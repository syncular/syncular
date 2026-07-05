/**
 * Relational current-row storage (DESIGN-relational-server-storage.md).
 *
 * Every synced table is a REAL table in the server database — the app's
 * columns with proper type affinities, queryable with plain SQL/joins/BI —
 * plus five `_sync_*` meta columns:
 *
 *   _sync_partition       TEXT      partition key (multi-partition servers
 *                                   share one database; same app PK in two
 *                                   partitions must coexist)
 *   _sync_row_id          TEXT      the change rowId (§2.2) — the string
 *                                   rendering of the app PK. The storage key
 *                                   stays TEXT so lookup and scan-pagination
 *                                   semantics are byte-identical to the old
 *                                   generic store regardless of the PK's type.
 *   _sync_server_version  INTEGER   §2.2 server version
 *   _sync_scopes          TEXT/JSONB the stored-scope map the §3.4 authz read
 *                                   consumes (also present as real columns;
 *                                   the map is cheaper to read back)
 *   _sync_payload         BLOB/BYTEA the verbatim row-codec bytes — the wire
 *                                   source of truth. The serve path reads
 *                                   THIS, never re-encodes from typed columns,
 *                                   so sync round-trips are byte-identical by
 *                                   construction. Typed columns are a
 *                                   queryable projection.
 *
 * PRIMARY KEY (_sync_partition, _sync_row_id).
 *
 * The typed columns are written from `decodeRow(payload)` in the same
 * statement as the payload, so projection and payload cannot drift except
 * through a codec bug — which the round-trip contract tests would catch.
 *
 * Dialect notes:
 * - postgres maps `json` → JSONB (queryable: `->>`, GIN). JSONB normalizes
 *   bytes, which is safe because the wire never reads typed columns.
 *   A json value that fails to parse binds NULL on postgres (the payload
 *   still holds it verbatim); sqlite stores the text as-is.
 * - D1's JSON transport represents integers as JS doubles; app integer
 *   columns beyond 2^53 lose precision in the PROJECTION only — the
 *   payload is exact, sync is unaffected.
 * - Migration-added columns (ALTER TABLE ADD COLUMN) are always nullable at
 *   the DB layer: SQLite cannot add a NOT NULL column without a default, and
 *   the row codec — not the DB — is the type authority. Fresh CREATEs carry
 *   NOT NULL per the schema.
 */
import { decodeRow, type RowColumn, type RowValue } from '@syncular/core';
import type { CompiledSchema, CompiledTable } from './schema';
import type { StoredRow } from './storage';

export type RelationalDialect = 'sqlite' | 'postgres';

export const SYNC_PARTITION_COLUMN = '_sync_partition';
export const SYNC_ROW_ID_COLUMN = '_sync_row_id';
export const SYNC_VERSION_COLUMN = '_sync_server_version';
export const SYNC_SCOPES_COLUMN = '_sync_scopes';
export const SYNC_PAYLOAD_COLUMN = '_sync_payload';

/** SQL-standard identifier quoting (both dialects). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** §5.3-style type affinities, per dialect (DESIGN type-mapping table). */
export function columnSqlType(
  column: RowColumn,
  dialect: RelationalDialect,
): string {
  if (dialect === 'postgres') {
    switch (column.type) {
      case 'string':
      case 'blob_ref':
        return 'TEXT';
      case 'json':
        return 'JSONB';
      case 'integer':
        return 'BIGINT';
      case 'float':
        return 'DOUBLE PRECISION';
      case 'boolean':
        return 'BOOLEAN';
      case 'bytes':
      case 'crdt':
        return 'BYTEA';
      default:
        throw new Error(`unsupported column type: ${String(column.type)}`);
    }
  }
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
      return 'BLOB';
    default:
      throw new Error(`unsupported column type: ${String(column.type)}`);
  }
}

/**
 * The full column list of a relational row table, in INSERT order:
 * partition, row id, app columns (schema order), version, scopes, payload.
 */
