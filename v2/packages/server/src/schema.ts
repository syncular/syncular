/**
 * Server schema IR (SPEC.md §2.4, §3.1).
 *
 * The server is configured with a schema IR: tables, columns with the six
 * §2.4 column types, scope patterns per §3.1, and a schema version. Codegen
 * (B5) will emit this shape later; tests hand-write it.
 */
import type { RowColumn } from '@syncular-v2/core';

/** `'prefix:{variable}'` shorthand (column name = variable) or explicit. */
export type ScopePatternSpec = string | { pattern: string; column: string };

export interface TableSchema {
  readonly name: string;
  /** Columns in schema-IR declaration order (the row-codec order, §2.4). */
  readonly columns: readonly RowColumn[];
  /** Primary-key column; its value renders as the change `rowId` (§2.2). */
  readonly primaryKey: string;
  /** Scope patterns (§3.1). Every synced table declares at least one. */
  readonly scopes: readonly ScopePatternSpec[];
}

export interface ServerSchema {
  /** The generated schema version this server serves (§2.4, §9). */
  readonly version: number;
  /** Tables in handler-declared bootstrap order (§4.7). */
  readonly tables: readonly TableSchema[];
}

export interface CompiledScopePattern {
  readonly variable: string;
  /** Literal prefix; the scope key is `prefix + ':' + value` (§3.1). */
  readonly prefix: string;
  readonly column: string;
  readonly columnIndex: number;
}

export interface CompiledTable {
  readonly name: string;
  readonly columns: readonly RowColumn[];
  readonly primaryKeyIndex: number;
  readonly scopePatterns: readonly CompiledScopePattern[];
  readonly columnIndex: ReadonlyMap<string, number>;
  readonly declaredVariables: ReadonlySet<string>;
  /** Column indices declared `blob_ref` (§2.4 tag 7, §5.9) — the columns
   * whose non-NULL values reference blobs (existence check, reference
   * index). */
  readonly blobRefColumnIndices: readonly number[];
}

export interface CompiledSchema {
  readonly version: number;
  readonly tables: ReadonlyMap<string, CompiledTable>;
  /** Union of scope variables declared by any table (§3.2 resolver check). */
  readonly declaredVariables: ReadonlySet<string>;
}

const PATTERN_RE = /^([^{}]+):\{([^{}:]+)\}$/;

function compilePattern(
  table: TableSchema,
  spec: ScopePatternSpec,
  columnIndex: ReadonlyMap<string, number>,
): CompiledScopePattern {
  const pattern = typeof spec === 'string' ? spec : spec.pattern;
  const match = PATTERN_RE.exec(pattern);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `table ${table.name}: scope pattern ${JSON.stringify(pattern)} must be 'prefix:{variable}' with exactly one variable`,
    );
  }
  const prefix = match[1];
  const variable = match[2];
  const column = typeof spec === 'string' ? variable : spec.column;
  const index = columnIndex.get(column);
  if (index === undefined) {
    throw new Error(
      `table ${table.name}: scope pattern ${JSON.stringify(pattern)} names unknown column ${JSON.stringify(column)}`,
    );
  }
  return { variable, prefix, column, columnIndex: index };
}

const compiledCache = new WeakMap<ServerSchema, CompiledSchema>();

export function compileSchema(schema: ServerSchema): CompiledSchema {
  const cached = compiledCache.get(schema);
  if (cached !== undefined) return cached;
  const tables = new Map<string, CompiledTable>();
  const declaredVariables = new Set<string>();
  for (const table of schema.tables) {
    if (tables.has(table.name)) {
      throw new Error(`duplicate table ${JSON.stringify(table.name)}`);
    }
    const columnIndex = new Map<string, number>();
    table.columns.forEach((column, index) => {
      if (columnIndex.has(column.name)) {
        throw new Error(
          `table ${table.name}: duplicate column ${JSON.stringify(column.name)}`,
        );
      }
      columnIndex.set(column.name, index);
    });
    const primaryKeyIndex = columnIndex.get(table.primaryKey);
    if (primaryKeyIndex === undefined) {
      throw new Error(
        `table ${table.name}: primary key ${JSON.stringify(table.primaryKey)} is not a column`,
      );
    }
    if (table.scopes.length === 0) {
      throw new Error(
        `table ${table.name}: every synced table declares at least one scope pattern (§3.1)`,
      );
    }
    const scopePatterns = table.scopes.map((spec) =>
      compilePattern(table, spec, columnIndex),
    );
    const variables = new Set<string>();
    for (const pattern of scopePatterns) {
      const existing = scopePatterns.find(
        (p) => p.variable === pattern.variable && p.column !== pattern.column,
      );
      if (existing !== undefined) {
        throw new Error(
          `table ${table.name}: variable ${JSON.stringify(pattern.variable)} maps to two different columns (§3.1)`,
        );
      }
      variables.add(pattern.variable);
      declaredVariables.add(pattern.variable);
    }
    const blobRefColumnIndices: number[] = [];
    table.columns.forEach((column, index) => {
      if (column.type === 'blob_ref') blobRefColumnIndices.push(index);
    });
    tables.set(table.name, {
      name: table.name,
      columns: table.columns,
      primaryKeyIndex,
      scopePatterns,
      columnIndex,
      declaredVariables: variables,
      blobRefColumnIndices,
    });
  }
  const compiled: CompiledSchema = {
    version: schema.version,
    tables,
    declaredVariables,
  };
  compiledCache.set(schema, compiled);
  return compiled;
}
