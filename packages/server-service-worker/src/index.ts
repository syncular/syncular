import type { SyncTransport } from '@syncular/core';
import {
  type ClientOptions,
  createHttpTransport,
} from '@syncular/transport-http';

export const SERVICE_WORKER_WAKE_CHANNEL = 'syncular-sw-realtime-v1';
export const SERVICE_WORKER_WAKE_MESSAGE_TYPE =
  'syncular:service-worker:wakeup';

export type ServiceWorkerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export interface ServiceWorkerWakeMessage {
  type: string;
  timestamp: number;
  cursor?: number;
  sourceClientId?: string;
}

export function isServiceWorkerWakeMessage(
  value: unknown
): value is ServiceWorkerWakeMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type !== SERVICE_WORKER_WAKE_MESSAGE_TYPE) return false;
  if (
    typeof record.timestamp !== 'number' ||
    !Number.isFinite(record.timestamp)
  ) {
    return false;
  }
  if (
    record.cursor !== undefined &&
    (typeof record.cursor !== 'number' || !Number.isFinite(record.cursor))
  ) {
    return false;
  }
  if (
    record.sourceClientId !== undefined &&
    (typeof record.sourceClientId !== 'string' ||
      record.sourceClientId.length === 0)
  ) {
    return false;
  }
  return true;
}

export interface ServiceWorkerWakeTransport extends SyncTransport {
  connect(
    args: { clientId: string },
    onEvent: (event: {
      event: 'sync';
      data: { cursor?: number; timestamp: number };
    }) => void,
    onStateChange?: (state: ServiceWorkerConnectionState) => void
  ): () => void;
  getConnectionState(): ServiceWorkerConnectionState;
  reconnect(): void;
}

export interface ServiceWorkerWakeTransportOptions extends ClientOptions {
  channelName?: string;
  includeServiceWorkerMessages?: boolean;
  isWakeMessage?: (payload: unknown) => payload is ServiceWorkerWakeMessage;
}

export function createServiceWorkerWakeTransport(
  options: ServiceWorkerWakeTransportOptions
): ServiceWorkerWakeTransport {
  const httpTransport = createHttpTransport({
    baseUrl: options.baseUrl,
    getHeaders: options.getHeaders,
    authLifecycle: options.authLifecycle,
    fetch: options.fetch,
    transportPath: options.transportPath,
  });

  const channelName = options.channelName ?? SERVICE_WORKER_WAKE_CHANNEL;
  const includeServiceWorkerMessages =
    options.includeServiceWorkerMessages ?? true;
  const wakeMessageGuard = options.isWakeMessage ?? isServiceWorkerWakeMessage;

  let connectionState: ServiceWorkerConnectionState = 'disconnected';
  let currentClientId: string | null = null;
  let eventCallback:
    | ((event: {
        event: 'sync';
        data: { cursor?: number; timestamp: number };
      }) => void)
    | null = null;
  let stateCallback: ((state: ServiceWorkerConnectionState) => void) | null =
    null;
  let channel: BroadcastChannel | null = null;
  let swMessageListener: ((event: MessageEvent<unknown>) => void) | null = null;

  const setConnectionState = (state: ServiceWorkerConnectionState): void => {
    if (connectionState === state) return;
    connectionState = state;
    stateCallback?.(state);
  };

  const handleWakeMessage = (payload: unknown): void => {
    if (!eventCallback) return;
    if (!wakeMessageGuard(payload)) return;
    if (currentClientId && payload.sourceClientId === currentClientId) return;

    eventCallback({
      event: 'sync',
      data: {
        cursor: payload.cursor,
        timestamp: payload.timestamp,
      },
    });
  };

  const detachListeners = (): void => {
    if (channel) {
      channel.onmessage = null;
      channel.close();
      channel = null;
    }

    if (
      swMessageListener &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator
    ) {
      navigator.serviceWorker.removeEventListener('message', swMessageListener);
      swMessageListener = null;
    }
  };

  const attachListeners = (): boolean => {
    detachListeners();
    let attached = false;

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(channelName);
      channel.onmessage = (event) => {
        handleWakeMessage(event.data);
      };
      attached = true;
    }

    if (
      includeServiceWorkerMessages &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator
    ) {
      swMessageListener = (event: MessageEvent<unknown>) => {
        handleWakeMessage(event.data);
      };
      navigator.serviceWorker.addEventListener('message', swMessageListener);
      attached = true;
    }

    return attached;
  };

  return {
    ...httpTransport,

    connect(args, onEvent, onStateChange) {
      currentClientId = args.clientId;
      eventCallback = onEvent;
      stateCallback = onStateChange ?? null;

      setConnectionState('connecting');
      const attached = attachListeners();
      setConnectionState(attached ? 'connected' : 'disconnected');

      return () => {
        detachListeners();
        currentClientId = null;
        eventCallback = null;
        stateCallback = null;
        setConnectionState('disconnected');
      };
    },

    getConnectionState() {
      return connectionState;
    },

    reconnect() {
      if (!eventCallback) return;
      setConnectionState('connecting');
      const attached = attachListeners();
      setConnectionState(attached ? 'connected' : 'disconnected');
    },
  };
}

