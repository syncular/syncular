import type { SyncularClientStatus } from './client';
import type { SyncularLocalVisibilityEvidence } from './local-visibility';
import {
  getSyncularMutationStatus,
  type SyncularMutationStatus,
  type SyncularMutationStatusClient,
  type SyncularMutationStatusOptions,
  type SyncularMutationTrackedCommitReference,
  type SyncularTrackedMutationCommit,
  type SyncularTrackedMutationState,
} from './mutation-status';
import {
  getSyncularRuntimeTimeline,
  type SyncularRuntimeTimeline,
  type SyncularRuntimeTimelineClient,
  type SyncularRuntimeTimelineEvent,
  type SyncularRuntimeTimelineOptions,
  type SyncularRuntimeTimelinePhase,
} from './runtime-timeline';
import type { SyncularDiagnosticSnapshot } from './types';

const DEFAULT_MAX_CONTEXT_EVENTS = 12;

export type SyncularCommandTimelinePhase =
  | 'command'
  | 'visibility'
  | SyncularRuntimeTimelinePhase;

export type SyncularCommandTimelineEventRelation =
  | 'synthetic'
  | 'matched'
  | 'context';

export type SyncularCommandTimelineMissingEvidence =
  | 'outbox-status'
  | 'outbox-sequence'
  | 'push-request-id'
  | 'sync-attempt'
  | 'server-commit-sequence'
  | 'realtime-event-cursor'
  | 'pull-reason'
  | 'local-apply'
  | 'local-visibility';

export type SyncularCommandTimelineVisibilityState =
  | 'not-requested'
  | 'pending'
  | 'visible'
  | 'timed-out'
  | 'failed';

export interface SyncularCommandTimelineClient
  extends SyncularMutationStatusClient,
    SyncularRuntimeTimelineClient {
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
}

export type SyncularCommandTimelineVisibilityEvidence =
  SyncularLocalVisibilityEvidence;

export interface SyncularCommandTimelineOptions {
  command: SyncularMutationTrackedCommitReference;
  now?: () => number;
  maxContextEvents?: number;
  includeRuntimeContext?: boolean;
  mutationStatusOptions?: Omit<
    SyncularMutationStatusOptions,
    'now' | 'trackCommits'
  >;
  runtimeTimelineOptions?: Omit<SyncularRuntimeTimelineOptions, 'now'>;
  localVisibility?: SyncularCommandTimelineVisibilityEvidence;
}

export interface SyncularCommandTimelineEvent {
  at: number;
  phase: SyncularCommandTimelinePhase;
  relation: SyncularCommandTimelineEventRelation;
  level: SyncularRuntimeTimelineEvent['level'];
  code: string;
  message: string;
  requestId?: string;
  syncAttemptId?: string;
  traceId?: string;
  spanId?: string;
  table?: string;
  rowId?: string;
  cursor?: number | string | null;
  details?: Record<string, unknown>;
}

export interface SyncularCommandTimelineSummary {
  state: SyncularTrackedMutationState;
  requiresAction: boolean;
  proof: SyncularCommandTimelineProof;
  matchedEventCount: number;
  contextEventCount: number;
  requestIds: string[];
  syncAttemptIds: string[];
  traceIds: string[];
  spanIds: string[];
  missingEvidence: SyncularCommandTimelineMissingEvidence[];
}

export interface SyncularCommandTimelineProof {
  outboxPersisted: boolean;
  requestCorrelated: boolean;
  syncAttemptObserved: boolean;
  serverCommitObserved: boolean;
  realtimeCursorObserved: boolean;
  pullReasonObserved: boolean;
  localApplyObserved: boolean;
  localVisibilityObserved: boolean;
  complete: boolean;
}

export interface SyncularCommandTimeline {
  generatedAt: number;
  clientCommitId: string;
  commitId?: string;
  commandId?: string;
  label?: string;
  state: SyncularTrackedMutationState;
  summary: SyncularCommandTimelineSummary;
  trackedCommit: SyncularTrackedMutationCommit;
  mutationStatus: Pick<
    SyncularMutationStatus,
    'state' | 'requiresAction' | 'trackedCommitsUnavailable'
  >;
  events: SyncularCommandTimelineEvent[];
  runtimeTimeline: Pick<SyncularRuntimeTimeline, 'status' | 'summary'>;
}

