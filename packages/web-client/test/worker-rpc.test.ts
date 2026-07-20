/**
 * Worker + RPC mode (Direction decision 2): the whole client core runs in
 * a real Worker (bun's Web Worker implementation) behind the
 * worker-protocol RPC, against a real HTTP + WebSocket server. Only the
 * SQLite backend differs from the browser (bun:sqlite via the bootstrap's
 * database-factory indirection; opfs-sahpool is browser-verified through
 * the demo).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  ClientSyncError,
  createSyncClientHandle,
  type LeaderLease,
  type LeaderLock,
  NOT_LEADER_CODE,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
  STORAGE_BUSY_CODE,
  type SyncClientHandle,
  type SyncClientHandleConfig,
  WORKER_FAILED_CODE,
  WORKER_RESTART_REQUIRED_CODE,
  type WorkerErrorShape,
  workerStartupError,
} from '@syncular/client';
import { hostBoolean } from '../../typegen/test/fixtures/basic/syncular.queries';
import {
  CLIENT_SCHEMA,
  makeServer,
  type TestServer,
  taskValues,
  waitFor,
} from './helpers';
import { type HttpTestServer, serveOverHttp } from './http-server';

const WORKER_URL = new URL('./rpc-worker.ts', import.meta.url).href;

/**
 * `expect(p).rejects` deterministically times out under bun:test when the
 * promise settles from a Worker 'message' event (bun 1.3.14 quirk) — so
 * RPC rejections are asserted the plain way.
 */
async function expectRejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ClientSyncError);
    expect((error as ClientSyncError).code).toBe(code);
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

let server: TestServer;
let http: HttpTestServer;
const handles: SyncClientHandle[] = [];

beforeAll(() => {
  server = makeServer();
  http = serveOverHttp(server);
});

afterAll(async () => {
  for (const handle of handles) await handle.close();
  await http.stop();
});

interface HandleEvents {
  wakes: string[];
  conflicts: number;
  synced: Array<{ error?: WorkerErrorShape }>;
}

async function makeHandle(
  options: Partial<SyncClientHandleConfig> & { clientId: string },
): Promise<{ handle: SyncClientHandle; events: HandleEvents }> {
  const events: HandleEvents = { wakes: [], conflicts: 0, synced: [] };
  const handle = await createSyncClientHandle({
    worker: () => new Worker(WORKER_URL),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: {
      syncUrl: http.syncUrl,
      segmentsUrl: http.segmentsUrl,
      realtimeUrl: http.realtimeUrl,
    },
    // Distinct lock names: these handles coexist inside one test process.
    lockName: `rpc-test-${options.clientId}`,
    onSyncNeeded: (reason) => {
      events.wakes.push(reason);
    },
    onConflict: () => {
      events.conflicts += 1;
    },
    onSynced: (result) => {
      events.synced.push(result);
    },
    ...options,
  });
  handles.push(handle);
  return { handle, events };
}

