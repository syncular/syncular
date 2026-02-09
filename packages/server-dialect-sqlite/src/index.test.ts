import Database from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import type { SyncCoreDb } from '@syncular/server/schema';
import type { Dialect, QueryResult } from 'kysely';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely';
import { createSqliteServerDialect } from './index';

describe('SqliteServerSyncDialect.ensureConsoleSchema', () => {
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

  it('creates sync_request_events with transport_path on new databases', async () => {
    db = createTestDb();
    const dialect = createSqliteServerDialect();

    await dialect.ensureConsoleSchema(db);

    const columns = await sql<{ name: string }>`
      PRAGMA table_info(sync_request_events)
    `.execute(db);

    expect(columns.rows.map((row) => row.name)).toContain('transport_path');
  });

  it('adds transport_path when upgrading an existing sync_request_events table', async () => {
    db = createTestDb();
    const dialect = createSqliteServerDialect();

    await db.schema
      .createTable('sync_request_events')
      .addColumn('event_id', 'integer', (col) => col.primaryKey())
      .addColumn('event_type', 'text', (col) => col.notNull())
      .addColumn('actor_id', 'text', (col) => col.notNull())
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('status_code', 'integer', (col) => col.notNull())
      .addColumn('outcome', 'text', (col) => col.notNull())
      .addColumn('duration_ms', 'integer', (col) => col.notNull())
      .addColumn('commit_seq', 'integer')
      .addColumn('operation_count', 'integer')
      .addColumn('row_count', 'integer')
      .addColumn('tables', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('error_message', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute();

    await dialect.ensureConsoleSchema(db);

    const columns = await sql<{ name: string }>`
      PRAGMA table_info(sync_request_events)
    `.execute(db);
    expect(columns.rows.map((row) => row.name)).toContain('transport_path');

    await sql`
      INSERT INTO sync_request_events (
        event_type,
        actor_id,
        client_id,
        status_code,
        outcome,
        duration_ms,
        tables,
        transport_path,
        created_at
      ) VALUES (
        ${'pull'},
        ${'actor-1'},
        ${'client-1'},
        ${200},
        ${'ok'},
        ${12},
        ${'[]'},
        ${'direct'},
        ${'2026-02-12T00:00:00.000Z'}
      )
    `.execute(db);

    const inserted = await sql<{ count: number }>`
      SELECT COUNT(*) as count
      FROM sync_request_events
      WHERE transport_path = ${'direct'}
    `.execute(db);

    expect(inserted.rows[0]?.count ?? 0).toBe(1);
  });
});
