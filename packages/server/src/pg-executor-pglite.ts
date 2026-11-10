import { retainRollbackFailure } from './storage-errors';
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
 * `ROLLBACK` on the one connection. Transactions and pool-level `query` calls
 * share one promise chain (mirroring `SqliteServerStorage`): a nested BEGIN
 * on Postgres is a warning-level no-op, so interleaved scopes would silently
 * collapse into one SQL transaction, and a pool-level statement issued while
 * a transaction is open would read its uncommitted rows or join it (§6.4).
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgExecutor, PgQueryable, PgRow } from './pg-executor';

/** Minimal structural type for a pglite instance (avoids a hard type dep). */
interface PgliteLike {
  query<Row>(query: string, params?: unknown[]): Promise<{ rows: Row[] }>;
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
      return { rows: result.rows };
    },
  };
}

export function pgliteExecutor(db: PGlite | PgliteLike): PgExecutor {
  const like = db as PgliteLike;
  const q = queryable(like);
  // One caller at a time on the single connection (see the file header).
  let tail: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };
  return {
    async query<Row = PgRow>(text: string, params?: readonly unknown[]) {
      const release = await acquire();
      try {
        return await q.query<Row>(text, params);
      } finally {
        release();
      }
    },
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      const release = await acquire();
      try {
        await like.exec('BEGIN');
        try {
          const result = await fn(q);
          await like.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            await like.exec('ROLLBACK');
          } catch (rollbackError) {
            retainRollbackFailure(error, rollbackError);
          }
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
