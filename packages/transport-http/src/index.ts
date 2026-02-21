/**
 * @syncular/transport-http - HTTP transport for Sync
 *
 * Provides typed API clients using openapi-fetch with auto-generated types.
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
import createClient from 'openapi-fetch';
import type { paths } from './generated/api';

export type {
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncAuthOperation,
  SyncTransport,
  SyncTransportBlobs,
  SyncTransportOptions,
} from '@syncular/core';

/**
 * Error thrown when unwrapping an API response fails.
 */
class ApiResponseError extends Error {
  constructor(
    message: string,
    public readonly error?: unknown
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

/**
 * Helper to unwrap openapi-fetch responses.
 * Throws ApiResponseError if the response contains an error or no data.
 */
function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const inner = (error as { error: unknown }).error;
    if (typeof inner === 'string') return inner;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return 'Request failed';
}

export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown }>
): Promise<T> {
  const { data, error } = await promise;
  if (error || !data) {
    throw new ApiResponseError(getErrorMessage(error), error);
  }
  return data;
}

type ApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

type ResolveAuthRetry = (
  context: SyncAuthErrorContext,
  options?: SyncTransportOptions
) => Promise<boolean>;

async function executeWithAuthRetry<T>(
  execute: (signal?: AbortSignal) => Promise<ApiResult<T>>,
  options: SyncTransportOptions | undefined,
  operation: SyncAuthOperation,
  resolveAuthRetry: ResolveAuthRetry
): Promise<ApiResult<T>> {
  const first = await execute(options?.signal);
  if (first.response.status !== 401 && first.response.status !== 403) {
    return first;
  }
  const shouldRetry = await resolveAuthRetry(
    { operation, status: first.response.status },
    options
  );
  if (!shouldRetry) {
    return first;
  }

  return execute(options?.signal);
}

// Re-export useful types from the generated API
export type SyncClient = ReturnType<typeof createClient<paths>>;
export type SyncTransportPath = 'direct' | 'relay';

export interface ClientOptions {
  /** Base URL for the API (e.g., 'https://api.example.com') */
  baseUrl: string;
  /** Function to get headers for requests (e.g., for auth tokens) */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Shared auth lifecycle for all transport operations. */
  authLifecycle?: SyncAuthLifecycle;
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: typeof globalThis.fetch;
  /**
   * Transport path telemetry sent to the server.
   * Defaults to 'direct'.
   */
  transportPath?: SyncTransportPath;
}

function resolveRequestUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, '');
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(baseUrl);
  if (isAbsolute) {
    return new URL(normalizedPath, normalizedBaseUrl).toString();
  }
  if (typeof location === 'undefined') {
    return `${baseUrl.replace(/\/$/, '')}/${normalizedPath}`;
  }
  return new URL(
    `${baseUrl.replace(/\/$/, '')}/${normalizedPath}`,
    location.origin
  ).toString();
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Create a typed API client for the full Syncular API.
 *
 * Returns an openapi-fetch client with full type safety for all endpoints.
 *
 * @example
 * ```typescript
 * const client = createApiClient({
 *   baseUrl: 'https://api.example.com',
 *   getHeaders: () => ({ Authorization: `Bearer ${token}` }),
 * });
 *
 * // Sync endpoints
 * const { data } = await client.POST('/sync', { body: { clientId: 'c1', pull: { ... } } });
 *
 * // Console endpoints
 * const { data: stats } = await client.GET('/console/stats');
 * const { data: commits } = await client.GET('/console/commits', {
 *   params: { query: { limit: 50 } }
 * });
 * ```
 */
export function createApiClient(options: ClientOptions): SyncClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch && { fetch: options.fetch }),
  });

  const getHeaders = options.getHeaders;
  const transportPath = options.transportPath ?? 'direct';

  client.use({
    async onRequest({ request }) {
      if (getHeaders) {
        const headers = await getHeaders();
        for (const [key, value] of Object.entries(headers)) {
          request.headers.set(key, value);
        }
      }

      if (!request.headers.has('x-syncular-transport-path')) {
        request.headers.set('x-syncular-transport-path', transportPath);
      }

      return request;
    },
  });

  return client;
}

/**
 * Create a SyncTransport from an API client or options.
 *
 * The transport includes both sync and blob operations via the typed OpenAPI client.
 *
 * @example
 * ```typescript
 * // From options (convenience)
 * const transport = createHttpTransport({
 *   baseUrl: 'https://api.example.com',
 *   getHeaders: () => ({ Authorization: `Bearer ${token}` }),
 * });
 *
 * // Or from an existing client
 * const client = createApiClient({ baseUrl: 'https://api.example.com' });
 * const transport = createHttpTransport(client);
 *
 * // Use with Client
 * const syncClient = new Client({ transport, ... });
 * ```
 */
export function createHttpTransport(
  clientOrOptions: SyncClient | ClientOptions
): SyncTransport {
  const client =
    'GET' in clientOrOptions
      ? clientOrOptions
      : createApiClient(clientOrOptions);
  const transportOptions =
    'GET' in clientOrOptions ? undefined : clientOrOptions;
  const defaultAuthLifecycle = transportOptions?.authLifecycle;

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

  const resolveAuthRetry: ResolveAuthRetry = async (context, options) => {
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

  // Create blob operations using the typed OpenAPI client
  const blobs: SyncTransportBlobs = {
    async initiateUpload(args) {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.POST('/sync/blobs/upload', {
            body: args,
            ...(signal ? { signal } : {}),
          }),
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
          client.POST('/sync/blobs/{hash}/complete', {
            params: { path: { hash } },
            ...(signal ? { signal } : {}),
          }),
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
          client.GET('/sync/blobs/{hash}/url', {
            params: { path: { hash } },
            ...(signal ? { signal } : {}),
          }),
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

      return {
        url: data.url,
        expiresAt: data.expiresAt,
      };
    },
  };

  return {
    async sync(
      request: SyncCombinedRequest,
      transportOptions?: SyncTransportOptions
    ): Promise<SyncCombinedResponse> {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.POST('/sync', {
            body: request,
            ...(signal ? { signal } : {}),
          }),
        transportOptions,
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
      request: { chunkId: string },
      transportOptions?: SyncTransportOptions
    ): Promise<Uint8Array> {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.GET('/sync/snapshot-chunks/{chunkId}', {
            params: { path: { chunkId: request.chunkId } },
            parseAs: 'blob',
            ...(signal ? { signal } : {}),
          }),
        transportOptions,
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
    },

    async fetchSnapshotChunkStream(
      request: { chunkId: string },
      options?: SyncTransportOptions
    ): Promise<ReadableStream<Uint8Array>> {
      if (!transportOptions) {
        const bytes = await this.fetchSnapshotChunk(request, options);
        return bytesToReadableStream(bytes);
      }

      const fetchImpl = transportOptions.fetch ?? globalThis.fetch;
      const requestUrl = resolveRequestUrl(
        transportOptions.baseUrl,
        `/sync/snapshot-chunks/${encodeURIComponent(request.chunkId)}`
      );

      const performRequest = async (
        signal?: AbortSignal
      ): Promise<Response> => {
        const headers = new Headers();
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

    // Include blob operations
    blobs,
  };
}
