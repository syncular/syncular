import type {
  BlobRef,
  SyncAuthLeaseIssueRequest,
  SyncAuthOperation,
  SyncOperation,
} from '@syncular/core';
import { issueSyncularAuthLease } from './auth-leases';
import { assertSyncularBlobPayloadLimit } from './blob-limits';
import {
  isSyncularRemoteMode,
  resolveSyncularClientConfig,
  SYNCULAR_DEFAULT_STORAGE,
} from './client-config';
import {
  appendSyncularDiagnosticEvent,
  appendSyncularSyncTimings,
  createSyncularSyncAttempt,
  summarizeSyncularDiagnosticSubscriptions,
} from './diagnostics';
import {
  isGeneratedSyncularOperationalStateWorkerRequestType,
  type SyncularGeneratedWorkerRequestInput,
  type SyncularGeneratedWorkerRequestType,
} from './generated-bridge';
import { browserSyncularNetworkStatusSource } from './network';
import { assertSyncularReadonlySql } from './sql-safety';
import type {
  CreateSyncularDatabaseOptions,
  ResolvedSyncularClientConfig,
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularApplyYjsTextUpdatesResult,
  SyncularAuthHeaders,
  SyncularAuthLeaseRecord,
  SyncularBlobCacheStats,
  SyncularBlobEncryptionConfig,
  SyncularBlobStoreOptions,
  SyncularBlobUploadQueueProcessOptions,
  SyncularBlobUploadQueueStats,
  SyncularBootstrapStatus,
  SyncularBuildYjsTextUpdateArgs,
  SyncularBuildYjsTextUpdateResult,
  SyncularClientEventMap,
  SyncularClientEventSink,
  SyncularClientEventType,
  SyncularConflictResolution,
  SyncularConflictStats,
  SyncularConflictSummary,
  SyncularConnectionState,
  SyncularCrdtDocumentSnapshot,
  SyncularCrdtFieldCompactionReceipt,
  SyncularCrdtFieldCompactionRequest,
  SyncularCrdtFieldDescriptor,
  SyncularCrdtFieldMaterialization,
  SyncularCrdtFieldRequest,
  SyncularCrdtFieldTextRequest,
  SyncularCrdtFieldWriteReceipt,
  SyncularCrdtFieldYjsUpdateRequest,
  SyncularCrdtUpdateLogEntry,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSink,
  SyncularDiagnosticSnapshot,
  SyncularEncryptedCrdtConfig,
  SyncularEncryptionHelperMethod,
  SyncularFieldEncryptionConfig,
  SyncularLifecycleState,
  SyncularLiveQueryDependencyHint,
  SyncularLiveQueryDiagnostics,
  SyncularLiveQueryEvent,
  SyncularLiveQuerySnapshot,
  SyncularLocalHealthRepairReport,
  SyncularLocalHealthRepairRequest,
  SyncularLocalHealthReport,
  SyncularLocalSupportBundle,
  SyncularLocalSupportBundleImportReport,
  SyncularLocalSyncResetReport,
  SyncularLocalSyncResetRequest,
  SyncularNetworkStatusSource,
  SyncularOutboxStats,
  SyncularPresenceEntry,
  SyncularPresenceSink,
  SyncularRealtimeConnectionState,
  SyncularRealtimeOptions,
  SyncularRowsChangedSink,
  SyncularRuntimeArtifact,
  SyncularRuntimeClient,
  SyncularRuntimeInfo,
  SyncularSchemaState,
  SyncularSqlResult,
  SyncularStorageCompactionOptions,
  SyncularStorageCompactionReport,
  SyncularStorageFallbackInfo,
  SyncularSubscriptionSpec,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
  SyncularSyncTimings,
  SyncularTransportStats,
  SyncularWorkerRequestTimeoutMs,
  SyncularWorkerRequestTimeouts,
} from './types';
import {
  getSyncularRuntimeArtifact,
  selectSyncularRuntimeArtifact,
} from './wasm-runtime';
import type {
  SyncularWorkerErrorPayload,
  SyncularWorkerOutboundMessage,
  SyncularWorkerRealtimeOptions,
  SyncularWorkerRequest,
  SyncularWorkerResponse,
  SyncularWorkerRuntimeArtifact,
} from './worker-protocol';
import {
  createSyncularWorkerErrorPayload,
  SYNCULAR_WORKER_PROTOCOL_VERSION,
} from './worker-protocol';

type PendingRequest = {
  type: SyncularWorkerRequestInput['type'];
  timeout: ReturnType<typeof setTimeout> | undefined;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

type BlobOutboxRow = {
  hash: string;
  size: number;
  mime_type: string;
  encrypted: number | boolean;
  key_id: string | null;
  status: string;
  error: string | null;
};

type SyncularWorkerRequestInput = SyncularGeneratedWorkerRequestInput;

const DEFAULT_SYNCULAR_WORKER_REQUEST_TIMEOUT_MS = 30_000;
const NO_SYNCULAR_WORKER_REQUEST_TIMEOUT = 0;

const SYNCULAR_SYNC_WORKER_REQUEST_TYPES = new Set<string>([
  'forceSubscriptionsBootstrap',
  'syncPull',
  'syncPush',
  'syncOnce',
]);

const SYNCULAR_BLOB_WORKER_REQUEST_TYPES = new Set<string>([
  'storeBlob',
  'retrieveBlob',
  'processBlobUploadQueue',
]);

const SYNCULAR_STORAGE_MAINTENANCE_WORKER_REQUEST_TYPES = new Set<string>([
  'open',
  'compactStorage',
  'exportLocalSupportBundle',
  'importLocalSupportBundle',
  'repairLocalHealth',
  'resetLocalSyncState',
]);

function syncularWorkerRequestTimeoutMs(
  config:
    | SyncularWorkerRequestTimeoutMs
    | SyncularWorkerRequestTimeouts
    | undefined,
  type: SyncularGeneratedWorkerRequestType
): number {
  if (typeof config === 'number' || config === false) {
    return normalizeSyncularWorkerTimeoutMs(config);
  }

  const byType = config?.byType?.[type];
  if (byType !== undefined) return normalizeSyncularWorkerTimeoutMs(byType);

  if (SYNCULAR_SYNC_WORKER_REQUEST_TYPES.has(type)) {
    return normalizeSyncularWorkerTimeoutMs(config?.syncMs ?? false);
  }
  if (SYNCULAR_BLOB_WORKER_REQUEST_TYPES.has(type)) {
    return normalizeSyncularWorkerTimeoutMs(config?.blobMs ?? false);
  }
  if (SYNCULAR_STORAGE_MAINTENANCE_WORKER_REQUEST_TYPES.has(type)) {
    return normalizeSyncularWorkerTimeoutMs(
      config?.storageMaintenanceMs ?? false
    );
  }

  return normalizeSyncularWorkerTimeoutMs(
    config?.defaultMs ?? DEFAULT_SYNCULAR_WORKER_REQUEST_TIMEOUT_MS
  );
}

function normalizeSyncularWorkerTimeoutMs(
  value: SyncularWorkerRequestTimeoutMs
): number {
  if (value === false) return NO_SYNCULAR_WORKER_REQUEST_TIMEOUT;
  if (!Number.isFinite(value) || value <= 0) {
    return NO_SYNCULAR_WORKER_REQUEST_TIMEOUT;
  }
  return Math.trunc(value);
}

export async function createSyncularWorkerClient(
  options: CreateSyncularDatabaseOptions
): Promise<SyncularWorkerClient> {
  const config = resolveSyncularClientConfig(options.config);
  const runtime =
    typeof options.runtime === 'string'
      ? getSyncularRuntimeArtifact(options.runtime)
      : (options.runtime ??
        selectSyncularRuntimeArtifact(
          options.requiredRuntimeFeatures,
          options.runtimeArtifacts
        ));
  const worker =
    typeof options.worker === 'function'
      ? options.worker()
      : (options.worker ?? createDefaultSyncularWorker());
  const client = new SyncularWorkerClient(worker, {
    ownsWorker: options.worker == null,
    requestTimeoutMs: options.requestTimeoutMs,
    getHeaders: options.getHeaders,
    authLifecycle: options.authLifecycle,
    diagnostics: options.diagnostics,
    rowsChangedDebounceMs: options.sync?.rowsChangedDebounceMs,
    network:
      options.sync?.network === false
        ? undefined
        : (options.sync?.network ?? browserSyncularNetworkStatusSource()),
    blobLimits: options.blobLimits,
  });
  try {
    await client.open(config, runtime);
  } catch (err) {
    if (
      options.config.storage == null &&
      config.storage === SYNCULAR_DEFAULT_STORAGE &&
      isOpfsOpenFailure(err)
    ) {
      const fallbackConfig = { ...config, storage: 'indexedDb' as const };
      const fallbackInfo: SyncularStorageFallbackInfo = {
        from: SYNCULAR_DEFAULT_STORAGE,
        to: fallbackConfig.storage,
        reason: errorMessage(err),
      };
      client.setStorageFallback(fallbackInfo);
      try {
        await client.open(fallbackConfig, runtime);
      } catch (fallbackErr) {
        throw createStorageFallbackFailureError(err, fallbackErr, fallbackInfo);
      }
    } else {
      throw err;
    }
  }
  return client;
}

export function getDefaultSyncularWorkerUrl(): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith('/src/worker-client.ts');
  return new URL(
    sourceRuntime ? './worker-entry.ts' : './worker-entry.js',
    runtimeUrl
  );
}

