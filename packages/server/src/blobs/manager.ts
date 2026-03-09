/**
 * Server-side blob manager.
 *
 * Orchestrates blob uploads and downloads using a pluggable storage adapter.
 * Handles metadata tracking, upload verification, and garbage collection.
 */

import type {
  BlobMetadata,
  BlobStorageAdapter,
  BlobUploadCompleteResponse,
  BlobUploadInitResponse,
} from '@syncular/core';
import { parseBlobHash } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { SyncBlobUploadsDb } from './types';

// ============================================================================
// Blob Manager
// ============================================================================

export interface BlobManagerOptions<
  DB extends SyncBlobUploadsDb = SyncBlobUploadsDb,
> {
  /** Database instance for tracking uploads */
  db: Kysely<DB>;
  /** Storage adapter (S3, R2, database, etc.) */
  adapter: BlobStorageAdapter;
  /** Default presigned URL expiration in seconds. Default: 3600 (1 hour) */
  defaultExpiresIn?: number;
  /** How long incomplete uploads are kept before cleanup. Default: 86400 (24 hours) */
  uploadTtlSeconds?: number;
  /** Optional cleanup throughput tuning knobs. */
  cleanupTuning?: BlobCleanupTuning;
}

export interface BlobCleanupTuning {
  /** Cleanup select/delete batch size. Default: 250 */
  batchSize?: number;
  /** Max concurrent storage deletes during cleanup. Default: 8 */
  storageDeleteConcurrency?: number;
  /** Max concurrent reference checks for completed uploads. Default: 16 */
  referenceCheckConcurrency?: number;
}

export const BLOB_CLEANUP_TUNING_PRESETS = {
  server: {
    batchSize: 500,
    storageDeleteConcurrency: 16,
    referenceCheckConcurrency: 24,
  },
  edge: {
    batchSize: 100,
    storageDeleteConcurrency: 4,
    referenceCheckConcurrency: 8,
  },
} as const satisfies Record<'server' | 'edge', Required<BlobCleanupTuning>>;

export interface InitiateUploadOptions {
  hash: string;
  size: number;
  mimeType: string;
  actorId: string;
  partitionId?: string;
}

export interface GetDownloadUrlOptions {
  hash: string;
  /** Optional: verify actor has access to this blob via a scope check */
  actorId?: string;
  partitionId?: string;
}

export interface CompleteUploadOptions {
  /**
   * Optional actor identity to authorize upload completion.
   * When provided, only the initiating actor may mark an upload complete.
   */
  actorId?: string;
  partitionId?: string;
}

export interface BlobUploadRecord {
  partitionId: string;
  hash: string;
  size: number;
  mimeType: string;
  status: 'pending' | 'complete';
  actorId: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}

/**
 * Create a blob manager for handling server-side blob operations.
 */
