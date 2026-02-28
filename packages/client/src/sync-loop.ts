/**
 * @syncular/client - High-level sync loops
 *
 * Helpers that run push/pull repeatedly until the client is caught up.
 */

import type {
  SyncCombinedResponse,
  SyncPullResponse,
  SyncPullSubscriptionResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncSubscriptionRequest,
  SyncTransport,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import { upsertConflictsForRejectedCommit } from './conflicts';
import type { ClientHandlerCollection } from './handlers/collection';
import {
  getNextSendableOutboxCommit,
  markOutboxCommitAcked,
  markOutboxCommitFailed,
  markOutboxCommitPending,
} from './outbox';
import type { SyncClientPluginContext } from './plugins/types';
import {
  applyPullResponse,
  buildPullRequest,
  createFollowupPullState,
  type SyncPullOnceOptions,
  type SyncPullRequestState,
  syncPullOnce,
} from './pull-engine';
import { type SyncPushOnceOptions, syncPushOnce } from './push-engine';
import type { SyncClientDb } from './schema';

interface SyncPushUntilSettledOptions extends SyncPushOnceOptions {
  /** Max outbox commits to attempt per call. Default: 20 */
  maxCommits?: number;
}

interface SyncPushUntilSettledResult {
  pushedCount: number;
}

async function syncPushUntilSettled<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  options: SyncPushUntilSettledOptions
): Promise<SyncPushUntilSettledResult> {
  const maxCommits = Math.max(1, Math.min(1000, options.maxCommits ?? 20));

  let pushedCount = 0;
  for (let i = 0; i < maxCommits; i++) {
    const res = await syncPushOnce(db, transport, {
      clientId: options.clientId,
      actorId: options.actorId,
      plugins: options.plugins,
    });
    if (!res.pushed) break;
    pushedCount += 1;
  }

  return { pushedCount };
}

interface SyncPullUntilSettledOptions extends SyncPullOnceOptions {
  /** Max pull rounds per call. Default: 20 */
  maxRounds?: number;
  /** Optional prebuilt state from a prior pull round in the same sync cycle. */
  initialPullState?: SyncPullRequestState;
}

interface SyncPullUntilSettledResult {
  response: SyncPullResponse;
  rounds: number;
}

interface TransportWithWsPush extends SyncTransport {
  pushViaWs(request: SyncPushRequest): Promise<SyncPushResponse | null>;
}

function hasPushViaWs(
  transport: SyncTransport
): transport is TransportWithWsPush {
  return 'pushViaWs' in transport && typeof transport.pushViaWs === 'function';
}

function needsAnotherPull(res: SyncPullResponse): boolean {
  for (const sub of res.subscriptions ?? []) {
    if (sub.status !== 'active') continue;
    if (sub.bootstrap) return true;
    if ((sub.commits?.length ?? 0) > 0) return true;
  }
  return false;
}

function mergePullResponse(
  targetBySubId: Map<string, SyncPullSubscriptionResponse>,
  res: SyncPullResponse
): void {
  for (const sub of res.subscriptions ?? []) {
    const prev = targetBySubId.get(sub.id);
    if (!prev) {
      const merged: SyncPullSubscriptionResponse = {
        ...sub,
        commits: [...(sub.commits ?? [])],
        snapshots: [...(sub.snapshots ?? [])],
      };
      targetBySubId.set(sub.id, merged);
      continue;
    }

    const merged: SyncPullSubscriptionResponse = {
      ...prev,
      ...sub,
      commits: [...(prev.commits ?? []), ...(sub.commits ?? [])],
      snapshots: [...(prev.snapshots ?? []), ...(sub.snapshots ?? [])],
    };
    targetBySubId.set(sub.id, merged);
  }
}

