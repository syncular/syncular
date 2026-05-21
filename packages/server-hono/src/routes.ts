/**
 * @syncular/server-hono - Sync routes for Hono
 *
 * Provides:
 * - POST /      (combined push + pull in one round-trip)
 * - GET  /snapshot-chunks/:chunkId (download encoded snapshot chunks)
 * - GET  /snapshot-artifacts/:artifactId (download scoped snapshot artifacts)
 * - GET  /realtime (optional WebSocket "wake up" notifications)
 */

import {
  captureSyncException,
  collectScopeVars,
  countSyncMetric,
  createSyncTimer,
  createSyncularErrorResponse,
  distributionSyncMetric,
  ErrorResponseSchema,
  encodeBinarySyncPack,
  logSyncEvent,
  prefersBinarySyncPack,
  type ScopeValues,
  ScopeValuesSchema,
  type StoredScopes,
  SYNC_AUTH_LEASE_CODE_EXPIRED,
  SYNC_AUTH_LEASE_CODE_INVALID,
  SYNC_AUTH_LEASE_CODE_MISSING,
  SYNC_PACK_CONTENT_TYPE,
  SYNC_PACK_ENCODING_BINARY_V1,
  type SyncAuthLeaseCapabilities,
  SyncAuthLeaseIssueRequestSchema,
  type SyncAuthLeaseIssueResponse,
  SyncAuthLeaseIssueResponseSchema,
  type SyncChange,
  SyncCombinedRequestSchema,
  type SyncCombinedResponse,
  SyncCombinedResponseSchema,
  type SyncCommit,
  type SyncPullSubscriptionResponse,
  type SyncPushCommitRequestSchema,
  SyncPushRequestSchema,
  type SyncPushResponse,
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
  SyncRealtimeEvent,
  SyncServerAuth,
  SyncServerPushPlugin,
} from '@syncular/server';
import {
  type AuthLeaseSigner,
  type CompactOptions,
  coerceNumber,
  createServerHandlerCollection,
  createSyncRealtimeShardKey,
  createWireSubscriptionIntegrity,
  InvalidSubscriptionScopeError,
  issueAuthLease,
  maybeCompactChanges,
  maybePruneSync,
  type PruneOptions,
  type PullResult,
  type PushCommitValidator,
  parseJsonValue,
  pull,
  pushCommit,
  pushCommitBatch,
  readScopedSnapshotArtifact,
  readSnapshotChunk,
  recordClientCursor,
  resolveEffectiveScopesForSubscriptions,
  rowScopesAllowed,
  scopesToSnapshotChunkScopeKey,
  validateAuthLeaseOperation,
  verifyAuthLeaseToken,
} from '@syncular/server';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import type { UpgradeWebSocket } from 'hono/ws';
import { describeRoute, resolver } from 'hono-openapi';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { summarizeAuditChange } from './audit-redaction';
import { isBenignConsoleSchemaError } from './console/schema-errors';
import { syncError, syncErrorResponse, syncLimitExceeded } from './errors';
import {
  createRateLimiter,
  DEFAULT_SYNC_RATE_LIMITS,
  type SyncRateLimitConfig,
} from './rate-limit';
import { syncValidator as zValidator } from './validation';
import {
  isWebSocketOriginAllowed,
  resolveAllowedOriginFromPatterns,
} from './websocket-origin';
import {
  createRealtimeSessionId,
  createWebSocketConnection,
  createWebSocketConnectionOwnerKey,
  type WebSocketConnection,
  WebSocketConnectionManager,
  type WebSocketRealtimeSubscription,
} from './ws';

/**
 * WeakMaps for storing Hono-instance-specific data without augmenting the type.
 */
const wsConnectionManagerMap = new WeakMap<Hono, WebSocketConnectionManager>();
const realtimeUnsubscribeMap = new WeakMap<Hono, () => void>();

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
   * Maximum JSON response body emitted by POST /.
   * Default: 16 MiB.
   */
  maxSyncResponseJsonBytes?: number;
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

const snapshotChunkParamsSchema = z.object({
  chunkId: z.string().min(1),
});
const snapshotArtifactParamsSchema = z.object({
  artifactId: z.string().min(1),
});
const snapshotChunkQuerySchema = z.object({
  scopes: z.string().optional(),
});

const auditCommitListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  beforeCommitSeq: z.coerce.number().int().min(1).optional(),
  actorId: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const auditCommitParamsSchema = z.object({
  commitSeq: z.coerce.number().int().min(1),
});

const auditRowHistoryParamsSchema = z.object({
  table: z.string().min(1),
  rowId: z.string().min(1),
});

const auditRowHistoryQuerySchema = z
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

