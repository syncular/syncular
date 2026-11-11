/**
 * The development profiler over stubs and a virtual clock: every wrapped
 * surface records into one report, a worker's statements and rounds reach
 * the page over a channel, and `assertBudgets` names each exceeded budget.
 */
import { expect, test } from 'bun:test';
import type { QueryReadSpec, QuerySnapshot } from '../src/client';
import type { ClientDatabase, SqlRow } from '../src/database';
import {
  assertBudgets,
  createSyncProfiler,
  type ProfileReport,
} from '../src/dev-profiler';
import type { ClientDiagnosticsSnapshot } from '../src/diagnostics';
import { ClientSyncError } from '../src/errors';
import type { ClientChangeBatch } from '../src/invalidation';
import type { SyncProgress } from '../src/progress';
import type { RealtimeHandlers } from '../src/transport';

const drainMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function clock() {
  const state = { ms: 0 };
  return { state, now: () => state.ms };
}

function stubClient(rows: () => readonly SqlRow[], async = false) {
  const change = new Set<(batch: ClientChangeBatch) => void>();
  const progress = new Set<(progress: SyncProgress) => void>();
  const diagnostics = new Set<(snapshot: ClientDiagnosticsSnapshot) => void>();
  const mutations: unknown[] = [];
  const on =
    <T>(set: Set<T>) =>
    (listener: T) => {
      set.add(listener);
      return () => set.delete(listener);
    };
  const client = {
    label: 'stub',
    querySnapshot(spec: QueryReadSpec): QuerySnapshot | Promise<QuerySnapshot> {
      const snapshot: QuerySnapshot = {
        revision: 1n,
        rows: rows(),
        coverage: { complete: true, pending: [], missing: [] },
      };
      expect(spec.sql).toBe('SELECT id FROM tasks');
      return async ? Promise.resolve(snapshot) : snapshot;
    },
    mutate(input: readonly unknown[]) {
      mutations.push(input);
      return `commit-${mutations.length}`;
    },
    onChange: on(change),
    onProgress: on(progress),
    onDiagnostics: on(diagnostics),
  };
  return {
    client,
    mutations,
    changed: (...tables: string[]) => {
      for (const listener of change)
        listener({
          revision: 2n,
          tables: tables.map((table) => ({ table })),
          windows: [],
          conflictsChanged: false,
          rejectionsChanged: false,
          outcomesChanged: false,
        });
    },
    progress: (event: Partial<SyncProgress>) => {
      for (const listener of progress)
        listener({
          attempt: 1,
          state: 'running',
          phase: 'download',
          bytesReceived: 0,
          rowsProcessed: 0,
          ...event,
        });
    },
    diagnostics: (activeUnits: number) => {
      for (const listener of diagnostics)
        listener({ activeUnits } as ClientDiagnosticsSnapshot);
    },
  };
}

test('statements: SQL, runs, rows and time per statement; other methods pass through', () => {
  const time = clock();
  const profiler = createSyncProfiler({ now: time.now });
  let transactions = 0;
  const database: ClientDatabase = {
    exec: () => {
      time.state.ms += 2;
    },
    query: () => {
      time.state.ms += 5;
      return [{ a: 1 }, { a: 2 }];
    },
    queryReadOnly: () => [{ a: 1 }],
    transaction: (fn) => {
      transactions += 1;
      return fn();
    },
    close: () => {},
  };
  const wrapped = profiler.database(database);
  wrapped.transaction(() => {
    wrapped.exec('UPDATE t SET a = ?', [1]);
    wrapped.exec('UPDATE t SET a = ?', [2]);
    wrapped.query('SELECT a FROM t');
  });
  wrapped.queryReadOnly('SELECT a FROM t');
  expect(transactions).toBe(1);
  expect('withSqliteImage' in wrapped).toBe(false);
  expect(profiler.report().statements).toEqual([
    { sql: 'UPDATE t SET a = ?', runs: 2, totalMs: 4, maxMs: 2, rows: 0 },
    { sql: 'SELECT a FROM t', runs: 2, totalMs: 5, maxMs: 5, rows: 3 },
  ]);
});

