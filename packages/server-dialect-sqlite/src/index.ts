/**
 * @syncular/server-dialect-sqlite - SQLite Server Sync Dialect
 *
 * SQLite adaptation of the commit-log based sync system.
 * Works with any SQLite-compatible Kysely dialect (bun:sqlite, wa-sqlite, better-sqlite3, etc.).
 *
 * Key differences from Postgres:
 * - No bigserial → INTEGER PRIMARY KEY AUTOINCREMENT
 * - No JSONB → JSON stored as TEXT (with json_extract for filtering)
 * - No array && overlap → JSON object key matching
 * - No timestamptz → TEXT with ISO format
 * - No GIN index → regular index + manual filtering
 * - REPEATABLE READ → no-op (SQLite uses serializable by default)
 */

import type { ScopeValues, StoredScopes, SyncOp } from '@syncular/core';
import type { DbExecutor } from '@syncular/server';
import {
  BaseServerSyncDialect,
  coerceIsoString,
  coerceNumber,
  type IncrementalPullRow,
  type IncrementalPullRowsArgs,
  parseScopes,
} from '@syncular/server';
import type { SyncChangeRow, SyncCoreDb } from '@syncular/server/schema';
import type { Kysely, RawBuilder, Transaction } from 'kysely';
import { sql } from 'kysely';

function isActiveTransaction<DB extends SyncCoreDb>(
  db: Kysely<DB>
): db is Kysely<DB> & Transaction<DB> {
  return (db as { isTransaction?: boolean }).isTransaction === true;
}

function createSavepointName(): string {
  const randomPart = Math.floor(Math.random() * 1_000_000_000).toString(36);
  return `syncular_sp_${Date.now().toString(36)}_${randomPart}`;
}

function parseJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((k: unknown): k is string => typeof k === 'string');
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (k: unknown): k is string => typeof k === 'string'
        );
      }
    } catch {
      // ignore
    }
  }
  return [];
}

/**
 * Build a safe SQLite JSON path for a scope key.
 */
function toSqliteJsonPath(scopeKey: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(scopeKey)) {
    return `$.${scopeKey}`;
  }
  const escaped = scopeKey
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll("'", "\\'");
  return `$."${escaped}"`;
}

/**
 * Build scope filter SQL for a JSON scopes column.
 * Returns `0 = 1` when a requested array scope is empty.
 */
function buildScopeFilterSql(
  scopes: ScopeValues,
  scopeColumnSql: string
): ReturnType<typeof sql> {
  const conditions: ReturnType<typeof sql>[] = [];

  for (const [scopeKey, requested] of Object.entries(scopes)) {
    const jsonPath = toSqliteJsonPath(scopeKey);
    if (Array.isArray(requested)) {
      const values = requested.filter(
        (value): value is string => typeof value === 'string'
      );
      if (values.length === 0) {
        return sql`0 = 1`;
      }
      const valuesSql = sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
      );
      conditions.push(
        sql`json_extract(${sql.raw(scopeColumnSql)}, ${jsonPath}) IN (${valuesSql})`
      );
      continue;
    }

    conditions.push(
      sql`json_extract(${sql.raw(scopeColumnSql)}, ${jsonPath}) = ${requested}`
    );
  }

  if (conditions.length === 0) {
    return sql`1 = 1`;
  }

  return sql.join(conditions, sql` AND `);
}

async function ensurePartitionColumn<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  table: string
): Promise<void> {
  try {
    await sql
      .raw(
        `ALTER TABLE ${table} ADD COLUMN partition_id TEXT NOT NULL DEFAULT 'default'`
      )
      .execute(db);
  } catch {
    // Ignore when column already exists (or table is immutable in the current backend).
  }
}

