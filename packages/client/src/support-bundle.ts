import {
  getSyncularBrowserDeploymentPreflight,
  type SyncularBrowserDeploymentPreflight,
  type SyncularBrowserDeploymentPreflightOptions,
} from './browser-deployment-preflight';
import {
  getSyncularBrowserHealth,
  type SyncularBrowserHealth,
  type SyncularBrowserHealthRuntime,
} from './browser-health';
import type { SyncularClientStatus } from './client';
import { SYNCULAR_DIAGNOSTIC_DETAIL_POLICY } from './console-diagnostics';
import {
  getSyncularRuntimeTimeline,
  type SyncularRuntimeTimeline,
  type SyncularRuntimeTimelineOptions,
} from './runtime-timeline';
import {
  getSyncularSchemaReadiness,
  type SyncularSchemaReadinessOptions,
  type SyncularSchemaReadinessResult,
} from './schema-readiness';
import type {
  SyncularDiagnosticSnapshot,
  SyncularLocalSupportBundle,
  SyncularRuntimeInfo,
  SyncularSchemaState,
} from './types';

export type SyncularSupportBundleStatus = 'ok' | 'warning' | 'action-required';

export type SyncularSupportBundleSectionStatus =
  | 'included'
  | 'omitted'
  | 'failed';

export interface SyncularSupportBundleClient {
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
  runtimeInfo(): Promise<SyncularRuntimeInfo>;
  generatedSchemaState(): Promise<SyncularSchemaState>;
  exportLocalSupportBundle(): Promise<SyncularLocalSupportBundle>;
}

export interface SyncularSupportBundleOptions {
  now?: () => number;
  includeBrowserHealth?: boolean;
  includeRuntimeTimeline?: boolean;
  includeSchemaReadiness?: boolean;
  includeLocalSupportBundle?: boolean;
  runtimeTimelineOptions?: SyncularRuntimeTimelineOptions;
  schemaReadinessOptions?: SyncularSchemaReadinessOptions;
  deploymentPreflight?:
    | false
    | SyncularBrowserDeploymentPreflight
    | SyncularBrowserDeploymentPreflightOptions;
}

export interface SyncularSupportBundleRuntime {
  packageName?: string;
  packageVersion?: string;
  workerProtocolVersion?: number;
  rust?: SyncularBrowserHealthRuntime['rust'];
}

export interface SyncularSupportBundleBrowserHealth
  extends Omit<SyncularBrowserHealth, 'runtime'> {
  runtime: SyncularSupportBundleRuntime & {
    runtimeAssetUrlsRedacted: true;
  };
}

export interface SyncularSupportBundleDeploymentPreflight
  extends Omit<SyncularBrowserDeploymentPreflight, 'runtimeAssets'> {
  runtimeAssets: Omit<
    SyncularBrowserDeploymentPreflight['runtimeAssets'],
    'assets'
  > & {
    assets: Array<
      Omit<
        SyncularBrowserDeploymentPreflight['runtimeAssets']['assets'][number],
        'url'
      > & {
        urlRedacted: true;
      }
    >;
  };
}

export interface SyncularSupportBundleSectionError {
  section: keyof SyncularSupportBundleSections;
  message: string;
}

export interface SyncularSupportBundleSections {
  browserHealth: SyncularSupportBundleSectionStatus;
  runtimeTimeline: SyncularSupportBundleSectionStatus;
  schemaReadiness: SyncularSupportBundleSectionStatus;
  deploymentPreflight: SyncularSupportBundleSectionStatus;
  localSupportBundle: SyncularSupportBundleSectionStatus;
}

export interface SyncularSupportBundleSummary {
  status: SyncularSupportBundleStatus;
  requiresAction: boolean;
  issueCodes: string[];
  syncAttemptIds: string[];
  traceIds: string[];
  spanIds: string[];
  affectedTables: string[];
  subscriptionIds: string[];
  subscriptionCursors: Array<{
    id: string;
    table: string;
    cursor: number | null;
  }>;
  runtime: SyncularSupportBundleRuntime | null;
}

