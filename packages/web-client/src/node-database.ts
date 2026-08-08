/**
 * `ClientDatabase` on Node's built-in `node:sqlite`. Semantics mirror the Bun
 * adapter: synchronous queries, nested transactions, and SQLite image attach.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertImageAlias,
  type ClientDatabase,
  runTransaction,
  type SqlRow,
  type SqlValue,
} from './database';

function coerceParams(params: readonly SqlValue[]): SQLInputValue[] {
  return params.map((value): SQLInputValue => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

function normalizeRow(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const key in row) {
    const value = row[key];
    if (value instanceof Uint8Array) {
      out[key] = new Uint8Array(value);
    } else {
      out[key] = value as SqlValue;
    }
  }
  return out;
}

export class NodeClientDatabase implements ClientDatabase {
  readonly db: DatabaseSync;
  #tx = { depth: 0 };

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string, params: readonly SqlValue[] = []): void {
    this.db.prepare(sql).run(...coerceParams(params));
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const rows = this.db.prepare(sql).all(...coerceParams(params));
    return rows.map(normalizeRow);
  }

  transaction<T>(fn: () => T): T {
    return runTransaction(this.#tx, (sql) => this.db.exec(sql), fn);
  }

  /** §5.3 image import through a private file attached for one callback. */
  withSqliteImage<T>(bytes: Uint8Array, alias: string, fn: () => T): T {
    assertImageAlias(alias);
    const dir = mkdtempSync(join(tmpdir(), 'syncular-image-'));
    const path = join(dir, 'segment.db');
    try {
      writeFileSync(path, bytes);
      this.db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path);
      try {
        return fn();
      } finally {
        this.db.prepare(`DETACH DATABASE ${alias}`).run();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openNodeDatabase(path = ':memory:'): ClientDatabase {
  return new NodeClientDatabase(path);
}
