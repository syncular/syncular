import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  createDatabase,
  encodeSnapshotRows,
  type SyncChange,
  type SyncTransport,
  SyncTransportError,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import type { ClientHandlerCollection } from '../handlers/collection';
import { ensureClientSyncSchema } from '../migrate';
import { enqueueOutboxCommit } from '../outbox';
import type { SyncClientDb } from '../schema';
import { SyncEngine } from './SyncEngine';
import type { RealtimeTransportLike } from './types';

interface TasksTable {
  id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncClientDb {
  tasks: TasksTable;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
  stepMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
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

  it('emits structured pull/apply trace events when tracing is enabled', async () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const transport: SyncTransport = {
      async sync() {
        return {
          pull: {
            ok: true,
            subscriptions: [
              {
                id: 'sub-1',
                status: 'active',
                table: 'tasks',
                scopes: {},
                bootstrap: false,
                commits: [],
                snapshots: [],
                nextCursor: 0,
              },
            ],
          },
        };
      },
    };

    const engine = new SyncEngine<TestDb>({
      db,
      transport,
      handlers,
      actorId: 'u1',
      clientId: 'client-trace',
      subscriptions: [{ id: 'sub-1', table: 'tasks', scopes: {} }],
      stateId: 'default',
      traceEnabled: true,
    });

    const stages: string[] = [];
    engine.on('sync:trace', (payload) => {
      stages.push(payload.stage);
    });

    await engine.start();

    expect(stages).toContain('pull:start');
    expect(stages).toContain('pull:response');
    expect(stages).toContain('apply:transaction:start');
    expect(stages).toContain('apply:transaction:complete');
    expect(stages).toContain('apply:subscription:start');
    expect(stages).toContain('apply:subscription:complete');

    const snapshot = await engine.getInspectorSnapshot({ eventLimit: 50 });
    const traceEvents = snapshot.recentEvents.filter(
      (event) => event.event === 'sync:trace'
    );
    expect(traceEvents.length).toBeGreaterThan(0);
  });

