ALTER TABLE sync_crdt_updates ADD COLUMN server_seq BIGINT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_crdt_updates_server_seq
  ON sync_crdt_updates (partition_id, stream_id, server_seq);

ALTER TABLE sync_crdt_checkpoints ADD COLUMN server_seq BIGINT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_crdt_checkpoints_server_seq
  ON sync_crdt_checkpoints (partition_id, stream_id, server_seq);
