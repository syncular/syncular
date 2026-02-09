/**
 * @syncular/transport-ws - WebSocket transport for sync realtime wake-ups
 *
 * Extends the HTTP transport with WebSocket-based realtime notifications.
 * WebSockets are only used as a "wake up" mechanism; clients must still pull.
 *
 * Auth notes:
 * - Browsers' `WebSocket` cannot attach custom headers.
 * - Use cookie auth (same-origin) or a query-param token for the realtime URL.
 */

import type { SyncTransport } from '@syncular/core';
import {
  type ClientOptions,
  createHttpTransport,
} from '@syncular/transport-http';

/**
 * WebSocket connection state
 */
export type WebSocketConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected';

/**
 * Presence event data
 */
export interface PresenceEventData {
  action: 'join' | 'leave' | 'update' | 'snapshot';
  scopeKey: string;
  clientId?: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  entries?: Array<{
    clientId: string;
    actorId: string;
    joinedAt: number;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * WebSocket event from the server
 */
export interface WebSocketEvent {
  event: 'sync' | 'heartbeat' | 'error' | 'presence';
  data: {
    cursor?: number;
    error?: string;
    presence?: PresenceEventData;
    timestamp: number;
  };
}

/**
 * Callback for realtime events
 */
export type WebSocketEventCallback = (event: WebSocketEvent) => void;

/**
 * Callback for connection state changes
 */
export type WebSocketStateCallback = (state: WebSocketConnectionState) => void;

export interface WebSocketTransportOptions extends ClientOptions {
  /**
   * WebSocket endpoint URL. If not provided, uses `${baseUrl}/realtime` with
   * `http(s)` -> `ws(s)` conversion when possible.
   */
  wsUrl?: string;
  /**
   * Additional query params for the realtime URL (e.g. `{ token }`).
   *
   * ⚠️ SECURITY WARNING: Query parameters may be logged by proxies, CDNs, and
   * browser history. Do NOT pass sensitive tokens here. Use cookie-based auth
   * or the `authToken` option with a server that supports first-message auth.
   */
  getRealtimeParams?: (args: {
    clientId: string;
  }) => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Auth token sent in the first WebSocket message after connection.
   * More secure than query parameters as it won't appear in URLs.
   * Requires server support for first-message auth.
   */
  authToken?: string | (() => string | Promise<string>);
  /**
   * Initial reconnection delay in ms.
   * Default: 1000 (1 second)
   */
  initialReconnectDelay?: number;
  /**
   * Maximum reconnection delay in ms.
   * Default: 30000 (30 seconds)
   */
  maxReconnectDelay?: number;
  /**
   * Backoff factor for reconnection delay.
   * Default: 2
   */
  reconnectBackoffFactor?: number;
  /**
   * Jitter factor for reconnection delay (0-1).
   * Adds randomness to prevent thundering herd on server restart.
   * Default: 0.3 (30% randomization)
   */
  reconnectJitter?: number;
  /**
   * Heartbeat timeout in ms. If no message is received within this time,
   * the connection is considered dead.
   * Default: 60000 (60 seconds)
   */
  heartbeatTimeout?: number;
  /**
   * Optional WebSocket implementation override (useful for non-browser runtimes).
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Transport path telemetry sent to the server for push/pull and realtime.
   * Defaults to 'relay' for this transport.
   */
  transportPath?: 'direct' | 'relay';
}

/**
 * Callback for presence events from the server
 */
export type PresenceEventCallback = (event: PresenceEventData) => void;

/**
 * Extended sync transport with WebSocket subscription support.
 */
export interface WebSocketTransport extends SyncTransport {
  connect(
    args: { clientId: string },
    onEvent: WebSocketEventCallback,
    onStateChange?: WebSocketStateCallback
  ): () => void;
  getConnectionState(): WebSocketConnectionState;
  reconnect(): void;
  sendPresenceJoin(scopeKey: string, metadata?: Record<string, unknown>): void;
  sendPresenceLeave(scopeKey: string): void;
  sendPresenceUpdate(scopeKey: string, metadata: Record<string, unknown>): void;
  onPresenceEvent(callback: PresenceEventCallback): () => void;
}

function defaultWsUrl(baseUrl: string): string | null {
  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(baseUrl);
    const resolved =
      isAbsolute || typeof location === 'undefined'
        ? new URL(baseUrl)
        : new URL(baseUrl, location.origin);

    resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
    resolved.pathname = `${resolved.pathname.replace(/\/$/, '')}/realtime`;
    return resolved.toString();
  } catch {
    return null;
  }
}

export function createWebSocketTransport(
  options: WebSocketTransportOptions
): WebSocketTransport {
  const telemetryTransportPath = options.transportPath ?? 'relay';
  const httpTransport = createHttpTransport({
    baseUrl: options.baseUrl,
    getHeaders: options.getHeaders,
    fetch: options.fetch,
    transportPath: telemetryTransportPath,
  });

  const {
    baseUrl,
    wsUrl = options.wsUrl ?? defaultWsUrl(baseUrl),
    getRealtimeParams,
    authToken,
    initialReconnectDelay = 1000,
    maxReconnectDelay = 30_000,
    reconnectBackoffFactor = 2,
    heartbeatTimeout = 60_000,
    WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : undefined,
  } = options;

  // Warn about security risk of using getRealtimeParams with sensitive data
  if (getRealtimeParams && !authToken) {
    console.warn(
      '[transport-ws] getRealtimeParams sends data in URL query parameters, ' +
        'which may be logged by proxies and CDNs. Consider using authToken instead.'
    );
  }

  if (!wsUrl) {
    throw new Error(
      '@syncular/transport-ws: wsUrl is required when baseUrl cannot be converted'
    );
  }

  if (!WebSocketImpl) {
    throw new Error(
      '@syncular/transport-ws: WebSocket is not available in this runtime'
    );
  }

  let ws: WebSocket | null = null;
  let connectionState: WebSocketConnectionState = 'disconnected';
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  let currentEventCallback: WebSocketEventCallback | null = null;
  let currentStateCallback: WebSocketStateCallback | null = null;
  let isManuallyDisconnected = false;
  let currentClientId: string | null = null;
  let connectNonce = 0;

  // Presence state
  const activePresenceScopes = new Map<
    string,
    Record<string, unknown> | undefined
  >();
  const presenceCallbacks = new Set<PresenceEventCallback>();

  function setConnectionState(state: WebSocketConnectionState): void {
    if (connectionState === state) return;
    connectionState = state;
    currentStateCallback?.(state);
  }

  function calculateReconnectDelay(): number {
    const baseDelay = Math.min(
      initialReconnectDelay * reconnectBackoffFactor ** reconnectAttempts,
      maxReconnectDelay
    );
    // Add jitter to prevent thundering herd (multiple clients reconnecting simultaneously)
    const jitterFactor = options.reconnectJitter ?? 0.3;
    const jitter = baseDelay * jitterFactor * (Math.random() * 2 - 1); // +/- jitterFactor
    return Math.max(0, Math.round(baseDelay + jitter));
  }

  function clearHeartbeatTimer(): void {
    if (!heartbeatTimer) return;
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function resetHeartbeatTimer(): void {
    clearHeartbeatTimer();
    if (heartbeatTimeout <= 0) return;

    heartbeatTimer = setTimeout(() => {
      doDisconnect();
      scheduleReconnect();
    }, heartbeatTimeout);
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (isManuallyDisconnected) return;

    clearReconnectTimer();
    const delay = calculateReconnectDelay();
    reconnectAttempts += 1;

    reconnectTimer = setTimeout(() => {
      void doConnect();
    }, delay);
  }

  function doDisconnect(): void {
    clearHeartbeatTimer();
    clearReconnectTimer();

    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }

    setConnectionState('disconnected');
  }

  function dispatchEvent(raw: unknown): void {
    resetHeartbeatTimer();

    if (!raw || typeof raw !== 'object') return;
    if (!('event' in raw) || !('data' in raw)) return;
    const event = (raw as { event: unknown }).event;
    const data = (raw as { data: unknown }).data;
    if (!data || typeof data !== 'object') return;

    // Route presence events to dedicated callbacks
    if (event === 'presence') {
      const presenceData = (data as { presence?: unknown }).presence;
      if (presenceData && typeof presenceData === 'object') {
        for (const cb of presenceCallbacks) {
          cb(presenceData as PresenceEventData);
        }
      }
      // Also forward to main event callback
      if (currentEventCallback) {
        currentEventCallback({ event, data } as WebSocketEvent);
      }
      return;
    }

    if (event !== 'sync' && event !== 'heartbeat' && event !== 'error') return;
    currentEventCallback?.({ event, data } as WebSocketEvent);
  }

  function sendPresenceMessage(msg: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocketImpl!.OPEN) return;
    ws.send(JSON.stringify({ type: 'presence', ...msg }));
  }

