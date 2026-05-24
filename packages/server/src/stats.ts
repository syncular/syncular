/**
 * @syncular/server - Observability helpers
 */

import type { Kysely, SelectQueryBuilder, SqlBool } from 'kysely';
import { sql } from 'kysely';
import { coerceNumber } from './dialect/helpers';
import type { SyncCoreDb } from './schema';

// biome-ignore lint/complexity/noBannedTypes: Kysely uses `{}` as the initial "no selected columns yet" marker.
type EmptySelection = {};

export interface SyncStats {
  commitCount: number;
  changeCount: number;
  minCommitSeq: number;
  maxCommitSeq: number;
  clientCount: number;
  activeClientCount: number;
  minActiveClientCursor: number | null;
  maxActiveClientCursor: number | null;
  snapshotChunkCount: number;
  snapshotChunkBytes: number;
  expiredSnapshotChunkCount: number;
  expiredSnapshotChunkBytes: number;
  snapshotArtifactCount: number;
  snapshotArtifactBytes: number;
  expiredSnapshotArtifactCount: number;
  expiredSnapshotArtifactBytes: number;
}

interface CachePressureRow {
  total_count: unknown;
  total_bytes: unknown;
  expired_count: unknown;
  expired_bytes: unknown;
}

function mapCachePressure(row: CachePressureRow | undefined): {
  count: number;
  bytes: number;
  expiredCount: number;
  expiredBytes: number;
} {
  return {
    count: coerceNumber(row?.total_count) ?? 0,
    bytes: coerceNumber(row?.total_bytes) ?? 0,
    expiredCount: coerceNumber(row?.expired_count) ?? 0,
    expiredBytes: coerceNumber(row?.expired_bytes) ?? 0,
  };
}

export async function readSyncStats<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  options: { activeWindowMs?: number; partitionId?: string } = {}
): Promise<SyncStats> {
  type SyncDb = Pick<Kysely<SyncCoreDb>, 'selectFrom'>;
  const syncDb = db as SyncDb;

  const activeWindowMs = options.activeWindowMs ?? 14 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - activeWindowMs).toISOString();
  const nowIso = new Date().toISOString();
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

  const partitionFilter = partitionId
    ? sql`where partition_id = ${partitionId}`
    : sql``;

  const [
    commitRow,
    changeRow,
    clientRow,
    activeClientRow,
    chunkPressureRow,
    artifactPressureRow,
  ] = await Promise.all([
    commitQuery.executeTakeFirst(),
    changeQuery.executeTakeFirst(),
    clientQuery.executeTakeFirst(),
    activeClientQuery.executeTakeFirst(),
    sql<CachePressureRow>`
      select
        count(*) as total_count,
        coalesce(sum(byte_length), 0) as total_bytes,
        coalesce(sum(case when expires_at <= ${nowIso} then 1 else 0 end), 0) as expired_count,
        coalesce(sum(case when expires_at <= ${nowIso} then byte_length else 0 end), 0) as expired_bytes
      from ${sql.table('sync_snapshot_chunks')}
      ${partitionFilter}
    `
      .execute(db)
      .then((result) => result.rows[0]),
    sql<CachePressureRow>`
      select
        count(*) as total_count,
        coalesce(sum(byte_length), 0) as total_bytes,
        coalesce(sum(case when expires_at <= ${nowIso} then 1 else 0 end), 0) as expired_count,
        coalesce(sum(case when expires_at <= ${nowIso} then byte_length else 0 end), 0) as expired_bytes
      from ${sql.table('sync_snapshot_artifacts')}
      ${partitionFilter}
    `
      .execute(db)
      .then((result) => result.rows[0]),
  ]);

  const chunkPressure = mapCachePressure(chunkPressureRow);
  const artifactPressure = mapCachePressure(artifactPressureRow);

  return {
    commitCount: coerceNumber(commitRow?.commitCount) ?? 0,
    changeCount: coerceNumber(changeRow?.changeCount) ?? 0,
    minCommitSeq: coerceNumber(commitRow?.minCommitSeq) ?? 0,
    maxCommitSeq: coerceNumber(commitRow?.maxCommitSeq) ?? 0,
    clientCount: coerceNumber(clientRow?.clientCount) ?? 0,
    activeClientCount: coerceNumber(activeClientRow?.activeClientCount) ?? 0,
    minActiveClientCursor: coerceNumber(activeClientRow?.minActiveClientCursor),
    maxActiveClientCursor: coerceNumber(activeClientRow?.maxActiveClientCursor),
    snapshotChunkCount: chunkPressure.count,
    snapshotChunkBytes: chunkPressure.bytes,
    expiredSnapshotChunkCount: chunkPressure.expiredCount,
    expiredSnapshotChunkBytes: chunkPressure.expiredBytes,
    snapshotArtifactCount: artifactPressure.count,
    snapshotArtifactBytes: artifactPressure.bytes,
    expiredSnapshotArtifactCount: artifactPressure.expiredCount,
    expiredSnapshotArtifactBytes: artifactPressure.expiredBytes,
  };
}
