import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  // Resolve the published browser export from an installed tarball, not the
  // workspace's Bun source condition. Also check the generic neutral import.
  const serverDirectory = realpathSync(
    join(directory, 'node_modules/@syncular/server'),
  );
  const manifest: {
    exports: { '.': { browser: string; import: { default: string } } };
  } = JSON.parse(readFileSync(join(serverDirectory, 'package.json'), 'utf8'));
  if (manifest.exports['.'].browser !== manifest.exports['.'].import.default) {
    throw new Error('published neutral browser and import exports differ');
  }
  const browserEntry = join(directory, 'neutral.ts');
  writeFileSync(browserEntry, "export * from '@syncular/server';\n");
  const loaded = new Set<string>();
  for (const entrypoint of [
    browserEntry,
    join(serverDirectory, manifest.exports['.'].import.default),
  ]) {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      conditions: ['browser'],
      minify: false,
      plugins: [
        {
          name: 'record-published-imports',
          setup(build) {
            build.onLoad({ filter: /\.(?:js|ts)$/ }, (args) => {
              loaded.add(args.path);
              return undefined;
            });
          },
        },
      ],
    });
    if (!result.success)
      throw new AggregateError(result.logs, 'published neutral bundle failed');
    for (const output of result.outputs) {
      if (/(?:bun|node):(?:sqlite|fs|path)/.test(await output.text())) {
        throw new Error('published neutral bundle contains runtime builtins');
      }
    }
  }
  if (
    !loaded.has(join(serverDirectory, 'dist/index.js')) ||
    [...loaded].some((path) =>
      /sqlite-(?:bun|node)(?:-driver)?\.js$/.test(path),
    )
  ) {
    throw new Error(
      'published neutral export selected a runtime-specific entry',
    );
  }
  console.log('packed neutral exports bundle unminified for browsers');
  writeFileSync(
    join(directory, 'verify.mjs'),
    `import { openSqliteDatabase } from '@syncular/client/sqlite';
import { buildSqliteImage as rootBuilder, SqliteServerStorage as RootStorage } from '@syncular/server';
import { buildSqliteImage, SqliteServerStorage } from '@syncular/server/sqlite';

if (RootStorage !== SqliteServerStorage || rootBuilder !== buildSqliteImage || typeof buildSqliteImage !== 'function') {
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
