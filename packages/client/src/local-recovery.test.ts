import { describe, expect, it } from 'bun:test';
import type { SyncularClientStatus } from './client';
import {
  getSyncularLocalRecoveryPlan,
  runSyncularLocalRecoveryAction,
  type SyncularLocalRecoveryAction,
  type SyncularLocalRecoveryClient,
  SyncularLocalRecoveryError,
} from './local-recovery';
import type {
  SyncularDiagnosticSnapshot,
  SyncularLocalHealthReport,
  SyncularLocalSupportBundle,
  SyncularStorageCompactionReport,
  SyncularSyncResult,
} from './types';

describe('local recovery plan', () => {
  it('summarizes a healthy client with a non-destructive support bundle action', async () => {
    const client = new FakeRecoveryClient();

    await expect(
      getSyncularLocalRecoveryPlan(client, { now: () => 42 })
    ).resolves.toMatchObject({
      generatedAt: 42,
      status: 'healthy',
      requiresAction: false,
      actions: [
        expect.objectContaining({
          id: 'support.export-local-bundle',
          kind: 'export-support-bundle',
          destructive: false,
        }),
      ],
    });
  });

  it('groups local health findings into confirmed repair actions', async () => {
    const client = new FakeRecoveryClient({
      health: {
        ...healthyLocalHealth(),
        ok: false,
        findings: [
          {
            severity: 'error',
            code: 'local.subscription_state_orphaned',
            component: 'subscriptionState',
            message: 'stored subscription state is not configured',
            subscriptionId: 'old-sub',
            table: 'tasks',
            repairAction: 'clearOrphanedState',
          },
          {
            severity: 'error',
            code: 'local.verified_root_orphaned',
            component: 'verifiedRoot',
            message: 'stored verified root is not configured',
            subscriptionId: 'old-sub',
            repairAction: 'clearOrphanedState',
          },
        ],
      },
    });

    const plan = await getSyncularLocalRecoveryPlan(client);
    const repair = requiredAction(plan.actions, 'clear-orphaned-state');
    expect(plan.status).toBe('action-required');
    expect(repair).toMatchObject({
      id: 'health.clear-orphaned-state',
      severity: 'warning',
      requiresConfirmation: true,
      subscriptionIds: ['old-sub'],
      reasonCodes: [
        'local.subscription_state_orphaned',
        'local.verified_root_orphaned',
      ],
    });

    await expect(
      runSyncularLocalRecoveryAction(client, repair)
    ).rejects.toBeInstanceOf(SyncularLocalRecoveryError);

    await expect(
      runSyncularLocalRecoveryAction(client, repair, {
        confirmationText: repair.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'clear-orphaned-state',
      report: { action: 'clearOrphanedState' },
    });
    expect(client.calls).toContainEqual([
      'repairLocalHealth',
      { action: 'clearOrphanedState', subscriptionIds: ['old-sub'] },
    ]);
  });

  it('adds retry actions for failed outbox and blob uploads', async () => {
    const client = new FakeRecoveryClient({
      snapshot: {
        ...diagnosticSnapshot(),
        outboxStats: {
          pending: 0,
          sending: 0,
          failed: 2,
          acked: 0,
          total: 2,
        },
        blobUploadStats: {
          pending: 0,
          uploading: 0,
          failed: 1,
        },
      },
    });

    const plan = await getSyncularLocalRecoveryPlan(client);
    expect(plan.status).toBe('maintenance-recommended');
    expect(plan.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining(['resume-from-background', 'retry-blob-uploads'])
    );

    await expect(
      runSyncularLocalRecoveryAction(
        client,
        requiredAction(plan.actions, 'retry-blob-uploads')
      )
    ).resolves.toMatchObject({
      action: 'retry-blob-uploads',
      result: { uploaded: 1, failed: 0 },
    });
  });

  it('only exposes reset and cache-clear operations when explicitly requested', async () => {
    const client = new FakeRecoveryClient();
    const defaultPlan = await getSyncularLocalRecoveryPlan(client);
    expect(
      defaultPlan.actions.some(
        (action) => action.kind === 'reset-local-sync-state'
      )
    ).toBe(false);

    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeMaintenanceActions: true,
      includeResetAction: true,
      resetClearSyncedRows: true,
      resetSubscriptionIds: ['sub-a'],
      compactStorageOptions: { olderThanMs: 1_000 },
    });

    const compact = requiredAction(plan.actions, 'compact-storage');
    expect(compact.compactStorageOptions).toEqual({ olderThanMs: 1_000 });
    await expect(
      runSyncularLocalRecoveryAction(client, compact)
    ).resolves.toMatchObject({
      action: 'compact-storage',
      report: { ackedOutboxCommitsDeleted: 1 },
    });

    const reset = requiredAction(plan.actions, 'reset-local-sync-state');
    await expect(
      runSyncularLocalRecoveryAction(client, reset, {
        confirmationText: reset.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'reset-local-sync-state',
      report: { resetSubscriptions: 1, clearedSyncedRows: 2 },
    });
    expect(client.calls).toContainEqual([
      'resetLocalSyncState',
      { subscriptionIds: ['sub-a'], clearSyncedRows: true },
    ]);
  });

  it('runs the support bundle action without confirmation', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client);

    await expect(
      runSyncularLocalRecoveryAction(
        client,
        requiredAction(plan.actions, 'export-support-bundle')
      )
    ).resolves.toMatchObject({
      action: 'export-support-bundle',
      bundle: {
        redacted: true,
        health: { ok: true },
        outbox: { total: 0 },
      },
    });
  });
});

