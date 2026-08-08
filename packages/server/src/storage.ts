/**
 * Storage interface (defined by the SPEC's needs, implementation-agnostic).
 *
 * Requirements it encodes:
 * - commit log with per-partition `commitSeq` (§2.1) and a commit→scope
 *   inverted index (§3.1): pulls filter
 *   by scope via the index, never by scanning the log;
 * - idempotency results per §2.3 persisted in the same transaction as the
 *   commit's writes (§6.4);
 * - the pruning horizon per §4.6;
 * - current-row reads for write authorization (§3.4) and conflict handling
 *   (§6.2);
 * - per-(partition, clientId) cursor records + last subscription list
 *   (§4.5, §8.1).
 *
 * The interface is async throughout so a Postgres implementation slots in
 * without touching the core. All methods are partition-local (§2.1).
 */
import type { PushOperationResult, RowValue, ScopeMap } from '@syncular/core';
import type { CompiledSchema } from './schema';

/** The current stored state of a synced row. */
export interface StoredRow {
  readonly rowId: string;
  /** `server_version` (§2.2): starts at 1, +1 per applied upsert. */
  readonly serverVersion: number;
  /** Stored scopes (§3.1): variable → single value. */
  readonly scopes: Record<string, string>;
  /** Row-codec payload (§2.4) for the server's schema version. */
  readonly payload: Uint8Array;
}

export interface NewChange {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
  /** Present for upsert (§2.2). */
  readonly rowVersion?: number;
  readonly scopes: Record<string, string>;
  /** Present for upsert. */
  readonly payload?: Uint8Array;
}

export interface NewCommit {
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly actorId: string;
  readonly createdAtMs: number;
  readonly changes: readonly NewChange[];
}

export interface StoredChange {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
  readonly rowVersion?: number;
  readonly scopes: Record<string, string>;
  readonly payload?: Uint8Array;
}

export interface StoredCommit {
  readonly commitSeq: number;
  readonly createdAtMs: number;
  readonly actorId: string;
  readonly changes: readonly StoredChange[];
}

/** JSON values accepted by the durable reaction payload/failure store. */
export type DurableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DurableJsonValue[]
  | { readonly [key: string]: DurableJsonValue };

export type ReactionStatus = 'pending' | 'leased' | 'completed' | 'dead-letter';

export interface ReactionFailure {
  /** Stable application or Syncular error identity. */
  readonly code: string;
  readonly atMs: number;
  /** Bounded JSON metadata. Diagnostic exception text is never persisted. */
  readonly details?: { readonly [key: string]: DurableJsonValue };
}

/** A validated reaction row written with its source commit. */
export interface NewReaction {
  readonly idempotencyKey: string;
  readonly type: string;
  readonly version: number;
  readonly payload: DurableJsonValue;
  readonly sourceClientId: string;
  readonly sourceClientCommitId: string;
  readonly sourceCommitSeq: number;
  readonly createdAtMs: number;
  readonly maxAttempts: number;
}

/** Durable reaction state returned to workers and administrative readers. */
export interface StoredReaction extends NewReaction {
  readonly status: ReactionStatus;
  /** Incremented atomically when a worker claims the reaction. */
  readonly attempts: number;
  readonly availableAtMs: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAtMs?: number;
  readonly completedAtMs?: number;
  readonly lastFailure?: ReactionFailure;
}

