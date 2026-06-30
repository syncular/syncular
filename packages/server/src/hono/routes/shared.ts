/**
 * Shared private helpers, constants, option types, and zod schemas used by the
 * sync route modules. Extracted verbatim from routes.ts.
 */

import {
  collectScopeVars,
  createSyncularErrorResponse,
  type ScopeValues,
  ScopeValuesSchema,
  type StoredScopes,
  SYNC_AUTH_LEASE_CODE_EXPIRED,
  SYNC_AUTH_LEASE_CODE_INVALID,
  SYNC_AUTH_LEASE_CODE_MISSING,
  type SyncAuthLeaseCapabilities,
} from '@syncular/core';
import type {
  ScopeCacheBackend,
  ServerSnapshotBinaryMetadata,
  ServerSyncDialect,
  ServerTableHandler,
  SnapshotArtifactStorage,
  SnapshotChunkStorage,
  SqlFamily,
  SyncCoreDb,
  SyncRealtimeBroadcaster,
  SyncServerAuth,
  SyncServerPushPlugin,
} from '@syncular/server';
import {
  type AuthLeaseSigner,
  type CompactOptions,
  coerceNumber,
  type PruneOptions,
  type PullResult,
  parseJsonValue,
} from '@syncular/server';
import type { Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { syncErrorResponse, syncLimitExceeded } from '../errors';
import type { SyncRateLimitConfig } from '../rate-limit';
import { resolveAllowedOriginFromPatterns } from '../websocket-origin';
import type {
  WebSocketConnectionManager,
  WebSocketRealtimeSubscription,
} from '../ws';

/**
 * WeakMaps for storing Hono-instance-specific data without augmenting the type.
 */
const wsConnectionManagerMap = new WeakMap<Hono, WebSocketConnectionManager>();
const realtimeUnsubscribeMap = new WeakMap<Hono, () => void>();

export { realtimeUnsubscribeMap, wsConnectionManagerMap };

export interface SyncAuthResult extends SyncServerAuth {}

/**
 * WebSocket configuration for realtime sync.
 */
export interface SyncWebSocketConfig {
  enabled?: boolean;
  /**
   * Runtime-provided WebSocket upgrader (e.g. from `hono/bun`'s `createBunWebSocket()`).
   */
  upgradeWebSocket?: UpgradeWebSocket;
  heartbeatIntervalMs?: number;
  /**
   * Maximum number of concurrent WebSocket connections across the entire process.
   * Default: 5000
   */
  maxConnectionsTotal?: number;
  /**
   * Maximum number of concurrent WebSocket connections per clientId.
   * Default: 3
   */
  maxConnectionsPerClient?: number;
  /**
   * Maximum inbound websocket message size in bytes.
   * Default: 1 MiB.
   */
  maxMessageBytes?: number;
  /**
   * Maximum encoded sync-pack size sent directly over a websocket frame.
   * Larger payloads fall back to explicit HTTP pull recovery.
   * Default: 64 KiB.
   */
  maxSyncPackBytes?: number;
  /**
   * Maximum inbound websocket messages allowed per connection within one window.
   * Default: 120 messages.
   * Set to 0 or a negative value to disable rate limiting.
   */
  maxMessagesPerWindow?: number;
  /**
   * Maximum outbound sync notifications allowed without a newer client ACK.
   * When exceeded, the server sends cursor-only resync-required frames until
   * the client ACKs a caught-up cursor. Set to 0 to disable.
   * Default: 64.
   */
  maxInFlightSyncsPerConnection?: number;
  /**
   * Recent outbound scope notifications retained for websocket reconnect
   * replay before falling back to HTTP pull recovery. Set to 0 to disable.
   * Default: 64.
   */
  replayWindowSize?: number;
  /**
   * Window size in milliseconds for inbound websocket message rate limiting.
   * Default: 10000 ms.
   */
  messageRateWindowMs?: number;
  /**
   * Optional list of allowed websocket origins.
   * - undefined: allow same-origin browser upgrades and origin-less non-browser clients
   * - '*': allow all origins
   * - string[]: exact origin match (scheme + host + port)
   */
  allowedOrigins?: string[] | '*';
}

export type SyncCorsOriginResolver = (
  origin: string | undefined,
  context: Context
) =>
  | boolean
  | string
  | null
  | undefined
  | Promise<boolean | string | null | undefined>;

export type SyncCorsOrigin = string | string[] | '*' | SyncCorsOriginResolver;

export interface SyncCorsOptions {
  /**
   * Hono-style origin config.
   * - string / string[]: exact or wildcard origin patterns
   * - '*': allow all origins
   * - function: dynamic allow/deny decision
   */
  origin?: SyncCorsOrigin;
  /**
   * Additional request headers to allow. These are appended to the built-in
   * Syncular transport and tracing headers, not used as a replacement.
   */
  allowHeaders?: string[];
  /**
   * Additional response headers exposed to the browser.
   */
  exposeHeaders?: string[];
}

export interface SyncRoutesConfigWithRateLimit {
  /**
   * Optional browser CORS handling for sync routes.
   * When configured, sync route responses and preflights include matching
   * CORS headers directly from the generated sync app.
   */
  cors?: SyncCorsOrigin | SyncCorsOptions;
  /**
   * Max commits per pull request.
   * Default: 100
   */
  maxPullLimitCommits?: number;
  /**
   * Max subscriptions per pull request.
   * Default: 200
   */
  maxSubscriptionsPerPull?: number;
  /**
   * Max snapshot rows per snapshot page.
   * Default: 5000
   */
  maxPullLimitSnapshotRows?: number;
  /**
   * Max snapshot pages per subscription per pull response.
   * Default: 50
   */
  maxPullMaxSnapshotPages?: number;
  /**
   * Gzip compression level for generated snapshot chunks.
   *
   * Default: 1, range: 0-9. Lower values reduce CPU and browser inflate time
   * but increase response size.
   */
  snapshotChunkGzipLevel?: number;
  /**
   * Max operations per pushed commit.
   * Default: 200
   */
  maxOperationsPerPush?: number;
  /**
   * Maximum JSON request body accepted by POST /.
   * Default: 4 MiB.
   */
  maxSyncRequestJsonBytes?: number;
  /**
   * Maximum binary sync-pack response body emitted by POST /.
   * Default: 16 MiB.
   */
  maxSyncBinaryPackBytes?: number;
  /**
   * Maximum snapshot chunk body emitted by GET /snapshot-chunks/:chunkId.
   * Default: 64 MiB.
   */
  maxSnapshotChunkResponseBytes?: number;
  /**
   * Maximum snapshot artifact body emitted by GET /snapshot-artifacts/:artifactId.
   * Default: 256 MiB.
   */
  maxSnapshotArtifactResponseBytes?: number;
  /**
   * Request/response payload snapshots recorded for console inspection.
   */
  requestPayloadSnapshots?: {
    /**
     * Enable payload snapshot storage in `sync_request_payloads`.
     * Default: false (opt-in).
     */
    enabled?: boolean;
    /**
     * Max serialized payload size in bytes per request/response snapshot.
     * Larger payloads are truncated with metadata.
     * Default: 128 KiB.
     */
    maxBytes?: number;
  };
  /**
   * Minimum Syncular client schema version accepted by this server.
   * Clients with an older runtime must upgrade before continuing sync.
   */
  requiredSchemaVersion?: number;
  /**
   * Latest Syncular client schema version known by this server.
   * Newer values are informational and should not block older compatible
   * clients.
   */
  latestSchemaVersion?: number;
  /**
   * Rate limiting configuration.
   * Set to false to disable all rate limiting.
   */
  rateLimit?: SyncRateLimitConfig | false;
  /**
   * WebSocket realtime configuration.
   */
  websocket?: SyncWebSocketConfig;

  /**
   * Optional pruning configuration. When enabled, the server periodically prunes
   * old commit history based on active client cursors.
   */
  prune?: {
    /** Minimum time between prune runs. Default: 5 minutes. */
    minIntervalMs?: number;
    /** Pruning watermark options. */
    options?: PruneOptions;
  };

  /**
   * Optional compaction configuration. When enabled, the server periodically
   * compacts older change history to reduce storage.
   */
  compact?: {
    /** Minimum time between compaction runs. Default: 30 minutes. */
    minIntervalMs?: number;
    /** Compaction options. */
    options?: CompactOptions;
  };

  /**
   * Optional multi-instance realtime broadcaster.
   * When provided, instances publish/subscribe commit wakeups via the broadcaster.
   */
  realtime?: {
    broadcaster: SyncRealtimeBroadcaster;
    /** Optional stable instance id (useful in tests). */
    instanceId?: string;
  };
}

export interface SyncAuthLeaseRoutesConfig<
  Auth extends SyncAuthResult = SyncAuthResult,
> {
  /**
   * Set false to keep route config around without exposing the issue endpoint.
   * Providing this config enables POST /auth-leases/issue by default.
   */
  enabled?: boolean;
  issuer: string;
  audience: string;
  kid: string;
  signer: AuthLeaseSigner;
  publicKey: CryptoKey;
  ttlMs?: number;
  maxTtlMs?: number;
  maxClockSkewMs?: number;
  capabilities?: SyncAuthLeaseCapabilities;
  nowMs?: () => number;
  leaseId?: () => string;
  subject?: (
    auth: Auth
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface CreateSyncRoutesOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect<F>;
  handlers: ServerTableHandler<DB, Auth>[];
  snapshotBinary?: ServerSnapshotBinaryMetadata;
  plugins?: SyncServerPushPlugin<DB, Auth>[];
  authenticate: (c: Context) => Promise<Auth | null>;
  sync?: SyncRoutesConfigWithRateLimit;
  authLeases?: SyncAuthLeaseRoutesConfig<Auth>;
  wsConnectionManager?: WebSocketConnectionManager;
  /**
   * Optional snapshot chunk storage adapter.
   * When provided, stores snapshot chunk bodies in external storage
   * (S3, R2, etc.) instead of inline in the database.
   */
  chunkStorage?: SnapshotChunkStorage;
  /**
   * Optional scoped snapshot artifact body storage adapter.
   * Artifact metadata is stored in SQL; bodies are always external.
   */
  snapshotArtifactStorage?: SnapshotArtifactStorage;
  /**
   * Optional scope cache backend for resolveScopes() results.
   * Request-local memoization is always applied for every pull.
   */
  scopeCache?: ScopeCacheBackend;
  /**
   * Optional live emitter for console websocket activity feed.
   * When provided, sync lifecycle events are published to `/console/events/live`.
   */
  consoleLiveEmitter?: {
    emit(event: {
      type: 'sync' | 'push' | 'pull' | 'commit' | 'client_update';
      timestamp: string;
      data: Record<string, unknown>;
    }): void;
  };
  /**
   * Optional console schema readiness promise.
   * When provided, request-event recording waits for this promise before writing.
   */
  consoleSchemaReady?: Promise<void>;
}

// ============================================================================
// Route Schemas
// ============================================================================

export const snapshotChunkParamsSchema = z.object({
  chunkId: z.string().min(1),
});
export const snapshotArtifactParamsSchema = z.object({
  artifactId: z.string().min(1),
});
export const snapshotChunkQuerySchema = z.object({
  scopes: z.string().optional(),
});

export const auditCommitListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  beforeCommitSeq: z.coerce.number().int().min(1).optional(),
  actorId: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const auditCommitParamsSchema = z.object({
  commitSeq: z.coerce.number().int().min(1),
});

export const auditRowHistoryParamsSchema = z.object({
  table: z.string().min(1),
  rowId: z.string().min(1),
});

export const auditRowHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeCommitSeq: z.coerce.number().int().min(1).optional(),
    afterCommitSeq: z.coerce.number().int().min(1).optional(),
  })
  .refine(
    (query) =>
      query.beforeCommitSeq === undefined ||
      query.afterCommitSeq === undefined ||
      query.afterCommitSeq < query.beforeCommitSeq,
    {
      message: 'afterCommitSeq must be lower than beforeCommitSeq',
      path: ['afterCommitSeq'],
    }
  );

