-- Nested-folder query: default name is path-derived
-- (reporting/tasks-by-priority.sql → reportingTasksByPriority).
SELECT id, title, priority
FROM tasks
WHERE priority = :priority
ORDER BY id
