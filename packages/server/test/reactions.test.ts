import { describe, expect, test } from 'bun:test';
import {
  PermanentReactionError,
  pruneReactions,
  ReactionRunner,
  reactionIdempotencyKey,
  retryDeadLetterReaction,
  RetryableReactionError,
  type ReactionPlanner,
  type ServerStorage,
  type StorageTransaction,
  type SyncularServerEvent,
} from '@syncular/server';
import {
  makeContext,
  overlapAfterTwoOptimisticMisses,
  pushCommit,
  pushResults,
  seedTask,
  sync,
  taskRow,
  upsert,
} from './helpers';

type TestReactions = {
  'email.send': { readonly taskId: string };
};

const planner: ReactionPlanner<TestReactions> = ({ operations }) =>
  operations
    .filter((operation) => operation.op === 'upsert')
    .map((operation) => ({
      key: `task:${operation.rowId}`,
      type: 'email.send',
      version: 1,
      payload: { taskId: operation.rowId },
      maxAttempts: 3,
    }));

describe('durable reaction planning', () => {
  test('handler idempotency keys isolate partitions and tuple boundaries', () => {
    expect(
      reactionIdempotencyKey('part-1', 'client', 'commit', 'work'),
    ).not.toBe(reactionIdempotencyKey('part-2', 'client', 'commit', 'work'));
    expect(reactionIdempotencyKey('p', 'a:b', 'c', 'd')).not.toBe(
      reactionIdempotencyKey('p', 'a', 'b:c', 'd'),
    );
  });

  test('accepted commit and reaction enqueue land atomically', async () => {
    const events: SyncularServerEvent[] = [];
    const t = makeContext({
      reactionPlanner: planner,
      events: { emit: (event) => events.push(event) },
    });
    const result = await sync(t, [
      pushCommit('commit-1', [
        upsert('tasks', 'task-1', taskRow('task-1', 'p1')),
      ]),
    ]);
    expect(pushResults(result)[0]?.status).toBe('applied');
    expect(
      await t.storage.getReaction?.(
        'part-1',
        reactionIdempotencyKey('part-1', 'client-1', 'commit-1', 'task:task-1'),
      ),
    ).toMatchObject({
      status: 'pending',
      sourceCommitSeq: 1,
      payload: { taskId: 'task-1' },
    });
    expect(events.filter((event) => event.type === 'reaction.queued')).toEqual([
      expect.objectContaining({
        commitSeq: 1,
        reactionType: 'email.send',
      }),
    ]);
  });

  test('enqueue failure rolls back the row, commit log, and reaction', async () => {
    const base = makeContext({ reactionPlanner: planner });
    const storage = new Proxy(base.storage, {
      get(target, property) {
        if (property === 'begin') {
          return async (partition: string): Promise<StorageTransaction> => {
            const tx = await target.begin(partition);
            return new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === 'enqueueReactions') {
                  return async () => {
                    throw new Error('injected enqueue failure');
                  };
                }
                const value = Reflect.get(txTarget, txProperty, txTarget);
                return typeof value === 'function'
                  ? value.bind(txTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const t = { ...base, ctx: { ...base.ctx, storage } };
    await expect(
      sync(t, [
        pushCommit('commit-fails', [
          upsert('tasks', 'task-fails', taskRow('task-fails', 'p1')),
        ]),
      ]),
    ).rejects.toThrow('injected enqueue failure');
    expect(
      await base.storage.getRow('part-1', 'tasks', 'task-fails'),
    ).toBeUndefined();
    expect(await base.storage.getMaxCommitSeq('part-1')).toBe(0);
    expect(await base.storage.listReactions?.('part-1', { limit: 10 })).toEqual(
      [],
    );
  });

  test('rejected commits do not call the planner or enqueue', async () => {
    let plannerCalls = 0;
    const t = makeContext({
      reactionPlanner: (input) => {
        plannerCalls += 1;
        return planner(input);
      },
    });
    const result = await sync(t, [
      pushCommit('rejected', [
        upsert('tasks', 'forbidden', taskRow('forbidden', 'p9')),
      ]),
    ]);
    expect(pushResults(result)[0]?.status).toBe('rejected');
    expect(plannerCalls).toBe(0);
    expect(await t.storage.listReactions?.('part-1', { limit: 10 })).toEqual(
      [],
    );
  });

  test('conflicted commits do not call the planner or enqueue', async () => {
    const base = makeContext();
    await seedTask(base, 'seed', 'task-1', 'p1');
    let plannerCalls = 0;
    const t = {
      ...base,
      ctx: {
        ...base.ctx,
        reactionPlanner: (input: Parameters<typeof planner>[0]) => {
          plannerCalls += 1;
          return planner(input);
        },
      },
    };
    const result = await sync(t, [
      pushCommit('conflict', [
        upsert('tasks', 'task-1', taskRow('task-1', 'p1'), 0),
      ]),
    ]);
    expect(pushResults(result)[0]?.results[0]?.status).toBe('conflict');
    expect(plannerCalls).toBe(0);
    expect(await base.storage.listReactions?.('part-1', { limit: 10 })).toEqual(
      [],
    );
  });

  test('idempotency replay neither replans nor enqueues twice', async () => {
    let plannerCalls = 0;
    const t = makeContext({
      reactionPlanner: (input) => {
        plannerCalls += 1;
        return planner(input);
      },
    });
    const commit = pushCommit('duplicate', [
      upsert('tasks', 'task-1', taskRow('task-1', 'p1')),
    ]);
    expect(pushResults(await sync(t, [commit]))[0]?.status).toBe('applied');
    expect(pushResults(await sync(t, [commit]))[0]?.status).toBe('cached');
    expect(plannerCalls).toBe(1);
    expect(
      await t.storage.listReactions?.('part-1', { limit: 10 }),
    ).toHaveLength(1);
  });

  test('overlapping duplicate deliveries plan and enqueue once', async () => {
    let plannerCalls = 0;
    const base = makeContext({
      reactionPlanner: (input) => {
        plannerCalls += 1;
        return planner(input);
      },
    });
    const storage = overlapAfterTwoOptimisticMisses(base.storage);
    const t = { ...base, ctx: { ...base.ctx, storage } };
    const commit = pushCommit('overlapping', [
      upsert('tasks', 'task-1', taskRow('task-1', 'p1')),
    ]);
    const results = await Promise.all([sync(t, [commit]), sync(t, [commit])]);
    expect(
      results.map((result) => pushResults(result)[0]?.status).sort(),
    ).toEqual(['applied', 'cached']);
    expect(plannerCalls).toBe(1);
    expect(
      await base.storage.listReactions?.('part-1', { limit: 10 }),
    ).toHaveLength(1);
  });

  test('planner candidate reads observe the accepted staged state', async () => {
    let observedTitle: unknown;
    const t = makeContext({
      reactionPlanner: async ({ read }) => {
        observedTitle = (await read.getRow('tasks', 'task-1'))?.row.title;
        return [];
      },
    });
    await sync(t, [
      pushCommit('candidate', [
        upsert('tasks', 'task-1', taskRow('task-1', 'p1', 'candidate')),
      ]),
    ]);
    expect(observedTitle).toBe('candidate');
  });

  test('oversized planner payload fails before the source commit lands', async () => {
    const t = makeContext({
      reactionPlanner: () => [
        {
          key: 'oversized',
          type: 'email.send',
          version: 1,
          payload: { body: 'x'.repeat(65_536) },
        },
      ],
    });
    await expect(
      sync(t, [
        pushCommit('oversized', [
          upsert('tasks', 'task-1', taskRow('task-1', 'p1')),
        ]),
      ]),
    ).rejects.toThrow('exceeds 65536 persisted bytes');
    expect(await t.storage.getMaxCommitSeq('part-1')).toBe(0);
    expect(await t.storage.getRow('part-1', 'tasks', 'task-1')).toBeUndefined();
  });
});

describe('reaction delivery', () => {
  test('SQLite claims wait outside an open authoritative push transaction', async () => {
    const base = makeContext();
    const seed = await base.storage.begin('part-1');
    await seed.enqueueReactions?.([
      {
        idempotencyKey: '["seed","seed","task:queued"]',
        type: 'email.send',
        version: 1,
        payload: { taskId: 'queued' },
        sourceClientId: 'seed',
        sourceClientCommitId: 'seed',
        sourceCommitSeq: 0,
        createdAtMs: base.now.ms,
        maxAttempts: 3,
      },
    ]);
    await seed.commit();
    let enteredPlanner!: () => void;
    const plannerEntered = new Promise<void>((resolve) => {
      enteredPlanner = resolve;
    });
    let releasePlanner!: () => void;
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const t = {
      ...base,
      ctx: {
        ...base.ctx,
        reactionPlanner: async () => {
          enteredPlanner();
          await plannerGate;
          return [];
        },
      },
    };
    const push = sync(t, [
      pushCommit('open-push', [
        upsert('tasks', 'task-1', taskRow('task-1', 'p1')),
      ]),
    ]);
    await plannerEntered;
    let deliveries = 0;
    const runner = new ReactionRunner<TestReactions>({
      storage: base.storage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': () => {
          deliveries += 1;
        },
      },
      clock: () => base.now.ms,
    });
    const delivery = runner.runOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveries).toBe(0);
    releasePlanner();
    await push;
    expect((await delivery).completed).toBe(1);
    expect(deliveries).toBe(1);
  });

  test('handler success acknowledges the reaction and emits lifecycle events', async () => {
    const events: SyncularServerEvent[] = [];
    const t = makeContext({ reactionPlanner: planner });
    await seedTask(t, 'commit-1', 'task-1', 'p1');
    const handled: string[] = [];
    const runner = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': async ({ idempotencyKey, extendLease }) => {
          await extendLease();
          handled.push(idempotencyKey);
        },
      },
      events: { emit: (event) => events.push(event) },
      clock: () => t.now.ms,
    });
    expect(await runner.runOnce()).toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      deadLettered: 0,
      lostLeases: 0,
    });
    expect(handled).toEqual([
      reactionIdempotencyKey('part-1', 'client-1', 'commit-1', 'task:task-1'),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      'reaction.started',
      'reaction.completed',
    ]);
    expect(
      await t.storage.getReaction?.('part-1', handled[0] ?? ''),
    ).toMatchObject({ status: 'completed', attempts: 1 });
  });

  test('retryable failure uses bounded backoff and later succeeds', async () => {
    const t = makeContext({ reactionPlanner: planner });
    await seedTask(t, 'commit-1', 'task-1', 'p1');
    let calls = 0;
    const runner = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': () => {
          calls += 1;
          if (calls === 1)
            throw new RetryableReactionError('email.unavailable');
        },
      },
      clock: () => t.now.ms,
      initialBackoffMs: 100,
      maxBackoffMs: 250,
    });
    expect((await runner.runOnce()).retried).toBe(1);
    const key = reactionIdempotencyKey(
      'part-1',
      'client-1',
      'commit-1',
      'task:task-1',
    );
    expect(await t.storage.getReaction?.('part-1', key)).toMatchObject({
      status: 'pending',
      availableAtMs: t.now.ms + 100,
      lastFailure: { code: 'email.unavailable' },
    });
    expect((await runner.runOnce()).claimed).toBe(0);
    t.now.ms += 100;
    expect((await runner.runOnce()).completed).toBe(1);
    expect(await t.storage.getReaction?.('part-1', key)).toMatchObject({
      status: 'completed',
      attempts: 2,
    });
  });

  test('permanent failure is dead-lettered with bounded failure information', async () => {
    const t = makeContext({ reactionPlanner: planner });
    await seedTask(t, 'commit-1', 'task-1', 'p1');
    const runner = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': () => {
          throw new PermanentReactionError('email.invalid_recipient', {
            reason: 'invalid_address',
          });
        },
      },
      clock: () => t.now.ms,
    });
    expect((await runner.runOnce()).deadLettered).toBe(1);
    expect(
      await t.storage.getReaction?.(
        'part-1',
        reactionIdempotencyKey('part-1', 'client-1', 'commit-1', 'task:task-1'),
      ),
    ).toMatchObject({
      status: 'dead-letter',
      lastFailure: {
        code: 'email.invalid_recipient',
        details: { reason: 'invalid_address' },
      },
    });
    expect(
      await retryDeadLetterReaction({
        storage: t.storage,
        partition: 'part-1',
        idempotencyKey: reactionIdempotencyKey(
          'part-1',
          'client-1',
          'commit-1',
          'task:task-1',
        ),
        nowMs: t.now.ms + 1,
      }),
    ).toBe(true);
    expect(
      await t.storage.getReaction?.(
        'part-1',
        reactionIdempotencyKey('part-1', 'client-1', 'commit-1', 'task:task-1'),
      ),
    ).toMatchObject({ status: 'pending', attempts: 0 });
  });

  test('crash after side effect and before acknowledgement redelivers with the same key', async () => {
    const t = makeContext({ reactionPlanner: planner });
    await seedTask(t, 'commit-1', 'task-1', 'p1');
    const deliveries: string[] = [];
    const crashingStorage = new Proxy<ServerStorage>(t.storage, {
      get(target, property) {
        if (property === 'completeReaction' || property === 'failReaction') {
          return async () => {
            throw new Error('worker crashed before acknowledgement');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const first = new ReactionRunner<TestReactions>({
      storage: crashingStorage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': ({ idempotencyKey }) => {
          deliveries.push(idempotencyKey);
        },
      },
      clock: () => t.now.ms,
      leaseDurationMs: 100,
    });
    await expect(first.runOnce()).rejects.toThrow(
      'worker crashed before acknowledgement',
    );
    t.now.ms += 100;
    const second = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-2',
      handlers: {
        'email.send': ({ idempotencyKey }) => {
          deliveries.push(idempotencyKey);
        },
      },
      clock: () => t.now.ms,
      leaseDurationMs: 100,
    });
    expect((await second.runOnce()).completed).toBe(1);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toBe(deliveries[1]);
  });

  test('concurrent workers do not normally execute one lease concurrently', async () => {
    const t = makeContext({ reactionPlanner: planner });
    await seedTask(t, 'commit-1', 'task-1', 'p1');
    let deliveries = 0;
    const makeRunner = (workerId: string) =>
      new ReactionRunner<TestReactions>({
        storage: t.storage,
        partition: 'part-1',
        workerId,
        handlers: {
          'email.send': () => {
            deliveries += 1;
          },
        },
        clock: () => t.now.ms,
      });
    const results = await Promise.all([
      makeRunner('worker-1').runOnce(),
      makeRunner('worker-2').runOnce(),
    ]);
    expect(results[0].claimed + results[1].claimed).toBe(1);
    expect(deliveries).toBe(1);
  });

  test('a stale member of a claimed batch is skipped after another worker reclaims it', async () => {
    const t = makeContext({ reactionPlanner: planner });
    await sync(t, [
      pushCommit('commit-1', [
        upsert('tasks', 'task-1', taskRow('task-1', 'p1')),
        upsert('tasks', 'task-2', taskRow('task-2', 'p1')),
      ]),
    ]);
    let firstStarted!: () => void;
    const firstIsRunning = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deliveries: string[] = [];
    const first = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': async ({ payload, extendLease }) => {
          deliveries.push(`worker-1:${payload.taskId}`);
          if (payload.taskId === 'task-1') {
            t.now.ms += 100;
            await extendLease();
            firstStarted();
            await firstGate;
          }
        },
      },
      clock: () => t.now.ms,
      leaseDurationMs: 100,
    });
    const firstRun = first.runOnce();
    await firstIsRunning;
    const second = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-2',
      handlers: {
        'email.send': ({ payload }) => {
          deliveries.push(`worker-2:${payload.taskId}`);
        },
      },
      clock: () => t.now.ms,
      leaseDurationMs: 100,
    });
    expect(await second.runOnce()).toMatchObject({ claimed: 1, completed: 1 });
    releaseFirst();
    expect(await firstRun).toMatchObject({
      claimed: 2,
      completed: 1,
      lostLeases: 1,
    });
    expect(deliveries).toEqual(['worker-1:task-1', 'worker-2:task-2']);
  });
});

