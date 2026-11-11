-- Joined boolean projections cover an aliased exact value and a nullable
-- computed value. TypeScript must lift SQLite's numeric representation for
-- both while the native emitters keep their existing fromRow behavior.
-- allow automatic_index docs: the fixture schema is shared with client, server and Rust tests and keeps docs without secondary indexes
-- allow unbounded tasks: the fixture types boolean projections over every task
SELECT t.id, t.done AS is_done, t.reviewed AS maybe_done
FROM tasks t
JOIN docs d ON d.project_id = t.project_id
ORDER BY t.id
