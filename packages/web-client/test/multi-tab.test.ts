/**
 * Multi-tab followers: one leader worker core, N
 * follower tabs proxying over a BroadcastChannel. Two handle instances in
 * ONE bun process sharing a lock name IS the multi-tab shape — the lock is
 * an in-process Web-Locks stand-in (bun has no `navigator.locks`), the
 * channel is bun's real `BroadcastChannel`. Everything else — the worker,
 * the server, the wire — is real.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { unitId } from '@syncular/core';
import {
  ClientSyncError,
  type ClientDiagnosticsSnapshot,
  type CrossTabChannel,
  createSyncClientHandle,
  createTabCoordinator,
  FOLLOWER_TIMEOUT_CODE,
  isolatedReplicaNames,
  LEADER_HANDOVER_CODE,
  LEADER_INCOMPATIBLE_CODE,
  LEADERSHIP_TAKEN_CODE,
  type LeaderLease,
  type LeaderLock,
  type LeaderUnreachableEvent,
  type LeadershipState,
  MULTI_TAB_PROTOCOL_VERSION,
  type MultiTabMessage,
  NOT_LEADER_CODE,
  registerDevtools,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
  type SyncClientHandle,
  type SyncClientHandleConfig,
  type SyncProgress,
  type SyncWorkerEvent,
  TAKEOVER_REFUSED_CODE,
  type TabCoordinator,
  type TabCoordinatorConfig,
  type TabLeaderContext,
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
 * In-process exclusive locks with real Web-Locks semantics, one per name:
 * `tryAcquire` returns undefined when held; `acquire` queues FIFO and resolves
 * when the current holder releases; `steal` takes the lock at once and the
 * holder's lease reports `lost`. This is the multi-tab seam the browser fills
 * with `navigator.locks`. `holdLost` keeps `lost` from reaching a holder, the
 * way a frozen tab runs no task until it resumes.
 */
function makeSharedLock(): LeaderLock & {
  holdLost(): void;
  releaseLost(): void;
} {
  const held = new Map<string, { token: symbol; markLost(): void }>();
  const waiters = new Map<string, Array<(lease: LeaderLease) => void>>();
  let heldLost: Array<() => void> | undefined;
  const grant = (name: string): LeaderLease => {
    const token = Symbol(name);
    let markLost = (): void => {};
    const lost = new Promise<void>((resolve) => {
      markLost = resolve;
    });
    held.set(name, { token, markLost });
    return {
      lost,
      release: () => {
        if (held.get(name)?.token !== token) return;
        held.delete(name);
        const next = waiters.get(name)?.shift();
        if (next !== undefined) next(grant(name));
      },
    };
  };
  return {
    acquire: (name) =>
      new Promise<LeaderLease>((resolve) => {
        if (!held.has(name)) resolve(grant(name));
        else waiters.set(name, [...(waiters.get(name) ?? []), resolve]);
      }),
    tryAcquire: (name) =>
      Promise.resolve(held.has(name) ? undefined : grant(name)),
    steal: (name) => {
      const holder = held.get(name);
      if (holder !== undefined) {
        if (heldLost !== undefined) heldLost.push(holder.markLost);
        else holder.markLost();
      }
      return Promise.resolve(grant(name));
    },
    holdLost: () => {
      heldLost = [];
    },
    releaseLost: () => {
      const pending = heldLost ?? [];
      heldLost = undefined;
      for (const markLost of pending) markLost();
    },
  };
}

class ChannelPartition<E = SyncWorkerEvent> {
  readonly #channels = new Map<string, Set<CrossTabChannel<E>>>();
  readonly sent: Array<{
    readonly name: string;
    readonly message: MultiTabMessage<E>;
  }> = [];

  /** Frozen channels and the sends and deliveries they hold until thawed. */
  readonly #frozen = new Map<CrossTabChannel<E>, Array<() => void>>();

  freeze(channel: CrossTabChannel<E>): void {
    this.#frozen.set(channel, []);
  }

  thaw(channel: CrossTabChannel<E>): void {
    const held = this.#frozen.get(channel) ?? [];
    this.#frozen.delete(channel);
    for (const run of held) run();
  }

