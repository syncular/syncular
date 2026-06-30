#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_APP_FILE = 'syncular.app.ts';
const DEFAULT_CODEGEN_CONFIG_FILE = 'generated/syncular.codegen.json';
const SYNCULAR_CODEGEN_BIN = 'syncular-codegen';

export interface GenerateCommandOptions {
  check: boolean;
  manifestDir: string;
  migrationsDir?: string;
  rustOutputDir?: string;
  app?: string;
}

export interface CodegenInstallCommandOptions {
  version?: string;
  root?: string;
  force: boolean;
}

export type SyncularCliCommand =
  | { kind: 'help'; topic?: 'generate' | 'codegen-install' }
  | { kind: 'generate'; options: GenerateCommandOptions }
  | { kind: 'codegen-install'; options: CodegenInstallCommandOptions };

export interface GenerateStep {
  label: string;
  command: string;
  args: string[];
}

export interface GenerateStepContext {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
}

function usage(): string {
  return `usage: syncular <command>

commands:
  generate [--check] [--manifest-dir <path>] [--migrations-dir <path>] [--rust-output-dir <path>] [--app <path>]
  codegen install [--version <version>] [--root <path>] [--force]

examples:
  syncular generate
  syncular generate --check
  syncular generate --manifest-dir ./syncular-app --app ./syncular.app.ts
  syncular codegen install
`;
}

function generateUsage(): string {
  return `usage: syncular generate [--check] [--manifest-dir <path>] [--migrations-dir <path>] [--rust-output-dir <path>] [--app <path>]

Generates the Syncular app handoff and language clients in one app-facing command.

When <manifest-dir>/syncular.app.ts exists, or --app is provided, the typed
TypeScript app contract is used to refresh generated/syncular.codegen.json.
Rust-only apps can omit syncular.app.ts; when generated/syncular.codegen.json
is missing, syncular generate initializes it from migrations before generating
clients.

Use --check in CI to verify generated outputs are current without rewriting
files.
`;
}

