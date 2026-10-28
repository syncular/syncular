import { validateCommitPruneQuery } from './prune';
import { StorageQueryError } from './storage-errors';
import type { CommitPruneQuery, CommitPruneResult } from './storage';
import {
  clientRoundState,
  PARTITION_TOUCH_INTERVAL_MS,
  rowsLiveAfterDelete,
  serveGateRefusal,
} from './storage';
import { serveNotReadyError } from './readiness';
/**
 * Postgres server storage: the production database path.
 *
 * Semantics mirror `SqliteServerStorage` exactly (both run the shared
 * storage contract in `test/storage-contract.ts`); the difference is that
 * scope fanout MUST survive contact with Postgres — no scan-before-LIMIT,
 * ever (performance-by-construction):
 *
 *   - both the commit log and the current-row table carry a (table, var,
 *     value) inverted scope index;
 *   - `readCommitWindow`/`scanRows` select candidates through that index
 *     (`sync_change_scopes` / `sync_row_scopes`), ordered + LIMITed at the
 *     index, then verify the full multi-variable match against the stored
 *     scope map — never a log or table scan;
 *   - the candidate indexes are *covering* for their selection: the ordered
 *     column (`commit_seq` / `row_id`) sits in the index key after
 *     (tbl, var, value), so the planner does an index range scan and returns
 *     already-ordered candidates without a heap sort. `test/postgres-explain
 *     .test.ts` asserts an `Index` node (never `Seq Scan`) so the regression
 *     cannot silently return.
 *
 * Storage is written against the `PgExecutor` seam (zero runtime deps); the
 * production driver (Bun.sql / node-postgres) and the test driver (pglite)
 * are wired by the host. See `pg-executor.ts` and the server README.
 *
 * ## commitSeq allocation under concurrency
 *
 * Per-partition `commitSeq` is a dense, gap-free counter (§2.1), allocated
 * inside the push transaction by `UPDATE sync_partitions SET
 * max_commit_seq = max_commit_seq + 1 … RETURNING`. The `UPDATE` takes a
 * row-level write lock on the partition row for the duration of the
 * transaction, so two concurrent pushes to the same partition serialize on
 * that row: the second blocks until the first commits, then reads the
 * advanced counter. This keeps the sequence dense (a Postgres `SEQUENCE`
 * would leave gaps on rollback, which the pull-window arithmetic in §4.5
 * does not tolerate). Cross-partition pushes never contend.
 */
import type { PushOperationResult, ScopeMap } from '@syncular/core';
import {
  bindAuthoritativePartition,
  type BoundAuthoritativeQuery,
  postgresPlaceholders,
  prepareAuthoritativeQuery,
} from './authoritative-query';
import { syncError } from './errors';
import {
  asBytes,
  asNumber,
  type PgExecutor,
  type PgQueryable,
  type PgRow,
} from './pg-executor';
import {
  assertPhysicalColumns,
  assertStoredLayouts,
  COMMIT_WINDOW_BATCH_SQL,
  LATEST_SCOPED_CHANGE_BATCH_SQL,
  deleteRowSql,
  dropTableDdl,
  indexRowPageStatement,
  layoutsOf,
  migratePayload,
  parseLayouts,
  quoteIdent,
  tableColumnNames,
  retiredTableNames,
  rewritePlan,
  columnSqlType,
  rewriteValues,
  SCHEMA_META_DDL_POSTGRES,
  SYNC_COLUMN_VERSIONS_COLUMN,
  SYNC_PARTITION_COLUMN,
  SYNC_PAYLOAD_COLUMN,
  SYNC_ROW_ID_COLUMN,
  SYNC_SCOPES_COLUMN,
  SYNC_VERSION_COLUMN,
  type StoredColumnLayout,
  scanRowBatchSql,
  scanRowPageSql,
  indexSignature,
  schemaDdl,
  serverIndexDdl,
  selectRowScopesSql,
  selectRowSql,
  prefetchRowsBatchSql,
  selectRowsForRewriteSql,
  upsertSql,
  upsertValues,
} from './relational-rows';
import type { CompiledSchema, CompiledTable } from './schema';
import { matchesEffective, sha256Hex } from './scopes';
import type {
  AuthoritativeQueryRequest,
  AuthoritativeQueryResult,
  CheckpointDeclaration,
  ClientCursorInfo,
  ClientPushResult,
  ClientRecord,
  ClientRecordWriteOptions,
  ClientSubscription,
  CommitChangeSummary,
  CommitDetail,
  CommitMetadata,
  CommitMetadataQuery,
  CommitWindowQuery,
  DurableJsonValue,
  IndexRowScanQuery,
  NewChange,
  NewCommit,
  NewReaction,
  PartitionRegistryEntry,
  PreparedPushApply,
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
  ServerStorage,
  ServeGate,
  StorageTransaction,
  StoredChange,
  StoredCheckpoint,
  StoredCommit,
  StoredPushResult,
  StoredReaction,
  StoredRow,
} from './storage';
import {
  isPostgresConstraintError,
  StorageConstraintError,
} from './storage-errors';
import { assertScopeIndexedScan, resolveIndexRowScan } from './storage-query';

/**
 * Schema DDL. Applied by `PostgresServerStorage.migrate()` (idempotent).
 *
 * Covering index design (the reason this file exists):
 *   - `sync_change_scopes_pk (partition, tbl, var, value, commit_seq)` — the
 *     candidate scan for `readCommitWindow` ranges on the (partition, tbl,
 *     var, value IN …) prefix and returns `commit_seq` already ascending;
 *   - `sync_row_scopes_pk (partition, tbl, var, value, row_id)` — same shape
 *     for `scanRows`, ordered by `row_id`.
 * Both are the PRIMARY KEY, so they are the clustering/covering index for
 * their table.
 *
 * `sync_row_scopes_by_row (partition, tbl, row_id)` is the one secondary
 * scope index: `writeRowsOn` and `deleteRow` replace a row's scope entries
 * with a `(partition, tbl, row_id)` predicate, and `row_id` is the LAST
 * column of the inverted PRIMARY KEY, so without this index that predicate
 * scans the table's whole scope range on every row written (a bulk import
 * costs one such scan per row).
 *
 * Blob reference index (§5.9.4) — parity with the SQLite dialect's
 * `sync_blob_refs`:
 *   - PRIMARY KEY `(partition, tbl, row_id, blob_id)` — the by-row prefix
 *     lets `setBlobRefs` replace a row's set with a single ranged DELETE and
 *     the delete path clear it by (partition, tbl, row_id);
 *   - the secondary `sync_blob_refs_by_blob (partition, blob_id)` index
 *     drives `listRowsReferencingBlob` (the download-authorization candidate
 *     set, §5.9.5) as an index range, never a scan. `postgres-explain
 *     .test.ts` asserts an `Index` node here too.
 */
export const POSTGRES_DDL = `
CREATE TABLE IF NOT EXISTS sync_partitions(
  partition TEXT PRIMARY KEY,
  max_commit_seq BIGINT NOT NULL DEFAULT 0,
  horizon_seq BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_partition_registry(
  partition TEXT PRIMARY KEY,
  log_epoch TEXT NOT NULL,
  epoch_required BOOLEAN NOT NULL DEFAULT FALSE,
  last_authenticated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_row_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, row_id)
);
CREATE INDEX IF NOT EXISTS sync_row_scopes_by_row
  ON sync_row_scopes(partition, tbl, row_id);
CREATE TABLE IF NOT EXISTS sync_commits(
  partition TEXT NOT NULL, commit_seq BIGINT NOT NULL,
  client_id TEXT NOT NULL, client_commit_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, created_at_ms BIGINT NOT NULL,
  writer_version BIGINT,
  PRIMARY KEY(partition, commit_seq)
);
CREATE INDEX IF NOT EXISTS sync_commits_by_time
  ON sync_commits(partition, created_at_ms);
CREATE TABLE IF NOT EXISTS sync_changes(
  partition TEXT NOT NULL, commit_seq BIGINT NOT NULL, idx INTEGER NOT NULL,
  tbl TEXT NOT NULL, row_id TEXT NOT NULL, op SMALLINT NOT NULL,
  row_version BIGINT, scopes JSONB NOT NULL, payload BYTEA,
  PRIMARY KEY(partition, commit_seq, idx)
);
CREATE INDEX IF NOT EXISTS sync_changes_by_table
  ON sync_changes(partition, commit_seq, tbl, idx);
CREATE TABLE IF NOT EXISTS sync_change_scopes(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  var TEXT NOT NULL, value TEXT NOT NULL, commit_seq BIGINT NOT NULL,
  PRIMARY KEY(partition, tbl, var, value, commit_seq)
);
CREATE TABLE IF NOT EXISTS sync_push_results(
  partition TEXT NOT NULL, client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL, result JSONB NOT NULL,
  PRIMARY KEY(partition, client_id, client_commit_id)
);
CREATE TABLE IF NOT EXISTS sync_reactions(
  partition TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL, version INTEGER NOT NULL, payload JSONB NOT NULL,
  source_client_id TEXT NOT NULL, source_client_commit_id TEXT NOT NULL,
  source_commit_seq BIGINT NOT NULL, created_at_ms BIGINT NOT NULL,
  available_at_ms BIGINT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
  lease_owner TEXT, lease_expires_at_ms BIGINT, completed_at_ms BIGINT,
  last_failure JSONB,
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
  cursor BIGINT NOT NULL, subscriptions JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  last_round_at_ms BIGINT, last_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(partition, client_id)
);
ALTER TABLE sync_clients
  ADD COLUMN IF NOT EXISTS wire_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS last_round_at_ms BIGINT;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE sync_clients
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sync_blob_refs(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, row_id, blob_id)
);
CREATE INDEX IF NOT EXISTS sync_blob_refs_by_blob
  ON sync_blob_refs(partition, blob_id);
CREATE TABLE IF NOT EXISTS sync_tombstones(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  commit_seq BIGINT NOT NULL,
  PRIMARY KEY(partition, tbl, row_id)
);
CREATE TABLE IF NOT EXISTS sync_backfill_checkpoints(
  partition TEXT NOT NULL, name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('declared','backfilling','activated')),
  watermark BIGINT NOT NULL DEFAULT 0,
  owner_epoch BIGINT NOT NULL DEFAULT 0,
  observed_rows BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY(partition, name)
);
CREATE TABLE IF NOT EXISTS sync_writer_fence(
  partition TEXT PRIMARY KEY,
  required_writer_version INTEGER NOT NULL
);
`;

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

async function lockPartitionOn(
  client: PgQueryable,
  partition: string,
): Promise<void> {
  const locked = await client.query(
    'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1 FOR UPDATE',
    [partition],
  );
  if (locked.rows.length > 0) return;
  // The first writer initializes the partition. Concurrent initializers may
  // wait on this insert, so acquire the row lock again before applying writes.
  await client.query(
    `INSERT INTO sync_partitions(partition, max_commit_seq) VALUES ($1, 0)
    ON CONFLICT (partition) DO NOTHING`,
    [partition],
  );
  await client.query(
    'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1 FOR UPDATE',
    [partition],
  );
}

/**
 * Insert the `declared` row and raise the fence, on the caller's open
 * transaction. Shared by `declareCheckpoint` and the `ensureSchema`
 * migration so the schema bump and the fence commit together. Never lowers a
 * fence and never re-declares an existing row.
 */
