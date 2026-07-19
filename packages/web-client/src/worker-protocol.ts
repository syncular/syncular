/**
 * The worker RPC protocol (Direction decision 2, 2026-07-03): the whole
 * client core runs in a Web Worker; the UI thread talks to it through
 * this thin, multiplexed postMessage protocol. Exactly SIX message types
 * (`init`, `call`, `ready`, `result`, `error`, `event`) — every logical
 * API method multiplexes over `call`, every notification over `event`.
 *
 * Both sides derive their typing from ONE shared shape: `WorkerApi`.
 * The worker implements it (`worker-entry.ts`); the handle projects it
 * to promises (`worker-host.ts`). Everything crossing the boundary is
 * structured-clone data — no functions, no class instances.
 *
 * Scheduling note (SPEC §8.4): the sync-needed signal is host-driven,
 * and in worker mode the HOST LOOP LIVES IN THE WORKER — wake-ups
 * coalesce into intent-driven `syncUntilIdle` rounds there (`autoSync`),
 * so the UI thread never has to react to keep data flowing. Events are
 * still forwarded to the handle for visibility.
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
  SecurityLifecycle,
  SubscribeInput,
  SyncClientLimits,
  SyncSummary,
  WindowState,
} from './client';
import type { SqlRow, SqlValue } from './database';
import type {
  ClientDiagnosticsRequest,
  ClientDiagnosticsSnapshot,
} from './diagnostics';
import type { EncryptionKeyringConfig } from './encryption';
import type {
  ClientChangeBatch,
  LocalRevision,
  SyncStatusSnapshot,
} from './invalidation';
import type { LocalDataPurgeInput, LocalDataPurgeResult } from './local-purge';
import type {
  LocalDataRebootstrapInput,
  LocalDataRebootstrapResult,
} from './local-rebootstrap';
import type { OutboxCommit } from './outbox';
import type {
  CommitOutcome,
  CommitOutcomeQuery,
  ResolveCommitOutcomeInput,
} from './outcomes';
import type { ClientSchema } from './schema';
import type { SubscriptionRecord } from './state';
import type { WindowBase } from './window';

// ---------------------------------------------------------------------------
// Client-local error codes (never wire codes; §10 stays server-owned)
// ---------------------------------------------------------------------------

/** The handle exists but this tab lost the leader election (TODO 3.2). */
export const NOT_LEADER_CODE = 'client.not_leader';
/** The worker (or its RPC channel) failed outside protocol semantics. */
export const WORKER_FAILED_CODE = 'client.worker_failed';

// ---------------------------------------------------------------------------
// Init configuration (structured-clone safe)
// ---------------------------------------------------------------------------

export type WorkerDatabaseInit =
  | {
      /** THE persistent mode: opfs-sahpool, named database. */
      readonly mode: 'persistent';
      readonly name: string;
      /** Optional pool directory override (default `.syncular/<name>`). */
      readonly directory?: string;
    }
  | {
      /**
       * Bootstrap-provided database (tests inject bun:sqlite here). The
       * worker entry MUST have an `openDatabase` override or init fails.
       */
      readonly mode: 'custom';
      readonly options?: unknown;
    };

export interface WorkerEndpoints {
  /** POST target for SSP2 sync rounds (§1.1). */
  readonly syncUrl: string;
  /** Segment download base URL; omit when segments are not served. */
  readonly segmentsUrl?: string;
  /** Blob upload/download base URL (§5.9); omit when blobs are unused. */
  readonly blobsUrl?: string;
  /**
   * WebSocket URL for §8 realtime. The literal placeholder `{clientId}`
   * is substituted with the (possibly persisted) client id after start.
   */
  readonly realtimeUrl?: string;
}

export interface WorkerInitConfig {
  readonly schema: ClientSchema;
  readonly database: WorkerDatabaseInit;
  readonly endpoints: WorkerEndpoints;
  /** Portable raw keyring installed inside the worker-owned client core. */
  readonly encryption?: EncryptionKeyringConfig;
  /** Open the worker-owned replica behind the fail-closed security gate. */
  readonly securityPreflight?: boolean;
  readonly clientId?: string;
  readonly limits?: SyncClientLimits;
  /**
   * Worker-side host loop (§8.4): coalesce interactive work immediately and
   * honor explicit background retry deadlines
   * `syncUntilIdle` rounds inside the worker. Default true.
   */
  readonly autoSync?: boolean;
}

/** Successful init reply. */
export interface WorkerInitResult {
  readonly clientId: string;
}

/** Structured-clone-safe key material installed at security activation. */
export interface WorkerSecurityActivation {
  readonly encryption?: EncryptionKeyringConfig;
}

// ---------------------------------------------------------------------------
// The logical API — the one shared shape (worker implements, handle projects)
// ---------------------------------------------------------------------------

