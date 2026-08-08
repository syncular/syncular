import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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

  constructor(path = ':memory:') {
    this.native = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  run(sql: string, bindings: readonly SqliteValue[] = []): SqliteRunResult {
    return this.native.prepare(sql).run(...bindings.map(bind));
  }

  query<Row, Params extends readonly SqliteValue[]>(
    sql: string,
  ): SqliteStatement<Row, Params> {
    const statement = this.native.prepare(sql);
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
