/**
 * A client's stored record carries its last round outcome: the failure code,
 * the failure streak, and the round time. `onError` only sees exceptions
 * outside the catalog, so the record and the `request.handled` event are
 * where a catalog failure such as `sync.schema_not_ready` shows up.
 */
import { expect, test } from 'bun:test';
import { REALTIME_TAG_ROUND } from '@syncular/core';
import {
  compileSchema,
  createRealtimeHub,
  handleSyncRequest,
  MemorySegmentStore,
  type SyncularServerEvent,
} from '@syncular/server';
import {
  makeContext,
  pullHeader,
  requestBytes,
  subFrame,
  sync,
  TEST_SCHEMA,
} from './helpers';

const PARTITION = 'part-1';
const SCHEMA = compileSchema(TEST_SCHEMA);
const CHECKPOINT = {
  partition: PARTITION,
  name: 'tasks-projection',
  schemaVersion: 1,
} as const;

function pull() {
  return [pullHeader(), subFrame('s1', 'tasks', { project_id: ['p1'] }, -1)];
}

async function refused(
  t: ReturnType<typeof makeContext>,
  clientId = 'client-1',
): Promise<void> {
  await expect(
    handleSyncRequest(requestBytes(pull(), clientId), t.ctx),
  ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
}

test('failed rounds accumulate on the client record and a completed round resets them', async () => {
  const events: SyncularServerEvent[] = [];
  const t = makeContext({ events: { emit: (event) => events.push(event) } });
  await sync(t, pull());
  const first = await t.storage.getClientRecord(PARTITION, 'client-1');
  expect(first).toMatchObject({ lastRoundAtMs: t.now.ms });
  expect(first?.lastErrorCode).toBeUndefined();
  expect(first?.consecutiveFailures).toBeUndefined();

  await t.storage.declareCheckpoint(
    PARTITION,
    CHECKPOINT.name,
    SCHEMA.version,
    t.now.ms,
  );
  t.now.ms += 1000;
  await refused(t);
  t.now.ms += 30_000;
  await refused(t);
  const stuck = await t.storage.getClientRecord(PARTITION, 'client-1');
  expect(stuck).toMatchObject({
    lastErrorCode: 'sync.schema_not_ready',
    consecutiveFailures: 2,
    lastRoundAtMs: t.now.ms,
    // The cursor and liveness timestamp keep their last successful values.
    cursor: first?.cursor,
    updatedAtMs: first?.updatedAtMs,
  });

  // The refused rounds name their client on the `request.handled` event.
  const rejected = events.flatMap((event) =>
    event.type === 'request.handled' && event.outcome === 'rejected'
      ? [event]
      : [],
  );
  expect(rejected).toHaveLength(2);
  expect(rejected.map((event) => event.clientId)).toEqual([
    'client-1',
    'client-1',
  ]);

  // The declaring process serves, completes the round and clears the streak.
  const serving = makeContext({
    storage: t.storage,
    checkpoints: [CHECKPOINT],
    clock: () => t.now.ms,
  });
  t.now.ms += 1000;
  await sync(serving, pull());
  const recovered = await t.storage.getClientRecord(PARTITION, 'client-1');
  expect(recovered?.consecutiveFailures).toBeUndefined();
  expect(recovered?.lastErrorCode).toBeUndefined();
  expect(recovered?.lastRoundAtMs).toBe(t.now.ms);
});

test('a client that never completed a round has no record to annotate', async () => {
  const t = makeContext();
  await t.storage.ensureSchema(SCHEMA);
  await t.storage.declareCheckpoint(
    PARTITION,
    CHECKPOINT.name,
    SCHEMA.version,
    t.now.ms,
  );
  await refused(t, 'new-client');
  expect(await t.storage.getClientRecord(PARTITION, 'new-client')).toBe(
    undefined,
  );
});

test('an exception outside the catalog is recorded as sync.internal_error', async () => {
  const t = makeContext();
  await sync(t, pull());
  t.storage.readServeGate = () => Promise.reject(new Error('database down'));
  await expect(
    handleSyncRequest(requestBytes(pull()), t.ctx),
  ).rejects.toThrow();
  expect(await t.storage.getClientRecord(PARTITION, 'client-1')).toMatchObject({
    lastErrorCode: 'sync.internal_error',
    consecutiveFailures: 1,
  });
});

test('a realtime round refused by the serve gate is recorded', async () => {
  const t = makeContext();
  await sync(t, pull());
  await t.storage.declareCheckpoint(
    PARTITION,
    CHECKPOINT.name,
    SCHEMA.version,
    t.now.ms,
  );
  const hub = createRealtimeHub({
    schema: TEST_SCHEMA,
    storage: t.storage,
    segments: new MemorySegmentStore(),
    resolveScopes: t.ctx.resolveScopes,
    clock: () => t.now.ms,
  });
  const session = await hub.connect({
    partition: PARTITION,
    actorId: 'actor-1',
    clientId: 'client-1',
    send: () => {},
  });
  const bytes = requestBytes(pull(), 'client-1');
  const tagged = new Uint8Array(bytes.length + 1);
  tagged[0] = REALTIME_TAG_ROUND;
  tagged.set(bytes, 1);
  await session.handleBinary(tagged);
  session.close();
  expect(await t.storage.getClientRecord(PARTITION, 'client-1')).toMatchObject({
    lastErrorCode: 'sync.schema_not_ready',
    consecutiveFailures: 1,
  });
});

test('a failing record write is reported to onError and never replaces the round outcome', async () => {
  const reported: unknown[] = [];
  const t = makeContext({ onError: (error) => reported.push(error) });
  await sync(t, pull());
  await t.storage.declareCheckpoint(
    PARTITION,
    CHECKPOINT.name,
    SCHEMA.version,
    t.now.ms,
  );
  t.storage.recordClientRoundFailure = () =>
    Promise.reject(new Error('disk full'));
  await refused(t);
  expect(reported).toHaveLength(1);
});
