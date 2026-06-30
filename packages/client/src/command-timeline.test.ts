import { describe, expect, it } from 'bun:test';
import type { SyncularClientStatus } from './client';
import {
  getSyncularCommandTimeline,
  type SyncularCommandTimelineClient,
} from './command-timeline';
import type {
  SyncularConflictSummary,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularLocalSupportBundle,
} from './types';

describe('command timeline', () => {
  it('links a mutation receipt to tracked state and matched runtime events', async () => {
    const client = commandTimelineClient({
      localSupportBundle: localSupportBundle({
        outboxCommits: [
          {
            outboxId: 'outbox-a',
            clientCommitId: 'commit-a',
            schemaVersion: 3,
            status: 'acked',
            ackedCommitSeq: 42,
          },
        ],
      }),
      snapshot: diagnosticSnapshot({
        recentDiagnostics: [
          diagnosticEvent({
            at: 100,
            code: 'outbox.enqueued',
            details: {
              clientCommitId: 'commit-a',
              commandId: 'cmd-a',
              outboxSeq: 7,
            },
            source: 'sync',
          }),
          diagnosticEvent({
            at: 200,
            code: 'sync.syncPush.completed',
            details: {
              clientCommitId: 'commit-a',
              commitSeq: 42,
              pushedCommits: 1,
              reason: 'manual',
            },
            source: 'sync',
            syncAttemptId: 'attempt-a',
            traceId: 'trace-a',
            spanId: 'span-a',
          }),
          diagnosticEvent({
            at: 300,
            code: 'realtime.event_received',
            cursor: 42,
            details: {
              clientCommitId: 'commit-a',
            },
            source: 'realtime',
          }),
        ],
      }),
    });

    const timeline = await getSyncularCommandTimeline(client, {
      command: {
        clientCommitId: 'commit-a',
        commandId: 'cmd-a',
        label: 'Create task',
      },
      localVisibility: {
        state: 'visible',
        at: 350,
      },
      now: () => 500,
    });

    expect(timeline).toMatchObject({
      clientCommitId: 'commit-a',
      commandId: 'cmd-a',
      label: 'Create task',
      state: 'acked',
      summary: {
        state: 'acked',
        requiresAction: false,
        matchedEventCount: 3,
        contextEventCount: 0,
        syncAttemptIds: ['attempt-a'],
        traceIds: ['trace-a'],
        spanIds: ['span-a'],
        missingEvidence: [],
      },
    });
    expect(
      timeline.events.map((event) => [event.relation, event.code])
    ).toEqual([
      ['synthetic', 'command.receipt'],
      ['synthetic', 'local_apply.outbox_persisted'],
      ['matched', 'outbox.enqueued'],
      ['matched', 'sync.syncPush.completed'],
      ['matched', 'realtime.event_received'],
      ['synthetic', 'local_visibility.visible'],
    ]);
    expect(timeline.trackedCommit.outbox).toEqual({
      outboxId: 'outbox-a',
      ackedCommitSeq: 42,
      schemaVersion: 3,
      status: 'acked',
    });
    expect(timeline.events[0]?.details).toMatchObject({
      clientCommitId: 'commit-a',
      outboxId: 'outbox-a',
      commitSeq: 42,
      outboxStatus: 'acked',
    });
    expect(timeline.events[1]).toMatchObject({
      phase: 'local-apply',
      relation: 'synthetic',
      code: 'local_apply.outbox_persisted',
      details: {
        clientCommitId: 'commit-a',
        outboxId: 'outbox-a',
        commitSeq: 42,
        outboxStatus: 'acked',
      },
    });
  });

  it('uses redacted outbox ack evidence as the server commit sequence link', async () => {
    const client = commandTimelineClient({
      localSupportBundle: localSupportBundle({
        outboxCommits: [
          {
            outboxId: 'outbox-acked',
            clientCommitId: 'commit-acked',
            schemaVersion: 3,
            status: 'acked',
            ackedCommitSeq: 88,
          },
        ],
      }),
    });

    const timeline = await getSyncularCommandTimeline(client, {
      command: 'commit-acked',
      now: () => 500,
      includeRuntimeContext: false,
    });

    expect(timeline.trackedCommit.outbox).toEqual({
      outboxId: 'outbox-acked',
      ackedCommitSeq: 88,
      schemaVersion: 3,
      status: 'acked',
    });
    expect(timeline.events[0]?.details).toMatchObject({
      outboxId: 'outbox-acked',
      commitSeq: 88,
      outboxStatus: 'acked',
    });
    expect(timeline.summary.missingEvidence).not.toContain('outbox-sequence');
    expect(timeline.summary.missingEvidence).not.toContain(
      'server-commit-sequence'
    );
    expect(timeline.summary.missingEvidence).not.toContain('local-apply');
  });

  it('uses runtime context and names missing evidence when exact links are unavailable', async () => {
    const client = commandTimelineClient({
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
            at: 100,
            code: 'sync.syncOnce.completed',
            details: {
              pushedCommits: 1,
              requestType: 'syncOnce',
            },
            source: 'sync',
            syncAttemptId: 'attempt-context',
            traceId: 'trace-context',
          }),
        ],
      }),
    });

    const timeline = await getSyncularCommandTimeline(client, {
      command: 'commit-missing',
      now: () => 500,
    });

    expect(timeline).toMatchObject({
      clientCommitId: 'commit-missing',
      state: 'unknown',
      summary: {
        requiresAction: true,
        matchedEventCount: 0,
        contextEventCount: 3,
        syncAttemptIds: ['attempt-context'],
        missingEvidence: [
          'outbox-status',
          'outbox-sequence',
          'server-commit-sequence',
          'realtime-event-cursor',
          'pull-reason',
          'local-apply',
          'local-visibility',
        ],
      },
    });
    expect(timeline.events.some((event) => event.relation === 'context')).toBe(
      true
    );
  });
});

function commandTimelineClient(args: {
  snapshot?: SyncularDiagnosticSnapshot;
  status?: SyncularClientStatus;
  conflicts?: SyncularConflictSummary[];
  localSupportBundle?: SyncularLocalSupportBundle;
}): SyncularCommandTimelineClient {
  return {
    async diagnosticSnapshot() {
      return args.snapshot ?? diagnosticSnapshot();
    },
    getStatus() {
      return args.status ?? clientStatus();
    },
    async listConflicts() {
      return args.conflicts ?? [];
    },
    async exportLocalSupportBundle() {
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
