CREATE TABLE IF NOT EXISTS sync_verified_roots (
  state_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  partition_id TEXT NOT NULL,
  commit_seq BIGINT NOT NULL,
  root TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (state_id, subscription_id)
);
