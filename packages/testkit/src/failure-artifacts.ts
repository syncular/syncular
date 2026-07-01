export const SYNCULAR_FAILURE_ARTIFACT_SENSITIVE_KEYS = [
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'mnemonic',
  'password',
  'plaintext',
  'privatekey',
  'refreshtoken',
  'secret',
  'seedphrase',
] as const;

export type SyncularFailureArtifactSensitiveKey =
  (typeof SYNCULAR_FAILURE_ARTIFACT_SENSITIVE_KEYS)[number];

export interface SyncularFailureArtifactAssertionOptions {
  path?: string;
  allowSensitiveFields?: boolean;
  forbiddenSubstrings?: readonly string[];
}

export type SyncularBrowserPreviewFailureArtifact = {
  generatedAt: string;
  metrics: SyncularBrowserPreviewFailureMetrics;
  reason: string;
  probe: SyncularBrowserPreviewProbe | null;
};

export type SyncularBrowserPreviewFailureMetrics = {
  artifactCreatedAfterMs: number;
  assetCheckMs: number;
  assetCount: number;
  browserHealthMarkerInAssets: boolean;
  browserSupportPolicyMarkerInAssets: boolean;
  commandTimelineMarkerInAssets: boolean;
  cssAssetBytes: number;
  cssAssetCount: number;
  deploymentPreflightMarkerInAssets: boolean;
  jsAssetBytes: number;
  jsAssetCount: number;
  lifecycleResumeMarkerInAssets: boolean;
  otherAssetBytes: number;
  otherAssetCount: number;
  previewReadyMs: number;
  starterTimelineMarkerInAssets: boolean;
  storageRecoveryMarkerInAssets: boolean;
  supportBundleMarkerInAssets: boolean;
  totalAssetBytes: number;
};

export type SyncularBrowserPreviewProbe = {
  ready: boolean;
  errors: string[];
  markers: Record<string, boolean>;
  browserHealth: Record<string, unknown>;
  deploymentPreflight: Record<string, unknown>;
  browserSupportPolicy: Record<string, unknown>;
  commandTimelineProof: Record<string, unknown>;
  supportBundle: Record<string, unknown>;
  lifecycleResume: Record<string, unknown>;
  lifecyclePause: Record<string, unknown>;
  starterTimeline: Record<string, unknown>;
  textExcerpt: string;
};

export type SyncularCloudflareRuntimeFailureArtifact = {
  generatedAt: string;
  reason: string;
  probe: SyncularCloudflareRuntimeFailureProbe;
};

export type SyncularCloudflareRuntimeFailureProbe = {
  blobMetrics: SyncularCloudflareBlobRouteMetrics | null;
  blobRouteBase: string | null;
  expectedText: string;
  exited: { code: number | null; signal: string | null } | null;
  outputExcerpt: string;
  port: number;
  route: string;
  syncRouteBase: string | null;
  webSocketRoute: string | null;
};

export type SyncularCloudflareBlobRouteMetrics = {
  attempted: boolean;
  completeUploadMs: number | null;
  contentBytes: number | null;
  downloadBytes: number | null;
  downloadBytesMs: number | null;
  downloadUrlMs: number | null;
  partitionedDownloadBytes: number | null;
  partitionedDownloadBytesMs: number | null;
  partitionedDownloadUrlMs: number | null;
  referencePushMs: number | null;
  totalMs: number | null;
  uploadBytesMs: number | null;
  uploadInitMs: number | null;
};

const BROWSER_TEXT_EXCERPT_MAX = 4000;
const CLOUDFLARE_OUTPUT_EXCERPT_MAX = 12_003;
const SENSITIVE_KEYS = new Set<string>(
  SYNCULAR_FAILURE_ARTIFACT_SENSITIVE_KEYS
);

export function requireBrowserPreviewFailureArtifact(
  artifact: unknown,
  options: SyncularFailureArtifactAssertionOptions = {}
): SyncularBrowserPreviewFailureArtifact {
  assertFailureArtifactRedacted(artifact, options);
  const path = options.path ?? '$';
  assertRecord(artifact, path);
  assertParseableDate(artifact.generatedAt, `${path}.generatedAt`);
  assertNonEmptyString(artifact.reason, `${path}.reason`);
  assertBrowserPreviewFailureMetrics(artifact.metrics, `${path}.metrics`);
  if (artifact.probe !== null) {
    assertBrowserPreviewProbe(artifact.probe, `${path}.probe`);
  }
  return artifact as SyncularBrowserPreviewFailureArtifact;
}

