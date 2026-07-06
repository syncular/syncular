/**
 * Server schema IR (SPEC.md §2.4, §3.1).
 *
 * The server is configured with a schema IR: tables, columns with the six
 * §2.4 column types, scope patterns per §3.1, and a schema version. Codegen
 * (B5) will emit this shape later; tests hand-write it.
 */
import type { RowColumn } from '@syncular/core';

/** `'prefix:{variable}'` shorthand (column name = variable) or explicit. */
export type ScopePatternSpec = string | { pattern: string; column: string };

/**
 * A user-declared index (the migration subset's CREATE INDEX). With
 * relational server storage these apply server-side too (DESIGN
 * "user indexes") — the same declaration the client materializes.
 */
export interface IndexSchema {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

export interface TableSchema {
  readonly name: string;
  /** Columns in schema-IR declaration order (the row-codec order, §2.4). */
  readonly columns: readonly RowColumn[];
  /** Primary-key column; its value renders as the change `rowId` (§2.2). */
  readonly primaryKey: string;
  /** Scope patterns (§3.1). Every synced table declares at least one. */
  readonly scopes: readonly ScopePatternSpec[];
  /** User indexes (optional) — created on the server's relational tables. */
  readonly indexes?: readonly IndexSchema[];
  /**
   * Server-side column materialization (DESIGN-relational-server-storage.md
   * "optional materialization"). When `true` (the usual default) the server's
   * row table carries the app's typed columns as a queryable projection;
   * when `false` it carries only the `_sync_*` meta columns — same storage
   * layout, same serve path, no decode on the push path, but no server-side
   * SQL over the app's columns (and user indexes are skipped).
   *
   * Unset defaults to `true`, EXCEPT for tables whose every non-PK,
   * non-scope column is encrypted (§5.11): their projection would be
   * columns of ciphertext, so they default to `false`. Explicit values
   * always win. Changing the value later requires a schemaVersion bump
   * (flipping on backfills the projection from stored payloads).
   */
  readonly materialize?: boolean;
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
  /** User indexes (validated: unique names, existing columns). */
  readonly indexes: readonly IndexSchema[];
  /** Resolved materialization (see `TableSchema.materialize`). */
  readonly materialize: boolean;
  readonly columnIndex: ReadonlyMap<string, number>;
  readonly declaredVariables: ReadonlySet<string>;
  /** Column indices declared `blob_ref` (§2.4 tag 7, §5.9) — the columns
   * whose non-NULL values reference blobs (existence check, reference
   * index). */
  readonly blobRefColumnIndices: readonly number[];
  /** `crdt` columns (§2.4 tag 8, §5.10) — index + the `crdtType` name that
   * selects the merger. Empty when the table has no crdt columns. */
  readonly crdtColumns: readonly {
    readonly index: number;
    readonly crdtType: string;
  }[];
  /** §5.11: column indices marked `encrypted`. The server never decrypts;
   * this only excludes the table from sqlite-image eligibility (§5.3) — an
   * image copies ciphertext wholesale with no per-row decrypt pass, so an
   * encrypted table MUST be served via the rows lane. Empty ⇒ no restriction. */
  readonly encryptedColumnIndices: readonly number[];
}

export interface CompiledSchema {
  readonly version: number;
  readonly tables: ReadonlyMap<string, CompiledTable>;
  /** Union of scope variables declared by any table (§3.2 resolver check). */
  readonly declaredVariables: ReadonlySet<string>;
}

const PATTERN_RE = /^([^{}]+):\{([^{}:]+)\}$/;

/**
 * Identifier rules for relational server storage (DESIGN "current-row
 * tables"): app tables live in the same namespace as the sync
 * infrastructure tables (`sync_*`) and carry `_sync_*` meta columns, so
 * both prefixes are reserved; identifiers over 63 bytes would be silently
 * truncated by Postgres.
 */
function validateIdentifier(kind: string, name: string): void {
  if (name.length === 0) {
    throw new Error(`${kind} name must not be empty`);
  }
  const lower = name.toLowerCase();
  if (lower.startsWith('sync_') || lower.startsWith('_sync')) {
    throw new Error(
      `${kind} name ${JSON.stringify(name)} uses a reserved prefix (sync_/_sync are the server storage namespace)`,
    );
  }
  if (new TextEncoder().encode(name).length > 63) {
    throw new Error(
      `${kind} name ${JSON.stringify(name)} exceeds 63 bytes (Postgres identifier limit)`,
    );
  }
}

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
    validateIdentifier('table', table.name);
    const columnIndex = new Map<string, number>();
    table.columns.forEach((column, index) => {
      if (columnIndex.has(column.name)) {
        throw new Error(
          `table ${table.name}: duplicate column ${JSON.stringify(column.name)}`,
        );
      }
      validateIdentifier(`table ${table.name}: column`, column.name);
      columnIndex.set(column.name, index);
    });
    const indexes = table.indexes ?? [];
    const indexNames = new Set<string>();
    for (const index of indexes) {
      validateIdentifier(`table ${table.name}: index`, index.name);
      if (indexNames.has(index.name)) {
        throw new Error(
          `table ${table.name}: duplicate index ${JSON.stringify(index.name)}`,
        );
      }
      indexNames.add(index.name);
      for (const column of index.columns) {
        if (!columnIndex.has(column)) {
          throw new Error(
            `table ${table.name}: index ${JSON.stringify(index.name)} names unknown column ${JSON.stringify(column)}`,
          );
        }
      }
    }
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
    const crdtColumns: { index: number; crdtType: string }[] = [];
    const encryptedColumnIndices: number[] = [];
    table.columns.forEach((column, index) => {
      if (column.type === 'blob_ref') blobRefColumnIndices.push(index);
      // §5.11: an encrypted column carries wire type `bytes` + `encrypted`.
      if (column.encrypted === true) encryptedColumnIndices.push(index);
      if (column.type === 'crdt') {
        // §5.10.1: a crdt column MUST name a crdtType (schema-compile-time
        // requirement — a crdt column without one is a server bug).
        if (column.crdtType === undefined || column.crdtType.length === 0) {
          throw new Error(
            `table ${table.name}: crdt column ${JSON.stringify(column.name)} must declare a crdtType (§5.10.1)`,
          );
        }
        crdtColumns.push({ index, crdtType: column.crdtType });
      }
    });
    // Materialization default: explicit wins; otherwise on, unless every
    // non-PK, non-scope column is encrypted — a fully-E2EE table's
    // projection would be pure ciphertext, so it defaults off.
    const scopeColumnIndices = new Set(
      scopePatterns.map((pattern) => pattern.columnIndex),
    );
    const projectable = table.columns.filter(
      (column, index) =>
        index !== primaryKeyIndex && !scopeColumnIndices.has(index),
    );
    const fullyEncrypted =
      encryptedColumnIndices.length > 0 &&
      projectable.length > 0 &&
      projectable.every((column) => column.encrypted === true);
    const materialize = table.materialize ?? !fullyEncrypted;

    tables.set(table.name, {
      name: table.name,
      columns: table.columns,
      primaryKeyIndex,
      scopePatterns,
      indexes,
      materialize,
      columnIndex,
      declaredVariables: variables,
      blobRefColumnIndices,
      crdtColumns,
      encryptedColumnIndices,
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
