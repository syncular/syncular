#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

interface Options {
  version: string;
  allowDirty: boolean;
  skipPublishDryRuns: boolean;
  skipFreshAppSmokes: boolean;
  skipFrameworkImportSmokes: boolean;
  skipStarterSmoke: boolean;
  skipDocsStaleCheck: boolean;
  requireStarterBrowserPreview: boolean;
  keepWorktree: boolean;
  workDir: string;
}

const repoRoot = resolve(join(import.meta.dirname, '..'));

function usage(): string {
  return `usage: bun scripts/release-rehearsal.ts [options]

options:
  --version <version>         Exact rehearsal version (default: root package.json version)
  --allow-dirty               Allow a dirty worktree for local rehearsal
  --skip-publish-dry-runs     Skip npm and Cargo publish dry-runs
  --skip-fresh-app-smokes     Skip local fresh-app generation smokes
  --skip-framework-import-smokes
                              Skip local Next/Vite root import smokes
  --skip-starter-smoke        Skip create-syncular-app built-preview smoke
  --require-starter-browser-preview
                              Require Chrome/Chromium CDP execution in the starter smoke
  --skip-docs-stale-check     Skip stale public-docs checks
  --work-dir <path>           Publish dry-run worktree path (default: .context/release-rehearsal/<version>)
  --keep-worktree             Keep the publish dry-run worktree after the run
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

async function parseArgs(argv: readonly string[]): Promise<Options> {
  let version = '';
  let allowDirty = false;
  let skipPublishDryRuns = false;
  let skipFreshAppSmokes = false;
  let skipFrameworkImportSmokes = false;
  let skipStarterSmoke = false;
  let skipDocsStaleCheck = false;
  let requireStarterBrowserPreview = false;
  let keepWorktree = false;
  let workDir = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--allow-dirty') {
      allowDirty = true;
      continue;
    }

    if (arg === '--skip-publish-dry-runs') {
      skipPublishDryRuns = true;
      continue;
    }

    if (arg === '--skip-fresh-app-smokes') {
      skipFreshAppSmokes = true;
      continue;
    }

    if (arg === '--skip-framework-import-smokes') {
      skipFrameworkImportSmokes = true;
      continue;
    }

    if (arg === '--skip-starter-smoke') {
      skipStarterSmoke = true;
      continue;
    }

    if (arg === '--require-starter-browser-preview') {
      requireStarterBrowserPreview = true;
      continue;
    }

    if (arg === '--skip-docs-stale-check') {
      skipDocsStaleCheck = true;
      continue;
    }

    if (arg === '--keep-worktree') {
      keepWorktree = true;
      continue;
    }

    const versionOption = readOptionValue(argv, index, arg, '--version');
    if (versionOption) {
      version = versionOption.value;
      index = versionOption.nextIndex;
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

  if (!version) {
    const rootPackage = JSON.parse(
      await readFile(join(repoRoot, 'package.json'), 'utf8')
    ) as { version?: string };
    if (!rootPackage.version) {
      throw new Error('Root package.json is missing a version');
    }
    version = rootPackage.version;
  }

  return {
    version,
    allowDirty,
    skipPublishDryRuns,
    skipFreshAppSmokes,
    skipFrameworkImportSmokes,
    skipStarterSmoke,
    skipDocsStaleCheck,
    requireStarterBrowserPreview,
    keepWorktree,
    workDir,
  };
}

async function runCapture(
  command: string,
  args: string[],
  cwd = repoRoot
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function run(
  command: string,
  args: string[],
  cwd = repoRoot
): Promise<void> {
  const cwdLabel = cwd === repoRoot ? '' : ` (${relative(repoRoot, cwd)})`;
  console.log(`$${cwdLabel} ${[command, ...args].join(' ')}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
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

async function verifyGitState(options: Options): Promise<boolean> {
  const ref = (
    await runCapture('git', ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
      async () =>
        (
          await runCapture('git', ['describe', '--tags', '--exact-match'])
        ).trim()
    )
  ).trim();
  console.log(`[release-rehearsal] ref: ${ref || 'detached HEAD'}`);

  const dirty = (await runCapture('git', ['status', '--porcelain'])).trim();
  if (dirty && !options.allowDirty) {
    throw new Error(
      `Release rehearsal requires a clean worktree. Re-run with --allow-dirty for local development.\n${dirty}`
    );
  }
  if (dirty) {
    console.warn('[release-rehearsal] continuing with dirty worktree');
  }

  return dirty.length > 0;
}

function defaultWorktreeDir(version: string): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(repoRoot, '.context', 'release-rehearsal', safeVersion);
}

