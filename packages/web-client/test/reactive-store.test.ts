import { describe, expect, test } from 'bun:test';
import {
  type ClientChangeBatch,
  type CommitOutcome,
  type ClientChangeListener,
  canonicalValue,
  ClientSyncError,
  FOLLOWER_TIMEOUT_CODE,
  LEADER_HANDOVER_CODE,
  type LeadershipState,
  type QueryReadSpec,
  type QuerySnapshot,
  ReactiveClientStore,
  ProgressEmitter,
  type ReactiveQueryClient,
  type SyncProgressListener,
  SyncRoundFailedError,
  type SyncStatusSnapshot,
  type WindowBase,
  type WindowState,
} from '@syncular/client';

interface Row {
  readonly id: string;
  readonly title: string;
  readonly body?: Uint8Array;
}

const STATUS: SyncStatusSnapshot = {
  currentSchemaVersion: 1,
  outbox: 0,
  upgrading: false,
  upgradeKeptTables: false,
  leaseState: undefined,
  schemaFloor: undefined,
  syncNeeded: false,
  previousVersionContext: { present: false },
  securityLifecycle: 'active',
};

const COMPLETE = {
  complete: true,
  pending: [],
  missing: [],
  revoked: [],
} as const;
const BASE: WindowBase = { variable: 'project_id' };

function batch(
  revision: bigint,
  overrides: Partial<ClientChangeBatch> = {},
): ClientChangeBatch {
  return {
    revision,
    tables: [],
    windows: [],
    conflictsChanged: false,
    rejectionsChanged: false,
    outcomesChanged: false,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

class FakeReactiveClient implements ReactiveQueryClient {
  readonly listeners = new Set<ClientChangeListener>();
  readonly progress = new ProgressEmitter();
  readonly reads: QueryReadSpec[] = [];
  readonly setWindowCalls: Array<{
    readonly base: WindowBase;
    readonly units: readonly string[];
  }> = [];
  readonly snapshots: Array<
    QuerySnapshot<object> | Promise<QuerySnapshot<object>>
  > = [];
  statusCalls = 0;
  conflictCalls = 0;
  rejectionCalls = 0;
  outcomeCalls = 0;
  currentStatus = STATUS;
  setWindowFailure: Error | undefined;
  setWindowSyncFailure: Error | undefined;
  setWindowGate: Promise<void> | undefined;

  onChange(listener: ClientChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onProgress(listener: SyncProgressListener): () => void {
    return this.progress.on(listener);
  }

  emit(change: ClientChangeBatch): void {
    for (const listener of this.listeners) listener(change);
  }

  querySnapshot<Result = Record<string, never>>(
    spec: QueryReadSpec,
  ): QuerySnapshot<Result> | Promise<QuerySnapshot<Result>> {
    this.reads.push(spec);
    const next = this.snapshots.shift();
    if (next === undefined) throw new Error('missing fake query snapshot');
    return next as QuerySnapshot<Result> | Promise<QuerySnapshot<Result>>;
  }

  statusSnapshot(): SyncStatusSnapshot | Promise<SyncStatusSnapshot> {
    this.statusCalls += 1;
    return this.currentStatus;
  }

  conflicts(): readonly unknown[] | Promise<readonly unknown[]> {
    this.conflictCalls += 1;
    return [];
  }

  rejections(): readonly unknown[] {
    this.rejectionCalls += 1;
    return [];
  }

  commitOutcomes():
    | readonly CommitOutcome[]
    | Promise<readonly CommitOutcome[]> {
    this.outcomeCalls += 1;
    return [];
  }

  setWindow(base: WindowBase, units: readonly string[]): void | Promise<void> {
    this.setWindowCalls.push({ base, units: [...units] });
    if (this.setWindowSyncFailure !== undefined) {
      throw this.setWindowSyncFailure;
    }
    if (this.setWindowFailure !== undefined) {
      return Promise.reject(this.setWindowFailure);
    }
    return this.setWindowGate;
  }

  /** Units the core window held when the client opened. */
  held: readonly string[] = [];

  windowState(): WindowState {
    return { units: this.held, pending: [], revoked: [] };
  }
}

/** A follower tab's client: leadership changes arrive from the leader link. */
class FakeFollowerClient extends FakeReactiveClient {
  leadership: LeadershipState = {
    state: 'follower',
    leaderClientId: 'lead',
    epoch: 1,
  };
  readonly leadershipListeners = new Set<(state: LeadershipState) => void>();

  leadershipSnapshot(): LeadershipState {
    return this.leadership;
  }

  onLeadershipChange(listener: (state: LeadershipState) => void): () => void {
    this.leadershipListeners.add(listener);
    return () => this.leadershipListeners.delete(listener);
  }

  setLeadership(state: LeadershipState): void {
    this.leadership = state;
    for (const listener of this.leadershipListeners) listener(state);
  }
}

function querySpec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'queries:listTasks:hash',
    sql: 'SELECT id, title FROM tasks WHERE project_id = ?',
    params: ['p1'],
    dependencies: [{ table: 'tasks', scopeKeys: ['project:p1'] }],
    rowKey: (row: Row) => [row.id],
    ...overrides,
  };
}

describe('reactive cache identity', () => {
  test('is typed, deterministic, order-independent where appropriate, and fail-loud', () => {
    expect(canonicalValue(1)).not.toBe(canonicalValue(1n));
    expect(canonicalValue(new Uint8Array([1, 23]))).not.toBe(
      canonicalValue(new Uint8Array([12, 3])),
    );
    expect(canonicalValue({ b: 2, a: 1 })).toBe(canonicalValue({ a: 1, b: 2 }));
    expect(() => canonicalValue(undefined)).toThrow(TypeError);
    expect(() => canonicalValue(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalValue(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalValue(new Date())).toThrow(TypeError);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalValue(cyclic)).toThrow(TypeError);
  });

  test('deduplicates equal observers to one core read', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const store = new ReactiveClientStore(client);
    const left = store.query<Row>(querySpec());
    const right = store.query<Row>(querySpec());

    expect(left).toBe(right);
    const offLeft = left.subscribe(() => undefined);
    const offRight = right.subscribe(() => undefined);
    await drainMicrotasks();

    expect(client.reads).toHaveLength(1);
    expect(left.getSnapshot().phase).toBe('ready');
    offLeft();
    offRight();
    store.dispose();
  });

  test.each([
    [true, 1],
    [false, 0],
  ])(
    'an empty read with incomplete coverage, publishFirstAnswer %p, notifies %p times and exposes its revision',
    async (publishFirstAnswer, notified) => {
      const client = new FakeReactiveClient();
      client.snapshots.push({
        revision: 1n,
        rows: [],
        coverage: { complete: false, pending: [], missing: [], revoked: [] },
      });
      const store = new ReactiveClientStore(client);
      const query = store.query<Row>(querySpec({ publishFirstAnswer }));
      const unread = query.getSnapshot();
      let published = 0;
      const off = query.subscribe(() => (published += 1));
      await drainMicrotasks();

      expect(unread.revision).toBeUndefined();
      expect(published).toBe(notified);
      expect(query.getSnapshot()).toMatchObject({
        rows: [],
        phase: 'loading',
        revision: 1n,
      });
      off();
      store.dispose();
    },
  );
});

describe('scopes events', () => {
  test('a scopes event applies every claimed window again, once', async () => {
    class ScopesClient extends FakeReactiveClient {
      readonly scopes = new Set<() => void>();
      onScopesChanged(listener: () => void): () => void {
        this.scopes.add(listener);
        return () => this.scopes.delete(listener);
      }
    }
    const client = new ScopesClient();
    const store = new ReactiveClientStore(client);
    store.start();
    const retained = store.retainWindow(BASE, ['p1']);
    await retained.ready;
    expect(client.setWindowCalls).toHaveLength(1);
    // An unchanged claim makes no call.
    await store.retainWindow(BASE, ['p1']).ready;
    expect(client.setWindowCalls).toHaveLength(1);
    for (const listener of client.scopes) listener();
    await drainMicrotasks();
    expect(client.setWindowCalls).toEqual([
      { base: BASE, units: ['p1'] },
      { base: BASE, units: ['p1'] },
    ]);
    store.dispose();
    expect(client.scopes.size).toBe(0);
  });
});

describe('leader link recovery', () => {
  test('a coverage claim that failed while the leader was unreachable is claimed again on rebind', async () => {
    const client = new FakeFollowerClient();
    const store = new ReactiveClientStore(client);
    store.start();
    await drainMicrotasks();
    const retained = store.retainWindow(BASE, ['p2']);
    const unreachable = new ClientSyncError(
      FOLLOWER_TIMEOUT_CODE,
      'the follower cannot reach the tab that owns the database',
      true,
    );
    client.setWindowFailure = unreachable;
    client.setLeadership({
      state: 'blocked',
      reason: 'leader-unreachable',
      code: FOLLOWER_TIMEOUT_CODE,
      retryable: true,
    });
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    await expect(retained.ready).rejects.toBe(unreachable);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'blocked',
      availability: { state: 'blocked', reason: 'leader-unreachable' },
    });

    client.setWindowFailure = undefined;
    client.snapshots.push({
      revision: 1n,
      rows: [{ id: 't1', title: 'first' }],
      coverage: COMPLETE,
    });
    const before = client.setWindowCalls.length;
    client.setLeadership({
      state: 'follower',
      leaderClientId: 'lead',
      epoch: 2,
    });
    await drainMicrotasks(24);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      rows: [{ id: 't1', title: 'first' }],
    });
    expect(client.setWindowCalls.slice(before).at(-1)).toEqual({
      base: BASE,
      units: ['p1', 'p2'],
    });
    off();
    const released = retained.release();
    store.dispose();
    await expect(released).rejects.toMatchObject({
      code: 'client.reactive_store_disposed',
    });
  });

  test('a claim rejected during a handover is claimed again when this tab leads', async () => {
    const client = new FakeFollowerClient();
    const store = new ReactiveClientStore(client);
    store.start();
    await drainMicrotasks();
    client.setLeadership({ state: 'waiting', reason: 'handover' });
    client.setWindowFailure = new ClientSyncError(
      'client.worker_failed',
      'the follower link was closed',
    );
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    expect(entry.getSnapshot().phase).toBe('error');

    client.setWindowFailure = undefined;
    client.snapshots.push({
      revision: 1n,
      rows: [{ id: 't1', title: 'first' }],
      coverage: COMPLETE,
    });
    client.setLeadership({ state: 'leader', clientId: 'own' });
    await drainMicrotasks(24);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      rows: [{ id: 't1', title: 'first' }],
    });
    off();
    store.dispose();
  });

  for (const next of [
    { state: 'follower', leaderClientId: 'next', epoch: 2 },
    { state: 'leader', clientId: 'own' },
  ] as const) {
    test(`every active query and value store reads again when this tab becomes ${next.state}`, async () => {
      const client = new FakeFollowerClient();
      const store = new ReactiveClientStore(client);
      const inFlight = deferred<QuerySnapshot<object>>();
      // Each query reads its own queue: the two entries read in either order.
      const byParam = new Map<
        unknown,
        Array<QuerySnapshot<object> | Promise<QuerySnapshot<object>>>
      >([
        ['p1', [inFlight.promise]],
        [
          'p2',
          [
            {
              revision: 1n,
              rows: [{ id: 'other', title: 'from the departed leader' }],
              coverage: COMPLETE,
            },
          ],
        ],
      ]);
      client.querySnapshot = <Result>(spec: QueryReadSpec) => {
        client.reads.push(spec);
        const next = byParam.get(spec.params?.[0])?.shift();
        if (next === undefined) throw new Error('missing fake query snapshot');
        return next as QuerySnapshot<Result> | Promise<QuerySnapshot<Result>>;
      };
      const handedOver = store.query<Row>(querySpec());
      const settled = store.query<Row>(
        querySpec({ id: 'queries:other:hash', params: ['p2'] }),
      );
      const offHandedOver = handedOver.subscribe(() => {});
      const offSettled = settled.subscribe(() => {});
      await drainMicrotasks();
      expect(settled.getSnapshot().phase).toBe('ready');

      const calls = {
        status: client.statusCalls,
        conflicts: client.conflictCalls,
        outcomes: client.outcomeCalls,
      };
      // The link rejects the call in flight, then reports the new leader.
      inFlight.reject(
        new ClientSyncError(
          LEADER_HANDOVER_CODE,
          'the leader changed before it answered the call',
          true,
        ),
      );
      client.setLeadership(next);
      byParam.get('p1')?.push({
        revision: 2n,
        rows: [{ id: 't1', title: 'first' }],
        coverage: COMPLETE,
      });
      byParam.get('p2')?.push({
        revision: 2n,
        rows: [{ id: 'other', title: 'from the next leader' }],
        coverage: COMPLETE,
      });
      await drainMicrotasks(24);

      expect(handedOver.getSnapshot()).toMatchObject({
        phase: 'ready',
        error: undefined,
        rows: [{ id: 't1', title: 'first' }],
      });
      expect(settled.getSnapshot()).toMatchObject({
        phase: 'ready',
        rows: [{ id: 'other', title: 'from the next leader' }],
      });
      expect(client.reads).toHaveLength(4);
      expect(client.statusCalls).toBe(calls.status + 1);
      expect(client.conflictCalls).toBe(calls.conflicts + 1);
      expect(client.outcomeCalls).toBe(calls.outcomes + 1);
      offHandedOver();
      offSettled();
      store.dispose();
    });
  }

  test('a follower of another build reports leader-incompatible availability', async () => {
    const client = new FakeFollowerClient();
    const store = new ReactiveClientStore(client);
    store.start();
    await drainMicrotasks();
    client.setLeadership({
      state: 'blocked',
      reason: 'leader-incompatible',
      code: 'client.leader_incompatible',
      leader: 'older',
      retryable: true,
    });
    expect(store.availabilitySnapshot()).toEqual({
      state: 'blocked',
      reason: 'leader-incompatible',
      currentSchemaVersion: 1,
      leader: 'older',
      retryable: true,
    });
    store.dispose();
  });
});

