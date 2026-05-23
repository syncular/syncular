import {
  type BinarySnapshotColumn,
  type BinarySnapshotColumnType,
  type BinarySnapshotRowsEncoder,
  bytesToReadableStream,
  captureSyncException,
  concatByteChunks,
  countSyncMetric,
  createSnapshotManifest,
  distributionSyncMetric,
  encodeBinarySnapshotTable,
  gzipBytes,
  randomId,
  type ScopeValues,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING,
  type SyncBootstrapState,
  type SyncChange,
  type SyncCommit,
  type SyncCrdtStateVectorHint,
  type SyncPullRequest,
  type SyncPullResponse,
  type SyncPullSubscriptionResponse,
  type SyncScopedSnapshotArtifactKind,
  type SyncSnapshot,
  type SyncSnapshotArtifactCompression,
  type SyncSnapshotArtifactsRequest,
  type SyncSnapshotChunkRef,
  sha256Hex,
  snapshotScopeDigestFromCacheKey,
  startSyncSpan,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import {
  createWireSubscriptionIntegrity,
  SYNCULAR_COMMIT_GENESIS_ROOT,
} from './commit-integrity';
import type {
  DbExecutor,
  IncrementalPullRow,
  ServerSyncDialect,
} from './dialect/types';
import {
  getServerBootstrapOrderFor,
  type ServerHandlerCollection,
} from './handlers/collection';
import type { ServerTableHandler, SyncServerAuth } from './handlers/types';
import { EXTERNAL_CLIENT_ID } from './notify';
import {
  type SyncServerPullPlugin,
  sortServerPullPlugins,
} from './plugins/types';
import type { SyncCoreDb } from './schema';
import {
  createScopedSnapshotArtifactScopeCacheKey,
  readBestScopedSnapshotArtifactRefForPageCapacity,
} from './snapshot-artifacts';
import {
  createSnapshotChunkScopeCacheKey,
  insertSnapshotChunk,
  readSnapshotChunkRefByPageKey,
  type SnapshotChunkRefWithContinuation,
} from './snapshot-chunks';
import type { SnapshotChunkStorage } from './snapshot-chunks/types';
import {
  createMemoryScopeCache,
  type ScopeCacheBackend,
} from './subscriptions/cache';
import { resolveEffectiveScopesForSubscriptions } from './subscriptions/resolve';

const defaultScopeCache = createMemoryScopeCache();
const DEFAULT_MAX_BINARY_SNAPSHOT_BUNDLE_ROWS = 50_000;
const DEFAULT_SNAPSHOT_CHUNK_GZIP_LEVEL = 1;
const MAX_PULL_TRANSACTION_RETRIES = 2;
const PULL_TRANSACTION_RETRY_DELAY_MS = 15;

interface PullBootstrapTimings {
  snapshotQueryMs: number;
  binaryEncodeMs: number;
  chunkCacheLookupMs: number;
  artifactCacheLookupMs: number;
  chunkGzipMs: number;
  chunkHashMs: number;
  chunkPersistMs: number;
}

interface SnapshotChunkEncodeResult {
  body: Uint8Array;
  sha256: string;
  gzipMs: number;
  hashMs: number;
}

function toResponseChunkRef(ref: SyncSnapshotChunkRef): SyncSnapshotChunkRef {
  return {
    id: ref.id,
    byteLength: ref.byteLength,
    sha256: ref.sha256,
    encoding: ref.encoding,
    compression: ref.compression,
  };
}

async function createChunkedSnapshotManifest(args: {
  table: string;
  asOfCommitSeq: number;
  scopeKey: string;
  rowCursor: string | null;
  rowLimit: number;
  nextRowCursor: string | null;
  isFirstPage: boolean;
  isLastPage: boolean;
  chunks: readonly SyncSnapshotChunkRef[];
}): Promise<SyncSnapshot['manifest']> {
  return createSnapshotManifest({
    version: 1,
    table: args.table,
    asOfCommitSeq: args.asOfCommitSeq,
    scopeDigest: snapshotScopeDigestFromCacheKey(args.scopeKey),
    rowCursor: args.rowCursor,
    rowLimit: args.rowLimit,
    nextRowCursor: args.nextRowCursor,
    isFirstPage: args.isFirstPage,
    isLastPage: args.isLastPage,
    chunks: args.chunks.map(toResponseChunkRef),
  });
}

interface SnapshotArtifactSelection {
  artifactKind: SyncScopedSnapshotArtifactKind;
  compression: SyncSnapshotArtifactCompression;
  schemaVersion: string;
  featureSet: readonly string[];
}

function normalizeFeatureSet(
  features: readonly string[] | undefined
): string[] {
  return Array.from(new Set(features ?? [])).sort();
}

function resolveSnapshotArtifactSelection(
  request: SyncSnapshotArtifactsRequest | undefined,
  clientSchemaVersion: number
): SnapshotArtifactSelection | null {
  if (!request) return null;
  if (
    !request.artifactKinds.includes(
      SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1
    )
  ) {
    return null;
  }
  if (!request.compressions?.includes(SYNC_SNAPSHOT_CHUNK_COMPRESSION)) {
    return null;
  }
  return {
    artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
    compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
    schemaVersion: String(clientSchemaVersion),
    featureSet: normalizeFeatureSet(request.featureSet),
  };
}

function resolveSnapshotBinaryColumns<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  handler: ServerTableHandler<DB, Auth>,
  schemaVersion: number
): readonly BinarySnapshotColumn[] | undefined {
  const versioned = handler.snapshotBinaryColumnsForVersion?.(schemaVersion);
  return versioned === undefined
    ? handler.snapshotBinaryColumns
    : (versioned ?? undefined);
}

function resolveSnapshotBinaryEncoder<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  handler: ServerTableHandler<DB, Auth>,
  schemaVersion: number
): BinarySnapshotRowsEncoder | undefined {
  const versioned = handler.snapshotBinaryEncoderForVersion?.(schemaVersion);
  return versioned === undefined
    ? handler.snapshotBinaryEncoder
    : (versioned ?? undefined);
}

function createPullBootstrapTimings(): PullBootstrapTimings {
  return {
    snapshotQueryMs: 0,
    binaryEncodeMs: 0,
    chunkCacheLookupMs: 0,
    artifactCacheLookupMs: 0,
    chunkGzipMs: 0,
    chunkHashMs: 0,
    chunkPersistMs: 0,
  };
}

function resolveBinarySnapshotBundleRowLimit(args: {
  limitSnapshotRows: number;
  pagesRemaining: number;
}): number {
  const pageSize = Math.max(1, args.limitSnapshotRows);
  const pagesRemaining = Math.max(1, args.pagesRemaining);
  const maxBundlePages = Math.max(
    1,
    Math.ceil(DEFAULT_MAX_BINARY_SNAPSHOT_BUNDLE_ROWS / pageSize)
  );
  return pageSize * Math.min(pagesRemaining, maxBundlePages);
}

async function gzipByteChunks(
  chunks: readonly Uint8Array[],
  gzipLevel: number
): Promise<Uint8Array> {
  return gzipBytes(concatByteChunks(chunks), {
    level: gzipLevel,
  });
}

