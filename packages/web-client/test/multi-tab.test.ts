/**
 * Multi-tab followers: one leader worker core, N
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
  LEADER_HANDOVER_CODE,
  LEADER_INCOMPATIBLE_CODE,
  type LeaderLease,
  type LeaderLock,
  MULTI_TAB_PROTOCOL_VERSION,
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

/** The identity every tab in a FollowerLink/LeaderBridge unit test shares. */
const ID = { protocol: MULTI_TAB_PROTOCOL_VERSION, schemaVersion: 1 } as const;

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

/**
 * A manual clock for FollowerLink's timer seam: time moves only on `advance`,
 * which runs every due timer in deadline order.
 */
function manualClock(): {
  schedule: (callback: () => void, delayMs: number) => () => void;
  advance: (ms: number) => void;
} {
  let now = 0;
  const timers = new Set<{ readonly at: number; readonly run: () => void }>();
  return {
    schedule: (run, delayMs) => {
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        let next: { readonly at: number; readonly run: () => void } | undefined;
        for (const timer of timers) {
          if (timer.at <= end && (next === undefined || timer.at < next.at)) {
            next = timer;
          }
        }
        if (next === undefined) break;
        timers.delete(next);
        now = next.at;
        next.run();
      }
      now = end;
    },
  };
}

/** Two channel ends that deliver to each other synchronously. */
function channelPair(): {
  leader: CrossTabChannel;
  follower: CrossTabChannel;
  fromLeader: MultiTabMessage[];
  fromFollower: MultiTabMessage[];
} {
  const leaderListeners = new Set<(event: { data: MultiTabMessage }) => void>();
  const followerListeners = new Set<
    (event: { data: MultiTabMessage }) => void
  >();
  const fromLeader: MultiTabMessage[] = [];
  const fromFollower: MultiTabMessage[] = [];
  const end = (
    own: Set<(event: { data: MultiTabMessage }) => void>,
    peer: Set<(event: { data: MultiTabMessage }) => void>,
    log: MultiTabMessage[],
  ): CrossTabChannel => ({
    postMessage: (message) => {
      log.push(message);
      for (const listener of peer) listener({ data: message });
    },
    addEventListener: (_type, listener) => own.add(listener),
    removeEventListener: (_type, listener) => own.delete(listener),
    close: noop,
  });
  return {
    leader: end(leaderListeners, followerListeners, fromLeader),
    follower: end(followerListeners, leaderListeners, fromFollower),
    fromLeader,
    fromFollower,
  };
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
      // follower path as the default it is.
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
  expect((await follower.statusSnapshot()).schemaFloor).toBeUndefined();
  const leaderDiagnostics = await leader.diagnosticsSnapshot();
  const followerDiagnostics = await follower.diagnosticsSnapshot();
  expect(leaderDiagnostics.host).toMatchObject({
    kind: 'worker',
    role: 'leader',
  });
  expect(followerDiagnostics.host).toMatchObject({
    kind: 'worker',
    role: 'follower',
  });
  expect({
    ...followerDiagnostics,
    capturedAtMs: leaderDiagnostics.capturedAtMs,
    host: leaderDiagnostics.host,
  }).toEqual(leaderDiagnostics);
});

