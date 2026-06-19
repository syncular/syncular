import { describe, expect, it } from 'bun:test';
import { ScopeCacheDurableObject } from './scope-cache';

class FakeDurableObjectStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function createScopeCacheObject(): ScopeCacheDurableObject {
  return new ScopeCacheDurableObject(
    {
      storage: new FakeDurableObjectStorage(),
    } as unknown as DurableObjectState,
    {}
  );
}

describe('ScopeCacheDurableObject error envelopes', () => {
  it('returns a stable envelope for disallowed methods', async () => {
    const object = createScopeCacheObject();

    const response = await object.fetch(new Request('https://scope-cache/'));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toMatchObject({
      error: 'sync.invalid_request',
      code: 'sync.invalid_request',
      category: 'invalid-request',
      retryable: false,
      recommendedAction: 'fixRequest',
      message: 'Method not allowed',
    });
  });

  it('returns a stable envelope for invalid payloads', async () => {
    const object = createScopeCacheObject();

    const response = await object.fetch(
      new Request('https://scope-cache/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'get' }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'sync.invalid_request',
      code: 'sync.invalid_request',
      category: 'invalid-request',
      retryable: false,
      recommendedAction: 'fixRequest',
      message: 'Invalid scope cache request',
    });
  });
});
