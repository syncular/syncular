-- Your schema, one table to start. typegen reads this to derive the schema
-- SHAPE (column types, primary key); the server manages its own sync_* tables
-- and never runs this migration.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
