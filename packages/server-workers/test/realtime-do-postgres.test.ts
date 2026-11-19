/**
 * `SyncularRealtimeHost` over a caller-built `PostgresServerStorage` (PGlite
 * stands in for PostgreSQL behind Hyperdrive): the partition's object relays
 * commits to the shard objects registered with it, and each storage refuses
 * the other's topology (§8.9).
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeSparseRow, type RowColumn } from '@syncular/core';
import {
  compileSchema,
  MemorySegmentStore,
  PostgresServerStorage,
  RemoteOperationRegistry,
  type ServerSchema,
  type SyncularServerEvent,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from '../../server/test/d1-double';
import {
  createWorkersFetchHandler,
  D1ServerStorage,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  durableObjectRealtimeNotifier,
  OPERATIONS_DO_REQUEST_PATH,
  REALTIME_DO_SHARDS_PATH,
  REALTIME_DO_UPGRADE_PATH,
  type RealtimeDOConfig,
  type RealtimeHostStorage,
  SYNC_DO_REQUEST_PATH,
  SyncularRealtimeHost,
  WorkersTopologyError,
  writeIdentityHeaders,
  writeRequestIdentityHeaders,
} from '../src/index';
import { FakeDurableObjectState } from './do-double';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'list_id', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

test('the partition object drops a shard without sockets unless it registered again', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.ensureSchema(compileSchema(SCHEMA));
  const stubs = new Map<string, DurableObjectStubLike>();
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => stubs.get(id.toString())!,
  };
  const state = new FakeDurableObjectState();
  const relay = new SyncularRealtimeHost(state, storage, {
    syncConfig: (coordinated) => ({
      schema: SCHEMA,
      storage: coordinated,
      resolveScopes: () => ({ list_id: ['L'] }),
      segments: new MemorySegmentStore(),
    }),
    namespace,
  });
  stubs.set('part-1', relay);
  const register = (shard: string, token: string) =>
    relay.fetch(
      new Request(new URL(REALTIME_DO_SHARDS_PATH, 'https://do'), {
        method: 'POST',
        body: JSON.stringify({ shard, token }),
      }),
    );
  const received: string[] = [];
  // A shard without sockets, and one that registers again before it answers.
  stubs.set('empty', {
    fetch: async () => {
      received.push('empty');
      return new Response(null, { status: 404 });
    },
  });
  stubs.set('returning', {
    fetch: async () => {
      received.push('returning');
      await register('returning', 'second');
      return new Response(null, { status: 404 });
    },
  });
  expect((await register('empty', 'first')).status).toBe(204);
  expect((await register('returning', 'first')).status).toBe(204);
  await durableObjectRealtimeNotifier(namespace, {
    waitUntil: () => {},
  }).notifyCommit('part-1', {
    commitSeq: 1,
    createdAtMs: 0,
    actorId: 'actor-1',
    changes: [
      {
        table: 'tasks',
        rowId: 't1',
        op: 'upsert',
        rowVersion: 1,
        scopes: { list_id: 'L' },
        payload: encodeSparseRow(COLUMNS, 0, ['t1', 'L']),
      },
    ],
  });
  expect(received.sort()).toEqual(['empty', 'returning']);
  expect([...state.values]).toEqual([['shard:returning', 'second']]);
  await db.close();
});

test('each storage refuses the other topology with workers.topology_mismatch', async () => {
  const db = await PGlite.create();
  const postgres = new PostgresServerStorage(pgliteExecutor(db));
  const namespace: DurableObjectNamespaceLike = {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response() }),
  };
  const syncConfig: RealtimeDOConfig<RealtimeHostStorage>['syncConfig'] = (
    storage,
  ) => ({
    schema: SCHEMA,
    storage,
    resolveScopes: () => ({ list_id: ['L'] }),
    segments: new MemorySegmentStore(),
  });
  const refusal = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof WorkersTopologyError)) throw error;
      return error.details;
    }
    throw new Error('expected a topology refusal');
  };
  const state = new FakeDurableObjectState();
  expect(
    await refusal(
      () =>
        new SyncularRealtimeHost(state, new D1DatabaseDouble(), {
          syncConfig,
          namespace,
        }),
    ),
  ).toEqual({ storage: 'd1', wiring: 'namespace' });
  expect(
    await refusal(
      () =>
        // @ts-expect-error: a PostgreSQL host needs the namespace.
        new SyncularRealtimeHost(state, postgres, { syncConfig }),
    ),
  ).toEqual({ storage: 'database-lock', wiring: 'no-namespace' });
  expect(
    await refusal(
      () =>
        new SyncularRealtimeHost(state, postgres, {
          syncConfig,
          namespace,
          // @ts-expect-error: commands run in the Worker on PostgreSQL.
          operations: new RemoteOperationRegistry([]),
        }),
    ),
  ).toEqual({ storage: 'database-lock', wiring: 'operations' });
  const shardHost = new SyncularRealtimeHost(state, postgres, {
    syncConfig,
    namespace,
  });
  const identity = { partition: 'part-1', actorId: 'actor-1' };
  for (const path of [SYNC_DO_REQUEST_PATH, OPERATIONS_DO_REQUEST_PATH]) {
    const forwarded = new Request(new URL(path, 'https://do'), {
      method: 'POST',
    });
    writeRequestIdentityHeaders(forwarded.headers, identity);
    expect(await refusal(() => shardHost.fetch(forwarded))).toEqual({
      storage: 'database-lock',
      wiring: 'forwarded-round',
    });
  }
  const upgrade = (shard?: string) => {
    const request = new Request(
      new URL(REALTIME_DO_UPGRADE_PATH, 'https://do'),
    );
    writeIdentityHeaders(
      request.headers,
      { ...identity, clientId: 'client-1' },
      shard,
    );
    return request;
  };
  expect(await refusal(() => shardHost.fetch(upgrade()))).toEqual({
    storage: 'database-lock',
    wiring: 'unsharded-upgrade',
  });
  const d1Host = new SyncularRealtimeHost(state, new D1DatabaseDouble(), {
    syncConfig,
  });
  expect(await refusal(() => d1Host.fetch(upgrade('["part-1","a"]')))).toEqual({
    storage: 'd1',
    wiring: 'sharded-upgrade',
  });
  const handler = createWorkersFetchHandler({
    config: () => ({
      config: syncConfig(new D1ServerStorage(new D1DatabaseDouble())),
      authenticate: async () => ({ actorId: 'actor-1', partition: 'part-1' }),
    }),
    realtime: () => ({
      namespace,
      authenticate: () => undefined,
      shard: () => 'facility-a',
    }),
  });
  expect(
    await refusal(() =>
      handler(
        new Request('https://worker/sync', { method: 'POST' }),
        {},
        { waitUntil: () => {} },
      ),
    ),
  ).toEqual({ storage: 'database-lock', wiring: 'no-notifier' });
  await db.close();
});

test('a failed relay is owed to the shard and retried from the alarm until it answers', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.ensureSchema(compileSchema(SCHEMA));
  const statuses = [503, 204];
  const stubs = new Map<string, DurableObjectStubLike>();
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => stubs.get(id.toString())!,
  };
  stubs.set('flaky', {
    fetch: async () => new Response(null, { status: statuses.shift() ?? 500 }),
  });
  const state = new FakeDurableObjectState();
  const relay = new SyncularRealtimeHost(state, storage, {
    syncConfig: (coordinated) => ({
      schema: SCHEMA,
      storage: coordinated,
      resolveScopes: () => ({ list_id: ['L'] }),
      segments: new MemorySegmentStore(),
    }),
    namespace,
  });
  stubs.set('part-1', relay);
  await relay.fetch(
    new Request(new URL(REALTIME_DO_SHARDS_PATH, 'https://do'), {
      method: 'POST',
      body: JSON.stringify({ shard: 'flaky', token: 'first' }),
    }),
  );
  const notifier = durableObjectRealtimeNotifier(namespace, {
    waitUntil: () => {},
  });
  for (const commitSeq of [4, 7]) {
    if (commitSeq === 7) statuses.unshift(503);
    await notifier.notifyCommit('part-1', {
      commitSeq,
      createdAtMs: 0,
      actorId: 'actor-1',
      changes: [],
    });
  }
  // Two failures merge into one record that owes the higher sequence.
  expect(JSON.parse(state.values.get('owed:flaky')!)).toEqual({
    partition: 'part-1',
    owed: { commitSeq: 7 },
  });
  expect(state.alarmAt).not.toBeNull();
  await relay.alarm();
  expect(state.values.has('owed:flaky')).toBe(false);
  expect(statuses).toEqual([]);
  await db.close();
});

test('the notifier retries a failed request to the partition object, then reports it', async () => {
  const commit = {
    commitSeq: 9,
    createdAtMs: 0,
    actorId: 'actor-1',
    changes: [],
  };
  const run = async (statuses: number[]) => {
    const pending: Promise<unknown>[] = [];
    const events: SyncularServerEvent[] = [];
    const delays: number[] = [];
    let requests = 0;
    const notifier = durableObjectRealtimeNotifier(
      {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            requests += 1;
            return new Response(null, { status: statuses.shift() ?? 503 });
          },
        }),
      },
      {
        waitUntil: (promise) => pending.push(promise),
        events: { emit: (event) => events.push(event) },
        retryDelay: async (attempt) => {
          delays.push(attempt);
        },
      },
    );
    // The push sees no failure: the first attempt fails, the retries run
    // in waitUntil.
    await notifier.notifyCommit('part-1', commit);
    await Promise.all(pending);
    return { requests, events, delays };
  };
  // Fails twice, then the partition object takes it: no event.
  expect(await run([503, 500, 204])).toEqual({
    requests: 3,
    events: [],
    delays: [1, 2],
  });
  // Every attempt fails: one event after the third retry.
  expect(await run([])).toEqual({
    requests: 4,
    events: [
      expect.objectContaining({
        type: 'realtime.relay_failed',
        partition: 'part-1',
        commitSeq: 9,
        attempts: 4,
      }),
    ],
    delays: [1, 2, 3],
  });
});