describe('reaction retention', () => {
  test('prunes completed and dead-lettered rows on separate retention floors', async () => {
    const events: SyncularServerEvent[] = [];
    const t = makeContext({ reactionPlanner: planner });
    await seedTask(t, 'commit-1', 'task-1', 'p1');
    await seedTask(t, 'commit-2', 'task-2', 'p1');
    const runner = new ReactionRunner<TestReactions>({
      storage: t.storage,
      partition: 'part-1',
      workerId: 'worker-1',
      handlers: {
        'email.send': ({ payload }) => {
          if (payload.taskId === 'task-2') {
            throw new PermanentReactionError('email.invalid_recipient');
          }
        },
      },
      clock: () => t.now.ms,
    });
    expect(await runner.runOnce()).toMatchObject({
      completed: 1,
      deadLettered: 1,
    });

    t.now.ms += 31 * 24 * 60 * 60 * 1000;
    expect(
      await pruneReactions({
        storage: t.storage,
        partition: 'part-1',
        nowMs: t.now.ms,
        events: { emit: (event) => events.push(event) },
      }),
    ).toMatchObject({
      removedCompleted: 1,
      removedDeadLetter: 0,
      mayHaveMore: false,
    });
    expect(
      await t.storage.getReaction?.(
        'part-1',
        reactionIdempotencyKey('part-1', 'client-1', 'commit-1', 'task:task-1'),
      ),
    ).toBeUndefined();
    expect(
      await t.storage.getReaction?.(
        'part-1',
        reactionIdempotencyKey('part-1', 'client-1', 'commit-2', 'task:task-2'),
      ),
    ).toMatchObject({ status: 'dead-letter' });

    t.now.ms += 60 * 24 * 60 * 60 * 1000;
    expect(
      await pruneReactions({
        storage: t.storage,
        partition: 'part-1',
        nowMs: t.now.ms,
        events: { emit: (event) => events.push(event) },
      }),
    ).toMatchObject({ removedCompleted: 0, removedDeadLetter: 1 });
    expect(
      events.filter((event) => event.type === 'reaction.prune_completed'),
    ).toEqual([
      expect.objectContaining({
        partition: 'part-1',
        limit: 1_000,
        removedCompleted: 1,
        removedDeadLetter: 0,
        mayHaveMore: false,
      }),
      expect.objectContaining({
        partition: 'part-1',
        limit: 1_000,
        removedCompleted: 0,
        removedDeadLetter: 1,
        mayHaveMore: false,
      }),
    ]);
  });

  test('fails closed when storage lacks terminal reaction pruning', async () => {
    const t = makeContext();
    const storage = new Proxy<ServerStorage>(t.storage, {
      get(target, property) {
        if (property === 'pruneReactions') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      pruneReactions({
        storage,
        partition: 'part-1',
        nowMs: t.now.ms,
      }),
    ).rejects.toThrow('storage does not implement durable reaction pruning');
  });
});