export const auditDebugExportQuerySchema = z.object({
  limitCommits: z.coerce.number().int().min(1).max(200).default(50),
  limitEvents: z.coerce.number().int().min(1).max(500).default(100),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const auditCommitSummarySchema = z.object({
  commitSeq: z.number().int(),
  actorId: z.string(),
  clientId: z.string(),
  clientCommitId: z.string(),
  createdAt: z.string(),
  changeCount: z.number().int(),
  affectedTables: z.array(z.string()),
});

export const auditCommitListResponseSchema = z.object({
  ok: z.literal(true),
  commits: z.array(auditCommitSummarySchema),
  nextCursor: z.number().int().nullable(),
});

const auditChangeKindSchema = z.enum([
  'app_row',
  'delete',
  'blob_reference',
  'encrypted_field_envelope',
  'encrypted_crdt_update',
  'encrypted_crdt_checkpoint',
]);

const auditChangeRedactionSchema = z.object({
  payload: z.literal('omitted'),
  reason: z.literal('audit_redacted_by_default'),
});

const auditChangeSchema = z.object({
  changeId: z.number().int(),
  table: z.string(),
  rowId: z.string(),
  op: z.enum(['upsert', 'delete']),
  rowVersion: z.number().int().nullable(),
  fields: z.array(z.string()),
  scopeFields: z.array(z.string()),
  changeKind: auditChangeKindSchema,
  sensitiveFields: z.array(z.string()),
  redaction: auditChangeRedactionSchema,
});

export const auditCommitDetailResponseSchema = z.object({
  ok: z.literal(true),
  commit: auditCommitSummarySchema,
  changes: z.array(auditChangeSchema),
});

const auditDebugExportCommitSchema = auditCommitSummarySchema.extend({
  changes: z.array(auditChangeSchema),
});

const auditDebugExportEventSchema = z.object({
  eventId: z.number().int(),
  partitionId: z.string(),
  requestId: z.string(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  eventType: z.enum(['sync', 'push', 'pull']),
  syncPath: z.enum(['http-combined', 'ws-push']),
  transportPath: z.enum(['direct', 'relay']),
  actorId: z.string(),
  clientId: z.string(),
  statusCode: z.number().int(),
  outcome: z.string(),
  responseStatus: z.string(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int(),
  commitSeq: z.number().int().nullable(),
  operationCount: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  subscriptionCount: z.number().int().nullable(),
  scopesSummary: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .nullable(),
  tables: z.array(z.string()),
  createdAt: z.string(),
});

export const auditDebugExportResponseSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  partitionId: z.string(),
  limits: z.object({
    commits: z.number().int(),
    requestEvents: z.number().int(),
  }),
  truncated: z.object({
    commits: z.boolean(),
    requestEvents: z.boolean(),
  }),
  commits: z.array(auditDebugExportCommitSchema),
  requestEvents: z.array(auditDebugExportEventSchema),
});

const auditRowHistoryEntrySchema = z.object({
  commitSeq: z.number().int(),
  actorId: z.string(),
  clientId: z.string(),
  clientCommitId: z.string(),
  createdAt: z.string(),
  changeId: z.number().int(),
  table: z.string(),
  rowId: z.string(),
  op: z.enum(['upsert', 'delete']),
  rowVersion: z.number().int().nullable(),
  fields: z.array(z.string()),
  scopeFields: z.array(z.string()),
  changeKind: auditChangeKindSchema,
  sensitiveFields: z.array(z.string()),
  redaction: auditChangeRedactionSchema,
});

export const auditRowHistoryResponseSchema = z.object({
  ok: z.literal(true),
  table: z.string(),
  rowId: z.string(),
  history: z.array(auditRowHistoryEntrySchema),
  nextCursor: z.number().int().nullable(),
});

export type AuditChangeResponse = z.infer<typeof auditChangeSchema>;
export type AuditDebugExportEvent = z.infer<typeof auditDebugExportEventSchema>;

export const DEFAULT_REQUEST_PAYLOAD_SNAPSHOT_MAX_BYTES = 128 * 1024;
export const DEFAULT_MAX_SYNC_REQUEST_JSON_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SYNC_BINARY_PACK_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_SNAPSHOT_CHUNK_RESPONSE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_SNAPSHOT_ARTIFACT_RESPONSE_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_SCOPES_HEADER = 'x-syncular-snapshot-scopes';
const SYNC_CLIENT_ID_HEADER = 'x-syncular-client-id';

export type TraceContext = {
  traceId: string | null;
  spanId: string | null;
};

const DEFAULT_SYNC_CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'Cache-Control',
  'x-syncular-publishable-key',
  'x-syncular-schema-version',
  SNAPSHOT_SCOPES_HEADER,
  'x-syncular-sync-attempt-id',
  'x-syncular-transport-path',
  SYNC_CLIENT_ID_HEADER,
  'x-request-id',
  'sentry-trace',
  'baggage',
  'traceparent',
  'tracestate',
];

const DEFAULT_SYNC_CORS_ALLOW_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'OPTIONS',
];

