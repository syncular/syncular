import {
  SYNCULAR_ERROR_DEFINITIONS,
  type SyncularErrorCode,
  type SyncularErrorRecommendedAction,
} from '@syncular/core';
import type { SyncularClientStatus } from './client';
import type {
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularLifecyclePhase,
  SyncularRealtimeConnectionState,
  SyncularRuntimeInfo,
  SyncularStorage,
  SyncularStorageFallbackInfo,
} from './types';

export type SyncularBrowserHealthStatus =
  | 'ok'
  | 'starting'
  | 'offline'
  | 'degraded'
  | 'action-required'
  | 'closed';

export type SyncularBrowserPersistenceStatus = 'durable' | 'memory' | 'unknown';

export type SyncularBrowserHealthLifecycleStage =
  | 'destroyed'
  | 'requires-action'
  | 'recovering'
  | 'offline'
  | 'bootstrapping'
  | 'degraded'
  | 'realtime-live'
  | 'ready';

export type SyncularBrowserHealthRecoveryOwner =
  | 'none'
  | 'runtime'
  | 'app-auth'
  | 'app-scope'
  | 'user'
  | 'operator'
  | 'developer';

export type SyncularBrowserHealthOperation =
  | 'read-local'
  | 'generated-mutation'
  | 'await-local-visibility'
  | 'sync-now'
  | 'replace-auth-context'
  | 'resume-from-background'
  | 'export-support-bundle'
  | 'destructive-local-recovery';

export type SyncularBrowserHealthOperationAvailability =
  | 'available'
  | 'blocked'
  | 'advanced'
  | 'requires-confirmation';

export interface SyncularBrowserHealthClient {
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
}

export interface SyncularBrowserHealthRuntime {
  packageName: string;
  packageVersion: string;
  workerProtocolVersion: number;
  workerUrl?: string;
  wasmGlueUrl: string;
  wasmUrl: string;
  rust?: SyncularRuntimeInfo['rust'];
}

export interface SyncularBrowserHealthPersistence {
  status: SyncularBrowserPersistenceStatus;
  durable: boolean | null;
  storage: SyncularStorage | null;
  effectiveStorage: SyncularStorage | null;
  fallback?: SyncularStorageFallbackInfo;
  reason?: string;
}

export interface SyncularBrowserHealthBootstrap {
  complete: boolean;
  criticalReady: boolean;
  interactiveReady: boolean;
  isBootstrapping: boolean;
  progressPercent: number;
  activePhase: number | null;
  pendingSubscriptionIds: string[];
  readySubscriptionIds: string[];
}

export interface SyncularBrowserHealthSubscriptions {
  total: number;
  ready: number;
  pending: number;
  errored: number;
  revoked: number;
  items: Array<{
    id: string;
    table: string;
    ready: boolean;
    status: string | null;
    phase: string;
    progressPercent: number;
    cursor: number | null;
    bootstrapPhase: number;
    scopeKeys: string[];
    scopeValueCount: number;
  }>;
}

export interface SyncularBrowserHealthRealtime {
  state: SyncularRealtimeConnectionState;
  connected: boolean;
}

export interface SyncularBrowserHealthError {
  code?: string;
  message: string;
  source?: string;
  level?: string;
  at?: number;
  details?: Record<string, unknown>;
}

export interface SyncularBrowserHealthRecommendedAction {
  recommendedAction: SyncularErrorRecommendedAction;
  code: SyncularErrorCode;
  message: string;
  source?: string;
}

export interface SyncularBrowserHealthOperationState {
  operation: SyncularBrowserHealthOperation;
  availability: SyncularBrowserHealthOperationAvailability;
  reasonCode?: string;
  recommendedAction?: SyncularErrorRecommendedAction;
}

export interface SyncularBrowserHealthLifecycle {
  phase: SyncularLifecyclePhase | 'unknown';
  stage: SyncularBrowserHealthLifecycleStage;
  recoveryOwner: SyncularBrowserHealthRecoveryOwner;
  blockedOperationCount: number;
  operations: SyncularBrowserHealthOperationState[];
}

export interface SyncularBrowserHealth {
  generatedAt: number;
  status: SyncularBrowserHealthStatus;
  requiresAction: boolean;
  recommendedActions: SyncularBrowserHealthRecommendedAction[];
  lifecycle: SyncularBrowserHealthLifecycle;
  runtime: SyncularBrowserHealthRuntime;
  persistence: SyncularBrowserHealthPersistence;
  bootstrap: SyncularBrowserHealthBootstrap | null;
  subscriptions: SyncularBrowserHealthSubscriptions;
  realtime: SyncularBrowserHealthRealtime;
  lastError: SyncularBrowserHealthError | null;
  recentErrors: SyncularBrowserHealthError[];
}

