import { browserSyncularNetworkStatusSource } from './network';
import type {
  SyncularAuthHeaders,
  SyncularClientConfig,
  SyncularConsoleDiagnosticsOptions,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSnapshot,
  SyncularLifecycleState,
  SyncularNetworkStatusSource,
  SyncularRuntimeClient,
  SyncularSyncTimings,
} from './types';

const DEFAULT_MAX_PAYLOAD_BYTES = 48 * 1024;
const MIN_MAX_PAYLOAD_BYTES = 1024;
const DEFAULT_DEBOUNCE_MS = 100;
const MAX_MESSAGE_LENGTH = 240;
const MAX_STRING_DETAIL_LENGTH = 160;
const MAX_ARRAY_DETAIL_ITEMS = 8;

type ConsoleDiagnosticsClient = Pick<
  SyncularRuntimeClient,
  | 'addDiagnosticListener'
  | 'addEventListener'
  | 'diagnosticSnapshot'
  | 'lifecycleState'
>;

export interface SyncularConsoleDiagnosticsPayload {
  clientId: string;
  actorId?: string;
  partitionId: string;
  lifecycle?: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

export interface SyncularConsoleDiagnosticsPayloadResult {
  payload: SyncularConsoleDiagnosticsPayload;
  body: string;
  byteLength: number;
  compacted: boolean;
}

interface CreateSyncularConsoleDiagnosticsPublisherOptions
  extends SyncularConsoleDiagnosticsOptions {
  config: SyncularClientConfig;
  isClosed: () => boolean;
}

interface ResolvedConsoleDiagnosticsOptions {
  endpoint: string;
  clientId: string;
  actorId?: string;
  partitionId: string;
  token?: string;
  getHeaders?: () => SyncularAuthHeaders | Promise<SyncularAuthHeaders>;
  debounceMs: number | false;
  maxPayloadBytes: number;
  network: SyncularNetworkStatusSource | undefined;
}

interface CompactProfile {
  diagnosticCount: number;
  syncTimingCount: number;
  includeDetails: boolean;
  includeConnectionLastDiagnostic: boolean;
}

const COMPACT_PROFILES: CompactProfile[] = [
  {
    diagnosticCount: 40,
    syncTimingCount: 20,
    includeDetails: true,
    includeConnectionLastDiagnostic: true,
  },
  {
    diagnosticCount: 20,
    syncTimingCount: 10,
    includeDetails: true,
    includeConnectionLastDiagnostic: true,
  },
  {
    diagnosticCount: 10,
    syncTimingCount: 5,
    includeDetails: true,
    includeConnectionLastDiagnostic: true,
  },
  {
    diagnosticCount: 5,
    syncTimingCount: 3,
    includeDetails: false,
    includeConnectionLastDiagnostic: false,
  },
  {
    diagnosticCount: 2,
    syncTimingCount: 1,
    includeDetails: false,
    includeConnectionLastDiagnostic: false,
  },
  {
    diagnosticCount: 0,
    syncTimingCount: 0,
    includeDetails: false,
    includeConnectionLastDiagnostic: false,
  },
];

const SIMPLE_DETAIL_KEYS = new Set([
  'acked',
  'bytes',
  'changedRowCount',
  'changedRows',
  'changedRowsTruncated',
  'changedTableCount',
  'changedTables',
  'commitApplyMs',
  'conflicts',
  'cursor',
  'durationMs',
  'failed',
  'headerCount',
  'integrityVerifyMs',
  'message',
  'notifyMs',
  'operation',
  'pending',
  'pullApplyMs',
  'pullTransformMs',
  'pushedCommits',
  'reason',
  'requestType',
  'responseBytes',
  'rowId',
  'source',
  'status',
  'statusText',
  'subscriptionStateMs',
  'syncPackDecodeMs',
  'table',
  'total',
  'totalMs',
  'uploading',
]);

const OMITTED_DETAIL_KEYS = new Set([
  'changedRows',
  'subscriptions',
  'phases',
  'expectedSubscriptionIds',
  'readySubscriptionIds',
  'pendingSubscriptionIds',
]);

const SENSITIVE_DETAIL_KEYS = new Set([
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
]);

export function createSyncularConsoleDiagnosticsPublisher(
  client: ConsoleDiagnosticsClient,
  options: CreateSyncularConsoleDiagnosticsPublisherOptions
): { schedule(): void; destroy(): void } {
  const resolved = resolveConsoleDiagnosticsOptions(options);
  if (!resolved || typeof globalThis.fetch !== 'function') {
    return noopPublisher();
  }

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let publishAgain = false;
  let queuedWhileOffline = false;
  let lastCompletedFingerprint: string | undefined;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const isClosed = () => closed || options.isClosed();
  const isOnline = () => resolved.network?.isOnline() !== false;

  const publish = async () => {
    if (isClosed()) return;
    if (!isOnline()) {
      queuedWhileOffline = true;
      return;
    }
    if (inFlight) {
      publishAgain = true;
      return;
    }

    inFlight = true;
    try {
      const snapshot = await client.diagnosticSnapshot();
      const lifecycle = client.lifecycleState();
      const payload = buildSyncularConsoleDiagnosticsPayload({
        actorId: resolved.actorId,
        clientId: resolved.clientId,
        lifecycle,
        maxPayloadBytes: resolved.maxPayloadBytes,
        partitionId: resolved.partitionId,
        snapshot,
      });
      const fingerprint = payloadFingerprint(payload.payload);
      if (fingerprint === lastCompletedFingerprint) return;

      const response = await globalThis.fetch(resolved.endpoint, {
        method: 'POST',
        headers: await buildHeaders(resolved),
        body: payload.body,
      });
      if (response.ok || response.status < 500) {
        lastCompletedFingerprint = fingerprint;
      }
    } catch {
      if (!isOnline()) queuedWhileOffline = true;
    } finally {
      inFlight = false;
      if (publishAgain && !isClosed()) {
        publishAgain = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (isClosed()) return;
    if (!isOnline()) {
      queuedWhileOffline = true;
      clearTimer();
      return;
    }
    if (inFlight) {
      publishAgain = true;
      return;
    }
    clearTimer();
    if (resolved.debounceMs === false || resolved.debounceMs <= 0) {
      queueMicrotask(() => void publish());
      return;
    }
    timer = setTimeout(() => void publish(), resolved.debounceMs);
  };

  const handleOnline = () => {
    if (!queuedWhileOffline || isClosed()) return;
    queuedWhileOffline = false;
    schedule();
  };

  const stopListening = [
    client.addDiagnosticListener(schedule),
    client.addEventListener('bootstrapChanged', schedule),
    client.addEventListener('outboxChanged', schedule),
    client.addEventListener('conflictsChanged', schedule),
    client.addEventListener('blobUploadsChanged', schedule),
  ];
  resolved.network?.addEventListener?.('online', handleOnline);
  schedule();

  return {
    schedule,
    destroy() {
      closed = true;
      clearTimer();
      queuedWhileOffline = false;
      publishAgain = false;
      resolved.network?.removeEventListener?.('online', handleOnline);
      for (const stop of stopListening) stop();
    },
  };
}

export function buildSyncularConsoleDiagnosticsPayload(args: {
  clientId: string;
  actorId?: string;
  partitionId?: string;
  lifecycle?: SyncularLifecycleState;
  snapshot: SyncularDiagnosticSnapshot;
  maxPayloadBytes?: number;
}): SyncularConsoleDiagnosticsPayloadResult {
  const maxPayloadBytes = normalizeMaxPayloadBytes(args.maxPayloadBytes);
  let best: SyncularConsoleDiagnosticsPayloadResult | undefined;

  for (const profile of COMPACT_PROFILES) {
    const payload = createPayloadForProfile(args, profile);
    const body = JSON.stringify(payload);
    const byteLength = jsonByteLength(body);
    const result = {
      payload,
      body,
      byteLength,
      compacted: true,
    };
    best = result;
    if (byteLength <= maxPayloadBytes) return result;
  }

  return best as SyncularConsoleDiagnosticsPayloadResult;
}

function createPayloadForProfile(
  args: {
    clientId: string;
    actorId?: string;
    partitionId?: string;
    lifecycle?: SyncularLifecycleState;
    snapshot: SyncularDiagnosticSnapshot;
  },
  profile: CompactProfile
): SyncularConsoleDiagnosticsPayload {
  const payload: SyncularConsoleDiagnosticsPayload = {
    clientId: args.clientId,
    partitionId: args.partitionId || 'default',
    snapshot: compactSnapshot(args.snapshot, profile),
  };
  if (args.actorId) payload.actorId = args.actorId;
  if (args.lifecycle) {
    payload.lifecycle = compactLifecycle(args.lifecycle, profile);
  }
  return payload;
}

function compactSnapshot(
  snapshot: SyncularDiagnosticSnapshot,
  profile: CompactProfile
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    generatedAt: snapshot.generatedAt,
    runtime: snapshot.runtime,
    connection: compactConnection(
      snapshot.connection,
      profile.includeConnectionLastDiagnostic
    ),
    subscriptions: snapshot.subscriptions,
    recentDiagnostics: takeLast(
      snapshot.recentDiagnostics,
      profile.diagnosticCount
    ).map((event) => compactDiagnosticEvent(event, profile.includeDetails)),
    recentSyncTimings: takeLast(
      snapshot.recentSyncTimings,
      profile.syncTimingCount
    ).map(compactSyncTiming),
  };
  if (snapshot.bootstrap)
    result.bootstrap = compactBootstrap(snapshot.bootstrap);
  if (snapshot.transportStats) result.transportStats = snapshot.transportStats;
  if (snapshot.outboxStats) result.outboxStats = snapshot.outboxStats;
  if (snapshot.conflictStats) result.conflictStats = snapshot.conflictStats;
  if (snapshot.blobUploadStats) {
    result.blobUploadStats = snapshot.blobUploadStats;
  }
  return result;
}

function compactLifecycle(
  lifecycle: SyncularLifecycleState,
  profile: CompactProfile
): Record<string, unknown> {
  return {
    ...lifecycle,
    lastDiagnostic: lifecycle.lastDiagnostic
      ? compactDiagnosticEvent(lifecycle.lastDiagnostic, profile.includeDetails)
      : undefined,
  };
}

function compactConnection(
  connection: SyncularDiagnosticSnapshot['connection'],
  includeLastDiagnostic: boolean
): Record<string, unknown> {
  return {
    ...connection,
    lastDiagnostic:
      includeLastDiagnostic && connection.lastDiagnostic
        ? compactDiagnosticEvent(connection.lastDiagnostic, true)
        : undefined,
  };
}

function compactDiagnosticEvent(
  event: SyncularDiagnosticEvent,
  includeDetails: boolean
): SyncularDiagnosticEvent {
  const compacted: SyncularDiagnosticEvent = {
    at: event.at,
    level: event.level,
    source: event.source,
    code: event.code,
    message: truncateString(event.message, MAX_MESSAGE_LENGTH),
  };
  if (event.syncAttemptId) compacted.syncAttemptId = event.syncAttemptId;
  if (event.traceId) compacted.traceId = event.traceId;
  if (event.spanId) compacted.spanId = event.spanId;
  if (event.clientId) compacted.clientId = event.clientId;
  if (event.subscriptionId) compacted.subscriptionId = event.subscriptionId;
  if (event.table) compacted.table = event.table;
  if (event.rowId) compacted.rowId = event.rowId;
  if (event.cursor !== undefined) compacted.cursor = event.cursor;
  if (includeDetails && event.details) {
    const details = compactDiagnosticDetails(event.details);
    if (details) compacted.details = details;
  }
  return compacted;
}

function compactDiagnosticDetails(
  details: Record<string, unknown>
): Record<string, unknown> | undefined {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const normalizedKey = normalizeDiagnosticKey(key);
    if (
      SENSITIVE_DETAIL_KEYS.has(normalizedKey) ||
      OMITTED_DETAIL_KEYS.has(key)
    ) {
      continue;
    }
    if (key === 'bootstrap') {
      compacted.bootstrap = compactBootstrap(value);
      continue;
    }
    if (!SIMPLE_DETAIL_KEYS.has(key)) continue;
    const compactedValue = compactDetailValue(value);
    if (compactedValue !== undefined) compacted[key] = compactedValue;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactDetailValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateString(value, MAX_STRING_DETAIL_LENGTH);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_DETAIL_ITEMS)
      .map(compactDetailValue)
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const compacted: Record<string, unknown> = {};
  for (const key of [
    'table',
    'rowId',
    'operation',
    'commitId',
    'commitSeq',
    'subscriptionId',
    'serverVersion',
  ]) {
    const entry = compactDetailValue(object[key]);
    if (entry !== undefined) compacted[key] = entry;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactBootstrap(value: unknown): Record<string, unknown> | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const bootstrap = value as Record<string, unknown>;
  const compacted: Record<string, unknown> = {};
  for (const key of [
    'channelPhase',
    'progressPercent',
    'isBootstrapping',
    'criticalReady',
    'interactiveReady',
    'complete',
    'activePhase',
  ]) {
    if (bootstrap[key] !== undefined) compacted[key] = bootstrap[key];
  }
  for (const [sourceKey, targetKey] of [
    ['expectedSubscriptionIds', 'expectedSubscriptionCount'],
    ['readySubscriptionIds', 'readySubscriptionCount'],
    ['pendingSubscriptionIds', 'pendingSubscriptionCount'],
    ['subscriptions', 'subscriptionCount'],
    ['phases', 'phaseCount'],
  ] as const) {
    const entry = bootstrap[sourceKey];
    if (Array.isArray(entry)) compacted[targetKey] = entry.length;
  }
  return compacted;
}

function compactSyncTiming(
  timing: SyncularSyncTimings
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(timing)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function resolveConsoleDiagnosticsOptions(
  options: CreateSyncularConsoleDiagnosticsPublisherOptions
): ResolvedConsoleDiagnosticsOptions | undefined {
  if (options.enabled === false) return undefined;
  const endpoint =
    normalizeEndpoint(options.endpoint) ??
    endpointFromConsoleBaseUrl(options.baseUrl) ??
    endpointFromSyncBaseUrl(options.config.baseUrl);
  if (!endpoint) return undefined;

  return {
    endpoint,
    clientId: options.clientId || options.config.clientId,
    actorId: options.actorId ?? options.config.actorId,
    partitionId: options.partitionId || 'default',
    ...(options.token ? { token: options.token } : {}),
    ...(options.getHeaders ? { getHeaders: options.getHeaders } : {}),
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxPayloadBytes: normalizeMaxPayloadBytes(options.maxPayloadBytes),
    network:
      options.network === false
        ? undefined
        : (options.network ?? browserSyncularNetworkStatusSource()),
  };
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/u, '');
  return trimmed || undefined;
}

function endpointFromConsoleBaseUrl(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/u, '');
  if (!trimmed) return undefined;
  if (trimmed.endsWith('/client-diagnostics')) return trimmed;
  if (trimmed.endsWith('/console')) return `${trimmed}/client-diagnostics`;
  return `${trimmed}/console/client-diagnostics`;
}

function endpointFromSyncBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/u, '');
  if (!trimmed) return undefined;
  if (trimmed.endsWith('/sync')) {
    return `${trimmed.slice(0, -'/sync'.length)}/console/client-diagnostics`;
  }
  return `${trimmed}/console/client-diagnostics`;
}

async function buildHeaders(
  options: Pick<ResolvedConsoleDiagnosticsOptions, 'getHeaders' | 'token'>
): Promise<SyncularAuthHeaders> {
  return {
    'Content-Type': 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.getHeaders ? await options.getHeaders() : {}),
  };
}

function payloadFingerprint(
  payload: SyncularConsoleDiagnosticsPayload
): string {
  const snapshot = { ...payload.snapshot, generatedAt: 0 };
  return JSON.stringify({
    ...payload,
    snapshot,
  });
}

function normalizeMaxPayloadBytes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_PAYLOAD_BYTES;
  }
  return Math.max(MIN_MAX_PAYLOAD_BYTES, Math.floor(value));
}

function jsonByteLength(json: string): number {
  return new TextEncoder().encode(json).byteLength;
}

function takeLast<T>(entries: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  return entries.slice(Math.max(0, entries.length - count));
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeDiagnosticKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function noopPublisher(): { schedule(): void; destroy(): void } {
  return {
    schedule() {},
    destroy() {},
  };
}
