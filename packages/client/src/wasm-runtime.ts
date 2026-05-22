import {
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  type SyncularRustOwnedSqliteClient,
} from '@syncular/client-javascript-bindings';
import type { SyncularClientConfig, SyncularRustRuntimeInfo } from './types';

export type {
  SyncularRustOwnedSqliteClient,
  SyncularWasmArtifactVariant,
} from '@syncular/client-javascript-bindings';
export {
  getSyncularPackagedRuntimeArtifacts,
  getSyncularRuntimeArtifact,
  getSyncularRuntimeArtifactCatalogUrl,
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  resolveSyncularRuntimeArtifactCatalog,
  selectSyncularRuntimeArtifact,
} from '@syncular/client-javascript-bindings';

export interface SyncularWasmGlue {
  default(moduleOrPath?: string | URL | Request): Promise<unknown>;
  syncularRuntimeInfoJson(): string;
  syncularBuildYjsTextUpdateJson(argsJson: string): string;
  syncularApplyYjsTextUpdatesJson(argsJson: string): string;
  syncularApplyYjsEnvelopeToPayloadJson(argsJson: string): string;
  syncularMaterializeYjsRowJson(argsJson: string): string;
  syncularEncryptionHelperJson(method: string, argsJson: string): string;
  openSyncularRustOwnedSqliteClient(
    config: SyncularClientConfig
  ): Promise<SyncularRustOwnedSqliteClient>;
}

let modulePromise: Promise<SyncularWasmGlue> | undefined;

export function loadSyncularWasmGlue(): Promise<SyncularWasmGlue> {
  modulePromise ??= import(
    /* @vite-ignore */ getSyncularWasmGlueUrl().href
  ) as Promise<SyncularWasmGlue>;
  return modulePromise;
}

export async function getSyncularRustRuntimeInfo(
  mod?: SyncularWasmGlue | Promise<SyncularWasmGlue>,
  wasmUrl: string | URL | Request = getSyncularWasmUrl()
): Promise<SyncularRustRuntimeInfo> {
  const resolved = await (mod ?? loadSyncularWasmGlue());
  await resolved.default(wasmUrl);
  return readSyncularRustRuntimeInfo(resolved);
}

export function readSyncularRustRuntimeInfo(
  mod: SyncularWasmGlue
): SyncularRustRuntimeInfo {
  return JSON.parse(mod.syncularRuntimeInfoJson()) as SyncularRustRuntimeInfo;
}
