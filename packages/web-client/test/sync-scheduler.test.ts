import { expect, test } from 'bun:test';
import {
  ClientSyncError,
  installSyncScheduler,
  type SecurityLifecycle,
  type SyncIdleOptions,
  type SyncIntent,
  type SyncSchedulerClient,
} from '@syncular/client';
import { decodeMessage, type WakeReason } from '@syncular/core';
import {
  makeClient,
  makeServer,
  tableRows,
  taskValues,
  waitFor,
} from './helpers';

class FakeSchedulerClient implements SyncSchedulerClient {
  syncNeeded = false;
  lifecycle: SecurityLifecycle = 'active';
  readonly needed = new Set<
    (reason: 'startup' | 'hello' | WakeReason) => void
  >();
  readonly intents = new Set<(intent: SyncIntent) => void>();
  runs = 0;
  readonly options: SyncIdleOptions[] = [];
  run: () => Promise<unknown> = async () => undefined;

  statusSnapshot(): { readonly syncNeeded: boolean } {
    return { syncNeeded: this.syncNeeded };
  }

  securityLifecycle(): SecurityLifecycle {
    return this.lifecycle;
  }

  syncUntilIdle(options: SyncIdleOptions): Promise<unknown> {
    this.options.push(options);
    this.runs += 1;
    return this.run();
  }

  onSyncNeeded(
    listener: (reason: 'startup' | 'hello' | WakeReason) => void,
  ): () => void {
    this.needed.add(listener);
    return () => this.needed.delete(listener);
  }

  onSyncIntent(listener: (intent: SyncIntent) => void): () => void {
    this.intents.add(listener);
    return () => this.intents.delete(listener);
  }

  wake(): void {
    for (const listener of this.needed) listener('hello');
  }

