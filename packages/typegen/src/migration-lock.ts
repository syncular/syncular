/**
 * Immutable application-migration history.
 *
 * `syncular.migrations.lock.json` is a version-controlled baseline of every
 * migration that has been accepted so far, with the schema version each one
 * belongs to. Existing entries are immutable; generation may only append newly
 * named migrations, in a schema version above the highest locked one (§7.4).
 * Format 3 stores one canonical head-schema snapshot for actionable
 * diagnostics. Formats 1 and 2 predate per-migration versions: only the
 * explicit `migrations upgrade-lock` command reads them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TypegenError } from './errors';
import type { MigrationInput } from './generate';
import type { IrColumn, IrColumnType, IrSchemaVersion } from './ir';
import { MANIFEST_FILENAME, type ManifestSchemaVersion } from './manifest';
import { applyMigrationSql, type ParsedTable } from './sql';

export const MIGRATION_LOCK_FILENAME = 'syncular.migrations.lock.json';
export const MIGRATION_LOCK_FORMAT_VERSION = 3;

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
  /** The schema version this migration belongs to (§1.5, §7.4). */
  readonly schemaVersion: number;
}

export interface MigrationLock {
  readonly formatVersion: typeof MIGRATION_LOCK_FORMAT_VERSION;
  readonly migrations: readonly MigrationLockEntry[];
  readonly head: {
    readonly tables: readonly MigrationLockTable[];
  };
}

/** A format-1 or format-2 lock: names and checksums without schema versions,
 * read only to upgrade it to the current format. */
export interface LegacyMigrationLock {
  readonly formatVersion: 1 | 2;
  readonly migrations: readonly Omit<MigrationLockEntry, 'schemaVersion'>[];
}

interface HistoryEntry {
  readonly name: string;
  readonly sha256: string;
  readonly tables: readonly MigrationLockTable[];
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
export function lockedMigrationNames(
  lock: MigrationLock | LegacyMigrationLock,
): ReadonlySet<string> {
  return new Set(lock.migrations.map((migration) => migration.name));
}

/** Resolve the manifest's `schemaVersions` (each naming the last migration
 * it includes) into the migrations every version adds (§1.5). */
export function buildSchemaVersions(
  declared: readonly ManifestSchemaVersion[],
  migrations: readonly MigrationInput[],
): IrSchemaVersion[] {
  const names = migrations.map((m) => m.name);
  let cursor = 0;
  const out = declared.map((entry) => {
    const index = names.indexOf(entry.through, cursor);
    if (index === -1) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `schemaVersions: version ${entry.version} names migration ${JSON.stringify(entry.through)}, which does not exist after ${JSON.stringify(names[cursor - 1] ?? '(start)')} (migrations: ${names.join(', ')})`,
      );
    }
    const covered = names.slice(cursor, index + 1);
    cursor = index + 1;
    return { version: entry.version, migrations: covered };
  });
  if (cursor !== names.length) {
    throw new TypegenError(
      MANIFEST_FILENAME,
      `schemaVersions: migrations ${names.slice(cursor).join(', ')} are not covered by any schema version — the last entry's "through" must be the last migration`,
    );
  }
  return out;
}

/** Replay a complete migration sequence with ephemeral diagnostic snapshots.
 * Migrations named in `lockedNames` replay as deployed history; rules that
 * only appended migrations must satisfy are skipped for them. */
function buildMigrationHistory(
  migrations: readonly MigrationInput[],
  lockedNames?: ReadonlySet<string>,
): HistoryEntry[] {
  const tables = new Map<string, ParsedTable>();
  const droppedTables = new Set<string>();
  return migrations.map((migration) => {
    applyMigrationSql(
      tables,
      migration.sql,
      `${migration.name}/up.sql`,
      droppedTables,
      { lockedHistory: lockedNames?.has(migration.name) === true },
    );
    return {
      name: migration.name,
      sha256: checksum(migration.sql),
      tables: snapshotTables(tables),
    };
  });
}