  it('coalesces rapid data:change emissions when debounce is configured', async () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const onDataChangeCalls: string[][] = [];
    const engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-debounce',
      subscriptions: [],
      stateId: 'default',
      dataChangeDebounceMs: 25,
      onDataChange(scopes) {
        onDataChangeCalls.push(scopes);
      },
    });

    const eventScopes: string[][] = [];
    const eventSources: Array<'local' | 'remote'> = [];
    engine.on('data:change', (payload) => {
      eventScopes.push(payload.scopes);
      eventSources.push(payload.source);
    });

    const emitDataChange = Reflect.get(engine, 'emitDataChange');
    if (typeof emitDataChange !== 'function') {
      throw new Error('Expected emitDataChange to be callable');
    }
    emitDataChange.call(engine, ['tasks'], { source: 'remote' });
    emitDataChange.call(engine, ['tasks'], { source: 'remote' });
    emitDataChange.call(engine, ['tasks'], { source: 'remote' });

    expect(eventScopes).toEqual([]);
    expect(onDataChangeCalls).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(eventScopes).toEqual([['tasks']]);
    expect(eventSources).toEqual(['remote']);
    expect(onDataChangeCalls).toEqual([['tasks']]);
  });

  it('uses 10ms debounce by default and supports 0/false opt-out', async () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const defaultEngine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-default-debounce',
      subscriptions: [],
      stateId: 'default',
    });

    const defaultEvents: string[][] = [];
    const defaultEventSources: Array<'local' | 'remote'> = [];
    defaultEngine.on('data:change', (payload) => {
      defaultEvents.push(payload.scopes);
      defaultEventSources.push(payload.source);
    });
    const emitDataChange = Reflect.get(defaultEngine, 'emitDataChange');
    if (typeof emitDataChange !== 'function') {
      throw new Error('Expected emitDataChange to be callable');
    }

    emitDataChange.call(defaultEngine, ['tasks'], { source: 'remote' });
    emitDataChange.call(defaultEngine, ['tasks'], { source: 'remote' });
    expect(defaultEvents).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(defaultEvents).toEqual([['tasks']]);

    defaultEngine.recordLocalMutations([
      { table: 'tasks', rowId: 'local-1', op: 'upsert' },
    ]);
    expect(defaultEvents).toEqual([['tasks'], ['tasks']]);
    expect(defaultEventSources).toEqual(['remote', 'local']);

    const noDebounceEngine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-no-debounce',
      subscriptions: [],
      stateId: 'default',
      dataChangeDebounceMs: false,
    });

    const immediateEvents: string[][] = [];
    const immediateEventSources: Array<'local' | 'remote'> = [];
    noDebounceEngine.on('data:change', (payload) => {
      immediateEvents.push(payload.scopes);
      immediateEventSources.push(payload.source);
    });

    emitDataChange.call(noDebounceEngine, ['tasks'], { source: 'remote' });
    expect(immediateEvents).toEqual([['tasks']]);
    expect(immediateEventSources).toEqual(['remote']);

    const zeroDebounceEngine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-zero-debounce',
      subscriptions: [],
      stateId: 'default',
      dataChangeDebounceMs: 0,
    });

    const zeroEvents: string[][] = [];
    const zeroEventSources: Array<'local' | 'remote'> = [];
    zeroDebounceEngine.on('data:change', (payload) => {
      zeroEvents.push(payload.scopes);
      zeroEventSources.push(payload.source);
    });

    emitDataChange.call(zeroDebounceEngine, ['tasks'], { source: 'remote' });
    expect(zeroEvents).toEqual([['tasks']]);
    expect(zeroEventSources).toEqual(['remote']);

    defaultEngine.destroy();
    noDebounceEngine.destroy();
    zeroDebounceEngine.destroy();
  });

  it('supports adaptive debounce overrides while syncing and reconnecting', async () => {
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
      clientId: 'client-adaptive-debounce',
      subscriptions: [],
      stateId: 'default',
      dataChangeDebounceMs: 0,
      dataChangeDebounceMsWhenSyncing: 15,
      dataChangeDebounceMsWhenReconnecting: 35,
    });

    const eventScopes: string[][] = [];
    engine.on('data:change', (payload) => {
      eventScopes.push(payload.scopes);
    });

    const setConnectionState = Reflect.get(engine, 'setConnectionState');
    if (typeof setConnectionState !== 'function') {
      throw new Error('Expected setConnectionState to be callable');
    }

    const updateState = Reflect.get(engine, 'updateState');
    if (typeof updateState !== 'function') {
      throw new Error('Expected updateState to be callable');
    }

    updateState.call(engine, {
      isSyncing: true,
      connectionState: 'connected',
    });

    const emitDataChange = Reflect.get(engine, 'emitDataChange');
    if (typeof emitDataChange !== 'function') {
      throw new Error('Expected emitDataChange to be callable');
    }
    emitDataChange.call(engine, ['tasks'], { source: 'remote' });
    expect(eventScopes).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(eventScopes).toEqual([['tasks']]);

    updateState.call(engine, {
      isSyncing: false,
      connectionState: 'connected',
    });
    setConnectionState.call(engine, 'reconnecting');

    emitDataChange.call(engine, ['tasks'], { source: 'remote' });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(eventScopes).toEqual([['tasks']]);

    setConnectionState.call(engine, 'connected');
    const flushReconnectBatch = Reflect.get(
      engine,
      'flushReconnectBatchedDataChangesIfReady'
    );
    if (typeof flushReconnectBatch !== 'function') {
      throw new Error(
        'Expected flushReconnectBatchedDataChangesIfReady to be callable'
      );
    }
    flushReconnectBatch.call(engine);
    expect(eventScopes).toEqual([['tasks'], ['tasks']]);
  });

  it('does not emit state:change for no-op state updates', async () => {
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
      clientId: 'client-noop-state',
      subscriptions: [],
      stateId: 'default',
    });

    let stateChangeCount = 0;
    engine.subscribe(() => {
      stateChangeCount += 1;
    });

    const updateState = Reflect.get(engine, 'updateState');
    if (typeof updateState !== 'function') {
      throw new Error('Expected updateState to be callable');
    }

    const initialState = engine.getState();
    updateState.call(engine, { enabled: initialState.enabled });
    updateState.call(engine, { error: initialState.error });
    expect(stateChangeCount).toBe(0);

    updateState.call(engine, { enabled: !initialState.enabled });
    expect(stateChangeCount).toBe(1);
  });

  it('supports selector subscriptions without notifying on unrelated state changes', async () => {
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
      clientId: 'client-selector',
      subscriptions: [],
      stateId: 'default',
    });

    let calls = 0;
    const unsubscribe = engine.subscribeSelector(
      () => engine.getState().lastSyncAt,
      () => {
        calls += 1;
      }
    );

    const updateState = Reflect.get(engine, 'updateState');
    if (typeof updateState !== 'function') {
      throw new Error('Expected updateState to be callable');
    }

    updateState.call(engine, { retryCount: 1 });
    expect(calls).toBe(0);

    updateState.call(engine, { lastSyncAt: Date.now() });
    expect(calls).toBe(1);

    unsubscribe();
  });

  it('skips presence:change emissions for no-op presence updates', async () => {
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
      clientId: 'client-presence',
      subscriptions: [],
      stateId: 'default',
    });

    let eventCount = 0;
    engine.on('presence:change', () => {
      eventCount += 1;
    });

    const basePresence = [
      {
        clientId: 'c1',
        actorId: 'u1',
        joinedAt: 1000,
        metadata: { name: 'Alice' },
      },
    ];

    engine.updatePresence('room:1', basePresence);
    expect(eventCount).toBe(1);

    engine.updatePresence('room:1', [
      {
        clientId: 'c1',
        actorId: 'u1',
        joinedAt: 1000,
        metadata: { name: 'Alice' },
      },
    ]);
    expect(eventCount).toBe(1);

    engine.handlePresenceEvent({
      action: 'update',
      scopeKey: 'room:1',
      clientId: 'c1',
      actorId: 'u1',
      metadata: { name: 'Alice' },
    });
    expect(eventCount).toBe(1);

    engine.handlePresenceEvent({
      action: 'join',
      scopeKey: 'room:1',
      clientId: 'c1',
      actorId: 'u1',
      metadata: { name: 'Alice' },
    });
    expect(eventCount).toBe(1);
  });

  it('ensures sync schema on start without custom migrate callback', async () => {
    const coldDb = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
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

  it('classifies missing snapshot chunk pull failures as non-retryable', async () => {
    const missingChunkTransport: SyncTransport = {
      async sync() {
        throw new SyncTransportError('snapshot chunk not found', 404);
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

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
      transport: missingChunkTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-missing-chunk',
      subscriptions: [
        {
          id: 'sub-1',
          table: 'tasks',
          scopes: {},
        },
      ],
      stateId: 'default',
      pollIntervalMs: 60_000,
      maxRetries: 3,
    });

    await engine.start();
    engine.stop();

    const state = engine.getState();
    expect(state.error?.code).toBe('SNAPSHOT_CHUNK_NOT_FOUND');
    expect(state.error?.stage).toBe('pull');
    expect(state.error?.retryable).toBe(false);
    expect(state.retryCount).toBe(1);
    expect(state.isRetrying).toBe(false);
  });

  it('classifies gzip decode failures with chunk metadata', async () => {
    const invalidCompressed = new Uint8Array(
      gzipSync(new TextEncoder().encode('truncated-gzip')).subarray(0, 8)
    );
    const transport: SyncTransport = {
      capabilities: {
        snapshotChunkReadMode: 'bytes',
        preferMaterializedSnapshots: true,
      },
      async sync() {
        return {
          pull: {
            ok: true,
            subscriptions: [
              {
                id: 'sub-1',
                status: 'active',
                scopes: {},
                bootstrap: true,
                bootstrapState: null,
                nextCursor: 1,
                commits: [],
                snapshots: [
                  {
                    table: 'tasks',
                    rows: [],
                    chunks: [
                      {
                        id: 'chunk-1',
                        byteLength: invalidCompressed.length,
                        sha256: '',
                        encoding: 'json-row-frame-v1',
                        compression: 'gzip',
                      },
                    ],
                    isFirstPage: true,
                    isLastPage: true,
                  },
                ],
              },
            ],
          },
        };
      },
      async fetchSnapshotChunk() {
        return invalidCompressed;
      },
    };

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
      transport,
      handlers,
      actorId: 'u1',
      clientId: 'client-gzip-failure',
      subscriptions: [
        {
          id: 'sub-1',
          table: 'tasks',
          scopes: {},
        },
      ],
      stateId: 'default',
      pollIntervalMs: 60_000,
      maxRetries: 1,
    });

    await engine.start();
    engine.stop();

    const state = engine.getState();
    expect(state.error?.code).toBe('SNAPSHOT_GZIP_DECODE_FAILED');
    expect(state.error?.stage).toBe('snapshot-gzip-decode');
    expect(state.error?.subscriptionId).toBe('sub-1');
    expect(state.error?.chunkId).toBe('chunk-1');
    expect(state.error?.table).toBe('tasks');
    expect(state.error?.retryable).toBe(false);
  });

  it('classifies snapshot apply failures with stage metadata', async () => {
    const rows = [{ id: 't2', title: 'new', server_version: 1 }];
    const encoded = encodeSnapshotRows(rows);
    const compressed = new Uint8Array(gzipSync(encoded));
    const transport: SyncTransport = {
      async sync() {
        return {
          pull: {
            ok: true,
            subscriptions: [
              {
                id: 'sub-1',
                status: 'active',
                scopes: {},
                bootstrap: true,
                bootstrapState: null,
                nextCursor: 1,
                commits: [],
                snapshots: [
                  {
                    table: 'tasks',
                    rows: [],
                    chunks: [
                      {
                        id: 'chunk-1',
                        byteLength: compressed.length,
                        sha256: '',
                        encoding: 'json-row-frame-v1',
                        compression: 'gzip',
                      },
                    ],
                    isFirstPage: true,
                    isLastPage: true,
                  },
                ],
              },
            ],
          },
        };
      },
      async fetchSnapshotChunk() {
        return compressed;
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {
          throw new Error('forced snapshot apply failure');
        },
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const engine = new SyncEngine<TestDb>({
      db,
      transport,
      handlers,
      actorId: 'u1',
      clientId: 'client-apply-failure',
      subscriptions: [
        {
          id: 'sub-1',
          table: 'tasks',
          scopes: {},
        },
      ],
      stateId: 'default',
      pollIntervalMs: 60_000,
      maxRetries: 1,
    });

    await engine.start();
    engine.stop();

    const state = engine.getState();
    expect(state.error?.code).toBe('SNAPSHOT_APPLY_FAILED');
    expect(state.error?.stage).toBe('snapshot-apply');
    expect(state.error?.subscriptionId).toBe('sub-1');
    expect(state.error?.table).toBe('tasks');
    expect(state.error?.retryable).toBe(false);
  });

  it('pulls newly eligible bootstrap phases in the same sync cycle', async () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const syncRequests: string[][] = [];
    const transport: SyncTransport = {
      async sync(request) {
        const ids = request.pull?.subscriptions.map((subscription) => {
          return subscription.id;
        }) ?? ['unexpected'];
        syncRequests.push(ids);

        if (syncRequests.length === 1) {
          expect(ids).toEqual(['catalog-meta', 'catalog-codes']);
          return {
            pull: {
              ok: true,
              subscriptions: [
                {
                  id: 'catalog-meta',
                  status: 'active',
                  scopes: {},
                  bootstrap: false,
                  nextCursor: 1,
                  commits: [],
                  snapshots: [],
                },
                {
                  id: 'catalog-codes',
                  status: 'active',
                  scopes: {},
                  bootstrap: false,
                  nextCursor: 1,
                  commits: [],
                  snapshots: [],
                },
              ],
            },
          };
        }

        expect(ids).toEqual([
          'catalog-meta',
          'catalog-codes',
          'catalog-relations',
        ]);
        return {
          pull: {
            ok: true,
            subscriptions: [
              {
                id: 'catalog-meta',
                status: 'active',
                scopes: {},
                bootstrap: false,
                nextCursor: 1,
                commits: [],
                snapshots: [],
              },
              {
                id: 'catalog-codes',
                status: 'active',
                scopes: {},
                bootstrap: false,
                nextCursor: 1,
                commits: [],
                snapshots: [],
              },
              {
                id: 'catalog-relations',
                status: 'active',
                scopes: {},
                bootstrap: false,
                nextCursor: 1,
                commits: [],
                snapshots: [],
              },
            ],
          },
        };
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    const engine = new SyncEngine<TestDb>({
      db,
      transport,
      handlers,
      actorId: 'catalog-public',
      clientId: 'client-bootstrap-phases',
      subscriptions: [
        {
          id: 'catalog-meta',
          table: 'tasks',
          scopes: {},
          bootstrapPhase: 0,
        },
        {
          id: 'catalog-codes',
          table: 'tasks',
          scopes: {},
          bootstrapPhase: 0,
        },
        {
          id: 'catalog-relations',
          table: 'tasks',
          scopes: {},
          bootstrapPhase: 1,
        },
      ],
      stateId: 'default',
      pollIntervalMs: 60_000,
    });

    await engine.start();
    engine.stop();

    expect(syncRequests).toEqual([
      ['catalog-meta', 'catalog-codes'],
      ['catalog-meta', 'catalog-codes', 'catalog-relations'],
    ]);

    const relationState = await db
      .selectFrom('sync_subscription_state')
      .select(['subscription_id', 'status', 'cursor'])
      .where('state_id', '=', 'default')
      .where('subscription_id', '=', 'catalog-relations')
      .executeTakeFirst();

    expect(relationState).toEqual({
      subscription_id: 'catalog-relations',
      status: 'active',
      cursor: 1,
    });
  });

  it('skips outbox and conflict refresh after a read-only successful sync', async () => {
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
      clientId: 'client-readonly-sync',
      subscriptions: [],
      stateId: 'default',
      pollIntervalMs: 60_000,
    });

    let outboxRefreshes = 0;
    let conflictChecks = 0;
    Reflect.set(engine, 'refreshOutboxStats', async () => {
      outboxRefreshes += 1;
      return {
        pending: 0,
        sending: 0,
        failed: 0,
        acked: 0,
        total: 0,
      };
    });
    Reflect.set(engine, 'emitNewConflictsSafe', async () => {
      conflictChecks += 1;
    });

    await engine.start();

    expect(outboxRefreshes).toBe(0);
    expect(conflictChecks).toBe(0);

    engine.destroy();
  });

  it('classifies 429 sync failures as retryable and schedules exponential backoff', async () => {
    let syncAttempts = 0;
    const rateLimitedTransport: SyncTransport = {
      async sync() {
        syncAttempts += 1;
        throw new SyncTransportError('rate limited', 429);
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const delays: number[] = [];
    const timeoutHandles: Array<ReturnType<typeof setTimeout>> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const patchedSetTimeout: typeof globalThis.setTimeout = (
      _handler,
      timeout,
      ..._args
    ) => {
      const delayMs = typeof timeout === 'number' ? timeout : 0;
      delays.push(delayMs);
      const handle = originalSetTimeout(() => {}, 60_000);
      timeoutHandles.push(handle);
      return handle;
    };
    globalThis.setTimeout = patchedSetTimeout;

    try {
      const engine = new SyncEngine<TestDb>({
        db,
        transport: rateLimitedTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-rate-limit',
        subscriptions: [
          {
            id: 'sub-1',
            table: 'tasks',
            scopes: {},
          },
        ],
        stateId: 'default',
        pollIntervalMs: 60_000,
        maxRetries: 4,
      });

      await engine.start();

      let state = engine.getState();
      expect(state.error?.code).toBe('NETWORK_ERROR');
      expect(state.error?.retryable).toBe(true);
      expect(state.error?.httpStatus).toBe(429);
      expect(state.retryCount).toBe(1);
      expect(state.isRetrying).toBe(true);
      expect(delays).toEqual([1000]);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(2);
      expect(state.isRetrying).toBe(true);
      expect(delays).toEqual([1000, 2000]);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(3);
      expect(state.isRetrying).toBe(true);
      expect(delays).toEqual([1000, 2000, 4000]);
      expect(syncAttempts).toBe(3);

      engine.destroy();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      for (const handle of timeoutHandles) {
        clearTimeout(handle);
      }
    }
  });

  it('uses a shorter capped recovery retry delay after a recent successful read-only sync', async () => {
    let syncAttempts = 0;
    const delayedFailureTransport: SyncTransport = {
      async sync() {
        syncAttempts += 1;
        if (syncAttempts === 1) {
          return { ok: true, subscriptions: [] };
        }
        throw new SyncTransportError('service unavailable', 503);
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const delays: number[] = [];
    const timeoutHandles: Array<ReturnType<typeof setTimeout>> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const patchedSetTimeout: typeof globalThis.setTimeout = (
      _handler,
      timeout,
      ..._args
    ) => {
      const delayMs = typeof timeout === 'number' ? timeout : 0;
      delays.push(delayMs);
      const handle = originalSetTimeout(() => {}, 60_000);
      timeoutHandles.push(handle);
      return handle;
    };
    globalThis.setTimeout = patchedSetTimeout;

    try {
      const engine = new SyncEngine<TestDb>({
        db,
        transport: delayedFailureTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-recovery-retry',
        subscriptions: [
          {
            id: 'sub-1',
            table: 'tasks',
            scopes: {},
          },
        ],
        stateId: 'default',
        pollIntervalMs: 60_000,
        maxRetries: 5,
      });

      await engine.start();
      expect(engine.getState().lastSyncAt).not.toBeNull();

      await engine.sync();
      let state = engine.getState();
      expect(state.error?.code).toBe('NETWORK_ERROR');
      expect(state.retryCount).toBe(1);
      expect(state.isRetrying).toBe(true);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(2);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(3);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(4);
      expect(delays).toEqual([250, 500, 1000, 1000]);

      engine.destroy();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      for (const handle of timeoutHandles) {
        clearTimeout(handle);
      }
    }
  });

  it('uses deterministic jitter for realtime reconnect sync and catchup scheduling', () => {
    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const delays: number[] = [];
    const timeoutHandles: Array<ReturnType<typeof setTimeout>> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const patchedSetTimeout: typeof globalThis.setTimeout = (
      _handler,
      timeout,
      ..._args
    ) => {
      const delayMs = typeof timeout === 'number' ? timeout : 0;
      delays.push(delayMs);
      const handle = originalSetTimeout(() => {}, 60_000);
      timeoutHandles.push(handle);
      return handle;
    };
    globalThis.setTimeout = patchedSetTimeout;

    try {
      const engineA = new SyncEngine<TestDb>({
        db,
        transport: noopTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-reconnect-jitter',
        subscriptions: [],
        stateId: 'default',
      });
      const engineB = new SyncEngine<TestDb>({
        db,
        transport: noopTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-reconnect-jitter',
        subscriptions: [],
        stateId: 'default',
      });

      const scheduleReconnectSyncA = Reflect.get(
        engineA,
        'scheduleRealtimeReconnectSync'
      );
      const scheduleReconnectCatchupA = Reflect.get(
        engineA,
        'scheduleRealtimeReconnectCatchupSync'
      );
      const scheduleReconnectSyncB = Reflect.get(
        engineB,
        'scheduleRealtimeReconnectSync'
      );

      if (
        typeof scheduleReconnectSyncA !== 'function' ||
        typeof scheduleReconnectCatchupA !== 'function' ||
        typeof scheduleReconnectSyncB !== 'function'
      ) {
        throw new Error('Expected reconnect scheduling helpers to be callable');
      }

      scheduleReconnectSyncA.call(engineA);
      scheduleReconnectCatchupA.call(engineA);
      scheduleReconnectSyncB.call(engineB);

      expect(delays.length).toBe(3);
      expect(delays[0]).toBeGreaterThanOrEqual(0);
      expect(delays[0]).toBeLessThanOrEqual(250);
      expect(delays[1]).toBeGreaterThanOrEqual(500);
      expect(delays[1]).toBeLessThanOrEqual(750);
      expect(delays[2]).toBe(delays[0]);

      engineA.destroy();
      engineB.destroy();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      for (const handle of timeoutHandles) {
        clearTimeout(handle);
      }
    }
  });

  it('keeps push failures retryable on 503 and preserves pending outbox state', async () => {
    let sawPushRequest = false;
    const unavailablePushTransport: SyncTransport = {
      async sync(request) {
        sawPushRequest = sawPushRequest || Boolean(request.push);
        throw new SyncTransportError('service unavailable', 503);
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange() {},
      },
    ];

    const originalSetTimeout = globalThis.setTimeout;
    const timeoutHandles: Array<ReturnType<typeof setTimeout>> = [];
    const patchedSetTimeout: typeof globalThis.setTimeout = (
      _handler,
      _timeout,
      ..._args
    ) => {
      const handle = originalSetTimeout(() => {}, 60_000);
      timeoutHandles.push(handle);
      return handle;
    };
    globalThis.setTimeout = patchedSetTimeout;

    try {
      await enqueueOutboxCommit(db, {
        operations: [
          {
            table: 'tasks',
            row_id: 'push-failure-task',
            op: 'upsert',
            payload: {
              title: 'Push Failure Task',
            },
            base_version: null,
          },
        ],
      });

      const engine = new SyncEngine<TestDb>({
        db,
        transport: unavailablePushTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-push-503',
        subscriptions: [
          {
            id: 'sub-1',
            table: 'tasks',
            scopes: {},
          },
        ],
        stateId: 'default',
        pollIntervalMs: 60_000,
      });

      await engine.start();

      const state = engine.getState();
      expect(state.error?.code).toBe('NETWORK_ERROR');
      expect(state.error?.retryable).toBe(true);
      expect(state.error?.httpStatus).toBe(503);
      expect(sawPushRequest).toBe(true);

      const row = await db
        .selectFrom('sync_outbox_commits')
        .select(['status'])
        .executeTakeFirst();
      const failedCount = await db
        .selectFrom('sync_outbox_commits')
        .select(({ fn }) => fn.countAll().as('total'))
        .where('status', '=', 'failed')
        .executeTakeFirst();
      expect(row?.status === 'pending' || row?.status === 'sending').toBe(true);
      expect(Number(failedCount?.total ?? 0)).toBe(0);

      engine.destroy();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      for (const handle of timeoutHandles) {
        clearTimeout(handle);
      }
    }
  });

  it('classifies 503 snapshot chunk fetch failures as retryable and recovers on retry', async () => {
    let syncCalls = 0;
    let chunkFetchCalls = 0;
    const payload = new Uint8Array(
      gzipSync(
        encodeSnapshotRows([
          {
            id: 'chunk-retry-task',
            title: 'Chunk Retry',
            server_version: 1,
          },
        ])
      )
    );
    const chunkFailThenRecoverTransport: SyncTransport = {
      async sync() {
        syncCalls += 1;
        return {
          ok: true,
          pull: {
            ok: true,
            subscriptions: [
              {
                id: 'sub-1',
                status: 'active',
                scopes: {},
                bootstrap: true,
                bootstrapState: null,
                nextCursor: 1,
                commits: [],
                snapshots: [
                  {
                    table: 'tasks',
                    rows: [],
                    chunks: [
                      {
                        id: 'chunk-retry-1',
                        byteLength: payload.length,
                        sha256: '',
                        encoding: 'json-row-frame-v1',
                        compression: 'gzip',
                      },
                    ],
                    isFirstPage: true,
                    isLastPage: true,
                  },
                ],
              },
            ],
          },
        };
      },
      async fetchSnapshotChunk() {
        chunkFetchCalls += 1;
        if (chunkFetchCalls === 1) {
          throw new SyncTransportError('temporary chunk outage', 503);
        }
        return payload;
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot(ctx, snapshot) {
          for (const row of snapshot.rows as TasksTable[]) {
            await sql`
              insert into ${sql.table('tasks')} (
                ${sql.ref('id')},
                ${sql.ref('title')},
                ${sql.ref('server_version')}
              ) values (
                ${sql.val(row.id)},
                ${sql.val(row.title)},
                ${sql.val(row.server_version)}
              )
              on conflict (${sql.ref('id')})
              do update set
                ${sql.ref('title')} = excluded.${sql.ref('title')},
                ${sql.ref('server_version')} = excluded.${sql.ref('server_version')}
            `.execute(ctx.trx);
          }
        },
        async clearAll(ctx) {
          await sql`delete from ${sql.table('tasks')}`.execute(ctx.trx);
        },
        async applyChange() {},
      },
    ];

    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const patchedSetTimeout: typeof globalThis.setTimeout = (
      handler,
      timeout,
      ...args
    ) => {
      const delayMs = typeof timeout === 'number' ? timeout : 0;
      delays.push(delayMs);
      return originalSetTimeout(() => {
        if (typeof handler === 'function') {
          handler(...args);
        }
      }, 0);
    };
    globalThis.setTimeout = patchedSetTimeout;

    try {
      const engine = new SyncEngine<TestDb>({
        db,
        transport: chunkFailThenRecoverTransport,
        handlers,
        actorId: 'u1',
        clientId: 'client-chunk-503',
        subscriptions: [
          {
            id: 'sub-1',
            table: 'tasks',
            scopes: {},
          },
        ],
        stateId: 'default',
        pollIntervalMs: 60_000,
      });

      await engine.start();
      await waitFor(() => engine.getState().error === null, 2000, 10);

      const state = engine.getState();
      expect(state.retryCount).toBe(0);
      expect(state.isRetrying).toBe(false);
      expect(delays[0]).toBe(1000);
      expect(chunkFetchCalls).toBeGreaterThanOrEqual(2);
      expect(syncCalls).toBeGreaterThanOrEqual(2);

      const row = await db
        .selectFrom('tasks')
        .select(['id', 'title'])
        .where('id', '=', 'chunk-retry-task')
        .executeTakeFirst();
      expect(row?.title).toBe('Chunk Retry');

      engine.destroy();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('stops realtime reconnect and fallback polling after auth failures', async () => {
    let syncAttempts = 0;
    let disconnectCalls = 0;
    let reconnectCalls = 0;

    const authFailingRealtimeTransport: RealtimeTransportLike = {
      async sync() {
        syncAttempts += 1;
        throw new SyncTransportError('unauthorized', 401);
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
      connect(_args, _onEvent, onStateChange) {
        onStateChange?.('disconnected');
        return () => {
          disconnectCalls += 1;
        };
      },
      getConnectionState() {
        return 'disconnected';
      },
      reconnect() {
        reconnectCalls += 1;
      },
    };

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
      transport: authFailingRealtimeTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-auth-failed-realtime',
      subscriptions: [
        {
          id: 'sub-1',
          table: 'tasks',
          scopes: {},
        },
      ],
      stateId: 'default',
      realtimeFallbackPollMs: 10,
      pollIntervalMs: 60_000,
    });

    await engine.start();

    try {
      const state = engine.getState();
      expect(state.error?.code).toBe('AUTH_FAILED');
      expect(state.error?.retryable).toBe(false);
      expect(state.connectionState).toBe('disconnected');

      const health = engine.getTransportHealth();
      expect(health.mode).toBe('disconnected');
      expect(health.connected).toBe(false);
      expect(health.fallbackReason).toBe('auth');

      const attemptsAfterStart = syncAttempts;
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(syncAttempts).toBe(attemptsAfterStart);
      expect(disconnectCalls).toBeGreaterThanOrEqual(1);
      expect(reconnectCalls).toBe(0);
    } finally {
      engine.destroy();
    }
  });

  it('repairs rebootstrap-missing-chunks by clearing synced state and data', async () => {
    const outboxId = 'outbox-1';
    const now = Date.now();

    await db
      .insertInto('tasks')
      .values({
        id: 't2',
        title: 'to-clear',
        server_version: 2,
      })
      .execute();

    await db
      .insertInto('sync_outbox_commits')
      .values({
        id: outboxId,
        client_commit_id: 'client-commit-1',
        status: 'pending',
        operations_json: '[]',
        last_response_json: null,
        error: null,
        created_at: now,
        updated_at: now,
        acked_commit_seq: null,
      })
      .execute();

    await db
      .insertInto('sync_conflicts')
      .values({
        id: 'conflict-1',
        outbox_commit_id: outboxId,
        client_commit_id: 'client-commit-1',
        op_index: 0,
        result_status: 'conflict',
        message: 'forced conflict',
        code: 'TEST_CONFLICT',
        server_version: 1,
        server_row_json: '{}',
        created_at: now,
        resolved_at: null,
        resolution: null,
      })
      .execute();

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'tasks',
        async applySnapshot() {},
        async clearAll(ctx) {
          await sql`delete from ${sql.table('tasks')}`.execute(ctx.trx);
        },
        async applyChange() {},
      },
    ];

    const engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers,
      actorId: 'u1',
      clientId: 'client-repair',
      subscriptions: [],
      stateId: 'default',
    });

    const result = await engine.repair({
      mode: 'rebootstrap-missing-chunks',
      clearOutbox: true,
      clearConflicts: true,
    });

    expect(result.deletedSubscriptionStates).toBe(1);
    expect(result.deletedOutboxCommits).toBe(1);
    expect(result.deletedConflicts).toBe(1);
    expect(result.clearedTables).toEqual(['tasks']);

    const tasksCount = await db
      .selectFrom('tasks')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(tasksCount?.total ?? 0)).toBe(0);

    const subscriptionsCount = await db
      .selectFrom('sync_subscription_state')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(subscriptionsCount?.total ?? 0)).toBe(0);

    const outboxCount = await db
      .selectFrom('sync_outbox_commits')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(outboxCount?.total ?? 0)).toBe(0);

    const conflictsCount = await db
      .selectFrom('sync_conflicts')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(conflictsCount?.total ?? 0)).toBe(0);
  });

  it('defers polling-triggered background sync while retry backoff is active', () => {
    const engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers: [],
      actorId: 'u1',
      clientId: 'client-retry-poll',
      subscriptions: [],
      stateId: 'default',
    });

    const syncCalls: Array<{ trigger?: 'ws' | 'local' | 'poll' }> = [];
    Reflect.set(
      engine,
      'sync',
      async (opts?: { trigger?: 'ws' | 'local' | 'poll' }) => {
        syncCalls.push(opts ?? {});
        return {
          success: true,
          pushedCommits: 0,
          pullRounds: 0,
          pullResponse: { ok: true, subscriptions: [] },
          error: null,
        };
      }
    );

    const updateState = Reflect.get(engine, 'updateState');
    if (typeof updateState !== 'function') {
      throw new Error('Expected updateState to be callable');
    }
    updateState.call(engine, { isRetrying: true });

    const triggerSyncInBackground = Reflect.get(
      engine,
      'triggerSyncInBackground'
    );
    if (typeof triggerSyncInBackground !== 'function') {
      throw new Error('Expected triggerSyncInBackground to be callable');
    }
    triggerSyncInBackground.call(engine, undefined, 'polling interval');

    expect(syncCalls).toEqual([]);
  });

  it('allows ws-triggered background sync while retry backoff is active', () => {
    const engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers: [],
      actorId: 'u1',
      clientId: 'client-retry-ws',
      subscriptions: [],
      stateId: 'default',
    });

    const syncCalls: Array<{ trigger?: 'ws' | 'local' | 'poll' }> = [];
    Reflect.set(
      engine,
      'sync',
      async (opts?: { trigger?: 'ws' | 'local' | 'poll' }) => {
        syncCalls.push(opts ?? {});
        return {
          success: true,
          pushedCommits: 0,
          pullRounds: 0,
          pullResponse: { ok: true, subscriptions: [] },
          error: null,
        };
      }
    );

    const updateState = Reflect.get(engine, 'updateState');
    if (typeof updateState !== 'function') {
      throw new Error('Expected updateState to be callable');
    }
    updateState.call(engine, { isRetrying: true });

    const triggerSyncInBackground = Reflect.get(
      engine,
      'triggerSyncInBackground'
    );
    if (typeof triggerSyncInBackground !== 'function') {
      throw new Error('Expected triggerSyncInBackground to be callable');
    }
    triggerSyncInBackground.call(engine, { trigger: 'ws' }, 'ws cursor wakeup');

    expect(syncCalls).toEqual([{ trigger: 'ws' }]);
  });
});
