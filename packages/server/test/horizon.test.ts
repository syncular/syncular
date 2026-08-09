/**
 * Pruning horizon: cursor-behind-horizon reset and retention floors
 * (SPEC.md §4.6).
 */
import { describe, expect, test } from 'bun:test';
import { decodeMessage } from '@syncular/core';
import {
  createSyncResponseStream,
  pruneCommitLog,
  type PruneCompletedEvent,
} from '@syncular/server';
import {
  makeContext,
  pullHeader,
  requestBytes,
  section,
  seedTask,
  subFrame,
  sync,
} from './helpers';

describe('cursor behind the horizon (§4.6)', () => {
  test('answers reset with sync.cursor_expired and echoes the cursor', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    await t.storage.setHorizonSeq('part-1', 2);
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 1),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('reset');
    expect(s.start.reasonCode).toBe('sync.cursor_expired');
    expect(s.start.effectiveScopes).toEqual({});
    expect(s.body).toHaveLength(0);
    expect(s.end.nextCursor).toBe(1); // echoed unchanged
  });

  test('a cursor exactly at the horizon still pulls incrementally (boundary)', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    await t.storage.setHorizonSeq('part-1', 2);
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 2),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.body.filter((f) => f.type === 'COMMIT')).toHaveLength(1);
    expect(s.end.nextCursor).toBe(3);
  });

  test('after reset, the client re-bootstraps with cursor -1', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    await t.storage.setHorizonSeq('part-1', 3);
    await t.storage.pruneCommitsThrough('part-1', 3);
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.start.bootstrap).toBe(true);
    expect(s.end.nextCursor).toBe(3);
  });

  test('a prune that lands during an incremental section expires it before SUB_END', async () => {
    const t = makeContext();
    for (let i = 1; i <= 4; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');

    const readCommitWindow = t.storage.readCommitWindow.bind(t.storage);
    Object.assign(t.storage, {
      readCommitWindow: async (
        ...args: Parameters<typeof readCommitWindow>
      ) => {
        // This hook runs after any check before the storage call and before
        // the real query. A post-read check is the only placement that sees
        // the truncated result and the advanced horizon together.
        expect(
          await pruneCommitLog({
            storage: t.storage,
            partition: 'part-1',
            nowMs: t.now.ms + 1,
            retention: { activeWindowMs: 0, minRetainedCommits: 1 },
          }),
        ).toBe(3);
        return readCommitWindow(...args);
      },
    });

    const stream = await createSyncResponseStream(
      requestBytes([
        pullHeader(),
        subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
      ]),
      t.ctx,
    );
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const responseBytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      responseBytes.set(chunk, offset);
      offset += chunk.length;
    }
    const response = decodeMessage(responseBytes);

    expect(response.frames.map((frame) => frame.type)).toEqual([
      'RESP_HEADER',
      'SUB_START',
      'ERROR',
    ]);
    expect(response.frames.find((frame) => frame.type === 'ERROR')?.code).toBe(
      'sync.cursor_expired',
    );
    expect(response.frames.some((frame) => frame.type === 'SUB_END')).toBe(
      false,
    );
    expect(
      (await t.storage.getClientRecord('part-1', 'client-1'))?.cursor,
    ).toBe(-1);
  });

  test('a horizon that advances exactly to the incremental cursor remains serviceable', async () => {
    const t = makeContext();
    for (let i = 1; i <= 4; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');

    const readCommitWindow = t.storage.readCommitWindow.bind(t.storage);
    Object.assign(t.storage, {
      readCommitWindow: async (
        ...args: Parameters<typeof readCommitWindow>
      ) => {
        expect(
          await pruneCommitLog({
            storage: t.storage,
            partition: 'part-1',
            nowMs: t.now.ms + 1,
            retention: { activeWindowMs: 0, minRetainedCommits: 1 },
          }),
        ).toBe(3);
        return readCommitWindow(...args);
      },
    });

    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 3),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.body.filter((frame) => frame.type === 'COMMIT')).toHaveLength(1);
    expect(s.end.nextCursor).toBe(4);
  });
});

