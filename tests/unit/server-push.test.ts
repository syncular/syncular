import { beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  createServerHandlerCollection,
  ensureSyncSchema,
  pushCommit,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

describe('pushCommit', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  const makeHandlers = () => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });
    return createServerHandlerCollection<ServerDb>([tasksHandler]);
  };

  beforeEach(async () => {
    db = createDatabase<ServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  // -----------------------------------------------------------
  // Validation
  // -----------------------------------------------------------

  it('rejects missing clientId with INVALID_REQUEST', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: '',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Test', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('rejected');
    expect(result.response.results[0]).toEqual({
      opIndex: 0,
      status: 'error',
      error: 'INVALID_REQUEST',
      code: 'INVALID_REQUEST',
      retriable: false,
    });
  });

  it('rejects missing clientCommitId with INVALID_REQUEST', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: '',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Test', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('rejected');
    expect(result.response.results[0]).toEqual({
      opIndex: 0,
      status: 'error',
      error: 'INVALID_REQUEST',
      code: 'INVALID_REQUEST',
      retriable: false,
    });
  });

  it('rejects empty operations with EMPTY_COMMIT', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [],
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('rejected');
    expect(result.response.results[0]).toEqual({
      opIndex: 0,
      status: 'error',
      error: 'EMPTY_COMMIT',
      code: 'EMPTY_COMMIT',
      retriable: false,
    });
  });

  it('rejects non-array operations with EMPTY_COMMIT', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: 'not-an-array' as never,
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('rejected');
    expect(result.response.results[0]).toEqual({
      opIndex: 0,
      status: 'error',
      error: 'EMPTY_COMMIT',
      code: 'EMPTY_COMMIT',
      retriable: false,
    });
  });

  // -----------------------------------------------------------
  // Successful operations
  // -----------------------------------------------------------

  it('applies a single upsert and writes row + sync_changes', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'My Task', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('applied');
    expect(result.response.results).toEqual([
      { opIndex: 0, status: 'applied' },
    ]);

    // Row is in the tasks table
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-1')
      .executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row!.title).toBe('My Task');
    expect(row!.user_id).toBe('u1');
    expect(row!.server_version).toBe(1);

    // Change is in sync_changes
    const changes = await db
      .selectFrom('sync_changes' as never)
      .selectAll()
      .execute();
    expect(changes.length).toBe(1);
    const change = changes[0] as Record<string, unknown>;
    expect(change.table).toBe('tasks');
    expect(change.row_id).toBe('task-1');
    expect(change.op).toBe('upsert');
  });

  it('applies a single delete and removes the row', async () => {
    const handlers = makeHandlers();

    // First insert a row to delete
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'setup-commit',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-del',
            op: 'upsert',
            payload: { title: 'To Delete', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    // Now delete
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'delete-commit',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-del',
            op: 'delete',
            payload: null,
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('applied');

    // Row no longer exists
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-del')
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  // -----------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------

  it('returns cached status on duplicate clientCommitId with same commitSeq', async () => {
    const handlers = makeHandlers();
    const request = {
      clientId: 'c1',
      clientCommitId: 'idempotent-commit',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks' as const,
          row_id: 'task-idem',
          op: 'upsert' as const,
          payload: { title: 'Idempotent', user_id: 'u1' },
          base_version: null,
        },
      ],
    };

    const first = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request,
    });

    expect(first.response.status).toBe('applied');
    const firstSeq = first.response.commitSeq;

    const second = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request,
    });

    expect(second.response.status).toBe('cached');
    expect(second.response.commitSeq).toBe(firstSeq);
    // Cached responses have empty scopeKeys and emittedChanges
    expect(second.scopeKeys).toEqual([]);
    expect(second.emittedChanges).toEqual([]);
  });

  // -----------------------------------------------------------
  // Multi-operation commit
  // -----------------------------------------------------------

  it('applies multiple operations in a single commit', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'multi-op',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-a',
            op: 'upsert',
            payload: { title: 'Task A', user_id: 'u1' },
            base_version: null,
          },
          {
            table: 'tasks',
            row_id: 'task-b',
            op: 'upsert',
            payload: { title: 'Task B', user_id: 'u1' },
            base_version: null,
          },
          {
            table: 'tasks',
            row_id: 'task-c',
            op: 'upsert',
            payload: { title: 'Task C', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.status).toBe('applied');
    expect(result.response.results).toHaveLength(3);
    for (const r of result.response.results) {
      expect(r.status).toBe('applied');
    }

    // All rows written
    const rows = await db.selectFrom('tasks').selectAll().execute();
    expect(rows).toHaveLength(3);

    // All changes written
    const changes = await db
      .selectFrom('sync_changes' as never)
      .selectAll()
      .execute();
    expect(changes.length).toBe(3);
  });

  // -----------------------------------------------------------
  // Positive commitSeq
  // -----------------------------------------------------------

  it('returns a positive commitSeq on success', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'seq-commit',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-seq',
            op: 'upsert',
            payload: { title: 'Seq Test', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.status).toBe('applied');
    expect(result.response.commitSeq).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------
  // Scope key derivation
  // -----------------------------------------------------------

  it('derives scope keys from emitted changes', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'scope-commit',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-scope',
            op: 'upsert',
            payload: { title: 'Scope Test', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.status).toBe('applied');
    // Scope pattern is 'user:{user_id}', user_id='u1' -> scope key 'user:u1'
    expect(result.scopeKeys).toEqual(['user:u1']);
  });

  // -----------------------------------------------------------
  // Affected tables tracking
  // -----------------------------------------------------------

  it('tracks affected tables sorted and deduplicated', async () => {
    const handlers = makeHandlers();
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'affected-tables-commit',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-at-1',
            op: 'upsert',
            payload: { title: 'AT1', user_id: 'u1' },
            base_version: null,
          },
          {
            table: 'tasks',
            row_id: 'task-at-2',
            op: 'upsert',
            payload: { title: 'AT2', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.status).toBe('applied');
    // Both ops on 'tasks' -> single entry, sorted
    expect(result.affectedTables).toEqual(['tasks']);
  });

  // -----------------------------------------------------------
  // Operation rejection (constraint violation)
  // -----------------------------------------------------------

  it('rejects on constraint violation with no changes persisted', async () => {
    const handlers = makeHandlers();

    // Push an operation with a NOT NULL constraint violation (title: null)
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'constraint-fail',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-fail',
            op: 'upsert',
            payload: { title: null, user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('rejected');
    expect(result.response.results[0]?.status).toBe('error');
    expect(result.affectedTables).toEqual([]);
    expect(result.scopeKeys).toEqual([]);
    expect(result.emittedChanges).toEqual([]);

    // No row was persisted
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-fail')
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
