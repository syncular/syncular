/**
 * B6 demo backend: one Bun process serving
 * - POST /sync + GET /segments/:id via the B2 server-hono adapter,
 * - GET /realtime as a WebSocket wired to the server's RealtimeHub,
 * - the static frontend: TWO bundles built with Bun.build at startup —
 *   /app.js (the page) and /worker.js (the sync worker running the whole
 *   client core on opfs-sahpool, Direction decision 2). Module workers do
 *   not inherit the page's import map, so a build plugin rewrites the
 *   sqlite-wasm bare specifier to /vendor/sqlite-wasm/index.mjs in both
 *   bundles; the package files are served under /vendor/sqlite-wasm/.
 *   COOP/COEP headers are still sent but are NOT required by sahpool
 *   (it uses FileSystemSyncAccessHandle, not SharedArrayBuffer).
 *
 * Storage is bun:sqlite (in-memory by default; set SYNCULAR_DEMO_DB=path
 * for a file). The schema is the typegen-generated module (B5 dogfood).
 */
import { dirname, join } from 'node:path';
import {
  composeEvents,
  consoleJsonEvents,
  createRealtimeHub,
  MemorySegmentStore,
  type RealtimeSession,
  RingBufferEvents,
  type SeedMutation,
  SqliteBlobStore,
  SqliteServerStorage,
  type SyncServerConfig,
  SyncularAdmin,
  type SyncularServerEvents,
  seedMutations,
} from '@syncular/server';
import {
  createSyncularAdminRoutes,
  createSyncularHono,
} from '@syncular/server-hono';
import { Hono } from 'hono';
import { schema } from './syncular.generated';

const PORT = Number(process.env.PORT ?? 8787);
const PARTITION = 'demo';
const ACTOR_ID = 'demo-user';

// -- sync server ------------------------------------------------------------

const storage = new SqliteServerStorage(
  process.env.SYNCULAR_DEMO_DB ?? ':memory:',
);
const segments = new MemorySegmentStore();
/** §5.9 blobs: durable content-addressed store sharing the demo DB. */
const blobs = new SqliteBlobStore();
/** Demo authorization: the single demo actor may see every list. */
const resolveScopes = () => ({ list_id: ['*'] });

/**
 * Ops events. The in-memory ring always feeds the admin console (TODO §2.5);
 * SYNCULAR_DEMO_EVENTS=1 additionally logs one JSON line per event. The two
 * sinks compose so the console tail and the log see the same emissions.
 */
const ring = new RingBufferEvents({ capacity: 500 });
const events: SyncularServerEvents =
  process.env.SYNCULAR_DEMO_EVENTS === '1'
    ? composeEvents(ring, consoleJsonEvents())
    : ring;

const hub = createRealtimeHub({
  schema,
  storage,
  resolveScopes,
  // §8.7: the socket carries sync rounds through the same handler and
  // segment store as POST /sync (Direction decision 1).
  segments,
  events,
});
const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  blobs,
  resolveScopes,
  realtime: hub,
  events,
};
const hono = createSyncularHono({
  config,
  authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
});

/**
 * Admin console (TODO §2.5), mounted behind a trivial dev guard: enabled
 * only with SYNCULAR_DEMO_ADMIN=1 and, when SYNCULAR_DEMO_ADMIN_TOKEN is
 * set, gated on a matching `?token=` / `Authorization: Bearer` — a stand-in
 * for the real host guard (never default-open). Reachable at /admin.
 */
const adminEnabled = process.env.SYNCULAR_DEMO_ADMIN === '1';
const adminToken = process.env.SYNCULAR_DEMO_ADMIN_TOKEN;
const adminHono = adminEnabled
  ? (() => {
      const admin = SyncularAdmin.fromConfig(config, { ring });
      const routes = createSyncularAdminRoutes(admin, {
        defaultPartition: PARTITION,
        authorize: ({ request }) => {
          if (adminToken === undefined) return true; // dev default: open
          const url = new URL(request.url);
          const bearer = request.headers
            .get('authorization')
            ?.replace(/^Bearer\s+/i, '');
          return (
            url.searchParams.get('token') === adminToken ||
            bearer === adminToken
          );
        },
      });
      const mount = new Hono();
      mount.route('/admin', routes);
      return mount;
    })()
  : undefined;

/** Seed a few rows (RFC 0002 §2.5 — the supported recipe: `seedMutations`
 * pushes app-shaped values through the real §6 pipeline, idempotent per
 * commit id). */