const DEFAULT_SYNC_CORS_EXPOSE_HEADERS: string[] = [];

export type NormalizedSyncCorsConfig = {
  resolveOrigin: (
    origin: string | undefined,
    context: Context
  ) => Promise<string | null>;
  staticAllowedOrigins?: string[] | '*';
  allowHeaders: string[];
  exposeHeaders: string[];
  allowMethods: string[];
  allowCredentials: boolean;
  maxAgeSeconds: number;
};

export function applySyncCorsHeaders(args: {
  headers: Headers;
  allowedOrigin: string;
  allowCredentials: boolean;
  allowHeaders: string[];
  exposeHeaders: string[];
  allowMethods: string[];
  maxAgeSeconds: number;
}): void {
  args.headers.set('Access-Control-Allow-Origin', args.allowedOrigin);
  args.headers.set(
    'Access-Control-Allow-Headers',
    args.allowHeaders.join(', ')
  );
  args.headers.set(
    'Access-Control-Allow-Methods',
    args.allowMethods.join(', ')
  );
  args.headers.set('Access-Control-Max-Age', String(args.maxAgeSeconds));
  if (args.exposeHeaders.length > 0) {
    args.headers.set(
      'Access-Control-Expose-Headers',
      args.exposeHeaders.join(', ')
    );
  }
  if (args.allowedOrigin !== '*') {
    args.headers.append('Vary', 'Origin');
    if (args.allowCredentials) {
      args.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  }
}

export function createSyncCorsOriginDeniedResponse(origin: string): Response {
  return syncErrorResponse(
    403,
    'sync.forbidden',
    `Origin ${origin} is not allowed for sync access.`
  );
}

function mergeUniqueHeaders(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const header of list ?? []) {
      const trimmed = header.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmed);
    }
  }
  return merged;
}

