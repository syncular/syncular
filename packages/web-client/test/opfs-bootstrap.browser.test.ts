import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { decodeMessage } from '@syncular/core';
import {
  handleSegmentDownload,
  compileSchema,
  handleSyncRequest,
  verifySegmentToken,
} from '@syncular/server';
import { makeClient, makeServer, PARTITION } from './helpers';
import {
  OPFS_SCHEMA,
  OPFS_SCOPE_SCHEMAS,
  type CrashPoint,
} from './opfs-bootstrap-fixture';
import type {} from './opfs-bootstrap-page';

const source = makeServer(OPFS_SCHEMA);
source.allowed['actor-1'] = { project_id: ['p1'] };
source.limits.inlineSegmentMaxBytes = 0;
const scopeSource = makeServer(OPFS_SCOPE_SCHEMAS[2]!);
scopeSource.allowed['actor-1'] = { calendar_theatre_id: ['p1'] };
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
let readBarrierReached: (() => void) | undefined;
let releaseReadBarrier: (() => void) | undefined;

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
      if (pathname === '/read-barrier') {
        return new Promise<Response>((resolve) => {
          releaseReadBarrier = () => resolve(new Response('continue'));
          readBarrierReached?.();
        });
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
      if (pathname === '/sync-scope') {
        const response = await handleSyncRequest(
          new Uint8Array(await request.arrayBuffer()),
          {
            ...scopeSource.ctxFor('actor-1'),
            schemaWindow: OPFS_SCOPE_SCHEMAS.slice(1)
              .reverse()
              .map(compileSchema),
          },
        );
        return new Response(response.slice().buffer);
      }
      if (pathname.startsWith('/scope-segments/')) {
        const result = await handleSegmentDownload(
          {
            ...scopeSource.ctxFor('actor-1'),
            schemaWindow: OPFS_SCOPE_SCHEMAS.slice(1)
              .reverse()
              .map(compileSchema),
          },
          {
            segmentId: decodeURIComponent(
              pathname.slice('/scope-segments/'.length),
            ),
            scopesHeader: request.headers.get('X-Syncular-Scopes') ?? '',
          },
        );
        return new Response(result.bytes.slice().buffer);
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
            scopeDigest: segment.record.scopeDigests,
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
  scopeSource.storage.db.close();
});

for (const point of [
  'download',
  'before-import',
  'mid-import',
  'after-chunk',
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
          : point === 'after-chunk'
            ? expected.slice(0, 1024)
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
  test(`OPFS startup contention: owner ${releaseOwner ? 'document closes' : 'explicitly hands over'}`, async () => {
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
      await contender.waitForFunction(async () => {
        const locks = await navigator.locks.query();
        return locks.pending?.some((lock) =>
          lock.name?.startsWith('syncular-opfs/'),
        );
      });
      if (releaseOwner) {
        await owner.close();
      } else {
        expect(
          await owner.evaluate(async () =>
            (await window.opfsTest.ready).query('SELECT id FROM catalogue'),
          ),
        ).toEqual([{ id: 'pending-owner' }]);
        await owner.evaluate(async () => (await window.opfsTest.ready).close());
      }
      expect(await opening).toEqual({ status: 'ready' });
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

test('the default worker serves a queued snapshot between committed image chunks', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const reached = new Promise<void>((resolve) => {
    readBarrierReached = resolve;
  });
  try {
    await page.goto(`${server.url.href}?responsive`);
    await page.evaluate(async () => {
      await window.opfsTest.open();
      const client = await window.opfsTest.ready;
      await client.setWindow({ table: 'catalogue', variable: 'project_id' }, [
        'p1',
      ]);
    });
    const importing = page.evaluate(async () =>
      (await window.opfsTest.ready).syncUntilIdle(),
    );
    await reached;
    // Post the RPC while SQLite is held in the first block's transaction.
    // The read must run after that commit and before the remaining blocks.
    const reading = page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      const result = client.querySnapshot({
        sql: 'SELECT count(*) AS n FROM catalogue',
        coverage: [
          {
            base: { table: 'catalogue', variable: 'project_id' },
            units: ['p1'],
          },
        ],
      });
      document.title = 'read-requested';
      const snapshot = await result;
      return { rows: snapshot.rows, coverage: snapshot.coverage };
    });
    await page.waitForFunction(() => document.title === 'read-requested');
    releaseReadBarrier?.();
    const snapshot = await reading;
    expect(snapshot.rows).toEqual([{ n: 1024 }]);
    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.pending).toHaveLength(1);
    await importing;
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          'SELECT count(*) AS n FROM catalogue',
        ),
      ),
    ).toEqual([{ n: expected.length }]);
    expect(
      (await page.evaluate(() => window.opfsTest.progress)).at(-1)?.state,
    ).toBe('complete');
    await page.evaluate(async () => (await window.opfsTest.ready).close());
  } finally {
    releaseReadBarrier?.();
    readBarrierReached = undefined;
    releaseReadBarrier = undefined;
    await browser.close();
  }
}, 60000);

