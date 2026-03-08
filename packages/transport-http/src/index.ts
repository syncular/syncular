/**
 * @syncular/transport-http - HTTP transport for Sync
 *
 * Provides:
 * - a lightweight fetch-based SyncTransport for client runtime use
 * - a separately exported typed API client for advanced/console use
 */

import type {
  SyncCombinedRequest,
  SyncCombinedResponse,
  SyncTransport,
  SyncTransportOptions,
} from '@syncular/core';
import { SyncTransportError } from '@syncular/core';
import type { SyncClient } from './api-client';
import {
  applySnapshotScopesHeader,
  bytesToReadableStream,
  type ClientOptions,
  executeWithAuthRetry,
  getErrorMessage,
  resolveSnapshotChunkRequestUrl,
  type SyncTransportPath,
  unwrap,
} from './shared';
import {
  createTransportApiClient,
  createTransportAuthRetryResolver,
  HTTP_TRANSPORT_SOURCE,
  type HttpTransportSource,
} from './transport-client';

export { type SyncClient, type ClientOptions, type SyncTransportPath, unwrap };

export type {
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncAuthOperation,
  SyncTransport,
  SyncTransportOptions,
} from '@syncular/core';
export { createApiClient } from './api-client';
export type { operations } from './generated/api';

export function createHttpTransport(
  clientOrOptions: SyncClient | ClientOptions
): SyncTransport {
  const client = createTransportApiClient(clientOrOptions);
  const resolveAuthRetry = createTransportAuthRetryResolver(clientOrOptions);
  const transportOptions =
    'baseUrl' in clientOrOptions ? clientOrOptions : undefined;

  const transport: SyncTransport = {
    async sync(
      request: SyncCombinedRequest,
      transportRequestOptions?: SyncTransportOptions
    ): Promise<SyncCombinedResponse> {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) => client.sync(request, signal),
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
            client.getSnapshotChunk(
              request.chunkId,
              request.scopeValues,
              signal
            ),
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
  };

  Object.defineProperty(transport, HTTP_TRANSPORT_SOURCE, {
    configurable: false,
    enumerable: false,
    value: clientOrOptions as HttpTransportSource,
    writable: false,
  });

  return transport;
}
