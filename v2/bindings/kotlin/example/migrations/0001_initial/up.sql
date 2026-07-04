-- The quickstart `notes` schema the Kotlin todo demo speaks — the SAME shape
-- examples/quickstart ships and its TS clients use (id, list_id, body,
-- updated_at_ms; scoped by list). A todo is a note whose body carries the
-- title with a leading "[x] "/"[ ] " marker (see TodoStore.kt).
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
