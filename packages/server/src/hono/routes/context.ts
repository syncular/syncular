/**
 * Shared per-instance context for the sync route modules.
 *
 * createSyncRoutesContext() contains the entire setup block of the former
 * monolithic createSyncRoutes() factory (Hono app creation, CORS + rate-limit
 * middleware, handler registry, websocket manager, realtime broadcaster
 * bridge, console request-event recording, and the shared push/pull
 * execution pipeline). Route modules destructure what they need from the
 * returned context object.
 */

import {
  captureSyncException,
  collectScopeVars,
  countSyncMetric,
  createSyncTimer,
  logSyncEvent,
  type ScopeValues,
  SYNC_AUTH_LEASE_CODE_INVALID,
  SYNC_AUTH_LEASE_CODE_MISSING,
  type SyncCommit,
  type SyncPullSubscriptionResponse,
  type SyncPushCommitRequestSchema,
  type SyncPushResponse,
} from '@syncular/core';
import type {
  SqlFamily,
  SyncCoreDb,
  SyncRealtimeEvent,
} from '@syncular/server';
import {
  coerceNumber,
  createServerHandlerCollection,
  createSyncRealtimeShardKey,
  maybeCompactChanges,
  maybePruneSync,
  type PushCommitValidator,
  pushCommit,
  pushCommitBatch,
  rowScopesAllowed,
  validateAuthLeaseOperation,
  verifyAuthLeaseToken,
} from '@syncular/server';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { z } from 'zod';
import { summarizeAuditChange } from '../audit-redaction';
import { isBenignConsoleSchemaError } from '../console/schema-errors';
import { syncError, syncLimitExceeded } from '../errors';
import {
  createRateLimiter,
  DEFAULT_SYNC_RATE_LIMITS,
  type SyncRateLimitConfig,
} from '../rate-limit';
import { notifyWebSocketConnectionsWithSyncPacks } from '../realtime-sync-packs';
import {
  WebSocketConnectionManager,
  type WebSocketRealtimeSubscription,
} from '../ws';
import {
  type AuditChangeResponse,
  type AuditDebugExportEvent,
  applyPartitionToScopeKeys,
  applySyncCorsHeaders,
  type CreateSyncRoutesOptions,
  createOpaqueId,
  createSyncCorsOriginDeniedResponse,
  DEFAULT_MAX_SNAPSHOT_ARTIFACT_RESPONSE_BYTES,
  DEFAULT_MAX_SNAPSHOT_CHUNK_RESPONSE_BYTES,
  DEFAULT_MAX_SYNC_BINARY_PACK_BYTES,
  DEFAULT_MAX_SYNC_REQUEST_JSON_BYTES,
  DEFAULT_REQUEST_PAYLOAD_SNAPSHOT_MAX_BYTES,
  emitConsoleLiveEvent,
  encodePayloadSnapshot,
  firstPushErrorCode,
  isAuthLeaseRefreshRetriable,
  isMissingRequestEventsTableError,
  isSyncJsonBodyLimitError,
  normalizeRequestEventType,
  normalizeResponseStatus,
  normalizeSyncCorsConfig,
  parseScopesSummary,
  parseStoredAuditScopes,
  type RequestPayloadSnapshot,
  readClientIdHint,
  readCommitScopeKeys,
  readOptionalPositiveInteger,
  readOriginHeader,
  readPositiveInteger,
  readRequestBodyBytesWithLimit,
  readRequestContentLength,
  readRequestId,
  readTraceContext,
  readTransportPath,
  realtimeUnsubscribeMap,
  type SyncAuthResult,
  scopeValuesToScopeKeys,
  selectRequiredAuditScopes,
  syncValidationError,
  type TraceContext,
  wsConnectionManagerMap,
} from './shared';