test('a follower cannot rebind a leader-owned subscription identity', async () => {
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-subscription-identity' });
  const follower = await group.make();
  await leader.subscribe({
    id: 'stable-subscription',
    table: 'tasks',
    scopes: { project_id: ['mp2', 'mp1'] },
    params: '{"view":"v1"}',
  });
  await leader.syncUntilIdle();
  const complete = await leader.subscription('stable-subscription');
  expect(complete?.cursor).toBeGreaterThanOrEqual(0);

  await follower.subscribe({
    id: 'stable-subscription',
    table: 'tasks',
    scopes: { project_id: ['mp1', 'mp2', 'mp1'] },
    params: '{"view":"v1"}',
  });
  expect(await follower.subscription('stable-subscription')).toEqual(complete);

  await expect(
    follower.subscribe({
      id: 'stable-subscription',
      table: 'tasks',
      scopes: { project_id: ['mp2'] },
      params: '{"view":"v1"}',
    }),
  ).rejects.toMatchObject({
    code: 'client.subscription_intent_mismatch',
  });
  expect(await leader.subscription('stable-subscription')).toEqual(complete);
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
  const diagnostics1: string[] = [];
  const diagnostics2: string[] = [];
  f1.onInvalidate((e) => inval1.push(e.tables.size));
  f2.onInvalidate((e) => inval2.push(e.tables.size));
  f1.onDiagnostics((snapshot) =>
    diagnostics1.push(snapshot.replica.localRevision),
  );
  f2.onDiagnostics((snapshot) =>
    diagnostics2.push(snapshot.replica.localRevision),
  );

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
  await waitFor(() => diagnostics1.length >= 1, 'follower 1 diagnostics');
  await waitFor(() => diagnostics2.length >= 1, 'follower 2 diagnostics');
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
    // oxlint-disable-next-line typescript/no-explicit-any -- minimal channel stub
    channel: channel as any,
    fromId: 'f',
    identity: ID,
    onEvent: (e) => events.push(e),
    onLeaderChange: noop,
    callTimeoutMs: 50,
  });

  // Bind to epoch 5.
  listener?.({ data: { t: 'announce', epoch: 5, clientId: 'c5', ...ID } });
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
  const clock = manualClock();
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
    // oxlint-disable-next-line typescript/no-explicit-any -- minimal channel stub
    channel: channel as any,
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 40,
    schedule: clock.schedule,
  });
  expect(link.bound).toBe(false);
  const bound = link.waitUntilBound();
  // An announce binds the link → the waiter resolves.
  listener?.({ data: { t: 'announce', epoch: 1, clientId: 'c1', ...ID } });
  await bound;
  expect(link.bound).toBe(true);
  // Already bound → resolves synchronously (no new announce needed).
  await link.waitUntilBound();
  link.close();

  // A link that never hears an announce rejects loudly at the deadline.
  const lonely = new FollowerLink({
    // oxlint-disable-next-line typescript/no-explicit-any -- minimal channel stub
    channel: { ...channel, addEventListener: noop } as any,
    fromId: 'g',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 20,
    schedule: clock.schedule,
  });
  const lonelyBound = lonely.waitUntilBound();
  clock.advance(20);
  await expectRejectsWithCode(lonelyBound, FOLLOWER_TIMEOUT_CODE);
  lonely.close();
});

test('a follower call times out loudly when no leader answers', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  const channel = {
    postMessage: noop,
    addEventListener: noop,
    removeEventListener: noop,
    close: noop,
  };
  const link = new FollowerLink({
    // oxlint-disable-next-line typescript/no-explicit-any -- minimal channel stub
    channel: channel as any,
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 30,
    schedule: clock.schedule,
  });
  // No announce ever arrives → queued → deadline fires loudly (no hang).
  const call = link.call('query', ['x']);
  clock.advance(30);
  await expectRejectsWithCode(call, FOLLOWER_TIMEOUT_CODE);
  link.close();
});

