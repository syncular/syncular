import { describe, expect, it } from 'bun:test';
import type { SyncularClientStatus } from './client';
import {
  getSyncularSubscriptionReadiness,
  type SyncularSubscriptionReadinessClient,
} from './subscription-readiness';
import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularDiagnosticSubscriptionSnapshot,
} from './types';

describe('getSyncularSubscriptionReadiness', () => {
  it('reports ready generated subscriptions without leaking scope values', async () => {
    const result = await getSyncularSubscriptionReadiness(
      client({
        subscriptions: [
          observedSubscription({
            id: 'sub-tasks',
            table: 'tasks',
            ready: true,
            scopeKeys: ['project_id', 'user_id'],
            scopeValueCount: 2,
          }),
        ],
      }),
      {
        expectedSubscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'user-1', project_id: 'project-a' },
          },
        ],
      }
    );

    expect(result).toMatchObject({
      status: 'ready',
      ready: true,
      requiresAction: false,
      summary: {
        total: 1,
        ready: 1,
        waiting: 0,
        actionRequired: 0,
        missing: 0,
        unknown: 0,
      },
    });
    expect(result.items[0]).toMatchObject({
      id: 'sub-tasks',
      table: 'tasks',
      scopeKeys: ['project_id', 'user_id'],
      scopeValueCount: 2,
      ready: true,
      status: 'ready',
    });
    expect(JSON.stringify(result)).not.toContain('project-a');
    expect(JSON.stringify(result)).not.toContain('user-1');
  });

  it('names expected generated subscriptions that were not configured', async () => {
    const result = await getSyncularSubscriptionReadiness(client(), {
      expectedSubscriptions: [
        {
          id: 'sub-projects',
          table: 'projects',
          scopes: { project_id: ['project-a', 'project-b'] },
          params: { includeArchived: false },
          bootstrapPhase: 1,
        },
      ],
    });

    expect(result.status).toBe('action-required');
    expect(result.items[0]).toMatchObject({
      id: 'sub-projects',
      table: 'projects',
      expected: true,
      observed: false,
      status: 'missing',
      bootstrapPhase: 1,
      scopeKeys: ['project_id'],
      scopeValueCount: 2,
      paramsKeys: ['includeArchived'],
      paramsValueCount: 1,
      issues: [
        expect.objectContaining({
          code: 'subscription.missing',
          severity: 'error',
          recommendedAction: 'fixRequest',
        }),
      ],
    });
  });

  it('classifies revoked, auth-required, and rate-limited subscription blockers', async () => {
    const result = await getSyncularSubscriptionReadiness(
      client({
        status: status({ phase: 'authRequired' }),
        subscriptions: [
          observedSubscription({
            id: 'sub-projects',
            table: 'projects',
            status: 'revoked',
            phase: 'error',
          }),
          observedSubscription({
            id: 'sub-tasks',
            table: 'tasks',
            phase: 'pending',
            ready: false,
          }),
        ],
        diagnostics: [
          diagnostic({
            code: 'sync.scope_revoked',
            message: 'revoked',
            subscriptionId: 'sub-projects',
            table: 'projects',
          }),
          diagnostic({
            code: 'sync.auth_required',
            message: 'auth required',
            source: 'auth',
          }),
          diagnostic({
            code: 'sync.rate_limited',
            level: 'warn',
            message: 'rate limited',
            subscriptionId: 'sub-tasks',
            table: 'tasks',
          }),
        ],
      })
    );

    expect(result.status).toBe('action-required');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'subscription.auth_required',
        'subscription.rate_limited',
        'subscription.revoked',
      ])
    );
    expect(
      result.items.find((item) => item.id === 'sub-projects')
    ).toMatchObject({
      status: 'action-required',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'subscription.revoked',
          recommendedAction: 'checkPermissions',
        }),
        expect.objectContaining({
          code: 'subscription.auth_required',
          recommendedAction: 'refreshAuth',
        }),
      ]),
    });
    expect(result.items.find((item) => item.id === 'sub-tasks')).toMatchObject({
      status: 'action-required',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'sync.rate_limited',
          recommendedAction: 'retryLater',
        }),
      ]),
    });
  });

  it('filters readiness to a table while preserving global schema blockers', async () => {
    const result = await getSyncularSubscriptionReadiness(
      client({
        subscriptions: [
          observedSubscription({
            id: 'sub-projects',
            table: 'projects',
            ready: true,
          }),
          observedSubscription({
            id: 'sub-tasks',
            table: 'tasks',
            ready: true,
          }),
        ],
        diagnostics: [
          diagnostic({
            code: 'schema.local_too_old',
            level: 'error',
            message: 'schema too old',
            source: 'worker',
          }),
        ],
      }),
      { tables: ['tasks'] }
    );

    expect(result.items.map((item) => item.id)).toEqual(['sub-tasks']);
    expect(result.status).toBe('action-required');
    expect(result.items[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: 'subscription.schema_issue',
        diagnosticCode: 'schema.local_too_old',
        recommendedAction: 'regenerateClient',
      })
    );
  });

  it('returns unknown when no subscription state exists yet', async () => {
    const result = await getSyncularSubscriptionReadiness(client());

    expect(result).toMatchObject({
      status: 'unknown',
      ready: false,
      requiresAction: false,
      summary: {
        total: 1,
        ready: 0,
        waiting: 0,
        actionRequired: 0,
        missing: 0,
        unknown: 1,
      },
      items: [
        {
          id: '<unknown>',
          table: '<unknown>',
          status: 'unknown',
        },
      ],
    });
  });
});

