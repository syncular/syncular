-- Plain select + param inference: :projectId types to project_id (TEXT).
SELECT id, title, done, priority, estimate
FROM tasks
WHERE project_id = :projectId
ORDER BY priority
