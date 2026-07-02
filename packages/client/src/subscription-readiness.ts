import type { SyncularErrorRecommendedAction } from '@syncular/core';
import type { SyncularClientStatus } from './client';
import type {
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularDiagnosticSubscriptionSnapshot,
  SyncularSubscriptionSpec,
} from './types';

export type SyncularSubscriptionReadinessStatus =
  | 'ready'
  | 'waiting'
  | 'partial'
  | 'action-required'
  | 'unknown';

export type SyncularSubscriptionReadinessItemStatus =
  | 'ready'
  | 'waiting'
  | 'action-required'
  | 'missing'
  | 'unknown';

export type SyncularSubscriptionReadinessIssueSeverity =
  | 'info'
  | 'warning'
  | 'error';

export type SyncularSubscriptionReadinessIssueCode =
  | 'subscription.auth_required'
  | 'subscription.bootstrap_pending'
  | 'subscription.error'
  | 'subscription.missing'
  | 'subscription.network_offline'
  | 'subscription.rate_limited'
  | 'subscription.revoked'
  | 'subscription.runtime_issue'
  | 'subscription.schema_issue'
  | 'subscription.storage_issue';

export interface SyncularSubscriptionReadinessClient {
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
}

export interface SyncularSubscriptionReadinessOptions {
  /**
   * Generated app wrappers pass the resolved generated subscriptions here so
   * readiness can distinguish "not yet observed" from "not configured".
   */
  expectedSubscriptions?: readonly SyncularSubscriptionSpec[];
  subscriptionIds?: readonly string[];
  tables?: readonly string[];
}

export interface SyncularSubscriptionReadinessIssue {
  code: SyncularSubscriptionReadinessIssueCode;
  severity: SyncularSubscriptionReadinessIssueSeverity;
  message: string;
  table?: string;
  subscriptionId?: string;
  diagnosticCode?: string;
  recommendedAction?: SyncularErrorRecommendedAction;
  details?: Record<string, unknown>;
}

export interface SyncularSubscriptionReadinessDiagnostic {
  at: number;
  code: string;
  level: SyncularDiagnosticEvent['level'];
  source: SyncularDiagnosticEvent['source'];
  message: string;
  table?: string;
  subscriptionId?: string;
  recommendedAction?: SyncularErrorRecommendedAction;
}

export interface SyncularSubscriptionReadinessItem {
  id: string;
  table: string;
  status: SyncularSubscriptionReadinessItemStatus;
  ready: boolean;
  expected: boolean;
  observed: boolean;
  phase: string | null;
  subscriptionStatus: string | null;
  progressPercent: number;
  cursor: number | null;
  bootstrapPhase: number;
  bootstrapStatePresent: boolean;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  issues: SyncularSubscriptionReadinessIssue[];
  diagnostics: SyncularSubscriptionReadinessDiagnostic[];
}

export interface SyncularSubscriptionReadinessSummary {
  total: number;
  ready: number;
  waiting: number;
  actionRequired: number;
  missing: number;
  unknown: number;
}

export interface SyncularSubscriptionReadinessResult {
  generatedAt: number;
  status: SyncularSubscriptionReadinessStatus;
  ready: boolean;
  requiresAction: boolean;
  summary: SyncularSubscriptionReadinessSummary;
  items: SyncularSubscriptionReadinessItem[];
  issues: SyncularSubscriptionReadinessIssue[];
}