export function tableColumnNames(table: CompiledTable): string[] {
  return [
    SYNC_PARTITION_COLUMN,
    SYNC_ROW_ID_COLUMN,
    ...table.columns.map((column) => column.name),
    SYNC_VERSION_COLUMN,
    SYNC_SCOPES_COLUMN,
    SYNC_PAYLOAD_COLUMN,
  ];
}

/** CREATE TABLE IF NOT EXISTS for one app table. */
export function createTableDdl(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const versionType = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const scopesType = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const payloadType = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  const defs = [
    `${quoteIdent(SYNC_PARTITION_COLUMN)} TEXT NOT NULL`,
    `${quoteIdent(SYNC_ROW_ID_COLUMN)} TEXT NOT NULL`,
    ...table.columns.map((column) => {
      const notNull = column.nullable ? '' : ' NOT NULL';
      return `${quoteIdent(column.name)} ${columnSqlType(column, dialect)}${notNull}`;
    }),
    `${quoteIdent(SYNC_VERSION_COLUMN)} ${versionType} NOT NULL`,
    `${quoteIdent(SYNC_SCOPES_COLUMN)} ${scopesType} NOT NULL`,
    `${quoteIdent(SYNC_PAYLOAD_COLUMN)} ${payloadType} NOT NULL`,
    `PRIMARY KEY (${quoteIdent(SYNC_PARTITION_COLUMN)}, ${quoteIdent(SYNC_ROW_ID_COLUMN)})`,
  ];
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${defs.join(', ')})`;
}

/**
 * ALTER TABLE ADD COLUMN statements for schema columns missing from
 * `existingColumns` (introspected). Added columns are nullable (header note).
 */
export function addColumnDdl(
  table: CompiledTable,
  existingColumns: ReadonlySet<string>,
  dialect: RelationalDialect,
): string[] {
  const out: string[] = [];
  for (const column of table.columns) {
    if (existingColumns.has(column.name)) continue;
    out.push(
      `ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${quoteIdent(column.name)} ${columnSqlType(column, dialect)}`,
    );
  }
  return out;
}

/**
 * CREATE INDEX IF NOT EXISTS for the table's user-declared indexes
 * (DESIGN "user indexes" — the same names/columns the client materializes;
 * cross-table index-name uniqueness is the user's schema concern, exactly
 * as it is client-side).
 */
export function createIndexDdl(table: CompiledTable): string[] {
  return table.indexes.map((index) => {
    const unique = index.unique ? 'UNIQUE ' : '';
    const columns = index.columns
      .map((column) => quoteIdent(column))
      .join(', ');
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(table.name)} (${columns})`;
  });
}

/**
 * Convert one decoded row value to its SQL bind value.
 * - boolean → 0/1 on sqlite (INTEGER affinity), native on postgres;
 * - json → the raw string on sqlite; on postgres, NULL if unparseable
 *   (JSONB would reject the INSERT — the payload keeps the verbatim value);
 * - everything else binds naturally (Uint8Array → BLOB/BYTEA).
 */
