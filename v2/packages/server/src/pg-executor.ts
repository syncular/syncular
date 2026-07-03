/**
 * The minimal Postgres executor seam (REVISE B2: zero runtime deps).
 *
 * `PostgresServerStorage` is written entirely against this interface so the
 * server library never imports a specific driver. Production wires one of:
 *
 *   - **Bun.sql** (built into bun) — see `bunSqlExecutor` in the README;
 *   - **node-postgres** (`pg`) — a `Pool`/`PoolClient` adapter;
 *
 * and the test lane wires **@electric-sql/pglite** (embedded WASM Postgres,
 * a devDependency) via `pgliteExecutor`. All three speak the same three
 * primitives below.
 *
 * ## Type-parser contract (load-bearing)
 *
 * `commitSeq`/`serverVersion` are `int8`/`bigint` columns. Drivers disagree
 * on how they decode `int8`:
 *
 *   - pglite → JS `number`;
 *   - node-postgres → `string` (its default `int8` parser is off to avoid
 *     silent precision loss past 2^53);
 *   - Bun.sql → `bigint`.
 *
 * The storage layer therefore coerces every sequence value it reads through
 * `Number(...)` (see `asNumber`). Sequences here are per-partition commit
 * counters and server_version counters — both comfortably inside 2^53 for
 * any realistic deployment, so the coercion is safe; a host that expects to
 * exceed 2^53 commits in a single partition has bigger problems than this
 * seam. `bytea` columns MUST decode to `Uint8Array`/`Buffer` (all three
 * drivers do); `NULL` decodes to JS `null`.
 */

/** One database row as a plain object keyed by (lower-cased) column name. */
export type PgRow = Record<string, unknown>;

/**
 * A handle that runs parameterized statements. Both the pool-level executor
 * and a per-transaction client implement it, so storage code is written once
 * against `PgQueryable` regardless of transaction scope.
 *
 * `params` use Postgres positional placeholders (`$1`, `$2`, ...). `text`
 * is a single statement (no multi-statement `;`-joined batches — those are
 * driver-specific and defeat parameterization).
 */
export interface PgQueryable {
  query<Row = PgRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>;
}

/**
 * The pool-level executor: `PgQueryable` plus transaction control. A
 * `transaction` callback receives a client pinned to one connection for the
 * duration of a real Postgres `BEGIN … COMMIT/ROLLBACK`; throwing rolls back.
 */
export interface PgExecutor extends PgQueryable {
  /**
   * Run `fn` inside a single Postgres transaction on one pinned connection.
   * The executor issues `BEGIN` before `fn`, `COMMIT` on resolve, and
   * `ROLLBACK` on throw (rethrowing the original error).
   */
  transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T>;
  /** Release any pooled resources. Optional (pglite/Bun.sql). */
  close?(): Promise<void>;
}

/** Coerce a driver-decoded sequence value (`number | string | bigint`). */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10);
  if (value === null || value === undefined) return 0;
  throw new Error(`expected a numeric column, got ${typeof value}`);
}

/** Coerce a driver-decoded `bytea` value to a `Uint8Array`. */
export function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value === null || value === undefined) {
    throw new Error('expected bytea, got null');
  }
  // node-postgres/Bun.sql return Buffer (a Uint8Array subclass); this branch
  // is a defensive copy for any array-like the driver hands back.
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error(`expected bytea, got ${typeof value}`);
}