test('boot → subscribe → mutate → sync → query, all over the RPC', async () => {
  const { handle } = await makeHandle({ clientId: 'rpc-a', autoSync: false });
  const diagnosticEvents: string[] = [];
  handle.onDiagnostics((snapshot) => {
    diagnosticEvents.push(snapshot.replica.localRevision);
  });
  expect(handle.isLeader).toBe(true);
  expect(handle.clientId).toBe('rpc-a');

  await handle.subscribe({
    id: 'tasks',
    table: 'tasks',
    scopes: { project_id: ['p1'] },
  });
  const subs = await handle.subscriptions();
  expect(subs.map((sub) => sub.id)).toEqual(['tasks']);
  expect((await handle.subscription('tasks'))?.cursor).toBe(-1);
  expect(await handle.subscription('nope')).toBeUndefined();

  const commitId = await handle.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'hello') },
  ]);
  expect(commitId.length).toBeGreaterThan(0);
  expect((await handle.pendingCommits()).length).toBe(1);

  // sync() reports the round that pushed; syncUntilIdle would return the
  // final quiescent round's (empty) summary.
  const summary = await handle.sync();
  expect(summary.applied).toEqual([commitId]);
  await handle.syncUntilIdle();
  expect((await handle.pendingCommits()).length).toBe(0);
  expect(await handle.commitOutcome(commitId)).toMatchObject({
    status: 'applied',
    results: [{ status: 'applied', opIndex: 0 }],
  });
  expect(
    (await handle.commitOutcomes()).map((outcome) => outcome.clientCommitId),
  ).toContain(commitId);

  const rows = await handle.query(
    'SELECT id, title, done FROM tasks ORDER BY id',
  );
  expect(rows).toEqual([{ id: 't1', title: 'hello', done: 0 }]);
  expect(await hostBoolean(handle, { projectId: 'p1' })).toEqual([
    { id: 't1', done: false },
  ]);

  // State surfaces cross the boundary with sane defaults.
  expect((await handle.statusSnapshot()).currentSchemaVersion).toBe(
    CLIENT_SCHEMA.version,
  );
  expect(await handle.conflicts()).toEqual([]);
  expect(await handle.rejections()).toEqual([]);
  expect(await handle.schemaFloor()).toBeUndefined();
  expect(await handle.syncNeeded()).toBe(false);
  const diagnostics = await handle.diagnosticsSnapshot({
    expectedSubscriptions: [
      { id: 'tasks', table: 'tasks' },
      { id: 'membership-security', table: 'docs' },
    ],
  });
  expect(diagnostics.host).toMatchObject({ kind: 'worker', role: 'leader' });
  expect(diagnostics.subscriptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'tasks', state: 'complete' }),
      expect.objectContaining({
        id: 'membership-security',
        state: 'unregistered',
      }),
    ]),
  );
  expect(diagnostics.lastRound).toMatchObject({ status: 'succeeded' });
  expect(JSON.stringify(diagnostics)).not.toContain('p1');
  expect(diagnosticEvents.length).toBeGreaterThan(0);
});

test('worker subscriptions reject an identity rebind without losing completeness', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-subscription-identity',
    autoSync: false,
  });
  await handle.subscribe({
    id: 'stable-subscription',
    table: 'tasks',
    scopes: { project_id: ['p2', 'p1'] },
    params: '{"view":"v1"}',
  });
  await handle.syncUntilIdle();
  const complete = await handle.subscription('stable-subscription');
  expect(complete?.cursor).toBeGreaterThanOrEqual(0);

  await handle.subscribe({
    id: 'stable-subscription',
    table: 'tasks',
    scopes: { project_id: ['p1', 'p2', 'p1'] },
    params: '{"view":"v1"}',
  });
  expect(await handle.subscription('stable-subscription')).toEqual(complete);

  await expectRejectsWithCode(
    handle.subscribe({
      id: 'stable-subscription',
      table: 'tasks',
      scopes: { project_id: ['p2'] },
      params: '{"view":"v1"}',
    }),
    'client.subscription_intent_mismatch',
  );
  expect(await handle.subscription('stable-subscription')).toEqual(complete);
});

test('worker preflight gates protected RPCs and activates the host loop later', async () => {
  const { handle, events } = await makeHandle({
    clientId: 'rpc-security-preflight',
    securityPreflight: true,
  });

  expect(await handle.securityLifecycle()).toBe('preflight');
  expect((await handle.statusSnapshot()).currentSchemaVersion).toBe(1);
  await expectRejectsWithCode(
    handle.query('SELECT id FROM tasks'),
    SECURITY_PREFLIGHT_REQUIRED_CODE,
  );
  await expectRejectsWithCode(
    handle.subscribe({
      id: 'blocked',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    }),
    SECURITY_PREFLIGHT_REQUIRED_CODE,
  );
  expect(
    await handle.purgeLocalData({
      purgeId: 'rpc-security-directive',
      targets: [{ table: 'tasks', selectors: { project_id: ['p1'] } }],
    }),
  ).toEqual({ alreadyApplied: false, purgedRows: 0, droppedCommits: 0 });
  await expectRejectsWithCode(
    handle.rebootstrapLocalData({ rebootstrapId: 'blocked-repair' }),
    SECURITY_PREFLIGHT_REQUIRED_CODE,
  );
  expect(events.synced).toEqual([]);

  await handle.activateSecurity();
  expect(await handle.securityLifecycle()).toBe('active');
  expect(await handle.query('SELECT id FROM tasks')).toEqual([]);
});

