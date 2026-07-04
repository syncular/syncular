-- Single-statement file with a `-- name:` override: the path default would be
-- docLookup, but the marker renames it verbatim to findDocByOrg.
-- name: findDocByOrg
SELECT id, body
FROM docs
WHERE org_id = :orgId
ORDER BY id
