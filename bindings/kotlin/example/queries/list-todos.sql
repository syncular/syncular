-- The demo's live read: every todo in a list, id-ordered.
SELECT id, list_id, title, done, position, updated_at_ms
FROM todos
WHERE list_id = :listId
ORDER BY id
