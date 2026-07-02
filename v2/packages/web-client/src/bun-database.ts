/**
 * `ClientDatabase` on bun:sqlite — the test backend (REVISE B3: the core
 * must run without a browser). Not exported from the package root so the
 * browser entry never touches `bun:sqlite`.
 */
import { Database } from 'bun:sqlite';
import {
  type ClientDatabase,
  runTransaction,
  type SqlRow,
  type SqlValue,
} from './database';

type BunParam = string | number | bigint | Uint8Array | null;

function coerceParams(params: readonly SqlValue[]): BunParam[] {
  return params.map((value): BunParam => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

export class BunClientDatabase implements ClientDatabase {
  readonly db: Database;
  #tx = { depth: 0 };

  constructor(path = ':memory:') {
    this.db = new Database(path);
  }

  exec(sql: string, params: readonly SqlValue[] = []): void {
    this.db.query(sql).run(...coerceParams(params));
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.db.query(sql).all(...coerceParams(params)) as SqlRow[];
  }

  transaction<T>(fn: () => T): T {
    return runTransaction(this.#tx, (sql) => this.db.run(sql), fn);
  }

  close(): void {
    this.db.close();
  }
}

export function openBunDatabase(path = ':memory:'): ClientDatabase {
  return new BunClientDatabase(path);
}