test('rounds: HTTP bytes and time, socket round chunks, deltas', async () => {
  const time = clock();
  const profiler = createSyncProfiler({ now: time.now });
  const transport = profiler.transport(async (request) => {
    time.state.ms += 7;
    return new Uint8Array(request.length * 10);
  });
  await transport(new Uint8Array(3));

  let handlers: RealtimeHandlers | undefined;
  const sent: Uint8Array[] = [];
  const texts: string[] = [];
  const connect = profiler.realtime((h) => {
    handlers = h;
    return {
      send: () => {},
      sendBytes: (bytes) => sent.push(bytes),
      close: () => {},
    };
  });
  const socket = await connect(
    { onText: (text) => texts.push(text), onBinary: () => {} },
    'client-1',
  );
  socket.sendBytes(Uint8Array.of(1, 9, 9, 9, 9));
  time.state.ms += 3;
  handlers!.onBinary(Uint8Array.of(1, 8, 8));
  time.state.ms += 1;
  handlers!.onBinary(Uint8Array.of(1, 8));
  handlers!.onBinary(Uint8Array.of(0, 7, 7, 7));
  handlers!.onText('{"event":"heartbeat"}');

  const report = profiler.report();
  expect(sent).toHaveLength(1);
  expect(texts).toEqual(['{"event":"heartbeat"}']);
  expect(report.rounds).toEqual([
    { via: 'http', requestBytes: 3, responseBytes: 30, ms: 7 },
    { via: 'socket', requestBytes: 4, responseBytes: 3, ms: 4 },
  ]);
  expect(report.deltas).toEqual({ count: 1, bytes: 3 });
});

test('queries: runs, identical runs, triggers per changed table, sync and async clients', async () => {
  for (const async of [false, true]) {
    const time = clock();
    const profiler = createSyncProfiler({ now: time.now });
    let rows: SqlRow[] = [{ id: 't1' }];
    const stub = stubClient(() => rows, async);
    const client = profiler.client(stub.client);
    const read = () =>
      client.querySnapshot({
        sql: 'SELECT id FROM tasks',
        owner: { id: 'tasks', tables: ['tasks', 'projects'] },
      });
    await read();
    stub.changed('tasks');
    await read();
    stub.changed('projects');
    rows = [{ id: 't1' }, { id: 't2' }];
    await read();
    await read();
    stub.changed('comments');
    await read();
    expect(client.label).toBe('stub');
    expect(profiler.report().queries).toEqual([
      {
        id: 'tasks',
        sql: 'SELECT id FROM tasks',
        tables: ['tasks', 'projects'],
        runs: 5,
        identicalRuns: 3,
        totalMs: 0,
        maxMs: 0,
        rows: 2,
        triggers: { mount: 1, tasks: 1, projects: 1, refresh: 2 },
      },
    ]);
  }
});

test('units and writes: peak units, bootstrap bytes across segments, single-operation bursts', () => {
  const time = clock();
  const profiler = createSyncProfiler({ now: time.now, unitLimit: 50 });
  const stub = stubClient(() => []);
  const client = profiler.client(stub.client);

  stub.diagnostics(3);
  stub.diagnostics(7);
  stub.diagnostics(4);
  const unit = { unitId: 'u1', table: 'tasks' };
  stub.progress({ phase: 'request' });
  stub.progress({ ...unit, segmentId: 's1', bytesReceived: 0 });
  time.state.ms += 4;
  stub.progress({ ...unit, segmentId: 's1', bytesReceived: 100 });
  stub.progress({
    ...unit,
    segmentId: 's1',
    phase: 'import',
    bytesReceived: 100,
    rowsProcessed: 10,
  });
  stub.progress({
    ...unit,
    segmentId: undefined,
    phase: 'import',
    bytesReceived: 30,
    rowsProcessed: 0,
  });
  time.state.ms += 2;
  stub.progress({
    ...unit,
    segmentId: undefined,
    phase: 'import',
    bytesReceived: 30,
    rowsProcessed: 3,
  });
  stub.progress({
    ...unit,
    segmentId: undefined,
    phase: 'import',
    bytesReceived: 20,
    rowsProcessed: 0,
  });
  stub.progress({
    ...unit,
    segmentId: undefined,
    phase: 'import',
    bytesReceived: 20,
    rowsProcessed: 2,
  });

  const op = (table: string) => ({ table, op: 'delete' as const, rowId: 'r' });
  expect(client.mutate([op('tasks')])).toBe('commit-1');
  time.state.ms += 10;
  client.mutate([op('tasks')]);
  time.state.ms += 16;
  client.mutate([op('comments')]);
  time.state.ms += 17;
  client.mutate([op('tasks')]);
  client.mutate([op('tasks'), op('tasks')]);
  client.mutate([op('tasks')]);

  const report = profiler.report();
  expect(stub.mutations).toHaveLength(6);
  expect(report.units).toEqual({
    active: 4,
    peak: 7,
    limit: 50,
    bootstraps: [{ unitId: 'u1', table: 'tasks', bytes: 150, rows: 15, ms: 6 }],
  });
  expect(report.writes).toEqual({
    mutateCalls: 6,
    operations: 7,
    bursts: [{ commits: 3, tables: ['tasks', 'comments'] }],
  });
});

