/**
 * Main-thread side of the worker mode (Direction decision 2) and the
 * multi-tab topology (TODO 3.2, REVISE B3).
 *
 * `createSyncClientHandle` acquires the Web Locks leader lock and, when it
 * wins, spawns the worker running the WHOLE core — so exactly one core runs
 * per origin (the lock IS the invariant: a worker is NEVER spawned without
 * holding the lock). The returned {@link SyncClientHandle} is a thin, fully
 * async proxy over the `worker-protocol` RPC.
 *
 * With `multiTab: true`, a tab that LOSES the election does not resolve to a
 * dead not-leader handle: it becomes a FOLLOWER (`role === 'follower'`) that
 * proxies every call to the leader tab over a BroadcastChannel (see
 * `multi-tab.ts`). When the leader tab closes, its lock releases; the
 * followers contest, the winner PROMOTES in place — spawns the worker over
 * the persisted OPFS database and re-announces — and the handle's `role`
 * flips to `'leader'` with `onRoleChange` firing. The same handle object is
 * kept across the transition so React bindings hold a stable reference.
 *
 * With `multiTab` off (default), behavior is unchanged: the loser is an
 * `isLeader === false` handle whose calls reject with `client.not_leader`.
 */
import type { WakeReason } from '@syncular-v2/core';
import type { BlobRef, CachedBlob } from './blob';
import type {
  ConflictRecord,
  LeaseState,
  MutationInput,
  PresencePeer,
  RejectionRecord,
  SchemaFloor,
  SubscribeInput,
  SyncClientLimits,
  SyncSummary,
  WindowState,
} from './client';
import type { SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import { InvalidationEmitter, type InvalidationListener } from './invalidation';
import {
  type LeaderLease,
  type LeaderLock,
  singleOwnerLock,
  webLocksLeaderLock,
} from './leader-lock';
import {
  broadcastChannelFactory,
  type CrossTabChannel,
  FollowerLink,
  LeaderBridge,
  multiTabChannelName,
  newTabId,
} from './multi-tab';
import type { OutboxCommit } from './outbox';
import type { ClientSchema } from './schema';
import type { SubscriptionRecord } from './state';
import type { WindowBase } from './window';
import {
  type MainToWorkerMessage,
  NOT_LEADER_CODE,
  type SyncWorkerEvent,
  WORKER_FAILED_CODE,
  type WorkerApi,
  type WorkerDatabaseInit,
  type WorkerEndpoints,
  type WorkerErrorShape,
  type WorkerInitConfig,
  type WorkerInitResult,
  type WorkerMethod,
  type WorkerToMainMessage,
} from './worker-protocol';

export type HandleRole = 'leader' | 'follower';

export interface SyncClientHandleConfig {
  /**
   * Spawns the worker running `startSyncWorker()` (a factory so bundlers
   * see `new Worker(new URL(...))` at the call site, and so no worker is
   * spawned when this tab loses the leader election). Called again on a
   * follower's promotion.
   */
  readonly worker: () => Worker;
  readonly schema: ClientSchema;
  readonly database: WorkerDatabaseInit;
  readonly endpoints: WorkerEndpoints;
  readonly clientId?: string;
  readonly limits?: SyncClientLimits;
  /** Worker-side host loop (§8.4); default true. */
  readonly autoSync?: boolean;
  readonly wakeJitterMs?: number;
  /** Default: Web Locks when available, else single-owner. */
  readonly leaderLock?: LeaderLock;
  readonly lockName?: string;
  /**
   * Multi-tab followers (TODO 3.2). When true, a tab that loses the leader
   * election becomes a FOLLOWER that proxies to the leader over a
   * BroadcastChannel, and contests + promotes when the leader closes. When
   * false (default), the loser is a dead `isLeader === false` handle.
   */
  readonly multiTab?: boolean;
  /** Cross-tab channel factory (default `BroadcastChannel`); injectable for tests. */
  readonly channelFactory?: (name: string) => CrossTabChannel;
  /** Deadline for a follower call (covers the leader-handover gap). */
  readonly followerCallTimeoutMs?: number;
  /** Fires when this handle's role changes (follower → leader on promotion). */
  readonly onRoleChange?: (role: HandleRole) => void;
  readonly onSyncNeeded?: (reason: 'hello' | WakeReason) => void;
  readonly onConflict?: (conflict: ConflictRecord) => void;
  /** A worker-side autoSync round finished (or failed). */
  readonly onSynced?: (result: {
    readonly summary?: SyncSummary;
    readonly error?: WorkerErrorShape;
  }) => void;
  /** §7.4.5: schema-bump `upgrading` state changed (reset began/completed). */
  readonly onUpgrading?: (upgrading: boolean) => void;
  /** §8.6: presence on a scope key changed. */
  readonly onPresence?: (scopeKey: string) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function defaultLeaderLock(): LeaderLock {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  return nav?.locks !== undefined
    ? webLocksLeaderLock(nav.locks)
    : singleOwnerLock();
}

/**
 * A running worker core owned by THIS tab (the leader). Wraps the worker,
 * the RPC pending map, and (in multi-tab mode) the `LeaderBridge` relaying
 * follower requests. Torn down on `close()` or on a graceful demotion.
 */
interface LeaderCore {
  readonly clientId: string;
  readonly invoke: (
    method: string,
    args: readonly unknown[],
  ) => Promise<unknown>;
  readonly bridge: LeaderBridge | undefined;
  readonly lease: LeaderLease;
  close(terminate: boolean): Promise<void>;
}

/**
 * The main-thread proxy: the same logical API as `SyncClient`, every method a
 * promise. `role` is `'leader'` (owns the worker) or `'follower'` (proxies to
 * the leader over the channel). Constructed via {@link createSyncClientHandle}.
 */
export class SyncClientHandle {
  /** True only for a leader handle. Kept for the pre-multiTab contract. */
  get isLeader(): boolean {
    return this.#role === 'leader';
  }
  get role(): HandleRole {
    return this.#role;
  }
  /** Resolved client id — the leader's; shared by all tabs on this origin. */
  get clientId(): string {
    return this.#clientId;
  }

  #role: HandleRole;
  #clientId: string;
  #core: LeaderCore | undefined;
  #follower: FollowerLink | undefined;
  readonly #invalidation: InvalidationEmitter;
  readonly #presence: Set<(scopeKey: string) => void>;
  readonly #roleListeners: Set<(role: HandleRole) => void>;
  #closed = false;

  /** @internal — use {@link createSyncClientHandle}. */
  constructor(internals: {
    role: HandleRole;
    clientId: string;
    core?: LeaderCore;
    follower?: FollowerLink;
    invalidation: InvalidationEmitter;
    presence: Set<(scopeKey: string) => void>;
    roleListeners?: Set<(role: HandleRole) => void>;
  }) {
    this.#role = internals.role;
    this.#clientId = internals.clientId;
    this.#core = internals.core;
    this.#follower = internals.follower;
    this.#invalidation = internals.invalidation;
    this.#presence = internals.presence;
    this.#roleListeners = internals.roleListeners ?? new Set();
  }

  /** @internal — swap this handle from follower to leader (promotion). */
  __becomeLeader(core: LeaderCore): void {
    this.#follower?.close();
    this.#follower = undefined;
    this.#core = core;
    this.#clientId = core.clientId;
    this.#role = 'leader';
    for (const listener of this.#roleListeners) {
      try {
        listener('leader');
      } catch {
        /* a UI listener must never break promotion */
      }
    }
  }

  /** @internal — dispatch a worker/relayed event to handle-local listeners. */
  __dispatchEvent(event: SyncWorkerEvent): void {
    if (event.kind === 'presence') {
      for (const listener of this.#presence) {
        try {
          listener(event.scopeKey);
        } catch {
          /* a UI listener must never break event dispatch */
        }
      }
    } else if (event.kind === 'invalidate') {
      this.#invalidation.emit(event.event);
    }
  }

  /**
   * TODO 3.1 / I1: subscribe to fine-grained invalidation — the identical
   * surface as `SyncClient.onInvalidate`, so React bindings target one
   * interface across direct, worker-leader, and follower modes. Returns an
   * unsubscribe function.
   */
  onInvalidate(listener: InvalidationListener): () => void {
    return this.#invalidation.on(listener);
  }

  /**
   * §8.6: subscribe to presence changes — the identical surface as
   * `SyncClient.onPresence`. Returns an unsubscribe function.
   */
  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presence.add(listener);
    return () => {
      this.#presence.delete(listener);
    };
  }

  /** Subscribe to role transitions (follower → leader on promotion). */
  onRoleChange(listener: (role: HandleRole) => void): () => void {
    this.#roleListeners.add(listener);
    return () => {
      this.#roleListeners.delete(listener);
    };
  }

  #call<M extends WorkerMethod>(
    method: M,
    args: Parameters<WorkerApi[M]>,
  ): Promise<Awaited<ReturnType<WorkerApi[M]>>> {
    if (this.#closed) {
      return Promise.reject(
        new ClientSyncError(WORKER_FAILED_CODE, 'the handle is closed'),
      );
    }
    if (this.#role === 'follower') {
      if (this.#follower === undefined) {
        return Promise.reject(
          new ClientSyncError(
            NOT_LEADER_CODE,
            'this tab is not the leader — another tab owns the syncular ' +
              'core for this origin (enable multiTab for follower proxying)',
          ),
        );
      }
      return this.#follower.call(method, args) as Promise<
        Awaited<ReturnType<WorkerApi[M]>>
      >;
    }
    if (this.#core === undefined) {
      return Promise.reject(
        new ClientSyncError(WORKER_FAILED_CODE, 'the handle is closed'),
      );
    }
    return this.#core.invoke(method, args) as Promise<
      Awaited<ReturnType<WorkerApi[M]>>
    >;
  }

  subscribe(input: SubscribeInput): Promise<void> {
    return this.#call('subscribe', [input]);
  }

  unsubscribe(id: string): Promise<void> {
    return this.#call('unsubscribe', [id]);
  }

  setWindow(base: WindowBase, units: readonly string[]): Promise<void> {
    return this.#call('setWindow', [base, units]);
  }

  windowState(base: WindowBase): Promise<WindowState> {
    return this.#call('windowState', [base]);
  }

  mutate(mutations: readonly MutationInput[]): Promise<string> {
    return this.#call('mutate', [mutations]);
  }

  sync(): Promise<SyncSummary> {
    return this.#call('sync', []);
  }

  syncUntilIdle(maxRounds?: number): Promise<SyncSummary> {
    return this.#call('syncUntilIdle', [maxRounds]);
  }

  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> {
    return this.#call('query', [sql, params]);
  }

  conflicts(): Promise<readonly ConflictRecord[]> {
    return this.#call('conflicts', []);
  }

  rejections(): Promise<readonly RejectionRecord[]> {
    return this.#call('rejections', []);
  }

  schemaFloor(): Promise<SchemaFloor | undefined> {
    return this.#call('schemaFloor', []);
  }

  leaseState(): Promise<LeaseState | undefined> {
    return this.#call('leaseState', []);
  }

  /** §7.4.5: true while a schema-bump reset + first re-bootstrap runs. */
  upgrading(): Promise<boolean> {
    return this.#call('upgrading', []);
  }

  syncNeeded(): Promise<boolean> {
    return this.#call('syncNeeded', []);
  }

  pendingCommits(): Promise<OutboxCommit[]> {
    return this.#call('pendingCommits', []);
  }

  subscriptions(): Promise<SubscriptionRecord[]> {
    return this.#call('subscriptions', []);
  }

  subscription(id: string): Promise<SubscriptionRecord | undefined> {
    return this.#call('subscription', [id]);
  }

  connectRealtime(): Promise<void> {
    return this.#call('connectRealtime', []);
  }

  disconnectRealtime(): Promise<void> {
    return this.#call('disconnectRealtime', []);
  }

  /** §8.6: publish/clear a scope-keyed presence document. */
  setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void> {
    return this.#call('setPresence', [scopeKey, doc]);
  }

  /** §8.6: the peers currently present on a scope key. */
  presence(scopeKey: string): Promise<readonly PresencePeer[]> {
    return this.#call('presence', [scopeKey]);
  }

  uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<BlobRef> {
    return this.#call('uploadBlob', [bytes, options]);
  }

  fetchBlob(blobIdOrRef: string): Promise<CachedBlob> {
    return this.#call('fetchBlob', [blobIdOrRef]);
  }

  /** Sever/restore transport + realtime inside the worker (demos). */
  setOffline(offline: boolean): Promise<void> {
    return this.#call('setOffline', [offline]);
  }

  /** Close the core (leader) or unbind the link (follower), release leadership. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#follower !== undefined) {
      this.#follower.close();
      this.#follower = undefined;
    }
    if (this.#core !== undefined) {
      const core = this.#core;
      this.#core = undefined;
      await core.close(true);
    }
  }
}

/**
 * Spawn the worker, run the init handshake, and return a running leader core.
 * `dispatchEvent` receives every worker event; `bridge` (when supplied) is
 * the follower relay whose lifetime is tied to this core.
 */
async function startWorkerCore(options: {
  config: SyncClientHandleConfig;
  initConfig: WorkerInitConfig;
  lease: LeaderLease;
  dispatchEvent: (event: SyncWorkerEvent) => void;
  makeBridge?: (
    clientId: string,
    invoke: (method: string, args: readonly unknown[]) => Promise<unknown>,
  ) => LeaderBridge;
}): Promise<LeaderCore> {
  const { config, initConfig, lease } = options;
  const worker = config.worker();
  const pending = new Map<number, Pending>();
  const nextId = { value: 1 };

  const invoke = (
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> => {
    const id = nextId.value++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        t: 'call',
        id,
        method,
        args,
      } as MainToWorkerMessage);
    });
  };

  let bridge: LeaderBridge | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as WorkerToMainMessage;
      switch (message.t) {
        case 'ready':
          resolve();
          break;
        case 'result': {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          entry?.resolve(message.value);
          break;
        }
        case 'error': {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          entry?.reject(
            new ClientSyncError(
              message.error.code,
              message.error.message,
              message.error.retryable,
            ),
          );
          break;
        }
        case 'event':
          options.dispatchEvent(message.event);
          bridge?.broadcastEvent(message.event);
          break;
      }
    };
    const onError = (event: ErrorEvent) => {
      const error = new ClientSyncError(
        WORKER_FAILED_CODE,
        `the sync worker failed: ${event.message ?? 'unknown error'}`,
      );
      reject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError as EventListener);
  });

  try {
    await ready;
    const initResult = await new Promise<WorkerInitResult>(
      (resolve, reject) => {
        const id = nextId.value++;
        pending.set(id, {
          resolve: (value) => resolve(value as WorkerInitResult),
          reject,
        });
        worker.postMessage({
          t: 'init',
          id,
          config: initConfig,
        } as MainToWorkerMessage);
      },
    );
    if (options.makeBridge !== undefined) {
      bridge = options.makeBridge(initResult.clientId, invoke);
    }
    return {
      clientId: initResult.clientId,
      invoke,
      bridge,
      lease,
      close: async (terminate) => {
        bridge?.close();
        try {
          await invoke('close', []);
        } catch {
          // Closing a wedged worker still terminates it below.
        }
        if (terminate) worker.terminate();
        const closedError = new ClientSyncError(
          WORKER_FAILED_CODE,
          'the handle was closed',
        );
        for (const entry of pending.values()) entry.reject(closedError);
        pending.clear();
        await lease.release();
      },
    };
  } catch (error) {
    worker.terminate();
    await lease.release();
    throw error;
  }
}

