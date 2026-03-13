/**
 * @syncular/client - High-level sync loops
 *
 * Helpers that run push/pull repeatedly until the client is caught up.
 */

import type {
  SyncCombinedResponse,
  SyncPullResponse,
  SyncPullSubscriptionResponse,
  SyncPushBatchCommitResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncTransport,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import { upsertConflictsForRejectedCommit } from './conflicts';
import type { PushResultInfo, SyncClientSubscription } from './engine/types';
import type { ClientHandlerCollection } from './handlers/collection';
import {
  getNextSendableOutboxCommit,
  markOutboxCommitAcked,
  markOutboxCommitFailed,
  markOutboxCommitPending,
  type OutboxCommit,
} from './outbox';
import { INCREMENTING_VERSION_PLUGIN_KIND } from './plugins/incrementing-version';
import type {
  SyncClientPlugin,
  SyncClientPluginContext,
} from './plugins/types';
import {
  applyPullResponse,
  buildPullRequest,
  createFollowupPullState,
  type SyncPullOnceOptions,
  type SyncPullRequestState,
  syncPullOnce,
} from './pull-engine';
import type { SyncPushOnceOptions } from './push-engine';
import type { SyncClientDb } from './schema';

interface SyncPushUntilSettledOptions extends SyncPushOnceOptions {
  /** Max outbox commits to attempt per call. Default: 20 */
  maxCommits?: number;
}

interface SyncPushUntilSettledResult {
  pushedCount: number;
  pushResults: PushResultInfo[];
}

function firstPushErrorCode(response: SyncPushResponse): string | null {
  const firstError = response.results.find(
    (result) => result.status === 'error'
  );
  if (
    firstError &&
    'code' in firstError &&
    typeof firstError.code === 'string' &&
    firstError.code
  ) {
    return firstError.code;
  }
  const hasConflict = response.results.some(
    (result) => result.status === 'conflict'
  );
  return hasConflict ? 'CONFLICT' : null;
}

function buildPushResult(args: {
  outboxCommitId: string;
  clientCommitId: string;
  status: PushResultInfo['status'];
  response: SyncPushResponse;
}): PushResultInfo {
  return {
    outboxCommitId: args.outboxCommitId,
    clientCommitId: args.clientCommitId,
    status: args.status,
    commitSeq: args.response.commitSeq ?? null,
    results: args.response.results,
    errorCode: firstPushErrorCode(args.response),
    timestamp: Date.now(),
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createPushRequest(
  clientId: string,
  outboxCommit: OutboxCommit
): SyncPushRequest {
  return {
    clientId,
    clientCommitId: outboxCommit.client_commit_id,
    operations: outboxCommit.operations,
    schemaVersion: outboxCommit.schema_version,
  };
}

function toSyncPushResponse(
  response: SyncPushBatchCommitResponse
): SyncPushResponse {
  return {
    ok: true,
    status: response.status,
    commitSeq: response.commitSeq,
    results: response.results,
  };
}

function isRetriablePushResponse(response: SyncPushResponse): boolean {
  const errorResults = response.results.filter(
    (result) => result.status === 'error'
  );
  return (
    errorResults.length > 0 &&
    errorResults.every((result) => result.retriable === true)
  );
}

async function claimSendableOutboxCommits<DB extends SyncClientDb>(
  db: Kysely<DB>,
  maxCommits: number
): Promise<OutboxCommit[]> {
  const claimed: OutboxCommit[] = [];

  for (let i = 0; i < maxCommits; i++) {
    const next = await getNextSendableOutboxCommit(db);
    if (!next) break;
    claimed.push(next);
  }

  return claimed;
}

async function markClaimedOutboxCommitsPending<DB extends SyncClientDb>(
  db: Kysely<DB>,
  outboxCommits: OutboxCommit[],
  error: string
): Promise<void> {
  for (const outboxCommit of outboxCommits) {
    await markOutboxCommitPending(db, {
      id: outboxCommit.id,
      error,
    });
  }
}

interface PreparedPushCommit {
  outboxCommit: OutboxCommit;
  request: SyncPushRequest;
}

function hasIncrementingVersionPlugin(
  plugins: readonly SyncClientPlugin[]
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.kind === INCREMENTING_VERSION_PLUGIN_KIND ||
      plugin.name === INCREMENTING_VERSION_PLUGIN_KIND
  );
}

function makeSequentialRowKey(
  operation: Pick<SyncPushRequest['operations'][number], 'table' | 'row_id'>
): string {
  return `${operation.table}\u001f${operation.row_id}`;
}

function advanceSequentialBaseVersionsInBatch(
  preparedCommits: PreparedPushCommit[]
): PreparedPushCommit[] {
  const nextExpectedBaseVersionByRow = new Map<string, number>();

  return preparedCommits.map((preparedCommit) => {
    let requestChanged = false;
    const operations = preparedCommit.request.operations.map((operation) => {
      const key = makeSequentialRowKey(operation);
      const nextExpected = nextExpectedBaseVersionByRow.get(key);
      const baseVersion =
        typeof operation.base_version === 'number' &&
        typeof nextExpected === 'number' &&
        nextExpected > operation.base_version
          ? nextExpected
          : operation.base_version;

      const rewrittenOperation =
        baseVersion === operation.base_version
          ? operation
          : { ...operation, base_version: baseVersion };

      if (rewrittenOperation !== operation) {
        requestChanged = true;
      }

      if (operation.op === 'delete') {
        nextExpectedBaseVersionByRow.delete(key);
        return rewrittenOperation;
      }

      if (typeof baseVersion === 'number') {
        nextExpectedBaseVersionByRow.set(key, baseVersion + 1);
        return rewrittenOperation;
      }

      nextExpectedBaseVersionByRow.set(key, 1);
      return rewrittenOperation;
    });

    if (!requestChanged) return preparedCommit;
    return {
      ...preparedCommit,
      request: {
        ...preparedCommit.request,
        operations,
      },
    };
  });
}

async function preparePushCommits(
  outboxCommits: OutboxCommit[],
  options: SyncPushOnceOptions
): Promise<PreparedPushCommit[]> {
  const plugins = options.plugins ?? [];
  const ctx: SyncClientPluginContext = {
    actorId: options.actorId ?? 'unknown',
    clientId: options.clientId,
  };

  const prepared: PreparedPushCommit[] = [];
  for (const outboxCommit of outboxCommits) {
    let request = createPushRequest(options.clientId, outboxCommit);
    for (const plugin of plugins) {
      if (!plugin.beforePush) continue;
      request = await plugin.beforePush(ctx, request);
    }
    prepared.push({ outboxCommit, request });
  }

  if (!hasIncrementingVersionPlugin(plugins)) {
    return prepared;
  }

  return advanceSequentialBaseVersionsInBatch(prepared);
}

async function finalizePushCommit<DB extends SyncClientDb>(
  db: Kysely<DB>,
  options: SyncPushOnceOptions,
  preparedCommit: PreparedPushCommit,
  rawResponse: SyncPushResponse
): Promise<{ pushResult: PushResultInfo; afterPushError: Error | null }> {
  const plugins = options.plugins ?? [];
  const ctx: SyncClientPluginContext = {
    actorId: options.actorId ?? 'unknown',
    clientId: options.clientId,
  };

  let response = rawResponse;
  let afterPushError: Error | null = null;
  try {
    for (const plugin of plugins) {
      if (!plugin.afterPush) continue;
      response = await plugin.afterPush(ctx, {
        request: preparedCommit.request,
        response,
      });
    }
  } catch (error) {
    afterPushError = normalizeError(error);
    response = rawResponse;
  }

  const responseJson = JSON.stringify(response);
  let status: PushResultInfo['status'];

  if (response.status === 'applied' || response.status === 'cached') {
    await markOutboxCommitAcked(db, {
      id: preparedCommit.outboxCommit.id,
      commitSeq: response.commitSeq ?? null,
      responseJson,
    });
    status = response.status;
  } else if (isRetriablePushResponse(response)) {
    const errorMessages = response.results
      .filter((result) => result.status === 'error')
      .map((result) => result.error ?? 'Unknown error')
      .join('; ');
    await markOutboxCommitPending(db, {
      id: preparedCommit.outboxCommit.id,
      error: `Retriable: ${errorMessages}`,
      responseJson,
    });
    status = 'retriable';
  } else {
    await upsertConflictsForRejectedCommit(db, {
      outboxCommitId: preparedCommit.outboxCommit.id,
      clientCommitId: preparedCommit.outboxCommit.client_commit_id,
      response,
    });
    await markOutboxCommitFailed(db, {
      id: preparedCommit.outboxCommit.id,
      error: 'REJECTED',
      responseJson,
    });
    status = 'rejected';
  }

  return {
    pushResult: buildPushResult({
      outboxCommitId: preparedCommit.outboxCommit.id,
      clientCommitId: preparedCommit.outboxCommit.client_commit_id,
      status,
      response,
    }),
    afterPushError,
  };
}

async function syncPushUntilSettled<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  options: SyncPushUntilSettledOptions
): Promise<SyncPushUntilSettledResult> {
  const maxCommits = Math.max(1, Math.min(1000, options.maxCommits ?? 20));

  let pushedCount = 0;
  const pushResults: PushResultInfo[] = [];
  while (pushedCount < maxCommits) {
    const claimedCommits = await claimSendableOutboxCommits(
      db,
      maxCommits - pushedCount
    );
    if (claimedCommits.length === 0) break;

    let preparedCommits: PreparedPushCommit[];
    try {
      preparedCommits = await preparePushCommits(claimedCommits, options);
    } catch (error) {
      const normalizedError = normalizeError(error);
      await markClaimedOutboxCommitsPending(
        db,
        claimedCommits,
        normalizedError.message
      );
      throw normalizedError;
    }

    let combined: SyncCombinedResponse;
    try {
      combined = await transport.sync({
        clientId: options.clientId,
        push: {
          commits: preparedCommits.map(({ request }) => ({
            clientCommitId: request.clientCommitId,
            operations: request.operations,
            schemaVersion: request.schemaVersion,
          })),
        },
      });
    } catch (error) {
      const normalizedError = normalizeError(error);
      await markClaimedOutboxCommitsPending(
        db,
        claimedCommits,
        normalizedError.message
      );
      throw normalizedError;
    }

    const batchResponses = combined.push?.commits ?? [];
    const responsesByClientCommitId = new Map(
      batchResponses.map((response) => [response.clientCommitId, response])
    );

    if (
      !combined.push ||
      preparedCommits.some(
        ({ request }) => !responsesByClientCommitId.has(request.clientCommitId)
      )
    ) {
      await markClaimedOutboxCommitsPending(
        db,
        claimedCommits,
        'MISSING_PUSH_RESPONSE'
      );
      throw new Error('Server returned incomplete push response');
    }

    let deferredError: Error | null = null;
    for (const preparedCommit of preparedCommits) {
      const batchResponse = responsesByClientCommitId.get(
        preparedCommit.request.clientCommitId
      );
      if (!batchResponse) continue;

      const finalized = await finalizePushCommit(
        db,
        options,
        preparedCommit,
        toSyncPushResponse(batchResponse)
      );
      pushResults.push(finalized.pushResult);
      pushedCount += 1;
      if (!deferredError && finalized.afterPushError) {
        deferredError = finalized.afterPushError;
      }
    }

    if (deferredError) {
      throw deferredError;
    }
  }

  return { pushedCount, pushResults };
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

function needsAnotherPull(
  res: SyncPullResponse,
  limitCommits: number
): boolean {
  let totalCommits = 0;
  for (const sub of res.subscriptions ?? []) {
    if (sub.status !== 'active') continue;
    if (sub.bootstrap) return true;
    totalCommits += sub.commits?.length ?? 0;
  }
  return totalCommits >= limitCommits;
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

function canSkipPullAfterLocalWsPush(
  pullState: SyncPullRequestState,
  pushResponse: SyncPushResponse | null,
  options: SyncOnceOptions
): boolean {
  if (!options.allowSkipPullOnLocalWsPush) return false;
  if (options.trigger !== 'local') return false;
  if (!pushResponse) return false;
  if (pushResponse.status !== 'applied' && pushResponse.status !== 'cached') {
    return false;
  }
  if (
    (options.plugins ?? []).some(
      (plugin) => typeof plugin.afterPull === 'function'
    )
  ) {
    return false;
  }

  for (const subscription of pullState.request.subscriptions ?? []) {
    if (subscription.bootstrapState != null) {
      return false;
    }
    const cursor = subscription.cursor ?? -1;
    if (cursor < 0) {
      return false;
    }
  }

  return true;
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

    if (!needsAnotherPull(res, pullState.request.limitCommits)) break;
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
  subscriptions: SyncClientSubscription[];
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  dedupeRows?: boolean;
  stateId?: string;
  maxPushCommits?: number;
  maxPullRounds?: number;
  /** When 'ws', peek outbox first and skip push if empty. */
  trigger?: 'ws' | 'local' | 'poll';
  /** Allow successful local WS pushes to skip the immediate HTTP pull phase. */
  allowSkipPullOnLocalWsPush?: boolean;
  /** Custom SHA-256 hash function (for platforms without crypto.subtle) */
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

export interface SyncOnceResult {
  pushedCommits: number;
  pullRounds: number;
  pullResponse: SyncPullResponse;
  pushResults: PushResultInfo[];
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

  const plugins = options.plugins ?? [];

  const outbox = await getNextSendableOutboxCommit(db);
  let preparedFirstCommit: PreparedPushCommit | null = null;
  if (outbox) {
    try {
      const preparedCommits = await preparePushCommits([outbox], {
        clientId: options.clientId,
        actorId: options.actorId,
        plugins,
      });
      preparedFirstCommit = preparedCommits[0] ?? null;
    } catch (error) {
      const normalizedError = normalizeError(error);
      await markClaimedOutboxCommitsPending(
        db,
        [outbox],
        normalizedError.message
      );
      throw normalizedError;
    }
  }

  // Try WS push first for the first outbox commit (if realtime transport supports it).
  // Fall back to HTTP push in the combined request when WS is unavailable or fails.
  let wsPushResponse: SyncPushResponse | null = null;
  if (preparedFirstCommit && hasPushViaWs(transport)) {
    try {
      wsPushResponse = await transport.pushViaWs(preparedFirstCommit.request);
    } catch {
      wsPushResponse = null;
    }
  }

  const skipPullAfterWsPush = canSkipPullAfterLocalWsPush(
    pullState,
    wsPushResponse,
    options
  );

  let combined: SyncCombinedResponse | null = null;
  let combinedPushCommits: PreparedPushCommit[] = [];
  if (!skipPullAfterWsPush) {
    combinedPushCommits =
      preparedFirstCommit && !wsPushResponse
        ? [
            preparedFirstCommit,
            ...(await (async () => {
              const additionalOutboxCommits = await claimSendableOutboxCommits(
                db,
                Math.max(0, (options.maxPushCommits ?? 20) - 1)
              );
              if (additionalOutboxCommits.length === 0) return [];
              try {
                return await preparePushCommits(additionalOutboxCommits, {
                  clientId: options.clientId,
                  actorId: options.actorId,
                  plugins,
                });
              } catch (error) {
                const normalizedError = normalizeError(error);
                await markClaimedOutboxCommitsPending(
                  db,
                  additionalOutboxCommits,
                  normalizedError.message
                );
                throw normalizedError;
              }
            })()),
          ]
        : [];
    if (hasIncrementingVersionPlugin(plugins)) {
      combinedPushCommits =
        advanceSequentialBaseVersionsInBatch(combinedPushCommits);
    }

    try {
      combined = await transport.sync({
        clientId,
        ...(combinedPushCommits.length > 0
          ? {
              push: {
                commits: combinedPushCommits.map(({ request }) => ({
                  clientCommitId: request.clientCommitId,
                  operations: request.operations,
                  schemaVersion: request.schemaVersion,
                })),
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
      if (combinedPushCommits.length > 0) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await markClaimedOutboxCommitsPending(
          db,
          combinedPushCommits.map(({ outboxCommit }) => outboxCommit),
          message
        );
      }
      throw err;
    }
  }

  // Process push response
  let pushedCommits = 0;
  const pushResults: PushResultInfo[] = [];
  if (preparedFirstCommit) {
    if (wsPushResponse) {
      const finalizedFirstCommit = await finalizePushCommit(
        db,
        {
          clientId: options.clientId,
          actorId: options.actorId,
          plugins,
        },
        preparedFirstCommit,
        wsPushResponse
      );
      pushResults.push(finalizedFirstCommit.pushResult);
      pushedCommits = 1;

      if (finalizedFirstCommit.afterPushError) {
        throw finalizedFirstCommit.afterPushError;
      }
    } else {
      const batchResponses = combined?.push?.commits ?? [];
      const responsesByClientCommitId = new Map(
        batchResponses.map((response) => [response.clientCommitId, response])
      );
      if (
        !combined?.push ||
        combinedPushCommits.some(
          ({ request }) =>
            !responsesByClientCommitId.has(request.clientCommitId)
        )
      ) {
        await markClaimedOutboxCommitsPending(
          db,
          combinedPushCommits.map(({ outboxCommit }) => outboxCommit),
          'MISSING_PUSH_RESPONSE'
        );
        throw new Error('Server returned incomplete push response');
      }

      let deferredError: Error | null = null;
      for (const preparedCommit of combinedPushCommits) {
        const batchResponse = responsesByClientCommitId.get(
          preparedCommit.request.clientCommitId
        );
        if (!batchResponse) continue;

        const finalizedCommit = await finalizePushCommit(
          db,
          {
            clientId: options.clientId,
            actorId: options.actorId,
            plugins,
          },
          preparedCommit,
          toSyncPushResponse(batchResponse)
        );
        pushResults.push(finalizedCommit.pushResult);
        pushedCommits += 1;
        if (!deferredError && finalizedCommit.afterPushError) {
          deferredError = finalizedCommit.afterPushError;
        }
      }

      if (deferredError) {
        throw deferredError;
      }
    }

    // Settle remaining outbox commits
    const remainingMaxCommits = Math.max(
      0,
      (options.maxPushCommits ?? 20) - pushedCommits
    );
    if (remainingMaxCommits > 0) {
      const remaining = await syncPushUntilSettled(db, transport, {
        clientId: options.clientId,
        actorId: options.actorId,
        plugins: options.plugins,
        maxCommits: remainingMaxCommits,
      });
      pushedCommits += remaining.pushedCount;
      pushResults.push(...remaining.pushResults);
    }
  }

  // Process pull response
  let pullResponse: SyncPullResponse = { ok: true, subscriptions: [] };
  let pullRounds = 0;
  if (combined?.pull) {
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
    if (needsAnotherPull(pullResponse, pullState.request.limitCommits)) {
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

  return { pushedCommits, pullRounds, pullResponse, pushResults };
}

export async function syncOnce<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  handlers: ClientHandlerCollection<DB>,
  options: SyncOnceOptions
): Promise<SyncOnceResult> {
  return syncOnceCombined(db, transport, handlers, options);
}
