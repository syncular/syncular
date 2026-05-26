#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Options {
  version: string;
  allowDirty: boolean;
  skipPublishDryRuns: boolean;
  skipFreshAppSmokes: boolean;
  skipDocsStaleCheck: boolean;
}

const repoRoot = resolve(join(import.meta.dirname, '..'));

function usage(): string {
  return `usage: bun scripts/release-rehearsal.ts [options]

options:
  --version <version>         Exact rehearsal version (default: root package.json version)
  --allow-dirty               Allow a dirty worktree for local rehearsal
  --skip-publish-dry-runs     Skip npm and Cargo publish dry-runs
  --skip-fresh-app-smokes     Skip local fresh-app generation smokes
  --skip-docs-stale-check     Skip stale public-docs checks
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
  let skipDocsStaleCheck = false;

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

    if (arg === '--skip-docs-stale-check') {
      skipDocsStaleCheck = true;
      continue;
    }

    const versionOption = readOptionValue(argv, index, arg, '--version');
    if (versionOption) {
      version = versionOption.value;
      index = versionOption.nextIndex;
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
    skipDocsStaleCheck,
  };
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
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

async function run(command: string, args: string[]): Promise<void> {
  console.log(`$ ${[command, ...args].join(' ')}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
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

async function verifyGitState(options: Options): Promise<void> {
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
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  await verifyGitState(options);

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
  if (!options.skipPublishDryRuns) {
    await run('bun', ['run', 'release:npm:dry-run']);
    await run('bun', ['run', 'release:cargo:dry-run']);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[release-rehearsal] ${message}`);
  process.exitCode = 1;
}
