/**
 * @syncular/typegen - TypeScript code generation
 */

import type {
  ColumnSchema,
  SyncularImportType,
  TableSchema,
  VersionedSchema,
} from './types';

/**
 * Convert a snake_case table/column name to PascalCase.
 */
function toPascalCase(str: string): string {
  return str
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Render a single column definition.
 */
function renderColumn(column: ColumnSchema): string {
  const tsType = column.hasDefault
    ? `Generated<${column.tsType}>`
    : column.tsType;
  return `  ${column.name}: ${tsType};`;
}

/**
 * Render a table interface.
 */
function renderTableInterface(
  table: TableSchema,
  interfaceName: string
): string {
  const columns = table.columns.map(renderColumn).join('\n');
  return `export interface ${interfaceName} {\n${columns}\n}`;
}

/**
 * Render a database interface containing all tables.
 */
function renderDbInterface(
  schema: VersionedSchema,
  interfaceName: string,
  extendsType?: string
): string {
  const extendsClause = extendsType ? ` extends ${extendsType}` : '';
  const tableEntries = schema.tables
    .map((t) => `  ${t.name}: ${toPascalCase(t.name)}Table;`)
    .join('\n');

  return `export interface ${interfaceName}${extendsClause} {\n${tableEntries}\n}`;
}

/**
 * Options for rendering types.
 */
export interface RenderOptions {
  /** Schemas at each version (for version history) */
  schemas: VersionedSchema[];
  /** Whether to extend SyncClientDb */
  extendsSyncClientDb?: boolean;
  /** Controls package import style for SyncClientDb (default: 'scoped') */
  syncularImportType?: SyncularImportType;
  /** Generate versioned interfaces */
  includeVersionHistory?: boolean;
  /** Custom imports collected from resolver results */
  customImports?: Array<{ name: string; from: string }>;
}

function resolveSyncClientImportPath(importType: SyncularImportType): string {
  if (importType === 'umbrella') {
    return 'syncular/client';
  }
  if (importType === 'scoped') {
    return '@syncular/client';
  }
  const clientImportPath = importType.client.trim();
  if (clientImportPath.length === 0) {
    throw new Error(
      'syncularImportType.client must be a non-empty package import path'
    );
  }
  return clientImportPath;
}

/**
 * Render complete TypeScript type definitions.
 */
export function renderTypes(options: RenderOptions): string {
  const {
    schemas,
    extendsSyncClientDb,
    syncularImportType = 'scoped',
    includeVersionHistory,
    customImports,
  } = options;
  const lines: string[] = [];

  // Header
  lines.push('/**');
  lines.push(' * Auto-generated database types from migrations.');
  lines.push(' * DO NOT EDIT - regenerate with @syncular/typegen');
  lines.push(' */');
  lines.push('');

  // Import SyncClientDb if extending
  if (extendsSyncClientDb) {
    lines.push(
      `import type { SyncClientDb } from '${resolveSyncClientImportPath(syncularImportType)}';`
    );
    lines.push('');
  }

  const usesGenerated = schemas.some((schema) =>
    schema.tables.some((table) =>
      table.columns.some((column) => column.hasDefault)
    )
  );
  if (usesGenerated) {
    lines.push("import type { Generated } from 'kysely';");
    lines.push('');
  }

  // Render custom imports from resolver
  if (customImports && customImports.length > 0) {
    // Group imports by source module
    const byModule = new Map<string, Set<string>>();
    for (const imp of customImports) {
      let names = byModule.get(imp.from);
      if (!names) {
        names = new Set();
        byModule.set(imp.from, names);
      }
      names.add(imp.name);
    }
    for (const [from, names] of byModule) {
      const sorted = [...names].sort();
      lines.push(`import type { ${sorted.join(', ')} } from '${from}';`);
    }
    lines.push('');
  }

  // Get the latest schema
  const latestSchema = schemas[schemas.length - 1];
  if (!latestSchema) {
    lines.push('// No migrations defined');
    return lines.join('\n');
  }

  // Generate table interfaces for latest version
  for (const table of latestSchema.tables) {
    lines.push(renderTableInterface(table, `${toPascalCase(table.name)}Table`));
    lines.push('');
  }

  // Generate versioned DB interfaces if requested
  if (includeVersionHistory && schemas.length > 0) {
    for (const schema of schemas) {
      // For each version, generate table interfaces with version suffix
      // if they differ from the latest
      const versionSuffix = `V${schema.version}`;

      // Generate versioned table interfaces
      for (const table of schema.tables) {
        const latestTable = latestSchema.tables.find(
          (t) => t.name === table.name
        );

        // Only generate versioned interface if different from latest
        if (latestTable && !tablesEqual(table, latestTable)) {
          lines.push(
            renderTableInterface(
              table,
              `${toPascalCase(table.name)}Table${versionSuffix}`
            )
          );
          lines.push('');
        }
      }

      // Generate versioned DB interface
      const tableEntries = schema.tables
        .map((t) => {
          const latestTable = latestSchema.tables.find(
            (lt) => lt.name === t.name
          );
          const useVersioned = latestTable && !tablesEqual(t, latestTable);
          const typeName = useVersioned
            ? `${toPascalCase(t.name)}Table${versionSuffix}`
            : `${toPascalCase(t.name)}Table`;
          return `  ${t.name}: ${typeName};`;
        })
        .join('\n');

      lines.push(`export interface ClientDb${versionSuffix} {`);
      lines.push(tableEntries);
      lines.push('}');
      lines.push('');
    }
  }

  // Generate main DB interface (latest version)
  const extendsType = extendsSyncClientDb ? 'SyncClientDb' : undefined;
  lines.push(renderDbInterface(latestSchema, 'ClientDb', extendsType));
  lines.push('');

  return lines.join('\n');
}

/**
 * Check if two table schemas are equal.
 */
function tablesEqual(a: TableSchema, b: TableSchema): boolean {
  if (a.columns.length !== b.columns.length) return false;

  for (let i = 0; i < a.columns.length; i++) {
    const colA = a.columns[i]!;
    const colB = b.columns[i]!;

    if (
      colA.name !== colB.name ||
      colA.tsType !== colB.tsType ||
      colA.nullable !== colB.nullable ||
      colA.hasDefault !== colB.hasDefault
    ) {
      return false;
    }
  }

  return true;
}
