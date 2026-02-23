/**
 * @syncular/server-hono - Proxy Routes
 *
 * WebSocket endpoint for database proxy.
 */

import type {
  ProxyHandshake,
  ProxyHandshakeAck,
  ProxyMessage,
  ProxyResponse,
} from '@syncular/core';
import { logSyncEvent } from '@syncular/core';
import type {
  ProxyHandlerCollection,
  ServerSyncDialect,
  SyncCoreDb,
} from '@syncular/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import type { Kysely } from 'kysely';
import { ProxyConnectionManager } from './connection-manager';

/**
 * WeakMap for storing proxy connection manager per Hono instance.
 */
interface ProxyConnectionManagerHandle {
  canAccept(): boolean;
  getConnectionCount(): number;
  register(ws: WSContext, handshake: ProxyHandshake): unknown;
  handleMessage(ws: WSContext, message: ProxyMessage): Promise<ProxyResponse>;
  unregister(ws: WSContext): Promise<void>;
}

const proxyConnectionManagerMap = new WeakMap<
  Hono,
  ProxyConnectionManagerHandle
>();

interface ProxyAuthResult {
  /** Actor ID for oplog tracking */
  actorId: string;
}

interface CreateProxyRoutesConfig<DB extends SyncCoreDb = SyncCoreDb> {
  /** Database connection */
  db: Kysely<DB>;
  /** Server sync dialect */
  dialect: ServerSyncDialect;
  /** Proxy table handlers for oplog generation */
  handlers: ProxyHandlerCollection;
  /** Authenticate the request and return actor info */
  authenticate: (c: Context) => Promise<ProxyAuthResult | null>;
  /** WebSocket upgrade function from Hono */
  upgradeWebSocket: UpgradeWebSocket;
  /** Maximum concurrent connections (default: 100) */
  maxConnections?: number;
  /** Idle connection timeout in ms (default: 30000) */
  idleTimeoutMs?: number;
}

/**
 * Create Hono routes for the proxy WebSocket endpoint.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createBunWebSocket } from 'hono/bun';
 * import { createProxyRoutes } from '@syncular/server-hono/proxy';
 *
 * const { upgradeWebSocket, websocket } = createBunWebSocket();
 *
 * const app = new Hono();
 *
 * app.route('/proxy', createProxyRoutes({
 *   db,
 *   handlers: proxyHandlers,
 *   authenticate: async (c) => {
 *     // Verify admin auth
 *     return { actorId: 'admin:123' };
 *   },
 *   upgradeWebSocket,
 * }));
 *
 * export default { fetch: app.fetch, websocket };
 * ```
 */
export function createProxyRoutes<DB extends SyncCoreDb>(
  config: CreateProxyRoutesConfig<DB>
): Hono {
  const app = new Hono();

  const manager = new ProxyConnectionManager({
    db: config.db,
    dialect: config.dialect,
    handlers: config.handlers,
    maxConnections: config.maxConnections,
    idleTimeoutMs: config.idleTimeoutMs,
  });

  // Store manager for external access if needed
  proxyConnectionManagerMap.set(app, manager);

  // WebSocket upgrade endpoint - using regular route since WebSocket doesn't fit OpenAPI well
  app.get('/', async (c) => {
    // Authenticate before upgrade
    const auth = await config.authenticate(c);
    if (!auth) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401);
    }

    // Check connection limit
    if (!manager.canAccept()) {
      logSyncEvent({
        event: 'proxy.rejected',
        userId: auth.actorId,
        reason: 'max_connections',
      });
      return c.json({ error: 'PROXY_CONNECTION_LIMIT' }, 429);
    }

    logSyncEvent({
      event: 'proxy.connect',
      userId: auth.actorId,
    });

    return config.upgradeWebSocket(c, {
      onOpen(_evt, _ws) {
        // Connection opened, wait for handshake message
      },

      async onMessage(evt, ws) {
        try {
          const data =
            typeof evt.data === 'string'
              ? evt.data
              : new TextDecoder().decode(evt.data as ArrayBuffer);

          const message = JSON.parse(data);

          // Handle handshake
          if (message.type === 'handshake') {
            const handshake = message as ProxyHandshake;

            // Validate that the handshake actor matches authenticated actor
            if (handshake.actorId !== auth.actorId) {
              const ack: ProxyHandshakeAck = {
                type: 'handshake_ack',
                ok: false,
                error: 'Actor ID mismatch',
              };
              ws.send(JSON.stringify(ack));
              ws.close(4001, 'Unauthorized');
              return;
            }

            manager.register(ws, handshake);

            const ack: ProxyHandshakeAck = {
              type: 'handshake_ack',
              ok: true,
            };
            ws.send(JSON.stringify(ack));
            return;
          }

          // Handle proxy messages
          const proxyMessage = message as ProxyMessage;
          const response = await manager.handleMessage(ws, proxyMessage);
          ws.send(JSON.stringify(response));
        } catch (err) {
          // Send error response if we can parse the message ID
          try {
            const parsed = JSON.parse(
              typeof evt.data === 'string'
                ? evt.data
                : new TextDecoder().decode(evt.data as ArrayBuffer)
            );
            if (parsed.id) {
              ws.send(
                JSON.stringify({
                  id: parsed.id,
                  type: 'error',
                  error: err instanceof Error ? err.message : 'Unknown error',
                })
              );
            }
          } catch {
            // Ignore parse errors
          }
        }
      },

      async onClose(_evt, ws) {
        await manager.unregister(ws);
        logSyncEvent({
          event: 'proxy.disconnect',
          userId: auth.actorId,
        });
      },

      async onError(_evt, ws) {
        await manager.unregister(ws);
        logSyncEvent({
          event: 'proxy.error',
          userId: auth.actorId,
        });
      },
    });
  });

  return app;
}

/**
 * Get the ProxyConnectionManager from a proxy routes instance.
 */
export function getProxyConnectionManager(
  routes: Hono
): ProxyConnectionManagerHandle | undefined {
  return proxyConnectionManagerMap.get(routes);
}
