-- Multi-statement file: two queries in one .sql. Each statement REQUIRES a
-- `-- name:` marker (the file's path can't disambiguate them) and each carries
-- its own leading `-- param`/`-- name` scope.

-- name: reportOpenTasks
-- One statement's scope: infers :projectId from project_id (TEXT).
SELECT id, title, done
FROM tasks
WHERE project_id = :projectId AND done = 0
ORDER BY id;

-- name: reportDocScores
-- A separate statement, separately scoped: :minScore is compared to an
-- expression, so it needs its own `-- param` comment.
-- param :minScore float
SELECT id, org_id, score
FROM docs
WHERE score > :minScore * 1.0
ORDER BY id
