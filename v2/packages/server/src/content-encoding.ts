/**
 * §5.8 shipped compression posture for the direct segment endpoint:
 * negotiate `Content-Encoding` from the request's `Accept-Encoding`
 * (zstd preferred, gzip fallback, identity when the client offers
 * neither), feature-detecting the runtime's codecs — zero dependencies.
 *
 * Segment bytes are stored and content-addressed UNCOMPRESSED (§5.1);
 * this is a per-response serving concern only. It is never applied to
 * stored objects or the signed-URL path (§5.8: presigned GETs serve the
 * addressed bytes verbatim; edge compression is a deployment concern).
 *
 * Decision data (2026-07-03, 100k-row bench table, Bun 1.3): rows
 * segments 6.2× in 8 ms (zstd) / 7.7× in 42 ms (gzip); sqlite images
 * 3.4× in 14 ms (zstd) / 51 ms (gzip); client decompression ≤ 8 ms.
 */

export type SegmentContentEncoding = 'zstd' | 'gzip';

interface Codec {
  readonly encoding: SegmentContentEncoding;
  readonly compress: (bytes: Uint8Array) => Uint8Array;
}

interface BunCompressors {
  readonly zstdCompressSync?: (bytes: Uint8Array) => Uint8Array;
  readonly gzipSync?: (bytes: Uint8Array) => Uint8Array;
}

/** Preference order is zstd, gzip (§5.8). Non-Bun runtimes without these
 * codecs serve identity — negotiation, never a hard requirement here. */
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
  }
  return codecs;
}

const CODECS = detectCodecs();

/** Bodies below this size are served identity (headers outweigh gains). */
const MIN_COMPRESS_BYTES = 1024;

/** Does the `Accept-Encoding` header value accept `encoding` (q > 0)? */
function accepts(header: string, encoding: SegmentContentEncoding): boolean {
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

export interface EncodedSegmentBody {
  readonly bytes: Uint8Array;
  /** Absent ⇒ identity (no `Content-Encoding` header). */
  readonly contentEncoding?: SegmentContentEncoding;
}

/**
 * Compress a buffered segment body per §5.8. Returns the original bytes
 * (identity) when the client offered no supported encoding, the body is
 * tiny, or the runtime has no codec.
 */
export function encodeSegmentBody(
  bytes: Uint8Array,
  acceptEncoding: string | undefined,
): EncodedSegmentBody {
  if (acceptEncoding === undefined || bytes.length < MIN_COMPRESS_BYTES) {
    return { bytes };
  }
  for (const codec of CODECS) {
    if (accepts(acceptEncoding, codec.encoding)) {
      return {
        bytes: codec.compress(bytes),
        contentEncoding: codec.encoding,
      };
    }
  }
  return { bytes };
}