export function createBlobManager<DB extends SyncBlobUploadsDb>(
  options: BlobManagerOptions<DB>
) {
  const {
    db,
    adapter,
    defaultExpiresIn = 3600,
    uploadTtlSeconds = 86400,
    cleanupTuning,
  } = options;

  function positiveIntOrDefault(value: number | undefined, fallback: number) {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value)) return fallback;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : fallback;
  }

  function resolvePartitionId(partitionId?: string): string {
    return partitionId ?? 'default';
  }

  function normalizeBlobSizeValue(value: number | string): number {
    return typeof value === 'number' ? value : Number(value);
  }

  function toStoragePartitionOptions(partitionId: string): {
    partitionId?: string;
  } {
    if (partitionId === 'default') return {};
    return { partitionId };
  }

  const CLEANUP_BATCH_SIZE = positiveIntOrDefault(
    cleanupTuning?.batchSize,
    250
  );
  const STORAGE_DELETE_CONCURRENCY = positiveIntOrDefault(
    cleanupTuning?.storageDeleteConcurrency,
    8
  );
  const REFERENCE_CHECK_CONCURRENCY = positiveIntOrDefault(
    cleanupTuning?.referenceCheckConcurrency,
    16
  );

  async function runWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    if (items.length === 0) return;

    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    async function runWorker(): Promise<void> {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) continue;
        await worker(item);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  }

  async function deleteUploadRowsByHashes(
    partitionId: string,
    hashes: readonly string[]
  ): Promise<number> {
    if (hashes.length === 0) return 0;

    const deletedResult = await sql`
      delete from ${sql.table('sync_blob_uploads')}
      where partition_id = ${partitionId}
        and hash in (${sql.join(hashes)})
    `.execute(db);

    return Number(deletedResult.numAffectedRows ?? 0);
  }

  return {
    /**
     * Initiate a blob upload.
     *
     * Checks for deduplication and returns a presigned URL for uploading.
     */
    async initiateUpload(
      opts: InitiateUploadOptions
    ): Promise<BlobUploadInitResponse> {
      const { hash, size, mimeType, actorId } = opts;
      const partitionId = resolvePartitionId(opts.partitionId);
      const storagePartitionOptions = toStoragePartitionOptions(partitionId);

      // Validate hash format
      if (!parseBlobHash(hash)) {
        throw new BlobValidationError('Invalid blob hash format');
      }

      // Check if blob already exists (deduplication)
      const exists = await adapter.exists(hash, storagePartitionOptions);
      if (exists) {
        // Also check if we have a complete upload record
        const existingResult = await sql<{ status: 'pending' | 'complete' }>`
          select status
          from ${sql.table('sync_blob_uploads')}
          where partition_id = ${partitionId}
            and hash = ${hash}
            and status = 'complete'
          limit 1
        `.execute(db);
        const existing = existingResult.rows[0];

        if (existing) {
          return { exists: true };
        }

        // Blob exists in storage but we don't have a record - create one
        const existsExpiresAt = new Date(
          Date.now() + uploadTtlSeconds * 1000
        ).toISOString();
        const existsCompletedAt = new Date().toISOString();

        await sql`
          insert into ${sql.table('sync_blob_uploads')} (
            partition_id,
            hash,
            size,
            mime_type,
            status,
            actor_id,
            expires_at,
            completed_at
          )
          values (
            ${partitionId},
            ${hash},
            ${size},
            ${mimeType},
            'complete',
            ${actorId},
            ${existsExpiresAt},
            ${existsCompletedAt}
          )
          on conflict (partition_id, hash) do nothing
        `.execute(db);

        return { exists: true };
      }

      // Create pending upload record
      const expiresAt = new Date(
        Date.now() + uploadTtlSeconds * 1000
      ).toISOString();

      await sql`
        insert into ${sql.table('sync_blob_uploads')} (
          partition_id,
          hash,
          size,
          mime_type,
          status,
          actor_id,
          expires_at,
          completed_at
        )
        values (
          ${partitionId},
          ${hash},
          ${size},
          ${mimeType},
          'pending',
          ${actorId},
          ${expiresAt},
          ${null}
        )
        on conflict (partition_id, hash)
        do update set
          size = ${size},
          mime_type = ${mimeType},
          status = 'pending',
          actor_id = ${actorId},
          expires_at = ${expiresAt},
          completed_at = ${null}
      `.execute(db);

      // Generate presigned upload URL
      const signed = await adapter.signUpload({
        hash,
        partitionId: storagePartitionOptions.partitionId,
        size,
        mimeType,
        expiresIn: defaultExpiresIn,
      });

      return {
        exists: false,
        uploadId: hash, // Use hash as upload ID
        uploadUrl: signed.url,
        uploadMethod: signed.method,
        uploadHeaders: signed.headers,
      };
    },

    /**
     * Complete a blob upload.
     *
     * Verifies the blob exists in storage and marks the upload as complete.
     */
    async completeUpload(
      hash: string,
      options?: CompleteUploadOptions
    ): Promise<BlobUploadCompleteResponse> {
      const partitionId = resolvePartitionId(options?.partitionId);
      const storagePartitionOptions = toStoragePartitionOptions(partitionId);

      // Validate hash format
      if (!parseBlobHash(hash)) {
        return { ok: false, error: 'Invalid blob hash format' };
      }

      // Check upload record exists
      const uploadResult = await sql<{
        hash: string;
        size: number | string;
        mime_type: string;
        status: 'pending' | 'complete';
        actor_id: string;
        created_at: string;
      }>`
        select hash, size, mime_type, status, actor_id, created_at
        from ${sql.table('sync_blob_uploads')}
        where partition_id = ${partitionId} and hash = ${hash}
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        return { ok: false, error: 'Upload not found' };
      }

      if (
        options?.actorId !== undefined &&
        upload.actor_id !== options.actorId
      ) {
        return { ok: false, error: 'FORBIDDEN' };
      }

      if (upload.status === 'complete') {
        const uploadSize = normalizeBlobSizeValue(upload.size);
        // Already complete - return metadata
        return {
          ok: true,
          metadata: {
            hash: upload.hash,
            size: uploadSize,
            mimeType: upload.mime_type,
            createdAt: upload.created_at,
            uploadComplete: true,
          },
        };
      }

      // Verify blob exists in storage
      const exists = await adapter.exists(hash, storagePartitionOptions);
      if (!exists) {
        return { ok: false, error: 'Blob not found in storage' };
      }

      // Optionally verify size matches
      const uploadSize = normalizeBlobSizeValue(upload.size);
      if (adapter.getMetadata) {
        const meta = await adapter.getMetadata(hash, storagePartitionOptions);
        if (meta && meta.size !== uploadSize) {
          return {
            ok: false,
            error: `Size mismatch: expected ${uploadSize}, got ${meta.size}`,
          };
        }
      }

      // Mark upload as complete
      const completedAt = new Date().toISOString();
      await sql`
        update ${sql.table('sync_blob_uploads')}
        set status = 'complete', completed_at = ${completedAt}
        where partition_id = ${partitionId} and hash = ${hash}
      `.execute(db);

      return {
        ok: true,
        metadata: {
          hash: upload.hash,
          size: uploadSize,
          mimeType: upload.mime_type,
          createdAt: upload.created_at,
          uploadComplete: true,
        },
      };
    },

    /**
     * Get a presigned download URL for a blob.
     */
    async getDownloadUrl(
      opts: GetDownloadUrlOptions
    ): Promise<{ url: string; expiresAt: string; metadata: BlobMetadata }> {
      const { hash } = opts;
      const partitionId = resolvePartitionId(opts.partitionId);
      const storagePartitionOptions = toStoragePartitionOptions(partitionId);

      // Validate hash format
      if (!parseBlobHash(hash)) {
        throw new BlobNotFoundError('Invalid blob hash format');
      }

      // Get upload record (must be complete)
      const uploadResult = await sql<{
        hash: string;
        size: number | string;
        mime_type: string;
        status: 'pending' | 'complete';
        created_at: string;
      }>`
        select hash, size, mime_type, status, created_at
        from ${sql.table('sync_blob_uploads')}
        where partition_id = ${partitionId}
          and hash = ${hash}
          and status = 'complete'
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        throw new BlobNotFoundError('Blob not found');
      }

      // Generate presigned download URL
      const url = await adapter.signDownload({
        hash,
        partitionId: storagePartitionOptions.partitionId,
        expiresIn: defaultExpiresIn,
      });

      const expiresAt = new Date(
        Date.now() + defaultExpiresIn * 1000
      ).toISOString();

      return {
        url,
        expiresAt,
        metadata: {
          hash: upload.hash,
          size: normalizeBlobSizeValue(upload.size),
          mimeType: upload.mime_type,
          createdAt: upload.created_at,
          uploadComplete: true,
        },
      };
    },

    /**
     * Get upload record for a blob hash, including pending uploads.
     */
    async getUploadRecord(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<BlobUploadRecord | null> {
      const partitionId = resolvePartitionId(options?.partitionId);
      if (!parseBlobHash(hash)) {
        return null;
      }

      const uploadResult = await sql<{
        partition_id: string;
        hash: string;
        size: number | string;
        mime_type: string;
        status: 'pending' | 'complete';
        actor_id: string;
        created_at: string;
        expires_at: string;
        completed_at: string | null;
      }>`
        select
          partition_id,
          hash,
          size,
          mime_type,
          status,
          actor_id,
          created_at,
          expires_at,
          completed_at
        from ${sql.table('sync_blob_uploads')}
        where partition_id = ${partitionId} and hash = ${hash}
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        return null;
      }

      return {
        partitionId: upload.partition_id,
        hash: upload.hash,
        size: normalizeBlobSizeValue(upload.size),
        mimeType: upload.mime_type,
        status: upload.status,
        actorId: upload.actor_id,
        createdAt: upload.created_at,
        expiresAt: upload.expires_at,
        completedAt: upload.completed_at,
      };
    },

    /**
     * Get blob metadata without generating a download URL.
     */
    async getMetadata(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<BlobMetadata | null> {
      const partitionId = resolvePartitionId(options?.partitionId);
      // Validate hash format
      if (!parseBlobHash(hash)) {
        return null;
      }

      const uploadResult = await sql<{
        hash: string;
        size: number | string;
        mime_type: string;
        status: 'pending' | 'complete';
        created_at: string;
      }>`
        select hash, size, mime_type, status, created_at
        from ${sql.table('sync_blob_uploads')}
        where partition_id = ${partitionId}
          and hash = ${hash}
          and status = 'complete'
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        return null;
      }

      return {
        hash: upload.hash,
        size: normalizeBlobSizeValue(upload.size),
        mimeType: upload.mime_type,
        createdAt: upload.created_at,
        uploadComplete: true,
      };
    },

    /**
     * Check if a blob exists and is complete.
     */
    async exists(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<boolean> {
      const partitionId = resolvePartitionId(options?.partitionId);
      if (!parseBlobHash(hash)) return false;

      const rowResult = await sql<{ hash: string }>`
        select hash
        from ${sql.table('sync_blob_uploads')}
        where partition_id = ${partitionId}
          and hash = ${hash}
          and status = 'complete'
        limit 1
      `.execute(db);

      return rowResult.rows.length > 0;
    },

    /**
     * Clean up expired/orphaned uploads.
     *
     * Deletes upload records (and optionally storage) for:
     * - Pending uploads that have expired
     * - Completed uploads with no references (if refCheck provided)
     */
    async cleanup(options?: {
      /** Check if a blob hash is referenced by any row */
      isReferenced?: (hash: string) => Promise<boolean>;
      /** Delete from storage too (not just tracking table) */
      deleteFromStorage?: boolean;
      /** Optional partition filter for cleanup */
      partitionId?: string;
    }): Promise<{ deleted: number }> {
      const now = new Date().toISOString();
      const partitionId = resolvePartitionId(options?.partitionId);
      const storagePartitionOptions = toStoragePartitionOptions(partitionId);

      let deleted = 0;

      // Find and delete expired pending uploads in batches.
      while (true) {
        const expiredResult = await sql<{ hash: string }>`
          select hash
          from ${sql.table('sync_blob_uploads')}
          where partition_id = ${partitionId}
            and status = 'pending'
            and expires_at < ${now}
          order by expires_at asc
          limit ${CLEANUP_BATCH_SIZE}
        `.execute(db);
        const expiredHashes = expiredResult.rows
          .map((row) => row.hash)
          .filter((hash): hash is string => typeof hash === 'string');

        if (expiredHashes.length === 0) {
          break;
        }

        if (options?.deleteFromStorage) {
          await runWithConcurrency(
            expiredHashes,
            STORAGE_DELETE_CONCURRENCY,
            async (hash) => {
              try {
                await adapter.delete(hash, storagePartitionOptions);
              } catch {
                // Ignore storage errors during cleanup
              }
            }
          );
        }

        deleted += await deleteUploadRowsByHashes(partitionId, expiredHashes);

        if (expiredHashes.length < CLEANUP_BATCH_SIZE) {
          break;
        }
      }

      // If reference check provided, also clean up unreferenced complete uploads
      // in batches with bounded parallelism.
      if (options?.isReferenced) {
        const isReferenced = options.isReferenced;
        let afterHash: string | null = null;

        while (true) {
          let completeRows: Array<{ hash: string }>;
          if (afterHash === null) {
            const completeResult = await sql<{ hash: string }>`
              select hash
              from ${sql.table('sync_blob_uploads')}
              where partition_id = ${partitionId}
                and status = 'complete'
              order by hash asc
              limit ${CLEANUP_BATCH_SIZE}
            `.execute(db);
            completeRows = completeResult.rows;
          } else {
            const completeResult = await sql<{ hash: string }>`
              select hash
              from ${sql.table('sync_blob_uploads')}
              where partition_id = ${partitionId}
                and status = 'complete'
                and hash > ${afterHash}
              order by hash asc
              limit ${CLEANUP_BATCH_SIZE}
            `.execute(db);
            completeRows = completeResult.rows;
          }

          const completeHashes = completeRows
            .map((row) => row.hash)
            .filter((hash): hash is string => typeof hash === 'string');

          if (completeHashes.length === 0) {
            break;
          }

          afterHash = completeHashes[completeHashes.length - 1] ?? afterHash;

          const unreferencedHashes: string[] = [];
          await runWithConcurrency(
            completeHashes,
            REFERENCE_CHECK_CONCURRENCY,
            async (hash) => {
              const referenced = await isReferenced(hash);
              if (!referenced) {
                unreferencedHashes.push(hash);
              }
            }
          );

          if (unreferencedHashes.length > 0) {
            if (options?.deleteFromStorage) {
              await runWithConcurrency(
                unreferencedHashes,
                STORAGE_DELETE_CONCURRENCY,
                async (hash) => {
                  try {
                    await adapter.delete(hash, storagePartitionOptions);
                  } catch {
                    // Ignore storage errors during cleanup
                  }
                }
              );
            }

            deleted += await deleteUploadRowsByHashes(
              partitionId,
              unreferencedHashes
            );
          }

          if (completeHashes.length < CLEANUP_BATCH_SIZE) {
            break;
          }
        }
      }

      return { deleted };
    },

    /** The underlying storage adapter */
    adapter,
  };
}

