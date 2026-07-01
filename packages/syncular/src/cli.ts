#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_APP_FILE = 'syncular.app.ts';
const DEFAULT_CODEGEN_CONFIG_FILE = 'generated/syncular.codegen.json';
const DEFAULT_OPS_CHECK_FILE = 'syncular.ops.json';
const SYNCULAR_CODEGEN_BIN = 'syncular-codegen';

export interface GenerateCommandOptions {
  check: boolean;
  manifestDir: string;
  migrationsDir?: string;
  rustOutputDir?: string;
  app?: string;
}

export interface CodegenInstallCommandOptions {
  version?: string;
  root?: string;
  force: boolean;
}

export interface SchemaCheckCommandOptions {
  manifestDir: string;
  config?: string;
  migrationsDir?: string;
  generatedClient?: string;
  generatedServer?: string;
  json: boolean;
  pretty: boolean;
}

export interface OpsCheckCommandOptions {
  manifestDir: string;
  config?: string;
  json: boolean;
  pretty: boolean;
  maxRestoreDrillAgeDays?: number;
  maxBlobConsistencyAgeDays?: number;
  maxCredentialReviewAgeDays?: number;
  maxRateLimitReviewAgeDays?: number;
}

export type SyncularCliCommand =
  | {
      kind: 'help';
      topic?: 'generate' | 'codegen-install' | 'schema-check' | 'ops-check';
    }
  | { kind: 'generate'; options: GenerateCommandOptions }
  | { kind: 'codegen-install'; options: CodegenInstallCommandOptions }
  | { kind: 'schema-check'; options: SchemaCheckCommandOptions }
  | { kind: 'ops-check'; options: OpsCheckCommandOptions };

export interface GenerateStep {
  label: string;
  command: string;
  args: string[];
}

export interface GenerateStepContext {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
}

export type SchemaCheckStatus = 'ready' | 'not-ready';

export type SchemaCheckIssueSeverity = 'warning' | 'error';

export type SchemaCheckIssueCode =
  | 'schema.config_missing'
  | 'schema.config_invalid'
  | 'schema.config_no_tables'
  | 'schema.migrations_missing'
  | 'schema.migrations_empty'
  | 'schema.generated_client_missing'
  | 'schema.generated_client_version_missing'
  | 'schema.generated_server_missing'
  | 'schema.generated_server_version_missing'
  | 'schema.generated_server_mismatch'
  | 'schema.generated_output_stale'
  | 'schema.generated_output_ahead';

export interface SchemaCheckIssue {
  code: SchemaCheckIssueCode;
  severity: SchemaCheckIssueSeverity;
  message: string;
  path?: string;
  recommendedAction:
    | 'runSyncularGenerate'
    | 'fixCodegenConfig'
    | 'addMigrations'
    | 'inspectGeneratedOutput';
  details?: Record<string, unknown>;
}

export interface SchemaCheckResult {
  generatedAt: string;
  status: SchemaCheckStatus;
  ready: boolean;
  manifestDir: string;
  configPath: string;
  migrationsDir: string;
  generatedClientPath: string | null;
  generatedServerPath: string | null;
  tableCount: number;
  tables: string[];
  schemaVersion: {
    migrations: number | null;
    generatedClient: number | null;
    generatedServer: number | null;
  };
  issues: SchemaCheckIssue[];
}

export type OpsCheckStatus = 'ready' | 'not-ready';

export type OpsCheckIssueCode =
  | 'ops.config_missing'
  | 'ops.config_invalid'
  | 'ops.environment_missing'
  | 'ops.schema_readiness_missing'
  | 'ops.schema_readiness_not_ready'
  | 'ops.schema_readiness_checked_at_missing'
  | 'ops.restore_drill_missing'
  | 'ops.restore_drill_completed_at_missing'
  | 'ops.restore_drill_stale'
  | 'ops.restore_drill_duration_invalid'
  | 'ops.restore_drill_rebootstrap_load_missing'
  | 'ops.restore_drill_rollback_decision_missing'
  | 'ops.blob_consistency_missing'
  | 'ops.blob_consistency_status_invalid'
  | 'ops.blob_consistency_stale'
  | 'ops.credential_rotation_missing'
  | 'ops.credential_rotation_stale'
  | 'ops.credential_rotation_owner_missing'
  | 'ops.rate_limits_missing'
  | 'ops.rate_limits_status_invalid'
  | 'ops.rate_limits_stale';

export type OpsCheckIssueSeverity = 'error';

export interface OpsCheckIssue {
  code: OpsCheckIssueCode;
  severity: OpsCheckIssueSeverity;
  message: string;
  path?: string;
  recommendedAction:
    | 'createOpsReadinessFile'
    | 'runSchemaChecks'
    | 'runRestoreDrill'
    | 'runBlobConsistencyCheck'
    | 'reviewCredentialRotation'
    | 'tuneRateLimits';
  details?: Record<string, unknown>;
}

export interface OpsCheckResult {
  generatedAt: string;
  status: OpsCheckStatus;
  ready: boolean;
  manifestDir: string;
  configPath: string;
  environment: string | null;
  checks: {
    schemaReadiness: 'ready' | 'not-ready' | 'missing';
    restoreDrill: 'ready' | 'not-ready' | 'missing';
    blobConsistency: 'ready' | 'not-ready' | 'not-applicable' | 'missing';
    credentialRotation: 'ready' | 'not-ready' | 'missing';
    rateLimits: 'ready' | 'not-ready' | 'missing';
  };
  issues: OpsCheckIssue[];
}

interface SyncularCodegenConfig {
  tables?: unknown;
  typescriptOutputPath?: unknown;
  typescriptServerOutputPath?: unknown;
}

interface SyncularOpsCheckConfig {
  environment?: unknown;
  schemaReadiness?: unknown;
  restoreDrill?: unknown;
  blobConsistency?: unknown;
  credentialRotation?: unknown;
  rateLimits?: unknown;
}

