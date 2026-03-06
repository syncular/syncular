export interface RealtimeConnection {
  readonly clientId: string;
  readonly ownerKey: string;
  readonly isOpen: boolean;
  sendHeartbeat(): void;
  close(code?: number, reason?: string): void;
}

export class RealtimeConnectionRegistry<
  TConnection extends RealtimeConnection,
> {
  private connectionsByOwnerKey = new Map<string, Set<TConnection>>();
  private connectionsByClientId = new Map<string, Set<TConnection>>();
  private scopeKeysByOwnerKey = new Map<string, Set<string>>();
  private connectionsByScopeKey = new Map<string, Set<TConnection>>();

  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onOwnerDisconnected?: (ownerKey: string) => void;

  constructor(options?: {
    heartbeatIntervalMs?: number;
    onOwnerDisconnected?: (ownerKey: string) => void;
  }) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
    this.onOwnerDisconnected = options?.onOwnerDisconnected;
  }

  register(
    connection: TConnection,
    initialScopeKeys: string[] = []
  ): () => void {
    const ownerKey = connection.ownerKey;
    let ownerConns = this.connectionsByOwnerKey.get(ownerKey);
    if (!ownerConns) {
      ownerConns = new Set();
      this.connectionsByOwnerKey.set(ownerKey, ownerConns);
    }
    ownerConns.add(connection);

    let clientConns = this.connectionsByClientId.get(connection.clientId);
    if (!clientConns) {
      clientConns = new Set();
      this.connectionsByClientId.set(connection.clientId, clientConns);
    }
    clientConns.add(connection);

    if (!this.scopeKeysByOwnerKey.has(ownerKey)) {
      this.scopeKeysByOwnerKey.set(ownerKey, new Set(initialScopeKeys));
    }

    const scopeKeys = this.scopeKeysByOwnerKey.get(ownerKey);
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

  updateOwnerScopeKeys(ownerKey: string, scopeKeys: string[]): void {
    const conns = this.connectionsByOwnerKey.get(ownerKey);
    if (!conns || conns.size === 0) return;

    const next = new Set(scopeKeys);
    const prev = this.scopeKeysByOwnerKey.get(ownerKey) ?? new Set<string>();

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

    this.scopeKeysByOwnerKey.set(ownerKey, next);

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

  isOwnerSubscribedToScopeKey(ownerKey: string, scopeKey: string): boolean {
    const scopeKeys = this.scopeKeysByOwnerKey.get(ownerKey);
    if (!scopeKeys || scopeKeys.size === 0) return false;
    return scopeKeys.has(scopeKey);
  }

  getConnectionsForOwner(
    ownerKey: string
  ): ReadonlySet<TConnection> | undefined {
    return this.connectionsByOwnerKey.get(ownerKey);
  }

  getScopedConnectionCount(ownerKey: string): number {
    return this.connectionsByOwnerKey.get(ownerKey)?.size ?? 0;
  }

  getConnectionsForClient(
    clientId: string
  ): ReadonlySet<TConnection> | undefined {
    return this.connectionsByClientId.get(clientId);
  }

  getConnectionCount(clientId: string): number {
    return this.connectionsByClientId.get(clientId)?.size ?? 0;
  }

  getTotalConnections(): number {
    let total = 0;
    for (const conns of this.connectionsByOwnerKey.values()) {
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
    for (const conns of this.connectionsByOwnerKey.values()) {
      for (const conn of conns) {
        if (!conn.isOpen) continue;
        visitor(conn);
      }
    }
  }

  closeOwnerConnections(ownerKey: string, code?: number, reason?: string): void {
    const conns = this.connectionsByOwnerKey.get(ownerKey);
    if (!conns) return;

    for (const conn of Array.from(conns)) {
      conn.close(code, reason);
      this.unregister(conn);
    }

    this.ensureHeartbeat();
  }

  closeClientConnections(
    clientId: string,
    code?: number,
    reason?: string
  ): void {
    const conns = this.connectionsByClientId.get(clientId);
    if (!conns) return;

    for (const conn of Array.from(conns)) {
      conn.close(code, reason);
      this.unregister(conn);
    }
    this.ensureHeartbeat();
  }

  closeAll(code?: number, reason?: string): void {
    for (const conns of this.connectionsByOwnerKey.values()) {
      for (const conn of Array.from(conns)) {
        conn.close(code, reason);
        this.unregister(conn);
      }
    }
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
    for (const conns of this.connectionsByOwnerKey.values()) {
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
    const ownerKey = connection.ownerKey;

    const scopeKeys = this.scopeKeysByOwnerKey.get(ownerKey);
    if (scopeKeys) {
      for (const key of scopeKeys) {
        const scopedConns = this.connectionsByScopeKey.get(key);
        if (!scopedConns) continue;
        scopedConns.delete(connection);
        if (scopedConns.size === 0) this.connectionsByScopeKey.delete(key);
      }
    }

    const ownerConns = this.connectionsByOwnerKey.get(ownerKey);
    if (ownerConns) {
      ownerConns.delete(connection);
      if (ownerConns.size === 0) {
        this.connectionsByOwnerKey.delete(ownerKey);
        this.scopeKeysByOwnerKey.delete(ownerKey);
        this.onOwnerDisconnected?.(ownerKey);
      }
    }

    const clientConns = this.connectionsByClientId.get(connection.clientId);
    if (!clientConns) return;
    clientConns.delete(connection);
    if (clientConns.size === 0) {
      this.connectionsByClientId.delete(connection.clientId);
    }
  }
}
