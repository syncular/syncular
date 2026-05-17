/**
 * Browser entry point for runtime tests.
 *
 * Bundled by Bun.build() and served to the browser. Exposes scenario
 * functions on window.__runtime for Playwright to call via page.evaluate().
 */

import { Kysely } from 'kysely';
import {
  type ClientHandlerCollection,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  type SyncClientDb,
  syncPullOnce,
  syncPushOnce,
} from '../../../../packages/client/src/index';
import { codecs, createDatabase } from '../../../../packages/core/src/index';
import { createWaSqliteDialect } from '../../../../packages/dialect-wa-sqlite/src/index';
import { createHttpTransport } from '../../../../packages/transport-http/src/index';
import {
  createSyncularRustOwnedSqlite,
  createSyncularV2Dialect,
  type SyncularRustOwnedSqlite,
} from '../../../../rust/bindings/browser/src/index';
import {
  createSyncularAppDatabase,
  ensureSyncularAppSchema,
  newCommentOperation,
  newProjectOperation,
  newTaskOperation,
  type SyncularAppDatabase,
  syncularGeneratedAppSchema,
  syncularGeneratedFieldEncryptionConfig,
  syncularGeneratedSchemaVersion,
  syncularGeneratedTableConfig,
  taskSubscription,
  taskPatchPayload,
} from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';
import type {
  SyncularV2AppSchema,
  SyncularV2PullOptions,
} from '../../../../rust/bindings/browser/src/index';
import type {
  ConformanceDb,
  RuntimeClientDb,
} from '../../shared/runtime-types';
import { tasksClientHandler } from '../../shared/tasks-handler';
import { assert, bytesToArray, jsonEqual } from '../../shared/test-helpers';
import {
  createSyncularWebStoreHost,
  type SyncularWebStoreHostConfig,
} from './web-store-host';

// --- Helpers ---

function createDb<T>(fileName: string, options?: { preferOPFS?: boolean }) {
  return createDatabase<T>({
    dialect: createWaSqliteDialect({
      fileName,
      preferOPFS: options?.preferOPFS ?? false,
      url: (useAsyncWasm: boolean) =>
        `/wasqlite/${useAsyncWasm ? 'wa-sqlite-async.wasm' : 'wa-sqlite.wasm'}`,
      worker: () =>
        new Worker('/wasqlite/worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
    }),
    family: 'sqlite',
    codecs: (col) => {
      if (col.table !== 'dialect_conformance') return undefined;
      if (col.column === 'b_bool' || col.column === 'nullable_bool') {
        return codecs.numberBoolean();
      }
      if (
        col.column === 'j_json' ||
        col.column === 'j_large' ||
        col.column === 'nullable_json'
      ) {
        return codecs.stringJson();
      }
      if (col.column === 'd_date' || col.column === 'nullable_date') {
        return codecs.timestampDate();
      }
      return undefined;
    },
  });
}

type RuntimeClientDbHandle = ReturnType<typeof createDb<RuntimeClientDb>>;

type CreateSyncularAppWebStoreHostOptions = Omit<
  SyncularWebStoreHostConfig,
  'tables' | 'schemaVersion'
> & {
  schemaVersion?: number;
};

async function createSyncularAppWebStoreHost(
  db: Kysely<any>,
  options: CreateSyncularAppWebStoreHostOptions = {}
) {
  await ensureSyncularAppSchema(db);
  return createSyncularWebStoreHost(db, {
    ...options,
    schemaVersion: options.schemaVersion ?? syncularGeneratedSchemaVersion,
    tables: syncularGeneratedTableConfig,
  });
}

async function ensureRustOwnedBenchmarkSchema(
  client: SyncularRustOwnedSqlite
): Promise<void> {
  const dialect = createSyncularV2Dialect(
    client as unknown as Parameters<typeof createSyncularV2Dialect>[0],
    { unsafeWrites: true }
  );
  const db = new Kysely<any>({ dialect });
  try {
    await ensureSyncularAppSchema(db);
  } finally {
    await dialect.destroyLiveQueries();
    await db.destroy();
  }
}

interface LocalMutationBenchmarkOptions {
  operations?: number;
  rounds?: number;
  warmupOperations?: number;
  preferOPFS?: boolean;
  includeDirectRustOwned?: boolean;
}

interface LocalMutationBenchmarkStats {
  label: string;
  operations: number;
  rounds: number;
  totalOperations: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  opsPerSecondMedian: number;
  outboxRows: number;
  taskRows: number;
}

interface FeatureWorkloadBenchmarkOptions {
  operations?: number;
  rounds?: number;
  warmupOperations?: number;
  storage?: 'memory' | 'indexedDb' | 'opfsSahPool';
}

interface E2eScoreboardOptions {
  serverUrl: string;
  actorId: string;
  projectId?: string;
  rows: number;
  queryIterations?: number;
  rustStorage?: 'memory' | 'indexedDb' | 'opfsSahPool';
  rustIncludeSnapshotRows?: boolean;
  rustCollectChangedRows?: boolean;
  rustMaxSnapshotChangedRows?: number | null;
}

interface E2eScoreboardMetric {
  name: string;
  value: number;
  unit: 'ms' | 'rows' | 'bytes' | 'count';
}

interface RustE2eTransportStats {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  snapshotChunkCount: number;
  snapshotChunkJsonCount: number;
  snapshotChunkBinaryCount: number;
  snapshotChunkRowCount: number;
  snapshotChunkFetchMs: number;
  snapshotChunkDecompressMs: number;
  snapshotChunkHashMs: number;
  snapshotChunkDecodeMs: number;
  serverBootstrapSnapshotQueryMs: number;
  serverBootstrapRowFrameEncodeMs: number;
  serverBootstrapChunkCacheLookupMs: number;
  serverBootstrapChunkGzipMs: number;
  serverBootstrapChunkHashMs: number;
  serverBootstrapChunkPersistMs: number;
}

interface RustE2eDiagnostics {
  resetTransportStats(): Promise<void>;
  transportStats(): Promise<RustE2eTransportStats>;
}

interface TimedSamples {
  p50: number;
  p95: number;
  min: number;
  max: number;
}

type RustOwnedWorkerRequest =
  | {
      id: number;
      type: 'open';
      fileName: string;
      storage: 'memory' | 'indexedDb' | 'opfsSahPool';
      clearOnInit?: boolean;
    }
  | {
      id: number;
      type: 'applyBatch';
      operations: Array<{
        operation: ReturnType<typeof makeTaskOperation>;
        localRow?: unknown | null;
      }>;
    }
  | { id: number; type: 'countRows'; table: string }
  | { id: number; type: 'close' };

type RustOwnedWorkerResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };

class RustOwnedSqliteWorkerClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<RustOwnedWorkerResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.value);
      else pending.reject(new Error(event.data.error));
    };
  }

  static async open(args: {
    fileName: string;
    storage: 'memory' | 'indexedDb' | 'opfsSahPool';
    clearOnInit?: boolean;
  }): Promise<RustOwnedSqliteWorkerClient> {
    const client = new RustOwnedSqliteWorkerClient(
      new Worker('/rust-owned-worker.js', { type: 'module' })
    );
    await client.request({
      id: 0,
      type: 'open',
      fileName: args.fileName,
      storage: args.storage,
      clearOnInit: args.clearOnInit,
    });
    return client;
  }

  applyLocalOperationsBatch(
    operations: Array<{
      operation: ReturnType<typeof makeTaskOperation>;
      localRow?: unknown | null;
    }>
  ): Promise<string[]> {
    return this.request({ id: 0, type: 'applyBatch', operations }) as Promise<
      string[]
    >;
  }

  countRows(table: 'tasks' | 'sync_outbox_commits'): Promise<number> {
    return this.request({ id: 0, type: 'countRows', table }) as Promise<number>;
  }

  async close(): Promise<void> {
    try {
      await this.request({ id: 0, type: 'close' });
    } finally {
      this.worker.terminate();
    }
  }

  private request(message: RustOwnedWorkerRequest): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }
}

function makeTaskOperation(prefix: string, index: number, actorId: string) {
  return {
    table: 'tasks',
    row_id: `${prefix}-${index}`,
    op: 'upsert' as const,
    payload: {
      title: `${prefix} Task ${index}`,
      completed: index % 2,
      user_id: actorId,
      project_id: 'p1',
    },
    base_version: null,
  };
}

async function applyJsLocalTaskOperation(
  db: RuntimeClientDbHandle,
  operation: ReturnType<typeof makeTaskOperation>
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const payload = operation.payload;
    await trx
      .insertInto('tasks')
      .values({
        id: operation.row_id,
        title: payload.title,
        completed: payload.completed,
        user_id: payload.user_id,
        project_id: payload.project_id,
        server_version: 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          title: payload.title,
          completed: payload.completed,
          user_id: payload.user_id,
          project_id: payload.project_id,
        })
      )
      .execute();

    await enqueueOutboxCommit(trx as unknown as Kysely<SyncClientDb>, {
      schemaVersion: syncularGeneratedSchemaVersion,
      operations: [operation],
    });
  });
}