async function ensureConsoleEventColumns<DB extends SyncCoreDb>(
  db: Kysely<DB>
): Promise<void> {
  const alterStatements = [
    "ALTER TABLE sync_request_events ADD COLUMN partition_id TEXT NOT NULL DEFAULT 'default'",
    'ALTER TABLE sync_request_events ADD COLUMN request_id TEXT',
    'ALTER TABLE sync_request_events ADD COLUMN trace_id TEXT',
    'ALTER TABLE sync_request_events ADD COLUMN span_id TEXT',
    "ALTER TABLE sync_request_events ADD COLUMN transport_path TEXT NOT NULL DEFAULT 'direct'",
    "ALTER TABLE sync_request_events ADD COLUMN sync_path TEXT NOT NULL DEFAULT 'http-combined'",
    "ALTER TABLE sync_request_events ADD COLUMN response_status TEXT NOT NULL DEFAULT 'unknown'",
    'ALTER TABLE sync_request_events ADD COLUMN error_code TEXT',
    'ALTER TABLE sync_request_events ADD COLUMN subscription_count INTEGER',
    'ALTER TABLE sync_request_events ADD COLUMN scopes_summary TEXT',
    'ALTER TABLE sync_request_events ADD COLUMN payload_ref TEXT',
  ];

  for (const statement of alterStatements) {
    try {
      await sql.raw(statement).execute(db);
    } catch {
      // Ignore when column already exists (or table is immutable in the current backend).
    }
  }
}

export class SqliteServerSyncDialect extends BaseServerSyncDialect<'sqlite'> {
  readonly family = 'sqlite' as const;
  readonly supportsForUpdate = false;
  readonly supportsSavepoints: boolean;
  readonly supportsInsertReturning = false;
  private readonly _supportsTransactions: boolean;

  constructor(options?: { supportsTransactions?: boolean }) {
    super();
    this._supportsTransactions = options?.supportsTransactions ?? true;
    this.supportsSavepoints = this._supportsTransactions;
  }

  // ===========================================================================
  // SQL Fragment Hooks
  // ===========================================================================

  protected buildNumberListFilter(values: number[]): RawBuilder<unknown> {
    const list = sql.join(
      values.map((v) => sql`${v}`),
      sql`, `
    );
    return sql`IN (${list})`;
  }

  protected buildStringListFilter(values: string[]): RawBuilder<unknown> {
    const list = sql.join(
      values.map((v) => sql`${v}`),
      sql`, `
    );
    return sql`IN (${list})`;
  }

  // ===========================================================================
  // Schema Setup
  // ===========================================================================

