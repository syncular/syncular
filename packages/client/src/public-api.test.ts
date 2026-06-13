import { describe, expect, it } from 'bun:test';
import * as clientApi from './index';
import {
  createSyncularCommandHistory,
  createSyncularDatabase,
  getSyncularPackagedRuntimeArtifacts,
  resolveSyncularClientConfig,
  SYNCULAR_DEFAULT_STORAGE,
  SYNCULAR_PACKAGE_NAME,
  SYNCULAR_PACKAGE_VERSION,
  SYNCULAR_WASM_ARTIFACT_CATALOG_FILE,
  SYNCULAR_WASM_ARTIFACT_FILE,
  SYNCULAR_WASM_BINARY_FILE,
  SYNCULAR_WASM_GLUE_FILE,
  SyncularCommandHistoryError,
} from './index';

describe('@syncular/client public API', () => {
  it('exports the stable runtime contract', () => {
    expect(SYNCULAR_PACKAGE_NAME).toBe('@syncular/client');
    expect(SYNCULAR_PACKAGE_VERSION).toBe('0.0.0');
    expect(SYNCULAR_WASM_GLUE_FILE).toBe('syncular.js');
    expect(SYNCULAR_WASM_BINARY_FILE).toBe('syncular_bg.wasm');
    expect(SYNCULAR_WASM_ARTIFACT_FILE).toBe('syncular-runtime-artifact.json');
    expect(SYNCULAR_WASM_ARTIFACT_CATALOG_FILE).toBe(
      'syncular-runtime-artifacts.json'
    );
  });

  it('orders packaged runtime artifacts from smallest compatible to full profiles', () => {
    const artifacts = getSyncularPackagedRuntimeArtifacts();
    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      'core',
      'full',
      'full-perf',
    ]);
    expect(artifacts[0]?.features).toEqual(['web-owned-sqlite-core']);
    expect(artifacts[1]?.features).toContain('crdt-yjs');
    expect(artifacts[2]?.wasmUrl?.toString()).toContain('wasm-perf');
  });

  it('exports the managed database constructor', () => {
    expect(typeof createSyncularDatabase).toBe('function');
  });

  it('does not expose the removed standalone managed-client constructor', () => {
    expect('createSyncularClient' in clientApi).toBe(false);
  });

  it('exports generated command-history helpers', () => {
    expect(typeof createSyncularCommandHistory).toBe('function');
    expect(typeof SyncularCommandHistoryError).toBe('function');
  });

  it('does not expose low-level Rust helper modules from the package root', () => {
    expect('openSyncularRustClient' in clientApi).toBe(false);
    expect('createSyncularRustOwnedSqlite' in clientApi).toBe(false);
    expect('loadSyncularWasmGlue' in clientApi).toBe(false);
  });

  it('defaults generated app storage to OPFS SAH', () => {
    expect(
      resolveSyncularClientConfig({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      }).storage
    ).toBe(SYNCULAR_DEFAULT_STORAGE);
  });
});
