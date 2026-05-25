import { describe, expect, it } from 'bun:test';
import {
  resolveSyncularClientConfig,
  SYNCULAR_DEFAULT_STORAGE,
  SYNCULAR_LOCAL_DISABLED_BASE_URL,
} from './client-config';

describe('Syncular client config', () => {
  it('defaults browser storage to OPFS SAH', () => {
    expect(
      resolveSyncularClientConfig({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      }).storage
    ).toBe(SYNCULAR_DEFAULT_STORAGE);
  });

  it('keeps an explicit storage override', () => {
    expect(
      resolveSyncularClientConfig({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
        storage: 'indexedDb',
      }).storage
    ).toBe('indexedDb');
  });

  it('requires baseUrl for remote clients', () => {
    expect(() =>
      resolveSyncularClientConfig({
        actorId: 'actor',
        clientId: 'client',
      })
    ).toThrow('Syncular remote clients require config.baseUrl');
  });

  it('allows local-sync-compatible clients without baseUrl', () => {
    expect(
      resolveSyncularClientConfig({
        mode: 'local-sync-compatible',
        actorId: 'actor',
        clientId: 'client',
      })
    ).toMatchObject({
      mode: 'local-sync-compatible',
      baseUrl: SYNCULAR_LOCAL_DISABLED_BASE_URL,
    });
  });
});
