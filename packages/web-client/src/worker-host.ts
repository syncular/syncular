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
 * Multi-tab is the DEFAULT (RFC 0002 §2.4 — the follower path is
 * conformance-covered): a tab that LOSES the election becomes a FOLLOWER
 * (`role === 'follower'`) that proxies every call to the leader tab over a
 * BroadcastChannel (see `multi-tab.ts`). When the leader tab closes, its
 * lock releases; the followers contest, the winner PROMOTES in place —
 * spawns the worker over the persisted OPFS database and re-announces — and
 * the handle's `role` flips to `'leader'` with `onRoleChange` firing. The
 * same handle object is kept across the transition so React bindings hold a
 * stable reference.
 *
 * With `multiTab: false`, the loser is an `isLeader === false` handle whose
 * calls reject with `client.not_leader` (the single-tab contract).
 */
import type { WakeReason } from '@syncular/core';
import type { BlobRef, CachedBlob } from './blob';
import type {
  ConflictRecord,
  LeaseState,
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  RejectionRecord,
  SchemaFloor,
  SubscribeInput,
  SyncClientLimits,
  SyncSummary,
  WindowState,
} from './client';
import type { SqlRow, SqlValue } from './database';
import { registerDevtools } from './devtools';
import type { EncryptionKeyringConfig } from './encryption';
import { ClientSyncError } from './errors';
import {
  ChangeEmitter,
  type ClientChangeListener,
  InvalidationEmitter,
  type InvalidationListener,
  invalidationFromChange,
  type LocalRevision,
  type SyncStatusSnapshot,
} from './invalidation';
import {
  type LeaderLease,
  type LeaderLock,
  singleOwnerLock,
  webLocksLeaderLock,
} from './leader-lock';
import type { LocalDataPurgeInput, LocalDataPurgeResult } from './local-purge';
import {
  broadcastChannelFactory,
  type CrossTabChannel,
  FollowerLink,
  LeaderBridge,
  type LeadershipState,
  multiTabChannelName,
  newTabId,
} from './multi-tab';
import type { OutboxCommit } from './outbox';
import type {
  CommitOutcome,
  CommitOutcomeQuery,
  ResolveCommitOutcomeInput,
} from './outcomes';
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

export type BrowserReplicaMode =
  | { readonly mode: 'shared' }
  | { readonly mode: 'isolated'; readonly id: string };

export interface IsolatedReplicaNames {
  readonly databaseName: string;
  readonly databaseDirectory: string;
  readonly lockName: string;
  readonly channelName: string;
}

