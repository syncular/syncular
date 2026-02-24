import { describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createClientHandler, type SyncClientDb } from '@syncular/client';
import type { SyncSnapshot } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';

interface CatalogItemsTable {
  id: string;
  name: string;
  category: string;
  tag: string;
  status: number;
  version: number;
}

interface ClientDb extends SyncClientDb {
  catalog_items: CatalogItemsTable;
}

describe('createClientHandler snapshot batching', () => {
  it('applies large snapshots without exceeding SQLite variable limits', async () => {
    const db = createDatabase<ClientDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });

    try {
      await db.schema
        .createTable('catalog_items')
        .addColumn('id', 'text', (column) => column.primaryKey())
        .addColumn('name', 'text', (column) => column.notNull())
        .addColumn('category', 'text', (column) => column.notNull())
        .addColumn('tag', 'text', (column) => column.notNull())
        .addColumn('status', 'integer', (column) => column.notNull())
        .addColumn('version', 'integer', (column) => column.notNull())
        .execute();

      const handler = createClientHandler<ClientDb, 'catalog_items'>({
        table: 'catalog_items',
        scopes: [{ pattern: 'catalog:{catalog_id}', column: 'id' }],
      });

      const rowCount = 6_000;
      const rows: CatalogItemsTable[] = [];
      for (let index = 0; index < rowCount; index += 1) {
        rows.push({
          id: `item-${index}`,
          name: `Item ${index}`,
          category: `category-${index % 10}`,
          tag: `tag-${index % 7}`,
          status: index % 2,
          version: 1,
        });
      }

      const snapshot: SyncSnapshot = {
        table: 'catalog_items',
        rows,
        isFirstPage: true,
        isLastPage: true,
      };

      await db.transaction().execute(async (trx) => {
        await handler.applySnapshot({ trx }, snapshot);
      });

      const stats = await db
        .selectFrom('catalog_items')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirst();
      expect(Number(stats?.count ?? 0)).toBe(rowCount);
    } finally {
      await db.destroy();
    }
  });
});
