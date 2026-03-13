import { describe, expect, it } from 'bun:test';
import {
  createApiClient,
  createHttpTransport,
  createReactNativeHttpTransport,
} from '../index';

function readHeaderFromFetchArgs(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string
): string | null {
  if (input instanceof Request) {
    return input.headers.get(name);
  }

  return new Headers(init?.headers).get(name);
}

function readSearchParamFromFetchArgs(
  input: RequestInfo | URL,
  name: string
): string | null {
  const url =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.toString()
        : typeof input === 'string'
          ? input
          : null;
  if (!url) return null;
  return new URL(url, 'http://localhost').searchParams.get(name);
}

describe('createHttpTransport SyncTransportOptions', () => {
  it('exposes explicit transport capabilities and merges overrides', () => {
    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      capabilities: {
        snapshotChunkReadMode: 'bytes',
        preferMaterializedSnapshots: true,
      },
    });

    expect(transport.capabilities?.snapshotChunkReadMode).toBe('bytes');
    expect(transport.capabilities?.preferMaterializedSnapshots).toBe(true);
    expect(transport.capabilities?.gzipDecompressionMode).toBeDefined();
    expect(transport.capabilities?.preferredBootstrapApplyMode).toBe(
      'per-subscription'
    );
    expect(transport.capabilities?.preferredSnapshotApplyYieldMs).toBe(0);
  });

  it('provides a React Native / Expo transport preset', () => {
    const transport = createReactNativeHttpTransport({
      baseUrl: 'http://localhost',
    });

    expect(transport.capabilities).toMatchObject({
      snapshotChunkReadMode: 'bytes',
      gzipDecompressionMode: 'buffered',
      preferredBootstrapApplyMode: 'per-subscription',
      preferredSnapshotApplyYieldMs: 0,
      preferMaterializedSnapshots: true,
    });
  });

  it('forwards AbortSignal to sync requests', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null = null;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        const requestSignal = input instanceof Request ? input.signal : null;
        capturedSignal = init?.signal ?? requestSignal;
        return new Response(
          JSON.stringify({ ok: true, pull: { ok: true, subscriptions: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      },
    });

    await transport.sync(
      {
        clientId: 'client-1',
        pull: { limitCommits: 10, subscriptions: [] },
      },
      { signal: controller.signal }
    );
    expect(capturedSignal).toBe(controller.signal);
  });

  it('retries sync once after 401 when onAuthError returns true', async () => {
    let requestCount = 0;
    let authErrorCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({ ok: true, pull: { ok: true, subscriptions: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      },
    });

    const response = await transport.sync(
      {
        clientId: 'client-1',
        pull: { limitCommits: 10, subscriptions: [] },
      },
      {
        onAuthError: async () => {
          authErrorCount += 1;
          return true;
        },
      }
    );

    expect(response.ok).toBe(true);
    expect(requestCount).toBe(2);
    expect(authErrorCount).toBe(1);
  });

  it('does not retry when onAuthError returns false', async () => {
    let requestCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(
      transport.sync(
        {
          clientId: 'client-1',
          pull: { limitCommits: 10, subscriptions: [] },
        },
        {
          onAuthError: async () => false,
        }
      )
    ).rejects.toMatchObject({ status: 403 });

    expect(requestCount).toBe(1);
  });

  it('retries sync on transient network errors before succeeding', async () => {
    let requestCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async () => {
        requestCount += 1;
        if (requestCount <= 3) {
          throw new TypeError('fetch failed: connect ECONNRESET');
        }

        return new Response(
          JSON.stringify({ ok: true, pull: { ok: true, subscriptions: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      },
    });

    const response = await transport.sync({
      clientId: 'client-1',
      pull: { limitCommits: 10, subscriptions: [] },
    });

    expect(response.ok).toBe(true);
    expect(requestCount).toBe(4);
  });

  it('does not retry aborted sync requests', async () => {
    let requestCount = 0;
    const controller = new AbortController();

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async () => {
        requestCount += 1;
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });

    await expect(
      transport.sync(
        {
          clientId: 'client-1',
          pull: { limitCommits: 10, subscriptions: [] },
        },
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(DOMException);

    expect(requestCount).toBe(1);
  });

  it('retries snapshot chunk fetch on auth error and preserves signal', async () => {
    const controller = new AbortController();
    let requestCount = 0;
    let authErrorCount = 0;
    const seenSignals: Array<AbortSignal | null> = [];

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        const requestSignal = input instanceof Request ? input.signal : null;
        seenSignals.push(init?.signal ?? requestSignal);

        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });

    const bytes = await transport.fetchSnapshotChunk(
      { chunkId: 'chunk-1' },
      {
        signal: controller.signal,
        onAuthError: async () => {
          authErrorCount += 1;
          return true;
        },
      }
    );

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(requestCount).toBe(2);
    expect(authErrorCount).toBe(1);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(seenSignals[1]).toBe(controller.signal);
  });

  it('streams snapshot chunk fetch with auth retry support', async () => {
    let requestCount = 0;
    let authErrorCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });

    const stream = await transport.fetchSnapshotChunkStream?.(
      { chunkId: 'chunk-2' },
      {
        onAuthError: async () => {
          authErrorCount += 1;
          return true;
        },
      }
    );

    expect(stream).toBeDefined();
    const reader = stream!.getReader();
    const collected: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      collected.push(...value);
    }
    reader.releaseLock();

    expect(collected).toEqual([9, 8, 7]);
    expect(requestCount).toBe(2);
    expect(authErrorCount).toBe(1);
  });

  it('preserves base path for streamed snapshot chunk fetches', async () => {
    const seenUrls: string[] = [];

    const transport = createHttpTransport({
      baseUrl: 'http://localhost:4311/api',
      fetch: async (input) => {
        seenUrls.push(
          typeof input === 'string' ? input : (input as Request).url
        );
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });

    const stream = await transport.fetchSnapshotChunkStream?.({
      chunkId: 'chunk-path-test',
    });
    expect(stream).toBeDefined();

    const reader = stream!.getReader();
    await reader.read();
    reader.releaseLock();

    expect(seenUrls).toEqual([
      'http://localhost:4311/api/sync/snapshot-chunks/chunk-path-test',
    ]);
  });

  it('sends snapshot scopes via header when using direct transport options', async () => {
    let seenHeader: string | null = null;
    let seenQueryScopes: string | null = null;

    const scopeValues = { user_id: 'u1' };
    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        seenHeader = headers.get('x-syncular-snapshot-scopes');
        seenQueryScopes = readSearchParamFromFetchArgs(input, 'scopes');
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });

    await transport.fetchSnapshotChunk({
      chunkId: 'chunk-with-scopes',
      scopeValues,
    });

    expect(seenHeader).toBe(JSON.stringify(scopeValues));
    expect(seenQueryScopes).toBe(JSON.stringify(scopeValues));
  });

  it('sends snapshot scopes via header when wrapping an existing api client', async () => {
    let seenHeader: string | null = null;

    const scopeValues = { user_id: 'u2' };
    const client = createApiClient({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        seenHeader = readHeaderFromFetchArgs(
          input,
          init,
          'x-syncular-snapshot-scopes'
        );
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });
    const transport = createHttpTransport(client);

    await transport.fetchSnapshotChunk({
      chunkId: 'chunk-from-client',
      scopeValues,
    });

    expect(seenHeader).toBe(JSON.stringify(scopeValues));
  });

  it('sends snapshot scopes via header for streamed snapshot chunk fetches', async () => {
    let seenHeader: string | null = null;
    let seenQueryScopes: string | null = null;

    const scopeValues = { user_id: 'u3' };
    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        seenHeader = headers.get('x-syncular-snapshot-scopes');
        seenQueryScopes = readSearchParamFromFetchArgs(input, 'scopes');
        return new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });

    const stream = await transport.fetchSnapshotChunkStream?.({
      chunkId: 'chunk-stream-with-scopes',
      scopeValues,
    });

    expect(stream).toBeDefined();
    const reader = stream!.getReader();
    await reader.read();
    reader.releaseLock();

    expect(seenHeader).toBe(JSON.stringify(scopeValues));
    expect(seenQueryScopes).toBe(JSON.stringify(scopeValues));
  });

  it('supports auth lifecycle callbacks on 401/403', async () => {
    let requestCount = 0;
    let authExpiredCount = 0;
    let refreshCount = 0;
    let retryCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      authLifecycle: {
        onAuthExpired: async (context) => {
          authExpiredCount += 1;
          expect(context.operation).toBe('sync');
          expect(context.status).toBe(401);
        },
        refreshToken: async (context) => {
          refreshCount += 1;
          expect(context.operation).toBe('sync');
          expect(context.status).toBe(401);
          return true;
        },
        retryWithFreshToken: async (context) => {
          retryCount += 1;
          expect(context.operation).toBe('sync');
          expect(context.status).toBe(401);
          expect(context.refreshResult).toBe(true);
          return context.refreshResult;
        },
      },
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ ok: true, pull: { ok: true, subscriptions: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      },
    });

    const response = await transport.sync({
      clientId: 'client-1',
      pull: { limitCommits: 10, subscriptions: [] },
    });

    expect(response.ok).toBe(true);
    expect(requestCount).toBe(2);
    expect(authExpiredCount).toBe(1);
    expect(refreshCount).toBe(1);
    expect(retryCount).toBe(1);
  });

  it('deduplicates concurrent token refresh requests', async () => {
    let requestCount = 0;
    let refreshCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      authLifecycle: {
        refreshToken: async () => {
          refreshCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return true;
        },
      },
      fetch: async () => {
        requestCount += 1;
        if (requestCount <= 2) {
          return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ ok: true, pull: { ok: true, subscriptions: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      },
    });

    const [first, second] = await Promise.all([
      transport.sync({
        clientId: 'client-a',
        pull: { limitCommits: 10, subscriptions: [] },
      }),
      transport.sync({
        clientId: 'client-b',
        pull: { limitCommits: 10, subscriptions: [] },
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(refreshCount).toBe(1);
    expect(requestCount).toBe(4);
  });

  it('prioritizes per-call onAuthError over shared auth lifecycle', async () => {
    let legacyCount = 0;
    let refreshCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      authLifecycle: {
        refreshToken: async () => {
          refreshCount += 1;
          return true;
        },
      },
      fetch: async () =>
        new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(
      transport.sync(
        {
          clientId: 'client-1',
          pull: { limitCommits: 10, subscriptions: [] },
        },
        {
          onAuthError: async () => {
            legacyCount += 1;
            return false;
          },
        }
      )
    ).rejects.toMatchObject({ status: 401 });

    expect(legacyCount).toBe(1);
    expect(refreshCount).toBe(0);
  });

  it('retries streamed snapshot chunk fetch via shared auth lifecycle', async () => {
    let requestCount = 0;
    let refreshCount = 0;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      authLifecycle: {
        refreshToken: async () => {
          refreshCount += 1;
          return true;
        },
      },
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: 'UNAUTHENTICATED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(new Uint8Array([5, 4, 3]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    });

    const stream = await transport.fetchSnapshotChunkStream?.({
      chunkId: 'chunk-shared-auth',
    });
    expect(stream).toBeDefined();

    const reader = stream!.getReader();
    const collected: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      collected.push(...value);
    }
    reader.releaseLock();

    expect(collected).toEqual([5, 4, 3]);
    expect(refreshCount).toBe(1);
    expect(requestCount).toBe(2);
  });
});