export function requireCloudflareRuntimeFailureArtifact(
  artifact: unknown,
  options: SyncularFailureArtifactAssertionOptions = {}
): SyncularCloudflareRuntimeFailureArtifact {
  assertFailureArtifactRedacted(artifact, options);
  const path = options.path ?? '$';
  assertRecord(artifact, path);
  assertParseableDate(artifact.generatedAt, `${path}.generatedAt`);
  assertNonEmptyString(artifact.reason, `${path}.reason`);
  assertCloudflareRuntimeFailureProbe(artifact.probe, `${path}.probe`);
  return artifact as SyncularCloudflareRuntimeFailureArtifact;
}

export function assertFailureArtifactRedacted(
  artifact: unknown,
  options: SyncularFailureArtifactAssertionOptions = {}
): void {
  if (!options.allowSensitiveFields) {
    const sensitiveField = findFailureArtifactSensitiveField(
      artifact,
      options.path ?? '$'
    );
    if (sensitiveField) {
      throw new Error(
        `Expected Syncular failure artifact to be redacted, but found sensitive field ${sensitiveField}`
      );
    }
  }

  const serialized = JSON.stringify(artifact) ?? '';
  for (const forbidden of options.forbiddenSubstrings ?? []) {
    if (forbidden.length > 0 && serialized.includes(forbidden)) {
      throw new Error(
        `Expected Syncular failure artifact to exclude forbidden substring ${JSON.stringify(
          forbidden
        )}`
      );
    }
  }
}

export function findFailureArtifactSensitiveField(
  value: unknown,
  path = '$',
  depth = 0
): string | null {
  if (depth > 12 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findFailureArtifactSensitiveField(
        value[index],
        `${path}[${index}]`,
        depth + 1
      );
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizeSensitiveKey(key))) return `${path}.${key}`;
    const found = findFailureArtifactSensitiveField(
      entry,
      `${path}.${key}`,
      depth + 1
    );
    if (found) return found;
  }
  return null;
}

function assertBrowserPreviewFailureMetrics(
  value: unknown,
  path: string
): void {
  assertRecord(value, path);
  for (const key of [
    'artifactCreatedAfterMs',
    'assetCheckMs',
    'assetCount',
    'cssAssetBytes',
    'cssAssetCount',
    'jsAssetBytes',
    'jsAssetCount',
    'otherAssetBytes',
    'otherAssetCount',
    'previewReadyMs',
    'totalAssetBytes',
  ] as const) {
    assertNonNegativeNumber(value[key], `${path}.${key}`);
  }
  for (const key of [
    'browserHealthMarkerInAssets',
    'browserSupportPolicyMarkerInAssets',
    'commandTimelineMarkerInAssets',
    'deploymentPreflightMarkerInAssets',
    'lifecycleResumeMarkerInAssets',
    'starterTimelineMarkerInAssets',
    'storageRecoveryMarkerInAssets',
    'supportBundleMarkerInAssets',
  ] as const) {
    assertBoolean(value[key], `${path}.${key}`);
  }
}

function assertBrowserPreviewProbe(value: unknown, path: string): void {
  assertRecord(value, path);
  assertBoolean(value.ready, `${path}.ready`);
  assertTextArray(value.errors, `${path}.errors`);
  assertRecord(value.markers, `${path}.markers`);
  for (const [key, marker] of Object.entries(value.markers)) {
    assertBoolean(marker, `${path}.markers.${key}`);
  }
  assertBrowserHealth(value.browserHealth, `${path}.browserHealth`);
  assertRecord(value.deploymentPreflight, `${path}.deploymentPreflight`);
  assertRecord(value.browserSupportPolicy, `${path}.browserSupportPolicy`);
  assertBrowserSupportPolicyCounts(
    value.browserSupportPolicy,
    `${path}.browserSupportPolicy`
  );
  assertBrowserCommandTimelineProof(
    value.commandTimelineProof,
    `${path}.commandTimelineProof`
  );
  assertBrowserPreviewSupportBundle(
    value.supportBundle,
    `${path}.supportBundle`
  );
  assertBrowserLifecycleResume(
    value.lifecycleResume,
    `${path}.lifecycleResume`
  );
  assertBrowserLifecyclePause(value.lifecyclePause, `${path}.lifecyclePause`);
  assertBrowserStarterTimeline(
    value.starterTimeline,
    `${path}.starterTimeline`
  );
  assertBoundedString(
    value.textExcerpt,
    BROWSER_TEXT_EXCERPT_MAX,
    `${path}.textExcerpt`
  );
}

