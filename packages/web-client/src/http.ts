/**
 * Browser transport bindings (§1.1, §5.4/§5.5, §8.1): fetch-based sync
 * transport, descriptor-selected signed-URL or direct segment delivery, and
 * WebSocket realtime connectors. Adapter tests inject fetch and socket surfaces;
 * protocol core conformance uses loopback.
 */
import type { BlobTransport } from './blob';
import { definedObject } from '@syncular/core';
import { SSP2_CONTENT_TYPE } from './content-type';
import { ClientSyncError, transportFailed } from './errors';
import { hexToBytes } from './schema';
import type {
  RealtimeConnector,
  TransportContext,
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
    throw transportFailed(message, {
      causeKind,
      ...definedObject({ httpStatus }),
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
  let recommendedAction: string | undefined;
  let serverDetails: Readonly<Record<string, unknown>> | undefined;
  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      retryable?: boolean;
      recommendedAction?: string;
      details?: unknown;
    };
    // Only the blob download endpoint can establish absence.
    if (body.code !== 'blob.not_found' || defaultCode === 'blob.not_found') {
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.retryable === 'boolean') retryable = body.retryable;
      if (typeof body.recommendedAction === 'string')
        recommendedAction = body.recommendedAction;
      if (
        typeof body.details === 'object' &&
        body.details !== null &&
        !Array.isArray(body.details)
      )
        serverDetails = body.details as Readonly<Record<string, unknown>>;
    }
  } catch {
    // non-JSON error body — keep the HTTP-status defaults
  }
  throw new ClientSyncError(
    code,
    message,
    retryable,
    {
      ...serverDetails,
      causeKind: 'status',
      httpStatus: response.status,
    },
    recommendedAction,
  );
}

/** The request a header source answers for (§1.1). */
export interface HeaderContext extends TransportContext {
  readonly target: 'sync' | 'segment' | 'blob' | 'realtime';
}

/**
 * The host's header source (§1.1 "The transport asks, the host answers"):
 * called before every host-authenticated request, and once more with the
 * refused headers after a 401, before the one retry. `context` names the
 * replica, round and target; a transport called directly, outside a client,
 * passes none.
 */
export type HeaderSource = (
  rejected: Readonly<Record<string, string>> | undefined,
  context: HeaderContext | undefined,
) =>
  | Readonly<Record<string, string>>
  | Promise<Readonly<Record<string, string>>>;

export interface HttpTransportOptions {
  /**
   * Host auth headers: a fixed set, or the {@link HeaderSource} the
   * transport asks per request. Signed-URL fetches never carry them (§5.4,
   * §5.9.5).
   */
  readonly headers?: Readonly<Record<string, string>> | HeaderSource;
  readonly fetch?: typeof fetch;
}

/** In-flight source calls per source, keyed by replica, round and whether
 * they follow a 401, shared by every transport built on that source (single
 * flight, §1.1). */
const flights = new WeakMap<
  HeaderSource,
  Map<string, Promise<Readonly<Record<string, string>>>>
>();

/**
 * Send one host-authenticated request (§1.1). A source is asked first; a 401
 * asks it again with the refused headers and resends once. A second 401
 * surfaces through the caller's status handling as `sync.auth_required`.
 */
async function authorized(
  options: HttpTransportOptions | undefined,
  message: string,
  context: HeaderContext | undefined,
  send: (headers?: Readonly<Record<string, string>>) => Promise<Response>,
): Promise<Response> {
  const source = options?.headers;
  if (typeof source !== 'function')
    return transfer(message, () => send(source));
  const ask = (rejected?: Readonly<Record<string, string>>) => {
    let byKind = flights.get(source);
    if (byKind === undefined) flights.set(source, (byKind = new Map()));
    const kind = JSON.stringify([
      context?.clientId,
      context?.round,
      rejected !== undefined,
    ]);
    let flight = byKind.get(kind);
    if (flight === undefined) {
      const started = (flight = Promise.resolve()
        .then(() => source(rejected, context))
        .catch(() => {
          throw new ClientSyncError(
            'sync.auth_required',
            'the header source failed',
            true,
            { causeKind: 'header_source' },
          );
        }));
      byKind.set(kind, started);
      const settle = () => {
        if (byKind.get(kind) === started) byKind.delete(kind);
      };
      started.then(settle, settle);
    }
    return flight;
  };
  const headers = await ask();
  const response = await transfer(message, () => send(headers));
  if (response.status !== 401) return response;
  await response.body?.cancel();
  const renewed = await ask(headers);
  return transfer(message, () => send(renewed));
}

