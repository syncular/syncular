/**
 * The structured-events seam: correct shapes on every operator-relevant
 * path, fire-and-forget discipline (a throwing sink never affects
 * processing), and zero-cost silence when no sink is configured.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRealtimeHub,
  handleSegmentDownload,
  handleSyncRequest,
  pruneCommitLog,
  type ServerStorage,
  type SyncularServerEvent,
  type SyncularServerEvents,
  syncError,
} from '@syncular/server';
import {
  expectSyncError,
  makeContext,
  pullHeader,
  pushCommit,
  pushResults,
  requestBytes,
  seedTask,
  subFrame,
  sync,
  TEST_SCHEMA,
  type TestContext,
  taskRow,
  upsert,
} from './helpers';

interface Capture {
  readonly sink: SyncularServerEvents;
  readonly events: SyncularServerEvent[];
}

function capture(): Capture {
  const events: SyncularServerEvent[] = [];
  return {
    sink: {
      emit(event) {
        events.push(event);
      },
    },
    events,
  };
}

function eventsContext(): TestContext & Capture {
  const cap = capture();
  const t = makeContext({ events: cap.sink });
  return { ...t, ...cap };
}

function ofType<T extends SyncularServerEvent['type']>(
  events: SyncularServerEvent[],
  type: T,
): Extract<SyncularServerEvent, { type: T }>[] {
  return events.filter(
    (e): e is Extract<SyncularServerEvent, { type: T }> => e.type === type,
  );
}

describe('push events', () => {
  test('applied commit emits push.applied then request.handled ok', async () => {
    const t = eventsContext();
    const bytes = requestBytes([
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const out = await handleSyncRequest(bytes, t.ctx);

    const applied = ofType(t.events, 'push.applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({
      type: 'push.applied',
      atMs: t.now.ms,
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      clientCommitId: 'c1',
      operations: 1,
      commitSeq: 1,
      replay: false,
    });

    const handled = ofType(t.events, 'request.handled');
    expect(handled).toHaveLength(1);
    expect(handled[0]).toEqual({
      type: 'request.handled',
      kind: 'sync',
      atMs: t.now.ms,
      partition: 'part-1',
      actorId: 'actor-1',
      durationMs: 0,
      bytesIn: bytes.length,
      bytesOut: out.length,
      outcome: 'ok',
      pushCommits: 1,
      pulled: false,
      subscriptions: 0,
    });
    // push.applied precedes request.handled (streaming order).
    expect(t.events.indexOf(applied[0] as SyncularServerEvent)).toBeLessThan(
      t.events.indexOf(handled[0] as SyncularServerEvent),
    );
  });

  test('idempotent replay emits push.applied with replay: true', async () => {
    const t = eventsContext();
    const ops = [upsert('tasks', 't1', taskRow('t1', 'p1'))];
    await sync(t, [pushCommit('c1', ops)]);
    await sync(t, [pushCommit('c1', ops)]);
    const applied = ofType(t.events, 'push.applied');
    expect(applied.map((e) => e.replay)).toEqual([false, true]);
    expect(applied[1]?.commitSeq).toBe(1);
  });

  test('version conflict emits push.conflicted', async () => {
    const t = eventsContext();
    await seedTask(t, 'c1', 't1', 'p1');
    // baseVersion 0 against an existing row: the §6.2 lost insert race.
    await sync(t, [
      pushCommit('c2', [upsert('tasks', 't1', taskRow('t1', 'p1'), 0)]),
    ]);
    const conflicted = ofType(t.events, 'push.conflicted');
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0]?.clientCommitId).toBe('c2');
    expect(conflicted[0]?.opIndex).toBe(0);
    expect(ofType(t.events, 'push.rejected')).toHaveLength(0);
  });

  test('rejection emits push.rejected with the terminating code', async () => {
    const t = eventsContext();
    t.scopes.value = { project_id: ['other'] };
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const rejected = ofType(t.events, 'push.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe('sync.forbidden');
    expect(rejected[0]?.operations).toBe(1);
  });

  test('resolver failure emits scopes.resolve_failed on the request path', async () => {
    const t = eventsContext();
    t.scopes.error = true;
    await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
    ]);
    const failed = ofType(t.events, 'scopes.resolve_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.phase).toBe('request');
    expect(failed[0]?.message).toBe('resolver failure');
    expect(ofType(t.events, 'push.rejected')[0]?.code).toBe('sync.forbidden');
  });
});

describe('pull events', () => {
  test('inline bootstrap emits pull.served with segment summaries', async () => {
    const t = eventsContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const served = ofType(t.events, 'pull.served');
    expect(served).toHaveLength(1);
    const sub = served[0]?.subscriptions[0];
    expect(sub).toBeDefined();
    expect(sub?.status).toBe('active');
    expect(sub?.mode).toBe('bootstrap');
    expect(sub?.fromCursor).toBe(-1);
    expect(sub?.nextCursor).toBe(1);
    expect(sub?.segments).toEqual([
      {
        mediaType: 'rows',
        delivery: 'inline',
        origin: 'built',
        bytes: expect.any(Number) as unknown as number,
        rows: 1,
      },
    ]);
    const handled = ofType(t.events, 'request.handled');
    expect(handled[handled.length - 1]?.pulled).toBe(true);
    expect(handled[handled.length - 1]?.subscriptions).toBe(1);
  });

  test('external rows segment reports delivery ref', async () => {
    const cap = capture();
    const t = makeContext({
      events: cap.sink,
      limits: { inlineSegmentMaxBytes: 1 },
    });
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const served = ofType(cap.events, 'pull.served');
    const segment = served[0]?.subscriptions[0]?.segments[0];
    expect(segment?.delivery).toBe('ref');
    expect(segment?.origin).toBe('built');
    expect(segment?.mediaType).toBe('rows');
  });

  test('sqlite image lane reports built then reused', async () => {
    const t = eventsContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    await seedTask(t, 'c3', 't3', 'p1');
    const pull = pullHeader({ limitSnapshotRows: 1, accept: 0b0111 });
    const sub = subFrame('s1', 'tasks', { project_id: ['p1'] }, -1);
    await sync(t, [pull, sub]);
    await sync(t, [pull, sub], { clientId: 'client-2' });
    const served = ofType(t.events, 'pull.served');
    expect(served).toHaveLength(2);
    const first = served[0]?.subscriptions[0]?.segments[0];
    const second = served[1]?.subscriptions[0]?.segments[0];
    expect(first).toMatchObject({
      mediaType: 'sqlite',
      delivery: 'ref',
      origin: 'built',
      rows: 3,
    });
    expect(second).toMatchObject({
      mediaType: 'sqlite',
      delivery: 'ref',
      origin: 'reused',
      rows: 3,
    });
  });

  test('incremental pull reports commits, changes, cursor span', async () => {
    const t = eventsContext();
    const first = await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, first),
    ]);
    const served = ofType(t.events, 'pull.served');
    const sub = served[0]?.subscriptions[0];
    expect(sub?.mode).toBe('incremental');
    expect(sub?.fromCursor).toBe(first);
    expect(sub?.nextCursor).toBe(2);
    expect(sub?.commits).toBe(1);
    expect(sub?.changes).toBe(1);
    expect(sub?.segments).toEqual([]);
  });

  test('revoked and reset sections report their statuses', async () => {
    const t = eventsContext();
    const seq = await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    await t.storage.setHorizonSeq('part-1', seq + 1);
    // Cursor behind the horizon ⇒ reset (sync.cursor_expired).
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, seq),
    ]);
    t.scopes.error = true;
    await sync(t, [
      pullHeader(),
      subFrame('s2', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const served = ofType(t.events, 'pull.served');
    expect(served[0]?.subscriptions[0]).toMatchObject({
      status: 'reset',
      mode: 'none',
      segments: [],
    });
    expect(served[1]?.subscriptions[0]).toMatchObject({
      status: 'revoked',
      mode: 'none',
    });
  });
});

describe('request lifecycle events', () => {
  test('request validation failure emits request.handled rejected', async () => {
    const t = eventsContext();
    const bytes = requestBytes([
      pullHeader(),
      subFrame('dup', 'tasks', {}, -1),
      subFrame('dup', 'tasks', {}, -1),
    ]);
    await expectSyncError(
      handleSyncRequest(bytes, t.ctx),
      'sync.invalid_subscription',
    );
    const handled = ofType(t.events, 'request.handled');
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      outcome: 'rejected',
      errorCode: 'sync.invalid_subscription',
      bytesIn: bytes.length,
      bytesOut: 0,
    });
  });

  test('schema floor emits request.handled schema_floor', async () => {
    const t = eventsContext();
    await sync(t, [pullHeader()], { schemaVersion: 99 });
    const handled = ofType(t.events, 'request.handled');
    expect(handled[0]?.outcome).toBe('schema_floor');
    expect(handled[0]?.bytesOut).toBeGreaterThan(0);
  });

  test('in-band SyncError emits request.handled error with its code', async () => {
    const base = makeContext();
    const cap = capture();
    // Fault only readCommitWindow — pushes seed through the real storage.
    const t = makeContext({
      events: cap.sink,
      storage: wrapStorage(base.storage, () => {
        throw syncError('sync.rate_limited', 'injected');
      }),
    });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 1),
    ]);
    expect(message.frames.some((f) => f.type === 'ERROR')).toBe(true);
    const handled = ofType(cap.events, 'request.handled');
    const last = handled[handled.length - 1];
    expect(last?.outcome).toBe('error');
    expect(last?.errorCode).toBe('sync.rate_limited');
  });

  test('thrown host failure mid-stream emits request.handled error internal', async () => {
    const base = makeContext();
    const cap = capture();
    const t = makeContext({
      events: cap.sink,
      storage: wrapStorage(base.storage, () => {
        throw new Error('db down');
      }),
    });
    await seedTask(t, 'c1', 't1', 'p1');
    await expect(
      sync(t, [
        pullHeader(),
        subFrame('s1', 'tasks', { project_id: ['p1'] }, 1),
      ]),
    ).rejects.toThrow('db down');
    const handled = ofType(cap.events, 'request.handled');
    const last = handled[handled.length - 1];
    expect(last?.outcome).toBe('error');
    expect(last?.errorCode).toBe('internal');
  });
});

/** Delegating storage with a fault injected into readCommitWindow. */
function wrapStorage(
  storage: ServerStorage,
  onReadCommitWindow: () => never,
): ServerStorage {
  return {
    begin: (p) => storage.begin(p),
    getMaxCommitSeq: (p) => storage.getMaxCommitSeq(p),
    getHorizonSeq: (p) => storage.getHorizonSeq(p),
    setHorizonSeq: (p, s) => storage.setHorizonSeq(p, s),
    pruneCommitsThrough: (p, s) => storage.pruneCommitsThrough(p, s),
    getCommitSeqBefore: (p, m) => storage.getCommitSeqBefore(p, m),
    getRow: (p, t, r) => storage.getRow(p, t, r),
    getPushResult: (p, c, id) => storage.getPushResult(p, c, id),
    readCommitWindow: () => onReadCommitWindow(),
    scanRows: (p, q) => storage.scanRows(p, q),
    getClientRecord: (p, c) => storage.getClientRecord(p, c),
    putClientRecord: (p, r) => storage.putClientRecord(p, r),
    listClientCursors: (p) => storage.listClientCursors(p),
  };
}

