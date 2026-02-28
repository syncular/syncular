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
    engine.on('data:change', (payload) => {
      eventScopes.push(payload.scopes);
    });

    engine.recordLocalMutations([
      { table: 'tasks', rowId: 't1', op: 'upsert' },
    ]);
    engine.recordLocalMutations([
      { table: 'tasks', rowId: 't2', op: 'upsert' },
    ]);
    engine.recordLocalMutations([
      { table: 'tasks', rowId: 't3', op: 'delete' },
    ]);

    expect(eventScopes).toEqual([]);
    expect(onDataChangeCalls).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(eventScopes).toEqual([['tasks']]);
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
    defaultEngine.on('data:change', (payload) => {
      defaultEvents.push(payload.scopes);
    });

    defaultEngine.recordLocalMutations([
      { table: 'tasks', rowId: 'd1', op: 'upsert' },
    ]);
    defaultEngine.recordLocalMutations([
      { table: 'tasks', rowId: 'd2', op: 'upsert' },
    ]);
    expect(defaultEvents).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(defaultEvents).toEqual([['tasks']]);

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
    noDebounceEngine.on('data:change', (payload) => {
      immediateEvents.push(payload.scopes);
    });

    noDebounceEngine.recordLocalMutations([
      { table: 'tasks', rowId: 'n1', op: 'upsert' },
    ]);
    expect(immediateEvents).toEqual([['tasks']]);

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
    zeroDebounceEngine.on('data:change', (payload) => {
      zeroEvents.push(payload.scopes);
    });

    zeroDebounceEngine.recordLocalMutations([
      { table: 'tasks', rowId: 'z1', op: 'upsert' },
    ]);
    expect(zeroEvents).toEqual([['tasks']]);

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

    engine.recordLocalMutations([
      { table: 'tasks', rowId: 'syncing-1', op: 'upsert' },
    ]);
    expect(eventScopes).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(eventScopes).toEqual([['tasks']]);

    updateState.call(engine, {
      isSyncing: false,
      connectionState: 'connected',
    });
    setConnectionState.call(engine, 'reconnecting');

    engine.recordLocalMutations([
      { table: 'tasks', rowId: 'reconnecting-1', op: 'upsert' },
    ]);
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
    expect(state.error?.retryable).toBe(false);
    expect(state.retryCount).toBe(1);
    expect(state.isRetrying).toBe(false);
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
      expect(delays).toEqual([2000]);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(2);
      expect(state.isRetrying).toBe(true);
      expect(delays).toEqual([2000, 4000]);

      await engine.sync();
      state = engine.getState();
      expect(state.retryCount).toBe(3);
      expect(state.isRetrying).toBe(true);
      expect(delays).toEqual([2000, 4000, 8000]);
      expect(syncAttempts).toBe(3);

      engine.destroy();
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
      expect(delays[0]).toBe(2000);
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
});
