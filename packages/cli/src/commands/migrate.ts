import process from 'node:process';
import { configPathFromArgs, loadMigrationAdapter } from '../config';
import type {
  ChecksumMismatchMode,
  CommandResult,
  MigrationStatusResult,
  ParsedArgs,
} from '../types';

function parseChecksumMode(
  args: ParsedArgs
): ChecksumMismatchMode | { error: string } {
  const value = args.flagValues.get('--on-checksum-mismatch');
  if (!value) return 'error';
  if (value === 'error' || value === 'reset') return value;
  return {
    error: 'Invalid value for --on-checksum-mismatch. Use "error" or "reset".',
  };
}

function formatStatusResult(result: MigrationStatusResult): CommandResult {
  const pendingLabel =
    result.pendingVersions.length === 0
      ? '(none)'
      : result.pendingVersions.join(', ');

  return {
    title: 'Migrate Status',
    ok: true,
    lines: [
      `Current version: ${result.currentVersion}`,
      `Target version: ${result.targetVersion}`,
      `Pending versions: ${pendingLabel}`,
      ...(result.trackingTable
        ? [`Tracking table: ${result.trackingTable}`]
        : []),
    ],
  };
}

export async function runMigrateStatus(
  args: ParsedArgs
): Promise<CommandResult> {
  const cwd = process.cwd();
  const configPath = configPathFromArgs(args, cwd);
  const loaded = await loadMigrationAdapter({ configPath });
  if ('error' in loaded) {
    return {
      title: 'Migrate Status',
      ok: false,
      lines: [loaded.error],
    };
  }

  try {
    const result = await loaded.adapter.status({ cwd });
    return formatStatusResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      title: 'Migrate Status',
      ok: false,
      lines: [`Adapter status() failed: ${message}`],
    };
  }
}

export async function runMigrateUp(args: ParsedArgs): Promise<CommandResult> {
  const modeValue = parseChecksumMode(args);
  if (typeof modeValue !== 'string') {
    return {
      title: 'Migrate Up',
      ok: false,
      lines: [modeValue.error],
    };
  }

  if (modeValue === 'reset' && !args.flags.has('--yes')) {
    return {
      title: 'Migrate Up',
      ok: false,
      lines: [
        'Reset mode requires explicit confirmation.',
        'Re-run with: --on-checksum-mismatch reset --yes',
      ],
    };
  }

  const cwd = process.cwd();
  const dryRun = args.flags.has('--dry-run');
  const configPath = configPathFromArgs(args, cwd);
  const loaded = await loadMigrationAdapter({ configPath });
  if ('error' in loaded) {
    return {
      title: 'Migrate Up',
      ok: false,
      lines: [loaded.error],
    };
  }

  try {
    const result = await loaded.adapter.up({
      cwd,
      onChecksumMismatch: modeValue,
      dryRun,
    });

    const appliedLabel =
      result.appliedVersions.length === 0
        ? '(none)'
        : result.appliedVersions.join(', ');

    return {
      title: 'Migrate Up',
      ok: true,
      lines: [
        `Applied versions: ${appliedLabel}`,
        `Current version: ${result.currentVersion}`,
        `Checksum mismatch mode: ${modeValue}`,
        ...(result.wasReset ? ['Reset occurred: yes'] : ['Reset occurred: no']),
        ...(result.dryRun ? ['Dry run: yes'] : dryRun ? ['Dry run: yes'] : []),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      title: 'Migrate Up',
      ok: false,
      lines: [`Adapter up() failed: ${message}`],
    };
  }
}
