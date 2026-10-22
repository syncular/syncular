/**
 * Segment, blob and forwarded sync rounds under workerd with real D1, R2 and
 * Durable Object bindings.
 *
 * SYNCULAR-WORKERS-SEGMENT-ENCODING-001: the segment route
 * gzips a segment above SEGMENT_STREAM_THRESHOLD_BYTES itself (§1.3), and
 * workerd encodes a response that declares Content-Encoding again unless the
 * body is marked `encodeBody: 'manual'`. A client that decodes the response
 * once must receive the content-addressed bytes (§5.1).
 *
 * §1.3 for `/sync`: the round is answered by the partition Durable Object as
 * an identity body; the Worker is the outermost hop and declares gzip with
 * the default `encodeBody`, so workerd encodes it once. Decoding the client
 * response must yield the identity round byte for byte.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalScopeJson,
  encodeMessage,
  encodeSparseRow,
  type RequestFrame,
  type RowColumn,
} from '@syncular/core';
import { SSP2_CONTENT_TYPE } from '@syncular/server';
import { Miniflare } from 'miniflare';

const LOG_EPOCH = 'test-log-epoch';
/** A partition of its own, so the pushed rows do not disturb the p1 fixtures
 * the segment, blob and erasure tests share. */
const SYNC_PARTITION = 'part-sync';
const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
];

/**
 * A POST whose `Accept-Encoding` and body reach the wire verbatim: Bun's
 * `fetch` overwrites the header with `br, gzip` and decodes the response, so
 * neither the identity branch nor the encoded bytes are observable through it.
 */
function postRaw(
  url: URL,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<{
  status: number;
  contentEncoding: string | null;
  vary: string | null;
  body: Uint8Array<ArrayBuffer>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(body.byteLength) },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        response.on('end', () => {
          const bytes = new Uint8Array(
            chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({
            status: response.statusCode ?? 0,
            contentEncoding:
              (response.headers['content-encoding'] as string | undefined) ??
              null,
            vary: (response.headers.vary as string | undefined) ?? null,
            body: bytes,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

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
    durableObjects: { REALTIME: { className: 'RealtimeDO' } },
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

test('a forwarded /sync round arrives gzip-encoded once, and takes a gzip body', async () => {
  const url = await mf.ready;
  expect((await fetch(new URL('/setup', url), { method: 'POST' })).status).toBe(
    204,
  );
  const requestBytes = (frames: RequestFrame[]) =>
    encodeMessage({
      wireVersion: 3,
      msgKind: 'request',
      frames: [
        {
          type: 'REQ_HEADER',
          clientId: 'client-1',
          schemaVersion: 1,
          logEpoch: LOG_EPOCH,
        },
        ...frames,
      ],
    });
  const sync = (
    body: Uint8Array,
    acceptEncoding: string,
    contentEncoding?: string,
  ) =>
    postRaw(
      new URL('/sync', url),
      {
        'content-type': SSP2_CONTENT_TYPE,
        'x-test-accept-encoding': acceptEncoding,
        'x-test-partition': SYNC_PARTITION,
        ...(contentEncoding !== undefined
          ? { 'content-encoding': contentEncoding }
          : {}),
      },
      body,
    );
  // Enough rows that the round's body clears the 1 KiB identity floor.
  const pushed = await sync(
    requestBytes([
      {
        type: 'PUSH_COMMIT',
        clientCommitId: 'c1',
        operations: Array.from({ length: 300 }, (_, i) => {
          const rowId = `task-${String(i).padStart(4, '0')}-${'.'.repeat(48)}`;
          return {
            table: 'tasks',
            rowId,
            op: 'upsert' as const,
            payload: encodeSparseRow(TASK_COLUMNS, 0, [rowId, 'p1']),
          };
        }),
      },
    ]),
    'identity',
  );
  expect(pushed.status).toBe(200);

  const pull: RequestFrame[] = [
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0011,
    },
    {
      type: 'SUBSCRIPTION',
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
      cursor: -1,
    },
  ];
  const identity = await sync(requestBytes(pull), 'identity');
  expect(identity.status).toBe(200);
  expect(identity.contentEncoding).toBeNull();
  expect(identity.vary).toContain('Accept-Encoding');
  expect(identity.body.byteLength).toBeGreaterThan(1024);

  // The client decodes exactly once: the bytes equal the identity round, so
  // workerd applied the encoding the Worker declared and nothing else. An
  // identity body behind the header would not gunzip at all.
  const gzip = await sync(requestBytes(pull), 'gzip');
  expect(gzip.status).toBe(200);
  expect(gzip.contentEncoding).toBe('gzip');
  expect(gzip.body.byteLength).toBeLessThan(identity.body.byteLength);
  expect(new Uint8Array(Bun.gunzipSync(gzip.body))).toEqual(identity.body);

  // §1.3 request bodies: the forwarded request keeps the client's
  // `Content-Encoding`, and the Durable Object decodes it.
  const compressedRequest = await sync(
    new Uint8Array(Bun.gzipSync(requestBytes(pull).slice())),
    'identity',
    'gzip',
  );
  expect(compressedRequest.status).toBe(200);
  expect(compressedRequest.body).toEqual(identity.body);
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