function assertBrowserHealth(value: unknown, path: string): void {
  assertRecord(value, path);
  assertNonNegativeNumber(
    value.blockedOperationCount,
    `${path}.blockedOperationCount`
  );
  for (const key of [
    'generatedMutation',
    'lifecycleStage',
    'localVisibility',
    'recoveryOwner',
    'status',
    'syncNow',
  ] as const) {
    assertNullableString(value[key], `${path}.${key}`);
  }
}

function assertBrowserSupportPolicyCounts(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const key of [
    'knownRisks',
    'nextSteps',
    'reasonCodes',
    'requiredEvidence',
  ] as const) {
    assertTextArray(value[key], `${path}.${key}`);
  }
  assertCountMatchesArray(value, 'knownRiskCount', 'knownRisks', path);
  assertCountMatchesArray(value, 'nextStepCount', 'nextSteps', path);
  assertCountMatchesArray(value, 'reasonCount', 'reasonCodes', path);
  assertCountMatchesArray(
    value,
    'requiredEvidenceCount',
    'requiredEvidence',
    path
  );
}

function assertBrowserPreviewSupportBundle(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const key of [
    'blobEventCount',
    'cursorCount',
    'issueCount',
    'localApplyEventCount',
    'realtimeEventCount',
    'requestIdCount',
    'sectionCount',
    'sectionErrorCount',
    'syncAttemptIdCount',
    'syncEventCount',
    'timelineEventCount',
  ] as const) {
    assertNonNegativeNumber(value[key], `${path}.${key}`);
  }
  if (value.redacted !== 'true') {
    throw new Error(`${path}.redacted was not "true"`);
  }
}

function assertBrowserCommandTimelineProof(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const key of [
    'complete',
    'localApplyObserved',
    'localVisibilityObserved',
    'outboxPersisted',
    'pullReasonObserved',
    'realtimeCursorObserved',
    'requestCorrelated',
    'scopeJoined',
    'serverCommitObserved',
    'syncAttemptObserved',
  ] as const) {
    assertBoolean(value[key], `${path}.${key}`);
  }
  for (const key of ['missingEvidence', 'subscriptionIds'] as const) {
    assertTextArray(value[key], `${path}.${key}`);
  }
  assertCountMatchesArray(
    value,
    'missingEvidenceCount',
    'missingEvidence',
    path
  );
  assertCountMatchesArray(
    value,
    'subscriptionIdCount',
    'subscriptionIds',
    path
  );
  for (const key of [
    'clientCommitId',
    'error',
    'errorCode',
    'localApplyOutboxId',
    'localVisibilitySource',
    'localVisibilityState',
    'localVisibilityTrigger',
    'pullReason',
    'requestId',
    'state',
    'status',
    'syncAttemptId',
    'traceId',
    'spanId',
  ] as const) {
    assertNullableString(value[key], `${path}.${key}`);
  }
  for (const key of [
    'contextEventCount',
    'count',
    'eventCount',
    'matchedEventCount',
  ] as const) {
    assertNonNegativeNumber(value[key], `${path}.${key}`);
  }
  for (const key of [
    'durationMs',
    'localApplyCommitSeq',
    'serverCommitSeq',
  ] as const) {
    assertNullableNonNegativeNumber(value[key], `${path}.${key}`);
  }
  if (
    value.realtimeCursor !== null &&
    typeof value.realtimeCursor !== 'string'
  ) {
    assertNonNegativeNumber(value.realtimeCursor, `${path}.realtimeCursor`);
  }
}

function assertBrowserLifecycleResume(value: unknown, path: string): void {
  assertRecord(value, path);
  assertNonNegativeNumber(value.count, `${path}.count`);
  for (const key of [
    'status',
    'reason',
    'error',
    'lockName',
    'lockRequired',
    'lockState',
  ] as const) {
    assertNullableString(value[key], `${path}.${key}`);
  }
}

