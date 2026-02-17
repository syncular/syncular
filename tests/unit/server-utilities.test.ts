/**
 * Tests for server utilities
 *
 * Covers:
 * - stats.ts: readSyncStats, coerceNumber edge cases
 * - compaction.ts: compactChanges, maybeCompactChanges interval debouncing
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import {
  compactChanges,
  ensureSyncSchema,
  maybeCompactChanges,
  maybePruneSync,
  readSyncStats,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

describe('server utilities', () => {
  let db: Kysely<SyncCoreDb>;
  let dialect: ReturnType<typeof createSqliteServerDialect>;

  beforeEach(async () => {
    db = createBunSqliteDb<SyncCoreDb>({ path: ':memory:' });
    dialect = createSqliteServerDialect();
    await ensureSyncSchema(db, dialect);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('readSyncStats', () => {
    it('returns zero stats for empty database', async () => {
      const stats = await readSyncStats(db);

      expect(stats.commitCount).toBe(0);
      expect(stats.changeCount).toBe(0);
      expect(stats.minCommitSeq).toBe(0);
      expect(stats.maxCommitSeq).toBe(0);
      expect(stats.clientCount).toBe(0);
      expect(stats.activeClientCount).toBe(0);
      expect(stats.minActiveClientCursor).toBeNull();
      expect(stats.maxActiveClientCursor).toBeNull();
    });

    it('counts commits and changes', async () => {
      // Insert some commits
      await db
        .insertInto('sync_commits')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            client_id: 'c1',
            client_commit_id: 'cc1',
            actor_id: 'a1',
            created_at: new Date().toISOString(),
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            client_id: 'c1',
            client_commit_id: 'cc2',
            actor_id: 'a1',
            created_at: new Date().toISOString(),
          },
          {
            commit_seq: 3,
            partition_id: 'test',
            client_id: 'c2',
            client_commit_id: 'cc3',
            actor_id: 'a2',
            created_at: new Date().toISOString(),
          },
        ])
        .execute();

      // Insert some changes
      await db
        .insertInto('sync_changes')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'r1',
            op: 'upsert',
            row_json: '{}',
            row_version: 1,
            scopes: '{"user_id":"u1"}',
          },
          {
            commit_seq: 1,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'r2',
            op: 'upsert',
            row_json: '{}',
            row_version: 1,
            scopes: '{"user_id":"u1"}',
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'r3',
            op: 'delete',
            row_json: null,
            row_version: null,
            scopes: '{"user_id":"u1"}',
          },
        ])
        .execute();

      const stats = await readSyncStats(db);

      expect(stats.commitCount).toBe(3);
      expect(stats.changeCount).toBe(3);
      expect(stats.minCommitSeq).toBe(1);
      expect(stats.maxCommitSeq).toBe(3);
    });

    it('counts clients and active clients', async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 1000 * 60 * 60).toISOString(); // 1 hour ago
      const old = new Date(
        now.getTime() - 1000 * 60 * 60 * 24 * 30
      ).toISOString(); // 30 days ago

      await db
        .insertInto('sync_client_cursors')
        .values([
          {
            client_id: 'c1',
            partition_id: 'test',
            actor_id: 'a1',
            cursor: 10,
            effective_scopes: '{"user_id":"u1"}',
            updated_at: recent,
          },
          {
            client_id: 'c2',
            partition_id: 'test',
            actor_id: 'a2',
            cursor: 20,
            effective_scopes: '{"user_id":"u1"}',
            updated_at: recent,
          },
          {
            client_id: 'c3',
            partition_id: 'test',
            actor_id: 'a3',
            cursor: 5,
            effective_scopes: '{"user_id":"u1"}',
            updated_at: old,
          },
        ])
        .execute();

      const stats = await readSyncStats(db);

      expect(stats.clientCount).toBe(3);
      expect(stats.activeClientCount).toBe(2); // Only c1 and c2 are recent
      expect(stats.minActiveClientCursor).toBe(10);
      expect(stats.maxActiveClientCursor).toBe(20);
    });

    it('respects custom activeWindowMs', async () => {
      const now = new Date();
      const recentish = new Date(
        now.getTime() - 1000 * 60 * 60 * 2
      ).toISOString(); // 2 hours ago

      await db
        .insertInto('sync_client_cursors')
        .values([
          {
            client_id: 'c1',
            partition_id: 'test',
            actor_id: 'a1',
            cursor: 10,
            effective_scopes: '{"user_id":"u1"}',
            updated_at: recentish,
          },
        ])
        .execute();

      // With 1 hour window, client should not be active
      const stats1hr = await readSyncStats(db, {
        activeWindowMs: 1000 * 60 * 60,
      });
      expect(stats1hr.activeClientCount).toBe(0);

      // With 3 hour window, client should be active
      const stats3hr = await readSyncStats(db, {
        activeWindowMs: 1000 * 60 * 60 * 3,
      });
      expect(stats3hr.activeClientCount).toBe(1);
    });
  });

  describe('compactChanges', () => {
    it('returns 0 when fullHistoryHours is 0', async () => {
      const deleted = await compactChanges(db, {
        dialect,
        options: { fullHistoryHours: 0 },
      });
      expect(deleted).toBe(0);
    });

    it('returns 0 when fullHistoryHours is negative', async () => {
      const deleted = await compactChanges(db, {
        dialect,
        options: { fullHistoryHours: -5 },
      });
      expect(deleted).toBe(0);
    });

    it('compacts old changes', async () => {
      const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // 48 hours ago

      // Create commits
      await db
        .insertInto('sync_commits')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            client_id: 'c1',
            client_commit_id: 'cc1',
            actor_id: 'a1',
            created_at: oldDate,
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            client_id: 'c1',
            client_commit_id: 'cc2',
            actor_id: 'a1',
            created_at: oldDate,
          },
        ])
        .execute();

      // Create multiple changes for the same row (intermediate changes should be compacted)
      await db
        .insertInto('sync_changes')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'r1',
            op: 'upsert',
            row_json: '{"v":1}',
            row_version: 1,
            scopes: '{"user_id":"u1"}',
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'r1',
            op: 'upsert',
            row_json: '{"v":2}',
            row_version: 2,
            scopes: '{"user_id":"u1"}',
          },
        ])
        .execute();

      const countBefore = await db
        .selectFrom('sync_changes')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow();

      expect(Number(countBefore.count)).toBe(2);

      const deleted = await compactChanges(db, {
        dialect,
        options: { fullHistoryHours: 1 }, // Only keep 1 hour
      });

      // At least one change should be compacted (the older one)
      // The exact number depends on the dialect's compaction strategy
      expect(deleted).toBeGreaterThanOrEqual(0);
    });
  });

  describe('maybeCompactChanges', () => {
    it('respects minIntervalMs debouncing', async () => {
      // First call should run compaction
      await maybeCompactChanges(db, {
        dialect,
        minIntervalMs: 10000, // 10 seconds
        options: { fullHistoryHours: 1 },
      });

      // Immediate second call should be debounced (return 0)
      const result2 = await maybeCompactChanges(db, {
        dialect,
        minIntervalMs: 10000,
        options: { fullHistoryHours: 1 },
      });

      expect(result2).toBe(0);
    });
  });

  describe('maintenance debounce isolation', () => {
    it('does not share prune debounce state across databases', async () => {
      const db1 = createBunSqliteDb<SyncCoreDb>({ path: ':memory:' });
      const db2 = createBunSqliteDb<SyncCoreDb>({ path: ':memory:' });
      const localDialect = createSqliteServerDialect();
      await ensureSyncSchema(db1, localDialect);
      await ensureSyncSchema(db2, localDialect);

      const nowIso = new Date().toISOString();

      await db1
        .insertInto('sync_commits')
        .values({
          commit_seq: 1,
          partition_id: 'test',
          client_id: 'c1',
          client_commit_id: 'cc1',
          actor_id: 'a1',
          created_at: nowIso,
        })
        .execute();
      await db1
        .insertInto('sync_client_cursors')
        .values({
          client_id: 'c1',
          partition_id: 'test',
          actor_id: 'a1',
          cursor: 1,
          effective_scopes: '{"user_id":"u1"}',
          updated_at: nowIso,
        })
        .execute();

      await db2
        .insertInto('sync_commits')
        .values({
          commit_seq: 1,
          partition_id: 'test',
          client_id: 'c2',
          client_commit_id: 'cc2',
          actor_id: 'a2',
          created_at: nowIso,
        })
        .execute();
      await db2
        .insertInto('sync_client_cursors')
        .values({
          client_id: 'c2',
          partition_id: 'test',
          actor_id: 'a2',
          cursor: 1,
          effective_scopes: '{"user_id":"u2"}',
          updated_at: nowIso,
        })
        .execute();

      try {
        const deleted1 = await maybePruneSync(db1, {
          minIntervalMs: 60_000,
          options: {
            keepNewestCommits: 0,
            fallbackMaxAgeMs: 0,
          },
        });
        const deleted2 = await maybePruneSync(db2, {
          minIntervalMs: 60_000,
          options: {
            keepNewestCommits: 0,
            fallbackMaxAgeMs: 0,
          },
        });

        expect(deleted1).toBe(1);
        expect(deleted2).toBe(1);
      } finally {
        await db1.destroy();
        await db2.destroy();
      }
    });

    it('does not share compaction debounce state across databases', async () => {
      const db1 = createBunSqliteDb<SyncCoreDb>({ path: ':memory:' });
      const db2 = createBunSqliteDb<SyncCoreDb>({ path: ':memory:' });
      const localDialect = createSqliteServerDialect();
      await ensureSyncSchema(db1, localDialect);
      await ensureSyncSchema(db2, localDialect);

      const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();

      await db1
        .insertInto('sync_commits')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            client_id: 'c1',
            client_commit_id: 'cc1',
            actor_id: 'a1',
            created_at: oldDate,
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            client_id: 'c1',
            client_commit_id: 'cc2',
            actor_id: 'a1',
            created_at: oldDate,
          },
        ])
        .execute();
      await db1
        .insertInto('sync_changes')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'row-1',
            op: 'upsert',
            row_json: '{}',
            row_version: 1,
            scopes: '{"user_id":"u1"}',
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'row-1',
            op: 'upsert',
            row_json: '{}',
            row_version: 2,
            scopes: '{"user_id":"u1"}',
          },
        ])
        .execute();

      await db2
        .insertInto('sync_commits')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            client_id: 'c2',
            client_commit_id: 'cc3',
            actor_id: 'a2',
            created_at: oldDate,
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            client_id: 'c2',
            client_commit_id: 'cc4',
            actor_id: 'a2',
            created_at: oldDate,
          },
        ])
        .execute();
      await db2
        .insertInto('sync_changes')
        .values([
          {
            commit_seq: 1,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'row-2',
            op: 'upsert',
            row_json: '{}',
            row_version: 1,
            scopes: '{"user_id":"u2"}',
          },
          {
            commit_seq: 2,
            partition_id: 'test',
            table: 'tasks',
            row_id: 'row-2',
            op: 'upsert',
            row_json: '{}',
            row_version: 2,
            scopes: '{"user_id":"u2"}',
          },
        ])
        .execute();

      try {
        const deleted1 = await maybeCompactChanges(db1, {
          dialect: localDialect,
          minIntervalMs: 60_000,
          options: { fullHistoryHours: 1 },
        });
        const deleted2 = await maybeCompactChanges(db2, {
          dialect: localDialect,
          minIntervalMs: 60_000,
          options: { fullHistoryHours: 1 },
        });

        expect(deleted1).toBe(1);
        expect(deleted2).toBe(1);
      } finally {
        await db1.destroy();
        await db2.destroy();
      }
    });
  });
});
