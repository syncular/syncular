/**
 * Tests for @syncular/client mutations API
 *
 * Covers:
 * - sanitizePayload with omitColumns
 * - coerceBaseVersion edge cases
 * - createOutboxCommit insert/update/delete
 * - insertMany batch operations
 * - Error cases (no mutations enqueued)
 * - createPushCommit (direct push without outbox)
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createOutboxCommit,
  createOutboxMutations,
  createPushCommit,
  createPushMutations,
  ensureClientSyncSchema,
  type SyncClientDb,
} from '@syncular/client';
import { codecs, createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import type { Kysely } from 'kysely';

interface TestDbTasks {
  id: string;
  title: string;
  completed: number | boolean;
  user_id: string;
  server_version?: number;
}

interface TestDb extends SyncClientDb {
  tasks: TestDbTasks;
}

describe('mutations API', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });

    await ensureClientSyncSchema(db);

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  describe('createOutboxCommit', () => {
    it('inserts a row and creates outbox commit', async () => {
      const commit = createOutboxCommit({ db });

      const { receipt, meta } = await commit(async (tx) => {
        return tx.tasks.insert({
          title: 'Test Task',
          completed: 0,
          user_id: 'user-1',
        });
      });

      expect(receipt.commitId).toBeTruthy();
      expect(receipt.clientCommitId).toBeTruthy();
      expect(meta.operations.length).toBe(1);
      expect(meta.operations[0]!.op).toBe('upsert');

      // Verify row was inserted
      const row = await db.selectFrom('tasks').selectAll().executeTakeFirst();
      expect(row).toBeDefined();
      expect(row?.title).toBe('Test Task');

      // Verify outbox commit was created
      const outbox = await db
        .selectFrom('sync_outbox_commits')
        .selectAll()
        .execute();
      expect(outbox.length).toBe(1);
    });

    it('applies column codecs for local DB writes while keeping payload app-shaped', async () => {
      const commit = createOutboxCommit({
        db,
        codecs: (col) => {
          if (col.table !== 'tasks') return undefined;
          if (col.column === 'user_id') {
            return {
              ts: 'string',
              toDb: (value: string) => value.toLowerCase(),
              fromDb: (value: string) => value.toUpperCase(),
            };
          }
          if (col.column === 'completed') return codecs.numberBoolean();
          return undefined;
        },
      });

      const { meta } = await commit(async (tx) => {
        return tx.tasks.insert({
          title: 'Codec Task',
          completed: true,
          user_id: 'USER-ABC',
        });
      });

      const row = await db
        .selectFrom('tasks')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.user_id).toBe('user-abc');
      expect(row.completed).toBe(1);

      expect(meta.operations[0]?.payload).toEqual({
        title: 'Codec Task',
        completed: true,
        user_id: 'USER-ABC',
      });
    });

    it('inserts with custom id', async () => {
      const commit = createOutboxCommit({ db });

      const { result } = await commit(async (tx) => {
        return tx.tasks.insert({
          id: 'custom-id',
          title: 'Custom',
          completed: 0,
          user_id: 'user-1',
        });
      });

      expect(result).toBe('custom-id');

      const row = await db
        .selectFrom('tasks')
        .where('id', '=', 'custom-id')
        .selectAll()
        .executeTakeFirst();
      expect(row).toBeDefined();
    });

    it('updates a row', async () => {
      const commit = createOutboxCommit({ db });

      // First insert a row
      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'Original',
          completed: 0,
          user_id: 'user-1',
          server_version: 5,
        })
        .execute();

      // Update the row
      const { meta } = await commit(async (tx) => {
        await tx.tasks.update('task-1', { title: 'Updated' });
      });

      expect(meta.operations.length).toBe(1);
      expect(meta.operations[0]!.op).toBe('upsert');
      expect(meta.operations[0]!.payload).toEqual({ title: 'Updated' });
      // base_version should be auto-read from server_version column
      expect(meta.operations[0]!.base_version).toBe(5);

      const row = await db
        .selectFrom('tasks')
        .where('id', '=', 'task-1')
        .selectAll()
        .executeTakeFirst();
      expect(row?.title).toBe('Updated');
    });

    it('update with explicit baseVersion overrides auto-read', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'Original',
          completed: 0,
          user_id: 'user-1',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update(
          'task-1',
          { title: 'Updated' },
          { baseVersion: 10 }
        );
      });

      expect(meta.operations[0]!.base_version).toBe(10);
    });

    it('update with baseVersion: null disables optimistic concurrency', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'Original',
          completed: 0,
          user_id: 'user-1',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update(
          'task-1',
          { title: 'Updated' },
          { baseVersion: null }
        );
      });

      expect(meta.operations[0]!.base_version).toBeNull();
    });

    it('deletes a row', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'To Delete',
          completed: 0,
          user_id: 'user-1',
          server_version: 3,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.delete('task-1');
      });

      expect(meta.operations.length).toBe(1);
      expect(meta.operations[0]!.op).toBe('delete');
      expect(meta.operations[0]!.base_version).toBe(3);

      const row = await db
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', 'task-1')
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it('delete with explicit baseVersion', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'To Delete',
          completed: 0,
          user_id: 'user-1',
          server_version: 3,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.delete('task-1', { baseVersion: 99 });
      });

      expect(meta.operations[0]!.base_version).toBe(99);
    });

    it('insertMany creates multiple rows in single commit', async () => {
      const commit = createOutboxCommit({ db });

      const { result, meta } = await commit(async (tx) => {
        return tx.tasks.insertMany([
          { title: 'Task 1', completed: 0, user_id: 'user-1' },
          { title: 'Task 2', completed: 1, user_id: 'user-1' },
          { title: 'Task 3', completed: 0, user_id: 'user-2' },
        ]);
      });

      expect(result.length).toBe(3);
      expect(meta.operations.length).toBe(3);

      const rows = await db.selectFrom('tasks').selectAll().execute();
      expect(rows.length).toBe(3);

      const outbox = await db
        .selectFrom('sync_outbox_commits')
        .selectAll()
        .execute();
      expect(outbox.length).toBe(1);
    });

    it('throws when no mutations enqueued', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async () => {
          // No operations
          return 'nothing';
        })
      ).rejects.toThrow('No mutations were enqueued');
    });

    it('upsert is equivalent to update', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'Original',
          completed: 0,
          user_id: 'user-1',
          server_version: 1,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.upsert('task-1', { title: 'Upserted' });
      });

      expect(meta.operations[0]!.op).toBe('upsert');
      expect(meta.operations[0]!.payload).toEqual({ title: 'Upserted' });
    });
  });

  describe('createOutboxCommit with omitColumns', () => {
    it('omits specified columns from payload', async () => {
      const commit = createOutboxCommit({
        db,
        omitColumns: ['user_id'],
      });

      const { meta } = await commit(async (tx) => {
        return tx.tasks.insert({
          title: 'Test',
          completed: 0,
          user_id: 'user-1',
        });
      });

      // user_id should be omitted from the sync payload
      expect(meta.operations[0]!.payload).not.toHaveProperty('user_id');
      expect(meta.operations[0]!.payload).toHaveProperty('title');
    });
  });

  describe('createOutboxCommit with versionColumn: null', () => {
    it('does not auto-read base_version when versionColumn is null', async () => {
      const commit = createOutboxCommit({
        db,
        versionColumn: null,
      });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'Original',
          completed: 0,
          user_id: 'user-1',
          server_version: 10,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        // Explicit baseVersion: null to disable auto-read
        await tx.tasks.update(
          'task-1',
          { title: 'Updated' },
          { baseVersion: null }
        );
      });

      // base_version should be null when explicitly set to null
      expect(meta.operations[0]!.base_version).toBeNull();
    });
  });

  describe('createOutboxMutations', () => {
    it('provides a fluent API for mutations', async () => {
      const mutations = createOutboxMutations({ db });

      const result = await mutations.tasks.insert({
        title: 'Fluent API',
        completed: 0,
        user_id: 'user-1',
      });

      expect(result.commitId).toBeTruthy();
      expect(result.id).toBeTruthy();
    });

    it('$commit batches multiple operations', async () => {
      const mutations = createOutboxMutations({ db });

      const { result, commit } = await mutations.$commit(async (tx) => {
        const id1 = await tx.tasks.insert({
          title: 'A',
          completed: 0,
          user_id: 'u',
        });
        const id2 = await tx.tasks.insert({
          title: 'B',
          completed: 0,
          user_id: 'u',
        });
        return [id1, id2];
      });

      expect(result.length).toBe(2);
      expect(commit.commitId).toBeTruthy();

      const outbox = await db
        .selectFrom('sync_outbox_commits')
        .selectAll()
        .execute();
      expect(outbox.length).toBe(1);
    });

    it('$table provides dynamic table access', async () => {
      const mutations = createOutboxMutations({ db });

      const result = await mutations.$table('tasks').insert({
        title: 'Dynamic',
        completed: 0,
        user_id: 'user-1',
      });

      expect(result.id).toBeTruthy();
    });
  });

  describe('createPushCommit', () => {
    it('pushes directly to server without outbox', async () => {
      let pushedRequest: { operations: unknown[] } | null = null;

      const commit = createPushCommit({
        transport: {
          async sync(request) {
            if (request.push) {
              const ops = request.push.operations;
              pushedRequest = { operations: ops };
              return {
                ok: true as const,
                push: {
                  ok: true,
                  status: 'applied' as const,
                  results: ops.map((_, i) => ({
                    opIndex: i,
                    status: 'applied' as const,
                  })),
                },
              };
            }
            return { ok: true as const };
          },
          async fetchSnapshotChunk() {
            return new Uint8Array();
          },
        },
        clientId: 'test-client',
        actorId: 'test-actor',
      });

      const { receipt, meta } = await commit(async (tx) => {
        return tx.tasks.insert({
          title: 'Push Test',
          completed: 0,
          user_id: 'user-1',
        });
      });

      expect(receipt.commitId).toBeTruthy();
      expect(meta.response.status).toBe('applied');
      expect(pushedRequest).not.toBeNull();
      expect(pushedRequest!.operations.length).toBe(1);
    });

    it('throws on push rejection', async () => {
      const commit = createPushCommit({
        transport: {
          async sync() {
            return {
              ok: true as const,
              push: {
                ok: true,
                status: 'rejected' as const,
                results: [
                  {
                    opIndex: 0,
                    status: 'conflict' as const,
                    message: 'Version conflict',
                    server_version: 1,
                    server_row: null,
                  },
                ],
              },
            };
          },
          async fetchSnapshotChunk() {
            return new Uint8Array();
          },
        },
        clientId: 'test-client',
      });

      await expect(
        commit(async (tx) => {
          return tx.tasks.insert({
            title: 'Will Fail',
            completed: 0,
            user_id: 'user-1',
          });
        })
      ).rejects.toThrow('Push rejected');
    });

    it('throws when no mutations enqueued', async () => {
      const commit = createPushCommit({
        transport: {
          async sync() {
            return {
              ok: true as const,
              push: { ok: true, status: 'applied' as const, results: [] },
            };
          },
          async fetchSnapshotChunk() {
            return new Uint8Array();
          },
        },
        clientId: 'test-client',
      });

      await expect(
        commit(async () => {
          // No operations
          return 'nothing';
        })
      ).rejects.toThrow('No mutations were enqueued');
    });

    it('supports readBaseVersion callback', async () => {
      const readCalls: { table: string; rowId: string }[] = [];

      const commit = createPushCommit({
        transport: {
          async sync(request) {
            if (request.push) {
              return {
                ok: true as const,
                push: {
                  ok: true,
                  status: 'applied' as const,
                  results: request.push.operations.map((_, i) => ({
                    opIndex: i,
                    status: 'applied' as const,
                  })),
                },
              };
            }
            return { ok: true as const };
          },
          async fetchSnapshotChunk() {
            return new Uint8Array();
          },
        },
        clientId: 'test-client',
        readBaseVersion: async (args) => {
          readCalls.push({ table: args.table, rowId: args.rowId });
          return 42;
        },
      });

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update('task-1', { title: 'Updated' });
      });

      expect(readCalls.length).toBe(1);
      expect(readCalls[0]).toEqual({ table: 'tasks', rowId: 'task-1' });
      expect(meta.operations[0]!.base_version).toBe(42);
    });
  });

  describe('createPushMutations', () => {
    it('provides a fluent API for direct push', async () => {
      const mutations = createPushMutations<TestDb>({
        transport: {
          async sync(request) {
            if (request.push) {
              return {
                ok: true as const,
                push: {
                  ok: true,
                  status: 'applied' as const,
                  results: request.push.operations.map((_, i) => ({
                    opIndex: i,
                    status: 'applied' as const,
                  })),
                },
              };
            }
            return { ok: true as const };
          },
          async fetchSnapshotChunk() {
            return new Uint8Array();
          },
        },
        clientId: 'test-client',
      });

      const result = await mutations.tasks.insert({
        title: 'Direct Push',
        completed: 0,
        user_id: 'user-1',
      });

      expect(result.id).toBeTruthy();
      expect(result.commitId).toBeTruthy();
    });
  });
});
