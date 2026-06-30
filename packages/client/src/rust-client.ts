import type {
  BlobRef,
  SyncAuthLeaseIssueRequest,
  SyncOperation,
} from '@syncular/core';
import { issueSyncularAuthLease } from './auth-leases';
import { assertSyncularBlobPayloadLimit } from './blob-limits';
import { resolveSyncularClientConfig } from './client-config';
import {
  appendSyncularDiagnosticEvent,
  appendSyncularSyncTimings,
  createSyncularSyncAttempt,
  summarizeSyncularDiagnosticSubscriptions,
  syncularDiagnosticAttemptFields,
  syncularSyncAttemptHeaders,
} from './diagnostics';
import { SyncularClientError, toSyncularClientError } from './errors';
import { createSyncularRuntimeInfo } from './runtime-contract';
import { assertSyncularReadonlySql } from './sql-safety';
import type {
  ResolvedSyncularClientConfig,
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularApplyYjsTextUpdatesResult,
  SyncularAuthHeaders,
  SyncularAuthLeaseRecord,
  SyncularBlobCacheStats,
  SyncularBlobEncryptionConfig,
  SyncularBlobLimits,
  SyncularBlobStoreOptions,
  SyncularBlobUploadQueueProcessOptions,
  SyncularBlobUploadQueueStats,
  SyncularBootstrapState,
  SyncularBootstrapStatus,
  SyncularBootstrapSubscriptionPhase,
  SyncularBuildYjsTextUpdateArgs,
  SyncularBuildYjsTextUpdateResult,
  SyncularChangedRow,
  SyncularClientConfig,
  SyncularConflictResolution,
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
  SyncularPullOptions,
  SyncularRowsChangedEvent,
  SyncularRowsChangedSink,
  SyncularRuntimeArtifact,
  SyncularRuntimeInfo,
  SyncularSchemaState,
  SyncularSqlResult,
  SyncularStorageCompactionOptions,
  SyncularStorageCompactionReport,
  SyncularSubscriptionSpec,
  SyncularSyncAttempt,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
  SyncularSyncTimings,
  SyncularTransportStats,
} from './types';
import {
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  loadSyncularWasmGlue,
  prepareSyncularWasmModuleInput,
  readSyncularRustRuntimeInfo,
  type SyncularRustOwnedSqliteClient,
  type SyncularWasmGlue,
} from './wasm-runtime';

interface CreateSyncularRustClientOptions {
  module?: SyncularWasmGlue | Promise<SyncularWasmGlue>;
  wasmGlueUrl?: string | URL;
  wasmUrl?: string | URL | Request;
  runtime?: SyncularRuntimeArtifact;
  config: SyncularClientConfig;
  blobLimits?: SyncularBlobLimits;
}

type RawSyncResult = {
  changed_tables?: string[];
  changed_rows?: SyncularChangedRow[];
  changed_rows_truncated?: boolean;
  subscriptions?: Array<{
    id: string;
    table: string;
    status: string;
    scopes: Record<string, string | string[]>;
    next_cursor: number;
    bootstrap_phase?: number;
    bootstrap_state?: RawBootstrapState | null;
    ready?: boolean;
    phase?: SyncularBootstrapSubscriptionPhase;
    progress_percent?: number;
    snapshot_rows?: unknown[];
    commits?: unknown[];
  }>;
  bootstrap?: RawBootstrapStatus;
  pushed_commits?: number;
  timings?: {
    total_ms?: number;
    push_ms?: number;
    pull_ms?: number;
    pull_request_ms?: number;
    sync_pack_decode_ms?: number;
    pull_transform_ms?: number;
    integrity_verify_ms?: number;
    snapshot_fetch_ms?: number;
    pull_apply_ms?: number;
    scope_clear_ms?: number;
    snapshot_row_apply_ms?: number;
    snapshot_artifact_apply_ms?: number;
    snapshot_artifact_checkpoint_ms?: number;
    snapshot_artifact_checkpoint_count?: number;
    snapshot_chunk_apply_ms?: number;
    snapshot_chunk_materialize_ms?: number;
    snapshot_chunk_reset_ms?: number;
    snapshot_chunk_bind_ms?: number;
    snapshot_chunk_step_ms?: number;
    commit_apply_ms?: number;
    subscription_state_ms?: number;
    notify_ms?: number;
  };
};

type RawBootstrapState = {
  asOfCommitSeq?: number;
  tables?: string[];
  tableIndex?: number;
  rowCursor?: string | null;
};

type RawBootstrapStatus = {
  channel_phase?: string;
  progress_percent?: number;
  is_bootstrapping?: boolean;
  critical_ready?: boolean;
  interactive_ready?: boolean;
  complete?: boolean;
  active_phase?: number | null;
  expected_subscription_ids?: string[];
  ready_subscription_ids?: string[];
  pending_subscription_ids?: string[];
  subscriptions?: Array<{
    id: string;
    table: string;
    expected?: boolean;
    ready?: boolean;
    status?: string | null;
    phase?: SyncularBootstrapSubscriptionPhase;
    progress_percent?: number;
    cursor?: number | null;
    bootstrap_state?: RawBootstrapState | null;
    bootstrap_phase?: number;
  }>;
  phases?: Array<{
    phase?: number;
    expected_subscription_ids?: string[];
    ready_subscription_ids?: string[];
    pending_subscription_ids?: string[];
    is_ready?: boolean;
    progress_percent?: number;
  }>;
};

type RawConflictSummary = {
  id: string;
  client_commit_id: string;
  op_index: number;
  result_status: string;
  message: string;
  code: string | null;
  server_version: number | null;
  resolved_at: number | null;
  resolution: string | null;
};

