/**
 * Multi-tab followers (TODO 3.2, REVISE B3): one leader worker core, N
 * follower tabs proxying over a BroadcastChannel. Two handle instances in
 * ONE bun process sharing a lock name IS the multi-tab shape — the lock is
 * an in-process Web-Locks stand-in (bun has no `navigator.locks`), the
 * channel is bun's real `BroadcastChannel`. Everything else — the worker,
 * the server, the wire — is real.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import {
  ClientSyncError,
  type CrossTabChannel,
  createSyncClientHandle,
  FOLLOWER_TIMEOUT_CODE,
  isolatedReplicaNames,
  type LeaderLease,
  type LeaderLock,
  type MultiTabMessage,
  NOT_LEADER_CODE,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
  type SyncClientHandle,
  type SyncClientHandleConfig,
  type WorkerInitConfig,
} from '@syncular/client';
import { hostBoolean } from '../../typegen/test/fixtures/basic/syncular.queries';
import {
  CLIENT_SCHEMA,
  makeServer,
  type TestServer,
  taskValues,
} from './helpers';
import { type HttpTestServer, serveOverHttp } from './http-server';

const WORKER_URL = new URL('./rpc-worker.ts', import.meta.url).href;

/** A shared no-op for the minimal channel stubs below. */
const noop = (): void => undefined;

/**
 * An in-process exclusive lock with real Web-Locks semantics: `tryAcquire`
 * returns undefined when held; `acquire` queues FIFO and resolves when the
 * current holder releases. This is the multi-tab seam the browser fills with
 * `navigator.locks`.
 */
function makeSharedLock(): LeaderLock {
  let holder: symbol | undefined;
  const waiters: Array<(lease: LeaderLease) => void> = [];
  const grant = (): LeaderLease => {
    const token = Symbol('lease');
    holder = token;
    return {
      release: () => {
        if (holder !== token) return;
        holder = undefined;
        const next = waiters.shift();
        if (next !== undefined) next(grant());
      },
    };
  };
  return {
    acquire: () =>
      new Promise<LeaderLease>((resolve) => {
        if (holder === undefined) resolve(grant());
        else waiters.push(resolve);
      }),
    tryAcquire: () =>
      Promise.resolve(holder === undefined ? grant() : undefined),
  };
}

class ChannelPartition {
  readonly #channels = new Map<string, Set<CrossTabChannel>>();
  readonly sent: Array<{
    readonly name: string;
    readonly message: MultiTabMessage;
  }> = [];

  readonly factory = (name: string): CrossTabChannel => {
    const listeners = new Set<(event: { data: MultiTabMessage }) => void>();
    const channel: CrossTabChannel = {
      postMessage: (message) => {
        this.sent.push({ name, message });
        for (const peer of this.#channels.get(name) ?? []) {
          if (peer === channel) continue;
          queueMicrotask(() =>
            (
              peer as CrossTabChannel & {
                deliver?: (message: MultiTabMessage) => void;
              }
            ).deliver?.(message),
          );
        }
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => this.#channels.get(name)?.delete(channel),
    };
    (
      channel as CrossTabChannel & {
        deliver: (message: MultiTabMessage) => void;
      }
    ).deliver = (message) => {
      for (const listener of listeners) listener({ data: message });
    };
    let named = this.#channels.get(name);
    if (named === undefined) {
      named = new Set();
      this.#channels.set(name, named);
    }
    named.add(channel);
    return channel;
  };

  deliver(name: string, message: MultiTabMessage): void {
    for (const channel of this.#channels.get(name) ?? []) {
      (
        channel as CrossTabChannel & {
          deliver?: (message: MultiTabMessage) => void;
        }
      ).deliver?.(message);
    }
  }
}

function fakeReadyWorker(
  clientId: string,
  initConfigs: WorkerInitConfig[],
): Worker {
  const messageListeners = new Set<(event: MessageEvent) => void>();
  let readyScheduled = false;
  const emit = (data: unknown): void => {
    for (const listener of messageListeners) {
      listener({ data } as MessageEvent);
    }
  };
  return {
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type !== 'message' || typeof listener !== 'function') return;
      messageListeners.add(listener as (event: MessageEvent) => void);
      if (!readyScheduled) {
        readyScheduled = true;
        queueMicrotask(() => emit({ t: 'ready' }));
      }
    },
    postMessage: (message: {
      t: string;
      id?: number;
      config?: WorkerInitConfig;
    }) => {
      if (message.t === 'init' && message.config !== undefined) {
        initConfigs.push(message.config);
        queueMicrotask(() =>
          emit({ t: 'result', id: message.id, value: { clientId } }),
        );
      } else if (message.t === 'call') {
        queueMicrotask(() =>
          emit({ t: 'result', id: message.id, value: undefined }),
        );
      }
    },
    terminate: noop,
  } as unknown as Worker;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what = 'condition',
): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error(`${what} not reached`);
}

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
const open: SyncClientHandle[] = [];
let lockSeq = 0;