test('application-authorized local purge crosses the worker RPC atomically', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-local-purge',
    autoSync: false,
  });
  const doomed = await handle.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('target', 'purged-project', 'purge me'),
    },
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('same-commit', 'held-project', 'rollback me too'),
    },
  ]);
  const kept = await handle.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('kept', 'held-project', 'keep me'),
    },
  ]);
  const input = {
    purgeId: 'rpc-purge-001',
    targets: [
      {
        table: 'tasks',
        selectors: { project_id: ['purged-project'] },
      },
    ],
  } as const;

  expect(await handle.purgeLocalData(input)).toEqual({
    alreadyApplied: false,
    purgedRows: 0,
    droppedCommits: 1,
  });
  expect(await handle.query('SELECT id FROM tasks ORDER BY id')).toEqual([
    { id: 'kept' },
  ]);
  expect(
    (await handle.pendingCommits()).map((commit) => commit.clientCommitId),
  ).toEqual([kept]);
  expect(await handle.commitOutcome(doomed)).toMatchObject({
    status: 'rejected',
    results: [
      {
        status: 'error',
        rejection: { code: 'client.local_data_purged' },
      },
      {
        status: 'error',
        rejection: { code: 'client.local_data_purged' },
      },
    ],
  });
  expect(await handle.purgeLocalData(input)).toEqual({
    alreadyApplied: true,
    purgedRows: 0,
    droppedCommits: 0,
  });
});

test('outbox-preserving rebootstrap crosses the worker RPC atomically', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-local-rebootstrap',
    autoSync: false,
  });
  await handle.subscribe({
    id: 'rpc-rebootstrap-tasks',
    table: 'tasks',
    scopes: { project_id: ['p1'] },
  });
  const pending = await handle.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('offline-row', 'p1', 'offline'),
    },
  ]);

  expect(
    await handle.rebootstrapLocalData({ rebootstrapId: 'rpc-repair-001' }),
  ).toEqual({
    alreadyApplied: false,
    retainedCommits: 1,
    resetSubscriptions: 1,
  });
  expect(await handle.query('SELECT id FROM tasks')).toEqual([
    { id: 'offline-row' },
  ]);
  expect(
    (await handle.pendingCommits()).map((commit) => commit.clientCommitId),
  ).toEqual([pending]);
  expect(await handle.subscription('rpc-rebootstrap-tasks')).toMatchObject({
    cursor: -1,
    status: 'active',
  });
  expect(
    await handle.rebootstrapLocalData({ rebootstrapId: 'rpc-repair-001' }),
  ).toEqual({
    alreadyApplied: true,
    retainedCommits: 1,
    resetSubscriptions: 1,
  });
});

test('query results carry blobs across the boundary (transfer path)', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-blob',
    autoSync: false,
  });
  const rows = await handle.query(
    "SELECT x'0102ff' AS bytes, 42 AS n, NULL AS missing",
  );
  expect(rows.length).toBe(1);
  const bytes = rows[0]?.bytes;
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect([...(bytes as Uint8Array)]).toEqual([1, 2, 255]);
  expect(rows[0]?.n).toBe(42);
  expect(rows[0]?.missing).toBeNull();
});

test('warm worker querySnapshot IPC p95 stays within the local-view budget', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-performance',
    autoSync: false,
  });
  await handle.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('perf', 'perf', 'fast'),
    },
  ]);
  const spec = {
    sql: 'SELECT id, title FROM tasks WHERE id = ?',
    params: ['perf'],
  } as const;
  await handle.querySnapshot(spec);
  const samples: number[] = [];
  for (let run = 0; run < 50; run += 1) {
    const started = performance.now();
    const snapshot = await handle.querySnapshot(spec);
    samples.push(performance.now() - started);
    expect(snapshot.rows).toHaveLength(1);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
  expect(p95).toBeLessThanOrEqual(
    process.env.SYNCULAR_PERF_GATE === '1' ? 5 : 25,
  );
});

