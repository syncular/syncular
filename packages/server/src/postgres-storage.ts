import { validateCommitPruneQuery } from './prune';
import { StorageQueryError } from './storage-errors';
import type {
  CommitPruneQuery,
  CommitPruneResult,
  PartitionHorizons,
} from './storage';
import {
  asJson,
  CLIENT_RECORD_COLUMNS,
  pushResultFromJson,
  pushResultToJson,
  type StoredChangeRecord,
  type StoredReactionRecord,
  type StoredRowRecord,
  toClientRecord,
  toStoredChange,
  toStoredReaction,
  toStoredRow,
  toTombstone,
  PARTITION_TOUCH_INTERVAL_MS,
  commitDeleteFloor,
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
 *   - `readLiveWindow`/`scanRows` select candidates through an index
 *     (`sync_change_scopes_by_key` / `sync_row_scopes`), ordered + LIMITed
 *     at the index, then verify the full multi-variable match against the
 *     stored scope map — never a log or table scan;
 *   - the candidate indexes are *covering* for their selection: the ordered
 *     column (`commit_seq` / `row_id`) sits in the index key after the scope
 *     key, so the planner does an index range scan and returns
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
import { decodeRow, type UnitScopes } from '@syncular/core';
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
  assertStoredScopePatterns,
  changedScopePatterns,
  deleteRowSql,
  dropTableDdl,
  indexRowPageStatement,
  layoutsOf,
  migratePayload,
  parseLayouts,
  quoteIdent,
  rekeyCleanupSql,
  rekeyedScopes,
  rekeyRowScopesSql,
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
  countRowsSql,
  scanRowBatchSql,
  scanProbeSql,
  scanRowPageSql,
  indexSignature,
  schemaDdl,
  serverIndexDdl,
  rowsReferencingBlobSql,
  selectRowSql,
  selectRowsSql,
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
  CommitChangeSummary,
  CommitDetail,
  CommitMetadata,
  CommitMetadataQuery,
  IndexRowScanQuery,
  LiveWindow,
  LiveWindowQuery,
  NewCommit,
  NewReaction,
  OutboxSequence,
  OutboxSettlement,
  PartitionRegistryEntry,
  PartitionTouch,
  PreparedPushApply,
  PushApplyOptions,
  PrunedReactionCounts,
  PushApplyCommit,
  PushWatermark,
  ReactionClaimQuery,
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
  StoredCheckpoint,
  StoredPushResult,
  StoredReaction,
  StoredRow,
  Tombstone,
} from './storage';
import {
  ClosedCommitConstraintError,
  isPostgresConstraintError,
  StorageConstraintError,
} from './storage-errors';
import {
  chooseScanVariable,
  readLiveWindowPages,
  resolveIndexRowScan,
} from './storage-query';

/**
 * Schema DDL. Applied by `PostgresServerStorage.migrate()` (idempotent).
 *
 * Covering index design (the reason this file exists):
 *   - `sync_change_scopes_by_key (partition, var, value, commit_seq)`: the
 *     §4.5 live scan ranges once per unit key on the (partition, var, value)
 *     prefix across tables and returns `commit_seq` already ascending;
 *   - `sync_change_scopes_pk (partition, tbl, var, value, commit_seq)`:
 *     the §4.7 scope pin, erasure and pruning name the table;
 *   - `sync_row_scopes_pk (partition, tbl, var, value, row_id)`: the same
 *     shape for `scanRows`, ordered by `row_id`.
 *
 * The §6.3.2 watermark delete and the §9 settlement of results stored
 * before wire version 4 (NULL `outbox_id`) range over the `(partition,
 * client_id)` prefix of `sync_push_results`' PRIMARY KEY, which the
 * watermark keeps to one request's results per outbox.
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
  horizon_seq BIGINT NOT NULL DEFAULT 0,
  delete_floor BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_partition_registry(
  partition TEXT PRIMARY KEY,
  log_epoch TEXT NOT NULL,
  epoch_required BOOLEAN NOT NULL DEFAULT FALSE,
  last_authenticated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_table_horizons(
  partition TEXT NOT NULL, tbl TEXT NOT NULL,
  commit_seq BIGINT NOT NULL,
  PRIMARY KEY(partition, tbl)
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
CREATE INDEX IF NOT EXISTS sync_change_scopes_by_key
  ON sync_change_scopes(partition, var, value, commit_seq);
CREATE TABLE IF NOT EXISTS sync_push_results(
  partition TEXT NOT NULL, client_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL, result JSONB NOT NULL,
  outbox_id TEXT, client_seq BIGINT,
  PRIMARY KEY(partition, client_id, client_commit_id)
);
ALTER TABLE sync_push_results ADD COLUMN IF NOT EXISTS outbox_id TEXT;
ALTER TABLE sync_push_results ADD COLUMN IF NOT EXISTS client_seq BIGINT;
CREATE TABLE IF NOT EXISTS sync_push_watermarks(
  partition TEXT NOT NULL, client_id TEXT NOT NULL, outbox_id TEXT NOT NULL,
  through_seq BIGINT NOT NULL,
  PRIMARY KEY(partition, client_id, outbox_id)
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
  cursor BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  last_round_at_ms BIGINT, last_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER, units JSONB, registration_digest BYTEA,
  catching_up JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY(partition, client_id)
);
ALTER TABLE sync_clients
  ADD COLUMN IF NOT EXISTS wire_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS last_round_at_ms BIGINT;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE sync_clients
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS schema_version INTEGER;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS units JSONB;
ALTER TABLE sync_clients ADD COLUMN IF NOT EXISTS registration_digest BYTEA;
ALTER TABLE sync_clients
  ADD COLUMN IF NOT EXISTS catching_up JSONB NOT NULL DEFAULT '[]';
-- §9: a database from before wire version 4 (its client records still hold
-- subscriptions) starts the horizon at its last commit.
UPDATE sync_partitions SET horizon_seq = max_commit_seq
 WHERE EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'sync_clients'
                  AND column_name = 'subscriptions');
ALTER TABLE sync_clients DROP COLUMN IF EXISTS subscriptions;
CREATE TABLE IF NOT EXISTS sync_blob_refs(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  PRIMARY KEY(partition, tbl, row_id, blob_id)
);
CREATE INDEX IF NOT EXISTS sync_blob_refs_by_blob
  ON sync_blob_refs(partition, blob_id);
CREATE TABLE IF NOT EXISTS sync_tombstones(
  partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL,
  commit_seq BIGINT NOT NULL, server_version BIGINT, scopes JSONB,
  PRIMARY KEY(partition, tbl, row_id)
);
ALTER TABLE sync_tombstones ADD COLUMN IF NOT EXISTS server_version BIGINT;
ALTER TABLE sync_tombstones ADD COLUMN IF NOT EXISTS scopes JSONB;
ALTER TABLE sync_partitions
  ADD COLUMN IF NOT EXISTS delete_floor BIGINT NOT NULL DEFAULT 0;
UPDATE sync_partitions SET delete_floor = t.version
  FROM (SELECT partition, max(server_version) AS version
          FROM sync_tombstones GROUP BY partition) t
 WHERE t.partition = sync_partitions.partition
   AND t.version > sync_partitions.delete_floor;
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

/** Lock the partition row; returns its `max_commit_seq`, which the lock freezes. */
async function lockPartitionOn(
  client: PgQueryable,
  partition: string,
): Promise<number> {
  const lock = () =>
    client.query<{ max_commit_seq: unknown }>(
      'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1 FOR UPDATE',
      [partition],
    );
  const locked = await lock();
  if (locked.rows[0] !== undefined) {
    return asNumber(locked.rows[0].max_commit_seq);
  }
  // The first writer initializes the partition. Concurrent initializers may
  // wait on this insert, so acquire the row lock again before applying writes.
  await client.query(
    `INSERT INTO sync_partitions(partition, max_commit_seq) VALUES ($1, 0)
    ON CONFLICT (partition) DO NOTHING`,
    [partition],
  );
  return asNumber((await lock()).rows[0]?.max_commit_seq);
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
  results?: unknown;
  delete_floor?: unknown;
  watermark?: unknown;
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
  readonly tombstone_version: unknown;
  readonly tombstone_scopes: unknown;
}

type AdmissionRow = ServeGateRow & Partial<PrefetchRow>;

/**
 * The push admission statement: the §9 settlement and §6.3.2 steps 1 and 2
 * when the request carries an outbox, the RFC 0007 serve gate, the §2.3
 * idempotency records of every commit of the request, and (when the caller
 * already knows the commits' row targets) the read-ahead rows, in one
 * statement with one snapshot. The caller takes the partition lock first:
 * under READ COMMITTED a statement's snapshot is fixed at its start, so the
 * read must be the statement *after* the lock to observe a duplicate that
 * committed while this transaction waited for it.
 *
 * The settlement's writable CTEs see the same snapshot as the read, so they
 * touch disjoint rows and the read leaves out the results they delete. §9
 * (b): with no pre-upgrade result on the request's last commit, every
 * remaining one outside the request left the outbox. (a) assigns the
 * request's sequences to its pre-upgrade results at or above the new
 * watermark; step 2 deletes the outbox's results below it, the pre-upgrade
 * results of the request below it included.
 */
