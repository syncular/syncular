import { describe, expect, test } from 'bun:test';
import {
  type BlobStorageAdapter,
  type BlobTokenSigner,
  createR2BlobStorageAdapter,
} from './r2';

function createBodyStream(
  chunks: readonly Uint8Array[]
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function consumeStream(
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function createTokenSigner(): BlobTokenSigner {
  return {
    async sign() {
      return 'token';
    },
    async verify() {
      return null;
    },
  };
}

function createAdapterWithCapturedPuts(
  captured: Array<{ body: unknown; options: unknown }>
): BlobStorageAdapter {
  const bucket = {
    async put(_key: string, body: unknown, options?: unknown) {
      captured.push({ body, options });
      if (body instanceof ReadableStream) {
        await consumeStream(body as ReadableStream<Uint8Array>);
      }
      return {} as R2Object;
    },
    async get() {
      return null;
    },
    async head() {
      return null;
    },
    async delete() {},
  } as unknown as R2Bucket;

  return createR2BlobStorageAdapter({
    bucket,
    baseUrl: '/api/sync',
    tokenSigner: createTokenSigner(),
  });
}

describe('createR2BlobStorageAdapter.putStream', () => {
  test('buffers unknown-length streams before upload', async () => {
    const puts: Array<{ body: unknown; options: unknown }> = [];
    const adapter = createAdapterWithCapturedPuts(puts);

    await adapter.putStream?.(
      'sha256:abc123',
      createBodyStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])])
    );

    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(puts[0]?.body as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  test('uses fixed-length stream when byteLength is provided', async () => {
    const puts: Array<{ body: unknown; options: unknown }> = [];
    const adapter = createAdapterWithCapturedPuts(puts);

    await adapter.putStream?.(
      'sha256:def456',
      createBodyStream([new Uint8Array([9, 8, 7, 6])]),
      { byteLength: 4 }
    );

    expect(puts).toHaveLength(1);
    if (typeof FixedLengthStream !== 'undefined') {
      expect(puts[0]?.body).toBeInstanceOf(ReadableStream);
    } else {
      expect(puts[0]?.body).toBeInstanceOf(Uint8Array);
    }
  });

  test('omits checksum when disableChecksum metadata is set', async () => {
    const puts: Array<{ body: unknown; options: unknown }> = [];
    const adapter = createAdapterWithCapturedPuts(puts);

    await adapter.putStream?.(
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      createBodyStream([new Uint8Array([1, 2, 3])]),
      { disableChecksum: true }
    );

    expect(puts).toHaveLength(1);
    const options = puts[0]?.options as { sha256?: string };
    expect(options.sha256).toBeUndefined();
  });
});
