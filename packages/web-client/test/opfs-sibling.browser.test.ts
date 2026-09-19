import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import {
  SIBLING_FLOOR,
  SIBLING_NAME,
  SIBLING_REPLICA,
  SIBLING_SECOND,
  type SiblingEvidence,
} from './opfs-sibling-fixture';
import type {} from './opfs-sibling-page';

/**
 * The three vendor files the sqlite-wasm ESM build needs: the module itself,
 * the wasm binary it fetches relative to its own URL, and the async proxy.
 */
const VENDOR_FILES = [
  '/vendor/index.mjs',
  '/vendor/sqlite3.wasm',
  '/vendor/sqlite3-opfs-async-proxy.js',
];

/**
 * Interposed between the built fixtures' `@sqlite.org/sqlite-wasm` specifier
 * (string-rewritten below, the same way the OPFS bootstrap fixture serves the
 * vendor module) and the real vendor module. It changes no behaviour; it only
 * records the pool util the adapter installs, so the test can read the pool's
 * real `getFileNames()`/`getCapacity()`.
 *
 * A second `sqlite3InitModule()` cannot substitute for this: each call makes a
 * distinct sqlite3 instance, and a second instance cannot open a pool
 * directory another instance already owns.
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

let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      join(import.meta.dir, 'opfs-sibling-page.ts'),
      join(import.meta.dir, 'opfs-sibling-worker.ts'),
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
              '"/opfs-sibling-sqlite.js"',
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
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/')
        return new Response(
          '<!doctype html><script type="module" src="/opfs-sibling-page.js"></script>',
          { headers: { 'Content-Type': 'text/html' } },
        );
      const asset = assets.get(pathname);
      if (asset !== undefined)
        return new Response(asset, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      if (pathname === '/opfs-sibling-sqlite.js')
        return new Response(SQLITE_SHIM, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      if (VENDOR_FILES.includes(pathname))
        return new Response(
          Bun.file(join(vendor, pathname.slice('/vendor/'.length))),
        );
      return new Response('not found', { status: 404 });
    },
  });
}, 60000);

afterAll(async () => {
  await server?.stop(true);
});

const sorted = (names: string[]): string[] => [...names].sort();
const replicaFile = `/${SIBLING_REPLICA}.db`;

test('OPFS SAH pool drives the RFC 0005 sibling container', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url.href);
    const evidence: SiblingEvidence = await page.evaluate(() =>
      window.opfsSiblingTest.run(),
    );
    expect(errors).toEqual([]);

    // The adapter's own pool, observed through the real pool util. Default
    // capacity is sqlite-wasm's 6; the replica is the only associated file.
    expect(evidence.capacity).toBe(6);
    expect(evidence.filesAfterReplicaOpen).toEqual([replicaFile]);
    expect(evidence.fileCountAfterReplicaOpen).toBe(1);
    expect(evidence.replicaTables).toEqual(['replica_only']);

    // 2. `siblingExists` is false before creation and creates nothing: the
    // pool's file list is identical across the probes.
    expect(evidence.existsBeforeCreate).toBe(false);
    expect(evidence.existsBeforeSecond).toBe(false);
    expect(evidence.filesAfterProbe).toEqual(evidence.filesAfterReplicaOpen);
    expect(evidence.fileCountAfterProbe).toBe(1);

    // 3. A sibling handle creates a '/'-prefixed pool file that survives the
    // handle's close and reopens with its row intact.
    expect(evidence.existsAfterCreate).toBe(true);
    expect(evidence.existsAfterClose).toBe(true);
    expect(sorted(evidence.filesAfterCreate)).toEqual(
      sorted([replicaFile, `/${SIBLING_NAME}.db`]),
    );
    expect(evidence.siblingTables).toEqual(['sibling_only']);
    expect(evidence.siblingVisibleTables).toEqual(['sibling_only']);
    expect(evidence.row).toEqual([{ id: 1, note: 'container' }]);

    // 4. D3: the replica connection never sees the sibling's table.
    expect(evidence.replicaTablesWhileSiblingOpen).toEqual(['replica_only']);

    // 5. Capacity headroom: replica + one live sibling still leaves room for a
    // second sibling, which is removable again.
    expect(evidence.capacityWhileTwoSiblings).toBe(6);
    expect(evidence.secondSiblingExists).toBe(true);
    expect(sorted(evidence.filesAfterSecondCreate)).toEqual(
      sorted([replicaFile, `/${SIBLING_NAME}.db`, `/${SIBLING_SECOND}.db`]),
    );
    expect(evidence.secondSiblingExistsAfterRemove).toBe(false);
    expect(sorted(evidence.filesAfterSecondRemove)).toEqual(
      sorted([replicaFile, `/${SIBLING_NAME}.db`]),
    );

    // 6. `removeFile` removes the file from the pool, and reopening the name
    // gets an empty database — the bytes, not just the name, are gone.
    expect(evidence.existsAfterRemove).toBe(false);
    expect(evidence.filesAfterRemove).toEqual([replicaFile]);
    expect(evidence.freshTables).toEqual([]);
    expect(evidence.filesAtEnd).toEqual([replicaFile]);
    expect(evidence.fileCountAtEnd).toBe(1);

    // 7. The floor clamps a smaller request up to 3, and those 3 slots carry
    // the replica plus a writable sibling (journal included).
    expect(evidence.floorCapacity).toBe(3);
    expect(evidence.floorRowCount).toBe(1);
    expect(evidence.floorFilesAtEnd).toEqual([`/${SIBLING_FLOOR}.db`]);
  } finally {
    await browser.close();
  }
}, 60000);
