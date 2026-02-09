/**
 * @syncular/relay - Realtime WebSocket Manager
 *
 * Manages WebSocket connections for local clients to receive
 * instant notifications when data changes.
 *
 * Adapted from @syncular/server-hono/ws.ts for relay use.
 */

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
  private connectionsByClientId = new Map<
    string,
    Set<RelayWebSocketConnection>
  >();
  private scopeKeysByClientId = new Map<string, Set<string>>();
  private connectionsByScopeKey = new Map<
    string,
    Set<RelayWebSocketConnection>
  >();

  private heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { heartbeatIntervalMs?: number }) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
  }

  /**
   * Register a connection for a client.
   * Returns a cleanup function to unregister.
   */
  register(
    connection: RelayWebSocketConnection,
    initialScopeKeys: string[] = []
  ): () => void {
    const clientId = connection.clientId;
    let clientConns = this.connectionsByClientId.get(clientId);
    if (!clientConns) {
      clientConns = new Set();
      this.connectionsByClientId.set(clientId, clientConns);
    }
    clientConns.add(connection);

    if (!this.scopeKeysByClientId.has(clientId)) {
      this.scopeKeysByClientId.set(clientId, new Set(initialScopeKeys));
    }

    const scopeKeys =
      this.scopeKeysByClientId.get(clientId) ?? new Set<string>();
    for (const k of scopeKeys) {
      let scopeConns = this.connectionsByScopeKey.get(k);
      if (!scopeConns) {
        scopeConns = new Set();
        this.connectionsByScopeKey.set(k, scopeConns);
      }
      scopeConns.add(connection);
    }

    this.ensureHeartbeat();

    return () => {
      this.unregister(connection);
      this.ensureHeartbeat();
    };
  }

  /**
   * Update the effective tables/scopes for an already-connected client.
   * In the new scope model, this is called with table names.
   */
  updateClientTables(clientId: string, tables: string[]): void {
    this._updateScopeKeys(clientId, tables);
  }

  /**
   * Alias for backwards compatibility.
   */
  updateClientScopeKeys(clientId: string, scopeKeys: string[]): void {
    this._updateScopeKeys(clientId, scopeKeys);
  }

  private _updateScopeKeys(clientId: string, keys: string[]): void {
    const conns = this.connectionsByClientId.get(clientId);
    if (!conns || conns.size === 0) return;

    const next = new Set<string>(keys);
    const prev = this.scopeKeysByClientId.get(clientId) ?? new Set<string>();

    // No-op when unchanged
    if (prev.size === next.size) {
      let unchanged = true;
      for (const k of prev) {
        if (!next.has(k)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return;
    }

    this.scopeKeysByClientId.set(clientId, next);

    // Remove from old scopes
    for (const k of prev) {
      if (next.has(k)) continue;
      const set = this.connectionsByScopeKey.get(k);
      if (!set) continue;
      for (const conn of conns) set.delete(conn);
      if (set.size === 0) this.connectionsByScopeKey.delete(k);
    }

    // Add to new scopes
    for (const k of next) {
      if (prev.has(k)) continue;
      let set = this.connectionsByScopeKey.get(k);
      if (!set) {
        set = new Set();
        this.connectionsByScopeKey.set(k, set);
      }
      for (const conn of conns) set.add(conn);
    }
  }

  /**
   * Notify clients that new data is available for the given scopes.
   */
  notifyScopeKeys(
    scopeKeys: string[],
    cursor: number,
    opts?: { excludeClientIds?: string[] }
  ): void {
    const exclude = new Set(opts?.excludeClientIds ?? []);
    const targets = new Set<RelayWebSocketConnection>();

    for (const k of scopeKeys) {
      const conns = this.connectionsByScopeKey.get(k);
      if (!conns) continue;
      for (const conn of conns) targets.add(conn);
    }

    for (const conn of targets) {
      if (!conn.isOpen) continue;
      if (exclude.has(conn.clientId)) continue;
      conn.sendSync(cursor);
    }
  }

  /**
   * Get the number of active connections for a client.
   */
  getConnectionCount(clientId: string): number {
    return this.connectionsByClientId.get(clientId)?.size ?? 0;
  }

  /**
   * Get total number of active connections.
   */
  getTotalConnections(): number {
    let total = 0;
    for (const conns of this.connectionsByClientId.values()) {
      total += conns.size;
    }
    return total;
  }

  /**
   * Close all connections for a client.
   */
  closeClientConnections(clientId: string): void {
    const conns = this.connectionsByClientId.get(clientId);
    if (!conns) return;

    const scopeKeys =
      this.scopeKeysByClientId.get(clientId) ?? new Set<string>();
    for (const k of scopeKeys) {
      const set = this.connectionsByScopeKey.get(k);
      if (!set) continue;
      for (const conn of conns) set.delete(conn);
      if (set.size === 0) this.connectionsByScopeKey.delete(k);
    }

    for (const conn of conns) {
      conn.close(1000, 'client closed');
    }
    this.connectionsByClientId.delete(clientId);
    this.scopeKeysByClientId.delete(clientId);
    this.ensureHeartbeat();
  }

  /**
   * Close all connections.
   */
  closeAll(): void {
    for (const conns of this.connectionsByClientId.values()) {
      for (const conn of conns) {
        conn.close(1000, 'server shutdown');
      }
    }
    this.connectionsByClientId.clear();
    this.scopeKeysByClientId.clear();
    this.connectionsByScopeKey.clear();
    this.ensureHeartbeat();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return;

    const total = this.getTotalConnections();

    if (total === 0) {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      return;
    }

    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeats(): void {
    const closed: RelayWebSocketConnection[] = [];

    for (const conns of this.connectionsByClientId.values()) {
      for (const conn of conns) {
        if (!conn.isOpen) {
          closed.push(conn);
          continue;
        }
        conn.sendHeartbeat();
      }
    }

    for (const conn of closed) {
      this.unregister(conn);
    }

    this.ensureHeartbeat();
  }

  private unregister(connection: RelayWebSocketConnection): void {
    const clientId = connection.clientId;

    const scopeKeys =
      this.scopeKeysByClientId.get(clientId) ?? new Set<string>();
    for (const k of scopeKeys) {
      const set = this.connectionsByScopeKey.get(k);
      if (!set) continue;
      set.delete(connection);
      if (set.size === 0) this.connectionsByScopeKey.delete(k);
    }

    const conns = this.connectionsByClientId.get(clientId);
    if (!conns) return;
    conns.delete(connection);
    if (conns.size > 0) return;

    this.connectionsByClientId.delete(clientId);
    this.scopeKeysByClientId.delete(clientId);
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
