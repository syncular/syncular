/**
 * Syncular proxy API scaffold.
 */

import { createProxyRoutes } from '@syncular/server-hono';
import { ProxyTableRegistry } from '@syncular/server';

type ProxyRouteOptions = Parameters<typeof createProxyRoutes>[0];

export function createSyncularProxyRoutes(args: {
  db: ProxyRouteOptions['db'];
  dialect: ProxyRouteOptions['dialect'];
  upgradeWebSocket: ProxyRouteOptions['upgradeWebSocket'];
  validateToken: (token: string | undefined) => string | null;
}) {
  const handlers = new ProxyTableRegistry().register({
    table: 'tasks',
    computeScopes: (row) => ({ user_id: String(row.user_id ?? '') }),
  });

  return createProxyRoutes({
    db: args.db,
    dialect: args.dialect,
    handlers,
    upgradeWebSocket: args.upgradeWebSocket,
    authenticate: async (c) => {
      const token = c.req.query('token') ?? c.req.header('x-api-key');
      const actorId = args.validateToken(token);
      return actorId ? { actorId } : null;
    },
  });
}
