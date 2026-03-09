import {
  captureSyncException,
  countSyncMetric,
  distributionSyncMetric,
  type SyncChange,
  type SyncPushRequest,
  type SyncPushResponse,
  startSyncSpan,
} from '@syncular/core';
import type { Insertable, Kysely, SelectQueryBuilder, SqlBool } from 'kysely';
import { sql } from 'kysely';
import {
  coerceNumber,
  parseJsonValue,
  toDialectJsonValue,
} from './dialect/helpers';
import type { DbExecutor, ServerSyncDialect } from './dialect/types';
import type { ServerHandlerCollection } from './handlers/collection';
import type { SyncServerAuth } from './handlers/types';
import {
  type SyncServerPushPlugin,
  sortServerPushPlugins,
} from './plugins/types';
import type { SyncCoreDb } from './schema';

// biome-ignore lint/complexity/noBannedTypes: Kysely uses `{}` as the initial "no selected columns yet" marker.
type EmptySelection = {};
type SyncMetadataTrx = Pick<
  Kysely<SyncCoreDb>,
  'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
>;

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
  db: DbExecutor<DB>,
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

function createRejectedPushResult(
  error: SyncPushResponse['results'][number]
): PushCommitResult {
  return {
    response: {
      ok: true,
      status: 'rejected',
      results: [error],
    },
    affectedTables: [],
    scopeKeys: [],
    emittedChanges: [],
    commitActorId: null,
    commitCreatedAt: null,
  };
}

function createRejectedPushResponse(
  error: SyncPushResponse['results'][number],
  commitSeq?: number
): SyncPushResponse {
  return {
    ok: true,
    status: 'rejected',
    ...(commitSeq !== undefined ? { commitSeq } : {}),
    results: [error],
  };
}

function validatePushRequest(
  request: SyncPushRequest
): SyncPushResponse['results'][number] | null {
  if (!request.clientId || !request.clientCommitId) {
    return {
      opIndex: 0,
      status: 'error',
      error: 'INVALID_REQUEST',
      code: 'INVALID_REQUEST',
      retriable: false,
    };
  }

  const ops = request.operations ?? [];
  if (!Array.isArray(ops) || ops.length === 0) {
    return {
      opIndex: 0,
      status: 'error',
      error: 'EMPTY_COMMIT',
      code: 'EMPTY_COMMIT',
      retriable: false,
    };
  }

  return null;
}

function shouldUseSavepoints<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<DB, Auth>;
  operations: SyncPushRequest['operations'];
}): boolean {
  if (!args.dialect.supportsSavepoints) {
    return false;
  }

  if ((args.operations?.length ?? 0) !== 1) {
    return true;
  }

  const singleOp = args.operations?.[0];
  if (!singleOp) {
    return true;
  }

  const singleOpHandler = args.handlers.byTable.get(singleOp.table);
  if (!singleOpHandler) {
    throw new Error(`Unknown table: ${singleOp.table}`);
  }

  return !singleOpHandler.canRejectSingleOperationWithoutSavepoint;
}

async function persistEmittedChanges<DB extends SyncCoreDb>(args: {
  trx: DbExecutor<DB>;
  dialect: ServerSyncDialect;
  partitionId: string;
  commitSeq: number;
  emittedChanges: PushCommitResult['emittedChanges'];
}): Promise<void> {
  if (args.emittedChanges.length === 0) {
    return;
  }

  const syncTrx = args.trx as Pick<Kysely<SyncCoreDb>, 'insertInto'>;
  const changeRows: Array<Insertable<SyncCoreDb['sync_changes']>> =
    args.emittedChanges.map((change) => ({
      partition_id: args.partitionId,
      commit_seq: args.commitSeq,
      table: change.table,
      row_id: change.row_id,
      op: change.op,
      row_json: toDialectJsonValue(args.dialect, change.row_json),
      row_version: change.row_version,
      scopes: args.dialect.scopesToDb(change.scopes),
    }));

  await syncTrx.insertInto('sync_changes').values(changeRows).execute();
}

async function persistCommitOutcome<DB extends SyncCoreDb>(args: {
  trx: DbExecutor<DB>;
  dialect: ServerSyncDialect;
  partitionId: string;
  commitSeq: number;
  response: SyncPushResponse;
  affectedTables: string[];
  emittedChangeCount: number;
}): Promise<void> {
  const syncTrx = args.trx as Pick<
    Kysely<SyncCoreDb>,
    'insertInto' | 'updateTable'
  >;

  await syncTrx
    .updateTable('sync_commits')
    .set({
      result_json: toDialectJsonValue(args.dialect, args.response),
      change_count: args.emittedChangeCount,
      affected_tables: args.dialect.arrayToDb(args.affectedTables) as string[],
    })
    .where('commit_seq', '=', args.commitSeq)
    .execute();

  if (args.affectedTables.length === 0) {
    return;
  }

  await syncTrx
    .insertInto('sync_table_commits')
    .values(
      args.affectedTables.map((table) => ({
        partition_id: args.partitionId,
        table,
        commit_seq: args.commitSeq,
      }))
    )
    .onConflict((oc) =>
      oc.columns(['partition_id', 'table', 'commit_seq']).doNothing()
    )
    .execute();
}

