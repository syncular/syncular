ALTER TABLE sync_outbox_commits
  ADD COLUMN next_attempt_at BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_commits_due
  ON sync_outbox_commits (status, next_attempt_at, created_at);

ALTER TABLE sync_blob_outbox
  ADD COLUMN next_attempt_at BIGINT NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_sync_blob_outbox_status;

CREATE INDEX IF NOT EXISTS idx_sync_blob_outbox_status
  ON sync_blob_outbox (status, next_attempt_at, created_at);
