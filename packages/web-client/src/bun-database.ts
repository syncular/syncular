/**
 * `ClientDatabase` on bun:sqlite is the test backend. The core
 * must run without a browser). Not exported from the package root so the
 * browser entry never touches `bun:sqlite`.
 */
import { Database } from 'bun:sqlite';
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

type BunParam = string | number | bigint | Uint8Array | null;

function coerceParams(params: readonly SqlValue[]): BunParam[] {
  return params.map((value): BunParam => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

export class BunClientDatabase implements ClientDatabase {
  readonly db: Database;
  readonly #path: string;
  #tx = { depth: 0 };

  constructor(path = ':memory:') {
    this.#path = path;
    this.db = new Database(path);
    // Match native Rust persistence: append durable commits to the WAL
    // instead of creating and syncing a rollback journal per transaction.
    // SQLite retains its in-memory journal for :memory: databases.
    try {
      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA synchronous = FULL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  exec(sql: string, params: readonly SqlValue[] = []): void {
    this.db.query(sql).run(...coerceParams(params));
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.db.query(sql).all(...coerceParams(params)) as SqlRow[];
  }

  /** RFC 0005: a sibling file beside the replica, e.g. `<path>.prev-context`. */
  openSibling(name: string): SiblingDatabase {
    const siblingPath =
      this.#path === ':memory:' ? ':memory:' : `${this.#path}.${name}`;
    const database = new BunClientDatabase(siblingPath);
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
    return runTransaction(this.#tx, (sql) => this.db.run(sql), fn);
  }

  /**
   * §5.3 image import: bun:sqlite attaches files, not buffers, so the
   * image lands in a private temp file for the duration of the ATTACH.
   */
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
      this.db.run(`ATTACH DATABASE ? AS ${alias}`, [path]);
      try {
        return await fn();
      } finally {
        this.db.run(`DETACH DATABASE ${alias}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openBunDatabase(path = ':memory:'): ClientDatabase {
  return new BunClientDatabase(path);
}
