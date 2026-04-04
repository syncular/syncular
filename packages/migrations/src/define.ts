/**
 * @syncular/migrations - Migration definition
 */

import type {
  DefinedMigrations,
  MigrationChecksumMode,
  MigrationDefinition,
  MigrationRecord,
  ParsedMigration,
} from './types';

/**
 * Parse a version key (e.g., 'v1', 'v2', '1', '2') into a version number.
 */
function parseVersionKey(key: string): number | null {
  // Support both 'v1' and '1' formats
  const match = key.match(/^v?(\d+)$/i);
  if (!match) return null;
  const version = Number.parseInt(match[1]!, 10);
  return Number.isNaN(version) ? null : version;
}

function isMigrationDefinitionObject<DB>(
  value: MigrationDefinition<DB>
): value is MigrationDefinition<DB> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChecksumMode(
  key: string,
  checksum: MigrationChecksumMode | undefined
): MigrationChecksumMode {
  if (checksum === undefined) {
    return 'deterministic';
  }
  if (checksum === 'deterministic' || checksum === 'disabled') {
    return checksum;
  }

  throw new Error(
    `Invalid migration "${key}": "checksum" must be "deterministic" or "disabled" when provided.`
  );
}

/**
 * Define versioned migrations with automatic version parsing and sorting.
 *
 * @example
 * ```typescript
 * export const migrations = defineMigrations({
 *   v1: {
 *     up: async (db) => {
 *       await db.schema.createTable('tasks')
 *         .addColumn('id', 'text', col => col.primaryKey())
 *         .addColumn('title', 'text', col => col.notNull())
 *         .execute();
 *     },
 *     down: async (db) => {
 *       await db.schema.dropTable('tasks').ifExists().execute();
 *     },
 *   },
 *   v2: {
 *     up: async (db) => {
 *       await db.schema.alterTable('tasks')
 *         .addColumn('priority', 'integer', col => col.defaultTo(0))
 *         .execute();
 *     },
 *     down: async (db) => {
 *       await db.schema.alterTable('tasks')
 *         .dropColumn('priority')
 *         .execute();
 *     },
 *   },
 * });
 * ```
 */
export function defineMigrations<
  DB = unknown,
  T extends MigrationRecord<DB> = MigrationRecord<DB>,
>(versionedMigrations: T): DefinedMigrations<DB> {
  const migrations: ParsedMigration<DB>[] = [];

  for (const [key, definition] of Object.entries(versionedMigrations)) {
    const version = parseVersionKey(key);
    if (version === null) {
      throw new Error(
        `Invalid migration key "${key}": must be a version number (e.g., 'v1', 'v2', '1', '2')`
      );
    }
    if (version < 1) {
      throw new Error(
        `Invalid migration version ${version}: versions must be >= 1`
      );
    }

    if (!isMigrationDefinitionObject(definition)) {
      throw new Error(
        `Invalid migration "${key}": expected a { up, down } object. Shorthand migration functions are not supported.`
      );
    }

    const { up, down } = definition;
    const checksum = normalizeChecksumMode(key, definition.checksum);

    if (typeof up !== 'function') {
      throw new Error(`Invalid migration "${key}": "up" must be a function.`);
    }
    if (typeof down !== 'function') {
      throw new Error(`Invalid migration "${key}": "down" must be a function.`);
    }
    migrations.push({
      version,
      name: key,
      up,
      down,
      checksum,
    });
  }

  // Sort by version number
  migrations.sort((a, b) => a.version - b.version);

  // Check for duplicate versions
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version) {
      throw new Error(`Duplicate migration version ${migrations[i]!.version}`);
    }
  }

  const currentVersion =
    migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;

  return {
    migrations,
    currentVersion,
    getMigration(version: number) {
      return migrations.find((m) => m.version === version);
    },
  };
}