export interface ServiceWorkerServer {
  shouldHandleRequest(request: Request, localOrigin?: string): boolean;
  handleRequest(request: Request): Promise<Response>;
  captureWakeContext(request: Request): Promise<unknown>;
  resolveWakeMessage(args: {
    request: Request;
    response: Response;
    wakeContext: unknown;
  }): Promise<ServiceWorkerWakeMessage | null>;
}

export interface ResolveWakeMessageArgs {
  request: Request;
  response: Response;
  wakeContext: unknown;
}

export interface ServiceWorkerSyncWakeContext {
  sourceClientId?: string;
}

export interface ServiceWorkerSyncWakeMessageResolverOptions {
  syncPathnames?: string[];
}

export interface CreateServiceWorkerServerOptions {
  handleRequest: (request: Request) => Promise<Response> | Response;
  apiPrefix?: string;
  serviceWorkerScriptPath?: string;
  syncPathnames?: string[];
  captureWakeContext?: (request: Request) => Promise<unknown>;
  resolveWakeMessage?: (
    args: ResolveWakeMessageArgs
  ) => Promise<ServiceWorkerWakeMessage | null>;
  onError?: (error: unknown, request: Request) => Promise<Response> | Response;
}

function normalizePrefix(prefix: string | undefined): string {
  const raw = (prefix ?? '/api').trim();
  if (!raw) return '/api';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const trimmed = withSlash.replace(/\/+$/, '');
  return trimmed || '/';
}

function pathStartsWithPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getSyncPushContext(
  request: Request,
  syncPathnameSet: ReadonlySet<string>
): Promise<{ sourceClientId?: string } | null> {
  if (request.method !== 'POST') return null;

  const pathname = new URL(request.url).pathname;
  if (!syncPathnameSet.has(pathname)) return null;

  try {
    const payload = await request.clone().json();
    if (!isRecord(payload)) return null;
    if (!isRecord(payload.push)) return null;
    if (!Array.isArray(payload.push.operations)) return null;
    if (payload.push.operations.length === 0) return null;

    const sourceClientId =
      typeof payload.clientId === 'string' && payload.clientId.length > 0
        ? payload.clientId
        : undefined;

    return { sourceClientId };
  } catch {
    return null;
  }
}