  intent(intent: SyncIntent): void {
    for (const listener of this.intents) listener(intent);
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('coalesces wake and intent signals into one immediate round', async () => {
  const client = new FakeSchedulerClient();
  const queued: Array<() => void> = [];
  const scheduler = installSyncScheduler(client, {
    schedule: (callback) => (queued.push(callback), () => {}),
  });

  client.wake();
  client.intent({ kind: 'interactive' });
  expect(queued).toHaveLength(1);
  queued.shift()?.();
  await flushPromises();
  expect(client.runs).toBe(1);

  scheduler.stop();
});

test('a queued drive waits 50 ms on one deadline that later intents share', async () => {
  const client = new FakeSchedulerClient();
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const scheduler = installSyncScheduler(client, {
    maxRounds: 3,
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return () => {};
    },
  });

  client.intent({ kind: 'interactive' });
  client.wake();
  client.intent({ kind: 'interactive' });
  expect(timers.map((timer) => timer.delayMs)).toEqual([50]);
  expect(client.runs).toBe(0);
  timers[0]!.callback();
  await flushPromises();
  expect(client.options).toEqual([{ maxRounds: 3, skipEmpty: true }]);

  scheduler.stop();
});

test('runs one sync at a time and preserves an interactive signal mid-round', async () => {
  const client = new FakeSchedulerClient();
  const queued: Array<() => void> = [];
  let release: (() => void) | undefined;
  client.run = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const scheduler = installSyncScheduler(client, {
    schedule: (callback) => (queued.push(callback), () => {}),
  });

  client.intent({ kind: 'interactive' });
  queued.shift()?.();
  expect(client.runs).toBe(1);
  client.intent({ kind: 'interactive' });
  expect(queued).toHaveLength(0);

  release?.();
  await flushPromises();
  expect(queued).toHaveLength(1);
  client.run = async () => undefined;
  queued.shift()?.();
  await flushPromises();
  expect(client.runs).toBe(2);

  scheduler.stop();
});

test('the newest background intent replaces the pending deadline', async () => {
  const client = new FakeSchedulerClient();
  const queued: Array<() => void> = [];
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const scheduler = installSyncScheduler(client, {
    schedule: (callback, delayMs) => {
      if (delayMs === 50) {
        queued.push(callback);
        return () => {};
      }
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  client.intent({ kind: 'background', delayMs: 250 });
  client.intent({ kind: 'background', delayMs: 1_000 });
  expect(
    timers.map(({ delayMs, cancelled }) => ({ delayMs, cancelled })),
  ).toEqual([
    { delayMs: 250, cancelled: true },
    { delayMs: 1_000, cancelled: false },
  ]);

  timers[1]?.callback();
  queued.shift()?.();
  await flushPromises();
  expect(client.runs).toBe(1);

  scheduler.stop();
  client.intent({ kind: 'interactive' });
  expect(queued).toHaveLength(0);
});

test('a drive deadline rejection schedules a background retry with backoff', async () => {
  const client = new FakeSchedulerClient();
  const queued: Array<() => void> = [];
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const errors: unknown[] = [];
  const scheduler = installSyncScheduler(client, {
    onError: (error) => errors.push(error),
    schedule: (callback, delayMs) => {
      if (delayMs === 50) {
        queued.push(callback);
        return () => {};
      }
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const timeout = new ClientSyncError(
    'sync.idle_timeout',
    'syncUntilIdle exceeded its deadline',
    true,
    { timeoutMs: 60_000, rounds: 3 },
  );
  client.run = async () => {
    throw timeout;
  };

  client.wake();
  for (const delayMs of [250, 500]) {
    queued.shift()?.();
    await flushPromises();
    // §7.8: the deadline left a half-finished drive and no client intent.
    expect(timers.at(-1)).toMatchObject({ delayMs, cancelled: false });
    timers.at(-1)?.callback();
  }
  client.run = async () => ({ budgetExhausted: false });
  queued.shift()?.();
  await flushPromises();
  expect(client.runs).toBe(3);
  expect(errors).toEqual([timeout, timeout]);

  // §1.8: an unreachable endpoint waits for the host's connectivity signal.
  client.run = async () => {
    throw new ClientSyncError('sync.transport_failed', 'fetch failed', true, {
      causeKind: 'network',
    });
  };
  const scheduled = timers.length;
  client.wake();
  queued.shift()?.();
  await flushPromises();
  expect(timers).toHaveLength(scheduled);
  expect(queued).toHaveLength(0);
  scheduler.stop();
});

test('budget exhaustion schedules another batch without an external wake', async () => {
  const client = new FakeSchedulerClient();
  const queued: Array<() => void> = [];
  client.run = async () => ({ budgetExhausted: client.runs < 3 });
  const scheduler = installSyncScheduler(client, {
    maxRounds: 1,
    schedule: (callback) => (queued.push(callback), () => {}),
  });
  client.wake();
  for (let round = 1; round <= 3; round++) {
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    await flushPromises();
    expect(client.runs).toBe(round);
  }
  expect(queued).toHaveLength(0);
  client.run = async () => ({ budgetExhausted: true });
  client.wake();
  queued.shift()?.();
  scheduler.stop();
  await flushPromises();
  expect(queued).toHaveLength(0);
});

test('installs on a real SyncClient and runs the startup catch-up round', async () => {
  const server = makeServer();
  const { client, db } = await makeClient(server, {
    clientId: 'scheduler-startup',
  });
  try {
    client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('scheduled', 'p1') },
    ]);
    expect(client.statusSnapshot().syncNeeded).toBe(true);
    const queued: Array<() => void> = [];
    // No `SyncSchedulerClient` cast: the real client satisfies the interface.
    const scheduler = installSyncScheduler(client, {
      schedule: (callback) => (queued.push(callback), () => {}),
    });
    try {
      // Install-time catch-up: queued work is the startup wake-up.
      expect(queued).toHaveLength(1);
      expect(client.statusSnapshot().outbox).toBe(1);
      queued.shift()?.();
      await waitFor(
        () =>
          client.statusSnapshot().syncNeeded === false &&
          client.statusSnapshot().outbox === 0,
        (notify) => client.onChange(notify),
        'startup catch-up round',
      );
      // The round pushed the queued commit and cleared the wake-up.
      expect(client.statusSnapshot().syncNeeded).toBe(false);
      expect(client.commitOutcomes()[0]?.status).toBe('applied');
      expect(tableRows(db, 'tasks')).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  } finally {
    await client.close();
    db.close();
    server.storage.db.close();
  }
});

test('two setWindow calls 10 ms apart ride one pull', async () => {
  const server = makeServer();
  const { client, db, requests } = await makeClient(server, {
    clientId: 'scheduler-coalesce',
  });
  const timers: Array<{ callback: () => void; dueMs: number }> = [];
  let nowMs = 0;
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const timer of timers.splice(0))
      if (timer.dueMs <= nowMs) timer.callback();
      else timers.push(timer);
  };
  const scheduler = installSyncScheduler(client, {
    now: () => nowMs,
    schedule: (callback, delayMs) => {
      timers.push({ callback, dueMs: nowMs + delayMs });
      return () => {};
    },
  });
  try {
    const base = { variable: 'project_id' };
    await client.setWindow(base, ['p1']);
    advance(10);
    await client.setWindow(base, ['p1', 'p2']);
    expect(requests).toHaveLength(0);
    advance(40);
    await waitFor(
      () => client.windowState(base).pending.length === 0,
      (notify) => client.onChange(notify),
      'one coalesced drive',
    );
    const units = requests.map(
      (request) =>
        decodeMessage(request).frames.filter((frame) => frame.type === 'UNIT')
          .length,
    );
    // The first pull carries both units; later rounds of the drive only
    // continue their bootstrap.
    expect(units[0]).toBe(2);
    expect(units.slice(1).every((count) => count === 0)).toBe(true);
  } finally {
    scheduler.stop();
    await client.close();
    db.close();
    server.storage.db.close();
  }
});

test('a skipEmpty drive on an empty replica sends nothing until it has a unit or a list to clear', async () => {
  const server = makeServer();
  const { client, db, httpRounds } = await makeClient(server, {
    clientId: 'scheduler-empty',
  });
  // A fresh replica: no log epoch, no unit list stored on the server.
  db.exec("DELETE FROM _syncular_meta WHERE key = 'logEpoch'");
  try {
    const empty = await client.syncUntilIdle({ skipEmpty: true });
    expect(httpRounds.count).toBe(0);
    expect(empty).toMatchObject({ budgetExhausted: false, pushed: 0 });
    expect(client.diagnosticsSnapshot().lastRound).toBeUndefined();

    const id = client.subscribe({ project_id: 'p1' });
    await client.syncUntilIdle({ skipEmpty: true });
    const withUnit = httpRounds.count;
    expect(withUnit).toBeGreaterThan(0);

    // The server still holds the unit: the release must reach it.
    client.unsubscribe(id);
    await client.syncUntilIdle({ skipEmpty: true });
    const cleared = httpRounds.count;
    expect(cleared).toBeGreaterThan(withUnit);
    expect(client.statusSnapshot().syncNeeded).toBe(false);

    await client.syncUntilIdle({ skipEmpty: true });
    expect(httpRounds.count).toBe(cleared);
    // An explicit drive without the option still runs its round.
    await client.syncUntilIdle();
    expect(httpRounds.count).toBe(cleared + 1);
  } finally {
    await client.close();
    db.close();
    server.storage.db.close();
  }
});

test('the round confirming idle waits 50 ms and carries a claim made in reaction to the data', async () => {
  const server = makeServer();
  const writer = await makeClient(server, { clientId: 'coalesce-writer' });
  writer.client.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
  ]);
  await writer.client.sync();
  const timers: Array<{ callback: () => void; dueMs: number }> = [];
  let nowMs = 0;
  let scheduled = () => {};
  const schedule = (callback: () => void, delayMs: number) => {
    const timer = { callback, dueMs: nowMs + delayMs };
    timers.push(timer);
    scheduled();
    return () => {
      timers.splice(timers.indexOf(timer) >>> 0, 1);
    };
  };
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const timer of timers.splice(0))
      if (timer.dueMs <= nowMs) timer.callback();
      else timers.push(timer);
  };
  const { client, db, requests } = await makeClient(server, {
    clientId: 'coalesce-reader',
    schedule,
  });
  const scheduler = installSyncScheduler(client, {
    now: () => nowMs,
    schedule,
  });
  const unitFrames = () =>
    requests.map(
      (request) =>
        decodeMessage(request).frames.filter((frame) => frame.type === 'UNIT')
          .length,
    );
  try {
    const base = { variable: 'project_id' };
    await client.setWindow(base, ['p1']);
    advance(50);
    // The first round lands t1; the drive then holds its next round.
    await waitFor(
      () =>
        tableRows(db, 'tasks').length === 1 &&
        timers.some((timer) => timer.dueMs === nowMs + 50),
      (notify) => {
        scheduled = notify;
        return client.onChange(notify);
      },
      'the held confirming round',
    );
    expect(unitFrames()).toEqual([1]);
    await client.setWindow(base, ['p1', 'p2']);
    advance(50);
    await waitFor(
      () => client.windowState(base).pending.length === 0,
      (notify) => client.onChange(notify),
      'the claim rides the confirming round',
    );
    // The second and last request registers the list with both units.
    expect(unitFrames()).toEqual([1, 2]);
  } finally {
    scheduler.stop();
    await client.close();
    await writer.client.close();
    db.close();
    writer.db.close();
    server.storage.db.close();
  }
});