export async function getSyncularSubscriptionReadiness(
  client: SyncularSubscriptionReadinessClient,
  options: SyncularSubscriptionReadinessOptions = {}
): Promise<SyncularSubscriptionReadinessResult> {
  const snapshot = await client.diagnosticSnapshot();
  const status = client.getStatus?.();
  const expected = filterExpectedSubscriptions(
    options.expectedSubscriptions ?? [],
    options
  );
  const observed = filterObservedSubscriptions(snapshot.subscriptions, options);
  const expectedById = new Map(
    expected.map((subscription) => [subscription.id, subscription])
  );
  const observedById = new Map(
    observed.map((subscription) => [subscription.id, subscription])
  );
  const ids = uniqueStrings([
    ...expected.map((subscription) => subscription.id),
    ...observed.map((subscription) => subscription.id),
  ]);
  const globalDiagnostics = snapshot.recentDiagnostics.filter((diagnostic) =>
    diagnosticAppliesToSelection(diagnostic, options)
  );
  const globalIssues = issueUniqueByKey(
    globalDiagnostics
      .map((diagnostic) =>
        issueFromDiagnostic({
          diagnostic,
          table: diagnostic.table,
          subscriptionId: diagnostic.subscriptionId,
        })
      )
      .filter(isSubscriptionReadinessIssue)
  );
  const items = ids.map((id) =>
    summarizeSubscriptionItem({
      expected: expectedById.get(id),
      observed: observedById.get(id),
      diagnostics: globalDiagnostics,
      lifecyclePhase: status?.lifecycle.phase,
      online: status?.lifecycle.online,
    })
  );
  const syntheticUnknown =
    items.length === 0 && expected.length === 0 && observed.length === 0;
  const finalItems = syntheticUnknown
    ? [
        {
          id: '<unknown>',
          table: '<unknown>',
          status: 'unknown' as const,
          ready: false,
          expected: false,
          observed: false,
          phase: null,
          subscriptionStatus: null,
          progressPercent: 0,
          cursor: null,
          bootstrapPhase: 0,
          bootstrapStatePresent: false,
          scopeKeys: [],
          scopeValueCount: 0,
          paramsKeys: [],
          paramsValueCount: 0,
          issues: [],
          diagnostics: [],
        },
      ]
    : items;
  const summary = summarizeItems(finalItems);
  const issues = issueUniqueByKey([
    ...globalIssues,
    ...finalItems.flatMap((item) => item.issues),
  ]);
  const resultStatus = summarizeReadinessStatus(summary);

  return {
    generatedAt: snapshot.generatedAt,
    status: resultStatus,
    ready: resultStatus === 'ready',
    requiresAction: resultStatus === 'action-required',
    summary,
    items: finalItems,
    issues,
  };
}

function summarizeSubscriptionItem(args: {
  expected: SyncularSubscriptionSpec | undefined;
  observed: SyncularDiagnosticSubscriptionSnapshot | undefined;
  diagnostics: readonly SyncularDiagnosticEvent[];
  lifecyclePhase: SyncularClientStatus['lifecycle']['phase'] | undefined;
  online: boolean | undefined;
}): SyncularSubscriptionReadinessItem {
  const id = args.observed?.id ?? args.expected?.id ?? '<unknown>';
  const table = args.observed?.table ?? args.expected?.table ?? '<unknown>';
  const matchingDiagnostics = args.diagnostics.filter((diagnostic) =>
    diagnosticAppliesToSubscription(diagnostic, id, table)
  );
  const diagnosticIssues = matchingDiagnostics
    .map((diagnostic) =>
      issueFromDiagnostic({ diagnostic, table, subscriptionId: id })
    )
    .filter(isSubscriptionReadinessIssue);
  const issues: SyncularSubscriptionReadinessIssue[] = [
    ...diagnosticIssues,
    ...stateIssuesForSubscription({
      id,
      table,
      expected: args.expected,
      observed: args.observed,
      lifecyclePhase: args.lifecyclePhase,
      online: args.online,
    }),
  ];
  const uniqueIssues = issueUniqueByKey(issues);
  const itemStatus = summarizeItemStatus(args.observed, uniqueIssues);
  const diagnostics = matchingDiagnostics.map((diagnostic) =>
    summarizeDiagnostic(diagnostic)
  );
  const scopeKeys = args.observed
    ? [...args.observed.scopeKeys]
    : Object.keys(args.expected?.scopes ?? {}).sort();
  const paramsKeys = args.observed
    ? [...args.observed.paramsKeys]
    : Object.keys(args.expected?.params ?? {}).sort();
  const scopeValueCount =
    args.observed?.scopeValueCount ??
    Object.values(args.expected?.scopes ?? {}).reduce(
      (count, value) => count + (Array.isArray(value) ? value.length : 1),
      0
    );
  const paramsValueCount =
    args.observed?.paramsValueCount ??
    Object.keys(args.expected?.params ?? {}).length;

  return {
    id,
    table,
    status: itemStatus,
    ready: itemStatus === 'ready',
    expected: args.expected !== undefined,
    observed: args.observed !== undefined,
    phase: args.observed?.phase ?? null,
    subscriptionStatus: args.observed?.status ?? null,
    progressPercent: args.observed?.progressPercent ?? 0,
    cursor: args.observed?.cursor ?? null,
    bootstrapPhase:
      args.observed?.bootstrapPhase ?? args.expected?.bootstrapPhase ?? 0,
    bootstrapStatePresent: args.observed?.bootstrapState != null,
    scopeKeys,
    scopeValueCount,
    paramsKeys,
    paramsValueCount,
    issues: uniqueIssues,
    diagnostics,
  };
}

