/**
 * @syncular/server-hono - WebSocket helpers for realtime sync wake-ups
 *
 * WebSockets can deliver bounded inline deltas and fall back to wake-ups.
 * Also supports presence tracking for collaborative features.
 */

import { RealtimeConnectionRegistry } from '@syncular/core';
import type { WSContext } from 'hono/ws';

/**
 * Presence entry for a client connected to a scope
 */
export interface PresenceEntry {
  clientId: string;
  actorId: string;
  joinedAt: number;
  metadata?: Record<string, unknown>;
}

export function createWebSocketConnectionOwnerKey(args: {
  partitionId: string;
  actorId: string;
  clientId: string;
}): string {
  return JSON.stringify([args.partitionId, args.actorId, args.clientId]);
}

/**
 * Push response data sent back to the client over WS
 */
export interface WsPushResponseData {
  requestId: string;
  ok: boolean;
  status: string;
  commitSeq?: number;
  results: Array<{ opIndex: number; status: string; [k: string]: unknown }>;
}

export type WebSocketSyncPackEncoding = 'binary-sync-pack-v1';

export interface WsHelloData {
  protocolVersion: 1;
  sessionId: string;
  shardKey: string;
  actorId: string;
  clientId: string;
  transportPath: 'direct' | 'relay';
  syncPackEncoding: WebSocketSyncPackEncoding | null;
  cursor: number;
  latestCursor: number;
  scopeCount: number;
  requiresSync: boolean;
}

export type WebSocketSyncReason =
  | 'commit'
  | 'payload-too-large'
  | 'reconnect-catchup'
  | 'server-wakeup';

export interface WebSocketSyncMetadata {
  actorId?: string;
  createdAt?: string;
  reason?: WebSocketSyncReason;
  requiresPull?: boolean;
}

/**
 * WebSocket event data for sync notifications
 */
export interface SyncWebSocketEvent {
  /** Event type */
  event:
    | 'hello'
    | 'sync'
    | 'heartbeat'
    | 'error'
    | 'presence'
    | 'push-response';
  /** Data payload */
  data: {
    /** Realtime protocol version (for hello events) */
    protocolVersion?: number;
    /** Server-generated websocket session id (for hello events) */
    sessionId?: string;
    /** Stable sequencer/fanout shard key (for hello events) */
    shardKey?: string;
    /** New cursor position (for sync events) */
    cursor?: number;
    /** Latest server cursor known when the session was accepted */
    latestCursor?: number;
    /** Number of effective scope keys attached to this connection */
    scopeCount?: number;
    /** Whether the client should run catch-up sync */
    requiresSync?: boolean;
    /** Whether this notification intentionally requires HTTP pull recovery */
    requiresPull?: boolean;
    /** Why the server sent this sync notification */
    reason?: WebSocketSyncReason;
    /** Negotiated binary sync-pack encoding, if any */
    syncPackEncoding?: WebSocketSyncPackEncoding | null;
    /** Commit actor metadata (for sync events with inline changes) */
    actorId?: string;
    /** Client/device id (for hello events) */
    clientId?: string;
    /** Transport path used by this connection */
    transportPath?: 'direct' | 'relay';
    /** Commit timestamp metadata (for sync events with inline changes) */
    createdAt?: string;
    /** Error message (for error events) */
    error?: string;
    /** Presence data (for presence events) */
    presence?: {
      action: 'join' | 'leave' | 'update' | 'snapshot';
      scopeKey: string;
      ownerKey?: string;
      clientId?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
      entries?: PresenceEntry[];
    };
    /** Push response data (for push-response events) */
    requestId?: string;
    ok?: boolean;
    status?: string;
    commitSeq?: number;
    results?: Array<{ opIndex: number; status: string; [k: string]: unknown }>;
    /** Timestamp */
    timestamp: number;
  };
}

/**
 * WebSocket connection controller for managing active connections
 */
