/**
 * CLI end-to-end: generate writes both outputs; --check passes on fresh
 * outputs, fails (exit 1) on drift or missing files; bad args fail.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
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
  cpSync(
    join(FIXTURE, 'syncular.migrations.lock.json'),
    join(dir, 'syncular.migrations.lock.json'),
  );
  return dir;
}

function replaceInFile(path: string, before: string, after: string): void {
  const source = readFileSync(path, 'utf8');
  expect(source).toContain(before);
  writeFileSync(path, source.replace(before, after), 'utf8');
}

function appendNullableMigration(dir: string): void {
  const migrationDir = join(dir, 'migrations', '0005_add_task_reviewer');
  cpSync(join(dir, 'migrations', '0004_add_doc_blob_ref'), migrationDir, {
    recursive: true,
  });
  writeFileSync(
    join(migrationDir, 'up.sql'),
    'ALTER TABLE tasks ADD COLUMN reviewer TEXT;\n',
    'utf8',
  );
  const manifestPath = join(dir, 'syncular.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersions: Array<{ version: number; through: string }>;
  };
  manifest.schemaVersions.push({
    version: 5,
    through: '0005_add_task_reviewer',
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function appendRequiredMigration(dir: string): void {
  const migrationDir = join(dir, 'migrations', '0005_add_task_reviewer');
  cpSync(join(dir, 'migrations', '0004_add_doc_blob_ref'), migrationDir, {
    recursive: true,
  });
  writeFileSync(
    join(migrationDir, 'up.sql'),
    "ALTER TABLE tasks ADD COLUMN reviewer TEXT NOT NULL DEFAULT 'unassigned';\n",
    'utf8',
  );
  const manifestPath = join(dir, 'syncular.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersions: Array<{ version: number; through: string }>;
  };
  manifest.schemaVersions.push({
    version: 5,
    through: '0005_add_task_reviewer',
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
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

describe('syncular generate', () => {
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

describe('immutable migration history', () => {
  test('baseline is explicit, checkable, and refuses replacement', () => {
    const dir = freshDir();
    unlinkSync(join(dir, 'syncular.migrations.lock.json'));

    const missing = runCli(['migrations', 'check', '--manifest-dir', dir]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('migrations baseline');

    const baseline = runCli(['migrations', 'baseline', '--manifest-dir', dir]);
    expect(baseline.exitCode).toBe(0);
    expect(baseline.stdout).toContain('commit this migration baseline');
    expect(
      runCli(['migrations', 'check', '--manifest-dir', dir]).exitCode,
    ).toBe(0);

    const replacement = runCli([
      'migrations',
      'baseline',
      '--manifest-dir',
      dir,
    ]);
    expect(replacement.exitCode).toBe(1);
    expect(replacement.stderr).toContain('refusing to replace');
  });

  test('editing, removing, or reordering locked migrations fails before generation', () => {
    const cases: Array<{
      name: string;
      mutate: (dir: string) => void;
      evidence: string;
    }> = [
      {
        name: 'text edit',
        mutate: (dir) =>
          appendFileSync(
            join(dir, 'migrations', '0002_add_task_estimate', 'up.sql'),
            '\n-- changed after deployment\n',
          ),
        evidence: 'schema shape is unchanged',
      },
      {
        name: 'removal',
        mutate: (dir) =>
          rmSync(join(dir, 'migrations', '0002_add_task_estimate'), {
            recursive: true,
          }),
        evidence: 'locked "0002_add_task_estimate"',
      },
      {
        name: 'reorder',
        mutate: (dir) =>
          renameSync(
            join(dir, 'migrations', '0002_add_task_estimate'),
            join(dir, 'migrations', '0005_add_task_estimate'),
          ),
        evidence: 'cannot be removed, renamed, or reordered',
      },
      {
        name: 'nullability change',
        mutate: (dir) =>
          replaceInFile(
            join(dir, 'migrations', '0001_initial', 'up.sql'),
            'reviewed BOOLEAN,',
            'reviewed BOOLEAN NOT NULL,',
          ),
        evidence: 'column "reviewed" changed nullability',
      },
      {
        name: 'type change',
        mutate: (dir) =>
          replaceInFile(
            join(dir, 'migrations', '0002_add_task_estimate', 'up.sql'),
            'estimate FLOAT',
            'estimate TEXT',
          ),
        evidence: 'column "estimate" changed type from float to string',
      },
    ];

    for (const scenario of cases) {
      const dir = freshDir();
      scenario.mutate(dir);
      const run = runCli(['generate', '--manifest-dir', dir]);
      expect(run.exitCode, scenario.name).toBe(1);
      expect(run.stderr, scenario.name).toContain('history drift');
      expect(run.stderr, scenario.name).toContain(scenario.evidence);
      expect(run.stderr, scenario.name).toContain('append a new migration');
      expect(run.stderr, scenario.name).not.toContain(dir);
    }
  });

  test('an inserted required column identifies the migration, table, and first column', () => {
    const dir = freshDir();
    replaceInFile(
      join(dir, 'migrations', '0001_initial', 'up.sql'),
      '  project_id TEXT NOT NULL,\n  title TEXT NOT NULL,',
      '  project_id TEXT NOT NULL,\n  device_id TEXT NOT NULL,\n  title TEXT NOT NULL,',
    );
    const run = runCli(['migrations', 'check', '--manifest-dir', dir]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('migration "0001_initial"');
    expect(run.stderr).toContain('table "tasks", column 3');
    expect(run.stderr).toContain('"device_id" was inserted');
    expect(run.stderr).not.toContain(dir);
    expect(run.stderr).not.toContain('CREATE TABLE');
  });

  test('a new nullable migration extends the lock and matches a fresh baseline', () => {
    const upgradeDir = freshDir();
    expect(
      runCli(['migrations', 'upgrade-lock', '--manifest-dir', upgradeDir])
        .exitCode,
    ).toBe(0);
    appendNullableMigration(upgradeDir);
    const generated = runCli(['generate', '--manifest-dir', upgradeDir]);
    expect(generated.exitCode).toBe(0);
    expect(
      runCli(['migrations', 'check', '--manifest-dir', upgradeDir]).exitCode,
    ).toBe(0);

    const freshInstallDir = freshDir();
    appendNullableMigration(freshInstallDir);
    unlinkSync(join(freshInstallDir, 'syncular.migrations.lock.json'));
    expect(
      runCli(['migrations', 'baseline', '--manifest-dir', freshInstallDir])
        .exitCode,
    ).toBe(0);

    expect(
      readFileSync(join(upgradeDir, 'syncular.migrations.lock.json'), 'utf8'),
    ).toBe(
      readFileSync(
        join(freshInstallDir, 'syncular.migrations.lock.json'),
        'utf8',
      ),
    );
  });

  test('a required appended column fails generation and a fresh baseline before runtime', () => {
    const upgradeDir = freshDir();
    appendRequiredMigration(upgradeDir);
    for (const args of [
      ['generate', '--manifest-dir', upgradeDir],
      ['migrations', 'check', '--manifest-dir', upgradeDir],
    ]) {
      const run = runCli(args);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('0005_add_task_reviewer/up.sql');
      expect(run.stderr).toContain('added column "reviewer" must be nullable');
      expect(run.stderr).toContain('SQL defaults do not backfill');
      expect(run.stderr).not.toContain(upgradeDir);
    }

    const baselineDir = freshDir();
    appendRequiredMigration(baselineDir);
    unlinkSync(join(baselineDir, 'syncular.migrations.lock.json'));
    const baseline = runCli([
      'migrations',
      'baseline',
      '--manifest-dir',
      baselineDir,
    ]);
    expect(baseline.exitCode).toBe(1);
    expect(baseline.stderr).toContain(
      'added column "reviewer" must be nullable',
    );
    expect(baseline.stderr).not.toContain(baselineDir);
  });

  test('a format-1 lock stays valid and upgrades only through the explicit command', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'syncular.migrations.lock.json');
    const before = readFileSync(lockPath, 'utf8');
    expect(JSON.parse(before).formatVersion).toBe(1);
    expect(
      runCli(['migrations', 'check', '--manifest-dir', dir]).exitCode,
    ).toBe(0);

    // Ordinary generation preserves the committed representation.
    expect(runCli(['generate', '--manifest-dir', dir]).exitCode).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(before);

    const upgrade = runCli([
      'migrations',
      'upgrade-lock',
      '--manifest-dir',
      dir,
    ]);
    expect(upgrade.exitCode).toBe(0);
    expect(upgrade.stdout).toContain('compact format 2');
    const compact = readFileSync(lockPath, 'utf8');
    expect(JSON.parse(compact).formatVersion).toBe(2);
    expect(compact.length).toBeLessThan(before.length);
    expect(
      runCli(['migrations', 'check', '--manifest-dir', dir]).exitCode,
    ).toBe(0);

    const repeated = runCli([
      'migrations',
      'upgrade-lock',
      '--manifest-dir',
      dir,
    ]);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain('already uses the current compact');

    replaceInFile(
      join(dir, 'migrations', '0001_initial', 'up.sql'),
      '  project_id TEXT NOT NULL,\n  title TEXT NOT NULL,',
      '  project_id TEXT NOT NULL,\n  device_id TEXT NOT NULL,\n  title TEXT NOT NULL,',
    );
    const drift = runCli(['migrations', 'check', '--manifest-dir', dir]);
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr).toContain('migration "0001_initial"');
    expect(drift.stderr).toContain('table "tasks", column 3');
    expect(drift.stderr).toContain('"device_id" was inserted');
    expect(drift.stderr).not.toContain(dir);
  });

  test('format upgrade refuses drift and leaves the version-1 lock byte-exact', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'syncular.migrations.lock.json');
    const before = readFileSync(lockPath, 'utf8');
    appendFileSync(
      join(dir, 'migrations', '0002_add_task_estimate', 'up.sql'),
      '\n-- changed before upgrade\n',
    );

    const upgrade = runCli([
      'migrations',
      'upgrade-lock',
      '--manifest-dir',
      dir,
    ]);
    expect(upgrade.exitCode).toBe(1);
    expect(upgrade.stderr).toContain('history drift');
    expect(readFileSync(lockPath, 'utf8')).toBe(before);
  });
});