async function applyJsLocalTaskOperationsBatch(
  db: RuntimeClientDbHandle,
  operations: Array<ReturnType<typeof makeTaskOperation>>
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const operation of operations) {
      const payload = operation.payload;
      await trx
        .insertInto('tasks')
        .values({
          id: operation.row_id,
          title: payload.title,
          completed: payload.completed,
          user_id: payload.user_id,
          project_id: payload.project_id,
          server_version: 0,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            title: payload.title,
            completed: payload.completed,
            user_id: payload.user_id,
            project_id: payload.project_id,
          })
        )
        .execute();

      await enqueueOutboxCommit(trx as unknown as Kysely<SyncClientDb>, {
        schemaVersion: syncularGeneratedSchemaVersion,
        operations: [operation],
      });
    }
  });
}

function summarizeBenchmark(
  label: string,
  operations: number,
  times: number[],
  outboxRows: number,
  taskRows: number
): LocalMutationBenchmarkStats {
  const sorted = [...times].sort((a, b) => a - b);
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? sorted.at(-1) ?? 0;
  return {
    label,
    operations,
    rounds: sorted.length,
    totalOperations: operations * sorted.length,
    meanMs,
    medianMs,
    p95Ms,
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    opsPerSecondMedian: medianMs > 0 ? operations / (medianMs / 1000) : 0,
    outboxRows,
    taskRows,
  };
}

async function summarizeClientBenchmark(
  client: SyncularAppDatabase['client'],
  label: string,
  operations: number,
  times: number[]
): Promise<LocalMutationBenchmarkStats> {
  return summarizeBenchmark(
    label,
    operations,
    times,
    await countClientRows(client, 'sync_outbox_commits'),
    await countClientRows(client, 'tasks')
  );
}

async function countRows(
  db: RuntimeClientDbHandle,
  table: 'tasks' | 'sync_outbox_commits'
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countClientRows(
  client: SyncularAppDatabase['client'],
  table: string
): Promise<number> {
  const result = await client.executeSql<{ count: number }>(
    `select count(*) as count from "${table}"`
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function measureLocalMutationBatches(args: {
  label: string;
  operations: number;
  rounds: number;
  warmupOperations: number;
  db: RuntimeClientDbHandle;
  apply(prefix: string, index: number): Promise<void>;
}): Promise<LocalMutationBenchmarkStats> {
  for (let index = 0; index < args.warmupOperations; index += 1) {
    await args.apply(`${args.label}-warmup`, index);
  }

  const times: number[] = [];
  let nextIndex = 0;
  for (let round = 0; round < args.rounds; round += 1) {
    const startedAt = performance.now();
    for (let index = 0; index < args.operations; index += 1) {
      await args.apply(`${args.label}-measured`, nextIndex);
      nextIndex += 1;
    }
    times.push(performance.now() - startedAt);
  }

  return summarizeBenchmark(
    args.label,
    args.operations,
    times,
    await countRows(args.db, 'sync_outbox_commits'),
    await countRows(args.db, 'tasks')
  );
}

async function measureClientRounds(args: {
  label: string;
  operations: number;
  rounds: number;
  warmupOperations: number;
  client: SyncularAppDatabase['client'];
  run(prefix: string, startIndex: number, count: number): Promise<void>;
}): Promise<LocalMutationBenchmarkStats> {
  if (args.warmupOperations > 0) {
    await args.run(`${args.label}-warmup`, 0, args.warmupOperations);
  }

  const times: number[] = [];
  let nextIndex = 0;
  for (let round = 0; round < args.rounds; round += 1) {
    const startedAt = performance.now();
    await args.run(`${args.label}-measured`, nextIndex, args.operations);
    nextIndex += args.operations;
    times.push(performance.now() - startedAt);
  }

  return summarizeClientBenchmark(
    args.client,
    args.label,
    args.operations,
    times
  );
}

async function measureLocalMutationBatchCalls(args: {
  label: string;
  operations: number;
  rounds: number;
  warmupOperations: number;
  db: RuntimeClientDbHandle;
  applyBatch(prefix: string, startIndex: number, count: number): Promise<void>;
}): Promise<LocalMutationBenchmarkStats> {
  if (args.warmupOperations > 0) {
    await args.applyBatch(`${args.label}-warmup`, 0, args.warmupOperations);
  }

  const times: number[] = [];
  let nextIndex = 0;
  for (let round = 0; round < args.rounds; round += 1) {
    const startedAt = performance.now();
    await args.applyBatch(`${args.label}-measured`, nextIndex, args.operations);
    nextIndex += args.operations;
    times.push(performance.now() - startedAt);
  }

  return summarizeBenchmark(
    args.label,
    args.operations,
    times,
    await countRows(args.db, 'sync_outbox_commits'),
    await countRows(args.db, 'tasks')
  );
}

async function measureExternalLocalMutationBatchCalls(args: {
  label: string;
  operations: number;
  rounds: number;
  warmupOperations: number;
  applyBatch(prefix: string, startIndex: number, count: number): Promise<void>;
  countRows(table: 'tasks' | 'sync_outbox_commits'): number | Promise<number>;
}): Promise<LocalMutationBenchmarkStats> {
  if (args.warmupOperations > 0) {
    await args.applyBatch(`${args.label}-warmup`, 0, args.warmupOperations);
  }

  const times: number[] = [];
  let nextIndex = 0;
  for (let round = 0; round < args.rounds; round += 1) {
    const startedAt = performance.now();
    await args.applyBatch(`${args.label}-measured`, nextIndex, args.operations);
    nextIndex += args.operations;
    times.push(performance.now() - startedAt);
  }

  return summarizeBenchmark(
    args.label,
    args.operations,
    times,
    await args.countRows('sync_outbox_commits'),
    await args.countRows('tasks')
  );
}

// --- Conformance scenario ---

async function runConformance(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const db = createDb<ConformanceDb>(`conf-${Date.now()}.sqlite`);
  try {
    // Create schema
    await db.schema
      .createTable('dialect_conformance')
      .ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('n_int', 'integer', (c) => c.notNull())
      .addColumn('n_bigint', 'integer', (c) => c.notNull())
      .addColumn('bigint_text', 'text', (c) => c.notNull())
      .addColumn('t_text', 'text', (c) => c.notNull())
      .addColumn('u_unique', 'text', (c) => c.notNull())
      .addColumn('b_bool', 'text', (c) => c.notNull())
      .addColumn('j_json', 'text', (c) => c.notNull())
      .addColumn('j_large', 'text', (c) => c.notNull())
      .addColumn('d_date', 'text', (c) => c.notNull())
      .addColumn('bytes', 'blob', (c) => c.notNull())
      .addColumn('nullable_text', 'text')
      .addColumn('nullable_int', 'integer')
      .addColumn('nullable_bigint', 'integer')
      .addColumn('nullable_bool', 'text')
      .addColumn('nullable_bytes', 'blob')
      .addColumn('nullable_json', 'text')
      .addColumn('nullable_date', 'text')
      .execute();
    await db.schema
      .createIndex('dialect_conformance_u_unique_idx')
      .ifNotExists()
      .on('dialect_conformance')
      .column('u_unique')
      .unique()
      .execute();

    const now = new Date('2025-01-02T03:04:05.678Z');
    const payload = {
      a: 1,
      b: [true, null, { c: 'x', d: [1, 2, 3] }],
      e: { nested: { ok: true } },
    };
    const largePayload = {
      unicode: 'こんにちは 🌍 — café — 😀',
      nested: {
        ok: true,
        bigString: 'x'.repeat(64 * 1024),
        list: Array.from({ length: 2000 }, (_, i) => ({
          i,
          v: `value-${i}`,
        })),
      },
    };
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 42]);
    const tText = 'unicode: 北京 — café — 😀 — newline:\nsecond-line';

    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'row-1',
        n_int: 123,
        n_bigint: 42,
        bigint_text: '9007199254740993',
        t_text: tText,
        u_unique: 'u-1',
        b_bool: true,
        j_json: payload,
        j_large: largePayload,
        d_date: now,
        bytes,
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    type Row = Record<string, unknown>;
    const row = (await db
      .selectFrom('dialect_conformance')
      .selectAll()
      .where('id', '=', 'row-1')
      .executeTakeFirstOrThrow()) as Row;

    assert(row.n_int === 123, 'n_int mismatch');
    assert(row.t_text === tText, 't_text mismatch');
    jsonEqual(row.j_json, payload, 'j_json');
    jsonEqual(row.j_large, largePayload, 'j_large');
    assert(row.b_bool === true, 'b_bool mismatch');
    assert(row.d_date instanceof Date, 'd_date should be Date');
    assert((row.d_date as Date).getTime() === now.getTime(), 'd_date mismatch');
    assert(
      JSON.stringify(bytesToArray(row.bytes)) ===
        JSON.stringify(Array.from(bytes)),
      'bytes mismatch'
    );

    // Unique constraint + upsert
    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'uniq-1',
        n_int: 1,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'one',
        u_unique: 'unique-key',
        b_bool: true,
        j_json: { ok: true },
        j_large: { ok: true },
        d_date: now,
        bytes: new Uint8Array([1]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .execute();

    await db
      .insertInto('dialect_conformance')
      .values({
        id: 'uniq-2',
        n_int: 2,
        n_bigint: 1,
        bigint_text: '1',
        t_text: 'two',
        u_unique: 'unique-key',
        b_bool: false,
        j_json: { ok: false },
        j_large: { ok: false },
        d_date: now,
        bytes: new Uint8Array([2]),
        nullable_text: null,
        nullable_int: null,
        nullable_bigint: null,
        nullable_bool: null,
        nullable_bytes: null,
        nullable_json: null,
        nullable_date: null,
      })
      .onConflict((oc) =>
        oc.column('u_unique').doUpdateSet({
          id: 'uniq-2',
          n_int: 2,
          t_text: 'two',
          b_bool: false,
        })
      )
      .execute();

    const uniq = (await db
      .selectFrom('dialect_conformance')
      .select(['id', 'n_int', 't_text', 'b_bool'])
      .where('u_unique', '=', 'unique-key')
      .executeTakeFirstOrThrow()) as Row;

    assert(uniq.id === 'uniq-2', 'upsert id mismatch');
    assert(uniq.n_int === 2, 'upsert n_int mismatch');

    // Transaction rollback
    let rolledBack = false;
    await db
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('dialect_conformance')
          .values({
            id: 'tx-row',
            n_int: 1,
            n_bigint: 1,
            bigint_text: '1',
            t_text: 'tx',
            u_unique: 'u-tx',
            b_bool: false,
            j_json: { ok: true },
            j_large: { ok: true },
            d_date: new Date('2025-01-01T00:00:00.000Z'),
            bytes: new Uint8Array([1, 2, 3]),
            nullable_text: null,
            nullable_int: null,
            nullable_bigint: null,
            nullable_bool: null,
            nullable_bytes: null,
            nullable_json: null,
            nullable_date: null,
          })
          .execute();
        throw new Error('rollback');
      })
      .catch((e: unknown) => {
        rolledBack = String(e).includes('rollback');
      });

    assert(rolledBack, 'expected rollback error');
    const txRow = await db
      .selectFrom('dialect_conformance')
      .select(['id'])
      .where('id', '=', 'tx-row')
      .executeTakeFirst();
    assert(txRow === undefined, 'tx-row should not persist after rollback');

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await db.destroy();
  }
}

