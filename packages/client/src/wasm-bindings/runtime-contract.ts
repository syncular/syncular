export type { SyncularRustOwnedSqliteClient } from './generated-wasm-bindings';

import type {
  SyncularRuntimeArtifact,
  SyncularRuntimeArtifactCandidate,
  SyncularRuntimeArtifactCatalog,
} from '../types';

export const SYNCULAR_CLIENT_PACKAGE_NAME = '@syncular/client';
export const SYNCULAR_CLIENT_PACKAGE_VERSION = '0.1.1';
export const SYNCULAR_WASM_OUT_NAME = 'syncular';
export const SYNCULAR_WASM_GLUE_FILE = `${SYNCULAR_WASM_OUT_NAME}.js`;
export const SYNCULAR_WASM_BINARY_FILE = `${SYNCULAR_WASM_OUT_NAME}_bg.wasm`;
export const SYNCULAR_WASM_ARTIFACT_FILE = 'syncular-runtime-artifact.json';
export const SYNCULAR_WASM_ARTIFACT_CATALOG_FILE =
  'syncular-runtime-artifacts.json';
export const SYNCULAR_FULL_RUNTIME_FEATURES = [
  'web-owned-sqlite-core',
  'web-owned-sqlite',
  'blobs',
  'crdt-yjs',
  'e2ee',
] as const;
export const SYNCULAR_CORE_RUNTIME_FEATURES = [
  'web-owned-sqlite-core',
] as const;

export type SyncularWasmArtifactVariant = 'full' | 'full-perf' | 'core';

export function getSyncularWasmGlueUrl(): URL {
  return resolveSyncularWasmAsset(SYNCULAR_WASM_GLUE_FILE);
}

export function getSyncularWasmUrl(): URL {
  return resolveSyncularWasmAsset(SYNCULAR_WASM_BINARY_FILE);
}

export function getSyncularRuntimeArtifactCatalogUrl(): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith(
    '/src/wasm-bindings/runtime-contract.ts'
  );
  return new URL(
    sourceRuntime
      ? `../../dist/${SYNCULAR_WASM_ARTIFACT_CATALOG_FILE}`
      : `../${SYNCULAR_WASM_ARTIFACT_CATALOG_FILE}`,
    runtimeUrl
  );
}

export function getSyncularRuntimeArtifact(
  variant: SyncularWasmArtifactVariant = 'full'
): SyncularRuntimeArtifactCandidate {
  const dir =
    variant === 'core'
      ? 'wasm-core'
      : variant === 'full-perf'
        ? 'wasm-perf'
        : 'wasm';
  const features =
    variant === 'core'
      ? SYNCULAR_CORE_RUNTIME_FEATURES
      : SYNCULAR_FULL_RUNTIME_FEATURES;
  return {
    name: variant,
    features,
    wasmGlueUrl: resolveSyncularWasmAsset(SYNCULAR_WASM_GLUE_FILE, dir),
    wasmUrl: resolveSyncularWasmAsset(SYNCULAR_WASM_BINARY_FILE, dir),
  };
}

export function getSyncularPackagedRuntimeArtifacts(): readonly SyncularRuntimeArtifactCandidate[] {
  return [
    getSyncularRuntimeArtifact('core'),
    getSyncularRuntimeArtifact('full'),
    getSyncularRuntimeArtifact('full-perf'),
  ];
}

export function resolveSyncularRuntimeArtifactCatalog(
  catalog: SyncularRuntimeArtifactCatalog,
  options: { baseUrl?: string | URL } = {}
): readonly SyncularRuntimeArtifactCandidate[] {
  const baseUrl = options.baseUrl ?? getSyncularRuntimeArtifactCatalogUrl();
  return catalog.artifacts.map((artifact) => ({
    name: artifact.name,
    features: artifact.features,
    wasmGlueUrl: resolveCatalogAssetUrl(artifact.wasmGlueUrl, baseUrl),
    wasmUrl: resolveCatalogAssetUrl(artifact.wasmUrl, baseUrl),
  }));
}

export function selectSyncularRuntimeArtifact(
  requiredFeatures: readonly string[] = [],
  artifacts: readonly SyncularRuntimeArtifactCandidate[] = [
    getSyncularRuntimeArtifact('full'),
  ]
): SyncularRuntimeArtifact {
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

function resolveSyncularWasmAsset(fileName: string, dir = 'wasm'): URL {
  const runtimeUrl = new URL(import.meta.url);
  const sourceRuntime = runtimeUrl.pathname.endsWith(
    '/src/wasm-bindings/runtime-contract.ts'
  );
  return new URL(
    sourceRuntime ? `../../dist/${dir}/${fileName}` : `../${dir}/${fileName}`,
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