describe('rejected claim recovery (SPEC §7.8)', () => {
  const failure = () =>
    new ClientSyncError(
      'window.transport_failed',
      'the window edit failed',
      true,
    );
  const ready = {
    revision: 2n,
    rows: [{ id: 't1', title: 'first' }],
    coverage: COMPLETE,
  };

  /** An entry whose only claim was rejected, outside any leadership change. */
  async function rejected() {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    store.start();
    await drainMicrotasks();
    client.setWindowFailure = failure();
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const off = entry.subscribe(() => {});
    await drainMicrotasks(24);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'error',
      error: { code: 'window.transport_failed' },
    });
    expect(client.setWindowCalls).toHaveLength(1);
    client.setWindowFailure = undefined;
    client.snapshots.push(ready, ready);
    return { client, store, entry, off };
  }

  test('a committed change of a dependency claims again', async () => {
    const { client, store, entry, off } = await rejected();
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    await drainMicrotasks(24);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      rows: [{ id: 't1', title: 'first' }],
    });
    expect(client.setWindowCalls).toHaveLength(2);
    off();
    store.dispose();
  });

  test('a window-only batch does not claim again', async () => {
    const { client, store, entry, off } = await rejected();
    client.emit(
      batch(2n, {
        windows: [
          {
            baseKey: 'project_id\0{}',
            units: new Set(['p1']),
          },
        ],
      }),
    );
    await drainMicrotasks(24);
    expect(entry.getSnapshot().phase).toBe('error');
    expect(client.setWindowCalls).toHaveLength(1);
    off();
    store.dispose();
  });

  test('refresh claims again', async () => {
    const { client, store, entry, off } = await rejected();
    entry.refresh();
    await drainMicrotasks(24);
    expect(entry.getSnapshot().phase).toBe('ready');
    expect(client.setWindowCalls).toHaveLength(2);
    off();
    store.dispose();
  });

  test('each new sync attempt claims once again, never in between', async () => {
    const { client, store, entry, off } = await rejected();
    client.setWindowFailure = failure();
    const running = (attempt: number) => ({
      epoch: 'e1',
      attempt,
      state: 'running' as const,
      phase: 'request' as const,
      bytesReceived: 0,
      rowsProcessed: 0,
    });
    client.progress.emit(running(1));
    client.progress.update({ phase: 'download', bytesReceived: 10 });
    await drainMicrotasks(48);
    expect(client.setWindowCalls).toHaveLength(2);
    expect(entry.getSnapshot().phase).toBe('error');
    client.progress.update({
      state: 'failed',
      errorCode: 'sync.transport_failed',
    });
    await drainMicrotasks(48);
    expect(client.setWindowCalls).toHaveLength(2);

    client.setWindowFailure = undefined;
    client.progress.emit(running(2));
    await drainMicrotasks(48);
    expect(client.setWindowCalls).toHaveLength(3);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      rows: [{ id: 't1', title: 'first' }],
    });
    off();
    store.dispose();
  });
});

