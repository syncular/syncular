#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Fallback dependency range used when this package's own version is the
 * unstamped `0.0.0` development placeholder (i.e. when the CLI runs from the
 * repository instead of a published tarball). Release stamping
 * (scripts/stamp-versions.ts) rewrites this package's `version` field, and
 * the scaffolded app always prefers `^<that version>`.
 */
const FALLBACK_SYNCULAR_VERSION_RANGE = '^0.1.3';

export interface CreateCommandOptions {
  targetDir?: string;
  help: boolean;
}

function usage(): string {
  return `usage: create-syncular-app <target-dir>

Scaffolds a local-first Syncular starter app (tasks table, Hono sync server,
React client) into <target-dir>.

examples:
  bunx create-syncular-app my-app
  npm create syncular-app@latest my-app
  pnpm create syncular-app my-app
`;
}

export function parseCreateCliArgs(
  argv: readonly string[]
): CreateCommandOptions {
  const options: CreateCommandOptions = { help: false };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
    if (options.targetDir !== undefined) {
      throw new Error(`Unexpected extra argument: ${arg}\n\n${usage()}`);
    }
    options.targetDir = arg;
  }

  return options;
}

/** Derives a valid npm package name from the target directory. */
export function packageNameFromDirectory(targetDir: string): string {
  const name = basename(resolve(targetDir))
    .toLowerCase()
    .replace(/[^a-z0-9-_.~]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return name.length > 0 ? name : 'syncular-app';
}

/**
 * Returns the dependency range to use for `@syncular/*` packages and the
 * `syncular` CLI in the scaffolded app. The published CLI carries the same
 * stamped version as every other package in a release, so `^<own version>`
 * always points at the matching release train.
 */
export function syncularDependencyRange(
  ownVersion: string | undefined
): string {
  const version = ownVersion?.trim();
  if (!version || version === '0.0.0') {
    return FALLBACK_SYNCULAR_VERSION_RANGE;
  }
  return `^${version}`;
}

function isSyncularPackage(dependencyName: string): boolean {
  return (
    dependencyName === 'syncular' || dependencyName.startsWith('@syncular/')
  );
}

/**
 * Rewrites the template package.json for the scaffolded app: sets the package
 * name and replaces `workspace:*` placeholders on Syncular packages with the
 * published version range.
 */
export function rewriteTemplatePackageJson(
  source: string,
  options: { packageName: string; syncularRange: string }
): string {
  const pkg = JSON.parse(source) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  pkg.name = options.packageName;

  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    if (!section) continue;
    for (const [name, range] of Object.entries(section)) {
      if (isSyncularPackage(name) && range.startsWith('workspace:')) {
        section[name] = options.syncularRange;
      }
    }
  }

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export function detectPackageManager(
  userAgent = process.env.npm_config_user_agent
): PackageManager {
  if (!userAgent) return 'bun';
  if (userAgent.startsWith('bun')) return 'bun';
  if (userAgent.startsWith('pnpm')) return 'pnpm';
  if (userAgent.startsWith('yarn')) return 'yarn';
  if (userAgent.startsWith('npm')) return 'npm';
  return 'bun';
}

export function nextStepsMessage(
  targetDir: string,
  packageManager: PackageManager
): string {
  const install =
    packageManager === 'yarn' ? 'yarn' : `${packageManager} install`;
  const dev =
    packageManager === 'bun' ? 'bun dev' : `${packageManager} run dev`;
  return `
Done. Next steps:

  cd ${targetDir}
  ${install}
  ${dev}

The dev script starts the sync server (http://127.0.0.1:4100/health) and the
Vite client (http://127.0.0.1:5173). The app itself runs on Bun (the sync
server uses Bun.serve + bun:sqlite); install it from https://bun.sh if needed.

Read the generated README.md for the project layout and how to evolve the
schema.
`;
}

function readOwnVersion(): string | undefined {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

function templateDirectory(): string {
  // dist/cli.js -> ../template, src/cli.ts -> ../template
  return fileURLToPath(new URL('../template', import.meta.url));
}

function directoryIsEmpty(path: string): boolean {
  return readdirSync(path).length === 0;
}

async function promptTargetDir(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Target directory (e.g. my-app): ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

export interface ScaffoldResult {
  targetDir: string;
  packageName: string;
  syncularRange: string;
}

export function scaffoldApp(targetDirInput: string): ScaffoldResult {
  const targetDir = resolve(targetDirInput);
  const templateDir = templateDirectory();

  if (!existsSync(templateDir)) {
    throw new Error(`Bundled template not found at ${templateDir}`);
  }
  if (existsSync(targetDir) && !directoryIsEmpty(targetDir)) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }

  cpSync(templateDir, targetDir, { recursive: true });

  // npm strips `.gitignore` from published packages, so the template ships it
  // as `_gitignore` and we restore the real name on copy.
  const gitignorePlaceholder = join(targetDir, '_gitignore');
  if (existsSync(gitignorePlaceholder)) {
    renameSync(gitignorePlaceholder, join(targetDir, '.gitignore'));
  }

  const packageName = packageNameFromDirectory(targetDir);
  const syncularRange = syncularDependencyRange(readOwnVersion());
  const packageJsonPath = join(targetDir, 'package.json');
  writeFileSync(
    packageJsonPath,
    rewriteTemplatePackageJson(readFileSync(packageJsonPath, 'utf8'), {
      packageName,
      syncularRange,
    })
  );

  return { targetDir, packageName, syncularRange };
}

export async function runCreateSyncularAppCli(
  argv = process.argv.slice(2)
): Promise<number> {
  try {
    const options = parseCreateCliArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }

    let targetDirInput = options.targetDir;
    if (!targetDirInput) {
      targetDirInput = await promptTargetDir();
    }
    if (!targetDirInput) {
      console.error('[create-syncular-app] A target directory is required.');
      console.error(usage());
      return 1;
    }

    const result = scaffoldApp(targetDirInput);
    console.log(
      `[create-syncular-app] Scaffolded ${result.packageName} into ${result.targetDir} (Syncular packages at ${result.syncularRange}).`
    );
    console.log(nextStepsMessage(targetDirInput, detectPackageManager()));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[create-syncular-app] ${message}`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  process.exitCode = await runCreateSyncularAppCli();
}