type SyncularBootstrapSubscriptionStatusEntry = {
  id: string;
  table: string;
  status: string | null;
  ready: boolean;
  phase: SyncularBootstrapSubscriptionPhase;
  progressPercent: number;
  cursor: number | null;
  bootstrapState: SyncularBootstrapState | null;
  bootstrapPhase: number;
};

export async function openSyncularRustClient(
  options: CreateSyncularRustClientOptions
): Promise<SyncularRustClient> {
  const wasmGlueUrl =
    options.runtime?.wasmGlueUrl ??
    options.wasmGlueUrl ??
    getSyncularWasmGlueUrl();
  const mod = await (options.module ??
    (options.runtime?.wasmGlueUrl || options.wasmGlueUrl
      ? loadSyncularWasmGlueFromUrl(wasmGlueUrl)
      : loadSyncularWasmGlue()));
  const wasmUrl =
    options.runtime?.wasmUrl ?? options.wasmUrl ?? getSyncularWasmUrl();
  const config = resolveSyncularClientConfig(options.config);
  await mod.default({
    module_or_path: await prepareSyncularWasmModuleInput(wasmUrl),
  });
  const rustRuntimeInfo = readSyncularRustRuntimeInfo(mod);
  return new SyncularRustClient(
    await mod.openSyncularRustOwnedSqliteClient(config),
    createSyncularRuntimeInfo({
      storage: config.storage,
      wasmGlueUrl,
      wasmUrl,
      rust: rustRuntimeInfo,
    }),
    config,
    config.pull,
    options.blobLimits
  );
}

function loadSyncularWasmGlueFromUrl(
  wasmGlueUrl: string | URL
): Promise<SyncularWasmGlue> {
  const href = wasmGlueUrl instanceof URL ? wasmGlueUrl.href : wasmGlueUrl;
  return import(/* @vite-ignore */ href) as Promise<SyncularWasmGlue>;
}

export class SyncularRustClient {
  #rowsChangedListeners = new Set<SyncularRowsChangedSink>();
  #diagnosticListeners = new Set<SyncularDiagnosticSink>();
  #recentDiagnostics: SyncularDiagnosticEvent[] = [];
  #recentSyncTimings: SyncularSyncTimings[] = [];
  #subscriptions: SyncularSubscriptionSpec[] = [];
  #authHeaders: SyncularAuthHeaders = {};
  #bootstrapById = new Map<string, SyncularBootstrapSubscriptionStatusEntry>();
  #closed = false;

  constructor(
    private readonly raw: SyncularRustOwnedSqliteClient,
    private readonly runtime: SyncularRuntimeInfo,
    private readonly config: ResolvedSyncularClientConfig,
    private readonly pullOptions: SyncularPullOptions | undefined,
    private readonly blobLimits: SyncularBlobLimits | undefined
  ) {}

