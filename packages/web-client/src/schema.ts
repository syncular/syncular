/**
 * Client schema IR (SPEC.md §2.4, §3.1) — the same shape the server
 * compiles, hand-written until codegen (B5) emits it. Drives local table
 * DDL, the generated row codec, mutation helpers, and the §3.3 purge
 * mapping (scope variable → local column).
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ClientDatabase, SqlValue } from './database';
import { ClientSyncError } from './errors';

/** `'prefix:{variable}'` shorthand (column name = variable) or explicit. */
export type ScopePatternSpec = string | { pattern: string; column: string };

/** One local secondary index (the CREATE INDEX migration subset). */
export interface ClientIndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

export interface ClientTableSchema {
  readonly name: string;
  /** Columns in schema-IR declaration order (the row-codec order, §2.4). */
  readonly columns: readonly RowColumn[];
  readonly primaryKey: string;
  /** Scope patterns (§3.1); the variable→column map feeds the §3.3 purge. */
  readonly scopes: readonly ScopePatternSpec[];
  /** Local secondary indexes; absent in the generated schema when a table
   * declares none (typegen omits the key for index-free tables). */
  readonly indexes?: readonly ClientIndexSpec[];
}

export interface ClientSchema {
  readonly version: number;
  readonly tables: readonly ClientTableSchema[];
}

export interface CompiledClientTable {
  readonly name: string;
  readonly columns: readonly RowColumn[];
  readonly primaryKey: string;
  readonly primaryKeyIndex: number;
  readonly columnIndex: ReadonlyMap<string, number>;
  /** Scope variable → local scope column (§3.3 purge mapping). */
  readonly scopeColumnByVariable: ReadonlyMap<string, string>;
  /**
   * Scope variable → the pattern's literal prefix (§3.1). A stored-scope
   * value `v` for this variable has scope key `prefix:v` — the invalidation
   * vocabulary (TODO 3.1 / DESIGN-eviction I2) and the delta-routing key.
   */
  readonly scopePrefixByVariable: ReadonlyMap<string, string>;
  /** Local secondary indexes to create on the mirror table (declaration
   * order); empty when the table declares none. */
  readonly indexes: readonly ClientIndexSpec[];
}

export interface CompiledClientSchema {
  readonly version: number;
  readonly tables: ReadonlyMap<string, CompiledClientTable>;
}

const PATTERN_RE = /^([^{}]+):\{([^{}:]+)\}$/;

export function compileClientSchema(
  schema: ClientSchema,
): CompiledClientSchema {
  const tables = new Map<string, CompiledClientTable>();
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
    const scopeColumnByVariable = new Map<string, string>();
    const scopePrefixByVariable = new Map<string, string>();
    for (const spec of table.scopes) {
      const pattern = typeof spec === 'string' ? spec : spec.pattern;
      const match = PATTERN_RE.exec(pattern);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error(
          `table ${table.name}: scope pattern ${JSON.stringify(pattern)} must be 'prefix:{variable}'`,
        );
      }
      const prefix = match[1];
      const variable = match[2];
      const column = typeof spec === 'string' ? variable : spec.column;
      if (!columnIndex.has(column)) {
        throw new Error(
          `table ${table.name}: scope pattern ${JSON.stringify(pattern)} names unknown column ${JSON.stringify(column)}`,
        );
      }
      const existing = scopeColumnByVariable.get(variable);
      if (existing !== undefined && existing !== column) {
        throw new Error(
          `table ${table.name}: variable ${JSON.stringify(variable)} maps to two different columns (§3.1)`,
        );
      }
      scopeColumnByVariable.set(variable, column);
      scopePrefixByVariable.set(variable, prefix);
    }
    const indexes = table.indexes ?? [];
    for (const index of indexes) {
      for (const column of index.columns) {
        if (!columnIndex.has(column)) {
          throw new Error(
            `table ${table.name}: index ${JSON.stringify(index.name)} names unknown column ${JSON.stringify(column)}`,
          );
        }
      }
    }
    tables.set(table.name, {
      name: table.name,
      columns: table.columns,
      primaryKey: table.primaryKey,
      primaryKeyIndex,
      columnIndex,
      scopeColumnByVariable,
      scopePrefixByVariable,
      indexes,
    });
  }
  return { version: schema.version, tables };
}

// ---------------------------------------------------------------------------
// Local DDL
// ---------------------------------------------------------------------------

/**
 * Hidden per-row column carrying the last known `server_version` (§2.2):
 * `-1` = local optimistic row never confirmed by the server, `≥ 1` =
 * version from a `COMMIT` change or a segment row record (§5.2/§5.6 —
 * segment rows land with their real server version).
 */
export const SYNC_VERSION_COLUMN = '_sync_version';

/** `_sync_version` for optimistic rows the server has never confirmed. */
export const OPTIMISTIC_VERSION = -1;

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlType(column: RowColumn): string {
  switch (column.type) {
    case 'string':
    case 'json':
    case 'blob_ref':
      return 'TEXT';
    case 'integer':
      return 'INTEGER';
    case 'float':
      return 'REAL';
    case 'boolean':
      return 'INTEGER';
    case 'bytes':
    case 'crdt':
      // §5.10: a crdt column stores its opaque bytes locally, exactly like
      // a bytes column. The Y.Doc view is an app-level helper (§5.10.4).
      return 'BLOB';
  }
}