export async function getSyncularBrowserHealth(
  client: SyncularBrowserHealthClient
): Promise<SyncularBrowserHealth> {
  const snapshot = await client.diagnosticSnapshot();
  const status = client.getStatus?.();
  const persistence = summarizePersistence(snapshot.runtime);
  const subscriptions = summarizeSubscriptions(snapshot);
  const bootstrap = snapshot.bootstrap
    ? {
        complete: snapshot.bootstrap.complete,
        criticalReady: snapshot.bootstrap.criticalReady,
        interactiveReady: snapshot.bootstrap.interactiveReady,
        isBootstrapping: snapshot.bootstrap.isBootstrapping,
        progressPercent: snapshot.bootstrap.progressPercent,
        activePhase: snapshot.bootstrap.activePhase,
        pendingSubscriptionIds: [...snapshot.bootstrap.pendingSubscriptionIds],
        readySubscriptionIds: [...snapshot.bootstrap.readySubscriptionIds],
      }
    : null;
  const realtimeState =
    status?.connection.realtime ?? snapshot.connection.realtime;
  const recentErrors = snapshot.recentDiagnostics
    .filter((event) => event.level === 'error')
    .map(diagnosticToHealthError);
  const lastError =
    errorRecordToHealthError(status?.lifecycle.lastError) ??
    errorRecordToHealthError(snapshot.connection.lastError) ??
    last(recentErrors) ??
    null;
  const lifecyclePhase = status?.lifecycle.phase;
  const explicitRequiresAction =
    status?.requiresAction ?? status?.lifecycle.requiresAction ?? false;
  const closed = status?.connection.closed ?? snapshot.connection.closed;
  const requiresAction =
    explicitRequiresAction ||
    lifecyclePhase === 'authRequired' ||
    subscriptions.revoked > 0;
  const recommendedActions = summarizeRecommendedActions({
    lifecyclePhase,
    requiresAction,
    subscriptions,
    lastError,
    recentErrors,
  });
  const healthStatus = summarizeHealthStatus({
    closed,
    lifecyclePhase,
    requiresAction,
    persistence,
    bootstrap,
    subscriptions,
    lastError,
  });
  const lifecycle = summarizeLifecycle({
    closed,
    lifecyclePhase,
    online: status?.lifecycle.online,
    realtimeConnected: realtimeState === 'connected',
    healthStatus,
    requiresAction,
    recommendedActions,
    persistence,
    bootstrap,
    subscriptions,
    lastError,
  });

  return {
    generatedAt: snapshot.generatedAt,
    status: healthStatus,
    requiresAction,
    recommendedActions,
    lifecycle,
    runtime: {
      packageName: snapshot.runtime.packageName,
      packageVersion: snapshot.runtime.packageVersion,
      workerProtocolVersion: snapshot.runtime.workerProtocolVersion,
      ...(snapshot.runtime.workerUrl
        ? { workerUrl: snapshot.runtime.workerUrl }
        : {}),
      wasmGlueUrl: snapshot.runtime.wasmGlueUrl,
      wasmUrl: snapshot.runtime.wasmUrl,
      ...(snapshot.runtime.rust ? { rust: snapshot.runtime.rust } : {}),
    },
    persistence,
    bootstrap,
    subscriptions,
    realtime: {
      state: realtimeState,
      connected: realtimeState === 'connected',
    },
    lastError,
    recentErrors,
  };
}

function summarizePersistence(
  runtime: SyncularRuntimeInfo
): SyncularBrowserHealthPersistence {
  const storage = runtime.storage ?? null;
  const effectiveStorage = runtime.storageFallback?.to ?? storage;
  const durable =
    effectiveStorage == null ? null : effectiveStorage !== 'memory';
  const status: SyncularBrowserPersistenceStatus =
    durable === null ? 'unknown' : durable ? 'durable' : 'memory';
  const reason =
    runtime.storageFallback?.reason ??
    (effectiveStorage === 'memory'
      ? 'Syncular is using in-memory browser storage; data will not survive a reload.'
      : undefined);

  return {
    status,
    durable,
    storage,
    effectiveStorage,
    ...(runtime.storageFallback ? { fallback: runtime.storageFallback } : {}),
    ...(reason ? { reason } : {}),
  };
}

