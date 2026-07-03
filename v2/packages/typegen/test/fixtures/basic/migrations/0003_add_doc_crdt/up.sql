/* Schema version 3: a collaborative CRDT body on docs (§5.10). */
ALTER TABLE docs ADD COLUMN body_doc CRDT;
