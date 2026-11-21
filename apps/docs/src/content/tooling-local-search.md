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
<div class="node ok"><span class="t">Owner table</span>patient_notes<br>synced, scoped, covered by units</div>
<div class="d-down"><small>triggers keep it aligned in the same transaction</small></div>
<div class="node hot"><span class="t">FTS5 projection</span>patient_notes_fts<br>never synced, mutated, or uploaded</div>
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
       CAST(bm25(patient_notes_fts) AS REAL) AS rank,
       CAST(snippet(patient_notes_fts, 1, '<mark>', '</mark>', ' … ', 16) AS TEXT) AS excerpt
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

The `CAST` wrappers give the computed `rank` and `excerpt` columns a generated type ([Named queries](/tooling-queries/)). `MATCH` gives `query` a generated string type. The portable SQL profile admits `bm25`, `highlight`, and `snippet` only in a statement that references a schema-declared FTS projection. Typegen treats the projected `_syncular_source_id` as exact non-null text and uses it with the owner key to prove stable identity for a bounded query.

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

The client creates a contentful FTS table with a private stable source-id column and deterministic maintenance triggers. When a projection first appears, the client bulk-indexes the existing owner rows. Every open compares the projection's mapping row count with the owner table's row count and rebuilds a projection whose counts differ. Replicas the TypeScript client wrote with releases up to 0.78.1 lost the entries of rows that a SQLite image delivered again at their held version; the first open after an upgrade restores them. Rebuilding a 114,007-row projection took 4.2 s once; the check on later opens takes 7 ms (Apple M5 Pro, Bun).

An [encrypted column](/concepts-encryption/) is eligible when its declared application type is `string`, so `patient_notes.body` above can be encrypted and still searched. Encryption applies at the wire boundary: FTS indexes the decrypted value already in the protected local mirror, while the server and the commit log keep ciphertext. Revoking that local plaintext needs the same subscription gating and [authorized local purge](/concepts-local-data-purge/) as the owner row, and the purge removes both in one transaction.

## Boundaries

- FTS is local search. No server-side search service exists.
- A projection is never synced and cannot be written through `mutate()`.
- Rank is local presentation data. Do not treat it as a cross-database protocol value.
- The application primary key is the durable identity. Syncular does not rely on SQLite `rowid`, including for `WITHOUT ROWID` tables.

## Advanced: the source-id mapping

Reading `_syncular_source_id` from the projection makes FTS5 fetch the content row of every match. Each managed projection therefore keeps an internal mapping table from source identity to FTS rowid, keyed by the projection rowid. The generated SQL reads each source id through that mapping, while the authored query, its types, and its rows stay the same. On 50,000 matches the generated form took 53.9 ms against 73.6 ms for the authored form (Bun 1.4.0, macOS arm64). `highlight` and `snippet` still read the content row of every match they evaluate.

Deletes resolve the identity through a unique index and delete by rowid, which avoids scanning the unindexed source-identity column for each row during eviction or replacement. Both cores backfill the mapping for existing projections on startup without resetting application rows or pending writes. Source rows, mappings, and FTS changes commit or roll back together. Your query SQL and schema declarations need no change.

## App-filled local projections

An app-filled projection stores values your app derives from a synced source
row. Use one when your app opens a sealed record on the device and needs to
query the result across restarts.

Add `localProjections` to the source table entry in `syncular.json`. Each
column takes a `declaredType` of `string`, `integer`, `real`, `boolean` or
`json`. When you open the database with a changed projection
declaration, the client clears its derived rows and queues its source rows again.

```json
{
  "name": "sealed_records",
  "scopes": ["workspace:{workspace_id}"],
  "localProjections": [
    {
      "name": "record_names",
      "columns": [{ "name": "display_name", "declaredType": "string" }],
      "fts": { "tokenize": "unicode61", "columns": ["display_name"] },
      "dependencies": [
        { "table": "record_wraps", "column": "key_id", "sourceColumn": "key_id" }
      ]
    }
  ]
}
```

Declare `record_wraps` as a synced table. Both dependency columns must be
plaintext. Use the source primary key or declare a local index whose first
column is `sourceColumn`. On a write to `record_wraps`, the client clears
projection rows whose source `key_id` matches the old or new value of
`record_wraps.key_id`. The client queues those source rows in the same transaction.

Import `compileLocalProjections` from `@syncular/client/projections`.
Pass `{ createProjections: compileLocalProjections }` to the direct
`SyncClient` constructor or to `startSyncWorker` in your worker entry.
The Rust client loads the projection from the generated schema.

1. Call `projectionPending(name, limit)` for `{ epoch, entries }`. Each
   entry carries a `sourceId` and a `token`. Pending work survives restarts
   and browser leader changes. Register `onProjectionPending` before your
   first read after security activation. Each event names a projection that
   received new pending work in a committed transaction. Call
   `projectionPending` to read the work.
2. Read the source rows and derive their values. Submit
   `writeProjection(name, epoch, rows)` with
   `{ sourceId, token, values }` for each row. Pass `values: null` to withhold a
   row from subsequent batches.
   A source write, matching dependency write, or explicit invalidation queues
   the row again. For a JSON column, pass a JSON document as a string. An omitted
   or null column stores SQL NULL.
3. Read `{ written, stale }` from the result. The client skips any entry
   whose token or epoch changed while your app derived its values. It
   rejects the entire batch with `client.projection_invalid` if it contains
   an unknown column or a value of the wrong type.

Call `invalidateProjection(name, sourceIds?)` when the app's authority over
the derived values changes. This clears the selected projection rows and
queues the source rows again. Omit `sourceIds` to select every row. The epoch
advances and invalidates every outstanding batch for the projection.

Query the projection by its name. Join its `_syncular_source_id` to the
source primary key as text. To use FTS5, list at least one string column in
`fts.columns`. List each column once. Use `MATCH` to search the indexed
columns. Projection writes and clears invalidate named queries that
read it. A query can establish coverage through the synced source
table's declared scopes. During security preflight, the client rejects all
three projection operations with `client.security_preflight_required`.

The replica stores derived values in plaintext, under the same
[device security rules as decrypted encrypted columns](/concepts-encryption/).
Your app verifies access before it derives values or activates protected reads.
A scope revocation or [authorized local purge](/concepts-local-data-purge/)
removes the projection rows and FTS copies together with the affected source
rows. Sync transfers the source data. Derived values stay on the device.

To erase derived plaintext during security preflight, use
`purgeLocalData({ purgeId, targets: [{ projection: "record_names" }] })`.
The client clears the projection and queues its source rows again. It
preserves the source rows and pending commits. The purge rewrites the
replica file and truncates its write-ahead log (WAL) to erase the deleted
values. After an interruption, retry the same purge plan with the same
`purgeId` to finish erasure.
