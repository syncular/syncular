-- IN-clause param inference: both params type to project_id (TEXT).
SELECT id, title FROM tasks WHERE project_id IN (:first, :second)
