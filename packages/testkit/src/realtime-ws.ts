import { isRecord } from '@syncular/core';
import {
  type AsyncDisposableResource,
  createAsyncDisposableResource,
  type ResourceRunner,
  withAsyncDisposableFactory,
} from './disposable';

export type RealtimeWsQueryValue = string | number | boolean | null | undefined;

export interface CreateRealtimeWsUrlOptions {
  baseUrl: string;
  clientId: string;
  actorId: string;
  actorQueryParam?: string;
  path?: string;
  query?: Record<string, RealtimeWsQueryValue>;
}

export interface WebSocketConstructor {
  new (url: string, protocols?: string | string[]): WebSocket;
}

export interface OpenRealtimeWsOptions extends CreateRealtimeWsUrlOptions {
  WebSocketCtor?: WebSocketConstructor;
  protocols?: string | string[];
}

export interface OpenRealtimeWsResourceOptions extends OpenRealtimeWsOptions {
  waitForOpen?: boolean;
  openTimeoutMs?: number;
  close?: CloseWsSafeOptions;
}

function appendQueryParam(
  url: URL,
  key: string,
  value: RealtimeWsQueryValue
): void {
  if (value === null || value === undefined) {
    return;
  }

  url.searchParams.set(key, String(value));
}

function toWsProtocol(protocol: string): string {
  if (protocol === 'http:') {
    return 'ws:';
  }

  if (protocol === 'https:') {
    return 'wss:';
  }

  return protocol;
}

export function createRealtimeWsUrl(
  options: CreateRealtimeWsUrlOptions
): string {
  const url = new URL(options.baseUrl);
  url.protocol = toWsProtocol(url.protocol);

  const path = options.path ?? '/sync/realtime';
  url.pathname = path.startsWith('/') ? path : `/${path}`;
  url.search = '';

  appendQueryParam(url, 'clientId', options.clientId);
  appendQueryParam(url, options.actorQueryParam ?? 'userId', options.actorId);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    appendQueryParam(url, key, value);
  }

  return url.toString();
}

export function openRealtimeWs(options: OpenRealtimeWsOptions): WebSocket {
  const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error('WebSocket constructor is unavailable in this runtime');
  }

  return new WebSocketCtor(createRealtimeWsUrl(options), options.protocols);
}

export interface WaitForWsOpenOptions {
  timeoutMs?: number;
}

export function waitForWsOpen(
  ws: WebSocket,
  options: WaitForWsOpenOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket emitted an error before opening'));
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed before opening (code=${event.code} reason=${event.reason || 'none'})`
        )
      );
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for WebSocket open (${timeoutMs}ms)`)
      );
    }, timeoutMs);

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

export interface WaitForWsMessageOptions {
  timeoutMs?: number;
  predicate?: (event: MessageEvent) => boolean;
}

export function waitForWsMessage(
  ws: WebSocket,
  options: WaitForWsMessageOptions = {}
): Promise<MessageEvent> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<MessageEvent>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    const onMessage = (event: MessageEvent) => {
      if (options.predicate && !options.predicate(event)) {
        return;
      }

      cleanup();
      resolve(event);
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket emitted an error before a message arrived'));
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed before receiving a matching message (code=${event.code} reason=${event.reason || 'none'})`
        )
      );
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for WebSocket message (${timeoutMs}ms)`)
      );
    }, timeoutMs);

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

function readTextPayload(data: MessageEvent['data']): string | null {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }

  return null;
}

export function parseWsJsonMessage(
  event: MessageEvent
): Record<string, unknown> | null {
  const payload = readTextPayload(event.data);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface WaitForWsJsonMessageOptions {
  timeoutMs?: number;
  predicate?: (message: Record<string, unknown>) => boolean;
}

export function waitForWsJsonMessage(
  ws: WebSocket,
  options: WaitForWsJsonMessageOptions = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    const onMessage = (event: MessageEvent) => {
      const parsed = parseWsJsonMessage(event);
      if (!parsed) {
        return;
      }

      if (options.predicate && !options.predicate(parsed)) {
        return;
      }

      cleanup();
      resolve(parsed);
    };

    const onError = () => {
      cleanup();
      reject(new Error('WebSocket emitted an error before JSON message'));
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed before receiving JSON message (code=${event.code} reason=${event.reason || 'none'})`
        )
      );
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for WebSocket JSON message (${timeoutMs}ms)`
        )
      );
    }, timeoutMs);

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

export interface CloseWsSafeOptions {
  code?: number;
  reason?: string;
  timeoutMs?: number;
}

const WS_CLOSING = 2;
const WS_CLOSED = 3;

export async function closeWsSafe(
  ws: WebSocket,
  options: CloseWsSafeOptions = {}
): Promise<void> {
  if (ws.readyState === WS_CLOSED) {
    return;
  }

  const timeoutMs = options.timeoutMs ?? 2_000;

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('close', onClose);
      resolve();
    };

    const onClose = () => {
      cleanup();
    };

    const timeout = setTimeout(() => {
      cleanup();
    }, timeoutMs);

    ws.addEventListener('close', onClose);

    if (ws.readyState !== WS_CLOSING) {
      try {
        ws.close(options.code, options.reason);
      } catch {
        cleanup();
      }
    }
  });
}

export async function openRealtimeWsResource(
  options: OpenRealtimeWsResourceOptions
): Promise<AsyncDisposableResource<WebSocket>> {
  const ws = openRealtimeWs(options);

  if (options.waitForOpen) {
    await waitForWsOpen(ws, { timeoutMs: options.openTimeoutMs });
  }

  return createAsyncDisposableResource(ws, () =>
    closeWsSafe(ws, options.close)
  );
}

export async function withRealtimeWs<TResult>(
  options: OpenRealtimeWsResourceOptions,
  run: ResourceRunner<WebSocket, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(() => openRealtimeWsResource(options), run);
}
