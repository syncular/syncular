-- The Release board model, shared by the sync lab (apps/demo) and the SYQL
-- playground (apps/docs/src/playground). Every table carries `board_id` and
-- syncs under the `board:{board_id}` scope, so a device holds exactly the
-- boards its actor is granted. `boards.board_id` equals `boards.id`: the
-- scope column of a board row names the board itself.
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);

-- One row per board membership; `user_id` links one person across boards.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  role TEXT NOT NULL
);

-- `column_id` is one of backlog | doing | review | done; `position` orders
-- cards within a column (gapped integers, a move takes a free midpoint).
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  column_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  assignee_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  estimate INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE card_labels (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id),
  author_id TEXT NOT NULL REFERENCES members(id),
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX cards_by_column ON cards (board_id, column_id, position);
CREATE INDEX comments_by_card ON comments (card_id, created_at_ms);