function requiredAction(
  actions: readonly SyncularLocalRecoveryAction[],
  kind: SyncularLocalRecoveryAction['kind']
): SyncularLocalRecoveryAction {
  const action = actions.find((candidate) => candidate.kind === kind);
  if (!action) throw new Error(`Missing local recovery action ${kind}`);
  return action;
}

class FakeRecoveryClient implements SyncularLocalRecoveryClient {
  readonly calls: Array<[string, unknown?]> = [];
  readonly #health: SyncularLocalHealthReport;
  readonly #snapshot: SyncularDiagnosticSnapshot;
  readonly #status: SyncularClientStatus;

  constructor(
    args: {
      health?: SyncularLocalHealthReport;
      snapshot?: SyncularDiagnosticSnapshot;
      status?: SyncularClientStatus;
    } = {}
  ) {
    this.#health = args.health ?? healthyLocalHealth();
    this.#snapshot = args.snapshot ?? diagnosticSnapshot();
    this.#status = args.status ?? clientStatus();
  }

  async localHealthCheck() {
    this.calls.push(['localHealthCheck']);
    return this.#health;
  }

  async diagnosticSnapshot() {
    this.calls.push(['diagnosticSnapshot']);
    return this.#snapshot;
  }

  getStatus() {
    return this.#status;
  }

  async exportLocalSupportBundle(): Promise<SyncularLocalSupportBundle> {
    this.calls.push(['exportLocalSupportBundle']);
    return {
      formatVersion: 1,
      generatedAt: 1,
      redacted: true,
      source: 'fake',
      health: this.#health,
      appSchemaState: {
        schemaId: 'app',
        schemaVersion: 1,
        currentSchemaVersion: 1,
        updatedAt: 1,
      },
      subscriptions: [],
      subscriptionStates: [],
      verifiedRoots: [],
      outbox: { total: 0, byStatus: {}, bySchemaVersion: {} },
      conflicts: {
        total: 0,
        unresolved: 0,
        resolved: 0,
        byResultStatus: {},
        byCode: {},
      },
    };
  }

  async resumeFromBackground(): Promise<SyncularSyncResult> {
    this.calls.push(['resumeFromBackground']);
    return syncResult();
  }

  async processBlobUploadQueue() {
    this.calls.push(['processBlobUploadQueue']);
    return { uploaded: 1, failed: 0 };
  }

  async compactStorage(): Promise<SyncularStorageCompactionReport> {
    this.calls.push(['compactStorage']);
    return {
      ackedOutboxCommitsDeleted: 1,
      resolvedConflictsDeleted: 0,
      failedBlobUploadsDeleted: 0,
      inactiveSubscriptionStatesDeleted: 0,
      tombstoneRowsDeleted: 0,
      blobCacheBytesPruned: 0,
      encryptedCrdtUpdatesDeleted: 0,
      encryptedCrdtCheckpointsDeleted: 0,
      crdtUpdateLogDeleted: 0,
    };
  }

