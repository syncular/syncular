/**
 * Immutable application-migration history.
 *
 * `syncular.migrations.lock.json` is a version-controlled baseline of every
 * migration that has been accepted so far. Existing entries are immutable;
 * generation may only append newly named migrations. Format 2 stores one
 * canonical head-schema snapshot for actionable diagnostics instead of a
 * cumulative schema copy after every migration. Format 1 remains readable and
 * writable until an explicit `migrations upgrade-lock` command replaces it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TypegenError } from './errors';
import type { MigrationInput } from './generate';
import type { IrColumn, IrColumnType } from './ir';
import { applyMigrationSql, type ParsedTable } from './sql';

export const MIGRATION_LOCK_FILENAME = 'syncular.migrations.lock.json';
export const MIGRATION_LOCK_FORMAT_VERSION = 2;
export const LEGACY_MIGRATION_LOCK_FORMAT_VERSION = 1;

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
}

export interface LegacyMigrationLockEntry extends MigrationLockEntry {
  readonly tables: readonly MigrationLockTable[];
}

export interface LegacyMigrationLock {
  readonly formatVersion: typeof LEGACY_MIGRATION_LOCK_FORMAT_VERSION;
  readonly migrations: readonly LegacyMigrationLockEntry[];
}

export interface MigrationLockV2 {
  readonly formatVersion: typeof MIGRATION_LOCK_FORMAT_VERSION;
  readonly migrations: readonly MigrationLockEntry[];
  readonly head: {
    readonly tables: readonly MigrationLockTable[];
  };
}

export type MigrationLock = LegacyMigrationLock | MigrationLockV2;

interface CurrentMigrationHistory {
  readonly migrations: readonly LegacyMigrationLockEntry[];
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
  return (
    [...tables.values()]
      // Code-point order keeps the serialization byte-identical across locales.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((table) => ({
        name: table.name,
        primaryKey: table.primaryKey,
        columns: table.columns.map(snapshotColumn),
      }))
  );
}

/** The names of every migration a committed lock has made immutable. */
export function lockedMigrationNames(lock: MigrationLock): ReadonlySet<string> {
  return new Set(lock.migrations.map((migration) => migration.name));
}

/** Replay a complete migration sequence with ephemeral diagnostic snapshots.
 * Migrations named in `lockedNames` replay as deployed history; rules that
 * only appended migrations must satisfy are skipped for them. */
function buildMigrationHistory(
  migrations: readonly MigrationInput[],
  lockedNames?: ReadonlySet<string>,
): CurrentMigrationHistory {
  const tables = new Map<string, ParsedTable>();
  const droppedTables = new Set<string>();
  const entries: LegacyMigrationLockEntry[] = [];
  for (const migration of migrations) {
    applyMigrationSql(
      tables,
      migration.sql,
      `${migration.name}/up.sql`,
      droppedTables,
      { lockedHistory: lockedNames?.has(migration.name) === true },
    );
    entries.push({
      name: migration.name,
      sha256: checksum(migration.sql),
      tables: snapshotTables(tables),
    });
  }
  return { migrations: entries };
}

function lockFromHistory(
  history: CurrentMigrationHistory,
  formatVersion:
    | typeof LEGACY_MIGRATION_LOCK_FORMAT_VERSION
    | typeof MIGRATION_LOCK_FORMAT_VERSION,
): MigrationLock {
  if (history.migrations.length === 0) {
    failLock('cannot lock an empty migration history');
  }
  if (formatVersion === LEGACY_MIGRATION_LOCK_FORMAT_VERSION) {
    return {
      formatVersion: LEGACY_MIGRATION_LOCK_FORMAT_VERSION,
      migrations: history.migrations,
    };
  }
  const head = history.migrations.at(-1) as LegacyMigrationLockEntry;
  return {
    formatVersion: MIGRATION_LOCK_FORMAT_VERSION,
    migrations: history.migrations.map(({ name, sha256 }) => ({
      name,
      sha256,
    })),
    head: { tables: head.tables },
  };
}

/** Build a deterministic lock document for a complete migration sequence. */
export function buildMigrationLock(
  migrations: readonly MigrationInput[],
  formatVersion:
    | typeof LEGACY_MIGRATION_LOCK_FORMAT_VERSION
    | typeof MIGRATION_LOCK_FORMAT_VERSION = MIGRATION_LOCK_FORMAT_VERSION,
  lockedNames?: ReadonlySet<string>,
): MigrationLock {
  return lockFromHistory(
    buildMigrationHistory(migrations, lockedNames),
    formatVersion,
  );
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
  const { name, sha256 } = value;
  if (typeof name !== 'string' || name.length === 0) {
    failLock(`${context}.name must be a non-empty string`);
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    failLock(`${context}.sha256 must be a lowercase SHA-256 digest`);
  }
  return { name, sha256 };
}

