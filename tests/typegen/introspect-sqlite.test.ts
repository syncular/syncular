import { describe, expect, it } from 'bun:test';
import { defineMigrations } from '@syncular/migrations';
import {
  introspectAllVersions,
  introspectCurrentSchema,
} from '@syncular/typegen';
import { multiTableMigrations, sqliteMigrations } from './fixtures';

describe('SQLite introspection', () => {
  it('introspects basic table columns', async () => {
    const schema = await introspectCurrentSchema(sqliteMigrations, 'sqlite');
    expect(schema.version).toBe(2);
    expect(schema.tables).toHaveLength(1);

    const users = schema.tables[0]!;
    expect(users.name).toBe('users');
    expect(users.columns).toHaveLength(9); // v1 (8) + v2 (1 email)

    const idCol = users.columns.find((c) => c.name === 'id')!;
    expect(idCol.sqlType.toLowerCase()).toBe('text');
    expect(idCol.isPrimaryKey).toBe(true);
    expect(idCol.nullable).toBe(false);
    expect(idCol.hasDefault).toBe(false);

    const nameCol = users.columns.find((c) => c.name === 'name')!;
    expect(nameCol.sqlType.toLowerCase()).toBe('text');
    expect(nameCol.nullable).toBe(false);

    const ageCol = users.columns.find((c) => c.name === 'age')!;
    expect(ageCol.sqlType.toLowerCase()).toBe('integer');
    expect(ageCol.nullable).toBe(true);

    const scoreCol = users.columns.find((c) => c.name === 'score')!;
    expect(scoreCol.sqlType.toLowerCase()).toBe('real');

    const isActiveCol = users.columns.find((c) => c.name === 'is_active')!;
    expect(isActiveCol.sqlType.toLowerCase()).toBe('integer');
    expect(isActiveCol.hasDefault).toBe(true);
    expect(isActiveCol.nullable).toBe(false);

    const avatarCol = users.columns.find((c) => c.name === 'avatar')!;
    expect(avatarCol.sqlType.toLowerCase()).toBe('blob');

    const emailCol = users.columns.find((c) => c.name === 'email')!;
    expect(emailCol.sqlType.toLowerCase()).toBe('text');
    expect(emailCol.nullable).toBe(true);
  });

  it('supports migrations that read rows during introspection', async () => {
    const readDuringMigration = defineMigrations({
      v1: async (db) => {
        const migrationDb = db as unknown as {
          insertInto: (table: string) => {
            values: (row: Record<string, unknown>) => {
              execute: () => Promise<unknown>;
            };
          };
          selectFrom: (table: string) => {
            select: (column: string) => {
              where: (
                column: string,
                operator: '=' | '!=' | '<' | '>' | '<=' | '>=',
                value: unknown
              ) => {
                executeTakeFirstOrThrow: () => Promise<{ id: string }>;
              };
            };
          };
        };

        await db.schema
          .createTable('source')
          .addColumn('id', 'text', (col) => col.primaryKey())
          .execute();

        await migrationDb
          .insertInto('source')
          .values({ id: 'row-1' })
          .execute();

        const row = await migrationDb
          .selectFrom('source')
          .select('id')
          .where('id', '=', 'row-1')
          .executeTakeFirstOrThrow();

        if (row.id !== 'row-1') {
          throw new Error('expected to read seeded row');
        }

        await db.schema
          .createTable('result')
          .addColumn('id', 'text', (col) => col.primaryKey())
          .execute();
      },
    });

    const schema = await introspectCurrentSchema(readDuringMigration, 'sqlite');
    const tableNames = schema.tables.map((table) => table.name).sort();
    expect(tableNames).toEqual(['result', 'source']);
  });

  it('introspects multi-table migrations', async () => {
    const schema = await introspectCurrentSchema(
      multiTableMigrations,
      'sqlite'
    );
    expect(schema.tables).toHaveLength(2);
    const tableNames = schema.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual(['tasks', 'users']);
  });

  it('supports table filtering', async () => {
    const schema = await introspectCurrentSchema(
      multiTableMigrations,
      'sqlite',
      ['tasks']
    );
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0]!.name).toBe('tasks');
  });

  it('introspects version history', async () => {
    const schemas = await introspectAllVersions(sqliteMigrations, 'sqlite');
    expect(schemas).toHaveLength(2);

    // v1 has 8 columns
    expect(schemas[0]!.version).toBe(1);
    expect(schemas[0]!.tables[0]!.columns).toHaveLength(8);

    // v2 has 9 columns (added email)
    expect(schemas[1]!.version).toBe(2);
    expect(schemas[1]!.tables[0]!.columns).toHaveLength(9);
  });

  it('handles alter table (add column) across versions', async () => {
    const schemas = await introspectAllVersions(sqliteMigrations, 'sqlite');
    const v1Cols = schemas[0]!.tables[0]!.columns.map((c) => c.name);
    const v2Cols = schemas[1]!.tables[0]!.columns.map((c) => c.name);

    expect(v1Cols).not.toContain('email');
    expect(v2Cols).toContain('email');
  });

  it('handles empty migrations', async () => {
    const empty = defineMigrations({
      v1: async (_db) => {
        // no-op
      },
    });
    const schema = await introspectCurrentSchema(empty, 'sqlite');
    expect(schema.tables).toHaveLength(0);
  });

  it('handles version history table filtering', async () => {
    const schemas = await introspectAllVersions(
      multiTableMigrations,
      'sqlite',
      ['users']
    );
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.tables).toHaveLength(1);
    expect(schemas[0]!.tables[0]!.name).toBe('users');
  });

  it('returns empty tsType (to be resolved later)', async () => {
    const schema = await introspectCurrentSchema(sqliteMigrations, 'sqlite');
    const col = schema.tables[0]!.columns[0]!;
    expect(col.tsType).toBe('');
  });
});
