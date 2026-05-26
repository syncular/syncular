import { describe, expect, it } from 'bun:test';
import { buildGenerateSteps, parseSyncularCliArgs } from './cli';

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
});
