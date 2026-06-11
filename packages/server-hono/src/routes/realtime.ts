/**
 * GET /realtime (optional WebSocket deltas and recovery wake-ups), including
 * the websocket push pipeline (ws-push) helpers.
 */

import {
  captureSyncException,
  countSyncMetric,
  createSyncTimer,
  distributionSyncMetric,
  logSyncEvent,
  SYNC_PACK_ENCODING_BINARY_V1,
  SyncPushRequestSchema,
} from '@syncular/core';
import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import { createSyncRealtimeShardKey } from '@syncular/server';
import { syncError } from '../errors';
import { isWebSocketOriginAllowed } from '../websocket-origin';
import {
  createRealtimeSessionId,
  createWebSocketConnection,
  createWebSocketConnectionOwnerKey,
  type WebSocketConnection,
  type WebSocketRealtimeSubscription,
} from '../ws';
import type { SyncRoutesContext } from './context';
import {
  applyPartitionToScopeKeys,
  createSyncCorsOriginDeniedResponse,
  emitConsoleLiveEvent,
  measureWebSocketMessageBytes,
  normalizeResponseStatus,
  normalizeScopeKeyForPartition,
  parsePersistedRealtimeSubscriptions,
  type RequestPayloadSnapshot,
  readClientState,
  readOriginHeader,
  readTraceContextFromMessage,
  readTransportPath,
  recordRealtimeAck,
  type SyncAuthResult,
  scopeValuesToScopeKeys,
  type TraceContext,
  uniqueScopeKeys,
} from './shared';

export function registerRealtimeRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(ctx: SyncRoutesContext<DB, Auth, F>): void {
  const {
    routes,
    getAuth,
    options,
    websocketConfig,
    corsConfig,
    wsConnectionManager,
    consoleLiveEmitter,
    recordRealtimeEventInBackground,
    recordRequestEventInBackground,
    serializeRealtimeSubscriptions,
    logAsyncFailureOnce,
    maxOperationsPerPush,
    executePushCommitWithSideEffects,
    triggerAutoMaintenance,
    shouldCaptureRequestPayloadSnapshots,
  } = ctx;

  // -------------------------------------------------------------------------
  // GET /realtime (optional WebSocket deltas and recovery wake-ups)
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
      let initialRealtimeSubscriptions: WebSocketRealtimeSubscription[] = [];
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
        initialRealtimeSubscriptions = parsePersistedRealtimeSubscriptions(
          clientState.realtimeSubscriptions,
          partitionId
        );
        if (initialRealtimeSubscriptions.length > 0) {
          initialScopeKeys = uniqueScopeKeys(
            initialRealtimeSubscriptions.flatMap(
              (subscription) => subscription.scopeKeys
            )
          );
        }
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
        recordRealtimeEventInBackground({
          partitionId,
          actorId: auth.actorId,
          clientId,
          transportPath: realtimeTransportPath,
          eventType: 'rejected',
          reason: 'max_total',
          cursor: lastAckedCursor,
          latestCursor: latestCommitSeq,
          scopeCount: initialScopeKeys.length,
          syncPackEncoding,
        });
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
        recordRealtimeEventInBackground({
          partitionId,
          actorId: auth.actorId,
          clientId,
          transportPath: realtimeTransportPath,
          eventType: 'rejected',
          reason: 'max_per_client',
          cursor: lastAckedCursor,
          latestCursor: latestCommitSeq,
          scopeCount: initialScopeKeys.length,
          syncPackEncoding,
        });
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
        recordRealtimeEventInBackground({
          partitionId,
          actorId: auth.actorId,
          clientId,
          transportPath: realtimeTransportPath,
          eventType: args.reason === 'closed' ? 'disconnected' : 'error',
          reason: args.reason,
          cursor: lastAckedCursor,
          latestCursor: latestCommitSeq,
          scopeCount: initialScopeKeys.length,
          syncPackEncoding,
        });
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
          if (initialRealtimeSubscriptions.length > 0) {
            wsConnectionManager.updateConnectionSubscriptions(
              connectionOwnerKey,
              initialRealtimeSubscriptions
            );
          }
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
          recordRealtimeEventInBackground({
            partitionId,
            actorId: auth.actorId,
            clientId,
            transportPath: realtimeTransportPath,
            eventType: 'connected',
            reason: requiresInitialSync ? 'requires_sync' : null,
            cursor: lastAckedCursor,
            latestCursor: latestCommitSeq,
            scopeCount: initialScopeKeys.length,
            syncPackEncoding,
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
              recordRealtimeEventInBackground({
                partitionId,
                actorId: auth.actorId,
                clientId,
                transportPath: realtimeTransportPath,
                eventType: 'pull_required',
                reason: 'reconnect-catchup',
                cursor: lastAckedCursor,
                latestCursor: latestCommitSeq,
                commitSeq: latestCommitSeq,
                scopeCount: initialScopeKeys.length,
                syncPackEncoding,
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
              recordRealtimeEventInBackground({
                partitionId,
                actorId: auth.actorId,
                clientId,
                transportPath: realtimeTransportPath,
                eventType: 'error',
                reason: 'message_too_large',
                cursor: lastAckedCursor,
                latestCursor: latestCommitSeq,
                scopeCount: initialScopeKeys.length,
                syncPackEncoding,
              });
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
                recordRealtimeEventInBackground({
                  partitionId,
                  actorId: auth.actorId,
                  clientId,
                  transportPath: realtimeTransportPath,
                  eventType: 'error',
                  reason: 'message_rate_exceeded',
                  cursor: lastAckedCursor,
                  latestCursor: latestCommitSeq,
                  scopeCount: initialScopeKeys.length,
                  syncPackEncoding,
                });
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
                recordRealtimeEventInBackground({
                  partitionId,
                  actorId: auth.actorId,
                  clientId,
                  transportPath: realtimeTransportPath,
                  eventType: 'ack',
                  reason: null,
                  cursor,
                  latestCursor: latestCommitSeq,
                  scopeCount: initialScopeKeys.length,
                  syncPackEncoding,
                });
                void recordRealtimeAck({
                  db: options.db,
                  dialect: options.dialect,
                  actorId: auth.actorId,
                  clientId,
                  cursor,
                  partitionId,
                  realtimeSubscriptions: serializeRealtimeSubscriptions(
                    wsConnectionManager.getConnectionSubscriptions(
                      connectionOwnerKey
                    )
                  ),
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
}
