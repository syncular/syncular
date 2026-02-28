/**
 * @syncular/server - Base Server Sync Dialect
 *
 * Abstract base class that implements shared query methods for all
 * database-specific sync dialect implementations.
 */

import type { ScopeValues, SqlFamily, StoredScopes } from '@syncular/core';
import type { Kysely, RawBuilder, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { SyncChangeRow, SyncCommitRow, SyncCoreDb } from '../schema';
import { coerceIsoString, coerceNumber, parseScopes } from './helpers';
import type {
  DbExecutor,
  IncrementalPullRow,
  IncrementalPullRowsArgs,
  ServerSyncDialect,
} from './types';

/**
 * Abstract base class for server sync dialects.
 *
 * Implements methods that are identical across dialects (pure SQL with no
 * dialect-specific syntax) and methods that differ only in trivial SQL
 * fragments (IN vs ANY, jsonb casts). Dialect-specific fragments are
 * provided via small abstract hook methods.
 *
 * Genuinely different methods (DDL, transaction control, scope filtering,
 * compaction) remain abstract for each dialect to implement.
 */
export abstract class BaseServerSyncDialect<F extends SqlFamily = SqlFamily>
  implements ServerSyncDialect<F>
{
  abstract readonly family: F;
  abstract readonly supportsForUpdate: boolean;
  abstract readonly supportsSavepoints: boolean;
  abstract readonly supportsInsertReturning: boolean;

  // ===========================================================================
  // Abstract SQL fragment hooks
  // ===========================================================================

  /**
   * Build a SQL fragment for "column IN/= list of numbers".
   * SQLite: `IN (1, 2, 3)` via sql.join
   * Postgres: `= ANY(ARRAY[1,2,3]::bigint[])`
   */
  protected abstract buildNumberListFilter(
    values: number[]
  ): RawBuilder<unknown>;

  /**
   * Build a SQL fragment for "column IN/= list of strings".
   * SQLite: `IN ('a', 'b')` via sql.join
   * Postgres: `= ANY(ARRAY['a','b']::text[])`
   */
  protected abstract buildStringListFilter(
    values: string[]
  ): RawBuilder<unknown>;

  // ===========================================================================
  // Abstract methods (genuinely different implementations)
  // ===========================================================================

  abstract ensureSyncSchema<DB extends SyncCoreDb>(
    db: Kysely<DB>
  ): Promise<void>;

  abstract ensureConsoleSchema?<DB extends SyncCoreDb>(
    db: Kysely<DB>
  ): Promise<void>;

  abstract executeInTransaction<DB extends SyncCoreDb, T>(
    db: Kysely<DB>,
    fn: (executor: DbExecutor<DB>) => Promise<T>
  ): Promise<T>;

  abstract setRepeatableRead<DB extends SyncCoreDb>(
    trx: DbExecutor<DB>
  ): Promise<void>;

  abstract readChangesForCommits<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: {
      commitSeqs: number[];
      table: string;
      scopes: ScopeValues;
      partitionId?: string;
    }
  ): Promise<SyncChangeRow[]>;

  protected abstract readIncrementalPullRowsBatch<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: Omit<IncrementalPullRowsArgs, 'batchSize'>
  ): Promise<IncrementalPullRow[]>;

  abstract compactChanges<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: { fullHistoryHours: number }
  ): Promise<number>;

  abstract scopesToDb(scopes: StoredScopes): unknown;
  abstract dbToArray(value: unknown): string[];
  abstract arrayToDb(values: string[]): unknown;

  // ===========================================================================
  // Concrete methods (identical SQL across dialects)
  // ===========================================================================

  async readMaxCommitSeq<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    options?: { partitionId?: string }
  ): Promise<number> {
    const partitionId = options?.partitionId ?? 'default';
    const res = await sql<{ max_seq: unknown }>`
      SELECT max(commit_seq) as max_seq
      FROM sync_commits
      WHERE partition_id = ${partitionId}
    `.execute(db);

    return coerceNumber(res.rows[0]?.max_seq) ?? 0;
  }

  async readMinCommitSeq<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    options?: { partitionId?: string }
  ): Promise<number> {
    const partitionId = options?.partitionId ?? 'default';
    const res = await sql<{ min_seq: unknown }>`
      SELECT min(commit_seq) as min_seq
      FROM sync_commits
      WHERE partition_id = ${partitionId}
    `.execute(db);

    return coerceNumber(res.rows[0]?.min_seq) ?? 0;
  }

  async readAffectedTablesFromChanges<DB extends SyncCoreDb>(
    db: Kysely<DB> | Transaction<DB>,
    commitSeq: number,
    options?: { partitionId?: string }
  ): Promise<string[]> {
    const partitionId = options?.partitionId ?? 'default';
    const res = await sql<{ table: string }>`
      SELECT DISTINCT "table"
      FROM sync_changes
      WHERE commit_seq = ${commitSeq}
        AND partition_id = ${partitionId}
    `.execute(db);

    return res.rows
      .map((r) => r.table)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  }

  dbToScopes(value: unknown): StoredScopes {
    return parseScopes(value);
  }

  // ===========================================================================
  // Concrete methods using hooks (trivial dialect diffs)
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

    const tablesFilter = this.buildStringListFilter(args.tables);

    const res = await sql<{ commit_seq: unknown }>`
      SELECT DISTINCT commit_seq
      FROM sync_table_commits
      WHERE partition_id = ${partitionId}
        AND "table" ${tablesFilter}
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
    commitSeqs: number[],
    options?: { partitionId?: string }
  ): Promise<SyncCommitRow[]> {
    const partitionId = options?.partitionId ?? 'default';
    if (commitSeqs.length === 0) return [];

    const seqsFilter = this.buildNumberListFilter(commitSeqs);

    const res = await sql<{
      commit_seq: unknown;
      actor_id: string;
      created_at: unknown;
      result_json: unknown | null;
    }>`
      SELECT commit_seq, actor_id, created_at, result_json
      FROM sync_commits
      WHERE commit_seq ${seqsFilter}
        AND partition_id = ${partitionId}
      ORDER BY commit_seq ASC
    `.execute(db);

    return res.rows.map((row) => ({
      commit_seq: coerceNumber(row.commit_seq) ?? 0,
      actor_id: row.actor_id,
      created_at: coerceIsoString(row.created_at),
      result_json: row.result_json ?? null,
    }));
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
      VALUES (${partitionId}, ${args.clientId}, ${args.actorId}, ${args.cursor}, ${scopesJson}, ${now})
      ON CONFLICT(partition_id, client_id) DO UPDATE SET
        actor_id = ${args.actorId},
        cursor = ${args.cursor},
        effective_scopes = ${scopesJson},
        updated_at = ${now}
    `.execute(db);
  }

  async *iterateIncrementalPullRows<DB extends SyncCoreDb>(
    db: DbExecutor<DB>,
    args: IncrementalPullRowsArgs
  ): AsyncGenerator<IncrementalPullRow> {
    const limitCommits = Math.max(1, Math.min(500, args.limitCommits));
    const batchSize = Math.max(
      1,
      Math.min(limitCommits, args.batchSize ?? 100, 500)
    );

    let processedCommits = 0;
    let cursor = args.cursor;

    while (processedCommits < limitCommits) {
      const remainingCommits = limitCommits - processedCommits;
      const commitLimit = Math.min(batchSize, remainingCommits);
      const rows = await this.readIncrementalPullRowsBatch(db, {
        table: args.table,
        scopes: args.scopes,
        cursor,
        limitCommits: commitLimit,
        partitionId: args.partitionId,
      });

      if (rows.length === 0) break;

      let maxCommitSeq = cursor;
      const commitSeqs = new Set<number>();

      for (const row of rows) {
        maxCommitSeq = Math.max(maxCommitSeq, row.commit_seq);
        commitSeqs.add(row.commit_seq);
        yield row;
      }

      if (maxCommitSeq <= cursor) break;

      processedCommits += commitSeqs.size;
      cursor = maxCommitSeq;

      if (commitSeqs.size < commitLimit) break;
    }
  }
}