describe('pruneCommitLog retention floors (§4.6)', () => {
  test('never advances past an active client cursor', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    // handleSyncRequest recorded client-1's record; pin its cursor at 2.
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    if (record === undefined) throw new Error('expected client record');
    await t.storage.putClientRecord('part-1', {
      ...record,
      cursor: 2,
      updatedAtMs: t.now.ms,
    });
    const horizon = await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      retention: { minRetainedCommits: 1 },
    });
    expect(horizon).toBe(2);
    expect(await t.storage.getHorizonSeq('part-1')).toBe(2);
  });

  test('always retains the newest commits', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    if (record === undefined) throw new Error('expected client record');
    await t.storage.putClientRecord('part-1', {
      ...record,
      cursor: 5,
      updatedAtMs: t.now.ms,
    });
    const horizon = await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      retention: { minRetainedCommits: 3 },
    });
    expect(horizon).toBe(2); // 5 - 3
  });

  test('advances the horizon before deleting retained history', async () => {
    const t = makeContext();
    for (let i = 1; i <= 4; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    if (record === undefined) throw new Error('expected client record');
    await t.storage.putClientRecord('part-1', {
      ...record,
      cursor: 4,
      updatedAtMs: t.now.ms,
    });

    let deleteObserved = false;
    const pruneCommitsThrough = t.storage.pruneCommitsThrough.bind(t.storage);
    Object.assign(t.storage, {
      pruneCommitsThrough: async (
        ...args: Parameters<typeof pruneCommitsThrough>
      ) => {
        expect(await t.storage.getHorizonSeq(args[0])).toBe(args[1]);
        deleteObserved = true;
        return pruneCommitsThrough(...args);
      },
    });

    expect(
      await pruneCommitLog({
        storage: t.storage,
        partition: 'part-1',
        nowMs: t.now.ms,
        retention: { minRetainedCommits: 1 },
      }),
    ).toBe(3);
    expect(deleteObserved).toBe(true);
  });

  test('repairs deletion after a crash left the horizon pre-advanced', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');

    // This is the durable state left by a crash between the required
    // horizon-first write and the idempotent commit deletion.
    await t.storage.setHorizonSeq('part-1', 3);
    expect(
      await t.storage.readCommitWindow('part-1', {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterSeq: 0,
        throughSeq: 5,
        limitChanges: 10,
      }),
    ).toHaveLength(5);

    expect(
      await pruneCommitLog({
        storage: t.storage,
        partition: 'part-1',
        nowMs: t.now.ms,
        retention: { minRetainedCommits: 2 },
      }),
    ).toBe(3);
    expect(
      (
        await t.storage.readCommitWindow('part-1', {
          table: 'tasks',
          scopeFilter: { project_id: ['p1'] },
          afterSeq: 0,
          throughSeq: 5,
          limitChanges: 10,
        })
      ).map((commit) => commit.commitSeq),
    ).toEqual([4, 5]);
  });

  test('returns and reports a concurrently advanced horizon', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    if (record === undefined) throw new Error('expected client record');
    await t.storage.putClientRecord('part-1', {
      ...record,
      cursor: 2,
      updatedAtMs: t.now.ms,
    });

    const setHorizonSeq = t.storage.setHorizonSeq.bind(t.storage);
    Object.assign(t.storage, {
      setHorizonSeq: async (
        ...args: Parameters<typeof setHorizonSeq>
      ): Promise<void> => {
        await setHorizonSeq(args[0], 4);
        await setHorizonSeq(...args);
      },
    });
    let completed: PruneCompletedEvent | undefined;

    expect(
      await pruneCommitLog({
        storage: t.storage,
        partition: 'part-1',
        nowMs: t.now.ms,
        retention: { minRetainedCommits: 1 },
        events: {
          emit(event) {
            if (event.type === 'prune.completed') completed = event;
          },
        },
      }),
    ).toBe(4);
    expect(completed).toMatchObject({
      previousHorizonSeq: 0,
      horizonSeq: 4,
      advanced: true,
      removedCommits: 4,
    });
    expect(
      (
        await t.storage.readCommitWindow('part-1', {
          table: 'tasks',
          scopeFilter: { project_id: ['p1'] },
          afterSeq: 0,
          throughSeq: 5,
          limitChanges: 10,
        })
      ).map((commit) => commit.commitSeq),
    ).toEqual([5]);
  });

  test('inactive cursors do not hold retention; age force applies', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    if (record === undefined) throw new Error('expected client record');
    await t.storage.putClientRecord('part-1', {
      ...record,
      cursor: 1,
      updatedAtMs: t.now.ms,
    });
    // Full client records preserve the newest activity timestamp, so make
    // the client inactive by advancing the host clock instead of attempting
    // to backdate its record.
    t.now.ms += 100 * 24 * 60 * 60 * 1000;
    const horizon = await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      retention: { minRetainedCommits: 2 },
    });
    expect(horizon).toBe(3); // 5 - 2, laggard ignored
  });
});
