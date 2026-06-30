import type { SyncularClientStatus } from './client';
import type {
  SyncularConflictStats,
  SyncularConflictSummary,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularOutboxStats,
} from './types';

const DEFAULT_MAX_CONFLICT_ITEMS = 20;

export type SyncularMutationStatusState =
  | 'idle'
  | 'queued'
  | 'syncing'
  | 'failed'
  | 'conflicted'
  | 'action-required';

export type SyncularMutationStatusRecommendedAction =
  | 'show-pending'
  | 'wait-for-sync'
  | 'retry-sync'
  | 'resolve-conflicts'
  | 'refresh-auth'
  | 'inspect-diagnostics';

export interface SyncularMutationStatusClient {
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
  listConflicts?(): Promise<SyncularConflictSummary[]>;
}

export interface SyncularMutationStatusOptions {
  now?: () => number;
  includeConflictItems?: boolean;
  maxConflictItems?: number;
}

export interface SyncularMutationStatusAction {
  action: SyncularMutationStatusRecommendedAction;
  reasonCodes: string[];
  message: string;
}

export interface SyncularMutationConflictItem {
  id: string;
  clientCommitId: string;
  opIndex: number;
  resultStatus: string;
  code: string | null;
  message: string;
  serverVersion: number | null;
  resolvedAt: number | null;
  resolution: string | null;
  recommendedActions: Array<'retry-local' | 'keep-server' | 'dismiss'>;
}

export interface SyncularMutationStatusSummary {
  queued: number;
  sending: number;
  failed: number;
  acked: number;
  total: number;
  unresolvedConflicts: number;
  resolvedConflicts: number;
  conflictCodes: string[];
  lastError?: {
    code?: string;
    message: string;
    at?: number;
  };
}

export interface SyncularMutationStatus {
  generatedAt: number;
  state: SyncularMutationStatusState;
  requiresAction: boolean;
  outbox: SyncularOutboxStats;
  conflicts: SyncularConflictStats;
  conflictItems: SyncularMutationConflictItem[];
  conflictItemsTruncated: boolean;
  conflictItemsUnavailable?: {
    message: string;
  };
  summary: SyncularMutationStatusSummary;
  recommendedActions: SyncularMutationStatusAction[];
}

export async function getSyncularMutationStatus(
  client: SyncularMutationStatusClient,
  options: SyncularMutationStatusOptions = {}
): Promise<SyncularMutationStatus> {
  const snapshot = await client.diagnosticSnapshot();
  const status = client.getStatus?.();
  const outbox = normalizeOutbox(snapshot.outboxStats ?? status?.outbox);
  const listedConflicts = await listConflictItems(client, options);
  const conflictItems = listedConflicts.items.map(summarizeConflictItem);
  const conflicts = normalizeConflicts({
    stats: snapshot.conflictStats ?? status?.conflicts,
    items: conflictItems,
  });
  const lastError = findLastMutationError(snapshot, status);
  const state = summarizeMutationState({
    outbox,
    conflicts,
    status,
    lastError,
  });
  const summary: SyncularMutationStatusSummary = {
    queued: outbox.pending,
    sending: outbox.sending,
    failed: outbox.failed,
    acked: outbox.acked,
    total: outbox.total,
    unresolvedConflicts: conflicts.unresolved,
    resolvedConflicts: conflicts.resolved,
    conflictCodes: uniqueSorted(
      conflictItems
        .map((conflict) => conflict.code)
        .filter((code): code is string => Boolean(code))
    ),
    ...(lastError ? { lastError } : {}),
  };

  return {
    generatedAt: options.now?.() ?? Date.now(),
    state,
    requiresAction: state === 'action-required' || state === 'conflicted',
    outbox,
    conflicts,
    conflictItems,
    conflictItemsTruncated: listedConflicts.truncated,
    ...(listedConflicts.error
      ? { conflictItemsUnavailable: { message: listedConflicts.error } }
      : {}),
    summary,
    recommendedActions: recommendedActionsForState({
      state,
      outbox,
      conflicts,
      lastError,
      conflictItemsUnavailable: listedConflicts.error != null,
    }),
  };
}

function normalizeOutbox(
  stats: SyncularOutboxStats | null | undefined
): SyncularOutboxStats {
  return {
    pending: stats?.pending ?? 0,
    sending: stats?.sending ?? 0,
    failed: stats?.failed ?? 0,
    acked: stats?.acked ?? 0,
    total: stats?.total ?? 0,
  };
}

function normalizeConflicts(args: {
  stats: SyncularConflictStats | null | undefined;
  items: readonly SyncularMutationConflictItem[];
}): SyncularConflictStats {
  const unresolvedItems = args.items.filter(
    (conflict) => conflict.resolvedAt == null
  ).length;
  const resolvedItems = args.items.filter(
    (conflict) => conflict.resolvedAt != null
  ).length;
  return {
    unresolved: args.stats?.unresolved ?? unresolvedItems,
    resolved: args.stats?.resolved ?? resolvedItems,
    total: args.stats?.total ?? unresolvedItems + resolvedItems,
  };
}