function assertBrowserLifecyclePause(value: unknown, path: string): void {
  assertRecord(value, path);
  assertNonNegativeNumber(value.count, `${path}.count`);
  assertNonNegativeNumber(
    value.shutdownSignalCount,
    `${path}.shutdownSignalCount`
  );
  for (const key of [
    'reason',
    'pagehidePersisted',
    'visibilityState',
  ] as const) {
    assertNullableString(value[key], `${path}.${key}`);
  }
}

function assertBrowserStarterTimeline(value: unknown, path: string): void {
  assertRecord(value, path);
  assertBoolean(value.marker, `${path}.marker`);
  for (const key of [
    'bootstrapReadyMs',
    'databaseOpenMs',
    'healthRefreshMs',
    'localVisibilityMs',
    'realtimeConnectedMs',
    'schemaReadinessMs',
    'supportBundleExportMs',
  ] as const) {
    assertNullableNonNegativeNumber(value[key], `${path}.${key}`);
  }
}

function assertCloudflareRuntimeFailureProbe(
  value: unknown,
  path: string
): void {
  assertRecord(value, path);
  assertCloudflareBlobRouteMetrics(value.blobMetrics, `${path}.blobMetrics`);
  for (const key of [
    'blobRouteBase',
    'syncRouteBase',
    'webSocketRoute',
  ] as const) {
    assertNullableString(value[key], `${path}.${key}`);
  }
  for (const key of ['expectedText', 'route'] as const) {
    assertNonEmptyString(value[key], `${path}.${key}`);
  }
  assertBoundedString(
    value.outputExcerpt,
    CLOUDFLARE_OUTPUT_EXCERPT_MAX,
    `${path}.outputExcerpt`
  );
  if (
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    value.port <= 0
  ) {
    throw new Error(`${path}.port was not a positive integer`);
  }
  if (value.exited !== null) {
    assertRecord(value.exited, `${path}.exited`);
    assertNullableNumber(value.exited.code, `${path}.exited.code`);
    assertNullableString(value.exited.signal, `${path}.exited.signal`);
  }
}

function assertCloudflareBlobRouteMetrics(value: unknown, path: string): void {
  if (value === null) return;
  assertRecord(value, path);
  assertBoolean(value.attempted, `${path}.attempted`);
  for (const key of [
    'completeUploadMs',
    'contentBytes',
    'downloadBytes',
    'downloadBytesMs',
    'downloadUrlMs',
    'partitionedDownloadBytes',
    'partitionedDownloadBytesMs',
    'partitionedDownloadUrlMs',
    'referencePushMs',
    'totalMs',
    'uploadBytesMs',
    'uploadInitMs',
  ] as const) {
    assertNullableNonNegativeNumber(value[key], `${path}.${key}`);
  }
}

function assertCountMatchesArray(
  record: Record<string, unknown>,
  countKey: string,
  arrayKey: string,
  path: string
): void {
  assertNonNegativeNumber(record[countKey], `${path}.${countKey}`);
  const array = record[arrayKey];
  if (!Array.isArray(array)) {
    throw new Error(`${path}.${arrayKey} was not an array`);
  }
  if (record[countKey] !== array.length) {
    throw new Error(`${path}.${countKey} did not match ${arrayKey}.length`);
  }
}

function assertTextArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path} was not a string array`);
  }
}

function assertRecord(
  value: unknown,
  path: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} was not a JSON object`);
}

function assertParseableDate(value: unknown, path: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} was not a parseable date string`);
  }
}

function assertNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} was not a non-empty string`);
  }
}

function assertBoundedString(
  value: unknown,
  maxLength: number,
  path: string
): void {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${path} was not a bounded string`);
  }
}

function assertNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${path} was not nullable text`);
  }
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`${path} was not a boolean`);
}

function assertNonNegativeNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} was not a non-negative number`);
  }
}

function assertNullableNumber(value: unknown, path: string): void {
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error(`${path} was not nullable number`);
  }
}

function assertNullableNonNegativeNumber(value: unknown, path: string): void {
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`${path} was not nullable non-negative number`);
  }
}

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