beforeAll(() => {
  server = makeServer();
  http = serveOverHttp(server);
});

afterEach(async () => {
  for (const handle of open.splice(0)) {
    try {
      await handle.close();
    } catch {
      /* best effort */
    }
  }
});

interface Group {
  readonly lock: LeaderLock;
  readonly lockName: string;
  make(overrides?: Partial<SyncClientHandleConfig>): Promise<SyncClientHandle>;
}

/** A shared lock + lock-name pair: every handle made here is one "tab". */
function makeGroup(): Group {
  const lock = makeSharedLock();
  const lockName = `mt-${lockSeq++}`;
  const make = async (
    overrides?: Partial<SyncClientHandleConfig>,
  ): Promise<SyncClientHandle> => {
    const handle = await createSyncClientHandle({
      worker: () => new Worker(WORKER_URL),
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom' },
      endpoints: {
        syncUrl: http.syncUrl,
        segmentsUrl: http.segmentsUrl,
        realtimeUrl: http.realtimeUrl,
      },
      autoSync: false,
      // multiTab is deliberately OMITTED: this suite exercises the
      // follower path as the default it is (RFC 0002 §2.4).
      leaderLock: lock,
      lockName,
      ...overrides,
    });
    open.push(handle);
    return handle;
  };
  return { lock, lockName, make };
}

test('leader + follower: follower proxies the full API to the one core', async () => {
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-lead' });
  expect(leader.role).toBe('leader');
  expect(leader.isLeader).toBe(true);
  expect(leader.clientId).toBe('mt-lead');

  const follower = await group.make();
  expect(follower.role).toBe('follower');
  expect(follower.isLeader).toBe(false);

  // The follower subscribes + mutates through the leader's single core.
  await follower.subscribe({
    id: 's',
    table: 'tasks',
    scopes: { project_id: ['mp1'] },
  });
  const subsViaLeader = await leader.subscriptions();
  expect(subsViaLeader.map((s) => s.id)).toEqual(['s']);
  const subsViaFollower = await follower.subscriptions();
  expect(subsViaFollower.map((s) => s.id)).toEqual(['s']);

  const commitId = await follower.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('mt1', 'mp1', 'hi') },
  ]);
  expect(commitId.length).toBeGreaterThan(0);
  // Outbox lives on the leader — a follower query sees it there.
  expect((await follower.pendingCommits()).length).toBe(1);

  await follower.syncUntilIdle();
  expect((await leader.pendingCommits()).length).toBe(0);

  // Query forwards to the one DB; the follower sees the same rows.
  const viaFollower = await follower.query(
    'SELECT id, title FROM tasks WHERE id = ?',
    ['mt1'],
  );
  expect(viaFollower).toEqual([{ id: 'mt1', title: 'hi' }]);
  expect(await hostBoolean(follower, { projectId: 'mp1' })).toEqual([
    { id: 'mt1', done: false },
  ]);

  // Byte columns survive structured-clone across the channel.
  const bytesRow = await follower.query("SELECT x'0102ff' AS b");
  expect(bytesRow[0]?.b).toBeInstanceOf(Uint8Array);
  expect([...(bytesRow[0]?.b as Uint8Array)]).toEqual([1, 2, 255]);

  // State surfaces cross the channel.
  expect(await follower.conflicts()).toEqual([]);
  expect(await follower.schemaFloor()).toBeUndefined();
});

test('a follower preflight request gates the already-running shared leader', async () => {
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-security-lead' });
  expect(await leader.securityLifecycle()).toBe('active');

  const follower = await group.make({ securityPreflight: true });
  expect(follower.role).toBe('follower');
  expect(await follower.securityLifecycle()).toBe('preflight');
  expect(await leader.securityLifecycle()).toBe('preflight');
  await expectRejectsWithCode(
    leader.query('SELECT id FROM tasks'),
    SECURITY_PREFLIGHT_REQUIRED_CODE,
  );

  await follower.activateSecurity();
  expect(await leader.securityLifecycle()).toBe('active');
  expect(await leader.query('SELECT id FROM tasks')).toEqual([]);
});

