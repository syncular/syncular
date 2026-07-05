/**
 * Browser transport bindings (§1.1, §5.4/§5.5, §8.1): fetch-based sync
 * transport, segment download with signed-URL preference and direct-serve
 * fallback, and a WebSocket realtime connector. Core tests never use these
 * (the loopback doctrine); B6 exercises them in a real browser.
 */
import type { BlobTransport } from './blob';
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
 * §5.5 direct endpoint with the `X-Syncular-Scopes` re-authorization
 * header, plus the §5.4 `fetchUrl` capability (advertises accept bit 3).
 * `fetchUrl` sends NO headers at all — the signed URL is the entire
 * grant, and host auth must never leak to CDN/object hosts (§5.4).
 * Resolution (which path a descriptor takes, expiry, no fall-through)
 * lives in the client core, not here.
 */
export function httpSegmentDownloader(
  segmentsBaseUrl: string,
  options?: HttpTransportOptions,
): SegmentDownloader {
  const doFetch = options?.fetch ?? fetch;
  const direct = async (request: {
    readonly segmentId: string;
    readonly requestedScopesJson: string;
  }) => {
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
  const fetchUrl = async (url: string) => {
    // Deliberately headerless: the URL is the bearer grant (§5.4).
    const response = await doFetch(url);
    if (!response.ok) {
      throw new ClientSyncError(
        'sync.transport_failed',
        `signed-URL fetch failed with HTTP ${response.status} (§5.4: descriptor invalidated, re-pull to recover)`,
        true,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return Object.assign(direct, { fetchUrl });
}

/**
 * §5.9.3/§5.9.5 blob transport: host-authenticated `PUT`/`GET
 * <mount>/blobs/{blobId}`. Both carry normal host auth (the blob id is not
 * a capability — the server re-authorizes downloads against referencing
 * rows). Content-address verification is the client core's job (§5.9.7).
 */
export function httpBlobTransport(
  blobsBaseUrl: string,
  options?: HttpTransportOptions,
): BlobTransport {
  const doFetch = options?.fetch ?? fetch;
  const blobUrl = (blobId: string) =>
    `${blobsBaseUrl}/${encodeURIComponent(blobId)}`;
  return {
    upload: async (blobId, bytes, mediaType) => {
      const response = await doFetch(blobUrl(blobId), {
        method: 'PUT',
        headers: {
          'Content-Type': mediaType ?? 'application/octet-stream',
          ...options?.headers,
        },
        body: bytes.slice().buffer as ArrayBuffer,
      });
      if (!response.ok) await throwHttpError(response);
    },
    download: async (blobId) => {
      const response = await doFetch(blobUrl(blobId), {
        headers: { ...options?.headers },
      });
      if (!response.ok) await throwHttpError(response);
      // §5.9.5 always-issue: a JSON body with `url` means presigned delivery;
      // an octet-stream body is inline bytes.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = (await response.json()) as {
          url?: string;
          urlExpiresAtMs?: number;
        };
        if (typeof body.url === 'string') {
          return {
            kind: 'url',
            url: body.url,
            ...(typeof body.urlExpiresAtMs === 'number'
              ? { urlExpiresAtMs: body.urlExpiresAtMs }
              : {}),
          };
        }
      }
      return {
        kind: 'bytes',
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
    // §5.9.5: bare GET of the signed URL — no host auth (the URL is the grant).
    fetchUrl: async (url) => {
      const response = await doFetch(url);
      if (!response.ok) {
        throw new ClientSyncError(
          'sync.transport_failed',
          `blob signed-URL fetch failed with HTTP ${response.status} (§5.9.5: re-request to recover)`,
          true,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    // §5.9.3: presigned-upload grant.
    uploadGrant: async (blobId, byteLength, mediaType) => {
      const response = await doFetch(`${blobUrl(blobId)}/upload-grant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        body: JSON.stringify({
          byteLength,
          ...(mediaType !== undefined ? { mediaType } : {}),
        }),
      });
      if (!response.ok) await throwHttpError(response);
      const body = (await response.json()) as {
        url?: string;
        urlExpiresAtMs?: number;
        present?: boolean;
      };
      if (typeof body.url === 'string') {
        return {
          kind: 'url',
          url: body.url,
          ...(typeof body.urlExpiresAtMs === 'number'
            ? { urlExpiresAtMs: body.urlExpiresAtMs }
            : {}),
        };
      }
      if (body.present === true) return { kind: 'present' };
      return { kind: 'none' };
    },
    // §5.9.3: direct-to-storage PUT — no host auth (the URL is the grant).
    uploadToUrl: async (url, bytes, mediaType) => {
      const response = await doFetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': mediaType ?? 'application/octet-stream',
        },
        body: bytes.slice().buffer as ArrayBuffer,
      });
      if (!response.ok) {
        throw new ClientSyncError(
          'sync.transport_failed',
          `blob presigned PUT failed with HTTP ${response.status} (§5.9.3: re-request a grant or stream direct)`,
          true,
        );
      }
    },
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
          sendBytes: (bytes) => {
            socket.send(bytes.slice().buffer as ArrayBuffer);
          },
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