async function syncPullUntilSettled<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  handlers: ClientHandlerCollection<DB>,
  options: SyncPullUntilSettledOptions
): Promise<SyncPullUntilSettledResult> {
  const maxRounds = Math.max(1, Math.min(1000, options.maxRounds ?? 20));

  const aggregatedBySubId = new Map<string, SyncPullSubscriptionResponse>();
  let pullState =
    options.initialPullState ?? (await buildPullRequest(db, options));
  let rounds = 0;

  for (let i = 0; i < maxRounds; i++) {
    rounds += 1;
    const res = await syncPullOnce(db, transport, handlers, options, pullState);
    mergePullResponse(aggregatedBySubId, res);

    if (!needsAnotherPull(res)) break;
    pullState = createFollowupPullState(pullState, res);
  }

  return {
    // Return an aggregate response so callers can see what was applied across
    // all pull rounds (the last round is often empty by design).
    response: {
      ok: true,
      subscriptions: Array.from(aggregatedBySubId.values()),
    },
    rounds,
  };
}

export interface SyncOnceOptions {
  clientId: string;
  actorId?: string;
  plugins?: SyncPushOnceOptions['plugins'];
  subscriptions: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  dedupeRows?: boolean;
  stateId?: string;
  maxPushCommits?: number;
  maxPullRounds?: number;
  /** When 'ws', peek outbox first and skip push if empty. */
  trigger?: 'ws' | 'local' | 'poll';
  /** Custom SHA-256 hash function (for platforms without crypto.subtle) */
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

export interface SyncOnceResult {
  pushedCommits: number;
  pullRounds: number;
  pullResponse: SyncPullResponse;
}

/**
 * Sync once using a WS-first push strategy for the first outbox commit.
 *
 * - If transport supports `pushViaWs` and the commit succeeds over WS, this call
 *   sends only an HTTP pull request.
 * - Otherwise it falls back to combined HTTP push+pull.
 *
 * Remaining outbox commits are then settled via `syncPushUntilSettled`.
 */
async function syncOnceCombined<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  handlers: ClientHandlerCollection<DB>,
  options: SyncOnceOptions
): Promise<SyncOnceResult> {
  const pullOpts: SyncPullOnceOptions = {
    clientId: options.clientId,
    actorId: options.actorId,
    plugins: options.plugins,
    subscriptions: options.subscriptions,
    limitCommits: options.limitCommits,
    limitSnapshotRows: options.limitSnapshotRows,
    maxSnapshotPages: options.maxSnapshotPages,
    dedupeRows: options.dedupeRows,
    stateId: options.stateId,
    sha256: options.sha256,
  };

  // Build pull request (reads subscription state)
  const pullState = await buildPullRequest(db, pullOpts);
  const { clientId } = pullState.request;

  // Grab at most one outbox commit
  const outbox = await getNextSendableOutboxCommit(db);

  const plugins = options.plugins ?? [];
  const ctx: SyncClientPluginContext = {
    actorId: options.actorId ?? 'unknown',
    clientId,
  };

  // Build push request, running beforePush plugins
  let pushRequest: SyncPushRequest | undefined;
  if (outbox) {
    pushRequest = {
      clientId,
      clientCommitId: outbox.client_commit_id,
      operations: outbox.operations,
      schemaVersion: outbox.schema_version,
    };
    for (const plugin of plugins) {
      if (!plugin.beforePush) continue;
      pushRequest = await plugin.beforePush(ctx, pushRequest);
    }
  }

  // Try WS push first for the first outbox commit (if realtime transport supports it).
  // Fall back to HTTP push in the combined request when WS is unavailable or fails.
  let wsPushResponse: SyncPushResponse | null = null;
  if (pushRequest && hasPushViaWs(transport)) {
    try {
      wsPushResponse = await transport.pushViaWs(pushRequest);
    } catch {
      wsPushResponse = null;
    }
  }

  let combined: SyncCombinedResponse;
  try {
    combined = await transport.sync({
      clientId,
      ...(pushRequest && !wsPushResponse
        ? {
            push: {
              clientCommitId: pushRequest.clientCommitId,
              operations: pushRequest.operations,
              schemaVersion: pushRequest.schemaVersion,
            },
          }
        : {}),
      pull: {
        limitCommits: pullState.request.limitCommits,
        limitSnapshotRows: pullState.request.limitSnapshotRows,
        maxSnapshotPages: pullState.request.maxSnapshotPages,
        dedupeRows: pullState.request.dedupeRows,
        subscriptions: pullState.request.subscriptions,
      },
    });
  } catch (err) {
    if (outbox) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await markOutboxCommitPending(db, { id: outbox.id, error: message });
    }
    throw err;
  }

  // Process push response
  let pushedCommits = 0;
  if (outbox && pushRequest) {
    let pushRes = wsPushResponse ?? combined.push;
    if (!pushRes) {
      await markOutboxCommitPending(db, {
        id: outbox.id,
        error: 'MISSING_PUSH_RESPONSE',
      });
      throw new Error('Server returned no push response');
    }

    // Run afterPush plugins
    for (const plugin of plugins) {
      if (!plugin.afterPush) continue;
      pushRes = await plugin.afterPush(ctx, {
        request: pushRequest,
        response: pushRes,
      });
    }

    const responseJson = JSON.stringify(pushRes);

    if (pushRes.status === 'applied' || pushRes.status === 'cached') {
      await markOutboxCommitAcked(db, {
        id: outbox.id,
        commitSeq: pushRes.commitSeq ?? null,
        responseJson,
      });
      pushedCommits = 1;
    } else {
      // Check if all errors are retriable
      const errorResults = pushRes.results.filter((r) => r.status === 'error');
      const allRetriable =
        errorResults.length > 0 &&
        errorResults.every((r) => r.retriable === true);

      if (allRetriable) {
        await markOutboxCommitPending(db, {
          id: outbox.id,
          error: 'Retriable',
          responseJson,
        });
        pushedCommits = 1;
      } else {
        await upsertConflictsForRejectedCommit(db, {
          outboxCommitId: outbox.id,
          clientCommitId: outbox.client_commit_id,
          response: pushRes,
        });
        await markOutboxCommitFailed(db, {
          id: outbox.id,
          error: 'REJECTED',
          responseJson,
        });
        pushedCommits = 1;
      }
    }

    // Settle remaining outbox commits
    const remaining = await syncPushUntilSettled(db, transport, {
      clientId: options.clientId,
      actorId: options.actorId,
      plugins: options.plugins,
      maxCommits: (options.maxPushCommits ?? 20) - 1,
    });
    pushedCommits += remaining.pushedCount;
  }

  // Process pull response
  let pullResponse: SyncPullResponse = { ok: true, subscriptions: [] };
  let pullRounds = 0;
  if (combined.pull) {
    pullResponse = await applyPullResponse(
      db,
      transport,
      handlers,
      pullOpts,
      pullState,
      combined.pull
    );
    pullRounds = 1;

    // Continue pulling if more data
    if (needsAnotherPull(pullResponse)) {
      const aggregatedBySubId = new Map<string, SyncPullSubscriptionResponse>();
      mergePullResponse(aggregatedBySubId, pullResponse);

      const more = await syncPullUntilSettled(db, transport, handlers, {
        ...pullOpts,
        maxRounds: (options.maxPullRounds ?? 20) - 1,
        initialPullState: createFollowupPullState(pullState, pullResponse),
      });
      pullRounds += more.rounds;
      mergePullResponse(aggregatedBySubId, more.response);
      pullResponse = {
        ok: true,
        subscriptions: Array.from(aggregatedBySubId.values()),
      };
    }
  }

  return { pushedCommits, pullRounds, pullResponse };
}

export async function syncOnce<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  handlers: ClientHandlerCollection<DB>,
  options: SyncOnceOptions
): Promise<SyncOnceResult> {
  return syncOnceCombined(db, transport, handlers, options);
}
