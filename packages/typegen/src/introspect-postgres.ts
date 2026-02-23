/**
 * @syncular/typegen - PostgreSQL schema introspection via PGlite
 */

import { PGlite } from '@electric-sql/pglite';
import type { DefinedMigrations } from '@syncular/migrations';
import { Kysely } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import type { TableSchema, VersionedSchema } from './types';

interface PgColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

interface PgPrimaryKey {
  table_name: string;
  column_name: string;
}

async function introspectPg(pglite: PGlite): Promise<TableSchema[]> {
  const colResult = await pglite.query<PgColumn>(
    `SELECT table_name, column_name, data_type, udt_name,
            is_nullable, column_default, ordinal_position
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  );

  const pkResult = await pglite.query<PgPrimaryKey>(
    `SELECT kcu.column_name, tc.table_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`
  );

  const pkSet = new Set(
    pkResult.rows.map((r) => `${r.table_name}.${r.column_name}`)
  );

  const tableMap = new Map<string, TableSchema>();

  for (const col of colResult.rows) {
    let table = tableMap.get(col.table_name);
    if (!table) {
      table = { name: col.table_name, columns: [] };
      tableMap.set(col.table_name, table);
    }

    const isPrimaryKey = pkSet.has(`${col.table_name}.${col.column_name}`);
    const nullable = col.is_nullable === 'YES' && !isPrimaryKey;
    const hasDefault = col.column_default !== null;

    // Use udt_name for more precise type info (e.g. int4 instead of "integer")
    // For arrays, data_type is "ARRAY" and udt_name starts with "_"
    let sqlType: string;
    if (col.data_type === 'ARRAY' && col.udt_name.startsWith('_')) {
      // Convert _int4 → int4[], _text → text[], etc.
      sqlType = `${col.udt_name.slice(1)}[]`;
    } else if (col.data_type === 'USER-DEFINED') {
      sqlType = col.udt_name;
    } else {
      sqlType = col.udt_name;
    }

    table.columns.push({
      name: col.column_name,
      sqlType,
      tsType: '', // resolved later by map-types
      nullable,
      isPrimaryKey,
      hasDefault,
    });
  }

  // Sort tables by name for deterministic output
  return [...tableMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function introspectAtVersion<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  targetVersion: number,
  filterTables?: string[]
): Promise<VersionedSchema> {
  const pglite = await PGlite.create();

  try {
    const db = new Kysely<DB>({
      dialect: new PGliteDialect(pglite),
    });

    for (const migration of migrations.migrations) {
      if (migration.version > targetVersion) break;
      await migration.up(db);
    }

    await db.destroy();

    let tables = await introspectPg(pglite);

    if (filterTables && filterTables.length > 0) {
      const filterSet = new Set(filterTables);
      tables = tables.filter((t) => filterSet.has(t.name));
    }

    return {
      version: targetVersion,
      tables,
    };
  } finally {
    await pglite.close();
  }
}

export async function introspectPostgresAllVersions<DB = unknown>(
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

export async function introspectPostgresCurrentSchema<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  filterTables?: string[]
): Promise<VersionedSchema> {
  return introspectAtVersion(
    migrations,
    migrations.currentVersion,
    filterTables
  );
}
