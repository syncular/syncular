-- The demo's live read: a list's todos, position-then-id ordered.
-- :listId infers to TEXT (compared against the todos.list_id column).
SELECT id, list_id, title, done, position, updated_at_ms, attachment
FROM todos
WHERE list_id = :listId
ORDER BY position, id
