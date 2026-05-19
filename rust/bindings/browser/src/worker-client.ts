import type { BlobRef, SyncAuthOperation, SyncOperation } from '@syncular/core';
import {
  resolveSyncularV2ClientConfig,
  SYNCULAR_V2_DEFAULT_STORAGE,
} from './client-config';
import { assertSyncularV2ReadonlySql } from './sql-safety';
import type {
  CreateSyncularV2DatabaseOptions,
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularApplyYjsTextUpdatesResult,
  SyncularBuildYjsTextUpdateArgs,
  SyncularBuildYjsTextUpdateResult,
  SyncularV2AuthHeaders,
  SyncularV2BlobCacheStats,
  SyncularV2BlobUploadErrorEvent,
  SyncularV2BlobUploadEvent,
  SyncularV2BlobStoreOptions,
  SyncularV2BlobUploadQueueStats,
  SyncularV2Client,
  SyncularV2ClientEventMap,
  SyncularV2ClientEventSink,
  SyncularV2ClientEventType,
  SyncularV2ClientConfig,
  SyncularV2ConflictSummary,
  SyncularV2ConflictStats,
  SyncularV2ConnectionState,
  SyncularV2CrdtFieldCompactionReceipt,
  SyncularV2CrdtFieldCompactionRequest,
  SyncularV2CrdtFieldDescriptor,
  SyncularV2CrdtFieldMaterialization,
  SyncularV2CrdtFieldRequest,
  SyncularV2CrdtFieldTextRequest,
  SyncularV2CrdtFieldWriteReceipt,
  SyncularV2CrdtFieldYjsUpdateRequest,
  SyncularV2CrdtDocumentSnapshot,
  SyncularV2CrdtUpdateLogEntry,
  SyncularV2DiagnosticEvent,
  SyncularV2DiagnosticSink,
  SyncularV2EncryptedCrdtConfig,
  SyncularV2EncryptionHelperMethod,
  SyncularV2FieldEncryptionConfig,
  SyncularV2LiveQueryEvent,
  SyncularV2LiveQuerySnapshot,
  SyncularV2OutboxStats,
  SyncularV2PresenceEntry,
  SyncularV2PresenceSink,
  SyncularV2RealtimeConnectionState,
  SyncularV2RealtimeOptions,
  SyncularV2RowsChangedSink,
  SyncularV2RuntimeInfo,
  SyncularV2SchemaState,
  SyncularV2SqlResult,
  SyncularV2StorageCompactionOptions,
  SyncularV2StorageCompactionReport,
  SyncularV2StorageFallbackInfo,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncResult,
  SyncularV2TransportStats,
} from './types';
import { selectSyncularV2RuntimeArtifact } from './wasm-runtime';
import type {
  SyncularV2WorkerErrorPayload,
  SyncularV2WorkerOutboundMessage,
  SyncularV2WorkerRealtimeOptions,
  SyncularV2WorkerRequest,
  SyncularV2WorkerResponse,
  SyncularV2WorkerRuntimeArtifact,
} from './worker-protocol';
import { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';

type PendingRequest = {
  type: SyncularV2WorkerRequestInput['type'];
  timeout: ReturnType<typeof setTimeout> | undefined;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

type BlobOutboxRow = {
  hash: string;
  size: number;
  mime_type: string;
  status: string;
  error: string | null;
};

type SyncularV2WorkerRequestInput =
  SyncularV2WorkerRequest extends infer Request
    ? Request extends SyncularV2WorkerRequest
      ? Omit<Request, 'id' | 'protocolVersion'>
      : never
    : never;

const DEFAULT_SYNCULAR_V2_WORKER_REQUEST_TIMEOUT_MS = 30_000;

export async function createSyncularV2WorkerClient(
  options: CreateSyncularV2DatabaseOptions
): Promise<SyncularV2WorkerClient> {
  const config = resolveSyncularV2ClientConfig(options.config);
  const runtime =
    options.runtime ??
    selectSyncularV2RuntimeArtifact(
      options.requiredRuntimeFeatures,
      options.runtimeArtifacts
    );
  const worker =
    typeof options.worker === 'function'
      ? options.worker()
      : (options.worker ?? createDefaultSyncularV2Worker());
  const client = new SyncularV2WorkerClient(worker, {
    ownsWorker: options.worker == null,
    requestTimeoutMs: options.requestTimeoutMs,
    getHeaders: options.getHeaders,
    authLifecycle: options.authLifecycle,
    diagnostics: options.diagnostics,
    rowsChangedDebounceMs: options.sync?.rowsChangedDebounceMs,
  });
  try {
    await client.open(config, runtime);
  } catch (err) {
    if (
      options.config.storage == null &&
      config.storage === SYNCULAR_V2_DEFAULT_STORAGE &&
      isOpfsOpenFailure(err)
    ) {
      const fallbackConfig = { ...config, storage: 'indexedDb' as const };
      client.setStorageFallback({
        from: SYNCULAR_V2_DEFAULT_STORAGE,
        to: fallbackConfig.storage,
        reason: errorMessage(err),
      });
      await client.open(fallbackConfig, runtime);
    } else {
      throw err;
    }
  }
  if (options.realtime) {
    await client.startRealtime(options.realtime);
  }
  return client;
}

export function getDefaultSyncularV2WorkerUrl(): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith('/src/worker-client.ts');
  return new URL(
    sourceRuntime ? './worker-entry.ts' : './worker-entry.js',
    runtimeUrl
  );
}

export function createDefaultSyncularV2Worker(): Worker {
  return new Worker(getDefaultSyncularV2WorkerUrl(), {
    type: 'module',
    credentials: 'same-origin',
  });
}

export class SyncularV2WorkerError extends Error {
  readonly code: SyncularV2WorkerErrorPayload['code'];
  readonly details: unknown;

  constructor(payload: SyncularV2WorkerErrorPayload) {
    super(payload.message);
    this.name = payload.name ?? 'SyncularV2WorkerError';
    this.code = payload.code;
    this.details = payload.details;
    if (payload.stack) this.stack = payload.stack;
  }
}

export class SyncularV2WorkerClient implements SyncularV2Client {
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #closed = false;
  #requestTimeoutMs: number;
  #getHeaders: CreateSyncularV2DatabaseOptions['getHeaders'] | undefined;
  #authLifecycle: CreateSyncularV2DatabaseOptions['authLifecycle'] | undefined;
  #authRefreshInFlight: Promise<boolean> | undefined;
  #config: SyncularV2ClientConfig | undefined;
  #realtimeOptions: SyncularV2RealtimeOptions | undefined;
  #realtimeState: SyncularV2RealtimeConnectionState = 'disconnected';
  #storageFallback: SyncularV2StorageFallbackInfo | undefined;
  #lastDiagnostic: SyncularV2DiagnosticEvent | undefined;
  #lastError: { message: string; code?: string } | undefined;
  #rowsChangedDebounceMs: number | false;
  #rowsChangedDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingRowsChanged:
    | {
        source: string;
        changedTables: Set<string>;
        changedRows: SyncularV2SyncResult['changedRows'];
        changedRowsTruncated: boolean;
      }
    | undefined;
  #lastOutboxStats: SyncularV2OutboxStats | undefined;
  #lastConflictStats: SyncularV2ConflictStats | undefined;
  #diagnosticListeners = new Set<SyncularV2DiagnosticSink>();
  #rowsChangedListeners = new Set<SyncularV2RowsChangedSink>();
  #eventListeners = new Map<
    SyncularV2ClientEventType,
    Set<SyncularV2ClientEventSink<SyncularV2ClientEventType>>
  >();
  #presenceByScopeKey = new Map<string, SyncularV2PresenceEntry[]>();
  #joinedPresence = new Map<string, Record<string, unknown> | undefined>();
  #liveListeners = new Map<
    string,
    (event: SyncularV2LiveQueryEvent<Record<string, unknown>>) => void
  >();

  constructor(
    private readonly worker: Worker,
    options: {
      ownsWorker: boolean;
      requestTimeoutMs?: number;
      getHeaders?: CreateSyncularV2DatabaseOptions['getHeaders'];
      authLifecycle?: CreateSyncularV2DatabaseOptions['authLifecycle'];
      diagnostics?: SyncularV2DiagnosticSink;
      rowsChangedDebounceMs?: number | false;
    }
  ) {
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SYNCULAR_V2_WORKER_REQUEST_TIMEOUT_MS;
    this.#getHeaders = options.getHeaders;
    this.#authLifecycle = options.authLifecycle;
    this.#rowsChangedDebounceMs =
      options.rowsChangedDebounceMs === false
        ? false
        : Math.max(0, options.rowsChangedDebounceMs ?? 0);
    if (options.diagnostics) {
      this.#diagnosticListeners.add(options.diagnostics);
    }
    this.worker.onmessage = (
      event: MessageEvent<SyncularV2WorkerOutboundMessage>
    ) => {
      this.#handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event) => {
      const payload = {
        code: 'worker_failed',
        message: event.message || 'Syncular v2 worker failed',
      } as const;
      this.#emitDiagnostic({
        level: 'error',
        source: 'worker',
        code: 'worker.failed',
        message: payload.message,
      });
      this.#rejectAll(payload);
    };
    this.worker.onmessageerror = () => {
      const payload = {
        code: 'worker_failed',
        message: 'Syncular v2 worker sent an unreadable message',
      } as const;
      this.#emitDiagnostic({
        level: 'error',
        source: 'worker',
        code: 'worker.message_unreadable',
        message: payload.message,
      });
      this.#rejectAll(payload);
    };
    this.ownsWorker = options.ownsWorker;
  }

  private readonly ownsWorker: boolean;

  async open(
    config: CreateSyncularV2DatabaseOptions['config'],
    runtime?: CreateSyncularV2DatabaseOptions['runtime']
  ): Promise<void> {
    await this.#request({
      type: 'open',
      config,
      runtime: serializeRuntimeArtifact(runtime),
    });
    this.#config = config;
    this.#realtimeOptions = undefined;
    await this.#refreshAuthHeaders();
  }

  async setAuthHeaders(headers: SyncularV2AuthHeaders): Promise<void> {
    await this.#setAuthHeaders(headers, { restartRealtime: true });
  }

  async setFieldEncryption(
    config: SyncularV2FieldEncryptionConfig | null
  ): Promise<void> {
    await this.#request({
      type: 'setFieldEncryption',
      config: config == null ? null : normalizeFieldEncryptionConfig(config),
    });
  }

  async setEncryptedCrdt(
    config: SyncularV2EncryptedCrdtConfig | null
  ): Promise<void> {
    await this.#request({
      type: 'setEncryptedCrdt',
      config: config == null ? null : normalizeEncryptedCrdtConfig(config),
    });
  }

  async #setAuthHeaders(
    headers: SyncularV2AuthHeaders,
    options: { restartRealtime: boolean }
  ): Promise<void> {
    await this.#request({
      type: 'setAuthHeaders',
      headers: cloneAuthHeaders(headers),
    });
    if (options.restartRealtime) await this.#restartRealtime();
  }

  async startRealtime(
    options: boolean | SyncularV2RealtimeOptions = {}
  ): Promise<void> {
    if (options === false) {
      await this.stopRealtime();
      return;
    }
    const config = this.#config;
    if (!config) {
      throw new Error(
        'Syncular v2 worker client must be opened before realtime'
      );
    }
    const realtimeOptions = options === true ? {} : options;
    if (realtimeOptions.enabled === false) {
      await this.stopRealtime();
      return;
    }
    this.#realtimeOptions = realtimeOptions;
    await this.#refreshAuthHeaders({ restartRealtime: false });
    await this.#request({
      type: 'startRealtime',
      options: await resolveRealtimeWorkerOptions(realtimeOptions, config),
    });
  }

  async stopRealtime(): Promise<void> {
    this.#realtimeOptions = undefined;
    await this.#request({ type: 'stopRealtime' });
  }

  async setSubscriptions(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
  ): Promise<void> {
    await this.#request({
      type: 'setSubscriptions',
      subscriptions: [...subscriptions],
    });
  }

  async executeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<SyncularV2SqlResult<Row>> {
    assertSyncularV2ReadonlySql(sql);
    return this.#request({
      type: 'executeSql',
      sql,
      params: [...params],
    });
  }

  executeUnsafeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<SyncularV2SqlResult<Row>> {
    return this.#request({
      type: 'executeUnsafeSql',
      sql,
      params: [...params],
    });
  }

  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[]
  ): Promise<SyncularV2LiveQuerySnapshot<Row>> {
    return this.#request({
      type: 'subscribeQuery',
      sql,
      params: [...params],
      tables: [...tables],
    });
  }

  async unsubscribeQuery(id: string): Promise<void> {
    await this.#request({ type: 'unsubscribeQuery', queryId: id });
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Promise<Array<SyncularV2LiveQueryEvent<Row>>> {
    return this.#request({ type: 'drainLiveQueryEvents' });
  }

  async applyMutation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string> {
    return this.#requestAndDrain({
      type: 'applyMutation',
      operation,
      localRow,
    });
  }

  async applyMutationsBatch(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string[]> {
    return this.#requestAndDrain({
      type: 'applyMutationsBatch',
      operations,
    });
  }

  async applyMutationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string> {
    return this.#requestAndDrain({
      type: 'applyMutationsCommit',
      operations,
    });
  }

  async syncPull(): Promise<SyncularV2SyncResult> {
    return this.#syncWithAuthRetry({ type: 'syncPull' });
  }

  async syncPush(): Promise<SyncularV2SyncResult> {
    return this.#syncWithAuthRetry({ type: 'syncPush' });
  }

  async syncOnce(): Promise<SyncularV2SyncResult> {
    return this.#syncWithAuthRetry({ type: 'syncOnce' });
  }

  transportStats(): Promise<SyncularV2TransportStats> {
    return this.#request({ type: 'transportStats' });
  }

  async resetTransportStats(): Promise<void> {
    await this.#request({ type: 'resetTransportStats' });
  }

  conflictSummaries(): Promise<SyncularV2ConflictSummary[]> {
    return this.#request({ type: 'conflictSummaries' });
  }

  retryConflictKeepLocal(id: string): Promise<string> {
    return this.#requestAndDrain({
      type: 'retryConflictKeepLocal',
      conflictId: id,
    });
  }

  async resolveConflict(id: string, resolution: string): Promise<void> {
    await this.#requestAndDrain({
      type: 'resolveConflict',
      conflictId: id,
      resolution,
    });
  }

  listTable<Row extends Record<string, unknown> = Record<string, unknown>>(
    table: string
  ): Promise<Row[]> {
    return this.#request({ type: 'listTable', table });
  }

  storeBlob(
    data: Uint8Array,
    options?: SyncularV2BlobStoreOptions
  ): Promise<BlobRef> {
    const request = { type: 'storeBlob' as const, data, options };
    const result = options?.immediate
      ? this.#requestWithAuthRetry<BlobRef>(request, 'blobInitiateUpload')
      : this.#request<BlobRef>(request);
    return result.then((ref) => {
      if (options?.immediate) {
        this.#emitClientEvent('blobUploadCompleted', { ref });
      }
      void this.#emitOperationalState();
      return ref;
    });
  }

  retrieveBlob(ref: BlobRef): Promise<Uint8Array> {
    return this.#requestWithAuthRetry(
      { type: 'retrieveBlob', ref },
      'blobGetDownloadUrl'
    );
  }

  isBlobLocal(hash: string): Promise<boolean> {
    return this.#request({ type: 'isBlobLocal', hash });
  }

  async processBlobUploadQueue(): Promise<{ uploaded: number; failed: number }> {
    const observeBlobEvents =
      this.#hasClientEventListeners('blobUploadCompleted') ||
      this.#hasClientEventListeners('blobUploadFailed');
    const before = observeBlobEvents
      ? await this.#readBlobOutboxRows().catch(() => [])
      : [];
    const result = await this.#requestWithAuthRetry<{
      uploaded: number;
      failed: number;
    }>({ type: 'processBlobUploadQueue' }, 'blobInitiateUpload');
    if (observeBlobEvents) {
      const after = await this.#readBlobOutboxRows().catch(() => []);
      this.#emitBlobUploadEvents(before, after);
    }
    void this.#emitOperationalState();
    return result;
  }

  blobUploadQueueStats(): Promise<SyncularV2BlobUploadQueueStats> {
    return this.#request({ type: 'blobUploadQueueStats' });
  }

  blobCacheStats(): Promise<SyncularV2BlobCacheStats> {
    return this.#request({ type: 'blobCacheStats' });
  }

  pruneBlobCache(maxBytes?: number): Promise<number> {
    return this.#request({ type: 'pruneBlobCache', maxBytes });
  }

  async clearBlobCache(): Promise<void> {
    await this.#request({ type: 'clearBlobCache' });
  }

  compactStorage(
    options: SyncularV2StorageCompactionOptions = {}
  ): Promise<SyncularV2StorageCompactionReport> {
    return this.#request({ type: 'compactStorage', options });
  }

  generatedSchemaState(): Promise<SyncularV2SchemaState> {
    return this.#request({ type: 'generatedSchemaState' });
  }

  buildYjsTextUpdate(
    args: SyncularBuildYjsTextUpdateArgs
  ): Promise<SyncularBuildYjsTextUpdateResult> {
    return this.#request({ type: 'buildYjsTextUpdate', args });
  }

  applyYjsTextUpdates(
    args: SyncularApplyYjsTextUpdatesArgs
  ): Promise<SyncularApplyYjsTextUpdatesResult> {
    return this.#request({ type: 'applyYjsTextUpdates', args });
  }

  applyYjsEnvelopeToPayload(
    args: SyncularApplyYjsEnvelopeToPayloadArgs
  ): Promise<Record<string, unknown>> {
    return this.#request({ type: 'applyYjsEnvelopeToPayload', args });
  }

  openCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldDescriptor> {
    return this.#request({ type: 'openCrdtField', request });
  }

  applyCrdtFieldText(
    request: SyncularV2CrdtFieldTextRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt> {
    return this.#requestAndDrain({ type: 'applyCrdtFieldText', request });
  }

  applyCrdtFieldYjsUpdate(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt> {
    return this.#requestAndDrain({
      type: 'applyCrdtFieldYjsUpdate',
      request,
    });
  }

  materializeCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldMaterialization> {
    return this.#request({ type: 'materializeCrdtField', request });
  }

  crdtDocumentSnapshot(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtDocumentSnapshot> {
    return this.#request({ type: 'crdtDocumentSnapshot', request });
  }

  crdtUpdateLog(
    request: SyncularV2CrdtFieldRequest & { limit?: number }
  ): Promise<SyncularV2CrdtUpdateLogEntry[]> {
    return this.#request({ type: 'crdtUpdateLog', request });
  }

  snapshotCrdtFieldStateVector(
    request: SyncularV2CrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }> {
    return this.#request({ type: 'snapshotCrdtFieldStateVector', request });
  }

  compactCrdtField(
    request: SyncularV2CrdtFieldCompactionRequest
  ): Promise<SyncularV2CrdtFieldCompactionReceipt> {
    return this.#requestAndDrain({ type: 'compactCrdtField', request });
  }

  encryptionHelper(
    method: SyncularV2EncryptionHelperMethod,
    args: unknown = {}
  ): Promise<unknown> {
    return this.#request({ type: 'encryptionHelper', method, args });
  }

  runtimeInfo(): Promise<SyncularV2RuntimeInfo> {
    return this.#request<SyncularV2RuntimeInfo>({ type: 'runtimeInfo' }).then(
      (info) => ({
        ...info,
        storageFallback: this.#storageFallback,
      })
    );
  }

  connectionState(): SyncularV2ConnectionState {
    return {
      closed: this.#closed,
      pendingRequests: this.#pending.size,
      realtime: this.#realtimeState,
      ...(this.#storageFallback
        ? { storageFallback: this.#storageFallback }
        : {}),
      ...(this.#lastDiagnostic ? { lastDiagnostic: this.#lastDiagnostic } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  setStorageFallback(fallback: SyncularV2StorageFallbackInfo): void {
    this.#storageFallback = fallback;
    this.#emitDiagnostic({
      level: 'warn',
      source: 'storage',
      code: 'storage.fallback',
      message: `Syncular v2 storage fell back from ${fallback.from} to ${fallback.to}`,
      details: {
        from: fallback.from,
        to: fallback.to,
        reason: fallback.reason,
      },
    });
  }

  addDiagnosticListener(listener: SyncularV2DiagnosticSink): () => void {
    this.#diagnosticListeners.add(listener);
    return () => {
      this.#diagnosticListeners.delete(listener);
    };
  }

  addEventListener<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void {
    const listeners = this.#eventListeners.get(event) ?? new Set();
    listeners.add(
      listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
    );
    this.#eventListeners.set(event, listeners);
    return () => {
      listeners.delete(
        listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
      );
      if (listeners.size === 0) this.#eventListeners.delete(event);
    };
  }

  addRowsChangedListener(listener: SyncularV2RowsChangedSink): () => void {
    this.#rowsChangedListeners.add(listener);
    return () => {
      this.#rowsChangedListeners.delete(listener);
    };
  }

  getPresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[] {
    return (this.#presenceByScopeKey.get(scopeKey) ??
      []) as SyncularV2PresenceEntry<TMetadata>[];
  }

  joinPresence(scopeKey: string, metadata?: Record<string, unknown>): void {
    this.#joinedPresence.set(scopeKey, metadata);
    void this.#request({
      type: 'sendPresence',
      action: 'join',
      scopeKey,
      ...(metadata === undefined ? {} : { metadata }),
    }).catch((error) => {
      this.#emitDiagnostic({
        level: 'warn',
        source: 'realtime',
        code: 'realtime.presence_join_failed',
        message: `Syncular v2 presence join failed: ${errorMessage(error)}`,
        details: { scopeKey },
      });
    });
    this.#applyPresenceEvent({
      action: 'join',
      scopeKey,
      clientId: this.#config?.clientId ?? '',
      actorId: this.#config?.actorId ?? '',
      metadata,
    });
  }

  leavePresence(scopeKey: string): void {
    this.#joinedPresence.delete(scopeKey);
    void this.#request({
      type: 'sendPresence',
      action: 'leave',
      scopeKey,
    }).catch((error) => {
      this.#emitDiagnostic({
        level: 'warn',
        source: 'realtime',
        code: 'realtime.presence_leave_failed',
        message: `Syncular v2 presence leave failed: ${errorMessage(error)}`,
        details: { scopeKey },
      });
    });
    this.#applyPresenceEvent({
      action: 'leave',
      scopeKey,
      clientId: this.#config?.clientId ?? '',
      actorId: this.#config?.actorId ?? '',
    });
  }

  updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void {
    if (this.#joinedPresence.has(scopeKey)) {
      this.#joinedPresence.set(scopeKey, metadata);
    }
    void this.#request({
      type: 'sendPresence',
      action: 'update',
      scopeKey,
      metadata,
    }).catch((error) => {
      this.#emitDiagnostic({
        level: 'warn',
        source: 'realtime',
        code: 'realtime.presence_update_failed',
        message: `Syncular v2 presence update failed: ${errorMessage(error)}`,
        details: { scopeKey },
      });
    });
    this.#applyPresenceEvent({
      action: 'update',
      scopeKey,
      clientId: this.#config?.clientId ?? '',
      actorId: this.#config?.actorId ?? '',
      metadata,
    });
  }

  addPresenceListener<TMetadata = Record<string, unknown>>(
    listener: SyncularV2PresenceSink<TMetadata>
  ): () => void {
    return this.addEventListener(
      'presenceChanged',
      listener as SyncularV2ClientEventSink<'presenceChanged'>
    );
  }

  addLiveQueryListener(
    queryId: string,
    listener: (event: SyncularV2LiveQueryEvent<Record<string, unknown>>) => void
  ): void {
    this.#liveListeners.set(queryId, listener);
  }

  removeLiveQueryListener(queryId: string): void {
    this.#liveListeners.delete(queryId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#realtimeState = 'disconnected';
    try {
      await this.#request({ type: 'close' });
    } finally {
      this.#flushRowsChanged();
      this.#rejectAll(new Error('Syncular v2 worker client closed'));
      if (this.ownsWorker) this.worker.terminate();
    }
  }

  async #requestAndDrain<T>(request: SyncularV2WorkerRequestInput): Promise<T> {
    const value = await this.#request<T>(request);
    await this.#emitLiveEvents();
    if (shouldEmitOperationalState(request.type)) {
      void this.#emitOperationalState();
    }
    return value;
  }

  async #syncWithAuthRetry(
    request: Extract<
      SyncularV2WorkerRequestInput,
      { type: 'syncPull' | 'syncPush' | 'syncOnce' }
    >
  ): Promise<SyncularV2SyncResult> {
    await this.#refreshAuthHeaders();
    try {
      const result = await this.#requestAndDrain<SyncularV2SyncResult>(request);
      this.#emitBootstrapChanged(result);
      return result;
    } catch (error) {
      const shouldRetry = await this.#resolveAuthRetry(error, 'sync');
      if (!shouldRetry) throw error;
      await this.#refreshAuthHeaders();
      const result = await this.#requestAndDrain<SyncularV2SyncResult>(request);
      this.#emitBootstrapChanged(result);
      return result;
    }
  }

  async #requestWithAuthRetry<T>(
    request: SyncularV2WorkerRequestInput,
    operation: SyncAuthOperation
  ): Promise<T> {
    await this.#refreshAuthHeaders();
    try {
      return await this.#request<T>(request);
    } catch (error) {
      const shouldRetry = await this.#resolveAuthRetry(error, operation);
      if (!shouldRetry) throw error;
      await this.#refreshAuthHeaders();
      return this.#request<T>(request);
    }
  }

  async #refreshAuthHeaders(
    options: { restartRealtime: boolean } = { restartRealtime: true }
  ): Promise<void> {
    if (!this.#getHeaders) return;
    const headers = await this.#getHeaders();
    this.#emitDiagnostic({
      level: 'debug',
      source: 'auth',
      code: 'auth.headers_refreshed',
      message: 'Syncular v2 auth headers refreshed',
      details: { headerCount: Object.keys(headers).length },
    });
    await this.#setAuthHeaders(headers, options);
  }

  async #restartRealtime(): Promise<void> {
    const realtimeOptions = this.#realtimeOptions;
    const config = this.#config;
    if (!realtimeOptions || !config || this.#closed) return;
    await this.#request({
      type: 'startRealtime',
      options: await resolveRealtimeWorkerOptions(realtimeOptions, config),
    });
  }

  async #resolveAuthRetry(
    error: unknown,
    operation: SyncAuthOperation
  ): Promise<boolean> {
    const status = authStatusFromError(error);
    const lifecycle = this.#authLifecycle;
    if (!status || !lifecycle) return false;

    const context = { operation, status };
    this.#emitDiagnostic({
      level: 'warn',
      source: 'auth',
      code: 'auth.expired',
      message: `Syncular v2 auth expired during ${operation}`,
      details: context,
    });
    await lifecycle.onAuthExpired?.(context);
    const refreshResult = await this.#refreshAuthSingleFlight(context);
    this.#emitDiagnostic({
      level: refreshResult ? 'info' : 'warn',
      source: 'auth',
      code: refreshResult ? 'auth.refresh_succeeded' : 'auth.refresh_failed',
      message: refreshResult
        ? 'Syncular v2 auth refresh succeeded'
        : 'Syncular v2 auth refresh did not produce fresh credentials',
      details: context,
    });
    if (lifecycle.retryWithFreshToken) {
      return Boolean(
        await lifecycle.retryWithFreshToken({ ...context, refreshResult })
      );
    }
    return refreshResult;
  }

  #refreshAuthSingleFlight(context: {
    operation: SyncAuthOperation;
    status: 401 | 403;
  }): Promise<boolean> {
    const refreshToken = this.#authLifecycle?.refreshToken;
    if (!refreshToken) return Promise.resolve(false);
    this.#authRefreshInFlight ??= Promise.resolve(refreshToken(context))
      .then(Boolean)
      .finally(() => {
        this.#authRefreshInFlight = undefined;
      });
    return this.#authRefreshInFlight;
  }

  async #emitLiveEvents(): Promise<void> {
    const events = await this.drainLiveQueryEvents<Record<string, unknown>>();
    for (const event of events) {
      this.#liveListeners.get(event.queryId)?.(event);
    }
  }

  #request<T>(request: SyncularV2WorkerRequestInput): Promise<T> {
    if (this.#closed && request.type !== 'close') {
      return Promise.reject(new Error('Syncular v2 worker client is closed'));
    }
    const id = this.#nextId++;
    const message = {
      ...request,
      id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
    } as SyncularV2WorkerRequest;
    return new Promise<T>((resolve, reject) => {
      const timeout =
        this.#requestTimeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              this.#sendCancel(id);
              this.#emitDiagnostic({
                level: 'warn',
                source: 'worker',
                code: 'worker.request_timeout',
                message: `Syncular v2 worker request ${request.type} timed out`,
                details: {
                  requestId: id,
                  requestType: request.type,
                  timeoutMs: this.#requestTimeoutMs,
                },
              });
              const error = new SyncularV2WorkerError({
                code: 'request_timeout',
                message: `Syncular v2 worker request ${request.type} timed out after ${this.#requestTimeoutMs}ms`,
                details: { requestId: id, requestType: request.type },
              });
              this.#lastError = {
                message: error.message,
                code: error.code,
              };
              reject(error);
            }, this.#requestTimeoutMs)
          : undefined;
      this.#pending.set(id, {
        type: request.type,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage(message);
    });
  }

  #handleWorkerMessage(message: SyncularV2WorkerOutboundMessage): void {
    if (message.protocolVersion !== SYNCULAR_V2_WORKER_PROTOCOL_VERSION) {
      this.#rejectAll({
        code: 'protocol_mismatch',
        message: `Unsupported Syncular v2 worker protocol ${message.protocolVersion}`,
        details: { supported: SYNCULAR_V2_WORKER_PROTOCOL_VERSION },
      });
      return;
    }
    if (isWorkerEvent(message)) {
      this.#handleWorkerEvent(message);
      return;
    }
    this.#handleResponse(message);
  }

  #handleResponse(response: SyncularV2WorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      const error = new SyncularV2WorkerError(response.error);
      this.#lastError = {
        message: error.message,
        code: error.code,
      };
      pending.reject(error);
    }
  }

  #handleWorkerEvent(
    event: Exclude<SyncularV2WorkerOutboundMessage, SyncularV2WorkerResponse>
  ): void {
    if (event.type === 'liveQueryEvents') {
      for (const liveEvent of event.events) {
        this.#liveListeners.get(liveEvent.queryId)?.(liveEvent);
      }
      return;
    }
    if (event.type === 'rowsChanged') {
      this.#emitRowsChanged({
        source: event.source,
        changedTables: event.changedTables,
        changedRows: event.changedRows,
        changedRowsTruncated: event.changedRowsTruncated,
      });
      return;
    }
    if (event.type === 'bootstrapChanged') {
      this.#emitClientEvent('bootstrapChanged', event.bootstrap);
      return;
    }
    if (event.type === 'realtimeState') {
      this.#realtimeState = event.state;
      this.#emitDiagnostic({
        level: 'info',
        source: 'realtime',
        code: 'realtime.state',
        message: `Syncular v2 realtime is ${event.state}`,
        details: { state: event.state },
      });
      if (event.state === 'connected') {
        this.#rejoinPresence();
      }
      return;
    }
    if (event.type === 'presenceEvent') {
      this.#applyPresenceEvent(event);
      return;
    }
    this.#emitDiagnostic(event.event);
  }

  #emitClientEvent<T extends SyncularV2ClientEventType>(
    event: T,
    payload: SyncularV2ClientEventMap[T]
  ): void {
    const listeners = this.#eventListeners.get(event);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(payload as SyncularV2ClientEventMap[SyncularV2ClientEventType]);
      } catch {
        // Client event listeners must never break sync control flow.
      }
    }
  }

  #hasClientEventListeners(event: SyncularV2ClientEventType): boolean {
    return (this.#eventListeners.get(event)?.size ?? 0) > 0;
  }

  #emitRowsChanged(event: SyncularV2ClientEventMap['rowsChanged']): void {
    if (this.#rowsChangedDebounceMs === false || this.#rowsChangedDebounceMs <= 0) {
      this.#deliverRowsChanged(event);
      return;
    }
    if (!this.#pendingRowsChanged) {
      this.#pendingRowsChanged = {
        source: event.source,
        changedTables: new Set(event.changedTables),
        changedRows: [...event.changedRows],
        changedRowsTruncated: event.changedRowsTruncated === true,
      };
    } else {
      const pending = this.#pendingRowsChanged;
      pending.source =
        pending.source === event.source ? pending.source : 'mixed';
      for (const table of event.changedTables) pending.changedTables.add(table);
      pending.changedRows.push(...event.changedRows);
      pending.changedRowsTruncated ||= event.changedRowsTruncated === true;
    }
    if (this.#rowsChangedDebounceTimer) return;
    this.#rowsChangedDebounceTimer = setTimeout(() => {
      this.#rowsChangedDebounceTimer = undefined;
      this.#flushRowsChanged();
    }, this.#rowsChangedDebounceMs);
  }

  #flushRowsChanged(): void {
    if (this.#rowsChangedDebounceTimer) {
      clearTimeout(this.#rowsChangedDebounceTimer);
      this.#rowsChangedDebounceTimer = undefined;
    }
    const pending = this.#pendingRowsChanged;
    this.#pendingRowsChanged = undefined;
    if (!pending) return;
    this.#deliverRowsChanged({
      source: pending.source,
      changedTables: [...pending.changedTables],
      changedRows: pending.changedRows,
      changedRowsTruncated: pending.changedRowsTruncated,
    });
  }

  #deliverRowsChanged(event: SyncularV2ClientEventMap['rowsChanged']): void {
    for (const listener of this.#rowsChangedListeners) {
      try {
        listener(event);
      } catch {
        // Row-change listeners must never break worker event handling.
      }
    }
    this.#emitClientEvent('rowsChanged', event);
  }

  #emitBootstrapChanged(result: SyncularV2SyncResult): void {
    this.#emitClientEvent('bootstrapChanged', result.bootstrap);
  }

  async #emitOperationalState(): Promise<void> {
    if (
      !this.#hasClientEventListeners('outboxChanged') &&
      !this.#hasClientEventListeners('conflictsChanged')
    ) {
      return;
    }
    const [outboxStats, conflictStats] = await Promise.all([
      this.#readOutboxStats().catch(() => undefined),
      this.#readConflictStats().catch(() => undefined),
    ]);
    if (outboxStats && !sameJson(this.#lastOutboxStats, outboxStats)) {
      this.#lastOutboxStats = outboxStats;
      this.#emitClientEvent('outboxChanged', outboxStats);
    }
    if (conflictStats && !sameJson(this.#lastConflictStats, conflictStats)) {
      this.#lastConflictStats = conflictStats;
      this.#emitClientEvent('conflictsChanged', conflictStats);
    }
  }

  async #readOutboxStats(): Promise<SyncularV2OutboxStats> {
    const result = await this.#request<
      SyncularV2SqlResult<{ status: string; count: number }>
    >({
      type: 'executeUnsafeSql',
      sql: 'select status, count(*) as count from sync_outbox_commits group by status',
      params: [],
    });
    const stats: SyncularV2OutboxStats = {
      pending: 0,
      sending: 0,
      failed: 0,
      acked: 0,
      total: 0,
    };
    for (const row of result.rows) {
      const count = coerceCount(row.count);
      if (row.status === 'pending') stats.pending = count;
      if (row.status === 'sending') stats.sending = count;
      if (row.status === 'failed') stats.failed = count;
      if (row.status === 'acked') stats.acked = count;
      stats.total += count;
    }
    return stats;
  }

  async #readConflictStats(): Promise<SyncularV2ConflictStats> {
    const result = await this.#request<
      SyncularV2SqlResult<{
        unresolved: number;
        resolved: number;
        total: number;
      }>
    >({
      type: 'executeUnsafeSql',
      sql:
        'select ' +
        'coalesce(sum(case when resolved_at is null then 1 else 0 end), 0) as unresolved, ' +
        'coalesce(sum(case when resolved_at is not null then 1 else 0 end), 0) as resolved, ' +
        'count(*) as total from sync_conflicts',
      params: [],
    });
    const row = result.rows[0];
    return {
      unresolved: coerceCount(row?.unresolved),
      resolved: coerceCount(row?.resolved),
      total: coerceCount(row?.total),
    };
  }

  async #readBlobOutboxRows(): Promise<BlobOutboxRow[]> {
    const result = await this.#request<SyncularV2SqlResult<BlobOutboxRow>>({
      type: 'executeUnsafeSql',
      sql:
        'select hash, size, mime_type, status, error ' +
        'from sync_blob_outbox order by created_at asc',
      params: [],
    });
    return result.rows;
  }

  #emitBlobUploadEvents(
    beforeRows: readonly BlobOutboxRow[],
    afterRows: readonly BlobOutboxRow[]
  ): void {
    const after = new Map(afterRows.map((row) => [row.hash, row]));
    for (const before of beforeRows) {
      const next = after.get(before.hash);
      if (!next) {
        this.#emitClientEvent('blobUploadCompleted', {
          ref: {
            hash: before.hash,
            size: coerceCount(before.size),
            mimeType: before.mime_type,
            encrypted: false,
          },
        });
        continue;
      }
      if (before.status !== 'failed' && next.status === 'failed') {
        this.#emitClientEvent('blobUploadFailed', {
          hash: next.hash,
          error: next.error ?? 'Blob upload failed',
        });
      }
    }
  }

  #applyPresenceEvent(event: {
    action: 'join' | 'leave' | 'update' | 'snapshot';
    scopeKey: string;
    clientId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
    entries?: SyncularV2PresenceEntry[];
  }): void {
    const scopeKey = normalizePresenceScopeKey(event.scopeKey);
    if (!scopeKey) return;
    const current = this.#presenceByScopeKey.get(scopeKey) ?? [];
    let next: SyncularV2PresenceEntry[];
    if (event.action === 'snapshot') {
      next = event.entries ?? [];
    } else {
      if (!event.clientId || !event.actorId) return;
      if (event.action === 'leave') {
        next = current.filter((entry) => entry.clientId !== event.clientId);
      } else if (event.action === 'update') {
        const existing = current.find(
          (entry) => entry.clientId === event.clientId
        );
        if (!existing) return;
        next = current.map((entry) =>
          entry.clientId === event.clientId
            ? { ...entry, metadata: event.metadata }
            : entry
        );
      } else {
        const existing = current.find(
          (entry) => entry.clientId === event.clientId
        );
        next = [
          ...current.filter((entry) => entry.clientId !== event.clientId),
          {
            clientId: event.clientId,
            actorId: event.actorId,
            joinedAt: existing?.joinedAt ?? Date.now(),
            metadata: event.metadata,
          },
        ];
      }
    }
    if (arePresenceEntriesEqual(current, next)) return;
    if (next.length === 0) {
      this.#presenceByScopeKey.delete(scopeKey);
    } else {
      this.#presenceByScopeKey.set(scopeKey, next);
    }
    this.#emitClientEvent('presenceChanged', {
      scopeKey,
      presence: next,
    });
  }

  #rejoinPresence(): void {
    if (this.#joinedPresence.size === 0) return;
    for (const [scopeKey, metadata] of this.#joinedPresence) {
      void this.#request({
        type: 'sendPresence',
        action: 'join',
        scopeKey,
        ...(metadata === undefined ? {} : { metadata }),
      }).catch((error) => {
        this.#emitDiagnostic({
          level: 'warn',
          source: 'realtime',
          code: 'realtime.presence_rejoin_failed',
          message: `Syncular v2 presence rejoin failed: ${errorMessage(error)}`,
          details: { scopeKey },
        });
      });
    }
  }

  #rejectAll(reason: SyncularV2WorkerErrorPayload | Error): void {
    const error =
      reason instanceof Error ? reason : new SyncularV2WorkerError(reason);
    this.#lastError = {
      message: error.message,
      ...(error instanceof SyncularV2WorkerError ? { code: error.code } : {}),
    };
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #sendCancel(requestId: number): void {
    const id = this.#nextId++;
    this.worker.postMessage({
      id,
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      requestId,
    } satisfies SyncularV2WorkerRequest);
  }

  #emitDiagnostic(
    event: Omit<SyncularV2DiagnosticEvent, 'at'> & { at?: number }
  ): void {
    const diagnostic: SyncularV2DiagnosticEvent = {
      at: event.at ?? Date.now(),
      level: event.level,
      source: event.source,
      code: event.code,
      message: event.message,
      ...(event.details ? { details: event.details } : {}),
    };
    this.#lastDiagnostic = diagnostic;
    if (this.#diagnosticListeners.size === 0) return;
    for (const listener of this.#diagnosticListeners) {
      try {
        listener(diagnostic);
      } catch {
        // Diagnostics must never break client control flow.
      }
    }
  }
}

