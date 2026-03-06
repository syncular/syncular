/**
 * @syncular/server - Pruning utilities
 *
 * Pruning strategy (initial):
 * - Track per-client cursors in `sync_client_cursors`
 * - Consider a client "active" if it has pulled within `activeWindowMs`
 * - Compute watermark = min(cursor) across active clients (ignoring cursor < 0)
 * - Delete commits with commit_seq <= watermark (cascade deletes changes)
 *
 * Clients behind pruned history will be forced to bootstrap.
 */

import type {
  DeleteQueryBuilder,
  DeleteResult,
  Kysely,
  SelectQueryBuilder,
  SqlBool,
} from 'kysely';
import { sql } from 'kysely';
import { coerceNumber } from './dialect/helpers';
import type { SyncCoreDb } from './schema';

type EmptySelection = Record<string, never>;

export interface PruneOptions {
  /** Clients with updated_at older than this are ignored for watermark. Default: 14 days. */
  activeWindowMs?: number;
  /**
   * Time-based retention safety cap.
   *
   * The server prunes commits older than this age even if watermark pruning
   * is stuck (e.g. a client never advances).
   * Default: 30 days.
   */
  fallbackMaxAgeMs?: number;
  /** Soft cap: keep at least this many newest commits even if watermark is high. Default: 1000. */
  keepNewestCommits?: number;
}

export interface PartitionPrunePreview {
  partitionId: string;
  watermarkCommitSeq: number;
  commitsToDelete: number;
}

async function readPrunePartitionIds<DB extends SyncCoreDb>(
  db: Kysely<DB>
): Promise<string[]> {
  const res = await sql<{ partition_id: string }>`
    SELECT DISTINCT partition_id
    FROM sync_commits
    ORDER BY partition_id ASC
  `.execute(db);

  return res.rows
    .map((row) => row.partition_id)
    .filter((partitionId) => typeof partitionId === 'string' && partitionId);
}

async function computePruneUpToCommitSeq<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  partitionId: string,
  watermarkCommitSeq: number,
  keepNewestCommits: number
): Promise<number> {
  if (watermarkCommitSeq <= 0) return 0;

  type SyncDb = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const syncDb = db as SyncDb;
  const commitsQ = syncDb.selectFrom('sync_commits') as SelectQueryBuilder<
    SyncCoreDb,
    'sync_commits',
    EmptySelection
  >;

  const maxRow = await commitsQ
    .select(({ fn }) => [fn.max('commit_seq').as('maxSeq')])
    .where('partition_id', '=', partitionId)
    .executeTakeFirst();

  const maxSeq = coerceNumber(maxRow?.maxSeq) ?? 0;
  const minKept = Math.max(0, maxSeq - keepNewestCommits);
  return Math.min(watermarkCommitSeq, minKept);
}

export async function computePruneWatermarkCommitSeq<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  options: PruneOptions = {},
  partitionId = 'default'
): Promise<number> {
  type SyncDb = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const syncDb = db as SyncDb;

  const activeWindowMs = options.activeWindowMs ?? 14 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - activeWindowMs).toISOString();

  const cursorsQ = syncDb.selectFrom(
    'sync_client_cursors'
  ) as SelectQueryBuilder<SyncCoreDb, 'sync_client_cursors', EmptySelection>;

  const row = await cursorsQ
    .select(({ fn }) => [fn.min('cursor').as('minCursor')])
    .where(sql<SqlBool>`partition_id = ${partitionId}`)
    .where(sql<SqlBool>`updated_at >= ${cutoffIso}`)
    .where(sql<SqlBool>`cursor >= ${0}`)
    .executeTakeFirst();

  const minCursor = coerceNumber(row?.minCursor) ?? 0;

  const fallbackMaxAgeMs = options.fallbackMaxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  if (fallbackMaxAgeMs <= 0) return minCursor;

  const ageCutoffIso = new Date(Date.now() - fallbackMaxAgeMs).toISOString();
  const commitsQ = syncDb.selectFrom('sync_commits') as SelectQueryBuilder<
    SyncCoreDb,
    'sync_commits',
    EmptySelection
  >;

  const ageRow = await commitsQ
    .select(({ fn }) => [fn.max('commit_seq').as('maxSeq')])
    .where(sql<SqlBool>`partition_id = ${partitionId}`)
    .where(sql<SqlBool>`created_at < ${ageCutoffIso}`)
    .executeTakeFirst();

  const ageSeq = coerceNumber(ageRow?.maxSeq) ?? 0;
  return Math.max(minCursor, ageSeq);
}

