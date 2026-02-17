/**
 * @syncular/core - Blob types for media/binary handling
 *
 * Content-addressable blob storage with presigned URL support.
 * Protocol types (BlobRef, BlobMetadata, etc.) live in ./schemas/blobs.ts
 */

import type { BlobRef } from './schemas/blobs';

// ============================================================================
// Client Transport Types
// ============================================================================

/**
 * Transport interface for client-server blob communication.
 * This is used by the client blob manager to communicate with the server.
 */
export interface BlobTransport {
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

// ============================================================================
// Storage Adapter Types (Server-side)
// ============================================================================

/**
 * Options for signing an upload URL.
 */
export interface BlobSignUploadOptions {
  /** SHA-256 hash (for naming and checksum validation) */
  hash: string;
  /** Content size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
  /** URL expiration in seconds */
  expiresIn: number;
}

/**
 * Result of signing an upload URL.
 */
export interface BlobSignedUpload {
  /** The URL to upload to */
  url: string;
  /** HTTP method */
  method: 'PUT' | 'POST';
  /** Required headers */
  headers?: Record<string, string>;
}

/**
 * Options for signing a download URL.
 */
export interface BlobSignDownloadOptions {
  /** SHA-256 hash */
  hash: string;
  /** URL expiration in seconds */
  expiresIn: number;
}

/**
 * Adapter for blob storage backends (S3, R2, custom).
 * Implementations handle actual storage; the sync server orchestrates.
 */
export interface BlobStorageAdapter {
  /** Adapter name for logging/debugging */
  readonly name: string;

  /**
   * Generate a presigned URL for uploading a blob.
   * The URL should enforce checksum validation if the backend supports it.
   */
  signUpload(options: BlobSignUploadOptions): Promise<BlobSignedUpload>;

  /**
   * Generate a presigned URL for downloading a blob.
   */
  signDownload(options: BlobSignDownloadOptions): Promise<string>;

  /**
   * Check if a blob exists in storage.
   */
  exists(hash: string): Promise<boolean>;

  /**
   * Delete a blob (for garbage collection).
   */
  delete(hash: string): Promise<void>;

  /**
   * Get blob metadata from storage (optional).
   * Used to verify uploads completed successfully.
   */
  getMetadata?(
    hash: string
  ): Promise<{ size: number; mimeType?: string } | null>;

  /**
   * Store blob data directly (for adapters that support direct storage).
   * Used for snapshot chunks and other internal data.
   */
  put?(
    hash: string,
    data: Uint8Array,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Store blob data directly from a stream.
   * Preferred for large payloads to avoid full buffering in memory.
   */
  putStream?(
    hash: string,
    stream: ReadableStream<Uint8Array>,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Get blob data directly (for adapters that support direct retrieval).
   */
  get?(hash: string): Promise<Uint8Array | null>;

  /**
   * Get blob data directly as a stream (for adapters that support stream retrieval).
   */
  getStream?(hash: string): Promise<ReadableStream<Uint8Array> | null>;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a BlobRef from upload metadata.
 */
export function createBlobRef(args: {
  hash: string;
  size: number;
  mimeType: string;
  encrypted?: boolean;
  keyId?: string;
}): BlobRef {
  const ref: BlobRef = {
    hash: args.hash,
    size: args.size,
    mimeType: args.mimeType,
  };
  if (args.encrypted) {
    ref.encrypted = true;
    if (args.keyId) {
      ref.keyId = args.keyId;
    }
  }
  return ref;
}

/**
 * Parse a blob hash, validating format.
 * @returns The hex hash without prefix, or null if invalid.
 */
export function parseBlobHash(hash: string): string | null {
  if (!hash.startsWith('sha256:')) return null;
  const hex = hash.slice(7);
  if (hex.length !== 64) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return hex.toLowerCase();
}

/**
 * Create a blob hash string from hex.
 */
export function createBlobHash(hexHash: string): string {
  return `sha256:${hexHash.toLowerCase()}`;
}
