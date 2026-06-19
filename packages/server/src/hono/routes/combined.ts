/**
 * POST /  (combined push + pull in one round-trip)
 */

import {
  createSyncTimer,
  ErrorResponseSchema,
  encodeBinarySyncPack,
  logSyncEvent,
  SYNC_PACK_CONTENT_TYPE,
  SyncCombinedRequestSchema,
  type SyncCombinedResponse,
  SyncCombinedResponseSchema,
} from '@syncular/core';
import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import {
  InvalidSubscriptionScopeError,
  type PullResult,
  pull,
  type pushCommit,
  recordClientCursor,
  resolveEffectiveScopesForSubscriptions,
  SyncClientSchemaUnsupportedError,
} from '@syncular/server';
import { describeRoute, resolver } from 'hono-openapi';
import { syncError } from '../errors';
import { createWebSocketConnectionOwnerKey } from '../ws';
import type { SyncRoutesContext } from './context';
import {
  clampInt,
  countPullRows,
  emitConsoleLiveEvent,
  normalizeResponseStatus,
  readClientState,
  readRequestId,
  readTraceContext,
  readTransportPath,
  responseBodyOverLimit,
  type SyncAuthResult,
  summarizePullResponse,
  summarizePullResponseForRequestEvent,
  summarizeScopeValues,
  syncValidationError,
} from './shared';

export function registerCombinedSyncRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(ctx: SyncRoutesContext<DB, Auth, F>): void {
  const {
    routes,
    getAuth,
    options,
    handlerRegistry,
    readLimitedSyncJsonBody,
    recordHttpCombinedReadFailure,
    recordHttpCombinedFailure,
    recordRequestEventInBackground,
    executePushCommitBatchWithSideEffects,
    executePushCommitWithSideEffects,
    buildRealtimeSubscriptionsForPull,
    serializeRealtimeSubscriptions,
    consoleLiveEmitter,
    shouldRecordRequestEvents,
    shouldEmitConsoleLiveEvents,
    shouldCaptureRequestPayloadSnapshots,
    logAsyncFailureOnce,
    wsConnectionManager,
    triggerAutoMaintenance,
    binarySyncPackChangeRowEncoders,
    maxOperationsPerPush,
    maxSubscriptionsPerPull,
    maxPullLimitCommits,
    maxPullLimitSnapshotRows,
    maxPullMaxSnapshotPages,
    maxSyncBinaryPackBytes,
    requiredSchemaVersion,
    latestSchemaVersion,
  } = ctx;

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
          schemaVersion: body.pull.schemaVersion,
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
          snapshotArtifacts: body.pull.snapshotArtifacts,
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
          if (err instanceof SyncClientSchemaUnsupportedError) {
            return syncError(
              c,
              409,
              'sync.client_schema_unsupported',
              err.message
            );
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
        const realtimeSubscriptions = buildRealtimeSubscriptionsForPull({
          partitionId,
          requestSubscriptions: request.subscriptions,
          responseSubscriptions: pullResult.response.subscriptions,
        });
        finalizePullSuccess = async () => {
          try {
            await recordClientCursor(options.db, options.dialect, {
              partitionId,
              clientId,
              actorId: auth.actorId,
              cursor: pullResult.clientCursor,
              effectiveScopes: pullResult.effectiveScopes,
              realtimeSubscriptions: serializeRealtimeSubscriptions(
                realtimeSubscriptions
              ),
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
            realtimeSubscriptions
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

      const responseBody = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      ) as ArrayBuffer;
      c.header('content-type', SYNC_PACK_CONTENT_TYPE);
      return c.body(responseBody, 200);
    }
  );
}
