/**
 * `Bun.SQL` as the server's `PgExecutor`: the production-shape adapter the
 * load server and the partition ceiling share. `max` caps the pool; Bun's
 * own default is 10 connections.
 */
import { SQL } from 'bun';
import type { PgExecutor, PgQueryable } from '@syncular/server';

function queryableOver(handle: Pick<SQL, 'unsafe'>): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = await handle.unsafe<Row[]>(text, params ? [...params] : []);
      return { rows };
    },
  };
}

export function bunSqlExecutor(
  url: string,
  options: { max?: number } = {},
): { executor: PgExecutor; sql: SQL } {
  const sql = new SQL(
    url,
    options.max === undefined ? {} : { max: options.max },
  );
  return {
    sql,
    executor: {
      query: queryableOver(sql).query,
      transaction: (fn) => sql.begin((tx) => fn(queryableOver(tx))),
      async close() {
        await sql.end();
      },
    },
  };
}
