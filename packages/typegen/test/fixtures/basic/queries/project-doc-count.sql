-- Aggregate (a whole-expression count(*) is integer) + a plain grouped ref.
-- allow unbounded docs: the fixture types an aggregate over every doc
SELECT project_id, count(*) AS doc_count
FROM docs
GROUP BY project_id
