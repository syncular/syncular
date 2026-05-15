import { resolveSyncularV2ClientConfig } from './client-config';
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
  SyncularV2WorkerRequest,
  SyncularV2WorkerResponse,
  SyncularV2WorkerRuntimeArtifact,
} from './worker-protocol';
import { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';
import { SyncularV2WorkerRealtimeController } from './worker-realtime';

let client: SyncularV2RustClient | undefined;
let openedConfig: SyncularV2ClientConfig | undefined;
let openedRuntime: SyncularV2WorkerRuntimeArtifact | undefined;
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
      error: {
        code: 'protocol_mismatch',
        message: `Unsupported Syncular v2 worker protocol ${request.protocolVersion}`,
        details: { supported: SYNCULAR_V2_WORKER_PROTOCOL_VERSION },
      },
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
    postDiagnostic({
      level: requestDiagnosticLevel(request.type, err),
      source: requestDiagnosticSource(request.type),
      code: `${requestDiagnosticSource(request.type)}.${request.type}.failed`,
      message: `Syncular v2 worker request ${request.type} failed`,
      details: {
        requestType: request.type,
        durationMs: Date.now() - startedAt,
        error: errorMessage(err),
        ...diagnosticStatus(err),
      },
    });
    post({
      id: request.id,
      protocolVersion: request.protocolVersion,
      ok: false,
      error: encodeWorkerError(err),
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
        openedConfig = config;
        openedRuntime = runtime;
      }
      return true;
    case 'setSubscriptions':
      return requireClient().setSubscriptions(request.subscriptions);
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
    case 'applyLocalOperation':
      return requireClient().applyLocalOperation(
        request.operation,
        request.localRow
      );
    case 'applyLocalOperationsBatch':
      return requireClient().applyLocalOperationsBatch(request.operations);
    case 'applyLocalOperationsCommit':
      return requireClient().applyLocalOperationsCommit(request.operations);
    case 'syncPull':
      return requireClient().syncPull();
    case 'syncPush':
      return requireClient().syncPush();
    case 'syncOnce':
      return requireClient().syncOnce();
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
    throw {
      code: 'not_open',
      message: 'Syncular v2 worker client is not open',
    } satisfies SyncularV2WorkerErrorPayload;
  }
  return client;
}

function post(response: SyncularV2WorkerResponse): void {
  self.postMessage(response);
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
  postDiagnostic({
    level: 'info',
    source: requestDiagnosticSource(request.type),
    code: `${requestDiagnosticSource(request.type)}.${request.type}.completed`,
    message: `Syncular v2 worker request ${request.type} completed`,
    details: {
      requestType: request.type,
      durationMs,
      ...requestSuccessDetails(request, value),
    },
  });
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
    type === 'syncPull' ||
    type === 'syncPush' ||
    type === 'syncOnce' ||
    type === 'storeBlob' ||
    type === 'retrieveBlob' ||
    type === 'processBlobUploadQueue' ||
    type === 'clearBlobCache' ||
    type === 'pruneBlobCache' ||
    type === 'compactStorage'
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
    type === 'setSubscriptions'
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
  if (type === 'setAuthHeaders' || httpStatusFromError(error)) return 'warn';
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
  return {
    changedTables,
    changedTableCount: changedTables.length,
    pushedCommits:
      typeof result.pushedCommits === 'number' ? result.pushedCommits : 0,
  };
}

function diagnosticStatus(error: unknown): Record<string, unknown> {
  const status = httpStatusFromError(error);
  return status ? { status } : {};
}

function httpStatusFromError(error: unknown): 401 | 403 | undefined {
  if (error instanceof Error)
    return httpStatusFromMessage(error.message)?.status;
  if (isWorkerErrorPayload(error)) {
    const details = error.details;
    if (
      details &&
      typeof details === 'object' &&
      'status' in details &&
      (details.status === 401 || details.status === 403)
    ) {
      return details.status;
    }
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeWorkerError(error: unknown): SyncularV2WorkerErrorPayload {
  if (isWorkerErrorPayload(error)) return error;
  if (error instanceof Error) {
    return {
      code: 'worker_error',
      message: error.message,
      name: error.name,
      stack: error.stack,
      details: workerErrorDetails(error),
    };
  }
  return {
    code: 'worker_error',
    message: String(error),
  };
}

function httpStatusFromMessage(
  message: string
): { status: 401 | 403 } | undefined {
  const match = /\bHTTP (401|403)\b/.exec(message);
  if (!match) return undefined;
  return { status: match[1] === '401' ? 401 : 403 };
}

function workerErrorDetails(error: Error): Record<string, unknown> | undefined {
  const source = error as Error & {
    syncularKind?: unknown;
    syncularDebug?: unknown;
  };
  const details: Record<string, unknown> = {
    ...(httpStatusFromMessage(error.message) ?? {}),
    ...(typeof source.syncularKind === 'string'
      ? { syncularKind: source.syncularKind }
      : {}),
    ...(typeof source.syncularDebug === 'string'
      ? { syncularDebug: source.syncularDebug }
      : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

function isWorkerErrorPayload(
  value: unknown
): value is SyncularV2WorkerErrorPayload {
  return Boolean(
    value && typeof value === 'object' && 'code' in value && 'message' in value
  );
}