function summarizeSubscriptions(
  snapshot: SyncularDiagnosticSnapshot
): SyncularBrowserHealthSubscriptions {
  const items = snapshot.subscriptions.map((subscription) => ({
    id: subscription.id,
    table: subscription.table,
    ready: subscription.ready,
    status: subscription.status,
    phase: subscription.phase,
    progressPercent: subscription.progressPercent,
    cursor: subscription.cursor,
    bootstrapPhase: subscription.bootstrapPhase,
    scopeKeys: [...subscription.scopeKeys],
    scopeValueCount: subscription.scopeValueCount,
  }));
  const errored = items.filter((item) => item.phase === 'error').length;
  const revoked = items.filter((item) => item.status === 'revoked').length;
  const ready = items.filter((item) => item.ready).length;

  return {
    total: items.length,
    ready,
    pending: items.length - ready - errored - revoked,
    errored,
    revoked,
    items,
  };
}

function summarizeHealthStatus(args: {
  closed: boolean;
  lifecyclePhase: string | undefined;
  requiresAction: boolean;
  persistence: SyncularBrowserHealthPersistence;
  bootstrap: SyncularBrowserHealthBootstrap | null;
  subscriptions: SyncularBrowserHealthSubscriptions;
  lastError: SyncularBrowserHealthError | null;
}): SyncularBrowserHealthStatus {
  if (args.closed) return 'closed';
  if (args.lifecyclePhase === 'authRequired' || args.requiresAction) {
    return 'action-required';
  }
  if (args.lifecyclePhase === 'offline') return 'offline';
  if (
    args.persistence.durable === false ||
    args.subscriptions.errored > 0 ||
    args.subscriptions.revoked > 0 ||
    (args.lastError && args.lifecyclePhase !== 'complete')
  ) {
    return 'degraded';
  }
  if (args.bootstrap && !args.bootstrap.complete) return 'starting';
  if (args.lifecyclePhase && args.lifecyclePhase !== 'complete') {
    return 'starting';
  }
  return 'ok';
}

function summarizeRecommendedActions(args: {
  lifecyclePhase: string | undefined;
  requiresAction: boolean;
  subscriptions: SyncularBrowserHealthSubscriptions;
  lastError: SyncularBrowserHealthError | null;
  recentErrors: SyncularBrowserHealthError[];
}): SyncularBrowserHealthRecommendedAction[] {
  const actions = new Map<string, SyncularBrowserHealthRecommendedAction>();

  const add = (
    code: string | undefined,
    source: string | undefined,
    message: string | undefined
  ) => {
    if (!isSyncularErrorCode(code)) {
      return;
    }
    const definition = SYNCULAR_ERROR_DEFINITIONS[code];
    const key = `${code}:${source ?? ''}`;
    actions.set(key, {
      code,
      recommendedAction: definition.recommendedAction,
      message: message ?? definition.message,
      ...(source ? { source } : {}),
    });
  };

  if (args.lifecyclePhase === 'authRequired') {
    add('sync.auth_required', 'lifecycle', undefined);
  }
  if (args.subscriptions.revoked > 0) {
    add('sync.scope_revoked', 'subscriptions', undefined);
  }
  if (args.requiresAction) {
    add(args.lastError?.code, args.lastError?.source, args.lastError?.message);
    for (const error of args.recentErrors) {
      add(error.code, error.source, error.message);
    }
  }

  return Array.from(actions.values());
}

function summarizeLifecycle(args: {
  closed: boolean;
  lifecyclePhase: SyncularLifecyclePhase | undefined;
  online: boolean | undefined;
  realtimeConnected: boolean;
  healthStatus: SyncularBrowserHealthStatus;
  requiresAction: boolean;
  recommendedActions: readonly SyncularBrowserHealthRecommendedAction[];
  persistence: SyncularBrowserHealthPersistence;
  bootstrap: SyncularBrowserHealthBootstrap | null;
  subscriptions: SyncularBrowserHealthSubscriptions;
  lastError: SyncularBrowserHealthError | null;
}): SyncularBrowserHealthLifecycle {
  const stage = summarizeLifecycleStage(args);
  const recoveryOwner = summarizeRecoveryOwner(args);
  const operations = summarizeOperationStates(args);

  return {
    phase: args.lifecyclePhase ?? 'unknown',
    stage,
    recoveryOwner,
    blockedOperationCount: operations.filter(
      (operation) => operation.availability === 'blocked'
    ).length,
    operations,
  };
}

