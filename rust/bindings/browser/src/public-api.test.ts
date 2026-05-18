import { describe, expect, it } from 'bun:test';
import {
  createSyncularV2Client,
  createSyncularRustSqliteDatabase,
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

describe('@syncular/client-rust public API', () => {
  it('exports the stable v2 runtime contract', () => {
    expect(SYNCULAR_V2_PACKAGE_NAME).toBe('@syncular/client-rust');
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

  it('orders packaged runtime artifacts from smallest compatible to full', () => {
    const artifacts = getSyncularV2PackagedRuntimeArtifacts();
    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      'core',
      'full',
    ]);
    expect(artifacts[0]?.features).toEqual(['web-owned-sqlite-core']);
    expect(artifacts[1]?.features).toContain('crdt-yjs');
  });

  it('keeps the Rust SQLite alias wired to the v2 database constructor', () => {
    expect(createSyncularRustSqliteDatabase).toBe(createSyncularV2Database);
  });

  it('exports the managed browser client constructor', () => {
    expect(typeof createSyncularV2Client).toBe('function');
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
