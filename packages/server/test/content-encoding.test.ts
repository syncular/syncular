/**
 * The gzip codec that ships on every runtime (§1.3): Bun prefers its own sync
 * codecs, and everything else (workerd, Node, Deno) falls back to the standard
 * `CompressionStream`. This suite pins the Bun negotiation and runs the same
 * module under Node, where only the fallback exists.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acceptsEncoding,
  decodeRequestBody,
  encodeBody,
  encodeStream,
} from '../src/content-encoding';
import { SyncError } from '../src/errors';

test('Bun negotiates zstd before gzip and serves identity below 1 KiB', async () => {
  const body = new TextEncoder().encode('abcdefghij'.repeat(400));
  expect((await encodeBody(body, 'zstd, gzip')).contentEncoding).toBe('zstd');
  expect((await encodeBody(body, 'gzip')).contentEncoding).toBe('gzip');
  expect((await encodeBody(body, 'br')).contentEncoding).toBeUndefined();
  expect((await encodeBody(body, 'gzip;q=0')).contentEncoding).toBeUndefined();
  expect(
    (await encodeBody(new Uint8Array(64), 'gzip')).contentEncoding,
  ).toBeUndefined();
});

test('the gzip codec is the CompressionStream fallback without Bun', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'syncular-encoding-'));
  const built = Bun.spawnSync({
    cmd: [
      process.execPath,
      'build',
      resolve(import.meta.dir, 'content-encoding.probe.ts'),
      '--outdir',
      outdir,
      '--target',
      'node',
      '--format',
      'esm',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(built.stderr.toString()).toBe('');
  expect(built.exitCode).toBe(0);
  const run = Bun.spawnSync({
    cmd: ['node', join(outdir, 'content-encoding.probe.js')],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.stderr.toString()).toBe('');
  expect(JSON.parse(run.stdout.toString())).toEqual({
    contentEncoding: 'gzip',
    shrunk: true,
    roundTrip: true,
    tinyIsIdentity: true,
    refusedIsIdentity: true,
    requestRoundTrip: true,
  });
}, 60_000);

test('a streamed body is gzip only when the client accepts it', () => {
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
      controller.close();
    },
  });
  expect(encodeStream(body, 'br').contentEncoding).toBeUndefined();
  expect(encodeStream(body, 'gzip').contentEncoding).toBe('gzip');
});

test('Accept-Encoding entries honor q=0 and unknown encodings', () => {
  expect(acceptsEncoding('gzip, zstd', 'zstd')).toBe(true);
  expect(acceptsEncoding('gzip;q=0.5', 'gzip')).toBe(true);
  expect(acceptsEncoding('gzip;q=0', 'gzip')).toBe(false);
  expect(acceptsEncoding('br', 'gzip')).toBe(false);
});

function syncRequest(body: Uint8Array, encoding?: string): Request {
  return new Request('https://probe.example/sync', {
    method: 'POST',
    headers: encoding !== undefined ? { 'content-encoding': encoding } : {},
    body: new Blob([body.slice().buffer as ArrayBuffer]),
  });
}

async function decodeFailure(request: Request, max: number) {
  try {
    await decodeRequestBody(request, max);
  } catch (error) {
    return error instanceof SyncError ? error : undefined;
  }
  return undefined;
}

test('a gzip body stops inflating at maxRequestBytes (§1.7)', async () => {
  // 4 MiB of zeros gzip to about 4 KiB: the decoded size, not the wire
  // size, meets the cap.
  const bomb = Bun.gzipSync(new Uint8Array(4 * 1024 * 1024));
  expect(bomb.length).toBeLessThan(64 * 1024);
  const error = await decodeFailure(syncRequest(bomb, 'gzip'), 64 * 1024);
  expect(error?.code).toBe('sync.limit_exceeded');
  expect(error?.httpStatus).toBe(413);
  expect(JSON.parse(error?.details ?? '{}')).toEqual({
    limit: 'maxRequestBytes',
    max: 64 * 1024,
  });
});

test('identity bodies count against the same cap', async () => {
  const body = new Uint8Array(1025).fill(7);
  expect((await decodeFailure(syncRequest(body), 1024))?.code).toBe(
    'sync.limit_exceeded',
  );
  expect(await decodeRequestBody(syncRequest(body), 1025)).toEqual(body);
  expect(await decodeRequestBody(syncRequest(body, 'identity'), 1025)).toEqual(
    body,
  );
  expect(
    await decodeRequestBody(syncRequest(Bun.gzipSync(body), 'gzip'), 1025),
  ).toEqual(body);
});

test('a gzip body that does not inflate is an invalid request', async () => {
  const error = await decodeFailure(
    syncRequest(new Uint8Array([1, 2, 3, 4]), 'gzip'),
    1024,
  );
  expect(error?.code).toBe('sync.invalid_request');
  expect(await decodeRequestBody(syncRequest(new Uint8Array(1), 'br'), 1)).toBe(
    undefined,
  );
});