  #assertRuntimeFeature(feature: 'crdt-yjs' | 'e2ee', apiName: string): void {
    if (this.runtime.rust?.features.includes(feature)) return;
    throw new Error(
      `Syncular runtime feature "${feature}" is required for ${apiName}. ` +
        'Select the full browser WASM runtime artifact.'
    );
  }

  setSubscriptions(subscriptions: readonly SyncularSubscriptionSpec[]): void {
    this.#subscriptions = [...subscriptions];
    this.#bootstrapById.clear();
    this.raw.setSubscriptionsJson(JSON.stringify(subscriptions));
    this.#emitDiagnostic({
      at: Date.now(),
      level: 'info',
      source: 'client',
      code: 'client.subscriptions.updated',
      message: 'Syncular subscriptions updated',
      details: { subscriptionCount: subscriptions.length },
    });
  }

  async forceSubscriptionsBootstrap(
    subscriptionIds: readonly string[] = []
  ): Promise<number> {
    const count = parseJson<number>(
      await this.raw.forceSubscriptionsBootstrapJson(
        JSON.stringify(subscriptionIds)
      )
    );
    for (const id of subscriptionIds.length > 0
      ? subscriptionIds
      : this.#subscriptions.map((subscription) => subscription.id)) {
      this.#bootstrapById.delete(id);
    }
    return count;
  }

  setAuthHeaders(headers: SyncularAuthHeaders): void {
    this.#authHeaders = { ...headers };
    this.raw.setAuthHeadersJson(JSON.stringify(this.#authHeaders));
  }

  async issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord> {
    const lease = await issueSyncularAuthLease({
      baseUrl: this.config.baseUrl,
      headers: this.#authHeaders,
      request,
      appSchema: this.config.appSchema,
    });
    await this.upsertAuthLease(lease);
    this.#emitDiagnostic({
      at: Date.now(),
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

  async upsertAuthLease(lease: SyncularAuthLeaseRecord): Promise<void> {
    this.raw.upsertAuthLeaseJson(JSON.stringify(lease));
  }

  async authLease(leaseId: string): Promise<SyncularAuthLeaseRecord | null> {
    return parseJson<SyncularAuthLeaseRecord | null>(
      this.raw.authLeaseJson(leaseId)
    );
  }

  async activeAuthLeases(
    actorId?: string | null,
    nowMs = Date.now()
  ): Promise<SyncularAuthLeaseRecord[]> {
    return parseJson<SyncularAuthLeaseRecord[]>(
      this.raw.activeAuthLeasesJson(actorId ?? null, BigInt(Math.trunc(nowMs)))
    );
  }

  setFieldEncryption(config: SyncularFieldEncryptionConfig | null): void {
    if (config == null && !this.runtime.rust?.features.includes('e2ee')) return;
    this.#assertRuntimeFeature('e2ee', 'setFieldEncryption');
    this.raw.setFieldEncryptionJson(
      config == null
        ? 'null'
        : JSON.stringify(normalizeFieldEncryptionConfig(config))
    );
  }

  setEncryptedCrdt(config: SyncularEncryptedCrdtConfig | null): void {
    if (config == null && !this.runtime.rust?.features.includes('e2ee')) return;
    this.#assertRuntimeFeature('e2ee', 'setEncryptedCrdt');
    this.raw.setEncryptedCrdtJson(
      config == null
        ? 'null'
        : JSON.stringify(normalizeEncryptedCrdtConfig(config))
    );
  }

  setBlobEncryption(config: SyncularBlobEncryptionConfig | null): void {
    if (config == null && !this.runtime.rust?.features.includes('e2ee')) return;
    this.#assertRuntimeFeature('e2ee', 'setBlobEncryption');
    this.raw.setBlobEncryptionJson(
      config == null
        ? 'null'
        : JSON.stringify(normalizeBlobEncryptionConfig(config))
    );
  }

  setAbortSignal(signal?: AbortSignal | null): void {
    this.raw.setAbortSignal(signal ?? null);
  }

  async applyMutation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string> {
    const commitId = await this.raw.applyMutationJson(
      JSON.stringify(operation),
      localRow == null ? null : JSON.stringify(localRow)
    );
    this.#drainAndEmitRowsChanged();
    return commitId;
  }

  async applyLeasedMutation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string> {
    const commitId = await this.raw.applyLeasedMutationJson(
      JSON.stringify(operation),
      localRow == null ? null : JSON.stringify(localRow)
    );
    this.#drainAndEmitRowsChanged();
    return commitId;
  }

  async applyMutationsBatch(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string[]> {
    const commitIds = parseJson<string[]>(
      await this.raw.applyMutationsBatchJson(JSON.stringify(operations))
    );
    this.#drainAndEmitRowsChanged();
    return commitIds;
  }

  async applyMutationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string> {
    const commitId = parseJson<string>(
      await this.raw.applyMutationsCommitJson(JSON.stringify(operations))
    );
    this.#drainAndEmitRowsChanged();
    return commitId;
  }

  async applyLeasedMutationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string> {
    const commitId = parseJson<string>(
      await this.raw.applyLeasedMutationsCommitJson(JSON.stringify(operations))
    );
    this.#drainAndEmitRowsChanged();
    return commitId;
  }

  async syncPull(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    const result = await this.#runTracedSync(
      'syncPull',
      options.syncAttempt,
      async () =>
        this.#decorateSyncResult(parseSyncResult(await this.raw.syncPullJson()))
    );
    this.#captureSyncTimings(result);
    this.#emitRowsChanged('remotePull', result);
    return result;
  }

  async applyRealtimeSyncPack(bytes: Uint8Array): Promise<SyncularSyncResult> {
    const result = this.#decorateSyncResult(
      parseSyncResult(await this.raw.applyRealtimeSyncPackBytes(bytes))
    );
    this.#captureSyncTimings(result);
    this.#emitRowsChanged('remotePull', result);
    return result;
  }

  async syncPush(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    try {
      const result = await this.#runTracedSync(
        'syncPush',
        options.syncAttempt,
        async () =>
          this.#decorateSyncResult(
            parseSyncResult(await this.raw.syncPushJson())
          )
      );
      this.#captureSyncTimings(result);
      this.#emitRowsChanged('localWrite', result);
      return result;
    } catch (error) {
      this.raw.recoverSyncPushErrorJson(String(error));
      throw error;
    }
  }

  async syncOnce(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    try {
      const result = await this.#runTracedSync(
        'syncOnce',
        options.syncAttempt,
        async () =>
          this.#decorateSyncResult(
            parseSyncResult(await this.raw.syncOnceJson())
          )
      );
      this.#captureSyncTimings(result);
      this.#emitRowsChanged('remotePull', result);
      return result;
    } catch (error) {
      this.raw.recoverSyncPushErrorJson(String(error));
      throw error;
    }
  }

  resumeFromBackground(
    options: SyncularSyncRequestOptions = {}
  ): Promise<SyncularSyncResult> {
    return this.syncOnce(options);
  }

  transportStats(): SyncularTransportStats {
    return parseJson(this.raw.transportStatsJson());
  }

  resetTransportStats(): void {
    this.raw.resetTransportStats();
  }

  async conflictSummaries(): Promise<SyncularConflictSummary[]> {
    return parseConflictSummaries(await this.raw.conflictSummariesJson());
  }

  retryConflictKeepLocal(id: string): Promise<string> {
    return this.raw.retryConflictKeepLocal(id);
  }

  resolveConflict(
    id: string,
    resolution: SyncularConflictResolution
  ): Promise<void> {
    return this.raw.resolveConflict(id, resolution);
  }

  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): SyncularSqlResult<Row> {
    assertSyncularReadonlySql(sql);
    return this.raw.executeSqlValue(sql, params) as SyncularSqlResult<Row>;
  }

  executeUnsafeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params: readonly unknown[] = []): SyncularSqlResult<Row> {
    return this.raw.executeUnsafeSqlValue(
      sql,
      params
    ) as SyncularSqlResult<Row>;
  }

  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[],
    hints: readonly SyncularLiveQueryDependencyHint[] = []
  ): SyncularLiveQuerySnapshot<Row> {
    return parseJson(
      this.raw.subscribeQueryJson(
        sql,
        stringifyParams(params),
        JSON.stringify(tables),
        JSON.stringify(hints)
      )
    );
  }

  unsubscribeQuery(id: string): void {
    this.raw.unsubscribeQuery(id);
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularLiveQueryEvent<Row>> {
    return parseJson(this.raw.drainLiveQueryEventsJson());
  }

  liveQueryDiagnostics(): SyncularLiveQueryDiagnostics {
    return parseJson(this.raw.liveQueryDiagnosticsJson());
  }

  addRowsChangedListener(listener: SyncularRowsChangedSink): () => void {
    this.#rowsChangedListeners.add(listener);
    return () => {
      this.#rowsChangedListeners.delete(listener);
    };
  }

  async listTable<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(table: string): Promise<Row[]> {
    return parseJson(await this.raw.listTableJson(table));
  }

  async storeBlob(
    data: Uint8Array,
    options: SyncularBlobStoreOptions = {}
  ): Promise<BlobRef> {
    assertSyncularBlobPayloadLimit({
      operation: 'store',
      size: data.byteLength,
      limits: this.blobLimits,
      options,
      diagnostics: (event) => this.#emitDiagnostic(event),
    });
    return parseJson(
      await this.raw.storeBlobJson(data, JSON.stringify(options))
    );
  }

  async retrieveBlob(ref: BlobRef): Promise<Uint8Array> {
    assertSyncularBlobPayloadLimit({
      operation: 'retrieve',
      size: ref.size,
      limits: this.blobLimits,
      refHash: ref.hash,
      diagnostics: (event) => this.#emitDiagnostic(event),
    });
    const wasLocal = this.#hasDiagnosticListeners()
      ? this.raw.isBlobLocal(ref.hash)
      : undefined;
    try {
      const bytes = await this.raw.retrieveBlob(JSON.stringify(ref));
      if (wasLocal !== undefined) {
        this.#emitDiagnostic({
          at: Date.now(),
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
          at: Date.now(),
          level: 'warn',
          source: 'blob',
          code: 'blob.download_failed',
          message: `Syncular blob download failed: ${String(error)}`,
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

  isBlobLocal(hash: string): boolean {
    const local = this.raw.isBlobLocal(hash);
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        at: Date.now(),
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
    const result = parseJson<{ uploaded: number; failed: number }>(
      await this.raw.processBlobUploadQueueJson(options?.retryNow === true)
    );
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        at: Date.now(),
        level: result.failed > 0 ? 'warn' : 'info',
        source: 'blob',
        code: 'blob.upload_queue_processed',
        message: 'Syncular blob upload queue processed',
        details: result,
      });
    }
    return result;
  }

  blobUploadQueueStats(): SyncularBlobUploadQueueStats {
    return parseJson(this.raw.blobUploadQueueStatsJson());
  }

  blobCacheStats(): SyncularBlobCacheStats {
    return parseJson(this.raw.blobCacheStatsJson());
  }

  pruneBlobCache(maxBytes = 0): number {
    const prunedBytes = Number(this.raw.pruneBlobCache(BigInt(maxBytes)));
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        at: Date.now(),
        level: 'info',
        source: 'blob',
        code: 'blob.cache_pruned',
        message: 'Syncular blob cache pruned',
        details: { prunedBytes, maxBytes },
      });
    }
    return prunedBytes;
  }

  clearBlobCache(): void {
    this.raw.clearBlobCache();
    if (this.#hasDiagnosticListeners()) {
      this.#emitDiagnostic({
        at: Date.now(),
        level: 'info',
        source: 'blob',
        code: 'blob.cache_cleared',
        message: 'Syncular blob cache cleared',
      });
    }
  }

  compactStorage(
    options: SyncularStorageCompactionOptions = {}
  ): SyncularStorageCompactionReport {
    return parseJson(this.raw.compactStorageJson(JSON.stringify(options)));
  }

  generatedSchemaState(): SyncularSchemaState {
    return parseJson(this.raw.generatedSchemaStateJson());
  }

  async localHealthCheck(): Promise<SyncularLocalHealthReport> {
    return parseJson(await this.raw.localHealthCheckJson());
  }

  async exportLocalSupportBundle(): Promise<SyncularLocalSupportBundle> {
    return parseJson(await this.raw.exportLocalSupportBundleJson());
  }

  async importLocalSupportBundle(
    bundle: SyncularLocalSupportBundle | string
  ): Promise<SyncularLocalSupportBundleImportReport> {
    const bundleJson =
      typeof bundle === 'string' ? bundle : JSON.stringify(bundle);
    return parseJson(await this.raw.importLocalSupportBundleJson(bundleJson));
  }

  async repairLocalHealth(
    request: SyncularLocalHealthRepairRequest
  ): Promise<SyncularLocalHealthRepairReport> {
    const normalized = {
      action: request.action,
      subscriptionIds: [...(request.subscriptionIds ?? [])],
      tables: [...(request.tables ?? [])],
    };
    return parseJson(
      await this.raw.repairLocalHealthJson(JSON.stringify(normalized))
    );
  }

  async resetLocalSyncState(
    request: SyncularLocalSyncResetRequest = {}
  ): Promise<SyncularLocalSyncResetReport> {
    const normalized = {
      subscriptionIds: [...(request.subscriptionIds ?? [])],
      clearSyncedRows: request.clearSyncedRows === true,
    };
    const result = parseJson<SyncularLocalSyncResetReport>(
      await this.raw.resetLocalSyncStateJson(JSON.stringify(normalized))
    );
    for (const id of normalized.subscriptionIds.length > 0
      ? normalized.subscriptionIds
      : this.#subscriptions.map((subscription) => subscription.id)) {
      this.#bootstrapById.delete(id);
    }
    return result;
  }

  buildYjsTextUpdate(
    args: SyncularBuildYjsTextUpdateArgs
  ): SyncularBuildYjsTextUpdateResult {
    this.#assertRuntimeFeature('crdt-yjs', 'buildYjsTextUpdate');
    return parseJson(this.raw.buildYjsTextUpdateJson(JSON.stringify(args)));
  }

  applyYjsTextUpdates(
    args: SyncularApplyYjsTextUpdatesArgs
  ): SyncularApplyYjsTextUpdatesResult {
    this.#assertRuntimeFeature('crdt-yjs', 'applyYjsTextUpdates');
    return parseJson(this.raw.applyYjsTextUpdatesJson(JSON.stringify(args)));
  }

  applyYjsEnvelopeToPayload(
    args: SyncularApplyYjsEnvelopeToPayloadArgs
  ): Record<string, unknown> {
    this.#assertRuntimeFeature('crdt-yjs', 'applyYjsEnvelopeToPayload');
    const result = parseJson<{ payload: Record<string, unknown> }>(
      this.raw.applyYjsEnvelopeToPayloadJson(JSON.stringify(args))
    );
    return result.payload;
  }

  async openCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldDescriptor> {
    this.#assertRuntimeFeature('crdt-yjs', 'openCrdtField');
    return parseJson(this.raw.openCrdtFieldJson(JSON.stringify(request)));
  }

  async applyCrdtFieldText(
    request: SyncularCrdtFieldTextRequest
  ): Promise<SyncularCrdtFieldWriteReceipt> {
    this.#assertRuntimeFeature('crdt-yjs', 'applyCrdtFieldText');
    const receipt = parseJson<SyncularCrdtFieldWriteReceipt>(
      this.raw.applyCrdtFieldTextJson(JSON.stringify(request))
    );
    this.#drainAndEmitRowsChanged();
    return receipt;
  }

  async applyCrdtFieldYjsUpdate(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<SyncularCrdtFieldWriteReceipt> {
    this.#assertRuntimeFeature('crdt-yjs', 'applyCrdtFieldYjsUpdate');
    const receipt = parseJson<SyncularCrdtFieldWriteReceipt>(
      this.raw.applyCrdtFieldYjsUpdateJson(JSON.stringify(request))
    );
    this.#drainAndEmitRowsChanged();
    return receipt;
  }

  async materializeCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldMaterialization> {
    this.#assertRuntimeFeature('crdt-yjs', 'materializeCrdtField');
    return parseJson(
      this.raw.materializeCrdtFieldJson(JSON.stringify(request))
    );
  }

  async crdtDocumentSnapshot(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtDocumentSnapshot> {
    this.#assertRuntimeFeature('crdt-yjs', 'crdtDocumentSnapshot');
    return parseJson(
      this.raw.crdtDocumentSnapshotJson(JSON.stringify(request))
    );
  }

  async crdtUpdateLog(
    request: SyncularCrdtFieldRequest & { limit?: number }
  ): Promise<SyncularCrdtUpdateLogEntry[]> {
    this.#assertRuntimeFeature('crdt-yjs', 'crdtUpdateLog');
    return parseJson(this.raw.crdtUpdateLogJson(JSON.stringify(request)));
  }

  async snapshotCrdtFieldStateVector(
    request: SyncularCrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }> {
    this.#assertRuntimeFeature('crdt-yjs', 'snapshotCrdtFieldStateVector');
    return parseJson(
      this.raw.snapshotCrdtFieldStateVectorJson(JSON.stringify(request))
    );
  }

  async compactCrdtField(
    request: SyncularCrdtFieldCompactionRequest
  ): Promise<SyncularCrdtFieldCompactionReceipt> {
    this.#assertRuntimeFeature('crdt-yjs', 'compactCrdtField');
    const receipt = parseJson<SyncularCrdtFieldCompactionReceipt>(
      this.raw.compactCrdtFieldJson(JSON.stringify(request))
    );
    this.#drainAndEmitRowsChanged();
    return receipt;
  }

  encryptionHelper<T = unknown>(
    method: SyncularEncryptionHelperMethod,
    args: unknown = {}
  ): T {
    this.#assertRuntimeFeature('e2ee', 'encryptionHelper');
    return parseJson(
      this.raw.encryptionHelperJson(method, JSON.stringify(args))
    );
  }

  async runtimeInfo(): Promise<SyncularRuntimeInfo> {
    return this.runtime;
  }

  connectionState(): SyncularConnectionState {
    const lastDiagnostic =
      this.#recentDiagnostics[this.#recentDiagnostics.length - 1];
    return {
      closed: this.#closed,
      pendingRequests: 0,
      realtime: 'disconnected',
      ...(lastDiagnostic ? { lastDiagnostic } : {}),
    };
  }

  lifecycleState(): SyncularLifecycleState {
    const bootstrap = buildBootstrapStatus(
      this.#subscriptions,
      this.#bootstrapById,
      this.pullOptions
    );
    const lastDiagnostic =
      this.#recentDiagnostics[this.#recentDiagnostics.length - 1];
    return {
      phase: this.#closed
        ? 'closed'
        : bootstrap.complete
          ? 'complete'
          : 'offline',
      realtime: 'disconnected',
      online: false,
      requiresAction: false,
      pendingRequests: 0,
      bootstrap: {
        complete: bootstrap.complete,
        criticalReady: bootstrap.criticalReady,
        interactiveReady: bootstrap.interactiveReady,
        isBootstrapping: bootstrap.isBootstrapping,
        progressPercent: bootstrap.progressPercent,
      },
      ...(lastDiagnostic ? { lastDiagnostic } : {}),
    };
  }

  async diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot> {
    const bootstrap = buildBootstrapStatus(
      this.#subscriptions,
      this.#bootstrapById,
      this.pullOptions
    );
    return {
      generatedAt: Date.now(),
      runtime: this.runtime,
      connection: this.connectionState(),
      subscriptions: summarizeSyncularDiagnosticSubscriptions(
        this.#subscriptions,
        bootstrap
      ),
      recentDiagnostics: [...this.#recentDiagnostics],
      recentSyncTimings: [...this.#recentSyncTimings],
      bootstrap,
      transportStats: this.transportStats(),
    };
  }

  addDiagnosticListener(listener: SyncularDiagnosticSink): () => void {
    this.#diagnosticListeners.add(listener);
    return () => {
      this.#diagnosticListeners.delete(listener);
    };
  }

  #decorateSyncResult(result: SyncularSyncResult): SyncularSyncResult {
    for (const subscription of result.subscriptions) {
      this.#bootstrapById.set(subscription.id, {
        id: subscription.id,
        table: subscription.table,
        status: subscription.status,
        ready: subscription.ready,
        phase: subscription.phase,
        progressPercent: subscription.progressPercent,
        cursor: subscription.nextCursor,
        bootstrapState: subscription.bootstrapState,
        bootstrapPhase: subscription.bootstrapPhase,
      });
    }
    return {
      ...result,
      bootstrap: buildBootstrapStatus(
        this.#subscriptions,
        this.#bootstrapById,
        this.pullOptions
      ),
    };
  }

  #emitRowsChanged(
    source: 'localWrite' | 'remotePull',
    result: SyncularSyncResult
  ): void {
    if (
      this.#rowsChangedListeners.size === 0 ||
      (result.changedTables.length === 0 && result.changedRows.length === 0)
    ) {
      return;
    }
    for (const listener of this.#rowsChangedListeners) {
      try {
        listener({
          source,
          changedTables: result.changedTables,
          changedRows: result.changedRows,
          changedRowsTruncated: result.changedRowsTruncated,
        });
      } catch {
        // Row-change listeners must never break client control flow.
      }
    }
  }

  #captureSyncTimings(result: SyncularSyncResult): void {
    appendSyncularSyncTimings(this.#recentSyncTimings, result.timings);
  }

  async #runTracedSync<T>(
    requestType: 'syncPull' | 'syncPush' | 'syncOnce',
    providedAttempt: SyncularSyncAttempt | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    const syncAttempt = providedAttempt ?? createSyncularSyncAttempt();
    const startedAt = Date.now();
    this.#emitDiagnostic({
      at: startedAt,
      level: 'debug',
      source: 'sync',
      code: `sync.${requestType}.started`,
      message: `Syncular ${requestType} started`,
      ...syncularDiagnosticAttemptFields(syncAttempt),
    });
    this.raw.setAuthHeadersJson(
      JSON.stringify({
        ...this.#authHeaders,
        ...syncularSyncAttemptHeaders(syncAttempt),
      })
    );
    try {
      const result = await run();
      this.#emitDiagnostic({
        at: Date.now(),
        level: 'info',
        source: 'sync',
        code: `sync.${requestType}.completed`,
        message: `Syncular ${requestType} completed`,
        ...syncularDiagnosticAttemptFields(syncAttempt),
        details: { requestType, durationMs: Date.now() - startedAt },
      });
      if (isSyncularSyncResult(result)) {
        this.#emitScopeRevokedDiagnostic(requestType, result, syncAttempt);
      }
      return result;
    } catch (error) {
      const classifiedError = toSyncularClientError(error);
      const classified =
        classifiedError instanceof SyncularClientError ? classifiedError : null;
      this.#emitDiagnostic({
        at: Date.now(),
        level: 'warn',
        source: 'sync',
        code: classified?.code ?? `sync.${requestType}.failed`,
        message: `Syncular ${requestType} failed`,
        ...syncularDiagnosticAttemptFields(syncAttempt),
        details: {
          requestType,
          durationMs: Date.now() - startedAt,
          error:
            classifiedError instanceof Error
              ? classifiedError.message
              : String(classifiedError),
          ...(classified
            ? {
                errorCode: classified.code,
                category: classified.category,
                retryable: classified.retryable,
                recommendedAction: classified.recommendedAction,
                ...(classified.details ?? {}),
              }
            : {}),
        },
      });
      throw classifiedError;
    } finally {
      this.raw.setAuthHeadersJson(JSON.stringify(this.#authHeaders));
    }
  }

  #emitDiagnostic(event: SyncularDiagnosticEvent): void {
    appendSyncularDiagnosticEvent(this.#recentDiagnostics, event);
    if (this.#diagnosticListeners.size === 0) return;
    for (const listener of this.#diagnosticListeners) {
      try {
        listener(event);
      } catch {
        // Diagnostics must never break client control flow.
      }
    }
  }

  #hasDiagnosticListeners(): boolean {
    return this.#diagnosticListeners.size > 0;
  }

  #drainAndEmitRowsChanged(): void {
    let events: SyncularRowsChangedEvent[];
    try {
      events = parseJson(this.raw.drainRowsChangedEventsJson());
    } catch {
      return;
    }
    if (this.#rowsChangedListeners.size === 0) return;
    for (const event of events) {
      if (event.changedTables.length === 0 && event.changedRows.length === 0) {
        continue;
      }
      for (const listener of this.#rowsChangedListeners) {
        try {
          listener(event);
        } catch {
          // Row-change listeners must never break client control flow.
        }
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.raw.close();
  }

  #emitScopeRevokedDiagnostic(
    requestType: 'syncPull' | 'syncPush' | 'syncOnce',
    result: SyncularSyncResult,
    syncAttempt: SyncularSyncAttempt
  ): void {
    const revokedSubscriptionIds = result.subscriptions
      .filter((subscription) => subscription.status === 'revoked')
      .map((subscription) => subscription.id);
    if (revokedSubscriptionIds.length === 0) return;

    this.#emitDiagnostic({
      at: Date.now(),
      level: 'warn',
      source: 'sync',
      code: 'sync.scope_revoked',
      message: 'Syncular subscription scope revoked',
      ...syncularDiagnosticAttemptFields(syncAttempt),
      details: {
        requestType,
        revokedSubscriptionIds,
        revokedSubscriptionCount: revokedSubscriptionIds.length,
      },
    });
  }
}

