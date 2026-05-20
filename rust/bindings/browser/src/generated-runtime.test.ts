import { describe, expect, it } from 'bun:test';
import {
  assertSyncularAppRuntime,
  assertSyncularAppRuntimeInfo,
  syncularGeneratedSchemaVersion,
} from '../../../examples/todo-app/generated/typescript/syncular.generated';
import {
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
  SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
} from './runtime-contract';
import type { SyncularV2RuntimeInfo } from './types';
import { resolveSyncularV2RuntimeArtifactCatalog } from './wasm-runtime';

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

  it('rejects mismatched configured app schema versions', async () => {
    await expect(
      assertSyncularAppRuntime({
        client: {
          async runtimeInfo() {
            return runtimeInfo();
          },
          async generatedSchemaState() {
            return {
              schemaId: 'syncular-app',
              schemaVersion: syncularGeneratedSchemaVersion + 1,
              currentSchemaVersion: syncularGeneratedSchemaVersion + 1,
              updatedAt: Date.now(),
            };
          },
        },
      } as any)
    ).rejects.toThrow('Syncular Rust app schema version mismatch');
  });

  it('rejects mismatched persisted local app schema versions', async () => {
    await expect(
      assertSyncularAppRuntime({
        client: {
          async runtimeInfo() {
            return runtimeInfo();
          },
          async generatedSchemaState() {
            return {
              schemaId: 'syncular-app',
              schemaVersion: syncularGeneratedSchemaVersion - 1,
              currentSchemaVersion: syncularGeneratedSchemaVersion,
              updatedAt: Date.now(),
            };
          },
        },
      } as any)
    ).rejects.toThrow('Syncular Rust local app schema version mismatch');
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
    ).toThrow('web-owned-sqlite-core');
  });

  it('rejects a runtime missing generated schema feature requirements', () => {
    expect(() =>
      assertSyncularAppRuntimeInfo(
        runtimeInfo({
          rust: {
            ...baseRustRuntimeInfo(),
            features: ['web-owned-sqlite-core'],
          },
        })
      )
    ).toThrow('blobs');
  });

  it('resolves generated artifact catalogs relative to their catalog URL', () => {
    const artifacts = resolveSyncularV2RuntimeArtifactCatalog(
      {
        catalogVersion: 1,
        packageName: SYNCULAR_V2_PACKAGE_NAME,
        packageVersion: SYNCULAR_V2_PACKAGE_VERSION,
        artifacts: [
          {
            name: 'core',
            features: ['web-owned-sqlite-core'],
            wasmGlueUrl: 'wasm-core/syncular_v2.js',
            wasmUrl: 'wasm-core/syncular_v2_bg.wasm',
          },
          {
            name: 'full',
            features: [
              'web-owned-sqlite-core',
              'web-owned-sqlite',
              'blobs',
              'crdt-yjs',
              'e2ee',
            ],
            wasmGlueUrl: 'wasm/syncular_v2.js',
            wasmUrl: 'wasm/syncular_v2_bg.wasm',
          },
        ],
      },
      { baseUrl: '/syncular/syncular-v2-runtime-artifacts.json' }
    );

    expect(artifacts).toEqual([
      {
        name: 'core',
        features: ['web-owned-sqlite-core'],
        wasmGlueUrl: '/syncular/wasm-core/syncular_v2.js',
        wasmUrl: '/syncular/wasm-core/syncular_v2_bg.wasm',
      },
      {
        name: 'full',
        features: [
          'web-owned-sqlite-core',
          'web-owned-sqlite',
          'blobs',
          'crdt-yjs',
          'e2ee',
        ],
        wasmGlueUrl: '/syncular/wasm/syncular_v2.js',
        wasmUrl: '/syncular/wasm/syncular_v2_bg.wasm',
      },
    ]);
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
    features: [
      'web-owned-sqlite-core',
      'web-owned-sqlite',
      'blobs',
      'crdt-yjs',
    ],
  };
}
