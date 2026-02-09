/**
 * @syncular/client - Sync outbox (commit-based)
 */

import type { SyncOperation } from '@syncular/core';
import { isRecord, randomId } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { OutboxCommitStatus, SyncClientDb } from './schema';

export interface OutboxCommit {
  id: string;
  client_commit_id: string;
  status: OutboxCommitStatus;
  operations: SyncOperation[];
  last_response_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  attempt_count: number;
  acked_commit_seq: number | null;
  /** Client schema version when commit was created */
  schema_version: number;
}

function isSyncOperation(value: unknown): value is SyncOperation {
  if (!isRecord(value)) return false;
  if (typeof value.table !== 'string') return false;
  if (typeof value.row_id !== 'string') return false;
  if (value.op !== 'upsert' && value.op !== 'delete') return false;
  if (value.payload !== null && !isRecord(value.payload)) return false;
  if (!('base_version' in value)) return true;
  return (
    value.base_version === null ||
    value.base_version === undefined ||
    typeof value.base_version === 'number'
  );
}

function parseOperations(value: unknown): SyncOperation[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const out: SyncOperation[] = [];
  for (const item of parsed) {
    if (!isSyncOperation(item)) continue;
    out.push(item);
  }
  return out;
}

export async function enqueueOutboxCommit<DB extends SyncClientDb>(
  db: Kysely<DB>,
  args: {
    operations: SyncOperation[];
    clientCommitId?: string;
    nowMs?: number;
    /** Client schema version (default: 1) */
    schemaVersion?: number;
  }
): Promise<{ id: string; clientCommitId: string }> {
  const now = args.nowMs ?? Date.now();
  const id = randomId();
  const clientCommitId = args.clientCommitId ?? randomId();
  const schemaVersion = args.schemaVersion ?? 1;

  await sql`
    insert into ${sql.table('sync_outbox_commits')} (
      ${sql.join([
        sql.ref('id'),
        sql.ref('client_commit_id'),
        sql.ref('status'),
        sql.ref('operations_json'),
        sql.ref('last_response_json'),
        sql.ref('error'),
        sql.ref('created_at'),
        sql.ref('updated_at'),
        sql.ref('attempt_count'),
        sql.ref('acked_commit_seq'),
        sql.ref('schema_version'),
      ])}
    ) values (
      ${sql.join([
        sql.val(id),
        sql.val(clientCommitId),
        sql.val('pending'),
        sql.val(JSON.stringify(args.operations ?? [])),
        sql.val(null),
        sql.val(null),
        sql.val(now),
        sql.val(now),
        sql.val(0),
        sql.val(null),
        sql.val(schemaVersion),
      ])}
    )
  `.execute(db);

  return { id, clientCommitId };
}

/**
 * Atomically claim and return the next sendable outbox commit.
 *
 * Uses SELECT then UPDATE with status check to prevent race conditions.
 * If another tab claims the same commit, retries with a different candidate.
 */
