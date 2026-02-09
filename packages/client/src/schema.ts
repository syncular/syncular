/**
 * @syncular/client - Sync client schema types (SQLite reference)
 *
 * These tables are sync-internal and should not collide with app tables.
 */

import type { Generated, Kysely } from 'kysely';
import type { SyncBlobClientDb } from './blobs/types';

/**
 * Database executor type that both Kysely and Transaction satisfy.
 * Use this when a function needs to work with either a raw Kysely instance
 * or within a transaction context.
 */
export type SyncClientExecutor<DB extends SyncClientDb = SyncClientDb> = Pick<
  Kysely<DB>,
  'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
>;

export type OutboxCommitStatus = 'pending' | 'sending' | 'acked' | 'failed';

export type SubscriptionStatus = 'active' | 'revoked';

export interface SyncSubscriptionStateTable {
  /** Logical profile id (default: 'default') */
  state_id: string;
  /** Subscription identifier (client-chosen) */
  subscription_id: string;
  /** Table name for this subscription */
  table: string;
  /** JSON string of ScopeValues for this subscription */
  scopes_json: string;
  /** JSON string of params */
  params_json: string;
  /** Per-subscription cursor (last applied commit_seq) */
  cursor: number;
  /**
   * JSON string of SyncBootstrapState (or null).
   * When set, indicates a paginated bootstrap is in progress for this subscription.
   */
  bootstrap_state_json: string | null;
  /** active | revoked */
  status: SubscriptionStatus;
  created_at: number;
  updated_at: number;
}

export interface SyncOutboxCommitsTable {
  /** Local row id (uuid) */
  id: string;
  /** Client-provided idempotency key (uuid) */
  client_commit_id: string;
  /** pending | sending | acked | failed */
  status: OutboxCommitStatus;
  /** JSON string of SyncOperation[] */
  operations_json: string;
  /** JSON string of the last SyncPushResponse (optional) */
  last_response_json: string | null;
  /** Last error (if any) */
  error: string | null;
  /** Created timestamp (ms since epoch) */
  created_at: number;
  /** Updated timestamp (ms since epoch) */
  updated_at: number;
  /** How many send attempts have been made */
  attempt_count: Generated<number>;
  /** Server commit_seq if acked (optional) */
  acked_commit_seq: number | null;
  /** Client schema version when commit was created (default: 1 for legacy) */
  schema_version: Generated<number>;
}

export interface SyncClientDb extends SyncBlobClientDb {
  sync_subscription_state: SyncSubscriptionStateTable;
  sync_outbox_commits: SyncOutboxCommitsTable;
  sync_conflicts: SyncConflictsTable;
}

export type ConflictResultStatus = 'conflict' | 'error';

export interface SyncConflictsTable {
  id: string;
  outbox_commit_id: string;
  client_commit_id: string;
  op_index: number;
  result_status: ConflictResultStatus;
  message: string;
  code: string | null;
  server_version: number | null;
  server_row_json: string | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}
