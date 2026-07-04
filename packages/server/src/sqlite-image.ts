/**
 * SQLite-image segment generation (SPEC.md §5.3): a complete SQLite
 * database file carrying one table's whole effective-scope snapshot at
 * the bootstrap pin, plus the single-row `_syncular_segment` metadata
 * table. Built in memory on bun:sqlite — dependency-free.
 *
 * Images are NOT byte-deterministic (§5.3): the content address pins the
 * served bytes, and cross-client dedup comes from the segment store's
 * metadata lookup (`SegmentStore.find`), not from hash convergence.
 */
import { Database } from 'bun:sqlite';
import { decodeRow, type RowColumn, type RowValue } from '@syncular-v2/core';
import type { CompiledTable } from './schema';
import type { StoredRow } from './storage';

/** The §5.6 version column as it appears inside a sqlite image (§5.3). */
export const IMAGE_VERSION_COLUMN = '_syncular_version';

/** The §5.3 metadata table name. */
export const IMAGE_METADATA_TABLE = '_syncular_segment';

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** §5.3 column type affinities (string/json/blob_ref TEXT, boolean INTEGER, …). */
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
      // §5.10: a crdt column's opaque bytes ride the BLOB affinity, like
      // bytes.
      return 'BLOB';
    default:
      throw new Error(`unsupported column type: ${String(column.type)}`);
  }
}

/** §5.3 cell encodings: boolean as 0/1, everything else its natural type. */
function toSql(value: RowValue): string | number | bigint | Uint8Array | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export interface SqliteImageInput {
  readonly table: CompiledTable;
  readonly schemaVersion: number;
  readonly asOfCommitSeq: number;
  readonly scopeDigest: string;
  readonly rows: readonly StoredRow[];
}

/**
 * The §5.3 image-builder capability, injected through
 * `SyncServerConfig.sqliteImageBuilder` (TODO §4.2). Building an image needs
 * a real SQLite engine (`bun:sqlite` here), which is not available on every
 * runtime — Cloudflare Workers has none. So the core takes the builder as an
 * optional capability rather than importing `bun:sqlite` on the pull path:
 * a Bun/Node host passes `buildSqliteImage`; a Workers host omits it and the
 * pull serves the rows lane (§5.3 clients advertise sqlite as an *accept*,
 * never a requirement — the host chooses the served format from what it can
 * produce; this is a support floor, not a fallback).
 */
export type SqliteImageBuilder = (input: SqliteImageInput) => Uint8Array;

/** Build the §5.3 image bytes for a whole-table snapshot. */
export const buildSqliteImage: SqliteImageBuilder = (input) => {
  const { table, rows } = input;
  const primaryKey = table.columns[table.primaryKeyIndex]?.name;
  const db = new Database(':memory:');
  try {
    const columnDefs = table.columns.map((column) => {
      const notNull = column.nullable ? '' : ' NOT NULL';
      const pk = column.name === primaryKey ? ' PRIMARY KEY' : '';
      return `${quoteIdent(column.name)} ${sqlType(column)}${notNull}${pk}`;
    });
    columnDefs.push(`${quoteIdent(IMAGE_VERSION_COLUMN)} INTEGER NOT NULL`);
    db.exec(
      `CREATE TABLE ${quoteIdent(table.name)} (${columnDefs.join(', ')})`,
    );
    db.exec(
      `CREATE TABLE ${IMAGE_METADATA_TABLE} (
        format INTEGER NOT NULL, "table" TEXT NOT NULL,
        "schemaVersion" INTEGER NOT NULL, "asOfCommitSeq" INTEGER NOT NULL,
        "scopeDigest" TEXT NOT NULL, "rowCount" INTEGER NOT NULL)`,
    );
    db.query(
      `INSERT INTO ${IMAGE_METADATA_TABLE} VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      table.name,
      input.schemaVersion,
      input.asOfCommitSeq,
      input.scopeDigest,
      rows.length,
    );
    const names = [
      ...table.columns.map((column) => quoteIdent(column.name)),
      quoteIdent(IMAGE_VERSION_COLUMN),
    ];
    const insert = db.query(
      `INSERT INTO ${quoteIdent(table.name)} (${names.join(', ')})
       VALUES (${names.map(() => '?').join(', ')})`,
    );
    db.exec('BEGIN');
    for (const row of rows) {
      const values = decodeRow(table.columns, row.payload);
      insert.run(...values.map(toSql), row.serverVersion);
    }
    db.exec('COMMIT');
    return new Uint8Array(db.serialize());
  } finally {
    db.close();
  }
};
