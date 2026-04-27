import { describe, expect, it } from 'bun:test';
import { createClientHandler, type SyncClientDb } from '@syncular/client';
import {
  createDatabase,
  type SyncChange,
  type SyncSnapshot,
} from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';

interface NotesTable {
  id: string;
  title: string;
  owner_user_id: string;
  server_version: number;
}

interface ClientDb extends SyncClientDb {
  notes: NotesTable;
}

async function createNotesDb() {
  const db = createDatabase<ClientDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });

  await db.schema
    .createTable('notes')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('title', 'text', (column) => column.notNull())
    .addColumn('owner_user_id', 'text', (column) => column.notNull())
    .addColumn('server_version', 'integer', (column) => column.notNull())
    .execute();

  return db;
}

describe('createClientHandler scoped defaults', () => {
  it('materializes local scope columns from pulled snapshot and change scopes', async () => {
    const db = await createNotesDb();

    try {
      const handler = createClientHandler<ClientDb, 'notes'>({
        table: 'notes',
        scopes: [{ pattern: 'user:{user_id}', column: 'owner_user_id' }],
        materializeScopeColumns: true,
        versionColumn: 'server_version',
      });

      const snapshot: SyncSnapshot = {
        table: 'notes',
        rows: [{ id: 'n1', title: 'Snapshot note', server_version: 1 }],
        isFirstPage: true,
        isLastPage: true,
      };

      await db.transaction().execute(async (trx) => {
        await handler.applySnapshot(
          { trx, scopes: { user_id: 'u1' } },
          snapshot
        );
      });

      const change: SyncChange = {
        table: 'notes',
        row_id: 'n2',
        op: 'upsert',
        row_json: { title: 'Changed note' },
        row_version: 2,
        scopes: { user_id: 'u2' },
      };

      await db.transaction().execute(async (trx) => {
        await handler.applyChange({ trx }, change);
      });

      const rows = await db
        .selectFrom('notes')
        .select(['id', 'owner_user_id'])
        .orderBy('id')
        .execute();

      expect(rows).toEqual([
        { id: 'n1', owner_user_id: 'u1' },
        { id: 'n2', owner_user_id: 'u2' },
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('rejects ambiguous snapshot scope materialization', async () => {
    const db = await createNotesDb();

    try {
      const handler = createClientHandler<ClientDb, 'notes'>({
        table: 'notes',
        scopes: [{ pattern: 'user:{user_id}', column: 'owner_user_id' }],
        materializeScopeColumns: true,
      });

      const snapshot: SyncSnapshot = {
        table: 'notes',
        rows: [{ id: 'n1', title: 'Snapshot note', server_version: 1 }],
        isFirstPage: true,
        isLastPage: true,
      };

      await expect(
        db.transaction().execute(async (trx) => {
          await handler.applySnapshot(
            { trx, scopes: { user_id: ['u1', 'u2'] } },
            snapshot
          );
        })
      ).rejects.toThrow('has multiple values');
    } finally {
      await db.destroy();
    }
  });

  it('does not turn unmapped scoped clears into whole-table deletes', async () => {
    const db = await createNotesDb();

    try {
      await db
        .insertInto('notes')
        .values({
          id: 'n1',
          title: 'Keep me',
          owner_user_id: 'u1',
          server_version: 1,
        })
        .execute();

      const handler = createClientHandler<ClientDb, 'notes'>({
        table: 'notes',
        scopes: [],
      });

      await expect(
        db.transaction().execute(async (trx) => {
          await handler.clearAll({ trx, scopes: { user_id: 'u1' } });
        })
      ).rejects.toThrow('no local scope column mapping');

      const rows = await db.selectFrom('notes').selectAll().execute();
      expect(rows).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
});
