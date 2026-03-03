/**
 * @syncular/dialect-react-native-nitro-sqlite - React Native Nitro SQLite dialect for sync
 *
 * Provides a Kysely dialect for React Native Nitro SQLite (react-native-nitro-sqlite).
 * SQLite-compatible — use with @syncular/server-dialect-sqlite.
 */

import type {
  CompiledQuery,
  DatabaseConnection,
  Dialect,
  QueryResult,
} from 'kysely';
import { BaseSqliteDialect, BaseSqliteDriver } from 'kysely-generic-sqlite';
import type {
  NitroSQLiteConnection,
  NitroSQLiteConnectionOptions,
  SQLiteValue,
} from 'react-native-nitro-sqlite';

/** Function type for open from react-native-nitro-sqlite */
type OpenNitroSqlite = (
  options: NitroSQLiteConnectionOptions
) => NitroSQLiteConnection;

interface NitroSqliteNameOptions {
  /** Database name (will be stored in app's document directory) */
  name: string;
  /** The open function from react-native-nitro-sqlite */
  open: OpenNitroSqlite;
  /** Optional database location */
  location?: string;
}

interface NitroSqliteInstanceOptions {
  /** An existing nitro-sqlite database instance */
  database: NitroSQLiteConnection;
}

export type NitroSqliteOptions =
  | NitroSqliteNameOptions
  | NitroSqliteInstanceOptions;

/**
 * Create the Nitro SQLite dialect directly.
 */
export function createNitroSqliteDialect(options: NitroSqliteOptions): Dialect {
  return new BaseSqliteDialect(() => new NitroSqliteDriver(options));
}

class NitroSqliteDriver extends BaseSqliteDriver {
  #db: NitroSQLiteConnection | undefined;

  constructor(options: NitroSqliteOptions) {
    super(async () => {
      this.#db = resolveNitroSqliteDatabase(options);
      this.conn = new NitroSqliteConnection(this.#db);
    });
  }

  async destroy(): Promise<void> {
    const db = this.#db;
    this.#db = undefined;
    db?.close();
  }
}

function resolveNitroSqliteDatabase(
  options: NitroSqliteOptions
): NitroSQLiteConnection {
  if ('database' in options) {
    return options.database;
  }

  return options.open({
    name: options.name,
    location: options.location,
  });
}

class NitroSqliteConnection implements DatabaseConnection {
  readonly #db: NitroSQLiteConnection;

  constructor(db: NitroSQLiteConnection) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const params = parameters as SQLiteValue[];

    const hasReturning = /\breturning\b/i.test(sql);
    const isSelectLike = /^\s*(select|pragma|explain|with)\b/i.test(sql);

    const result = this.#db.execute(sql, params);

    if (isSelectLike || hasReturning) {
      const rows = (result.results ?? []) as R[];
      return {
        rows,
        ...(hasReturning ? { numAffectedRows: BigInt(rows.length) } : {}),
      };
    }

    return {
      rows: [],
      numAffectedRows: BigInt(result.rowsAffected ?? 0),
      insertId: BigInt(result.insertId ?? 0),
    };
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      'react-native-nitro-sqlite driver does not support streaming'
    );
  }
}