function normalizeOriginResolver(
  resolver: SyncCorsOriginResolver
): NormalizedSyncCorsConfig['resolveOrigin'] {
  return async (origin, context) => {
    const resolved = await resolver(origin, context);
    if (resolved === true) {
      return origin ?? null;
    }
    if (resolved === false || resolved == null) {
      return null;
    }
    return resolved;
  };
}

function createStaticOriginResolver(
  allowedOrigins: string[] | '*'
): NormalizedSyncCorsConfig['resolveOrigin'] {
  return async (origin) => {
    if (allowedOrigins === '*') {
      return '*';
    }
    return resolveAllowedOriginFromPatterns(origin, allowedOrigins);
  };
}

function toStaticAllowedOrigins(
  origin: string | string[] | '*'
): string[] | '*' {
  return origin === '*' ? '*' : typeof origin === 'string' ? [origin] : origin;
}

export function normalizeSyncCorsConfig(
  config: SyncRoutesConfigWithRateLimit['cors']
): NormalizedSyncCorsConfig | null {
  if (!config) {
    return null;
  }

  if (
    typeof config === 'string' ||
    Array.isArray(config) ||
    typeof config === 'function'
  ) {
    const originResolver =
      typeof config === 'function'
        ? normalizeOriginResolver(config)
        : createStaticOriginResolver(toStaticAllowedOrigins(config));
    const staticAllowedOrigins =
      typeof config === 'function' ? undefined : toStaticAllowedOrigins(config);
    return {
      resolveOrigin: originResolver,
      staticAllowedOrigins,
      allowHeaders: [...DEFAULT_SYNC_CORS_ALLOW_HEADERS],
      exposeHeaders: [...DEFAULT_SYNC_CORS_EXPOSE_HEADERS],
      allowMethods: [...DEFAULT_SYNC_CORS_ALLOW_METHODS],
      allowCredentials: true,
      maxAgeSeconds: 86_400,
    };
  }

  const staticOrigin = config.origin;
  const resolveOrigin =
    typeof staticOrigin === 'function'
      ? normalizeOriginResolver(staticOrigin)
      : staticOrigin
        ? createStaticOriginResolver(toStaticAllowedOrigins(staticOrigin))
        : async () => null;
  const staticAllowedOrigins =
    typeof staticOrigin === 'function'
      ? undefined
      : staticOrigin
        ? toStaticAllowedOrigins(staticOrigin)
        : undefined;
  return {
    resolveOrigin,
    staticAllowedOrigins,
    allowHeaders: mergeUniqueHeaders(
      DEFAULT_SYNC_CORS_ALLOW_HEADERS,
      config.allowHeaders
    ),
    exposeHeaders: mergeUniqueHeaders(
      DEFAULT_SYNC_CORS_EXPOSE_HEADERS,
      config.exposeHeaders
    ),
    allowMethods: [...DEFAULT_SYNC_CORS_ALLOW_METHODS],
    allowCredentials: true,
    maxAgeSeconds: 86_400,
  };
}