for (const atCommit of [false, true])
  test(`OPFS storage-full import preserves the first error at ${atCommit ? 'commit' : 'step'} and resumes on the same worker`, async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(server.url.href);
      await page.evaluate(() => window.opfsTest.open());
      const failure = await page.evaluate(async (atCommit) => {
        const client = await window.opfsTest.ready;
        await client.sync();
        await client.subscribe({
          id: 'catalogue',
          table: 'catalogue',
          scopes: { project_id: ['p1'] },
        });
        await window.opfsTest.limitStorage(atCommit ? 1073741823 : 1, atCommit);
        try {
          await client.syncUntilIdle();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            !('details' in error)
          )
            throw error;
          return {
            code: error.code,
            message: error.message,
            details: error.details,
            progress: window.opfsTest.progress.at(-1),
          };
        }
        throw new Error('page-limited import unexpectedly succeeded');
      }, atCommit);
      expect(failure.code).toBe('client.storage_full');
      expect(failure.message).not.toContain('rollback');
      expect(failure.details).toMatchObject({ sqliteCode: 13 });
      if (atCommit)
        expect(failure.details).toMatchObject({
          rollbackFailure: { sqliteCode: 1 },
        });
      expect(failure.progress?.errorCode).toBe('client.storage_full');
      await page.evaluate(async () => {
        await window.opfsTest.limitStorage(1073741823);
        await (await window.opfsTest.ready).syncUntilIdle();
      });
      const count = await page.evaluate(
        async () =>
          (
            await (
              await window.opfsTest.ready
            ).query('SELECT count(*) AS n FROM catalogue')
          )[0]?.n,
      );
      expect(count).toBe(expected.length);
      expect(
        (await page.evaluate(() => window.opfsTest.probe())).ftsIntegrity,
      ).toBe('ok');
    } finally {
      await browser.close();
    }
  }, 60000);

