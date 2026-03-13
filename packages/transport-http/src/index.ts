/**
 * @syncular/transport-http - HTTP transport for Sync
 *
 * Provides:
 * - a lightweight fetch-based SyncTransport for client runtime use
 * - a separately exported typed API client for advanced/console use
 */

import type {
  SyncBootstrapApplyMode,
  SyncCombinedRequest,
  SyncCombinedResponse,
  SyncTransport,
  SyncTransportCapabilities,
  SyncTransportOptions,
} from '@syncular/core';
import { SyncTransportError } from '@syncular/core';
import type { SyncClient } from './api-client';
import {
  applySnapshotScopesHeader,
  bytesToReadableStream,
  type ClientOptions,
  executeWithAuthRetry,
  executeWithTransientNetworkRetry,
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

function detectDefaultTransportCapabilities(): SyncTransportCapabilities {
  const isReactNative =
    typeof navigator !== 'undefined' && navigator?.product === 'ReactNative';
  const snapshotChunkReadMode = isReactNative ? 'bytes' : 'stream';
  const gzipDecompressionMode =
    !isReactNative && typeof DecompressionStream !== 'undefined'
      ? 'stream'
      : 'buffered';
  const preferredBootstrapApplyMode: SyncBootstrapApplyMode =
    snapshotChunkReadMode === 'bytes' || gzipDecompressionMode === 'buffered'
      ? 'per-subscription'
      : 'single-transaction';

  return {
    snapshotChunkReadMode,
    gzipDecompressionMode,
    preferredBootstrapApplyMode,
    preferredSnapshotApplyYieldMs: isReactNative ? 0 : false,
  };
}

function mergeTransportCapabilities(
  overrides?: Partial<SyncTransportCapabilities>
): SyncTransportCapabilities {
  const defaults = detectDefaultTransportCapabilities();
  const merged: SyncTransportCapabilities = {
    ...defaults,
    ...overrides,
  };

  if (
    overrides?.preferredBootstrapApplyMode !== undefined &&
    overrides?.preferredSnapshotApplyYieldMs !== undefined
  ) {
    return merged;
  }

  const preferredBootstrapApplyMode: SyncBootstrapApplyMode =
    merged.snapshotChunkReadMode === 'bytes' ||
    merged.gzipDecompressionMode === 'buffered'
      ? 'per-subscription'
      : 'single-transaction';

  return {
    ...merged,
    preferredBootstrapApplyMode:
      overrides?.preferredBootstrapApplyMode ?? preferredBootstrapApplyMode,
    preferredSnapshotApplyYieldMs:
      overrides?.preferredSnapshotApplyYieldMs ??
      (merged.snapshotChunkReadMode === 'bytes' ||
      merged.gzipDecompressionMode === 'buffered'
        ? 0
        : false),
  };
}

function shouldUseResponseBodyStream(
  response: Response,
  capabilities: SyncTransportCapabilities
): boolean {
  if (!response.body) return false;
  if (capabilities.snapshotChunkReadMode === 'bytes') {
    return false;
  }
  return (
    typeof (response.body as ReadableStream<Uint8Array>).getReader ===
    'function'
  );
}

export const REACT_NATIVE_TRANSPORT_CAPABILITIES: SyncTransportCapabilities = {
  snapshotChunkReadMode: 'bytes',
  gzipDecompressionMode: 'buffered',
  preferredBootstrapApplyMode: 'per-subscription',
  preferredSnapshotApplyYieldMs: 0,
  preferMaterializedSnapshots: true,
};

export function createHttpTransport(
  clientOrOptions: SyncClient | ClientOptions
): SyncTransport {
  const client = createTransportApiClient(clientOrOptions);
  const resolveAuthRetry = createTransportAuthRetryResolver(clientOrOptions);
  const transportOptions =
    'baseUrl' in clientOrOptions ? clientOrOptions : undefined;
  const capabilities =
    'baseUrl' in clientOrOptions
      ? mergeTransportCapabilities(clientOrOptions.capabilities)
      : mergeTransportCapabilities();

  const transport: SyncTransport = {
    capabilities,
    async sync(
      request: SyncCombinedRequest,
      transportRequestOptions?: SyncTransportOptions
    ): Promise<SyncCombinedResponse> {
      const { data, error, response } = await executeWithTransientNetworkRetry({
        execute: (signal) =>
          executeWithAuthRetry(
            (retrySignal) => client.sync(request, retrySignal),
            { ...transportRequestOptions, signal },
            'sync',
            resolveAuthRetry
          ),
        options: transportRequestOptions,
      });

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

      if (!shouldUseResponseBodyStream(response, capabilities)) {
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

export function createReactNativeHttpTransport(
  clientOrOptions: SyncClient | ClientOptions
): SyncTransport {
  if (!('baseUrl' in clientOrOptions)) {
    return createHttpTransport(clientOrOptions);
  }

  return createHttpTransport({
    ...clientOrOptions,
    capabilities: {
      ...REACT_NATIVE_TRANSPORT_CAPABILITIES,
      ...clientOrOptions.capabilities,
    },
  });
}
