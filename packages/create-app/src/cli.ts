#!/usr/bin/env node
/**
 * `create-syncular-app [project-name] [--template <minimal|web>] [--local]`
 *
 * Runnable as `bun create syncular-app my-app` or `bunx create-syncular-app
 * my-app`. Prompts for anything a flag did not supply. Scaffolds one of the
 * two templates (see `./scaffold`).
 */
import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CREATE_BIN, PRODUCT_NAME } from './constants';
import {
  isTemplateName,
  scaffoldApp,
  TEMPLATES,
  type TemplateName,
} from './scaffold';

interface ParsedArgs {
  readonly help: boolean;
  readonly local: boolean;
  readonly projectName?: string;
  readonly template?: TemplateName;
}

function usage(): string {
  return `usage: ${CREATE_BIN} [project-name] [options]

Scaffolds a ${PRODUCT_NAME} v2 starter app.

templates:
  minimal   server + a terminal two-client convergence demo (no browser)
  web       Hono server + WebSocket + a single-pane browser todo app
            (worker core on OPFS)

options:
  --template <name>   one of: ${TEMPLATES.join(', ')} (prompts if omitted)
  --local             keep workspace:* deps (scaffolding inside this repo)
  -h, --help          show this help

examples:
  bun create syncular-app my-app
  bunx ${CREATE_BIN} my-app --template web
`;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let local = false;
  let projectName: string | undefined;
  let template: TemplateName | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--local') {
      local = true;
    } else if (arg === '--template') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--template requires a value');
      if (!isTemplateName(value)) {
        throw new Error(
          `unknown template ${JSON.stringify(value)} (expected: ${TEMPLATES.join(', ')})`,
        );
      }
      template = value;
      i += 1;
    } else if (arg?.startsWith('-')) {
      throw new Error(`unknown option ${JSON.stringify(arg)}\n\n${usage()}`);
    } else if (projectName === undefined) {
      projectName = arg;
    } else {
      throw new Error(`unexpected extra argument ${JSON.stringify(arg)}`);
    }
  }
  return {
    help,
    local,
    ...(projectName !== undefined ? { projectName } : {}),
    ...(template !== undefined ? { template } : {}),
  };
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveTemplate(
  supplied: TemplateName | undefined,
): Promise<TemplateName> {
  if (supplied !== undefined) return supplied;
  const answer = await prompt(
    `Template? (${TEMPLATES.join(' / ')}) [minimal]: `,
  );
  if (answer === '') return 'minimal';
  if (!isTemplateName(answer)) {
    throw new Error(
      `unknown template ${JSON.stringify(answer)} (expected: ${TEMPLATES.join(', ')})`,
    );
  }
  return answer;
}

function nextSteps(dir: string, template: TemplateName): string {
  const cd = `  cd ${dir}\n  bun install`;
  const run =
    template === 'web'
      ? '  bun run dev          # http://localhost:8787'
      : '  bun run server       # terminal 1\n  bun run clients      # terminal 2 — prints "✓ converged"';
  return `\nDone. Next steps:\n\n${cd}\n  bun run generate     # migrations → src/syncular.generated.ts\n${run}\n\nSee README.md for the layout and what to edit first.\n`;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[${CREATE_BIN}] ${describe(error)}`);
    return 1;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }

  try {
    let projectName = args.projectName;
    if (projectName === undefined || projectName === '') {
      projectName = await prompt('Project directory (e.g. my-app): ');
    }
    if (projectName === '') {
      console.error(`[${CREATE_BIN}] a project directory is required`);
      return 1;
    }
    const template = await resolveTemplate(args.template);

    const result = scaffoldApp({
      template,
      targetDir: projectName,
      local: args.local,
    });

    const displayDir = relative(process.cwd(), result.targetDir) || '.';
    console.log(
      `[${CREATE_BIN}] scaffolded ${result.packageName} (template: ${template}) into ${displayDir}`,
    );
    console.log(nextSteps(displayDir, template));
    return 0;
  } catch (error) {
    console.error(`[${CREATE_BIN}] ${describe(error)}`);
    return 1;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  process.exitCode = await runCli();
}