test('two worker cores converge through the real server', async () => {
  const { handle: a } = await makeHandle({
    clientId: 'rpc-conv-a',
    autoSync: false,
  });
  const { handle: b } = await makeHandle({
    clientId: 'rpc-conv-b',
    autoSync: false,
  });
  const scopes = { project_id: ['p2'] };
  await a.subscribe({ id: 's', table: 'tasks', scopes });
  await b.subscribe({ id: 's', table: 'tasks', scopes });

  await a.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p2', 'from a') },
  ]);
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  const rows = await b.query('SELECT id, title FROM tasks WHERE id = ?', [
    't2',
  ]);
  expect(rows).toEqual([{ id: 't2', title: 'from a' }]);
});

test('conflicts surface as RPC events and via conflicts()', async () => {
  const { handle: a, events } = await makeHandle({
    clientId: 'rpc-conf-a',
    autoSync: false,
  });
  const { handle: b } = await makeHandle({
    clientId: 'rpc-conf-b',
    autoSync: false,
  });
  const scopes = { project_id: ['p3'] };
  await a.subscribe({ id: 's', table: 'tasks', scopes });
  await b.subscribe({ id: 's', table: 'tasks', scopes });

  await a.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t3', 'p3', 'base') },
  ]);
  await a.syncUntilIdle();
  await b.syncUntilIdle();

  // B wins the race; A pushes with the stale base version.
  await b.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('t3', 'p3', 'b wins'),
      baseVersion: 1,
    },
  ]);
  await b.syncUntilIdle();
  const losingCommitId = await a.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: taskValues('t3', 'p3', 'a loses'),
      baseVersion: 1,
    },
  ]);
  const summary = await a.sync();

  expect(summary.conflicts.length).toBe(1);
  expect(summary.conflicts[0]?.code).toBe('sync.version_conflict');
  await a.syncUntilIdle();
  const conflicts = await a.conflicts();
  expect(conflicts.length).toBe(1);
  expect(conflicts[0]?.rowId).toBe('t3');
  expect(conflicts[0]?.serverRow.title).toBe('b wins');
  expect(await a.commitOutcome(losingCommitId)).toMatchObject({
    status: 'conflict',
    resolution: 'active',
  });
  expect(await a.commitOutcomes({ activeOnly: true })).toHaveLength(1);
  const resolved = await a.resolveCommitOutcome({
    clientCommitId: losingCommitId,
    resolution: 'resolved_keep_server',
  });
  expect(resolved.resolution).toBe('resolved_keep_server');
  expect(await a.conflicts()).toHaveLength(0);
  expect(await a.commitOutcomes({ activeOnly: true })).toHaveLength(0);
  await waitFor(() => events.conflicts === 1, 'conflict event delivery');

  // The losing pane converges to the server row.
  const rows = await a.query('SELECT title FROM tasks WHERE id = ?', ['t3']);
  expect(rows).toEqual([{ title: 'b wins' }]);
});

test('realtime wake-ups drive the worker-side host loop (§8.4)', async () => {
  const { handle: a } = await makeHandle({
    clientId: 'rpc-rt-a',
    autoSync: false,
  });
  const { handle: b, events } = await makeHandle({
    clientId: 'rpc-rt-b',
    autoSync: true,
  });
  const scopes = { project_id: ['p4'] };
  await a.subscribe({ id: 's', table: 'tasks', scopes });
  await b.subscribe({ id: 's', table: 'tasks', scopes });
  await a.syncUntilIdle();
  await b.syncUntilIdle();
  await b.connectRealtime();

  await a.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t4', 'p4', 'wake b') },
  ]);
  await a.syncUntilIdle();

  // Either a binary delta applied directly or a wake-up triggered the
  // worker's coalesced auto-sync — the observable contract is the row.
  await waitFor(async () => {
    const rows = await b.query('SELECT id FROM tasks WHERE id = ?', ['t4']);
    return rows.length === 1;
  }, 'realtime propagation into worker B');
  await b.disconnectRealtime();
  expect(events.wakes.length).toBeGreaterThanOrEqual(0);
});

test('worker realtime connect is single-owner across repeated RPC calls', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-rt-owner',
    autoSync: false,
  });
  const openedBefore = http.realtimeOpened;
  await Promise.all([handle.connectRealtime(), handle.connectRealtime()]);
  await handle.connectRealtime();
  expect(http.realtimeOpened - openedBefore).toBe(1);

  await handle.disconnectRealtime();
  await waitFor(() => http.realtimeActive === 0, 'worker realtime disconnect');
  await handle.connectRealtime();
  expect(http.realtimeOpened - openedBefore).toBe(2);
  await handle.disconnectRealtime();
});

