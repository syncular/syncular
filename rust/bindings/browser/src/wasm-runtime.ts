import {
  SYNCULAR_V2_CORE_RUNTIME_FEATURES,
  SYNCULAR_V2_FULL_RUNTIME_FEATURES,
  SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE,
  SYNCULAR_V2_WASM_BINARY_FILE,
  SYNCULAR_V2_WASM_GLUE_FILE,
} from './runtime-contract';
import type {
  RawSyncularRustOwnedSqlite,
  SyncularRustOwnedSqliteConfig,
} from './rust-store';
import type {
  SyncularV2ClientConfig,
  SyncularV2RuntimeArtifact,
  SyncularV2RuntimeArtifactCandidate,
  SyncularV2RuntimeArtifactCatalog,
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
  forceSubscriptionsBootstrapJson(subscriptionIdsJson: string): Promise<string>;
  localHealthCheckJson(): Promise<string>;
  repairLocalHealthJson(requestJson: string): Promise<string>;
  resetLocalSyncStateJson(requestJson: string): Promise<string>;
  setAuthHeadersJson(headersJson: string): void;
  setFieldEncryptionJson(configJson: string): void;
  setEncryptedCrdtJson(configJson: string): void;
  setAbortSignal(signal?: AbortSignal | null): void;
  applyMutationJson(
    operationJson: string,
    localRowJson?: string | null
  ): Promise<string>;
  applyMutationsBatchJson(operationsJson: string): Promise<string>;
  applyMutationsCommitJson(operationsJson: string): Promise<string>;
  syncPullJson(): Promise<string>;
  applyRealtimeSyncPackBytes(bytes: Uint8Array): Promise<string>;
  syncPushJson(): Promise<string>;
  recoverSyncPushErrorJson(errorMessage: string): void;
  syncOnceJson(): Promise<string>;
  transportStatsJson(): string;
  resetTransportStats(): void;
  conflictSummariesJson(): Promise<string>;
  retryConflictKeepLocal(id: string): Promise<string>;
  resolveConflict(id: string, resolution: string): Promise<void>;
  listTableJson(table: string): Promise<string>;
  storeBlobJson(data: Uint8Array, optionsJson: string): Promise<string>;
  retrieveBlob(refJson: string): Promise<Uint8Array>;
  isBlobLocal(hash: string): boolean;
  processBlobUploadQueueJson(): Promise<string>;
  blobUploadQueueStatsJson(): string;
  blobCacheStatsJson(): string;
  pruneBlobCache(maxBytes: bigint): bigint;
  clearBlobCache(): void;
  compactStorageJson(optionsJson: string): string;
  executeSqlJson(sql: string, paramsJson: string): string;
  executeUnsafeSqlJson(sql: string, paramsJson: string): string;
  executeSqlValue?(sql: string, params: readonly unknown[]): unknown;
  executeUnsafeSqlValue?(sql: string, params: readonly unknown[]): unknown;
  buildYjsTextUpdateJson(argsJson: string): string;
  applyYjsTextUpdatesJson(argsJson: string): string;
  applyYjsEnvelopeToPayloadJson(argsJson: string): string;
  materializeYjsRowJson(argsJson: string): string;
  yjsStateVectorBase64(stateBase64?: string | null): string;
  openCrdtFieldJson(requestJson: string): string;
  applyCrdtFieldTextJson(requestJson: string): string;
  applyCrdtFieldYjsUpdateJson(requestJson: string): string;
  materializeCrdtFieldJson(requestJson: string): string;
  crdtDocumentSnapshotJson(requestJson: string): string;
  crdtUpdateLogJson(requestJson: string): string;
  snapshotCrdtFieldStateVectorJson(requestJson: string): string;
  compactCrdtFieldJson(requestJson: string): string;
  encryptionHelperJson(method: string, argsJson: string): string;
  generatedSchemaStateJson(): string;
  subscribeQueryJson(
    sql: string,
    paramsJson: string,
    tablesJson: string
  ): string;
  unsubscribeQuery(id: string): void;
  drainLiveQueryEventsJson(): string;
  drainRowsChangedEventsJson(): string;
  close(): void;
}

let modulePromise: Promise<SyncularV2WasmGlue> | undefined;

