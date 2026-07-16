/**
 * Client schema IR (SPEC.md §2.4, §3.1) — the same shape the server
 * compiles, hand-written until codegen (B5) emits it. Drives local table
 * DDL, the generated row codec, mutation helpers, and the §3.3 purge
 * mapping (scope variable → local column).
 */
import type { RowColumn, RowValue } from '@syncular/core';
import type { ClientDatabase, SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import { snakeToCamel } from './naming';

/** `'prefix:{variable}'` shorthand (column name = variable) or explicit. */
export type ScopePatternSpec = string | { pattern: string; column: string };

/** One local secondary index (the CREATE INDEX migration subset). */
export interface ClientIndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

/** One client-local contentful FTS5 projection (RFC 0005). */
export interface ClientFtsIndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly tokenize: string;
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
  /** Local FTS5 search projections; omitted when a table declares none. */
  readonly ftsIndexes?: readonly ClientFtsIndexSpec[];
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
  /**
   * §5 mutate key normalization: unambiguous camelCase alias → column
   * index. An alias is dropped when it equals another column's exact name
   * or when two columns map to the same alias (exact names always win; the
   * generator errors on such schemas under camel naming anyway).
   */
  readonly columnIndexByCamel: ReadonlyMap<string, number>;
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
  /** Client-local FTS5 projections, in declaration order. */
  readonly ftsIndexes: readonly ClientFtsIndexSpec[];
  /** §5.11: true when any column is `encrypted`. Drives the encrypt/decrypt
   * seam (skipped entirely when false) and the local-plaintext DDL. */
  readonly hasEncryptedColumns: boolean;
}

export interface CompiledClientSchema {
  readonly version: number;
  readonly tables: ReadonlyMap<string, CompiledClientTable>;
}

const PATTERN_RE = /^([^{}]+):\{([^{}:]+)\}$/;
const ALLOWED_FTS_TOKENIZERS = new Set([
  'unicode61',
  'unicode61 remove_diacritics 0',
  'unicode61 remove_diacritics 1',
  'unicode61 remove_diacritics 2',
  'porter unicode61',
  'trigram',
]);