describe('revision race gates', () => {
  test('never publishes a result older than an observed matching revision', async () => {
    const client = new FakeReactiveClient();
    const stale = deferred<QuerySnapshot<Row>>();
    const fresh = deferred<QuerySnapshot<Row>>();
    client.snapshots.push(stale.promise, fresh.promise);
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(querySpec());
    const published: Array<ReturnType<typeof entry.getSnapshot>> = [];
    const off = entry.subscribe(() => published.push(entry.getSnapshot()));
    await drainMicrotasks();

    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    stale.resolve({
      revision: 1n,
      rows: [{ id: 'old', title: 'stale' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks();

    expect(client.reads).toHaveLength(2);
    expect(published).toHaveLength(0);
    expect(entry.getSnapshot().phase).toBe('loading');

    fresh.resolve({
      revision: 2n,
      rows: [{ id: 'new', title: 'fresh' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks();
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      revision: 2n,
      rows: [{ id: 'new', title: 'fresh' }],
    });
    off();
    store.dispose();
  });

  test('batches that arrive during a read its snapshot covers cost no second read', async () => {
    const client = new FakeReactiveClient();
    const first = deferred<QuerySnapshot<Row>>();
    client.snapshots.push(first.promise);
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(querySpec());
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    // A coalesced apply transaction publishes its blocks' batches together.
    for (const revision of [2n, 3n, 4n])
      client.emit(
        batch(revision, {
          tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
        }),
      );
    first.resolve({
      revision: 4n,
      rows: [{ id: 'a', title: 'a' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(1);
    expect(entry.getSnapshot()).toMatchObject({ phase: 'ready', revision: 4n });
    off();
    store.dispose();
  });

  test('a batch that arrives during a failing read reads again', async () => {
    const client = new FakeReactiveClient();
    const failing = deferred<QuerySnapshot<Row>>();
    client.snapshots.push(failing.promise, {
      revision: 2n,
      rows: [{ id: 'a', title: 'a' }],
      coverage: COMPLETE,
    });
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(querySpec());
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    failing.reject(new Error('read failed'));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(2);
    expect(entry.getSnapshot()).toMatchObject({ phase: 'ready', revision: 2n });
    off();
    store.dispose();
  });

  test('a failed refresh keeps rows and revision but leaves ready phase', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push({
      revision: 1n,
      rows: [{ id: 'one', title: 'first' }],
      coverage: COMPLETE,
    });
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(querySpec());
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();

    const failure = new Error('refresh failed');
    client.snapshots.push(Promise.reject(failure));
    entry.refresh();
    await drainMicrotasks();
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'error',
      revision: 1n,
      rows: [{ id: 'one', title: 'first' }],
      error: failure,
      isRefreshing: false,
    });
    expect(client.reads.at(-1)?.owner).toEqual({
      id: 'queries:listTasks:hash',
      tables: ['tasks'],
    });

    client.snapshots.push({ revision: 2n, rows: [], coverage: COMPLETE });
    entry.refresh();
    await drainMicrotasks();
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      revision: 2n,
      rows: [],
      error: undefined,
    });
    off();
    store.dispose();
  });

  test('zero-row completion changes loading directly to ready atomically', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push({
      revision: 1n,
      rows: [],
      coverage: {
        complete: false,
        pending: [{ baseKey: 'tasks', unit: 'p1' }],
        missing: [],
        revoked: [],
      },
    });
    const gate = deferred<void>();
    client.setWindowGate = gate.promise;
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const phases: string[] = [];
    const off = entry.subscribe(() => phases.push(entry.getSnapshot().phase));
    await drainMicrotasks();
    expect(entry.getSnapshot().phase).toBe('loading');

    client.snapshots.push({ revision: 2n, rows: [], coverage: COMPLETE });
    gate.resolve();
    client.emit(
      batch(2n, {
        windows: [
          {
            baseKey: 'project_id\0{}',
            units: new Set(['p1']),
          },
        ],
      }),
    );
    await drainMicrotasks();

    expect(entry.getSnapshot().phase).toBe('ready');
    expect(entry.getSnapshot().rows).toEqual([]);
    expect(phases).not.toContain('partial');
    off();
    store.dispose();
  });
});

describe('failed sync rounds', () => {
  const PENDING = {
    complete: false,
    pending: [{ baseKey: 'tasks', unit: 'p1' }],
    missing: [],
    revoked: [],
  } as const;
  const windowBatch = (revision: bigint) =>
    batch(revision, {
      windows: [
        {
          baseKey: 'project_id\0{}',
          units: new Set(['p1']),
        },
      ],
    });
  const running = (attempt: number) => ({
    epoch: 'e1',
    attempt,
    state: 'running' as const,
    phase: 'request' as const,
    bytesReceived: 0,
    rowsProcessed: 0,
  });

  test('pending coverage turns error on failure and loading when a retry starts', async () => {
    const client = new FakeReactiveClient();
    // The initial read and the read after claim registration.
    client.snapshots.push(
      { revision: 1n, rows: [], coverage: PENDING },
      { revision: 1n, rows: [], coverage: PENDING },
    );
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({
        coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }],
        publishFirstAnswer: true,
      }),
    );
    const phases: string[] = [];
    const off = entry.subscribe(() => phases.push(entry.getSnapshot().phase));
    await drainMicrotasks();
    expect(entry.getSnapshot().phase).toBe('loading');

    client.progress.emit(running(1));
    client.progress.update({
      state: 'failed',
      errorCode: 'sync.transport_failed',
      retryDelayMs: 250,
    });
    const failed = entry.getSnapshot();
    expect(failed.phase).toBe('error');
    expect(failed.error).toBeInstanceOf(SyncRoundFailedError);
    expect(failed.error).toMatchObject({
      code: 'sync.transport_failed',
      attempt: 1,
      retryable: true,
      retryDelayMs: 250,
    });

    // A local change re-reads but cannot clear the failure before a retry.
    client.snapshots.push({ revision: 2n, rows: [], coverage: PENDING });
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    await drainMicrotasks();
    expect(client.reads).toHaveLength(3);
    expect(entry.getSnapshot().error).toBe(failed.error);

    client.snapshots.push({ revision: 2n, rows: [], coverage: PENDING });
    client.progress.emit(running(2));
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'loading',
      error: undefined,
    });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(4);
    expect(entry.getSnapshot().phase).toBe('loading');

    client.snapshots.push({
      revision: 3n,
      rows: [{ id: 't1', title: 'first' }],
      coverage: COMPLETE,
    });
    client.progress.update({ state: 'complete' });
    client.emit(windowBatch(3n));
    await drainMicrotasks();
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: undefined,
      rows: [{ id: 't1', title: 'first' }],
    });
    // The first answer publishes `loading` with its revision.
    expect(phases).toEqual(['loading', 'error', 'loading', 'ready']);
    off();
    store.dispose();
  });

  test('partial rows survive a final failure; complete queries ignore it', async () => {
    const client = new FakeReactiveClient();
    client.progress.emit(running(4));
    client.progress.update({
      state: 'failed',
      errorCode: 'sync.scope_revoked',
    });
    const cached = {
      revision: 1n,
      rows: [{ id: 't1', title: 'cached' }],
      coverage: PENDING,
    };
    client.snapshots.push(cached, cached);
    const store = new ReactiveClientStore(client);
    const partial = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const offPartial = partial.subscribe(() => {});
    await drainMicrotasks();
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const complete = store.query<Row>(querySpec({ id: 'queries:local:hash' }));
    const offComplete = complete.subscribe(() => {});
    await drainMicrotasks();

    // Mounted after the failure: the first read already reports it.
    expect(partial.getSnapshot()).toMatchObject({
      phase: 'error',
      rows: [{ id: 't1', title: 'cached' }],
      revision: 1n,
      error: {
        code: 'sync.scope_revoked',
        attempt: 4,
        retryable: false,
        retryDelayMs: undefined,
      },
    });
    expect(complete.getSnapshot().phase).toBe('ready');

    client.snapshots.push(cached);
    client.progress.emit(running(5));
    expect(partial.getSnapshot()).toMatchObject({
      phase: 'partial',
      error: undefined,
      rows: [{ id: 't1', title: 'cached' }],
    });
    expect(complete.getSnapshot().phase).toBe('ready');
    await drainMicrotasks();
    offPartial();
    offComplete();
    store.dispose();
  });
});

describe('reads during an import (SPEC §7.8)', () => {
  const KEY = 'project_id\0{}';
  const pending = (...units: string[]) => ({
    complete: false,
    pending: units.map((unit) => ({ baseKey: KEY, unit })),
    missing: [],
    revoked: [],
  });
  const rows = (revision: bigint) =>
    batch(revision, {
      tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
    });
  const unitEnd = (revision: bigint, unit: string) =>
    batch(revision, { windows: [{ baseKey: KEY, units: new Set([unit]) }] });

  /** Answers every read with the latest committed revision. */
  class ImportingClient extends FakeReactiveClient {
    revision = 1n;
    coverage: QuerySnapshot<object>['coverage'] = pending('p1');
    gate: Promise<void> | undefined;
    override emit(change: ClientChangeBatch): void {
      this.revision = change.revision;
      super.emit(change);
    }
    override querySnapshot<Result = Record<string, never>>(
      spec: QueryReadSpec,
    ): Promise<QuerySnapshot<Result>> {
      this.reads.push(spec);
      const snapshot = {
        revision: this.revision,
        rows: [{ id: 't1', title: `at ${this.revision}` }] as Result[],
        coverage: this.coverage,
      };
      return (this.gate ?? Promise.resolve()).then(() => snapshot);
    }
    importing(): void {
      this.progress.emit({
        epoch: 'e1',
        attempt: 1,
        state: 'running',
        phase: 'request',
        bytesReceived: 0,
        rowsProcessed: 0,
      });
      this.progress.update({ phase: 'import' });
    }
  }

  function mount(client: ImportingClient, units = ['p1']) {
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units }] }),
    );
    const phases: string[] = [];
    const off = entry.subscribe(() => phases.push(entry.getSnapshot().phase));
    return { store, entry, phases, off };
  }

  test('an incomplete entry reads once over an import of 50 blocks, then on its unit end', async () => {
    const client = new ImportingClient();
    client.importing();
    const { store, entry, phases, off } = mount(client);
    await drainMicrotasks();
    const before = client.reads.length;
    expect(entry.getSnapshot().phase).toBe('partial');

    for (let revision = 2n; revision <= 51n; revision += 1n) {
      client.emit(rows(revision));
      await drainMicrotasks();
    }
    expect(client.reads).toHaveLength(before);
    expect(entry.getSnapshot().revision).toBeLessThan(51n);

    client.coverage = COMPLETE;
    client.emit(unitEnd(52n, 'p1'));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      revision: 52n,
    });
    expect(phases).toEqual(['partial', 'ready']);

    // A complete answer was not deferred: the end of the import reads nothing.
    client.progress.update({ state: 'complete' });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    off();
    store.dispose();
  });

  test('a deferred entry reads once when the attempt stops importing', async () => {
    const client = new ImportingClient();
    client.importing();
    const { store, entry, off } = mount(client);
    await drainMicrotasks();
    const before = client.reads.length;
    for (let revision = 2n; revision <= 11n; revision += 1n)
      client.emit(rows(revision));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before);

    client.progress.update({ state: 'complete' });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'partial',
      revision: 11n,
      rows: [{ id: 't1', title: 'at 11' }],
    });
    off();
    store.dispose();
  });

  test('a read that the import overtook publishes partial and reads after the import', async () => {
    const client = new ImportingClient();
    client.importing();
    const gate = deferred<void>();
    client.gate = gate.promise;
    // A claim that settles during the read refreshes it (§7.8); hold it.
    client.setWindowGate = new Promise(() => {});
    const { store, entry, off } = mount(client);
    await drainMicrotasks();
    const before = client.reads.length;
    for (let revision = 2n; revision <= 6n; revision += 1n)
      client.emit(rows(revision));
    client.gate = undefined;
    gate.resolve();
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before);
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'partial',
      revision: 1n,
    });

    client.progress.update({ state: 'complete' });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().revision).toBe(6n);
    off();
    store.dispose();
  });

  test('an entry over two units reads when the last of them ends', async () => {
    const client = new ImportingClient();
    client.coverage = pending('p1', 'p2');
    client.importing();
    const { store, entry, off } = mount(client, ['p1', 'p2']);
    await drainMicrotasks();
    const before = client.reads.length;
    client.coverage = pending('p2');
    client.emit(unitEnd(2n, 'p1'));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before);
    client.coverage = COMPLETE;
    client.emit(unitEnd(3n, 'p2'));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot()).toMatchObject({ phase: 'ready', revision: 3n });
    off();
    store.dispose();
  });

  test('a unit that ends while the read runs still ends the wait', async () => {
    const client = new ImportingClient();
    client.coverage = pending('p1', 'p2');
    client.importing();
    const { store, entry, off } = mount(client, ['p1', 'p2']);
    await drainMicrotasks();
    const gate = deferred<void>();
    client.gate = gate.promise;
    entry.refresh();
    await drainMicrotasks();
    const before = client.reads.length;
    // p1 ends after the running read's snapshot, which still reports it.
    client.emit(unitEnd(2n, 'p1'));
    client.gate = undefined;
    gate.resolve();
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before);
    expect(entry.getSnapshot().revision).toBe(1n);
    client.coverage = COMPLETE;
    client.emit(unitEnd(3n, 'p2'));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().phase).toBe('ready');
    off();
    store.dispose();
  });

  test('a local write and refresh read at once during the import', async () => {
    const client = new ImportingClient();
    client.importing();
    const { store, entry, off } = mount(client);
    await drainMicrotasks();
    const before = client.reads.length;
    client.emit({ ...rows(2n), status: STATUS });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().revision).toBe(2n);
    entry.refresh();
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 2);
    off();
    store.dispose();
  });

  const notes = (revision: bigint) =>
    batch(revision, { tables: [{ table: 'notes' }] });
  const commit = (revision: bigint) =>
    batch(revision, {
      tables: [{ table: 'notes' }],
      appliedCommits: [{ table: 'notes', commitSeq: 9, source: 'delta' }],
    });
  function mountNotes(client: ImportingClient) {
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({
        id: 'queries:notes:hash',
        dependencies: [{ table: 'notes' }],
      }),
    );
    const off = entry.subscribe(() => {});
    return { store, entry, off };
  }

  test('a complete entry reads once after other units import 50 blocks into its table', async () => {
    const client = new ImportingClient();
    client.coverage = COMPLETE;
    client.importing();
    const { store, entry, off } = mountNotes(client);
    await drainMicrotasks();
    const before = client.reads.length;
    for (let revision = 2n; revision <= 51n; revision += 1n) {
      client.emit(notes(revision));
      await drainMicrotasks();
    }
    expect(client.reads).toHaveLength(before);
    expect(entry.getSnapshot()).toMatchObject({ phase: 'ready', revision: 1n });

    client.progress.update({ state: 'complete' });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().revision).toBe(51n);
    off();
    store.dispose();
  });

  test('a complete entry reads at once on a server COMMIT and a local write during the import', async () => {
    const client = new ImportingClient();
    client.coverage = COMPLETE;
    client.importing();
    const { store, entry, off } = mountNotes(client);
    await drainMicrotasks();
    const before = client.reads.length;
    client.emit(notes(2n));
    client.emit(commit(3n));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().revision).toBe(3n);
    client.emit(notes(4n));
    client.emit({ ...notes(5n), status: STATUS });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 2);
    expect(entry.getSnapshot().revision).toBe(5n);

    // Nothing was deferred since the last read: the import end reads nothing.
    client.progress.update({ state: 'complete' });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 2);
    off();
    store.dispose();
  });

  test('a complete read that import blocks overtook publishes and reads after the import', async () => {
    const client = new ImportingClient();
    client.coverage = COMPLETE;
    client.importing();
    const gate = deferred<void>();
    client.gate = gate.promise;
    const { store, entry, off } = mountNotes(client);
    await drainMicrotasks();
    const before = client.reads.length;
    for (let revision = 2n; revision <= 6n; revision += 1n)
      client.emit(notes(revision));
    client.gate = undefined;
    gate.resolve();
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before);
    expect(entry.getSnapshot()).toMatchObject({ phase: 'ready', revision: 1n });

    client.progress.update({ state: 'complete' });
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().revision).toBe(6n);
    off();
    store.dispose();
  });

  test('a complete entry reads at once when a unit of its coverage changes state', async () => {
    const client = new ImportingClient();
    client.coverage = COMPLETE;
    client.importing();
    const { store, entry, off } = mount(client);
    await drainMicrotasks();
    const before = client.reads.length;
    client.emit(rows(2n));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before);
    client.emit(unitEnd(3n, 'p1'));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot()).toMatchObject({ phase: 'ready', revision: 3n });
    off();
    store.dispose();
  });

  test('a complete read that a server COMMIT overtook reads again at once', async () => {
    const client = new ImportingClient();
    client.coverage = COMPLETE;
    client.importing();
    const gate = deferred<void>();
    client.gate = gate.promise;
    const { store, entry, off } = mountNotes(client);
    await drainMicrotasks();
    const before = client.reads.length;
    client.emit(notes(2n));
    client.emit(commit(3n));
    client.gate = undefined;
    gate.resolve();
    await drainMicrotasks();
    expect(client.reads).toHaveLength(before + 1);
    expect(entry.getSnapshot().revision).toBe(3n);
    off();
    store.dispose();
  });
});

