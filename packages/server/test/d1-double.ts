/**
 * A hermetic local double for the Cloudflare D1 API, backed by `bun:sqlite`.
 *
 * D1's storage engine *is* SQLite, and its query API is a thin async wrapper
 * over prepared statements. This double exposes exactly the `D1Database`
 * subset `D1ServerStorage` and the Workers entry use — `prepare(sql)` →
 * `bind(...)` → `first()`/`all()`/`run()`, plus `batch([…])` and `exec()` —
 * over an in-memory `bun:sqlite` database. Because the SQL, the types, and
 * the transaction semantics are the same SQLite engine, the contract suite
 * runs against this double with high fidelity to real D1.
 *
 * ## Fidelity limits (documented honestly, TODO §4.2)
 *
 *   - **Sync-under-the-hood**: real D1 is a network round-trip per statement
 *     with its own latency and occasional replication lag on read replicas;
 *     the double resolves synchronously (wrapped in `Promise.resolve`), so it
 *     cannot surface timing, replica staleness, or partial-network failures.
 *   - **`batch()` atomicity**: real D1 wraps a batch in one implicit
 *     transaction (all-or-nothing). The double reproduces this with a
 *     `bun:sqlite` `BEGIN … COMMIT`/`ROLLBACK`, so the atomicity the
 *     `D1ServerStorage` buffered-commit relies on is faithfully exercised —
 *     a mid-batch failure rolls the whole batch back here too.
 *   - **BLOB round-trip**: real D1 returns BLOB columns as `ArrayBuffer`;
 *     `bun:sqlite` returns `Uint8Array`. The double converts reads to
 *     `ArrayBuffer` so `D1ServerStorage`'s `asUint8Array` normalization is
 *     exercised on the same type real D1 hands back (not the sqlite default).
 *   - **No `EXPLAIN` lane**: the double does not attempt an index-plan
 *     assertion — real D1 does not expose a stable `EXPLAIN QUERY PLAN`
 *     surface over its API, so index sanity for the D1 dialect is covered by
 *     the sqlite-family PRAGMA index shape (shared DDL) and can be re-checked
 *     against real D1 in an env-gated lane later. See the note in the D1
 *     contract test.
 */
import { Database } from 'bun:sqlite';
import type { D1Database, D1PreparedStatement } from '../src/d1-storage';

/** Convert `bun:sqlite`'s BLOB result (`Uint8Array`) to D1's (`ArrayBuffer`). */
function normalizeRow<T>(row: unknown): T {
  if (row === null || typeof row !== 'object') return row as T;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] =
      value instanceof Uint8Array
        ? (value.slice().buffer as ArrayBuffer)
        : value;
  }
  return out as T;
}

class DoublePreparedStatement implements D1PreparedStatement {
  readonly #db: Database;
  readonly #sql: string;
  #params: unknown[] = [];

  constructor(db: Database, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.#params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.#db.query(this.#sql).get(...(this.#params as never[]));
    return row === null || row === undefined ? null : normalizeRow<T>(row);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.#db.query(this.#sql).all(...(this.#params as never[]));
    return { results: rows.map((row) => normalizeRow<T>(row)) };
  }

  async run(): Promise<unknown> {
    this.#db.query(this.#sql).run(...(this.#params as never[]));
    return {};
  }

  /** Internal: apply this statement inside an already-open transaction. */
  _apply(): void {
    this.#db.query(this.#sql).run(...(this.#params as never[]));
  }
}

export class D1DatabaseDouble implements D1Database {
  readonly #db: Database;

  constructor(db: Database = new Database(':memory:')) {
    this.#db = db;
  }

  prepare(query: string): D1PreparedStatement {
    return new DoublePreparedStatement(this.#db, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    // Real D1 wraps a batch in one implicit transaction; reproduce the
    // all-or-nothing semantics with BEGIN … COMMIT/ROLLBACK.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of statements) {
        (statement as DoublePreparedStatement)._apply();
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return statements.map(() => ({}));
  }

  async exec(query: string): Promise<unknown> {
    this.#db.exec(query);
    return {};
  }
}
