/** Values accepted by the synchronous SQLite adapters. */
export type SqliteValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | null;

/** Result of a SQLite statement that does not return rows. */
export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** Prepared synchronous SQLite statement used by the server stores. */
export interface SqliteStatement<Row, Params extends readonly SqliteValue[]> {
  run(...params: Params): SqliteRunResult;
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
}

/** Runtime-neutral database surface shared by the Bun and Node adapters. */
export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, bindings?: readonly SqliteValue[]): SqliteRunResult;
  query<
    Row = Record<string, SqliteValue>,
    Params extends readonly SqliteValue[] = SqliteValue[],
  >(
    sql: string,
  ): SqliteStatement<Row, Params>;
  close(): void;
}

/** Raised when a neutral-runtime import is used without a SQLite adapter. */
export class SqliteAdapterRequiredError extends Error {
  override readonly name = 'SqliteAdapterRequiredError';
  readonly code = 'sync.sqlite_adapter_required';

  constructor() {
    super('SQLite paths require the @syncular/server/sqlite runtime adapter');
  }
}
