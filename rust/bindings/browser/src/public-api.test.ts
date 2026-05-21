import { describe, expect, it } from 'bun:test';
import {
  createSyncularClient,
  createSyncularRustSqliteDatabase,
  createSyncularV2Client,
  createSyncularV2Database,
  getSyncularV2PackagedRuntimeArtifacts,
  resolveSyncularV2ClientConfig,
  SYNCULAR_V2_DEFAULT_STORAGE,
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
  SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE,
  SYNCULAR_V2_WASM_ARTIFACT_FILE,
  SYNCULAR_V2_WASM_BINARY_FILE,
  SYNCULAR_V2_WASM_GLUE_FILE,
} from './index';

describe('@syncular/client public API', () => {
  it('exports the stable v2 runtime contract', () => {
    expect(SYNCULAR_V2_PACKAGE_NAME).toBe('@syncular/client');
    expect(SYNCULAR_V2_PACKAGE_VERSION).toBe('0.0.0');
    expect(SYNCULAR_V2_WASM_GLUE_FILE).toBe('syncular_v2.js');
    expect(SYNCULAR_V2_WASM_BINARY_FILE).toBe('syncular_v2_bg.wasm');
    expect(SYNCULAR_V2_WASM_ARTIFACT_FILE).toBe(
      'syncular-v2-runtime-artifact.json'
    );
    expect(SYNCULAR_V2_WASM_ARTIFACT_CATALOG_FILE).toBe(
      'syncular-v2-runtime-artifacts.json'
    );
  });

  it('orders packaged runtime artifacts from smallest compatible to full profiles', () => {
    const artifacts = getSyncularV2PackagedRuntimeArtifacts();
    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      'core',
      'full',
      'full-perf',
    ]);
    expect(artifacts[0]?.features).toEqual(['web-owned-sqlite-core']);
    expect(artifacts[1]?.features).toContain('crdt-yjs');
    expect(artifacts[2]?.wasmUrl?.toString()).toContain('wasm-perf');
  });

  it('keeps the Rust SQLite alias wired to the v2 database constructor', () => {
    expect(createSyncularRustSqliteDatabase).toBe(createSyncularV2Database);
  });

  it('exports the ergonomic managed browser client constructor', () => {
    expect(typeof createSyncularClient).toBe('function');
  });

  it('keeps the v2 managed constructor as an internal alias', () => {
    expect(typeof createSyncularV2Client).toBe('function');
    expect(createSyncularV2Client).toBe(createSyncularClient);
  });

  it('defaults generated app storage to OPFS SAH', () => {
    expect(
      resolveSyncularV2ClientConfig({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      }).storage
    ).toBe(SYNCULAR_V2_DEFAULT_STORAGE);
  });
});
