export interface RealtimeConnection {
  readonly clientId: string;
  readonly isOpen: boolean;
  sendHeartbeat(): void;
  close(code?: number, reason?: string): void;
}

export class RealtimeConnectionRegistry<
  TConnection extends RealtimeConnection,
> {
  private connectionsByClientId = new Map<string, Set<TConnection>>();
  private scopeKeysByClientId = new Map<string, Set<string>>();
  private connectionsByScopeKey = new Map<string, Set<TConnection>>();

  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onClientDisconnected?: (clientId: string) => void;

  constructor(options?: {
    heartbeatIntervalMs?: number;
    onClientDisconnected?: (clientId: string) => void;
  }) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
    this.onClientDisconnected = options?.onClientDisconnected;
  }

  register(connection: TConnection, initialScopeKeys: string[] = []): () => void {
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

    const scopeKeys = this.scopeKeysByClientId.get(clientId);
    if (scopeKeys) {
      for (const key of scopeKeys) {
        let scopedConns = this.connectionsByScopeKey.get(key);
        if (!scopedConns) {
          scopedConns = new Set();
          this.connectionsByScopeKey.set(key, scopedConns);
        }
        scopedConns.add(connection);
      }
    }

    this.ensureHeartbeat();
    return () => {
      this.unregister(connection);
      this.ensureHeartbeat();
    };
  }

  updateClientScopeKeys(clientId: string, scopeKeys: string[]): void {
    const conns = this.connectionsByClientId.get(clientId);
    if (!conns || conns.size === 0) return;

    const next = new Set(scopeKeys);
    const prev = this.scopeKeysByClientId.get(clientId) ?? new Set<string>();

    if (prev.size === next.size) {
      let unchanged = true;
      for (const key of prev) {
        if (!next.has(key)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return;
    }

    this.scopeKeysByClientId.set(clientId, next);

    for (const key of prev) {
      if (next.has(key)) continue;
      const scopedConns = this.connectionsByScopeKey.get(key);
      if (!scopedConns) continue;
      for (const conn of conns) scopedConns.delete(conn);
      if (scopedConns.size === 0) this.connectionsByScopeKey.delete(key);
    }

    for (const key of next) {
      if (prev.has(key)) continue;
      let scopedConns = this.connectionsByScopeKey.get(key);
      if (!scopedConns) {
        scopedConns = new Set();
        this.connectionsByScopeKey.set(key, scopedConns);
      }
      for (const conn of conns) scopedConns.add(conn);
    }
  }

  isClientSubscribedToScopeKey(clientId: string, scopeKey: string): boolean {
    const scopeKeys = this.scopeKeysByClientId.get(clientId);
    if (!scopeKeys || scopeKeys.size === 0) return false;
    return scopeKeys.has(scopeKey);
  }

  getConnectionsForClient(clientId: string): ReadonlySet<TConnection> | undefined {
    return this.connectionsByClientId.get(clientId);
  }

  getConnectionCount(clientId: string): number {
    return this.connectionsByClientId.get(clientId)?.size ?? 0;
  }

  getTotalConnections(): number {
    let total = 0;
    for (const conns of this.connectionsByClientId.values()) {
      total += conns.size;
    }
    return total;
  }

  forEachConnectionInScopeKeys(
    scopeKeys: Iterable<string>,
    visitor: (connection: TConnection) => void,
    options?: { excludeClientIds?: readonly string[] }
  ): void {
    const targets = new Set<TConnection>();
    for (const key of scopeKeys) {
      const conns = this.connectionsByScopeKey.get(key);
      if (!conns) continue;
      for (const conn of conns) targets.add(conn);
    }

    const excludedClientIds = new Set(options?.excludeClientIds ?? []);
    for (const conn of targets) {
      if (!conn.isOpen) continue;
      if (excludedClientIds.has(conn.clientId)) continue;
      visitor(conn);
    }
  }

  forEachConnection(visitor: (connection: TConnection) => void): void {
    for (const conns of this.connectionsByClientId.values()) {
      for (const conn of conns) {
        if (!conn.isOpen) continue;
        visitor(conn);
      }
    }
  }

  closeClientConnections(
    clientId: string,
    code?: number,
    reason?: string
  ): void {
    const conns = this.connectionsByClientId.get(clientId);
    if (!conns) return;

    const scopeKeys = this.scopeKeysByClientId.get(clientId);
    if (scopeKeys) {
      for (const key of scopeKeys) {
        const scopedConns = this.connectionsByScopeKey.get(key);
        if (!scopedConns) continue;
        for (const conn of conns) scopedConns.delete(conn);
        if (scopedConns.size === 0) this.connectionsByScopeKey.delete(key);
      }
    }

    for (const conn of conns) {
      conn.close(code, reason);
    }

    this.connectionsByClientId.delete(clientId);
    this.scopeKeysByClientId.delete(clientId);
    this.ensureHeartbeat();
  }

  closeAll(code?: number, reason?: string): void {
    for (const conns of this.connectionsByClientId.values()) {
      for (const conn of conns) {
        conn.close(code, reason);
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
    const closedConnections: TConnection[] = [];
    for (const conns of this.connectionsByClientId.values()) {
      for (const conn of conns) {
        if (!conn.isOpen) {
          closedConnections.push(conn);
          continue;
        }
        conn.sendHeartbeat();
      }
    }

    for (const conn of closedConnections) {
      this.unregister(conn);
    }

    this.ensureHeartbeat();
  }

  private unregister(connection: TConnection): void {
    const clientId = connection.clientId;

    const scopeKeys = this.scopeKeysByClientId.get(clientId);
    if (scopeKeys) {
      for (const key of scopeKeys) {
        const scopedConns = this.connectionsByScopeKey.get(key);
        if (!scopedConns) continue;
        scopedConns.delete(connection);
        if (scopedConns.size === 0) this.connectionsByScopeKey.delete(key);
      }
    }

    const conns = this.connectionsByClientId.get(clientId);
    if (!conns) return;
    conns.delete(connection);
    if (conns.size > 0) return;

    this.connectionsByClientId.delete(clientId);
    this.scopeKeysByClientId.delete(clientId);
    this.onClientDisconnected?.(clientId);
  }
}