async function listConflictItems(
  client: SyncularMutationStatusClient,
  options: SyncularMutationStatusOptions
): Promise<{
  items: SyncularConflictSummary[];
  truncated: boolean;
  error?: string;
}> {
  if (options.includeConflictItems === false || !client.listConflicts) {
    return { items: [], truncated: false };
  }
  try {
    const conflicts = await client.listConflicts();
    const maxItems = normalizeMaxConflictItems(options.maxConflictItems);
    return {
      items: conflicts.slice(0, maxItems),
      truncated: conflicts.length > maxItems,
    };
  } catch (error) {
    return {
      items: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeConflictItem(
  conflict: SyncularConflictSummary
): SyncularMutationConflictItem {
  return {
    id: conflict.id,
    clientCommitId: conflict.clientCommitId,
    opIndex: conflict.opIndex,
    resultStatus: conflict.resultStatus,
    code: conflict.code,
    message: conflict.message,
    serverVersion: conflict.serverVersion,
    resolvedAt: conflict.resolvedAt,
    resolution: conflict.resolution,
    recommendedActions:
      conflict.resolvedAt == null
        ? ['retry-local', 'keep-server', 'dismiss']
        : [],
  };
}

function summarizeMutationState(args: {
  outbox: SyncularOutboxStats;
  conflicts: SyncularConflictStats;
  status: SyncularClientStatus | undefined;
  lastError: SyncularMutationStatusSummary['lastError'] | undefined;
}): SyncularMutationStatusState {
  if (args.status?.requiresAction || isAuthError(args.lastError?.code)) {
    return 'action-required';
  }
  if (args.conflicts.unresolved > 0) return 'conflicted';
  if (args.outbox.failed > 0) return 'failed';
  if (args.outbox.sending > 0 || args.status?.isSyncing) return 'syncing';
  if (args.outbox.pending > 0) return 'queued';
  return 'idle';
}

function findLastMutationError(
  snapshot: SyncularDiagnosticSnapshot,
  status: SyncularClientStatus | undefined
): SyncularMutationStatusSummary['lastError'] | undefined {
  const statusError =
    status?.lifecycle.lastError ?? snapshot.connection.lastError;
  if (statusError) {
    return {
      code: statusError.code,
      message: statusError.message,
    };
  }
  const event = snapshot.recentDiagnostics
    .filter(isMutationDiagnosticError)
    .at(-1);
  return event
    ? {
        code: event.code,
        message: event.message,
        at: event.at,
      }
    : undefined;
}

function isMutationDiagnosticError(event: SyncularDiagnosticEvent): boolean {
  if (event.level !== 'error') return false;
  const code = event.code.toLowerCase();
  return (
    event.source === 'sync' ||
    code.includes('outbox') ||
    code.includes('conflict') ||
    code.includes('mutation') ||
    code.includes('auth')
  );
}

function recommendedActionsForState(args: {
  state: SyncularMutationStatusState;
  outbox: SyncularOutboxStats;
  conflicts: SyncularConflictStats;
  lastError: SyncularMutationStatusSummary['lastError'] | undefined;
  conflictItemsUnavailable: boolean;
}): SyncularMutationStatusAction[] {
  const actions: SyncularMutationStatusAction[] = [];
  if (args.outbox.pending > 0) {
    actions.push({
      action: 'show-pending',
      reasonCodes: ['outbox.pending'],
      message:
        'Show the user that local mutations are durable and waiting to sync.',
    });
  }
  if (args.outbox.sending > 0 || args.state === 'syncing') {
    actions.push({
      action: 'wait-for-sync',
      reasonCodes: ['outbox.sending'],
      message:
        'A sync is already sending queued mutations; wait for it to finish.',
    });
  }
  if (args.outbox.failed > 0) {
    actions.push({
      action: 'retry-sync',
      reasonCodes: ['outbox.failed'],
      message:
        'Queued mutations have failed push attempts; resume background sync or use the local recovery plan.',
    });
  }
  if (args.conflicts.unresolved > 0) {
    actions.push({
      action: 'resolve-conflicts',
      reasonCodes: ['conflict.unresolved'],
      message:
        'Route the user to conflict resolution before claiming all local work is accepted.',
    });
  }
  if (isAuthError(args.lastError?.code)) {
    actions.push({
      action: 'refresh-auth',
      reasonCodes: [args.lastError?.code ?? 'auth.required'],
      message:
        'Refresh auth or replace auth context before retrying queued mutations.',
    });
  }
  if (args.conflictItemsUnavailable) {
    actions.push({
      action: 'inspect-diagnostics',
      reasonCodes: ['conflict.items_unavailable'],
      message:
        'Conflict stats exist, but detailed conflict records could not be read.',
    });
  }
  return dedupeActions(actions);
}

function dedupeActions(
  actions: readonly SyncularMutationStatusAction[]
): SyncularMutationStatusAction[] {
  const byAction = new Map<
    SyncularMutationStatusRecommendedAction,
    SyncularMutationStatusAction
  >();
  for (const action of actions) {
    const existing = byAction.get(action.action);
    if (!existing) {
      byAction.set(action.action, { ...action });
      continue;
    }
    existing.reasonCodes = uniqueSorted([
      ...existing.reasonCodes,
      ...action.reasonCodes,
    ]);
  }
  return [...byAction.values()];
}

function isAuthError(code: string | undefined): boolean {
  if (!code) return false;
  const normalized = code.toLowerCase();
  return normalized.includes('auth') || normalized.includes('forbidden');
}

function normalizeMaxConflictItems(maxItems: number | undefined): number {
  if (!Number.isFinite(maxItems)) return DEFAULT_MAX_CONFLICT_ITEMS;
  return Math.max(0, Math.floor(maxItems as number));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