async function installCheckpointOn(
  client: PgQueryable,
  partition: string,
  name: string,
  schemaVersion: number,
  nowMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO sync_backfill_checkpoints(
       partition, name, schema_version, state, watermark,
       owner_epoch, observed_rows, updated_at_ms)
     VALUES ($1,$2,$3,'declared',0,0,0,$4)
     ON CONFLICT (partition, name) DO NOTHING`,
    [partition, name, schemaVersion, nowMs],
  );
  await client.query(
    `INSERT INTO sync_writer_fence(partition, required_writer_version)
     VALUES ($1,$2)
     ON CONFLICT (partition) DO UPDATE SET
       required_writer_version=GREATEST(
         sync_writer_fence.required_writer_version,
         EXCLUDED.required_writer_version)`,
    [partition, schemaVersion],
  );
}

/**
 * A scalar subquery over the table names in the JSON array bound to
 * `namesParam`: the free-standing indexes of each table as a JSON array of
 * `{tbl, name, unique, partial, columns}`. Parity with the SQLite/D1
 * `origin === 'c'` filter: constraint-owned indexes (PRIMARY KEY, UNIQUE
 * constraints) can only be removed through their constraint, so DROP INDEX on
 * them would abort the transaction. Tables resolve through `to_regclass`,
 * which follows the session's `search_path` like the row queries do.
 */
function indexesSubquery(namesParam: string): string {
  return `(SELECT coalesce(json_agg(json_build_object(
                  'tbl', tables.name,
                  'name', index_class.relname,
                  'unique', index_meta.indisunique,
                  'partial', index_meta.indpred IS NOT NULL,
                  'columns', ARRAY(
                    SELECT attribute.attname::text
                      FROM unnest(index_meta.indkey::int2[])
                           WITH ORDINALITY AS key(attnum, ord)
                      LEFT JOIN pg_catalog.pg_attribute AS attribute
                        ON attribute.attrelid = index_meta.indrelid
                       AND attribute.attnum = key.attnum
                     WHERE key.ord <= index_meta.indnkeyatts
                     ORDER BY key.ord))), '[]'::json)::text
           FROM jsonb_array_elements_text(${namesParam}::text::jsonb) AS tables(name)
           JOIN pg_catalog.pg_index AS index_meta
             ON index_meta.indrelid = to_regclass(tables.name)
           JOIN pg_catalog.pg_class AS index_class
             ON index_class.oid = index_meta.indexrelid
          WHERE NOT index_meta.indisprimary
            AND NOT EXISTS (
              SELECT 1
                FROM pg_catalog.pg_constraint AS owning_constraint
               WHERE owning_constraint.conindid = index_meta.indexrelid
            ))`;
}

/** Table name to index name to {@link indexSignature}, from {@link indexesSubquery} JSON. */
function parseIndexSignatures(
  json: string,
): Map<string, ReadonlyMap<string, string>> {
  const byTable = new Map<string, Map<string, string>>();
  for (const index of JSON.parse(json) as {
    tbl: string;
    name: string;
    unique: boolean;
    partial: boolean;
    columns: (string | null)[];
  }[]) {
    const indexes = byTable.get(index.tbl) ?? new Map<string, string>();
    indexes.set(
      index.name,
      indexSignature(index.columns, index.unique, index.partial),
    );
    byTable.set(index.tbl, indexes);
  }
  return byTable;
}

async function readIndexSignatures(
  client: PgQueryable,
  tableNames: readonly string[],
): Promise<Map<string, ReadonlyMap<string, string>>> {
  const { rows } = await client.query<{ indexes: string }>(
    `SELECT ${indexesSubquery('$1')} AS indexes`,
    [JSON.stringify(tableNames)],
  );
  return parseIndexSignatures(rows[0]?.indexes ?? '[]');
}

interface ServeGateRow {
  schema_version: unknown;
  log_epoch: string | null;
  pending: unknown;
  result?: unknown;
}

/**
 * The serve-gate projection shared by every read: the entry/verify gate and
 * the push admission statement select exactly these columns. Params:
 * [partition, running schema version].
 */
const SERVE_GATE_PROJECTION = `(SELECT schema_version FROM sync_schema_meta WHERE id=1) AS schema_version,
            (SELECT log_epoch FROM sync_partition_registry WHERE partition=$1) AS log_epoch,
            (SELECT json_agg(json_build_object('partition', partition, 'name', name))
               FROM sync_backfill_checkpoints
              WHERE schema_version=$2 AND state<>'activated') AS pending`;

function toServeGate(row: ServeGateRow | undefined): ServeGate {
  return {
    // asNumber maps the NULL of a missing marker row to 0.
    storedSchemaVersion: asNumber(row?.schema_version),
    logEpoch: row?.log_epoch ?? undefined,
    pending:
      row?.pending === null || row?.pending === undefined
        ? []
        : asJson<{ partition: string; name: string }[]>(row.pending),
  };
}

/** RFC 0007 serve gate on either the pool or a transaction's client. */
async function readServeGateOn(
  client: PgQueryable,
  partition: string,
  runningSchemaVersion: number,
): Promise<ServeGate> {
  // One statement: every request reads the gate twice (entry and verify),
  // so its parts share one round trip and one snapshot.
  const { rows } = await client.query<ServeGateRow>(
    `SELECT ${SERVE_GATE_PROJECTION}`,
    [partition, runningSchemaVersion],
  );
  return toServeGate(rows[0]);
}

/** One read-ahead row of the admission statement (the gate row has no `tbl`). */
interface PrefetchRow {
  readonly tbl: string;
  readonly lookup_id: string;
  readonly row_id: string | null;
  readonly server_version: unknown;
  readonly scopes: unknown;
  readonly payload: unknown;
  readonly column_versions: unknown;
  readonly tombstone_seq: unknown;
}

type AdmissionRow = ServeGateRow & Partial<PrefetchRow>;

/**
 * The push admission read: the RFC 0007 serve gate, the §2.3 idempotency
 * record, and (when the caller already knows the commit's row targets) the
 * read-ahead rows, in one statement with one snapshot. The caller takes the
 * partition lock first: under READ COMMITTED a statement's snapshot is fixed
 * at its start, so the read must be the statement *after* the lock to observe
 * a duplicate that committed while this transaction waited for it.
 */
async function readAdmissionOn(
  client: PgQueryable,
  partition: string,
  clientId: string,
  clientCommitId: string,
  runningSchemaVersion: number,
  prefetch:
    | {
        readonly tables: readonly CompiledTable[];
        readonly specs: readonly {
          readonly tbl: string;
          readonly ids: string[];
        }[];
      }
    | undefined,
): Promise<{
  gate: ServeGate;
  persisted: StoredPushResult | undefined;
  prefetched: readonly PrefetchRow[];
}> {
  const params: unknown[] = [
    partition,
    runningSchemaVersion,
    clientId,
    clientCommitId,
  ];
  let statement = `SELECT ${SERVE_GATE_PROJECTION},
            (SELECT result FROM sync_push_results
              WHERE partition=$1 AND client_id=$3 AND client_commit_id=$4) AS result`;
  if (prefetch !== undefined && prefetch.specs.length > 0) {
    params.push(JSON.stringify(prefetch.specs));
    // The gate row pads the read-ahead columns with typed NULLs so both
    // branches share one result shape; `tbl` is NULL only for the gate row.
    statement += `,
            NULL::text AS tbl, NULL::text AS lookup_id, NULL::text AS row_id,
            NULL::bigint AS server_version, NULL::jsonb AS scopes,
            NULL::bytea AS payload, NULL::bytea AS column_versions,
            NULL::bigint AS tombstone_seq
       UNION ALL
       SELECT NULL::bigint, NULL::text, NULL::json, NULL::jsonb,
              p.tbl, p.lookup_id, p.row_id, p.server_version, p.scopes,
              p.payload, p.column_versions, p.tombstone_seq
         FROM (${prefetchRowsBatchSql(prefetch.tables, {
           partition: '$1',
           specs: `$${params.length}`,
         })}) p`;
  }
  const { rows } = await client.query<AdmissionRow>(statement, params);
  const gateRow = rows.find((row) => row.tbl === null) ?? rows[0];
  return {
    gate: toServeGate(gateRow),
    persisted: toPersistedPushResult(gateRow?.result),
    prefetched: rows.filter(
      (row): row is AdmissionRow & PrefetchRow =>
        row.tbl !== null && row.tbl !== undefined,
    ),
  };
}

/**
 * Insert the `declared` row and raise the fence, on the caller's open
 * transaction. Shared by `declareCheckpoint` and the `ensureSchema`
 * migration so the schema bump and the fence commit together. Never lowers a
 * fence and never re-declares an existing row.
 */
async function hasSourceChangesAboveOn(
  client: PgQueryable,
  partition: string,
  tables: readonly string[],
  seq: number,
): Promise<'clean' | 'changed' | 'unverifiable'> {
  // Read the horizon before the window scan: a horizon past `seq` means the
  // history that would answer the question is gone, so an empty scan proves
  // nothing and must not be reported as `clean`.
  const horizon = await client.query<{ horizon_seq: unknown }>(
    'SELECT horizon_seq FROM sync_partitions WHERE partition=$1',
    [partition],
  );
  const horizonSeq =
    horizon.rows[0] === undefined ? 0 : asNumber(horizon.rows[0].horizon_seq);
  if (tables.length === 0) return 'clean';
  const tableParams = tables.map((_, index) => `$${index + 2}`).join(',');
  const hit = await client.query<{ hit: number }>(
    `SELECT 1 AS hit FROM sync_changes
      WHERE partition=$1 AND tbl IN (${tableParams}) AND commit_seq>$${tables.length + 2}
      LIMIT 1`,
    [partition, ...tables, seq],
  );
  if (hit.rows[0] !== undefined) return 'changed';
  return horizonSeq > seq ? 'unverifiable' : 'clean';
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

interface PostgresCheckpointRecord {
  partition: string;
  name: string;
  schema_version: unknown;
  state: StoredCheckpoint['state'];
  watermark: unknown;
  owner_epoch: unknown;
  observed_rows: unknown;
  updated_at_ms: unknown;
}

function toStoredCheckpoint(
  record: PostgresCheckpointRecord,
): StoredCheckpoint {
  return {
    partition: record.partition,
    name: record.name,
    schemaVersion: asNumber(record.schema_version),
    state: record.state,
    watermark: asNumber(record.watermark),
    ownerEpoch: asNumber(record.owner_epoch),
    observedRows: asNumber(record.observed_rows),
    updatedAtMs: asNumber(record.updated_at_ms),
  };
}

interface PostgresReactionRecord {
  idempotency_key: string;
  type: string;
  version: unknown;
  payload: unknown;
  source_client_id: string;
  source_client_commit_id: string;
  source_commit_seq: unknown;
  created_at_ms: unknown;
  available_at_ms: unknown;
  status: StoredReaction['status'];
  attempts: unknown;
  max_attempts: unknown;
  lease_owner: string | null;
  lease_expires_at_ms: unknown | null;
  completed_at_ms: unknown | null;
  last_failure: unknown | null;
}

function toStoredReaction(record: PostgresReactionRecord): StoredReaction {
  return {
    idempotencyKey: record.idempotency_key,
    type: record.type,
    version: asNumber(record.version),
    payload: asJson(record.payload) as DurableJsonValue,
    sourceClientId: record.source_client_id,
    sourceClientCommitId: record.source_client_commit_id,
    sourceCommitSeq: asNumber(record.source_commit_seq),
    createdAtMs: asNumber(record.created_at_ms),
    maxAttempts: asNumber(record.max_attempts),
    status: record.status,
    attempts: asNumber(record.attempts),
    availableAtMs: asNumber(record.available_at_ms),
    ...(record.lease_owner !== null ? { leaseOwner: record.lease_owner } : {}),
    ...(record.lease_expires_at_ms !== null
      ? { leaseExpiresAtMs: asNumber(record.lease_expires_at_ms) }
      : {}),
    ...(record.completed_at_ms !== null
      ? { completedAtMs: asNumber(record.completed_at_ms) }
      : {}),
    ...(record.last_failure !== null
      ? { lastFailure: asJson(record.last_failure) as ReactionFailure }
      : {}),
  };
}

/**
 * Serialize a push result to a JSON-able object (stored in a JSONB column).
 * `serverRow` bytes are base64-encoded — JSONB cannot hold raw bytes.
 */
function serializePushResult(result: StoredPushResult): unknown {
  return {
    status: result.status,
    ...(result.commitSeq !== undefined ? { commitSeq: result.commitSeq } : {}),
    ...(result.recordedAtMs !== undefined
      ? { recordedAtMs: result.recordedAtMs }
      : {}),
    ...(result.cacheIdentity !== undefined
      ? { cacheIdentity: result.cacheIdentity }
      : {}),
    results: result.results.map((record) => {
      if (record.status === 'conflict') {
        return {
          opIndex: record.opIndex,
          status: record.status,
          code: record.code,
          message: record.message,
          serverVersion: record.serverVersion,
          serverRow: toBase64(record.serverRow),
          conflictColumns: toBase64(record.conflictColumns),
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
  };
}

function deserializePushResult(value: unknown): StoredPushResult {
  const parsed = value as {
    status: 'applied' | 'rejected';
    commitSeq?: number;
    recordedAtMs?: number;
    cacheIdentity?: string;
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
        serverRow: fromBase64(record.serverRow ?? ''),
        conflictColumns: fromBase64(record.conflictColumns ?? ''),
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
    ...(parsed.commitSeq !== undefined ? { commitSeq: parsed.commitSeq } : {}),
    ...(parsed.recordedAtMs !== undefined
      ? { recordedAtMs: parsed.recordedAtMs }
      : {}),
    ...(parsed.cacheIdentity !== undefined
      ? { cacheIdentity: parsed.cacheIdentity }
      : {}),
    results,
  };
}

/**
 * Some drivers return a JSONB column already parsed (pglite, node-postgres);
 * accept a string too for defensiveness.
 */
function asJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

interface RowRecord {
  row_id: string;
  server_version: unknown;
  scopes: unknown;
  payload: unknown;
  column_versions: unknown;
}

interface ChangeRecord {
  tbl: string;
  row_id: string;
  op: unknown;
  row_version: unknown;
  scopes: unknown;
  payload: unknown;
}

/**
 * One result row of `COMMIT_WINDOW_BATCH_SQL` (candidate LEFT JOIN commit meta
 * LEFT JOIN changes): meta/change columns are NULL when the joined row
 * vanished (LEFT JOIN contract).
 */
interface CommitWindowRecord {
  commit_seq: unknown;
  actor_id: string | null;
  created_at_ms: unknown;
  tbl: string | null;
  row_id: string | null;
  op: unknown;
  row_version: unknown;
  scopes: unknown;
  payload: unknown;
}

function toStoredRow(record: RowRecord): StoredRow {
  return {
    rowId: record.row_id,
    serverVersion: asNumber(record.server_version),
    scopes: asJson<Record<string, string>>(record.scopes),
    payload: asBytes(record.payload),
    ...(record.column_versions === null || record.column_versions === undefined
      ? {}
      : { columnVersions: asBytes(record.column_versions) }),
  };
}

function toStoredChange(record: ChangeRecord): StoredChange {
  return {
    table: record.tbl,
    rowId: record.row_id,
    op: asNumber(record.op) === 1 ? 'upsert' : 'delete',
    ...(record.row_version !== null && record.row_version !== undefined
      ? { rowVersion: asNumber(record.row_version) }
      : {}),
    scopes: asJson<Record<string, string>>(record.scopes),
    ...(record.payload !== null && record.payload !== undefined
      ? { payload: asBytes(record.payload) }
      : {}),
  };
}

/**
 * Migration rewrite: keyset-paged walk of a row table inside the migration
 * transaction. When `oldLayout` is
 * given every payload re-encodes under the current columns, and the
 * projection (when materialized) refreshes from the payload either way.
 */
async function rewriteRowsOn(
  q: PgQueryable,
  table: CompiledTable,
  oldLayout: readonly StoredColumnLayout[] | undefined,
): Promise<void> {
  const select = selectRowsForRewriteSql(table, 'postgres');
  // One UPDATE per page: behind a network hop (Hyperdrive, a managed
  // database) every statement is a round trip, and the bump holds the
  // migration lock for its whole duration. The page's rows bind as one
  // VALUES list with typed placeholders (`rewriteValues` order: projection
  // columns, payload, partition, row id).
  const types = [
    ...(table.materialize
      ? table.columns.map((column) => columnSqlType(column, 'postgres'))
      : []),
    'BYTEA',
    'TEXT',
    'TEXT',
  ];
  const projected = table.materialize ? table.columns : [];
  const sets = [
    ...projected.map((column, i) => `${quoteIdent(column.name)}=v.c${i}`),
    `${quoteIdent(SYNC_PAYLOAD_COLUMN)}=v.c${projected.length}`,
  ].join(', ');
  const aliases = types.map((_, i) => `c${i}`).join(', ');
  const partitionAlias = `c${projected.length + 1}`;
  const rowIdAlias = `c${projected.length + 2}`;
  // A page binds types.length parameters per row; PGlite corrupts its state
  // above 32,767 bound parameters (see PG_CHANGES_PER_STATEMENT).
  const batch = Math.max(1, Math.min(500, Math.floor(30_000 / types.length)));
  let afterPartition = '';
  let afterRowId = '';
  for (;;) {
    const { rows } = await q.query<{
      partition: string;
      row_id: string;
      payload: unknown;
    }>(select, [afterPartition, afterRowId, batch]);
    if (rows.length === 0) break;
    const params: unknown[] = [];
    const values = rows.map((row) => {
      const bytes = asBytes(row.payload);
      const payload =
        oldLayout !== undefined
          ? migratePayload(oldLayout, table, bytes)
          : bytes;
      const base = params.length;
      params.push(
        ...rewriteValues(table, row.partition, row.row_id, payload, 'postgres'),
      );
      return `(${types.map((type, i) => `$${base + i + 1}::${type}`).join(',')})`;
    });
    await q.query(
      `UPDATE ${quoteIdent(table.name)} AS t SET ${sets}
         FROM (VALUES ${values.join(',')}) AS v(${aliases})
        WHERE t.${quoteIdent(SYNC_PARTITION_COLUMN)}=v.${partitionAlias}
          AND t.${quoteIdent(SYNC_ROW_ID_COLUMN)}=v.${rowIdAlias}`,
      params,
    );
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < batch) break;
    afterPartition = last.partition;
    afterRowId = last.row_id;
  }
}

/** Shared read/write query logic, parameterized by the queryable in scope. */
async function getRowOn(
  q: PgQueryable,
  compiled: CompiledTable,
  partition: string,
  rowId: string,
): Promise<StoredRow | undefined> {
  const { rows } = await q.query<RowRecord>(
    selectRowSql(compiled, 'postgres'),
    [partition, rowId],
  );
  const record = rows[0];
  return record === undefined ? undefined : toStoredRow(record);
}

async function scanRowsByIndexOn(
  q: PgQueryable,
  compiled: CompiledTable,
  partition: string,
  query: IndexRowScanQuery,
): Promise<StoredRow[]> {
  const index = resolveIndexRowScan(compiled, query);
  const statement = indexRowPageStatement(
    compiled,
    index,
    query.values,
    partition,
    query.afterRowId,
    query.limit,
    'postgres',
  );
  const { rows } = await q.query<RowRecord>(statement.sql, statement.params);
  return rows.map(toStoredRow);
}

/**
 * Write rows of one table in one statement per chunk: the upsert, the scope
 * index synced to each row's scope map (entries outside it deleted, missing
 * ones inserted), and the §5.9.4 blob-reference index synced to the ids the
 * row now references (entries outside the new set deleted, missing ones
 * inserted). Row ids are distinct, so no index entry is touched twice and the
 * writable CTEs cannot conflict. The scopes and blob ids bind as text before
 * the JSONB cast (see `appendCommit`); the refs set is part of the same
 * statement, so a blob-referencing commit costs no extra round trip per row.
 * Every chunk is handed to `q` before the first one settles, so a statement
 * issued after this call queues behind all of them on the transaction FIFO.
 */
function writeRowsOn(
  q: PgQueryable,
  compiled: CompiledTable,
  partition: string,
  rows: readonly {
    readonly row: StoredRow;
    /** `upsertValues` of the row, computed when it was staged. */
    readonly values: readonly unknown[];
  }[],
  blobRefs: readonly {
    readonly rowId: string;
    readonly blobIds: readonly string[];
  }[] = [],
): Promise<unknown> {
  const width = tableColumnNames(compiled).length;
  // PGlite corrupts its state above 32,767 bound parameters (see
  // PG_CHANGES_PER_STATEMENT).
  const chunk = Math.max(1, Math.floor(30_000 / width));
  const pendingRefs = new Map(
    blobRefs.map((entry) => [entry.rowId, entry.blobIds]),
  );
  const writes: Promise<unknown>[] = [];
  for (let first = 0; first < rows.length; first += chunk) {
    const slice = rows.slice(first, first + chunk);
    const params = slice.flatMap((entry) => entry.values);
    const n = params.length;
    const refs: { row_id: string; blob_ids: readonly string[] }[] = [];
    for (const entry of slice) {
      const blobIds = pendingRefs.get(entry.row.rowId);
      if (blobIds === undefined) continue;
      pendingRefs.delete(entry.row.rowId);
      refs.push({ row_id: entry.row.rowId, blob_ids: blobIds });
    }
    writes.push(
      q.query(
        `WITH upserted AS (${upsertSql(compiled, 'postgres', slice.length)}),
         batch AS (
           SELECT row_id, scopes
             FROM jsonb_to_recordset($${n + 1}::text::jsonb) AS r(row_id text, scopes jsonb)
         ),
         scope AS (
           SELECT batch.row_id, entry.key, entry.value
             FROM batch CROSS JOIN LATERAL jsonb_each_text(batch.scopes) AS entry
         ),
         removed AS (
           DELETE FROM sync_row_scopes existing
            USING batch
            WHERE existing.partition=$${n + 2} AND existing.tbl=$${n + 3}
              AND existing.row_id=batch.row_id
              AND batch.scopes->>existing.var IS DISTINCT FROM existing.value
         ),
         changed_refs AS (
           SELECT DISTINCT row_id
             FROM jsonb_to_recordset($${n + 4}::text::jsonb) AS r(row_id text, blob_ids jsonb)
         ),
         removed_refs AS (
           DELETE FROM sync_blob_refs existing
            USING changed_refs
            WHERE existing.partition=$${n + 2} AND existing.tbl=$${n + 3}
              AND existing.row_id=changed_refs.row_id
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_to_recordset($${n + 4}::text::jsonb) AS r(row_id text, blob_ids jsonb)
                  CROSS JOIN LATERAL jsonb_array_elements_text(r.blob_ids) AS entry(value)
                 WHERE r.row_id=existing.row_id AND entry.value=existing.blob_id)
         ),
         inserted_refs AS (
           INSERT INTO sync_blob_refs(partition, tbl, row_id, blob_id)
           SELECT $${n + 2}, $${n + 3}, r.row_id, entry.value
             FROM jsonb_to_recordset($${n + 4}::text::jsonb) AS r(row_id text, blob_ids jsonb)
             CROSS JOIN LATERAL jsonb_array_elements_text(r.blob_ids) AS entry(value)
           ON CONFLICT DO NOTHING
         )
         INSERT INTO sync_row_scopes(partition, tbl, var, value, row_id)
         SELECT $${n + 2}, $${n + 3}, key, value, row_id FROM scope
         ON CONFLICT DO NOTHING`,
        [
          ...params,
          JSON.stringify(
            slice.map(({ row }) => ({ row_id: row.rowId, scopes: row.scopes })),
          ),
          partition,
          compiled.name,
          JSON.stringify(refs),
        ],
      ),
    );
  }
  if (pendingRefs.size > 0) {
    // Refs staged for a row this call did not carry (the row was written by an
    // earlier flush): replace the reference set in one statement of its own.
    writes.push(
      q.query(
        `WITH changed_refs AS (
           SELECT DISTINCT row_id
             FROM jsonb_to_recordset($3::text::jsonb) AS r(row_id text, blob_ids jsonb)
         ),
         removed_refs AS (
           DELETE FROM sync_blob_refs existing
            USING changed_refs
            WHERE existing.partition=$1 AND existing.tbl=$2
              AND existing.row_id=changed_refs.row_id
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_to_recordset($3::text::jsonb) AS r(row_id text, blob_ids jsonb)
                  CROSS JOIN LATERAL jsonb_array_elements_text(r.blob_ids) AS entry(value)
                 WHERE r.row_id=existing.row_id AND entry.value=existing.blob_id)
         )
         INSERT INTO sync_blob_refs(partition, tbl, row_id, blob_id)
         SELECT $1, $2, r.row_id, entry.value
           FROM jsonb_to_recordset($3::text::jsonb) AS r(row_id text, blob_ids jsonb)
           CROSS JOIN LATERAL jsonb_array_elements_text(r.blob_ids) AS entry(value)
         ON CONFLICT DO NOTHING`,
        [
          partition,
          compiled.name,
          JSON.stringify(
            [...pendingRefs].map(([row_id, blob_ids]) => ({
              row_id,
              blob_ids,
            })),
          ),
        ],
      ),
    );
  }
  return Promise.all(writes);
}

async function getPushResultOn(
  q: PgQueryable,
  partition: string,
  clientId: string,
  clientCommitId: string,
): Promise<StoredPushResult | undefined> {
  const { rows } = await q.query<{ result: unknown }>(
    'SELECT result FROM sync_push_results WHERE partition=$1 AND client_id=$2 AND client_commit_id=$3',
    [partition, clientId, clientCommitId],
  );
  return toPersistedPushResult(rows[0]?.result);
}

/** Decode a persisted §2.3 outcome; an unreadable record is a cache miss. */
function toPersistedPushResult(value: unknown): StoredPushResult | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return deserializePushResult(asJson(value));
  } catch {
    throw syncError(
      'sync.idempotency_cache_miss',
      'persisted push result unreadable (§6.3)',
    );
  }
}

/** Run one partition-bound registered query and the cursor read on `client`. */
async function queryAuthoritativeOn(
  client: PgQueryable,
  partition: string,
  prepared: BoundAuthoritativeQuery,
): Promise<AuthoritativeQueryResult> {
  const result = await client.query<Readonly<Record<string, unknown>>>(
    postgresPlaceholders(prepared.sql),
    prepared.params,
  );
  const cursor = await client.query<{ max_commit_seq: unknown }>(
    'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1',
    [partition],
  );
  return {
    rows: result.rows,
    maxCommitSeq:
      cursor.rows[0] === undefined
        ? 0
        : asNumber(cursor.rows[0].max_commit_seq),
  };
}

class PostgresTransaction implements StorageTransaction {
  #client: PgQueryable;
  /** The FIFO without the staged-write prelude (see the constructor). */
  #serial: PgQueryable;
  #partition: string;
  /** Storage-owned relation rewrite, bound to this transaction's partition. */
  readonly #prepareQuery: (
    query: AuthoritativeQueryRequest,
  ) => BoundAuthoritativeQuery;
  /** Schema version this transaction writes; rides every appended commit row. */
  #writerVersion: number;
  #resolveTable: (name: string) => CompiledTable;
  #open = true;
  #pushApplySavepoint = false;
  /**
   * `prefetchRows` results keyed `table\u0000rowId`; `null` records a row
   * (or tombstone) read as absent. A write in this transaction drops the
   * key, so the next read goes to the database again.
   */
  readonly #prefetchedRows = new Map<string, StoredRow | null>();
  readonly #prefetchedTombstones = new Map<string, number | null>();
  /**
   * Upserts staged per table (row id → row and its push operation index).
   * Every statement of this transaction writes them first (see the
   * constructor), so reads and later writes observe them; a commit's rows
   * reach the database as one statement per table instead of one per row.
   * Tables with a unique index write immediately: a violation must name its
   * operation.
   */
  readonly #staged = new Map<
    CompiledTable,
    Map<
      string,
      {
        readonly row: StoredRow;
        readonly values: readonly unknown[];
        readonly opIndex?: number;
      }
    >
  >();
  /**
   * §5.9.4 reference sets staged per table (row id → blob ids). They flush
   * with the table's row statement, so a blob-referencing row costs no extra
   * round trip; a ref set staged for an already-written row flushes on the
   * next statement of its table.
   */
  readonly #stagedBlobRefs = new Map<string, Map<string, readonly string[]>>();
  /**
   * The partition cursor (`max_commit_seq`) read by the first registered
   * query in this transaction. The partition lock freezes it, so later
   * registered queries in the same transaction reuse the value instead of
   * paying a round trip each.
   */
  #cursorSeq: number | undefined;
  /** Resolves/rejects the `transaction(fn)` wrapper (see `begin`). */
  #resolve: () => void;
  #reject: (error: unknown) => void;

  constructor(
    client: PgQueryable,
    partition: string,
    writerVersion: number,
    resolveTable: (name: string) => CompiledTable,
    prepareQuery: (query: AuthoritativeQueryRequest) => BoundAuthoritativeQuery,
    resolve: () => void,
    reject: (error: unknown) => void,
  ) {
    // One pinned connection carries one statement at a time: node-postgres
    // warns about a concurrently issued second query today and rejects it in
    // node-postgres 9. A whole-commit validator that fans independent reads
    // out with Promise.all must not interleave them, so every statement
    // issued through this transaction is chained on one FIFO — the same
    // shape as `SqliteServerStorage.queryAuthoritative`.
    let tail: Promise<void> = Promise.resolve();
    const serial: PgQueryable = {
      query: <Row>(text: string, params?: readonly unknown[]) => {
        const run = tail.then(() => client.query<Row>(text, params));
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    this.#serial = serial;
    this.#client = {
      query: async <Row>(text: string, params?: readonly unknown[]) => {
        // Queue the staged writes ahead of this statement synchronously, so
        // a concurrently issued statement cannot overtake them.
        const staged = this.#writeStaged();
        const run = serial.query<Row>(text, params);
        try {
          await staged;
        } catch (error) {
          // The aborted transaction fails the queued statement too.
          run.catch(() => undefined);
          throw error;
        }
        return run;
      },
    };
    this.#partition = partition;
    this.#writerVersion = writerVersion;
    this.#resolveTable = resolveTable;
    this.#prepareQuery = prepareQuery;
    this.#resolve = resolve;
    this.#reject = reject;
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error('transaction already finished');
  }

  #writeStaged(): Promise<unknown> {
    if (this.#staged.size === 0 && this.#stagedBlobRefs.size === 0) {
      return Promise.resolve();
    }
    const tables = new Set<string>([
      ...[...this.#staged.keys()].map((table) => table.name),
      ...this.#stagedBlobRefs.keys(),
    ]);
    const batches = [...tables].map((table) => {
      const compiled = this.#resolveTable(table);
      const rows = [...(this.#staged.get(compiled)?.values() ?? [])];
      const blobRefs = [
        ...(this.#stagedBlobRefs.get(table)?.entries() ?? []),
      ].map(([rowId, blobIds]) => ({ rowId, blobIds }));
      this.#staged.delete(compiled);
      this.#stagedBlobRefs.delete(table);
      return { table, compiled, rows, blobRefs };
    });
    const writes: Promise<unknown>[] = [];
    // The candidate savepoint lands before the first candidate write, and
    // only when a write actually reaches the database: a commit refused
    // before its first write has no candidate rows to roll back, so its
    // rejection finalization skips the savepoint round trips.
    const savepoint = this.#ensurePushSavepoint();
    if (savepoint !== undefined) writes.push(savepoint);
    for (const { compiled, rows, blobRefs } of batches) {
      writes.push(
        writeRowsOn(
          this.#serial,
          compiled,
          this.#partition,
          rows,
          blobRefs,
        ).catch((error: unknown) => {
          // Staged tables have no unique index, so a violation is a column
          // constraint; it names the first staged operation of the table.
          if (isPostgresConstraintError(error)) {
            throw new StorageConstraintError(error, rows[0]?.opIndex);
          }
          throw error;
        }),
      );
    }
    return Promise.all(writes);
  }

  /**
   * The candidate savepoint, taken before the transaction's first write.
   * Every candidate write must be undoable by `commitRejectedPushResult`, and
   * a refused commit that wrote nothing must not pay to create one.
   */
  #ensurePushSavepoint(): Promise<unknown> | undefined {
    if (this.#pushApplySavepoint) return undefined;
    this.#pushApplySavepoint = true;
    return this.#serial.query('SAVEPOINT syncular_push_candidate');
  }

  getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.#assertOpen();
    const prefetched = this.#prefetchedRows.get(`${table}\u0000${rowId}`);
    if (prefetched !== undefined) {
      return Promise.resolve(prefetched ?? undefined);
    }
    return getRowOn(
      this.#client,
      this.#resolveTable(table),
      this.#partition,
      rowId,
    );
  }

  async prefetchRows(
    targets: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[],
  ): Promise<void> {
    this.#assertOpen();
    const tables: CompiledTable[] = [];
    const specs: { tbl: string; ids: string[] }[] = [];
    for (const target of targets) {
      const ids = [...new Set(target.rowIds)].filter(
        (rowId) => !this.#prefetchedRows.has(`${target.table}\u0000${rowId}`),
      );
      if (ids.length === 0) continue;
      tables.push(this.#resolveTable(target.table));
      specs.push({ tbl: target.table, ids });
    }
    if (specs.length === 0) return;
    const { rows } = await this.#client.query<PrefetchRow>(
      prefetchRowsBatchSql(tables),
      [this.#partition, JSON.stringify(specs)],
    );
    this.#recordPrefetched(rows);
  }

  /** Answer the following `getRow`/`getTombstoneSeq` calls from a read snapshot. */
  #recordPrefetched(records: readonly PrefetchRow[]): void {
    for (const record of records) {
      const key = `${record.tbl}\u0000${record.lookup_id}`;
      this.#prefetchedRows.set(
        key,
        record.row_id === null || record.row_id === undefined
          ? null
          : toStoredRow({ ...record, row_id: record.row_id }),
      );
      this.#prefetchedTombstones.set(
        key,
        record.tombstone_seq === null || record.tombstone_seq === undefined
          ? null
          : asNumber(record.tombstone_seq),
      );
    }
  }

  async getTombstoneSeq(
    table: string,
    rowId: string,
  ): Promise<number | undefined> {
    this.#assertOpen();
    const prefetched = this.#prefetchedTombstones.get(`${table}\u0000${rowId}`);
    if (prefetched !== undefined) return prefetched ?? undefined;
    const { rows } = await this.#client.query<{ commit_seq: unknown }>(
      'SELECT commit_seq FROM sync_tombstones WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
    );
    const seq = rows[0]?.commit_seq;
    return seq === null || seq === undefined ? undefined : asNumber(seq);
  }

  async clearTombstone(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    this.#prefetchedTombstones.delete(`${table}\u0000${rowId}`);
    await this.#ensurePushSavepoint();
    await this.#client.query(
      'DELETE FROM sync_tombstones WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
    );
  }

  async scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    const firstVariable = assertScopeIndexedScan(query);
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    const sql = scanRowPageSql(
      this.#resolveTable(query.table),
      firstValues.length,
      'postgres',
    );
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const { rows: records } = await this.#client.query<RowRecord>(sql, [
        this.#partition,
        query.table,
        firstVariable,
        ...firstValues,
        afterRowId,
        batchSize,
      ]);
      if (records.length === 0) break;
      for (const record of records) {
        afterRowId = record.row_id;
        if (record.payload === null || record.payload === undefined) continue;
        const stored = toStoredRow(record);
        if (!matchesEffective(stored.scopes, query.scopeFilter)) continue;
        rows.push(stored);
        if (rows.length >= query.limit) break;
      }
      if (records.length < batchSize) break;
    }
    return rows;
  }

  scanRowsByIndex(query: IndexRowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    return scanRowsByIndexOn(
      this.#client,
      this.#resolveTable(query.table),
      this.#partition,
      query,
    );
  }

  async queryAuthoritative(
    query: AuthoritativeQueryRequest,
  ): Promise<AuthoritativeQueryResult> {
    this.#assertOpen();
    // Runs on this transaction's pinned client, so the read observes every
    // staged row and never waits for a second pool connection.
    const prepared = this.#prepareQuery(query);
    const result = await this.#client.query<Readonly<Record<string, unknown>>>(
      postgresPlaceholders(prepared.sql),
      prepared.params,
    );
    // The partition lock freezes `max_commit_seq` for the whole transaction,
    // so one read answers every registered query in it.
    if (this.#cursorSeq === undefined) {
      const cursor = await this.#client.query<{ max_commit_seq: unknown }>(
        'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1',
        [this.#partition],
      );
      this.#cursorSeq =
        cursor.rows[0] === undefined
          ? 0
          : asNumber(cursor.rows[0].max_commit_seq);
    }
    return { rows: result.rows, maxCommitSeq: this.#cursorSeq };
  }

  async preparePushApply(
    clientId: string,
    clientCommitId: string,
    runningSchemaVersion: number,
    targets: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[] = [],
  ): Promise<PreparedPushApply> {
    this.#assertOpen();
    // The lock is its own statement: a READ COMMITTED statement's snapshot is
    // fixed at its start, so the admission read must run *after* a duplicate's
    // commit has released the partition lock to observe it. Folding the lock
    // and the read into one statement would miss a duplicate that committed
    // while this transaction waited.
    await lockPartitionOn(this.#client, this.#partition);
    const tables: CompiledTable[] = [];
    const specs: { tbl: string; ids: string[] }[] = [];
    for (const target of targets) {
      const ids = [...new Set(target.rowIds)].filter(
        (rowId) => !this.#prefetchedRows.has(`${target.table}\u0000${rowId}`),
      );
      if (ids.length === 0) continue;
      tables.push(this.#resolveTable(target.table));
      specs.push({ tbl: target.table, ids });
    }
    // One statement: the serve gate, the idempotency record, and the commit's
    // read-ahead (when the caller already knows its targets).
    const admission = await readAdmissionOn(
      this.#client,
      this.#partition,
      clientId,
      clientCommitId,
      runningSchemaVersion,
      specs.length === 0 ? undefined : { tables, specs },
    );
    this.#recordPrefetched(admission.prefetched);
    return { gate: admission.gate, persisted: admission.persisted };
  }

  async advanceCheckpoint(
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    this.#assertOpen();
    await this.#ensurePushSavepoint();
    // `RETURNING`: the affected-row check must not depend on a driver's
    // `rowCount` for a statement with no result rows. Bun.sql's canonical
    // adapter derives `rowCount` from the returned rows, so a bare UPDATE
    // reports 0 and the CAS would never advance on a real Bun.sql host.
    const result = await this.#client.query<{ name: string }>(
      `UPDATE sync_backfill_checkpoints
          SET watermark=$1, observed_rows=$2, updated_at_ms=$3
        WHERE partition=$4 AND name=$5 AND owner_epoch=$6
        RETURNING name`,
      [watermark, observedRows, nowMs, this.#partition, name, ownerEpoch],
    );
    return result.rows.length === 1;
  }

  readServeGate(runningSchemaVersion: number): Promise<ServeGate> {
    this.#assertOpen();
    // The transaction's own client: the gate and the write share one
    // transaction, so a migration cannot interleave between them.
    return readServeGateOn(this.#client, this.#partition, runningSchemaVersion);
  }

  async commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<StoredPushResult> {
    this.#assertOpen();
    // Candidate rows that never reached the database are discarded with the
    // staging map; a savepoint exists only when one did.
    this.#staged.clear();
    this.#stagedBlobRefs.clear();
    if (this.#pushApplySavepoint) {
      await this.#client.query('ROLLBACK TO SAVEPOINT syncular_push_candidate');
      await this.#client.query('RELEASE SAVEPOINT syncular_push_candidate');
      this.#pushApplySavepoint = false;
    }
    const canonical = await this.#insertPushResult(
      clientId,
      clientCommitId,
      result,
    );
    await this.commit();
    return canonical;
  }

  /** Insert the §2.3 outcome and return the canonical persisted value. */
  async #insertPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<StoredPushResult> {
    const { rows } = await this.#client.query<{ result: unknown }>(
      `INSERT INTO sync_push_results(partition, client_id, client_commit_id, result)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (partition, client_id, client_commit_id) DO NOTHING
       RETURNING result`,
      [
        this.#partition,
        clientId,
        clientCommitId,
        JSON.stringify(serializePushResult(result)),
      ],
    );
    if (rows[0] !== undefined) {
      return toPersistedPushResult(rows[0].result) ?? result;
    }
    // `ON CONFLICT DO NOTHING` means a previously committed outcome won; read
    // it rather than claiming this caller's candidate.
    const existing = await getPushResultOn(
      this.#client,
      this.#partition,
      clientId,
      clientCommitId,
    );
    if (existing === undefined) {
      throw new Error('push result insert did not persist an outcome');
    }
    return existing;
  }

  async upsertRow(
    table: string,
    row: StoredRow,
    context?: { readonly opIndex: number },
  ): Promise<void> {
    this.#assertOpen();
    this.#prefetchedRows.delete(`${table}\u0000${row.rowId}`);
    const compiled = this.#resolveTable(table);
    // Decodes the payload: an undecodable row fails here, at its operation.
    const values = upsertValues(compiled, this.#partition, row, 'postgres');
    if (!compiled.indexes.some((index) => index.unique === true)) {
      let rows = this.#staged.get(compiled);
      if (rows === undefined) {
        rows = new Map();
        this.#staged.set(compiled, rows);
      }
      // A later upsert of the same row in this transaction replaces it.
      rows.delete(row.rowId);
      rows.set(row.rowId, {
        row,
        values,
        ...(context === undefined ? {} : { opIndex: context.opIndex }),
      });
      return;
    }
    const refs = this.#stagedBlobRefs.get(table);
    const blobIds = refs?.get(row.rowId);
    if (blobIds !== undefined && refs !== undefined) {
      refs.delete(row.rowId);
      if (refs.size === 0) this.#stagedBlobRefs.delete(table);
    }
    await this.#ensurePushSavepoint();
    try {
      await writeRowsOn(
        this.#client,
        compiled,
        this.#partition,
        [{ row, values }],
        blobIds === undefined ? [] : [{ rowId: row.rowId, blobIds }],
      );
    } catch (error) {
      if (isPostgresConstraintError(error)) {
        throw new StorageConstraintError(error, context?.opIndex);
      }
      throw error;
    }
  }

  async deleteRow(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    this.#prefetchedRows.delete(`${table}\u0000${rowId}`);
    const refs = this.#stagedBlobRefs.get(table);
    refs?.delete(rowId);
    if (refs?.size === 0) this.#stagedBlobRefs.delete(table);
    await this.#ensurePushSavepoint();
    // One statement: the row, its scope-index entries, and (§5.9.4: a
    // deleted row references no blobs) its blob references.
    await this.#client.query(
      `WITH deleted AS (${deleteRowSql(this.#resolveTable(table), 'postgres')}),
       unscoped AS (
         DELETE FROM sync_row_scopes WHERE partition=$1 AND tbl=$3 AND row_id=$2
       )
       DELETE FROM sync_blob_refs WHERE partition=$1 AND tbl=$3 AND row_id=$2`,
      [this.#partition, rowId, table],
    );
  }

  setBlobRefs(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    // Staged with the row: the reference set is replaced in the same
    // statement that writes the row (§5.9.4), inside the commit tx.
    let rows = this.#stagedBlobRefs.get(table);
    if (rows === undefined) {
      rows = new Map();
      this.#stagedBlobRefs.set(table, rows);
    }
    rows.set(rowId, blobIds);
    return Promise.resolve();
  }

  async appendCommit(commit: NewCommit): Promise<number> {
    this.#assertOpen();
    // The commit writes its delete tombstones below.
    this.#prefetchedTombstones.clear();
    // The append advances the partition cursor; a registered query that runs
    // after it must read the new value.
    this.#cursorSeq = undefined;
    const q = this.#client;
    const p = this.#partition;
    // Allocate the next dense commitSeq under a per-partition row lock: the
    // UPDATE … RETURNING serializes concurrent pushes to this partition and
    // never leaves a gap on rollback (see the file header).
    const allocate = `INSERT INTO sync_partitions(partition, max_commit_seq) VALUES ($1, 1)
         ON CONFLICT (partition) DO UPDATE
           SET max_commit_seq = sync_partitions.max_commit_seq + 1
         RETURNING max_commit_seq`;
    const commitRow = `INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms, writer_version)
         SELECT $1, allocated.max_commit_seq, $2, $3, $4, $5, $6 FROM allocated
         RETURNING commit_seq`;
    const head = [
      p,
      commit.clientId,
      commit.clientCommitId,
      commit.actorId,
      commit.createdAtMs,
      this.#writerVersion,
    ];
    if (commit.changes.length === 0) {
      const { rows } = await q.query<{ commit_seq: unknown }>(
        `WITH allocated AS (${allocate}) ${commitRow}`,
        head,
      );
      return asNumber(rows[0]?.commit_seq);
    }
    // §2.2: a delete whose commit follows it with an upsert is a scope move.
    // The row is live, so the tombstone insert below skips it.
    const moved = JSON.stringify(
      [...rowsLiveAfterDelete(commit.changes)].map((key) => {
        const at = key.indexOf('\u0000');
        return { tbl: key.slice(0, at), row_id: key.slice(at + 1) };
      }),
    );
    // One writable-CTE chain per chunk of changes: the changes, their
    // inverted scope entries, and the §5 delete tombstones. A statement binds
    // at most a 16-bit count of parameters, so a chunk carries
    // PG_CHANGES_PER_STATEMENT changes. The first chunk folds the allocation,
    // the commit row, and the change-log write into one statement; later
    // chunks run under the same commitSeq with their global idx. Serialized
    // scopes bind as text before parsing JSONB; drivers that encode JSONB
    // parameters would otherwise store the string as a scalar. A commit can
    // delete one row twice, so a chunk's tombstone insert keeps one row per
    // key and a later chunk updates it to the same commit_seq.
    const valuesOf = (
      params: unknown[],
      slice: readonly NewChange[],
      firstIdx: number,
    ): string[] =>
      slice.map((change, offset) => {
        const base = params.length;
        params.push(
          firstIdx + offset,
          change.table,
          change.rowId,
          change.op === 'upsert' ? 1 : 2,
          change.rowVersion ?? null,
          JSON.stringify(change.scopes),
          change.payload ?? null,
        );
        return `($${base + 1}::int,$${base + 2}::text,$${base + 3}::text,$${base + 4}::smallint,$${base + 5}::bigint,$${base + 6}::text::jsonb,$${base + 7}::bytea)`;
      });
    const scopesCte = `scoped AS (
           INSERT INTO sync_change_scopes(partition, tbl, var, value, commit_seq)
           SELECT inserted.partition, inserted.tbl, scope.key, scope.value, inserted.commit_seq
           FROM inserted CROSS JOIN LATERAL jsonb_each_text(inserted.scopes) AS scope
           ON CONFLICT DO NOTHING
         )`;
    const tombstones = (
      movedParam: string,
    ) => `INSERT INTO sync_tombstones(partition, tbl, row_id, commit_seq)
         SELECT DISTINCT ON (tbl, row_id) partition, tbl, row_id, commit_seq
           FROM inserted
          WHERE op = 2
            AND NOT EXISTS (
              SELECT 1
                FROM jsonb_to_recordset(${movedParam}::text::jsonb) AS moved(tbl text, row_id text)
               WHERE moved.tbl = inserted.tbl AND moved.row_id = inserted.row_id)
         ON CONFLICT (partition, tbl, row_id)
         DO UPDATE SET commit_seq = excluded.commit_seq`;
    const firstSlice = commit.changes.slice(0, PG_CHANGES_PER_STATEMENT);
    const params = [...head];
    const values = valuesOf(params, firstSlice, 0);
    params.push(moved);
    const movedParam = `$${params.length}`;
    const { rows } = await q.query<{ max_commit_seq: unknown }>(
      `WITH allocated AS (${allocate}),
       allocated_commit AS (${commitRow}),
       inserted AS (
         INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload)
         SELECT $1, allocated.max_commit_seq, v.idx, v.tbl, v.row_id, v.op, v.row_version, v.scopes, v.payload
           FROM allocated
           CROSS JOIN (VALUES ${values.join(',')}) AS v(idx, tbl, row_id, op, row_version, scopes, payload)
         RETURNING partition, tbl, row_id, op, commit_seq, scopes
       ),
       ${scopesCte},
       tombstoned AS (${tombstones(movedParam)})
       SELECT max_commit_seq FROM allocated`,
      params,
    );
    const commitSeq = asNumber(rows[0]?.max_commit_seq);
    for (
      let first = PG_CHANGES_PER_STATEMENT;
      first < commit.changes.length;
      first += PG_CHANGES_PER_STATEMENT
    ) {
      const chunkParams: unknown[] = [p, commitSeq];
      const chunkValues = valuesOf(
        chunkParams,
        commit.changes.slice(first, first + PG_CHANGES_PER_STATEMENT),
        first,
      );
      chunkParams.push(moved);
      const chunkMovedParam = `$${chunkParams.length}`;
      await q.query(
        `WITH inserted AS (
           INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload)
           SELECT $1, $2, v.idx, v.tbl, v.row_id, v.op, v.row_version, v.scopes, v.payload
             FROM (VALUES ${chunkValues.join(',')}) AS v(idx, tbl, row_id, op, row_version, scopes, payload)
           RETURNING partition, tbl, row_id, op, commit_seq, scopes
         ),
         ${scopesCte},
         tombstoned AS (${tombstones(chunkMovedParam)})
         SELECT 1`,
        chunkParams,
      );
    }
    return commitSeq;
  }

  async putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
  ): Promise<void> {
    this.#assertOpen();
    await this.#client.query(
      `INSERT INTO sync_push_results(partition, client_id, client_commit_id, result)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (partition, client_id, client_commit_id) DO NOTHING`,
      [
        this.#partition,
        clientId,
        clientCommitId,
        JSON.stringify(serializePushResult(result)),
      ],
    );
  }

  async enqueueReactions(reactions: readonly NewReaction[]): Promise<void> {
    this.#assertOpen();
    for (const reaction of reactions) {
      await this.#client.query(
        `INSERT INTO sync_reactions(
           partition, idempotency_key, type, version, payload,
           source_client_id, source_client_commit_id, source_commit_seq,
           created_at_ms, available_at_ms, status, attempts, max_attempts
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'pending',0,$10)`,
        [
          this.#partition,
          reaction.idempotencyKey,
          reaction.type,
          reaction.version,
          JSON.stringify(reaction.payload),
          reaction.sourceClientId,
          reaction.sourceClientCommitId,
          reaction.sourceCommitSeq,
          reaction.createdAtMs,
          reaction.maxAttempts,
        ],
      );
    }
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    await this.#writeStaged();
    this.#open = false;
    // Signal the transaction wrapper to COMMIT; wait for it to actually land.
    this.#resolve();
    await this.#done;
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;
    this.#staged.clear();
    this.#open = false;
    this.#reject(new RollbackSignal());
    // Swallow — a rollback is a normal outcome, not an error to the caller.
    await this.#done.catch(() => {});
  }

  /** Set by `begin`: resolves when BEGIN…COMMIT/ROLLBACK has fully landed. */
  #done!: Promise<void>;
  _attachDone(done: Promise<void>): void {
    this.#done = done;
  }
}

/** Internal marker: a caller-requested rollback, not a real failure. */
class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}

/** Changes per sync_changes statement: 2 + 7 × 4,096 = 28,674 bound
 * parameters. The Bind message counts parameters in 16 bits; PostgreSQL reads
 * up to 65,535, and PGlite 0.5 corrupts its state above 32,767. */
const PG_CHANGES_PER_STATEMENT = 4096;

/** One page read waiting in `PostgresServerStorage#batchedPage`. */
interface PendingPage {
  readonly spec: Record<string, unknown>;
  readonly resolve: (rows: PgRow[]) => void;
  readonly reject: (error: unknown) => void;
}

