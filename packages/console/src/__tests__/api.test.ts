import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createConsoleClient, testConnection } from '../lib/api';

describe('createConsoleClient', () => {
  it('returns an object with GET, POST, PUT, DELETE, and PATCH methods', () => {
    const client = createConsoleClient({
      serverUrl: 'https://api.example.com',
      token: 'test-token',
    });

    expect(typeof client.GET).toBe('function');
    expect(typeof client.POST).toBe('function');
    expect(typeof client.PUT).toBe('function');
    expect(typeof client.DELETE).toBe('function');
    expect(typeof client.PATCH).toBe('function');
  });
});

describe('testConnection', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('resolves on a 200 response', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ commitCount: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const client = createConsoleClient({
      serverUrl: 'https://api.example.com',
      token: 'valid-token',
    });

    await expect(testConnection(client)).resolves.toBeUndefined();
  });

  it('throws with status code on a 401 response', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });

    const client = createConsoleClient({
      serverUrl: 'https://api.example.com',
      token: 'bad-token',
    });

    await expect(testConnection(client)).rejects.toThrow('401');
  });

  it('throws a generic error on network failure', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const client = createConsoleClient({
      serverUrl: 'https://unreachable.example.com',
      token: 'any',
    });

    await expect(testConnection(client)).rejects.toThrow();
  });

  it('extracts string error detail from error body', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify('plain string error'), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });

    const client = createConsoleClient({
      serverUrl: 'https://api.example.com',
      token: 'tok',
    });

    await expect(testConnection(client)).rejects.toThrow('500');
  });

  it('extracts nested .error field from object error body', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: 'Forbidden: insufficient permissions' }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }
      );

    const client = createConsoleClient({
      serverUrl: 'https://api.example.com',
      token: 'tok',
    });

    await expect(testConnection(client)).rejects.toThrow(
      'Forbidden: insufficient permissions'
    );
  });

  it('extracts nested .message field when .error is absent', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'Rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });

    const client = createConsoleClient({
      serverUrl: 'https://api.example.com',
      token: 'tok',
    });

    await expect(testConnection(client)).rejects.toThrow('Rate limited');
  });
});
