-- Required columns from the optional side must be nullable in every emitted
-- language even though their physical schema columns are NOT NULL.
-- allow scan docs: the fixture schema is shared with client, server and Rust tests and keeps docs without secondary indexes
SELECT t.id AS task_id, t.title, d.body AS doc_body
FROM tasks AS t
LEFT JOIN docs AS d ON d.project_id = t.project_id
WHERE t.id = :taskId
