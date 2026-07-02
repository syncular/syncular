import { syncularErrorMessage } from './errors';
import type { SyncularRuntimeInfo, SyncularSchemaState } from './types';

export type SyncularSchemaReadinessStatus =
  | 'ready'
  | 'warning'
  | 'not-ready'
  | 'unknown';

export type SyncularSchemaReadinessIssueSeverity = 'info' | 'warning' | 'error';

export type SyncularSchemaReadinessIssueCode =
  | 'schema.missing_local_schema'
  | 'schema.local_schema_stale'
  | 'schema.local_schema_newer_than_generated'
  | 'schema.generated_client_stale'
  | 'schema.runtime_app_schema_stale'
  | 'schema.server_requires_newer_client'
  | 'schema.server_schema_stale'
  | 'schema.server_newer_available'
  | 'runtime.info_unavailable'
  | 'runtime.schema_state_unavailable'
  | 'runtime.package_mismatch'
  | 'runtime.package_version_mismatch'
  | 'runtime.worker_protocol_mismatch'
  | 'runtime.rust_info_missing'
  | 'runtime.rust_crate_mismatch'
  | 'runtime.rust_crate_version_mismatch'
  | 'runtime.rust_schema_version_mismatch'
  | 'runtime.rust_feature_missing'
  | 'runtime.worker_asset_mismatch'
  | 'runtime.wasm_glue_asset_mismatch'
  | 'runtime.wasm_asset_mismatch';

export type SyncularSchemaReadinessAction =
  | 'openDatabase'
  | 'runSyncularGenerate'
  | 'runSchemaMigrations'
  | 'redeployServer'
  | 'redeployClient'
  | 'refreshRuntimeAssets'
  | 'upgradeClient'
  | 'inspectRuntime'
  | 'recreateLocalDatabase';

export interface SyncularSchemaReadinessClient {
  runtimeInfo(): Promise<SyncularRuntimeInfo>;
  generatedSchemaState(): Promise<SyncularSchemaState>;
}

export interface SyncularSchemaReadinessServerState {
  /**
   * The server-required app schema version observed from a sync response or
   * deploy/readiness endpoint. Versions newer than the generated client are
   * hard blockers.
   */
  requiredSchemaVersion?: number | null;
  /**
   * The latest app schema version the server knows about. Older values usually
   * mean the server deploy is behind the generated client.
   */
  latestSchemaVersion?: number | null;
  source?: string;
}

export type SyncularSchemaReadinessRuntimeAssetInput = string | URL | Request;

export interface SyncularSchemaReadinessExpectedRuntime {
  packageName?: string;
  packageVersion?: string;
  workerProtocolVersion?: number;
  rust?: {
    crateName?: string;
    crateVersion?: string;
    schemaVersion?: number;
    features?: readonly string[];
  };
  requiredRustFeatures?: readonly string[];
  workerUrl?: SyncularSchemaReadinessRuntimeAssetInput;
  wasmGlueUrl?: SyncularSchemaReadinessRuntimeAssetInput;
  wasmUrl?: SyncularSchemaReadinessRuntimeAssetInput;
}

export interface SyncularSchemaReadinessOptions {
  /**
   * Pass the schema version baked into the generated client. Without it the
   * helper can still inspect the local runtime, but cannot prove generated
   * output freshness.
   */
  generatedSchemaVersion?: number;
  /**
   * Expected runtime identity for the app bundle that is calling this helper.
   * Generated clients fill this automatically so mixed JS/WASM/worker deploys
   * produce stable issue codes instead of later worker-open failures.
   */
  expectedRuntime?: SyncularSchemaReadinessExpectedRuntime;
  server?: SyncularSchemaReadinessServerState;
  now?: () => number;
}

export interface SyncularSchemaReadinessIssue {
  code: SyncularSchemaReadinessIssueCode;
  severity: SyncularSchemaReadinessIssueSeverity;
  message: string;
  recommendedAction: SyncularSchemaReadinessAction;
  details?: Record<string, unknown>;
}

