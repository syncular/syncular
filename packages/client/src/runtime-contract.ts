import type {
  SyncularRuntimeInfo,
  SyncularRustRuntimeInfo,
  SyncularStorage,
} from './types';
import {
  SYNCULAR_CLIENT_PACKAGE_NAME,
  SYNCULAR_CLIENT_PACKAGE_VERSION,
} from './wasm-bindings/runtime-contract';
import { SYNCULAR_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export {
  SYNCULAR_CORE_RUNTIME_FEATURES,
  SYNCULAR_FULL_RUNTIME_FEATURES,
  SYNCULAR_WASM_ARTIFACT_CATALOG_FILE,
  SYNCULAR_WASM_ARTIFACT_FILE,
  SYNCULAR_WASM_BINARY_FILE,
  SYNCULAR_WASM_GLUE_FILE,
  SYNCULAR_WASM_OUT_NAME,
} from './wasm-bindings/runtime-contract';
export { SYNCULAR_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export const SYNCULAR_PACKAGE_NAME = SYNCULAR_CLIENT_PACKAGE_NAME;
export const SYNCULAR_PACKAGE_VERSION = SYNCULAR_CLIENT_PACKAGE_VERSION;

export function createSyncularRuntimeInfo(options: {
  storage?: SyncularStorage;
  workerUrl?: string | URL;
  wasmGlueUrl: string | URL;
  wasmUrl: string | URL | Request;
  rust?: SyncularRustRuntimeInfo | null;
}): SyncularRuntimeInfo {
  return {
    packageName: SYNCULAR_PACKAGE_NAME,
    packageVersion: SYNCULAR_PACKAGE_VERSION,
    workerProtocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
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