function isSyncularSyncResult(value: unknown): value is SyncularSyncResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { subscriptions?: unknown }).subscriptions)
  );
}

function parseSyncResult(value: string): SyncularSyncResult {
  const raw = parseJson<RawSyncResult>(value);
  return {
    changedTables: raw.changed_tables ?? [],
    changedRows: raw.changed_rows ?? [],
    changedRowsTruncated: raw.changed_rows_truncated ?? false,
    subscriptions: (raw.subscriptions ?? []).map((subscription) => ({
      id: subscription.id,
      table: subscription.table,
      status: subscription.status,
      scopes: subscription.scopes,
      nextCursor: subscription.next_cursor,
      bootstrapPhase: subscription.bootstrap_phase ?? 0,
      bootstrapState: parseBootstrapState(subscription.bootstrap_state),
      ready: subscription.ready === true,
      phase: subscription.phase ?? 'pending',
      progressPercent: subscription.progress_percent ?? 0,
      snapshotRows: subscription.snapshot_rows ?? [],
      commits: subscription.commits ?? [],
    })),
    bootstrap: parseBootstrapStatus(raw.bootstrap),
    pushedCommits: raw.pushed_commits ?? 0,
    timings: {
      totalMs: raw.timings?.total_ms ?? 0,
      pushMs: raw.timings?.push_ms ?? 0,
      pullMs: raw.timings?.pull_ms ?? 0,
      pullRequestMs: raw.timings?.pull_request_ms ?? 0,
      syncPackDecodeMs: raw.timings?.sync_pack_decode_ms ?? 0,
      pullTransformMs: raw.timings?.pull_transform_ms ?? 0,
      integrityVerifyMs: raw.timings?.integrity_verify_ms ?? 0,
      snapshotFetchMs: raw.timings?.snapshot_fetch_ms ?? 0,
      pullApplyMs: raw.timings?.pull_apply_ms ?? 0,
      scopeClearMs: raw.timings?.scope_clear_ms ?? 0,
      snapshotRowApplyMs: raw.timings?.snapshot_row_apply_ms ?? 0,
      snapshotArtifactApplyMs: raw.timings?.snapshot_artifact_apply_ms ?? 0,
      snapshotArtifactCheckpointMs:
        raw.timings?.snapshot_artifact_checkpoint_ms ?? 0,
      snapshotArtifactCheckpointCount:
        raw.timings?.snapshot_artifact_checkpoint_count ?? 0,
      snapshotChunkApplyMs: raw.timings?.snapshot_chunk_apply_ms ?? 0,
      snapshotChunkMaterializeMs:
        raw.timings?.snapshot_chunk_materialize_ms ?? 0,
      snapshotChunkResetMs: raw.timings?.snapshot_chunk_reset_ms ?? 0,
      snapshotChunkBindMs: raw.timings?.snapshot_chunk_bind_ms ?? 0,
      snapshotChunkStepMs: raw.timings?.snapshot_chunk_step_ms ?? 0,
      commitApplyMs: raw.timings?.commit_apply_ms ?? 0,
      subscriptionStateMs: raw.timings?.subscription_state_ms ?? 0,
      notifyMs: raw.timings?.notify_ms ?? 0,
    },
  };
}

