-- Nested-folder query: default name is path-derived
-- (reporting/tasks-by-priority.sql → reportingTasksByPriority).
-- allow scan tasks: the fixture types a nested-folder query and keeps tasks without a priority index
SELECT id, title, priority
FROM tasks
WHERE priority = :priority
ORDER BY id
