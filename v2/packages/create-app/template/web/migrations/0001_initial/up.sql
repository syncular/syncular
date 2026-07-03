-- Your schema, one table to start. typegen reads this to derive the schema
-- SHAPE (column types, primary key); the server manages its own sync_* tables
-- and never runs this migration.
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
