#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Options {
  version: string;
  crateVersion: string;
  workDir: string;
  npmRegistry: string;
  skipJs: boolean;
  skipRust: boolean;
  keep: boolean;
}

const bunBin = process.execPath;

function usage(): string {
  return `usage: bun scripts/post-publish-install-smokes.ts --version <published-version> [options]

options:
  --crate-version <version>   Rust crate version when it differs from npm version
  --work-dir <path>           Fresh-project workspace (default: .context/post-publish-install-smokes/<version>)
  --npm-registry <url>        npm registry (default: https://registry.npmjs.org/)
  --skip-js                   Skip the fresh JS app smoke
  --skip-rust                 Skip the fresh Rust app smoke
  --keep                      Keep the smoke workspace after a successful run

environment:
  SYNCULAR_POST_PUBLISH_JS_RUNTIME_SMOKE=1|0
                              Force-enable or disable the JS WASM runtime smoke.
                              By default it is skipped on Linux because Bun's
                              worker WASM loader is not stable there yet.
`;
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  arg: string,
  name: string
): { value: string; nextIndex: number } | null {
  if (arg === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`${name} requires a value`);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (value.length === 0) {
      throw new Error(`${name} requires a value`);
    }
    return { value, nextIndex: index };
  }

  return null;
}

