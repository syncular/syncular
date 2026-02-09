/**
 * @syncular/server - Database-backed metadata store for snapshot chunks
 *
 * Stores chunk metadata in sync_snapshot_chunks_metadata table,
 * body content in blob storage adapter.
 */

import { createHash } from 'node:crypto';
import type { BlobStorageAdapter, SyncSnapshotChunkRef } from '@syncular/core';
import type { Kysely } from 'kysely';
import type { SyncCoreDb } from '../schema';
import type { SnapshotChunkMetadata, SnapshotChunkPageKey } from './types';

export interface DbMetadataSnapshotChunkStorageOptions {
  /** Database instance */
  db: Kysely<SyncCoreDb>;
  /** Blob storage adapter for body content */
  blobAdapter: BlobStorageAdapter;
  /** Optional prefix for chunk IDs */
  chunkIdPrefix?: string;
}

/**
 * Create a snapshot chunk storage that uses:
 * - Database for metadata (scope, commit seq, etc.)
 * - Blob adapter for body content
 */
export function createDbMetadataChunkStorage(
  options: DbMetadataSnapshotChunkStorageOptions
): {
  name: string;
  storeChunk: (
    metadata: Omit<
      SnapshotChunkMetadata,
      'chunkId' | 'byteLength' | 'blobHash'
    > & {
      body: Uint8Array;
    }
  ) => Promise<SyncSnapshotChunkRef>;
  readChunk: (chunkId: string) => Promise<Uint8Array | null>;
  findChunk: (
    pageKey: SnapshotChunkPageKey
  ) => Promise<SyncSnapshotChunkRef | null>;
  cleanupExpired: (beforeIso: string) => Promise<number>;
} {
  const { db, blobAdapter, chunkIdPrefix = 'chunk_' } = options;

  // Generate deterministic blob hash from content
  function computeBlobHash(body: Uint8Array): string {
    return `sha256:${createHash('sha256').update(body).digest('hex')}`;
  }

  // Generate unique chunk ID
  function generateChunkId(): string {
    return `${chunkIdPrefix}${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  return {
    name: `db-metadata+${blobAdapter.name}`,

    async storeChunk(
      metadata: Omit<
        SnapshotChunkMetadata,
        'chunkId' | 'byteLength' | 'blobHash'
      > & {
        body: Uint8Array;
      }
    ): Promise<SyncSnapshotChunkRef> {
      const { body, ...metaWithoutBody } = metadata;
      const blobHash = computeBlobHash(body);
      const chunkId = generateChunkId();
      const now = new Date().toISOString();

      // Check if blob already exists (content-addressed dedup)
      const blobExists = await blobAdapter.exists(blobHash);

      if (!blobExists) {
        // Store body in blob adapter
        if (blobAdapter.put) {
          await blobAdapter.put(blobHash, body);
        } else {
          throw new Error(
            `Blob adapter ${blobAdapter.name} does not support direct put() for snapshot chunks`
          );
        }
      }

      // Upsert metadata in database
      await db
        .insertInto('sync_snapshot_chunks')
        .values({
          chunk_id: chunkId,
          scope_key: metaWithoutBody.scopeKey,
          scope: metaWithoutBody.scope,
          as_of_commit_seq: metaWithoutBody.asOfCommitSeq,
          row_cursor: metaWithoutBody.rowCursor ?? '',
          row_limit: metaWithoutBody.rowLimit,
          encoding: metaWithoutBody.encoding,
          compression: metaWithoutBody.compression,
          sha256: metaWithoutBody.sha256,
          byte_length: body.length,
          blob_hash: blobHash,
          expires_at: metaWithoutBody.expiresAt,
          created_at: now,
        })
        .onConflict((oc) =>
          oc
            .columns([
              'scope_key',
              'scope',
              'as_of_commit_seq',
              'row_cursor',
              'row_limit',
              'encoding',
              'compression',
            ])
            .doUpdateSet({
              expires_at: metaWithoutBody.expiresAt,
              blob_hash: blobHash,
              sha256: metaWithoutBody.sha256,
              byte_length: body.length,
              row_cursor: metaWithoutBody.rowCursor ?? '',
            })
        )
        .execute();

      return {
        id: chunkId,
        sha256: metaWithoutBody.sha256,
        byteLength: body.length,
        encoding: metaWithoutBody.encoding,
        compression: metaWithoutBody.compression,
      };
    },

    async readChunk(chunkId: string): Promise<Uint8Array | null> {
      // Get metadata to find blob hash
      const row = await db
        .selectFrom('sync_snapshot_chunks')
        .select(['blob_hash'])
        .where('chunk_id', '=', chunkId)
        .executeTakeFirst();

      if (!row) return null;

      // Read from blob adapter
      if (blobAdapter.get) {
        return blobAdapter.get(row.blob_hash);
      }

      throw new Error(
        `Blob adapter ${blobAdapter.name} does not support direct get() for snapshot chunks`
      );
    },

    async findChunk(
      pageKey: SnapshotChunkPageKey
    ): Promise<SyncSnapshotChunkRef | null> {
      const nowIso = new Date().toISOString();
      const rowCursorKey = pageKey.rowCursor ?? '';

      const row = await db
        .selectFrom('sync_snapshot_chunks')
        .select([
          'chunk_id',
          'sha256',
          'byte_length',
          'encoding',
          'compression',
        ])
        .where('scope_key', '=', pageKey.scopeKey)
        .where('scope', '=', pageKey.scope)
        .where('as_of_commit_seq', '=', pageKey.asOfCommitSeq)
        .where('row_cursor', '=', rowCursorKey)
        .where('row_limit', '=', pageKey.rowLimit)
        .where('encoding', '=', pageKey.encoding)
        .where('compression', '=', pageKey.compression)
        .where('expires_at', '>', nowIso)
        .executeTakeFirst();

      if (!row) return null;

      if (row.encoding !== 'ndjson') {
        throw new Error(
          `Unexpected snapshot chunk encoding: ${String(row.encoding)}`
        );
      }
      if (row.compression !== 'gzip') {
        throw new Error(
          `Unexpected snapshot chunk compression: ${String(row.compression)}`
        );
      }

      return {
        id: row.chunk_id,
        sha256: row.sha256,
        byteLength: Number(row.byte_length ?? 0),
        encoding: row.encoding,
        compression: row.compression,
      };
    },

    async cleanupExpired(beforeIso: string): Promise<number> {
      // Find expired chunks
      const expiredRows = await db
        .selectFrom('sync_snapshot_chunks')
        .select(['chunk_id', 'blob_hash'])
        .where('expires_at', '<=', beforeIso)
        .execute();

      if (expiredRows.length === 0) return 0;

      // Delete from blob storage (best effort)
      for (const row of expiredRows) {
        try {
          await blobAdapter.delete(row.blob_hash);
        } catch {
          // Ignore deletion errors - blob may be shared or already deleted
          // Log for observability but don't fail the cleanup
          console.warn(
            `Failed to delete blob ${row.blob_hash} for chunk ${row.chunk_id}, may be already deleted or shared`
          );
        }
      }

      // Delete metadata from database
      const result = await db
        .deleteFrom('sync_snapshot_chunks')
        .where('expires_at', '<=', beforeIso)
        .executeTakeFirst();

      return Number(result.numDeletedRows ?? 0);
    },
  };
}