export function createDefaultSyncularWorker(): Worker {
  return new Worker(getDefaultSyncularWorkerUrl(), {
    type: 'module',
    credentials: 'same-origin',
  });
}

export class SyncularWorkerError extends Error {
  readonly code: SyncularWorkerErrorPayload['code'];
  readonly category: SyncularWorkerErrorPayload['category'];
  readonly retryable: boolean;
  readonly recommendedAction: SyncularWorkerErrorPayload['recommendedAction'];
  readonly details: unknown;

  constructor(payload: SyncularWorkerErrorPayload) {
    super(payload.message);
    this.name = payload.name ?? 'SyncularWorkerError';
    this.code = payload.code;
    this.category = payload.category;
    this.retryable = payload.retryable === true;
    this.recommendedAction = payload.recommendedAction;
    this.details = payload.details;
    if (payload.stack) this.stack = payload.stack;
  }
}

export class SyncularWorkerClient implements SyncularRuntimeClient {
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #closed = false;
  #requestTimeouts:
    | SyncularWorkerRequestTimeoutMs
    | SyncularWorkerRequestTimeouts
    | undefined;
  #getHeaders: CreateSyncularDatabaseOptions['getHeaders'] | undefined;
  #authHeaders: SyncularAuthHeaders = {};
  #authLifecycle: CreateSyncularDatabaseOptions['authLifecycle'] | undefined;
  #authRefreshInFlight: Promise<boolean> | undefined;
  #config: ResolvedSyncularClientConfig | undefined;
  #realtimeOptions: SyncularRealtimeOptions | undefined;
  #realtimeState: SyncularRealtimeConnectionState = 'disconnected';
  #storageFallback: SyncularStorageFallbackInfo | undefined;
  #lastDiagnostic: SyncularDiagnosticEvent | undefined;
  #lastError: { message: string; code?: string } | undefined;
  #lastLifecycleState: SyncularLifecycleState | undefined;
  #recoveryRequired = false;
  #authRequired = false;
  #subscriptions: SyncularSubscriptionSpec[] = [];
  #lastBootstrap: SyncularBootstrapStatus | undefined;
  #recentDiagnostics: SyncularDiagnosticEvent[] = [];
  #recentSyncTimings: SyncularSyncTimings[] = [];
  #rowsChangedDebounceMs: number | false;
  #rowsChangedDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingRowsChanged:
    | {
        source: string;
        changedTables: Set<string>;
        changedRows: SyncularSyncResult['changedRows'];
        changedRowsTruncated: boolean;
      }
    | undefined;
  #lastOutboxStats: SyncularOutboxStats | undefined;
  #lastConflictStats: SyncularConflictStats | undefined;
  #lastBlobUploadStats: SyncularBlobUploadQueueStats | undefined;
  #blobLimits: CreateSyncularDatabaseOptions['blobLimits'];
  #network: SyncularNetworkStatusSource | undefined;
  #networkOnline: boolean | undefined;
  #unsubscribeNetwork: (() => void) | undefined;
  #diagnosticListeners = new Set<SyncularDiagnosticSink>();
  #rowsChangedListeners = new Set<SyncularRowsChangedSink>();
  #eventListeners = new Map<
    SyncularClientEventType,
    Set<SyncularClientEventSink<SyncularClientEventType>>
  >();
  #presenceByScopeKey = new Map<string, SyncularPresenceEntry[]>();
  #joinedPresence = new Map<string, Record<string, unknown> | undefined>();
  #liveListeners = new Map<
    string,
    (event: SyncularLiveQueryEvent<Record<string, unknown>>) => void
  >();

