/**
 * The `SyncularAdmin` read surface. Driven through the loopback
 * doctrine: real pushes/pulls populate storage, then the admin reads assert
 * what the console will show. No HTTP, no sockets.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealtimeHub,
  type LeaseStore,
  type MemoryBlobStore,
  MemoryLeaseStore,
  RingBufferEvents,
  S3SegmentStore,
  type SegmentMetadata,
  SqliteBlobStore,
  type SqliteServerStorage,
  SyncularAdmin,
} from '@syncular/server';
import {
  del,
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
import { startS3Stub } from './s3-stub';

function adminOf(
  t: TestContext,
  extra?: {
    ring?: RingBufferEvents;
    blobs?: MemoryBlobStore | SqliteBlobStore;
    leases?: LeaseStore;
  },
): SyncularAdmin {
  return new SyncularAdmin({
    storage: t.storage,
    schema: t.ctx.schema,
    segments: t.segments,
    clock: () => t.now.ms,
    ...(extra?.ring !== undefined ? { ring: extra.ring } : {}),
    ...(extra?.blobs !== undefined ? { blobs: extra.blobs } : {}),
    ...(extra?.leases !== undefined ? { leases: extra.leases } : {}),
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
    const { clients, total } = await admin.listClients('part-1');
    expect(total).toBe(1);
    expect(clients).toHaveLength(1);
    const client = clients[0];
    expect(client?.clientId).toBe('client-1');
    expect(client?.actorId).toBe('actor-1');
    expect(client?.cursor).toBe(1);
    expect(client?.lag).toBe(0);
    expect(client?.active).toBe(true);
    expect(client?.subscriptions[0]).toMatchObject({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
  });

  test('lag counts commits the client has not pulled', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    // Two more commits land after the client's last pull (cursor 1).
    await seedTask(t, 'c2', 't2', 'p1');
    await seedTask(t, 'c3', 't3', 'p1');
    const admin = adminOf(t);
    const client = (await admin.listClients('part-1')).clients[0];
    expect(client?.cursor).toBe(1);
    expect(client?.lag).toBe(2);
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
    expect((await admin.listClients('part-1')).clients[0]?.active).toBe(false);
  });
});

describe('clientDetail', () => {
  test('drill-down: record with lag, lease, and the client event slice', async () => {
    const ring = new RingBufferEvents({ capacity: 100 });
    const t = makeContext({ events: ring });
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    await seedTask(t, 'c2', 't2', 'p1'); // one commit of lag
    const leases = new MemoryLeaseStore({ leaseId: () => 'lease_test' });
    await leases.issue(
      'part-1',
      'client-1',
      'actor-1',
      { project_id: ['p1'] },
      t.now.ms,
      60_000,
    );
    const admin = adminOf(t, { ring, leases });
    const detail = await admin.clientDetail('part-1', 'client-1');
    expect(detail.exists).toBe(true);
    expect(detail.client).toMatchObject({
      clientId: 'client-1',
      cursor: 1,
      lag: 1,
      active: true,
    });
    expect(detail.lease).toMatchObject({
      leaseId: 'lease_test',
      actorId: 'actor-1',
      revoked: false,
    });
    // Only this client's events; every one carries its clientId.
    expect(detail.events.length).toBeGreaterThan(0);
    expect(
      detail.events.every(
        (e) => (e as { clientId?: string }).clientId === 'client-1',
      ),
    ).toBe(true);
  });

  test('an unknown client reports exists: false (events still queried)', async () => {
    const t = makeContext();
    const admin = adminOf(t);
    const detail = await admin.clientDetail('part-1', 'ghost');
    expect(detail).toMatchObject({ clientId: 'ghost', exists: false });
    expect(detail.client).toBeUndefined();
    expect(detail.events).toEqual([]);
  });
});

describe('metrics', () => {
  test('ring-derived request/push aggregates + sparkline buckets', async () => {
    const ring = new RingBufferEvents({ capacity: 100 });
    const t = makeContext({ events: ring });
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    const admin = adminOf(t, { ring });
    const m = admin.metrics('part-1', { windowMs: 60_000, buckets: 6 });
    expect(m.partition).toBe('part-1');
    expect(m.requests.count).toBe(2);
    expect(m.requests.perMinute).toBe(2);
    expect(m.requests.errorCount).toBe(0);
    expect(m.requests.errorRate).toBe(0);
    expect(m.pushes).toEqual({ applied: 2, rejected: 0, conflicted: 0 });
    expect(m.buckets.counts).toHaveLength(6);
    expect(m.buckets.counts.reduce((a, b) => a + b, 0)).toBe(2);
    // Virtual clock: both requests land in the newest bucket.
    expect(m.buckets.counts[5]).toBe(2);
  });

  test('another partition’s events do not count; no ring ⇒ zeros', async () => {
    const ring = new RingBufferEvents({ capacity: 100 });
    const t = makeContext({ events: ring });
    await seedTask(t, 'c1', 't1', 'p1');
    const admin = adminOf(t, { ring });
    const other = admin.metrics('elsewhere', { windowMs: 60_000 });
    expect(other.requests.count).toBe(0);
    expect(other.requests.p95Ms).toBe(0);
    const unwired = adminOf(t).metrics('part-1', { windowMs: 60_000 });
    expect(unwired.requests.count).toBe(0);
  });
});

describe('partitions', () => {
  test('listPartitions + partitionsOverview across two partitions', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const admin = adminOf(t);
    // A second partition on the same storage, via a direct commit.
    const tx = await t.storage.begin('part-2');
    await tx.appendCommit({
      clientId: 'c-two',
      clientCommitId: 'k1',
      actorId: 'a2',
      createdAtMs: t.now.ms,
      changes: [],
    });
    await tx.commit();
    await t.storage.touchPartition('part-2', t.now.ms, 'epoch-2');
    expect(await admin.listPartitions()).toEqual(['part-1', 'part-2']);
    const { partitions: overview, total } = await admin.partitionsOverview();
    expect(total).toBe(2);
    expect(overview).toHaveLength(2);
    expect(overview[0]).toMatchObject({
      partition: 'part-1',
      maxCommitSeq: 1,
      knownClients: 1,
      activeClients: 1,
      recommendation: 'up-to-date',
    });
    expect(overview[1]).toMatchObject({
      partition: 'part-2',
      maxCommitSeq: 1,
      knownClients: 0,
      activeClients: 0,
    });
  });
});

describe('subscribeEvents', () => {
  test('streams live events through the admin; undefined when unwired', async () => {
    const ring = new RingBufferEvents({ capacity: 10 });
    const t = makeContext({ events: ring });
    const admin = adminOf(t, { ring });
    const seen: string[] = [];
    const unsubscribe = admin.subscribeEvents((e) => seen.push(e.type));
    expect(unsubscribe).toBeDefined();
    await seedTask(t, 'c1', 't1', 'p1');
    expect(seen).toContain('push.applied');
    expect(seen).toContain('request.handled');
    unsubscribe?.();
    const before = seen.length;
    await seedTask(t, 'c2', 't2', 'p1');
    expect(seen.length).toBe(before);
    expect(adminOf(t).subscribeEvents(() => {})).toBeUndefined();
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
    const segStats = (await admin.stats('part-1')).segments;
    expect(segStats?.count).toBeGreaterThanOrEqual(1);
    expect(segStats?.rowsSegments).toBeGreaterThanOrEqual(1);
  });

  test('blob stats reflect stored blobs', async () => {
    const t = makeContext();
    const blobs = new SqliteBlobStore();
    await blobs.put('part-1', 'sha256:aa', new Uint8Array(64), t.now.ms);
    const admin = adminOf(t, { blobs });
    expect((await admin.stats('part-1')).blobs).toEqual({
      count: 1,
      bytes: 64,
    });
    expect((await admin.stats('other')).blobs).toEqual({ count: 0, bytes: 0 });
  });

  test('S3 segment stats carry the approximate marker through the admin surface', async () => {
    const clock = { ms: 1_750_000_000_000 };
    const stub = startS3Stub({
      bucket: 'segments',
      region: 'auto',
      accessKeyId: 'SYNCULARTESTAKID',
      secretAccessKey: 'syncular-test-secret',
      now: () => clock.ms,
    });
    try {
      const s3 = new S3SegmentStore({
        endpoint: stub.url,
        region: 'auto',
        bucket: 'segments',
        accessKeyId: 'SYNCULARTESTAKID',
        secretAccessKey: 'syncular-test-secret',
        keyPrefix: 'admin-approx/',
      });
      const meta: SegmentMetadata = {
        partition: 'p',
        logEpoch: 'epoch-1',
        table: 'tasks',
        schemaVersion: 1,
        mediaType: 'rows',
        scopeDigest: 'digest-a',
        asOfCommitSeq: 7,
        rowCount: 2,
        rowCursor: null,
        nextRowCursor: null,
      };
      await s3.put(meta, new Uint8Array([1, 2, 3]), clock.ms);
      const t = makeContext();
      const admin = new SyncularAdmin({
        storage: t.storage,
        segments: s3,
        clock: () => t.now.ms,
      });
      const combined = await admin.stats('p');
      expect(combined.segments).toMatchObject({ count: 1, approximate: true });
    } finally {
      stub.stop();
    }
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

describe('traceRow', () => {
  function tracingAdmin(t: TestContext): SyncularAdmin {
    return new SyncularAdmin({
      storage: t.storage,
      schema: t.ctx.schema,
      resolveScopes: t.ctx.resolveScopes,
      clock: () => t.now.ms,
    });
  }

  async function subscribed(t: TestContext): Promise<void> {
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
  }

  test('delivered, scope-mismatch, then pending-pull after a new change', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p2');
    await subscribed(t);
    const admin = tracingAdmin(t);
    const trace = (rowId: string) =>
      admin.traceRow('part-1', { table: 'tasks', rowId, clientId: 'client-1' });

    expect((await trace('t1')).verdict).toBe('delivered');
    const mismatch = await trace('t2');
    expect(mismatch.verdict).toBe('scope-mismatch');
    expect(mismatch.subscriptions[0]?.mismatches).toEqual([
      { variable: 'project_id', rowValue: 'p2', requested: ['p1'] },
    ]);

    await sync(
      t,
      [pushCommit('c3', [upsert('tasks', 't1', taskRow('t1', 'p1', 'again'))])],
      { clientId: 'writer' },
    );
    const pending = await trace('t1');
    expect(pending.verdict).toBe('pending-pull');
    expect(pending.lastChange?.commitSeq).toBe(3);
    expect(pending.client?.cursor).toBe(2);
  });

  test('scope-denied when the actor lost the scope the subscription requests', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await subscribed(t);
    t.scopes.value = { project_id: ['p2'] };
    const trace = await tracingAdmin(t).traceRow('part-1', {
      table: 'tasks',
      rowId: 't1',
      clientId: 'client-1',
    });
    expect(trace.verdict).toBe('scope-denied');
    expect(trace.allowed).toEqual({ project_id: ['p2'] });
    expect(trace.subscriptions[0]).toMatchObject({
      requestedMatch: true,
      effectiveMatch: false,
    });
  });

  test('row-deleted once the client pulled the delete', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [pushCommit('c2', [del('tasks', 't1')])], {
      clientId: 'writer',
    });
    await subscribed(t);
    const trace = await tracingAdmin(t).traceRow('part-1', {
      table: 'tasks',
      rowId: 't1',
      clientId: 'client-1',
    });
    expect(trace.verdict).toBe('row-deleted');
    expect(trace.lastChange).toMatchObject({ commitSeq: 2, op: 'delete' });
  });
});

describe('errors + coverage', () => {
  const push = {
    atMs: 1_000,
    partition: 'part-1',
    actorId: 'actor-1',
    clientCommitId: 'k',
    operations: 1,
  };

  test('groups failures by code and client, newest first', () => {
    const ring = new RingBufferEvents({ capacity: 10 });
    ring.emit({
      ...push,
      type: 'push.rejected',
      clientId: 'client-a',
      code: 'sync.constraint_violation',
      opIndex: 0,
      replay: false,
    });
    ring.emit({
      ...push,
      atMs: 2_000,
      type: 'push.rejected',
      clientId: 'client-a',
      code: 'sync.constraint_violation',
      opIndex: 0,
      replay: false,
    });
    ring.emit({
      ...push,
      type: 'push.conflicted',
      clientId: 'client-b',
      opIndex: 0,
      replay: false,
    });
    ring.emit({
      type: 'push.rejected',
      ...push,
      partition: 'part-2',
      clientId: 'client-c',
      code: 'sync.forbidden',
      opIndex: 0,
      replay: false,
    });
    const t = makeContext();
    t.now.ms = 10_000;
    const summary = adminOf(t, { ring }).errors('part-1');
    expect(summary.coverage).toEqual({
      complete: true,
      fromMs: 10_000 - 300_000,
    });
    expect(summary.byCode).toEqual([
      {
        source: 'push',
        code: 'sync.constraint_violation',
        count: 2,
        clients: 1,
        actors: 1,
        lastAtMs: 2_000,
        sampleClientIds: ['client-a'],
        sampleRows: [],
      },
      {
        source: 'push',
        code: 'sync.version_conflict',
        count: 1,
        clients: 1,
        actors: 1,
        lastAtMs: 1_000,
        sampleClientIds: ['client-b'],
        sampleRows: [],
      },
    ]);
    expect(summary.byClient[0]).toEqual({
      clientId: 'client-a',
      actorId: 'actor-1',
      count: 2,
      lastCode: 'sync.constraint_violation',
      lastAtMs: 2_000,
    });
  });

  test('request failures count toward their client and actor', async () => {
    const ring = new RingBufferEvents({ capacity: 50 });
    const t = makeContext({ events: ring });
    await seedTask(t, 'c1', 't1', 'p1');
    ring.emit({
      type: 'request.handled',
      kind: 'sync',
      atMs: t.now.ms,
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      durationMs: 1,
      bytesIn: 10,
      bytesOut: 0,
      outcome: 'rejected',
      errorCode: 'sync.invalid_request',
      pushCommits: 0,
      pulled: false,
      subscriptions: 0,
    });
    const admin = adminOf(t, { ring });
    expect(admin.errors('part-1').byClient).toEqual([
      {
        clientId: 'client-1',
        actorId: 'actor-1',
        count: 1,
        lastCode: 'sync.invalid_request',
        lastAtMs: t.now.ms,
      },
    ]);
    const actors = await admin.actors('part-1');
    expect(actors.map((a) => [a.actorId, a.recentFailures])).toEqual([
      ['actor-1', 1],
    ]);
  });

  test('a ring that evicted events inside the window reports partial coverage', () => {
    const ring = new RingBufferEvents({ capacity: 2 });
    for (const atMs of [1_000, 2_000, 3_000]) {
      ring.emit({
        ...push,
        atMs,
        type: 'push.applied',
        clientId: 'c',
        replay: false,
      });
    }
    const t = makeContext();
    t.now.ms = 10_000;
    const metrics = adminOf(t, { ring }).metrics('part-1');
    expect(metrics.coverage).toEqual({ complete: false, fromMs: 1_000 });
    expect(metrics.pushes.applied).toBe(2);
    expect(
      metrics.buckets.pushes.reduce((sum, bucket) => sum + bucket.applied, 0),
    ).toBe(2);
  });
});

describe('operator actions', () => {
  test('revokeLease revokes the stored lease and emits lease.revoked', async () => {
    const t = makeContext();
    const leases = new MemoryLeaseStore();
    await leases.issue('part-1', 'client-1', 'actor-1', {}, t.now.ms, 60_000);
    const ring = new RingBufferEvents({ capacity: 10 });
    const admin = new SyncularAdmin({
      storage: t.storage,
      leases,
      events: ring,
      clock: () => t.now.ms,
    });
    const lease = await admin.revokeLease('part-1', 'client-1');
    expect(lease.revoked).toBe(true);
    expect((await leases.get('part-1', 'client-1'))?.revoked).toBe(true);
    expect(ring.query({ type: 'lease.revoked' })).toHaveLength(1);
    await expect(admin.revokeLease('part-1', 'ghost')).rejects.toMatchObject({
      code: 'sync.invalid_request',
    });
  });

  test('prune advances the horizon and reports both values', async () => {
    const t = makeContext();
    for (const n of [1, 2, 3]) await seedTask(t, `c${n}`, `t${n}`, 'p1');
    t.now.ms += 1;
    // Age-forced: every commit is past the force age; one stays retained.
    const admin = new SyncularAdmin({
      storage: t.storage,
      retention: { minRetainedCommits: 1, ageForceMs: 0 },
      clock: () => t.now.ms,
    });
    expect(await admin.prune('part-1')).toEqual({
      previousHorizonSeq: 0,
      horizonSeq: 2,
    });
  });
});

describe('people, delivery, search', () => {
  async function twoDevices(t: TestContext) {
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p2');
    // client-1 subscribes to p1 and holds a socket; client-2 to p2, offline.
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    await sync(
      t,
      [pullHeader(), subFrame('s1', 'tasks', { project_id: ['p2'] }, -1)],
      { clientId: 'client-2' },
    );
    const hub = createRealtimeHub({
      schema: t.ctx.schema,
      storage: t.storage,
      segments: t.segments,
      resolveScopes: t.ctx.resolveScopes,
      clock: () => t.now.ms,
    });
    await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: () => {},
    });
    return SyncularAdmin.fromConfig({ ...t.ctx, realtime: hub });
  }

  test('clients report open sockets and actors group their devices', async () => {
    const t = makeContext();
    const admin = await twoDevices(t);
    const { clients } = await admin.listClients('part-1');
    expect(
      Object.fromEntries(clients.map((c) => [c.clientId, c.connected])),
    ).toEqual({ 'client-1': true, 'client-2': false });
    expect(clients.find((c) => c.clientId === 'client-1')).toMatchObject({
      connectedSinceMs: t.now.ms,
    });
    const actors = await admin.actors('part-1');
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({
      actorId: 'actor-1',
      connected: 1,
      maxLag: 0,
      recentFailures: 0,
    });
    expect(actors[0]?.clients).toHaveLength(2);
  });

  test('rowDelivery gives every client a verdict for one row', async () => {
    const t = makeContext();
    const admin = await twoDevices(t);
    const delivery = await admin.rowDelivery('part-1', 'tasks', 't1');
    expect(
      delivery.clients.map(({ client, verdict }) => [client.clientId, verdict]),
    ).toEqual([
      ['client-2', 'scope-mismatch'],
      ['client-1', 'delivered'],
    ]);
  });

  test('search resolves clients, actors, rows and commits from one id', async () => {
    const t = makeContext();
    const admin = await twoDevices(t);
    const byRow = await admin.search('part-1', 't2');
    expect(byRow.rows).toEqual([{ table: 'tasks', rowId: 't2' }]);
    const byActor = await admin.search('part-1', 'actor-1');
    expect(byActor.actors).toEqual(['actor-1']);
    expect(byActor.clients).toHaveLength(2);
    const bySeq = await admin.search('part-1', '2');
    expect(bySeq.commit).toMatchObject({ commitSeq: 2, clientCommitId: 'c2' });
    const byWrite = await admin.search('part-1', 'c2');
    expect(byWrite.writes).toEqual([
      expect.objectContaining({
        clientId: 'client-1',
        status: 'applied',
        commitSeq: 2,
      }),
    ]);
    await expect(admin.search('part-1', '  ')).rejects.toMatchObject({
      code: 'sync.invalid_request',
    });
  });

  test('listRows pages a table and filters by scope; tableCounts counts rows', async () => {
    const t = makeContext();
    const admin = await twoDevices(t);
    const first = await admin.listRows('part-1', 'tasks', { limit: 1 });
    expect(first.rows.map((row) => row.rowId)).toEqual(['t1']);
    expect(first.rows[0]?.values).toMatchObject({ id: 't1', project_id: 'p1' });
    expect(first.nextAfterRowId).toBe('t1');
    const second = await admin.listRows('part-1', 'tasks', {
      afterRowId: 't1',
      limit: 1,
    });
    expect(second.rows.map((row) => row.rowId)).toEqual(['t2']);
    const scoped = await admin.listRows('part-1', 'tasks', {
      scope: { variable: 'project_id', value: 'p2' },
    });
    expect(scoped.rows.map((row) => row.rowId)).toEqual(['t2']);
    expect(scoped.nextAfterRowId).toBeUndefined();
    expect((await admin.tableCounts('part-1')).tasks).toBe(2);
  });

  test('findWrite returns a rejected outcome with its per-operation code', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pushCommit('c-bad', [upsert('tasks', 't9', taskRow('t9', 'p-denied'))]),
    ]);
    const admin = SyncularAdmin.fromConfig(t.ctx);
    const write = await admin.findWrite('part-1', 'c-bad');
    expect(write.outcomes).toEqual([
      expect.objectContaining({ clientId: 'client-1', status: 'rejected' }),
    ]);
    expect(write.outcomes[0]?.results[0]).toMatchObject({
      status: 'error',
      code: 'sync.forbidden',
    });
  });
});
