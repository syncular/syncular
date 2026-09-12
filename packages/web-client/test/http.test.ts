/**
 * httpSegmentDownloader (§5.4/§5.5): the direct endpoint carries host
 * auth + X-Syncular-Scopes; the signed-URL fetch carries NOTHING — the
 * URL is the entire grant, and configured host headers MUST NOT leak to
 * CDN hosts. Failures map to a retryable client error (re-pull
 * recovers); there is no fall-through logic here (that rule lives in
 * the client core).
 */
import { describe, expect, test } from 'bun:test';
import {
  ClientSyncError,
  httpSegmentDownloader,
  webSocketRealtimeConnector,
  webSocketRemoteOperationConnector,
} from '../src/index';

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
    await expect(
      downloader.fetchUrl?.('https://cdn.example/x'),
    ).rejects.toThrow(ClientSyncError);
    // Exactly one request: the downloader never touched the direct
    // endpoint on failure (§5.4 — descriptor invalidated, re-pull).
    expect(seen).toHaveLength(1);
  });
});

describe('WebSocket connectors', () => {
  test('reject a socket that closes before opening', async () => {
    class ClosedBeforeOpenWebSocket {
      static latest: ClosedBeforeOpenWebSocket | undefined;
      binaryType = 'blob';
      onclose: (() => void) | null = null;

      constructor(_url: string) {
        ClosedBeforeOpenWebSocket.latest = this;
      }

      send(): void {}
      close(): void {}
    }

    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: ClosedBeforeOpenWebSocket,
    });
    try {
      for (const connect of [
        webSocketRealtimeConnector('wss://example.test/realtime'),
        webSocketRemoteOperationConnector(
          'wss://example.test/operations/realtime',
        ),
      ]) {
        const pending = connect({
          onText: () => undefined,
          onBinary: () => undefined,
          onMessage: () => undefined,
        });
        ClosedBeforeOpenWebSocket.latest?.onclose?.();
        await expect(pending).rejects.toMatchObject({
          code: 'sync.transport_failed',
        });
      }
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, 'WebSocket');
      } else {
        Object.defineProperty(globalThis, 'WebSocket', original);
      }
    }
  });
});

for (const signed of [false, true]) {
  test(`segment transfer emits intermediate bytes before completion (signed=${signed})`, async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher = Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        ),
      { preconnect: fetch.preconnect },
    );
    const downloader = httpSegmentDownloader('https://host/segments', {
      fetch: fetcher,
    });
    const updates: number[] = [];
    const intermediate = Promise.withResolvers<void>();
    const onProgress = (bytes: number) => {
      updates.push(bytes);
      intermediate.resolve();
    };
    let finished = false;
    const operation = signed
      ? downloader.fetchUrl!('https://cdn/image', onProgress)
      : downloader({
          segmentId: 'sha256:test',
          table: 'tasks',
          requestedScopesJson: '{}',
          onProgress,
        });
    const done = operation.then((bytes) => {
      finished = true;
      return bytes;
    });
    stream!.enqueue(new Uint8Array(64 * 1024));
    await intermediate.promise;
    expect(finished).toBe(false);
    expect(updates).toEqual([64 * 1024]);
    stream!.enqueue(new Uint8Array(17));
    stream!.close();
    expect((await done).byteLength).toBe(64 * 1024 + 17);
    expect(updates).toEqual([64 * 1024, 64 * 1024 + 17]);
  });
}
