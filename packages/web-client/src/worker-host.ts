import {
  ProgressEmitter,
  type SyncProgress,
  type SyncProgressListener,
} from './progress';
import type { PromiseMethods } from './client';
/**
 * Main-thread side of the worker mode and the
 * multi-tab topology.
 *
 * `createSyncClientHandle` acquires the Web Locks leader lock and, when it
 * wins, spawns the worker running the WHOLE core — so exactly one core runs
 * per origin (the lock IS the invariant: a worker is NEVER spawned without
 * holding the lock). The returned {@link SyncClientHandle} is a thin, fully
 * async proxy over the `worker-protocol` RPC.
 *
 * Multi-tab is the DEFAULT. The follower path is
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
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  RejectionRecord,
  SecurityLifecycle,
  SnapshotRead,
  SnapshotReadRequest,
  SubscribeInput,
  SyncClientConfig,
  SyncClientLimits,
  SyncSummary,
  SyncIdleOptions,
  SyncIdleResult,
  WindowState,
} from './client';
import type { SqlRow, SqlValue } from './database';
import { registerDevtools } from './devtools';
import {
  ClientDiagnosticsEmitter,
  type ClientDiagnosticsListener,
  type ClientDiagnosticsRequest,
  type ClientDiagnosticsSnapshot,
  type RealtimePolicy,
  withClientDiagnosticsHost,
} from './diagnostics';
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
  decodeLocalDataRebootstrapResult,
  type LocalDataRebootstrapInput,
  type LocalDataRebootstrapResult,
} from './local-rebootstrap';
import {
  type CrossTabChannel,
  createTabCoordinator,
  type LeadershipState,
  multiTabChannelName,
  type TabCoordinator,
} from './multi-tab';
import type { OutboxCommit } from './outbox';
import type {
  CommitOutcome,
  CommitOutcomeQuery,
  ResolveCommitOutcomeInput,
} from './outcomes';
import {
  decodePreviousVersionAuditResult,
  decodePreviousVersionDiscardResult,
  decodePreviousVersionSnapshot,
  type PreviousVersionAudit,
  type PreviousVersionReadSpec,
  type PreviousVersionSnapshot,
} from './previous-version';
import type { ClientSchema } from './schema';
import type { SubscriptionRecord } from './state';
import type { WindowBase } from './window';
import {
  type LocalAuthorityState,
  type MainToWorkerMessage,
  NOT_LEADER_CODE,
  type SyncWorkerEvent,
  WORKER_FAILED_CODE,
  WORKER_RESTART_REQUIRED_CODE,
  type WorkerApi,
  type WorkerDatabaseInit,
  type WorkerEndpoints,
  type WorkerErrorShape,
  type WorkerInitConfig,
  type WorkerInitResult,
  type WorkerMethod,
  type WorkerSecurityActivation,
  type WorkerToMainMessage,
} from './worker-protocol';

const WORKER_BUNDLE_LOAD_FAILURE =
  /(?:failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script)/iu;

/** Classify startup without echoing a chunk URL or bundler text to UI/logs. */
export function workerStartupError(message: unknown): ClientSyncError {
  if (typeof message === 'string' && WORKER_BUNDLE_LOAD_FAILURE.test(message)) {
    return new ClientSyncError(
      WORKER_RESTART_REQUIRED_CODE,
      'the sync worker bundle changed; fully reload this application',
    );
  }
  return new ClientSyncError(WORKER_FAILED_CODE, 'the sync worker failed');
}

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
  /**
   * Host auth headers for sync, segment, and blob requests (e.g.
   * `Authorization`). Rotate with `setHeaders`. Realtime authenticates
   * through `realtimeUrl`, because WebSockets cannot carry headers.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Structured-clone-safe E2EE keyring installed only in the leader worker. */
  readonly encryption?: EncryptionKeyringConfig;
  /** Fixed plain authority reads permitted before security activation. */
  readonly authorityReads?: import('./authority').AuthorityReadPolicy;
  /** Open the worker-owned replica behind the fail-closed security gate. */
  readonly securityPreflight?: boolean;
  readonly transportEnabled?: boolean;
  /** SPEC §12: start against the worker's local authority (`WorkerInitConfig`). */
  readonly localAuthority?: boolean;
  readonly clientId?: string;
  readonly limits?: SyncClientLimits;
  readonly retainFailedCommits?: boolean;
  /**
   * SPEC §8.8 realtime policy for the worker-owned core, forwarded into
   * `WorkerInitConfig`. Absent ⇒ `optional`.
   */
  readonly realtimePolicy?: RealtimePolicy;
  /**
   * RFC 0005 previous-version context, forwarded into the worker's
   * `SyncClientConfig`. Absent ⇒ the feature stays off (default-off).
   */
  readonly previousVersionContext?: SyncClientConfig['previousVersionContext'];
  /** Worker-side host loop (§8.4); default true. */
  readonly autoSync?: boolean;
  /** Default: Web Locks when available, else single-owner. */
  readonly leaderLock?: LeaderLock;
  readonly lockName?: string;
  /** Shared by default; isolated derives the database/lock/channel tuple. */
  readonly replica?: BrowserReplicaMode;
  /**
   * Multi-tab followers. On by default: a tab that loses the
   * leader election becomes a FOLLOWER that proxies to the leader over a
   * BroadcastChannel, and contests + promotes when the leader closes. Set
   * false for the single-tab contract — the loser is a dead
   * `isLeader === false` handle rejecting with `client.not_leader`.
   */
  readonly multiTab?: boolean;
  /** Cross-tab channel factory (default `BroadcastChannel`); injectable for tests. */
  readonly channelFactory?: (name: string) => CrossTabChannel;
  /**
   * Deadline for a follower call (covers the leader-handover gap), and the
   * bound on leader silence: a follower probes after a third of it and goes
   * `blocked` when the probe stays unanswered for the rest. Default 10 s.
   */
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
  /** Atomic privacy-safe diagnostics changed. */
  readonly onDiagnostics?: (snapshot: ClientDiagnosticsSnapshot) => void;
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
 * A running worker core owned by THIS tab (the leader). Wraps the worker and
 * the RPC pending map. Torn down on `close()` or on a graceful demotion.
 */
