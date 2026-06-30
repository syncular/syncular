import type { SyncularClientStatus } from './client';
import { classifySyncularDiagnosticDetailKey } from './console-diagnostics';
import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularDiagnosticLevel,
  SyncularDiagnosticSnapshot,
} from './types';

const DEFAULT_MAX_EVENTS = 80;
const MAX_MESSAGE_LENGTH = 240;
const MAX_STRING_DETAIL_LENGTH = 160;
const MAX_ARRAY_DETAIL_ITEMS = 8;
const MAX_OBJECT_DETAIL_KEYS = 8;

export type SyncularRuntimeTimelinePhase =
  | 'runtime'
  | 'storage'
  | 'schema'
  | 'bootstrap'
  | 'sync'
  | 'auth'
  | 'realtime'
  | 'outbox'
  | 'blob'
  | 'conflict'
  | 'local-apply'
  | 'lifecycle'
  | 'error'
  | 'unknown';

export type SyncularRuntimeTimelineStatus =
  | 'ok'
  | 'warning'
  | 'action-required';

export interface SyncularRuntimeTimelineClient {
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
}

export interface SyncularRuntimeTimelineOptions {
  maxEvents?: number;
  now?: () => number;
  includeStateEvents?: boolean;
  includeDetails?: boolean;
}

export interface SyncularRuntimeTimelineEvent {
  at: number;
  phase: SyncularRuntimeTimelinePhase;
  level: SyncularDiagnosticLevel;
  source: string;
  code: string;
  message: string;
  syncAttemptId?: string;
  traceId?: string;
  spanId?: string;
  subscriptionId?: string;
  table?: string;
  rowId?: string;
  cursor?: number | string | null;
  details?: Record<string, unknown>;
}

export interface SyncularRuntimeTimelineSummary {
  eventCount: number;
  errorCount: number;
  warningCount: number;
  syncAttemptIds: string[];
  affectedTables: string[];
  subscriptionIds: string[];
  requiresAction: boolean;
  lastError?: {
    at: number;
    code: string;
    message: string;
    phase: SyncularRuntimeTimelinePhase;
  };
}

export interface SyncularRuntimeTimeline {
  generatedAt: number;
  status: SyncularRuntimeTimelineStatus;
  requiresAction: boolean;
  summary: SyncularRuntimeTimelineSummary;
  events: SyncularRuntimeTimelineEvent[];
}

export async function getSyncularRuntimeTimeline(
  client: SyncularRuntimeTimelineClient,
  options: SyncularRuntimeTimelineOptions = {}
): Promise<SyncularRuntimeTimeline> {
  const snapshot = await client.diagnosticSnapshot();
  const status = client.getStatus?.();
  const generatedAt = options.now?.() ?? snapshot.generatedAt;
  const includeStateEvents = options.includeStateEvents !== false;
  const includeDetails = options.includeDetails !== false;
  const events = [
    ...(includeStateEvents
      ? stateEventsForSnapshot(snapshot, status, generatedAt)
      : []),
    ...snapshot.recentDiagnostics.map((event) =>
      timelineEventFromDiagnostic(event, includeDetails)
    ),
  ];
  const orderedEvents = limitEvents(sortTimelineEvents(events), options);
  const summary = summarizeTimeline(orderedEvents, status);
  const timelineStatus = summarizeTimelineStatus(summary);

  return {
    generatedAt,
    status: timelineStatus,
    requiresAction: summary.requiresAction,
    summary,
    events: orderedEvents,
  };
}

