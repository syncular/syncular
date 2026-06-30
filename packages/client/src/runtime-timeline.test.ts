import { describe, expect, it } from 'bun:test';
import type { SyncularClientStatus } from './client';
import {
  getSyncularRuntimeTimeline,
  type SyncularRuntimeTimelineClient,
} from './runtime-timeline';
import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
} from './types';

describe('runtime timeline', () => {
  it('builds ordered state and diagnostic events from a snapshot', async () => {
    const client = timelineClient({
      snapshot: diagnosticSnapshot({
        generatedAt: 1_000,
        recentDiagnostics: [
          diagnosticEvent({
            at: 200,
            code: 'sync.pull_completed',
            message: 'pull completed',
            source: 'sync',
            syncAttemptId: 'attempt-1',
            table: 'tasks',
          }),
          diagnosticEvent({
            at: 100,
            code: 'realtime.connected',
            message: 'socket connected',
            source: 'realtime',
          }),
        ],
      }),
      status: clientStatus({ requiresAction: false }),
    });

    const timeline = await getSyncularRuntimeTimeline(client, {
      now: () => 1_100,
    });

    expect(timeline.generatedAt).toBe(1_100);
    expect(timeline.status).toBe('ok');
    expect(timeline.events.map((event) => event.code)).toEqual([
      'realtime.connected',
      'sync.pull_completed',
      'runtime.snapshot',
      'lifecycle.current',
      'bootstrap.current',
      'outbox.current',
      'conflict.current',
      'blob.uploads.current',
    ]);
    expect(timeline.summary).toMatchObject({
      eventCount: 8,
      errorCount: 0,
      warningCount: 0,
      syncAttemptIds: ['attempt-1'],
      affectedTables: ['tasks'],
      requiresAction: false,
    });
    expect(
      timeline.events.find((event) => event.code === 'runtime.snapshot')
    ).toMatchObject({
      details: {
        packageName: '@syncular/client',
        packageVersion: '1.2.3',
        storage: 'opfsSahPool',
        rustFeatureCount: 1,
        realtime: 'connected',
      },
    });
  });

  it('redacts sensitive details and summarizes payload-shaped details', async () => {
    const client = timelineClient({
      snapshot: diagnosticSnapshot({
        recentDiagnostics: [
          diagnosticEvent({
            code: 'sync.bootstrap_failed',
            level: 'error',
            message: 'bootstrap failed',
            source: 'sync',
            details: {
              authorization: 'Bearer very-secret',
              bootstrap: bootstrapStatus(),
              changedRows: [{ table: 'tasks', rowId: 'task-1' }],
              changedTables: ['tasks', 'projects'],
              message: 'x'.repeat(220),
              url: 'https://example.com/signed-url',
            },
          }),
        ],
      }),
      status: clientStatus({ requiresAction: true }),
    });

    const timeline = await getSyncularRuntimeTimeline(client, {
      includeStateEvents: false,
    });

    const event = timeline.events[0];
    expect(event).toMatchObject({
      phase: 'bootstrap',
      level: 'error',
      details: {
        authorization: '[redacted]',
        bootstrap: {
          complete: true,
          expectedSubscriptionCount: 1,
          readySubscriptionCount: 1,
        },
        changedTables: ['tasks', 'projects'],
        url: '[redacted]',
      },
    });
    expect(event?.details?.changedRows).toBeUndefined();
    expect(String(event?.details?.message)).toHaveLength(160);
    expect(timeline.status).toBe('action-required');
    expect(timeline.summary.lastError).toMatchObject({
      code: 'sync.bootstrap_failed',
      phase: 'bootstrap',
    });
  });

  it('classifies phases and limits to the newest events', async () => {
    const client = timelineClient({
      snapshot: diagnosticSnapshot({
        recentDiagnostics: [
          diagnosticEvent({
            at: 1,
            code: 'storage.opened',
            source: 'storage',
          }),
          diagnosticEvent({
            at: 2,
            code: 'sync.local_visibility_timeout',
            source: 'sync',
          }),
          diagnosticEvent({
            at: 3,
            code: 'blob.forbidden',
            source: 'blob',
          }),
          diagnosticEvent({
            at: 4,
            code: 'sync.scope_revoked',
            level: 'warn',
            source: 'sync',
            subscriptionId: 'sub-a',
          }),
          diagnosticEvent({
            at: 5,
            code: 'conflict.detected',
            source: 'sync',
          }),
        ],
      }),
    });

    const timeline = await getSyncularRuntimeTimeline(client, {
      includeStateEvents: false,
      maxEvents: 4,
    });

    expect(timeline.events.map((event) => [event.code, event.phase])).toEqual([
      ['sync.local_visibility_timeout', 'local-apply'],
      ['blob.forbidden', 'blob'],
      ['sync.scope_revoked', 'auth'],
      ['conflict.detected', 'conflict'],
    ]);
    expect(timeline.summary.subscriptionIds).toEqual(['sub-a']);
    expect(timeline.status).toBe('warning');
  });

  it('promotes realtime detail cursors into timeline cursor evidence', async () => {
    const client = timelineClient({
      snapshot: diagnosticSnapshot({
        recentDiagnostics: [
          diagnosticEvent({
            code: 'realtime.pull_required',
            source: 'realtime',
            details: {
              cursor: 42,
              reason: 'payload-too-large',
            },
          }),
        ],
      }),
    });

    const timeline = await getSyncularRuntimeTimeline(client, {
      includeStateEvents: false,
    });

    expect(timeline.events[0]).toMatchObject({
      code: 'realtime.pull_required',
      phase: 'realtime',
      cursor: 42,
      details: {
        cursor: 42,
        reason: 'payload-too-large',
      },
    });
  });
});

function timelineClient(args: {
  snapshot?: SyncularDiagnosticSnapshot;
  status?: SyncularClientStatus;
}): SyncularRuntimeTimelineClient {
  return {
    async diagnosticSnapshot() {
      return args.snapshot ?? diagnosticSnapshot();
    },
    getStatus() {
      return args.status ?? clientStatus();
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
      wasmGlueUrl: 'https://example.com/syncular.js',
      wasmUrl: 'https://example.com/syncular_bg.wasm',
      rust: {
        crateName: 'syncular-runtime',
        crateVersion: '1.2.3',
        features: ['web-owned-sqlite-core'],
        schemaVersion: 7,
      },
    },
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