async function getAppliedCommitCursor(
  response: Response
): Promise<number | undefined> {
  if (!response.ok) return undefined;

  try {
    const payload = await response.clone().json();
    if (!isRecord(payload)) return undefined;
    if (!isRecord(payload.push)) return undefined;
    if (payload.push.status !== 'applied') return undefined;

    if (typeof payload.push.commitSeq === 'number') {
      return payload.push.commitSeq;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function createSyncWakeMessageResolver(
  options?: ServiceWorkerSyncWakeMessageResolverOptions
): {
  captureContext: (
    request: Request
  ) => Promise<ServiceWorkerSyncWakeContext | null>;
  resolveMessage: (
    args: ResolveWakeMessageArgs
  ) => Promise<ServiceWorkerWakeMessage | null>;
} {
  const syncPathnameSet = new Set(
    options?.syncPathnames ?? ['/api/sync', '/api/sync/']
  );

  return {
    captureContext: async (request: Request) => {
      return await getSyncPushContext(request, syncPathnameSet);
    },
    resolveMessage: async (args: ResolveWakeMessageArgs) => {
      const syncContext =
        args.wakeContext && typeof args.wakeContext === 'object'
          ? (args.wakeContext as ServiceWorkerSyncWakeContext)
          : null;
      if (!syncContext) return null;

      const cursor = await getAppliedCommitCursor(args.response);
      if (cursor === undefined) return null;

      return {
        type: SERVICE_WORKER_WAKE_MESSAGE_TYPE,
        timestamp: Date.now(),
        cursor,
        ...(syncContext.sourceClientId
          ? { sourceClientId: syncContext.sourceClientId }
          : {}),
      } satisfies ServiceWorkerWakeMessage;
    },
  };
}

export function createServiceWorkerServer(
  options: CreateServiceWorkerServerOptions
): ServiceWorkerServer {
  const apiPrefix = normalizePrefix(options.apiPrefix);
  const scriptPath = options.serviceWorkerScriptPath;
  const syncWakeResolver = createSyncWakeMessageResolver({
    syncPathnames: options.syncPathnames,
  });

  const captureWakeContext =
    options.captureWakeContext ?? syncWakeResolver.captureContext;
  const resolveWakeMessage =
    options.resolveWakeMessage ?? syncWakeResolver.resolveMessage;

  const onError =
    options.onError ??
    (() =>
      new Response('Service worker server failed', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }));

  return {
    shouldHandleRequest(request: Request, localOrigin?: string): boolean {
      const requestUrl = new URL(request.url);

      if (localOrigin && requestUrl.origin !== localOrigin) {
        return false;
      }
      if (!pathStartsWithPrefix(requestUrl.pathname, apiPrefix)) {
        return false;
      }
      if (scriptPath && requestUrl.pathname === scriptPath) {
        return false;
      }
      return true;
    },

    async handleRequest(request: Request): Promise<Response> {
      try {
        return await options.handleRequest(request);
      } catch (error) {
        return await onError(error, request);
      }
    },

    async captureWakeContext(request: Request) {
      return await captureWakeContext(request);
    },

    async resolveWakeMessage(args: ResolveWakeMessageArgs) {
      return await resolveWakeMessage(args);
    },
  };
}

export interface ServiceWorkerGlobalScopeLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  location?: { origin?: string };
  skipWaiting?: () => Promise<void>;
  clients?: {
    claim?: () => Promise<void>;
    matchAll?: (options?: {
      type?: 'window' | 'worker' | 'sharedworker' | 'all';
      includeUncontrolled?: boolean;
    }) => Promise<Array<{ postMessage: (message: unknown) => void }>>;
  };
}

interface ServiceWorkerLifecycleEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface ServiceWorkerFetchEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

export interface AttachServiceWorkerServerOptions {
  manageLifecycle?: boolean;
  channelName?: string;
  logger?: {
    error?: (...args: unknown[]) => void;
  };
}

function createWakeBroadcaster(
  globalScope: ServiceWorkerGlobalScopeLike,
  channelName: string
): (message: ServiceWorkerWakeMessage) => void {
  const channel =
    typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(channelName)
      : null;

  return (message: ServiceWorkerWakeMessage): void => {
    try {
      if (channel) {
        channel.postMessage(message);
        return;
      }
    } catch {
      // fall through to postMessage fallback
    }

    void globalScope.clients
      ?.matchAll?.({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          try {
            client.postMessage(message);
          } catch {
            // best-effort wake-up
          }
        }
      })
      .catch(() => {
        // best-effort wake-up
      });
  };
}