function parseArgs(argv: readonly string[]): Options {
  let version = process.env.SYNCULAR_RELEASE_VERSION ?? '';
  let crateVersion = process.env.SYNCULAR_CRATE_RELEASE_VERSION ?? '';
  let workDir = '';
  let npmRegistry =
    process.env.SYNCULAR_NPM_REGISTRY ?? 'https://registry.npmjs.org/';
  let skipJs = false;
  let skipRust = false;
  let keep = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--skip-js') {
      skipJs = true;
      continue;
    }

    if (arg === '--skip-rust') {
      skipRust = true;
      continue;
    }

    if (arg === '--keep') {
      keep = true;
      continue;
    }

    const versionOption = readOptionValue(argv, index, arg, '--version');
    if (versionOption) {
      version = versionOption.value;
      index = versionOption.nextIndex;
      continue;
    }

    const crateVersionOption = readOptionValue(
      argv,
      index,
      arg,
      '--crate-version'
    );
    if (crateVersionOption) {
      crateVersion = crateVersionOption.value;
      index = crateVersionOption.nextIndex;
      continue;
    }

    const workDirOption = readOptionValue(argv, index, arg, '--work-dir');
    if (workDirOption) {
      workDir = workDirOption.value;
      index = workDirOption.nextIndex;
      continue;
    }

    const npmRegistryOption = readOptionValue(
      argv,
      index,
      arg,
      '--npm-registry'
    );
    if (npmRegistryOption) {
      npmRegistry = npmRegistryOption.value;
      index = npmRegistryOption.nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  if (!version) {
    throw new Error(
      `Missing --version. This smoke must run against an exact published version.\n\n${usage()}`
    );
  }

  return {
    version,
    crateVersion: crateVersion || version,
    workDir: resolve(
      workDir || `.context/post-publish-install-smokes/${version}`
    ),
    npmRegistry,
    skipJs,
    skipRust,
    keep,
  };
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> }
): Promise<void> {
  console.log(`$ ${[command, ...args].join(' ')}`);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

function atVersion(name: string, version: string): string {
  return `${name}@${version}`;
}

function codegenBinaryPath(root: string): string {
  return join(
    root,
    'bin',
    process.platform === 'win32' ? 'syncular-codegen.exe' : 'syncular-codegen'
  );
}

function readBooleanEnv(name: string): boolean | null {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be one of 1, true, yes, on, 0, false, no, off`);
}

function jsRuntimeSmokeDecision(): { run: boolean; reason?: string } {
  const configured = readBooleanEnv('SYNCULAR_POST_PUBLISH_JS_RUNTIME_SMOKE');
  if (configured !== null) {
    return {
      run: configured,
      reason: configured
        ? undefined
        : 'disabled by SYNCULAR_POST_PUBLISH_JS_RUNTIME_SMOKE=0',
    };
  }

  if (process.platform === 'linux') {
    return {
      run: false,
      reason:
        'skipped on Linux because Bun worker WASM loading is currently flaky in CI',
    };
  }

  return { run: true };
}

async function writeTaskMigration(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'migrations', '0001_initial'), {
    recursive: true,
  });
  await writeFile(
    join(appDir, 'migrations', '0001_initial', 'up.sql'),
    `create table tasks (
  id text primary key not null,
  title text not null,
  completed integer not null default 0,
  user_id text not null,
  server_version bigint not null default 0
);
`,
    'utf8'
  );
}

async function runJsSmoke(options: Options): Promise<void> {
  const jsDir = join(options.workDir, 'js-browser-app');
  const cargoHome = join(options.workDir, 'js-cargo-home');
  const codegenRoot = join(options.workDir, 'js-codegen-root');
  const codegenBin = codegenBinaryPath(codegenRoot);
  await mkdir(jsDir, { recursive: true });
  await mkdir(cargoHome, { recursive: true });

  await writeFile(
    join(jsDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          generate: 'syncular generate --manifest-dir .',
          smoke: 'bun ./smoke.mjs',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeTaskMigration(jsDir);
  await writeFile(
    join(jsDir, 'syncular.app.ts'),
    `import { defineSyncularClient, scope, syncedTable } from '@syncular/typegen';

export const app = defineSyncularClient({
  typescriptOutputPath: 'src/generated/syncular.generated.ts',
  typescriptServerOutputPath: 'src/generated/syncular.server.generated.ts',
  tables: {
    tasks: syncedTable({
      table: 'tasks',
      subscriptionId: 'sub-tasks',
      serverVersion: 'server_version',
      scopes: [
        scope('user_id', {
          source: 'actorId',
          required: true,
        }),
      ],
    }),
  },
});
`,
    'utf8'
  );

  await writeFile(
    join(jsDir, 'smoke.mjs'),
    `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncularWasmUrl } from '@syncular/client';
import { createSyncularReact } from '@syncular/client/react';
import { generateTypes } from '@syncular/typegen';
import {
  createSyncCombinedRequest,
  createSyncPullRequest,
  createSyncPushRequest,
  createSyncSubscription,
  createSyncUpsertOperation
} from '@syncular/testkit';

const migrations = {
  currentVersion: 1,
  migrations: [
    {
      version: 1,
      name: 'v1',
      checksum: 'disabled',
      up: async (db) => {
        await db.schema
          .createTable('tasks')
          .addColumn('id', 'text', (column) => column.primaryKey())
          .addColumn('title', 'text', (column) => column.notNull())
          .addColumn('completed', 'integer', (column) => column.notNull().defaultTo(0))
          .addColumn('user_id', 'text', (column) => column.notNull())
          .addColumn('server_version', 'integer', (column) => column.notNull().defaultTo(0))
          .execute();
      },
      down: async (db) => {
        await db.schema.dropTable('tasks').ifExists().execute();
      }
    }
  ],
  getMigration(version) {
    return this.migrations.find((migration) => migration.version === version);
  }
};

const output = join(process.cwd(), 'generated', 'db.generated.ts');
const result = await generateTypes({ migrations, output });
const generated = await readFile(output, 'utf8');
if (!generated.includes('tasks: TasksTable') || result.tableCount !== 1) {
  throw new Error('typegen did not generate the expected task table');
}

const react = createSyncularReact();
if (typeof react.SyncProvider !== 'function' || typeof react.useSyncQuery !== 'function') {
  throw new Error('@syncular/client/react did not expose the expected React helpers');
}

const wasmUrl = getSyncularWasmUrl();
if (!(wasmUrl instanceof URL)) {
  throw new Error('@syncular/client did not expose packaged runtime URLs');
}

const clientId = 'fresh-js-smoke';
const push = createSyncPushRequest({
  clientId,
  clientCommitId: 'commit-fresh-js-smoke',
  schemaVersion: 1,
  operations: [
    createSyncUpsertOperation({
      table: 'tasks',
      rowId: 'task-fresh-js-smoke',
      payload: { title: 'Fresh JS smoke', completed: 0, user_id: 'user-js' }
    })
  ]
});
const pull = createSyncPullRequest({
  clientId,
  limitCommits: 10,
  subscriptions: [
    createSyncSubscription({
      id: 'sub-tasks',
      table: 'tasks',
      scopes: { user_id: 'user-js' }
    })
  ]
});
const request = createSyncCombinedRequest({
  clientId,
  push: {
    commits: push.commits
  },
  pull: {
    schemaVersion: 1,
    limitCommits: pull.limitCommits,
    subscriptions: pull.subscriptions
  }
});

if (request.clientId !== 'fresh-js-smoke' || request.push?.commits.length !== 1) {
  throw new Error('@syncular/testkit did not build the expected sync request');
}

console.log('fresh JS package smoke passed');
`,
    'utf8'
  );
  await writeFile(
    join(jsDir, 'runtime-smoke.ts'),
    `import { getSyncularRuntimeArtifact } from '@syncular/client';
import { createSyncularReact } from '@syncular/client/react';
import {
  createSyncularAppDatabase,
  taskSubscription,
} from './src/generated/syncular.generated';

const react = createSyncularReact();
if (
  typeof react.SyncProvider !== 'function' ||
  typeof react.useSyncQuery !== 'function'
) {
  throw new Error('@syncular/client/react did not expose the expected helpers');
}

const database = await createSyncularAppDatabase({
  config: {
    mode: 'local-sync-compatible',
    actorId: 'user-js',
    clientId: 'published-js-client',
    storage: 'memory',
    clearOnInit: true,
  },
  runtimeArtifacts: [getSyncularRuntimeArtifact('core')],
  subscriptions: [taskSubscription({ actorId: 'user-js' })],
});

try {
  await database.mutations.tasks.insert({
    id: 'task-published-js',
    title: 'Published JS app',
    user_id: 'user-js',
  });

  const rows = await database.db
    .selectFrom('tasks')
    .select(['id', 'title', 'completed', 'user_id', 'server_version'])
    .orderBy('id')
    .execute();

  if (
    rows.length !== 1 ||
    rows[0]?.id !== 'task-published-js' ||
    rows[0]?.title !== 'Published JS app' ||
    rows[0]?.completed !== 0 ||
    rows[0]?.user_id !== 'user-js' ||
    rows[0]?.server_version !== 0
  ) {
    throw new Error(
      \`published JS app query returned \${JSON.stringify(rows)}\`
    );
  }
} finally {
  await database.close();
}

console.log('published JS runtime smoke passed');
`,
    'utf8'
  );

  await run(
    'npm',
    [
      'install',
      '--registry',
      options.npmRegistry,
      atVersion('syncular', options.version),
      atVersion('@syncular/client', options.version),
      atVersion('@syncular/typegen', options.version),
      atVersion('@syncular/testkit', options.version),
      'kysely',
      'react',
      'react-dom',
    ],
    { cwd: jsDir }
  );
  await run('npm', ['exec', '--', 'syncular', 'generate', '--help'], {
    cwd: jsDir,
  });
  await run(
    'npm',
    [
      'exec',
      '--',
      'syncular',
      'codegen',
      'install',
      '--version',
      options.crateVersion,
      '--root',
      codegenRoot,
    ],
    { cwd: jsDir, env: { CARGO_HOME: cargoHome } }
  );
  await run(
    'npm',
    ['exec', '--', 'syncular', 'generate', '--manifest-dir', '.'],
    {
      cwd: jsDir,
      env: { CARGO_HOME: cargoHome, SYNCULAR_CODEGEN_BIN: codegenBin },
    }
  );
  await run(
    'npm',
    ['exec', '--', 'syncular', 'generate', '--manifest-dir', '.', '--check'],
    {
      cwd: jsDir,
      env: { CARGO_HOME: cargoHome, SYNCULAR_CODEGEN_BIN: codegenBin },
    }
  );
  const config = await readFile(
    join(jsDir, 'generated/syncular.codegen.json'),
    'utf8'
  );
  const generatedClient = await readFile(
    join(jsDir, 'src/generated/syncular.generated.ts'),
    'utf8'
  );
  if (!config.includes('"subscriptionId": "sub-tasks"')) {
    throw new Error(
      'published JS app did not generate the expected codegen config'
    );
  }
  if (!generatedClient.includes('sub-tasks')) {
    throw new Error(
      'published JS app did not generate the expected client output'
    );
  }
  const runtimeSmoke = jsRuntimeSmokeDecision();
  if (runtimeSmoke.run) {
    await run(bunBin, ['runtime-smoke.ts'], { cwd: jsDir });
  } else {
    console.warn(
      `[post-publish-install-smokes] Skipping JS runtime WASM smoke: ${runtimeSmoke.reason}. Set SYNCULAR_POST_PUBLISH_JS_RUNTIME_SMOKE=1 to force it.`
    );
  }
  await run(bunBin, ['smoke.mjs'], { cwd: jsDir });
}

async function runRustSmoke(options: Options): Promise<void> {
  const rustDir = join(options.workDir, 'rust-app');
  const cargoHome = join(options.workDir, 'cargo-home');
  const cargoRoot = join(options.workDir, 'cargo-bin');
  const cargoBin = codegenBinaryPath(cargoRoot);
  await mkdir(rustDir, { recursive: true });
  await mkdir(cargoHome, { recursive: true });
  await mkdir(cargoRoot, { recursive: true });

  await run(
    'cargo',
    ['init', '--bin', '--name', 'syncular_install_smoke', '.'],
    {
      cwd: rustDir,
      env: { CARGO_HOME: cargoHome },
    }
  );

  await run(
    'cargo',
    [
      'add',
      atVersion('syncular', options.crateVersion),
      atVersion('syncular-client', options.crateVersion),
      atVersion('syncular-codegen', options.crateVersion),
      atVersion('syncular-testkit', options.crateVersion),
    ],
    { cwd: rustDir, env: { CARGO_HOME: cargoHome } }
  );

  await run(
    'cargo',
    [
      'install',
      'syncular-codegen',
      '--version',
      options.crateVersion,
      '--locked',
      '--root',
      cargoRoot,
    ],
    { cwd: rustDir, env: { CARGO_HOME: cargoHome } }
  );

  await writeTaskMigration(rustDir);
  await run(cargoBin, ['init', '--manifest-dir', rustDir], {
    cwd: rustDir,
    env: { CARGO_HOME: cargoHome },
  });
  await run(cargoBin, ['init', '--manifest-dir', rustDir, '--check'], {
    cwd: rustDir,
    env: { CARGO_HOME: cargoHome },
  });

  await run(cargoBin, ['--manifest-dir', rustDir], {
    cwd: rustDir,
    env: { CARGO_HOME: cargoHome },
  });
  await run(cargoBin, ['--manifest-dir', rustDir, '--check'], {
    cwd: rustDir,
    env: { CARGO_HOME: cargoHome },
  });

  await mkdir(join(rustDir, 'tests'), { recursive: true });
  await writeFile(
    join(rustDir, 'tests', 'install_smoke.rs'),
    `use syncular_client::store::DemoTaskStore;

#[test]
fn published_testkit_opens_client_and_reads_written_rows() {
    assert_eq!(syncular::package_name(), "syncular");
    assert!(!syncular::VERSION.is_empty());

    let mut fixture = syncular_testkit::open_todo_client().expect("open todo testkit client");
    let task_id = fixture
        .client
        .add_task("Fresh Rust smoke".to_string(), None)
        .expect("insert task through client");
    let rows = fixture.client.list_tasks().expect("query tasks");
    assert!(rows.iter().any(|row| row.id == task_id));
}
`,
    'utf8'
  );

  await run('cargo', ['test'], {
    cwd: rustDir,
    env: { CARGO_HOME: cargoHome },
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (existsSync(options.workDir)) {
    await rm(options.workDir, { recursive: true, force: true });
  }
  await mkdir(options.workDir, { recursive: true });

  try {
    if (!options.skipJs) {
      await runJsSmoke(options);
    }
    if (!options.skipRust) {
      await runRustSmoke(options);
    }
  } finally {
    if (!options.keep) {
      await rm(options.workDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[post-publish-install-smokes] ${message}`);
  process.exitCode = 1;
}
