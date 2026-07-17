-- Native/Rust query-codegen fidelity for bytes, CRDT, and blob references.
SELECT id, attachment, body_doc, remote_blob
FROM docs
WHERE id = :id;
