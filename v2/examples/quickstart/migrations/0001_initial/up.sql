-- The quickstart schema: one table, scoped by list.
-- typegen reads this to derive the schema SHAPE (column types, primary key).
-- The server manages its own sync_* tables; it never runs this migration.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
