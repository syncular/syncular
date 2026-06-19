/**
 * @syncular/server/hono - Console request event and live event routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import {
  createSyncularErrorResponse,
  ErrorResponseSchema,
  logSyncEvent,
} from '@syncular/core';
import { coerceNumber, parseJsonValue } from '@syncular/server';
import type { Context } from 'hono';
import { resolver } from 'hono-openapi';
import { consoleValidator as zValidator } from '../../validation';
import { isWebSocketOriginAllowed } from '../../websocket-origin';
import {
  closeUnauthenticatedSocket,
  parseWebSocketAuthToken,
} from '../live-auth';
import { describeConsoleRoute } from '../route-descriptor';
import {
  type ConsoleClearEventsResult,
  ConsoleClearEventsResultSchema,
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
  type ConsolePruneEventsResult,
  ConsolePruneEventsResultSchema,
  type ConsoleRequestEvent,
  ConsoleRequestEventSchema,
  type ConsoleRequestPayload,
  ConsoleRequestPayloadSchema,
} from '../schemas';
import type { ConsoleEventListener } from '../types';
import type { ConsoleRoutesContext } from './context';
import {
  consoleNotFound,
  eventDetailQuerySchema,
  eventIdParamSchema,
  eventsQuerySchema,
  measureWebSocketMessageBytes,
} from './shared';

export function registerEventRoutes(ctx: ConsoleRoutesContext): void {
  const {
    routes,
    options,
    db,
    requestEventSelectColumns,
    mapRequestEvent,
    deleteUnreferencedPayloadSnapshots,
    runEventsPrune,
  } = ctx;

  // -------------------------------------------------------------------------
  // GET /events - Paginated request events list
  // -------------------------------------------------------------------------

  routes.get(
    '/events',
    describeConsoleRoute({
      summary: 'List request events',
      responses: {
        200: {
          description: 'Paginated event list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleRequestEventSchema)
              ),
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
    zValidator('query', eventsQuerySchema),
    async (c) => {
      const {
        limit,
        offset,
        partitionId,
        eventType,
        actorId,
        clientId,
        requestId,
        traceId,
        syncAttemptId,
        outcome,
      } = c.req.valid('query');
      const resolvedTraceId = traceId ?? syncAttemptId;

      let query = db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns);

      let countQuery = db
        .selectFrom('sync_request_events')
        .select(({ fn }) => fn.countAll().as('total'));

      if (partitionId) {
        query = query.where('partition_id', '=', partitionId);
        countQuery = countQuery.where('partition_id', '=', partitionId);
      }
      if (eventType) {
        query = query.where('event_type', '=', eventType);
        countQuery = countQuery.where('event_type', '=', eventType);
      }
      if (actorId) {
        query = query.where('actor_id', '=', actorId);
        countQuery = countQuery.where('actor_id', '=', actorId);
      }
      if (clientId) {
        query = query.where('client_id', '=', clientId);
        countQuery = countQuery.where('client_id', '=', clientId);
      }
      if (requestId) {
        query = query.where('request_id', '=', requestId);
        countQuery = countQuery.where('request_id', '=', requestId);
      }
      if (resolvedTraceId) {
        query = query.where('trace_id', '=', resolvedTraceId);
        countQuery = countQuery.where('trace_id', '=', resolvedTraceId);
      }
      if (outcome) {
        query = query.where('outcome', '=', outcome);
        countQuery = countQuery.where('outcome', '=', outcome);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items: ConsoleRequestEvent[] = rows.map((row) =>
        mapRequestEvent(row)
      );

      const total = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleRequestEvent> = {
        items,
        total,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(total));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /events/live - WebSocket for live activity feed
  // NOTE: Must be defined BEFORE /events/:id to avoid route conflict
  // -------------------------------------------------------------------------

  if (
    options.eventEmitter &&
    options.websocket?.enabled &&
    options.websocket?.upgradeWebSocket
  ) {
    const emitter = options.eventEmitter;
    const upgradeWebSocket = options.websocket.upgradeWebSocket;
    const heartbeatIntervalMs = options.websocket.heartbeatIntervalMs ?? 30000;
    const maxMessageBytes = options.websocket.maxMessageBytes ?? 1024 * 1024;
    const maxMessagesPerWindow = options.websocket.maxMessagesPerWindow ?? 120;
    const messageRateWindowMs = options.websocket.messageRateWindowMs ?? 10000;

    type WebSocketLike = {
      send: (data: string) => void;
      close: (code?: number, reason?: string) => void;
    };

    const wsState = new WeakMap<
      WebSocketLike,
      {
        listener: ConsoleEventListener | null;
        heartbeatInterval: ReturnType<typeof setInterval> | null;
        authTimeout: ReturnType<typeof setTimeout> | null;
        isAuthenticated: boolean;
        startAuthenticatedSession: (() => void) | null;
        messageRateWindowStart: number;
        messageRateWindowCount: number;
      }
    >();

    const cleanup = (ws: WebSocketLike) => {
      const state = wsState.get(ws);
      if (!state) return;
      if (state.listener) {
        emitter.removeListener(state.listener);
      }
      if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
      }
      if (state.authTimeout) {
        clearTimeout(state.authTimeout);
      }
      wsState.delete(ws);
    };

    const liveEventsWebSocketRoute = upgradeWebSocket(async (c) => {
      const authHeader = c.req.header('Authorization');
      const partitionId = c.req.query('partitionId')?.trim() || undefined;
      const replaySince = c.req.query('since');
      const replayLimitRaw = c.req.query('replayLimit');
      const replayLimitNumber = replayLimitRaw
        ? Number.parseInt(replayLimitRaw, 10)
        : Number.NaN;
      const replayLimit = Number.isFinite(replayLimitNumber)
        ? Math.max(1, Math.min(500, replayLimitNumber))
        : 100;
      const mockContext = {
        req: {
          header: (name: string) =>
            name === 'Authorization' ? authHeader : undefined,
          query: () => undefined,
        },
      } as unknown as Context;

      const initialAuth = await options.authenticate(mockContext);

      const authenticateWithBearer = async (token: string) => {
        const trimmedToken = token.trim();
        if (!trimmedToken) return null;
        const authContext = {
          req: {
            header: (name: string) =>
              name === 'Authorization' ? `Bearer ${trimmedToken}` : undefined,
            query: () => undefined,
          },
        } as unknown as Context;
        return options.authenticate(authContext);
      };

      return {
        onOpen(_event, ws) {
          const state: {
            listener: ConsoleEventListener | null;
            heartbeatInterval: ReturnType<typeof setInterval> | null;
            authTimeout: ReturnType<typeof setTimeout> | null;
            isAuthenticated: boolean;
            startAuthenticatedSession: (() => void) | null;
            messageRateWindowStart: number;
            messageRateWindowCount: number;
          } = {
            listener: null,
            heartbeatInterval: null,
            authTimeout: null,
            isAuthenticated: false,
            startAuthenticatedSession: null,
            messageRateWindowStart: Date.now(),
            messageRateWindowCount: 0,
          };
          wsState.set(ws, state);

          const startAuthenticatedSession = () => {
            if (state.isAuthenticated) return;
            state.isAuthenticated = true;
            if (state.authTimeout) {
              clearTimeout(state.authTimeout);
              state.authTimeout = null;
            }

            const listener: ConsoleEventListener = (event) => {
              if (partitionId) {
                const eventPartitionId = event.data.partitionId;
                if (
                  typeof eventPartitionId !== 'string' ||
                  eventPartitionId !== partitionId
                ) {
                  return;
                }
              }
              try {
                ws.send(JSON.stringify(event));
              } catch {
                // Connection closed
              }
            };

            emitter.addListener(listener);
            state.listener = listener;

            ws.send(
              JSON.stringify({
                type: 'connected',
                timestamp: new Date().toISOString(),
              })
            );

            const replayEvents = emitter.replay({
              since: replaySince,
              limit: replayLimit,
              partitionId,
            });
            for (const replayEvent of replayEvents) {
              try {
                ws.send(JSON.stringify(replayEvent));
              } catch {
                // Connection closed
                break;
              }
            }

            const heartbeatInterval = setInterval(() => {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'heartbeat',
                    timestamp: new Date().toISOString(),
                  })
                );
              } catch {
                clearInterval(heartbeatInterval);
              }
            }, heartbeatIntervalMs);
            state.heartbeatInterval = heartbeatInterval;
          };
          state.startAuthenticatedSession = startAuthenticatedSession;

          if (initialAuth) {
            startAuthenticatedSession();
            return;
          }

          state.authTimeout = setTimeout(() => {
            const current = wsState.get(ws);
            if (!current || current.isAuthenticated) {
              return;
            }
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
          }, 5_000);
        },
        async onMessage(event, ws) {
          const state = wsState.get(ws);
          if (!state) {
            return;
          }

          const messageBytes = measureWebSocketMessageBytes(event.data);
          if (messageBytes > maxMessageBytes) {
            ws.close(1009, 'message too large');
            cleanup(ws);
            return;
          }

          if (maxMessagesPerWindow > 0 && messageRateWindowMs > 0) {
            const nowMs = Date.now();
            if (nowMs - state.messageRateWindowStart >= messageRateWindowMs) {
              state.messageRateWindowStart = nowMs;
              state.messageRateWindowCount = 0;
            }
            state.messageRateWindowCount += 1;
            if (state.messageRateWindowCount > maxMessagesPerWindow) {
              ws.close(1008, 'message rate exceeded');
              cleanup(ws);
              return;
            }
          }

          if (state.isAuthenticated) {
            return;
          }

          if (typeof event.data !== 'string') {
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
            return;
          }

          const token = parseWebSocketAuthToken(event.data);

          if (!token) {
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
            return;
          }

          const auth = await authenticateWithBearer(token);
          const currentState = wsState.get(ws);
          if (!currentState || currentState.isAuthenticated) {
            return;
          }
          if (!auth) {
            closeUnauthenticatedSocket(ws);
            cleanup(ws);
            return;
          }
          currentState.startAuthenticatedSession?.();
        },
        onClose(_event, ws) {
          cleanup(ws);
        },
        onError(_event, ws) {
          cleanup(ws);
        },
      };
    });

    routes.get('/events/live', async (c, next) => {
      if (!isWebSocketOriginAllowed(c, options.websocket?.allowedOrigins)) {
        return c.json(
          createSyncularErrorResponse('console.forbidden_origin'),
          403
        );
      }
      return liveEventsWebSocketRoute(c, next);
    });
  }

  // -------------------------------------------------------------------------
  // GET /events/:id - Single event detail
  // -------------------------------------------------------------------------

  routes.get(
    '/events/:id',
    describeConsoleRoute({
      summary: 'Get event details',
      responses: {
        200: {
          description: 'Event details',
          content: {
            'application/json': {
              schema: resolver(ConsoleRequestEventSchema),
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
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', eventIdParamSchema),
    zValidator('query', eventDetailQuerySchema),
    async (c) => {
      const { id: eventId } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let eventQuery = db
        .selectFrom('sync_request_events')
        .select(requestEventSelectColumns)
        .where('event_id', '=', eventId);

      if (partitionId) {
        eventQuery = eventQuery.where('partition_id', '=', partitionId);
      }

      const row = await eventQuery.executeTakeFirst();

      if (!row) {
        return consoleNotFound(c);
      }

      return c.json(mapRequestEvent(row), 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /events/:id/payload - payload snapshot detail (if retained)
  // -------------------------------------------------------------------------

  routes.get(
    '/events/:id/payload',
    describeConsoleRoute({
      summary: 'Get event payload snapshot',
      responses: {
        200: {
          description: 'Payload snapshot details',
          content: {
            'application/json': {
              schema: resolver(ConsoleRequestPayloadSchema),
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
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', eventIdParamSchema),
    zValidator('query', eventDetailQuerySchema),
    async (c) => {
      const { id: eventId } = c.req.valid('param');
      const { partitionId } = c.req.valid('query');

      let eventQuery = db
        .selectFrom('sync_request_events')
        .select(['payload_ref', 'partition_id'])
        .where('event_id', '=', eventId);

      if (partitionId) {
        eventQuery = eventQuery.where('partition_id', '=', partitionId);
      }

      const eventRow = await eventQuery.executeTakeFirst();

      if (!eventRow) {
        return consoleNotFound(c);
      }

      const payloadRef = eventRow.payload_ref;
      if (!payloadRef) {
        return consoleNotFound(c, 'No payload snapshot recorded');
      }

      const payloadRow = await db
        .selectFrom('sync_request_payloads')
        .select([
          'payload_ref',
          'partition_id',
          'request_payload',
          'response_payload',
          'created_at',
        ])
        .where('payload_ref', '=', payloadRef)
        .where('partition_id', '=', eventRow.partition_id)
        .executeTakeFirst();

      if (!payloadRow) {
        return consoleNotFound(c, 'Payload snapshot not available');
      }

      const payload: ConsoleRequestPayload = {
        payloadRef: payloadRow.payload_ref,
        partitionId: payloadRow.partition_id,
        requestPayload: parseJsonValue(payloadRow.request_payload),
        responsePayload: parseJsonValue(payloadRow.response_payload),
        createdAt: payloadRow.created_at,
      };

      return c.json(payload, 200);
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /events - Clear all events
  // -------------------------------------------------------------------------

  routes.delete(
    '/events',
    describeConsoleRoute({
      summary: 'Clear all events',
      responses: {
        200: {
          description: 'Clear result',
          content: {
            'application/json': {
              schema: resolver(ConsoleClearEventsResultSchema),
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
    async (c) => {
      const res = await db.deleteFrom('sync_request_events').executeTakeFirst();

      const deletedCount = Number(res?.numDeletedRows ?? 0);
      const payloadDeletedCount = await deleteUnreferencedPayloadSnapshots();

      logSyncEvent({
        event: 'console.clear_events',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedCount,
        payloadDeletedCount,
      });

      const result: ConsoleClearEventsResult = { deletedCount };
      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /events/prune - Prune old events
  // -------------------------------------------------------------------------

  routes.post(
    '/events/prune',
    describeConsoleRoute({
      summary: 'Prune old events',
      responses: {
        200: {
          description: 'Prune result',
          content: {
            'application/json': {
              schema: resolver(ConsolePruneEventsResultSchema),
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
    async (c) => {
      const pruneResult = await runEventsPrune();
      const deletedCount = pruneResult.totalDeleted;

      logSyncEvent({
        event: 'console.prune_events',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        deletedCount,
        requestEventsDeleted: pruneResult.requestEventsDeleted,
        operationEventsDeleted: pruneResult.operationEventsDeleted,
        realtimeEventsDeleted: pruneResult.realtimeEventsDeleted,
        payloadDeletedCount: pruneResult.payloadSnapshotsDeleted,
      });

      const result: ConsolePruneEventsResult = {
        deletedCount,
        requestEventsDeleted: pruneResult.requestEventsDeleted,
        operationEventsDeleted: pruneResult.operationEventsDeleted,
        realtimeEventsDeleted: pruneResult.realtimeEventsDeleted,
        payloadDeletedCount: pruneResult.payloadSnapshotsDeleted,
      };
      return c.json(result, 200);
    }
  );
}