function parseBootstrapState(
  state: RawBootstrapState | null | undefined
): SyncularBootstrapStatus['subscriptions'][number]['bootstrapState'] {
  if (!state) return null;
  return {
    asOfCommitSeq: state.asOfCommitSeq ?? 0,
    tables: state.tables ?? [],
    tableIndex: state.tableIndex ?? 0,
    rowCursor: state.rowCursor ?? null,
  };
}

function parseBootstrapStatus(
  raw: RawBootstrapStatus | null | undefined
): SyncularBootstrapStatus {
  return {
    channelPhase: raw?.channel_phase ?? 'idle',
    progressPercent: raw?.progress_percent ?? 100,
    isBootstrapping: raw?.is_bootstrapping === true,
    criticalReady: raw?.critical_ready ?? true,
    interactiveReady: raw?.interactive_ready ?? true,
    complete: raw?.complete ?? true,
    activePhase: raw?.active_phase ?? null,
    expectedSubscriptionIds: raw?.expected_subscription_ids ?? [],
    readySubscriptionIds: raw?.ready_subscription_ids ?? [],
    pendingSubscriptionIds: raw?.pending_subscription_ids ?? [],
    subscriptions: (raw?.subscriptions ?? []).map((subscription) => ({
      id: subscription.id,
      table: subscription.table,
      expected: subscription.expected ?? true,
      ready: subscription.ready === true,
      status: subscription.status ?? null,
      phase: subscription.phase ?? 'pending',
      progressPercent: subscription.progress_percent ?? 0,
      cursor: subscription.cursor ?? null,
      bootstrapState: parseBootstrapState(subscription.bootstrap_state),
      bootstrapPhase: subscription.bootstrap_phase ?? 0,
    })),
    phases: (raw?.phases ?? []).map((phase) => ({
      phase: phase.phase ?? 0,
      expectedSubscriptionIds: phase.expected_subscription_ids ?? [],
      readySubscriptionIds: phase.ready_subscription_ids ?? [],
      pendingSubscriptionIds: phase.pending_subscription_ids ?? [],
      isReady: phase.is_ready === true,
      progressPercent: phase.progress_percent ?? 0,
    })),
  };
}

