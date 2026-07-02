#!/usr/bin/env bun
/**
 * `syncular-v2 generate [--manifest-dir .] [--check]`
 *
 * Reads `syncular.json` + `migrations/` under the manifest dir and writes
 * the neutral IR JSON and the generated TS module next to it (paths
 * configurable via the manifest's `output`). `--check` regenerates in
 * memory and fails (exit 1) unless the files on disk match byte-exactly.
 */
import { checkOutputs, generate, writeOutputs } from './generate';

const USAGE = 'usage: syncular-v2 generate [--manifest-dir <dir>] [--check]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function runCli(argv: readonly string[]): void {
  if (argv[0] !== 'generate') {
    fail(USAGE);
  }
  let manifestDir = '.';
  let check = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--manifest-dir') {
      const value = argv[i + 1];
      if (value === undefined) fail('--manifest-dir requires a value');
      manifestDir = value;
      i += 1;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  let result: ReturnType<typeof generate>;
  try {
    result = generate(manifestDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (check) {
    const drift = checkOutputs(result);
    if (drift.length > 0) {
      fail(`generated output is out of date:\n${drift.join('\n')}`);
    }
    console.log('generated output is up to date');
    return;
  }
  writeOutputs(result);
  console.log(`wrote ${result.irPath}`);
  console.log(`wrote ${result.modulePath}`);
}

if (import.meta.main) {
  runCli(process.argv.slice(2));
}
