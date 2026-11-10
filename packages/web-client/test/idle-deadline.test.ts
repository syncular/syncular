/**
 * SPEC §7.7: one `syncUntilIdle` drive is bounded by a total deadline, and
 * §1.8: a refused or unreachable endpoint stops without another backoff.
 */
import { expect, test } from 'bun:test';
import { httpSyncTransport } from '@syncular/client';
import { handleSyncRequest } from '@syncular/server';
import {
  makeClient,
  makeServer,
  responseGate,
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