export interface ReactionClaimQuery {
  /** Opaque token unique to this claim operation. */
  readonly leaseOwner: string;
  readonly types: readonly string[];
  readonly nowMs: number;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export interface ReactionListQuery {
  readonly statuses?: readonly ReactionStatus[];
  readonly types?: readonly string[];
  readonly limit: number;
}

export interface ReactionFailureUpdate {
  readonly leaseOwner: string;
  readonly failure: ReactionFailure;
  /** Present for retry; absent moves the row to the dead-letter state. */
  readonly retryAtMs?: number;
}

export interface ReactionPruneQuery {
  readonly completedBeforeMs: number;
  readonly deadLetterBeforeMs: number;
  readonly limit: number;
}

export interface PrunedReactionCounts {
  readonly completed: number;
  readonly deadLetter: number;
}

/** Persisted push outcome for idempotent replay (§2.3, §6.3). */
export interface StoredPushResult {
  readonly status: 'applied' | 'rejected';
  /** Present iff `status` is `applied`. */
  readonly commitSeq?: number;
  /** Host clock when this terminal idempotency outcome was first recorded. */
  readonly recordedAtMs?: number;
  /** Privacy-safe identity used to distinguish this stored outcome from a race. */
  readonly cacheIdentity?: string;
  readonly results: readonly PushOperationResult[];
}

export interface ClientSubscription {
  readonly id: string;
  readonly table: string;
  /** Requested scopes of the client's most recent pull (§8.1). */
  readonly scopes: ScopeMap;
}

export interface ClientRecord {
  readonly clientId: string;
  readonly actorId: string;
  /** SSP2 version last accepted from this client; selects realtime deltas. */
  readonly wireVersion: number;
  /** Minimum `nextCursor` across the last pull's active subscriptions. */
  readonly cursor: number;
  readonly updatedAtMs: number;
  readonly subscriptions: readonly ClientSubscription[];
}

export interface CommitWindowQuery {
  readonly table: string;
  /**
   * Effective scopes (§3.2): a change matches iff, for every key, its
   * stored value is in the list. Implementations MUST select candidates
   * via the inverted scope index, never by scanning the log.
   */
  readonly scopeFilter: ScopeMap;
  /** Window `afterSeq < commitSeq <= throughSeq`, oldest first (§4.5). */
  readonly afterSeq: number;
  readonly throughSeq: number;
  /** Stop after accumulating at least this many matching changes. */
  readonly limitChanges: number;
}

export interface RowScanQuery {
  readonly table: string;
  /** Same matching rule as `CommitWindowQuery.scopeFilter`, over rows. */
  readonly scopeFilter: ScopeMap;
  /** Resume after this rowId (exclusive); `null` = start of table. */
  readonly afterRowId: string | null;
  readonly limit: number;
}

/**
 * Exact server-host lookup through one declared relational index.
 *
 * This is deliberately NOT a Syncular scope or client query. It is available
 * only to trusted server code that already owns a `ServerStorage` or
 * `StorageTransaction` capability. Every declared index column must have one
 * exact value, so adapters can keep the lookup bounded and deterministic.
 */
export interface IndexRowScanQuery {
  readonly table: string;
  /** `TableSchema.indexes[].name`; never exposed as a client subscription. */
  readonly index: string;
  /** Exact values in the index declaration's column order. */
  readonly values: readonly RowValue[];
  /** Resume after this rowId (exclusive); `null` = start of the match set. */
  readonly afterRowId?: string | null;
  /** Integer from 1 through 1,000. */
  readonly limit: number;
}

export interface ClientCursorInfo {
  readonly clientId: string;
  readonly cursor: number;
  readonly updatedAtMs: number;
}

/** Durable partition identity refreshed after host authentication (§2.1). */
export interface PartitionRegistryEntry {
  readonly partition: string;
  readonly logEpoch: string;
  readonly epochRequired: boolean;
  readonly lastAuthenticatedAtMs: number;
}

/**
 * Commit-log metadata (no change payloads) for the admin/console read
 * surface. `changeCount` is the number of changes the commit carries;
 * `tables` is the distinct set of tables it touched, cheap to derive from
 * the change index.
 */
export interface CommitMetadata {
  readonly commitSeq: number;
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly actorId: string;
  readonly createdAtMs: number;
  readonly changeCount: number;
  readonly tables: readonly string[];
}

export interface CommitMetadataQuery {
  /** Window `afterSeq < commitSeq`, oldest first. */
  readonly afterSeq: number;
  readonly limit: number;
  /** Restrict to commits that touched this table (via the change index). */
  readonly table?: string;
}

/** One recent commit touching a scope key, for the admin scope activity view. */
export interface ScopeCommitActivity {
  readonly commitSeq: number;
  readonly table: string;
  readonly createdAtMs: number;
  readonly actorId: string;
  readonly changeCount: number;
}

export interface ScopeActivityQuery {
  /** The scope key as `variable + ':' + value` (§3.1) — e.g. `project:p1`. */
  readonly variable: string;
  readonly value: string;
  readonly limit: number;
}

/** A registered SELECT executed against the authoritative row projection. */
export type AuthoritativeQueryValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | null;

export interface AuthoritativeQueryRequest {
  /** Generated, positional SQLite-family SQL. It never comes from the request. */
  readonly sql: string;
  readonly params: readonly AuthoritativeQueryValue[];
  /** Generated dependency set, used to validate and partition every relation. */
  readonly tables: readonly string[];
}

/** One transactionally consistent authoritative query snapshot. */
export interface AuthoritativeQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly maxCommitSeq: number;
}

