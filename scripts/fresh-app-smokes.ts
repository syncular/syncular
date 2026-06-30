#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface Options {
  workDir: string;
  keep: boolean;
  skipJs: boolean;
  skipRust: boolean;
}

const repoRoot = resolve(join(import.meta.dirname, '..'));
const bunBin = process.execPath;

function usage(): string {
  return `usage: bun scripts/fresh-app-smokes.ts [options]

options:
  --work-dir <path>   Fresh-project workspace (default: .context/fresh-app-smokes)
  --skip-js           Skip the fresh JavaScript app smoke
  --skip-rust         Skip the fresh Rust app smoke
  --keep              Keep the smoke workspace after a successful run
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
  let workDir = '.context/fresh-app-smokes';
  let keep = false;
  let skipJs = false;
  let skipRust = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--keep') {
      keep = true;
      continue;
    }

    if (arg === '--skip-js') {
      skipJs = true;
      continue;
    }

    if (arg === '--skip-rust') {
      skipRust = true;
      continue;
    }

    const workDirOption = readOptionValue(argv, index, arg, '--work-dir');
    if (workDirOption) {
      workDir = workDirOption.value;
      index = workDirOption.nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return {
    workDir: resolve(workDir),
    keep,
    skipJs,
    skipRust,
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

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

async function createTypegenBinDir(workDir: string): Promise<{
  binDir: string;
  env: Record<string, string>;
}> {
  const binDir = join(workDir, 'bin');
  await mkdir(binDir, { recursive: true });

  const typegenBin = join(binDir, 'syncular-typegen');
  await writeExecutable(
    typegenBin,
    `#!/usr/bin/env sh
exec ${shQuote(bunBin)} ${shQuote(join(repoRoot, 'packages/typegen/src/cli.ts'))} "$@"
`
  );

  return {
    binDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      SYNCULAR_TYPEGEN_BIN: typegenBin,
    },
  };
}

async function linkNodeModule(
  appDir: string,
  packageName: string,
  packageDir: string
): Promise<void> {
  const linkPath = join(appDir, 'node_modules', ...packageName.split('/'));
  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  await symlink(join(repoRoot, packageDir), linkPath, 'dir');
}

async function runSyncularGenerate(
  manifestDir: string,
  args: string[],
  env: Record<string, string>
): Promise<void> {
  await run(
    bunBin,
    [
      join(repoRoot, 'packages/syncular/src/cli.ts'),
      'generate',
      '--manifest-dir',
      manifestDir,
      ...args,
    ],
    { cwd: repoRoot, env }
  );
}

async function runRepoCodegen(
  appDir: string,
  args: string[],
  env: Record<string, string>
): Promise<void> {
  await run(
    'cargo',
    [
      'run',
      '--quiet',
      '--manifest-path',
      join(repoRoot, 'rust/Cargo.toml'),
      '-p',
      'syncular-codegen',
      '--',
      ...args,
    ],
    { cwd: appDir, env }
  );
}

async function writeTaskMigration(appDir: string): Promise<void> {
  const migrationDir = join(appDir, 'migrations', '0001_initial');
  await mkdir(migrationDir, { recursive: true });
  await writeFile(
    join(migrationDir, 'up.sql'),
    `create table tasks (
  id text primary key not null,
  title text not null,
  completed integer not null default 0,
  user_id text not null,
  campaign_id text not null,
  server_version bigint not null default 0
);
`,
    'utf8'
  );
}

async function runJsSmoke(
  workDir: string,
  env: Record<string, string>
): Promise<void> {
  const appDir = join(workDir, 'js-browser-app');
  await mkdir(appDir, { recursive: true });
  await linkNodeModule(appDir, '@syncular/client', 'packages/client');
  await linkNodeModule(appDir, '@syncular/core', 'packages/core');
  await linkNodeModule(appDir, '@syncular/typegen', 'packages/typegen');
  await linkNodeModule(appDir, 'fflate', 'packages/core/node_modules/fflate');
  await linkNodeModule(appDir, 'kysely', 'packages/client/node_modules/kysely');
  await linkNodeModule(
    appDir,
    'kysely-generic-sqlite',
    'packages/client/node_modules/kysely-generic-sqlite'
  );
  await linkNodeModule(appDir, 'react', 'packages/client/node_modules/react');
  await linkNodeModule(appDir, 'zod', 'packages/core/node_modules/zod');
  await writeTaskMigration(appDir);
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@syncular/client': 'workspace:*',
          '@syncular/typegen': 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'syncular.app.ts'),
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
        scope('campaign_id', {
          source: 'projectId',
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
    join(appDir, 'runtime-smoke.ts'),
    `import {
  getSyncularBrowserHealth,
  getSyncularRuntimeArtifact,
} from '@syncular/client';
import { createSyncularReact } from '@syncular/client/react';
import {
  createSyncularAppDatabase,
  syncularGeneratedSchemaVersion,
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
    projectId: 'campaign-a',
    clientId: 'fresh-js-client',
    storage: 'memory',
    clearOnInit: true,
  },
  runtimeArtifacts: [getSyncularRuntimeArtifact('core')],
  subscriptions: [taskSubscription({ actorId: 'user-js', projectId: 'campaign-a' })],
});