function buildInitConfig(config: SyncClientHandleConfig): WorkerInitConfig {
  return {
    schema: config.schema,
    database: config.database,
    endpoints: config.endpoints,
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.limits !== undefined ? { limits: config.limits } : {}),
    ...(config.autoSync !== undefined ? { autoSync: config.autoSync } : {}),
    ...(config.wakeJitterMs !== undefined
      ? { wakeJitterMs: config.wakeJitterMs }
      : {}),
  };
}

/** Route a worker event to the config-level callbacks (leader visibility). */
function fireConfigCallbacks(
  config: SyncClientHandleConfig,
  event: SyncWorkerEvent,
): void {
  if (event.kind === 'sync-needed') {
    config.onSyncNeeded?.(event.reason);
  } else if (event.kind === 'conflict') {
    config.onConflict?.(event.conflict);
  } else if (event.kind === 'upgrading') {
    config.onUpgrading?.(event.upgrading);
  } else if (event.kind === 'presence') {
    config.onPresence?.(event.scopeKey);
  } else if (event.kind === 'synced') {
    config.onSynced?.({
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
  }
}

/**
 * Acquire leadership, spawn the worker, initialize the core inside it.
 *
 * With `multiTab` off: a losing tab resolves to a dead not-leader handle.
 * With `multiTab` on: a losing tab becomes a FOLLOWER proxying to the leader,
 * and promotes itself if the leader later closes.
 */
export async function createSyncClientHandle(
  config: SyncClientHandleConfig,
): Promise<SyncClientHandle> {
  const lock = config.leaderLock ?? defaultLeaderLock();
  const lockName = config.lockName ?? 'syncular-leader';
  const invalidation = new InvalidationEmitter();
  const presence = new Set<(scopeKey: string) => void>();
  const roleListeners = new Set<(role: HandleRole) => void>();
  if (config.onRoleChange !== undefined) roleListeners.add(config.onRoleChange);

  // Leadership BEFORE the worker exists: one core per origin, and a losing
  // tab never boots a database it must not own.
  const lease =
    lock.tryAcquire !== undefined
      ? await lock.tryAcquire(lockName)
      : await lock.acquire(lockName);

  // ---- Won the election: leader. ----
  if (lease !== undefined) {
    // Epoch derivation for a fresh boot: epoch 0. A promoter (below) reads
    // the highest epoch it has seen and adds one, so leaders monotonically
    // increase it across handovers.
    return await bootLeader(config, lockName, lease, {
      epoch: 0,
      invalidation,
      presence,
      roleListeners,
    });
  }

  // ---- Lost the election. ----
  if (config.multiTab !== true) {
    // Legacy single-tab contract: a dead not-leader handle.
    return new SyncClientHandle({
      role: 'follower',
      clientId: '',
      invalidation,
      presence,
      roleListeners,
    });
  }

  // ---- Follower: proxy to the leader; contest + promote on its close. ----
  return await bootFollower(config, lockName, lock, {
    invalidation,
    presence,
    roleListeners,
  });
}

interface HandleParts {
  epoch?: number;
  invalidation: InvalidationEmitter;
  presence: Set<(scopeKey: string) => void>;
  roleListeners: Set<(role: HandleRole) => void>;
}

/** Boot (or promote to) a leader: spawn the worker, wire the bridge. */
async function bootLeader(
  config: SyncClientHandleConfig,
  lockName: string,
  lease: LeaderLease,
  parts: HandleParts,
): Promise<SyncClientHandle> {
  const handleRef: { handle: SyncClientHandle | undefined } = {
    handle: undefined,
  };
  const dispatchEvent = (event: SyncWorkerEvent): void => {
    fireConfigCallbacks(config, event);
    handleRef.handle?.__dispatchEvent(event);
  };
  const makeBridge =
    config.multiTab === true
      ? (
          clientId: string,
          invoke: (
            method: string,
            args: readonly unknown[],
          ) => Promise<unknown>,
        ): LeaderBridge => {
          const factory = config.channelFactory ?? broadcastChannelFactory();
          const channel = factory(multiTabChannelName(lockName));
          return new LeaderBridge({
            channel,
            epoch: parts.epoch ?? 0,
            clientId,
            invoke,
          });
        }
      : undefined;

  const core = await startWorkerCore({
    config,
    initConfig: buildInitConfig(config),
    lease,
    dispatchEvent,
    ...(makeBridge !== undefined ? { makeBridge } : {}),
  });

  const handle = new SyncClientHandle({
    role: 'leader',
    clientId: core.clientId,
    core,
    invalidation: parts.invalidation,
    presence: parts.presence,
    roleListeners: parts.roleListeners,
  });
  handleRef.handle = handle;
  return handle;
}

/**
 * Boot a follower: open the channel, bind to the leader, and race the lock in
 * the background so this tab promotes itself the instant the leader closes.
 */
async function bootFollower(
  config: SyncClientHandleConfig,
  lockName: string,
  lock: LeaderLock,
  parts: HandleParts,
): Promise<SyncClientHandle> {
  const factory = config.channelFactory ?? broadcastChannelFactory();
  const channel = factory(multiTabChannelName(lockName));
  const handleRef: { handle: SyncClientHandle | undefined } = {
    handle: undefined,
  };

  const follower = new FollowerLink({
    channel,
    fromId: newTabId(),
    onEvent: (event) => handleRef.handle?.__dispatchEvent(event),
    onLeaderChange: (clientId) => {
      // Learn the leader's shared client id (best-effort; the handle exposes
      // it after binding). Nothing else to do — calls already flush.
      void clientId;
    },
    ...(config.followerCallTimeoutMs !== undefined
      ? { callTimeoutMs: config.followerCallTimeoutMs }
      : {}),
  });

  // A follower waits (blocking) on the exclusive lock: it resolves ONLY when
  // the current leader releases it (tab close). Winning it triggers promotion.
  // We do NOT hold this promise — it settles asynchronously.
  void lock.acquire(lockName).then(async (lease) => {
    const handle = handleRef.handle;
    if (handle === undefined) {
      // Handle was never assembled (shouldn't happen); drop the lease.
      await lease.release();
      return;
    }
    // The follower saw the departing leader's epoch; the new leader must
    // strictly exceed it so stale replies/events are discarded everywhere.
    const nextEpoch = follower.maxEpochSeen + 1;
    // Unbind the link so any late leader traffic is ignored, then promote.
    follower.unbind();
    try {
      const core = await startWorkerCore({
        config,
        initConfig: buildInitConfig(config),
        lease,
        dispatchEvent: (event) => {
          fireConfigCallbacks(config, event);
          handle.__dispatchEvent(event);
        },
        ...(config.multiTab === true
          ? {
              makeBridge: (
                clientId: string,
                invoke: (
                  method: string,
                  args: readonly unknown[],
                ) => Promise<unknown>,
              ): LeaderBridge => {
                const promoteChannel = factory(multiTabChannelName(lockName));
                return new LeaderBridge({
                  channel: promoteChannel,
                  epoch: nextEpoch,
                  clientId,
                  invoke,
                });
              },
            }
          : {}),
      });
      handle.__becomeLeader(core);
    } catch {
      // Promotion failed to spawn a worker — release so the next tab tries.
      await lease.release();
    }
  });

  const handle = new SyncClientHandle({
    role: 'follower',
    // The follower learns the leader's shared client id once bound; expose it
    // lazily via `clientId` is not possible on a getter over the link, so we
    // leave '' until promotion (the shared id is the leader's — hooks that
    // need it read it after a round). Followers rarely need clientId directly.
    clientId: '',
    follower,
    invalidation: parts.invalidation,
    presence: parts.presence,
    roleListeners: parts.roleListeners,
  });
  handleRef.handle = handle;
  // Do not hand back a follower until its link has bound to the leader (the
  // hello→announce round trip completed). Before binding, epoch is -1 and any
  // event the leader fans out is dropped, so a caller that subscribes and then
  // relies on push invalidation would silently miss events emitted in the
  // binding window — a real multi-tab race, not just a test flake. Binding is
  // fast (the leader answers every hello with an announce); on the off chance
  // it times out we still return the handle (queued calls flush and events
  // resume on the next announce) rather than failing handle construction.
  try {
    await follower.waitUntilBound();
  } catch {
    /* bind timed out — return the (degraded but functional) handle anyway */
  }
  return handle;
}
