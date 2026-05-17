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
  SyncularV2EncryptedCrdtConfig,
  SyncularV2EncryptionHelperMethod,
  SyncularV2FieldEncryptionConfig,
  SyncularV2LiveQueryEvent,
  SyncularV2LiveQuerySnapshot,
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
    snapshot_rows?: unknown[];
    commits?: unknown[];
  }>;
  pushed_commits?: number;
  timings?: {
    total_ms?: number;
    push_ms?: number;
    pull_ms?: number;
    pull_request_ms?: number;
    pull_transform_ms?: number;
    snapshot_fetch_ms?: number;
    pull_apply_ms?: number;
    notify_ms?: number;
  };
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
    })
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

  constructor(
    private readonly raw: RawSyncularV2RustClient,
    private readonly runtime: SyncularV2RuntimeInfo
  ) {}

  setSubscriptions(subscriptions: readonly SyncularV2SubscriptionSpec[]): void {
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

  async applyLocalOperation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string> {
    const commitId = await this.raw.applyLocalOperationJson(
      JSON.stringify(operation),
      localRow == null ? null : JSON.stringify(localRow)
    );
    this.#drainAndEmitRowsChanged();
    return commitId;
  }

  async applyLocalOperationsBatch(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string[]> {
    const commitIds = parseJson<string[]>(
      await this.raw.applyLocalOperationsBatchJson(JSON.stringify(operations))
    );
    this.#drainAndEmitRowsChanged();
    return commitIds;
  }

  async applyLocalOperationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string> {
    const commitId = parseJson<string>(
      await this.raw.applyLocalOperationsCommitJson(JSON.stringify(operations))
    );
    this.#drainAndEmitRowsChanged();
    return commitId;
  }

  async syncPull(): Promise<SyncularV2SyncResult> {
    const result = parseSyncResult(await this.raw.syncPullJson());
    this.#emitRowsChanged('remotePull', result);
    return result;
  }

  async syncPush(): Promise<SyncularV2SyncResult> {
    try {
      const result = parseSyncResult(await this.raw.syncPushJson());
      this.#emitRowsChanged('localWrite', result);
      return result;
    } catch (error) {
      this.raw.recoverSyncPushErrorJson(String(error));
      throw error;
    }
  }

  async syncOnce(): Promise<SyncularV2SyncResult> {
    try {
      const result = parseSyncResult(await this.raw.syncOnceJson());
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
    return parseJson(this.raw.compactCrdtFieldJson(JSON.stringify(request)));
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
      snapshotRows: subscription.snapshot_rows ?? [],
      commits: subscription.commits ?? [],
    })),
    pushedCommits: raw.pushed_commits ?? 0,
    timings: {
      totalMs: raw.timings?.total_ms ?? 0,
      pushMs: raw.timings?.push_ms ?? 0,
      pullMs: raw.timings?.pull_ms ?? 0,
      pullRequestMs: raw.timings?.pull_request_ms ?? 0,
      pullTransformMs: raw.timings?.pull_transform_ms ?? 0,
      snapshotFetchMs: raw.timings?.snapshot_fetch_ms ?? 0,
      pullApplyMs: raw.timings?.pull_apply_ms ?? 0,
      notifyMs: raw.timings?.notify_ms ?? 0,
    },
  };
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
