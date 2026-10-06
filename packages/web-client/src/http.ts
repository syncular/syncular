/**
 * Browser transport bindings (§1.1, §5.4/§5.5, §8.1): fetch-based sync
 * transport, descriptor-selected signed-URL or direct segment delivery, and
 * WebSocket realtime connectors. Adapter tests inject fetch and socket surfaces;
 * protocol core conformance uses loopback.
 */
import type { BlobTransport } from './blob';
import { SSP2_CONTENT_TYPE } from './content-type';
import { ClientSyncError } from './errors';
import type {
  RealtimeConnector,
  RemoteOperationTransport,
  RemoteOperationRealtimeConnector,
  SegmentDownloader,
  SyncTransport,
} from './transport';

async function transfer<T>(
  message: string,
  operation: () => Promise<T>,
  httpStatus?: number,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Classify only known exception kinds. Injected errors, including
    // ClientSyncError, are untrusted and never become the returned cause.
    const causeKind =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timeout'
        : error instanceof DOMException && error.name === 'AbortError'
          ? 'aborted'
          : httpStatus !== undefined
            ? 'body'
            : error instanceof TypeError
              ? 'network'
              : 'unknown';
    throw new ClientSyncError('sync.transport_failed', message, true, {
      causeKind,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    });
  }
}

async function throwHttpError(
  response: Response,
  defaultCode = 'sync.transport_failed',
): Promise<never> {
  let code = defaultCode;
  let message = 'HTTP request failed';
  let retryable =
    response.status >= 500 ||
    response.status === 429 ||
    defaultCode === 'sync.auth_required';
  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    // Absence requires an actual 404, even if a server body claims otherwise.
    if (body.code !== 'blob.not_found' || response.status === 404) {
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.retryable === 'boolean') retryable = body.retryable;
    }
  } catch {
    // non-JSON error body — keep the HTTP-status defaults
  }
  throw new ClientSyncError(code, message, retryable, {
    causeKind: 'status',
    httpStatus: response.status,
  });
}

export interface HttpTransportOptions {
  /**
   * Host auth headers. A function is read on every request, so a rotated
   * token applies from the next request on. Signed-URL fetches never
   * carry them (§5.4, §5.9.5).
   */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>>);
  readonly fetch?: typeof fetch;
}

function hostHeaders(
  options: HttpTransportOptions | undefined,
): Readonly<Record<string, string>> | undefined {
  const headers = options?.headers;
  return typeof headers === 'function' ? headers() : headers;
}

/** POST `<mount>/sync` with SSP2 bodies (§1.1). */
export function httpSyncTransport(
  syncUrl: string,
  options?: HttpTransportOptions,
): SyncTransport {
  const doFetch = options?.fetch ?? fetch;
  return async (request) => {
    const response = await transfer('sync request failed', () =>
      doFetch(syncUrl, {
        method: 'POST',
        headers: {
          'Content-Type': SSP2_CONTENT_TYPE,
          ...hostHeaders(options),
        },
        body: request.slice().buffer as ArrayBuffer,
      }),
    );
    if (!response.ok) await throwHttpError(response);
    return new Uint8Array(
      await transfer(
        'response body read failed',
        () => response.arrayBuffer(),
        response.status,
      ),
    );
  };
}

/** POST one registered authoritative operation to `<mount>/operations`. */
export function httpRemoteOperationTransport(
  operationsUrl: string,
  options?: HttpTransportOptions,
): RemoteOperationTransport {
  const doFetch = options?.fetch ?? fetch;
  return async (request) => {
    const response = await transfer('remote operation request failed', () =>
      doFetch(operationsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.syncular.operations.v1+json',
          ...hostHeaders(options),
        },
        body: request.slice().buffer as ArrayBuffer,
      }),
    );
    if (!response.ok) await throwHttpError(response);
    return new Uint8Array(
      await transfer(
        'response body read failed',
        () => response.arrayBuffer(),
        response.status,
      ),
    );
  };
}

function socketOperation<T>(message: string, operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new ClientSyncError('sync.transport_failed', message, true, {
      causeKind: 'unknown',
    });
  }
}

/** WebSocket connector for registered query snapshots. */
export function webSocketRemoteOperationConnector(
  realtimeUrl: string,
): RemoteOperationRealtimeConnector {
  return (handlers) =>
    new Promise((resolve, reject) => {
      const socket = socketOperation(
        'realtime socket failed to connect',
        () => new WebSocket(realtimeUrl),
      );
      let opened = false;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        opened = true;
        resolve({
          send: (bytes) =>
            socketOperation('realtime send failed', () =>
              socket.send(bytes.slice().buffer as ArrayBuffer),
            ),
          close: () =>
            socketOperation('realtime close failed', () => socket.close()),
        });
      };
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          handlers.onMessage(new Uint8Array(event.data));
        }
      };
      socket.onerror = () => {
        if (!opened) {
          reject(
            new ClientSyncError(
              'sync.transport_failed',
              'remote operation realtime socket failed to connect',
              true,
            ),
          );
        }
        try {
          socket.close();
        } catch {
          handlers.onClose?.();
        }
      };
      socket.onclose = () => {
        if (!opened) {
          reject(
            new ClientSyncError(
              'sync.transport_failed',
              'remote operation realtime socket closed while connecting',
              true,
            ),
          );
        }
        handlers.onClose?.();
      };
    });
}

/**
 * §5.5 direct endpoint with the `X-Syncular-Scopes` re-authorization
 * header, plus the §5.4 `fetchUrl` capability (advertises accept bit 3).
 * `fetchUrl` sends NO headers at all — the signed URL is the entire
 * grant, and host auth must never leak to CDN/object hosts (§5.4).
 * Resolution (which path a descriptor takes, expiry, no fall-through)
 * lives in the client core, not here.
 */