describe('local snapshots during window registration', () => {
  test('a revoked unit publishes sync.scope_revoked instead of loading', async () => {
    const client = new FakeReactiveClient();
    const revoked = [{ baseKey: 'tasks', unit: 'p1' }];
    const coverage = {
      complete: false,
      pending: revoked,
      missing: [],
      revoked,
    };
    client.snapshots.push(
      { revision: 1n, rows: [], coverage },
      { revision: 2n, rows: [], coverage },
      { revision: 3n, rows: [], coverage },
      { revision: 4n, rows: [], coverage },
    );
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    const first = entry.getSnapshot();
    expect(first.phase).toBe('error');
    expect(first.error).toBeInstanceOf(ClientSyncError);
    expect(first.error).toMatchObject({
      code: 'sync.scope_revoked',
      details: { units: revoked },
    });
    // The same refusal read again keeps its error object.
    entry.refresh();
    await drainMicrotasks();
    expect(entry.getSnapshot().error).toBe(first.error);
    off();
    store.dispose();
  });

  for (const complete of [true, false]) {
    test(`cached rows are ${complete ? 'ready' : 'partial'} while registration waits`, async () => {
      const client = new FakeReactiveClient();
      const gate = deferred<void>();
      client.setWindowGate = gate.promise;
      client.snapshots.push({
        revision: 1n,
        rows: [{ id: 'cached', title: 'local' }],
        coverage: complete
          ? COMPLETE
          : {
              complete: false,
              pending: [],
              missing: [{ baseKey: 'tasks', unit: 'p1' }],
              revoked: [],
            },
      });
      const store = new ReactiveClientStore(client);
      const entry = store.query<Row>(
        querySpec({
          coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }],
        }),
      );
      const off = entry.subscribe(() => {});
      await drainMicrotasks();
      expect(client.setWindowCalls).toHaveLength(1);
      expect(entry.getSnapshot()).toMatchObject({
        phase: complete ? 'ready' : 'partial',
        rows: [{ id: 'cached', title: 'local' }],
        error: undefined,
      });
      gate.reject(new Error('registration rejected'));
      await drainMicrotasks();
      expect(entry.getSnapshot().error?.message).toBe('registration rejected');
      expect(entry.getSnapshot().rows).toEqual([
        { id: 'cached', title: 'local' },
      ]);
      off();
      store.dispose();
    });
  }

  test('registration completion refreshes missing coverage without a change event', async () => {
    const client = new FakeReactiveClient();
    const gate = deferred<void>();
    client.setWindowGate = gate.promise;
    client.snapshots.push({
      revision: 1n,
      rows: [],
      coverage: {
        complete: false,
        pending: [],
        missing: [{ baseKey: 'tasks', unit: 'p1' }],
        revoked: [],
      },
    });
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    expect(entry.getSnapshot().phase).toBe('loading');
    client.snapshots.push({ revision: 2n, rows: [], coverage: COMPLETE });
    gate.resolve();
    await drainMicrotasks();
    expect(entry.getSnapshot()).toMatchObject({
      phase: 'ready',
      revision: 2n,
      rows: [],
    });
    off();
    store.dispose();
  });

  test('a schema stop retains a late local snapshot and permits a newly mounted query', async () => {
    const client = new FakeReactiveClient();
    const claim = deferred<void>();
    const read = deferred<QuerySnapshot<Row>>();
    client.setWindowGate = claim.promise;
    client.snapshots.push(read.promise);
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }] }),
    );
    const off = entry.subscribe(() => {});
    await drainMicrotasks();
    client.emit(
      batch(2n, {
        status: { ...STATUS, schemaFloor: { requiredSchemaVersion: 2 } },
      }),
    );
    claim.resolve();
    read.resolve({
      revision: 2n,
      rows: [{ id: 'secret', title: 'protected' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks();
    expect(entry.getSnapshot().phase).toBe('ready');
    expect(entry.getSnapshot().rows).toEqual([
      { id: 'secret', title: 'protected' },
    ]);
    const next = store.query<Row>(querySpec({ id: 'new-local-query' }));
    client.snapshots.push({
      revision: 2n,
      rows: [{ id: 'retained', title: 'local' }],
      coverage: COMPLETE,
    });
    const stop = next.subscribe(() => {});
    await drainMicrotasks();
    expect(next.getSnapshot().rows).toEqual([
      { id: 'retained', title: 'local' },
    ]);
    expect(next.getSnapshot().availability).toMatchObject({
      state: 'blocked',
      reason: 'client-upgrade-required',
    });
    stop();
    off();
    store.dispose();
  });

  test('a held unit is acknowledged during widening but not during its removal', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const owner = Symbol('cache');
    await store.setWindowClaim(owner, BASE, ['p1']);
    const widening = deferred<void>();
    client.setWindowGate = widening.promise;
    const widen = store.setWindowClaim(Symbol('new'), BASE, ['p2']);
    await drainMicrotasks();
    let held = false;
    const observer = Symbol('observer');
    const ack = store.setWindowClaim(observer, BASE, ['p1']).then(() => {
      held = true;
    });
    await drainMicrotasks();
    expect(held).toBe(true);
    widening.resolve();
    await widen;
    await ack;
    const removal = deferred<void>();
    client.setWindowGate = removal.promise;
    store.releaseWindowClaims(owner);
    store.releaseWindowClaims(observer);
    await drainMicrotasks();
    let restored = false;
    const reentry = store
      .setWindowClaim(Symbol('reentry'), BASE, ['p1'])
      .then(() => {
        restored = true;
      });
    await drainMicrotasks();
    expect(restored).toBe(false);
    removal.resolve();
    await reentry;
    expect(client.setWindowCalls.at(-1)?.units).toEqual(['p1', 'p2']);
    store.dispose();
  });
});

