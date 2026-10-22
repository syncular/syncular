import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import type {
  SqliteDatabase,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
} from './sqlite-driver';

function bind(value: SqliteValue): SQLInputValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function row<Row>(value: Record<string, unknown> | undefined): Row | null {
  return (value ?? null) as Row | null;
}

export class NodeSqliteDatabase implements SqliteDatabase {
  readonly native: DatabaseSync;
  /** Prepared statements by SQL text, as `bun:sqlite`'s `query` keeps them. */
  readonly #statements = new Map<string, StatementSync>();

  constructor(path = ':memory:') {
    this.native = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  run(sql: string, bindings: readonly SqliteValue[] = []): SqliteRunResult {
    return this.#prepare(sql).run(...bindings.map(bind));
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.native.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  query<Row, Params extends readonly SqliteValue[]>(
    sql: string,
  ): SqliteStatement<Row, Params> {
    const statement = this.#prepare(sql);
    return {
      run: (...params) => statement.run(...params.map(bind)),
      get: (...params) => row<Row>(statement.get(...params.map(bind))),
      all: (...params) => statement.all(...params.map(bind)) as Row[],
    };
  }

  close(): void {
    this.native.close();
  }
}
