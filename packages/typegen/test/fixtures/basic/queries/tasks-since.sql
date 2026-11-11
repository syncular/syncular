-- Comment-typed param: :sinceMs isn't compared to a plain column (it hits an
-- expression), so its type is declared explicitly.
-- param :sinceMs integer
-- allow scan tasks: the fixture types a comment-declared param and keeps tasks without an estimated_at index
SELECT id, title FROM tasks WHERE estimated_at > :sinceMs + 0
