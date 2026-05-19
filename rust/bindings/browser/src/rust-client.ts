import type { BlobRef, SyncOperation } from '@syncular/core';
import { resolveSyncularV2ClientConfig } from './client-config';
import { createSyncularV2RuntimeInfo } from './runtime-contract';
import { assertSyncularV2ReadonlySql } from './sql-safety';
import type {
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularApplyYjsTextUpdatesResult,
  SyncularBuildYjsTextUpdateArgs,
  SyncularBuildYjsTextUpdateResult,
  SyncularV2AuthHeaders,
  SyncularV2BlobCacheStats,
  SyncularV2BlobStoreOptions,
  SyncularV2BlobUploadQueueStats,
  SyncularV2BootstrapState,
  SyncularV2BootstrapStatus,
  SyncularV2BootstrapSubscriptionPhase,
  SyncularV2ChangedRow,
  SyncularV2ClientConfig,
  SyncularV2ConflictSummary,
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
  SyncularV2EncryptedCrdtConfig,
  SyncularV2EncryptionHelperMethod,
  SyncularV2FieldEncryptionConfig,
  SyncularV2LiveQueryEvent,
  SyncularV2LiveQuerySnapshot,
  SyncularV2PullOptions,
  SyncularV2RowsChangedEvent,
  SyncularV2RowsChangedSink,
  SyncularV2RuntimeArtifact,
  SyncularV2RuntimeInfo,
  SyncularV2SchemaState,
  SyncularV2SqlResult,
  SyncularV2StorageCompactionOptions,
  SyncularV2StorageCompactionReport,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncResult,
  SyncularV2TransportStats,
} from './types';
import {
  getSyncularV2WasmGlueUrl,
  getSyncularV2WasmUrl,
  loadSyncularV2WasmGlue,
  type RawSyncularV2RustClient,
  readSyncularV2RustRuntimeInfo,
  type SyncularV2WasmGlue,
} from './wasm-runtime';

export interface CreateSyncularV2RustClientOptions {
  module?: SyncularV2WasmGlue | Promise<SyncularV2WasmGlue>;
  wasmGlueUrl?: string | URL;
  wasmUrl?: string | URL | Request;
  runtime?: SyncularV2RuntimeArtifact;
  config: SyncularV2ClientConfig;
}

