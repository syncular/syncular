/**
 * @syncular/relay - Realtime WebSocket Manager
 *
 * Manages WebSocket connections for local clients to receive
 * instant notifications when data changes.
 *
 * Adapted from @syncular/server-hono/ws.ts for relay use.
 */

import { RealtimeConnectionRegistry } from '@syncular/core';

/**
 * WebSocket event data for sync notifications.
 */
export interface RelayWebSocketEvent {
  event: 'sync' | 'heartbeat' | 'error';
  data: {
    cursor?: number;
    error?: string;
    timestamp: number;
  };
}

/**
 * WebSocket connection interface for the relay.
 */
export interface RelayWebSocketConnection {
  sendSync(cursor: number): void;
  sendHeartbeat(): void;
  sendError(message: string): void;
  close(code?: number, reason?: string): void;
  isOpen: boolean;
  actorId: string;
  clientId: string;
}

/**
 * Realtime manager for relay WebSocket connections.
 *
 * Tracks active connections by client ID and scope key for
 * efficient notification routing.
 */
export class RelayRealtime {
  private readonly registry: RealtimeConnectionRegistry<RelayWebSocketConnection>;

  constructor(options?: { heartbeatIntervalMs?: number }) {
    this.registry = new RealtimeConnectionRegistry({
      heartbeatIntervalMs: options?.heartbeatIntervalMs,
    });
  }

  /**
   * Register a connection for a client.
   * Returns a cleanup function to unregister.
   */
  register(
    connection: RelayWebSocketConnection,
    initialScopeKeys: string[] = []
  ): () => void {
    return this.registry.register(connection, initialScopeKeys);
  }

  /**
   * Update the effective scopes for an already-connected client.
   */
  updateClientScopeKeys(clientId: string, scopeKeys: string[]): void {
    this.registry.updateClientScopeKeys(clientId, scopeKeys);
  }

  /**
   * Notify clients that new data is available for the given scopes.
   */
  notifyScopeKeys(
    scopeKeys: string[],
    cursor: number,
    opts?: { excludeClientIds?: string[] }
  ): void {
    this.registry.forEachConnectionInScopeKeys(
      scopeKeys,
      (conn) => {
        conn.sendSync(cursor);
      },
      { excludeClientIds: opts?.excludeClientIds }
    );
  }

  /**
   * Get the number of active connections for a client.
   */
  getConnectionCount(clientId: string): number {
    return this.registry.getConnectionCount(clientId);
  }

  /**
   * Get total number of active connections.
   */
  getTotalConnections(): number {
    return this.registry.getTotalConnections();
  }

  /**
   * Close all connections for a client.
   */
  closeClientConnections(clientId: string): void {
    this.registry.closeClientConnections(clientId, 1000, 'client closed');
  }

  /**
   * Close all connections.
   */
  closeAll(): void {
    this.registry.closeAll(1000, 'server shutdown');
  }
}

/**
 * Create a WebSocket connection wrapper.
 *
 * Use this with your WebSocket library to create connections
 * compatible with RelayRealtime.
 */
export function createRelayWebSocketConnection(
  ws: {
    send(message: string): void;
    close(code?: number, reason?: string): void;
    readyState: number;
  },
  args: { actorId: string; clientId: string }
): RelayWebSocketConnection {
  let closed = false;

  function safeSend(message: string): boolean {
    try {
      ws.send(message);
      return true;
    } catch {
      return false;
    }
  }

  const connection: RelayWebSocketConnection = {
    get isOpen() {
      if (closed) return false;
      return ws.readyState === 1;
    },
    actorId: args.actorId,
    clientId: args.clientId,
    sendSync(cursor: number) {
      if (!connection.isOpen) return;
      const ok = safeSend(
        JSON.stringify({
          event: 'sync',
          data: { cursor, timestamp: Date.now() },
        })
      );
      if (!ok) closed = true;
    },
    sendHeartbeat() {
      if (!connection.isOpen) return;
      const ok = safeSend(
        JSON.stringify({ event: 'heartbeat', data: { timestamp: Date.now() } })
      );
      if (!ok) closed = true;
    },
    sendError(message: string) {
      if (connection.isOpen) {
        safeSend(
          JSON.stringify({
            event: 'error',
            data: { error: message, timestamp: Date.now() },
          })
        );
      }
      connection.close(1011, 'server error');
    },
    close(code?: number, reason?: string) {
      if (closed) return;
      closed = true;
      try {
        ws.close(code, reason);
      } catch {
        // ignore
      }
    },
  };

  return connection;
}
