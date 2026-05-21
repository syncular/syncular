/**
 * @syncular/server-hono - WebSocket helpers for realtime sync wake-ups
 *
 * WebSockets deliver binary sync-pack deltas or explicit pull-required wake-ups.
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
  | 'payload-too-large'
  | 'reconnect-catchup'
  | 'resync-required'
  | 'server-wakeup';

export interface WebSocketSyncMetadata {
  reason?: WebSocketSyncReason;
  requiresPull?: boolean;
  droppedCount?: number;
}

interface WebSocketReplayRecord {
  scopeKeys: string[];
  cursor: number;
  syncPack?: Uint8Array;
  syncPackForConnection?: (
    connection: WebSocketConnection
  ) => Uint8Array | undefined;
  hasSharedPayload: boolean;
}

export interface WebSocketRealtimeSubscription {
  id: string;
  table: string;
  scopes: Record<string, string | string[]>;
  scopeKeys: string[];
  cursor: number;
  verifiedRoot?: string | null;
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
    /** Number of realtime payload notifications skipped while waiting for ACK */
    droppedCount?: number;
    /** Why the server sent this sync notification */
    reason?: WebSocketSyncReason;
    /** Negotiated binary sync-pack encoding, if any */
    syncPackEncoding?: WebSocketSyncPackEncoding | null;
    /** Client/device id (for hello events) */
    clientId?: string;
    /** Transport path used by this connection */
    transportPath?: 'direct' | 'relay';
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
  /** Send a sync wake-up notification. */
  sendSync(cursor: number, metadata?: WebSocketSyncMetadata): void;
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
    sendSync(cursor: number, metadata?: WebSocketSyncMetadata) {
      if (!connection.isOpen) return;
      const payload: Record<string, unknown> = {
        cursor,
        timestamp: Date.now(),
      };
      if (metadata?.reason) {
        payload.reason = metadata.reason;
      }
      if (metadata?.requiresPull) {
        payload.requiresPull = true;
      }
      if (metadata?.droppedCount !== undefined) {
        payload.droppedCount = metadata.droppedCount;
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
  private readonly replayWindowSize: number;
  private readonly replayRecords: WebSocketReplayRecord[] = [];
  private readonly subscriptionsByOwnerKey = new Map<
    string,
    WebSocketRealtimeSubscription[]
  >();
  private replayDroppedThroughCursor = -1;
  private readonly flowStateByConnection = new WeakMap<
    WebSocketConnection,
    {
      lastAckedCursor: number;
      lastSentCursor: number;
      inFlightCursors: number[];
      resyncRequired: boolean;
      droppedCount: number;
    }
  >();
  private readonly maxInFlightSyncsPerConnection: number;

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
    maxInFlightSyncsPerConnection?: number;
    replayWindowSize?: number;
    onPresenceChange?: WebSocketConnectionManager['onPresenceChange'];
  }) {
    this.onPresenceChange = options?.onPresenceChange;
    this.maxInFlightSyncsPerConnection =
      options?.maxInFlightSyncsPerConnection ?? 64;
    this.replayWindowSize = normalizeReplayWindowSize(
      options?.replayWindowSize
    );
    this.registry = new RealtimeConnectionRegistry({
      heartbeatIntervalMs: options?.heartbeatIntervalMs,
      onOwnerDisconnected: (ownerKey) => {
        this.cleanupOwnerPresence(ownerKey);
      },
    });
  }

  recordAck(connection: WebSocketConnection, cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    const state = this.getFlowState(connection);
    if (cursor <= state.lastAckedCursor) return;
    state.lastAckedCursor = cursor;
    state.inFlightCursors = state.inFlightCursors.filter(
      (inFlightCursor) => inFlightCursor > cursor
    );
    if (cursor >= state.lastSentCursor) {
      state.inFlightCursors = [];
      state.resyncRequired = false;
      state.droppedCount = 0;
    }
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
   * Update the active pull subscriptions for an owner. Realtime binary deltas
   * use these records to emit the same per-subscription integrity contract as
   * HTTP pull responses.
   */
  updateConnectionSubscriptions(
    ownerKey: string,
    subscriptions: WebSocketRealtimeSubscription[]
  ): void {
    if (subscriptions.length === 0) {
      this.subscriptionsByOwnerKey.delete(ownerKey);
      this.registry.updateOwnerScopeKeys(ownerKey, []);
      return;
    }

    this.subscriptionsByOwnerKey.set(
      ownerKey,
      subscriptions.map((subscription) => ({
        ...subscription,
        scopeKeys: [...subscription.scopeKeys],
      }))
    );
    this.registry.updateOwnerScopeKeys(
      ownerKey,
      uniqueScopeKeys(
        subscriptions.flatMap((subscription) => subscription.scopeKeys)
      )
    );
  }

  updateConnectionSubscriptionRoots(
    ownerKey: string,
    updates: Array<{
      subscriptionId: string;
      cursor: number;
      verifiedRoot: string;
    }>
  ): void {
    if (updates.length === 0) return;
    const subscriptions = this.subscriptionsByOwnerKey.get(ownerKey);
    if (!subscriptions || subscriptions.length === 0) return;

    const updatesBySubscription = new Map(
      updates.map((update) => [update.subscriptionId, update])
    );
    let changed = false;
    const next = subscriptions.map((subscription) => {
      const update = updatesBySubscription.get(subscription.id);
      if (!update) return subscription;
      changed = true;
      return {
        ...subscription,
        cursor: Math.max(subscription.cursor, update.cursor),
        verifiedRoot: update.verifiedRoot,
      };
    });
    if (changed) {
      this.subscriptionsByOwnerKey.set(ownerKey, next);
    }
  }

  getConnectionSubscriptions(
    ownerKey: string
  ): readonly WebSocketRealtimeSubscription[] {
    return this.subscriptionsByOwnerKey.get(ownerKey) ?? [];
  }

  getConnectionsForScopeKeys(
    scopeKeys: Iterable<string>,
    options?: { excludeClientIds?: readonly string[] }
  ): WebSocketConnection[] {
    const connections: WebSocketConnection[] = [];
    this.registry.forEachConnectionInScopeKeys(
      scopeKeys,
      (connection) => connections.push(connection),
      options
    );
    return connections;
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

  /**
   * Replay recent websocket delta notifications for a reconnecting client.
   * Returns false when the requested cursor range is no longer fully in memory,
   * so the caller can send an explicit pull-required recovery frame.
   */
  replayScopeKeys(
    connection: WebSocketConnection,
    scopeKeys: string[],
    fromCursor: number,
    latestCursor: number
  ): boolean {
    if (
      !Number.isSafeInteger(fromCursor) ||
      !Number.isSafeInteger(latestCursor)
    ) {
      return false;
    }
    if (latestCursor <= fromCursor) {
      return true;
    }
    if (scopeKeys.length === 0 || this.replayRecords.length === 0) {
      return false;
    }
    if (fromCursor < this.replayDroppedThroughCursor) {
      return false;
    }

    const scopeKeySet = new Set(scopeKeys);
    const records = this.replayRecords.filter(
      (record) =>
        record.cursor > fromCursor &&
        record.cursor <= latestCursor &&
        record.scopeKeys.some((scopeKey) => scopeKeySet.has(scopeKey))
    );
    if (records.length === 0) {
      return false;
    }

    const lastRecordCursor = records.reduce(
      (cursor, record) => Math.max(cursor, record.cursor),
      fromCursor
    );
    if (lastRecordCursor < latestCursor) {
      return false;
    }

    for (const record of records) {
      this.deliverSyncRecordToConnection(connection, record);
    }
    return true;
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
   * Maximum encoded sync-pack size sent directly over a websocket frame.
   * Larger payloads fall back to explicit HTTP pull recovery.
   */
  private static readonly WS_SYNC_PACK_MAX_BYTES = 64 * 1024;

  /**
   * Notify clients that new data is available for the given scopes.
   * Dedupes connections that match multiple scopes.
   */
  notifyScopeKeys(
    scopeKeys: string[],
    cursor: number,
    opts?: {
      excludeClientIds?: string[];
      syncPack?: Uint8Array;
      syncPackForConnection?: (
        connection: WebSocketConnection
      ) => Uint8Array | undefined;
    }
  ): void {
    const websocketSyncPack =
      opts?.syncPack &&
      opts.syncPack.byteLength <=
        WebSocketConnectionManager.WS_SYNC_PACK_MAX_BYTES
        ? opts.syncPack
        : undefined;
    const replayRecord: WebSocketReplayRecord = {
      scopeKeys: [...scopeKeys],
      cursor,
      syncPack: websocketSyncPack,
      syncPackForConnection: opts?.syncPackForConnection,
      hasSharedPayload:
        opts?.syncPack !== undefined ||
        opts?.syncPackForConnection !== undefined,
    };
    this.rememberReplayRecord(replayRecord);

    this.registry.forEachConnectionInScopeKeys(
      scopeKeys,
      (conn) => {
        this.deliverSyncRecordToConnection(conn, replayRecord);
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
      if (this.shouldSendResyncRequired(conn, cursor)) {
        this.sendResyncRequired(conn, cursor);
        return;
      }
      this.markSyncSent(conn, cursor);
      conn.sendSync(cursor, {
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

  private getFlowState(connection: WebSocketConnection): {
    lastAckedCursor: number;
    lastSentCursor: number;
    inFlightCursors: number[];
    resyncRequired: boolean;
    droppedCount: number;
  } {
    let state = this.flowStateByConnection.get(connection);
    if (!state) {
      state = {
        lastAckedCursor: -1,
        lastSentCursor: -1,
        inFlightCursors: [],
        resyncRequired: false,
        droppedCount: 0,
      };
      this.flowStateByConnection.set(connection, state);
    }
    return state;
  }

  private shouldSendResyncRequired(
    connection: WebSocketConnection,
    cursor: number
  ): boolean {
    if (
      this.maxInFlightSyncsPerConnection <= 0 ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    ) {
      return false;
    }
    const state = this.getFlowState(connection);
    if (cursor <= state.lastAckedCursor) return false;
    return (
      state.resyncRequired ||
      state.inFlightCursors.length >= this.maxInFlightSyncsPerConnection
    );
  }

  private markSyncSent(connection: WebSocketConnection, cursor: number): void {
    if (
      this.maxInFlightSyncsPerConnection <= 0 ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    ) {
      return;
    }
    const state = this.getFlowState(connection);
    if (cursor <= state.lastAckedCursor) return;
    state.lastSentCursor = Math.max(state.lastSentCursor, cursor);
    if (!state.inFlightCursors.includes(cursor)) {
      state.inFlightCursors.push(cursor);
    }
  }

  private sendResyncRequired(
    connection: WebSocketConnection,
    cursor: number
  ): void {
    const state = this.getFlowState(connection);
    state.resyncRequired = true;
    state.lastSentCursor = Math.max(state.lastSentCursor, cursor);
    state.droppedCount += 1;
    connection.sendSync(cursor, {
      reason: 'resync-required',
      requiresPull: true,
      droppedCount: state.droppedCount,
    });
  }

  private rememberReplayRecord(record: WebSocketReplayRecord): void {
    if (
      this.replayWindowSize <= 0 ||
      record.scopeKeys.length === 0 ||
      !Number.isSafeInteger(record.cursor) ||
      record.cursor < 0
    ) {
      return;
    }
    this.replayRecords.push(record);
    while (this.replayRecords.length > this.replayWindowSize) {
      const dropped = this.replayRecords.shift();
      if (dropped) {
        this.replayDroppedThroughCursor = Math.max(
          this.replayDroppedThroughCursor,
          dropped.cursor
        );
      }
    }
  }

  private deliverSyncRecordToConnection(
    connection: WebSocketConnection,
    record: WebSocketReplayRecord
  ): void {
    if (this.shouldSendResyncRequired(connection, record.cursor)) {
      this.sendResyncRequired(connection, record.cursor);
      return;
    }

    const connectionSyncPack =
      record.syncPackForConnection?.(connection) ?? record.syncPack;
    if (
      connectionSyncPack &&
      connectionSyncPack.byteLength <=
        WebSocketConnectionManager.WS_SYNC_PACK_MAX_BYTES &&
      connection.syncPackEncoding === 'binary-sync-pack-v1'
    ) {
      this.markSyncSent(connection, record.cursor);
      connection.sendSyncPack(connectionSyncPack);
      return;
    }

    this.markSyncSent(connection, record.cursor);
    connection.sendSync(record.cursor, {
      reason:
        connectionSyncPack || record.hasSharedPayload
          ? 'payload-too-large'
          : 'server-wakeup',
      requiresPull: true,
    });
  }
}

function normalizeReplayWindowSize(value: number | undefined): number {
  if (value === undefined) return 64;
  if (!Number.isFinite(value)) return 64;
  return Math.max(0, Math.floor(value));
}

function uniqueScopeKeys(scopeKeys: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const scopeKey of scopeKeys) {
    if (scopeKey) unique.add(scopeKey);
  }
  return Array.from(unique);
}
