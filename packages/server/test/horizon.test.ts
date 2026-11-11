/**
 * Pruning horizon: cursor-behind-horizon reset and retention floors
 * (SPEC.md §4.6).
 */
import { describe, expect, test } from 'bun:test';
import { pruneCommitLog } from '@syncular/server';
import {
  live,
  makeContext,
  progressFrame,
  pullFrames,
  section,
  sections,
  seedTask,
  sync,
  TestReplica,
} from './helpers';

const P1 = { project_id: 'p1' };

describe('cursors behind the horizon (§4.6)', () => {
  test('a post-bootstrap unit below the horizon answers reset and echoes its cursor', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    await t.storage.setHorizonSeq('part-1', 2);
    const message = await sync(
      t,
      pullFrames([P1], { progress: [progressFrame(P1, 1)] }),
    );
    const s = section(message, P1);
    expect(s.start).toMatchObject({
      status: 'reset',
      reasonCode: 'sync.cursor_expired',
      bootstrap: false,
      fenced: [],
    });
    expect(s.body).toHaveLength(0);
    expect(s.end).toEqual({ type: 'SUB_END', nextCursor: 1 });
    // The unit left the scan set: an active live section without its changes.
    expect(live(message).start.status).toBe('active');
    expect(live(message).commits).toHaveLength(0);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.catchingUp).toEqual([
      { id: section(message, P1).start.id, cursor: -1 },
    ]);
  });

  test('a replica cursor below the horizon or above maxCommitSeq resets the live section', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    await t.storage.setHorizonSeq('part-1', 2);
    for (const cursor of [1, -1, 4]) {
      const message = await sync(t, pullFrames([P1], { cursor, progress: [] }));
      expect(live(message).start).toEqual({
        type: 'LIVE_START',
        status: 'reset',
        reasonCode: 'sync.cursor_expired',
      });
      expect(live(message).commits).toHaveLength(0);
      expect(live(message).end.throughSeq).toBe(-1);
      const record = await t.storage.getClientRecord('part-1', 'client-1');
      expect(record?.catchingUp.map((unit) => unit.cursor)).toEqual([-1]);
      expect(record?.cursor).toBe(-1);
    }
  });

  for (const live_ of [false, true]) {
    test(`pruning during the live read resets ${live_ ? 'the live section' : 'the unit'} before an active section`, async () => {
      const t = makeContext();
      for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
      const read = t.storage.readLiveWindow.bind(t.storage);
      t.storage.readLiveWindow = async (partition, query) => {
        const window = await read(partition, query);
        const logEpoch = await t.storage.getPartitionLogEpoch(partition);
        if (logEpoch === undefined) throw new Error('missing epoch');
        await t.storage.pruneCommitsThrough(partition, {
          logEpoch,
          throughSeq: 3,
        });
        return window;
      };
      const message = await sync(
        t,
        live_
          ? pullFrames([P1], { cursor: 1, progress: [] })
          : pullFrames([P1], { progress: [progressFrame(P1, 1)] }),
      );
      expect(
        message.frames.filter((frame) => frame.type === 'ERROR'),
      ).toHaveLength(0);
      expect(live(message).commits).toHaveLength(0);
      if (live_) {
        expect(live(message).start.status).toBe('reset');
        expect(section(message, P1).start.status).toBe('active');
      } else {
        expect(live(message).start.status).toBe('active');
        expect(section(message, P1).start.status).toBe('reset');
        expect(section(message, P1).end.nextCursor).toBe(1);
      }
      t.storage.db.close();
    });
  }

  test('a cursor exactly at the horizon still pulls from the log (boundary)', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    await t.storage.setHorizonSeq('part-1', 2);
    const message = await sync(
      t,
      pullFrames([P1], { cursor: 2, progress: [] }),
    );
    expect(
      sections(message).get(section(message, P1).start.id)?.start,
    ).toMatchObject({
      status: 'active',
      bootstrap: false,
    });
    expect(live(message).commits.map((c) => c.commitSeq)).toEqual([3]);
    expect(live(message).end.throughSeq).toBe(3);
  });

  test('after a reset the replica re-bootstraps and joins again', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const logEpoch = await t.storage.getPartitionLogEpoch('part-1');
    if (logEpoch === undefined) throw new Error('missing epoch');
    await t.storage.pruneCommitsThrough('part-1', { logEpoch, throughSeq: 3 });
    expect(live(await replica.pull(t)).start.status).toBe('reset');
    expect(replica.cursor).toBe(-1);
    const again = await replica.pull(t);
    expect(section(again, P1).start.bootstrap).toBe(true);
    expect(section(again, P1).end.nextCursor).toBe(3);
    expect(replica.cursor).toBe(3);
    expect(replica.idle).toBe(true);
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
