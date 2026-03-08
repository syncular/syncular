import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase, type SyncTransport } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { Client } from './client';
import { SyncEngine } from './engine/SyncEngine';
import type { ClientHandlerCollection } from './handlers/collection';
import { ensureClientSyncSchema } from './migrate';
import type { SyncClientDb } from './schema';

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

describe('Client conflict events', () => {
  let db: Kysely<TestDb>;
  let client: Client<TestDb>;
  let engine: SyncEngine<TestDb>;

  async function seedConflict(id: string): Promise<void> {
    const now = Date.now();
    await sql`
      insert into ${sql.table('sync_outbox_commits')} (
        ${sql.ref('id')},
        ${sql.ref('client_commit_id')},
        ${sql.ref('status')},
        ${sql.ref('operations_json')},
        ${sql.ref('last_response_json')},
        ${sql.ref('error')},
        ${sql.ref('created_at')},
        ${sql.ref('updated_at')},
        ${sql.ref('attempt_count')},
        ${sql.ref('acked_commit_seq')},
        ${sql.ref('schema_version')}
      ) values (
        ${'outbox-1'},
        ${'commit-1'},
        ${'failed'},
        ${JSON.stringify([
          {
            table: 'tasks',
            row_id: 't1',
            op: 'upsert',
            payload: { id: 't1', title: 'local', server_version: 1 },
          },
        ])},
        ${null},
        ${'conflict'},
        ${now},
        ${now},
        ${1},
        ${null},
        ${1}
      )
    `.execute(db);

    await sql`
      insert into ${sql.table('sync_conflicts')} (
        ${sql.ref('id')},
        ${sql.ref('outbox_commit_id')},
        ${sql.ref('client_commit_id')},
        ${sql.ref('op_index')},
        ${sql.ref('result_status')},
        ${sql.ref('message')},
        ${sql.ref('code')},
        ${sql.ref('server_version')},
        ${sql.ref('server_row_json')},
        ${sql.ref('created_at')},
        ${sql.ref('resolved_at')},
        ${sql.ref('resolution')}
      ) values (
        ${id},
        ${'outbox-1'},
        ${'commit-1'},
        ${0},
        ${'conflict'},
        ${'server conflict'},
        ${'CONFLICT'},
        ${2},
        ${JSON.stringify({ id: 't1', title: 'server', server_version: 2 })},
        ${now},
        ${null},
        ${null}
      )
    `.execute(db);
  }

  async function runConflictCheck(
    engineInstance: SyncEngine<TestDb>
  ): Promise<void> {
    const checker = Reflect.get(engineInstance, 'emitNewConflicts');
    if (typeof checker !== 'function') {
      throw new Error('Expected emitNewConflicts to be callable');
    }
    await checker.call(engineInstance);
  }

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
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    const handlers: ClientHandlerCollection<TestDb> = [];
    client = new Client<TestDb>({
      db,
      transport: noopTransport,
      tableHandlers: handlers,
      clientId: 'client-1',
      actorId: 'u1',
      subscriptions: [],
    });

    engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers: handlers,
      actorId: 'u1',
      clientId: 'client-1',
      subscriptions: [],
    });
    Reflect.set(client, 'engine', engine);
    const wireEngineEvents = Reflect.get(client, 'wireEngineEvents');
    if (typeof wireEngineEvents !== 'function') {
      throw new Error('Expected wireEngineEvents to be callable');
    }
    wireEngineEvents.call(client);
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('emits conflict:resolved with the resolved conflict payload', async () => {
    await seedConflict('conflict-1');

    const resolvedEvents: Array<{ id: string }> = [];
    client.on('conflict:resolved', (conflict) => {
      resolvedEvents.push({ id: conflict.id });
    });

    await client.resolveConflict('conflict-1', { strategy: 'keep-local' });

    expect(resolvedEvents).toEqual([{ id: 'conflict-1' }]);

    const resolvedRow = await sql<{ resolved_at: number | null }>`
      select ${sql.ref('resolved_at')}
      from ${sql.table('sync_conflicts')}
      where ${sql.ref('id')} = ${'conflict-1'}
      limit 1
    `.execute(db);
    expect(resolvedRow.rows[0]?.resolved_at).not.toBeNull();
  });

  it('emits conflict:new only once per unresolved conflict id', async () => {
    await seedConflict('conflict-1');

    const newEvents: string[] = [];
    client.on('conflict:new', (conflict) => {
      newEvents.push(conflict.id);
    });

    await runConflictCheck(engine);
    await runConflictCheck(engine);

    expect(newEvents).toEqual(['conflict-1']);
  });

  it('forwards push:result events from the engine', () => {
    const pushResults: Array<{ clientCommitId: string; status: string }> = [];
    client.on('push:result', (result) => {
      pushResults.push({
        clientCommitId: result.clientCommitId,
        status: result.status,
      });
    });

    const emit = Reflect.get(engine, 'emit');
    if (typeof emit !== 'function') {
      throw new Error('Expected SyncEngine.emit to be callable');
    }

    emit.call(engine, 'push:result', {
      outboxCommitId: 'outbox-1',
      clientCommitId: 'commit-1',
      status: 'rejected',
      commitSeq: null,
      results: [],
      errorCode: 'CONFLICT',
      timestamp: Date.now(),
    });

    expect(pushResults).toEqual([
      {
        clientCommitId: 'commit-1',
        status: 'rejected',
      },
    ]);
  });
});