async function loadExistingCommitResult<DB extends SyncCoreDb>(args: {
  trx: DbExecutor<DB>;
  syncTrx: SyncMetadataTrx;
  dialect: ServerSyncDialect;
  request: SyncPushRequest;
  partitionId: string;
}): Promise<PushCommitResult> {
  let query = (
    args.syncTrx.selectFrom('sync_commits') as SelectQueryBuilder<
      SyncCoreDb,
      'sync_commits',
      EmptySelection
    >
  )
    .selectAll()
    .where('partition_id', '=', args.partitionId)
    .where('client_id', '=', args.request.clientId)
    .where('client_commit_id', '=', args.request.clientCommitId);

  if (args.dialect.supportsForUpdate) {
    query = query.forUpdate();
  }

  const existing = await query.executeTakeFirstOrThrow();
  const parsedCached = parseJsonValue(existing.result_json);

  if (!isSyncPushResponse(parsedCached)) {
    return createRejectedPushResult({
      opIndex: 0,
      status: 'error',
      error: 'IDEMPOTENCY_CACHE_MISS',
      code: 'INTERNAL',
      retriable: true,
    });
  }

  const base: SyncPushResponse = {
    ...parsedCached,
    commitSeq: Number(existing.commit_seq),
  };

  if (parsedCached.status === 'applied') {
    const tablesFromDb = args.dialect.dbToArray(existing.affected_tables);
    return {
      response: { ...base, status: 'cached' },
      affectedTables:
        tablesFromDb.length > 0
          ? tablesFromDb
          : await readCommitAffectedTables(
              args.trx,
              args.dialect,
              Number(existing.commit_seq),
              args.partitionId
            ),
      scopeKeys: [],
      emittedChanges: [],
      commitActorId:
        typeof existing.actor_id === 'string' ? existing.actor_id : null,
      commitCreatedAt:
        typeof existing.created_at === 'string' ? existing.created_at : null,
    };
  }

  return {
    response: base,
    affectedTables: [],
    scopeKeys: [],
    emittedChanges: [],
    commitActorId:
      typeof existing.actor_id === 'string' ? existing.actor_id : null,
    commitCreatedAt:
      typeof existing.created_at === 'string' ? existing.created_at : null,
  };
}

async function insertPendingCommit(args: {
  syncTrx: SyncMetadataTrx;
  dialect: ServerSyncDialect;
  commitRow: Insertable<SyncCoreDb['sync_commits']>;
}): Promise<number | null> {
  if (args.dialect.supportsInsertReturning) {
    const insertedCommit = await args.syncTrx
      .insertInto('sync_commits')
      .values(args.commitRow)
      .onConflict((oc) =>
        oc
          .columns(['partition_id', 'client_id', 'client_commit_id'])
          .doNothing()
      )
      .returning(['commit_seq'])
      .executeTakeFirst();

    if (!insertedCommit) {
      return null;
    }

    return coerceNumber(insertedCommit.commit_seq) ?? 0;
  }

  const insertResult = await args.syncTrx
    .insertInto('sync_commits')
    .values(args.commitRow)
    .onConflict((oc) =>
      oc.columns(['partition_id', 'client_id', 'client_commit_id']).doNothing()
    )
    .executeTakeFirstOrThrow();

  const insertedRows = Number(insertResult.numInsertedOrUpdatedRows ?? 0);
  if (insertedRows === 0) {
    return null;
  }

  return coerceNumber(insertResult.insertId) ?? 0;
}

