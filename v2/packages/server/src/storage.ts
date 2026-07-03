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
import type { PushOperationResult, ScopeMap } from '@syncular-v2/core';

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
 * One transaction per push commit (§6.4): all row writes, the appended
 * commit (with its scope-index entries), and the idempotency record either
 * land together or not at all.
 */
export interface StorageTransaction {
  getRow(table: string, rowId: string): Promise<StoredRow | undefined>;
  upsertRow(table: string, row: StoredRow): Promise<void>;
  deleteRow(table: string, rowId: string): Promise<void>;
  /** Allocates the next per-partition commitSeq and appends the commit. */
  appendCommit(commit: NewCommit): Promise<number>;
  putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ServerStorage {
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
}
