/**
 * @syncular/transport-http - HTTP transport for Sync
 *
 * Provides typed API clients using openapi-fetch with auto-generated types.
 */

import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncTransport,
  SyncTransportBlobs,
  SyncTransportOptions,
} from '@syncular/core';
import { SyncTransportError } from '@syncular/core';
import createClient from 'openapi-fetch';
import type { paths } from './generated/api';

export type {
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

async function executeWithAuthRetry<T>(
  execute: (signal?: AbortSignal) => Promise<ApiResult<T>>,
  options?: SyncTransportOptions
): Promise<ApiResult<T>> {
  const first = await execute(options?.signal);
  if (first.response.status !== 401 && first.response.status !== 403) {
    return first;
  }
  if (!options?.onAuthError) {
    return first;
  }

  const shouldRetry = await options.onAuthError();
  if (!shouldRetry) {
    return first;
  }

  return execute(options.signal);
}

// Re-export useful types from the generated API
export type SyncClient = ReturnType<typeof createClient<paths>>;
export type SyncTransportPath = 'direct' | 'relay';

export interface ClientOptions {
  /** Base URL for the API (e.g., 'https://api.example.com') */
  baseUrl: string;
  /** Function to get headers for requests (e.g., for auth tokens) */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: typeof globalThis.fetch;
  /**
   * Transport path telemetry sent to the server.
   * Defaults to 'direct'.
   */
  transportPath?: SyncTransportPath;
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
 * const { data } = await client.POST('/sync/pull', { body: { ... } });
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

  // Create blob operations using the typed OpenAPI client
  const blobs: SyncTransportBlobs = {
    async initiateUpload(args) {
      const { data, error, response } = await client.POST(
        '/sync/blobs/upload',
        {
          body: args,
        }
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
      const { data, error } = await client.POST('/sync/blobs/{hash}/complete', {
        params: { path: { hash } },
      });

      if (error || !data) {
        return {
          ok: false,
          error: getErrorMessage(error) || 'Complete upload failed',
        };
      }

      return data;
    },

    async getDownloadUrl(hash) {
      const { data, error, response } = await client.GET(
        '/sync/blobs/{hash}/url',
        {
          params: { path: { hash } },
        }
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
    async pull(
      request: SyncPullRequest,
      transportOptions?: SyncTransportOptions
    ): Promise<SyncPullResponse> {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.POST('/sync/pull', {
            body: request,
            ...(signal ? { signal } : {}),
          }),
        transportOptions
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Pull failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data as SyncPullResponse;
    },

    async push(
      request: SyncPushRequest,
      transportOptions?: SyncTransportOptions
    ): Promise<SyncPushResponse> {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) =>
          client.POST('/sync/push', {
            body: request,
            ...(signal ? { signal } : {}),
          }),
        transportOptions
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Push failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data as SyncPushResponse;
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
        transportOptions
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Snapshot chunk download failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return new Uint8Array(await (data as Blob).arrayBuffer());
    },

    // Include blob operations
    blobs,
  };
}
