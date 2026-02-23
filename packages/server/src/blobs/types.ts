/**
 * @syncular/server - Blob storage types
 */

import type { Generated } from 'kysely';

// ============================================================================
// Blob Upload Tracking
// ============================================================================

/**
 * Blob uploads tracking table.
 * Tracks initiated uploads and their completion status.
 */
export interface SyncBlobUploadsTable {
  /** SHA-256 hash with prefix: "sha256:<hex>" */
  hash: string;
  /** Expected size in bytes */
  size: number;
  /** MIME type */
  mime_type: string;
  /** Upload status */
  status: 'pending' | 'complete';
  /** Actor who initiated the upload */
  actor_id: string;
  /** When the upload was initiated */
  created_at: Generated<string>;
  /** When the upload expires (for cleanup of incomplete uploads) */
  expires_at: string;
  /** When the upload was completed */
  completed_at: string | null;
}

export interface SyncBlobUploadsDb {
  sync_blob_uploads: SyncBlobUploadsTable;
}

// ============================================================================
// Blob Storage (Database Adapter)
// ============================================================================

/**
 * Blob storage table (for database adapter).
 * Stores blob content directly in the database.
 */
export interface SyncBlobsTable {
  /** SHA-256 hash with prefix: "sha256:<hex>" */
  hash: string;
  /** Size in bytes */
  size: number;
  /** MIME type */
  mime_type: string;
  /** Blob content */
  body: Uint8Array;
  /** When the blob was created */
  created_at: Generated<string>;
}

export interface SyncBlobsDb {
  sync_blobs: SyncBlobsTable;
}

// ============================================================================
// Combined DB Interface
// ============================================================================

/**
 * Full database interface for blob storage.
 */
export interface SyncBlobDb extends SyncBlobUploadsDb, SyncBlobsDb {}
