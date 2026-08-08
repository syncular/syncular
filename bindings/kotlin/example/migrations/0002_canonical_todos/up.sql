CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

DROP TABLE notes;