test('a leader answering probes keeps its follower bound without running a timer', async () => {
  // The leader tab is hidden: its timers never fire, but it still handles
  // channel messages. Only the follower's clock advances.
  const { FollowerLink, LeaderBridge } = await import('../src/multi-tab');
  const clock = manualClock();
  const channels = channelPair();
  const link = new FollowerLink({
    channel: channels.follower,
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  const bridge = new LeaderBridge({
    channel: channels.leader,
    epoch: 1,
    clientId: 'lead',
    identity: ID,
    onNewerTab: noop,
    invoke: (method) =>
      method === 'slow' ? new Promise(noop) : Promise.resolve(`${method}-ok`),
  });
  expect(link.leadershipState).toEqual({
    state: 'follower',
    leaderClientId: 'lead',
    epoch: 1,
  });

  clock.advance(300 * 20);
  expect(link.leadershipState.state).toBe('follower');
  // One probe per 100 ms of leader silence, each answered by an announce.
  expect(
    channels.fromFollower.filter((message) => message.t === 'hello').length,
  ).toBe(61);
  expect(
    channels.fromLeader.filter((message) => message.t === 'announce').length,
  ).toBe(61);
  expect(await link.call('query', [])).toBe('query-ok');

  bridge.close();
  link.close();
});

test('a call a live leader runs behind a long sync round waits past the follower timeout', async () => {
  // The leader's worker serializes setWindow behind a running sync round (a
  // large bootstrap download). The leader tab still answers every probe, so
  // the follower's call waits for the result like a call in the leader tab.
  const { FollowerLink, LeaderBridge } = await import('../src/multi-tab');
  const clock = manualClock();
  const channels = channelPair();
  const link = new FollowerLink({
    channel: channels.follower,
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  let finishRound: (() => void) | undefined;
  const bridge = new LeaderBridge({
    channel: channels.leader,
    epoch: 1,
    clientId: 'lead',
    identity: ID,
    onNewerTab: noop,
    invoke: (method) =>
      method === 'setWindow'
        ? new Promise((resolve) => {
            finishRound = () => resolve('window-applied');
          })
        : Promise.resolve(`${method}-ok`),
  });
  let settled: unknown;
  const call = link.call('setWindow', []);
  void call.then(
    (value) => {
      settled = value;
    },
    (error: unknown) => {
      settled = error;
    },
  );
  clock.advance(300 * 10);
  await Promise.resolve();
  expect(settled).toBeUndefined();
  expect(link.leadershipState.state).toBe('follower');
  finishRound?.();
  expect(await call).toBe('window-applied');
  bridge.close();
  link.close();
});

test('a leader closed while a follower call runs posts no answer on its closed channel', async () => {
  // A browser BroadcastChannel throws InvalidStateError on postMessage after
  // close(); a call that settles after the leader closed must not post.
  const { LeaderBridge } = await import('../src/multi-tab');
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  let closed = false;
  const posted: MultiTabMessage[] = [];
  let finish: ((value: unknown) => void) | undefined;
  const bridge = new LeaderBridge({
    channel: {
      postMessage: (message) => {
        if (closed) throw new Error('InvalidStateError: Channel is closed');
        posted.push(message);
      },
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: noop,
      close: () => {
        closed = true;
      },
    },
    epoch: 1,
    clientId: 'lead',
    identity: ID,
    onNewerTab: noop,
    invoke: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  deliver?.({
    data: {
      t: 'req',
      epoch: 1,
      fromId: 'f',
      reqId: 1,
      method: 'query',
      args: [],
      ...ID,
    },
  });
  bridge.close();
  finish?.('late');
  await Promise.resolve();
  await Promise.resolve();
  expect(posted.filter((message) => message.t === 'res')).toEqual([]);
});

test('calls in flight reject when the leader stops answering probes', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  const link = new FollowerLink({
    channel: {
      postMessage: noop,
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: noop,
      close: noop,
    },
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'lead', ...ID } });
  // The leader tab freezes after it received the call.
  const call = link.call('query', []);
  clock.advance(300);
  expect(link.leadershipState.state).toBe('blocked');
  await expectRejectsWithCode(call, FOLLOWER_TIMEOUT_CODE);
  link.close();
});

test('calls in flight to a previous leader reject when another leader announces', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  const link = new FollowerLink({
    channel: {
      postMessage: noop,
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: noop,
      close: noop,
    },
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'first', ...ID } });
  const call = link.call('query', []);
  deliver?.({ data: { t: 'announce', epoch: 2, clientId: 'second', ...ID } });
  await expectRejectsWithCode(call, LEADER_HANDOVER_CODE);
  expect(link.leadershipState).toEqual({
    state: 'follower',
    leaderClientId: 'second',
    epoch: 2,
  });
  link.close();
});

test('a tab that wins the lock runs the calls queued for the next leader on its own core', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  const link = new FollowerLink({
    channel: {
      postMessage: noop,
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: noop,
      close: noop,
    },
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'lead', ...ID } });
  const sentToOldLeader = link.call('query', ['old']);
  // The old leader released the lock to this tab.
  link.unbind();
  await expectRejectsWithCode(sentToOldLeader, LEADER_HANDOVER_CODE);
  const queued = link.call('setWindow', ['gap']);
  const invoked: unknown[] = [];
  link.handOver((method, args) => {
    invoked.push([method, ...args]);
    return Promise.resolve('own-core');
  });
  expect(await queued).toBe('own-core');
  expect(invoked).toEqual([['setWindow', 'gap']]);
  // The queued call's handover deadline no longer applies.
  clock.advance(300 * 2);
  await expectRejectsWithCode(link.call('query', []), 'client.worker_failed');
});