async function applyCommitOperations<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  trx: DbExecutor<DB>;
  handlers: ServerHandlerCollection<DB, Auth>;
  pushPlugins: readonly SyncServerPushPlugin<DB, Auth>[];
  auth: Auth;
  request: SyncPushRequest;
  actorId: string;
  commitId: string;
  commitSeq: number;
}): Promise<{
  results: SyncPushResponse['results'];
  emittedChanges: PushCommitResult['emittedChanges'];
  affectedTables: string[];
}> {
  const ops = args.request.operations ?? [];
  const allEmitted: PushCommitResult['emittedChanges'] = [];
  const results: SyncPushResponse['results'] = [];
  const affectedTablesSet = new Set<string>();

  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    const handler = args.handlers.byTable.get(op.table);
    if (!handler) {
      throw new Error(`Unknown table: ${op.table}`);
    }

    const operationCtx = {
      db: args.trx,
      trx: args.trx,
      actorId: args.actorId,
      auth: args.auth,
      clientId: args.request.clientId,
      commitId: args.commitId,
      schemaVersion: args.request.schemaVersion,
    };

    let transformedOp = op;
    for (const plugin of args.pushPlugins) {
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

    if (args.pushPlugins.length === 0 && handler.applyOperationBatch) {
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

      for (const plugin of args.pushPlugins) {
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
        throw new RejectCommitError(
          createRejectedPushResponse(applied.result, args.commitSeq)
        );
      }

      for (const change of applied.emittedChanges ?? []) {
        const scopes = change?.scopes;
        if (!scopes || typeof scopes !== 'object') {
          const error: SyncPushResponse['results'][number] = {
            opIndex: applied.result.opIndex,
            status: 'error',
            error: 'MISSING_SCOPES',
            code: 'INVALID_SCOPE',
            retriable: false,
          };
          results.push(error);
          throw new RejectCommitError(
            createRejectedPushResponse(error, args.commitSeq)
          );
        }
      }

      results.push(applied.result);
      allEmitted.push(...applied.emittedChanges);
      for (const change of applied.emittedChanges) {
        affectedTablesSet.add(change.table);
      }
    }

    i += consumed;
  }

  return {
    results,
    emittedChanges: allEmitted,
    affectedTables: Array.from(affectedTablesSet).sort(),
  };
}

