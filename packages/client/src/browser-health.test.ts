import { describe, expect, it } from 'bun:test';
import {
  getSyncularBrowserHealth,
  type SyncularBrowserHealthClient,
} from './browser-health';
import type {
  SyncularClientStatus,
  SyncularDiagnosticSnapshot,
  SyncularStorageFallbackInfo,
} from './types';

describe('Syncular browser health', () => {
  it('summarizes durable browser runtime state for app UI surfaces', async () => {
    const client = fakeHealthClient({
      snapshot: makeSnapshot(),
      status: makeStatus(),
    });

    await expect(getSyncularBrowserHealth(client)).resolves.toMatchObject({
      status: 'ok',
      requiresAction: false,
      recommendedActions: [],
      lifecycle: {
        phase: 'complete',
        stage: 'realtime-live',
        recoveryOwner: 'none',
        blockedOperationCount: 0,
        operations: expect.arrayContaining([
          {
            operation: 'generated-mutation',
            availability: 'available',
          },
          {
            operation: 'sync-now',
            availability: 'available',
          },
          {
            operation: 'destructive-local-recovery',
            availability: 'advanced',
            reasonCode: 'lifecycle.advanced_recovery',
          },
        ]),
      },
      persistence: {
        status: 'durable',
        durable: true,
        storage: 'indexedDb',
        effectiveStorage: 'indexedDb',
        issueCodes: [],
      },
      subscriptions: {
        total: 1,
        ready: 1,
        pending: 0,
        errored: 0,
        revoked: 0,
      },
      realtime: { state: 'connected', connected: true },
      bootstrap: {
        complete: true,
        criticalReady: true,
        pendingSubscriptionIds: [],
      },
      lastError: null,
    });
  });

  it('reports non-durable storage fallback without hiding the reason', async () => {
    const fallback: SyncularStorageFallbackInfo = {
      from: 'opfsSahPool',
      to: 'memory',
      reason: 'OPFS synchronous access handles are unavailable.',
    };
    const client = fakeHealthClient({
      snapshot: makeSnapshot({ storageFallback: fallback }),
      status: makeStatus(),
    });

    await expect(getSyncularBrowserHealth(client)).resolves.toMatchObject({
      status: 'degraded',
      persistence: {
        status: 'memory',
        durable: false,
        storage: 'indexedDb',
        effectiveStorage: 'memory',
        fallback,
        fallbackSeverity: 'ephemeral',
        issueCodes: ['browser.storage_fallback', 'browser.storage_ephemeral'],
        reason: fallback.reason,
      },
    });
  });

  it('reports durable storage fallback without pretending persistence is memory-only', async () => {
    const fallback: SyncularStorageFallbackInfo = {
      from: 'opfsSahPool',
      to: 'indexedDb',
      reason: 'Storage: install opfs-sahpool vfs: sync access handle failed',
    };
    const client = fakeHealthClient({
      snapshot: makeSnapshot({ storageFallback: fallback }),
      status: makeStatus(),
    });

    await expect(getSyncularBrowserHealth(client)).resolves.toMatchObject({
      status: 'ok',
      requiresAction: false,
      persistence: {
        status: 'durable',
        durable: true,
        storage: 'indexedDb',
        effectiveStorage: 'indexedDb',
        fallback,
        fallbackSeverity: 'durable',
        issueCodes: ['browser.storage_fallback'],
        reason: fallback.reason,
      },
      lifecycle: {
        recoveryOwner: 'none',
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation: 'generated-mutation',
            availability: 'available',
          }),
          expect.objectContaining({
            operation: 'destructive-local-recovery',
            availability: 'advanced',
          }),
        ]),
      },
    });
  });

  it('surfaces revoked subscriptions and structured last errors', async () => {
    const client = fakeHealthClient({
      snapshot: makeSnapshot({
        subscriptionStatus: 'revoked',
        subscriptionReady: false,
        subscriptionPhase: 'error',
        errorDiagnostic: {
          at: 2,
          level: 'error',
          source: 'sync',
          code: 'sync.scope_revoked',
          message: 'subscription scope was revoked',
          subscriptionId: 'sub-tasks',
          table: 'tasks',
          details: { actorId: 'user-1', scope: { user_id: 'user-2' } },
        },
      }),
      status: makeStatus({
        phase: 'degraded',
        requiresAction: true,
        lastError: {
          code: 'sync.scope_revoked',
          message: 'subscription scope was revoked',
        },
      }),
    });

    await expect(getSyncularBrowserHealth(client)).resolves.toMatchObject({
      status: 'action-required',
      requiresAction: true,
      lifecycle: {
        stage: 'requires-action',
        recoveryOwner: 'app-scope',
        blockedOperationCount: 3,
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation: 'generated-mutation',
            availability: 'blocked',
            reasonCode: 'sync.scope_revoked',
            recommendedAction: 'checkPermissions',
          }),
          expect.objectContaining({
            operation: 'sync-now',
            availability: 'blocked',
            reasonCode: 'sync.scope_revoked',
            recommendedAction: 'checkPermissions',
          }),
          expect.objectContaining({
            operation: 'destructive-local-recovery',
            availability: 'requires-confirmation',
            reasonCode: 'sync.scope_revoked',
          }),
        ]),
      },
      recommendedActions: expect.arrayContaining([
        expect.objectContaining({
          code: 'sync.scope_revoked',
          recommendedAction: 'checkPermissions',
          source: 'subscriptions',
        }),
        expect.objectContaining({
          code: 'sync.scope_revoked',
          recommendedAction: 'checkPermissions',
          source: 'sync',
        }),
      ]),
      subscriptions: {
        total: 1,
        ready: 0,
        errored: 1,
        revoked: 1,
      },
      lastError: {
        code: 'sync.scope_revoked',
        message: 'subscription scope was revoked',
      },
      recentErrors: [
        {
          code: 'sync.scope_revoked',
          source: 'sync',
          details: { actorId: 'user-1', scope: { user_id: 'user-2' } },
        },
      ],
    });
  });

  it('maps auth-required lifecycle state to a stable refresh action', async () => {
    const client = fakeHealthClient({
      snapshot: makeSnapshot(),
      status: makeStatus({
        phase: 'authRequired',
        requiresAction: true,
        lastError: {
          code: 'sync.auth_required',
          message: 'Authentication is required.',
        },
      }),
    });

    await expect(getSyncularBrowserHealth(client)).resolves.toMatchObject({
      status: 'action-required',
      requiresAction: true,
      lifecycle: {
        stage: 'requires-action',
        recoveryOwner: 'app-auth',
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation: 'generated-mutation',
            availability: 'blocked',
            reasonCode: 'sync.auth_required',
            recommendedAction: 'refreshAuth',
          }),
          expect.objectContaining({
            operation: 'replace-auth-context',
            availability: 'available',
          }),
          expect.objectContaining({
            operation: 'sync-now',
            availability: 'blocked',
            reasonCode: 'sync.auth_required',
            recommendedAction: 'refreshAuth',
          }),
        ]),
      },
      recommendedActions: expect.arrayContaining([
        expect.objectContaining({
          code: 'sync.auth_required',
          recommendedAction: 'refreshAuth',
          source: 'lifecycle',
        }),
      ]),
    });
  });

  it('keeps generated mutations available while offline but blocks immediate sync', async () => {
    const client = fakeHealthClient({
      snapshot: makeSnapshot(),
      status: makeStatus({
        phase: 'offline',
        online: false,
        lastError: {
          code: 'sync.offline',
          message: 'The browser is offline.',
        },
      }),
    });

    await expect(getSyncularBrowserHealth(client)).resolves.toMatchObject({
      status: 'offline',
      requiresAction: false,
      lifecycle: {
        phase: 'offline',
        stage: 'offline',
        recoveryOwner: 'runtime',
        blockedOperationCount: 1,
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation: 'generated-mutation',
            availability: 'available',
          }),
          expect.objectContaining({
            operation: 'await-local-visibility',
            availability: 'available',
          }),
          expect.objectContaining({
            operation: 'sync-now',
            availability: 'blocked',
            reasonCode: 'sync.offline',
            recommendedAction: 'retryLater',
          }),
        ]),
      },
    });
  });
});

