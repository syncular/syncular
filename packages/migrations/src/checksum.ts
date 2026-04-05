import type {
  MigrationChecksumAlgorithm,
  MigrationChecksums,
  ParsedMigration,
} from './types';

export const DISABLED_MIGRATION_CHECKSUM = '__syncular_checksum_disabled__';
export const LEGACY_SOURCE_MIGRATION_CHECKSUM_ALGORITHM = 'legacy_source_v1';
export const SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM = 'sql_trace_v1';
export const DISABLED_MIGRATION_CHECKSUM_ALGORITHM = 'disabled';

function stripCommentsPreservingStrings(source: string): string {
  let out = '';
  let index = 0;
  let mode:
    | 'code'
    | 'singleQuote'
    | 'doubleQuote'
    | 'template'
    | 'lineComment'
    | 'blockComment' = 'code';

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (mode === 'lineComment') {
      if (char === '\n') {
        out += '\n';
        mode = 'code';
      }
      index += 1;
      continue;
    }

    if (mode === 'blockComment') {
      if (char === '*' && next === '/') {
        index += 2;
        mode = 'code';
        continue;
      }
      if (char === '\n') {
        out += '\n';
      }
      index += 1;
      continue;
    }

    if (mode === 'singleQuote') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === "'") {
        mode = 'code';
      }
      index += 1;
      continue;
    }

    if (mode === 'doubleQuote') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === '"') {
        mode = 'code';
      }
      index += 1;
      continue;
    }

    if (mode === 'template') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === '`') {
        mode = 'code';
      }
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      mode = 'lineComment';
      index += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'blockComment';
      index += 2;
      continue;
    }
    if (char === "'") {
      mode = 'singleQuote';
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      mode = 'doubleQuote';
      out += char;
      index += 1;
      continue;
    }
    if (char === '`') {
      mode = 'template';
      out += char;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function hashString(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function normalizeLegacySource(source: string): string {
  return stripCommentsPreservingStrings(source).replace(/\s+/g, ' ').trim();
}

export function getLegacyMigrationChecksum<DB>(
  migration: ParsedMigration<DB>
): string {
  return hashString(normalizeLegacySource(migration.up.toString()));
}

export function getStoredDeterministicChecksum<DB>(
  migration: ParsedMigration<DB>,
  checksums: MigrationChecksums | undefined
): string {
  if (migration.checksum === 'disabled') {
    return DISABLED_MIGRATION_CHECKSUM;
  }

  if (!checksums) {
    throw new Error(
      `Migration v${migration.version} (${migration.name}) requires generated checksums. ` +
        'Generate a checksum manifest with @syncular/typegen and pass it to runMigrations({ checksums }).'
    );
  }

  const checksum = checksums[String(migration.version)];

  if (!checksum) {
    throw new Error(
      `Missing generated checksum for migration v${migration.version} (${migration.name}). ` +
        'Regenerate the checksum manifest before running migrations.'
    );
  }

  return checksum;
}

export function getMigrationChecksumAlgorithm<DB>(
  migration: ParsedMigration<DB>,
  checksums: MigrationChecksums | undefined
): MigrationChecksumAlgorithm {
  if (migration.checksum === 'disabled') {
    return DISABLED_MIGRATION_CHECKSUM_ALGORITHM;
  }

  if (!checksums) {
    throw new Error(
      `Migration v${migration.version} (${migration.name}) requires generated checksums. ` +
        'Generate a checksum manifest with @syncular/typegen and pass it to runMigrations({ checksums }).'
    );
  }

  return SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM;
}
