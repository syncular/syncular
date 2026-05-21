import type {
  SyncularV2RuntimeInfo,
  SyncularV2RustRuntimeInfo,
  SyncularV2Storage,
} from './types';
import { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export const SYNCULAR_V2_PACKAGE_NAME = '@syncular/client';
export const SYNCULAR_V2_PACKAGE_VERSION = '0.0.0';
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

export function createSyncularV2RuntimeInfo(options: {
  storage?: SyncularV2Storage;
  workerUrl?: string | URL;
  wasmGlueUrl: string | URL;
  wasmUrl: string | URL | Request;
  rust?: SyncularV2RustRuntimeInfo | null;
}): SyncularV2RuntimeInfo {
  return {
    packageName: SYNCULAR_V2_PACKAGE_NAME,
    packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
    workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
    storage: options.storage,
    workerUrl: options.workerUrl == null ? undefined : href(options.workerUrl),
    wasmGlueUrl: href(options.wasmGlueUrl),
    wasmUrl: href(options.wasmUrl),
    rust: options.rust ?? undefined,
  };
}

function href(value: string | URL | Request): string {
  if (value instanceof Request) return value.url;
  return value instanceof URL ? value.href : value;
}