function isOpfsOpenFailure(error: unknown): boolean {
  if (!(error instanceof SyncularV2WorkerError)) return false;
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('opfs') ||
    message.includes('sahpool') ||
    message.includes('sync access handle')
  );
}

function shouldEmitOperationalState(
  type: SyncularV2WorkerRequestInput['type']
): boolean {
  return (
    type === 'applyMutation' ||
    type === 'applyMutationsBatch' ||
    type === 'applyMutationsCommit' ||
    type === 'syncPull' ||
    type === 'syncPush' ||
    type === 'syncOnce' ||
    type === 'retryConflictKeepLocal' ||
    type === 'resolveConflict' ||
    type === 'compactStorage'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePresenceScopeKey(scopeKey: string): string {
  const separator = scopeKey.indexOf('::');
  return separator >= 0 ? scopeKey.slice(separator + 2) : scopeKey;
}

function coerceCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneAuthHeaders(
  headers: SyncularV2AuthHeaders
): SyncularV2AuthHeaders {
  return Object.fromEntries(Object.entries(headers));
}

function serializeRuntimeArtifact(
  runtime: CreateSyncularV2DatabaseOptions['runtime'] | undefined
): SyncularV2WorkerRuntimeArtifact | undefined {
  if (!runtime) return undefined;
  return {
    wasmGlueUrl:
      runtime.wasmGlueUrl == null
        ? undefined
        : runtimeUrlHref(runtime.wasmGlueUrl),
    wasmUrl:
      runtime.wasmUrl == null ? undefined : runtimeUrlHref(runtime.wasmUrl),
  };
}

function runtimeUrlHref(value: string | URL | Request): string {
  if (value instanceof Request) return value.url;
  return value instanceof URL ? value.href : value;
}

function normalizeFieldEncryptionConfig(
  config: SyncularV2FieldEncryptionConfig
): Omit<SyncularV2FieldEncryptionConfig, 'keys'> & {
  keys: Record<string, string>;
} {
  const keys: Record<string, string> = {};
  for (const [kid, value] of Object.entries(config.keys)) {
    keys[kid] = value instanceof Uint8Array ? bytesToBase64Url(value) : value;
  }
  return { ...config, keys };
}

function normalizeEncryptedCrdtConfig(
  config: SyncularV2EncryptedCrdtConfig
): Omit<SyncularV2EncryptedCrdtConfig, 'keys'> & {
  keys: Record<string, string>;
} {
  const keys: Record<string, string> = {};
  for (const [kid, value] of Object.entries(config.keys)) {
    keys[kid] = value instanceof Uint8Array ? bytesToBase64Url(value) : value;
  }
  return { ...config, keys };
}

function arePresenceEntriesEqual(
  left: readonly SyncularV2PresenceEntry[],
  right: readonly SyncularV2PresenceEntry[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.clientId !== b.clientId ||
      a.actorId !== b.actorId ||
      a.joinedAt !== b.joinedAt ||
      JSON.stringify(a.metadata ?? {}) !== JSON.stringify(b.metadata ?? {})
    ) {
      return false;
    }
  }
  return true;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function resolveRealtimeWorkerOptions(
  options: SyncularV2RealtimeOptions,
  config: SyncularV2ClientConfig
): Promise<SyncularV2WorkerRealtimeOptions> {
  const params = {
    ...(options.params ?? {}),
    ...((await options.getParams?.({ clientId: config.clientId })) ?? {}),
  };
  return {
    ...(options.wsUrl ? { wsUrl: options.wsUrl } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(options.initialReconnectDelayMs != null
      ? { initialReconnectDelayMs: options.initialReconnectDelayMs }
      : {}),
    ...(options.maxReconnectDelayMs != null
      ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
      : {}),
    ...(options.reconnectBackoffFactor != null
      ? { reconnectBackoffFactor: options.reconnectBackoffFactor }
      : {}),
    ...(options.heartbeatTimeoutMs != null
      ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs }
      : {}),
  };
}

function isWorkerEvent(
  message: SyncularV2WorkerOutboundMessage
): message is Exclude<
  SyncularV2WorkerOutboundMessage,
  SyncularV2WorkerResponse
> {
  return 'type' in message && !('id' in message);
}

function authStatusFromError(error: unknown): 401 | 403 | undefined {
  const details =
    error instanceof SyncularV2WorkerError ? error.details : undefined;
  if (
    details &&
    typeof details === 'object' &&
    'status' in details &&
    (details.status === 401 || details.status === 403)
  ) {
    return details.status;
  }

  const message = errorMessage(error);
  const match = /\bHTTP (401|403)\b/.exec(message);
  if (!match) return undefined;
  return match[1] === '401' ? 401 : 403;
}
