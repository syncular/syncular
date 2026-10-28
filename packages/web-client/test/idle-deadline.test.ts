/**
 * SPEC §7.7: one `syncUntilIdle` drive is bounded by a total deadline, and
 * §1.8: a refused or unreachable endpoint stops without another backoff.
 */
import { expect, test } from 'bun:test';
import { makeClient, makeServer, responseGate } from './helpers';

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
