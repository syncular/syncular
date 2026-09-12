import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { decodeMessage } from '@syncular/core';
import {
  handleSegmentDownload,
  handleSyncRequest,
  verifySegmentToken,
} from '@syncular/server';
import { makeClient, makeServer, PARTITION } from './helpers';
import { OPFS_SCHEMA, type CrashPoint } from './opfs-bootstrap-fixture';
import type {} from './opfs-bootstrap-page';

const source = makeServer(OPFS_SCHEMA);
source.allowed['actor-1'] = { project_id: ['p1'] };
source.limits.inlineSegmentMaxBytes = 0;
const expected = Array.from({ length: 4000 }, (_, i) => ({
  id: `code-${String(i).padStart(5, '0')}`,
  project_id: 'p1',
  title: `needle code${i} ${'catalogue '.repeat(32)}`,
}));
let server: ReturnType<typeof Bun.serve>;
let downloads = 0;
let images = 0;
let pin = 0;
let signedDownloads = 0;

beforeAll(async () => {
  source.now.ms = Date.now();
  const seed = await makeClient(source, {
    clientId: 'seed',
    schema: OPFS_SCHEMA,
  });
  try {
    for (let i = 0; i < expected.length; i += 500) {
      await seed.client.mutate(
        expected
          .slice(i, i + 500)
          .map((values) => ({ table: 'catalogue', op: 'upsert', values })),
      );
      await seed.client.syncUntilIdle();
    }
    pin = await source.storage.getMaxCommitSeq(PARTITION);
  } finally {
    await seed.client.close();
    seed.db.close();
  }
  const build = await Bun.build({
    entrypoints: [
      join(import.meta.dir, 'opfs-bootstrap-page.ts'),
      join(import.meta.dir, 'opfs-bootstrap-worker.ts'),
    ],
    target: 'browser',
    conditions: ['bun'],
    external: ['@sqlite.org/sqlite-wasm'],
  });
  if (!build.success)
    throw new AggregateError(build.logs, 'browser fixture build failed');
  const assets = new Map<string, string>(
    await Promise.all(
      build.outputs.map(
        async (output) =>
          [
            `/${output.path.split('/').at(-1)}`,
            (await output.text()).replaceAll(
              /(["'])@sqlite\.org\/sqlite-wasm\1/g,
              '"/vendor/index.mjs"',
            ),
          ] as const,
      ),
    ),
  );
  const vendor = dirname(
    Bun.resolveSync('@sqlite.org/sqlite-wasm', import.meta.dir),
  );
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const headers = {};
      if (pathname === '/')
        return new Response(
          '<!doctype html><script type="module" src="/opfs-bootstrap-page.js"></script>',
          { headers: { ...headers, 'Content-Type': 'text/html' } },
        );
      const asset = assets.get(pathname);
      if (asset)
        return new Response(asset, {
          headers: { ...headers, 'Content-Type': 'text/javascript' },
        });
      if (
        [
          '/vendor/index.mjs',
          '/vendor/sqlite3.wasm',
          '/vendor/sqlite3-opfs-async-proxy.js',
        ].includes(pathname)
      ) {
        return new Response(
          Bun.file(join(vendor, pathname.slice('/vendor/'.length))),
          { headers },
        );
      }
      if (pathname === '/crash-barrier') {
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => resolve(new Response()),
            {
              once: true,
            },
          );
        });
      }
      if (pathname === '/sync' || pathname === '/sync-signed') {
        const response = await handleSyncRequest(
          new Uint8Array(await request.arrayBuffer()),
          {
            ...source.ctxFor('actor-1'),
            ...(pathname === '/sync-signed'
              ? {
                  signedUrls: {
                    key: 'synthetic-browser-test-key',
                    baseUrl: new URL('/signed-segments', request.url).href,
                    audience: () => 'synthetic-browser-test',
                  },
                }
              : {}),
          },
        );
        const decoded = decodeMessage(response);
        if (decoded.msgKind === 'response')
          images += decoded.frames.filter(
            (frame) =>
              frame.type === 'SEGMENT_REF' && frame.mediaType === 'sqlite',
          ).length;
        return new Response(response.slice().buffer, { headers });
      }
      if (pathname.startsWith('/signed-segments/')) {
        const segmentId = decodeURIComponent(
          pathname.slice('/signed-segments/'.length),
        );
        const segment = await source.segments.get(segmentId);
        if (!segment) return new Response('missing segment', { status: 404 });
        await verifySegmentToken(
          'synthetic-browser-test-key',
          new URL(request.url).searchParams.get('st') ?? '',
          {
            segmentId,
            scopeDigest: segment.record.scopeDigest,
            audience: 'synthetic-browser-test',
            nowMs: source.now.ms,
          },
        );
        expect(request.headers.get('Authorization')).toBeNull();
        expect(request.headers.get('X-Syncular-Scopes')).toBeNull();
        signedDownloads++;
        return new Response(segment.bytes.slice().buffer);
      }
      if (pathname.startsWith('/segments/')) {
        const segment = await handleSegmentDownload(source.ctxFor('actor-1'), {
          segmentId: decodeURIComponent(pathname.slice('/segments/'.length)),
          scopesHeader: request.headers.get('X-Syncular-Scopes') ?? '',
        });
        downloads++;
        return new Response(segment.bytes.slice().buffer, { headers });
      }
      return new Response('not found', { status: 404 });
    },
  });
}, 60000);

