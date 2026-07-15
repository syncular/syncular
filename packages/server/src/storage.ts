/**
 * Storage interface (defined by the SPEC's needs, implementation-agnostic).
 *
 * Requirements it encodes:
 * - commit log with per-partition `commitSeq` (§2.1) and a commit→scope
 *   inverted index designed in from day one (§3.1, REVISE B2): pulls filter
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
import type { PushOperationResult, ScopeMap } from '@syncular/core';
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

/** Persisted push outcome for idempotent replay (§2.3, §6.3). */
export interface StoredPushResult {
  readonly status: 'applied' | 'rejected';
  /** Present iff `status` is `applied`. */
  readonly commitSeq?: number;
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

export interface ClientCursorInfo {
  readonly clientId: string;
  readonly cursor: number;
  readonly updatedAtMs: number;
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

/**
 * One transaction per push commit (§6.4): all row writes, the appended
 * commit (with its scope-index entries), and the idempotency record either
 * land together or not at all.
 */
export interface StorageTransaction {
  getRow(table: string, rowId: string): Promise<StoredRow | undefined>;
  /**
   * Optional candidate-state scan used only by whole-commit validation.
   * In-tree SQLite/Postgres/D1 backends implement it with read-your-own-writes
   * semantics. A custom backend may omit it until `commitValidator` is used.
   */
  scanRows?(query: RowScanQuery): Promise<StoredRow[]>;
  /**
   * Serialize candidate-state validation for this partition before any row
   * read/write. Required at runtime when `commitValidator` is configured.
   */
  lockPartitionForCommitValidation?(): Promise<void>;
  /**
   * §6.8 rejection finalization while the validation serialization lock is
   * still held: discard every candidate write, persist the rejected
   * idempotency result, and finish the transaction atomically. Required when
   * `commitValidator` is configured so a concurrent duplicate cannot rerun it.
   */
  commitRejectedPushResult?(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void>;
  upsertRow(table: string, row: StoredRow): Promise<void>;
  deleteRow(table: string, rowId: string): Promise<void>;
  /** Allocates the next per-partition commitSeq and appends the commit. */
  appendCommit(commit: NewCommit): Promise<number>;
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
   * (DESIGN-relational-server-storage.md). Idempotent and cheap when the
   * stored schema version already matches (one marker read, memoized per
   * instance); on first use it creates the tables, on a version bump it
   * applies the migration subset (CREATE TABLE / ADD COLUMN / CREATE
   * INDEX). The handler calls this before serving; hosts that drive
   * storage directly (tests, admin tooling) call it once up front. Row
   * operations for tables not covered by an `ensureSchema` call throw.
   */
  ensureSchema(schema: CompiledSchema): Promise<void>;

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
   * Admin/console read surface (`SyncularAdmin`, TODO §2.5) — ADDITIVE,
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
   * `listPartitions`: every partition this storage holds state for — the
   * union of the partition registry (commit log counters) and client
   * records, sorted. Powers the console's fleet view / partition picker;
   * deliberately NOT partition-scoped (the one cross-partition read).
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
  listPartitions?(): Promise<string[]>;
}

/** A row referencing a blob, with the scopes needed to authorize download. */
export interface BlobReferencingRow {
  readonly table: string;
  readonly rowId: string;
  readonly scopes: Record<string, string>;
}
