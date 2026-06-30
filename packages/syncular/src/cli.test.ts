import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCodegenInstallArgs,
  buildGenerateSteps,
  isMainModuleEntrypoint,
  parseSyncularCliArgs,
  runSchemaCheckCommand,
} from './cli';

describe('syncular CLI', () => {
  it('parses the unified generate check command', () => {
    expect(
      parseSyncularCliArgs([
        'generate',
        '--check',
        '--manifest-dir',
        './app',
        '--migrations-dir=./db/migrations',
        '--rust-output-dir',
        './src/generated/rust',
        '--app',
        './syncular.app.ts',
      ])
    ).toEqual({
      kind: 'generate',
      options: {
        check: true,
        manifestDir: './app',
        migrationsDir: './db/migrations',
        rustOutputDir: './src/generated/rust',
        app: './syncular.app.ts',
      },
    });
  });

  it('parses the codegen installer command', () => {
    expect(
      parseSyncularCliArgs([
        'codegen',
        'install',
        '--version',
        '0.1.2',
        '--root',
        '/workspace/.cache/codegen',
        '--force',
      ])
    ).toEqual({
      kind: 'codegen-install',
      options: {
        version: '0.1.2',
        root: '/workspace/.cache/codegen',
        force: true,
      },
    });
  });

  it('parses the schema check command', () => {
    expect(
      parseSyncularCliArgs([
        'schema',
        'check',
        '--manifest-dir',
        './app',
        '--migrations-dir=./db/migrations',
        '--generated-client',
        './src/generated/client.ts',
        '--generated-server',
        './src/generated/server.ts',
        '--json',
        '--pretty',
      ])
    ).toEqual({
      kind: 'schema-check',
      options: {
        manifestDir: './app',
        migrationsDir: './db/migrations',
        generatedClient: './src/generated/client.ts',
        generatedServer: './src/generated/server.ts',
        json: true,
        pretty: true,
      },
    });
  });

  it('builds stable cargo install args for syncular-codegen', () => {
    expect(
      buildCodegenInstallArgs({
        version: '0.1.2',
        root: '/workspace/.cache/codegen',
        force: true,
      })
    ).toEqual([
      'install',
      'syncular-codegen',
      '--version',
      '0.1.2',
      '--locked',
      '--root',
      '/workspace/.cache/codegen',
      '--force',
    ]);
  });

  it('detects npm bin symlinks as the CLI entrypoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-cli-'));
    try {
      const distDir = join(dir, 'dist');
      const binDir = join(dir, 'node_modules', '.bin');
      const target = join(distDir, 'cli.js');
      const entrypoint = join(binDir, 'syncular');
      mkdirSync(distDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(target, '#!/usr/bin/env node\n');
      symlinkSync(target, entrypoint);

      expect(
        isMainModuleEntrypoint(entrypoint, pathToFileURL(target).href)
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs both generators when a Syncular app definition is present', () => {
    const steps = buildGenerateSteps(
      { check: true, manifestDir: './app' },
      {
        cwd: '/workspace',
        env: {
          SYNCULAR_TYPEGEN_BIN: 'typegen-bin',
          SYNCULAR_CODEGEN_BIN: 'codegen-bin',
        },
        fileExists: (path) => path === '/workspace/app/syncular.app.ts',
      }
    );

    expect(steps).toEqual([
      {
        label: 'Generate Syncular codegen config',
        command: 'typegen-bin',
        args: [
          'codegen-config',
          '--app',
          '/workspace/app/syncular.app.ts',
          '--out',
          '/workspace/app/generated/syncular.codegen.json',
          '--check',
        ],
      },
      {
        label: 'Generate Syncular app clients',
        command: 'codegen-bin',
        args: ['--manifest-dir', '/workspace/app', '--check'],
      },
    ]);
  });

  it('initializes Rust codegen config when no app definition or config exists', () => {
    const steps = buildGenerateSteps(
      {
        check: false,
        manifestDir: './app',
        migrationsDir: './migrations',
        rustOutputDir: './generated/rust',
      },
      {
        cwd: '/workspace',
        env: { SYNCULAR_CODEGEN_BIN: 'codegen-bin' },
        fileExists: () => false,
      }
    );

    expect(steps).toEqual([
      {
        label: 'Initialize Syncular codegen config',
        command: 'codegen-bin',
        args: [
          'init',
          '--manifest-dir',
          '/workspace/app',
          '--migrations-dir',
          '/workspace/migrations',
        ],
      },
      {
        label: 'Generate Syncular app clients',
        command: 'codegen-bin',
        args: [
          '--manifest-dir',
          '/workspace/app',
          '--migrations-dir',
          '/workspace/migrations',
          '--rust-output-dir',
          '/workspace/generated/rust',
        ],
      },
    ]);
  });

  it('runs Rust codegen directly when an existing config is present', () => {
    const steps = buildGenerateSteps(
      {
        check: true,
        manifestDir: './app',
      },
      {
        cwd: '/workspace',
        env: { SYNCULAR_CODEGEN_BIN: 'codegen-bin' },
        fileExists: (path) =>
          path === '/workspace/app/generated/syncular.codegen.json',
      }
    );

    expect(steps).toEqual([
      {
        label: 'Generate Syncular app clients',
        command: 'codegen-bin',
        args: ['--manifest-dir', '/workspace/app', '--check'],
      },
    ]);
  });

  it('fails clearly when an explicit app definition path is missing', () => {
    expect(() =>
      buildGenerateSteps(
        { check: false, manifestDir: '.', app: './missing.ts' },
        {
          cwd: '/workspace',
          fileExists: () => false,
        }
      )
    ).toThrow(
      'Syncular app definition not found: /workspace/missing.ts. Create syncular.app.ts'
    );
  });

  it('checks generated schema readiness from config, migrations, and generated outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-schema-check-'));
    try {
      writeSchemaCheckFixture(dir, { migrationCount: 2, generatedVersion: 2 });

      const result = runSchemaCheckCommand(
        { manifestDir: dir, json: true, pretty: false },
        { now: () => new Date('2026-06-30T00:00:00.000Z') }
      );

      expect(result).toEqual({
        generatedAt: '2026-06-30T00:00:00.000Z',
        status: 'ready',
        ready: true,
        manifestDir: dir,
        configPath: join(dir, 'generated/syncular.codegen.json'),
        migrationsDir: join(dir, 'migrations'),
        generatedClientPath: join(dir, 'src/generated/syncular.generated.ts'),
        generatedServerPath: join(
          dir,
          'src/generated/syncular.server.generated.ts'
        ),
        tableCount: 1,
        tables: ['tasks'],
        schemaVersion: {
          migrations: 2,
          generatedClient: 2,
          generatedServer: 2,
        },
        issues: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports stale generated output with a stable issue code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-schema-check-'));
    try {
      writeSchemaCheckFixture(dir, { migrationCount: 2, generatedVersion: 1 });

      const result = runSchemaCheckCommand({
        manifestDir: dir,
        json: true,
        pretty: false,
      });

      expect(result.ready).toBe(false);
      expect(result.status).toBe('not-ready');
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'schema.generated_output_stale',
          severity: 'error',
          recommendedAction: 'runSyncularGenerate',
          details: {
            migrationVersion: 2,
            generatedClientVersion: 1,
          },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeSchemaCheckFixture(
  dir: string,
  options: { migrationCount: number; generatedVersion: number }
): void {
  mkdirSync(join(dir, 'generated'), { recursive: true });
  mkdirSync(join(dir, 'src/generated'), { recursive: true });
  writeFileSync(
    join(dir, 'generated/syncular.codegen.json'),
    JSON.stringify({
      tables: {
        tasks: {
          serverVersionColumn: 'server_version',
          subscriptionId: 'sub-tasks',
        },
      },
      typescriptOutputPath: 'src/generated/syncular.generated.ts',
      typescriptServerOutputPath: 'src/generated/syncular.server.generated.ts',
    })
  );

  for (let index = 1; index <= options.migrationCount; index += 1) {
    const migrationDir = join(
      dir,
      'migrations',
      `${String(index).padStart(4, '0')}_migration`
    );
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(join(migrationDir, 'up.sql'), 'select 1;');
  }

  const generatedSource = `export const syncularGeneratedSchemaVersion = ${options.generatedVersion} as const;\n`;
  writeFileSync(
    join(dir, 'src/generated/syncular.generated.ts'),
    generatedSource
  );
  writeFileSync(
    join(dir, 'src/generated/syncular.server.generated.ts'),
    generatedSource
  );
}
