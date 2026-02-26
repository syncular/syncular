import {
  captureSyncException,
  countSyncMetric,
  distributionSyncMetric,
  encodeSnapshotRowFrames,
  encodeSnapshotRows,
  gzipBytes,
  gzipBytesToStream,
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
  getServerHandlerOrThrow,
  type ServerHandlerCollection,
} from './handlers/collection';
import type { ServerTableHandler, SyncServerAuth } from './handlers/types';
import { EXTERNAL_CLIENT_ID } from './notify';
import type { SyncCoreDb } from './schema';
import {
  insertSnapshotChunk,
  readSnapshotChunkRefByPageKey,
} from './snapshot-chunks';
import type { SnapshotChunkStorage } from './snapshot-chunks/types';
import {
  createMemoryScopeCache,
  type ScopeCacheBackend,
} from './subscriptions/cache';
import { resolveEffectiveScopesForSubscriptions } from './subscriptions/resolve';

const defaultScopeCache = createMemoryScopeCache();

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

/**
 * Generate a stable cache key for snapshot chunks.
 */
async function scopesToCacheKey(scopes: ScopeValues): Promise<string> {
  const sorted = Object.entries(scopes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const arr = Array.isArray(v) ? [...v].sort() : [v];
      return `${k}:${arr.join(',')}`;
    })
    .join('|');
  return await sha256Hex(sorted);
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

/**
 * Read synthetic commits created by notifyExternalDataChange() after a given cursor.
 * Returns commit_seq and affected tables for each external change commit.
 */
async function readExternalDataChanges<DB extends SyncCoreDb>(
  trx: DbExecutor<DB>,
  dialect: ServerSyncDialect,
  args: { partitionId: string; afterCursor: number }
): Promise<Array<{ commitSeq: number; tables: string[] }>> {
  type SyncExecutor = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const executor = trx as SyncExecutor;

  const rows = await executor
    .selectFrom('sync_commits')
    .select(['commit_seq', 'affected_tables'])
    .where('partition_id', '=', args.partitionId)
    .where('client_id', '=', EXTERNAL_CLIENT_ID)
    .where('commit_seq', '>', args.afterCursor)
    .orderBy('commit_seq', 'asc')
    .execute();

  return rows.map((row) => ({
    commitSeq: Number(row.commit_seq),
    tables: dialect.dbToArray(row.affected_tables),
  }));
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
          for (const sub of resolved) {
            if (
              sub.status === 'revoked' ||
              Object.keys(sub.scopes).length === 0
            )
              continue;
            const cursor = Math.max(-1, sub.cursor ?? -1);
            if (cursor >= 0 && cursor < minSubCursor) {
              minSubCursor = cursor;
            }
          }

          const externalDataChanges =
            minSubCursor < Number.MAX_SAFE_INTEGER && minSubCursor >= 0
              ? await readExternalDataChanges(trx, dialect, {
                  partitionId,
                  afterCursor: minSubCursor,
                })
              : [];
          const maxExternalCommitByTable = new Map<string, number>();
          for (const change of externalDataChanges) {
            for (const table of change.tables) {
              const previous = maxExternalCommitByTable.get(table) ?? -1;
              if (change.commitSeq > previous) {
                maxExternalCommitByTable.set(table, change.commitSeq);
              }
            }
          }

          for (const sub of resolved) {
            const cursor = Math.max(-1, sub.cursor ?? -1);
            // Validate table handler exists (throws if not registered)
            getServerHandlerOrThrow(args.handlers, sub.table);

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
              const cacheKey = `${partitionId}:${await scopesToCacheKey(effectiveScopes)}`;

              interface SnapshotBundle {
                table: string;
                startCursor: string | null;
                isFirstPage: boolean;
                isLastPage: boolean;
                pageCount: number;
                ttlMs: number;
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
                  const rowFramePayload = concatByteChunks(
                    bundle.rowFrameParts
                  );
                  const sha256 = await sha256Hex(rowFramePayload);
                  const expiresAt = new Date(
                    Date.now() + Math.max(1000, bundle.ttlMs)
                  ).toISOString();

                  if (args.chunkStorage) {
                    if (args.chunkStorage.storeChunkStream) {
                      const { stream: bodyStream, byteLength } =
                        await gzipBytesToStream(rowFramePayload);
                      chunkRef = await args.chunkStorage.storeChunkStream({
                        partitionId,
                        scopeKey: cacheKey,
                        scope: bundle.table,
                        asOfCommitSeq: effectiveState.asOfCommitSeq,
                        rowCursor: bundle.startCursor,
                        rowLimit: bundleRowLimit,
                        encoding: SYNC_SNAPSHOT_CHUNK_ENCODING,
                        compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
                        sha256,
                        byteLength,
                        bodyStream,
                        expiresAt,
                      });
                    } else {
                      const compressedBody = await gzipBytes(rowFramePayload);
                      chunkRef = await args.chunkStorage.storeChunk({
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
                  } else {
                    const compressedBody = await gzipBytes(rowFramePayload);
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

                const tableHandler: ServerTableHandler<DB, Auth> =
                  getServerHandlerOrThrow(args.handlers, nextTableName);
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
                activeBundle.rowFrameParts.push(rowFrames);
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
                  changeId: number;
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

                latestByRowKey.set(rowKey, {
                  commitSeq: r.commit_seq,
                  createdAt: r.created_at,
                  actorId: r.actor_id,
                  changeId: r.change_id,
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

              const latest = Array.from(latestByRowKey.values()).sort(
                (a, b) => a.commitSeq - b.commitSeq || a.changeId - b.changeId
              );

              const commits: SyncCommit[] = [];
              for (const item of latest) {
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
