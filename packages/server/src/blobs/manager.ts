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
}

export interface InitiateUploadOptions {
  hash: string;
  size: number;
  mimeType: string;
  actorId: string;
}

export interface GetDownloadUrlOptions {
  hash: string;
  /** Optional: verify actor has access to this blob via a scope check */
  actorId?: string;
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
  } = options;

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

      // Validate hash format
      if (!parseBlobHash(hash)) {
        throw new BlobValidationError('Invalid blob hash format');
      }

      // Check if blob already exists (deduplication)
      const exists = await adapter.exists(hash);
      if (exists) {
        // Also check if we have a complete upload record
        const existingResult = await sql<{ status: 'pending' | 'complete' }>`
          select status
          from ${sql.table('sync_blob_uploads')}
          where hash = ${hash} and status = 'complete'
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
            hash,
            size,
            mime_type,
            status,
            actor_id,
            expires_at,
            completed_at
          )
          values (
            ${hash},
            ${size},
            ${mimeType},
            'complete',
            ${actorId},
            ${existsExpiresAt},
            ${existsCompletedAt}
          )
          on conflict (hash) do nothing
        `.execute(db);

        return { exists: true };
      }

      // Create pending upload record
      const expiresAt = new Date(
        Date.now() + uploadTtlSeconds * 1000
      ).toISOString();

      await sql`
        insert into ${sql.table('sync_blob_uploads')} (
          hash,
          size,
          mime_type,
          status,
          actor_id,
          expires_at,
          completed_at
        )
        values (
          ${hash},
          ${size},
          ${mimeType},
          'pending',
          ${actorId},
          ${expiresAt},
          ${null}
        )
        on conflict (hash)
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
    async completeUpload(hash: string): Promise<BlobUploadCompleteResponse> {
      // Validate hash format
      if (!parseBlobHash(hash)) {
        return { ok: false, error: 'Invalid blob hash format' };
      }

      // Check upload record exists
      const uploadResult = await sql<{
        hash: string;
        size: number;
        mime_type: string;
        status: 'pending' | 'complete';
        created_at: string;
      }>`
        select hash, size, mime_type, status, created_at
        from ${sql.table('sync_blob_uploads')}
        where hash = ${hash}
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        return { ok: false, error: 'Upload not found' };
      }

      if (upload.status === 'complete') {
        // Already complete - return metadata
        return {
          ok: true,
          metadata: {
            hash: upload.hash,
            size: upload.size,
            mimeType: upload.mime_type,
            createdAt: upload.created_at,
            uploadComplete: true,
          },
        };
      }

      // Verify blob exists in storage
      const exists = await adapter.exists(hash);
      if (!exists) {
        return { ok: false, error: 'Blob not found in storage' };
      }

      // Optionally verify size matches
      if (adapter.getMetadata) {
        const meta = await adapter.getMetadata(hash);
        if (meta && meta.size !== upload.size) {
          return {
            ok: false,
            error: `Size mismatch: expected ${upload.size}, got ${meta.size}`,
          };
        }
      }

      // Mark upload as complete
      const completedAt = new Date().toISOString();
      await sql`
        update ${sql.table('sync_blob_uploads')}
        set status = 'complete', completed_at = ${completedAt}
        where hash = ${hash}
      `.execute(db);

      return {
        ok: true,
        metadata: {
          hash: upload.hash,
          size: upload.size,
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

      // Validate hash format
      if (!parseBlobHash(hash)) {
        throw new BlobNotFoundError('Invalid blob hash format');
      }

      // Get upload record (must be complete)
      const uploadResult = await sql<{
        hash: string;
        size: number;
        mime_type: string;
        status: 'pending' | 'complete';
        created_at: string;
      }>`
        select hash, size, mime_type, status, created_at
        from ${sql.table('sync_blob_uploads')}
        where hash = ${hash} and status = 'complete'
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        throw new BlobNotFoundError('Blob not found');
      }

      // Generate presigned download URL
      const url = await adapter.signDownload({
        hash,
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
          size: upload.size,
          mimeType: upload.mime_type,
          createdAt: upload.created_at,
          uploadComplete: true,
        },
      };
    },

    /**
     * Get blob metadata without generating a download URL.
     */
    async getMetadata(hash: string): Promise<BlobMetadata | null> {
      // Validate hash format
      if (!parseBlobHash(hash)) {
        return null;
      }

      const uploadResult = await sql<{
        hash: string;
        size: number;
        mime_type: string;
        status: 'pending' | 'complete';
        created_at: string;
      }>`
        select hash, size, mime_type, status, created_at
        from ${sql.table('sync_blob_uploads')}
        where hash = ${hash} and status = 'complete'
        limit 1
      `.execute(db);
      const upload = uploadResult.rows[0];

      if (!upload) {
        return null;
      }

      return {
        hash: upload.hash,
        size: upload.size,
        mimeType: upload.mime_type,
        createdAt: upload.created_at,
        uploadComplete: true,
      };
    },

    /**
     * Check if a blob exists and is complete.
     */
    async exists(hash: string): Promise<boolean> {
      if (!parseBlobHash(hash)) return false;

      const rowResult = await sql<{ hash: string }>`
        select hash
        from ${sql.table('sync_blob_uploads')}
        where hash = ${hash} and status = 'complete'
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
    }): Promise<{ deleted: number }> {
      const now = new Date().toISOString();

      // Find expired pending uploads
      const expiredResult = await sql<{ hash: string }>`
        select hash
        from ${sql.table('sync_blob_uploads')}
        where status = 'pending' and expires_at < ${now}
      `.execute(db);
      const expired = expiredResult.rows;

      let deleted = 0;

      for (const row of expired) {
        if (options?.deleteFromStorage) {
          try {
            await adapter.delete(row.hash);
          } catch {
            // Ignore storage errors during cleanup
          }
        }

        await sql`
          delete from ${sql.table('sync_blob_uploads')}
          where hash = ${row.hash}
        `.execute(db);

        deleted++;
      }

      // If reference check provided, also clean up unreferenced complete uploads
      if (options?.isReferenced) {
        const completeResult = await sql<{ hash: string }>`
          select hash
          from ${sql.table('sync_blob_uploads')}
          where status = 'complete'
        `.execute(db);
        const complete = completeResult.rows;

        for (const row of complete) {
          const referenced = await options.isReferenced(row.hash);
          if (!referenced) {
            if (options?.deleteFromStorage) {
              try {
                await adapter.delete(row.hash);
              } catch {
                // Ignore storage errors during cleanup
              }
            }

            await sql`
              delete from ${sql.table('sync_blob_uploads')}
              where hash = ${row.hash}
            `.execute(db);

            deleted++;
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