async function seed(): Promise<void> {
  if ((await storage.getMaxCommitSeq(PARTITION)) > 0) return;
  const now = Date.now();
  const mutations: SeedMutation[] = [
    'Open this page in two panes',
    'Toggle a pane offline and keep editing',
    'Attach a file to a todo — it uploads then syncs',
  ].map((title, index) => ({
    table: 'todos',
    op: 'upsert',
    values: {
      id: `seed-${index + 1}`,
      listId: 'demo',
      title,
      done: false,
      position: index + 1,
      updatedAtMs: now,
      attachment: null,
    },
  }));
  await seedMutations(
    config,
    { partition: PARTITION, actorId: ACTOR_ID },
    mutations,
  );
}

// -- frontend build + static assets ------------------------------------------

const build = await Bun.build({
  entrypoints: [
    join(import.meta.dir, 'frontend', 'main.ts'),
    join(import.meta.dir, 'frontend', 'worker.ts'),
  ],
  target: 'browser',
  // Workspace packages resolve their `bun` condition (TS source), so the
  // dev loop never needs `build:packages` (the published `browser`
  // condition points at compiled dist for external bundlers, RFC 0002 §1.1).
  conditions: ['bun'],
  sourcemap: 'inline',
  external: ['@sqlite.org/sqlite-wasm'],
});
async function bundleText(basename: string): Promise<string> {
  const artifact = build.outputs.find((output) =>
    output.path.endsWith(`/${basename}`),
  );
  if (artifact === undefined) {
    throw new Error(`frontend build produced no ${basename}`);
  }
  // Both bundles import sqlite-wasm from the served vendor path. An
  // import map would only cover the page, never the module worker, so
  // the external bare specifier is rewritten in the emitted JS instead.
  const text = await artifact.text();
  return text.replaceAll(
    /(["'])@sqlite\.org\/sqlite-wasm\1/g,
    '"/vendor/sqlite-wasm/index.mjs"',
  );
}
const appJs = await bundleText('main.js');
const workerJs = await bundleText('worker.js');
const indexHtml = await Bun.file(
  join(import.meta.dir, 'frontend', 'index.html'),
).text();

const wasmDir = dirname(
  Bun.resolveSync('@sqlite.org/sqlite-wasm', import.meta.dir),
);
/** Only the files the sqlite-wasm ESM entry actually references. */
const WASM_FILES: Record<string, string> = {
  'index.mjs': 'text/javascript',
  'sqlite3.wasm': 'application/wasm',
  'sqlite3-opfs-async-proxy.js': 'text/javascript',
  'sqlite3-worker1.mjs': 'text/javascript',
};

/** COOP/COEP so OPFS-capable contexts get cross-origin isolation. */
const STATIC_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
};

function staticResponse(body: string | Uint8Array, type: string): Response {
  return new Response(body as BodyInit, {
    headers: { ...STATIC_HEADERS, 'Content-Type': type },
  });
}

// -- one process, one port ----------------------------------------------------

interface SocketData {
  clientId: string;
  session?: RealtimeSession;
}

await seed();

const server = Bun.serve<SocketData, never>({
  port: PORT,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/realtime') {
      const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
      if (bunServer.upgrade(request, { data: { clientId } })) {
        return undefined as unknown as Response;
      }
      return new Response('expected a websocket upgrade', { status: 400 });
    }
    if (
      path === '/sync' ||
      path.startsWith('/segments/') ||
      path.startsWith('/blobs/')
    ) {
      return hono.fetch(request);
    }
    if (adminHono !== undefined && path.startsWith('/admin')) {
      return adminHono.fetch(request);
    }
    if (path === '/' || path === '/index.html') {
      return staticResponse(indexHtml, 'text/html; charset=utf-8');
    }
    if (path === '/app.js') {
      return staticResponse(appJs, 'text/javascript; charset=utf-8');
    }
    if (path === '/worker.js') {
      return staticResponse(workerJs, 'text/javascript; charset=utf-8');
    }
    if (path.startsWith('/vendor/sqlite-wasm/')) {
      const name = path.slice('/vendor/sqlite-wasm/'.length);
      const type = WASM_FILES[name];
      if (type !== undefined) {
        const bytes = await Bun.file(join(wasmDir, name)).bytes();
        return staticResponse(bytes, type);
      }
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      hub
        .connect({
          partition: PARTITION,
          actorId: ACTOR_ID,
          clientId: ws.data.clientId,
          send: (data) => {
            ws.send(data);
          },
          closeSocket: () => ws.close(1008, 'protocol violation (§8.7)'),
        })
        .then((session) => {
          ws.data.session = session;
        })
        .catch(() => ws.close(1011, 'realtime connect failed'));
    },
    message(ws, message) {
      if (typeof message === 'string') {
        ws.data.session?.handleMessage(message);
      } else {
        // §8.7: tagged binary — sync-round request chunks.
        ws.data.session?.handleBinary(new Uint8Array(message));
      }
    },
    close(ws) {
      ws.data.session?.close();
    },
  },
});

console.log(`syncular v2 demo: http://localhost:${server.port}`);
