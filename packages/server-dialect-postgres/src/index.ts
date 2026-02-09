/**
 * @syncular/server-dialect-postgres - PostgreSQL Server Sync Dialect
 *
 * Driver-agnostic PostgreSQL dialect for sync. Works with any Postgres-compatible
 * Kysely dialect (pg, pglite, neon, etc.).
 *
 * Tables:
 * - sync_commits: commit log (idempotency + ordering)
 * - sync_table_commits: commit routing index (fast pull by table)
 * - sync_changes: change log (JSONB scopes for filtering)
 * - sync_client_cursors: per-client cursor tracking (pruning/observability)
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
  return {};
}

export class PostgresServerSyncDialect implements ServerSyncDialect {
  readonly name = 'postgres' as const;
  readonly supportsForUpdate = true;
  readonly supportsSavepoints = true;

  // ===========================================================================
  // Schema Setup
  // ===========================================================================

  async ensureSyncSchema<DB extends SyncCoreDb>(db: Kysely<DB>): Promise<void> {
    await db.schema
      .createTable('sync_commits')
      .ifNotExists()
      .addColumn('commit_seq', 'bigserial', (col) => col.primaryKey())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('client_commit_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'timestamptz', (col) =>
        col.notNull().defaultTo(sql`now()`)
      )
      .addColumn('meta', 'jsonb')
      .addColumn('result_json', 'jsonb')
      .addColumn('change_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('affected_tables', sql`text[]`, (col) =>
        col.notNull().defaultTo(sql`ARRAY[]::text[]`)
      )
      .execute();

    // Ensure new columns exist for dev environments that already created the table.
    await sql`ALTER TABLE sync_commits
      ADD COLUMN IF NOT EXISTS change_count integer NOT NULL DEFAULT 0`.execute(
      db
    );
    await sql`ALTER TABLE sync_commits
      ADD COLUMN IF NOT EXISTS affected_tables text[] NOT NULL DEFAULT ARRAY[]::text[]`.execute(
      db
    );

    await db.schema
      .createIndex('idx_sync_commits_client_commit')
      .ifNotExists()
      .on('sync_commits')
      .columns(['client_id', 'client_commit_id'])
      .unique()
      .execute();

    // Table-based commit routing index
    await db.schema
      .createTable('sync_table_commits')
      .ifNotExists()
      .addColumn('table', 'text', (col) => col.notNull())
      .addColumn('commit_seq', 'bigint', (col) =>
        col.notNull().references('sync_commits.commit_seq').onDelete('cascade')
      )
      .addPrimaryKeyConstraint('sync_table_commits_pk', ['table', 'commit_seq'])
      .execute();

    await db.schema
      .createIndex('idx_sync_table_commits_commit_seq')
      .ifNotExists()
      .on('sync_table_commits')
      .columns(['commit_seq'])
      .execute();

    // Changes table with JSONB scopes
    await db.schema
      .createTable('sync_changes')
      .ifNotExists()
      .addColumn('change_id', 'bigserial', (col) => col.primaryKey())
      .addColumn('commit_seq', 'bigint', (col) =>
        col.notNull().references('sync_commits.commit_seq').onDelete('cascade')
      )
      .addColumn('table', 'text', (col) => col.notNull())
      .addColumn('row_id', 'text', (col) => col.notNull())
      .addColumn('op', 'text', (col) => col.notNull())
      .addColumn('row_json', 'jsonb')
      .addColumn('row_version', 'bigint')
      .addColumn('scopes', 'jsonb', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_sync_changes_commit_seq')
      .ifNotExists()
      .on('sync_changes')
      .columns(['commit_seq'])
      .execute();

    await db.schema
      .createIndex('idx_sync_changes_table')
      .ifNotExists()
      .on('sync_changes')
      .columns(['table'])
      .execute();

    await this.ensureIndex(
      db,
      'idx_sync_changes_scopes',
      'CREATE INDEX idx_sync_changes_scopes ON sync_changes USING GIN (scopes)'
    );

    await db.schema
      .createTable('sync_client_cursors')
      .ifNotExists()
      .addColumn('client_id', 'text', (col) => col.primaryKey())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('cursor', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('effective_scopes', 'jsonb', (col) =>
        col.notNull().defaultTo(sql`'{}'::jsonb`)
      )
      .addColumn('updated_at', 'timestamptz', (col) =>
        col.notNull().defaultTo(sql`now()`)
      )
      .execute();

    await db.schema
      .createIndex('idx_sync_client_cursors_updated_at')
      .ifNotExists()
      .on('sync_client_cursors')
      .columns(['updated_at'])
      .execute();

    await db.schema
      .createTable('sync_snapshot_chunks')
      .ifNotExists()
      .addColumn('chunk_id', 'text', (col) => col.primaryKey())
      .addColumn('scope_key', 'text', (col) => col.notNull())
      .addColumn('scope', 'text', (col) => col.notNull())
      .addColumn('as_of_commit_seq', 'bigint', (col) => col.notNull())
      .addColumn('row_cursor', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('row_limit', 'integer', (col) => col.notNull())
      .addColumn('encoding', 'text', (col) => col.notNull())
      .addColumn('compression', 'text', (col) => col.notNull())
      .addColumn('sha256', 'text', (col) => col.notNull())
      .addColumn('byte_length', 'integer', (col) => col.notNull())
      .addColumn('blob_hash', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('body', 'bytea') // Deprecated: use blob storage
      .addColumn('created_at', 'timestamptz', (col) =>
        col.notNull().defaultTo(sql`now()`)
      )
      .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('idx_sync_snapshot_chunks_expires_at')
      .ifNotExists()
      .on('sync_snapshot_chunks')
      .columns(['expires_at'])
      .execute();

    await db.schema
      .createIndex('idx_sync_snapshot_chunks_page_key')
      .ifNotExists()
      .on('sync_snapshot_chunks')
      .columns([
        'scope_key',
        'scope',
        'as_of_commit_seq',
        'row_cursor',
        'row_limit',
        'encoding',
        'compression',
      ])
      .unique()
      .execute();
  }

  // ===========================================================================
  // Transaction Control
  // ===========================================================================

  async executeInTransaction<DB extends SyncCoreDb, T>(
    db: Kysely<DB>,
    fn: (executor: DbExecutor<DB>) => Promise<T>
  ): Promise<T> {
    return db.transaction().execute(fn);
  }

  async setRepeatableRead<DB extends SyncCoreDb>(
    trx: DbExecutor<DB>
  ): Promise<void> {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.execute(trx);
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

    if (args.tables.length === 1) {
      const res = await sql<{ commit_seq: unknown }>`
        SELECT commit_seq
        FROM sync_table_commits
        WHERE "table" = ${args.tables[0]}
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

    const res = await sql<{ commit_seq: unknown }>`
      SELECT DISTINCT commit_seq
      FROM sync_table_commits
      WHERE "table" = ANY(${args.tables}::text[])
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

    const res = await sql<{
      commit_seq: unknown;
      actor_id: string;
      created_at: unknown;
      result_json: unknown | null;
    }>`
      SELECT commit_seq, actor_id, created_at, result_json
      FROM sync_commits
      WHERE commit_seq = ANY(${commitSeqs}::bigint[])
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

    // Build JSONB containment conditions for scope filtering
    // For each scope key/value, we need: scopes->>'key' = 'value' OR scopes->>'key' IN (values)
    const scopeConditions: ReturnType<typeof sql>[] = [];
    for (const [key, value] of Object.entries(args.scopes)) {
      if (Array.isArray(value)) {
        // OR condition for array values
        scopeConditions.push(sql`scopes->>${key} = ANY(${value}::text[])`);
      } else {
        scopeConditions.push(sql`scopes->>${key} = ${value}`);
      }
    }

    let query = sql<{
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
      WHERE commit_seq = ANY(${args.commitSeqs}::bigint[])
        AND "table" = ${args.table}
    `;

    if (scopeConditions.length > 0) {
      const scopeFilter = sql.join(scopeConditions, sql` AND `);
      query = sql<{
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
        WHERE commit_seq = ANY(${args.commitSeqs}::bigint[])
          AND "table" = ${args.table}
          AND (${scopeFilter})
        ORDER BY commit_seq ASC, change_id ASC
      `;
    }

    const res = await query.execute(db);

    return res.rows.map((row) => ({
      commit_seq: coerceNumber(row.commit_seq) ?? 0,
      table: row.table,
      row_id: row.row_id,
      op: row.op as SyncOp,
      row_json: row.row_json ?? null,
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

    // Build scope filter conditions
    const scopeConditions: ReturnType<typeof sql>[] = [];
    for (const [key, value] of Object.entries(args.scopes)) {
      if (Array.isArray(value)) {
        scopeConditions.push(sql`c.scopes->>${key} = ANY(${value}::text[])`);
      } else {
        scopeConditions.push(sql`c.scopes->>${key} = ${value}`);
      }
    }

    const scopeFilter =
      scopeConditions.length > 0
        ? sql.join(scopeConditions, sql` AND `)
        : sql`TRUE`;

    const res = await sql<{
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
      WITH commit_seqs AS (
        SELECT DISTINCT tc.commit_seq
        FROM sync_table_commits tc
        JOIN sync_commits cm ON cm.commit_seq = tc.commit_seq
        WHERE tc."table" = ${args.table}
          AND tc.commit_seq > ${args.cursor}
          AND EXISTS (
            SELECT 1
            FROM sync_changes c
            WHERE c.commit_seq = tc.commit_seq
              AND c."table" = ${args.table}
              AND (${scopeFilter})
          )
        ORDER BY tc.commit_seq ASC
        LIMIT ${limitCommits}
      )
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
      FROM commit_seqs cs
      JOIN sync_commits cm ON cm.commit_seq = cs.commit_seq
      JOIN sync_changes c ON c.commit_seq = cs.commit_seq
      WHERE c."table" = ${args.table}
        AND (${scopeFilter})
      ORDER BY cm.commit_seq ASC, c.change_id ASC
    `.execute(db);

    return res.rows.map((row) => ({
      commit_seq: coerceNumber(row.commit_seq) ?? 0,
      actor_id: row.actor_id,
      created_at: coerceIsoString(row.created_at),
      change_id: coerceNumber(row.change_id) ?? 0,
      table: row.table,
      row_id: row.row_id,
      op: row.op as SyncOp,
      row_json: row.row_json ?? null,
      row_version: coerceNumber(row.row_version),
      scopes: parseScopes(row.scopes),
    }));
  }

  async *streamIncrementalPullRows<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: {
      table: string;
      scopes: ScopeValues;
      cursor: number;
      limitCommits: number;
      batchSize?: number;
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
    // PostgreSQL: use batching approach (could use pg-query-stream for true streaming)
    const batchSize = Math.min(100, args.batchSize ?? 100);
    let processed = 0;

    while (processed < args.limitCommits) {
      const batch = await this.readIncrementalPullRows(db, {
        ...args,
        limitCommits: Math.min(batchSize, args.limitCommits - processed),
        cursor: args.cursor + processed,
      });

      if (batch.length === 0) break;

      for (const row of batch) {
        yield row;
      }

      processed += batch.length;
      if (batch.length < batchSize) break;
    }
  }

  async compactChanges<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: { fullHistoryHours: number }
  ): Promise<number> {
    const cutoffIso = new Date(
      Date.now() - args.fullHistoryHours * 60 * 60 * 1000
    ).toISOString();

    const res = await sql`
      WITH ranked AS (
        SELECT
          c.change_id,
          row_number() OVER (
            PARTITION BY c."table", c.row_id, c.scopes
            ORDER BY c.commit_seq DESC, c.change_id DESC
          ) AS rn
        FROM sync_changes c
        JOIN sync_commits cm ON cm.commit_seq = c.commit_seq
        WHERE cm.created_at < ${cutoffIso}
      )
      DELETE FROM sync_changes
      WHERE change_id IN (SELECT change_id FROM ranked WHERE rn > 1)
    `.execute(db);

    const deletedChanges = Number(res.numAffectedRows ?? 0);

    // Remove routing index entries that no longer have any remaining changes
    await sql`
      DELETE FROM sync_table_commits tc
      USING sync_commits cm
      WHERE cm.commit_seq = tc.commit_seq
        AND cm.created_at < ${cutoffIso}
        AND NOT EXISTS (
          SELECT 1
          FROM sync_changes c
          WHERE c.commit_seq = tc.commit_seq
            AND c."table" = tc."table"
        )
    `.execute(db);

    return deletedChanges;
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
      VALUES (${args.clientId}, ${args.actorId}, ${args.cursor}, ${scopesJson}::jsonb, ${now})
      ON CONFLICT(client_id) DO UPDATE SET
        actor_id = ${args.actorId},
        cursor = ${args.cursor},
        effective_scopes = ${scopesJson}::jsonb,
        updated_at = ${now}
    `.execute(db);
  }

  // ===========================================================================
  // Scope Conversion Helpers
  // ===========================================================================

  scopesToDb(scopes: StoredScopes): StoredScopes {
    return scopes;
  }

  dbToScopes(value: unknown): StoredScopes {
    return parseScopes(value);
  }

  dbToArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((k: unknown): k is string => typeof k === 'string');
    }
    return [];
  }

  arrayToDb(values: string[]): string[] {
    return values.filter((v) => v.length > 0);
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
    await sql`
      CREATE TABLE IF NOT EXISTS sync_request_events (
        event_id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        transport_path TEXT NOT NULL DEFAULT 'direct',
        status_code INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        commit_seq BIGINT,
        operation_count INTEGER,
        row_count INTEGER,
        tables TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS transport_path TEXT NOT NULL DEFAULT 'direct'
    `.execute(db);

    await this.ensureIndex(
      db,
      'idx_sync_request_events_created_at',
      'CREATE INDEX idx_sync_request_events_created_at ON sync_request_events(created_at DESC)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_request_events_event_type',
      'CREATE INDEX idx_sync_request_events_event_type ON sync_request_events(event_type)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_request_events_client_id',
      'CREATE INDEX idx_sync_request_events_client_id ON sync_request_events(client_id)'
    );

    // API Keys table
    await sql`
      CREATE TABLE IF NOT EXISTS sync_api_keys (
        key_id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        key_type TEXT NOT NULL,
        scope_keys TEXT[] DEFAULT ARRAY[]::TEXT[],
        actor_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )
    `.execute(db);

    await this.ensureIndex(
      db,
      'idx_sync_api_keys_key_hash',
      'CREATE INDEX idx_sync_api_keys_key_hash ON sync_api_keys(key_hash)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_api_keys_key_type',
      'CREATE INDEX idx_sync_api_keys_key_type ON sync_api_keys(key_type)'
    );
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private async ensureIndex<DB extends SyncCoreDb>(
    db: Kysely<DB>,
    indexName: string,
    createSql: string
  ): Promise<void> {
    const exists = await sql<{ ok: 1 }>`
      SELECT 1 as ok
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ${indexName}
      LIMIT 1
    `.execute(db);

    if (exists.rows.length > 0) return;
    await sql.raw(createSql).execute(db);
  }
}

export function createPostgresServerDialect(): PostgresServerSyncDialect {
  return new PostgresServerSyncDialect();
}
