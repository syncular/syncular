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

import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncTransport,
} from '@syncular/core';
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
 * Push response data received from the server over WS
 */
export interface WsPushResponseData {
  requestId: string;
  ok: boolean;
  status: string;
  commitSeq?: number;
  results: Array<{ opIndex: number; status: string; [k: string]: unknown }>;
  timestamp: number;
}

/**
 * WebSocket event from the server
 */
export interface WebSocketEvent {
  event: 'sync' | 'heartbeat' | 'error' | 'presence' | 'push-response';
  data: {
    cursor?: number;
    actorId?: string;
    createdAt?: string;
    /** Inline change data for small payloads (WS data delivery) */
    changes?: unknown[];
    error?: string;
    presence?: PresenceEventData;
    /** Push response fields (for push-response events) */
    requestId?: string;
    ok?: boolean;
    status?: string;
    commitSeq?: number;
    results?: Array<{ opIndex: number; status: string; [k: string]: unknown }>;
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
   * WebSocket endpoint URL. If not provided, uses `${baseUrl}/sync/realtime`
   * with `http(s)` -> `ws(s)` conversion when possible.
   */
  wsUrl?: string;
  /**
   * Additional query params for the realtime URL (e.g. `{ token }`).
   *
   * ⚠️ SECURITY WARNING: Query parameters may be logged by proxies, CDNs, and
   * browser history. Do NOT pass sensitive tokens here. Prefer cookie-based
   * auth. Use `authToken` only with servers that explicitly support first-message
   * WebSocket authentication.
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
   * Timeout for waiting on WS push responses before falling back to HTTP push.
   * Default: 1500ms
   */
  wsPushTimeoutMs?: number;
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
  /**
   * Push a commit via WebSocket (bypasses HTTP).
   * Returns `null` if WS is not connected or times out (caller should fall back to HTTP).
   */
  pushViaWs(request: SyncPushRequest): Promise<SyncPushResponse | null>;
}

function defaultWsUrl(baseUrl: string): string | null {
  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(baseUrl);
    const resolved =
      isAbsolute || typeof location === 'undefined'
        ? new URL(baseUrl)
        : new URL(baseUrl, location.origin);

    resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
    resolved.pathname = `${resolved.pathname.replace(/\/$/, '')}/sync/realtime`;
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
    authLifecycle: options.authLifecycle,
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

  // Warn about security risk of using getRealtimeParams with sensitive data,
  // but only if the consumer hasn't also provided getHeaders or authToken
  // (which indicates intentional auth handling with query-param fallback).
  if (getRealtimeParams && !authToken && !options.getHeaders) {
    console.warn(
      '[transport-ws] getRealtimeParams sends data in URL query parameters, ' +
        'which may be logged by proxies and CDNs. Prefer cookie-based auth when possible.'
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

  // Pending WS push requests (requestId -> resolver)
  const pendingPushRequests = new Map<
    string,
    {
      resolve: (value: SyncPushResponse | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const wsPushTimeoutMs = Math.max(1, options.wsPushTimeoutMs ?? 1_500);

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

    // Resolve all pending WS push requests as null (triggers HTTP fallback)
    for (const [, pending] of pendingPushRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    pendingPushRequests.clear();

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

    // Route push-response events to pending request resolvers
    if (event === 'push-response') {
      const d = data as Record<string, unknown>;
      const requestId = typeof d.requestId === 'string' ? d.requestId : '';
      const pending = pendingPushRequests.get(requestId);
      if (pending) {
        pendingPushRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: true as const,
          status: (d.status as 'applied' | 'cached' | 'rejected') ?? 'rejected',
          commitSeq: typeof d.commitSeq === 'number' ? d.commitSeq : undefined,
          results: Array.isArray(d.results)
            ? (d.results as SyncPushResponse['results'])
            : [],
        });
      }
      return;
    }

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

  function sendPresenceMessage(
    msg: Record<string, unknown>,
    socketArg?: WebSocket
  ): void {
    const target = socketArg ?? ws;
    if (!target || target.readyState !== WebSocketImpl!.OPEN) return;
    target.send(JSON.stringify({ type: 'presence', ...msg }));
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

    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(url);
    } catch {
      doDisconnect();
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = async () => {
      if (nonce !== connectNonce) return;
      if (socket !== ws) return;

      // Send auth token if provided (more secure than query params)
      if (authToken) {
        try {
          const token =
            typeof authToken === 'function' ? await authToken() : authToken;
          if (
            token &&
            nonce === connectNonce &&
            socket === ws &&
            socket.readyState === WebSocketImpl.OPEN
          ) {
            socket.send(JSON.stringify({ type: 'auth', token }));
          }
        } catch {
          // Auth token failed, but connection is still open
          // Server will handle unauthenticated connection appropriately
        }
      }

      if (nonce !== connectNonce) return;
      if (socket !== ws) return;
      if (socket.readyState !== WebSocketImpl.OPEN) return;
      setConnectionState('connected');
      reconnectAttempts = 0;
      resetHeartbeatTimer();

      // Re-join all active presence scopes on reconnect
      for (const [scopeKey, metadata] of activePresenceScopes) {
        sendPresenceMessage({ action: 'join', scopeKey, metadata }, socket);
      }
    };

    socket.onmessage = (evt) => {
      if (nonce !== connectNonce) return;
      if (socket !== ws) return;
      resetHeartbeatTimer();

      if (typeof evt.data === 'string') {
        try {
          dispatchEvent(JSON.parse(evt.data));
        } catch {
          // ignore malformed messages
        }
      }
    };

    socket.onerror = () => {
      if (nonce !== connectNonce) return;
      if (socket !== ws) return;
      doDisconnect();
      scheduleReconnect();
    };

    socket.onclose = () => {
      if (nonce !== connectNonce) return;
      if (socket !== ws) return;
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
    pushViaWs(request: SyncPushRequest): Promise<SyncPushResponse | null> {
      if (!ws || ws.readyState !== WebSocketImpl!.OPEN) {
        return Promise.resolve(null);
      }

      const requestId = crypto.randomUUID();

      return new Promise<SyncPushResponse | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingPushRequests.delete(requestId);
          resolve(null);
        }, wsPushTimeoutMs);

        pendingPushRequests.set(requestId, { resolve, timer });

        try {
          ws!.send(
            JSON.stringify({
              type: 'push',
              requestId,
              clientCommitId: request.clientCommitId,
              operations: request.operations,
              schemaVersion: request.schemaVersion,
            })
          );
        } catch {
          pendingPushRequests.delete(requestId);
          clearTimeout(timer);
          resolve(null);
        }
      });
    },
  };
}