export function compileClientSchema(
  schema: ClientSchema,
): CompiledClientSchema {
  const tables = new Map<string, CompiledClientTable>();
  const schemaObjectNames = new Set<string>();
  for (const table of schema.tables) {
    if (tables.has(table.name)) {
      throw new Error(`duplicate table ${JSON.stringify(table.name)}`);
    }
    if (schemaObjectNames.has(table.name)) {
      throw new Error(
        `table ${JSON.stringify(table.name)} conflicts with an index or FTS projection`,
      );
    }
    schemaObjectNames.add(table.name);
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
    // §5: unambiguous camelCase aliases for mutate key normalization.
    const columnIndexByCamel = new Map<string, number>();
    const ambiguous = new Set<string>();
    table.columns.forEach((column, index) => {
      const alias = snakeToCamel(column.name);
      if (alias === column.name || columnIndex.has(alias)) return;
      if (columnIndexByCamel.has(alias)) {
        ambiguous.add(alias);
        return;
      }
      columnIndexByCamel.set(alias, index);
    });
    for (const alias of ambiguous) columnIndexByCamel.delete(alias);
    const indexes = table.indexes ?? [];
    for (const index of indexes) {
      if (schemaObjectNames.has(index.name)) {
        throw new Error(
          `table ${table.name}: index ${JSON.stringify(index.name)} conflicts with another schema object`,
        );
      }
      schemaObjectNames.add(index.name);
      for (const column of index.columns) {
        if (!columnIndex.has(column)) {
          throw new Error(
            `table ${table.name}: index ${JSON.stringify(index.name)} names unknown column ${JSON.stringify(column)}`,
          );
        }
      }
    }
    const ftsIndexes = table.ftsIndexes ?? [];
    for (const index of ftsIndexes) {
      if (schemaObjectNames.has(index.name)) {
        throw new Error(
          `table ${table.name}: FTS projection ${JSON.stringify(index.name)} conflicts with another schema object`,
        );
      }
      schemaObjectNames.add(index.name);
      if (index.columns.length === 0 || index.columns.length > 32) {
        throw new Error(
          `table ${table.name}: FTS projection ${JSON.stringify(index.name)} needs between 1 and 32 columns`,
        );
      }
      const seenColumns = new Set<string>();
      for (const columnName of index.columns) {
        if (seenColumns.has(columnName)) {
          throw new Error(
            `table ${table.name}: FTS projection ${JSON.stringify(index.name)} repeats column ${JSON.stringify(columnName)}`,
          );
        }
        seenColumns.add(columnName);
        const column = table.columns.find(
          (candidate) => candidate.name === columnName,
        );
        if (column === undefined) {
          throw new Error(
            `table ${table.name}: FTS projection ${JSON.stringify(index.name)} names unknown column ${JSON.stringify(columnName)}`,
          );
        }
        if (localColumnType(column) !== 'string') {
          throw new Error(
            `table ${table.name}: FTS projection ${JSON.stringify(index.name)} column ${JSON.stringify(columnName)} must have string type`,
          );
        }
      }
      if (!ALLOWED_FTS_TOKENIZERS.has(index.tokenize)) {
        throw new Error(
          `table ${table.name}: FTS projection ${JSON.stringify(index.name)} tokenizer ${JSON.stringify(index.tokenize)} is not allowlisted`,
        );
      }
    }
    tables.set(table.name, {
      name: table.name,
      columns: table.columns,
      primaryKey: table.primaryKey,
      primaryKeyIndex,
      columnIndex,
      columnIndexByCamel,
      scopeColumnByVariable,
      scopePrefixByVariable,
      indexes,
      ftsIndexes,
      hasEncryptedColumns: table.columns.some((c) => c.encrypted === true),
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

/**
 * Strip the reserved `_sync_*` columns from app-facing query rows, so a
 * `SELECT *` row round-trips straight into `mutate()` values. Result
 * columns are per-statement, so the first row decides for all rows; an
 * explicit alias (`SELECT _sync_version AS v`) passes through untouched.
 * Engine internals read `_sync_version` via `client.database` and never
 * pass through this filter.
 */
export function stripSyncColumns(rows: SqlRow[]): SqlRow[] {
  const first = rows[0];
  if (first === undefined) return rows;
  const reserved = Object.keys(first).filter((key) => key.startsWith('_sync_'));
  if (reserved.length === 0) return rows;
  return rows.map((row) => {
    const copy: SqlRow = { ...row };
    for (const key of reserved) delete copy[key];
    return copy;
  });
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * §5.11: the app-side type of a column for local (plaintext) storage. For an
 * encrypted column this is `declaredType` — the local mirror stays plaintext,
 * so it stores/reads the real value type, not the wire `bytes`.
 */
export function localColumnType(column: RowColumn): RowColumn['type'] {
  if (column.encrypted && column.declaredType !== undefined) {
    return column.declaredType;
  }
  return column.type;
}

function sqlType(column: RowColumn): string {
  switch (localColumnType(column)) {
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

const FTS_SOURCE_ID_COLUMN = '_syncular_source_id';

function createFtsProjection(
  db: ClientDatabase,
  table: CompiledClientTable,
  index: ClientFtsIndexSpec,
): void {
  const existed =
    db.query(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
      [index.name],
    ).length > 0;
  const indexedColumns = index.columns.map(quoteIdent);
  const tokenizer = index.tokenize.replaceAll("'", "''");
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdent(index.name)} USING fts5(${quoteIdent(FTS_SOURCE_ID_COLUMN)} UNINDEXED, ${indexedColumns.join(', ')}, tokenize='${tokenizer}')`,
  );

  const sourceId = `CAST(${quoteIdent(table.primaryKey)} AS TEXT)`;
  const newSourceId = `CAST(new.${quoteIdent(table.primaryKey)} AS TEXT)`;
  const oldSourceId = `CAST(old.${quoteIdent(table.primaryKey)} AS TEXT)`;
  const projectionColumns = [
    quoteIdent(FTS_SOURCE_ID_COLUMN),
    ...indexedColumns,
  ].join(', ');
  const newValues = [
    newSourceId,
    ...index.columns.map((column) => `new.${quoteIdent(column)}`),
  ].join(', ');
  const deleteFor = (value: string) =>
    `DELETE FROM ${quoteIdent(index.name)} WHERE ${quoteIdent(FTS_SOURCE_ID_COLUMN)} = ${value}`;

  db.exec(
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${index.name}_ai`)} AFTER INSERT ON ${quoteIdent(table.name)} BEGIN ${deleteFor(newSourceId)}; INSERT INTO ${quoteIdent(index.name)} (${projectionColumns}) VALUES (${newValues}); END`,
  );
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${index.name}_ad`)} AFTER DELETE ON ${quoteIdent(table.name)} BEGIN ${deleteFor(oldSourceId)}; END`,
  );
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${index.name}_au`)} AFTER UPDATE ON ${quoteIdent(table.name)} BEGIN ${deleteFor(oldSourceId)}; ${deleteFor(newSourceId)}; INSERT INTO ${quoteIdent(index.name)} (${projectionColumns}) VALUES (${newValues}); END`,
  );

  if (!existed) {
    db.exec(
      `INSERT INTO ${quoteIdent(index.name)} (${projectionColumns}) SELECT ${sourceId}, ${indexedColumns.join(', ')} FROM ${quoteIdent(table.name)}`,
    );
  }
}

/**
 * Create only the application-owned synced tables, indexes, and FTS
 * projections. Callers opening an existing database must compare the
 * persisted schema version before invoking this: a new index may reference a
 * column that does not exist until the schema-bump reset recreates the table.
 */
export function ensureLocalSyncedSchema(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  db.transaction(() => {
    for (const table of schema.tables.values()) {
      createSyncedTable(db, table);
    }
    for (const table of schema.tables.values()) {
      for (const index of table.ftsIndexes) {
        createFtsProjection(db, table, index);
      }
    }
  });
}

/**
 * Create the protected Syncular bookkeeping tables without touching the
 * application schema. This makes the persisted schema-version marker
 * readable before any new application index or FTS projection is applied.
 */
export function ensureLocalBookkeepingSchema(db: ClientDatabase): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_meta(
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(
      `INSERT OR IGNORE INTO _syncular_meta(key, value) VALUES ('localRevision', '0')`,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_outbox(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      client_commit_id TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      operations TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_outbox_before_images(
      client_commit_id TEXT NOT NULL,
      op_index INTEGER NOT NULL,
      existed INTEGER NOT NULL CHECK(existed IN (0, 1)),
      sync_version INTEGER,
      values_json TEXT,
      PRIMARY KEY(client_commit_id, op_index))`);
    db.exec(`CREATE TABLE IF NOT EXISTS _syncular_commit_outcomes(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      client_commit_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('applied', 'cached', 'conflict', 'rejected')),
      recorded_at_ms INTEGER NOT NULL,
      results TEXT NOT NULL,
      operations TEXT,
      resolution TEXT NOT NULL DEFAULT 'active'
        CHECK(resolution IN ('active', 'resolved_keep_server', 'superseded', 'dismissed')),
      resolved_at_ms INTEGER,
      replacement_client_commit_id TEXT)`);
    // Outcomes created before durable aggregate recovery retain no commit
    // envelope. New failed outcomes store it in the protected client DB.
    try {
      db.exec(
        'ALTER TABLE _syncular_commit_outcomes ADD COLUMN operations TEXT',
      );
    } catch {
      // column already exists — the CREATE above included it
    }
    db.exec(`CREATE INDEX IF NOT EXISTS _syncular_commit_outcomes_resolution_seq
      ON _syncular_commit_outcomes(resolution, seq)`);
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