test('OPFS offline atomic patch survives reload and retains second-actor conflict', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'syncular-opfs-conflict-'));
  const context = await chromium.launchPersistentContext(profile);
  const page = await context.newPage();
  const winner = await makeClient(source, {
    clientId: 'opfs-conflict-winner',
    schema: OPFS_SCHEMA,
  });
  try {
    await page.goto(server.url.href);
    await page.evaluate(() => window.opfsTest.open());
    await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      await client.subscribe({
        id: 'catalogue',
        table: 'catalogue',
        scopes: { project_id: ['p1'] },
      });
      await client.syncUntilIdle();
    });
    await context.setOffline(true);
    const missing = await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      let code: string | undefined;
      try {
        await client.mutate([
          {
            op: 'upsert',
            table: 'catalogue',
            values: { id: 'unwritten', project_id: 'p1', title: 'audit' },
          },
          {
            op: 'patch',
            table: 'catalogue',
            values: { id: 'absent-base', title: 'mine' },
          },
        ]);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      return {
        code,
        pending: await client.pendingCommits(),
        rows: await client.query(
          "SELECT id FROM catalogue WHERE id IN ('unwritten', 'absent-base')",
        ),
      };
    });
    expect(missing).toEqual({
      code: 'sync.row_missing',
      pending: [],
      rows: [],
    });
    const commitId = await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      return client.mutate([
        {
          table: 'catalogue',
          op: 'patch',
          values: { id: 'code-00000', title: 'offline mine' },
          baseVersion: 1,
        },
        {
          table: 'catalogue',
          op: 'patch',
          values: { id: 'code-00001', title: 'offline sibling' },
          baseVersion: 1,
        },
        {
          table: 'catalogue',
          op: 'upsert',
          values: {
            id: 'offline-event',
            project_id: 'p1',
            title: 'immutable event',
          },
          baseVersion: 0,
        },
      ]);
    });
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT title FROM catalogue WHERE id = 'code-00000'",
        ),
      ),
    ).toEqual([{ title: 'offline mine' }]);
    // The document comes from the test server while all sync endpoints remain
    // disconnected: reload the worker from a captured browser route.
    await context.setOffline(false);
    await page.route('**/sync', (route) => route.abort());
    await page.reload();
    await page.evaluate(() => window.opfsTest.open());
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT title FROM catalogue WHERE id = 'code-00001'",
        ),
      ),
    ).toEqual([{ title: 'offline sibling' }]);
    winner.client.subscribe({
      id: 'catalogue',
      table: 'catalogue',
      scopes: { project_id: ['p1'] },
    });
    await winner.client.syncUntilIdle();
    winner.client.patch(
      'catalogue',
      'code-00000',
      { title: 'server winner' },
      { baseVersion: 1 },
    );
    await winner.client.syncUntilIdle();
    await page.unroute('**/sync');
    await page.evaluate(async () =>
      (await window.opfsTest.ready).syncUntilIdle(),
    );
    expect(
      await page.evaluate(async (id) => {
        const outcome = await (await window.opfsTest.ready).commitOutcome(id);
        return {
          status: outcome?.status,
          row: outcome?.retainedRows?.find((row) => row.rowId === 'code-00000'),
        };
      }, commitId),
    ).toMatchObject({
      status: 'conflict',
      row: {
        localRow: { title: 'offline mine' },
        serverRow: { title: 'server winner' },
      },
    });
    await page.reload();
    await page.evaluate(() => window.opfsTest.open());
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT title FROM catalogue WHERE id = 'code-00000'",
        ),
      ),
    ).toEqual([{ title: 'offline mine' }]);
    await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      await client.rebootstrapLocalData({ rebootstrapId: 'retained-image' });
      await client.syncUntilIdle();
    });
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT title FROM catalogue WHERE id = 'code-00000'",
        ),
      ),
    ).toEqual([{ title: 'offline mine' }]);
    winner.client.mutate([
      { op: 'delete', table: 'catalogue', rowId: 'code-00000' },
    ]);
    await winner.client.syncUntilIdle();
    await page.evaluate(async () =>
      (await window.opfsTest.ready).syncUntilIdle(),
    );
    await page.reload();
    await page.evaluate(() => window.opfsTest.open());
    expect(
      await page.evaluate(async (id) => {
        const client = await window.opfsTest.ready;
        return {
          rows: await client.query(
            "SELECT id FROM catalogue WHERE id = 'code-00000'",
          ),
          base: (await client.commitOutcome(id))?.retainedRows?.find(
            (row) => row.rowId === 'code-00000',
          )?.serverRow,
          operation: (await client.commitOutcome(id))?.operations?.find(
            (operation) => operation.rowId === 'code-00000',
          )?.values,
        };
      }, commitId),
    ).toEqual({
      rows: [],
      base: null,
      operation: { id: 'code-00000', title: 'offline mine' },
    });
    await page.evaluate(
      async (id) =>
        (await window.opfsTest.ready).resolveCommitOutcome({
          clientCommitId: id,
          resolution: 'resolved_keep_server',
        }),
      commitId,
    );
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT title FROM catalogue WHERE id = 'code-00000'",
        ),
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT id FROM catalogue WHERE id = 'offline-event'",
        ),
      ),
    ).toEqual([]);
    await page.evaluate(async () => (await window.opfsTest.ready).close());
  } finally {
    await winner.client.close();
    winner.db.close();
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 60000);