  async ensureSyncSchema<DB extends SyncCoreDb>(db: Kysely<DB>): Promise<void> {
    await sql`PRAGMA foreign_keys = ON`.execute(db);

    const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

    // sync_commits table
    await db.schema
      .createTable('sync_commits')
      .ifNotExists()
      .addColumn('commit_seq', 'integer', (col) =>
        col.primaryKey().autoIncrement()
      )
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('client_commit_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .addColumn('meta', 'json')
      .addColumn('result_json', 'json')
      .addColumn('change_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('affected_tables', 'text', (col) =>
        col.notNull().defaultTo('[]')
      )
      .execute();
    await ensurePartitionColumn(db, 'sync_commits');

    await sql`DROP INDEX IF EXISTS idx_sync_commits_client_commit`.execute(db);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_commits_client_commit
      ON sync_commits(partition_id, client_id, client_commit_id)`.execute(db);

    // sync_table_commits table (index of which commits affect which tables)
    await db.schema
      .createTable('sync_table_commits')
      .ifNotExists()
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('table', 'text', (col) => col.notNull())
      .addColumn('commit_seq', 'integer', (col) =>
        col.notNull().references('sync_commits.commit_seq').onDelete('cascade')
      )
      .addPrimaryKeyConstraint('sync_table_commits_pk', [
        'partition_id',
        'table',
        'commit_seq',
      ])
      .execute();
    await ensurePartitionColumn(db, 'sync_table_commits');

    // Ensure unique index matches ON CONFLICT clause in push.ts
    // (needed when migrating from old schema where PK was only (table, commit_seq))
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_table_commits_partition_pk
      ON sync_table_commits(partition_id, "table", commit_seq)`.execute(db);

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_table_commits_commit_seq
      ON sync_table_commits(partition_id, commit_seq)`.execute(db);

    // sync_changes table - uses JSON for scopes
    await db.schema
      .createTable('sync_changes')
      .ifNotExists()
      .addColumn('change_id', 'integer', (col) =>
        col.primaryKey().autoIncrement()
      )
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('commit_seq', 'integer', (col) =>
        col.notNull().references('sync_commits.commit_seq').onDelete('cascade')
      )
      .addColumn('table', 'text', (col) => col.notNull())
      .addColumn('row_id', 'text', (col) => col.notNull())
      .addColumn('op', 'text', (col) => col.notNull())
      .addColumn('row_json', 'json')
      .addColumn('row_version', 'integer')
      .addColumn('scopes', 'json', (col) => col.notNull())
      .execute();
    await ensurePartitionColumn(db, 'sync_changes');

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_changes_commit_seq
      ON sync_changes(partition_id, commit_seq)`.execute(db);

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_changes_table
      ON sync_changes(partition_id, "table")`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_changes_table_commit_seq_change_id
      ON sync_changes(partition_id, "table", commit_seq, change_id)`.execute(
      db
    );

    // sync_client_cursors table
    await db.schema
      .createTable('sync_client_cursors')
      .ifNotExists()
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('cursor', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('effective_scopes', 'json', (col) =>
        col.notNull().defaultTo('{}')
      )
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .addPrimaryKeyConstraint('sync_client_cursors_pk', [
        'partition_id',
        'client_id',
      ])
      .execute();
    await ensurePartitionColumn(db, 'sync_client_cursors');

    // Ensure unique index matches ON CONFLICT clause in recordClientCursor
    // (needed when migrating from old schema where PK was only (client_id))
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_client_cursors_partition_pk
      ON sync_client_cursors(partition_id, client_id)`.execute(db);

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_client_cursors_updated_at
      ON sync_client_cursors(updated_at)`.execute(db);

    // sync_snapshot_chunks table
    await db.schema
      .createTable('sync_snapshot_chunks')
      .ifNotExists()
      .addColumn('chunk_id', 'text', (col) => col.primaryKey())
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('scope_key', 'text', (col) => col.notNull())
      .addColumn('scope', 'text', (col) => col.notNull())
      .addColumn('as_of_commit_seq', 'integer', (col) => col.notNull())
      .addColumn('row_cursor', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('row_limit', 'integer', (col) => col.notNull())
      .addColumn('encoding', 'text', (col) => col.notNull())
      .addColumn('compression', 'text', (col) => col.notNull())
      .addColumn('sha256', 'text', (col) => col.notNull())
      .addColumn('byte_length', 'integer', (col) => col.notNull())
      .addColumn('blob_hash', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('body', 'blob') // Deprecated: use blob storage
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .addColumn('expires_at', 'text', (col) => col.notNull())
      .execute();
    await ensurePartitionColumn(db, 'sync_snapshot_chunks');

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_snapshot_chunks_expires_at
      ON sync_snapshot_chunks(expires_at)`.execute(db);

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_snapshot_chunks_page_key
      ON sync_snapshot_chunks(partition_id, scope_key, scope, as_of_commit_seq, row_cursor, row_limit, encoding, compression)`.execute(
      db
    );

    // Cleanup orphaned rows
    await sql`
      DELETE FROM sync_table_commits
      WHERE commit_seq NOT IN (SELECT commit_seq FROM sync_commits)
    `.execute(db);
    await sql`
      DELETE FROM sync_changes
      WHERE commit_seq NOT IN (SELECT commit_seq FROM sync_commits)
    `.execute(db);
  }

  // ===========================================================================
  // Transaction Control
  // ===========================================================================

  async executeInTransaction<DB extends SyncCoreDb, T>(
    db: Kysely<DB>,
    fn: (executor: DbExecutor<DB>) => Promise<T>
  ): Promise<T> {
    if (isActiveTransaction(db)) {
      if (!this._supportsTransactions) {
        return fn(db);
      }
      const savepoint = createSavepointName();
      await sql.raw(`SAVEPOINT ${savepoint}`).execute(db);
      try {
        const result = await fn(db);
        await sql.raw(`RELEASE SAVEPOINT ${savepoint}`).execute(db);
        return result;
      } catch (error) {
        await sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`).execute(db);
        await sql.raw(`RELEASE SAVEPOINT ${savepoint}`).execute(db);
        throw error;
      }
    }
    if (this._supportsTransactions) {
      return db.transaction().execute(fn);
    }
    return fn(db);
  }

  async setRepeatableRead<DB extends SyncCoreDb>(
    _trx: DbExecutor<DB>
  ): Promise<void> {
    // SQLite uses serializable isolation by default in WAL mode.
  }

  // ===========================================================================
  // Commit/Change Log Queries (dialect-specific)
  // ===========================================================================

  async readChangesForCommits<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: {
      commitSeqs: number[];
      table: string;
      scopes: ScopeValues;
      partitionId?: string;
    }
  ): Promise<SyncChangeRow[]> {
    const partitionId = args.partitionId ?? 'default';
    if (args.commitSeqs.length === 0) return [];
    const scopeFilter = buildScopeFilterSql(args.scopes, 'scopes');

    const commitSeqsIn = sql.join(
      args.commitSeqs.map((seq) => sql`${seq}`),
      sql`, `
    );

    // Fetch all changes for the table and commit sequences
    const res = await sql<{
      commit_seq: unknown;
      table: string;
      row_id: string;
      op: string;
      row_json: unknown | null;
      row_version: unknown | null;
      scopes: unknown;
    }>`
      SELECT commit_seq, "table", row_id, op, row_json, row_version, scopes
      FROM sync_changes
      WHERE commit_seq IN (${commitSeqsIn})
        AND partition_id = ${partitionId}
        AND "table" = ${args.table}
        AND (${scopeFilter})
      ORDER BY commit_seq ASC, change_id ASC
    `.execute(db);

    return res.rows.map((row) => ({
      commit_seq: coerceNumber(row.commit_seq) ?? 0,
      table: row.table,
      row_id: row.row_id,
      op: row.op as SyncOp,
      row_json: parseJsonValue(row.row_json),
      row_version: coerceNumber(row.row_version),
      scopes: parseScopes(row.scopes),
    }));
  }

  protected override async readIncrementalPullRowsBatch<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: Omit<IncrementalPullRowsArgs, 'batchSize'>
  ): Promise<IncrementalPullRow[]> {
    const partitionId = args.partitionId ?? 'default';
    const limitCommits = Math.max(1, Math.min(500, args.limitCommits));
    const scopeFilter = buildScopeFilterSql(args.scopes, 'c.scopes');

    // Get commit_seqs for this table
    const commitSeqsRes = await sql<{ commit_seq: unknown }>`
      SELECT commit_seq
      FROM sync_table_commits
      WHERE partition_id = ${partitionId}
        AND "table" = ${args.table}
        AND commit_seq > ${args.cursor}
        AND EXISTS (
          SELECT 1
          FROM sync_commits cm
          WHERE cm.commit_seq = sync_table_commits.commit_seq
            AND cm.partition_id = ${partitionId}
        )
      ORDER BY commit_seq ASC
      LIMIT ${limitCommits}
    `.execute(db);

    const commitSeqs = commitSeqsRes.rows
      .map((r) => coerceNumber(r.commit_seq))
      .filter((n): n is number => n !== null);

    if (commitSeqs.length === 0) return [];

    const commitSeqsIn = sql.join(
      commitSeqs.map((seq) => sql`${seq}`),
      sql`, `
    );

    // Get commits and changes for these commit_seqs
    const changesRes = await sql<{
      commit_seq: unknown;
      actor_id: string;
      created_at: unknown;
      change_id: unknown;
      table: string;
      row_id: string;
      op: string;
      row_json: unknown | null;
      row_version: unknown | null;
      scopes: unknown;
    }>`
      SELECT
        cm.commit_seq,
        cm.actor_id,
        cm.created_at,
        c.change_id,
        c."table",
        c.row_id,
        c.op,
        c.row_json,
        c.row_version,
        c.scopes
      FROM sync_commits cm
      JOIN sync_changes c ON c.commit_seq = cm.commit_seq
      WHERE cm.commit_seq IN (${commitSeqsIn})
        AND cm.partition_id = ${partitionId}
        AND c.partition_id = ${partitionId}
        AND c."table" = ${args.table}
        AND (${scopeFilter})
      ORDER BY cm.commit_seq ASC, c.change_id ASC
    `.execute(db);

    return changesRes.rows.map((row) => ({
      commit_seq: coerceNumber(row.commit_seq) ?? 0,
      actor_id: row.actor_id,
      created_at: coerceIsoString(row.created_at),
      change_id: coerceNumber(row.change_id) ?? 0,
      table: row.table,
      row_id: row.row_id,
      op: row.op as SyncOp,
      row_json: parseJsonValue(row.row_json),
      row_version: coerceNumber(row.row_version),
      scopes: parseScopes(row.scopes),
    }));
  }

  async compactChanges<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: { fullHistoryHours: number }
  ): Promise<number> {
    const cutoffIso = new Date(
      Date.now() - args.fullHistoryHours * 60 * 60 * 1000
    ).toISOString();

    // Find all old changes
    const oldChanges = await sql<{
      change_id: unknown;
      partition_id: string;
      commit_seq: unknown;
      table: string;
      row_id: string;
      scopes: unknown;
    }>`
      SELECT c.change_id, c.partition_id, c.commit_seq, c."table", c.row_id, c.scopes
      FROM sync_changes c
      JOIN sync_commits cm ON cm.commit_seq = c.commit_seq
      WHERE cm.created_at < ${cutoffIso}
    `.execute(db);

    // Group by (partition_id, table, row_id, scopes)
    const groups = new Map<
      string,
      Array<{ change_id: number; commit_seq: number }>
    >();

    for (const row of oldChanges.rows) {
      const scopesStr = JSON.stringify(parseScopes(row.scopes));
      const key = `${row.partition_id}|${row.table}|${row.row_id}|${scopesStr}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push({
        change_id: coerceNumber(row.change_id) ?? 0,
        commit_seq: coerceNumber(row.commit_seq) ?? 0,
      });
    }

    // Find change_ids to delete (all but the one with highest commit_seq)
    const toDelete: number[] = [];
    for (const changes of groups.values()) {
      if (changes.length <= 1) continue;

      changes.sort((a, b) => {
        if (a.commit_seq !== b.commit_seq) return b.commit_seq - a.commit_seq;
        return b.change_id - a.change_id;
      });

      for (let i = 1; i < changes.length; i++) {
        toDelete.push(changes[i]!.change_id);
      }
    }

    if (toDelete.length === 0) return 0;

    // Delete in batches
    const deleteBatchSize = 500;
    let deleted = 0;

    for (let i = 0; i < toDelete.length; i += deleteBatchSize) {
      const batch = toDelete.slice(i, i + deleteBatchSize);
      const batchIn = sql.join(
        batch.map((id) => sql`${id}`),
        sql`, `
      );

      const res = await sql`
        DELETE FROM sync_changes
        WHERE change_id IN (${batchIn})
      `.execute(db);

      deleted += Number(res.numAffectedRows ?? 0);
    }

    // Remove routing index entries that no longer have any remaining changes
    await sql`
      DELETE FROM sync_table_commits
      WHERE commit_seq IN (
        SELECT commit_seq
        FROM sync_commits
        WHERE created_at < ${cutoffIso}
          AND partition_id = sync_table_commits.partition_id
      )
        AND NOT EXISTS (
          SELECT 1
          FROM sync_changes c
          WHERE c.commit_seq = sync_table_commits.commit_seq
            AND c.partition_id = sync_table_commits.partition_id
            AND c."table" = sync_table_commits."table"
        )
    `.execute(db);

    return deleted;
  }

  // ===========================================================================
  // Scope Conversion Helpers
  // ===========================================================================

  scopesToDb(scopes: StoredScopes): string {
    return JSON.stringify(scopes);
  }

  dbToArray(value: unknown): string[] {
    return toStringArray(value);
  }

  arrayToDb(values: string[]): string {
    return JSON.stringify(values.filter((v) => v.length > 0));
  }

  // ===========================================================================
  // Console Schema (Request Events)
  // ===========================================================================

  async ensureConsoleSchema<DB extends SyncCoreDb>(
    db: Kysely<DB>
  ): Promise<void> {
    const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

    await db.schema
      .createTable('sync_request_events')
      .ifNotExists()
      .addColumn('event_id', 'integer', (col) =>
        col.primaryKey().autoIncrement()
      )
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('request_id', 'text')
      .addColumn('trace_id', 'text')
      .addColumn('span_id', 'text')
      .addColumn('event_type', 'text', (col) => col.notNull())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('transport_path', 'text', (col) =>
        col.notNull().defaultTo('direct')
      )
      .addColumn('sync_path', 'text', (col) =>
        col.notNull().defaultTo('http-combined')
      )
      .addColumn('status_code', 'integer', (col) => col.notNull())
      .addColumn('outcome', 'text', (col) => col.notNull())
      .addColumn('response_status', 'text', (col) =>
        col.notNull().defaultTo('unknown')
      )
      .addColumn('error_code', 'text')
      .addColumn('duration_ms', 'integer', (col) => col.notNull())
      .addColumn('commit_seq', 'integer')
      .addColumn('operation_count', 'integer')
      .addColumn('row_count', 'integer')
      .addColumn('subscription_count', 'integer')
      .addColumn('scopes_summary', 'text')
      .addColumn('tables', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('error_message', 'text')
      .addColumn('payload_ref', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .execute();
    await ensureConsoleEventColumns(db);

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_created_at
      ON sync_request_events(created_at DESC)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_event_type
      ON sync_request_events(event_type)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_client_id
      ON sync_request_events(client_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_request_id
      ON sync_request_events(request_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_trace_id
      ON sync_request_events(trace_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_partition_created_at
      ON sync_request_events(partition_id, created_at DESC)`.execute(db);

    await db.schema
      .createTable('sync_request_payloads')
      .ifNotExists()
      .addColumn('payload_ref', 'text', (col) => col.primaryKey())
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('request_payload', 'text', (col) => col.notNull())
      .addColumn('response_payload', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .execute();
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_payloads_created_at
      ON sync_request_payloads(created_at DESC)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_payloads_partition_created_at
      ON sync_request_payloads(partition_id, created_at DESC)`.execute(db);

    await db.schema
      .createTable('sync_operation_events')
      .ifNotExists()
      .addColumn('operation_id', 'integer', (col) =>
        col.primaryKey().autoIncrement()
      )
      .addColumn('operation_type', 'text', (col) => col.notNull())
      .addColumn('console_user_id', 'text')
      .addColumn('partition_id', 'text')
      .addColumn('target_client_id', 'text')
      .addColumn('request_payload', 'text')
      .addColumn('result_payload', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .execute();
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_operation_events_created_at
      ON sync_operation_events(created_at DESC)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_operation_events_type
      ON sync_operation_events(operation_type)`.execute(db);

    // API Keys table
    await db.schema
      .createTable('sync_api_keys')
      .ifNotExists()
      .addColumn('key_id', 'text', (col) => col.primaryKey())
      .addColumn('key_hash', 'text', (col) => col.notNull())
      .addColumn('key_prefix', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('key_type', 'text', (col) => col.notNull())
      .addColumn('scope_keys', 'text', (col) => col.defaultTo('[]'))
      .addColumn('actor_id', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .addColumn('expires_at', 'text')
      .addColumn('last_used_at', 'text')
      .addColumn('revoked_at', 'text')
      .execute();

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_api_keys_key_hash
      ON sync_api_keys(key_hash)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_api_keys_key_type
      ON sync_api_keys(key_type)`.execute(db);
  }
}

export function createSqliteServerDialect(options?: {
  supportsTransactions?: boolean;
}): SqliteServerSyncDialect {
  return new SqliteServerSyncDialect(options);
}
