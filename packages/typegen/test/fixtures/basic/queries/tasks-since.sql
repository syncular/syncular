-- Comment-typed param: :sinceMs isn't compared to a plain column (it hits an
-- expression), so its type is declared explicitly.
-- param :sinceMs integer
SELECT id, title FROM tasks WHERE estimated_at > :sinceMs + 0
