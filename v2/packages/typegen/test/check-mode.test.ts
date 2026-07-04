/**
 * CLI end-to-end: generate writes both outputs; --check passes on fresh
 * outputs, fails (exit 1) on drift or missing files; bad args fail.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const FIXTURE = join(import.meta.dir, 'fixtures', 'basic');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Copy the fixture inputs (not the committed outputs) to a temp dir. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-typegen-'));
  tempDirs.push(dir);
  cpSync(join(FIXTURE, 'migrations'), join(dir, 'migrations'), {
    recursive: true,
  });
  cpSync(join(FIXTURE, 'queries'), join(dir, 'queries'), { recursive: true });
  cpSync(join(FIXTURE, 'syncular.json'), join(dir, 'syncular.json'));
  return dir;
}

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliRun {
  const result = Bun.spawnSync(['bun', CLI, ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('syncular-v2 generate', () => {
  test('generate then --check round-trips through the real CLI', () => {
    const dir = freshDir();
    const generated = runCli(['generate', '--manifest-dir', dir]);
    expect(generated.stderr).toBe('');
    expect(generated.exitCode).toBe(0);
    expect(generated.stdout).toContain('syncular.ir.json');
    expect(generated.stdout).toContain('syncular.generated.ts');

    const check = runCli(['generate', '--manifest-dir', dir, '--check']);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain('up to date');
  });

  test('--check fails on byte drift in the generated module', () => {
    const dir = freshDir();
    expect(runCli(['generate', '--manifest-dir', dir]).exitCode).toBe(0);
    appendFileSync(join(dir, 'syncular.generated.ts'), '\n// edited\n');
    const check = runCli(['generate', '--manifest-dir', dir, '--check']);
    expect(check.exitCode).toBe(1);
    expect(check.stderr).toContain('out of date');
    expect(check.stderr).toContain('syncular.generated.ts');
  });

  test('--check fails when an output file is missing', () => {
    const dir = freshDir();
    expect(runCli(['generate', '--manifest-dir', dir]).exitCode).toBe(0);
    unlinkSync(join(dir, 'syncular.ir.json'));
    const check = runCli(['generate', '--manifest-dir', dir, '--check']);
    expect(check.exitCode).toBe(1);
    expect(check.stderr).toContain('missing');
  });

  test('unsupported SQL fails the CLI with the construct named', () => {
    const dir = freshDir();
    appendFileSync(
      join(dir, 'migrations', '0002_add_task_estimate', 'up.sql'),
      '\nCREATE TRIGGER boom AFTER INSERT ON tasks BEGIN SELECT 1; END;\n',
    );
    const run = runCli(['generate', '--manifest-dir', dir]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('0002_add_task_estimate/up.sql');
    expect(run.stderr).toContain('TRIGGER');
  });

  test('bad arguments fail with usage', () => {
    expect(runCli([]).exitCode).toBe(1);
    expect(runCli(['generate', '--bogus']).stderr).toContain('--bogus');
    expect(runCli(['generate', '--manifest-dir']).stderr).toContain(
      'requires a value',
    );
  });
});