function fakeHealthClient(args: {
  snapshot: SyncularDiagnosticSnapshot;
  status?: SyncularClientStatus;
}): SyncularBrowserHealthClient {
  return {
    async diagnosticSnapshot() {
      return args.snapshot;
    },
    ...(args.status
      ? {
          getStatus() {
            return args.status!;
          },
        }
      : {}),
  };
}

function makeSnapshot(
  options: {
    storageFallback?: SyncularStorageFallbackInfo;
    subscriptionReady?: boolean;
    subscriptionStatus?: string;
    subscriptionPhase?: string;
    errorDiagnostic?: SyncularDiagnosticSnapshot['recentDiagnostics'][number];
  } = {}
): SyncularDiagnosticSnapshot {
  const subscriptionReady = options.subscriptionReady ?? true;
  const subscriptionStatus = options.subscriptionStatus ?? 'active';
  const subscriptionPhase = options.subscriptionPhase ?? 'live';
  const recentDiagnostics = options.errorDiagnostic
    ? [options.errorDiagnostic]
    : [];
  return {
    generatedAt: 1,
    runtime: {
      packageName: '@syncular/client',
      packageVersion: '0.1.3',
      workerProtocolVersion: 2,
      storage: 'indexedDb',
      ...(options.storageFallback
        ? { storageFallback: options.storageFallback }
        : {}),
      workerUrl: 'http://localhost/syncular-worker.js',
      wasmGlueUrl: 'http://localhost/wasm/syncular.js',
      wasmUrl: 'http://localhost/wasm/syncular_bg.wasm',
      rust: {
        crateName: 'syncular-runtime',
        crateVersion: '0.1.3',
        schemaVersion: 1,
        features: ['web-owned-sqlite-core'],
      },
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    },
    subscriptions: [
      {
        id: 'sub-tasks',
        table: 'tasks',
        scopeKeys: ['user_id'],
        scopeValueCount: 1,
        paramsKeys: [],
        paramsValueCount: 0,
        status: subscriptionStatus,
        ready: subscriptionReady,
        phase: subscriptionPhase,
        progressPercent: subscriptionReady ? 100 : 0,
        cursor: subscriptionReady ? 10 : null,
        bootstrapPhase: 0,
        bootstrapState: null,
      },
    ],
    recentDiagnostics,
    recentSyncTimings: [],
    bootstrap: {
      channelPhase: subscriptionReady ? 'live' : 'error',
      progressPercent: subscriptionReady ? 100 : 0,
      isBootstrapping: false,
      criticalReady: subscriptionReady,
      interactiveReady: subscriptionReady,
      complete: subscriptionReady,
      activePhase: null,
      expectedSubscriptionIds: ['sub-tasks'],
      readySubscriptionIds: subscriptionReady ? ['sub-tasks'] : [],
      pendingSubscriptionIds: subscriptionReady ? [] : ['sub-tasks'],
      subscriptions: [
        {
          id: 'sub-tasks',
          table: 'tasks',
          expected: true,
          ready: subscriptionReady,
          status: subscriptionStatus,
          phase: subscriptionPhase,
          progressPercent: subscriptionReady ? 100 : 0,
          cursor: subscriptionReady ? 10 : null,
          bootstrapState: null,
          bootstrapPhase: 0,
        },
      ],
      phases: [
        {
          phase: 0,
          expectedSubscriptionIds: ['sub-tasks'],
          readySubscriptionIds: subscriptionReady ? ['sub-tasks'] : [],
          pendingSubscriptionIds: subscriptionReady ? [] : ['sub-tasks'],
          isReady: subscriptionReady,
          progressPercent: subscriptionReady ? 100 : 0,
        },
      ],
    },
  };
}

function makeStatus(
  options: {
    phase?: SyncularClientStatus['lifecycle']['phase'];
    online?: boolean;
    requiresAction?: boolean;
    lastError?: SyncularClientStatus['lifecycle']['lastError'];
  } = {}
): SyncularClientStatus {
  const phase = options.phase ?? 'complete';
  const requiresAction = options.requiresAction ?? false;
  return {
    lifecycle: {
      phase,
      realtime: 'connected',
      online: options.online ?? true,
      requiresAction,
      pendingRequests: 0,
      ...(options.lastError ? { lastError: options.lastError } : {}),
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
      ...(options.lastError ? { lastError: options.lastError } : {}),
    },
    outbox: null,
    conflicts: null,
    isConnected: true,
    isSyncing: false,
    hasPendingMutations: false,
    hasConflicts: false,
    requiresAction,
  };
}
