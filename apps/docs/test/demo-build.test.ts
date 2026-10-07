import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Runs against the output of `bun run build`; the root gate builds first.
const demoDir = join(import.meta.dir, '../dist/demo');
const built = existsSync(join(demoDir, 'index.html'));

test.skipIf(!built)('the docs build emits the demo under dist/demo/', () => {
  for (const file of [
    'index.html',
    'admin.html',
    'app.js',
    'server-worker.js',
    'vendor/sqlite-wasm/index.mjs',
    'vendor/sqlite-wasm/sqlite3.wasm',
  ]) {
    expect({ file, exists: existsSync(join(demoDir, file)) }).toEqual({
      file,
      exists: true,
    });
  }
});

test.skipIf(!built)('no root-absolute URL leaks out of the demo', () => {
  const index = readFileSync(join(demoDir, 'index.html'), 'utf8');
  const app = readFileSync(join(demoDir, 'app.js'), 'utf8');
  const worker = readFileSync(join(demoDir, 'server-worker.js'), 'utf8');
  expect(index.match(/(?:href|src)="\/[^/"]/g)).toBeNull();
  expect(index.match(/url\(['"]?\/[^/]/g)).toBeNull();
  expect(app.match(/new Worker\(["'`]\//g)).toBeNull();
  expect(app).not.toContain('"/vendor/');
  expect(worker).not.toContain('"/vendor/');
  expect(index).toContain(
    '<link rel="canonical" href="https://syncular.dev/demo/" />',
  );
});

test('the docs worker counts demo page views in their own section and the sitemap lists the demo', () => {
  const worker = readFileSync(
    join(import.meta.dir, '../src/worker.ts'),
    'utf8',
  );
  expect(worker).toContain("return 'demo'");
  const assets = readFileSync(
    join(import.meta.dir, '../scripts/agent-assets.mjs'),
    'utf8',
  );
  expect(assets).toContain('`${site}/demo/`');
});
