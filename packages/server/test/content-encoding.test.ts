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
  encodeBody,
  encodeStream,
} from '../src/content-encoding';

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
