-- Join across docs+tasks (same project); projection mixes both tables.
SELECT d.id AS doc_id, d.body, t.title AS task_title
FROM docs d
JOIN tasks t ON t.project_id = d.project_id
WHERE d.org_id = :orgId