export interface WorkerApi {
  securityLifecycle(): SecurityLifecycle;
  beginSecurityPreflight(): Promise<void>;
  activateSecurity(options?: WorkerSecurityActivation): Promise<void>;
  subscribe(input: SubscribeInput): void;
  unsubscribe(id: string): void;
  /** §4.8 windowed subscriptions: set the live units for a window base. */
  setWindow(base: WindowBase, units: readonly string[]): Promise<void>;
  /** §4.8 completeness oracle (I3): the windowed-in units for a base. */
  windowState(base: WindowBase): WindowState;
  mutate(mutations: readonly MutationInput[]): string;
  /** Partial-update convenience: read-merge-write one full-row upsert. */
  patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): string;
  /** Application-authorized, idempotent local security purge. */
  purgeLocalData(input: LocalDataPurgeInput): LocalDataPurgeResult;
  /** Application-authorized, outbox-preserving projection recovery. */
  rebootstrapLocalData(
    input: LocalDataRebootstrapInput,
  ): LocalDataRebootstrapResult;
  sync(): Promise<SyncSummary>;
  syncUntilIdle(maxRounds?: number): Promise<SyncSummary>;
  query(sql: string, params?: readonly SqlValue[]): SqlRow[];
  querySnapshot(spec: QueryReadSpec): QuerySnapshot;
  localRevision(): LocalRevision;
  statusSnapshot(): SyncStatusSnapshot;
  diagnosticsSnapshot(
    request?: ClientDiagnosticsRequest,
  ): ClientDiagnosticsSnapshot;
  conflicts(): readonly ConflictRecord[];
  rejections(): readonly RejectionRecord[];
  commitOutcome(clientCommitId: string): CommitOutcome | undefined;
  commitOutcomes(query?: CommitOutcomeQuery): readonly CommitOutcome[];
  resolveCommitOutcome(input: ResolveCommitOutcomeInput): CommitOutcome;
  schemaFloor(): SchemaFloor | undefined;
  /** §7.3.5: the opaque auth-lease state, or undefined. */
  leaseState(): LeaseState | undefined;
  /** §7.4.5: true while a schema-bump reset + first re-bootstrap runs. */
  upgrading(): boolean;
  syncNeeded(): boolean;
  pendingCommits(): OutboxCommit[];
  subscriptions(): SubscriptionRecord[];
  subscription(id: string): SubscriptionRecord | undefined;
  connectRealtime(): Promise<void>;
  disconnectRealtime(): void;
  /** §8.6 presence: publish/clear a scope-keyed presence document. */
  setPresence(scopeKey: string, doc: Record<string, unknown> | null): void;
  /** §8.6 presence: the peers currently present on a scope key. */
  presence(scopeKey: string): readonly PresencePeer[];
  /** §5.9 blobs: stage bytes (returns the canonical ref) / resolve bytes. */
  uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<BlobRef>;
  fetchBlob(blobIdOrRef: string): Promise<CachedBlob>;
  /** Sever/restore the transport + realtime (offline simulation, demos). */
  setOffline(offline: boolean): void;
  close(): Promise<void>;
}

export type WorkerMethod = keyof WorkerApi;

// ---------------------------------------------------------------------------
// Messages (6 types total)
// ---------------------------------------------------------------------------

/** `call` for method M, with args typed straight off `WorkerApi`. */
export type WorkerCallMessage = {
  [M in WorkerMethod]: {
    readonly t: 'call';
    readonly id: number;
    readonly method: M;
    readonly args: Parameters<WorkerApi[M]>;
  };
}[WorkerMethod];

export type MainToWorkerMessage =
  | {
      readonly t: 'init';
      readonly id: number;
      readonly config: WorkerInitConfig;
    }
  | WorkerCallMessage;

export interface WorkerErrorShape {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type SyncWorkerEvent =
  | {
      readonly kind: 'sync-needed';
      readonly reason: 'startup' | 'hello' | WakeReason;
    }
  | { readonly kind: 'conflict'; readonly conflict: ConflictRecord }
  | {
      /** An autoSync round finished (or failed) inside the worker. */
      readonly kind: 'synced';
      readonly summary?: SyncSummary;
      readonly error?: WorkerErrorShape;
    }
  | {
      /** §7.4.5: the schema-bump `upgrading` state changed in the worker. */
      readonly kind: 'upgrading';
      readonly upgrading: boolean;
    }
  | {
      /** §8.6: presence on a scope key changed inside the worker. */
      readonly kind: 'presence';
      readonly scopeKey: string;
    }
  | {
      /** Exact revisioned core transaction; Sets and bigint clone directly. */
      readonly kind: 'change';
      readonly batch: ClientChangeBatch;
    }
  | {
      /** Atomic privacy-safe health/support evidence from the worker core. */
      readonly kind: 'diagnostics';
      readonly snapshot: ClientDiagnosticsSnapshot;
    };

export type WorkerToMainMessage =
  | { readonly t: 'ready' }
  | { readonly t: 'result'; readonly id: number; readonly value: unknown }
  | {
      readonly t: 'error';
      readonly id: number;
      readonly error: WorkerErrorShape;
    }
  | { readonly t: 'event'; readonly event: SyncWorkerEvent };