try {
  const health = await getSyncularBrowserHealth(database);
  if (
    health.persistence.status !== 'memory' ||
    health.persistence.durable !== false ||
    health.subscriptions.total !== 1 ||
    health.realtime.state !== 'disconnected'
  ) {
    throw new Error(\`fresh JS app health returned \${JSON.stringify(health)}\`);
  }

  const schemaReadiness = await database.schemaReadiness({
    generatedSchemaVersion: syncularGeneratedSchemaVersion,
  });
  if (
    schemaReadiness.status !== 'ready' ||
    schemaReadiness.ready !== true ||
    schemaReadiness.generatedSchemaVersion !== syncularGeneratedSchemaVersion ||
    schemaReadiness.localSchema?.schemaVersion !== syncularGeneratedSchemaVersion
  ) {
    throw new Error(
      \`fresh JS app schema readiness returned \${JSON.stringify(schemaReadiness)}\`
    );
  }

  await database.mutations.tasks.insert({
    id: 'task-fresh-js',
    title: 'Fresh JS app',
    user_id: 'user-js',
    campaign_id: 'campaign-a',
  });

  const rows = await database.db
    .selectFrom('tasks')
    .select(['id', 'title', 'completed', 'user_id', 'campaign_id', 'server_version'])
    .orderBy('id')
    .execute();

  if (
    rows.length !== 1 ||
    rows[0]?.id !== 'task-fresh-js' ||
    rows[0]?.title !== 'Fresh JS app' ||
    rows[0]?.completed !== 0 ||
    rows[0]?.user_id !== 'user-js' ||
    rows[0]?.campaign_id !== 'campaign-a' ||
    rows[0]?.server_version !== 0
  ) {
    throw new Error(\`fresh JS app query returned \${JSON.stringify(rows)}\`);
  }

  const replacement = await database.replaceAuthContext({
    headers: { authorization: 'Bearer fresh-js-campaign-b' },
    subscriptions: [
      taskSubscription({ actorId: 'user-js', projectId: 'campaign-b' }),
    ],
    sync: false,
  });
  if (
    replacement.authHeadersReplaced !== true ||
    replacement.subscriptionsReplaced !== true ||
    replacement.bootstrapReset === null ||
    replacement.syncMode !== 'skipped'
  ) {
    throw new Error(
      \`fresh JS app auth context replacement returned \${JSON.stringify(replacement)}\`
    );
  }

  await database.mutations.tasks.insert({
    id: 'task-fresh-js-campaign-b',
    title: 'Fresh JS campaign switch',
    user_id: 'user-js',
    campaign_id: 'campaign-b',
  });

  const campaignRows = await database.awaitLocalVisibility(
    (db) =>
      db
        .selectFrom('tasks')
        .select(['id', 'campaign_id'])
        .where('campaign_id', '=', 'campaign-b')
        .execute(),
    { tables: ['tasks'], timeoutMs: 1_000 }
  );
  if (
    campaignRows.length !== 1 ||
    campaignRows[0]?.id !== 'task-fresh-js-campaign-b' ||
    campaignRows[0]?.campaign_id !== 'campaign-b'
  ) {
    throw new Error(
      \`fresh JS campaign visibility returned \${JSON.stringify(campaignRows)}\`
    );
  }
} finally {
  await database.close();
}
`,
    'utf8'
  );

  await runSyncularGenerate(appDir, [], env);
  await runSyncularGenerate(appDir, ['--check'], env);
  await run(
    bunBin,
    [
      join(repoRoot, 'packages/syncular/src/cli.ts'),
      'schema',
      'check',
      '--manifest-dir',
      appDir,
      '--json',
    ],
    { cwd: repoRoot, env }
  );

  const config = await readFile(
    join(appDir, 'generated/syncular.codegen.json'),
    'utf8'
  );
  const generatedClient = await readFile(
    join(appDir, 'src/generated/syncular.generated.ts'),
    'utf8'
  );
  if (!config.includes('"subscriptionId": "sub-tasks"')) {
    throw new Error(
      'fresh JS app did not generate the expected codegen config'
    );
  }
  if (!generatedClient.includes('sub-tasks')) {
    throw new Error('fresh JS app did not generate the expected client output');
  }
  await run(bunBin, ['runtime-smoke.ts'], { cwd: appDir });
}

async function runRustSmoke(
  workDir: string,
  env: Record<string, string>
): Promise<void> {
  const appDir = join(workDir, 'rust-app');
  await mkdir(join(appDir, 'src'), { recursive: true });
  await writeTaskMigration(appDir);
  await writeFile(
    join(appDir, 'Cargo.toml'),
    `[package]
name = "syncular_fresh_rust_app"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
diesel = { version = "2.2", features = ["sqlite", "returning_clauses_for_sqlite_3_35"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
syncular = { path = "${join(repoRoot, 'rust/crates/syncular')}" }
syncular-client = { path = "${join(repoRoot, 'rust/crates/client')}", default-features = false, features = ["native", "crdt-yjs", "e2ee"] }
syncular-testkit = { path = "${join(repoRoot, 'rust/crates/testkit')}" }
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'src/lib.rs'),
    `pub mod generated {
    pub mod schema {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/schema.rs"));
    }

    pub mod syncular {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/syncular.rs"));
    }

    pub mod diesel_tables {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/diesel_tables.rs"));
    }

    pub mod migrations {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/generated/rust/migrations.rs"));
    }
}

#[cfg(test)]
mod tests {
    use super::generated::{migrations, syncular};

    #[test]
    fn generated_metadata_matches_fresh_app() {
        assert_eq!(syncular::APP_TABLES, &["tasks"]);
        assert_eq!(
            syncular::table_metadata("tasks")
                .expect("tasks metadata")
                .subscription_id,
            "sub-tasks"
        );
        assert_eq!(migrations::current_schema_version(), 1);
    }

    #[test]
    fn testkit_opens_a_sync_client() {
        assert_eq!(::syncular::package_name(), "syncular");
        let mut fixture = syncular_testkit::open_todo_client().expect("open todo testkit client");
        let task_id = fixture
            .client
            .add_task("Fresh Rust app".to_string(), None)
            .expect("insert task through client");
        let rows = fixture.client.list_tasks().expect("query tasks");
        assert!(rows.iter().any(|row| row.id == task_id));
    }
}
`,
    'utf8'
  );

  await runSyncularGenerate(appDir, [], env);
  await runRepoCodegen(
    appDir,
    ['init', '--manifest-dir', appDir, '--check'],
    env
  );
  await runSyncularGenerate(appDir, ['--check'], env);
  await run('cargo', ['test', '--manifest-path', join(appDir, 'Cargo.toml')], {
    cwd: appDir,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workDir = join(options.workDir, randomUUID());
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });

  try {
    const { env } = await createTypegenBinDir(workDir);
    if (!options.skipJs) {
      await runJsSmoke(workDir, env);
    }
    if (!options.skipRust) {
      await runRustSmoke(workDir, env);
    }
  } finally {
    if (!options.keep) {
      await rm(workDir, { recursive: true, force: true });
    } else {
      console.log(`[fresh-app-smokes] kept workspace at ${workDir}`);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fresh-app-smokes] ${message}`);
  process.exitCode = 1;
}
