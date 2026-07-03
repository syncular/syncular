/**
 * The `SyncularAdmin` read surface (TODO §2.5). Driven through the loopback
 * doctrine: real pushes/pulls populate storage, then the admin reads assert
 * what the console will show. No HTTP, no sockets.
 */
import { describe, expect, test } from 'bun:test';
import {
  type MemoryBlobStore,
  RingBufferEvents,
  SqliteBlobStore,
  type SqliteServerStorage,
  SyncularAdmin,
} from '@syncular-v2/server';
import {
  makeContext,
  pullHeader,
  pushCommit,
  seedTask,
  subFrame,
  sync,
  type TestContext,
  taskRow,
  upsert,
} from './helpers';

function adminOf(
  t: TestContext,
  extra?: {
    ring?: RingBufferEvents;
    blobs?: MemoryBlobStore | SqliteBlobStore;
  },
): SyncularAdmin {
  return new SyncularAdmin({
    storage: t.storage,
    segments: t.segments,
    clock: () => t.now.ms,
    ...(extra?.ring !== undefined ? { ring: extra.ring } : {}),
    ...(extra?.blobs !== undefined ? { blobs: extra.blobs } : {}),
  });
}

describe('listClients', () => {
  test('reflects a synced client cursor + subscriptions, active flag', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    // A pull with a subscription persists the client record (§8.1).
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const admin = adminOf(t);
    const clients = await admin.listClients('part-1');
    expect(clients).toHaveLength(1);
    const client = clients[0];
    expect(client?.clientId).toBe('client-1');
    expect(client?.actorId).toBe('actor-1');
    expect(client?.cursor).toBe(1);
    expect(client?.active).toBe(true);
    expect(client?.subscriptions[0]).toMatchObject({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
  });

  test('a stale client falls outside the active window', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    // Advance the clock past the default 14-day active window.
    t.now.ms += 15 * 24 * 60 * 60 * 1000;
    const admin = adminOf(t);
    expect((await admin.listClients('part-1'))[0]?.active).toBe(false);
  });
});

describe('listCommits', () => {
  test('newest-first commit metadata, no payloads, table filter', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    // A commit touching docs, so the table filter has something to exclude.
    await sync(t, [
      pushCommit('c3', [upsert('tasks', 't3', taskRow('t3', 'p1'))]),
    ]);
    const admin = adminOf(t);
    const commits = await admin.listCommits('part-1');
    expect(commits.map((c) => c.commitSeq)).toEqual([3, 2, 1]);
    const first = commits[0];
    expect(first).toMatchObject({
      commitSeq: 3,
      clientId: 'client-1',
      clientCommitId: 'c3',
      actorId: 'actor-1',
      changeCount: 1,
      tables: ['tasks'],
    });
    // No payload field leaks into the metadata.
    expect(Object.keys(first ?? {})).not.toContain('payload');

    const limited = await admin.listCommits('part-1', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.commitSeq).toBe(3);

    const tasksOnly = await admin.listCommits('part-1', { table: 'tasks' });
    expect(tasksOnly).toHaveLength(3);
    const docsOnly = await admin.listCommits('part-1', { table: 'docs' });
    expect(docsOnly).toHaveLength(0);
  });

  test('afterSeq resumes the window', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    await seedTask(t, 'c3', 't3', 'p1');
    const admin = adminOf(t);
    const rest = await admin.listCommits('part-1', { afterSeq: 1 });
    expect(rest.map((c) => c.commitSeq)).toEqual([3, 2]);
  });
});

describe('inspectRow', () => {
  test('current version + scopes for an existing row', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const admin = adminOf(t);
    const row = await admin.inspectRow('part-1', 'tasks', 't1');
    expect(row.exists).toBe(true);
    expect(row.serverVersion).toBe(1);
    expect(row.scopes).toEqual({ project_id: 'p1' });
  });

  test('reports a missing row', async () => {
    const t = makeContext();
    const admin = adminOf(t);
    const row = await admin.inspectRow('part-1', 'tasks', 'nope');
    expect(row.exists).toBe(false);
    expect(row.serverVersion).toBeUndefined();
  });
});

