/**
 * Shared SQLite dialect for synchronous `SqliteServerStorage` on Bun or Node
 * and asynchronous `D1ServerStorage` on Cloudflare Workers. D1 is SQLite:
 * same DDL, same statement grammar, same `?` positional placeholders, same
 * `INSERT ... ON CONFLICT` / `INSERT OR IGNORE` upsert idioms.
 *
 * `SqliteFamilyStorage` and `SqliteFamilyTransaction` hold every statement
 * and row mapping the two backends share. A backend supplies statement
 * execution through a small seam (`all`, `guardedAll`, `atomic`; `run` and
 * `all` inside a transaction) and keeps only what differs: connection
 * handling, the request lock in SQLite, transaction execution (interactive
 * `BEGIN IMMEDIATE` in SQLite, one buffered `db.batch` in D1), D1's
 * bound-parameter cap and its published-schema guard. The seam returns
 * promises; the synchronous SQLite driver resolves them with rows it read at
 * call time. Both classes run the identical `test/storage-contract.ts`.
 */
import type { PushOperationResult, ScopeMap } from '@syncular/core';
import {
  bindAuthoritativePartition,
  type BoundAuthoritativeQuery,
  prepareAuthoritativeQuery,
} from './authoritative-query';
import { syncError } from './errors';
import { validateCommitPruneQuery } from './prune';
import { StorageQueryError } from './storage-errors';
import {
  deleteRowSql,
  deleteSqliteRowScopesSql,
  indexRowPageStatement,
  quoteIdent,
  scanRowPageSql,
  selectRowScopesSql,
  selectRowSql,
  SYNC_COLUMN_VERSIONS_COLUMN,
  SYNC_PARTITION_COLUMN,
  SYNC_PAYLOAD_COLUMN,
  SYNC_ROW_ID_COLUMN,
  SYNC_SCOPES_COLUMN,
  SYNC_VERSION_COLUMN,
  commitWindowPageSql,
  LATEST_SCOPED_CHANGE_SEQ_SQLITE_SQL,
  upsertSql,
  upsertValues,
} from './relational-rows';
import type { CompiledTable } from './schema';
import { matchesEffective } from './scopes';
import type { SqliteValue } from './sqlite-driver';
import {
  clientRoundState,
  PARTITION_TOUCH_INTERVAL_MS,
  rowsLiveAfterDelete,
} from './storage';
import type {
  AuthoritativeQueryRequest,
  ClientCursorInfo,
  ClientPushResult,
  ClientRecord,
  ClientRecordWriteOptions,
  ClientSubscription,
  CommitChangeSummary,
  CommitDetail,
  CommitMetadata,
  CommitMetadataQuery,
  CommitPruneQuery,
  CommitPruneResult,
  CommitWindowQuery,
  DurableJsonValue,
  IndexRowScanQuery,
  NewCommit,
  NewReaction,
  PartitionRegistryEntry,
  PrunedReactionCounts,
  ReactionClaimQuery,
  ReactionFailure,
  ReactionFailureUpdate,
  ReactionListQuery,
  ReactionPruneQuery,
  RowChangeRecord,
  RowChangesQuery,
  RowListQuery,
  RowScanQuery,
  ScopeActivityQuery,
  ScopeCommitActivity,
  ScopeValueHistoryQuery,
  ScopeValueQuery,
  StoredChange,
  StoredCommit,
  StoredPushResult,
  StoredReaction,
  StoredRow,
} from './storage';
import { assertScopeIndexedScan, resolveIndexRowScan } from './storage-query';

/**
 * Schema DDL, one statement per `;`-delimited chunk. Native SQLite applies
 * the whole string via `db.exec(SQLITE_DDL)`; D1 applies each statement
 * separately (its `prepare`/`batch` API is one statement per call). Types
 * are SQLite's: `INTEGER`/`TEXT`/`BLOB`. Scopes are stored as JSON `TEXT`
 * (no JSONB on SQLite), payloads as `BLOB`.
 *
 * The inverted scope index carries the ordered column (`commit_seq` /
 * `row_id`) last in the PRIMARY KEY, so the candidate scan is an index
 * range that returns already-ordered rows — the same covering-index shape
 * the Postgres storage documents (§3.1, performance-by-
 * construction).
 *
 * `sync_row_scopes_by_row` is the one secondary scope index: a per-row
 * scope replacement predicates on `(partition, tbl, row_id)`, and `row_id`
 * is the LAST PRIMARY KEY column, so that predicate cannot narrow the
 * inverted index. Declared here so every SQLite-family storage (and D1,
 * which applies this same DDL) keeps the same plan shape as Postgres.
 */
export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS sync_partitions(
  partition TEXT PRIMARY KEY,
  max_commit_seq INTEGER NOT NULL DEFAULT 0,
  horizon_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_partition_registry(
  partition TEXT PRIMARY KEY,
  log_epoch TEXT NOT NULL,
  epoch_required INTEGER NOT NULL DEFAULT 0,
  last_authenticated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_row_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, row_id)
);
CREATE INDEX IF NOT EXISTS sync_row_scopes_by_row
  ON sync_row_scopes(partition, tbl, row_id);
CREATE TABLE IF NOT EXISTS sync_commits(
  partition TEXT NOT NULL, commit_seq INTEGER NOT NULL,
  client_id TEXT NOT NULL, client_commit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  writer_version INTEGER,
  PRIMARY KEY(partition, commit_seq)
);
CREATE INDEX IF NOT EXISTS sync_commits_by_time
  ON sync_commits(partition, created_at_ms);
CREATE TABLE IF NOT EXISTS sync_changes(
  partition TEXT NOT NULL, commit_seq INTEGER NOT NULL, idx INTEGER NOT NULL,
  tbl TEXT NOT NULL, row_id TEXT NOT NULL, op INTEGER NOT NULL,
  row_version INTEGER, scopes TEXT NOT NULL, payload BLOB,
  PRIMARY KEY(partition, commit_seq, idx)
);
CREATE INDEX IF NOT EXISTS sync_changes_by_table
  ON sync_changes(partition, commit_seq, tbl, idx);
CREATE TABLE IF NOT EXISTS sync_change_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, commit_seq INTEGER NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, commit_seq)
);
CREATE TABLE IF NOT EXISTS sync_push_results(
  partition TEXT NOT NULL, client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY(partition, client_id, client_commit_id)
);
CREATE TABLE IF NOT EXISTS sync_reactions(
  partition TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
  source_client_id TEXT NOT NULL, source_client_commit_id TEXT NOT NULL,
  source_commit_seq INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
  lease_owner TEXT, lease_expires_at_ms INTEGER, completed_at_ms INTEGER,
  last_failure TEXT,
  PRIMARY KEY(partition, idempotency_key),
  CHECK(status IN ('pending', 'leased', 'completed', 'dead-letter'))
);
CREATE INDEX IF NOT EXISTS sync_reactions_due
  ON sync_reactions(partition, status, available_at_ms, created_at_ms, idempotency_key);
CREATE INDEX IF NOT EXISTS sync_reactions_lease
  ON sync_reactions(partition, status, lease_expires_at_ms);
CREATE INDEX IF NOT EXISTS sync_reactions_completed
  ON sync_reactions(partition, status, completed_at_ms, idempotency_key);
CREATE INDEX IF NOT EXISTS sync_reactions_dead_letter
  ON sync_reactions(partition, status, available_at_ms, idempotency_key);
CREATE TABLE IF NOT EXISTS sync_clients(
  partition TEXT NOT NULL, client_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  wire_version INTEGER NOT NULL DEFAULT 1,
  cursor INTEGER NOT NULL, subscriptions TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_round_at_ms INTEGER, last_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(partition, client_id)
);
CREATE TABLE IF NOT EXISTS sync_blob_refs(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, row_id, blob_id)
);
CREATE INDEX IF NOT EXISTS sync_blob_refs_by_blob
  ON sync_blob_refs(partition, blob_id);
