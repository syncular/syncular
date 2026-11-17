import { rollbackAfterError } from './storage-errors';
/**
 * SQLite-image segment generation (SPEC.md §5.3): a complete SQLite
 * database file carrying one range of a table's effective-scope snapshot at
 * the table's scope pin, plus the single-row `_syncular_segment` metadata
 * table. Runtime entries provide the concrete SQLite database.
 *
 * Images are NOT byte-deterministic (§5.3): the content address pins the
 * served bytes, and cross-client dedup comes from the segment store's
 * metadata lookup (`SegmentStore.find`), not from hash convergence.
 */
import { decodeRow, type RowColumn, type RowValue } from '@syncular/core';
import type { CompiledTable } from './schema';
import type { SqliteDatabase } from './sqlite-driver';
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
  /**
   * The image's file-size bound (`ServerLimits.maxImageSegmentBytes`). The
   * builder stops before the row that could pass it; the first row always
   * goes in.
   */
  readonly maxBytes: number;
  /** The range's rows in row order, from its start to the table's end. */
  readonly rowBatches:
    | AsyncIterable<readonly StoredRow[]>
    | Iterable<readonly StoredRow[]>;
}

/**
 * The §5.3 image-builder capability, injected through
 * `SyncServerConfig.sqliteImageBuilder`. Building an image needs
 * a real SQLite engine, which is not available on every runtime. The core
 * takes the builder as an optional capability rather than importing a driver
 * on the pull path. A Bun or Node host passes `buildSqliteImage`; a Workers
 * host omits it and serves matching stored images or the rows lane.
 */
export type SqliteImageBuilder = (
  input: SqliteImageInput,
) => Promise<SqliteImage>;

/** A built image and the number of leading input rows it holds. */
export interface SqliteImage {
  readonly bytes: Uint8Array;
  readonly rowCount: number;
}

/**
 * Populate a §5.3 image database with the leading input rows that fit
 * `maxBytes`. Returns how many rows it consumed.
 */
export async function writeSqliteImage(
  db: SqliteDatabase,
  input: SqliteImageInput,
): Promise<number> {
  const { table, rowBatches } = input;
  const primaryKey = table.columns[table.primaryKeyIndex]?.name;
  const columnDefs = table.columns.map((column) => {
    const notNull = column.nullable ? '' : ' NOT NULL';
    const pk = column.name === primaryKey ? ' PRIMARY KEY' : '';
    return `${quoteIdent(column.name)} ${sqlType(column)}${notNull}${pk}`;
  });
  columnDefs.push(`${quoteIdent(IMAGE_VERSION_COLUMN)} INTEGER NOT NULL`);
  db.exec(`CREATE TABLE ${quoteIdent(table.name)} (${columnDefs.join(', ')})`);
  db.exec(
    `CREATE TABLE ${IMAGE_METADATA_TABLE} (
      format INTEGER NOT NULL, "table" TEXT NOT NULL,
      "schemaVersion" INTEGER NOT NULL, "asOfCommitSeq" INTEGER NOT NULL,
      "scopeDigest" TEXT NOT NULL, "rowCount" INTEGER NOT NULL)`,
  );
  const names = [
    ...table.columns.map((column) => quoteIdent(column.name)),
    quoteIdent(IMAGE_VERSION_COLUMN),
  ];
  const insert = db.query(
    `INSERT INTO ${quoteIdent(table.name)} (${names.join(', ')})
     VALUES (${names.map(() => '?').join(', ')})`,
  );
  const pageSize = db
    .query<{ page_size: number }>('PRAGMA page_size')
    .get()!.page_size;
  const pageCount = db.query<{ page_count: number }>('PRAGMA page_count');
  db.exec('BEGIN');
  try {
    let rowCount = 0;
    // An upper bound of the file size, re-measured when it nears the bound.
    let size = pageCount.get()!.page_count * pageSize;
    fill: for await (const rows of rowBatches) {
      for (const row of rows) {
        // An appended row grows the table and its primary-key index by at
        // most its cell (bounded by the payload plus a 9-byte varint per
        // column, the version and the rowid), overflow rounding and a split
        // per tree level.
        const growth =
          2 * (row.payload.length + 9 * (table.columns.length + 2)) +
          16 * pageSize;
        if (rowCount > 0 && size + growth > input.maxBytes) {
          size = pageCount.get()!.page_count * pageSize;
          if (size + growth > input.maxBytes) break fill;
        }
        const values = decodeRow(table.columns, row.payload);
        insert.run(...values.map(toSql), row.serverVersion);
        size += growth;
        rowCount += 1;
      }
    }
    db.query(
      `INSERT INTO ${IMAGE_METADATA_TABLE} VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      table.name,
      input.schemaVersion,
      input.asOfCommitSeq,
      input.scopeDigest,
      rowCount,
    );

    db.exec('COMMIT');
    return rowCount;
  } catch (error) {
    rollbackAfterError(() => {
      db.exec('ROLLBACK');
    }, error);
  }
}