async function removeWorktree(worktreeDir: string): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', worktreeDir]).catch(
    async (error) => {
      console.warn(
        `[release-rehearsal] git worktree remove failed; removing directory directly: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await rm(worktreeDir, { recursive: true, force: true });
      await run('git', ['worktree', 'prune']).catch(() => undefined);
    }
  );
}

async function runPublishDryRuns(
  options: Options,
  sourceDirty: boolean
): Promise<void> {
  if (sourceDirty) {
    throw new Error(
      'Publish dry-runs require a clean source checkout so the temporary release worktree exactly matches HEAD. Use --skip-publish-dry-runs for dirty local iteration.'
    );
  }

  const sourceSha = (
    await runCapture('git', ['rev-parse', '--verify', 'HEAD'])
  ).trim();
  const worktreeDir = resolve(
    options.workDir || defaultWorktreeDir(options.version)
  );
  const usingDefaultWorktree = options.workDir.length === 0;
  let worktreeCreated = false;

  if (usingDefaultWorktree) {
    await rm(worktreeDir, { recursive: true, force: true });
  }
  await mkdir(dirname(worktreeDir), { recursive: true });

  try {
    await run('git', ['worktree', 'add', '--detach', worktreeDir, sourceSha]);
    worktreeCreated = true;

    await run('bun', ['install', '--frozen-lockfile'], worktreeDir);
    await run(
      'bun',
      ['scripts/stamp-versions.ts', '--version', options.version],
      worktreeDir
    );
    await run(
      'bun',
      ['scripts/stamp-cargo-versions.ts', '--version', options.version],
      worktreeDir
    );
    await run('bun', ['run', 'release:npm:dry-run'], worktreeDir);
    await run('bun', ['run', 'release:cargo:dry-run'], worktreeDir);
  } finally {
    if (worktreeCreated && options.keepWorktree) {
      console.log(`[release-rehearsal] kept worktree at ${worktreeDir}`);
    } else if (worktreeCreated) {
      await removeWorktree(worktreeDir);
    }
  }
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  const sourceDirty = await verifyGitState(options);

  await run('bun', [
    'scripts/stamp-versions.ts',
    '--version',
    options.version,
    '--dry-run',
  ]);
  await run('bun', [
    'scripts/stamp-cargo-versions.ts',
    '--version',
    options.version,
    '--dry-run',
  ]);

  if (!options.skipDocsStaleCheck) {
    await run('bun', ['run', 'docs:stale-check']);
  }
  if (!options.skipFreshAppSmokes) {
    await run('bun', ['run', 'fresh-app-smokes']);
  }
  if (!options.skipStarterSmoke) {
    await run('bun', [
      '--cwd',
      'packages/create-syncular-app',
      'smoke',
      ...(options.requireStarterBrowserPreview
        ? ['--require-browser-preview']
        : []),
    ]);
  }
  if (!options.skipFrameworkImportSmokes) {
    await run('bun', ['run', 'framework-import-smokes']);
  }
  if (!options.skipPublishDryRuns) {
    await runPublishDryRuns(options, sourceDirty);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[release-rehearsal] ${message}`);
  process.exitCode = 1;
}