/**
 * One transaction per push commit (§6.4): all row writes, the appended
 * commit (with its scope-index entries), and the idempotency record either
 * land together or not at all.
 */
export interface StorageTransaction {
  getRow(table: string, rowId: string): Promise<StoredRow | undefined>;
  /**
   * Optional transaction-scoped idempotency lookup (§2.3) with the same
   * semantics as `ServerStorage.getPushResult`, including the
   * `sync.idempotency_cache_miss` throw. The push layer prefers it for the
   * post-serialization duplicate re-check so the read runs on the
   * transaction's own connection — a pooled Postgres client that holds the
   * partition lock must never wait for a second pool slot mid-push. In-tree
   * SQLite/Postgres/D1 adapters implement it; a custom adapter that omits it
   * keeps the pool-level read.
   */
  getPushResult?(
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined>;
  /**
   * Optional candidate-state scan used only by whole-commit validation.
   * In-tree SQLite/Postgres/D1 backends implement it with read-your-own-writes
   * semantics. A custom backend may omit it until `commitValidator` is used.
   */
  scanRows?(query: RowScanQuery): Promise<StoredRow[]>;
  /**
   * Optional additive capability for trusted authoritative commands. In-tree
   * SQLite/PostgreSQL/D1 adapters implement it with transaction-local
   * read-your-own-writes semantics. It is not reachable from SSP2 requests.
   */
  scanRowsByIndex?(query: IndexRowScanQuery): Promise<StoredRow[]>;
  /**
   * Serialize every push apply for this partition before any operation read,
   * validation, merge, or write. The push layer re-checks idempotency only
   * after this resolves and retains the lock through terminal-result commit.
   * Missing support fails closed before an app-row mutation.
   */
  lockPartitionForPush?(): Promise<void>;
  /**
   * @deprecated Implement `lockPartitionForPush`. Kept as a compatibility
   * bridge for custom adapters whose existing implementation already locks
   * the complete partition from before candidate reads through commit.
   */
  lockPartitionForCommitValidation?(): Promise<void>;
  /**
   * Rejection finalization while the push-apply serialization lock is still
   * held: discard every candidate write, persist the rejected idempotency
   * result, and finish the transaction atomically. Required for every push so
   * a concurrent duplicate cannot rerun operations, validators, or merges.
   */
  commitRejectedPushResult?(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void>;
  upsertRow(
    table: string,
    row: StoredRow,
    context?: { readonly opIndex: number },
  ): Promise<void>;
  deleteRow(table: string, rowId: string): Promise<void>;
  /** Allocates the next per-partition commitSeq and appends the commit. */
  appendCommit(commit: NewCommit): Promise<number>;
  /**
   * Persist reaction rows in this authoritative transaction. Required when
   * the host configures a reaction planner. Reactions survive commit-log
   * pruning because they live outside the commit/change tables.
   */
  enqueueReactions?(reactions: readonly NewReaction[]): Promise<void>;
  /**
   * Persist an idempotency outcome only when the key is still absent. The
   * first writer wins; callers read the canonical value after commit.
   */
  putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void>;
  /**
   * Blob reference index (§5.9.4) — ADDITIVE, optional. Set the blobIds a
   * row currently references (empty = clear), replacing any prior entries
   * for (table, rowId), inside the same commit transaction (§6.4). A
   * storage backend that omits this does not support blobs; the push layer
   * only calls it for tables with `blob_ref` columns.
   */
  setBlobRefs?(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ServerStorage {
  /**
   * Create/migrate the relational per-app row tables for `schema`
   * Idempotent and cheap when the
   * stored schema version already matches (one marker read, memoized per
   * instance); on first use it creates the tables, on a version bump it
   * applies the migration subset (CREATE TABLE / ADD COLUMN / CREATE
   * INDEX). The handler calls this before serving; hosts that drive
   * storage directly (tests, admin tooling) call it once up front. Row
   * operations for tables not covered by an `ensureSchema` call throw.
   *
   * This low-level storage seam accepts a `CompiledSchema`. Application hosts
   * should call `ensureSyncServerReady(config)` with their generated schema
   * before binding a public port; protocol handlers still call this method
   * lazily as a defensive backstop.
   */
  ensureSchema(schema: CompiledSchema): Promise<void>;

  /** Create or refresh the authenticated partition registry row (§2.1). */
  touchPartition(
    partition: string,
    authenticatedAtMs: number,
    initialLogEpoch: string,
  ): Promise<PartitionRegistryEntry>;
  /** Rotate log continuity after restore and discard stale cursor records. */
  rotatePartitionLogEpoch(
    partition: string,
    logEpoch: string,
    authenticatedAtMs: number,
  ): Promise<PartitionRegistryEntry>;
  /** Registry entries ordered by partition for maintenance loops. */
  listPartitionRegistry(): Promise<PartitionRegistryEntry[]>;

  begin(partition: string): Promise<StorageTransaction>;

  getMaxCommitSeq(partition: string): Promise<number>;
  getHorizonSeq(partition: string): Promise<number>;
  setHorizonSeq(partition: string, seq: number): Promise<void>;
  /**
   * Deletes commits with `commitSeq <= seq` (log, changes, scope index).
   * Returns the number of commits removed (ops observability).
   */
  pruneCommitsThrough(partition: string, seq: number): Promise<number>;
  /** Newest commitSeq created strictly before the timestamp; 0 if none. */
  getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number>;

  getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined>;

  /**
   * Idempotency lookup (§2.3). Throws `SyncError sync.idempotency_cache_miss`
   * when a persisted result exists but cannot be read (§6.3).
   */
  getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined>;

  /**
   * Atomically lease due or expired-lease reactions for one worker. Optional
   * for compatibility with custom storages; reaction runners fail closed when
   * any lifecycle method is absent.
   */
  claimReactions?(
    partition: string,
    query: ReactionClaimQuery,
  ): Promise<StoredReaction[]>;
  /** Acknowledge only while `leaseOwner` still owns the lease. */
  completeReaction?(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    completedAtMs: number,
  ): Promise<boolean>;
  /** Extend only while `leaseOwner` still owns the active lease. */
  extendReactionLease?(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean>;
  /** Retry or dead-letter only while `leaseOwner` still owns the lease. */
  failReaction?(
    partition: string,
    idempotencyKey: string,
    update: ReactionFailureUpdate,
  ): Promise<boolean>;
  /** Reset a dead-lettered row for an explicit operator retry. */
  retryReaction?(
    partition: string,
    idempotencyKey: string,
    nowMs: number,
  ): Promise<boolean>;
  getReaction?(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction | undefined>;
  listReactions?(
    partition: string,
    query: ReactionListQuery,
  ): Promise<StoredReaction[]>;
  /** Delete a bounded set of aged terminal rows. Never deletes active work. */
  pruneReactions?(
    partition: string,
    query: ReactionPruneQuery,
  ): Promise<PrunedReactionCounts>;

  /**
   * Matching commits in the window, oldest first, each carrying only its
   * matching changes for `table`. Stops once accumulated matching changes
   * reach `limitChanges` or the window is exhausted.
   */
  readCommitWindow(
    partition: string,
    query: CommitWindowQuery,
  ): Promise<StoredCommit[]>;

  /** Scope-filtered snapshot scan, ordered by rowId (bootstrap paging). */
  scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]>;

  /**
   * Optional registered-query capability. The implementation MUST replace
   * every generated app-table relation with a partition-filtered relation and
   * return rows plus maxCommitSeq from one consistent database snapshot.
   */
  queryAuthoritative?(
    partition: string,
    query: AuthoritativeQueryRequest,
  ): Promise<AuthoritativeQueryResult>;

  /**
   * Optional trusted-host exact lookup through a declared relational index.
   * This capability is outside client scope/subscription authorization and
   * MUST NOT be re-exported as a client-controlled endpoint.
   */
  scanRowsByIndex?(
    partition: string,
    query: IndexRowScanQuery,
  ): Promise<StoredRow[]>;

  getClientRecord(
    partition: string,
    clientId: string,
  ): Promise<ClientRecord | undefined>;
  putClientRecord(partition: string, record: ClientRecord): Promise<void>;
  /** Cursor records feeding the §4.6 retention watermark. */
  listClientCursors(partition: string): Promise<ClientCursorInfo[]>;

  /**
   * Blob reference index reads (§5.9.4) — ADDITIVE, optional (mirrors the
   * optional `StorageTransaction.setBlobRefs`).
   *
   * `listRowsReferencingBlob`: the (table, rowId) rows that reference the
   * blob — the download authorization candidate set (§5.9.5). Each result
   * carries the row's stored scopes so the caller runs the §3.4 scope test
   * without a second read.
   *
   * `listReferencedBlobIds`: every blobId a live row currently references —
   * the orphan sweep's keep-set (§5.9.2).
   */
  listRowsReferencingBlob?(
    partition: string,
    blobId: string,
  ): Promise<BlobReferencingRow[]>;
  listReferencedBlobIds?(partition: string): Promise<string[]>;

  /**
   * Admin/console read surface (`SyncularAdmin`): ADDITIVE,
   * optional. All read-only, partition-scoped, and JSON-able. A backend
   * that omits these simply cannot serve the console; the sync path never
   * calls them.
   *
   * `listClientRecords`: every stored client record for the partition
   * (cursor, last-seen, subscription list) — the "who's connected" view.
   * `listCommitMetadata`: the commit log without payloads (metadata +
   * touched tables), the newest-oriented window an operator inspects.
   * `scopeActivity`: the recent commits touching one scope key, via the
   * change scope index (never a log scan).
   * `getRowScopes`: the (table, rowId) row's current server_version and
   * stored scopes without decoding its payload — the row inspector.
   * `listPartitions`: the partition-only compatibility view of
   * `listPartitionRegistry`, sorted.
   */
  listClientRecords?(partition: string): Promise<ClientRecord[]>;
  listCommitMetadata?(
    partition: string,
    query: CommitMetadataQuery,
  ): Promise<CommitMetadata[]>;
  scopeActivity?(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]>;
  getRowScopes?(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<
    { serverVersion: number; scopes: Record<string, string> } | undefined
  >;
  listPartitions(): Promise<string[]>;
}

/** A row referencing a blob, with the scopes needed to authorize download. */
export interface BlobReferencingRow {
  readonly table: string;
  readonly rowId: string;
  readonly scopes: Record<string, string>;
}
