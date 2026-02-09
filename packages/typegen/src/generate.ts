/**
 * @syncular/typegen - Type generation entry point
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { introspectAllVersions, introspectCurrentSchema } from './introspect';
import { resolveColumnType } from './map-types';
import { renderTypes } from './render';
import type {
  GenerateTypesOptions,
  GenerateTypesResult,
  ResolveTypeFn,
  TypegenDialect,
  VersionedSchema,
} from './types';

/**
 * Apply type mapping to all columns in the schemas.
 * Returns the schemas with tsType filled in and any custom imports collected.
 */
function applyTypeMappings(
  schemas: VersionedSchema[],
  dialect: TypegenDialect,
  resolveType?: ResolveTypeFn
): {
  schemas: VersionedSchema[];
  customImports: Array<{ name: string; from: string }>;
} {
  const allImports: Array<{ name: string; from: string }> = [];

  const mapped = schemas.map((schema) => ({
    ...schema,
    tables: schema.tables.map((table) => ({
      ...table,
      columns: table.columns.map((col) => {
        const resolved = resolveColumnType(
          {
            table: table.name,
            column: col.name,
            sqlType: col.sqlType,
            nullable: col.nullable,
            isPrimaryKey: col.isPrimaryKey,
            hasDefault: col.hasDefault,
            dialect,
          },
          resolveType
        );
        allImports.push(...resolved.imports);
        return {
          ...col,
          tsType: resolved.tsType,
        };
      }),
    })),
  }));

  return { schemas: mapped, customImports: allImports };
}

/**
 * Generate TypeScript types from migrations.
 *
 * @example
 * ```typescript
 * import { generateTypes } from '@syncular/typegen';
 * import { migrations } from './migrations';
 *
 * await generateTypes({
 *   migrations,
 *   output: './src/db.generated.ts',
 *   extendsSyncClientDb: true,
 * });
 * ```
 */
export async function generateTypes<DB>(
  options: GenerateTypesOptions<DB>
): Promise<GenerateTypesResult> {
  const {
    migrations,
    output,
    extendsSyncClientDb,
    syncularImportType,
    includeVersionHistory,
    tables,
    dialect = 'sqlite',
    resolveType,
  } = options;

  // Introspect schemas (raw SQL types, no TS mapping yet)
  let rawSchemas: VersionedSchema[];
  if (includeVersionHistory) {
    rawSchemas = await introspectAllVersions(migrations, dialect, tables);
  } else {
    const current = await introspectCurrentSchema(migrations, dialect, tables);
    rawSchemas = [current];
  }

  // Apply type mapping (default + user resolver)
  const { schemas, customImports } = applyTypeMappings(
    rawSchemas,
    dialect,
    resolveType
  );

  // Render TypeScript code
  const code = renderTypes({
    schemas,
    extendsSyncClientDb,
    syncularImportType,
    includeVersionHistory,
    customImports,
  });

  // Ensure output directory exists
  await mkdir(dirname(output), { recursive: true });

  // Write the file
  await writeFile(output, code, 'utf-8');

  const latestSchema = schemas[schemas.length - 1];

  return {
    outputPath: output,
    currentVersion: migrations.currentVersion,
    tableCount: latestSchema?.tables.length ?? 0,
    code,
  };
}