export type BlobManager = ReturnType<typeof createBlobManager>;

// ============================================================================
// Garbage Collection Scheduler
// ============================================================================

export interface BlobCleanupSchedulerOptions {
  /** Blob manager instance */
  blobManager: BlobManager;
  /** Interval between cleanup runs in milliseconds. Default: 3600000 (1 hour) */
  intervalMs?: number;
  /** Delete from storage too (not just tracking table). Default: true */
  deleteFromStorage?: boolean;
  /** Optional: Check if a blob hash is referenced by any row */
  isReferenced?: (hash: string) => Promise<boolean>;
  /** Optional partition to scope cleanup. Defaults to "default". */
  partitionId?: string;
  /** Optional: Called after each cleanup run */
  onCleanup?: (result: { deleted: number; error?: Error }) => void;
}

/**
 * Create a garbage collection scheduler for blob storage.
 *
 * Periodically runs cleanup to remove:
 * - Expired pending uploads
 * - Unreferenced blobs (if isReferenced callback provided)
 *
 * @example
 * ```typescript
 * const scheduler = createBlobCleanupScheduler({
 *   blobManager,
 *   intervalMs: 60 * 60 * 1000, // 1 hour
 *   deleteFromStorage: true,
 *   isReferenced: async (hash) => {
 *     const row = await db.selectFrom('my_table')
 *       .select('id')
 *       .where('blob_hash', '=', hash)
 *       .executeTakeFirst();
 *     return !!row;
 *   },
 *   onCleanup: (result) => {
 *     console.log(`Cleanup complete: ${result.deleted} blobs removed`);
 *   },
 * });
 *
 * // Start the scheduler
 * scheduler.start();
 *
 * // Stop when shutting down
 * scheduler.stop();
 * ```
 */