test('events fan out from the leader to two followers', async () => {
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-fan-lead' });
  const f1 = await group.make();
  const f2 = await group.make();

  const inval1: number[] = [];
  const inval2: number[] = [];
  f1.onInvalidate((e) => inval1.push(e.tables.size));
  f2.onInvalidate((e) => inval2.push(e.tables.size));

  await leader.subscribe({
    id: 's',
    table: 'tasks',
    scopes: { project_id: ['fp'] },
  });
  // A mutation on the leader routes touched tables through invalidation,
  // which the bridge fans out to both followers.
  await leader.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('fan1', 'fp', 'x') },
  ]);

  await waitFor(() => inval1.length >= 1, 'follower 1 invalidation');
  await waitFor(() => inval2.length >= 1, 'follower 2 invalidation');
  expect(inval1.some((n) => n >= 1)).toBe(true);
  expect(inval2.some((n) => n >= 1)).toBe(true);
});

test('a follower is bound on return: an event emitted immediately reaches it', async () => {
  // Regression for the binding-window race: before the fix, `make()` handed
  // back a follower whose link had not yet processed the leader's `announce`
  // (epoch -1). Any event the leader fanned out in that window was dropped
  // (epoch mismatch) with no retry — a real multi-tab miss, not just a flake.
  // `bootFollower` now awaits `waitUntilBound`, so the instant `make()`
  // resolves the follower can receive fanned-out events.
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-bind-lead' });
  await leader.subscribe({
    id: 's',
    table: 'tasks',
    scopes: { project_id: ['bp'] },
  });

  const follower = await group.make();
  const seen: number[] = [];
  follower.onInvalidate((e) => seen.push(e.tables.size));

  // No waitFor-then-hope: the mutation's fan-out must land because the
  // follower was already bound when `make()` returned.
  await leader.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('b1', 'bp', 'y') },
  ]);
  await waitFor(() => seen.length >= 1, 'follower invalidation after bind');
  expect(seen.some((n) => n >= 1)).toBe(true);
});

test('leader close → follower promotes, keeps the DB, continues syncing', async () => {
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-promo-lead' });
  const follower = await group.make();

  await leader.subscribe({
    id: 's',
    table: 'tasks',
    scopes: { project_id: ['pp'] },
  });
  await leader.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('before', 'pp', 'A') },
  ]);
  await leader.syncUntilIdle();

  const roles: string[] = [];
  follower.onRoleChange((r) => roles.push(r));
  expect(follower.role).toBe('follower');

  // Leader tab closes → lock releases → follower contests + wins + promotes.
  await leader.close();
  await waitFor(() => follower.role === 'leader', 'follower promotion');
  expect(roles).toEqual(['leader']);
  expect(follower.isLeader).toBe(true);

  // The ex-follower now owns the core; it mutates and converges through the
  // server (server is the source; the local OPFS DB persisted the old row).
  const promotedCommit = await follower.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('after', 'pp', 'B') },
  ]);
  expect(promotedCommit.length).toBeGreaterThan(0);
  await follower.syncUntilIdle();

  // A brand-new tab joining now follows the PROMOTED leader.
  const late = await group.make();
  expect(late.role).toBe('follower');
  await late.subscribe({
    id: 's',
    table: 'tasks',
    scopes: { project_id: ['pp'] },
  });
  await late.syncUntilIdle();
  const rows = await late.query(
    'SELECT id FROM tasks WHERE project_id = ? ORDER BY id',
    ['pp'],
  );
  expect(rows.map((r) => r.id)).toContain('after');
});

