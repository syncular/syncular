import {
  captureSyncException,
  countSyncMetric,
  distributionSyncMetric,
  encodeSnapshotRowFrames,
  encodeSnapshotRows,
  gzipBytes,
  randomId,
  type ScopeValues,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING,
  type SyncBootstrapState,
  type SyncChange,
  type SyncCommit,
  type SyncPullRequest,
  type SyncPullResponse,
  type SyncPullSubscriptionResponse,
  type SyncSnapshot,
  sha256Hex,
  startSyncSpan,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import type { DbExecutor, ServerSyncDialect } from './dialect/types';
import {
  getServerBootstrapOrderFor,
  type ServerHandlerCollection,
} from './handlers/collection';
import type { SyncServerAuth } from './handlers/types';
import { EXTERNAL_CLIENT_ID } from './notify';
import type { SyncCoreDb } from './schema';
import {
  insertSnapshotChunk,
  readSnapshotChunkRefByPageKey,
  scopesToSnapshotChunkScopeKey,
} from './snapshot-chunks';
import type { SnapshotChunkStorage } from './snapshot-chunks/types';
import {
  createMemoryScopeCache,
  type ScopeCacheBackend,
} from './subscriptions/cache';
import { resolveEffectiveScopesForSubscriptions } from './subscriptions/resolve';

const defaultScopeCache = createMemoryScopeCache();
const DEFAULT_MAX_SNAPSHOT_BUNDLE_ROW_FRAME_BYTES = 512 * 1024;

function concatByteChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array();
  }

  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function byteChunksToStream(
  chunks: readonly Uint8Array[]
): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        controller.enqueue(chunk.slice());
      }
      controller.close();
    },
  });
}

function bufferSourceToUint8Array(chunk: BufferSource): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

async function streamToBytes(
  stream: ReadableStream<BufferSource>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = bufferSourceToUint8Array(value);
      if (bytes.length === 0) continue;
      chunks.push(bytes);
      total += bytes.length;
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function bufferSourceStreamToUint8ArrayStream(
  stream: ReadableStream<BufferSource>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const bytes = bufferSourceToUint8Array(value);
          if (bytes.length === 0) continue;
          controller.enqueue(bytes);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

let nodeCryptoModulePromise: Promise<
  typeof import('node:crypto') | null
> | null = null;

async function getNodeCryptoModule(): Promise<
  typeof import('node:crypto') | null
> {
  if (!nodeCryptoModulePromise) {
    nodeCryptoModulePromise = import('node:crypto').catch(() => null);
  }
  return nodeCryptoModulePromise;
}

async function sha256HexFromByteChunks(
  chunks: readonly Uint8Array[]
): Promise<string> {
  const nodeCrypto = await getNodeCryptoModule();
  if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
    const hasher = nodeCrypto.createHash('sha256');
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      hasher.update(chunk);
    }
    return hasher.digest('hex');
  }

  return sha256Hex(concatByteChunks(chunks));
}

async function gzipByteChunks(
  chunks: readonly Uint8Array[]
): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const stream = byteChunksToStream(chunks).pipeThrough(
      new CompressionStream('gzip')
    );
    return streamToBytes(stream);
  }

  return gzipBytes(concatByteChunks(chunks));
}