export interface SyncularSchemaReadinessRuntimeSummary {
  packageName: string;
  packageVersion: string;
  workerProtocolVersion: number;
  rust?: SyncularRuntimeInfo['rust'];
}

export interface SyncularSchemaReadinessResult {
  generatedAt: number;
  status: SyncularSchemaReadinessStatus;
  ready: boolean;
  requiresAction: boolean;
  generatedSchemaVersion: number | null;
  runtime: SyncularSchemaReadinessRuntimeSummary | null;
  localSchema: SyncularSchemaState | null;
  serverSchema: SyncularSchemaReadinessServerState | null;
  issues: SyncularSchemaReadinessIssue[];
}

export async function getSyncularSchemaReadiness(
  client: SyncularSchemaReadinessClient,
  options: SyncularSchemaReadinessOptions = {}
): Promise<SyncularSchemaReadinessResult> {
  const issues: SyncularSchemaReadinessIssue[] = [];
  const [runtimeResult, schemaResult] = await Promise.allSettled([
    client.runtimeInfo(),
    client.generatedSchemaState(),
  ]);

  const runtimeInfo =
    runtimeResult.status === 'fulfilled' ? runtimeResult.value : null;
  const runtime = runtimeInfo ? summarizeRuntimeInfo(runtimeInfo) : null;
  const localSchema =
    schemaResult.status === 'fulfilled' ? schemaResult.value : null;

  if (runtimeResult.status === 'rejected') {
    issues.push({
      code: 'runtime.info_unavailable',
      severity: 'error',
      message: 'Syncular runtime info is unavailable.',
      recommendedAction: 'inspectRuntime',
      details: errorDetails(runtimeResult.reason),
    });
  }
  if (schemaResult.status === 'rejected') {
    issues.push({
      code: 'runtime.schema_state_unavailable',
      severity: 'error',
      message: 'Syncular local app schema state is unavailable.',
      recommendedAction: 'inspectRuntime',
      details: errorDetails(schemaResult.reason),
    });
  }

  if (runtimeInfo && options.expectedRuntime) {
    issues.push(
      ...runtimeCompatibilityIssues(runtimeInfo, options.expectedRuntime)
    );
  }

  const generatedSchemaVersion =
    options.generatedSchemaVersion ??
    localSchema?.currentSchemaVersion ??
    runtime?.rust?.schemaVersion ??
    null;

  if (localSchema) {
    issues.push(
      ...localSchemaIssues({
        localSchema,
        generatedSchemaVersion,
        explicitGeneratedSchemaVersion: options.generatedSchemaVersion,
      })
    );
  }

  if (options.server) {
    issues.push(
      ...serverSchemaIssues({
        server: options.server,
        generatedSchemaVersion,
      })
    );
  }

  const status = readinessStatus(issues);
  return {
    generatedAt: options.now?.() ?? Date.now(),
    status,
    ready: status === 'ready' || status === 'warning',
    requiresAction: issues.some((issue) => issue.severity === 'error'),
    generatedSchemaVersion,
    runtime,
    localSchema,
    serverSchema: options.server ?? null,
    issues,
  };
}

