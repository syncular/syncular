/**
 * @syncular/server - Change-log compaction utilities
 *
 * Compaction reduces storage by deleting intermediate history while preserving
 * the newest change per (table_name, row_id, scope_key) for older data.
 *
 * Dialect-specific implementation lives in `ServerSyncDialect.compactChanges`.
 */

import type { DbExecutor, ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';

export interface CompactOptions {
  /**
   * Keep full (non-compacted) history for the most recent N hours.
   * Older history may be compacted depending on dialect strategy.
   */
  fullHistoryHours: number;
}

export async function compactChanges<DB extends SyncCoreDb>(
  db: DbExecutor<DB>,
  args: { dialect: ServerSyncDialect; options: CompactOptions }
): Promise<number> {
  const fullHistoryHours = Math.max(0, args.options.fullHistoryHours);
  if (fullHistoryHours <= 0) return 0;
  return args.dialect.compactChanges(db, { fullHistoryHours });
}

interface CompactState {
  lastCompactAtMs: number;
  compactInFlight: Promise<number> | null;
}

const compactStateByDb = new WeakMap<object, CompactState>();

function getCompactState(db: object): CompactState {
  const existing = compactStateByDb.get(db);
  if (existing) return existing;

  const created: CompactState = {
    lastCompactAtMs: 0,
    compactInFlight: null,
  };
  compactStateByDb.set(db, created);
  return created;
}

export async function maybeCompactChanges<DB extends SyncCoreDb>(
  db: DbExecutor<DB>,
  args: {
    dialect: ServerSyncDialect;
    minIntervalMs: number;
    options: CompactOptions;
  }
): Promise<number> {
  const state = getCompactState(db);
  const now = Date.now();
  if (now - state.lastCompactAtMs < args.minIntervalMs) return 0;

  if (state.compactInFlight) return state.compactInFlight;

  state.compactInFlight = (async () => {
    try {
      const deleted = await compactChanges(db, {
        dialect: args.dialect,
        options: args.options,
      });
      state.lastCompactAtMs = Date.now();
      return deleted;
    } finally {
      state.compactInFlight = null;
    }
  })();

  return state.compactInFlight;
}
