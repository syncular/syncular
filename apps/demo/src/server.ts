/**
 * Demo backend: one Bun process serving
 * - POST /sync + GET /segments/:id via the server-hono adapter,
 * - GET /realtime as a WebSocket wired to the server's RealtimeHub,
 * - GET /events as a server-sent event tail of the server event ring (the
 *   sync lab's commit log),
 * - the static frontend: TWO bundles built with Bun.build at startup —
 *   /app.js (the page) and /worker.js (the sync worker running the whole
 *   client core on opfs-sahpool). Module workers do
 *   not inherit the page's import map, so a build plugin rewrites the
 *   sqlite-wasm bare specifier to /vendor/sqlite-wasm/index.mjs in both
 *   bundles; the package files are served under /vendor/sqlite-wasm/.
 *   COOP/COEP headers are still sent but are NOT required by sahpool
 *   (it uses FileSystemSyncAccessHandle, not SharedArrayBuffer).
 *
 * Storage is bun:sqlite (in-memory by default; set SYNCULAR_DEMO_DB=path
 * for a file). The schema is the typegen-generated module.
 */
import { buildSqliteImage } from '@syncular/server/sqlite';
import { dirname, join } from 'node:path';
import {
  composeEvents,
  consoleJsonEvents,
  createRealtimeHub,
  ensureSyncServerReady,
  MemorySegmentStore,
  type RealtimeSession,
  type ResolveScopesArgs,
  RingBufferEvents,
  SqliteBlobStore,
  SqliteServerStorage,
  type SyncServerConfig,
  SyncularAdmin,
  type SyncularServerEvent,
  type SyncularServerEvents,
  seedMutations,
} from '@syncular/server';
import {
  createSyncularAdminRoutes,
  createSyncularHono,
} from '@syncular/server-hono';
import { Hono } from 'hono';
import rootPackage from '../../../package.json';
import {
  DEMO_PARTITION as PARTITION,
  isDemoActor,
  resolveBoardScopes,
  SEED_ACTOR,
} from './access';
import { releaseBoardSeedMutations } from './seed';
import { schema } from './syncular.generated';

const PORT = Number(process.env.PORT ?? 8787);

function reflectReleaseVersion(text: string): string {
  if (text.split('0.0.0').length - 1 !== 1) {
    throw new Error('demo index must contain exactly one 0.0.0 placeholder');
  }
  return text.replace('0.0.0', rootPackage.version);
}

// -- sync server ------------------------------------------------------------

const storage = new SqliteServerStorage(
  process.env.SYNCULAR_DEMO_DB ?? ':memory:',
);
const segments = new MemorySegmentStore();
/** §5.9 blobs: durable content-addressed store sharing the demo DB. */
const blobs = new SqliteBlobStore();
/** Release board authorization: an actor sees the boards it is a member of. */
const resolveScopes = (args: ResolveScopesArgs) =>
  resolveBoardScopes(storage, args);

/**
 * Ops events. The in-memory ring always feeds the admin console;
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
  // segment store as POST /sync.
  segments,
  sqliteImageBuilder: buildSqliteImage,
  events,
});
const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  sqliteImageBuilder: buildSqliteImage,
  blobs,
  resolveScopes,
  realtime: hub,
  events,
};
const hono = createSyncularHono({
  config,
  // Demo sign-in: each device names its actor in a header. Anything else
  // is unauthenticated.
  authenticate: async (request) => {
    const actorId = request.headers.get('x-syncular-demo-actor');
    return isDemoActor(actorId) ? { actorId, partition: PARTITION } : null;
  },
});

/**
 * Admin console, mounted behind a trivial dev guard: enabled
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

/** Seed the two demo lists through the real §6 pipeline (idempotent per
 * commit id; skipped once the log holds commits). */
async function seed(): Promise<void> {
  if ((await storage.getMaxCommitSeq(PARTITION)) > 0) return;
  await seedMutations(
    config,
    { partition: PARTITION, actorId: SEED_ACTOR },
    releaseBoardSeedMutations(),
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
  // condition points at compiled dist for external bundlers).
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
    '"./vendor/sqlite-wasm/index.mjs"',
  );
}
const appJs = await bundleText('main.js');
const workerJs = await bundleText('worker.js');
const indexHtml = await Bun.file(
  join(import.meta.dir, 'frontend', 'index.html'),
)
  .text()
  .then(reflectReleaseVersion);

const wasmDir = dirname(
  Bun.resolveSync('@sqlite.org/sqlite-wasm', import.meta.dir),
);
/** Only the files the sqlite-wasm ESM entry actually references. */
/** The docs site's self-hosted fonts and mark, shared with the static build. */
const docsPublicDir = join(import.meta.dir, '..', '..', 'docs', 'public');
const BRAND_FILES: Record<string, string> = {
  'favicon.svg': 'image/svg+xml',
  'fonts/plex-mono-400.woff2': 'font/woff2',
  'fonts/plex-mono-500.woff2': 'font/woff2',
  'fonts/plex-mono-600.woff2': 'font/woff2',
  'fonts/plex-sans-400.woff2': 'font/woff2',
  'fonts/plex-sans-500.woff2': 'font/woff2',
};
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
  actorId: string;
  session?: RealtimeSession;
}

await ensureSyncServerReady(config);
await seed();

const server = Bun.serve<SocketData, never>({
  port: PORT,
  ...(process.env.HOST !== undefined ? { hostname: process.env.HOST } : {}),
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/realtime') {
      const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
      const actorId = url.searchParams.get('actor');
      if (!isDemoActor(actorId)) {
        return new Response('realtime requires a demo actor', { status: 401 });
      }
      if (bunServer.upgrade(request, { data: { clientId, actorId } })) {
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
    if (path === '/events') {
      // The lab's commit log: the retained ring oldest first, then every
      // new event. No idle timeout, so the tail stays open while idle.
      bunServer.timeout(request, 0);
      let unsubscribe = () => {};
      const body = new ReadableStream<string>({
        start(controller) {
          const send = (event: SyncularServerEvent) =>
            controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
          for (const event of ring.query().reverse()) send(event);
          unsubscribe = ring.subscribe(send);
        },
        cancel() {
          unsubscribe();
        },
      });
      return new Response(body, {
        headers: { ...STATIC_HEADERS, 'Content-Type': 'text/event-stream' },
      });
    }
    const brandType = BRAND_FILES[path.slice(1)];
    if (brandType !== undefined) {
      const bytes = await Bun.file(join(docsPublicDir, path.slice(1))).bytes();
      return staticResponse(bytes, brandType);
    }
    if (path === '/version.json') {
      return Response.json(
        { version: rootPackage.version },
        {
          headers: STATIC_HEADERS,
        },
      );
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
          actorId: ws.data.actorId,
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

console.log(`syncular demo: http://${server.hostname}:${server.port}`);
