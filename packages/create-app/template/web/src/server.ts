/**
 * The whole app in one Bun process:
 * - POST /sync + GET /segments/:id via the server-hono adapter,
 * - GET /realtime as a WebSocket wired to the server's RealtimeHub (§8.7),
 * - the static frontend: TWO bundles built with Bun.build at startup —
 *   /app.js (the page) and /worker.js (the sync worker running the whole
 *   client core on opfs-sahpool). Module workers do not inherit the page's
 *   import map, so the sqlite-wasm bare specifier is rewritten to the served
 *   vendor path in both bundles.
 *
 * Storage is bun:sqlite (in-memory by default; set DB_PATH=path for a file).
 *
 * EDIT FIRST: `resolveScopes` + `authenticate` below are the whole
 * authorization story — they run in YOUR backend next to YOUR auth.
 */
import { dirname, join } from 'node:path';
import {
  createRealtimeHub,
  MemorySegmentStore,
  type RealtimeSession,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { schema } from './syncular.generated';

const PORT = Number(process.env.PORT ?? 8787);
const PARTITION = 'demo';
const ACTOR_ID = 'demo-user';

// -- sync server ------------------------------------------------------------

const storage = new SqliteServerStorage(process.env.DB_PATH ?? ':memory:');
const segments = new MemorySegmentStore();
/** Demo authorization: the single actor may see every list. Replace with the
 * scope values the authenticated actor is allowed to see. */
const resolveScopes = () => ({ list_id: ['*'] });

const hub = createRealtimeHub({ schema, storage, resolveScopes, segments });
const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  resolveScopes,
  realtime: hub,
};
const hono = createSyncularHono({
  config,
  // Replace with your real auth: return { actorId, partition } or null (401).
  authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
});

// -- frontend build + static assets ------------------------------------------

const build = await Bun.build({
  entrypoints: [
    join(import.meta.dir, 'frontend', 'main.ts'),
    join(import.meta.dir, 'frontend', 'worker.ts'),
  ],
  target: 'browser',
  // Resolve syncular packages through their `bun` condition (TS source,
  // shipped in the npm tarballs) — bun transpiles it, and a `--local`
  // workspace link works without a dist build.
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
  // Both bundles import sqlite-wasm from the served vendor path. An import map
  // would only cover the page, never the module worker, so the external bare
  // specifier is rewritten in the emitted JS instead.
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

/** COOP/COEP so OPFS-capable contexts get cross-origin isolation (not
 * required by opfs-sahpool, but harmless and future-proof). */
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
    if (path === '/sync' || path.startsWith('/segments/')) {
      return hono.fetch(request);
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
        ws.data.session?.handleBinary(new Uint8Array(message));
      }
    },
    close(ws) {
      ws.data.session?.close();
    },
  },
});

console.log(`app: http://localhost:${server.port}`);