test('a worker profiler posts statements and rounds; the page merges them and resets both', async () => {
  type Channel = {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
  };
  const pair = (): [Channel, Channel] => {
    const a: Channel = {
      onmessage: null,
      postMessage: (data) => b.onmessage?.({ data } as MessageEvent),
    };
    const b: Channel = {
      onmessage: null,
      postMessage: (data) => a.onmessage?.({ data } as MessageEvent),
    };
    return [a, b];
  };
  const [workerSide, pageSide] = pair();
  const time = clock();
  const worker = createSyncProfiler({ now: time.now, channel: workerSide });
  const page = createSyncProfiler({ now: time.now, channel: pageSide });
  const database = worker.database<ClientDatabase>({
    exec: () => {},
    query: () => [],
    queryReadOnly: () => [{ x: 1 }],
    transaction: (fn) => fn(),
    close: () => {},
  });
  database.queryReadOnly('SELECT x');
  database.queryReadOnly('SELECT x');
  // The worker posts once per microtask turn.
  expect(page.report().statements).toEqual([]);
  await worker.transport(async () => new Uint8Array(4))(new Uint8Array(2));
  await drainMicrotasks();

  const report = page.report();
  expect(report.statements).toEqual([
    { sql: 'SELECT x', runs: 2, totalMs: 0, maxMs: 0, rows: 2 },
  ]);
  expect(report.rounds).toEqual([
    { via: 'http', requestBytes: 2, responseBytes: 4, ms: 0 },
  ]);

  page.reset();
  expect(page.report().statements).toEqual([]);
  expect(worker.report().statements).toEqual([]);
});

test('a build without a development or test signal refuses the profiler', () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    expect(() => createSyncProfiler()).toThrow(
      expect.objectContaining({ code: 'client.profiler_in_production' }),
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('assertBudgets names every exceeded budget with its limit and measured value', () => {
  const report: ProfileReport = {
    queries: [
      {
        id: 'a',
        sql: 'A',
        tables: [],
        runs: 4,
        identicalRuns: 2,
        totalMs: 0,
        maxMs: 0,
        rows: 0,
        triggers: {},
      },
      {
        id: 'b',
        sql: 'B',
        tables: [],
        runs: 9,
        identicalRuns: 1,
        totalMs: 0,
        maxMs: 0,
        rows: 0,
        triggers: {},
      },
    ],
    statements: [],
    rounds: [{ via: 'http', requestBytes: 100, responseBytes: 900, ms: 0 }],
    deltas: { count: 0, bytes: 0 },
    units: { active: 2, peak: 60, limit: 500, bootstraps: [] },
    writes: {
      mutateCalls: 5,
      operations: 5,
      bursts: [{ commits: 5, tables: ['t'] }],
    },
  };
  assertBudgets(report, {
    maxActiveUnits: 60,
    maxRoundBytes: 1000,
    maxRunsPerQuery: 9,
    maxIdenticalRuns: 3,
    maxWriteBurst: 5,
  });
  let error: unknown;
  try {
    assertBudgets(report, {
      maxActiveUnits: 50,
      maxRoundBytes: 999,
      maxRunsPerQuery: 9,
      maxIdenticalRuns: 0,
      maxWriteBurst: 1,
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ClientSyncError);
  expect((error as ClientSyncError).code).toBe(
    'client.profile_budget_exceeded',
  );
  expect((error as ClientSyncError).details).toEqual({
    exceeded: [
      { budget: 'maxActiveUnits', limit: 50, measured: 60 },
      { budget: 'maxRoundBytes', limit: 999, measured: 1000 },
      { budget: 'maxIdenticalRuns', limit: 0, measured: 3 },
      { budget: 'maxWriteBurst', limit: 1, measured: 5 },
    ],
  });
});
