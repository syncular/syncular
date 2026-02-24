import { describe, expect, it } from 'bun:test';
import { createClientHandler, type SyncClientDb } from '@syncular/client';
import {
  codecs,
  createDatabase,
  type SyncChange,
  type SyncSnapshot,
} from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';

interface TasksTable {
  id: string;
  user_id: string;
  enabled: number;
  metadata: string | { tags: string[] };
  server_version: number;
}

interface ClientDb extends SyncClientDb {
  tasks: TasksTable;
}

describe('createClientHandler column codecs', () => {
  it('applies codecs when writing snapshot and change rows', async () => {
    const db = createDatabase<ClientDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });

    try {
      await db.schema
        .createTable('tasks')
        .addColumn('id', 'text', (column) => column.primaryKey())
        .addColumn('user_id', 'text', (column) => column.notNull())
        .addColumn('enabled', 'integer', (column) => column.notNull())
        .addColumn('metadata', 'text', (column) => column.notNull())
        .addColumn('server_version', 'integer', (column) => column.notNull())
        .execute();

      const handler = createClientHandler<ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        versionColumn: 'server_version',
        codecs: (col) => {
          if (col.table !== 'tasks') return undefined;
          if (col.column === 'enabled') return codecs.numberBoolean();
          if (col.column === 'metadata') {
            return codecs.stringJson<{ tags: string[] }>();
          }
          return undefined;
        },
      });

      const snapshot: SyncSnapshot = {
        table: 'tasks',
        rows: [
          {
            id: 't1',
            user_id: 'u1',
            enabled: true,
            metadata: { tags: ['first'] },
            server_version: 1,
          },
        ],
        isFirstPage: true,
        isLastPage: true,
      };

      await db.transaction().execute(async (trx) => {
        await handler.applySnapshot({ trx }, snapshot);
      });

      const rowFromSnapshot = await db
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', 't1')
        .executeTakeFirstOrThrow();
      expect(rowFromSnapshot.enabled).toBe(1);
      expect(rowFromSnapshot.metadata).toBe('{"tags":["first"]}');

      const change: SyncChange = {
        table: 'tasks',
        row_id: 't2',
        op: 'upsert',
        row_json: {
          user_id: 'u1',
          enabled: false,
          metadata: { tags: ['second'] },
        },
        row_version: 2,
        scopes: { user_id: 'u1' },
      };

      await db.transaction().execute(async (trx) => {
        await handler.applyChange({ trx }, change);
      });

      const rowFromChange = await db
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', 't2')
        .executeTakeFirstOrThrow();
      expect(rowFromChange.enabled).toBe(0);
      expect(rowFromChange.metadata).toBe('{"tags":["second"]}');
      expect(rowFromChange.server_version).toBe(2);
    } finally {
      await db.destroy();
    }
  });
});
