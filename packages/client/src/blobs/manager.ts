/**
 * @syncular/client - Client-side blob manager
 *
 * Handles blob upload/download with:
 * - Local caching for offline access
 * - Upload queue for offline uploads
 * - SHA-256 hash computation
 * - Optional client-side encryption
 */

import type { BlobRef, BlobTransport } from '@syncular/core';
import { createBlobHash, createBlobRef } from '@syncular/core';
import type { Kysely } from 'kysely';
import type { BlobUploadStatus, SyncBlobClientDb } from './types';

// Re-export BlobTransport for convenience
export type { BlobTransport } from '@syncular/core';

// ============================================================================
// Types
// ============================================================================

interface BlobEncryption {
  /**
   * Encrypt blob content.
   * Returns encrypted bytes and the key ID used.
   */
  encrypt(
    data: Uint8Array,
    options?: { keyId?: string }
  ): Promise<{ encrypted: Uint8Array; keyId: string }>;

  /**
   * Decrypt blob content.
   */
  decrypt(data: Uint8Array, keyId: string): Promise<Uint8Array>;
}

export interface ClientBlobManagerOptions {
  /** Kysely database instance */
  db: Kysely<SyncBlobClientDb>;
  /** Blob transport for server communication */
  transport: BlobTransport;
  /** Optional encryption handler */
  encryption?: BlobEncryption;
  /** Maximum cache size in bytes. Default: 100MB */
  maxCacheSize?: number;
  /** Maximum retry attempts for uploads. Default: 3 */
  maxUploadRetries?: number;
  /** Custom fetch function for blob uploads/downloads. Default: globalThis.fetch */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface UploadOptions {
  /** Encrypt the blob before uploading */
  encrypt?: boolean;
  /** Specific encryption key ID to use */
  keyId?: string;
  /** Skip queuing and upload immediately (blocks until complete) */
  immediate?: boolean;
}

export interface DownloadOptions {
  /** Skip cache lookup and always fetch from server */
  skipCache?: boolean;
  /** Update last_accessed_at in cache */
  updateAccessTime?: boolean;
}

// ============================================================================
// Client Blob Manager
// ============================================================================

/**
 * Create a client-side blob manager.
 *
 * @example
 * ```typescript
 * const blobManager = createClientBlobManager({
 *   db,
 *   transport: {
 *     async initiateUpload(args) {
 *       const res = await fetch('/api/sync/blobs/upload', {
 *         method: 'POST',
 *         body: JSON.stringify(args),
 *       });
 *       return res.json();
 *     },
 *     async completeUpload(hash) {
 *       const res = await fetch(`/api/sync/blobs/${hash}/complete`, { method: 'POST' });
 *       return res.json();
 *     },
 *     async getDownloadUrl(hash) {
 *       const res = await fetch(`/api/sync/blobs/${hash}/url`);
 *       return res.json();
 *     },
 *   },
 * });
 *
 * // Upload a file
 * const blobRef = await blobManager.upload(file);
 *
 * // Download a blob
 * const blob = await blobManager.download(blobRef);
 * ```
 */
export function createClientBlobManager(options: ClientBlobManagerOptions) {
  const {
    db,
    transport,
    encryption,
    maxCacheSize = 100 * 1024 * 1024,
    maxUploadRetries = 3,
    fetch: customFetch = globalThis.fetch,
  } = options;

  return {
    /**
     * Upload a blob to the server.
     *
     * If `immediate` is false (default), the blob is queued for background upload.
     * If `immediate` is true, the upload blocks until complete.
     */
    async upload(
      data: Blob | File | Uint8Array,
      opts?: UploadOptions
    ): Promise<BlobRef> {
      const bytes = await toUint8Array(data);
      const mimeType =
        data instanceof Blob ? data.type : 'application/octet-stream';

      let finalBytes = bytes;
      let encrypted = false;
      let keyId: string | undefined;

      // Encrypt if requested
      if (opts?.encrypt && encryption) {
        const result = await encryption.encrypt(bytes, { keyId: opts.keyId });
        finalBytes = result.encrypted;
        encrypted = true;
        keyId = result.keyId;
      }

      // Compute hash of final (possibly encrypted) bytes
      const hash = await computeSha256(finalBytes);

      // Create blob ref
      const blobRef = createBlobRef({
        hash,
        size: finalBytes.length,
        mimeType,
        encrypted,
        keyId,
      });

      // Check if already in cache (dedup locally)
      const cached = await db
        .selectFrom('sync_blob_cache')
        .select('hash')
        .where('hash', '=', hash)
        .executeTakeFirst();

      if (cached) {
        return blobRef;
      }

      // Check if already in outbox
      const queued = await db
        .selectFrom('sync_blob_outbox')
        .select('hash')
        .where('hash', '=', hash)
        .where('status', '!=', 'failed')
        .executeTakeFirst();

      if (queued) {
        return blobRef;
      }

      if (opts?.immediate) {
        // Upload immediately
        await uploadBlob(finalBytes, hash, mimeType);

        // Complete the upload (mark as done on server)
        const completeResult = await transport.completeUpload(hash);
        if (!completeResult.ok) {
          throw new BlobUploadError(
            `Failed to complete upload: ${completeResult.error}`
          );
        }

        // Cache the blob
        await cacheBlob(hash, finalBytes, mimeType, encrypted, keyId);
      } else {
        // Queue for background upload
        const now = Date.now();
        await db
          .insertInto('sync_blob_outbox')
          .values({
            hash,
            size: finalBytes.length,
            mime_type: mimeType,
            body: finalBytes,
            encrypted: encrypted ? 1 : 0,
            key_id: keyId ?? null,
            status: 'pending',
            attempt_count: 0,
            error: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) => oc.column('hash').doNothing())
          .execute();
      }

      return blobRef;
    },

    /**
     * Download a blob.
     *
     * First checks the local cache, then fetches from server if needed.
     * Automatically decrypts if the blob was encrypted.
     */
    async download(ref: BlobRef, opts?: DownloadOptions): Promise<Uint8Array> {
      const hash = ref.hash;

      // Check cache first (unless skipCache)
      if (!opts?.skipCache) {
        const cached = await db
          .selectFrom('sync_blob_cache')
          .select(['body', 'encrypted', 'key_id'])
          .where('hash', '=', hash)
          .executeTakeFirst();

        if (cached) {
          // Update access time if requested
          if (opts?.updateAccessTime !== false) {
            await db
              .updateTable('sync_blob_cache')
              .set({ last_accessed_at: Date.now() })
              .where('hash', '=', hash)
              .execute();
          }

          let data = cached.body;

          // Decrypt if needed
          if (cached.encrypted && cached.key_id && encryption) {
            data = await encryption.decrypt(data, cached.key_id);
          }

          return data;
        }
      }

      // Check if blob is in upload outbox (not yet on server)
      const outbox = await db
        .selectFrom('sync_blob_outbox')
        .select(['body', 'encrypted', 'key_id'])
        .where('hash', '=', hash)
        .executeTakeFirst();

      if (outbox) {
        let data = outbox.body;
        if (outbox.encrypted && outbox.key_id && encryption) {
          data = await encryption.decrypt(data, outbox.key_id);
        }
        return data;
      }

      // Fetch from server
      const { url } = await transport.getDownloadUrl(hash);
      const response = await customFetch(url);

      if (!response.ok) {
        throw new BlobDownloadError(
          `Failed to download blob: ${response.status}`
        );
      }

      const buffer = await response.arrayBuffer();
      const data = new Uint8Array(buffer);

      // Verify hash
      const computedHash = await computeSha256(data);
      if (computedHash !== hash) {
        throw new BlobDownloadError('Downloaded blob hash mismatch');
      }

      // Cache the blob
      await cacheBlob(
        hash,
        data,
        ref.mimeType,
        ref.encrypted ?? false,
        ref.keyId
      );

      // Decrypt if needed
      if (ref.encrypted && ref.keyId && encryption) {
        return encryption.decrypt(data, ref.keyId);
      }

      return data;
    },

    /**
     * Check if a blob is cached locally.
     */
    async isCached(hash: string): Promise<boolean> {
      const row = await db
        .selectFrom('sync_blob_cache')
        .select('hash')
        .where('hash', '=', hash)
        .executeTakeFirst();
      return !!row;
    },

    /**
     * Get a blob URL for display.
     *
     * Returns a blob: URL if cached locally, or fetches and creates one.
     */
    async getBlobUrl(ref: BlobRef): Promise<string> {
      const data = await this.download(ref);
      const blob = new Blob([data.buffer as ArrayBuffer], {
        type: ref.mimeType,
      });
      return URL.createObjectURL(blob);
    },

    /**
     * Preload blobs into the cache.
     */
    async preload(refs: BlobRef[]): Promise<void> {
      await Promise.all(refs.map((ref) => this.download(ref)));
    },

    /**
     * Process pending uploads in the outbox.
     *
     * Call this periodically or when online to sync pending uploads.
     * Returns the number of blobs processed.
     */
    async processUploadQueue(): Promise<{
      uploaded: number;
      failed: number;
      errors: Array<{ hash: string; error: string }>;
    }> {
      let uploaded = 0;
      let failed = 0;
      const errors: Array<{ hash: string; error: string }> = [];

      // Get pending uploads
      const pending = await db
        .selectFrom('sync_blob_outbox')
        .selectAll()
        .where('status', 'in', ['pending', 'uploading', 'uploaded'])
        .where('attempt_count', '<', maxUploadRetries)
        .orderBy('created_at', 'asc')
        .execute();

      for (const row of pending) {
        try {
          // Process based on current status
          if (row.status === 'pending' || row.status === 'uploading') {
            // Mark as uploading
            await db
              .updateTable('sync_blob_outbox')
              .set({
                status: 'uploading',
                attempt_count: row.attempt_count + 1,
                updated_at: Date.now(),
              })
              .where('hash', '=', row.hash)
              .execute();

            // Upload to server
            await uploadBlob(row.body, row.hash, row.mime_type);

            // Mark as uploaded (waiting for confirmation)
            await db
              .updateTable('sync_blob_outbox')
              .set({ status: 'uploaded', updated_at: Date.now() })
              .where('hash', '=', row.hash)
              .execute();
          }

          if (
            row.status === 'uploaded' ||
            row.status === 'confirming' ||
            row.status === 'pending'
          ) {
            // Confirm upload
            await db
              .updateTable('sync_blob_outbox')
              .set({ status: 'confirming', updated_at: Date.now() })
              .where('hash', '=', row.hash)
              .execute();

            const result = await transport.completeUpload(row.hash);

            if (result.ok) {
              // Cache the blob
              await cacheBlob(
                row.hash,
                row.body,
                row.mime_type,
                row.encrypted === 1,
                row.key_id ?? undefined
              );

              // Remove from outbox
              await db
                .deleteFrom('sync_blob_outbox')
                .where('hash', '=', row.hash)
                .execute();

              uploaded++;
            } else {
              throw new Error(result.error ?? 'Upload confirmation failed');
            }
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);

          // Check if max retries exceeded
          if (row.attempt_count + 1 >= maxUploadRetries) {
            await db
              .updateTable('sync_blob_outbox')
              .set({
                status: 'failed',
                error: errorMessage,
                updated_at: Date.now(),
              })
              .where('hash', '=', row.hash)
              .execute();
            failed++;
          } else {
            // Mark as pending for retry
            await db
              .updateTable('sync_blob_outbox')
              .set({
                status: 'pending',
                error: errorMessage,
                updated_at: Date.now(),
              })
              .where('hash', '=', row.hash)
              .execute();
          }

          errors.push({ hash: row.hash, error: errorMessage });
        }
      }

      return { uploaded, failed, errors };
    },

    /**
     * Get the status of a pending upload.
     */
    async getUploadStatus(
      hash: string
    ): Promise<{ status: BlobUploadStatus; error?: string } | null> {
      const row = await db
        .selectFrom('sync_blob_outbox')
        .select(['status', 'error'])
        .where('hash', '=', hash)
        .executeTakeFirst();

      if (!row) return null;
      return { status: row.status, error: row.error ?? undefined };
    },

    /**
     * Clear failed uploads from the outbox.
     */
    async clearFailedUploads(): Promise<number> {
      const result = await db
        .deleteFrom('sync_blob_outbox')
        .where('status', '=', 'failed')
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    /**
     * Retry a failed upload.
     */
    async retryUpload(hash: string): Promise<boolean> {
      const result = await db
        .updateTable('sync_blob_outbox')
        .set({
          status: 'pending',
          attempt_count: 0,
          error: null,
          updated_at: Date.now(),
        })
        .where('hash', '=', hash)
        .where('status', '=', 'failed')
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    /**
     * Prune the cache to stay under maxCacheSize.
     * Uses LRU (least recently used) eviction.
     */
    async pruneCache(): Promise<{ evicted: number; freedBytes: number }> {
      // Calculate current cache size
      const stats = await db
        .selectFrom('sync_blob_cache')
        .select(({ fn }) => [fn.sum<number>('size').as('total_size')])
        .executeTakeFirst();

      const currentSize = stats?.total_size ?? 0;

      if (currentSize <= maxCacheSize) {
        return { evicted: 0, freedBytes: 0 };
      }

      const targetSize = maxCacheSize * 0.8; // Prune to 80% of max
      let freedBytes = 0;
      let evicted = 0;

      // Get blobs ordered by last access (LRU)
      const blobs = await db
        .selectFrom('sync_blob_cache')
        .select(['hash', 'size'])
        .orderBy('last_accessed_at', 'asc')
        .execute();

      for (const blob of blobs) {
        if (currentSize - freedBytes <= targetSize) break;

        await db
          .deleteFrom('sync_blob_cache')
          .where('hash', '=', blob.hash)
          .execute();

        freedBytes += blob.size;
        evicted++;
      }

      return { evicted, freedBytes };
    },

    /**
     * Clear the entire cache.
     */
    async clearCache(): Promise<number> {
      const result = await db.deleteFrom('sync_blob_cache').executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    /**
     * Get cache statistics.
     */
    async getCacheStats(): Promise<{
      count: number;
      totalSize: number;
      maxSize: number;
    }> {
      const stats = await db
        .selectFrom('sync_blob_cache')
        .select(({ fn }) => [
          fn.count<number>('hash').as('count'),
          fn.sum<number>('size').as('total_size'),
        ])
        .executeTakeFirst();

      return {
        count: stats?.count ?? 0,
        totalSize: stats?.total_size ?? 0,
        maxSize: maxCacheSize,
      };
    },

    /**
     * Get upload queue statistics.
     */
    async getUploadQueueStats(): Promise<{
      pending: number;
      uploading: number;
      failed: number;
      total: number;
    }> {
      const rows = await db
        .selectFrom('sync_blob_outbox')
        .select(['status'])
        .execute();

      const stats = { pending: 0, uploading: 0, failed: 0, total: 0 };
      for (const row of rows) {
        stats.total++;
        if (row.status === 'pending') stats.pending++;
        else if (
          row.status === 'uploading' ||
          row.status === 'uploaded' ||
          row.status === 'confirming'
        )
          stats.uploading++;
        else if (row.status === 'failed') stats.failed++;
      }
      return stats;
    },
  };

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async function uploadBlob(
    data: Uint8Array,
    hash: string,
    mimeType: string
  ): Promise<void> {
    // Initiate upload
    const initResult = await transport.initiateUpload({
      hash,
      size: data.length,
      mimeType,
    });

    // If blob already exists, we're done
    if (initResult.exists) {
      return;
    }

    if (!initResult.uploadUrl) {
      throw new BlobUploadError('No upload URL returned');
    }

    // Upload to presigned URL
    const response = await customFetch(initResult.uploadUrl, {
      method: initResult.uploadMethod ?? 'PUT',
      headers: {
        ...initResult.uploadHeaders,
        'Content-Type': mimeType,
      },
      body: new Blob([data.buffer as ArrayBuffer], { type: mimeType }),
    });

    if (!response.ok) {
      throw new BlobUploadError(`Upload failed: ${response.status}`);
    }
  }

  async function cacheBlob(
    hash: string,
    data: Uint8Array,
    mimeType: string,
    encrypted: boolean,
    keyId?: string
  ): Promise<void> {
    const now = Date.now();
    await db
      .insertInto('sync_blob_cache')
      .values({
        hash,
        size: data.length,
        mime_type: mimeType,
        body: data,
        encrypted: encrypted ? 1 : 0,
        key_id: keyId ?? null,
        cached_at: now,
        last_accessed_at: now,
      })
      .onConflict((oc) =>
        oc.column('hash').doUpdateSet({
          last_accessed_at: now,
        })
      )
      .execute();

    // Prune cache if needed (async, don't block)
    void pruneCache().catch(() => {});
  }

  async function pruneCache(): Promise<void> {
    const stats = await db
      .selectFrom('sync_blob_cache')
      .select(({ fn }) => [fn.sum<number>('size').as('total_size')])
      .executeTakeFirst();

    const currentSize = stats?.total_size ?? 0;

    if (currentSize > maxCacheSize) {
      const targetSize = maxCacheSize * 0.8;
      let freedBytes = 0;

      const blobs = await db
        .selectFrom('sync_blob_cache')
        .select(['hash', 'size'])
        .orderBy('last_accessed_at', 'asc')
        .limit(100) // Limit batch size
        .execute();

      for (const blob of blobs) {
        if (currentSize - freedBytes <= targetSize) break;

        await db
          .deleteFrom('sync_blob_cache')
          .where('hash', '=', blob.hash)
          .execute();

        freedBytes += blob.size;
      }
    }
  }
}

type ClientBlobManager = ReturnType<typeof createClientBlobManager>;

// ============================================================================
// Cache Pruning Scheduler
// ============================================================================

interface BlobCachePruneSchedulerOptions {
  /** Client blob manager instance */
  blobManager: ClientBlobManager;
  /** Interval between prune runs in milliseconds. Default: 300000 (5 minutes) */
  intervalMs?: number;
  /** Optional: Called after each prune run */
  onPrune?: (result: {
    evicted: number;
    freedBytes: number;
    error?: Error;
  }) => void;
}

/**
 * Create a cache pruning scheduler for the client blob manager.
 *
 * Periodically prunes the cache to stay under maxCacheSize using LRU eviction.
 *
 * @example
 * ```typescript
 * const scheduler = createBlobCachePruneScheduler({
 *   blobManager,
 *   intervalMs: 5 * 60 * 1000, // 5 minutes
 *   onPrune: (result) => {
 *     if (result.evicted > 0) {
 *       console.log(`Cache pruned: ${result.evicted} blobs, ${result.freedBytes} bytes freed`);
 *     }
 *   },
 * });
 *
 * // Start the scheduler
 * scheduler.start();
 *
 * // Stop when unmounting/shutting down
 * scheduler.stop();
 * ```
 */
export function createBlobCachePruneScheduler(
  options: BlobCachePruneSchedulerOptions
) {
  const {
    blobManager,
    intervalMs = 300000, // 5 minutes
    onPrune,
  } = options;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  const runPrune = async (): Promise<{
    evicted: number;
    freedBytes: number;
    error?: Error;
  }> => {
    if (isRunning) {
      return { evicted: 0, freedBytes: 0 };
    }

    isRunning = true;

    try {
      const result = await blobManager.pruneCache();
      onPrune?.({ evicted: result.evicted, freedBytes: result.freedBytes });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onPrune?.({ evicted: 0, freedBytes: 0, error });
      return { evicted: 0, freedBytes: 0, error };
    } finally {
      isRunning = false;
    }
  };

  return {
    /**
     * Start the prune scheduler.
     * Optionally runs an immediate prune before starting the interval.
     */
    start(options?: { immediate?: boolean }): void {
      if (intervalId) {
        return; // Already running
      }

      if (options?.immediate) {
        void runPrune();
      }

      intervalId = setInterval(() => {
        void runPrune();
      }, intervalMs);
    },

    /**
     * Stop the prune scheduler.
     */
    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    /**
     * Run a single prune manually.
     */
    async runOnce(): Promise<{
      evicted: number;
      freedBytes: number;
      error?: Error;
    }> {
      return runPrune();
    },

    /**
     * Check if the scheduler is currently active.
     */
    get active(): boolean {
      return intervalId !== null;
    },

    /**
     * Check if a prune is currently in progress.
     */
    get running(): boolean {
      return isRunning;
    },
  };
}

// ============================================================================
// Upload Queue Processor Scheduler
// ============================================================================

interface BlobUploadQueueSchedulerOptions {
  /** Client blob manager instance */
  blobManager: ClientBlobManager;
  /** Interval between processing runs in milliseconds. Default: 30000 (30 seconds) */
  intervalMs?: number;
  /** Optional: Called after each processing run */
  onProcess?: (result: {
    uploaded: number;
    failed: number;
    errors: Array<{ hash: string; error: string }>;
    error?: Error;
  }) => void;
}

/**
 * Create an upload queue processor scheduler for the client blob manager.
 *
 * Periodically processes pending uploads when online.
 *
 * @example
 * ```typescript
 * const scheduler = createBlobUploadQueueScheduler({
 *   blobManager,
 *   intervalMs: 30 * 1000, // 30 seconds
 *   onProcess: (result) => {
 *     if (result.uploaded > 0) {
 *       console.log(`Uploaded ${result.uploaded} blobs`);
 *     }
 *     if (result.failed > 0) {
 *       console.warn(`Failed to upload ${result.failed} blobs`);
 *     }
 *   },
 * });
 *
 * // Start when online
 * scheduler.start();
 *
 * // Stop when offline or shutting down
 * scheduler.stop();
 * ```
 */
export function createBlobUploadQueueScheduler(
  options: BlobUploadQueueSchedulerOptions
) {
  const {
    blobManager,
    intervalMs = 30000, // 30 seconds
    onProcess,
  } = options;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  const runProcess = async (): Promise<{
    uploaded: number;
    failed: number;
    errors: Array<{ hash: string; error: string }>;
    error?: Error;
  }> => {
    if (isRunning) {
      return { uploaded: 0, failed: 0, errors: [] };
    }

    isRunning = true;

    try {
      const result = await blobManager.processUploadQueue();
      onProcess?.(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const result = { uploaded: 0, failed: 0, errors: [], error };
      onProcess?.(result);
      return result;
    } finally {
      isRunning = false;
    }
  };

  return {
    /**
     * Start the upload queue processor.
     * Optionally runs an immediate processing before starting the interval.
     */
    start(options?: { immediate?: boolean }): void {
      if (intervalId) {
        return; // Already running
      }

      if (options?.immediate) {
        void runProcess();
      }

      intervalId = setInterval(() => {
        void runProcess();
      }, intervalMs);
    },

    /**
     * Stop the upload queue processor.
     */
    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    /**
     * Run a single processing manually.
     */
    async runOnce(): Promise<{
      uploaded: number;
      failed: number;
      errors: Array<{ hash: string; error: string }>;
      error?: Error;
    }> {
      return runProcess();
    },

    /**
     * Check if the processor is currently active.
     */
    get active(): boolean {
      return intervalId !== null;
    },

    /**
     * Check if processing is currently in progress.
     */
    get running(): boolean {
      return isRunning;
    },
  };
}

// ============================================================================
// Utilities
// ============================================================================

async function toUint8Array(
  data: Blob | File | Uint8Array
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

async function computeSha256(data: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(data).buffer as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return createBlobHash(hex);
}

// ============================================================================
// Errors
// ============================================================================

class BlobUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobUploadError';
  }
}

class BlobDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobDownloadError';
  }
}
