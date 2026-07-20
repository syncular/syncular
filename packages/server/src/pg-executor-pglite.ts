/**
 * A `PgExecutor` over @electric-sql/pglite (embedded WASM Postgres).
 *
 * This is the **test/dev** driver — hermetic, no docker, runs under bun.
 * `@electric-sql/pglite` is a devDependency of `@syncular/server`; this
 * module is exported for tests and local experiments, not the production
 * path. Production wires Bun.sql or node-postgres against the same
 * `PgExecutor` interface (see the server README).
 *
 * pglite is single-connection, so `transaction` runs `BEGIN`/`COMMIT`/
 * `ROLLBACK` on the one connection. Overlapping `transaction` calls are
 * serialized through a promise chain (mirroring `SqliteServerStorage`'s
 * begin() FIFO): a nested BEGIN on Postgres is a warning-level no-op, so
 * interleaved scopes would silently collapse into one SQL transaction and
 * break the push layer's serialization guarantee on this dev driver.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgExecutor, PgQueryable, PgRow } from './pg-executor';

/** Minimal structural type for a pglite instance (avoids a hard type dep). */
interface PgliteLike {
  query<Row>(
    query: string,
    params?: unknown[],
  ): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(query: string): Promise<unknown>;
  close(): Promise<void>;
}

function queryable(db: PgliteLike): PgQueryable {
  return {
    async query<Row = PgRow>(text: string, params?: readonly unknown[]) {
      const result = await db.query<Row>(
        text,
        params ? [...params] : undefined,
      );
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
  };
}

export function pgliteExecutor(db: PGlite | PgliteLike): PgExecutor {
  const like = db as PgliteLike;
  const q = queryable(like);
  // One BEGIN…COMMIT/ROLLBACK scope at a time on the single connection (see
  // the file header).
  let transactionTail: Promise<void> = Promise.resolve();
  return {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        await like.exec('BEGIN');
        try {
          const result = await fn(q);
          await like.exec('COMMIT');
          return result;
        } catch (error) {
          await like.exec('ROLLBACK');
          throw error;
        }
      } finally {
        release();
      }
    },
    async close() {
      await like.close();
    },
  };
}
