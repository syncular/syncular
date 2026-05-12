import { describe, expect, it } from 'bun:test';
import {
  assertSyncularAppRuntimeInfo,
  syncularGeneratedSchemaVersion,
} from '../../../examples/todo-app/generated/typescript/syncular.generated';
import {
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
  SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
} from './runtime-contract';
import type { SyncularV2RuntimeInfo } from './types';

describe('generated Syncular v2 runtime assertions', () => {
  it('accepts the matching v2 runtime manifest', () => {
    expect(() => assertSyncularAppRuntimeInfo(runtimeInfo())).not.toThrow();
  });

  it('rejects mismatched worker protocols', () => {
    expect(() =>
      assertSyncularAppRuntimeInfo(
        runtimeInfo({
          workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION + 1,
        })
      )
    ).toThrow('Syncular worker protocol mismatch');
  });

  it('rejects mismatched Rust schema versions', () => {
    expect(() =>
      assertSyncularAppRuntimeInfo(
        runtimeInfo({
          rust: {
            ...baseRustRuntimeInfo(),
            schemaVersion: syncularGeneratedSchemaVersion + 1,
          },
        })
      )
    ).toThrow('Syncular Rust schema version mismatch');
  });

  it('rejects a runtime without rust-owned SQLite support', () => {
    expect(() =>
      assertSyncularAppRuntimeInfo(
        runtimeInfo({
          rust: {
            ...baseRustRuntimeInfo(),
            features: [],
          },
        })
      )
    ).toThrow('web-owned-sqlite');
  });
});

function runtimeInfo(
  overrides: Partial<SyncularV2RuntimeInfo> = {}
): SyncularV2RuntimeInfo {
  return {
    packageName: SYNCULAR_V2_PACKAGE_NAME,
    packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
    workerProtocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
    storage: 'opfsSahPool',
    workerUrl: 'http://localhost/syncular-v2-worker.js',
    wasmGlueUrl: 'http://localhost/wasm/syncular_v2.js',
    wasmUrl: 'http://localhost/wasm/syncular_v2_bg.wasm',
    rust: baseRustRuntimeInfo(),
    ...overrides,
  };
}

function baseRustRuntimeInfo(): NonNullable<SyncularV2RuntimeInfo['rust']> {
  return {
    crateName: 'syncular-runtime',
    crateVersion: '0.1.0',
    schemaVersion: syncularGeneratedSchemaVersion,
    features: ['web-owned-sqlite'],
  };
}