  readonly factory = (name: string): CrossTabChannel<E> => {
    const listeners = new Set<(event: { data: MultiTabMessage<E> }) => void>();
    const channel: CrossTabChannel<E> = {
      postMessage: (message) => {
        const send = (): void => {
          this.sent.push({ name, message });
          for (const peer of this.#channels.get(name) ?? []) {
            if (peer === channel) continue;
            const deliver = (): void =>
              (
                peer as CrossTabChannel<E> & {
                  deliver?: (message: MultiTabMessage<E>) => void;
                }
              ).deliver?.(message);
            const held = this.#frozen.get(peer);
            if (held !== undefined) held.push(deliver);
            else queueMicrotask(deliver);
          }
        };
        const held = this.#frozen.get(channel);
        if (held !== undefined) held.push(send);
        else send();
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => this.#channels.get(name)?.delete(channel),
    };
    (
      channel as CrossTabChannel<E> & {
        deliver: (message: MultiTabMessage<E>) => void;
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

  deliver(name: string, message: MultiTabMessage<E>): void {
    for (const channel of this.#channels.get(name) ?? []) {
      (
        channel as CrossTabChannel<E> & {
          deliver?: (message: MultiTabMessage<E>) => void;
        }
      ).deliver?.(message);
    }
  }
}

/**
 * A worker that answers every call at once, except `held`, which it never
 * answers. `posts` receives the function that posts a worker message.
 */
function fakeReadyWorker(
  clientId: string,
  initConfigs: WorkerInitConfig[],
  held?: string,
  posts?: Array<(data: unknown) => void>,
): Worker {
  const messageListeners = new Set<(event: MessageEvent) => void>();
  let readyScheduled = false;
  const emit = (data: unknown): void => {
    for (const listener of messageListeners) {
      listener({ data } as MessageEvent);
    }
  };
  posts?.push(emit);
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
      method?: string;
      config?: WorkerInitConfig;
    }) => {
      if (message.t === 'call' && message.method === held) return;
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
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
  advance: (ms: number) => void;
} {
  let now = 0;
  const timers = new Set<{ readonly at: number; readonly run: () => void }>();
  return {
    now: () => now,
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

test('development registry is opt-in per handle and unregisters on close', async () => {
  const host = globalThis as Record<string, unknown>;
  const registry = () =>
    host.__SYNCULAR__ as { clients: Array<{ ref: unknown }> } | undefined;
  const previousWindow = host.window;
  const previousRegistry = host.__SYNCULAR__;
  host.window = host;
  delete host.__SYNCULAR__;
  try {
    const group = makeGroup();
    const leader = await group.make({
      clientId: 'devtools-leader',
      devtools: registerDevtools,
    });
    const follower = await group.make({ devtools: registerDevtools });
    expect(leader.role).toBe('leader');
    expect(follower.role).toBe('follower');
    expect(registry()?.clients.map((entry) => entry.ref)).toEqual([
      leader,
      follower,
    ]);
    await follower.close();
    expect(registry()?.clients.map((entry) => entry.ref)).toEqual([leader]);
    await leader.close();
    expect(registry()?.clients).toEqual([]);
  } finally {
    if (previousWindow === undefined) delete host.window;
    else host.window = previousWindow;
    if (previousRegistry === undefined) delete host.__SYNCULAR__;
    else host.__SYNCULAR__ = previousRegistry;
  }
});

test('worker leader and follower receive bounded failure evidence and recovery', async () => {
  const workerUrl = new URL('./diagnostics-worker.ts', import.meta.url).href;
  for (const fixture of [
    {
      mode: 'network',
      cause: 'network',
      status: undefined,
      connectivity: 'offline',
    },
    {
      mode: 'coded-network',
      cause: 'network',
      status: undefined,
      connectivity: 'offline',
    },
    { mode: 'status', cause: 'status', status: 500, connectivity: 'online' },
    { mode: 'auth', cause: 'status', status: 401, connectivity: 'online' },
    {
      mode: 'timeout',
      cause: 'timeout',
      status: undefined,
      connectivity: 'unknown',
    },
    {
      mode: 'unknown',
      cause: 'unknown',
      status: undefined,
      connectivity: 'unknown',
    },
  ] as const) {
    const group = makeGroup();
    const options: Partial<SyncClientHandleConfig> = {
      worker: () => new Worker(workerUrl),
      database: { mode: 'custom', options: fixture.mode },
      endpoints: { syncUrl: 'https://example.invalid/sync' },
    };
    const leader = await group.make({
      ...options,
      clientId: `diagnostics-${fixture.mode}`,
    });
    const follower = await group.make(options);
    expect(leader.role).toBe('leader');
    expect(follower.role).toBe('follower');
    const progress = [
      Promise.withResolvers<SyncProgress>(),
      Promise.withResolvers<SyncProgress>(),
    ];
    const diagnostics = [
      Promise.withResolvers<ClientDiagnosticsSnapshot>(),
      Promise.withResolvers<ClientDiagnosticsSnapshot>(),
    ];
    const recovered = [
      Promise.withResolvers<SyncProgress>(),
      Promise.withResolvers<SyncProgress>(),
    ];
    for (const [index, handle] of [leader, follower].entries()) {
      handle.onProgress((value) => {
        if (value.state === 'failed') progress[index]!.resolve(value);
        if (value.state === 'complete') recovered[index]!.resolve(value);
      });
      handle.onDiagnostics((value) => {
        if (value.lastRound?.status === 'failed')
          diagnostics[index]!.resolve(value);
      });
    }
    try {
      let error: unknown;
      try {
        await leader.sync();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ClientSyncError);
      const seenProgress = await Promise.all(
        progress.map((item) => item.promise),
      );
      const seenDiagnostics = await Promise.all(
        diagnostics.map((item) => item.promise),
      );
      for (const item of seenProgress) {
        expect(item.causeKind).toBe(fixture.cause);
        expect(item.httpStatus).toBe(fixture.status);
      }
      for (const item of seenDiagnostics) {
        expect(item.host.connectivity).toBe(fixture.connectivity);
        expect(item.lastRound?.status).toBe('failed');
        if (item.lastRound?.status !== 'failed')
          throw new Error('missing failed round');
        expect(item.lastRound.causeKind).toBe(fixture.cause);
        expect(item.lastRound.httpStatus).toBe(fixture.status);
      }
      expect(JSON.stringify({ seenProgress, seenDiagnostics })).not.toContain(
        'secret',
      );
      await leader.sync();
      for (const item of await Promise.all(
        recovered.map((entry) => entry.promise),
      )) {
        expect(item.causeKind).toBeUndefined();
        expect(item.httpStatus).toBeUndefined();
      }
      for (const handle of [leader, follower]) {
        const snapshot = await handle.diagnosticsSnapshot();
        expect(snapshot.lastRound?.status).toBe('succeeded');
        expect(snapshot.host.connectivity).toBe('online');
      }
    } finally {
      await follower.close();
      await leader.close();
    }
  }
});

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
  const id = await follower.subscribe({ project_id: 'mp1' });
  expect(id).toBe(unitId({ project_id: 'mp1' }));
  const subsViaLeader = await leader.units();
  expect(subsViaLeader.map((s) => s.id)).toEqual([id]);
  const subsViaFollower = await follower.units();
  expect(subsViaFollower.map((s) => s.id)).toEqual([id]);

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

test('a follower registering the leader units again changes nothing', async () => {
  const group = makeGroup();
  const leader = await group.make({ clientId: 'mt-subscription-identity' });
  const follower = await group.make();
  await leader.subscribeMany([{ project_id: 'mp2' }, { project_id: 'mp1' }]);
  await leader.syncUntilIdle();
  const complete = await leader.unit(unitId({ project_id: 'mp2' }));
  expect(complete).toMatchObject({ status: 'active', echo: [] });

  await follower.subscribeMany([
    { project_id: 'mp1' },
    { project_id: 'mp2' },
    { project_id: 'mp1' },
  ]);
  expect(await follower.unit(unitId({ project_id: 'mp2' }))).toEqual(complete);
  expect(await leader.unit(unitId({ project_id: 'mp2' }))).toEqual(complete);
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

  await leader.subscribe({ project_id: 'fp' });
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
  await leader.subscribe({ project_id: 'bp' });

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

  await leader.subscribe({ project_id: 'pp' });
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
  await late.subscribe({ project_id: 'pp' });
  await late.syncUntilIdle();
  const rows = await late.query(
    'SELECT id FROM tasks WHERE project_id = ? ORDER BY id',
    ['pp'],
  );
  expect(rows.map((r) => r.id)).toContain('after');
});

for (const preflight of [false, true]) {
  test(`listeners registered on a follower receive the promoted core's pushes${preflight ? ' under security preflight' : ''}`, async () => {
    const group = makeGroup();
    const config = preflight ? { securityPreflight: true } : {};
    const leader = await group.make({
      clientId: `mt-push-lead-${preflight}`,
      ...config,
    });
    if (preflight) await leader.activateSecurity();
    await leader.subscribe({ project_id: 'np' });
    await leader.syncUntilIdle();
    const configDiagnostics: string[] = [];
    const follower = await group.make({
      ...config,
      onDiagnostics: (snapshot) =>
        configDiagnostics.push(snapshot.replica.localRevision),
    });
    expect(follower.role).toBe('follower');
    const progress: string[] = [];
    const diagnostics: string[] = [];
    let changes = 0;
    follower.onProgress((value) => progress.push(value.state));
    follower.onDiagnostics((snapshot) =>
      diagnostics.push(snapshot.replica.localRevision),
    );
    follower.onChange(() => {
      changes += 1;
    });
    const promoted = Promise.withResolvers<string>();
    follower.onRoleChange(promoted.resolve);

    await leader.close();
    expect(await promoted.promise).toBe('leader');
    if (preflight) {
      await follower.beginSecurityPreflight();
      await follower.activateSecurity();
    }
    const seen = {
      progress: progress.length,
      diagnostics: diagnostics.length,
      changes,
      config: configDiagnostics.length,
    };
    await follower.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('pushed', 'np', 'x') },
    ]);
    await follower.syncUntilIdle();
    expect(progress.slice(seen.progress)).toContain('complete');
    expect(diagnostics.length).toBeGreaterThan(seen.diagnostics);
    expect(configDiagnostics.length).toBeGreaterThan(seen.config);
    expect(changes).toBeGreaterThan(seen.changes);
  });
}

test('every handle observes the end of each automatic drive of its current leader', async () => {
  const lock = makeSharedLock();
  const lockName = `mt-synced-${lockSeq++}`;
  const partition = new ChannelPartition();
  const posts = new Map<string, Array<(data: unknown) => void>>();
  const configSynced: Array<{
    readonly tab: string;
    readonly result: unknown;
  }> = [];
  const make = async (tab: string): Promise<SyncClientHandle> => {
    const workerPosts: Array<(data: unknown) => void> = [];
    posts.set(tab, workerPosts);
    const handle = await createSyncClientHandle({
      worker: () => fakeReadyWorker(tab, [], undefined, workerPosts),
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom' },
      endpoints: { syncUrl: http.syncUrl },
      autoSync: false,
      leaderLock: lock,
      lockName,
      channelFactory: partition.factory,
      onSynced: (result) => configSynced.push({ tab, result }),
    });
    open.push(handle);
    return handle;
  };
  // A drive result as the worker posts it; the summary stays opaque here.
  const drive = (tab: string, result: object): void => {
    for (const post of posts.get(tab) ?? []) {
      post({ t: 'event', event: { kind: 'synced', ...result } });
    }
  };
  const failed = {
    error: { code: 'sync.network', message: 'offline', retryable: true },
  };
  const succeeded = (pushed: number) => ({ summary: { pushed } });

  // (1) Tab b joins while tab a's drive is still running; the drive fails.
  const a = await make('a');
  const b = await make('b');
  expect(b.role).toBe('follower');
  const aSeen: unknown[] = [];
  const bSeen: unknown[] = [];
  a.onSynced((result) => aSeen.push(result));
  const offB = b.onSynced((result) => bSeen.push(result));
  drive('a', failed);
  await drain();
  expect(aSeen).toEqual([failed]);
  expect(bSeen).toEqual([failed]);

  // (2) The next drive succeeds after the failure.
  drive('a', succeeded(1));
  await drain();
  expect(bSeen).toEqual([failed, succeeded(1)]);
  expect(configSynced.map((entry) => entry.tab)).toEqual(['a', 'a']);

  // (3) Tab a closes; b promotes and keeps its listener. Tab c follows b and
  // drops a drive result stamped with a's epoch.
  const announced = partition.sent.find(
    (entry) => entry.message.t === 'announce',
  );
  if (announced?.message.t !== 'announce') throw new Error('no announce');
  const promoted = Promise.withResolvers<string>();
  b.onRoleChange(promoted.resolve);
  await a.close();
  expect(await promoted.promise).toBe('leader');
  const c = await make('c');
  expect(c.role).toBe('follower');
  const cSeen: unknown[] = [];
  c.onSynced((result) => cSeen.push(result));
  partition.deliver(announced.name, {
    t: 'event',
    epoch: announced.message.epoch,
    event: { kind: 'synced', ...succeeded(99) },
  } as MultiTabMessage);
  drive('b', succeeded(2));
  await drain();
  expect(cSeen).toEqual([succeeded(2)]);
  expect(bSeen.at(-1)).toEqual(succeeded(2));
  expect(configSynced.map((entry) => entry.tab)).toEqual(['a', 'a', 'b']);

  // Unsubscribing stops delivery.
  offB();
  drive('b', failed);
  await drain();
  expect(bSeen).toHaveLength(3);
  expect(cSeen).toHaveLength(2);
});

test('a tab promoted while its own core starts past the follower timeout returns as leader', async () => {
  // A full-page navigation: the previous document still holds the lock when
  // this one opens, then releases it without announcing again.
  const group = makeGroup();
  const departed = await group.lock.acquire(group.lockName);
  const contested = Promise.withResolvers<void>();
  const initPosted = Promise.withResolvers<() => void>();
  class HeldInitWorker extends Worker {
    override postMessage(message: { readonly t?: string }): void {
      if (message.t === 'init')
        initPosted.resolve(() => super.postMessage(message));
      else super.postMessage(message);
    }
  }
  const clock = manualClock();
  const states: LeadershipState[] = [];
  const unreachable: LeaderUnreachableEvent[] = [];
  const making = group.make({
    worker: () => new HeldInitWorker(WORKER_URL),
    clientId: 'mt-slow-start',
    securityPreflight: true,
    followerCallTimeoutMs: 30,
    tabClock: clock,
    leaderLock: {
      ...group.lock,
      acquire: (name) => {
        if (name === group.lockName) contested.resolve();
        return group.lock.acquire(name);
      },
    },
    onLeadershipChange: (state) => states.push(state),
    onLeaderUnreachable: (event) => unreachable.push(event),
  });
  await contested.promise;
  departed.release();
  const releaseInit = await initPosted.promise;
  // The worker opens its database for longer than any follower deadline.
  clock.advance(100);
  releaseInit();
  const handle = await making;

  expect(handle.role).toBe('leader');
  expect(handle.leadership).toEqual({
    state: 'leader',
    clientId: 'mt-slow-start',
  });
  expect(states.some((state) => state.state === 'blocked')).toBe(false);
  expect(unreachable).toEqual([]);
  expect(await handle.securityLifecycle()).toBe('preflight');
  await handle.activateSecurity();
  expect(await handle.query('SELECT id FROM tasks')).toEqual([]);
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
    data: {
      t: 'res',
      epoch: 4,
      to: 'f',
      reqId: req.reqId,
      ok: true,
      value: 'stale',
    },
  });
  // A reply on the live epoch for another follower's request of the same id
  // is discarded.
  listener?.({
    data: {
      t: 'res',
      epoch: 5,
      to: 'g',
      reqId: req.reqId,
      ok: true,
      value: 'for g',
    },
  });
  // A stale-epoch event is discarded too.
  listener?.({
    data: { t: 'event', epoch: 4, event: { kind: 'presence', scopeKey: 'x' } },
  });
  expect(events.length).toBe(0);

  // The correct-epoch reply settles it.
  listener?.({
    data: {
      t: 'res',
      epoch: 5,
      to: 'f',
      reqId: req.reqId,
      ok: true,
      value: 'fresh',
    },
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
    invoke: (_tabId, method) =>
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
    invoke: (_tabId, method) =>
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

test('realtime calls in flight to a previous leader settle on the next leader', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  const posted: MultiTabMessage[] = [];
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
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
    callTimeoutMs: 300,
    schedule: clock.schedule,
    replayOnHandover: ['connectRealtime', 'disconnectRealtime'],
  });
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'first', ...ID } });
  const disconnect = link.call('disconnectRealtime', []);
  const connect = link.call('connectRealtime', []);
  const query = link.call('query', []);
  deliver?.({ data: { t: 'announce', epoch: 2, clientId: 'second', ...ID } });
  await expectRejectsWithCode(query, LEADER_HANDOVER_CODE);
  const replayed = posted.filter(
    (message): message is Extract<MultiTabMessage, { t: 'req' }> =>
      message.t === 'req' && message.epoch === 2,
  );
  expect(replayed.map((message) => message.method)).toEqual([
    'disconnectRealtime',
    'connectRealtime',
  ]);
  for (const message of replayed) {
    deliver?.({
      data: {
        t: 'res',
        epoch: 2,
        to: 'f',
        reqId: message.reqId,
        ok: true,
        value: message.method,
      },
    });
  }
  expect(await disconnect).toBe('disconnectRealtime');
  expect(await connect).toBe('connectRealtime');
  link.close();
});

