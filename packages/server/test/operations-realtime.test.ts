/**
 * Registered-query watch sessions: the per-session watch cap (§1.7
 * `maxWatchesPerSession`) and one refresh at a time per session.
 */
import { expect, test } from 'bun:test';
import {
  decodeRemoteOperationRealtimeMessage,
  encodeRemoteOperationRealtimeMessage,
  type RemoteOperationRealtimeMessage,
  type RemoteOperationResponse,
} from '@syncular/core';
import {
  RemoteOperationRegistry,
  RemoteOperationWatchHub,
  type StoredCommit,
} from '@syncular/server';
import { makeContext } from './helpers';

const OPERATION_ID = 'query/tasks';

/** A query whose runs the test settles one by one once `held` is set. */
function heldQuery() {
  const state = {
    held: false,
    inFlight: 0,
    peak: 0,
    pending: [] as (() => void)[],
    started: undefined as (() => void) | undefined,
  };
  const response: RemoteOperationResponse = {
    revision: 1,
    kind: 'query',
    operationId: OPERATION_ID,
    rows: [],
    maxCommitSeq: 0,
  };
  const operation = {
    kind: 'query' as const,
    id: OPERATION_ID,
    tables: ['tasks'],
    run: (): Promise<RemoteOperationResponse> => {
      if (!state.held) return Promise.resolve(response);
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      return new Promise((resolve) => {
        state.pending.push(() => {
          state.inFlight -= 1;
          resolve(response);
        });
        state.started?.();
      });
    },
  };
  return { state, registry: new RemoteOperationRegistry([operation]) };
}

function watch(watchId: string): Uint8Array {
  return encodeRemoteOperationRealtimeMessage({
    revision: 1,
    kind: 'watch',
    watchId,
    clientId: 'client-1',
    operationId: OPERATION_ID,
    params: null,
  });
}

const TASKS_COMMIT: StoredCommit = {
  commitSeq: 1,
  createdAtMs: 0,
  actorId: 'actor-1',
  changes: [
    { table: 'tasks', rowId: 't1', op: 'upsert', scopes: { project_id: 'p1' } },
  ],
};

test('a session past maxWatchesPerSession answers watch_error sync.limit_exceeded', async () => {
  const { registry } = heldQuery();
  const t = makeContext({ limits: { maxWatchesPerSession: 2 } });
  const sent: RemoteOperationRealtimeMessage[] = [];
  const session = new RemoteOperationWatchHub(registry).connect(
    t.ctx,
    (bytes) => sent.push(decodeRemoteOperationRealtimeMessage(bytes)),
  );
  await session.receive(watch('w1'));
  await session.receive(watch('w2'));
  await session.receive(watch('w3'));
  expect(sent.map((m) => [m.kind, 'watchId' in m ? m.watchId : ''])).toEqual([
    ['snapshot', 'w1'],
    ['snapshot', 'w2'],
    ['watch_error', 'w3'],
  ]);
  expect(sent[2]).toMatchObject({
    code: 'sync.limit_exceeded',
    retryable: false,
  });
  // An unwatch frees the slot.
  await session.receive(
    encodeRemoteOperationRealtimeMessage({
      revision: 1,
      kind: 'unwatch',
      watchId: 'w1',
    }),
  );
  await session.receive(watch('w3'));
  expect(sent.at(-1)).toMatchObject({ kind: 'snapshot', watchId: 'w3' });
  session.close();
});

test("a commit reruns a session's watches one at a time, each once", async () => {
  const { state, registry } = heldQuery();
  const t = makeContext();
  const hub = new RemoteOperationWatchHub(registry);
  const snapshots: string[] = [];
  let snapshotSent: (() => void) | undefined;
  const session = hub.connect(t.ctx, (bytes) => {
    const message = decodeRemoteOperationRealtimeMessage(bytes);
    if (message.kind === 'snapshot') snapshots.push(message.watchId);
    snapshotSent?.();
  });
  for (const id of ['w1', 'w2', 'w3']) await session.receive(watch(id));
  snapshots.length = 0;
  state.held = true;
  const nextStart = () =>
    new Promise<void>((resolve) => {
      state.started = resolve;
    });

  hub.notifyCommit(t.ctx.partition, TASKS_COMMIT);
  expect(state.pending).toHaveLength(1);
  // A second commit while w1 runs queues nothing new: w2 and w3 wait, and
  // w1 is queued once more behind them.
  hub.notifyCommit(t.ctx.partition, TASKS_COMMIT);
  for (let run = 0; run < 4; run++) {
    const started = nextStart();
    const sent = new Promise<void>((resolve) => {
      snapshotSent = resolve;
    });
    state.pending.shift()?.();
    await sent;
    if (run < 3) await started;
  }
  expect(state.peak).toBe(1);
  expect(snapshots).toEqual(['w1', 'w2', 'w3', 'w1']);
  session.close();
});
