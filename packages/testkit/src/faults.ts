import type {
  SyncCombinedRequest,
  SyncPullResponse,
  SyncPushResponse,
  SyncTransport,
  SyncTransportOptions,
} from '@syncular/core';

export type FaultTransportOperation = 'push' | 'pull' | 'fetch';

export type FaultTransportAction = 'pass' | 'fail';

export type FaultTransportPhase = 'before' | 'after';

export interface FaultPlanStep {
  operation: FaultTransportOperation | 'any';
  action?: FaultTransportAction;
  phase?: FaultTransportPhase;
  repeat?: number;
  failWith?: Error;
  latencyMs?: number;
}

export interface FaultTransportOptions {
  failAfter?: number;
  failWith?: Error;
  latencyMs?: number;
  flaky?: number;
  failOnPush?: boolean;
  failOnPull?: boolean;
  failOnFetch?: boolean;
  plan?: FaultPlanStep[];
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

interface ActiveFaultPlanStep {
  operation: FaultPlanStep['operation'];
  action: FaultTransportAction;
  phase: FaultTransportPhase;
  remaining: number;
  failWith?: Error;
  latencyMs?: number;
}

interface PlannedFaultDecision {
  action: FaultTransportAction;
  phase: FaultTransportPhase;
  error: Error;
  latencyMs: number;
}

export function withFaults(
  baseTransport: SyncTransport,
  options: FaultTransportOptions = {}
): FaultTransportResult {
  let currentOptions = { ...options };
  let currentPlan = createActivePlan(currentOptions.plan);
  const state: FaultTransportState = {
    pushCount: 0,
    pullCount: 0,
    fetchCount: 0,
    failureCount: 0,
  };

  const defaultError = new Error('Simulated transport error');

  const maybeDelay = async (extraLatencyMs = 0): Promise<void> => {
    const latencyMs = (currentOptions.latencyMs ?? 0) + extraLatencyMs;
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }
  };

  const shouldTargetOperation = (
    operation: FaultTransportOperation
  ): boolean => {
    const hasTargets =
      currentOptions.failOnPush === true ||
      currentOptions.failOnPull === true ||
      currentOptions.failOnFetch === true;

    if (!hasTargets) {
      return true;
    }

    if (operation === 'push') {
      return currentOptions.failOnPush === true;
    }
    if (operation === 'pull') {
      return currentOptions.failOnPull === true;
    }
    return currentOptions.failOnFetch === true;
  };

  const shouldFail = (
    operation: FaultTransportOperation,
    count: number
  ): boolean => {
    if (!shouldTargetOperation(operation)) {
      return false;
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

  const fail = (operation: FaultTransportOperation, error: Error): never => {
    state.failureCount++;
    currentOptions.onFail?.(operation, error);
    throw error;
  };

  const recordSuccess = (operation: FaultTransportOperation): void => {
    if (operation === 'push') {
      state.pushCount++;
      return;
    }
    if (operation === 'pull') {
      state.pullCount++;
      return;
    }
    state.fetchCount++;
  };

  const takePlannedDecision = (
    operation: FaultTransportOperation
  ): PlannedFaultDecision | null => {
    const step = currentPlan.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (candidate.operation === 'any' || candidate.operation === operation)
    );
    if (!step) {
      return null;
    }

    step.remaining -= 1;
    return {
      action: step.action,
      phase: step.phase,
      error: step.failWith ?? getError(),
      latencyMs: step.latencyMs ?? 0,
    };
  };

  const runWithFaults = async <Result>(
    operation: FaultTransportOperation,
    count: number,
    run: () => Promise<Result>
  ): Promise<Result> => {
    const plannedDecision = takePlannedDecision(operation);
    await maybeDelay(plannedDecision?.latencyMs ?? 0);

    if (
      plannedDecision?.action === 'fail' &&
      plannedDecision.phase === 'before'
    ) {
      return fail(operation, plannedDecision.error);
    }

    if (!plannedDecision && shouldFail(operation, count)) {
      return fail(operation, getError());
    }

    const result = await run();
    recordSuccess(operation);

    if (
      plannedDecision?.action === 'fail' &&
      plannedDecision.phase === 'after'
    ) {
      return fail(operation, plannedDecision.error);
    }

    currentOptions.onSuccess?.(operation);
    return result;
  };

  const transport: SyncTransport = {
    async sync(request, transportOptions) {
      const operation: FaultTransportOperation = request.push ? 'push' : 'pull';
      const count = operation === 'push' ? state.pushCount : state.pullCount;

      return runWithFaults(operation, count, () =>
        baseTransport.sync(request, transportOptions)
      );
    },

    async fetchSnapshotChunk(
      request: { chunkId: string },
      transportOptions?: SyncTransportOptions
    ): Promise<Uint8Array> {
      return runWithFaults('fetch', state.fetchCount, () =>
        baseTransport.fetchSnapshotChunk(request, transportOptions)
      );
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
      currentPlan = createActivePlan(currentOptions.plan);
    },
    setOptions: (newOptions) => {
      currentOptions = { ...currentOptions, ...newOptions };
      if ('plan' in newOptions) {
        currentPlan = createActivePlan(currentOptions.plan);
      }
    },
  };
}

function createActivePlan(
  plan: FaultPlanStep[] | undefined
): ActiveFaultPlanStep[] {
  if (!plan || plan.length === 0) {
    return [];
  }

  return plan.flatMap((step) => {
    const remaining = step.repeat ?? 1;
    if (remaining <= 0) {
      return [];
    }

    return [
      {
        operation: step.operation,
        action: step.action ?? 'fail',
        phase: step.phase ?? 'before',
        remaining,
        failWith: step.failWith,
        latencyMs: step.latencyMs,
      },
    ];
  });
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
