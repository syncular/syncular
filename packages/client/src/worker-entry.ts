import { resolveSyncularClientConfig } from './client-config';
import { syncularDiagnosticAttemptFields } from './diagnostics';
import {
  classifySyncularError,
  SyncularClientError,
  syncularErrorDetails,
  syncularErrorMessage,
  syncularErrorStatus,
} from './errors';
import {
  dispatchGeneratedSyncularWorkerRequest,
  generatedSyncularWorkerRequestDiagnosticSource,
  isGeneratedSyncularAbortableWorkerRequestType,
  isGeneratedSyncularDiagnosedSuccessWorkerRequestType,
} from './generated-bridge';
import { createSyncularRuntimeInfo } from './runtime-contract';
import { openSyncularRustClient, type SyncularRustClient } from './rust-client';
import type {
  ResolvedSyncularClientConfig,
  SyncularDiagnosticEvent,
} from './types';
import {
  getSyncularRustRuntimeInfo,
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  type SyncularWasmGlue,
} from './wasm-runtime';
import { createSyncularWorkerOperationQueue } from './worker-operation-queue';
import type {
  SyncularWorkerErrorPayload,
  SyncularWorkerOutboundMessage,
  SyncularWorkerRequest,
  SyncularWorkerRuntimeArtifact,
} from './worker-protocol';
import {
  createSyncularWorkerErrorPayload,
  SYNCULAR_WORKER_PROTOCOL_VERSION,
} from './worker-protocol';
import { SyncularWorkerRealtimeController } from './worker-realtime';

let client: SyncularRustClient | undefined;
let openedConfig: ResolvedSyncularClientConfig | undefined;
let openedRuntime: SyncularWorkerRuntimeArtifact | undefined;
let removeRowsChangedListener: (() => void) | undefined;
const canceledRequests = new Set<number>();
const abortControllers = new Map<number, AbortController>();
const clientOperations = createSyncularWorkerOperationQueue();
const realtime = new SyncularWorkerRealtimeController({
  getClient: requireClient,
  getConfig: () => openedConfig,
  getLocationOrigin: () =>
    typeof self.location?.origin === 'string'
      ? self.location.origin
      : 'http://localhost',
  createWebSocket: (url) => new WebSocket(url),
  postEvent: (event) => self.postMessage(event),
  postDiagnostic,
  runClientOperation: (operation) => clientOperations.run(operation),
});

self.onmessage = (event: MessageEvent<SyncularWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    void handleRequest(request);
    return;
  }
  void clientOperations.run(() => handleRequest(request));
};

async function handleRequest(request: SyncularWorkerRequest): Promise<void> {
  if (request.protocolVersion !== SYNCULAR_WORKER_PROTOCOL_VERSION) {
    post({
      id: request.id,
      protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: createSyncularWorkerErrorPayload(
        'worker.protocol_mismatch',
        `Unsupported Syncular worker protocol ${request.protocolVersion}`,
        { details: { supported: SYNCULAR_WORKER_PROTOCOL_VERSION } }
      ),
    });
    return;
  }

  if (request.type === 'cancel') {
    canceledRequests.add(request.requestId);
    const controller = abortControllers.get(request.requestId);
    controller?.abort();
    if (controller) {
      postDiagnostic({
        level: 'warn',
        source: 'worker',
        code: 'worker.request_aborted',
        message: 'Syncular worker request aborted',
        details: { requestId: request.requestId },
      });
    }
    post({
      id: request.id,
      protocolVersion: request.protocolVersion,
      ok: true,
    });
    return;
  }

  const startedAt = Date.now();
  const abortController = createAbortController(request.type);
  if (abortController) {
    abortControllers.set(request.id, abortController);
  }
  try {
    if (abortController) client?.setAbortSignal(abortController.signal);
    const value = await dispatch(request);
    if (canceledRequests.delete(request.id)) return;
    post({
      id: request.id,
      protocolVersion: request.protocolVersion,
      ok: true,
      value,
    });
    postRequestSuccessDiagnostic(request, value, Date.now() - startedAt);
  } catch (err) {
    if (canceledRequests.delete(request.id)) return;
    const source = requestDiagnosticSource(request.type);
    const resyncRequired = errorRequiresFullRefresh(err);
    const encodedError = encodeWorkerError(err);
    const diagnosticCode = resyncRequired
      ? `${source}.resync_required`
      : encodedError.code.startsWith(`${source}.`)
        ? encodedError.code
        : `${source}.${request.type}.failed`;
    postDiagnostic({
      level: requestDiagnosticLevel(request.type, err),
      source,
      code: diagnosticCode,
      message: resyncRequired
        ? `Syncular worker request ${request.type} requires full resync`
        : `Syncular worker request ${request.type} failed`,
      details: {
        requestType: request.type,
        durationMs: Date.now() - startedAt,
        error: errorMessage(err),
        errorCode: encodedError.code,
        ...(encodedError.category ? { category: encodedError.category } : {}),
        ...(encodedError.retryable != null
          ? { retryable: encodedError.retryable }
          : {}),
        ...(encodedError.recommendedAction
          ? { recommendedAction: encodedError.recommendedAction }
          : {}),
        ...(resyncRequired ? { resyncRequired: true } : {}),
        ...diagnosticStatus(err),
      },
      ...requestSyncAttemptDiagnosticFields(request),
    });
    post({
      id: request.id,
      protocolVersion: request.protocolVersion,
      ok: false,
      error: encodedError,
    });
  } finally {
    abortControllers.delete(request.id);
    if (abortController) clearClientAbortSignal();
  }
}

