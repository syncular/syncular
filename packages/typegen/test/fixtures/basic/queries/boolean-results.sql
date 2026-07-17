-- Joined boolean projections cover an aliased exact value and a nullable
-- computed value. TypeScript must lift SQLite's numeric representation for
-- both while the native emitters keep their existing fromRow behavior.
SELECT t.id, t.done AS is_done, t.reviewed AS maybe_done
FROM tasks t
JOIN docs d ON d.project_id = t.project_id
ORDER BY t.id