// --- Sync scenarios ---

async function createSyncClient(serverUrl: string, actorId: string) {
  const db = createDb<RuntimeClientDb>(`sync-${Date.now()}.sqlite`);
  await ensureClientSyncSchema(db);
  await ensureSyncularAppSchema(db);

  const handlers: ClientHandlerCollection<RuntimeClientDb> = [
    tasksClientHandler,
  ];

  const transport = createHttpTransport({
    baseUrl: serverUrl,
    getHeaders: () => ({ 'x-actor-id': actorId }),
  });

  return { db, handlers, transport };
}

async function runBootstrap(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{ ok: boolean; rowCount?: number; error?: string }> {
  const client = await createSyncClient(params.serverUrl, params.actorId);
  try {
    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [
        {
          id: 'tasks',
          table: 'tasks',
          scopes: { user_id: params.actorId, project_id: 'p1' },
        },
      ],
    });
    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { ok: true, rowCount: rows.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.db.destroy();
  }
}

async function runE2eScoreboard(
  options: E2eScoreboardOptions
): Promise<{
  ok: boolean;
  rows?: number;
  queryIterations?: number;
  metrics?: E2eScoreboardMetric[];
  error?: string;
}> {
  const actorId = options.actorId;
  const projectId = options.projectId ?? 'p1';
  const queryIterations = options.queryIterations ?? 25;
  const metrics: E2eScoreboardMetric[] = [];
  const tsClient = await createSyncClient(options.serverUrl, actorId);
  let rustDatabase: SyncularAppDatabase | undefined;
  let cachedRustDatabase: SyncularAppDatabase | undefined;

  try {
    const pushMetric = (
      name: string,
      value: number,
      unit: E2eScoreboardMetric['unit'] = 'ms'
    ) => metrics.push({ name, value, unit });
    const rustPullOptions: SyncularV2PullOptions = {
      includeSnapshotRows: options.rustIncludeSnapshotRows ?? false,
      collectChangedRows: options.rustCollectChangedRows ?? false,
      collectServerTimings: true,
      limitSnapshotRows: 5_000,
      maxSnapshotPages: 100,
    };
    if (options.rustMaxSnapshotChangedRows !== undefined) {
      rustPullOptions.maxSnapshotChangedRows =
        options.rustMaxSnapshotChangedRows;
    }

    const tsBootstrapStartedAt = performance.now();
    await syncPullOnce(tsClient.db, tsClient.transport, tsClient.handlers, {
      clientId: `ts-e2e-${Date.now()}`,
      subscriptions: [
        {
          id: 'sub-tasks',
          table: 'tasks',
          scopes: { user_id: actorId },
        },
      ],
      limitSnapshotRows: 5_000,
      maxSnapshotPages: 100,
    });
    pushMetric('ts_bootstrap_ms', performance.now() - tsBootstrapStartedAt);
    const tsRows = await tsClient.db
      .selectFrom('tasks')
      .select(({ fn }) => fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow();
    pushMetric('ts_rows', Number(tsRows.count), 'rows');

    rustDatabase = await createSyncularAppDatabase({
      worker: () =>
        new Worker('/syncular-v2-worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
      getHeaders: () => ({ 'x-actor-id': actorId }),
      subscriptions: false,
      config: {
        baseUrl: `${options.serverUrl.replace(/\/$/, '')}/sync`,
        actorId,
        clientId: `rust-e2e-${Date.now()}`,
        projectId,
        fileName: `rust-e2e-${Date.now()}.sqlite`,
        storage: options.rustStorage ?? 'memory',
        clearOnInit: true,
        pull: rustPullOptions,
      },
    });
    await rustDatabase.client.setSubscriptions([
      taskSubscription({ actorId }),
    ]);
    const rustDiagnostics = rustDatabase.client as unknown as RustE2eDiagnostics;
    await rustDiagnostics.resetTransportStats();
    const rustBootstrapStartedAt = performance.now();
    const rustSync = await rustDatabase.client.syncPull();
    pushMetric(
      'rust_bootstrap_ms',
      performance.now() - rustBootstrapStartedAt
    );
    pushMetric('rust_pull_request_ms', rustSync.timings.pullRequestMs);
    pushMetric('rust_snapshot_fetch_ms', rustSync.timings.snapshotFetchMs);
    pushMetric('rust_pull_apply_ms', rustSync.timings.pullApplyMs);
    pushMetric('rust_changed_row_count', rustSync.changedRows.length, 'count');
    pushMetric(
      'rust_changed_rows_truncated',
      rustSync.changedRowsTruncated ? 1 : 0,
      'count'
    );
    const rustStats = await rustDiagnostics.transportStats();
    pushMetric(
      'rust_snapshot_chunk_decode_ms',
      rustStats.snapshotChunkDecodeMs
    );
    pushMetric(
      'rust_snapshot_chunk_decompress_ms',
      rustStats.snapshotChunkDecompressMs
    );
    pushMetric('rust_snapshot_chunk_hash_ms', rustStats.snapshotChunkHashMs);
    pushMetric(
      'rust_server_bootstrap_snapshot_query_ms',
      rustStats.serverBootstrapSnapshotQueryMs
    );
    pushMetric(
      'rust_server_bootstrap_row_frame_encode_ms',
      rustStats.serverBootstrapRowFrameEncodeMs
    );
    pushMetric(
      'rust_server_bootstrap_chunk_cache_lookup_ms',
      rustStats.serverBootstrapChunkCacheLookupMs
    );
    pushMetric(
      'rust_server_bootstrap_chunk_gzip_ms',
      rustStats.serverBootstrapChunkGzipMs
    );
    pushMetric(
      'rust_server_bootstrap_chunk_hash_ms',
      rustStats.serverBootstrapChunkHashMs
    );
    pushMetric(
      'rust_server_bootstrap_chunk_persist_ms',
      rustStats.serverBootstrapChunkPersistMs
    );
    pushMetric('rust_request_count', rustStats.requestCount, 'count');
    pushMetric('rust_request_bytes', rustStats.requestBytes, 'bytes');
    pushMetric('rust_response_bytes', rustStats.responseBytes, 'bytes');
    pushMetric(
      'rust_snapshot_chunk_binary_count',
      rustStats.snapshotChunkBinaryCount,
      'count'
    );
    pushMetric(
      'rust_snapshot_chunk_json_count',
      rustStats.snapshotChunkJsonCount,
      'count'
    );
    pushMetric(
      'rust_snapshot_chunk_row_count',
      rustStats.snapshotChunkRowCount,
      'rows'
    );
    const rustRows = await rustDatabase.db
      .selectFrom('tasks')
      .select(({ fn }) => fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow();
    pushMetric('rust_rows', Number(rustRows.count), 'rows');

    cachedRustDatabase = await createSyncularAppDatabase({
      worker: () =>
        new Worker('/syncular-v2-worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
      getHeaders: () => ({ 'x-actor-id': actorId }),
      subscriptions: false,
      config: {
        baseUrl: `${options.serverUrl.replace(/\/$/, '')}/sync`,
        actorId,
        clientId: `rust-e2e-cached-${Date.now()}`,
        projectId,
        fileName: `rust-e2e-cached-${Date.now()}.sqlite`,
        storage: options.rustStorage ?? 'memory',
        clearOnInit: true,
        pull: rustPullOptions,
      },
    });
    await cachedRustDatabase.client.setSubscriptions([
      taskSubscription({ actorId }),
    ]);
    const cachedRustDiagnostics =
      cachedRustDatabase.client as unknown as RustE2eDiagnostics;
    await cachedRustDiagnostics.resetTransportStats();
    const cachedRustBootstrapStartedAt = performance.now();
    const cachedRustSync = await cachedRustDatabase.client.syncPull();
    pushMetric(
      'rust_cached_bootstrap_ms',
      performance.now() - cachedRustBootstrapStartedAt
    );
    pushMetric(
      'rust_cached_pull_request_ms',
      cachedRustSync.timings.pullRequestMs
    );
    pushMetric(
      'rust_cached_snapshot_fetch_ms',
      cachedRustSync.timings.snapshotFetchMs
    );
    pushMetric(
      'rust_cached_pull_apply_ms',
      cachedRustSync.timings.pullApplyMs
    );
    const cachedRustStats = await cachedRustDiagnostics.transportStats();
    pushMetric(
      'rust_cached_snapshot_chunk_decompress_ms',
      cachedRustStats.snapshotChunkDecompressMs
    );
    pushMetric(
      'rust_cached_snapshot_chunk_hash_ms',
      cachedRustStats.snapshotChunkHashMs
    );
    pushMetric(
      'rust_cached_snapshot_chunk_decode_ms',
      cachedRustStats.snapshotChunkDecodeMs
    );
    pushMetric(
      'rust_cached_server_bootstrap_snapshot_query_ms',
      cachedRustStats.serverBootstrapSnapshotQueryMs
    );
    pushMetric(
      'rust_cached_server_bootstrap_row_frame_encode_ms',
      cachedRustStats.serverBootstrapRowFrameEncodeMs
    );
    pushMetric(
      'rust_cached_server_bootstrap_chunk_cache_lookup_ms',
      cachedRustStats.serverBootstrapChunkCacheLookupMs
    );
    pushMetric(
      'rust_cached_server_bootstrap_chunk_gzip_ms',
      cachedRustStats.serverBootstrapChunkGzipMs
    );
    pushMetric(
      'rust_cached_server_bootstrap_chunk_hash_ms',
      cachedRustStats.serverBootstrapChunkHashMs
    );
    pushMetric(
      'rust_cached_server_bootstrap_chunk_persist_ms',
      cachedRustStats.serverBootstrapChunkPersistMs
    );
    pushMetric(
      'rust_cached_request_count',
      cachedRustStats.requestCount,
      'count'
    );
    pushMetric(
      'rust_cached_response_bytes',
      cachedRustStats.responseBytes,
      'bytes'
    );
    pushMetric(
      'rust_cached_snapshot_chunk_binary_count',
      cachedRustStats.snapshotChunkBinaryCount,
      'count'
    );
    const cachedRustRows = await cachedRustDatabase.db
      .selectFrom('tasks')
      .select(({ fn }) => fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow();
    pushMetric('rust_cached_rows', Number(cachedRustRows.count), 'rows');

    await collectLocalQueryMetrics({
      prefix: 'ts',
      db: tsClient.db as unknown as Kysely<any>,
      actorId,
      projectId,
      iterations: queryIterations,
      pushMetric,
    });
    await collectLocalQueryMetrics({
      prefix: 'rust',
      db: rustDatabase.db as unknown as Kysely<any>,
      actorId,
      projectId,
      iterations: queryIterations,
      pushMetric,
    });

    assert(Number(tsRows.count) === options.rows, 'TS row count mismatch');
    assert(Number(rustRows.count) === options.rows, 'Rust row count mismatch');
    assert(
      Number(cachedRustRows.count) === options.rows,
      'Cached Rust row count mismatch'
    );
    return { ok: true, rows: options.rows, queryIterations, metrics };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Promise.all([
      tsClient.db.destroy(),
      rustDatabase?.close(),
      cachedRustDatabase?.close(),
    ]);
  }
}

async function collectLocalQueryMetrics(args: {
  prefix: 'ts' | 'rust';
  db: Kysely<any>;
  actorId: string;
  projectId: string;
  iterations: number;
  pushMetric(
    name: string,
    value: number,
    unit?: E2eScoreboardMetric['unit']
  ): void;
}): Promise<void> {
  const list = await measureSamples(args.iterations, async () => {
    const rows = await args.db
      .selectFrom('tasks')
      .select(['id', 'title', 'server_version'])
      .where('user_id', '=', args.actorId)
      .where('project_id', '=', args.projectId)
      .orderBy('id')
      .limit(50)
      .execute();
    assert(rows.length > 0, `${args.prefix} list query returned no rows`);
  });
  emitTimedSamples(args.pushMetric, `${args.prefix}_local_list`, list);

  const search = await measureSamples(args.iterations, async (index) => {
    const rows = await args.db
      .selectFrom('tasks')
      .select(['id', 'title', 'server_version'])
      .where('user_id', '=', args.actorId)
      .where('project_id', '=', args.projectId)
      .where('title', 'like', `%Task ${index % 100}%`)
      .orderBy('id')
      .limit(50)
      .execute();
    assert(rows.length > 0, `${args.prefix} search query returned no rows`);
  });
  emitTimedSamples(args.pushMetric, `${args.prefix}_local_search`, search);

  const aggregate = await measureSamples(args.iterations, async () => {
    const rows = await args.db
      .selectFrom('tasks')
      .select(({ fn }) => [
        'completed',
        fn.count<number>('id').as('count'),
      ])
      .where('user_id', '=', args.actorId)
      .where('project_id', '=', args.projectId)
      .groupBy('completed')
      .orderBy('completed')
      .execute();
    assert(rows.length > 0, `${args.prefix} aggregate query returned no rows`);
  });
  emitTimedSamples(args.pushMetric, `${args.prefix}_aggregate`, aggregate);
}

async function measureSamples(
  iterations: number,
  run: (index: number) => Promise<void>
): Promise<TimedSamples> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await run(index);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: samples[0] ?? 0,
    max: samples[samples.length - 1] ?? 0,
  };
}

function emitTimedSamples(
  pushMetric: (
    name: string,
    value: number,
    unit?: E2eScoreboardMetric['unit']
  ) => void,
  prefix: string,
  samples: TimedSamples
): void {
  pushMetric(`${prefix}_p50_ms`, samples.p50);
  pushMetric(`${prefix}_p95_ms`, samples.p95);
  pushMetric(`${prefix}_min_ms`, samples.min);
  pushMetric(`${prefix}_max_ms`, samples.max);
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) return 0;
  const index = Math.min(
    samples.length - 1,
    Math.max(0, Math.ceil(samples.length * percentileValue) - 1)
  );
  return samples[index] ?? 0;
}

async function runPushPull(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{ ok: boolean; finalRowCount?: number; error?: string }> {
  const client = await createSyncClient(params.serverUrl, params.actorId);
  try {
    const sub = {
      id: 'tasks',
      table: 'tasks',
      scopes: { user_id: params.actorId, project_id: 'p1' },
    };

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    await enqueueOutboxCommit(client.db, {
      schemaVersion: syncularGeneratedSchemaVersion,
      operations: [
        {
          table: 'tasks',
          row_id: 'browser-task-1',
          op: 'upsert',
          payload: {
            title: 'Browser Task',
            completed: 0,
            project_id: 'p1',
          },
          base_version: null,
        },
      ],
    });

    const pushResult = await syncPushOnce(client.db, client.transport, {
      clientId: params.clientId,
    });

    if (!pushResult.pushed || pushResult.response?.status !== 'applied') {
      return {
        ok: false,
        error: `Push failed: ${pushResult.response?.status}`,
      };
    }

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: params.clientId,
      subscriptions: [sub],
    });

    const rows = await client.db.selectFrom('tasks').selectAll().execute();
    return { ok: true, finalRowCount: rows.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.db.destroy();
  }
}

async function runHostStore(): Promise<{
  ok: boolean;
  opfsSupported?: boolean;
  pendingCount?: number;
  retryBaseVersion?: number;
  subscriptionCursor?: number;
  rowIds?: string[];
  error?: string;
}> {
  const opfsSupported = typeof navigator.storage?.getDirectory === 'function';
  const db = createDb<RuntimeClientDb>(`host-${Date.now()}.sqlite`, {
    preferOPFS: true,
  });

  try {
    const host = await createSyncularAppWebStoreHost(db, {
      schemaVersion: 11,
    });

    const clientCommitId = await host.applyLocalOperation(
      {
        table: 'tasks',
        row_id: 'host-task-1',
        op: 'upsert',
        payload: {
          title: 'Host Task',
          completed: 0,
          user_id: 'browser-host-user',
          project_id: 'p1',
        },
        base_version: 1,
      },
      null
    );

    const [original] = await host.pendingOutbox(10);
    assert(Boolean(original), 'expected pending outbox commit');
    assert(
      original!.client_commit_id === clientCommitId,
      'client commit id mismatch'
    );
    assert(original!.schema_version === 11, 'schema version mismatch');

    const rejectedResponse = {
      ok: true as const,
      status: 'rejected' as const,
      results: [
        {
          opIndex: 0,
          status: 'conflict' as const,
          message: 'version conflict',
          server_version: 8,
          server_row: {
            id: 'host-task-1',
            title: 'Server Task',
            completed: 0,
            user_id: 'browser-host-user',
            project_id: 'p1',
            server_version: 8,
          },
        },
      ],
    };

    await host.markOutboxFailed(original!.id, 'REJECTED', rejectedResponse);
    await host.insertConflict(original!, rejectedResponse.results[0]!);

    const conflicts = await host.conflictSummaries();
    assert(conflicts.length === 1, 'expected one pending conflict');
    const retryCommitId = await host.retryConflictKeepLocal(conflicts[0]!.id);
    const retry = (await host.pendingOutbox(10)).find(
      (commit) => commit.client_commit_id === retryCommitId
    );
    assert(Boolean(retry), 'expected retry outbox commit');
    const retryOperations = JSON.parse(retry!.operations_json);

    await host.upsertSubscriptionState({
      subscription_id: 'tasks',
      table: 'tasks',
      scopes: { user_id: 'browser-host-user', project_id: 'p1' },
      cursor: 12,
      bootstrap_state: null,
      status: 'active',
    });
    const subscription = await host.subscriptionState('tasks');

    await host.applyChange({
      table: 'tasks',
      row_id: 'host-task-2',
      op: 'upsert',
      row_json: {
        title: 'Pulled Host Task',
        completed: 1,
        user_id: 'browser-host-user',
        project_id: 'p2',
      },
      row_version: 9,
      scopes: {},
    });
    await host.clearTableForScopes('tasks', { project_id: 'p2' });

    const rows = JSON.parse(await host.listTableJson('tasks')) as Array<{
      id: string;
    }>;
    return {
      ok: true,
      opfsSupported,
      pendingCount: (await host.pendingOutbox(10)).length,
      retryBaseVersion: retryOperations[0]?.base_version,
      subscriptionCursor: subscription?.cursor,
      rowIds: rows.map((row) => row.id).sort(),
    };
  } catch (err) {
    return {
      ok: false,
      opfsSupported,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await db.destroy();
  }
}

async function runRustOwnedSqlite(): Promise<{
  ok: boolean;
  clientCommitIds?: string[];
  taskRows?: number;
  outboxRows?: number;
  schemaVersion?: number | null;
  currentSchemaVersion?: number;
  error?: string;
}> {
  let db: Awaited<ReturnType<typeof createSyncularRustOwnedSqlite>> | undefined;
  try {
    db = await createSyncularRustOwnedSqlite({
      config: {
        fileName: `rust-owned-idb-${Date.now()}.sqlite`,
        storage: 'indexedDb',
        clearOnInit: true,
      },
    });
    const clientCommitIds = db.applyLocalOperationsBatch([
      {
        operation: makeTaskOperation(
          'rust-owned-idb-task',
          1,
          'rust-owned-user'
        ),
      },
    ]);
    const schemaState = db.generatedSchemaState();

    return {
      ok: true,
      clientCommitIds,
      taskRows: db.countRows('tasks'),
      outboxRows: db.countRows('sync_outbox_commits'),
      schemaVersion: schemaState.schemaVersion,
      currentSchemaVersion: schemaState.currentSchemaVersion,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

async function runRustOwnedSqliteSchemaMismatch(): Promise<{
  ok: boolean;
  errorMessage?: string;
  error?: string;
}> {
  const fileName = `rust-owned-schema-mismatch-${Date.now()}.sqlite`;
  let db: Awaited<ReturnType<typeof createSyncularRustOwnedSqlite>> | undefined;
  try {
    db = await createSyncularRustOwnedSqlite({
      config: {
        fileName,
        storage: 'indexedDb',
        clearOnInit: true,
      },
    });
    db.executeSql('drop table tasks');
    db.executeSql('create table tasks (id text primary key)');
    db.close();
    db = undefined;

    try {
      const reopened = await createSyncularRustOwnedSqlite({
        config: {
          fileName,
          storage: 'indexedDb',
          clearOnInit: false,
        },
      });
      reopened.close();
      return {
        ok: false,
        error: 'expected rust-owned sqlite open to reject mismatched schema',
      };
    } catch (err) {
      return {
        ok: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

async function runRustOwnedSqliteOpfsWorker(): Promise<{
  ok: boolean;
  clientCommitIds?: string[];
  taskRows?: number;
  outboxRows?: number;
  error?: string;
}> {
  let worker: RustOwnedSqliteWorkerClient | undefined;
  try {
    worker = await RustOwnedSqliteWorkerClient.open({
      fileName: `rust-owned-opfs-${Date.now()}.sqlite`,
      storage: 'opfsSahPool',
      clearOnInit: true,
    });
    const clientCommitIds = await worker.applyLocalOperationsBatch([
      {
        operation: makeTaskOperation(
          'rust-owned-opfs-task',
          1,
          'rust-owned-opfs-user'
        ),
      },
    ]);

    return {
      ok: true,
      clientCommitIds,
      taskRows: await worker.countRows('tasks'),
      outboxRows: await worker.countRows('sync_outbox_commits'),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await worker?.close();
  }
}

async function runRustOwnedStoreParity(): Promise<{
  ok: boolean;
  clientCommitId?: string;
  retryBaseVersion?: number;
  subscriptionCursor?: number;
  rowIds?: string[];
  outboxRows?: number;
  error?: string;
}> {
  let db: Awaited<ReturnType<typeof createSyncularRustOwnedSqlite>> | undefined;
  try {
    db = await createSyncularRustOwnedSqlite({
      config: {
        fileName: `rust-owned-parity-${Date.now()}.sqlite`,
        storage: 'indexedDb',
        clearOnInit: true,
        schemaVersion: 7,
      },
    });

    const [clientCommitId] = db.applyLocalOperationsBatch([
      {
        operation: {
          table: 'tasks',
          row_id: 'parity-task-1',
          op: 'upsert',
          payload: {
            title: 'Parity task',
            completed: 0,
            user_id: 'user-rust',
            project_id: 'p0',
          },
          base_version: 1,
        },
      },
    ]);
    assert(Boolean(clientCommitId), 'expected client commit id');

    const rows = await db.listTable<{ id: string; server_version: number }>(
      'tasks'
    );
    assert(rows.length === 1, 'expected one local row');
    assert(rows[0]?.id === 'parity-task-1', 'unexpected local row id');
    assert(rows[0]?.server_version === 0, 'expected default server version');

    const pending = await db.pendingOutbox(10);
    assert(pending.length === 1, 'expected one pending outbox row');
    assert(
      pending[0]?.client_commit_id === clientCommitId,
      'pending outbox commit mismatch'
    );
    assert(pending[0]?.schema_version === 7, 'schema version mismatch');

    const original = pending[0]!;
    await db.insertConflict(original, {
      opIndex: 0,
      status: 'conflict',
      message: 'version conflict',
      server_version: 5,
      server_row: { id: 'parity-task-1', server_version: 5 },
    });

    const conflicts = await db.conflictSummaries();
    assert(conflicts.length === 1, 'expected one conflict');
    assert(
      conflicts[0]?.server_version === 5,
      'conflict server version mismatch'
    );

    const retryCommitId = await db.retryConflictKeepLocal(conflicts[0]!.id);
    assert(Boolean(retryCommitId), 'expected retry commit id');
    assert(
      (await db.conflictSummaries()).length === 0,
      'expected conflict to be resolved'
    );

    const retryRows = await db.pendingOutbox(10);
    const retry = retryRows.find(
      (row) => row.client_commit_id === retryCommitId
    );
    const retryOperations = JSON.parse(
      retry?.operations_json ?? '[]'
    ) as Array<{
      base_version?: number;
    }>;
    assert(
      retryOperations[0]?.base_version === 5,
      'retry base version mismatch'
    );

    await db.upsertSubscriptionState({
      subscription_id: 'sub-tasks',
      table: 'tasks',
      scopes: { user_id: 'user-rust' },
      cursor: 42,
      bootstrap_state: {
        asOfCommitSeq: 40,
        tables: ['tasks'],
        tableIndex: 0,
        rowCursor: null,
      },
      status: 'active',
    });
    const subscription = await db.subscriptionState('sub-tasks');
    assert(subscription?.cursor === 42, 'subscription cursor mismatch');
    await db.deleteSubscriptionState('sub-tasks');
    assert(
      (await db.subscriptionState('sub-tasks')) === null,
      'subscription should be deleted'
    );

    await db.applyChange({
      table: 'tasks',
      row_id: 'parity-task-2',
      op: 'upsert',
      row_json: {
        title: 'Pulled parity task',
        completed: 1,
        user_id: 'user-rust',
        project_id: 'p1',
      },
      row_version: 9,
      scopes: {},
    });
    await db.clearTableForScopes('tasks', { project_id: 'p1' });
    const afterScopeClear = await db.listTable<{ id: string }>('tasks');

    return {
      ok: true,
      clientCommitId,
      retryBaseVersion: retryOperations[0]?.base_version,
      subscriptionCursor: subscription?.cursor,
      rowIds: afterScopeClear.map((row) => row.id).sort(),
      outboxRows: db.countRows('sync_outbox_commits'),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

async function runRustOwnedKyselyLive(): Promise<{
  ok: boolean;
  initialRows?: number;
  liveSnapshots?: Array<{ initial: boolean; ids: string[] }>;
  selectedIds?: string[];
  updatedTitle?: string;
  runtimePackage?: string;
  runtimeProtocol?: number;
  runtimeRustFeature?: string;
  runtimeStorage?: string;
  runtimeFallbackFrom?: string;
  runtimeFallbackTo?: string;
  error?: string;
}> {
  const liveSnapshots: Array<{ initial: boolean; ids: string[] }> = [];
  let syncular: SyncularAppDatabase | undefined;
  try {
    syncular = await createSyncularAppDatabase({
      worker: () =>
        new Worker('/syncular-v2-worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
      config: {
        baseUrl: '/sync',
        actorId: 'kysely-user',
        clientId: 'kysely-live-client',
        projectId: 'p1',
        fileName: `rust-owned-kysely-${Date.now()}.sqlite`,
        clearOnInit: true,
      },
    });
    const { db, client, live } = syncular;
    const runtimeInfo = await client.runtimeInfo();
    assert(
      runtimeInfo.packageName === '@syncular/client-rust',
      'runtime package mismatch'
    );
    assert(
      runtimeInfo.workerProtocolVersion === 1,
      'runtime protocol mismatch'
    );
    assert(
      runtimeInfo.storage === 'opfsSahPool' ||
        runtimeInfo.storageFallback?.from === 'opfsSahPool',
      'runtime storage mismatch'
    );
    assert(
      runtimeInfo.rust?.features.includes('web-owned-sqlite') === true,
      'runtime rust feature mismatch'
    );

    const query = db
      .selectFrom('tasks')
      .select(['id', 'title'])
      .where('project_id', '=', 'p1')
      .orderBy('id');

    const subscription = await live(query, {
      onChange(rows, event) {
        liveSnapshots.push({
          initial: event.initial,
          ids: rows.map((row) => String(row.id)),
        });
      },
    });

    await client.applyLocalOperation(
      newTaskOperation({
        id: 'kysely-live-client-write',
        title: 'Kysely live client write',
        user_id: 'kysely-user',
        project_id: 'p1',
      })
    );
    await db
      .insertInto('tasks')
      .values({
        id: 'kysely-live-1',
        title: 'Kysely live task',
        completed: 0,
        user_id: 'kysely-user',
        project_id: 'p1',
        server_version: 0,
      })
      .execute();
    await db
      .insertInto('tasks')
      .values({
        id: 'kysely-live-ignored',
        title: 'Other project',
        completed: 0,
        user_id: 'kysely-user',
        project_id: 'p2',
        server_version: 0,
      })
      .execute();
    await db
      .updateTable('tasks')
      .set(taskPatchPayload({ title: 'Kysely live task updated' }))
      .where('id', '=', 'kysely-live-1')
      .execute();

    const selected = await query.execute();
    const updated = await db
      .selectFrom('tasks')
      .select(['title'])
      .where('id', '=', 'kysely-live-1')
      .executeTakeFirstOrThrow();
    subscription.unsubscribe();

    return {
      ok: true,
      initialRows: liveSnapshots[0]?.ids.length,
      liveSnapshots,
      selectedIds: selected.map((row) => row.id),
      updatedTitle: updated.title,
      runtimePackage: runtimeInfo.packageName,
      runtimeProtocol: runtimeInfo.workerProtocolVersion,
      runtimeRustFeature: runtimeInfo.rust?.features[0],
      runtimeStorage: runtimeInfo.storage,
      runtimeFallbackFrom: runtimeInfo.storageFallback?.from,
      runtimeFallbackTo: runtimeInfo.storageFallback?.to,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await syncular?.close();
  }
}

async function runRustOwnedSqliteClient(params: {
  serverUrl: string;
  actorId: string;
  clientId: string;
}): Promise<{
  ok: boolean;
  clientCommitId?: string;
  pushedCommits?: number;
  changedTables?: string[];
  localRowCount?: number;
  rowIds?: string[];
  schemaVersion?: number | null;
  currentSchemaVersion?: number;
  runtimeStorage?: string;
  runtimeFallbackFrom?: string;
  runtimeFallbackTo?: string;
  error?: string;
}> {
  let syncular: SyncularAppDatabase | undefined;
  try {
    syncular = await createSyncularAppDatabase({
      worker: () =>
        new Worker('/syncular-v2-worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
      config: {
        baseUrl: `${params.serverUrl}/sync`,
        actorId: params.actorId,
        clientId: params.clientId,
        projectId: 'p1',
        fileName: `rust-owned-client-opfs-${Date.now()}.sqlite`,
        clearOnInit: true,
      },
      getHeaders: () => ({ 'x-actor-id': params.actorId }),
    });
    const { client } = syncular;
    const runtimeInfo = await client.runtimeInfo();
    assert(
      runtimeInfo.storage === 'opfsSahPool' ||
        runtimeInfo.storageFallback?.from === 'opfsSahPool',
      'runtime storage mismatch'
    );

    const clientCommitId = await client.applyLocalOperation(
      newTaskOperation(
        {
          id: 'rust-owned-client-task-1',
          title: 'Rust Owned SQLite Task',
          user_id: params.actorId,
          project_id: 'p1',
        },
        null
      )
    );
    const localRows = await client.listTable<{ id: string }>('tasks');
    const push = await client.syncPush();
    const pull = await client.syncPull();
    const rows = await client.listTable<{ id: string }>('tasks');
    const schemaState = await client.generatedSchemaState();

    return {
      ok: true,
      clientCommitId,
      pushedCommits: push.pushedCommits,
      changedTables: pull.changedTables,
      localRowCount: localRows.length,
      rowIds: rows.map((row) => row.id).sort(),
      schemaVersion: schemaState.schemaVersion,
      currentSchemaVersion: schemaState.currentSchemaVersion,
      runtimeStorage: runtimeInfo.storage,
      runtimeFallbackFrom: runtimeInfo.storageFallback?.from,
      runtimeFallbackTo: runtimeInfo.storageFallback?.to,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await syncular?.close();
  }
}

async function runLocalMutationBenchmark(
  options: LocalMutationBenchmarkOptions = {}
): Promise<{
  ok: boolean;
  operations?: number;
  rounds?: number;
  preferOPFS?: boolean;
  includeDirectRustOwned?: boolean;
  js?: LocalMutationBenchmarkStats;
  jsBatch?: LocalMutationBenchmarkStats;
  rustOwnedSqliteIdb?: LocalMutationBenchmarkStats;
  rustOwnedSqliteOpfsWorker?: LocalMutationBenchmarkStats;
  ratioRustOwnedSqliteIdbToJsBatch?: number;
  ratioRustOwnedSqliteOpfsWorkerToJsBatch?: number;
  error?: string;
}> {
  const operations = options.operations ?? 100;
  const rounds = options.rounds ?? 5;
  const warmupOperations = options.warmupOperations ?? 10;
  const preferOPFS = options.preferOPFS ?? true;
  const includeDirectRustOwned = options.includeDirectRustOwned ?? false;
  const actorId = 'browser-bench-user';
  const jsDb = createDb<RuntimeClientDb>(`bench-js-${Date.now()}.sqlite`, {
    preferOPFS,
  });
  const jsBatchDb = createDb<RuntimeClientDb>(
    `bench-js-batch-${Date.now()}.sqlite`,
    {
      preferOPFS,
    }
  );

  try {
    await ensureClientSyncSchema(jsDb);
    await ensureSyncularAppSchema(jsDb);
    await ensureClientSyncSchema(jsBatchDb);
    await ensureSyncularAppSchema(jsBatchDb);
    const rustOwnedSqliteIdb = includeDirectRustOwned
      ? await createSyncularRustOwnedSqlite({
          config: {
            fileName: `bench-rust-owned-idb-${Date.now()}.sqlite`,
            storage: 'indexedDb',
            clearOnInit: true,
            appSchema: syncularGeneratedAppSchema,
          },
        })
      : undefined;
    if (rustOwnedSqliteIdb) {
      await ensureRustOwnedBenchmarkSchema(rustOwnedSqliteIdb);
    }
    const rustOwnedSqliteOpfsWorker = await RustOwnedSqliteWorkerClient.open({
      fileName: `bench-rust-owned-opfs-${Date.now()}.sqlite`,
      storage: 'opfsSahPool',
      clearOnInit: true,
    });

    const js = await measureLocalMutationBatches({
      label: 'legacy JS host-store (single)',
      operations,
      rounds,
      warmupOperations,
      db: jsDb,
      apply: (prefix, index) =>
        applyJsLocalTaskOperation(
          jsDb,
          makeTaskOperation(prefix, index, actorId)
        ),
    });
    const jsBatch = await measureLocalMutationBatchCalls({
      label: 'legacy JS host-store (batch)',
      operations,
      rounds,
      warmupOperations,
      db: jsBatchDb,
      applyBatch: (prefix, startIndex, count) =>
        applyJsLocalTaskOperationsBatch(
          jsBatchDb,
          Array.from({ length: count }, (_, index) =>
            makeTaskOperation(prefix, startIndex + index, actorId)
          )
        ),
    });
    const rustOwnedSqliteIdbStats = rustOwnedSqliteIdb
      ? await measureExternalLocalMutationBatchCalls({
          label: 'Rust-owned sqlite-wasm-rs (IndexedDB)',
          operations,
          rounds,
          warmupOperations,
          countRows: (table) => rustOwnedSqliteIdb.countRows(table),
          applyBatch: (prefix, startIndex, count) => {
            rustOwnedSqliteIdb.applyLocalOperationsBatch(
              Array.from({ length: count }, (_, index) => ({
                operation: makeTaskOperation(
                  prefix,
                  startIndex + index,
                  actorId
                ),
              }))
            );
            return Promise.resolve();
          },
        })
      : undefined;
    const rustOwnedSqliteOpfsWorkerStats =
      await measureExternalLocalMutationBatchCalls({
        label: 'Rust-owned sqlite-wasm-rs (OPFS Worker)',
        operations,
        rounds,
        warmupOperations,
        countRows: (table) => rustOwnedSqliteOpfsWorker.countRows(table),
        applyBatch: (prefix, startIndex, count) =>
          rustOwnedSqliteOpfsWorker
            .applyLocalOperationsBatch(
              Array.from({ length: count }, (_, index) => ({
                operation: makeTaskOperation(
                  prefix,
                  startIndex + index,
                  actorId
                ),
              }))
            )
            .then(() => undefined),
      });
    rustOwnedSqliteIdb?.close();
    await rustOwnedSqliteOpfsWorker.close();

    return {
      ok: true,
      operations,
      rounds,
      preferOPFS,
      includeDirectRustOwned,
      js,
      jsBatch,
      rustOwnedSqliteIdb: rustOwnedSqliteIdbStats,
      rustOwnedSqliteOpfsWorker: rustOwnedSqliteOpfsWorkerStats,
      ratioRustOwnedSqliteIdbToJsBatch: rustOwnedSqliteIdbStats
        ? rustOwnedSqliteIdbStats.medianMs / jsBatch.medianMs
        : undefined,
      ratioRustOwnedSqliteOpfsWorkerToJsBatch:
        rustOwnedSqliteOpfsWorkerStats.medianMs / jsBatch.medianMs,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Promise.all([jsDb.destroy(), jsBatchDb.destroy()]);
  }
}

async function runFeatureWorkloadBenchmark(
  options: FeatureWorkloadBenchmarkOptions = {}
): Promise<{
  ok: boolean;
  operations?: number;
  rounds?: number;
  storage?: string;
  readHeavyQuery?: LocalMutationBenchmarkStats;
  liveQueryRefresh?: LocalMutationBenchmarkStats;
  crdtTextUpdates?: LocalMutationBenchmarkStats;
  encryptedFieldPush?: LocalMutationBenchmarkStats;
  encryptedCrdtTextUpdates?: LocalMutationBenchmarkStats;
  blobMetadata?: LocalMutationBenchmarkStats;
  largeSnapshotRead?: LocalMutationBenchmarkStats;
  multiTableCommit?: LocalMutationBenchmarkStats;
  error?: string;
}> {
  const operations = options.operations ?? 50;
  const rounds = options.rounds ?? 5;
  const warmupOperations = options.warmupOperations ?? 5;
  const storage = options.storage ?? 'indexedDb';
  const actorId = 'browser-feature-bench-user';
  const projectId = 'feature-project';
  let syncular: SyncularAppDatabase | undefined;
  let encryptedSyncular: SyncularAppDatabase | undefined;

  try {
    syncular = await createSyncularAppDatabase({
      worker: () =>
        new Worker('/syncular-v2-worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
      config: {
        baseUrl: '/sync',
        actorId,
        clientId: `feature-bench-${Date.now()}`,
        projectId,
        fileName: `feature-bench-${storage}-${Date.now()}.sqlite`,
        storage,
        clearOnInit: true,
      },
    });
    const { client, db, mutations, blobs, live } = syncular;

    await client.applyLocalOperationsCommit([
      {
        operation: newProjectOperation(
          {
            id: projectId,
            name: 'Feature Benchmark',
            owner_id: actorId,
          },
          null
        ),
      },
    ]);
    await client.applyLocalOperationsCommit(
      Array.from({ length: operations * 4 }, (_, index) => ({
        operation: newTaskOperation(
          {
            id: `feature-seed-task-${index}`,
            title: `Seed task ${index}`,
            completed: index % 2,
            user_id: actorId,
            project_id: projectId,
          },
          null
        ),
      }))
    );

    const readHeavyQuery = await measureClientRounds({
      label: 'Rust-owned Kysely read-heavy query',
      operations,
      rounds,
      warmupOperations,
      client,
      run: async (_prefix, startIndex, count) => {
        for (let index = 0; index < count; index += 1) {
          const offset = (startIndex + index) % Math.max(1, operations * 2);
          const rows = await db
            .selectFrom('tasks')
            .select(['id', 'title', 'completed', 'server_version'])
            .where('project_id', '=', projectId)
            .where('completed', '=', offset % 2)
            .orderBy('id')
            .limit(50)
            .execute();
          assert(rows.length > 0, 'read-heavy query returned no rows');
        }
      },
    });

    const liveQuery = db
      .selectFrom('tasks')
      .select(['id', 'title'])
      .where('project_id', '=', projectId)
      .where('completed', '=', 0)
      .orderBy('id')
      .limit(25);
    let liveEvents = 0;
    const subscription = await live(liveQuery, {
      onChange(rows) {
        liveEvents += 1;
        assert(rows.length <= 25, 'live query returned too many rows');
      },
    });
    const liveQueryRefresh = await measureClientRounds({
      label: 'Rust-owned live query refresh',
      operations,
      rounds,
      warmupOperations,
      client,
      run: async (prefix, startIndex, count) => {
        for (let index = 0; index < count; index += 1) {
          const absoluteIndex = startIndex + index;
          const rowId = `feature-seed-task-${absoluteIndex % (operations * 4)}`;
          await mutations.tasks.update(rowId, {
            title: `${prefix} task ${absoluteIndex}`,
            completed: absoluteIndex % 2,
            user_id: actorId,
            project_id: projectId,
          });
          await liveQuery.execute();
        }
      },
    });
    subscription.unsubscribe();
    assert(liveEvents > 1, 'expected live query refresh events');

    await client.applyLocalOperation(
      newTaskOperation(
        {
          id: 'feature-crdt-task',
          title: '',
          user_id: actorId,
          project_id: projectId,
        },
        null
      ),
      {
        id: 'feature-crdt-task',
        title: '',
        completed: 0,
        user_id: actorId,
        project_id: projectId,
        server_version: 0,
        image: null,
        title_yjs_state: null,
      }
    );
    const crdtTextUpdates = await measureClientRounds({
      label: 'Rust-owned CRDT text updates',
      operations,
      rounds,
      warmupOperations,
      client,
      run: async (prefix, startIndex, count) => {
        for (let index = 0; index < count; index += 1) {
          await client.applyCrdtFieldText({
            table: 'tasks',
            rowId: 'feature-crdt-task',
            field: 'title',
            nextText: `${prefix} CRDT ${startIndex + index}`,
          });
        }
        const materialized = await client.materializeCrdtField({
          table: 'tasks',
          rowId: 'feature-crdt-task',
          field: 'title',
        });
        assert(
          typeof materialized.value === 'string' &&
            materialized.value.includes('CRDT'),
          'CRDT materialization mismatch'
        );
      },
    });

    const blobMetadata = await measureClientRounds({
      label: 'Rust-owned blob metadata store',
      operations,
      rounds,
      warmupOperations,
      client,
      run: async (prefix, startIndex, count) => {
        for (let index = 0; index < count; index += 1) {
          const payload = new TextEncoder().encode(
            `${prefix}-blob-${startIndex + index}-${'x'.repeat(128)}`
          );
          const ref = await blobs.store(payload, {
            mimeType: 'text/plain',
          });
          assert(ref.hash.length > 0, 'blob ref missing hash');
        }
        const stats = await blobs.getUploadQueueStats();
        assert(stats.pending >= count, 'blob upload queue did not grow');
      },
    });

    const largeSnapshotRead = await measureClientRounds({
      label: 'Rust-owned large local snapshot read',
      operations,
      rounds,
      warmupOperations,
      client,
      run: async (_prefix, _startIndex, count) => {
        for (let index = 0; index < count; index += 1) {
          const rows = await db
            .selectFrom('tasks')
            .selectAll()
            .where('project_id', '=', projectId)
            .orderBy('id')
            .limit(operations * 4)
            .execute();
          assert(
            rows.length >= operations * 4,
            'large local snapshot returned too few rows'
          );
        }
      },
    });

    const multiTableCommit = await measureClientRounds({
      label: 'Rust-owned multi-table commit',
      operations,
      rounds,
      warmupOperations,
      client,
      run: async (prefix, startIndex, count) => {
        await client.applyLocalOperationsCommit(
          Array.from({ length: count }, (_, index) => {
            const absoluteIndex = startIndex + index;
            const taskId = `${prefix}-multi-task-${absoluteIndex}`;
            return [
              {
                operation: newProjectOperation(
                  {
                    id: `${prefix}-multi-project-${absoluteIndex}`,
                    name: `Project ${absoluteIndex}`,
                    owner_id: actorId,
                  },
                  null
                ),
              },
              {
                operation: newTaskOperation(
                  {
                    id: taskId,
                    title: `Multi task ${absoluteIndex}`,
                    completed: absoluteIndex % 2,
                    user_id: actorId,
                    project_id: projectId,
                  },
                  null
                ),
              },
              {
                operation: newCommentOperation(
                  {
                    id: `${prefix}-multi-comment-${absoluteIndex}`,
                    task_id: taskId,
                    project_id: projectId,
                    body: `Comment ${absoluteIndex}`,
                    author_id: actorId,
                  },
                  null
                ),
              },
            ];
          }).flat()
        );
      },
    });

    encryptedSyncular = await createSyncularAppDatabase({
      worker: () =>
        new Worker('/syncular-v2-worker.js', {
          type: 'module',
          credentials: 'same-origin',
        }),
      config: {
        baseUrl: '/sync',
        actorId,
        clientId: `feature-bench-encrypted-${Date.now()}`,
        projectId,
        fileName: `feature-bench-encrypted-${storage}-${Date.now()}.sqlite`,
        storage,
        clearOnInit: true,
        appSchema: encryptedTitleCrdtAppSchema(),
      },
    });
    const encryptedClient = encryptedSyncular.client;
    await encryptedClient.setFieldEncryption(
      syncularGeneratedFieldEncryptionConfig({
        rules: [
          {
            scope: 'tasks',
            table: 'tasks',
            fields: ['title'],
            rowIdField: 'id',
          },
        ],
        keys: { default: new Uint8Array(32).fill(17) },
        envelopePrefix: 'dgsync:e2ee:1:',
      })
    );
    await encryptedClient.setEncryptedCrdt({
      keys: { default: new Uint8Array(32).fill(19) },
    });
    await encryptedClient.applyLocalOperationsCommit([
      {
        operation: newProjectOperation(
          {
            id: projectId,
            name: 'Encrypted Feature Benchmark',
            owner_id: actorId,
          },
          null
        ),
      },
    ]);

    const encryptedFieldPush = await measureClientRounds({
      label: 'Rust-owned encrypted field push',
      operations,
      rounds,
      warmupOperations,
      client: encryptedClient,
      run: async (prefix, startIndex, count) => {
        await encryptedClient.applyLocalOperationsCommit(
          Array.from({ length: count }, (_, index) => {
            const absoluteIndex = startIndex + index;
            return {
              operation: newTaskOperation(
                {
                  id: `${prefix}-encrypted-task-${absoluteIndex}`,
                  title: `Secret task ${absoluteIndex}`,
                  completed: absoluteIndex % 2,
                  user_id: actorId,
                  project_id: projectId,
                },
                null
              ),
            };
          })
        );
        const pushed = await encryptedClient.syncPush();
        assert(
          pushed.pushedCommits > 0,
          'encrypted field benchmark did not push any commits'
        );
      },
    });

    await encryptedClient.applyLocalOperation(
      newTaskOperation(
        {
          id: 'feature-encrypted-crdt-task',
          title: '',
          user_id: actorId,
          project_id: projectId,
        },
        null
      ),
      {
        id: 'feature-encrypted-crdt-task',
        title: '',
        completed: 0,
        user_id: actorId,
        project_id: projectId,
        server_version: 0,
        image: null,
        title_yjs_state: null,
      }
    );
    const encryptedCrdtTextUpdates = await measureClientRounds({
      label: 'Rust-owned encrypted CRDT text updates',
      operations,
      rounds,
      warmupOperations,
      client: encryptedClient,
      run: async (prefix, startIndex, count) => {
        for (let index = 0; index < count; index += 1) {
          await encryptedClient.applyCrdtFieldText({
            table: 'tasks',
            rowId: 'feature-encrypted-crdt-task',
            field: 'title',
            nextText: `${prefix} encrypted CRDT ${startIndex + index}`,
          });
        }
        const materialized = await encryptedClient.materializeCrdtField({
          table: 'tasks',
          rowId: 'feature-encrypted-crdt-task',
          field: 'title',
        });
        assert(
          typeof materialized.value === 'string' &&
            materialized.value.includes('encrypted CRDT'),
          'encrypted CRDT materialization mismatch'
        );
      },
    });

    return {
      ok: true,
      operations,
      rounds,
      storage,
      readHeavyQuery,
      liveQueryRefresh,
      crdtTextUpdates,
      encryptedFieldPush,
      encryptedCrdtTextUpdates,
      blobMetadata,
      largeSnapshotRead,
      multiTableCommit,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Promise.all([syncular?.close(), encryptedSyncular?.close()]);
  }
}

function encryptedTitleCrdtAppSchema(): SyncularV2AppSchema {
  return {
    ...syncularGeneratedAppSchema,
    tables: syncularGeneratedAppSchema.tables.map((table) =>
      table.name === 'tasks'
        ? {
            ...table,
            crdtYjsFields: table.crdtYjsFields.map((field) =>
              field.field === 'title'
                ? { ...field, syncMode: 'encrypted-update-log' }
                : field
            ),
          }
        : table
    ),
  };
}

// --- Expose to Playwright ---

const runtime = {
  conformance: runConformance,
  bootstrap: runBootstrap,
  benchmarkE2eScoreboard: runE2eScoreboard,
  benchmarkFeatureWorkloads: runFeatureWorkloadBenchmark,
  benchmarkLocalMutations: runLocalMutationBenchmark,
  hostStore: runHostStore,
  pushPull: runPushPull,
  rustOwnedSqlite: runRustOwnedSqlite,
  rustOwnedSqliteSchemaMismatch: runRustOwnedSqliteSchemaMismatch,
  rustOwnedSqliteOpfsWorker: runRustOwnedSqliteOpfsWorker,
  rustOwnedStoreParity: runRustOwnedStoreParity,
  rustOwnedKyselyLive: runRustOwnedKyselyLive,
  rustOwnedSqliteClient: runRustOwnedSqliteClient,
};

Object.assign(window, { __runtime: runtime, __runtimeReady: true });
