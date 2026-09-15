/**
 * Server schema IR (SPEC.md §2.4, §3.1).
 *
 * The server is configured with a schema IR: tables, columns with the six
 * §2.4 column types, scope patterns per §3.1, and a schema version. Codegen
 * Typegen emits this shape; tests hand-write it.
 */
import {
  type RowColumn,
  validatePortableRelationalIdentifier,
} from '@syncular/core';

/** `'prefix:{variable}'` shorthand (column name = variable) or explicit. */
export type ScopePatternSpec = string | { pattern: string; column: string };

/**
 * A user-declared index (the migration subset's CREATE INDEX). Relational
 * server storage applies the same declaration the client materializes.
 */
export interface IndexSchema {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

/** One declared reference (§6.11). Absent `onDelete` means `RESTRICT`. */
export interface ReferenceSchema {
  readonly column: string;
  readonly parentTable: string;
  readonly onDelete?: ReferenceOnDelete;
}

export type ReferenceOnDelete = 'RESTRICT' | 'CASCADE' | 'SET NULL';

/** A compiled outgoing reference (§6.11). */
export interface CompiledReference {
  readonly column: string;
  readonly columnIndex: number;
  readonly parentTable: string;
  readonly onDelete: ReferenceOnDelete;
}

/** A compiled INCOMING reference: rows of `table` whose `column` points at a
 * row of the table that carries this entry. `index` is the declared
 * single-column index the server probes through `scanRowsByIndex` (§6.8). */
export interface CompiledIncomingReference {
  readonly table: string;
  readonly column: string;
  readonly columnIndex: number;
  readonly onDelete: ReferenceOnDelete;
  readonly index: string;
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
  /** Declared references (§6.11). Optional so pre-reference schemas stay
   * valid; the reference index over each child column is declared in
   * `indexes` (typegen emits it). */
  readonly references?: readonly ReferenceSchema[];
  /**
   * Server-side column materialization
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
  /** Outgoing declared references (§6.11), resolved to column indices. */
  readonly references: readonly CompiledReference[];
  /** Incoming declared references: child rows to reach on a parent delete. */
  readonly referencedBy: readonly CompiledIncomingReference[];
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
 * Compile one `prefix:{variable}` scope pattern against the table's column
 * list, resolving the scope column's positional index for row extraction.
 */
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
    // Identifier rules live in core's validatePortableRelationalIdentifier,
    // shared with typegen: app tables
    // share a namespace with the sync infrastructure tables (`sync_*`) and
    // carry `_sync_*` meta columns, so both prefixes are reserved, and
    // Postgres silently truncates identifiers over 63 bytes.
    validatePortableRelationalIdentifier('table', table.name);
    const columnIndex = new Map<string, number>();
    table.columns.forEach((column, index) => {
      if (columnIndex.has(column.name)) {
        throw new Error(
          `table ${table.name}: duplicate column ${JSON.stringify(column.name)}`,
        );
      }
      validatePortableRelationalIdentifier(
        `table ${table.name}: column`,
        column.name,
      );
      columnIndex.set(column.name, index);
    });
    const indexes = table.indexes ?? [];
    const indexNames = new Set<string>();
    for (const index of indexes) {
      validatePortableRelationalIdentifier(
        `table ${table.name}: index`,
        index.name,
      );
      if (indexNames.has(index.name)) {
        throw new Error(
          `table ${table.name}: duplicate index ${JSON.stringify(index.name)}`,
        );
      }
      indexNames.add(index.name);
      if (index.columns.length === 0) {
        throw new Error(
          `table ${table.name}: index ${JSON.stringify(index.name)} must name at least one column`,
        );
      }
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
    const references: CompiledReference[] = [];
    for (const reference of table.references ?? []) {
      const index = columnIndex.get(reference.column);
      if (index === undefined) {
        throw new Error(
          `table ${table.name}: reference column ${JSON.stringify(reference.column)} is not a column`,
        );
      }
      references.push({
        column: reference.column,
        columnIndex: index,
        parentTable: reference.parentTable,
        onDelete: reference.onDelete ?? 'RESTRICT',
      });
    }
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
      (_column, index) =>
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
      references,
      referencedBy: [],
      materialize,
      columnIndex,
      declaredVariables: variables,
      blobRefColumnIndices,
      crdtColumns,
      encryptedColumnIndices,
    });
  }
  // §6.11: resolve incoming references and enforce the declaration rules the
  // generator enforces too, so a hand-written server schema fails loud.
  for (const child of tables.values()) {
    for (const reference of child.references) {
      const parent = tables.get(reference.parentTable);
      if (parent === undefined) {
        throw new Error(
          `table ${child.name}: reference column ${JSON.stringify(reference.column)} names unknown table ${JSON.stringify(reference.parentTable)}`,
        );
      }
      const childColumn = child.columns[reference.columnIndex];
      const parentKey = parent.columns[parent.primaryKeyIndex];
      if (childColumn === undefined || parentKey === undefined) {
        throw new Error(
          `unreachable: ${child.name}.${reference.column} or a missing primary key on ${parent.name}`,
        );
      }
      if (childColumn.type !== parentKey.type) {
        throw new Error(
          `table ${child.name}: reference column ${JSON.stringify(reference.column)} has type ${JSON.stringify(childColumn.type)} but ${parent.name}.${parentKey.name} has type ${JSON.stringify(parentKey.type)} — the types must match (§6.11)`,
        );
      }
      if (reference.onDelete === 'SET NULL' && !childColumn.nullable) {
        throw new Error(
          `table ${child.name}: reference column ${JSON.stringify(reference.column)} is not nullable but declares ON DELETE SET NULL (§6.11)`,
        );
      }
      const patterns = (compiled: CompiledTable): string =>
        compiled.scopePatterns
          .map((pattern) => `${pattern.prefix}:{${pattern.variable}}`)
          .sort()
          .join('\u0000');
      if (patterns(child) !== patterns(parent)) {
        throw new Error(
          `table ${child.name}: reference column ${JSON.stringify(reference.column)} targets ${parent.name}, whose scope patterns differ — a cascade MUST NOT cross an authorization boundary (§6.11)`,
        );
      }
      const index = child.indexes.find(
        (candidate) =>
          candidate.columns.length === 1 &&
          candidate.columns[0] === reference.column,
      );
      if (index === undefined) {
        throw new Error(
          `table ${child.name}: reference column ${JSON.stringify(reference.column)} needs a declared single-column index so the server reaches children through scanRowsByIndex (§6.11)`,
        );
      }
      (parent.referencedBy as CompiledIncomingReference[]).push({
        table: child.name,
        column: reference.column,
        columnIndex: reference.columnIndex,
        onDelete: reference.onDelete,
        index: index.name,
      });
    }
  }
  const compiled: CompiledSchema = {
    version: schema.version,
    tables,
    declaredVariables,
  };
  compiledCache.set(schema, compiled);
  return compiled;
}
