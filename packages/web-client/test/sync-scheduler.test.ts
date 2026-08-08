import { expect, test } from 'bun:test';
import {
  installSyncScheduler,
  type SecurityLifecycle,
  type SyncIntent,
  type SyncSchedulerClient,
} from '@syncular/client';
import type { WakeReason } from '@syncular/core';

class FakeSchedulerClient implements SyncSchedulerClient {
  syncNeeded = false;
  securityLifecycle: SecurityLifecycle = 'active';
  readonly needed = new Set<
    (reason: 'startup' | 'hello' | WakeReason) => void
  >();
  readonly intents = new Set<(intent: SyncIntent) => void>();
  runs = 0;
  run: () => Promise<unknown> = async () => undefined;

  syncUntilIdle(): Promise<unknown> {
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
    queueMicrotask: (callback) => queued.push(callback),
  });

  client.wake();
  client.intent({ kind: 'interactive' });
  expect(queued).toHaveLength(1);
  queued.shift()?.();
  await flushPromises();
  expect(client.runs).toBe(1);

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
    queueMicrotask: (callback) => queued.push(callback),
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
    queueMicrotask: (callback) => queued.push(callback),
    schedule: (callback, delayMs) => {
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
