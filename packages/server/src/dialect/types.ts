/**
 * @syncular/server - Server Sync Dialect Interface
 *
 * Abstracts database-specific operations for commit-log sync.
 * Supports the new JSONB scopes model.
 */

import type {
  ScopeValues,
  SqlFamily,
  StoredScopes,
  SyncOp,
} from '@syncular/core';
import type { Kysely, Transaction } from 'kysely';
import type { SyncChangeRow, SyncCommitRow, SyncCoreDb } from '../schema';

/**
 * Common database executor type that works with both Kysely and Transaction.
 * Generic version allows for extended database types that include sync tables.
 */
export type DbExecutor<DB extends SyncCoreDb = SyncCoreDb> =
  | Kysely<DB>
  | Transaction<DB>;

export interface IncrementalPullRowsArgs {
  table: string;
  scopes: ScopeValues;
  cursor: number;
  limitCommits: number;
  partitionId?: string;
  batchSize?: number;
}

export interface IncrementalPullRow {
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
}

export type ServerSqliteDialect = ServerSyncDialect<'sqlite'>;
export type ServerPostgresDialect = ServerSyncDialect<'postgres'>;

export interface ServerSyncDialect<F extends SqlFamily = SqlFamily> {
  readonly family: F;

  /** Create sync tables + indexes (idempotent) */
  ensureSyncSchema<DB extends SyncCoreDb>(db: Kysely<DB>): Promise<void>;

  /** Create console-specific tables (e.g., sync_request_events) - optional */
  ensureConsoleSchema?<DB extends SyncCoreDb>(db: Kysely<DB>): Promise<void>;

  /** Execute callback in a transaction (or directly if transactions not supported). */
  executeInTransaction<DB extends SyncCoreDb, T>(
    db: Kysely<DB>,
    fn: (executor: DbExecutor<DB>) => Promise<T>
  ): Promise<T>;

  /** Set REPEATABLE READ (or closest equivalent) */
  setRepeatableRead<DB extends SyncCoreDb>(trx: DbExecutor<DB>): Promise<void>;

  /** Read the maximum committed commit_seq (0 if none) */
  readMaxCommitSeq<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    options?: { partitionId?: string }
  ): Promise<number>;

  /** Read the minimum committed commit_seq (0 if none) */
  readMinCommitSeq<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    options?: { partitionId?: string }
  ): Promise<number>;

  /**
   * Read the next commit sequence numbers that have changes for the given tables.
   * Must return commit_seq values in ascending order.
   */
  readCommitSeqsForPull<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: {
      cursor: number;
      limitCommits: number;
      tables: string[];
      partitionId?: string;
    }
  ): Promise<number[]>;

  /** Read commit metadata for commit_seq values */
  readCommits<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    commitSeqs: number[],
    options?: { partitionId?: string }
  ): Promise<SyncCommitRow[]>;

  /**
   * Read changes for commit_seq values, filtered by table and scopes.
   * Uses JSONB filtering for scope matching.
   */
  readChangesForCommits<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: {
      commitSeqs: number[];
      table: string;
      scopes: ScopeValues;
      partitionId?: string;
    }
  ): Promise<SyncChangeRow[]>;

  /**
   * Incremental pull iterator for a subscription.
   *
   * Yields change rows joined with commit metadata and filtered by
   * the subscription's table and scope values.
   */
  iterateIncrementalPullRows<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: IncrementalPullRowsArgs
  ): AsyncGenerator<IncrementalPullRow>;

  /**
   * Optional compaction of the change log to reduce storage.
   *
   * Keeps full history for the most recent N hours.
   * For older history, keeps only the newest change per (table, row_id, scopes).
   */
  compactChanges<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: { fullHistoryHours: number }
  ): Promise<number>;

  /**
   * Record/update a client cursor for tracking and pruning.
   */
  recordClientCursor<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: {
      partitionId?: string;
      clientId: string;
      actorId: string;
      cursor: number;
      effectiveScopes: ScopeValues;
    }
  ): Promise<void>;

  /**
   * Convert a StoredScopes object to database representation.
   * For Postgres: returns as-is (native JSONB)
   * For SQLite: returns JSON.stringify()
   */
  scopesToDb(scopes: StoredScopes): unknown;

  /**
   * Convert database scopes representation to StoredScopes.
   */
  dbToScopes(value: unknown): StoredScopes;

  /**
   * Whether the dialect supports SELECT ... FOR UPDATE row locking.
   * Postgres: true
   * SQLite: false (uses database-level locking)
   */
  readonly supportsForUpdate: boolean;

  /**
   * Whether the dialect supports SAVEPOINT / ROLLBACK TO SAVEPOINT.
   * Postgres/SQLite: true
   * D1 (Durable Object): false (blocks raw SAVEPOINT statements)
   */
  readonly supportsSavepoints: boolean;

  /**
   * Read distinct tables from sync_changes for a given commit.
   * Used for realtime notifications.
   */
  readAffectedTablesFromChanges<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    commitSeq: number,
    options?: { partitionId?: string }
  ): Promise<string[]>;

  /**
   * Convert database array representation to string[].
   * For Postgres: returns as-is (native array)
   * For SQLite: returns JSON.parse() or empty array if null
   */
  dbToArray(value: unknown): string[];

  /**
   * Convert string[] to database array representation.
   * For Postgres: returns as-is (native array)
   * For SQLite: returns JSON.stringify()
   */
  arrayToDb(values: string[]): unknown;
}
