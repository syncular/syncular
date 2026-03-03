/**
 * @syncular/dialect-expo-sqlite - Expo SQLite dialect for sync
 *
 * Provides a Kysely dialect for Expo's SQLite module (expo-sqlite).
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type {
  DatabaseConnection,
  Dialect,
  QueryResult,
} from 'kysely';
import { CompiledQuery } from 'kysely';
import { BaseSqliteDialect, BaseSqliteDriver } from 'kysely-generic-sqlite';

export type ExpoSqliteBindValue = null | string | number | Uint8Array;

export type ExpoSqliteBindParams = ExpoSqliteBindValue[];

export interface ExpoSqliteRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface ExpoSqliteDatabaseLike {
  getAllSync<R>(sql: string, params: ExpoSqliteBindParams): R[];
  getAllSync<R>(sql: string, ...params: readonly ExpoSqliteBindValue[]): R[];
  runSync(sql: string, params: ExpoSqliteBindParams): ExpoSqliteRunResult;
  runSync(
    sql: string,
    ...params: readonly ExpoSqliteBindValue[]
  ): ExpoSqliteRunResult;
  closeSync(): void;
}

/** Function type for openDatabaseSync from expo-sqlite */
type OpenDatabaseSync = (name: string) => ExpoSqliteDatabaseLike;

interface ExpoSqliteNameOptions {
  /** Database name (will be stored in app's document directory) */
  name: string;
  /** The openDatabaseSync function from expo-sqlite */
  openDatabaseSync: OpenDatabaseSync;
}

interface ExpoSqliteInstanceOptions {
  /** An existing expo-sqlite database instance */
  database: ExpoSqliteDatabaseLike;
}

export type ExpoSqliteOptions =
  | ExpoSqliteNameOptions
  | ExpoSqliteInstanceOptions;

/**
 * Create the Expo SQLite dialect directly.
 */
export function createExpoSqliteDialect(options: ExpoSqliteOptions): Dialect {
  return new BaseSqliteDialect(() => new ExpoSqliteDriver(options));
}

class ExpoSqliteDriver extends BaseSqliteDriver {
  #db: ExpoSqliteDatabaseLike | undefined;

  constructor(options: ExpoSqliteOptions) {
    super(async () => {
      this.#db = resolveExpoSqliteDatabase(options);
      // Better concurrency defaults for sync workloads.
      this.#db.runSync('PRAGMA journal_mode = WAL', []);
      this.#db.runSync('PRAGMA busy_timeout = 5000', []);
      this.conn = new ExpoSqliteConnection(this.#db);
    });
  }

  async beginTransaction(
    connection: DatabaseConnection
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }

  async destroy(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    db?.closeSync();
  }
}

function resolveExpoSqliteDatabase(
  options: ExpoSqliteOptions
): ExpoSqliteDatabaseLike {
  if ('database' in options) {
    return options.database;
  }
  return options.openDatabaseSync(options.name);
}

class ExpoSqliteConnection implements DatabaseConnection {
  readonly #db: ExpoSqliteDatabaseLike;

  constructor(db: ExpoSqliteDatabaseLike) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const params = [...parameters] as ExpoSqliteBindParams;

    const hasReturning = /\breturning\b/i.test(sql);
    const isSelectLike = /^\s*(select|pragma|explain|with)\b/i.test(sql);

    if (isSelectLike || hasReturning) {
      const rows = this.#db.getAllSync<R>(sql, params);
      const normalizedRows = rows ?? [];
      return {
        rows: normalizedRows,
        ...(hasReturning
          ? { numAffectedRows: BigInt(normalizedRows.length) }
          : {}),
      };
    }

    const result: ExpoSqliteRunResult = this.#db.runSync(sql, params);
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowId),
    };
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('expo-sqlite driver does not support streaming');
  }
}
