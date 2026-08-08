import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'syncular-runtime-packages-'));

async function run(command: string[], cwd = root): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}`);
}

try {
  for (const [packageDirectory, filename] of [
    ['core', 'core.tgz'],
    ['server', 'server.tgz'],
    ['web-client', 'client.tgz'],
  ] as const) {
    await run(
      ['bun', 'pm', 'pack', '--quiet', '--filename', join(directory, filename)],
      join(root, 'packages', packageDirectory),
    );
  }
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await run(
    [
      'npm',
      'install',
      '--ignore-scripts',
      './core.tgz',
      './server.tgz',
      './client.tgz',
    ],
    directory,
  );
  writeFileSync(
    join(directory, 'verify.mjs'),
    `import { openSqliteDatabase } from '@syncular/client/sqlite';
import { SqliteServerStorage as RootStorage } from '@syncular/server';
import { SqliteServerStorage } from '@syncular/server/sqlite';

if (RootStorage !== SqliteServerStorage) {
  throw new Error('server root and sqlite export selected different adapters');
}
const local = openSqliteDatabase(':memory:');
local.exec('CREATE TABLE checks (id TEXT PRIMARY KEY, value INTEGER)');
local.exec('INSERT INTO checks VALUES (?, ?)', ['runtime', true]);
if (local.query('SELECT value FROM checks')[0]?.value !== 1) {
  throw new Error('client SQLite query failed');
}
local.close();

const server = new SqliteServerStorage(':memory:');
if (await server.getMaxCommitSeq('runtime') !== 0) {
  throw new Error('server SQLite query failed');
}
server.db.close();
console.log('packed SQLite exports pass under ' + (globalThis.Bun ? 'Bun' : 'Node'));
`,
  );
  await run(['node', './verify.mjs'], directory);
  await run(['bun', './verify.mjs'], directory);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