/** Create both application and protected bookkeeping tables. */
export function ensureLocalSchema(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  ensureLocalBookkeepingSchema(db);
  ensureLocalSyncedSchema(db, schema);
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
  // Drop virtual tables first. SQLite then removes their shadow tables as one
  // unit, so the generic discovery below never tears an FTS5 projection apart.
  const virtualTables = db.query(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND sql LIKE 'CREATE VIRTUAL TABLE%'
       AND name NOT LIKE '${RESERVED_TABLE_PREFIX}%'`,
  );
  for (const row of virtualTables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(String(row.name))}`);
  }
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
  for (const table of schema.tables.values()) {
    for (const index of table.ftsIndexes) {
      createFtsProjection(db, table, index);
    }
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
  switch (localColumnType(column)) {
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
 * Normalize an app-facing record's keys to the SQL-truth snake_case column
 * names. Keys are accepted in exactly two casings (§5/§12): snake_case and
 * the generated row types' camelCase — one bijective-map lookup per key,
 * no fuzzy matching. Unknown keys fail loud (with a dedicated hint for the
 * reserved `_sync_*` names); giving one column in both casings is an error.
 */
export function normalizeRecordKeys(
  table: CompiledClientTable,
  record: Readonly<Record<string, unknown>>,
): Map<string, unknown> {
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    const index =
      table.columnIndex.get(key) ?? table.columnIndexByCamel.get(key);
    if (index === undefined) {
      if (key.startsWith('_sync_')) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `table ${table.name}: ${JSON.stringify(key)} is an internal sync column and cannot appear in mutation values — did you build this record from a raw SELECT * row? (client.query() strips _sync_* columns; rows read via client.database keep them)`,
        );
      }
      throw new ClientSyncError(
        'sync.invalid_request',
        `table ${table.name}: unknown column ${JSON.stringify(key)} in mutation values (snake_case and camelCase keys are accepted)`,
      );
    }
    const sqlName = (table.columns[index] as RowColumn).name;
    if (normalized.has(sqlName)) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `table ${table.name}: column ${JSON.stringify(sqlName)} appears twice in mutation values (as both snake_case and camelCase) — pass it once`,
      );
    }
    normalized.set(sqlName, value);
  }
  return normalized;
}

