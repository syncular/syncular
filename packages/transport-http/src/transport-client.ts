import type {
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncCombinedRequest,
  SyncCombinedResponse,
} from '@syncular/core';
import type { SyncClient } from './api-client';
import {
  type ApiResult,
  type ClientOptions,
  encodeSnapshotScopes,
  type ResolveAuthRetry,
  resolveRequestUrl,
  SNAPSHOT_SCOPES_HEADER,
} from './shared';

export type { ClientOptions };

export const HTTP_TRANSPORT_SOURCE = Symbol.for(
  '@syncular/transport-http/source'
);

export type HttpTransportSource = SyncClient | ClientOptions;

function isApiClientLike(value: unknown): value is SyncClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SyncClient).GET === 'function' &&
    typeof (value as SyncClient).POST === 'function'
  );
}

interface TransportApiClient {
  sync(
    request: SyncCombinedRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<SyncCombinedResponse>>;
  initiateUpload(
    args: { hash: string; size: number; mimeType: string },
    signal?: AbortSignal
  ): Promise<
    ApiResult<{
      exists: boolean;
      uploadUrl?: string;
      uploadMethod?: 'PUT' | 'POST';
      uploadHeaders?: Record<string, string>;
    }>
  >;
  completeUpload(
    hash: string,
    signal?: AbortSignal
  ): Promise<ApiResult<{ ok: boolean; error?: string }>>;
  getDownloadUrl(
    hash: string,
    signal?: AbortSignal
  ): Promise<ApiResult<{ url: string; expiresAt: string }>>;
  getSnapshotChunk(
    chunkId: string,
    scopeValues: Record<string, string | string[]> | undefined,
    signal?: AbortSignal
  ): Promise<ApiResult<Blob>>;
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.includes('application/json') === true;
}

async function parseErrorBody(response: Response): Promise<unknown> {
  if (!isJsonContentType(response.headers.get('content-type'))) {
    return undefined;
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function parseJsonBody<T>(response: Response): Promise<T | undefined> {
  if (!isJsonContentType(response.headers.get('content-type'))) {
    return undefined;
  }
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

function createAuthRetryResolver(
  defaultAuthLifecycle: SyncAuthLifecycle | undefined
): ResolveAuthRetry {
  let refreshInFlight: Promise<boolean> | null = null;

  const runRefreshSingleFlight = async (
    lifecycle: SyncAuthLifecycle,
    context: SyncAuthErrorContext
  ): Promise<boolean> => {
    if (!lifecycle.refreshToken) return false;

    if (!refreshInFlight) {
      refreshInFlight = Promise.resolve(lifecycle.refreshToken(context))
        .then((result) => Boolean(result))
        .finally(() => {
          refreshInFlight = null;
        });
    }

    return refreshInFlight;
  };

  return async (context, options) => {
    if (options?.onAuthError) {
      return Boolean(await options.onAuthError());
    }

    const lifecycle = options?.authLifecycle ?? defaultAuthLifecycle;
    if (!lifecycle) return false;

    await lifecycle.onAuthExpired?.(context);

    const refreshResult = await runRefreshSingleFlight(lifecycle, context);
    if (lifecycle.retryWithFreshToken) {
      return Boolean(
        await lifecycle.retryWithFreshToken({ ...context, refreshResult })
      );
    }
    return refreshResult;
  };
}

function createRequestHeaders(
  baseOptions: ClientOptions,
  extraHeaders?: Record<string, string>
): Promise<Headers> {
  return Promise.resolve(baseOptions.getHeaders?.()).then((dynamicHeaders) => {
    const headers = new Headers(extraHeaders);
    if (dynamicHeaders) {
      for (const [key, value] of Object.entries(dynamicHeaders)) {
        headers.set(key, value);
      }
    }
    if (!headers.has('x-syncular-transport-path')) {
      headers.set(
        'x-syncular-transport-path',
        baseOptions.transportPath ?? 'direct'
      );
    }
    return headers;
  });
}

function createFetchApiClient(baseOptions: ClientOptions): TransportApiClient {
  const fetchImpl = baseOptions.fetch ?? globalThis.fetch;

  const request = async <T>(args: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    parseAs?: 'json' | 'blob';
  }): Promise<ApiResult<T>> => {
    const headers = await createRequestHeaders(baseOptions, args.headers);
    let body: BodyInit | undefined;
    if (args.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(args.body);
    }

    const response = await fetchImpl(
      resolveRequestUrl(baseOptions.baseUrl, args.path),
      {
        method: args.method,
        headers,
        body,
        ...(args.signal ? { signal: args.signal } : {}),
      }
    );

    if (!response.ok) {
      return {
        response,
        error: await parseErrorBody(response),
      };
    }

    if (args.parseAs === 'blob') {
      return {
        response,
        data: (await response.blob()) as T,
      };
    }

    return {
      response,
      data: await parseJsonBody<T>(response),
    };
  };

  return {
    sync: (requestBody, signal) =>
      request({
        method: 'POST',
        path: '/sync',
        body: requestBody,
        signal,
      }),
    initiateUpload: (args, signal) =>
      request({
        method: 'POST',
        path: '/sync/blobs/upload',
        body: args,
        signal,
      }),
    completeUpload: (hash, signal) =>
      request({
        method: 'POST',
        path: `/sync/blobs/${encodeURIComponent(hash)}/complete`,
        signal,
      }),
    getDownloadUrl: (hash, signal) =>
      request({
        method: 'GET',
        path: `/sync/blobs/${encodeURIComponent(hash)}/url`,
        signal,
      }),
    getSnapshotChunk: (chunkId, scopeValues, signal) =>
      request({
        method: 'GET',
        path: `/sync/snapshot-chunks/${encodeURIComponent(chunkId)}`,
        headers: (() => {
          const encodedScopes = encodeSnapshotScopes(scopeValues);
          return encodedScopes
            ? {
                [SNAPSHOT_SCOPES_HEADER]: encodedScopes,
              }
            : undefined;
        })(),
        signal,
        parseAs: 'blob',
      }),
  };
}

function createTypedTransportClient(client: SyncClient): TransportApiClient {
  return {
    sync: (request, signal) =>
      client.POST('/sync', {
        body: request,
        ...(signal ? { signal } : {}),
      }) as Promise<ApiResult<SyncCombinedResponse>>,
    initiateUpload: (args, signal) =>
      client.POST('/sync/blobs/upload', {
        body: args,
        ...(signal ? { signal } : {}),
      }) as Promise<
        ApiResult<{
          exists: boolean;
          uploadUrl?: string;
          uploadMethod?: 'PUT' | 'POST';
          uploadHeaders?: Record<string, string>;
        }>
      >,
    completeUpload: (hash, signal) =>
      client.POST('/sync/blobs/{hash}/complete', {
        params: { path: { hash } },
        ...(signal ? { signal } : {}),
      }) as Promise<ApiResult<{ ok: boolean; error?: string }>>,
    getDownloadUrl: (hash, signal) =>
      client.GET('/sync/blobs/{hash}/url', {
        params: { path: { hash } },
        ...(signal ? { signal } : {}),
      }) as Promise<ApiResult<{ url: string; expiresAt: string }>>,
    getSnapshotChunk: (chunkId, scopeValues, signal) =>
      client.GET('/sync/snapshot-chunks/{chunkId}', {
        params: { path: { chunkId } },
        parseAs: 'blob',
        headers: (() => {
          const encodedScopes = encodeSnapshotScopes(scopeValues);
          return encodedScopes
            ? {
                [SNAPSHOT_SCOPES_HEADER]: encodedScopes,
              }
            : undefined;
        })(),
        ...(signal ? { signal } : {}),
      }) as Promise<ApiResult<Blob>>,
  };
}

export function createTransportApiClient(
  source: HttpTransportSource
): TransportApiClient {
  return isApiClientLike(source)
    ? createTypedTransportClient(source)
    : createFetchApiClient(source);
}

export function createTransportAuthRetryResolver(
  source: HttpTransportSource
): ResolveAuthRetry {
  return createAuthRetryResolver(
    isApiClientLike(source) ? undefined : source.authLifecycle
  );
}
