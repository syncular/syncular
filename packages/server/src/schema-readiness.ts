import type { Kysely } from 'kysely';

export const SYNCULAR_CORE_TABLES = [
  'sync_commits',
  'sync_changes',
  'sync_client_cursors',
  'sync_crdt_updates',
  'sync_crdt_checkpoints',
  'sync_table_commits',
  'sync_scope_commits',
  'sync_snapshot_chunks',
  'sync_snapshot_artifacts',
] as const;

export type SyncularCoreTable = (typeof SYNCULAR_CORE_TABLES)[number];

export type SyncularServerSchemaReadinessStatus =
  | 'ready'
  | 'warning'
  | 'not-ready'
  | 'unknown';

export type SyncularServerSchemaReadinessIssueSeverity = 'warning' | 'error';

export type SyncularServerSchemaReadinessIssueCode =
  | 'server.schema_introspection_unavailable'
  | 'server.sync_schema_missing'
  | 'server.app_tables_missing'
  | 'server.schema_version_required_newer_client'
  | 'server.schema_version_server_stale'
  | 'server.schema_version_newer_available';

export type SyncularServerSchemaReadinessAction =
  | 'runEnsureSyncSchema'
  | 'runAppMigrations'
  | 'redeployServer'
  | 'upgradeClient'
  | 'regenerateClient'
  | 'inspectDatabase';

export interface SyncularServerSchemaVersionState {
  expectedSchemaVersion?: number | null;
  requiredSchemaVersion?: number | null;
  latestSchemaVersion?: number | null;
}

export interface SyncularServerSchemaReadinessOptions
  extends SyncularServerSchemaVersionState {
  expectedAppTables?: readonly string[];
  now?: () => number;
}

export interface SyncularServerSchemaReadinessIssue {
  code: SyncularServerSchemaReadinessIssueCode;
  severity: SyncularServerSchemaReadinessIssueSeverity;
  message: string;
  recommendedAction: SyncularServerSchemaReadinessAction;
  details?: Record<string, unknown>;
}

export interface SyncularServerSchemaReadinessTables {
  installed: string[];
  expectedCore: SyncularCoreTable[];
  expectedApp: string[];
  missingCore: SyncularCoreTable[];
  missingApp: string[];
}

export interface SyncularServerSchemaReadinessResult {
  generatedAt: number;
  status: SyncularServerSchemaReadinessStatus;
  ready: boolean;
  requiresAction: boolean;
  tables: SyncularServerSchemaReadinessTables;
  schemaVersion: Required<SyncularServerSchemaVersionState>;
  issues: SyncularServerSchemaReadinessIssue[];
}

export async function getSyncularServerSchemaReadiness<DB>(
  db: Kysely<DB>,
  options: SyncularServerSchemaReadinessOptions = {}
): Promise<SyncularServerSchemaReadinessResult> {
  const issues: SyncularServerSchemaReadinessIssue[] = [];
  const installedTables = await readInstalledTables(db, issues);
  const expectedApp = [...(options.expectedAppTables ?? [])].sort();
  const missingCore =
    installedTables === null
      ? [...SYNCULAR_CORE_TABLES]
      : SYNCULAR_CORE_TABLES.filter((table) => !installedTables.has(table));
  const missingApp =
    installedTables === null
      ? expectedApp
      : expectedApp.filter((table) => !installedTables.has(table));

  if (installedTables !== null && missingCore.length > 0) {
    issues.push({
      code: 'server.sync_schema_missing',
      severity: 'error',
      message: 'The server database is missing Syncular core tables.',
      recommendedAction: 'runEnsureSyncSchema',
      details: { missingTables: missingCore },
    });
  }

  if (installedTables !== null && missingApp.length > 0) {
    issues.push({
      code: 'server.app_tables_missing',
      severity: 'error',
      message: 'The server database is missing app tables expected by sync.',
      recommendedAction: 'runAppMigrations',
      details: { missingTables: missingApp },
    });
  }

  issues.push(
    ...schemaVersionIssues({
      expectedSchemaVersion: normalizeVersion(options.expectedSchemaVersion),
      requiredSchemaVersion: normalizeVersion(options.requiredSchemaVersion),
      latestSchemaVersion: normalizeVersion(options.latestSchemaVersion),
    })
  );

  const status = readinessStatus(issues);
  return {
    generatedAt: options.now?.() ?? Date.now(),
    status,
    ready: status === 'ready' || status === 'warning',
    requiresAction: issues.some((issue) => issue.severity === 'error'),
    tables: {
      installed: installedTables ? [...installedTables].sort() : [],
      expectedCore: [...SYNCULAR_CORE_TABLES],
      expectedApp,
      missingCore,
      missingApp,
    },
    schemaVersion: {
      expectedSchemaVersion: normalizeVersion(options.expectedSchemaVersion),
      requiredSchemaVersion: normalizeVersion(options.requiredSchemaVersion),
      latestSchemaVersion: normalizeVersion(options.latestSchemaVersion),
    },
    issues,
  };
}

async function readInstalledTables<DB>(
  db: Kysely<DB>,
  issues: SyncularServerSchemaReadinessIssue[]
): Promise<Set<string> | null> {
  try {
    const tables = await db.introspection.getTables();
    return new Set(tables.map((table) => table.name));
  } catch (error) {
    issues.push({
      code: 'server.schema_introspection_unavailable',
      severity: 'error',
      message: 'The server database schema could not be introspected.',
      recommendedAction: 'inspectDatabase',
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}

function schemaVersionIssues(
  state: Required<SyncularServerSchemaVersionState>
): SyncularServerSchemaReadinessIssue[] {
  const issues: SyncularServerSchemaReadinessIssue[] = [];
  if (state.expectedSchemaVersion === null) return issues;

  if (
    state.requiredSchemaVersion !== null &&
    state.requiredSchemaVersion > state.expectedSchemaVersion
  ) {
    issues.push({
      code: 'server.schema_version_required_newer_client',
      severity: 'error',
      message:
        'The server requires a newer generated client schema than this deploy expects.',
      recommendedAction: 'upgradeClient',
      details: state,
    });
  }

  if (
    state.latestSchemaVersion !== null &&
    state.latestSchemaVersion < state.expectedSchemaVersion
  ) {
    issues.push({
      code: 'server.schema_version_server_stale',
      severity: 'error',
      message:
        'The server latest schema version is older than this generated deploy.',
      recommendedAction: 'redeployServer',
      details: state,
    });
  }

  if (
    state.latestSchemaVersion !== null &&
    state.latestSchemaVersion > state.expectedSchemaVersion
  ) {
    issues.push({
      code: 'server.schema_version_newer_available',
      severity: 'warning',
      message:
        'The server knows about a newer schema than this generated deploy expects.',
      recommendedAction: 'regenerateClient',
      details: state,
    });
  }

  return issues;
}

function normalizeVersion(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readinessStatus(
  issues: readonly SyncularServerSchemaReadinessIssue[]
): SyncularServerSchemaReadinessStatus {
  if (
    issues.some(
      (issue) => issue.code === 'server.schema_introspection_unavailable'
    )
  ) {
    return 'unknown';
  }
  if (issues.some((issue) => issue.severity === 'error')) return 'not-ready';
  if (issues.some((issue) => issue.severity === 'warning')) return 'warning';
  return 'ready';
}