describe('segment download events', () => {
  test('successful download emits segment.downloaded ok', async () => {
    const cap = capture();
    const t = makeContext({
      events: cap.sink,
      limits: { inlineSegmentMaxBytes: 1 },
    });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const ref = message.frames.find((f) => f.type === 'SEGMENT_REF');
    if (ref?.type !== 'SEGMENT_REF') throw new Error('expected SEGMENT_REF');
    const result = await handleSegmentDownload(t.ctx, {
      segmentId: ref.segmentId,
      scopesHeader: JSON.stringify({ project_id: ['p1'] }),
    });
    const downloaded = ofType(cap.events, 'segment.downloaded');
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]).toMatchObject({
      segmentId: ref.segmentId,
      outcome: 'ok',
      mediaType: 'rows',
      bytes: result.bytes.length,
      durationMs: 0,
    });
  });

  test('failed download emits segment.downloaded error with code', async () => {
    const t = eventsContext();
    await expectSyncError(
      handleSegmentDownload(t.ctx, {
        segmentId: 'sha256:missing',
        scopesHeader: '{}',
      }),
      'sync.not_found',
    );
    const downloaded = ofType(t.events, 'segment.downloaded');
    expect(downloaded[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'sync.not_found',
    });
  });

  test('resolver failure emits scopes.resolve_failed for downloads', async () => {
    const cap = capture();
    const t = makeContext({
      events: cap.sink,
      limits: { inlineSegmentMaxBytes: 1 },
    });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const ref = message.frames.find((f) => f.type === 'SEGMENT_REF');
    if (ref?.type !== 'SEGMENT_REF') throw new Error('expected SEGMENT_REF');
    t.scopes.error = true;
    await expectSyncError(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: JSON.stringify({ project_id: ['p1'] }),
      }),
      'sync.forbidden',
    );
    const failed = ofType(cap.events, 'scopes.resolve_failed');
    expect(failed[0]?.phase).toBe('segment-download');
  });
});

