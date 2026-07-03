/**
 * httpSegmentDownloader (§5.4/§5.5): the direct endpoint carries host
 * auth + X-Syncular-Scopes; the signed-URL fetch carries NOTHING — the
 * URL is the entire grant, and configured host headers MUST NOT leak to
 * CDN hosts. Failures map to a retryable client error (re-pull
 * recovers); there is no fall-through logic here (that rule lives in
 * the client core).
 */
import { describe, expect, test } from 'bun:test';
import { ClientSyncError, httpSegmentDownloader } from '../src/index';

interface SeenRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function fakeFetch(status = 200) {
  const seen: SeenRequest[] = [];
  const doFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers)) {
      headers[key] = value;
    }
    seen.push({ url: String(input), headers });
    return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, {
      status,
    });
  }) as typeof fetch;
  return { seen, doFetch };
}

describe('httpSegmentDownloader', () => {
  test('direct endpoint sends scopes header plus configured host auth', async () => {
    const { seen, doFetch } = fakeFetch();
    const downloader = httpSegmentDownloader('https://host/segments', {
      fetch: doFetch,
      headers: { authorization: 'Bearer host-token' },
    });
    await downloader({
      segmentId: 'sha256:ab',
      table: 'tasks',
      requestedScopesJson: '{"project_id":["p1"]}',
    });
    expect(seen[0]?.url).toBe('https://host/segments/sha256%3Aab');
    expect(seen[0]?.headers['x-syncular-scopes']).toBe('{"project_id":["p1"]}');
    expect(seen[0]?.headers.authorization).toBe('Bearer host-token');
  });

  test('fetchUrl exists (advertises bit 3) and sends NO headers (§5.4)', async () => {
    const { seen, doFetch } = fakeFetch();
    const downloader = httpSegmentDownloader('https://host/segments', {
      fetch: doFetch,
      headers: { authorization: 'Bearer host-token' },
    });
    expect(typeof downloader.fetchUrl).toBe('function');
    const bytes = await downloader.fetchUrl?.(
      'https://cdn.example/segments/sha256:ab?st=tok',
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]?.url).toBe('https://cdn.example/segments/sha256:ab?st=tok');
    // The URL is the entire grant: no host auth, no scopes header.
    expect(seen[0]?.headers).toEqual({});
  });

  test('a non-success URL fetch is a retryable client error, never a detour', async () => {
    const { seen, doFetch } = fakeFetch(403);
    const downloader = httpSegmentDownloader('https://host/segments', {
      fetch: doFetch,
    });
    expect(downloader.fetchUrl?.('https://cdn.example/x')).rejects.toThrow(
      ClientSyncError,
    );
    await Bun.sleep(0);
    // Exactly one request: the downloader never touched the direct
    // endpoint on failure (§5.4 — descriptor invalidated, re-pull).
    expect(seen).toHaveLength(1);
  });
});
