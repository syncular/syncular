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
import type { DbExecutor, ServerSyncDialect } from '@syncular/server';
import type {
  SyncChangeRow,
  SyncCommitRow,
  SyncCoreDb,
} from '@syncular/server/schema';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint')
    return Number.isFinite(Number(value)) ? Number(value) : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
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

function parseScopes(value: unknown): StoredScopes {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const result: StoredScopes = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        result[k] = v;
      }
    }
    return result;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const result: StoredScopes = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          if (typeof v === 'string') {
            result[k] = v;
          }
        }
        return result;
      }
    } catch {
      // ignore
    }
  }
  return {};
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
 * Check if stored scopes match the requested scope values.
 * Uses OR semantics for arrays and treats missing keys as wildcards.
 */
function scopesMatch(stored: StoredScopes, requested: ScopeValues): boolean {
  for (const [key, value] of Object.entries(requested)) {
    const storedValue = stored[key];
    if (storedValue === undefined) return false;
    if (Array.isArray(value)) {
      if (!value.includes(storedValue)) return false;
    } else {
      if (storedValue !== value) return false;
    }
  }
  return true;
}

export class SqliteServerSyncDialect implements ServerSyncDialect {
  readonly name = 'sqlite' as const;
  readonly supportsForUpdate = false;
  readonly supportsSavepoints: boolean;
  private readonly _supportsTransactions: boolean;

