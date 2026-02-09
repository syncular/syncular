/**
 * @syncular/client - High-level sync loops
 *
 * Helpers that run push/pull repeatedly until the client is caught up.
 */

import type {
  SyncPullResponse,
  SyncPullSubscriptionResponse,
  SyncSubscriptionRequest,
  SyncTransport,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import type { ClientTableRegistry } from './handlers/registry';
import { type SyncPullOnceOptions, syncPullOnce } from './pull-engine';
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
}

interface SyncPullUntilSettledResult {
  response: SyncPullResponse;
  rounds: number;
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
  shapes: ClientTableRegistry<DB>,
  options: SyncPullUntilSettledOptions
): Promise<SyncPullUntilSettledResult> {
  const maxRounds = Math.max(1, Math.min(1000, options.maxRounds ?? 20));

  const aggregatedBySubId = new Map<string, SyncPullSubscriptionResponse>();
  let rounds = 0;

  for (let i = 0; i < maxRounds; i++) {
    rounds += 1;
    const res = await syncPullOnce(db, transport, shapes, options);
    mergePullResponse(aggregatedBySubId, res);

    if (!needsAnotherPull(res)) break;
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
}

export interface SyncOnceResult {
  pushedCommits: number;
  pullRounds: number;
  pullResponse: SyncPullResponse;
}

export async function syncOnce<DB extends SyncClientDb>(
  db: Kysely<DB>,
  transport: SyncTransport,
  shapes: ClientTableRegistry<DB>,
  options: SyncOnceOptions
): Promise<SyncOnceResult> {
  const pushed = await syncPushUntilSettled(db, transport, {
    clientId: options.clientId,
    actorId: options.actorId,
    plugins: options.plugins,
    maxCommits: options.maxPushCommits,
  });

  const pulled = await syncPullUntilSettled(db, transport, shapes, {
    clientId: options.clientId,
    actorId: options.actorId,
    plugins: options.plugins,
    subscriptions: options.subscriptions,
    limitCommits: options.limitCommits,
    limitSnapshotRows: options.limitSnapshotRows,
    maxSnapshotPages: options.maxSnapshotPages,
    dedupeRows: options.dedupeRows,
    stateId: options.stateId,
    maxRounds: options.maxPullRounds,
  });

  return {
    pushedCommits: pushed.pushedCount,
    pullRounds: pulled.rounds,
    pullResponse: pulled.response,
  };
}
