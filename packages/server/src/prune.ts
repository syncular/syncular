/**
 * Commit-log pruning (SPEC.md §4.6) — normative retention floors.
 *
 * The horizon never advances past `min(active-client cursors)` (clients
 * whose cursor record was touched within the active window), except that
 * commits older than the age-force limit may be pruned regardless; at
 * least the newest `minRetainedCommits` commits are always retained.
 */
import { emitEvent, type SyncularServerEvents } from './events';
import type { CommitPruneQuery, ServerStorage } from './storage';
import { StorageQueryError } from './storage-errors';

/** Shared validation for the built-in atomic pruning adapters. */
export function validateCommitPruneQuery(query: CommitPruneQuery): void {
  if (
    !Number.isSafeInteger(query.throughSeq) ||
    query.throughSeq < 0 ||
    typeof query.logEpoch !== 'string' ||
    query.logEpoch.length === 0
  ) {
    throw new StorageQueryError('sync.storage.invalid_prune_cursor');
  }
}

export interface RetentionPolicy {
  /** Active window for laggard cursors (default 14 days). */
  readonly activeWindowMs: number;
  /** Force-advance past commits older than this (default 30 days). */
  readonly ageForceMs: number;
  /** Always retain at least this many newest commits (default 1000). */
  readonly minRetainedCommits: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  activeWindowMs: 14 * 24 * 60 * 60 * 1000,
  ageForceMs: 30 * 24 * 60 * 60 * 1000,
  minRetainedCommits: 1000,
};

export interface PruneOptions {
  readonly storage: ServerStorage;
  readonly partition: string;
  readonly nowMs: number;
  readonly retention?: Partial<RetentionPolicy>;
  /** Optional structured-events sink (`prune.completed`). */
  readonly events?: SyncularServerEvents;
}

/** Advance the horizon per §4.6 and delete commits at or below it. */
export async function pruneCommitLog(options: PruneOptions): Promise<number> {
  const { storage, partition, nowMs } = options;
  const policy = { ...DEFAULT_RETENTION, ...options.retention };
  const logEpoch = await storage.getPartitionLogEpoch(partition);
  if (logEpoch === undefined)
    throw new StorageQueryError('sync.storage.partition_unregistered');
  const maxSeq = await storage.getMaxCommitSeq(partition);
  const cursorFloor =
    (await storage.getActiveClientCursorFloor(
      partition,
      nowMs - policy.activeWindowMs,
    )) ?? Number.MAX_SAFE_INTEGER;
  const forcedSeq = await storage.getCommitSeqBefore(
    partition,
    nowMs - policy.ageForceMs,
  );
  const retainFloor = maxSeq - policy.minRetainedCommits;
  const target = Math.min(Math.max(cursorFloor, forcedSeq), retainFloor);
  const {
    previousHorizonSeq: current,
    horizonSeq: horizon,
    removedCommits,
  } = await storage.pruneCommitsThrough(partition, {
    logEpoch,
    throughSeq: Math.max(0, target),
  });
  const events = options.events;
  if (events !== undefined) {
    emitEvent(events, {
      type: 'prune.completed',
      atMs: nowMs,
      partition,
      previousHorizonSeq: current,
      horizonSeq: horizon,
      advanced: horizon > current,
      removedCommits,
    });
  }
  return horizon;
}