  constructor(options?: { supportsTransactions?: boolean }) {
    this._supportsTransactions = options?.supportsTransactions ?? true;
    this.supportsSavepoints = this._supportsTransactions;
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

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_commits_client_commit
      ON sync_commits(client_id, client_commit_id)`.execute(db);

    // sync_table_commits table (index of which commits affect which tables)
    await db.schema
      .createTable('sync_table_commits')
      .ifNotExists()
      .addColumn('table', 'text', (col) => col.notNull())
      .addColumn('commit_seq', 'integer', (col) =>
        col.notNull().references('sync_commits.commit_seq').onDelete('cascade')
      )
      .addPrimaryKeyConstraint('sync_table_commits_pk', ['table', 'commit_seq'])
      .execute();

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_table_commits_commit_seq
      ON sync_table_commits(commit_seq)`.execute(db);

    // sync_changes table - uses JSON for scopes
    await db.schema
      .createTable('sync_changes')
      .ifNotExists()
      .addColumn('change_id', 'integer', (col) =>
        col.primaryKey().autoIncrement()
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

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_changes_commit_seq
      ON sync_changes(commit_seq)`.execute(db);

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_changes_table
      ON sync_changes("table")`.execute(db);

    // sync_client_cursors table
    await db.schema
      .createTable('sync_client_cursors')
      .ifNotExists()
      .addColumn('client_id', 'text', (col) => col.primaryKey())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('cursor', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('effective_scopes', 'json', (col) =>
        col.notNull().defaultTo('{}')
      )
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .execute();

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_client_cursors_updated_at
      ON sync_client_cursors(updated_at)`.execute(db);

    // sync_snapshot_chunks table
    await db.schema
      .createTable('sync_snapshot_chunks')
      .ifNotExists()
      .addColumn('chunk_id', 'text', (col) => col.primaryKey())
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

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_snapshot_chunks_expires_at
      ON sync_snapshot_chunks(expires_at)`.execute(db);

    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_snapshot_chunks_page_key
      ON sync_snapshot_chunks(scope_key, scope, as_of_commit_seq, row_cursor, row_limit, encoding, compression)`.execute(
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
  // Commit/Change Log Queries
  // ===========================================================================

  async readMaxCommitSeq<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>
  ): Promise<number> {
    const res = await sql<{ max_seq: unknown }>`
      SELECT max(commit_seq) as max_seq
      FROM sync_commits
    `.execute(db);

    return coerceNumber(res.rows[0]?.max_seq) ?? 0;
  }

  async readMinCommitSeq<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>
  ): Promise<number> {
    const res = await sql<{ min_seq: unknown }>`
      SELECT min(commit_seq) as min_seq
      FROM sync_commits
    `.execute(db);

    return coerceNumber(res.rows[0]?.min_seq) ?? 0;
  }

  async readCommitSeqsForPull<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: { cursor: number; limitCommits: number; tables: string[] }
  ): Promise<number[]> {
    if (args.tables.length === 0) return [];

    const tablesIn = sql.join(
      args.tables.map((t) => sql`${t}`),
      sql`, `
    );

    const res = await sql<{ commit_seq: unknown }>`
      SELECT DISTINCT commit_seq
      FROM sync_table_commits
      WHERE "table" IN (${tablesIn})
        AND commit_seq > ${args.cursor}
      ORDER BY commit_seq ASC
      LIMIT ${args.limitCommits}
    `.execute(db);

    return res.rows
      .map((r) => coerceNumber(r.commit_seq))
      .filter(
        (n): n is number =>
          typeof n === 'number' && Number.isFinite(n) && n > args.cursor
      );
  }

  async readCommits<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    commitSeqs: number[]
  ): Promise<SyncCommitRow[]> {
    if (commitSeqs.length === 0) return [];

    const commitSeqsIn = sql.join(
      commitSeqs.map((seq) => sql`${seq}`),
      sql`, `
    );

    const res = await sql<{
      commit_seq: unknown;
      actor_id: string;
      created_at: unknown;
      result_json: unknown | null;
    }>`
      SELECT commit_seq, actor_id, created_at, result_json
      FROM sync_commits
      WHERE commit_seq IN (${commitSeqsIn})
      ORDER BY commit_seq ASC
    `.execute(db);

    return res.rows.map((row) => ({
      commit_seq: coerceNumber(row.commit_seq) ?? 0,
      actor_id: row.actor_id,
      created_at: coerceIsoString(row.created_at),
      result_json: row.result_json ?? null,
    }));
  }

  async readChangesForCommits<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: { commitSeqs: number[]; table: string; scopes: ScopeValues }
  ): Promise<SyncChangeRow[]> {
    if (args.commitSeqs.length === 0) return [];

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
        AND "table" = ${args.table}
      ORDER BY commit_seq ASC, change_id ASC
    `.execute(db);

    // Filter by scopes (manual, since SQLite JSON operators are limited)
    return res.rows
      .filter((row) => {
        const storedScopes = parseScopes(row.scopes);
        return scopesMatch(storedScopes, args.scopes);
      })
      .map((row) => ({
        commit_seq: coerceNumber(row.commit_seq) ?? 0,
        table: row.table,
        row_id: row.row_id,
        op: row.op as SyncOp,
        row_json: parseJsonValue(row.row_json),
        row_version: coerceNumber(row.row_version),
        scopes: parseScopes(row.scopes),
      }));
  }

  async readIncrementalPullRows<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: {
      table: string;
      scopes: ScopeValues;
      cursor: number;
      limitCommits: number;
    }
  ): Promise<
    Array<{
      commit_seq: number;
      actor_id: string;
      created_at: string;
      change_id: number;
      table: string;
      row_id: string;
      op: SyncOp;
      row_json: unknown | null;
      row_version: number | null;
      scopes: StoredScopes;
    }>
  > {
    const limitCommits = Math.max(1, Math.min(500, args.limitCommits));

    // Get commit_seqs for this table
    const commitSeqsRes = await sql<{ commit_seq: unknown }>`
      SELECT commit_seq
      FROM sync_table_commits
      WHERE "table" = ${args.table}
        AND commit_seq > ${args.cursor}
        AND EXISTS (
          SELECT 1
          FROM sync_commits cm
          WHERE cm.commit_seq = sync_table_commits.commit_seq
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
        AND c."table" = ${args.table}
      ORDER BY cm.commit_seq ASC, c.change_id ASC
    `.execute(db);

    // Filter by scopes and transform
    return changesRes.rows
      .filter((row) => {
        const storedScopes = parseScopes(row.scopes);
        return scopesMatch(storedScopes, args.scopes);
      })
      .map((row) => ({
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

  /**
   * Streaming version of incremental pull for large result sets.
   * Yields changes one at a time instead of loading all into memory.
   */
  async *streamIncrementalPullRows<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: {
      table: string;
      scopes: ScopeValues;
      cursor: number;
      limitCommits: number;
    }
  ): AsyncGenerator<{
    commit_seq: number;
    actor_id: string;
    created_at: string;
    change_id: number;
    table: string;
    row_id: string;
    op: SyncOp;
    row_json: unknown | null;
    row_version: number | null;
    scopes: StoredScopes;
  }> {
    const limitCommits = Math.max(1, Math.min(500, args.limitCommits));

    // Get commit_seqs for this table
    const commitSeqsRes = await sql<{ commit_seq: unknown }>`
      SELECT commit_seq
      FROM sync_table_commits
      WHERE "table" = ${args.table}
        AND commit_seq > ${args.cursor}
        AND EXISTS (
          SELECT 1
          FROM sync_commits cm
          WHERE cm.commit_seq = sync_table_commits.commit_seq
        )
      ORDER BY commit_seq ASC
      LIMIT ${limitCommits}
    `.execute(db);

    const commitSeqs = commitSeqsRes.rows
      .map((r) => coerceNumber(r.commit_seq))
      .filter((n): n is number => n !== null);

    if (commitSeqs.length === 0) return;

    // Process in smaller batches to avoid memory issues
    const batchSize = 100;
    for (let i = 0; i < commitSeqs.length; i += batchSize) {
      const batch = commitSeqs.slice(i, i + batchSize);
      const commitSeqsIn = sql.join(
        batch.map((seq) => sql`${seq}`),
        sql`, `
      );

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
          AND c."table" = ${args.table}
        ORDER BY cm.commit_seq ASC, c.change_id ASC
      `.execute(db);

      // Filter and yield each row
      for (const row of changesRes.rows) {
        const storedScopes = parseScopes(row.scopes);
        if (scopesMatch(storedScopes, args.scopes)) {
          yield {
            commit_seq: coerceNumber(row.commit_seq) ?? 0,
            actor_id: row.actor_id,
            created_at: coerceIsoString(row.created_at),
            change_id: coerceNumber(row.change_id) ?? 0,
            table: row.table,
            row_id: row.row_id,
            op: row.op as SyncOp,
            row_json: parseJsonValue(row.row_json),
            row_version: coerceNumber(row.row_version),
            scopes: storedScopes,
          };
        }
      }
    }
  }

  async compactChanges<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: { fullHistoryHours: number }
  ): Promise<number> {
    const cutoffIso = new Date(
      Date.now() - args.fullHistoryHours * 60 * 60 * 1000
    ).toISOString();

    // Find all old changes
    const oldChanges = await sql<{
      change_id: unknown;
      commit_seq: unknown;
      table: string;
      row_id: string;
      scopes: unknown;
    }>`
      SELECT c.change_id, c.commit_seq, c."table", c.row_id, c.scopes
      FROM sync_changes c
      JOIN sync_commits cm ON cm.commit_seq = c.commit_seq
      WHERE cm.created_at < ${cutoffIso}
    `.execute(db);

    // Group by (table, row_id, scopes)
    const groups = new Map<
      string,
      Array<{ change_id: number; commit_seq: number }>
    >();

    for (const row of oldChanges.rows) {
      const scopesStr = JSON.stringify(parseScopes(row.scopes));
      const key = `${row.table}|${row.row_id}|${scopesStr}`;
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
    const batchSize = 500;
    let deleted = 0;

    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
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
      )
        AND NOT EXISTS (
          SELECT 1
          FROM sync_changes c
          WHERE c.commit_seq = sync_table_commits.commit_seq
            AND c."table" = sync_table_commits."table"
        )
    `.execute(db);

    return deleted;
  }

  // ===========================================================================
  // Client Cursor Recording
  // ===========================================================================

  async recordClientCursor<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: {
      clientId: string;
      actorId: string;
      cursor: number;
      effectiveScopes: ScopeValues;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    const scopesJson = JSON.stringify(args.effectiveScopes);

    await sql`
      INSERT INTO sync_client_cursors (client_id, actor_id, cursor, effective_scopes, updated_at)
      VALUES (${args.clientId}, ${args.actorId}, ${args.cursor}, ${scopesJson}, ${now})
      ON CONFLICT(client_id) DO UPDATE SET
        actor_id = ${args.actorId},
        cursor = ${args.cursor},
        effective_scopes = ${scopesJson},
        updated_at = ${now}
    `.execute(db);
  }

  // ===========================================================================
  // Scope Conversion Helpers
  // ===========================================================================

  scopesToDb(scopes: StoredScopes): string {
    return JSON.stringify(scopes);
  }

  dbToScopes(value: unknown): StoredScopes {
    return parseScopes(value);
  }

  dbToArray(value: unknown): string[] {
    return toStringArray(value);
  }

  arrayToDb(values: string[]): string {
    return JSON.stringify(values.filter((v) => v.length > 0));
  }

  async readAffectedTablesFromChanges<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    commitSeq: number
  ): Promise<string[]> {
    const res = await sql<{ table: string }>`
      SELECT DISTINCT "table"
      FROM sync_changes
      WHERE commit_seq = ${commitSeq}
    `.execute(db);

    return res.rows
      .map((r) => r.table)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
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
      .addColumn('event_type', 'text', (col) => col.notNull())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('status_code', 'integer', (col) => col.notNull())
      .addColumn('outcome', 'text', (col) => col.notNull())
      .addColumn('duration_ms', 'integer', (col) => col.notNull())
      .addColumn('commit_seq', 'integer')
      .addColumn('operation_count', 'integer')
      .addColumn('row_count', 'integer')
      .addColumn('tables', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('error_message', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(nowIso))
      .execute();

    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_created_at
      ON sync_request_events(created_at DESC)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_event_type
      ON sync_request_events(event_type)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_sync_request_events_client_id
      ON sync_request_events(client_id)`.execute(db);

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
