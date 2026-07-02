/**
 * Pruning horizon: cursor-behind-horizon reset and retention floors
 * (SPEC.md §4.6).
 */
import { describe, expect, test } from 'bun:test';
import { pruneCommitLog } from '@syncular-v2/server';
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
