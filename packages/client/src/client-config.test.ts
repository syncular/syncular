import { describe, expect, it } from 'bun:test';
import {
  resolveSyncularV2ClientConfig,
  SYNCULAR_V2_DEFAULT_STORAGE,
} from './client-config';

describe('Syncular v2 client config', () => {
  it('defaults browser storage to OPFS SAH', () => {
    expect(
      resolveSyncularV2ClientConfig({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
      }).storage
    ).toBe(SYNCULAR_V2_DEFAULT_STORAGE);
  });

  it('keeps an explicit storage override', () => {
    expect(
      resolveSyncularV2ClientConfig({
        baseUrl: '/sync',
        actorId: 'actor',
        clientId: 'client',
        storage: 'indexedDb',
      }).storage
    ).toBe('indexedDb');
  });
});