function runtimeCompatibilityIssues(
  runtime: SyncularRuntimeInfo,
  expected: SyncularSchemaReadinessExpectedRuntime
): SyncularSchemaReadinessIssue[] {
  const issues: SyncularSchemaReadinessIssue[] = [];

  if (
    expected.packageName !== undefined &&
    runtime.packageName !== expected.packageName
  ) {
    issues.push({
      code: 'runtime.package_mismatch',
      severity: 'error',
      message:
        'The Syncular runtime package does not match the generated app bundle.',
      recommendedAction: 'redeployClient',
      details: {
        expectedPackageName: expected.packageName,
        actualPackageName: runtime.packageName,
      },
    });
  }

  if (
    expected.packageVersion !== undefined &&
    runtime.packageVersion !== expected.packageVersion
  ) {
    issues.push({
      code: 'runtime.package_version_mismatch',
      severity: 'error',
      message:
        'The Syncular runtime package version does not match the generated app bundle.',
      recommendedAction: 'redeployClient',
      details: {
        expectedPackageVersion: expected.packageVersion,
        actualPackageVersion: runtime.packageVersion,
      },
    });
  }

  if (
    expected.workerProtocolVersion !== undefined &&
    runtime.workerProtocolVersion !== expected.workerProtocolVersion
  ) {
    issues.push({
      code: 'runtime.worker_protocol_mismatch',
      severity: 'error',
      message:
        'The Syncular worker protocol version does not match the generated app bundle.',
      recommendedAction: 'redeployClient',
      details: {
        expectedWorkerProtocolVersion: expected.workerProtocolVersion,
        actualWorkerProtocolVersion: runtime.workerProtocolVersion,
      },
    });
  }

  const requiredRustFeatures = new Set([
    ...(expected.rust?.features ?? []),
    ...(expected.requiredRustFeatures ?? []),
  ]);
  const expectsRust =
    expected.rust !== undefined || requiredRustFeatures.size > 0;

  if (expectsRust && !runtime.rust) {
    issues.push({
      code: 'runtime.rust_info_missing',
      severity: 'error',
      message:
        'The Syncular runtime did not report Rust runtime information required by this app.',
      recommendedAction: 'redeployClient',
      details: {
        expectedRustFeatures: [...requiredRustFeatures],
      },
    });
  }

  if (runtime.rust) {
    if (
      expected.rust?.crateName !== undefined &&
      runtime.rust.crateName !== expected.rust.crateName
    ) {
      issues.push({
        code: 'runtime.rust_crate_mismatch',
        severity: 'error',
        message:
          'The Syncular Rust runtime crate does not match the generated app bundle.',
        recommendedAction: 'redeployClient',
        details: {
          expectedRustCrateName: expected.rust.crateName,
          actualRustCrateName: runtime.rust.crateName,
        },
      });
    }

    if (
      expected.rust?.crateVersion !== undefined &&
      runtime.rust.crateVersion !== expected.rust.crateVersion
    ) {
      issues.push({
        code: 'runtime.rust_crate_version_mismatch',
        severity: 'error',
        message:
          'The Syncular Rust runtime crate version does not match the generated app bundle.',
        recommendedAction: 'redeployClient',
        details: {
          expectedRustCrateVersion: expected.rust.crateVersion,
          actualRustCrateVersion: runtime.rust.crateVersion,
        },
      });
    }

    if (
      expected.rust?.schemaVersion !== undefined &&
      runtime.rust.schemaVersion !== expected.rust.schemaVersion
    ) {
      issues.push({
        code: 'runtime.rust_schema_version_mismatch',
        severity: 'error',
        message:
          'The Syncular Rust runtime schema version does not match the generated app bundle.',
        recommendedAction: 'redeployClient',
        details: {
          expectedRustSchemaVersion: expected.rust.schemaVersion,
          actualRustSchemaVersion: runtime.rust.schemaVersion,
        },
      });
    }

    const availableFeatures = new Set(runtime.rust.features);
    const missingFeatures = [...requiredRustFeatures].filter(
      (feature) => !availableFeatures.has(feature)
    );
    if (missingFeatures.length > 0) {
      issues.push({
        code: 'runtime.rust_feature_missing',
        severity: 'error',
        message:
          'The Syncular Rust runtime is missing features required by this app.',
        recommendedAction: 'redeployClient',
        details: {
          missingRustFeatures: missingFeatures,
          actualRustFeatures: runtime.rust.features,
        },
      });
    }
  }

  assetMismatchIssue({
    issues,
    code: 'runtime.worker_asset_mismatch',
    message:
      'The Syncular worker asset URL does not match the generated app bundle.',
    expected: expected.workerUrl,
    actual: runtime.workerUrl,
    expectedKey: 'expectedWorkerUrl',
    actualKey: 'actualWorkerUrl',
  });
  assetMismatchIssue({
    issues,
    code: 'runtime.wasm_glue_asset_mismatch',
    message:
      'The Syncular WASM glue asset URL does not match the generated app bundle.',
    expected: expected.wasmGlueUrl,
    actual: runtime.wasmGlueUrl,
    expectedKey: 'expectedWasmGlueUrl',
    actualKey: 'actualWasmGlueUrl',
  });
  assetMismatchIssue({
    issues,
    code: 'runtime.wasm_asset_mismatch',
    message:
      'The Syncular WASM binary asset URL does not match the generated app bundle.',
    expected: expected.wasmUrl,
    actual: runtime.wasmUrl,
    expectedKey: 'expectedWasmUrl',
    actualKey: 'actualWasmUrl',
  });

  return issues;
}

