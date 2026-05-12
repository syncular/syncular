CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  server_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL,
  project_id TEXT NULL,
  server_version BIGINT NOT NULL DEFAULT 0,
  image TEXT NULL,
  title_yjs_state TEXT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NULL,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at BIGINT NOT NULL
);

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
  schema_version INTEGER NOT NULL DEFAULT 1
);

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