export interface WebSocketConnection {
  /** Send session/capability handshake metadata */
  sendHello(data: WsHelloData): void;
  /** Send a sync notification, optionally with inline change data */
  sendSync(
    cursor: number,
    changes?: unknown[],
    metadata?: WebSocketSyncMetadata
  ): void;
  /** Send an encoded binary sync-pack delta */
  sendSyncPack(bytes: Uint8Array): void;
  /** Send a heartbeat */
  sendHeartbeat(): void;
  /** Send a presence event */
  sendPresence(data: {
    action: 'join' | 'leave' | 'update' | 'snapshot';
    scopeKey: string;
    ownerKey?: string;
    clientId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
    entries?: PresenceEntry[];
  }): void;
  /** Send a push response back to the client */
  sendPushResponse(data: WsPushResponseData): void;
  /** Send an error and close */
  sendError(message: string): void;
  /** Close the connection */
  close(code?: number, reason?: string): void;
  /** Whether the connection is still open */
  isOpen: boolean;
  /** Actor ID for this connection */
  actorId: string;
  /** Client/device identifier for this connection */
  clientId: string;
  /** Stable owner identity for this connection */
  ownerKey: string;
  /** Transport path used by this connection. */
  transportPath: 'direct' | 'relay';
  /** Optional binary sync-pack encoding negotiated by the client. */
  syncPackEncoding?: WebSocketSyncPackEncoding | null;
}

function safeSend(ws: WSContext, message: string | ArrayBuffer): boolean {
  try {
    ws.send(message);
    return true;
  } catch {
    return false;
  }
}