async function executePushCommitInExecutor<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  trx: DbExecutor<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<DB, Auth>;
  pushPlugins: readonly SyncServerPushPlugin<DB, Auth>[];
  auth: Auth;
  request: SyncPushRequest;
}): Promise<PushCommitResult> {
  const { trx, dialect, handlers, request, pushPlugins } = args;
  const actorId = args.auth.actorId;
  const partitionId = args.auth.partitionId ?? 'default';
  const ops = request.operations ?? [];
  const syncTrx = trx as SyncMetadataTrx;

  if (!dialect.supportsSavepoints) {
    await syncTrx
      .deleteFrom('sync_commits')
      .where('partition_id', '=', partitionId)
      .where('client_id', '=', request.clientId)
      .where('client_commit_id', '=', request.clientCommitId)
      .where('result_json', 'is', null)
      .execute();
  }

  const commitCreatedAt = new Date().toISOString();
  const commitRow: Insertable<SyncCoreDb['sync_commits']> = {
    partition_id: partitionId,
    actor_id: actorId,
    client_id: request.clientId,
    client_commit_id: request.clientCommitId,
    created_at: commitCreatedAt,
    meta: null,
    result_json: null,
  };
  let commitSeq =
    (await insertPendingCommit({
      syncTrx,
      dialect,
      commitRow,
    })) ?? 0;
  if (commitSeq === 0) {
    return loadExistingCommitResult({
      trx,
      syncTrx,
      dialect,
      request,
      partitionId,
    });
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
  const savepointName = `sync_apply_${commitSeq}`;
  const useSavepoints = shouldUseSavepoints({
    dialect,
    handlers,
    operations: ops,
  });
  let savepointCreated = false;

  try {
    if (useSavepoints) {
      await sql.raw(`SAVEPOINT ${savepointName}`).execute(trx);
      savepointCreated = true;
    }

    const applied = await applyCommitOperations({
      trx,
      handlers,
      pushPlugins,
      auth: args.auth,
      request,
      actorId,
      commitId,
      commitSeq,
    });

    const appliedResponse: SyncPushResponse = {
      ok: true,
      status: 'applied',
      commitSeq,
      results: applied.results,
    };
    await persistEmittedChanges({
      trx,
      dialect,
      partitionId,
      commitSeq,
      emittedChanges: applied.emittedChanges,
    });
    await persistCommitOutcome({
      trx,
      dialect,
      partitionId,
      commitSeq,
      response: appliedResponse,
      affectedTables: applied.affectedTables,
      emittedChangeCount: applied.emittedChanges.length,
    });

    if (useSavepoints) {
      await sql.raw(`RELEASE SAVEPOINT ${savepointName}`).execute(trx);
    }

    return {
      response: appliedResponse,
      affectedTables: applied.affectedTables,
      scopeKeys: scopeKeysFromEmitted(applied.emittedChanges),
      emittedChanges: applied.emittedChanges,
      commitActorId: actorId,
      commitCreatedAt,
    };
  } catch (error) {
    if (savepointCreated) {
      try {
        await sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`).execute(trx);
        await sql.raw(`RELEASE SAVEPOINT ${savepointName}`).execute(trx);
      } catch (savepointError) {
        console.error(
          '[pushCommit] Savepoint rollback failed:',
          savepointError
        );
        throw savepointError;
      }
    }

    if (!(error instanceof RejectCommitError)) {
      throw error;
    }

    await persistCommitOutcome({
      trx,
      dialect,
      partitionId,
      commitSeq,
      response: error.response,
      affectedTables: [],
      emittedChangeCount: 0,
    });

    return {
      response: error.response,
      affectedTables: [],
      scopeKeys: [],
      emittedChanges: [],
      commitActorId: actorId,
      commitCreatedAt,
    };
  }
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
  suppressTelemetry?: boolean;
}): Promise<PushCommitResult> {
  const { db, dialect, handlers, request } = args;
  const pushPlugins = sortServerPushPlugins(args.plugins);
  const requestedOps = Array.isArray(request.operations)
    ? request.operations
    : [];
  const operationCount = requestedOps.length;
  const startedAtMs = Date.now();
  const suppressTelemetry = args.suppressTelemetry === true;

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

        if (!suppressTelemetry) {
          recordPushMetrics({
            status,
            durationMs,
            operationCount,
            emittedChangeCount: result.emittedChanges.length,
            affectedTableCount: result.affectedTables.length,
          });
        }

        return result;
      };

      try {
        const validationError = validatePushRequest(request);
        if (validationError) {
          return finalizeResult(createRejectedPushResult(validationError));
        }

        return finalizeResult(
          await dialect.executeInTransaction(db, async (trx) =>
            executePushCommitInExecutor({
              trx,
              dialect,
              handlers,
              pushPlugins,
              auth: args.auth,
              request,
            })
          )
        );
      } catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        span.setAttribute('status', 'error');
        span.setAttribute('duration_ms', durationMs);
        span.setStatus('error');

        if (!suppressTelemetry) {
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
        }
        throw error;
      }
    }
  );
}

export async function pushCommitBatch<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<DB, Auth>;
  plugins?: readonly SyncServerPushPlugin<DB, Auth>[];
  auth: Auth;
  requests: SyncPushRequest[];
  suppressTelemetry?: boolean;
}): Promise<PushCommitResult[]> {
  const { db, dialect, handlers, requests } = args;
  const pushPlugins = sortServerPushPlugins(args.plugins);
  const startedAtMs = Date.now();
  const suppressTelemetry = args.suppressTelemetry === true;
  const totalOperationCount = requests.reduce((count, request) => {
    const operations = Array.isArray(request.operations)
      ? request.operations
      : [];
    return count + operations.length;
  }, 0);

  return startSyncSpan(
    {
      name: 'sync.server.push_batch',
      op: 'sync.push.batch',
      attributes: {
        commit_count: requests.length,
        operation_count: totalOperationCount,
      },
    },
    async (span) => {
      try {
        const results = await dialect.executeInTransaction(db, async (trx) => {
          const executed: PushCommitResult[] = [];
          for (const request of requests) {
            const validationError = validatePushRequest(request);
            if (validationError) {
              executed.push(createRejectedPushResult(validationError));
              continue;
            }

            executed.push(
              await executePushCommitInExecutor({
                trx,
                dialect,
                handlers,
                pushPlugins,
                auth: args.auth,
                request,
              })
            );
          }
          return executed;
        });

        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const emittedChangeCount = results.reduce(
          (count, result) => count + result.emittedChanges.length,
          0
        );
        const affectedTableCount = results.reduce(
          (count, result) => count + result.affectedTables.length,
          0
        );
        const status = results.every(
          (result) => result.response.status === 'cached'
        )
          ? 'cached'
          : results.every(
                (result) =>
                  result.response.status === 'applied' ||
                  result.response.status === 'cached'
              )
            ? 'applied'
            : 'rejected';

        span.setAttribute('status', status);
        span.setAttribute('duration_ms', durationMs);
        span.setAttribute('commit_count', results.length);
        span.setAttribute('emitted_change_count', emittedChangeCount);
        span.setAttribute('affected_table_count', affectedTableCount);
        span.setStatus('ok');

        if (!suppressTelemetry) {
          recordPushMetrics({
            status,
            durationMs,
            operationCount: totalOperationCount,
            emittedChangeCount,
            affectedTableCount,
          });
        }

        return results;
      } catch (error) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        span.setAttribute('status', 'error');
        span.setAttribute('duration_ms', durationMs);
        span.setStatus('error');

        if (!suppressTelemetry) {
          recordPushMetrics({
            status: 'error',
            durationMs,
            operationCount: totalOperationCount,
            emittedChangeCount: 0,
            affectedTableCount: 0,
          });
          captureSyncException(error, {
            event: 'sync.server.push_batch',
            commitCount: requests.length,
            operationCount: totalOperationCount,
          });
        }
        throw error;
      }
    }
  );
}