async function readSegmentBody(
  response: Response,
  onProgress?: (bytesReceived: number) => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let reported = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (received - reported >= 64 * 1024) {
          onProgress?.(received);
          reported = received;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (received !== reported) onProgress?.(received);
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function httpSegmentDownloader(
  segmentsBaseUrl: string,
  options?: HttpTransportOptions,
): SegmentDownloader {
  const doFetch = options?.fetch ?? fetch;
  const download = async (
    url: string,
    init?: RequestInit,
    onProgress?: (bytesReceived: number) => void,
    signed = false,
  ) => {
    const response = await transfer('segment transfer failed', () =>
      doFetch(url, init),
    );
    if (!response.ok) {
      if (!signed) await throwHttpError(response);
      throw new ClientSyncError(
        'sync.transport_failed',
        'signed segment request failed; invalidate the descriptor and re-pull',
        true,
        { causeKind: 'status', httpStatus: response.status },
      );
    }
    return transfer(
      'segment transfer failed',
      () => readSegmentBody(response, onProgress),
      response.status,
    );
  };
  const direct = (request: {
    readonly segmentId: string;
    readonly requestedScopesJson: string;
    readonly onProgress?: (bytesReceived: number) => void;
  }) =>
    download(
      `${segmentsBaseUrl}/${encodeURIComponent(request.segmentId)}`,
      {
        headers: {
          'X-Syncular-Scopes': request.requestedScopesJson,
          ...hostHeaders(options),
        },
      },
      request.onProgress,
    );
  // Deliberately headerless: the URL is the bearer grant (§5.4).
  const fetchUrl = (
    url: string,
    onProgress?: (bytesReceived: number) => void,
  ) => download(url, undefined, onProgress, true);
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
      const response = await transfer('blob upload failed', () =>
        doFetch(blobUrl(blobId), {
          method: 'PUT',
          headers: {
            'Content-Type': mediaType ?? 'application/octet-stream',
            ...hostHeaders(options),
          },
          body: bytes.slice().buffer as ArrayBuffer,
        }),
      );
      if (!response.ok) await throwHttpError(response);
    },
    download: async (blobId) => {
      const response = await transfer('blob download failed', () =>
        doFetch(blobUrl(blobId), {
          headers: { ...hostHeaders(options) },
        }),
      );
      if (!response.ok)
        await throwHttpError(
          response,
          response.status === 404
            ? 'blob.not_found'
            : response.status === 403
              ? 'blob.forbidden'
              : response.status === 401
                ? 'sync.auth_required'
                : 'sync.transport_failed',
        );
      // §5.9.5 always-issue: a JSON body with `url` means presigned delivery;
      // an octet-stream body is inline bytes.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = (await transfer(
          'blob download body read failed',
          () => response.json(),
          response.status,
        )) as {
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
        bytes: new Uint8Array(
          await transfer(
            'blob download body read failed',
            () => response.arrayBuffer(),
            response.status,
          ),
        ),
      };
    },
    // §5.9.5: bare GET of the signed URL — no host auth (the URL is the grant).
    fetchUrl: async (url) => {
      const response = await transfer('signed blob download failed', () =>
        doFetch(url),
      );
      if (!response.ok) {
        throw new ClientSyncError(
          'sync.transport_failed',
          'signed blob download failed; re-request to recover',
          true,
          { causeKind: 'status', httpStatus: response.status },
        );
      }
      return new Uint8Array(
        await transfer(
          'response body read failed',
          () => response.arrayBuffer(),
          response.status,
        ),
      );
    },
    // §5.9.3: presigned-upload grant.
    uploadGrant: async (blobId, byteLength, mediaType) => {
      const response = await transfer('blob upload grant request failed', () =>
        doFetch(`${blobUrl(blobId)}/upload-grant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...hostHeaders(options),
          },
          body: JSON.stringify({
            byteLength,
            ...(mediaType !== undefined ? { mediaType } : {}),
          }),
        }),
      );
      if (!response.ok) await throwHttpError(response);
      const body = (await transfer(
        'blob upload grant body read failed',
        () => response.json(),
        response.status,
      )) as {
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
      const response = await transfer('signed blob upload failed', () =>
        doFetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': mediaType ?? 'application/octet-stream',
          },
          body: bytes.slice().buffer as ArrayBuffer,
        }),
      );
      if (!response.ok) {
        throw new ClientSyncError(
          'sync.transport_failed',
          'signed blob upload failed; re-request a grant or stream direct',
          true,
          { causeKind: 'status', httpStatus: response.status },
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
      const socket = socketOperation(
        'realtime socket failed to connect',
        () => new WebSocket(realtimeUrl),
      );
      let opened = false;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        opened = true;
        resolve({
          send: (text) =>
            socketOperation('realtime send failed', () => socket.send(text)),
          sendBytes: (bytes) => {
            socketOperation('realtime send failed', () =>
              socket.send(bytes.slice().buffer as ArrayBuffer),
            );
          },
          close: () =>
            socketOperation('realtime close failed', () => socket.close()),
        });
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') handlers.onText(event.data);
        else handlers.onBinary(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        if (!opened) {
          reject(
            new ClientSyncError(
              'sync.transport_failed',
              'realtime socket failed to connect',
              true,
            ),
          );
        }
        try {
          socket.close();
        } catch {
          handlers.onClose?.();
        }
      };
      socket.onclose = () => {
        if (!opened) {
          reject(
            new ClientSyncError(
              'sync.transport_failed',
              'realtime socket closed while connecting',
              true,
            ),
          );
        }
        handlers.onClose?.();
      };
    });
}