async function encodeCompressedSnapshotChunk(
  chunks: readonly Uint8Array[],
  gzipLevel: number
): Promise<SnapshotChunkEncodeResult> {
  const gzipStartedAt = Date.now();
  const body = await gzipByteChunks(chunks, gzipLevel);
  const gzipMs = Math.max(0, Date.now() - gzipStartedAt);
  const hashStartedAt = Date.now();
  const sha256 = await sha256Hex(body);
  const hashMs = Math.max(0, Date.now() - hashStartedAt);
  return { body, sha256, gzipMs, hashMs };
}

async function encodeCompressedSnapshotChunkToStream(
  chunks: readonly Uint8Array[],
  gzipLevel: number
): Promise<{
  stream: ReadableStream<Uint8Array>;
  byteLength: number;
  sha256: string;
  gzipMs: number;
  hashMs: number;
}> {
  const encoded = await encodeCompressedSnapshotChunk(chunks, gzipLevel);
  return {
    stream: bytesToReadableStream(encoded.body),
    byteLength: encoded.body.length,
    sha256: encoded.sha256,
    gzipMs: encoded.gzipMs,
    hashMs: encoded.hashMs,
  };
}

interface SnapshotColumnInference {
  name: string;
  type: BinarySnapshotColumnType | null;
  nullable: boolean;
  presentCount: number;
}

function encodeBinarySnapshotRows(
  table: string,
  rows: readonly unknown[],
  columns?: readonly BinarySnapshotColumn[]
): Uint8Array {
  const recordRows = rows.map((row) => toSnapshotRecordRow(table, row));
  return encodeBinarySnapshotTable({
    table,
    columns: columns ?? inferBinarySnapshotColumns(recordRows),
    rows: recordRows,
  });
}

function toSnapshotRecordRow(
  table: string,
  row: unknown
): Record<string, unknown> {
  if (
    row == null ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row instanceof Uint8Array ||
    row instanceof ArrayBuffer
  ) {
    throw new Error(
      `Cannot encode binary snapshot for table ${table}: snapshot rows must be objects`
    );
  }
  return row as Record<string, unknown>;
}

function inferBinarySnapshotColumns(
  rows: readonly Record<string, unknown>[]
): BinarySnapshotColumn[] {
  const columns: SnapshotColumnInference[] = [];
  const columnsByName = new Map<string, SnapshotColumnInference>();

  for (const row of rows) {
    for (const name in row) {
      if (!Object.hasOwn(row, name)) continue;
      const value = row[name];
      let column = columnsByName.get(name);
      if (!column) {
        column = { name, type: null, nullable: false, presentCount: 0 };
        columnsByName.set(name, column);
        columns.push(column);
      }
      column.presentCount += 1;
      if (value == null) {
        column.nullable = true;
        continue;
      }
      column.type = mergeBinarySnapshotColumnTypes(
        column.type,
        inferBinarySnapshotColumnType(value)
      );
    }
  }

  return columns.map((column) => ({
    name: column.name,
    type: column.type ?? 'json',
    ...(column.nullable || column.presentCount < rows.length
      ? { nullable: true }
      : {}),
  }));
}

function inferBinarySnapshotColumnType(
  value: unknown
): BinarySnapshotColumnType {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'integer';
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? 'integer' : 'float';
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return 'bytes';
  }
  return 'json';
}

function mergeBinarySnapshotColumnTypes(
  current: BinarySnapshotColumnType | null,
  next: BinarySnapshotColumnType
): BinarySnapshotColumnType {
  if (!current || current === next) return next;
  if (
    (current === 'integer' && next === 'float') ||
    (current === 'float' && next === 'integer')
  ) {
    return 'float';
  }
  return 'json';
}

export interface PullResult {
  response: SyncPullResponse;
  /**
   * Effective scopes for all active subscriptions (for cursor tracking).
   * Maps subscription ID to effective scopes.
   */
  effectiveScopes: ScopeValues;
  /** Minimum nextCursor across active subscriptions (for pruning cursor tracking). */
  clientCursor: number;
  /** Internal bootstrap timing breakdown used for benchmark-gated diagnostics. */
  bootstrapTimings?: PullBootstrapTimings;
}

interface PendingExternalChunkWrite {
  snapshot: SyncSnapshot;
  cacheLookup: {
    partitionId: string;
    scopeKey: string;
    scope: string;
    asOfCommitSeq: number;
    rowCursor: string | null;
    rowLimit: number;
    nextRowCursor: string | null;
    isLastPage: boolean;
  };
  payloadParts: Uint8Array[];
  expiresAt: string;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

/**
 * Sanitize a numeric limit parameter with bounds checking.
 * Handles NaN, negative values, and undefined.
 */
function sanitizeLimit(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return defaultValue;
  if (Number.isNaN(value)) return defaultValue;
  return Math.max(min, Math.min(max, value));
}

function sanitizeGzipLevel(value: number | undefined): number {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return DEFAULT_SNAPSHOT_CHUNK_GZIP_LEVEL;
  }
  return Math.max(0, Math.min(9, Math.trunc(value)));
}

function isSerializablePullError(error: Error): boolean {
  const withCode = error as Error & { code?: string };
  return (
    withCode.code === '40001' ||
    error.message.toLowerCase().includes('could not serialize access')
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Merge all scope values into a flat ScopeValues for cursor tracking.
 */
function mergeScopes(subscriptions: { scopes: ScopeValues }[]): ScopeValues {
  const result: Record<string, Set<string>> = {};

  for (const sub of subscriptions) {
    for (const [key, value] of Object.entries(sub.scopes)) {
      if (!result[key]) result[key] = new Set();
      const arr = Array.isArray(value) ? value : [value];
      for (const v of arr) result[key].add(v);
    }
  }

  const merged: ScopeValues = {};
  for (const [key, set] of Object.entries(result)) {
    const arr = Array.from(set);
    if (arr.length === 0) continue;
    merged[key] = arr.length === 1 ? arr[0]! : arr;
  }
  return merged;
}

interface PullResponseStats {
  subscriptionCount: number;
  activeSubscriptionCount: number;
  revokedSubscriptionCount: number;
  bootstrapSubscriptionCount: number;
  commitCount: number;
  changeCount: number;
  snapshotPageCount: number;
}

function assertPullChangeIdentityUnchanged(
  pluginName: string,
  before: SyncChange,
  after: SyncChange
): void {
  if (before.table !== after.table) {
    throw new Error(
      `Server pull plugin "${pluginName}" cannot change change.table (${before.table} -> ${after.table})`
    );
  }
  if (before.row_id !== after.row_id) {
    throw new Error(
      `Server pull plugin "${pluginName}" cannot change change.row_id (${before.row_id} -> ${after.row_id})`
    );
  }
  if (before.op !== after.op) {
    throw new Error(
      `Server pull plugin "${pluginName}" cannot change change.op (${before.op} -> ${after.op})`
    );
  }
}

async function transformPullChanges<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  plugins: readonly SyncServerPullPlugin<DB, Auth>[];
  ctx: { db: DbExecutor<DB>; actorId: string; auth: Auth };
  tableHandler: ServerTableHandler<DB, Auth>;
  subscription: {
    id: string;
    table: string;
    scopes: ScopeValues;
    params: Record<string, unknown> | undefined;
    cursor: number;
    crdtStateVectors: readonly SyncCrdtStateVectorHint[];
  };
  changes: readonly SyncChange[];
}): Promise<SyncChange[]> {
  let changes = [...args.changes];
  for (const plugin of args.plugins) {
    if (!plugin.transformPullChanges) continue;
    const nextChanges = await plugin.transformPullChanges({
      ctx: args.ctx,
      tableHandler: args.tableHandler,
      subscription: args.subscription,
      changes,
    });
    if (nextChanges.length !== changes.length) {
      throw new Error(
        `Server pull plugin "${plugin.name}" cannot change pull change count (${changes.length} -> ${nextChanges.length})`
      );
    }
    for (let i = 0; i < changes.length; i += 1) {
      assertPullChangeIdentityUnchanged(
        plugin.name,
        changes[i]!,
        nextChanges[i]!
      );
    }
    changes = [...nextChanges];
  }
  return changes;
}

