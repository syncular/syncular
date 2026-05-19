import { Database } from 'bun:sqlite';
import type { BinarySnapshotColumn } from '@syncular/core';
import {
  gzipBytes,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
} from '@syncular/core';
import type { ScopedSnapshotSqliteArtifactEncoder } from '../snapshot-artifacts';

export interface BunSqliteSnapshotArtifactEncoderOptions {
  withoutRowid?: boolean;
  gzipLevel?: number;
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
      if (typeof value === 'bigint') return safeSqliteInteger(value);
      if (typeof value === 'string' && /^-?\d+$/.test(value))
        return safeSqliteInteger(BigInt(value));
      return value;
    case 'float':
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    case 'string':
      if (value instanceof Date) return value.toISOString();
      return value;
  }
}

function safeSqliteInteger(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(
      `Cannot encode SQLite snapshot artifact integer outside JavaScript safe range: ${value}`
    );
  }
  return Number(value);
}

export function encodeBunSqliteSnapshotArtifact(args: {
  table: string;
  primaryKeyColumn?: string;
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
    const canUseWithoutRowid =
      args.options?.withoutRowid !== false &&
      args.primaryKeyColumn != null &&
      args.columns.some((column) => column.name === args.primaryKeyColumn);
    if (args.options?.withoutRowid === true && !canUseWithoutRowid) {
      throw new Error(
        `Cannot encode SQLite snapshot artifact for ${args.table} without rowid: primary key column is missing from snapshot columns`
      );
    }
    const columnsSql = args.columns
      .map((column) => {
        const primaryKey =
          canUseWithoutRowid && column.name === args.primaryKeyColumn
            ? ' primary key'
            : '';
        return `${quoteSqliteIdentifier(column.name)} ${sqliteColumnType(column)}${primaryKey}`;
      })
      .join(', ');
    db.exec(
      `create table ${table} (${columnsSql})${canUseWithoutRowid ? ' without rowid' : ''}`
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
    compression: SYNC_SNAPSHOT_CHUNK_COMPRESSION,
    encode: async ({ table, primaryKeyColumn, columns, rows }) => {
      const raw = encodeBunSqliteSnapshotArtifact({
        table,
        primaryKeyColumn,
        columns,
        rows,
        options,
      });
      return gzipBytes(raw, { level: options.gzipLevel ?? 6 });
    },
  };
}
