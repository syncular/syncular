import { resolveSyncularV2ClientConfig } from './client-config';
import { syncularV2DiagnosticAttemptFields } from './diagnostics';
import {
  classifySyncularV2Error,
  SyncularV2ClientError,
  syncularV2ErrorDetails,
  syncularV2ErrorMessage,
  syncularV2ErrorStatus,
} from './errors';
import { createSyncularV2RuntimeInfo } from './runtime-contract';
import {
  openSyncularV2RustClient,
  type SyncularV2RustClient,
} from './rust-client';
import type {
  SyncularV2ClientConfig,
  SyncularV2DiagnosticEvent,
} from './types';
import {
  getSyncularV2RustRuntimeInfo,
  getSyncularV2WasmGlueUrl,
  getSyncularV2WasmUrl,
  type SyncularV2WasmGlue,
} from './wasm-runtime';
import type {
  SyncularV2WorkerErrorPayload,
  SyncularV2WorkerOutboundMessage,
  SyncularV2WorkerRequest,
  SyncularV2WorkerRuntimeArtifact,
} from './worker-protocol';
import {
  createSyncularV2WorkerErrorPayload,
  SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
} from './worker-protocol';
import { SyncularV2WorkerRealtimeController } from './worker-realtime';

let client: SyncularV2RustClient | undefined;
let openedConfig: SyncularV2ClientConfig | undefined;
let openedRuntime: SyncularV2WorkerRuntimeArtifact | undefined;
let removeRowsChangedListener: (() => void) | undefined;
const canceledRequests = new Set<number>();
const abortControllers = new Map<number, AbortController>();
const realtime = new SyncularV2WorkerRealtimeController({
  getClient: requireClient,
  getConfig: () => openedConfig,
  getLocationOrigin: () =>
    typeof self.location?.origin === 'string'
      ? self.location.origin
      : 'http://localhost',
  createWebSocket: (url) => new WebSocket(url),
  postEvent: (event) => self.postMessage(event),
  postDiagnostic,
});

self.onmessage = (event: MessageEvent<SyncularV2WorkerRequest>) => {
  void handleRequest(event.data);
};

