pub const RUNTIME_SCHEMA_VERSION: i32 = 6;

pub fn runtime_schema_version() -> i32 {
    RUNTIME_SCHEMA_VERSION
}

pub const RUNTIME_SYSTEM_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sync_subscription_state (
  state_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  "table" TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '{}',
  params_json TEXT NOT NULL DEFAULT '{}',
  cursor BIGINT NOT NULL,
  bootstrap_state_json TEXT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (state_id, subscription_id)
);

CREATE TABLE IF NOT EXISTS sync_outbox_commits (
  id TEXT PRIMARY KEY,
  client_commit_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  last_response_json TEXT NULL,
  error TEXT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  acked_commit_seq BIGINT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  next_attempt_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_commits_due
  ON sync_outbox_commits (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  outbox_commit_id TEXT NOT NULL,
  client_commit_id TEXT NOT NULL,
  op_index INTEGER NOT NULL,
  result_status TEXT NOT NULL,
  message TEXT NOT NULL,
  code TEXT NULL,
  server_version BIGINT NULL,
  server_row_json TEXT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT NULL,
  resolution TEXT NULL
);

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
  updated_at BIGINT NOT NULL,
  next_attempt_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sync_blob_outbox_status
  ON sync_blob_outbox (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS sync_crdt_updates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  partition_id TEXT NOT NULL DEFAULT 'default',
  stream_id TEXT NOT NULL,
  app_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  update_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NULL,
  client_id TEXT NULL,
  key_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  server_seq BIGINT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_updates_stream_seq
  ON sync_crdt_updates (partition_id, stream_id, seq);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_updates_scope_table
  ON sync_crdt_updates (partition_id, app_table, row_id, field_name);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_updates_server_seq
  ON sync_crdt_updates (partition_id, stream_id, server_seq);

CREATE TABLE IF NOT EXISTS sync_crdt_checkpoints (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  partition_id TEXT NOT NULL DEFAULT 'default',
  stream_id TEXT NOT NULL,
  app_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL UNIQUE,
  covers_seq BIGINT NOT NULL,
  actor_id TEXT NULL,
  client_id TEXT NULL,
  key_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  server_seq BIGINT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_checkpoints_stream_covers
  ON sync_crdt_checkpoints (partition_id, stream_id, covers_seq);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_checkpoints_scope_table
  ON sync_crdt_checkpoints (partition_id, app_table, row_id, field_name);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_checkpoints_server_seq
  ON sync_crdt_checkpoints (partition_id, stream_id, server_seq);

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
"#;