function summarizeLifecycleStage(args: {
  closed: boolean;
  lifecyclePhase: SyncularLifecyclePhase | undefined;
  realtimeConnected: boolean;
  healthStatus: SyncularBrowserHealthStatus;
  requiresAction: boolean;
  bootstrap: SyncularBrowserHealthBootstrap | null;
}): SyncularBrowserHealthLifecycleStage {
  if (args.closed || args.lifecyclePhase === 'closed') return 'destroyed';
  if (args.requiresAction || args.healthStatus === 'action-required') {
    return 'requires-action';
  }
  if (
    args.lifecyclePhase === 'recovering' ||
    args.lifecyclePhase === 'syncing' ||
    args.lifecyclePhase === 'connecting'
  ) {
    return 'recovering';
  }
  if (args.lifecyclePhase === 'offline' || args.healthStatus === 'offline') {
    return 'offline';
  }
  if (args.bootstrap && !args.bootstrap.complete) return 'bootstrapping';
  if (args.healthStatus === 'degraded') return 'degraded';
  if (args.lifecyclePhase === 'complete' && args.realtimeConnected) {
    return 'realtime-live';
  }
  return 'ready';
}

function summarizeRecoveryOwner(args: {
  closed: boolean;
  lifecyclePhase: SyncularLifecyclePhase | undefined;
  healthStatus: SyncularBrowserHealthStatus;
  recommendedActions: readonly SyncularBrowserHealthRecommendedAction[];
  persistence: SyncularBrowserHealthPersistence;
}): SyncularBrowserHealthRecoveryOwner {
  if (args.healthStatus === 'ok' || args.healthStatus === 'starting') {
    return 'none';
  }
  if (args.closed || args.lifecyclePhase === 'closed') return 'user';

  for (const action of args.recommendedActions) {
    const owner = recoveryOwnerForRecommendedAction(action.recommendedAction);
    if (owner !== 'none') return owner;
  }

  if (args.lifecyclePhase === 'authRequired') return 'app-auth';
  if (
    args.lifecyclePhase === 'connecting' ||
    args.lifecyclePhase === 'syncing' ||
    args.lifecyclePhase === 'recovering' ||
    args.lifecyclePhase === 'offline'
  ) {
    return 'runtime';
  }
  if (args.persistence.durable === false) return 'user';
  return args.healthStatus === 'degraded' ? 'runtime' : 'none';
}

function recoveryOwnerForRecommendedAction(
  action: SyncularErrorRecommendedAction
): SyncularBrowserHealthRecoveryOwner {
  switch (action) {
    case 'refreshAuth':
      return 'app-auth';
    case 'checkPermissions':
      return 'app-scope';
    case 'inspectServer':
    case 'regenerateClient':
    case 'upgradeClient':
      return 'operator';
    case 'inspectStorage':
    case 'recreateClient':
    case 'resetClientId':
    case 'resolveConflict':
    case 'reduceInput':
      return 'user';
    case 'fixRequest':
    case 'splitBatch':
      return 'developer';
    case 'forceResync':
    case 'retryLater':
      return 'runtime';
  }
}