export async function getSyncularCommandTimeline(
  client: SyncularCommandTimelineClient,
  options: SyncularCommandTimelineOptions
): Promise<SyncularCommandTimeline> {
  const command = normalizeCommandReference(options.command);
  const generatedAt = options.now?.() ?? Date.now();
  const [mutationStatus, runtimeTimeline] = await Promise.all([
    getSyncularMutationStatus(client, {
      ...options.mutationStatusOptions,
      now: () => generatedAt,
      trackCommits: [options.command],
    }),
    getSyncularRuntimeTimeline(client, {
      ...options.runtimeTimelineOptions,
      now: () => generatedAt,
    }),
  ]);
  const trackedCommit =
    mutationStatus.trackedCommits[0] ??
    unknownTrackedCommit(command.clientCommitId);
  const runtimeEvents = commandRuntimeEvents(runtimeTimeline, command, options);
  const events = [
    commandReceiptEvent(generatedAt, command, trackedCommit),
    ...(trackedCommit.outbox
      ? [localApplyEvidenceEvent(generatedAt, command, trackedCommit)]
      : []),
    ...runtimeEvents,
    ...(options.localVisibility
      ? [localVisibilityEvent(generatedAt, options.localVisibility)]
      : []),
  ];
  const summary = summarizeCommandTimeline({
    trackedCommit,
    runtimeEvents,
    localVisibility: options.localVisibility,
  });

  return {
    generatedAt,
    clientCommitId: command.clientCommitId,
    ...(command.commitId ? { commitId: command.commitId } : {}),
    ...(command.commandId ? { commandId: command.commandId } : {}),
    ...(command.label ? { label: command.label } : {}),
    state: trackedCommit.state,
    summary,
    trackedCommit,
    mutationStatus: {
      state: mutationStatus.state,
      requiresAction: mutationStatus.requiresAction,
      ...(mutationStatus.trackedCommitsUnavailable
        ? {
            trackedCommitsUnavailable: mutationStatus.trackedCommitsUnavailable,
          }
        : {}),
    },
    events,
    runtimeTimeline: {
      status: runtimeTimeline.status,
      summary: runtimeTimeline.summary,
    },
  };
}

function normalizeCommandReference(
  reference: SyncularMutationTrackedCommitReference
): {
  clientCommitId: string;
  commitId?: string;
  commandId?: string;
  label?: string;
} {
  if (typeof reference === 'string') {
    return { clientCommitId: reference };
  }
  const clientCommitId = reference.clientCommitId ?? reference.commitId;
  if (!clientCommitId) {
    throw new Error(
      'Syncular command timeline requires a clientCommitId or commitId.'
    );
  }
  return {
    clientCommitId,
    ...(reference.commitId ? { commitId: reference.commitId } : {}),
    ...(reference.commandId ? { commandId: reference.commandId } : {}),
    ...(reference.label ? { label: reference.label } : {}),
  };
}

function commandRuntimeEvents(
  timeline: SyncularRuntimeTimeline,
  command: {
    clientCommitId: string;
    commitId?: string;
    commandId?: string;
  },
  options: SyncularCommandTimelineOptions
): SyncularCommandTimelineEvent[] {
  const matched = timeline.events
    .filter((event) => eventMatchesCommand(event, command))
    .map((event) => commandEventFromRuntime(event, 'matched'));
  if (matched.length > 0 || options.includeRuntimeContext === false) {
    return matched;
  }
  return timeline.events
    .filter(isCommandContextEvent)
    .slice(-normalizeMaxContextEvents(options.maxContextEvents))
    .map((event) => commandEventFromRuntime(event, 'context'));
}

function eventMatchesCommand(
  event: SyncularRuntimeTimelineEvent,
  command: {
    clientCommitId: string;
    commitId?: string;
    commandId?: string;
  }
): boolean {
  return (
    detailEquals(event, 'clientCommitId', command.clientCommitId) ||
    detailEquals(
      event,
      'commitId',
      command.commitId ?? command.clientCommitId
    ) ||
    detailEquals(event, 'commandId', command.commandId)
  );
}

function detailEquals(
  event: SyncularRuntimeTimelineEvent,
  key: string,
  expected: string | undefined
): boolean {
  if (!expected) return false;
  return event.details?.[key] === expected;
}

function isCommandContextEvent(event: SyncularRuntimeTimelineEvent): boolean {
  return (
    event.phase === 'sync' ||
    event.phase === 'outbox' ||
    event.phase === 'conflict' ||
    event.phase === 'local-apply' ||
    event.phase === 'realtime'
  );
}