  async function buildUrl(clientId: string): Promise<string> {
    if (!wsUrl) throw new Error('wsUrl is required');
    // Handle relative URLs by using location.origin as base
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(wsUrl);
    const url =
      isAbsolute || typeof location === 'undefined'
        ? new URL(wsUrl)
        : new URL(wsUrl, location.origin);
    // Convert http(s) to ws(s) if needed
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    url.searchParams.set('clientId', clientId);

    if (getRealtimeParams) {
      try {
        const params = await getRealtimeParams({ clientId });
        for (const [k, v] of Object.entries(params ?? {})) {
          if (typeof v !== 'string') continue;
          if (!v) continue;
          url.searchParams.set(k, v);
        }
      } catch {
        // ignore; realtime is best-effort
      }
    }

    url.searchParams.set('transportPath', telemetryTransportPath);

    return url.toString();
  }

  async function doConnect(): Promise<void> {
    if (!currentClientId) return;
    if (isManuallyDisconnected) return;

    const nonce = ++connectNonce;

    setConnectionState('connecting');

    const url = await buildUrl(currentClientId);
    if (nonce !== connectNonce) return;

    if (!WebSocketImpl) throw new Error('WebSocketImpl is required');

    try {
      ws = new WebSocketImpl(url);
    } catch {
      doDisconnect();
      scheduleReconnect();
      return;
    }

    ws.onopen = async () => {
      if (nonce !== connectNonce) return;

      // Send auth token if provided (more secure than query params)
      if (authToken && ws) {
        try {
          const token =
            typeof authToken === 'function' ? await authToken() : authToken;
          if (token && nonce === connectNonce) {
            ws.send(JSON.stringify({ type: 'auth', token }));
          }
        } catch {
          // Auth token failed, but connection is still open
          // Server will handle unauthenticated connection appropriately
        }
      }

      if (nonce !== connectNonce) return;
      setConnectionState('connected');
      reconnectAttempts = 0;
      resetHeartbeatTimer();

      // Re-join all active presence scopes on reconnect
      for (const [scopeKey, metadata] of activePresenceScopes) {
        sendPresenceMessage({ action: 'join', scopeKey, metadata });
      }
    };

    ws.onmessage = (evt) => {
      if (nonce !== connectNonce) return;
      resetHeartbeatTimer();

      if (typeof evt.data === 'string') {
        try {
          dispatchEvent(JSON.parse(evt.data));
        } catch {
          // ignore malformed messages
        }
      }
    };

    ws.onerror = () => {
      if (nonce !== connectNonce) return;
      doDisconnect();
      scheduleReconnect();
    };

    ws.onclose = () => {
      if (nonce !== connectNonce) return;
      doDisconnect();
      scheduleReconnect();
    };
  }

