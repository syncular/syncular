import type { SyncularClientStatus } from './client';
import type {
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
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

export interface SyncularBrowserHealth {
  generatedAt: number;
  status: SyncularBrowserHealthStatus;
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

  return {
    generatedAt: snapshot.generatedAt,
    status: summarizeHealthStatus({
      closed: status?.connection.closed ?? snapshot.connection.closed,
      lifecyclePhase: status?.lifecycle.phase,
      requiresAction:
        status?.requiresAction ?? status?.lifecycle.requiresAction,
      persistence,
      bootstrap,
      subscriptions,
      lastError,
    }),
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
  requiresAction: boolean | undefined;
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