export async function pruneSync<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  args: {
    partitionId?: string;
    watermarkCommitSeq: number;
    keepNewestCommits?: number;
  }
): Promise<number> {
  if (args.watermarkCommitSeq <= 0) return 0;

  type SyncDb = Pick<Kysely<SyncCoreDb>, 'deleteFrom' | 'selectFrom'>;
  const syncDb = db as SyncDb;
  const partitionId = args.partitionId ?? 'default';

  const keepNewestCommits = args.keepNewestCommits ?? 1000;
  const pruneUpTo = await computePruneUpToCommitSeq(
    db,
    partitionId,
    args.watermarkCommitSeq,
    keepNewestCommits
  );

  if (pruneUpTo <= 0) return 0;

  // Delete dependent rows explicitly to be robust across dialects and older
  // schemas that may not have FK cascade enabled.
  await (
    syncDb.deleteFrom('sync_table_commits') as DeleteQueryBuilder<
      SyncCoreDb,
      'sync_table_commits',
      DeleteResult
    >
  )
    .where(sql<SqlBool>`partition_id = ${partitionId}`)
    .where(sql<SqlBool>`commit_seq <= ${pruneUpTo}`)
    .executeTakeFirst();

  await (
    syncDb.deleteFrom('sync_changes') as DeleteQueryBuilder<
      SyncCoreDb,
      'sync_changes',
      DeleteResult
    >
  )
    .where(sql<SqlBool>`partition_id = ${partitionId}`)
    .where(sql<SqlBool>`commit_seq <= ${pruneUpTo}`)
    .executeTakeFirst();

  const res = await (
    syncDb.deleteFrom('sync_commits') as DeleteQueryBuilder<
      SyncCoreDb,
      'sync_commits',
      DeleteResult
    >
  )
    .where(sql<SqlBool>`partition_id = ${partitionId}`)
    .where(sql<SqlBool>`commit_seq <= ${pruneUpTo}`)
    .executeTakeFirst();

  return Number(res?.numDeletedRows ?? 0);
}

export async function previewPruneSync<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  options: PruneOptions = {}
): Promise<PartitionPrunePreview[]> {
  type SyncDb = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const syncDb = db as SyncDb;
  const partitionIds = await readPrunePartitionIds(db);
  const previews: PartitionPrunePreview[] = [];

  for (const partitionId of partitionIds) {
    const watermarkCommitSeq = await computePruneWatermarkCommitSeq(
      db,
      options,
      partitionId
    );
    const pruneUpToCommitSeq = await computePruneUpToCommitSeq(
      db,
      partitionId,
      watermarkCommitSeq,
      options.keepNewestCommits ?? 1000
    );

    const commitsQ = syncDb.selectFrom('sync_commits') as SelectQueryBuilder<
      SyncCoreDb,
      'sync_commits',
      EmptySelection
    >;

    const countRow = await commitsQ
      .select(({ fn }) => [fn.countAll().as('count')])
      .where('partition_id', '=', partitionId)
      .where('commit_seq', '<=', pruneUpToCommitSeq)
      .executeTakeFirst();

    previews.push({
      partitionId,
      watermarkCommitSeq,
      commitsToDelete: coerceNumber(countRow?.count) ?? 0,
    });
  }

  return previews;
}

interface PruneState {
  lastPruneAtMs: number;
  pruneInFlight: Promise<number> | null;
}

const pruneStateByDb = new WeakMap<object, PruneState>();

function getPruneState(db: object): PruneState {
  const existing = pruneStateByDb.get(db);
  if (existing) return existing;

  const created: PruneState = {
    lastPruneAtMs: 0,
    pruneInFlight: null,
  };
  pruneStateByDb.set(db, created);
  return created;
}

export async function maybePruneSync<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  args: { minIntervalMs: number; options?: PruneOptions }
): Promise<number> {
  const state = getPruneState(db);
  const now = Date.now();
  if (now - state.lastPruneAtMs < args.minIntervalMs) return 0;

  if (state.pruneInFlight) return state.pruneInFlight;

  state.pruneInFlight = (async () => {
    try {
      const partitionIds = await readPrunePartitionIds(db);
      let deleted = 0;
      for (const partitionId of partitionIds) {
        const watermark = await computePruneWatermarkCommitSeq(
          db,
          args.options,
          partitionId
        );
        deleted += await pruneSync(db, {
          partitionId,
          watermarkCommitSeq: watermark,
          keepNewestCommits: args.options?.keepNewestCommits,
        });
      }
      state.lastPruneAtMs = Date.now();
      return deleted;
    } finally {
      state.pruneInFlight = null;
    }
  })();

  return state.pruneInFlight;
}
