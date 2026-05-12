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
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_updates_stream_seq
  ON sync_crdt_updates (partition_id, stream_id, seq);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_updates_scope_table
  ON sync_crdt_updates (partition_id, app_table, row_id, field_name);

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
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_checkpoints_stream_covers
  ON sync_crdt_checkpoints (partition_id, stream_id, covers_seq);

CREATE INDEX IF NOT EXISTS idx_sync_crdt_checkpoints_scope_table
  ON sync_crdt_checkpoints (partition_id, app_table, row_id, field_name);