async function readAdmissionOn(
  client: PgQueryable,
  partition: string,
  clientId: string,
  clientCommitIds: readonly string[],
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
  outbox: OutboxSettlement | undefined,
): Promise<{
  gate: ServeGate;
  persisted: ReadonlyMap<string, unknown>;
  deleteFloor: number;
  watermark: number | undefined;
  prefetched: readonly PrefetchRow[];
}> {
  const params: unknown[] = [
    partition,
    runningSchemaVersion,
    clientId,
    JSON.stringify(clientCommitIds),
  ];
  let settlement = '';
  if (outbox !== undefined) {
    const first = outbox.commits[0];
    const last = outbox.commits.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('outbox settlement needs the request commits');
    }
    params.push(
      outbox.outboxId,
      JSON.stringify(
        outbox.commits.map((commit) => ({
          id: commit.clientCommitId,
          seq: commit.clientSeq,
        })),
      ),
      last.clientCommitId,
      first.clientSeq,
    );
    settlement = `WITH c AS (SELECT * FROM jsonb_to_recordset($6::text::jsonb) AS c(id text, seq bigint)),
       w AS (
         INSERT INTO sync_push_watermarks(partition, client_id, outbox_id, through_seq)
         VALUES ($1,$3,$5,$8)
         ON CONFLICT (partition, client_id, outbox_id) DO UPDATE
           SET through_seq=GREATEST(sync_push_watermarks.through_seq, EXCLUDED.through_seq)
         RETURNING through_seq),
       b AS (DELETE FROM sync_push_results
              WHERE partition=$1 AND client_id=$3 AND outbox_id IS NULL
                AND result->>'status' IS DISTINCT FROM 'fenced'
                AND client_commit_id NOT IN (SELECT id FROM c)
                AND NOT EXISTS (SELECT 1 FROM sync_push_results
                  WHERE partition=$1 AND client_id=$3 AND client_commit_id=$7
                    AND outbox_id IS NULL
                    AND result->>'status' IS DISTINCT FROM 'fenced')),
       a AS (UPDATE sync_push_results r SET outbox_id=$5, client_seq=c.seq FROM c, w
              WHERE r.partition=$1 AND r.client_id=$3 AND r.outbox_id IS NULL
                AND r.result->>'status' IS DISTINCT FROM 'fenced'
                AND r.client_commit_id=c.id AND c.seq>=w.through_seq),
       expired AS (DELETE FROM sync_push_results r USING w
              WHERE r.partition=$1 AND r.client_id=$3
                AND r.result->>'status' IS DISTINCT FROM 'fenced'
                AND ((r.outbox_id=$5 AND r.client_seq<w.through_seq)
                  OR (r.outbox_id IS NULL AND EXISTS (SELECT 1 FROM c
                        WHERE c.id=r.client_commit_id AND c.seq<w.through_seq)))
              RETURNING r.client_commit_id)
       `;
  }
  let statement = `${settlement}SELECT ${SERVE_GATE_PROJECTION},
            (SELECT jsonb_object_agg(client_commit_id, result) FROM sync_push_results
              WHERE partition=$1 AND client_id=$3 AND client_commit_id IN (SELECT jsonb_array_elements_text($4::text::jsonb))${
                outbox === undefined
                  ? ''
                  : ' AND client_commit_id NOT IN (SELECT client_commit_id FROM expired)'
              }) AS results,
            (SELECT delete_floor FROM sync_partitions WHERE partition=$1) AS delete_floor,
            ${outbox === undefined ? 'NULL::bigint' : '(SELECT through_seq FROM w)'} AS watermark`;
  if (prefetch !== undefined && prefetch.specs.length > 0) {
    params.push(JSON.stringify(prefetch.specs));
    // The gate row pads the read-ahead columns with typed NULLs so both
    // branches share one result shape; `tbl` is NULL only for the gate row.
    statement += `,
            NULL::text AS tbl, NULL::text AS lookup_id, NULL::text AS row_id,
            NULL::bigint AS server_version, NULL::jsonb AS scopes,
            NULL::bytea AS payload, NULL::bytea AS column_versions,
            NULL::bigint AS tombstone_seq, NULL::bigint AS tombstone_version,
            NULL::jsonb AS tombstone_scopes
       UNION ALL
       SELECT NULL::bigint, NULL::text, NULL::json, NULL::jsonb, NULL::bigint,
              NULL::bigint,
              p.tbl, p.lookup_id, p.row_id, p.server_version, p.scopes,
              p.payload, p.column_versions, p.tombstone_seq,
              p.tombstone_version, p.tombstone_scopes
         FROM (${prefetchRowsBatchSql(prefetch.tables, {
           partition: '$1',
           specs: `$${params.length}`,
         })}) p`;
  }
  const { rows } = await client.query<AdmissionRow>(statement, params);
  const gateRow = rows.find((row) => row.tbl === null) ?? rows[0];
  const results =
    gateRow?.results === null || gateRow?.results === undefined
      ? {}
      : asJson(gateRow.results);
  return {
    gate: toServeGate(gateRow),
    persisted: new Map(
      typeof results === 'object' && results !== null
        ? Object.entries(results)
        : [],
    ),
    // asNumber maps the NULL of a partition without a commit to 0.
    deleteFloor: asNumber(gateRow?.delete_floor),
    watermark: outbox === undefined ? undefined : asNumber(gateRow?.watermark),
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

/**
 * Migration rewrite: keyset-paged walk of a row table inside the migration
 * transaction. When `oldLayout` is
 * given every payload re-encodes under the current columns, and the
 * projection (when materialized) refreshes from the payload either way.
 * `rekey` recomputes and indexes the stored scopes (§3.1).
 */
async function rewriteRowsOn(
  q: PgQueryable,
  table: CompiledTable,
  oldLayout: readonly StoredColumnLayout[] | undefined,
  rekey: boolean,
): Promise<void> {
  const select = selectRowsForRewriteSql(table, 'postgres');
  // One UPDATE per page: behind a network hop (Hyperdrive, a managed
  // database) every statement is a round trip, and the bump holds the
  // migration lock for its whole duration. The page's rows bind as one
  // VALUES list with typed placeholders (`rewriteValues` order: projection
  // columns, re-keyed scopes, payload, partition, row id). The scopes and
  // `json` columns bind as text before the JSONB cast (see `scanRowBatchSql`).
  const projected = table.materialize ? table.columns : [];
  const types = [
    ...projected.map((column) =>
      column.type === 'json' ? 'TEXT' : columnSqlType(column, 'postgres'),
    ),
    ...(rekey ? ['TEXT'] : []),
    'BYTEA',
    'TEXT',
    'TEXT',
  ];
  const payloadAt = projected.length + (rekey ? 1 : 0);
  const sets = [
    ...projected.map(
      (column, i) =>
        `${quoteIdent(column.name)}=v.c${i}${column.type === 'json' ? '::jsonb' : ''}`,
    ),
    ...(rekey
      ? [`${quoteIdent(SYNC_SCOPES_COLUMN)}=v.c${projected.length}::jsonb`]
      : []),
    `${quoteIdent(SYNC_PAYLOAD_COLUMN)}=v.c${payloadAt}`,
  ].join(', ');
  const aliases = types.map((_, i) => `c${i}`).join(', ');
  const partitionAlias = `c${payloadAt + 1}`;
  const rowIdAlias = `c${payloadAt + 2}`;
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
    const entries: string[][] = [];
    const values = rows.map((row) => {
      const bytes = asBytes(row.payload);
      const payload =
        oldLayout !== undefined
          ? migratePayload(oldLayout, table, bytes)
          : bytes;
      const scopes = rekey
        ? rekeyedScopes(table, decodeRow(table.columns, payload), row.row_id)
        : undefined;
      for (const [variable, value] of Object.entries(scopes ?? {})) {
        entries.push([row.partition, variable, value, row.row_id]);
      }
      const base = params.length;
      params.push(
        ...rewriteValues(
          table,
          row.partition,
          row.row_id,
          payload,
          'postgres',
          scopes,
        ),
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
    if (entries.length > 0) {
      await q.query(rekeyRowScopesSql(table, 'postgres'), [
        JSON.stringify(entries),
      ]);
    }
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
  const { rows } = await q.query<StoredRowRecord>(
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
  const { rows } = await q.query<StoredRowRecord>(
    statement.sql,
    statement.params,
  );
  return rows.map(toStoredRow);
}

/** One row a transaction has staged and not yet written. */
interface StagedRow {
  readonly row: StoredRow;
  /** `upsertValues` of the row, computed when it was staged. */
  readonly values: readonly unknown[];
  readonly opIndex?: number;
}

/**
 * A staged commit append. `commitSeq` is known when the transaction holds
 * the partition lock; otherwise the append's own allocation decides it.
 */
interface PendingAppend {
  readonly commit: NewCommit;
  readonly commitSeq?: number;
}

/**
 * One writing statement: writable CTEs and the parameters they bind. The
 * CTEs touch disjoint rows, so their order inside the statement is free.
 */
interface WriteStatement {
  readonly ctes: string[];
  readonly params: unknown[];
  /** The lowest operation index among the rows it writes. */
  opIndex?: number;
  /** True when the statement appends commits and returns the new cursor. */
  appends?: boolean;
  /** The `max_commit_seq` the statement's commit append must return. */
  allocates?: number;
}

/**
 * Bound parameters per write statement. The Bind message counts parameters
 * in 16 bits; PostgreSQL reads up to 65,535, and PGlite 0.5 corrupts its
 * state above 32,767.
 */
const PG_PARAMS_PER_STATEMENT = 30_000;

function bindParam(statement: WriteStatement, value: unknown): string {
  statement.params.push(value);
  return `$${statement.params.length}`;
}

/**
 * The CTEs that write rows of one table: the upsert, the scope index synced
 * to each row's scope map (entries outside it deleted, missing ones
 * inserted), and the §5.9.4 blob-reference index synced to the ids the row
 * now references. Row ids are distinct, so no index entry is touched twice.
 * The scopes and blob ids bind as text before the JSONB cast; drivers that
 * encode JSONB parameters would otherwise store the string as a scalar.
 */
function addRowWrites(
  statement: WriteStatement,
  compiled: CompiledTable,
  partition: string,
  rows: readonly StagedRow[],
  blobRefs: readonly { row_id: string; blob_ids: readonly string[] }[],
): void {
  const k = statement.ctes.length;
  const offset = statement.params.length;
  statement.params.push(...rows.flatMap((entry) => entry.values));
  const scopes = bindParam(
    statement,
    JSON.stringify(
      rows.map(({ row }) => ({ row_id: row.rowId, scopes: row.scopes })),
    ),
  );
  const p = bindParam(statement, partition);
  const tbl = bindParam(statement, compiled.name);
  statement.ctes.push(
    `u${k} AS (${upsertSql(compiled, 'postgres', rows.length, offset)})`,
    `b${k} AS (SELECT row_id, scopes FROM jsonb_to_recordset(${scopes}::text::jsonb) AS r(row_id text, scopes jsonb))`,
    `rs${k} AS (DELETE FROM sync_row_scopes existing USING b${k}
       WHERE existing.partition=${p} AND existing.tbl=${tbl}
         AND existing.row_id=b${k}.row_id
         AND b${k}.scopes->>existing.var IS DISTINCT FROM existing.value)`,
    `is${k} AS (INSERT INTO sync_row_scopes(partition, tbl, var, value, row_id)
       SELECT ${p}, ${tbl}, entry.key, entry.value, b${k}.row_id
         FROM b${k} CROSS JOIN LATERAL jsonb_each_text(b${k}.scopes) AS entry
       ON CONFLICT DO NOTHING)`,
  );
  for (const entry of rows) {
    if (
      entry.opIndex !== undefined &&
      (statement.opIndex === undefined || entry.opIndex < statement.opIndex)
    ) {
      statement.opIndex = entry.opIndex;
    }
  }
  if (blobRefs.length > 0) addBlobRefWrites(statement, p, tbl, blobRefs);
}

/** Replace the §5.9.4 reference sets of rows of one table. */
function addBlobRefWrites(
  statement: WriteStatement,
  p: string,
  tbl: string,
  blobRefs: readonly { row_id: string; blob_ids: readonly string[] }[],
): void {
  const k = statement.ctes.length;
  const refs = bindParam(statement, JSON.stringify(blobRefs));
  statement.ctes.push(
    `rr${k} AS (DELETE FROM sync_blob_refs existing
       WHERE existing.partition=${p} AND existing.tbl=${tbl}
         AND existing.row_id IN (SELECT r.row_id FROM jsonb_to_recordset(${refs}::text::jsonb) AS r(row_id text, blob_ids jsonb))
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_to_recordset(${refs}::text::jsonb) AS r(row_id text, blob_ids jsonb)
             CROSS JOIN LATERAL jsonb_array_elements_text(r.blob_ids) AS entry(value)
            WHERE r.row_id=existing.row_id AND entry.value=existing.blob_id))`,
    `ir${k} AS (INSERT INTO sync_blob_refs(partition, tbl, row_id, blob_id)
       SELECT ${p}, ${tbl}, r.row_id, entry.value
         FROM jsonb_to_recordset(${refs}::text::jsonb) AS r(row_id text, blob_ids jsonb)
         CROSS JOIN LATERAL jsonb_array_elements_text(r.blob_ids) AS entry(value)
       ON CONFLICT DO NOTHING)`,
  );
}

/**
 * The CTEs that append commits with consecutive `commitSeq`s: the partition
 * cursor and delete floor (§2.2), the commit rows, their changes with the
 * inverted scope entries, and the §5 delete tombstones. The cursor advances
 * by the number of commits, and every row takes its commit's sequence from
 * the advanced cursor; the statement returns the cursor, which a caller that
 * computed the sequences under the partition lock checks. Every list binds
 * as one JSON text parameter, so the parameter count does not grow with the
 * change count. A tombstone keeps the change's row version (§2.2); a row
 * live again at the end of its commit (a §2.2 scope move) gets none, and a
 * later delete of the same row overwrites an earlier one.
 */
function addAppends(
  statement: WriteStatement,
  partition: string,
  writerVersion: number,
  appends: readonly PendingAppend[],
): void {
  if (appends.length === 0) return;
  const p = bindParam(statement, partition);
  const changes: unknown[] = [];
  const tombstones = new Map<string, unknown>();
  let deleteFloor = 0;
  for (const [index, { commit }] of appends.entries()) {
    const k = index + 1;
    deleteFloor = Math.max(deleteFloor, commitDeleteFloor(commit.changes));
    const live = rowsLiveAfterDelete(commit.changes);
    for (const [idx, change] of commit.changes.entries()) {
      changes.push({
        k,
        idx,
        tbl: change.table,
        row_id: change.rowId,
        op: change.op === 'upsert' ? 1 : 2,
        version: change.rowVersion,
        scopes: change.scopes,
        payload: change.payload === undefined ? null : toBase64(change.payload),
      });
      const key = `${change.table}\u0000${change.rowId}`;
      if (change.op === 'delete' && !live.has(key)) {
        tombstones.set(key, {
          k,
          tbl: change.table,
          row_id: change.rowId,
          version: change.rowVersion,
          scopes: change.scopes,
        });
      }
    }
  }
  statement.appends = true;
  const expected = appends.at(-1)?.commitSeq;
  if (expected !== undefined) statement.allocates = expected;
  const n = bindParam(statement, appends.length);
  statement.ctes.push(
    `alloc AS (INSERT INTO sync_partitions(partition, max_commit_seq, delete_floor)
       VALUES (${p}, ${n}, ${bindParam(statement, deleteFloor)})
       ON CONFLICT (partition) DO UPDATE
         SET max_commit_seq=sync_partitions.max_commit_seq + EXCLUDED.max_commit_seq,
             delete_floor=GREATEST(sync_partitions.delete_floor, EXCLUDED.delete_floor)
       RETURNING max_commit_seq, max_commit_seq - ${n}::bigint AS base)`,
    `commits AS (INSERT INTO sync_commits(partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms, writer_version)
       SELECT ${p}, alloc.base + c.k, c.client_id, c.client_commit_id, c.actor_id, c.created_at_ms, ${bindParam(statement, writerVersion)}
         FROM alloc CROSS JOIN jsonb_to_recordset(${bindParam(
           statement,
           JSON.stringify(
             appends.map(({ commit }, index) => ({
               k: index + 1,
               client_id: commit.clientId,
               client_commit_id: commit.clientCommitId,
               actor_id: commit.actorId,
               created_at_ms: commit.createdAtMs,
             })),
           ),
         )}::text::jsonb)
           AS c(k int, client_id text, client_commit_id text, actor_id text, created_at_ms bigint))`,
  );
  if (changes.length > 0) {
    statement.ctes.push(
      `changed AS (INSERT INTO sync_changes(partition, commit_seq, idx, tbl, row_id, op, row_version, scopes, payload)
         SELECT ${p}, alloc.base + c.k, c.idx, c.tbl, c.row_id, c.op, c.version, c.scopes, decode(c.payload, 'base64')
           FROM alloc CROSS JOIN jsonb_to_recordset(${bindParam(statement, JSON.stringify(changes))}::text::jsonb)
             AS c(k int, idx int, tbl text, row_id text, op smallint, version bigint, scopes jsonb, payload text)
         RETURNING commit_seq, tbl, scopes)`,
      `change_scopes AS (INSERT INTO sync_change_scopes(partition, tbl, var, value, commit_seq)
         SELECT ${p}, changed.tbl, scope.key, scope.value, changed.commit_seq
           FROM changed CROSS JOIN LATERAL jsonb_each_text(changed.scopes) AS scope
         ON CONFLICT DO NOTHING)`,
    );
  }
  if (tombstones.size > 0) {
    statement.ctes.push(
      `tombstoned AS (INSERT INTO sync_tombstones(partition, tbl, row_id, commit_seq, server_version, scopes)
         SELECT ${p}, t.tbl, t.row_id, alloc.base + t.k, t.version, t.scopes
           FROM alloc CROSS JOIN jsonb_to_recordset(${bindParam(statement, JSON.stringify([...tombstones.values()]))}::text::jsonb)
             AS t(k int, tbl text, row_id text, version bigint, scopes jsonb)
         ON CONFLICT (partition, tbl, row_id)
         DO UPDATE SET commit_seq=excluded.commit_seq,
                       server_version=excluded.server_version,
                       scopes=excluded.scopes)`,
    );
  }
}

/**
 * The statements that write staged rows, blob references, commit appends
 * and push results. Everything shares the first statement while the bound
 * parameters fit; a large row set continues in further statements of the
 * same shape.
 */
function writeStatements(
  partition: string,
  writerVersion: number,
  resolveTable: (name: string) => CompiledTable,
  rows: ReadonlyMap<string, ReadonlyMap<string, StagedRow>>,
  blobRefs: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  appends: readonly PendingAppend[],
  results: readonly unknown[],
): WriteStatement[] {
  let current: WriteStatement = { ctes: [], params: [] };
  const statements = [current];
  addAppends(current, partition, writerVersion, appends);
  if (results.length > 0) {
    current.ctes.push(
      `results AS (INSERT INTO sync_push_results(partition, client_id, client_commit_id, result, outbox_id, client_seq)
         SELECT ${bindParam(current, partition)}, r.client_id, r.client_commit_id, r.result, r.outbox_id, r.client_seq
           FROM jsonb_to_recordset(${bindParam(current, JSON.stringify(results))}::text::jsonb)
             AS r(client_id text, client_commit_id text, result jsonb, outbox_id text, client_seq bigint)
         ON CONFLICT (partition, client_id, client_commit_id) DO NOTHING)`,
    );
  }
  for (const table of new Set([...rows.keys(), ...blobRefs.keys()])) {
    const compiled = resolveTable(table);
    const width = tableColumnNames(compiled).length;
    const chunk = Math.max(
      1,
      Math.floor((PG_PARAMS_PER_STATEMENT - 4) / width),
    );
    const pending = new Map(blobRefs.get(table));
    const staged = [...(rows.get(table)?.values() ?? [])];
    for (let first = 0; first < staged.length; first += chunk) {
      const slice = staged.slice(first, first + chunk);
      if (
        current.params.length + slice.length * width + 4 >
        PG_PARAMS_PER_STATEMENT
      ) {
        current = { ctes: [], params: [] };
        statements.push(current);
      }
      const refs: { row_id: string; blob_ids: readonly string[] }[] = [];
      for (const { row } of slice) {
        const blobIds = pending.get(row.rowId);
        if (blobIds === undefined) continue;
        pending.delete(row.rowId);
        refs.push({ row_id: row.rowId, blob_ids: blobIds });
      }
      addRowWrites(current, compiled, partition, slice, refs);
    }
    if (pending.size > 0) {
      // Refs staged for a row written by an earlier statement.
      addBlobRefWrites(
        current,
        bindParam(current, partition),
        bindParam(current, table),
        [...pending].map(([row_id, blob_ids]) => ({ row_id, blob_ids })),
      );
    }
  }
  return statements.filter((statement) => statement.ctes.length > 0);
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
    return pushResultFromJson(asJson(value));
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
  /** The FIFO without the pending-write prelude (see the constructor). */
  #serial: PgQueryable;
  #partition: string;
  /** Storage-owned relation rewrite, bound to this transaction's partition. */
  readonly #prepareQuery: (
    query: AuthoritativeQueryRequest,
  ) => BoundAuthoritativeQuery;
  /** Schema version this transaction writes; rides every appended commit row. */
  #writerVersion: number;
  #resolveTable: (name: string) => CompiledTable;
  /** The storage's `chooseScanVariable` picks. */
  readonly #scanVariables: Map<string, string>;
  #open = true;
  /** Set by `preparePushApply`: commits close with a result and roll back alone. */
  #pushApply = false;
  /** Set by `preparePushApply` on the rerun after a closed commit's write failed. */
  #closeEagerly = false;
  /** True once the request's current commit has written behind its savepoint. */
  #pushApplySavepoint = false;
  /**
   * The `commitSeq` the next appended commit takes. The partition lock read
   * sets it and freezes the cursor, so an append needs no allocation read.
   */
  #nextCommitSeq: number | undefined;
  /** The `commitSeq` the open push commit appended, until it closes. */
  #openCommitSeq: number | undefined;
  /**
   * The open commit's upserts staged per table name (row id → row and its
   * push operation index), its §5.9.4 reference sets, and its commit append.
   * They reach the database with the next statement that needs them, behind
   * the commit's savepoint, as one statement: a commit's rows cost one round
   * trip per statement instead of one per row. Tables with a unique index
   * write immediately: a violation must name its operation.
   */
  readonly #staged = new Map<string, Map<string, StagedRow>>();
  readonly #stagedBlobRefs = new Map<string, Map<string, readonly string[]>>();
  #stagedAppend: PendingAppend | undefined;
  /**
   * The writes of push commits that closed and are not yet written: rows (a
   * later commit's row replaces an earlier one), reference sets, appends in
   * `commitSeq` order, and the §2.3 results. They reach the database in one
   * statement ahead of the next statement of the transaction, outside any
   * commit's savepoint; a request whose commits never read their own writes
   * writes them all in one statement before COMMIT (§6.4).
   */
  readonly #closedRows = new Map<string, Map<string, StagedRow>>();
  readonly #closedBlobRefs = new Map<string, Map<string, readonly string[]>>();
  readonly #closedAppends: PendingAppend[] = [];
  readonly #pushResults: {
    readonly client_id: string;
    readonly client_commit_id: string;
    readonly result: unknown;
    readonly outbox_id: string | null;
    readonly client_seq: number | null;
  }[] = [];
  /**
   * `prefetchRows` results keyed `table\u0000rowId`; `null` records a row
   * (or tombstone) read as absent. A write in this transaction drops the
   * key, so the next read goes to the database again.
   */
  readonly #prefetchedRows = new Map<string, StoredRow | null>();
  readonly #prefetchedTombstones = new Map<string, Tombstone | null>();
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
    scanVariables: Map<string, string>,
  ) {
    this.#scanVariables = scanVariables;
    // One pinned connection carries one statement at a time: node-postgres
    // warns about a concurrently issued second query today and rejects it in
    // node-postgres 9. A whole-commit validator that fans independent reads
    // out with Promise.all must not interleave them, so every statement
    // issued through this transaction is chained on one FIFO — the same
    // shape as `SqliteServerStorage.queryAuthoritative`.
    let tail: Promise<void> = Promise.resolve();
    this.#serial = {
      query: <Row>(text: string, params?: readonly unknown[]) => {
        const run = tail.then(() => client.query<Row>(text, params));
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    this.#client = {
      query: (text, params) => this.#statement(text, params, 'read'),
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

  /**
   * Queue the pending writes and then one statement. `write` marks a
   * candidate write of the open commit, which needs the commit's savepoint
   * even when nothing is staged.
   */
  async #statement<Row>(
    text: string,
    params: readonly unknown[] | undefined,
    mode: 'read' | 'write',
  ): Promise<{ rows: Row[] }> {
    // Queue the pending writes ahead of this statement synchronously, so a
    // concurrently issued statement cannot overtake them.
    const pending = this.#flush(mode);
    const run = this.#serial.query<Row>(text, params);
    try {
      await pending;
    } catch (error) {
      // The aborted transaction fails the queued statement too.
      run.catch(() => undefined);
      throw error;
    }
    return run;
  }

  /**
   * Queue every pending write, in order: the closed commits' writes, then
   * the open commit's savepoint (taken before its first write reaches the
   * database, so a refused commit that wrote nothing pays for none) and its
   * staged writes. `final` is the flush before COMMIT, which no rejection
   * follows.
   *
   * A relational constraint that fails on a closed commit's writes can no
   * longer reject that commit alone: the transaction is aborted, and
   * `ClosedCommitConstraintError` tells the push layer to rerun the request
   * with each commit written before it closes (§6.4).
   *
   * Resolves to the partition cursor the open commit's append returned.
   */
  async #flush(mode: 'read' | 'write' | 'final'): Promise<number | undefined> {
    const pending: Promise<unknown>[] = [];
    let cursor: Promise<number | undefined> = Promise.resolve(undefined);
    if (
      this.#closedRows.size > 0 ||
      this.#closedBlobRefs.size > 0 ||
      this.#closedAppends.length > 0 ||
      this.#pushResults.length > 0
    ) {
      const statements = writeStatements(
        this.#partition,
        this.#writerVersion,
        this.#resolveTable,
        this.#closedRows,
        this.#closedBlobRefs,
        this.#closedAppends,
        this.#pushResults,
      );
      this.#closedRows.clear();
      this.#closedBlobRefs.clear();
      this.#closedAppends.length = 0;
      this.#pushResults.length = 0;
      pending.push(
        this.#runWrites(statements, (error) =>
          isPostgresConstraintError(error)
            ? new ClosedCommitConstraintError(error)
            : error,
        ),
      );
    }
    const staged =
      this.#staged.size > 0 ||
      this.#stagedBlobRefs.size > 0 ||
      this.#stagedAppend !== undefined;
    if (
      mode !== 'final' &&
      this.#pushApply &&
      !this.#pushApplySavepoint &&
      (staged || mode === 'write')
    ) {
      // Each commit takes its own savepoint under the same name: `ROLLBACK
      // TO` targets the newest, and an earlier commit's savepoint stays open
      // until the transaction ends, so no `RELEASE` round trip is needed.
      this.#pushApplySavepoint = true;
      pending.push(this.#serial.query('SAVEPOINT syncular_push_candidate'));
    }
    if (staged) {
      const statements = writeStatements(
        this.#partition,
        this.#writerVersion,
        this.#resolveTable,
        this.#staged,
        this.#stagedBlobRefs,
        this.#stagedAppend === undefined ? [] : [this.#stagedAppend],
        [],
      );
      this.#staged.clear();
      this.#stagedBlobRefs.clear();
      this.#stagedAppend = undefined;
      cursor = this.#runWrites(statements, (error, statement) =>
        isPostgresConstraintError(error)
          ? new StorageConstraintError(error, statement.opIndex)
          : error,
      );
      pending.push(cursor);
    }
    await Promise.all(pending);
    return cursor;
  }

  /**
   * Queue write statements on the FIFO. Resolves to the cursor a commit
   * append returned, checked against the sequences computed under the lock.
   */
  async #runWrites(
    statements: readonly WriteStatement[],
    mapError: (error: unknown, statement: WriteStatement) => unknown,
  ): Promise<number | undefined> {
    const cursors = await Promise.all(
      statements.map((statement) =>
        this.#serial
          .query<{ allocated: unknown }>(
            `WITH ${statement.ctes.join(',\n')} SELECT ${
              statement.appends === true
                ? '(SELECT max_commit_seq FROM alloc)'
                : 'NULL::bigint'
            } AS allocated`,
            statement.params,
          )
          .then(
            ({ rows }) => {
              if (statement.appends !== true) return undefined;
              const allocated = asNumber(rows[0]?.allocated);
              if (
                statement.allocates !== undefined &&
                allocated !== statement.allocates
              ) {
                throw new Error(
                  'partition commit sequence moved under the partition lock',
                );
              }
              return allocated;
            },
            (error: unknown) => {
              throw mapError(error, statement);
            },
          ),
      ),
    );
    return cursors.find((cursor) => cursor !== undefined);
  }

  /**
   * The executor of a read over `tables`: it writes the pending writes first
   * only when one of them is a row of those tables or a change of the commit
   * log to them (§6.4). A read of other tables runs without them, so it takes
   * no savepoint and moves no write ahead of itself.
   */
  #readOf(tables: readonly string[]): PgQueryable {
    return {
      query: (text, params) => {
        const appends =
          this.#stagedAppend === undefined
            ? this.#closedAppends
            : [...this.#closedAppends, this.#stagedAppend];
        return tables.some(
          (table) =>
            this.#staged.has(table) ||
            this.#closedRows.has(table) ||
            appends.some(({ commit }) =>
              commit.changes.some((change) => change.table === table),
            ),
        )
          ? this.#client.query(text, params)
          : this.#serial.query(text, params);
      },
    };
  }

  /** The candidate row this transaction staged and has not yet written. */
  #stagedRow(table: string, rowId: string): StoredRow | undefined {
    return (
      this.#staged.get(table)?.get(rowId)?.row ??
      this.#closedRows.get(table)?.get(rowId)?.row
    );
  }

  /**
   * A read by primary key. A staged row answers from memory, so the read
   * needs no pending write: it runs without flushing them, and a validator
   * that reads rows by id adds no savepoint or write round trip (§6.4).
   */
  getRow(table: string, rowId: string): Promise<StoredRow | undefined> {
    this.#assertOpen();
    const staged = this.#stagedRow(table, rowId);
    if (staged !== undefined) return Promise.resolve(staged);
    const prefetched = this.#prefetchedRows.get(`${table}\u0000${rowId}`);
    if (prefetched !== undefined) {
      return Promise.resolve(prefetched ?? undefined);
    }
    return getRowOn(
      this.#serial,
      this.#resolveTable(table),
      this.#partition,
      rowId,
    );
  }

  async getRows(
    table: string,
    rowIds: readonly string[],
  ): Promise<ReadonlyMap<string, StoredRow>> {
    this.#assertOpen();
    const rows = new Map<string, StoredRow>();
    const missing: string[] = [];
    for (const rowId of new Set(rowIds)) {
      const staged = this.#stagedRow(table, rowId);
      const prefetched = this.#prefetchedRows.get(`${table}\u0000${rowId}`);
      if (staged !== undefined) rows.set(rowId, staged);
      else if (prefetched === undefined) missing.push(rowId);
      else if (prefetched !== null) rows.set(rowId, prefetched);
    }
    if (missing.length === 0) return rows;
    // One statement for every id neither the staged writes nor the
    // admission read answered (see `getRow`).
    const { rows: records } = await this.#serial.query<StoredRowRecord>(
      selectRowsSql(this.#resolveTable(table), 'postgres'),
      [this.#partition, JSON.stringify(missing)],
    );
    for (const record of records) rows.set(record.row_id, toStoredRow(record));
    return rows;
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
        (rowId) =>
          !this.#prefetchedRows.has(`${target.table}\u0000${rowId}`) &&
          this.#stagedRow(target.table, rowId) === undefined,
      );
      if (ids.length === 0) continue;
      tables.push(this.#resolveTable(target.table));
      specs.push({ tbl: target.table, ids });
    }
    if (specs.length === 0) return;
    const { rows } = await this.#readOf(
      specs.map((spec) => spec.tbl),
    ).query<PrefetchRow>(prefetchRowsBatchSql(tables), [
      this.#partition,
      JSON.stringify(specs),
    ]);
    this.#recordPrefetched(rows);
  }

  /** Answer the following `getRow`/`getTombstone` calls from a read snapshot. */
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
          : toTombstone({
              commit_seq: record.tombstone_seq,
              server_version: record.tombstone_version,
              scopes: record.tombstone_scopes,
            }),
      );
    }
  }

  async getTombstone(
    table: string,
    rowId: string,
  ): Promise<Tombstone | undefined> {
    this.#assertOpen();
    const prefetched = this.#prefetchedTombstones.get(`${table}\u0000${rowId}`);
    if (prefetched !== undefined) return prefetched ?? undefined;
    const { rows } = await this.#readOf([table]).query<{
      commit_seq: unknown;
      server_version: unknown;
      scopes: unknown;
    }>(
      'SELECT commit_seq, server_version, scopes FROM sync_tombstones WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
    );
    const row = rows[0];
    return row === undefined || row.commit_seq === null
      ? undefined
      : toTombstone(row);
  }

  async clearTombstone(table: string, rowId: string): Promise<void> {
    this.#assertOpen();
    this.#prefetchedTombstones.delete(`${table}\u0000${rowId}`);
    await this.#statement(
      'DELETE FROM sync_tombstones WHERE partition=$1 AND tbl=$2 AND row_id=$3',
      [this.#partition, table, rowId],
      'write',
    );
  }

  async scanRows(query: RowScanQuery): Promise<StoredRow[]> {
    this.#assertOpen();
    const client = this.#readOf([query.table]);
    const variable = await chooseScanVariable(
      this.#partition,
      query,
      this.#scanVariables,
      (probes, cap) =>
        client
          .query<{ sub: unknown; n: unknown }>(scanProbeSql('postgres'), [
            this.#partition,
            JSON.stringify(probes.map((probe) => ({ ...probe, lim: cap }))),
          ])
          .then(({ rows }) => rows),
    );
    if (variable === undefined) return [];
    const values = query.scopeFilter[variable]!;
    const sql = scanRowPageSql(
      this.#resolveTable(query.table),
      values.length,
      'postgres',
    );
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const { rows: records } = await client.query<StoredRowRecord>(sql, [
        this.#partition,
        query.table,
        variable,
        ...values,
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
      this.#readOf([query.table]),
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
    // staged row and never waits for a second pool connection. The prepared
    // statement reads exactly `query.tables`: every relation of the plan is
    // one of them, rewritten to a derived relation over its own table.
    const prepared = this.#prepareQuery(query);
    const result = await this.#readOf(query.tables).query<
      Readonly<Record<string, unknown>>
    >(postgresPlaceholders(prepared.sql), prepared.params);
    // Under the partition lock the cursor is the locked `max_commit_seq` plus
    // this transaction's appends: no read. An append still held back changed
    // no table the query read, so the rows are those of that cursor.
    if (this.#nextCommitSeq !== undefined) {
      return { rows: result.rows, maxCommitSeq: this.#nextCommitSeq - 1 };
    }
    const cursor = await this.#client.query<{ max_commit_seq: unknown }>(
      'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1',
      [this.#partition],
    );
    // asNumber maps the absent row of a partition without a commit to 0.
    return {
      rows: result.rows,
      maxCommitSeq: asNumber(cursor.rows[0]?.max_commit_seq),
    };
  }

  async preparePushApply(
    clientId: string,
    commits: readonly PushApplyCommit[],
    runningSchemaVersion: number,
    outbox?: OutboxSettlement,
    options?: PushApplyOptions,
  ): Promise<PreparedPushApply> {
    this.#assertOpen();
    this.#pushApply = true;
    this.#closeEagerly = options?.closeEagerly === true;
    // The lock is its own statement: a READ COMMITTED statement's snapshot is
    // fixed at its start, so the admission read must run *after* a duplicate's
    // commit has released the partition lock to observe it. Folding the lock
    // and the read into one statement would miss a duplicate that committed
    // while this transaction waited.
    await this.lockPartition();
    const ids = new Map<string, Set<string>>();
    for (const commit of commits) {
      for (const target of commit.targets ?? []) {
        const table = ids.get(target.table) ?? new Set<string>();
        for (const rowId of target.rowIds) {
          if (!this.#prefetchedRows.has(`${target.table}\u0000${rowId}`)) {
            table.add(rowId);
          }
        }
        if (table.size > 0) ids.set(target.table, table);
      }
    }
    const tables = [...ids.keys()].map((table) => this.#resolveTable(table));
    const specs = [...ids].map(([tbl, rowIds]) => ({ tbl, ids: [...rowIds] }));
    // One statement for the whole request: the outbox settlement, the serve
    // gate, every commit's idempotency record, and the read-ahead of every
    // commit's known rows. The settlement precedes every commit's savepoint,
    // so no rejection discards it.
    const admission = await readAdmissionOn(
      this.#client,
      this.#partition,
      clientId,
      commits.map((commit) => commit.clientCommitId),
      runningSchemaVersion,
      specs.length === 0 ? undefined : { tables, specs },
      outbox,
    );
    this.#recordPrefetched(admission.prefetched);
    return {
      gate: admission.gate,
      persisted: (clientCommitId) =>
        toPersistedPushResult(admission.persisted.get(clientCommitId)),
      deleteFloor: admission.deleteFloor,
      ...(admission.watermark === undefined
        ? {}
        : { watermark: admission.watermark }),
    };
  }

  async lockPartition(): Promise<void> {
    this.#assertOpen();
    this.#nextCommitSeq =
      (await lockPartitionOn(this.#client, this.#partition)) + 1;
  }

  async pinSnapshot(): Promise<void> {
    this.#assertOpen();
    // PostgreSQL refuses this after the transaction's first statement.
    await this.#client.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
  }

  async advanceCheckpoint(
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean> {
    this.#assertOpen();
    // `RETURNING`: `PgQueryable` reports returned rows only (no affected-row
    // count), so every affected-row check counts returned rows.
    const result = await this.#statement<{ name: string }>(
      `UPDATE sync_backfill_checkpoints
          SET watermark=$1, observed_rows=$2, updated_at_ms=$3
        WHERE partition=$4 AND name=$5 AND owner_epoch=$6
        RETURNING name`,
      [watermark, observedRows, nowMs, this.#partition, name, ownerEpoch],
      'write',
    );
    return result.rows.length === 1;
  }

  readServeGate(runningSchemaVersion: number): Promise<ServeGate> {
    this.#assertOpen();
    // The transaction's own client: the gate and the write share one
    // transaction, so a migration cannot interleave between them.
    return readServeGateOn(this.#client, this.#partition, runningSchemaVersion);
  }

  async rejectPushCommit(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
    sequence?: OutboxSequence,
  ): Promise<void> {
    this.#assertOpen();
    // Candidate writes that never reached the database are discarded with the
    // staging maps; a savepoint exists only when one did. It stays open: the
    // rollback returns the database to where the next commit starts (the
    // closed commits' writes wait in memory or precede it), so the next
    // commit writes behind it.
    this.#staged.clear();
    this.#stagedBlobRefs.clear();
    this.#stagedAppend = undefined;
    if (this.#openCommitSeq !== undefined) {
      this.#nextCommitSeq = this.#openCommitSeq;
      this.#openCommitSeq = undefined;
    }
    if (this.#pushApplySavepoint) {
      this.#pushApplySavepoint = false;
      await this.#serial.query('ROLLBACK TO SAVEPOINT syncular_push_candidate');
    }
    this.#recordPushResult(clientId, clientCommitId, result, sequence);
  }

  #recordPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
    sequence: OutboxSequence | undefined,
  ): void {
    this.#pushResults.push({
      client_id: clientId,
      client_commit_id: clientCommitId,
      result: pushResultToJson(result),
      outbox_id: sequence?.outboxId ?? null,
      client_seq: sequence?.clientSeq ?? null,
    });
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
    const entry = {
      row,
      values,
      ...(context === undefined ? {} : { opIndex: context.opIndex }),
    };
    if (!compiled.indexes.some((index) => index.unique === true)) {
      let rows = this.#staged.get(table);
      if (rows === undefined) {
        rows = new Map();
        this.#staged.set(table, rows);
      }
      // A later upsert of the same row in this transaction replaces it.
      rows.delete(row.rowId);
      rows.set(row.rowId, entry);
      return;
    }
    const refs = this.#stagedBlobRefs.get(table);
    const blobIds = refs?.get(row.rowId);
    if (blobIds !== undefined && refs !== undefined) {
      refs.delete(row.rowId);
      if (refs.size === 0) this.#stagedBlobRefs.delete(table);
    }
    const statements = writeStatements(
      this.#partition,
      this.#writerVersion,
      this.#resolveTable,
      new Map([[table, new Map([[row.rowId, entry]])]]),
      blobIds === undefined
        ? new Map()
        : new Map([[table, new Map([[row.rowId, blobIds]])]]),
      [],
      [],
    );
    try {
      for (const statement of statements) {
        await this.#statement(
          `WITH ${statement.ctes.join(',\n')} SELECT 1`,
          statement.params,
          'write',
        );
      }
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
    // One statement: the row, its scope-index entries, and (§5.9.4: a
    // deleted row references no blobs) its blob references.
    await this.#statement(
      `WITH deleted AS (${deleteRowSql(this.#resolveTable(table), 'postgres')}),
       unscoped AS (
         DELETE FROM sync_row_scopes WHERE partition=$1 AND tbl=$3 AND row_id=$2
       )
       DELETE FROM sync_blob_refs WHERE partition=$1 AND tbl=$3 AND row_id=$2`,
      [this.#partition, rowId, table],
      'write',
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

  /**
   * Stage the append with the commit's rows. Under the partition lock the
   * cursor is frozen, so the next `commitSeq` is known without a statement
   * and a push commit's append waits for the next statement. Outside a push
   * apply the append is written at once (its allocation takes the lock when
   * no earlier statement did), so a relational constraint on the staged rows
   * fails this call.
   */
  async appendCommit(commit: NewCommit): Promise<number> {
    this.#assertOpen();
    if (this.#stagedAppend !== undefined || this.#openCommitSeq !== undefined) {
      throw new Error('the open commit already appended');
    }
    // The commit writes its delete tombstones; every other prefetched
    // tombstone still holds for the request's later commits.
    for (const change of commit.changes) {
      if (change.op === 'delete') {
        this.#prefetchedTombstones.delete(
          `${change.table}\u0000${change.rowId}`,
        );
      }
    }
    const commitSeq = this.#nextCommitSeq;
    if (commitSeq === undefined) {
      this.#stagedAppend = { commit };
      const allocated = await this.#flush('write');
      if (allocated === undefined) {
        throw new Error('the commit append returned no cursor');
      }
      this.#nextCommitSeq = allocated + 1;
      return allocated;
    }
    this.#nextCommitSeq = commitSeq + 1;
    this.#stagedAppend = { commit, commitSeq };
    if (this.#pushApply) this.#openCommitSeq = commitSeq;
    else await this.#flush('write');
    return commitSeq;
  }

  async putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
    sequence?: OutboxSequence,
  ): Promise<void> {
    this.#assertOpen();
    // On the rerun after a closed commit's write failed, the commit writes
    // behind its savepoint before it closes, so a relational constraint
    // rejects it alone (`StorageConstraintError`).
    if (this.#closeEagerly) await this.#flush('read');
    this.#recordPushResult(clientId, clientCommitId, result, sequence);
    // The commit is closed: its writes join the closed commits', and the next
    // commit's first write takes its own savepoint.
    for (const [table, rows] of this.#staged) {
      const closed = this.#closedRows.get(table) ?? new Map();
      for (const [rowId, entry] of rows) {
        closed.delete(rowId);
        closed.set(rowId, entry);
      }
      this.#closedRows.set(table, closed);
    }
    for (const [table, refs] of this.#stagedBlobRefs) {
      const closed = this.#closedBlobRefs.get(table) ?? new Map();
      for (const [rowId, blobIds] of refs) closed.set(rowId, blobIds);
      this.#closedBlobRefs.set(table, closed);
    }
    if (this.#stagedAppend !== undefined) {
      this.#closedAppends.push(this.#stagedAppend);
    }
    this.#staged.clear();
    this.#stagedBlobRefs.clear();
    this.#stagedAppend = undefined;
    this.#openCommitSeq = undefined;
    this.#pushApplySavepoint = false;
  }

  async enqueueReactions(reactions: readonly NewReaction[]): Promise<void> {
    this.#assertOpen();
    for (const reaction of reactions) {
      await this.#statement(
        `INSERT INTO sync_reactions(
           partition, idempotency_key, type, version, payload,
           source_client_id, source_client_commit_id, source_commit_seq,
           created_at_ms, available_at_ms, status, attempts, max_attempts
         ) VALUES ($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9,$9,'pending',0,$10)`,
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
        'write',
      );
    }
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    // Every pending write in one statement where the parameters fit.
    await this.#flush('final');
    this.#open = false;
    // Signal the transaction wrapper to COMMIT; wait for it to actually land.
    this.#resolve();
    await this.#done;
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;
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
  /** `chooseScanVariable` picks, shared with this storage's transactions. */
  readonly #scanVariables = new Map<string, string>();

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
    const current = async (db: PgQueryable): Promise<boolean> => {
      const { rows } = await db.query<{
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
      return rows[0]?.storage === fingerprint && rows[0].missing === 0;
    };
    if (await current(this.#exec)) return;
    // Concurrent `CREATE TABLE IF NOT EXISTS` races in `pg_type` and fails
    // with `type ... already exists`. A transaction-scoped advisory lock
    // serializes the DDL across processes; the winner applies it and the
    // others find the fingerprint current once the lock frees.
    await this.#exec.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('syncular.migrate'))",
      );
      if (await current(tx)) return;
      for (const statement of statements) {
        await tx.query(statement);
      }
      // The fingerprint is lowercase hex, safe to inline (COMMENT takes no
      // bound parameter).
      await tx.query(`COMMENT ON TABLE sync_schema_meta IS '${fingerprint}'`);
    });
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
      throw new StorageQueryError('sync.storage.schema_changed', {
        storedVersion: String(stored),
        configuredVersion: String(schema.version),
      });
    }
    if (stored !== undefined && stored === schema.version) {
      const storedLayouts =
        typeof marker.layouts === 'string' ? marker.layouts : undefined;
      assertStoredLayouts(schema, storedLayouts);
      if (!assertStoredScopePatterns(schema, storedLayouts)) {
        // A marker from before 0.63 records no scope patterns: record the
        // configured ones, which every later start compares against.
        await this.#exec.query(
          'UPDATE sync_schema_meta SET layouts=$1 WHERE id=1 AND schema_version=$2',
          [layoutsOf(schema), schema.version],
        );
      }
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
          throw new StorageQueryError('sync.storage.schema_changed', {
            storedVersion: String(lockedVersion),
            configuredVersion: String(schema.version),
          });
        }
        if (lockedVersion === schema.version) return;
        const lockedLayouts =
          typeof lockedMarker[0]?.layouts === 'string'
            ? lockedMarker[0].layouts
            : undefined;
        const rekeyed = (changedScopePatterns(schema, lockedLayouts) ?? []).map(
          (change) => change.table,
        );
        const layouts = parseLayouts(lockedLayouts);
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
        for (const statement of rekeyCleanupSql(rekeyed)) {
          await client.query(statement);
        }
        for (const table of schema.tables.values()) {
          const oldLayout = layouts[table.name];
          const plan = rewritePlan(table, oldLayout, existing.get(table.name));
          // SPEC §2.4: payload bytes are unchanged; only the constraint goes.
          for (const column of plan.relaxed) {
            await client.query(
              `ALTER TABLE ${quoteIdent(table.name)} ALTER COLUMN ${quoteIdent(column)} DROP NOT NULL`,
            );
          }
          const rekey = rekeyed.includes(table.name);
          if (!plan.migrate && !plan.backfill && !rekey) continue;
          await rewriteRowsOn(
            client,
            table,
            plan.migrate ? oldLayout : undefined,
            rekey,
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
  ): Promise<PartitionTouch> {
    if (initialLogEpoch.length === 0) {
      throw new Error('initial log epoch must be non-empty');
    }
    type Registry = {
      log_epoch: string;
      epoch_required: boolean;
      last_authenticated_at_ms: unknown;
      checkpoint_schema_version: number | null;
    };
    const checkpointVersion = `(SELECT max(schema_version)
             FROM sync_backfill_checkpoints WHERE partition=$1)
           AS checkpoint_schema_version`;
    let row = (
      await this.#exec.query<Registry>(
        `SELECT log_epoch, epoch_required, last_authenticated_at_ms,
                ${checkpointVersion}
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
           RETURNING log_epoch, epoch_required, last_authenticated_at_ms,
             ${checkpointVersion}`,
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
      checkpointSchemaVersion: row.checkpoint_schema_version ?? undefined,
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
      await client.query(
        `DELETE FROM sync_push_results WHERE partition=$1 AND result->>'status'='fenced'`,
        [partition],
      );
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
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<PostgresTransaction>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    let opened = false;
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
          this.#scanVariables,
        );
        opened = true;
        resolveReady(tx);
        // Hold the transaction open until commit()/rollback() settles `scope`.
        await scope;
      })
      .catch((error: unknown) => {
        if (error instanceof RollbackSignal) return;
        // The executor failed before the callback ran (no connection, BEGIN
        // refused): `begin()` itself rejects, and no transaction exists to
        // observe `done`.
        if (!opened) {
          rejectReady(error);
          return;
        }
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

  async getHorizons(partition: string): Promise<PartitionHorizons> {
    const { rows } = await this.#exec.query<{ seq: unknown; tables: string }>(
      `SELECT coalesce((SELECT horizon_seq FROM sync_partitions WHERE partition=$1),0) AS seq,
              coalesce((SELECT jsonb_object_agg(tbl, commit_seq) FROM sync_table_horizons WHERE partition=$1),'{}')::text AS tables`,
      [partition],
    );
    return {
      seq: asNumber(rows[0]?.seq),
      tables: new Map(
        Object.entries(asJson<Record<string, number>>(rows[0]?.tables ?? '{}')),
      ),
    };
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
        'DELETE FROM sync_commits WHERE partition=$1 AND commit_seq<=$2 RETURNING commit_seq',
        [partition, horizonSeq],
      );
      // Scope entries go by the keys of the changes being pruned, before
      // those changes are deleted: a `commit_seq` predicate alone would scan
      // the partition's whole scope index (`commit_seq` is its last key column).
      await client.query(
        `DELETE FROM sync_change_scopes s USING (
           SELECT DISTINCT c.tbl, e.key, e.value, c.commit_seq
           FROM sync_changes c CROSS JOIN LATERAL jsonb_each_text(c.scopes) e
           WHERE c.partition=$1 AND c.commit_seq<=$2) k
         WHERE s.partition=$1 AND s.tbl=k.tbl AND s.var=k.key
           AND s.value=k.value AND s.commit_seq=k.commit_seq`,
        [partition, horizonSeq],
      );
      await client.query(
        'DELETE FROM sync_changes WHERE partition=$1 AND commit_seq<=$2',
        [partition, horizonSeq],
      );
      // §4.6: tombstones and table horizons prune in the same pass as the
      // commit log.
      for (const table of ['sync_tombstones', 'sync_table_horizons']) {
        await client.query(
          `DELETE FROM ${table} WHERE partition=$1 AND commit_seq<=$2`,
          [partition, horizonSeq],
        );
      }
      return {
        previousHorizonSeq,
        horizonSeq,
        removedCommits: removed.rows.length,
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
    const { rows } = await this.#exec.query<StoredReactionRecord>(
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
          AND status='leased' AND lease_owner=$3
        RETURNING idempotency_key`,
      [partition, idempotencyKey, leaseOwner, completedAtMs],
    );
    return result.rows.length === 1;
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
          AND status='leased' AND lease_owner=$3
        RETURNING idempotency_key`,
      [partition, idempotencyKey, leaseOwner, leaseExpiresAtMs],
    );
    return result.rows.length === 1;
  }

  async failReaction(
    partition: string,
    idempotencyKey: string,
    update: ReactionFailureUpdate,
  ): Promise<boolean> {
    const result = await this.#exec.query(
      `UPDATE sync_reactions
          SET status=$4, available_at_ms=$5, last_failure=$6::text::jsonb,
              lease_owner=NULL, lease_expires_at_ms=NULL
        WHERE partition=$1 AND idempotency_key=$2
          AND status='leased' AND lease_owner=$3
        RETURNING idempotency_key`,
      [
        partition,
        idempotencyKey,
        update.leaseOwner,
        update.retryAtMs === undefined ? 'dead-letter' : 'pending',
        update.retryAtMs ?? update.failure.atMs,
        JSON.stringify(update.failure),
      ],
    );
    return result.rows.length === 1;
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
        WHERE partition=$1 AND idempotency_key=$2 AND status='dead-letter'
        RETURNING idempotency_key`,
      [partition, idempotencyKey, nowMs],
    );
    return result.rows.length === 1;
  }

  async getReaction(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction | undefined> {
    const { rows } = await this.#exec.query<StoredReactionRecord>(
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
    const { rows } = await this.#exec.query<StoredReactionRecord>(
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
    query: { readonly table: string; readonly scopes: UnitScopes },
  ): Promise<number> {
    const keys = Object.entries(query.scopes).sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    if (keys.length === 0) return 0;
    // Concurrent reads of a pull share one statement across tables. Per spec
    // a leapfrog over the unit's key ranges: each step seeks the next key's
    // newest commit at or below the current bound.
    const [row] = await this.#batchedPage<{ seq: unknown }>(
      'latestScopedChange',
      `SELECT s.i AS sub, (
         WITH RECURSIVE step(seq, i, same) AS (
           SELECT 9007199254740991::bigint, 0, 0
           UNION ALL
           SELECT x.seq, step.i+1,
                  CASE WHEN x.seq=step.seq THEN step.same+1 ELSE 1 END
           FROM step CROSS JOIN LATERAL (
             SELECT max(c.commit_seq) AS seq FROM sync_change_scopes AS c
              WHERE c.partition=$1 AND c.tbl=s.tbl
                AND c.var=s.keys->(step.i%s.n)->>0 AND c.value=s.keys->(step.i%s.n)->>1
                AND c.commit_seq<=step.seq) AS x
           WHERE step.seq IS NOT NULL AND step.same<s.n)
         SELECT seq FROM step WHERE same>=s.n) AS seq
       FROM jsonb_to_recordset($2::text::jsonb) AS s(i int, tbl text, keys jsonb, n int)
       ORDER BY s.i`,
      partition,
      { tbl: query.table, keys, n: keys.length },
    );
    return row === undefined || row.seq === null ? 0 : asNumber(row.seq);
  }

  readLiveWindow(
    partition: string,
    query: LiveWindowQuery,
  ): Promise<LiveWindow> {
    // Two statements per page. The candidate read takes one LATERAL range of
    // `sync_change_scopes_by_key` per unit key, each DISTINCT and LIMITed at
    // the index, merged in commit order and LIMITed again into one array.
    // `walk` then sizes the candidates one at a time and stops after the one
    // that reaches the budget: per key, the count and byte size of the
    // commit's changes the key reads. Each change's scopes expand once and
    // hash-join the keys on (var, value); `octet_length` of a TOASTed payload
    // reads its pointer, never the value. Every walked commit LEFT JOINs its
    // meta (NULL when the commit vanished, which still advances the scan).
    // The change read then seeks only the commits the byte budget admits,
    // matching each change to the keys by the same join.
    return readLiveWindowPages(
      query,
      async (keys, limit, budget) => {
        const { rows } = await this.#exec.query<{
          commit_seq: unknown;
          actor_id: string | null;
          created_at_ms: unknown;
          key: unknown;
          bytes: unknown;
          changes: unknown;
        }>(
          `WITH RECURSIVE k AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($2::text::jsonb) AS k(i int, var text, value text, after bigint, tables jsonb)),
           c AS MATERIALIZED (SELECT coalesce(array_agg(d.commit_seq ORDER BY d.commit_seq), '{}') AS seqs
             FROM (SELECT DISTINCT s.commit_seq
               FROM k CROSS JOIN LATERAL (SELECT DISTINCT commit_seq FROM sync_change_scopes
                 WHERE partition=$1 AND var=k.var AND value=k.value
                   AND commit_seq>k.after AND commit_seq<=$3
                 ORDER BY commit_seq LIMIT $4) s
               ORDER BY s.commit_seq LIMIT $4) d),
           km AS MATERIALIZED (SELECT jsonb_object_agg(x.var, x.vals) AS m
             FROM (SELECT var, jsonb_object_agg(value, jsonb_build_array(i, after, tables)) AS vals FROM k GROUP BY var) x),
           walk(n, commit_seq, changes, bytes, sizes) AS (
             SELECT 0, NULL::bigint, 0::numeric, 0::numeric, NULL::jsonb
             UNION ALL
             SELECT w.n+1, c.seqs[w.n+1], w.changes+z.changes, w.bytes+z.bytes, z.sizes
             FROM walk w CROSS JOIN c CROSS JOIN km CROSS JOIN LATERAL (
               SELECT coalesce(sum(g.changes), 0) AS changes, coalesce(sum(g.bytes), 0) AS bytes,
                 jsonb_agg(jsonb_build_array(g.key, g.bytes, g.changes)) AS sizes
               FROM (SELECT (x.kv->>0)::int AS key, count(*) AS changes,
                   sum(coalesce(octet_length(ch.payload), 0) + octet_length(ch.row_id) + octet_length(ch.scopes::text)) AS bytes
                 FROM sync_changes ch
                 CROSS JOIN LATERAL jsonb_each_text(CASE jsonb_typeof(ch.scopes) WHEN 'string' THEN (ch.scopes#>>'{}')::jsonb ELSE ch.scopes END) e
                 CROSS JOIN LATERAL (SELECT km.m->e.key->e.value AS kv) x
                 WHERE ch.partition=$1 AND ch.commit_seq=c.seqs[w.n+1]
                   AND ch.commit_seq>(x.kv->>1)::bigint AND x.kv->2 @> to_jsonb(ch.tbl)
                 GROUP BY 1) g) z
             WHERE w.n<cardinality(c.seqs) AND w.changes<$5 AND w.bytes<=$6)
           SELECT w.commit_seq AS commit_seq, m.actor_id AS actor_id, m.created_at_ms AS created_at_ms,
             (z->>0)::int AS key, (z->>1)::bigint AS bytes, (z->>2)::bigint AS changes
           FROM walk w
           LEFT JOIN sync_commits m ON m.partition=$1 AND m.commit_seq=w.commit_seq
           LEFT JOIN LATERAL jsonb_array_elements(w.sizes) z ON true
           WHERE w.n>0
           ORDER BY w.commit_seq, key`,
          [
            partition,
            JSON.stringify(keys),
            query.throughSeq,
            limit,
            budget.changes,
            budget.bytes,
          ],
        );
        return rows.map((record) => ({
          commitSeq: asNumber(record.commit_seq),
          ...(record.actor_id === null
            ? {}
            : {
                meta: {
                  actorId: record.actor_id,
                  createdAtMs: asNumber(record.created_at_ms),
                },
              }),
          ...(record.key === null
            ? {}
            : {
                key: asNumber(record.key),
                bytes: asNumber(record.bytes),
                changes: asNumber(record.changes),
              }),
        }));
      },
      async (keys, commitSeqs) => {
        const { rows } = await this.#exec.query<
          StoredChangeRecord & { commit_seq: unknown }
        >(
          `WITH km AS MATERIALIZED (SELECT jsonb_object_agg(x.var, x.vals) AS m
             FROM (SELECT var, jsonb_object_agg(value, jsonb_build_array(after, tables)) AS vals
               FROM jsonb_to_recordset($2::text::jsonb) AS k(var text, value text, after bigint, tables jsonb) GROUP BY var) x)
           SELECT ch.commit_seq AS commit_seq, ch.tbl AS tbl, ch.row_id AS row_id, ch.op AS op,
             ch.row_version AS row_version, ch.scopes AS scopes, ch.payload AS payload
           FROM sync_changes ch CROSS JOIN km
           WHERE ch.partition=$1 AND ch.commit_seq=ANY(ARRAY(SELECT jsonb_array_elements_text($3::text::jsonb)::bigint))
             AND EXISTS (SELECT 1 FROM jsonb_each_text(CASE jsonb_typeof(ch.scopes) WHEN 'string' THEN (ch.scopes#>>'{}')::jsonb ELSE ch.scopes END) e
               CROSS JOIN LATERAL (SELECT km.m->e.key->e.value AS kv) x
               WHERE ch.commit_seq>(x.kv->>0)::bigint AND x.kv->1 @> to_jsonb(ch.tbl))
           ORDER BY ch.commit_seq, ch.idx`,
          [partition, JSON.stringify(keys), JSON.stringify(commitSeqs)],
        );
        return rows.map((record) => ({
          commitSeq: asNumber(record.commit_seq),
          change: toStoredChange(record),
        }));
      },
    );
  }

  #scanVariable(
    partition: string,
    query: RowScanQuery,
  ): Promise<string | undefined> {
    // The probes of concurrent scans leave as one statement, like their pages.
    return chooseScanVariable(
      partition,
      query,
      this.#scanVariables,
      (probes, cap) =>
        Promise.all(
          probes.map(async (probe) => {
            const [row] = await this.#batchedPage<{ n: unknown }>(
              'scanProbe',
              scanProbeSql('postgres'),
              partition,
              { tbl: probe.tbl, var: probe.var, vals: probe.vals, lim: cap },
            );
            return { sub: probe.i, n: row?.n };
          }),
        ),
    );
  }

  async countScopedRows(
    partition: string,
    query: Pick<RowScanQuery, 'table' | 'scopeFilter'>,
  ): Promise<number> {
    const variable = await this.#scanVariable(partition, {
      ...query,
      afterRowId: null,
      limit: 0,
    });
    if (variable === undefined) return 0;
    // The counts of concurrent bootstraps leave as one statement.
    const [row] = await this.#batchedPage<{ n: unknown }>(
      'countRows',
      countRowsSql('postgres'),
      partition,
      {
        tbl: query.table,
        vars: Object.entries(query.scopeFilter).map(([name, vals]) => ({
          var: name,
          vals,
        })),
      },
    );
    return row === undefined ? 0 : asNumber(row.n);
  }

  async scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]> {
    const variable = await this.#scanVariable(partition, query);
    if (variable === undefined) return [];
    // Candidates via the inverted index (ordered + LIMITed at the covering
    // PK) LEFT JOINed to the row table — one round trip per page, never one
    // per row, and concurrent scans across tables share one statement (see
    // `scanRowBatchSql`). Exact multi-variable verification against the
    // stored scope map happens below.
    const rows: StoredRow[] = [];
    let afterRowId = query.afterRowId ?? '';
    const batchSize = Math.max(64, query.limit);
    while (rows.length < query.limit) {
      const records = await this.#batchedPage<StoredRowRecord>(
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
          var: variable,
          vals: query.scopeFilter[variable],
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
    const { rows } = await this.#exec.query<
      Parameters<typeof toClientRecord>[0]
    >(
      `SELECT ${CLIENT_RECORD_COLUMNS} FROM sync_clients WHERE partition=$1 AND client_id=$2`,
      [partition, clientId],
    );
    return rows[0] === undefined ? undefined : toClientRecord(rows[0]);
  }

  async putClientRecord(
    partition: string,
    record: ClientRecord,
    options?: ClientRecordWriteOptions,
  ): Promise<void> {
    // Every non-key field comes from the new record, except the registration
    // list and digest, which only a traveling list replaces (§4.5).
    const registration = record.registration;
    await this.#exec.query(
      `INSERT INTO sync_clients(partition, client_id, actor_id, wire_version, cursor, updated_at_ms, last_round_at_ms, schema_version, units, registration_digest, catching_up)
       VALUES ($1,$2,$3,$4,$5,$6,$11,$7,$8::text::jsonb,$9,$10::text::jsonb)
       ON CONFLICT (partition, client_id) DO UPDATE
         SET actor_id=EXCLUDED.actor_id, wire_version=EXCLUDED.wire_version,
             cursor=EXCLUDED.cursor,
             updated_at_ms=EXCLUDED.updated_at_ms,
             last_round_at_ms=EXCLUDED.last_round_at_ms,
             schema_version=EXCLUDED.schema_version,${
               registration === undefined
                 ? ''
                 : '\n             units=EXCLUDED.units, registration_digest=EXCLUDED.registration_digest,'
             }
             catching_up=EXCLUDED.catching_up${
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
        record.updatedAtMs,
        record.schemaVersion ?? null,
        registration === undefined ? null : JSON.stringify(registration.units),
        registration?.digest ?? null,
        JSON.stringify(record.catchingUp),
        record.lastRoundAtMs ?? record.updatedAtMs,
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
    // §8.2: the ack never raises the record cursor above a catching-up
    // unit's cursor, so pruning keeps that unit's history (§4.6).
    await this.#exec.query(
      `UPDATE sync_clients
         SET cursor=GREATEST(cursor, LEAST($1::bigint, COALESCE((
               SELECT min((u->>'cursor')::bigint)
                 FROM jsonb_array_elements(sync_clients.catching_up) AS u
                WHERE (u->>'cursor')::bigint>=0), $1::bigint))),
             updated_at_ms=GREATEST(updated_at_ms, $2)
         WHERE partition=$3 AND client_id=$4 AND actor_id=$5
           AND EXISTS (SELECT 1 FROM sync_partition_registry
                       WHERE partition=sync_clients.partition AND log_epoch=$6)`,
      [cursor, updatedAtMs, partition, clientId, actorId, logEpoch],
    );
  }

  async getActiveClientCursorFloor(
    partition: string,
    cutoffMs: number,
  ): Promise<number | null> {
    const { rows } = await this.#exec.query<{ cursor: unknown }>(
      'SELECT MIN(cursor) AS cursor FROM sync_clients WHERE partition=$1 AND updated_at_ms>=$2 AND cursor>=0',
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
    // One statement: the by-blob index (§5.9.4/§5.9.5) supplies the candidate
    // rows and each row's stored scopes come from its row table for the §3.4
    // authorization test (see `rowsReferencingBlobSql`).
    if (this.#tables === undefined || this.#tables.size === 0) return [];
    const { rows } = await this.#exec.query<{
      tbl: string;
      row_id: string;
      scopes: unknown;
    }>(rowsReferencingBlobSql(this.#tables.values(), 'postgres'), [
      partition,
      blobId,
    ]);
    return rows.flatMap((row) =>
      row.scopes === null
        ? []
        : [
            {
              table: row.tbl,
              rowId: row.row_id,
              scopes: asJson<Record<string, string>>(row.scopes),
            },
          ],
    );
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
         WHERE c.partition=$1 AND c.commit_seq=d.commit_seq AND c.idx=d.idx
         RETURNING c.commit_seq`,
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
           AND cs.commit_seq=d.commit_seq
         RETURNING cs.commit_seq`,
        params,
      );
      // §4.6.1: stored conflict results of the binding lose their row payload.
      const results = await client.query(
        `UPDATE sync_push_results p SET result=jsonb_set(p.result, '{results}', (
           SELECT jsonb_agg(e - 'serverRow' ORDER BY i)
             FROM jsonb_array_elements(p.result->'results')
                  WITH ORDINALITY AS t(e, i)))
         FROM (
           SELECT client_id, client_commit_id FROM sync_push_results
            WHERE partition=$1
              AND result->'conflictAuthorization'->>'table'=$2
              AND result->'conflictAuthorization'->'scopes'->>$3=$4
              AND jsonb_path_exists(result, '$.results[*].serverRow')
            LIMIT $5) d
         WHERE p.partition=$1 AND p.client_id=d.client_id
           AND p.client_commit_id=d.client_commit_id
         RETURNING p.client_id`,
        [partition, query.table, query.variable, query.value, query.limit],
      );
      return changes.rows.length + scopes.rows.length + results.rows.length;
    });
  }

  // -- admin/console read surface --------------------------------------------

  async listClientRecords(partition: string): Promise<ClientRecord[]> {
    const { rows } = await this.#exec.query<
      Parameters<typeof toClientRecord>[0]
    >(
      `SELECT ${CLIENT_RECORD_COLUMNS} FROM sync_clients WHERE partition=$1 ORDER BY updated_at_ms DESC`,
      [partition],
    );
    return rows.map(toClientRecord);
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
    // One grouped statement for the page's per-table change counts and, with
    // `changeSample`, one for the first `sample` changes (change-index order)
    // of every listed commit.
    const sampleCount =
      query.changeSample !== undefined &&
      Number.isInteger(query.changeSample) &&
      query.changeSample > 0
        ? query.changeSample
        : 0;
    const seqs = rows.map((row) => asNumber(row.commit_seq));
    const counts = new Map<number, { tbl: string; n: unknown }[]>();
    for (const count of seqs.length === 0
      ? []
      : (
          await this.#exec.query<{
            commit_seq: unknown;
            tbl: string;
            n: unknown;
          }>(
            `SELECT commit_seq, tbl, count(*) AS n FROM sync_changes
             WHERE partition=$1 AND commit_seq IN (SELECT jsonb_array_elements_text($2::text::jsonb)::bigint)
             GROUP BY commit_seq, tbl ORDER BY commit_seq, tbl`,
            [partition, JSON.stringify(seqs)],
          )
        ).rows) {
      const seq = asNumber(count.commit_seq);
      counts.set(seq, [...(counts.get(seq) ?? []), count]);
    }
    const samples = new Map<number, CommitChangeSummary[]>();
    for (const change of sampleCount === 0 || seqs.length === 0
      ? []
      : (
          await this.#exec.query<{
            commit_seq: unknown;
            tbl: string;
            row_id: string;
            op: unknown;
          }>(
            `SELECT commit_seq, tbl, row_id, op FROM sync_changes
             WHERE partition=$1 AND commit_seq IN (SELECT jsonb_array_elements_text($2::text::jsonb)::bigint) AND idx<$3
             ORDER BY commit_seq, idx`,
            [partition, JSON.stringify(seqs), sampleCount],
          )
        ).rows) {
      const seq = asNumber(change.commit_seq);
      samples.set(seq, [
        ...(samples.get(seq) ?? []),
        {
          table: change.tbl,
          rowId: change.row_id,
          op: asNumber(change.op) === 1 ? 'upsert' : 'delete',
        },
      ]);
    }
    const out: CommitMetadata[] = [];
    for (const row of rows) {
      const commitSeq = asNumber(row.commit_seq);
      const changes = counts.get(commitSeq) ?? [];
      out.push({
        commitSeq,
        clientId: row.client_id,
        clientCommitId: row.client_commit_id,
        actorId: row.actor_id,
        createdAtMs: asNumber(row.created_at_ms),
        changeCount: changes.reduce((sum, c) => sum + asNumber(c.n), 0),
        tables: changes.map((c) => c.tbl),
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
    const { rows: changeRows } = await this.#exec.query<StoredChangeRecord>(
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
    const { rows } = await this.#exec.query<StoredRowRecord>(
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
          result: pushResultFromJson(asJson(row.result)),
        };
      } catch {
        throw syncError(
          'sync.idempotency_cache_miss',
          'persisted push result unreadable (§6.3)',
        );
      }
    });
  }

  async listPushWatermarks(
    partition: string,
    clientCommitId: string,
  ): Promise<PushWatermark[]> {
    // The clients come from the retained commit log, which has no index on
    // `client_commit_id`; the read is bounded by retention (§4.6).
    const { rows } = await this.#exec.query<{
      client_id: string;
      outbox_id: string;
      through_seq: unknown;
    }>(
      `SELECT client_id, outbox_id, through_seq FROM sync_push_watermarks
        WHERE partition=$1 AND client_id IN (
          SELECT client_id FROM sync_commits WHERE partition=$1 AND client_commit_id=$2)
        ORDER BY client_id, outbox_id`,
      [partition, clientCommitId],
    );
    return rows.map((row) => ({
      clientId: row.client_id,
      outboxId: row.outbox_id,
      throughSeq: asNumber(row.through_seq),
    }));
  }

  async scopeActivity(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]> {
    // One statement for the page: candidate (commit, table) pairs from the
    // `sync_change_scopes_by_key` range of the key, newest first, joined to
    // the commit metadata with the table's change count. A candidate whose
    // commit was pruned has no metadata and is skipped.
    const { rows } = await this.#exec.query<{
      commit_seq: unknown;
      tbl: string;
      actor_id: string;
      created_at_ms: unknown;
      n: unknown;
    }>(
      `SELECT s.commit_seq, s.tbl, m.actor_id, m.created_at_ms,
         (SELECT count(*) FROM sync_changes ch
           WHERE ch.partition=$1 AND ch.commit_seq=s.commit_seq AND ch.tbl=s.tbl) AS n
       FROM (SELECT DISTINCT commit_seq, tbl FROM sync_change_scopes
         WHERE partition=$1 AND var=$2 AND value=$3
         ORDER BY commit_seq DESC LIMIT $4) s
       JOIN sync_commits m ON m.partition=$1 AND m.commit_seq=s.commit_seq
       ORDER BY s.commit_seq DESC`,
      [partition, query.variable, query.value, query.limit],
    );
    return rows.map((row) => ({
      commitSeq: asNumber(row.commit_seq),
      table: row.tbl,
      createdAtMs: asNumber(row.created_at_ms),
      actorId: row.actor_id,
      changeCount: asNumber(row.n),
    }));
  }

  async listPartitions(): Promise<string[]> {
    return (await this.listPartitionRegistry()).map((entry) => entry.partition);
  }
}
