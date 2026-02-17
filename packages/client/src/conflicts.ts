/**
 * @syncular/client - Sync conflict storage helpers
 */

import type { SyncOperationResult, SyncPushResponse } from '@syncular/core';
import { randomId } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { SyncClientDb } from './schema';

function messageFromResult(
  r: Extract<SyncOperationResult, { status: 'conflict' | 'error' }>
): {
  message: string;
  code: string | null;
  serverVersion: number | null;
  serverRowJson: string | null;
} {
  if (r.status === 'conflict') {
    return {
      message: r.message,
      code: 'CONFLICT',
      serverVersion: r.server_version,
      serverRowJson: JSON.stringify(r.server_row),
    };
  }

  return {
    message: r.error,
    code: r.code ?? null,
    serverVersion: null,
    serverRowJson: null,
  };
}

export async function upsertConflictsForRejectedCommit<DB extends SyncClientDb>(
  db: Kysely<DB>,
  args: {
    outboxCommitId: string;
    clientCommitId: string;
    response: SyncPushResponse;
    nowMs?: number;
  }
): Promise<number> {
  const now = args.nowMs ?? Date.now();

  // Remove any previous conflict rows for this outbox commit.
  await sql`
    delete from ${sql.table('sync_conflicts')}
    where ${sql.ref('outbox_commit_id')} = ${sql.val(args.outboxCommitId)}
  `.execute(db);

  const conflictResults = args.response.results.filter(
    (r) => r.status === 'conflict' || r.status === 'error'
  );

  if (conflictResults.length === 0) return 0;

  const rows = conflictResults.map((r) => {
    const info = messageFromResult(r);
    return {
      id: randomId(),
      outbox_commit_id: args.outboxCommitId,
      client_commit_id: args.clientCommitId,
      op_index: r.opIndex,
      result_status: r.status,
      message: info.message,
      code: info.code,
      server_version: info.serverVersion,
      server_row_json: info.serverRowJson,
      created_at: now,
      resolved_at: null,
      resolution: null,
    };
  });

  const insertColumns = [
    'id',
    'outbox_commit_id',
    'client_commit_id',
    'op_index',
    'result_status',
    'message',
    'code',
    'server_version',
    'server_row_json',
    'created_at',
    'resolved_at',
    'resolution',
  ] as const;

  await sql`
    insert into ${sql.table('sync_conflicts')} (
      ${sql.join(insertColumns.map((c) => sql.ref(c)))}
    ) values ${sql.join(
      rows.map(
        (row) =>
          sql`(${sql.join(
            [
              sql.val(row.id),
              sql.val(row.outbox_commit_id),
              sql.val(row.client_commit_id),
              sql.val(row.op_index),
              sql.val(row.result_status),
              sql.val(row.message),
              sql.val(row.code),
              sql.val(row.server_version),
              sql.val(row.server_row_json),
              sql.val(row.created_at),
              sql.val(row.resolved_at),
              sql.val(row.resolution),
            ],
            sql`, `
          )})`
      ),
      sql`, `
    )}
  `.execute(db);

  return conflictResults.length;
}

export type PendingConflictRow = {
  id: string;
  outbox_commit_id: string;
  client_commit_id: string;
  op_index: number;
  result_status: string;
  message: string;
  code: string | null;
  server_version: number | null;
  server_row_json: string | null;
  created_at: number;
};

export async function listPendingConflicts<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<PendingConflictRow[]> {
  const res = await sql<PendingConflictRow>`
    select
      ${sql.ref('id')},
      ${sql.ref('outbox_commit_id')},
      ${sql.ref('client_commit_id')},
      ${sql.ref('op_index')},
      ${sql.ref('result_status')},
      ${sql.ref('message')},
      ${sql.ref('code')},
      ${sql.ref('server_version')},
      ${sql.ref('server_row_json')},
      ${sql.ref('created_at')}
    from ${sql.table('sync_conflicts')}
    where ${sql.ref('resolved_at')} is null
    order by ${sql.ref('created_at')} desc
  `.execute(db);

  return res.rows;
}

export async function resolveConflict<DB extends SyncClientDb>(
  db: Kysely<DB>,
  args: { id: string; resolution: string; nowMs?: number }
): Promise<void> {
  const now = args.nowMs ?? Date.now();
  await sql`
    update ${sql.table('sync_conflicts')}
    set
      ${sql.ref('resolved_at')} = ${sql.val(now)},
      ${sql.ref('resolution')} = ${sql.val(args.resolution)}
    where ${sql.ref('id')} = ${sql.val(args.id)}
  `.execute(db);
}
