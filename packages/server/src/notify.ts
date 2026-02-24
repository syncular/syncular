/**
 * @syncular/server - External data change notification
 *
 * Creates synthetic commits to notify the sync framework about data changes
 * made outside the normal push flow (e.g., pipeline imports, direct DB writes).
 *
 * The synthetic commit forces affected subscriptions to re-bootstrap on next pull,
 * ensuring clients receive the updated data.
 */

import { randomId } from '@syncular/core';
import type { Insertable, Kysely } from 'kysely';
import type { ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';

/**
 * Well-known client_id for external/synthetic commits.
 * Used by the pull handler to detect external data changes.
 */
export const EXTERNAL_CLIENT_ID = '__external__';

function toDialectJsonValue(
  dialect: ServerSyncDialect,
  value: unknown
): unknown {
  if (value === null || value === undefined) return null;
  if (dialect.family === 'sqlite') return JSON.stringify(value);
  return value;
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

  if (tables.length === 0) {
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
      affected_tables: dialect.arrayToDb(tables) as string[],
    };

    const insertResult = await syncTrx
      .insertInto('sync_commits')
      .values(commitRow)
      .executeTakeFirstOrThrow();

    let commitSeq = coerceNumber(insertResult.insertId) ?? 0;
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
      tables.map((table) => ({
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

    // 3. Delete cached snapshot chunks for affected tables
    let deletedChunks = 0;
    for (const table of tables) {
      const result = await syncTrx
        .deleteFrom('sync_snapshot_chunks')
        .where('partition_id', '=', partitionId)
        .where('scope', '=', table)
        .executeTakeFirst();

      deletedChunks += Number(result?.numDeletedRows ?? 0);
    }

    return {
      commitSeq,
      tables,
      deletedChunks,
    };
  });
}