async function dispatch(request: SyncularWorkerRequest): Promise<unknown> {
  return dispatchGeneratedSyncularWorkerRequest(
    {
      requireClient,
      openClient,
      startRealtime: (options) => {
        realtime.start(options);
        return true;
      },
      stopRealtime: () => {
        realtime.stop();
        return true;
      },
      sendPresence: (action, scopeKey, metadata) => {
        realtime.sendPresence(action, scopeKey, metadata);
        return true;
      },
      runtimeInfo,
      closeClient,
    },
    request
  );
}

async function openClient(
  request: Extract<SyncularWorkerRequest, { type: 'open' }>
): Promise<boolean> {
  const config = resolveSyncularClientConfig(request.config);
  realtime.stop();
  detachRowsChangedListener();
  client?.close();
  client = undefined;
  openedConfig = undefined;
  openedRuntime = undefined;
  const runtime = request.runtime;
  client = await openSyncularRustClient({
    config,
    module: runtime?.wasmGlueUrl
      ? loadWorkerWasmGlue(runtime.wasmGlueUrl)
      : undefined,
    wasmGlueUrl: runtime?.wasmGlueUrl,
    wasmUrl: runtime?.wasmUrl,
  });
  attachRowsChangedListener(client);
  openedConfig = config;
  openedRuntime = runtime;
  return true;
}

function closeClient(): boolean {
  realtime.stop();
  detachRowsChangedListener();
  client?.close();
  client = undefined;
  openedConfig = undefined;
  openedRuntime = undefined;
  return true;
}

async function runtimeInfo(): Promise<
  ReturnType<typeof createSyncularRuntimeInfo>
> {
  const wasmUrl = getSyncularWasmUrl();
  const selectedWasmUrl = openedRuntime?.wasmUrl ?? wasmUrl;
  const selectedWasmGlueUrl =
    openedRuntime?.wasmGlueUrl ?? getSyncularWasmGlueUrl();
  return createSyncularRuntimeInfo({
    storage: openedConfig?.storage,
    workerUrl:
      typeof self.location?.href === 'string' ? self.location.href : '',
    wasmGlueUrl: selectedWasmGlueUrl,
    wasmUrl: selectedWasmUrl,
    rust: await getSyncularRustRuntimeInfo(
      openedRuntime?.wasmGlueUrl
        ? loadWorkerWasmGlue(openedRuntime.wasmGlueUrl)
        : undefined,
      selectedWasmUrl
    ),
  });
}

function loadWorkerWasmGlue(wasmGlueUrl: string): Promise<SyncularWasmGlue> {
  return import(
    /* @vite-ignore */ /* webpackIgnore: true */ wasmGlueUrl
  ) as Promise<SyncularWasmGlue>;
}

function requireClient(): SyncularRustClient {
  if (!client) {
    throw createSyncularWorkerErrorPayload(
      'worker.not_open',
      'Syncular worker client is not open'
    );
  }
  return client;
}

function attachRowsChangedListener(nextClient: SyncularRustClient): void {
  removeRowsChangedListener = nextClient.addRowsChangedListener((event) => {
    post({
      protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
      type: 'rowsChanged',
      source: event.source,
      changedTables: event.changedTables,
      changedRows: event.changedRows,
      changedRowsTruncated: event.changedRowsTruncated,
    });
  });
}