function stateIssuesForSubscription(args: {
  id: string;
  table: string;
  expected: SyncularSubscriptionSpec | undefined;
  observed: SyncularDiagnosticSubscriptionSnapshot | undefined;
  lifecyclePhase: SyncularClientStatus['lifecycle']['phase'] | undefined;
  online: boolean | undefined;
}): SyncularSubscriptionReadinessIssue[] {
  const issues: SyncularSubscriptionReadinessIssue[] = [];
  if (args.expected && !args.observed) {
    issues.push({
      code: 'subscription.missing',
      severity: 'error',
      message:
        'Expected subscription is not configured on the opened Syncular client.',
      subscriptionId: args.id,
      table: args.table,
      recommendedAction: 'fixRequest',
    });
    return issues;
  }
  if (!args.observed) return issues;
  if (args.observed.status === 'revoked') {
    issues.push({
      code: 'subscription.revoked',
      severity: 'error',
      message: 'Subscription was revoked by the server authority.',
      subscriptionId: args.id,
      table: args.table,
      recommendedAction: 'checkPermissions',
    });
  }
  if (args.observed.phase === 'error') {
    issues.push({
      code: 'subscription.error',
      severity: 'error',
      message: 'Subscription bootstrap or sync is in an error phase.',
      subscriptionId: args.id,
      table: args.table,
      recommendedAction: 'inspectServer',
    });
  }
  if (
    !args.observed.ready &&
    args.observed.phase !== 'error' &&
    args.observed.status !== 'revoked'
  ) {
    issues.push({
      code: 'subscription.bootstrap_pending',
      severity: 'info',
      message: 'Subscription is waiting for bootstrap, sync, or local apply.',
      subscriptionId: args.id,
      table: args.table,
      recommendedAction: 'retryLater',
    });
  }
  if (args.lifecyclePhase === 'authRequired') {
    issues.push({
      code: 'subscription.auth_required',
      severity: 'error',
      message:
        'Syncular needs refreshed app auth before this subscription can recover.',
      subscriptionId: args.id,
      table: args.table,
      recommendedAction: 'refreshAuth',
    });
  }
  if (args.online === false) {
    issues.push({
      code: 'subscription.network_offline',
      severity: 'warning',
      message:
        'Browser network state is offline; subscription recovery is waiting for connectivity.',
      subscriptionId: args.id,
      table: args.table,
      recommendedAction: 'retryLater',
    });
  }
  return issues;
}

