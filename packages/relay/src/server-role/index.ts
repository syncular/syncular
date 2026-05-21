/**
 * @syncular/relay - Server Role
 *
 * Hono routes for serving local clients.
 */

import type { SyncPullRequest, SyncPushRequest } from '@syncular/core';
import {
  createSyncTimer,
  createSyncularErrorResponse,
  isRecord,
  logSyncEvent,
  ScopeValuesSchema,
  SyncBootstrapStateSchema,
  SyncPullRequestSchema,
  SyncPushRequestSchema,
} from '@syncular/core';
import type {
  ServerHandlerCollection,
  ServerSyncDialect,
  SyncServerAuth,
} from '@syncular/server';
import { recordClientCursor } from '@syncular/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { RelayRealtime } from '../realtime';
import type { RelayDatabase } from '../schema';
import { relayPull } from './pull';
import { relayPushCommit } from './push';

type RelayAuth = SyncServerAuth;

/**
 * Options for creating relay routes.
 */
export interface CreateRelayRoutesOptions<
  DB extends RelayDatabase = RelayDatabase,
> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  handlers: ServerHandlerCollection<DB, RelayAuth>;
  realtime: RelayRealtime;
  /**
   * Called after a commit is successfully applied locally.
   * Use this to trigger forwarding and notify local clients.
   */
  onCommit?: (
    localCommitSeq: number,
    affectedTables: string[]
  ) => Promise<void>;
  /**
   * Optional: authenticate requests. Return actor ID or null for unauthorized.
   * If not provided, all requests are allowed with actor ID 'anonymous'.
   */
  authenticate?: (c: Context) => Promise<{ actorId: string } | null>;
  /**
   * Max operations per pushed commit (default: 200).
   */
  maxOperationsPerPush?: number;
  /**
   * Max subscriptions per pull request (default: 200).
   */
  maxSubscriptionsPerPull?: number;
  /**
   * Max commits per pull request (default: 100).
   */
  maxPullLimitCommits?: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function relayError(
  c: Context,
  status: 400 | 401,
  code:
    | 'sync.auth_required'
    | 'sync.invalid_request'
    | 'sync.too_many_operations',
  message?: string,
  details?: Record<string, unknown>
): Response {
  return c.json(
    createSyncularErrorResponse(code, {
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    }),
    status
  );
}

function invalidRelayRequest(
  c: Context,
  message: string,
  details?: Record<string, unknown>
): Response {
  return relayError(c, 400, 'sync.invalid_request', message, details);
}

/**
 * Create Hono routes for relay server-role endpoints.
 *
 * Provides:
 * - POST /pull (commit stream + optional bootstrap snapshots)
 * - POST /push (commit ingestion)
 * - GET /realtime (WebSocket wake-up notifications)
 */