export function toSqlValue(
  column: RowColumn,
  value: RowValue,
  dialect: RelationalDialect,
): unknown {
  if (value === null) return null;
  if (column.type === 'boolean' && dialect === 'sqlite') {
    return value === true ? 1 : 0;
  }
  if (column.type === 'json' && dialect === 'postgres') {
    if (typeof value !== 'string') return null;
    try {
      JSON.parse(value);
      return value;
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Bind values for an upsert, in `tableColumnNames` order. Decodes the
 * payload once; the typed columns and the verbatim payload land in one
 * statement, so they cannot drift.
 */
export function upsertValues(
  table: CompiledTable,
  partition: string,
  row: StoredRow,
  dialect: RelationalDialect,
): unknown[] {
  const values = decodeRow(table.columns, row.payload);
  return [
    partition,
    row.rowId,
    ...table.columns.map((column, index) =>
      toSqlValue(column, values[index] ?? null, dialect),
    ),
    row.serverVersion,
    JSON.stringify(row.scopes),
    row.payload,
  ];
}

function placeholderList(count: number, dialect: RelationalDialect): string {
  if (dialect === 'sqlite') return new Array(count).fill('?').join(',');
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(`$${i}`);
  return out.join(',');
}

/** Upsert statement text (bind with `upsertValues`). */
export function upsertSql(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const names = tableColumnNames(table);
  const quoted = names.map((name) => quoteIdent(name)).join(', ');
  const values = placeholderList(names.length, dialect);
  if (dialect === 'sqlite') {
    // INSERT OR REPLACE keys on the (_sync_partition, _sync_row_id) PK.
    return `INSERT OR REPLACE INTO ${quoteIdent(table.name)} (${quoted}) VALUES (${values})`;
  }
  const updates = names
    .slice(2) // partition + row id are the conflict key
    .map((name) => `${quoteIdent(name)}=EXCLUDED.${quoteIdent(name)}`)
    .join(', ');
  return `INSERT INTO ${quoteIdent(table.name)} (${quoted}) VALUES (${values})
     ON CONFLICT (${quoteIdent(SYNC_PARTITION_COLUMN)}, ${quoteIdent(SYNC_ROW_ID_COLUMN)}) DO UPDATE SET ${updates}`;
}

/**
 * SELECT one stored row. Aliased to the legacy record shape
 * (`row_id`/`server_version`/`scopes`/`payload`) so the existing
 * `toStoredRow` converters keep working. Params: [partition, rowId].
 */
export function selectRowSql(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const p = dialect === 'sqlite' ? ['?', '?'] : ['$1', '$2'];
  return `SELECT ${quoteIdent(SYNC_ROW_ID_COLUMN)} AS row_id, ${quoteIdent(SYNC_VERSION_COLUMN)} AS server_version, ${quoteIdent(SYNC_SCOPES_COLUMN)} AS scopes, ${quoteIdent(SYNC_PAYLOAD_COLUMN)} AS payload FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=${p[0]} AND ${quoteIdent(SYNC_ROW_ID_COLUMN)}=${p[1]}`;
}

/** SELECT a row's version + scope map (admin/blob authz). Params: [partition, rowId]. */
export function selectRowScopesSql(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const p = dialect === 'sqlite' ? ['?', '?'] : ['$1', '$2'];
  return `SELECT ${quoteIdent(SYNC_VERSION_COLUMN)} AS server_version, ${quoteIdent(SYNC_SCOPES_COLUMN)} AS scopes FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=${p[0]} AND ${quoteIdent(SYNC_ROW_ID_COLUMN)}=${p[1]}`;
}

/** DELETE one stored row. Params: [partition, rowId]. */
export function deleteRowSql(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const p = dialect === 'sqlite' ? ['?', '?'] : ['$1', '$2'];
  return `DELETE FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=${p[0]} AND ${quoteIdent(SYNC_ROW_ID_COLUMN)}=${p[1]}`;
}

/**
 * The schema-version marker table gating DDL work (DESIGN "server-side
 * schema migration"): `ensureSchema` compares the stored version and skips
 * all introspection/DDL when it matches — one cheap read per storage
 * instance (relevant for D1's per-request instantiation).
 */
export const SCHEMA_META_DDL_SQLITE = `CREATE TABLE IF NOT EXISTS sync_schema_meta(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL
)`;

export const SCHEMA_META_DDL_POSTGRES = `CREATE TABLE IF NOT EXISTS sync_schema_meta(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version BIGINT NOT NULL
)`;

/**
 * Every DDL statement to bring a database from `existingColumnsByTable`
 * (introspected; a missing key = table absent) to `schema`: CREATE TABLE
 * for absent tables, ADD COLUMN for missing columns, CREATE INDEX for the
 * declared user indexes — exactly the migration subset.
 */
export function schemaDdl(
  schema: CompiledSchema,
  existingColumnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
  dialect: RelationalDialect,
): string[] {
  const out: string[] = [];
  for (const table of schema.tables.values()) {
    const existing = existingColumnsByTable.get(table.name);
    if (existing === undefined) {
      out.push(createTableDdl(table, dialect));
    } else {
      out.push(...addColumnDdl(table, existing, dialect));
    }
    out.push(...createIndexDdl(table));
  }
  return out;
}