/** §7.4.1 persisted local schema-version marker (`_syncular_meta` key). */
export const LOCAL_SCHEMA_VERSION_KEY = 'localSchemaVersion';

function createSyncedTable(
  db: ClientDatabase,
  table: CompiledClientTable,
): void {
  const columns = table.columns.map((column) => {
    const notNull = column.nullable ? '' : ' NOT NULL';
    const pk = column.name === table.primaryKey ? ' PRIMARY KEY' : '';
    return `${quoteIdent(column.name)} ${sqlType(column)}${notNull}${pk}`;
  });
  columns.push(`${quoteIdent(SYNC_VERSION_COLUMN)} INTEGER NOT NULL DEFAULT 0`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${columns.join(', ')})`,
  );
  // Local secondary indexes (CREATE INDEX subset). Created here so both the
  // initial ensureLocalSchema and the §7.4.3 drop-and-recreate reset path
  // materialize them. IF NOT EXISTS keeps it idempotent; the DROP TABLE in the
  // reset path already removed any stale index alongside its table.
  for (const index of table.indexes) {
    const unique = index.unique ? 'UNIQUE ' : '';
    const cols = index.columns.map((c) => quoteIdent(c)).join(', ');
    db.exec(
      `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(table.name)} (${cols})`,
    );
  }
}

/**
 * Create the synced tables plus client bookkeeping tables (outbox,
 * subscription state, meta). Idempotent.
 */
export function ensureLocalSchema(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  db.transaction(() => {
    for (const table of schema.tables.values()) {
      createSyncedTable(db, table);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_meta(
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_outbox(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      client_commit_id TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      operations TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_subscriptions(
      id TEXT PRIMARY KEY,
      tbl TEXT NOT NULL,
      requested_scopes TEXT NOT NULL,
      params TEXT,
      cursor INTEGER NOT NULL DEFAULT -1,
      bootstrap_state TEXT,
      effective_scopes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      reason_code TEXT)`);
    // §4.8 window registry: which units (scope values) of a window base are
    // live locally — the completeness oracle (I3) and the shrink driver
    // (a unit's omission from the next pull unregisters it, §4.1).
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_windows(
      base TEXT NOT NULL,
      unit TEXT NOT NULL,
      sub_id TEXT NOT NULL,
      PRIMARY KEY (base, unit))`);
    // §4.8 E1: units that left the window but still had outbox-pinned rows.
    // Retried when the outbox drains; cancelled if the unit re-enters.
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_window_pending_evict(
      sub_id TEXT PRIMARY KEY,
      tbl TEXT NOT NULL,
      effective_scopes TEXT NOT NULL)`);
  });
}

/** Bookkeeping tables the schema-bump reset (§7.4.3) MUST NOT drop. */
const RESERVED_TABLE_PREFIX = '_syncular_';

/**
 * §7.4.3 reset: drop every synced local table (whatever the *previous*
 * generated schema created — discovered from `sqlite_master`, since a
 * bump may add/remove tables) and recreate the synced tables from the
 * NEW schema. Bookkeeping tables (`_syncular_*`: outbox, meta,
 * subscriptions, blob cache) are preserved. Caller owns the surrounding
 * transaction and the subscription-state reset (state.ts).
 */
export function dropAndRecreateSyncedTables(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  const existing = db.query(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE '${RESERVED_TABLE_PREFIX}%'
       AND name NOT LIKE 'sqlite_%'`,
  );
  for (const row of existing) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(String(row.name))}`);
  }
  for (const table of schema.tables.values()) {
    createSyncedTable(db, table);
  }
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

/** RowValue → SQL bind value for the local mirror tables. */
export function toSqlValue(value: RowValue): SqlValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** SQL cell → RowValue per the column's declared type. */
export function fromSqlValue(column: RowColumn, value: SqlValue): RowValue {
  if (value === null) return null;
  switch (column.type) {
    case 'boolean':
      return value !== 0 && value !== false;
    case 'integer':
      return typeof value === 'bigint' ? Number(value) : (value as number);
    case 'float':
      return value as number;
    case 'bytes':
    case 'crdt':
      return value as Uint8Array;
    case 'string':
    case 'json':
    case 'blob_ref':
      return value as string;
  }
}

/**
 * App-facing record → schema-ordered row values for the codec and the
 * local mirror. Missing keys become NULL; unknown keys fail loud.
 */
export function recordToRowValues(
  table: CompiledClientTable,
  record: Readonly<Record<string, unknown>>,
): RowValue[] {
  for (const key of Object.keys(record)) {
    if (!table.columnIndex.has(key)) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `table ${table.name}: unknown column ${JSON.stringify(key)} in mutation values`,
      );
    }
  }
  return table.columns.map((column) => {
    const value = record[column.name];
    if (value === undefined || value === null) {
      if (!column.nullable) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `table ${table.name}: column ${JSON.stringify(column.name)} is not nullable (§6.1 full-row payloads)`,
        );
      }
      return null;
    }
    return value as RowValue;
  });
}

// ---------------------------------------------------------------------------
// Schema-agnostic JSON form (outbox persistence — the §0 outbox rule)
// ---------------------------------------------------------------------------

export type JsonRowValue =
  | string
  | number
  | boolean
  | null
  | { readonly $bytes: string };

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function rowValueToJson(value: RowValue): JsonRowValue {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  return value;
}

export function jsonToRowValue(value: JsonRowValue): RowValue {
  if (typeof value === 'object' && value !== null) {
    return hexToBytes(value.$bytes);
  }
  return value;
}
