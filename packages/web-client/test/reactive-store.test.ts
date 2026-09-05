import { describe, expect, test } from 'bun:test';
import {
  type ClientChangeBatch,
  type CommitOutcome,
  type ClientChangeListener,
  canonicalValue,
  type QueryReadSpec,
  type QuerySnapshot,
  ReactiveClientStore,
  type ReactiveQueryClient,
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
  leaseState: undefined,
  schemaFloor: undefined,
  syncNeeded: false,
};

const COMPLETE = { complete: true, pending: [], missing: [] } as const;
const BASE: WindowBase = { table: 'tasks', variable: 'project_id' };

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
  readonly reads: QueryReadSpec[] = [];
  readonly setWindowCalls: Array<{
    readonly base: WindowBase;
    readonly units: readonly string[];
  }> = [];
  readonly snapshots: Array<QuerySnapshot<Row> | Promise<QuerySnapshot<Row>>> =
    [];
  statusCalls = 0;
  conflictCalls = 0;
  rejectionCalls = 0;
  currentStatus = STATUS;
  setWindowFailure: Error | undefined;
  setWindowSyncFailure: Error | undefined;

  onChange(listener: ClientChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  }

  windowState(): WindowState {
    return { units: [], pending: [] };
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

  test('zero-row completion changes loading directly to ready atomically', async () => {
    const client = new FakeReactiveClient();
    client.snapshots.push(
      {
        revision: 1n,
        rows: [],
        coverage: {
          complete: false,
          pending: [{ baseKey: 'tasks', unit: 'p1' }],
          missing: [],
        },
      },
      { revision: 2n, rows: [], coverage: COMPLETE },
    );
    const store = new ReactiveClientStore(client);
    const entry = store.query<Row>(
      querySpec({ coverage: [{ base: BASE, units: ['p1'] }] }),
    );
    const phases: string[] = [];
    const off = entry.subscribe(() => phases.push(entry.getSnapshot().phase));
    await drainMicrotasks();
    expect(entry.getSnapshot().phase).toBe('loading');

    client.emit(
      batch(2n, {
        windows: [
          {
            baseKey: 'tasks\0project_id\0{}',
            table: 'tasks',
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
        coverage: [{ base: BASE, units: ['b', 'a', 'a'] }],
      }),
    );
    const right = store.query<Row>(
      querySpec({
        params: ['c'],
        coverage: [{ base: BASE, units: ['c', 'b'] }],
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
      test(`${source} ignores an older result after a newer ${fails ? 'failure' : 'result'}`, async () => {
        const client = new FakeReactiveClient();
        const first = deferred<readonly CommitOutcome[]>();
        const second = deferred<readonly CommitOutcome[]>();
        let reads = 0;
        const read = () => (++reads === 1 ? first.promise : second.promise);
        if (source === 'conflicts') client.conflicts = read;
        else client.commitOutcomes = read;
        const store = new ReactiveClientStore(client);
        const entry = store[source];
        entry.refresh();
        const failure = new Error('latest read failed');
        if (fails) second.reject(failure);
        else second.resolve([]);
        await drainMicrotasks();
        const latest = entry.getSnapshot();
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
        expect(entry.getSnapshot()).toBe(latest);
        expect(latest.error).toBe(fails ? failure : undefined);
        store.dispose();
      });
    }
  }

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

describe('keyed reconciliation performance', () => {
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
    const spec = querySpec({ coverage: [{ base: BASE, units: ['p1'] }] });
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
      querySpec({ coverage: [{ base: BASE, units: ['old'] }] }),
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
    expect(client.setWindowCalls.map((call) => call.units)).toEqual([
      [],
      ['fresh'],
    ]);
    fresh.release();
    await drainMicrotasks();
    expect(store.cacheStats().windowClaims).toBe(0);
    store.dispose();
  });
});
