/**
 * A `PgExecutor` over Bun.sql for tests against a real PostgreSQL at
 * `SYNCULAR_PG_URL`; `realPg` is undefined without that URL or Bun.sql.
 */
/* oxlint-disable typescript/no-explicit-any -- Bun.sql and its handles are dynamic. */
import type { PgExecutor, PgQueryable } from '@syncular/server';

export const PG_URL = process.env.SYNCULAR_PG_URL;

export const BunSQL = (Bun as any).SQL as
  | undefined
  | (new (url: string) => any);

export function queryableOver(handle: any): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = (await handle.unsafe(
        text,
        params ? [...params] : [],
      )) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
}

export function bunSqlExecutor(
  sql: any,
): PgExecutor & { close(): Promise<void> } {
  const q = queryableOver(sql);
  return {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      return sql.begin(async (tx: any) => fn(queryableOver(tx)));
    },
    async close() {
      await sql.end();
    },
  };
}
