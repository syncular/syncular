import { expect, test } from 'bun:test';
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
  expect(app).toContain('/admin.html?transport=parent');
  expect(app).toContain('syncular-admin-request');
  expect(admin).toContain('<title>Syncular console</title>');
  expect(admin).toContain('syncular-admin-response');
  expect(worker).toContain('admin request requires a route path');
});
