/**
 * Browser runtime asset server.
 *
 * Builds and serves the wa-sqlite dialect + test entry point with COOP/COEP headers.
 * Started as a subprocess by the test coordinator.
 */

import path from 'node:path';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  getWaSqliteWasmPaths,
  getWaSqliteWorkerEntrypointPaths,
} from '@syncular/dialect-wa-sqlite';
import {
  createServerHandler,
  ensureSyncSchema,
  readSnapshotChunk,
  type SyncCoreDb,
  type SyncServerAuth,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import {
  syncularGeneratedCodecs,
  syncularGeneratedSnapshotBinaryColumns,
  syncularGeneratedSnapshotBinaryEncoders,
} from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';

type BunServer = ReturnType<typeof Bun.serve>;

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number.parseInt(portArg.split('=')[1]!, 10) : 0;
const wasmProfile = readWasmProfile();
const syncSeedRows = readPositiveIntArg('--sync-seed-rows', 0);
const syncSeedUsers = Math.max(1, readPositiveIntArg('--sync-seed-users', 1));
const syncWsMaxInFlight = readPositiveIntArg('--sync-ws-max-in-flight', 64);
const repoRoot = path.resolve(import.meta.dir, '../../../..');
const rustPackageRoot = path.join(repoRoot, 'rust/bindings/browser');
const rustPackageWasmDir = path.join(rustPackageRoot, 'dist/wasm');

const rustWasmBuild = Bun.spawnSync(
  ['bun', 'run', wasmProfile === 'release' ? 'build:wasm' : 'build:wasm:dev'],
  {
    cwd: rustPackageRoot,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  }
);

if (rustWasmBuild.exitCode !== 0) {
  console.error('Failed to build Syncular Rust WASM client:');
  console.error(rustWasmBuild.stdout.toString());
  console.error(rustWasmBuild.stderr.toString());
  process.exit(1);
}

// Build the browser entry point
const entryBuild = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'entry.ts')],
  target: 'browser',
  format: 'esm',
  conditions: ['bun'],
});

if (!entryBuild.success) {
  console.error('Failed to build entry:', entryBuild.logs);
  process.exit(1);
}

const rustOwnedWorkerBuild = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'rust-owned-worker.ts')],
  target: 'browser',
  format: 'esm',
  conditions: ['bun'],
});

if (!rustOwnedWorkerBuild.success) {
  console.error(
    'Failed to build rust-owned worker:',
    rustOwnedWorkerBuild.logs
  );
  process.exit(1);
}

const syncularV2WorkerBuild = await Bun.build({
  entrypoints: [path.join(rustPackageRoot, 'src/worker-entry.ts')],
  target: 'browser',
  format: 'esm',
  conditions: ['bun'],
});

if (!syncularV2WorkerBuild.success) {
  console.error(
    'Failed to build Syncular v2 worker:',
    syncularV2WorkerBuild.logs
  );
  process.exit(1);
}

// Build the wa-sqlite worker
const { moduleWorkerPath } = getWaSqliteWorkerEntrypointPaths();
const workerBuild = await Bun.build({
  entrypoints: [moduleWorkerPath],
  target: 'browser',
  format: 'esm',
  splitting: false,
  publicPath: '/wasqlite/',
  conditions: ['bun'],
  naming: {
    entry: 'worker.js',
    chunk: 'chunk-[hash].js',
    asset: 'asset-[hash].[ext]',
  },
});

if (!workerBuild.success) {
  console.error('Failed to build worker:', workerBuild.logs);
  process.exit(1);
}
assertSingleWorkerBundle(workerBuild.outputs.map((output) => output.path));

// Get WASM file paths
const { asyncWasmPath, syncWasmPath } = getWaSqliteWasmPaths();

// Create asset map for worker chunks
const workerAssets = new Map<string, (typeof workerBuild.outputs)[0]>();
for (const output of workerBuild.outputs) {
  const name = output.path.split('/').at(-1);
  if (name) workerAssets.set(name, output);
}

const COOP_COEP_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'cross-origin',
  'cache-control': 'no-cache',
};

let syncCommitSeq = 1;
const benchmarkSyncRoute =
  syncSeedRows > 0
    ? await createBenchmarkSyncRoute(syncSeedRows, syncSeedUsers)
    : null;

const HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Runtime Test</title></head>
<body>
<script type="module" src="/entry.js"></script>
</body>
</html>`;

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/sync' && req.method === 'POST') {
      if (benchmarkSyncRoute) return benchmarkSyncRoute(req, server);
      return benchmarkSyncResponse(req);
    }

    if (url.pathname.startsWith('/sync/') && benchmarkSyncRoute) {
      return benchmarkSyncRoute(req, server);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, {
        headers: { ...COOP_COEP_HEADERS, 'content-type': 'text/html' },
      });
    }

    if (url.pathname === '/entry.js') {
      return new Response(entryBuild.outputs[0], {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/javascript',
        },
      });
    }

    if (url.pathname === '/rust-owned-worker.js') {
      return new Response(rustOwnedWorkerBuild.outputs[0], {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/javascript',
        },
      });
    }

    if (url.pathname === '/syncular-v2-worker.js') {
      return new Response(syncularV2WorkerBuild.outputs[0], {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/javascript',
        },
      });
    }

    if (url.pathname === '/wasqlite/wa-sqlite-async.wasm') {
      return new Response(Bun.file(asyncWasmPath), {
        headers: { ...COOP_COEP_HEADERS, 'content-type': 'application/wasm' },
      });
    }

    if (url.pathname === '/wasqlite/wa-sqlite.wasm') {
      return new Response(Bun.file(syncWasmPath), {
        headers: { ...COOP_COEP_HEADERS, 'content-type': 'application/wasm' },
      });
    }

    if (url.pathname === '/wasm/syncular_v2.js') {
      return new Response(
        Bun.file(path.join(rustPackageWasmDir, 'syncular_v2.js')),
        {
          headers: {
            ...COOP_COEP_HEADERS,
            'content-type': 'application/javascript',
          },
        }
      );
    }

    if (url.pathname === '/wasm/syncular_v2_bg.wasm') {
      return new Response(
        Bun.file(path.join(rustPackageWasmDir, 'syncular_v2_bg.wasm')),
        {
          headers: { ...COOP_COEP_HEADERS, 'content-type': 'application/wasm' },
        }
      );
    }

    // Worker chunks
    if (url.pathname.startsWith('/wasqlite/')) {
      const name = url.pathname.slice('/wasqlite/'.length);
      const asset = workerAssets.get(name);
      if (asset) {
        return new Response(asset, {
          headers: {
            ...COOP_COEP_HEADERS,
            'content-type': 'application/javascript',
          },
        });
      }
    }

    return new Response('Not found', { status: 404 });
  },
  websocket,
});

console.log(`READY:${server.port}`);

function assertSingleWorkerBundle(outputPaths: readonly string[]): void {
  const outputNames = outputPaths
    .map((outputPath) => outputPath.split('/').at(-1))
    .filter((name): name is string => Boolean(name));
  const extraOutputs = outputNames.filter((name) => name !== 'worker.js');

  if (extraOutputs.length === 0) return;

  throw new Error(
    `[runtime-browser] wa-sqlite worker build produced split artifacts (${extraOutputs.join(', ')}). ` +
      'This can trigger Bun ESM duplicate-export crashes in module workers. Keep worker bundling unsplit.'
  );
}

function readWasmProfile(): 'dev' | 'release' {
  const profileArg = process.argv.find((a) => a.startsWith('--wasm-profile='));
  const raw =
    profileArg?.split('=')[1] ??
    process.env.SYNCULAR_BROWSER_WASM_PROFILE ??
    'dev';
  if (raw === 'dev' || raw === 'release') return raw;
  throw new Error(`Invalid --wasm-profile value: ${raw}`);
}

function readPositiveIntArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  const raw =
    arg?.split('=')[1] ??
    process.env[name.slice(2).replaceAll('-', '_').toUpperCase()];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return parsed;
}

async function createBenchmarkSyncRoute(
  rows: number,
  users: number
): Promise<(request: Request, server: BunServer) => Promise<Response>> {
  const dialect = createSqliteServerDialect();
  const db = createDatabase<BenchmarkSyncServerDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
  await ensureSyncSchema(db, dialect);
  await ensureBenchmarkTasksTable(db);
  await seedBenchmarkTasks(db, rows, users);
  const syncRoutes = createSyncRoutes<
    BenchmarkSyncServerDb,
    BenchmarkSyncAuthContext
  >({
    db,
    dialect,
    handlers: [
      createServerHandler<
        BenchmarkSyncServerDb,
        BenchmarkSyncClientDb,
        'tasks',
        BenchmarkSyncAuthContext
      >({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        codecs: syncularGeneratedCodecs,
        snapshotBundleMaxBytes: Number.MAX_SAFE_INTEGER,
        snapshotBinaryColumns: syncularGeneratedSnapshotBinaryColumns.tasks,
        snapshotBinaryEncoder: syncularGeneratedSnapshotBinaryEncoders.tasks,
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ],
    authenticate: async (c) => {
      const actorId =
        c.req.header('x-actor-id') ??
        c.req.header('x-syncular-actor-id') ??
        c.req.header('authorization') ??
        'browser-e2e-user';
      return { actorId, partitionId: 'browser-e2e' };
    },
    sync: {
      rateLimit: false,
      maxPullMaxSnapshotPages: 100,
      websocket: {
        enabled: true,
        upgradeWebSocket,
        heartbeatIntervalMs: 0,
        allowedOrigins: '*',
        maxInFlightSyncsPerConnection: syncWsMaxInFlight,
      },
    },
  });
  const app = new Hono().route('/sync', syncRoutes);
  return async (request: Request, server) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/sync/snapshot-chunks/')) {
      const chunkId = decodeURIComponent(
        url.pathname.slice('/sync/snapshot-chunks/'.length)
      );
      const chunk = await readSnapshotChunk(db, chunkId);
      if (!chunk) return new Response('not found', { status: 404 });
      return new Response(chunk.body as BodyInit, {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/octet-stream',
          'content-length': String(chunk.byteLength),
          'x-sync-chunk-id': chunk.chunkId,
          'x-sync-chunk-sha256': chunk.sha256,
          'x-sync-chunk-encoding': chunk.encoding,
          'x-sync-chunk-compression': chunk.compression,
        },
      });
    }
    return app.fetch(request, server);
  };
}

async function ensureBenchmarkTasksTable(
  db: ReturnType<typeof createDatabase<BenchmarkSyncServerDb>>
): Promise<void> {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('project_id', 'text')
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('image', 'text')
    .addColumn('title_yjs_state', 'text')
    .execute();

  await db.schema
    .createIndex('idx_tasks_scope_user_id_id')
    .ifNotExists()
    .on('tasks')
    .columns(['user_id', 'id'])
    .execute();
}

async function seedBenchmarkTasks(
  db: ReturnType<typeof createDatabase<BenchmarkSyncServerDb>>,
  rows: number,
  users: number
): Promise<void> {
  const chunkSize = 1_000;
  for (let start = 0; start < rows; start += chunkSize) {
    const values = Array.from(
      { length: Math.min(chunkSize, rows - start) },
      (_, offset) => {
        const index = start + offset;
        const userIndex = users === 1 ? 0 : index % users;
        return {
          id: `task-${index}`,
          title: `Task ${index}`,
          completed: index % 2,
          user_id:
            userIndex === 0
              ? 'browser-e2e-user'
              : `browser-e2e-user-${userIndex}`,
          project_id: 'p1',
          server_version: index + 1,
          image: null,
          title_yjs_state: null,
        };
      }
    );
    await db.insertInto('tasks').values(values).execute();
  }
}

async function benchmarkSyncResponse(req: Request): Promise<Response> {
  const request = (await req.json()) as {
    push?: {
      commits?: Array<{
        clientCommitId: string;
        operations?: unknown[];
      }>;
    };
    pull?: {
      subscriptions?: Array<{
        id: string;
        table: string;
        scopes: Record<string, unknown>;
        cursor: number;
      }>;
    };
  };

  const response = {
    ok: true,
    push: request.push
      ? {
          ok: true,
          commits: (request.push.commits ?? []).map((commit) => {
            const commitSeq = syncCommitSeq++;
            return {
              clientCommitId: commit.clientCommitId,
              status: 'applied',
              commitSeq,
              results: (commit.operations ?? []).map((_operation, opIndex) => ({
                opIndex,
                status: 'applied',
                message: null,
                error: null,
                code: null,
                retriable: null,
                server_version: commitSeq * 1000 + opIndex,
                server_row: null,
              })),
            };
          }),
        }
      : null,
    pull: request.pull
      ? {
          ok: true,
          subscriptions: (request.pull.subscriptions ?? []).map((sub) => ({
            id: sub.id,
            table: sub.table,
            status: 'active',
            scopes: sub.scopes,
            bootstrap: false,
            bootstrapState: null,
            nextCursor: sub.cursor,
            snapshotRows: [],
            commits: [],
          })),
        }
      : null,
  };

  return new Response(JSON.stringify(response), {
    headers: {
      ...COOP_COEP_HEADERS,
      'content-type': 'application/json',
    },
  });
}

interface BenchmarkTaskTable {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: string | null;
  title_yjs_state: string | null;
}

interface BenchmarkSyncServerDb extends SyncCoreDb {
  tasks: BenchmarkTaskTable;
}

interface BenchmarkSyncClientDb {
  tasks: BenchmarkTaskTable;
}

interface BenchmarkSyncAuthContext extends SyncServerAuth {
  actorId: string;
}