describe('realtime events', () => {
  async function realtimeSetup() {
    const cap = capture();
    const t = makeContext({ events: cap.sink });
    const hub = createRealtimeHub({
      schema: TEST_SCHEMA,
      storage: t.storage,
      resolveScopes: t.ctx.resolveScopes,
      clock: () => t.now.ms,
      events: cap.sink,
    });
    const ctx = { ...t.ctx, realtime: hub };
    await seedTask({ ...t, ctx }, 'c1', 't1', 'p1');
    await sync({ ...t, ctx }, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const sent: Array<string | Uint8Array> = [];
    const session = await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: (data) => {
        sent.push(data);
      },
    });
    return { ...t, ...cap, hub, ctx, session, sent };
  }

  test('session lifecycle emits opened, delta, wake, closed', async () => {
    const s = await realtimeSetup();
    const opened = ofType(s.events, 'realtime.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      sessionId: s.session.sessionId,
      registrations: 1,
      cursor: 1,
      latestSeq: 1,
    });

    // An applied push fans out through the hub → realtime.delta.
    await sync(
      { ...s, ctx: s.ctx },
      [pushCommit('c2', [upsert('tasks', 't2', taskRow('t2', 'p1'))])],
      { clientId: 'client-9' },
    );
    const delta = ofType(s.events, 'realtime.delta');
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({
      sessionId: s.session.sessionId,
      commitSeq: 2,
      changes: 1,
    });
    expect(delta[0]?.bytes).toBeGreaterThan(0);

    s.hub.wake('part-1', 'reset-required');
    const wake = ofType(s.events, 'realtime.wake');
    expect(wake).toHaveLength(1);
    expect(wake[0]?.reason).toBe('reset-required');

    s.session.close();
    s.session.close(); // double close: exactly one event
    const closed = ofType(s.events, 'realtime.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.durationMs).toBe(0);
  });

  test('realtime resolver failure emits scopes.resolve_failed', async () => {
    const cap = capture();
    const t = makeContext();
    t.scopes.error = true;
    const hub = createRealtimeHub({
      schema: TEST_SCHEMA,
      storage: t.storage,
      resolveScopes: t.ctx.resolveScopes,
      clock: () => t.now.ms,
      events: cap.sink,
    });
    await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: () => {},
    });
    const failed = ofType(cap.events, 'scopes.resolve_failed');
    expect(failed[0]?.phase).toBe('realtime');
  });
});

