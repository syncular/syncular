import { beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
  codecs,
  decodeSnapshotRows,
  type SyncPullRequest,
} from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  createServerHandlerCollection,
  ensureSyncSchema,
  InvalidSubscriptionScopeError,
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

interface CatalogItemsTable {
  id: string;
  catalog_id: string;
  name: string;
  server_version: number;
}

interface TaskCodecsTable {
  id: string;
  user_id: string;
  enabled: number;
  metadata: string | { tags: string[] };
  server_version: number;
}

interface TaskCodecsClientTable {
  id: string;
  user_id: string;
  enabled: boolean;
  metadata: { tags: string[] };
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
  catalog_items: CatalogItemsTable;
  task_codecs: TaskCodecsTable;
}

interface ClientDb {
  tasks: TasksTable;
  catalog_items: CatalogItemsTable;
  task_codecs: TaskCodecsClientTable;
}

function decodeSnapshotRowsGzip(
  bytes: Uint8Array | ReadableStream<Uint8Array>
): unknown[] {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Expected Uint8Array snapshot body in this test');
  }
  return decodeSnapshotRows(gunzipSync(bytes));
}

describe('createServerHandler', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  beforeEach(async () => {
    db = createBunSqliteDb<ServerDb>({ path: ':memory:' });
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

    await db.schema
      .createTable('catalog_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('catalog_id', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    await db.schema
      .createTable('task_codecs')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('metadata', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  it('extractScopes uses scope variable names (not patterns)', () => {
    const handler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    expect(handler.extractScopes({ user_id: 'u1' })).toEqual({ user_id: 'u1' });
  });

  it('filters bootstrap snapshots by resolved scope columns', async () => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

    await db
      .insertInto('tasks')
      .values([
        { id: 't1', user_id: 'u1', title: 'u1 task', server_version: 1 },
        { id: 't2', user_id: 'u2', title: 'u2 task', server_version: 1 },
      ])
      .execute();

    const request: SyncPullRequest = {
      clientId: 'c1',
      limitCommits: 10,
      subscriptions: [
        { id: 's1', table: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
      ],
    };

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request,
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);

    const snapshot = sub.snapshots?.[0];
    expect(snapshot?.table).toBe('tasks');

    const chunkRef = snapshot?.chunks?.[0];
    expect(chunkRef?.id).toBeTruthy();

    const chunk = await readSnapshotChunk(db, chunkRef!.id);
    expect(chunk).not.toBeNull();

    const rows = decodeSnapshotRowsGzip(chunk!.body);
    expect(rows).toEqual([
      { id: 't1', user_id: 'u1', title: 'u1 task', server_version: 1 },
    ]);
  });

  it("treats allowed '*' as wildcard for requested scopes", async () => {
    const catalogHandler = createServerHandler<
      ServerDb,
      ClientDb,
      'catalog_items'
    >({
      table: 'catalog_items',
      scopes: ['catalog:{catalog_id}'],
      resolveScopes: async () => ({ catalog_id: '*' }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([catalogHandler]);

    await db
      .insertInto('catalog_items')
      .values([
        { id: 'c1', catalog_id: 'demo', name: 'Demo', server_version: 1 },
        { id: 'c2', catalog_id: 'other', name: 'Other', server_version: 1 },
      ])
      .execute();

    const request: SyncPullRequest = {
      clientId: 'c1',
      limitCommits: 10,
      subscriptions: [
        {
          id: 's1',
          table: 'catalog_items',
          scopes: { catalog_id: 'demo' },
          cursor: -1,
        },
      ],
    };

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'any-actor' },
      request,
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.scopes).toEqual({ catalog_id: 'demo' });

    const snapshot = sub.snapshots?.[0];
    const chunkRef = snapshot?.chunks?.[0];
    const chunk = await readSnapshotChunk(db, chunkRef!.id);
    const rows = decodeSnapshotRowsGzip(chunk!.body);

    expect(rows).toEqual([
      { id: 'c1', catalog_id: 'demo', name: 'Demo', server_version: 1 },
    ]);
  });

  it('applies column codecs in default apply/snapshot paths', async () => {
    const codecsHandler = createServerHandler<
      ServerDb,
      ClientDb,
      'task_codecs'
    >({
      table: 'task_codecs',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      columnCodecs: (col) => {
        if (col.table !== 'task_codecs') return undefined;
        if (col.column === 'enabled') return codecs.numberBoolean();
        if (col.column === 'metadata') {
          return codecs.stringJson<{ tags: string[] }>();
        }
        return undefined;
      },
    });

    const handlers = createServerHandlerCollection<ServerDb>([codecsHandler]);

    const pushResult = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'codec-commit-1',
        schemaVersion: 1,
        operations: [
          {
            table: 'task_codecs',
            row_id: 'tc1',
            op: 'upsert',
            payload: {
              user_id: 'u1',
              enabled: true,
              metadata: { tags: ['alpha', 'beta'] },
            },
            base_version: null,
          },
        ],
      },
    });
    expect(pushResult.response.status).toBe('applied');

    const stored = await db
      .selectFrom('task_codecs')
      .select(['enabled', 'metadata'])
      .where('id', '=', 'tc1')
      .executeTakeFirstOrThrow();
    expect(stored.enabled).toBe(1);
    expect(stored.metadata).toBe('{"tags":["alpha","beta"]}');

    const pullResult = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        limitCommits: 10,
        subscriptions: [
          {
            id: 'codec-sub',
            table: 'task_codecs',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const snapshot = pullResult.response.subscriptions[0]?.snapshots?.[0];
    const chunkRef = snapshot?.chunks?.[0];
    expect(chunkRef?.id).toBeTruthy();

    const chunk = await readSnapshotChunk(db, chunkRef!.id);
    const rows = decodeSnapshotRowsGzip(chunk!.body);
    expect(rows).toEqual([
      {
        id: 'tc1',
        user_id: 'u1',
        enabled: true,
        metadata: { tags: ['alpha', 'beta'] },
        server_version: 1,
      },
    ]);
  });

  it('rejects subscriptions with unknown scope keys', async () => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

    let caught: unknown;
    try {
      await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request: {
          clientId: 'c1',
          limitCommits: 10,
          subscriptions: [
            {
              id: 'bad-sub',
              table: 'tasks',
              scopes: { team_id: 't1' },
              cursor: -1,
            },
          ],
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidSubscriptionScopeError);
    if (caught instanceof Error) {
      expect(caught.message).toContain('team_id');
      expect(caught.message).toContain('requested scopes');
    }
  });

  it('rejects resolveScopes outputs with unknown keys', async () => {
    const untypedScopeDefs: string[] = ['user:{user_id}'];
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: untypedScopeDefs,
      resolveScopes: async (ctx) => ({
        user_id: [ctx.actorId],
        team_id: ['team-1'],
      }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

    let caught: unknown;
    try {
      await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request: {
          clientId: 'c1',
          limitCommits: 10,
          subscriptions: [
            {
              id: 'sub-1',
              table: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
            },
          ],
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidSubscriptionScopeError);
    if (caught instanceof Error) {
      expect(caught.message).toContain('team_id');
      expect(caught.message).toContain('resolveScopes() result');
    }
  });

  it('returns ROW_MISSING error (not 500) for stale base version on missing row', async () => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

    const pushed = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'commit-row-missing',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'missing-row',
            op: 'upsert',
            payload: { completed: 1 },
            base_version: 2,
          },
        ],
      },
    });

    expect(pushed.response.status).toBe('rejected');
    expect(pushed.response.results).toEqual([
      {
        opIndex: 0,
        status: 'error',
        error: 'ROW_NOT_FOUND_FOR_BASE_VERSION',
        code: 'ROW_MISSING',
        retriable: false,
      },
    ]);
  });

  it('returns constraint error in push response instead of throwing', async () => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

    const pushed = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        clientCommitId: 'commit-constraint',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'new-row',
            op: 'upsert',
            payload: { title: null },
            base_version: null,
          },
        ],
      },
    });

    expect(pushed.response.status).toBe('rejected');
    expect(pushed.response.results[0]?.status).toBe('error');
    expect(
      pushed.response.results[0] && 'code' in pushed.response.results[0]
        ? pushed.response.results[0].code
        : undefined
    ).toBe('NOT_NULL_CONSTRAINT');
  });

  it('advances nextCursor when scanned commits do not match requested scopes', async () => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

    // Seed a baseline commit for actor u1 so we can start incremental pull at cursor=1.
    const basePush = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-u1',
        clientCommitId: 'base-u1',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'u1-task-1',
            op: 'upsert',
            payload: { title: 'u1 baseline', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });
    expect(basePush.response.status).toBe('applied');

    // Push commits for another actor that should not match u1's scopes.
    for (let i = 0; i < 3; i += 1) {
      const otherPush = await pushCommit({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u2' },
        request: {
          clientId: 'client-u2',
          clientCommitId: `u2-${i}`,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: `u2-task-${i}`,
              op: 'upsert',
              payload: { title: `u2 ${i}`, user_id: 'u2' },
              base_version: null,
            },
          ],
        },
      });
      expect(otherPush.response.status).toBe('applied');
    }

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-u1',
        limitCommits: 2,
        subscriptions: [
          {
            id: 'my-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: 1,
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0];
    expect(sub?.bootstrap).toBe(false);
    expect(sub?.commits).toEqual([]);
    expect(sub?.nextCursor).toBe(3);
  });
});
