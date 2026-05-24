CREATE TABLE IF NOT EXISTS sync_crdt_documents (
  document_key TEXT PRIMARY KEY,
  app_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  state_column TEXT NOT NULL,
  sync_mode TEXT NOT NULL,
  state_base64 TEXT NULL,
  state_vector_base64 TEXT NOT NULL DEFAULT '',
  pending_updates BIGINT NOT NULL DEFAULT 0,
  flushed_updates BIGINT NOT NULL DEFAULT 0,
  acked_updates BIGINT NOT NULL DEFAULT 0,
  log_updates BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  compacted_at BIGINT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_crdt_documents_identity
  ON sync_crdt_documents (app_table, row_id, field_name);

CREATE TABLE IF NOT EXISTS sync_crdt_update_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_key TEXT NOT NULL,
  app_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  update_id TEXT NOT NULL UNIQUE,
  client_commit_id TEXT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  update_base64 TEXT NOT NULL,
  state_vector_base64 TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  flushed_at BIGINT NULL,
  acked_at BIGINT NULL,
  FOREIGN KEY (document_key) REFERENCES sync_crdt_documents(document_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_update_log_document_status
  ON sync_crdt_update_log (document_key, status, created_at);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_update_log_client_commit
  ON sync_crdt_update_log (client_commit_id);