describe('prune events', () => {
  test('prune.completed reports horizon movement and removed counts', async () => {
    const cap = capture();
    const t = makeContext({ events: cap.sink });
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    const last = await seedTask(t, 'c3', 't3', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const horizon = await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      retention: { minRetainedCommits: 0 },
      events: cap.sink,
    });
    expect(horizon).toBe(last);
    const completed = ofType(cap.events, 'prune.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      type: 'prune.completed',
      atMs: t.now.ms,
      partition: 'part-1',
      previousHorizonSeq: 0,
      horizonSeq: last,
      advanced: true,
      removedCommits: 3,
    });

    // Second pass: nothing to do, still observable.
    await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      retention: { minRetainedCommits: 0 },
      events: cap.sink,
    });
    const second = ofType(cap.events, 'prune.completed')[1];
    expect(second).toMatchObject({ advanced: false, removedCommits: 0 });
  });
});

describe('discipline', () => {
  test('a throwing sink never affects request processing', async () => {
    const throwingSink: SyncularServerEvents = {
      emit() {
        throw new Error('sink exploded');
      },
    };
    const t = makeContext({ events: throwingSink });
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(message.frames.some((f) => f.type === 'ERROR')).toBe(false);
    expect(message.frames.some((f) => f.type === 'SUB_END')).toBe(true);

    // Prune survives the same sink.
    await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      events: throwingSink,
    });
  });

  test('no sink configured: everything stays silent and green', async () => {
    const t = makeContext();
    expect(t.ctx.events).toBeUndefined();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
  });

  test('every emitted event is JSON-able and round-trips', async () => {
    const t = eventsContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    t.scopes.error = true;
    await sync(t, [
      pullHeader(),
      subFrame('s2', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    await pruneCommitLog({
      storage: t.storage,
      partition: 'part-1',
      nowMs: t.now.ms,
      events: t.sink,
    });
    expect(t.events.length).toBeGreaterThan(4);
    for (const event of t.events) {
      const roundTripped = JSON.parse(JSON.stringify(event)) as unknown;
      expect(roundTripped).toEqual(event);
    }
  });
});
