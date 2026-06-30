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
  SyncularLocalSupportBundle,
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

  it('correlates tracked mutation receipts with redacted outbox commits', async () => {
    const client = mutationStatusClient({
      snapshot: diagnosticSnapshot({
        outboxStats: {
          acked: 1,
          failed: 1,
          pending: 1,
          sending: 1,
          total: 4,
        },
      }),
      localSupportBundle: localSupportBundle({
        outboxCommits: [
          {
            outboxId: 'outbox-pending',
            clientCommitId: 'commit-pending',
            schemaVersion: 3,
            status: 'pending',
          },
          {
            outboxId: 'outbox-sending',
            clientCommitId: 'commit-sending',
            schemaVersion: 3,
            status: 'sending',
          },
          {
            outboxId: 'outbox-failed',
            clientCommitId: 'commit-failed',
            schemaVersion: 3,
            status: 'failed',
          },
          {
            outboxId: 'outbox-acked',
            clientCommitId: 'commit-acked',
            schemaVersion: 3,
            status: 'acked',
            ackedCommitSeq: 42,
          },
        ],
      }),
    });

    const status = await getSyncularMutationStatus(client, {
      trackCommits: [
        { clientCommitId: 'commit-pending', commandId: 'cmd-create-task' },
        'commit-sending',
        'commit-failed',
        { commitId: 'commit-acked' },
        'commit-missing',
      ],
    });

    expect(
      status.trackedCommits.map((commit) => ({
        id: commit.clientCommitId,
        commandId: commit.commandId,
        state: commit.state,
        evidence: commit.evidence,
        action: commit.recommendedActions[0]?.action,
        outbox: commit.outbox,
      }))
    ).toEqual([
      {
        id: 'commit-pending',
        commandId: 'cmd-create-task',
        state: 'queued',
        evidence: ['localSupportBundle.outboxCommit'],
        action: 'show-pending',
        outbox: {
          outboxId: 'outbox-pending',
          schemaVersion: 3,
          status: 'pending',
        },
      },
      {
        id: 'commit-sending',
        commandId: undefined,
        state: 'syncing',
        evidence: ['localSupportBundle.outboxCommit'],
        action: 'wait-for-sync',
        outbox: {
          outboxId: 'outbox-sending',
          schemaVersion: 3,
          status: 'sending',
        },
      },
      {
        id: 'commit-failed',
        commandId: undefined,
        state: 'failed',
        evidence: ['localSupportBundle.outboxCommit'],
        action: 'retry-sync',
        outbox: {
          outboxId: 'outbox-failed',
          schemaVersion: 3,
          status: 'failed',
        },
      },
      {
        id: 'commit-acked',
        commandId: undefined,
        state: 'acked',
        evidence: ['localSupportBundle.outboxCommit'],
        action: undefined,
        outbox: {
          outboxId: 'outbox-acked',
          schemaVersion: 3,
          status: 'acked',
          ackedCommitSeq: 42,
        },
      },
      {
        id: 'commit-missing',
        commandId: undefined,
        state: 'unknown',
        evidence: ['outbox.aggregate'],
        action: 'inspect-diagnostics',
        outbox: undefined,
      },
    ]);
  });

  it('prioritizes tracked unresolved conflicts over outbox state', async () => {
    const client = mutationStatusClient({
      conflicts: [
        conflictSummary({
          clientCommitId: 'commit-conflicted',
          code: 'sync.conflict_version',
        }),
      ],
      localSupportBundle: localSupportBundle({
        outboxCommits: [
          {
            outboxId: 'outbox-conflicted',
            clientCommitId: 'commit-conflicted',
            schemaVersion: 3,
            status: 'failed',
          },
        ],
      }),
      snapshot: diagnosticSnapshot({
        conflictStats: { resolved: 0, total: 1, unresolved: 1 },
        outboxStats: { acked: 0, failed: 1, pending: 0, sending: 0, total: 1 },
      }),
    });

    const status = await getSyncularMutationStatus(client, {
      trackCommits: ['commit-conflicted'],
    });

    expect(status.trackedCommits).toEqual([
      expect.objectContaining({
        clientCommitId: 'commit-conflicted',
        state: 'conflicted',
        evidence: ['conflict.item', 'localSupportBundle.outboxCommit'],
        recommendedActions: [
          expect.objectContaining({ action: 'resolve-conflicts' }),
        ],
      }),
    ]);
  });

  it('keeps tracked commits inspectable when local support export fails', async () => {
    const client = mutationStatusClient({
      exportLocalSupportBundleError: new Error('opfs unavailable'),
      snapshot: diagnosticSnapshot({
        outboxStats: { acked: 0, failed: 0, pending: 1, sending: 0, total: 1 },
      }),
    });

    const status = await getSyncularMutationStatus(client, {
      trackCommits: ['commit-a'],
    });

    expect(status).toMatchObject({
      trackedCommitsUnavailable: { message: 'opfs unavailable' },
      trackedCommits: [
        {
          clientCommitId: 'commit-a',
          state: 'unknown',
          evidence: ['localSupportBundle.unavailable'],
        },
      ],
    });
  });
});

function mutationStatusClient(args: {
  snapshot?: SyncularDiagnosticSnapshot;
  status?: SyncularClientStatus;
  conflicts?: SyncularConflictSummary[];
  conflictError?: Error;
  localSupportBundle?: SyncularLocalSupportBundle;
  exportLocalSupportBundleError?: Error;
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
    async exportLocalSupportBundle() {
      if (args.exportLocalSupportBundleError) {
        throw args.exportLocalSupportBundleError;
      }
      return args.localSupportBundle ?? localSupportBundle();
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

function localSupportBundle(
  overrides: Partial<SyncularLocalSupportBundle> = {}
): SyncularLocalSupportBundle {
  return {
    appSchemaState: {
      currentSchemaVersion: 3,
      schemaId: 'app',
      schemaVersion: 3,
      updatedAt: 1_000,
    },
    conflicts: {
      byCode: {},
      byResultStatus: {},
      resolved: 0,
      total: 0,
      unresolved: 0,
    },
    formatVersion: 2,
    generatedAt: 1_000,
    health: {
      checkedBlobReferences: 0,
      checkedConflicts: 0,
      checkedCrdtDocuments: 0,
      checkedCrdtUpdateLogEntries: 0,
      checkedOutboxCommits: 0,
      checkedSubscriptionStates: 0,
      checkedSubscriptions: 0,
      checkedSyncedRows: 0,
      checkedVerifiedRoots: 0,
      findings: [],
      generatedAt: 1_000,
      ok: true,
    },
    outbox: {
      bySchemaVersion: {},
      byStatus: {},
      total: 0,
    },
    outboxCommits: [],
    redacted: true,
    source: 'test',
    subscriptionStates: [],
    subscriptions: [],
    verifiedRoots: [],
    ...overrides,
  };
}