function stateEventsForSnapshot(
  snapshot: SyncularDiagnosticSnapshot,
  status: SyncularClientStatus | undefined,
  now: number | undefined
): SyncularRuntimeTimelineEvent[] {
  const at = now ?? snapshot.generatedAt;
  const events: SyncularRuntimeTimelineEvent[] = [
    {
      at,
      phase: 'runtime',
      level: 'info',
      source: 'client',
      code: 'runtime.snapshot',
      message: 'Syncular runtime snapshot captured.',
      details: compactRuntimeDetails(snapshot),
    },
    {
      at,
      phase: 'lifecycle',
      level: status?.requiresAction ? 'warn' : 'info',
      source: 'client',
      code: 'lifecycle.current',
      message: 'Current Syncular lifecycle state captured.',
      details: compactLifecycleDetails(snapshot, status),
    },
  ];

  if (snapshot.bootstrap) {
    events.push(bootstrapStateEvent(snapshot.bootstrap, at));
  }
  if (snapshot.outboxStats) {
    events.push({
      at,
      phase: 'outbox',
      level: snapshot.outboxStats.failed > 0 ? 'warn' : 'info',
      source: 'client',
      code: 'outbox.current',
      message: 'Current Syncular outbox state captured.',
      details: { ...snapshot.outboxStats },
    });
  }
  if (snapshot.conflictStats) {
    events.push({
      at,
      phase: 'conflict',
      level: snapshot.conflictStats.unresolved > 0 ? 'warn' : 'info',
      source: 'client',
      code: 'conflict.current',
      message: 'Current Syncular conflict state captured.',
      details: { ...snapshot.conflictStats },
    });
  }
  if (snapshot.blobUploadStats) {
    events.push({
      at,
      phase: 'blob',
      level: snapshot.blobUploadStats.failed > 0 ? 'warn' : 'info',
      source: 'client',
      code: 'blob.uploads.current',
      message: 'Current Syncular blob upload queue captured.',
      details: { ...snapshot.blobUploadStats },
    });
  }

  return events;
}

function compactRuntimeDetails(
  snapshot: SyncularDiagnosticSnapshot
): Record<string, unknown> {
  const { runtime, connection } = snapshot;
  return compactRecord({
    packageName: runtime.packageName,
    packageVersion: runtime.packageVersion,
    workerProtocolVersion: runtime.workerProtocolVersion,
    storage: runtime.storage,
    storageFallbackFrom: runtime.storageFallback?.from,
    storageFallbackTo: runtime.storageFallback?.to,
    storageFallbackReason: runtime.storageFallback?.reason,
    rustCrateName: runtime.rust?.crateName,
    rustCrateVersion: runtime.rust?.crateVersion,
    rustSchemaVersion: runtime.rust?.schemaVersion,
    rustFeatureCount: runtime.rust?.features.length,
    connectionClosed: connection.closed,
    pendingRequests: connection.pendingRequests,
    realtime: connection.realtime,
  });
}

function compactLifecycleDetails(
  snapshot: SyncularDiagnosticSnapshot,
  status: SyncularClientStatus | undefined
): Record<string, unknown> {
  const lifecycle = status?.lifecycle;
  return compactRecord({
    phase: lifecycle?.phase,
    realtime: lifecycle?.realtime ?? snapshot.connection.realtime,
    online: lifecycle?.online,
    requiresAction: status?.requiresAction ?? lifecycle?.requiresAction,
    pendingRequests:
      lifecycle?.pendingRequests ?? snapshot.connection.pendingRequests,
    lastErrorCode:
      lifecycle?.lastError?.code ?? snapshot.connection.lastError?.code,
    lastDiagnosticCode:
      lifecycle?.lastDiagnostic?.code ??
      snapshot.connection.lastDiagnostic?.code,
  });
}

function bootstrapStateEvent(
  bootstrap: SyncularBootstrapStatus,
  at: number
): SyncularRuntimeTimelineEvent {
  return {
    at,
    phase: 'bootstrap',
    level: bootstrap.channelPhase === 'error' ? 'warn' : 'info',
    source: 'client',
    code: 'bootstrap.current',
    message: 'Current Syncular bootstrap state captured.',
    details: summarizeBootstrap(bootstrap),
  };
}

