/**
 * SyncClient — the B3 client protocol core (SPEC.md §§3–8 client side).
 *
 * A plain library running on whatever thread it is constructed on
 * (worker-OPTIONAL, REVISE B3): storage behind `ClientDatabase`, network
 * behind `SyncTransport`/`SegmentDownloader`/`RealtimeConnector`, multi-tab
 * ownership behind `LeaderLock`. One combined push+pull request per
 * `sync()` round (§7.2); local reads go straight to the database.
 */
import {
  type CommitFrame,
  canonicalScopeJson,
  decodeMessage,
  decodeRow,
  decodeRowsSegment,
  encodeMessage,
  encodePresencePublish,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  type PresenceKind,
  type PushResultFrame,
  parseRealtimeServerEvent,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type RejectionDetails,
  type RequestFrame,
  type ResponseMessage,
  type RowColumn,
  type RowValue,
  type ScopeMap,
  type SegmentRefFrame,
  type SubStartFrame,
  type WakeReason,
} from '@syncular/core';
import {
  applyCommitFrame,
  applyRowsSegment,
  applySqliteSegment,
  deleteLocalRow,
  deleteScopedRows,
  evictScopedRows,
  upsertLocalRow,
} from './apply';
import {
  type BlobRef,
  type BlobTransport,
  type CachedBlob,
  clearPendingUpload,
  computeBlobId,
  enforceBlobCacheCap,
  ensureBlobSchema,
  getCachedBlob,
  listPendingUploads,
  parseBlobRef,
  putCachedBlob,
  reconcileBlobRefcounts,
  recordPendingUpload,
  schemaHasBlobs,
  serializeBlobRef,
} from './blob';
import type { ClientDatabase, SqlRow, SqlValue } from './database';
import { registerDevtools } from './devtools';
import {
  CLIENT_DIAGNOSTICS_VERSION,
  ClientDiagnosticsEmitter,
  type ClientDiagnosticsListener,
  type ClientDiagnosticsRequest,
  type ClientDiagnosticsSnapshot,
  type ClientDiagnosticsStorage,
  type DiagnosticLastChange,
  type DiagnosticLastRound,
  type DiagnosticRoundCounters,
  type DiagnosticSubscription,
  MAX_DIAGNOSTIC_DOMAINS,
  MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
} from './diagnostics';
import type { EncryptionConfig } from './encryption';
import { ClientSyncError } from './errors';
import {
  ChangeAccumulator,
  ChangeEmitter,
  type ClientChangeListener,
  type CommandEffects,
  type CommandResult,
  InvalidationEmitter,
  type InvalidationListener,
  invalidationFromChange,
  type LocalRevision,
  type SyncIntent,
  type SyncStatusSnapshot,
} from './invalidation';
import {
  type LeaderLease,
  type LeaderLock,
  singleOwnerLock,
} from './leader-lock';
import {
  type CompiledLocalDataPurge,
  type CompiledLocalDataPurgeTarget,
  compileLocalDataPurge,
  type LocalDataPurgeInput,
  type LocalDataPurgeResult,
  localDataPurgeMetaKey,
  localDataPurgeTargetMatches,
} from './local-purge';
import {
  compileLocalDataRebootstrap,
  type LocalDataRebootstrapInput,
  type LocalDataRebootstrapResult,
  localDataRebootstrapMetaKey,
} from './local-rebootstrap';
import {
  appendOutboxCommit,
  deleteOutboxCommit,
  dropOutboxCommitsInScope,
  encodeOutboxCommit,
  listOutbox,
  listOutboxBeforeImages,
  type OutboxBeforeImage,
  type OutboxCommit,
  OutboxEncodeError,
  type OutboxOperation,
  replaceOutboxBeforeImages,
} from './outbox';
import {
  activeFailureRecords,
  type CommitOperationOutcome,
  type CommitOutcome,
  type CommitOutcomeQuery,
  type ConflictRecord,
  listCommitOutcomes,
  persistCommitOutcomeResolution,
  pruneCommitOutcomes,
  type RejectionRecord,
  type ResolveCommitOutcomeInput,
  commitOutcome as readCommitOutcome,
  recordCommitOutcome,
} from './outcomes';
import { assertReadOnlyQuery } from './query-guard';
import {
  type ClientSchema,
  type CompiledClientSchema,
  type CompiledClientTable,
  compileClientSchema,
  dropAndRecreateSyncedTables,
  ensureLocalBookkeepingSchema,
  ensureLocalSyncedSchema,
  fromSqlValue,
  jsonToRowValue,
  LOCAL_SCHEMA_VERSION_KEY,
  normalizeRecordKeys,
  OPTIMISTIC_VERSION,
  quoteIdent,
  recordToRowValues,
  rowValueToJson,
  SYNC_VERSION_COLUMN,
  stripSyncColumns,
} from './schema';
import {
  bumpLocalRevision,
  deleteSubscription,
  getLocalRevision,
  getMeta,
  getSubscription,
  loadSubscriptions,
  pruneUnknownSubscriptions,
  resetSubscriptionsForBump,
  type SubscriptionRecord,
  saveSubscription,
  setMeta,
} from './state';
import type {
  RealtimeConnector,
  RealtimeSocket,
  SegmentDownloader,
  SyncTransport,
} from './transport';
import {
  deletePendingEviction,
  deleteWindowUnit,
  deriveSubId,
  getWindowUnitBySubId,
  insertWindowUnit,
  loadPendingEvictions,
  loadWindowUnits,
  savePendingEviction,
  unitScopes,
  type WindowBase,
  windowBaseKey,
} from './window';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type MutationInput =
  | {
      readonly table: string;
      readonly op: 'upsert';
      /** Full-row values keyed by column name (§6.1: full row payloads). */
      readonly values: Readonly<Record<string, unknown>>;
      readonly baseVersion?: number;
    }
  | {
      readonly table: string;
      readonly op: 'delete';
      readonly rowId: string;
      readonly baseVersion?: number;
    };

export type {
  CommitOperationOutcome,
  CommitOutcome,
  CommitOutcomeQuery,
  ConflictRecord,
  RejectionRecord,
  ResolveCommitOutcomeInput,
} from './outcomes';

export interface SchemaFloor {
  readonly requiredSchemaVersion?: number;
  readonly latestSchemaVersion?: number;
}

/**
 * §7.3.5: the client's view of its current auth lease — opaque state, the
 * mirror of `schemaFloor`. `leaseId`/`expiresAtMs` come from the last
 * `LEASE` frame; `errorCode` is set (and syncing stops on the lease) when
 * the server rejects a round with a request-level lease code (§7.3.4).
 * The lease is never cryptographically verified by the client (§7.3
 * non-goal 1), and lease errors never purge local data (§7.3.4).
 */
export interface LeaseState {
  readonly leaseId?: string;
  readonly expiresAtMs?: number;
  /** `sync.auth_lease_required` | `sync.auth_lease_revoked` when stopped. */
  readonly errorCode?: string;
}

export interface SyncSummary {
  /** Commits sent in this round's push half. */
  readonly pushed: number;
  /** clientCommitIds drained (`applied` or `cached`, §6.3). */
  readonly applied: readonly string[];
  /** clientCommitIds rejected and dropped from the outbox. */
  readonly rejected: readonly string[];
  /** clientCommitIds kept for retry (`sync.idempotency_cache_miss`). */
  readonly retryable: readonly string[];
  /** New conflict records surfaced this round. */
  readonly conflicts: readonly ConflictRecord[];
  /** `COMMIT` frames applied locally. */
  readonly commitsApplied: number;
  /** Snapshot rows applied from segments. */
  readonly segmentRowsApplied: number;
  /** Subscriptions still mid-bootstrap (resume token pending). */
  readonly bootstrapping: readonly string[];
  /** Subscriptions reset via `sync.cursor_expired` (re-pull needed). */
  readonly resets: readonly string[];
  /** Subscriptions revoked this round (§3.3 purge ran). */
  readonly revoked: readonly string[];
  /** Subscriptions stopped by a fatal configuration error (§3.3/§5.6
   * fail-closed: no local scope-column mapping). */
  readonly failed: readonly string[];
  /** Present when the server declared a schema floor — syncing stopped. */
  readonly schemaFloor?: SchemaFloor;
  /** §6.1 splitBatch: outbox commits held back from THIS request because
   * including them would exceed the per-request operation cap. They remain
   * queued; sync-needed stays raised and `syncUntilIdle` keeps going. */
  readonly deferredCommits?: number;
}

export interface SyncClientLimits {
  readonly limitCommits?: number;
  readonly limitSnapshotRows?: number;
  readonly maxSnapshotPages?: number;
  /**
   * §4.2 accept bitmask; defaults to inline + external rows (0b0011)
   * plus sqlite images (bit 2) when the database backend implements
   * `withSqliteImage` and a segment downloader is configured (§5.3).
   */
  readonly accept?: number;
  /**
   * Maximum retained durable commit outcomes. Old applied/cached or resolved
   * entries are pruned first; unresolved conflicts/rejections are never
   * deleted to satisfy this cap. Defaults to 1,000.
   */
  readonly outcomeRetentionMaxEntries?: number;
}

export interface SyncClientConfig {
  readonly database: ClientDatabase;
  readonly schema: ClientSchema;
  readonly transport: SyncTransport;
  readonly segments?: SegmentDownloader;
  /** Blob upload/download (§5.9). Required to use `uploadBlob`/`fetchBlob`. */
  readonly blobs?: BlobTransport;
  /**
   * §5.9.7 B1 blob-cache size cap (bytes). When the sum of cached body sizes
   * exceeds this, zero-ref, non-pinned bodies are evicted LRU-first after each
   * cache write (referenced/pinned bodies are never evicted — correctness
   * beats the cap). Absent ⇒ retain until storage pressure (the shipped
   * default; a referenced body always stays resolvable without a re-download).
   */
  readonly blobCacheMaxBytes?: number;
  readonly realtime?: RealtimeConnector;
  /** Stable per-device id (§1.5); defaults to a persisted random UUID. */
  readonly clientId?: string;
  readonly leaderLock?: LeaderLock;
  readonly lockName?: string;
  readonly limits?: SyncClientLimits;
  readonly now?: () => number;
  /** §8: hello `requiresSync` or a wake-up — run a pull soon. */
  readonly onSyncNeeded?: (reason: 'startup' | 'hello' | WakeReason) => void;
  /** Exact core-owned scheduling intent. Hosts consume this to run an
   * event-driven retry deadline without polling or inferring sync state. */
  readonly onSyncIntent?: (intent: SyncIntent) => void;
  readonly onConflict?: (conflict: ConflictRecord) => void;
  /**
   * §7.4.5: the schema-bump `upgrading` state changed. `true` when a reset
   * (wipe + re-bootstrap) began, `false` when the first post-reset
   * bootstrap round reached idle — the app's cue to re-run live queries.
   */
  readonly onUpgrading?: (upgrading: boolean) => void;
  /**
   * §8.6 presence: a scope-mate's presence on a key this client holds
   * changed (join/update/leave). Fired after the local presence map is
   * updated — the app's cue to re-render who's-online.
   */
  readonly onPresence?: (scopeKey: string) => void;
  /**
   * §5.11 client-side encryption. Supplies the key material (`keyProvider`)
   * and key selection (`keyIdFor`) for columns the generated schema marks
   * `encrypted`. Absent ⇒ no columns are encrypted (a schema with encrypted
   * columns then fails loud on the first encode/apply — a missing key is
   * `client.decrypt_failed`, never silent plaintext).
   */
  readonly encryption?: EncryptionConfig;
  /**
   * Open the local replica in the fail-closed security preflight state.
   *
   * Preflight opens/migrates the database but suppresses every protected read,
   * mutation, subscription, transport, realtime, presence, and blob operation.
   * Only lifecycle/status inspection and `purgeLocalData` remain available.
   * Install the post-authentication keyring and release the gate with
   * `activateSecurity`. This is mutually exclusive with `encryption`: secure
   * hosts must not materialize key bytes before their preflight has passed.
   */
  readonly securityPreflight?: boolean;
}

/** The fail-closed local-replica security lifecycle shared by every host. */
export type SecurityLifecycle = 'preflight' | 'active';

/** Stable client-local error while protected operations are preflight-gated. */
export const SECURITY_PREFLIGHT_REQUIRED_CODE =
  'client.security_preflight_required';

/** Key material installed atomically when a direct client becomes active. */
export interface SecurityActivation {
  readonly encryption?: EncryptionConfig;
}

/** §8.6 a peer's ephemeral presence document on a scope key. */
export interface PresencePeer {
  readonly actorId: string;
  readonly clientId: string;
  readonly doc: Record<string, unknown>;
}

export interface SubscribeInput {
  readonly id: string;
  readonly table: string;
  readonly scopes: ScopeMap;
  readonly params?: string;
}

/**
 * The live state of a window base (§4.8) — the completeness oracle (I3),
 * as plain serializable data so it crosses the worker/follower boundary
 * unchanged. `units` are the scope values currently windowed-in; a query
 * touching only these is answerable in full locally. Use
 * {@link windowComplete} for the per-value verdict a live query renders
 * "this data may be partial" from.
 */
export interface WindowState {
  /** Windowed-in units for this base, ordered by value. */
  readonly units: readonly string[];
  /**
   * Registered units whose bootstrap has not yet completed (§4.8): the
   * unit's subscription still has `cursor: -1` (never synced) or holds a
   * resume token (mid-bootstrap). Between `setWindow` and the bootstrap
   * landing, the local replica for a pending unit may be empty or partial —
   * it MUST NOT be rendered as complete.
   */
  readonly pending: readonly string[];
}

/** One generated/raw query's required window units (SPEC §7.5). */
export interface WindowCoverage {
  readonly base: WindowBase;
  readonly units: readonly string[];
}

export interface WindowUnitRef {
  readonly baseKey: string;
  readonly unit: string;
}

export interface CoverageSnapshot {
  readonly complete: boolean;
  readonly pending: readonly WindowUnitRef[];
  readonly missing: readonly WindowUnitRef[];
}

export interface QueryReadSpec {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
  readonly coverage?: readonly WindowCoverage[];
}

export interface QuerySnapshot<Row = SqlRow> {
  readonly revision: LocalRevision;
  readonly rows: readonly Row[];
  readonly coverage: CoverageSnapshot;
}

/**
 * True iff `unit` is windowed-in AND its bootstrap completed (§4.8 I3):
 * registered and not pending. A unit with zero server rows still becomes
 * complete once its bootstrap round finishes — emptiness ≠ pendency.
 */
export function windowComplete(state: WindowState, unit: string): boolean {
  return state.units.includes(unit) && !state.pending.includes(unit);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** §4.2 accept bits the client cares about. */
const ACCEPT_ROWS_BASELINE = 0b0011;
const ACCEPT_SQLITE = 1 << 2;
const ACCEPT_SIGNED_URLS = 1 << 3;

/**
 * §7.4.4 client-local code: a pending outbox commit cannot re-encode under
 * the new generated schema after a bump (a referenced column is gone).
 * Never a wire code (§10.3) — surfaced through the rejection channel.
 */
const OUTBOX_INCOMPATIBLE_CODE = 'sync.outbox_incompatible';

/** §6.1 per-request operation cap (matches the server's shipped default —
 * `sync.too_many_operations` above it). The push half sends whole commits in
 * commit order up to this cap and defers the rest to the next round. */
const MAX_OPS_PER_REQUEST = 500;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface OpenSection {
  readonly start: SubStartFrame;
  readonly sub: SubscriptionRecord | undefined;
  /** Fresh bootstrap (§5.6): request had cursor < 0 and no resume token. */
  readonly fresh: boolean;
  /** Skip application entirely (unknown sub, delta during bootstrap, …). */
  skip: boolean;
  cleared: boolean;
}

/** §8.7 client side: one in-flight socket round's response assembly. */
interface PendingRound {
  readonly scanner: MessageStreamScanner;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: ClientSyncError) => void;
}

interface MutableSummary {
  pushed: number;
  applied: string[];
  rejected: string[];
  retryable: string[];
  conflicts: ConflictRecord[];
  commitsApplied: number;
  segmentRowsApplied: number;
  resets: string[];
  revoked: string[];
  failed: string[];
}

