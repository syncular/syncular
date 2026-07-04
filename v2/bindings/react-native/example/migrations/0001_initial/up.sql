-- The B6 demo `todos` schema — byte-identical to apps/demo-react's todos, so
-- the RN example is the same todo over the native core.
-- `attachment` is a §5.9 blob_ref column (tag 7): a nullable reference to an
-- uploaded file, resolved on demand via the /blobs endpoints.
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  attachment BLOB_REF
);
