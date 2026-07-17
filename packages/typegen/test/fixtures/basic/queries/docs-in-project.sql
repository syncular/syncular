SELECT id, body
FROM docs
WHERE org_id = :orgId AND project_id = :projectId
ORDER BY id;
