import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobStorageAdapter } from '@syncular/core';
import { createHmacTokenSigner } from '@syncular/server';
import { createFilesystemBlobStorageAdapter } from './index';

let basePath: string;
let adapter: BlobStorageAdapter;

beforeEach(async () => {
  basePath = await mkdtemp(join(tmpdir(), 'syncular-blob-test-'));
  adapter = createFilesystemBlobStorageAdapter({
    basePath,
    baseUrl: 'https://example.com/api/sync',
    tokenSigner: createHmacTokenSigner('test-secret'),
  });
});

afterEach(async () => {
  await rm(basePath, { recursive: true, force: true });
});

const testHash =
  'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const testData = new TextEncoder().encode('hello world');

describe('createFilesystemBlobStorageAdapter', () => {
  test('put + get round-trip', async () => {
    await adapter.put!(testHash, testData);
    const result = await adapter.get!(testHash);
    expect(result).toEqual(testData);
  });

  test('putStream + getStream round-trip', async () => {
    const inputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(testData);
        controller.close();
      },
    });

    await adapter.putStream!(testHash, inputStream);

    const outputStream = await adapter.getStream!(testHash);
    expect(outputStream).not.toBeNull();

    const reader = outputStream!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const result = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    expect(result).toEqual(testData);
  });

  test('get returns null for missing blob', async () => {
    const result = await adapter.get!(testHash);
    expect(result).toBeNull();
  });

  test('getStream returns null for missing blob', async () => {
    const result = await adapter.getStream!(testHash);
    expect(result).toBeNull();
  });

  test('exists returns true after put', async () => {
    expect(await adapter.exists(testHash)).toBe(false);
    await adapter.put!(testHash, testData);
    expect(await adapter.exists(testHash)).toBe(true);
  });

  test('delete removes the blob', async () => {
    await adapter.put!(testHash, testData);
    expect(await adapter.exists(testHash)).toBe(true);
    await adapter.delete(testHash);
    expect(await adapter.exists(testHash)).toBe(false);
  });

  test('delete is idempotent for missing blob', async () => {
    await adapter.delete(testHash);
  });

  test('getMetadata returns size', async () => {
    await adapter.put!(testHash, testData);
    const meta = await adapter.getMetadata!(testHash);
    expect(meta).toEqual({ size: testData.length });
  });

  test('getMetadata returns null for missing blob', async () => {
    const meta = await adapter.getMetadata!(testHash);
    expect(meta).toBeNull();
  });

  test('creates hash-based subdirectories', async () => {
    await adapter.put!(testHash, testData);
    // hex = abcdef..., so subdirs should be "ab/cd"
    const firstLevel = await readdir(basePath);
    expect(firstLevel).toContain('ab');
    const secondLevel = await readdir(join(basePath, 'ab'));
    expect(secondLevel).toContain('cd');
  });

  test('signUpload returns a token URL', async () => {
    const result = await adapter.signUpload({
      hash: testHash,
      size: 100,
      mimeType: 'application/octet-stream',
      expiresIn: 60,
    });
    expect(result.url).toContain('/blobs/');
    expect(result.url).toContain('token=');
    expect(result.method).toBe('PUT');
  });

  test('signDownload returns a token URL', async () => {
    const url = await adapter.signDownload({
      hash: testHash,
      expiresIn: 60,
    });
    expect(url).toContain('/blobs/');
    expect(url).toContain('token=');
  });
});