test('a follower never sends calls to a leader of another build', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  const posted: MultiTabMessage[] = [];
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  const states: unknown[] = [];
  const link = new FollowerLink({
    channel: {
      postMessage: (message) => posted.push(message),
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: noop,
      close: noop,
    },
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    onStateChange: (state) => states.push(state),
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  const bound = link.waitUntilBound();
  const queued = link.call('query', []);
  // A leader from before protocol 1 announces without an identity.
  deliver?.({ data: { t: 'announce', epoch: 3, clientId: 'legacy' } });
  await bound;
  expect(link.leadershipState).toEqual({
    state: 'blocked',
    reason: 'leader-incompatible',
    code: LEADER_INCOMPATIBLE_CODE,
    leader: 'older',
    retryable: true,
  });
  await expectRejectsWithCode(queued, LEADER_INCOMPATIBLE_CODE);
  await expectRejectsWithCode(link.call('query', []), LEADER_INCOMPATIBLE_CODE);
  // A leader with a newer schema blocks it the other way round.
  deliver?.({
    data: {
      t: 'announce',
      epoch: 4,
      clientId: 'newer',
      protocol: ID.protocol,
      schemaVersion: ID.schemaVersion + 1,
    },
  });
  expect(link.leadershipState).toMatchObject({ leader: 'newer' });
  expect(posted.filter((message) => message.t === 'req')).toEqual([]);
  // Blocking is not reachability: no deadline flips it to leader-unreachable.
  clock.advance(300 * 10);
  expect(link.leadershipState).toMatchObject({ reason: 'leader-incompatible' });
  // A leader of this build binds the link.
  deliver?.({ data: { t: 'announce', epoch: 5, clientId: 'same', ...ID } });
  expect(link.leadershipState).toEqual({
    state: 'follower',
    leaderClientId: 'same',
    epoch: 5,
  });
  link.close();
});

test('a leader yields to a newer tab and refuses calls from another build', async () => {
  const { LeaderBridge } = await import('../src/multi-tab');
  const channels = channelPair();
  let yielded = 0;
  const bridge = new LeaderBridge({
    channel: channels.leader,
    epoch: 1,
    clientId: 'lead',
    identity: ID,
    onNewerTab: () => {
      yielded += 1;
    },
    invoke: () => Promise.resolve('served'),
  });
  // A request from a tab before protocol 1 carries no identity.
  channels.follower.postMessage({
    t: 'req',
    epoch: 1,
    fromId: 'legacy',
    reqId: 7,
    method: 'query',
    args: [],
  });
  await Promise.resolve();
  expect(channels.fromLeader.at(-1)).toEqual({
    t: 'res',
    epoch: 1,
    reqId: 7,
    ok: false,
    error: {
      code: LEADER_INCOMPATIBLE_CODE,
      message: 'the leader runs a different protocol or schema version',
      retryable: true,
    },
  });
  // An older tab's hello is answered; it blocks itself on the announce.
  channels.follower.postMessage({
    t: 'hello',
    fromId: 'older',
    protocol: ID.protocol,
    schemaVersion: ID.schemaVersion - 1,
  });
  expect(channels.fromLeader.at(-1)).toMatchObject({ t: 'announce', ...ID });
  expect(yielded).toBe(0);
  // A newer tab's hello makes the leader step down without announcing.
  const sent = channels.fromLeader.length;
  channels.follower.postMessage({
    t: 'hello',
    fromId: 'newer',
    protocol: ID.protocol + 1,
    schemaVersion: ID.schemaVersion,
  });
  expect(yielded).toBe(1);
  expect(channels.fromLeader.length).toBe(sent);
  channels.follower.postMessage({ t: 'hello', fromId: 'f', ...ID });
  bridge.announce();
  expect(channels.fromLeader.length).toBe(sent);
});

test('a newer tab takes over from an older leader, which stays blocked', async () => {
  const lock = makeSharedLock();
  const lockName = `mt-newer-${lockSeq++}`;
  const partition = new ChannelPartition();
  const initConfigs: WorkerInitConfig[] = [];
  const make = async (
    schemaVersion: number,
    clientId: string,
  ): Promise<SyncClientHandle> => {
    const handle = await createSyncClientHandle({
      worker: () => fakeReadyWorker(clientId, initConfigs),
      schema: { ...CLIENT_SCHEMA, version: schemaVersion },
      database: { mode: 'custom' },
      endpoints: { syncUrl: http.syncUrl },
      autoSync: false,
      leaderLock: lock,
      lockName,
      channelFactory: partition.factory,
      followerCallTimeoutMs: 1_000,
    });
    open.push(handle);
    return handle;
  };
  const older = await make(CLIENT_SCHEMA.version, 'older');
  expect(older.role).toBe('leader');
  const newer = await make(CLIENT_SCHEMA.version + 1, 'newer');
  await waitFor(() => newer.role === 'leader', 'newer tab promotion');
  expect(newer.leadership).toEqual({ state: 'leader', clientId: 'newer' });
  expect(older.role).toBe('follower');
  expect(older.leadership).toEqual({
    state: 'blocked',
    reason: 'leader-incompatible',
    code: LEADER_INCOMPATIBLE_CODE,
    leader: 'newer',
    retryable: true,
  });
  await expectRejectsWithCode(
    older.query('SELECT 1'),
    LEADER_INCOMPATIBLE_CODE,
  );
  expect(initConfigs.map((config) => config.schema.version)).toEqual([
    CLIENT_SCHEMA.version,
    CLIENT_SCHEMA.version + 1,
  ]);
});

test('a leader that processes no messages blocks its follower until a probe is answered', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  const posted: MultiTabMessage[] = [];
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  const channel: CrossTabChannel = {
    postMessage: (message) => posted.push(message),
    addEventListener: (_type, listener) => {
      deliver = listener;
    },
    removeEventListener: noop,
    close: noop,
  };
  const states: string[] = [];
  const link = new FollowerLink({
    channel,
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    onStateChange: (state) => states.push(state.state),
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'lead', ...ID } });
  // From here on the leader tab is hung: nothing it would answer arrives.
  posted.length = 0;
  clock.advance(99);
  expect(posted).toEqual([]);
  clock.advance(1);
  expect(posted).toEqual([{ t: 'hello', fromId: 'f', epoch: 1, ...ID }]);
  expect(link.leadershipState.state).toBe('follower');
  clock.advance(199);
  expect(link.leadershipState.state).toBe('follower');
  clock.advance(1);
  expect(link.leadershipState).toEqual({
    state: 'blocked',
    reason: 'leader-unreachable',
    code: FOLLOWER_TIMEOUT_CODE,
    retryable: true,
  });
  await expectRejectsWithCode(link.call('query', []), FOLLOWER_TIMEOUT_CODE);

  // A blocked link keeps probing, and an answer rebinds the same link.
  posted.length = 0;
  clock.advance(100);
  expect(posted).toEqual([{ t: 'hello', fromId: 'f', epoch: 1, ...ID }]);
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'lead', ...ID } });
  expect(link.leadershipState.state).toBe('follower');
  expect(states).toEqual(['follower', 'blocked', 'follower']);
  link.close();
});

