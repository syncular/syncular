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

  it('supports wildcard ports for loopback origins', () => {
    expect(
      isRequestOriginAllowed({
        requestUrl:
          'https://space.syncular.space/api/sync/realtime?clientId=client-1',
        originHeader: 'http://localhost:5180',
        allowedOrigins: ['http://localhost:*'],
      })
    ).toBe(true);

    expect(
      isRequestOriginAllowed({
        requestUrl:
          'https://space.syncular.space/api/sync/realtime?clientId=client-1',
        originHeader: 'http://127.0.0.1:5174',
        allowedOrigins: ['http://127.0.0.1:*'],
      })
    ).toBe(true);
  });

  it('supports wildcard subdomain origin patterns', () => {
    expect(
      isRequestOriginAllowed({
        requestUrl:
          'https://space.syncular.space/api/sync/realtime?clientId=client-1',
        originHeader: 'https://preview-123.pages.dev',
        allowedOrigins: ['https://*.pages.dev'],
      })
    ).toBe(true);

    expect(
      isRequestOriginAllowed({
        requestUrl:
          'https://space.syncular.space/api/sync/realtime?clientId=client-1',
        originHeader: 'https://pages.dev',
        allowedOrigins: ['https://*.pages.dev'],
      })
    ).toBe(false);
  });
});