function lockFromHistory(
  history: readonly HistoryEntry[],
  schemaVersions: readonly IrSchemaVersion[],
): MigrationLock {
  const head = history.at(-1);
  if (head === undefined) failLock('cannot lock an empty migration history');
  return {
    formatVersion: MIGRATION_LOCK_FORMAT_VERSION,
    migrations: history.map(({ name, sha256 }) => {
      const version = schemaVersions.find((v) => v.migrations.includes(name));
      if (version === undefined) {
        throw new Error(`unreachable: migration ${name} has no schema version`);
      }
      return { name, sha256, schemaVersion: version.version };
    }),
    head: { tables: head.tables },
  };
}

/** Build a deterministic lock document for a complete migration sequence;
 * `declared` is the manifest's `schemaVersions`. */
export function buildMigrationLock(
  migrations: readonly MigrationInput[],
  declared: readonly ManifestSchemaVersion[],
): MigrationLock {
  return lockFromHistory(
    buildMigrationHistory(migrations),
    buildSchemaVersions(declared, migrations),
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

function parseEntry(
  value: unknown,
  index: number,
): Omit<MigrationLockEntry, 'schemaVersion'> & { schemaVersion?: unknown } {
  const context = `migrations[${index}]`;
  if (!isRecord(value)) failLock(`${context} must be an object`);
  const { name, sha256, schemaVersion } = value;
  if (typeof name !== 'string' || name.length === 0) {
    failLock(`${context}.name must be a non-empty string`);
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    failLock(`${context}.sha256 must be a lowercase SHA-256 digest`);
  }
  return { name, sha256, schemaVersion };
}

function parseHead(value: unknown): MigrationLock['head'] {
  if (!isRecord(value)) failLock('head must be an object');
  if (!Array.isArray(value.tables)) failLock('head.tables must be an array');
  return {
    tables: value.tables.map((table, index) =>
      parseTable(table, `head.tables[${index}]`),
    ),
  };
}

/** Parse and structurally validate a committed lock document. */
export function parseMigrationLock(
  source: string,
): MigrationLock | LegacyMigrationLock {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    failLock('invalid JSON');
  }
  if (!isRecord(raw)) failLock('root must be an object');
  const { formatVersion } = raw;
  if (
    formatVersion !== 1 &&
    formatVersion !== 2 &&
    formatVersion !== MIGRATION_LOCK_FORMAT_VERSION
  ) {
    failLock(
      `formatVersion must be 1, 2, or ${MIGRATION_LOCK_FORMAT_VERSION}, got ${JSON.stringify(formatVersion)}`,
    );
  }
  if (!Array.isArray(raw.migrations) || raw.migrations.length === 0) {
    failLock('migrations must be a non-empty array');
  }
  const entries = raw.migrations.map(parseEntry);
  const names = new Set<string>();
  for (const { name } of entries) {
    if (names.has(name)) {
      failLock(`migration ${JSON.stringify(name)} appears twice`);
    }
    names.add(name);
  }
  if (formatVersion !== MIGRATION_LOCK_FORMAT_VERSION) {
    return {
      formatVersion,
      migrations: entries.map(({ name, sha256 }) => ({ name, sha256 })),
    };
  }
  let previous = 1;
  const migrations = entries.map(({ name, sha256, schemaVersion }, index) => {
    if (
      typeof schemaVersion !== 'number' ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < previous
    ) {
      failLock(
        `migrations[${index}].schemaVersion must be an integer, at least 1 and at least the previous entry's`,
      );
    }
    previous = schemaVersion;
    return { name, sha256, schemaVersion };
  });
  return {
    formatVersion: MIGRATION_LOCK_FORMAT_VERSION,
    migrations,
    head: parseHead(raw.head),
  };
}

/** Read the version-controlled baseline without exposing its absolute path. */
export function readMigrationLock(
  manifestDir: string,
): MigrationLock | LegacyMigrationLock {
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
  locked: readonly MigrationLockTable[],
  current: readonly MigrationLockTable[],
): string {
  const length = Math.max(locked.length, current.length);
  for (let index = 0; index < length; index++) {
    const before = locked[index];
    const after = current[index];
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
  locked: MigrationLock | LegacyMigrationLock,
  current: readonly HistoryEntry[],
): void {
  locked.migrations.forEach((before, index) => {
    const after = current[index];
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
      // The head snapshot is the schema after the complete locked prefix:
      // compare it with the current schema at that same boundary, excluding
      // valid newly appended migrations. A legacy lock is read without one.
      const difference =
        locked.formatVersion === MIGRATION_LOCK_FORMAT_VERSION
          ? `; first schema difference: ${firstSchemaDifference(locked.head.tables, (current[locked.migrations.length - 1] ?? after).tables)}`
          : '';
      failLock(
        `history drift in migration ${JSON.stringify(before.name)}: checksum changed${difference}; ${REPAIR_HINT}`,
      );
    }
  });
}

/**
 * Validate a committed lock against the migration inputs and their schema
 * versions, and build its exact next document. A locked migration keeps its
 * schema version; an appended migration belongs to a version above the
 * highest locked one, because a deployed version never changes (§7.4).
 */
export function updateMigrationLock(
  locked: MigrationLock | LegacyMigrationLock,
  migrations: readonly MigrationInput[],
  declared: readonly ManifestSchemaVersion[],
): MigrationLock {
  if (locked.formatVersion !== MIGRATION_LOCK_FORMAT_VERSION) {
    throw new TypegenError(
      MIGRATION_LOCK_FILENAME,
      'the lock predates per-migration schema versions; run `syncular migrations upgrade-lock` once and commit the lock',
      'typegen.migration_lock_outdated',
      { formatVersion: locked.formatVersion },
    );
  }
  const current = buildMigrationHistory(
    migrations,
    lockedMigrationNames(locked),
  );
  validateMigrationHistory(locked, current);
  const next = lockFromHistory(
    current,
    buildSchemaVersions(declared, migrations),
  );
  const highestLockedVersion = locked.migrations.at(-1)?.schemaVersion ?? 0;
  next.migrations.forEach(({ name, schemaVersion }, index) => {
    const lockedVersion = locked.migrations[index]?.schemaVersion;
    if (lockedVersion !== undefined && lockedVersion !== schemaVersion) {
      throw new TypegenError(
        MIGRATION_LOCK_FILENAME,
        'a locked migration moved to another schema version; a locked version keeps its migration set (§7.4)',
        'typegen.migration_version_changed',
        { migration: name, lockedVersion, schemaVersion },
      );
    }
    if (lockedVersion === undefined && schemaVersion <= highestLockedVersion) {
      throw new TypegenError(
        MIGRATION_LOCK_FILENAME,
        'an appended migration joins a locked schema version; declare a schema version above the highest locked one (§7.4)',
        'typegen.schema_version_locked',
        { migration: name, schemaVersion, highestLockedVersion },
      );
    }
  });
  return next;
}

/**
 * Convert a format-1 or format-2 lock to the current format: validate its
 * locked prefix and record the schema version the manifest's `declared`
 * versions assign each locked migration. Appended migrations stay unlocked for generation.
 */
export function upgradeMigrationLock(
  locked: LegacyMigrationLock,
  migrations: readonly MigrationInput[],
  declared: readonly ManifestSchemaVersion[],
): MigrationLock {
  const current = buildMigrationHistory(
    migrations,
    lockedMigrationNames(locked),
  );
  validateMigrationHistory(locked, current);
  return lockFromHistory(
    current.slice(0, locked.migrations.length),
    buildSchemaVersions(declared, migrations),
  );
}
