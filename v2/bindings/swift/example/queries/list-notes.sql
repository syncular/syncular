-- The demo's live read: every note in a list, id-ordered. :listId infers to
-- TEXT (compared against notes.list_id). Rows decode to the generated
-- ListNotesRow — the projection's own type.
SELECT id, list_id, body, updated_at_ms
FROM notes
WHERE list_id = :listId
ORDER BY id