interface LeaderCore {
  readonly clientId: string;
  readonly invoke: (
    method: string,
    args: readonly unknown[],
  ) => Promise<unknown>;
  /** Close the core, terminate the worker, and release the lease. */
  close(): Promise<void>;
}

/**
 * The main-thread proxy: the same logical API as `SyncClient`, every method a
 * promise. `role` is `'leader'` (owns the worker) or `'follower'` (proxies to
 * the leader over the channel). Constructed via {@link createSyncClientHandle}.
 */
export class SyncClientHandle implements PromiseMethods<WorkerApi> {
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
  /** The multi-tab route: this tab's core when it leads, the leader's otherwise. */
  readonly #tabs: TabCoordinator | undefined;
  /** The `multiTab: false` leader's own core. */
  #core: LeaderCore | undefined;
  readonly #invalidation: InvalidationEmitter;
  readonly #progress = new ProgressEmitter();
  readonly #changes: ChangeEmitter;
  readonly #presence: Set<(scopeKey: string) => void>;
  readonly #diagnostics: ClientDiagnosticsEmitter;
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
    tabs?: TabCoordinator;
    invalidation: InvalidationEmitter;
    changes: ChangeEmitter;
    presence: Set<(scopeKey: string) => void>;
    diagnostics: ClientDiagnosticsEmitter;
    roleListeners?: Set<(role: HandleRole) => void>;
    leadershipListeners?: Set<(state: LeadershipState) => void>;
    leadership?: LeadershipState;
  }) {
    this.#role = internals.role;
    this.#clientId = internals.clientId;
    this.#currentSchemaVersion = internals.currentSchemaVersion;
    this.#leadership =
      internals.leadership ??
      internals.tabs?.state ??
      (internals.role === 'leader'
        ? { state: 'leader', clientId: internals.clientId }
        : {
            state: 'blocked',
            reason: 'leader-unreachable',
            code: 'client.follower_timeout',
            retryable: true,
          });
    this.#core = internals.core;
    this.#tabs = internals.tabs;
    this.#invalidation = internals.invalidation;
    this.#changes = internals.changes;
    this.#presence = internals.presence;
    this.#diagnostics = internals.diagnostics;
    this.#roleListeners = internals.roleListeners ?? new Set();
    this.#leadershipListeners = internals.leadershipListeners ?? new Set();
    // Console introspection is a no-op outside a dev page.
    this.#devtoolsUnregister = registerDevtools({
      kind: 'handle',
      ref: this,
      clientId: () => this.#clientId,
      role: () => this.#role,
      outbox: async () => (await this.statusSnapshot()).outbox,
      subscriptions: () => this.subscriptions(),
      conflicts: async () => (await this.conflicts()).length,
      rejections: async () => (await this.rejections()).length,
      syncNeeded: async () => (await this.statusSnapshot()).syncNeeded,
      upgrading: async () => (await this.statusSnapshot()).upgrading,
      onInvalidate: (listener) => this.onInvalidate(listener),
    });
  }

  /**
   * @internal — apply a leadership snapshot in place: a promotion flips the
   * role to `'leader'`, stepping down for a newer tab flips it back.
   */
  __setLeadership(state: LeadershipState): void {
    this.#leadership = state;
    if (state.state === 'leader') this.#clientId = state.clientId;
    if (state.state === 'follower') this.#clientId = state.leaderClientId;
    for (const listener of this.#leadershipListeners) {
      try {
        listener(state);
      } catch {
        /* a UI listener must never break leadership transitions */
      }
    }
    const role = state.state === 'leader' ? 'leader' : 'follower';
    if (role === this.#role) return;
    this.#role = role;
    for (const listener of this.#roleListeners) {
      try {
        listener(role);
      } catch {
        /* a UI listener must never break a promotion or a handover */
      }
    }
  }

  /** @internal — dispatch a worker/relayed event to handle-local listeners. */
  __dispatchEvent(event: SyncWorkerEvent): void {
    if (event.kind === 'progress') {
      this.#progress.emit(event.progress);
    } else if (event.kind === 'presence') {
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
    } else if (event.kind === 'diagnostics') {
      this.#diagnostics.emit(
        withClientDiagnosticsHost(event.snapshot, {
          ...event.snapshot.host,
          kind: 'worker',
          role: this.#role,
        }),
      );
    }
  }

  /**
   * Subscribe to fine-grained invalidation. The identical
   * surface as `SyncClient.onInvalidate`, so React bindings target one
   * interface across direct, worker-leader, and follower modes. Returns an
   * unsubscribe function.
   */
  onInvalidate(listener: InvalidationListener): () => void {
    return this.#invalidation.on(listener);
  }

  onProgress(listener: SyncProgressListener): () => void {
    return this.#progress.on(listener);
  }
  progressSnapshot(): SyncProgress | undefined {
    return this.#progress.snapshot();
  }

  onChange(listener: ClientChangeListener): () => void {
    return this.#changes.on(listener);
  }

  onDiagnostics(listener: ClientDiagnosticsListener): () => void {
    return this.#diagnostics.on(listener);
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
    if (this.#tabs !== undefined) {
      return this.#tabs.call(method, args) as Promise<
        Awaited<ReturnType<WorkerApi[M]>>
      >;
    }
    if (this.#core === undefined) {
      return Promise.reject(
        new ClientSyncError(
          NOT_LEADER_CODE,
          'this tab is not the leader — another tab owns the syncular ' +
            'core for this origin (this handle opted out of follower ' +
            'proxying with multiTab: false)',
        ),
      );
    }
    return this.#core.invoke(method, args) as Promise<
      Awaited<ReturnType<WorkerApi[M]>>
    >;
  }

  subscribe(input: SubscribeInput): Promise<void> {
    return this.#call('subscribe', [input]);
  }

  subscribeMany(inputs: readonly SubscribeInput[]): Promise<void> {
    return this.#call('subscribeMany', [inputs]);
  }

  securityLifecycle(): Promise<SecurityLifecycle> {
    return this.#call('securityLifecycle', []);
  }

  beginSecurityPreflight(): Promise<void> {
    return this.#call('beginSecurityPreflight', []);
  }

  activateSecurity(options: WorkerSecurityActivation = {}): Promise<void> {
    return this.#call('activateSecurity', [options]);
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

  async rebootstrapLocalData(
    input: LocalDataRebootstrapInput,
  ): Promise<LocalDataRebootstrapResult> {
    return decodeLocalDataRebootstrapResult(
      await this.#call('rebootstrapLocalData', [input]),
    );
  }

  async previousVersionSnapshot(
    spec: PreviousVersionReadSpec,
  ): Promise<PreviousVersionSnapshot> {
    return decodePreviousVersionSnapshot(
      await this.#call('previousVersionSnapshot', [spec]),
    );
  }

  async previousVersionAudit(): Promise<PreviousVersionAudit | undefined> {
    return decodePreviousVersionAuditResult(
      await this.#call('previousVersionAudit', []),
    );
  }

  async previousVersionDiscard(): Promise<{
    present: boolean;
    discarded: boolean;
  }> {
    return decodePreviousVersionDiscardResult(
      await this.#call('previousVersionDiscard', []),
    );
  }

  sync(): Promise<SyncSummary> {
    return this.#call('sync', []);
  }

  syncUntilIdle(options?: number | SyncIdleOptions): Promise<SyncIdleResult> {
    return this.#call('syncUntilIdle', [options]);
  }

  /**
   * Rotate the client id (§1.5) after a `sync.invalid_client_id` refusal.
   * The worker's next round carries the new id; the replica and outbox stay
   * in place.
   */
  async resetClientId(): Promise<string> {
    const clientId = await this.#call('resetClientId', []);
    this.#clientId = clientId;
    return clientId;
  }

  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> {
    return this.#call('query', [sql, params]);
  }

  authoritySnapshot(): Promise<import('./authority').AuthoritySnapshot> {
    if (arguments.length)
      throw new ClientSyncError(
        'client.authority_read_forbidden',
        'authoritySnapshot accepts no arguments',
      );
    return this.#call('authoritySnapshot', []);
  }

  querySnapshot<Row = SqlRow>(
    spec: QueryReadSpec,
  ): Promise<QuerySnapshot<Row>> {
    return this.#call('querySnapshot', [spec]) as Promise<QuerySnapshot<Row>>;
  }

  snapshotRead<Row = SqlRow>(
    spec: SnapshotReadRequest,
  ): Promise<SnapshotRead<Row>> {
    return this.#call('snapshotRead', [spec]) as Promise<SnapshotRead<Row>>;
  }

  localRevision(): Promise<LocalRevision> {
    return this.#call('localRevision', []);
  }

  statusSnapshot(): Promise<SyncStatusSnapshot> {
    return this.#call('statusSnapshot', []);
  }

  async diagnosticsSnapshot(
    request: ClientDiagnosticsRequest = {},
  ): Promise<ClientDiagnosticsSnapshot> {
    const snapshot = await this.#call('diagnosticsSnapshot', [request]);
    return withClientDiagnosticsHost(snapshot, {
      ...snapshot.host,
      kind: 'worker',
      role: this.#role,
    });
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

  /** §7.4.5: true while a schema-bump reset + first re-bootstrap runs. */
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

  /**
   * Replace the full host auth header set. The next HTTP request uses it;
   * a live realtime socket keeps its handshake credentials. A follower
   * forwards to the leader and keeps the set for its own promotion.
   */
  setHeaders(headers: Readonly<Record<string, string>>): Promise<void> {
    this.__headers = headers;
    return this.#call('setHeaders', [headers]);
  }

  /** @internal — the latest `setHeaders` set, carried into a promotion. */
  __headers: Readonly<Record<string, string>> | undefined;

  /** Sever/restore transport + realtime inside the worker (demos). */
  setOffline(offline: boolean): Promise<void> {
    return this.#call('setOffline', [offline]);
  }

  /** SPEC §12.3 local-authority state; `undefined` without `localAuthority`. */
  localAuthorityState(): Promise<LocalAuthorityState | undefined> {
    return this.#call('localAuthorityState', []);
  }

  /**
   * SPEC §12.3: upload the local authority's rows to `endpoints.syncUrl`,
   * then sync with that server. Rejects with `sync.attach_rejected` when the
   * server refuses an upload commit.
   */
  attachLocalAuthority(): Promise<void> {
    return this.#call('attachLocalAuthority', []);
  }

  /** SPEC §12.3: delete the rows a stopped attach uploaded, then sync locally. */
  abandonLocalAuthorityAttach(): Promise<void> {
    return this.#call('abandonLocalAuthorityAttach', []);
  }

  /** Close the core (leader) or the link (follower), release leadership. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#progress.clear();
    this.#devtoolsUnregister();
    await this.#tabs?.close();
    if (this.#core !== undefined) {
      const core = this.#core;
      this.#core = undefined;
      await core.close();
    }
  }
}

/**
 * Spawn the worker, run the init handshake, and return a running leader core.
 * `dispatchEvent` receives every worker event.
 */
async function startWorkerCore(options: {
  config: SyncClientHandleConfig;
  initConfig: WorkerInitConfig;
  lease: LeaderLease;
  dispatchEvent: (event: SyncWorkerEvent) => void;
}): Promise<LeaderCore> {
  const { config, initConfig, lease } = options;
  const worker = config.worker();
  const pending = new Map<number, Pending>();
  const nextId = { value: 1 };
  let terminated = false;
  let rejectReady: ((error: Error) => void) | undefined;
  const closedError = new ClientSyncError(
    WORKER_FAILED_CODE,
    'the handle was closed',
  );
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    globalThis.removeEventListener?.('pagehide', terminate);
    worker.terminate();
    rejectReady?.(closedError);
    for (const entry of pending.values()) entry.reject(closedError);
    pending.clear();
    void lease.release();
  };
  // Installed before bootstrap starts: pagehide must also terminate a worker
  // whose first open/import is still pending. Termination closes its SAHs and
  // releases its physical Web Lock; the next document waits for that lock.
  globalThis.addEventListener?.('pagehide', terminate);

  const invoke = (
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> => {
    if (terminated) return Promise.reject(closedError);
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

  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
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
              message.error.details,
            ),
          );
          break;
        }
        case 'event':
          options.dispatchEvent(message.event);
          break;
      }
    };
    const onError = (event: ErrorEvent) => {
      const error = workerStartupError(event.message);
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
    return {
      clientId: initResult.clientId,
      invoke,
      close: async () => {
        if (terminated) return;
        try {
          await invoke('close', []);
        } catch {
          // A terminated or failed worker has no further close RPC to service.
        }
        terminate();
      },
    };
  } catch (error) {
    terminate();
    throw error;
  }
}