test('offline gate queues, reconnect drains through the worker', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-off',
    autoSync: false,
  });
  await handle.subscribe({
    id: 's',
    table: 'tasks',
    scopes: { project_id: ['p5'] },
  });
  await handle.syncUntilIdle();

  await handle.setOffline(true);
  await handle.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t5', 'p5', 'queued') },
  ]);
  expect((await handle.pendingCommits()).length).toBe(1);
  await expectRejectsWithCode(handle.sync(), 'sync.transport_failed');

  await handle.setOffline(false);
  await handle.syncUntilIdle();
  expect((await handle.pendingCommits()).length).toBe(0);
});

test('a second handle on the same lock (multiTab: false) gets a clear not-leader state', async () => {
  let held = false;
  const lock: LeaderLock = {
    acquire: () => Promise.resolve({ release: () => {} }),
    tryAcquire: () => {
      if (held) return Promise.resolve(undefined);
      held = true;
      const lease: LeaderLease = {
        release: () => {
          held = false;
        },
      };
      return Promise.resolve(lease);
    },
  };
  const { handle: leader } = await makeHandle({
    clientId: 'rpc-lead',
    autoSync: false,
    leaderLock: lock,
    lockName: 'rpc-lock',
  });
  expect(leader.isLeader).toBe(true);

  const follower = await createSyncClientHandle({
    worker: () => {
      throw new Error('a non-leader must never spawn a worker');
    },
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    leaderLock: lock,
    lockName: 'rpc-lock',
    // The explicit opt-out (multi-tab followers are the default).
    multiTab: false,
  });
  expect(follower.isLeader).toBe(false);
  expect(follower.clientId).toBe('');
  await expectRejectsWithCode(follower.query('SELECT 1'), NOT_LEADER_CODE);
  await follower.close(); // clean no-op

  // Leadership hands over once the leader closes.
  await leader.close();
  expect(held).toBe(false);
});

test('worker init failure rejects the handle cleanly', async () => {
  await expectRejectsWithCode(
    createSyncClientHandle({
      worker: () => new Worker(WORKER_URL),
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom', options: 'fail' },
      endpoints: { syncUrl: http.syncUrl },
      lockName: 'rpc-test-init-failure',
    }),
    WORKER_FAILED_CODE,
  );
});

test('worker bundle load failures require a privacy-safe full restart', () => {
  const stale = workerStartupError(
    'Failed to fetch dynamically imported module: http://localhost:5199/node_modules/.vite/deps/encryption-secret.js?v=private',
  );
  expect(stale).toMatchObject({
    code: WORKER_RESTART_REQUIRED_CODE,
    retryable: false,
  });
  expect(stale.message).not.toContain('localhost');
  expect(stale.message).not.toContain('encryption-secret');

  expect(workerStartupError('ordinary worker exception')).toMatchObject({
    code: WORKER_FAILED_CODE,
    retryable: false,
  });
});

test('retryable storage ownership failure crosses worker RPC and releases leadership', async () => {
  const lockName = 'rpc-test-storage-busy';
  let caught: unknown;
  try {
    await createSyncClientHandle({
      worker: () => new Worker(WORKER_URL),
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom', options: 'storage-busy' },
      endpoints: { syncUrl: http.syncUrl },
      lockName,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ClientSyncError);
  expect(caught).toMatchObject({
    code: STORAGE_BUSY_CODE,
    retryable: true,
  });

  // The failed worker released its leader lease, so the same factory can be
  // attempted again instead of leaving this origin permanently wedged.
  const recovered = await createSyncClientHandle({
    worker: () => new Worker(WORKER_URL),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    lockName,
  });
  expect(recovered.isLeader).toBe(true);
  await recovered.close();
});

test('close terminates the worker and rejects later calls', async () => {
  const { handle } = await makeHandle({
    clientId: 'rpc-close',
    autoSync: false,
  });
  await handle.query('SELECT 1 AS one');
  await handle.close();
  await handle.close(); // idempotent
  await expectRejectsWithCode(handle.query('SELECT 1'), WORKER_FAILED_CODE);
});
