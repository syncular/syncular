import { PGlite } from '@electric-sql/pglite';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  type Kysely as KyselyInstance,
  PostgresAdapter,
  type QueryResult,
  SqliteAdapter,
  SqliteDialect,
  type TransactionSettings,
} from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import type {
  DefinedMigrations,
  MigrationChecksumAlgorithm,
  MigrationChecksumDialect,
  ParsedMigration,
} from './types';

export const DISABLED_MIGRATION_CHECKSUM = '__syncular_checksum_disabled__';
export const LEGACY_SOURCE_MIGRATION_CHECKSUM_ALGORITHM = 'legacy_source_v1';
export const SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM = 'sql_trace_v1';
export const DISABLED_MIGRATION_CHECKSUM_ALGORITHM = 'disabled';

interface TraceSink {
  enabled: boolean;
  entries: string[];
}

const checksumCache = new WeakMap<
  object,
  Map<MigrationChecksumDialect, string | null>
>();

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

class TracingConnection implements DatabaseConnection {
  readonly #inner: DatabaseConnection;
  readonly #sink: TraceSink;

  constructor(inner: DatabaseConnection, sink: TraceSink) {
    this.#inner = inner;
    this.#sink = sink;
  }

  unwrap(): DatabaseConnection {
    return this.#inner;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    if (this.#sink.enabled) {
      this.#sink.entries.push(serializeCompiledQuery(compiledQuery));
    }
    return await this.#inner.executeQuery<R>(compiledQuery);
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    if (this.#sink.enabled) {
      this.#sink.entries.push(serializeCompiledQuery(compiledQuery));
    }
    for await (const result of this.#inner.streamQuery<R>(
      compiledQuery,
      chunkSize
    )) {
      yield result;
    }
  }
}

class TracingDriver implements Driver {
  readonly #inner: Driver;
  readonly #sink: TraceSink;
  readonly #innerToWrapped = new Map<DatabaseConnection, TracingConnection>();

  constructor(inner: Driver, sink: TraceSink) {
    this.#inner = inner;
    this.#sink = sink;
  }

  async init(): Promise<void> {
    await this.#inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#wrapConnection(await this.#inner.acquireConnection());
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings
  ): Promise<void> {
    await this.#inner.beginTransaction(
      this.#unwrapConnection(connection),
      settings
    );
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.#inner.commitTransaction(this.#unwrapConnection(connection));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.#inner.rollbackTransaction(this.#unwrapConnection(connection));
  }

  async savepoint?(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: Parameters<NonNullable<Driver['savepoint']>>[2]
  ): Promise<void> {
    if (!this.#inner.savepoint) {
      return;
    }
    await this.#inner.savepoint(
      this.#unwrapConnection(connection),
      savepointName,
      compileQuery
    );
  }

  async rollbackToSavepoint?(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: Parameters<NonNullable<Driver['rollbackToSavepoint']>>[2]
  ): Promise<void> {
    if (!this.#inner.rollbackToSavepoint) {
      return;
    }
    await this.#inner.rollbackToSavepoint(
      this.#unwrapConnection(connection),
      savepointName,
      compileQuery
    );
  }

  async releaseSavepoint?(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: Parameters<NonNullable<Driver['releaseSavepoint']>>[2]
  ): Promise<void> {
    if (!this.#inner.releaseSavepoint) {
      return;
    }
    await this.#inner.releaseSavepoint(
      this.#unwrapConnection(connection),
      savepointName,
      compileQuery
    );
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const unwrapped = this.#unwrapConnection(connection);

    if (connection instanceof TracingConnection) {
      this.#innerToWrapped.delete(unwrapped);
    }

    await this.#inner.releaseConnection(unwrapped);
  }

  async destroy(): Promise<void> {
    this.#innerToWrapped.clear();
    await this.#inner.destroy();
  }

  #wrapConnection(connection: DatabaseConnection): DatabaseConnection {
    const existing = this.#innerToWrapped.get(connection);
    if (existing) {
      return existing;
    }

    const wrapped = new TracingConnection(connection, this.#sink);
    this.#innerToWrapped.set(connection, wrapped);
    return wrapped;
  }

  #unwrapConnection(connection: DatabaseConnection): DatabaseConnection {
    if (connection instanceof TracingConnection) {
      return connection.unwrap();
    }
    return connection;
  }
}

function createTracingDialect(baseDialect: Dialect, sink: TraceSink): Dialect {
  return {
    createDriver: () => new TracingDriver(baseDialect.createDriver(), sink),
    createAdapter: () => baseDialect.createAdapter(),
    createQueryCompiler: () => baseDialect.createQueryCompiler(),
    createIntrospector: (db) => baseDialect.createIntrospector(db),
  };
}

