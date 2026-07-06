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
import {
  decodeRow,
  encodeRow,
  type RowColumn,
  type RowValue,
} from '@syncular/core';
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
 * partition, row id, app columns (schema order; only when the table is
 * materialized), version, scopes, payload.
 */
export function tableColumnNames(table: CompiledTable): string[] {
  return [
    SYNC_PARTITION_COLUMN,
    SYNC_ROW_ID_COLUMN,
    ...(table.materialize ? table.columns.map((column) => column.name) : []),
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
    ...(table.materialize
      ? table.columns.map((column) => {
          const notNull = column.nullable ? '' : ' NOT NULL';
          return `${quoteIdent(column.name)} ${columnSqlType(column, dialect)}${notNull}`;
        })
      : []),
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
  if (!table.materialize) return [];
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
  // User indexes name app columns — nothing to index without the projection.
  if (!table.materialize) return [];
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
  // A non-materialized table skips the decode entirely — the upsert is a
  // five-column meta write (the old blob-store cost).
  const projection = table.materialize
    ? decodeRow(table.columns, row.payload)
    : undefined;
  return [
    partition,
    row.rowId,
    ...(projection !== undefined
      ? table.columns.map((column, index) =>
          toSqlValue(column, projection[index] ?? null, dialect),
        )
      : []),
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

/**
 * One-round-trip page scan for `scanRows`: candidates from the inverted
 * scope index (ordered + LIMITed at the covering `sync_row_scopes` PK —
 * exactly the old candidate query, so the index-first posture is unchanged)
 * LEFT JOINed to the row table, so a whole page arrives in ONE statement
 * instead of one lookup per candidate. That per-candidate lookup was the
 * cold-bootstrap hot path: a 100k-row snapshot on Postgres paid ~100k
 * network round-trips (~10 s at 0.1 ms each) before this join.
 *
 * LEFT JOIN (not INNER): a candidate whose row vanished (index entry
 * without a row) must still reach the caller — its `row_id` advances the
 * keyset cursor — so it comes back with NULL payload rather than
 * disappearing from the page.
 *
 * Bind order:
 *   - postgres: [partition, tbl, var, ...values, afterRowId, limit]
 *     (the join reuses `$1` for the partition);
 *   - sqlite:   [partition, tbl, var, ...values, afterRowId, limit,
 *     partition] (positional `?` — the partition binds again for the join).
 */
export function scanRowPageSql(
  table: CompiledTable,
  valueCount: number,
  dialect: RelationalDialect,
): string {
  const p = (n: number) => (dialect === 'sqlite' ? '?' : `$${n}`);
  const values: string[] = [];
  for (let i = 0; i < valueCount; i++) values.push(p(4 + i));
  const after = p(4 + valueCount);
  const limit = p(5 + valueCount);
  const joinPartition = dialect === 'sqlite' ? '?' : '$1';
  return `SELECT c.row_id AS row_id, r.${quoteIdent(SYNC_VERSION_COLUMN)} AS server_version, r.${quoteIdent(SYNC_SCOPES_COLUMN)} AS scopes, r.${quoteIdent(SYNC_PAYLOAD_COLUMN)} AS payload
     FROM (SELECT DISTINCT row_id FROM sync_row_scopes
       WHERE partition=${p(1)} AND tbl=${p(2)} AND var=${p(3)} AND value IN (${values.join(',')})
         AND row_id>${after}
       ORDER BY row_id LIMIT ${limit}) c
     LEFT JOIN ${quoteIdent(table.name)} r
       ON r.${quoteIdent(SYNC_PARTITION_COLUMN)}=${joinPartition} AND r.${quoteIdent(SYNC_ROW_ID_COLUMN)}=c.row_id
     ORDER BY c.row_id`;
}

/**
 * One-round-trip page read for `readCommitWindow` (sync_* tables only; it
 * lives here beside `scanRowPageSql` because it is the same join-the-index
 * posture, dialect-parameterized the same way): candidates from the inverted
 * change-scope index (ordered + LIMITed at the covering `sync_change_scopes`
 * PK — exactly the old candidate query, so the index-first invariant of
 * `CommitWindowQuery` is unchanged) LEFT JOINed to the commit metadata and
 * to the commit's changes for the table, so a whole window page arrives in
 * ONE statement instead of 1 + 2×candidates round trips. This is the
 * incremental-pull hot path — it runs on every sync round; before the join a
 * 500-candidate catch-up window on Postgres paid ~1000 network round trips.
 *
 * LEFT JOIN (not INNER): a candidate whose commit vanished (scope-index
 * entry without a commit/changes row) must still reach the caller — its
 * `commit_seq` advances the window cursor — so it comes back with NULL
 * meta/change columns rather than disappearing from the page.
 *
 * Rows arrive ordered (commit_seq, idx): oldest-first commits, each commit's
 * change rows consecutive in `idx` order — the caller groups consecutive
 * rows and verifies the full multi-variable scope match in JS.
 *
 * Bind order:
 *   - postgres: [partition, tbl, var, ...values, afterSeq, throughSeq,
 *     limit] (the joins reuse `$1`/`$2`);
 *   - sqlite:   [partition, tbl, var, ...values, afterSeq, throughSeq,
 *     limit, partition, partition, tbl] (positional `?` — partition/tbl bind
 *     again for the joins).
 */
export function commitWindowPageSql(
  valueCount: number,
  dialect: RelationalDialect,
): string {
  const p = (n: number) => (dialect === 'sqlite' ? '?' : `$${n}`);
  const values: string[] = [];
  for (let i = 0; i < valueCount; i++) values.push(p(4 + i));
  const after = p(4 + valueCount);
  const through = p(5 + valueCount);
  const limit = p(6 + valueCount);
  const joinPartition = dialect === 'sqlite' ? '?' : '$1';
  const joinTbl = dialect === 'sqlite' ? '?' : '$2';
  return `SELECT c.commit_seq AS commit_seq, m.actor_id AS actor_id, m.created_at_ms AS created_at_ms,
       ch.tbl AS tbl, ch.row_id AS row_id, ch.op AS op, ch.row_version AS row_version, ch.scopes AS scopes, ch.payload AS payload
     FROM (SELECT DISTINCT commit_seq FROM sync_change_scopes
       WHERE partition=${p(1)} AND tbl=${p(2)} AND var=${p(3)} AND value IN (${values.join(',')})
         AND commit_seq>${after} AND commit_seq<=${through}
       ORDER BY commit_seq LIMIT ${limit}) c
     LEFT JOIN sync_commits m
       ON m.partition=${joinPartition} AND m.commit_seq=c.commit_seq
     LEFT JOIN sync_changes ch
       ON ch.partition=${joinPartition} AND ch.commit_seq=c.commit_seq AND ch.tbl=${joinTbl}
     ORDER BY c.commit_seq, ch.idx`;
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
 *
 * `layouts` persists each table's column layout (name/type/nullable, the
 * exact inputs the row codec's byte layout depends on) as of the LAST
 * applied schema version. The codec is strict — a payload only decodes
 * under the column list it was encoded with — so a version bump MUST
 * re-encode stored payloads (append trailing NULLs for added columns);
 * decoding the old bytes requires the old layout, and this column is where
 * it lives.
 */
export const SCHEMA_META_DDL_SQLITE = `CREATE TABLE IF NOT EXISTS sync_schema_meta(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  layouts TEXT NOT NULL DEFAULT '{}'
)`;

export const SCHEMA_META_DDL_POSTGRES = `CREATE TABLE IF NOT EXISTS sync_schema_meta(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version BIGINT NOT NULL,
  layouts TEXT NOT NULL DEFAULT '{}'
)`;

// -- column layouts + payload migration (version bumps) ----------------------

/** The codec-relevant subset of a column, persisted per applied version. */
export interface StoredColumnLayout {
  readonly name: string;
  readonly type: RowColumn['type'];
  readonly nullable: boolean;
}

export type StoredLayouts = Record<string, readonly StoredColumnLayout[]>;

/** The layouts JSON persisted alongside the schema version marker. */
export function layoutsOf(schema: CompiledSchema): string {
  const out: Record<string, StoredColumnLayout[]> = {};
  for (const table of schema.tables.values()) {
    out[table.name] = table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
    }));
  }
  return JSON.stringify(out);
}

export function parseLayouts(json: string | null | undefined): StoredLayouts {
  if (json === null || json === undefined || json.length === 0) return {};
  return JSON.parse(json) as StoredLayouts;
}

/**
 * Enforce the migration subset on a table's column list: the old layout
 * must be an exact prefix (same name, type, nullability) of the new one,
 * and appended columns must be nullable (there is no default to backfill).
 * Returns `true` iff columns were appended.
 */
export function assertAppendOnlyMigration(
  tableName: string,
  oldLayout: readonly StoredColumnLayout[],
  table: CompiledTable,
): boolean {
  if (oldLayout.length > table.columns.length) {
    throw new Error(
      `table ${JSON.stringify(tableName)}: the schema removed columns — only CREATE TABLE / ADD COLUMN / CREATE INDEX migrations are supported`,
    );
  }
  for (let i = 0; i < oldLayout.length; i++) {
    const before = oldLayout[i];
    const after = table.columns[i];
    if (
      before === undefined ||
      after === undefined ||
      before.name !== after.name ||
      before.type !== after.type ||
      before.nullable !== after.nullable
    ) {
      throw new Error(
        `table ${JSON.stringify(tableName)}: column ${i} changed (${JSON.stringify(before)} → ${JSON.stringify({ name: after?.name, type: after?.type, nullable: after?.nullable })}) — only appending nullable columns is supported`,
      );
    }
  }
  for (let i = oldLayout.length; i < table.columns.length; i++) {
    const added = table.columns[i];
    if (added !== undefined && !added.nullable) {
      throw new Error(
        `table ${JSON.stringify(tableName)}: added column ${JSON.stringify(added.name)} must be nullable — existing rows have no value to backfill`,
      );
    }
  }
  return oldLayout.length < table.columns.length;
}

/**
 * Re-encode an old-layout payload under the current columns: decode with
 * the layout it was written under, append NULLs for the added columns,
 * encode with the current column list. The write path (§3.4 scope-strip,
 * CRDT merge, conflict serverRow) and the bootstrap serve path both decode
 * stored payloads under the CURRENT schema, so this migration is a
 * correctness requirement of the version bump, not an optimization.
 */
export function migratePayload(
  oldLayout: readonly StoredColumnLayout[],
  table: CompiledTable,
  payload: Uint8Array,
): Uint8Array {
  const values = decodeRow(oldLayout as readonly RowColumn[], payload);
  while (values.length < table.columns.length) values.push(null);
  return encodeRow(table.columns, values);
}

/**
 * Keyset-paged scan of a row table for the migration rewrite.
 * Params: [afterPartition, afterRowId, limit].
 */
export function selectRowsForRewriteSql(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const p = dialect === 'sqlite' ? ['?', '?', '?'] : ['$1', '$2', '$3'];
  return `SELECT ${quoteIdent(SYNC_PARTITION_COLUMN)} AS partition, ${quoteIdent(SYNC_ROW_ID_COLUMN)} AS row_id, ${quoteIdent(SYNC_PAYLOAD_COLUMN)} AS payload
     FROM ${quoteIdent(table.name)}
     WHERE (${quoteIdent(SYNC_PARTITION_COLUMN)}, ${quoteIdent(SYNC_ROW_ID_COLUMN)}) > (${p[0]}, ${p[1]})
     ORDER BY ${quoteIdent(SYNC_PARTITION_COLUMN)}, ${quoteIdent(SYNC_ROW_ID_COLUMN)}
     LIMIT ${p[2]}`;
}

/**
 * Rewrite one row during a migration: refresh the projection columns (when
 * materialized) and the payload. Bind with `rewriteValues`.
 */
export function rewriteRowSql(
  table: CompiledTable,
  dialect: RelationalDialect,
): string {
  const sets: string[] = [];
  let i = 1;
  if (table.materialize) {
    for (const column of table.columns) {
      sets.push(
        `${quoteIdent(column.name)}=${dialect === 'sqlite' ? '?' : `$${i}`}`,
      );
      i++;
    }
  }
  sets.push(
    `${quoteIdent(SYNC_PAYLOAD_COLUMN)}=${dialect === 'sqlite' ? '?' : `$${i}`}`,
  );
  i++;
  const wherePartition = dialect === 'sqlite' ? '?' : `$${i}`;
  const whereRowId = dialect === 'sqlite' ? '?' : `$${i + 1}`;
  return `UPDATE ${quoteIdent(table.name)} SET ${sets.join(', ')} WHERE ${quoteIdent(SYNC_PARTITION_COLUMN)}=${wherePartition} AND ${quoteIdent(SYNC_ROW_ID_COLUMN)}=${whereRowId}`;
}

/** Bind values for `rewriteRowSql` from the (already migrated) payload. */
export function rewriteValues(
  table: CompiledTable,
  partition: string,
  rowId: string,
  payload: Uint8Array,
  dialect: RelationalDialect,
): unknown[] {
  const out: unknown[] = [];
  if (table.materialize) {
    const values = decodeRow(table.columns, payload);
    for (let i = 0; i < table.columns.length; i++) {
      const column = table.columns[i];
      if (column === undefined) continue;
      out.push(toSqlValue(column, values[i] ?? null, dialect));
    }
  }
  out.push(payload, partition, rowId);
  return out;
}

/**
 * What the migration rewrite phase must do for one table, derived from the
 * persisted layouts + the physical columns present before this run.
 *
 * - `migrate`: the layout gained columns — every stored payload re-encodes
 *   under the new column list (correctness; see `migratePayload`).
 * - `backfill`: the table just gained physical projection columns whose
 *   values exist in stored payloads (materialization flipped on) — the
 *   projection refreshes from the payload, no re-encode.
 */
export function rewritePlan(
  table: CompiledTable,
  oldLayout: readonly StoredColumnLayout[] | undefined,
  physicalColumnsBefore: ReadonlySet<string> | undefined,
): { migrate: boolean; backfill: boolean } {
  if (oldLayout === undefined || physicalColumnsBefore === undefined) {
    // Fresh table (or a pre-layout database, which cannot be reasoned
    // about): nothing stored to rewrite.
    return { migrate: false, backfill: false };
  }
  const migrate = assertAppendOnlyMigration(table.name, oldLayout, table);
  const backfill =
    table.materialize &&
    table.columns.some(
      (column, index) =>
        index < oldLayout.length && // value exists in old payloads
        !physicalColumnsBefore.has(column.name), // column was just added
    );
  return { migrate, backfill };
}

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
