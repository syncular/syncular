/**
 * SPEC §12 in a real Chromium worker over OPFS: the guide's worker entry
 * opens the authority in the replica's sibling file, rounds reach it until
 * `attachLocalAuthority` moves the rows to an HTTP sync server, and a
 * follower tab reaches the leader's authority.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { handleSegmentDownload, handleSyncRequest } from '@syncular/server';
import { CLIENT_SCHEMA, makeServer, taskValues } from './helpers';
import {
  LOCAL_AUTHORITY_DATABASE,
  type LocalAuthorityProbe,
} from './local-authority-browser-fixture';
import type {} from './local-authority-browser-page';

/**
 * Wraps the vendor sqlite-wasm module so the worker can read the adapter's
 * own SAH pool util (`getFileNames()`), the way opfs-sibling's shim does.
 */
const SQLITE_SHIM = `
import realInit from '/vendor/index.mjs';
export default async function init(config) {
  const sqlite3 = await realInit(config);
  const pools = (globalThis.__sahPools ??= new Map());
  const install = sqlite3.installOpfsSAHPoolVfs;
  sqlite3.installOpfsSAHPoolVfs = async (options = {}) => {
    const util = await install.call(sqlite3, options);
    pools.set(options.directory ?? options.name, util);
    return util;
  };
  return sqlite3;
}
`;

const remote = makeServer();
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      join(import.meta.dir, 'local-authority-browser-page.ts'),
      join(import.meta.dir, 'local-authority-browser-worker.ts'),
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
              '"/local-authority-sqlite.js"',
            ),
          ] as const,
      ),
    ),
  );
  const vendor = dirname(
    Bun.resolveSync('@sqlite.org/sqlite-wasm', import.meta.dir),
  );
  // One origin serves the page, the worker and the remote sync server, so
  // the worker's fetches need no CORS.
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/')
        return new Response(
          '<!doctype html><script type="module" src="/local-authority-browser-page.js"></script>',
          { headers: { 'Content-Type': 'text/html' } },
        );
      const asset = assets.get(pathname);
      if (asset !== undefined)
        return new Response(asset, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      if (pathname === '/local-authority-sqlite.js')
        return new Response(SQLITE_SHIM, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      if (
        [
          '/vendor/index.mjs',
          '/vendor/sqlite3.wasm',
          '/vendor/sqlite3-opfs-async-proxy.js',
        ].includes(pathname)
      )
        return new Response(
          Bun.file(join(vendor, pathname.slice('/vendor/'.length))),
        );
      if (pathname === '/sync' && request.method === 'POST') {
        const response = await handleSyncRequest(
          new Uint8Array(await request.arrayBuffer()),
          remote.ctxFor('actor-1'),
        );
        return new Response(response.slice().buffer);
      }
      if (pathname.startsWith('/segments/')) {
        const segment = await handleSegmentDownload(remote.ctxFor('actor-1'), {
          segmentId: decodeURIComponent(pathname.slice('/segments/'.length)),
          scopesHeader: request.headers.get('X-Syncular-Scopes') ?? '',
        });
        return new Response(segment.bytes.slice().buffer);
      }
      return new Response('not found', { status: 404 });
    },
  });
}, 60000);

afterAll(async () => {
  await server?.stop(true);
  remote.storage.db.close();
});

/** Remote row ids of one project; the remote creates `tasks` at first use. */
const remoteTasks = (projectId: string): string[] =>
  remote.storage.db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE name='tasks'",
    )
    .get()?.n === 0
    ? []
    : remote.storage.db
        .query<{ id: string }, [string]>(
          'SELECT _sync_row_id AS id FROM tasks WHERE project_id = ? ORDER BY id',
        )
        .all(projectId)
        .map((row) => row.id);

const open = (page: Page) =>
  page.evaluate(
    (schema) => window.localAuthorityTest.open(schema),
    CLIENT_SCHEMA,
  );

/** Subscribe to the project, upsert the tasks and drive rounds to idle. */
const write = (page: Page, projectId: string, ids: string[]) =>
  page.evaluate(
    async ({ projectId, values }) => {
      const handle = await window.localAuthorityTest.ready;
      await handle.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: [projectId] },
      });
      await handle.mutate(
        values.map((row) => ({ table: 'tasks', op: 'upsert', values: row })),
      );
      await handle.syncUntilIdle();
    },
    { projectId, values: ids.map((id) => taskValues(id, projectId, id)) },
  );

const state = (page: Page) =>
  page.evaluate(async () =>
    (await window.localAuthorityTest.ready).localAuthorityState(),
  );

const localTasks = (page: Page) =>
  page.evaluate(async () =>
    (
      await (
        await window.localAuthorityTest.ready
      ).query('SELECT id FROM tasks ORDER BY id')
    ).map((row) => String(row.id)),
  );

const probe = (page: Page): Promise<LocalAuthorityProbe> =>
  page.evaluate(() => window.localAuthorityTest.probe());

const close = (page: Page) =>
  page.evaluate(async () => (await window.localAuthorityTest.ready).close());

const replicaFile = `/${LOCAL_AUTHORITY_DATABASE}.db`;
const authorityFile = '/local-authority.db';

