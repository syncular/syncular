/**
 * @syncular/client - Blob storage types
 */

import type { Generated } from 'kysely';

// ============================================================================
// Blob Cache Table
// ============================================================================

/**
 * Local blob cache table.
 * Stores downloaded blobs for offline access.
 */
export interface SyncBlobCacheTable {
  /** SHA-256 hash with prefix: "sha256:<hex>" */
  hash: string;
  /** Size in bytes */
  size: number;
  /** MIME type */
  mime_type: string;
  /** Blob content */
  body: Uint8Array;
  /** Whether the blob is encrypted */
  encrypted: number; // SQLite boolean
  /** Encryption key ID (if encrypted) */
  key_id: string | null;
  /** When the blob was cached */
  cached_at: number;
  /** Last accessed timestamp (for LRU eviction) */
  last_accessed_at: number;
}

// ============================================================================
// Blob Upload Outbox Table
// ============================================================================

export type BlobUploadStatus =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'confirming'
  | 'complete'
  | 'failed';

/**
 * Blob upload outbox table.
 * Tracks pending blob uploads for offline support.
 */
export interface SyncBlobOutboxTable {
  /** Local row id */
  id: Generated<number>;
  /** SHA-256 hash with prefix: "sha256:<hex>" */
  hash: string;
  /** Size in bytes */
  size: number;
  /** MIME type */
  mime_type: string;
  /** Blob content (stored locally until upload completes) */
  body: Uint8Array;
  /** Whether the blob is encrypted */
  encrypted: number; // SQLite boolean
  /** Encryption key ID (if encrypted) */
  key_id: string | null;
  /** Upload status */
  status: BlobUploadStatus;
  /** Upload attempt count */
  attempt_count: number;
  /** Last error message */
  error: string | null;
  /** When the upload was queued */
  created_at: number;
  /** When the upload was last updated */
  updated_at: number;
}

// ============================================================================
// Database Interface
// ============================================================================

export interface SyncBlobClientDb {
  sync_blob_cache: SyncBlobCacheTable;
  sync_blob_outbox: SyncBlobOutboxTable;
}