function commandReceiptEvent(
  generatedAt: number,
  command: {
    clientCommitId: string;
    commandId?: string;
  },
  trackedCommit: SyncularTrackedMutationCommit
): SyncularCommandTimelineEvent {
  return {
    at: generatedAt,
    phase: 'command',
    relation: 'synthetic',
    level: trackedCommit.state === 'unknown' ? 'warn' : 'info',
    code: 'command.receipt',
    message: 'Syncular mutation receipt captured.',
    details: {
      clientCommitId: command.clientCommitId,
      ...(command.commandId ? { commandId: command.commandId } : {}),
      state: trackedCommit.state,
      evidence: trackedCommit.evidence,
      ...(trackedCommit.outbox
        ? {
            outboxStatus: trackedCommit.outbox.status,
            outboxSchemaVersion: trackedCommit.outbox.schemaVersion,
            ...(trackedCommit.outbox.outboxId
              ? { outboxId: trackedCommit.outbox.outboxId }
              : {}),
            ...(trackedCommit.outbox.ackedCommitSeq != null
              ? { commitSeq: trackedCommit.outbox.ackedCommitSeq }
              : {}),
          }
        : {}),
    },
  };
}

function localVisibilityEvent(
  generatedAt: number,
  visibility: SyncularCommandTimelineVisibilityEvidence
): SyncularCommandTimelineEvent {
  const failed =
    visibility.state === 'failed' || visibility.state === 'timed-out';
  return {
    at: visibility.at ?? generatedAt,
    phase: 'visibility',
    relation: 'synthetic',
    level: failed ? 'warn' : 'info',
    code: `local_visibility.${visibility.state}`,
    message:
      visibility.message ??
      `Syncular local visibility was reported as ${visibility.state}.`,
    ...(visibility.details ? { details: visibility.details } : {}),
  };
}

function localApplyEvidenceEvent(
  generatedAt: number,
  command: {
    clientCommitId: string;
    commandId?: string;
  },
  trackedCommit: SyncularTrackedMutationCommit
): SyncularCommandTimelineEvent {
  const outbox = trackedCommit.outbox;
  return {
    at: generatedAt,
    phase: 'local-apply',
    relation: 'synthetic',
    level: 'info',
    code: 'local_apply.outbox_persisted',
    message:
      'Syncular mutation receipt has redacted local outbox evidence, proving the command was durably accepted locally.',
    details: {
      clientCommitId: command.clientCommitId,
      ...(command.commandId ? { commandId: command.commandId } : {}),
      ...(outbox?.outboxId ? { outboxId: outbox.outboxId } : {}),
      outboxStatus: outbox?.status,
      outboxSchemaVersion: outbox?.schemaVersion,
      ...(outbox?.ackedCommitSeq != null
        ? { commitSeq: outbox.ackedCommitSeq }
        : {}),
    },
  };
}

function commandEventFromRuntime(
  event: SyncularRuntimeTimelineEvent,
  relation: Exclude<SyncularCommandTimelineEventRelation, 'synthetic'>
): SyncularCommandTimelineEvent {
  return {
    at: event.at,
    phase: event.phase,
    relation,
    level: event.level,
    code: event.code,
    message: event.message,
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.syncAttemptId ? { syncAttemptId: event.syncAttemptId } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
    ...(event.table ? { table: event.table } : {}),
    ...(event.rowId ? { rowId: event.rowId } : {}),
    ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
    ...(event.details ? { details: event.details } : {}),
  };
}

function summarizeCommandTimeline(args: {
  trackedCommit: SyncularTrackedMutationCommit;
  runtimeEvents: readonly SyncularCommandTimelineEvent[];
  localVisibility: SyncularCommandTimelineVisibilityEvidence | undefined;
}): SyncularCommandTimelineSummary {
  const missingEvidence = missingCommandEvidence(args);
  const proof = commandProof(args);
  return {
    state: args.trackedCommit.state,
    requiresAction: trackedCommitRequiresAction(args.trackedCommit),
    proof: {
      ...proof,
      complete: missingEvidence.length === 0,
    },
    matchedEventCount: args.runtimeEvents.filter(
      (event) => event.relation === 'matched'
    ).length,
    contextEventCount: args.runtimeEvents.filter(
      (event) => event.relation === 'context'
    ).length,
    requestIds: uniqueSorted(
      args.runtimeEvents
        .map((event) => event.requestId)
        .filter((value): value is string => Boolean(value))
    ),
    syncAttemptIds: uniqueSorted(
      args.runtimeEvents
        .map((event) => event.syncAttemptId)
        .filter((value): value is string => Boolean(value))
    ),
    traceIds: uniqueSorted(
      args.runtimeEvents
        .map((event) => event.traceId)
        .filter((value): value is string => Boolean(value))
    ),
    spanIds: uniqueSorted(
      args.runtimeEvents
        .map((event) => event.spanId)
        .filter((value): value is string => Boolean(value))
    ),
    missingEvidence,
  };
}

