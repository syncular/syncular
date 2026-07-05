/**
 * `ClientDatabase` on better-sqlite3 — the Electron-main / plain-Node
 * backend (TODO 2: Node ClientDatabase). Semantics mirror `./bun-database`
 * exactly (synchronous exec/query/transaction with the shared savepoint
 * helper, and the same §5.3 sqlite-image ATTACH path), so the core behaves
 * identically whether it runs on bun:sqlite (tests), sqlite-wasm (browser)
 * or better-sqlite3 (Node/Electron-main).
 *
 * better-sqlite3 is an OPTIONAL peer dependency, not a hard one: the package
 * installs cleanly without it and this module errors helpfully only when a
 * host actually calls `openNodeDatabase()` without having installed the peer.
 * Not exported from the package root, so browser/bun entries never resolve
 * the native module. Subpath export: `@syncular-v2/web-client/node`.
 *
 * bun CANNOT dlopen better-sqlite3 (ERR_DLOPEN_FAILED, oven-sh/bun#4290), so
 * this adapter is verified under real Node — see the README "Electron-main /
 * plain-Node" section for the one-command recipe and `test/node-database`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertImageAlias,
  type ClientDatabase,
  runTransaction,
  type SqlRow,
  type SqlValue,
} from './database';

/**
 * Structural view of the tiny better-sqlite3 surface this binding uses. We
 * type it locally (rather than importing `better-sqlite3`'s types) so the
 * package typechecks without the optional peer installed.
 */
interface BetterSqliteStatement {
  run(...params: NodeParam[]): unknown;
  all(...params: NodeParam[]): unknown[];
}
interface BetterSqliteDatabase {
  readonly inTransaction: boolean;
  prepare(sql: string): BetterSqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}
type BetterSqliteConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqliteDatabase;

/**
 * better-sqlite3 accepts string / number / bigint / null / Buffer|Uint8Array
 * bind values, but NOT booleans (it throws "TypeError: can only bind …"). We
 * coerce booleans to 0/1 exactly like the bun adapter so callers see one
 * uniform bind contract across every backend.
 */
type NodeParam = string | number | bigint | Uint8Array | null;

function coerceParams(params: readonly SqlValue[]): NodeParam[] {
  return params.map((value): NodeParam => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

/**
 * better-sqlite3 returns BLOB columns as Node `Buffer`s. A Buffer IS a
 * Uint8Array subclass, but it can be a view onto a shared pool buffer, so we
 * normalize to a standalone Uint8Array — matching what bun:sqlite hands back
 * and keeping the buffer-ownership assumptions elsewhere (worker transfer,
 * structured clone) honest.
 */
function normalizeRow(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const key in row) {
    const value = row[key];
    if (Buffer.isBuffer(value)) {
      out[key] = new Uint8Array(value); // copies out of the pool
    } else {
      out[key] = value as SqlValue;
    }
  }
  return out;
}

/**
 * Load the optional peer AND open the database in one guarded step, so BOTH
 * failure modes are turned into a clear, actionable error rather than a raw
 * one:
 *
 *  - `require('better-sqlite3')` throwing MODULE_NOT_FOUND — the peer is not
 *    installed (the common browser-only-host case), and
 *  - `new Database()` throwing ERR_DLOPEN_FAILED — the module resolves but the
 *    native addon cannot load, which is exactly what bun does for
 *    better-sqlite3 (oven-sh/bun#4290); the addon only dlopens at construction.
 */
function openBetterSqlite(path: string): BetterSqliteDatabase {
  const require = createRequire(import.meta.url);
  try {
    const mod = require('better-sqlite3') as
      | BetterSqliteConstructor
      | { default: BetterSqliteConstructor };
    const Database =
      (mod as { default?: BetterSqliteConstructor }).default ??
      (mod as BetterSqliteConstructor);
    return new Database(path);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'ERR_DLOPEN_FAILED') {
      throw new Error(
        "openNodeDatabase() requires the 'better-sqlite3' native module, but " +
          'it failed to load. This most commonly means you are running under ' +
          'bun, which cannot dlopen better-sqlite3 (oven-sh/bun#4290) — use ' +
          "the bun:sqlite backend ('@syncular-v2/web-client/bun') under bun, " +
          "and reserve '@syncular-v2/web-client/node' for Node/Electron-main. " +
          `Underlying error: ${String(error)}`,
      );
    }
    throw new Error(
      'openNodeDatabase() requires the optional peer dependency ' +
        "'better-sqlite3', which is not installed. Add it to your app " +
        '(`npm install better-sqlite3` / `bun add better-sqlite3`) — it is ' +
        'kept optional so @syncular-v2/web-client installs without a native ' +
        `build for browser-only hosts. Underlying error: ${String(error)}`,
    );
  }
}

export class NodeClientDatabase implements ClientDatabase {
  readonly db: BetterSqliteDatabase;
  #tx = { depth: 0 };

  constructor(path = ':memory:') {
    this.db = openBetterSqlite(path);
  }

  exec(sql: string, params: readonly SqlValue[] = []): void {
    this.db.prepare(sql).run(...coerceParams(params));
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const rows = this.db.prepare(sql).all(...coerceParams(params));
    return (rows as Record<string, unknown>[]).map(normalizeRow);
  }

  transaction<T>(fn: () => T): T {
    return runTransaction(this.#tx, (sql) => this.db.exec(sql), fn);
  }

  /**
   * §5.3 image import: better-sqlite3 (like bun:sqlite) attaches files, not
   * buffers, so the image lands in a private temp file for the duration of
   * the ATTACH. Must be called outside any open transaction (SQLite cannot
   * ATTACH inside one).
   */
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
