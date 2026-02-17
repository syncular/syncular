/**
 * @syncular/server - Observability helpers
 */

import type { Kysely, SelectQueryBuilder, SqlBool } from 'kysely';
import { sql } from 'kysely';
import type { SyncCoreDb } from './schema';

// biome-ignore lint/complexity/noBannedTypes: Kysely uses `{}` as the initial "no selected columns yet" marker.
type EmptySelection = {};

function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint')
    return Number.isFinite(Number(value)) ? Number(value) : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface SyncStats {
  commitCount: number;
  changeCount: number;
  minCommitSeq: number;
  maxCommitSeq: number;
  clientCount: number;
  activeClientCount: number;
  minActiveClientCursor: number | null;
  maxActiveClientCursor: number | null;
}

export async function readSyncStats<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  options: { activeWindowMs?: number; partitionId?: string } = {}
): Promise<SyncStats> {
  type SyncDb = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const syncDb = db as SyncDb;

  const activeWindowMs = options.activeWindowMs ?? 14 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - activeWindowMs).toISOString();
  const partitionId = options.partitionId;

  let commitQuery = (
    syncDb.selectFrom('sync_commits') as SelectQueryBuilder<
      SyncCoreDb,
      'sync_commits',
      EmptySelection
    >
  ).select(({ fn }) => [
    fn.countAll().as('commitCount'),
    fn.min('commit_seq').as('minCommitSeq'),
    fn.max('commit_seq').as('maxCommitSeq'),
  ]);

  let changeQuery = (
    syncDb.selectFrom('sync_changes') as SelectQueryBuilder<
      SyncCoreDb,
      'sync_changes',
      EmptySelection
    >
  ).select(({ fn }) => [fn.countAll().as('changeCount')]);

  let clientQuery = (
    syncDb.selectFrom('sync_client_cursors') as SelectQueryBuilder<
      SyncCoreDb,
      'sync_client_cursors',
      EmptySelection
    >
  ).select(({ fn }) => [fn.countAll().as('clientCount')]);

  let activeClientQuery = (
    syncDb.selectFrom('sync_client_cursors') as SelectQueryBuilder<
      SyncCoreDb,
      'sync_client_cursors',
      EmptySelection
    >
  )
    .where(sql<SqlBool>`updated_at >= ${cutoffIso}`)
    .where(sql<SqlBool>`cursor >= ${0}`)
    .select(({ fn }) => [
      fn.countAll().as('activeClientCount'),
      fn.min('cursor').as('minActiveClientCursor'),
      fn.max('cursor').as('maxActiveClientCursor'),
    ]);

  if (partitionId) {
    commitQuery = commitQuery.where('partition_id', '=', partitionId);
    changeQuery = changeQuery.where('partition_id', '=', partitionId);
    clientQuery = clientQuery.where('partition_id', '=', partitionId);
    activeClientQuery = activeClientQuery.where(
      'partition_id',
      '=',
      partitionId
    );
  }

  const [commitRow, changeRow, clientRow, activeClientRow] = await Promise.all([
    commitQuery.executeTakeFirst(),
    changeQuery.executeTakeFirst(),
    clientQuery.executeTakeFirst(),
    activeClientQuery.executeTakeFirst(),
  ]);

  return {
    commitCount: coerceNumber(commitRow?.commitCount) ?? 0,
    changeCount: coerceNumber(changeRow?.changeCount) ?? 0,
    minCommitSeq: coerceNumber(commitRow?.minCommitSeq) ?? 0,
    maxCommitSeq: coerceNumber(commitRow?.maxCommitSeq) ?? 0,
    clientCount: coerceNumber(clientRow?.clientCount) ?? 0,
    activeClientCount: coerceNumber(activeClientRow?.activeClientCount) ?? 0,
    minActiveClientCursor: coerceNumber(activeClientRow?.minActiveClientCursor),
    maxActiveClientCursor: coerceNumber(activeClientRow?.maxActiveClientCursor),
  };
}
