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
  httpBlobTransport,
  httpSyncTransport,
  httpRemoteOperationTransport,
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

  test('a headers function is read on every request', async () => {
    const { seen, doFetch } = fakeFetch();
    let token = 'first';
    const downloader = httpSegmentDownloader('https://host/segments', {
      fetch: doFetch,
      headers: () => ({ authorization: `Bearer ${token}` }),
    });
    const request = {
      segmentId: 'sha256:ab',
      table: 'tasks',
      requestedScopesJson: '{}',
    };
    await downloader(request);
    token = 'second';
    await downloader(request);
    await downloader.fetchUrl?.('https://cdn.example/x');
    expect(seen.map((entry) => entry.headers.authorization)).toEqual([
      'Bearer first',
      'Bearer second',
      undefined,
    ]);
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
  for (const signed of [false, true]) {
    for (const bodyFailure of [false, true]) {
      test(`segment failure has a code and structured evidence (signed=${signed}, body=${bodyFailure})`, async () => {
        let calls = 0;
        const cause = new TypeError(
          'https://user:password@cdn.example/secret-path?secret-query#secret-fragment',
        );
        const downloader = httpSegmentDownloader('https://host/segments', {
          fetch: Object.assign(
            async () => {
              calls++;
              if (!bodyFailure) throw cause;
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(cause);
                  },
                }),
              );
            },
            { preconnect: fetch.preconnect },
          ),
        });
        const operation = signed
          ? downloader.fetchUrl!(
              'https://user:password@cdn.example/image?signature=secret#grant',
            )
          : downloader({
              segmentId: 'sha256:test',
              table: 'tasks',
              requestedScopesJson: '{}',
            });
        await expect(operation).rejects.toMatchObject({
          code: 'sync.transport_failed',
          retryable: true,
          message: 'segment transfer failed',
          details: {
            causeKind: bodyFailure ? 'body' : 'network',
            ...(bodyFailure ? { httpStatus: 200 } : {}),
          },
        });
        expect(calls).toBe(1);
      });
    }
    test(`HTTP failure retains only status and kind (signed=${signed})`, async () => {
      const { seen, doFetch } = fakeFetch(403);
      const downloader = httpSegmentDownloader('/segments', { fetch: doFetch });
      await expect(
        signed
          ? downloader.fetchUrl!('https://cdn.example/image?signature=secret')
          : downloader({
              segmentId: 'sha256:test',
              table: 'tasks',
              requestedScopesJson: '{}',
            }),
      ).rejects.toMatchObject({
        code: 'sync.transport_failed',
        retryable: signed,
        details: {
          causeKind: 'status',
          httpStatus: 403,
        },
      });
      expect(seen).toHaveLength(1);
    });
  }

  test('direct endpoint retains the server error identity and retry policy', async () => {
    const downloader = httpSegmentDownloader('/segments', {
      fetch: Object.assign(
        async () =>
          Response.json(
            {
              code: 'sync.forbidden',
              message: 'scope grant refused',
              retryable: false,
            },
            { status: 403 },
          ),
        { preconnect: fetch.preconnect },
      ),
    });
    await expect(
      downloader({
        segmentId: 'sha256:test',
        table: 'tasks',
        requestedScopesJson: '{}',
      }),
    ).rejects.toMatchObject({
      code: 'sync.forbidden',
      message: 'scope grant refused',
      retryable: false,
      details: { causeKind: 'status', httpStatus: 403 },
    });
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

describe('transfer error privacy', () => {
  const capability =
    'https://user:password@cdn.example/secret-path?secret-query=value#secret-fragment';
  for (const signed of [false, true]) {
    for (const body of [false, true]) {
      for (const kind of ['typed', 'timeout', 'abort', 'opaque'] as const) {
        test(`segment sanitizes every injected exception (signed=${signed}, body=${body}, kind=${kind})`, async () => {
          const cause =
            kind === 'typed'
              ? new ClientSyncError('blob.not_found', capability, false, {
                  url: capability,
                  causeMessage: capability,
                })
              : kind === 'timeout'
                ? new DOMException(capability, 'TimeoutError')
                : kind === 'abort'
                  ? new DOMException(capability, 'AbortError')
                  : {
                      toString: () => {
                        throw new Error('must never stringify a cause');
                      },
                    };
          if (cause instanceof Error) cause.cause = new Error(capability);
          const downloader = httpSegmentDownloader(capability, {
            fetch: Object.assign(
              async () => {
                if (!body) throw cause;
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.error(cause);
                    },
                  }),
                );
              },
              { preconnect: fetch.preconnect },
            ),
          });
          const pending = signed
            ? downloader.fetchUrl!(capability)
            : downloader({
                segmentId: 'sha256:test',
                requestedScopesJson: '{}',
                table: 'tasks',
              });
          let caught: unknown;
          try {
            await pending;
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(ClientSyncError);
          if (!(caught instanceof ClientSyncError))
            throw new Error('expected transfer error');
          expect(caught.code).toBe('sync.transport_failed');
          expect(caught.message).toBe('segment transfer failed');
          expect(caught.retryable).toBe(true);
          expect(caught.details).toEqual({
            causeKind:
              kind === 'timeout'
                ? 'timeout'
                : kind === 'abort'
                  ? 'aborted'
                  : body
                    ? 'body'
                    : 'unknown',
            ...(body ? { httpStatus: 200 } : {}),
          });
          expect(caught.cause).toBeUndefined();
          expect(JSON.stringify(caught)).not.toContain('secret');
          expect(JSON.stringify(caught)).not.toContain('password');
        });
      }
    }
  }

  for (const body of [false, true]) {
    for (const operation of [
      'sync',
      'remote',
      'blob',
      'signed_blob',
      'signed_put',
      'grant',
    ] as const) {
      if (body && operation === 'signed_put') continue;
      test(`${operation} sanitizes injected ${body ? 'body' : 'network'} failures`, async () => {
        const cause = new ClientSyncError('blob.not_found', capability, false, {
          path: '/secret-path',
        });
        const doFetch = Object.assign(
          async () => {
            if (!body) throw cause;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(cause);
                },
              }),
              {
                headers:
                  operation === 'grant'
                    ? { 'content-type': 'application/json' }
                    : {},
              },
            );
          },
          { preconnect: fetch.preconnect },
        );
        const options = { fetch: doFetch };
        const blobs = httpBlobTransport(capability, options);
        const pending =
          operation === 'sync'
            ? httpSyncTransport(capability, options)(new Uint8Array())
            : operation === 'remote'
              ? httpRemoteOperationTransport(
                  capability,
                  options,
                )(new Uint8Array())
              : operation === 'blob'
                ? blobs.download('sha256:test')
                : operation === 'signed_blob'
                  ? blobs.fetchUrl!(capability)
                  : operation === 'signed_put'
                    ? blobs.uploadToUrl!(capability, new Uint8Array())
                    : blobs.uploadGrant!('sha256:test', 0);
        let caught: unknown;
        try {
          await pending;
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ClientSyncError);
        if (!(caught instanceof ClientSyncError))
          throw new Error('expected transfer error');
        expect(caught.code).toBe('sync.transport_failed');
        expect(caught.details).toEqual({
          causeKind: body ? 'body' : 'unknown',
          ...(body ? { httpStatus: 200 } : {}),
        });
        expect(caught.cause).toBeUndefined();
        expect(JSON.stringify(caught)).not.toContain('secret');
        expect(JSON.stringify(caught)).not.toContain('password');
      });
    }
  }

  test('only an actual blob endpoint 404 establishes absence', async () => {
    for (const status of [401, 403, 404, 429, 503]) {
      const { doFetch } = fakeFetch(status);
      const blobs = httpBlobTransport(capability, { fetch: doFetch });
      await expect(blobs.download('sha256:test')).rejects.toMatchObject({
        code:
          status === 404
            ? 'blob.not_found'
            : status === 403
              ? 'blob.forbidden'
              : status === 401
                ? 'sync.auth_required'
                : 'sync.transport_failed',
        details: { causeKind: 'status', httpStatus: status },
      });
      await expect(blobs.fetchUrl!(capability)).rejects.toMatchObject({
        code: 'sync.transport_failed',
        details: { causeKind: 'status', httpStatus: status },
      });
    }
    const blobs = httpBlobTransport(capability, {
      fetch: Object.assign(
        async () => {
          throw new TypeError(`HTTP 404 ${capability}`);
        },
        { preconnect: fetch.preconnect },
      ),
    });
    await expect(blobs.download('sha256:test')).rejects.toMatchObject({
      code: 'sync.transport_failed',
      details: { causeKind: 'network' },
    });
  });
});