CREATE TABLE IF NOT EXISTS sync_tombstones(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  PRIMARY KEY(partition, tbl, row_id)
);
CREATE TABLE IF NOT EXISTS sync_backfill_checkpoints(
  partition TEXT NOT NULL, name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('declared','backfilling','activated')),
  watermark INTEGER NOT NULL DEFAULT 0,
  owner_epoch INTEGER NOT NULL DEFAULT 0,
  observed_rows INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(partition, name)
);
CREATE TABLE IF NOT EXISTS sync_writer_fence(
  partition TEXT PRIMARY KEY,
  required_writer_version INTEGER NOT NULL
);
`;

/** Columns added to `sync_clients` after its first release, by column name. */
export const SYNC_CLIENT_ROUND_COLUMNS = {
  last_round_at_ms: 'INTEGER',
  last_error_code: 'TEXT',
  consecutive_failures: 'INTEGER NOT NULL DEFAULT 0',
} as const;

/** Split the DDL into individual statements (D1 applies them one by one). */
export function sqliteDdlStatements(): string[] {
  return SQLITE_DDL.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** `?,?,…` for an `IN (…)` clause of `count` positional parameters. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

// -- value (de)serialization, shared by both SQLite storages ----------------

/** Runtime-neutral base64 (no `Buffer` — Workers-safe) for push results. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface SerializedResult {
  opIndex: number;
  status: string;
  code?: string;
  message?: string;
  serverVersion?: number;
  serverRow?: string;
  conflictColumns?: string;
  retryable?: boolean;
  details?: import('@syncular/core').RejectionDetails;
}

/** Serialize a push result to the JSON `TEXT` stored in `sync_push_results`. */
export function serializePushResult(result: StoredPushResult): string {
  return JSON.stringify({
    status: result.status,
    ...(result.commitSeq !== undefined ? { commitSeq: result.commitSeq } : {}),
    ...(result.recordedAtMs !== undefined
      ? { recordedAtMs: result.recordedAtMs }
      : {}),
    ...(result.cacheIdentity !== undefined
      ? { cacheIdentity: result.cacheIdentity }
      : {}),
    ...(result.conflictAuthorization !== undefined
      ? { conflictAuthorization: result.conflictAuthorization }
      : {}),
    results: result.results.map((record) => {
      if (record.status === 'conflict') {
        return {
          opIndex: record.opIndex,
          status: record.status,
          code: record.code,
          message: record.message,
          serverVersion: record.serverVersion,
          serverRow: bytesToBase64(record.serverRow),
          conflictColumns: bytesToBase64(record.conflictColumns),
        };
      }
      if (record.status === 'error') {
        return {
          opIndex: record.opIndex,
          status: record.status,
          code: record.code,
          message: record.message,
          retryable: record.retryable,
          ...(record.details !== undefined ? { details: record.details } : {}),
        };
      }
      return { opIndex: record.opIndex, status: record.status };
    }),
  });
}

/** Parse a stored push result; an unreadable record is a §6.3 cache miss. */
export function deserializePushResult(text: string): StoredPushResult {
  try {
    const parsed = JSON.parse(text) as {
      status: 'applied' | 'rejected';
      commitSeq?: number;
      recordedAtMs?: number;
      cacheIdentity?: string;
      conflictAuthorization?: StoredPushResult['conflictAuthorization'];
      results: SerializedResult[];
    };
    const results: PushOperationResult[] = parsed.results.map((record) => {
      if (record.status === 'conflict') {
        return {
          opIndex: record.opIndex,
          status: 'conflict',
          code: record.code ?? '',
          message: record.message ?? '',
          serverVersion: record.serverVersion ?? 0,
          serverRow: base64ToBytes(record.serverRow ?? ''),
          conflictColumns: base64ToBytes(record.conflictColumns ?? ''),
        };
      }
      if (record.status === 'error') {
        return {
          opIndex: record.opIndex,
          status: 'error',
          code: record.code ?? '',
          message: record.message ?? '',
          retryable: record.retryable ?? false,
          ...(record.details !== undefined ? { details: record.details } : {}),
        };
      }
      return { opIndex: record.opIndex, status: 'applied' };
    });
    return {
      status: parsed.status,
      ...(parsed.commitSeq !== undefined
        ? { commitSeq: parsed.commitSeq }
        : {}),
      ...(parsed.recordedAtMs !== undefined
        ? { recordedAtMs: parsed.recordedAtMs }
        : {}),
      ...(parsed.cacheIdentity !== undefined
        ? { cacheIdentity: parsed.cacheIdentity }
        : {}),
      ...(parsed.conflictAuthorization !== undefined
        ? { conflictAuthorization: parsed.conflictAuthorization }
        : {}),
      results,
    };
  } catch {
    throw syncError(
      'sync.idempotency_cache_miss',
      'persisted push result unreadable (§6.3)',
    );
  }
}

/** Row-record shape the SQLite `SELECT`s in both storages return. */
export interface SqliteRowRecord {
  row_id: string;
  server_version: number;
  scopes: string;
  payload: Uint8Array;
  column_versions: Uint8Array | null;
}

export interface SqliteChangeRecord {
  tbl: string;
  row_id: string;
  op: number;
  row_version: number | null;
  scopes: string;
  payload: Uint8Array | null;
}

/** Native SQLite returns `Uint8Array`; D1 returns `ArrayBuffer` for BLOBs. */
export function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error(`expected a BLOB column, got ${typeof value}`);
}

export function toStoredRow(record: SqliteRowRecord): StoredRow {
  return {
    rowId: record.row_id,
    serverVersion: record.server_version,
    scopes: JSON.parse(record.scopes) as Record<string, string>,
    payload: asUint8Array(record.payload),
    ...(record.column_versions !== null
      ? { columnVersions: asUint8Array(record.column_versions) }
      : {}),
  };
}

export function toStoredChange(record: SqliteChangeRecord): StoredChange {
  return {
    table: record.tbl,
    rowId: record.row_id,
    op: record.op === 1 ? 'upsert' : 'delete',
    ...(record.row_version !== null ? { rowVersion: record.row_version } : {}),
    scopes: JSON.parse(record.scopes) as Record<string, string>,
    ...(record.payload !== null
      ? { payload: asUint8Array(record.payload) }
      : {}),
  };
}

/**
 * One result row of `commitWindowPageSql` (candidate LEFT JOIN commit meta
 * LEFT JOIN changes): meta/change columns are NULL when the joined row
 * vanished (see the builder's LEFT JOIN contract). `payload` is a BLOB —
 * Native SQLite hands back `Uint8Array`, D1 `ArrayBuffer`; `toStoredChange`
 * normalizes via `asUint8Array`.
 */
export interface SqliteCommitWindowRecord {
  commit_seq: number;
  actor_id: string | null;
  created_at_ms: number | null;
  tbl: string | null;
  row_id: string | null;
  op: number | null;
  row_version: number | null;
  scopes: string | null;
  payload: Uint8Array | null;
}

/**
 * Fold one `commitWindowPageSql` page into commits, preserving the exact
 * semantics of the old per-candidate loop:
 *
 *   - rows arrive ordered (commit_seq, idx); consecutive rows with the same
 *     `commit_seq` are one candidate commit;
 *   - every candidate advances the cursor (`lastSeq`) — including vanished
 *     commits (NULL meta) and commits whose changes all fail the exact
 *     multi-variable scope verification (`matchesEffective`);
 *   - a commit is emitted only with its matching changes, in `idx` order;
 *   - stops after the commit that accumulates at least `remaining` matching
 *     changes (never splitting a commit).
 *
 * `candidateCount` counts the processed candidates so the caller can detect
 * a short page (window exhausted) exactly as it did with the old candidate
 * query.
 */
export function collectCommitWindowPage(
  records: readonly SqliteCommitWindowRecord[],
  scopeFilter: ScopeMap,
  remaining: number,
): {
  commits: StoredCommit[];
  delivered: number;
  lastSeq: number;
  candidateCount: number;
} {
  const commits: StoredCommit[] = [];
  let delivered = 0;
  let lastSeq = 0;
  let candidateCount = 0;
  let i = 0;
  while (i < records.length) {
    const head = records[i];
    if (head === undefined) break;
    const seq = head.commit_seq;
    candidateCount += 1;
    lastSeq = seq;
    const changes: StoredChange[] = [];
    for (; i < records.length; i++) {
      const record = records[i];
      if (record === undefined || record.commit_seq !== seq) break;
      // NULL tbl: a candidate with no change rows for the table (LEFT JOIN
      // contract) — it still advanced the cursor above.
      if (
        record.tbl === null ||
        record.row_id === null ||
        record.op === null ||
        record.scopes === null
      ) {
        continue;
      }
      const change = toStoredChange({
        tbl: record.tbl,
        row_id: record.row_id,
        op: record.op,
        row_version: record.row_version,
        scopes: record.scopes,
        payload: record.payload,
      });
      if (matchesEffective(change.scopes, scopeFilter)) changes.push(change);
    }
    // NULL meta: the commit vanished — cursor advanced, nothing emitted.
    if (head.actor_id === null || head.created_at_ms === null) continue;
    if (changes.length === 0) continue;
    commits.push({
      commitSeq: seq,
      createdAtMs: head.created_at_ms,
      actorId: head.actor_id,
      changes,
    });
    delivered += changes.length;
    if (delivered >= remaining) break;
  }
  return { commits, delivered, lastSeq, candidateCount };
}

interface SqliteReactionRecord {
  idempotency_key: string;
  type: string;
  version: number;
  payload: string;
  source_client_id: string;
  source_client_commit_id: string;
  source_commit_seq: number;
  created_at_ms: number;
  available_at_ms: number;
  status: StoredReaction['status'];
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  completed_at_ms: number | null;
  last_failure: string | null;
}

function toStoredReaction(record: SqliteReactionRecord): StoredReaction {
  return {
    idempotencyKey: record.idempotency_key,
    type: record.type,
    version: record.version,
    payload: JSON.parse(record.payload) as DurableJsonValue,
    sourceClientId: record.source_client_id,
    sourceClientCommitId: record.source_client_commit_id,
    sourceCommitSeq: record.source_commit_seq,
    createdAtMs: record.created_at_ms,
    maxAttempts: record.max_attempts,
    status: record.status,
    attempts: record.attempts,
    availableAtMs: record.available_at_ms,
    ...(record.lease_owner !== null ? { leaseOwner: record.lease_owner } : {}),
    ...(record.lease_expires_at_ms !== null
      ? { leaseExpiresAtMs: record.lease_expires_at_ms }
      : {}),
    ...(record.completed_at_ms !== null
      ? { completedAtMs: record.completed_at_ms }
      : {}),
    ...(record.last_failure !== null
      ? { lastFailure: JSON.parse(record.last_failure) as ReactionFailure }
      : {}),
  };
}

interface SqliteClientRecord {
  client_id: string;
  actor_id: string;
  wire_version: number;
  cursor: number;
  subscriptions: string;
  updated_at_ms: number;
  last_round_at_ms: number | null;
  last_error_code: string | null;
  consecutive_failures: number;
}

function toClientRecord(record: SqliteClientRecord): ClientRecord {
  return {
    clientId: record.client_id,
    actorId: record.actor_id,
    wireVersion: record.wire_version,
    cursor: record.cursor,
    updatedAtMs: record.updated_at_ms,
    subscriptions: JSON.parse(record.subscriptions) as ClientSubscription[],
    ...clientRoundState(
      record.last_round_at_ms,
      record.last_error_code,
      record.consecutive_failures,
    ),
  };
}

interface SqlitePartitionRegistryRecord {
  partition: string;
  log_epoch: string;
  epoch_required: number;
  last_authenticated_at_ms: number;
}

function toPartitionRegistryEntry(
  row: SqlitePartitionRegistryRecord,
): PartitionRegistryEntry {
  return {
    partition: row.partition,
    logEpoch: row.log_epoch,
    epochRequired: row.epoch_required === 1,
    lastAuthenticatedAtMs: row.last_authenticated_at_ms,
  };
}

/** One statement of an atomic unit: its SQL text and bound parameters. */
export interface SqliteStatementSpec {
  readonly sql: string;
  readonly params: readonly SqliteValue[];
}

/**
 * The `ServerStorage` methods SQLite and D1 share. A subclass supplies the
 * execution seam and implements the rest of the interface: schema migration,
 * `begin`, registered queries, the serve gate and checkpoints.
 */
export abstract class SqliteFamilyStorage {
  /** Set by `ensureSchema`: app-table lookup for the relational row store. */
  protected tables: ReadonlyMap<string, CompiledTable> | undefined;
  protected schemaVersion: number | undefined;
  /** Bound parameters one statement accepts. */
  protected abstract readonly maxBindParams: number;

  /** Run one statement and return its rows. */
  protected abstract all<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]>;

  /**
   * Run one read of schema-dependent state (row tables, the commit window,
   * push results). D1 runs it behind its published-schema guard and joins the
   * reads of one microtask turn into one batch; SQLite runs it as `all`.
   */
  protected abstract guardedAll<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]>;

  /** Run statements as one all-or-nothing unit; returns each one's rows. */
  protected abstract atomic(
    statements: readonly SqliteStatementSpec[],
  ): Promise<unknown[][]>;

  /** Resolve a table's compiled schema; row operations require `ensureSchema`. */
  table(name: string): CompiledTable {
    const table = this.tables?.get(name);
    if (table === undefined) {
      throw new Error(
        `unknown table ${JSON.stringify(name)} — ensureSchema(schema) must run before row operations`,
      );
    }
    return table;
  }

  protected prepareAuthoritativeQuery(
    partition: string,
    query: AuthoritativeQueryRequest,
  ): BoundAuthoritativeQuery {
    if (this.tables === undefined) {
      throw new Error(
        'ensureSchema(schema) must run before registered queries',
      );
    }
    return bindAuthoritativePartition(
      prepareAuthoritativeQuery(
        query.plan,
        query.params,
        query.tables,
        this.tables,
      ),
      partition,
    );
  }

  async touchPartition(
    partition: string,
    authenticatedAtMs: number,
    initialLogEpoch: string,
  ): Promise<PartitionRegistryEntry> {
    if (initialLogEpoch.length === 0) {
      throw new Error('initial log epoch must be non-empty');
    }
    const select = async () =>
      (
        await this.all<SqlitePartitionRegistryRecord>(
          `SELECT partition, log_epoch, epoch_required, last_authenticated_at_ms
             FROM sync_partition_registry WHERE partition=?`,
          [partition],
        )
      )[0];
    let row = await select();
    if (
      row === undefined ||
      authenticatedAtMs - row.last_authenticated_at_ms >=
        PARTITION_TOUCH_INTERVAL_MS
    ) {
      await this.all(
        `INSERT INTO sync_partition_registry(
           partition, log_epoch, last_authenticated_at_ms
         ) VALUES (?,?,?)
         ON CONFLICT(partition) DO UPDATE SET
           last_authenticated_at_ms=excluded.last_authenticated_at_ms`,
        [partition, initialLogEpoch, authenticatedAtMs],
      );
      row = await select();
    }
    if (row === undefined)
      throw new Error('partition registry write did not persist');
    return toPartitionRegistryEntry(row);
  }

  async rotatePartitionLogEpoch(
    partition: string,
    logEpoch: string,
    authenticatedAtMs: number,
  ): Promise<PartitionRegistryEntry> {
    if (logEpoch.length === 0) throw new Error('log epoch must be non-empty');
    await this.atomic([
      {
        sql: `INSERT INTO sync_partition_registry(
                partition, log_epoch, epoch_required, last_authenticated_at_ms
              ) VALUES (?,?,1,?)
              ON CONFLICT(partition) DO UPDATE SET
                log_epoch=excluded.log_epoch,
                epoch_required=1,
                last_authenticated_at_ms=excluded.last_authenticated_at_ms`,
        params: [partition, logEpoch, authenticatedAtMs],
      },
      {
        sql: 'DELETE FROM sync_clients WHERE partition=?',
        params: [partition],
      },
    ]);
    return {
      partition,
      logEpoch,
      epochRequired: true,
      lastAuthenticatedAtMs: authenticatedAtMs,
    };
  }

  async listPartitionRegistry(): Promise<PartitionRegistryEntry[]> {
    return (
      await this.all<SqlitePartitionRegistryRecord>(
        `SELECT partition, log_epoch, epoch_required, last_authenticated_at_ms
           FROM sync_partition_registry ORDER BY partition`,
        [],
      )
    ).map(toPartitionRegistryEntry);
  }

  async getMaxCommitSeq(partition: string): Promise<number> {
    const [row] = await this.all<{ max_commit_seq: number }>(
      'SELECT max_commit_seq FROM sync_partitions WHERE partition=?',
      [partition],
    );
    return row?.max_commit_seq ?? 0;
  }

  async getPartitionLogEpoch(partition: string): Promise<string | undefined> {
    const [row] = await this.all<{ log_epoch: string }>(
      'SELECT log_epoch FROM sync_partition_registry WHERE partition=?',
      [partition],
    );
    return row?.log_epoch;
  }

  async getHorizonSeq(partition: string): Promise<number> {
    const [row] = await this.all<{ horizon_seq: number }>(
      'SELECT horizon_seq FROM sync_partitions WHERE partition=?',
      [partition],
    );
    return row?.horizon_seq ?? 0;
  }

  async setHorizonSeq(partition: string, seq: number): Promise<void> {
    await this.all(
      `INSERT INTO sync_partitions(partition, horizon_seq) VALUES (?,?)
       ON CONFLICT(partition) DO UPDATE SET horizon_seq=max(horizon_seq,excluded.horizon_seq)`,
      [partition, seq],
    );
  }

  async pruneCommitsThrough(
    partition: string,
    query: CommitPruneQuery,
  ): Promise<CommitPruneResult> {
    validateCommitPruneQuery(query);
    // Every write re-checks the epoch, so the unit needs no read before its
    // writes: on a mismatch it changes nothing and the first row reports it.
    const epochGuard =
      'EXISTS (SELECT 1 FROM sync_partition_registry WHERE partition=? AND log_epoch=?)';
    const horizon =
      '(SELECT horizon_seq FROM sync_partitions WHERE partition=?)';
    const results = await this.atomic([
      {
        sql: `SELECT log_epoch, coalesce(${horizon},0) AS previous_horizon_seq FROM sync_partition_registry WHERE partition=?`,
        params: [partition, partition],
      },
      {
        sql: `INSERT INTO sync_partitions(partition,horizon_seq) SELECT ?,? WHERE ${epochGuard}
              ON CONFLICT(partition) DO UPDATE SET horizon_seq=max(horizon_seq,excluded.horizon_seq)`,
        params: [partition, query.throughSeq, partition, query.logEpoch],
      },
      {
        sql: `SELECT horizon_seq, (SELECT count(*) FROM sync_commits WHERE partition=? AND commit_seq<=${horizon}) AS removed_commits FROM sync_partitions WHERE partition=?`,
        params: [partition, partition, partition],
      },
      // §4.6: tombstones prune in the same pass as the commit log.
      ...[
        'sync_commits',
        'sync_changes',
        'sync_change_scopes',
        'sync_tombstones',
      ].map((table) => ({
        sql: `DELETE FROM ${table} WHERE partition=? AND commit_seq<=${horizon} AND ${epochGuard}`,
        params: [partition, partition, partition, query.logEpoch],
      })),
    ]);
    const [before, after] = [results[0], results[2]].map((rows) => {
      const row: unknown = rows?.[0];
      return typeof row === 'object' && row !== null
        ? (row as Readonly<Record<string, unknown>>)
        : undefined;
    });
    if (before?.log_epoch !== query.logEpoch)
      throw new StorageQueryError('sync.storage.prune_epoch_mismatch');
    if (
      typeof before.previous_horizon_seq !== 'number' ||
      typeof after?.horizon_seq !== 'number' ||
      typeof after.removed_commits !== 'number'
    ) {
      throw new Error('pruning returned invalid horizon metadata');
    }
    return {
      previousHorizonSeq: before.previous_horizon_seq,
      horizonSeq: after.horizon_seq,
      removedCommits: after.removed_commits,
    };
  }

  async getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number> {
    const [row] = await this.all<{ seq: number | null }>(
      'SELECT max(commit_seq) AS seq FROM sync_commits WHERE partition=? AND created_at_ms<?',
      [partition, createdBeforeMs],
    );
    return row?.seq ?? 0;
  }

  async sourceCoverageSeq(
    partition: string,
    tables: readonly string[],
  ): Promise<number> {
    if (tables.length === 0) return 0;
    const [row] = await this.all<{ seq: number | null }>(
      `SELECT max(commit_seq) AS seq FROM sync_changes
        WHERE partition=? AND tbl IN (${placeholders(tables.length)})`,
      [partition, ...tables],
    );
    return row?.seq ?? 0;
  }

  async hasSourceChangesAbove(
    partition: string,
    tables: readonly string[],
    seq: number,
  ): Promise<'clean' | 'changed' | 'unverifiable'> {
    // Read the horizon before the window scan: a horizon past `seq` means the
    // history that would answer the question is gone, so an empty scan proves
    // nothing and must not be reported as `clean`.
    const horizon = await this.getHorizonSeq(partition);
    if (tables.length === 0) return 'clean';
    const hit = await this.all<{ hit: number }>(
      `SELECT 1 AS hit FROM sync_changes
        WHERE partition=? AND tbl IN (${placeholders(tables.length)})
          AND commit_seq>? LIMIT 1`,
      [partition, ...tables, seq],
    );
    if (hit.length > 0) return 'changed';
    return horizon > seq ? 'unverifiable' : 'clean';
  }

  async getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined> {
    const [record] = await this.guardedAll<SqliteRowRecord>(
      selectRowSql(this.table(table), 'sqlite'),
      [partition, rowId],
    );
    return record === undefined ? undefined : toStoredRow(record);
  }

  async getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    const [record] = await this.guardedAll<{ result: string }>(
      'SELECT result FROM sync_push_results WHERE partition=? AND client_id=? AND client_commit_id=?',
      [partition, clientId, clientCommitId],
    );
    return record === undefined
      ? undefined
      : deserializePushResult(record.result);
  }

  async claimReactions(
    partition: string,
    query: ReactionClaimQuery,
  ): Promise<StoredReaction[]> {
    if (query.types.length === 0 || query.limit <= 0) return [];
    if (query.types.length + 7 > this.maxBindParams) {
      throw new Error('D1 reaction claim exceeds the bound-parameter limit');
    }
    const records = await this.all<SqliteReactionRecord>(
      `UPDATE sync_reactions
          SET status='leased', attempts=attempts+1,
              lease_owner=?, lease_expires_at_ms=?, completed_at_ms=NULL
        WHERE (partition, idempotency_key) IN (
          SELECT partition, idempotency_key
            FROM sync_reactions
           WHERE partition=? AND type IN (${placeholders(query.types.length)})
             AND ((status='pending' AND available_at_ms<=?)
               OR (status='leased' AND lease_expires_at_ms<=?))
           ORDER BY CASE WHEN status='leased' THEN lease_expires_at_ms
                         ELSE available_at_ms END,
                    created_at_ms, idempotency_key
           LIMIT ?
        )
      RETURNING *`,
      [
        query.leaseOwner,
        Math.min(Number.MAX_SAFE_INTEGER, query.nowMs + query.leaseDurationMs),
        partition,
        ...query.types,
        query.nowMs,
        query.nowMs,
        query.limit,
      ],
    );
    return records
      .map(toStoredReaction)
      .sort(
        (a, b) =>
          a.createdAtMs - b.createdAtMs ||
          a.idempotencyKey.localeCompare(b.idempotencyKey),
      );
  }

  async completeReaction(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    completedAtMs: number,
  ): Promise<boolean> {
    const updated = await this.all(
      `UPDATE sync_reactions
          SET status='completed', completed_at_ms=?,
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE partition=? AND idempotency_key=?
          AND status='leased' AND lease_owner=?
      RETURNING idempotency_key`,
      [completedAtMs, partition, idempotencyKey, leaseOwner],
    );
    return updated.length === 1;
  }

  async extendReactionLease(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean> {
    const updated = await this.all(
      `UPDATE sync_reactions SET lease_expires_at_ms=?
        WHERE partition=? AND idempotency_key=?
          AND status='leased' AND lease_owner=?
      RETURNING idempotency_key`,
      [leaseExpiresAtMs, partition, idempotencyKey, leaseOwner],
    );
    return updated.length === 1;
  }

  async failReaction(
    partition: string,
    idempotencyKey: string,
    update: ReactionFailureUpdate,
  ): Promise<boolean> {
    const updated = await this.all(
      `UPDATE sync_reactions
          SET status=?, available_at_ms=?, last_failure=?,
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE partition=? AND idempotency_key=?
          AND status='leased' AND lease_owner=?
      RETURNING idempotency_key`,
      [
        update.retryAtMs === undefined ? 'dead-letter' : 'pending',
        update.retryAtMs ?? update.failure.atMs,
        JSON.stringify(update.failure),
        partition,
        idempotencyKey,
        update.leaseOwner,
      ],
    );
    return updated.length === 1;
  }

  async retryReaction(
    partition: string,
    idempotencyKey: string,
    nowMs: number,
  ): Promise<boolean> {
    const updated = await this.all(
      `UPDATE sync_reactions
          SET status='pending', attempts=0, available_at_ms=?,
              last_failure=NULL, lease_owner=NULL, lease_expires_at_ms=NULL,
              completed_at_ms=NULL
        WHERE partition=? AND idempotency_key=? AND status='dead-letter'
      RETURNING idempotency_key`,
      [nowMs, partition, idempotencyKey],
    );
    return updated.length === 1;
  }

  async getReaction(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction | undefined> {
    const [record] = await this.all<SqliteReactionRecord>(
      'SELECT * FROM sync_reactions WHERE partition=? AND idempotency_key=?',
      [partition, idempotencyKey],
    );
    return record === undefined ? undefined : toStoredReaction(record);
  }

  async listReactions(
    partition: string,
    query: ReactionListQuery,
  ): Promise<StoredReaction[]> {
    const where = ['partition=?'];
    const params: (string | number)[] = [partition];
    if (query.statuses !== undefined && query.statuses.length > 0) {
      where.push(`status IN (${placeholders(query.statuses.length)})`);
      params.push(...query.statuses);
    }
    if (query.types !== undefined && query.types.length > 0) {
      where.push(`type IN (${placeholders(query.types.length)})`);
      params.push(...query.types);
    }
    if (params.length + 1 > this.maxBindParams) {
      throw new Error('D1 reaction list exceeds the bound-parameter limit');
    }
    params.push(query.limit);
    const records = await this.all<SqliteReactionRecord>(
      `SELECT * FROM sync_reactions WHERE ${where.join(' AND ')}
        ORDER BY created_at_ms DESC, idempotency_key DESC LIMIT ?`,
      params,
    );
    return records.map(toStoredReaction);
  }

  async pruneReactions(
    partition: string,
    query: ReactionPruneQuery,
  ): Promise<PrunedReactionCounts> {
    if (query.limit <= 0) return { completed: 0, deadLetter: 0 };
    const records = await this.all<{ status: 'completed' | 'dead-letter' }>(
      `DELETE FROM sync_reactions
        WHERE partition=? AND idempotency_key IN (
          SELECT idempotency_key FROM sync_reactions
           WHERE partition=?
             AND ((status='completed' AND completed_at_ms IS NOT NULL
                   AND completed_at_ms<?)
               OR (status='dead-letter' AND available_at_ms<?))
           ORDER BY CASE WHEN status='completed' THEN completed_at_ms
                         ELSE available_at_ms END,
                    idempotency_key
           LIMIT ?
        )
          AND ((status='completed' AND completed_at_ms IS NOT NULL
                AND completed_at_ms<?)
            OR (status='dead-letter' AND available_at_ms<?))
      RETURNING status`,
      [
        partition,
        partition,
        query.completedBeforeMs,
        query.deadLetterBeforeMs,
        query.limit,
        query.completedBeforeMs,
        query.deadLetterBeforeMs,
      ],
    );
    return {
      completed: records.filter((record) => record.status === 'completed')
        .length,
      deadLetter: records.filter((record) => record.status === 'dead-letter')
        .length,
    };
  }

  async latestScopedChangeSeq(
    partition: string,
    query: { readonly table: string; readonly scopeFilter: ScopeMap },
  ): Promise<number> {
    const firstVariable = Object.keys(query.scopeFilter).sort()[0];
    const values =
      firstVariable === undefined
        ? []
        : (query.scopeFilter[firstVariable] ?? []);
    if (firstVariable === undefined || values.length === 0) return 0;
    const [row] = await this.guardedAll<{ seq: number | null }>(
      LATEST_SCOPED_CHANGE_SEQ_SQLITE_SQL,
      [partition, query.table, firstVariable, JSON.stringify(values)],
    );
    return row?.seq ?? 0;
  }

  async readCommitWindow(
    partition: string,
    query: CommitWindowQuery,
  ): Promise<StoredCommit[]> {
    const variables = Object.keys(query.scopeFilter).sort();
    const firstVariable = variables[0];
    if (firstVariable === undefined) return [];
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    // Candidates via the inverted index (one variable) LEFT JOINed to the
    // commit meta + the table's changes — one statement per page, never two
    // per candidate (see `commitWindowPageSql`). Exact multi-variable
    // verification against the stored scope map in `collectCommitWindowPage`.
    const sql = commitWindowPageSql(firstValues.length, 'sqlite');
    const commits: StoredCommit[] = [];
    let deliveredChanges = 0;
    let afterSeq = query.afterSeq;
    const batchSize = Math.max(64, query.limitChanges);
    while (deliveredChanges < query.limitChanges) {
      const records = await this.guardedAll<SqliteCommitWindowRecord>(sql, [
        partition,
        query.table,
        firstVariable,
        ...firstValues,
        afterSeq,
        query.throughSeq,
        batchSize,
        partition,
        partition,
        query.table,
      ]);
      if (records.length === 0) break;
      const page = collectCommitWindowPage(
        records,
        query.scopeFilter,
        query.limitChanges - deliveredChanges,
      );
      commits.push(...page.commits);
      deliveredChanges += page.delivered;
      afterSeq = page.lastSeq;
      if (page.candidateCount < batchSize) break;
    }
    return commits;
  }

  async scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]> {
    const firstVariable = assertScopeIndexedScan(query);
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    // Candidates via the inverted index LEFT JOINed to the row table — one
    // statement per page, never one per row (see `scanRowPageSql`). Exact
    // multi-variable verification against the stored scope map below.
    const sql = scanRowPageSql(
      this.table(query.table),
      firstValues.length,
      'sqlite',
    );
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const records = await this.guardedAll<
        SqliteRowRecord & { payload: Uint8Array | null }
      >(sql, [
        partition,
        query.table,
        firstVariable,
        ...firstValues,
        afterRowId,
        batchSize,
        partition,
      ]);
      if (records.length === 0) break;
      for (const record of records) {
        afterRowId = record.row_id;
        // NULL payload: an index candidate whose row vanished — it still
        // advances the keyset cursor (LEFT JOIN contract) but yields no row.
        if (record.payload === null) continue;
        const stored = toStoredRow(record);
        if (!matchesEffective(stored.scopes, query.scopeFilter)) continue;
        rows.push(stored);
        if (rows.length >= query.limit) break;
      }
      if (records.length < batchSize) break;
    }
    return rows;
  }

  async scanRowsByIndex(
    partition: string,
    query: IndexRowScanQuery,
  ): Promise<StoredRow[]> {
    const table = this.table(query.table);
    const statement = indexRowPageStatement(
      table,
      resolveIndexRowScan(table, query),
      query.values,
      partition,
      query.afterRowId,
      query.limit,
      'sqlite',
    );
    return (
      await this.guardedAll<SqliteRowRecord>(statement.sql, statement.params)
    ).map(toStoredRow);
  }

  async getClientRecord(
    partition: string,
    clientId: string,
  ): Promise<ClientRecord | undefined> {
    const [record] = await this.all<SqliteClientRecord>(
      'SELECT client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms, last_round_at_ms, last_error_code, consecutive_failures FROM sync_clients WHERE partition=? AND client_id=?',
      [partition, clientId],
    );
    return record === undefined ? undefined : toClientRecord(record);
  }

  async putClientRecord(
    partition: string,
    record: ClientRecord,
    options?: ClientRecordWriteOptions,
  ): Promise<void> {
    // One row per (partition, client_id): every non-key field is written
    // from the new record. `keepRoundOutcome` leaves the round-state columns
    // alone (§1.5, §4.5).
    await this.all(
      `INSERT INTO sync_clients(partition, client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms, last_round_at_ms) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(partition, client_id) DO UPDATE SET
         actor_id=excluded.actor_id,
         wire_version=excluded.wire_version,
         cursor=excluded.cursor,
         subscriptions=excluded.subscriptions,
         updated_at_ms=excluded.updated_at_ms,
         last_round_at_ms=excluded.last_round_at_ms${
           options?.keepRoundOutcome === true
             ? ''
             : `,
         last_error_code=NULL,
         consecutive_failures=0`
         }`,
      [
        partition,
        record.clientId,
        record.actorId,
        record.wireVersion,
        record.cursor,
        JSON.stringify(record.subscriptions),
        record.updatedAtMs,
        record.updatedAtMs,
      ],
    );
  }

  async recordClientRoundFailure(
    partition: string,
    clientId: string,
    actorId: string,
    errorCode: string,
    atMs: number,
  ): Promise<void> {
    await this.all(
      `UPDATE sync_clients
       SET last_round_at_ms=?, last_error_code=?,
           consecutive_failures=consecutive_failures+1
       WHERE partition=? AND client_id=? AND actor_id=?`,
      [atMs, errorCode, partition, clientId, actorId],
    );
  }

  async advanceClientCursor(
    partition: string,
    clientId: string,
    actorId: string,
    logEpoch: string,
    cursor: number,
    updatedAtMs: number,
  ): Promise<void> {
    await this.all(
      `UPDATE sync_clients
       SET cursor=MAX(cursor, ?), updated_at_ms=MAX(updated_at_ms, ?)
       WHERE partition=? AND client_id=? AND actor_id=?
         AND EXISTS (SELECT 1 FROM sync_partition_registry
                     WHERE partition=sync_clients.partition AND log_epoch=?)`,
      [cursor, updatedAtMs, partition, clientId, actorId, logEpoch],
    );
  }

  async updateClientCursor(
    partition: string,
    clientId: string,
    cursor: number,
    updatedAtMs: number,
  ): Promise<void> {
    await this.all(
      `UPDATE sync_clients
       SET cursor=MAX(cursor, ?), updated_at_ms=MAX(updated_at_ms, ?)
       WHERE partition=? AND client_id=?`,
      [cursor, updatedAtMs, partition, clientId],
    );
  }

  async getActiveClientCursorFloor(
    partition: string,
    cutoffMs: number,
  ): Promise<number | null> {
    const [row] = await this.all<{ cursor: number | null }>(
      'SELECT MIN(cursor) AS cursor FROM sync_clients WHERE partition=? AND updated_at_ms>=? AND cursor>=0',
      [partition, cutoffMs],
    );
    return row!.cursor;
  }

  async listClientCursors(partition: string): Promise<ClientCursorInfo[]> {
    const records = await this.all<{
      client_id: string;
      cursor: number;
      updated_at_ms: number;
    }>(
      'SELECT client_id, cursor, updated_at_ms FROM sync_clients WHERE partition=?',
      [partition],
    );
    return records.map((r) => ({
      clientId: r.client_id,
      cursor: r.cursor,
      updatedAtMs: r.updated_at_ms,
    }));
  }

  async listRowsReferencingBlob(
    partition: string,
    blobId: string,
  ): Promise<
    {
      readonly table: string;
      readonly rowId: string;
      readonly scopes: Record<string, string>;
    }[]
  > {
    // Candidate rows via the by-blob index (§5.9.4/§5.9.5); each row's
    // stored scopes come from its row table for the §3.4 authorization test.
    const refs = await this.guardedAll<{ tbl: string; row_id: string }>(
      'SELECT tbl, row_id FROM sync_blob_refs WHERE partition=? AND blob_id=?',
      [partition, blobId],
    );
    const out: {
      table: string;
      rowId: string;
      scopes: Record<string, string>;
    }[] = [];
    for (const ref of refs) {
      const compiled = this.tables?.get(ref.tbl);
      if (compiled === undefined) continue; // table no longer in the schema
      const [row] = await this.guardedAll<{ scopes: string }>(
        selectRowScopesSql(compiled, 'sqlite'),
        [partition, ref.row_id],
      );
      if (row === undefined) continue;
      out.push({
        table: ref.tbl,
        rowId: ref.row_id,
        scopes: JSON.parse(row.scopes) as Record<string, string>,
      });
    }
    return out;
  }

  async listReferencedBlobIds(partition: string): Promise<string[]> {
    const rows = await this.all<{ blob_id: string }>(
      'SELECT DISTINCT blob_id FROM sync_blob_refs WHERE partition=?',
      [partition],
    );
    return rows.map((r) => r.blob_id);
  }

  async listScopeValueRows(
    partition: string,
    query: ScopeValueQuery,
  ): Promise<string[]> {
    // §4.6.1: rowIds of one table bound to one scope value, budgeted.
    const rows = await this.all<{ row_id: string }>(
      'SELECT row_id FROM sync_row_scopes WHERE partition=? AND tbl=? AND var=? AND value=? ORDER BY row_id LIMIT ?',
      [partition, query.table, query.variable, query.value, query.limit],
    );
    return rows.map((row) => row.row_id);
  }

  async eraseScopeValueHistory(
    partition: string,
    query: ScopeValueHistoryQuery,
  ): Promise<number> {
    const params = [
      partition,
      query.table,
      query.variable,
      query.value,
      query.throughSeq,
      `$.${JSON.stringify(query.variable)}`,
      query.limit,
    ];
    // §4.6.1 history scrub: upsert change records of the binding first, then
    // the change scope entries whose commit no longer holds a change of the
    // binding, then `serverRow` of stored conflict results whose conflict
    // authorization scopes carry the binding. Each statement returns one row
    // per changed record (D1 batch results carry no reliable change count).
    const results = await this.atomic(
      [
        `DELETE FROM sync_changes WHERE rowid IN (
           SELECT c.rowid FROM sync_change_scopes s JOIN sync_changes c
             ON c.partition=s.partition AND c.commit_seq=s.commit_seq AND c.tbl=s.tbl
           WHERE s.partition=?1 AND s.tbl=?2 AND s.var=?3 AND s.value=?4
             AND s.commit_seq<=?5 AND c.op=1 AND json_extract(c.scopes, ?6)=s.value
           LIMIT ?7) RETURNING 1 AS removed`,
        `DELETE FROM sync_change_scopes WHERE rowid IN (
           SELECT s.rowid FROM sync_change_scopes s
           WHERE s.partition=?1 AND s.tbl=?2 AND s.var=?3 AND s.value=?4
             AND s.commit_seq<=?5 AND NOT EXISTS (
               SELECT 1 FROM sync_changes c
               WHERE c.partition=s.partition AND c.commit_seq=s.commit_seq
                 AND c.tbl=s.tbl AND json_extract(c.scopes, ?6)=s.value)
           LIMIT ?7) RETURNING 1 AS removed`,
        `UPDATE sync_push_results SET result=json_set(result, '$.results', json((
           SELECT json_group_array(json(json_remove(e.value, '$.serverRow')))
             FROM (SELECT value FROM json_each(sync_push_results.result, '$.results')
                    ORDER BY key) e)))
         WHERE rowid IN (
           SELECT rowid FROM sync_push_results
           WHERE partition=?1
             AND json_extract(result, '$.conflictAuthorization.table')=?2
             AND json_extract(result,
                   '$.conflictAuthorization.scopes' || substr(?6, 2))=?4
             AND EXISTS (SELECT 1 FROM json_each(result, '$.results') r
                         WHERE json_type(r.value, '$.serverRow') IS NOT NULL)
           LIMIT ?7) RETURNING 1 AS removed`,
      ].map((sql) => ({ sql, params })),
    );
    return results.reduce((removed, rows) => removed + rows.length, 0);
  }

  // -- admin/console read surface --------------------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    return (
      await this.all<SqliteClientRecord>(
        'SELECT client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms, last_round_at_ms, last_error_code, consecutive_failures FROM sync_clients WHERE partition=? ORDER BY updated_at_ms DESC',
        [partition],
      )
    ).map(toClientRecord);
  }

  async listCommitMetadata(
    partition: string,
    query: CommitMetadataQuery,
  ): Promise<CommitMetadata[]> {
    // Newest-first window, resumed by `afterSeq` (exclusive lower bound) and
    // ended by `beforeSeq` (exclusive upper bound) when paging older. An
    // omitted bound is the largest safe commitSeq, so one statement serves
    // both the bounded and unbounded read.
    const beforeSeq = query.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = await this.all<{
      commit_seq: number;
      client_id: string;
      client_commit_id: string;
      actor_id: string;
      created_at_ms: number;
    }>(
      query.table
        ? `SELECT c.commit_seq, c.client_id, c.client_commit_id, c.actor_id, c.created_at_ms
           FROM sync_commits c
           WHERE c.partition=? AND c.commit_seq>? AND c.commit_seq<?
             AND EXISTS (SELECT 1 FROM sync_changes ch
               WHERE ch.partition=c.partition AND ch.commit_seq=c.commit_seq AND ch.tbl=?)
           ORDER BY c.commit_seq DESC LIMIT ?`
        : `SELECT commit_seq, client_id, client_commit_id, actor_id, created_at_ms
           FROM sync_commits
           WHERE partition=? AND commit_seq>? AND commit_seq<?
           ORDER BY commit_seq DESC LIMIT ?`,
      query.table
        ? [partition, query.afterSeq, beforeSeq, query.table, query.limit]
        : [partition, query.afterSeq, beforeSeq, query.limit],
    );
    // `changeSample`: one extra statement for the whole page — the first
    // `sample` changes (change-index order) of every listed commit. A page
    // larger than the bound-parameter cap splits into a few chunk statements,
    // never one per commit.
    const sampleCount =
      query.changeSample !== undefined &&
      Number.isInteger(query.changeSample) &&
      query.changeSample > 0
        ? query.changeSample
        : 0;
    const samples = new Map<number, CommitChangeSummary[]>();
    const seqs = sampleCount > 0 ? rows.map((row) => row.commit_seq) : [];
    const chunkSize = this.maxBindParams - 2;
    for (let offset = 0; offset < seqs.length; offset += chunkSize) {
      const chunk = seqs.slice(offset, offset + chunkSize);
      const changes = await this.all<{
        commit_seq: number;
        tbl: string;
        row_id: string;
        op: number;
      }>(
        `SELECT commit_seq, tbl, row_id, op FROM sync_changes
         WHERE partition=? AND commit_seq IN (${placeholders(chunk.length)}) AND idx<?
         ORDER BY commit_seq, idx`,
        [partition, ...chunk, sampleCount],
      );
      for (const change of changes) {
        const sample = samples.get(change.commit_seq) ?? [];
        sample.push({
          table: change.tbl,
          rowId: change.row_id,
          op: change.op === 1 ? 'upsert' : 'delete',
        });
        samples.set(change.commit_seq, sample);
      }
    }
    const out: CommitMetadata[] = [];
    for (const row of rows) {
      const changes = await this.all<{ tbl: string; n: number }>(
        'SELECT tbl, count(*) AS n FROM sync_changes WHERE partition=? AND commit_seq=? GROUP BY tbl',
        [partition, row.commit_seq],
      );
      out.push({
        commitSeq: row.commit_seq,
        clientId: row.client_id,
        clientCommitId: row.client_commit_id,
        actorId: row.actor_id,
        createdAtMs: row.created_at_ms,
        changeCount: changes.reduce((sum, c) => sum + c.n, 0),
        tables: changes.map((c) => c.tbl),
        ...(sampleCount > 0
          ? { sample: samples.get(row.commit_seq) ?? [] }
          : {}),
      });
    }
    return out;
  }

  async getCommit(
    partition: string,
    commitSeq: number,
  ): Promise<CommitDetail | undefined> {
    const [meta] = await this.all<{
      client_id: string;
      client_commit_id: string;
      actor_id: string;
      created_at_ms: number;
    }>(
      'SELECT client_id, client_commit_id, actor_id, created_at_ms FROM sync_commits WHERE partition=? AND commit_seq=?',
      [partition, commitSeq],
    );
    if (meta === undefined) return undefined;
    const changes = (
      await this.all<SqliteChangeRecord>(
        'SELECT tbl, row_id, op, row_version, scopes, payload FROM sync_changes WHERE partition=? AND commit_seq=? ORDER BY idx',
        [partition, commitSeq],
      )
    ).map(toStoredChange);
    return {
      commitSeq,
      clientId: meta.client_id,
      clientCommitId: meta.client_commit_id,
      actorId: meta.actor_id,
      createdAtMs: meta.created_at_ms,
      changeCount: changes.length,
      tables: [...new Set(changes.map((change) => change.table))].sort(),
      changes,
    };
  }

  async listRowChanges(
    partition: string,
    query: RowChangesQuery,
  ): Promise<RowChangeRecord[]> {
    // Retained-log read for one row: no dedicated index (the write path pays
    // nothing for it), bounded by retention (§4.6).
    const rows = await this.all<{
      commit_seq: number;
      op: number;
      row_version: number | null;
      actor_id: string;
      client_id: string;
      created_at_ms: number;
    }>(
      `SELECT ch.commit_seq, ch.op, ch.row_version, c.actor_id, c.client_id, c.created_at_ms
       FROM sync_changes ch
       JOIN sync_commits c
         ON c.partition=ch.partition AND c.commit_seq=ch.commit_seq
       WHERE ch.partition=? AND ch.tbl=? AND ch.row_id=?
       ORDER BY ch.commit_seq DESC, ch.idx DESC LIMIT ?`,
      [partition, query.table, query.rowId, query.limit],
    );
    return rows.map((row) => ({
      commitSeq: row.commit_seq,
      op: row.op === 1 ? 'upsert' : 'delete',
      ...(row.row_version !== null ? { rowVersion: row.row_version } : {}),
      actorId: row.actor_id,
      clientId: row.client_id,
      createdAtMs: row.created_at_ms,
    }));
  }

  async listRows(partition: string, query: RowListQuery): Promise<StoredRow[]> {
    // Keyset page over the row table's (partition, rowId) primary key: an
    // index range read, no scope filter, no per-row lookup.
    return (
      await this.guardedAll<SqliteRowRecord>(
        `SELECT ${quoteIdent(SYNC_ROW_ID_COLUMN)} AS row_id, ${quoteIdent(SYNC_VERSION_COLUMN)} AS server_version, ${quoteIdent(SYNC_SCOPES_COLUMN)} AS scopes, ${quoteIdent(SYNC_PAYLOAD_COLUMN)} AS payload, ${quoteIdent(SYNC_COLUMN_VERSIONS_COLUMN)} AS column_versions
         FROM ${quoteIdent(this.table(query.table).name)}
         WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=? AND ${quoteIdent(SYNC_ROW_ID_COLUMN)}>?
         ORDER BY ${quoteIdent(SYNC_ROW_ID_COLUMN)} LIMIT ?`,
        [partition, query.afterRowId ?? '', query.limit],
      )
    ).map(toStoredRow);
  }

  async countRows(partition: string, table: string): Promise<number> {
    const [record] = await this.guardedAll<{ n: number }>(
      `SELECT count(*) AS n FROM ${quoteIdent(this.table(table).name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=?`,
      [partition],
    );
    return record?.n ?? 0;
  }

  async listPushResults(
    partition: string,
    clientCommitId: string,
  ): Promise<ClientPushResult[]> {
    // Retained outcomes for one clientCommitId: no dedicated index, ordered
    // by client so the read is deterministic.
    const records = await this.guardedAll<{
      client_id: string;
      result: string;
    }>(
      'SELECT client_id, result FROM sync_push_results WHERE partition=? AND client_commit_id=? ORDER BY client_id',
      [partition, clientCommitId],
    );
    return records.map((record) => ({
      clientId: record.client_id,
      result: deserializePushResult(record.result),
    }));
  }

  async scopeActivity(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]> {
    // Candidate commits via the change-scope index (§3.1) — never a scan.
    const rows = await this.all<{ commit_seq: number; tbl: string }>(
      `SELECT DISTINCT commit_seq, tbl FROM sync_change_scopes
       WHERE partition=? AND var=? AND value=?
       ORDER BY commit_seq DESC LIMIT ?`,
      [partition, query.variable, query.value, query.limit],
    );
    const out: ScopeCommitActivity[] = [];
    for (const row of rows) {
      const [meta] = await this.all<{
        actor_id: string;
        created_at_ms: number;
      }>(
        'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=? AND commit_seq=?',
        [partition, row.commit_seq],
      );
      if (meta === undefined) continue;
      const [count] = await this.all<{ n: number }>(
        'SELECT count(*) AS n FROM sync_changes WHERE partition=? AND commit_seq=? AND tbl=?',
        [partition, row.commit_seq, row.tbl],
      );
      out.push({
        commitSeq: row.commit_seq,
        table: row.tbl,
        createdAtMs: meta.created_at_ms,
        actorId: meta.actor_id,
        changeCount: count?.n ?? 0,
      });
    }
    return out;
  }

  async listPartitions(): Promise<string[]> {
    return (await this.listPartitionRegistry()).map((entry) => entry.partition);
  }
}

/**
 * The `StorageTransaction` writes SQLite and D1 share. `run` executes a write
 * at call time on SQLite, inside its `BEGIN IMMEDIATE`; D1 buffers it for the
 * one `db.batch` at `commit()`.
 */
export abstract class SqliteFamilyTransaction {
  protected readonly partition: string;
  protected open = true;

  constructor(partition: string) {
    this.partition = partition;
  }

  /** Execute (SQLite) or buffer (D1) one write of this transaction. */
  protected abstract run(sql: string, params: readonly SqliteValue[]): void;

  /** Read persisted state from inside this transaction. */
  protected abstract all<T>(
    sql: string,
    params: readonly SqliteValue[],
  ): Promise<T[]>;

  protected abstract table(name: string): CompiledTable;

  /** Allocate the next dense commitSeq (§2.1) and write its `sync_commits` row. */
  protected abstract appendCommitRow(commit: NewCommit): Promise<number>;

  abstract getRow(table: string, rowId: string): Promise<StoredRow | undefined>;

  protected assertOpen(): void {
    if (!this.open) throw new Error('transaction already finished');
  }

  async getRows(
    table: string,
    rowIds: readonly string[],
  ): Promise<ReadonlyMap<string, StoredRow>> {
    this.assertOpen();
    // One indexed lookup per id: SQLite is in-process, and on D1 `getRow`
    // owns the buffered-write overlay.
    const rows = new Map<string, StoredRow>();
    for (const rowId of new Set(rowIds)) {
      const row = await this.getRow(table, rowId);
      if (row !== undefined) rows.set(rowId, row);
    }
    return rows;
  }

  async getTombstoneSeq(
    table: string,
    rowId: string,
  ): Promise<number | undefined> {
    this.assertOpen();
    const [row] = await this.all<{ commit_seq: number }>(
      'SELECT commit_seq FROM sync_tombstones WHERE partition=? AND tbl=? AND row_id=?',
      [this.partition, table, rowId],
    );
    return row?.commit_seq;
  }

  async clearTombstone(table: string, rowId: string): Promise<void> {
    this.assertOpen();
    this.run(
      'DELETE FROM sync_tombstones WHERE partition=? AND tbl=? AND row_id=?',
      [this.partition, table, rowId],
    );
  }

  /**
   * Write a row and refresh its scope-index entries. The DELETE drops only
   * the keys the new scope map no longer carries and runs before the upsert,
   * so its subquery reads the pre-upsert scope map; keys present in both
   * maps are left alone and the `INSERT OR IGNORE` writes nothing for them.
   */
  protected writeRow(table: string, row: StoredRow): void {
    const p = this.partition;
    const compiled = this.table(table);
    this.run(
      `${deleteSqliteRowScopesSql(compiled)}
        AND (var, value) NOT IN (SELECT key, value FROM json_each(?))`,
      [p, table, row.rowId, p, row.rowId, JSON.stringify(row.scopes)],
    );
    this.run(
      upsertSql(compiled, 'sqlite'),
      upsertValues(compiled, p, row, 'sqlite'),
    );
    for (const [variable, value] of Object.entries(row.scopes)) {
      this.run(
        'INSERT OR IGNORE INTO sync_row_scopes(partition, tbl, var, value, row_id) VALUES (?,?,?,?,?)',
        [p, table, variable, value, row.rowId],
      );
    }
  }

  async deleteRow(table: string, rowId: string): Promise<void> {
    this.assertOpen();
    const p = this.partition;
    const compiled = this.table(table);
    this.run(deleteSqliteRowScopesSql(compiled), [p, table, rowId, p, rowId]);
    this.run(deleteRowSql(compiled, 'sqlite'), [p, rowId]);
    // §5.9.4: a deleted row references no blobs.
    this.run(
      'DELETE FROM sync_blob_refs WHERE partition=? AND tbl=? AND row_id=?',
      [p, table, rowId],
    );
  }

  async setBlobRefs(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void> {
    this.assertOpen();
    const p = this.partition;
    // Replace the row's reference set atomically (§5.9.4).
    this.run(
      'DELETE FROM sync_blob_refs WHERE partition=? AND tbl=? AND row_id=?',
      [p, table, rowId],
    );
    for (const blobId of blobIds) {
      this.run(
        'INSERT OR IGNORE INTO sync_blob_refs(partition, tbl, row_id, blob_id) VALUES (?,?,?,?)',
        [p, table, rowId, blobId],
      );
    }
  }

  async appendCommit(commit: NewCommit): Promise<number> {
    this.assertOpen();
    const p = this.partition;
    const commitSeq = await this.appendCommitRow(commit);
    const liveAfterDelete = rowsLiveAfterDelete(commit.changes);
    commit.changes.forEach((change, idx) => {
      this.run(
        'INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          p,
          commitSeq,
          idx,
          change.table,
          change.rowId,
          change.op === 'upsert' ? 1 : 2,
          change.rowVersion ?? null,
          JSON.stringify(change.scopes),
          change.payload ?? null,
        ],
      );
      if (
        change.op === 'delete' &&
        !liveAfterDelete.has(`${change.table}\u0000${change.rowId}`)
      ) {
        // §5 delete precedence: every applied delete leaves a tombstone,
        // pruned with the commit log (§4.6). A delete that the same commit
        // follows with an upsert is a §2.2 scope move, not a deletion.
        this.run(
          `INSERT INTO sync_tombstones(partition, tbl, row_id, commit_seq) VALUES (?,?,?,?)
           ON CONFLICT(partition, tbl, row_id) DO UPDATE SET commit_seq=excluded.commit_seq`,
          [p, change.table, change.rowId, commitSeq],
        );
      }
      for (const [variable, value] of Object.entries(change.scopes)) {
        this.run(
          'INSERT OR IGNORE INTO sync_change_scopes(partition, tbl, var, value, commit_seq) VALUES (?,?,?,?,?)',
          [p, change.table, variable, value, commitSeq],
        );
      }
    });
    return commitSeq;
  }

  async putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.assertOpen();
    this.run(
      'INSERT OR IGNORE INTO sync_push_results(partition, client_id, client_commit_id, result) VALUES (?,?,?,?)',
      [this.partition, clientId, clientCommitId, serializePushResult(result)],
    );
  }

  async enqueueReactions(reactions: readonly NewReaction[]): Promise<void> {
    this.assertOpen();
    for (const reaction of reactions) {
      this.run(
        `INSERT INTO sync_reactions(
           partition, idempotency_key, type, version, payload,
           source_client_id, source_client_commit_id, source_commit_seq,
           created_at_ms, available_at_ms, status, attempts, max_attempts
         ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?)`,
        [
          this.partition,
          reaction.idempotencyKey,
          reaction.type,
          reaction.version,
          JSON.stringify(reaction.payload),
          reaction.sourceClientId,
          reaction.sourceClientCommitId,
          reaction.sourceCommitSeq,
          reaction.createdAtMs,
          reaction.createdAtMs,
          reaction.maxAttempts,
        ],
      );
    }
  }
}
