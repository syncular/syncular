import { describe, expect, it } from 'bun:test';
import type { SyncularClientStatus } from './client';
import {
  getSyncularSupportBundle,
  type SyncularSupportBundleClient,
} from './support-bundle';
import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularLocalHealthReport,
  SyncularLocalSupportBundle,
  SyncularRuntimeInfo,
  SyncularSchemaState,
} from './types';

describe('support bundle', () => {
  it('composes redacted browser, schema, timeline, preflight, and local support data', async () => {
    const client = new FakeSupportClient({
      snapshot: diagnosticSnapshot({
        recentDiagnostics: [
          diagnosticEvent({
            at: 123,
            code: 'sync.scope_revoked',
            level: 'error',
            message: 'scope revoked',
            source: 'sync',
            requestId: 'req-1',
            subscriptionId: 'sub-a',
            syncAttemptId: 'attempt-1',
            table: 'tasks',
            traceId: 'trace-1',
            spanId: 'span-1',
            details: {
              authorization: 'Bearer secret',
              changedTables: ['tasks'],
            },
          }),
        ],
      }),
      schemaState: {
        schemaId: 'app',
        schemaVersion: 1,
        currentSchemaVersion: 2,
        updatedAt: 100,
      },
      status: clientStatus({ requiresAction: true }),
    });

    const bundle = await getSyncularSupportBundle(client, {
      now: () => 500,
      schemaReadinessOptions: { generatedSchemaVersion: 2 },
      deploymentPreflight: deploymentPreflight(),
    });

    expect(bundle).toMatchObject({
      formatVersion: 1,
      generatedAt: 500,
      redacted: true,
      source: '@syncular/client',
      sections: {
        browserHealth: 'included',
        runtimeTimeline: 'included',
        schemaReadiness: 'included',
        deploymentPreflight: 'included',
        localSupportBundle: 'included',
      },
      summary: {
        status: 'action-required',
        requiresAction: true,
        requestIds: ['req-1'],
        syncAttemptIds: ['attempt-1'],
        traceIds: ['trace-1'],
        spanIds: ['span-1'],
        affectedTables: ['tasks'],
        subscriptionIds: ['sub-a'],
        runtime: {
          packageName: '@syncular/client',
          packageVersion: '1.2.3',
        },
      },
      redaction: {
        redacted: true,
        redactedValue: '[redacted]',
        omittedRuntimeUrlFields: ['workerUrl', 'wasmGlueUrl', 'wasmUrl'],
      },
    });
    expect(bundle.summary.issueCodes).toEqual(
      expect.arrayContaining([
        'browser.storage_quota_low',
        'local.subscription_state_orphaned',
        'schema.local_schema_stale',
        'sync.scope_revoked',
      ])
    );
    expect(bundle.summary.subscriptionCursors).toEqual([
      { id: 'sub-a', table: 'tasks', cursor: 10 },
    ]);
    expect(bundle.browserHealth?.runtime).toMatchObject({
      runtimeAssetUrlsRedacted: true,
    });
    expect('wasmUrl' in (bundle.browserHealth?.runtime ?? {})).toBe(false);
    expect(bundle.deploymentPreflight?.runtimeAssets.assets[0]).toMatchObject({
      kind: 'wasm-binary',
      urlRedacted: true,
    });
    expect(
      'url' in (bundle.deploymentPreflight?.runtimeAssets.assets[0] ?? {})
    ).toBe(false);
    expect(bundle.runtimeTimeline?.events[0]?.details).toMatchObject({
      authorization: '[redacted]',
      changedTables: ['tasks'],
    });
    expect(bundle.localSupportBundle?.redacted).toBe(true);
  });

  it('records omitted and failed sections without throwing away the bundle', async () => {
    const client = new FakeSupportClient({
      localSupportBundleError: new Error('local export failed'),
    });

    const bundle = await getSyncularSupportBundle(client, {
      includeBrowserHealth: false,
      includeRuntimeTimeline: false,
      includeSchemaReadiness: false,
    });

    expect(bundle.sections).toMatchObject({
      browserHealth: 'omitted',
      runtimeTimeline: 'omitted',
      schemaReadiness: 'omitted',
      deploymentPreflight: 'omitted',
      localSupportBundle: 'failed',
    });
    expect(bundle.sectionErrors).toEqual([
      {
        section: 'localSupportBundle',
        message: 'local export failed',
      },
    ]);
    expect(bundle.summary).toMatchObject({
      status: 'warning',
      requiresAction: false,
      issueCodes: ['support.localSupportBundle_failed'],
    });
  });
});