function codegenInstallUsage(): string {
  return `usage: syncular codegen install [--version <version>] [--root <path>] [--force]

Installs the Rust syncular-codegen binary with Cargo into Syncular's tool cache.

By default the installed crate version matches the installed syncular npm
package version. Use --root to install into a custom Cargo root, or set
SYNCULAR_CODEGEN_BIN to point syncular generate at a custom binary.
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

export function parseSyncularCliArgs(
  argv: readonly string[]
): SyncularCliCommand {
  const [command, ...rest] = argv;

  if (
    !command ||
    command === '--help' ||
    command === '-h' ||
    command === 'help'
  ) {
    return { kind: 'help' };
  }

  if (command === 'codegen') {
    const [subcommand, ...codegenArgs] = rest;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      return { kind: 'help', topic: 'codegen-install' };
    }
    if (subcommand !== 'install') {
      throw new Error(
        `Unknown syncular codegen command: ${subcommand}\n\n${usage()}`
      );
    }
    if (codegenArgs.includes('--help') || codegenArgs.includes('-h')) {
      return { kind: 'help', topic: 'codegen-install' };
    }
    return {
      kind: 'codegen-install',
      options: parseCodegenInstallArgs(codegenArgs),
    };
  }

  if (command !== 'generate') {
    throw new Error(`Unknown syncular command: ${command}\n\n${usage()}`);
  }

  const options: GenerateCommandOptions = {
    check: false,
    manifestDir: '.',
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;

    if (arg === '--help' || arg === '-h') {
      return { kind: 'help', topic: 'generate' };
    }

    if (arg === '--check') {
      options.check = true;
      continue;
    }

    const manifestDir = readOptionValue(rest, index, arg, '--manifest-dir');
    if (manifestDir) {
      options.manifestDir = manifestDir.value;
      index = manifestDir.nextIndex;
      continue;
    }

    const migrationsDir = readOptionValue(rest, index, arg, '--migrations-dir');
    if (migrationsDir) {
      options.migrationsDir = migrationsDir.value;
      index = migrationsDir.nextIndex;
      continue;
    }

    const rustOutputDir = readOptionValue(
      rest,
      index,
      arg,
      '--rust-output-dir'
    );
    if (rustOutputDir) {
      options.rustOutputDir = rustOutputDir.value;
      index = rustOutputDir.nextIndex;
      continue;
    }

    const app = readOptionValue(rest, index, arg, '--app');
    if (app) {
      options.app = app.value;
      index = app.nextIndex;
      continue;
    }

    throw new Error(
      `Unknown syncular generate option: ${arg}\n\n${generateUsage()}`
    );
  }

  return { kind: 'generate', options };
}

function parseCodegenInstallArgs(
  args: readonly string[]
): CodegenInstallCommandOptions {
  const options: CodegenInstallCommandOptions = {
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    const version = readOptionValue(args, index, arg, '--version');
    if (version) {
      options.version = version.value;
      index = version.nextIndex;
      continue;
    }

    const root = readOptionValue(args, index, arg, '--root');
    if (root) {
      options.root = root.value;
      index = root.nextIndex;
      continue;
    }

    throw new Error(
      `Unknown syncular codegen install option: ${arg}\n\n${codegenInstallUsage()}`
    );
  }

  return options;
}

function resolveFrom(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export function buildGenerateSteps(
  options: GenerateCommandOptions,
  context: GenerateStepContext = {}
): GenerateStep[] {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  const fileExists = context.fileExists ?? existsSync;
  const typegenBin = env.SYNCULAR_TYPEGEN_BIN ?? 'syncular-typegen';
  const codegenBin = env.SYNCULAR_CODEGEN_BIN ?? SYNCULAR_CODEGEN_BIN;
  const manifestDir = resolveFrom(cwd, options.manifestDir);
  const appPath = options.app
    ? resolveFrom(cwd, options.app)
    : resolveFrom(manifestDir, DEFAULT_APP_FILE);
  const codegenConfigPath = resolveFrom(
    manifestDir,
    DEFAULT_CODEGEN_CONFIG_FILE
  );
  const hasAppDefinition = options.app !== undefined || fileExists(appPath);

  if (options.app !== undefined && !fileExists(appPath)) {
    throw new Error(
      `Syncular app definition not found: ${appPath}. Create syncular.app.ts, pass the correct --app path, or omit --app for a Rust-only project that already has generated/syncular.codegen.json.`
    );
  }

  const steps: GenerateStep[] = [];

  if (hasAppDefinition) {
    steps.push({
      label: 'Generate Syncular codegen config',
      command: typegenBin,
      args: [
        'codegen-config',
        '--app',
        appPath,
        '--out',
        codegenConfigPath,
        ...(options.check ? ['--check'] : []),
      ],
    });
  }

  if (!hasAppDefinition && !fileExists(codegenConfigPath)) {
    steps.push({
      label: 'Initialize Syncular codegen config',
      command: codegenBin,
      args: [
        'init',
        '--manifest-dir',
        manifestDir,
        ...(options.migrationsDir
          ? ['--migrations-dir', resolveFrom(cwd, options.migrationsDir)]
          : []),
        ...(options.check ? ['--check'] : []),
      ],
    });
  }

  steps.push({
    label: 'Generate Syncular app clients',
    command: codegenBin,
    args: [
      '--manifest-dir',
      manifestDir,
      ...(options.migrationsDir
        ? ['--migrations-dir', resolveFrom(cwd, options.migrationsDir)]
        : []),
      ...(options.rustOutputDir
        ? ['--rust-output-dir', resolveFrom(cwd, options.rustOutputDir)]
        : []),
      ...(options.check ? ['--check'] : []),
    ],
  });

  return steps;
}

function readPackageVersion(): string | undefined {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    const version = packageJson.version?.trim();
    return version && version !== '0.0.0' ? version : undefined;
  } catch {
    return undefined;
  }
}

function defaultCacheDir(): string {
  if (process.env.SYNCULAR_CACHE_DIR) {
    return process.env.SYNCULAR_CACHE_DIR;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Syncular');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'syncular');
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'syncular'
  );
}

function defaultCodegenVersion(version?: string): string | undefined {
  const resolved =
    version?.trim() ||
    process.env.SYNCULAR_CODEGEN_VERSION?.trim() ||
    readPackageVersion();
  return resolved && resolved !== '0.0.0' ? resolved : undefined;
}

function defaultCodegenInstallRoot(version?: string): string {
  return join(defaultCacheDir(), 'codegen', version ?? 'latest');
}

function codegenBinaryPath(root: string): string {
  return join(
    root,
    'bin',
    process.platform === 'win32'
      ? `${SYNCULAR_CODEGEN_BIN}.exe`
      : SYNCULAR_CODEGEN_BIN
  );
}

export function buildCodegenInstallArgs(options: {
  version?: string;
  root: string;
  force?: boolean;
}): string[] {
  return [
    'install',
    SYNCULAR_CODEGEN_BIN,
    ...(options.version ? ['--version', options.version] : []),
    '--locked',
    '--root',
    options.root,
    ...(options.force ? ['--force'] : []),
  ];
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function executableCandidates(command: string, env = process.env): string[] {
  if (hasPathSeparator(command)) {
    return [command];
  }

  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  return pathDirs.flatMap((dir) =>
    extensions.map((extension) => join(dir, `${command}${extension}`))
  );
}

function findExecutable(command: string, env = process.env): string | null {
  for (const candidate of executableCandidates(command, env)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      if (process.platform === 'win32' && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function localRepoCodegenManifest(): string | null {
  const cliPath = fileURLToPath(import.meta.url);
  let current = dirname(cliPath);
  while (true) {
    const cargoManifest = join(current, 'rust/Cargo.toml');
    const codegenManifest = join(current, 'rust/crates/codegen/Cargo.toml');
    const syncularPackageDir = join(current, 'packages/syncular');
    if (
      existsSync(cargoManifest) &&
      existsSync(codegenManifest) &&
      cliPath.startsWith(`${syncularPackageDir}${sep}`)
    ) {
      return cargoManifest;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function codegenAutoInstallEnabled(): boolean {
  const value = (process.env.SYNCULAR_CODEGEN_AUTO_INSTALL ?? '1')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function missingCodegenMessage(
  version: string | undefined,
  root: string
): string {
  const installCommand = version
    ? `npx syncular codegen install --version ${version}`
    : 'npx syncular codegen install';
  const cargoCommand = version
    ? `cargo install ${SYNCULAR_CODEGEN_BIN} --version ${version} --locked`
    : `cargo install ${SYNCULAR_CODEGEN_BIN} --locked`;
  return [
    `Required generator command not found: ${SYNCULAR_CODEGEN_BIN}.`,
    `Run \`${installCommand}\` to install it into ${root},`,
    `run \`${cargoCommand}\`,`,
    `or set SYNCULAR_CODEGEN_BIN to an existing ${SYNCULAR_CODEGEN_BIN} binary.`,
  ].join(' ');
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Required generator command not found: ${command}. Install it and ensure it is on PATH before running syncular generate.`
          )
        );
        return;
      }
      reject(error);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

async function installSyncularCodegen(options: {
  version?: string;
  root: string;
  force?: boolean;
}): Promise<string> {
  const cargo = findExecutable('cargo');
  if (!cargo) {
    throw new Error(missingCodegenMessage(options.version, options.root));
  }

  mkdirSync(options.root, { recursive: true });
  const args = buildCodegenInstallArgs(options);
  console.log(`[syncular] Installing ${SYNCULAR_CODEGEN_BIN}`);
  console.log(`$ ${[cargo, ...args].join(' ')}`);
  await runProcess(cargo, args);

  const binary = codegenBinaryPath(options.root);
  if (!findExecutable(binary)) {
    throw new Error(
      `${SYNCULAR_CODEGEN_BIN} install completed but ${binary} is not executable`
    );
  }
  return binary;
}

async function resolveStep(step: GenerateStep): Promise<GenerateStep> {
  const explicitCodegenBin = process.env.SYNCULAR_CODEGEN_BIN;
  const isCodegenStep =
    step.command === SYNCULAR_CODEGEN_BIN ||
    (explicitCodegenBin !== undefined && step.command === explicitCodegenBin);

  if (!isCodegenStep) {
    return step;
  }

  if (explicitCodegenBin) {
    const explicitBinary = findExecutable(explicitCodegenBin);
    if (!explicitBinary) {
      throw new Error(
        `SYNCULAR_CODEGEN_BIN points to a missing or non-executable command: ${explicitCodegenBin}`
      );
    }
    return { ...step, command: explicitBinary };
  }

  const repoManifest = localRepoCodegenManifest();
  if (repoManifest) {
    return {
      ...step,
      command: 'cargo',
      args: [
        'run',
        '--quiet',
        '--manifest-path',
        repoManifest,
        '-p',
        SYNCULAR_CODEGEN_BIN,
        '--',
        ...step.args,
      ],
    };
  }

  const version = defaultCodegenVersion();
  const root = defaultCodegenInstallRoot(version);
  const cachedBinary = codegenBinaryPath(root);
  if (findExecutable(cachedBinary)) {
    return { ...step, command: cachedBinary };
  }

  const pathBinary = findExecutable(SYNCULAR_CODEGEN_BIN);
  if (pathBinary) {
    return { ...step, command: pathBinary };
  }

  if (codegenAutoInstallEnabled() && findExecutable('cargo')) {
    const installedBinary = await installSyncularCodegen({ version, root });
    return { ...step, command: installedBinary };
  }

  throw new Error(missingCodegenMessage(version, root));
}

async function runStep(step: GenerateStep): Promise<void> {
  const resolvedStep = await resolveStep(step);
  console.log(`[syncular] ${step.label}`);
  console.log(`$ ${[resolvedStep.command, ...resolvedStep.args].join(' ')}`);
  await runProcess(resolvedStep.command, resolvedStep.args);
}

export async function runGenerateCommand(
  options: GenerateCommandOptions
): Promise<void> {
  const steps = buildGenerateSteps(options);
  for (const step of steps) {
    await runStep(step);
  }
}

export async function runCodegenInstallCommand(
  options: CodegenInstallCommandOptions
): Promise<void> {
  const version = defaultCodegenVersion(options.version);
  const root = resolve(options.root ?? defaultCodegenInstallRoot(version));
  const binary = await installSyncularCodegen({
    version,
    root,
    force: options.force,
  });
  console.log(`[syncular] ${SYNCULAR_CODEGEN_BIN} installed at ${binary}`);
}

export async function runSyncularCli(
  argv = process.argv.slice(2)
): Promise<number> {
  try {
    const parsed = parseSyncularCliArgs(argv);

    if (parsed.kind === 'help') {
      if (parsed.topic === 'generate') {
        console.log(generateUsage());
      } else if (parsed.topic === 'codegen-install') {
        console.log(codegenInstallUsage());
      } else {
        console.log(usage());
      }
      return 0;
    }

    if (parsed.kind === 'generate') {
      await runGenerateCommand(parsed.options);
    } else {
      await runCodegenInstallCommand(parsed.options);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[syncular] ${message}`);
    return 1;
  }
}

export function isMainModuleEntrypoint(
  entrypoint: string | undefined,
  moduleUrl = import.meta.url
): boolean {
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(entrypoint).href === moduleUrl;
  }
}

function isMainModule(): boolean {
  return isMainModuleEntrypoint(process.argv[1]);
}

if (isMainModule()) {
  process.exitCode = await runSyncularCli();
}
