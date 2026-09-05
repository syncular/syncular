/**
 * Pruning horizon: cursor-behind-horizon reset and retention floors
 * (SPEC.md §4.6).
 */
import { describe, expect, test } from 'bun:test';
import { pruneCommitLog } from '@syncular/server';
import {
  makeContext,
  pullHeader,
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
    const logEpoch = await t.storage.getPartitionLogEpoch('part-1');
    if (logEpoch === undefined) throw new Error('missing epoch');
    await t.storage.pruneCommitsThrough('part-1', { logEpoch, throughSeq: 3 });
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.start.bootstrap).toBe(true);
    expect(s.end.nextCursor).toBe(3);
  });
});

describe('pruneCommitLog retention floors (§4.6)', () => {
  test('a delayed older pass cannot regress a newer committed horizon', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i += 1) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    let reached!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prune = t.storage.pruneCommitsThrough.bind(t.storage);
    t.storage.pruneCommitsThrough = async (partition, query) => {
      if (query.throughSeq === 2) {
        reached();
        await gate;
      }
      return prune(partition, query);
    };
    // Expire cursors so only the configured retained-commit floor constrains each pass.
    const nowMs = t.now.ms + 100 * 24 * 60 * 60 * 1000;
    const older = pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs,
      retention: { minRetainedCommits: 3 },
    });
    await blocked;
    expect(
      await pruneCommitLog({
        storage: t.storage,
        partition: 'part-1',
        nowMs,
        retention: { minRetainedCommits: 1 },
      }),
    ).toBe(4);
    release();
    expect(await older).toBe(4);
    expect(await t.storage.getHorizonSeq('part-1')).toBe(4);
    t.storage.db.close();
  });

  test('rotation after retention reads rejects the stale pruning pass', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const prune = t.storage.pruneCommitsThrough.bind(t.storage);
    t.storage.pruneCommitsThrough = async (partition, query) => {
      await t.storage.rotatePartitionLogEpoch(partition, 'restored', t.now.ms);
      return prune(partition, query);
    };
    await expect(
      pruneCommitLog({
        storage: t.storage,
        partition: 'part-1',
        nowMs: t.now.ms,
        retention: { minRetainedCommits: 0 },
      }),
    ).rejects.toMatchObject({ code: 'sync.storage.prune_epoch_mismatch' });
    expect(await t.storage.getHorizonSeq('part-1')).toBe(0);
    t.storage.db.close();
  });

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

  test('inactive cursors do not hold retention; age force applies', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    if (record === undefined) throw new Error('expected client record');
    await t.storage.putClientRecord('part-1', {
      ...record,
      cursor: 1,
      updatedAtMs: t.now.ms - 100 * 24 * 60 * 60 * 1000, // long inactive
    });
    const horizon = await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      retention: { minRetainedCommits: 2 },
    });
    expect(horizon).toBe(3); // 5 - 2, laggard ignored
  });
});