test('a realtime call in flight when the leader releases the lock runs on the promoted core', async () => {
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
    replayOnHandover: ['connectRealtime', 'disconnectRealtime'],
  });
  deliver?.({ data: { t: 'announce', epoch: 1, clientId: 'lead', ...ID } });
  const disconnect = link.call('disconnectRealtime', []);
  const query = link.call('query', []);
  // The leader tab signs out and closes; this tab wins the lock.
  link.unbind();
  await expectRejectsWithCode(query, LEADER_HANDOVER_CODE);
  const invoked: string[] = [];
  link.handOver((method) => {
    invoked.push(method);
    return Promise.resolve('own-core');
  });
  expect(await disconnect).toBe('own-core');
  expect(invoked).toEqual(['disconnectRealtime']);
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
  // This tab's core starts for longer than the follower deadlines.
  clock.advance(300 * 2);
  expect(link.leadershipState).toEqual({
    state: 'waiting',
    reason: 'handover',
  });
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

test('a tab whose own core failed to start waits for another leader under the follower deadlines', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const clock = manualClock();
  const sent: MultiTabMessage[] = [];
  const link = new FollowerLink({
    channel: {
      postMessage: (message) => sent.push(message),
      addEventListener: noop,
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
  const bound = link.waitUntilBound();
  link.unbind();
  const queued = link.call('query', []);
  clock.advance(300 * 2);
  expect(link.leadershipState).toEqual({
    state: 'waiting',
    reason: 'handover',
  });
  const hellos = sent.filter((message) => message.t === 'hello').length;
  link.awaitLeader();
  expect(sent.filter((message) => message.t === 'hello')).toHaveLength(
    hellos + 1,
  );
  clock.advance(300);
  expect(link.leadershipState.state).toBe('blocked');
  await expectRejectsWithCode(queued, FOLLOWER_TIMEOUT_CODE);
  await expectRejectsWithCode(bound, FOLLOWER_TIMEOUT_CODE);
  link.close();
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

test('a newer follower sends one hello to each older leader it hears', async () => {
  const { FollowerLink } = await import('../src/multi-tab');
  const posted: MultiTabMessage[] = [];
  let deliver: ((event: { data: MultiTabMessage }) => void) | undefined;
  const link = new FollowerLink({
    channel: {
      postMessage: (message) => posted.push(message),
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: noop,
      close: noop,
    },
    fromId: 'newer',
    identity: { ...ID, schemaVersion: ID.schemaVersion + 1 },
    onEvent: noop,
    onLeaderChange: noop,
    schedule: manualClock().schedule,
  });
  const hellos = () => posted.filter((message) => message.t === 'hello');
  expect(hellos()).toHaveLength(1);
  const announce = (epoch: number, clientId: string): void =>
    deliver?.({ data: { t: 'announce', epoch, clientId, ...ID } });
  announce(0, 'first');
  // The same leader answering another tab's hello is not asked again.
  announce(0, 'first');
  expect(hellos()).toHaveLength(2);
  announce(1, 'second');
  announce(1, 'second');
  expect(hellos()).toHaveLength(3);
  expect(link.leadershipState).toMatchObject({
    state: 'blocked',
    reason: 'leader-incompatible',
    leader: 'older',
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
    to: 'legacy',
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
  // Each tab also holds a tab lock named under its replica's lock.
  const [alphaTab, alphaLead, betaTab, betaLead] = acquired;
  expect([alphaLead, betaLead]).toEqual([alpha.lockName, beta.lockName]);
  expect(alphaTab?.startsWith(`${alpha.lockName}:tab:`)).toBe(true);
  expect(betaTab?.startsWith(`${beta.lockName}:tab:`)).toBe(true);
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

test('a single-tab leader whose worker factory throws releases the lock', async () => {
  const { lock, lockName } = makeGroup();
  const failure = new Error('worker bundle missing');
  await expect(
    createSyncClientHandle({
      worker: () => {
        throw failure;
      },
      schema: CLIENT_SCHEMA,
      database: { mode: 'custom' },
      endpoints: { syncUrl: http.syncUrl },
      leaderLock: lock,
      lockName,
      multiTab: false,
    }),
  ).rejects.toBe(failure);
  const lease = await lock.tryAcquire?.(lockName);
  expect(lease).toBeDefined();
  await lease?.release();
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

/** Settle queued channel deliveries and lock grants (all microtasks). */
async function drain(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

interface CoreLog {
  readonly calls: Array<readonly [tabId: string, method: string]>;
  readonly closedTabs: string[];
  readonly contexts: Array<TabLeaderContext<string>>;
  closes: number;
}

/**
 * A group of coordinator tabs over one in-process lock and channel set. Each
 * tab's core answers `<method>@<core tab>` and logs the calling tab.
 */
function coordinatorGroup(): {
  readonly log: CoreLog;
  open(
    events: string[],
    overrides?: Partial<TabCoordinatorConfig<string>>,
  ): Promise<TabCoordinator>;
  readonly tabs: TabCoordinator[];
  readonly lock: ReturnType<typeof makeSharedLock>;
  /** Every message posted on the group's channels, in order. */
  readonly sent: ChannelPartition<string>['sent'];
  /** Freeze a tab: its channel messages and lost lease wait for `thaw`. */
  freeze(tab: TabCoordinator): void;
  thaw(tab: TabCoordinator): void;
} {
  const lock = makeSharedLock();
  const channels = new ChannelPartition<string>();
  const name = `tabs-${lockSeq++}`;
  const log: CoreLog = { calls: [], closedTabs: [], contexts: [], closes: 0 };
  const tabs: TabCoordinator[] = [];
  const opened = new Map<TabCoordinator, Array<CrossTabChannel<string>>>();
  let opening: Array<CrossTabChannel<string>> = [];
  return {
    log,
    tabs,
    lock,
    sent: channels.sent,
    freeze: (tab) => {
      for (const channel of opened.get(tab) ?? []) channels.freeze(channel);
      lock.holdLost();
    },
    thaw: (tab) => {
      lock.releaseLost();
      for (const channel of opened.get(tab) ?? []) channels.thaw(channel);
    },
    open: async (events, overrides) => {
      opening = [];
      const tab = await createTabCoordinator<string>({
        name,
        version: 1,
        lock,
        channelFactory: (channel) => {
          const created = channels.factory(channel);
          opening.push(created);
          return created;
        },
        lead: async (context) => {
          log.contexts.push(context);
          return {
            clientId: `core-${context.tabId}`,
            call: async (tabId, method) => {
              log.calls.push([tabId, method]);
              return `${method}@${context.tabId}`;
            },
            tabClosed: (tabId) => {
              log.closedTabs.push(tabId);
            },
            close: async () => {
              log.closes += 1;
            },
          };
        },
        onEvent: (event) => events.push(event),
        ...overrides,
      });
      opened.set(tab, opening);
      tabs.push(tab);
      return tab;
    },
  };
}

test('a tab coordinator routes each call and event by tab', async () => {
  const group = coordinatorGroup();
  const aEvents: string[] = [];
  const bEvents: string[] = [];
  const cEvents: string[] = [];
  const a = await group.open(aEvents);
  const b = await group.open(bEvents);
  // A third tab that only receives broadcasts.
  await group.open(cEvents);
  try {
    expect(a.state).toEqual({ state: 'leader', clientId: `core-${a.tabId}` });
    expect(b.state).toEqual({
      state: 'follower',
      leaderClientId: `core-${a.tabId}`,
      epoch: 0,
    });

    expect(await a.call('open', [])).toBe(`open@${a.tabId}`);
    expect(await b.call('open', [])).toBe(`open@${a.tabId}`);
    expect(group.log.calls).toEqual([
      [a.tabId, 'open'],
      [b.tabId, 'open'],
    ]);

    const [context] = group.log.contexts;
    context?.send(b.tabId, 'b-view');
    context?.send(a.tabId, 'a-view');
    context?.broadcast('signed-out');
    await drain();
    expect(aEvents).toEqual(['a-view', 'signed-out']);
    expect(bEvents).toEqual(['b-view', 'signed-out']);
    expect(cEvents).toEqual(['signed-out']);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a leader learns that a tab which called it closed', async () => {
  const group = coordinatorGroup();
  const a = await group.open([]);
  const b = await group.open([]);
  const c = await group.open([]);
  try {
    await b.call('open', []);
    await b.call('navigate', []);
    await b.close();
    await c.close();
    await drain();
    // C never called the leader, so its core holds nothing for C.
    expect(group.log.closedTabs).toEqual([b.tabId]);
    expect(a.state.state).toBe('leader');
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a closed leader hands its core to a follower on a higher epoch', async () => {
  const group = coordinatorGroup();
  const bStates: string[] = [];
  const a = await group.open([]);
  const b = await group.open([], {
    onStateChange: (state) => bStates.push(state.state),
  });
  const cEvents: string[] = [];
  const c = await group.open(cEvents);
  try {
    await c.call('open', []);
    await a.close();
    // The call made in the handover gap waits for the next leader.
    const queued = c.call('navigate', []);
    await drain();
    expect(group.log.closes).toBe(1);
    expect(b.state).toEqual({ state: 'leader', clientId: `core-${b.tabId}` });
    expect(bStates).toContain('leader');
    const promoted = group.log.contexts.at(-1);
    expect(promoted?.tabId).toBe(b.tabId);
    expect(promoted?.epoch).toBe(1);
    expect(await queued).toBe(`navigate@${b.tabId}`);
    expect(c.state).toEqual({
      state: 'follower',
      leaderClientId: `core-${b.tabId}`,
      epoch: 1,
    });
    // The promoted core serves its own tab and watches the tabs that call it.
    expect(await b.call('open', [])).toBe(`open@${b.tabId}`);
    promoted?.send(c.tabId, 'c-view');
    await drain();
    expect(cEvents).toEqual(['c-view']);
    await c.close();
    await drain();
    expect(group.log.closedTabs).toEqual([c.tabId]);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a leader of an older build stops its core for a newer tab', async () => {
  const group = coordinatorGroup();
  const older = await group.open([]);
  const newer = await group.open([], { version: 2 });
  try {
    await drain();
    expect(older.state).toEqual({
      state: 'blocked',
      reason: 'leader-incompatible',
      code: LEADER_INCOMPATIBLE_CODE,
      leader: 'newer',
      retryable: true,
    });
    expect(group.log.closes).toBe(1);
    expect(newer.state.state).toBe('leader');
    await expectRejectsWithCode(
      older.call('open', []),
      LEADER_INCOMPATIBLE_CODE,
    );
    expect(await newer.call('open', [])).toBe(`open@${newer.tabId}`);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a tab coordinator that fails to start its core releases the lock', async () => {
  const group = coordinatorGroup();
  let attempts = 0;
  const failing: Partial<TabCoordinatorConfig<string>> = {
    lead: async () => {
      attempts += 1;
      throw new ClientSyncError('client.worker_failed', 'core start failed');
    },
  };
  await expectRejectsWithCode(group.open([], failing), 'client.worker_failed');
  const next = await group.open([]);
  try {
    expect(attempts).toBe(1);
    expect(next.state.state).toBe('leader');
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('two followers whose request ids collide each settle with their own reply', async () => {
  const group = coordinatorGroup();
  const answers = new Map<string, (value: unknown) => void>();
  // The core answers only when the test says so, per calling tab and method.
  const lead: TabCoordinatorConfig<string>['lead'] = async (context) => ({
    clientId: `core-${context.tabId}`,
    call: (tabId, method) =>
      new Promise((resolve) => answers.set(`${method}@${tabId}`, resolve)),
    close: async () => {},
  });
  await group.open([], { lead });
  const reader = await group.open([], { lead });
  const writer = await group.open([], { lead });
  try {
    const read = reader.call('querySnapshot', []);
    const write = writer.call('mutate', []);
    await drain();
    // Both followers count from 1, so their requests share one id.
    expect(
      group.sent.flatMap(({ message }) =>
        message.t === 'req' ? [[message.fromId, message.reqId]] : [],
      ),
    ).toEqual([
      [reader.tabId, 1],
      [writer.tabId, 1],
    ]);
    answers.get(`mutate@${writer.tabId}`)?.('commit-1');
    await drain();
    answers.get(`querySnapshot@${reader.tabId}`)?.('rows');
    expect(await write).toBe('commit-1');
    expect(await read).toBe('rows');
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a newer tab deposes every older tab that promotes before it leads', async () => {
  const group = coordinatorGroup();
  const first = await group.open([]);
  const second = await group.open([]);
  // The second older tab waits for the lock ahead of the newer one.
  const newer = await group.open([], { version: 2 });
  try {
    await drain();
    expect(group.log.contexts.map((context) => context.tabId)).toEqual([
      first.tabId,
      second.tabId,
      newer.tabId,
    ]);
    expect(group.log.closes).toBe(2);
    for (const older of [first, second]) {
      expect(older.state).toEqual({
        state: 'blocked',
        reason: 'leader-incompatible',
        code: LEADER_INCOMPATIBLE_CODE,
        leader: 'newer',
        retryable: true,
      });
    }
    expect(newer.state).toEqual({
      state: 'leader',
      clientId: `core-${newer.tabId}`,
    });
    // The join probe deposes the first tab; the second tab's announce gets
    // one hello; the newer tab's own promotion probes once more.
    expect(
      group.sent.flatMap(({ message }) =>
        message.t === 'hello' && message.fromId === newer.tabId
          ? [message.epoch]
          : [],
      ),
    ).toEqual([-1, 1, 1]);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a promoted tab whose core fails to start reports it and contests the lock again', async () => {
  const group = coordinatorGroup();
  const failure = new ClientSyncError('client.worker_failed', 'start failed');
  const states: LeadershipState[] = [];
  let starts = 0;
  const leader = await group.open([]);
  const follower = await group.open([], {
    onStateChange: (state) => states.push(state),
    lead: async (context) => {
      starts += 1;
      if (starts < 3) throw failure;
      return {
        clientId: `core-${context.tabId}`,
        call: async (_tabId, method) => `${method}@${context.tabId}`,
        close: async () => {},
      };
    },
  });
  try {
    await leader.close();
    await drain();
    expect(starts).toBe(3);
    const failed = states.filter((state) => state.state === 'waiting');
    expect(failed).toMatchObject([
      { state: 'waiting', reason: 'handover' },
      { reason: 'leader-start-failed', attempt: 1, retrying: true },
      { reason: 'leader-start-failed', attempt: 2, retrying: true },
    ]);
    for (const state of failed.slice(1)) {
      expect(
        state.reason === 'leader-start-failed' ? state.error : undefined,
      ).toBe(failure);
    }
    expect(follower.state).toEqual({
      state: 'leader',
      clientId: `core-${follower.tabId}`,
    });
    expect(await follower.call('open', [])).toBe(`open@${follower.tabId}`);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a tab whose core fails three starts stops contesting and follows the next leader', async () => {
  const group = coordinatorGroup();
  let starts = 0;
  const leader = await group.open([]);
  const follower = await group.open([], {
    lead: async () => {
      starts += 1;
      throw new Error('worker bundle missing');
    },
  });
  try {
    await leader.close();
    await drain();
    expect(starts).toBe(3);
    expect(follower.state).toMatchObject({
      state: 'waiting',
      reason: 'leader-start-failed',
      attempt: 3,
      retrying: false,
    });
    const error =
      follower.state.state === 'waiting' &&
      follower.state.reason === 'leader-start-failed'
        ? follower.state.error
        : undefined;
    expect(error?.code).toBe('client.worker_failed');
    expect(error?.message).toBe('the core failed to start');
    // The lock is free: the next tab leads and the failed tab follows it.
    const next = await group.open([]);
    await drain();
    expect(starts).toBe(3);
    expect(next.state.state).toBe('leader');
    expect(follower.state).toMatchObject({
      state: 'follower',
      leaderClientId: `core-${next.tabId}`,
    });
    expect(await follower.call('open', [])).toBe(`open@${next.tabId}`);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

/**
 * Advance a manual clock in steps of `stepMs`, settling channel deliveries
 * after each step so a live leader answers every probe.
 */
async function advanceSettled(
  clock: ReturnType<typeof manualClock>,
  totalMs: number,
  stepMs: number,
): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    clock.advance(stepMs);
    await drain();
  }
}

test('a follower takes over from a frozen leader, which wakes up fenced', async () => {
  const group = coordinatorGroup();
  const clock = manualClock();
  const unreachable: LeaderUnreachableEvent[] = [];
  const timing = { clock, callTimeoutMs: 300 };
  const frozen = await group.open([], timing);
  const taker = await group.open([], {
    ...timing,
    onLeaderUnreachable: (event) => unreachable.push(event),
  });
  try {
    expect(await taker.call('open', [])).toBe(`open@${frozen.tabId}`);
    group.freeze(frozen);

    // The probe after 100 ms stays unanswered; the follower blocks at 300 ms.
    await advanceSettled(clock, 300, 100);
    expect(taker.state).toEqual({
      state: 'blocked',
      reason: 'leader-unreachable',
      code: FOLLOWER_TIMEOUT_CODE,
      retryable: true,
    });
    expect(unreachable).toEqual([
      { phase: 'started', at: 300, takeOverAt: 900 },
    ]);
    try {
      await taker.takeOver();
      throw new Error('takeOver() succeeded before takeOverAfterMs');
    } catch (error) {
      expect(error).toMatchObject({
        code: TAKEOVER_REFUSED_CODE,
        details: { reason: 'too-early', takeOverAt: 900 },
      });
    }

    await advanceSettled(clock, 600, 100);
    await taker.takeOver();
    expect(taker.state).toEqual({
      state: 'leader',
      clientId: `core-${taker.tabId}`,
    });
    const started = group.log.contexts.at(-1);
    expect(started).toMatchObject({
      tabId: taker.tabId,
      epoch: 1,
      takeover: true,
    });
    expect(unreachable.at(-1)).toEqual({
      phase: 'ended',
      at: 900,
      durationMs: 600,
      outcome: 'taken-over',
    });
    expect(await taker.call('navigate', [])).toBe(`navigate@${taker.tabId}`);

    // Frozen, the old leader has not run since: its core is still open.
    expect(frozen.state.state).toBe('leader');
    expect(group.log.closes).toBe(0);
    const callsBeforeWake = group.log.calls.length;

    group.thaw(frozen);
    await drain();
    expect(frozen.state).toEqual({
      state: 'blocked',
      reason: 'leadership-taken',
      code: LEADERSHIP_TAKEN_CODE,
      retryable: true,
    });
    expect(group.log.closes).toBe(1);
    await expectRejectsWithCode(
      frozen.call('write', []),
      LEADERSHIP_TAKEN_CODE,
    );
    // The woken leader's core ran nothing, and the new leader still leads.
    expect(group.log.calls.length).toBe(callsBeforeWake);
    expect(taker.state.state).toBe('leader');
    expect(await taker.call('write', [])).toBe(`write@${taker.tabId}`);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('a responsive hidden leader keeps its lock against takeOver', async () => {
  const group = coordinatorGroup();
  const clock = manualClock();
  const unreachable: LeaderUnreachableEvent[] = [];
  const timing = { clock, callTimeoutMs: 300 };
  const hidden = await group.open([], timing);
  const follower = await group.open([], {
    ...timing,
    onLeaderUnreachable: (event) => unreachable.push(event),
  });
  try {
    // Hidden tabs still dispatch channel messages, so every probe is answered.
    await advanceSettled(clock, 3000, 100);
    expect(follower.state.state).toBe('follower');
    try {
      await follower.takeOver();
      throw new Error('takeOver() succeeded against a responsive leader');
    } catch (error) {
      expect(error).toMatchObject({
        code: TAKEOVER_REFUSED_CODE,
        details: { reason: 'not-unreachable' },
      });
    }
    expect(hidden.state.state).toBe('leader');
    expect(group.log.contexts).toHaveLength(1);
    expect(unreachable).toEqual([]);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('an unreachable period ends when the leader answers again', async () => {
  const group = coordinatorGroup();
  const clock = manualClock();
  const unreachable: LeaderUnreachableEvent[] = [];
  const timing = { clock, callTimeoutMs: 300 };
  const leader = await group.open([], timing);
  const follower = await group.open([], {
    ...timing,
    onLeaderUnreachable: (event) => unreachable.push(event),
  });
  try {
    group.freeze(leader);
    await advanceSettled(clock, 500, 100);
    expect(follower.state.state).toBe('blocked');
    group.thaw(leader);
    // The blocked follower re-probes every 100 ms; the thawed leader answers.
    await advanceSettled(clock, 100, 100);
    expect(follower.state.state).toBe('follower');
    expect(unreachable).toEqual([
      { phase: 'started', at: 300, takeOverAt: 900 },
      { phase: 'ended', at: 600, durationMs: 300, outcome: 'rebound' },
    ]);
  } finally {
    for (const tab of group.tabs) await tab.close();
  }
});

test('takeOver() on a handle opens the worker with the storage takeover flag', async () => {
  const lock = makeSharedLock();
  const channels = new ChannelPartition();
  const clock = manualClock();
  const initConfigs: WorkerInitConfig[] = [];
  const lockName = `takeover-${lockSeq++}`;
  const make = (clientId: string) =>
    createSyncClientHandle({
      worker: () => fakeReadyWorker(clientId, initConfigs),
      schema: CLIENT_SCHEMA,
      database: { mode: 'persistent', name: 'takeover' },
      endpoints: { syncUrl: http.syncUrl },
      leaderLock: lock,
      lockName,
      channelFactory: (name) => {
        const channel = channels.factory(name);
        created.push(channel);
        return channel;
      },
      followerCallTimeoutMs: 300,
      tabClock: clock,
    });
  let created: CrossTabChannel[] = [];
  const frozen = await make('frozen-leader');
  open.push(frozen);
  const frozenChannels = created;
  created = [];
  const taker = await make('taker');
  open.push(taker);
  for (const channel of frozenChannels) channels.freeze(channel);
  lock.holdLost();
  await advanceSettled(clock, 900, 100);
  expect(taker.leadership).toMatchObject({ reason: 'leader-unreachable' });
  await taker.takeOver();
  expect(taker.role).toBe('leader');
  expect(taker.clientId).toBe('taker');
  expect(initConfigs.map((config) => config.takeOverStorage)).toEqual([
    undefined,
    true,
  ]);
  lock.releaseLost();
  for (const channel of frozenChannels) channels.thaw(channel);
  await drain();
  expect(frozen.role).toBe('follower');
  expect(frozen.leadership).toMatchObject({ reason: 'leadership-taken' });
  await expectRejectsWithCode(frozen.query('SELECT 1'), LEADERSHIP_TAKEN_CODE);
});

test('concurrent and repeated multi-tab leader close join one held lease release', async () => {
  const releases: Array<() => void> = [];
  const lease = (): LeaderLease => ({
    release: () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  });
  const leader = await createSyncClientHandle({
    worker: () => fakeReadyWorker('held-release-leader', []),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: {
      acquire: () => Promise.resolve(lease()),
      tryAcquire: () => Promise.resolve(lease()),
    },
    lockName: `mt-held-release-${lockSeq++}`,
    clientId: 'held-release-leader',
  });
  expect(leader.isLeader).toBe(true);
  const settled: string[] = [];
  const first = leader.close().then(() => settled.push('first'));
  const second = leader.close().then(() => settled.push('second'));
  for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
  expect(settled).toEqual([]);
  while (settled.length < 2) {
    const release = releases.shift();
    expect(release).toBeDefined();
    release?.();
    for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
  }
  await Promise.all([first, second]);
  expect(settled).toEqual(['first', 'second']);
  await leader.close();
  expect(settled).toEqual(['first', 'second']);
});

test('a follower disconnectRealtime in flight when the leader tab closes settles on the promoted core', async () => {
  const lock = makeSharedLock();
  const lockName = `mt-replay-${lockSeq++}`;
  const workerMethods: string[] = [];
  const leader = await createSyncClientHandle({
    worker: () => fakeReadyWorker('replay-leader', [], 'disconnectRealtime'),
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
    clientId: 'replay-leader',
  });
  const follower = await createSyncClientHandle({
    worker: () => {
      const worker = fakeReadyWorker('replay-follower', []);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: { t: string; method?: string }) => {
        if (message.t === 'call' && message.method !== undefined)
          workerMethods.push(message.method);
        post(message);
      };
      return worker;
    },
    schema: CLIENT_SCHEMA,
    database: { mode: 'custom' },
    endpoints: { syncUrl: http.syncUrl },
    autoSync: false,
    leaderLock: lock,
    lockName,
  });
  expect(follower.role).toBe('follower');
  const disconnect = follower.disconnectRealtime();
  await leader.close();
  await disconnect;
  expect(follower.role).toBe('leader');
  expect(workerMethods).toContain('disconnectRealtime');
  await follower.close();
});
