/**
 * Browser transport bindings (§1.1, §5.4/§5.5, §8.1): fetch-based sync
 * transport, segment download with signed-URL preference and direct-serve
 * fallback, and a WebSocket realtime connector. Core tests never use these
 * (the loopback doctrine); B6 exercises them in a real browser.
 */
import { SSP2_CONTENT_TYPE } from './content-type';
import { ClientSyncError } from './errors';
import type {
  RealtimeConnector,
  SegmentDownloader,
  SyncTransport,
} from './transport';

async function throwHttpError(response: Response): Promise<never> {
  let code = 'sync.transport_failed';
  let message = `HTTP ${response.status}`;
  let retryable = response.status >= 500 || response.status === 429;
  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.retryable === 'boolean') retryable = body.retryable;
  } catch {
    // non-JSON error body — keep the HTTP-status defaults
  }
  throw new ClientSyncError(code, message, retryable);
}

export interface HttpTransportOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

/** POST `<mount>/sync` with SSP2 bodies (§1.1). */
export function httpSyncTransport(
  syncUrl: string,
  options?: HttpTransportOptions,
): SyncTransport {
  const doFetch = options?.fetch ?? fetch;
  return async (request) => {
    const response = await doFetch(syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': SSP2_CONTENT_TYPE,
        ...options?.headers,
      },
      body: request.slice().buffer as ArrayBuffer,
    });
    if (!response.ok) await throwHttpError(response);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/**
 * §5.4 download resolution order: a fresh signed URL first (zero
 * sync-server egress), then the direct endpoint with the
 * `X-Syncular-Scopes` re-authorization header (§5.5). A signed URL is
 * never retried after `urlExpiresAtMs`.
 */
export function httpSegmentDownloader(
  segmentsBaseUrl: string,
  options?: HttpTransportOptions & { readonly now?: () => number },
): SegmentDownloader {
  const doFetch = options?.fetch ?? fetch;
  const now = options?.now ?? Date.now;
  return async (request) => {
    if (
      request.url !== undefined &&
      (request.urlExpiresAtMs === undefined || request.urlExpiresAtMs > now())
    ) {
      try {
        const response = await doFetch(request.url);
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
      } catch {
        // fall through to the direct endpoint (§5.4 MUST fall back)
      }
    }
    const response = await doFetch(
      `${segmentsBaseUrl}/${encodeURIComponent(request.segmentId)}`,
      {
        headers: {
          'X-Syncular-Scopes': request.requestedScopesJson,
          ...options?.headers,
        },
      },
    );
    if (!response.ok) await throwHttpError(response);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** WebSocket realtime connector (§8.1): text = control, binary = deltas. */
export function webSocketRealtimeConnector(
  realtimeUrl: string,
): RealtimeConnector {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(realtimeUrl);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        resolve({
          send: (text) => socket.send(text),
          close: () => socket.close(),
        });
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') handlers.onText(event.data);
        else handlers.onBinary(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        reject(
          new ClientSyncError(
            'sync.transport_failed',
            'realtime socket failed to connect',
            true,
          ),
        );
      };
      socket.onclose = () => {
        handlers.onClose?.();
      };
    });
}
