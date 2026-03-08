import type {
  ScopeValues,
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncAuthOperation,
  SyncTransportOptions,
} from '@syncular/core';
import { resolveUrlFromBase } from '@syncular/core';

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

export type ApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

export type ResolveAuthRetry = (
  context: SyncAuthErrorContext,
  options?: SyncTransportOptions
) => Promise<boolean>;

class ApiResponseError extends Error {
  constructor(
    message: string,
    public readonly error?: unknown
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

export function getErrorMessage(error: unknown): string {
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

export async function executeWithAuthRetry<T>(
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

export const SNAPSHOT_SCOPES_HEADER = 'x-syncular-snapshot-scopes';

export function resolveRequestUrl(baseUrl: string, path: string): string {
  return resolveUrlFromBase(
    baseUrl,
    path,
    typeof location === 'undefined' ? undefined : location.origin
  );
}

export function bytesToReadableStream(
  bytes: Uint8Array
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function encodeSnapshotScopes(
  scopeValues: ScopeValues | undefined
): string | null {
  if (!scopeValues) return null;
  if (Object.keys(scopeValues).length === 0) return null;
  return JSON.stringify(scopeValues);
}

export function applySnapshotScopesHeader(
  headers: Headers,
  scopeValues: ScopeValues | undefined
): void {
  const encodedScopes = encodeSnapshotScopes(scopeValues);
  if (!encodedScopes) return;
  headers.set(SNAPSHOT_SCOPES_HEADER, encodedScopes);
}

export function resolveSnapshotChunkRequestUrl(
  baseUrl: string,
  chunkId: string,
  scopeValues: ScopeValues | undefined
): string {
  const requestUrl = new URL(
    resolveRequestUrl(
      baseUrl,
      `/sync/snapshot-chunks/${encodeURIComponent(chunkId)}`
    )
  );
  const encodedScopes = encodeSnapshotScopes(scopeValues);
  if (encodedScopes) {
    requestUrl.searchParams.set('scopes', encodedScopes);
  }
  return requestUrl.toString();
}