test('OPFS retains a distinct-ID unique insert without displacing the server winner', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const winner = await makeClient(source, {
    clientId: 'unique-winner',
    schema: OPFS_SCHEMA,
  });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);
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
    const losing = await page.evaluate(async () =>
      (await window.opfsTest.ready).mutate([
        {
          table: 'catalogue',
          op: 'upsert',
          values: {
            id: 'unique-loser',
            project_id: 'p1',
            title: 'unique-publication',
          },
        },
      ]),
    );
    winner.client.mutate([
      {
        table: 'catalogue',
        op: 'upsert',
        values: {
          id: 'unique-winner',
          project_id: 'p1',
          title: 'unique-publication',
        },
      },
    ]);
    await winner.client.syncUntilIdle();
    await page.evaluate(async () => {
      await (await window.opfsTest.ready).syncUntilIdle();
    });
    const expected = {
      rowId: 'unique-loser',
      localRow: { id: 'unique-loser' },
      serverRow: null,
      uniqueConflicts: [
        {
          index: 'catalogue_unique_title',
          columns: ['project_id', 'title'],
          rowId: 'unique-winner',
          serverVersion: 1,
          serverRow: { id: 'unique-winner', title: 'unique-publication' },
        },
      ],
    };
    expect(
      await page.evaluate(
        async (id) => (await window.opfsTest.ready).commitOutcome(id),
        losing,
      ),
    ).toMatchObject({ retainedRows: [expected] });
    await page.evaluate(async () => {
      await (await window.opfsTest.ready).close();
    });
    await page.reload();
    await page.evaluate(async () => {
      await window.opfsTest.open();
      await (await window.opfsTest.ready).syncUntilIdle();
    });
    expect(
      await page.evaluate(
        async (id) => (await window.opfsTest.ready).commitOutcome(id),
        losing,
      ),
    ).toMatchObject({ retainedRows: [expected] });
    await page.evaluate(async (id) => {
      const client = await window.opfsTest.ready;
      const replacement = await client.patch(
        'catalogue',
        'unique-winner',
        { title: 'reviewed-mine' },
        { baseVersion: 1 },
      );
      await client.resolveCommitOutcome({
        clientCommitId: id,
        resolution: 'superseded',
        replacementClientCommitId: replacement,
      });
      await client.syncUntilIdle();
    }, losing);
    expect(
      await page.evaluate(async () =>
        (await window.opfsTest.ready).query(
          "SELECT id, title FROM catalogue WHERE id IN ('unique-winner', 'unique-loser')",
        ),
      ),
    ).toEqual([{ id: 'unique-winner', title: 'reviewed-mine' }]);
    await page.evaluate(async () => {
      await (await window.opfsTest.ready).close();
    });
  } finally {
    await winner.client.close();
    winner.db.close();
    await browser.close();
  }
}, 30000);

test('OPFS 89→90 drops old scopes/windows and reloads after a compatible 91 bump', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(server.url.href);
    await page.evaluate(
      (schema) => window.opfsTest.open(false, schema),
      OPFS_SCOPE_SCHEMAS[0]!,
    );
    const id = await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      await client.subscribe({
        id: 'old',
        table: 'catalogue',
        scopes: { theatre_calendar_id: ['p1'] },
      });
      await client.setWindow(
        { table: 'catalogue', variable: 'theatre_calendar_id' },
        ['p1'],
      );
      await client.mutate([
        {
          table: 'catalogue',
          op: 'upsert',
          values: { id: 'scope-offline', project_id: 'p1', title: 'offline' },
        },
      ]);
      return client.clientId;
    });
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(
      (schema) => window.opfsTest.open(false, schema),
      OPFS_SCOPE_SCHEMAS[1]!,
    );
    expect(
      await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        return {
          id: client.clientId,
          old: await client.subscription('old'),
          window: await client.windowState({
            table: 'catalogue',
            variable: 'theatre_calendar_id',
          }),
          pending: (await client.pendingCommits()).length,
        };
      }),
    ).toEqual({
      id,
      old: undefined,
      window: { units: [], pending: [] },
      pending: 1,
    });
    await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      await client.subscribe({
        id: 'current',
        table: 'catalogue',
        scopes: { calendar_theatre_id: ['p1'] },
      });
      await client.syncUntilIdle();
    });
    const cursor = await page.evaluate(
      async () =>
        (await (await window.opfsTest.ready).subscription('current'))?.cursor,
    );
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(
      (schema) => window.opfsTest.open(false, schema),
      OPFS_SCOPE_SCHEMAS[1]!,
    );
    expect(
      await page.evaluate(
        async () =>
          (await (await window.opfsTest.ready).subscription('current'))?.cursor,
      ),
    ).toBe(cursor);
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(
      (schema) => window.opfsTest.open(false, schema),
      OPFS_SCOPE_SCHEMAS[2]!,
    );
    expect(
      await page.evaluate(
        async () =>
          (await (await window.opfsTest.ready).subscription('current'))?.cursor,
      ),
    ).toBe(-1);
    // A reload immediately after the schema reset, followed by a second reload.
    for (let i = 0; i < 2; i++) {
      await page.reload({ waitUntil: 'load' });
      await page.evaluate(
        (schema) => window.opfsTest.open(false, schema),
        OPFS_SCOPE_SCHEMAS[2]!,
      );
    }
    expect(
      await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        await client.syncUntilIdle();
        return {
          rows: await client.query('SELECT id, title FROM catalogue'),
          pending: (await client.pendingCommits()).length,
          probe: await window.opfsTest.probe(),
        };
      }),
    ).toMatchObject({
      rows: [{ id: 'scope-offline', title: 'offline' }],
      pending: 0,
      probe: { ftsIntegrity: 'ok', integrity: [{ integrity_check: 'ok' }] },
    });
    expect(errors).toEqual([]);
    await page.evaluate(async () => (await window.opfsTest.ready).close());
  } finally {
    await browser.close();
  }
}, 60000);