type RawSyncResult = {
  changed_tables?: string[];
  changed_rows?: SyncularV2ChangedRow[];
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
    phase?: SyncularV2BootstrapSubscriptionPhase;
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
    phase?: SyncularV2BootstrapSubscriptionPhase;
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

type SyncularV2BootstrapSubscriptionStatusEntry = {
  id: string;
  table: string;
  status: string | null;
  ready: boolean;
  phase: SyncularV2BootstrapSubscriptionPhase;
  progressPercent: number;
  cursor: number | null;
  bootstrapState: SyncularV2BootstrapState | null;
  bootstrapPhase: number;
};

export async function openSyncularV2RustClient(
  options: CreateSyncularV2RustClientOptions
): Promise<SyncularV2RustClient> {
  const wasmGlueUrl =
    options.runtime?.wasmGlueUrl ??
    options.wasmGlueUrl ??
    getSyncularV2WasmGlueUrl();
  const mod = await (options.module ??
    (options.runtime?.wasmGlueUrl || options.wasmGlueUrl
      ? loadSyncularV2WasmGlueFromUrl(wasmGlueUrl)
      : loadSyncularV2WasmGlue()));
  const wasmUrl =
    options.runtime?.wasmUrl ?? options.wasmUrl ?? getSyncularV2WasmUrl();
  const config = resolveSyncularV2ClientConfig(options.config);
  await mod.default(wasmUrl);
  const rustRuntimeInfo = readSyncularV2RustRuntimeInfo(mod);
  return new SyncularV2RustClient(
    await mod.openSyncularRustOwnedSqliteClient(config),
    createSyncularV2RuntimeInfo({
      storage: config.storage,
      wasmGlueUrl,
      wasmUrl,
      rust: rustRuntimeInfo,
    }),
    config.pull
  );
}

function loadSyncularV2WasmGlueFromUrl(
  wasmGlueUrl: string | URL
): Promise<SyncularV2WasmGlue> {
  const href = wasmGlueUrl instanceof URL ? wasmGlueUrl.href : wasmGlueUrl;
  return import(/* @vite-ignore */ href) as Promise<SyncularV2WasmGlue>;
}

export class SyncularV2RustClient {
  #rowsChangedListeners = new Set<SyncularV2RowsChangedSink>();
  #subscriptions: SyncularV2SubscriptionSpec[] = [];
  #bootstrapById = new Map<
    string,
    SyncularV2BootstrapSubscriptionStatusEntry
  >();

  constructor(
    private readonly raw: RawSyncularV2RustClient,
    private readonly runtime: SyncularV2RuntimeInfo,
    private readonly pullOptions: SyncularV2PullOptions | undefined
  ) {}

  setSubscriptions(subscriptions: readonly SyncularV2SubscriptionSpec[]): void {
    this.#subscriptions = [...subscriptions];
    this.#bootstrapById.clear();
    this.raw.setSubscriptionsJson(JSON.stringify(subscriptions));
  }

  setAuthHeaders(headers: SyncularV2AuthHeaders): void {
    this.raw.setAuthHeadersJson(JSON.stringify(headers));
  }

  setFieldEncryption(config: SyncularV2FieldEncryptionConfig | null): void {
    this.raw.setFieldEncryptionJson(
      config == null
        ? 'null'
        : JSON.stringify(normalizeFieldEncryptionConfig(config))
    );
  }

  setEncryptedCrdt(config: SyncularV2EncryptedCrdtConfig | null): void {
    this.raw.setEncryptedCrdtJson(
      config == null
        ? 'null'
        : JSON.stringify(normalizeEncryptedCrdtConfig(config))
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

  async syncPull(): Promise<SyncularV2SyncResult> {
    const result = this.#decorateSyncResult(
      parseSyncResult(await this.raw.syncPullJson())
    );
    this.#emitRowsChanged('remotePull', result);
    return result;
  }

  async applyRealtimeSyncPack(
    bytes: Uint8Array
  ): Promise<SyncularV2SyncResult> {
    const result = this.#decorateSyncResult(
      parseSyncResult(await this.raw.applyRealtimeSyncPackBytes(bytes))
    );
    this.#emitRowsChanged('remotePull', result);
    return result;
  }

  async syncPush(): Promise<SyncularV2SyncResult> {
    try {
      const result = this.#decorateSyncResult(
        parseSyncResult(await this.raw.syncPushJson())
      );
      this.#emitRowsChanged('localWrite', result);
      return result;
    } catch (error) {
      this.raw.recoverSyncPushErrorJson(String(error));
      throw error;
    }
  }

  async syncOnce(): Promise<SyncularV2SyncResult> {
    try {
      const result = this.#decorateSyncResult(
        parseSyncResult(await this.raw.syncOnceJson())
      );
      this.#emitRowsChanged('remotePull', result);
      return result;
    } catch (error) {
      this.raw.recoverSyncPushErrorJson(String(error));
      throw error;
    }
  }

  transportStats(): SyncularV2TransportStats {
    return parseJson(this.raw.transportStatsJson());
  }

  resetTransportStats(): void {
    this.raw.resetTransportStats();
  }

  async conflictSummaries(): Promise<SyncularV2ConflictSummary[]> {
    return parseConflictSummaries(await this.raw.conflictSummariesJson());
  }

  retryConflictKeepLocal(id: string): Promise<string> {
    return this.raw.retryConflictKeepLocal(id);
  }

  resolveConflict(id: string, resolution: string): Promise<void> {
    return this.raw.resolveConflict(id, resolution);
  }

  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): SyncularV2SqlResult<Row> {
    assertSyncularV2ReadonlySql(sql);
    if (typeof this.raw.executeSqlValue === 'function') {
      return this.raw.executeSqlValue(sql, params) as SyncularV2SqlResult<Row>;
    }
    return parseJson(this.raw.executeSqlJson(sql, stringifyParams(params)));
  }

  executeUnsafeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params: readonly unknown[] = []): SyncularV2SqlResult<Row> {
    if (typeof this.raw.executeUnsafeSqlValue === 'function') {
      return this.raw.executeUnsafeSqlValue(
        sql,
        params
      ) as SyncularV2SqlResult<Row>;
    }
    return parseJson(
      this.raw.executeUnsafeSqlJson(sql, stringifyParams(params))
    );
  }

  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[]
  ): SyncularV2LiveQuerySnapshot<Row> {
    return parseJson(
      this.raw.subscribeQueryJson(
        sql,
        stringifyParams(params),
        JSON.stringify(tables)
      )
    );
  }

  unsubscribeQuery(id: string): void {
    this.raw.unsubscribeQuery(id);
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularV2LiveQueryEvent<Row>> {
    return parseJson(this.raw.drainLiveQueryEventsJson());
  }

  addRowsChangedListener(listener: SyncularV2RowsChangedSink): () => void {
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
    options: SyncularV2BlobStoreOptions = {}
  ): Promise<BlobRef> {
    return parseJson(
      await this.raw.storeBlobJson(data, JSON.stringify(options))
    );
  }

  retrieveBlob(ref: BlobRef): Promise<Uint8Array> {
    return this.raw.retrieveBlob(JSON.stringify(ref));
  }

  isBlobLocal(hash: string): boolean {
    return this.raw.isBlobLocal(hash);
  }

  async processBlobUploadQueue(): Promise<{
    uploaded: number;
    failed: number;
  }> {
    return parseJson(await this.raw.processBlobUploadQueueJson());
  }

  blobUploadQueueStats(): SyncularV2BlobUploadQueueStats {
    return parseJson(this.raw.blobUploadQueueStatsJson());
  }

  blobCacheStats(): SyncularV2BlobCacheStats {
    return parseJson(this.raw.blobCacheStatsJson());
  }

  pruneBlobCache(maxBytes = 0): number {
    return Number(this.raw.pruneBlobCache(BigInt(maxBytes)));
  }

  clearBlobCache(): void {
    this.raw.clearBlobCache();
  }

  compactStorage(
    options: SyncularV2StorageCompactionOptions = {}
  ): SyncularV2StorageCompactionReport {
    return parseJson(this.raw.compactStorageJson(JSON.stringify(options)));
  }

  generatedSchemaState(): SyncularV2SchemaState {
    return parseJson(this.raw.generatedSchemaStateJson());
  }

  buildYjsTextUpdate(
    args: SyncularBuildYjsTextUpdateArgs
  ): SyncularBuildYjsTextUpdateResult {
    return parseJson(this.raw.buildYjsTextUpdateJson(JSON.stringify(args)));
  }

  applyYjsTextUpdates(
    args: SyncularApplyYjsTextUpdatesArgs
  ): SyncularApplyYjsTextUpdatesResult {
    return parseJson(this.raw.applyYjsTextUpdatesJson(JSON.stringify(args)));
  }

  applyYjsEnvelopeToPayload(
    args: SyncularApplyYjsEnvelopeToPayloadArgs
  ): Record<string, unknown> {
    const result = parseJson<{ payload: Record<string, unknown> }>(
      this.raw.applyYjsEnvelopeToPayloadJson(JSON.stringify(args))
    );
    return result.payload;
  }

  async openCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldDescriptor> {
    return parseJson(this.raw.openCrdtFieldJson(JSON.stringify(request)));
  }

  async applyCrdtFieldText(
    request: SyncularV2CrdtFieldTextRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt> {
    const receipt = parseJson<SyncularV2CrdtFieldWriteReceipt>(
      this.raw.applyCrdtFieldTextJson(JSON.stringify(request))
    );
    this.#drainAndEmitRowsChanged();
    return receipt;
  }

  async applyCrdtFieldYjsUpdate(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt> {
    const receipt = parseJson<SyncularV2CrdtFieldWriteReceipt>(
      this.raw.applyCrdtFieldYjsUpdateJson(JSON.stringify(request))
    );
    this.#drainAndEmitRowsChanged();
    return receipt;
  }

  async materializeCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldMaterialization> {
    return parseJson(
      this.raw.materializeCrdtFieldJson(JSON.stringify(request))
    );
  }

  async crdtDocumentSnapshot(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtDocumentSnapshot> {
    return parseJson(
      this.raw.crdtDocumentSnapshotJson(JSON.stringify(request))
    );
  }

  async crdtUpdateLog(
    request: SyncularV2CrdtFieldRequest & { limit?: number }
  ): Promise<SyncularV2CrdtUpdateLogEntry[]> {
    return parseJson(this.raw.crdtUpdateLogJson(JSON.stringify(request)));
  }

  async snapshotCrdtFieldStateVector(
    request: SyncularV2CrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }> {
    return parseJson(
      this.raw.snapshotCrdtFieldStateVectorJson(JSON.stringify(request))
    );
  }

  async compactCrdtField(
    request: SyncularV2CrdtFieldCompactionRequest
  ): Promise<SyncularV2CrdtFieldCompactionReceipt> {
    const receipt = parseJson<SyncularV2CrdtFieldCompactionReceipt>(
      this.raw.compactCrdtFieldJson(JSON.stringify(request))
    );
    this.#drainAndEmitRowsChanged();
    return receipt;
  }

  encryptionHelper<T = unknown>(
    method: SyncularV2EncryptionHelperMethod,
    args: unknown = {}
  ): T {
    return parseJson(
      this.raw.encryptionHelperJson(method, JSON.stringify(args))
    );
  }

  async runtimeInfo(): Promise<SyncularV2RuntimeInfo> {
    return this.runtime;
  }

  #decorateSyncResult(result: SyncularV2SyncResult): SyncularV2SyncResult {
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
    result: SyncularV2SyncResult
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

  #drainAndEmitRowsChanged(): void {
    let events: SyncularV2RowsChangedEvent[];
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
    this.raw.close();
  }
}

function parseSyncResult(value: string): SyncularV2SyncResult {
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
): SyncularV2BootstrapStatus['subscriptions'][number]['bootstrapState'] {
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
): SyncularV2BootstrapStatus {
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
  configuredSubscriptions: readonly SyncularV2SubscriptionSpec[],
  cachedById: ReadonlyMap<string, SyncularV2BootstrapSubscriptionStatusEntry>,
  pullOptions: SyncularV2PullOptions | undefined
): SyncularV2BootstrapStatus {
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
  const expectedSubscriptionIds = subscriptions.map((subscription) => subscription.id);
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

function parseConflictSummaries(value: string): SyncularV2ConflictSummary[] {
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

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