function timelineEventFromDiagnostic(
  event: SyncularDiagnosticEvent,
  includeDetails: boolean
): SyncularRuntimeTimelineEvent {
  const timelineEvent: SyncularRuntimeTimelineEvent = {
    at: event.at,
    phase: classifyTimelinePhase(event),
    level: event.level,
    source: event.source,
    code: event.code,
    message: truncateString(event.message, MAX_MESSAGE_LENGTH),
  };
  if (event.syncAttemptId) timelineEvent.syncAttemptId = event.syncAttemptId;
  if (event.traceId) timelineEvent.traceId = event.traceId;
  if (event.spanId) timelineEvent.spanId = event.spanId;
  if (event.subscriptionId) timelineEvent.subscriptionId = event.subscriptionId;
  if (event.table) timelineEvent.table = event.table;
  if (event.rowId) timelineEvent.rowId = event.rowId;
  const cursor = event.cursor ?? diagnosticDetailCursor(event.details);
  if (cursor !== undefined) timelineEvent.cursor = cursor;
  if (includeDetails && event.details) {
    const details = compactDiagnosticDetails(event.details);
    if (details) timelineEvent.details = details;
  }
  return timelineEvent;
}

function diagnosticDetailCursor(
  details: Record<string, unknown> | undefined
): number | string | null | undefined {
  const cursor = details?.cursor;
  if (
    cursor === null ||
    typeof cursor === 'number' ||
    typeof cursor === 'string'
  ) {
    return cursor;
  }
  return undefined;
}

function classifyTimelinePhase(
  event: Pick<SyncularDiagnosticEvent, 'source' | 'code' | 'level'>
): SyncularRuntimeTimelinePhase {
  const code = event.code.toLowerCase();
  if (code.includes('local_visibility') || code.includes('local-visibility')) {
    return 'local-apply';
  }
  if (code.includes('bootstrap')) return 'bootstrap';
  if (code.includes('schema')) return 'schema';
  if (code.includes('outbox')) return 'outbox';
  if (code.includes('conflict')) return 'conflict';
  if (code.includes('blob')) return 'blob';
  if (code.includes('auth') || code.includes('scope')) return 'auth';
  if (code.includes('realtime') || code.includes('websocket')) {
    return 'realtime';
  }
  if (code.includes('storage') || code.includes('opfs')) return 'storage';
  if (code.includes('runtime') || code.includes('worker')) return 'runtime';

  switch (event.source) {
    case 'auth':
      return 'auth';
    case 'blob':
      return 'blob';
    case 'realtime':
      return 'realtime';
    case 'storage':
      return 'storage';
    case 'sync':
      return 'sync';
    case 'worker':
      return 'runtime';
    case 'client':
      return event.level === 'error' ? 'error' : 'unknown';
  }
}

function compactDiagnosticDetails(
  details: Record<string, unknown>
): Record<string, unknown> | undefined {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const decision = classifySyncularDiagnosticDetailKey(key);
    if (decision === 'omitted') continue;
    if (decision === 'redacted') {
      compacted[key] = '[redacted]';
      continue;
    }
    if (decision === 'summarized') {
      compacted[key] = summarizeBootstrap(value);
      continue;
    }
    const compactedValue = compactDetailValue(value);
    if (compactedValue !== undefined) compacted[key] = compactedValue;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactDetailValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateString(value, MAX_STRING_DETAIL_LENGTH);
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_ARRAY_DETAIL_ITEMS
      ? value.map(compactDetailValue).filter((entry) => entry !== undefined)
      : {
          itemCount: value.length,
          items: value
            .slice(0, MAX_ARRAY_DETAIL_ITEMS)
            .map(compactDetailValue)
            .filter((entry) => entry !== undefined),
        };
  }
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return {
    keyCount: keys.length,
    keys: keys.slice(0, MAX_OBJECT_DETAIL_KEYS),
  };
}

