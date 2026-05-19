import { Database } from 'bun:sqlite';
import type { BinarySnapshotColumn } from '@syncular/core';
import {
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
} from '@syncular/core';
import type { ScopedSnapshotSqliteArtifactEncoder } from '../snapshot-artifacts';

export interface BunSqliteSnapshotArtifactEncoderOptions {
  withoutRowid?: boolean;
}

function quoteSqliteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes('\0')) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqliteColumnType(column: BinarySnapshotColumn): string {
  switch (column.type) {
    case 'integer':
    case 'boolean':
      return 'integer';
    case 'float':
      return 'real';
    case 'bytes':
      return 'blob';
    case 'json':
    case 'string':
      return 'text';
  }
}

function sqliteValueForColumn(
  column: BinarySnapshotColumn,
  row: Record<string, unknown>
): unknown {
  const value = row[column.name];
  if (value == null) return null;
  switch (column.type) {
    case 'boolean':
      return value === true ? 1 : 0;
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'bytes':
      if (value instanceof Uint8Array) return value;
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      return value;
    case 'integer':
    case 'float':
    case 'string':
      return value;
  }
}

export function encodeBunSqliteSnapshotArtifact(args: {
  table: string;
  columns: readonly BinarySnapshotColumn[];
  rows: readonly Record<string, unknown>[];
  options?: BunSqliteSnapshotArtifactEncoderOptions;
}): Uint8Array {
  if (args.columns.length === 0) {
    throw new Error(
      `Cannot encode SQLite snapshot artifact for ${args.table}: no columns`
    );
  }

  const db = new Database(':memory:');
  try {
    const table = quoteSqliteIdentifier(args.table);
    const columnsSql = args.columns
      .map(
        (column) =>
          `${quoteSqliteIdentifier(column.name)} ${sqliteColumnType(column)}`
      )
      .join(', ');
    db.exec(
      `create table ${table} (${columnsSql})${args.options?.withoutRowid ? ' without rowid' : ''}`
    );

    if (args.rows.length > 0) {
      const placeholders = args.columns.map(() => '?').join(', ');
      const columnNames = args.columns
        .map((column) => quoteSqliteIdentifier(column.name))
        .join(', ');
      const insert = db.prepare(
        `insert into ${table} (${columnNames}) values (${placeholders})`
      );
      db.transaction((rows: readonly Record<string, unknown>[]) => {
        for (const row of rows) {
          const values = args.columns.map((column) =>
            sqliteValueForColumn(column, row)
          ) as Parameters<typeof insert.run>;
          insert.run(...values);
        }
      })(args.rows);
    }

    const bytes = (db as unknown as { serialize(): Uint8Array }).serialize();
    return new Uint8Array(bytes);
  } finally {
    db.close();
  }
}

export function createBunSqliteSnapshotArtifactEncoder(
  options: BunSqliteSnapshotArtifactEncoderOptions = {}
): ScopedSnapshotSqliteArtifactEncoder {
  return {
    artifactKind: SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
    compression: SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
    encode: ({ table, columns, rows }) =>
      encodeBunSqliteSnapshotArtifact({ table, columns, rows, options }),
  };
}
