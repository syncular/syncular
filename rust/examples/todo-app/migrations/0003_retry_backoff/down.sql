DROP INDEX IF EXISTS idx_sync_outbox_commits_due;
DROP INDEX IF EXISTS idx_sync_blob_outbox_status;

CREATE INDEX IF NOT EXISTS idx_sync_blob_outbox_status
  ON sync_blob_outbox (status, created_at);