describe('composable windows and domain routing', () => {
  test('coalesces claims into a normalized union and retains surviving consumers', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push(
      { revision: 1n, rows: [], coverage: COMPLETE },
      { revision: 1n, rows: [], coverage: COMPLETE },
    );
    const store = new ReactiveClientStore(client);
    const left = store.query<Row>(
      querySpec({
        params: ['b'],
        coverage: [{ table: 'tasks', base: BASE, units: ['b', 'a', 'a'] }],
      }),
    );
    const right = store.query<Row>(
      querySpec({
        params: ['c'],
        coverage: [{ table: 'tasks', base: BASE, units: ['c', 'b'] }],
      }),
    );
    const offLeft = left.subscribe(() => undefined);
    const offRight = right.subscribe(() => undefined);
    await drainMicrotasks();

    expect(client.setWindowCalls).toEqual([
      { base: BASE, units: ['a', 'b', 'c'] },
    ]);
    offLeft();
    await drainMicrotasks();
    expect(client.setWindowCalls.at(-1)).toEqual({
      base: BASE,
      units: ['b', 'c'],
    });
    offRight();
    await drainMicrotasks();
    expect(client.setWindowCalls.at(-1)).toEqual({ base: BASE, units: [] });
    store.dispose();
  });

  test('coverage entries sharing one base claim the union of their units', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push(
      { revision: 1n, rows: [], coverage: COMPLETE },
      { revision: 2n, rows: [], coverage: COMPLETE },
      { revision: 3n, rows: [], coverage: COMPLETE },
    );
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({
        coverage: [
          { table: 'tasks', base: BASE, units: ['p1'] },
          { table: 'docs', base: { variable: 'org_id' }, units: ['o1'] },
          { table: 'docs', base: BASE, units: ['p2'] },
        ],
      }),
    );
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();

    // The composed spec's later entry for the same base accumulates, so the
    // first entry's units survive registration. Entries name tables, but a
    // claim registers exactly the units of its base (§4.8): one claim per base.
    expect(client.setWindowCalls).toEqual([
      { base: BASE, units: ['p1', 'p2'] },
      { base: { variable: 'org_id' }, units: ['o1'] },
    ]);

    client.emit(
      batch(2n, {
        windows: [
          {
            baseKey: 'project_id\0{}',
            units: new Set(['p1']),
          },
        ],
      }),
    );
    await drainMicrotasks();
    expect(client.reads).toHaveLength(2);

    client.emit(
      batch(3n, {
        windows: [
          {
            baseKey: 'project_id\0{}',
            units: new Set(['p2']),
          },
        ],
      }),
    );
    await drainMicrotasks();
    expect(client.reads).toHaveLength(3);

    off();
    store.dispose();
  });

  test('dependencies sharing one table match a change in any scope', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push(
      { revision: 1n, rows: [], coverage: COMPLETE },
      { revision: 2n, rows: [], coverage: COMPLETE },
      { revision: 3n, rows: [], coverage: COMPLETE },
    );
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({
        dependencies: [
          { table: 'tasks', scopeKeys: ['project:p1'] },
          { table: 'tasks', scopeKeys: ['project:p2'] },
        ],
      }),
    );
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();
    expect(client.reads).toHaveLength(1);

    // A scoped dependency that does not cover the change must not mask the
    // sibling dependency on the same table that does.
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p2']) }],
      }),
    );
    await drainMicrotasks();
    expect(client.reads).toHaveLength(2);

    client.emit(
      batch(3n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    await drainMicrotasks();
    expect(client.reads).toHaveLength(3);

    client.emit(
      batch(4n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p3']) }],
      }),
    );
    await drainMicrotasks();
    expect(client.reads).toHaveLength(3);

    off();
    store.dispose();
  });

  test('a status event supersedes an older pending snapshot', async () => {
    const client = new FakeReactiveClient();
    const pending = deferred<SyncStatusSnapshot>();
    client.statusSnapshot = () => pending.promise;
    const store = new ReactiveClientStore(client);
    const latest = { ...STATUS, outbox: 3 };
    client.emit(batch(1n, { status: latest }));
    pending.resolve(STATUS);
    await drainMicrotasks();
    expect(store.status.getSnapshot().status).toEqual(latest);
    store.dispose();
  });

  for (const source of ['conflicts', 'outcomes'] as const) {
    for (const fails of [false, true]) {
      test(`${source} publishes only the read that follows a refresh during a read, ${fails ? 'failing' : 'succeeding'}`, async () => {
        const client = new FakeReactiveClient();
        const first = deferred<readonly CommitOutcome[]>();
        const second = deferred<readonly CommitOutcome[]>();
        let reads = 0;
        const read = () => (++reads === 1 ? first.promise : second.promise);
        if (source === 'conflicts') client.conflicts = read;
        else client.commitOutcomes = read;
        const store = new ReactiveClientStore(client);
        const entry = store[source];
        const published: unknown[] = [];
        const off = entry.subscribe(() => published.push(entry.getSnapshot()));
        entry.refresh();
        entry.refresh();
        await drainMicrotasks();
        expect(reads).toBe(1);
        first.resolve([
          {
            sequence: 1,
            clientCommitId: 'stale',
            status: 'applied',
            recordedAtMs: 0,
            results: [],
            resolution: 'active',
          },
        ]);
        await drainMicrotasks();
        expect(reads).toBe(2);
        expect(published).toEqual([]);
        const failure = new Error('latest read failed');
        if (fails) second.reject(failure);
        else second.resolve([]);
        await drainMicrotasks();
        expect(published).toEqual([entry.getSnapshot()]);
        expect(entry.getSnapshot().error).toBe(fails ? failure : undefined);
        expect(entry.getSnapshot().isLoading).toBe(false);
        off();
        store.dispose();
      });
    }
  }

  test('outcome changes during a journal read cost one more read, not one each', async () => {
    const client = new FakeReactiveClient();
    const pending = deferred<readonly CommitOutcome[]>();
    client.commitOutcomes = () => {
      client.outcomeCalls += 1;
      return client.outcomeCalls === 1 ? pending.promise : [];
    };
    const store = new ReactiveClientStore(client);
    for (let revision = 1n; revision <= 5n; revision += 1n) {
      client.emit(batch(revision, { outcomesChanged: true }));
    }
    await drainMicrotasks();
    expect(client.outcomeCalls).toBe(1);
    pending.resolve([]);
    await drainMicrotasks();
    expect(client.outcomeCalls).toBe(2);
    expect(store.outcomes.getSnapshot().isLoading).toBe(false);
    store.dispose();
  });

  test('disposing a store invalidates pending value reads and restart refreshes them', async () => {
    const client = new FakeReactiveClient();
    const pending = deferred<SyncStatusSnapshot>();
    client.statusSnapshot = () => pending.promise;
    const store = new ReactiveClientStore(client);
    store.dispose();
    pending.resolve(STATUS);
    await drainMicrotasks();
    expect(store.status.getSnapshot().isLoading).toBe(true);
    client.statusSnapshot = () => STATUS;
    store.start();
    await drainMicrotasks();
    expect(store.status.getSnapshot().status).toEqual(STATUS);
    store.dispose();
  });

  test('status-only changes perform zero SQL reruns and no status follow-up read', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(querySpec());
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();
    expect(client.statusCalls).toBe(1);

    const status = { ...STATUS, outbox: 2, syncNeeded: true };
    client.emit(batch(2n, { status }));
    await drainMicrotasks();
    expect(client.reads).toHaveLength(1);
    expect(client.statusCalls).toBe(1);
    expect(store.status.getSnapshot().status).toEqual(status);
    off();
    store.dispose();
  });

  test('repeated equal status batches keep the snapshot and do not notify', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    await drainMicrotasks();
    const initial = store.status.getSnapshot();
    let notifications = 0;
    const off = store.status.subscribe(() => {
      notifications += 1;
    });

    client.emit(batch(1n, { status: { ...STATUS } }));
    client.emit(batch(2n, { status: { ...STATUS } }));
    store.status.refresh();
    await drainMicrotasks();
    expect(notifications).toBe(0);
    expect(store.status.getSnapshot()).toBe(initial);

    client.emit(batch(3n, { status: { ...STATUS, outbox: 1 } }));
    expect(notifications).toBe(1);
    expect(store.status.getSnapshot().status?.outbox).toBe(1);
    off();
    store.dispose();
  });

  test('a repeated status read failure notifies for each new error', async () => {
    const client = new FakeReactiveClient();
    client.statusSnapshot = () => Promise.reject(new Error('status failed'));
    const store = new ReactiveClientStore(client);
    await drainMicrotasks();
    const first = store.status.getSnapshot().error;
    let notifications = 0;
    const off = store.status.subscribe(() => {
      notifications += 1;
    });
    store.status.refresh();
    await drainMicrotasks();
    expect(notifications).toBe(1);
    expect(store.status.getSnapshot().error).not.toBe(first);
    off();
    store.dispose();
  });

  for (const source of ['conflicts', 'outcomes'] as const) {
    test(`${source} refreshes with equal content do not notify`, async () => {
      const client = new FakeReactiveClient();
      const outcome: CommitOutcome = {
        sequence: 1,
        clientCommitId: 'c1',
        status: 'applied',
        recordedAtMs: 0,
        results: [],
        resolution: 'active',
      };
      if (source === 'conflicts') client.conflicts = () => [{ ...outcome }];
      else client.commitOutcomes = () => [{ ...outcome }];
      const store = new ReactiveClientStore(client);
      await drainMicrotasks();
      const entry = store[source];
      const initial = entry.getSnapshot();
      let notifications = 0;
      const off = entry.subscribe(() => {
        notifications += 1;
      });
      client.emit(
        batch(1n, {
          conflictsChanged: true,
          rejectionsChanged: true,
          outcomesChanged: true,
        }),
      );
      entry.refresh();
      await drainMicrotasks();
      expect(notifications).toBe(0);
      expect(entry.getSnapshot()).toBe(initial);
      off();
      store.dispose();
    });
  }

  test('a retention release settles with the core edit that applies it', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const both = store.retainWindow(BASE, ['p1', 'p2']);
    await both.ready;
    const p1 = store.retainWindow(BASE, ['p1']);
    await p1.ready;

    const failure = new Error('eviction failed');
    client.setWindowFailure = failure;
    await expect(both.release()).rejects.toBe(failure);
    expect(client.setWindowCalls.at(-1)).toEqual({ base: BASE, units: ['p1'] });

    client.setWindowFailure = undefined;
    const retry = store.retainWindow(BASE, ['p1']);
    await retry.ready;
    expect(client.setWindowCalls.at(-1)).toEqual({ base: BASE, units: ['p1'] });
    await p1.release();
    await retry.release();
    expect(client.setWindowCalls.at(-1)).toEqual({ base: BASE, units: [] });
    await expect(retry.release()).resolves.toBeUndefined();
    store.dispose();
  });

  test('treats window release after client closure as best-effort teardown', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const retained = store.retainWindow(BASE, ['p1']);
    await retained.ready;

    client.setWindowFailure = new Error('the handle is closed');
    store.dispose();
    await drainMicrotasks();

    expect(client.setWindowCalls).toEqual([
      { base: BASE, units: ['p1'] },
      { base: BASE, units: [] },
    ]);
    store.dispose();
    await drainMicrotasks();
    expect(client.setWindowCalls).toHaveLength(2);
  });

  test('dispose survives a synchronous setWindow throw from a closed handle', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const retained = store.retainWindow(BASE, ['p1']);
    await retained.ready;

    // The interface permits a plain void return, so a closed native/worker
    // handle may throw synchronously during best-effort teardown.
    client.setWindowSyncFailure = new Error('the handle is closed');
    expect(() => store.dispose()).not.toThrow();
    await drainMicrotasks();

    expect(client.setWindowCalls).toEqual([
      { base: BASE, units: ['p1'] },
      { base: BASE, units: [] },
    ]);
  });
});

