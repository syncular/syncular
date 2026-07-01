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
  runDoctorCommand,
  runOpsCheckCommand,
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

  it('parses the doctor command', () => {
    expect(
      parseSyncularCliArgs([
        'doctor',
        '--manifest-dir',
        './app',
        '--schema-config=./generated/config.json',
        '--migrations-dir',
        './db/migrations',
        '--generated-client',
        './src/generated/client.ts',
        '--generated-server=./src/generated/server.ts',
        '--ops-config',
        './ops/prod.json',
        '--require-ops',
        '--json',
        '--pretty',
      ])
    ).toEqual({
      kind: 'doctor',
      options: {
        manifestDir: './app',
        schemaConfig: './generated/config.json',
        migrationsDir: './db/migrations',
        generatedClient: './src/generated/client.ts',
        generatedServer: './src/generated/server.ts',
        opsConfig: './ops/prod.json',
        skipOps: false,
        requireOps: true,
        json: true,
        pretty: true,
      },
    });
  });

  it('parses the ops check command', () => {
    expect(
      parseSyncularCliArgs([
        'ops',
        'check',
        '--manifest-dir',
        './app',
        '--config=./ops/prod.json',
        '--max-restore-drill-age-days',
        '30',
        '--max-blob-consistency-age-days=2',
        '--max-credential-review-age-days',
        '45',
        '--max-rate-limit-review-age-days=60',
        '--max-log-retention-review-age-days',
        '75',
        '--max-support-window-review-age-days=120',
        '--json',
        '--pretty',
      ])
    ).toEqual({
      kind: 'ops-check',
      options: {
        manifestDir: './app',
        config: './ops/prod.json',
        json: true,
        pretty: true,
        maxRestoreDrillAgeDays: 30,
        maxBlobConsistencyAgeDays: 2,
        maxCredentialReviewAgeDays: 45,
        maxRateLimitReviewAgeDays: 60,
        maxLogRetentionReviewAgeDays: 75,
        maxSupportWindowReviewAgeDays: 120,
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

  it('checks production ops evidence from the deployment runbook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-ops-check-'));
    try {
      writeOpsCheckFixture(dir);

      const result = runOpsCheckCommand(
        { manifestDir: dir, json: true, pretty: false },
        { now: () => new Date('2026-07-01T00:00:00.000Z') }
      );

      expect(result).toEqual({
        generatedAt: '2026-07-01T00:00:00.000Z',
        status: 'ready',
        ready: true,
        manifestDir: dir,
        configPath: join(dir, 'syncular.ops.json'),
        environment: 'production',
        checks: {
          schemaReadiness: 'ready',
          restoreDrill: 'ready',
          blobConsistency: 'ready',
          credentialRotation: 'ready',
          rateLimits: 'ready',
          logRetention: 'ready',
          supportWindow: 'ready',
        },
        issues: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs doctor with schema readiness and optional missing ops evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-doctor-'));
    try {
      writeSchemaCheckFixture(dir, { migrationCount: 2, generatedVersion: 2 });

      const result = runDoctorCommand(
        {
          manifestDir: dir,
          skipOps: false,
          requireOps: false,
          json: true,
          pretty: false,
        },
        { now: () => new Date('2026-07-01T00:00:00.000Z') }
      );

      expect(result.ready).toBe(true);
      expect(result.status).toBe('ready');
      expect(result.checks.schema).toMatchObject({
        name: 'schema',
        status: 'ready',
        ready: true,
        issueCount: 0,
      });
      expect(result.checks.ops).toMatchObject({
        name: 'ops',
        status: 'skipped',
        ready: null,
        issueCount: 0,
        skippedReason: 'ops_config_missing',
      });
      expect(result.ops).toBeNull();
      expect(result.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails doctor when required ops evidence is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-doctor-'));
    try {
      writeSchemaCheckFixture(dir, { migrationCount: 1, generatedVersion: 1 });

      const result = runDoctorCommand(
        {
          manifestDir: dir,
          skipOps: false,
          requireOps: true,
          json: true,
          pretty: false,
        },
        { now: () => new Date('2026-07-01T00:00:00.000Z') }
      );

      expect(result.ready).toBe(false);
      expect(result.status).toBe('not-ready');
      expect(result.checks.ops).toMatchObject({
        status: 'not-ready',
        ready: false,
        issueCount: 8,
      });
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'ops',
            code: 'ops.config_missing',
            recommendedAction: 'createOpsReadinessFile',
          }),
        ])
      );
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'ops',
            code: 'ops.schema_readiness_missing',
            recommendedAction: 'runSchemaChecks',
          }),
        ])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs doctor with production ops evidence when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-doctor-'));
    try {
      writeSchemaCheckFixture(dir, { migrationCount: 3, generatedVersion: 3 });
      writeOpsCheckFixture(dir);

      const result = runDoctorCommand(
        {
          manifestDir: dir,
          skipOps: false,
          requireOps: false,
          json: true,
          pretty: false,
        },
        { now: () => new Date('2026-07-01T00:00:00.000Z') }
      );

      expect(result.ready).toBe(true);
      expect(result.checks.ops).toMatchObject({
        name: 'ops',
        status: 'ready',
        ready: true,
        issueCount: 0,
      });
      expect(result.ops?.environment).toBe('production');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aggregates schema and ops issues from doctor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-doctor-'));
    try {
      writeSchemaCheckFixture(dir, { migrationCount: 2, generatedVersion: 1 });
      writeOpsCheckFixture(dir, {
        restoreCompletedAt: '2026-01-01T00:00:00.000Z',
      });

      const result = runDoctorCommand(
        {
          manifestDir: dir,
          skipOps: false,
          requireOps: false,
          json: true,
          pretty: false,
        },
        { now: () => new Date('2026-07-01T00:00:00.000Z') }
      );

      expect(result.ready).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'schema',
            code: 'schema.generated_output_stale',
            recommendedAction: 'runSyncularGenerate',
          }),
          expect.objectContaining({
            source: 'ops',
            code: 'ops.restore_drill_stale',
            recommendedAction: 'runRestoreDrill',
          }),
        ])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports stale or failed production ops evidence with stable issue codes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-ops-check-'));
    try {
      writeOpsCheckFixture(dir, {
        restoreCompletedAt: '2026-01-01T00:00:00.000Z',
        blobStatus: 'fail',
        credentialReviewedAt: '2026-01-01T00:00:00.000Z',
        rateLimitStatus: 'disabled',
        logRetentionReviewedAt: '2026-01-01T00:00:00.000Z',
        payloadSnapshotPolicy: '',
        pruneActiveWindowDays: 7,
      });

      const result = runOpsCheckCommand(
        { manifestDir: dir, json: true, pretty: false },
        { now: () => new Date('2026-07-01T00:00:00.000Z') }
      );

      expect(result.ready).toBe(false);
      expect(result.status).toBe('not-ready');
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'ops.restore_drill_stale',
            recommendedAction: 'runRestoreDrill',
          }),
          expect.objectContaining({
            code: 'ops.blob_consistency_status_invalid',
            recommendedAction: 'runBlobConsistencyCheck',
          }),
          expect.objectContaining({
            code: 'ops.credential_rotation_stale',
            recommendedAction: 'reviewCredentialRotation',
          }),
          expect.objectContaining({
            code: 'ops.rate_limits_status_invalid',
            recommendedAction: 'tuneRateLimits',
          }),
          expect.objectContaining({
            code: 'ops.log_retention_stale',
            recommendedAction: 'reviewLogRetention',
          }),
          expect.objectContaining({
            code: 'ops.log_retention_payload_policy_missing',
            recommendedAction: 'reviewLogRetention',
          }),
          expect.objectContaining({
            code: 'ops.support_window_prune_window_invalid',
            recommendedAction: 'reviewSupportWindow',
          }),
        ])
      );
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