/** POST `<mount>/sync` with SSP2 bodies (§1.1). */
export function httpSyncTransport(
  syncUrl: string,
  options?: HttpTransportOptions,
): SyncTransport {
  const doFetch = options?.fetch ?? fetch;
  return async (request, signal, context) => {
    const body = request.slice().buffer as ArrayBuffer;
    const response = await authorized(
      options,
      'sync request failed',
      context && { ...context, target: 'sync' },
      (headers) =>
        doFetch(syncUrl, {
          method: 'POST',
          headers: { 'Content-Type': SSP2_CONTENT_TYPE, ...headers },
          body,
          ...definedObject({ signal }),
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
  return async (request, context) => {
    const body = request.slice().buffer as ArrayBuffer;
    const response = await authorized(
      options,
      'remote operation request failed',
      context && { ...context, target: 'sync' },
      (headers) =>
        doFetch(operationsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.syncular.operations.v1+json',
            ...headers,
          },
          body,
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
    throw transportFailed(message, {
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
            transportFailed(
              'remote operation realtime socket failed to connect',
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
            transportFailed(
              'remote operation realtime socket closed while connecting',
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
async function readBody(
  response: Response,
  onProgress?: (bytesReceived: number) => void,
  maxBytes?: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
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
        // The caller rejects a body longer than its declared byteLength.
        if (received > (maxBytes ?? received)) {
          await reader.cancel();
          break;
        }
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
  // One allocation of the body's size. A Blob of the chunks and its
  // arrayBuffer() kept one more full copy resident until garbage collection.
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
    init: (
      headers?: Readonly<Record<string, string>>,
    ) => RequestInit | undefined,
    onProgress?: (bytesReceived: number) => void,
    signed = false,
    maxBytes?: number,
    context?: TransportContext,
  ) => {
    // Deliberately headerless when signed: the URL is the bearer grant (§5.4).
    const response = signed
      ? await transfer('segment transfer failed', () => doFetch(url, init()))
      : await authorized(
          options,
          'segment transfer failed',
          context && { ...context, target: 'segment' },
          (headers) => doFetch(url, init(headers)),
        );
    if (!response.ok) {
      if (!signed) await throwHttpError(response);
      throw transportFailed('signed segment request failed', {
        causeKind: 'status',
        httpStatus: response.status,
      });
    }
    return transfer(
      'segment transfer failed',
      () => readBody(response, onProgress, maxBytes),
      response.status,
    );
  };
  const direct = (request: {
    readonly segmentId: string;
    readonly requestedScopesJson: string;
    readonly byteLength?: number;
    readonly onProgress?: (bytesReceived: number) => void;
    readonly signal?: AbortSignal;
    readonly context?: TransportContext;
  }) =>
    download(
      `${segmentsBaseUrl}/${encodeURIComponent(request.segmentId)}`,
      (headers) => ({
        headers: {
          'X-Syncular-Scopes': request.requestedScopesJson,
          ...headers,
        },
        ...definedObject({ signal: request.signal }),
      }),
      request.onProgress,
      false,
      request.byteLength,
      request.context,
    );
  // Deliberately headerless: the URL is the bearer grant (§5.4).
  const fetchUrl = (
    url: string,
    onProgress?: (bytesReceived: number) => void,
    signal?: AbortSignal,
    byteLength?: number,
  ) => download(url, () => signal && { signal }, onProgress, true, byteLength);
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
    upload: async (blobId, bytes, mediaType, signal, context) => {
      const body = bytes.slice().buffer as ArrayBuffer;
      const response = await authorized(
        options,
        'blob upload failed',
        context && { ...context, target: 'blob' },
        (headers) =>
          doFetch(blobUrl(blobId), {
            method: 'PUT',
            headers: {
              'Content-Type': mediaType ?? 'application/octet-stream',
              ...headers,
            },
            body,
            ...definedObject({ signal }),
          }),
      );
      if (!response.ok) await throwHttpError(response);
    },
    download: async (blobId, byteLength, context) => {
      const response = await authorized(
        options,
        'blob download failed',
        context && { ...context, target: 'blob' },
        (headers) => doFetch(blobUrl(blobId), { headers: { ...headers } }),
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
      // §5.9.5 always-issue: a JSON body with a `url` means presigned delivery;
      // any other body is inline bytes, capped by the declared byteLength.
      const json = (response.headers.get('content-type') ?? '').includes(
        'application/json',
      );
      const bytes = await transfer(
        'blob body read failed',
        () => readBody(response, undefined, json ? undefined : byteLength),
        response.status,
      );
      if (json) {
        let envelope: { url?: unknown; urlExpiresAtMs?: unknown } | null = null;
        try {
          envelope = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          // Not JSON: inline bytes.
        }
        const grant = envelope && urlGrant(envelope);
        if (grant) return grant;
      }
      return { kind: 'bytes', bytes };
    },
    // §5.9.5: bare GET of the signed URL — no host auth (the URL is the grant).
    fetchUrl: async (url, byteLength) => {
      const response = await transfer('signed blob download failed', () =>
        doFetch(url),
      );
      if (!response.ok) {
        throw transportFailed('signed blob download failed', {
          causeKind: 'status',
          httpStatus: response.status,
        });
      }
      return transfer(
        'response body read failed',
        () => readBody(response, undefined, byteLength),
        response.status,
      );
    },
    // §5.9.3: presigned-upload grant.
    uploadGrant: async (blobId, byteLength, mediaType, signal, context) => {
      const response = await authorized(
        options,
        'blob upload grant request failed',
        context && { ...context, target: 'blob' },
        (headers) =>
          doFetch(`${blobUrl(blobId)}/upload-grant`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...headers,
            },
            body: JSON.stringify({
              byteLength,
              mediaType,
            }),
            ...definedObject({ signal }),
          }),
      );
      if (!response.ok) await throwHttpError(response);
      const body = (await transfer(
        'blob grant read failed',
        () => response.json(),
        response.status,
      )) as { url?: unknown; urlExpiresAtMs?: unknown; present?: boolean };
      return (
        urlGrant(body) ??
        (body.present === true ? { kind: 'present' } : { kind: 'none' })
      );
    },
    // §5.9.3: direct-to-storage PUT — no host auth (the URL is the grant).
    uploadToUrl: async (blobId, url, bytes, mediaType, signal) => {
      // The grant signs content-length (set by fetch from the body) and the
      // checksum, the blob id's digest, so the object store rejects any other
      // bytes without the client hashing the body again (§5.9.3).
      const hex = /^sha256:([0-9a-f]{64})$/.exec(blobId)?.[1];
      if (hex === undefined) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'the blob id is not a sha256 blob id (§5.9.1)',
        );
      }
      const checksum = btoa(String.fromCharCode(...hexToBytes(hex)));
      const body = bytes.slice().buffer as ArrayBuffer;
      const response = await transfer('signed blob upload failed', () =>
        doFetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': mediaType ?? 'application/octet-stream',
            'x-amz-checksum-sha256': checksum,
          },
          body,
          ...definedObject({ signal }),
        }),
      );
      if (!response.ok) {
        throw transportFailed('signed blob upload failed', {
          causeKind: 'status',
          httpStatus: response.status,
        });
      }
    },
  };
}

/**
 * WebSocket realtime connector (§8.1): text = control, binary = deltas. The
 * client's id replaces a `{clientId}` placeholder in the URL.
 */
export function webSocketRealtimeConnector(
  realtimeUrl: string,
): RealtimeConnector {
  return (handlers, clientId) =>
    new Promise((resolve, reject) => {
      const socket = socketOperation(
        'realtime socket failed to connect',
        () =>
          new WebSocket(
            clientId === undefined
              ? realtimeUrl
              : realtimeUrl.replace('{clientId}', encodeURIComponent(clientId)),
          ),
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
          reject(transportFailed('realtime socket failed to connect'));
        }
        try {
          socket.close();
        } catch {
          handlers.onClose?.();
        }
      };
      socket.onclose = () => {
        if (!opened) {
          reject(transportFailed('realtime socket closed while connecting'));
        }
        handlers.onClose?.();
      };
    });
}

/** §5.9.3, §5.9.5: a JSON body with a string `url` is a presigned grant. */
function urlGrant(body: { url?: unknown; urlExpiresAtMs?: unknown }) {
  return typeof body.url === 'string'
    ? {
        kind: 'url' as const,
        url: body.url,
        ...(typeof body.urlExpiresAtMs === 'number'
          ? { urlExpiresAtMs: body.urlExpiresAtMs }
          : {}),
      }
    : undefined;
}
