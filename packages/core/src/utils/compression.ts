import { gunzipSync as gunzipSyncFflate } from 'fflate';
import { bytesToReadableStream, readAllBytesFromStream } from './bytes';
import { getBunRuntime, usesNodeRuntimeModules } from './internal-runtime';

type NodeZlibModule = typeof import('node:zlib');

let nodeZlibModulePromise: Promise<NodeZlibModule | null> | null = null;

function importNodeModule(specifier: string): Promise<unknown> {
  return new Function('specifier', 'return import(specifier);')(
    specifier
  ) as Promise<unknown>;
}

async function getNodeZlibModule(): Promise<NodeZlibModule | null> {
  if (!usesNodeRuntimeModules()) {
    return null;
  }
  if (!nodeZlibModulePromise) {
    nodeZlibModulePromise = importNodeModule('node:zlib')
      .then((module) => module as NodeZlibModule)
      .catch(() => null);
  }
  return nodeZlibModulePromise;
}

/**
 * Gzip-compress a byte array using the fastest native implementation available
 * in the current runtime.
 */
export async function gzipBytes(payload: Uint8Array): Promise<Uint8Array> {
  const bun = getBunRuntime();
  if (bun?.gzipSync) {
    return bun.gzipSync(payload);
  }

  const nodeZlib = await getNodeZlibModule();
  if (nodeZlib?.gzip) {
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

  if (typeof CompressionStream !== 'undefined') {
    const stream = bytesToReadableStream(payload).pipeThrough(
      new CompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>
    );
    return readAllBytesFromStream(stream);
  }

  throw new Error(
    'Failed to gzip bytes, no compression implementation available'
  );
}

/**
 * Gzip-decompress a byte array using the fastest implementation available in
 * the current runtime, with a pure-JS fallback for runtimes like Expo/Hermes.
 */
export async function gunzipBytes(payload: Uint8Array): Promise<Uint8Array> {
  const bun = getBunRuntime();
  if (bun?.gunzipSync) {
    return bun.gunzipSync(payload);
  }

  const nodeZlib = await getNodeZlibModule();
  if (nodeZlib?.gunzip) {
    return await new Promise<Uint8Array>((resolve, reject) => {
      nodeZlib.gunzip(payload, (error, decompressed) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(new Uint8Array(decompressed));
      });
    });
  }

  if (typeof DecompressionStream !== 'undefined') {
    const stream = bytesToReadableStream(payload).pipeThrough(
      new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>
    );
    return readAllBytesFromStream(stream);
  }

  try {
    return gunzipSyncFflate(payload);
  } catch (error) {
    throw new Error(
      'Failed to gunzip bytes, no decompression implementation available',
      { cause: error }
    );
  }
}

/**
 * Gzip-compress bytes and return a stream. When streaming compression is not
 * available, falls back to eager compression and includes byteLength metadata.
 */
export async function gzipBytesToStream(payload: Uint8Array): Promise<{
  stream: ReadableStream<Uint8Array>;
  byteLength?: number;
}> {
  const bun = getBunRuntime();
  const nodeZlib = await getNodeZlibModule();

  if (!bun?.gzipSync && !nodeZlib && typeof CompressionStream !== 'undefined') {
    const source = bytesToReadableStream(payload);
    const gzipStream = new CompressionStream('gzip') as TransformStream<
      Uint8Array,
      Uint8Array
    >;
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