function buildInitConfig(
  config: SyncClientHandleConfig,
  headers = config.headers,
): WorkerInitConfig {
  return {
    schema: config.schema,
    database: config.database,
    endpoints: config.endpoints,
    ...(headers !== undefined ? { headers } : {}),
    ...(config.encryption !== undefined
      ? { encryption: config.encryption }
      : {}),
    ...(config.transportEnabled !== undefined
      ? { transportEnabled: config.transportEnabled }
      : {}),
    ...(config.localAuthority !== undefined
      ? { localAuthority: config.localAuthority }
      : {}),
    ...(config.authorityReads !== undefined
      ? { authorityReads: config.authorityReads.declarations }
      : {}),
    ...(config.securityPreflight !== undefined
      ? { securityPreflight: config.securityPreflight }
      : {}),
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.limits !== undefined ? { limits: config.limits } : {}),
    ...(config.retainFailedCommits !== undefined
      ? { retainFailedCommits: config.retainFailedCommits }
      : {}),
    ...(config.realtimePolicy !== undefined
      ? { realtimePolicy: config.realtimePolicy }
      : {}),
    ...(config.previousVersionContext !== undefined
      ? { previousVersionContext: config.previousVersionContext }
      : {}),
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
  } else if (event.kind === 'diagnostics') {
    config.onDiagnostics?.(event.snapshot);
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
  const diagnostics = new ClientDiagnosticsEmitter();
  const roleListeners = new Set<(role: HandleRole) => void>();
  if (resolvedConfig.onRoleChange !== undefined)
    roleListeners.add(resolvedConfig.onRoleChange);
  const leadershipListeners = new Set<(state: LeadershipState) => void>();
  if (resolvedConfig.onLeadershipChange !== undefined) {
    leadershipListeners.add(resolvedConfig.onLeadershipChange);
  }

  const handleRef: { handle: SyncClientHandle | undefined } = {
    handle: undefined,
  };
  const parts = {
    currentSchemaVersion: resolvedConfig.schema.version,
    invalidation,
    changes,
    presence,
    diagnostics,
    roleListeners,
    leadershipListeners,
  };

  if (resolvedConfig.multiTab === false) {
    // Single-tab contract: the leader runs its core with no channel; a losing
    // tab is a dead not-leader handle that never boots a database.
    const lease =
      lock.tryAcquire !== undefined
        ? await lock.tryAcquire(lockName)
        : await lock.acquire(lockName);
    if (lease === undefined) {
      return new SyncClientHandle({ role: 'follower', clientId: '', ...parts });
    }
    const core = await startWorkerCore({
      config: resolvedConfig,
      initConfig: buildInitConfig(resolvedConfig),
      lease,
      dispatchEvent: (event) => {
        fireConfigCallbacks(resolvedConfig, event);
        handleRef.handle?.__dispatchEvent(event);
      },
    });
    const handle = new SyncClientHandle({
      role: 'leader',
      clientId: core.clientId,
      core,
      ...parts,
    });
    handleRef.handle = handle;
    return handle;
  }

  // One core per origin: the tab that wins the lock runs the worker, every
  // other tab forwards to it and promotes when it closes.
  const tabs = await createTabCoordinator<SyncWorkerEvent>({
    name: lockName,
    version: resolvedConfig.schema.version,
    lock,
    ...(resolvedConfig.channelFactory !== undefined
      ? { channelFactory: resolvedConfig.channelFactory }
      : {}),
    ...(resolvedConfig.followerCallTimeoutMs !== undefined
      ? { callTimeoutMs: resolvedConfig.followerCallTimeoutMs }
      : {}),
    lead: async (context) => {
      const core = await startWorkerCore({
        config: resolvedConfig,
        // A promoted tab carries the latest `setHeaders` set.
        initConfig: buildInitConfig(
          resolvedConfig,
          handleRef.handle?.__headers ?? resolvedConfig.headers,
        ),
        lease: context.lease,
        dispatchEvent: (event) => {
          fireConfigCallbacks(resolvedConfig, event);
          context.broadcast(event);
        },
      });
      return {
        clientId: core.clientId,
        call: (_tabId, method, args) => core.invoke(method, args),
        close: () => core.close(),
      };
    },
    onEvent: (event) => handleRef.handle?.__dispatchEvent(event),
    onStateChange: (state) => handleRef.handle?.__setLeadership(state),
  });
  const leadership = tabs.state;
  const handle = new SyncClientHandle({
    role: leadership.state === 'leader' ? 'leader' : 'follower',
    clientId:
      leadership.state === 'leader'
        ? leadership.clientId
        : leadership.state === 'follower'
          ? leadership.leaderClientId
          : '',
    tabs,
    ...parts,
  });
  handleRef.handle = handle;
  // Init configuration belongs to the one leader worker. A newly opened
  // follower that explicitly requests security preflight must therefore put
  // the shared origin replica behind the same barrier before it is returned;
  // otherwise an already-running leader would silently ignore the request.
  if (
    leadership.state !== 'leader' &&
    resolvedConfig.securityPreflight === true
  ) {
    try {
      await handle.beginSecurityPreflight();
    } catch (error) {
      // The caller never receives this handle, so it must not stay queued for
      // the lock and promote into a database nobody holds.
      await handle.close();
      throw error;
    }
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
