/**
 * `ClientDatabase` on Node's built-in `node:sqlite`. Semantics mirror the Bun
 * adapter: synchronous queries, nested transactions, and SQLite image attach.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertImageAlias,
  type ClientDatabase,
  runTransaction,
  type SiblingDatabase,
  type SqlRow,
  type SqlValue,
} from './database';
import { prepareReadOnly, SQL_BLANK } from './query-guard';

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
  readonly #path: string;
  #tx = { depth: 0 };

  constructor(path = ':memory:') {
    this.#path = path;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  exec(sql: string, params: readonly SqlValue[] = []): void {
    this.db.prepare(sql).run(...coerceParams(params));
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const rows = this.db.prepare(sql).all(...coerceParams(params));
    return rows.map(normalizeRow);
  }

  queryReadOnly(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const statement = prepareReadOnly(sql, () => {
      const prepared = this.db.prepare(sql);
      // node:sqlite exposes no `sqlite3_stmt_readonly` (and no column count
      // before Node 22.16), so the verb decides: SELECT, VALUES, EXPLAIN, or
      // a WITH clause whose first keyword outside parentheses is SELECT or
      // VALUES.
      const body = prepared.sourceSQL.replace(SQL_BLANK, '');
      const verb = /^[a-z]+/i.exec(body)?.[0].toLowerCase();
      let reads = verb === 'select' || verb === 'values' || verb === 'explain';
      if (verb === 'with') {
        let depth = 0;
        for (const [token] of body.matchAll(
          /'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$)|[\w$\u0080-\uffff]+|[\s\S]/g,
        )) {
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
          else if (
            depth === 0 &&
            /^(?:select|values|insert|update|delete|replace)$/i.test(token)
          ) {
            reads = /^(?:select|values)$/i.test(token);
            break;
          }
        }
      }
      return [prepared, prepared.sourceSQL, reads] as const;
    });
    return statement.all(...coerceParams(params)).map(normalizeRow);
  }

  /** RFC 0005: a sibling file beside the replica, e.g. `<path>.prev-context`. */
  openSibling(name: string): SiblingDatabase {
    const siblingPath =
      this.#path === ':memory:' ? ':memory:' : `${this.#path}.${name}`;
    const database = new NodeClientDatabase(siblingPath);
    return {
      database,
      close: () => database.close(),
      removeFile: () => {
        if (siblingPath === ':memory:') return;
        rmSync(siblingPath, { force: true });
        rmSync(`${siblingPath}-wal`, { force: true });
        rmSync(`${siblingPath}-shm`, { force: true });
      },
    };
  }

  siblingExists(name: string): boolean {
    if (this.#path === ':memory:') return false;
    return existsSync(`${this.#path}.${name}`);
  }

  transaction<T>(fn: () => T): T {
    return runTransaction(this.#tx, (sql) => this.db.exec(sql), fn);
  }

  /** §5.3 image import through a private file attached for one callback. */
  async withSqliteImage<T>(
    bytes: Uint8Array,
    alias: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    assertImageAlias(alias);
    const dir = mkdtempSync(join(tmpdir(), 'syncular-image-'));
    const path = join(dir, 'segment.db');
    try {
      writeFileSync(path, bytes);
      this.db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path);
      try {
        return await fn();
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