function writeOpsCheckFixture(
  dir: string,
  options: {
    restoreCompletedAt?: string;
    blobStatus?: string;
    credentialReviewedAt?: string;
    rateLimitStatus?: string;
    logRetentionReviewedAt?: string;
    payloadSnapshotPolicy?: string;
    pruneActiveWindowDays?: number;
  } = {}
): void {
  writeFileSync(
    join(dir, 'syncular.ops.json'),
    JSON.stringify({
      environment: 'production',
      schemaReadiness: {
        status: 'ready',
        ready: true,
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
      restoreDrill: {
        completedAt: options.restoreCompletedAt ?? '2026-06-15T00:00:00.000Z',
        restoreMinutes: 12,
        expectedClientRebootstrapLoad: 'normal weekday client population',
        rollbackDecision: 'roll forward unless schema readiness fails',
      },
      blobConsistency: {
        required: true,
        status: options.blobStatus ?? 'pass',
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
      credentialRotation: {
        reviewedAt: options.credentialReviewedAt ?? '2026-06-15T00:00:00.000Z',
        owners: {
          auth: 'identity team',
          console: 'platform team',
          storage: 'storage team',
        },
      },
      rateLimits: {
        reviewedAt: '2026-06-15T00:00:00.000Z',
        status: options.rateLimitStatus ?? 'enabled',
      },
      logRetention: {
        reviewedAt:
          options.logRetentionReviewedAt ?? '2026-06-15T00:00:00.000Z',
        requestEventRetentionDays: 14,
        operationEventRetentionDays: 30,
        payloadSnapshotPolicy:
          options.payloadSnapshotPolicy ?? 'redacted-bounded',
      },
      supportWindow: {
        reviewedAt: '2026-06-15T00:00:00.000Z',
        offlineWindowDays: 14,
        pruneActiveWindowDays: options.pruneActiveWindowDays ?? 14,
        fullHistoryHours: 168,
      },
    })
  );
}
