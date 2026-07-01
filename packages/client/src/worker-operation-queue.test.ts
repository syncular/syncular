import { describe, expect, it } from 'bun:test';
import { createSyncularWorkerOperationQueue } from './worker-operation-queue';

describe('Syncular worker operation queue', () => {
  it('runs operations one at a time in enqueue order', async () => {
    const queue = createSyncularWorkerOperationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run(async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
      return 'first';
    });
    const second = queue.run(() => {
      events.push('second');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst?.();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues after a queued operation rejects', async () => {
    const queue = createSyncularWorkerOperationQueue();
    const events: string[] = [];
    const first = queue.run(() => {
      events.push('first');
      throw new Error('failed');
    });
    const second = queue.run(() => {
      events.push('second');
      return 'second';
    });

    await expect(first).rejects.toThrow('failed');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first', 'second']);
  });
});