function localSchemaIssues(args: {
  localSchema: SyncularSchemaState;
  generatedSchemaVersion: number | null;
  explicitGeneratedSchemaVersion: number | undefined;
}): SyncularSchemaReadinessIssue[] {
  const {
    localSchema,
    generatedSchemaVersion,
    explicitGeneratedSchemaVersion,
  } = args;
  const issues: SyncularSchemaReadinessIssue[] = [];
  const currentSchemaVersion = localSchema.currentSchemaVersion;

  if (
    explicitGeneratedSchemaVersion !== undefined &&
    currentSchemaVersion !== explicitGeneratedSchemaVersion
  ) {
    if (currentSchemaVersion > explicitGeneratedSchemaVersion) {
      issues.push({
        code: 'schema.generated_client_stale',
        severity: 'error',
        message:
          'The runtime app schema is newer than the generated client output.',
        recommendedAction: 'runSyncularGenerate',
        details: {
          generatedSchemaVersion: explicitGeneratedSchemaVersion,
          runtimeCurrentSchemaVersion: currentSchemaVersion,
        },
      });
    } else {
      issues.push({
        code: 'schema.runtime_app_schema_stale',
        severity: 'error',
        message:
          'The generated client output is newer than the app schema configured in the runtime.',
        recommendedAction: 'redeployServer',
        details: {
          generatedSchemaVersion: explicitGeneratedSchemaVersion,
          runtimeCurrentSchemaVersion: currentSchemaVersion,
        },
      });
    }
  }

  if (localSchema.schemaVersion === null) {
    issues.push({
      code: 'schema.missing_local_schema',
      severity: 'error',
      message:
        'The local Syncular database has not recorded an installed app schema.',
      recommendedAction: 'openDatabase',
      details: {
        schemaId: localSchema.schemaId,
        expectedSchemaVersion: generatedSchemaVersion,
      },
    });
    return issues;
  }

  if (
    generatedSchemaVersion !== null &&
    localSchema.schemaVersion < generatedSchemaVersion
  ) {
    issues.push({
      code: 'schema.local_schema_stale',
      severity: 'error',
      message:
        'The local Syncular database schema is older than the generated app schema.',
      recommendedAction: 'runSchemaMigrations',
      details: {
        schemaId: localSchema.schemaId,
        localSchemaVersion: localSchema.schemaVersion,
        generatedSchemaVersion,
      },
    });
  }

  if (
    generatedSchemaVersion !== null &&
    localSchema.schemaVersion > generatedSchemaVersion
  ) {
    issues.push({
      code: 'schema.local_schema_newer_than_generated',
      severity: 'error',
      message:
        'The local Syncular database schema is newer than the generated client output.',
      recommendedAction: 'runSyncularGenerate',
      details: {
        schemaId: localSchema.schemaId,
        localSchemaVersion: localSchema.schemaVersion,
        generatedSchemaVersion,
      },
    });
  }

  return issues;
}