function detachRowsChangedListener(): void {
  removeRowsChangedListener?.();
  removeRowsChangedListener = undefined;
}

function post(message: SyncularWorkerOutboundMessage): void {
  self.postMessage(message);
}

function createAbortController(
  type: SyncularWorkerRequest['type']
): AbortController | undefined {
  if (!isAbortableRequest(type) || typeof AbortController === 'undefined') {
    return undefined;
  }
  return new AbortController();
}

function isAbortableRequest(type: SyncularWorkerRequest['type']): boolean {
  return isGeneratedSyncularAbortableWorkerRequestType(type);
}

function clearClientAbortSignal(): void {
  try {
    client?.setAbortSignal(null);
  } catch {
    // Best effort after a request completed, failed, or closed the client.
  }
}

function postDiagnostic(
  event: Omit<SyncularDiagnosticEvent, 'at'> & { at?: number }
): void {
  self.postMessage({
    protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
    type: 'diagnostic',
    event: {
      at: event.at ?? Date.now(),
      level: event.level,
      source: event.source,
      code: event.code,
      message: event.message,
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.syncAttemptId ? { syncAttemptId: event.syncAttemptId } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.spanId ? { spanId: event.spanId } : {}),
      ...(event.clientId ? { clientId: event.clientId } : {}),
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
      ...(event.table ? { table: event.table } : {}),
      ...(event.rowId ? { rowId: event.rowId } : {}),
      ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
      ...(event.details ? { details: event.details } : {}),
    },
  });
}

function postRequestSuccessDiagnostic(
  request: SyncularWorkerRequest,
  value: unknown,
  durationMs: number
): void {
  if (!isDiagnosedSuccessRequest(request.type)) return;
  const syncRevocation = syncScopeRevocationDetails(value);
  postDiagnostic({
    level: 'info',
    source: requestDiagnosticSource(request.type),
    code: `${requestDiagnosticSource(request.type)}.${request.type}.completed`,
    message: `Syncular worker request ${request.type} completed`,
    ...requestSyncAttemptDiagnosticFields(request),
    details: {
      requestType: request.type,
      durationMs,
      ...requestSuccessDetails(request, value),
    },
  });
  if (
    syncRevocation &&
    (request.type === 'syncPull' ||
      request.type === 'syncPush' ||
      request.type === 'syncOnce')
  ) {
    postDiagnostic({
      level: 'warn',
      source: 'sync',
      code: 'sync.scope_revoked',
      message: 'Syncular subscription scope revoked',
      ...requestSyncAttemptDiagnosticFields(request),
      details: {
        requestType: request.type,
        ...syncRevocation,
      },
    });
  }
}

function requestSyncAttemptDiagnosticFields(
  request: SyncularWorkerRequest
): Pick<
  SyncularDiagnosticEvent,
  'requestId' | 'syncAttemptId' | 'traceId' | 'spanId'
> {
  if (
    request.type !== 'syncPull' &&
    request.type !== 'syncPush' &&
    request.type !== 'syncOnce'
  ) {
    return {};
  }
  return syncularDiagnosticAttemptFields(request.syncAttempt);
}

function isDiagnosedSuccessRequest(
  type: SyncularWorkerRequest['type']
): boolean {
  return isGeneratedSyncularDiagnosedSuccessWorkerRequestType(type);
}

function requestDiagnosticSource(
  type: SyncularWorkerRequest['type']
): SyncularDiagnosticEvent['source'] {
  return generatedSyncularWorkerRequestDiagnosticSource(type);
}

function requestDiagnosticLevel(
  type: SyncularWorkerRequest['type'],
  error: unknown
): SyncularDiagnosticEvent['level'] {
  if (type === 'setAuthHeaders' || syncularErrorStatus(error)) return 'warn';
  return 'error';
}

