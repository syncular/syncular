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
  | 'runtime.schema_state_unavailable';

export type SyncularSchemaReadinessAction =
  | 'openDatabase'
  | 'runSyncularGenerate'
  | 'runSchemaMigrations'
  | 'redeployServer'
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

export interface SyncularSchemaReadinessOptions {
  /**
   * Pass the schema version baked into the generated client. Without it the
   * helper can still inspect the local runtime, but cannot prove generated
   * output freshness.
   */
  generatedSchemaVersion?: number;
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

  const runtime =
    runtimeResult.status === 'fulfilled'
      ? summarizeRuntimeInfo(runtimeResult.value)
      : null;
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

function readinessStatus(
  issues: readonly SyncularSchemaReadinessIssue[]
): SyncularSchemaReadinessStatus {
  if (issues.some((issue) => issue.code.startsWith('runtime.'))) {
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
