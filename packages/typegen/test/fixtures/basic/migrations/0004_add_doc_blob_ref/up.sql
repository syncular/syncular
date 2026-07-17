/* Schema version 4: exercise the application-facing blob reference type. */
ALTER TABLE docs ADD COLUMN remote_blob BLOB_REF;
