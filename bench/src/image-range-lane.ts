/**
 * Image range lane: seeds the Diego-scale catalogue (67,302 codes and 87,267
 * relations at scale 1, about 350 MB of images) into a `SqliteServerStorage`
 * and serves it through the real pull path (`handleSyncRequest` with
 * `buildSqliteImage`, `MemorySegmentStore`, production resume tokens). A
 * `SyncClient` in headless Chromium bootstraps it into the production OPFS
 * SAH-pool replica on a persistent profile, once per run on a fresh profile.
 *
 *   bun run --cwd bench bench:image-range [--config before|after] [--runs 2] [--scale 1]
 *     [--units 7] [--fts] [--ephemeral] [--max-pages 1]
 *     [--browser firefox] [--cpu-throttle 6] [--sync-delay-ms 200] [--write-delay-ms 2]
 *
 * `before` lifts `maxImageSegmentBytes` to 4 GiB (one image per table), `after`
 * keeps the 32 MiB default.
 * `--units` splits the rows into release units (see below), `--fts` adds an FTS5
 * projection on the codes, `--ephemeral` runs in an ephemeral context (OPFS in
 * memory, like a private window), and `--max-pages` limits the image ranges per
 * unit and round. `firstUnitMs` is when the first unit finished, `readLagMs` how
 * late a 50 ms timer in the worker ran during the import.
 * `--browser` picks Chromium (default) or Firefox. `--cpu-throttle` slows
 * the renderer processes by that factor (persistent Chromium only). `--sync-delay-ms` holds every VFS `xSync` (a
 * `FileSystemSyncAccessHandle.flush()`) that long on top of its own time, the
 * way a slow disk or a scanning antivirus stretches a flush. `--write-delay-ms`
 * holds every VFS `xWrite` that long, the way such a disk stretches each write.
 * `perImage` lists each image apply: rows, chunks, the largest chunk, the
 * write and post-callback time of its chunks, its wall time from the first progress
 * to the last chunk, the time between chunk commits outside them, and the
 * download time of its segment; `vfs` totals the `xWrite` and `xSync` calls
 * inside `COMMIT` and outside it. `stages` splits the post-callback time
 * into bookkeeping (from the callback's end to `COMMIT`), `COMMIT`, and
 * publication (after `COMMIT`), summed over the import's transactions.
 * The first run builds the images; later runs find them in the segment store,
 * so `serverSyncMs` shows the build cost.
 * Memory, sampled during the import only (`measureUserAgentSpecificMemory`
 * answers too late to sample a multi-second import, so it is not used):
 *  - `rendererRssPeakMiB`: peak resident size of the largest Chromium
 *    renderer process (page, worker, downloaded buffers and wasm memory),
 *    polled with `ps` every 50 ms; `rendererRssStartMiB` is its first sample;
 *  - `wasmHeapMiB`: the sqlite-wasm heap after the import. It never shrinks,
 *    so this is the worker's wasm peak.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox } from 'playwright';
import { encodeRow } from '../../packages/core/src/index';
import { createSyncularHono } from '../../packages/server-hono/src/index';
import {
  compileSchema,
  MemorySegmentStore,
  SqliteServerStorage,
  type ServerSchema,
  type SyncRequestContext,
} from '../../packages/server/src/index-bun';
import { buildSqliteImage } from '../../packages/server/src/sqlite-bun';
import { IMAGE_SCHEMA } from './image-import-fixture';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'after' },
    ephemeral: { type: 'boolean', default: false },
    fts: { type: 'boolean', default: false },
    units: { type: 'string', default: '1' },
    'max-image-mib': { type: 'string' },
    'max-pages': { type: 'string' },
    runs: { type: 'string', default: '2' },
    scale: { type: 'string', default: '1' },
    browser: { type: 'string', default: 'chromium' },
    'cpu-throttle': { type: 'string', default: '1' },
    'sync-delay-ms': { type: 'string', default: '0' },
    'write-delay-ms': { type: 'string', default: '0' },
  },
});
if (values.config !== 'before' && values.config !== 'after')
  throw new Error('--config must be before or after');
if (values.browser !== 'chromium' && values.browser !== 'firefox')
  throw new Error('--browser must be chromium or firefox');
const engine = values.browser === 'firefox' ? firefox : chromium;
const cpuThrottle = Number(values['cpu-throttle']);
const syncDelayMs = Number(values['sync-delay-ms']);
const writeDelayMs = Number(values['write-delay-ms']);
if (cpuThrottle !== 1 && (values.browser !== 'chromium' || values.ephemeral))
  throw new Error('--cpu-throttle needs a persistent Chromium context');
const scale = Number(values.scale);
if (!(scale > 0)) throw new Error('--scale must be positive');

const hex = (n: number) => n.toString(16).padStart(8, '0');
const codeId = (x: number) => `c${hex((x * 2654435761) % 4294967296)}`;
const codeRows = Math.round(67_302 * scale);
const relationRows = Math.round(87_267 * scale);
const units = Number(values.units);
// With more than one unit, each release of `set-1` is a unit (scopes
// `catalogue_set_id` and `release_id`), codes
// spread over the releases and every relation belongs to the first one. The
// client loads the first release, then the rest, the way a web app loads the
// visited catalogue edition first: every later unit clears an empty relations
// scope while the table holds all relations, through indexes that lead with
// `catalogue_set_id`.
const variable = units > 1 ? 'release_id' : 'catalogue_set_id';
const unitScopes =
  units > 1 ? ['set:{catalogue_set_id}', 'release:{release_id}'] : undefined;
const unitValues =
  units > 1
    ? Array.from({ length: units }, (_, i) => `rel-${i + 1}`)
    : ['set-1'];
const release = (x: number) => (units > 1 ? `rel-${(x % units) + 1}` : 'rel-1');
const scope = (releaseId: string) =>
  units > 1
    ? { catalogue_set_id: 'set-1', release_id: releaseId }
    : { catalogue_set_id: 'set-1' };

const schema: ServerSchema = {
  version: IMAGE_SCHEMA.version,
  tables: IMAGE_SCHEMA.tables.map(({ name, columns, primaryKey, scopes }) => ({
    name,
    columns,
    primaryKey,
    scopes: unitScopes ?? scopes,
  })),
};
const storage = new SqliteServerStorage();
await storage.ensureSchema(compileSchema(schema));
const tx = await storage.begin('bench');
const [codes, relations] = schema.tables;
for (let x = 0; x < codeRows; x++)
  await tx.upsertRow('codes', {
    rowId: codeId(x),
    serverVersion: 1,
    scopes: scope(release(x)),
    payload: encodeRow(codes!.columns, [
      codeId(x),
      'set-1',
      release(x),
      'ops',
      `${Math.floor(x / 1000)}-${x % 1000}.${x % 7}`,
      x % 50 === 0 ? null : codeId(Math.floor(x / 50) * 50),
      String(x).padStart(10, '0'),
      `Code ${x} title text`,
      `Description ${x} ${'d'.repeat(200)}`,
      't'.repeat(1_750),
      x % 3 !== 0,
    ]),
  });
for (let x = 0; x < relationRows; x++) {
  const id = `r${hex((x * 2246822519) % 4294967296)}`;
  await tx.upsertRow('relations', {
    rowId: id,
    serverVersion: 1,
    scopes: scope('rel-1'),
    payload: encodeRow(relations!.columns, [
      id,
      'set-1',
      'rel-1',
      codeId(((x * 7) % 67_302) % 4294967296),
      ['see', 'excl', 'incl'][x % 3]!,
      codeId(((x * 13) % 67_302) % 4294967296),
      `note ${x}`,
      x % 17,
      'm'.repeat(700),
    ]),
  });
}
await tx.commit();

const config: SyncRequestContext = {
  sqliteImageBuilder: buildSqliteImage,
  partition: 'bench',
  actorId: 'bench-actor',
  schema,
  storage,
  segments: new MemorySegmentStore(),
  resolveScopes: () => ({
    catalogue_set_id: ['set-1'],
    [variable]: unitValues,
  }),
  ...(values.config === 'before'
    ? { limits: { maxImageSegmentBytes: 4 * 1024 ** 3 } }
    : values['max-image-mib'] === undefined
      ? {}
      : {
          limits: {
            maxImageSegmentBytes: Number(values['max-image-mib']) * 1024 ** 2,
          },
        }),
};
const hono = createSyncularHono({
  config,
  authenticate: async () => ({ actorId: 'bench-actor', partition: 'bench' }),
});

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, 'image-range-worker.ts')],
  target: 'browser',
  conditions: ['bun'],
  external: ['@sqlite.org/sqlite-wasm'],
});
if (!build.success)
  throw new AggregateError(build.logs, 'image range worker build failed');
const worker = (await build.outputs[0]!.text()).replaceAll(
  /(["'])@sqlite\.org\/sqlite-wasm\1/g,
  '"/sqlite-shim.js"',
);
const vendor = dirname(
  Bun.resolveSync(
    '@sqlite.org/sqlite-wasm',
    join(import.meta.dir, '../../packages/web-client'),
  ),
);
// Exposes the module so the worker can read the wasm heap size, and wraps
// the xWrite and xSync of every VFS file (replica and journal) to count them
// per stage and to hold them writeDelayMs and syncDelayMs longer.
const shim = `
import realInit from '/vendor/index.mjs';
export default async function init(config) {
  const sqlite3 = await realInit(config);
  globalThis.__sqlite3 = sqlite3;
  const stage = () => ({ writeMs: 0, writeCalls: 0, writeBytes: 0, syncMs: 0, syncCalls: 0 });
  const totals = (globalThis.__vfs = { commit: false, inCommit: stage(), outside: stage() });
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
      finally {
        while (performance.now() - started < ${writeDelayMs});
        const into = totals.commit ? totals.inCommit : totals.outside;
        into.writeMs += performance.now() - started;
        into.writeCalls++;
        into.writeBytes += bytes;
      }
    });
    methods.installMethod('xSync', (file, flags) => {
      const started = performance.now();
      try { return sync(file, flags); }
      finally {
        while (performance.now() - started < ${syncDelayMs});
        const into = totals.commit ? totals.inCommit : totals.outside;
        into.syncMs += performance.now() - started;
        into.syncCalls++;
      }
    });
    return methods;
  };
  return sqlite3;
}`;

let serverSyncMs = 0;
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const text = (body: string, type: string) =>
      new Response(body, {
        headers: { 'Content-Type': type, ...isolation },
      });
    if (pathname === '/') return text('<!doctype html>', 'text/html');
    if (pathname === '/worker.js') return text(worker, 'text/javascript');
    if (pathname === '/sqlite-shim.js') return text(shim, 'text/javascript');
    if (pathname.startsWith('/vendor/'))
      return new Response(
        Bun.file(join(vendor, pathname.slice('/vendor/'.length))),
        { headers: isolation },
      );
    const started = performance.now();
    const response = await hono.fetch(request);
    if (pathname === '/sync') serverSyncMs += performance.now() - started;
    return new Response(response.body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), ...isolation },
    });
  },
});

const directory = join(import.meta.dir, '..', '.tmp', 'image-range');
const MIB = 1024 * 1024;
const runs: unknown[] = [];
for (let run = 1; run <= Number(values.runs); run++) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const profile = join(directory, 'profile');
  // An ephemeral context keeps OPFS in memory, like a private window.
  const browser = values.ephemeral ? await engine.launch() : undefined;
  const context = browser
    ? await browser.newContext()
    : await engine.launchPersistentContext(profile);
  let importing = false;
  let rssStart: number | undefined;
  let rssPeak = 0;
  const renderers = new Set<number>();
  // DevTools CPU throttling covers pages, not dedicated workers, so the lane
  // stops the renderer processes for (rate - 1) * 10 ms after every 10 ms.
  const throttling = { on: cpuThrottle !== 1 };
  const throttle = (async () => {
    while (throttling.on) {
      await Bun.sleep(10);
      const stopped = [...renderers];
      for (const pid of stopped) process.kill(pid, 'SIGSTOP');
      await Bun.sleep((cpuThrottle - 1) * 10);
      for (const pid of stopped) process.kill(pid, 'SIGCONT');
    }
  })();
  const poll = setInterval(async () => {
    if (!importing && !throttling.on) return;
    const ps = Bun.spawn(['ps', '-axo', 'pid=,ppid=,rss=,command='], {
      stdout: 'pipe',
    });
    const table = (await new Response(ps.stdout).text())
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
      .filter((match) => match !== null);
    // Renderer command lines omit the profile; their parent is the browser.
    const browser = table.find(
      (m) => m[4]!.includes(profile) && !m[4]!.includes('--type='),
    )?.[1];
    for (const m of table)
      if (m[2] === browser && m[4]!.includes('--type=renderer')) {
        renderers.add(Number(m[1]));
        if (!importing) continue;
        rssStart ??= Number(m[3]) / 1024;
        rssPeak = Math.max(rssPeak, Number(m[3]) / 1024);
      }
  }, 50);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.exposeFunction('markImporting', (value: boolean) => {
      importing = value;
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    serverSyncMs = 0;
    const maxSnapshotPages =
      values['max-pages'] === undefined
        ? undefined
        : Number(values['max-pages']);
    const value = await page.evaluate(
      (options) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const worker = new Worker('/worker.js', { type: 'module' });
          worker.onmessage = (event) => {
            if (event.data.t === 'phase')
              (
                window as unknown as { markImporting(value: boolean): void }
              ).markImporting(event.data.phase === 'import');
            else if (event.data.t === 'done') {
              worker.terminate();
              resolve(event.data.value);
            } else reject(new Error(event.data.message));
          };
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage(options);
        }),
      { maxSnapshotPages, variable, unitValues, unitScopes, fts: values.fts },
    );
    const { wasmHeapBytes, ...rest } = value;
    runs.push({
      run,
      ...rest,
      serverSyncMs: Math.round(serverSyncMs),
      rendererRssStartMiB: Math.round(rssStart ?? 0),
      rendererRssPeakMiB: Math.round(rssPeak),
      wasmHeapMiB: Math.round(Number(wasmHeapBytes) / MIB),
    });
  } finally {
    clearInterval(poll);
    throttling.on = false;
    await throttle;
    await context.close();
    await browser?.close();
  }
}
await server.stop(true);
rmSync(directory, { recursive: true, force: true });
console.log(
  JSON.stringify(
    {
      config: values.config,
      browser: values.browser,
      cpuThrottle,
      syncDelayMs,
      writeDelayMs,
      units,
      ephemeral: values.ephemeral,
      fts: values.fts,
      maxSnapshotPages: values['max-pages'],
      scale,
      date: new Date().toISOString(),
      runs,
    },
    null,
    2,
  ),
);