test('an OPFS local authority serves rounds, survives reload, and attaches to the HTTP server', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url.href);

    // 1. Rounds drain into the authority in the replica's sibling file.
    expect(await open(page)).toBe('leader');
    expect(await state(page)).toBe('local');
    await write(page, 'p-reload', ['local-1', 'local-2']);
    expect(
      await page.evaluate(async () =>
        (await window.localAuthorityTest.ready).pendingCommits(),
      ),
    ).toEqual([]);
    expect(await localTasks(page)).toEqual(['local-1', 'local-2']);
    expect(remoteTasks('p-reload')).toEqual([]);
    const local = await probe(page);
    expect(local.files).toEqual([replicaFile, authorityFile]);
    expect(local.authorityTables).toContain('tasks');
    expect(local.authorityTables).toContain('sync_local_authority');

    // 2. A new worker reopens the same replica and authority.
    await page.reload({ waitUntil: 'load' });
    expect(await open(page)).toBe('leader');
    expect(await state(page)).toBe('local');
    expect(await localTasks(page)).toEqual(['local-1', 'local-2']);
    await write(page, 'p-reload', ['local-3']);
    expect(await localTasks(page)).toEqual(['local-1', 'local-2', 'local-3']);
    expect(remoteTasks('p-reload')).toEqual([]);

    // 3. Attach uploads the rows the authority kept across the reload; rounds
    // then reach the remote server, and the replica rebinds to it.
    await page.evaluate(async () =>
      (await window.localAuthorityTest.ready).attachLocalAuthority(),
    );
    expect(await state(page)).toBe('attached');
    expect(remoteTasks('p-reload')).toEqual(['local-1', 'local-2', 'local-3']);
    await write(page, 'p-reload', ['remote-4']);
    expect(remoteTasks('p-reload')).toEqual([
      'local-1',
      'local-2',
      'local-3',
      'remote-4',
    ]);
    expect(await localTasks(page)).toEqual([
      'local-1',
      'local-2',
      'local-3',
      'remote-4',
    ]);

    // After another reload the attached authority keeps only its state, and
    // the worker keeps syncing with the remote server.
    await page.reload({ waitUntil: 'load' });
    expect(await open(page)).toBe('leader');
    expect(await state(page)).toBe('attached');
    await write(page, 'p-reload', ['remote-5']);
    expect(remoteTasks('p-reload')).toEqual([
      'local-1',
      'local-2',
      'local-3',
      'remote-4',
      'remote-5',
    ]);
    expect(await localTasks(page)).toEqual([
      'local-1',
      'local-2',
      'local-3',
      'remote-4',
      'remote-5',
    ]);
    const attached = await probe(page);
    expect(attached.files).toEqual([replicaFile, authorityFile]);
    expect(attached.authorityTables).toEqual(['sync_local_authority']);
    expect(errors).toEqual([]);
    await close(page);
  } finally {
    await browser.close();
  }
}, 60000);

test('a follower tab reaches the leader authority, and a handover reopens it', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const owner = await context.newPage();
    const follower = await context.newPage();
    const errors: string[] = [];
    for (const page of [owner, follower])
      page.on('pageerror', (error) => errors.push(error.message));
    await owner.goto(server.url.href);
    expect(await open(owner)).toBe('leader');
    await write(owner, 'p-tabs', ['owner-1']);

    // The follower runs no worker; its calls reach the leader's authority.
    await follower.goto(server.url.href);
    expect(await open(follower)).toBe('follower');
    expect(follower.workers()).toHaveLength(0);
    expect(await state(follower)).toBe('local');
    await write(follower, 'p-tabs', ['follower-2']);
    expect(await localTasks(owner)).toEqual(['follower-2', 'owner-1']);
    expect(remoteTasks('p-tabs')).toEqual([]);

    // The owner's reload hands leadership over: the promoted tab's worker
    // reopens the OPFS replica and the authority.
    await owner.reload({ waitUntil: 'load' });
    await follower.waitForFunction(
      async () => (await window.localAuthorityTest.ready).role === 'leader',
    );
    expect(await state(follower)).toBe('local');
    expect((await probe(follower)).files).toEqual([replicaFile, authorityFile]);
    await write(follower, 'p-tabs', ['leader-3']);
    expect(await localTasks(follower)).toEqual([
      'follower-2',
      'leader-3',
      'owner-1',
    ]);

    // The reloaded owner is now the follower; its attach drives the new
    // leader's authority.
    expect(await open(owner)).toBe('follower');
    await owner.evaluate(async () =>
      (await window.localAuthorityTest.ready).attachLocalAuthority(),
    );
    expect(await state(owner)).toBe('attached');
    expect(await state(follower)).toBe('attached');
    expect(remoteTasks('p-tabs')).toEqual([
      'follower-2',
      'leader-3',
      'owner-1',
    ]);
    await write(owner, 'p-tabs', ['tab-remote-4']);
    expect(remoteTasks('p-tabs')).toEqual([
      'follower-2',
      'leader-3',
      'owner-1',
      'tab-remote-4',
    ]);
    expect((await probe(follower)).authorityTables).toEqual([
      'sync_local_authority',
    ]);
    expect(errors).toEqual([]);
    await close(owner);
    await close(follower);
  } finally {
    await browser.close();
  }
}, 60000);
