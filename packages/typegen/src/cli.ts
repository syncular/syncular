#!/usr/bin/env bun
/**
 * The `syncular` CLI. Subcommands:
 *
 *   generate [--manifest-dir <dir>] [--check] [--watch]
 *     Reads `syncular.json` + `migrations/` under the manifest dir and writes
 *     the neutral IR JSON and generated TS module (paths from the manifest's
 *     `output`). `--check` regenerates in memory and fails (exit 1) unless the
 *     files on disk match byte-exactly. `--watch` regenerates on change.
 *
 *   init [--manifest-dir <dir>]
 *     Drops a starter `syncular.json` + `migrations/0001_initial` into an
 *     existing project (the "add syncular to my app" path).
 *
 * The generate CONTRACT (inputs, outputs, byte-exact `--check`) is unchanged;
 * this file only adds `init`, `--watch`, and friendlier errors.
 */
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { checkOutputs, generate, writeOutputs } from './generate';
import { InitError, initProject } from './init';
import { MANIFEST_FILENAME } from './manifest';

const DOCS_HINT =
  'See the schema guide: https://github.com/bkniffler/syncular (guide-schema), ' +
  'or run `syncular init` to scaffold a starter manifest + migration.';

const USAGE = `usage: syncular <command> [options]

commands:
  generate   build the IR + typed module from syncular.json + migrations/
  init       scaffold a starter syncular.json + migrations/0001_initial

generate options:
  --manifest-dir <dir>   directory holding syncular.json (default: .)
  --check                fail unless generated files are byte-exactly fresh
  --watch                regenerate on file change (Ctrl-C to stop)

init options:
  --manifest-dir <dir>   directory to scaffold into (default: .)`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

interface GenerateArgs {
  manifestDir: string;
  check: boolean;
  watch: boolean;
}

function parseGenerateArgs(argv: readonly string[]): GenerateArgs {
  const args: GenerateArgs = { manifestDir: '.', check: false, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      args.check = true;
    } else if (arg === '--watch') {
      args.watch = true;
    } else if (arg === '--manifest-dir') {
      const value = argv[i + 1];
      if (value === undefined) fail('--manifest-dir requires a value');
      args.manifestDir = value;
      i += 1;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (args.check && args.watch) {
    fail('--check and --watch cannot be combined');
  }
  return args;
}

function parseManifestDir(argv: readonly string[]): string {
  let manifestDir = '.';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest-dir') {
      const value = argv[i + 1];
      if (value === undefined) fail('--manifest-dir requires a value');
      manifestDir = value;
      i += 1;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  return manifestDir;
}

/** Add a docs pointer to the fail-loud missing-input errors. */
function friendlyGenerateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('manifest not found') ||
    message.includes('migrations directory does not exist') ||
    message.includes('no migrations found')
  ) {
    return `${message}\n${DOCS_HINT}`;
  }
  return message;
}

function runGenerateOnce(args: GenerateArgs): void {
  let result: ReturnType<typeof generate>;
  try {
    result = generate(args.manifestDir);
  } catch (error) {
    fail(friendlyGenerateError(error));
  }
  if (args.check) {
    const drift = checkOutputs(result);
    if (drift.length > 0) {
      fail(`generated output is out of date:\n${drift.join('\n')}`);
    }
    console.log('generated output is up to date');
    return;
  }
  writeOutputs(result);
  for (const output of result.outputs) {
    console.log(`wrote ${output.path}`);
  }
}

/** `--watch`: regenerate on any change under the manifest dir. Uses Bun's
 * `fs.watch` recursively; debounced so a burst of writes triggers one run. */
function runGenerateWatch(args: GenerateArgs): void {
  const dir = resolve(args.manifestDir);
  const safeRun = (): void => {
    try {
      const result = generate(args.manifestDir);
      // Skip the write when the outputs are already fresh — otherwise writing
      // them (they live under the watched dir) would re-trigger the watcher in
      // a loop.
      if (checkOutputs(result).length === 0) return;
      writeOutputs(result);
      console.log(`regenerated ${result.modulePath}`);
    } catch (error) {
      // In watch mode a bad intermediate state is expected — report, don't die.
      console.error(friendlyGenerateError(error));
    }
  };
  safeRun();
  console.log(`watching ${dir} for changes (Ctrl-C to stop)…`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(dir, { recursive: true }, () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(safeRun, 50);
  });
}

export function runCli(argv: readonly string[]): void {
  const command = argv[0];
  if (command === 'generate') {
    const args = parseGenerateArgs(argv.slice(1));
    if (args.watch) {
      runGenerateWatch(args);
      return;
    }
    runGenerateOnce(args);
    return;
  }
  if (command === 'init') {
    const dir = parseManifestDir(argv.slice(1));
    try {
      const result = initProject(dir);
      for (const path of result.written) console.log(`wrote ${path}`);
      console.log(
        '\nNext: `syncular generate` to build the typed schema, then wire ' +
          `${MANIFEST_FILENAME}'s "output.module" into your server + client.`,
      );
    } catch (error) {
      fail(error instanceof InitError ? error.message : String(error));
    }
    return;
  }
  fail(USAGE);
}

if (import.meta.main) {
  runCli(process.argv.slice(2));
}
