/**
 * @syncular/server - S3-compatible snapshot chunk storage adapter
 *
 * Stores snapshot chunk bodies in S3/R2/MinIO with metadata in database.
 */

import type { BlobStorageAdapter } from '@syncular/core';
import type { Kysely } from 'kysely';
import type { SyncCoreDb } from '../../schema';
import { createDbMetadataChunkStorage } from '../db-metadata';

export interface S3SnapshotChunkStorageOptions {
  /** Database instance for metadata */
  db: Kysely<SyncCoreDb>;
  /** S3 blob storage adapter */
  s3Adapter: BlobStorageAdapter;
  /** Optional key prefix for all chunks */
  keyPrefix?: string;
}

/**
 * Create S3-compatible snapshot chunk storage.
 *
 * Stores chunk bodies in S3/R2/MinIO and metadata in the database.
 * Supports presigned URLs for direct client downloads.
 *
 * @example
 * ```typescript
 * import { createS3BlobStorageAdapter } from '@syncular/server/blobs/adapters/s3';
 * import { createS3SnapshotChunkStorage } from '@syncular/server/snapshot-chunks/adapters/s3';
 *
 * const s3Adapter = createS3BlobStorageAdapter({
 *   client: new S3Client({ region: 'us-east-1' }),
 *   bucket: 'my-snapshot-chunks',
 *   commands: { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand },
 *   getSignedUrl,
 * });
 *
 * const chunkStorage = createS3SnapshotChunkStorage({
 *   db: kysely,
 *   s3Adapter,
 *   keyPrefix: 'snapshots/',
 * });
 * ```
 */
export function createS3SnapshotChunkStorage(
  options: S3SnapshotChunkStorageOptions
) {
  const { db, s3Adapter, keyPrefix } = options;

  // Wrap the S3 adapter to use prefixed keys
  const prefixedAdapter: BlobStorageAdapter = keyPrefix
    ? {
        ...s3Adapter,
        name: `${s3Adapter.name}+prefixed`,
        // Keys are already handled by the S3 adapter, prefix is applied there
      }
    : s3Adapter;

  // Use the database metadata storage with S3 for bodies
  const storage = createDbMetadataChunkStorage({
    db,
    blobAdapter: prefixedAdapter,
    chunkIdPrefix: keyPrefix ? `${keyPrefix.replace(/\/$/, '')}_` : 'chunk_',
  });

  return storage;
}
