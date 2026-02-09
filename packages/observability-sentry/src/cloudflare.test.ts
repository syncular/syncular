import { describe, expect, test } from 'bun:test';
import {
  attachCloudflareSentryTraceHeaders,
  getCloudflareSentryTraceHeaders,
} from './cloudflare';

describe('cloudflare tracing helpers', () => {
  test('extracts trace headers from sentry trace data', () => {
    expect(
      getCloudflareSentryTraceHeaders({
        'sentry-trace': 'trace-id-span-id-1',
        baggage: 'sample_rate=1',
      })
    ).toEqual({
      sentryTrace: 'trace-id-span-id-1',
      baggage: 'sample_rate=1',
    });
  });

  test('returns original request when trace headers are missing', () => {
    const request = new Request('https://example.com/api/sync', {
      method: 'POST',
      headers: { 'x-custom': '1' },
      body: '{}',
    });

    const result = attachCloudflareSentryTraceHeaders(request, {});
    expect(result).toBe(request);
  });

  test('adds sentry trace headers to cloned request', async () => {
    const request = new Request('https://example.com/api/sync', {
      method: 'POST',
      headers: { 'x-custom': '1' },
      body: '{"ok":true}',
    });

    const result = attachCloudflareSentryTraceHeaders(request, {
      sentryTrace: 'trace-id-span-id-1',
      baggage: 'sample_rate=1',
    });

    expect(result).not.toBe(request);
    expect(result.headers.get('x-custom')).toBe('1');
    expect(result.headers.get('sentry-trace')).toBe('trace-id-span-id-1');
    expect(result.headers.get('baggage')).toBe('sample_rate=1');
    expect(await result.text()).toBe('{"ok":true}');
  });
});
