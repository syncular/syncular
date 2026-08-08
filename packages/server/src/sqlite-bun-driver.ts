import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type {
  SqliteDatabase,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
} from './sqlite-driver';

export class BunSqliteDatabase implements SqliteDatabase {
  readonly native: Database;

  constructor(path = ':memory:') {
    this.native = new Database(path);
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  run(sql: string, bindings: readonly SqliteValue[] = []): SqliteRunResult {
    return this.native.run(sql, [...bindings]);
  }

  query<Row, Params extends readonly SqliteValue[]>(
    sql: string,
  ): SqliteStatement<Row, Params> {
    const statement = this.native.query<Row, SQLQueryBindings[]>(sql);
    return {
      run: (...params) => statement.run(...params),
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
    };
  }

  serialize(): Uint8Array {
    return new Uint8Array(this.native.serialize());
  }

  close(): void {
    this.native.close();
  }
}
