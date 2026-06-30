import { describe, expect, it } from 'bun:test';
import type { SyncularClientStatus } from './client';
import {
  getSyncularMutationStatus,
  type SyncularMutationStatusClient,
} from './mutation-status';
import type {
  SyncularConflictSummary,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
} from './types';

describe('mutation status', () => {
  it('summarizes queued and currently sending mutations for app chrome', async () => {
    const client = mutationStatusClient({
      snapshot: diagnosticSnapshot({
        outboxStats: {
          acked: 5,
          failed: 0,
          pending: 3,
          sending: 1,
          total: 9,
        },
      }),
      status: clientStatus({ isSyncing: true }),
    });

    const status = await getSyncularMutationStatus(client, { now: () => 42 });

    expect(status).toMatchObject({
      generatedAt: 42,
      state: 'syncing',
      requiresAction: false,
      summary: {
        queued: 3,
        sending: 1,
        failed: 0,
        acked: 5,
        total: 9,
      },
    });
    expect(status.recommendedActions.map((action) => action.action)).toEqual([
      'show-pending',
      'wait-for-sync',
    ]);
  });

  it('prioritizes unresolved conflicts and exposes stable conflict actions', async () => {
    const client = mutationStatusClient({
      snapshot: diagnosticSnapshot({
        conflictStats: {
          resolved: 1,
          total: 2,
          unresolved: 1,
        },
        outboxStats: {
          acked: 1,
          failed: 1,
          pending: 0,
          sending: 0,
          total: 2,
        },
      }),
      conflicts: [
        conflictSummary({
          code: 'sync.conflict_version',
          id: 'conflict-a',
          resolvedAt: null,
          resolution: null,
        }),
        conflictSummary({
          code: 'sync.conflict_dismissed',
          id: 'conflict-b',
          resolvedAt: 10,
          resolution: 'dismiss',
        }),
      ],
    });

    const status = await getSyncularMutationStatus(client);

    expect(status.state).toBe('conflicted');
    expect(status.requiresAction).toBe(true);
    expect(status.summary.conflictCodes).toEqual([
      'sync.conflict_dismissed',
      'sync.conflict_version',
    ]);
    expect(status.conflictItems).toEqual([
      expect.objectContaining({
        id: 'conflict-a',
        code: 'sync.conflict_version',
        recommendedActions: ['retry-local', 'keep-server', 'dismiss'],
      }),
      expect.objectContaining({
        id: 'conflict-b',
        recommendedActions: [],
      }),
    ]);
    expect(status.recommendedActions.map((action) => action.action)).toEqual([
      'retry-sync',
      'resolve-conflicts',
    ]);
  });

  it('surfaces auth blockers before generic queued state', async () => {
    const client = mutationStatusClient({
      snapshot: diagnosticSnapshot({
        outboxStats: {
          acked: 0,
          failed: 0,
          pending: 1,
          sending: 0,
          total: 1,
        },
        recentDiagnostics: [
          diagnosticEvent({
            code: 'sync.auth_required',
            level: 'error',
            message: 'auth expired',
            source: 'auth',
          }),
        ],
      }),
    });

    const status = await getSyncularMutationStatus(client);

    expect(status).toMatchObject({
      state: 'action-required',
      requiresAction: true,
      summary: {
        lastError: {
          code: 'sync.auth_required',
          message: 'auth expired',
        },
      },
    });
    expect(status.recommendedActions.map((action) => action.action)).toEqual([
      'show-pending',
      'refresh-auth',
    ]);
  });

  it('keeps stats useful when conflict records cannot be listed', async () => {
    const client = mutationStatusClient({
      snapshot: diagnosticSnapshot({
        conflictStats: {
          resolved: 0,
          total: 1,
          unresolved: 1,
        },
      }),
      conflictError: new Error('conflict table unavailable'),
    });

    const status = await getSyncularMutationStatus(client, {
      maxConflictItems: 1,
    });

    expect(status).toMatchObject({
      state: 'conflicted',
      conflictItems: [],
      conflictItemsUnavailable: {
        message: 'conflict table unavailable',
      },
    });
    expect(status.recommendedActions.map((action) => action.action)).toEqual([
      'resolve-conflicts',
      'inspect-diagnostics',
    ]);
  });
});

function mutationStatusClient(args: {
  snapshot?: SyncularDiagnosticSnapshot;
  status?: SyncularClientStatus;
  conflicts?: SyncularConflictSummary[];
  conflictError?: Error;
}): SyncularMutationStatusClient {
  return {
    async diagnosticSnapshot() {
      return args.snapshot ?? diagnosticSnapshot();
    },
    getStatus() {
      return args.status ?? clientStatus();
    },
    async listConflicts() {
      if (args.conflictError) throw args.conflictError;
      return args.conflicts ?? [];
    },
  };
}

function diagnosticSnapshot(
  overrides: Partial<SyncularDiagnosticSnapshot> = {}
): SyncularDiagnosticSnapshot {
  return {
    generatedAt: 1_000,
    runtime: {
      packageName: '@syncular/client',
      packageVersion: '1.2.3',
      workerProtocolVersion: 1,
      storage: 'opfsSahPool',
      wasmGlueUrl: 'syncular.js',
      wasmUrl: 'syncular_bg.wasm',
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    },
    subscriptions: [],
    recentDiagnostics: [],
    recentSyncTimings: [],
    outboxStats: {
      acked: 0,
      failed: 0,
      pending: 0,
      sending: 0,
      total: 0,
    },
    conflictStats: {
      resolved: 0,
      total: 0,
      unresolved: 0,
    },
    ...overrides,
  };
}

function diagnosticEvent(
  overrides: Partial<SyncularDiagnosticEvent> = {}
): SyncularDiagnosticEvent {
  return {
    at: 100,
    code: 'sync.event',
    level: 'info',
    message: 'diagnostic event',
    source: 'sync',
    ...overrides,
  };
}

function clientStatus(
  overrides: Partial<SyncularClientStatus> = {}
): SyncularClientStatus {
  return {
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    },
    conflicts: null,
    hasConflicts: false,
    hasPendingMutations: false,
    isConnected: true,
    isSyncing: false,
    lifecycle: {
      online: true,
      pendingRequests: 0,
      phase: 'complete',
      realtime: 'connected',
      requiresAction: false,
    },
    outbox: null,
    requiresAction: false,
    ...overrides,
  };
}

function conflictSummary(
  overrides: Partial<SyncularConflictSummary> = {}
): SyncularConflictSummary {
  return {
    clientCommitId: 'commit-a',
    code: null,
    id: 'conflict-a',
    message: 'conflict',
    opIndex: 0,
    resolution: null,
    resolvedAt: null,
    resultStatus: 'conflict',
    serverVersion: 10,
    ...overrides,
  };
}