test('stale-epoch replies from a dead leader are discarded', async () => {
  // Drive FollowerLink directly against a controllable channel to prove the
  // epoch guard: a res/event stamped for an old epoch is dropped.
  const { FollowerLink } = await import('../src/multi-tab');
  const sent: unknown[] = [];
  let listener: ((e: { data: unknown }) => void) | undefined;
  const channel = {
    postMessage: (m: unknown) => sent.push(m),
    addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => {
      listener = l;
    },
    removeEventListener: noop,
    close: noop,
  };
  const events: unknown[] = [];
  const link = new FollowerLink({
    // biome-ignore lint/suspicious/noExplicitAny: minimal channel stub
    channel: channel as any,
    fromId: 'f',
    onEvent: (e) => events.push(e),
    onLeaderChange: noop,
    callTimeoutMs: 50,
  });

  // Bind to epoch 5.
  listener?.({ data: { t: 'announce', epoch: 5, clientId: 'c5' } });
  expect(link.epoch).toBe(5);

  const call = link.call('query', ['SELECT 1']);
  const req = sent.find((m) => (m as { t: string }).t === 'req') as {
    reqId: number;
  };
  expect(req).toBeDefined();

  // A late reply from epoch 4 (the dead leader) must be discarded.
  listener?.({
    data: { t: 'res', epoch: 4, reqId: req.reqId, ok: true, value: 'stale' },
  });
  // A stale-epoch event is discarded too.
  listener?.({
    data: { t: 'event', epoch: 4, event: { kind: 'presence', scopeKey: 'x' } },
  });
  expect(events.length).toBe(0);

  // The correct-epoch reply settles it.
  listener?.({
    data: { t: 'res', epoch: 5, reqId: req.reqId, ok: true, value: 'fresh' },
  });
  expect(await call).toBe('fresh');
  link.close();
});

test('waitUntilBound resolves on announce and rejects on bind timeout', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  let listener: ((e: { data: unknown }) => void) | undefined;
  const channel = {
    postMessage: noop,
    addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => {
      listener = l;
    },
    removeEventListener: noop,
    close: noop,
  };
  const link = new FollowerLink({
    // biome-ignore lint/suspicious/noExplicitAny: minimal channel stub
    channel: channel as any,
    fromId: 'f',
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 40,
  });
  expect(link.bound).toBe(false);
  const bound = link.waitUntilBound();
  // An announce binds the link → the waiter resolves.
  listener?.({ data: { t: 'announce', epoch: 1, clientId: 'c1' } });
  await bound;
  expect(link.bound).toBe(true);
  // Already bound → resolves synchronously (no new announce needed).
  await link.waitUntilBound();
  link.close();

  // A link that never hears an announce rejects loudly at the deadline.
  const lonely = new FollowerLink({
    // biome-ignore lint/suspicious/noExplicitAny: minimal channel stub
    channel: { ...channel, addEventListener: noop } as any,
    fromId: 'g',
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 20,
  });
  await expectRejectsWithCode(lonely.waitUntilBound(), FOLLOWER_TIMEOUT_CODE);
  lonely.close();
});

test('a follower call times out loudly when no leader answers', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const channel = {
    postMessage: noop,
    addEventListener: noop,
    removeEventListener: noop,
    close: noop,
  };
  const link = new FollowerLink({
    // biome-ignore lint/suspicious/noExplicitAny: minimal channel stub
    channel: channel as any,
    fromId: 'f',
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 30,
  });
  // No announce ever arrives → queued → deadline fires loudly (no hang).
  await expectRejectsWithCode(link.call('query', ['x']), FOLLOWER_TIMEOUT_CODE);
  link.close();
});