function commandProof(args: {
  trackedCommit: SyncularTrackedMutationCommit;
  runtimeEvents: readonly SyncularCommandTimelineEvent[];
  localVisibility: SyncularCommandTimelineVisibilityEvidence | undefined;
}): Omit<SyncularCommandTimelineProof, 'complete'> {
  const outboxPersisted =
    Boolean(args.trackedCommit.outbox) ||
    eventsHaveDetail(args.runtimeEvents, 'outboxSeq') ||
    eventsHaveDetail(args.runtimeEvents, 'outboxId');
  const localApplyObserved =
    Boolean(args.trackedCommit.outbox) ||
    args.runtimeEvents.some((event) => event.phase === 'local-apply');
  return {
    outboxPersisted,
    requestCorrelated: args.runtimeEvents.some((event) =>
      Boolean(event.requestId)
    ),
    syncAttemptObserved: args.runtimeEvents.some((event) =>
      Boolean(event.syncAttemptId || event.traceId)
    ),
    serverCommitObserved:
      args.trackedCommit.outbox?.ackedCommitSeq != null ||
      eventsHaveDetail(args.runtimeEvents, 'commitSeq'),
    realtimeCursorObserved: args.runtimeEvents.some(
      (event) => event.phase === 'realtime' && event.cursor != null
    ),
    pullReasonObserved: eventsHavePullReason(args.runtimeEvents),
    localApplyObserved,
    localVisibilityObserved: args.localVisibility?.state === 'visible',
  };
}

function missingCommandEvidence(args: {
  trackedCommit: SyncularTrackedMutationCommit;
  runtimeEvents: readonly SyncularCommandTimelineEvent[];
  localVisibility: SyncularCommandTimelineVisibilityEvidence | undefined;
}): SyncularCommandTimelineMissingEvidence[] {
  const missing: SyncularCommandTimelineMissingEvidence[] = [];
  if (!args.trackedCommit.outbox) missing.push('outbox-status');
  if (
    !args.trackedCommit.outbox?.outboxId &&
    !eventsHaveDetail(args.runtimeEvents, 'outboxSeq') &&
    !eventsHaveDetail(args.runtimeEvents, 'outboxId')
  ) {
    missing.push('outbox-sequence');
  }
  if (
    !args.runtimeEvents.some((event) => event.syncAttemptId || event.traceId)
  ) {
    missing.push('sync-attempt');
  }
  if (!args.runtimeEvents.some((event) => event.requestId)) {
    missing.push('push-request-id');
  }
  if (
    args.trackedCommit.outbox?.ackedCommitSeq == null &&
    !eventsHaveDetail(args.runtimeEvents, 'commitSeq')
  ) {
    missing.push('server-commit-sequence');
  }
  if (
    !args.runtimeEvents.some(
      (event) => event.phase === 'realtime' && event.cursor != null
    )
  ) {
    missing.push('realtime-event-cursor');
  }
  if (!eventsHavePullReason(args.runtimeEvents)) {
    missing.push('pull-reason');
  }
  if (
    !args.trackedCommit.outbox &&
    !args.runtimeEvents.some((event) => event.phase === 'local-apply')
  ) {
    missing.push('local-apply');
  }
  if (!args.localVisibility || args.localVisibility.state !== 'visible') {
    missing.push('local-visibility');
  }
  return missing;
}

function eventsHaveDetail(
  events: readonly SyncularCommandTimelineEvent[],
  key: string
): boolean {
  return events.some((event) => event.details?.[key] != null);
}

function eventsHavePullReason(
  events: readonly SyncularCommandTimelineEvent[]
): boolean {
  return events.some((event) => {
    if (event.details?.reason != null || event.details?.pullReason != null) {
      return true;
    }
    return (
      event.phase === 'sync' &&
      typeof event.details?.requestType === 'string' &&
      (event.details.requestType === 'syncPull' ||
        event.details.requestType === 'syncOnce')
    );
  });
}

function trackedCommitRequiresAction(
  trackedCommit: SyncularTrackedMutationCommit
): boolean {
  return trackedCommit.recommendedActions.some((action) =>
    [
      'retry-sync',
      'resolve-conflicts',
      'refresh-auth',
      'inspect-diagnostics',
    ].includes(action.action)
  );
}

function unknownTrackedCommit(
  clientCommitId: string
): SyncularTrackedMutationCommit {
  return {
    clientCommitId,
    state: 'unknown',
    evidence: ['none'],
    recommendedActions: [
      {
        action: 'inspect-diagnostics',
        reasonCodes: ['tracked_commit.unknown'],
        message:
          'This mutation receipt was not found in redacted outbox or conflict records.',
      },
    ],
  };
}

function normalizeMaxContextEvents(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONTEXT_EVENTS;
  return Math.max(0, Math.floor(value as number));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
