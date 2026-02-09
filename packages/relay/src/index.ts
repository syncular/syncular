/**
 * @syncular/relay - Edge Relay Server
 *
 * An edge relay server that acts as a local server to nearby clients
 * while simultaneously acting as a client to the main server.
 *
 * @example
 * ```typescript
 * import { createRelayServer } from '@syncular/relay';
 * import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
 *
 * const relay = createRelayServer({
 *   db: sqliteDb,
 *   dialect: createSqliteServerDialect(),
 *   mainServerTransport: createHttpTransport({ baseUrl: 'https://main.example.com/sync' }),
 *   mainServerClientId: 'relay-branch-001',
 *   mainServerActorId: 'relay-service',
 *   scopeKeys: ['client:acme'],
 *   handlers: shapeRegistry,
 *   subscriptions: subscriptionRegistry,
 * });
 *
 * // Mount routes for local clients
 * app.route('/sync', await relay.getRoutes());
 *
 * // Start background sync with main
 * await relay.start();
 * ```
 */

// Client role (syncing with main server)
export * from './client-role';

// Migration
export * from './migrate';

// Mode manager
export * from './mode-manager';

// Realtime WebSocket manager
export * from './realtime';

// Main exports
export * from './relay';

// Schema types
export * from './schema';

// Server role (serving local clients)
export * from './server-role';
