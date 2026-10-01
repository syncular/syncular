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
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'workerd/segment-worker.ts')],
    outdir,
    target: 'browser',
    format: 'esm',
    // pull.ts imports the Bun-only image builder lazily; workerd never
    // evaluates that chunk.
    splitting: true,
    external: ['bun:sqlite'],
    plugins: [
      {
        // The repo is dist-free; bundle the runtime-neutral sources.
        name: 'syncular-sources',
        setup(build) {
          build.onResolve(
            { filter: /^@syncular\/(core|server|server-hono)$/ },
            (args) => ({
              path: resolve(
                packages,
                args.path.slice('@syncular/'.length),
                'src/index.ts',
              ),
            }),
          );
          // The test runner's bundler does not resolve bare dependencies
          // of the redirected sources on its own.
          build.onResolve({ filter: /^hono(\/.*)?$/ }, (args) => ({
            path: Bun.resolveSync(args.path, resolve(packages, 'server-hono')),
          }));
        },
      },
    ],
  });
  expect(built.logs).toEqual([]);
  mf = new Miniflare({
    modules: built.outputs.map((output) => ({
      type: 'ESModule' as const,
      path: output.path,
    })),
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
