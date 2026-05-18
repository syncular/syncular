/**
 * @syncular/server - database schema types
 *
 * Commit-log based sync tables:
 * - sync_commits: one row per committed push
 * - sync_changes: one row per emitted change, stamped with scopes
 * - sync_table_commits: commit routing index for fast pull
 * - sync_scope_commits: scope routing index for scoped incremental pull
 */

import type { SyncOp } from '@syncular/core';
import type { Generated } from 'kysely';

/**
 * Commit log.
 */
export interface SyncCommitsTable {
  /** Monotonic commit sequence (server-assigned) */
  commit_seq: Generated<number>;
  /** Logical partition key (tenant / demo / workspace) */
  partition_id: string;
  /** Actor who produced the commit */
  actor_id: string;
  /** Client/device identifier */
  client_id: string;
  /** Client-provided commit idempotency key (unique per client) */
  client_commit_id: string;
  /** Creation timestamp */
  created_at: Generated<string>;
  /** Optional metadata */
  meta: unknown | null;
  /** Cached push response for idempotency */
  result_json: unknown | null;
  /** Number of emitted changes (denormalized for observability) */
  change_count: Generated<number>;
  /** Hex SHA-256 digest of the canonical persisted commit payload */
  commit_digest: Generated<string | null>;
  /** Hex SHA-256 root chaining this commit to the previous partition root */
  commit_chain_root: Generated<string | null>;
  /**
   * Tables affected by this commit (for realtime notifications).
   * Array of table names that had changes.
   */
  affected_tables: Generated<string[]>;
}

/**
 * Change log entries (filtered by scopes on pull).
 */
export interface SyncChangesTable {
  /** Monotonic change id */
  change_id: Generated<number>;
  /** Logical partition key (tenant / demo / workspace) */
  partition_id: string;
  /** Commit sequence this change belongs to */
  commit_seq: number;
  /** Table name being changed */
  table: string;
  /** Row primary key */
  row_id: string;
  /** Operation: 'upsert' or 'delete' */
  op: SyncOp;
  /** Row data as JSON (null for deletes) */
  row_json: unknown | null;
  /** Optional row version for optimistic concurrency */
  row_version: number | null;
  /**
   * Scope values for routing/filtering (JSONB).
   * Example: { "user_id": "U1", "project_id": "P1" }
   */
  scopes: unknown;
}

/**
 * Per-client cursor tracking (for pruning + observability).
 */
export interface SyncClientCursorsTable {
  /** Logical partition key (tenant / demo / workspace) */
  partition_id: string;
  /** Client/device identifier */
  client_id: string;
  /** Actor currently associated with the client */
  actor_id: string;
  /** Last successfully pulled commit_seq */
  cursor: number;
  /**
   * Effective scope values for the client's last pull (JSONB).
   * This is the intersection of requested scopes and allowed scopes.
   */
  effective_scopes: unknown;
  /** Last update timestamp */
  updated_at: Generated<string>;
}

/**
 * Cached bootstrap snapshot chunks (encoded, for large read-only bootstraps).
 */
export interface SyncSnapshotChunksTable {
  /** Opaque chunk id */
  chunk_id: string;
  /** Logical partition key (tenant / demo / workspace) */
  partition_id: string;
  /** Effective scope key this chunk belongs to */
  scope_key: string;
  /** Scope identifier */
  scope: string;
  /** Snapshot as-of commit sequence */
  as_of_commit_seq: number;
  /** Snapshot row cursor key (empty string represents null) */
  row_cursor: string;
  /** Snapshot row limit used to produce this chunk */
  row_limit: number;
  /** Cursor after this chunk; null means no next row for this table */
  next_row_cursor?: string | null;
  /** 1 when this chunk reaches the end of the table snapshot */
  is_last_page?: number;
  /** Row encoding (e.g. 'json-row-frame-v1') */
  encoding: string;
  /** Compression algorithm (e.g. 'gzip') */
  compression: string;
  /** Hex-encoded sha256 of content */
  sha256: string;
  /** Byte length of content */
  byte_length: number;
  /** Reference to blob storage (new field for external storage) */
  blob_hash: string;
  /** Encoded chunk bytes (deprecated: use blob storage via blob_hash) */
  body?: Uint8Array | null;
  /** Created timestamp */
  created_at: Generated<string>;
  /** Expiration timestamp (server may delete after this) */
  expires_at: string;
}

/**
 * Shared encrypted CRDT update log.
 *
 * One physical table stores updates for every encrypted CRDT field. The logical
 * stream is keyed by partition_id + stream_id, where stream_id is derived from
 * app_table + row_id + field_name.
 */
export interface SyncCrdtUpdatesTable {
  seq: Generated<number>;
  partition_id: string;
  stream_id: string;
  app_table: string;
  row_id: string;
  field_name: string;
  update_id: string;
  actor_id: string | null;
  client_id: string | null;
  key_id: string;
  ciphertext: string;
  scopes: unknown;
  created_at: Generated<string>;
}

/**
 * Shared encrypted CRDT checkpoints.
 *
 * Checkpoints contain encrypted full Yjs/Yrs state snapshots and allow old
 * update-log rows to be garbage-collected after retention rules are satisfied.
 */
export interface SyncCrdtCheckpointsTable {
  seq: Generated<number>;
  partition_id: string;
  stream_id: string;
  app_table: string;
  row_id: string;
  field_name: string;
  checkpoint_id: string;
  covers_seq: number;
  actor_id: string | null;
  client_id: string | null;
  key_id: string;
  ciphertext: string;
  scopes: unknown;
  created_at: Generated<string>;
}

/**
 * Index table: which commits affect which tables.
 *
 * Used to efficiently find commit_seq values for a table without scanning
 * the (much larger) change log.
 */
export interface SyncTableCommitsTable {
  /** Logical partition key (tenant / demo / workspace) */
  partition_id: string;
  table: string;
  commit_seq: number;
}

/**
 * Index table: which commits affect which table/scope route keys.
 *
 * Used to avoid scanning table-level commits that cannot match a scoped
 * subscription. JSON scope filtering still validates exact multi-scope matches.
 */
export interface SyncScopeCommitsTable {
  /** Logical partition key (tenant / demo / workspace) */
  partition_id: string;
  table: string;
  scope_key: string;
  commit_seq: number;
}

/**
 * Database interface for sync infrastructure tables
 * Merge this with your app's database interface
 */
export interface SyncCoreDb {
  sync_commits: SyncCommitsTable;
  sync_changes: SyncChangesTable;
  sync_client_cursors: SyncClientCursorsTable;
  sync_crdt_updates: SyncCrdtUpdatesTable;
  sync_crdt_checkpoints: SyncCrdtCheckpointsTable;
  sync_table_commits: SyncTableCommitsTable;
  sync_scope_commits: SyncScopeCommitsTable;
  sync_snapshot_chunks: SyncSnapshotChunksTable;
}

/**
 * Commit metadata row for pull responses
 */
export interface SyncCommitRow {
  commit_seq: number;
  actor_id: string;
  created_at: string;
  result_json: unknown | null;
}

/**
 * Change row for pull responses
 */
export interface SyncChangeRow {
  commit_seq: number;
  table: string;
  row_id: string;
  op: SyncOp;
  row_json: unknown | null;
  row_version: number | null;
  scopes: unknown;
}