/** Derive the complete ownership tuple for an independently owned replica. */
export function isolatedReplicaNames(options: {
  readonly databaseName: string;
  readonly databaseDirectory?: string;
  readonly lockName?: string;
  readonly replicaId: string;
}): IsolatedReplicaNames {
  if (!/^[A-Za-z0-9._-]+$/.test(options.replicaId)) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'an isolated replica id must contain only letters, numbers, dot, underscore, or dash',
    );
  }
  const suffix = `--replica-${options.replicaId}`;
  const databaseName = `${options.databaseName}${suffix}`;
  const lockName = `${options.lockName ?? 'syncular-leader'}${suffix}`;
  return {
    databaseName,
    databaseDirectory: `${options.databaseDirectory ?? `.syncular/${options.databaseName}`}${suffix}`,
    lockName,
    channelName: multiTabChannelName(lockName),
  };
}

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
  /** Structured-clone-safe E2EE keyring installed only in the leader worker. */
  readonly encryption?: EncryptionKeyringConfig;
  readonly clientId?: string;
  readonly limits?: SyncClientLimits;
  /** Worker-side host loop (§8.4); default true. */
  readonly autoSync?: boolean;
  /** Default: Web Locks when available, else single-owner. */
  readonly leaderLock?: LeaderLock;
  readonly lockName?: string;
  /** Shared by default; isolated derives the database/lock/channel tuple. */
  readonly replica?: BrowserReplicaMode;
  /**
   * Multi-tab followers (TODO 3.2). On by default: a tab that loses the
   * leader election becomes a FOLLOWER that proxies to the leader over a
   * BroadcastChannel, and contests + promotes when the leader closes. Set
   * false for the single-tab contract — the loser is a dead
   * `isLeader === false` handle rejecting with `client.not_leader`.
   */
  readonly multiTab?: boolean;
  /** Cross-tab channel factory (default `BroadcastChannel`); injectable for tests. */
  readonly channelFactory?: (name: string) => CrossTabChannel;
  /** Deadline for a follower call (covers the leader-handover gap). */
  readonly followerCallTimeoutMs?: number;
  /** Fires when this handle's role changes (follower → leader on promotion). */
  readonly onRoleChange?: (role: HandleRole) => void;
  /** Fires when reachability or ownership changes without replacing the handle. */
  readonly onLeadershipChange?: (state: LeadershipState) => void;
  readonly onSyncNeeded?: (reason: 'startup' | 'hello' | WakeReason) => void;
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
  get currentSchemaVersion(): number {
    return this.#currentSchemaVersion;
  }
  get leadership(): LeadershipState {
    return this.#leadership;
  }

  leadershipSnapshot(): LeadershipState {
    return this.#leadership;
  }

  #role: HandleRole;
  #clientId: string;
  readonly #currentSchemaVersion: number;
  #leadership: LeadershipState;
  #core: LeaderCore | undefined;
  #follower: FollowerLink | undefined;
  readonly #invalidation: InvalidationEmitter;
  readonly #changes: ChangeEmitter;
  readonly #presence: Set<(scopeKey: string) => void>;
  readonly #roleListeners: Set<(role: HandleRole) => void>;
  readonly #leadershipListeners: Set<(state: LeadershipState) => void>;
  readonly #devtoolsUnregister: () => void;
  #closed = false;

  /** @internal — use {@link createSyncClientHandle}. */
  constructor(internals: {
    role: HandleRole;
    clientId: string;
    currentSchemaVersion: number;
    core?: LeaderCore;
    follower?: FollowerLink;
    invalidation: InvalidationEmitter;
    changes: ChangeEmitter;
    presence: Set<(scopeKey: string) => void>;
    roleListeners?: Set<(role: HandleRole) => void>;
    leadershipListeners?: Set<(state: LeadershipState) => void>;
    leadership?: LeadershipState;
  }) {
    this.#role = internals.role;
    this.#clientId = internals.clientId;
    this.#currentSchemaVersion = internals.currentSchemaVersion;
    this.#leadership =
      internals.leadership ??
      (internals.role === 'leader'
        ? { state: 'leader', clientId: internals.clientId }
        : (internals.follower?.leadershipState ?? {
            state: 'blocked',
            reason: 'leader-unreachable',
            code: 'client.follower_timeout',
            retryable: true,
          }));
    this.#core = internals.core;
    this.#follower = internals.follower;
    this.#invalidation = internals.invalidation;
    this.#changes = internals.changes;
    this.#presence = internals.presence;
    this.#roleListeners = internals.roleListeners ?? new Set();
    this.#leadershipListeners = internals.leadershipListeners ?? new Set();
    // RFC 0002 §3.2: console introspection — a no-op outside a dev page.
    this.#devtoolsUnregister = registerDevtools({
      kind: 'handle',
      ref: this,
      clientId: () => this.#clientId,
      role: () => this.#role,
      outbox: async () => (await this.pendingCommits()).length,
      subscriptions: () => this.subscriptions(),
      conflicts: async () => (await this.conflicts()).length,
      rejections: async () => (await this.rejections()).length,
      syncNeeded: () => this.syncNeeded(),
      upgrading: () => this.upgrading(),
      onInvalidate: (listener) => this.onInvalidate(listener),
    });
  }

  /** @internal — swap this handle from follower to leader (promotion). */
  __becomeLeader(core: LeaderCore): void {
    this.#follower?.close();
    this.#follower = undefined;
    this.#core = core;
    this.#clientId = core.clientId;
    this.#role = 'leader';
    this.__setLeadership({ state: 'leader', clientId: core.clientId });
    for (const listener of this.#roleListeners) {
      try {
        listener('leader');
      } catch {
        /* a UI listener must never break promotion */
      }
    }
  }

  /** @internal — apply a follower reachability snapshot in place. */
  __setLeadership(state: LeadershipState): void {
    this.#leadership = state;
    if (state.state === 'follower') this.#clientId = state.leaderClientId;
    for (const listener of this.#leadershipListeners) {
      try {
        listener(state);
      } catch {
        /* a UI listener must never break leadership transitions */
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
    } else if (event.kind === 'change') {
      this.#changes.emit(event.batch);
      const legacy = invalidationFromChange(event.batch);
      if (legacy !== undefined) this.#invalidation.emit(legacy);
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

  onChange(listener: ClientChangeListener): () => void {
    return this.#changes.on(listener);
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

  onLeadershipChange(listener: (state: LeadershipState) => void): () => void {
    this.#leadershipListeners.add(listener);
    return () => {
      this.#leadershipListeners.delete(listener);
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
              'core for this origin (this handle opted out of follower ' +
              'proxying with multiTab: false)',
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

  /** Partial-update convenience: read-merge-write one full-row upsert. */
  patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): Promise<string> {
    return this.#call('patch', [table, rowId, partial, options]);
  }

  purgeLocalData(input: LocalDataPurgeInput): Promise<LocalDataPurgeResult> {
    return this.#call('purgeLocalData', [input]);
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

  querySnapshot<Row = SqlRow>(
    spec: QueryReadSpec,
  ): Promise<QuerySnapshot<Row>> {
    return this.#call('querySnapshot', [spec]) as Promise<QuerySnapshot<Row>>;
  }

  localRevision(): Promise<LocalRevision> {
    return this.#call('localRevision', []);
  }

  statusSnapshot(): Promise<SyncStatusSnapshot> {
    return this.#call('statusSnapshot', []);
  }

  conflicts(): Promise<readonly ConflictRecord[]> {
    return this.#call('conflicts', []);
  }

  rejections(): Promise<readonly RejectionRecord[]> {
    return this.#call('rejections', []);
  }

  commitOutcome(clientCommitId: string): Promise<CommitOutcome | undefined> {
    return this.#call('commitOutcome', [clientCommitId]);
  }

  commitOutcomes(
    query: CommitOutcomeQuery = {},
  ): Promise<readonly CommitOutcome[]> {
    return this.#call('commitOutcomes', [query]);
  }

  resolveCommitOutcome(
    input: ResolveCommitOutcomeInput,
  ): Promise<CommitOutcome> {
    return this.#call('resolveCommitOutcome', [input]);
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
    this.#devtoolsUnregister();
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
    ...(config.encryption !== undefined
      ? { encryption: config.encryption }
      : {}),
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.limits !== undefined ? { limits: config.limits } : {}),
    ...(config.autoSync !== undefined ? { autoSync: config.autoSync } : {}),
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
 * With `multiTab` on (the default): a losing tab becomes a FOLLOWER proxying
 * to the leader, and promotes itself if the leader later closes. With
 * `multiTab: false`: a losing tab resolves to a dead not-leader handle.
 */
export async function createSyncClientHandle(
  config: SyncClientHandleConfig,
): Promise<SyncClientHandle> {
  const resolvedConfig = resolveReplicaConfig(config);
  const lock = resolvedConfig.leaderLock ?? defaultLeaderLock();
  const lockName = resolvedConfig.lockName ?? 'syncular-leader';
  const invalidation = new InvalidationEmitter();
  const changes = new ChangeEmitter();
  const presence = new Set<(scopeKey: string) => void>();
  const roleListeners = new Set<(role: HandleRole) => void>();
  if (resolvedConfig.onRoleChange !== undefined)
    roleListeners.add(resolvedConfig.onRoleChange);
  const leadershipListeners = new Set<(state: LeadershipState) => void>();
  if (resolvedConfig.onLeadershipChange !== undefined) {
    leadershipListeners.add(resolvedConfig.onLeadershipChange);
  }

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
    return await bootLeader(resolvedConfig, lockName, lease, {
      epoch: 0,
      invalidation,
      changes,
      presence,
      roleListeners,
      leadershipListeners,
    });
  }

  // ---- Lost the election. ----
  if (resolvedConfig.multiTab === false) {
    // Opted-out single-tab contract: a dead not-leader handle.
    return new SyncClientHandle({
      role: 'follower',
      clientId: '',
      currentSchemaVersion: resolvedConfig.schema.version,
      invalidation,
      changes,
      presence,
      roleListeners,
      leadershipListeners,
    });
  }

  // ---- Follower: proxy to the leader; contest + promote on its close. ----
  return await bootFollower(resolvedConfig, lockName, lock, {
    invalidation,
    changes,
    presence,
    roleListeners,
    leadershipListeners,
  });
}

interface HandleParts {
  epoch?: number;
  invalidation: InvalidationEmitter;
  changes: ChangeEmitter;
  presence: Set<(scopeKey: string) => void>;
  roleListeners: Set<(role: HandleRole) => void>;
  leadershipListeners: Set<(state: LeadershipState) => void>;
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
    config.multiTab !== false
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
            heartbeatMs: Math.max(
              10,
              Math.floor((config.followerCallTimeoutMs ?? 10_000) / 3),
            ),
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
    currentSchemaVersion: config.schema.version,
    core,
    invalidation: parts.invalidation,
    changes: parts.changes,
    presence: parts.presence,
    roleListeners: parts.roleListeners,
    leadershipListeners: parts.leadershipListeners,
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
    onStateChange: (state) => handleRef.handle?.__setLeadership(state),
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
        ...(config.multiTab !== false
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
                  heartbeatMs: Math.max(
                    10,
                    Math.floor((config.followerCallTimeoutMs ?? 10_000) / 3),
                  ),
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
    currentSchemaVersion: config.schema.version,
    follower,
    invalidation: parts.invalidation,
    changes: parts.changes,
    presence: parts.presence,
    roleListeners: parts.roleListeners,
    leadershipListeners: parts.leadershipListeners,
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

function resolveReplicaConfig(
  config: SyncClientHandleConfig,
): SyncClientHandleConfig {
  if (config.replica?.mode !== 'isolated') return config;
  if (config.database.mode !== 'persistent') {
    throw new ClientSyncError(
      'sync.invalid_request',
      'isolated browser replicas require a named persistent database',
    );
  }
  const names = isolatedReplicaNames({
    databaseName: config.database.name,
    ...(config.database.directory !== undefined
      ? { databaseDirectory: config.database.directory }
      : {}),
    ...(config.lockName !== undefined ? { lockName: config.lockName } : {}),
    replicaId: config.replica.id,
  });
  return {
    ...config,
    lockName: names.lockName,
    database: {
      ...config.database,
      name: names.databaseName,
      directory: names.databaseDirectory,
    },
  };
}
