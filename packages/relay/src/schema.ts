/**
 * @syncular/relay - Database schema types
 *
 * Relay-specific tables for edge relay servers.
 */

import type { SyncCoreDb } from '@syncular/server';
import type { Generated } from 'kysely';

/**
 * Forward outbox status for commits awaiting forwarding to main server.
 */
export type RelayForwardOutboxStatus =
  | 'pending'
  | 'forwarding'
  | 'forwarded'
  | 'failed';

/**
 * Sequence map status for tracking local to main commit mapping.
 */
export type RelaySequenceMapStatus = 'pending' | 'forwarded' | 'confirmed';

/**
 * Forward outbox - Queue for commits to forward to main server.
 *
 * When local clients push to the relay, commits are stored here
 * for subsequent forwarding to the main server.
 */
interface RelayForwardOutboxTable {
  /** Unique identifier for this outbox entry */
  id: string;
  /** Local commit sequence assigned by the relay */
  local_commit_seq: number;
  /** Original client_id from the local client */
  client_id: string;
  /** Original client_commit_id from the local client */
  client_commit_id: string;
  /** Operations JSON for forwarding */
  operations_json: string;
  /** Client schema version when commit was created */
  schema_version: number;
  /** Current status of this entry */
  status: RelayForwardOutboxStatus;
  /** Main server's commit_seq after forwarding (null until confirmed) */
  main_commit_seq: number | null;
  /** Error message if status is 'failed' */
  error: string | null;
  /** Last response JSON from main server */
  last_response_json: string | null;
  /** Creation timestamp */
  created_at: Generated<number>;
  /** Last update timestamp */
  updated_at: Generated<number>;
  /** Number of forward attempts */
  attempt_count: Generated<number>;
}

/**
 * Sequence map - Maps local to main commit sequences.
 *
 * Tracks the relationship between relay's local commit_seq
 * and the main server's global commit_seq.
 */
interface RelaySequenceMapTable {
  /** Relay's local commit sequence */
  local_commit_seq: number;
  /** Main server's commit sequence (null if not yet forwarded) */
  main_commit_seq: number | null;
  /** Mapping status */
  status: RelaySequenceMapStatus;
  /** When this mapping was created */
  created_at: Generated<number>;
  /** When this mapping was last updated */
  updated_at: Generated<number>;
}

/**
 * Forward conflicts - Conflicts encountered when forwarding to main.
 *
 * When a local commit is rejected by the main server due to conflicts,
 * the details are stored here for application-level handling.
 */
interface RelayForwardConflictTable {
  /** Unique identifier */
  id: string;
  /** Local commit sequence that caused the conflict */
  local_commit_seq: number;
  /** Original client_id from the local client */
  client_id: string;
  /** Original client_commit_id from the local client */
  client_commit_id: string;
  /** Full rejection response from main server */
  response_json: string;
  /** When the conflict was recorded */
  created_at: number;
  /** When the conflict was resolved (null if unresolved) */
  resolved_at: number | null;
}

/**
 * Relay config - Key-value store for relay state.
 *
 * Stores configuration and runtime state like:
 * - scope_keys: subscribed scopes
 * - main_cursor: last pulled commit_seq from main server
 * - mode: online/offline/reconnecting
 */
interface RelayConfigTable {
  /** Configuration key */
  key: string;
  /** JSON-encoded value */
  value_json: string;
}

/**
 * Database interface for relay-specific tables.
 * Merge this with SyncCoreDb for the full database interface.
 */
export interface RelayDb {
  relay_forward_outbox: RelayForwardOutboxTable;
  relay_sequence_map: RelaySequenceMapTable;
  relay_forward_conflicts: RelayForwardConflictTable;
  relay_config: RelayConfigTable;
}

/**
 * Full database interface required by the relay runtime.
 *
 * Includes:
 * - Sync core tables (commit log, cursors, etc.)
 * - Relay-specific tables (outbox, sequence map, config, conflicts)
 */
export type RelayDatabase = SyncCoreDb & RelayDb;

/**
 * Forward outbox entry (with parsed operations).
 */
export interface ForwardOutboxEntry {
  id: string;
  local_commit_seq: number;
  client_id: string;
  client_commit_id: string;
  operations: Array<{
    table: string;
    row_id: string;
    op: 'upsert' | 'delete';
    payload: Record<string, unknown> | null;
    base_version?: number | null;
  }>;
  schema_version: number;
  status: RelayForwardOutboxStatus;
  main_commit_seq: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  attempt_count: number;
}

/**
 * Forward conflict entry (with parsed response).
 */
export interface ForwardConflictEntry {
  id: string;
  local_commit_seq: number;
  client_id: string;
  client_commit_id: string;
  response: unknown;
  created_at: number;
  resolved_at: number | null;
}