function summarizeBootstrap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const bootstrap = value as Record<string, unknown>;
  return compactRecord({
    channelPhase: bootstrap.channelPhase,
    progressPercent: bootstrap.progressPercent,
    isBootstrapping: bootstrap.isBootstrapping,
    criticalReady: bootstrap.criticalReady,
    interactiveReady: bootstrap.interactiveReady,
    complete: bootstrap.complete,
    activePhase: bootstrap.activePhase,
    expectedSubscriptionCount: countArray(bootstrap.expectedSubscriptionIds),
    readySubscriptionCount: countArray(bootstrap.readySubscriptionIds),
    pendingSubscriptionCount: countArray(bootstrap.pendingSubscriptionIds),
    subscriptionCount: countArray(bootstrap.subscriptions),
    phaseCount: countArray(bootstrap.phases),
  });
}

function sortTimelineEvents(
  events: readonly SyncularRuntimeTimelineEvent[]
): SyncularRuntimeTimelineEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        left.event.at - right.event.at || left.index - right.index
    )
    .map((entry) => entry.event);
}

function limitEvents(
  events: readonly SyncularRuntimeTimelineEvent[],
  options: SyncularRuntimeTimelineOptions
): SyncularRuntimeTimelineEvent[] {
  const maxEvents = normalizeMaxEvents(options.maxEvents);
  if (events.length <= maxEvents) return [...events];
  return events.slice(events.length - maxEvents);
}

function summarizeTimeline(
  events: readonly SyncularRuntimeTimelineEvent[],
  status: SyncularClientStatus | undefined
): SyncularRuntimeTimelineSummary {
  const errorEvents = events.filter((event) => event.level === 'error');
  const warningEvents = events.filter((event) => event.level === 'warn');
  const lastErrorEvent = errorEvents.at(-1);
  const syncAttemptIds = uniqueSorted(
    events
      .map((event) => event.syncAttemptId)
      .filter((value): value is string => Boolean(value))
  );
  const affectedTables = uniqueSorted(
    events.flatMap((event) => collectAffectedTables(event))
  );
  const subscriptionIds = uniqueSorted(
    events
      .map((event) => event.subscriptionId)
      .filter((value): value is string => Boolean(value))
  );
  const requiresAction =
    status?.requiresAction ?? status?.lifecycle.requiresAction ?? false;

  return {
    eventCount: events.length,
    errorCount: errorEvents.length,
    warningCount: warningEvents.length,
    syncAttemptIds,
    affectedTables,
    subscriptionIds,
    requiresAction,
    ...(lastErrorEvent
      ? {
          lastError: {
            at: lastErrorEvent.at,
            code: lastErrorEvent.code,
            message: lastErrorEvent.message,
            phase: lastErrorEvent.phase,
          },
        }
      : {}),
  };
}

function summarizeTimelineStatus(
  summary: SyncularRuntimeTimelineSummary
): SyncularRuntimeTimelineStatus {
  if (summary.requiresAction) return 'action-required';
  if (summary.errorCount > 0 || summary.warningCount > 0) return 'warning';
  return 'ok';
}

function collectAffectedTables(event: SyncularRuntimeTimelineEvent): string[] {
  const tables = new Set<string>();
  if (event.table) tables.add(event.table);
  const detailTable = event.details?.table;
  if (typeof detailTable === 'string') tables.add(detailTable);
  const changedTables = event.details?.changedTables;
  if (Array.isArray(changedTables)) {
    for (const table of changedTables) {
      if (typeof table === 'string') tables.add(table);
    }
  }
  return [...tables];
}

function compactRecord(
  values: Record<string, unknown | undefined>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) record[key] = value;
  }
  return record;
}

function countArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function normalizeMaxEvents(maxEvents: number | undefined): number {
  if (!Number.isFinite(maxEvents)) return DEFAULT_MAX_EVENTS;
  return Math.max(1, Math.floor(maxEvents as number));
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
