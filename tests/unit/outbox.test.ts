/**
 * Tests for @syncular/client outbox API
 *
 * Covers:
 * - enqueueOutboxCommit -> row created with status 'pending', operations JSON
 * - getNextSendableOutboxCommit -> returns oldest pending
 * - getNextSendableOutboxCommit with no candidates -> returns null
 * - Stale reclaim -> 'sending' commit with old updated_at is reclaimed
 * - markOutboxCommitAcked -> status 'acked', commitSeq stored
 * - markOutboxCommitFailed -> status 'failed', error stored
 * - markOutboxCommitPending -> resets to 'pending' for retry
 * - Cleanup: delete acked only
 * - Cleanup: delete failed only
 * - Cleanup: clear all
 * - parseOperations edge cases (tested indirectly via getNextSendable)
 * - isSyncOperation validation (tested indirectly via getNextSendable)
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  ensureClientSyncSchema,
  outbox,
  type SyncClientDb,
} from '@syncular/client';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

let db: Kysely<SyncClientDb>;

beforeEach(async () => {
  db = createDatabase<SyncClientDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
  await ensureClientSyncSchema(db);
});

const validOps = [
  {
    table: 'tasks',
    row_id: 'row-1',
    op: 'upsert' as const,
    payload: { title: 'Hello' },
    base_version: null,
  },
];

describe('outbox', () => {
  describe('enqueueOutboxCommit', () => {
    it('creates a row with status pending and operations JSON', async () => {
      const result = await outbox.enqueue(db, { operations: validOps });

      expect(result.id).toBeTruthy();
      expect(result.clientCommitId).toBeTruthy();

      const rows = await sql<{
        id: string;
        client_commit_id: string;
        status: string;
        operations_json: string;
        attempt_count: number;
        schema_version: number;
      }>`select * from sync_outbox_commits`.execute(db);

      expect(rows.rows.length).toBe(1);
      const row = rows.rows[0]!;
      expect(row.id).toBe(result.id);
      expect(row.client_commit_id).toBe(result.clientCommitId);
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0);
      expect(row.schema_version).toBe(1);

      const parsed = JSON.parse(row.operations_json);
      expect(parsed).toEqual(validOps);
    });

    it('uses custom clientCommitId and schemaVersion when provided', async () => {
      const result = await outbox.enqueue(db, {
        operations: validOps,
        clientCommitId: 'my-commit-id',
        schemaVersion: 42,
      });

      expect(result.clientCommitId).toBe('my-commit-id');

      const rows = await sql<{
        client_commit_id: string;
        schema_version: number;
      }>`select client_commit_id, schema_version from sync_outbox_commits where id = ${result.id}`.execute(
        db
      );
      expect(rows.rows[0]!.client_commit_id).toBe('my-commit-id');
      expect(rows.rows[0]!.schema_version).toBe(42);
    });
  });

  describe('getNextSendableOutboxCommit', () => {
    it('returns the oldest pending commit', async () => {
      const first = await outbox.enqueue(db, {
        operations: validOps,
        nowMs: 1000,
      });
      await outbox.enqueue(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'row-2',
            op: 'delete',
            payload: null,
            base_version: 1,
          },
        ],
        nowMs: 2000,
      });

      const commit = await outbox.getNextSendable(db);

      expect(commit).not.toBeNull();
      expect(commit!.id).toBe(first.id);
      expect(commit!.status).toBe('sending');
      expect(commit!.operations).toEqual(validOps);
      expect(commit!.attempt_count).toBe(1);
    });

    it('returns null when there are no candidates', async () => {
      const commit = await outbox.getNextSendable(db);
      expect(commit).toBeNull();
    });

    it('returns null when all commits are acked or failed', async () => {
      const { id: id1 } = await outbox.enqueue(db, {
        operations: validOps,
      });
      const { id: id2 } = await outbox.enqueue(db, {
        operations: validOps,
      });

      await outbox.mark.acked(db, { id: id1, commitSeq: 1 });
      await outbox.mark.failed(db, { id: id2, error: 'boom' });

      const commit = await outbox.getNextSendable(db);
      expect(commit).toBeNull();
    });

    it('reclaims a stale sending commit', async () => {
      const { id } = await outbox.enqueue(db, {
        operations: validOps,
      });

      // Mark as sending
      await outbox.mark.sending(db, id);

      // Manually backdate the updated_at to simulate staleness
      await sql`update sync_outbox_commits set updated_at = ${Date.now() - 60000} where id = ${id}`.execute(
        db
      );

      // With a short stale timeout, it should be reclaimed
      const commit = await outbox.getNextSendable(db, {
        staleTimeoutMs: 1000,
      });

      expect(commit).not.toBeNull();
      expect(commit!.id).toBe(id);
      expect(commit!.status).toBe('sending');
      // attempt_count should have incremented twice (once from mark.sending, once from reclaim)
      expect(commit!.attempt_count).toBeGreaterThanOrEqual(2);
    });

    it('does NOT reclaim a fresh sending commit', async () => {
      const { id } = await outbox.enqueue(db, {
        operations: validOps,
      });

      // Mark as sending (updates updated_at to now)
      await outbox.mark.sending(db, id);

      // Default staleTimeoutMs is 30s, so a fresh sending commit should not be reclaimed
      const commit = await outbox.getNextSendable(db, {
        staleTimeoutMs: 30000,
      });

      expect(commit).toBeNull();
    });
  });

  describe('mark status transitions', () => {
    it('markOutboxCommitAcked sets status to acked and stores commitSeq', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      await outbox.mark.acked(db, {
        id,
        commitSeq: 42,
        responseJson: '{"ok":true}',
      });

      const rows = await sql<{
        status: string;
        acked_commit_seq: number | null;
        last_response_json: string | null;
        error: string | null;
      }>`select status, acked_commit_seq, last_response_json, error from sync_outbox_commits where id = ${id}`.execute(
        db
      );

      const row = rows.rows[0]!;
      expect(row.status).toBe('acked');
      expect(row.acked_commit_seq).toBe(42);
      expect(row.last_response_json).toBe('{"ok":true}');
      expect(row.error).toBeNull();
    });

    it('markOutboxCommitFailed sets status to failed and stores error', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      await outbox.mark.failed(db, {
        id,
        error: 'Network timeout',
        responseJson: '{"error":"timeout"}',
      });

      const rows = await sql<{
        status: string;
        error: string | null;
        last_response_json: string | null;
      }>`select status, error, last_response_json from sync_outbox_commits where id = ${id}`.execute(
        db
      );

      const row = rows.rows[0]!;
      expect(row.status).toBe('failed');
      expect(row.error).toBe('Network timeout');
      expect(row.last_response_json).toBe('{"error":"timeout"}');
    });

    it('markOutboxCommitPending resets to pending for retry', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      // First mark as failed
      await outbox.mark.failed(db, { id, error: 'Temporary error' });

      // Then reset to pending
      await outbox.mark.pending(db, { id });

      const rows = await sql<{
        status: string;
        error: string | null;
      }>`select status, error from sync_outbox_commits where id = ${id}`.execute(
        db
      );

      const row = rows.rows[0]!;
      expect(row.status).toBe('pending');
      // error is cleared when no error arg is passed
      expect(row.error).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('deletes only acked commits', async () => {
      const { id: ackedId } = await outbox.enqueue(db, {
        operations: validOps,
      });
      const { id: pendingId } = await outbox.enqueue(db, {
        operations: validOps,
      });
      const { id: failedId } = await outbox.enqueue(db, {
        operations: validOps,
      });

      await outbox.mark.acked(db, { id: ackedId, commitSeq: 1 });
      await outbox.mark.failed(db, { id: failedId, error: 'err' });

      const deleted = await outbox.cleanup.acked(db);
      expect(deleted).toBe(1);

      const remaining = await sql<{
        id: string;
      }>`select id from sync_outbox_commits order by created_at`.execute(db);
      expect(remaining.rows.length).toBe(2);
      expect(remaining.rows.map((r) => r.id)).toContain(pendingId);
      expect(remaining.rows.map((r) => r.id)).toContain(failedId);
    });

    it('deletes only failed commits', async () => {
      const { id: ackedId } = await outbox.enqueue(db, {
        operations: validOps,
      });
      const { id: pendingId } = await outbox.enqueue(db, {
        operations: validOps,
      });
      const { id: failedId } = await outbox.enqueue(db, {
        operations: validOps,
      });

      await outbox.mark.acked(db, { id: ackedId, commitSeq: 1 });
      await outbox.mark.failed(db, { id: failedId, error: 'err' });

      const deleted = await outbox.cleanup.failed(db);
      expect(deleted).toBe(1);

      const remaining = await sql<{
        id: string;
      }>`select id from sync_outbox_commits order by created_at`.execute(db);
      expect(remaining.rows.length).toBe(2);
      expect(remaining.rows.map((r) => r.id)).toContain(pendingId);
      expect(remaining.rows.map((r) => r.id)).toContain(ackedId);
    });

    it('clears all commits regardless of status', async () => {
      await outbox.enqueue(db, { operations: validOps });
      const { id: id2 } = await outbox.enqueue(db, { operations: validOps });
      await outbox.enqueue(db, { operations: validOps });

      await outbox.mark.acked(db, { id: id2, commitSeq: 1 });

      const deleted = await outbox.cleanup.all(db);
      expect(deleted).toBe(3);

      const remaining =
        await sql`select count(*) as cnt from sync_outbox_commits`.execute(db);
      expect(Number((remaining.rows[0] as { cnt: number }).cnt)).toBe(0);
    });
  });

  describe('parseOperations / isSyncOperation (indirect)', () => {
    it('returns empty operations for empty string operations_json', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      // Corrupt the operations_json to an empty string (not valid JSON)
      await sql`update sync_outbox_commits set operations_json = '' where id = ${id}`.execute(
        db
      );

      // Reset to pending so getNextSendable can pick it up
      await sql`update sync_outbox_commits set status = 'pending' where id = ${id}`.execute(
        db
      );

      const commit = await outbox.getNextSendable(db);
      expect(commit).not.toBeNull();
      expect(commit!.operations).toEqual([]);
    });

    it('returns empty operations for invalid JSON', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      await sql`update sync_outbox_commits set operations_json = 'not-json' where id = ${id}`.execute(
        db
      );
      await sql`update sync_outbox_commits set status = 'pending' where id = ${id}`.execute(
        db
      );

      const commit = await outbox.getNextSendable(db);
      expect(commit).not.toBeNull();
      expect(commit!.operations).toEqual([]);
    });

    it('returns empty operations for non-array JSON', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      await sql`update sync_outbox_commits set operations_json = '{"not":"array"}' where id = ${id}`.execute(
        db
      );
      await sql`update sync_outbox_commits set status = 'pending' where id = ${id}`.execute(
        db
      );

      const commit = await outbox.getNextSendable(db);
      expect(commit).not.toBeNull();
      expect(commit!.operations).toEqual([]);
    });

    it('filters out invalid operations from the array', async () => {
      const { id } = await outbox.enqueue(db, { operations: validOps });

      // Array with one valid and several invalid items
      const mixedOps = JSON.stringify([
        {},
        { table: 'tasks', row_id: 'r1', op: 'upsert', payload: null },
        { table: 'tasks' },
        { row_id: 'r2', op: 'delete', payload: null },
        'not-an-object',
        42,
      ]);

      await sql`update sync_outbox_commits set operations_json = ${mixedOps} where id = ${id}`.execute(
        db
      );
      await sql`update sync_outbox_commits set status = 'pending' where id = ${id}`.execute(
        db
      );

      const commit = await outbox.getNextSendable(db);
      expect(commit).not.toBeNull();
      // Only the second item is valid (has table, row_id, op, payload)
      expect(commit!.operations.length).toBe(1);
      expect(commit!.operations[0]!.table).toBe('tasks');
      expect(commit!.operations[0]!.row_id).toBe('r1');
    });
  });
});
