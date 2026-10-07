import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('static bundle includes the graphical worker-backed admin console', async () => {
  const build = Bun.spawn(
    [process.execPath, 'run', join(import.meta.dir, 'build-static.ts')],
    {
      cwd: join(import.meta.dir, '..'),
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  const [exitCode, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });

  const [app, admin, worker] = await Promise.all([
    Bun.file(join(import.meta.dir, '..', 'dist', 'app.js')).text(),
    Bun.file(join(import.meta.dir, '..', 'dist', 'admin.html')).text(),
    Bun.file(join(import.meta.dir, '..', 'dist', 'server-worker.js')).text(),
  ]);
  expect(app).toContain('admin.html?transport=parent');
  expect(app).toContain('syncular-admin-request');
  expect(admin).toContain('<title>Syncular console</title>');
  expect(admin).toContain('syncular-admin-response');
  expect(worker).toContain('admin request requires a route path');
});

test('static bundle uses only page-relative URLs, so it serves under any base path', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'demo-base-'));
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        'run',
        join(import.meta.dir, 'build-static.ts'),
        outDir,
      ],
      { cwd: join(import.meta.dir, '..'), stdout: 'ignore', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });

    const [index, app, worker] = await Promise.all([
      Bun.file(join(outDir, 'index.html')).text(),
      Bun.file(join(outDir, 'app.js')).text(),
      Bun.file(join(outDir, 'server-worker.js')).text(),
    ]);
    // Root-absolute attribute and CSS URLs would break under /demo/.
    expect(index.match(/(?:href|src)="\/[^/"]/g)).toBeNull();
    expect(index.match(/url\(['"]?\/[^/]/g)).toBeNull();
    expect(app.match(/new Worker\(["'`]\//g)).toBeNull();
    for (const bundle of [app, worker]) {
      expect(bundle).toContain('./vendor/sqlite-wasm/index.mjs');
      expect(bundle).not.toContain('"/vendor/');
    }
    expect(app).toContain('new Worker("server-worker.js"');
    // Canonical and social URLs name the public location.
    expect(index).toContain('https://syncular.dev/demo/social-card.png');
    expect(index).not.toContain('demo.syncular.dev');
    for (const file of [
      'vendor/sqlite-wasm/sqlite3.wasm',
      'fonts/plex-mono-400.woff2',
      'favicon.svg',
    ]) {
      expect(await Bun.file(join(outDir, file)).exists()).toBe(true);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
