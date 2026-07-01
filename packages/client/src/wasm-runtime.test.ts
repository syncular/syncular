import { afterEach, describe, expect, it } from 'bun:test';
import { prepareSyncularWasmModuleInput } from './wasm-runtime';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('prepareSyncularWasmModuleInput', () => {
  it('loads URL inputs as bytes before wasm-bindgen initialization', async () => {
    const bytes = new Uint8Array([0, 97, 115, 109]).buffer;
    const calls: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(input);
      return new Response(bytes, {
        headers: { 'content-type': 'application/wasm' },
      });
    }) as typeof fetch;

    const result = await prepareSyncularWasmModuleInput(
      '/syncular/wasm-core/syncular_bg.wasm'
    );

    expect(calls).toEqual(['/syncular/wasm-core/syncular_bg.wasm']);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(result as ArrayBuffer))).toEqual([
      0, 97, 115, 109,
    ]);
  });

  it('loads Response inputs as bytes instead of using instantiateStreaming', async () => {
    const result = await prepareSyncularWasmModuleInput(
      new Response(new Uint8Array([1, 2, 3]).buffer)
    );

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(result as ArrayBuffer))).toEqual([
      1, 2, 3,
    ]);
  });

  it('keeps already-materialized module inputs unchanged', async () => {
    const bytes = new Uint8Array([4, 5, 6]);

    await expect(prepareSyncularWasmModuleInput(bytes)).resolves.toBe(bytes);
  });

  it('reports failed fetches with status and URL', async () => {
    globalThis.fetch = (async () =>
      new Response('missing', {
        status: 404,
        statusText: 'Not Found',
      })) as typeof fetch;

    await expect(
      prepareSyncularWasmModuleInput('/missing/syncular_bg.wasm')
    ).rejects.toThrow(
      'Syncular WASM runtime artifact could not be loaded from /missing/syncular_bg.wasm (404 Not Found)'
    );
  });
});
