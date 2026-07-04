-- Aggregate (count(*) → fallback nullable number) + a plain grouped ref.
SELECT project_id, count(*) AS doc_count
FROM docs
GROUP BY project_id
