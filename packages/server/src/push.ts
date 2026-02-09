import type { SyncPushRequest, SyncPushResponse } from '@syncular/core';
import type {
  Insertable,
  Kysely,
  SelectQueryBuilder,
  SqlBool,
  Updateable,
} from 'kysely';
import { sql } from 'kysely';
import type { ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';
import type { TableRegistry } from './shapes/registry';

// biome-ignore lint/complexity/noBannedTypes: Kysely uses `{}` as the initial "no selected columns yet" marker.
type EmptySelection = {};

export interface PushCommitResult {
  response: SyncPushResponse;
  /**
   * Distinct tables affected by this commit.
   * Empty for rejected commits and for commits that emit no changes.
   */
  affectedTables: string[];
}

class RejectCommitError extends Error {
  constructor(public readonly response: SyncPushResponse) {
    super('REJECT_COMMIT');
    this.name = 'RejectCommitError';
  }
}

async function readCommitAffectedTables<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  dialect: ServerSyncDialect,
  commitSeq: number
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
      .executeTakeFirst();

    const raw = row?.affected_tables;
    return dialect.dbToArray(raw);
  } catch {
    // ignore and fall back to scanning changes (best-effort)
  }

  // Fallback: read from changes using dialect-specific implementation
  return dialect.readAffectedTablesFromChanges(db, commitSeq);
}

export async function pushCommit<DB extends SyncCoreDb>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  shapes: TableRegistry<DB>;
  actorId: string;
  request: SyncPushRequest;
}): Promise<PushCommitResult> {
  const { request, dialect } = args;
  const db = args.db;

  if (!request.clientId || !request.clientCommitId) {
    return {
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
    };
  }

  const ops = request.operations ?? [];
  if (!Array.isArray(ops) || ops.length === 0) {
    return {
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
    };
  }

  return dialect.executeInTransaction(db, async (trx) => {
    type SyncTrx = Pick<
      Kysely<SyncCoreDb>,
      'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
    >;

    const syncTrx = trx as SyncTrx;

    // Clean up any stale commit row with null result_json.
    // This can happen when a previous push inserted the commit row but crashed
    // before writing the result (e.g., on D1 without transaction support).
    await syncTrx
      .deleteFrom('sync_commits')
      .where('client_id', '=', request.clientId)
      .where('client_commit_id', '=', request.clientCommitId)
      .where('result_json', 'is', null)
      .execute();

    // Insert commit row (idempotency key)
    const commitRow: Insertable<SyncCoreDb['sync_commits']> = {
      actor_id: args.actorId,
      client_id: request.clientId,
      client_commit_id: request.clientCommitId,
      meta: null,
      result_json: null,
    };

    const insertResult = await syncTrx
      .insertInto('sync_commits')
      .values(commitRow)
      .onConflict((oc) =>
        oc.columns(['client_id', 'client_commit_id']).doNothing()
      )
      .executeTakeFirstOrThrow();

    const insertedRows = Number(insertResult.numInsertedOrUpdatedRows ?? 0);
    if (insertedRows === 0) {
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
        .where('client_id', '=', request.clientId)
        .where('client_commit_id', '=', request.clientCommitId);

      if (dialect.supportsForUpdate) {
        query = query.forUpdate();
      }

      const existing = await query.executeTakeFirstOrThrow();

      const cached = existing.result_json as SyncPushResponse | null;
      if (!cached || cached.ok !== true) {
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
        };
      }

      const base: SyncPushResponse = {
        ...cached,
        commitSeq: Number(existing.commit_seq),
      };

      if (cached.status === 'applied') {
        const tablesFromDb = dialect.dbToArray(existing.affected_tables);
        return {
          response: { ...base, status: 'cached' },
          affectedTables:
            tablesFromDb.length > 0
              ? tablesFromDb
              : await readCommitAffectedTables(
                  trx,
                  dialect,
                  Number(existing.commit_seq)
                ),
        };
      }

      return { response: base, affectedTables: [] };
    }

    const insertedCommit = await (
      syncTrx.selectFrom('sync_commits') as SelectQueryBuilder<
        SyncCoreDb,
        'sync_commits',
        EmptySelection
      >
    )
      .selectAll()
      .where('client_id', '=', request.clientId)
      .where('client_commit_id', '=', request.clientCommitId)
      .executeTakeFirstOrThrow();

    const commitSeq = Number(insertedCommit.commit_seq);
    const commitId = `${request.clientId}:${request.clientCommitId}`;

    const savepointName = 'sync_apply';
    const useSavepoints = dialect.supportsSavepoints;
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

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        const handler = args.shapes.getOrThrow(op.table);
        const applied = await handler.applyOperation(
          {
            db: trx,
            trx,
            actorId: args.actorId,
            clientId: request.clientId,
            commitId,
            schemaVersion: request.schemaVersion,
          },
          op,
          i
        );

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
              opIndex: i,
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

      if (allEmitted.length > 0) {
        const changeRows: Array<Insertable<SyncCoreDb['sync_changes']>> =
          allEmitted.map((c) => ({
            commit_seq: commitSeq,
            table: c.table,
            row_id: c.row_id,
            op: c.op,
            row_json: c.row_json,
            row_version: c.row_version,
            scopes: dialect.scopesToDb(c.scopes),
          }));

        await syncTrx.insertInto('sync_changes').values(changeRows).execute();
      }

      const appliedResponse: SyncPushResponse = {
        ok: true,
        status: 'applied',
        commitSeq,
        results,
      };

      const affectedTables = Array.from(affectedTablesSet).sort();

      const appliedCommitUpdate: Updateable<SyncCoreDb['sync_commits']> = {
        result_json: appliedResponse,
        change_count: allEmitted.length,
        affected_tables: affectedTables,
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
          table,
          commit_seq: commitSeq,
        }));

        await syncTrx
          .insertInto('sync_table_commits')
          .values(tableCommits)
          .onConflict((oc) => oc.columns(['table', 'commit_seq']).doNothing())
          .execute();
      }

      if (useSavepoints) {
        await sql.raw(`RELEASE SAVEPOINT ${savepointName}`).execute(trx);
      }

      return {
        response: appliedResponse,
        affectedTables,
      };
    } catch (err) {
      // Roll back app writes but keep the commit row.
      if (savepointCreated) {
        try {
          await sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`).execute(trx);
          await sql.raw(`RELEASE SAVEPOINT ${savepointName}`).execute(trx);
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

      const rejectedCommitUpdate: Updateable<SyncCoreDb['sync_commits']> = {
        result_json: err.response,
        change_count: 0,
        affected_tables: [],
      };

      // Persist the rejected response for commit-level idempotency.
      await syncTrx
        .updateTable('sync_commits')
        .set(rejectedCommitUpdate)
        .where('commit_seq', '=', commitSeq)
        .execute();

      return { response: err.response, affectedTables: [] };
    }
  });
}