export function createBlobCleanupScheduler(
  options: BlobCleanupSchedulerOptions
) {
  const {
    blobManager,
    intervalMs = 3600000, // 1 hour
    deleteFromStorage = true,
    isReferenced,
    partitionId,
    onCleanup,
  } = options;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  const runCleanup = async (): Promise<{ deleted: number; error?: Error }> => {
    if (isRunning) {
      return { deleted: 0 };
    }

    isRunning = true;

    try {
      const result = await blobManager.cleanup({
        deleteFromStorage,
        isReferenced,
        partitionId,
      });

      onCleanup?.({ deleted: result.deleted });
      return { deleted: result.deleted };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onCleanup?.({ deleted: 0, error });
      return { deleted: 0, error };
    } finally {
      isRunning = false;
    }
  };

  return {
    /**
     * Start the cleanup scheduler.
     * Optionally runs an immediate cleanup before starting the interval.
     */
    start(options?: { immediate?: boolean }): void {
      if (intervalId) {
        return; // Already running
      }

      if (options?.immediate) {
        void runCleanup();
      }

      intervalId = setInterval(() => {
        void runCleanup();
      }, intervalMs);
    },

    /**
     * Stop the cleanup scheduler.
     */
    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    /**
     * Run a single cleanup manually.
     */
    async runOnce(): Promise<{ deleted: number; error?: Error }> {
      return runCleanup();
    },

    /**
     * Check if the scheduler is currently active.
     */
    get active(): boolean {
      return intervalId !== null;
    },

    /**
     * Check if a cleanup is currently in progress.
     */
    get running(): boolean {
      return isRunning;
    },
  };
}

// ============================================================================
// Errors
// ============================================================================

export class BlobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobValidationError';
  }
}

export class BlobNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobNotFoundError';
  }
}