export interface SyncularSupportBundleRedaction {
  redacted: true;
  diagnosticDetailPolicy: {
    safeKeys: string[];
    summarizedKeys: string[];
    redactedKeys: string[];
    omittedKeys: string[];
  };
  redactedValue: '[redacted]';
  omittedRuntimeUrlFields: ['workerUrl', 'wasmGlueUrl', 'wasmUrl'];
}

export interface SyncularSupportBundle {
  formatVersion: 1;
  generatedAt: number;
  redacted: true;
  source: '@syncular/client';
  summary: SyncularSupportBundleSummary;
  sections: SyncularSupportBundleSections;
  sectionErrors: SyncularSupportBundleSectionError[];
  redaction: SyncularSupportBundleRedaction;
  browserHealth?: SyncularSupportBundleBrowserHealth;
  runtimeTimeline?: SyncularRuntimeTimeline;
  schemaReadiness?: SyncularSchemaReadinessResult;
  deploymentPreflight?: SyncularSupportBundleDeploymentPreflight;
  localSupportBundle?: SyncularLocalSupportBundle;
}

export async function getSyncularSupportBundle(
  client: SyncularSupportBundleClient,
  options: SyncularSupportBundleOptions = {}
): Promise<SyncularSupportBundle> {
  const generatedAt = options.now?.() ?? Date.now();
  const [
    browserHealthResult,
    runtimeTimelineResult,
    schemaReadinessResult,
    deploymentPreflightResult,
    localSupportBundleResult,
  ] = await Promise.all([
    collectOptionalSection(options.includeBrowserHealth !== false, () =>
      getSyncularBrowserHealth(client)
    ),
    collectOptionalSection(options.includeRuntimeTimeline !== false, () =>
      getSyncularRuntimeTimeline(client, {
        ...options.runtimeTimelineOptions,
        now: () => generatedAt,
      })
    ),
    collectOptionalSection(options.includeSchemaReadiness !== false, () =>
      getSyncularSchemaReadiness(client, {
        ...options.schemaReadinessOptions,
        now: () => generatedAt,
      })
    ),
    collectOptionalSection(
      options.deploymentPreflight !== undefined &&
        options.deploymentPreflight !== false,
      () => resolveDeploymentPreflight(options.deploymentPreflight)
    ),
    collectOptionalSection(options.includeLocalSupportBundle !== false, () =>
      client.exportLocalSupportBundle()
    ),
  ]);

  const browserHealth = mapSectionValue(
    browserHealthResult,
    sanitizeBrowserHealth
  );
  const runtimeTimeline = sectionValue(runtimeTimelineResult);
  const schemaReadiness = sectionValue(schemaReadinessResult);
  const deploymentPreflight = mapSectionValue(
    deploymentPreflightResult,
    sanitizeDeploymentPreflight
  );
  const localSupportBundle = sectionValue(localSupportBundleResult);
  const sections: SyncularSupportBundleSections = {
    browserHealth: browserHealthResult.status,
    runtimeTimeline: runtimeTimelineResult.status,
    schemaReadiness: schemaReadinessResult.status,
    deploymentPreflight: deploymentPreflightResult.status,
    localSupportBundle: localSupportBundleResult.status,
  };
  const sectionErrors = [
    sectionError('browserHealth', browserHealthResult),
    sectionError('runtimeTimeline', runtimeTimelineResult),
    sectionError('schemaReadiness', schemaReadinessResult),
    sectionError('deploymentPreflight', deploymentPreflightResult),
    sectionError('localSupportBundle', localSupportBundleResult),
  ].filter(
    (error): error is SyncularSupportBundleSectionError => error !== null
  );
  const summary = summarizeSupportBundle({
    browserHealth,
    runtimeTimeline,
    schemaReadiness,
    deploymentPreflight,
    localSupportBundle,
    sectionErrors,
  });

  return {
    formatVersion: 1,
    generatedAt,
    redacted: true,
    source: '@syncular/client',
    summary,
    sections,
    sectionErrors,
    redaction: supportBundleRedaction(),
    ...(browserHealth ? { browserHealth } : {}),
    ...(runtimeTimeline ? { runtimeTimeline } : {}),
    ...(schemaReadiness ? { schemaReadiness } : {}),
    ...(deploymentPreflight ? { deploymentPreflight } : {}),
    ...(localSupportBundle ? { localSupportBundle } : {}),
  };
}

