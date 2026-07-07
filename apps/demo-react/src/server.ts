/**
 * demo-react backend: the SAME sync server as `apps/demo` (server-hono over
 * bun:sqlite, a RealtimeHub WebSocket, segment + blob endpoints) with a
 * React frontend instead of the vanilla-DOM one. It exists to dogfood the
 * hooks: `SyncProvider` + `useQuery` (named) + `useRawSql` (raw) + `useMutation` +
 * `useSyncStatus` + `useWindow`.
 *
 * Two Bun.build bundles at startup: /app.js (the React page) and /worker.js
 * (the whole client core on opfs-sahpool, Direction decision 2). Module
 * workers do not inherit the page's import map, so the sqlite-wasm bare
 * specifier is rewritten to /vendor/sqlite-wasm/ in both bundles.
 */
import { dirname, join } from 'node:path';
import {
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type RequestFrame,
} from '@syncular/core';
import {
  createRealtimeHub,
  handleSyncRequest,
  MemorySegmentStore,
  type RealtimeSession,
  SqliteBlobStore,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import { schema, type TodosRow } from './syncular.generated';

const PORT = Number(process.env.PORT ?? 8788);
const PARTITION = 'demo';
const ACTOR_ID = 'demo-user';

/** The three seed lists the window-filter dropdown drives (dogfoods W1). */
const LISTS = ['groceries', 'work', 'travel'] as const;

// -- sync server ------------------------------------------------------------

const storage = new SqliteServerStorage(
  process.env.SYNCULAR_DEMO_DB ?? ':memory:',
);
const segments = new MemorySegmentStore();
const blobs = new SqliteBlobStore();
/** Demo authorization: the single demo actor may see every list. */
const resolveScopes = () => ({ list_id: ['*'] });

const hub = createRealtimeHub({
  schema,
  storage,
  resolveScopes,
  segments,
});
const config: SyncServerConfig = {
  schema,
  storage,
  segments,
  blobs,
  resolveScopes,
  realtime: hub,
};
const hono = createSyncularHono({
  config,
  authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
});

/** Seed a few rows across the three lists through the real push path. */
async function seed(): Promise<void> {
  if ((await storage.getMaxCommitSeq(PARTITION)) > 0) return;
  const table = schema.tables[0];
  const now = Date.now();
  const seeds: Array<[string, string]> = [
    ['groceries', 'Milk, eggs, coffee'],
    ['groceries', 'Olive oil'],
    ['work', 'Ship the demo-react app'],
    ['work', 'Review the query surface RFC'],
    ['travel', 'Renew passport'],
  ];
  const rows: TodosRow[] = seeds.map(([list, title], index) => ({
    id: `seed-${index + 1}`,
    listId: list,
    title,
    done: false,
    position: index + 1,
    updatedAtMs: now,
    attachment: null,
  }));
  const frames: RequestFrame[] = [
    { type: 'REQ_HEADER', clientId: 'seed', schemaVersion: schema.version },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'seed-commit-1',
      operations: rows.map((row) => ({
        table: 'todos',
        rowId: row.id,
        op: 'upsert' as const,
        payload: encodeRow(table.columns, [
          row.id,
          row.listId,
          row.title,
          row.done,
          row.position,
          row.updatedAtMs,
          row.attachment,
        ]),
      })),
    },
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0011,
    },
  ];
  await handleSyncRequest(
    encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'request',
      frames,
    }),
    { ...config, partition: PARTITION, actorId: ACTOR_ID },
  );
}

// -- frontend build + static assets ------------------------------------------

const build = await Bun.build({
  entrypoints: [
    join(import.meta.dir, 'frontend', 'main.tsx'),
    join(import.meta.dir, 'frontend', 'worker.ts'),
  ],
  target: 'browser',
  sourcemap: 'inline',
  external: ['@sqlite.org/sqlite-wasm'],
  define: { 'process.env.NODE_ENV': '"development"' },
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('frontend build failed');
}
async function bundleText(basename: string): Promise<string> {
  const artifact = build.outputs.find((output) =>
    output.path.endsWith(`/${basename}`),
  );
  if (artifact === undefined) {
    throw new Error(`frontend build produced no ${basename}`);
  }
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
const WASM_FILES: Record<string, string> = {
  'index.mjs': 'text/javascript',
  'sqlite3.wasm': 'application/wasm',
  'sqlite3-opfs-async-proxy.js': 'text/javascript',
  'sqlite3-worker1.mjs': 'text/javascript',
};

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

console.log(
  `syncular v2 demo-react: http://localhost:${server.port} (lists: ${LISTS.join(', ')})`,
);
