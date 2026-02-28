import {
  captureSyncException,
  countSyncMetric,
  distributionSyncMetric,
  type SyncChange,
  type SyncPushRequest,
  type SyncPushResponse,
  startSyncSpan,
} from '@syncular/core';
import type {
  Insertable,
  Kysely,
  SelectQueryBuilder,
  SqlBool,
  Updateable,
} from 'kysely';
import { sql } from 'kysely';
import type { ServerSyncDialect } from './dialect/types';
import {
  getServerHandlerOrThrow,
  type ServerHandlerCollection,
} from './handlers/collection';
import type { SyncServerAuth } from './handlers/types';
import {
  type SyncServerPushPlugin,
  sortServerPushPlugins,
} from './plugins/types';
import type { SyncCoreDb } from './schema';

// biome-ignore lint/complexity/noBannedTypes: Kysely uses `{}` as the initial "no selected columns yet" marker.
type EmptySelection = {};

export interface PushCommitResult {
  response: SyncPushResponse;
  /**
   * Distinct tables affected by this commit.
   * Empty for rejected commits and for commits that emit no changes.
   */
  affectedTables: string[];
  /**
   * Scope keys derived from emitted changes (e.g. "org:abc", "team:xyz").
   * Computed in-transaction so callers don't need an extra DB query.
   * Empty for rejected/cached commits.
   */
  scopeKeys: string[];
  /**
   * Changes emitted by this commit. Available for WS data delivery.
   * Empty for rejected/cached commits.
   */
  emittedChanges: SyncChange[];
  /**
   * Commit actor metadata for downstream notifications.
   * Null when no commit row was persisted.
   */
  commitActorId: string | null;
  /**
   * Commit timestamp metadata for downstream notifications.
   * Null when no commit row was persisted.
   */
  commitCreatedAt: string | null;
}

class RejectCommitError extends Error {
  constructor(public readonly response: SyncPushResponse) {
    super('REJECT_COMMIT');
    this.name = 'RejectCommitError';
  }
}

function toDialectJsonValue(
  dialect: ServerSyncDialect,
  value: unknown
): unknown {
  if (value === null || value === undefined) return null;
  if (dialect.family === 'sqlite') return JSON.stringify(value);
  return value;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : null;
  }
  if (typeof value === 'string') {
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSyncPushResponse(value: unknown): value is SyncPushResponse {
  return (
    isRecord(value) && value.ok === true && typeof value.status === 'string'
  );
}

function assertOperationIdentityUnchanged(
  pluginName: string,
  before: SyncPushRequest['operations'][number],
  after: SyncPushRequest['operations'][number]
): void {
  if (before.table !== after.table) {
    throw new Error(
      `Server push plugin "${pluginName}" cannot change op.table (${before.table} -> ${after.table})`
    );
  }
  if (before.row_id !== after.row_id) {
    throw new Error(
      `Server push plugin "${pluginName}" cannot change op.row_id (${before.row_id} -> ${after.row_id})`
    );
  }
  if (before.op !== after.op) {
    throw new Error(
      `Server push plugin "${pluginName}" cannot change op.op (${before.op} -> ${after.op})`
    );
  }
}

async function readCommitAffectedTables<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  dialect: ServerSyncDialect,
  commitSeq: number,
  partitionId: string
): Promise<string[]> {
  try {
    const commitsQ = db.selectFrom('sync_commits') as SelectQueryBuilder<
      DB,
      'sync_commits',
      EmptySelection
    >;

    const row = await commitsQ
      .selectAll()
      .where(sql<SqlBool>`commit_seq = ${commitSeq}`)
      .where(sql<SqlBool>`partition_id = ${partitionId}`)
      .executeTakeFirst();

    const raw = row?.affected_tables;
    return dialect.dbToArray(raw);
  } catch {
    // ignore and fall back to scanning changes (best-effort)
  }

  // Fallback: read from changes using dialect-specific implementation
  return dialect.readAffectedTablesFromChanges(db, commitSeq, { partitionId });
}

function scopeKeysFromEmitted(
  emitted: Array<{ scopes: Record<string, string> }>
): string[] {
  const keys = new Set<string>();
  for (const c of emitted) {
    for (const [key, value] of Object.entries(c.scopes)) {
      if (!value) continue;
      const prefix = key.replace(/_id$/, '');
      keys.add(`${prefix}:${value}`);
    }
  }
  return Array.from(keys);
}

