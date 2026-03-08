import type { Generated } from 'kysely';

export interface ClientBlobStorage {
  write(
    hash: string,
    data: Uint8Array | ReadableStream<Uint8Array>
  ): Promise<void>;
  read(hash: string): Promise<Uint8Array | null>;
  readStream?(hash: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(hash: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
  getUsage?(): Promise<number>;
  clear?(): Promise<void>;
}

interface BlobStoreOptions {
  mimeType?: string;
  immediate?: boolean;
}

export interface BlobClient {
  store(
    data: Blob | File | Uint8Array,
    options?: BlobStoreOptions
  ): Promise<import('@syncular/core').BlobRef>;
  retrieve(ref: import('@syncular/core').BlobRef): Promise<Uint8Array>;
  isLocal(hash: string): Promise<boolean>;
  preload(refs: import('@syncular/core').BlobRef[]): Promise<void>;
  processUploadQueue(): Promise<{ uploaded: number; failed: number }>;
  getUploadQueueStats(): Promise<{
    pending: number;
    uploading: number;
    failed: number;
  }>;
  getCacheStats(): Promise<{ count: number; totalBytes: number }>;
  pruneCache(maxBytes?: number): Promise<number>;
  clearCache(): Promise<void>;
}

export interface SyncBlobCacheTable {
  hash: string;
  size: number;
  mime_type: string;
  body: Uint8Array;
  encrypted: number;
  key_id: string | null;
  cached_at: number;
  last_accessed_at: number;
}

export type BlobUploadStatus =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'confirming'
  | 'complete'
  | 'failed';

export interface SyncBlobOutboxTable {
  id: Generated<number>;
  hash: string;
  size: number;
  mime_type: string;
  body: Uint8Array;
  encrypted: number;
  key_id: string | null;
  status: BlobUploadStatus;
  attempt_count: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface SyncBlobClientDb {
  sync_blob_cache: SyncBlobCacheTable;
  sync_blob_outbox: SyncBlobOutboxTable;
}
