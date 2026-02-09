/**
 * @syncular/server - Snapshot chunk storage types
 *
 * Separates chunk metadata (in database) from chunk body (in blob storage).
 * Enables flexible storage backends (database, S3, R2, etc.)
 */

import type { SyncSnapshotChunkRef } from '@syncular/core';

/**
 * Page key for identifying a specific chunk
 */
export interface SnapshotChunkPageKey {
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  encoding: 'ndjson';
  compression: 'gzip';
}

/**
 * Metadata stored in the database for each chunk
 */
export interface SnapshotChunkMetadata {
  chunkId: string;
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  encoding: 'ndjson';
  compression: 'gzip';
  sha256: string;
  byteLength: number;
  blobHash: string; // Reference to blob storage
  expiresAt: string;
}

/**
 * Storage interface for snapshot chunks
 */
export interface SnapshotChunkStorage {
  /** Storage adapter name */
  readonly name: string;

  /**
   * Store a chunk. Returns chunk reference.
   * If chunk with same content already exists (by hash), returns existing reference.
   */
  storeChunk(
    metadata: Omit<
      SnapshotChunkMetadata,
      'chunkId' | 'byteLength' | 'blobHash'
    > & {
      body: Uint8Array;
    }
  ): Promise<SyncSnapshotChunkRef>;

  /**
   * Read chunk body by chunk ID
   */
  readChunk(chunkId: string): Promise<Uint8Array | null>;

  /**
   * Find existing chunk by page key
   */
  findChunk(
    pageKey: SnapshotChunkPageKey
  ): Promise<SyncSnapshotChunkRef | null>;

  /**
   * Delete expired chunks. Returns number deleted.
   */
  cleanupExpired(beforeIso: string): Promise<number>;
}