describe('Client local mutation sync scheduling', () => {
  let db: Kysely<TestDb>;
  let client: Client<TestDb>;

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
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    client = new Client<TestDb>({
      db,
      transport: noopTransport,
      tableHandlers: [],
      clientId: 'client-sync-after-mutation',
      actorId: 'u1',
      subscriptions: [],
    });
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('schedules a background local-trigger sync after low-level mutations when started', async () => {
    const syncCalls: Array<{ trigger?: 'ws' | 'local' | 'poll' }> = [];

    Reflect.set(client, 'engine', {
      getState: () => ({
        enabled: true,
        isSyncing: false,
        connectionState: 'connected',
        transportMode: 'realtime',
        lastSyncAt: null,
        error: null,
        pendingCount: 0,
        retryCount: 0,
        isRetrying: false,
      }),
      sync: async (opts?: { trigger?: 'ws' | 'local' | 'poll' }) => {
        syncCalls.push(opts ?? {});
        return {
          success: true,
          pushedCommits: 0,
          pullRounds: 0,
          pullResponse: { ok: true, subscriptions: [] },
          error: null,
        };
      },
      destroy: () => {},
    });
    Reflect.set(client, 'started', true);

    await client.mutations.tasks.insert({ title: 'queued task' });

    expect(syncCalls).toEqual([{ trigger: 'local' }]);
  });

  it('does not schedule a background sync while retry backoff is active', async () => {
    const syncCalls: Array<{ trigger?: 'ws' | 'local' | 'poll' }> = [];

    Reflect.set(client, 'engine', {
      getState: () => ({
        enabled: true,
        isSyncing: false,
        connectionState: 'connected',
        transportMode: 'realtime',
        lastSyncAt: null,
        error: null,
        pendingCount: 1,
        retryCount: 1,
        isRetrying: true,
      }),
      sync: async (opts?: { trigger?: 'ws' | 'local' | 'poll' }) => {
        syncCalls.push(opts ?? {});
        return {
          success: true,
          pushedCommits: 0,
          pullRounds: 0,
          pullResponse: { ok: true, subscriptions: [] },
          error: null,
        };
      },
      destroy: () => {},
    });
    Reflect.set(client, 'started', true);

    await client.mutations.tasks.insert({ title: 'queued task' });

    expect(syncCalls).toEqual([]);
  });
});

describe('Client inspector snapshot', () => {
  let db: Kysely<TestDb>;
  let client: Client<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureClientSyncSchema(db);

    const handlers: ClientHandlerCollection<TestDb> = [];
    client = new Client<TestDb>({
      db,
      transport: noopTransport,
      tableHandlers: handlers,
      clientId: 'client-inspector',
      actorId: 'u1',
      subscriptions: [],
    });
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('returns a serializable inspector snapshot', async () => {
    await client.start();
    await client.sync();

    const snapshot = await client.getInspectorSnapshot({ eventLimit: 20 });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.generatedAt).toBeGreaterThan(0);
    expect(Array.isArray(snapshot?.recentEvents)).toBe(true);
    expect(snapshot?.recentEvents.length).toBeGreaterThan(0);
    expect(snapshot?.diagnostics).toBeDefined();
  });
});
