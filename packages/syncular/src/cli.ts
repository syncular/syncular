#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_APP_FILE = 'syncular.app.ts';

export interface GenerateCommandOptions {
  check: boolean;
  manifestDir: string;
  migrationsDir?: string;
  rustOutputDir?: string;
  app?: string;
}

export type SyncularCliCommand =
  | { kind: 'help' }
  | { kind: 'generate'; options: GenerateCommandOptions };

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

examples:
  syncular generate
  syncular generate --check
  syncular generate --manifest-dir ./syncular-app --app ./syncular.app.ts
`;
}

function generateUsage(): string {
  return `usage: syncular generate [--check] [--manifest-dir <path>] [--migrations-dir <path>] [--rust-output-dir <path>] [--app <path>]

Runs the current Syncular app generation path as one command.

If a Syncular app definition exists at syncular.app.ts, or --app is provided,
Syncular first runs:
  syncular-typegen codegen-config --app <path>

It then runs:
  syncular-codegen --manifest-dir <path>
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
      return { kind: 'help' };
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
  const codegenBin = env.SYNCULAR_CODEGEN_BIN ?? 'syncular-codegen';
  const manifestDir = resolveFrom(cwd, options.manifestDir);
  const appPath = options.app
    ? resolveFrom(cwd, options.app)
    : resolveFrom(manifestDir, DEFAULT_APP_FILE);
  const hasAppDefinition = options.app !== undefined || fileExists(appPath);

  if (options.app !== undefined && !fileExists(appPath)) {
    throw new Error(`Syncular app definition not found: ${appPath}`);
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

async function runStep(step: GenerateStep): Promise<void> {
  console.log(`[syncular] ${step.label}`);
  console.log(`$ ${[step.command, ...step.args].join(' ')}`);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Required generator command not found: ${step.command}. Install it and ensure it is on PATH before running syncular generate.`
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

      reject(
        new Error(`${step.command} exited with status ${code ?? 'unknown'}`)
      );
    });
  });
}

export async function runGenerateCommand(
  options: GenerateCommandOptions
): Promise<void> {
  const steps = buildGenerateSteps(options);
  for (const step of steps) {
    await runStep(step);
  }
}

export async function runSyncularCli(
  argv = process.argv.slice(2)
): Promise<number> {
  try {
    const parsed = parseSyncularCliArgs(argv);

    if (parsed.kind === 'help') {
      console.log(argv[0] === 'generate' ? generateUsage() : usage());
      return 0;
    }

    await runGenerateCommand(parsed.options);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[syncular] ${message}`);
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
  process.exitCode = await runSyncularCli();
}
