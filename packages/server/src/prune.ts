/**
 * Commit-log pruning (SPEC.md §4.6) — normative retention floors.
 *
 * The horizon never advances past `min(active-client cursors)` (clients
 * whose cursor record was touched within the active window), except that
 * commits older than the age-force limit may be pruned regardless; at
 * least the newest `minRetainedCommits` commits are always retained.
 */
import { emitEvent, type SyncularServerEvents } from './events';
import type { ServerStorage } from './storage';

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
  const maxSeq = await storage.getMaxCommitSeq(partition);
  const cursors = await storage.listClientCursors(partition);
  const activeCursors = cursors
    .filter((c) => c.updatedAtMs >= nowMs - policy.activeWindowMs)
    .map((c) => c.cursor);
  const cursorFloor =
    activeCursors.length > 0
      ? Math.min(...activeCursors)
      : Number.MAX_SAFE_INTEGER;
  const forcedSeq = await storage.getCommitSeqBefore(
    partition,
    nowMs - policy.ageForceMs,
  );
  const retainFloor = maxSeq - policy.minRetainedCommits;
  const target = Math.min(Math.max(cursorFloor, forcedSeq), retainFloor);
  const current = await storage.getHorizonSeq(partition);
  const proposedHorizon = Math.max(current, Math.max(0, target));
  if (proposedHorizon > current) {
    // This order is load-bearing for concurrent pulls. The storage update is
    // monotonic, so concurrent prune passes cannot restore an older horizon.
    // A reader may observe the new horizon before deletion, which safely
    // overstates what is gone; it must never observe the old horizon after
    // the log has been pruned.
    await storage.setHorizonSeq(partition, proposedHorizon);
  }
  // Re-read after the monotonic write so a concurrent higher winner governs
  // this pass too. Deletion is idempotent and runs even when the horizon did
  // not move, repairing a crash between an earlier horizon write and delete.
  const horizon = await storage.getHorizonSeq(partition);
  const removedCommits = await storage.pruneCommitsThrough(partition, horizon);
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
