import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase, type SyncPushRequest } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialects/bun-sqlite';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { parseJsonValue } from './dialect/helpers';
import { createServerHandler, createServerHandlerCollection } from './handlers';
import { ensureSyncSchema } from './migrate';
import { pushCommit } from './push';
import type { SyncCoreDb } from './schema';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

interface StringVersionTasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: string;
}

interface StringVersionTestDb extends SyncCoreDb {
  string_tasks: StringVersionTasksTable;
}

interface StringVersionClientDb {
  string_tasks: Omit<StringVersionTasksTable, 'server_version'> & {
    server_version: number;
  };
}

const dialect = createSqliteServerDialect();

describe('push operation result error codes', () => {
  let db: ReturnType<typeof createBunSqliteDialect<TestDb>>;
  let handlers: ReturnType<typeof createServerHandlerCollection<TestDb>>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
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

    handlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('rejects empty commits with a stable sync code', async () => {
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-empty',
        clientCommitId: 'commit-empty',
        schemaVersion: 1,
        operations: [],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.empty_commit',
          error: 'Empty commit',
          retriable: false,
        },
      ],
    });
  });

  it('rejects malformed pushes with sync.invalid_request', async () => {
    const request = {
      clientId: '',
      clientCommitId: 'commit-invalid',
      schemaVersion: 1,
      operations: [],
    } as SyncPushRequest;

    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request,
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.invalid_request',
          error: 'Invalid push request',
          retriable: false,
        },
      ],
    });
  });

  it('surfaces auth lease rejection codes without treating the lease as authorization', async () => {
    const leaseAwareHandlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        authorize: async (ctx) => {
          expect(ctx.actorId).toBe('u1');
          expect(ctx.authLease?.leaseId).toBe('lease-expired');
          if (ctx.authLease?.leaseStatusAtEnqueue === 'expired') {
            return {
              error: 'Auth lease expired',
              code: 'sync.auth_lease_expired',
              retriable: true,
            };
          }
          return true;
        },
      }),
    ]);
    const authLease = {
      leaseId: 'lease-expired',
      leaseExpiresAtMs: 1_779_360_000_000,
      leaseStatusAtEnqueue: 'expired',
      leaseScopeSummaryJson: JSON.stringify({ user_id: ['u1'] }),
    };

    const result = await pushCommit({
      db,
      dialect,
      handlers: leaseAwareHandlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-auth-lease',
        clientCommitId: 'commit-auth-lease-expired',
        schemaVersion: 1,
        authLease,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-auth-lease',
            op: 'upsert',
            payload: { title: 'should not apply', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.auth_lease_expired',
          error: 'Auth lease expired',
          retriable: true,
        },
      ],
    });

    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-auth-lease')
      .executeTakeFirst();
    expect(task).toBeUndefined();

    const commit = await db
      .selectFrom('sync_commits')
      .select(['meta', 'result_json'])
      .where('client_commit_id', '=', 'commit-auth-lease-expired')
      .executeTakeFirstOrThrow();
    expect(parseJsonValue(commit.meta)).toEqual({ authLease });
    expect(parseJsonValue(commit.result_json)).toMatchObject({
      status: 'rejected',
      results: [{ code: 'sync.auth_lease_expired' }],
    });
  });

  it('rejects inserts outside resolved scopes without materializing rows or changes', async () => {
    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-forbidden-insert',
        clientCommitId: 'commit-forbidden-insert',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-forbidden',
            op: 'upsert',
            payload: { title: 'forbidden title', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });

    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-forbidden')
      .executeTakeFirst();
    expect(task).toBeUndefined();

    const changes = await db
      .selectFrom('sync_changes')
      .select(['table', 'row_id'])
      .execute();
    expect(changes).toEqual([]);

    const tableRoutes = await db
      .selectFrom('sync_table_commits')
      .select(['table', 'commit_seq'])
      .execute();
    expect(tableRoutes).toEqual([]);

    const scopeRoutes = await db
      .selectFrom('sync_scope_commits')
      .select(['table', 'scope_key', 'commit_seq'])
      .execute();
    expect(scopeRoutes).toEqual([]);
  });

  it('fails closed when write scope resolution fails', async () => {
    const failingHandlers = createServerHandlerCollection<TestDb>([
      createServerHandler<TestDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async () => {
          throw new Error('scope backend unavailable');
        },
      }),
    ]);

    const result = await pushCommit({
      db,
      dialect,
      handlers: failingHandlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-scope-failure',
        clientCommitId: 'commit-scope-failure',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-scope-failure',
            op: 'upsert',
            payload: { title: 'should not apply', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });

    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-scope-failure')
      .executeTakeFirst();
    expect(task).toBeUndefined();
  });

  it('rejects updates and deletes outside resolved scopes without leaking the row', async () => {
    await db
      .insertInto('tasks')
      .values({
        id: 'task-u2',
        user_id: 'u2',
        title: 'Owned by u2',
        server_version: 3,
      })
      .execute();

    const updateResult = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-forbidden-update',
        clientCommitId: 'commit-forbidden-update',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'stolen title', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(updateResult.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });
    expect(JSON.stringify(updateResult.response)).not.toContain('Owned by u2');

    const deleteResult = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-forbidden-delete',
        clientCommitId: 'commit-forbidden-delete',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'delete',
            base_version: null,
          },
        ],
      },
    });

    expect(deleteResult.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.forbidden',
          error: 'Forbidden',
          retriable: false,
        },
      ],
    });
    expect(JSON.stringify(deleteResult.response)).not.toContain('Owned by u2');

    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-u2')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      id: 'task-u2',
      user_id: 'u2',
      title: 'Owned by u2',
      server_version: 3,
    });

    const changes = await db
      .selectFrom('sync_changes')
      .select(['table', 'row_id'])
      .execute();
    expect(changes).toEqual([]);
  });

  it('stores version conflicts with a stable sync code', async () => {
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-conflict',
        clientCommitId: 'commit-seed',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'server title', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-conflict',
        clientCommitId: 'commit-stale',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'stale title', user_id: 'u1' },
            base_version: 0,
          },
        ],
      },
    });

    expect(result.response).toMatchObject({
      status: 'rejected',
      results: [
        {
          status: 'conflict',
          code: 'sync.version_conflict',
          server_version: 1,
        },
      ],
    });
  });

  it('normalizes driver string versions before emitting realtime changes', async () => {
    await db.schema
      .createTable('string_tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'text', (col) =>
        col.notNull().defaultTo('0')
      )
      .execute();

    const stringDb = db as unknown as ReturnType<
      typeof createBunSqliteDialect<StringVersionTestDb>
    >;
    const stringHandlers = createServerHandlerCollection<StringVersionTestDb>([
      createServerHandler<
        StringVersionTestDb,
        StringVersionClientDb,
        'string_tasks'
      >({
        table: 'string_tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      }),
    ]);

    const inserted = await pushCommit({
      db: stringDb,
      dialect,
      handlers: stringHandlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-string-version',
        clientCommitId: 'commit-string-version-insert',
        schemaVersion: 1,
        operations: [
          {
            table: 'string_tasks',
            row_id: 'task-string-version',
            op: 'upsert',
            payload: { title: 'string version', user_id: 'u1' },
            base_version: null,
          },
        ],
      },
    });

    expect(inserted.emittedChanges).toHaveLength(1);
    expect(inserted.emittedChanges[0]?.row_version).toBe(1);
    expect(inserted.emittedChanges[0]?.row_json).toMatchObject({
      server_version: 1,
    });

    const conflict = await pushCommit({
      db: stringDb,
      dialect,
      handlers: stringHandlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-string-version',
        clientCommitId: 'commit-string-version-conflict',
        schemaVersion: 1,
        operations: [
          {
            table: 'string_tasks',
            row_id: 'task-string-version',
            op: 'upsert',
            payload: { title: 'stale title' },
            base_version: 0,
          },
        ],
      },
    });

    expect(conflict.response.results[0]).toMatchObject({
      status: 'conflict',
      server_version: 1,
      server_row: { server_version: 1 },
    });
  });
});