export function createOpaqueId(prefix: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

export function readOriginHeader(c: Context): string | undefined {
  return c.req.raw.headers.get('origin') ?? c.req.header('origin');
}

export function readRequestId(c: Context): string {
  const headerRequestId = c.req.header('x-request-id')?.trim();
  if (headerRequestId) return headerRequestId;
  return createOpaqueId('req');
}

export function readClientIdHint(c: Context): string {
  return c.req.header(SYNC_CLIENT_ID_HEADER)?.trim() || 'unknown';
}

function parseW3cTraceparent(
  traceparent: string | null | undefined
): TraceContext | null {
  if (!traceparent) return null;
  const parsed = traceparent.trim();
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(parsed);
  if (!match) return null;
  const traceId = match[1]?.toLowerCase() ?? null;
  const spanId = match[2]?.toLowerCase() ?? null;
  if (!traceId || !spanId) return null;
  return { traceId, spanId };
}

function parseSentryTraceHeader(
  sentryTrace: string | null | undefined
): TraceContext | null {
  if (!sentryTrace) return null;
  const parsed = sentryTrace.trim();
  const match = /^([0-9a-f]{32})-([0-9a-f]{16})(?:-[01])?$/i.exec(parsed);
  if (!match) return null;
  const traceId = match[1]?.toLowerCase() ?? null;
  const spanId = match[2]?.toLowerCase() ?? null;
  if (!traceId || !spanId) return null;
  return { traceId, spanId };
}

export function readPositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function readOptionalPositiveInteger(
  value: number | undefined
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

class SyncJsonBodyLimitError extends Error {
  constructor(
    public readonly limit: string,
    public readonly observed: number,
    public readonly max: number
  ) {
    super(`${limit} exceeded: ${observed} bytes > ${max} bytes`);
    this.name = 'SyncJsonBodyLimitError';
  }
}

export function isSyncJsonBodyLimitError(
  error: unknown
): error is SyncJsonBodyLimitError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'SyncJsonBodyLimitError'
  );
}

export function readRequestContentLength(
  c: Context
): number | null | 'invalid' {
  const header = c.req.header('Content-Length');
  if (!header) return null;
  const value = Number(header);
  if (!Number.isFinite(value) || value < 0) return 'invalid';
  return Math.floor(value);
}