  return {
    ...httpTransport,
    connect(args, onEvent, onStateChange) {
      currentClientId = args.clientId;
      currentEventCallback = onEvent;
      currentStateCallback = onStateChange ?? null;
      isManuallyDisconnected = false;
      reconnectAttempts = 0;
      void doConnect();

      return () => {
        isManuallyDisconnected = true;
        currentEventCallback = null;
        currentStateCallback = null;
        currentClientId = null;
        connectNonce += 1;
        doDisconnect();
      };
    },
    getConnectionState() {
      return connectionState;
    },
    reconnect() {
      if (!currentClientId) return;
      if (isManuallyDisconnected) return;
      connectNonce += 1;
      doDisconnect();
      void doConnect();
    },
    sendPresenceJoin(scopeKey, metadata) {
      activePresenceScopes.set(scopeKey, metadata);
      sendPresenceMessage({ action: 'join', scopeKey, metadata });
    },
    sendPresenceLeave(scopeKey) {
      activePresenceScopes.delete(scopeKey);
      sendPresenceMessage({ action: 'leave', scopeKey });
    },
    sendPresenceUpdate(scopeKey, metadata) {
      activePresenceScopes.set(scopeKey, metadata);
      sendPresenceMessage({ action: 'update', scopeKey, metadata });
    },
    onPresenceEvent(callback) {
      presenceCallbacks.add(callback);
      return () => {
        presenceCallbacks.delete(callback);
      };
    },
  };
}
