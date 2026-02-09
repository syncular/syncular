/**
 * Error simulation transport wrapper for testing failure scenarios.
 *
 * Provides configurable failure modes:
 * - failAfter: fail after N successful calls
 * - failWith: specific error to throw
 * - latencyMs: add artificial latency
 * - flaky: random failure rate (0-1)
 * - failOnPush/failOnPull: target specific operations
 */

import type {
  SyncCombinedRequest,
  SyncPullResponse,
  SyncPushResponse,
  SyncTransport,
  SyncTransportOptions,
} from '@syncular/core';

interface ErrorTransportOptions {
  /** Fail after N successful calls (per operation type) */
  failAfter?: number;
  /** Error to throw on failure */
  failWith?: Error;
  /** Add latency in milliseconds */
  latencyMs?: number;
  /** Random failure rate (0-1, e.g. 0.5 = 50% failure) */
  flaky?: number;
  /** Only fail push operations */
  failOnPush?: boolean;
  /** Only fail pull operations */
  failOnPull?: boolean;
  /** Only fail fetchSnapshotChunk operations */
  failOnFetch?: boolean;
  /** Callback when an operation is about to fail */
  onFail?: (operation: 'push' | 'pull' | 'fetch', error: Error) => void;
  /** Callback when an operation succeeds */
  onSuccess?: (operation: 'push' | 'pull' | 'fetch') => void;
}

interface ErrorTransportState {
  pushCount: number;
  pullCount: number;
  fetchCount: number;
  failureCount: number;
}

interface ErrorTransportResult {
  transport: SyncTransport;
  /** Get current operation counts */
  getState: () => ErrorTransportState;
  /** Reset all counters */
  reset: () => void;
  /** Update options dynamically */
  setOptions: (options: Partial<ErrorTransportOptions>) => void;
}

/**
 * Creates a transport wrapper that can simulate various failure scenarios.
 *
 * @example
 * // Fail after 3 successful pushes
 * const { transport } = createErrorTransport(baseTransport, {
 *   failAfter: 3,
 *   failOnPush: true,
 *   failWith: new Error('Connection lost'),
 * });
 *
 * @example
 * // 50% random failure rate
 * const { transport } = createErrorTransport(baseTransport, {
 *   flaky: 0.5,
 * });
 *
 * @example
 * // Add 100ms latency to all operations
 * const { transport } = createErrorTransport(baseTransport, {
 *   latencyMs: 100,
 * });
 */
export function createErrorTransport(
  baseTransport: SyncTransport,
  options: ErrorTransportOptions = {}
): ErrorTransportResult {
  let currentOptions = { ...options };
  const state: ErrorTransportState = {
    pushCount: 0,
    pullCount: 0,
    fetchCount: 0,
    failureCount: 0,
  };

  const defaultError = new Error('Simulated transport error');

  async function maybeDelay(): Promise<void> {
    if (currentOptions.latencyMs && currentOptions.latencyMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, currentOptions.latencyMs)
      );
    }
  }

  function shouldFail(
    operation: 'push' | 'pull' | 'fetch',
    count: number
  ): boolean {
    // Check operation-specific flags
    if (operation === 'push' && currentOptions.failOnPull) return false;
    if (operation === 'pull' && currentOptions.failOnPush) return false;
    if (operation === 'fetch' && !currentOptions.failOnFetch) {
      // If neither failOnPush nor failOnPull, allow fetch to fail by default
      if (currentOptions.failOnPush || currentOptions.failOnPull) return false;
    }

    // Check failAfter
    if (
      currentOptions.failAfter !== undefined &&
      count >= currentOptions.failAfter
    ) {
      return true;
    }

    // Check flaky
    if (currentOptions.flaky !== undefined && currentOptions.flaky > 0) {
      return Math.random() < currentOptions.flaky;
    }

    return false;
  }

  function getError(): Error {
    return currentOptions.failWith ?? defaultError;
  }

  const transport: SyncTransport = {
    async sync(request, transportOptions) {
      await maybeDelay();

      // Determine which operation to check based on request content
      const operation = request.push ? 'push' : 'pull';
      const count = operation === 'push' ? state.pushCount : state.pullCount;

      if (shouldFail(operation, count)) {
        const error = getError();
        state.failureCount++;
        currentOptions.onFail?.(operation, error);
        throw error;
      }

      if (operation === 'push') state.pushCount++;
      else state.pullCount++;

      const result = await baseTransport.sync(request, transportOptions);
      currentOptions.onSuccess?.(operation);
      return result;
    },

    async fetchSnapshotChunk(
      request: { chunkId: string },
      transportOptions?: SyncTransportOptions
    ): Promise<Uint8Array> {
      await maybeDelay();

      if (shouldFail('fetch', state.fetchCount)) {
        const error = getError();
        state.failureCount++;
        currentOptions.onFail?.('fetch', error);
        throw error;
      }

      state.fetchCount++;
      const result = await baseTransport.fetchSnapshotChunk(
        request,
        transportOptions
      );
      currentOptions.onSuccess?.('fetch');
      return result;
    },
  };

  return {
    transport,
    getState: () => ({ ...state }),
    reset: () => {
      state.pushCount = 0;
      state.pullCount = 0;
      state.fetchCount = 0;
      state.failureCount = 0;
    },
    setOptions: (newOptions) => {
      currentOptions = { ...currentOptions, ...newOptions };
    },
  };
}

/**
 * Creates a mock transport that returns predefined responses.
 * Useful for unit testing without a real server.
 */
export function createMockTransport(options?: {
  pullResponse?: SyncPullResponse;
  pushResponse?: SyncPushResponse;
  chunkData?: Uint8Array;
}): SyncTransport {
  return {
    async sync(request) {
      const result: {
        ok: true;
        push?: SyncPushResponse;
        pull?: SyncPullResponse;
      } = { ok: true };

      if (request.push) {
        result.push = options?.pushResponse ?? {
          ok: true,
          status: 'applied',
          results: request.push.operations.map((_, i) => ({
            opIndex: i,
            status: 'applied' as const,
          })),
        };
      }

      if (request.pull) {
        result.pull = options?.pullResponse ?? {
          ok: true,
          subscriptions: [],
        };
      }

      return result;
    },
    async fetchSnapshotChunk(): Promise<Uint8Array> {
      return options?.chunkData ?? new Uint8Array();
    },
  };
}

/**
 * Creates a transport that records all requests for inspection.
 */
export interface RecordingTransportResult {
  transport: SyncTransport;
  syncRequests: SyncCombinedRequest[];
  fetchRequests: { chunkId: string }[];
  clear: () => void;
}

export function createRecordingTransport(
  baseTransport: SyncTransport
): RecordingTransportResult {
  const syncRequests: SyncCombinedRequest[] = [];
  const fetchRequests: { chunkId: string }[] = [];

  const transport: SyncTransport = {
    async sync(request, options) {
      syncRequests.push(structuredClone(request));
      return baseTransport.sync(request, options);
    },
    async fetchSnapshotChunk(request, options) {
      fetchRequests.push({ ...request });
      return baseTransport.fetchSnapshotChunk(request, options);
    },
  };

  return {
    transport,
    syncRequests,
    fetchRequests,
    clear: () => {
      syncRequests.length = 0;
      fetchRequests.length = 0;
    },
  };
}
