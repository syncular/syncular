/**
 * Schema migration tests — verifies that ensureSyncSchema correctly migrates
 * databases created with old schemas (e.g. before partition_id was added).
 *
 * This test was added after a production outage where the demo returned 500
 * on push because ON CONFLICT clauses referenced partition_id columns that
 * didn't have matching unique indexes on migrated databases.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { SyncOperation } from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandlerCollection,
  ensureSyncSchema,
  pushCommit,
  type ServerApplyOperationContext,
  type SyncCoreDb,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

interface TasksTable {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

/**
 * Create tables using the OLD schema (before partition_id was added).
 * This simulates a database that was created with an earlier version of the code.
 */
async function createOldSchema(db: Kysely<TestDb>) {
  // sync_commits — old schema: no partition_id, unique index on (client_id, client_commit_id)
  await sql`
    CREATE TABLE sync_commits (
      commit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      meta TEXT,
      result_json TEXT,
      change_count INTEGER NOT NULL DEFAULT 0,
      affected_tables TEXT NOT NULL DEFAULT '[]'
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX idx_sync_commits_client_commit
    ON sync_commits(client_id, client_commit_id)`.execute(db);

  // sync_table_commits — old schema: PK on (table, commit_seq) without partition_id
  await sql`
    CREATE TABLE sync_table_commits (
      "table" TEXT NOT NULL,
      commit_seq INTEGER NOT NULL REFERENCES sync_commits(commit_seq) ON DELETE CASCADE,
      PRIMARY KEY ("table", commit_seq)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_sync_table_commits_commit_seq
    ON sync_table_commits(commit_seq)`.execute(db);

  // sync_changes — old schema: no partition_id
  await sql`
    CREATE TABLE sync_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_seq INTEGER NOT NULL REFERENCES sync_commits(commit_seq) ON DELETE CASCADE,
      "table" TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL,
      row_json TEXT,
      row_version INTEGER,
      scopes TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_sync_changes_commit_seq ON sync_changes(commit_seq)`.execute(
    db
  );
  await sql`CREATE INDEX idx_sync_changes_table ON sync_changes("table")`.execute(
    db
  );

  // sync_client_cursors — old schema: PK on just client_id
  await sql`
    CREATE TABLE sync_client_cursors (
      client_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      effective_scopes TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `.execute(db);
  await sql`CREATE INDEX idx_sync_client_cursors_updated_at
    ON sync_client_cursors(updated_at)`.execute(db);

  // sync_snapshot_chunks — old schema: no partition_id
  await sql`
    CREATE TABLE sync_snapshot_chunks (
      chunk_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      as_of_commit_seq INTEGER NOT NULL,
      row_cursor TEXT NOT NULL DEFAULT '',
      row_limit INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      compression TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      blob_hash TEXT NOT NULL DEFAULT '',
      body BLOB,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_sync_snapshot_chunks_expires_at
    ON sync_snapshot_chunks(expires_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_sync_snapshot_chunks_page_key
    ON sync_snapshot_chunks(scope_key, scope, as_of_commit_seq, row_cursor, row_limit, encoding, compression)`.execute(
    db
  );

  // Application table
  await sql`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      server_version INTEGER NOT NULL DEFAULT 1
    )
  `.execute(db);
}

function createTasksHandler() {
  return {
    table: 'tasks' as const,
    scopePatterns: ['user:{user_id}:project:{project_id}'],

    async resolveScopes(ctx: { actorId: string }) {
      return { user_id: ctx.actorId, project_id: ['p1'] };
    },

    extractScopes(row: Record<string, unknown>) {
      return {
        user_id: String(row.user_id ?? ''),
        project_id: String(row.project_id ?? ''),
      };
    },

    async snapshot() {
      return { rows: [], nextCursor: null };
    },

    async applyOperation(
      ctx: ServerApplyOperationContext<TestDb>,
      op: SyncOperation,
      opIndex: number
    ) {
      const payload = (op.payload ?? {}) as {
        title?: string;
        completed?: number;
        project_id?: string;
      };

      await sql`
        INSERT INTO tasks (id, title, completed, user_id, project_id, server_version)
        VALUES (
          ${op.row_id},
          ${payload.title ?? ''},
          ${payload.completed ?? 0},
          ${ctx.actorId},
          ${payload.project_id ?? 'p1'},
          1
        )
        ON CONFLICT(id) DO UPDATE SET
          title = ${payload.title ?? ''},
          completed = ${payload.completed ?? 0},
          server_version = server_version + 1
      `.execute(ctx.trx);

      const updated = await sql<TasksTable>`
        SELECT * FROM tasks WHERE id = ${op.row_id} LIMIT 1
      `.execute(ctx.trx);
      const row = updated.rows[0]!;

      return {
        result: { opIndex, status: 'applied' as const },
        emittedChanges: [
          {
            table: 'tasks',
            row_id: op.row_id,
            op: 'upsert' as const,
            row_json: row,
            row_version: row.server_version,
            scopes: { user_id: ctx.actorId, project_id: row.project_id },
          },
        ],
      };
    },
  };
}

describe('schema migration (partition_id)', () => {
  let db: Kysely<TestDb>;
  const dialect = createSqliteServerDialect();

  beforeEach(async () => {
    db = createBunSqliteDb<TestDb>({ path: ':memory:' });
  });

  it('push succeeds after migrating old schema without partition_id', async () => {
    // 1. Create old-style tables (no partition_id)
    await createOldSchema(db);

    // 2. Run ensureSyncSchema — should add partition_id and create matching indexes
    await ensureSyncSchema(db, dialect);

    // 3. Push a task — this would fail with the old migration code because
    //    ON CONFLICT (partition_id, ...) had no matching unique index
    const handlers = createServerHandlerCollection<TestDb>([
      createTasksHandler(),
    ]);

    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'test-user' },
      request: {
        clientId: 'client-1',
        clientCommitId: 'commit-1',
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Migrated Task', completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
        schemaVersion: 1,
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('applied');

    // 4. Verify task was inserted
    const rows = await sql<TasksTable>`SELECT * FROM tasks`.execute(db);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.title).toBe('Migrated Task');
  });

  it('push succeeds on fresh schema (partition_id present from start)', async () => {
    // Fresh schema (normal path)
    await ensureSyncSchema(db, dialect);

    await sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        completed INTEGER NOT NULL DEFAULT 0,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        server_version INTEGER NOT NULL DEFAULT 1
      )
    `.execute(db);

    const handlers = createServerHandlerCollection<TestDb>([
      createTasksHandler(),
    ]);

    const result = await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'test-user' },
      request: {
        clientId: 'client-1',
        clientCommitId: 'commit-1',
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'Fresh Task', completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
        schemaVersion: 1,
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('applied');
  });

  it('push succeeds on D1-like config (no transactions, migrated schema)', async () => {
    const noTxDialect = createSqliteServerDialect({
      supportsTransactions: false,
    });

    // Old schema without partition_id
    await createOldSchema(db);

    // Migrate
    await ensureSyncSchema(db, noTxDialect);

    const handlers = createServerHandlerCollection<TestDb>([
      createTasksHandler(),
    ]);

    const result = await pushCommit({
      db,
      dialect: noTxDialect,
      handlers,
      auth: { actorId: 'test-user' },
      request: {
        clientId: 'client-1',
        clientCommitId: 'commit-1',
        operations: [
          {
            table: 'tasks',
            row_id: 'task-1',
            op: 'upsert',
            payload: { title: 'D1-like Task', completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
        schemaVersion: 1,
      },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe('applied');
  });
});