/**
 * Accept the local SQL representation of a value alongside the app-facing
 * one, so a row read straight off the mirror (`SELECT *`) feeds back into
 * `mutate()` without per-column fixups: SQLite stores booleans as 0/1 and
 * may surface integers as bigint. Anything else passes through untouched —
 * the codec still fails loud on genuine type garbage at encode time.
 */
function coerceSqlRepresentation(column: RowColumn, value: unknown): unknown {
  switch (localColumnType(column)) {
    case 'boolean':
      return value === 0 ? false : value === 1 ? true : value;
    case 'integer':
    case 'float':
      return typeof value === 'bigint' ? Number(value) : value;
    default:
      return value;
  }
}

/**
 * App-facing record → schema-ordered row values for the codec and the
 * local mirror. Missing keys become NULL; unknown keys fail loud (see
 * {@link normalizeRecordKeys} for the accepted casings).
 */
export function recordToRowValues(
  table: CompiledClientTable,
  record: Readonly<Record<string, unknown>>,
): RowValue[] {
  const normalized = normalizeRecordKeys(table, record);
  return table.columns.map((column) => {
    const value = normalized.get(column.name);
    if (value === undefined || value === null) {
      if (!column.nullable) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `table ${table.name}: column ${JSON.stringify(column.name)} is not nullable (§6.1 full-row payloads)`,
        );
      }
      return null;
    }
    return coerceSqlRepresentation(column, value) as RowValue;
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
