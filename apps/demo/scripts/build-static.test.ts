import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('static bundle retains the Syncular browser debugging registry', async () => {
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

  const app = await Bun.file(
    join(import.meta.dir, '..', 'dist', 'app.js'),
  ).text();
  expect(app).toContain('__SYNCULAR__');
  expect(app).toContain('Syncular debug console ready');
  expect(app).not.toMatch(/NODE_ENV\s*===\s*["']production/);
});