function summarizePullResponse(response: SyncPullResponse): PullResponseStats {
  const subscriptions = response.subscriptions ?? [];
  let activeSubscriptionCount = 0;
  let revokedSubscriptionCount = 0;
  let bootstrapSubscriptionCount = 0;
  let commitCount = 0;
  let changeCount = 0;
  let snapshotPageCount = 0;

  for (const sub of subscriptions) {
    if (sub.status === 'revoked') {
      revokedSubscriptionCount += 1;
    } else {
      activeSubscriptionCount += 1;
    }

    if (sub.bootstrap) {
      bootstrapSubscriptionCount += 1;
    }

    const commits = sub.commits ?? [];
    commitCount += commits.length;
    for (const commit of commits) {
      changeCount += commit.changes?.length ?? 0;
    }

    snapshotPageCount += sub.snapshots?.length ?? 0;
  }

  return {
    subscriptionCount: subscriptions.length,
    activeSubscriptionCount,
    revokedSubscriptionCount,
    bootstrapSubscriptionCount,
    commitCount,
    changeCount,
    snapshotPageCount,
  };
}

function recordPullMetrics(args: {
  status: string;
  dedupeRows: boolean;
  durationMs: number;
  stats: PullResponseStats;
}): void {
  const { status, dedupeRows, durationMs, stats } = args;
  const attributes = {
    status,
    dedupe_rows: dedupeRows,
  };

  countSyncMetric('sync.server.pull.requests', 1, { attributes });
  distributionSyncMetric('sync.server.pull.duration_ms', durationMs, {
    unit: 'millisecond',
    attributes,
  });
  distributionSyncMetric(
    'sync.server.pull.subscriptions',
    stats.subscriptionCount,
    { attributes }
  );
  distributionSyncMetric(
    'sync.server.pull.active_subscriptions',
    stats.activeSubscriptionCount,
    { attributes }
  );
  distributionSyncMetric(
    'sync.server.pull.revoked_subscriptions',
    stats.revokedSubscriptionCount,
    { attributes }
  );
  distributionSyncMetric(
    'sync.server.pull.bootstrap_subscriptions',
    stats.bootstrapSubscriptionCount,
    { attributes }
  );
  distributionSyncMetric('sync.server.pull.commits', stats.commitCount, {
    attributes,
  });
  distributionSyncMetric('sync.server.pull.changes', stats.changeCount, {
    attributes,
  });
  distributionSyncMetric(
    'sync.server.pull.snapshot_pages',
    stats.snapshotPageCount,
    { attributes }
  );
}

async function readLatestExternalCommitByTable<DB extends SyncCoreDb>(
  trx: DbExecutor<DB>,
  args: { partitionId: string; afterCursor: number; tables: string[] }
): Promise<Map<string, number>> {
  const tableNames = Array.from(
    new Set(args.tables.filter((table) => typeof table === 'string'))
  );
  const latestByTable = new Map<string, number>();
  if (tableNames.length === 0) {
    return latestByTable;
  }

  type SyncExecutor = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const executor = trx as SyncExecutor;
  const rows = await executor
    .selectFrom('sync_table_commits as tc')
    .innerJoin('sync_commits as cm', (join) =>
      join
        .onRef('cm.commit_seq', '=', 'tc.commit_seq')
        .onRef('cm.partition_id', '=', 'tc.partition_id')
    )
    .select(['tc.table as table'])
    .select((eb) => eb.fn.max('tc.commit_seq').as('latest_commit_seq'))
    .where('tc.partition_id', '=', args.partitionId)
    .where('cm.client_id', '=', EXTERNAL_CLIENT_ID)
    .where('cm.change_count', '=', 0)
    .where('tc.commit_seq', '>', args.afterCursor)
    .where('tc.table', 'in', tableNames)
    .groupBy('tc.table')
    .execute();

  for (const row of rows) {
    const commitSeq = Number(row.latest_commit_seq ?? -1);
    if (!Number.isFinite(commitSeq) || commitSeq < 0) continue;
    latestByTable.set(row.table, commitSeq);
  }

  return latestByTable;
}