export function createRelayRoutes<DB extends RelayDatabase = RelayDatabase>(
  options: CreateRelayRoutesOptions<DB>
): Hono {
  const routes = new Hono();
  const maxOperationsPerPush = options.maxOperationsPerPush ?? 200;
  const maxSubscriptionsPerPull = options.maxSubscriptionsPerPull ?? 200;
  const maxPullLimitCommits = options.maxPullLimitCommits ?? 100;

  const authenticate =
    options.authenticate ?? (async () => ({ actorId: 'anonymous' }));

  // POST /pull
  routes.post('/pull', async (c) => {
    const auth = await authenticate(c);
    if (!auth) return relayError(c, 401, 'sync.auth_required');

    const rawBody: unknown = await c.req.json();
    const timer = createSyncTimer();

    if (!isRecord(rawBody)) {
      return invalidRelayRequest(c, 'Invalid JSON body');
    }

    if (!rawBody.clientId || typeof rawBody.clientId !== 'string') {
      return invalidRelayRequest(c, 'clientId is required');
    }

    if (!Array.isArray(rawBody.subscriptions)) {
      return invalidRelayRequest(c, 'subscriptions array is required');
    }

    if (rawBody.subscriptions.length > maxSubscriptionsPerPull) {
      return invalidRelayRequest(
        c,
        `Too many subscriptions (max ${maxSubscriptionsPerPull})`
      );
    }

    const subscriptions: SyncPullRequest['subscriptions'] = [];
    for (const subValue of rawBody.subscriptions) {
      if (!isRecord(subValue)) {
        return invalidRelayRequest(c, 'Invalid subscription entry');
      }

      const id = typeof subValue.id === 'string' ? subValue.id : null;
      const table = typeof subValue.table === 'string' ? subValue.table : null;
      if (!id || !table) {
        return invalidRelayRequest(c, 'Subscription id/table required');
      }

      const scopesParsed = ScopeValuesSchema.safeParse(subValue.scopes);
      if (!scopesParsed.success) {
        return invalidRelayRequest(c, 'Invalid subscription scopes');
      }

      const rawParams = subValue.params;
      if (rawParams !== undefined && !isRecord(rawParams)) {
        return invalidRelayRequest(c, 'Invalid subscription params');
      }

      const cursor =
        typeof subValue.cursor === 'number' && Number.isInteger(subValue.cursor)
          ? Math.max(-1, subValue.cursor)
          : -1;

      const rawBootstrapState = subValue.bootstrapState;
      const bootstrapState =
        rawBootstrapState === undefined || rawBootstrapState === null
          ? null
          : (() => {
              const parsed =
                SyncBootstrapStateSchema.safeParse(rawBootstrapState);
              if (!parsed.success) return null;
              return parsed.data;
            })();

      if (
        rawBootstrapState !== undefined &&
        rawBootstrapState !== null &&
        bootstrapState === null
      ) {
        return invalidRelayRequest(c, 'Invalid subscription bootstrapState');
      }

      subscriptions.push({
        id,
        table,
        scopes: scopesParsed.data,
        params: rawParams,
        cursor,
        bootstrapState,
        crdtStateVectors: [],
      });
    }

    const request: SyncPullRequest = {
      clientId: rawBody.clientId,
      limitCommits: clampInt(
        typeof rawBody.limitCommits === 'number' &&
          Number.isInteger(rawBody.limitCommits)
          ? rawBody.limitCommits
          : 50,
        1,
        maxPullLimitCommits
      ),
      limitSnapshotRows: clampInt(
        typeof rawBody.limitSnapshotRows === 'number' &&
          Number.isInteger(rawBody.limitSnapshotRows)
          ? rawBody.limitSnapshotRows
          : 1000,
        1,
        5000
      ),
      maxSnapshotPages: clampInt(
        typeof rawBody.maxSnapshotPages === 'number' &&
          Number.isInteger(rawBody.maxSnapshotPages)
          ? rawBody.maxSnapshotPages
          : 4,
        1,
        10
      ),
      dedupeRows:
        typeof rawBody.dedupeRows === 'boolean'
          ? rawBody.dedupeRows
          : undefined,
      subscriptions,
    };

    const validatedRequest = SyncPullRequestSchema.safeParse(request);
    if (!validatedRequest.success) {
      return invalidRelayRequest(c, 'Invalid pull request');
    }

    const pullResult = await relayPull({
      db: options.db,
      dialect: options.dialect,
      handlers: options.handlers,
      auth,
      request: validatedRequest.data,
    });

    await recordClientCursor(options.db, options.dialect, {
      clientId: validatedRequest.data.clientId,
      actorId: auth.actorId,
      cursor: pullResult.clientCursor,
      effectiveScopes: pullResult.effectiveScopes,
    });

    // Notify realtime about updated scope values
    options.realtime.updateClientScopeKeys(
      request.clientId,
      Object.keys(pullResult.effectiveScopes)
    );

    logSyncEvent({
      event: 'relay.pull',
      userId: auth.actorId,
      durationMs: timer(),
      subscriptionCount: pullResult.response.subscriptions.length,
      clientCursor: pullResult.clientCursor,
    });

    return c.json(pullResult.response);
  });

  // POST /push
  routes.post('/push', async (c) => {
    const auth = await authenticate(c);
    if (!auth) return relayError(c, 401, 'sync.auth_required');

    const rawBody: unknown = await c.req.json();
    const parsed = SyncPushRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return invalidRelayRequest(c, 'Invalid push request');
    }

    const body: SyncPushRequest = parsed.data;

    if (body.operations.length > maxOperationsPerPush) {
      return relayError(
        c,
        400,
        'sync.too_many_operations',
        `Maximum ${maxOperationsPerPush} operations per push`
      );
    }

    const timer = createSyncTimer();

    const pushed = await relayPushCommit({
      db: options.db,
      dialect: options.dialect,
      handlers: options.handlers,
      auth,
      request: body,
    });

    logSyncEvent({
      event: 'relay.push',
      userId: auth.actorId,
      durationMs: timer(),
      operationCount: body.operations.length,
      status: pushed.response.status,
      commitSeq: pushed.response.commitSeq,
    });

    // Notify about the commit
    if (
      pushed.response.ok === true &&
      pushed.response.status === 'applied' &&
      typeof pushed.response.commitSeq === 'number' &&
      pushed.affectedTables.length > 0
    ) {
      await options.onCommit?.(
        pushed.response.commitSeq,
        pushed.affectedTables
      );
    }

    return c.json(pushed.response);
  });

  return routes;
}