async function gzipByteChunksToStream(chunks: readonly Uint8Array[]): Promise<{
  stream: ReadableStream<Uint8Array>;
  byteLength?: number;
}> {
  if (typeof CompressionStream !== 'undefined') {
    const source = byteChunksToStream(chunks).pipeThrough(
      new CompressionStream('gzip')
    );
    return {
      stream: bufferSourceStreamToUint8ArrayStream(source),
    };
  }

  const compressed = await gzipBytes(concatByteChunks(chunks));
  return {
    stream: bufferSourceStreamToUint8ArrayStream(
      byteChunksToStream([compressed])
    ),
    byteLength: compressed.length,
  };
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
  };
  rowFrameParts: Uint8Array[];
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
}): Promise<PullResult> {
  const { request, dialect } = args;
  const db = args.db;
  const partitionId = args.auth.partitionId ?? 'default';
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
        const limitCommits = sanitizeLimit(request.limitCommits, 50, 1, 500);
        const limitSnapshotRows = sanitizeLimit(
          request.limitSnapshotRows,
          1000,
          1,
          5000
        );
        const maxSnapshotPages = sanitizeLimit(
          request.maxSnapshotPages,
          4,
          1,
          50
        );
        const dedupeRows = request.dedupeRows === true;
        const pendingExternalChunkWrites: PendingExternalChunkWrite[] = [];

        // Resolve effective scopes for each subscription
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db,
          auth: args.auth,
          subscriptions: request.subscriptions ?? [],
          handlers: args.handlers,
          scopeCache: args.scopeCache ?? defaultScopeCache,
        });

        const result = await dialect.executeInTransaction(db, async (trx) => {
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
            const latestExternalCommitForTable = maxExternalCommitByTable.get(
              sub.table
            );

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
                state.asOfCommitSeq < minCommitSeq - 1 ? initState : state;

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
              const cacheKey = `${partitionId}:${await scopesToSnapshotChunkScopeKey(
                effectiveScopes
              )}`;

              interface SnapshotBundle {
                table: string;
                startCursor: string | null;
                isFirstPage: boolean;
                isLastPage: boolean;
                pageCount: number;
                ttlMs: number;
                rowFrameByteLength: number;
                rowFrameParts: Uint8Array[];
              }

              const flushSnapshotBundle = async (
                bundle: SnapshotBundle
              ): Promise<void> => {
                const nowIso = new Date().toISOString();
                const bundleRowLimit = Math.max(
                  1,
                  limitSnapshotRows * bundle.pageCount
                );

                const cached = await readSnapshotChunkRefByPageKey(trx, {
                  partitionId,
                  scopeKey: cacheKey,
                  scope: bundle.table,
                  asOfCommitSeq: effectiveState.asOfCommitSeq,
                  rowCursor: bundle.startCursor,
                  rowLimit: bundleRowLimit,
                  encoding: SYNC_SNAPSHOT_CHUNK_ENCODING,
                  compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                  nowIso,
                });

                let chunkRef = cached;
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
                      },
                      rowFrameParts: [...bundle.rowFrameParts],
                      expiresAt,
                    });
                    return;
                  }
                  const sha256 = await sha256HexFromByteChunks(
                    bundle.rowFrameParts
                  );
                  const compressedBody = await gzipByteChunks(
                    bundle.rowFrameParts
                  );
                  const chunkId = randomId();
                  chunkRef = await insertSnapshotChunk(trx, {
                    chunkId,
                    partitionId,
                    scopeKey: cacheKey,
                    scope: bundle.table,
                    asOfCommitSeq: effectiveState.asOfCommitSeq,
                    rowCursor: bundle.startCursor,
                    rowLimit: bundleRowLimit,
                    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING,
                    compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                    sha256,
                    body: compressedBody,
                    expiresAt,
                  });
                }

                snapshots.push({
                  table: bundle.table,
                  rows: [],
                  chunks: [chunkRef],
                  isFirstPage: bundle.isFirstPage,
                  isLastPage: bundle.isLastPage,
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

                const tableHandler = args.handlers.byTable.get(nextTableName);
                if (!tableHandler) {
                  throw new Error(`Unknown table: ${nextTableName}`);
                }
                if (!activeBundle || activeBundle.table !== nextTableName) {
                  if (activeBundle) {
                    await flushSnapshotBundle(activeBundle);
                  }
                  const bundleHeader = encodeSnapshotRows([]);
                  activeBundle = {
                    table: nextTableName,
                    startCursor: nextState.rowCursor,
                    isFirstPage: nextState.rowCursor == null,
                    isLastPage: false,
                    pageCount: 0,
                    ttlMs:
                      tableHandler.snapshotChunkTtlMs ?? 24 * 60 * 60 * 1000,
                    rowFrameByteLength: bundleHeader.length,
                    rowFrameParts: [bundleHeader],
                  };
                }

                const page: { rows: unknown[]; nextCursor: string | null } =
                  await tableHandler.snapshot(
                    {
                      db: trx,
                      actorId: args.auth.actorId,
                      auth: args.auth,
                      scopeValues: effectiveScopes,
                      cursor: nextState.rowCursor,
                      limit: limitSnapshotRows,
                    },
                    sub.params
                  );

                const rowFrames = encodeSnapshotRowFrames(page.rows ?? []);
                const bundleMaxBytes = Math.max(
                  1,
                  tableHandler.snapshotBundleMaxBytes ??
                    DEFAULT_MAX_SNAPSHOT_BUNDLE_ROW_FRAME_BYTES
                );
                if (
                  activeBundle.pageCount > 0 &&
                  activeBundle.rowFrameByteLength + rowFrames.length > bundleMaxBytes
                ) {
                  await flushSnapshotBundle(activeBundle);
                  const bundleHeader = encodeSnapshotRows([]);
                  activeBundle = {
                    table: nextTableName,
                    startCursor: nextState.rowCursor,
                    isFirstPage: nextState.rowCursor == null,
                    isLastPage: false,
                    pageCount: 0,
                    ttlMs:
                      tableHandler.snapshotChunkTtlMs ?? 24 * 60 * 60 * 1000,
                    rowFrameByteLength: bundleHeader.length,
                    rowFrameParts: [bundleHeader],
                  };
                }
                activeBundle.rowFrameParts.push(rowFrames);
                activeBundle.rowFrameByteLength += rowFrames.length;
                activeBundle.pageCount += 1;

                if (page.nextCursor != null) {
                  nextState = { ...nextState, rowCursor: page.nextCursor };
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

            // Incremental pull for this subscription
            // Read the commit window for this table up-front so the subscription cursor
            // can advance past commits that don't match the requested scopes.
            const scannedCommitSeqs = await dialect.readCommitSeqsForPull(trx, {
              partitionId,
              cursor,
              limitCommits,
              tables: [sub.table],
            });
            const maxScannedCommitSeq =
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

              for await (const r of dialect.iterateIncrementalPullRows(trx, {
                partitionId,
                table: sub.table,
                scopes: effectiveScopes,
                cursor,
                limitCommits,
              })) {
                nextCursor = Math.max(nextCursor, r.commit_seq);
                const rowKey = `${r.table}\u0000${r.row_id}`;
                const change: SyncChange = {
                  table: r.table,
                  row_id: r.row_id,
                  op: r.op,
                  row_json: r.row_json,
                  row_version: r.row_version,
                  scopes: r.scopes,
                };

                // Move row keys to insertion tail so Map iteration yields
                // "latest change wins" order without a full array sort.
                if (latestByRowKey.has(rowKey)) {
                  latestByRowKey.delete(rowKey);
                }
                latestByRowKey.set(rowKey, {
                  commitSeq: r.commit_seq,
                  createdAt: r.created_at,
                  actorId: r.actor_id,
                  change,
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
                if (!lastCommit || lastCommit.commitSeq !== item.commitSeq) {
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

              subResponses.push({
                id: sub.id,
                status: 'active',
                scopes: effectiveScopes,
                bootstrap: false,
                nextCursor,
                commits,
              });
              nextCursors.push(nextCursor);
              continue;
            }

            const commitsBySeq = new Map<number, SyncCommit>();
            const commitSeqs: number[] = [];

            for await (const r of dialect.iterateIncrementalPullRows(trx, {
              partitionId,
              table: sub.table,
              scopes: effectiveScopes,
              cursor,
              limitCommits,
            })) {
              nextCursor = Math.max(nextCursor, r.commit_seq);
              const seq = r.commit_seq;
              let commit = commitsBySeq.get(seq);
              if (!commit) {
                commit = {
                  commitSeq: seq,
                  createdAt: r.created_at,
                  actorId: r.actor_id,
                  changes: [],
                };
                commitsBySeq.set(seq, commit);
                commitSeqs.push(seq);
              }

              const change: SyncChange = {
                table: r.table,
                row_id: r.row_id,
                op: r.op,
                row_json: r.row_json,
                row_version: r.row_version,
                scopes: r.scopes,
              };
              commit.changes.push(change);
            }

            nextCursor = Math.max(nextCursor, maxScannedCommitSeq);

            if (commitSeqs.length === 0) {
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

            const commits: SyncCommit[] = commitSeqs
              .map((seq) => commitsBySeq.get(seq))
              .filter((c): c is SyncCommit => !!c)
              .filter((c) => c.changes.length > 0);

            subResponses.push({
              id: sub.id,
              status: 'active',
              scopes: effectiveScopes,
              bootstrap: false,
              nextCursor,
              commits,
            });
            nextCursors.push(nextCursor);
          }

          const effectiveScopes = mergeScopes(activeSubscriptions);
          const clientCursor =
            nextCursors.length > 0 ? Math.min(...nextCursors) : maxCommitSeq;

          return {
            response: {
              ok: true as const,
              subscriptions: subResponses,
            },
            effectiveScopes,
            clientCursor,
          };
        });

        const chunkStorage = args.chunkStorage;
        if (chunkStorage && pendingExternalChunkWrites.length > 0) {
          await runWithConcurrency(
            pendingExternalChunkWrites,
            4,
            async (pending) => {
              let chunkRef = await readSnapshotChunkRefByPageKey(db, {
                partitionId: pending.cacheLookup.partitionId,
                scopeKey: pending.cacheLookup.scopeKey,
                scope: pending.cacheLookup.scope,
                asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                rowCursor: pending.cacheLookup.rowCursor,
                rowLimit: pending.cacheLookup.rowLimit,
                encoding: SYNC_SNAPSHOT_CHUNK_ENCODING,
                compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
              });

              if (!chunkRef) {
                const sha256 = await sha256HexFromByteChunks(
                  pending.rowFrameParts
                );
                if (chunkStorage.storeChunkStream) {
                  const { stream: bodyStream, byteLength } =
                    await gzipByteChunksToStream(pending.rowFrameParts);
                  chunkRef = await chunkStorage.storeChunkStream({
                    partitionId: pending.cacheLookup.partitionId,
                    scopeKey: pending.cacheLookup.scopeKey,
                    scope: pending.cacheLookup.scope,
                    asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                    rowCursor: pending.cacheLookup.rowCursor,
                    rowLimit: pending.cacheLookup.rowLimit,
                    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING,
                    compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                    sha256,
                    byteLength,
                    bodyStream,
                    expiresAt: pending.expiresAt,
                  });
                } else {
                  const compressedBody = await gzipByteChunks(
                    pending.rowFrameParts
                  );
                  chunkRef = await chunkStorage.storeChunk({
                    partitionId: pending.cacheLookup.partitionId,
                    scopeKey: pending.cacheLookup.scopeKey,
                    scope: pending.cacheLookup.scope,
                    asOfCommitSeq: pending.cacheLookup.asOfCommitSeq,
                    rowCursor: pending.cacheLookup.rowCursor,
                    rowLimit: pending.cacheLookup.rowLimit,
                    encoding: SYNC_SNAPSHOT_CHUNK_ENCODING,
                    compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                    sha256,
                    body: compressedBody,
                    expiresAt: pending.expiresAt,
                  });
                }
              }

              pending.snapshot.chunks = [chunkRef];
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
        span.setStatus('ok');

        recordPullMetrics({
          status: 'ok',
          dedupeRows,
          durationMs,
          stats,
        });

        return result;
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