export async function pull<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<DB, Auth>;
  auth: Auth;
  request: SyncPullRequest;
  /**
   * Optional snapshot chunk storage adapter.
   * When provided, stores chunk bodies in external storage (S3, etc.)
   * instead of inline in the database.
   */
  chunkStorage?: SnapshotChunkStorage;
  /**
   * Optional shared scope cache backend.
   * Request-local memoization is always applied, even with custom backends.
   * Defaults to process-local memory cache.
   */
  scopeCache?: ScopeCacheBackend;
  /**
   * Gzip compression level for generated snapshot chunks. The protocol remains
   * gzip-only; this tunes CPU/size tradeoffs for deployments that know their
   * network constraints.
   *
   * Default: 1, range: 0-9.
   */
  snapshotChunkGzipLevel?: number;
  /**
   * Schema/cache semantic version included in generated snapshot chunk cache
   * keys. Changing this value invalidates cached bootstrap chunks without
   * requiring table data to change.
   */
  snapshotChunkCacheSchemaVersion?: number | string | null;
  /**
   * Optional server plugins for protocol-level pull transforms.
   */
  plugins?: readonly SyncServerPullPlugin<DB, Auth>[];
}): Promise<PullResult> {
  const { request, dialect } = args;
  const db = args.db;
  const pullPlugins = sortServerPullPlugins(args.plugins);
  const partitionId = args.auth.partitionId ?? 'default';
  const snapshotChunkGzipLevel = sanitizeGzipLevel(args.snapshotChunkGzipLevel);
  const clientSchemaVersion = request.schemaVersion;
  if (!Number.isInteger(clientSchemaVersion) || clientSchemaVersion < 1) {
    throw new Error('Pull request schemaVersion must be a positive integer');
  }
  const snapshotChunkCacheSchemaVersion =
    args.snapshotChunkCacheSchemaVersion === null ||
    args.snapshotChunkCacheSchemaVersion === undefined
      ? clientSchemaVersion
      : `${clientSchemaVersion}:${args.snapshotChunkCacheSchemaVersion}`;
  const requestedSubscriptionCount = Array.isArray(request.subscriptions)
    ? request.subscriptions.length
    : 0;
  const startedAtMs = Date.now();

  return startSyncSpan(
    {
      name: 'sync.server.pull',
      op: 'sync.pull',
      attributes: {
        requested_subscription_count: requestedSubscriptionCount,
        dedupe_rows: request.dedupeRows === true,
      },
    },
    async (span) => {
      try {
        // Validate and sanitize request limits
        const limitCommits = sanitizeLimit(request.limitCommits, 1000, 1, 1000);
        const limitSnapshotRows = sanitizeLimit(
          request.limitSnapshotRows,
          1000,
          1,
          50000
        );
        const maxSnapshotPages = sanitizeLimit(
          request.maxSnapshotPages,
          4,
          1,
          50
        );
        const dedupeRows = request.dedupeRows === true;
        const snapshotChunkEncoding = SYNC_SNAPSHOT_CHUNK_ENCODING;
        const snapshotArtifactSelection = resolveSnapshotArtifactSelection(
          request.snapshotArtifacts,
          clientSchemaVersion
        );
        const snapshotArtifactSchemaVersion =
          snapshotArtifactSelection?.schemaVersion ?? null;
        // Resolve effective scopes for each subscription
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db,
          auth: args.auth,
          subscriptions: request.subscriptions ?? [],
          handlers: args.handlers,
          scopeCache: args.scopeCache ?? defaultScopeCache,
        });

        for (
          let attemptIndex = 0;
          attemptIndex < MAX_PULL_TRANSACTION_RETRIES;
          attemptIndex += 1
        ) {
          const pendingExternalChunkWrites: PendingExternalChunkWrite[] = [];
          const bootstrapTimings = createPullBootstrapTimings();

          try {
            const result = await dialect.executeInTransaction(
              db,
              async (trx) => {
                await dialect.setRepeatableRead(trx);

                const maxCommitSeq = await dialect.readMaxCommitSeq(trx, {
                  partitionId,
                });
                const minCommitSeq = await dialect.readMinCommitSeq(trx, {
                  partitionId,
                });

                const subResponses: SyncPullSubscriptionResponse[] = [];
                const activeSubscriptions: { scopes: ScopeValues }[] = [];
                const nextCursors: number[] = [];

                // Detect external data changes (synthetic commits from notifyExternalDataChange)
                // Compute minimum cursor across all active subscriptions to scope the query.
                let minSubCursor = Number.MAX_SAFE_INTEGER;
                const activeTables = new Set<string>();
                for (const sub of resolved) {
                  if (
                    sub.status === 'revoked' ||
                    Object.keys(sub.scopes).length === 0
                  )
                    continue;
                  activeTables.add(sub.table);
                  const cursor = Math.max(-1, sub.cursor ?? -1);
                  if (cursor >= 0 && cursor < minSubCursor) {
                    minSubCursor = cursor;
                  }
                }

                const maxExternalCommitByTable =
                  minSubCursor < Number.MAX_SAFE_INTEGER && minSubCursor >= 0
                    ? await readLatestExternalCommitByTable(trx, {
                        partitionId,
                        afterCursor: minSubCursor,
                        tables: Array.from(activeTables),
                      })
                    : new Map<string, number>();

                for (const sub of resolved) {
                  const cursor = Math.max(-1, sub.cursor ?? -1);
                  // Validate table handler exists (throws if not registered)
                  if (!args.handlers.byTable.has(sub.table)) {
                    throw new Error(`Unknown table: ${sub.table}`);
                  }

                  if (
                    sub.status === 'revoked' ||
                    Object.keys(sub.scopes).length === 0
                  ) {
                    subResponses.push({
                      id: sub.id,
                      status: 'revoked',
                      scopes: {},
                      bootstrap: false,
                      nextCursor: cursor,
                      commits: [],
                    });
                    continue;
                  }

                  const effectiveScopes = sub.scopes;
                  activeSubscriptions.push({ scopes: effectiveScopes });
                  const latestExternalCommitForTable =
                    maxExternalCommitByTable.get(sub.table);

                  const needsBootstrap =
                    sub.bootstrapState != null ||
                    cursor < 0 ||
                    cursor > maxCommitSeq ||
                    (minCommitSeq > 0 && cursor < minCommitSeq - 1) ||
                    (latestExternalCommitForTable !== undefined &&
                      latestExternalCommitForTable > cursor);

                  if (needsBootstrap) {
                    const tables = getServerBootstrapOrderFor(
                      args.handlers,
                      sub.table
                    ).map((handler) => handler.table);
                    const initState: SyncBootstrapState = {
                      asOfCommitSeq: maxCommitSeq,
                      tables,
                      tableIndex: 0,
                      rowCursor: null,
                    };

                    const requestedState = sub.bootstrapState ?? null;
                    const state =
                      requestedState &&
                      typeof requestedState.asOfCommitSeq === 'number' &&
                      Array.isArray(requestedState.tables) &&
                      typeof requestedState.tableIndex === 'number'
                        ? (requestedState as SyncBootstrapState)
                        : initState;

                    // If the bootstrap state's asOfCommitSeq is no longer catch-up-able, restart bootstrap.
                    const effectiveState =
                      state.asOfCommitSeq < minCommitSeq - 1
                        ? initState
                        : state;

                    const tableName =
                      effectiveState.tables[effectiveState.tableIndex];

                    // No tables (or ran past the end): treat bootstrap as complete.
                    if (!tableName) {
                      subResponses.push({
                        id: sub.id,
                        status: 'active',
                        scopes: effectiveScopes,
                        bootstrap: true,
                        bootstrapState: null,
                        nextCursor: effectiveState.asOfCommitSeq,
                        commits: [],
                        snapshots: [],
                      });
                      nextCursors.push(effectiveState.asOfCommitSeq);
                      continue;
                    }

                    const snapshots: SyncSnapshot[] = [];
                    let nextState: SyncBootstrapState | null = effectiveState;
                    const cacheKey = await createSnapshotChunkScopeCacheKey({
                      partitionId,
                      scopes: effectiveScopes,
                      schemaVersion: snapshotChunkCacheSchemaVersion,
                      encoding: snapshotChunkEncoding,
                      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                      gzipLevel: snapshotChunkGzipLevel,
                    });
                    const artifactScopeKey =
                      snapshotArtifactSelection && snapshotArtifactSchemaVersion
                        ? await createScopedSnapshotArtifactScopeCacheKey({
                            partitionId,
                            subscriptionId: sub.id,
                            scopes: effectiveScopes,
                            schemaVersion: snapshotArtifactSchemaVersion,
                            artifactKind:
                              snapshotArtifactSelection.artifactKind,
                            compression: snapshotArtifactSelection.compression,
                            features: snapshotArtifactSelection.featureSet,
                          })
                        : null;

                    interface SnapshotBundle {
                      table: string;
                      tableIndex: number;
                      startCursor: string | null;
                      nextRowCursor: string | null;
                      isFirstPage: boolean;
                      isLastPage: boolean;
                      pageCount: number;
                      cacheRowLimit: number | null;
                      ttlMs: number;
                      binaryColumns?: readonly BinarySnapshotColumn[];
                      binaryEncoder?: BinarySnapshotRowsEncoder;
                      binaryRows: unknown[];
                    }

                    const createSnapshotBundle = (
                      table: string,
                      tableIndex: number,
                      rowCursor: string | null,
                      ttlMs: number,
                      binaryColumns?: readonly BinarySnapshotColumn[],
                      binaryEncoder?: BinarySnapshotRowsEncoder
                    ): SnapshotBundle => {
                      return {
                        table,
                        tableIndex,
                        startCursor: rowCursor,
                        nextRowCursor: null,
                        isFirstPage: rowCursor == null,
                        isLastPage: false,
                        pageCount: 0,
                        cacheRowLimit: null,
                        ttlMs,
                        binaryColumns,
                        binaryEncoder,
                        binaryRows: [],
                      };
                    };

                    const snapshotBootstrapStateAfter = (args: {
                      tableIndex: number;
                      nextRowCursor: string | null;
                      isLastPage: boolean;
                    }): SyncBootstrapState | null => {
                      if (!args.isLastPage) {
                        return {
                          ...effectiveState,
                          tableIndex: args.tableIndex,
                          rowCursor: args.nextRowCursor,
                        };
                      }
                      if (args.tableIndex + 1 < effectiveState.tables.length) {
                        return {
                          ...effectiveState,
                          tableIndex: args.tableIndex + 1,
                          rowCursor: null,
                        };
                      }
                      return null;
                    };

                    const encodeSnapshotBundlePayload = (
                      bundle: SnapshotBundle
                    ): Uint8Array[] => {
                      const encodeStartedAt = Date.now();
                      const payload = bundle.binaryEncoder
                        ? bundle.binaryEncoder(bundle.binaryRows)
                        : encodeBinarySnapshotRows(
                            bundle.table,
                            bundle.binaryRows,
                            bundle.binaryColumns
                          );
                      bootstrapTimings.binaryEncodeMs += Math.max(
                        0,
                        Date.now() - encodeStartedAt
                      );
                      return [payload];
                    };

                    const flushSnapshotBundle = async (
                      bundle: SnapshotBundle
                    ): Promise<void> => {
                      const nowIso = new Date().toISOString();
                      const bundleRowLimit = Math.max(
                        1,
                        bundle.cacheRowLimit ??
                          limitSnapshotRows * bundle.pageCount
                      );

                      const cacheLookupStartedAt = Date.now();
                      const cached = await readSnapshotChunkRefByPageKey(trx, {
                        partitionId,
                        scopeKey: cacheKey,
                        scope: bundle.table,
                        asOfCommitSeq: effectiveState.asOfCommitSeq,
                        rowCursor: bundle.startCursor,
                        rowLimit: bundleRowLimit,
                        encoding: snapshotChunkEncoding,
                        compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                        nowIso,
                      });
                      bootstrapTimings.chunkCacheLookupMs += Math.max(
                        0,
                        Date.now() - cacheLookupStartedAt
                      );

                      let chunkRef: SyncSnapshotChunkRef | null = cached;
                      if (!chunkRef) {
                        const expiresAt = new Date(
                          Date.now() + Math.max(1000, bundle.ttlMs)
                        ).toISOString();

                        if (args.chunkStorage) {
                          const snapshot: SyncSnapshot = {
                            table: bundle.table,
                            rows: [],
                            chunks: [],
                            isFirstPage: bundle.isFirstPage,
                            isLastPage: bundle.isLastPage,
                            bootstrapStateAfter: snapshotBootstrapStateAfter({
                              tableIndex: bundle.tableIndex,
                              nextRowCursor: bundle.nextRowCursor,
                              isLastPage: bundle.isLastPage,
                            }),
                          };
                          snapshots.push(snapshot);
                          pendingExternalChunkWrites.push({
                            snapshot,
                            cacheLookup: {
                              partitionId,
                              scopeKey: cacheKey,
                              scope: bundle.table,
                              asOfCommitSeq: effectiveState.asOfCommitSeq,
                              rowCursor: bundle.startCursor,
                              rowLimit: bundleRowLimit,
                              nextRowCursor: bundle.nextRowCursor,
                              isLastPage: bundle.isLastPage,
                            },
                            payloadParts: encodeSnapshotBundlePayload(bundle),
                            expiresAt,
                          });
                          return;
                        }
                        const encodedChunk =
                          await encodeCompressedSnapshotChunk(
                            encodeSnapshotBundlePayload(bundle),
                            snapshotChunkGzipLevel
                          );
                        bootstrapTimings.chunkGzipMs += encodedChunk.gzipMs;
                        bootstrapTimings.chunkHashMs += encodedChunk.hashMs;
                        const chunkId = randomId();
                        const chunkPersistStartedAt = Date.now();
                        chunkRef = await insertSnapshotChunk(trx, {
                          chunkId,
                          partitionId,
                          scopeKey: cacheKey,
                          scope: bundle.table,
                          asOfCommitSeq: effectiveState.asOfCommitSeq,
                          rowCursor: bundle.startCursor,
                          rowLimit: bundleRowLimit,
                          nextRowCursor: bundle.nextRowCursor,
                          isLastPage: bundle.isLastPage,
                          encoding: snapshotChunkEncoding,
                          compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                          sha256: encodedChunk.sha256,
                          body: encodedChunk.body,
                          expiresAt,
                        });
                        bootstrapTimings.chunkPersistMs += Math.max(
                          0,
                          Date.now() - chunkPersistStartedAt
                        );
                      }

                      const chunk = toResponseChunkRef(chunkRef);
                      snapshots.push({
                        table: bundle.table,
                        rows: [],
                        chunks: [chunk],
                        manifest: await createChunkedSnapshotManifest({
                          table: bundle.table,
                          asOfCommitSeq: effectiveState.asOfCommitSeq,
                          scopeKey: cacheKey,
                          rowCursor: bundle.startCursor,
                          rowLimit: bundleRowLimit,
                          nextRowCursor: bundle.nextRowCursor,
                          isFirstPage: bundle.isFirstPage,
                          isLastPage: bundle.isLastPage,
                          chunks: [chunk],
                        }),
                        isFirstPage: bundle.isFirstPage,
                        isLastPage: bundle.isLastPage,
                        bootstrapStateAfter: snapshotBootstrapStateAfter({
                          tableIndex: bundle.tableIndex,
                          nextRowCursor: bundle.nextRowCursor,
                          isLastPage: bundle.isLastPage,
                        }),
                      });
                    };

                    let activeBundle: SnapshotBundle | null = null;

                    for (
                      let pageIndex = 0;
                      pageIndex < maxSnapshotPages;
                      pageIndex++
                    ) {
                      if (!nextState) break;

                      const nextTableName: string | undefined =
                        nextState.tables[nextState.tableIndex];
                      if (!nextTableName) {
                        if (activeBundle) {
                          activeBundle.isLastPage = true;
                          await flushSnapshotBundle(activeBundle);
                          activeBundle = null;
                        }
                        nextState = null;
                        break;
                      }

                      const tableHandler =
                        args.handlers.byTable.get(nextTableName);
                      if (!tableHandler) {
                        throw new Error(`Unknown table: ${nextTableName}`);
                      }
                      if (
                        !activeBundle ||
                        activeBundle.table !== nextTableName
                      ) {
                        if (activeBundle) {
                          await flushSnapshotBundle(activeBundle);
                        }
                        activeBundle = createSnapshotBundle(
                          nextTableName,
                          nextState.tableIndex,
                          nextState.rowCursor,
                          tableHandler.snapshotChunkTtlMs ??
                            24 * 60 * 60 * 1000,
                          resolveSnapshotBinaryColumns(
                            tableHandler,
                            clientSchemaVersion
                          ),
                          resolveSnapshotBinaryEncoder(
                            tableHandler,
                            clientSchemaVersion
                          )
                        );
                      }

                      if (artifactScopeKey && activeBundle.pageCount === 0) {
                        const pagesRemaining = Math.max(
                          1,
                          maxSnapshotPages - pageIndex
                        );
                        const artifactRowLimit =
                          resolveBinarySnapshotBundleRowLimit({
                            limitSnapshotRows,
                            pagesRemaining,
                          });
                        const artifactLookupStartedAt = Date.now();
                        const artifact =
                          await readBestScopedSnapshotArtifactRefForPageCapacity(
                            trx,
                            {
                              partitionId,
                              scopeKey: artifactScopeKey,
                              subscriptionId: sub.id,
                              table: nextTableName,
                              asOfCommitSeq: effectiveState.asOfCommitSeq,
                              rowCursor: nextState.rowCursor,
                              maxRowLimit: artifactRowLimit,
                              artifactKind:
                                snapshotArtifactSelection!.artifactKind,
                              schemaVersion: snapshotArtifactSchemaVersion!,
                              compression:
                                snapshotArtifactSelection!.compression,
                            }
                          );
                        bootstrapTimings.artifactCacheLookupMs += Math.max(
                          0,
                          Date.now() - artifactLookupStartedAt
                        );

                        if (
                          artifact &&
                          (artifact.isLastPage ||
                            artifact.nextRowCursor !== null)
                        ) {
                          snapshots.push({
                            table: nextTableName,
                            rows: [],
                            artifacts: [artifact],
                            isFirstPage: artifact.isFirstPage,
                            isLastPage: artifact.isLastPage,
                            bootstrapStateAfter: snapshotBootstrapStateAfter({
                              tableIndex: nextState.tableIndex,
                              nextRowCursor: artifact.nextRowCursor,
                              isLastPage: artifact.isLastPage,
                            }),
                          });
                          activeBundle = null;
                          const selectedArtifactRowLimit =
                            artifact.manifest.rowLimit;
                          pageIndex +=
                            Math.max(
                              1,
                              Math.ceil(
                                selectedArtifactRowLimit / limitSnapshotRows
                              )
                            ) - 1;

                          nextState = snapshotBootstrapStateAfter({
                            tableIndex: nextState.tableIndex,
                            nextRowCursor: artifact.nextRowCursor,
                            isLastPage: artifact.isLastPage,
                          });
                          continue;
                        }
                      }

                      if (activeBundle.pageCount === 0) {
                        const pagesRemaining = Math.max(
                          1,
                          maxSnapshotPages - pageIndex
                        );
                        const cachedRowLimit =
                          resolveBinarySnapshotBundleRowLimit({
                            limitSnapshotRows,
                            pagesRemaining,
                          });
                        activeBundle.cacheRowLimit = cachedRowLimit;
                        const cacheLookupStartedAt = Date.now();
                        const cached: SnapshotChunkRefWithContinuation | null =
                          await readSnapshotChunkRefByPageKey(trx, {
                            partitionId,
                            scopeKey: cacheKey,
                            scope: nextTableName,
                            asOfCommitSeq: effectiveState.asOfCommitSeq,
                            rowCursor: nextState.rowCursor,
                            rowLimit: cachedRowLimit,
                            encoding: snapshotChunkEncoding,
                            compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                          });
                        bootstrapTimings.chunkCacheLookupMs += Math.max(
                          0,
                          Date.now() - cacheLookupStartedAt
                        );

                        if (
                          cached &&
                          (cached.isLastPage || cached.nextRowCursor !== null)
                        ) {
                          const chunk = toResponseChunkRef(cached);
                          snapshots.push({
                            table: nextTableName,
                            rows: [],
                            chunks: [chunk],
                            manifest: await createChunkedSnapshotManifest({
                              table: nextTableName,
                              asOfCommitSeq: effectiveState.asOfCommitSeq,
                              scopeKey: cacheKey,
                              rowCursor: nextState.rowCursor,
                              rowLimit: cachedRowLimit,
                              nextRowCursor: cached.nextRowCursor,
                              isFirstPage: nextState.rowCursor == null,
                              isLastPage: cached.isLastPage,
                              chunks: [chunk],
                            }),
                            isFirstPage: nextState.rowCursor == null,
                            isLastPage: cached.isLastPage,
                            bootstrapStateAfter: snapshotBootstrapStateAfter({
                              tableIndex: nextState.tableIndex,
                              nextRowCursor: cached.nextRowCursor,
                              isLastPage: cached.isLastPage,
                            }),
                          });
                          activeBundle = null;
                          pageIndex +=
                            Math.max(
                              1,
                              Math.ceil(cachedRowLimit / limitSnapshotRows)
                            ) - 1;

                          nextState = snapshotBootstrapStateAfter({
                            tableIndex: nextState.tableIndex,
                            nextRowCursor: cached.nextRowCursor,
                            isLastPage: cached.isLastPage,
                          });
                          continue;
                        }
                      }

                      const snapshotQueryStartedAt = Date.now();
                      const page: {
                        rows: unknown[];
                        nextCursor: string | null;
                      } = await tableHandler.snapshot(
                        {
                          db: trx,
                          actorId: args.auth.actorId,
                          auth: args.auth,
                          scopeValues: effectiveScopes,
                          cursor: nextState.rowCursor,
                          limit: limitSnapshotRows,
                          schemaVersion: clientSchemaVersion,
                        },
                        sub.params
                      );
                      bootstrapTimings.snapshotQueryMs += Math.max(
                        0,
                        Date.now() - snapshotQueryStartedAt
                      );

                      const pageRows = page.rows ?? [];
                      activeBundle.nextRowCursor = page.nextCursor;
                      activeBundle.binaryRows.push(...pageRows);
                      activeBundle.pageCount += 1;

                      if (page.nextCursor != null) {
                        const shouldFlushBinaryBundle =
                          activeBundle.binaryRows.length >=
                          DEFAULT_MAX_BINARY_SNAPSHOT_BUNDLE_ROWS;
                        if (shouldFlushBinaryBundle) {
                          await flushSnapshotBundle(activeBundle);
                          activeBundle = null;
                        }
                        nextState = {
                          ...nextState,
                          rowCursor: page.nextCursor,
                        };
                        continue;
                      }

                      activeBundle.isLastPage = true;
                      await flushSnapshotBundle(activeBundle);
                      activeBundle = null;

                      if (nextState.tableIndex + 1 < nextState.tables.length) {
                        nextState = {
                          ...nextState,
                          tableIndex: nextState.tableIndex + 1,
                          rowCursor: null,
                        };
                        continue;
                      }

                      nextState = null;
                      break;
                    }

                    if (activeBundle) {
                      await flushSnapshotBundle(activeBundle);
                    }

                    subResponses.push({
                      id: sub.id,
                      status: 'active',
                      scopes: effectiveScopes,
                      bootstrap: true,
                      bootstrapState: nextState,
                      nextCursor: effectiveState.asOfCommitSeq,
                      commits: [],
                      snapshots,
                    });
                    nextCursors.push(effectiveState.asOfCommitSeq);
                    continue;
                  }

                  // Incremental pull for this subscription. The dialect row query
                  // carries the scanned commit-window max when matching rows exist,
                  // so we only need a separate commit-window scan when the row query
                  // returns no matches at all.
                  const incrementalRows: IncrementalPullRow[] = [];
                  let maxScannedCommitSeq = cursor;

                  for await (const row of dialect.iterateIncrementalPullRows(
                    trx,
                    {
                      partitionId,
                      table: sub.table,
                      scopes: effectiveScopes,
                      cursor,
                      limitCommits,
                    }
                  )) {
                    incrementalRows.push(row);
                    maxScannedCommitSeq = Math.max(
                      maxScannedCommitSeq,
                      row.scanned_max_commit_seq ?? row.commit_seq
                    );
                  }

                  if (incrementalRows.length === 0) {
                    const scannedCommitSeqs =
                      await dialect.readCommitSeqsForPull(trx, {
                        partitionId,
                        cursor,
                        limitCommits,
                        tables: [sub.table],
                      });
                    maxScannedCommitSeq =
                      scannedCommitSeqs.length > 0
                        ? scannedCommitSeqs[scannedCommitSeqs.length - 1]!
                        : cursor;

                    if (scannedCommitSeqs.length === 0) {
                      subResponses.push({
                        id: sub.id,
                        status: 'active',
                        scopes: effectiveScopes,
                        bootstrap: false,
                        nextCursor: cursor,
                        commits: [],
                      });
                      nextCursors.push(cursor);
                      continue;
                    }
                  }

                  const incrementalItems = incrementalRows.map((r) => ({
                    commitSeq: r.commit_seq,
                    createdAt: r.created_at,
                    actorId: r.actor_id,
                    change: {
                      table: r.table,
                      row_id: r.row_id,
                      op: r.op,
                      row_json: r.row_json,
                      row_version: r.row_version,
                      scopes: r.scopes,
                    } satisfies SyncChange,
                  }));

                  if (pullPlugins.length > 0 && incrementalItems.length > 0) {
                    const tableHandler = args.handlers.byTable.get(sub.table);
                    if (!tableHandler) {
                      throw new Error(`Unknown table: ${sub.table}`);
                    }
                    const transformedChanges = await transformPullChanges({
                      plugins: pullPlugins,
                      ctx: {
                        db: trx,
                        actorId: args.auth.actorId,
                        auth: args.auth,
                      },
                      tableHandler,
                      subscription: {
                        id: sub.id,
                        table: sub.table,
                        scopes: effectiveScopes,
                        params: sub.params,
                        cursor,
                        crdtStateVectors: sub.crdtStateVectors,
                      },
                      changes: incrementalItems.map((item) => item.change),
                    });
                    for (let i = 0; i < incrementalItems.length; i += 1) {
                      incrementalItems[i]!.change = transformedChanges[i]!;
                    }
                  }

                  let nextCursor = cursor;

                  if (dedupeRows) {
                    const latestByRowKey = new Map<
                      string,
                      {
                        commitSeq: number;
                        createdAt: string;
                        actorId: string;
                        change: SyncChange;
                      }
                    >();

                    for (const item of incrementalItems) {
                      nextCursor = Math.max(nextCursor, item.commitSeq);
                      const rowKey = `${item.change.table}\u0000${item.change.row_id}`;

                      // Move row keys to insertion tail so Map iteration yields
                      // "latest change wins" order without a full array sort.
                      if (latestByRowKey.has(rowKey)) {
                        latestByRowKey.delete(rowKey);
                      }
                      latestByRowKey.set(rowKey, {
                        commitSeq: item.commitSeq,
                        createdAt: item.createdAt,
                        actorId: item.actorId,
                        change: item.change,
                      });
                    }

                    nextCursor = Math.max(nextCursor, maxScannedCommitSeq);

                    if (latestByRowKey.size === 0) {
                      subResponses.push({
                        id: sub.id,
                        status: 'active',
                        scopes: effectiveScopes,
                        bootstrap: false,
                        nextCursor,
                        commits: [],
                      });
                      nextCursors.push(nextCursor);
                      continue;
                    }

                    const commits: SyncCommit[] = [];
                    for (const item of latestByRowKey.values()) {
                      const lastCommit = commits[commits.length - 1];
                      if (
                        !lastCommit ||
                        lastCommit.commitSeq !== item.commitSeq
                      ) {
                        commits.push({
                          commitSeq: item.commitSeq,
                          createdAt: item.createdAt,
                          actorId: item.actorId,
                          changes: [item.change],
                        });
                        continue;
                      }
                      lastCommit.changes.push(item.change);
                    }
                    const integrity = await createWireSubscriptionIntegrity({
                      partitionId,
                      subscriptionId: sub.id,
                      previousRoot:
                        typeof sub.verifiedRoot === 'string'
                          ? sub.verifiedRoot
                          : SYNCULAR_COMMIT_GENESIS_ROOT,
                      commits,
                    });

                    subResponses.push({
                      id: sub.id,
                      status: 'active',
                      scopes: effectiveScopes,
                      bootstrap: false,
                      nextCursor,
                      ...(integrity ? { integrity } : {}),
                      commits,
                    });
                    nextCursors.push(nextCursor);
                    continue;
                  }

                  const commits: SyncCommit[] = [];

                  for (const item of incrementalItems) {
                    nextCursor = Math.max(nextCursor, item.commitSeq);
                    const seq = item.commitSeq;
                    let commit = commits[commits.length - 1];
                    if (!commit || commit.commitSeq !== seq) {
                      commit = {
                        commitSeq: seq,
                        createdAt: item.createdAt,
                        actorId: item.actorId,
                        changes: [],
                      };
                      commits.push(commit);
                    }

                    commit.changes.push(item.change);
                  }

                  const integrity = await createWireSubscriptionIntegrity({
                    partitionId,
                    subscriptionId: sub.id,
                    previousRoot:
                      typeof sub.verifiedRoot === 'string'
                        ? sub.verifiedRoot
                        : SYNCULAR_COMMIT_GENESIS_ROOT,
                    commits,
                  });

                  nextCursor = Math.max(nextCursor, maxScannedCommitSeq);

                  if (commits.length === 0) {
                    subResponses.push({
                      id: sub.id,
                      status: 'active',
                      scopes: effectiveScopes,
                      bootstrap: false,
                      nextCursor,
                      commits: [],
                    });
                    nextCursors.push(nextCursor);
                    continue;
                  }

                  subResponses.push({
                    id: sub.id,
                    status: 'active',
                    scopes: effectiveScopes,
                    bootstrap: false,
                    nextCursor,
                    ...(integrity ? { integrity } : {}),
                    commits,
                  });
                  nextCursors.push(nextCursor);
                }

                const effectiveScopes = mergeScopes(activeSubscriptions);
                const clientCursor =
                  nextCursors.length > 0
                    ? Math.min(...nextCursors)
                    : maxCommitSeq;

                return {
                  response: {
                    ok: true as const,
                    subscriptions: subResponses,
                  },
                  effectiveScopes,
                  clientCursor,
                };
              }
            );

            const chunkStorage = args.chunkStorage;
            if (chunkStorage && pendingExternalChunkWrites.length > 0) {
              await runWithConcurrency(
                pendingExternalChunkWrites,
                4,
                async (pending) => {
                  const cacheLookupStartedAt = Date.now();
                  let chunkRef: SyncSnapshotChunkRef | null =
                    await readSnapshotChunkRefByPageKey(db, {
                      partitionId: pending.cacheLookup.partitionId,
                      scopeKey: pending.cacheLookup.scopeKey,
                      scope: pending.cacheLookup.scope,
                      asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                      rowCursor: pending.cacheLookup.rowCursor,
                      rowLimit: pending.cacheLookup.rowLimit,
                      encoding: snapshotChunkEncoding,
                      compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                    });
                  bootstrapTimings.chunkCacheLookupMs += Math.max(
                    0,
                    Date.now() - cacheLookupStartedAt
                  );

                  if (!chunkRef) {
                    if (chunkStorage.storeChunkStream) {
                      const {
                        stream: bodyStream,
                        byteLength,
                        sha256,
                        gzipMs,
                        hashMs,
                      } = await encodeCompressedSnapshotChunkToStream(
                        pending.payloadParts,
                        snapshotChunkGzipLevel
                      );
                      bootstrapTimings.chunkGzipMs += gzipMs;
                      bootstrapTimings.chunkHashMs += hashMs;
                      const chunkPersistStartedAt = Date.now();
                      chunkRef = await chunkStorage.storeChunkStream({
                        partitionId: pending.cacheLookup.partitionId,
                        scopeKey: pending.cacheLookup.scopeKey,
                        scope: pending.cacheLookup.scope,
                        asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                        rowCursor: pending.cacheLookup.rowCursor,
                        rowLimit: pending.cacheLookup.rowLimit,
                        nextRowCursor: pending.cacheLookup.nextRowCursor,
                        isLastPage: pending.cacheLookup.isLastPage,
                        encoding: snapshotChunkEncoding,
                        compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                        sha256,
                        byteLength,
                        bodyStream,
                        expiresAt: pending.expiresAt,
                      });
                      bootstrapTimings.chunkPersistMs += Math.max(
                        0,
                        Date.now() - chunkPersistStartedAt
                      );
                    } else {
                      const encodedChunk = await encodeCompressedSnapshotChunk(
                        pending.payloadParts,
                        snapshotChunkGzipLevel
                      );
                      bootstrapTimings.chunkGzipMs += encodedChunk.gzipMs;
                      bootstrapTimings.chunkHashMs += encodedChunk.hashMs;
                      const chunkPersistStartedAt = Date.now();
                      chunkRef = await chunkStorage.storeChunk({
                        partitionId: pending.cacheLookup.partitionId,
                        scopeKey: pending.cacheLookup.scopeKey,
                        scope: pending.cacheLookup.scope,
                        asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                        rowCursor: pending.cacheLookup.rowCursor,
                        rowLimit: pending.cacheLookup.rowLimit,
                        nextRowCursor: pending.cacheLookup.nextRowCursor,
                        isLastPage: pending.cacheLookup.isLastPage,
                        encoding: snapshotChunkEncoding,
                        compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                        sha256: encodedChunk.sha256,
                        body: encodedChunk.body,
                        expiresAt: pending.expiresAt,
                      });
                      bootstrapTimings.chunkPersistMs += Math.max(
                        0,
                        Date.now() - chunkPersistStartedAt
                      );
                    }
                  }

                  const chunk = toResponseChunkRef(chunkRef);
                  pending.snapshot.chunks = [chunk];
                  pending.snapshot.manifest =
                    await createChunkedSnapshotManifest({
                      table: pending.snapshot.table,
                      asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                      scopeKey: pending.cacheLookup.scopeKey,
                      rowCursor: pending.cacheLookup.rowCursor,
                      rowLimit: pending.cacheLookup.rowLimit,
                      nextRowCursor: pending.cacheLookup.nextRowCursor,
                      isFirstPage: pending.snapshot.isFirstPage,
                      isLastPage: pending.cacheLookup.isLastPage,
                      chunks: [chunk],
                    });
                }
              );
            }

            const durationMs = Math.max(0, Date.now() - startedAtMs);
            const stats = summarizePullResponse(result.response);

            span.setAttribute('status', 'ok');
            span.setAttribute('duration_ms', durationMs);
            span.setAttribute('subscription_count', stats.subscriptionCount);
            span.setAttribute('commit_count', stats.commitCount);
            span.setAttribute('change_count', stats.changeCount);
            span.setAttribute('snapshot_page_count', stats.snapshotPageCount);
            span.setAttributes({
              bootstrap_snapshot_query_ms: bootstrapTimings.snapshotQueryMs,
              bootstrap_snapshot_binary_encode_ms:
                bootstrapTimings.binaryEncodeMs,
              bootstrap_chunk_cache_lookup_ms:
                bootstrapTimings.chunkCacheLookupMs,
              bootstrap_artifact_cache_lookup_ms:
                bootstrapTimings.artifactCacheLookupMs,
              bootstrap_chunk_gzip_ms: bootstrapTimings.chunkGzipMs,
              bootstrap_chunk_hash_ms: bootstrapTimings.chunkHashMs,
              bootstrap_chunk_persist_ms: bootstrapTimings.chunkPersistMs,
            });
            span.setStatus('ok');

            recordPullMetrics({
              status: 'ok',
              dedupeRows,
              durationMs,
              stats,
            });

            return {
              ...result,
              bootstrapTimings,
            };
          } catch (error) {
            if (
              error instanceof Error &&
              attemptIndex < MAX_PULL_TRANSACTION_RETRIES - 1 &&
              isSerializablePullError(error)
            ) {
              await delay(PULL_TRANSACTION_RETRY_DELAY_MS * (attemptIndex + 1));
              continue;
            }
            throw error;
          }
        }

        throw new Error('Pull transaction retry loop exhausted unexpectedly');
      } catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);

        span.setAttribute('status', 'error');
        span.setAttribute('duration_ms', durationMs);
        span.setStatus('error');

        recordPullMetrics({
          status: 'error',
          dedupeRows: request.dedupeRows === true,
          durationMs,
          stats: {
            subscriptionCount: 0,
            activeSubscriptionCount: 0,
            revokedSubscriptionCount: 0,
            bootstrapSubscriptionCount: 0,
            commitCount: 0,
            changeCount: 0,
            snapshotPageCount: 0,
          },
        });

        captureSyncException(error, {
          event: 'sync.server.pull',
          requestedSubscriptionCount,
          dedupeRows: request.dedupeRows === true,
        });
        throw error;
      }
    }
  );
}
