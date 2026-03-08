/**
 * @syncular/transport-http - HTTP transport for Sync
 *
 * Provides:
 * - a lightweight fetch-based SyncTransport for client runtime use
 * - a separately exported typed API client for advanced/console use
 */

import type {
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncAuthOperation,
  SyncCombinedRequest,
  SyncCombinedResponse,
  SyncTransport,
  SyncTransportBlobs,
  SyncTransportOptions,
} from '@syncular/core';
import { SyncTransportError } from '@syncular/core';
import type { SyncClient } from './api-client';
import {
  applySnapshotScopesHeader,
  bytesToReadableStream,
  type ClientOptions,
  type ApiResult,
  encodeSnapshotScopes,
  executeWithAuthRetry,
  getErrorMessage,
  resolveRequestUrl,
  ResolveAuthRetry,
  resolveSnapshotChunkRequestUrl,
  SNAPSHOT_SCOPES_HEADER,
  type SyncTransportPath,
  unwrap,
} from './shared';

export {
  type SyncClient,
  type ClientOptions,
  type SyncTransportPath,
  unwrap,
};
export { createApiClient } from './api-client';

export type { operations } from './generated/api';

export type {
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncAuthOperation,
  SyncTransport,
  SyncTransportBlobs,
  SyncTransportOptions,
} from '@syncular/core';

function isApiClientLike(value: unknown): value is SyncClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SyncClient).GET === 'function' &&
    typeof (value as SyncClient).POST === 'function'
  );
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

export function createHttpTransport(
  clientOrOptions: SyncClient | ClientOptions
): SyncTransport {
  const client = isApiClientLike(clientOrOptions)
    ? createTypedTransportClient(clientOrOptions)
    : createFetchApiClient(clientOrOptions);
  const transportOptions = isApiClientLike(clientOrOptions)
    ? undefined
    : clientOrOptions;
  const resolveAuthRetry = createAuthRetryResolver(
    transportOptions?.authLifecycle
  );

  const blobs: SyncTransportBlobs = {
    async initiateUpload(args) {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.initiateUpload(args, signal),
        undefined,
        'blobInitiateUpload',
        resolveAuthRetry
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Blob upload init failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data;
    },

    async completeUpload(hash) {
      const { data, error } = await executeWithAuthRetry(
        (signal) =>
          client.completeUpload(hash, signal),
        undefined,
        'blobCompleteUpload',
        resolveAuthRetry
      );

      if (error || !data) {
        return {
          ok: false,
          error: getErrorMessage(error) || 'Complete upload failed',
        };
      }

      return data;
    },

    async getDownloadUrl(hash) {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.getDownloadUrl(hash, signal),
        undefined,
        'blobGetDownloadUrl',
        resolveAuthRetry
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Get download URL failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data;
    },
  };

  return {
    async sync(
      request: SyncCombinedRequest,
      transportRequestOptions?: SyncTransportOptions
    ): Promise<SyncCombinedResponse> {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.sync(request, signal),
        transportRequestOptions,
        'sync',
        resolveAuthRetry
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Sync failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data as SyncCombinedResponse;
    },

    async fetchSnapshotChunk(
      request: {
        chunkId: string;
        scopeValues?: Record<string, string | string[]>;
      },
      options?: SyncTransportOptions
    ): Promise<Uint8Array> {
      if (!transportOptions) {
        const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
            client.getSnapshotChunk(request.chunkId, request.scopeValues, signal),
          options,
          'snapshotChunk',
          resolveAuthRetry
        );

        if (error || !data) {
          throw new SyncTransportError(
            `Snapshot chunk download failed: ${getErrorMessage(error) || response.statusText}`,
            response.status
          );
        }

        return new Uint8Array(await (data as Blob).arrayBuffer());
      }

      const fetchImpl = transportOptions.fetch ?? globalThis.fetch;
      const requestUrl = resolveSnapshotChunkRequestUrl(
        transportOptions.baseUrl,
        request.chunkId,
        request.scopeValues
      );

      const performRequest = async (
        signal?: AbortSignal
      ): Promise<Response> => {
        const headers = new Headers();
        applySnapshotScopesHeader(headers, request.scopeValues);
        const extraHeaders = await transportOptions.getHeaders?.();
        if (extraHeaders) {
          for (const [key, value] of Object.entries(extraHeaders)) {
            headers.set(key, value);
          }
        }
        if (!headers.has('x-syncular-transport-path')) {
          headers.set(
            'x-syncular-transport-path',
            transportOptions.transportPath ?? 'direct'
          );
        }
        return fetchImpl(requestUrl, {
          method: 'GET',
          headers,
          ...(signal ? { signal } : {}),
        });
      };

      let response = await performRequest(options?.signal);
      if (response.status === 401 || response.status === 403) {
        const shouldRetry = await resolveAuthRetry(
          {
            operation: 'snapshotChunk',
            status: response.status,
          },
          options
        );
        if (shouldRetry) {
          response = await performRequest(options?.signal);
        }
      }

      if (!response.ok) {
        let reason = response.statusText || 'Request failed';
        try {
          const maybeJson = (await response.json()) as
            | { error?: unknown; message?: unknown }
            | undefined;
          reason = getErrorMessage(maybeJson) || reason;
        } catch {
          // ignore parse failures
        }
        throw new SyncTransportError(
          `Snapshot chunk download failed: ${reason}`,
          response.status
        );
      }

      return new Uint8Array(await response.arrayBuffer());
    },

    async fetchSnapshotChunkStream(
      request: {
        chunkId: string;
        scopeValues?: Record<string, string | string[]>;
      },
      options?: SyncTransportOptions
    ): Promise<ReadableStream<Uint8Array>> {
      if (!transportOptions) {
        const bytes = await this.fetchSnapshotChunk(request, options);
        return bytesToReadableStream(bytes);
      }

      const fetchImpl = transportOptions.fetch ?? globalThis.fetch;
      const requestUrl = resolveSnapshotChunkRequestUrl(
        transportOptions.baseUrl,
        request.chunkId,
        request.scopeValues
      );

      const performRequest = async (
        signal?: AbortSignal
      ): Promise<Response> => {
        const headers = new Headers();
        applySnapshotScopesHeader(headers, request.scopeValues);
        const extraHeaders = await transportOptions.getHeaders?.();
        if (extraHeaders) {
          for (const [key, value] of Object.entries(extraHeaders)) {
            headers.set(key, value);
          }
        }
        if (!headers.has('x-syncular-transport-path')) {
          headers.set(
            'x-syncular-transport-path',
            transportOptions.transportPath ?? 'direct'
          );
        }
        return fetchImpl(requestUrl, {
          method: 'GET',
          headers,
          ...(signal ? { signal } : {}),
        });
      };

      let response = await performRequest(options?.signal);
      if (response.status === 401 || response.status === 403) {
        const shouldRetry = await resolveAuthRetry(
          {
            operation: 'snapshotChunkStream',
            status: response.status,
          },
          options
        );
        if (shouldRetry) {
          response = await performRequest(options?.signal);
        }
      }

      if (!response.ok) {
        let reason = response.statusText || 'Request failed';
        try {
          const maybeJson = (await response.json()) as
            | { error?: unknown; message?: unknown }
            | undefined;
          reason = getErrorMessage(maybeJson) || reason;
        } catch {
          // ignore parse failures
        }
        throw new SyncTransportError(
          `Snapshot chunk download failed: ${reason}`,
          response.status
        );
      }

      if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytesToReadableStream(bytes);
      }

      return response.body as ReadableStream<Uint8Array>;
    },

    blobs,
  };
}