function usage(): string {
  return `usage: syncular <command>

commands:
  generate [--check] [--manifest-dir <path>] [--migrations-dir <path>] [--rust-output-dir <path>] [--app <path>]
  schema check [--manifest-dir <path>] [--config <path>] [--migrations-dir <path>] [--generated-client <path>] [--generated-server <path>] [--json] [--pretty]
  ops check [--manifest-dir <path>] [--config <path>] [--json] [--pretty]
  codegen install [--version <version>] [--root <path>] [--force]

examples:
  syncular generate
  syncular generate --check
  syncular generate --manifest-dir ./syncular-app --app ./syncular.app.ts
  syncular schema check --json
  syncular ops check --json
  syncular codegen install
`;
}

function generateUsage(): string {
  return `usage: syncular generate [--check] [--manifest-dir <path>] [--migrations-dir <path>] [--rust-output-dir <path>] [--app <path>]

Generates the Syncular app handoff and language clients in one app-facing command.

When <manifest-dir>/syncular.app.ts exists, or --app is provided, the typed
TypeScript app contract is used to refresh generated/syncular.codegen.json.
Rust-only apps can omit syncular.app.ts; when generated/syncular.codegen.json
is missing, syncular generate initializes it from migrations before generating
clients.

Use --check in CI to verify generated outputs are current without rewriting
files.
`;
}

function codegenInstallUsage(): string {
  return `usage: syncular codegen install [--version <version>] [--root <path>] [--force]

Installs the Rust syncular-codegen binary with Cargo into Syncular's tool cache.

By default the installed crate version matches the installed syncular npm
package version. Use --root to install into a custom Cargo root, or set
SYNCULAR_CODEGEN_BIN to point syncular generate at a custom binary.
`;
}

function schemaCheckUsage(): string {
  return `usage: syncular schema check [--manifest-dir <path>] [--config <path>] [--migrations-dir <path>] [--generated-client <path>] [--generated-server <path>] [--json] [--pretty]

Checks that the generated Syncular config, migrations, and generated TypeScript
client/server outputs agree before deploy or CI continues.

Use --json for machine-readable output. A not-ready result exits with status 1.
`;
}

function opsCheckUsage(): string {
  return `usage: syncular ops check [--manifest-dir <path>] [--config <path>] [--json] [--pretty] [--max-restore-drill-age-days <days>] [--max-blob-consistency-age-days <days>] [--max-credential-review-age-days <days>] [--max-rate-limit-review-age-days <days>]

Checks a production operations evidence file before deploy continues.

By default the command reads <manifest-dir>/syncular.ops.json and verifies
schema readiness, restore-drill evidence, blob consistency policy, credential
rotation ownership/cadence, and rate-limit review status.

Use --json for machine-readable output. A not-ready result exits with status 1.
`;
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  arg: string,
  name: string
): { value: string; nextIndex: number } | null {
  if (arg === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`${name} requires a value`);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (value.length === 0) {
      throw new Error(`${name} requires a value`);
    }
    return { value, nextIndex: index };
  }

  return null;
}

export function parseSyncularCliArgs(
  argv: readonly string[]
): SyncularCliCommand {
  const [command, ...rest] = argv;

  if (
    !command ||
    command === '--help' ||
    command === '-h' ||
    command === 'help'
  ) {
    return { kind: 'help' };
  }

  if (command === 'codegen') {
    const [subcommand, ...codegenArgs] = rest;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      return { kind: 'help', topic: 'codegen-install' };
    }
    if (subcommand !== 'install') {
      throw new Error(
        `Unknown syncular codegen command: ${subcommand}\n\n${usage()}`
      );
    }
    if (codegenArgs.includes('--help') || codegenArgs.includes('-h')) {
      return { kind: 'help', topic: 'codegen-install' };
    }
    return {
      kind: 'codegen-install',
      options: parseCodegenInstallArgs(codegenArgs),
    };
  }

  if (command === 'schema') {
    const [subcommand, ...schemaArgs] = rest;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      return { kind: 'help', topic: 'schema-check' };
    }
    if (subcommand !== 'check') {
      throw new Error(
        `Unknown syncular schema command: ${subcommand}\n\n${usage()}`
      );
    }
    if (schemaArgs.includes('--help') || schemaArgs.includes('-h')) {
      return { kind: 'help', topic: 'schema-check' };
    }
    return {
      kind: 'schema-check',
      options: parseSchemaCheckArgs(schemaArgs),
    };
  }

  if (command === 'ops') {
    const [subcommand, ...opsArgs] = rest;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      return { kind: 'help', topic: 'ops-check' };
    }
    if (subcommand !== 'check') {
      throw new Error(
        `Unknown syncular ops command: ${subcommand}\n\n${usage()}`
      );
    }
    if (opsArgs.includes('--help') || opsArgs.includes('-h')) {
      return { kind: 'help', topic: 'ops-check' };
    }
    return {
      kind: 'ops-check',
      options: parseOpsCheckArgs(opsArgs),
    };
  }

  if (command !== 'generate') {
    throw new Error(`Unknown syncular command: ${command}\n\n${usage()}`);
  }

  const options: GenerateCommandOptions = {
    check: false,
    manifestDir: '.',
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;

    if (arg === '--help' || arg === '-h') {
      return { kind: 'help', topic: 'generate' };
    }

    if (arg === '--check') {
      options.check = true;
      continue;
    }

    const manifestDir = readOptionValue(rest, index, arg, '--manifest-dir');
    if (manifestDir) {
      options.manifestDir = manifestDir.value;
      index = manifestDir.nextIndex;
      continue;
    }

    const migrationsDir = readOptionValue(rest, index, arg, '--migrations-dir');
    if (migrationsDir) {
      options.migrationsDir = migrationsDir.value;
      index = migrationsDir.nextIndex;
      continue;
    }

    const rustOutputDir = readOptionValue(
      rest,
      index,
      arg,
      '--rust-output-dir'
    );
    if (rustOutputDir) {
      options.rustOutputDir = rustOutputDir.value;
      index = rustOutputDir.nextIndex;
      continue;
    }

    const app = readOptionValue(rest, index, arg, '--app');
    if (app) {
      options.app = app.value;
      index = app.nextIndex;
      continue;
    }

    throw new Error(
      `Unknown syncular generate option: ${arg}\n\n${generateUsage()}`
    );
  }

  return { kind: 'generate', options };
}

