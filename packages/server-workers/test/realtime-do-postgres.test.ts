/**
 * `SyncularRealtimeHost` over a caller-built `PostgresServerStorage` (PGlite
 * stands in for PostgreSQL behind Hyperdrive): the host coordinates the
 * storage it was given, and a fresh host over the same database (a Durable
 * Object wake) serves the committed rows. The partition's object relays
 * commits to the shard objects registered with it (§8.9).
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  encodeMessage,
  encodeSparseRow,
  PROTOCOL_WIRE_VERSION,
  registrationDigest,
  type RequestFrame,
  type RowColumn,
  unitId,
} from '@syncular/core';
import {
  compileSchema,
  MemorySegmentStore,
  PostgresServerStorage,
  type ServerSchema,
  SSP2_CONTENT_TYPE,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from '../../server/test/d1-double';
import {
  createWorkersFetchHandler,
  D1ServerStorage,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  durableObjectRealtimeNotifier,
  REALTIME_DO_SHARDS_PATH,
  type RealtimeDOConfig,
  SYNC_DO_REQUEST_PATH,
  SyncularRealtimeHost,
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

const STATE = new FakeDurableObjectState();

const PULL: RequestFrame[] = [
  {
    type: 'PULL_HEADER',
    limitCommits: 100,
    limitSnapshotRows: 100,
    maxSnapshotPages: 4,
    accept: 0b0011,
    cursor: -1,
    registrationDigest: registrationDigest([{ list_id: 'L' }]),
    echoDigest: new Uint8Array(),
  },
  { type: 'UNIT', scopes: { list_id: 'L' } },
  { type: 'PROGRESS', id: unitId({ list_id: 'L' }), cursor: -1 },
];

function pushFrame(id: string): RequestFrame {
  return {
    type: 'PUSH_COMMIT',
    clientCommitId: id,
    clientSeq: 0,
    operations: [
      {
        table: 'tasks',
        rowId: id,
        op: 'upsert',
        payload: encodeSparseRow(COLUMNS, 0, [id, 'L']),
      },
    ],
  };
}

async function round(
  host: SyncularRealtimeHost<PostgresServerStorage>,
  clientId: string,
  frames: RequestFrame[],
) {
  const request = new Request(new URL(SYNC_DO_REQUEST_PATH, 'https://do'), {
    method: 'POST',
    headers: { 'content-type': SSP2_CONTENT_TYPE },
    body: encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'request',
      frames: [
        { type: 'REQ_HEADER', clientId, schemaVersion: 1, logEpoch: 'epoch' },
        ...frames,
      ],
    }).slice().buffer as ArrayBuffer,
  });
  writeRequestIdentityHeaders(request.headers, {
    partition: 'part-1',
    actorId: 'actor-1',
  });
  const response = await host.fetch(request);
  expect(response.status).toBe(200);
  return decodeMessage(new Uint8Array(await response.arrayBuffer())).frames;
}

test('the host serves rounds over a PostgreSQL storage it was given', async () => {
  const db = await PGlite.create();
  const received: PostgresServerStorage[] = [];
  const config: RealtimeDOConfig<PostgresServerStorage> = {
    syncConfig: (storage) => {
      received.push(storage);
      return {
        schema: SCHEMA,
        storage,
        resolveScopes: () => ({ list_id: ['L'] }),
        segments: new MemorySegmentStore(),
      };
    },
  };
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.ensureSchema(compileSchema(SCHEMA));
  await storage.touchPartition('part-1', 0, 'epoch');
  const pushed = await round(
    new SyncularRealtimeHost(STATE, storage, config),
    'writer',
    [pushFrame('t1')],
  );
  expect(pushed).toContainEqual(
    expect.objectContaining({ type: 'PUSH_RESULT', status: 'applied' }),
  );
  expect(received).toEqual([storage]);
  // A wake builds a new host and storage over the same database.
  const woken = new PostgresServerStorage(pgliteExecutor(db));
  const pulled = await round(
    new SyncularRealtimeHost(STATE, woken, config),
    'reader',
    PULL,
  );
  expect(received).toEqual([storage, woken]);
  expect(pulled.some((frame) => frame.type === 'ERROR')).toBe(false);
  expect(pulled).toContainEqual(expect.objectContaining({ type: 'SUB_START' }));
  await db.close();
});

test('a pull-only round runs beside the partition FIFO; a push waits for it', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.ensureSchema(compileSchema(SCHEMA));
  await storage.touchPartition('part-1', 0, 'epoch');
  const host = new SyncularRealtimeHost(STATE, storage, {
    syncConfig: (coordinated) => ({
      schema: SCHEMA,
      storage: coordinated,
      resolveScopes: () => ({ list_id: ['L'] }),
      segments: new MemorySegmentStore(),
    }),
  });
  let release!: () => void;
  const held = host.serialized(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let pushed = false;
  const push = round(host, 'writer', [pushFrame('t1')]).then((frames) => {
    pushed = true;
    return frames;
  });
  const pulled = await round(host, 'reader', PULL);
  expect(pulled.some((frame) => frame.type === 'ERROR')).toBe(false);
  expect(pushed).toBe(false);
  release();
  await held;
  expect(await push).toContainEqual(
    expect.objectContaining({ type: 'PUSH_RESULT', status: 'applied' }),
  );
  await db.close();
});

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
  await durableObjectRealtimeNotifier(namespace).notifyCommit('part-1', {
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

test('sharded realtime refuses D1 and a Worker without the relay notifier', async () => {
  const namespace: DurableObjectNamespaceLike = {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response() }),
  };
  const syncConfig: RealtimeDOConfig['syncConfig'] = (storage) => ({
    schema: SCHEMA,
    storage,
    resolveScopes: () => ({ list_id: ['L'] }),
    segments: new MemorySegmentStore(),
  });
  expect(
    () =>
      new SyncularRealtimeHost(STATE, new D1DatabaseDouble(), {
        syncConfig,
        namespace,
      }),
  ).toThrow('RealtimeDOConfig.namespace needs a storage');
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
  await expect(
    handler(
      new Request('https://worker/sync', { method: 'POST' }),
      {},
      { waitUntil: () => {} },
    ),
  ).rejects.toThrow('sharded realtime runs /sync in the Worker');
});
