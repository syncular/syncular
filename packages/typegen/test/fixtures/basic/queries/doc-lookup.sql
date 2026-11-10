-- Single-statement file with a `-- name:` override: the path default would be
-- docLookup, but the marker renames it verbatim to findDocByOrg.
-- name: findDocByOrg
-- allow scan docs: the fixture schema is shared with client, server and Rust tests and keeps docs without secondary indexes
SELECT id, body
FROM docs
WHERE org_id = :orgId
ORDER BY id
