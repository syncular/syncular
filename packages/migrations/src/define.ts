/**
 * @syncular/migrations - Migration definition
 */

import type {
  DefinedMigrations,
  MigrationDefinition,
  MigrationFn,
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

/**
 * Normalize a function source string for checksum comparison.
 * Strips comments and collapses whitespace so that formatting-only
 * changes don't break checksums.
 */
function stripCommentsPreservingStrings(source: string): string {
  let out = '';
  let i = 0;
  let mode:
    | 'code'
    | 'singleQuote'
    | 'doubleQuote'
    | 'template'
    | 'lineComment'
    | 'blockComment' = 'code';

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];

    if (mode === 'lineComment') {
      if (char === '\n') {
        out += '\n';
        mode = 'code';
      }
      i += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (char === '*' && next === '/') {
        i += 2;
        mode = 'code';
        continue;
      }
      if (char === '\n') {
        out += '\n';
      }
      i += 1;
      continue;
    }

    if (mode === 'singleQuote') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (char === "'") {
        mode = 'code';
      }
      i += 1;
      continue;
    }

    if (mode === 'doubleQuote') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (char === '"') {
        mode = 'code';
      }
      i += 1;
      continue;
    }

    if (mode === 'template') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (char === '`') {
        mode = 'code';
      }
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      mode = 'lineComment';
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'blockComment';
      i += 2;
      continue;
    }
    if (char === "'") {
      mode = 'singleQuote';
      out += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      mode = 'doubleQuote';
      out += char;
      i += 1;
      continue;
    }
    if (char === '`') {
      mode = 'template';
      out += char;
      i += 1;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

function normalizeSource(source: string): string {
  return stripCommentsPreservingStrings(source)
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

/**
 * Compute a simple checksum for a migration function.
 * Used to detect if a migration has changed after being applied.
 */
function computeChecksum<DB>(fn: MigrationFn<DB>): string {
  const fnStr = normalizeSource(fn.toString());
  let hash = 0;
  for (let i = 0; i < fnStr.length; i++) {
    hash = (hash * 31 + fnStr.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isMigrationDefinitionObject<DB>(
  value: MigrationDefinition<DB>
): value is { up: MigrationFn<DB>; down?: MigrationFn<DB> } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Define versioned migrations with automatic version parsing and sorting.
 *
 * @example
 * ```typescript
 * export const migrations = defineMigrations({
 *   v1: async (db) => {
 *     await db.schema.createTable('tasks')
 *       .addColumn('id', 'text', col => col.primaryKey())
 *       .addColumn('title', 'text', col => col.notNull())
 *       .execute();
 *   },
 *   v2: async (db) => {
 *     await db.schema.alterTable('tasks')
 *       .addColumn('priority', 'integer', col => col.defaultTo(0))
 *       .execute();
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

    const up = isMigrationDefinitionObject(definition)
      ? definition.up
      : definition;
    const down = isMigrationDefinitionObject(definition)
      ? definition.down
      : undefined;
    if (typeof up !== 'function') {
      throw new Error(
        `Invalid migration "${key}": expected an async function or { up, down? } object.`
      );
    }
    if (down !== undefined && typeof down !== 'function') {
      throw new Error(
        `Invalid migration "${key}": "down" must be a function when provided.`
      );
    }

    migrations.push({
      version,
      name: key,
      up,
      down,
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

/**
 * Get the checksum for a migration.
 */
export function getMigrationChecksum<DB>(
  migration: ParsedMigration<DB>
): string {
  return computeChecksum(migration.up);
}