afterAll(async () => {
  await server?.stop(true);
  source.storage.db.close();
});

for (const point of [
  'download',
  'before-import',
  'mid-import',
  'after-import',
  'after-checkpoint',
] as const) {
  test(`OPFS reload recovers SQLite image and FTS: ${point}`, async () => {
    // A private test profile survives browser termination. Never use an app profile.
    const profile = await mkdtemp(join(tmpdir(), 'syncular-opfs-recovery-'));
    const context = await chromium.launchPersistentContext(profile);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const beforeDownloads = downloads;
    const beforeImages = images;
    let passed = false;
    const evidence: Record<string, unknown> = {
      point,
      browser: context.browser()?.version(),
      pin,
    };
    try {
      await page.goto(server.url.href);
      await page.evaluate(() => window.opfsTest.open());
      const originalId = await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        await client.sync(); // Acquire the server log epoch before bootstrap.
        await client.subscribe({
          id: 'catalogue',
          table: 'catalogue',
          scopes: { project_id: ['p1'] },
        });
        return client.clientId;
      });
      evidence.before = await page.evaluate(() => window.opfsTest.probe());
      expect(evidence.before).toMatchObject({
        integrity: [{ integrity_check: 'ok' }],
        ftsIntegrity: 'ok',
        ftsCount: 0,
      });
      if (point === 'after-checkpoint') {
        await page.evaluate(async () =>
          (await window.opfsTest.ready).syncUntilIdle(),
        );
      } else {
        const receipt = await page.evaluate(async (point: CrashPoint) => {
          await window.opfsTest.arm(point);
          void (await window.opfsTest.ready).syncUntilIdle().catch((error) => {
            if (
              !(error instanceof Error) ||
              error.message !== 'test.bootstrap_interrupted'
            )
              throw error;
          });
          return window.opfsTest.crash;
        }, point);
        expect(receipt.point).toBe(point);
        evidence.interruption = receipt;
        expect(receipt.bytes).toBeGreaterThan(0);
        expect(receipt.databaseWrite).toBe(point === 'mid-import');
      }
      // Termination interrupts actual SQLite work without a client close RPC.
      const oldWorker = page.workers()[0];
      if (!oldWorker) throw new Error('worker missing before reload');
      const closed = new Promise<void>((resolve) =>
        oldWorker.once('close', () => resolve()),
      );
      const committedBeforeTermination = await page.evaluate(() =>
        window.opfsTest.terminate(),
      );
      evidence.committedBeforeTermination = committedBeforeTermination;
      expect(committedBeforeTermination).toBe(
        point === 'after-import' || point === 'after-checkpoint',
      );
      await page.reload();
      await closed;
      // Recovery must finish in this browser session, including when old
      // worker handles outlive its close event. Production startup retries.
      await page.evaluate(() => window.opfsTest.open());
      evidence.immediateReload = { status: 'ready' };
      const recovered = await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        return {
          id: client.clientId,
          subscription: await client.subscription('catalogue'),
          rows: await client.query(
            'SELECT id, project_id, title FROM catalogue ORDER BY id',
          ),
          probe: await window.opfsTest.probe(),
        };
      });
      evidence.recovered = recovered;
      expect(recovered.id).toBe(originalId);
      expect(recovered.subscription?.cursor).toBe(
        point === 'after-checkpoint' ? pin : -1,
      );
      expect(recovered.subscription?.bootstrapState).toBeUndefined();
      expect(recovered.rows).toEqual(
        point === 'after-import' || point === 'after-checkpoint'
          ? expected
          : [],
      );
      expect(recovered.probe.integrity).toEqual([{ integrity_check: 'ok' }]);
      expect(recovered.probe.journal).toEqual([{ journal_mode: 'delete' }]);
      expect(recovered.probe.synchronous).toEqual([{ synchronous: 2 }]);
      expect(recovered.probe.ftsCount).toBe(recovered.rows.length);
      expect(recovered.probe.ftsIntegrity).toBe('ok');
      const complete = await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        await client.syncUntilIdle();
        return {
          rows: await client.query(
            'SELECT id, project_id, title FROM catalogue ORDER BY id',
          ),
          subscription: await client.subscription('catalogue'),
          probe: await window.opfsTest.probe(),
          pending: await client.pendingCommits(),
        };
      });
      if (point !== 'after-checkpoint') {
        const updates = await page.evaluate(() => window.opfsTest.progress);
        expect(
          updates.some(
            (p) =>
              p.state === 'running' &&
              p.phase === 'download' &&
              p.bytesReceived > 0 &&
              p.bytesReceived < (p.bytesTotal ?? 0),
          ),
        ).toBe(true);
        expect(
          updates.some(
            (p) =>
              p.state === 'running' &&
              p.phase === 'import' &&
              p.rowsProcessed > 0 &&
              p.rowsProcessed < expected.length,
          ),
        ).toBe(true);
        const imported = updates.find(
          (p) => p.state === 'complete' && p.phase === 'import',
        );
        expect(imported?.rowsProcessed).toBe(expected.length);
      }
      expect(complete.rows).toEqual(expected);
      expect(complete.subscription?.cursor).toBe(pin);
      expect(complete.subscription?.bootstrapState).toBeUndefined();
      expect(complete.probe.integrity).toEqual([{ integrity_check: 'ok' }]);
      expect(complete.probe.ftsCount).toBe(expected.length);
      expect(complete.probe.ftsIntegrity).toBe('ok');
      expect(complete.pending).toEqual([]);
      expect(downloads - beforeDownloads).toBe(
        point === 'after-checkpoint' ? 1 : 2,
      );
      expect(images - beforeImages).toBe(point === 'after-checkpoint' ? 1 : 2);
      expect(errors).toEqual([]);
      await page.evaluate(async () => (await window.opfsTest.ready).close());
      passed = true;
    } finally {
      await context.close();
      if (passed) await rm(profile, { recursive: true, force: true });
      else {
        await Bun.write(
          join(profile, 'recovery-test.json'),
          JSON.stringify(evidence, null, 2),
        );
        console.error(`Retained failed OPFS test profile: ${profile}`);
      }
    }
  }, 60000);
}