function summarizeOperationStates(args: {
  closed: boolean;
  lifecyclePhase: SyncularLifecyclePhase | undefined;
  online: boolean | undefined;
  requiresAction: boolean;
  recommendedActions: readonly SyncularBrowserHealthRecommendedAction[];
  persistence: SyncularBrowserHealthPersistence;
  subscriptions: SyncularBrowserHealthSubscriptions;
  lastError: SyncularBrowserHealthError | null;
}): SyncularBrowserHealthOperationState[] {
  const actionByCode = new Map(
    args.recommendedActions.map((action) => [
      action.code,
      action.recommendedAction,
    ])
  );
  const reasonCode = primaryLifecycleReasonCode(args);
  const recommendedAction = reasonCode
    ? (actionByCode.get(reasonCode as SyncularErrorCode) ??
      recommendedActionForReasonCode(reasonCode))
    : undefined;
  const blocked = (
    operation: SyncularBrowserHealthOperation,
    fallbackReasonCode: string
  ): SyncularBrowserHealthOperationState => ({
    operation,
    availability: 'blocked',
    reasonCode: reasonCode ?? fallbackReasonCode,
    ...(recommendedAction ? { recommendedAction } : {}),
  });
  const available = (
    operation: SyncularBrowserHealthOperation
  ): SyncularBrowserHealthOperationState => ({
    operation,
    availability: 'available',
  });
  const advanced = (
    operation: SyncularBrowserHealthOperation,
    operationReasonCode: string
  ): SyncularBrowserHealthOperationState => ({
    operation,
    availability: 'advanced',
    reasonCode: operationReasonCode,
  });
  const requiresConfirmation = (
    operation: SyncularBrowserHealthOperation,
    operationReasonCode: string
  ): SyncularBrowserHealthOperationState => ({
    operation,
    availability: 'requires-confirmation',
    reasonCode: operationReasonCode,
  });

  if (args.closed || args.lifecyclePhase === 'closed') {
    return ALL_BROWSER_HEALTH_OPERATIONS.map((operation) =>
      blocked(operation, 'lifecycle.closed')
    );
  }

  const authBlocked = args.lifecyclePhase === 'authRequired';
  const scopeBlocked = args.subscriptions.revoked > 0;
  const offline = args.online === false || args.lifecyclePhase === 'offline';
  const nonDurable = args.persistence.durable === false;

  return [
    available('read-local'),
    authBlocked || scopeBlocked
      ? blocked('generated-mutation', 'sync.auth_required')
      : nonDurable
        ? advanced('generated-mutation', 'browser.storage_ephemeral')
        : available('generated-mutation'),
    authBlocked || scopeBlocked
      ? blocked('await-local-visibility', 'sync.auth_required')
      : available('await-local-visibility'),
    authBlocked || scopeBlocked
      ? blocked('sync-now', 'sync.auth_required')
      : offline
        ? blocked('sync-now', 'sync.offline')
        : available('sync-now'),
    available('replace-auth-context'),
    authBlocked
      ? blocked('resume-from-background', 'sync.auth_required')
      : available('resume-from-background'),
    available('export-support-bundle'),
    args.requiresAction || nonDurable
      ? requiresConfirmation(
          'destructive-local-recovery',
          reasonCode ?? 'lifecycle.requires_action'
        )
      : advanced('destructive-local-recovery', 'lifecycle.advanced_recovery'),
  ];
}

const ALL_BROWSER_HEALTH_OPERATIONS: SyncularBrowserHealthOperation[] = [
  'read-local',
  'generated-mutation',
  'await-local-visibility',
  'sync-now',
  'replace-auth-context',
  'resume-from-background',
  'export-support-bundle',
  'destructive-local-recovery',
];

function primaryLifecycleReasonCode(args: {
  lifecyclePhase: SyncularLifecyclePhase | undefined;
  recommendedActions: readonly SyncularBrowserHealthRecommendedAction[];
  persistence: SyncularBrowserHealthPersistence;
  subscriptions: SyncularBrowserHealthSubscriptions;
  lastError: SyncularBrowserHealthError | null;
}): string | undefined {
  if (args.lifecyclePhase === 'authRequired') return 'sync.auth_required';
  if (args.subscriptions.revoked > 0) return 'sync.scope_revoked';
  if (args.lastError?.code) return args.lastError.code;
  if (args.recommendedActions[0]?.code) return args.recommendedActions[0].code;
  if (args.persistence.durable === false) return 'browser.storage_ephemeral';
  if (args.lifecyclePhase === 'offline') return 'sync.offline';
  return undefined;
}

function recommendedActionForReasonCode(
  code: string
): SyncularErrorRecommendedAction | undefined {
  return isSyncularErrorCode(code)
    ? SYNCULAR_ERROR_DEFINITIONS[code].recommendedAction
    : undefined;
}

function errorRecordToHealthError(
  error: { code?: string; message: string } | undefined
): SyncularBrowserHealthError | null {
  if (!error) return null;
  return {
    ...(error.code ? { code: error.code } : {}),
    message: error.message,
  };
}

function diagnosticToHealthError(
  event: SyncularDiagnosticEvent
): SyncularBrowserHealthError {
  return {
    code: event.code,
    message: event.message,
    source: event.source,
    level: event.level,
    at: event.at,
    ...(event.details ? { details: event.details } : {}),
  };
}

function last<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[items.length - 1];
}

function isSyncularErrorCode(
  code: string | undefined
): code is SyncularErrorCode {
  return typeof code === 'string' && code in SYNCULAR_ERROR_DEFINITIONS;
}