export type SyncularV2WasmArtifactVariant = 'full' | 'full-perf' | 'core';

export function getSyncularV2WasmGlueUrl(): URL {
  return resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_GLUE_FILE);
}

export function getSyncularV2WasmUrl(): URL {
  return resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_BINARY_FILE);
}

export function getSyncularV2RuntimeArtifactCatalogUrl(): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith('/src/wasm-runtime.ts');
  return new URL(
    sourceRuntime
      ? `../dist/${SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE}`
      : `./${SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE}`,
    runtimeUrl
  );
}

export function getSyncularV2RuntimeArtifact(
  variant: SyncularV2WasmArtifactVariant = 'full'
): SyncularV2RuntimeArtifactCandidate {
  const dir =
    variant === 'core'
      ? 'wasm-core'
      : variant === 'full-perf'
        ? 'wasm-perf'
        : 'wasm';
  const features =
    variant === 'core'
      ? SYNCULAR_V2_CORE_RUNTIME_FEATURES
      : SYNCULAR_V2_FULL_RUNTIME_FEATURES;
  return {
    name: variant,
    features,
    wasmGlueUrl: resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_GLUE_FILE, dir),
    wasmUrl: resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_BINARY_FILE, dir),
  };
}

export function getSyncularV2PackagedRuntimeArtifacts(): readonly SyncularV2RuntimeArtifactCandidate[] {
  return [
    getSyncularV2RuntimeArtifact('core'),
    getSyncularV2RuntimeArtifact('full'),
    getSyncularV2RuntimeArtifact('full-perf'),
  ];
}

export function resolveSyncularV2RuntimeArtifactCatalog(
  catalog: SyncularV2RuntimeArtifactCatalog,
  options: { baseUrl?: string | URL } = {}
): readonly SyncularV2RuntimeArtifactCandidate[] {
  const baseUrl = options.baseUrl ?? getSyncularV2RuntimeArtifactCatalogUrl();
  return catalog.artifacts.map((artifact) => ({
    name: artifact.name,
    features: artifact.features,
    wasmGlueUrl: resolveCatalogAssetUrl(artifact.wasmGlueUrl, baseUrl),
    wasmUrl: resolveCatalogAssetUrl(artifact.wasmUrl, baseUrl),
  }));
}

export function selectSyncularV2RuntimeArtifact(
  requiredFeatures: readonly string[] = [],
  artifacts: readonly SyncularV2RuntimeArtifactCandidate[] = [
    getSyncularV2RuntimeArtifact('full'),
  ]
): SyncularV2RuntimeArtifact {
  const required = new Set(requiredFeatures);
  for (const artifact of artifacts) {
    const available = new Set(artifact.features);
    let compatible = true;
    for (const feature of required) {
      if (!available.has(feature)) {
        compatible = false;
        break;
      }
    }
    if (compatible) {
      return {
        wasmGlueUrl: artifact.wasmGlueUrl,
        wasmUrl: artifact.wasmUrl,
      };
    }
  }

  throw new Error(
    `No Syncular Rust runtime artifact satisfies required features: ${[
      ...required,
    ].join(', ')}`
  );
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

function resolveSyncularV2WasmAsset(fileName: string, dir = 'wasm'): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith('/src/wasm-runtime.ts');
  return new URL(
    sourceRuntime ? `../dist/${dir}/${fileName}` : `./${dir}/${fileName}`,
    runtimeUrl
  );
}

function resolveCatalogAssetUrl(
  value: string,
  baseUrl: string | URL
): string | URL {
  if (isAbsoluteAssetUrl(value)) return value;
  if (baseUrl instanceof URL) {
    return new URL(value, new URL('./', baseUrl));
  }
  if (hasUrlProtocol(baseUrl)) {
    return new URL(value, new URL('./', baseUrl)).href;
  }
  const baseDir = baseUrl.endsWith('/')
    ? baseUrl
    : baseUrl.slice(0, Math.max(0, baseUrl.lastIndexOf('/') + 1));
  return `${baseDir}${value}`;
}

function isAbsoluteAssetUrl(value: string): boolean {
  return value.startsWith('/') || hasUrlProtocol(value);
}

function hasUrlProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
