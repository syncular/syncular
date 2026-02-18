import process from 'node:process';
import type { MigrateSubcommand, ParsedArgs, RootCommand } from './types';

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const flagValues = new Map<string, string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > 0) {
        const key = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);
        flags.add(key);
        flagValues.set(key, value);
        continue;
      }

      const key = arg;
      const next = argv[i + 1];
      const nextIsValue =
        typeof next === 'string' && next.length > 0 && !next.startsWith('-');
      flags.add(key);
      if (nextIsValue && next) {
        flagValues.set(key, next);
        i += 1;
      }
      continue;
    }

    flags.add(arg);
  }

  const commandCandidate = positionals[0] ?? null;
  const subcommand = positionals[1] ?? null;
  const command = normalizeRootCommand(commandCandidate);

  return {
    command,
    subcommand,
    flags,
    flagValues,
    positionals,
  };
}

function normalizeRootCommand(value: string | null): RootCommand | null {
  if (!value) return null;
  if (value === 'help') return 'help';
  if (value === 'version') return 'version';
  if (value === 'doctor') return 'doctor';
  if (value === 'migrate') return 'migrate';
  if (value === 'create') return 'create';
  if (value === 'console') return 'console';
  if (value === 'interactive') return 'interactive';
  return null;
}

export function normalizeMigrateSubcommand(
  value: string | null
): MigrateSubcommand | null {
  if (value === 'status') return 'status';
  if (value === 'up') return 'up';
  return null;
}

export function normalizeCreateSubcommand(
  value: string | null
): 'libraries' | 'demo' | null {
  if (value === null) return 'libraries';
  if (value === 'libraries') return 'libraries';
  if (value === 'demo') return 'demo';
  return null;
}

export function shouldRunInteractive(args: ParsedArgs): boolean {
  if (args.flags.has('--no-interactive')) return false;
  if (args.flags.has('--interactive')) return true;
  return process.stdout.isTTY === true;
}
