/**
 * @syncular/typegen - Schema introspection dispatcher
 */

import type { DefinedMigrations } from '@syncular/migrations';
import {
  introspectPostgresAllVersions,
  introspectPostgresCurrentSchema,
} from './introspect-postgres';
import {
  introspectSqliteAllVersions,
  introspectSqliteCurrentSchema,
} from './introspect-sqlite';
import type { TypegenDialect, VersionedSchema } from './types';

export async function introspectAllVersions<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  dialect: TypegenDialect,
  filterTables?: string[]
): Promise<VersionedSchema[]> {
  if (dialect === 'postgres') {
    return introspectPostgresAllVersions(migrations, filterTables);
  }
  return introspectSqliteAllVersions(migrations, filterTables);
}

export async function introspectCurrentSchema<DB = unknown>(
  migrations: DefinedMigrations<DB>,
  dialect: TypegenDialect,
  filterTables?: string[]
): Promise<VersionedSchema> {
  if (dialect === 'postgres') {
    return introspectPostgresCurrentSchema(migrations, filterTables);
  }
  return introspectSqliteCurrentSchema(migrations, filterTables);
}
