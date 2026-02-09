import { describe, expect, it } from 'bun:test';
import type { SyncPullRequest, SyncPushRequest } from '@syncular/core';
import { createHttpTransport } from '../index';

const pullRequest: SyncPullRequest = {
  clientId: 'client-1',
  limitCommits: 10,
  subscriptions: [],
};

const pushRequest: SyncPushRequest = {
  clientId: 'client-1',
  clientCommitId: 'commit-1',
  schemaVersion: 1,
  operations: [
    {
      table: 'tasks',
      row_id: 'row-1',
      op: 'upsert',
      payload: { id: 'row-1', title: 'Task' },
    },
  ],
};

describe('createHttpTransport SyncTransportOptions', () => {
  it('forwards AbortSignal to pull requests', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null = null;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        const requestSignal = input instanceof Request ? input.signal : null;
        capturedSignal = init?.signal ?? requestSignal;
        return new Response(JSON.stringify({ ok: true, subscriptions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await transport.pull(pullRequest, { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it('forwards AbortSignal to push requests', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null = null;

    const transport = createHttpTransport({
      baseUrl: 'http://localhost',
      fetch: async (input, init) => {
        const requestSignal = input instanceof Request ? input.signal : null;
        capturedSignal = init?.signal ?? requestSignal;
        return new Response(
          JSON.stringify({
            ok: true,
            status: 'applied',
            commitSeq: 1,
            results: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      },
    });

    await transport.push(pushRequest, { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it('retries pull once after 401 when onAuthError returns true', async () => {
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

        return new Response(JSON.stringify({ ok: true, subscriptions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const response = await transport.pull(pullRequest, {
      onAuthError: async () => {
        authErrorCount += 1;
        return true;
      },
    });

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
      transport.pull(pullRequest, {
        onAuthError: async () => false,
      })
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
});