type OptionalSection<T> =
  | {
      status: 'included';
      value: T;
    }
  | {
      status: 'omitted';
    }
  | {
      status: 'failed';
      error: unknown;
    };

async function collectOptionalSection<T>(
  include: boolean,
  collect: () => Promise<T>
): Promise<OptionalSection<T>> {
  if (!include) return { status: 'omitted' };
  try {
    return { status: 'included', value: await collect() };
  } catch (error) {
    return { status: 'failed', error };
  }
}

function sectionValue<T>(section: OptionalSection<T>): T | undefined {
  return section.status === 'included' ? section.value : undefined;
}

function mapSectionValue<T, TOutput>(
  section: OptionalSection<T>,
  map: (value: T) => TOutput
): TOutput | undefined {
  return section.status === 'included' ? map(section.value) : undefined;
}

function sectionError(
  section: keyof SyncularSupportBundleSections,
  result: OptionalSection<unknown>
): SyncularSupportBundleSectionError | null {
  if (result.status !== 'failed') return null;
  return {
    section,
    message: errorMessage(result.error),
  };
}

async function resolveDeploymentPreflight(
  preflight:
    | false
    | SyncularBrowserDeploymentPreflight
    | SyncularBrowserDeploymentPreflightOptions
    | undefined
): Promise<SyncularBrowserDeploymentPreflight> {
  if (!preflight) {
    throw new Error('Deployment preflight was not provided.');
  }
  if (isDeploymentPreflightResult(preflight)) return preflight;
  return getSyncularBrowserDeploymentPreflight(preflight);
}

function isDeploymentPreflightResult(
  value:
    | SyncularBrowserDeploymentPreflight
    | SyncularBrowserDeploymentPreflightOptions
): value is SyncularBrowserDeploymentPreflight {
  return 'ready' in value && 'issues' in value && 'runtimeAssets' in value;
}

function sanitizeBrowserHealth(
  health: SyncularBrowserHealth
): SyncularSupportBundleBrowserHealth {
  const { runtime, ...rest } = health;
  return {
    ...rest,
    runtime: {
      packageName: runtime.packageName,
      packageVersion: runtime.packageVersion,
      workerProtocolVersion: runtime.workerProtocolVersion,
      ...(runtime.rust ? { rust: runtime.rust } : {}),
      runtimeAssetUrlsRedacted: true,
    },
  };
}

function sanitizeDeploymentPreflight(
  preflight: SyncularBrowserDeploymentPreflight
): SyncularSupportBundleDeploymentPreflight {
  return {
    ...preflight,
    runtimeAssets: {
      ...preflight.runtimeAssets,
      assets: preflight.runtimeAssets.assets.map(({ url: _url, ...asset }) => ({
        ...asset,
        urlRedacted: true,
      })),
    },
  };
}

