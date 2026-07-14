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
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatSyql } from './fmt';
import { checkOutputs, generate, loadQueries, writeOutputs } from './generate';
import { InitError, initProject } from './init';
import { runLspStdio } from './lsp';
import { MANIFEST_FILENAME, parseManifest } from './manifest';

const DOCS_HINT =
  'See the schema guide: https://github.com/bkniffler/syncular (guide-schema), ' +
  'or run `syncular init` to scaffold a starter manifest + migration.';

const USAGE = `usage: syncular <command> [options]

commands:
  generate   build the IR + typed module from syncular.json + migrations/
  fmt        format .syql query files canonically (one style, no options)
  lsp        run the .syql language server over stdio (editor tooling)
  init       scaffold a starter syncular.json + migrations/0001_initial

generate options:
  --manifest-dir <dir>   directory holding syncular.json (default: .)
  --check                fail unless generated files are byte-exactly fresh
  --watch                regenerate on file change (Ctrl-C to stop)
  --print <name>         print one named query's lowered, checked SQL
                         (params, tables, knob variants) and exit

fmt options:
  [files…]               .syql files to format (default: the manifest's
                         queries directory, recursively)
  --manifest-dir <dir>   directory holding syncular.json (default: .)
  --check                fail unless every file is already canonical

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
  print: string | undefined;
}

function parseGenerateArgs(argv: readonly string[]): GenerateArgs {
  const args: GenerateArgs = {
    manifestDir: '.',
    check: false,
    watch: false,
    print: undefined,
  };
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
    } else if (arg === '--print') {
      const value = argv[i + 1];
      if (value === undefined) fail('--print requires a query name');
      args.print = value;
      i += 1;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (args.check && args.watch) {
    fail('--check and --watch cannot be combined');
  }
  if (args.print !== undefined && (args.check || args.watch)) {
    fail('--print cannot be combined with --check/--watch');
  }
  return args;
}

/** `generate --print <name>`: "what does this actually run" — the lowered,
 * checked SQL for one named query, plus its params/tables/knob variants. */
function runGeneratePrint(args: GenerateArgs, name: string): void {
  let result: ReturnType<typeof generate>;
  try {
    result = generate(args.manifestDir);
  } catch (error) {
    fail(friendlyGenerateError(error));
  }
  const query = result.queries.find((q) => q.name === name);
  if (query === undefined) {
    const known = result.queries.map((q) => q.name).join(', ');
    fail(
      `no named query ${JSON.stringify(name)} — this manifest defines: ${known.length > 0 ? known : '(none)'}`,
    );
  }
  console.log(`-- ${query.name} (${query.file})`);
  console.log(`-- tables: ${query.tables.join(', ')}`);
  if (query.syql !== undefined) {
    console.log('-- revision: SYQL 1');
    console.log(`-- backend: ${query.syql.plan.backend}`);
    if (query.syql.inputs.length > 0) {
      console.log('-- public inputs:');
      for (const input of query.syql.inputs) {
        if (input.kind === 'value') {
          console.log(
            `--   ${input.name}: ${input.type}${input.nullable ? ' | null' : ''} (${input.required ? 'required' : 'optional'})`,
          );
        } else if (input.kind === 'group') {
          console.log(
            `--   ${input.name}: optional group (${input.members.map((member) => `${member.name}: ${member.type}${member.nullable ? ' | null' : ''}`).join(', ')})`,
          );
        } else if (input.kind === 'switch') {
          console.log(`--   ${input.name}: switch (default false)`);
        } else if (input.kind === 'sort') {
          console.log(
            `--   ${input.name}: sort [${input.profiles.map((profile) => profile.name).join(', ')}] (default ${input.defaultProfile})`,
          );
        } else {
          console.log(
            `--   ${input.name}: page 1..${input.maxSize} (default ${input.defaultSize})`,
          );
        }
      }
    }
    if (query.syql.identity !== undefined) {
      console.log(`-- identity: ${query.syql.identity.join(', ')}`);
    }
    console.log(
      `-- checked statements: ${query.syql.plan.statements.length} (activation controls: ${query.syql.plan.activationControls.join(', ') || 'none'})`,
    );
    for (const statement of query.syql.plan.statements) {
      const selectors = [
        ...(statement.activationMask === undefined
          ? []
          : [`mask=${statement.activationMask}`]),
        ...(statement.sortProfile === undefined
          ? []
          : [`sort=${statement.sortProfile}`]),
      ];
      console.log(`-- [${selectors.join(', ') || 'default'}]`);
      console.log(statement.sql);
      console.log(
        `-- binds: ${statement.binds.map((bind) => `:${bind.name}`).join(', ') || '(none)'}`,
      );
    }
    return;
  }
  if (query.params.length > 0) {
    console.log('-- params:');
    for (const param of query.params) {
      console.log(`--   :${param.name} ${param.type} (required)`);
    }
  }
  console.log(query.sql);
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

/** `syncular fmt`: canonicalize `.syql` files in place (or `--check`). */
function runFmt(argv: readonly string[]): void {
  let manifestDir = '.';
  let check = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--check') check = true;
    else if (arg === '--manifest-dir') {
      const value = argv[i + 1];
      if (value === undefined) fail('--manifest-dir requires a value');
      manifestDir = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    } else {
      files.push(arg);
    }
  }
  let targets: string[];
  if (files.length > 0) {
    targets = files.map((f) => resolve(f));
  } else {
    const manifestPath = resolve(manifestDir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      fail(
        `no files given and no ${MANIFEST_FILENAME} in ${manifestDir} — pass .syql files or --manifest-dir`,
      );
    }
    const manifest = parseManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    );
    const queriesDir = resolve(manifestDir, manifest.queries);
    targets = loadQueries(queriesDir)
      .filter((q) => q.file.endsWith('.syql'))
      .map((q) => resolve(queriesDir, q.file));
  }
  if (targets.length === 0) {
    console.log('no .syql files to format');
    return;
  }
  let drifted = 0;
  for (const path of targets) {
    if (!path.endsWith('.syql')) {
      fail(`fmt formats .syql files only, got ${path}`);
    }
    const source = readFileSync(path, 'utf8');
    let formatted: string;
    try {
      formatted = formatSyql(path, source);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (formatted === source) continue;
    drifted += 1;
    if (check) {
      console.error(`${path}: not canonical — run \`syncular fmt\``);
    } else {
      writeFileSync(path, formatted, 'utf8');
      console.log(`formatted ${path}`);
    }
  }
  if (check && drifted > 0) process.exit(1);
  if (drifted === 0) console.log('all .syql files canonical');
}

export function runCli(argv: readonly string[]): void {
  const command = argv[0];
  if (command === 'generate') {
    const args = parseGenerateArgs(argv.slice(1));
    if (args.print !== undefined) {
      runGeneratePrint(args, args.print);
      return;
    }
    if (args.watch) {
      runGenerateWatch(args);
      return;
    }
    runGenerateOnce(args);
    return;
  }
  if (command === 'fmt') {
    runFmt(argv.slice(1));
    return;
  }
  if (command === 'lsp') {
    void runLspStdio();
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
