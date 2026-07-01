import { describe, expect, it } from 'bun:test';
import type { SyncularBrowserDeploymentPreflight } from './browser-deployment-preflight';
import type { SyncularClientStatus } from './client';
import {
  getSyncularLocalRecoveryPlan,
  runSyncularLocalRecoveryAction,
  type SyncularLocalRecoveryAction,
  SyncularLocalRecoveryActionLockError,
  SyncularLocalRecoveryActionLockTimeoutError,
  SyncularLocalRecoveryBlockedError,
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

  it('adds a confirmed rebootstrap action for revoked subscriptions', async () => {
    const client = new FakeRecoveryClient({
      snapshot: {
        ...diagnosticSnapshot(),
        subscriptions: [
          diagnosticSubscription({
            id: 'sub-revoked',
            status: 'revoked',
          }),
        ],
        recentDiagnostics: [
          {
            at: 1,
            level: 'warn',
            source: 'sync',
            code: 'sync.scope_revoked',
            message: 'scope revoked',
            details: {
              revokedSubscriptionIds: ['sub-revoked'],
            },
          },
        ],
      },
    });

    const plan = await getSyncularLocalRecoveryPlan(client);
    const action = plan.actions.find(
      (candidate) => candidate.id === 'scope.rebootstrap-revoked'
    );
    expect(plan.status).toBe('action-required');
    expect(action).toMatchObject({
      kind: 'force-rebootstrap',
      severity: 'danger',
      source: 'scope',
      destructive: true,
      requiresConfirmation: true,
      subscriptionIds: ['sub-revoked'],
      reasonCodes: ['sync.scope_revoked'],
    });

    await expect(
      runSyncularLocalRecoveryAction(client, action!)
    ).rejects.toBeInstanceOf(SyncularLocalRecoveryError);

    await expect(
      runSyncularLocalRecoveryAction(client, action!, {
        confirmationText: action!.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'force-rebootstrap',
      report: { action: 'forceRebootstrap' },
    });
    expect(client.calls).toContainEqual([
      'repairLocalHealth',
      { action: 'forceRebootstrap', subscriptionIds: ['sub-revoked'] },
    ]);
  });

  it('adds a confirmed rebootstrap action for unrecoverable bootstrap errors', async () => {
    const client = new FakeRecoveryClient({
      snapshot: {
        ...diagnosticSnapshot(),
        connection: {
          ...diagnosticSnapshot().connection,
          lastError: {
            code: 'sync.integrity_rejected',
            message: 'snapshot hash mismatch',
          },
        },
        subscriptions: [
          diagnosticSubscription({
            id: 'sub-broken',
            phase: 'error',
            ready: false,
            progressPercent: 40,
          }),
        ],
      },
    });

    const plan = await getSyncularLocalRecoveryPlan(client);
    const action = plan.actions.find(
      (candidate) => candidate.id === 'bootstrap.force-rebootstrap-errored'
    );
    expect(plan.status).toBe('action-required');
    expect(action).toMatchObject({
      kind: 'force-rebootstrap',
      severity: 'danger',
      source: 'bootstrap',
      destructive: true,
      requiresConfirmation: true,
      subscriptionIds: ['sub-broken'],
      reasonCodes: ['sync.integrity_rejected'],
    });

    await expect(
      runSyncularLocalRecoveryAction(client, action!, {
        confirmationText: action!.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'force-rebootstrap',
      report: { action: 'forceRebootstrap' },
    });
    expect(client.calls).toContainEqual([
      'repairLocalHealth',
      { action: 'forceRebootstrap', subscriptionIds: ['sub-broken'] },
    ]);
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

  it('turns storage preflight quota and persistence warnings into recovery actions', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      deploymentPreflight: storagePressurePreflight({
        persistRequestSupported: true,
      }),
    });

    expect(plan.status).toBe('maintenance-recommended');
    const requestPersistence = requiredAction(
      plan.actions,
      'request-persistent-storage'
    );
    expect(requestPersistence).toMatchObject({
      id: 'storage.request-persistence',
      severity: 'warning',
      source: 'storage',
      destructive: false,
      requiresConfirmation: false,
      reasonCodes: ['browser.storage_persistence_not_granted'],
    });

    await expect(
      runSyncularLocalRecoveryAction(client, requestPersistence, {
        navigator: {
          storage: {
            async persist() {
              return true;
            },
          },
        },
      })
    ).resolves.toMatchObject({
      action: 'request-persistent-storage',
      supported: true,
      granted: true,
    });

    const compact = requiredAction(plan.actions, 'compact-storage');
    expect(compact).toMatchObject({
      id: 'storage.compact',
      severity: 'warning',
      source: 'storage',
      destructive: false,
      reasonCodes: [
        'browser.storage_pressure_high',
        'browser.storage_quota_low',
      ],
    });
    await expect(
      runSyncularLocalRecoveryAction(client, compact)
    ).resolves.toMatchObject({
      action: 'compact-storage',
      report: { ackedOutboxCommitsDeleted: 1 },
    });

    const clearCache = requiredAction(plan.actions, 'clear-blob-cache');
    expect(clearCache).toMatchObject({
      id: 'blob.clear-cache',
      severity: 'warning',
      destructive: true,
      requiresConfirmation: true,
      reasonCodes: [
        'browser.storage_pressure_high',
        'browser.storage_quota_low',
      ],
    });
    await expect(
      runSyncularLocalRecoveryAction(client, clearCache)
    ).rejects.toBeInstanceOf(SyncularLocalRecoveryError);
    await expect(
      runSyncularLocalRecoveryAction(client, clearCache, {
        confirmationText: clearCache.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'clear-blob-cache',
    });
    expect(client.calls).toContainEqual(['compactStorage']);
    expect(client.calls).toContainEqual(['clearBlobCache']);
  });

  it('does not offer blob-cache clearing when the runtime lacks blob support', async () => {
    const client = new FakeRecoveryClient({
      snapshot: diagnosticSnapshotWithRuntimeFeatures([
        'web-owned-sqlite-core',
      ]),
    });
    const plan = await getSyncularLocalRecoveryPlan(client, {
      deploymentPreflight: storagePressurePreflight({
        persistRequestSupported: true,
      }),
      includeMaintenanceActions: true,
      includeSignOutAction: true,
    });

    expect(
      plan.actions.some((action) => action.kind === 'clear-blob-cache')
    ).toBe(false);
    expect(requiredAction(plan.actions, 'compact-storage')).toMatchObject({
      id: 'storage.compact',
      reasonCodes: [
        'browser.storage_pressure_high',
        'browser.storage_quota_low',
      ],
    });

    const signOut = requiredAction(plan.actions, 'prepare-sign-out');
    expect(signOut).toMatchObject({
      clearBlobCache: false,
      description:
        'Reset subscription/bootstrap state and clear synced app rows so the next user reboots from server authority.',
    });

    await expect(
      runSyncularLocalRecoveryAction(client, signOut, {
        confirmationText: signOut.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'prepare-sign-out',
      clearedBlobCache: false,
    });
    expect(client.calls.some(([call]) => call === 'clearBlobCache')).toBe(
      false
    );
  });

  it('does not offer browser persistence requests when preflight proves the API is unavailable', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      deploymentPreflight: storagePressurePreflight({
        persistRequestSupported: false,
      }),
    });

    expect(
      plan.actions.some(
        (action) => action.kind === 'request-persistent-storage'
      )
    ).toBe(false);
    await expect(
      runSyncularLocalRecoveryAction(
        client,
        {
          ...requiredAction(plan.actions, 'compact-storage'),
          kind: 'request-persistent-storage',
        },
        { navigator: {} }
      )
    ).resolves.toMatchObject({
      action: 'request-persistent-storage',
      supported: false,
      granted: null,
    });
  });

  it('blocks destructive recovery actions when required multi-tab coordination is missing', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeResetAction: true,
      multiTabMode: 'single-open-database-tab',
      requireMultiTabCoordinationForDestructiveActions: true,
      resetClearSyncedRows: true,
    });

    const reset = requiredAction(plan.actions, 'reset-local-sync-state');
    expect(reset.blockers).toEqual([
      expect.objectContaining({
        code: 'browser.multi_tab_coordination_required',
        recommendedAction: 'coordinateBrowserTabs',
        details: { multiTabMode: 'single-open-database-tab' },
      }),
    ]);
    await expect(
      runSyncularLocalRecoveryAction(client, reset, {
        confirmationText: reset.confirmationText,
      })
    ).rejects.toBeInstanceOf(SyncularLocalRecoveryBlockedError);
    expect(
      requiredAction(plan.actions, 'export-support-bundle').blockers
    ).toBeUndefined();
  });

  it('blocks destructive recovery actions when required multi-tab coordination is unknown', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeResetAction: true,
      requireMultiTabCoordinationForDestructiveActions: true,
    });

    expect(
      requiredAction(plan.actions, 'reset-local-sync-state').blockers
    ).toEqual([
      expect.objectContaining({
        code: 'browser.multi_tab_coordination_required',
        details: { multiTabMode: 'unknown' },
      }),
    ]);
  });

  it('allows destructive recovery actions when required multi-tab coordination is available', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeResetAction: true,
      multiTabMode: 'coordinated',
      requireMultiTabCoordinationForDestructiveActions: true,
    });

    const reset = requiredAction(plan.actions, 'reset-local-sync-state');
    expect(reset.blockers).toBeUndefined();
    await expect(
      runSyncularLocalRecoveryAction(client, reset, {
        confirmationText: reset.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'reset-local-sync-state',
    });
  });

  it('serializes recovery actions through Web Locks when coordination is enabled', async () => {
    const firstGate = createDeferred<void>();
    const firstClient = new FakeRecoveryClient({
      resetDelay: firstGate.promise,
    });
    const secondClient = new FakeRecoveryClient();
    const locks = new FakeWebLocks();
    const plan = await getSyncularLocalRecoveryPlan(firstClient, {
      includeResetAction: true,
      multiTabMode: 'coordinated',
      requireMultiTabCoordinationForDestructiveActions: true,
      resetClearSyncedRows: true,
    });
    const reset = requiredAction(plan.actions, 'reset-local-sync-state');
    const options = {
      confirmationText: reset.confirmationText,
      lock: { name: 'syncular:test:local-recovery' },
      navigator: { locks },
    };

    const first = runSyncularLocalRecoveryAction(firstClient, reset, options);
    await Promise.resolve();
    expect(firstClient.calls).toContainEqual([
      'resetLocalSyncState',
      { subscriptionIds: [], clearSyncedRows: true },
    ]);

    const second = runSyncularLocalRecoveryAction(secondClient, reset, options);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      secondClient.calls.some(([call]) => call === 'resetLocalSyncState')
    ).toBe(false);

    firstGate.resolve();
    await expect(first).resolves.toMatchObject({
      action: 'reset-local-sync-state',
      coordination: {
        lockName: 'syncular:test:local-recovery',
        lockRequired: false,
        lockState: 'acquired',
      },
    });
    await expect(second).resolves.toMatchObject({
      action: 'reset-local-sync-state',
      coordination: {
        lockName: 'syncular:test:local-recovery',
        lockRequired: false,
        lockState: 'acquired',
      },
    });
    expect(locks.requests).toEqual([
      'syncular:test:local-recovery',
      'syncular:test:local-recovery',
    ]);
  });

  it('times out queued Web Locks recovery coordination without running the action', async () => {
    const firstGate = createDeferred<void>();
    const firstClient = new FakeRecoveryClient({
      resetDelay: firstGate.promise,
    });
    const secondClient = new FakeRecoveryClient();
    const thirdClient = new FakeRecoveryClient();
    const locks = new FakeWebLocks();
    const lockName = 'syncular:test:local-recovery-timeout';
    const plan = await getSyncularLocalRecoveryPlan(firstClient, {
      includeResetAction: true,
      multiTabMode: 'coordinated',
      requireMultiTabCoordinationForDestructiveActions: true,
      resetClearSyncedRows: true,
    });
    const reset = requiredAction(plan.actions, 'reset-local-sync-state');

    const first = runSyncularLocalRecoveryAction(firstClient, reset, {
      confirmationText: reset.confirmationText,
      lock: { name: lockName },
      navigator: { locks },
    });
    await Promise.resolve();
    expect(firstClient.calls).toContainEqual([
      'resetLocalSyncState',
      { subscriptionIds: [], clearSyncedRows: true },
    ]);

    let observedTimeoutError: unknown;
    try {
      await runSyncularLocalRecoveryAction(secondClient, reset, {
        confirmationText: reset.confirmationText,
        lock: { name: lockName, timeoutMs: 5 },
        navigator: { locks },
      });
    } catch (error) {
      observedTimeoutError = error;
    }
    expect(observedTimeoutError).toBeInstanceOf(
      SyncularLocalRecoveryActionLockTimeoutError
    );
    expect(observedTimeoutError).toMatchObject({
      code: 'syncular.local_recovery_web_locks_timeout',
      lockName,
      timeoutMs: 5,
    });
    expect(
      secondClient.calls.some(([call]) => call === 'resetLocalSyncState')
    ).toBe(false);

    firstGate.resolve();
    await expect(first).resolves.toMatchObject({
      action: 'reset-local-sync-state',
      coordination: {
        lockName,
        lockRequired: false,
        lockState: 'acquired',
      },
    });

    await expect(
      runSyncularLocalRecoveryAction(thirdClient, reset, {
        confirmationText: reset.confirmationText,
        lock: { name: lockName, timeoutMs: 50 },
        navigator: { locks },
      })
    ).resolves.toMatchObject({
      action: 'reset-local-sync-state',
      coordination: {
        lockName,
        lockRequired: false,
        lockState: 'acquired',
        lockTimeoutMs: 50,
      },
    });
    expect(thirdClient.calls).toContainEqual([
      'resetLocalSyncState',
      { subscriptionIds: [], clearSyncedRows: true },
    ]);
  });

  it('falls back when optional Web Locks recovery coordination is unavailable', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeResetAction: true,
      resetClearSyncedRows: true,
    });
    const reset = requiredAction(plan.actions, 'reset-local-sync-state');

    await expect(
      runSyncularLocalRecoveryAction(client, reset, {
        confirmationText: reset.confirmationText,
        lock: true,
        navigator: {},
      })
    ).resolves.toMatchObject({
      action: 'reset-local-sync-state',
      coordination: {
        lockName: 'syncular:local-recovery',
        lockRequired: false,
        lockState: 'unavailable',
      },
    });
    expect(client.calls).toContainEqual([
      'resetLocalSyncState',
      { subscriptionIds: [], clearSyncedRows: true },
    ]);
  });

  it('rejects when required Web Locks recovery coordination is unavailable', async () => {
    const client = new FakeRecoveryClient();
    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeResetAction: true,
    });
    const reset = requiredAction(plan.actions, 'reset-local-sync-state');

    await expect(
      runSyncularLocalRecoveryAction(client, reset, {
        confirmationText: reset.confirmationText,
        lock: {
          name: 'syncular:test:required-local-recovery',
          required: true,
        },
        navigator: {},
      })
    ).rejects.toBeInstanceOf(SyncularLocalRecoveryActionLockError);
    expect(client.calls.some(([call]) => call === 'resetLocalSyncState')).toBe(
      false
    );
  });

  it('adds a confirmed sign-out cleanup action only when the local outbox is empty', async () => {
    const client = new FakeRecoveryClient();
    const defaultPlan = await getSyncularLocalRecoveryPlan(client);
    expect(
      defaultPlan.actions.some((action) => action.kind === 'prepare-sign-out')
    ).toBe(false);

    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeSignOutAction: true,
      signOutSubscriptionIds: ['sub-a'],
    });
    const action = requiredAction(plan.actions, 'prepare-sign-out');
    expect(action).toMatchObject({
      id: 'storage.prepare-sign-out',
      severity: 'danger',
      destructive: true,
      requiresConfirmation: true,
      clearSyncedRows: true,
      clearBlobCache: true,
      subscriptionIds: ['sub-a'],
      reasonCodes: ['sign_out.clear_local_data_requested'],
    });

    await expect(
      runSyncularLocalRecoveryAction(client, action)
    ).rejects.toBeInstanceOf(SyncularLocalRecoveryError);

    await expect(
      runSyncularLocalRecoveryAction(client, action, {
        confirmationText: action.confirmationText,
      })
    ).resolves.toMatchObject({
      action: 'prepare-sign-out',
      clearedBlobCache: true,
      report: { resetSubscriptions: 1, clearedSyncedRows: 2 },
    });
    expect(client.calls).toContainEqual([
      'resetLocalSyncState',
      { subscriptionIds: ['sub-a'], clearSyncedRows: true },
    ]);
    expect(client.calls).toContainEqual(['clearBlobCache']);
  });

  it('blocks sign-out cleanup while unsynced outbox work exists', async () => {
    const client = new FakeRecoveryClient({
      snapshot: {
        ...diagnosticSnapshot(),
        outboxStats: {
          pending: 1,
          sending: 0,
          failed: 0,
          acked: 0,
          total: 1,
        },
      },
    });

    const plan = await getSyncularLocalRecoveryPlan(client, {
      includeSignOutAction: true,
    });

    expect(
      plan.actions.some((action) => action.kind === 'prepare-sign-out')
    ).toBe(false);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sign-out.drain-outbox-first',
          kind: 'resume-from-background',
          reasonCodes: ['sign_out.outbox_not_empty'],
          destructive: false,
        }),
      ])
    );
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
  readonly #resetDelay: Promise<void> | undefined;

  constructor(
    args: {
      health?: SyncularLocalHealthReport;
      snapshot?: SyncularDiagnosticSnapshot;
      status?: SyncularClientStatus;
      resetDelay?: Promise<void>;
    } = {}
  ) {
    this.#health = args.health ?? healthyLocalHealth();
    this.#snapshot = args.snapshot ?? diagnosticSnapshot();
    this.#status = args.status ?? clientStatus();
    this.#resetDelay = args.resetDelay;
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
      formatVersion: 2,
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
      outboxCommits: [],
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
    await this.#resetDelay;
    return {
      resetSubscriptions: request?.subscriptionIds?.length ?? 0,
      deletedSubscriptionStates: 1,
      deletedVerifiedRoots: 1,
      clearedSyncedRows: request?.clearSyncedRows ? 2 : 0,
      clearedTables: request?.clearSyncedRows ? ['tasks'] : [],
    };
  }
}