function issueFromDiagnostic(args: {
  diagnostic: SyncularDiagnosticEvent;
  table?: string;
  subscriptionId?: string;
}): SyncularSubscriptionReadinessIssue | null {
  const { diagnostic } = args;
  const recommendedAction = recommendedActionForDiagnosticCode(diagnostic.code);
  const base = {
    diagnosticCode: diagnostic.code,
    message: diagnostic.message,
    ...(args.subscriptionId ? { subscriptionId: args.subscriptionId } : {}),
    ...(args.table ? { table: args.table } : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
  };

  if (
    diagnostic.code === 'sync.auth_required' ||
    diagnostic.code === 'auth.expired' ||
    diagnostic.code === 'auth.refresh_failed'
  ) {
    return {
      ...base,
      code: 'subscription.auth_required',
      severity: 'error',
      recommendedAction: recommendedAction ?? 'refreshAuth',
    };
  }
  if (diagnostic.code === 'sync.scope_revoked') {
    return {
      ...base,
      code: 'subscription.revoked',
      severity: 'error',
      recommendedAction: recommendedAction ?? 'checkPermissions',
    };
  }
  if (diagnostic.code === 'sync.rate_limited') {
    return {
      ...base,
      code: 'subscription.rate_limited',
      severity: 'warning',
      recommendedAction: recommendedAction ?? 'retryLater',
    };
  }
  if (diagnostic.code.includes('schema')) {
    return {
      ...base,
      code: 'subscription.schema_issue',
      severity: diagnostic.level === 'error' ? 'error' : 'warning',
      recommendedAction: recommendedAction ?? 'regenerateClient',
    };
  }
  if (
    diagnostic.code.includes('runtime') ||
    diagnostic.code.includes('worker')
  ) {
    return {
      ...base,
      code: 'subscription.runtime_issue',
      severity: diagnostic.level === 'error' ? 'error' : 'warning',
      recommendedAction: recommendedAction ?? 'recreateClient',
    };
  }
  if (diagnostic.code.includes('storage') || diagnostic.code.includes('opfs')) {
    return {
      ...base,
      code: 'subscription.storage_issue',
      severity: diagnostic.level === 'error' ? 'error' : 'warning',
      recommendedAction: recommendedAction ?? 'inspectStorage',
    };
  }
  if (diagnostic.code.includes('offline')) {
    return {
      ...base,
      code: 'subscription.network_offline',
      severity: 'warning',
      recommendedAction: recommendedAction ?? 'retryLater',
    };
  }
  if (
    diagnostic.level === 'error' &&
    (diagnostic.subscriptionId || diagnostic.table)
  ) {
    return {
      ...base,
      code: 'subscription.error',
      severity: 'error',
      recommendedAction: recommendedAction ?? 'inspectServer',
    };
  }
  return null;
}

function summarizeItemStatus(
  observed: SyncularDiagnosticSubscriptionSnapshot | undefined,
  issues: readonly SyncularSubscriptionReadinessIssue[]
): SyncularSubscriptionReadinessItemStatus {
  if (!observed) return 'missing';
  if (issues.some((issue) => issue.severity === 'error')) {
    return 'action-required';
  }
  if (observed.ready) return 'ready';
  if (observed.phase || observed.status) return 'waiting';
  return 'unknown';
}

function summarizeItems(
  items: readonly SyncularSubscriptionReadinessItem[]
): SyncularSubscriptionReadinessSummary {
  return {
    total: items.length,
    ready: items.filter((item) => item.status === 'ready').length,
    waiting: items.filter((item) => item.status === 'waiting').length,
    actionRequired: items.filter((item) => item.status === 'action-required')
      .length,
    missing: items.filter((item) => item.status === 'missing').length,
    unknown: items.filter((item) => item.status === 'unknown').length,
  };
}

function summarizeReadinessStatus(
  summary: SyncularSubscriptionReadinessSummary
): SyncularSubscriptionReadinessStatus {
  if (summary.actionRequired > 0 || summary.missing > 0) {
    return 'action-required';
  }
  if (summary.total === 0 || summary.unknown === summary.total)
    return 'unknown';
  if (summary.ready === summary.total) return 'ready';
  if (summary.ready > 0) return 'partial';
  return 'waiting';
}

function summarizeDiagnostic(
  diagnostic: SyncularDiagnosticEvent
): SyncularSubscriptionReadinessDiagnostic {
  const recommendedAction = recommendedActionForDiagnosticCode(diagnostic.code);
  return {
    at: diagnostic.at,
    code: diagnostic.code,
    level: diagnostic.level,
    source: diagnostic.source,
    message: diagnostic.message,
    ...(diagnostic.table ? { table: diagnostic.table } : {}),
    ...(diagnostic.subscriptionId
      ? { subscriptionId: diagnostic.subscriptionId }
      : {}),
    ...(recommendedAction ? { recommendedAction } : {}),
  };
}

function filterExpectedSubscriptions(
  subscriptions: readonly SyncularSubscriptionSpec[],
  options: SyncularSubscriptionReadinessOptions
): SyncularSubscriptionSpec[] {
  return subscriptions
    .filter((subscription) => matchesSelection(subscription, options))
    .map((subscription) => ({
      ...subscription,
      scopes: { ...subscription.scopes },
      ...(subscription.params ? { params: { ...subscription.params } } : {}),
    }));
}

function filterObservedSubscriptions(
  subscriptions: readonly SyncularDiagnosticSubscriptionSnapshot[],
  options: SyncularSubscriptionReadinessOptions
): SyncularDiagnosticSubscriptionSnapshot[] {
  return subscriptions
    .filter((subscription) => matchesSelection(subscription, options))
    .map((subscription) => ({
      ...subscription,
      scopeKeys: [...subscription.scopeKeys],
      paramsKeys: [...subscription.paramsKeys],
      bootstrapState: subscription.bootstrapState
        ? {
            ...subscription.bootstrapState,
            tables: [...subscription.bootstrapState.tables],
          }
        : null,
    }));
}

function matchesSelection(
  subscription: Pick<SyncularSubscriptionSpec, 'id' | 'table'>,
  options: SyncularSubscriptionReadinessOptions
): boolean {
  if (
    options.subscriptionIds &&
    !options.subscriptionIds.includes(subscription.id)
  ) {
    return false;
  }
  if (options.tables && !options.tables.includes(subscription.table)) {
    return false;
  }
  return true;
}

function diagnosticAppliesToSelection(
  diagnostic: SyncularDiagnosticEvent,
  options: SyncularSubscriptionReadinessOptions
): boolean {
  if (
    diagnostic.subscriptionId &&
    options.subscriptionIds &&
    !options.subscriptionIds.includes(diagnostic.subscriptionId)
  ) {
    return false;
  }
  if (
    diagnostic.table &&
    options.tables &&
    !options.tables.includes(diagnostic.table)
  ) {
    return false;
  }
  return true;
}

function diagnosticAppliesToSubscription(
  diagnostic: SyncularDiagnosticEvent,
  subscriptionId: string,
  table: string
): boolean {
  if (diagnostic.subscriptionId)
    return diagnostic.subscriptionId === subscriptionId;
  if (diagnostic.table) return diagnostic.table === table;
  return isGlobalSubscriptionDiagnostic(diagnostic);
}

function isGlobalSubscriptionDiagnostic(
  diagnostic: SyncularDiagnosticEvent
): boolean {
  return (
    diagnostic.code === 'sync.auth_required' ||
    diagnostic.code === 'auth.expired' ||
    diagnostic.code === 'auth.refresh_failed' ||
    diagnostic.code === 'sync.rate_limited' ||
    diagnostic.code.includes('schema') ||
    diagnostic.code.includes('runtime') ||
    diagnostic.code.includes('worker') ||
    diagnostic.code.includes('storage') ||
    diagnostic.code.includes('opfs') ||
    diagnostic.code.includes('offline')
  );
}

function issueUniqueByKey(
  issues: readonly SyncularSubscriptionReadinessIssue[]
): SyncularSubscriptionReadinessIssue[] {
  const seen = new Set<string>();
  const result: SyncularSubscriptionReadinessIssue[] = [];
  for (const issue of issues) {
    const key = [
      issue.code,
      issue.subscriptionId ?? '',
      issue.table ?? '',
      issue.diagnosticCode ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isSubscriptionReadinessIssue(
  issue: SyncularSubscriptionReadinessIssue | null
): issue is SyncularSubscriptionReadinessIssue {
  return issue !== null;
}

function recommendedActionForDiagnosticCode(
  code: string
): SyncularErrorRecommendedAction | undefined {
  if (
    code === 'sync.auth_required' ||
    code === 'auth.expired' ||
    code === 'auth.refresh_failed'
  ) {
    return 'refreshAuth';
  }
  if (code === 'sync.scope_revoked') return 'checkPermissions';
  if (code === 'sync.rate_limited') return 'retryLater';
  if (code.includes('schema')) return 'regenerateClient';
  if (code.includes('runtime') || code.includes('worker')) {
    return 'recreateClient';
  }
  if (code.includes('storage') || code.includes('opfs')) {
    return 'inspectStorage';
  }
  if (code.includes('offline')) return 'retryLater';
  return undefined;
}
