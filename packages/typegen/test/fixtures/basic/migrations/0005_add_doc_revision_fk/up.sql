/* Schema version 5: a declared reference (§6.11) across two tables. */
CREATE TABLE doc_revisions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  doc_id TEXT REFERENCES docs(id) ON DELETE CASCADE,
  note TEXT
);
