import type {
  ResolvedSyncularClientConfig,
  SyncularRustRuntimeInfo,
} from './types';
import {
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  type SyncularRustOwnedSqliteClient,
} from './wasm-bindings/runtime-contract';

export type {
  SyncularRustOwnedSqliteClient,
  SyncularWasmArtifactVariant,
} from './wasm-bindings/runtime-contract';
export {
  getSyncularPackagedRuntimeArtifacts,
  getSyncularRuntimeArtifact,
  getSyncularRuntimeArtifactCatalogUrl,
  getSyncularWasmGlueUrl,
  getSyncularWasmUrl,
  resolveSyncularRuntimeArtifactCatalog,
  selectSyncularRuntimeArtifact,
} from './wasm-bindings/runtime-contract';

export interface SyncularWasmGlue {
  default(moduleOrPath?: SyncularWasmInitInput): Promise<unknown>;
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

export type SyncularWasmModuleInput =
  | string
  | URL
  | Request
  | Response
  | BufferSource
  | WebAssembly.Module;

export type SyncularWasmInitInput =
  | SyncularWasmModuleInput
  | Promise<SyncularWasmModuleInput>
  | {
      module_or_path:
        | SyncularWasmModuleInput
        | Promise<SyncularWasmModuleInput>;
    };

type SyncularWasmFetchInput = string | URL | Request | Response;

let modulePromise: Promise<SyncularWasmGlue> | undefined;

export function loadSyncularWasmGlue(): Promise<SyncularWasmGlue> {
  modulePromise ??= (
    import(
      /* @vite-ignore */ /* webpackIgnore: true */ getSyncularWasmGlueUrl().href
    ) as Promise<SyncularWasmGlue>
  ).catch((error: unknown) => {
    modulePromise = undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (/cannot find module|failed to fetch|not found/i.test(message)) {
      throw new Error(
        `Syncular WASM runtime artifact is missing (${message}). ` +
          'In this repo, build it first: `bun run client:build:wasm` ' +
          '(or `bun --cwd packages/client build:wasm:dev` for a fast dev ' +
          'build). In an app, ensure the @syncular/client dist/wasm assets ' +
          'are served.',
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
  await resolved.default({
    module_or_path: await prepareSyncularWasmModuleInput(wasmUrl),
  });
  return readSyncularRustRuntimeInfo(resolved);
}

export async function prepareSyncularWasmModuleInput(
  wasmUrl: SyncularWasmModuleInput = getSyncularWasmUrl()
): Promise<SyncularWasmModuleInput> {
  if (!shouldReadWasmUrlAsBytes(wasmUrl)) return wasmUrl;
  const response = isResponseInput(wasmUrl) ? wasmUrl : await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(
      `Syncular WASM runtime artifact could not be loaded from ${describeSyncularWasmInput(
        wasmUrl
      )} (${response.status} ${response.statusText})`
    );
  }
  return response.arrayBuffer();
}

export function readSyncularRustRuntimeInfo(
  mod: SyncularWasmGlue
): SyncularRustRuntimeInfo {
  return JSON.parse(mod.syncularRuntimeInfoJson()) as SyncularRustRuntimeInfo;
}

function shouldReadWasmUrlAsBytes(
  input: SyncularWasmModuleInput
): input is SyncularWasmFetchInput {
  return isFetchableWasmInput(input);
}

function isFetchableWasmInput(
  input: SyncularWasmModuleInput
): input is SyncularWasmFetchInput {
  return (
    typeof input === 'string' ||
    isUrlInput(input) ||
    isRequestInput(input) ||
    isResponseInput(input)
  );
}

function isUrlInput(input: SyncularWasmModuleInput): input is URL {
  return typeof URL === 'function' && input instanceof URL;
}

function isRequestInput(input: SyncularWasmModuleInput): input is Request {
  return typeof Request === 'function' && input instanceof Request;
}

function isResponseInput(input: SyncularWasmModuleInput): input is Response {
  return typeof Response === 'function' && input instanceof Response;
}

function describeSyncularWasmInput(input: SyncularWasmFetchInput): string {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  if (input instanceof Response) return input.url || '<inline response>';
  return input;
}