test('a non-404 catalog body cannot claim that a blob is absent', async () => {
  for (const status of [401, 403, 500]) {
    const blobs = httpBlobTransport('/blobs', {
      fetch: Object.assign(
        async () =>
          Response.json(
            {
              code: 'blob.not_found',
              message: 'misclassified response',
              retryable: false,
            },
            { status },
          ),
        { preconnect: fetch.preconnect },
      ),
    });
    await expect(blobs.download('sha256:test')).rejects.toMatchObject({
      code:
        status === 401
          ? 'sync.auth_required'
          : status === 403
            ? 'blob.forbidden'
            : 'sync.transport_failed',
      message: 'HTTP request failed',
      retryable: status >= 500 || status === 401,
      details: { causeKind: 'status', httpStatus: status },
    });
  }
});

test('synchronous websocket exceptions never expose the request or their cause', async () => {
  const capability =
    'wss://user:password@host/secret-path?secret-query#secret-fragment';
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  let failConstructor = true;
  class ThrowingWebSocket {
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      if (failConstructor)
        throw new ClientSyncError('blob.not_found', capability, false);
      queueMicrotask(() => this.onopen?.());
    }
    send() {
      throw new Error(capability);
    }
    close() {
      throw new Error(capability);
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: ThrowingWebSocket,
  });
  try {
    for (const remote of [false, true]) {
      failConstructor = true;
      const pending = remote
        ? webSocketRemoteOperationConnector(capability)({ onMessage() {} })
        : webSocketRealtimeConnector(capability)({
            onText() {},
            onBinary() {},
          });
      await expect(pending).rejects.toMatchObject({
        code: 'sync.transport_failed',
        message: 'realtime socket failed to connect',
        details: { causeKind: 'unknown' },
      });
      failConstructor = false;
      if (remote) {
        const connection = await webSocketRemoteOperationConnector(capability)({
          onMessage() {},
        });
        expect(() => connection.send(new Uint8Array())).toThrow(
          'realtime send failed',
        );
        expect(() => connection.close()).toThrow('realtime close failed');
      } else {
        const connection = await webSocketRealtimeConnector(capability)({
          onText() {},
          onBinary() {},
        });
        expect(() => connection.send('hello')).toThrow('realtime send failed');
        expect(() => connection.sendBytes?.(new Uint8Array())).toThrow(
          'realtime send failed',
        );
        expect(() => connection.close()).toThrow('realtime close failed');
      }
    }
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebSocket');
    else Object.defineProperty(globalThis, 'WebSocket', original);
  }
});
