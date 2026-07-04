-- Initial schema: tasks + docs, covering all six §2.4 column types.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  priority BIGINT,
  meta JSON
);

CREATE TABLE docs (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  score DOUBLE,
  attachment BLOB,
  PRIMARY KEY (id)
) WITHOUT ROWID;