export async function getNextSendableOutboxCommit<DB extends SyncClientDb>(
  db: Kysely<DB>,
  options?: { staleTimeoutMs?: number; maxRetries?: number }
): Promise<OutboxCommit | null> {
  const staleTimeoutMs = options?.staleTimeoutMs ?? 30000;
  const maxRetries = options?.maxRetries ?? 3;

  // Track IDs we've already tried to claim (to avoid retrying the same one)
  const attemptedIds = new Set<string>();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const staleThreshold = Date.now() - staleTimeoutMs;
    const now = Date.now();

    // Find a candidate to claim, excluding ones we've already tried
    const attempted = Array.from(attemptedIds);
    const attemptedFilter =
      attempted.length === 0
        ? sql``
        : sql`and ${sql.ref('id')} not in (${sql.join(
            attempted.map((id) => sql.val(id)),
            sql`, `
          )})`;

    const candidateResult = await sql<{ id: string }>`
      select ${sql.ref('id')}
      from ${sql.table('sync_outbox_commits')}
      where (
        ${sql.ref('status')} = ${sql.val('pending')}
        or (
          ${sql.ref('status')} = ${sql.val('sending')}
          and ${sql.ref('updated_at')} < ${sql.val(staleThreshold)}
        )
      )
      ${attemptedFilter}
      order by ${sql.ref('created_at')} asc
      limit ${sql.val(1)}
    `.execute(db);
    const candidate = candidateResult.rows[0];
    if (!candidate) return null;

    attemptedIds.add(candidate.id);

    // Atomically claim the commit using UPDATE...WHERE with status check
    const claimResult = await sql`
      update ${sql.table('sync_outbox_commits')}
      set
        ${sql.ref('status')} = ${sql.val('sending')},
        ${sql.ref('updated_at')} = ${sql.val(now)},
        ${sql.ref('attempt_count')} = ${sql.ref('attempt_count')} + ${sql.val(1)},
        ${sql.ref('error')} = ${sql.val(null)},
        ${sql.ref('last_response_json')} = ${sql.val(null)}
      where ${sql.ref('id')} = ${sql.val(candidate.id)}
        and (
          ${sql.ref('status')} = ${sql.val('pending')}
          or (
            ${sql.ref('status')} = ${sql.val('sending')}
            and ${sql.ref('updated_at')} < ${sql.val(staleThreshold)}
          )
        )
    `.execute(db);

    const claimed = Number(claimResult.numAffectedRows ?? 0) > 0;
    if (claimed) {
      const rowResult = await sql<{
        id: string;
        client_commit_id: string;
        status: OutboxCommitStatus;
        operations_json: string;
        last_response_json: string | null;
        error: string | null;
        created_at: number;
        updated_at: number;
        attempt_count: number;
        acked_commit_seq: number | null;
        schema_version: number | null;
      }>`
        select
          ${sql.ref('id')},
          ${sql.ref('client_commit_id')},
          ${sql.ref('status')},
          ${sql.ref('operations_json')},
          ${sql.ref('last_response_json')},
          ${sql.ref('error')},
          ${sql.ref('created_at')},
          ${sql.ref('updated_at')},
          ${sql.ref('attempt_count')},
          ${sql.ref('acked_commit_seq')},
          ${sql.ref('schema_version')}
        from ${sql.table('sync_outbox_commits')}
        where ${sql.ref('id')} = ${sql.val(candidate.id)}
      `.execute(db);
      const row = rowResult.rows[0];
      if (!row) continue;

      return {
        id: row.id,
        client_commit_id: row.client_commit_id,
        status: row.status,
        operations: parseOperations(row.operations_json),
        last_response_json: row.last_response_json,
        error: row.error,
        created_at: row.created_at,
        updated_at: row.updated_at,
        attempt_count: row.attempt_count,
        acked_commit_seq: row.acked_commit_seq,
        schema_version: row.schema_version ?? 1,
      };
    }

    // Another tab claimed it, retry with next candidate
  }

  return null;
}

async function markOutboxCommitSending<DB extends SyncClientDb>(
  db: Kysely<DB>,
  id: string
): Promise<void> {
  const now = Date.now();

  await sql`
    update ${sql.table('sync_outbox_commits')}
    set
      ${sql.ref('status')} = ${sql.val('sending')},
      ${sql.ref('updated_at')} = ${sql.val(now)},
      ${sql.ref('attempt_count')} = ${sql.ref('attempt_count')} + ${sql.val(1)},
      ${sql.ref('error')} = ${sql.val(null)},
      ${sql.ref('last_response_json')} = ${sql.val(null)}
    where ${sql.ref('id')} = ${sql.val(id)}
  `.execute(db);
}

export async function markOutboxCommitAcked<DB extends SyncClientDb>(
  db: Kysely<DB>,
  args: { id: string; commitSeq?: number | null; responseJson?: string | null }
): Promise<void> {
  const now = Date.now();

  await sql`
    update ${sql.table('sync_outbox_commits')}
    set
      ${sql.ref('status')} = ${sql.val('acked')},
      ${sql.ref('updated_at')} = ${sql.val(now)},
      ${sql.ref('acked_commit_seq')} = ${sql.val(args.commitSeq ?? null)},
      ${sql.ref('error')} = ${sql.val(null)},
      ${sql.ref('last_response_json')} = ${sql.val(args.responseJson ?? null)}
    where ${sql.ref('id')} = ${sql.val(args.id)}
  `.execute(db);
}

