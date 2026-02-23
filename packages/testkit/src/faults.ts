import type {
  SyncCombinedRequest,
  SyncPullResponse,
  SyncPushResponse,
  SyncTransport,
  SyncTransportOptions,
} from '@syncular/core';

export interface FaultTransportOptions {
  failAfter?: number;
  failWith?: Error;
  latencyMs?: number;
  flaky?: number;
  failOnPush?: boolean;
  failOnPull?: boolean;
  failOnFetch?: boolean;
  onFail?: (operation: 'push' | 'pull' | 'fetch', error: Error) => void;
  onSuccess?: (operation: 'push' | 'pull' | 'fetch') => void;
}

export interface FaultTransportState {
  pushCount: number;
  pullCount: number;
  fetchCount: number;
  failureCount: number;
}

export interface FaultTransportResult {
  transport: SyncTransport;
  getState: () => FaultTransportState;
  reset: () => void;
  setOptions: (options: Partial<FaultTransportOptions>) => void;
}

export function withFaults(
  baseTransport: SyncTransport,
  options: FaultTransportOptions = {}
): FaultTransportResult {
  let currentOptions = { ...options };
  const state: FaultTransportState = {
    pushCount: 0,
    pullCount: 0,
    fetchCount: 0,
    failureCount: 0,
  };

  const defaultError = new Error('Simulated transport error');

  const maybeDelay = async (): Promise<void> => {
    if (currentOptions.latencyMs && currentOptions.latencyMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, currentOptions.latencyMs)
      );
    }
  };

  const shouldFail = (
    operation: 'push' | 'pull' | 'fetch',
    count: number
  ): boolean => {
    if (operation === 'push' && currentOptions.failOnPull) {
      return false;
    }
    if (operation === 'pull' && currentOptions.failOnPush) {
      return false;
    }
    if (operation === 'fetch' && !currentOptions.failOnFetch) {
      if (currentOptions.failOnPush || currentOptions.failOnPull) {
        return false;
      }
    }

    if (
      currentOptions.failAfter !== undefined &&
      count >= currentOptions.failAfter
    ) {
      return true;
    }

    if (currentOptions.flaky !== undefined && currentOptions.flaky > 0) {
      return Math.random() < currentOptions.flaky;
    }

    return false;
  };

  const getError = (): Error => currentOptions.failWith ?? defaultError;

  const transport: SyncTransport = {
    async sync(request, transportOptions) {
      await maybeDelay();

      const operation = request.push ? 'push' : 'pull';
      const count = operation === 'push' ? state.pushCount : state.pullCount;

      if (shouldFail(operation, count)) {
        const error = getError();
        state.failureCount++;
        currentOptions.onFail?.(operation, error);
        throw error;
      }

      if (operation === 'push') {
        state.pushCount++;
      } else {
        state.pullCount++;
      }

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
            status: 'applied',
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

export interface RecordingTransportResult {
  transport: SyncTransport;
  syncRequests: SyncCombinedRequest[];
  fetchRequests: { chunkId: string }[];
  clear: () => void;
}

export function withRecording(
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
