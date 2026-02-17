/**
 * @syncular/core - Shared types for sync infrastructure
 *
 * Non-protocol types: conflict detection, transport interfaces.
 * Protocol types (SyncOp, SyncPushRequest, etc.) live in ./schemas/sync.ts
 */

import type { SyncCombinedRequest, SyncCombinedResponse } from './schemas/sync';

// ============================================================================
// Conflict Detection Types
// ============================================================================

/**
 * Result of a conflict check - no conflict
 */
interface ConflictCheckResultOk {
  hasConflict: false;
}

/**
 * Result of a conflict check - conflict detected
 */
interface ConflictCheckResultConflict {
  hasConflict: true;
  /** Fields with conflicting changes */
  conflictingFields: string[];
  /** Current server row state */
  serverRow: Record<string, unknown>;
  /** Current server version */
  serverVersion: number;
}

/**
 * Union type for conflict check results
 */
export type ConflictCheckResult =
  | ConflictCheckResultOk
  | ConflictCheckResultConflict;

/**
 * Result of a field-level merge - can merge
 */
export interface MergeResultOk {
  canMerge: true;
  /** Merged payload combining client and server changes */
  mergedPayload: Record<string, unknown>;
}

/**
 * Result of a field-level merge - cannot merge
 */
export interface MergeResultConflict {
  canMerge: false;
  /** Fields that cannot be auto-merged */
  conflictingFields: string[];
}

/**
 * Union type for merge results
 */
export type MergeResult = MergeResultOk | MergeResultConflict;

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Options for transport operations.
 * Provides hooks for auth errors and cancellation support.
 */
export interface SyncTransportOptions {
  /**
   * Called when auth fails (401/403).
   * Return true to retry the request after refreshing auth.
   */
  onAuthError?: () => Promise<boolean>;
  /**
   * Abort signal for cancellation support.
   */
  signal?: AbortSignal;
}

/**
 * Blob transport operations (optional extension to SyncTransport).
 * When present, enables blob upload/download through the same transport.
 */
export interface SyncTransportBlobs {
  /**
   * Initiate a blob upload.
   * Returns presigned URL info or indicates blob already exists (dedup).
   */
  initiateUpload(args: {
    hash: string;
    size: number;
    mimeType: string;
  }): Promise<{
    exists: boolean;
    uploadUrl?: string;
    uploadMethod?: 'PUT' | 'POST';
    uploadHeaders?: Record<string, string>;
  }>;

  /**
   * Complete a blob upload.
   * Call this after uploading to the presigned URL.
   */
  completeUpload(hash: string): Promise<{ ok: boolean; error?: string }>;

  /**
   * Get a presigned download URL.
   */
  getDownloadUrl(hash: string): Promise<{
    url: string;
    expiresAt: string;
  }>;
}

/**
 * Transport interface for sync operations.
 */
export interface SyncTransport {
  /**
   * Combined push+pull in a single round-trip.
   */
  sync(
    request: SyncCombinedRequest,
    options?: SyncTransportOptions
  ): Promise<SyncCombinedResponse>;

  /**
   * Download an encoded bootstrap snapshot chunk.
   */
  fetchSnapshotChunk(
    request: { chunkId: string },
    options?: SyncTransportOptions
  ): Promise<Uint8Array>;

  /**
   * Optional streaming snapshot chunk download.
   *
   * When implemented, clients can decode and apply large bootstrap chunks
   * incrementally without materializing the entire chunk in memory.
   */
  fetchSnapshotChunkStream?(
    request: { chunkId: string },
    options?: SyncTransportOptions
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Optional blob operations.
   * When present, enables blob upload/download functionality.
   */
  blobs?: SyncTransportBlobs;
}

/**
 * Transport error with additional context
 */
export class SyncTransportError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'SyncTransportError';
  }
}