export async function readRequestBodyBytesWithLimit(
  request: Request,
  args: { maxBytes: number; limit: string }
): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    totalBytes += value.length;
    if (totalBytes > args.maxBytes) {
      throw new SyncJsonBodyLimitError(args.limit, totalBytes, args.maxBytes);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function responseBodyOverLimit(
  c: Context,
  args: { limit: string; observed: number; max: number; message?: string }
): Response | null {
  if (args.observed <= args.max) return null;
  return syncLimitExceeded(c, args);
}

export function syncValidationError(
  c: Context,
  target: string,
  issues: readonly { path?: unknown; message?: unknown }[]
): Response {
  return c.json(
    createSyncularErrorResponse('sync.invalid_request', {
      message: 'Invalid request.',
      details: {
        target,
        issues: issues.map((issue) => ({
          message:
            typeof issue.message === 'string'
              ? issue.message
              : 'Validation failed.',
          path: Array.isArray(issue.path)
            ? issue.path.map((segment) => String(segment))
            : [],
        })),
      },
    }),
    400
  );
}

export function readTraceContext(c: Context): TraceContext {
  const traceparent = parseW3cTraceparent(c.req.header('traceparent'));
  if (traceparent) return traceparent;

  const sentryTrace = parseSentryTraceHeader(c.req.header('sentry-trace'));
  if (sentryTrace) return sentryTrace;

  return { traceId: null, spanId: null };
}

function readStringField(
  data: Record<string, unknown>,
  key: string
): string | null {
  const value = data[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readTraceContextFromMessage(
  msg: Record<string, unknown>
): TraceContext {
  const directTraceId =
    readStringField(msg, 'traceId') ?? readStringField(msg, 'trace_id');
  const directSpanId =
    readStringField(msg, 'spanId') ?? readStringField(msg, 'span_id');
  if (directTraceId || directSpanId) {
    return { traceId: directTraceId, spanId: directSpanId };
  }

  const traceparent =
    readStringField(msg, 'traceparent') ?? readStringField(msg, 'traceParent');
  const parsedTraceparent = parseW3cTraceparent(traceparent);
  if (parsedTraceparent) return parsedTraceparent;

  const sentryTrace =
    readStringField(msg, 'sentry-trace') ??
    readStringField(msg, 'sentryTrace') ??
    readStringField(msg, 'sentry_trace');
  const parsedSentryTrace = parseSentryTraceHeader(sentryTrace);
  if (parsedSentryTrace) return parsedSentryTrace;

  return { traceId: null, spanId: null };
}

export function normalizeResponseStatus(
  statusCode: number,
  outcome: string
): string {
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  if (statusCode >= 300) return 'redirect';
  if (statusCode >= 200) {
    if (outcome === 'error' || outcome === 'rejected') return 'failure';
    return 'success';
  }
  return 'unknown';
}

export function firstPushErrorCode(results: unknown): string | null {
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const status = Reflect.get(result, 'status');
    if (status !== 'error') continue;
    const code = Reflect.get(result, 'code');
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return null;
}

export function summarizeScopeValues(
  scopes: Record<string, string | string[]>
): Record<string, string | string[]> | null {
  const summary: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(scopes)) {
    if (typeof value === 'string') {
      summary[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 20);
      summary[key] = normalized;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function summarizePullResponse(response: PullResult['response']): {
  subscriptions: Array<{
    id: string;
    status: 'active' | 'revoked';
    bootstrap: boolean;
    nextCursor: number;
    commitCount: number;
    changeCount: number;
    snapshotCount: number;
    snapshotRowCount: number;
  }>;
} {
  return {
    subscriptions: response.subscriptions.map((subscription) => {
      const changeCount = subscription.commits.reduce(
        (totalChanges, commit) => totalChanges + commit.changes.length,
        0
      );
      const snapshotCount = subscription.snapshots?.length ?? 0;
      const snapshotRowCount =
        subscription.snapshots?.reduce(
          (totalRows, snapshot) => totalRows + snapshot.rows.length,
          0
        ) ?? 0;

      return {
        id: subscription.id,
        status: subscription.status,
        bootstrap: subscription.bootstrap,
        nextCursor: subscription.nextCursor,
        commitCount: subscription.commits.length,
        changeCount,
        snapshotCount,
        snapshotRowCount,
      };
    }),
  };
}

export function summarizePullResponseForRequestEvent(
  response: PullResult['response']
): {
  subscriptionCount: number;
  activeSubscriptionCount: number;
  revokedSubscriptionCount: number;
  bootstrapSubscriptionCount: number;
  commitCount: number;
  changeCount: number;
  snapshotPageCount: number;
  snapshotInlineRowCount: number;
  snapshotChunkCount: number;
  snapshotChunkBytes: number;
  snapshotArtifactCount: number;
  snapshotArtifactBytes: number;
} {
  let activeSubscriptionCount = 0;
  let revokedSubscriptionCount = 0;
  let bootstrapSubscriptionCount = 0;
  let commitCount = 0;
  let changeCount = 0;
  let snapshotPageCount = 0;
  let snapshotInlineRowCount = 0;
  let snapshotChunkCount = 0;
  let snapshotChunkBytes = 0;
  let snapshotArtifactCount = 0;
  let snapshotArtifactBytes = 0;

  for (const subscription of response.subscriptions) {
    if (subscription.status === 'revoked') {
      revokedSubscriptionCount += 1;
    } else {
      activeSubscriptionCount += 1;
    }
    if (subscription.bootstrap) {
      bootstrapSubscriptionCount += 1;
    }
    commitCount += subscription.commits.length;
    changeCount += subscription.commits.reduce(
      (totalChanges, commit) => totalChanges + commit.changes.length,
      0
    );
    for (const snapshot of subscription.snapshots ?? []) {
      snapshotPageCount += 1;
      snapshotInlineRowCount += snapshot.rows.length;
      for (const chunk of snapshot.chunks ?? []) {
        snapshotChunkCount += 1;
        snapshotChunkBytes += chunk.byteLength;
      }
      for (const artifact of snapshot.artifacts ?? []) {
        snapshotArtifactCount += 1;
        snapshotArtifactBytes += artifact.byteLength;
      }
    }
  }

  return {
    subscriptionCount: response.subscriptions.length,
    activeSubscriptionCount,
    revokedSubscriptionCount,
    bootstrapSubscriptionCount,
    commitCount,
    changeCount,
    snapshotPageCount,
    snapshotInlineRowCount,
    snapshotChunkCount,
    snapshotChunkBytes,
    snapshotArtifactCount,
    snapshotArtifactBytes,
  };
}

export function countPullRows(response: PullResult['response']): number {
  return response.subscriptions.reduce((totalRows, subscription) => {
    const commitRows = subscription.commits.reduce(
      (totalChanges, commit) => totalChanges + commit.changes.length,
      0
    );
    const snapshotRows =
      subscription.snapshots?.reduce(
        (totalSnapshotRows, snapshot) =>
          totalSnapshotRows + snapshot.rows.length,
        0
      ) ?? 0;
    return totalRows + commitRows + snapshotRows;
  }, 0);
}

export function readSnapshotScopeValues(
  c: Context,
  queryScopes: string | undefined
): Record<string, string | string[]> | null {
  const rawValue = queryScopes ?? c.req.header(SNAPSHOT_SCOPES_HEADER);
  if (!rawValue) return null;
  const parsed = parseJsonValue(rawValue);
  const validated = ScopeValuesSchema.safeParse(parsed);
  if (!validated.success) return null;
  return validated.data;
}

export function parseScopesSummary(
  value: unknown
): Record<string, string | string[]> | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const summary: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'string') {
      summary[key] = entry;
      continue;
    }
    if (!Array.isArray(entry)) continue;
    summary[key] = entry.filter(
      (value): value is string => typeof value === 'string'
    );
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function normalizeRequestEventType(
  value: unknown
): 'sync' | 'push' | 'pull' {
  if (value === 'sync' || value === 'push' || value === 'pull') {
    return value;
  }
  return 'pull';
}

export function isMissingRequestEventsTableError(error: unknown): boolean {
  const visited = new Set<Error>();
  let current: unknown = error;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const message = current.message.toLowerCase();
    if (
      message.includes('sync_request_events') &&
      (message.includes('no such table') ||
        message.includes('does not exist') ||
        message.includes('unknown table'))
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

const SENSITIVE_PAYLOAD_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'idtoken',
  'passcode',
  'passphrase',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'sessiontoken',
  'setcookie',
  'token',
  'xapikey',
]);
const REDACTED_PAYLOAD_VALUE = '[redacted]';

function normalizePayloadKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function payloadSnapshotReplacer(key: string, value: unknown): unknown {
  if (key !== '' && SENSITIVE_PAYLOAD_KEYS.has(normalizePayloadKey(key))) {
    return REDACTED_PAYLOAD_VALUE;
  }
  return value;
}

export function encodePayloadSnapshot(
  value: unknown,
  maxBytes: number
): string {
  try {
    const serialized = JSON.stringify(value, payloadSnapshotReplacer);
    if (serialized.length <= maxBytes) {
      return serialized;
    }
    return JSON.stringify({
      truncated: true,
      originalSizeBytes: serialized.length,
      preview: serialized.slice(0, maxBytes),
    });
  } catch {
    return JSON.stringify({
      truncated: false,
      serializationError: 'Could not serialize payload snapshot',
    });
  }
}

export function emitConsoleLiveEvent(
  emitter:
    | {
        emit(event: {
          type: 'sync' | 'push' | 'pull' | 'commit' | 'client_update';
          timestamp: string;
          data: Record<string, unknown>;
        }): void;
      }
    | undefined,
  type: 'sync' | 'push' | 'pull' | 'commit' | 'client_update',
  data: Record<string, unknown> | (() => Record<string, unknown>)
): void {
  if (!emitter) return;
  emitter.emit({
    type,
    timestamp: new Date().toISOString(),
    data: typeof data === 'function' ? data() : data,
  });
}

export function isAuthLeaseRefreshRetriable(code: string): boolean {
  return (
    code === SYNC_AUTH_LEASE_CODE_MISSING ||
    code === SYNC_AUTH_LEASE_CODE_INVALID ||
    code === SYNC_AUTH_LEASE_CODE_EXPIRED
  );
}

export type RequestPayloadSnapshot = {
  request: unknown;
  response: unknown;
};

export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function measureWebSocketMessageBytes(data: unknown): number {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data).byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.size;
  }
  return new TextEncoder().encode(String(data)).byteLength;
}

export function readTransportPath(
  c: Context,
  queryValue?: string | null
): 'direct' | 'relay' {
  if (queryValue === 'relay' || queryValue === 'direct') {
    return queryValue;
  }

  const headerValue = c.req.header('x-syncular-transport-path');
  if (headerValue === 'relay' || headerValue === 'direct') {
    return headerValue;
  }

  return 'direct';
}

export function scopeValuesToScopeKeys(scopes: unknown): string[] {
  if (!scopes || typeof scopes !== 'object') return [];
  const scopeKeys = new Set<string>();

  for (const [key, value] of Object.entries(scopes)) {
    if (!value) continue;
    const prefix = key.replace(/_id$/, '');

    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v !== 'string') continue;
        if (!v) continue;
        scopeKeys.add(`${prefix}:${v}`);
      }
      continue;
    }

    if (typeof value === 'string') {
      if (!value) continue;
      scopeKeys.add(`${prefix}:${value}`);
      continue;
    }

    // Best-effort: stringify scalars.
    if (typeof value === 'number' || typeof value === 'bigint') {
      scopeKeys.add(`${prefix}:${String(value)}`);
    }
  }

  return Array.from(scopeKeys);
}

