import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type {
  DefinedMigrations,
  MigrationChecksums,
  ParsedMigration,
} from '@syncular/migrations';
import { Kysely, SqliteDialect } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import type {
  GenerateMigrationChecksumsOptions,
  GenerateMigrationChecksumsResult,
  TypegenDialect,
} from './types';

interface TraceableQuery {
  sql: string;
  parameters: readonly unknown[];
}

interface SqliteDb {
  close(): void;
}

type BunAwareGlobals = typeof globalThis & {
  Bun?: object;
};

const runtimeGlobals = globalThis as BunAwareGlobals;
const isBun = typeof runtimeGlobals.Bun !== 'undefined';

function hashString(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function normalizeParameterValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: value.toString() };
  }
  if (value instanceof Date) {
    return { type: 'date', value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { type: 'bytes', value: Array.from(value) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeParameterValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeParameterValue(entry)])
    );
  }
  return value;
}

function serializeQuery(query: TraceableQuery): string {
  return JSON.stringify({
    sql: query.sql,
    parameters: query.parameters.map((value) => normalizeParameterValue(value)),
  });
}

function hashTrace(entries: string[]): string {
  return hashString(entries.join('\n'));
}

async function createSqliteTraceDb<DB>(traceEntries: string[]): Promise<{
  db: Kysely<DB>;
  sqliteDb: SqliteDb;
}> {
  if (isBun) {
    const bunSqliteSpecifier = 'bun:sqlite';
    const sqliteModule = await import(bunSqliteSpecifier);
    const dialectModule = await import('kysely-bun-sqlite');
    const sqliteDb = new sqliteModule.Database(':memory:');
    const db = new Kysely<DB>({
      dialect: new dialectModule.BunSqliteDialect({
        database: sqliteDb as never,
      }),
      log(event) {
        if (event.level === 'query') {
          traceEntries.push(serializeQuery(event.query));
        }
      },
    });

    return { db, sqliteDb };
  }

  const { default: Database } = await import('better-sqlite3');
  const sqliteDb = new Database(':memory:');
  const db = new Kysely<DB>({
    dialect: new SqliteDialect({
      database: sqliteDb as never,
    }),
    log(event) {
      if (event.level === 'query') {
        traceEntries.push(serializeQuery(event.query));
      }
    },
  });

  return { db, sqliteDb };
}

async function createPostgresTraceDb<DB>(traceEntries: string[]): Promise<{
  db: Kysely<DB>;
  dispose: () => Promise<void>;
}> {
  const pglite = await PGlite.create();
  const db = new Kysely<DB>({
    dialect: new PGliteDialect(pglite),
    log(event) {
      if (event.level === 'query') {
        traceEntries.push(serializeQuery(event.query));
      }
    },
  });

  return {
    db,
    dispose: async () => {
      if (!pglite.closed) {
        await pglite.close();
      }
    },
  };
}

async function createTraceDb<DB>(
  dialect: TypegenDialect,
  traceEntries: string[]
): Promise<{
  db: Kysely<DB>;
  dispose: () => Promise<void>;
}> {
  if (dialect === 'postgres') {
    return createPostgresTraceDb<DB>(traceEntries);
  }

  const { db, sqliteDb } = await createSqliteTraceDb<DB>(traceEntries);
  return {
    db,
    dispose: async () => {
      sqliteDb.close();
    },
  };
}

async function computeMigrationChecksum<DB>(
  migrations: DefinedMigrations<DB>,
  targetMigration: ParsedMigration<DB>,
  dialect: TypegenDialect
): Promise<string> {
  const traceEntries: string[] = [];
  const { db, dispose } = await createTraceDb<DB>(dialect, traceEntries);

  try {
    for (const migration of migrations.migrations) {
      if (migration.version > targetMigration.version) {
        break;
      }

      if (migration.version === targetMigration.version) {
        traceEntries.length = 0;
      }

      await migration.up(db);

      if (migration.version === targetMigration.version) {
        break;
      }
    }

    return hashTrace(traceEntries);
  } finally {
    await db.destroy();
    await dispose();
  }
}

export async function createMigrationChecksums<DB>(
  migrations: DefinedMigrations<DB>,
  dialect: TypegenDialect = 'sqlite'
): Promise<MigrationChecksums> {
  const checksums: Record<string, string> = {};

  for (const migration of migrations.migrations) {
    if (migration.checksum === 'disabled') {
      continue;
    }

    checksums[String(migration.version)] = await computeMigrationChecksum(
      migrations,
      migration,
      dialect
    );
  }

  return checksums;
}

export function renderMigrationChecksums(
  checksums: MigrationChecksums
): string {
  const entries = Object.entries(checksums)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(
      ([version, checksum]) =>
        `  ${JSON.stringify(version)}: ${JSON.stringify(checksum)},`
    )
    .join('\n');

  return [
    '/**',
    ' * Generated by @syncular/typegen.',
    ' * Do not edit by hand.',
    ' */',
    '',
    'export const migrationChecksums = {',
    entries,
    '} as const;',
    '',
  ].join('\n');
}

export async function generateMigrationChecksums<DB>(
  options: GenerateMigrationChecksumsOptions<DB>
): Promise<GenerateMigrationChecksumsResult> {
  const { migrations, output, dialect = 'sqlite' } = options;
  const checksums = await createMigrationChecksums(migrations, dialect);
  const code = renderMigrationChecksums(checksums);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, code, 'utf-8');

  return {
    outputPath: output,
    currentVersion: migrations.currentVersion,
    checksumCount: Object.keys(checksums).length,
    code,
  };
}
