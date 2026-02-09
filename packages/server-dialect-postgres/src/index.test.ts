import Database from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ScopeValues, StoredScopes, SyncOp } from '@syncular/core';
import type { DbExecutor } from '@syncular/server';
import type { SyncCoreDb } from '@syncular/server/schema';
import type { Dialect, QueryResult } from 'kysely';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import { PostgresServerSyncDialect } from './index';

class TestPostgresServerSyncDialect extends PostgresServerSyncDialect {
  readonly calls: Array<{ cursor: number; limitCommits: number }> = [];

  protected override async readIncrementalPullRowsBatch<DB extends SyncCoreDb>(
    _db: DbExecutor<DB>,
    args: {
      table: string;
      scopes: ScopeValues;
      cursor: number;
      limitCommits: number;
      partitionId?: string;
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
    this.calls.push({ cursor: args.cursor, limitCommits: args.limitCommits });

    const startCommit = args.cursor + 1;
    const endCommit = Math.min(args.cursor + args.limitCommits, 120);
    if (startCommit > endCommit) return [];

    const rows: Array<{
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
    }> = [];

    let changeId = 0;
    for (let commitSeq = startCommit; commitSeq <= endCommit; commitSeq += 1) {
      for (let i = 0; i < 3; i += 1) {
        changeId += 1;
        rows.push({
          commit_seq: commitSeq,
          actor_id: 'actor-1',
          created_at: '2026-01-01T00:00:00.000Z',
          change_id: changeId,
          table: args.table,
          row_id: `row-${commitSeq}-${i}`,
          op: 'upsert',
          row_json: { id: `row-${commitSeq}-${i}` },
          row_version: commitSeq,
          scopes: { actor_id: 'actor-1' },
        });
      }
    }

    return rows;
  }
}

describe('PostgresServerSyncDialect.iterateIncrementalPullRows', () => {
  let db: Kysely<SyncCoreDb>;

  function createTestDb(): Kysely<SyncCoreDb> {
    const sqlite = new Database(':memory:');
    const dialect: Dialect = {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => ({
          executeQuery: async <R>(compiledQuery: {
            sql: string;
            parameters: readonly unknown[];
          }): Promise<QueryResult<R>> => {
            const normalizedSql = compiledQuery.sql.trimStart().toLowerCase();
            if (
              normalizedSql.startsWith('select') ||
              normalizedSql.startsWith('with') ||
              normalizedSql.startsWith('pragma')
            ) {
              const rows = sqlite
                .prepare(compiledQuery.sql)
                .all(...(compiledQuery.parameters ?? [])) as R[];
              return { rows };
            }
            const result = sqlite
              .prepare(compiledQuery.sql)
              .run(...(compiledQuery.parameters ?? []));
            return {
              rows: [] as R[],
              numAffectedRows: BigInt(result.changes),
              insertId:
                result.lastInsertRowid != null
                  ? BigInt(result.lastInsertRowid)
                  : undefined,
            };
          },
          streamQuery: <R>(): AsyncIterableIterator<QueryResult<R>> => {
            throw new Error('Not implemented in test driver');
          },
        }),
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {
          sqlite.close();
        },
      }),
      createIntrospector: (innerDb) => new SqliteIntrospector(innerDb),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    };

    return new Kysely<SyncCoreDb>({ dialect });
  }

  afterEach(async () => {
    if (db) {
      await db.destroy();
    }
  });

  it('advances the batch cursor by commit sequence, not by row count', async () => {
    db = createTestDb();
    const dialect = new TestPostgresServerSyncDialect();

    const rows = [];
    for await (const row of dialect.iterateIncrementalPullRows(db, {
      table: 'tasks',
      scopes: { actor_id: 'actor-1' },
      cursor: 0,
      limitCommits: 120,
      batchSize: 100,
    })) {
      rows.push(row);
    }

    const commitSeqs = new Set(rows.map((row) => row.commit_seq));
    const maxCommitSeq = Math.max(...commitSeqs.values());

    expect(commitSeqs.size).toBe(120);
    expect(maxCommitSeq).toBe(120);
    expect(dialect.calls).toEqual([
      { cursor: 0, limitCommits: 100 },
      { cursor: 100, limitCommits: 20 },
    ]);
  });
});