function client(
  options: {
    diagnostics?: SyncularDiagnosticEvent[];
    status?: SyncularClientStatus;
    subscriptions?: SyncularDiagnosticSubscriptionSnapshot[];
  } = {}
): SyncularSubscriptionReadinessClient {
  const snapshot = diagnosticSnapshot({
    diagnostics: options.diagnostics,
    subscriptions: options.subscriptions,
  });
  return {
    diagnosticSnapshot: async () => snapshot,
    ...(options.status
      ? { getStatus: () => options.status as SyncularClientStatus }
      : {}),
  };
}

function diagnosticSnapshot(
  options: {
    diagnostics?: SyncularDiagnosticEvent[];
    subscriptions?: SyncularDiagnosticSubscriptionSnapshot[];
  } = {}
): SyncularDiagnosticSnapshot {
  return {
    generatedAt: 42,
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
      realtime: 'connected',
    },
    subscriptions: options.subscriptions ?? [],
    recentDiagnostics: options.diagnostics ?? [],
    recentSyncTimings: [],
    bootstrap: bootstrap(options.subscriptions ?? []),
  };
}

function observedSubscription(
  options: Partial<SyncularDiagnosticSubscriptionSnapshot> & {
    id: string;
    table: string;
  }
): SyncularDiagnosticSubscriptionSnapshot {
  return {
    id: options.id,
    table: options.table,
    scopeKeys: options.scopeKeys ?? ['user_id'],
    scopeValueCount: options.scopeValueCount ?? 1,
    paramsKeys: options.paramsKeys ?? [],
    paramsValueCount: options.paramsValueCount ?? 0,
    status: options.status ?? 'ok',
    ready: options.ready ?? false,
    phase: options.phase ?? (options.ready ? 'live' : 'pending'),
    progressPercent: options.progressPercent ?? (options.ready ? 100 : 0),
    cursor: options.cursor ?? null,
    bootstrapPhase: options.bootstrapPhase ?? 0,
    bootstrapState: options.bootstrapState ?? null,
  };
}

function bootstrap(
  subscriptions: readonly SyncularDiagnosticSubscriptionSnapshot[]
): SyncularBootstrapStatus {
  const readySubscriptionIds = subscriptions
    .filter((subscription) => subscription.ready)
    .map((subscription) => subscription.id);
  const expectedSubscriptionIds = subscriptions.map(
    (subscription) => subscription.id
  );
  const pendingSubscriptionIds = expectedSubscriptionIds.filter(
    (id) => !readySubscriptionIds.includes(id)
  );
  return {
    channelPhase:
      pendingSubscriptionIds.length === 0 ? 'live' : 'bootstrapping',
    progressPercent:
      expectedSubscriptionIds.length === 0
        ? 0
        : Math.round(
            (readySubscriptionIds.length / expectedSubscriptionIds.length) * 100
          ),
    isBootstrapping: pendingSubscriptionIds.length > 0,
    criticalReady: pendingSubscriptionIds.length === 0,
    interactiveReady: pendingSubscriptionIds.length === 0,
    complete: pendingSubscriptionIds.length === 0 && subscriptions.length > 0,
    activePhase: subscriptions.length === 0 ? null : 0,
    expectedSubscriptionIds,
    readySubscriptionIds,
    pendingSubscriptionIds,
    subscriptions: subscriptions.map((subscription) => ({
      id: subscription.id,
      table: subscription.table,
      expected: true,
      ready: subscription.ready,
      status: subscription.status,
      phase: subscription.phase,
      progressPercent: subscription.progressPercent,
      cursor: subscription.cursor,
      bootstrapState: subscription.bootstrapState,
      bootstrapPhase: subscription.bootstrapPhase,
    })),
    phases: [],
  };
}

function diagnostic(
  options: Partial<SyncularDiagnosticEvent> & { code: string; message: string }
): SyncularDiagnosticEvent {
  return {
    at: 42,
    level: 'error',
    source: 'sync',
    code: options.code,
    message: options.message,
    ...(options.level ? { level: options.level } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.subscriptionId
      ? { subscriptionId: options.subscriptionId }
      : {}),
    ...(options.table ? { table: options.table } : {}),
  };
}

function status(
  options: Partial<SyncularClientStatus['lifecycle']>
): SyncularClientStatus {
  return {
    lifecycle: {
      phase: 'complete',
      realtime: 'connected',
      online: true,
      requiresAction: false,
      pendingRequests: 0,
      ...options,
    },
    connection: {
      closed: false,
      pendingRequests: 0,
      realtime: 'connected',
    },
    outbox: null,
    conflicts: null,
    isConnected: true,
    isSyncing: false,
    hasPendingMutations: false,
    hasConflicts: false,
    requiresAction: options.requiresAction ?? false,
  };
}