for (const releaseOwner of [true, false]) {
  test(`OPFS startup contention: owner ${releaseOwner ? 'releases during retry' : 'remains live'}`, async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    try {
      const owner = await context.newPage();
      await owner.goto(server.url.href);
      await owner.evaluate(() => window.opfsTest.open());
      const ownerId = await owner.evaluate(async () => {
        const client = await window.opfsTest.ready;
        await client.mutate([
          {
            table: 'catalogue',
            op: 'upsert',
            values: { id: 'pending-owner', project_id: 'p1', title: 'pending' },
          },
        ]);
        return client.clientId;
      });
      const contender = await context.newPage();
      await contender.goto(server.url.href);
      // Deliberately bypass leader election to exercise the physical OPFS
      // owner, as with independent lock namespaces sharing one directory.
      const opening = contender.evaluate(async () => {
        try {
          await window.opfsTest.open(true);
          return { status: 'ready' };
        } catch (error) {
          if (error instanceof Error && 'code' in error && 'retryable' in error)
            return { code: error.code, retryable: error.retryable };
          throw error;
        }
      });
      await contender.evaluate(() => window.opfsTest.storageBusy);
      if (releaseOwner) {
        await owner.close();
        expect(await opening).toEqual({ status: 'ready' });
      } else {
        expect(await opening).toEqual({
          code: 'client.storage_busy',
          retryable: true,
        });
        expect(
          await owner.evaluate(async () =>
            (await window.opfsTest.ready).query('SELECT id FROM catalogue'),
          ),
        ).toEqual([{ id: 'pending-owner' }]);
        await owner.close();
        await contender.evaluate(() => window.opfsTest.open(true));
      }
      expect(
        await contender.evaluate(async () => {
          const client = await window.opfsTest.ready;
          return {
            id: client.clientId,
            rows: await client.query('SELECT id FROM catalogue'),
            pending: (await client.pendingCommits()).length,
          };
        }),
      ).toEqual({ id: ownerId, rows: [{ id: 'pending-owner' }], pending: 1 });
      await contender.evaluate(async () =>
        (await window.opfsTest.ready).close(),
      );
    } finally {
      await browser.close();
    }
  }, 60000);
}

test('OPFS worker forwards intermediate signed-URL download progress', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const before = signedDownloads;
    await page.goto(`${server.url.href}?signed`);
    await page.evaluate(async () => {
      await window.opfsTest.open();
      const client = await window.opfsTest.ready;
      await client.subscribe({
        id: 'catalogue',
        table: 'catalogue',
        scopes: { project_id: ['p1'] },
      });
      await client.syncUntilIdle();
    });
    const updates = await page.evaluate(() => window.opfsTest.progress);
    expect(signedDownloads - before).toBe(1);
    expect(
      updates.some(
        (p) =>
          p.phase === 'download' &&
          p.bytesReceived > 0 &&
          p.bytesReceived < (p.bytesTotal ?? 0),
      ),
    ).toBe(true);
    expect(updates.at(-1)?.state).toBe('complete');
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          'SELECT count(*) AS n FROM catalogue',
        ),
      ),
    ).toEqual([{ n: expected.length }]);
    await page.evaluate(async () => (await window.opfsTest.ready).close());
  } finally {
    await browser.close();
  }
}, 60000);