export function createRealtimeSessionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createWebSocketConnection(
  ws: WSContext,
  args: {
    actorId: string;
    clientId: string;
    ownerKey: string;
    transportPath: 'direct' | 'relay';
    syncPackEncoding?: WebSocketSyncPackEncoding | null;
  }
): WebSocketConnection {
  let closed = false;

  const connection: WebSocketConnection = {
    get isOpen() {
      if (closed) return false;
      return ws.readyState === 1;
    },
    actorId: args.actorId,
    clientId: args.clientId,
    ownerKey: args.ownerKey,
    transportPath: args.transportPath,
    syncPackEncoding: args.syncPackEncoding ?? null,
    sendHello(data: WsHelloData) {
      if (!connection.isOpen) return;
      const ok = safeSend(
        ws,
        JSON.stringify({
          event: 'hello',
          data: { ...data, timestamp: Date.now() },
        })
      );
      if (!ok) closed = true;
    },
    sendSync(
      cursor: number,
      changes?: unknown[],
      metadata?: WebSocketSyncMetadata
    ) {
      if (!connection.isOpen) return;
      const payload: Record<string, unknown> = {
        cursor,
        timestamp: Date.now(),
      };
      if (changes && changes.length > 0) {
        payload.changes = changes;
      }
      if (metadata?.actorId) {
        payload.actorId = metadata.actorId;
      }
      if (metadata?.createdAt) {
        payload.createdAt = metadata.createdAt;
      }
      if (metadata?.reason) {
        payload.reason = metadata.reason;
      }
      if (metadata?.requiresPull) {
        payload.requiresPull = true;
      }
      const ok = safeSend(ws, JSON.stringify({ event: 'sync', data: payload }));
      if (!ok) closed = true;
    },
    sendSyncPack(bytes: Uint8Array) {
      if (!connection.isOpen) return;
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      const ok = safeSend(ws, body);
      if (!ok) closed = true;
    },
    sendHeartbeat() {
      if (!connection.isOpen) return;
      const ok = safeSend(
        ws,
        JSON.stringify({ event: 'heartbeat', data: { timestamp: Date.now() } })
      );
      if (!ok) closed = true;
    },
    sendPresence(data: {
      action: 'join' | 'leave' | 'update' | 'snapshot';
      scopeKey: string;
      ownerKey?: string;
      clientId?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
      entries?: PresenceEntry[];
    }) {
      if (!connection.isOpen) return;
      const ok = safeSend(
        ws,
        JSON.stringify({
          event: 'presence',
          data: { presence: data, timestamp: Date.now() },
        })
      );
      if (!ok) closed = true;
    },
    sendPushResponse(data: WsPushResponseData) {
      if (!connection.isOpen) return;
      const ok = safeSend(
        ws,
        JSON.stringify({
          event: 'push-response',
          data: { ...data, timestamp: Date.now() },
        })
      );
      if (!ok) closed = true;
    },
    sendError(message: string) {
      if (connection.isOpen) {
        safeSend(
          ws,
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

/**
 * Connection manager for tracking active WebSocket connections.
 * Scope-key based notifications and presence tracking.
 */
export class WebSocketConnectionManager {
  private readonly registry: RealtimeConnectionRegistry<WebSocketConnection>;

  /**
   * In-memory presence tracking by scope key.
   * Map<scopeKey, Map<ownerKey, PresenceEntry>>
   */
  private presenceByScopeKey = new Map<string, Map<string, PresenceEntry>>();

  /**
   * Callback for presence changes - allows integration with SyncRealtimeBroadcaster
   */
  onPresenceChange?: (event: {
    action: 'join' | 'leave' | 'update';
    scopeKey: string;
    ownerKey: string;
    clientId: string;
    actorId: string;
    metadata?: Record<string, unknown>;
  }) => void;

  constructor(options?: {
    heartbeatIntervalMs?: number;
    onPresenceChange?: WebSocketConnectionManager['onPresenceChange'];
  }) {
    this.onPresenceChange = options?.onPresenceChange;
    this.registry = new RealtimeConnectionRegistry({
      heartbeatIntervalMs: options?.heartbeatIntervalMs,
      onOwnerDisconnected: (ownerKey) => {
        this.cleanupOwnerPresence(ownerKey);
      },
    });
  }

  /**
   * Register a connection for a client.
   * Returns a cleanup function to unregister.
   */
  register(
    connection: WebSocketConnection,
    initialScopeKeys: string[] = []
  ): () => void {
    return this.registry.register(connection, initialScopeKeys);
  }

  /**
   * Update the effective scopes for an already-connected client.
   * If the client has no active connections, this is a no-op.
   */
  updateConnectionScopeKeys(ownerKey: string, scopeKeys: string[]): void {
    this.registry.updateOwnerScopeKeys(ownerKey, scopeKeys);
  }

  /**
   * Check whether a client is currently authorized/subscribed for a scope key.
   */
  isConnectionSubscribedToScopeKey(
    ownerKey: string,
    scopeKey: string
  ): boolean {
    return this.registry.isOwnerSubscribedToScopeKey(ownerKey, scopeKey);
  }

  getConnectionScopeKeys(ownerKey: string): readonly string[] {
    return this.registry.getScopeKeysForOwner(ownerKey);
  }

  // =========================================================================
  // Presence Tracking
  // =========================================================================

  /**
   * Join presence for a scope key.
   * Called when a client wants to be visible to others in a scope.
   */
  joinPresence(
    ownerKey: string,
    scopeKey: string,
    metadata?: Record<string, unknown>
  ): boolean {
    const conns = this.registry.getConnectionsForOwner(ownerKey);
    if (!conns || conns.size === 0) return false;
    if (!this.isConnectionSubscribedToScopeKey(ownerKey, scopeKey))
      return false;

    const conn = conns.values().next().value;
    if (!conn) return false;
    const { actorId, clientId } = conn;

    let scopePresence = this.presenceByScopeKey.get(scopeKey);
    if (!scopePresence) {
      scopePresence = new Map();
      this.presenceByScopeKey.set(scopeKey, scopePresence);
    }

    const entry: PresenceEntry = {
      clientId,
      actorId,
      joinedAt: Date.now(),
      metadata,
    };
    scopePresence.set(ownerKey, entry);

    this.broadcastPresenceEvent(scopeKey, {
      action: 'join',
      scopeKey,
      ownerKey,
      clientId,
      actorId,
      metadata,
    });

    this.onPresenceChange?.({
      action: 'join',
      scopeKey,
      ownerKey,
      clientId,
      actorId,
      metadata,
    });

    return true;
  }

  /**
   * Leave presence for a scope key.
   * Called when a client no longer wants to be visible in a scope.
   */
  leavePresence(ownerKey: string, scopeKey: string): boolean {
    const scopePresence = this.presenceByScopeKey.get(scopeKey);
    if (!scopePresence) return false;

    const entry = scopePresence.get(ownerKey);
    if (!entry) return false;

    scopePresence.delete(ownerKey);
    if (scopePresence.size === 0) {
      this.presenceByScopeKey.delete(scopeKey);
    }

    this.broadcastPresenceEvent(scopeKey, {
      action: 'leave',
      scopeKey,
      ownerKey,
      clientId: entry.clientId,
      actorId: entry.actorId,
    });

    this.onPresenceChange?.({
      action: 'leave',
      scopeKey,
      ownerKey,
      clientId: entry.clientId,
      actorId: entry.actorId,
    });

    return true;
  }

  /**
   * Update presence metadata for a client in a scope.
   * Used to update what entity a user is viewing/editing.
   */
  updatePresenceMetadata(
    ownerKey: string,
    scopeKey: string,
    metadata: Record<string, unknown>
  ): boolean {
    if (!this.isConnectionSubscribedToScopeKey(ownerKey, scopeKey))
      return false;
    const scopePresence = this.presenceByScopeKey.get(scopeKey);
    if (!scopePresence) return false;

    const entry = scopePresence.get(ownerKey);
    if (!entry) return false;

    entry.metadata = metadata;

    this.broadcastPresenceEvent(scopeKey, {
      action: 'update',
      scopeKey,
      ownerKey,
      clientId: entry.clientId,
      actorId: entry.actorId,
      metadata,
    });

    this.onPresenceChange?.({
      action: 'update',
      scopeKey,
      ownerKey,
      clientId: entry.clientId,
      actorId: entry.actorId,
      metadata,
    });

    return true;
  }

  /**
   * Get presence entries for a scope key.
   */
  getPresence(scopeKey: string): PresenceEntry[] {
    const scopePresence = this.presenceByScopeKey.get(scopeKey);
    if (!scopePresence) return [];
    return Array.from(scopePresence.values());
  }

  /**
   * Get presence for multiple scopes.
   */
  getPresenceMultiple(scopeKeys: string[]): Record<string, PresenceEntry[]> {
    const result: Record<string, PresenceEntry[]> = {};
    for (const scopeKey of scopeKeys) {
      result[scopeKey] = this.getPresence(scopeKey);
    }
    return result;
  }

  /**
   * Send current presence snapshot to a specific connection.
   * Called when a client first subscribes to presence for a scope.
   */
  sendPresenceSnapshot(
    connection: WebSocketConnection,
    scopeKey: string
  ): void {
    const entries = this.getPresence(scopeKey);
    connection.sendPresence({
      action: 'snapshot',
      scopeKey,
      entries,
    });
  }

  /**
   * Handle a presence event from another server instance (via broadcaster).
   * Updates local state and notifies local clients.
   */
  handleRemotePresenceEvent(event: {
    action: 'join' | 'leave' | 'update';
    scopeKey: string;
    ownerKey?: string;
    clientId: string;
    actorId: string;
    metadata?: Record<string, unknown>;
  }): void {
    const {
      action,
      scopeKey,
      clientId,
      actorId,
      metadata,
      ownerKey = createWebSocketConnectionOwnerKey({
        partitionId: scopeKey.split(':', 1)[0] ?? 'default',
        actorId,
        clientId,
      }),
    } = event;

    let scopePresence = this.presenceByScopeKey.get(scopeKey);

    switch (action) {
      case 'join': {
        if (!scopePresence) {
          scopePresence = new Map();
          this.presenceByScopeKey.set(scopeKey, scopePresence);
        }
        scopePresence.set(ownerKey, {
          clientId,
          actorId,
          joinedAt: Date.now(),
          metadata,
        });
        break;
      }
      case 'leave': {
        if (scopePresence) {
          scopePresence.delete(ownerKey);
          if (scopePresence.size === 0) {
            this.presenceByScopeKey.delete(scopeKey);
          }
        }
        break;
      }
      case 'update': {
        if (scopePresence) {
          const entry = scopePresence.get(ownerKey);
          if (entry) {
            entry.metadata = metadata;
          }
        }
        break;
      }
    }

    // Notify local clients
    this.broadcastPresenceEvent(scopeKey, event);
  }

  /**
   * Broadcast a presence event to all clients subscribed to a scope key.
   */
  private broadcastPresenceEvent(
    scopeKey: string,
    event: {
      action: 'join' | 'leave' | 'update';
      scopeKey: string;
      ownerKey?: string;
      clientId?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
    }
  ): void {
    this.registry.forEachConnectionInScopeKeys(
      [scopeKey],
      (conn) => {
        conn.sendPresence(event);
      },
      {
        excludeClientIds: event.clientId ? [event.clientId] : undefined,
      }
    );
  }

  /**
   * Clean up presence when an owner fully disconnects (all connections closed).
   */
  private cleanupOwnerPresence(ownerKey: string): void {
    for (const [scopeKey, scopePresence] of this.presenceByScopeKey) {
      const entry = scopePresence.get(ownerKey);
      if (!entry) continue;

      scopePresence.delete(ownerKey);
      if (scopePresence.size === 0) {
        this.presenceByScopeKey.delete(scopeKey);
      }

      this.broadcastPresenceEvent(scopeKey, {
        action: 'leave',
        scopeKey,
        ownerKey,
        clientId: entry.clientId,
        actorId: entry.actorId,
      });

      this.onPresenceChange?.({
        action: 'leave',
        scopeKey,
        ownerKey,
        clientId: entry.clientId,
        actorId: entry.actorId,
      });
    }
  }

  // =========================================================================
  // Sync Notifications
  // =========================================================================

  /**
   * Maximum serialized size (bytes) for inline WS change delivery.
   * Larger payloads fall back to cursor-only notification.
   */
  private static readonly WS_INLINE_MAX_BYTES = 64 * 1024;

  /**
   * Notify clients that new data is available for the given scopes.
   * Dedupes connections that match multiple scopes.
   */
  notifyScopeKeys(
    scopeKeys: string[],
    cursor: number,
    opts?: {
      excludeClientIds?: string[];
      changes?: unknown[];
      syncPack?: Uint8Array;
      changesForConnection?: (connection: WebSocketConnection) => unknown[];
      syncPackForConnection?: (
        connection: WebSocketConnection
      ) => Uint8Array | undefined;
      actorId?: string;
      createdAt?: string;
    }
  ): void {
    // Size guard: only deliver inline changes if under threshold
    let inlineChanges: unknown[] | undefined;
    const hasSharedChanges = (opts?.changes?.length ?? 0) > 0;
    if (opts?.changes && opts.changes.length > 0) {
      const serialized = JSON.stringify(opts.changes);
      if (serialized.length <= WebSocketConnectionManager.WS_INLINE_MAX_BYTES) {
        inlineChanges = opts.changes;
      }
    }
    const inlineSyncPack =
      opts?.syncPack &&
      opts.syncPack.byteLength <= WebSocketConnectionManager.WS_INLINE_MAX_BYTES
        ? opts.syncPack
        : undefined;

    this.registry.forEachConnectionInScopeKeys(
      scopeKeys,
      (conn) => {
        const connectionSyncPack =
          opts?.syncPackForConnection?.(conn) ?? inlineSyncPack;
        if (
          connectionSyncPack &&
          connectionSyncPack.byteLength <=
            WebSocketConnectionManager.WS_INLINE_MAX_BYTES &&
          conn.syncPackEncoding === 'binary-sync-pack-v1'
        ) {
          conn.sendSyncPack(connectionSyncPack);
          return;
        }
        const connectionChanges =
          opts?.changesForConnection?.(conn) ?? inlineChanges;
        const canSendConnectionChanges =
          connectionChanges &&
          connectionChanges.length > 0 &&
          JSON.stringify(connectionChanges).length <=
            WebSocketConnectionManager.WS_INLINE_MAX_BYTES;
        if (canSendConnectionChanges) {
          conn.sendSync(cursor, connectionChanges, {
            actorId: opts?.actorId,
            createdAt: opts?.createdAt,
            reason: 'commit',
          });
        } else {
          conn.sendSync(cursor, undefined, {
            reason:
              connectionSyncPack ||
              connectionChanges?.length ||
              hasSharedChanges
                ? 'payload-too-large'
                : 'server-wakeup',
            requiresPull: true,
          });
        }
      },
      { excludeClientIds: opts?.excludeClientIds }
    );
  }

  /**
   * Notify all connected clients of a new cursor position.
   * Used for external data changes that affect all clients regardless of scope.
   */
  notifyAllClients(cursor: number): void {
    this.registry.forEachConnection((conn) => {
      conn.sendSync(cursor, undefined, {
        reason: 'server-wakeup',
        requiresPull: true,
      });
    });
  }

  /**
   * Get the number of active connections for a client.
   */
  getConnectionCount(clientId: string): number {
    return this.registry.getConnectionCount(clientId);
  }

  /**
   * Get the number of active connections for one owner identity.
   */
  getScopedConnectionCount(ownerKey: string): number {
    return this.registry.getScopedConnectionCount(ownerKey);
  }

  /**
   * Get the current transport path for a client if connected.
   */
  getClientTransportPath(clientId: string): 'direct' | 'relay' | null {
    const conns = this.registry.getConnectionsForClient(clientId);
    if (!conns || conns.size === 0) {
      return null;
    }

    for (const conn of conns) {
      if (conn.transportPath === 'relay') {
        return 'relay';
      }
    }

    return 'direct';
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
    this.presenceByScopeKey.clear();
  }
}