function readPositiveNumberOptionValue(
  argv: readonly string[],
  index: number,
  arg: string,
  name: string
): { value: number; nextIndex: number } | null {
  const value = readOptionValue(argv, index, arg, name);
  if (!value) return null;
  const number = Number(value.value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} requires a positive number`);
  }
  return { value: number, nextIndex: value.nextIndex };
}

function parseSchemaCheckArgs(
  args: readonly string[]
): SchemaCheckCommandOptions {
  const options: SchemaCheckCommandOptions = {
    manifestDir: '.',
    json: false,
    pretty: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--pretty') {
      options.pretty = true;
      continue;
    }

    const manifestDir = readOptionValue(args, index, arg, '--manifest-dir');
    if (manifestDir) {
      options.manifestDir = manifestDir.value;
      index = manifestDir.nextIndex;
      continue;
    }

    const config = readOptionValue(args, index, arg, '--config');
    if (config) {
      options.config = config.value;
      index = config.nextIndex;
      continue;
    }

    const migrationsDir = readOptionValue(args, index, arg, '--migrations-dir');
    if (migrationsDir) {
      options.migrationsDir = migrationsDir.value;
      index = migrationsDir.nextIndex;
      continue;
    }

    const generatedClient = readOptionValue(
      args,
      index,
      arg,
      '--generated-client'
    );
    if (generatedClient) {
      options.generatedClient = generatedClient.value;
      index = generatedClient.nextIndex;
      continue;
    }

    const generatedServer = readOptionValue(
      args,
      index,
      arg,
      '--generated-server'
    );
    if (generatedServer) {
      options.generatedServer = generatedServer.value;
      index = generatedServer.nextIndex;
      continue;
    }

    throw new Error(
      `Unknown syncular schema check option: ${arg}\n\n${schemaCheckUsage()}`
    );
  }

  return options;
}

function parseOpsCheckArgs(args: readonly string[]): OpsCheckCommandOptions {
  const options: OpsCheckCommandOptions = {
    manifestDir: '.',
    json: false,
    pretty: false,
    maxRestoreDrillAgeDays: 90,
    maxBlobConsistencyAgeDays: 7,
    maxCredentialReviewAgeDays: 90,
    maxRateLimitReviewAgeDays: 90,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--pretty') {
      options.pretty = true;
      continue;
    }

    const manifestDir = readOptionValue(args, index, arg, '--manifest-dir');
    if (manifestDir) {
      options.manifestDir = manifestDir.value;
      index = manifestDir.nextIndex;
      continue;
    }

    const config = readOptionValue(args, index, arg, '--config');
    if (config) {
      options.config = config.value;
      index = config.nextIndex;
      continue;
    }

    const maxRestoreDrillAgeDays = readPositiveNumberOptionValue(
      args,
      index,
      arg,
      '--max-restore-drill-age-days'
    );
    if (maxRestoreDrillAgeDays) {
      options.maxRestoreDrillAgeDays = maxRestoreDrillAgeDays.value;
      index = maxRestoreDrillAgeDays.nextIndex;
      continue;
    }

    const maxBlobConsistencyAgeDays = readPositiveNumberOptionValue(
      args,
      index,
      arg,
      '--max-blob-consistency-age-days'
    );
    if (maxBlobConsistencyAgeDays) {
      options.maxBlobConsistencyAgeDays = maxBlobConsistencyAgeDays.value;
      index = maxBlobConsistencyAgeDays.nextIndex;
      continue;
    }

    const maxCredentialReviewAgeDays = readPositiveNumberOptionValue(
      args,
      index,
      arg,
      '--max-credential-review-age-days'
    );
    if (maxCredentialReviewAgeDays) {
      options.maxCredentialReviewAgeDays = maxCredentialReviewAgeDays.value;
      index = maxCredentialReviewAgeDays.nextIndex;
      continue;
    }

    const maxRateLimitReviewAgeDays = readPositiveNumberOptionValue(
      args,
      index,
      arg,
      '--max-rate-limit-review-age-days'
    );
    if (maxRateLimitReviewAgeDays) {
      options.maxRateLimitReviewAgeDays = maxRateLimitReviewAgeDays.value;
      index = maxRateLimitReviewAgeDays.nextIndex;
      continue;
    }

    throw new Error(
      `Unknown syncular ops check option: ${arg}\n\n${opsCheckUsage()}`
    );
  }

  return options;
}

function parseCodegenInstallArgs(
  args: readonly string[]
): CodegenInstallCommandOptions {
  const options: CodegenInstallCommandOptions = {
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    const version = readOptionValue(args, index, arg, '--version');
    if (version) {
      options.version = version.value;
      index = version.nextIndex;
      continue;
    }

    const root = readOptionValue(args, index, arg, '--root');
    if (root) {
      options.root = root.value;
      index = root.nextIndex;
      continue;
    }

    throw new Error(
      `Unknown syncular codegen install option: ${arg}\n\n${codegenInstallUsage()}`
    );
  }

  return options;
}

function resolveFrom(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export function buildGenerateSteps(
  options: GenerateCommandOptions,
  context: GenerateStepContext = {}
): GenerateStep[] {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  const fileExists = context.fileExists ?? existsSync;
  const typegenBin = env.SYNCULAR_TYPEGEN_BIN ?? 'syncular-typegen';
  const codegenBin = env.SYNCULAR_CODEGEN_BIN ?? SYNCULAR_CODEGEN_BIN;
  const manifestDir = resolveFrom(cwd, options.manifestDir);
  const appPath = options.app
    ? resolveFrom(cwd, options.app)
    : resolveFrom(manifestDir, DEFAULT_APP_FILE);
  const codegenConfigPath = resolveFrom(
    manifestDir,
    DEFAULT_CODEGEN_CONFIG_FILE
  );
  const hasAppDefinition = options.app !== undefined || fileExists(appPath);

  if (options.app !== undefined && !fileExists(appPath)) {
    throw new Error(
      `Syncular app definition not found: ${appPath}. Create syncular.app.ts, pass the correct --app path, or omit --app for a Rust-only project that already has generated/syncular.codegen.json.`
    );
  }

  const steps: GenerateStep[] = [];

  if (hasAppDefinition) {
    steps.push({
      label: 'Generate Syncular codegen config',
      command: typegenBin,
      args: [
        'codegen-config',
        '--app',
        appPath,
        '--out',
        codegenConfigPath,
        ...(options.check ? ['--check'] : []),
      ],
    });
  }

  if (!hasAppDefinition && !fileExists(codegenConfigPath)) {
    steps.push({
      label: 'Initialize Syncular codegen config',
      command: codegenBin,
      args: [
        'init',
        '--manifest-dir',
        manifestDir,
        ...(options.migrationsDir
          ? ['--migrations-dir', resolveFrom(cwd, options.migrationsDir)]
          : []),
        ...(options.check ? ['--check'] : []),
      ],
    });
  }

  steps.push({
    label: 'Generate Syncular app clients',
    command: codegenBin,
    args: [
      '--manifest-dir',
      manifestDir,
      ...(options.migrationsDir
        ? ['--migrations-dir', resolveFrom(cwd, options.migrationsDir)]
        : []),
      ...(options.rustOutputDir
        ? ['--rust-output-dir', resolveFrom(cwd, options.rustOutputDir)]
        : []),
      ...(options.check ? ['--check'] : []),
    ],
  });

  return steps;
}

export function runSchemaCheckCommand(
  options: SchemaCheckCommandOptions,
  context: { cwd?: string; now?: () => Date } = {}
): SchemaCheckResult {
  const cwd = context.cwd ?? process.cwd();
  const manifestDir = resolveFrom(cwd, options.manifestDir);
  const configPath = options.config
    ? resolveFrom(cwd, options.config)
    : resolveFrom(manifestDir, DEFAULT_CODEGEN_CONFIG_FILE);
  const migrationsDir = options.migrationsDir
    ? resolveFrom(cwd, options.migrationsDir)
    : resolveFrom(manifestDir, 'migrations');

  const issues: SchemaCheckIssue[] = [];
  const config = readCodegenConfig(configPath, issues);
  const tables = tableNames(config);
  if (config && tables.length === 0) {
    issues.push({
      code: 'schema.config_no_tables',
      severity: 'error',
      message: 'Syncular codegen config does not define any app tables.',
      path: configPath,
      recommendedAction: 'fixCodegenConfig',
    });
  }

  const generatedClientPath = resolveGeneratedOutputPath({
    cwd,
    manifestDir,
    explicitPath: options.generatedClient,
    configuredPath: config?.typescriptOutputPath,
  });
  const generatedServerPath = resolveGeneratedOutputPath({
    cwd,
    manifestDir,
    explicitPath: options.generatedServer,
    configuredPath: config?.typescriptServerOutputPath,
  });

  const migrationVersion = readMigrationVersion(migrationsDir, issues);
  const generatedClientVersion = readGeneratedSchemaVersion({
    kind: 'client',
    path: generatedClientPath,
    issues,
  });
  const generatedServerVersion = readGeneratedSchemaVersion({
    kind: 'server',
    path: generatedServerPath,
    issues,
  });

  if (
    generatedClientVersion !== null &&
    generatedServerVersion !== null &&
    generatedClientVersion !== generatedServerVersion
  ) {
    issues.push({
      code: 'schema.generated_server_mismatch',
      severity: 'error',
      message:
        'Generated Syncular client and server outputs disagree on app schema version.',
      path: generatedServerPath ?? undefined,
      recommendedAction: 'runSyncularGenerate',
      details: {
        generatedClientVersion,
        generatedServerVersion,
      },
    });
  }

  if (migrationVersion !== null && generatedClientVersion !== null) {
    if (generatedClientVersion < migrationVersion) {
      issues.push({
        code: 'schema.generated_output_stale',
        severity: 'error',
        message:
          'Generated Syncular client output is older than the migration set.',
        path: generatedClientPath ?? undefined,
        recommendedAction: 'runSyncularGenerate',
        details: {
          migrationVersion,
          generatedClientVersion,
        },
      });
    } else if (generatedClientVersion > migrationVersion) {
      issues.push({
        code: 'schema.generated_output_ahead',
        severity: 'error',
        message:
          'Generated Syncular client output is newer than the migration set.',
        path: generatedClientPath ?? undefined,
        recommendedAction: 'inspectGeneratedOutput',
        details: {
          migrationVersion,
          generatedClientVersion,
        },
      });
    }
  }

  const ready = !issues.some((issue) => issue.severity === 'error');
  return {
    generatedAt: (context.now?.() ?? new Date()).toISOString(),
    status: ready ? 'ready' : 'not-ready',
    ready,
    manifestDir,
    configPath,
    migrationsDir,
    generatedClientPath,
    generatedServerPath,
    tableCount: tables.length,
    tables,
    schemaVersion: {
      migrations: migrationVersion,
      generatedClient: generatedClientVersion,
      generatedServer: generatedServerVersion,
    },
    issues,
  };
}

export function runOpsCheckCommand(
  options: OpsCheckCommandOptions,
  context: { cwd?: string; now?: () => Date } = {}
): OpsCheckResult {
  const cwd = context.cwd ?? process.cwd();
  const now = context.now?.() ?? new Date();
  const manifestDir = resolveFrom(cwd, options.manifestDir);
  const configPath = options.config
    ? resolveFrom(cwd, options.config)
    : resolveFrom(manifestDir, DEFAULT_OPS_CHECK_FILE);

  const issues: OpsCheckIssue[] = [];
  const config = readOpsCheckConfig(configPath, issues);
  const environment = nonEmptyString(config?.environment);

  if (config && !environment) {
    issues.push({
      code: 'ops.environment_missing',
      severity: 'error',
      message: 'Syncular ops evidence must name the production environment.',
      path: configPath,
      recommendedAction: 'createOpsReadinessFile',
    });
  }

  const checks = {
    schemaReadiness: checkOpsSchemaReadiness({
      section: config?.schemaReadiness,
      issues,
      configPath,
    }),
    restoreDrill: checkOpsRestoreDrill({
      section: config?.restoreDrill,
      issues,
      configPath,
      maxAgeDays: options.maxRestoreDrillAgeDays ?? 90,
      now,
    }),
    blobConsistency: checkOpsBlobConsistency({
      section: config?.blobConsistency,
      issues,
      configPath,
      maxAgeDays: options.maxBlobConsistencyAgeDays ?? 7,
      now,
    }),
    credentialRotation:
      'missing' as OpsCheckResult['checks']['credentialRotation'],
    rateLimits: checkOpsRateLimits({
      section: config?.rateLimits,
      issues,
      configPath,
      maxAgeDays: options.maxRateLimitReviewAgeDays ?? 90,
      now,
    }),
  };
  checks.credentialRotation = checkOpsCredentialRotation({
    section: config?.credentialRotation,
    issues,
    configPath,
    maxAgeDays: options.maxCredentialReviewAgeDays ?? 90,
    now,
    storageOwnerRequired: checks.blobConsistency !== 'not-applicable',
  });

  const ready = !issues.some((issue) => issue.severity === 'error');
  return {
    generatedAt: now.toISOString(),
    status: ready ? 'ready' : 'not-ready',
    ready,
    manifestDir,
    configPath,
    environment,
    checks,
    issues,
  };
}

function readCodegenConfig(
  path: string,
  issues: SchemaCheckIssue[]
): SyncularCodegenConfig | null {
  if (!existsSync(path)) {
    issues.push({
      code: 'schema.config_missing',
      severity: 'error',
      message:
        'Syncular codegen config is missing. Run `syncular generate` before checking schema readiness.',
      path,
      recommendedAction: 'runSyncularGenerate',
    });
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SyncularCodegenConfig;
  } catch (error) {
    issues.push({
      code: 'schema.config_invalid',
      severity: 'error',
      message: 'Syncular codegen config is not valid JSON.',
      path,
      recommendedAction: 'fixCodegenConfig',
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}

function tableNames(config: SyncularCodegenConfig | null): string[] {
  if (!config || !isPlainRecord(config.tables)) return [];
  return Object.keys(config.tables).sort();
}

function resolveGeneratedOutputPath(args: {
  cwd: string;
  manifestDir: string;
  explicitPath: string | undefined;
  configuredPath: unknown;
}): string | null {
  if (args.explicitPath) return resolveFrom(args.cwd, args.explicitPath);
  if (typeof args.configuredPath === 'string' && args.configuredPath) {
    return resolveFrom(args.manifestDir, args.configuredPath);
  }
  return null;
}

function readMigrationVersion(
  migrationsDir: string,
  issues: SchemaCheckIssue[]
): number | null {
  if (!existsSync(migrationsDir)) {
    issues.push({
      code: 'schema.migrations_missing',
      severity: 'error',
      message: 'Syncular migrations directory is missing.',
      path: migrationsDir,
      recommendedAction: 'addMigrations',
    });
    return null;
  }

  const migrationCount = readdirSync(migrationsDir, {
    withFileTypes: true,
  }).filter((entry) => {
    if (!entry.isDirectory()) return false;
    return existsSync(join(migrationsDir, entry.name, 'up.sql'));
  }).length;

  if (migrationCount === 0) {
    issues.push({
      code: 'schema.migrations_empty',
      severity: 'error',
      message: 'Syncular migrations directory does not contain any migrations.',
      path: migrationsDir,
      recommendedAction: 'addMigrations',
    });
    return null;
  }

  return migrationCount;
}

function readGeneratedSchemaVersion(args: {
  kind: 'client' | 'server';
  path: string | null;
  issues: SchemaCheckIssue[];
}): number | null {
  if (args.path === null) return null;
  const missingCode =
    args.kind === 'client'
      ? 'schema.generated_client_missing'
      : 'schema.generated_server_missing';
  const versionMissingCode =
    args.kind === 'client'
      ? 'schema.generated_client_version_missing'
      : 'schema.generated_server_version_missing';

  if (!existsSync(args.path) || !statSync(args.path).isFile()) {
    args.issues.push({
      code: missingCode,
      severity: 'error',
      message: `Generated Syncular ${args.kind} output is missing.`,
      path: args.path,
      recommendedAction: 'runSyncularGenerate',
    });
    return null;
  }

  const source = readFileSync(args.path, 'utf8');
  const match =
    /export\s+const\s+syncularGeneratedSchemaVersion\s*=\s*(\d+)\s+as\s+const/.exec(
      source
    );
  if (!match) {
    args.issues.push({
      code: versionMissingCode,
      severity: 'error',
      message: `Generated Syncular ${args.kind} output does not export syncularGeneratedSchemaVersion.`,
      path: args.path,
      recommendedAction: 'runSyncularGenerate',
    });
    return null;
  }

  return Number(match[1]);
}

function readOpsCheckConfig(
  path: string,
  issues: OpsCheckIssue[]
): SyncularOpsCheckConfig | null {
  if (!existsSync(path)) {
    issues.push({
      code: 'ops.config_missing',
      severity: 'error',
      message:
        'Syncular production ops evidence is missing. Create syncular.ops.json or pass --config.',
      path,
      recommendedAction: 'createOpsReadinessFile',
    });
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isPlainRecord(parsed)) {
      issues.push({
        code: 'ops.config_invalid',
        severity: 'error',
        message: 'Syncular production ops evidence must be a JSON object.',
        path,
        recommendedAction: 'createOpsReadinessFile',
      });
      return null;
    }
    return parsed as SyncularOpsCheckConfig;
  } catch (error) {
    issues.push({
      code: 'ops.config_invalid',
      severity: 'error',
      message: 'Syncular production ops evidence is not valid JSON.',
      path,
      recommendedAction: 'createOpsReadinessFile',
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function checkOpsSchemaReadiness(args: {
  section: unknown;
  issues: OpsCheckIssue[];
  configPath: string;
}): OpsCheckResult['checks']['schemaReadiness'] {
  if (!isPlainRecord(args.section)) {
    args.issues.push({
      code: 'ops.schema_readiness_missing',
      severity: 'error',
      message:
        'Syncular ops evidence must include schema readiness from syncular schema check or getSyncularServerSchemaReadiness.',
      path: args.configPath,
      recommendedAction: 'runSchemaChecks',
    });
    return 'missing';
  }

  let ready = true;
  if (args.section.ready !== true && args.section.status !== 'ready') {
    args.issues.push({
      code: 'ops.schema_readiness_not_ready',
      severity: 'error',
      message: 'Syncular schema readiness evidence is not ready.',
      path: args.configPath,
      recommendedAction: 'runSchemaChecks',
    });
    ready = false;
  }

  if (!validDate(args.section.checkedAt)) {
    args.issues.push({
      code: 'ops.schema_readiness_checked_at_missing',
      severity: 'error',
      message: 'Syncular schema readiness evidence must include checkedAt.',
      path: args.configPath,
      recommendedAction: 'runSchemaChecks',
    });
    ready = false;
  }

  return ready ? 'ready' : 'not-ready';
}

function checkOpsRestoreDrill(args: {
  section: unknown;
  issues: OpsCheckIssue[];
  configPath: string;
  maxAgeDays: number;
  now: Date;
}): OpsCheckResult['checks']['restoreDrill'] {
  if (!isPlainRecord(args.section)) {
    args.issues.push({
      code: 'ops.restore_drill_missing',
      severity: 'error',
      message: 'Syncular ops evidence must include the latest restore drill.',
      path: args.configPath,
      recommendedAction: 'runRestoreDrill',
    });
    return 'missing';
  }

  let ready = true;
  const completedAt = readFreshDate({
    value: args.section.completedAt,
    now: args.now,
    maxAgeDays: args.maxAgeDays,
    missingCode: 'ops.restore_drill_completed_at_missing',
    staleCode: 'ops.restore_drill_stale',
    missingMessage: 'Syncular restore drill evidence must include completedAt.',
    staleMessage: 'Syncular restore drill evidence is older than allowed.',
    recommendedAction: 'runRestoreDrill',
    path: args.configPath,
    issues: args.issues,
  });
  if (!completedAt) ready = false;

  if (
    typeof args.section.restoreMinutes !== 'number' ||
    !Number.isFinite(args.section.restoreMinutes) ||
    args.section.restoreMinutes < 0
  ) {
    args.issues.push({
      code: 'ops.restore_drill_duration_invalid',
      severity: 'error',
      message:
        'Syncular restore drill evidence must include a non-negative restoreMinutes value.',
      path: args.configPath,
      recommendedAction: 'runRestoreDrill',
    });
    ready = false;
  }

  if (!nonEmptyString(args.section.expectedClientRebootstrapLoad)) {
    args.issues.push({
      code: 'ops.restore_drill_rebootstrap_load_missing',
      severity: 'error',
      message:
        'Syncular restore drill evidence must record expected client re-bootstrap load.',
      path: args.configPath,
      recommendedAction: 'runRestoreDrill',
    });
    ready = false;
  }

  if (!nonEmptyString(args.section.rollbackDecision)) {
    args.issues.push({
      code: 'ops.restore_drill_rollback_decision_missing',
      severity: 'error',
      message:
        'Syncular restore drill evidence must record the rollback decision.',
      path: args.configPath,
      recommendedAction: 'runRestoreDrill',
    });
    ready = false;
  }

  return ready ? 'ready' : 'not-ready';
}

function checkOpsBlobConsistency(args: {
  section: unknown;
  issues: OpsCheckIssue[];
  configPath: string;
  maxAgeDays: number;
  now: Date;
}): OpsCheckResult['checks']['blobConsistency'] {
  if (!isPlainRecord(args.section)) {
    args.issues.push({
      code: 'ops.blob_consistency_missing',
      severity: 'error',
      message:
        'Syncular ops evidence must declare blob consistency as pass or not-applicable.',
      path: args.configPath,
      recommendedAction: 'runBlobConsistencyCheck',
    });
    return 'missing';
  }

  const required = args.section.required !== false;
  const status = nonEmptyString(args.section.status);
  if (!required || status === 'not-applicable') {
    return 'not-applicable';
  }

  let ready = true;
  if (status !== 'pass') {
    args.issues.push({
      code: 'ops.blob_consistency_status_invalid',
      severity: 'error',
      message:
        'Syncular blob consistency evidence must pass before production deploy.',
      path: args.configPath,
      recommendedAction: 'runBlobConsistencyCheck',
      details: { status },
    });
    ready = false;
  }

  const checkedAt = readFreshDate({
    value: args.section.checkedAt,
    now: args.now,
    maxAgeDays: args.maxAgeDays,
    missingCode: 'ops.blob_consistency_stale',
    staleCode: 'ops.blob_consistency_stale',
    missingMessage:
      'Syncular blob consistency evidence must include checkedAt when blob storage is required.',
    staleMessage: 'Syncular blob consistency evidence is older than allowed.',
    recommendedAction: 'runBlobConsistencyCheck',
    path: args.configPath,
    issues: args.issues,
  });
  if (!checkedAt) ready = false;

  return ready ? 'ready' : 'not-ready';
}

function checkOpsCredentialRotation(args: {
  section: unknown;
  issues: OpsCheckIssue[];
  configPath: string;
  maxAgeDays: number;
  now: Date;
  storageOwnerRequired: boolean;
}): OpsCheckResult['checks']['credentialRotation'] {
  if (!isPlainRecord(args.section)) {
    args.issues.push({
      code: 'ops.credential_rotation_missing',
      severity: 'error',
      message:
        'Syncular ops evidence must include credential rotation ownership and review date.',
      path: args.configPath,
      recommendedAction: 'reviewCredentialRotation',
    });
    return 'missing';
  }

  let ready = true;
  const reviewedAt = readFreshDate({
    value: args.section.reviewedAt,
    now: args.now,
    maxAgeDays: args.maxAgeDays,
    missingCode: 'ops.credential_rotation_stale',
    staleCode: 'ops.credential_rotation_stale',
    missingMessage:
      'Syncular credential rotation evidence must include reviewedAt.',
    staleMessage:
      'Syncular credential rotation evidence is older than allowed.',
    recommendedAction: 'reviewCredentialRotation',
    path: args.configPath,
    issues: args.issues,
  });
  if (!reviewedAt) ready = false;

  const owners = isPlainRecord(args.section.owners)
    ? args.section.owners
    : null;
  for (const owner of [
    'auth',
    'console',
    ...(args.storageOwnerRequired ? ['storage'] : []),
  ]) {
    if (!owners || !nonEmptyString(owners[owner])) {
      args.issues.push({
        code: 'ops.credential_rotation_owner_missing',
        severity: 'error',
        message: `Syncular credential rotation evidence must name an owner for ${owner}.`,
        path: args.configPath,
        recommendedAction: 'reviewCredentialRotation',
        details: { owner },
      });
      ready = false;
    }
  }

  return ready ? 'ready' : 'not-ready';
}

function checkOpsRateLimits(args: {
  section: unknown;
  issues: OpsCheckIssue[];
  configPath: string;
  maxAgeDays: number;
  now: Date;
}): OpsCheckResult['checks']['rateLimits'] {
  if (!isPlainRecord(args.section)) {
    args.issues.push({
      code: 'ops.rate_limits_missing',
      severity: 'error',
      message:
        'Syncular ops evidence must include rate-limit tuning or gateway ownership.',
      path: args.configPath,
      recommendedAction: 'tuneRateLimits',
    });
    return 'missing';
  }

  let ready = true;
  const status = nonEmptyString(args.section.status);
  if (status !== 'enabled' && status !== 'gateway') {
    args.issues.push({
      code: 'ops.rate_limits_status_invalid',
      severity: 'error',
      message:
        'Syncular rate-limit evidence must have status "enabled" or "gateway".',
      path: args.configPath,
      recommendedAction: 'tuneRateLimits',
      details: { status },
    });
    ready = false;
  }

  const reviewedAt = readFreshDate({
    value: args.section.reviewedAt,
    now: args.now,
    maxAgeDays: args.maxAgeDays,
    missingCode: 'ops.rate_limits_stale',
    staleCode: 'ops.rate_limits_stale',
    missingMessage: 'Syncular rate-limit evidence must include reviewedAt.',
    staleMessage: 'Syncular rate-limit evidence is older than allowed.',
    recommendedAction: 'tuneRateLimits',
    path: args.configPath,
    issues: args.issues,
  });
  if (!reviewedAt) ready = false;

  return ready ? 'ready' : 'not-ready';
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function readFreshDate(args: {
  value: unknown;
  now: Date;
  maxAgeDays: number;
  missingCode: OpsCheckIssueCode;
  staleCode: OpsCheckIssueCode;
  missingMessage: string;
  staleMessage: string;
  recommendedAction: OpsCheckIssue['recommendedAction'];
  path: string;
  issues: OpsCheckIssue[];
}): Date | null {
  if (!validDate(args.value)) {
    args.issues.push({
      code: args.missingCode,
      severity: 'error',
      message: args.missingMessage,
      path: args.path,
      recommendedAction: args.recommendedAction,
    });
    return null;
  }

  const date = new Date(args.value);
  const ageDays = Math.max(
    0,
    (args.now.getTime() - date.getTime()) / 86_400_000
  );
  if (ageDays > args.maxAgeDays) {
    args.issues.push({
      code: args.staleCode,
      severity: 'error',
      message: args.staleMessage,
      path: args.path,
      recommendedAction: args.recommendedAction,
      details: {
        ageDays: Math.round(ageDays * 10) / 10,
        maxAgeDays: args.maxAgeDays,
      },
    });
    return null;
  }

  return date;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatSchemaCheckText(result: SchemaCheckResult): string {
  if (result.ready) {
    const version = result.schemaVersion.generatedClient ?? 'unknown';
    return `[syncular] schema ready (version ${version}, ${result.tableCount} table${result.tableCount === 1 ? '' : 's'})`;
  }

  return [
    `[syncular] schema not ready (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`,
    ...result.issues.map((issue) => {
      const location = issue.path ? ` at ${issue.path}` : '';
      return `- ${issue.code}${location}: ${issue.message}`;
    }),
  ].join('\n');
}

function formatOpsCheckText(result: OpsCheckResult): string {
  if (result.ready) {
    return `[syncular] ops ready (${result.environment ?? 'unknown environment'})`;
  }

  return [
    `[syncular] ops not ready (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`,
    ...result.issues.map((issue) => {
      const location = issue.path ? ` at ${issue.path}` : '';
      return `- ${issue.code}${location}: ${issue.message}`;
    }),
  ].join('\n');
}

function readPackageVersion(): string | undefined {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    const version = packageJson.version?.trim();
    return version && version !== '0.0.0' ? version : undefined;
  } catch {
    return undefined;
  }
}

function defaultCacheDir(): string {
  if (process.env.SYNCULAR_CACHE_DIR) {
    return process.env.SYNCULAR_CACHE_DIR;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Syncular');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'syncular');
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'syncular'
  );
}

function defaultCodegenVersion(version?: string): string | undefined {
  const resolved =
    version?.trim() ||
    process.env.SYNCULAR_CODEGEN_VERSION?.trim() ||
    readPackageVersion();
  return resolved && resolved !== '0.0.0' ? resolved : undefined;
}

function defaultCodegenInstallRoot(version?: string): string {
  return join(defaultCacheDir(), 'codegen', version ?? 'latest');
}

function codegenBinaryPath(root: string): string {
  return join(
    root,
    'bin',
    process.platform === 'win32'
      ? `${SYNCULAR_CODEGEN_BIN}.exe`
      : SYNCULAR_CODEGEN_BIN
  );
}

export function buildCodegenInstallArgs(options: {
  version?: string;
  root: string;
  force?: boolean;
}): string[] {
  return [
    'install',
    SYNCULAR_CODEGEN_BIN,
    ...(options.version ? ['--version', options.version] : []),
    '--locked',
    '--root',
    options.root,
    ...(options.force ? ['--force'] : []),
  ];
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function executableCandidates(command: string, env = process.env): string[] {
  if (hasPathSeparator(command)) {
    return [command];
  }

  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  return pathDirs.flatMap((dir) =>
    extensions.map((extension) => join(dir, `${command}${extension}`))
  );
}

function findExecutable(command: string, env = process.env): string | null {
  for (const candidate of executableCandidates(command, env)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      if (process.platform === 'win32' && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function localRepoCodegenManifest(): string | null {
  const cliPath = fileURLToPath(import.meta.url);
  let current = dirname(cliPath);
  while (true) {
    const cargoManifest = join(current, 'rust/Cargo.toml');
    const codegenManifest = join(current, 'rust/crates/codegen/Cargo.toml');
    const syncularPackageDir = join(current, 'packages/syncular');
    if (
      existsSync(cargoManifest) &&
      existsSync(codegenManifest) &&
      cliPath.startsWith(`${syncularPackageDir}${sep}`)
    ) {
      return cargoManifest;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function codegenAutoInstallEnabled(): boolean {
  const value = (process.env.SYNCULAR_CODEGEN_AUTO_INSTALL ?? '1')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function missingCodegenMessage(
  version: string | undefined,
  root: string
): string {
  const installCommand = version
    ? `npx syncular codegen install --version ${version}`
    : 'npx syncular codegen install';
  const cargoCommand = version
    ? `cargo install ${SYNCULAR_CODEGEN_BIN} --version ${version} --locked`
    : `cargo install ${SYNCULAR_CODEGEN_BIN} --locked`;
  return [
    `Required generator command not found: ${SYNCULAR_CODEGEN_BIN}.`,
    `Run \`${installCommand}\` to install it into ${root},`,
    `run \`${cargoCommand}\`,`,
    `or set SYNCULAR_CODEGEN_BIN to an existing ${SYNCULAR_CODEGEN_BIN} binary.`,
  ].join(' ');
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Required generator command not found: ${command}. Install it and ensure it is on PATH before running syncular generate.`
          )
        );
        return;
      }
      reject(error);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

async function installSyncularCodegen(options: {
  version?: string;
  root: string;
  force?: boolean;
}): Promise<string> {
  const cargo = findExecutable('cargo');
  if (!cargo) {
    throw new Error(missingCodegenMessage(options.version, options.root));
  }

  mkdirSync(options.root, { recursive: true });
  const args = buildCodegenInstallArgs(options);
  console.log(`[syncular] Installing ${SYNCULAR_CODEGEN_BIN}`);
  console.log(`$ ${[cargo, ...args].join(' ')}`);
  await runProcess(cargo, args);

  const binary = codegenBinaryPath(options.root);
  if (!findExecutable(binary)) {
    throw new Error(
      `${SYNCULAR_CODEGEN_BIN} install completed but ${binary} is not executable`
    );
  }
  return binary;
}

async function resolveStep(step: GenerateStep): Promise<GenerateStep> {
  const explicitCodegenBin = process.env.SYNCULAR_CODEGEN_BIN;
  const isCodegenStep =
    step.command === SYNCULAR_CODEGEN_BIN ||
    (explicitCodegenBin !== undefined && step.command === explicitCodegenBin);

  if (!isCodegenStep) {
    return step;
  }

  if (explicitCodegenBin) {
    const explicitBinary = findExecutable(explicitCodegenBin);
    if (!explicitBinary) {
      throw new Error(
        `SYNCULAR_CODEGEN_BIN points to a missing or non-executable command: ${explicitCodegenBin}`
      );
    }
    return { ...step, command: explicitBinary };
  }

  const repoManifest = localRepoCodegenManifest();
  if (repoManifest) {
    return {
      ...step,
      command: 'cargo',
      args: [
        'run',
        '--quiet',
        '--manifest-path',
        repoManifest,
        '-p',
        SYNCULAR_CODEGEN_BIN,
        '--',
        ...step.args,
      ],
    };
  }

  const version = defaultCodegenVersion();
  const root = defaultCodegenInstallRoot(version);
  const cachedBinary = codegenBinaryPath(root);
  if (findExecutable(cachedBinary)) {
    return { ...step, command: cachedBinary };
  }

  const pathBinary = findExecutable(SYNCULAR_CODEGEN_BIN);
  if (pathBinary) {
    return { ...step, command: pathBinary };
  }

  if (codegenAutoInstallEnabled() && findExecutable('cargo')) {
    const installedBinary = await installSyncularCodegen({ version, root });
    return { ...step, command: installedBinary };
  }

  throw new Error(missingCodegenMessage(version, root));
}

async function runStep(step: GenerateStep): Promise<void> {
  const resolvedStep = await resolveStep(step);
  console.log(`[syncular] ${step.label}`);
  console.log(`$ ${[resolvedStep.command, ...resolvedStep.args].join(' ')}`);
  await runProcess(resolvedStep.command, resolvedStep.args);
}

export async function runGenerateCommand(
  options: GenerateCommandOptions
): Promise<void> {
  const steps = buildGenerateSteps(options);
  for (const step of steps) {
    await runStep(step);
  }
}

export async function runCodegenInstallCommand(
  options: CodegenInstallCommandOptions
): Promise<void> {
  const version = defaultCodegenVersion(options.version);
  const root = resolve(options.root ?? defaultCodegenInstallRoot(version));
  const binary = await installSyncularCodegen({
    version,
    root,
    force: options.force,
  });
  console.log(`[syncular] ${SYNCULAR_CODEGEN_BIN} installed at ${binary}`);
}

export async function runSyncularCli(
  argv = process.argv.slice(2)
): Promise<number> {
  try {
    const parsed = parseSyncularCliArgs(argv);

    if (parsed.kind === 'help') {
      if (parsed.topic === 'generate') {
        console.log(generateUsage());
      } else if (parsed.topic === 'codegen-install') {
        console.log(codegenInstallUsage());
      } else if (parsed.topic === 'schema-check') {
        console.log(schemaCheckUsage());
      } else if (parsed.topic === 'ops-check') {
        console.log(opsCheckUsage());
      } else {
        console.log(usage());
      }
      return 0;
    }

    if (parsed.kind === 'generate') {
      await runGenerateCommand(parsed.options);
    } else if (parsed.kind === 'schema-check') {
      const result = runSchemaCheckCommand(parsed.options);
      console.log(
        parsed.options.json
          ? JSON.stringify(result, null, parsed.options.pretty ? 2 : 0)
          : formatSchemaCheckText(result)
      );
      return result.ready ? 0 : 1;
    } else if (parsed.kind === 'ops-check') {
      const result = runOpsCheckCommand(parsed.options);
      console.log(
        parsed.options.json
          ? JSON.stringify(result, null, parsed.options.pretty ? 2 : 0)
          : formatOpsCheckText(result)
      );
      return result.ready ? 0 : 1;
    } else {
      await runCodegenInstallCommand(parsed.options);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[syncular] ${message}`);
    return 1;
  }
}

export function isMainModuleEntrypoint(
  entrypoint: string | undefined,
  moduleUrl = import.meta.url
): boolean {
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(entrypoint).href === moduleUrl;
  }
}

function isMainModule(): boolean {
  return isMainModuleEntrypoint(process.argv[1]);
}

if (isMainModule()) {
  process.exitCode = await runSyncularCli();
}