function emptySummary(pushed: number): MutableSummary {
  return {
    pushed,
    applied: [],
    rejected: [],
    retryable: [],
    conflicts: [],
    commitsApplied: 0,
    segmentRowsApplied: 0,
    resets: [],
    revoked: [],
    failed: [],
  };
}

function isFinalPushResult(frame: PushResultFrame): boolean {
  return (
    frame.status !== 'rejected' ||
    !frame.results.some(
      (result) =>
        result.status === 'error' &&
        result.code === 'sync.idempotency_cache_miss' &&
        result.retryable,
    )
  );
}

export class SyncClient {
  readonly #config: SyncClientConfig;
  readonly #db: ClientDatabase;
  readonly #schema: CompiledClientSchema;
  /** §5.11 client-side encryption config; undefined ⇒ E2EE off. */
  #encryption: EncryptionConfig | undefined;
  #securityLifecycle: SecurityLifecycle;
  readonly #now: () => number;
  readonly #outcomeRetentionMaxEntries: number;
  #started = false;
  #lease: LeaderLease | undefined;
  #clientId = '';
  #devtoolsUnregister: (() => void) | undefined;
  #schemaFloor: SchemaFloor | undefined;
  #leaseState: LeaseState | undefined;
  /** §7.4.5: true while a schema-bump reset + first bootstrap is in flight. */
  #upgrading = false;
  #conflicts: ConflictRecord[] = [];
  #rejections: RejectionRecord[] = [];
  #socket: RealtimeSocket | undefined;
  #pendingRound: PendingRound | undefined;
  #needsPull = false;
  #syncing = false;
  /**
   * True from the synchronous entry of `sync()` until its serialized round
   * settles — the "one loop owns the database" guard that rejects a
   * concurrent `sync()` before the op chain would queue it. Distinct from
   * `#syncing`, which is true only while `#runSync`'s body actually runs
   * (the fast-bail the delta path reads).
   */
  #syncOutstanding = false;
  /** Retry policy belongs to the operation that classified the failure. */
  #retryDelayMs = 250;
  readonly #hasBlobs: boolean;
  /** §8.6 presence: scopeKey → (peerKey `actorId clientId` → peer). */
  readonly #presence = new Map<string, Map<string, PresencePeer>>();
  /** SPEC §7.5: exact core-originated observer transaction batches. */
  readonly #changes = new ChangeEmitter();
  /** Compatibility projection from exact batches; never bridge-inferred. */
  readonly #invalidation = new InvalidationEmitter();
  /** §8.6: subscribable presence-change listeners (twin of onPresence). */
  readonly #presenceListeners = new Set<(scopeKey: string) => void>();
  readonly #diagnostics = new ClientDiagnosticsEmitter();
  #diagnosticsDeferralDepth = 0;
  #diagnosticsPending = false;
  #lastRound: DiagnosticLastRound | undefined;
  #lastChange: DiagnosticLastChange | undefined;
  /** The batch accumulator; non-undefined only inside `#applyBatch`. */
  #batch: ChangeAccumulator | undefined;
  /**
   * Operation-serialization mutex (the core owns one loop). Every
   * transaction-entering ASYNC operation — `sync`, the delta-apply body, and
   * `setWindow` — runs to completion under this chain so no two interleave at
   * an `await` point. This is the single guard that keeps the apply seam
   * atomic: two `#processResponse` runs must never share the `#batch`
   * accumulator or interleave their SQLite transactions (a delta arriving
   * mid-`await this.#downloadSegment` of a pull, or a `setWindow` widen racing
   * a delta). Synchronous ops (`mutate`, schema reset) never join the chain —
   * single-threaded JS cannot interleave them, and because an async op holds
   * no OPEN db transaction (and no installed `#batch`) across its awaits only
   * while it is NOT actively running, a sync op can only land between chained
   * sections, when the seam is quiescent.
   */
  #opChain: Promise<unknown> = Promise.resolve();
  /** Async protected operations outside the SQLite serialization chain
   * (blob I/O and realtime connect). Security preflight waits for this set to
   * drain after synchronously closing the gate. */
  readonly #protectedAsync = new Set<Promise<unknown>>();
  #preflightBarrier: Promise<void> | undefined;

