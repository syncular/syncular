export const SYNCULAR_V2_CLIENT_PACKAGE_NAME = '@syncular/client';
export const SYNCULAR_V2_CLIENT_PACKAGE_VERSION = '0.0.0';
export const SYNCULAR_V2_WASM_OUT_NAME = 'syncular_v2';
export const SYNCULAR_V2_WASM_GLUE_FILE = `${SYNCULAR_V2_WASM_OUT_NAME}.js`;
export const SYNCULAR_V2_WASM_BINARY_FILE = `${SYNCULAR_V2_WASM_OUT_NAME}_bg.wasm`;
export const SYNCULAR_V2_WASM_ARTIFACT_FILE =
  'syncular-v2-runtime-artifact.json';
export const SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE =
  'syncular-v2-runtime-artifacts.json';
export const SYNCULAR_V2_FULL_RUNTIME_FEATURES = [
  'web-owned-sqlite-core',
  'web-owned-sqlite',
  'blobs',
  'crdt-yjs',
  'e2ee',
] as const;
export const SYNCULAR_V2_CORE_RUNTIME_FEATURES = [
  'web-owned-sqlite-core',
] as const;

export interface SyncularV2JavaScriptBindingRuntimeArtifact {
  wasmGlueUrl?: string | URL;
  wasmUrl?: string | URL | Request;
}

export interface SyncularV2JavaScriptBindingRuntimeArtifactCandidate
  extends SyncularV2JavaScriptBindingRuntimeArtifact {
  name?: string;
  features: readonly string[];
}

export interface SyncularV2JavaScriptBindingRuntimeArtifactCatalog {
  catalogVersion: 1;
  packageName: string;
  packageVersion: string;
  generatedAt?: string;
  artifacts: readonly SyncularV2JavaScriptBindingRuntimeArtifactCatalogEntry[];
}

export interface SyncularV2JavaScriptBindingRuntimeArtifactCatalogEntry {
  name: string;
  variant?: string;
  profile?: string;
  features: readonly string[];
  rustFeatures?: readonly string[];
  wasmGlueUrl: string;
  wasmUrl: string;
  rawBytes?: number;
  gzipBytes?: number;
}

export type SyncularV2WasmArtifactVariant = 'full' | 'full-perf' | 'core';

export function getSyncularV2WasmGlueUrl(): URL {
  return resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_GLUE_FILE);
}

export function getSyncularV2WasmUrl(): URL {
  return resolveSyncularV2WasmAsset(SYNCULAR_V2_WASM_BINARY_FILE);
}

export function getSyncularV2RuntimeArtifactCatalogUrl(): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith(
    '/src/runtime-contract.ts'
  );
  return new URL(
    sourceRuntime
      ? `../dist/${SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE}`
      : `./${SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE}`,
    runtimeUrl
  );
}

export function getSyncularV2RuntimeArtifact(
  variant: SyncularV2WasmArtifactVariant = 'full'
): SyncularV2JavaScriptBindingRuntimeArtifactCandidate {
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

export function getSyncularV2PackagedRuntimeArtifacts(): readonly SyncularV2JavaScriptBindingRuntimeArtifactCandidate[] {
  return [
    getSyncularV2RuntimeArtifact('core'),
    getSyncularV2RuntimeArtifact('full'),
    getSyncularV2RuntimeArtifact('full-perf'),
  ];
}

export function resolveSyncularV2RuntimeArtifactCatalog(
  catalog: SyncularV2JavaScriptBindingRuntimeArtifactCatalog,
  options: { baseUrl?: string | URL } = {}
): readonly SyncularV2JavaScriptBindingRuntimeArtifactCandidate[] {
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
  artifacts: readonly SyncularV2JavaScriptBindingRuntimeArtifactCandidate[] = [
    getSyncularV2RuntimeArtifact('full'),
  ]
): SyncularV2JavaScriptBindingRuntimeArtifact {
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

function resolveSyncularV2WasmAsset(fileName: string, dir = 'wasm'): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith(
    '/src/runtime-contract.ts'
  );
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