describe('window claims after a reload (SPEC §7.8)', () => {
  const HELD = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];

  test('a coverage claim applied before the retained claim evicts no held unit', async () => {
    const client = new FakeReactiveClient();
    client.held = HELD;
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const store = new ReactiveClientStore(client);
    const off = store
      .query<Row>(
        querySpec({
          coverage: [{ table: 'tasks', base: BASE, units: ['r3'] }],
        }),
      )
      .subscribe(() => undefined);
    await drainMicrotasks();
    expect(client.setWindowCalls).toEqual([{ base: BASE, units: HELD }]);

    const retained = store.retainWindow(BASE, HELD);
    await retained.ready;
    expect(client.setWindowCalls).toHaveLength(1);

    // A unit a claim of this session named and then released is evicted.
    const narrower = store.retainWindow(BASE, HELD.slice(0, 6));
    await narrower.ready;
    await retained.release();
    expect(client.setWindowCalls.at(-1)).toEqual({
      base: BASE,
      units: HELD.slice(0, 6),
    });
    off();
    store.dispose();
  });

  test('a held unit no claim named survives releases and disposal', async () => {
    const client = new FakeReactiveClient();
    client.held = ['r1', 'r2'];
    const store = new ReactiveClientStore(client);
    const retained = store.retainWindow(BASE, ['r2', 'r3']);
    await retained.ready;
    expect(client.setWindowCalls).toEqual([
      { base: BASE, units: ['r1', 'r2', 'r3'] },
    ]);
    await retained.release();
    expect(client.setWindowCalls.at(-1)).toEqual({ base: BASE, units: ['r1'] });
    store.retainWindow(BASE, ['r4']);
    await drainMicrotasks();
    store.dispose();
    expect(client.setWindowCalls.at(-1)).toEqual({ base: BASE, units: ['r1'] });
  });

  test('a window completes after the query reads of its batch (§7.8)', async () => {
    // A query without coverage reads the rows the import of the unit wrote;
    // its answer is held, and the window waits for it.
    let pending = ['p1'];
    const client = new (class extends FakeReactiveClient {
      override windowState(): WindowState {
        return { units: ['p1'], pending, revoked: [] };
      }
    })();
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const store = new ReactiveClientStore(client);
    store.start();
    const window = store.window(BASE);
    const query = store.query<Row>(querySpec());
    const order: string[] = [];
    const offWindow = window.subscribe(() => order.push('window'));
    const offQuery = query.subscribe(() => order.push('query'));
    await drainMicrotasks();
    expect(window.getSnapshot().pending).toEqual(['p1']);
    expect(query.getSnapshot()).toMatchObject({ phase: 'ready', rows: [] });
    let answer!: (snapshot: QuerySnapshot<object>) => void;
    client.snapshots.push(new Promise((resolve) => (answer = resolve)));
    pending = [];
    order.length = 0;
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
        windows: [{ baseKey: 'project_id\0{}', units: new Set(['p1']) }],
      }),
    );
    await drainMicrotasks(24);
    expect(window.getSnapshot().pending).toEqual(['p1']);
    expect(query.getSnapshot().rows).toEqual([]);
    answer({
      revision: 2n,
      rows: [{ id: 't1', title: 'first' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks(24);
    expect(query.getSnapshot().rows).toEqual([{ id: 't1', title: 'first' }]);
    expect(window.getSnapshot().pending).toEqual([]);
    expect(order).toEqual(['query', 'window']);
    offWindow();
    offQuery();
    store.dispose();
  });

  test('a window-only batch completes after the reads of an earlier row batch (§7.8)', async () => {
    let pending = ['p1'];
    const client = new (class extends FakeReactiveClient {
      override windowState(): WindowState {
        return { units: ['p1'], pending, revoked: [] };
      }
    })();
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const store = new ReactiveClientStore(client);
    store.start();
    const window = store.window(BASE);
    const query = store.query<Row>(querySpec());
    const order: string[] = [];
    const offWindow = window.subscribe(() => order.push('window'));
    const offQuery = query.subscribe(() => order.push('query'));
    await drainMicrotasks();
    let answer!: (snapshot: QuerySnapshot<object>) => void;
    client.snapshots.push(new Promise((resolve) => (answer = resolve)));
    order.length = 0;
    // The rows land in one batch; the unit completes in a later window-only one.
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    pending = [];
    client.emit(
      batch(3n, {
        windows: [{ baseKey: 'project_id\0{}', units: new Set(['p1']) }],
      }),
    );
    await drainMicrotasks(24);
    expect(window.getSnapshot().pending).toEqual(['p1']);
    answer({
      revision: 3n,
      rows: [{ id: 't1', title: 'first' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks(24);
    expect(window.getSnapshot().pending).toEqual([]);
    expect(order).toEqual(['query', 'window']);
    offWindow();
    offQuery();
    store.dispose();
  });

  test('a window-only batch during an import reads the deferred queries first (§7.8)', async () => {
    let pending = ['p1'];
    const client = new (class extends FakeReactiveClient {
      override windowState(): WindowState {
        return { units: ['p1'], pending, revoked: [] };
      }
    })();
    client.snapshots.push({ revision: 1n, rows: [], coverage: COMPLETE });
    const store = new ReactiveClientStore(client);
    store.start();
    const window = store.window(BASE);
    const query = store.query<Row>(querySpec());
    const order: string[] = [];
    const offWindow = window.subscribe(() => order.push('window'));
    const offQuery = query.subscribe(() => order.push('query'));
    await drainMicrotasks();
    client.progress.emit({
      epoch: 'e1',
      attempt: 1,
      state: 'running',
      phase: 'import',
      bytesReceived: 0,
      rowsProcessed: 0,
    });
    order.length = 0;
    // The import's row batch defers the read; the unit's completion reads.
    client.emit(
      batch(2n, {
        tables: [{ table: 'tasks', scopeKeys: new Set(['project:p1']) }],
      }),
    );
    await drainMicrotasks(24);
    expect(client.reads).toHaveLength(1);
    let answer!: (snapshot: QuerySnapshot<object>) => void;
    client.snapshots.push(new Promise((resolve) => (answer = resolve)));
    pending = [];
    client.emit(
      batch(3n, {
        windows: [{ baseKey: 'project_id\0{}', units: new Set(['p1']) }],
      }),
    );
    await drainMicrotasks(24);
    expect(client.reads).toHaveLength(2);
    expect(window.getSnapshot().pending).toEqual(['p1']);
    answer({
      revision: 3n,
      rows: [{ id: 't1', title: 'first' }],
      coverage: COMPLETE,
    });
    await drainMicrotasks(24);
    expect(window.getSnapshot().pending).toEqual([]);
    expect(order).toEqual(['query', 'window']);
    offWindow();
    offQuery();
    store.dispose();
  });

  test('a window snapshot says whether it has read the core', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const entry = store.window(BASE);
    let notified = 0;
    const off = entry.subscribe(() => {
      notified += 1;
    });
    expect(entry.getSnapshot()).toEqual({
      units: [],
      pending: [],
      revoked: [],
      loaded: false,
    });
    await drainMicrotasks();
    expect(entry.getSnapshot()).toEqual({
      units: [],
      pending: [],
      revoked: [],
      loaded: true,
    });
    expect(notified).toBe(1);
    off();
    store.dispose();
  });
});

describe('keyed reconciliation performance', () => {
  test('switching query identity before the first read keeps the unread snapshot identity', async () => {
    const client = new FakeReactiveClient();
    const pending = {
      complete: false,
      pending: [{ baseKey: 'tasks', unit: 'p1' }],
      missing: [],
      revoked: [],
    };
    client.snapshots.push({ revision: 1n, rows: [], coverage: pending });
    const store = new ReactiveClientStore(client);
    const first = store.query<Row>(querySpec({ params: ['p1'] }));
    const offFirst = first.subscribe(() => undefined);
    const initial = first.getSnapshot();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.rows)).toBe(true);

    const second = store.query<Row>(
      querySpec({ params: ['p1', 'p2'], publishFirstAnswer: true }),
    );
    let notifications = 0;
    const offSecond = second.subscribe(() => {
      notifications += 1;
    });
    offFirst();
    expect(second.getSnapshot()).toBe(initial);
    await drainMicrotasks();
    expect(client.reads).toHaveLength(1);
    // The answer, empty and pending, publishes its revision once.
    expect(notifications).toBe(1);
    expect(second.getSnapshot()).toMatchObject({
      phase: 'loading',
      revision: 1n,
    });
    expect(second.getSnapshot().rows).toBe(initial.rows);
    offSecond();
    store.dispose();
  });

  for (const rowKey of [undefined, (row: Row) => [row.id]]) {
    test(`an empty result read again keeps its identity and does not notify (${rowKey === undefined ? 'positional' : 'keyed'})`, async () => {
      const client = new FakeReactiveClient();
      client.snapshots.push(
        { revision: 1n, rows: [], coverage: COMPLETE },
        { revision: 2n, rows: [], coverage: COMPLETE },
        { revision: 3n, rows: [{ id: 'a', title: 'A' }], coverage: COMPLETE },
      );
      const store = new ReactiveClientStore(client);
      const entry = store.query<Row>(querySpec({ rowKey }));
      let notifications = 0;
      const off = entry.subscribe(() => {
        notifications += 1;
      });
      await drainMicrotasks();
      const empty = entry.getSnapshot();
      expect(empty.phase).toBe('ready');
      notifications = 0;

      client.emit(batch(2n, { tables: [{ table: 'tasks' }] }));
      await drainMicrotasks();
      expect(client.reads).toHaveLength(2);
      expect(notifications).toBe(0);
      expect(entry.getSnapshot()).toBe(empty);

      client.emit(batch(3n, { tables: [{ table: 'tasks' }] }));
      await drainMicrotasks();
      expect(notifications).toBe(1);
      expect(entry.getSnapshot().rows).toEqual([{ id: 'a', title: 'A' }]);
      off();
      store.dispose();
    });
  }

  test('mapped rows compare dates by time and class instances by identity', async () => {
    class Label {
      constructor(readonly text: string) {}
    }
    interface MappedRow {
      readonly id: string;
      readonly due: Date;
      readonly label?: Label;
    }
    const client = new FakeReactiveClient();
    const label = new Label('x');
    const rows = [
      { id: 'a', due: new Date(1) },
      { id: 'a', due: new Date(1) },
      { id: 'a', due: new Date(2) },
      { id: 'a', due: new Date(2), label },
      { id: 'a', due: new Date(2), label: new Label('x') },
    ];
    for (const [index, row] of rows.entries()) {
      client.snapshots.push({
        revision: BigInt(index + 1),
        rows: [row],
        coverage: COMPLETE,
      });
    }
    const store = new ReactiveClientStore(client);
    const entry = store.query<MappedRow>({
      ...querySpec(),
      rowKey: (row: MappedRow) => [row.id],
    });
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();
    const seen = [entry.getSnapshot().rows[0]];
    for (let revision = 2n; revision <= 5n; revision += 1n) {
      client.emit(batch(revision, { tables: [{ table: 'tasks' }] }));
      await drainMicrotasks();
      seen.push(entry.getSnapshot().rows[0]);
    }
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
    expect(seen[2]?.due.getTime()).toBe(2);
    expect(seen[3]).not.toBe(seen[2]);
    expect(seen[4]).not.toBe(seen[3]);
    off();
    store.dispose();
  });

  test('preserves row identities through a prepend, delete, and reorder', async () => {
    const client = new FakeReactiveClient();
    const first = [
      { id: 'a', title: 'A', body: new Uint8Array([1, 2]) },
      { id: 'b', title: 'B', body: new Uint8Array([3, 4]) },
      { id: 'c', title: 'C', body: new Uint8Array([5, 6]) },
    ];
    client.snapshots.push(
      { revision: 1n, rows: first, coverage: COMPLETE },
      {
        revision: 2n,
        rows: [
          { id: 'x', title: 'X', body: new Uint8Array([9]) },
          { id: 'c', title: 'C', body: new Uint8Array([5, 6]) },
          { id: 'a', title: 'A', body: new Uint8Array([1, 2]) },
        ],
        coverage: COMPLETE,
      },
    );
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(querySpec());
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();
    const before = entry.getSnapshot().rows;
    client.emit(batch(2n, { tables: [{ table: 'tasks' }] }));
    await drainMicrotasks();
    const after = entry.getSnapshot().rows;

    expect(after.map((row) => row.id)).toEqual(['x', 'c', 'a']);
    expect(after[1]).toBe(before[2]);
    expect(after[2]).toBe(before[0]);
    off();
    store.dispose();
  });

  test('100/1k/10k rows retain linear-time behavior without blob serialization', async () => {
    const durations: number[] = [];
    for (const size of [100, 1_000, 10_000]) {
      const client = new FakeReactiveClient();
      const rows = Array.from({ length: size }, (_, index) => ({
        id: `r${index}`,
        title: `row ${index}`,
        body: new Uint8Array([index & 255, (index >> 8) & 255]),
      }));
      client.snapshots.push(
        { revision: 1n, rows, coverage: COMPLETE },
        {
          revision: 2n,
          rows: [...rows].reverse().map((row) => ({
            ...row,
            body: new Uint8Array(row.body),
          })),
          coverage: COMPLETE,
        },
      );
      const store = new ReactiveClientStore(client);
      const entry = store.query<Row>(querySpec());
      const off = entry.subscribe(() => undefined);
      await drainMicrotasks();
      const started = performance.now();
      client.emit(batch(2n, { tables: [{ table: 'tasks' }] }));
      await drainMicrotasks();
      durations.push(performance.now() - started);
      expect(entry.getSnapshot().rows[0]).toBe(rows.at(-1));
      off();
      store.dispose();
    }

    // This guards against accidental quadratic scans or per-blob JSON/hex
    // expansion while staying portable across non-pinned developer machines.
    expect(durations[2] ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
    expect((durations[2] ?? 1) / Math.max(durations[1] ?? 1, 0.1)).toBeLessThan(
      30,
    );
  });
});

describe('observation ownership', () => {
  test('10k parameter changes retain only subscribed rows and dispatch only to active queries', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const activeRows = [{ id: 'active', title: 'keep' }];
    client.snapshots.push({
      revision: 1n,
      rows: activeRows,
      coverage: COMPLETE,
    });
    const active = store.query<Row>(querySpec({ params: ['active'] }));
    const offActive = active.subscribe(() => undefined);
    await drainMicrotasks();
    const snapshot = active.getSnapshot();
    let dependencyReads = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const entry = store.query<Row>({
        ...querySpec({ params: [String(index)] }),
        get dependencies() {
          dependencyReads += 1;
          return [{ table: 'tasks' }];
        },
      });
      if (index % 2 === 0) {
        client.snapshots.push({
          revision: 1n,
          rows: [{ id: String(index), title: 'retire' }],
          coverage: COMPLETE,
        });
        const off = entry.subscribe(() => undefined);
        await drainMicrotasks();
        expect(entry.getSnapshot().rows).toHaveLength(1);
        off();
      }
      await drainMicrotasks();
      expect(entry.getSnapshot().rows).toHaveLength(0);
    }
    expect(store.cacheStats()).toEqual({
      queries: 1,
      activeQueries: 1,
      windows: 0,
      activeWindows: 0,
      windowClaims: 0,
    });
    expect(active.getSnapshot()).toBe(snapshot);
    expect(store.query<Row>(querySpec({ params: ['active'] }))).toBe(active);
    dependencyReads = 0;
    client.snapshots.push({
      revision: 2n,
      rows: activeRows,
      coverage: COMPLETE,
    });
    client.emit(batch(2n, { tables: [{ table: 'tasks' }] }));
    await drainMicrotasks();
    expect(dependencyReads).toBe(0);
    expect(active.getSnapshot().rows).toBe(snapshot.rows);
    offActive();
    await drainMicrotasks();
    expect(store.cacheStats().queries).toBe(0);
    store.dispose();
  });

  test('abandoned render references rejoin one canonical entry across repeated retirements', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const abandoned = store.query<Row>(querySpec());
    await drainMicrotasks();
    for (let round = 0; round < 3; round += 1) {
      const current = store.query<Row>(querySpec());
      client.snapshots.push({
        revision: BigInt(round),
        rows: [{ id: 'id', title: String(round) }],
        coverage: COMPLETE,
      });
      const offCurrent = current.subscribe(() => undefined);
      const offOld = abandoned.subscribe(() => undefined);
      await drainMicrotasks();
      expect(abandoned.getSnapshot()).toBe(current.getSnapshot());
      expect(client.reads).toHaveLength(round + 1);
      offCurrent();
      offOld();
      await drainMicrotasks();
      expect(store.cacheStats().queries).toBe(0);
      expect(abandoned.getSnapshot().rows).toHaveLength(0);
    }
    store.dispose();
  });

  test('same-microtask remount preserves rows, sharing and window claims', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const spec = querySpec({
      coverage: [{ table: 'tasks', base: BASE, units: ['p1'] }],
    });
    client.snapshots.push({
      revision: 1n,
      rows: [{ id: 'id', title: 'kept' }],
      coverage: COMPLETE,
    });
    const entry = store.query<Row>(spec);
    const off = entry.subscribe(() => undefined);
    await drainMicrotasks();
    const snapshot = entry.getSnapshot();
    off();
    client.snapshots.push({
      revision: 1n,
      rows: snapshot.rows,
      coverage: COMPLETE,
    });
    const remount = store.query<Row>(spec);
    const offRemount = remount.subscribe(() => undefined);
    expect(remount).toBe(entry);
    expect(remount.getSnapshot()).toBe(snapshot);
    await drainMicrotasks();
    expect(remount.getSnapshot()).toBe(snapshot);
    expect(client.setWindowCalls.map((call) => call.units)).toEqual([['p1']]);
    offRemount();
    await drainMicrotasks();
    expect(client.setWindowCalls.at(-1)?.units).toEqual([]);
    expect(store.cacheStats().windowClaims).toBe(0);
    store.dispose();
  });

  for (const failed of [false, true]) {
    test(`retiring a pending read permits a fresh read and ignores its late ${failed ? 'error' : 'rows'}`, async () => {
      const client = new FakeReactiveClient();
      const old = deferred<QuerySnapshot<Row>>();
      client.snapshots.push(old.promise);
      const store = new ReactiveClientStore(client);
      const entry = store.query<Row>(querySpec());
      const off = entry.subscribe(() => undefined);
      await drainMicrotasks();
      off();
      await drainMicrotasks();
      client.snapshots.push({
        revision: 2n,
        rows: [{ id: 'fresh', title: 'fresh' }],
        coverage: COMPLETE,
      });
      const offNew = entry.subscribe(() => undefined);
      await drainMicrotasks();
      expect(client.reads).toHaveLength(2);
      const fresh = entry.getSnapshot();
      if (failed) old.reject(new Error('retired read'));
      else
        old.resolve({
          revision: 1n,
          rows: [{ id: 'old', title: 'old' }],
          coverage: COMPLETE,
        });
      await drainMicrotasks();
      expect(entry.getSnapshot()).toBe(fresh);
      expect(fresh.rows[0]?.id).toBe('fresh');
      offNew();
      store.dispose();
    });
  }

  test('window observations and released claim groups have no inactive retention', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    for (let index = 0; index < 100; index += 1) {
      const base = { ...BASE, table: `table_${index}` };
      const old = store.window(base);
      await drainMicrotasks();
      const current = store.window(base);
      const off = current.subscribe(() => undefined);
      const offOld = old.subscribe(() => undefined);
      const retained = store.retainWindow(base, ['p1']);
      await retained.ready;
      expect(old.getSnapshot()).toBe(current.getSnapshot());
      retained.release();
      off();
      offOld();
      await drainMicrotasks();
    }
    expect(store.cacheStats()).toEqual({
      queries: 0,
      activeQueries: 0,
      windows: 0,
      activeWindows: 0,
      windowClaims: 0,
    });
    store.dispose();
  });

  test('disposal rejects unapplied claims and old jobs cannot overwrite restarted ownership', async () => {
    const client = new FakeReactiveClient();
    const store = new ReactiveClientStore(client);
    const retained = store.retainWindow(BASE, ['old']);
    const rejected = retained.ready.then(
      () => undefined,
      (error: unknown) => error,
    );
    const query = store.query<Row>(
      querySpec({ coverage: [{ table: 'tasks', base: BASE, units: ['old'] }] }),
    );
    query.subscribe(() => undefined);
    store.dispose();
    store.start();
    const fresh = store.retainWindow(BASE, ['fresh']);
    await fresh.ready;
    expect(await rejected).toMatchObject({
      code: 'client.reactive_store_disposed',
    });
    await drainMicrotasks();
    // The disposed group applied nothing, so its teardown edits nothing.
    expect(client.setWindowCalls.map((call) => call.units)).toEqual([
      ['fresh'],
    ]);
    fresh.release();
    await drainMicrotasks();
    expect(store.cacheStats().windowClaims).toBe(0);
    store.dispose();
  });
});

