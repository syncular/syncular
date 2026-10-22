/**
 * Segment and blob routes under workerd with real D1 and R2 bindings.
 *
 * SYNCULAR-WORKERS-SEGMENT-ENCODING-001: the segment route
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
    r2Buckets: ['BUCKET'],
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

test('the R2 stores hold their preconditions over the workerd binding', async () => {
  const url = await mf.ready;
  const response = await fetch(new URL('/r2', url), { method: 'POST' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    segmentText: 'rows segment bytes',
    scopeDigests: 2,
    openedText: 'rows segment bytes',
    blobText: '{"inline":"json"}',
    blobCount: 1,
  });
}, 60_000);

test('a small blob PUT keeps its media type on R2 and the GET serves it', async () => {
  const url = await mf.ready;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const blobId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const put = (contentType: string) =>
    fetch(new URL(`/blobs/${encodeURIComponent(blobId)}`, url), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: bytes,
    });
  // The first upload names no media type; the second one records it.
  expect((await put('application/octet-stream')).status).toBe(200);
  expect((await put('image/jpeg')).status).toBe(200);
  const object = await fetch(new URL(`/object?blobId=${blobId}`, url));
  expect(await object.json()).toEqual({ contentType: 'image/jpeg' });
  const referenced = await fetch(new URL(`/reference?blobId=${blobId}`, url), {
    method: 'POST',
  });
  expect(referenced.status).toBe(204);
  const response = await fetch(
    new URL(`/blobs/${encodeURIComponent(blobId)}`, url),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
}, 60_000);

test('erasing a scope value removes its rows on D1 and its blob on R2', async () => {
  const url = await mf.ready;
  // The previous test stored the blob and the `files` row f1 referencing it.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const blobId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const response = await fetch(new URL(`/erase?blobId=${blobId}`, url), {
    method: 'POST',
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    steps: {
      rowsErased: number;
      historyErased: number;
      blobsErased: string[];
      done: boolean;
    }[];
    rows: number;
    blob: boolean;
  };
  expect(result.steps[0]).toMatchObject({
    rowsErased: 3,
    blobsErased: [blobId],
  });
  // The seed commit's upserts leave the log; the erasure deletes stay.
  expect(result.steps[1]?.historyErased).toBe(4);
  expect(result.steps.at(-1)?.done).toBe(true);
  expect(result.rows).toBe(0);
  expect(result.blob).toBe(false);
}, 60_000);