  constructor(config: SyncClientConfig) {
    if (config.securityPreflight === true && config.encryption !== undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'securityPreflight and encryption are mutually exclusive; install keys with activateSecurity after preflight',
      );
    }
    this.#config = config;
    this.#db = config.database;
    this.#schema = compileClientSchema(config.schema);
    this.#encryption = config.encryption;
    this.#securityLifecycle =
      config.securityPreflight === true ? 'preflight' : 'active';
    this.#now = config.now ?? Date.now;
    const outcomeRetentionMaxEntries =
      config.limits?.outcomeRetentionMaxEntries ?? 1_000;
    if (
      !Number.isSafeInteger(outcomeRetentionMaxEntries) ||
      outcomeRetentionMaxEntries < 1
    ) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'outcomeRetentionMaxEntries must be a positive safe integer',
      );
    }
    this.#outcomeRetentionMaxEntries = outcomeRetentionMaxEntries;
    this.#hasBlobs = schemaHasBlobs(this.#schema);
  }

  // -- lifecycle ------------------------------------------------------------

  /** Acquire leadership, create local tables, resolve the clientId. */
  async start(): Promise<void> {
    if (this.#started) return;
    const lock = this.#config.leaderLock ?? singleOwnerLock();
    this.#lease = await lock.acquire(
      this.#config.lockName ?? 'syncular-leader',
    );
    // Bookkeeping must exist before we inspect the persisted schema marker.
    // Do not materialize new app indexes/FTS projections yet: on a version
    // bump they may reference columns that only exist after the reset.
    ensureLocalBookkeepingSchema(this.#db);
    if (this.#hasBlobs) ensureBlobSchema(this.#db);
    this.#db.transaction(() => {
      pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
    });
    const activeFailures = activeFailureRecords(
      listCommitOutcomes(this.#db, { activeOnly: true }),
    );
    this.#conflicts = activeFailures.conflicts;
    this.#rejections = activeFailures.rejections;
    const persisted = getMeta(this.#db, 'clientId');
    if (
      persisted !== undefined &&
      this.#config.clientId !== undefined &&
      persisted !== this.#config.clientId
    ) {
      await this.#lease.release();
      this.#lease = undefined;
      throw new ClientSyncError(
        'client.identity_mismatch',
        `this client database belongs to ${JSON.stringify(persisted)}; refusing to rebind it to ${JSON.stringify(this.#config.clientId)}`,
      );
    }
    this.#clientId = persisted ?? this.#config.clientId ?? crypto.randomUUID();
    if (persisted === undefined) {
      setMeta(this.#db, 'clientId', this.#clientId);
    }
    // §7.3.5: restore the persisted lease so leaseState survives restart.
    const leaseJson = getMeta(this.#db, 'leaseState');
    if (leaseJson !== undefined) {
      this.#leaseState = JSON.parse(leaseJson) as LeaseState;
    }
    // §7.4.2 trigger 1: the persisted local schema version differs from the
    // generated version this client ships — run the wipe/re-bootstrap reset
    // before the first sync round. A fresh install (no marker) is treated as
    // already at the generated version.
    this.#detectAndResetSchema();
    // A registration remains app intent only while its table exists in the
    // running schema. Removed-table registrations would poison every pull.
    const subscriptions = pruneUnknownSubscriptions(
      this.#db,
      loadSubscriptions(this.#db),
      new Set(this.#schema.tables.keys()),
    );
    this.#started = true;
    // A persisted active subscription needs one catch-up round on every open:
    // realtime only covers changes after the socket connects, and an
    // idempotent setWindow/subscribe call correctly creates no new command
    // effect. Pending outbox work has the same restart requirement. Surface
    // this as an exact core-owned intent so hosts never need a startup poll or
    // an application-issued sync() call.
    const startupWork =
      this.#schemaFloor === undefined &&
      (listOutbox(this.#db).length > 0 ||
        subscriptions.some((sub) => sub.status === 'active'));
    if (startupWork && this.#securityLifecycle === 'active') {
      this.#needsPull = true;
      this.#config.onSyncNeeded?.('startup');
      this.#config.onSyncIntent?.({ kind: 'interactive' });
    }
    // RFC 0002 §3.2: console introspection — a no-op outside a dev page.
    this.#devtoolsUnregister = registerDevtools({
      kind: 'client',
      ref: this,
      clientId: () => this.#clientId,
      role: () => 'direct',
      outbox: async () => this.pendingCommits().length,
      subscriptions: async () => this.subscriptions(),
      conflicts: async () => this.conflicts.length,
      rejections: async () => this.rejections.length,
      syncNeeded: async () => this.syncNeeded,
      upgrading: async () => this.upgrading,
      onInvalidate: (listener) => this.onInvalidate(listener),
    });
    this.#emitDiagnostics();
  }

  /**
   * §7.4.1/§7.4.2: compare the generated schema version to the persisted
   * marker and run the §7.4.3 reset when they differ. Idempotent by the
   * marker — a mid-reset crash re-runs the reset on the next boot.
   */
  #detectAndResetSchema(): void {
    const markerJson = getMeta(this.#db, LOCAL_SCHEMA_VERSION_KEY);
    if (markerJson === undefined) {
      // Fresh install: the tables just created match the running code.
      ensureLocalSyncedSchema(this.#db, this.#schema);
      setMeta(this.#db, LOCAL_SCHEMA_VERSION_KEY, String(this.#schema.version));
      return;
    }
    const marker = Number(markerJson);
    if (marker === this.#schema.version) {
      // Same-version opens remain self-healing for absent tables/indexes.
      ensureLocalSyncedSchema(this.#db, this.#schema);
      return;
    }
    this.#runSchemaReset();
  }

  /**
   * §7.4.3 reset: whole-database local reset EXCEPT the outbox, clientId,
   * and leaseState. Drops/recreates every synced table from the new schema,
   * resets subscription sync-state (keeping registrations), clears any
   * schema-floor stop state, rewrites the marker, and raises `upgrading`.
   * The bump is idempotent by the marker (rewritten last).
   */
  #runSchemaReset(): void {
    this.#setUpgrading(true);
    this.#applyBatch((batch) => {
      this.#db.transaction(() => {
        dropAndRecreateSyncedTables(this.#db, this.#schema);
        resetSubscriptionsForBump(this.#db);
        setMeta(
          this.#db,
          LOCAL_SCHEMA_VERSION_KEY,
          String(this.#schema.version),
        );
      });
      // Whole-DB reset: every synced table's rows changed (I1 eviction-shaped).
      for (const table of this.#schema.tables.values()) batch.table(table.name);
    });
    // The stop state is over: this client now ships a servable schema. The
    // outbox is re-applied optimistically over the (now empty) tables so
    // pending offline writes stay visible across the bump (§7.4.5).
    this.#setSchemaFloor(undefined);
    this.#replayOutbox();
  }

  #setUpgrading(upgrading: boolean): void {
    if (this.#upgrading === upgrading) return;
    this.#applyBatch((batch) => {
      this.#upgrading = upgrading;
      batch.status();
    });
    this.#config.onUpgrading?.(upgrading);
  }

  #setSyncNeeded(syncNeeded: boolean): void {
    if (this.#needsPull === syncNeeded) return;
    this.#applyBatch((batch) => {
      this.#needsPull = syncNeeded;
      batch.status();
    });
  }

  #setSchemaFloor(schemaFloor: SchemaFloor | undefined): void {
    const current = JSON.stringify(this.#schemaFloor);
    if (current === JSON.stringify(schemaFloor)) return;
    this.#applyBatch((batch) => {
      this.#schemaFloor = schemaFloor;
      batch.status();
    });
  }

  async close(): Promise<void> {
    this.#devtoolsUnregister?.();
    this.#devtoolsUnregister = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#abortPendingRound('client closed mid-round');
    await this.#lease?.release();
    this.#lease = undefined;
    this.#started = false;
  }

  /** Current fail-closed local-replica security state. */
  get securityLifecycle(): SecurityLifecycle {
    return this.#securityLifecycle;
  }

  /**
   * Block new protected operations immediately, then wait for every already
   * serialized database/network operation to settle before releasing key
   * references. Hosts await this barrier before applying a quarantine purge.
   */
  beginSecurityPreflight(): Promise<void> {
    this.#requireStarted();
    if (this.#preflightBarrier !== undefined) return this.#preflightBarrier;
    this.#securityLifecycle = 'preflight';
    this.disconnectRealtime();
    const barrier = (async () => {
      await Promise.allSettled([this.#opChain, ...this.#protectedAsync]);
      this.disconnectRealtime();
      this.#encryption = undefined;
      this.#syncOutstanding = false;
    })();
    this.#preflightBarrier = barrier;
    void barrier.then(
      () => {
        if (this.#preflightBarrier === barrier)
          this.#preflightBarrier = undefined;
      },
      () => {
        if (this.#preflightBarrier === barrier)
          this.#preflightBarrier = undefined;
      },
    );
    return barrier;
  }

  /**
   * Atomically install the post-authentication keyring and release the gate.
   * Persisted subscriptions/outbox work produces one exact startup intent only
   * after activation, never while the local quarantine decision is pending.
   */
  async activateSecurity(options: SecurityActivation = {}): Promise<void> {
    this.#requireStarted();
    if (this.#securityLifecycle === 'active') {
      throw new ClientSyncError(
        'sync.invalid_request',
        'activateSecurity requires the client to be in security preflight',
      );
    }
    await (this.#preflightBarrier ?? this.#opChain);
    this.#encryption = options.encryption;
    this.#securityLifecycle = 'active';
    const startupWork =
      this.#schemaFloor === undefined &&
      (listOutbox(this.#db).length > 0 ||
        loadSubscriptions(this.#db).some((sub) => sub.status === 'active'));
    if (startupWork) {
      this.#setSyncNeeded(true);
      this.#config.onSyncNeeded?.('startup');
      this.#config.onSyncIntent?.({ kind: 'interactive' });
    }
    this.#emitDiagnostics();
  }

  // -- accessors ------------------------------------------------------------

  get clientId(): string {
    return this.#clientId;
  }

  /** The underlying database — raw SQL is the local query API (B3). */
  get database(): ClientDatabase {
    this.#requireActive();
    return this.#db;
  }

  /**
   * The raw-SQL read tier. Guarded (query-guard.ts): a single read-only
   * statement only — writes must go through `mutate()` so they hit the
   * outbox (SPEC §7.1). Reserved `_sync_*` columns are stripped from the
   * result, so a `SELECT *` row is safe to feed back into `mutate()`
   * values; alias explicitly (`_sync_version AS v`) to read one. Engine
   * internals read `this.#db` directly and skip this method by design.
   */
  query(sql: string, params?: readonly SqlValue[]): SqlRow[] {
    this.#requireActive();
    assertReadOnlyQuery(sql);
    return stripSyncColumns(this.#db.query(sql, params));
  }

  /** Current durable local observer revision (SPEC §7.5). */
  get localRevision(): LocalRevision {
    this.#requireStarted();
    return getLocalRevision(this.#db);
  }

  /**
   * Read rows, window answerability, and revision from one SQLite snapshot.
   * Reactive integrations use this instead of composing `query()` and
   * `windowState()` across separate worker/IPC calls.
   */
  querySnapshot<Row = SqlRow>(spec: QueryReadSpec): QuerySnapshot<Row> {
    this.#requireActive();
    assertReadOnlyQuery(spec.sql);
    return this.#db.transaction(() => {
      const revision = getLocalRevision(this.#db);
      const rows = stripSyncColumns(
        this.#db.query(spec.sql, spec.params),
      ) as unknown as readonly Row[];
      const pending: WindowUnitRef[] = [];
      const missing: WindowUnitRef[] = [];
      for (const requested of spec.coverage ?? []) {
        const baseKey = windowBaseKey(requested.base);
        const live = new Map(
          loadWindowUnits(this.#db, baseKey).map((entry) => [
            entry.unit,
            entry.subId,
          ]),
        );
        for (const unit of new Set(requested.units)) {
          const subId = live.get(unit);
          const ref = { baseKey, unit };
          if (subId === undefined) {
            missing.push(ref);
            continue;
          }
          const sub = getSubscription(this.#db, subId);
          if (
            sub === undefined ||
            sub.status !== 'active' ||
            sub.cursor < 0 ||
            sub.bootstrapState !== undefined
          ) {
            pending.push(ref);
          }
        }
      }
      return {
        revision,
        rows,
        coverage: {
          complete: pending.length === 0 && missing.length === 0,
          pending,
          missing,
        },
      };
    });
  }

  // -- live-query invalidation (TODO 3.1 / DESIGN-eviction I1–I4) -----------

  /**
   * Subscribe to fine-grained invalidation. The callback fires ONCE per
   * apply batch (never per row, I1) with the `{tables, scopeKeys}` touched
   * this batch (§3.1 vocabulary, I2). Returns an unsubscribe function.
   *
   * Every local mutation flows through the same choke point: `COMMIT`
   * apply, segment apply, the optimistic overlay rebuild, the §3.3 purge,
   * the §7.4.3 schema-bump reset, and local `mutate`. `tables` is the
   * reliable floor; `scopeKeys` refines it wherever the source carried
   * per-row scopes (COMMIT changes) or a scope map (segments/purge).
   */
  onInvalidate(listener: InvalidationListener): () => void {
    return this.#invalidation.on(listener);
  }

  /** Subscribe to exact revisioned observer transactions (SPEC §7.5). */
  onChange(listener: ClientChangeListener): () => void {
    return this.#changes.on(listener);
  }

  /** Subscribe to complete, privacy-safe diagnostic snapshots. */
  onDiagnostics(listener: ClientDiagnosticsListener): () => void {
    return this.#diagnostics.on(listener);
  }

  /**
   * One atomic support/product-health view. It never returns scope values,
   * rows, SQL, paths, auth material, lease ids, keys, or mutation bodies.
   */
  diagnosticsSnapshot(
    request: ClientDiagnosticsRequest = {},
  ): ClientDiagnosticsSnapshot {
    this.#requireActive();
    const expected = request.expectedSubscriptions ?? [];
    if (expected.length > MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `diagnosticsSnapshot accepts at most ${MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS} expected subscriptions`,
      );
    }
    const registered = loadSubscriptions(this.#db);
    const subscriptions = new Map<string, DiagnosticSubscription>();
    for (const sub of registered) {
      const reset = sub.cursor < 0 && sub.reasonCode === 'sync.cursor_expired';
      const complete =
        sub.status === 'active' &&
        sub.cursor >= 0 &&
        sub.bootstrapState === undefined;
      subscriptions.set(sub.id, {
        id: sub.id,
        table: sub.table,
        state:
          sub.status === 'revoked'
            ? 'revoked'
            : sub.status === 'failed'
              ? 'failed'
              : reset
                ? 'reset'
                : complete
                  ? 'complete'
                  : 'bootstrapping',
        complete,
        cursor: sub.cursor,
        ...(sub.reasonCode !== undefined
          ? { reasonCode: this.#diagnosticCode(sub.reasonCode) }
          : {}),
      });
    }
    for (const item of expected) {
      if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        typeof item.table !== 'string' ||
        item.table.length === 0
      ) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'diagnosticsSnapshot expected subscriptions require non-empty id and table strings',
        );
      }
      const registeredSubscription = subscriptions.get(item.id);
      if (
        registeredSubscription !== undefined &&
        registeredSubscription.table !== item.table
      ) {
        subscriptions.set(item.id, {
          id: item.id,
          table: item.table,
          state: 'failed',
          complete: false,
          reasonCode: 'client.subscription_intent_mismatch',
        });
      } else if (registeredSubscription === undefined) {
        subscriptions.set(item.id, {
          id: item.id,
          table: item.table,
          state: 'unregistered',
          complete: false,
        });
      }
    }
    const capturedAtMs = this.#now();
    const leaseState = this.#diagnosticLease(capturedAtMs);
    const connectivity =
      this.#lastRound?.status === 'succeeded'
        ? 'online'
        : this.#lastRound?.status === 'failed' &&
            this.#transportFailureCode(this.#lastRound.errorCode)
          ? 'offline'
          : 'unknown';
    const expectedOrder = new Map(
      expected.map((item, index) => [item.id, index] as const),
    );
    const allSubscriptions = [...subscriptions.values()].sort((a, b) => {
      const aExpected = expectedOrder.get(a.id);
      const bExpected = expectedOrder.get(b.id);
      if (aExpected !== undefined || bExpected !== undefined) {
        return (
          (aExpected ?? Number.MAX_SAFE_INTEGER) -
          (bExpected ?? Number.MAX_SAFE_INTEGER)
        );
      }
      return a.id.localeCompare(b.id);
    });
    return {
      version: CLIENT_DIAGNOSTICS_VERSION,
      capturedAtMs,
      host: {
        kind: 'direct',
        role: 'single',
        connectivity,
        realtime:
          this.#config.realtime === undefined
            ? 'unsupported'
            : this.#socket === undefined
              ? 'disconnected'
              : 'connected',
      },
      securityLifecycle: this.#securityLifecycle,
      schema: {
        currentVersion: this.#config.schema.version,
        upgrading: this.#upgrading,
        ...(this.#schemaFloor?.requiredSchemaVersion !== undefined
          ? { requiredVersion: this.#schemaFloor.requiredSchemaVersion }
          : {}),
        ...(this.#schemaFloor?.latestSchemaVersion !== undefined
          ? { latestVersion: this.#schemaFloor.latestSchemaVersion }
          : {}),
      },
      replica: {
        localRevision: getLocalRevision(this.#db).toString(),
        syncNeeded: this.#needsPull,
        pendingOutbox: listOutbox(this.#db).length,
      },
      lease: leaseState,
      subscriptions: allSubscriptions.slice(
        0,
        MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
      ),
      subscriptionsTruncated:
        allSubscriptions.length > MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
      ...(this.#lastRound !== undefined ? { lastRound: this.#lastRound } : {}),
      ...(this.#lastChange !== undefined
        ? { lastChange: this.#lastChange }
        : {}),
      storage: this.#diagnosticStorage(),
    };
  }

  #diagnosticLease(nowMs: number): ClientDiagnosticsSnapshot['lease'] {
    const lease = this.#leaseState;
    if (lease?.errorCode !== undefined) {
      return {
        state: 'stopped',
        errorCode: this.#diagnosticCode(lease.errorCode),
        ...(lease.expiresAtMs !== undefined
          ? { expiresAtMs: lease.expiresAtMs }
          : {}),
      };
    }
    if (lease?.expiresAtMs === undefined) return { state: 'none' };
    return {
      state: lease.expiresAtMs <= nowMs ? 'expired' : 'active',
      expiresAtMs: lease.expiresAtMs,
    };
  }

  #diagnosticStorage(): ClientDiagnosticsStorage {
    try {
      const pageCount = Number(
        this.#db.query('PRAGMA page_count')[0]?.page_count ?? 0,
      );
      const pageSize = Number(
        this.#db.query('PRAGMA page_size')[0]?.page_size ?? 0,
      );
      const outboxBytes = Number(
        this.#db.query(
          'SELECT COALESCE(SUM(LENGTH(operations)), 0) AS bytes FROM _syncular_outbox',
        )[0]?.bytes ?? 0,
      );
      const outcome = this.#db.query(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(LENGTH(results) + COALESCE(LENGTH(operations), 0)), 0) AS bytes
           FROM _syncular_commit_outcomes`,
      )[0];
      const blobBytes = this.#hasBlobs
        ? Number(
            this.#db.query(
              'SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM _syncular_blobs',
            )[0]?.bytes ?? 0,
          )
        : 0;
      const pressure =
        this.#config.blobCacheMaxBytes !== undefined &&
        blobBytes > this.#config.blobCacheMaxBytes;
      return {
        status: pressure ? 'pressure' : 'healthy',
        databaseBytesApprox: Math.max(0, pageCount * pageSize),
        pendingOutboxBytesApprox: Math.max(0, outboxBytes),
        retainedOutcomeBytesApprox: Math.max(0, Number(outcome?.bytes ?? 0)),
        retainedOutcomeEntries: Math.max(0, Number(outcome?.entries ?? 0)),
        blobCacheBytesApprox: Math.max(0, blobBytes),
        ...(pressure
          ? { pressureReasonCode: 'client.blob_cache_over_limit' as const }
          : {}),
      };
    } catch {
      return { status: 'unreadable' };
    }
  }

  #emitDiagnostics(): void {
    if (
      !this.#started ||
      this.#securityLifecycle !== 'active' ||
      !this.#diagnostics.observed
    ) {
      return;
    }
    if (this.#diagnosticsDeferralDepth > 0) {
      this.#diagnosticsPending = true;
      return;
    }
    this.#diagnostics.emit(this.diagnosticsSnapshot());
  }

  #beginDiagnosticsDeferral(): void {
    this.#diagnosticsDeferralDepth += 1;
  }

  #endDiagnosticsDeferral(): void {
    if (this.#diagnosticsDeferralDepth === 0) return;
    this.#diagnosticsDeferralDepth -= 1;
    if (this.#diagnosticsDeferralDepth === 0 && this.#diagnosticsPending) {
      this.#diagnosticsPending = false;
      this.#emitDiagnostics();
    }
  }

  /** One call for the complete status domain used by reactive hosts. */
  statusSnapshot(): SyncStatusSnapshot {
    this.#requireStarted();
    return this.#statusSnapshot();
  }

  #statusSnapshot(outboxCount?: number): SyncStatusSnapshot {
    return {
      currentSchemaVersion: this.#config.schema.version,
      outbox: outboxCount ?? listOutbox(this.#db).length,
      upgrading: this.#upgrading,
      leaseState: this.#leaseState,
      schemaFloor: this.#schemaFloor,
      syncNeeded: this.#needsPull,
    };
  }

  /**
   * Run `fn` as one apply batch: install a fresh accumulator, collect every
   * touched key, then emit exactly one coalesced event if anything changed.
   * Re-entrant calls share the outer batch so a nested apply never
   * double-emits (e.g. purge → blob reconcile → replay inside one round).
   */
  #applyBatch<T>(
    fn: (batch: ChangeAccumulator) => T,
    statusSnapshotOverride?: () => SyncStatusSnapshot,
  ): T {
    if (this.#batch !== undefined) return fn(this.#batch);
    const batch = new ChangeAccumulator();
    let revision: LocalRevision | undefined;
    let status: SyncStatusSnapshot | undefined;
    let result!: T;
    try {
      this.#db.transaction(() => {
        this.#batch = batch;
        try {
          result = fn(batch);
          if (batch.touched) {
            revision = bumpLocalRevision(this.#db);
            if (batch.statusChanged) {
              status = statusSnapshotOverride?.() ?? this.#statusSnapshot();
            }
          }
        } finally {
          this.#batch = undefined;
        }
      });
    } catch (error) {
      this.#batch = undefined;
      throw error;
    }
    if (revision !== undefined) {
      const event = batch.finish(revision, status);
      const tables = [...new Set(event.tables.map((entry) => entry.table))];
      const windows = [...new Set(event.windows.map((entry) => entry.table))];
      this.#lastChange = {
        revision: revision.toString(),
        recordedAtMs: this.#now(),
        tables: tables.slice(0, MAX_DIAGNOSTIC_DOMAINS),
        windows: windows.slice(0, MAX_DIAGNOSTIC_DOMAINS),
        domainsTruncated:
          tables.length > MAX_DIAGNOSTIC_DOMAINS ||
          windows.length > MAX_DIAGNOSTIC_DOMAINS,
        statusChanged: event.status !== undefined,
        conflictsChanged: event.conflictsChanged,
        rejectionsChanged: event.rejectionsChanged,
        outcomesChanged: event.outcomesChanged,
      };
      this.#changes.emit(event);
      const legacy = invalidationFromChange(event);
      if (legacy !== undefined) this.#invalidation.emit(legacy);
      this.#emitDiagnostics();
    }
    return result;
  }

  /**
   * Run `fn` as the next link in the operation-serialization chain
   * ({@link #opChain}): it starts only after every previously-serialized
   * operation has fully settled, so transaction-entering async operations
   * never interleave at an await point. Both chain branches settle to
   * `undefined` so one operation's rejection never poisons the next
   * (mirrors the worker host's `serializedSync`). NOT re-entrant: a
   * serialized operation must not call another serialized operation, or it
   * would deadlock waiting on itself.
   */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#opChain.then(fn, fn);
    this.#opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #runProtectedAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.#requireActive();
    const task = Promise.resolve().then(fn);
    this.#protectedAsync.add(task);
    void task.then(
      () => this.#protectedAsync.delete(task),
      () => this.#protectedAsync.delete(task),
    );
    return task;
  }

  // -- blobs (§5.9) ---------------------------------------------------------

  /**
   * Stage a blob for attachment (§5.9.7): hash the bytes into the content
   * address, cache them locally, and queue the upload (flushed before the
   * next push — B4). Returns the canonical `BlobRef` **string** to store in
   * a `blob_ref` column of a mutation. The referencing row MUST be written
   * (via `mutate`) after this call so upload-before-push holds (§5.9.3).
   */
  uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<BlobRef> {
    return this.#runProtectedAsync(() => this.#uploadBlob(bytes, options));
  }

  async #uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<BlobRef> {
    if (this.#config.blobs === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'uploadBlob requires a blob transport (SyncClientConfig.blobs, §5.9)',
      );
    }
    const blobId = await computeBlobId(bytes);
    this.#db.transaction(() => {
      putCachedBlob(this.#db, blobId, bytes, this.#now(), options?.mediaType);
      recordPendingUpload(this.#db, blobId, this.#now(), options?.mediaType);
    });
    // §5.9.7 B1: a staged upload is pinned (recordPendingUpload), so the cap
    // trim below will never evict it — but a stage may push other zero-ref
    // bodies over the cap, so run the trim.
    this.#enforceBlobCacheCap();
    return {
      blobId,
      byteLength: bytes.length,
      ...(options?.mediaType !== undefined
        ? { mediaType: options.mediaType }
        : {}),
      ...(options?.name !== undefined ? { name: options.name } : {}),
    };
  }

  /** Serialize a BlobRef to the canonical string a `blob_ref` column holds. */
  blobRefString(ref: BlobRef): string {
    return serializeBlobRef(ref);
  }

  /**
   * Resolve blob bytes for a `blobId` (§5.9.7): a content-addressed cache
   * hit serves without a network fetch (B1); a miss downloads via the blob
   * transport (§5.9.5), verifies the content address, caches, and returns.
   * Accepts a raw `blob_ref` column string or a bare `blobId`.
   */
  fetchBlob(blobIdOrRef: string): Promise<CachedBlob> {
    return this.#runProtectedAsync(() => this.#fetchBlob(blobIdOrRef));
  }

  async #fetchBlob(blobIdOrRef: string): Promise<CachedBlob> {
    const blobId = blobIdOrRef.startsWith('sha256:')
      ? blobIdOrRef
      : parseBlobRef(blobIdOrRef).blobId;
    const cached = getCachedBlob(this.#db, blobId, this.#now());
    if (cached !== undefined) return cached;
    const transport = this.#config.blobs;
    if (transport === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'fetchBlob requires a blob transport (SyncClientConfig.blobs, §5.9)',
      );
    }
    // §5.9.5: the authorized endpoint serves bytes inline OR (always-issue,
    // presign configured) a signed url the client fetches directly. On a url
    // arm the client MUST NOT attach host auth and MUST NOT fall through:
    // failure => re-request, the caller's next fetchBlob mints a fresh url.
    const response = await transport.download(blobId);
    let bytes: Uint8Array;
    if (response.kind === 'url') {
      if (transport.fetchUrl === undefined) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'blob download returned a url but the transport cannot fetch urls (§5.9.5)',
        );
      }
      if (
        response.urlExpiresAtMs !== undefined &&
        response.urlExpiresAtMs <= this.#now()
      ) {
        // §5.9.5: MUST NOT start a fetch at/past expiry — re-request recovers.
        throw new ClientSyncError(
          'sync.segment_expired',
          `blob url for ${blobId} expired before fetch — re-request mints a fresh url (§5.9.5)`,
          true,
        );
      }
      bytes = await transport.fetchUrl(response.url);
    } else {
      bytes = response.bytes;
    }
    const computed = await computeBlobId(bytes);
    if (computed !== blobId) {
      // §5.9.5 inherits §5.1: verify the content address, reject on mismatch.
      // On the url path this invalidates the fetch (no fall-through) — the
      // next fetchBlob re-requests the authorized endpoint (§5.9.5 recovery).
      throw new ClientSyncError(
        'sync.invalid_request',
        `blob content address mismatch for ${blobId} (§5.9.5)`,
      );
    }
    putCachedBlob(this.#db, blobId, bytes, this.#now());
    this.#enforceBlobCacheCap();
    const stored = getCachedBlob(this.#db, blobId);
    if (stored === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'blob cache write failed',
      );
    }
    return stored;
  }

  /** §5.9.7 B1: trim the blob cache to the configured cap (no-op if unset). */
  #enforceBlobCacheCap(): void {
    const cap = this.#config.blobCacheMaxBytes;
    if (cap === undefined) return;
    enforceBlobCacheCap(this.#db, cap);
  }

  /** Flush any queued blob uploads (§5.9.7 B4); safe to call standalone. */
  flushBlobUploads(): Promise<void> {
    return this.#runProtectedAsync(() => this.#flushBlobUploads());
  }

  async #flushBlobUploads(): Promise<void> {
    const transport = this.#config.blobs;
    if (transport === undefined || !this.#hasBlobs) return;
    for (const pending of listPendingUploads(this.#db)) {
      const cached = getCachedBlob(this.#db, pending.blobId);
      if (cached === undefined) {
        // The bytes are gone (never happens for a well-behaved client);
        // drop the upload so it does not wedge the queue.
        clearPendingUpload(this.#db, pending.blobId);
        continue;
      }
      await this.#uploadOne(
        transport,
        pending.blobId,
        cached.bytes,
        pending.mediaType,
      );
      clearPendingUpload(this.#db, pending.blobId);
    }
  }

  /**
   * §5.9.3: upload one blob, preferring the presigned direct-to-storage grant
   * when the transport supports it, else streaming through the direct endpoint
   * (capability, not fallback). A `url` grant PUTs direct with no host auth; on
   * a grant PUT failure the client streams through the direct endpoint — a
   * *different, host-authenticated capability*, not a fall-through of the
   * grant's authority (the direct endpoint was always the other path, B4).
   */
  async #uploadOne(
    transport: BlobTransport,
    blobId: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<void> {
    if (
      transport.uploadGrant !== undefined &&
      transport.uploadToUrl !== undefined
    ) {
      const grant = await transport.uploadGrant(
        blobId,
        bytes.length,
        mediaType,
      );
      if (grant.kind === 'present') return; // idempotent §5.9.3 — no PUT needed
      if (grant.kind === 'url') {
        if (
          grant.urlExpiresAtMs === undefined ||
          grant.urlExpiresAtMs > this.#now()
        ) {
          try {
            await transport.uploadToUrl(grant.url, bytes, mediaType);
            return;
          } catch {
            // Grant PUT failed — stream through the direct endpoint below.
          }
        }
      }
      // grant.kind === 'none' (no presign store) or a failed/expired grant:
      // stream through the direct host-authenticated endpoint.
    }
    await transport.upload(blobId, bytes, mediaType);
  }

  get conflicts(): readonly ConflictRecord[] {
    this.#requireActive();
    return this.#conflicts;
  }

  get rejections(): readonly RejectionRecord[] {
    this.#requireActive();
    return this.#rejections;
  }

  /** One durable final outcome by the originating client commit id. */
  commitOutcome(clientCommitId: string): CommitOutcome | undefined {
    this.#requireActive();
    return readCommitOutcome(this.#db, clientCommitId);
  }

  /** Newest-first durable outcome journal. */
  commitOutcomes(query: CommitOutcomeQuery = {}): readonly CommitOutcome[] {
    this.#requireActive();
    return listCommitOutcomes(this.#db, query);
  }

  /**
   * Mark a durable failure handled without deleting its evidence. Conflicts
   * may keep the server row or link to a replacement commit; rejections may
   * only be superseded by a named replacement. Applied/cached history may be
   * dismissed. The transition is one-way and survives restart.
   */
  resolveCommitOutcome(input: ResolveCommitOutcomeInput): CommitOutcome {
    this.#requireActive();
    const current = readCommitOutcome(this.#db, input.clientCommitId);
    if (current === undefined) {
      throw new ClientSyncError(
        'sync.outcome_not_found',
        `no durable outcome exists for ${JSON.stringify(input.clientCommitId)}`,
      );
    }
    if (current.resolution !== 'active') return current;
    const replacement = input.replacementClientCommitId;
    if (input.resolution === 'superseded') {
      if (
        replacement === undefined ||
        replacement.length === 0 ||
        replacement === input.clientCommitId
      ) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'superseded outcomes require a distinct replacementClientCommitId',
        );
      }
    } else if (replacement !== undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'replacementClientCommitId is valid only for superseded outcomes',
      );
    }
    const allowed =
      (current.status === 'conflict' &&
        (input.resolution === 'resolved_keep_server' ||
          input.resolution === 'superseded')) ||
      (current.status === 'rejected' && input.resolution === 'superseded') ||
      ((current.status === 'applied' || current.status === 'cached') &&
        input.resolution === 'dismissed');
    if (!allowed) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `resolution ${input.resolution} is invalid for ${current.status} outcome`,
      );
    }

    return this.#applyBatch((batch) => {
      const resolved = persistCommitOutcomeResolution(
        this.#db,
        input,
        this.#now(),
      );
      if (resolved === undefined) {
        throw new ClientSyncError(
          'sync.outcome_not_found',
          `no durable outcome exists for ${JSON.stringify(input.clientCommitId)}`,
        );
      }
      this.#conflicts = this.#conflicts.filter(
        (record) => record.clientCommitId !== input.clientCommitId,
      );
      this.#rejections = this.#rejections.filter(
        (record) => record.clientCommitId !== input.clientCommitId,
      );
      pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
      batch.outcomes();
      if (current.status === 'conflict') batch.conflicts();
      if (current.status === 'rejected') batch.rejections();
      return resolved;
    });
  }

  /** Non-undefined once the server declared a schema floor (§1.6). */
  get schemaFloor(): SchemaFloor | undefined {
    return this.#schemaFloor;
  }

  /**
   * §7.4.5: true while a schema-bump reset + first re-bootstrap is in
   * flight — the app's "upgrading…" cue. Clears when the first post-reset
   * bootstrap round reaches idle (every subscription past its fresh
   * bootstrap).
   */
  get upgrading(): boolean {
    return this.#upgrading;
  }

  /**
   * §7.3.5: the current auth-lease state (opaque). Undefined until a
   * `LEASE` frame arrives. `errorCode` is set when a round was rejected
   * with a request-level lease code — syncing on the lease has stopped.
   */
  get leaseState(): LeaseState | undefined {
    return this.#leaseState;
  }

  /** §7.3.5: remaining lease validity in ms (`expiresAtMs − now`), or
   * `undefined` if no lease is held. Negative once expired. */
  leaseRemainingMs(now: number = this.#now()): number | undefined {
    const expiresAtMs = this.#leaseState?.expiresAtMs;
    return expiresAtMs === undefined ? undefined : expiresAtMs - now;
  }

  /** True when syncing is stopped pending a client upgrade. */
  get stopped(): boolean {
    return this.#schemaFloor !== undefined;
  }

  /** §8: a hello/wake-up asked for a pull that has not run yet. */
  get syncNeeded(): boolean {
    return this.#needsPull;
  }

  /**
   * §8.6 presence on a scope key: the current peers present there (a map
   * of `actorId clientId` → peer). Empty for a key with no present peers.
   * Ephemeral — reflects only what the socket has delivered.
   */
  presence(scopeKey: string): readonly PresencePeer[] {
    this.#requireActive();
    const peers = this.#presence.get(scopeKey);
    return peers === undefined ? [] : [...peers.values()];
  }

  /** Every scope key this client currently has presence state for. */
  presenceKeys(): string[] {
    this.#requireActive();
    return [...this.#presence.keys()];
  }

  /**
   * §8.6: subscribe to presence changes (join/update/leave on any held key).
   * The subscribable twin of the `onPresence` config callback — React's
   * `usePresence` targets this so many components can watch one client.
   * Returns an unsubscribe function.
   */
  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => {
      this.#presenceListeners.delete(listener);
    };
  }

  /**
   * §8.6.2 publish (or clear, `doc: null`) this client's presence document
   * for `scopeKey`. Requires a live socket; the document is ephemeral and
   * lost on disconnect (the server emits leave). Authorization is the
   * connection's registration (§8.6.3) — an unheld key is rejected loudly
   * by the server with `presence.forbidden`.
   */
  setPresence(scopeKey: string, doc: Record<string, unknown> | null): void {
    this.#requireActive();
    const socket = this.#socket;
    if (socket === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'setPresence requires a connected realtime socket (§8.6)',
      );
    }
    socket.send(encodePresencePublish(scopeKey, doc));
  }

  /**
   * §4.2 accept mask: the configured override, or the rows baseline plus
   * bit 2 when the backend can import sqlite images (§5.3) and a segment
   * downloader exists (sqlite segments are never inline, §5.7), plus
   * bit 3 when the downloader exposes a direct URL fetch (§5.4
   * capability negotiation).
   */
  #acceptMask(): number {
    const configured = this.#config.limits?.accept;
    if (configured !== undefined) return configured;
    const segments = this.#config.segments;
    const sqliteCapable =
      typeof this.#db.withSqliteImage === 'function' && segments !== undefined;
    const urlCapable = typeof segments?.fetchUrl === 'function';
    return (
      ACCEPT_ROWS_BASELINE |
      (sqliteCapable ? ACCEPT_SQLITE : 0) |
      (urlCapable ? ACCEPT_SIGNED_URLS : 0)
    );
  }

  subscriptions(): SubscriptionRecord[] {
    this.#requireActive();
    return loadSubscriptions(this.#db);
  }

  subscription(id: string): SubscriptionRecord | undefined {
    this.#requireActive();
    return getSubscription(this.#db, id);
  }

  pendingCommits(): OutboxCommit[] {
    this.#requireActive();
    return listOutbox(this.#db);
  }

  // -- subscriptions ----------------------------------------------------------

  subscribe(input: SubscribeInput): void {
    this.#requireActive();
    if (!this.#schema.tables.has(input.table)) {
      throw new ClientSyncError(
        'sync.unknown_table',
        `subscribe: unknown local table ${JSON.stringify(input.table)}`,
      );
    }
    const existing = getSubscription(this.#db, input.id);
    if (existing !== undefined) {
      const sameIntent =
        existing.table === input.table &&
        canonicalScopeJson(existing.scopes) ===
          canonicalScopeJson(input.scopes) &&
        existing.params === input.params;
      if (!sameIntent) {
        throw new ClientSyncError(
          'client.subscription_intent_mismatch',
          'subscribe: the subscription id is already registered for a different table, scopes, or params',
        );
      }
      return;
    }
    saveSubscription(this.#db, {
      id: input.id,
      table: input.table,
      scopes: input.scopes,
      ...(input.params !== undefined ? { params: input.params } : {}),
      cursor: -1,
      status: 'active',
    });
    this.#emitDiagnostics();
  }

  unsubscribe(id: string): void {
    this.#requireActive();
    deleteSubscription(this.#db, id);
    this.#emitDiagnostics();
  }

  // -- windowed subscriptions (§4.8) ------------------------------------------

  /**
   * Set the live window units for a base (§4.8): a value-sharded family of
   * subscriptions, one per unit. Computes the diff against the registry —
   * added units get fresh subscriptions (image-lane bootstrap on the next
   * sync); removed units are unsubscribed and evicted, fused in one local
   * transaction (E1–E4). Idempotent: calling with the same units is a
   * no-op. Re-entry (a unit removed then re-added) cancels any deferred
   * eviction and fresh-bootstraps.
   *
   * The change takes effect on the next `sync()`/socket round — the pull's
   * subscription list (now with the added unit, without the removed one)
   * re-registers realtime at round end (§8.7). No socket cycle needed.
   */
  async setWindow(base: WindowBase, units: readonly string[]): Promise<void> {
    await this.setWindowCommand(base, units);
  }

  /** Exact core command result consumed by automatic host loops (§7.5). */
  async setWindowCommand(
    base: WindowBase,
    units: readonly string[],
  ): Promise<CommandResult<void>> {
    this.#requireActive();
    const table = this.#table(base.table);
    if (!table.scopeColumnByVariable.has(base.variable)) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `setWindow: table ${JSON.stringify(base.table)} has no scope variable ${JSON.stringify(base.variable)} (§4.8)`,
      );
    }
    // Serialize the whole window edit: it spans an `await deriveSubId` between
    // db transactions, so without the chain a delta apply (or a concurrent
    // setWindow) could interleave its transactions and corrupt the registry.
    let changed = false;
    let widened = false;
    await this.#serialize(async () => {
      const baseKey = windowBaseKey(base);
      const wanted = new Set(units);
      const live = loadWindowUnits(this.#db, baseKey);
      const liveByUnit = new Map(live.map((u) => [u.unit, u.subId]));

      // Widen: units wanted but not live → fresh subscription + registry row.
      for (const unit of wanted) {
        if (liveByUnit.has(unit)) continue;
        const subId = await deriveSubId(base, unit);
        this.#applyBatch((batch) => {
          this.#db.transaction(() => {
            // Re-entry cancels any deferred eviction for this sub id.
            deletePendingEviction(this.#db, subId);
            insertWindowUnit(this.#db, baseKey, unit, subId);
            saveSubscription(this.#db, {
              id: subId,
              table: base.table,
              scopes: unitScopes(base, unit),
              ...(base.params !== undefined ? { params: base.params } : {}),
              cursor: -1,
              status: 'active',
            });
          });
          batch.window(baseKey, base.table, unit);
        });
        changed = true;
        widened = true;
      }

      // Shrink: units live but not wanted → unsubscribe fused with eviction.
      for (const { unit, subId } of live) {
        if (wanted.has(unit)) continue;
        this.#evictUnit(baseKey, base, unit, subId);
        changed = true;
      }
    });
    const effects: CommandEffects = {
      sync: changed || widened ? { kind: 'interactive' } : { kind: 'none' },
    };
    return { value: undefined, effects };
  }

  /**
   * The completeness oracle (§4.8 I3): which units of a base are windowed-in
   * locally, which of those are still bootstrap-pending, and thereby the
   * per-unit verdict a live query renders "may be partial" from. A query
   * whose scope footprint includes an un-windowed OR still-pending unit is
   * NOT answerable in full — the host widens or shows partial, never
   * silently-complete. Registration alone is not completeness: a unit is
   * pending until its subscription completes a bootstrap round (cursor
   * advances past -1 with no resume token held).
   */
  windowState(base: WindowBase): WindowState {
    this.#requireActive();
    const baseKey = windowBaseKey(base);
    const live = loadWindowUnits(this.#db, baseKey);
    const pending: string[] = [];
    for (const { unit, subId } of live) {
      const sub = getSubscription(this.#db, subId);
      if (
        sub === undefined ||
        sub.status !== 'active' ||
        sub.cursor < 0 ||
        sub.bootstrapState !== undefined
      ) {
        pending.push(unit);
      }
    }
    return { units: live.map((u) => u.unit), pending };
  }

  /**
   * §4.8 E1–E4: evict one departing unit, fused with its unsubscription in
   * one transaction. Deletes the unit's rows EXCEPT those pinned by a
   * pending outbox commit (E1); if any pin remains, records a deferred
   * eviction retried on the next outbox drain. Discards the subscription's
   * cursor/resume/effective-echo (E3) and its version state with the rows
   * (E2). Emits the evicted table's invalidation keys (I1). Fail-closed:
   * with no local scope-column mapping, surfaces a configuration error and
   * evicts nothing (§4.8/§3.3).
   */
  #evictUnit(
    baseKey: string,
    base: WindowBase,
    unit: string,
    subId: string,
  ): void {
    const table = this.#table(base.table);
    const sub = getSubscription(this.#db, subId);
    // The rows a unit holds live under its LAST effective scopes if it ever
    // synced; before first sync, the requested unit scopes are the match.
    const effective = sub?.effectiveScopes ?? unitScopes(base, unit);
    const pinned = this.#pinnedRowIds(base.table);
    this.#applyBatch((batch) => {
      this.#db.transaction(() => {
        const deferred = evictScopedRows(this.#db, table, effective, pinned);
        deleteWindowUnit(this.#db, baseKey, unit);
        deleteSubscription(this.#db, subId);
        if (deferred) {
          savePendingEviction(this.#db, subId, base.table, effective);
        } else {
          deletePendingEviction(this.#db, subId);
        }
      });
      batch.scopeMap(table, effective);
      batch.window(baseKey, table.name, unit);
    });
  }

  /**
   * §4.8 E1: retry deferred evictions after the outbox drains. A pinned
   * unit's rows are removed once no pending commit references them; a unit
   * that re-entered the window in the meantime has no pending record left.
   */
  #drainPendingEvictions(): void {
    const pending = loadPendingEvictions(this.#db);
    if (pending.length === 0) return;
    for (const entry of pending) {
      const table = this.#schema.tables.get(entry.table);
      if (table === undefined) {
        deletePendingEviction(this.#db, entry.subId);
        continue;
      }
      const pinned = this.#pinnedRowIds(entry.table);
      this.#applyBatch((batch) => {
        let deferred = false;
        this.#db.transaction(() => {
          deferred = evictScopedRows(this.#db, table, entry.effective, pinned);
          if (!deferred) deletePendingEviction(this.#db, entry.subId);
        });
        batch.scopeMap(table, entry.effective);
      });
    }
  }

  /**
   * §4.8 E1: primary keys of `table` referenced by any still-pending outbox
   * commit — rows that MUST NOT be evicted until the commit drains.
   */
  #pinnedRowIds(table: string): Set<string> {
    const pinned = new Set<string>();
    for (const commit of listOutbox(this.#db)) {
      for (const op of commit.operations) {
        if (op.table === table) pinned.add(op.rowId);
      }
    }
    return pinned;
  }

  // -- local mutations --------------------------------------------------------

  /**
   * Record one atomic local commit (§7.1): appended to the outbox in
   * schema-agnostic form and applied optimistically to the local mirror.
   * Returns the generated `clientCommitId`.
   */
  mutate(mutations: readonly MutationInput[]): string {
    return this.#recordMutations(mutations);
  }

  #recordMutations(
    mutations: readonly MutationInput[],
    changedFieldsByIndex: readonly (readonly string[] | undefined)[] = [],
  ): string {
    this.#requireActive();
    const clientCommitId = crypto.randomUUID();
    const operations: OutboxOperation[] = mutations.map((mutation, index) => {
      const table = this.#table(mutation.table);
      if (mutation.op === 'delete') {
        return {
          table: mutation.table,
          rowId: mutation.rowId,
          op: 'delete',
          ...(mutation.baseVersion !== undefined
            ? { baseVersion: mutation.baseVersion }
            : {}),
        };
      }
      const values = recordToRowValues(table, mutation.values);
      const pkValue = values[table.primaryKeyIndex];
      if (typeof pkValue !== 'string' || pkValue.length === 0) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `table ${table.name}: upsert requires a non-empty string primary key`,
        );
      }
      const json: Record<string, ReturnType<typeof rowValueToJson>> = {};
      table.columns.forEach((column, index) => {
        json[column.name] = rowValueToJson(values[index] ?? null);
      });
      return {
        table: mutation.table,
        rowId: pkValue,
        op: 'upsert',
        ...(mutation.baseVersion !== undefined
          ? { baseVersion: mutation.baseVersion }
          : {}),
        values: json,
        ...(changedFieldsByIndex[index] !== undefined
          ? { changedFields: [...(changedFieldsByIndex[index] ?? [])] }
          : {}),
      };
    });
    this.#applyBatch((batch) => {
      this.#db.transaction(() => {
        appendOutboxCommit(
          this.#db,
          clientCommitId,
          operations,
          this.#now(),
          this.#captureBeforeImages(operations),
        );
        this.#applyOperationsLocally(operations, batch);
        batch.status();
      });
    });
    return clientCommitId;
  }

  /** Host-facing mutation result with explicit network work intent (§7.5). */
  mutateCommand(mutations: readonly MutationInput[]): CommandResult<string> {
    return {
      value: this.mutate(mutations),
      effects: { sync: { kind: 'interactive' } },
    };
  }

  /**
   * Partial-update convenience over the §6.1 full-row wire: read the
   * current LOCAL row, merge `partial` over it, and record one full-row
   * upsert through `mutate()`. `partial` keys follow the same two-casing
   * rule as mutation values (snake_case or camelCase). The row must be
   * locally present (subscribed/windowed-in); patching an absent row is
   * an error — there is no base to merge into.
   */
  patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): string {
    this.#requireActive();
    const compiled = this.#table(table);
    const pkColumn = compiled.columns[compiled.primaryKeyIndex] as RowColumn;
    const rows = this.#db.query(
      `SELECT * FROM ${quoteIdent(compiled.name)} WHERE ${quoteIdent(pkColumn.name)} = ?`,
      [rowId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `table ${compiled.name}: no local row with primary key ${JSON.stringify(rowId)} to patch`,
      );
    }
    const record: Record<string, unknown> = {};
    for (const column of compiled.columns as readonly RowColumn[]) {
      record[column.name] = fromSqlValue(column, row[column.name] ?? null);
    }
    const normalizedPartial = normalizeRecordKeys(compiled, partial);
    for (const [name, value] of normalizedPartial) {
      record[name] = value;
    }
    return this.#recordMutations(
      [
        {
          table,
          op: 'upsert',
          values: record,
          ...(options?.baseVersion !== undefined
            ? { baseVersion: options.baseVersion }
            : {}),
        },
      ],
      [[...normalizedPartial.keys()].sort()],
    );
  }

  /**
   * Apply one host-authorized local security purge. The host must stop/gate
   * protected subscriptions before calling this method; this operation owns
   * local SQLite cleanup only and intentionally cannot revoke server access.
   *
   * Selector columns are validated as bounded plaintext strings. Targets are
   * OR-combined and each target's selectors are AND-combined. `purgeId` is
   * persisted with the canonical plan, making exact retries no-ops while a
   * reused id with different selectors fails closed.
   */
  purgeLocalData(input: LocalDataPurgeInput): LocalDataPurgeResult {
    this.#requireStarted();
    const purge = compileLocalDataPurge(this.#schema, input);
    const metaKey = localDataPurgeMetaKey(purge.purgeId);
    const appliedPlan = getMeta(this.#db, metaKey);
    if (appliedPlan !== undefined) {
      if (appliedPlan !== purge.canonicalPlan) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `local purge id ${JSON.stringify(purge.purgeId)} was already used with a different plan`,
        );
      }
      return { alreadyApplied: true, purgedRows: 0, droppedCommits: 0 };
    }

    const rejectionCount = this.#rejections.length;
    try {
      return this.#applyBatch((batch) => {
        const initialRowIds = this.#localPurgeRowIds(purge);
        const targetsByTable = this.#localPurgeTargetsByTable(purge);
        const doomed = listOutbox(this.#db)
          .filter((commit) => {
            const images = new Map(
              listOutboxBeforeImages(this.#db, commit.clientCommitId).map(
                (image) => [image.opIndex, image],
              ),
            );
            return commit.operations.some((operation, opIndex) => {
              const targets = targetsByTable.get(operation.table);
              if (targets === undefined) return false;
              if (
                initialRowIds.get(operation.table)?.has(operation.rowId) ===
                true
              ) {
                return true;
              }
              if (
                operation.values !== undefined &&
                targets.some((target) =>
                  localDataPurgeTargetMatches(target, operation.values ?? {}),
                )
              ) {
                return true;
              }
              const beforeValues = images.get(opIndex)?.values;
              return (
                beforeValues !== undefined &&
                targets.some((target) =>
                  localDataPurgeTargetMatches(target, beforeValues),
                )
              );
            });
          })
          // Reverse order is essential: each rollback restores its before-image;
          // removing newest-first prevents an older doomed write reappearing.
          .sort((a, b) => b.seq - a.seq);

        for (const commit of doomed) {
          this.#rollbackFailedCommit(commit, batch);
        }

        // Rollback may reveal a target row hidden by an optimistic delete or
        // move, so select the final base/visible set only after doomed commits
        // have been removed.
        const rowIds = this.#localPurgeRowIds(purge);
        let purgedRows = 0;
        for (const [tableName, ids] of rowIds) {
          if (ids.size === 0) continue;
          const table = this.#table(tableName);
          const values = [...ids];
          purgedRows += values.length;
          batch.table(tableName);
          for (let offset = 0; offset < values.length; offset += 400) {
            const chunk = values.slice(offset, offset + 400);
            this.#db.exec(
              `DELETE FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(table.primaryKey)} IN (${chunk.map(() => '?').join(', ')})`,
              chunk,
            );
          }
        }

        if (doomed.length > 0) {
          for (const commit of doomed) {
            const results: CommitOperationOutcome[] = commit.operations.map(
              (operation, opIndex) => {
                const rejection: RejectionRecord = {
                  clientCommitId: commit.clientCommitId,
                  opIndex,
                  code: 'client.local_data_purged',
                  message:
                    'the commit was dropped by an application-authorized local data purge',
                  retryable: false,
                  operation,
                };
                this.#rejections.push(rejection);
                return { status: 'error', rejection };
              },
            );
            recordCommitOutcome(this.#db, {
              clientCommitId: commit.clientCommitId,
              status: 'rejected',
              recordedAtMs: this.#now(),
              results,
              operations: commit.operations,
            });
          }
          pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
          batch.status();
          batch.rejections();
          batch.outcomes();
        }
        this.#reconcileBlobs(true);
        setMeta(this.#db, metaKey, purge.canonicalPlan);
        return {
          alreadyApplied: false,
          purgedRows,
          droppedCommits: doomed.length,
        };
      });
    } catch (error) {
      // SQLite rolls back through #applyBatch; mirror that rollback for the
      // in-memory rejection cache before surfacing the storage failure.
      this.#rejections.length = rejectionCount;
      throw error;
    }
  }

  /**
   * Rebuild the server-derived local projection without sacrificing offline
   * work or device identity. The reset, subscription rewind, durable
   * idempotency marker, and optimistic outbox replay are one SQLite
   * transaction, so an interruption cannot expose a half-repaired replica.
   *
   * This is an application-authorized repair primitive, not a security purge.
   * It is unavailable during security preflight and while a schema-floor stop
   * is active: neither condition can be repaired by redownloading data.
   */
  rebootstrapLocalData(
    input: LocalDataRebootstrapInput,
  ): LocalDataRebootstrapResult {
    this.#requireActive();
    const rebootstrapId = compileLocalDataRebootstrap(input);
    const metaKey = localDataRebootstrapMetaKey(rebootstrapId);
    if (getMeta(this.#db, metaKey) !== undefined) {
      return {
        alreadyApplied: true,
        retainedCommits: 0,
        resetSubscriptions: 0,
      };
    }
    if (this.#schemaFloor !== undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'local rebootstrap cannot bypass an active schema-floor stop; update the application first',
      );
    }

    const pending = listOutbox(this.#db);
    const resetSubscriptions = loadSubscriptions(this.#db).length;
    const priorUpgrading = this.#upgrading;
    const priorNeedsPull = this.#needsPull;
    try {
      this.#applyBatch((batch) => {
        this.#upgrading = true;
        this.#needsPull = true;
        batch.status();
        dropAndRecreateSyncedTables(this.#db, this.#schema);
        resetSubscriptionsForBump(this.#db);
        for (const table of this.#schema.tables.values()) {
          batch.table(table.name);
        }
        for (const commit of pending) {
          this.#applyOperationsLocally(commit.operations, batch);
        }
        setMeta(this.#db, metaKey, 'v1');
      });
    } catch (error) {
      this.#upgrading = priorUpgrading;
      this.#needsPull = priorNeedsPull;
      throw error;
    }

    if (!priorUpgrading) this.#config.onUpgrading?.(true);
    this.#config.onSyncNeeded?.('startup');
    this.#config.onSyncIntent?.({ kind: 'interactive' });
    return {
      alreadyApplied: false,
      retainedCommits: pending.length,
      resetSubscriptions,
    };
  }

  #localPurgeTargetsByTable(
    purge: CompiledLocalDataPurge,
  ): Map<string, CompiledLocalDataPurgeTarget[]> {
    const byTable = new Map<string, CompiledLocalDataPurgeTarget[]>();
    for (const target of purge.targets) {
      const targets = byTable.get(target.table.name) ?? [];
      targets.push(target);
      byTable.set(target.table.name, targets);
    }
    return byTable;
  }

  #localPurgeRowIds(purge: CompiledLocalDataPurge): Map<string, Set<string>> {
    const byTable = new Map<string, Set<string>>();
    for (const target of purge.targets) {
      const ids = byTable.get(target.table.name) ?? new Set<string>();
      const clauses: string[] = [];
      const params: string[] = [];
      for (const selector of target.selectors) {
        clauses.push(
          `${quoteIdent(selector.column)} IN (${selector.values.map(() => '?').join(', ')})`,
        );
        params.push(...selector.values);
      }
      for (const row of this.#db.query(
        `SELECT CAST(${quoteIdent(target.table.primaryKey)} AS TEXT) AS id FROM ${quoteIdent(target.table.name)} WHERE ${clauses.join(' AND ')}`,
        params,
      )) {
        if (typeof row.id === 'string') ids.add(row.id);
      }
      byTable.set(target.table.name, ids);
    }
    return byTable;
  }

  /** Host-facing patch result with explicit network work intent (§7.5). */
  patchCommand(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): CommandResult<string> {
    return {
      value: this.patch(table, rowId, partial, options),
      effects: { sync: { kind: 'interactive' } },
    };
  }

  // -- lease state (§7.3.5) ---------------------------------------------------

  /** Merge and persist the lease state (opaque, §7.3.5). */
  #setLeaseState(next: LeaseState): void {
    this.#applyBatch((batch) => {
      this.#leaseState = next;
      setMeta(this.#db, 'leaseState', JSON.stringify(next));
      batch.status();
    });
  }

  /** The request-level lease error codes (§7.3.4): stop-and-surface. */
  #isLeaseErrorCode(code: string): boolean {
    return (
      code === 'sync.auth_lease_required' || code === 'sync.auth_lease_revoked'
    );
  }

  /**
   * §7.4.4: encode every pending outbox commit with the current codec. A
   * commit that cannot re-encode under the new schema (an
   * `OutboxEncodeError` — a referenced column/table the bump removed) is
   * dropped from the outbox and surfaced as a rejection (`sync.outbox_
   * incompatible`); its purely-optimistic rows are undone (§7.2). Returns
   * the encoded push frames index-aligned with the surviving `outbox`.
   */
  async #encodeOutboxForPush(): Promise<{
    pushFrames: RequestFrame[];
    outbox: OutboxCommit[];
    deferred: number;
  }> {
    const pending = listOutbox(this.#db);
    const pushFrames: RequestFrame[] = [];
    const outbox: OutboxCommit[] = [];
    let deferred = 0;
    let ops = 0;
    for (const commit of pending) {
      // §6.1 splitBatch: whole commits in commit order, stopping before the
      // per-request operation cap. A first commit that alone exceeds the cap
      // is sent alone — the server rejects it loudly rather than the queue
      // wedging silently. Deferred commits stay queued for the next round.
      if (
        outbox.length > 0 &&
        ops + commit.operations.length > MAX_OPS_PER_REQUEST
      ) {
        deferred += 1;
        continue;
      }
      try {
        pushFrames.push(
          // §5.11: encrypted columns are encrypted at this encode-at-send
          // seam before the row codec serializes them.
          await encodeOutboxCommit(this.#schema, commit, this.#encryption),
        );
        outbox.push(commit);
        ops += commit.operations.length;
      } catch (error) {
        if (error instanceof OutboxEncodeError) {
          this.#dropIncompatibleCommit(commit, error.message);
          continue;
        }
        throw error;
      }
    }
    return { pushFrames, outbox, deferred };
  }

  /**
   * §7.4.4: drop a commit that cannot re-encode after a bump, mirroring the
   * §7.2 `rejected` surface — the commit leaves the outbox, its
   * purely-optimistic rows are undone, and a rejection record is raised.
   */
  #dropIncompatibleCommit(commit: OutboxCommit, message: string): void {
    this.#applyBatch((batch) => {
      this.#rollbackFailedCommit(commit, batch);
      const rejection: RejectionRecord = {
        clientCommitId: commit.clientCommitId,
        opIndex: 0,
        code: OUTBOX_INCOMPATIBLE_CODE,
        message,
        retryable: false,
        ...(commit.operations[0] !== undefined
          ? { operation: commit.operations[0] }
          : {}),
      };
      this.#rejections.push(rejection);
      recordCommitOutcome(this.#db, {
        clientCommitId: commit.clientCommitId,
        status: 'rejected',
        recordedAtMs: this.#now(),
        results: [{ status: 'error', rejection }],
        operations: commit.operations,
      });
      pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
      batch.status();
      batch.rejections();
      batch.outcomes();
    });
  }

  // -- sync -------------------------------------------------------------------

  /**
   * One combined push+pull round (§1.5, §7.2). The core owns one loop: a
   * concurrent `sync()` while one is already outstanding is rejected loudly
   * (the app must coalesce its own wake-ups, §8.4) — this check is
   * SYNCHRONOUS so the second caller sees the first still in flight before
   * the op chain would otherwise queue it. The round then runs serialized on
   * the operation chain so it never interleaves with a delta apply or a
   * `setWindow` at an await point.
   */
  sync(): Promise<SyncSummary> {
    this.#requireActive();
    if (this.#syncOutstanding) {
      return Promise.reject(
        new ClientSyncError(
          'sync.invalid_request',
          'sync() is already running — the core owns one loop (coalesce wake-ups)',
        ),
      );
    }
    this.#syncOutstanding = true;
    this.#beginDiagnosticsDeferral();
    const startedAtMs = this.#now();
    return this.#serialize(() => this.#runSync())
      .then(
        (summary) => {
          const completedAtMs = this.#now();
          this.#lastRound = {
            status: 'succeeded',
            startedAtMs,
            completedAtMs,
            durationMs: Math.max(0, completedAtMs - startedAtMs),
            counters: this.#diagnosticRoundCounters(summary),
          };
          this.#emitDiagnostics();
          return summary;
        },
        (error: unknown) => {
          const completedAtMs = this.#now();
          const code = (error as { code?: unknown }).code;
          this.#lastRound = {
            status: 'failed',
            startedAtMs,
            completedAtMs,
            durationMs: Math.max(0, completedAtMs - startedAtMs),
            errorCode:
              typeof code === 'string'
                ? this.#diagnosticCode(code)
                : 'client.unknown_failure',
          };
          this.#emitDiagnostics();
          throw error;
        },
      )
      .finally(() => {
        this.#syncOutstanding = false;
        this.#endDiagnosticsDeferral();
      });
  }

  #diagnosticRoundCounters(summary: SyncSummary): DiagnosticRoundCounters {
    return {
      pushed: summary.pushed,
      applied: summary.applied.length,
      rejected: summary.rejected.length,
      retryable: summary.retryable.length,
      conflicts: summary.conflicts.length,
      commitsApplied: summary.commitsApplied,
      segmentRowsApplied: summary.segmentRowsApplied,
      bootstrapping: summary.bootstrapping.length,
      resets: summary.resets.length,
      revoked: summary.revoked.length,
      failed: summary.failed.length,
      deferredCommits: summary.deferredCommits ?? 0,
    };
  }

  #transportFailureCode(code: string): boolean {
    return (
      code === 'transport.failed' ||
      code === 'transport.unavailable' ||
      code === 'sync.transport_failed' ||
      code === 'client.worker_failed' ||
      code === 'client.worker_restart_required'
    );
  }

  #diagnosticCode(code: string): string {
    return code.length <= 96 && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(code)
      ? code
      : 'client.unknown_failure';
  }

  async #runSync(): Promise<SyncSummary> {
    if (this.#schemaFloor !== undefined) {
      return {
        ...emptySummary(0),
        bootstrapping: [],
        schemaFloor: this.#schemaFloor,
      };
    }
    this.#syncing = true;
    // Cleared before the round, not after: a wake-up (or a delta dropped
    // because this pull is mid-flight) that lands during the round must
    // survive it — the reference server keeps no replay buffer (§8.2).
    this.#setSyncNeeded(false);
    try {
      // §5.9.7 B4: upload pending blobs BEFORE pushing rows that reference
      // them, so the server-side existence check (§6.6) passes.
      if (this.#hasBlobs && this.#config.blobs !== undefined) {
        await this.flushBlobUploads();
      }
      // §7.4.4: encode the outbox with the CURRENT codec; a commit that
      // cannot express itself under the new schema (a dropped column/table)
      // is removed from the push and surfaced as a rejection, never wedging
      // the queue. `pushFrames` and `outbox` stay index-aligned for result
      // mapping.
      const { pushFrames, outbox, deferred } =
        await this.#encodeOutboxForPush();
      const subs = loadSubscriptions(this.#db).filter(
        (sub) => sub.status === 'active',
      );
      const limits = this.#config.limits;
      const frames: RequestFrame[] = [
        {
          type: 'REQ_HEADER',
          clientId: this.#clientId,
          schemaVersion: this.#schema.version,
        },
        ...pushFrames,
        {
          type: 'PULL_HEADER',
          limitCommits: limits?.limitCommits ?? 0,
          limitSnapshotRows: limits?.limitSnapshotRows ?? 0,
          maxSnapshotPages: limits?.maxSnapshotPages ?? 0,
          accept: this.#acceptMask(),
        },
        ...subs.map(
          (sub): RequestFrame => ({
            type: 'SUBSCRIPTION',
            id: sub.id,
            table: sub.table,
            scopes: sub.scopes,
            ...(sub.params !== undefined ? { params: sub.params } : {}),
            cursor: sub.cursor,
            ...(sub.bootstrapState !== undefined
              ? { bootstrapState: sub.bootstrapState }
              : {}),
          }),
        ),
      ];
      const requestBytes = encodeMessage({
        wireVersion: PROTOCOL_WIRE_VERSION,
        msgKind: 'request',
        frames,
      });
      const responseBytes = await this.#roundTrip(requestBytes);
      const message = decodeMessage(responseBytes);
      if (message.msgKind !== 'response') {
        throw new ClientSyncError(
          'sync.invalid_request',
          'transport returned a non-response message',
        );
      }
      const summary = await this.#processResponse(
        message,
        outbox,
        subs,
        'pull',
      );
      // §4.8 E1: the push half may have drained commits that pinned rows of
      // a shrunk window unit — retry any deferred evictions now.
      this.#drainPendingEvictions();
      this.#retryDelayMs = 250;
      if (deferred > 0) {
        // §6.1 splitBatch remainder: more queued commits than this request
        // could carry — keep the sync-needed signal raised for the host.
        this.#setSyncNeeded(true);
        return { ...summary, deferredCommits: deferred };
      }
      return summary;
    } catch (error) {
      // §7.3.5: a request-level lease code stops-and-surfaces — record it
      // in leaseState (no local-data purge, §7.3.4) and re-throw. Not a
      // silent retry: the app drives recovery to a live resolver. The
      // error may arrive as a ClientSyncError or as a transport error
      // carrying the server's `.code` (HTTP-JSON / loopback surface, §1.1).
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && this.#isLeaseErrorCode(code)) {
        this.#setLeaseState({
          ...(this.#leaseState ?? {}),
          errorCode: code,
        });
      }
      const explicitlyRetryable = (error as { retryable?: unknown }).retryable;
      const retryable =
        explicitlyRetryable === true ||
        (explicitlyRetryable === undefined && typeof code !== 'string');
      if (retryable) {
        const intent: SyncIntent = {
          kind: 'background',
          delayMs: this.#retryDelayMs,
        };
        this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, 30_000);
        try {
          this.#config.onSyncIntent?.(intent);
        } catch {
          // An observer cannot alter sync correctness.
        }
      }
      throw error;
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * Pull repeatedly until quiescent: no commits delivered, no bootstrap
   * pages pending, no resets to recover (§4.5 "pull again" SHOULD).
   */
  async syncUntilIdle(maxRounds = 20): Promise<SyncSummary> {
    let last: SyncSummary | undefined;
    for (let round = 0; round < maxRounds; round++) {
      last = await this.sync();
      if (last.schemaFloor !== undefined) return last;
      if (
        last.commitsApplied === 0 &&
        last.segmentRowsApplied === 0 &&
        last.bootstrapping.length === 0 &&
        last.resets.length === 0 &&
        (last.deferredCommits ?? 0) === 0
      ) {
        return last;
      }
    }
    throw new ClientSyncError(
      'sync.invalid_request',
      `sync did not reach idle within ${maxRounds} rounds`,
    );
  }

  /**
   * One request/response round trip (§8.7): over the socket whenever it
   * is connected (Direction decision 1 — the socket IS the sync-round
   * transport, not a fallback pair), otherwise through the configured
   * `SyncTransport` seam (loopback/conformance hosts, HTTP-only
   * producers).
   */
  #roundTrip(request: Uint8Array): Promise<Uint8Array> {
    const socket = this.#socket;
    if (socket === undefined) {
      return Promise.resolve()
        .then(() => this.#config.transport(request))
        .catch((error: unknown) => {
          if (
            error instanceof ClientSyncError ||
            typeof (error as { code?: unknown })?.code === 'string'
          ) {
            throw error;
          }
          throw new ClientSyncError(
            'sync.transport_failed',
            `transport round failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        });
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      // sync() already enforces one round in flight (§8.7).
      this.#pendingRound = {
        scanner: new MessageStreamScanner(),
        resolve,
        reject,
      };
      const tagged = new Uint8Array(request.length + 1);
      tagged[0] = REALTIME_TAG_ROUND;
      tagged.set(request, 1);
      try {
        socket.sendBytes(tagged);
      } catch (error) {
        this.#pendingRound = undefined;
        reject(
          new ClientSyncError(
            'sync.transport_failed',
            `socket round send failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
        );
      }
    });
  }

  /** Abort the in-flight socket round (socket closed or disconnected). */
  #abortPendingRound(reason: string): void {
    const round = this.#pendingRound;
    if (round === undefined) return;
    this.#pendingRound = undefined;
    round.reject(new ClientSyncError('sync.transport_failed', reason, true));
  }

  // -- realtime (§8 client side) ----------------------------------------------

  connectRealtime(): Promise<void> {
    return this.#runProtectedAsync(() => this.#connectRealtime());
  }

  async #connectRealtime(): Promise<void> {
    const connector = this.#config.realtime;
    if (connector === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'no realtime connector configured',
      );
    }
    const socket = await connector({
      onText: (text) => this.#handleRealtimeText(text),
      onBinary: (bytes) => this.#routeRealtimeBinary(bytes),
      onClose: () => {
        this.#socket = undefined;
        this.#presence.clear(); // §8.6.1: presence is per-connection
        this.#abortPendingRound('realtime socket closed mid-round (§8.7)');
        this.#emitDiagnostics();
      },
    });
    if (this.#securityLifecycle === 'preflight') {
      socket.close();
      throw new ClientSyncError(
        SECURITY_PREFLIGHT_REQUIRED_CODE,
        'realtime connected after the client entered security preflight',
      );
    }
    this.#socket = socket;
    this.#emitDiagnostics();
  }

  disconnectRealtime(): void {
    this.#socket?.close();
    this.#socket = undefined;
    this.#presence.clear(); // §8.6.1: presence is per-connection
    this.#abortPendingRound('realtime socket disconnected mid-round (§8.7)');
    this.#emitDiagnostics();
  }

  /**
   * §8.7 channel-tag routing (synchronous, so chunk order is preserved):
   * `0x01` chunks feed the in-flight round's assembler; `0x00` messages
   * are standalone deltas; unknown tags are ignored (forward compat).
   */
  #routeRealtimeBinary(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const tag = bytes[0];
    const body = bytes.subarray(1);
    if (tag === REALTIME_TAG_ROUND) {
      const round = this.#pendingRound;
      if (round === undefined) return; // stale chunk after an abort
      let done: ReturnType<MessageStreamScanner['push']>;
      try {
        done = round.scanner.push(body);
      } catch (error) {
        this.#pendingRound = undefined;
        round.reject(
          new ClientSyncError(
            'sync.invalid_request',
            `malformed round response stream (§8.7): ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (done === undefined) return;
      this.#pendingRound = undefined;
      if (done.excess > 0) {
        round.reject(
          new ClientSyncError(
            'sync.invalid_request',
            'response bytes past END of the round stream (§8.7)',
          ),
        );
        return;
      }
      round.resolve(done.message.slice());
      return;
    }
    if (tag === REALTIME_TAG_DELTA) {
      void this.#handleRealtimeBinary(body);
    }
    // Unknown tag: tolerated and ignored (§8.7 closed registry).
  }

  #handleRealtimeText(text: string): void {
    let parsed: ReturnType<typeof parseRealtimeServerEvent>;
    try {
      parsed = parseRealtimeServerEvent(text);
    } catch {
      return; // §8.1: tolerate garbled/unknown control messages
    }
    if (!parsed.known) return;
    const event = parsed.event;
    if (event.event === 'hello') {
      if (event.data.requiresSync) {
        this.#setSyncNeeded(true);
        this.#config.onSyncNeeded?.('hello');
      }
      return;
    }
    if (event.event === 'sync') {
      // §8.3: any wake-up means "run a pull soon", never data.
      this.#setSyncNeeded(true);
      this.#config.onSyncNeeded?.(event.data.reason);
      return;
    }
    if (event.event === 'presence') {
      this.#applyPresence(event.data);
    }
  }

  /** §8.6 apply an inbound presence fanout to the local map. */
  #applyPresence(data: {
    scopeKey: string;
    kind?: PresenceKind;
    actorId?: string;
    clientId?: string;
    doc?: Record<string, unknown> | null;
    error?: string;
  }): void {
    // The publisher-directed error variant (§8.6.2) surfaces via the
    // sync-needed reason channel is inappropriate; it is an out-of-band
    // presence rejection — record nothing to the peer map, just ignore
    // here (setPresence callers observe it through the callback if wired).
    if (data.error !== undefined || data.kind === undefined) return;
    const { scopeKey, kind, actorId, clientId } = data;
    if (actorId === undefined || clientId === undefined) return;
    const peerKey = `${actorId} ${clientId}`;
    let peers = this.#presence.get(scopeKey);
    if (kind === 'leave') {
      peers?.delete(peerKey);
      if (peers !== undefined && peers.size === 0) {
        this.#presence.delete(scopeKey);
      }
    } else {
      const doc = data.doc;
      if (doc === null || doc === undefined) return;
      if (peers === undefined) {
        peers = new Map();
        this.#presence.set(scopeKey, peers);
      }
      peers.set(peerKey, { actorId, clientId, doc });
    }
    this.#config.onPresence?.(scopeKey);
    for (const listener of this.#presenceListeners) {
      try {
        listener(scopeKey);
      } catch {
        // A UI listener must never break presence application.
      }
    }
  }

  async #handleRealtimeBinary(bytes: Uint8Array): Promise<void> {
    if (this.#syncing) {
      // Fast path: a pull is mid-flight; let it win and recover the gap
      // itself — re-pulling is idempotent, interleaved application is not
      // worth it. (An optimization; the op chain below is the correctness
      // mechanism — it also excludes a delta from racing a `setWindow` or a
      // sync round that started between this check and the apply.)
      this.#setSyncNeeded(true);
      return;
    }
    // Serialize the apply on the operation chain: a delta must never
    // interleave its transactions or share the `#batch` accumulator with a
    // pull round or a `setWindow` at an await point (§8.2).
    await this.#serialize(async () => {
      try {
        const message = decodeMessage(bytes);
        if (message.msgKind !== 'response') return;
        // §8.2: deltas apply like pull responses; ack after apply.
        await this.#processResponse(message, [], undefined, 'delta');
      } catch {
        // A delta that cannot be applied is recovered by a pull (§8.3).
        this.#setSyncNeeded(true);
        this.#config.onSyncNeeded?.('catchup-required');
      }
    });
  }

  #sendAck(cursor: number): void {
    this.#socket?.send(JSON.stringify({ type: 'ack', cursor }));
  }

  /** Ack the highest cursor that is contiguously applied for every sub. */
  #ackAfterPull(): void {
    if (this.#socket === undefined) return;
    const cursors = loadSubscriptions(this.#db)
      .filter(
        (sub) => sub.status === 'active' && sub.bootstrapState === undefined,
      )
      .map((sub) => sub.cursor)
      .filter((cursor) => cursor >= 0);
    if (cursors.length === 0) return;
    this.#sendAck(Math.min(...cursors));
  }

  // -- response processing ------------------------------------------------------

  async #processResponse(
    message: ResponseMessage,
    sentCommits: readonly OutboxCommit[],
    sentSubs: readonly SubscriptionRecord[] | undefined,
    mode: 'pull' | 'delta',
  ): Promise<SyncSummary> {
    const summary = emptySummary(sentCommits.length);
    const commitsById = new Map(
      sentCommits.map((commit) => [commit.clientCommitId, commit]),
    );
    const subsById = new Map(
      (sentSubs ?? loadSubscriptions(this.#db)).map((sub) => [sub.id, sub]),
    );
    const rejectionDetailsByCommit = new Map<
      string,
      ReadonlyMap<number, RejectionDetails>
    >();
    let lastFinalPushResult: PushResultFrame | undefined;
    for (const frame of message.frames) {
      if (frame.type === 'PUSH_RESULT_DETAILS') {
        rejectionDetailsByCommit.set(
          frame.clientCommitId,
          new Map(frame.entries.map((entry) => [entry.opIndex, entry.details])),
        );
      } else if (
        frame.type === 'PUSH_RESULT' &&
        commitsById.has(frame.clientCommitId) &&
        isFinalPushResult(frame)
      ) {
        lastFinalPushResult = frame;
      }
    }

    const header = message.frames[0];
    if (header?.type !== 'RESP_HEADER') {
      throw new ClientSyncError('sync.invalid_request', 'missing RESP_HEADER');
    }
    if (header.requiredSchemaVersion !== undefined) {
      // §1.6 schema floor: nothing else was processed — stop syncing and
      // surface the upgrade requirement. A live-round floor always stops:
      // the generated schema does not match what the server serves (behind,
      // or ahead of a lagging server), and no local reset changes the
      // version this client sends. The §7.4.2 trigger-2 convergence runs
      // when the APP updates (recreating the client with a new generated
      // schema), which fires the boot-time §7.4.1 marker check instead.
      const schemaFloor: SchemaFloor = {
        requiredSchemaVersion: header.requiredSchemaVersion,
        ...(header.latestSchemaVersion !== undefined
          ? { latestSchemaVersion: header.latestSchemaVersion }
          : {}),
      };
      this.#setSchemaFloor(schemaFloor);
      return {
        ...summary,
        bootstrapping: [],
        schemaFloor,
      };
    }

    let section: OpenSection | undefined;
    let errorFrame: ClientSyncError | undefined;
    let deltaCursor = -1;
    let responseOutboxCount: number | undefined;

    // Each durable observer transaction emits its own revisioned batch.
    // Async decrypt/download work happens outside SQLite transactions.
    this.#beginDiagnosticsDeferral();
    try {
      for (const frame of message.frames.slice(1)) {
        switch (frame.type) {
          case 'RESP_HEADER':
            break;
          case 'LEASE':
            // §7.3.5: persist the opaque lease and clear any prior lease
            // error — a fresh lease means the outage/revocation is over.
            this.#setLeaseState({
              leaseId: frame.leaseId,
              expiresAtMs: frame.expiresAtMs,
            });
            break;
          case 'PUSH_RESULT': {
            let outboxCount =
              responseOutboxCount ?? listOutbox(this.#db).length;
            this.#applyBatch(
              (batch) => {
                const drained = this.#handlePushResult(
                  frame,
                  commitsById,
                  summary,
                  batch,
                  rejectionDetailsByCommit.get(frame.clientCommitId),
                  frame === lastFinalPushResult,
                );
                if (drained) outboxCount -= 1;
              },
              () => this.#statusSnapshot(outboxCount),
            );
            responseOutboxCount = outboxCount;
            break;
          }
          case 'PUSH_RESULT_DETAILS':
            // Pre-indexed above so companion ordering remains wire-additive.
            break;
          case 'SUB_START': {
            const sub = subsById.get(frame.id);
            const fresh =
              sub !== undefined &&
              sub.cursor < 0 &&
              sub.bootstrapState === undefined &&
              frame.bootstrap;
            const skip =
              sub === undefined ||
              (mode === 'delta' &&
                (sub.status !== 'active' || sub.bootstrapState !== undefined));
            section = { start: frame, sub, fresh, skip, cleared: false };
            break;
          }
          case 'COMMIT':
            if (section !== undefined && !section.skip) {
              await this.#applyCommit(frame, summary);
            }
            break;
          case 'SEGMENT_INLINE': {
            if (
              section === undefined ||
              section.skip ||
              section.sub === undefined
            ) {
              break;
            }
            const segment = decodeRowsSegment(frame.payload);
            await this.#applySegmentOrFail(
              section,
              summary,
              (table, clearFirst, effective) =>
                applyRowsSegment(
                  this.#db,
                  this.#schema,
                  table,
                  segment,
                  {
                    clearFirst,
                    effective,
                    transaction: (fn) =>
                      this.#applyBatch((batch) => {
                        if (
                          segment.blocks.some((block) => block.length > 0) ||
                          (clearFirst &&
                            this.#scopedRowsExist(table, effective))
                        ) {
                          batch.table(table.name);
                        }
                        return fn();
                      }),
                  },
                  this.#encryption,
                ),
              section.fresh && !section.cleared,
            );
            break;
          }
          case 'SEGMENT_REF': {
            if (
              section === undefined ||
              section.skip ||
              section.sub === undefined
            ) {
              break;
            }
            // §4.2: a descriptor whose mediaType was not advertised is a
            // broken server — fail loud, never skip or guess.
            if (
              frame.mediaType === 'sqlite' &&
              (this.#acceptMask() & ACCEPT_SQLITE) === 0
            ) {
              throw new ClientSyncError(
                'sync.invalid_request',
                'SEGMENT_REF mediaType sqlite was not advertised in accept (§4.2)',
              );
            }
            const bytes = await this.#downloadSegment(frame, section.sub);
            if (frame.mediaType === 'sqlite') {
              // §5.3: images are whole-table — a paged descriptor is
              // invalid, and the image is always its table's first page.
              if (
                frame.rowCursor !== undefined ||
                frame.nextRowCursor !== undefined
              ) {
                throw new ClientSyncError(
                  'sync.invalid_request',
                  'sqlite segments are whole-table: rowCursor/nextRowCursor must be absent (§5.3)',
                );
              }
              await this.#applySegmentOrFail(
                section,
                summary,
                (table, clearFirst, effective) =>
                  applySqliteSegment(
                    this.#db,
                    this.#schema,
                    table,
                    bytes,
                    {
                      table: frame.table,
                      rowCount: frame.rowCount,
                      asOfCommitSeq: frame.asOfCommitSeq,
                      scopeDigest: frame.scopeDigest,
                    },
                    {
                      clearFirst,
                      effective,
                      transaction: (fn) =>
                        this.#applyBatch((batch) => {
                          if (
                            frame.rowCount > 0 ||
                            (clearFirst &&
                              this.#scopedRowsExist(table, effective))
                          ) {
                            batch.table(table.name);
                          }
                          return fn();
                        }),
                    },
                  ),
                section.fresh && !section.cleared,
              );
            } else {
              const segment = decodeRowsSegment(bytes);
              await this.#applySegmentOrFail(
                section,
                summary,
                (table, clearFirst, effective) =>
                  applyRowsSegment(
                    this.#db,
                    this.#schema,
                    table,
                    segment,
                    {
                      clearFirst,
                      effective,
                      transaction: (fn) =>
                        this.#applyBatch((batch) => {
                          if (
                            segment.blocks.some((block) => block.length > 0) ||
                            (clearFirst &&
                              this.#scopedRowsExist(table, effective))
                          ) {
                            batch.table(table.name);
                          }
                          return fn();
                        }),
                    },
                    this.#encryption,
                  ),
                section.fresh &&
                  !section.cleared &&
                  frame.rowCursor === undefined,
              );
            }
            break;
          }
          case 'SUB_END': {
            if (
              section !== undefined &&
              !section.skip &&
              section.sub !== undefined
            ) {
              const applied = this.#finishSection(
                section.sub,
                section.start,
                frame.nextCursor,
                frame.bootstrapState,
                summary,
              );
              if (mode === 'delta' && applied) {
                deltaCursor = Math.max(deltaCursor, frame.nextCursor);
              }
            }
            section = undefined;
            break;
          }
          case 'ERROR':
            // §1.4 rule 5 / §1.6: the request failed; the open
            // subscription's SUB_END values are never persisted.
            errorFrame = new ClientSyncError(
              frame.code,
              frame.message,
              frame.retryable,
            );
            section = undefined;
            break;
          case 'UNKNOWN':
            break; // §1.2 rule 2: skipped, never interpreted
        }
        if (errorFrame !== undefined) break;
      }
    } finally {
      try {
        // §7.1: local reads see outbox state applied optimistically — replay
        // the still-pending commits on top of the freshly applied server state.
        this.#replayOutbox();
        this.#reconcileBlobs(false);
      } finally {
        this.#endDiagnosticsDeferral();
      }
    }

    if (errorFrame !== undefined) throw errorFrame;

    if (mode === 'delta') {
      if (deltaCursor >= 0) this.#sendAck(deltaCursor);
    } else {
      this.#ackAfterPull();
    }

    const bootstrapping = loadSubscriptions(this.#db)
      .filter(
        (sub) => sub.status === 'active' && sub.bootstrapState !== undefined,
      )
      .map((sub) => sub.id);
    // §7.4.5: the reset is over once the first post-reset pull round leaves
    // no subscription mid-bootstrap — the tables are rebuilt and current.
    if (this.#upgrading && mode === 'pull' && bootstrapping.length === 0) {
      this.#setUpgrading(false);
    }
    return { ...summary, bootstrapping };
  }

  #handlePushResult(
    frame: PushResultFrame,
    commitsById: ReadonlyMap<string, OutboxCommit>,
    summary: MutableSummary,
    batch: ChangeAccumulator,
    rejectionDetails: ReadonlyMap<number, RejectionDetails> | undefined,
    pruneOutcomes: boolean,
  ): boolean {
    const commit = commitsById.get(frame.clientCommitId);
    if (commit === undefined) return false;
    if (frame.status === 'applied' || frame.status === 'cached') {
      // §6.3: applied and cached both drain the outbox — cached means
      // "already applied, you may have missed the ack".
      recordCommitOutcome(this.#db, {
        clientCommitId: frame.clientCommitId,
        status: frame.status,
        recordedAtMs: this.#now(),
        results: frame.results.map((result) => ({
          status: 'applied' as const,
          opIndex: result.opIndex,
        })),
      });
      deleteOutboxCommit(this.#db, frame.clientCommitId);
      if (pruneOutcomes) {
        pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
      }
      batch.status();
      batch.outcomes();
      summary.applied.push(frame.clientCommitId);
      return true;
    }
    // rejected
    const cacheMiss = frame.results.some(
      (result) =>
        result.status === 'error' &&
        result.code === 'sync.idempotency_cache_miss' &&
        result.retryable,
    );
    if (cacheMiss) {
      // §6.3: a serving failure, not the commit's outcome — keep the
      // commit queued and retry the identical push later.
      summary.retryable.push(frame.clientCommitId);
      return false;
    }
    const outcomeResults: CommitOperationOutcome[] = [];
    for (const result of frame.results) {
      const operation = commit.operations[result.opIndex];
      if (result.status === 'conflict') {
        const conflict: ConflictRecord = {
          clientCommitId: frame.clientCommitId,
          opIndex: result.opIndex,
          table: operation?.table ?? '',
          rowId: operation?.rowId ?? '',
          code: result.code,
          message: result.message,
          serverVersion: result.serverVersion,
          serverRow: this.#decodeServerRow(operation?.table, result.serverRow),
          ...(operation !== undefined ? { operation } : {}),
        };
        this.#conflicts.push(conflict);
        outcomeResults.push({ status: 'conflict', conflict });
        batch.conflicts();
        summary.conflicts.push(conflict);
        this.#config.onConflict?.(conflict);
      } else if (result.status === 'error') {
        const details = rejectionDetails?.get(result.opIndex);
        const rejection: RejectionRecord = {
          clientCommitId: frame.clientCommitId,
          opIndex: result.opIndex,
          code: result.code,
          message: result.message,
          retryable: result.retryable,
          ...(details !== undefined ? { details } : {}),
          ...(operation !== undefined ? { operation } : {}),
        };
        this.#rejections.push(rejection);
        outcomeResults.push({ status: 'error', rejection });
        batch.rejections();
      } else {
        outcomeResults.push({ status: 'applied', opIndex: result.opIndex });
      }
    }
    recordCommitOutcome(this.#db, {
      clientCommitId: frame.clientCommitId,
      status: outcomeResults.some((result) => result.status === 'conflict')
        ? 'conflict'
        : 'rejected',
      recordedAtMs: this.#now(),
      results: outcomeResults,
      operations: commit.operations,
    });
    if (pruneOutcomes) {
      pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
    }
    batch.outcomes();
    // §7.2: remove the rejected optimistic layer. Before-images restore
    // validator-rejected updates even when the server emitted no new COMMIT;
    // later pending overlays are then replayed with rebased before-images.
    this.#db.transaction(() => {
      this.#rollbackFailedCommit(commit, batch);
    });
    batch.status();
    summary.rejected.push(frame.clientCommitId);
    return true;
  }

  #decodeServerRow(
    tableName: string | undefined,
    payload: Uint8Array,
  ): Record<string, RowValue> {
    if (tableName === undefined) return {};
    const table = this.#schema.tables.get(tableName);
    if (table === undefined) return {};
    const values = decodeRow(table.columns, payload);
    const record: Record<string, RowValue> = {};
    table.columns.forEach((column, index) => {
      record[column.name] = values[index] ?? null;
    });
    return record;
  }

  async #applyCommit(
    frame: CommitFrame,
    summary: MutableSummary,
  ): Promise<void> {
    await applyCommitFrame(
      this.#db,
      this.#schema,
      frame,
      this.#encryption,
      (fn) =>
        this.#applyBatch((batch) => {
          this.#recordCommitChanges(batch, frame);
          return fn();
        }),
    );
    summary.commitsApplied += 1;
  }

  /** Record before + after scope keys while the commit transaction is open. */
  #recordCommitChanges(batch: ChangeAccumulator, frame: CommitFrame): void {
    for (const change of frame.changes) {
      const tableName = frame.tables[change.tableIndex];
      if (tableName === undefined) continue;
      const table = this.#schema.tables.get(tableName);
      if (table === undefined) continue;
      let precise = this.#recordStoredRowScopes(batch, table, change.rowId);
      for (const variable of Object.keys(change.scopes)) {
        if (table.scopePrefixByVariable.has(variable)) precise = true;
      }
      batch.changeScopes(table, change.scopes);
      if (!precise) batch.table(tableName);
    }
  }

  /** Add the currently materialized row's scope keys; returns whether known. */
  #recordStoredRowScopes(
    batch: ChangeAccumulator,
    table: CompiledClientTable,
    rowId: string,
  ): boolean {
    const mappings = [...table.scopeColumnByVariable].filter(([variable]) =>
      table.scopePrefixByVariable.has(variable),
    );
    if (mappings.length === 0) return false;
    const row = this.#db.query(
      `SELECT ${mappings.map(([, column]) => quoteIdent(column)).join(', ')}
         FROM ${quoteIdent(table.name)}
        WHERE ${quoteIdent(table.primaryKey)} = ?`,
      [rowId],
    )[0];
    if (row === undefined) return false;
    let recorded = false;
    for (const [variable, column] of mappings) {
      const value = row[column];
      const prefix = table.scopePrefixByVariable.get(variable);
      if (value != null && prefix !== undefined) {
        batch.scope(table.name, `${prefix}:${String(value)}`);
        recorded = true;
      }
    }
    return recorded;
  }

  /** Whether a fresh-bootstrap clear would remove at least one local row. */
  #scopedRowsExist(table: CompiledClientTable, effective: ScopeMap): boolean {
    const entries = Object.entries(effective);
    if (entries.length === 0) return false;
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [variable, values] of entries) {
      const column = table.scopeColumnByVariable.get(variable);
      if (column === undefined || values.length === 0) return false;
      clauses.push(
        `${quoteIdent(column)} IN (${values.map(() => '?').join(', ')})`,
      );
      params.push(...values);
    }
    return (
      this.#db.query(
        `SELECT 1 FROM ${quoteIdent(table.name)}
          WHERE ${clauses.join(' AND ')} LIMIT 1`,
        params,
      ).length > 0
    );
  }

  /**
   * Apply a segment (rows or sqlite image); a §5.6/§3.3 fail-closed error
   * (no local scope-column mapping) marks the subscription `failed` and
   * stops syncing the table without failing the whole request.
   */
  async #applySegmentOrFail(
    section: OpenSection,
    summary: MutableSummary,
    apply: (
      table: CompiledClientTable,
      clearFirst: boolean,
      effective: ScopeMap,
    ) => number | Promise<number>,
    clearFirst: boolean,
  ): Promise<void> {
    const sub = section.sub;
    if (sub === undefined) return;
    const table = this.#table(sub.table);
    try {
      summary.segmentRowsApplied += await apply(
        table,
        clearFirst,
        section.start.effectiveScopes,
      );
      section.cleared = true;
    } catch (error) {
      if (
        error instanceof ClientSyncError &&
        error.code === 'sync.scope_revoked'
      ) {
        const registered = getWindowUnitBySubId(this.#db, sub.id);
        this.#applyBatch((batch) => {
          saveSubscription(this.#db, {
            id: sub.id,
            table: sub.table,
            scopes: sub.scopes,
            ...(sub.params !== undefined ? { params: sub.params } : {}),
            cursor: sub.cursor,
            ...(sub.effectiveScopes !== undefined
              ? { effectiveScopes: sub.effectiveScopes }
              : {}),
            status: 'failed',
            reasonCode: 'sync.scope_revoked',
          });
          if (registered !== undefined) {
            batch.window(registered.baseKey, sub.table, registered.unit);
          }
        });
        summary.failed.push(sub.id);
        section.skip = true;
        return;
      }
      throw error;
    }
  }

  async #downloadSegment(
    frame: SegmentRefFrame,
    sub: SubscriptionRecord,
  ): Promise<Uint8Array> {
    const downloader = this.#config.segments;
    if (downloader === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'received SEGMENT_REF but no segment downloader is configured',
      );
    }
    let bytes: Uint8Array;
    if (frame.url !== undefined) {
      // §5.4: a url-carrying descriptor MUST be fetched from that URL —
      // no fall-through to the direct endpoint; any failure invalidates
      // the descriptor and re-pulling recovers (§1.4 rule 5 keeps the
      // cursor/resume token unpersisted).
      const fetchUrl = downloader.fetchUrl;
      if (
        fetchUrl === undefined ||
        (this.#acceptMask() & ACCEPT_SIGNED_URLS) === 0
      ) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'SEGMENT_REF carries a url but accept bit 3 was not advertised (§5.4)',
        );
      }
      if (
        frame.urlExpiresAtMs !== undefined &&
        frame.urlExpiresAtMs <= this.#now()
      ) {
        // §5.4: MUST NOT start a fetch at/past expiry.
        throw new ClientSyncError(
          'sync.segment_expired',
          `signed URL for segment ${frame.segmentId} expired before fetch — re-pull mints fresh descriptors (§5.4)`,
          true,
        );
      }
      bytes = await fetchUrl(frame.url);
    } else {
      bytes = await downloader({
        segmentId: frame.segmentId,
        table: frame.table,
        requestedScopesJson: canonicalScopeJson(sub.scopes),
      });
    }
    // §5.1: verify the content address before applying; on mismatch the
    // segment is discarded and the cursor/resume token stay unpersisted,
    // so the next pull re-delivers.
    const hash = await sha256Hex(bytes);
    if (`sha256:${hash}` !== frame.segmentId) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `segment ${frame.segmentId} failed content-address verification (§5.1)`,
        true,
      );
    }
    return bytes;
  }

  /** Returns whether SUB_END state was persisted (section applied). */
  #finishSection(
    sub: SubscriptionRecord,
    start: SubStartFrame,
    nextCursor: number,
    bootstrapState: string | undefined,
    summary: MutableSummary,
  ): boolean {
    if (start.status === 'active') {
      // §1.4 rule 4: durable cursor/resume state persists only at SUB_END;
      // §3.3: the effective-scope echo is persisted for the purge contract.
      // An absent bootstrapState clears any previous resume token (§4.4:
      // absent = bootstrap complete, or not bootstrapping).
      const wasPending = sub.cursor < 0 || sub.bootstrapState !== undefined;
      const completed =
        wasPending && nextCursor >= 0 && bootstrapState === undefined;
      const registered = getWindowUnitBySubId(this.#db, sub.id);
      this.#applyBatch((batch) => {
        saveSubscription(this.#db, {
          id: sub.id,
          table: sub.table,
          scopes: sub.scopes,
          ...(sub.params !== undefined ? { params: sub.params } : {}),
          cursor: nextCursor,
          ...(bootstrapState !== undefined ? { bootstrapState } : {}),
          effectiveScopes: start.effectiveScopes,
          status: 'active',
        });
        if (completed && registered !== undefined) {
          // A zero-row bootstrap is a window-domain transition, not a fake
          // row/table change (SPEC §4.8 / §7.5).
          batch.window(registered.baseKey, sub.table, registered.unit);
        }
      });
      return true;
    }

    if (start.status === 'reset') {
      // §4.6: discard cursor + resume token, keep local rows, re-bootstrap
      // with cursor = -1 on the next pull. Staleness, not a purge.
      const registered = getWindowUnitBySubId(this.#db, sub.id);
      this.#applyBatch((batch) => {
        saveSubscription(this.#db, {
          id: sub.id,
          table: sub.table,
          scopes: sub.scopes,
          ...(sub.params !== undefined ? { params: sub.params } : {}),
          cursor: -1,
          ...(sub.effectiveScopes !== undefined
            ? { effectiveScopes: sub.effectiveScopes }
            : {}),
          status: 'active',
          reasonCode: start.reasonCode,
        });
        if (registered !== undefined) {
          batch.window(registered.baseKey, sub.table, registered.unit);
        }
      });
      summary.resets.push(sub.id);
      return false;
    }

    // revoked (§3.3): purge rows matching the LAST-echoed effective scopes
    // (never the requested map), drop doomed outbox commits, stop pulling.
    const table = this.#table(sub.table);
    const lastEffective = sub.effectiveScopes;
    const registered = getWindowUnitBySubId(this.#db, sub.id);
    let failed = false;
    this.#applyBatch((batch) => {
      if (
        lastEffective !== undefined &&
        Object.keys(lastEffective).length > 0
      ) {
        try {
          deleteScopedRows(this.#db, table, lastEffective);
          batch.scopeMap(table, lastEffective);
          const pendingById = new Map(
            listOutbox(this.#db).map((commit) => [
              commit.clientCommitId,
              commit,
            ]),
          );
          const droppedIds = dropOutboxCommitsInScope(
            this.#db,
            table,
            lastEffective,
          );
          if (droppedIds.length > 0) {
            for (const clientCommitId of droppedIds) {
              const commit = pendingById.get(clientCommitId);
              if (commit === undefined) continue;
              const results: CommitOperationOutcome[] = commit.operations.map(
                (operation, opIndex) => {
                  const rejection: RejectionRecord = {
                    clientCommitId,
                    opIndex,
                    code: 'sync.scope_revoked',
                    message:
                      'the commit was dropped because its effective scope was revoked',
                    retryable: false,
                    operation,
                  };
                  this.#rejections.push(rejection);
                  return { status: 'error', rejection };
                },
              );
              recordCommitOutcome(this.#db, {
                clientCommitId,
                status: 'rejected',
                recordedAtMs: this.#now(),
                results,
                operations: commit.operations,
              });
            }
            pruneCommitOutcomes(this.#db, this.#outcomeRetentionMaxEntries);
            batch.status();
            batch.rejections();
            batch.outcomes();
          }
          this.#reconcileBlobs(true);
        } catch (error) {
          if (
            error instanceof ClientSyncError &&
            error.code === 'sync.scope_revoked'
          ) {
            failed = true;
          } else {
            throw error;
          }
        }
      }
      saveSubscription(this.#db, {
        id: sub.id,
        table: sub.table,
        scopes: sub.scopes,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
        cursor: nextCursor,
        ...(lastEffective !== undefined
          ? { effectiveScopes: lastEffective }
          : {}),
        status: failed ? 'failed' : 'revoked',
        reasonCode: start.reasonCode,
      });
      if (registered !== undefined) {
        batch.window(registered.baseKey, sub.table, registered.unit);
      }
    });
    summary.revoked.push(sub.id);
    if (failed) summary.failed.push(sub.id);
    return false;
  }

  // -- optimistic state ----------------------------------------------------------

  #captureBeforeImage(
    operation: OutboxOperation,
    opIndex: number,
  ): OutboxBeforeImage {
    const table = this.#schema.tables.get(operation.table);
    if (table === undefined) return { opIndex, existed: false };
    const columns = [
      ...table.columns.map((column) => quoteIdent(column.name)),
      quoteIdent(SYNC_VERSION_COLUMN),
    ];
    const row = this.#db.query(
      `SELECT ${columns.join(', ')} FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
      [operation.rowId],
    )[0];
    if (row === undefined) return { opIndex, existed: false };
    const values: Record<string, ReturnType<typeof rowValueToJson>> = {};
    for (const column of table.columns) {
      values[column.name] = rowValueToJson(
        fromSqlValue(column, row[column.name] ?? null),
      );
    }
    const syncVersion = row[SYNC_VERSION_COLUMN];
    if (typeof syncVersion !== 'number') {
      throw new ClientSyncError(
        'sync.local_corrupt',
        `local row ${operation.table}/${operation.rowId} has no sync version`,
      );
    }
    return { opIndex, existed: true, syncVersion, values };
  }

  #captureBeforeImages(
    operations: readonly OutboxOperation[],
    onlyKeys?: ReadonlySet<string>,
  ): OutboxBeforeImage[] {
    return operations.flatMap((operation, opIndex) =>
      onlyKeys && !onlyKeys.has(`${operation.table}\u0000${operation.rowId}`)
        ? []
        : [this.#captureBeforeImage(operation, opIndex)],
    );
  }

  #restoreBeforeImage(
    operation: OutboxOperation,
    image: OutboxBeforeImage,
    batch: ChangeAccumulator,
  ): void {
    const table = this.#schema.tables.get(operation.table);
    if (table === undefined) return;
    batch.table(table.name);
    if (!image.existed) {
      deleteLocalRow(this.#db, table, operation.rowId);
      return;
    }
    if (image.values === undefined || image.syncVersion === undefined) {
      throw new ClientSyncError(
        'sync.local_corrupt',
        `rollback image for ${operation.table}/${operation.rowId} is incomplete`,
      );
    }
    const values = table.columns.map((column) =>
      jsonToRowValue(image.values?.[column.name] ?? null),
    );
    upsertLocalRow(this.#db, table, values, image.syncVersion);
  }

  #legacyUndoOptimisticRows(
    commit: OutboxCommit,
    batch: ChangeAccumulator,
  ): void {
    for (const operation of commit.operations) {
      if (operation.op !== 'upsert') continue;
      const table = this.#schema.tables.get(operation.table);
      if (table === undefined) continue;
      const row = this.#db.query(
        `SELECT ${quoteIdent(SYNC_VERSION_COLUMN)} AS v FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
        [operation.rowId],
      )[0];
      if (row !== undefined && row.v === OPTIMISTIC_VERSION) {
        batch.table(table.name);
        deleteLocalRow(this.#db, table, operation.rowId);
      }
    }
  }

  #rollbackFailedCommit(commit: OutboxCommit, batch: ChangeAccumulator): void {
    const images = listOutboxBeforeImages(this.#db, commit.clientCommitId);
    const imageByIndex = new Map(images.map((image) => [image.opIndex, image]));
    const complete = commit.operations.every((_, index) =>
      imageByIndex.has(index),
    );
    const affectedKeys = new Set(
      commit.operations.map(
        (operation) => `${operation.table}\u0000${operation.rowId}`,
      ),
    );
    if (complete) {
      const restored = new Set<string>();
      commit.operations.forEach((operation, index) => {
        const key = `${operation.table}\u0000${operation.rowId}`;
        if (restored.has(key)) return;
        const image = imageByIndex.get(index);
        if (image) this.#restoreBeforeImage(operation, image, batch);
        restored.add(key);
      });
    } else {
      // Pending commits written by older clients have no before-images.
      // Preserve the old fail-closed behavior rather than guessing a base.
      this.#legacyUndoOptimisticRows(commit, batch);
    }
    deleteOutboxCommit(this.#db, commit.clientCommitId);

    if (!complete) return;
    for (const later of listOutbox(this.#db)) {
      if (later.seq <= commit.seq) continue;
      const affectedOperations = later.operations.filter((operation) =>
        affectedKeys.has(`${operation.table}\u0000${operation.rowId}`),
      );
      if (affectedOperations.length === 0) continue;
      replaceOutboxBeforeImages(
        this.#db,
        later.clientCommitId,
        this.#captureBeforeImages(later.operations, affectedKeys),
      );
      this.#applyOperationsLocally(affectedOperations, batch);
    }
  }

  #applyOperationsLocally(
    operations: readonly OutboxOperation[],
    batch?: ChangeAccumulator,
  ): void {
    for (const op of operations) {
      const table = this.#table(op.table);
      let precise =
        batch === undefined
          ? false
          : this.#recordStoredRowScopes(batch, table, op.rowId);
      if (op.op === 'delete') {
        if (batch !== undefined && !precise) batch.table(op.table);
        deleteLocalRow(this.#db, table, op.rowId);
        continue;
      }
      const values = table.columns.map((column) => {
        const value = op.values?.[column.name];
        return value === undefined ? null : jsonToRowValue(value);
      });
      // Record the row's scope keys from its scope columns (I2 refinement).
      if (batch !== undefined) {
        for (const [variable, column] of table.scopeColumnByVariable) {
          const idx = table.columnIndex.get(column);
          const cell = idx === undefined ? undefined : values[idx];
          const prefix = table.scopePrefixByVariable.get(variable);
          if (prefix !== undefined && cell != null) {
            batch.scope(table.name, `${prefix}:${String(cell)}`);
            precise = true;
          }
        }
        if (!precise) batch.table(table.name);
      }
      const existing = this.#db.query(
        `SELECT ${quoteIdent(SYNC_VERSION_COLUMN)} AS v FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
        [op.rowId],
      )[0];
      const version =
        existing === undefined ? OPTIMISTIC_VERSION : (existing.v as number);
      upsertLocalRow(this.#db, table, values, version);
    }
  }

  /** Re-apply every pending outbox commit on top of server state (§7.1). */
  #replayOutbox(): void {
    const pending = listOutbox(this.#db);
    if (pending.length === 0) return;
    this.#applyBatch((batch) => {
      this.#db.transaction(() => {
        for (const commit of pending) {
          this.#applyOperationsLocally(commit.operations, batch);
        }
      });
    });
  }

  /**
   * §5.9.7 B1/B2: recompute blob-cache refcounts from live `blob_ref`
   * columns. No-op unless the schema has blob columns. `deleteOrphans`
   * triggers the revocation-side body deletion (B2).
   */
  #reconcileBlobs(deleteOrphans: boolean): void {
    if (!this.#hasBlobs) return;
    reconcileBlobRefcounts(this.#db, this.#schema, { deleteOrphans });
  }

  // -- helpers -----------------------------------------------------------------

  #table(name: string): CompiledClientTable {
    const table = this.#schema.tables.get(name);
    if (table === undefined) {
      throw new ClientSyncError(
        'sync.unknown_table',
        `unknown local table ${JSON.stringify(name)}`,
      );
    }
    return table;
  }

  #requireStarted(): void {
    if (!this.#started) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'SyncClient.start() has not completed',
      );
    }
  }

  #requireActive(): void {
    this.#requireStarted();
    if (this.#securityLifecycle === 'preflight') {
      throw new ClientSyncError(
        SECURITY_PREFLIGHT_REQUIRED_CODE,
        'the local replica is in security preflight; complete quarantine checks and call activateSecurity before accessing protected data',
      );
    }
  }
}