describe('scopeActivity', () => {
  test('recent commits touching a scope key via the index', async () => {
    const t = makeContext();
    // Authorize both projects so p2 writes are allowed.
    t.scopes.value = {
      project_id: ['p1', 'p2'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p2');
    await seedTask(t, 'c3', 't3', 'p1');
    const admin = adminOf(t);
    const activity = await admin.scopeActivity('part-1', {
      variable: 'project_id',
      value: 'p1',
    });
    expect(activity.map((a) => a.commitSeq)).toEqual([3, 1]);
    expect(activity[0]).toMatchObject({
      table: 'tasks',
      actorId: 'actor-1',
      changeCount: 1,
    });
  });
});

describe('horizonStatus', () => {
  test('reports max/horizon and recommends a prune when behind', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    // The seeding client's cursor (-1) pins retention while it is active;
    // advancing past the active window frees the age-force floor, so with a
    // zero retain floor a prune becomes recommended.
    t.now.ms += 60 * 24 * 60 * 60 * 1000;
    const admin = new SyncularAdmin({
      storage: t.storage,
      segments: t.segments,
      clock: () => t.now.ms,
      retention: { minRetainedCommits: 0 },
    });
    const status = await admin.horizonStatus('part-1');
    expect(status.maxCommitSeq).toBe(2);
    expect(status.horizonSeq).toBe(0);
    expect(status.retainedCommits).toBe(2);
    expect(status.activeCursorFloor).toBeNull();
    expect(status.recommendation).toBe('prune-recommended');
    expect(status.recommendedHorizonSeq).toBeGreaterThan(0);
  });

  test('up-to-date when an active client cursor pins the log', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    // A pull leaves an active cursor at 1; default floors keep everything.
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const admin = adminOf(t);
    const status = await admin.horizonStatus('part-1');
    expect(status.activeCursorFloor).toBe(1);
    expect(status.recommendation).toBe('up-to-date');
  });
});

describe('stats + event stream', () => {
  test('segment stats reflect built segments', async () => {
    // Force external (stored) delivery so the segment store actually holds
    // bytes — inline segments never touch the store.
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const admin = adminOf(t);
    const segStats = await admin.segmentStats();
    expect(segStats?.count).toBeGreaterThanOrEqual(1);
    expect(segStats?.rowsSegments).toBeGreaterThanOrEqual(1);
  });

  test('blob stats reflect stored blobs', async () => {
    const t = makeContext();
    const blobs = new SqliteBlobStore();
    await blobs.put('part-1', 'sha256:aa', new Uint8Array(64), t.now.ms);
    const admin = adminOf(t, { blobs });
    const blobStats = await admin.blobStats('part-1');
    expect(blobStats).toEqual({ count: 1, bytes: 64 });
    expect(await admin.blobStats('other')).toEqual({ count: 0, bytes: 0 });
  });

  test('events() returns the ring tail; empty when no ring wired', async () => {
    const ring = new RingBufferEvents({ capacity: 50 });
    const t = makeContext({ events: ring });
    const withRing = adminOf(t, { ring });
    await seedTask(t, 'c1', 't1', 'p1');
    expect(withRing.hasEventStream).toBe(true);
    const events = withRing.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'push.applied')).toBe(true);

    const withoutRing = adminOf(t);
    expect(withoutRing.hasEventStream).toBe(false);
    expect(withoutRing.events()).toEqual([]);
  });
});

describe('fromConfig + unsupported storage', () => {
  test('fromConfig reuses config storage/segments/clock', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const admin = SyncularAdmin.fromConfig(t.ctx);
    const commits = await admin.listCommits('part-1');
    expect(commits).toHaveLength(1);
  });

  test('a storage without the admin methods fails loud', async () => {
    // A bare object implementing only the sync-path surface.
    const bare = {
      begin: () => {
        throw new Error('unused');
      },
    } as unknown as SqliteServerStorage;
    const admin = new SyncularAdmin({
      storage: bare,
      clock: () => 0,
    });
    await expect(admin.listClients('p')).rejects.toThrow(/does not implement/);
  });
});
