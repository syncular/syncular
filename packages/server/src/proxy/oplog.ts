/**
 * @syncular/server - Oplog Creation
 *
 * Creates sync oplog entries for proxy mutations.
 */

import { randomUUID } from 'node:crypto';
import type { SyncOp } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { ServerSyncDialect } from '../dialect/types';
import type { SyncCoreDb } from '../schema';
import type { ProxyTableHandler } from './types';

/**
 * Generate a random ID for commit tracking.
 */
function generateId(): string {
  return randomUUID();
}

/**
 * Create oplog entries for affected rows.
 *
 * This is called after a mutation to record the changes in the sync oplog,
 * making them visible to sync clients.
 */
export async function createOplogEntries<DB extends SyncCoreDb>(args: {
  trx: Kysely<DB>;
  dialect: ServerSyncDialect;
  actorId: string;
  clientId: string;
  shape: ProxyTableHandler;
  operation: SyncOp;
  rows: Record<string, unknown>[];
}): Promise<{ commitSeq: number; affectedTables: string[] }> {
  const { trx, dialect, actorId, clientId, shape, operation, rows } = args;

  if (rows.length === 0) {
    return { commitSeq: 0, affectedTables: [] };
  }

  const pk = shape.primaryKey ?? 'id';
  const versionCol = shape.versionColumn ?? 'server_version';

  // Create commit record
  const commitResult = await sql<{ commit_seq: number }>`
    insert into ${sql.table('sync_commits')} (
      actor_id,
      client_id,
      client_commit_id,
      meta,
      result_json
    )
    values (
      ${actorId},
      ${clientId},
      ${`proxy:${generateId()}`},
      ${null},
      ${null}
    )
    returning commit_seq
  `.execute(trx);

  const commitRow = commitResult.rows[0];
  if (!commitRow) {
    throw new Error('Failed to insert sync_commits row');
  }
  const commitSeq = Number(commitRow.commit_seq);

  // Compute scopes for all rows and collect changes
  const affectedTablesSet = new Set<string>();
  affectedTablesSet.add(shape.table);

  const changes = rows.map((row) => {
    const scopes = shape.computeScopes(row);

    return {
      commit_seq: commitSeq,
      table: shape.table,
      row_id: String(row[pk]),
      op: operation,
      row_json: operation === 'delete' ? null : row,
      row_version: row[versionCol] != null ? Number(row[versionCol]) : null,
      scopes: dialect.scopesToDb(scopes),
    };
  });

  // Insert changes
  await sql`
	    insert into ${sql.table('sync_changes')} (
	      commit_seq,
	      "table",
	      row_id,
	      op,
	      row_json,
	      row_version,
	      scopes
    )
    values ${sql.join(
      changes.map(
        (c) => sql`(
          ${c.commit_seq},
          ${c.table},
          ${c.row_id},
          ${c.op},
          ${c.row_json},
          ${c.row_version},
          ${c.scopes}
        )`
      ),
      sql`, `
    )}
  `.execute(trx);

  // Update commit with affected tables
  const affectedTables = Array.from(affectedTablesSet);
  const sortedAffectedTables = affectedTables.sort();
  await sql`
    update ${sql.table('sync_commits')}
    set change_count = ${rows.length}, affected_tables = ${sortedAffectedTables}
    where commit_seq = ${commitSeq}
  `.execute(trx);

  // Insert table commits for subscription filtering
  if (affectedTables.length > 0) {
    await sql`
	      insert into ${sql.table('sync_table_commits')} ("table", commit_seq)
	      values ${sql.join(
          sortedAffectedTables.map((table) => sql`(${table}, ${commitSeq})`),
          sql`, `
        )}
	      on conflict ("table", commit_seq) do nothing
	    `.execute(trx);
  }

  return { commitSeq, affectedTables };
}