  async clearBlobCache() {
    this.calls.push(['clearBlobCache']);
  }

  async repairLocalHealth(request: {
    action:
      | 'forceRebootstrap'
      | 'clearOrphanedState'
      | 'clearOrphanedSyncedRows';
    subscriptionIds?: readonly string[];
    tables?: readonly string[];
  }) {
    this.calls.push(['repairLocalHealth', request]);
    return {
      action: request.action,
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
      forcedRebootstrapSubscriptions:
        request.action === 'forceRebootstrap' ? 1 : 0,
      clearedOrphanedSyncedRows:
        request.action === 'clearOrphanedSyncedRows' ? 1 : 0,
      clearedTables: [...(request.tables ?? [])],
    };
  }

  async resetLocalSyncState(request?: {
    subscriptionIds?: readonly string[];
    clearSyncedRows?: boolean;
  }) {
    this.calls.push(['resetLocalSyncState', request]);
    return {
      resetSubscriptions: request?.subscriptionIds?.length ?? 0,
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
      clearedSyncedRows: request?.clearSyncedRows ? 2 : 0,
      clearedTables: request?.clearSyncedRows ? ['tasks'] : [],
    };
  }
}

function healthyLocalHealth(): SyncularLocalHealthReport {
  return {
    generatedAt: 1,
    ok: true,
    checkedSubscriptions: 0,
    checkedSubscriptionStates: 0,
    checkedVerifiedRoots: 0,
    checkedOutboxCommits: 0,
    checkedConflicts: 0,
    checkedSyncedRows: 0,
    checkedBlobReferences: 0,
    checkedCrdtDocuments: 0,
    checkedCrdtUpdateLogEntries: 0,
    findings: [],
  };
}

function diagnosticSnapshot(): SyncularDiagnosticSnapshot {
  return {
    generatedAt: 1,
    runtime: {
      packageName: '@syncular/client',
      packageVersion: '0.0.0-test',
      workerProtocolVersion: 1,
      storage: 'indexedDb',
      wasmGlueUrl: '/syncular.js',
      wasmUrl: '/syncular_bg.wasm',
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'disconnected',
    },
    subscriptions: [],
    recentDiagnostics: [],
    recentSyncTimings: [],
  };
}

function clientStatus(): SyncularClientStatus {
  return {
    lifecycle: {
      phase: 'complete',
      realtime: 'disconnected',
      online: true,
      requiresAction: false,
      pendingRequests: 0,
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'disconnected',
    },
    outbox: null,
    conflicts: null,
    isConnected: false,
    isSyncing: false,
    hasPendingMutations: false,
    hasConflicts: false,
    requiresAction: false,
  };
}

function syncResult(): SyncularSyncResult {
  return {
    changedTables: [],
    changedRows: [],
    changedRowsTruncated: false,
    subscriptions: [],
    bootstrap: {
      channelPhase: 'live',
      progressPercent: 100,
      isBootstrapping: false,
      criticalReady: true,
      interactiveReady: true,
      complete: true,
      activePhase: null,
      expectedSubscriptionIds: [],
      readySubscriptionIds: [],
      pendingSubscriptionIds: [],
      subscriptions: [],
      phases: [],
    },
    pushedCommits: 0,
    timings: {
      totalMs: 0,
      pushMs: 0,
      pullMs: 0,
      pullRequestMs: 0,
      syncPackDecodeMs: 0,
      pullTransformMs: 0,
      integrityVerifyMs: 0,
      snapshotFetchMs: 0,
      pullApplyMs: 0,
      scopeClearMs: 0,
      snapshotRowApplyMs: 0,
      snapshotArtifactApplyMs: 0,
      snapshotArtifactCheckpointMs: 0,
      snapshotArtifactCheckpointCount: 0,
      snapshotChunkApplyMs: 0,
      snapshotChunkMaterializeMs: 0,
      snapshotChunkResetMs: 0,
      snapshotChunkBindMs: 0,
      snapshotChunkStepMs: 0,
      commitApplyMs: 0,
      subscriptionStateMs: 0,
      notifyMs: 0,
    },
  };
}
