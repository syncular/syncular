import { describe, expect, it } from 'bun:test';
import { createHttpTransport } from '../index';

describe('createHttpTransport SyncTransportOptions', () => {
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
});