export async function markOutboxCommitFailed<DB extends SyncClientDb>(
  db: Kysely<DB>,
  args: { id: string; error: string; responseJson?: string | null }
): Promise<void> {
  const now = Date.now();

  await sql`
    update ${sql.table('sync_outbox_commits')}
    set
      ${sql.ref('status')} = ${sql.val('failed')},
      ${sql.ref('updated_at')} = ${sql.val(now)},
      ${sql.ref('error')} = ${sql.val(args.error)},
      ${sql.ref('last_response_json')} = ${sql.val(args.responseJson ?? null)}
    where ${sql.ref('id')} = ${sql.val(args.id)}
  `.execute(db);
}

export async function markOutboxCommitPending<DB extends SyncClientDb>(
  db: Kysely<DB>,
  args: { id: string; error?: string | null; responseJson?: string | null }
): Promise<void> {
  const now = Date.now();

  await sql`
    update ${sql.table('sync_outbox_commits')}
    set
      ${sql.ref('status')} = ${sql.val('pending')},
      ${sql.ref('updated_at')} = ${sql.val(now)},
      ${sql.ref('error')} = ${sql.val(args.error ?? null)},
      ${sql.ref('last_response_json')} = ${sql.val(args.responseJson ?? null)}
    where ${sql.ref('id')} = ${sql.val(args.id)}
  `.execute(db);
}

async function deleteAckedOutboxCommits<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<number> {
  const res = await sql`
    delete from ${sql.table('sync_outbox_commits')}
    where ${sql.ref('status')} = ${sql.val('acked')}
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

async function deleteFailedOutboxCommits<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<number> {
  const res = await sql`
    delete from ${sql.table('sync_outbox_commits')}
    where ${sql.ref('status')} = ${sql.val('failed')}
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

async function clearAllOutboxCommits<DB extends SyncClientDb>(
  db: Kysely<DB>
): Promise<number> {
  const res =
    await sql`delete from ${sql.table('sync_outbox_commits')}`.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

/**
 * Outbox namespace - organized API for outbox operations.
 *
 * @example
 * ```typescript
 * import { outbox } from '@syncular/client';
 *
 * // Enqueue a new commit
 * const { id } = await outbox.enqueue(db, { operations: [...] });
 *
 * // Get next sendable commit
 * const commit = await outbox.getNextSendable(db);
 *
 * // Mark commit status
 * await outbox.mark.acked(db, { id, commitSeq: 42 });
 * await outbox.mark.failed(db, { id, error: 'Network error' });
 * await outbox.mark.pending(db, { id });
 * await outbox.mark.sending(db, id);
 *
 * // Cleanup commits
 * await outbox.cleanup.acked(db);
 * await outbox.cleanup.failed(db);
 * await outbox.cleanup.all(db);
 * ```
 */
export const outbox = {
  /** Enqueue a new commit to the outbox */
  enqueue: enqueueOutboxCommit,

  /** Get the next sendable commit (atomically claims it) */
  getNextSendable: getNextSendableOutboxCommit,

  /** Mark commit status */
  mark: {
    /** Mark commit as sending (in progress) */
    sending: markOutboxCommitSending,
    /** Mark commit as acknowledged (successfully synced) */
    acked: markOutboxCommitAcked,
    /** Mark commit as failed (permanent error) */
    failed: markOutboxCommitFailed,
    /** Mark commit as pending (ready for retry) */
    pending: markOutboxCommitPending,
  },

  /** Cleanup operations */
  cleanup: {
    /** Delete all acknowledged commits */
    acked: deleteAckedOutboxCommits,
    /** Delete all failed commits */
    failed: deleteFailedOutboxCommits,
    /** Delete all commits (clear entire outbox) */
    all: clearAllOutboxCommits,
  },
} as const;
