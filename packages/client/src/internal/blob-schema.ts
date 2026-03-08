import type { Generated } from 'kysely';

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

export interface SyncInternalBlobClientDb {
  sync_blob_cache: SyncBlobCacheTable;
  sync_blob_outbox: SyncBlobOutboxTable;
}