test('partitioned channels block visibly without opening a second database', async () => {
  const lock = makeSharedLock();
  const lockName = `mt-partitioned-${lockSeq++}`;
  const leaderPartition = new ChannelPartition();
  const followerPartition = new ChannelPartition();
  const secondFollowerPartition = new ChannelPartition();
  const leader = await createSyncClientHandle({
    worker: () => new Worker(WORKER_URL),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
    channelFactory: leaderPartition.factory,
    clientId: 'partitioned-leader',
    followerCallTimeoutMs: 45,
  });
  open.push(leader);

  let followerWorkerStarts = 0;
  const makePartitionedFollower = async (
    partition: ChannelPartition,
  ): Promise<SyncClientHandle> => {
    const handle = await createSyncClientHandle({
      worker: () => {
        followerWorkerStarts += 1;
        return new Worker(WORKER_URL);
      },
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom' },
      endpoints: { syncUrl: http.syncUrl },
      autoSync: false,
      leaderLock: lock,
      lockName,
      channelFactory: partition.factory,
      followerCallTimeoutMs: 45,
    });
    open.push(handle);
    return handle;
  };
  const follower = await makePartitionedFollower(followerPartition);
  const secondFollower = await makePartitionedFollower(secondFollowerPartition);
  expect(follower.leadership).toEqual({
    state: 'blocked',
    reason: 'leader-unreachable',
    code: FOLLOWER_TIMEOUT_CODE,
    retryable: true,
  });
  expect(secondFollower.leadership.state).toBe('blocked');
  expect(followerWorkerStarts).toBe(0);

  const startedAt = performance.now();
  await expectRejectsWithCode(
    follower.query('SELECT 1'),
    FOLLOWER_TIMEOUT_CODE,
  );
  expect(performance.now() - startedAt).toBeLessThan(20);

  const announce = leaderPartition.sent.findLast(
    (entry) => entry.message.t === 'announce',
  );
  expect(announce).toBeDefined();
  if (announce !== undefined) {
    followerPartition.deliver(announce.name, announce.message);
  }
  await waitFor(
    () => follower.leadership.state === 'follower',
    'blocked follower rebind',
  );
  expect(follower.leadership).toMatchObject({
    state: 'follower',
    leaderClientId: 'partitioned-leader',
  });

  await leader.close();
  await waitFor(() => follower.role === 'leader', 'partitioned promotion');
  expect(followerWorkerStarts).toBe(1);
  expect(secondFollower.role).toBe('follower');
});

test('isolated replicas derive and open distinct ownership tuples', async () => {
  const alpha = isolatedReplicaNames({
    databaseName: 'medical',
    lockName: 'medical-owner',
    replicaId: 'preview-a',
  });
  const beta = isolatedReplicaNames({
    databaseName: 'medical',
    lockName: 'medical-owner',
    replicaId: 'preview-b',
  });
  expect(alpha.databaseName).not.toBe(beta.databaseName);
  expect(alpha.databaseDirectory).not.toBe(beta.databaseDirectory);
  expect(alpha.lockName).not.toBe(beta.lockName);
  expect(alpha.channelName).not.toBe(beta.channelName);

  const acquired: string[] = [];
  const lock: LeaderLock = {
    acquire: async (name) => {
      acquired.push(name);
      return { release: noop };
    },
    tryAcquire: async (name) => {
      acquired.push(name);
      return { release: noop };
    },
  };
  const channels: string[] = [];
  const channelFactory = (name: string): CrossTabChannel => {
    channels.push(name);
    return {
      postMessage: noop,
      addEventListener: noop,
      removeEventListener: noop,
      close: noop,
    };
  };
  const initConfigs: WorkerInitConfig[] = [];
  for (const [id, clientId] of [
    ['preview-a', 'isolated-a'],
    ['preview-b', 'isolated-b'],
  ] as const) {
    const handle = await createSyncClientHandle({
      worker: () => fakeReadyWorker(clientId, initConfigs),
      schema: CLIENT_SCHEMA,
      database: { mode: 'persistent', name: 'medical' },
      endpoints: { syncUrl: http.syncUrl },
      leaderLock: lock,
      lockName: 'medical-owner',
      channelFactory,
      replica: { mode: 'isolated', id },
    });
    open.push(handle);
  }
  expect(new Set(acquired).size).toBe(2);
  expect(new Set(channels).size).toBe(2);
  const databases = initConfigs.map((config) => config.database);
  expect(databases).toEqual([
    {
      mode: 'persistent',
      name: alpha.databaseName,
      directory: alpha.databaseDirectory,
    },
    {
      mode: 'persistent',
      name: beta.databaseName,
      directory: beta.databaseDirectory,
    },
  ]);
});

test('single-tab opt-out: multiTab false keeps the not-leader contract', async () => {
  const lock = makeSharedLock();
  const lockName = `mt-off-${lockSeq++}`;
  const leader = await createSyncClientHandle({
    worker: () => new Worker(WORKER_URL),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
    clientId: 'off-lead',
  });
  open.push(leader);
  expect(leader.isLeader).toBe(true);

  const loser = await createSyncClientHandle({
    worker: () => {
      throw new Error('a non-leader must never spawn a worker');
    },
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    leaderLock: lock,
    lockName,
    // The explicit opt-out (multi-tab followers are the default).
    multiTab: false,
  });
  open.push(loser);
  expect(loser.isLeader).toBe(false);
  expect(loser.role).toBe('follower');
  await expectRejectsWithCode(loser.query('SELECT 1'), NOT_LEADER_CODE);
  await loser.close();
});
