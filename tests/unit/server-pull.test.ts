import { beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { createDatabase, decodeSnapshotRows } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  createServerHandlerCollection,
  ensureSyncSchema,
  pull,
  pushCommit,
  readSnapshotChunk,
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

function decodeSnapshotRowsGzip(
  bytes: Uint8Array | ReadableStream<Uint8Array>
): unknown[] {
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  return decodeSnapshotRows(gunzipSync(bytes));
}

describe('pull', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  const makeHandlers = (
    overrides?: Partial<
      Parameters<typeof createServerHandler<ServerDb, ClientDb, 'tasks'>>[0]
    >
  ) => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      ...overrides,
    });
    return createServerHandlerCollection<ServerDb>([tasksHandler]);
  };

  const pushTask = async (
    handlers: ReturnType<typeof makeHandlers>,
    taskId: string,
    title: string,
    userId = 'u1',
    clientId = 'c1'
  ) => {
    return pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: userId },
      request: {
        clientId,
        clientCommitId: `commit-${taskId}-${Date.now()}-${Math.random()}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: taskId,
            op: 'upsert',
            payload: { title, user_id: userId },
            base_version: null,
          },
        ],
      },
    });
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
  // Empty pull
  // -----------------------------------------------------------

  it('returns empty subscriptions when none are requested', async () => {
    const handlers = makeHandlers();
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [],
      },
    });

    expect(res.response.ok).toBe(true);
    expect(res.response.subscriptions).toEqual([]);
  });

  // -----------------------------------------------------------
  // Bootstrap on cursor -1
  // -----------------------------------------------------------

  it('triggers bootstrap when cursor is -1 and returns snapshot data', async () => {
    const handlers = makeHandlers();

    // Push some data first
    await pushTask(handlers, 'task-1', 'First Task');
    await pushTask(handlers, 'task-2', 'Second Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    expect(res.response.ok).toBe(true);
    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);
    expect(sub.snapshots).toBeDefined();
    expect(sub.snapshots!.length).toBeGreaterThan(0);

    // Read the snapshot chunk and verify it has data
    const snapshot = sub.snapshots![0]!;
    expect(snapshot.table).toBe('tasks');
    expect(snapshot.chunks).toBeDefined();
    expect(snapshot.chunks!.length).toBeGreaterThan(0);

    const chunkRef = snapshot.chunks![0]!;
    const chunk = await readSnapshotChunk(db, chunkRef.id);
    expect(chunk).not.toBeNull();
    const rows = decodeSnapshotRowsGzip(chunk!.body);
    expect(rows.length).toBe(2);
  });

  // -----------------------------------------------------------
  // Bootstrap completion
  // -----------------------------------------------------------

  it('sets bootstrapState to null and status to active when bootstrap completes in one page', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task One');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);
    // When bootstrap completes in one page, bootstrapState should be null
    expect(sub.bootstrapState).toBeNull();

    // The snapshot's last page flag should be true
    const snapshot = sub.snapshots![0]!;
    expect(snapshot.isLastPage).toBe(true);
  });

  // -----------------------------------------------------------
  // Incremental pull
  // -----------------------------------------------------------

  it('returns commits in order for incremental pull', async () => {
    const handlers = makeHandlers();

    // Push three tasks to create three commits
    await pushTask(handlers, 'task-1', 'First');
    await pushTask(handlers, 'task-2', 'Second');
    await pushTask(handlers, 'task-3', 'Third');

    // First do a bootstrap pull to get the cursor
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const bootstrapCursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push more data after bootstrap
    await pushTask(handlers, 'task-4', 'Fourth');
    await pushTask(handlers, 'task-5', 'Fifth');

    // Now do an incremental pull
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: bootstrapCursor,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(false);
    expect(sub.commits.length).toBe(2);

    // Commits should be in ascending order
    expect(sub.commits[0]!.commitSeq).toBeLessThan(sub.commits[1]!.commitSeq);
  });

  // -----------------------------------------------------------
  // No new commits
  // -----------------------------------------------------------

  it('returns empty commits and same cursor when no new data exists', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'First');

    // Bootstrap first
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Pull again with same cursor, no new data
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.commits).toEqual([]);
    expect(sub.nextCursor).toBe(cursor);
  });

  // -----------------------------------------------------------
  // Subscription revocation
  // -----------------------------------------------------------

  it('returns status revoked when resolveScopes returns empty scopes', async () => {
    // Handler with resolveScopes that returns empty (no access)
    const handlers = makeHandlers({
      resolveScopes: async () => ({ user_id: [] }),
    });

    await pushTask(
      makeHandlers(), // use normal handlers to push data
      'task-1',
      'First'
    );

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('revoked');
    expect(sub.scopes).toEqual({});
    expect(sub.commits).toEqual([]);
  });

  // -----------------------------------------------------------
  // Scope filtering
  // -----------------------------------------------------------

  it('returns only data matching the requested scopes', async () => {
    // Use a handler that allows both u1 and u2
    const handlers = makeHandlers({
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    // Push data for u1
    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');

    // Push data for u2 (using separate push with u2 auth)
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u2' },
      request: {
        clientId: 'c2',
        clientCommitId: 'commit-u2-task',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'User 2 Task', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    // Pull for u1 only
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);

    // Read snapshot data - should only contain u1's task
    const snapshot = sub.snapshots![0]!;
    const chunkRef = snapshot.chunks![0]!;
    const chunk = await readSnapshotChunk(db, chunkRef.id);
    const rows = decodeSnapshotRowsGzip(chunk!.body) as TasksTable[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe('u1');
  });

  // -----------------------------------------------------------
  // Deduplication (dedupeRows=true)
  // -----------------------------------------------------------

  it('returns only the latest row version when dedupeRows is true', async () => {
    const handlers = makeHandlers();

    // Push initial task
    await pushTask(handlers, 'task-1', 'Version 1');

    // Bootstrap to get a cursor
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push multiple updates to the same row
    await pushTask(handlers, 'task-1', 'Version 2');
    await pushTask(handlers, 'task-1', 'Version 3');

    // Pull with dedupeRows=true
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        dedupeRows: true,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.bootstrap).toBe(false);

    // With deduplication, only the latest version of task-1 should appear
    const allChanges = sub.commits.flatMap((c) => c.changes);
    const task1Changes = allChanges.filter((c) => c.row_id === 'task-1');
    expect(task1Changes.length).toBe(1);

    // The row should have the latest title
    const rowJson = task1Changes[0]!.row_json as TasksTable;
    expect(rowJson.title).toBe('Version 3');
  });

  // -----------------------------------------------------------
  // Deduplication disabled
  // -----------------------------------------------------------

  it('returns all intermediate changes when dedupeRows is false', async () => {
    const handlers = makeHandlers();

    // Push initial task
    await pushTask(handlers, 'task-1', 'Version 1');

    // Bootstrap to get a cursor
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push multiple updates to the same row
    await pushTask(handlers, 'task-1', 'Version 2');
    await pushTask(handlers, 'task-1', 'Version 3');

    // Pull with dedupeRows=false (default)
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        dedupeRows: false,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.bootstrap).toBe(false);

    // Without deduplication, both updates should appear
    const allChanges = sub.commits.flatMap((c) => c.changes);
    const task1Changes = allChanges.filter((c) => c.row_id === 'task-1');
    expect(task1Changes.length).toBe(2);
  });

  // -----------------------------------------------------------
  // Limit enforcement
  // -----------------------------------------------------------

  it('returns at most limitCommits commits', async () => {
    const handlers = makeHandlers();

    // Push initial data and bootstrap
    await pushTask(handlers, 'task-0', 'Initial');
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push 5 more tasks
    for (let i = 1; i <= 5; i++) {
      await pushTask(handlers, `task-${i}`, `Task ${i}`);
    }

    // Pull with limitCommits=2
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 2,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.commits.length).toBeLessThanOrEqual(2);
  });

  // -----------------------------------------------------------
  // Limit sanitization
  // -----------------------------------------------------------

  it('falls back to defaults for NaN, negative, and Infinity limitCommits', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task 1');

    // Test with NaN
    const resNaN = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: Number.NaN,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    expect(resNaN.response.ok).toBe(true);

    // Test with negative
    const resNeg = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: -5,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    expect(resNeg.response.ok).toBe(true);

    // Test with Infinity
    const resInf = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: Number.POSITIVE_INFINITY,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    expect(resInf.response.ok).toBe(true);
  });

  // -----------------------------------------------------------
  // Multi-subscription pull
  // -----------------------------------------------------------

  it('handles multiple subscriptions with merged effective scopes', async () => {
    // Use a handler that allows all users (wildcard)
    const handlers = makeHandlers({
      resolveScopes: async () => ({ user_id: '*' }),
    });

    // Push data for two users
    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u2' },
      request: {
        clientId: 'c2',
        clientCommitId: 'commit-u2-multi',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'User 2 Task', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    // Pull with two subscriptions for different scopes
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
          {
            id: 's2',
            table: 'tasks',
            scopes: { user_id: 'u2' },
            cursor: -1,
          },
        ],
      },
    });

    expect(res.response.ok).toBe(true);
    expect(res.response.subscriptions.length).toBe(2);

    const sub1 = res.response.subscriptions[0]!;
    const sub2 = res.response.subscriptions[1]!;
    expect(sub1.id).toBe('s1');
    expect(sub2.id).toBe('s2');
    expect(sub1.status).toBe('active');
    expect(sub2.status).toBe('active');

    // effectiveScopes should be merged from both subscriptions
    const mergedUserIds = res.effectiveScopes.user_id;
    expect(mergedUserIds).toBeDefined();
    if (Array.isArray(mergedUserIds)) {
      expect(mergedUserIds).toContain('u1');
      expect(mergedUserIds).toContain('u2');
    }
  });

  // -----------------------------------------------------------
  // Cursor beyond max commit triggers bootstrap
  // -----------------------------------------------------------

  it('triggers bootstrap when cursor is beyond max commit seq', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task 1');

    // Use a cursor far beyond any existing commit
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: 999999,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);
    expect(sub.snapshots).toBeDefined();
  });

  // -----------------------------------------------------------
  // Client cursor tracking
  // -----------------------------------------------------------

  it('tracks minimum nextCursor across active subscriptions as clientCursor', async () => {
    // Use wildcard handler so both scopes are allowed
    const handlers = makeHandlers({
      resolveScopes: async () => ({ user_id: '*' }),
    });

    // Push data for u1 and u2
    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u2' },
      request: {
        clientId: 'c2',
        clientCommitId: 'commit-u2-cursor',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'User 2 Task', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    // First bootstrap subscription s1 (it will get a nextCursor at current maxCommitSeq)
    const bootstrap1 = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });
    const cursor1 = bootstrap1.response.subscriptions[0]!.nextCursor;

    // Push more data
    await pushTask(handlers, 'task-u1-2', 'User 1 Task 2', 'u1');

    // Pull with two subscriptions at different cursors
    // s1 at the bootstrap cursor, s2 starting fresh at -1
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: cursor1,
          },
          {
            id: 's2',
            table: 'tasks',
            scopes: { user_id: 'u2' },
            cursor: -1,
          },
        ],
      },
    });

    const sub1Cursor = res.response.subscriptions[0]!.nextCursor;
    const sub2Cursor = res.response.subscriptions[1]!.nextCursor;

    // clientCursor should be the minimum of the two nextCursors
    expect(res.clientCursor).toBe(Math.min(sub1Cursor, sub2Cursor));
  });

  // -----------------------------------------------------------
  // Bootstrap nextCursor equals asOfCommitSeq
  // -----------------------------------------------------------

  it('sets nextCursor to asOfCommitSeq during bootstrap', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task 1');
    await pushTask(handlers, 'task-2', 'Task 2');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.bootstrap).toBe(true);
    // The nextCursor should be a positive number equal to the maxCommitSeq at the time
    expect(sub.nextCursor).toBeGreaterThan(0);
  });
});
