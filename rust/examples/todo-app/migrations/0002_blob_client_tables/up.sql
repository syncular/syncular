CREATE TABLE IF NOT EXISTS sync_blob_cache (
  hash TEXT PRIMARY KEY,
  size BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  body BLOB NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  key_id TEXT NULL,
  cached_at BIGINT NOT NULL,
  last_accessed_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_blob_cache_last_accessed
  ON sync_blob_cache (last_accessed_at);

CREATE TABLE IF NOT EXISTS sync_blob_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  size BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  body BLOB NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  key_id TEXT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error TEXT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_blob_outbox_status
  ON sync_blob_outbox (status, created_at);
