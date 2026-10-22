/**
 * Probe run under Node by `content-encoding.test.ts`. Node has no Bun sync
 * codecs, so this exercises the `CompressionStream` gzip codec and the
 * `DecompressionStream` request-body path exactly as a workerd, Node, or Deno
 * deployment does.
 */
import { decodeRequestBody, encodeBody } from '../src/content-encoding';

const text = 'abcdefghij'.repeat(400);
const body = new TextEncoder().encode(text);
const encoded = await encodeBody(body, 'zstd, gzip');
const decoded = new Uint8Array(
  await new Response(
    new Blob([encoded.bytes.slice().buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer(),
);
const tiny = await encodeBody(new Uint8Array(64), 'gzip');
const refused = await encodeBody(body, 'gzip;q=0, zstd;q=0');
const decodedRequest = await decodeRequestBody(
  new Request('https://probe.example/sync', {
    method: 'POST',
    headers: { 'content-encoding': 'gzip' },
    body: new Blob([encoded.bytes.slice().buffer as ArrayBuffer]),
  }),
);
console.log(
  JSON.stringify({
    contentEncoding: encoded.contentEncoding,
    shrunk: encoded.bytes.length < body.length,
    roundTrip: new TextDecoder().decode(decoded) === text,
    tinyIsIdentity: tiny.contentEncoding === undefined,
    refusedIsIdentity: refused.contentEncoding === undefined,
    requestRoundTrip:
      decodedRequest !== undefined &&
      new TextDecoder().decode(decodedRequest) === text,
  }),
);
