/**
 * Image import lane: generates two catalogue images of the reported size and
 * bootstraps them through a real `SyncClient` into (1) a Bun file replica
 * (WAL, synchronous=FULL) and (2) the production OPFS SAH-pool replica in
 * headless Chromium on a persistent profile. Prints one JSON object.
 *
 *   bun run --cwd bench bench:image-import [--scale 1] [--skip-browser]
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { BunClientDatabase } from '../../packages/web-client/src/bun-database';
import {
  IMAGE_SCOPE_DIGEST,
  IMAGE_TABLES,
  runImageImport,
  type LaneImage,
} from './image-import-fixture';

const { values } = parseArgs({
  options: {
    scale: { type: 'string', default: '1' },
    'skip-browser': { type: 'boolean', default: false },
    'skip-bun': { type: 'boolean', default: false },
  },
});
const scale = Number(values.scale);
if (!(scale > 0)) throw new Error('--scale must be positive');

// 67,302 codes and 87,267 relations decode to 286.8 MB in the report; these
// widths land within a few percent of that at scale 1.
const shapes = [
  { table: 'codes', rows: Math.round(67_302 * scale), fill: 1_750 },
  { table: 'relations', rows: Math.round(87_267 * scale), fill: 700 },
] as const;

const digest = await IMAGE_SCOPE_DIGEST();
const images: LaneImage[] = shapes.map(({ table, rows, fill }) => {
  const image = new Database(':memory:');
  try {
    image.run(
      `CREATE TABLE ${table}(${IMAGE_TABLES[table].ddl}, _syncular_version INTEGER NOT NULL)`,
    );
    image.run(
      `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x+1<${rows}) INSERT INTO ${table} SELECT ${IMAGE_TABLES[table].select.replaceAll('$fill', String(fill))}, 1 FROM n`,
    );
    image.run(
      'CREATE TABLE _syncular_segment(format INTEGER NOT NULL, "table" TEXT NOT NULL, "schemaVersion" INTEGER NOT NULL, "asOfCommitSeq" INTEGER NOT NULL, "scopeDigest" TEXT NOT NULL, "rowCount" INTEGER NOT NULL)',
    );
    image.run('INSERT INTO _syncular_segment VALUES (1,?,1,1,?,?)', [
      table,
      digest,
      rows,
    ]);
    image.run('VACUUM');
    const bytes = image.serialize();
    return {
      table,
      rows,
      bytes,
      segmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  } finally {
    image.close();
  }
});

const directory = join(import.meta.dir, '..', '.tmp', 'image-import');
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);

const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  runtime: Bun.version,
  images: images.map(({ table, rows, bytes }) => ({
    table,
    rows,
    bytes: bytes.byteLength,
  })),
};

if (!values['skip-bun']) {
  const path = join(directory, 'replica.db');
  const database = new BunClientDatabase(path);
  try {
    const result = await runImageImport(database, images);
    report.bunFile = {
      ...result,
      walBytes: size(`${path}-wal`),
      databaseBytes: size(path),
    };
  } finally {
    database.close();
  }
}

if (!values['skip-browser']) {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'image-import-worker.ts')],
    target: 'browser',
    conditions: ['bun'],
    external: ['@sqlite.org/sqlite-wasm'],
  });
  if (!build.success)
    throw new AggregateError(build.logs, 'image lane worker build failed');
  const worker = (await build.outputs[0]!.text()).replaceAll(
    /(["'])@sqlite\.org\/sqlite-wasm\1/g,
    '"/vfs-shim.js"',
  );
  const vendor = dirname(
    Bun.resolveSync(
      '@sqlite.org/sqlite-wasm',
      join(import.meta.dir, '../../packages/web-client'),
    ),
  );
  // Times the SAH-pool VFS xWrite/xSync of every file (replica and journal)
  // by wrapping the I/O method table the adapter itself borrows.
  const shim = `
import realInit from '/vendor/index.mjs';
export default async function init(config) {
  const sqlite3 = await realInit(config);
  const totals = (globalThis.__vfs = {
    xWrite: { ms: 0, calls: 0, bytes: 0 },
    xSync: { ms: 0, calls: 0 },
  });
  const Methods = sqlite3.capi.sqlite3_io_methods;
  const wrapped = new Set();
  sqlite3.capi.sqlite3_io_methods = function (pointer) {
    const methods = new Methods(pointer);
    if (wrapped.has(pointer)) return methods;
    wrapped.add(pointer);
    const write = sqlite3.wasm.functionEntry(methods.$xWrite);
    const sync = sqlite3.wasm.functionEntry(methods.$xSync);
    methods.installMethod('xWrite', (file, source, bytes, offset) => {
      const started = performance.now();
      try { return write(file, source, bytes, offset); }
      finally { totals.xWrite.ms += performance.now() - started; totals.xWrite.calls++; totals.xWrite.bytes += bytes; }
    });
    methods.installMethod('xSync', (file, flags) => {
      const started = performance.now();
      try { return sync(file, flags); }
      finally { totals.xSync.ms += performance.now() - started; totals.xSync.calls++; }
    });
    return methods;
  };
  return sqlite3;
}`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/')
        return new Response('<!doctype html>', {
          headers: { 'Content-Type': 'text/html' },
        });
      if (pathname === '/worker.js')
        return new Response(worker, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      if (pathname === '/vfs-shim.js')
        return new Response(shim, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      const image = images.find(
        (candidate) => pathname === `/image/${candidate.table}`,
      );
      if (image !== undefined) return new Response(image.bytes.slice());
      if (pathname.startsWith('/vendor/'))
        return new Response(
          Bun.file(join(vendor, pathname.slice('/vendor/'.length))),
        );
      return new Response('not found', { status: 404 });
    },
  });
  const context = await chromium.launchPersistentContext(
    join(directory, 'profile'),
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`http://127.0.0.1:${server.port}/`);
    report.browserOpfs = await page.evaluate(
      (metadata) =>
        new Promise((resolve, reject) => {
          const worker = new Worker('/worker.js', { type: 'module' });
          worker.onmessage = (event) => {
            worker.terminate();
            if (event.data.t === 'done') resolve(event.data.value);
            else reject(new Error(event.data.message));
          };
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ images: metadata });
        }),
      images.map(({ table, rows, segmentId }) => ({ table, rows, segmentId })),
    );
  } finally {
    await context.close();
    await server.stop(true);
  }
}

rmSync(directory, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
