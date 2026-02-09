/**
 * @syncular/client - Proxy Dialect
 *
 * Kysely Dialect that proxies queries over WebSocket to a sync server.
 */

import type {
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
} from 'kysely';
import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { ProxyDriver, type ProxyDriverConfigWithFactory } from './driver';

interface ProxyDialectConfig extends ProxyDriverConfigWithFactory {}

/**
 * Creates a Kysely dialect that proxies queries over WebSocket.
 *
 * This dialect uses PostgreSQL query compilation and adapters since
 * the proxy server typically runs against a PostgreSQL database.
 *
 * @example
 * ```typescript
 * import { Kysely } from 'kysely';
 * import { createProxyDialect } from '@syncular/client/proxy';
 *
 * const db = new Kysely<MySchema>({
 *   dialect: createProxyDialect({
 *     endpoint: 'wss://api.example.com/proxy',
 *     actorId: 'admin:worker',
 *     clientId: 'cf-worker-123',
 *     headers: { authorization: 'Bearer ...' },
 *   }),
 * });
 *
 * // Full Kysely API works
 * const tasks = await db.selectFrom('tasks').selectAll().execute();
 *
 * // Transactions work
 * await db.transaction().execute(async (trx) => {
 *   const user = await trx.selectFrom('users')
 *     .where('id', '=', 'u1')
 *     .executeTakeFirst();
 *   await trx.insertInto('tasks')
 *     .values({ id: 'x', user_id: user.id, title: 'New' })
 *     .execute();
 * });
 * ```
 */
export function createProxyDialect(config: ProxyDialectConfig): Dialect {
  return {
    createDriver(): Driver {
      return new ProxyDriver(config);
    },

    createQueryCompiler(): QueryCompiler {
      return new PostgresQueryCompiler();
    },

    createAdapter(): DialectAdapter {
      return new PostgresAdapter();
    },

    createIntrospector(db: Kysely<any>): DatabaseIntrospector {
      return new PostgresIntrospector(db);
    },
  };
}
