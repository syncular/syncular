/**
 * Immutable application-migration history.
 *
 * `syncular.migrations.lock.json` is a version-controlled baseline of every
 * migration that has been accepted so far. Existing entries are immutable;
 * generation may only append newly named migrations. The per-migration schema
 * snapshot exists solely to make checksum drift actionable without retaining
 * SQL text, row data, or filesystem paths in diagnostics.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TypegenError } from './errors';
import type { MigrationInput } from './generate';
import type { IrColumn, IrColumnType } from './ir';
import { applyMigrationSql, type ParsedTable } from './sql';

export const MIGRATION_LOCK_FILENAME = 'syncular.migrations.lock.json';
export const MIGRATION_LOCK_FORMAT_VERSION = 1;

export interface MigrationLockColumn {
  readonly name: string;
  readonly type: IrColumnType;
  readonly nullable: boolean;
  readonly crdtType?: string;
}

export interface MigrationLockTable {
  readonly name: string;
  readonly primaryKey: string;
  readonly columns: readonly MigrationLockColumn[];
}

export interface MigrationLockEntry {
  readonly name: string;
  readonly sha256: string;
  readonly tables: readonly MigrationLockTable[];
}

export interface MigrationLock {
  readonly formatVersion: typeof MIGRATION_LOCK_FORMAT_VERSION;
  readonly migrations: readonly MigrationLockEntry[];
}

function normalizedSql(sql: string): string {
  return sql.replace(/\r\n?/g, '\n');
}

function checksum(sql: string): string {
  return createHash('sha256').update(normalizedSql(sql), 'utf8').digest('hex');
}

function snapshotColumn(column: IrColumn): MigrationLockColumn {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    ...(column.crdtType === undefined ? {} : { crdtType: column.crdtType }),
  };
}

function snapshotTables(
  tables: ReadonlyMap<string, ParsedTable>,
): MigrationLockTable[] {
  return [...tables.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((table) => ({
      name: table.name,
      primaryKey: table.primaryKey,
      columns: table.columns.map(snapshotColumn),
    }));
}

/** Build the exact lock document for a complete migration sequence. */
export function buildMigrationLock(
  migrations: readonly MigrationInput[],
): MigrationLock {
  const tables = new Map<string, ParsedTable>();
  const droppedTables = new Set<string>();
  const entries: MigrationLockEntry[] = [];
  for (const migration of migrations) {
    applyMigrationSql(
      tables,
      migration.sql,
      `${migration.name}/up.sql`,
      droppedTables,
    );
    entries.push({
      name: migration.name,
      sha256: checksum(migration.sql),
      tables: snapshotTables(tables),
    });
  }
  return { formatVersion: MIGRATION_LOCK_FORMAT_VERSION, migrations: entries };
}