describe('security preflight gate (SPEC §5.11)', () => {
  test('a window claim made in preflight waits and applies on activation', async () => {
    const { makeClient, makeServer } = await import('./helpers');
    const local = await makeClient(makeServer(), { clientId: 'gate-window' });
    const store = new ReactiveClientStore(local.client);
    store.start();
    await drainMicrotasks(24);
    await local.client.beginSecurityPreflight();
    await drainMicrotasks(24);
    let settled: string | undefined;
    const retention = store.retainWindow(BASE, ['p1']);
    retention.ready.then(
      () => (settled = 'ready'),
      (error: { code?: string }) => (settled = error.code),
    );
    await drainMicrotasks(24);
    expect(settled).toBeUndefined();

    await local.client.activateSecurity();
    await drainMicrotasks(48);
    expect(settled).toBe('ready');
    expect(local.client.windowState(BASE).units).toEqual(['p1']);
    await retention.release();
    store.dispose();
  });

  test('a refused read keeps its snapshot and reads again on activation', async () => {
    const { makeClient, makeServer, taskValues } = await import('./helpers');
    const local = await makeClient(makeServer(), { clientId: 'gate-client' });
    local.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'one') },
    ]);
    const store = new ReactiveClientStore(local.client);
    const spec = {
      id: 'tasks',
      sql: 'SELECT id FROM tasks ORDER BY id',
      dependencies: [{ table: 'tasks' }],
    };
    const ready = store.query<{ id: string }>(spec);
    const offReady = ready.subscribe(() => {});
    await drainMicrotasks(24);
    expect(ready.getSnapshot().phase).toBe('ready');

    await local.client.beginSecurityPreflight();
    await drainMicrotasks(24);
    expect(store.status.getSnapshot().status?.securityLifecycle).toBe(
      'preflight',
    );
    // A refresh inside the gate keeps the ready snapshot; a new entry stays
    // loading. Neither turns `error`.
    ready.refresh();
    const late = store.query<{ id: string }>({ ...spec, id: 'late' });
    const offLate = late.subscribe(() => {});
    await drainMicrotasks(24);
    expect(ready.getSnapshot()).toMatchObject({
      phase: 'ready',
      error: undefined,
      isRefreshing: false,
    });
    expect(ready.getSnapshot().rows.map((row) => row.id)).toEqual(['t1']);
    expect(late.getSnapshot()).toMatchObject({
      phase: 'loading',
      error: undefined,
    });

    await local.client.activateSecurity();
    await drainMicrotasks(24);
    for (const entry of [ready, late]) {
      expect(entry.getSnapshot().phase).toBe('ready');
      expect(entry.getSnapshot().rows.map((row) => row.id)).toEqual(['t1']);
    }
    offReady();
    offLate();
    store.dispose();
    await local.client.close();
  });

  test('journal and window entries refused in preflight read on activation without an app call', async () => {
    const { makeClient, makeServer } = await import('./helpers');
    const local = await makeClient(makeServer(), { clientId: 'gate-journal' });
    await local.client.beginSecurityPreflight();
    const store = new ReactiveClientStore(local.client);
    const window = store.window(BASE);
    const offWindow = window.subscribe(() => {});
    await drainMicrotasks(24);
    // The first reads ran inside the gate: no entry reports the refusal.
    expect(store.outcomes.getSnapshot()).toEqual({
      outcomes: [],
      error: undefined,
      isLoading: true,
    });
    expect(store.conflicts.getSnapshot()).toMatchObject({
      error: undefined,
      isLoading: true,
    });
    expect(window.getSnapshot().loaded).toBe(false);

    await local.client.activateSecurity();
    await drainMicrotasks(24);
    expect(store.outcomes.getSnapshot()).toEqual({
      outcomes: [],
      error: undefined,
      isLoading: false,
    });
    expect(store.conflicts.getSnapshot()).toEqual({
      conflicts: [],
      rejections: [],
      error: undefined,
      isLoading: false,
    });
    expect(window.getSnapshot()).toEqual({
      units: [],
      pending: [],
      revoked: [],
      loaded: true,
    });
    offWindow();
    store.dispose();
    await local.client.close();
  });

  test('a journal refusal that raced activation reads again; another error does not', async () => {
    const client = new FakeReactiveClient();
    const refused = new ClientSyncError(
      'client.security_preflight_required',
      'protected reads require activateSecurity',
    );
    // The refusal lands after the client already reports `active`.
    client.commitOutcomes = () => {
      client.outcomeCalls += 1;
      if (client.outcomeCalls === 1) throw refused;
      return [];
    };
    const failure = new ClientSyncError('sync.local_corrupt', 'corrupt');
    client.conflicts = () => {
      client.conflictCalls += 1;
      throw failure;
    };
    const store = new ReactiveClientStore(client);
    await drainMicrotasks();
    expect(client.outcomeCalls).toBe(2);
    expect(store.outcomes.getSnapshot()).toEqual({
      outcomes: [],
      error: undefined,
      isLoading: false,
    });
    expect(store.conflicts.getSnapshot().error).toBe(failure);
    expect(client.conflictCalls).toBe(1);

    // Activation re-reads only entries the gate refused.
    client.emit(
      batch(1n, { status: { ...STATUS, securityLifecycle: 'preflight' } }),
    );
    client.emit(batch(2n, { status: STATUS }));
    await drainMicrotasks();
    expect(client.conflictCalls).toBe(1);
    expect(client.outcomeCalls).toBe(2);
    expect(store.conflicts.getSnapshot().error).toBe(failure);
    store.dispose();
  });
});

