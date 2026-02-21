import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SyncChange, SyncTransport } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createBunSqliteDb } from '../../../dialect-bun-sqlite/src';
import type { ClientHandlerCollection } from '../handlers/collection';
import { ensureClientSyncSchema } from '../migrate';
import type { SyncClientDb } from '../schema';
import { SyncEngine } from './SyncEngine';

interface TasksTable {
  id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncClientDb {
  tasks: TasksTable;
}

const noopTransport: SyncTransport = {
  async sync() {
    return {};
  },
  async fetchSnapshotChunk() {
    return new Uint8Array();
  },
};

describe('SyncEngine WS inline apply', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createBunSqliteDb<TestDb>({ path: ':memory:' });
    await ensureClientSyncSchema(db);

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    await db
      .insertInto('tasks')
      .values({
        id: 't1',
        title: 'old',
        server_version: 1,
      })
      .execute();

    await db
      .insertInto('sync_subscription_state')
      .values({
        state_id: 'default',
        subscription_id: 'sub-1',
        table: 'tasks',
        scopes_json: '{}',
        params_json: '{}',
        cursor: 0,
        bootstrap_state_json: null,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('rolls back row updates and cursor when any inline WS change fails', async () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange(ctx, change) {
          if (change.row_id === 'fail') {
            throw new Error('forced apply failure');
          }
          const rowJson =
            change.row_json && typeof change.row_json === 'object'
              ? change.row_json
              : null;
          const title =
            rowJson && 'title' in rowJson ? String(rowJson.title ?? '') : '';
          await sql`
            update ${sql.table('tasks')}
            set
              ${sql.ref('title')} = ${sql.val(title)},
              ${sql.ref('server_version')} = ${sql.val(Number(change.row_version ?? 0))}
            where ${sql.ref('id')} = ${sql.val(change.row_id)}
          `.execute(ctx.trx);
        },
      },
    ];

    const engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-1',
      subscriptions: [],
      stateId: 'default',
    });

    const changes: SyncChange[] = [
      {
        table: 'tasks',
        row_id: 't1',
        op: 'upsert',
        row_json: { id: 't1', title: 'new' },
        row_version: 2,
        scopes: {},
      },
      {
        table: 'tasks',
        row_id: 'fail',
        op: 'upsert',
        row_json: { id: 'fail', title: 'bad' },
        row_version: 1,
        scopes: {},
      },
    ];

    const applyWsDeliveredChanges = Reflect.get(
      engine,
      'applyWsDeliveredChanges'
    );
    if (typeof applyWsDeliveredChanges !== 'function') {
      throw new Error('Expected applyWsDeliveredChanges to be callable');
    }
    const applied = await applyWsDeliveredChanges.call(engine, changes, 10);

    expect(applied).toBe(false);

    const task = await db
      .selectFrom('tasks')
      .select(['title', 'server_version'])
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(task.title).toBe('old');
    expect(task.server_version).toBe(1);

    const state = await db
      .selectFrom('sync_subscription_state')
      .select(['cursor'])
      .where('state_id', '=', 'default')
      .where('subscription_id', '=', 'sub-1')
      .executeTakeFirstOrThrow();
    expect(state.cursor).toBe(0);
  });

  it('returns a bounded inspector snapshot with serializable events', async () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-inspector',
      subscriptions: [],
      stateId: 'default',
    });

    await engine.start();
    await engine.sync();

    const snapshot = await engine.getInspectorSnapshot({ eventLimit: 5 });

    expect(snapshot.version).toBe(1);
    expect(snapshot.generatedAt).toBeGreaterThan(0);
    expect(snapshot.recentEvents.length).toBeLessThanOrEqual(5);
    expect(snapshot.recentEvents.length).toBeGreaterThan(0);

    const first = snapshot.recentEvents[0];
    if (!first) {
      throw new Error('Expected at least one inspector event');
    }
    expect(typeof first.id).toBe('number');
    expect(typeof first.event).toBe('string');
    expect(typeof first.timestamp).toBe('number');
    expect(typeof first.payload).toBe('object');
    expect(snapshot.diagnostics).toBeDefined();
  });

  it('ensures sync schema on start without custom migrate callback', async () => {
    const coldDb = createBunSqliteDb<TestDb>({ path: ':memory:' });
    try {
      await coldDb.schema
        .createTable('tasks')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      const handlers: ClientHandlerCollection<TestDb> = [
        {
          table: 'tasks',
          async applySnapshot() {},
          async clearAll() {},
          async applyChange() {},
        },
      ];

      const engine = new SyncEngine<TestDb>({
        db: coldDb,
        transport: noopTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-migrate',
        subscriptions: [],
      });

      await engine.start();

      const exists = await sql<{ count: number }>`
        select count(*) as count
        from sqlite_master
        where type = 'table' and name = 'sync_subscription_state'
      `.execute(coldDb);

      expect(Number(exists.rows[0]?.count ?? 0)).toBe(1);
    } finally {
      await coldDb.destroy();
    }
  });
});
