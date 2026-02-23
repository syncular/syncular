/**
 * @syncular/typegen - SQLite schema introspection
 *
 * Works with both better-sqlite3 (Node.js) and bun:sqlite (Bun runtime).
 */

import type { DefinedMigrations } from '@syncular/migrations';
import { Kysely, SqliteDialect } from 'kysely';
import type { TableSchema, VersionedSchema } from './types';

interface SqliteColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: 0 | 1;
}

/** Minimal interface shared by better-sqlite3 and bun:sqlite */
interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

const isBun = typeof globalThis.Bun !== 'undefined';

async function createSqliteDb(): Promise<SqliteDb> {
  if (isBun) {
    const { Database } = await import('bun:sqlite');
    return new Database(':memory:');
  }
  const { default: Database } = await import('better-sqlite3');
  return new Database(':memory:');
}

async function createKysely<DB>(sqliteDb: SqliteDb): Promise<Kysely<DB>> {
  if (isBun) {
    const { BunSqliteDialect } = await import('kysely-bun-sqlite');
    return new Kysely<DB>({
      dialect: new BunSqliteDialect({
        database: sqliteDb as never,
      }),
    });
  }

  return new Kysely<DB>({
    dialect: new SqliteDialect({
      database: sqliteDb as never,
    }),
  });
}

function introspectTable(sqliteDb: SqliteDb, tableName: string): TableSchema {
  const columns = sqliteDb
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all() as SqliteColumnInfo[];

  return {
    name: tableName,
    columns: columns.map((col) => {
      const nullable = col.notnull === 0 && col.pk === 0;
      const hasDefault = col.dflt_value !== null;
      return {
        name: col.name,
        sqlType: col.type,
        tsType: '', // resolved later by map-types
        nullable,
        isPrimaryKey: col.pk === 1,
        hasDefault,
      };
    }),
  };
}

function getAllTables(sqliteDb: SqliteDb): string[] {
  const rows = sqliteDb
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
       AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as { name: string }[];

  return rows.map((r) => r.name);
}

async function introspectAtVersion<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  targetVersion: number,
  filterTables?: string[]
): Promise<VersionedSchema> {
  const sqliteDb = await createSqliteDb();

  try {
    const db = await createKysely<DB>(sqliteDb);

    for (const migration of migrations.migrations) {
      if (migration.version > targetVersion) break;
      await migration.up(db);
    }

    let tableNames = getAllTables(sqliteDb);

    if (filterTables && filterTables.length > 0) {
      const filterSet = new Set(filterTables);
      tableNames = tableNames.filter((t) => filterSet.has(t));
    }

    const tables = tableNames.map((name) => introspectTable(sqliteDb, name));

    await db.destroy();

    return {
      version: targetVersion,
      tables,
    };
  } finally {
    sqliteDb.close();
  }
}

export async function introspectSqliteAllVersions<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  filterTables?: string[]
): Promise<VersionedSchema[]> {
  const schemas: VersionedSchema[] = [];

  for (const migration of migrations.migrations) {
    const schema = await introspectAtVersion(
      migrations,
      migration.version,
      filterTables
    );
    schemas.push(schema);
  }

  return schemas;
}

export async function introspectSqliteCurrentSchema<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  filterTables?: string[]
): Promise<VersionedSchema> {
  return introspectAtVersion(
    migrations,
    migrations.currentVersion,
    filterTables
  );
}