export class PostgresServerStorage implements ServerStorage {
  readonly #exec: PgExecutor;
  /** Set by `ensureSchema`: app-table lookup for the relational row store. */
  #tables: ReadonlyMap<string, CompiledTable> | undefined;
  #schemaVersion: number | undefined;
  /**
   * Page reads waiting for the end of the current microtask turn, keyed by
   * batch stream and partition. A pull starts the window read (or first
   * snapshot page) of every subscription before awaiting any of them, so the
   * reads of all tables leave as ONE set-based statement per stream instead
   * of one round trip per subscription or table
   * (SYNCULAR-PULL-ROUNDTRIPS-001).
   */
  readonly #pageBatches = new Map<string, PendingPage[]>();

  constructor(exec: PgExecutor) {
    this.#exec = exec;
  }

  /**
   * Queue one page read into the batch for (`key`, `partition`). `sql` is the
   * statement every batch of that stream shares, or a builder over the queued
   * specs when the statement names what the batch contains (the snapshot scan
   * joins one branch per table present). The batch runs as a single statement
   * with the queued specs bound as a JSON array (`$2`); each spec gets its
   * position as `i`, and the result rows are split back by their `sub`
   * column.
   */
  #batchedPage<Row>(
    key: string,
    sql: string | ((specs: readonly Record<string, unknown>[]) => string),
    partition: string,
    spec: Record<string, unknown>,
  ): Promise<Row[]> {
    const batchKey = `${key}\u0000${partition}`;
    let batch = this.#pageBatches.get(batchKey);
    if (batch === undefined) {
      const queued: PendingPage[] = [];
      batch = queued;
      this.#pageBatches.set(batchKey, queued);
      queueMicrotask(() => {
        this.#pageBatches.delete(batchKey);
        const specs = queued.map((entry, i) => ({ ...entry.spec, i }));
        const statement = typeof sql === 'string' ? sql : sql(specs);
        this.#exec
          .query<PgRow>(statement, [partition, JSON.stringify(specs)])
          .then(
            ({ rows }) => {
              const grouped = queued.map((): PgRow[] => []);
              for (const row of rows) grouped[asNumber(row.sub)]?.push(row);
              queued.forEach((entry, i) => entry.resolve(grouped[i] ?? []));
            },
            (error: unknown) => {
              for (const entry of queued) entry.reject(error);
            },
          );
      });
    }
    const target = batch;
    return new Promise<Row[]>((resolve, reject) => {
      target.push({
        spec,
        resolve: (rows) => resolve(rows as Row[]),
        reject,
      });
    });
  }

  /**
   * Apply the schema DDL (idempotent). Call once before use. The last
   * statement records a fingerprint of the applied DDL as the comment of
   * `sync_schema_meta`; a database that carries the current fingerprint
   * costs one catalog read instead of the DDL round trips, so a new storage
   * instance (a Worker isolate, a Durable Object wake) starts fast.
   */
  async migrate(): Promise<void> {
    // Split on the statement boundary so drivers that reject multi-statement
    // query strings (node-postgres extended protocol) still apply each DDL.
    // The fence function is sent whole because its dollar-quoted body
    // contains `;`.
    const statements = [
      ...POSTGRES_DDL.split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      'ALTER TABLE sync_commits ADD COLUMN IF NOT EXISTS writer_version BIGINT',
      // Database-side fence: an old binary's INSERT never reaches JS. An
      // absent `sync_writer_fence` row makes the EXISTS false, so a partition
      // with no barrier behaves exactly as before.
      `CREATE OR REPLACE FUNCTION syncular_writer_fence()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sync_writer_fence
     WHERE partition = NEW.partition
       AND (NEW.writer_version IS NULL
            OR NEW.writer_version < required_writer_version)
  ) THEN
    RAISE EXCEPTION 'sync.storage.writer_fence_rejected';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
      'DROP TRIGGER IF EXISTS sync_commits_writer_fence ON sync_commits',
      `CREATE TRIGGER sync_commits_writer_fence
BEFORE INSERT ON sync_commits
FOR EACH ROW EXECUTE FUNCTION syncular_writer_fence()`,
      SCHEMA_META_DDL_POSTGRES,
    ];
    const fingerprint = `syncular.storage:${await sha256Hex(
      new TextEncoder().encode(statements.join('\u0000')),
    )}`;
    // `obj_description` and `to_regclass` of a missing table are NULL, so
    // the probe never fails. A core table dropped out of band reapplies the
    // DDL even under the current fingerprint.
    const { rows } = await this.#exec.query<{
      storage: string | null;
      missing: number;
    }>(
      `SELECT obj_description(to_regclass('sync_schema_meta'), 'pg_class') AS storage,
              (SELECT count(*)::int
                 FROM jsonb_array_elements_text($1::text::jsonb) AS core(name)
                WHERE to_regclass(core.name) IS NULL) AS missing`,
      [
        JSON.stringify(
          statements.flatMap(
            (statement) =>
              /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1] ?? [],
          ),
        ),
      ],
    );
    if (rows[0]?.storage === fingerprint && rows[0].missing === 0) return;
    for (const statement of statements) {
      await this.#exec.query(statement);
    }
    // The fingerprint is lowercase hex, safe to inline (COMMENT takes no
    // bound parameter).
    await this.#exec.query(
      `COMMENT ON TABLE sync_schema_meta IS '${fingerprint}'`,
    );
  }

  /** Resolve a table's compiled schema; row operations require `ensureSchema`. */
  table(name: string): CompiledTable {
    const table = this.#tables?.get(name);
    if (table === undefined) {
      throw new Error(
        `unknown table ${JSON.stringify(name)} — ensureSchema(schema) must run before row operations`,
      );
    }
    return table;
  }

  async ensureSchema(
    schema: CompiledSchema,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<void> {
    // Memoized fast path: same instance, same schema version.
    if (this.#schemaVersion === schema.version) return;
    await this.migrate();
    // One statement reads the marker, the incomplete checkpoints of this
    // version and the physical columns of every app table. The aggregates
    // leave as text so every driver hands back the same JSON strings.
    // Columns resolve through `to_regclass`, which follows the session's
    // `search_path` exactly as the unqualified row queries do:
    // `current_schema()` names only the first existing schema, so it would
    // reject a table that resolves later in the path.
    const { rows: probe } = await this.#exec.query<{
      schema_version: unknown;
      layouts: unknown;
      incomplete: string;
      columns: string;
      indexes: string;
    }>(
      `SELECT meta.schema_version AS schema_version, meta.layouts AS layouts,
              (SELECT coalesce(json_agg(json_build_object(
                        'partition', checkpoint.partition,
                        'name', checkpoint.name)), '[]'::json)::text
                 FROM sync_backfill_checkpoints checkpoint
                WHERE checkpoint.schema_version=$1
                  AND checkpoint.state<>'activated') AS incomplete,
              (SELECT coalesce(json_agg(json_build_object(
                        'tbl', tables.name,
                        'name', attribute.attname,
                        'type', format_type(attribute.atttypid, attribute.atttypmod),
                        'not_null', attribute.attnotnull,
                        'pk', (SELECT key.position::int
                                 FROM pg_index pk,
                                      unnest(pk.indkey::int2[]) WITH ORDINALITY
                                        AS key(attnum, position)
                                WHERE pk.indrelid = attribute.attrelid
                                  AND pk.indisprimary
                                  AND key.attnum = attribute.attnum))
                        ORDER BY tables.name, attribute.attnum), '[]'::json)::text
                 FROM jsonb_array_elements_text($2::text::jsonb) AS tables(name)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = to_regclass(tables.name)
                WHERE attribute.attnum > 0
                  AND NOT attribute.attisdropped) AS columns,
              ${indexesSubquery('$2')} AS indexes
         FROM (SELECT 1) AS one
         LEFT JOIN sync_schema_meta meta ON meta.id=1`,
      [schema.version, JSON.stringify([...schema.tables.keys()])],
    );
    const marker = probe[0];
    if (marker === undefined) {
      throw new Error('schema probe returned no row');
    }
    // The barrier reads stored state: a checkpoint at this schema version that
    // is not activated and that this caller did not declare means this process
    // must not serve. An omitted or empty declaration set declares nothing and
    // is refused here, never treated as a bypass.
    const declarations = checkpoints ?? [];
    const incomplete = JSON.parse(marker.incomplete) as {
      partition: string;
      name: string;
    }[];
    if (
      incomplete.some(
        (row) =>
          !declarations.some(
            (declaration) =>
              declaration.partition === row.partition &&
              declaration.name === row.name,
          ),
      )
    ) {
      throw new StorageQueryError('sync.storage.checkpoint_incomplete');
    }
    const stored =
      marker.schema_version === null || marker.schema_version === undefined
        ? undefined
        : asNumber(marker.schema_version);
    if (stored !== undefined && stored > schema.version) {
      throw new Error(
        `stored schema version ${stored} is newer than the configured schema (${schema.version}) — refusing to run an older server against a migrated database`,
      );
    }
    if (stored !== undefined && stored === schema.version) {
      assertStoredLayouts(
        schema,
        typeof marker.layouts === 'string' ? marker.layouts : undefined,
      );
      const columns = JSON.parse(marker.columns) as {
        tbl: string;
        name: string;
        type: string;
        not_null: boolean;
        pk: number | null;
      }[];
      for (const table of schema.tables.values()) {
        assertPhysicalColumns(
          table,
          columns
            .filter((column) => column.tbl === table.name)
            .map((column) => ({
              name: column.name,
              type: column.type,
              notNull: column.not_null,
              primaryKeyPosition: column.pk ?? 0,
            })),
          'postgres',
        );
      }
      // Server-only indexes reconcile at every open of a database already at
      // this version: they never reach a client, so no version bump is needed.
      // The unlocked read finds the common no-op case; the diff is recomputed
      // under the migration barrier before any DDL runs.
      const reconcile = serverIndexDdl(
        schema,
        parseIndexSignatures(marker.indexes),
      );
      if (reconcile.length > 0) {
        await this.#exec.transaction(async (client) => {
          await client.query('LOCK TABLE sync_partitions IN EXCLUSIVE MODE');
          for (const statement of serverIndexDdl(
            schema,
            await readIndexSignatures(client, [...schema.tables.keys()]),
          )) {
            await client.query(statement);
          }
        });
      }
    }
    if (stored === undefined || stored < schema.version) {
      // Introspect existing app tables, apply the migration subset
      // (CREATE TABLE / ADD COLUMN / rebuild indexes), then rewrite stored
      // rows (payload re-encode for layout changes and/or projection
      // backfill for flipped-on materialization) — all inside one
      // transaction (Postgres DDL is transactional — a failed bump leaves
      // no half-state).
      await this.#exec.transaction(async (client) => {
        // RFC 0007 migration barrier: `LOCK TABLE ... EXCLUSIVE` is the FIRST
        // statement, before any read, DDL, rewrite, marker or checkpoint
        // install. EXCLUSIVE conflicts with the ROW SHARE that every writer's
        // `lockPartitionOn` takes (`SELECT … FOR UPDATE`) and with the ROW
        // EXCLUSIVE of its allocation (`UPDATE sync_partitions` / `INSERT … ON
        // CONFLICT DO UPDATE`), so an unaware old writer blocks at its first
        // statement with no cooperation; plain `SELECT` (ACCESS SHARE) still
        // works. The lock order is acyclic: the migration holds nothing else
        // when it takes this lock, so a writer already inside completes while
        // the migration waits.
        await client.query('LOCK TABLE sync_partitions IN EXCLUSIVE MODE');
        // The probe ran before the lock. A concurrent `ensureSchema` (another
        // isolate, the Durable Object's first request) may have bumped while
        // this one waited; re-running the rewrite would decode its new-layout
        // payloads with the old layout. The locked marker decides.
        const { rows: lockedMarker } = await client.query<{
          schema_version: unknown;
          layouts: unknown;
        }>('SELECT schema_version, layouts FROM sync_schema_meta WHERE id=1');
        const lockedVersion =
          lockedMarker[0]?.schema_version === null ||
          lockedMarker[0]?.schema_version === undefined
            ? undefined
            : asNumber(lockedMarker[0].schema_version);
        if (lockedVersion !== undefined && lockedVersion > schema.version) {
          throw new Error(
            `stored schema version ${lockedVersion} is newer than the configured schema (${schema.version}) — refusing to run an older server against a migrated database`,
          );
        }
        if (lockedVersion === schema.version) return;
        const layouts = parseLayouts(
          typeof lockedMarker[0]?.layouts === 'string'
            ? lockedMarker[0].layouts
            : undefined,
        );
        const retiredTables = retiredTableNames(schema, layouts);
        const existing = new Map<string, ReadonlySet<string>>();
        const existingIndexes = new Map<string, ReadonlyMap<string, string>>();
        const tableIndexes = await readIndexSignatures(client, [
          ...schema.tables.keys(),
        ]);
        for (const table of schema.tables.values()) {
          const { rows } = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1`,
            [table.name],
          );
          if (rows.length > 0) {
            existing.set(table.name, new Set(rows.map((r) => r.column_name)));
            existingIndexes.set(
              table.name,
              tableIndexes.get(table.name) ?? new Map(),
            );
          }
        }
        if (retiredTables.length > 0) {
          // Neither index leads with `tbl`: one scan per table, not one per
          // retired table.
          await client.query(
            `DELETE FROM sync_row_scopes
              WHERE tbl IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
            [JSON.stringify(retiredTables)],
          );
          await client.query(
            `DELETE FROM sync_blob_refs
              WHERE tbl IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
            [JSON.stringify(retiredTables)],
          );
        }
        for (const tableName of retiredTables) {
          await client.query(dropTableDdl(tableName));
        }
        for (const statement of schemaDdl(
          schema,
          existing,
          'postgres',
          existingIndexes,
        )) {
          await client.query(statement);
        }
        for (const table of schema.tables.values()) {
          const oldLayout = layouts[table.name];
          const plan = rewritePlan(table, oldLayout, existing.get(table.name));
          if (!plan.migrate && !plan.backfill) continue;
          await rewriteRowsOn(
            client,
            table,
            plan.migrate ? oldLayout : undefined,
          );
        }
        await client.query(
          `INSERT INTO sync_schema_meta(id, schema_version, layouts) VALUES (1, $1, $2)
           ON CONFLICT (id) DO UPDATE
             SET schema_version=EXCLUDED.schema_version, layouts=EXCLUDED.layouts`,
          [schema.version, layoutsOf(schema)],
        );
        // A writer of the previous schema still running against this
        // database would append payloads in the previous layout. Its push
        // is refused by the serve gate, but a host's server-side
        // `begin()`/`appendCommit` reads no gate, so the bump raises the
        // writer fence of every partition to the new version.
        await client.query(
          `INSERT INTO sync_writer_fence(partition, required_writer_version)
           SELECT partition, $1 FROM sync_partitions
           ON CONFLICT (partition) DO UPDATE SET
             required_writer_version=GREATEST(
               sync_writer_fence.required_writer_version,
               EXCLUDED.required_writer_version)`,
          [schema.version],
        );
        // The host's declared checkpoints install in the schema-bump
        // transaction, so no observer sees the bumped marker without the
        // fence, or the fence without its declaration row.
        const installedAtMs = Date.now();
        for (const declaration of checkpoints ?? []) {
          await installCheckpointOn(
            client,
            declaration.partition,
            declaration.name,
            declaration.schemaVersion,
            installedAtMs,
          );
        }
      });
    }
    this.#tables = schema.tables;
    this.#schemaVersion = schema.version;
  }

  async touchPartition(
    partition: string,
    authenticatedAtMs: number,
    initialLogEpoch: string,
  ): Promise<PartitionRegistryEntry> {
    if (initialLogEpoch.length === 0) {
      throw new Error('initial log epoch must be non-empty');
    }
    type Registry = {
      log_epoch: string;
      epoch_required: boolean;
      last_authenticated_at_ms: unknown;
    };
    let row = (
      await this.#exec.query<Registry>(
        `SELECT log_epoch, epoch_required, last_authenticated_at_ms
           FROM sync_partition_registry WHERE partition=$1`,
        [partition],
      )
    ).rows[0];
    if (
      row === undefined ||
      authenticatedAtMs - asNumber(row.last_authenticated_at_ms) >=
        PARTITION_TOUCH_INTERVAL_MS
    ) {
      row = (
        await this.#exec.query<Registry>(
          `INSERT INTO sync_partition_registry(
             partition, log_epoch, last_authenticated_at_ms
           ) VALUES ($1,$2,$3)
           ON CONFLICT(partition) DO UPDATE SET
             last_authenticated_at_ms=EXCLUDED.last_authenticated_at_ms
           RETURNING log_epoch, epoch_required, last_authenticated_at_ms`,
          [partition, initialLogEpoch, authenticatedAtMs],
        )
      ).rows[0];
    }
    if (row === undefined)
      throw new Error('partition registry write did not persist');
    return {
      partition,
      logEpoch: row.log_epoch,
      epochRequired: row.epoch_required,
      lastAuthenticatedAtMs: asNumber(row.last_authenticated_at_ms),
    };
  }

  async rotatePartitionLogEpoch(
    partition: string,
    logEpoch: string,
    authenticatedAtMs: number,
  ): Promise<PartitionRegistryEntry> {
    if (logEpoch.length === 0) throw new Error('log epoch must be non-empty');
    await this.#exec.transaction(async (client) => {
      await lockPartitionOn(client, partition);
      await client.query(
        `INSERT INTO sync_partition_registry(
           partition, log_epoch, epoch_required, last_authenticated_at_ms
         ) VALUES ($1,$2,TRUE,$3)
         ON CONFLICT(partition) DO UPDATE SET
           log_epoch=EXCLUDED.log_epoch,
           epoch_required=TRUE,
           last_authenticated_at_ms=EXCLUDED.last_authenticated_at_ms`,
        [partition, logEpoch, authenticatedAtMs],
      );
      await client.query('DELETE FROM sync_clients WHERE partition=$1', [
        partition,
      ]);
    });
    return {
      partition,
      logEpoch,
      epochRequired: true,
      lastAuthenticatedAtMs: authenticatedAtMs,
    };
  }

  async listPartitionRegistry(): Promise<PartitionRegistryEntry[]> {
    const { rows } = await this.#exec.query<{
      partition: string;
      log_epoch: string;
      epoch_required: boolean;
      last_authenticated_at_ms: unknown;
    }>(
      `SELECT partition, log_epoch, epoch_required, last_authenticated_at_ms
         FROM sync_partition_registry ORDER BY partition`,
      [],
    );
    return rows.map((row) => ({
      partition: row.partition,
      logEpoch: row.log_epoch,
      epochRequired: row.epoch_required,
      lastAuthenticatedAtMs: asNumber(row.last_authenticated_at_ms),
    }));
  }

  /**
   * Open a real Postgres transaction. The push handler drives the returned
   * `StorageTransaction` imperatively (getRow/upsert/…/commit), but the
   * driver seam models a transaction as a callback scope. We bridge the two:
   * `transaction(fn)` blocks inside `fn` on a promise that the imperative
   * `commit()`/`rollback()` resolves/rejects, so BEGIN…COMMIT wraps exactly
   * the handler's writes on one pinned connection.
   */
  async begin(partition: string): Promise<StorageTransaction> {
    let resolveReady!: (tx: PostgresTransaction) => void;
    const ready = new Promise<PostgresTransaction>((r) => {
      resolveReady = r;
    });
    let resolveScope!: () => void;
    let rejectScope!: (error: unknown) => void;
    const scope = new Promise<void>((res, rej) => {
      resolveScope = res;
      rejectScope = rej;
    });
    const done = this.#exec
      .transaction(async (client) => {
        const tx = new PostgresTransaction(
          client,
          partition,
          this.#schemaVersion ?? 0,
          (name) => this.table(name),
          (query) => this.#prepareAuthoritativeQuery(partition, query),
          resolveScope,
          rejectScope,
        );
        resolveReady(tx);
        // Hold the transaction open until commit()/rollback() settles `scope`.
        await scope;
      })
      .catch((error: unknown) => {
        if (error instanceof RollbackSignal) return;
        throw error;
      });
    const tx = await ready;
    tx._attachDone(done);
    return tx;
  }

  async getMaxCommitSeq(partition: string): Promise<number> {
    const { rows } = await this.#exec.query<{ max_commit_seq: unknown }>(
      'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1',
      [partition],
    );
    return rows[0] === undefined ? 0 : asNumber(rows[0].max_commit_seq);
  }

  #prepareAuthoritativeQuery(
    partition: string,
    query: AuthoritativeQueryRequest,
  ): BoundAuthoritativeQuery {
    if (this.#tables === undefined) {
      throw new Error(
        'ensureSchema(schema) must run before registered queries',
      );
    }
    return bindAuthoritativePartition(
      prepareAuthoritativeQuery(
        query.plan,
        query.params,
        query.tables,
        this.#tables,
      ),
      partition,
    );
  }

  async queryAuthoritative(
    partition: string,
    query: AuthoritativeQueryRequest,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<AuthoritativeQueryResult> {
    const prepared = this.#prepareAuthoritativeQuery(partition, query);
    return this.#exec.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      // RFC 0007: evaluate the gate inside this pinned snapshot, so a
      // migration or an epoch rotation cannot land between the gate read and
      // the query's own read. The registered-query path uses the pinned
      // snapshot, not a request-entry check.
      const runningVersion = this.#schemaVersion ?? 0;
      const gate = await readServeGateOn(client, partition, runningVersion);
      const refusal = serveGateRefusal(gate, runningVersion, checkpoints);
      if (refusal !== undefined) throw serveNotReadyError(refusal);
      return queryAuthoritativeOn(client, partition, prepared);
    });
  }

  async getPartitionLogEpoch(partition: string): Promise<string | undefined> {
    const { rows } = await this.#exec.query<{ log_epoch: string }>(
      'SELECT log_epoch FROM sync_partition_registry WHERE partition=$1',
      [partition],
    );
    return rows[0]?.log_epoch;
  }

  async getHorizonSeq(partition: string): Promise<number> {
    const { rows } = await this.#exec.query<{ horizon_seq: unknown }>(
      'SELECT horizon_seq FROM sync_partitions WHERE partition=$1',
      [partition],
    );
    return rows[0] === undefined ? 0 : asNumber(rows[0].horizon_seq);
  }

  async setHorizonSeq(partition: string, seq: number): Promise<void> {
    await this.#exec.query(
      `INSERT INTO sync_partitions(partition, horizon_seq) VALUES ($1,$2)
       ON CONFLICT (partition) DO UPDATE SET horizon_seq=GREATEST(sync_partitions.horizon_seq,EXCLUDED.horizon_seq)`,
      [partition, seq],
    );
  }

  async pruneCommitsThrough(
    partition: string,
    query: CommitPruneQuery,
  ): Promise<CommitPruneResult> {
    validateCommitPruneQuery(query);
    return this.#exec.transaction(async (client) => {
      await lockPartitionOn(client, partition);
      const epoch = await client.query<{ log_epoch: string }>(
        'SELECT log_epoch FROM sync_partition_registry WHERE partition=$1 FOR UPDATE',
        [partition],
      );
      if (epoch.rows[0]?.log_epoch !== query.logEpoch)
        throw new StorageQueryError('sync.storage.prune_epoch_mismatch');
      const previous = await client.query<{ horizon_seq: unknown }>(
        'SELECT horizon_seq FROM sync_partitions WHERE partition=$1',
        [partition],
      );
      const previousHorizonSeq = asNumber(previous.rows[0]?.horizon_seq);
      const horizonSeq = Math.max(previousHorizonSeq, query.throughSeq);
      await client.query(
        'UPDATE sync_partitions SET horizon_seq=$2 WHERE partition=$1',
        [partition, horizonSeq],
      );
      const removed = await client.query(
        'DELETE FROM sync_commits WHERE partition=$1 AND commit_seq<=$2',
        [partition, horizonSeq],
      );
      await client.query(
        'DELETE FROM sync_changes WHERE partition=$1 AND commit_seq<=$2',
        [partition, horizonSeq],
      );
      await client.query(
        'DELETE FROM sync_change_scopes WHERE partition=$1 AND commit_seq<=$2',
        [partition, horizonSeq],
      );
      // §4.6: tombstones prune in the same pass as the commit log.
      await client.query(
        'DELETE FROM sync_tombstones WHERE partition=$1 AND commit_seq<=$2',
        [partition, horizonSeq],
      );
      return {
        previousHorizonSeq,
        horizonSeq,
        removedCommits: removed.rowCount,
      };
    });
  }

  async getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number> {
    const { rows } = await this.#exec.query<{ seq: unknown }>(
      'SELECT max(commit_seq) AS seq FROM sync_commits WHERE partition=$1 AND created_at_ms<$2',
      [partition, createdBeforeMs],
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? 0 : asNumber(seq);
  }

  async readCheckpoints(partition: string): Promise<StoredCheckpoint[]> {
    const { rows } = await this.#exec.query<PostgresCheckpointRecord>(
      `SELECT partition, name, schema_version, state, watermark,
              owner_epoch, observed_rows, updated_at_ms
         FROM sync_backfill_checkpoints WHERE partition=$1 ORDER BY name`,
      [partition],
    );
    return rows.map(toStoredCheckpoint);
  }

  async readServeGate(
    partition: string,
    runningSchemaVersion: number,
  ): Promise<ServeGate> {
    return readServeGateOn(this.#exec, partition, runningSchemaVersion);
  }

  async declareCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint> {
    // One transaction: the checkpoint becomes visible and the fence that
    // protects it is raised together. The fence is raised at declaration, not
    // at activation, so old writers are rejected for the whole backfill.
    //
    // RFC 0007 lock decision: this transaction writes only the checkpoint and
    // fence rows, no application rows and no schema marker, so it does not
    // take the migration table lock or a partition lock. The fence it raises is
    // enforced by the `sync_commits` trigger on every append from the commit
    // of this transaction onward; a writer that committed before the fence was
    // visible is pre-barrier by the design's own "from declaration onward"
    // rule, not a bypass of it.
    return this.#exec.transaction(async (client) => {
      await installCheckpointOn(client, partition, name, schemaVersion, nowMs);
      const { rows } = await client.query<PostgresCheckpointRecord>(
        `SELECT partition, name, schema_version, state, watermark,
                owner_epoch, observed_rows, updated_at_ms
           FROM sync_backfill_checkpoints WHERE partition=$1 AND name=$2`,
        [partition, name],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new StorageQueryError('sync.storage.checkpoint_not_declared');
      }
      return toStoredCheckpoint(row);
    });
  }

  async activateCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    sources: readonly string[],
    nowMs: number,
  ): Promise<'activated' | 'stale' | 'unverifiable'> {
    return this.#exec.transaction(async (client) => {
      // The same `SELECT … FOR UPDATE` partition row lock that
      // `preparePushApply` takes; a bare `BEGIN` would race a push.
      await lockPartitionOn(client, partition);
      const fence = await client.query<{ required_writer_version: unknown }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [partition],
      );
      const checkpoint = await client.query<{ schema_version: unknown }>(
        'SELECT schema_version FROM sync_backfill_checkpoints WHERE partition=$1 AND name=$2',
        [partition, name],
      );
      const fenceRow = fence.rows[0];
      const checkpointRow = checkpoint.rows[0];
      if (
        fenceRow === undefined ||
        checkpointRow === undefined ||
        asNumber(fenceRow.required_writer_version) <
          asNumber(checkpointRow.schema_version)
      ) {
        // The barrier is not installed. Activating would certify a state old
        // writers can still decay; refuse instead of silently proceeding.
        throw new StorageQueryError('sync.storage.checkpoint_fence_missing');
      }
      const coverage = await hasSourceChangesAboveOn(
        client,
        partition,
        sources,
        watermark,
      );
      if (coverage !== 'clean') {
        return coverage === 'changed' ? 'stale' : 'unverifiable';
      }
      const updated = await client.query<{ partition: string }>(
        `UPDATE sync_backfill_checkpoints
            SET state='activated', watermark=$1, updated_at_ms=$2
          WHERE partition=$3 AND name=$4 AND owner_epoch=$5
            AND state<>'activated'
          RETURNING partition`,
        [watermark, nowMs, partition, name, ownerEpoch],
      );
      return updated.rows.length === 1 ? 'activated' : 'stale';
    });
  }

  async claimCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint> {
    // The UPDATE's own row lock serializes concurrent claims; owner_epoch+1
    // is evaluated under it, so two claimers never observe the same epoch.
    const { rows } = await this.#exec.query<PostgresCheckpointRecord>(
      `UPDATE sync_backfill_checkpoints
          SET owner_epoch=owner_epoch+1,
              state=CASE WHEN state='declared' THEN 'backfilling' ELSE state END,
              schema_version=$1, updated_at_ms=$2
        WHERE partition=$3 AND name=$4 AND state<>'activated'
    RETURNING partition, name, schema_version, state, watermark,
              owner_epoch, observed_rows, updated_at_ms`,
      [schemaVersion, nowMs, partition, name],
    );
    if (rows[0] === undefined) {
      throw new StorageQueryError('sync.storage.checkpoint_not_declared');
    }
    return toStoredCheckpoint(rows[0]);
  }

  async advanceCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.#exec.query<{ name: string }>(
      `UPDATE sync_backfill_checkpoints
          SET watermark=$1, observed_rows=$2, updated_at_ms=$3
        WHERE partition=$4 AND name=$5 AND owner_epoch=$6
        RETURNING name`,
      [watermark, observedRows, nowMs, partition, name, ownerEpoch],
    );
    return result.rows.length === 1;
  }

  async sourceCoverageSeq(
    partition: string,
    tables: readonly string[],
  ): Promise<number> {
    if (tables.length === 0) return 0;
    const tableParams = tables.map((_, index) => `$${index + 2}`).join(',');
    const { rows } = await this.#exec.query<{ seq: unknown }>(
      `SELECT max(commit_seq) AS seq FROM sync_changes
        WHERE partition=$1 AND tbl IN (${tableParams})`,
      [partition, ...tables],
    );
    const seq = rows[0]?.seq;
    return seq === null || seq === undefined ? 0 : asNumber(seq);
  }

  hasSourceChangesAbove(
    partition: string,
    tables: readonly string[],
    seq: number,
  ): Promise<'clean' | 'changed' | 'unverifiable'> {
    return hasSourceChangesAboveOn(this.#exec, partition, tables, seq);
  }

  getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined> {
    return getRowOn(this.#exec, this.table(table), partition, rowId);
  }

  getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined> {
    return getPushResultOn(this.#exec, partition, clientId, clientCommitId);
  }

  async claimReactions(
    partition: string,
    query: ReactionClaimQuery,
  ): Promise<StoredReaction[]> {
    if (query.types.length === 0 || query.limit <= 0) return [];
    const typeParams = query.types.map((_, index) => `$${index + 2}`).join(',');
    const nowParam = query.types.length + 2;
    const limitParam = nowParam + 1;
    const workerParam = limitParam + 1;
    const expiresParam = workerParam + 1;
    const { rows } = await this.#exec.query<PostgresReactionRecord>(
      `WITH due AS (
         SELECT partition, idempotency_key
           FROM sync_reactions
          WHERE partition=$1 AND type IN (${typeParams})
            AND ((status='pending' AND available_at_ms<=$${nowParam})
              OR (status='leased' AND lease_expires_at_ms<=$${nowParam}))
          ORDER BY CASE WHEN status='leased' THEN lease_expires_at_ms
                        ELSE available_at_ms END,
                   created_at_ms, idempotency_key
          FOR UPDATE SKIP LOCKED
          LIMIT $${limitParam}
       )
       UPDATE sync_reactions AS reaction
          SET status='leased', attempts=reaction.attempts+1,
              lease_owner=$${workerParam}, lease_expires_at_ms=$${expiresParam},
              completed_at_ms=NULL
         FROM due
        WHERE reaction.partition=due.partition
          AND reaction.idempotency_key=due.idempotency_key
      RETURNING reaction.*`,
      [
        partition,
        ...query.types,
        query.nowMs,
        query.limit,
        query.leaseOwner,
        Math.min(Number.MAX_SAFE_INTEGER, query.nowMs + query.leaseDurationMs),
      ],
    );
    return rows
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
    const result = await this.#exec.query(
      `UPDATE sync_reactions
          SET status='completed', completed_at_ms=$4,
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE partition=$1 AND idempotency_key=$2
          AND status='leased' AND lease_owner=$3`,
      [partition, idempotencyKey, leaseOwner, completedAtMs],
    );
    return result.rowCount === 1;
  }

  async extendReactionLease(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean> {
    const result = await this.#exec.query(
      `UPDATE sync_reactions SET lease_expires_at_ms=$4
        WHERE partition=$1 AND idempotency_key=$2
          AND status='leased' AND lease_owner=$3`,
      [partition, idempotencyKey, leaseOwner, leaseExpiresAtMs],
    );
    return result.rowCount === 1;
  }

  async failReaction(
    partition: string,
    idempotencyKey: string,
    update: ReactionFailureUpdate,
  ): Promise<boolean> {
    const result = await this.#exec.query(
      `UPDATE sync_reactions
          SET status=$4, available_at_ms=$5, last_failure=$6,
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE partition=$1 AND idempotency_key=$2
          AND status='leased' AND lease_owner=$3`,
      [
        partition,
        idempotencyKey,
        update.leaseOwner,
        update.retryAtMs === undefined ? 'dead-letter' : 'pending',
        update.retryAtMs ?? update.failure.atMs,
        JSON.stringify(update.failure),
      ],
    );
    return result.rowCount === 1;
  }

  async retryReaction(
    partition: string,
    idempotencyKey: string,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.#exec.query(
      `UPDATE sync_reactions
          SET status='pending', attempts=0, available_at_ms=$3,
              last_failure=NULL, lease_owner=NULL, lease_expires_at_ms=NULL,
              completed_at_ms=NULL
        WHERE partition=$1 AND idempotency_key=$2 AND status='dead-letter'`,
      [partition, idempotencyKey, nowMs],
    );
    return result.rowCount === 1;
  }

  async getReaction(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction | undefined> {
    const { rows } = await this.#exec.query<PostgresReactionRecord>(
      'SELECT * FROM sync_reactions WHERE partition=$1 AND idempotency_key=$2',
      [partition, idempotencyKey],
    );
    return rows[0] === undefined ? undefined : toStoredReaction(rows[0]);
  }

  async listReactions(
    partition: string,
    query: ReactionListQuery,
  ): Promise<StoredReaction[]> {
    const where = ['partition=$1'];
    const params: unknown[] = [partition];
    if (query.statuses !== undefined && query.statuses.length > 0) {
      const placeholders = query.statuses.map(
        (_, index) => `$${params.length + index + 1}`,
      );
      where.push(`status IN (${placeholders.join(',')})`);
      params.push(...query.statuses);
    }
    if (query.types !== undefined && query.types.length > 0) {
      const placeholders = query.types.map(
        (_, index) => `$${params.length + index + 1}`,
      );
      where.push(`type IN (${placeholders.join(',')})`);
      params.push(...query.types);
    }
    params.push(query.limit);
    const { rows } = await this.#exec.query<PostgresReactionRecord>(
      `SELECT * FROM sync_reactions WHERE ${where.join(' AND ')}
        ORDER BY created_at_ms DESC, idempotency_key DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toStoredReaction);
  }

  async pruneReactions(
    partition: string,
    query: ReactionPruneQuery,
  ): Promise<PrunedReactionCounts> {
    if (query.limit <= 0) return { completed: 0, deadLetter: 0 };
    const { rows } = await this.#exec.query<{
      status: 'completed' | 'dead-letter';
    }>(
      `WITH targets AS (
         SELECT partition, idempotency_key
           FROM sync_reactions
          WHERE partition=$1
            AND ((status='completed' AND completed_at_ms IS NOT NULL
                  AND completed_at_ms<$2)
              OR (status='dead-letter' AND available_at_ms<$3))
          ORDER BY CASE WHEN status='completed' THEN completed_at_ms
                        ELSE available_at_ms END,
                   idempotency_key
          FOR UPDATE SKIP LOCKED
          LIMIT $4
       )
       DELETE FROM sync_reactions AS reaction
        USING targets
        WHERE reaction.partition=targets.partition
          AND reaction.idempotency_key=targets.idempotency_key
          AND ((reaction.status='completed'
                AND reaction.completed_at_ms IS NOT NULL
                AND reaction.completed_at_ms<$2)
            OR (reaction.status='dead-letter'
                AND reaction.available_at_ms<$3))
      RETURNING reaction.status`,
      [
        partition,
        query.completedBeforeMs,
        query.deadLetterBeforeMs,
        query.limit,
      ],
    );
    return {
      completed: rows.filter((row) => row.status === 'completed').length,
      deadLetter: rows.filter((row) => row.status === 'dead-letter').length,
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
    // Concurrent reads of a pull share one statement across tables.
    const [row] = await this.#batchedPage<{ seq: unknown }>(
      'latestScopedChange',
      LATEST_SCOPED_CHANGE_BATCH_SQL,
      partition,
      { tbl: query.table, var: firstVariable, vals: values },
    );
    return row === undefined ? 0 : asNumber(row.seq);
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
    // Candidates via the inverted index (one variable): the (partition, tbl,
    // var, value, commit_seq) PK makes the candidate subquery an index range
    // scan returning commit_seq already ascending (see postgres-explain
    // .test.ts), LEFT JOINed to the commit meta + the table's changes. Pages
    // of concurrent window reads share one statement across tables (see
    // `COMMIT_WINDOW_BATCH_SQL`). Exact multi-variable verification against
    // the stored scope map happens below.
    const commits: StoredCommit[] = [];
    let deliveredChanges = 0;
    let afterSeq = query.afterSeq;
    const batchSize = Math.max(64, query.limitChanges);
    while (deliveredChanges < query.limitChanges) {
      const records = await this.#batchedPage<CommitWindowRecord>(
        'commitWindow',
        COMMIT_WINDOW_BATCH_SQL,
        partition,
        {
          tbl: query.table,
          var: firstVariable,
          vals: firstValues,
          after: afterSeq,
          through: query.throughSeq,
          lim: batchSize,
        },
      );
      if (records.length === 0) break;
      // Fold the page: rows arrive ordered (commit_seq, idx); consecutive
      // rows with the same commit_seq are one candidate. Every candidate
      // advances the cursor — including vanished commits (NULL meta, LEFT
      // JOIN contract) and commits whose changes all fail the exact
      // multi-variable match.
      let candidateCount = 0;
      let i = 0;
      while (i < records.length) {
        const head = records[i];
        if (head === undefined) break;
        const commitSeq = asNumber(head.commit_seq);
        candidateCount += 1;
        afterSeq = commitSeq;
        const changes: StoredChange[] = [];
        for (; i < records.length; i++) {
          const record = records[i];
          if (record === undefined || asNumber(record.commit_seq) !== commitSeq)
            break;
          // NULL tbl: a candidate with no change rows for the table.
          if (record.tbl === null || record.row_id === null) continue;
          const change = toStoredChange({
            tbl: record.tbl,
            row_id: record.row_id,
            op: record.op,
            row_version: record.row_version,
            scopes: record.scopes,
            payload: record.payload,
          });
          if (matchesEffective(change.scopes, query.scopeFilter)) {
            changes.push(change);
          }
        }
        // NULL meta: the commit vanished — cursor advanced, nothing emitted.
        if (head.actor_id === null) continue;
        if (changes.length === 0) continue;
        commits.push({
          commitSeq,
          createdAtMs: asNumber(head.created_at_ms),
          actorId: head.actor_id,
          changes,
        });
        deliveredChanges += changes.length;
        if (deliveredChanges >= query.limitChanges) break;
      }
      if (deliveredChanges >= query.limitChanges) break;
      if (candidateCount < batchSize) break;
    }
    return commits;
  }

  async scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]> {
    const firstVariable = assertScopeIndexedScan(query);
    const firstValues = query.scopeFilter[firstVariable] ?? [];
    if (firstValues.length === 0) return [];
    // Candidates via the inverted index (ordered + LIMITed at the covering
    // PK) LEFT JOINed to the row table — one round trip per page, never one
    // per row, and concurrent scans across tables share one statement (see
    // `scanRowBatchSql`). Exact multi-variable verification against the
    // stored scope map happens below.
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const records = await this.#batchedPage<RowRecord>(
        'scanRows',
        (specs) =>
          scanRowBatchSql(
            [...new Set(specs.map((spec) => String(spec.tbl)))].map((table) =>
              this.table(table),
            ),
          ),
        partition,
        {
          tbl: query.table,
          var: firstVariable,
          vals: firstValues,
          after: afterRowId,
          lim: batchSize,
        },
      );
      if (records.length === 0) break;
      for (const record of records) {
        afterRowId = record.row_id;
        // NULL payload: an index candidate whose row vanished — it still
        // advances the keyset cursor (LEFT JOIN contract) but yields no row.
        if (record.payload === null || record.payload === undefined) continue;
        const stored = toStoredRow(record);
        if (!matchesEffective(stored.scopes, query.scopeFilter)) continue;
        rows.push(stored);
        if (rows.length >= query.limit) break;
      }
      if (records.length < batchSize) break;
    }
    return rows;
  }

  scanRowsByIndex(
    partition: string,
    query: IndexRowScanQuery,
  ): Promise<StoredRow[]> {
    return scanRowsByIndexOn(
      this.#exec,
      this.table(query.table),
      partition,
      query,
    );
  }

  async getClientRecord(
    partition: string,
    clientId: string,
  ): Promise<ClientRecord | undefined> {
    const { rows } = await this.#exec.query<{
      client_id: string;
      actor_id: string;
      wire_version: unknown;
      cursor: unknown;
      subscriptions: unknown;
      updated_at_ms: unknown;
      last_round_at_ms: unknown;
      last_error_code: string | null;
      consecutive_failures: unknown;
    }>(
      'SELECT client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms, last_round_at_ms, last_error_code, consecutive_failures FROM sync_clients WHERE partition=$1 AND client_id=$2',
      [partition, clientId],
    );
    const record = rows[0];
    if (record === undefined) return undefined;
    return {
      clientId: record.client_id,
      actorId: record.actor_id,
      wireVersion: asNumber(record.wire_version),
      cursor: asNumber(record.cursor),
      updatedAtMs: asNumber(record.updated_at_ms),
      subscriptions: asJson<ClientSubscription[]>(record.subscriptions),
      ...clientRoundState(
        record.last_round_at_ms === null
          ? null
          : asNumber(record.last_round_at_ms),
        record.last_error_code,
        asNumber(record.consecutive_failures),
      ),
    };
  }

  async putClientRecord(
    partition: string,
    record: ClientRecord,
    options?: ClientRecordWriteOptions,
  ): Promise<void> {
    await this.#exec.query(
      `INSERT INTO sync_clients(partition, client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms, last_round_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (partition, client_id) DO UPDATE
         SET actor_id=EXCLUDED.actor_id, wire_version=EXCLUDED.wire_version,
             cursor=EXCLUDED.cursor,
             subscriptions=EXCLUDED.subscriptions,
             updated_at_ms=EXCLUDED.updated_at_ms,
             last_round_at_ms=EXCLUDED.last_round_at_ms${
               options?.keepRoundOutcome === true
                 ? ''
                 : ',\n             last_error_code=NULL, consecutive_failures=0'
             }`,
      [
        partition,
        record.clientId,
        record.actorId,
        record.wireVersion,
        record.cursor,
        JSON.stringify(record.subscriptions),
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
    await this.#exec.query(
      `UPDATE sync_clients
         SET last_round_at_ms=$1, last_error_code=$2,
             consecutive_failures=consecutive_failures+1
       WHERE partition=$3 AND client_id=$4 AND actor_id=$5`,
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
    await this.#exec.query(
      `UPDATE sync_clients
         SET cursor=GREATEST(cursor, $1), updated_at_ms=GREATEST(updated_at_ms, $2)
         WHERE partition=$3 AND client_id=$4 AND actor_id=$5
           AND EXISTS (SELECT 1 FROM sync_partition_registry
                       WHERE partition=sync_clients.partition AND log_epoch=$6)`,
      [cursor, updatedAtMs, partition, clientId, actorId, logEpoch],
    );
  }

  async updateClientCursor(
    partition: string,
    clientId: string,
    cursor: number,
    updatedAtMs: number,
  ): Promise<void> {
    await this.#exec.query(
      `UPDATE sync_clients
       SET cursor=GREATEST(cursor, $3), updated_at_ms=GREATEST(updated_at_ms, $4)
       WHERE partition=$1 AND client_id=$2`,
      [partition, clientId, cursor, updatedAtMs],
    );
  }

  async getActiveClientCursorFloor(
    partition: string,
    cutoffMs: number,
  ): Promise<number | null> {
    const { rows } = await this.#exec.query<{ cursor: unknown }>(
      'SELECT MIN(cursor) AS cursor FROM sync_clients WHERE partition=$1 AND updated_at_ms>=$2',
      [partition, cutoffMs],
    );
    return rows[0]!.cursor === null ? null : asNumber(rows[0]!.cursor);
  }

  async listClientCursors(partition: string): Promise<ClientCursorInfo[]> {
    const { rows } = await this.#exec.query<{
      client_id: string;
      cursor: unknown;
      updated_at_ms: unknown;
    }>(
      'SELECT client_id, cursor, updated_at_ms FROM sync_clients WHERE partition=$1',
      [partition],
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      cursor: asNumber(r.cursor),
      updatedAtMs: asNumber(r.updated_at_ms),
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
    // stored scopes come from sync_rows for the §3.4 authorization test.
    const { rows: refs } = await this.#exec.query<{
      tbl: string;
      row_id: string;
    }>(
      'SELECT tbl, row_id FROM sync_blob_refs WHERE partition=$1 AND blob_id=$2',
      [partition, blobId],
    );
    const out: {
      table: string;
      rowId: string;
      scopes: Record<string, string>;
    }[] = [];
    for (const ref of refs) {
      const compiled = this.#tables?.get(ref.tbl);
      if (compiled === undefined) continue; // table no longer in the schema
      const { rows } = await this.#exec.query<{ scopes: unknown }>(
        selectRowScopesSql(compiled, 'postgres'),
        [partition, ref.row_id],
      );
      const row = rows[0];
      if (row === undefined) continue;
      out.push({
        table: ref.tbl,
        rowId: ref.row_id,
        scopes: asJson<Record<string, string>>(row.scopes),
      });
    }
    return out;
  }

  async listReferencedBlobIds(partition: string): Promise<string[]> {
    const { rows } = await this.#exec.query<{ blob_id: string }>(
      'SELECT DISTINCT blob_id FROM sync_blob_refs WHERE partition=$1',
      [partition],
    );
    return rows.map((r) => r.blob_id);
  }

  async listScopeValueRows(
    partition: string,
    query: ScopeValueQuery,
  ): Promise<string[]> {
    const { rows } = await this.#exec.query<{ row_id: string }>(
      `SELECT row_id FROM sync_row_scopes
        WHERE partition=$1 AND tbl=$2 AND var=$3 AND value=$4
        ORDER BY row_id LIMIT $5`,
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
      query.limit,
    ];
    return this.#exec.transaction(async (client) => {
      await lockPartitionOn(client, partition);
      // Upsert change records of the binding, then the change scope entries
      // whose commit no longer holds a change of the binding.
      const changes = await client.query(
        `DELETE FROM sync_changes c USING (
           SELECT c2.commit_seq, c2.idx FROM sync_change_scopes s
             JOIN sync_changes c2 ON c2.partition=s.partition
              AND c2.commit_seq=s.commit_seq AND c2.tbl=s.tbl
            WHERE s.partition=$1 AND s.tbl=$2 AND s.var=$3 AND s.value=$4
              AND s.commit_seq<=$5 AND c2.op=1 AND c2.scopes->>$3=s.value
            LIMIT $6) d
         WHERE c.partition=$1 AND c.commit_seq=d.commit_seq AND c.idx=d.idx`,
        params,
      );
      const scopes = await client.query(
        `DELETE FROM sync_change_scopes cs USING (
           SELECT s.commit_seq FROM sync_change_scopes s
            WHERE s.partition=$1 AND s.tbl=$2 AND s.var=$3 AND s.value=$4
              AND s.commit_seq<=$5 AND NOT EXISTS (
                SELECT 1 FROM sync_changes c
                 WHERE c.partition=s.partition AND c.commit_seq=s.commit_seq
                   AND c.tbl=s.tbl AND c.scopes->>$3=s.value)
            LIMIT $6) d
         WHERE cs.partition=$1 AND cs.tbl=$2 AND cs.var=$3 AND cs.value=$4
           AND cs.commit_seq=d.commit_seq`,
        params,
      );
      return changes.rowCount + scopes.rowCount;
    });
  }

  // -- admin/console read surface --------------------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    const { rows } = await this.#exec.query<{
      client_id: string;
      actor_id: string;
      wire_version: unknown;
      cursor: unknown;
      subscriptions: unknown;
      updated_at_ms: unknown;
      last_round_at_ms: unknown;
      last_error_code: string | null;
      consecutive_failures: unknown;
    }>(
      'SELECT client_id, actor_id, wire_version, cursor, subscriptions, updated_at_ms, last_round_at_ms, last_error_code, consecutive_failures FROM sync_clients WHERE partition=$1 ORDER BY updated_at_ms DESC',
      [partition],
    );
    return rows.map((r) => ({
      clientId: r.client_id,
      actorId: r.actor_id,
      wireVersion: asNumber(r.wire_version),
      cursor: asNumber(r.cursor),
      updatedAtMs: asNumber(r.updated_at_ms),
      subscriptions: (typeof r.subscriptions === 'string'
        ? JSON.parse(r.subscriptions)
        : r.subscriptions) as ClientSubscription[],
      ...clientRoundState(
        r.last_round_at_ms === null ? null : asNumber(r.last_round_at_ms),
        r.last_error_code,
        asNumber(r.consecutive_failures),
      ),
    }));
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
    const { rows } = query.table
      ? await this.#exec.query<{
          commit_seq: unknown;
          client_id: string;
          client_commit_id: string;
          actor_id: string;
          created_at_ms: unknown;
        }>(
          `SELECT c.commit_seq, c.client_id, c.client_commit_id, c.actor_id, c.created_at_ms
           FROM sync_commits c
           WHERE c.partition=$1 AND c.commit_seq>$2 AND c.commit_seq<$3
             AND EXISTS (SELECT 1 FROM sync_changes ch
               WHERE ch.partition=c.partition AND ch.commit_seq=c.commit_seq AND ch.tbl=$4)
           ORDER BY c.commit_seq DESC LIMIT $5`,
          [partition, query.afterSeq, beforeSeq, query.table, query.limit],
        )
      : await this.#exec.query<{
          commit_seq: unknown;
          client_id: string;
          client_commit_id: string;
          actor_id: string;
          created_at_ms: unknown;
        }>(
          `SELECT commit_seq, client_id, client_commit_id, actor_id, created_at_ms
           FROM sync_commits
           WHERE partition=$1 AND commit_seq>$2 AND commit_seq<$3
           ORDER BY commit_seq DESC LIMIT $4`,
          [partition, query.afterSeq, beforeSeq, query.limit],
        );
    // `changeSample`: one extra statement for the whole page — the first
    // `sample` changes (change-index order) of every listed commit.
    const sampleCount =
      query.changeSample !== undefined &&
      Number.isInteger(query.changeSample) &&
      query.changeSample > 0
        ? query.changeSample
        : 0;
    const samples = new Map<number, CommitChangeSummary[]>();
    if (sampleCount > 0 && rows.length > 0) {
      const seqs = rows.map((row) => asNumber(row.commit_seq));
      const { rows: changeRows } = await this.#exec.query<{
        commit_seq: unknown;
        tbl: string;
        row_id: string;
        op: unknown;
      }>(
        `SELECT commit_seq, tbl, row_id, op FROM sync_changes
         WHERE partition=$1 AND commit_seq IN (${seqs.map((_, index) => `$${index + 2}`).join(',')}) AND idx<$${seqs.length + 2}
         ORDER BY commit_seq, idx`,
        [partition, ...seqs, sampleCount],
      );
      for (const change of changeRows) {
        const sample = samples.get(asNumber(change.commit_seq)) ?? [];
        sample.push({
          table: change.tbl,
          rowId: change.row_id,
          op: asNumber(change.op) === 1 ? 'upsert' : 'delete',
        });
        samples.set(asNumber(change.commit_seq), sample);
      }
    }
    const out: CommitMetadata[] = [];
    for (const row of rows) {
      const commitSeq = asNumber(row.commit_seq);
      const changes = await this.#exec.query<{ tbl: string; n: unknown }>(
        'SELECT tbl, count(*) AS n FROM sync_changes WHERE partition=$1 AND commit_seq=$2 GROUP BY tbl',
        [partition, commitSeq],
      );
      out.push({
        commitSeq,
        clientId: row.client_id,
        clientCommitId: row.client_commit_id,
        actorId: row.actor_id,
        createdAtMs: asNumber(row.created_at_ms),
        changeCount: changes.rows.reduce((sum, c) => sum + asNumber(c.n), 0),
        tables: changes.rows.map((c) => c.tbl),
        ...(sampleCount > 0 ? { sample: samples.get(commitSeq) ?? [] } : {}),
      });
    }
    return out;
  }

  async getCommit(
    partition: string,
    commitSeq: number,
  ): Promise<CommitDetail | undefined> {
    const { rows } = await this.#exec.query<{
      client_id: string;
      client_commit_id: string;
      actor_id: string;
      created_at_ms: unknown;
    }>(
      'SELECT client_id, client_commit_id, actor_id, created_at_ms FROM sync_commits WHERE partition=$1 AND commit_seq=$2',
      [partition, commitSeq],
    );
    const meta = rows[0];
    if (meta === undefined) return undefined;
    const { rows: changeRows } = await this.#exec.query<ChangeRecord>(
      'SELECT tbl, row_id, op, row_version, scopes, payload FROM sync_changes WHERE partition=$1 AND commit_seq=$2 ORDER BY idx',
      [partition, commitSeq],
    );
    const changes = changeRows.map(toStoredChange);
    return {
      commitSeq,
      clientId: meta.client_id,
      clientCommitId: meta.client_commit_id,
      actorId: meta.actor_id,
      createdAtMs: asNumber(meta.created_at_ms),
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
    const { rows } = await this.#exec.query<{
      commit_seq: unknown;
      op: unknown;
      row_version: unknown;
      actor_id: string;
      client_id: string;
      created_at_ms: unknown;
    }>(
      `SELECT ch.commit_seq, ch.op, ch.row_version, c.actor_id, c.client_id, c.created_at_ms
       FROM sync_changes ch
       JOIN sync_commits c
         ON c.partition=ch.partition AND c.commit_seq=ch.commit_seq
       WHERE ch.partition=$1 AND ch.tbl=$2 AND ch.row_id=$3
       ORDER BY ch.commit_seq DESC, ch.idx DESC LIMIT $4`,
      [partition, query.table, query.rowId, query.limit],
    );
    return rows.map((row) => ({
      commitSeq: asNumber(row.commit_seq),
      op: asNumber(row.op) === 1 ? 'upsert' : 'delete',
      ...(row.row_version === null || row.row_version === undefined
        ? {}
        : { rowVersion: asNumber(row.row_version) }),
      actorId: row.actor_id,
      clientId: row.client_id,
      createdAtMs: asNumber(row.created_at_ms),
    }));
  }

  async listRows(partition: string, query: RowListQuery): Promise<StoredRow[]> {
    // Keyset page over the row table's (partition, rowId) primary key: an
    // index range read, no scope filter, no per-row lookup.
    const { rows } = await this.#exec.query<RowRecord>(
      `SELECT ${quoteIdent(SYNC_ROW_ID_COLUMN)} AS row_id, ${quoteIdent(SYNC_VERSION_COLUMN)} AS server_version, ${quoteIdent(SYNC_SCOPES_COLUMN)} AS scopes, ${quoteIdent(SYNC_PAYLOAD_COLUMN)} AS payload, ${quoteIdent(SYNC_COLUMN_VERSIONS_COLUMN)} AS column_versions
       FROM ${quoteIdent(this.table(query.table).name)}
       WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=$1 AND ${quoteIdent(SYNC_ROW_ID_COLUMN)}>$2
       ORDER BY ${quoteIdent(SYNC_ROW_ID_COLUMN)} LIMIT $3`,
      [partition, query.afterRowId ?? '', query.limit],
    );
    return rows.map(toStoredRow);
  }

  async countRows(partition: string, table: string): Promise<number> {
    const { rows } = await this.#exec.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM ${quoteIdent(this.table(table).name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=$1`,
      [partition],
    );
    return rows[0] === undefined ? 0 : asNumber(rows[0].n);
  }

  async listPushResults(
    partition: string,
    clientCommitId: string,
  ): Promise<ClientPushResult[]> {
    // Retained outcomes for one clientCommitId: no dedicated index, ordered
    // by client so the read is deterministic.
    const { rows } = await this.#exec.query<{
      client_id: string;
      result: unknown;
    }>(
      'SELECT client_id, result FROM sync_push_results WHERE partition=$1 AND client_commit_id=$2 ORDER BY client_id',
      [partition, clientCommitId],
    );
    return rows.map((row) => {
      try {
        return {
          clientId: row.client_id,
          result: deserializePushResult(asJson(row.result)),
        };
      } catch {
        throw syncError(
          'sync.idempotency_cache_miss',
          'persisted push result unreadable (§6.3)',
        );
      }
    });
  }

  async scopeActivity(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]> {
    const { rows } = await this.#exec.query<{
      commit_seq: unknown;
      tbl: string;
    }>(
      `SELECT DISTINCT commit_seq, tbl FROM sync_change_scopes
       WHERE partition=$1 AND var=$2 AND value=$3
       ORDER BY commit_seq DESC LIMIT $4`,
      [partition, query.variable, query.value, query.limit],
    );
    const out: ScopeCommitActivity[] = [];
    for (const row of rows) {
      const commitSeq = asNumber(row.commit_seq);
      const meta = await this.#exec.query<{
        actor_id: string;
        created_at_ms: unknown;
      }>(
        'SELECT actor_id, created_at_ms FROM sync_commits WHERE partition=$1 AND commit_seq=$2',
        [partition, commitSeq],
      );
      const metaRow = meta.rows[0];
      if (metaRow === undefined) continue;
      const count = await this.#exec.query<{ n: unknown }>(
        'SELECT count(*) AS n FROM sync_changes WHERE partition=$1 AND commit_seq=$2 AND tbl=$3',
        [partition, commitSeq, row.tbl],
      );
      out.push({
        commitSeq,
        table: row.tbl,
        createdAtMs: asNumber(metaRow.created_at_ms),
        actorId: metaRow.actor_id,
        changeCount:
          count.rows[0] === undefined ? 0 : asNumber(count.rows[0].n),
      });
    }
    return out;
  }

  async listPartitions(): Promise<string[]> {
    return (await this.listPartitionRegistry()).map((entry) => entry.partition);
  }
}
