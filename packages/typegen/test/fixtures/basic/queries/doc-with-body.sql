-- Join across docs+tasks (same project); projection mixes both tables.
-- allow scan docs: the fixture schema is shared with client, server and Rust tests and keeps docs without secondary indexes
SELECT d.id AS doc_id, d.body, t.title AS task_title
FROM docs d
JOIN tasks t ON t.project_id = d.project_id
WHERE d.org_id = :orgId