export function attachServiceWorkerServer(
  globalScope: ServiceWorkerGlobalScopeLike,
  server: ServiceWorkerServer,
  options?: AttachServiceWorkerServerOptions
): void {
  const manageLifecycle = options?.manageLifecycle ?? true;
  const localOrigin = globalScope.location?.origin;
  const broadcastWakeMessage = createWakeBroadcaster(
    globalScope,
    options?.channelName ?? SERVICE_WORKER_WAKE_CHANNEL
  );

  if (manageLifecycle) {
    globalScope.addEventListener('install', (event: unknown) => {
      const installEvent = event as ServiceWorkerLifecycleEventLike;
      installEvent.waitUntil(globalScope.skipWaiting?.() ?? Promise.resolve());
    });

    globalScope.addEventListener('activate', (event: unknown) => {
      const activateEvent = event as ServiceWorkerLifecycleEventLike;
      activateEvent.waitUntil(
        globalScope.clients?.claim?.() ?? Promise.resolve()
      );
    });
  }

  globalScope.addEventListener('fetch', (event: unknown) => {
    const fetchEvent = event as ServiceWorkerFetchEventLike;
    const request = fetchEvent.request;

    if (!server.shouldHandleRequest(request, localOrigin)) {
      return;
    }

    fetchEvent.respondWith(
      (async () => {
        const wakeContext = await server.captureWakeContext(request);
        const response = await server.handleRequest(request);

        try {
          const wakeMessage = await server.resolveWakeMessage({
            request,
            response,
            wakeContext,
          });
          if (wakeMessage) {
            broadcastWakeMessage(wakeMessage);
          }
        } catch (error) {
          options?.logger?.error?.(
            '[server-service-worker] failed to resolve wake message',
            error
          );
        }

        return response;
      })()
    );
  });
}

export interface ConfigureServiceWorkerServerOptions {
  scriptPath: string;
  healthPath?: string;
  healthCheck?: (response: Response) => boolean | Promise<boolean>;
  enabled?: boolean;
  scope?: string;
  type?: 'classic' | 'module';
  updateViaCache?: 'imports' | 'all' | 'none';
  unregisterOnDisable?: boolean;
  controllerTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthRetryDelayMs?: number;
  healthRequestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

export async function unregisterServiceWorkerRegistrations(
  scriptPath: string
): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  const unregisterTasks = registrations
    .filter((registration) => {
      const scriptUrl =
        registration.active?.scriptURL ??
        registration.waiting?.scriptURL ??
        registration.installing?.scriptURL;
      return scriptUrl?.includes(scriptPath) === true;
    })
    .map((registration) => registration.unregister());

  await Promise.all(unregisterTasks);
}

function waitForControllerChange(timeoutMs: number): Promise<void> {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    navigator.serviceWorker.controller
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onControllerChange = () => {
      clearTimeout(timeoutId);
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange
      );
      resolve();
    };

    const timeoutId = setTimeout(() => {
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange
      );
      resolve();
    }, timeoutMs);

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      onControllerChange
    );
  });
}

async function waitForHealth(args: {
  path: string;
  timeoutMs: number;
  retryDelayMs: number;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
  healthCheck?: (response: Response) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const started = Date.now();

  while (Date.now() - started < args.timeoutMs) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        args.requestTimeoutMs
      );
      let response: Response;
      try {
        response = await args.fetchImpl(args.path, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (response.ok) {
        if (args.healthCheck) {
          const matches = await args.healthCheck(response);
          if (!matches) {
            throw new Error('Service Worker health probe mismatch');
          }
        }
        return true;
      }
    } catch {
      // keep retrying until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, args.retryDelayMs));
  }

  return false;
}

export async function configureServiceWorkerServer(
  options: ConfigureServiceWorkerServerOptions
): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return false;
  }

  const enabled = options.enabled ?? true;
  const logger = options.logger;

  if (!enabled) {
    if (options.unregisterOnDisable !== false) {
      await unregisterServiceWorkerRegistrations(options.scriptPath);
    }
    logger?.warn?.('[server-service-worker] service worker mode disabled');
    return false;
  }

  try {
    await navigator.serviceWorker.register(options.scriptPath, {
      scope: options.scope,
      type: options.type ?? 'module',
      updateViaCache: options.updateViaCache ?? 'none',
    });

    await navigator.serviceWorker.ready;
    await waitForControllerChange(options.controllerTimeoutMs ?? 5_000);

    const healthy = await waitForHealth({
      path: options.healthPath ?? '/api/health',
      timeoutMs: options.healthTimeoutMs ?? 10_000,
      retryDelayMs: options.healthRetryDelayMs ?? 150,
      requestTimeoutMs: options.healthRequestTimeoutMs ?? 2_000,
      fetchImpl: options.fetchImpl ?? fetch,
      healthCheck: options.healthCheck,
    });

    if (!healthy) {
      throw new Error('Service Worker server health check timed out');
    }

    logger?.info?.('[server-service-worker] service worker server enabled');
    return true;
  } catch (error) {
    logger?.error?.(
      '[server-service-worker] failed to enable service worker server',
      error
    );
    return false;
  }
}
