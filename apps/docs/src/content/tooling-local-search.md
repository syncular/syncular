# Local full-text search

Syncular can generate and maintain an FTS5 projection beside a synced table,
giving every client production-scale full-text search while offline. The
projection is local SQLite state: it is never subscribed, mutated, uploaded,
or stored by the server.

The TypeScript and Rust cores implement the same schema contract, so one
declaration works on web, Tauri, React Native, Swift, Kotlin, Flutter, and
direct Rust hosts.

## Declare the projection

Add a virtual table to your normal migration history after its owning table:

```sql
CREATE TABLE catalogue_codes (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  full_title TEXT NOT NULL
);

CREATE VIRTUAL TABLE catalogue_codes_fts USING fts5(
  code,
  title,
  full_title,
  content = catalogue_codes,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

Here `content = catalogue_codes` declares ownership to Syncular; it is not
passed through as SQLite external-content mode. Keep only the owning table in
`syncular.json.tables`. Typegen attaches the projection to that table in the
neutral IR and every generated client schema.

Projection names are globally unique. A projection accepts 1–32 distinct
declared-string columns. Supported tokenizers are:

- `unicode61` (the default), including `remove_diacritics 0`, `1`, or `2`;
- `porter unicode61`;
- `trigram`.

Arbitrary virtual-table modules, options, tokenizers, prefix definitions, and
hand-written maintenance triggers fail generation. There is no silent
`LIKE '%…%'` fallback: a host without FTS5 support fails local schema creation
instead of returning incomplete search results.

## Query it

Use a normal `.sql` or `.syql` named query. Join the projection's stable source
identity back to the synced table for scopes, metadata, and a generated row
key:

```sql
-- queries/search-catalogue.sql
SELECT catalogue_codes_fts._syncular_source_id AS fts_source_id,
       c.id,
       c.code,
       c.title,
       bm25(catalogue_codes_fts) AS rank,
       snippet(catalogue_codes_fts, 1, '<mark>', '</mark>', ' … ', 16) AS excerpt
FROM catalogue_codes_fts
JOIN catalogue_codes c
  ON CAST(c.id AS TEXT) = catalogue_codes_fts._syncular_source_id
WHERE catalogue_codes_fts MATCH :query
  AND c.release_id = :releaseId
ORDER BY rank,
         catalogue_codes_fts._syncular_source_id ASC,
         c.id ASC
LIMIT 50;
```

`MATCH` gives `query` a generated string type. `bm25`, `highlight`, and
`snippet` are admitted by the portable SQL profile only when the statement
references a schema-declared FTS projection. Typegen treats the projected
`_syncular_source_id` as exact non-null text and can use it with the owner key
to prove stable identity for a bounded query.

The projection maps back to its owning synced table for reactive dependencies.
A content change therefore invalidates generated React queries normally.
Synchronization coverage still comes from predicates on the synced owner—the
local projection never claims independent scopes or completeness.

## Lifecycle and encryption

The client creates a contentful FTS table with a private stable source-id
column and deterministic maintenance triggers. Existing owner rows are bulk
indexed when the projection first appears. Bootstrap, incremental sync,
optimistic writes, rejection rollback, deletes, scope eviction, and schema
reset keep it transactionally aligned with the visible table.

Encrypted columns are eligible when their declared application type is
`string`. Encryption still happens only at the wire boundary: FTS indexes the
decrypted value already present in the protected local mirror, while the server
and commit log retain ciphertext. Revoking that local plaintext requires the
same subscription gating and [authorized local purge](/concepts-local-data-purge/)
as its owner row; the purge removes both in one transaction.

## Boundaries

- FTS is local search, not a server-side search service.
- The projection cannot be subscribed or written through `mutate()`.
- Rank is local presentation data; do not treat it as a cross-database
  protocol value.
- The application primary key is the durable identity. Syncular does not rely
  on SQLite `rowid`, including for `WITHOUT ROWID` tables.

For the exact migration subset, see [Schema & typegen](/guide-schema/). For
typed query generation, see [Named queries](/tooling-queries/) and
[SYQL](/syql/).
