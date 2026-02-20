function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
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

/**
 * Gzip-compress a byte array using CompressionStream when available,
 * with node:zlib fallback for Node/Bun runtimes.
 */
export async function gzipBytes(payload: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const stream = bytesToReadableStream(payload).pipeThrough(
      new CompressionStream('gzip') as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >
    );
    return streamToBytes(stream);
  }

  const nodeZlib = await import('node:zlib');
  return await new Promise<Uint8Array>((resolve, reject) => {
    nodeZlib.gzip(payload, (error, compressed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(compressed));
    });
  });
}

/**
 * Gzip-compress bytes and return a stream. When streaming compression is not
 * available, falls back to eager compression and includes byteLength metadata.
 */
export async function gzipBytesToStream(payload: Uint8Array): Promise<{
  stream: ReadableStream<Uint8Array>;
  byteLength?: number;
}> {
  if (typeof CompressionStream !== 'undefined') {
    const source = bytesToReadableStream(payload);
    const gzipStream = new CompressionStream(
      'gzip'
    ) as unknown as TransformStream<Uint8Array, Uint8Array>;
    return {
      stream: source.pipeThrough(gzipStream),
    };
  }

  const compressed = await gzipBytes(payload);
  return {
    stream: bytesToReadableStream(compressed),
    byteLength: compressed.length,
  };
}