test('OPFS live second tab follows the leader and promotes after reload', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const owner = await context.newPage();
    await owner.goto(server.url.href);
    await owner.evaluate(() => window.opfsTest.open());
    const follower = await context.newPage();
    await follower.goto(server.url.href);
    await follower.evaluate(() => window.opfsTest.open());
    expect(
      await follower.evaluate(async () => (await window.opfsTest.ready).role),
    ).toBe('follower');
    expect(follower.workers()).toHaveLength(0);
    await follower.evaluate(async () =>
      (await window.opfsTest.ready).mutate([
        {
          table: 'catalogue',
          op: 'upsert',
          values: {
            id: 'through-follower',
            project_id: 'p1',
            title: 'follower',
          },
        },
      ]),
    );
    await owner.reload({ waitUntil: 'load' });
    await follower.waitForFunction(
      async () => (await window.opfsTest.ready).role === 'leader',
    );
    await owner.evaluate(() => window.opfsTest.open());
    expect(
      await owner.evaluate(async () => (await window.opfsTest.ready).role),
    ).toBe('follower');
    expect(
      await owner.evaluate(async () =>
        (await window.opfsTest.ready).query('SELECT id FROM catalogue'),
      ),
    ).toEqual([{ id: 'through-follower' }]);
    await owner.evaluate(async () => (await window.opfsTest.ready).close());
    await follower.evaluate(async () => (await window.opfsTest.ready).close());
  } finally {
    await browser.close();
  }
}, 60000);

test('OPFS pagehide closes handles during bootstrap and survives a double reload', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.evaluate(() => window.opfsTest.open());
    const id = await page.evaluate(async () => {
      const client = await window.opfsTest.ready;
      await client.sync();
      await client.subscribe({
        id: 'catalogue',
        table: 'catalogue',
        scopes: { project_id: ['p1'] },
      });
      await window.opfsTest.arm('after-chunk');
      void client.syncUntilIdle().catch(() => {});
      await window.opfsTest.crash;
      return client.clientId;
    });
    // No close RPC or explicit worker termination: production pagehide owns it.
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => window.opfsTest.open());
    expect(
      await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        return {
          id: client.clientId,
          count: (await client.query('SELECT count(*) AS n FROM catalogue'))[0]
            ?.n,
          probe: await window.opfsTest.probe(),
        };
      }),
    ).toMatchObject({
      id,
      count: 1024,
      probe: { ftsIntegrity: 'ok', integrity: [{ integrity_check: 'ok' }] },
    });
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => window.opfsTest.open());
    expect(
      await page.evaluate(async () => {
        const client = await window.opfsTest.ready;
        await client.syncUntilIdle();
        return {
          id: client.clientId,
          count: (await client.query('SELECT count(*) AS n FROM catalogue'))[0]
            ?.n,
          probe: await window.opfsTest.probe(),
        };
      }),
    ).toMatchObject({
      id,
      count: 4000,
      probe: { ftsIntegrity: 'ok', integrity: [{ integrity_check: 'ok' }] },
    });
    expect(errors).toEqual([]);
    await page.evaluate(async () => (await window.opfsTest.ready).close());
  } finally {
    await browser.close();
  }
}, 60000);