export function createSyncRoutesContext<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(options: CreateSyncRoutesOptions<DB, Auth, F>) {
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
        maxSyncPackBytes: websocketConfig.maxSyncPackBytes,
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

  type RealtimeConsoleEvent = {
    partitionId: string;
    actorId: string;
    clientId: string;
    transportPath: 'direct' | 'relay';
    eventType:
      | 'connected'
      | 'disconnected'
      | 'error'
      | 'pull_required'
      | 'ack'
      | 'rejected';
    reason?: string | null;
    cursor?: number | null;
    latestCursor?: number | null;
    commitSeq?: number | null;
    scopeCount?: number | null;
    skippedCount?: number | null;
    syncPackEncoding?: string | null;
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

  const recordRealtimeEvent = async (
    event: RealtimeConsoleEvent
  ): Promise<void> => {
    await sql`
      INSERT INTO sync_realtime_events (
        partition_id, actor_id, client_id, transport_path, event_type, reason,
        cursor, latest_cursor, commit_seq, scope_count, skipped_count,
        sync_pack_encoding
      ) VALUES (
        ${event.partitionId}, ${event.actorId}, ${event.clientId},
        ${event.transportPath}, ${event.eventType}, ${event.reason ?? null},
        ${event.cursor ?? null}, ${event.latestCursor ?? null},
        ${event.commitSeq ?? null}, ${event.scopeCount ?? null},
        ${event.skippedCount ?? null}, ${event.syncPackEncoding ?? null}
      )
    `.execute(options.db);
  };

  const recordRealtimeEventInBackground = (
    event: RealtimeConsoleEvent | (() => RealtimeConsoleEvent)
  ): void => {
    if (!shouldRecordRequestEvents) return;

    const resolvedEvent = typeof event === 'function' ? event() : event;

    void consoleSchemaReady
      .then(() => recordRealtimeEvent(resolvedEvent))
      .catch((error) => {
        logAsyncFailureOnce('sync.realtime_event_record_failed', {
          event: 'sync.realtime_event_record_failed',
          userId: resolvedEvent.actorId,
          clientId: resolvedEvent.clientId,
          realtimeEventType: resolvedEvent.eventType,
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
    if (wsConnectionManager) {
      await notifyWebSocketConnectionsWithSyncPacks({
        manager: wsConnectionManager,
        partitionId: ctx.partitionId,
        scopeKeys: combinedScopeKeys,
        cursor: latestCommitSeq,
        commits: emittedCommits,
        changeRowEncoders: binarySyncPackChangeRowEncoders,
        excludeClientIds: [ctx.clientId],
        onPackUnavailable: (event) => {
          logSyncEvent({
            event: 'sync.realtime.binary_pack_unavailable',
            userId: ctx.auth.actorId,
            clientId: ctx.clientId,
            reason: event.reason,
            subscriptionCount: event.subscriptionCount,
            emittedCommitCount: event.emittedCommitCount,
          });
        },
        onPackEncodeFailed: (event) => {
          logAsyncFailureOnce('sync.realtime.binary_pack_encode_failed', {
            event: 'sync.realtime.binary_pack_encode_failed',
            userId: ctx.auth.actorId,
            clientId: ctx.clientId,
            error:
              event.error instanceof Error
                ? event.error.message
                : String(event.error),
          });
        },
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

  function serializeRealtimeSubscriptions(
    subscriptions: readonly WebSocketRealtimeSubscription[]
  ): unknown[] {
    return subscriptions.map((subscription) => ({
      id: subscription.id,
      table: subscription.table,
      scopes: subscription.scopes,
      cursor: subscription.cursor,
      verifiedRoot: subscription.verifiedRoot ?? null,
    }));
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
      limitConfig:
        | Exclude<SyncRateLimitConfig['pull'], false | undefined>
        | false
        | undefined,
      operationType: 'pull' | 'push'
    ) => {
      if (limitConfig === false || !limitConfig) return null;
      const { details, ...rateLimiterConfig } = limitConfig;
      return createRateLimiter({
        ...rateLimiterConfig,
        keyGenerator: async (c) => {
          const auth = await getAuth(c);
          return auth?.actorId ?? null;
        },
        details: async (c, context) => ({
          ...(details ? await details(c, context) : {}),
          actorId: context.key,
          operationType,
        }),
      });
    };

    const pullLimiter = createAuthBasedRateLimiter(pullRateLimit, 'pull');
    const pushLimiter = createAuthBasedRateLimiter(pushRateLimit, 'push');

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

  return {
    routes,
    config,
    options,
    authLeaseRoutesConfig,
    corsConfig,
    handlerRegistry,
    binarySyncPackChangeRowEncoders,
    maxPullLimitCommits,
    maxSubscriptionsPerPull,
    maxPullLimitSnapshotRows,
    maxPullMaxSnapshotPages,
    maxOperationsPerPush,
    maxSyncRequestJsonBytes,
    maxSyncBinaryPackBytes,
    maxSnapshotChunkResponseBytes,
    maxSnapshotArtifactResponseBytes,
    requiredSchemaVersion,
    latestSchemaVersion,
    consoleLiveEmitter,
    shouldEmitConsoleLiveEvents,
    shouldRecordRequestEvents,
    shouldCaptureRequestPayloadSnapshots,
    getAuth,
    createAuditScopeResolver,
    readVisibleAuditChanges,
    readAuditDebugRequestEvents,
    validateAuthLeaseCommit,
    readLimitedSyncJsonBody,
    websocketConfig,
    wsConnectionManager,
    realtimeBroadcaster,
    instanceId,
    logAsyncFailureOnce,
    triggerAutoMaintenance,
    recordRequestEventInBackground,
    recordRealtimeEventInBackground,
    recordHttpCombinedFailure,
    recordHttpCombinedReadFailure,
    notifyRealtimeForAppliedPushes,
    buildRealtimeSubscriptionsForPull,
    serializeRealtimeSubscriptions,
    recordPushExecutionSideEffects,
    maybeCountPushConflicts,
    emitCommitLiveEvents,
    executePushCommitBatchWithSideEffects,
    executePushCommitWithSideEffects,
  };
}

export type SyncRoutesContext<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
> = ReturnType<typeof createSyncRoutesContext<DB, Auth, F>>;