class FakeSupportClient implements SyncularSupportBundleClient {
  readonly #snapshot: SyncularDiagnosticSnapshot;
  readonly #status: SyncularClientStatus;
  readonly #schemaState: SyncularSchemaState;
  readonly #localSupportBundleError: Error | undefined;

  constructor(
    args: {
      snapshot?: SyncularDiagnosticSnapshot;
      status?: SyncularClientStatus;
      schemaState?: SyncularSchemaState;
      localSupportBundleError?: Error;
    } = {}
  ) {
    this.#snapshot = args.snapshot ?? diagnosticSnapshot();
    this.#status = args.status ?? clientStatus();
    this.#schemaState =
      args.schemaState ??
      ({
        schemaId: 'app',
        schemaVersion: 2,
        currentSchemaVersion: 2,
        updatedAt: 100,
      } satisfies SyncularSchemaState);
    this.#localSupportBundleError = args.localSupportBundleError;
  }

  async diagnosticSnapshot() {
    return this.#snapshot;
  }

  getStatus() {
    return this.#status;
  }

  async runtimeInfo() {
    return this.#snapshot.runtime;
  }

  async generatedSchemaState() {
    return this.#schemaState;
  }

  async exportLocalSupportBundle() {
    if (this.#localSupportBundleError) throw this.#localSupportBundleError;
    return localSupportBundle();
  }
}

function diagnosticSnapshot(
  overrides: Partial<SyncularDiagnosticSnapshot> = {}
): SyncularDiagnosticSnapshot {
  return {
    generatedAt: 1_000,
    runtime: runtimeInfo(),
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    },
    subscriptions: [
      {
        id: 'sub-a',
        table: 'tasks',
        scopeKeys: ['projectId'],
        scopeValueCount: 1,
        paramsKeys: [],
        paramsValueCount: 0,
        status: 'ok',
        ready: true,
        phase: 'live',
        progressPercent: 100,
        cursor: 10,
        bootstrapPhase: 0,
        bootstrapState: null,
      },
    ],
    recentDiagnostics: [],
    recentSyncTimings: [],
    bootstrap: bootstrapStatus(),
    outboxStats: {
      acked: 1,
      failed: 0,
      pending: 0,
      sending: 0,
      total: 1,
    },
    conflictStats: {
      resolved: 0,
      total: 0,
      unresolved: 0,
    },
    blobUploadStats: {
      failed: 0,
      pending: 0,
      uploading: 0,
    },
    ...overrides,
  };
}