function requestSuccessDetails(
  request: SyncularWorkerRequest,
  value: unknown
): Record<string, unknown> {
  switch (request.type) {
    case 'open':
      return {
        storage: openedConfig?.storage,
        clientId: openedConfig?.clientId,
      };
    case 'setAuthHeaders':
      return { headerCount: Object.keys(request.headers).length };
    case 'setFieldEncryption':
      return {
        enabled: request.config != null,
        ruleCount: request.config?.rules.length ?? 0,
      };
    case 'setEncryptedCrdt':
      return {
        enabled: request.config != null,
        keyCount: request.config ? Object.keys(request.config.keys).length : 0,
      };
    case 'setBlobEncryption':
      return {
        enabled: request.config != null,
        keyCount: request.config ? Object.keys(request.config.keys).length : 0,
      };
    case 'syncPull':
    case 'syncPush':
    case 'syncOnce':
      return syncResultDetails(value);
    case 'storeBlob':
      return { immediate: request.options?.immediate === true };
    case 'pruneBlobCache':
      return { maxBytes: request.maxBytes ?? null, prunedBytes: value };
    case 'compactStorage':
      return objectRecord(value);
    case 'localHealthCheck': {
      const report = objectRecord(value);
      const findings = Array.isArray(report.findings) ? report.findings : [];
      return {
        ok: report.ok === true,
        findingCount: findings.length,
      };
    }
    case 'exportLocalSupportBundle': {
      const bundle = objectRecord(value);
      const health = objectRecord(bundle.health);
      const findings = Array.isArray(health.findings) ? health.findings : [];
      return {
        redacted: bundle.redacted === true,
        source: bundle.source,
        findingCount: findings.length,
      };
    }
    case 'importLocalSupportBundle':
      return objectRecord(value);
    case 'repairLocalHealth':
      return objectRecord(value);
    case 'resetLocalSyncState':
      return objectRecord(value);
    case 'processBlobUploadQueue':
      return objectRecord(value);
    default:
      return {};
  }
}

function syncResultDetails(value: unknown): Record<string, unknown> {
  const result = objectRecord(value);
  const changedTables = Array.isArray(result.changedTables)
    ? result.changedTables
    : [];
  const changedRows = Array.isArray(result.changedRows)
    ? result.changedRows
    : [];
  return {
    changedTables,
    changedRows,
    changedRowsTruncated: result.changedRowsTruncated === true,
    changedTableCount: changedTables.length,
    changedRowCount: changedRows.length,
    bootstrap: objectRecord(result.bootstrap),
    pushedCommits:
      typeof result.pushedCommits === 'number' ? result.pushedCommits : 0,
  };
}

function syncScopeRevocationDetails(value: unknown): {
  revokedSubscriptionIds: string[];
  revokedSubscriptionCount: number;
} | null {
  const result = objectRecord(value);
  const subscriptions = Array.isArray(result.subscriptions)
    ? result.subscriptions
    : [];
  const revokedSubscriptionIds = subscriptions
    .filter((subscription): subscription is { id: string; status: string } => {
      return (
        subscription !== null &&
        typeof subscription === 'object' &&
        (subscription as { status?: unknown }).status === 'revoked' &&
        typeof (subscription as { id?: unknown }).id === 'string'
      );
    })
    .map((subscription) => subscription.id);

  return revokedSubscriptionIds.length > 0
    ? {
        revokedSubscriptionIds,
        revokedSubscriptionCount: revokedSubscriptionIds.length,
      }
    : null;
}

function diagnosticStatus(error: unknown): Record<string, unknown> {
  const status = syncularErrorStatus(error);
  return status ? { status } : {};
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return syncularErrorMessage(error);
}

function errorRequiresFullRefresh(error: unknown): boolean {
  return errorMessage(error).includes('full snapshot resync required');
}

function encodeWorkerError(error: unknown): SyncularWorkerErrorPayload {
  if (isWorkerErrorPayload(error) && !(error instanceof Error)) return error;
  if (error instanceof SyncularClientError) {
    return {
      code: error.code,
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      recommendedAction: error.recommendedAction,
      name: error.name,
      stack: error.stack,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    const details = syncularErrorDetails(error);
    const classification = classifySyncularError(error, error.message, details);
    if (!classification) {
      return createSyncularWorkerErrorPayload('worker.failed', error.message, {
        name: error.name,
        stack: error.stack,
        details,
      });
    }
    return {
      code: classification.code,
      message: error.message,
      category: classification.category,
      retryable: classification.retryable,
      recommendedAction: classification.recommendedAction,
      name: error.name,
      stack: error.stack,
      details,
    };
  }
  const message = String(error);
  const classification = classifySyncularError(error, message);
  if (!classification) {
    return createSyncularWorkerErrorPayload('worker.failed', message);
  }
  return {
    code: classification.code,
    message,
    category: classification.category,
    retryable: classification.retryable,
    recommendedAction: classification.recommendedAction,
  };
}

function isWorkerErrorPayload(
  value: unknown
): value is SyncularWorkerErrorPayload {
  return Boolean(
    value && typeof value === 'object' && 'code' in value && 'message' in value
  );
}