function recordPushMetrics(args: {
  status: string;
  durationMs: number;
  operationCount: number;
  emittedChangeCount: number;
  affectedTableCount: number;
}): void {
  const {
    status,
    durationMs,
    operationCount,
    emittedChangeCount,
    affectedTableCount,
  } = args;

  countSyncMetric('sync.server.push.requests', 1, {
    attributes: { status },
  });
  countSyncMetric('sync.server.push.operations', operationCount, {
    attributes: { status },
  });
  distributionSyncMetric('sync.server.push.duration_ms', durationMs, {
    unit: 'millisecond',
    attributes: { status },
  });
  distributionSyncMetric(
    'sync.server.push.emitted_changes',
    emittedChangeCount,
    {
      attributes: { status },
    }
  );
  distributionSyncMetric(
    'sync.server.push.affected_tables',
    affectedTableCount,
    {
      attributes: { status },
    }
  );
}

export async function pushCommit<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<DB, Auth>;
  plugins?: readonly SyncServerPushPlugin<DB, Auth>[];
  auth: Auth;
  request: SyncPushRequest;
}): Promise<PushCommitResult> {
  const { db, dialect, handlers, request } = args;
  const pushPlugins = sortServerPushPlugins(args.plugins);
  const actorId = args.auth.actorId;
  const partitionId = args.auth.partitionId ?? 'default';
  const requestedOps = Array.isArray(request.operations)
    ? request.operations
    : [];
  const operationCount = requestedOps.length;
  const startedAtMs = Date.now();

  return startSyncSpan(
    {
      name: 'sync.server.push',
      op: 'sync.push',
      attributes: {
        operation_count: operationCount,
      },
    },
    async (span) => {
      const finalizeResult = (result: PushCommitResult): PushCommitResult => {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const status = result.response.status;

        span.setAttribute('status', status);
        span.setAttribute('duration_ms', durationMs);
        span.setAttribute('emitted_change_count', result.emittedChanges.length);
        span.setAttribute('affected_table_count', result.affectedTables.length);
        span.setStatus('ok');

        recordPushMetrics({
          status,
          durationMs,
          operationCount,
          emittedChangeCount: result.emittedChanges.length,
          affectedTableCount: result.affectedTables.length,
        });

        return result;
      };

      try {
        if (!request.clientId || !request.clientCommitId) {
          return finalizeResult({
            response: {
              ok: true,
              status: 'rejected',
              results: [
                {
                  opIndex: 0,
                  status: 'error',
                  error: 'INVALID_REQUEST',
                  code: 'INVALID_REQUEST',
                  retriable: false,
                },
              ],
            },
            affectedTables: [],
            scopeKeys: [],
            emittedChanges: [],
            commitActorId: null,
            commitCreatedAt: null,
          });
        }

        const ops = request.operations ?? [];
        if (!Array.isArray(ops) || ops.length === 0) {
          return finalizeResult({
            response: {
              ok: true,
              status: 'rejected',
              results: [
                {
                  opIndex: 0,
                  status: 'error',
                  error: 'EMPTY_COMMIT',
                  code: 'EMPTY_COMMIT',
                  retriable: false,
                },
              ],
            },
            affectedTables: [],
            scopeKeys: [],
            emittedChanges: [],
            commitActorId: null,
            commitCreatedAt: null,
          });
        }

        return finalizeResult(
          await dialect.executeInTransaction(db, async (trx) => {
            type SyncTrx = Pick<
              Kysely<SyncCoreDb>,
              'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
            >;

            const syncTrx = trx as SyncTrx;

            // Clean up any stale commit row with null result_json.
            // This can happen when a previous push inserted the commit row but crashed
            // before writing the result (e.g., on D1 without transaction support).
            if (!dialect.supportsSavepoints) {
              await syncTrx
                .deleteFrom('sync_commits')
                .where('partition_id', '=', partitionId)
                .where('client_id', '=', request.clientId)
                .where('client_commit_id', '=', request.clientCommitId)
                .where('result_json', 'is', null)
                .execute();
            }

            // Insert commit row (idempotency key)
            const commitRow: Insertable<SyncCoreDb['sync_commits']> = {
              partition_id: partitionId,
              actor_id: actorId,
              client_id: request.clientId,
              client_commit_id: request.clientCommitId,
              meta: null,
              result_json: null,
            };

            const loadExistingCommit = async (): Promise<PushCommitResult> => {
              // Existing commit: return cached response (applied or rejected)
              // Use forUpdate() for row locking on databases that support it
              let query = (
                syncTrx.selectFrom('sync_commits') as SelectQueryBuilder<
                  SyncCoreDb,
                  'sync_commits',
                  EmptySelection
                >
              )
                .selectAll()
                .where('partition_id', '=', partitionId)
                .where('client_id', '=', request.clientId)
                .where('client_commit_id', '=', request.clientCommitId);

              if (dialect.supportsForUpdate) {
                query = query.forUpdate();
              }

              const existing = await query.executeTakeFirstOrThrow();

              const parsedCached = parseJsonValue(existing.result_json);
              if (!isSyncPushResponse(parsedCached)) {
                return {
                  response: {
                    ok: true,
                    status: 'rejected',
                    results: [
                      {
                        opIndex: 0,
                        status: 'error',
                        error: 'IDEMPOTENCY_CACHE_MISS',
                        code: 'INTERNAL',
                        retriable: true,
                      },
                    ],
                  },
                  affectedTables: [],
                  scopeKeys: [],
                  emittedChanges: [],
                  commitActorId:
                    typeof existing.actor_id === 'string'
                      ? existing.actor_id
                      : null,
                  commitCreatedAt:
                    typeof existing.created_at === 'string'
                      ? existing.created_at
                      : null,
                };
              }

              const base: SyncPushResponse = {
                ...parsedCached,
                commitSeq: Number(existing.commit_seq),
              };

              if (parsedCached.status === 'applied') {
                const tablesFromDb = dialect.dbToArray(
                  existing.affected_tables
                );
                return {
                  response: { ...base, status: 'cached' },
                  affectedTables:
                    tablesFromDb.length > 0
                      ? tablesFromDb
                      : await readCommitAffectedTables(
                          trx,
                          dialect,
                          Number(existing.commit_seq),
                          partitionId
                        ),
                  scopeKeys: [],
                  emittedChanges: [],
                  commitActorId:
                    typeof existing.actor_id === 'string'
                      ? existing.actor_id
                      : null,
                  commitCreatedAt:
                    typeof existing.created_at === 'string'
                      ? existing.created_at
                      : null,
                };
              }

              return {
                response: base,
                affectedTables: [],
                scopeKeys: [],
                emittedChanges: [],
                commitActorId:
                  typeof existing.actor_id === 'string'
                    ? existing.actor_id
                    : null,
                commitCreatedAt:
                  typeof existing.created_at === 'string'
                    ? existing.created_at
                    : null,
              };
            };

            const loadPersistedCommitMetadata = async (
              seq: number
            ): Promise<{
              commitActorId: string | null;
              commitCreatedAt: string | null;
            }> => {
              const persisted = await (
                syncTrx.selectFrom('sync_commits') as SelectQueryBuilder<
                  SyncCoreDb,
                  'sync_commits',
                  EmptySelection
                >
              )
                .selectAll()
                .where('commit_seq', '=', seq)
                .where('partition_id', '=', partitionId)
                .executeTakeFirst();

              return {
                commitActorId:
                  typeof persisted?.actor_id === 'string'
                    ? persisted.actor_id
                    : null,
                commitCreatedAt:
                  typeof persisted?.created_at === 'string'
                    ? persisted.created_at
                    : null,
              };
            };

            let commitSeq = 0;
            if (dialect.supportsInsertReturning) {
              const insertedCommit = await syncTrx
                .insertInto('sync_commits')
                .values(commitRow)
                .onConflict((oc) =>
                  oc
                    .columns(['partition_id', 'client_id', 'client_commit_id'])
                    .doNothing()
                )
                .returning(['commit_seq'])
                .executeTakeFirst();

              if (!insertedCommit) {
                return loadExistingCommit();
              }

              commitSeq = coerceNumber(insertedCommit.commit_seq) ?? 0;
            } else {
              const insertResult = await syncTrx
                .insertInto('sync_commits')
                .values(commitRow)
                .onConflict((oc) =>
                  oc
                    .columns(['partition_id', 'client_id', 'client_commit_id'])
                    .doNothing()
                )
                .executeTakeFirstOrThrow();

              const insertedRows = Number(
                insertResult.numInsertedOrUpdatedRows ?? 0
              );
              if (insertedRows === 0) {
                return loadExistingCommit();
              }

              commitSeq = coerceNumber(insertResult.insertId) ?? 0;
            }

            if (commitSeq <= 0) {
              const insertedCommitRow = await (
                syncTrx.selectFrom('sync_commits') as SelectQueryBuilder<
                  SyncCoreDb,
                  'sync_commits',
                  EmptySelection
                >
              )
                .selectAll()
                .where('partition_id', '=', partitionId)
                .where('client_id', '=', request.clientId)
                .where('client_commit_id', '=', request.clientCommitId)
                .executeTakeFirstOrThrow();
              commitSeq = Number(insertedCommitRow.commit_seq);
            }
            const commitId = `${request.clientId}:${request.clientCommitId}`;

            const savepointName = 'sync_apply';
            let useSavepoints = dialect.supportsSavepoints;
            if (useSavepoints && ops.length === 1) {
              const singleOpHandler = getServerHandlerOrThrow(
                handlers,
                ops[0]!.table
              );
              if (singleOpHandler.canRejectSingleOperationWithoutSavepoint) {
                useSavepoints = false;
              }
            }
            let savepointCreated = false;

            try {
              // Apply the commit under a savepoint so we can roll back app writes on conflict
              // while still persisting the commit-level cached response.
              if (useSavepoints) {
                await sql.raw(`SAVEPOINT ${savepointName}`).execute(trx);
                savepointCreated = true;
              }

              const allEmitted = [];
              const results = [];
              const affectedTablesSet = new Set<string>();

              for (let i = 0; i < ops.length; ) {
                const op = ops[i]!;
                const handler = getServerHandlerOrThrow(handlers, op.table);

                const operationCtx = {
                  db: trx,
                  trx,
                  actorId,
                  auth: args.auth,
                  clientId: request.clientId,
                  commitId,
                  schemaVersion: request.schemaVersion,
                };

                let transformedOp = op;
                for (const plugin of pushPlugins) {
                  if (!plugin.beforeApplyOperation) continue;
                  const nextOp = await plugin.beforeApplyOperation({
                    ctx: operationCtx,
                    tableHandler: handler,
                    op: transformedOp,
                    opIndex: i,
                  });
                  assertOperationIdentityUnchanged(plugin.name, op, nextOp);
                  transformedOp = nextOp;
                }

                let appliedBatch:
                  | Awaited<ReturnType<typeof handler.applyOperation>>[]
                  | null = null;
                let consumed = 1;

                if (
                  pushPlugins.length === 0 &&
                  handler.applyOperationBatch &&
                  dialect.supportsInsertReturning
                ) {
                  const batchInput = [];
                  for (let j = i; j < ops.length; j++) {
                    const nextOp = ops[j]!;
                    if (nextOp.table !== op.table) break;
                    batchInput.push({ op: nextOp, opIndex: j });
                  }

                  if (batchInput.length > 1) {
                    appliedBatch = await handler.applyOperationBatch(
                      operationCtx,
                      batchInput
                    );
                    consumed = Math.max(1, appliedBatch.length);
                  }
                }

                if (!appliedBatch) {
                  let appliedSingle = await handler.applyOperation(
                    operationCtx,
                    transformedOp,
                    i
                  );

                  for (const plugin of pushPlugins) {
                    if (!plugin.afterApplyOperation) continue;
                    appliedSingle = await plugin.afterApplyOperation({
                      ctx: operationCtx,
                      tableHandler: handler,
                      op: transformedOp,
                      opIndex: i,
                      applied: appliedSingle,
                    });
                  }

                  appliedBatch = [appliedSingle];
                }
                if (appliedBatch.length === 0) {
                  throw new Error(
                    `Handler "${op.table}" returned no results from applyOperationBatch`
                  );
                }

                for (const applied of appliedBatch) {
                  if (applied.result.status !== 'applied') {
                    results.push(applied.result);
                    throw new RejectCommitError({
                      ok: true,
                      status: 'rejected',
                      commitSeq,
                      results,
                    });
                  }

                  // Framework-level enforcement: emitted changes must have scopes
                  for (const c of applied.emittedChanges ?? []) {
                    const scopes = c?.scopes;
                    if (!scopes || typeof scopes !== 'object') {
                      results.push({
                        opIndex: applied.result.opIndex,
                        status: 'error' as const,
                        error: 'MISSING_SCOPES',
                        code: 'INVALID_SCOPE',
                        retriable: false,
                      });
                      throw new RejectCommitError({
                        ok: true,
                        status: 'rejected',
                        commitSeq,
                        results,
                      });
                    }
                  }

                  results.push(applied.result);
                  allEmitted.push(...applied.emittedChanges);
                  for (const c of applied.emittedChanges) {
                    affectedTablesSet.add(c.table);
                  }
                }

                i += consumed;
              }

              if (allEmitted.length > 0) {
                const changeRows: Array<
                  Insertable<SyncCoreDb['sync_changes']>
                > = allEmitted.map((c) => ({
                  partition_id: partitionId,
                  commit_seq: commitSeq,
                  table: c.table,
                  row_id: c.row_id,
                  op: c.op,
                  row_json: toDialectJsonValue(dialect, c.row_json),
                  row_version: c.row_version,
                  scopes: dialect.scopesToDb(c.scopes),
                }));

                await syncTrx
                  .insertInto('sync_changes')
                  .values(changeRows)
                  .execute();
              }

              const appliedResponse: SyncPushResponse = {
                ok: true,
                status: 'applied',
                commitSeq,
                results,
              };

              const affectedTables = Array.from(affectedTablesSet).sort();

              const appliedCommitUpdate: Updateable<
                SyncCoreDb['sync_commits']
              > = {
                result_json: toDialectJsonValue(dialect, appliedResponse),
                change_count: allEmitted.length,
                affected_tables: dialect.arrayToDb(affectedTables) as string[],
              };

              await syncTrx
                .updateTable('sync_commits')
                .set(appliedCommitUpdate)
                .where('commit_seq', '=', commitSeq)
                .execute();

              // Insert table commits for subscription filtering
              if (affectedTables.length > 0) {
                const tableCommits: Array<
                  Insertable<SyncCoreDb['sync_table_commits']>
                > = affectedTables.map((table) => ({
                  partition_id: partitionId,
                  table,
                  commit_seq: commitSeq,
                }));

                await syncTrx
                  .insertInto('sync_table_commits')
                  .values(tableCommits)
                  .onConflict((oc) =>
                    oc
                      .columns(['partition_id', 'table', 'commit_seq'])
                      .doNothing()
                  )
                  .execute();
              }

              if (useSavepoints) {
                await sql
                  .raw(`RELEASE SAVEPOINT ${savepointName}`)
                  .execute(trx);
              }

              const commitMetadata =
                await loadPersistedCommitMetadata(commitSeq);

              return {
                response: appliedResponse,
                affectedTables,
                scopeKeys: scopeKeysFromEmitted(allEmitted),
                emittedChanges: allEmitted.map((c) => ({
                  table: c.table,
                  row_id: c.row_id,
                  op: c.op,
                  row_json: c.row_json,
                  row_version: c.row_version,
                  scopes: c.scopes,
                })),
                ...commitMetadata,
              };
            } catch (err) {
              // Roll back app writes but keep the commit row.
              if (savepointCreated) {
                try {
                  await sql
                    .raw(`ROLLBACK TO SAVEPOINT ${savepointName}`)
                    .execute(trx);
                  await sql
                    .raw(`RELEASE SAVEPOINT ${savepointName}`)
                    .execute(trx);
                } catch (savepointErr) {
                  // If savepoint rollback fails, the transaction may be in an
                  // inconsistent state. Log and rethrow to fail the entire commit
                  // rather than risk data corruption.
                  console.error(
                    '[pushCommit] Savepoint rollback failed:',
                    savepointErr
                  );
                  throw savepointErr;
                }
              }

              if (!(err instanceof RejectCommitError)) throw err;

              const rejectedCommitUpdate: Updateable<
                SyncCoreDb['sync_commits']
              > = {
                result_json: toDialectJsonValue(dialect, err.response),
                change_count: 0,
                affected_tables: dialect.arrayToDb([]) as string[],
              };

              // Persist the rejected response for commit-level idempotency.
              await syncTrx
                .updateTable('sync_commits')
                .set(rejectedCommitUpdate)
                .where('commit_seq', '=', commitSeq)
                .execute();

              const commitMetadata =
                await loadPersistedCommitMetadata(commitSeq);

              return {
                response: err.response,
                affectedTables: [],
                scopeKeys: [],
                emittedChanges: [],
                ...commitMetadata,
              };
            }
          })
        );
      } catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        span.setAttribute('status', 'error');
        span.setAttribute('duration_ms', durationMs);
        span.setStatus('error');

        recordPushMetrics({
          status: 'error',
          durationMs,
          operationCount,
          emittedChangeCount: 0,
          affectedTableCount: 0,
        });
        captureSyncException(error, {
          event: 'sync.server.push',
          operationCount,
        });
        throw error;
      }
    }
  );
}