describe('schema bump availability (SPEC §7.4.5)', () => {
  test('a reset that kept tables keeps entries ready; a reset unit stays loading', async () => {
    const client = new FakeReactiveClient();
    client.currentStatus = {
      ...STATUS,
      upgrading: true,
      upgradeKeptTables: true,
    };
    const pending = {
      revision: 1n,
      rows: [],
      coverage: {
        complete: false,
        pending: [{ baseKey: 'project_id\0{}', unit: 'p2' }],
        missing: [],
        revoked: [],
      },
    };
    // The reset entry reads again once its window claim settles.
    client.snapshots.push(
      { revision: 1n, rows: [{ id: 'a1', title: 'kept' }], coverage: COMPLETE },
      pending,
      pending,
    );
    const store = new ReactiveClientStore(client);
    const kept = store.query<Row>(querySpec());
    const reset = store.query<Row>(
      querySpec({
        id: 'queries:listReset:hash',
        params: ['p2'],
        coverage: [{ table: 'tasks', base: BASE, units: ['p2'] }],
      }),
    );
    const offKept = kept.subscribe(() => {});
    const offReset = reset.subscribe(() => {});
    await drainMicrotasks();

    expect(kept.getSnapshot()).toMatchObject({
      phase: 'ready',
      rows: [{ id: 'a1', title: 'kept' }],
      availability: { state: 'ready' },
    });
    expect(reset.getSnapshot()).toMatchObject({
      phase: 'loading',
      availability: { state: 'ready' },
    });

    client.emit(
      batch(2n, {
        status: { ...STATUS, upgrading: true, upgradeKeptTables: false },
      }),
    );
    await drainMicrotasks();
    expect(kept.getSnapshot().availability).toEqual({
      state: 'migrating',
      currentSchemaVersion: 1,
    });
    offKept();
    offReset();
    store.dispose();
  });
});
