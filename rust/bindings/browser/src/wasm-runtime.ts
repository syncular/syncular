import {
  SYNCULAR_V2_WASM_BINARY_FILE,
  SYNCULAR_V2_WASM_GLUE_FILE,
} from './runtime-contract';
import type {
  RawSyncularRustOwnedSqlite,
  SyncularRustOwnedSqliteConfig,
} from './rust-store';
import type {
  SyncularV2ClientConfig,
  SyncularV2RustRuntimeInfo,
} from './types';

export interface SyncularV2WasmGlue {
  default(moduleOrPath?: string | URL | Request): Promise<unknown>;
  syncularV2RuntimeInfoJson(): string;
  syncularV2BuildYjsTextUpdateJson(argsJson: string): string;
  syncularV2ApplyYjsTextUpdatesJson(argsJson: string): string;
  syncularV2ApplyYjsEnvelopeToPayloadJson(argsJson: string): string;
  syncularV2MaterializeYjsRowJson(argsJson: string): string;
  syncularV2EncryptionHelperJson(method: string, argsJson: string): string;
  openSyncularRustOwnedSqlite(
    config: SyncularRustOwnedSqliteConfig
  ): Promise<RawSyncularRustOwnedSqlite>;
  openSyncularRustOwnedSqliteClient(
    config: SyncularV2ClientConfig
  ): Promise<RawSyncularV2RustClient>;
}

export interface RawSyncularV2RustClient {
  setSubscriptionsJson(subscriptionsJson: string): void;
  setAuthHeadersJson(headersJson: string): void;
  setFieldEncryptionJson(configJson: string): void;
  setEncryptedCrdtJson(configJson: string): void;
  setAbortSignal(signal?: AbortSignal | null): void;
  applyLocalOperationJson(
    operationJson: string,
    localRowJson?: string | null
  ): Promise<string>;
  applyLocalOperationsBatchJson(operationsJson: string): Promise<string>;
  applyLocalOperationsCommitJson(operationsJson: string): Promise<string>;
  syncPullJson(): Promise<string>;
  syncPushJson(): Promise<string>;
  recoverSyncPushErrorJson(errorMessage: string): void;
  syncOnceJson(): Promise<string>;
  listTableJson(table: string): Promise<string>;
  storeBlobJson(data: Uint8Array, optionsJson: string): Promise<string>;
  retrieveBlob(refJson: string): Promise<Uint8Array>;
  isBlobLocal(hash: string): boolean;
  processBlobUploadQueueJson(): Promise<string>;
  blobUploadQueueStatsJson(): string;
  blobCacheStatsJson(): string;
  pruneBlobCache(maxBytes: number): number;
  clearBlobCache(): void;
  compactStorageJson(optionsJson: string): string;
  executeSqlJson(sql: string, paramsJson: string): string;
  buildYjsTextUpdateJson(argsJson: string): string;
  applyYjsTextUpdatesJson(argsJson: string): string;
  applyYjsEnvelopeToPayloadJson(argsJson: string): string;
  materializeYjsRowJson(argsJson: string): string;
  encryptionHelperJson(method: string, argsJson: string): string;
  generatedSchemaStateJson(): string;
  subscribeQueryJson(
    sql: string,
    paramsJson: string,
    tablesJson: string
  ): string;
  unsubscribeQuery(id: string): void;
  drainLiveQueryEventsJson(): string;
  close(): void;
}

let modulePromise: Promise<SyncularV2WasmGlue> | undefined;

export function getSyncularV2WasmGlueUrl(): URL {
  return resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_GLUE_FILE);
}

export function getSyncularV2WasmUrl(): URL {
  return resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_BINARY_FILE);
}

export function loadSyncularV2WasmGlue(): Promise<SyncularV2WasmGlue> {
  modulePromise ??= import(
    /* @vite-ignore */ getSyncularV2WasmGlueUrl().href
  ) as Promise<SyncularV2WasmGlue>;
  return modulePromise;
}

export async function getSyncularV2RustRuntimeInfo(
  mod?: SyncularV2WasmGlue | Promise<SyncularV2WasmGlue>,
  wasmUrl: string | URL | Request = getSyncularV2WasmUrl()
): Promise<SyncularV2RustRuntimeInfo> {
  const resolved = await (mod ?? loadSyncularV2WasmGlue());
  await resolved.default(wasmUrl);
  return readSyncularV2RustRuntimeInfo(resolved);
}

export function readSyncularV2RustRuntimeInfo(
  mod: SyncularV2WasmGlue
): SyncularV2RustRuntimeInfo {
  return JSON.parse(
    mod.syncularV2RuntimeInfoJson()
  ) as SyncularV2RustRuntimeInfo;
}

function resolveSyncularV2WasmAsset(fileName: string): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith('/src/wasm-runtime.ts');
  return new URL(
    sourceRuntime ? `../dist/wasm/${fileName}` : `./wasm/${fileName}`,
    runtimeUrl
  );
}
