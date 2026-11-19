/**
 * Apply-rows lane: bootstraps and then updates `--rows` rows of a 12-column,
 * two-index table through `applyRowsSegment` into (1) a Bun file replica
 * (WAL, synchronous=FULL) and (2) the production OPFS SAH-pool replica in a
 * worker in headless Chromium. Each lane runs `--runs` times on a fresh
 * replica, without and with a retained failed row on the table. Prints one JSON object; no timing assertions.
 *
 * The `plan` case ignores `--rows`: a plan-shaped round of 87 unit sections
 * over 16 tables (2,799 rows) through a real `SyncClient`, reporting the
 * round's transactions, change batches and (browser) SAH calls. The
 * `planLive` case runs the same round under four live reactive queries whose
 * coverage is the importing units, and adds their reads during the round.
 *
 *   bun run --cwd bench bench:apply-rows [--rows 10000] [--runs 3] [--case plan]
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { BunClientDatabase } from '../../packages/web-client/src/bun-database';
import { runApplyRows, runClientApply, runPlan } from './apply-rows-fixture';

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '10000' },
    runs: { type: 'string', default: '3' },
    'skip-browser': { type: 'boolean', default: false },
    case: { type: 'string' },
  },
});
const rows = Number(values.rows);
const runs = Number(values.runs);
const directory = join(import.meta.dir, '..', '.tmp', 'apply-rows');
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });

const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  runtime: Bun.version,
  rows,
};

// The `client` cases run a real SyncClient over ten rows-segment references;
// `sealed34` and `decrypted34` carry 17 encrypted columns, without and with
// the key.
const allCases = {
  plain: { retained: false },
  retained: { retained: true },
  client12: {
    client: { columns: 12, indexes: 2, segments: 10, encrypted: 0, key: false },
  },
  client41: {
    client: { columns: 41, indexes: 4, segments: 10, encrypted: 0, key: false },
  },
  sealed34: {
    client: {
      columns: 34,
      indexes: 1,
      segments: 10,
      encrypted: 17,
      key: false,
    },
  },
  decrypted34: {
    client: { columns: 34, indexes: 1, segments: 10, encrypted: 17, key: true },
  },
  plan: { plan: true, live: 0 },
  planLive: { plan: true, live: 4 },
};
const cases = Object.fromEntries(
  Object.entries(allCases).filter(
    ([name]) => values.case === undefined || name === values.case,
  ),
);
if (Object.keys(cases).length === 0)
  throw new Error(`unknown --case ${values.case}`);
const bun: Record<string, unknown[]> = {};
for (const [name, input] of Object.entries(cases))
  for (let run = 0; run < runs; run++) {
    const database = new BunClientDatabase(
      join(directory, `replica-${name}-${run}.db`),
    );
    try {
      (bun[name] ??= []).push(
        'plan' in input
          ? await runPlan(database, undefined, input.live)
          : 'client' in input
            ? await runClientApply(
                database,
                input.client.columns,
                input.client.indexes,
                rows,
                input.client.segments,
                input.client.encrypted,
                input.client.key,
              )
            : await runApplyRows(database, rows, input.retained),
      );
    } finally {
      database.close();
    }
  }
report.bunFile = bun;

if (!values['skip-browser']) {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, 'apply-rows-worker.ts')],
    target: 'browser',
    conditions: ['bun'],
    external: ['@sqlite.org/sqlite-wasm'],
  });
  if (!build.success)
    throw new AggregateError(build.logs, 'apply-rows worker build failed');
  const worker = (await build.outputs[0]!.text()).replaceAll(
    /(["'])@sqlite\.org\/sqlite-wasm\1/g,
    '"/vendor/index.mjs"',
  );
  const vendor = dirname(
    Bun.resolveSync(
      '@sqlite.org/sqlite-wasm',
      join(import.meta.dir, '../../packages/web-client'),
    ),
  );
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
    const browser: Record<string, unknown[]> = {};
    for (const [name, input] of Object.entries(cases))
      for (let run = 0; run < runs; run++)
        (browser[name] ??= []).push(
          await page.evaluate(
            (input) =>
              new Promise((resolve, reject) => {
                const worker = new Worker('/worker.js', { type: 'module' });
                worker.onmessage = (event) => {
                  worker.terminate();
                  if (event.data.t === 'done') resolve(event.data.value);
                  else reject(new Error(event.data.message));
                };
                worker.onerror = (event) => reject(new Error(event.message));
                worker.postMessage(input);
              }),
            { ...input, name: `apply-rows-${name}-${run}`, rows },
          ),
        );
    report.browserOpfs = browser;
  } finally {
    await context.close();
    await server.stop(true);
  }
}

rmSync(directory, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
