/**
 * @syncular/server - External data change notification
 *
 * Creates synthetic commits to notify the sync framework about data changes
 * made outside the normal push flow (e.g., pipeline imports, direct DB writes).
 *
 * The synthetic commit forces affected subscriptions to re-bootstrap on next pull,
 * ensuring clients receive the updated data.
 */

import { randomId, type StoredScopes } from '@syncular/core';
import type { Insertable, Kysely } from 'kysely';
import { coerceNumber, toDialectJsonValue } from './dialect/helpers';
import type { ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';

/**
 * Well-known client_id for external/synthetic commits.
 * Used by the pull handler to detect external data changes.
 */
export const EXTERNAL_CLIENT_ID = '__external__';

export interface NotifyExternalDataChangeArgs<DB extends SyncCoreDb> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  /** Table names that were externally modified. */
  tables: string[];
  /** Partition key. Defaults to 'default'. */
  partitionId?: string;
  /** Actor identifier for the synthetic commit. Defaults to '__external__'. */
  actorId?: string;
}

export interface NotifyExternalDataChangeResult {
  /** The commit_seq of the synthetic commit. */
  commitSeq: number;
  /** Tables that were notified. */
  tables: string[];
  /** Number of snapshot chunks deleted. */
  deletedChunks: number;
}

export interface ExternalRowChange {
  table: string;
  rowId: string;
  op: 'upsert' | 'delete';
  rowJson: unknown | null;
  rowVersion: number | null;
  scopes: StoredScopes;
}

export interface NotifyExternalRowChangesArgs<DB extends SyncCoreDb> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  changes: ExternalRowChange[];
  partitionId?: string;
  actorId?: string;
}

export interface NotifyExternalRowChangesResult {
  commitSeq: number;
  tables: string[];
  changeCount: number;
}

/**
 * Notify the sync framework about external data changes.
 *
 * Inserts a synthetic commit (client_id = '__external__'), clears cached
 * snapshot chunks for the affected tables, and inserts sync_table_commits
 * entries so the pull handler can detect the change.
 *
 * On next pull, subscriptions for affected tables will trigger a re-bootstrap
 * instead of an incremental pull.
 */
export async function notifyExternalDataChange<DB extends SyncCoreDb>(
  args: NotifyExternalDataChangeArgs<DB>
): Promise<NotifyExternalDataChangeResult> {
  const { db, dialect, tables } = args;
  const partitionId = args.partitionId ?? 'default';
  const actorId = args.actorId ?? EXTERNAL_CLIENT_ID;
  const uniqueTables = Array.from(
    new Set(tables.filter((table) => typeof table === 'string'))
  );

  if (uniqueTables.length === 0) {
    throw new Error('notifyExternalDataChange: tables must not be empty');
  }

  return dialect.executeInTransaction(db, async (trx) => {
    type SyncTrx = Pick<
      Kysely<SyncCoreDb>,
      'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
    >;
    const syncTrx = trx as SyncTrx;

    const clientCommitId = `ext_${Date.now()}_${randomId()}`;

    // 1. Insert synthetic commit
    const commitRow: Insertable<SyncCoreDb['sync_commits']> = {
      partition_id: partitionId,
      actor_id: actorId,
      client_id: EXTERNAL_CLIENT_ID,
      client_commit_id: clientCommitId,
      meta: null,
      result_json: toDialectJsonValue(dialect, { ok: true, status: 'applied' }),
      change_count: 0,
      affected_tables: dialect.arrayToDb(uniqueTables) as string[],
    };

    let commitSeq = 0;
    if (dialect.supportsInsertReturning) {
      const insertedCommit = await syncTrx
        .insertInto('sync_commits')
        .values(commitRow)
        .returning(['commit_seq'])
        .executeTakeFirstOrThrow();
      commitSeq = coerceNumber(insertedCommit.commit_seq) ?? 0;
    } else {
      const insertResult = await syncTrx
        .insertInto('sync_commits')
        .values(commitRow)
        .executeTakeFirstOrThrow();
      commitSeq = coerceNumber(insertResult.insertId) ?? 0;
    }

    if (commitSeq <= 0) {
      // Fallback for dialects/drivers that don't provide insertId.
      const inserted = await syncTrx
        .selectFrom('sync_commits')
        .select(['commit_seq'])
        .where('partition_id', '=', partitionId)
        .where('client_id', '=', EXTERNAL_CLIENT_ID)
        .where('client_commit_id', '=', clientCommitId)
        .executeTakeFirstOrThrow();
      commitSeq = Number(inserted.commit_seq);
    }

    // 2. Insert sync_table_commits entries for each affected table
    const tableCommits: Array<Insertable<SyncCoreDb['sync_table_commits']>> =
      uniqueTables.map((table) => ({
        partition_id: partitionId,
        table,
        commit_seq: commitSeq,
      }));

    await syncTrx
      .insertInto('sync_table_commits')
      .values(tableCommits)
      .onConflict((oc) =>
        oc.columns(['partition_id', 'table', 'commit_seq']).doNothing()
      )
      .execute();

    // 3. Delete cached snapshot chunks for affected tables.
    const deletedResult = await syncTrx
      .deleteFrom('sync_snapshot_chunks')
      .where('partition_id', '=', partitionId)
      .where('scope', 'in', uniqueTables)
      .executeTakeFirst();
    const deletedChunks = Number(deletedResult?.numDeletedRows ?? 0);

    return {
      commitSeq,
      tables: uniqueTables,
      deletedChunks,
    };
  });
}

