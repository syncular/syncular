import { describe, expect, it } from 'bun:test';
import { isRequestOriginAllowed } from '../websocket-origin';

describe('websocket origin policy', () => {
  it('allows same-origin browser upgrades by default', () => {
    expect(
      isRequestOriginAllowed({
        requestUrl: 'http://localhost/sync/realtime?clientId=client-1',
        originHeader: 'http://localhost',
      })
    ).toBe(true);
  });

  it('rejects cross-origin browser upgrades by default', () => {
    expect(
      isRequestOriginAllowed({
        requestUrl: 'http://localhost/sync/realtime?clientId=client-1',
        originHeader: 'https://evil.syncular.test',
      })
    ).toBe(false);
  });

  it('allows origin-less non-browser requests by default', () => {
    expect(
      isRequestOriginAllowed({
        requestUrl: 'http://localhost/sync/realtime?clientId=client-1',
      })
    ).toBe(true);
  });

  it('requires an exact match when allowedOrigins is configured', () => {
    expect(
      isRequestOriginAllowed({
        requestUrl: 'http://localhost/sync/realtime?clientId=client-1',
        originHeader: 'https://app.syncular.test',
        allowedOrigins: ['https://app.syncular.test'],
      })
    ).toBe(true);

    expect(
      isRequestOriginAllowed({
        requestUrl: 'http://localhost/sync/realtime?clientId=client-1',
        originHeader: 'https://evil.syncular.test',
        allowedOrigins: ['https://app.syncular.test'],
      })
    ).toBe(false);

    expect(
      isRequestOriginAllowed({
        requestUrl: 'http://localhost/sync/realtime?clientId=client-1',
        allowedOrigins: ['https://app.syncular.test'],
      })
    ).toBe(false);
  });
});