export function selectRequiredAuditScopes(
  scopePatterns: readonly string[],
  allowedScopes: ScopeValues
): ScopeValues | null {
  const requiredScopeKeys = Array.from(collectScopeVars(scopePatterns));
  if (requiredScopeKeys.length === 0) {
    return {};
  }

  const auditScopes: ScopeValues = {};
  for (const key of requiredScopeKeys) {
    const value = allowedScopes[key];
    if (value === undefined) {
      return null;
    }
    if (Array.isArray(value) && value.length === 0) {
      return null;
    }
    auditScopes[key] = value;
  }
  return auditScopes;
}

export function parseStoredAuditScopes(value: unknown): StoredScopes {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const scopes: StoredScopes = {};
  for (const [key, scopeValue] of Object.entries(parsed)) {
    if (typeof scopeValue === 'string') {
      scopes[key] = scopeValue;
    }
  }
  return scopes;
}

function partitionScopeKey(partitionId: string, scopeKey: string): string {
  return `${partitionId}::${scopeKey}`;
}

export function applyPartitionToScopeKeys(
  partitionId: string,
  scopeKeys: readonly string[]
): string[] {
  const prefixed = new Set<string>();
  for (const scopeKey of scopeKeys) {
    if (!scopeKey) continue;
    if (scopeKey.startsWith(`${partitionId}::`)) {
      prefixed.add(scopeKey);
      continue;
    }
    prefixed.add(partitionScopeKey(partitionId, scopeKey));
  }
  return Array.from(prefixed);
}

export function uniqueScopeKeys(scopeKeys: readonly string[]): string[] {
  return Array.from(
    new Set(scopeKeys.filter((scopeKey) => scopeKey.length > 0))
  );
}

function parseRealtimeSubscriptionScopes(
  value: unknown
): Record<string, string | string[]> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const scopes: Record<string, string | string[]> = {};
  for (const [key, scopeValue] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (typeof scopeValue === 'string' && scopeValue.length > 0) {
      scopes[key] = scopeValue;
      continue;
    }
    if (Array.isArray(scopeValue)) {
      const values = scopeValue.filter(
        (item): item is string => typeof item === 'string' && item.length > 0
      );
      if (values.length > 0) {
        scopes[key] = values;
      }
    }
  }
  return scopes;
}