/**
 * Notify the sync framework about external row-level changes without forcing
 * affected subscriptions to re-bootstrap.
 *
 * Use this when the external writer knows the exact changed rows, versions, and
 * scopes. It writes a synthetic incremental commit into the Syncular commit log
 * so subsequent pulls can continue incrementally.
 */
export async function notifyExternalRowChanges<DB extends SyncCoreDb>(
  args: NotifyExternalRowChangesArgs<DB>
): Promise<NotifyExternalRowChangesResult> {
  const { db, dialect, changes } = args;
  const partitionId = args.partitionId ?? 'default';
  const actorId = args.actorId ?? EXTERNAL_CLIENT_ID;
  const normalizedChanges = changes.filter(
    (change) =>
      typeof change.table === 'string' &&
      change.table.length > 0 &&
      typeof change.rowId === 'string' &&
      change.rowId.length > 0
  );

  if (normalizedChanges.length === 0) {
    throw new Error('notifyExternalRowChanges: changes must not be empty');
  }

  return dialect.executeInTransaction(db, async (trx) => {
    type SyncTrx = Pick<
      Kysely<SyncCoreDb>,
      'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
    >;
    const syncTrx = trx as SyncTrx;
    const clientCommitId = `ext_rows_${Date.now()}_${randomId()}`;

    const commitRow: Insertable<SyncCoreDb['sync_commits']> = {
      partition_id: partitionId,
      actor_id: actorId,
      client_id: EXTERNAL_CLIENT_ID,
      client_commit_id: clientCommitId,
      meta: null,
      result_json: null,
      change_count: normalizedChanges.length,
      affected_tables: dialect.arrayToDb(
        Array.from(new Set(normalizedChanges.map((change) => change.table))).sort()
      ) as string[],
    };

    let commitSeq = 0;
    if (dialect.supportsInsertReturning) {
      const insertedCommit = await syncTrx
        .insertInto('sync_commits')
        .values(commitRow)
        .returning(['commit_seq'])
        .executeTakeFirstOrThrow();
      commitSeq = coerceNumber(insertedCommit.commit_seq) ?? 0;
    } else {
      const insertResult = await syncTrx
        .insertInto('sync_commits')
        .values(commitRow)
        .executeTakeFirstOrThrow();
      commitSeq = coerceNumber(insertResult.insertId) ?? 0;
    }

    if (commitSeq <= 0) {
      const inserted = await syncTrx
        .selectFrom('sync_commits')
        .select(['commit_seq'])
        .where('partition_id', '=', partitionId)
        .where('client_id', '=', EXTERNAL_CLIENT_ID)
        .where('client_commit_id', '=', clientCommitId)
        .executeTakeFirstOrThrow();
      commitSeq = Number(inserted.commit_seq);
    }

    const changeRows: Array<Insertable<SyncCoreDb['sync_changes']>> =
      normalizedChanges.map((change) => ({
        partition_id: partitionId,
        commit_seq: commitSeq,
        table: change.table,
        row_id: change.rowId,
        op: change.op,
        row_json: toDialectJsonValue(dialect, change.rowJson),
        row_version: change.rowVersion,
        scopes: dialect.scopesToDb(change.scopes),
      }));

    await syncTrx.insertInto('sync_changes').values(changeRows).execute();

    const affectedTables = Array.from(
      new Set(normalizedChanges.map((change) => change.table))
    ).sort();

    await syncTrx
      .insertInto('sync_table_commits')
      .values(
        affectedTables.map((table) => ({
          partition_id: partitionId,
          table,
          commit_seq: commitSeq,
        }))
      )
      .onConflict((oc) =>
        oc.columns(['partition_id', 'table', 'commit_seq']).doNothing()
      )
      .execute();

    await syncTrx
      .updateTable('sync_commits')
      .set({
        result_json: toDialectJsonValue(dialect, {
          ok: true,
          status: 'applied',
          commitSeq,
          results: [],
        }),
        change_count: normalizedChanges.length,
        affected_tables: dialect.arrayToDb(affectedTables) as string[],
      })
      .where('commit_seq', '=', commitSeq)
      .execute();

    return {
      commitSeq,
      tables: affectedTables,
      changeCount: normalizedChanges.length,
    };
  });
}
