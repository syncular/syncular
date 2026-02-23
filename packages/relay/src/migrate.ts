/**
 * @syncular/relay - Schema setup
 *
 * Creates relay-specific tables for edge relay functionality.
 * Uses Kysely for dialect-agnostic schema creation.
 */

import type { ServerSyncDialect } from '@syncular/server';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { RelayDatabase } from './schema';

/**
 * Ensures the relay schema exists in the database.
 * Safe to call multiple times (idempotent).
 *
 * This creates relay-specific tables on top of the base sync schema.
 * Call `ensureSyncSchema()` from @syncular/server first to create base tables.
 */
export async function ensureRelaySchema<
  DB extends RelayDatabase = RelayDatabase,
>(db: Kysely<DB>, dialect: ServerSyncDialect): Promise<void> {
  // Ensure base sync schema exists first
  await dialect.ensureSyncSchema(db);

  // Create relay-specific tables
  const isSqlite = dialect.name === 'sqlite';

  // Forward outbox table
  await sql
    .raw(`
    CREATE TABLE IF NOT EXISTS relay_forward_outbox (
      id TEXT PRIMARY KEY,
      local_commit_seq INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_commit_id TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      main_commit_seq INTEGER,
      error TEXT,
      last_response_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (${isSqlite ? "strftime('%s','now') * 1000" : 'EXTRACT(EPOCH FROM NOW()) * 1000'}),
      updated_at INTEGER NOT NULL DEFAULT (${isSqlite ? "strftime('%s','now') * 1000" : 'EXTRACT(EPOCH FROM NOW()) * 1000'}),
      attempt_count INTEGER NOT NULL DEFAULT 0
    )
  `)
    .execute(db);

  // Index for finding next sendable outbox entry
  await sql
    .raw(`
    CREATE INDEX IF NOT EXISTS idx_relay_forward_outbox_status
    ON relay_forward_outbox (status, created_at)
  `)
    .execute(db);

  // Sequence map table
  await sql
    .raw(`
    CREATE TABLE IF NOT EXISTS relay_sequence_map (
      local_commit_seq INTEGER PRIMARY KEY,
      main_commit_seq INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (${isSqlite ? "strftime('%s','now') * 1000" : 'EXTRACT(EPOCH FROM NOW()) * 1000'}),
      updated_at INTEGER NOT NULL DEFAULT (${isSqlite ? "strftime('%s','now') * 1000" : 'EXTRACT(EPOCH FROM NOW()) * 1000'})
    )
  `)
    .execute(db);

  // Index for looking up main_commit_seq
  await sql
    .raw(`
    CREATE INDEX IF NOT EXISTS idx_relay_sequence_map_main
    ON relay_sequence_map (main_commit_seq)
    WHERE main_commit_seq IS NOT NULL
  `)
    .execute(db);

  // Forward conflicts table
  await sql
    .raw(`
    CREATE TABLE IF NOT EXISTS relay_forward_conflicts (
      id TEXT PRIMARY KEY,
      local_commit_seq INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_commit_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    )
  `)
    .execute(db);

  // Index for finding unresolved conflicts
  await sql
    .raw(`
    CREATE INDEX IF NOT EXISTS idx_relay_forward_conflicts_unresolved
    ON relay_forward_conflicts (resolved_at)
    WHERE resolved_at IS NULL
  `)
    .execute(db);

  // Config table
  await sql
    .raw(`
    CREATE TABLE IF NOT EXISTS relay_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )
  `)
    .execute(db);
}