function runtimeInfo(): SyncularRuntimeInfo {
  return {
    packageName: '@syncular/client',
    packageVersion: '1.2.3',
    workerProtocolVersion: 1,
    storage: 'opfsSahPool',
    workerUrl: 'https://example.com/syncular-worker.js?token=secret',
    wasmGlueUrl: 'https://example.com/syncular.js?token=secret',
    wasmUrl: 'https://example.com/syncular_bg.wasm?token=secret',
    rust: {
      crateName: 'syncular-runtime',
      crateVersion: '1.2.3',
      features: ['web-owned-sqlite-core'],
      schemaVersion: 2,
    },
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

function bootstrapStatus(): SyncularBootstrapStatus {
  return {
    activePhase: null,
    channelPhase: 'live',
    complete: true,
    criticalReady: true,
    expectedSubscriptionIds: ['sub-a'],
    interactiveReady: true,
    isBootstrapping: false,
    pendingSubscriptionIds: [],
    phases: [
      {
        expectedSubscriptionIds: ['sub-a'],
        isReady: true,
        pendingSubscriptionIds: [],
        phase: 0,
        progressPercent: 100,
        readySubscriptionIds: ['sub-a'],
      },
    ],
    progressPercent: 100,
    readySubscriptionIds: ['sub-a'],
    subscriptions: [
      {
        bootstrapPhase: 0,
        bootstrapState: null,
        cursor: 10,
        expected: true,
        id: 'sub-a',
        phase: 'live',
        progressPercent: 100,
        ready: true,
        status: 'ok',
        table: 'tasks',
      },
    ],
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

function localSupportBundle(): SyncularLocalSupportBundle {
  const health = localHealth();
  return {
    appSchemaState: {
      schemaId: 'app',
      schemaVersion: 2,
      currentSchemaVersion: 2,
      updatedAt: 100,
    },
    blob: { cached: 1 },
    conflicts: {
      byCode: {},
      byResultStatus: {},
      resolved: 0,
      total: 0,
      unresolved: 0,
    },
    crdt: {},
    formatVersion: 2,
    generatedAt: 100,
    health,
    outbox: {
      bySchemaVersion: {},
      byStatus: {},
      total: 0,
    },
    outboxCommits: [],
    redacted: true,
    source: 'fake',
    subscriptionStates: [],
    subscriptions: [],
    verifiedRoots: [],
  };
}

function localHealth(): SyncularLocalHealthReport {
  return {
    checkedConflicts: 0,
    checkedOutboxCommits: 0,
    checkedSubscriptionStates: 1,
    checkedSubscriptions: 1,
    checkedSyncedRows: 0,
    checkedVerifiedRoots: 0,
    findings: [
      {
        code: 'local.subscription_state_orphaned',
        component: 'subscriptionState',
        message: 'orphaned subscription',
        repairAction: 'clearOrphanedState',
        severity: 'warning',
        subscriptionId: 'sub-a',
        table: 'tasks',
      },
    ],
    generatedAt: 100,
    ok: false,
  };
}

function deploymentPreflight() {
  return {
    browser: {
      crossOriginIsolated: null,
      indexedDB: true,
      secureContext: true,
      webAssembly: true,
      worker: true,
    },
    generatedAt: 100,
    issues: [
      {
        code: 'browser.storage_quota_low' as const,
        details: { quotaBytes: 1 },
        message: 'quota is low',
        recommendedAction: 'freeStorageQuota' as const,
        severity: 'warning' as const,
        target: 'storage' as const,
      },
    ],
    ready: true,
    requiresAction: false,
    support: {
      issueCodes: ['browser.storage_quota_low' as const],
      persistence: 'persistent' as const,
      persistentOffline: true,
      productionReady: false,
      recommendedActions: ['freeStorageQuota' as const],
      summary:
        'Persistent offline browser storage is supported and persistent storage is currently granted.',
      tier: 'persistent-offline' as const,
    },
    runtimeAssets: {
      assets: [
        {
          checked: true,
          contentType: 'application/wasm',
          httpStatus: 200,
          issueCodes: [],
          kind: 'wasm-binary' as const,
          status: 'ready' as const,
          url: 'https://example.com/syncular_bg.wasm?token=secret',
        },
      ],
      checked: true,
      requiredFeatures: ['web-owned-sqlite-core'],
    },
    status: 'warning' as const,
    storage: {
      durableRequired: true,
      fallbackAllowed: true,
      opfsAvailable: true,
      persisted: true,
      persistenceSupported: true,
      requested: 'opfsSahPool' as const,
    },
  };
}
