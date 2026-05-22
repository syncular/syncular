import { describe, expect, it } from 'bun:test';
import {
  resolveSyncularClientConfig,
  SYNCULAR_DEFAULT_STORAGE,
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
});
