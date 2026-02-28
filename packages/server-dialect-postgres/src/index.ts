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

export class PostgresServerSyncDialect extends BaseServerSyncDialect<'postgres'> {
  readonly family = 'postgres' as const;
  readonly supportsForUpdate = true;
  readonly supportsSavepoints = true;
  readonly supportsInsertReturning = true;

  // ===========================================================================
  // SQL Fragment Hooks
  // ===========================================================================

  protected buildNumberListFilter(values: number[]): RawBuilder<unknown> {
    return sql`= ANY(${values}::bigint[])`;
  }

  protected buildStringListFilter(values: string[]): RawBuilder<unknown> {
    return sql`= ANY(${values}::text[])`;
  }

  // ===========================================================================
  // Schema Setup
  // ===========================================================================

  async ensureSyncSchema<DB extends SyncCoreDb>(db: Kysely<DB>): Promise<void> {
    await db.schema
      .createTable('sync_commits')
      .ifNotExists()
      .addColumn('commit_seq', 'bigserial', (col) => col.primaryKey())
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
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
    await sql`ALTER TABLE sync_commits
      ADD COLUMN IF NOT EXISTS partition_id text NOT NULL DEFAULT 'default'`.execute(
      db
    );

    await sql`DROP INDEX IF EXISTS idx_sync_commits_client_commit`.execute(db);
    await db.schema
      .createIndex('idx_sync_commits_client_commit')
      .ifNotExists()
      .on('sync_commits')
      .columns(['partition_id', 'client_id', 'client_commit_id'])
      .unique()
      .execute();

    // Table-based commit routing index
    await db.schema
      .createTable('sync_table_commits')
      .ifNotExists()
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('table', 'text', (col) => col.notNull())
      .addColumn('commit_seq', 'bigint', (col) =>
        col.notNull().references('sync_commits.commit_seq').onDelete('cascade')
      )
      .addPrimaryKeyConstraint('sync_table_commits_pk', [
        'partition_id',
        'table',
        'commit_seq',
      ])
      .execute();

    await sql`ALTER TABLE sync_table_commits
      ADD COLUMN IF NOT EXISTS partition_id text NOT NULL DEFAULT 'default'`.execute(
      db
    );

    await db.schema
      .createIndex('idx_sync_table_commits_commit_seq')
      .ifNotExists()
      .on('sync_table_commits')
      .columns(['partition_id', 'commit_seq'])
      .execute();

    // Changes table with JSONB scopes
    await db.schema
      .createTable('sync_changes')
      .ifNotExists()
      .addColumn('change_id', 'bigserial', (col) => col.primaryKey())
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
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

    await sql`ALTER TABLE sync_changes
      ADD COLUMN IF NOT EXISTS partition_id text NOT NULL DEFAULT 'default'`.execute(
      db
    );

    await db.schema
      .createIndex('idx_sync_changes_commit_seq')
      .ifNotExists()
      .on('sync_changes')
      .columns(['partition_id', 'commit_seq'])
      .execute();

    await db.schema
      .createIndex('idx_sync_changes_table')
      .ifNotExists()
      .on('sync_changes')
      .columns(['partition_id', 'table'])
      .execute();

    await db.schema
      .createIndex('idx_sync_changes_table_commit_seq_change_id')
      .ifNotExists()
      .on('sync_changes')
      .columns(['partition_id', 'table', 'commit_seq', 'change_id'])
      .execute();

    await this.ensureIndex(
      db,
      'idx_sync_changes_scopes',
      'CREATE INDEX idx_sync_changes_scopes ON sync_changes USING GIN (scopes)'
    );

    await db.schema
      .createTable('sync_client_cursors')
      .ifNotExists()
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('cursor', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('effective_scopes', 'jsonb', (col) =>
        col.notNull().defaultTo(sql`'{}'::jsonb`)
      )
      .addColumn('updated_at', 'timestamptz', (col) =>
        col.notNull().defaultTo(sql`now()`)
      )
      .addPrimaryKeyConstraint('sync_client_cursors_pk', [
        'partition_id',
        'client_id',
      ])
      .execute();

    await sql`ALTER TABLE sync_client_cursors
      ADD COLUMN IF NOT EXISTS partition_id text NOT NULL DEFAULT 'default'`.execute(
      db
    );

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
      .addColumn('partition_id', 'text', (col) =>
        col.notNull().defaultTo('default')
      )
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

    await sql`ALTER TABLE sync_snapshot_chunks
      ADD COLUMN IF NOT EXISTS partition_id text NOT NULL DEFAULT 'default'`.execute(
      db
    );

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
        'partition_id',
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
    if (isActiveTransaction(db)) {
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
    return db.transaction().execute(fn);
  }

  async setRepeatableRead<DB extends SyncCoreDb>(
    trx: DbExecutor<DB>
  ): Promise<void> {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.execute(trx);
  }

  // ===========================================================================
  // Overrides (dialect-specific optimizations / casts)
  // ===========================================================================

  async readCommitSeqsForPull<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: {
      cursor: number;
      limitCommits: number;
      tables: string[];
      partitionId?: string;
    }
  ): Promise<number[]> {
    const partitionId = args.partitionId ?? 'default';
    if (args.tables.length === 0) return [];

    // Single-table fast path: skip DISTINCT since (partition_id, table, commit_seq) is PK
    if (args.tables.length === 1) {
      const res = await sql<{ commit_seq: unknown }>`
        SELECT commit_seq
        FROM sync_table_commits
        WHERE partition_id = ${partitionId}
          AND "table" = ${args.tables[0]}
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

    // Multi-table: use ANY() with DISTINCT
    return super.readCommitSeqsForPull(db, args);
  }

  async recordClientCursor<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    args: {
      partitionId?: string;
      clientId: string;
      actorId: string;
      cursor: number;
      effectiveScopes: ScopeValues;
    }
  ): Promise<void> {
    const partitionId = args.partitionId ?? 'default';
    const now = new Date().toISOString();
    const scopesJson = JSON.stringify(args.effectiveScopes);

    await sql`
      INSERT INTO sync_client_cursors (partition_id, client_id, actor_id, cursor, effective_scopes, updated_at)
      VALUES (${partitionId}, ${args.clientId}, ${args.actorId}, ${args.cursor}, ${scopesJson}::jsonb, ${now})
      ON CONFLICT(partition_id, client_id) DO UPDATE SET
        actor_id = ${args.actorId},
        cursor = ${args.cursor},
        effective_scopes = ${scopesJson}::jsonb,
        updated_at = ${now}
    `.execute(db);
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

    // Build JSONB containment conditions for scope filtering
    const scopeConditions: ReturnType<typeof sql>[] = [];
    for (const [key, value] of Object.entries(args.scopes)) {
      if (Array.isArray(value)) {
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
        AND partition_id = ${partitionId}
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
          AND partition_id = ${partitionId}
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

  protected override async readIncrementalPullRowsBatch<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: Omit<IncrementalPullRowsArgs, 'batchSize'>
  ): Promise<IncrementalPullRow[]> {
    const partitionId = args.partitionId ?? 'default';
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
        WHERE tc.partition_id = ${partitionId}
          AND tc."table" = ${args.table}
          AND cm.partition_id = ${partitionId}
          AND tc.commit_seq > ${args.cursor}
          AND EXISTS (
            SELECT 1
            FROM sync_changes c
            WHERE c.commit_seq = tc.commit_seq
              AND c.partition_id = ${partitionId}
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
      WHERE cm.partition_id = ${partitionId}
        AND c.partition_id = ${partitionId}
        AND c."table" = ${args.table}
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

  async compactChanges<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
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
            PARTITION BY c.partition_id, c."table", c.row_id, c.scopes
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
          AND cm.partition_id = tc.partition_id
          AND cm.created_at < ${cutoffIso}
        AND NOT EXISTS (
          SELECT 1
          FROM sync_changes c
          WHERE c.commit_seq = tc.commit_seq
            AND c.partition_id = tc.partition_id
            AND c."table" = tc."table"
        )
    `.execute(db);

    return deletedChanges;
  }

  // ===========================================================================
  // Scope Conversion Helpers
  // ===========================================================================

  scopesToDb(scopes: StoredScopes): StoredScopes {
    return scopes;
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

  // ===========================================================================
  // Console Schema (Request Events)
  // ===========================================================================

  async ensureConsoleSchema<DB extends SyncCoreDb>(
    db: Kysely<DB>
  ): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS sync_request_events (
        event_id BIGSERIAL PRIMARY KEY,
        partition_id TEXT NOT NULL DEFAULT 'default',
        request_id TEXT,
        trace_id TEXT,
        span_id TEXT,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        transport_path TEXT NOT NULL DEFAULT 'direct',
        sync_path TEXT NOT NULL DEFAULT 'http-combined',
        status_code INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        response_status TEXT NOT NULL DEFAULT 'unknown',
        error_code TEXT,
        duration_ms INTEGER NOT NULL,
        commit_seq BIGINT,
        operation_count INTEGER,
        row_count INTEGER,
        subscription_count INTEGER,
        scopes_summary JSONB,
        tables TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        error_message TEXT,
        payload_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS partition_id TEXT NOT NULL DEFAULT 'default'
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS request_id TEXT
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS trace_id TEXT
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS span_id TEXT
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS transport_path TEXT NOT NULL DEFAULT 'direct'
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS sync_path TEXT NOT NULL DEFAULT 'http-combined'
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT 'unknown'
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS error_code TEXT
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS subscription_count INTEGER
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS scopes_summary JSONB
    `.execute(db);
    await sql`
      ALTER TABLE sync_request_events
      ADD COLUMN IF NOT EXISTS payload_ref TEXT
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
    await this.ensureIndex(
      db,
      'idx_sync_request_events_request_id',
      'CREATE INDEX idx_sync_request_events_request_id ON sync_request_events(request_id)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_request_events_trace_id',
      'CREATE INDEX idx_sync_request_events_trace_id ON sync_request_events(trace_id)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_request_events_partition_created_at',
      'CREATE INDEX idx_sync_request_events_partition_created_at ON sync_request_events(partition_id, created_at DESC)'
    );

    await sql`
      CREATE TABLE IF NOT EXISTS sync_request_payloads (
        payload_ref TEXT PRIMARY KEY,
        partition_id TEXT NOT NULL DEFAULT 'default',
        request_payload JSONB NOT NULL,
        response_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    await this.ensureIndex(
      db,
      'idx_sync_request_payloads_created_at',
      'CREATE INDEX idx_sync_request_payloads_created_at ON sync_request_payloads(created_at DESC)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_request_payloads_partition_created_at',
      'CREATE INDEX idx_sync_request_payloads_partition_created_at ON sync_request_payloads(partition_id, created_at DESC)'
    );

    await sql`
      CREATE TABLE IF NOT EXISTS sync_operation_events (
        operation_id BIGSERIAL PRIMARY KEY,
        operation_type TEXT NOT NULL,
        console_user_id TEXT,
        partition_id TEXT,
        target_client_id TEXT,
        request_payload JSONB,
        result_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    await this.ensureIndex(
      db,
      'idx_sync_operation_events_created_at',
      'CREATE INDEX idx_sync_operation_events_created_at ON sync_operation_events(created_at DESC)'
    );
    await this.ensureIndex(
      db,
      'idx_sync_operation_events_type',
      'CREATE INDEX idx_sync_operation_events_type ON sync_operation_events(operation_type)'
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
