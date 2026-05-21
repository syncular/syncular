import {
  getSyncularV2WasmGlueUrl,
  getSyncularV2WasmUrl,
  type SyncularRustOwnedSqliteClient,
} from '@syncular/client-javascript-bindings';
import type {
  RawSyncularRustOwnedSqlite,
  SyncularRustOwnedSqliteConfig,
} from './rust-store';
import type {
  SyncularV2ClientConfig,
  SyncularV2RustRuntimeInfo,
} from './types';

export type {
  SyncularRustOwnedSqliteClient,
  SyncularV2WasmArtifactVariant,
} from '@syncular/client-javascript-bindings';
export {
  getSyncularV2PackagedRuntimeArtifacts,
  getSyncularV2RuntimeArtifact,
  getSyncularV2RuntimeArtifactCatalogUrl,
  getSyncularV2WasmGlueUrl,
  getSyncularV2WasmUrl,
  resolveSyncularV2RuntimeArtifactCatalog,
  selectSyncularV2RuntimeArtifact,
} from '@syncular/client-javascript-bindings';

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
  ): Promise<SyncularRustOwnedSqliteClient>;
}

let modulePromise: Promise<SyncularV2WasmGlue> | undefined;

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
