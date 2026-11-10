-- allow scan docs: the fixture schema is shared with client, server and Rust tests and keeps docs without secondary indexes
SELECT id, body
FROM docs
WHERE org_id = :orgId AND project_id = :projectId
ORDER BY id;
