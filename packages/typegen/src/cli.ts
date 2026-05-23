#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import {
  loadSyncularClientContract,
  toSyncularCodegenJson,
  writeSyncularCodegenJsonFromModule,
} from './app-contract';

interface CodegenConfigCommand {
  app: string;
  out: string;
  exportName?: string;
  check: boolean;
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== 'codegen-config') {
    printUsageAndExit(command ? `Unknown command ${command}` : undefined);
  }
  const options = parseCodegenConfigArgs(argv.slice(1));
  if (options.check) {
    const contract = await loadSyncularClientContract({
      modulePath: options.app,
      exportName: options.exportName,
    });
    const expected = toSyncularCodegenJson(contract);
    const actual = await readFile(options.out, 'utf8').catch((error) => {
      throw new Error(
        `Cannot read ${options.out}; run without --check to generate it first: ${error.message}`
      );
    });
    if (actual !== expected) {
      throw new Error(
        `${options.out} does not match ${options.app}; run syncular-typegen codegen-config --app ${options.app} --out ${options.out}`
      );
    }
    return;
  }
  await writeSyncularCodegenJsonFromModule({
    modulePath: options.app,
    exportName: options.exportName,
    outputPath: options.out,
  });
}

function parseCodegenConfigArgs(args: string[]): CodegenConfigCommand {
  let app: string | undefined;
  let out = 'syncular.codegen.json';
  let exportName: string | undefined;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--app') {
      app = requireValue(args, (index += 1), '--app');
    } else if (arg === '--out') {
      out = requireValue(args, (index += 1), '--out');
    } else if (arg === '--export') {
      exportName = requireValue(args, (index += 1), '--export');
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit();
    } else {
      printUsageAndExit(`Unknown option ${arg}`);
    }
  }
  if (!app) printUsageAndExit('Missing --app');
  return { app, out, exportName, check };
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    printUsageAndExit(`${option} requires a value`);
  }
  return value;
}

function printUsageAndExit(message?: string): never {
  if (message) console.error(message);
  console.error(
    [
      'Usage:',
      '  syncular-typegen codegen-config --app ./syncular.app.ts [--out ./syncular.codegen.json] [--export app] [--check]',
    ].join('\n')
  );
  process.exit(message ? 1 : 0);
}

await main(process.argv.slice(2));