/** Fixed-order, byte-deterministic serialization for clean code review. */
export function serializeMigrationLock(lock: MigrationLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failLock(message: string): never {
  throw new TypegenError(MIGRATION_LOCK_FILENAME, message);
}

const COLUMN_TYPES = new Set<IrColumnType>([
  'string',
  'integer',
  'float',
  'boolean',
  'json',
  'bytes',
  'blob_ref',
  'crdt',
]);

function parseColumn(value: unknown, context: string): MigrationLockColumn {
  if (!isRecord(value)) failLock(`${context} must be an object`);
  const { name, type, nullable, crdtType } = value;
  if (typeof name !== 'string' || name.length === 0) {
    failLock(`${context}.name must be a non-empty string`);
  }
  if (typeof type !== 'string' || !COLUMN_TYPES.has(type as IrColumnType)) {
    failLock(`${context}.type is not a supported Syncular column type`);
  }
  if (typeof nullable !== 'boolean') {
    failLock(`${context}.nullable must be boolean`);
  }
  if (crdtType !== undefined && typeof crdtType !== 'string') {
    failLock(`${context}.crdtType must be a string when present`);
  }
  return {
    name,
    type: type as IrColumnType,
    nullable,
    ...(crdtType === undefined ? {} : { crdtType }),
  };
}

function parseTable(value: unknown, context: string): MigrationLockTable {
  if (!isRecord(value)) failLock(`${context} must be an object`);
  const { name, primaryKey, columns } = value;
  if (typeof name !== 'string' || name.length === 0) {
    failLock(`${context}.name must be a non-empty string`);
  }
  if (typeof primaryKey !== 'string' || primaryKey.length === 0) {
    failLock(`${context}.primaryKey must be a non-empty string`);
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    failLock(`${context}.columns must be a non-empty array`);
  }
  return {
    name,
    primaryKey,
    columns: columns.map((column, index) =>
      parseColumn(column, `${context}.columns[${index}]`),
    ),
  };
}

function parseEntry(value: unknown, index: number): MigrationLockEntry {
  const context = `migrations[${index}]`;
  if (!isRecord(value)) failLock(`${context} must be an object`);
  const { name, sha256, tables } = value;
  if (typeof name !== 'string' || name.length === 0) {
    failLock(`${context}.name must be a non-empty string`);
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    failLock(`${context}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!Array.isArray(tables)) failLock(`${context}.tables must be an array`);
  return {
    name,
    sha256,
    tables: tables.map((table, tableIndex) =>
      parseTable(table, `${context}.tables[${tableIndex}]`),
    ),
  };
}

/** Parse and structurally validate a committed lock document. */
export function parseMigrationLock(source: string): MigrationLock {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    failLock('invalid JSON');
  }
  if (!isRecord(raw)) failLock('root must be an object');
  if (raw.formatVersion !== MIGRATION_LOCK_FORMAT_VERSION) {
    failLock(
      `formatVersion must be ${MIGRATION_LOCK_FORMAT_VERSION}, got ${JSON.stringify(raw.formatVersion)}`,
    );
  }
  if (!Array.isArray(raw.migrations) || raw.migrations.length === 0) {
    failLock('migrations must be a non-empty array');
  }
  const migrations = raw.migrations.map(parseEntry);
  const names = new Set<string>();
  for (const migration of migrations) {
    if (names.has(migration.name)) {
      failLock(`migration ${JSON.stringify(migration.name)} appears twice`);
    }
    names.add(migration.name);
  }
  return { formatVersion: MIGRATION_LOCK_FORMAT_VERSION, migrations };
}

/** Read the version-controlled baseline without exposing its absolute path. */
export function readMigrationLock(manifestDir: string): MigrationLock {
  const path = resolve(manifestDir, MIGRATION_LOCK_FILENAME);
  if (!existsSync(path)) {
    failLock(
      'missing — run `syncular migrations baseline --manifest-dir .` once before deployment, then commit the file',
    );
  }
  return parseMigrationLock(readFileSync(path, 'utf8'));
}

function describeColumnDifference(
  tableName: string,
  locked: readonly MigrationLockColumn[],
  current: readonly MigrationLockColumn[],
): string | undefined {
  const length = Math.max(locked.length, current.length);
  for (let index = 0; index < length; index++) {
    const before = locked[index];
    const after = current[index];
    const position = index + 1;
    if (before === undefined && after !== undefined) {
      return `table ${JSON.stringify(tableName)}, column ${position} ${JSON.stringify(after.name)} was added (${after.type}, ${after.nullable ? 'nullable' : 'required'})`;
    }
    if (before !== undefined && after === undefined) {
      return `table ${JSON.stringify(tableName)}, column ${position} ${JSON.stringify(before.name)} was removed`;
    }
    if (before === undefined || after === undefined) continue;
    if (before.name !== after.name) {
      const oldStillPresent = current
        .slice(index + 1)
        .some((column) => column.name === before.name);
      const newWasPresent = locked
        .slice(index + 1)
        .some((column) => column.name === after.name);
      const action = oldStillPresent
        ? `${JSON.stringify(after.name)} was inserted before locked ${JSON.stringify(before.name)}`
        : newWasPresent
          ? `locked ${JSON.stringify(before.name)} was removed or reordered before ${JSON.stringify(after.name)}`
          : `locked ${JSON.stringify(before.name)} became ${JSON.stringify(after.name)}`;
      return `table ${JSON.stringify(tableName)}, column ${position}: ${action}`;
    }
    if (before.type !== after.type) {
      return `table ${JSON.stringify(tableName)}, column ${JSON.stringify(before.name)} changed type from ${before.type} to ${after.type}`;
    }
    if (before.nullable !== after.nullable) {
      return `table ${JSON.stringify(tableName)}, column ${JSON.stringify(before.name)} changed nullability from ${before.nullable ? 'nullable' : 'required'} to ${after.nullable ? 'nullable' : 'required'}`;
    }
    if (before.crdtType !== after.crdtType) {
      return `table ${JSON.stringify(tableName)}, column ${JSON.stringify(before.name)} changed CRDT type`;
    }
  }
  return undefined;
}

function firstSchemaDifference(
  locked: MigrationLockEntry,
  current: MigrationLockEntry,
): string {
  const length = Math.max(locked.tables.length, current.tables.length);
  for (let index = 0; index < length; index++) {
    const before = locked.tables[index];
    const after = current.tables[index];
    if (before === undefined && after !== undefined) {
      return `table ${JSON.stringify(after.name)} was added`;
    }
    if (before !== undefined && after === undefined) {
      return `table ${JSON.stringify(before.name)} was removed`;
    }
    if (before === undefined || after === undefined) continue;
    if (before.name !== after.name) {
      return `locked table ${JSON.stringify(before.name)} became or moved behind ${JSON.stringify(after.name)}`;
    }
    if (before.primaryKey !== after.primaryKey) {
      return `table ${JSON.stringify(before.name)} changed primary key from ${JSON.stringify(before.primaryKey)} to ${JSON.stringify(after.primaryKey)}`;
    }
    const column = describeColumnDifference(
      before.name,
      before.columns,
      after.columns,
    );
    if (column !== undefined) return column;
  }
  return 'schema shape is unchanged; SQL text, defaults, comments, indexes, or another non-column statement changed';
}

const REPAIR_HINT =
  'deployed migrations are immutable; restore the locked migration and append a new migration (added columns must be nullable)';

/**
 * Validate the committed history as an exact prefix of the current sequence.
 * New migrations may be appended; existing names and bytes may never change.
 */
export function validateMigrationLock(
  locked: MigrationLock,
  current: MigrationLock,
): void {
  for (let index = 0; index < locked.migrations.length; index++) {
    const before = locked.migrations[index] as MigrationLockEntry;
    const after = current.migrations[index];
    if (after === undefined) {
      failLock(
        `history drift at migration ${JSON.stringify(before.name)}: the locked migration is missing; ${REPAIR_HINT}`,
      );
    }
    if (before.name !== after.name) {
      failLock(
        `history drift at position ${index + 1}: locked ${JSON.stringify(before.name)} but found ${JSON.stringify(after.name)}; migrations cannot be removed, renamed, or reordered; ${REPAIR_HINT}`,
      );
    }
    if (before.sha256 !== after.sha256) {
      failLock(
        `history drift in migration ${JSON.stringify(before.name)}: checksum changed; first schema difference: ${firstSchemaDifference(before, after)}; ${REPAIR_HINT}`,
      );
    }
  }
}