  constructor(
    private readonly worker: Worker,
    options: {
      ownsWorker: boolean;
      requestTimeoutMs?: CreateSyncularDatabaseOptions['requestTimeoutMs'];
      getHeaders?: CreateSyncularDatabaseOptions['getHeaders'];
      authLifecycle?: CreateSyncularDatabaseOptions['authLifecycle'];
      diagnostics?: SyncularDiagnosticSink;
      rowsChangedDebounceMs?: number | false;
      network?: SyncularNetworkStatusSource;
      blobLimits?: CreateSyncularDatabaseOptions['blobLimits'];
    }
  ) {
    this.#requestTimeouts = options.requestTimeoutMs;
    this.#getHeaders = options.getHeaders;
    this.#authLifecycle = options.authLifecycle;
    this.#blobLimits = options.blobLimits;
    this.#network = options.network;
    this.#networkOnline = this.#network?.isOnline();
    this.#unsubscribeNetwork = this.#subscribeNetworkEvents();
    this.#rowsChangedDebounceMs =
      options.rowsChangedDebounceMs === false
        ? false
        : Math.max(0, options.rowsChangedDebounceMs ?? 0);
    if (options.diagnostics) {
      this.#diagnosticListeners.add(options.diagnostics);
    }
    this.worker.onmessage = (
      event: MessageEvent<SyncularWorkerOutboundMessage>
    ) => {
      this.#handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event) => {
      const payload = createSyncularWorkerErrorPayload(
        'worker.failed',
        event.message || 'Syncular worker failed'
      );
      this.#emitDiagnostic({
        level: 'error',
        source: 'worker',
        code: 'worker.failed',
        message: payload.message,
      });
      this.#rejectAll(payload);
    };
    this.worker.onmessageerror = () => {
      const payload = createSyncularWorkerErrorPayload(
        'worker.message_unreadable',
        'Syncular worker sent an unreadable message'
      );
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
    config: CreateSyncularDatabaseOptions['config'],
    runtime?: CreateSyncularDatabaseOptions['runtime']
  ): Promise<void> {
    const resolvedConfig = resolveSyncularClientConfig(config);
    const resolvedRuntime =
      typeof runtime === 'string'
        ? getSyncularRuntimeArtifact(runtime)
        : runtime;
    await this.#request({
      type: 'open',
      config: resolvedConfig,
      runtime: serializeRuntimeArtifact(resolvedRuntime),
    });
    this.#config = resolvedConfig;
    this.#realtimeOptions = undefined;
    this.#subscriptions = [];
    this.#lastBootstrap = undefined;
    await this.#refreshAuthHeaders();
  }

  async setAuthHeaders(headers: SyncularAuthHeaders): Promise<void> {
    await this.#setAuthHeaders(headers, { restartRealtime: true });
  }

  async issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord> {
    await this.#refreshAuthHeaders();
    try {
      return await this.#issueAuthLeaseWithCurrentHeaders(request);
    } catch (error) {
      const shouldRetry = await this.#resolveAuthRetry(error, 'authLeaseIssue');
      if (!shouldRetry) throw error;
      await this.#refreshAuthHeaders();
      return this.#issueAuthLeaseWithCurrentHeaders(request);
    }
  }

  async upsertAuthLease(lease: SyncularAuthLeaseRecord): Promise<void> {
    await this.#requestAndDrain({
      type: 'upsertAuthLease',
      lease,
    });
  }

  async authLease(leaseId: string): Promise<SyncularAuthLeaseRecord | null> {
    return this.#request({
      type: 'authLease',
      leaseId,
    });
  }

  async activeAuthLeases(
    actorId?: string | null,
    nowMs = Date.now()
  ): Promise<SyncularAuthLeaseRecord[]> {
    return this.#request({
      type: 'activeAuthLeases',
      actorId: actorId ?? null,
      nowMs: Math.trunc(nowMs),
    });
  }

  async setFieldEncryption(
    config: SyncularFieldEncryptionConfig | null
  ): Promise<void> {
    await this.#request({
      type: 'setFieldEncryption',
      config: config == null ? null : normalizeFieldEncryptionConfig(config),
    });
  }

  async setEncryptedCrdt(
    config: SyncularEncryptedCrdtConfig | null
  ): Promise<void> {
    await this.#request({
      type: 'setEncryptedCrdt',
      config: config == null ? null : normalizeEncryptedCrdtConfig(config),
    });
  }

  async setBlobEncryption(
    config: SyncularBlobEncryptionConfig | null
  ): Promise<void> {
    await this.#request({
      type: 'setBlobEncryption',
      config: config == null ? null : normalizeBlobEncryptionConfig(config),
    });
  }

  async #setAuthHeaders(
    headers: SyncularAuthHeaders,
    options: { restartRealtime: boolean }
  ): Promise<void> {
    this.#authHeaders = cloneAuthHeaders(headers);
    await this.#request({
      type: 'setAuthHeaders',
      headers: cloneAuthHeaders(this.#authHeaders),
    });
    if (options.restartRealtime) await this.#restartRealtime();
  }

  async #issueAuthLeaseWithCurrentHeaders(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord> {
    const config = this.#config;
    if (!config) {
      throw new Error(
        'Syncular worker client must be opened before auth lease issue'
      );
    }
    assertSyncularRemoteMode(config, 'auth lease issue');
    const lease = await issueSyncularAuthLease({
      baseUrl: config.baseUrl,
      headers: this.#authHeaders,
      request,
      appSchema: config.appSchema,
    });
    await this.upsertAuthLease(lease);
    this.#emitDiagnostic({
      level: 'info',
      source: 'auth',
      code: 'auth_lease.issued',
      message: 'Syncular auth lease issued and stored',
      details: {
        leaseId: lease.leaseId,
        expiresAtMs: lease.expiresAtMs,
        schemaVersion: lease.schemaVersion,
      },
    });
    return lease;
  }

  async startRealtime(
    options: boolean | SyncularRealtimeOptions = {}
  ): Promise<void> {
    if (options === false) {
      await this.stopRealtime();
      return;
    }
    const config = this.#config;
    if (!config) {
      throw new Error('Syncular worker client must be opened before realtime');
    }
    assertSyncularRemoteMode(config, 'realtime');
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
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void> {
    this.#subscriptions = [...subscriptions];
    this.#lastBootstrap = undefined;
    await this.#request({
      type: 'setSubscriptions',
      subscriptions: this.#subscriptions,
    });
  }

  async forceSubscriptionsBootstrap(
    subscriptionIds: readonly string[] = []
  ): Promise<number> {
    return this.#request({
      type: 'forceSubscriptionsBootstrap',
      subscriptionIds: [...subscriptionIds],
    });
  }

  async executeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<SyncularSqlResult<Row>> {
    assertSyncularReadonlySql(sql);
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
  ): Promise<SyncularSqlResult<Row>> {
    return this.#request({
      type: 'executeUnsafeSql',
      sql,
      params: [...params],
    });
  }

  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[],
    hints: readonly SyncularLiveQueryDependencyHint[] = []
  ): Promise<SyncularLiveQuerySnapshot<Row>> {
    return this.#request({
      type: 'subscribeQuery',
      sql,
      params: [...params],
      tables: [...tables],
      hints: hints.map((hint) => ({
        table: hint.table,
        rowIds: [...(hint.rowIds ?? [])],
        fields: [...(hint.fields ?? [])],
      })),
    });
  }

  async unsubscribeQuery(id: string): Promise<void> {
    await this.#request({ type: 'unsubscribeQuery', queryId: id });
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Promise<Array<SyncularLiveQueryEvent<Row>>> {
    return this.#request({ type: 'drainLiveQueryEvents' });
  }

  liveQueryDiagnostics(): Promise<SyncularLiveQueryDiagnostics> {
    return this.#request({ type: 'liveQueryDiagnostics' });
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

  async applyLeasedMutation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string> {
    return this.#requestAndDrain({
      type: 'applyLeasedMutation',
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

  async applyLeasedMutationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string> {
    return this.#requestAndDrain({
      type: 'applyLeasedMutationsCommit',
      operations,
    });
  }

  async syncPull(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    return this.#syncWithAuthRetry({
      type: 'syncPull',
      syncAttempt: options.syncAttempt ?? createSyncularSyncAttempt(),
    });
  }

  async syncPush(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    return this.#syncWithAuthRetry({
      type: 'syncPush',
      syncAttempt: options.syncAttempt ?? createSyncularSyncAttempt(),
    });
  }

  async syncOnce(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    return this.#syncWithAuthRetry({
      type: 'syncOnce',
      syncAttempt: options.syncAttempt ?? createSyncularSyncAttempt(),
    });
  }

  async resumeFromBackground(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    this.#recoveryRequired = true;
    this.#emitDiagnostic({
      level: 'info',
      source: 'client',
      code: 'lifecycle.resume_from_background',
      message: 'Syncular resumed from background',
    });
    await this.#refreshAuthHeaders({ restartRealtime: false });
    await this.#restartRealtime();
    return this.#syncWithAuthRetry(
      {
        type: 'syncOnce',
        syncAttempt: options.syncAttempt ?? createSyncularSyncAttempt(),
      },
      { refreshAuthHeaders: false }
    );
  }

  transportStats(): Promise<SyncularTransportStats> {
    return this.#request({ type: 'transportStats' });
  }

  async resetTransportStats(): Promise<void> {
    await this.#request({ type: 'resetTransportStats' });
  }

  conflictSummaries(): Promise<SyncularConflictSummary[]> {
    return this.#request({ type: 'conflictSummaries' });
  }

  retryConflictKeepLocal(id: string): Promise<string> {
    return this.#requestAndDrain({
      type: 'retryConflictKeepLocal',
      conflictId: id,
    });
  }

  async resolveConflict(
    id: string,
    resolution: SyncularConflictResolution
  ): Promise<void> {
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
    options?: SyncularBlobStoreOptions
  ): Promise<BlobRef> {
    try {
      assertSyncularBlobPayloadLimit({
        operation: 'store',
        size: data.byteLength,
        limits: this.#blobLimits,
        options,
        diagnostics: (event) => this.#emitDiagnostic(event),
      });
    } catch (error) {
      return Promise.reject(error);
    }
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

  async retrieveBlob(ref: BlobRef): Promise<Uint8Array> {
    assertSyncularBlobPayloadLimit({
      operation: 'retrieve',
      size: ref.size,
      limits: this.#blobLimits,
      refHash: ref.hash,
      diagnostics: (event) => this.#emitDiagnostic(event),
    });
    const wasLocal = this.#hasDiagnosticListeners()
      ? await this.#request<boolean>({
          type: 'isBlobLocal',
          hash: ref.hash,
        }).catch(() => undefined)
      : undefined;
    try {
      const bytes = await this.#requestWithAuthRetry<Uint8Array>(
        { type: 'retrieveBlob', ref },
        'blobGetDownloadUrl'
      );
      if (wasLocal !== undefined) {
        this.#emitDiagnostic({
          level: 'info',
          source: 'blob',
          code: wasLocal ? 'blob.cache_hit' : 'blob.cache_miss',
          message: wasLocal
            ? 'Syncular blob served from local cache'
            : 'Syncular blob fetched after local cache miss',
          details: {
            hash: ref.hash,
            size: ref.size,
            mimeType: ref.mimeType,
            encrypted: ref.encrypted === true,
            ...(ref.keyId ? { keyId: ref.keyId } : {}),
          },
        });
      }
      return bytes;
    } catch (error) {
      if (this.#hasDiagnosticListeners()) {
        this.#emitDiagnostic({
          level: 'warn',
          source: 'blob',
          code: 'blob.download_failed',
          message: `Syncular blob download failed: ${errorMessage(error)}`,
          details: {
            hash: ref.hash,
            size: ref.size,
            mimeType: ref.mimeType,
            encrypted: ref.encrypted === true,
            ...(ref.keyId ? { keyId: ref.keyId } : {}),
          },
        });
      }
      throw error;
    }
  }

  async isBlobLocal(hash: string): Promise<boolean> {
    const local = await this.#request<boolean>({ type: 'isBlobLocal', hash });
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        level: 'debug',
        source: 'blob',
        code: local ? 'blob.cache_hit' : 'blob.cache_miss',
        message: local
          ? 'Syncular blob is available in local cache'
          : 'Syncular blob is not available in local cache',
        details: { hash },
      });
    }
    return local;
  }

  async processBlobUploadQueue(
    options?: SyncularBlobUploadQueueProcessOptions
  ): Promise<{
    uploaded: number;
    failed: number;
  }> {
    const observeBlobEvents =
      this.#hasClientEventListeners('blobUploadCompleted') ||
      this.#hasClientEventListeners('blobUploadFailed') ||
      this.#hasDiagnosticListeners();
    const before = observeBlobEvents
      ? await this.#readBlobOutboxRows().catch(() => [])
      : [];
    const result = await this.#requestWithAuthRetry<{
      uploaded: number;
      failed: number;
    }>({ type: 'processBlobUploadQueue', options }, 'blobInitiateUpload');
    if (observeBlobEvents) {
      const after = await this.#readBlobOutboxRows().catch(() => []);
      this.#emitBlobUploadEvents(before, after);
    }
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        level: result.failed > 0 ? 'warn' : 'info',
        source: 'blob',
        code: 'blob.upload_queue_processed',
        message: 'Syncular blob upload queue processed',
        details: result,
      });
    }
    void this.#emitOperationalState();
    return result;
  }

  async blobUploadQueueStats(): Promise<SyncularBlobUploadQueueStats> {
    const stats = await this.#readBlobUploadStats();
    this.#lastBlobUploadStats = stats;
    return stats;
  }

  blobCacheStats(): Promise<SyncularBlobCacheStats> {
    return this.#request({ type: 'blobCacheStats' });
  }

  async pruneBlobCache(maxBytes?: number): Promise<number> {
    const prunedBytes = await this.#request<number>({
      type: 'pruneBlobCache',
      maxBytes,
    });
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        level: 'info',
        source: 'blob',
        code: 'blob.cache_pruned',
        message: 'Syncular blob cache pruned',
        details: {
          prunedBytes,
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        },
      });
    }
    return prunedBytes;
  }

  async clearBlobCache(): Promise<void> {
    await this.#request({ type: 'clearBlobCache' });
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        level: 'info',
        source: 'blob',
        code: 'blob.cache_cleared',
        message: 'Syncular blob cache cleared',
      });
    }
  }

  compactStorage(
    options: SyncularStorageCompactionOptions = {}
  ): Promise<SyncularStorageCompactionReport> {
    return this.#request({ type: 'compactStorage', options });
  }

  generatedSchemaState(): Promise<SyncularSchemaState> {
    return this.#request({ type: 'generatedSchemaState' });
  }

  localHealthCheck(): Promise<SyncularLocalHealthReport> {
    return this.#request({ type: 'localHealthCheck' });
  }

  exportLocalSupportBundle(): Promise<SyncularLocalSupportBundle> {
    return this.#request({ type: 'exportLocalSupportBundle' });
  }

  importLocalSupportBundle(
    bundle: SyncularLocalSupportBundle | string
  ): Promise<SyncularLocalSupportBundleImportReport> {
    return this.#request({
      type: 'importLocalSupportBundle',
      bundleJson: typeof bundle === 'string' ? bundle : JSON.stringify(bundle),
    });
  }

  async repairLocalHealth(
    request: SyncularLocalHealthRepairRequest
  ): Promise<SyncularLocalHealthRepairReport> {
    const message = {
      type: 'repairLocalHealth',
      request: {
        action: request.action,
        subscriptionIds: [...(request.subscriptionIds ?? [])],
        tables: [...(request.tables ?? [])],
      },
    } satisfies SyncularWorkerRequestInput;
    const result =
      request.action === 'clearOrphanedSyncedRows'
        ? await this.#requestAndDrain<SyncularLocalHealthRepairReport>(message)
        : await this.#request<SyncularLocalHealthRepairReport>(message);
    if (request.action === 'clearOrphanedSyncedRows') {
      this.#emitLifecycleChanged();
    }
    return result;
  }

  async resetLocalSyncState(
    request: SyncularLocalSyncResetRequest = {}
  ): Promise<SyncularLocalSyncResetReport> {
    const normalized = {
      subscriptionIds: [...(request.subscriptionIds ?? [])],
      clearSyncedRows: request.clearSyncedRows === true,
    };
    const result = await this.#requestAndDrain<SyncularLocalSyncResetReport>({
      type: 'resetLocalSyncState',
      request: normalized,
    });
    this.#lastBootstrap = undefined;
    this.#emitLifecycleChanged();
    return result;
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
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldDescriptor> {
    return this.#request({ type: 'openCrdtField', request });
  }

  applyCrdtFieldText(
    request: SyncularCrdtFieldTextRequest
  ): Promise<SyncularCrdtFieldWriteReceipt> {
    return this.#requestAndDrain({ type: 'applyCrdtFieldText', request });
  }

  applyCrdtFieldYjsUpdate(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<SyncularCrdtFieldWriteReceipt> {
    return this.#requestAndDrain({
      type: 'applyCrdtFieldYjsUpdate',
      request,
    });
  }

  materializeCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldMaterialization> {
    return this.#request({ type: 'materializeCrdtField', request });
  }

  crdtDocumentSnapshot(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtDocumentSnapshot> {
    return this.#request({ type: 'crdtDocumentSnapshot', request });
  }

  crdtUpdateLog(
    request: SyncularCrdtFieldRequest & { limit?: number }
  ): Promise<SyncularCrdtUpdateLogEntry[]> {
    return this.#request({ type: 'crdtUpdateLog', request });
  }

  snapshotCrdtFieldStateVector(
    request: SyncularCrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }> {
    return this.#request({ type: 'snapshotCrdtFieldStateVector', request });
  }

  compactCrdtField(
    request: SyncularCrdtFieldCompactionRequest
  ): Promise<SyncularCrdtFieldCompactionReceipt> {
    return this.#requestAndDrain({ type: 'compactCrdtField', request });
  }

  encryptionHelper(
    method: SyncularEncryptionHelperMethod,
    args: unknown = {}
  ): Promise<unknown> {
    return this.#request({ type: 'encryptionHelper', method, args });
  }

  runtimeInfo(): Promise<SyncularRuntimeInfo> {
    return this.#request<SyncularRuntimeInfo>({ type: 'runtimeInfo' }).then(
      (info) => ({
        ...info,
        storageFallback: this.#storageFallback,
      })
    );
  }

  connectionState(): SyncularConnectionState {
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

  lifecycleState(): SyncularLifecycleState {
    return this.#computeLifecycleState();
  }

  #computeLifecycleState(): SyncularLifecycleState {
    const outbox = this.#lastOutboxStats;
    const conflicts = this.#lastConflictStats;
    const blobUploads = this.#lastBlobUploadStats;
    const bootstrap = this.#lastBootstrap
      ? {
          complete: this.#lastBootstrap.complete,
          criticalReady: this.#lastBootstrap.criticalReady,
          interactiveReady: this.#lastBootstrap.interactiveReady,
          isBootstrapping: this.#lastBootstrap.isBootstrapping,
          progressPercent: this.#lastBootstrap.progressPercent,
        }
      : undefined;
    const hasFailedOutbox = (outbox?.failed ?? 0) > 0;
    const hasConflicts = (conflicts?.unresolved ?? 0) > 0;
    const hasFailedBlobUploads = (blobUploads?.failed ?? 0) > 0;
    const authRequired =
      this.#authRequired || this.#lastError?.code === 'sync.auth_required';
    const offline = this.#networkOnline === false;
    const pendingSyncRequests = this.#pendingSyncRequestCount();
    const phase: SyncularLifecycleState['phase'] = this.#closed
      ? 'closed'
      : authRequired
        ? 'authRequired'
        : offline
          ? 'offline'
          : this.#recoveryRequired || bootstrap?.isBootstrapping === true
            ? 'recovering'
            : pendingSyncRequests > 0
              ? 'syncing'
              : this.#realtimeState === 'connecting'
                ? 'connecting'
                : hasFailedOutbox || hasConflicts || hasFailedBlobUploads
                  ? 'degraded'
                  : bootstrap?.complete === true
                    ? 'complete'
                    : 'offline';

    return {
      phase,
      realtime: this.#realtimeState,
      online: this.#networkOnline ?? this.#realtimeState === 'connected',
      requiresAction:
        authRequired || hasFailedOutbox || hasConflicts || hasFailedBlobUploads,
      pendingRequests: this.#pending.size,
      ...(bootstrap ? { bootstrap } : {}),
      ...(outbox ? { outbox } : {}),
      ...(conflicts ? { conflicts } : {}),
      ...(blobUploads ? { blobUploads } : {}),
      ...(this.#lastDiagnostic ? { lastDiagnostic: this.#lastDiagnostic } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  async diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot> {
    const [runtime, transportStats] = await Promise.all([
      this.runtimeInfo(),
      this.transportStats().catch(() => undefined),
    ]);
    const outboxStats =
      this.#lastOutboxStats ??
      (await this.#readOutboxStats().catch(() => undefined));
    if (outboxStats) this.#lastOutboxStats = outboxStats;
    const conflictStats =
      this.#lastConflictStats ??
      (await this.#readConflictStats().catch(() => undefined));
    if (conflictStats) this.#lastConflictStats = conflictStats;
    const blobUploadStats =
      this.#lastBlobUploadStats ??
      (await this.blobUploadQueueStats().catch(() => undefined));
    return {
      generatedAt: Date.now(),
      runtime,
      connection: this.connectionState(),
      subscriptions: summarizeSyncularDiagnosticSubscriptions(
        this.#subscriptions,
        this.#lastBootstrap
      ),
      recentDiagnostics: [...this.#recentDiagnostics],
      recentSyncTimings: [...this.#recentSyncTimings],
      ...(this.#lastBootstrap ? { bootstrap: this.#lastBootstrap } : {}),
      ...(transportStats ? { transportStats } : {}),
      ...(outboxStats ? { outboxStats } : {}),
      ...(conflictStats ? { conflictStats } : {}),
      ...(blobUploadStats ? { blobUploadStats } : {}),
    };
  }

  setStorageFallback(fallback: SyncularStorageFallbackInfo): void {
    this.#storageFallback = fallback;
    this.#emitDiagnostic({
      level: 'warn',
      source: 'storage',
      code: 'storage.fallback',
      message: `Syncular storage fell back from ${fallback.from} to ${fallback.to}`,
      details: {
        from: fallback.from,
        to: fallback.to,
        reason: fallback.reason,
      },
    });
  }

  addDiagnosticListener(listener: SyncularDiagnosticSink): () => void {
    this.#diagnosticListeners.add(listener);
    return () => {
      this.#diagnosticListeners.delete(listener);
    };
  }

  addEventListener<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void {
    const listeners = this.#eventListeners.get(event) ?? new Set();
    listeners.add(listener as SyncularClientEventSink<SyncularClientEventType>);
    this.#eventListeners.set(event, listeners);
    return () => {
      listeners.delete(
        listener as SyncularClientEventSink<SyncularClientEventType>
      );
      if (listeners.size === 0) this.#eventListeners.delete(event);
    };
  }

  addRowsChangedListener(listener: SyncularRowsChangedSink): () => void {
    this.#rowsChangedListeners.add(listener);
    return () => {
      this.#rowsChangedListeners.delete(listener);
    };
  }

  getPresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularPresenceEntry<TMetadata>[] {
    return (this.#presenceByScopeKey.get(scopeKey) ??
      []) as SyncularPresenceEntry<TMetadata>[];
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
        message: `Syncular presence join failed: ${errorMessage(error)}`,
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
        message: `Syncular presence leave failed: ${errorMessage(error)}`,
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
        message: `Syncular presence update failed: ${errorMessage(error)}`,
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
    listener: SyncularPresenceSink<TMetadata>
  ): () => void {
    return this.addEventListener(
      'presenceChanged',
      listener as SyncularClientEventSink<'presenceChanged'>
    );
  }

  addLiveQueryListener(
    queryId: string,
    listener: (event: SyncularLiveQueryEvent<Record<string, unknown>>) => void
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
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = undefined;
    this.#emitLifecycleChanged();
    try {
      await this.#request({ type: 'close' });
    } finally {
      this.#flushRowsChanged();
      this.#rejectAll(
        createSyncularWorkerErrorPayload(
          'worker.closed',
          'Syncular worker client closed'
        )
      );
      if (this.ownsWorker) this.worker.terminate();
    }
  }

  async #requestAndDrain<T>(request: SyncularWorkerRequestInput): Promise<T> {
    const value = await this.#request<T>(request);
    await this.#emitLiveEvents();
    if (shouldEmitOperationalState(request.type)) {
      void this.#emitOperationalState();
    }
    return value;
  }

  async #syncWithAuthRetry(
    request: Extract<
      SyncularWorkerRequestInput,
      { type: 'syncPull' | 'syncPush' | 'syncOnce' }
    >,
    options: { refreshAuthHeaders: boolean } = { refreshAuthHeaders: true }
  ): Promise<SyncularSyncResult> {
    const config = this.#config;
    if (!config) {
      throw new Error('Syncular worker client must be opened before sync');
    }
    assertSyncularRemoteMode(config, request.type);
    if (options.refreshAuthHeaders) {
      await this.#refreshAuthHeaders({ restartRealtime: false });
    }
    try {
      const result = await this.#requestAndDrain<SyncularSyncResult>(request);
      this.#emitBootstrapChanged(result);
      return result;
    } catch (error) {
      const shouldRetry = await this.#resolveAuthRetry(error, 'sync');
      if (!shouldRetry) throw error;
      await this.#refreshAuthHeaders({ restartRealtime: false });
      const result = await this.#requestAndDrain<SyncularSyncResult>(request);
      this.#emitBootstrapChanged(result);
      return result;
    }
  }

  async #requestWithAuthRetry<T>(
    request: SyncularWorkerRequestInput,
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
      message: 'Syncular auth headers refreshed',
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
      message: `Syncular auth expired during ${operation}`,
      details: context,
    });
    await lifecycle.onAuthExpired?.(context);
    const refreshResult = await this.#refreshAuthSingleFlight(context);
    this.#emitDiagnostic({
      level: refreshResult ? 'info' : 'warn',
      source: 'auth',
      code: refreshResult ? 'auth.refresh_succeeded' : 'auth.refresh_failed',
      message: refreshResult
        ? 'Syncular auth refresh succeeded'
        : 'Syncular auth refresh did not produce fresh credentials',
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

  #request<T>(request: SyncularWorkerRequestInput): Promise<T> {
    if (this.#closed && request.type !== 'close') {
      return Promise.reject(
        new SyncularWorkerError(
          createSyncularWorkerErrorPayload(
            'worker.closed',
            'Syncular worker client is closed'
          )
        )
      );
    }
    const id = this.#nextId++;
    const message = {
      ...request,
      id,
      protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
    } as SyncularWorkerRequest;
    return new Promise<T>((resolve, reject) => {
      const requestTimeoutMs = this.#timeoutMsForRequest(request.type);
      const timeout =
        requestTimeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              this.#sendCancel(id);
              this.#emitDiagnostic({
                level: 'warn',
                source: 'worker',
                code: 'worker.request_timeout',
                message: `Syncular worker request ${request.type} timed out`,
                details: {
                  requestId: id,
                  requestType: request.type,
                  timeoutMs: requestTimeoutMs,
                },
              });
              const error = new SyncularWorkerError(
                createSyncularWorkerErrorPayload(
                  'worker.request_timeout',
                  `Syncular worker request ${request.type} timed out after ${requestTimeoutMs}ms`,
                  { details: { requestId: id, requestType: request.type } }
                )
              );
              this.#lastError = {
                message: error.message,
                code: error.code,
              };
              this.#emitLifecycleChanged();
              reject(error);
            }, requestTimeoutMs)
          : undefined;
      this.#pending.set(id, {
        type: request.type,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#emitLifecycleChanged();
      this.worker.postMessage(message);
    });
  }

  #timeoutMsForRequest(type: SyncularGeneratedWorkerRequestType): number {
    return syncularWorkerRequestTimeoutMs(this.#requestTimeouts, type);
  }

  #handleWorkerMessage(message: SyncularWorkerOutboundMessage): void {
    if (message.protocolVersion !== SYNCULAR_WORKER_PROTOCOL_VERSION) {
      this.#rejectAll(
        createSyncularWorkerErrorPayload(
          'worker.protocol_mismatch',
          `Unsupported Syncular worker protocol ${message.protocolVersion}`,
          { details: { supported: SYNCULAR_WORKER_PROTOCOL_VERSION } }
        )
      );
      return;
    }
    if (isWorkerEvent(message)) {
      this.#handleWorkerEvent(message);
      return;
    }
    this.#handleResponse(message);
  }

  #handleResponse(response: SyncularWorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      const error = new SyncularWorkerError(response.error);
      this.#lastError = {
        message: error.message,
        code: error.code,
      };
      pending.reject(error);
    }
    this.#emitLifecycleChanged();
  }

  #handleWorkerEvent(
    event: Exclude<SyncularWorkerOutboundMessage, SyncularWorkerResponse>
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
      this.#lastBootstrap = event.bootstrap;
      if (event.bootstrap.complete) {
        this.#recoveryRequired = false;
        this.#authRequired = false;
        this.#lastError = undefined;
      }
      this.#emitClientEvent('bootstrapChanged', event.bootstrap);
      this.#emitLifecycleChanged();
      return;
    }
    if (event.type === 'realtimeState') {
      this.#realtimeState = event.state;
      this.#emitDiagnostic({
        level: 'info',
        source: 'realtime',
        code: 'realtime.state',
        message: `Syncular realtime is ${event.state}`,
        details: { state: event.state },
      });
      if (event.state === 'connected') {
        this.#rejoinPresence();
      }
      this.#emitLifecycleChanged();
      return;
    }
    if (event.type === 'presenceEvent') {
      this.#applyPresenceEvent(event);
      return;
    }
    this.#emitDiagnostic(event.event);
  }

  #emitClientEvent<T extends SyncularClientEventType>(
    event: T,
    payload: SyncularClientEventMap[T]
  ): void {
    const listeners = this.#eventListeners.get(event);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(payload as SyncularClientEventMap[SyncularClientEventType]);
      } catch {
        // Client event listeners must never break sync control flow.
      }
    }
  }

  #emitLifecycleChanged(): void {
    const state = this.#computeLifecycleState();
    if (this.#lastLifecycleState && sameJson(this.#lastLifecycleState, state)) {
      return;
    }
    this.#lastLifecycleState = state;
    this.#emitClientEvent('lifecycleChanged', state);
  }

  #pendingSyncRequestCount(): number {
    let count = 0;
    for (const pending of this.#pending.values()) {
      if (
        pending.type === 'syncOnce' ||
        pending.type === 'syncPull' ||
        pending.type === 'syncPush'
      ) {
        count += 1;
      }
    }
    return count;
  }

  #subscribeNetworkEvents(): (() => void) | undefined {
    const network = this.#network;
    if (!network?.addEventListener || !network.removeEventListener) return;
    const refresh = () => {
      const next = network.isOnline();
      if (next === this.#networkOnline) return;
      this.#networkOnline = next;
      this.#emitLifecycleChanged();
    };
    network.addEventListener('online', refresh);
    network.addEventListener('offline', refresh);
    return () => {
      network.removeEventListener?.('online', refresh);
      network.removeEventListener?.('offline', refresh);
    };
  }

  #hasClientEventListeners(event: SyncularClientEventType): boolean {
    return (this.#eventListeners.get(event)?.size ?? 0) > 0;
  }

  #hasDiagnosticListeners(): boolean {
    return this.#diagnosticListeners.size > 0;
  }

  #emitRowsChanged(event: SyncularClientEventMap['rowsChanged']): void {
    if (
      this.#rowsChangedDebounceMs === false ||
      this.#rowsChangedDebounceMs <= 0
    ) {
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

  #deliverRowsChanged(event: SyncularClientEventMap['rowsChanged']): void {
    for (const listener of this.#rowsChangedListeners) {
      try {
        listener(event);
      } catch {
        // Row-change listeners must never break worker event handling.
      }
    }
    this.#emitClientEvent('rowsChanged', event);
  }

  #emitBootstrapChanged(result: SyncularSyncResult): void {
    this.#lastBootstrap = result.bootstrap;
    this.#recoveryRequired = false;
    this.#authRequired = false;
    this.#lastError = undefined;
    appendSyncularSyncTimings(this.#recentSyncTimings, result.timings);
    this.#emitClientEvent('bootstrapChanged', result.bootstrap);
    this.#emitLifecycleChanged();
  }

  async #emitOperationalState(): Promise<void> {
    const observeLifecycle = this.#hasClientEventListeners('lifecycleChanged');
    const observeOutbox =
      observeLifecycle || this.#hasClientEventListeners('outboxChanged');
    const observeConflicts =
      observeLifecycle || this.#hasClientEventListeners('conflictsChanged');
    const observeBlobUploads =
      observeLifecycle || this.#hasClientEventListeners('blobUploadsChanged');
    if (!observeOutbox && !observeConflicts && !observeBlobUploads) {
      return;
    }
    const [outboxStats, conflictStats, blobUploadStats] = await Promise.all([
      observeOutbox
        ? this.#readOutboxStats().catch(() => undefined)
        : Promise.resolve(undefined),
      observeConflicts
        ? this.#readConflictStats().catch(() => undefined)
        : Promise.resolve(undefined),
      observeBlobUploads
        ? this.#readBlobUploadStats().catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    if (outboxStats && !sameJson(this.#lastOutboxStats, outboxStats)) {
      this.#lastOutboxStats = outboxStats;
      this.#emitClientEvent('outboxChanged', outboxStats);
    }
    if (conflictStats && !sameJson(this.#lastConflictStats, conflictStats)) {
      this.#lastConflictStats = conflictStats;
      this.#emitClientEvent('conflictsChanged', conflictStats);
    }
    if (
      blobUploadStats &&
      !sameJson(this.#lastBlobUploadStats, blobUploadStats)
    ) {
      this.#lastBlobUploadStats = blobUploadStats;
      this.#emitClientEvent('blobUploadsChanged', blobUploadStats);
    }
    this.#emitLifecycleChanged();
  }

  #readBlobUploadStats(): Promise<SyncularBlobUploadQueueStats> {
    return this.#request({ type: 'blobUploadQueueStats' });
  }

  async #readOutboxStats(): Promise<SyncularOutboxStats> {
    const result = await this.#request<
      SyncularSqlResult<{ status: string; count: number }>
    >({
      type: 'executeUnsafeSql',
      sql: 'select status, count(*) as count from sync_outbox_commits group by status',
      params: [],
    });
    const stats: SyncularOutboxStats = {
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

  async #readConflictStats(): Promise<SyncularConflictStats> {
    const result = await this.#request<
      SyncularSqlResult<{
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
    const result = await this.#request<SyncularSqlResult<BlobOutboxRow>>({
      type: 'executeUnsafeSql',
      sql:
        'select hash, size, mime_type, encrypted, key_id, status, error ' +
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
        const ref = {
          hash: before.hash,
          size: coerceCount(before.size),
          mimeType: before.mime_type,
          encrypted: before.encrypted === true || before.encrypted === 1,
          ...(before.key_id ? { keyId: before.key_id } : {}),
        };
        this.#emitClientEvent('blobUploadCompleted', {
          ref,
        });
        if (this.#hasDiagnosticListeners()) {
          this.#emitDiagnostic({
            level: 'info',
            source: 'blob',
            code: 'blob.upload_completed',
            message: 'Syncular blob upload completed',
            details: ref,
          });
        }
        continue;
      }
      if (before.status !== 'failed' && next.status === 'failed') {
        const ref = {
          hash: next.hash,
          size: coerceCount(next.size),
          mimeType: next.mime_type,
          encrypted: next.encrypted === true || next.encrypted === 1,
          ...(next.key_id ? { keyId: next.key_id } : {}),
        };
        this.#emitClientEvent('blobUploadFailed', {
          hash: next.hash,
          error: next.error ?? 'Blob upload failed',
          ref,
        });
        if (this.#hasDiagnosticListeners()) {
          this.#emitDiagnostic({
            level: 'warn',
            source: 'blob',
            code: 'blob.upload_failed',
            message: next.error ?? 'Syncular blob upload failed',
            details: {
              ...ref,
              error: next.error ?? 'Blob upload failed',
            },
          });
        }
      }
    }
  }

  #applyPresenceEvent(event: {
    action: 'join' | 'leave' | 'update' | 'snapshot';
    scopeKey: string;
    clientId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
    entries?: SyncularPresenceEntry[];
  }): void {
    const scopeKey = normalizePresenceScopeKey(event.scopeKey);
    if (!scopeKey) return;
    const current = this.#presenceByScopeKey.get(scopeKey) ?? [];
    let next: SyncularPresenceEntry[];
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
          message: `Syncular presence rejoin failed: ${errorMessage(error)}`,
          details: { scopeKey },
        });
      });
    }
  }

  #rejectAll(reason: SyncularWorkerErrorPayload | Error): void {
    const error =
      reason instanceof Error ? reason : new SyncularWorkerError(reason);
    this.#lastError = {
      message: error.message,
      ...(error instanceof SyncularWorkerError ? { code: error.code } : {}),
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
      protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      requestId,
    } satisfies SyncularWorkerRequest);
  }

  #emitDiagnostic(
    event: Omit<SyncularDiagnosticEvent, 'at'> & { at?: number }
  ): void {
    const diagnostic: SyncularDiagnosticEvent = {
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
    };
    if (diagnostic.details?.resyncRequired === true) {
      this.#recoveryRequired = true;
    }
    if (
      diagnostic.code === 'auth.expired' ||
      diagnostic.code === 'auth.refresh_failed' ||
      diagnostic.code === 'sync.auth_required'
    ) {
      this.#authRequired = true;
    }
    if (diagnostic.code === 'auth.refresh_succeeded') {
      this.#authRequired = false;
    }
    this.#lastDiagnostic = diagnostic;
    appendSyncularDiagnosticEvent(this.#recentDiagnostics, diagnostic);
    this.#emitLifecycleChanged();
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
  if (!(error instanceof SyncularWorkerError)) return false;
  const message = errorMessage(error).toLowerCase();
  if (message.includes('install opfs-sahpool vfs')) return true;
  return (
    message.includes('sync access handle') &&
    /failed|unavailable|unsupported|not supported|not available|denied|blocked|securityerror|notallowederror|nomodificationallowederror/u.test(
      message
    )
  );
}

function createStorageFallbackFailureError(
  opfsError: unknown,
  fallbackError: unknown,
  fallback: SyncularStorageFallbackInfo
): SyncularWorkerError {
  return new SyncularWorkerError(
    createSyncularWorkerErrorPayload(
      'storage.failed',
      `Syncular browser storage could not open ${fallback.from} or ${fallback.to}.`,
      {
        details: {
          from: fallback.from,
          to: fallback.to,
          opfsFailure: summarizeStorageOpenFailure(opfsError),
          fallbackFailure: summarizeStorageOpenFailure(fallbackError),
        },
      }
    )
  );
}

function summarizeStorageOpenFailure(error: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = { message: errorMessage(error) };
  if (error instanceof SyncularWorkerError) {
    summary.code = error.code;
    if (error.category !== undefined) summary.category = error.category;
    summary.retryable = error.retryable;
    if (error.recommendedAction !== undefined) {
      summary.recommendedAction = error.recommendedAction;
    }
    if (error.details !== undefined) summary.details = error.details;
    return summary;
  }
  if (error instanceof Error) {
    summary.name = error.name;
  }
  return summary;
}

function shouldEmitOperationalState(
  type: SyncularWorkerRequestInput['type']
): boolean {
  return isGeneratedSyncularOperationalStateWorkerRequestType(type);
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

function cloneAuthHeaders(headers: SyncularAuthHeaders): SyncularAuthHeaders {
  return Object.fromEntries(Object.entries(headers));
}

function serializeRuntimeArtifact(
  runtime: SyncularRuntimeArtifact | undefined
): SyncularWorkerRuntimeArtifact | undefined {
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
  config: SyncularFieldEncryptionConfig
): Omit<SyncularFieldEncryptionConfig, 'keys'> & {
  keys: Record<string, string>;
} {
  const keys: Record<string, string> = {};
  for (const [kid, value] of Object.entries(config.keys)) {
    keys[kid] = value instanceof Uint8Array ? bytesToBase64Url(value) : value;
  }
  return { ...config, keys };
}

function normalizeEncryptedCrdtConfig(
  config: SyncularEncryptedCrdtConfig
): Omit<SyncularEncryptedCrdtConfig, 'keys'> & {
  keys: Record<string, string>;
} {
  const keys: Record<string, string> = {};
  for (const [kid, value] of Object.entries(config.keys)) {
    keys[kid] = value instanceof Uint8Array ? bytesToBase64Url(value) : value;
  }
  return { ...config, keys };
}

function normalizeBlobEncryptionConfig(
  config: SyncularBlobEncryptionConfig
): Omit<SyncularBlobEncryptionConfig, 'keys'> & {
  keys: Record<string, string>;
} {
  const keys: Record<string, string> = {};
  for (const [kid, value] of Object.entries(config.keys)) {
    keys[kid] = value instanceof Uint8Array ? bytesToBase64Url(value) : value;
  }
  return { ...config, keys };
}

function arePresenceEntriesEqual(
  left: readonly SyncularPresenceEntry[],
  right: readonly SyncularPresenceEntry[]
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
  options: SyncularRealtimeOptions,
  config: ResolvedSyncularClientConfig
): Promise<SyncularWorkerRealtimeOptions> {
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

function assertSyncularRemoteMode(
  config: ResolvedSyncularClientConfig,
  operation: string
): void {
  if (isSyncularRemoteMode(config)) return;
  throw new Error(
    `Syncular ${operation} requires remote mode; current mode is ${config.mode}`
  );
}

function isWorkerEvent(
  message: SyncularWorkerOutboundMessage
): message is Exclude<SyncularWorkerOutboundMessage, SyncularWorkerResponse> {
  return 'type' in message && !('id' in message);
}

function authStatusFromError(error: unknown): 401 | 403 | undefined {
  const details =
    error instanceof SyncularWorkerError ? error.details : undefined;
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
