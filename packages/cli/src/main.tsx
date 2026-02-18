import process from 'node:process';
import { render } from 'ink';
import {
  normalizeCreateSubcommand,
  normalizeMigrateSubcommand,
  parseArgs,
  shouldRunInteractive,
} from './args';
import { runConsole } from './commands/console';
import { runCreateDemo, runCreateLibraries } from './commands/create';
import { runMigrateStatus, runMigrateUp } from './commands/migrate';
import { CLI_VERSION } from './constants';
import { CreateLibrariesWizardApp } from './create-libraries-wizard';
import { formatDoctorResult } from './doctor';
import { printHelp } from './help';
import { InteractiveApp } from './interactive';
import { printResult } from './output';
import type { ParsedArgs } from './types';

async function runNonInteractive(args: ParsedArgs): Promise<number> {
  if (args.flags.has('--help')) {
    printHelp();
    return 0;
  }

  if (args.flags.has('--version')) {
    console.log(CLI_VERSION);
    return 0;
  }

  if (args.command === 'help') {
    printHelp();
    return 0;
  }

  if (args.command === 'version') {
    console.log(CLI_VERSION);
    return 0;
  }

  if (args.command === 'doctor') {
    const result = formatDoctorResult(process.cwd());
    printResult(result);
    return result.ok ? 0 : 1;
  }

  if (args.command === 'console') {
    return runConsole(args);
  }

  if (args.command === 'create') {
    const subcommand = normalizeCreateSubcommand(args.subcommand);
    if (subcommand === 'libraries') {
      const result = await runCreateLibraries(args);
      printResult(result);
      return result.ok ? 0 : 1;
    }
    if (subcommand === 'demo') {
      const result = await runCreateDemo(args);
      printResult(result);
      return result.ok ? 0 : 1;
    }

    console.error(`Unknown create subcommand: ${args.subcommand ?? '<none>'}`);
    console.error('Try: syncular create');
    console.error('Try: syncular create demo');
    return 1;
  }

  if (args.command === 'migrate') {
    const subcommand = normalizeMigrateSubcommand(args.subcommand);
    if (subcommand === 'status') {
      const result = await runMigrateStatus(args);
      printResult(result);
      return result.ok ? 0 : 1;
    }
    if (subcommand === 'up') {
      const result = await runMigrateUp(args);
      printResult(result);
      return result.ok ? 0 : 1;
    }

    console.error(`Unknown migrate subcommand: ${args.subcommand ?? '<none>'}`);
    console.error('Try: syncular migrate status');
    console.error('Try: syncular migrate up');
    return 1;
  }

  if (args.command === null && args.positionals.length > 0) {
    const unknownCommand = args.positionals[0] ?? '<none>';
    console.error(`Unknown command: ${unknownCommand}`);
    printHelp();
    return 1;
  }

  printHelp();
  return 0;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const helpOrVersionRequested =
    args.flags.has('--help') ||
    args.flags.has('--version') ||
    args.command === 'help' ||
    args.command === 'version';

  const interactiveRequested =
    args.command === 'interactive' ||
    (args.command === null && args.positionals.length === 0) ||
    (args.command === 'migrate' && args.subcommand === null) ||
    (args.command === 'create' &&
      (args.subcommand === null || args.subcommand === 'libraries'));

  if (
    !helpOrVersionRequested &&
    interactiveRequested &&
    shouldRunInteractive(args)
  ) {
    if (
      args.command === 'create' &&
      (args.subcommand === null || args.subcommand === 'libraries')
    ) {
      render(
        <CreateLibrariesWizardApp
          args={parseArgs(['create', ...argv.slice(1)])}
        />
      );
      return;
    }
    render(<InteractiveApp initialCommand={args.command} />);
    return;
  }

  const exitCode = await runNonInteractive(args);
  process.exit(exitCode);
}