async function handleRequest(request: SyncularV2WorkerRequest): Promise<void> {
  if (request.protocolVersion !== SYNCULAR_V2_WORKER_PROTOCOL_VERSION) {
    post({
      id: request.id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      ok: false,
      error: createSyncularV2WorkerErrorPayload(
        'worker.protocol_mismatch',
        `Unsupported Syncular v2 worker protocol ${request.protocolVersion}`,
        { details: { supported: SYNCULAR_V2_WORKER_PROTOCOL_VERSION } }
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
        message: 'Syncular v2 worker request aborted',
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
        ? `Syncular v2 worker request ${request.type} requires full resync`
        : `Syncular v2 worker request ${request.type} failed`,
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

async function dispatch(request: SyncularV2WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'open':
      {
        const config = resolveSyncularV2ClientConfig(request.config);
        realtime.stop();
        detachRowsChangedListener();
        client?.close();
        client = undefined;
        openedConfig = undefined;
        openedRuntime = undefined;
        const runtime = request.runtime;
        client = await openSyncularV2RustClient({
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
      }
      return true;
    case 'setSubscriptions':
      return requireClient().setSubscriptions(request.subscriptions);
    case 'forceSubscriptionsBootstrap':
      return requireClient().forceSubscriptionsBootstrap(
        request.subscriptionIds ?? []
      );
    case 'setAuthHeaders':
      return requireClient().setAuthHeaders(request.headers);
    case 'setFieldEncryption':
      return requireClient().setFieldEncryption(request.config);
    case 'setEncryptedCrdt':
      return requireClient().setEncryptedCrdt(request.config);
    case 'startRealtime':
      realtime.start(request.options);
      return true;
    case 'stopRealtime':
      realtime.stop();
      return true;
    case 'sendPresence':
      realtime.sendPresence(request.action, request.scopeKey, request.metadata);
      return true;
    case 'executeSql':
      return requireClient().executeSql(request.sql, request.params);
    case 'executeUnsafeSql':
      return requireClient().executeUnsafeSql(request.sql, request.params);
    case 'subscribeQuery':
      return requireClient().subscribeQuery(
        request.sql,
        request.params,
        request.tables
      );
    case 'unsubscribeQuery':
      requireClient().unsubscribeQuery(request.queryId);
      return true;
    case 'drainLiveQueryEvents':
      return requireClient().drainLiveQueryEvents();
    case 'applyMutation':
      return requireClient().applyMutation(request.operation, request.localRow);
    case 'applyMutationsBatch':
      return requireClient().applyMutationsBatch(request.operations);
    case 'applyMutationsCommit':
      return requireClient().applyMutationsCommit(request.operations);
    case 'syncPull':
      return requireClient().syncPull({ syncAttempt: request.syncAttempt });
    case 'syncPush':
      return requireClient().syncPush({ syncAttempt: request.syncAttempt });
    case 'syncOnce':
      return requireClient().syncOnce({ syncAttempt: request.syncAttempt });
    case 'transportStats':
      return requireClient().transportStats();
    case 'resetTransportStats':
      requireClient().resetTransportStats();
      return true;
    case 'conflictSummaries':
      return requireClient().conflictSummaries();
    case 'retryConflictKeepLocal':
      return requireClient().retryConflictKeepLocal(request.conflictId);
    case 'resolveConflict':
      return requireClient().resolveConflict(
        request.conflictId,
        request.resolution
      );
    case 'listTable':
      return requireClient().listTable(request.table);
    case 'storeBlob':
      return requireClient().storeBlob(request.data, request.options);
    case 'retrieveBlob':
      return requireClient().retrieveBlob(request.ref);
    case 'isBlobLocal':
      return requireClient().isBlobLocal(request.hash);
    case 'processBlobUploadQueue':
      return requireClient().processBlobUploadQueue();
    case 'blobUploadQueueStats':
      return requireClient().blobUploadQueueStats();
    case 'blobCacheStats':
      return requireClient().blobCacheStats();
    case 'pruneBlobCache':
      return requireClient().pruneBlobCache(request.maxBytes);
    case 'clearBlobCache':
      return requireClient().clearBlobCache();
    case 'compactStorage':
      return requireClient().compactStorage(request.options);
    case 'generatedSchemaState':
      return requireClient().generatedSchemaState();
    case 'localHealthCheck':
      return requireClient().localHealthCheck();
    case 'repairLocalHealth':
      return requireClient().repairLocalHealth(request.request);
    case 'resetLocalSyncState':
      return requireClient().resetLocalSyncState(request.request);
    case 'buildYjsTextUpdate':
      return requireClient().buildYjsTextUpdate(request.args);
    case 'applyYjsTextUpdates':
      return requireClient().applyYjsTextUpdates(request.args);
    case 'applyYjsEnvelopeToPayload':
      return requireClient().applyYjsEnvelopeToPayload(request.args);
    case 'openCrdtField':
      return requireClient().openCrdtField(request.request);
    case 'applyCrdtFieldText':
      return requireClient().applyCrdtFieldText(request.request);
    case 'applyCrdtFieldYjsUpdate':
      return requireClient().applyCrdtFieldYjsUpdate(request.request);
    case 'materializeCrdtField':
      return requireClient().materializeCrdtField(request.request);
    case 'crdtDocumentSnapshot':
      return requireClient().crdtDocumentSnapshot(request.request);
    case 'crdtUpdateLog':
      return requireClient().crdtUpdateLog(request.request);
    case 'snapshotCrdtFieldStateVector':
      return requireClient().snapshotCrdtFieldStateVector(request.request);
    case 'compactCrdtField':
      return requireClient().compactCrdtField(request.request);
    case 'encryptionHelper':
      return requireClient().encryptionHelper(request.method, request.args);
    case 'runtimeInfo':
      return runtimeInfo();
    case 'close':
      realtime.stop();
      detachRowsChangedListener();
      client?.close();
      client = undefined;
      openedConfig = undefined;
      openedRuntime = undefined;
      return true;
  }
}

async function runtimeInfo(): Promise<
  ReturnType<typeof createSyncularV2RuntimeInfo>
> {
  const wasmUrl = getSyncularV2WasmUrl();
  const selectedWasmUrl = openedRuntime?.wasmUrl ?? wasmUrl;
  const selectedWasmGlueUrl =
    openedRuntime?.wasmGlueUrl ?? getSyncularV2WasmGlueUrl();
  return createSyncularV2RuntimeInfo({
    storage: openedConfig?.storage,
    workerUrl:
      typeof self.location?.href === 'string' ? self.location.href : '',
    wasmGlueUrl: selectedWasmGlueUrl,
    wasmUrl: selectedWasmUrl,
    rust: await getSyncularV2RustRuntimeInfo(
      openedRuntime?.wasmGlueUrl
        ? loadWorkerWasmGlue(openedRuntime.wasmGlueUrl)
        : undefined,
      selectedWasmUrl
    ),
  });
}

function loadWorkerWasmGlue(wasmGlueUrl: string): Promise<SyncularV2WasmGlue> {
  return import(/* @vite-ignore */ wasmGlueUrl) as Promise<SyncularV2WasmGlue>;
}

function requireClient(): SyncularV2RustClient {
  if (!client) {
    throw createSyncularV2WorkerErrorPayload(
      'worker.not_open',
      'Syncular v2 worker client is not open'
    );
  }
  return client;
}

function attachRowsChangedListener(nextClient: SyncularV2RustClient): void {
  removeRowsChangedListener = nextClient.addRowsChangedListener((event) => {
    post({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
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

function post(message: SyncularV2WorkerOutboundMessage): void {
  self.postMessage(message);
}

function createAbortController(
  type: SyncularV2WorkerRequest['type']
): AbortController | undefined {
  if (!isAbortableRequest(type) || typeof AbortController === 'undefined') {
    return undefined;
  }
  return new AbortController();
}

function isAbortableRequest(type: SyncularV2WorkerRequest['type']): boolean {
  return (
    type === 'syncPull' ||
    type === 'syncPush' ||
    type === 'syncOnce' ||
    type === 'storeBlob' ||
    type === 'retrieveBlob' ||
    type === 'processBlobUploadQueue'
  );
}

function clearClientAbortSignal(): void {
  try {
    client?.setAbortSignal(null);
  } catch {
    // Best effort after a request completed, failed, or closed the client.
  }
}

function postDiagnostic(
  event: Omit<SyncularV2DiagnosticEvent, 'at'> & { at?: number }
): void {
  self.postMessage({
    protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
    type: 'diagnostic',
    event: {
      at: event.at ?? Date.now(),
      level: event.level,
      source: event.source,
      code: event.code,
      message: event.message,
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
  request: SyncularV2WorkerRequest,
  value: unknown,
  durationMs: number
): void {
  if (!isDiagnosedSuccessRequest(request.type)) return;
  const syncRevocation = syncScopeRevocationDetails(value);
  postDiagnostic({
    level: 'info',
    source: requestDiagnosticSource(request.type),
    code: `${requestDiagnosticSource(request.type)}.${request.type}.completed`,
    message: `Syncular v2 worker request ${request.type} completed`,
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
      message: 'Syncular v2 subscription scope revoked',
      ...requestSyncAttemptDiagnosticFields(request),
      details: {
        requestType: request.type,
        ...syncRevocation,
      },
    });
  }
}

function requestSyncAttemptDiagnosticFields(
  request: SyncularV2WorkerRequest
): Pick<SyncularV2DiagnosticEvent, 'syncAttemptId' | 'traceId' | 'spanId'> {
  if (
    request.type !== 'syncPull' &&
    request.type !== 'syncPush' &&
    request.type !== 'syncOnce'
  ) {
    return {};
  }
  return syncularV2DiagnosticAttemptFields(request.syncAttempt);
}

function isDiagnosedSuccessRequest(
  type: SyncularV2WorkerRequest['type']
): boolean {
  return (
    type === 'open' ||
    type === 'close' ||
    type === 'setAuthHeaders' ||
    type === 'setFieldEncryption' ||
    type === 'setEncryptedCrdt' ||
    type === 'startRealtime' ||
    type === 'stopRealtime' ||
    type === 'forceSubscriptionsBootstrap' ||
    type === 'syncPull' ||
    type === 'syncPush' ||
    type === 'syncOnce' ||
    type === 'storeBlob' ||
    type === 'retrieveBlob' ||
    type === 'processBlobUploadQueue' ||
    type === 'clearBlobCache' ||
    type === 'pruneBlobCache' ||
    type === 'compactStorage' ||
    type === 'repairLocalHealth' ||
    type === 'resetLocalSyncState'
  );
}

function requestDiagnosticSource(
  type: SyncularV2WorkerRequest['type']
): SyncularV2DiagnosticEvent['source'] {
  if (type === 'setAuthHeaders') return 'auth';
  if (type === 'setFieldEncryption') return 'client';
  if (type === 'setEncryptedCrdt') return 'client';
  if (type === 'encryptionHelper') return 'client';
  if (type === 'startRealtime' || type === 'stopRealtime') return 'realtime';
  if (
    type === 'syncPull' ||
    type === 'syncPush' ||
    type === 'syncOnce' ||
    type === 'setSubscriptions' ||
    type === 'forceSubscriptionsBootstrap'
  ) {
    return 'sync';
  }
  if (
    type === 'storeBlob' ||
    type === 'retrieveBlob' ||
    type === 'processBlobUploadQueue' ||
    type === 'blobUploadQueueStats' ||
    type === 'blobCacheStats' ||
    type === 'clearBlobCache' ||
    type === 'pruneBlobCache' ||
    type === 'isBlobLocal'
  ) {
    return 'blob';
  }
  if (
    type === 'open' ||
    type === 'close' ||
    type === 'generatedSchemaState' ||
    type === 'localHealthCheck' ||
    type === 'repairLocalHealth' ||
    type === 'resetLocalSyncState' ||
    type === 'compactStorage'
  ) {
    return 'storage';
  }
  return 'worker';
}

function requestDiagnosticLevel(
  type: SyncularV2WorkerRequest['type'],
  error: unknown
): SyncularV2DiagnosticEvent['level'] {
  if (type === 'setAuthHeaders' || syncularV2ErrorStatus(error)) return 'warn';
  return 'error';
}

function requestSuccessDetails(
  request: SyncularV2WorkerRequest,
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

function syncScopeRevocationDetails(
  value: unknown
): { revokedSubscriptionIds: string[]; revokedSubscriptionCount: number } | null {
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
  const status = syncularV2ErrorStatus(error);
  return status ? { status } : {};
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return syncularV2ErrorMessage(error);
}

function errorRequiresFullRefresh(error: unknown): boolean {
  return errorMessage(error).includes('full snapshot resync required');
}

function encodeWorkerError(error: unknown): SyncularV2WorkerErrorPayload {
  if (isWorkerErrorPayload(error) && !(error instanceof Error)) return error;
  if (error instanceof SyncularV2ClientError) {
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
    const details = syncularV2ErrorDetails(error);
    const classification = classifySyncularV2Error(
      error,
      error.message,
      details
    );
    if (!classification) {
      return createSyncularV2WorkerErrorPayload('worker.failed', error.message, {
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
  const classification = classifySyncularV2Error(error, message);
  if (!classification) {
    return createSyncularV2WorkerErrorPayload('worker.failed', message);
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
): value is SyncularV2WorkerErrorPayload {
  return Boolean(
    value && typeof value === 'object' && 'code' in value && 'message' in value
  );
}
