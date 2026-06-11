import {
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  type SyncularRustOwnedSqliteClient,
} from '@syncular/client-javascript-bindings';
import type {
  ResolvedSyncularClientConfig,
  SyncularRustRuntimeInfo,
} from './types';

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
    config: ResolvedSyncularClientConfig
  ): Promise<SyncularRustOwnedSqliteClient>;
}

let modulePromise: Promise<SyncularWasmGlue> | undefined;

export function loadSyncularWasmGlue(): Promise<SyncularWasmGlue> {
  modulePromise ??= (
    import(
      /* @vite-ignore */ getSyncularWasmGlueUrl().href
    ) as Promise<SyncularWasmGlue>
  ).catch((error: unknown) => {
    modulePromise = undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (/cannot find module|failed to fetch|not found/i.test(message)) {
      throw new Error(
        `Syncular WASM runtime artifact is missing (${message}). ` +
          'In this repo, build it first: `bun run javascript-bindings:build:wasm` ' +
          '(or `build:wasm:dev` for a fast dev build). In an app, ensure the ' +
          '@syncular/client-javascript-bindings dist/wasm assets are served.',
        { cause: error }
      );
    }
    throw error;
  });
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