test('a handover rebinds the follower and flushes calls queued in the gap', async () => {
  const { FollowerLink, LeaderBridge } = await import('../src/multi-tab');
  const clock = manualClock();
  const channels = channelPair();
  const link = new FollowerLink({
    channel: channels.follower,
    fromId: 'f',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
    callTimeoutMs: 300,
    schedule: clock.schedule,
  });
  const first = new LeaderBridge({
    channel: channels.leader,
    epoch: 1,
    clientId: 'first',
    identity: ID,
    onNewerTab: noop,
    invoke: () => Promise.resolve('first'),
  });
  expect(await link.call('query', [])).toBe('first');

  // The leader tab closes and its lock is granted onward: the link unbinds,
  // queues calls, and binds to whichever leader announces the next epoch.
  first.close();
  link.unbind();
  expect(link.leadershipState).toEqual({
    state: 'waiting',
    reason: 'handover',
  });
  const queued = link.call('query', []);
  const second = new LeaderBridge({
    channel: channels.leader,
    epoch: link.maxEpochSeen + 1,
    clientId: 'second',
    identity: ID,
    onNewerTab: noop,
    invoke: () => Promise.resolve('second'),
  });
  expect(await queued).toBe('second');
  expect(link.leadershipState).toEqual({
    state: 'follower',
    leaderClientId: 'second',
    epoch: 2,
  });
  clock.advance(300 * 10);
  expect(link.leadershipState.state).toBe('follower');
  second.close();
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

test('a closed follower never promotes itself, and frees the lock for the next tab', async () => {
  // A follower keeps a blocking `acquire` outstanding so it can take over when
  // the leader departs. Closing the handle has to cancel that intent. It did
  // not: the promotion path only checked whether the handle had been assembled,
  // never whether it had since been closed — so a handle the application had
  // already discarded would wake up on the departing leader's lease, spawn a
  // worker, open the database, and then hold the lock forever. Nothing else
  // could become leader after that.
  //
  // This is the recovery path for a partitioned follower: an app that observes
  // `blocked` and closes the handle to re-open an isolated replica must not be
  // shadowed by a zombie that later claims the shared database.
  const lock = makeSharedLock();
  const lockName = `mt-closed-follower-${lockSeq++}`;
  const initConfigs: WorkerInitConfig[] = [];

  const leader = await createSyncClientHandle({
    worker: () => fakeReadyWorker('closed-follower-leader', initConfigs),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
    clientId: 'closed-follower-leader',
  });
  expect(leader.isLeader).toBe(true);

  let abandonedWorkerStarts = 0;
  const abandoned = await createSyncClientHandle({
    worker: () => {
      abandonedWorkerStarts += 1;
      return fakeReadyWorker('abandoned', initConfigs);
    },
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
    followerCallTimeoutMs: 25,
  });
  expect(abandoned.role).toBe('follower');

  // The application discards this handle — e.g. to re-open in isolated mode.
  await abandoned.close();

  // The leader departs, releasing the lock the closed follower was queued on.
  await leader.close();

  // A fresh tab must be able to take the vacated leadership.
  let successorWorkerStarts = 0;
  const successor = await createSyncClientHandle({
    worker: () => {
      successorWorkerStarts += 1;
      return fakeReadyWorker('successor', initConfigs);
    },
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
    clientId: 'successor',
  });
  open.push(successor);

  expect(abandonedWorkerStarts).toBe(0);
  expect(abandoned.role).toBe('follower');
  expect(successor.isLeader).toBe(true);
  expect(successorWorkerStarts).toBe(1);
});

test('leader and follower preserve structured segment transport evidence', async () => {
  const { FollowerLink, LeaderBridge } = await import('../src/multi-tab');
  const channels = new ChannelPartition();
  const details = {
    path: '/segments/test',
    httpStatus: 200,
    causeMessage: 'Load failed',
  };
  const leader = new LeaderBridge({
    channel: channels.factory('transport-errors'),
    epoch: 1,
    clientId: 'leader',
    identity: ID,
    onNewerTab: noop,
    invoke: async () => {
      throw new ClientSyncError(
        'sync.transport_failed',
        'segment transfer failed',
        true,
        details,
      );
    },
  });
  const follower = new FollowerLink({
    channel: channels.factory('transport-errors'),
    fromId: 'follower',
    identity: ID,
    onEvent: noop,
    onLeaderChange: noop,
  });
  try {
    await follower.waitUntilBound();
    let caught: unknown;
    try {
      await follower.call('sync', []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClientSyncError);
    expect(caught).toMatchObject({
      code: 'sync.transport_failed',
      retryable: true,
      details,
    });
  } finally {
    follower.close();
    leader.close();
  }
});