function parseLegacyEntry(
  value: unknown,
  index: number,
): LegacyMigrationLockEntry {
  const context = `migrations[${index}]`;
  const entry = parseEntry(value, index);
  if (!isRecord(value)) failLock(`${context} must be an object`);
  const { tables } = value;
  if (!Array.isArray(tables)) failLock(`${context}.tables must be an array`);
  return {
    ...entry,
    tables: tables.map((table, tableIndex) =>
      parseTable(table, `${context}.tables[${tableIndex}]`),
    ),
  };
}

function parseHead(value: unknown): MigrationLockV2['head'] {
  if (!isRecord(value)) failLock('head must be an object');
  if (!Array.isArray(value.tables)) failLock('head.tables must be an array');
  return {
    tables: value.tables.map((table, index) =>
      parseTable(table, `head.tables[${index}]`),
    ),
  };
}

function assertUniqueMigrationNames(
  migrations: readonly MigrationLockEntry[],
): void {
  const names = new Set<string>();
  for (const migration of migrations) {
    if (names.has(migration.name)) {
      failLock(`migration ${JSON.stringify(migration.name)} appears twice`);
    }
    names.add(migration.name);
  }
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
  if (
    raw.formatVersion !== LEGACY_MIGRATION_LOCK_FORMAT_VERSION &&
    raw.formatVersion !== MIGRATION_LOCK_FORMAT_VERSION
  ) {
    failLock(
      `formatVersion must be ${LEGACY_MIGRATION_LOCK_FORMAT_VERSION} or ${MIGRATION_LOCK_FORMAT_VERSION}, got ${JSON.stringify(raw.formatVersion)}`,
    );
  }
  if (!Array.isArray(raw.migrations) || raw.migrations.length === 0) {
    failLock('migrations must be a non-empty array');
  }
  if (raw.formatVersion === LEGACY_MIGRATION_LOCK_FORMAT_VERSION) {
    const migrations = raw.migrations.map(parseLegacyEntry);
    assertUniqueMigrationNames(migrations);
    return {
      formatVersion: LEGACY_MIGRATION_LOCK_FORMAT_VERSION,
      migrations,
    };
  }
  const migrations = raw.migrations.map(parseEntry);
  assertUniqueMigrationNames(migrations);
  return {
    formatVersion: MIGRATION_LOCK_FORMAT_VERSION,
    migrations,
    head: parseHead(raw.head),
  };
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
  locked: LegacyMigrationLockEntry,
  current: LegacyMigrationLockEntry,
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
function validateMigrationHistory(
  locked: MigrationLock,
  current: CurrentMigrationHistory,
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
      const diagnosticBefore: LegacyMigrationLockEntry =
        locked.formatVersion === LEGACY_MIGRATION_LOCK_FORMAT_VERSION
          ? (locked.migrations[index] as LegacyMigrationLockEntry)
          : {
              ...before,
              tables: locked.head.tables,
            };
      // Format 2 keeps one schema snapshot after the complete locked prefix.
      // Compare it with the current schema at that same boundary, excluding
      // valid newly appended migrations from the diagnostic.
      const diagnosticAfter =
        locked.formatVersion === LEGACY_MIGRATION_LOCK_FORMAT_VERSION
          ? after
          : (current.migrations[locked.migrations.length - 1] ?? after);
      failLock(
        `history drift in migration ${JSON.stringify(before.name)}: checksum changed; first schema difference: ${firstSchemaDifference(diagnosticBefore, diagnosticAfter)}; ${REPAIR_HINT}`,
      );
    }
  }
}

/**
 * Validate a committed lock against migration inputs and build its exact next
 * document. Ordinary generation preserves the committed format; upgrading a
 * version-1 lock is always an explicit command.
 */
export function updateMigrationLock(
  locked: MigrationLock,
  migrations: readonly MigrationInput[],
): MigrationLock {
  const current = buildMigrationHistory(
    migrations,
    lockedMigrationNames(locked),
  );
  validateMigrationHistory(locked, current);
  return lockFromHistory(current, locked.formatVersion);
}

/** Validate without changing the committed lock format. */
export function validateMigrationLock(
  locked: MigrationLock,
  migrations: readonly MigrationInput[],
): void {
  validateMigrationHistory(
    locked,
    buildMigrationHistory(migrations, lockedMigrationNames(locked)),
  );
}
