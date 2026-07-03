/**
 * A `PgExecutor` over @electric-sql/pglite (embedded WASM Postgres).
 *
 * This is the **test/dev** driver — hermetic, no docker, runs under bun.
 * `@electric-sql/pglite` is a devDependency of `@syncular-v2/server`; this
 * module is exported for tests and local experiments, not the production
 * path. Production wires Bun.sql or node-postgres against the same
 * `PgExecutor` interface (see the server README).
 *
 * pglite is single-connection, so `transaction` runs `BEGIN`/`COMMIT`/
 * `ROLLBACK` on the one connection and relies on the caller not interleaving
 * unrelated queries during a transaction scope (the storage layer holds one
 * transaction at a time per push).
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
  return {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      await like.exec('BEGIN');
      try {
        const result = await fn(q);
        await like.exec('COMMIT');
        return result;
      } catch (error) {
        await like.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      await like.close();
    },
  };
}
