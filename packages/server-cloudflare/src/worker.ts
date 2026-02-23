/**
 * @syncular/server-cloudflare - Worker handler (polling only)
 *
 * Creates a stateless Cloudflare Worker that serves sync routes via Hono.
 * No WebSocket support — use the Durable Object adapter for realtime.
 *
 * @example
 * ```typescript
 * import { createSyncWorker } from '@syncular/server-cloudflare/worker';
 * import { createD1Db } from '@syncular/dialect-d1';
 * import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
 * import { ensureSyncSchema } from '@syncular/server';
 * import { createSyncServer } from '@syncular/server-hono';
 *
 * type Env = { DB: D1Database };
 *
 * export default createSyncWorker<Env>((app, env) => {
 *   const db = createD1Db(env.DB);
 *   const dialect = createSqliteServerDialect();
 *   const { syncRoutes, consoleRoutes } = createSyncServer({
 *     db, dialect,
 *     sync: {
 *       handlers: [tasksHandler],
 *       authenticate: async (request) => ({
 *         actorId: request.headers.get('x-user-id')!,
 *       }),
 *     },
 *   });
 *   app.route('/sync', syncRoutes);
 *   if (consoleRoutes) app.route('/console', consoleRoutes);
 * });
 * ```
 */

import { Hono } from 'hono';

type SyncWorkerSetup<B extends object> = (
  app: Hono<{ Bindings: B }>,
  env: B
) => void | Promise<void>;

/**
 * Create a Cloudflare Worker export that lazily initializes a Hono app.
 *
 * The `setup` callback is called once per isolate on the first request.
 * It receives a fresh Hono app and the Worker env bindings.
 */
export function createSyncWorker<
  Bindings extends object = Record<string, unknown>,
>(setup: SyncWorkerSetup<Bindings>): ExportedHandler<Bindings> {
  type E = { Bindings: Bindings };
  let app: Hono<E> | null = null;
  let initPromise: Promise<void> | null = null;

  async function getApp(env: Bindings): Promise<Hono<E>> {
    if (app) return app;
    if (!initPromise) {
      const honoApp = new Hono<E>();
      initPromise = Promise.resolve(setup(honoApp, env)).then(() => {
        app = honoApp;
      });
    }
    await initPromise;
    return app!;
  }

  return {
    async fetch(
      request: Request,
      env: Bindings,
      ctx: ExecutionContext
    ): Promise<Response> {
      const honoApp = await getApp(env);
      return honoApp.fetch(request, env, ctx);
    },
  };
}
