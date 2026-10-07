/**
 * SYNCULAR-WORKERS-SEGMENT-ENCODING-001 under workerd: the segment route
 * gzips a segment above SEGMENT_STREAM_THRESHOLD_BYTES itself (§5.8), and
 * workerd encodes a response that declares Content-Encoding again unless the
 * body is marked `encodeBody: 'manual'`. A client that decodes the response
 * once must receive the content-addressed bytes (§5.1).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalScopeJson } from '@syncular/core';
import { Miniflare } from 'miniflare';

const packages = resolve(import.meta.dir, '../..');
let mf: Miniflare;

beforeAll(async () => {
  const outdir = mkdtempSync(join(tmpdir(), 'syncular-workerd-'));
  // Bundling a workspace package with an in-process `Bun.build` leaks the
  // bundler's resolver state into every later import in the test process
  // (Bun 1.4.0), so fetch/realtime tests in the same invocation cannot
  // resolve `@syncular/core`. Run the build in its own process; the CLI
  // resolves the dist-free sources through the `bun` condition.
  const built = Bun.spawnSync({
    cmd: [
      process.execPath,
      'build',
      resolve(import.meta.dir, 'workerd/segment-worker.ts'),
      '--outdir',
      outdir,
      '--target',
      'browser',
      '--format',
      'esm',
      '--conditions',
      'bun',
    ],
    cwd: packages,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(built.stderr.toString()).toBe('');
  expect(built.exitCode).toBe(0);
  const output = join(outdir, 'segment-worker.js');
  expect(await Bun.file(output).text()).not.toContain('bun:sqlite');
  mf = new Miniflare({
    modules: [{ type: 'ESModule' as const, path: output }],
    modulesRoot: outdir,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

test('a streamed gzip segment decodes once to its content address', async () => {
  const url = await mf.ready;
  const seeded = (await (
    await fetch(new URL('/seed', url), { method: 'POST' })
  ).json()) as { segmentId: string; byteLength: number };
  // Bun's fetch decodes Content-Encoding once, as a browser does.
  const response = await fetch(new URL(`/segments/${seeded.segmentId}`, url), {
    headers: {
      'accept-encoding': 'gzip',
      'x-syncular-scopes': canonicalScopeJson({ project_id: ['p1'] }),
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-encoding')).toBe('gzip');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.byteLength).toBe(seeded.byteLength);
  expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
    seeded.segmentId,
  );
}, 60_000);
