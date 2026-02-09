import { beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import type { SyncPullRequest } from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  ensureSyncSchema,
  pull,
  readSnapshotChunk,
  type SyncCoreDb,
  TableRegistry,
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

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
  catalog_items: CatalogItemsTable;
}

interface ClientDb {
  tasks: TasksTable;
  catalog_items: CatalogItemsTable;
}

function decodeNdjsonGzip(bytes: Uint8Array): unknown[] {
  const txt = new TextDecoder().decode(gunzipSync(bytes));
  return txt
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
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

    const shapes = new TableRegistry<ServerDb>();
    shapes.register(tasksHandler);

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
        { id: 's1', shape: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
      ],
    };

    const res = await pull({
      db,
      dialect,
      shapes,
      actorId: 'u1',
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

    const rows = decodeNdjsonGzip(chunk!.body);
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

    const shapes = new TableRegistry<ServerDb>();
    shapes.register(catalogHandler);

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
          shape: 'catalog_items',
          scopes: { catalog_id: 'demo' },
          cursor: -1,
        },
      ],
    };

    const res = await pull({
      db,
      dialect,
      shapes,
      actorId: 'any-actor',
      request,
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.scopes).toEqual({ catalog_id: 'demo' });

    const snapshot = sub.snapshots?.[0];
    const chunkRef = snapshot?.chunks?.[0];
    const chunk = await readSnapshotChunk(db, chunkRef!.id);
    const rows = decodeNdjsonGzip(chunk!.body);

    expect(rows).toEqual([
      { id: 'c1', catalog_id: 'demo', name: 'Demo', server_version: 1 },
    ]);
  });
});
