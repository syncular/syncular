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
import { type Kysely, sql } from 'kysely';

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

  describe('validateTableName rejects SQL injection', () => {
    it('rejects table name with semicolon', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async (tx) => {
          return (tx as any)['tasks; DROP TABLE'].insert({
            title: 'Hack',
            completed: 0,
            user_id: 'u',
          });
        })
      ).rejects.toThrow('Invalid table name');
    });

    it('rejects table name with comment syntax', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async (tx) => {
          return (tx as any)['tasks--'].insert({
            title: 'Hack',
            completed: 0,
            user_id: 'u',
          });
        })
      ).rejects.toThrow('Invalid table name');
    });

    it('rejects empty table name', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async (tx) => {
          return (tx as any)[''].insert({
            title: 'Hack',
            completed: 0,
            user_id: 'u',
          });
        })
      ).rejects.toThrow('Invalid table name');
    });
  });

  describe('validateColumnName rejects invalid names', () => {
    it('rejects column name with spaces', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async (tx) => {
          return tx.tasks.insert({
            title: 'Test',
            completed: 0,
            user_id: 'u',
            'bad column': 'x',
          } as any);
        })
      ).rejects.toThrow('Invalid column name');
    });

    it('rejects column name starting with digit', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async (tx) => {
          return tx.tasks.insert({
            title: 'Test',
            completed: 0,
            user_id: 'u',
            '1abc': 'x',
          } as any);
        })
      ).rejects.toThrow('Invalid column name');
    });
  });

  describe('coerceBaseVersion edge cases', () => {
    it('coerces baseVersion 0 to null', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'T',
          completed: 0,
          user_id: 'u',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update('task-1', { title: 'Up' }, { baseVersion: 0 });
      });

      expect(meta.operations[0]!.base_version).toBeNull();
    });

    it('coerces baseVersion -1 to null', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'T',
          completed: 0,
          user_id: 'u',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update('task-1', { title: 'Up' }, { baseVersion: -1 });
      });

      expect(meta.operations[0]!.base_version).toBeNull();
    });

    it('coerces baseVersion NaN to null', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'T',
          completed: 0,
          user_id: 'u',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update(
          'task-1',
          { title: 'Up' },
          { baseVersion: Number.NaN }
        );
      });

      expect(meta.operations[0]!.base_version).toBeNull();
    });

    it('coerces baseVersion Infinity to null', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'T',
          completed: 0,
          user_id: 'u',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update(
          'task-1',
          { title: 'Up' },
          { baseVersion: Number.POSITIVE_INFINITY }
        );
      });

      expect(meta.operations[0]!.base_version).toBeNull();
    });

    it('coerces string baseVersion "5" to number 5', async () => {
      const commit = createOutboxCommit({ db });

      await db
        .insertInto('tasks')
        .values({
          id: 'task-1',
          title: 'T',
          completed: 0,
          user_id: 'u',
          server_version: 5,
        })
        .execute();

      const { meta } = await commit(async (tx) => {
        await tx.tasks.update(
          'task-1',
          { title: 'Up' },
          { baseVersion: '5' as any }
        );
      });

      expect(meta.operations[0]!.base_version).toBe(5);
    });
  });

  describe('sanitizePayload with empty omitColumns', () => {
    it('returns payload unchanged when omitColumns is empty', async () => {
      const commit = createOutboxCommit({
        db,
        omitColumns: [],
      });

      const { meta } = await commit(async (tx) => {
        return tx.tasks.insert({
          title: 'Keep All',
          completed: 1,
          user_id: 'user-1',
        });
      });

      // With empty omitColumns, all non-id/version columns should be in payload
      expect(meta.operations[0]!.payload).toHaveProperty('title', 'Keep All');
      expect(meta.operations[0]!.payload).toHaveProperty('completed', 1);
      expect(meta.operations[0]!.payload).toHaveProperty('user_id', 'user-1');
    });
  });

  describe('insertMany with empty array', () => {
    it('throws when insertMany receives an empty array', async () => {
      const commit = createOutboxCommit({ db });

      await expect(
        commit(async (tx) => {
          return tx.tasks.insertMany([]);
        })
      ).rejects.toThrow('No mutations were enqueued');
    });
  });

  describe('Codec with null values', () => {
    it('null values pass through codecs untransformed', async () => {
      // Create a table with a nullable column to test codec null passthrough
      await db.schema
        .createTable('notes')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('body', 'text')
        .addColumn('tag', 'text')
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      const codecCalls: { column: string; value: unknown }[] = [];

      const commit = createOutboxCommit({
        db: db as any,
        codecs: (col) => {
          if (col.table !== 'notes') return undefined;
          if (col.column === 'tag') {
            return {
              ts: 'string',
              toDb: (value: string) => {
                codecCalls.push({ column: 'tag', value });
                return value.toUpperCase();
              },
              fromDb: (value: string) => value.toLowerCase(),
            };
          }
          return undefined;
        },
      });

      const { meta } = await commit(async (tx) => {
        return (tx as any).notes.insert({
          body: 'Hello',
          tag: null,
        });
      });

      // The codec's toDb should NOT be called for null values
      const tagCalls = codecCalls.filter((c) => c.column === 'tag');
      expect(tagCalls.length).toBe(0);

      // The payload should still contain the null value (tag is not in omitColumns)
      expect(meta.operations[0]!.payload).toHaveProperty('tag', null);
    });
  });

  describe('custom idColumn and versionColumn', () => {
    it('uses custom column names for id and version', async () => {
      // Create a table with custom column names
      await db.schema
        .createTable('items')
        .addColumn('item_id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('rev', 'integer', (col) => col.notNull().defaultTo(0))
        .execute();

      const commit = createOutboxCommit({
        db: db as any,
        idColumn: 'item_id',
        versionColumn: 'rev',
      });

      // Insert with custom id column
      const { result, meta } = await commit(async (tx) => {
        return (tx as any).items.insert({
          item_id: 'my-item',
          name: 'Widget',
        });
      });

      expect(result).toBe('my-item');
      // The idColumn and versionColumn should be omitted from payload
      expect(meta.operations[0]!.payload).not.toHaveProperty('item_id');
      expect(meta.operations[0]!.payload).not.toHaveProperty('rev');
      expect(meta.operations[0]!.payload).toHaveProperty('name', 'Widget');
      expect(meta.operations[0]!.row_id).toBe('my-item');

      // Verify the row was inserted with the custom id column
      const row = await db
        .selectFrom('items' as any)
        .selectAll()
        .executeTakeFirst();
      expect((row as any)?.item_id).toBe('my-item');
      expect((row as any)?.name).toBe('Widget');
    });

    it('auto-reads base_version from custom versionColumn on update', async () => {
      await db.schema
        .createTable('items')
        .addColumn('item_id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('rev', 'integer', (col) => col.notNull().defaultTo(0))
        .execute();

      await sql`insert into items (item_id, name, rev) values ('i1', 'Old', 7)`.execute(
        db
      );

      const commit = createOutboxCommit({
        db: db as any,
        idColumn: 'item_id',
        versionColumn: 'rev',
      });

      const { meta } = await commit(async (tx) => {
        await (tx as any).items.update('i1', { name: 'New' });
      });

      expect(meta.operations[0]!.base_version).toBe(7);
    });
  });

  describe('plugin priority ordering', () => {
    it('runs beforePush in ascending priority and afterPush in descending priority', async () => {
      const callOrder: string[] = [];

      const commit = createPushCommit({
        transport: {
          async sync(request) {
            if (request.push) {
              callOrder.push('transport');
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
        plugins: [
          {
            name: 'plugin-b',
            priority: 80,
            beforePush: async (_ctx, req) => {
              callOrder.push('b-before');
              return req;
            },
            afterPush: async (_ctx, { response }) => {
              callOrder.push('b-after');
              return response;
            },
          },
          {
            name: 'plugin-a',
            priority: 10,
            beforePush: async (_ctx, req) => {
              callOrder.push('a-before');
              return req;
            },
            afterPush: async (_ctx, { response }) => {
              callOrder.push('a-after');
              return response;
            },
          },
        ],
      });

      await commit(async (tx) => {
        return tx.tasks.insert({
          title: 'Plugin Test',
          completed: 0,
          user_id: 'u',
        });
      });

      // beforePush: ascending priority (a=10 first, then b=80)
      // transport call
      // afterPush: descending priority (b=80 first, then a=10)
      expect(callOrder).toEqual([
        'a-before',
        'b-before',
        'transport',
        'b-after',
        'a-after',
      ]);
    });
  });
});
