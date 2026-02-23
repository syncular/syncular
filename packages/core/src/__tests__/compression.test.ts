import { describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { gzipBytes, gzipBytesToStream } from '../utils';

async function readStream(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
  }

  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

describe('gzipBytes', () => {
  it('compresses bytes that can be decompressed via gunzip', async () => {
    const payload = new TextEncoder().encode(
      'syncular compression test '.repeat(64)
    );
    const compressed = await gzipBytes(payload);
    const decompressed = new Uint8Array(gunzipSync(compressed));
    expect(decompressed).toEqual(payload);
  });
});

describe('gzipBytesToStream', () => {
  it('returns a gzip stream that round-trips', async () => {
    const payload = new TextEncoder().encode('stream compression '.repeat(64));
    const result = await gzipBytesToStream(payload);
    const compressed = await readStream(result.stream);
    const decompressed = new Uint8Array(gunzipSync(compressed));
    expect(decompressed).toEqual(payload);
    if (typeof result.byteLength === 'number') {
      expect(result.byteLength).toBe(compressed.length);
    }
  });
});
