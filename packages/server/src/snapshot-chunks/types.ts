/**
 * @syncular/server - Snapshot chunk storage types
 *
 * Separates chunk metadata (in database) from chunk body (in blob storage).
 * Enables flexible storage backends (database, S3, R2, etc.)
 */

import type {
  SyncSnapshotChunkCompression,
  SyncSnapshotChunkEncoding,
  SyncSnapshotChunkRef,
} from '@syncular/core';

/**
 * Page key for identifying a specific chunk
 */
export interface SnapshotChunkPageKey {
  partitionId: string;
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  encoding: SyncSnapshotChunkEncoding;
  compression: SyncSnapshotChunkCompression;
}

/**
 * Metadata stored in the database for each chunk
 */
export interface SnapshotChunkMetadata {
  chunkId: string;
  partitionId: string;
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  encoding: SyncSnapshotChunkEncoding;
  compression: SyncSnapshotChunkCompression;
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
   * Store a chunk from a stream.
   * Preferred for large payloads to avoid full buffering in memory.
   */
  storeChunkStream?(
    metadata: Omit<
      SnapshotChunkMetadata,
      'chunkId' | 'byteLength' | 'blobHash'
    > & {
      bodyStream: ReadableStream<Uint8Array>;
      byteLength?: number;
    }
  ): Promise<SyncSnapshotChunkRef>;

  /**
   * Read chunk body by chunk ID
   */
  readChunk(chunkId: string): Promise<Uint8Array | null>;

  /**
   * Read chunk body as a stream.
   * Preferred for large payloads to avoid full buffering in memory.
   */
  readChunkStream?(chunkId: string): Promise<ReadableStream<Uint8Array> | null>;

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