function summarizeSupportBundle(args: {
  browserHealth?: SyncularSupportBundleBrowserHealth;
  runtimeTimeline?: SyncularRuntimeTimeline;
  schemaReadiness?: SyncularSchemaReadinessResult;
  deploymentPreflight?: SyncularSupportBundleDeploymentPreflight;
  localSupportBundle?: SyncularLocalSupportBundle;
  sectionErrors: readonly SyncularSupportBundleSectionError[];
}): SyncularSupportBundleSummary {
  const issueCodes = uniqueSorted([
    ...collectBrowserHealthIssueCodes(args.browserHealth),
    ...collectTimelineIssueCodes(args.runtimeTimeline),
    ...collectSchemaIssueCodes(args.schemaReadiness),
    ...collectDeploymentIssueCodes(args.deploymentPreflight),
    ...collectLocalIssueCodes(args.localSupportBundle),
    ...args.sectionErrors.map((error) => `support.${error.section}_failed`),
  ]);
  const requiresAction =
    args.browserHealth?.requiresAction === true ||
    args.runtimeTimeline?.requiresAction === true ||
    args.schemaReadiness?.requiresAction === true ||
    args.deploymentPreflight?.requiresAction === true ||
    args.localSupportBundle?.health.ok === false;
  const warning =
    args.browserHealth?.status === 'degraded' ||
    args.browserHealth?.status === 'offline' ||
    args.runtimeTimeline?.status === 'warning' ||
    args.schemaReadiness?.status === 'warning' ||
    args.deploymentPreflight?.status === 'warning' ||
    args.sectionErrors.length > 0 ||
    issueCodes.length > 0;

  return {
    status: requiresAction ? 'action-required' : warning ? 'warning' : 'ok',
    requiresAction,
    issueCodes,
    syncAttemptIds: args.runtimeTimeline?.summary.syncAttemptIds ?? [],
    traceIds: uniqueSorted(
      args.runtimeTimeline?.events.flatMap((event) =>
        event.traceId ? [event.traceId] : []
      ) ?? []
    ),
    spanIds: uniqueSorted(
      args.runtimeTimeline?.events.flatMap((event) =>
        event.spanId ? [event.spanId] : []
      ) ?? []
    ),
    affectedTables: uniqueSorted([
      ...(args.runtimeTimeline?.summary.affectedTables ?? []),
      ...(args.localSupportBundle?.health.findings.flatMap((finding) =>
        finding.table ? [finding.table] : []
      ) ?? []),
    ]),
    subscriptionIds: uniqueSorted([
      ...(args.runtimeTimeline?.summary.subscriptionIds ?? []),
      ...(args.localSupportBundle?.health.findings.flatMap((finding) =>
        finding.subscriptionId ? [finding.subscriptionId] : []
      ) ?? []),
    ]),
    subscriptionCursors:
      args.browserHealth?.subscriptions.items.map((subscription) => ({
        id: subscription.id,
        table: subscription.table,
        cursor: subscription.cursor,
      })) ?? [],
    runtime: args.browserHealth?.runtime ?? null,
  };
}

function collectBrowserHealthIssueCodes(
  health: SyncularSupportBundleBrowserHealth | undefined
): string[] {
  return [
    ...(health?.recommendedActions.map((action) => action.code) ?? []),
    ...(health?.recentErrors.flatMap((error) =>
      error.code ? [error.code] : []
    ) ?? []),
    ...(health?.lastError?.code ? [health.lastError.code] : []),
  ];
}

function collectTimelineIssueCodes(
  timeline: SyncularRuntimeTimeline | undefined
): string[] {
  return timeline?.summary.lastError ? [timeline.summary.lastError.code] : [];
}

function collectSchemaIssueCodes(
  readiness: SyncularSchemaReadinessResult | undefined
): string[] {
  return readiness?.issues.map((issue) => issue.code) ?? [];
}

function collectDeploymentIssueCodes(
  preflight: SyncularSupportBundleDeploymentPreflight | undefined
): string[] {
  return preflight?.issues.map((issue) => issue.code) ?? [];
}

function collectLocalIssueCodes(
  bundle: SyncularLocalSupportBundle | undefined
): string[] {
  return bundle?.health.findings.map((finding) => finding.code) ?? [];
}

function supportBundleRedaction(): SyncularSupportBundleRedaction {
  return {
    redacted: true,
    diagnosticDetailPolicy: {
      safeKeys: [...SYNCULAR_DIAGNOSTIC_DETAIL_POLICY.safeKeys],
      summarizedKeys: [...SYNCULAR_DIAGNOSTIC_DETAIL_POLICY.summarizedKeys],
      redactedKeys: [...SYNCULAR_DIAGNOSTIC_DETAIL_POLICY.sensitiveKeys],
      omittedKeys: [...SYNCULAR_DIAGNOSTIC_DETAIL_POLICY.omittedKeys],
    },
    redactedValue: '[redacted]',
    omittedRuntimeUrlFields: ['workerUrl', 'wasmGlueUrl', 'wasmUrl'],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
