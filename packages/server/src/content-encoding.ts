/**
 * §1.3 transport compression for every buffered HTTP body the adapters
 * serve — `<mount>/sync`, `<mount>/operations`, blob GETs and segment
 * downloads: negotiate `Content-Encoding` from the request's
 * `Accept-Encoding` (zstd preferred, gzip fallback, identity when the client
 * offers neither), feature-detecting the runtime's codecs, zero
 * dependencies. Bun supplies zstd + gzip natively; every other runtime
 * (workerd, Node, Deno) gets gzip through the standard `CompressionStream`.
 *
 * Body bytes are stored and content-addressed UNCOMPRESSED (§5.1); this is a
 * per-response serving concern only. It is never applied to stored objects or
 * the signed-URL path (§5.8: presigned GETs serve the addressed bytes
 * verbatim; edge compression is a deployment concern). Clients MAY gzip a
 * request body (§1.3) — `decodeRequestBody` is the accepting half.
 *
 * Decision data (2026-07-03, 100k-row bench table, Bun 1.3): rows
 * segments 6.2× in 8 ms (zstd) / 7.7× in 42 ms (gzip); sqlite images
 * 3.4× in 14 ms (zstd) / 51 ms (gzip); client decompression ≤ 8 ms.
 */
import { syncError } from './errors';

export type ContentEncoding = 'zstd' | 'gzip';

interface Codec {
  readonly encoding: ContentEncoding;
  readonly compress: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

interface BunCompressors {
  readonly zstdCompressSync?: (bytes: Uint8Array) => Uint8Array;
  readonly gzipSync?: (bytes: Uint8Array) => Uint8Array;
}

/** Bodies below this size are served identity (headers outweigh gains). */
const MIN_COMPRESS_BYTES = 1024;

async function gzipWithCompressionStream(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const compressed = await new Response(
    new Blob([bytes.slice().buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

/** Preference order is zstd, gzip (§1.3). A runtime with neither codec
 * serves identity: negotiation, never a hard requirement here. */
function detectCodecs(): readonly Codec[] {
  const bun = (globalThis as { Bun?: BunCompressors }).Bun;
  const codecs: Codec[] = [];
  const zstd = bun?.zstdCompressSync;
  if (typeof zstd === 'function') {
    codecs.push({ encoding: 'zstd', compress: (bytes) => zstd(bytes) });
  }
  const gzip = bun?.gzipSync;
  if (typeof gzip === 'function') {
    codecs.push({ encoding: 'gzip', compress: (bytes) => gzip(bytes) });
  } else if (typeof CompressionStream === 'function') {
    codecs.push({ encoding: 'gzip', compress: gzipWithCompressionStream });
  }
  return codecs;
}

const CODECS = detectCodecs();

/** Does the `Accept-Encoding` header value accept `encoding` (q > 0)? */
export function acceptsEncoding(
  header: string,
  encoding: ContentEncoding,
): boolean {
  for (const entry of header.split(',')) {
    const [rawName, ...params] = entry.trim().split(';');
    const name = rawName?.trim().toLowerCase();
    if (name !== encoding) continue;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim().toLowerCase() === 'q' && Number(value) === 0) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Add `Accept-Encoding` to a response's `Vary` header. Every response whose
 * body was negotiated carries it, so a cache never serves one encoding to a
 * client that asked for another.
 */
export function varyOnAcceptEncoding(headers: Headers): void {
  const vary = headers.get('vary');
  if (vary === null) headers.set('vary', 'Accept-Encoding');
  else if (!/\baccept-encoding\b/i.test(vary)) {
    headers.set('vary', `${vary}, Accept-Encoding`);
  }
}

export interface EncodedBody {
  readonly bytes: Uint8Array;
  /** Absent ⇒ identity (no `Content-Encoding` header). */
  readonly contentEncoding?: ContentEncoding;
}

/**
 * Compress a buffered response body per §1.3. Returns the original bytes
 * (identity) when the client offered no supported encoding, the body is
 * tiny, or the runtime has no codec.
 */
export async function encodeBody(
  bytes: Uint8Array,
  acceptEncoding: string | undefined,
): Promise<EncodedBody> {
  if (acceptEncoding === undefined || bytes.length < MIN_COMPRESS_BYTES) {
    return { bytes };
  }
  for (const codec of CODECS) {
    if (acceptsEncoding(acceptEncoding, codec.encoding)) {
      return {
        bytes: await codec.compress(bytes),
        contentEncoding: codec.encoding,
      };
    }
  }
  return { bytes };
}

/**
 * Segments above this size are relayed as a stream instead of being
 * buffered and compressed in memory: a sqlite image can exceed the memory of
 * a Workers isolate (128 MB).
 */
export const SEGMENT_STREAM_THRESHOLD_BYTES = 16 * 1024 * 1024;

export interface EncodedStreamBody {
  readonly body: ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Absent ⇒ identity (no `Content-Encoding` header). */
  readonly contentEncoding?: 'gzip';
}

/**
 * Compress a streamed body per §1.3 with the runtime's `CompressionStream`:
 * gzip when the client accepts it, identity otherwise (zstd has no standard
 * streaming codec).
 */
export function encodeStream(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  acceptEncoding: string | undefined,
): EncodedStreamBody {
  if (
    acceptEncoding === undefined ||
    !acceptsEncoding(acceptEncoding, 'gzip') ||
    typeof CompressionStream !== 'function'
  ) {
    return { body };
  }
  return {
    body: body.pipeThrough(new CompressionStream('gzip')),
    contentEncoding: 'gzip',
  };
}

/**
 * The bytes of a request body, decompressed when the client sent
 * `Content-Encoding: gzip` (§1.3: clients MAY compress a request body and
 * servers MUST accept it). Returns `undefined` for any other declared
 * encoding — the adapter answers 415 rather than parse bytes it cannot read.
 * A gzip body that does not decompress is a `sync.invalid_request`.
 */
export async function decodeRequestBody(
  request: Request,
): Promise<Uint8Array | undefined> {
  const encoding = request.headers
    .get('content-encoding')
    ?.trim()
    .toLowerCase();
  if (encoding === undefined || encoding === '' || encoding === 'identity') {
    return new Uint8Array(await request.arrayBuffer());
  }
  if (encoding !== 'gzip' || typeof DecompressionStream !== 'function') {
    return undefined;
  }
  if (request.body === null) {
    throw syncError('sync.invalid_request', 'malformed gzip request body');
  }
  try {
    return new Uint8Array(
      await new Response(
        request.body.pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer(),
    );
  } catch {
    throw syncError('sync.invalid_request', 'malformed gzip request body');
  }
}