class FakeWebLocks {
  readonly requests: string[] = [];
  #active = false;
  readonly #queue: Array<() => void> = [];

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; signal?: AbortSignal },
    callback: () => T | Promise<T>
  ): Promise<T> {
    if (options.mode !== 'exclusive') {
      throw new Error(`Unexpected lock mode ${options.mode}`);
    }
    this.requests.push(name);
    await this.#acquire(options.signal);
    try {
      return await callback();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Lock request aborted'));
    }
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let queued: (() => void) | null = null;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (!queued) return;
        const index = this.#queue.indexOf(queued);
        if (index >= 0) {
          this.#queue.splice(index, 1);
        }
        queued = null;
        cleanup();
        reject(new Error('Lock request aborted'));
      };
      queued = () => {
        queued = null;
        cleanup();
        this.#active = true;
        resolve();
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#queue.push(queued);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
      return;
    }
    this.#active = false;
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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

function diagnosticSnapshotWithRuntimeFeatures(
  features: readonly string[]
): SyncularDiagnosticSnapshot {
  const snapshot = diagnosticSnapshot();
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      rust: {
        crateName: 'syncular-runtime',
        crateVersion: '0.0.0-test',
        schemaVersion: 1,
        features: [...features],
      },
    },
  };
}

function diagnosticSubscription(
  overrides: Partial<SyncularDiagnosticSnapshot['subscriptions'][number]> = {}
): SyncularDiagnosticSnapshot['subscriptions'][number] {
  return {
    id: 'sub-tasks',
    table: 'tasks',
    scopeKeys: ['user_id'],
    scopeValueCount: 1,
    paramsKeys: [],
    paramsValueCount: 0,
    status: 'active',
    ready: true,
    phase: 'ready',
    progressPercent: 100,
    cursor: 1,
    bootstrapPhase: 0,
    bootstrapState: null,
    ...overrides,
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

function storagePressurePreflight(options: {
  persistRequestSupported: boolean;
}): SyncularBrowserDeploymentPreflight {
  return {
    browser: {
      crossOriginIsolated: false,
      indexedDB: true,
      secureContext: true,
      serviceWorker: false,
      serviceWorkerControlled: false,
      serviceWorkerControllerScriptPath: null,
      serviceWorkerControllerState: null,
      webAssembly: true,
      worker: true,
    },
    generatedAt: 1,
    lifecycle: {
      beforeUnloadEvent: true,
      broadcastChannel: true,
      multiTabMode: 'coordinated',
      pageHideEvent: true,
      pageVisibility: true,
      resumeSignalAvailable: true,
      shutdownSignalAvailable: true,
      webLocks: true,
    },
    ready: false,
    requiresAction: false,
    runtimeAssets: {
      assets: [],
      checked: true,
      requiredFeatures: [],
    },
    status: 'warning',
    storage: {
      availableBytes: 5_000,
      durableRequired: true,
      fallbackAllowed: false,
      minimumAvailableBytes: 25_000,
      opfsAvailable: null,
      persisted: false,
      persistenceSupported: true,
      persistRequestSupported: options.persistRequestSupported,
      quotaBytes: 100_000,
      quotaPressure: 'high',
      requested: 'indexedDb',
      usageBytes: 95_000,
      usageRatio: 0.95,
    },
    support: {
      issueCodes: [
        'browser.storage_persistence_not_granted',
        'browser.storage_pressure_high',
        'browser.storage_quota_low',
      ],
      persistence: 'evictable',
      persistentOffline: true,
      productionReady: false,
      recommendedActions: ['requestPersistentStorage', 'freeStorageQuota'],
      summary:
        'Persistent offline browser storage is supported, but storage may be evicted or persistence could not be fully proven.',
      tier: 'persistent-offline',
    },
    issues: [
      {
        code: 'browser.storage_persistence_not_granted',
        details: {
          persistRequestSupported: options.persistRequestSupported,
        },
        message: 'persistence not granted',
        recommendedAction: 'requestPersistentStorage',
        severity: 'warning',
        target: 'storage',
      },
      {
        code: 'browser.storage_pressure_high',
        details: {
          availableBytes: 5_000,
          quotaBytes: 100_000,
          usageBytes: 95_000,
          usageRatio: 0.95,
        },
        message: 'storage pressure is high',
        recommendedAction: 'freeStorageQuota',
        severity: 'warning',
        target: 'storage',
      },
      {
        code: 'browser.storage_quota_low',
        details: {
          availableBytes: 5_000,
          minimumAvailableBytes: 25_000,
        },
        message: 'available quota is low',
        recommendedAction: 'freeStorageQuota',
        severity: 'warning',
        target: 'storage',
      },
    ],
  };
}
