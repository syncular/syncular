# RFC 0005: FTS5 Local Search Projections

Status: Accepted and implemented in 0.15.0
Date: 2026-07-16

## Summary

Syncular applications need production-scale offline text search without
replicating a second mutable search table or falling back to unbounded
`LIKE '%…%'` scans. This RFC adds one deliberately narrow migration-subset v2
construct: a contentful FTS5 projection derived from one synced table. The
authored `content = …` option declares ownership to Syncular; it is not passed
through as SQLite's external-content mode.

```sql
CREATE VIRTUAL TABLE catalogue_codes_fts USING fts5(
  code,
  title,
  full_title,
  content = catalogue_codes,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

The virtual table is a local projection only. It never appears in the wire
schema, subscriptions, mutations, server storage, scope resolution, or row
codec. The generated client schema attaches its definition to the synced
content table. Every client core creates and maintains the same projection.

## Motivation

The first demand-trigger is Diego's immutable medical catalogue. Catalogue
releases contain large ICD, OPS, DRG, EBM, and GOÄ trees that must be searchable
offline on web, desktop, iOS, and Android. A normal secondary index can serve
code-prefix lookup but cannot provide bounded token search across titles and
descriptions. An application-specific raw-SQL hook would make Tauri and web
behave differently and would bypass schema drift checking.

## Contract

### Accepted migration syntax

The migration parser accepts:

```sql
CREATE VIRTUAL TABLE [IF NOT EXISTS] fts_name USING fts5(
  source_text_column [, source_text_column …],
  content = synced_table
  [, tokenize = 'allowlisted tokenizer']
)
```

Rules:

- `fts_name` is globally unique across tables, indexes, and other FTS
  projections;
- `content` is required and names a synced table created earlier in migration
  order;
- every indexed column exists on the content table, is non-encrypted, and has
  declared string type;
- at least one and at most 32 distinct columns are required;
- `content_rowid`, prefix indexes, column weights, custom tokenizers, arbitrary
  FTS options, and hand-written triggers are not accepted in this revision;
- tokenizer configuration is allowlisted to deterministic built-in FTS5
  tokenizers; the default is `unicode61`;
- the statement is local-only and therefore is not listed in
  `syncular.json.tables`.

Unsupported syntax fails generation with the migration path and exact reason.
There is no runtime fallback to `LIKE` and no silent omission on a client that
lacks FTS5.

### Generated schema

The neutral IR and every generated language schema add an optional
`ftsIndexes` array to the owning synced table:

```json
{
  "name": "catalogue_codes",
  "ftsIndexes": [
    {
      "name": "catalogue_codes_fts",
      "columns": ["code", "title", "full_title"],
      "tokenize": "unicode61 remove_diacritics 2"
    }
  ]
}
```

The property is omitted when empty so pre-FTS generated output stays stable.

### Local materialization

Each client creates a contentful FTS5 table with a private
`_syncular_source_id UNINDEXED` column plus deterministic
insert/delete/update triggers on the visible synced table. The source ID is the
string form of the application primary key, rather than SQLite `rowid`; this
keeps the projection correct across `INSERT OR REPLACE`, overlay rebuilds, and
tables declared `WITHOUT ROWID`. Existing content is bulk-copied when the
projection is first created. Scope purge, snapshot replace, delta upsert,
optimistic mutation, rejection rollback, and schema reset all flow through the
visible table and therefore update the index transactionally.

The Rust client creates FTS only for the visible half of its base/visible pair.
Its overlay rebuild suspends per-row FTS triggers and performs one FTS rebuild
after the visible table is complete, avoiding an extra tokenizer pass for every
copied row.

A client without compiled FTS5 support fails during local schema creation with
an explicit local-schema error. It does not continue with missing or stale
search results.

### Query and invalidation

Named SYQL may use `MATCH`, `bm25`, `highlight`, and `snippet` through SQLite's
FTS5 surface. The FTS projection maps to its synced content table for reactive
dependency metadata, so changes to the content table invalidate FTS queries.
Coverage remains derived only from scope predicates on the synced content
table; the local projection never claims independent completeness.

Applications join the private source identity to the content table when they
need scope filtering, hierarchy metadata, or a generated row key:

```sql
SELECT c.id, c.code, c.title, bm25(catalogue_codes_fts) AS rank
FROM catalogue_codes_fts
JOIN catalogue_codes c
  ON CAST(c.id AS TEXT) = catalogue_codes_fts._syncular_source_id
WHERE catalogue_codes_fts MATCH :query
  AND c.release_id = :releaseId
ORDER BY rank, c.code
LIMIT :limit;
```

### Authority and security

FTS contains only local plaintext already present in the content table. An
encrypted column cannot be indexed by this feature: doing so would create a
new durable plaintext copy outside the reviewed encrypted-data boundary.
Search projections inherit the content table's local lifetime and are removed
on scope purge, schema reset, or local database reset.

## Non-goals

- Server-side full-text search.
- Replicating FTS segments or tokenizer state.
- Mutating virtual tables through `mutate()`.
- Arbitrary virtual-table modules or SQL triggers.
- Custom native tokenizer plugins.
- A cross-database relevance guarantee; supported clients use the same SQLite
  FTS5 tokenizer contract, while rank values remain local presentation data.

## Verification

- Typegen parser and hard-error tests for accepted/rejected syntax.
- Neutral IR and TypeScript/Swift/Kotlin/Dart golden output.
- Named-query type/dependency tests using `MATCH` and `bm25`.
- TypeScript client tests for initial rebuild, insert/update/delete, scope
  purge, and schema reset.
- Rust client tests for the same visible results and overlay rebuild.
- Existing TS/Rust conformance remains green because no wire behavior changes.
- Consumer verification in Diego covers browser and Tauri-native catalogue
  search from the same generated schema.
