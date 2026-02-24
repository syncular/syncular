import { describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeSnapshotRows, type SyncPullRequest } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  createServerHandlerCollection,
  ensureSyncSchema,
  pull,
  readSnapshotChunk,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';

interface ProjectsTable {
  id: string;
  user_id: string;
  name: string;
  server_version: number;
}

interface TasksTable {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  server_version: number;
}

interface CatalogItemsTable {
  id: string;
  catalog_id: string;
  name: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  projects: ProjectsTable;
  tasks: TasksTable;
  catalog_items: CatalogItemsTable;
}

interface ClientDb {
  projects: ProjectsTable;
  tasks: TasksTable;
  catalog_items: CatalogItemsTable;
}

function decodeSnapshotRowsGzip(
  bytes: Uint8Array | ReadableStream<Uint8Array>
): unknown[] {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Expected Uint8Array snapshot body in this test');
  }
  return decodeSnapshotRows(gunzipSync(bytes));
}

function expectUint8ArrayBody(
  body: Uint8Array | ReadableStream<Uint8Array>
): Uint8Array {
  if (body instanceof Uint8Array) return body;
  throw new Error('Expected Uint8Array snapshot body in this test');
}

describe('pull bootstrap behavior', () => {
  it('bootstraps dependency tables before the requested table', async () => {
    const db = createDatabase<ServerDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    const dialect = createSqliteServerDialect();
    try {
      await ensureSyncSchema(db, dialect);

      await db.schema
        .createTable('projects')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      await db.schema
        .createTable('tasks')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('project_id', 'text', (col) => col.notNull())
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      await db
        .insertInto('projects')
        .values({
          id: 'p1',
          user_id: 'u1',
          name: 'Project 1',
          server_version: 1,
        })
        .execute();

      await db
        .insertInto('tasks')
        .values({
          id: 't1',
          user_id: 'u1',
          project_id: 'p1',
          title: 'Task 1',
          server_version: 1,
        })
        .execute();

      const projectsHandler = createServerHandler<
        ServerDb,
        ClientDb,
        'projects'
      >({
        table: 'projects',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      });
      const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        dependsOn: ['projects'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      });

      const handlers = createServerHandlerCollection<ServerDb>([
        projectsHandler,
        tasksHandler,
      ]);

      const request: SyncPullRequest = {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      };

      const result = await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request,
      });

      const subscription = result.response.subscriptions[0];
      if (!subscription) {
        throw new Error('Expected subscription response');
      }

      expect(subscription.bootstrap).toBe(true);
      expect(subscription.bootstrapState).toBeNull();
      expect(subscription.snapshots?.map((snapshot) => snapshot.table)).toEqual(
        ['projects', 'tasks']
      );

      const projectChunkId = subscription.snapshots?.[0]?.chunks?.[0]?.id;
      const taskChunkId = subscription.snapshots?.[1]?.chunks?.[0]?.id;
      if (!projectChunkId || !taskChunkId) {
        throw new Error('Expected bootstrap chunks for projects and tasks');
      }

      const projectChunk = await readSnapshotChunk(db, projectChunkId);
      const taskChunk = await readSnapshotChunk(db, taskChunkId);
      if (!projectChunk || !taskChunk) {
        throw new Error('Expected stored snapshot chunks');
      }

      expect(decodeSnapshotRowsGzip(projectChunk.body)).toEqual([
        { id: 'p1', user_id: 'u1', name: 'Project 1', server_version: 1 },
      ]);
      expect(decodeSnapshotRowsGzip(taskChunk.body)).toEqual([
        {
          id: 't1',
          user_id: 'u1',
          project_id: 'p1',
          title: 'Task 1',
          server_version: 1,
        },
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('does not mutate caller-provided scope arrays while generating snapshot cache keys', async () => {
    const db = createDatabase<ServerDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    const dialect = createSqliteServerDialect();
    try {
      await ensureSyncSchema(db, dialect);

      await db.schema
        .createTable('catalog_items')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('catalog_id', 'text', (col) => col.notNull())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      await db
        .insertInto('catalog_items')
        .values([
          { id: 'c1', catalog_id: 'alpha', name: 'Alpha', server_version: 1 },
          { id: 'c2', catalog_id: 'zeta', name: 'Zeta', server_version: 1 },
        ])
        .execute();

      const catalogHandler = createServerHandler<
        ServerDb,
        ClientDb,
        'catalog_items'
      >({
        table: 'catalog_items',
        scopes: ['catalog:{catalog_id}'],
        resolveScopes: async () => ({ catalog_id: '*' }),
      });

      const handlers = createServerHandlerCollection<ServerDb>([
        catalogHandler,
      ]);

      const requestedCatalogs = ['zeta', 'alpha'];
      const request: SyncPullRequest = {
        clientId: 'client-2',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 1,
        subscriptions: [
          {
            id: 'sub-1',
            table: 'catalog_items',
            scopes: { catalog_id: requestedCatalogs },
            cursor: -1,
          },
        ],
      };

      await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request,
      });

      expect(requestedCatalogs).toEqual(['zeta', 'alpha']);
    } finally {
      await db.destroy();
    }
  });

  it('stores bundled bootstrap pages as a single gzip stream', async () => {
    const db = createDatabase<ServerDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    const dialect = createSqliteServerDialect();
    try {
      await ensureSyncSchema(db, dialect);

      await db.schema
        .createTable('tasks')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('project_id', 'text', (col) => col.notNull())
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      await db
        .insertInto('tasks')
        .values([
          {
            id: 't1',
            user_id: 'u1',
            project_id: 'p1',
            title: 'Task 1',
            server_version: 1,
          },
          {
            id: 't2',
            user_id: 'u1',
            project_id: 'p1',
            title: 'Task 2',
            server_version: 1,
          },
        ])
        .execute();

      const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      });

      const handlers = createServerHandlerCollection<ServerDb>([tasksHandler]);

      const request: SyncPullRequest = {
        clientId: 'client-gzip-bundle',
        limitCommits: 10,
        limitSnapshotRows: 1,
        maxSnapshotPages: 2,
        subscriptions: [
          {
            id: 'sub-1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      };

      const result = await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request,
      });

      const subscription = result.response.subscriptions[0];
      if (!subscription) throw new Error('Expected subscription response');
      expect(subscription.bootstrap).toBe(true);
      expect(subscription.snapshots?.length).toBe(1);
      expect(subscription.snapshots?.[0]?.chunks?.length).toBe(1);

      const chunkId = subscription.snapshots?.[0]?.chunks?.[0]?.id;
      if (!chunkId) throw new Error('Expected snapshot chunk id');

      const chunk = await readSnapshotChunk(db, chunkId);
      if (!chunk) throw new Error('Expected stored snapshot chunk');

      const bodyBytes = expectUint8ArrayBody(chunk.body);
      const decompressed = gunzipSync(bodyBytes);
      const normalized = new Uint8Array(gzipSync(decompressed));

      expect(Buffer.from(bodyBytes).equals(Buffer.from(normalized))).toBe(true);
      expect(decodeSnapshotRowsGzip(bodyBytes)).toEqual([
        {
          id: 't1',
          user_id: 'u1',
          project_id: 'p1',
          title: 'Task 1',
          server_version: 1,
        },
        {
          id: 't2',
          user_id: 'u1',
          project_id: 'p1',
          title: 'Task 2',
          server_version: 1,
        },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