function serverSchemaIssues(args: {
  server: SyncularSchemaReadinessServerState;
  generatedSchemaVersion: number | null;
}): SyncularSchemaReadinessIssue[] {
  const { server, generatedSchemaVersion } = args;
  if (generatedSchemaVersion === null) return [];

  const issues: SyncularSchemaReadinessIssue[] = [];
  const requiredSchemaVersion = normalizeSchemaVersion(
    server.requiredSchemaVersion
  );
  const latestSchemaVersion = normalizeSchemaVersion(
    server.latestSchemaVersion
  );

  if (
    requiredSchemaVersion !== null &&
    requiredSchemaVersion > generatedSchemaVersion
  ) {
    issues.push({
      code: 'schema.server_requires_newer_client',
      severity: 'error',
      message:
        'The server requires a newer generated client schema than this app has.',
      recommendedAction: 'upgradeClient',
      details: {
        generatedSchemaVersion,
        requiredSchemaVersion,
        ...(server.source ? { source: server.source } : {}),
      },
    });
  }

  if (
    latestSchemaVersion !== null &&
    latestSchemaVersion < generatedSchemaVersion
  ) {
    issues.push({
      code: 'schema.server_schema_stale',
      severity: 'error',
      message:
        'The server schema is older than the generated client schema in this app.',
      recommendedAction: 'redeployServer',
      details: {
        generatedSchemaVersion,
        latestSchemaVersion,
        ...(server.source ? { source: server.source } : {}),
      },
    });
  }

  if (
    latestSchemaVersion !== null &&
    latestSchemaVersion > generatedSchemaVersion
  ) {
    issues.push({
      code: 'schema.server_newer_available',
      severity: 'warning',
      message:
        'The server knows about a newer generated client schema than this app uses.',
      recommendedAction: 'runSyncularGenerate',
      details: {
        generatedSchemaVersion,
        latestSchemaVersion,
        ...(server.source ? { source: server.source } : {}),
      },
    });
  }

  return issues;
}

function summarizeRuntimeInfo(
  runtime: SyncularRuntimeInfo
): SyncularSchemaReadinessRuntimeSummary {
  return {
    packageName: runtime.packageName,
    packageVersion: runtime.packageVersion,
    workerProtocolVersion: runtime.workerProtocolVersion,
    ...(runtime.rust ? { rust: runtime.rust } : {}),
  };
}

function normalizeSchemaVersion(
  value: number | null | undefined
): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function assetMismatchIssue(args: {
  issues: SyncularSchemaReadinessIssue[];
  code: Extract<
    SyncularSchemaReadinessIssueCode,
    | 'runtime.worker_asset_mismatch'
    | 'runtime.wasm_glue_asset_mismatch'
    | 'runtime.wasm_asset_mismatch'
  >;
  message: string;
  expected?: SyncularSchemaReadinessRuntimeAssetInput;
  actual?: string;
  expectedKey: string;
  actualKey: string;
}): void {
  const expected = runtimeAssetHref(args.expected);
  if (expected === undefined) return;
  if (args.actual === expected) return;

  args.issues.push({
    code: args.code,
    severity: 'error',
    message: args.message,
    recommendedAction: 'refreshRuntimeAssets',
    details: {
      [args.expectedKey]: redactRuntimeAssetUrl(expected),
      [args.actualKey]:
        args.actual === undefined ? null : redactRuntimeAssetUrl(args.actual),
    },
  });
}

function runtimeAssetHref(
  value: SyncularSchemaReadinessRuntimeAssetInput | undefined
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.href;
  return value.url;
}

function redactRuntimeAssetUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

function readinessStatus(
  issues: readonly SyncularSchemaReadinessIssue[]
): SyncularSchemaReadinessStatus {
  if (
    issues.some(
      (issue) =>
        issue.code === 'runtime.info_unavailable' ||
        issue.code === 'runtime.schema_state_unavailable'
    )
  ) {
    return 'unknown';
  }
  if (issues.some((issue) => issue.severity === 'error')) {
    return 'not-ready';
  }
  if (issues.some((issue) => issue.severity === 'warning')) {
    return 'warning';
  }
  return 'ready';
}

function errorDetails(error: unknown): Record<string, unknown> {
  return {
    message: syncularErrorMessage(error),
    ...(error instanceof Error ? { name: error.name } : {}),
  };
}