function buildBootstrapStatus(
  configuredSubscriptions: readonly SyncularSubscriptionSpec[],
  cachedById: ReadonlyMap<string, SyncularBootstrapSubscriptionStatusEntry>,
  pullOptions: SyncularPullOptions | undefined
): SyncularBootstrapStatus {
  const criticalPhase = normalizeBootstrapPhase(
    pullOptions?.criticalBootstrapPhase
  );
  const interactivePhase = Math.max(
    criticalPhase,
    normalizeBootstrapPhase(pullOptions?.interactiveBootstrapPhase ?? 1)
  );
  const subscriptions = configuredSubscriptions.map((spec) => {
    const cached = cachedById.get(spec.id);
    const bootstrapPhase = normalizeBootstrapPhase(spec.bootstrapPhase);
    return {
      id: spec.id,
      table: spec.table,
      expected: true,
      ready: cached?.ready ?? false,
      status: cached?.status ?? null,
      phase: cached?.phase ?? 'pending',
      progressPercent: cached?.progressPercent ?? 0,
      cursor: cached?.cursor ?? null,
      bootstrapState: cached?.bootstrapState ?? null,
      bootstrapPhase,
    };
  });
  const expectedSubscriptionIds = subscriptions.map(
    (subscription) => subscription.id
  );
  const readySubscriptionIds = subscriptions
    .filter((subscription) => subscription.ready)
    .map((subscription) => subscription.id);
  const pendingSubscriptionIds = subscriptions
    .filter((subscription) => !subscription.ready)
    .map((subscription) => subscription.id);
  const complete = pendingSubscriptionIds.length === 0;
  const criticalReady = subscriptions.every(
    (subscription) =>
      subscription.bootstrapPhase > criticalPhase || subscription.ready
  );
  const interactiveReady = subscriptions.every(
    (subscription) =>
      subscription.bootstrapPhase > interactivePhase || subscription.ready
  );
  const activePhase =
    subscriptions
      .filter((subscription) => !subscription.ready)
      .reduce<number | null>(
        (lowest, subscription) =>
          lowest === null || subscription.bootstrapPhase < lowest
            ? subscription.bootstrapPhase
            : lowest,
        null
      ) ?? null;
  const hasError = subscriptions.some(
    (subscription) => subscription.phase === 'error'
  );
  const isBootstrapping = subscriptions.some(
    (subscription) => !subscription.ready && subscription.phase !== 'error'
  );
  const channelPhase = hasError
    ? 'error'
    : isBootstrapping
      ? 'bootstrapping'
      : complete && expectedSubscriptionIds.length > 0
        ? 'live'
        : 'idle';
  const progressPercent =
    subscriptions.length === 0
      ? 100
      : Math.round(
          subscriptions.reduce(
            (sum, subscription) => sum + subscription.progressPercent,
            0
          ) / subscriptions.length
        );
  const phaseMap = new Map<
    number,
    {
      expectedSubscriptionIds: string[];
      readySubscriptionIds: string[];
      pendingSubscriptionIds: string[];
      progressPercent: number;
    }
  >();
  for (const subscription of subscriptions) {
    const phase = phaseMap.get(subscription.bootstrapPhase) ?? {
      expectedSubscriptionIds: [],
      readySubscriptionIds: [],
      pendingSubscriptionIds: [],
      progressPercent: 0,
    };
    phase.expectedSubscriptionIds.push(subscription.id);
    phase.progressPercent += subscription.progressPercent;
    if (subscription.ready) {
      phase.readySubscriptionIds.push(subscription.id);
    } else {
      phase.pendingSubscriptionIds.push(subscription.id);
    }
    phaseMap.set(subscription.bootstrapPhase, phase);
  }
  const phases = [...phaseMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([phase, summary]) => ({
      phase,
      expectedSubscriptionIds: summary.expectedSubscriptionIds,
      readySubscriptionIds: summary.readySubscriptionIds,
      pendingSubscriptionIds: summary.pendingSubscriptionIds,
      isReady: summary.pendingSubscriptionIds.length === 0,
      progressPercent:
        summary.expectedSubscriptionIds.length === 0
          ? 100
          : Math.round(
              summary.progressPercent / summary.expectedSubscriptionIds.length
            ),
    }));

  return {
    channelPhase,
    progressPercent,
    isBootstrapping,
    criticalReady,
    interactiveReady,
    complete,
    activePhase,
    expectedSubscriptionIds,
    readySubscriptionIds,
    pendingSubscriptionIds,
    subscriptions,
    phases,
  };
}

function normalizeBootstrapPhase(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : 0;
}

function parseConflictSummaries(value: string): SyncularConflictSummary[] {
  return parseJson<RawConflictSummary[]>(value).map((conflict) => ({
    id: conflict.id,
    clientCommitId: conflict.client_commit_id,
    opIndex: conflict.op_index,
    resultStatus: conflict.result_status,
    message: conflict.message,
    code: conflict.code,
    serverVersion: conflict.server_version,
    resolvedAt: conflict.resolved_at,
    resolution: conflict.resolution,
  }));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyParams(params: readonly unknown[]): string {
  return JSON.stringify(params, (_key, value) => {
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Uint8Array) return Array.from(value);
    return value;
  });
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

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