export function parsePersistedRealtimeSubscriptions(
  value: unknown,
  partitionId: string
): WebSocketRealtimeSubscription[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];

  const subscriptions: WebSocketRealtimeSubscription[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const table = typeof record.table === 'string' ? record.table : '';
    if (!id || !table) continue;

    const scopes = parseRealtimeSubscriptionScopes(record.scopes);
    const scopeKeys = applyPartitionToScopeKeys(
      partitionId,
      scopeValuesToScopeKeys(scopes)
    );
    if (scopeKeys.length === 0) continue;

    const cursor = coerceNumber(record.cursor);
    subscriptions.push({
      id,
      table,
      scopes,
      scopeKeys,
      cursor: cursor === null ? -1 : Math.max(-1, cursor),
      verifiedRoot:
        typeof record.verifiedRoot === 'string' &&
        record.verifiedRoot.length > 0
          ? record.verifiedRoot
          : null,
    });
  }
  return subscriptions;
}

export function normalizeScopeKeyForPartition(
  partitionId: string,
  scopeKey: string
): string {
  if (scopeKey.startsWith(`${partitionId}::`)) return scopeKey;
  if (scopeKey.includes('::')) return '';
  return partitionScopeKey(partitionId, scopeKey);
}

export async function readCommitScopeKeys<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  commitSeq: number,
  partitionId: string
): Promise<string[]> {
  const indexedRows = await sql<{ scope_key: string }>`
    select distinct scope_key
    from ${sql.table('sync_scope_commits')}
    where commit_seq = ${commitSeq}
      and partition_id = ${partitionId}
  `.execute(db);
  const indexedScopeKeys = indexedRows.rows
    .map((row) => row.scope_key)
    .filter(
      (scopeKey): scopeKey is string =>
        typeof scopeKey === 'string' && scopeKey.length > 0
    );
  return applyPartitionToScopeKeys(partitionId, indexedScopeKeys);
}

export async function readClientState<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  partitionId: string,
  clientId: string
): Promise<{
  ownerActorId: string | null;
  effectiveScopes: unknown;
  realtimeSubscriptions: unknown;
  cursor: number | null;
  latestCommitSeq: number;
  hasConflict: boolean;
}> {
  const result = await sql<{
    cursor_actor_id: string | null;
    effective_scopes: unknown;
    realtime_subscriptions: unknown;
    cursor: number | string | null;
    latest_client_actor_id: string | null;
    latest_commit_seq: number | string | null;
  }>`
    SELECT
      cc.actor_id AS cursor_actor_id,
      cc.effective_scopes,
      cc.realtime_subscriptions,
      cc.cursor,
      (
        SELECT actor_id
        FROM sync_commits
        WHERE partition_id = ${partitionId} AND client_id = ${clientId}
        ORDER BY commit_seq DESC
        LIMIT 1
      ) AS latest_client_actor_id,
      (
        SELECT COALESCE(MAX(commit_seq), 0)
        FROM sync_commits
        WHERE partition_id = ${partitionId}
      ) AS latest_commit_seq
    FROM (SELECT 1) AS realtime_state
    LEFT JOIN sync_client_cursors AS cc
      ON cc.partition_id = ${partitionId} AND cc.client_id = ${clientId}
    LIMIT 1
  `.execute(db);
  const cursorRow = result.rows[0];

  // Cursor state reflects the current authenticated owner for a clientId.
  // Commit history is only used to seed ownership before the first pull.
  const ownerActorId =
    cursorRow?.cursor_actor_id ?? cursorRow?.latest_client_actor_id ?? null;
  const cursor =
    cursorRow?.cursor === null || cursorRow?.cursor === undefined
      ? null
      : Number(cursorRow.cursor);
  const latestCommitSeq =
    cursorRow?.latest_commit_seq === null ||
    cursorRow?.latest_commit_seq === undefined
      ? 0
      : Number(cursorRow.latest_commit_seq);

  return {
    ownerActorId,
    effectiveScopes: cursorRow?.effective_scopes ?? null,
    realtimeSubscriptions: cursorRow?.realtime_subscriptions ?? null,
    cursor: Number.isFinite(cursor) ? cursor : null,
    latestCommitSeq: Number.isFinite(latestCommitSeq) ? latestCommitSeq : 0,
    hasConflict: false,
  };
}

export async function recordRealtimeAck<DB extends SyncCoreDb>(args: {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  partitionId: string;
  actorId: string;
  clientId: string;
  cursor: number;
  realtimeSubscriptions?: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  const realtimeSubscriptionsJson =
    args.realtimeSubscriptions === undefined
      ? null
      : JSON.stringify(args.realtimeSubscriptions);
  const realtimeSubscriptionsSet =
    args.dialect.family === 'postgres'
      ? sql`realtime_subscriptions = ${realtimeSubscriptionsJson}::jsonb,`
      : sql`realtime_subscriptions = ${realtimeSubscriptionsJson},`;
  await sql`
    UPDATE sync_client_cursors
    SET
      cursor = CASE
        WHEN cursor < ${args.cursor}
          AND cursor < (
            SELECT COALESCE(MAX(commit_seq), 0)
            FROM sync_commits
            WHERE partition_id = ${args.partitionId}
          )
        THEN CASE
          WHEN ${args.cursor} < (
            SELECT COALESCE(MAX(commit_seq), 0)
            FROM sync_commits
            WHERE partition_id = ${args.partitionId}
          )
          THEN ${args.cursor}
          ELSE (
            SELECT COALESCE(MAX(commit_seq), 0)
            FROM sync_commits
            WHERE partition_id = ${args.partitionId}
          )
        END
        ELSE cursor
      END,
      ${realtimeSubscriptionsSet}
      updated_at = ${now}
    WHERE partition_id = ${args.partitionId}
      AND client_id = ${args.clientId}
      AND actor_id = ${args.actorId}
  `.execute(args.db);
}
