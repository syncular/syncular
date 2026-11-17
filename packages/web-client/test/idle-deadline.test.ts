/**
 * SPEC §7.8: one `syncUntilIdle` drive is bounded by a total deadline, and
 * §1.8: a refused or unreachable endpoint stops without another backoff.
 */
import { expect, test } from 'bun:test';
import { httpSyncTransport, installSyncScheduler } from '@syncular/client';
import { handleSyncRequest } from '@syncular/server';
import {
  makeClient,
  makeServer,
  responseGate,
  tableRows,
  taskValues,
  waitFor,
} from './helpers';

test('a transport that never answers rejects with sync.idle_timeout', async () => {
  const local = await makeClient(makeServer(), { clientId: 'idle-deadline' });
  const gate = responseGate();
  local.faults.holdResponseOnce = gate.fault;
  let markComplete!: () => void;
  const completed = new Promise<void>((resolve) => {
    markComplete = resolve;
  });
  const off = local.client.onProgress((progress) => {
    if (progress.state === 'complete') markComplete();
  });

  const drive = local.client.syncUntilIdle({ timeoutMs: 20 });
  await gate.held;
  await expect(drive).rejects.toMatchObject({
    code: 'sync.idle_timeout',
    retryable: true,
    details: { timeoutMs: 20, rounds: 0 },
  });

  // The round was parked, not lost: releasing it lets the drive settle.
  gate.release();
  await completed;
  off();
  await local.client.close();
  local.db.close();
});

test('a deadline that elapses across completed rounds ends the drive as an exhausted budget', async () => {
  const server = makeServer();
  const seeder = await makeClient(server, { clientId: 'idle-seeder' });
  seeder.client.mutate(
    Array.from({ length: 12 }, (_, i) => ({
      table: 'tasks',
      op: 'upsert' as const,
      values: taskValues(`t${i}`, 'p1', `task ${i}`),
    })),
  );
  await seeder.client.sync();
  let rounds = 0;
  const local = await makeClient(server, {
    clientId: 'idle-progress',
    // One row per round: a unit that bootstraps page by page.
    limits: { limitSnapshotRows: 1, maxSnapshotPages: 1, accept: 0b0011 },
    // Every round takes 40 % of the deadline on the client clock.
    transport: async (bytes) => {
      rounds += 1;
      server.now.ms += 24_000;
      return handleSyncRequest(bytes, server.ctxFor('actor-1'));
    },
  });
  local.client.subscribe({ project_id: 'p1' });
  const failed: unknown[] = [];
  const off = local.client.onProgress((progress) => {
    if (progress.state === 'failed') failed.push(progress);
  });

  const drive = await local.client.syncUntilIdle({ timeoutMs: 60_000 });
  // Rounds end at 24 s, 48 s and 72 s; the check before a fourth round ends
  // the drive.
  expect(rounds).toBe(3);
  expect(drive.budgetExhausted).toBe(true);
  expect(drive.segmentRowsApplied).toBe(3);
  expect(drive.bootstrapping).toHaveLength(1);
  expect(local.client.diagnosticsSnapshot().lastRound?.status).toBe(
    'succeeded',
  );
  expect(failed).toEqual([]);

  // The scheduler queues the next drive at once; it resumes the bootstrap.
  const queued: Array<() => void> = [];
  let requeued = Promise.withResolvers<void>();
  const scheduler = installSyncScheduler(local.client, {
    queueMicrotask: (callback) => {
      queued.push(callback);
      requeued.resolve();
    },
  });
  await requeued.promise;
  requeued = Promise.withResolvers<void>();
  queued.shift()?.();
  await requeued.promise;
  expect(rounds).toBe(6);
  expect(tableRows(local.db, 'tasks')).toHaveLength(6);
  expect(failed).toEqual([]);
  scheduler.stop();
  off();
  await local.client.close();
  local.db.close();
});

test('the deadline aborts a silent fetch, and the client syncs again', async () => {
  const server = makeServer();
  const aborted: unknown[] = [];
  let silent = true;
  const fetchStub = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const signal = init?.signal;
    if (silent) {
      silent = false;
      // A silent transport: no answer, no error, until the signal aborts.
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => {
          aborted.push(signal.reason);
          reject(signal.reason);
        });
      });
    }
    const body = new Uint8Array(init?.body as ArrayBuffer);
    const bytes = await handleSyncRequest(body, server.ctxFor('actor-1'));
    return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
  };
  const local = await makeClient(server, {
    clientId: 'idle-abort',
    realtimePolicy: 'off',
    transport: httpSyncTransport('https://sync.test/sync', {
      fetch: Object.assign(fetchStub, { preconnect: fetch.preconnect }),
    }),
  });
  local.client.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'held') },
  ]);

  await expect(
    local.client.syncUntilIdle({ timeoutMs: 20 }),
  ).rejects.toMatchObject({ code: 'sync.idle_timeout', retryable: true });
  expect(aborted).toHaveLength(1);
  expect(aborted[0]).toMatchObject({ code: 'sync.idle_timeout' });
  // The aborted round ends with the deadline's error and releases the loop.
  await waitFor(
    () => {
      const round = local.client.diagnosticsSnapshot().lastRound;
      return (
        round?.status === 'failed' && round.errorCode === 'sync.idle_timeout'
      );
    },
    (notify) => local.client.onDiagnostics(notify),
    'the aborted round settles',
  );
  expect(local.intents.at(-1)).toEqual({ kind: 'background', delayMs: 250 });

  const summary = await local.client.sync();
  expect(summary.pushed).toBe(1);
  expect(local.client.pendingCommits()).toHaveLength(0);
  await local.client.close();
  local.db.close();
});

test('a refused connection stops without scheduling a retry', async () => {
  const local = await makeClient(makeServer(), { clientId: 'idle-refused' });
  const before = local.intents.length;
  local.faults.refuseConnectionOnce = true;

  await expect(
    local.client.syncUntilIdle({ timeoutMs: 5_000 }),
  ).rejects.toMatchObject({ code: 'sync.transport_failed' });
  expect(local.intents.length).toBe(before);
  expect(local.httpRounds.count).toBe(1);

  // Control: a retryable failure the transport does not classify as an
  // unreachable endpoint still schedules the background intent.
  local.faults.dropResponseOnce = true;
  await expect(
    local.client.syncUntilIdle({ timeoutMs: 5_000 }),
  ).rejects.toMatchObject({ code: 'sync.transport_failed' });
  expect(local.intents.at(-1)).toEqual({ kind: 'background', delayMs: 250 });

  await local.client.close();
  local.db.close();
});

test('the deadline must be positive, and the numeric overload still works', async () => {
  const local = await makeClient(makeServer(), { clientId: 'idle-options' });
  for (const timeoutMs of [0, -1, Number.NaN]) {
    await expect(
      local.client.syncUntilIdle({ timeoutMs }),
    ).rejects.toMatchObject({ code: 'sync.invalid_request' });
  }
  const numeric = await local.client.syncUntilIdle(1);
  expect(numeric.budgetExhausted).toBe(false);
  const options = await local.client.syncUntilIdle({ maxRounds: 1 });
  expect(options.budgetExhausted).toBe(false);
  await local.client.close();
  local.db.close();
});