function serializeCompiledQuery(compiledQuery: CompiledQuery): string {
  return JSON.stringify({
    sql: compiledQuery.sql,
    parameters: compiledQuery.parameters.map((value) =>
      normalizeParameterValue(value)
    ),
  });
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

function hashTrace(entries: string[]): string {
  return hashString(entries.join('\n'));
}

async function createSqliteChecksumDb<DB>(sink: TraceSink): Promise<{
  db: Kysely<DB>;
  dispose: () => Promise<void>;
}> {
  try {
    const bunSqliteSpecifier = 'bun:sqlite';
    const sqliteModule = await import(bunSqliteSpecifier);
    const dialectModule = await import('kysely-bun-sqlite');
    const sqliteDb = new sqliteModule.Database(':memory:');
    const dialect = createTracingDialect(
      new dialectModule.BunSqliteDialect({ database: sqliteDb }),
      sink
    );

    return {
      db: new Kysely<DB>({ dialect }),
      dispose: async () => {
        sqliteDb.close();
      },
    };
  } catch {
    // Fall back to better-sqlite3 outside Bun.
  }

  try {
    const sqliteModule = await import('better-sqlite3');
    const sqliteDb = new sqliteModule.default(':memory:');
    const dialect = createTracingDialect(
      new SqliteDialect({ database: sqliteDb }),
      sink
    );

    return {
      db: new Kysely<DB>({ dialect }),
      dispose: async () => {
        sqliteDb.close();
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Deterministic migration checksums for sqlite require an in-memory sqlite runtime in this environment. ${message}`
    );
  }
}

async function createPostgresChecksumDb<DB>(sink: TraceSink): Promise<{
  db: Kysely<DB>;
  dispose: () => Promise<void>;
}> {
  const pglite = await PGlite.create();
  const dialect = createTracingDialect(new PGliteDialect(pglite), sink);

  return {
    db: new Kysely<DB>({ dialect }),
    dispose: async () => {
      await pglite.close();
    },
  };
}

async function createChecksumDb<DB>(
  dialect: MigrationChecksumDialect,
  sink: TraceSink
): Promise<{
  db: Kysely<DB>;
  dispose: () => Promise<void>;
}> {
  if (dialect === 'postgres') {
    return await createPostgresChecksumDb<DB>(sink);
  }

  return await createSqliteChecksumDb<DB>(sink);
}

async function computeDeterministicChecksum<DB>(
  migrations: DefinedMigrations<DB>,
  migration: ParsedMigration<DB>,
  dialect: MigrationChecksumDialect
): Promise<string> {
  const sink: TraceSink = { enabled: false, entries: [] };
  const { db, dispose } = await createChecksumDb<DB>(dialect, sink);

  try {
    for (const current of migrations.migrations) {
      if (current.version > migration.version) {
        break;
      }

      sink.enabled = current.version === migration.version;
      await current.up(db);
      sink.enabled = false;

      if (current.version === migration.version) {
        break;
      }
    }

    return hashTrace(sink.entries);
  } finally {
    await db.destroy();
    await dispose();
  }
}

export function inferMigrationChecksumDialect<DB>(
  db: KyselyInstance<DB>
): MigrationChecksumDialect | null {
  const adapter = db.getExecutor().adapter;
  const adapterName = adapter.constructor.name;

  if (adapter instanceof SqliteAdapter || adapterName === 'SqliteAdapter') {
    return 'sqlite';
  }

  if (adapter instanceof PostgresAdapter || adapterName === 'PostgresAdapter') {
    return 'postgres';
  }

  return null;
}

export async function getMigrationChecksum<DB>(
  migrations: DefinedMigrations<DB>,
  migration: ParsedMigration<DB>,
  dialect: MigrationChecksumDialect
): Promise<string | null> {
  if (migration.checksum === 'disabled') {
    return null;
  }

  let dialectCache = checksumCache.get(migration);
  if (!dialectCache) {
    dialectCache = new Map();
    checksumCache.set(migration, dialectCache);
  }

  if (dialectCache.has(dialect)) {
    return dialectCache.get(dialect) ?? null;
  }

  const checksum = await computeDeterministicChecksum(
    migrations,
    migration,
    dialect
  );

  dialectCache.set(dialect, checksum);
  return checksum;
}

export function getLegacyMigrationChecksum<DB>(
  migration: ParsedMigration<DB>
): string {
  return hashString(normalizeLegacySource(migration.up.toString()));
}

export function getMigrationChecksumAlgorithm<DB>(
  migration: ParsedMigration<DB>
): MigrationChecksumAlgorithm {
  if (migration.checksum === 'disabled') {
    return DISABLED_MIGRATION_CHECKSUM_ALGORITHM;
  }

  return SQL_TRACE_MIGRATION_CHECKSUM_ALGORITHM;
}