const auditDebugExportQuerySchema = z.object({
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

const auditCommitListResponseSchema = z.object({
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

const auditCommitDetailResponseSchema = z.object({
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

const auditDebugExportResponseSchema = z.object({
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

const auditRowHistoryResponseSchema = z.object({
  ok: z.literal(true),
  table: z.string(),
  rowId: z.string(),
  history: z.array(auditRowHistoryEntrySchema),
  nextCursor: z.number().int().nullable(),
});

type AuditChangeResponse = z.infer<typeof auditChangeSchema>;
type AuditDebugExportEvent = z.infer<typeof auditDebugExportEventSchema>;

const DEFAULT_REQUEST_PAYLOAD_SNAPSHOT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_SYNC_REQUEST_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SYNC_RESPONSE_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SYNC_BINARY_PACK_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_CHUNK_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_ARTIFACT_RESPONSE_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_SCOPES_HEADER = 'x-syncular-snapshot-scopes';
const SYNC_CLIENT_ID_HEADER = 'x-syncular-client-id';

type TraceContext = {
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

function applySyncCorsHeaders(args: {
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

function createSyncCorsOriginDeniedResponse(origin: string): Response {
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

function createOpaqueId(prefix: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

function readOriginHeader(c: Context): string | undefined {
  return c.req.raw.headers.get('origin') ?? c.req.header('origin');
}

function readRequestId(c: Context): string {
  const headerRequestId = c.req.header('x-request-id')?.trim();
  if (headerRequestId) return headerRequestId;
  return createOpaqueId('req');
}

function readClientIdHint(c: Context): string {
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

function readPositiveInteger(
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

function readOptionalPositiveInteger(
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

function isSyncJsonBodyLimitError(
  error: unknown
): error is SyncJsonBodyLimitError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'SyncJsonBodyLimitError'
  );
}

function readRequestContentLength(c: Context): number | null | 'invalid' {
  const header = c.req.header('Content-Length');
  if (!header) return null;
  const value = Number(header);
  if (!Number.isFinite(value) || value < 0) return 'invalid';
  return Math.floor(value);
}

async function readRequestBodyBytesWithLimit(
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

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

function responseBodyOverLimit(
  c: Context,
  args: { limit: string; observed: number; max: number; message?: string }
): Response | null {
  if (args.observed <= args.max) return null;
  return syncLimitExceeded(c, args);
}

function syncValidationError(
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

function readTraceContext(c: Context): TraceContext {
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

function readTraceContextFromMessage(
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

function normalizeResponseStatus(statusCode: number, outcome: string): string {
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  if (statusCode >= 300) return 'redirect';
  if (statusCode >= 200) {
    if (outcome === 'error' || outcome === 'rejected') return 'failure';
    return 'success';
  }
  return 'unknown';
}

function firstPushErrorCode(results: unknown): string | null {
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

function summarizeScopeValues(
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

function summarizePullResponse(response: PullResult['response']): {
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

function summarizePullResponseForRequestEvent(
  response: PullResult['response']
): {
  subscriptionCount: number;
  activeSubscriptionCount: number;
  revokedSubscriptionCount: number;
  bootstrapSubscriptionCount: number;
  commitCount: number;
  changeCount: number;
  snapshotPageCount: number;
} {
  let activeSubscriptionCount = 0;
  let revokedSubscriptionCount = 0;
  let bootstrapSubscriptionCount = 0;
  let commitCount = 0;
  let changeCount = 0;
  let snapshotPageCount = 0;

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
    snapshotPageCount += subscription.snapshots?.length ?? 0;
  }

  return {
    subscriptionCount: response.subscriptions.length,
    activeSubscriptionCount,
    revokedSubscriptionCount,
    bootstrapSubscriptionCount,
    commitCount,
    changeCount,
    snapshotPageCount,
  };
}

function countPullRows(response: PullResult['response']): number {
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

function readSnapshotScopeValues(
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

function parseScopesSummary(
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

function normalizeRequestEventType(value: unknown): 'sync' | 'push' | 'pull' {
  if (value === 'sync' || value === 'push' || value === 'pull') {
    return value;
  }
  return 'pull';
}

function isMissingRequestEventsTableError(error: unknown): boolean {
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

function encodePayloadSnapshot(value: unknown, maxBytes: number): string {
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

function emitConsoleLiveEvent(
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

function isAuthLeaseRefreshRetriable(code: string): boolean {
  return (
    code === SYNC_AUTH_LEASE_CODE_MISSING ||
    code === SYNC_AUTH_LEASE_CODE_INVALID ||
    code === SYNC_AUTH_LEASE_CODE_EXPIRED
  );
}

export function createSyncRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(options: CreateSyncRoutesOptions<DB, Auth, F>): Hono {
  const routes = new Hono();
  const config = options.sync ?? {};
  const authLeaseRoutesConfig = options.authLeases;
  routes.onError((error, c) => {
    captureSyncException(error, {
      event: 'sync.route.unhandled',
      method: c.req.method,
      path: c.req.path,
    });
    return c.text('Internal Server Error', 500);
  });
  const corsConfig = normalizeSyncCorsConfig(config.cors);
  if (corsConfig) {
    routes.use('*', async (c, next) => {
      const origin = readOriginHeader(c);
      const allowedOrigin = await corsConfig.resolveOrigin(origin, c);

      if (origin && !allowedOrigin) {
        return createSyncCorsOriginDeniedResponse(origin);
      }

      const resolvedOrigin = allowedOrigin ?? '*';

      if (c.req.method === 'OPTIONS') {
        const headers = new Headers();
        applySyncCorsHeaders({
          headers,
          allowedOrigin: resolvedOrigin,
          allowCredentials: corsConfig.allowCredentials,
          allowHeaders: corsConfig.allowHeaders,
          exposeHeaders: corsConfig.exposeHeaders,
          allowMethods: corsConfig.allowMethods,
          maxAgeSeconds: corsConfig.maxAgeSeconds,
        });
        return new Response(null, { status: 204, headers });
      }

      await next();
      applySyncCorsHeaders({
        headers: c.res.headers,
        allowedOrigin: resolvedOrigin,
        allowCredentials: corsConfig.allowCredentials,
        allowHeaders: corsConfig.allowHeaders,
        exposeHeaders: corsConfig.exposeHeaders,
        allowMethods: corsConfig.allowMethods,
        maxAgeSeconds: corsConfig.maxAgeSeconds,
      });
      return c.res;
    });
  }
  const handlerRegistry = createServerHandlerCollection(options.handlers, {
    snapshotBinary: options.snapshotBinary,
  });
  const binarySyncPackChangeRowEncoders = Object.fromEntries(
    handlerRegistry.handlers.flatMap((handler) =>
      handler.snapshotBinaryEncoder
        ? [[handler.table, handler.snapshotBinaryEncoder]]
        : []
    )
  );
  const maxPullLimitCommits = config.maxPullLimitCommits ?? 1000;
  const maxSubscriptionsPerPull = config.maxSubscriptionsPerPull ?? 200;
  const maxPullLimitSnapshotRows = config.maxPullLimitSnapshotRows ?? 50000;
  const maxPullMaxSnapshotPages = config.maxPullMaxSnapshotPages ?? 50;
  const maxOperationsPerPush = config.maxOperationsPerPush ?? 200;
  const maxSyncRequestJsonBytes = readPositiveInteger(
    config.maxSyncRequestJsonBytes,
    DEFAULT_MAX_SYNC_REQUEST_JSON_BYTES
  );
  const maxSyncResponseJsonBytes = readPositiveInteger(
    config.maxSyncResponseJsonBytes,
    DEFAULT_MAX_SYNC_RESPONSE_JSON_BYTES
  );
  const maxSyncBinaryPackBytes = readPositiveInteger(
    config.maxSyncBinaryPackBytes,
    DEFAULT_MAX_SYNC_BINARY_PACK_BYTES
  );
  const maxSnapshotChunkResponseBytes = readPositiveInteger(
    config.maxSnapshotChunkResponseBytes,
    DEFAULT_MAX_SNAPSHOT_CHUNK_RESPONSE_BYTES
  );
  const maxSnapshotArtifactResponseBytes = readPositiveInteger(
    config.maxSnapshotArtifactResponseBytes,
    DEFAULT_MAX_SNAPSHOT_ARTIFACT_RESPONSE_BYTES
  );
  const requiredSchemaVersion = readOptionalPositiveInteger(
    config.requiredSchemaVersion
  );
  const latestSchemaVersion = readOptionalPositiveInteger(
    config.latestSchemaVersion
  );
  const requestPayloadSnapshots = config.requestPayloadSnapshots;
  const requestPayloadSnapshotsEnabled =
    requestPayloadSnapshots?.enabled ??
    requestPayloadSnapshots?.maxBytes !== undefined;
  const pruneConfig = config.prune;
  const compactConfig = config.compact;
  const pruneMinIntervalMs = readPositiveInteger(
    pruneConfig?.minIntervalMs,
    5 * 60 * 1000
  );
  const compactMinIntervalMs = readPositiveInteger(
    compactConfig?.minIntervalMs,
    30 * 60 * 1000
  );
  const compactOptions = compactConfig?.options;
  const consoleLiveEmitter = options.consoleLiveEmitter;
  const shouldEmitConsoleLiveEvents = consoleLiveEmitter !== undefined;
  const shouldRecordRequestEvents = shouldEmitConsoleLiveEvents;
  const shouldCaptureRequestPayloadSnapshots =
    shouldRecordRequestEvents && requestPayloadSnapshotsEnabled;
  const requestPayloadSnapshotMaxBytes = readPositiveInteger(
    requestPayloadSnapshots?.maxBytes,
    DEFAULT_REQUEST_PAYLOAD_SNAPSHOT_MAX_BYTES
  );
  const consoleSchemaReadyBase = shouldRecordRequestEvents
    ? (options.consoleSchemaReady ??
      options.dialect.ensureConsoleSchema?.(options.db) ??
      Promise.resolve())
    : Promise.resolve();
  const consoleSchemaReady = consoleSchemaReadyBase.catch((error) => {
    if (isBenignConsoleSchemaError(error)) {
      return;
    }
    logSyncEvent({
      event: 'sync.console_schema_ready_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  const authCache = new WeakMap<Context, Promise<Auth | null>>();
  const getAuth = (c: Context): Promise<Auth | null> => {
    const cached = authCache.get(c);
    if (cached) return cached;
    const pending = options.authenticate(c);
    authCache.set(c, pending);
    return pending;
  };
  type AuditScopeConfig = {
    scopes: ScopeValues;
    requiredScopeKeys: string[];
  };
  const createAuditScopeResolver = (auth: Auth) => {
    const auditScopesByTable = new Map<
      string,
      Promise<AuditScopeConfig | null>
    >();

    return async (table: string): Promise<AuditScopeConfig | null> => {
      const cached = auditScopesByTable.get(table);
      if (cached) return cached;

      const pending = (async () => {
        const handler = handlerRegistry.byTable.get(table);
        if (!handler) return null;

        let allowedScopes: ScopeValues;
        try {
          allowedScopes = await handler.resolveScopes({
            db: options.db,
            actorId: auth.actorId,
            auth,
          });
        } catch {
          return null;
        }

        const scopes = selectRequiredAuditScopes(
          handler.scopePatterns,
          allowedScopes
        );
        if (!scopes) return null;

        return {
          scopes,
          requiredScopeKeys: Array.from(
            collectScopeVars(handler.scopePatterns)
          ),
        };
      })();

      auditScopesByTable.set(table, pending);
      return pending;
    };
  };
  const readVisibleAuditChanges = async (args: {
    auth: Auth;
    partitionId: string;
    commitSeqs: readonly number[];
  }): Promise<Map<number, AuditChangeResponse[]>> => {
    const uniqueCommitSeqs = Array.from(new Set(args.commitSeqs));
    if (uniqueCommitSeqs.length === 0) return new Map();

    const changesResult = await sql<{
      commit_seq: number;
      change_id: number;
      table: string;
      row_id: string;
      op: 'upsert' | 'delete';
      row_json: unknown | null;
      row_version: number | null;
      scopes: unknown;
    }>`
      select
        ${sql.ref('commit_seq')} as ${sql.ref('commit_seq')},
        ${sql.ref('change_id')} as ${sql.ref('change_id')},
        ${sql.ref('table')} as ${sql.ref('table')},
        ${sql.ref('row_id')} as ${sql.ref('row_id')},
        ${sql.ref('op')} as ${sql.ref('op')},
        ${sql.ref('row_json')} as ${sql.ref('row_json')},
        ${sql.ref('row_version')} as ${sql.ref('row_version')},
        ${sql.ref('scopes')} as ${sql.ref('scopes')}
      from ${sql.table('sync_changes')}
      where ${sql.ref('partition_id')} = ${args.partitionId}
        and ${sql.ref('commit_seq')} in (${sql.join(uniqueCommitSeqs)})
      order by ${sql.ref('commit_seq')} asc, ${sql.ref('change_id')} asc
    `.execute(options.db);

    const resolveAuditScopesForTable = createAuditScopeResolver(args.auth);
    const changesByCommitSeq = new Map<number, AuditChangeResponse[]>();
    for (const change of changesResult.rows) {
      const scopeConfig = await resolveAuditScopesForTable(change.table);
      if (!scopeConfig) continue;

      const rowScopes = parseStoredAuditScopes(change.scopes);
      if (
        !rowScopesAllowed({
          rowScopes,
          allowedScopes: scopeConfig.scopes,
          requiredScopeKeys: scopeConfig.requiredScopeKeys,
        })
      ) {
        continue;
      }

      const commitSeq = Number(change.commit_seq);
      const summary = summarizeAuditChange({
        table: change.table,
        op: change.op,
        rowJson: change.row_json,
        scopes: change.scopes,
      });
      const changes = changesByCommitSeq.get(commitSeq) ?? [];
      changes.push({
        changeId: Number(change.change_id),
        table: change.table,
        rowId: change.row_id,
        op: change.op,
        rowVersion:
          change.row_version === null ? null : Number(change.row_version),
        ...summary,
      });
      changesByCommitSeq.set(commitSeq, changes);
    }

    return changesByCommitSeq;
  };
  const readAuditDebugRequestEvents = async (args: {
    auth: Auth;
    partitionId: string;
    limit: number;
    from?: string;
    to?: string;
  }): Promise<{
    events: AuditDebugExportEvent[];
    truncated: boolean;
  }> => {
    const whereClauses = [
      sql`partition_id = ${args.partitionId}`,
      sql`actor_id = ${args.auth.actorId}`,
    ];
    if (args.from) {
      whereClauses.push(sql`created_at >= ${args.from}`);
    }
    if (args.to) {
      whereClauses.push(sql`created_at <= ${args.to}`);
    }

    try {
      const result = await sql<{
        event_id: number | string | null;
        partition_id: string | null;
        request_id: string | null;
        trace_id: string | null;
        span_id: string | null;
        event_type: string | null;
        sync_path: string | null;
        transport_path: string | null;
        actor_id: string | null;
        client_id: string | null;
        status_code: number | string | null;
        outcome: string | null;
        response_status: string | null;
        error_code: string | null;
        duration_ms: number | string | null;
        commit_seq: number | string | null;
        operation_count: number | string | null;
        row_count: number | string | null;
        subscription_count: number | string | null;
        scopes_summary: unknown | null;
        tables: unknown;
        created_at: string | null;
      }>`
        select
          event_id,
          partition_id,
          request_id,
          trace_id,
          span_id,
          event_type,
          sync_path,
          transport_path,
          actor_id,
          client_id,
          status_code,
          outcome,
          response_status,
          error_code,
          duration_ms,
          commit_seq,
          operation_count,
          row_count,
          subscription_count,
          scopes_summary,
          tables,
          created_at
        from ${sql.table('sync_request_events')}
        where ${sql.join(whereClauses, sql` and `)}
        order by created_at desc
        limit ${args.limit + 1}
      `.execute(options.db);

      const selectedRows = result.rows.slice(0, args.limit);
      return {
        truncated: result.rows.length > args.limit,
        events: selectedRows.map((row) => ({
          eventId: coerceNumber(row.event_id) ?? 0,
          partitionId: row.partition_id ?? args.partitionId,
          requestId: row.request_id ?? '',
          traceId: row.trace_id ?? null,
          spanId: row.span_id ?? null,
          eventType: normalizeRequestEventType(row.event_type),
          syncPath: row.sync_path === 'ws-push' ? 'ws-push' : 'http-combined',
          transportPath: row.transport_path === 'relay' ? 'relay' : 'direct',
          actorId: row.actor_id ?? '',
          clientId: row.client_id ?? '',
          statusCode: coerceNumber(row.status_code) ?? 0,
          outcome: row.outcome ?? '',
          responseStatus: row.response_status ?? 'unknown',
          errorCode: row.error_code ?? null,
          durationMs: coerceNumber(row.duration_ms) ?? 0,
          commitSeq: coerceNumber(row.commit_seq),
          operationCount: coerceNumber(row.operation_count),
          rowCount: coerceNumber(row.row_count),
          subscriptionCount: coerceNumber(row.subscription_count),
          scopesSummary: parseScopesSummary(row.scopes_summary),
          tables: options.dialect.dbToArray(row.tables),
          createdAt: row.created_at ?? '',
        })),
      };
    } catch (error) {
      if (isMissingRequestEventsTableError(error)) {
        return { events: [], truncated: false };
      }
      throw error;
    }
  };
  const validateAuthLeaseCommit: PushCommitValidator<DB, Auth> | undefined =
    authLeaseRoutesConfig && authLeaseRoutesConfig.enabled !== false
      ? async ({ trx, request, auth }) => {
          const authLease = request.authLease;
          if (!authLease) return null;
          if (!authLease.leaseToken) {
            return {
              opIndex: 0,
              status: 'error',
              error: 'Auth lease token is missing',
              code: SYNC_AUTH_LEASE_CODE_MISSING,
              retriable: true,
            };
          }

          const verification = await verifyAuthLeaseToken({
            token: authLease.leaseToken,
            publicKey: authLeaseRoutesConfig.publicKey,
            nowMs: authLeaseRoutesConfig.nowMs?.(),
            expectedIssuer: authLeaseRoutesConfig.issuer,
            expectedAudience: authLeaseRoutesConfig.audience,
            expectedSchemaVersion: request.schemaVersion,
          });
          if (!verification.ok) {
            return {
              opIndex: 0,
              status: 'error',
              error: verification.message,
              code: verification.code,
              retriable: isAuthLeaseRefreshRetriable(verification.code),
            };
          }
          const verifiedPayload = verification.payload;
          if (
            verifiedPayload.actorId !== auth.actorId ||
            verifiedPayload.leaseId !== authLease.leaseId
          ) {
            return {
              opIndex: 0,
              status: 'error',
              error: 'Auth lease does not match the current replay context',
              code: SYNC_AUTH_LEASE_CODE_INVALID,
              retriable: true,
            };
          }
          for (
            let opIndex = 0;
            opIndex < request.operations.length;
            opIndex += 1
          ) {
            const operation = request.operations[opIndex]!;
            const handler = handlerRegistry.byTable.get(operation.table);
            if (!handler) {
              return {
                opIndex,
                status: 'error',
                error: 'Auth lease operation table is not registered',
                code: SYNC_AUTH_LEASE_CODE_INVALID,
                retriable: false,
              };
            }
            const operationError = await validateAuthLeaseOperation({
              db: trx,
              auth,
              handler,
              payload: verifiedPayload,
              operation,
              opIndex,
            });
            if (operationError) return operationError;
          }
          return null;
        }
      : undefined;

  type SyncJsonReadFailure = {
    statusCode: number;
    errorCode: string;
    errorMessage: string;
  };
  type SyncJsonReadResult =
    | { ok: true; value: unknown }
    | { ok: false; response: Response; failure?: SyncJsonReadFailure };
  const syncJsonBodyCache = new WeakMap<Request, Promise<SyncJsonReadResult>>();
  const readLimitedSyncJsonBody = (c: Context): Promise<SyncJsonReadResult> => {
    const cached = syncJsonBodyCache.get(c.req.raw);
    if (cached) return cached;

    const pending = (async (): Promise<SyncJsonReadResult> => {
      const declaredLength = readRequestContentLength(c);
      if (declaredLength === 'invalid') {
        return {
          ok: false,
          response: syncError(
            c,
            400,
            'sync.invalid_request',
            'Invalid Content-Length'
          ),
        };
      }
      if (
        typeof declaredLength === 'number' &&
        declaredLength > maxSyncRequestJsonBytes
      ) {
        return {
          ok: false,
          response: syncLimitExceeded(c, {
            limit: 'maxSyncRequestJsonBytes',
            observed: declaredLength,
            max: maxSyncRequestJsonBytes,
          }),
          failure: {
            statusCode: 413,
            errorCode: 'runtime.limit_exceeded',
            errorMessage: 'maxSyncRequestJsonBytes exceeded',
          },
        };
      }

      let bytes: Uint8Array;
      try {
        bytes = await readRequestBodyBytesWithLimit(c.req.raw, {
          maxBytes: maxSyncRequestJsonBytes,
          limit: 'maxSyncRequestJsonBytes',
        });
      } catch (error) {
        if (isSyncJsonBodyLimitError(error)) {
          return {
            ok: false,
            response: syncLimitExceeded(c, {
              limit: error.limit,
              observed: error.observed,
              max: error.max,
            }),
            failure: {
              statusCode: 413,
              errorCode: 'runtime.limit_exceeded',
              errorMessage: `${error.limit} exceeded`,
            },
          };
        }
        throw error;
      }

      try {
        const text = new TextDecoder().decode(bytes);
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return {
          ok: false,
          response: syncValidationError(c, 'json', [
            { message: 'Invalid JSON body.', path: [] },
          ]),
        };
      }
    })();

    syncJsonBodyCache.set(c.req.raw, pending);
    return pending;
  };

  // -------------------------------------------------------------------------
  // Optional WebSocket manager (scope-key based wake-ups)
  // -------------------------------------------------------------------------

  const websocketConfig = config.websocket;
  if (websocketConfig?.enabled && !websocketConfig.upgradeWebSocket) {
    throw new Error(
      'sync.websocket.enabled requires sync.websocket.upgradeWebSocket'
    );
  }

  const wsConnectionManager = websocketConfig?.enabled
    ? (options.wsConnectionManager ??
      new WebSocketConnectionManager({
        heartbeatIntervalMs: websocketConfig.heartbeatIntervalMs ?? 30_000,
        maxInFlightSyncsPerConnection:
          websocketConfig.maxInFlightSyncsPerConnection ?? 64,
        replayWindowSize: websocketConfig.replayWindowSize ?? 64,
      }))
    : null;

  if (wsConnectionManager) {
    wsConnectionManagerMap.set(routes, wsConnectionManager);
  }

  // -------------------------------------------------------------------------
  // Multi-instance realtime broadcaster (optional)
  // -------------------------------------------------------------------------

  const realtimeBroadcaster = config.realtime?.broadcaster ?? null;
  const instanceId =
    config.realtime?.instanceId ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const loggedAsyncFailureKeys = new Set<string>();
  const logAsyncFailureOnce = (
    key: string,
    event: {
      event: string;
      error: string;
      [key: string]: unknown;
    }
  ) => {
    if (loggedAsyncFailureKeys.has(key)) return;
    loggedAsyncFailureKeys.add(key);
    logSyncEvent(event);
  };

  if (compactConfig && !compactOptions) {
    logSyncEvent({
      event: 'sync.compact_auto_disabled',
      reason: 'missing_options',
    });
  }

  const triggerAutoMaintenance = (ctx: {
    actorId: string;
    clientId: string;
    partitionId: string;
  }): void => {
    if (!pruneConfig && !compactConfig) return;

    void (async () => {
      if (pruneConfig) {
        try {
          const deleted = await maybePruneSync(options.db, {
            minIntervalMs: pruneMinIntervalMs,
            options: pruneConfig.options,
          });
          if (deleted > 0) {
            logSyncEvent({
              event: 'sync.prune_auto',
              userId: ctx.actorId,
              clientId: ctx.clientId,
              partitionId: ctx.partitionId,
              deletedCount: deleted,
            });
          }
        } catch (error) {
          logAsyncFailureOnce('sync.prune_auto_failed', {
            event: 'sync.prune_auto_failed',
            userId: ctx.actorId,
            clientId: ctx.clientId,
            partitionId: ctx.partitionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (compactConfig && compactOptions) {
        try {
          const deleted = await maybeCompactChanges(options.db, {
            dialect: options.dialect,
            minIntervalMs: compactMinIntervalMs,
            options: compactOptions,
          });
          if (deleted > 0) {
            logSyncEvent({
              event: 'sync.compact_auto',
              userId: ctx.actorId,
              clientId: ctx.clientId,
              partitionId: ctx.partitionId,
              deletedCount: deleted,
            });
          }
        } catch (error) {
          logAsyncFailureOnce('sync.compact_auto_failed', {
            event: 'sync.compact_auto_failed',
            userId: ctx.actorId,
            clientId: ctx.clientId,
            partitionId: ctx.partitionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  };

  if (wsConnectionManager && realtimeBroadcaster) {
    const unsubscribe = realtimeBroadcaster.subscribe(
      (event: SyncRealtimeEvent) => {
        void handleRealtimeEvent(event).catch((error) => {
          logAsyncFailureOnce('sync.realtime.broadcast_delivery_failed', {
            event: 'sync.realtime.broadcast_delivery_failed',
            error: error instanceof Error ? error.message : String(error),
            sourceEventType: event.type,
          });
        });
      }
    );

    realtimeUnsubscribeMap.set(routes, unsubscribe);
  }

  // -------------------------------------------------------------------------
  // Request event recording (for console inspector)
  // -------------------------------------------------------------------------

  type RequestPayloadSnapshot = {
    request: unknown;
    response: unknown;
  };

  type RequestEvent = {
    partitionId: string;
    requestId: string;
    traceId?: string | null;
    spanId?: string | null;
    eventType: 'sync' | 'push' | 'pull';
    syncPath: 'http-combined' | 'ws-push';
    actorId: string;
    clientId: string;
    transportPath: 'direct' | 'relay';
    statusCode: number;
    outcome: string;
    responseStatus: string;
    durationMs: number;
    errorCode?: string | null;
    commitSeq?: number | null;
    operationCount?: number | null;
    rowCount?: number | null;
    subscriptionCount?: number | null;
    scopesSummary?: Record<string, string | string[]> | null;
    responseSummary?: Record<string, unknown> | null;
    tables?: string[];
    errorMessage?: string | null;
    payloadRef?: string | null;
    payloadSnapshot?: RequestPayloadSnapshot | null;
  };

  const recordRequestEvent = async (event: RequestEvent) => {
    let payloadRef = event.payloadRef ?? null;
    if (event.payloadSnapshot) {
      const nextPayloadRef = payloadRef ?? createOpaqueId('payload');
      const nowIso = new Date().toISOString();

      try {
        await sql`
          INSERT INTO sync_request_payloads (
            payload_ref, partition_id, request_payload, response_payload, created_at
          ) VALUES (
            ${nextPayloadRef}, ${event.partitionId},
            ${encodePayloadSnapshot(
              event.payloadSnapshot.request,
              requestPayloadSnapshotMaxBytes
            )},
            ${encodePayloadSnapshot(
              event.payloadSnapshot.response,
              requestPayloadSnapshotMaxBytes
            )},
            ${nowIso}
          )
          ON CONFLICT (payload_ref) DO UPDATE SET
            partition_id = EXCLUDED.partition_id,
            request_payload = EXCLUDED.request_payload,
            response_payload = EXCLUDED.response_payload,
            created_at = EXCLUDED.created_at
        `.execute(options.db);
        payloadRef = nextPayloadRef;
      } catch (error) {
        payloadRef = null;
        logAsyncFailureOnce('sync.request_payload_record_failed', {
          event: 'sync.request_payload_record_failed',
          userId: event.actorId,
          clientId: event.clientId,
          requestEventType: event.eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const tablesValue = options.dialect.arrayToDb(event.tables ?? []);
    const scopesSummaryValue = event.scopesSummary
      ? JSON.stringify(event.scopesSummary)
      : null;
    const responseSummaryValue = event.responseSummary
      ? JSON.stringify(event.responseSummary)
      : null;

    await sql`
      INSERT INTO sync_request_events (
        partition_id, request_id, trace_id, span_id,
        event_type, sync_path, actor_id, client_id, transport_path,
        status_code, outcome, response_status, error_code,
        duration_ms, commit_seq, operation_count, row_count, subscription_count,
        scopes_summary, response_summary, tables, error_message, payload_ref
      ) VALUES (
        ${event.partitionId}, ${event.requestId}, ${event.traceId ?? null},
        ${event.spanId ?? null}, ${event.eventType}, ${event.syncPath},
        ${event.actorId}, ${event.clientId}, ${event.transportPath},
        ${event.statusCode}, ${event.outcome}, ${event.responseStatus},
        ${event.errorCode ?? null}, ${event.durationMs}, ${event.commitSeq ?? null},
        ${event.operationCount ?? null}, ${event.rowCount ?? null},
        ${event.subscriptionCount ?? null}, ${scopesSummaryValue},
        ${responseSummaryValue}, ${tablesValue}, ${event.errorMessage ?? null},
        ${payloadRef}
      )
    `.execute(options.db);
  };

  const recordRequestEventInBackground = (
    event: RequestEvent | (() => RequestEvent)
  ): void => {
    if (!shouldRecordRequestEvents) return;

    const resolvedEvent = typeof event === 'function' ? event() : event;

    void consoleSchemaReady
      .then(() => recordRequestEvent(resolvedEvent))
      .catch((error) => {
        logAsyncFailureOnce('sync.request_event_record_failed', {
          event: 'sync.request_event_record_failed',
          userId: resolvedEvent.actorId,
          clientId: resolvedEvent.clientId,
          requestEventType: resolvedEvent.eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const recordHttpCombinedFailure = (args: {
    partitionId: string;
    requestId: string;
    traceContext: TraceContext;
    actorId: string;
    clientId: string;
    transportPath: 'direct' | 'relay';
    eventType: 'sync' | 'push' | 'pull';
    statusCode: number;
    outcome: 'rejected' | 'error';
    durationMs: number;
    errorCode: string;
    errorMessage: string;
    operationCount?: number | null;
    rowCount?: number | null;
    subscriptionCount?: number | null;
    scopesSummary?: Record<string, string | string[]> | null;
    responseSummary?: Record<string, unknown> | null;
    payloadSnapshot?: RequestPayloadSnapshot | null;
  }): void => {
    recordRequestEventInBackground(() => ({
      partitionId: args.partitionId,
      requestId: args.requestId,
      traceId: args.traceContext.traceId,
      spanId: args.traceContext.spanId,
      eventType: args.eventType,
      syncPath: 'http-combined',
      actorId: args.actorId,
      clientId: args.clientId,
      transportPath: args.transportPath,
      statusCode: args.statusCode,
      outcome: args.outcome,
      responseStatus: normalizeResponseStatus(args.statusCode, args.outcome),
      durationMs: args.durationMs,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      operationCount: args.operationCount ?? null,
      rowCount: args.rowCount ?? null,
      subscriptionCount: args.subscriptionCount ?? null,
      scopesSummary: args.scopesSummary ?? null,
      responseSummary: args.responseSummary ?? null,
      payloadSnapshot: args.payloadSnapshot ?? null,
    }));

    emitConsoleLiveEvent(consoleLiveEmitter, args.eventType, () => ({
      partitionId: args.partitionId,
      requestId: args.requestId,
      traceId: args.traceContext.traceId,
      spanId: args.traceContext.spanId,
      actorId: args.actorId,
      clientId: args.clientId,
      transportPath: args.transportPath,
      syncPath: 'http-combined',
      outcome: args.outcome,
      statusCode: args.statusCode,
      durationMs: args.durationMs,
      operationCount: args.operationCount ?? null,
      rowCount: args.rowCount ?? null,
      subscriptionCount: args.subscriptionCount ?? null,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    }));
  };

  const recordHttpCombinedReadFailure = async (
    c: Context,
    failure: SyncJsonReadFailure
  ): Promise<void> => {
    if (!shouldRecordRequestEvents && !shouldEmitConsoleLiveEvents) return;

    const auth = await getAuth(c).catch(() => null);
    if (!auth) return;

    recordHttpCombinedFailure({
      partitionId: auth.partitionId ?? 'default',
      requestId: readRequestId(c),
      traceContext: readTraceContext(c),
      actorId: auth.actorId,
      clientId: readClientIdHint(c),
      transportPath: readTransportPath(c),
      eventType: 'sync',
      statusCode: failure.statusCode,
      outcome: failure.statusCode >= 500 ? 'error' : 'rejected',
      durationMs: 0,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    });
  };

  type PushRequestBody = Omit<
    z.infer<typeof SyncPushCommitRequestSchema>,
    never
  >;

  type PushExecutionContext = {
    auth: Auth;
    clientId: string;
    partitionId: string;
    requestId: string;
    traceContext: TraceContext;
    transportPath: 'direct' | 'relay';
    syncPath: 'http-combined' | 'ws-push';
  };

  type ExecutedPushCommit = Awaited<ReturnType<typeof pushCommit>>;

  type PushExecutionSummary = {
    durationMs: number;
    outcome: string;
    commitSeq: number | null;
    operationCount: number;
    tables: string[];
    results: SyncPushResponse['results'];
    payloadSnapshot: RequestPayloadSnapshot | null;
  };

  async function notifyRealtimeForAppliedPushes(
    ctx: PushExecutionContext,
    pushedCommits: ExecutedPushCommit[]
  ): Promise<void> {
    if (!wsConnectionManager && !realtimeBroadcaster) {
      return;
    }

    let latestCommitSeq = 0;
    const scopeKeys = new Set<string>();
    const emittedCommits: SyncCommit[] = [];

    for (const pushed of pushedCommits) {
      if (
        pushed.response.ok !== true ||
        pushed.response.status !== 'applied' ||
        typeof pushed.response.commitSeq !== 'number'
      ) {
        continue;
      }

      latestCommitSeq = Math.max(latestCommitSeq, pushed.response.commitSeq);
      for (const scopeKey of applyPartitionToScopeKeys(
        ctx.partitionId,
        pushed.scopeKeys
      )) {
        scopeKeys.add(scopeKey);
      }
      if (pushed.emittedChanges.length > 0) {
        emittedCommits.push({
          commitSeq: pushed.response.commitSeq,
          createdAt: pushed.commitCreatedAt ?? new Date().toISOString(),
          actorId: pushed.commitActorId ?? ctx.auth.actorId,
          changes: [...pushed.emittedChanges],
        });
      }
    }

    if (latestCommitSeq <= 0 || scopeKeys.size === 0) {
      return;
    }

    const combinedScopeKeys = Array.from(scopeKeys);
    const syncPacksByOwnerKey = wsConnectionManager
      ? await buildRealtimeSyncPacksForConnections({
          ctx,
          manager: wsConnectionManager,
          scopeKeys: combinedScopeKeys,
          latestCommitSeq,
          emittedCommits,
        })
      : new Map<string, Uint8Array | undefined>();

    if (wsConnectionManager) {
      wsConnectionManager.notifyScopeKeys(combinedScopeKeys, latestCommitSeq, {
        excludeClientIds: [ctx.clientId],
        syncPackForConnection: (connection) =>
          syncPacksByOwnerKey.get(connection.ownerKey),
      });
    }

    if (realtimeBroadcaster) {
      realtimeBroadcaster
        .publish({
          type: 'commit',
          commitSeq: latestCommitSeq,
          shardKey: createSyncRealtimeShardKey({
            partitionId: ctx.partitionId,
          }),
          partitionId: ctx.partitionId,
          scopeKeys: combinedScopeKeys,
          sourceInstanceId: instanceId,
        })
        .catch((error) => {
          logAsyncFailureOnce('sync.realtime.broadcast_publish_failed', {
            event: 'sync.realtime.broadcast_publish_failed',
            userId: ctx.auth.actorId,
            clientId: ctx.clientId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  async function buildRealtimeSyncPacksForConnections(args: {
    ctx: PushExecutionContext;
    manager: WebSocketConnectionManager;
    scopeKeys: string[];
    latestCommitSeq: number;
    emittedCommits: SyncCommit[];
  }): Promise<Map<string, Uint8Array | undefined>> {
    const syncPacksByOwnerKey = new Map<string, Uint8Array | undefined>();
    const ownerKeys = new Set<string>();
    for (const connection of args.manager.getConnectionsForScopeKeys(
      args.scopeKeys,
      { excludeClientIds: [args.ctx.clientId] }
    )) {
      ownerKeys.add(connection.ownerKey);
    }

    await Promise.all(
      Array.from(ownerKeys).map(async (ownerKey) => {
        syncPacksByOwnerKey.set(
          ownerKey,
          await buildRealtimeSyncPackForOwner({ ...args, ownerKey })
        );
      })
    );

    return syncPacksByOwnerKey;
  }

  async function buildRealtimeSyncPackForOwner(args: {
    ctx: PushExecutionContext;
    manager: WebSocketConnectionManager;
    ownerKey: string;
    latestCommitSeq: number;
    emittedCommits: SyncCommit[];
  }): Promise<Uint8Array | undefined> {
    const subscriptions = args.manager.getConnectionSubscriptions(
      args.ownerKey
    );
    if (subscriptions.length === 0 || args.emittedCommits.length === 0) {
      return undefined;
    }

    const responses: SyncPullSubscriptionResponse[] = [];
    const rootUpdates: Array<{
      subscriptionId: string;
      cursor: number;
      verifiedRoot: string;
    }> = [];
    for (const subscription of subscriptions) {
      const commits = selectRealtimeCommitsForSubscription(
        args.ctx.partitionId,
        args.emittedCommits,
        subscription
      );
      if (commits.length === 0) continue;

      const integrity = await createWireSubscriptionIntegrity({
        partitionId: args.ctx.partitionId,
        subscriptionId: subscription.id,
        previousRoot: subscription.verifiedRoot,
        commits,
      });
      const nextCursor = Math.max(args.latestCommitSeq, subscription.cursor);
      if (integrity) {
        rootUpdates.push({
          subscriptionId: subscription.id,
          cursor: nextCursor,
          verifiedRoot: integrity.commitChainRoot,
        });
      }

      responses.push({
        id: subscription.id,
        status: 'active',
        scopes: subscription.scopes,
        bootstrap: false,
        bootstrapState: null,
        nextCursor,
        ...(integrity ? { integrity } : {}),
        commits,
      });
    }

    if (responses.length === 0) {
      return undefined;
    }

    try {
      const bytes = encodeBinarySyncPack(
        {
          ok: true as const,
          pull: {
            ok: true as const,
            subscriptions: responses,
          },
        },
        {
          changeRowEncoders: binarySyncPackChangeRowEncoders,
        }
      );
      args.manager.updateConnectionSubscriptionRoots(
        args.ownerKey,
        rootUpdates
      );
      return bytes;
    } catch (error) {
      logAsyncFailureOnce('sync.realtime.binary_pack_encode_failed', {
        event: 'sync.realtime.binary_pack_encode_failed',
        userId: args.ctx.auth.actorId,
        clientId: args.ctx.clientId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  function selectRealtimeCommitsForSubscription(
    partitionId: string,
    commits: readonly SyncCommit[],
    subscription: WebSocketRealtimeSubscription
  ): SyncCommit[] {
    const scopeKeys = new Set(subscription.scopeKeys);
    if (scopeKeys.size === 0) return [];

    const selected: SyncCommit[] = [];
    for (const commit of commits) {
      const changes = commit.changes.filter((change) =>
        changeMatchesRealtimeSubscription(partitionId, change, scopeKeys)
      );
      if (changes.length === 0) continue;
      selected.push({ ...commit, changes });
    }
    return selected;
  }

  function changeMatchesRealtimeSubscription(
    partitionId: string,
    change: SyncChange,
    scopeKeys: Set<string>
  ): boolean {
    for (const scopeKey of applyPartitionToScopeKeys(
      partitionId,
      scopeValuesToScopeKeys(change.scopes)
    )) {
      if (scopeKeys.has(scopeKey)) return true;
    }
    return false;
  }

  function buildRealtimeSubscriptionsForPull(args: {
    partitionId: string;
    requestSubscriptions: Array<{
      id: string;
      table: string;
      scopes: Record<string, string | string[]>;
      cursor: number;
      verifiedRoot?: string;
    }>;
    responseSubscriptions: SyncPullSubscriptionResponse[];
  }): WebSocketRealtimeSubscription[] {
    const requestById = new Map(
      args.requestSubscriptions.map((subscription) => [
        subscription.id,
        subscription,
      ])
    );
    const subscriptions: WebSocketRealtimeSubscription[] = [];

    for (const response of args.responseSubscriptions) {
      if (response.status !== 'active') continue;
      const request = requestById.get(response.id);
      const scopeKeys = applyPartitionToScopeKeys(
        args.partitionId,
        scopeValuesToScopeKeys(response.scopes)
      );
      if (scopeKeys.length === 0) continue;

      subscriptions.push({
        id: response.id,
        table: request?.table ?? response.id,
        scopes: response.scopes,
        scopeKeys,
        cursor: response.nextCursor,
        verifiedRoot:
          response.integrity?.commitChainRoot ?? request?.verifiedRoot ?? null,
      });
    }

    return subscriptions;
  }

  function recordPushExecutionSideEffects(
    ctx: PushExecutionContext,
    summary: PushExecutionSummary
  ): void {
    recordRequestEventInBackground(() => ({
      partitionId: ctx.partitionId,
      requestId: ctx.requestId,
      traceId: ctx.traceContext.traceId,
      spanId: ctx.traceContext.spanId,
      eventType: 'push',
      syncPath: ctx.syncPath,
      actorId: ctx.auth.actorId,
      clientId: ctx.clientId,
      transportPath: ctx.transportPath,
      statusCode: 200,
      outcome: summary.outcome,
      responseStatus: normalizeResponseStatus(200, summary.outcome),
      durationMs: summary.durationMs,
      errorCode: firstPushErrorCode(summary.results),
      commitSeq: summary.commitSeq,
      operationCount: summary.operationCount,
      tables: summary.tables,
      payloadSnapshot: summary.payloadSnapshot,
    }));

    emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
      partitionId: ctx.partitionId,
      requestId: ctx.requestId,
      traceId: ctx.traceContext.traceId,
      spanId: ctx.traceContext.spanId,
      actorId: ctx.auth.actorId,
      clientId: ctx.clientId,
      transportPath: ctx.transportPath,
      syncPath: ctx.syncPath,
      outcome: summary.outcome,
      statusCode: 200,
      durationMs: summary.durationMs,
      commitSeq: summary.commitSeq,
      operationCount: summary.operationCount,
      tables: summary.tables,
    }));
  }

  function maybeCountPushConflicts(
    ctx: PushExecutionContext,
    results: SyncPushResponse['results'],
    enabled?: boolean
  ): void {
    if (enabled !== true) {
      return;
    }

    const detectedConflicts = results.reduce(
      (count, result) => count + (result.status === 'conflict' ? 1 : 0),
      0
    );
    if (detectedConflicts <= 0) {
      return;
    }

    countSyncMetric('sync.conflicts.detected', detectedConflicts, {
      attributes: {
        syncPath: ctx.syncPath,
        transportPath: ctx.transportPath,
      },
    });
  }

  function emitCommitLiveEvents(
    ctx: PushExecutionContext,
    pushedCommits: ExecutedPushCommit[]
  ): void {
    for (const pushed of pushedCommits) {
      if (
        pushed.response.ok !== true ||
        pushed.response.status !== 'applied' ||
        typeof pushed.response.commitSeq !== 'number'
      ) {
        continue;
      }

      emitConsoleLiveEvent(consoleLiveEmitter, 'commit', () => ({
        partitionId: ctx.partitionId,
        commitSeq: pushed.response.commitSeq,
        actorId: ctx.auth.actorId,
        clientId: ctx.clientId,
        affectedTables: pushed.affectedTables,
      }));
    }
  }

  async function executePushCommitBatchWithSideEffects(
    ctx: PushExecutionContext,
    pushBodies: PushRequestBody[],
    execOptions: {
      countConflictsMetric?: boolean;
    } = {}
  ): Promise<ExecutedPushCommit[]> {
    const timer = createSyncTimer();
    const totalOperationCount = pushBodies.reduce(
      (count, pushBody) => count + (pushBody.operations?.length ?? 0),
      0
    );
    const executedPushes = await pushCommitBatch({
      db: options.db,
      dialect: options.dialect,
      handlers: handlerRegistry,
      plugins: options.plugins,
      auth: ctx.auth,
      validateCommit: validateAuthLeaseCommit,
      suppressTelemetry: true,
      requests: pushBodies.map((pushBody) => ({
        clientId: ctx.clientId,
        clientCommitId: pushBody.clientCommitId,
        operations: pushBody.operations,
        schemaVersion: pushBody.schemaVersion,
        authLease: pushBody.authLease,
      })),
    });
    const affectedTables = new Set<string>();
    for (const pushed of executedPushes) {
      for (const table of pushed.affectedTables) {
        affectedTables.add(table);
      }
    }

    const pushDurationMs = timer();
    const latestCommitSeq = executedPushes.reduce((latest, pushed) => {
      if (typeof pushed.response.commitSeq === 'number') {
        return Math.max(latest, pushed.response.commitSeq);
      }
      return latest;
    }, 0);
    const aggregateStatus = executedPushes.every(
      (pushed) => pushed.response.status === 'cached'
    )
      ? 'cached'
      : executedPushes.every(
            (pushed) =>
              pushed.response.status === 'applied' ||
              pushed.response.status === 'cached'
          )
        ? 'applied'
        : 'rejected';
    const aggregatedResults = executedPushes.flatMap(
      (pushed) => pushed.response.results
    );

    logSyncEvent({
      event: 'sync.push',
      userId: ctx.auth.actorId,
      durationMs: pushDurationMs,
      operationCount: totalOperationCount,
      status: aggregateStatus,
      commitSeq: latestCommitSeq > 0 ? latestCommitSeq : undefined,
    });

    recordPushExecutionSideEffects(ctx, {
      durationMs: pushDurationMs,
      outcome: aggregateStatus,
      commitSeq: latestCommitSeq > 0 ? latestCommitSeq : null,
      operationCount: totalOperationCount,
      tables: Array.from(affectedTables),
      results: aggregatedResults,
      payloadSnapshot: shouldCaptureRequestPayloadSnapshots
        ? {
            request: {
              clientId: ctx.clientId,
              commits: pushBodies.map((pushBody) => ({
                clientCommitId: pushBody.clientCommitId,
                schemaVersion: pushBody.schemaVersion,
                authLease: pushBody.authLease,
                operations: pushBody.operations,
              })),
            },
            response: {
              ok: true,
              commits: executedPushes.map((pushed, index) => ({
                clientCommitId: pushBodies[index]?.clientCommitId ?? '',
                ...pushed.response,
              })),
            },
          }
        : null,
    });

    maybeCountPushConflicts(
      ctx,
      aggregatedResults,
      execOptions.countConflictsMetric
    );

    await notifyRealtimeForAppliedPushes(ctx, executedPushes);
    emitCommitLiveEvents(ctx, executedPushes);

    return executedPushes;
  }

  async function executePushCommitWithSideEffects(
    ctx: PushExecutionContext,
    pushBody: PushRequestBody,
    execOptions: {
      countConflictsMetric?: boolean;
      deferRealtimeNotifications?: boolean;
    } = {}
  ): Promise<ExecutedPushCommit> {
    const timer = createSyncTimer();
    const pushOps = pushBody.operations ?? [];

    const pushed = await pushCommit({
      db: options.db,
      dialect: options.dialect,
      handlers: handlerRegistry,
      plugins: options.plugins,
      auth: ctx.auth,
      validateCommit: validateAuthLeaseCommit,
      request: {
        clientId: ctx.clientId,
        clientCommitId: pushBody.clientCommitId,
        operations: pushBody.operations,
        schemaVersion: pushBody.schemaVersion,
        authLease: pushBody.authLease,
      },
    });

    const pushDurationMs = timer();

    logSyncEvent({
      event: 'sync.push',
      userId: ctx.auth.actorId,
      durationMs: pushDurationMs,
      operationCount: pushOps.length,
      status: pushed.response.status,
      commitSeq: pushed.response.commitSeq,
    });

    recordPushExecutionSideEffects(ctx, {
      durationMs: pushDurationMs,
      outcome: pushed.response.status,
      commitSeq: pushed.response.commitSeq ?? null,
      operationCount: pushOps.length,
      tables: pushed.affectedTables,
      results: pushed.response.results,
      payloadSnapshot: shouldCaptureRequestPayloadSnapshots
        ? {
            request: {
              clientId: ctx.clientId,
              clientCommitId: pushBody.clientCommitId,
              schemaVersion: pushBody.schemaVersion,
              authLease: pushBody.authLease,
              operations: pushBody.operations,
            },
            response: pushed.response,
          }
        : null,
    });

    maybeCountPushConflicts(
      ctx,
      pushed.response.results,
      execOptions.countConflictsMetric
    );

    if (execOptions.deferRealtimeNotifications !== true) {
      await notifyRealtimeForAppliedPushes(ctx, [pushed]);
    }
    emitCommitLiveEvents(ctx, [pushed]);

    return pushed;
  }

  // -------------------------------------------------------------------------
  // Rate limiting (optional)
  // -------------------------------------------------------------------------

  const rateLimitConfig = config.rateLimit;
  if (rateLimitConfig !== false) {
    const pullRateLimit =
      rateLimitConfig?.pull ?? DEFAULT_SYNC_RATE_LIMITS.pull;
    const pushRateLimit =
      rateLimitConfig?.push ?? DEFAULT_SYNC_RATE_LIMITS.push;

    const createAuthBasedRateLimiter = (
      limitConfig: Omit<SyncRateLimitConfig['pull'], never> | false | undefined
    ) => {
      if (limitConfig === false || !limitConfig) return null;
      return createRateLimiter({
        ...limitConfig,
        keyGenerator: async (c) => {
          const auth = await getAuth(c);
          return auth?.actorId ?? null;
        },
      });
    };

    const pullLimiter = createAuthBasedRateLimiter(pullRateLimit);
    const pushLimiter = createAuthBasedRateLimiter(pushRateLimit);

    const syncRateLimiter: MiddlewareHandler = async (c, next) => {
      if (!pullLimiter && !pushLimiter) return next();

      let shouldApplyPull = pullLimiter !== null;
      let shouldApplyPush = pushLimiter !== null;

      if (pullLimiter && pushLimiter && c.req.method === 'POST') {
        const parsed = await readLimitedSyncJsonBody(c);
        if (!parsed.ok) {
          if (parsed.failure) {
            await recordHttpCombinedReadFailure(c, parsed.failure);
          }
          return parsed.response;
        }
        if (parsed.value !== null && typeof parsed.value === 'object') {
          shouldApplyPull = Reflect.get(parsed.value, 'pull') !== undefined;
          shouldApplyPush = Reflect.get(parsed.value, 'push') !== undefined;
        }
      }

      if (pullLimiter && shouldApplyPull && pushLimiter && shouldApplyPush) {
        return pullLimiter(c, async () => {
          const pushResult = await pushLimiter(c, next);
          if (pushResult instanceof Response) {
            c.res = pushResult;
          }
        });
      }
      if (pullLimiter && shouldApplyPull) {
        return pullLimiter(c, next);
      }
      if (pushLimiter && shouldApplyPush) {
        return pushLimiter(c, next);
      }

      return next();
    };

    routes.use('/', syncRateLimiter);
  }

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  routes.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth-leases/issue
  // -------------------------------------------------------------------------

  if (authLeaseRoutesConfig && authLeaseRoutesConfig.enabled !== false) {
    routes.post(
      '/auth-leases/issue',
      describeRoute({
        tags: ['sync'],
        summary: 'Issue an offline auth lease',
        description:
          'Issues a bounded signed auth lease for offline intent capture. The lease does not bypass current request auth or table-handler authorization on replay.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        responses: {
          200: {
            description: 'Issued auth lease',
            content: {
              'application/json': {
                schema: resolver(SyncAuthLeaseIssueResponseSchema),
              },
            },
          },
          401: {
            description: 'Unauthenticated',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
          403: {
            description: 'Requested lease scopes are not allowed',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
        },
      }),
      zValidator('json', SyncAuthLeaseIssueRequestSchema),
      async (c) => {
        const auth = await getAuth(c);
        if (!auth) return syncError(c, 401, 'sync.auth_required');

        const request = c.req.valid('json');
        let issued: SyncAuthLeaseIssueResponse | null;
        try {
          issued = await issueAuthLease({
            db: options.db,
            auth,
            handlers: handlerRegistry,
            scopeCache: options.scopeCache,
            request,
            issuer: authLeaseRoutesConfig.issuer,
            audience: authLeaseRoutesConfig.audience,
            kid: authLeaseRoutesConfig.kid,
            signer: authLeaseRoutesConfig.signer,
            capabilities: authLeaseRoutesConfig.capabilities,
            defaultTtlMs: authLeaseRoutesConfig.ttlMs,
            maxTtlMs: authLeaseRoutesConfig.maxTtlMs,
            maxClockSkewMs: authLeaseRoutesConfig.maxClockSkewMs,
            nowMs: authLeaseRoutesConfig.nowMs,
            leaseId: authLeaseRoutesConfig.leaseId,
            subject: authLeaseRoutesConfig.subject,
          });
        } catch (error) {
          if (error instanceof InvalidSubscriptionScopeError) {
            return syncError(c, 400, 'sync.invalid_request', error.message);
          }
          throw error;
        }

        if (!issued) {
          return syncError(
            c,
            403,
            'sync.auth_lease_scope_mismatch',
            'Requested auth lease scopes are not allowed'
          );
        }

        return c.json(issued, 200);
      }
    );
  }

  // -------------------------------------------------------------------------
  // GET /audit/commits
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/commits',
    describeRoute({
      tags: ['sync'],
      summary: 'List sync commits for audit UI',
      description:
        'Returns commit-level audit history scoped to the authenticated partition.',
      responses: {
        200: {
          description: 'Commit audit history',
          content: {
            'application/json': {
              schema: resolver(auditCommitListResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', auditCommitListQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const query = c.req.valid('query');
      const limit = query.limit ?? 50;

      const whereClauses = [sql`c.partition_id = ${partitionId}`];
      if (query.beforeCommitSeq !== undefined) {
        whereClauses.push(sql`c.commit_seq < ${query.beforeCommitSeq}`);
      }
      if (query.actorId) {
        whereClauses.push(sql`c.actor_id = ${query.actorId}`);
      }
      if (query.from) {
        whereClauses.push(sql`c.created_at >= ${query.from}`);
      }
      if (query.to) {
        whereClauses.push(sql`c.created_at <= ${query.to}`);
      }
      const tableFilter = query.table;
      if (tableFilter) {
        whereClauses.push(sql`
          exists (
            select 1
            from ${sql.table('sync_table_commits')} as ${sql.ref('tc')}
            where ${sql.raw('tc.partition_id')} = ${partitionId}
              and ${sql.raw('tc.commit_seq')} = ${sql.raw('c.commit_seq')}
              and ${sql.raw('tc.table')} = ${tableFilter}
          )
        `);
      }

      const rowsResult = await sql<{
        commit_seq: number;
        actor_id: string;
        client_id: string;
        client_commit_id: string;
        created_at: string;
        change_count: number;
        affected_tables: unknown;
      }>`
        select
          c.commit_seq,
          c.actor_id,
          c.client_id,
          c.client_commit_id,
          c.created_at,
          c.change_count,
          c.affected_tables
        from ${sql.table('sync_commits')} as ${sql.ref('c')}
        where ${sql.join(whereClauses, sql` and `)}
        order by c.commit_seq desc
        limit ${limit + 1}
      `.execute(options.db);
      const rows = rowsResult.rows;

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? Number(rows[limit]?.commit_seq ?? 0) : null;

      return c.json(
        {
          ok: true,
          commits: selectedRows.map((row) => ({
            commitSeq: Number(row.commit_seq),
            actorId: row.actor_id,
            clientId: row.client_id,
            clientCommitId: row.client_commit_id,
            createdAt: row.created_at,
            changeCount: Number(row.change_count),
            affectedTables: options.dialect.dbToArray(row.affected_tables),
          })),
          nextCursor,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /audit/debug/export
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/debug/export',
    describeRoute({
      tags: ['sync'],
      summary: 'Export a redacted sync debug bundle',
      description:
        'Returns a size-bounded support bundle for the authenticated actor with visible redacted commit changes and own request events.',
      responses: {
        200: {
          description: 'Redacted sync debug export',
          content: {
            'application/json': {
              schema: resolver(auditDebugExportResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('query', auditDebugExportQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const { limitCommits, limitEvents, from, to } = c.req.valid('query');

      const commitWhereClauses = [sql`partition_id = ${partitionId}`];
      if (from) {
        commitWhereClauses.push(sql`created_at >= ${from}`);
      }
      if (to) {
        commitWhereClauses.push(sql`created_at <= ${to}`);
      }

      const [commitResult, requestEventResult] = await Promise.all([
        sql<{
          commit_seq: number | string;
          actor_id: string;
          client_id: string;
          client_commit_id: string;
          created_at: string;
          change_count: number | string;
          affected_tables: unknown;
        }>`
          select
            commit_seq,
            actor_id,
            client_id,
            client_commit_id,
            created_at,
            change_count,
            affected_tables
          from ${sql.table('sync_commits')}
          where ${sql.join(commitWhereClauses, sql` and `)}
          order by commit_seq desc
          limit ${limitCommits + 1}
        `.execute(options.db),
        readAuditDebugRequestEvents({
          auth,
          partitionId,
          limit: limitEvents,
          from,
          to,
        }),
      ]);

      const selectedCommitRows = commitResult.rows.slice(0, limitCommits);
      const commitSeqs = selectedCommitRows
        .map((row) => coerceNumber(row.commit_seq))
        .filter((seq): seq is number => seq !== null);
      const changesByCommitSeq = await readVisibleAuditChanges({
        auth,
        partitionId,
        commitSeqs,
      });
      const commits = selectedCommitRows.flatMap((row) => {
        const commitSeq = coerceNumber(row.commit_seq) ?? 0;
        const changes = changesByCommitSeq.get(commitSeq) ?? [];
        if (changes.length === 0) return [];
        return [
          {
            commitSeq,
            actorId: row.actor_id,
            clientId: row.client_id,
            clientCommitId: row.client_commit_id,
            createdAt: row.created_at,
            changeCount: coerceNumber(row.change_count) ?? 0,
            affectedTables: options.dialect.dbToArray(row.affected_tables),
            changes,
          },
        ];
      });

      return c.json(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          partitionId,
          limits: {
            commits: limitCommits,
            requestEvents: limitEvents,
          },
          truncated: {
            commits: commitResult.rows.length > limitCommits,
            requestEvents: requestEventResult.truncated,
          },
          commits,
          requestEvents: requestEventResult.events,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /audit/commits/:commitSeq
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/commits/:commitSeq',
    describeRoute({
      tags: ['sync'],
      summary: 'Read a sync commit with emitted changes',
      description:
        'Returns commit metadata and change rows for one commit within the authenticated partition.',
      responses: {
        200: {
          description: 'Commit audit detail',
          content: {
            'application/json': {
              schema: resolver(auditCommitDetailResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Commit not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', auditCommitParamsSchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const { commitSeq } = c.req.valid('param');

      const commitResult = await sql<{
        commit_seq: number;
        actor_id: string;
        client_id: string;
        client_commit_id: string;
        created_at: string;
        change_count: number;
        affected_tables: unknown;
      }>`
        select
          commit_seq,
          actor_id,
          client_id,
          client_commit_id,
          created_at,
          change_count,
          affected_tables
        from ${sql.table('sync_commits')}
        where partition_id = ${partitionId}
          and commit_seq = ${commitSeq}
        limit 1
      `.execute(options.db);

      const commit = commitResult.rows[0];
      if (!commit) {
        return syncError(c, 404, 'sync.not_found');
      }

      const changesByCommitSeq = await readVisibleAuditChanges({
        auth,
        partitionId,
        commitSeqs: [commitSeq],
      });
      const changes = changesByCommitSeq.get(commitSeq) ?? [];
      if (changes.length === 0) {
        return syncError(c, 404, 'sync.not_found');
      }

      return c.json(
        {
          ok: true,
          commit: {
            commitSeq: Number(commit.commit_seq),
            actorId: commit.actor_id,
            clientId: commit.client_id,
            clientCommitId: commit.client_commit_id,
            createdAt: commit.created_at,
            changeCount: Number(commit.change_count),
            affectedTables: options.dialect.dbToArray(commit.affected_tables),
          },
          changes,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // GET /audit/rows/:table/:rowId
  // -------------------------------------------------------------------------

  routes.get(
    '/audit/rows/:table/:rowId',
    describeRoute({
      tags: ['sync'],
      summary: 'Read scoped row audit history',
      description:
        'Returns redacted row-level audit history for one row within the authenticated partition and allowed scopes.',
      responses: {
        200: {
          description: 'Scoped row audit history',
          content: {
            'application/json': {
              schema: resolver(auditRowHistoryResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Row history not found in the authenticated scopes',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', auditRowHistoryParamsSchema),
    zValidator('query', auditRowHistoryQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');

      const partitionId = auth.partitionId ?? 'default';
      const { table, rowId } = c.req.valid('param');
      const query = c.req.valid('query');
      const limit = query.limit ?? 50;
      const handler = handlerRegistry.byTable.get(table);
      if (!handler) {
        return syncError(c, 404, 'sync.not_found');
      }

      let allowedScopes: ScopeValues;
      try {
        allowedScopes = await handler.resolveScopes({
          db: options.db,
          actorId: auth.actorId,
          auth,
        });
      } catch {
        return syncError(c, 404, 'sync.not_found');
      }

      const auditScopes = selectRequiredAuditScopes(
        handler.scopePatterns,
        allowedScopes
      );
      if (!auditScopes) {
        return syncError(c, 404, 'sync.not_found');
      }

      const rows = await options.dialect.readAuditRowHistory(options.db, {
        partitionId,
        table,
        rowId,
        scopes: auditScopes,
        limit,
        beforeCommitSeq: query.beforeCommitSeq,
        afterCommitSeq: query.afterCommitSeq,
      });
      if (rows.length === 0) {
        return syncError(c, 404, 'sync.not_found');
      }

      const hasMore = rows.length > limit;
      const selectedRows = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? Number(selectedRows[selectedRows.length - 1]?.commit_seq ?? 0)
        : null;

      return c.json(
        {
          ok: true,
          table,
          rowId,
          history: selectedRows.map((row) => {
            const summary = summarizeAuditChange({
              table: row.table,
              op: row.op,
              rowJson: row.row_json,
              scopes: row.scopes,
            });
            return {
              commitSeq: Number(row.commit_seq),
              actorId: row.actor_id,
              clientId: row.client_id,
              clientCommitId: row.client_commit_id,
              createdAt: row.created_at,
              changeId: Number(row.change_id),
              table: row.table,
              rowId: row.row_id,
              op: row.op,
              rowVersion:
                row.row_version === null ? null : Number(row.row_version),
              ...summary,
            };
          }),
          nextCursor,
        },
        200
      );
    }
  );

  // -------------------------------------------------------------------------
  // POST /  (combined push + pull in one round-trip)
  // -------------------------------------------------------------------------

  routes.post(
    '/',
    describeRoute({
      tags: ['sync'],
      summary: 'Combined push and pull',
      description:
        'Perform push and/or pull in a single request to reduce round-trips',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true },
          },
        },
      },
      responses: {
        200: {
          description: 'Combined sync response',
          content: {
            'application/json': {
              schema: resolver(SyncCombinedResponseSchema),
            },
            [SYNC_PACK_CONTENT_TYPE]: {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');
      const partitionId = auth.partitionId ?? 'default';
      const transportPath = readTransportPath(c);
      const combinedTimer = createSyncTimer();

      const bodyRead = await readLimitedSyncJsonBody(c);
      if (!bodyRead.ok) {
        if (bodyRead.failure) {
          await recordHttpCombinedReadFailure(c, bodyRead.failure);
        }
        return bodyRead.response;
      }
      const parsedBody = SyncCombinedRequestSchema.safeParse(bodyRead.value);
      if (!parsedBody.success) {
        return syncValidationError(c, 'json', parsedBody.error.issues);
      }
      const body = parsedBody.data;
      const clientId = body.clientId;
      const requestId = readRequestId(c);
      const traceContext = readTraceContext(c);
      const connectionOwnerKey = createWebSocketConnectionOwnerKey({
        partitionId,
        actorId: auth.actorId,
        clientId,
      });

      const clientState = await readClientState(
        options.db,
        partitionId,
        clientId
      );
      let allowStaleScopeRebind = false;
      if (
        body.pull &&
        !body.push &&
        clientState.ownerActorId !== null &&
        clientState.ownerActorId !== auth.actorId
      ) {
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db: options.db,
          auth,
          subscriptions: body.pull.subscriptions,
          handlers: handlerRegistry,
          scopeCache: options.scopeCache,
        });
        allowStaleScopeRebind = resolved.every(
          (subscription) => subscription.status === 'revoked'
        );
      }

      if (
        !allowStaleScopeRebind &&
        (clientState.hasConflict || clientState.ownerActorId !== null)
      ) {
        if (
          clientState.ownerActorId !== auth.actorId ||
          clientState.hasConflict
        ) {
          return syncError(
            c,
            400,
            'sync.invalid_client_id',
            clientState.hasConflict
              ? 'clientId has conflicting ownership history'
              : 'clientId is already bound to a different actor'
          );
        }
      }

      let pushResponse:
        | undefined
        | {
            ok: true;
            commits: Array<
              Awaited<ReturnType<typeof pushCommit>>['response'] & {
                clientCommitId: string;
              }
            >;
          };
      let pullResponse: undefined | PullResult['response'];
      let finalizePullSuccess: (() => Promise<void>) | undefined;
      let pullLimitEventDetails:
        | {
            rowCount: number | null;
            subscriptionCount: number;
            scopesSummary: Record<string, string | string[]> | null;
          }
        | undefined;
      const exposeBenchPullTimings =
        c.req.header('x-syncular-bench-timings') === '1';
      const requestedSyncPackEncodings =
        body.syncPackEncodings ?? body.pull?.syncPackEncodings;
      const shouldEncodeBinarySyncPack = prefersBinarySyncPack(
        requestedSyncPackEncodings
      );

      // --- Push phase ---
      if (body.push) {
        const pushBodies = body.push.commits ?? [];
        const pushedCommits: NonNullable<typeof pushResponse>['commits'] = [];
        for (const pushBody of pushBodies) {
          const pushOps = pushBody.operations ?? [];
          if (pushOps.length > maxOperationsPerPush) {
            return syncError(
              c,
              400,
              'sync.too_many_operations',
              `Maximum ${maxOperationsPerPush} operations per push`
            );
          }
        }
        const executedPushes =
          pushBodies.length > 1
            ? await executePushCommitBatchWithSideEffects(
                {
                  auth,
                  clientId,
                  partitionId,
                  requestId,
                  traceContext,
                  transportPath,
                  syncPath: 'http-combined',
                },
                pushBodies,
                {
                  countConflictsMetric: true,
                }
              )
            : [];

        for (let index = 0; index < pushBodies.length; index += 1) {
          const pushBody = pushBodies[index];
          if (!pushBody) continue;
          const pushed =
            pushBodies.length > 1
              ? executedPushes[index]
              : await executePushCommitWithSideEffects(
                  {
                    auth,
                    clientId,
                    partitionId,
                    requestId,
                    traceContext,
                    transportPath,
                    syncPath: 'http-combined',
                  },
                  pushBody,
                  {
                    countConflictsMetric: true,
                  }
                );
          if (!pushed) {
            throw new Error('Server returned incomplete batched push result');
          }
          pushedCommits.push({
            clientCommitId: pushBody.clientCommitId,
            ...pushed.response,
          });
        }

        pushResponse = {
          ok: true,
          commits: pushedCommits,
        };
      }

      // --- Pull phase ---
      if (body.pull) {
        if (body.pull.subscriptions.length > maxSubscriptionsPerPull) {
          return syncError(
            c,
            400,
            'sync.invalid_request',
            `Too many subscriptions (max ${maxSubscriptionsPerPull})`
          );
        }

        const seenSubscriptionIds = new Set<string>();
        for (const sub of body.pull.subscriptions) {
          const id = sub.id;
          if (seenSubscriptionIds.has(id)) {
            return syncError(
              c,
              400,
              'sync.invalid_request',
              `Duplicate subscription id: ${id}`
            );
          }
          seenSubscriptionIds.add(id);
        }

        const request = {
          clientId,
          limitCommits: clampInt(
            body.pull.limitCommits ?? 1000,
            1,
            maxPullLimitCommits
          ),
          limitSnapshotRows: clampInt(
            body.pull.limitSnapshotRows ?? 1000,
            1,
            maxPullLimitSnapshotRows
          ),
          maxSnapshotPages: clampInt(
            body.pull.maxSnapshotPages ?? 4,
            1,
            maxPullMaxSnapshotPages
          ),
          dedupeRows: body.pull.dedupeRows === true,
          snapshotEncodings: body.pull.snapshotEncodings,
          snapshotArtifacts: body.pull.snapshotArtifacts,
          syncPackEncodings: body.pull.syncPackEncodings,
          subscriptions: body.pull.subscriptions.map((sub) => ({
            id: sub.id,
            table: sub.table,
            scopes: (sub.scopes ?? {}) as Record<string, string | string[]>,
            params: sub.params as Record<string, unknown>,
            cursor: Math.max(-1, sub.cursor),
            bootstrapState: sub.bootstrapState ?? null,
            verifiedRoot: sub.verifiedRoot,
            crdtStateVectors: sub.crdtStateVectors,
          })),
        };

        const timer = createSyncTimer();

        let pullResult: PullResult;
        try {
          pullResult = await pull({
            db: options.db,
            dialect: options.dialect,
            handlers: handlerRegistry,
            auth,
            request,
            plugins: options.plugins,
            chunkStorage: options.chunkStorage,
            scopeCache: options.scopeCache,
            snapshotChunkGzipLevel: options.sync?.snapshotChunkGzipLevel,
            snapshotChunkCacheSchemaVersion:
              latestSchemaVersion ?? requiredSchemaVersion ?? null,
          });
        } catch (err) {
          if (err instanceof InvalidSubscriptionScopeError) {
            return syncError(c, 400, 'sync.invalid_subscription', err.message);
          }
          throw err;
        }

        const pullDurationMs = timer();
        const pullRowCount =
          shouldRecordRequestEvents || shouldEmitConsoleLiveEvents
            ? countPullRows(pullResult.response)
            : null;
        const scopesSummary = shouldRecordRequestEvents
          ? summarizeScopeValues(pullResult.effectiveScopes)
          : null;
        const responseSummary =
          shouldRecordRequestEvents || shouldEmitConsoleLiveEvents
            ? summarizePullResponseForRequestEvent(pullResult.response)
            : null;
        pullLimitEventDetails = {
          rowCount: pullRowCount,
          subscriptionCount: request.subscriptions.length,
          scopesSummary,
        };
        finalizePullSuccess = async () => {
          try {
            await recordClientCursor(options.db, options.dialect, {
              partitionId,
              clientId,
              actorId: auth.actorId,
              cursor: pullResult.clientCursor,
              effectiveScopes: pullResult.effectiveScopes,
            });
            emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
              action: 'cursor_recorded',
              partitionId,
              actorId: auth.actorId,
              clientId,
              cursor: pullResult.clientCursor,
            }));
          } catch (error) {
            logAsyncFailureOnce('sync.client_cursor_record_failed', {
              event: 'sync.client_cursor_record_failed',
              userId: auth.actorId,
              clientId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          wsConnectionManager?.updateConnectionSubscriptions(
            connectionOwnerKey,
            buildRealtimeSubscriptionsForPull({
              partitionId,
              requestSubscriptions: request.subscriptions,
              responseSubscriptions: pullResult.response.subscriptions,
            })
          );

          logSyncEvent({
            event: 'sync.pull',
            userId: auth.actorId,
            durationMs: pullDurationMs,
            subscriptionCount: pullResult.response.subscriptions.length,
            clientCursor: pullResult.clientCursor,
          });

          recordRequestEventInBackground(() => {
            const payloadSnapshot = shouldCaptureRequestPayloadSnapshots
              ? {
                  request: {
                    clientId,
                    limitCommits: request.limitCommits,
                    limitSnapshotRows: request.limitSnapshotRows,
                    maxSnapshotPages: request.maxSnapshotPages,
                    dedupeRows: request.dedupeRows,
                    subscriptions: request.subscriptions.map(
                      (subscription) => ({
                        id: subscription.id,
                        table: subscription.table,
                        scopes: subscription.scopes,
                        cursor: subscription.cursor,
                        bootstrapState: subscription.bootstrapState,
                      })
                    ),
                  },
                  response: summarizePullResponse(pullResult.response),
                }
              : null;

            return {
              partitionId,
              requestId,
              traceId: traceContext.traceId,
              spanId: traceContext.spanId,
              eventType: 'pull',
              syncPath: 'http-combined',
              actorId: auth.actorId,
              clientId,
              transportPath,
              statusCode: 200,
              outcome: 'applied',
              responseStatus: normalizeResponseStatus(200, 'applied'),
              durationMs: pullDurationMs,
              rowCount: pullRowCount,
              subscriptionCount: request.subscriptions.length,
              scopesSummary,
              responseSummary,
              payloadSnapshot,
            };
          });
          emitConsoleLiveEvent(consoleLiveEmitter, 'pull', () => ({
            partitionId,
            requestId,
            traceId: traceContext.traceId,
            spanId: traceContext.spanId,
            actorId: auth.actorId,
            clientId,
            transportPath,
            syncPath: 'http-combined',
            outcome: 'applied',
            statusCode: 200,
            durationMs: pullDurationMs,
            rowCount: pullRowCount,
            subscriptionCount: request.subscriptions.length,
            responseSummary,
            clientCursor: pullResult.clientCursor,
          }));

          if (exposeBenchPullTimings && pullResult.bootstrapTimings) {
            c.header(
              'x-syncular-bench-pull-timings',
              JSON.stringify(pullResult.bootstrapTimings)
            );
          }
        };

        pullResponse = pullResult.response;
      }

      const combinedResponse: SyncCombinedResponse = {
        ok: true as const,
        ...(requiredSchemaVersion ? { requiredSchemaVersion } : {}),
        ...(latestSchemaVersion ? { latestSchemaVersion } : {}),
        ...(pushResponse ? { push: pushResponse } : {}),
        ...(pullResponse ? { pull: pullResponse } : {}),
      };
      const recordResponseLimitFailure = (args: {
        limit: string;
        observed: number;
        max: number;
      }): void => {
        recordHttpCombinedFailure({
          partitionId,
          requestId,
          traceContext,
          actorId: auth.actorId,
          clientId,
          transportPath,
          eventType: body.pull ? 'pull' : 'push',
          statusCode: 413,
          outcome: 'rejected',
          durationMs: combinedTimer(),
          errorCode: 'runtime.limit_exceeded',
          errorMessage: `${args.limit} exceeded (${args.observed} > ${args.max} bytes)`,
          operationCount:
            body.push?.commits.reduce(
              (count, commit) => count + (commit.operations?.length ?? 0),
              0
            ) ?? null,
          rowCount: pullLimitEventDetails?.rowCount ?? null,
          subscriptionCount: pullLimitEventDetails?.subscriptionCount ?? null,
          scopesSummary: pullLimitEventDetails?.scopesSummary ?? null,
        });
      };

      if (shouldEncodeBinarySyncPack) {
        const encoded = encodeBinarySyncPack(combinedResponse, {
          changeRowEncoders: binarySyncPackChangeRowEncoders,
        });
        const limitResponse = responseBodyOverLimit(c, {
          limit: 'maxSyncBinaryPackBytes',
          observed: encoded.byteLength,
          max: maxSyncBinaryPackBytes,
        });
        if (limitResponse) {
          recordResponseLimitFailure({
            limit: 'maxSyncBinaryPackBytes',
            observed: encoded.byteLength,
            max: maxSyncBinaryPackBytes,
          });
          return limitResponse;
        }
        if (finalizePullSuccess) {
          await finalizePullSuccess();
        }
        triggerAutoMaintenance({
          actorId: auth.actorId,
          clientId,
          partitionId,
        });
        const body = encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength
        ) as ArrayBuffer;
        c.header('content-type', SYNC_PACK_CONTENT_TYPE);
        return c.body(body, 200);
      }

      const jsonResponse = JSON.stringify(combinedResponse);
      const jsonResponseBytes = byteLengthUtf8(jsonResponse);
      const limitResponse = responseBodyOverLimit(c, {
        limit: 'maxSyncResponseJsonBytes',
        observed: jsonResponseBytes,
        max: maxSyncResponseJsonBytes,
      });
      if (limitResponse) {
        recordResponseLimitFailure({
          limit: 'maxSyncResponseJsonBytes',
          observed: jsonResponseBytes,
          max: maxSyncResponseJsonBytes,
        });
        return limitResponse;
      }
      if (finalizePullSuccess) {
        await finalizePullSuccess();
      }
      triggerAutoMaintenance({
        actorId: auth.actorId,
        clientId,
        partitionId,
      });

      c.header('content-type', 'application/json');
      return c.body(jsonResponse, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /snapshot-chunks/:chunkId
  // -------------------------------------------------------------------------

  routes.get(
    '/snapshot-chunks/:chunkId',
    describeRoute({
      tags: ['sync'],
      summary: 'Download snapshot chunk',
      description: 'Download an encoded bootstrap snapshot chunk',
      responses: {
        200: {
          description: 'Snapshot chunk data (gzip-compressed framed JSON rows)',
          content: {
            'application/octet-stream': {
              schema: resolver(z.string()),
            },
          },
        },
        304: {
          description: 'Not modified (cached)',
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        403: {
          description: 'Forbidden',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', snapshotChunkParamsSchema),
    zValidator('query', snapshotChunkQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');
      const partitionId = auth.partitionId ?? 'default';
      const query = c.req.valid('query');
      const requestedChunkScopes = readSnapshotScopeValues(c, query.scopes);

      const { chunkId } = c.req.valid('param');

      const chunk = await readSnapshotChunk(options.db, chunkId, {
        chunkStorage: options.chunkStorage,
      });
      if (!chunk) return syncError(c, 404, 'sync.not_found');
      if (chunk.partitionId !== partitionId) {
        return syncError(c, 403, 'sync.forbidden');
      }

      const nowIso = new Date().toISOString();
      if (chunk.expiresAt <= nowIso) {
        return syncError(c, 404, 'sync.not_found');
      }

      if (!requestedChunkScopes) {
        return syncError(
          c,
          400,
          'sync.invalid_request',
          'Snapshot chunk scope values are required'
        );
      }

      try {
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db: options.db,
          auth,
          subscriptions: [
            {
              id: 'snapshot-chunk-authz',
              table: chunk.scope,
              scopes: requestedChunkScopes,
              cursor: 0,
              crdtStateVectors: [],
            },
          ],
          handlers: handlerRegistry,
          scopeCache: options.scopeCache,
        });
        const scopeAuth = resolved[0];
        if (!scopeAuth || scopeAuth.status !== 'active') {
          return syncError(c, 403, 'sync.forbidden');
        }

        const scopeHash = await scopesToSnapshotChunkScopeKey(scopeAuth.scopes);
        const scopedChunkKeyMatches =
          chunk.scopeKey.startsWith('snapshot-v2:') &&
          chunk.scopeKey.endsWith(`:scope:${scopeHash}`);
        if (!scopedChunkKeyMatches) {
          return syncError(c, 403, 'sync.forbidden');
        }
      } catch (error) {
        if (error instanceof InvalidSubscriptionScopeError) {
          return syncError(c, 403, 'sync.forbidden');
        }
        throw error;
      }

      const etag = `"sha256:${chunk.sha256}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=0',
            Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          },
        });
      }

      const limitResponse = responseBodyOverLimit(c, {
        limit: 'maxSnapshotChunkResponseBytes',
        observed: chunk.byteLength,
        max: maxSnapshotChunkResponseBytes,
      });
      if (limitResponse) return limitResponse;

      return new Response(chunk.body as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.byteLength),
          ETag: etag,
          'Cache-Control': 'private, max-age=0',
          Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          'X-Sync-Chunk-Id': chunk.chunkId,
          'X-Sync-Chunk-Sha256': chunk.sha256,
          'X-Sync-Chunk-Encoding': chunk.encoding,
          'X-Sync-Chunk-Compression': chunk.compression,
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /snapshot-artifacts/:artifactId
  // -------------------------------------------------------------------------

  routes.get(
    '/snapshot-artifacts/:artifactId',
    describeRoute({
      tags: ['sync'],
      summary: 'Download scoped snapshot artifact',
      description: 'Download a verified, scoped bootstrap snapshot artifact',
      responses: {
        200: {
          description: 'Scoped snapshot artifact bytes',
          content: {
            'application/octet-stream': {
              schema: resolver(z.string()),
            },
          },
        },
        304: {
          description: 'Not modified (cached)',
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        403: {
          description: 'Forbidden',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', snapshotArtifactParamsSchema),
    zValidator('query', snapshotChunkQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');
      const artifactStorage = options.snapshotArtifactStorage;
      if (!artifactStorage) return syncError(c, 404, 'sync.not_found');

      const partitionId = auth.partitionId ?? 'default';
      const query = c.req.valid('query');
      const requestedArtifactScopes = readSnapshotScopeValues(c, query.scopes);
      const { artifactId } = c.req.valid('param');

      const artifact = await readScopedSnapshotArtifact(options.db, artifactId);
      if (!artifact) return syncError(c, 404, 'sync.not_found');
      if (artifact.partitionId !== partitionId) {
        return syncError(c, 403, 'sync.forbidden');
      }

      const nowIso = new Date().toISOString();
      if (artifact.expiresAt <= nowIso) {
        return syncError(c, 404, 'sync.not_found');
      }

      if (!requestedArtifactScopes) {
        return syncError(
          c,
          400,
          'sync.invalid_request',
          'Snapshot artifact scope values are required'
        );
      }

      try {
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db: options.db,
          auth,
          subscriptions: [
            {
              id: artifact.subscriptionId,
              table: artifact.table,
              scopes: requestedArtifactScopes,
              cursor: 0,
              crdtStateVectors: [],
            },
          ],
          handlers: handlerRegistry,
          scopeCache: options.scopeCache,
        });
        const scopeAuth = resolved[0];
        if (!scopeAuth || scopeAuth.status !== 'active') {
          return syncError(c, 403, 'sync.forbidden');
        }

        const scopeHash = await scopesToSnapshotChunkScopeKey(scopeAuth.scopes);
        const scopedArtifactKeyMatches =
          artifact.scopeKey.startsWith('snapshot-artifact-v1:') &&
          artifact.scopeKey.endsWith(`:scope:${scopeHash}`);
        if (!scopedArtifactKeyMatches) {
          return syncError(c, 403, 'sync.forbidden');
        }
      } catch (error) {
        if (error instanceof InvalidSubscriptionScopeError) {
          return syncError(c, 403, 'sync.forbidden');
        }
        throw error;
      }

      const etag = `"sha256:${artifact.sha256}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=0',
            Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          },
        });
      }

      const limitResponse = responseBodyOverLimit(c, {
        limit: 'maxSnapshotArtifactResponseBytes',
        observed: artifact.byteLength,
        max: maxSnapshotArtifactResponseBytes,
      });
      if (limitResponse) return limitResponse;

      let body: Uint8Array | ReadableStream<Uint8Array> | null = null;
      if (artifactStorage.readArtifactStream) {
        body = await artifactStorage.readArtifactStream(artifact);
      }
      body ??= await artifactStorage.readArtifact(artifact);
      if (!body) return syncError(c, 404, 'sync.not_found');

      return new Response(body as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(artifact.byteLength),
          ETag: etag,
          'Cache-Control': 'private, max-age=0',
          Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          'X-Sync-Artifact-Id': artifact.artifactId,
          'X-Sync-Artifact-Sha256': artifact.sha256,
          'X-Sync-Artifact-Kind': artifact.artifactKind,
          'X-Sync-Artifact-Compression': artifact.compression,
          'X-Sync-Artifact-Manifest-Digest': artifact.manifestDigest,
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /realtime (optional WebSocket wake-ups)
  // -------------------------------------------------------------------------

  if (wsConnectionManager && websocketConfig?.enabled) {
    routes.get('/realtime', async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');
      if (!isWebSocketOriginAllowed(c, websocketConfig.allowedOrigins)) {
        const origin = readOriginHeader(c);
        if (origin && corsConfig) {
          return createSyncCorsOriginDeniedResponse(origin);
        }
        return syncError(
          c,
          403,
          'sync.forbidden',
          'Forbidden websocket origin'
        );
      }
      const partitionId = auth.partitionId ?? 'default';

      const clientId = c.req.query('clientId');
      if (!clientId || typeof clientId !== 'string') {
        return syncError(
          c,
          400,
          'sync.invalid_request',
          'clientId query param is required'
        );
      }
      const realtimeTransportPath = readTransportPath(
        c,
        c.req.query('transportPath')
      );
      const syncPackEncoding =
        c.req.query('syncPackEncoding') === SYNC_PACK_ENCODING_BINARY_V1
          ? SYNC_PACK_ENCODING_BINARY_V1
          : null;
      const connectionOwnerKey = createWebSocketConnectionOwnerKey({
        partitionId,
        actorId: auth.actorId,
        clientId,
      });

      // Load last-known effective scopes for this client (best-effort).
      // Keeps /realtime lightweight and avoids sending large subscription payloads over the URL.
      let initialScopeKeys: string[] = [];
      let lastAckedCursor = -1;
      let latestCommitSeq = 0;
      try {
        const clientState = await readClientState(
          options.db,
          partitionId,
          clientId
        );
        if (clientState.hasConflict || clientState.ownerActorId !== null) {
          if (
            clientState.ownerActorId !== auth.actorId ||
            clientState.hasConflict
          ) {
            return syncError(
              c,
              400,
              'sync.invalid_client_id',
              clientState.hasConflict
                ? 'clientId has conflicting ownership history'
                : 'clientId is already bound to a different actor'
            );
          }
        }

        const raw = clientState.effectiveScopes;
        let parsed: unknown = raw;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
        }

        initialScopeKeys = applyPartitionToScopeKeys(
          partitionId,
          scopeValuesToScopeKeys(parsed)
        );
        lastAckedCursor = clientState.cursor ?? -1;
        latestCommitSeq = clientState.latestCommitSeq;
      } catch {
        // ignore; realtime is best-effort
      }

      const maxConnectionsTotal = websocketConfig.maxConnectionsTotal ?? 5000;
      const maxConnectionsPerClient =
        websocketConfig.maxConnectionsPerClient ?? 3;
      const maxMessageBytes = websocketConfig.maxMessageBytes ?? 1024 * 1024;
      const maxMessagesPerWindow = websocketConfig.maxMessagesPerWindow ?? 120;
      const messageRateWindowMs = websocketConfig.messageRateWindowMs ?? 10000;
      let messageRateWindowStartedAtMs = Date.now();
      let messageRateWindowCount = 0;

      if (
        maxConnectionsTotal > 0 &&
        wsConnectionManager.getTotalConnections() >= maxConnectionsTotal
      ) {
        logSyncEvent({
          event: 'sync.realtime.rejected',
          userId: auth.actorId,
          reason: 'max_total',
        });
        return syncError(c, 429, 'sync.websocket_connection_limit');
      }

      if (
        maxConnectionsPerClient > 0 &&
        wsConnectionManager.getScopedConnectionCount(connectionOwnerKey) >=
          maxConnectionsPerClient
      ) {
        logSyncEvent({
          event: 'sync.realtime.rejected',
          userId: auth.actorId,
          reason: 'max_per_client',
        });
        return syncError(c, 429, 'sync.websocket_connection_limit');
      }

      logSyncEvent({ event: 'sync.realtime.connect', userId: auth.actorId });

      let unregister: (() => void) | null = null;
      let connRef: ReturnType<typeof createWebSocketConnection> | null = null;
      const connectionCountBeforeUpgrade =
        wsConnectionManager.getScopedConnectionCount(connectionOwnerKey);
      let sessionStartedAtMs: number | null = null;
      let sessionEnded = false;

      const finishRealtimeSession = (reason: 'closed' | 'error') => {
        if (sessionEnded) return;
        sessionEnded = true;
        if (sessionStartedAtMs === null) {
          return;
        }
        const durationMs = Math.max(0, Date.now() - sessionStartedAtMs);
        countSyncMetric('sync.sessions.ended', 1, {
          attributes: {
            transportPath: realtimeTransportPath,
            reason,
          },
        });
        distributionSyncMetric('sync.sessions.duration_ms', durationMs, {
          unit: 'millisecond',
          attributes: {
            transportPath: realtimeTransportPath,
            reason,
          },
        });
      };

      const teardownRealtimeConnection = (args: {
        reason: 'closed' | 'error';
        action: 'realtime_disconnected' | 'realtime_error';
      }) => {
        unregister?.();
        unregister = null;
        connRef = null;
        finishRealtimeSession(args.reason);
        logSyncEvent({
          event: 'sync.realtime.disconnect',
          userId: auth.actorId,
        });
        emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
          action: args.action,
          actorId: auth.actorId,
          clientId,
          partitionId,
        }));
      };

      const logPresenceRejected = (scopeKey: string) => {
        logSyncEvent({
          event: 'sync.realtime.presence.rejected',
          userId: auth.actorId,
          reason: 'scope_not_authorized',
          scopeKey,
        });
      };

      const upgradeWebSocket = websocketConfig.upgradeWebSocket;
      if (!upgradeWebSocket) {
        return syncError(c, 500, 'sync.websocket_not_configured');
      }

      return upgradeWebSocket(c, {
        onOpen(_evt, ws) {
          const requiresInitialSync =
            initialScopeKeys.length > 0 && latestCommitSeq > lastAckedCursor;
          const shardKey = createSyncRealtimeShardKey({ partitionId });
          const conn = createWebSocketConnection(ws, {
            actorId: auth.actorId,
            clientId,
            ownerKey: connectionOwnerKey,
            transportPath: realtimeTransportPath,
            syncPackEncoding,
          });
          connRef = conn;
          sessionStartedAtMs = Date.now();
          countSyncMetric('sync.sessions.started', 1, {
            attributes: {
              transportPath: realtimeTransportPath,
            },
          });
          if (connectionCountBeforeUpgrade > 0) {
            countSyncMetric('sync.transport.reconnects', 1, {
              attributes: {
                transportPath: realtimeTransportPath,
                source: 'server',
              },
            });
          }

          unregister = wsConnectionManager.register(conn, initialScopeKeys);
          conn.sendHello({
            protocolVersion: 1,
            sessionId: createRealtimeSessionId(),
            shardKey,
            actorId: auth.actorId,
            clientId,
            transportPath: realtimeTransportPath,
            syncPackEncoding,
            cursor: lastAckedCursor,
            latestCursor: latestCommitSeq,
            scopeCount: initialScopeKeys.length,
            requiresSync: requiresInitialSync,
          });
          conn.sendHeartbeat();
          if (requiresInitialSync) {
            const replayed = wsConnectionManager.replayScopeKeys(
              conn,
              initialScopeKeys,
              lastAckedCursor,
              latestCommitSeq
            );
            if (!replayed) {
              conn.sendSync(latestCommitSeq, {
                reason: 'reconnect-catchup',
                requiresPull: true,
              });
            }
          }
          emitConsoleLiveEvent(consoleLiveEmitter, 'client_update', () => ({
            action: 'realtime_connected',
            actorId: auth.actorId,
            clientId,
            partitionId,
            transportPath: realtimeTransportPath,
            scopeCount: initialScopeKeys.length,
          }));
        },
        onClose(_evt, _ws) {
          teardownRealtimeConnection({
            reason: 'closed',
            action: 'realtime_disconnected',
          });
        },
        onError(_evt, _ws) {
          teardownRealtimeConnection({
            reason: 'error',
            action: 'realtime_error',
          });
        },
        onMessage(evt, _ws) {
          if (!connRef) return;
          try {
            const messageBytes = measureWebSocketMessageBytes(evt.data);
            if (messageBytes > maxMessageBytes) {
              connRef.sendError(
                `WebSocket message exceeds max size (${maxMessageBytes} bytes)`
              );
              return;
            }
            if (maxMessagesPerWindow > 0 && messageRateWindowMs > 0) {
              const nowMs = Date.now();
              if (nowMs - messageRateWindowStartedAtMs >= messageRateWindowMs) {
                messageRateWindowStartedAtMs = nowMs;
                messageRateWindowCount = 0;
              }
              messageRateWindowCount += 1;
              if (messageRateWindowCount > maxMessagesPerWindow) {
                connRef.sendError(
                  `WebSocket message rate exceeded (${maxMessagesPerWindow}/${messageRateWindowMs}ms)`
                );
                return;
              }
            }
            const raw =
              typeof evt.data === 'string' ? evt.data : String(evt.data);
            const msg = JSON.parse(raw);
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'ack') {
              const cursor =
                typeof msg.cursor === 'number' &&
                Number.isSafeInteger(msg.cursor)
                  ? msg.cursor
                  : null;
              if (cursor !== null && cursor > lastAckedCursor) {
                lastAckedCursor = cursor;
                wsConnectionManager.recordAck(connRef, cursor);
                void recordRealtimeAck({
                  db: options.db,
                  actorId: auth.actorId,
                  clientId,
                  cursor,
                  partitionId,
                }).catch((error) => {
                  logAsyncFailureOnce('sync.realtime.ack_record_failed', {
                    event: 'sync.realtime.ack_record_failed',
                    userId: auth.actorId,
                    clientId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                });
              }
              return;
            }

            if (msg.type === 'push') {
              void handleWsPush(msg, connRef, auth, clientId);
              return;
            }

            if (msg.type !== 'presence' || !msg.scopeKey) return;

            const scopeKey = normalizeScopeKeyForPartition(
              partitionId,
              String(msg.scopeKey)
            );
            if (!scopeKey) return;

            switch (msg.action) {
              case 'join':
                if (
                  !wsConnectionManager.joinPresence(
                    connectionOwnerKey,
                    scopeKey,
                    msg.metadata
                  )
                ) {
                  logPresenceRejected(scopeKey);
                  return;
                }
                // Send presence snapshot back to the joining client
                {
                  const entries = wsConnectionManager.getPresence(scopeKey);
                  connRef.sendPresence({
                    action: 'snapshot',
                    scopeKey,
                    entries,
                  });
                }
                break;
              case 'leave':
                wsConnectionManager.leavePresence(connectionOwnerKey, scopeKey);
                break;
              case 'update':
                if (
                  !wsConnectionManager.updatePresenceMetadata(
                    connectionOwnerKey,
                    scopeKey,
                    msg.metadata ?? {}
                  ) &&
                  !wsConnectionManager.isConnectionSubscribedToScopeKey(
                    connectionOwnerKey,
                    scopeKey
                  )
                ) {
                  logPresenceRejected(scopeKey);
                }
                break;
            }
          } catch {
            // Ignore malformed messages
          }
        },
      });
    });
  }

  async function handleRealtimeEvent(event: SyncRealtimeEvent): Promise<void> {
    if (!wsConnectionManager) return;
    if (event.type !== 'commit') return;
    if (event.sourceInstanceId && event.sourceInstanceId === instanceId) return;

    const commitSeq = event.commitSeq;
    const partitionId = event.partitionId ?? 'default';
    const scopeKeys =
      event.scopeKeys && event.scopeKeys.length > 0
        ? event.scopeKeys
        : await readCommitScopeKeys(options.db, commitSeq, partitionId);

    if (scopeKeys.length === 0) return;
    wsConnectionManager.notifyScopeKeys(scopeKeys, commitSeq);
  }

  const recordWsPushFailure = (args: {
    partitionId: string;
    requestId: string;
    traceContext: TraceContext;
    actorId: string;
    clientId: string;
    transportPath: 'direct' | 'relay';
    statusCode: number;
    outcome: 'rejected' | 'error';
    durationMs: number;
    errorCode: string;
    errorMessage: string;
    operationCount?: number | null;
    payloadSnapshot?: RequestPayloadSnapshot | null;
  }): void => {
    recordRequestEventInBackground(() => ({
      partitionId: args.partitionId,
      requestId: args.requestId,
      traceId: args.traceContext.traceId,
      spanId: args.traceContext.spanId,
      eventType: 'push',
      syncPath: 'ws-push',
      actorId: args.actorId,
      clientId: args.clientId,
      transportPath: args.transportPath,
      statusCode: args.statusCode,
      outcome: args.outcome,
      responseStatus: normalizeResponseStatus(args.statusCode, args.outcome),
      durationMs: args.durationMs,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      operationCount: args.operationCount ?? null,
      payloadSnapshot: args.payloadSnapshot ?? null,
    }));

    emitConsoleLiveEvent(consoleLiveEmitter, 'push', () => ({
      partitionId: args.partitionId,
      requestId: args.requestId,
      traceId: args.traceContext.traceId,
      spanId: args.traceContext.spanId,
      actorId: args.actorId,
      clientId: args.clientId,
      transportPath: args.transportPath,
      syncPath: 'ws-push',
      outcome: args.outcome,
      statusCode: args.statusCode,
      durationMs: args.durationMs,
      operationCount: args.operationCount ?? null,
      errorCode: args.errorCode,
    }));
  };

  async function handleWsPush(
    msg: Record<string, unknown>,
    conn: WebSocketConnection,
    auth: Auth,
    clientId: string
  ): Promise<void> {
    const actorId = auth.actorId;
    const partitionId = auth.partitionId ?? 'default';
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    if (!requestId) return;
    const traceContext = readTraceContextFromMessage(msg);
    const timer = createSyncTimer();

    try {
      // Validate the push payload
      const parsed = SyncPushRequestSchema.omit({ clientId: true }).safeParse(
        msg
      );
      if (!parsed.success) {
        const invalidDurationMs = timer();
        const errorMessage = 'Invalid push payload';
        conn.sendPushResponse({
          requestId,
          ok: false,
          status: 'rejected',
          results: [{ opIndex: 0, status: 'error', error: errorMessage }],
        });
        recordWsPushFailure({
          partitionId,
          requestId,
          actorId,
          clientId,
          transportPath: conn.transportPath,
          statusCode: 400,
          outcome: 'rejected',
          durationMs: invalidDurationMs,
          errorCode: 'INVALID_PUSH_PAYLOAD',
          errorMessage,
          traceContext,
          payloadSnapshot: shouldCaptureRequestPayloadSnapshots
            ? {
                request: msg,
                response: {
                  ok: false,
                  status: 'rejected',
                  reason: 'invalid_push_payload',
                },
              }
            : null,
        });
        return;
      }

      const pushOps = parsed.data.operations ?? [];
      if (pushOps.length > maxOperationsPerPush) {
        const rejectedDurationMs = timer();
        const errorMessage = `Maximum ${maxOperationsPerPush} operations per push`;
        conn.sendPushResponse({
          requestId,
          ok: false,
          status: 'rejected',
          results: [
            {
              opIndex: 0,
              status: 'error',
              error: errorMessage,
            },
          ],
        });
        recordWsPushFailure({
          partitionId,
          requestId,
          actorId,
          clientId,
          transportPath: conn.transportPath,
          statusCode: 400,
          outcome: 'rejected',
          durationMs: rejectedDurationMs,
          errorCode: 'MAX_OPERATIONS_EXCEEDED',
          errorMessage,
          traceContext,
          operationCount: pushOps.length,
          payloadSnapshot: shouldCaptureRequestPayloadSnapshots
            ? {
                request: {
                  clientId,
                  clientCommitId: parsed.data.clientCommitId,
                  schemaVersion: parsed.data.schemaVersion,
                  authLease: parsed.data.authLease,
                  operations: parsed.data.operations,
                },
                response: {
                  ok: false,
                  status: 'rejected',
                  reason: 'max_operations_exceeded',
                },
              }
            : null,
        });
        return;
      }

      const pushed = await executePushCommitWithSideEffects(
        {
          auth,
          clientId,
          partitionId,
          requestId,
          traceContext,
          transportPath: conn.transportPath,
          syncPath: 'ws-push',
        },
        {
          clientCommitId: parsed.data.clientCommitId,
          operations: parsed.data.operations,
          schemaVersion: parsed.data.schemaVersion,
          authLease: parsed.data.authLease,
        },
        { countConflictsMetric: true }
      );

      triggerAutoMaintenance({
        actorId,
        clientId,
        partitionId,
      });

      conn.sendPushResponse({
        requestId,
        ok: pushed.response.ok,
        status: pushed.response.status,
        commitSeq: pushed.response.commitSeq,
        results: pushed.response.results,
      });
    } catch (err) {
      const failedDurationMs = timer();
      captureSyncException(err, {
        event: 'sync.realtime.push_failed',
        requestId,
        clientId,
        actorId,
        partitionId,
      });
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      recordWsPushFailure({
        partitionId,
        requestId,
        actorId,
        clientId,
        transportPath: conn.transportPath,
        statusCode: 500,
        outcome: 'error',
        durationMs: failedDurationMs,
        errorCode: 'INTERNAL_SERVER_ERROR',
        errorMessage: message,
        traceContext,
        payloadSnapshot: shouldCaptureRequestPayloadSnapshots
          ? {
              request: msg,
              response: {
                ok: false,
                status: 'rejected',
                reason: 'internal_server_error',
                message,
              },
            }
          : null,
      });
      conn.sendPushResponse({
        requestId,
        ok: false,
        status: 'rejected',
        results: [{ opIndex: 0, status: 'error', error: message }],
      });
    }
  }

  return routes;
}

export function getSyncWebSocketConnectionManager(
  routes: Hono
): WebSocketConnectionManager | undefined {
  return wsConnectionManagerMap.get(routes);
}

export function getSyncRealtimeUnsubscribe(
  routes: Hono
): (() => void) | undefined {
  return realtimeUnsubscribeMap.get(routes);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function measureWebSocketMessageBytes(data: unknown): number {
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

function readTransportPath(
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

function scopeValuesToScopeKeys(scopes: unknown): string[] {
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

function selectRequiredAuditScopes(
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

function parseStoredAuditScopes(value: unknown): StoredScopes {
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

function applyPartitionToScopeKeys(
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

function normalizeScopeKeyForPartition(
  partitionId: string,
  scopeKey: string
): string {
  if (scopeKey.startsWith(`${partitionId}::`)) return scopeKey;
  if (scopeKey.includes('::')) return '';
  return partitionScopeKey(partitionId, scopeKey);
}

async function readCommitScopeKeys<DB extends SyncCoreDb>(
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

async function readClientState<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  partitionId: string,
  clientId: string
): Promise<{
  ownerActorId: string | null;
  effectiveScopes: unknown;
  cursor: number | null;
  latestCommitSeq: number;
  hasConflict: boolean;
}> {
  const [cursorResult, latestClientCommitResult, latestCommitResult] =
    await Promise.all([
      sql<{
        actor_id: string | null;
        effective_scopes: unknown;
        cursor: number | string | null;
      }>`
      SELECT actor_id, effective_scopes, cursor
      FROM sync_client_cursors
      WHERE partition_id = ${partitionId} AND client_id = ${clientId}
      LIMIT 1
    `.execute(db),
      sql<{ actor_id: string | null }>`
      SELECT actor_id
      FROM sync_commits
      WHERE partition_id = ${partitionId} AND client_id = ${clientId}
      ORDER BY commit_seq DESC
      LIMIT 1
    `.execute(db),
      sql<{ latest_commit_seq: number | string | null }>`
      SELECT COALESCE(MAX(commit_seq), 0) AS latest_commit_seq
      FROM sync_commits
      WHERE partition_id = ${partitionId}
    `.execute(db),
    ]);
  const cursorRow = cursorResult.rows[0];
  const latestClientCommitRow = latestClientCommitResult.rows[0];
  const latestCommitRow = latestCommitResult.rows[0];

  // Cursor state reflects the current authenticated owner for a clientId.
  // Commit history is only used to seed ownership before the first pull.
  const ownerActorId =
    cursorRow?.actor_id ?? latestClientCommitRow?.actor_id ?? null;
  const cursor =
    cursorRow?.cursor === null || cursorRow?.cursor === undefined
      ? null
      : Number(cursorRow.cursor);
  const latestCommitSeq =
    latestCommitRow?.latest_commit_seq === null ||
    latestCommitRow?.latest_commit_seq === undefined
      ? 0
      : Number(latestCommitRow.latest_commit_seq);

  return {
    ownerActorId,
    effectiveScopes: cursorRow?.effective_scopes ?? null,
    cursor: Number.isFinite(cursor) ? cursor : null,
    latestCommitSeq: Number.isFinite(latestCommitSeq) ? latestCommitSeq : 0,
    hasConflict: false,
  };
}

async function recordRealtimeAck<DB extends SyncCoreDb>(args: {
  db: Kysely<DB>;
  partitionId: string;
  actorId: string;
  clientId: string;
  cursor: number;
}): Promise<void> {
  const now = new Date().toISOString();
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
      updated_at = ${now}
    WHERE partition_id = ${args.partitionId}
      AND client_id = ${args.clientId}
      AND actor_id = ${args.actorId}
  `.execute(args.db);
}
