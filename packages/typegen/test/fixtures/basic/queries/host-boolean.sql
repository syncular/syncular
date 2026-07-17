-- A minimal projection shared by direct, worker/follower, Tauri, and React
-- Native host-parity tests. Each host returns SQLite-shaped 0/1 storage values;
-- the generated runner must return declared JavaScript booleans.
SELECT id, done
FROM tasks
WHERE project_id = :projectId
ORDER BY id
