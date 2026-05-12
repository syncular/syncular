import { describe, expect, it } from 'bun:test';
import {
  createSyncularRustSqliteDatabase,
  createSyncularV2Database,
  resolveSyncularV2ClientConfig,
  SYNCULAR_V2_DEFAULT_STORAGE,
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
  SYNCULAR_V2_WASM_BINARY_FILE,
  SYNCULAR_V2_WASM_GLUE_FILE,
} from './index';

describe('@syncular/client-rust public API', () => {
  it('exports the stable v2 runtime contract', () => {
    expect(SYNCULAR_V2_PACKAGE_NAME).toBe('@syncular/client-rust');
    expect(SYNCULAR_V2_PACKAGE_VERSION).toBe('0.0.0');
    expect(SYNCULAR_V2_WASM_GLUE_FILE).toBe('syncular_v2.js');
    expect(SYNCULAR_V2_WASM_BINARY_FILE).toBe('syncular_v2_bg.wasm');
  });

  it('keeps the Rust SQLite alias wired to the v2 database constructor', () => {
    expect(createSyncularRustSqliteDatabase).toBe(createSyncularV2Database);
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
