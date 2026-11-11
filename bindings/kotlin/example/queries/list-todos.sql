-- The demo's live read: every todo in a list, id-ordered.
-- allow scan todos: this example syncs with the quickstart server at schema version 1; a declared index needs schema version 2 on the client and the server
SELECT id, list_id, title, done, position, updated_at_ms
FROM todos
WHERE list_id = :listId
ORDER BY id
