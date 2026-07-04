/**
 * `syncular-v2 init` and the CLI polish: init scaffolds a starter that
 * generates cleanly, refuses to clobber, and generate errors point at the
 * docs when inputs are missing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-init-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[]) {
  const r = Bun.spawnSync(['bun', CLI, ...args]);
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

describe('syncular-v2 init', () => {
  test('scaffolds a manifest + migration that then generates', () => {
    const dir = freshDir();
    const init = runCli(['init', '--manifest-dir', dir]);
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain('syncular.json');
    expect(existsSync(join(dir, 'syncular.json'))).toBe(true);
    expect(existsSync(join(dir, 'migrations', '0001_initial', 'up.sql'))).toBe(
      true,
    );

    const generated = runCli(['generate', '--manifest-dir', dir]);
    expect(generated.stderr).toBe('');
    expect(generated.exitCode).toBe(0);
    const check = runCli(['generate', '--manifest-dir', dir, '--check']);
    expect(check.exitCode).toBe(0);
  });

  test('refuses to overwrite an existing manifest', () => {
    const dir = freshDir();
    expect(runCli(['init', '--manifest-dir', dir]).exitCode).toBe(0);
    const again = runCli(['init', '--manifest-dir', dir]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already exists');
  });
});

describe('generate error UX', () => {
  test('missing manifest points at the docs / init', () => {
    const dir = freshDir();
    const run = runCli(['generate', '--manifest-dir', dir]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('manifest not found');
    expect(run.stderr).toContain('syncular-v2 init');
  });

  test('--check and --watch cannot combine', () => {
    const run = runCli(['generate', '--check', '--watch']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('cannot be combined');
  });

  test('unknown command fails with usage', () => {
    const run = runCli(['bogus']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('usage: syncular-v2');
  });
});
