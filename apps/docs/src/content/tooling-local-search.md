# Local full-text search

Add a local full-text projection when users must search synced text while offline, such as notes, messages, or documents. Syncular generates and maintains an FTS5 projection beside a synced table in each client's SQLite database. The projection is local state: the server never receives, stores, or serves it. This guide takes you from a declaration to a ranked, highlighted search query.

::meta{for="App developers adding offline search on any SDK" time="10 minutes" first="tooling-queries" spec="2.4"}

:::terms
- **FTS5 projection**: A local SQLite full-text index over columns of one synced table.
- **Owner table**: The synced table the projection indexes, named by `content = …`.
- **Source id**: The projection's private `_syncular_source_id` column; it holds the owner's primary key as text.
:::

:::figure{title="Where the index lives" note="Local state only" ticks}
<div class="d-cols-2">
<div class="d-box">
<p class="d-label">Client · local SQLite</p>
<div class="d-stack">
<div class="node ok"><span class="t">Owner table</span>patient_notes<br>synced, scoped, subscribed</div>
<div class="d-down"><small>triggers keep it aligned in the same transaction</small></div>
<div class="node hot"><span class="t">FTS5 projection</span>patient_notes_fts<br>never subscribed, mutated, or uploaded</div>
</div>
</div>
<div class="d-box">
<p class="d-label">Server</p>
<div class="node"><span class="t">Owner rows only</span>No projection, no index, no search service</div>
</div>
</div>

::caption[Bootstrap, incremental sync, optimistic writes, rejection rollback, deletes, scope eviction, and schema reset all update the projection with the owner row.]
:::

The TypeScript and Rust cores implement the same schema contract, so one declaration works on web, Tauri, React Native, Swift, Kotlin, Flutter, and direct Rust hosts.

::::steps
:::step{title="Declare the projection" time="3 min"}
Add a virtual table to your migration history after its owner table:

```sql title="migrations/001_notes.sql"
CREATE TABLE patient_notes (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE VIRTUAL TABLE patient_notes_fts USING fts5(
  title,
  body,
  content = patient_notes,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

`content = patient_notes` declares ownership to Syncular and is not passed to SQLite as external-content mode. List only the owner table in `syncular.json.tables`. Typegen attaches the projection to that table in the neutral IR and in every generated client schema.

::checkpoint[`syncular generate` succeeds and the generated schema for `patient_notes` carries the projection.]
:::
:::step{title="Write the search query" time="4 min"}
Use a normal `.sql` or `.syql` [named query](/tooling-queries/). Join the projection's source id back to the owner table for scopes, metadata, and a generated row key:

```sql title="queries/search-notes.sql"
SELECT patient_notes_fts._syncular_source_id AS fts_source_id,
       n.id,
       n.title,
       bm25(patient_notes_fts) AS rank,
       snippet(patient_notes_fts, 1, '<mark>', '</mark>', ' … ', 16) AS excerpt
FROM patient_notes_fts
JOIN patient_notes n
  ON CAST(n.id AS TEXT) = patient_notes_fts._syncular_source_id
WHERE patient_notes_fts MATCH :query
  AND n.clinic_id = :clinicId
ORDER BY rank,
         patient_notes_fts._syncular_source_id ASC,
         n.id ASC
LIMIT 50;
```

`MATCH` gives `query` a generated string type. The portable SQL profile admits `bm25`, `highlight`, and `snippet` only in a statement that references a schema-declared FTS projection. Typegen treats the projected `_syncular_source_id` as exact non-null text and uses it with the owner key to prove stable identity for a bounded query.

The `n.clinic_id = :clinicId` predicate carries the synchronization coverage. The projection maps back to its owner table for reactive dependencies, so a content change invalidates generated React queries normally, but the projection never claims independent scopes or completeness.

::checkpoint[`syncular generate` emits a typed `searchNotesQuery` whose `query` parameter is a string.]
:::
:::step{title="Run the query" time="3 min"}
Call the generated query from your SDK like any other named query ([Named queries](/tooling-queries/)). In React:

```tsx title="src/Search.tsx"
const results = useQuery(searchNotesQuery, { query: term, clinicId });
```

::checkpoint[With the network off, typing a word that appears in a note returns that note with its `excerpt`.]
:::
::::

## What a projection accepts

A projection names 1 to 32 distinct declared-string columns of its owner table. Projection names are globally unique. The supported tokenizers are:

- `unicode61` (the default), including `remove_diacritics 0`, `1`, or `2`;
- `porter unicode61`;
- `trigram`.

Arbitrary virtual-table modules, options, tokenizers, prefix definitions, and hand-written maintenance triggers fail generation. No `LIKE '%…%'` fallback exists: a host without FTS5 support fails local schema creation instead of returning incomplete search results. The exact migration subset is on [Schema & typegen](/guide-schema/); the query language is [SYQL](/syql/). A search that ranks many matches and returns a few wide rows ranks narrow rows in a bounded CTE first ([ranked top-N](/syql/#ranked-top-n)).

## Lifecycle and encryption

The client creates a contentful FTS table with a private stable source-id column and deterministic maintenance triggers. When a projection first appears, the client bulk-indexes the existing owner rows.

An [encrypted column](/concepts-encryption/) is eligible when its declared application type is `string`, so `patient_notes.body` above can be encrypted and still searched. Encryption applies at the wire boundary: FTS indexes the decrypted value already in the protected local mirror, while the server and the commit log keep ciphertext. Revoking that local plaintext needs the same subscription gating and [authorized local purge](/concepts-local-data-purge/) as the owner row, and the purge removes both in one transaction.

## Boundaries

- FTS is local search. No server-side search service exists.
- A projection cannot be subscribed or written through `mutate()`.
- Rank is local presentation data. Do not treat it as a cross-database protocol value.
- The application primary key is the durable identity. Syncular does not rely on SQLite `rowid`, including for `WITHOUT ROWID` tables.

## Advanced: the source-id mapping

Reading `_syncular_source_id` from the projection makes FTS5 fetch the content row of every match. Each managed projection therefore keeps an internal mapping table from source identity to FTS rowid, keyed by the projection rowid. The generated SQL reads each source id through that mapping, while the authored query, its types, and its rows stay the same. On 50,000 matches the generated form took 53.9 ms against 73.6 ms for the authored form (Bun 1.4.0, macOS arm64). `highlight` and `snippet` still read the content row of every match they evaluate.

Deletes resolve the identity through a unique index and delete by rowid, which avoids scanning the unindexed source-identity column for each row during eviction or replacement. Both cores backfill the mapping for existing projections on startup without resetting application rows or pending writes. Source rows, mappings, and FTS changes commit or roll back together. Your query SQL and schema declarations need no change.
