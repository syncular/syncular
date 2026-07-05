# DESIGN — relational server storage

Decided to plan with Benjamin 2026-07-05, after the offline-sync-bench
integration surfaced that the v2 server persists synced rows as opaque
payload blobs rather than real relational tables (a property v1 had and
this rebuild dropped by default).

## Problem

Today every synced row lives in one generic table —
`sync_rows(partition, tbl, row_id, server_version, scopes, payload BLOB)` —
with the app's actual columns (`title`, `completed`, `project_id`…) encoded
opaquely inside `payload` (the SSP2 row bytes). Confirmed identical across
the sqlite, d1, and postgres backends. Consequence: the server database is
**not a queryable relational database of the app's data**. You cannot
`SELECT title FROM tasks` on the server; there are no foreign keys, no
server-side SQL/joins/aggregates over live data, no BI/analytics against
the DB. Clients get proper relational SQL (real per-table tables, indexes,
joins — intact); the server is a commit-log/blob store.

v1 stored real relational tables server-side. The greenfield rebuild chose
the generic store for engine simplicity (one schema-agnostic storage impl,
uniform scope indexing, row bytes stored verbatim). That undercuts "sync
lives inside your backend next to your data" — the data is there but not
usable *as data* — and is why the CDC-model benchmark harness doesn't fit.

## Constraints from the existing system (what makes this tractable)

1. **SPEC does not pin server storage layout.** The wire carries opaque
   payloads; how the server *persists* them is an implementation detail.
   So this is storage-layer only — no wire/SPEC/client changes,
   conformance stays green throughout.
2. **The column-materialization machinery already exists.** `sqlite-image.ts`
   already reads the `CompiledSchema` (`table.columns`, type affinities via
   `sqlType`), generates `CREATE TABLE tasks(id, project_id, …, _syncular_
   version)`, and `decodeRow(columns, payload)` → real column values, then
   INSERTs. IR→DDL and payload→typed-columns are built and tested.
3. **The storage interface is cleanly abstracted.** `ServerStorage` /
   `StorageTransaction` operate on `StoredRow { …, scopes, payload }`.
   Implementations swap internals without touching callers (push/pull).
4. **The server already holds the full `CompiledSchema`** (columns,
   primaryKeyIndex, scopePatterns, blob/crdt/encrypted column indices) — it
   knows every table's shape.
5. **The commit log is separate** (`sync_commits` / `sync_changes`) — an
   append-only history, not queried relationally.
6. **Two dialects, three backends**: sqlite + d1 share `sqlite-dialect`;
   postgres is its own.

## The design

Replace the opaque **current-row** store (`sync_rows`) with **real
per-app tables**; keep everything else. A `StoredRow` still crosses the
interface with a `payload`, but the storage impl now persists it as typed
columns and re-materializes the payload on read.

### Current-row tables

- On schema load, compile the IR into per-table DDL (generalize the
  sqlite-image builder): `CREATE TABLE <app_table>(<cols with affinities>,
  _sync_server_version INTEGER NOT NULL, _sync_scopes <TEXT|JSONB>)`.
  The primary key is the app PK. Scope columns are the app's real columns
  already (§3.1 binds a scope variable to a column), so they need no
  duplication — the `_sync_scopes` blob stays only as the resolved
  stored-scope map the §3.4 authz path reads (or is recomputed from the
  scope columns on read; decide in impl — keeping the map is cheaper).
- `upsertRow`: `decodeRow(columns, payload)` → typed values →
  `INSERT … ON CONFLICT(pk) DO UPDATE`; write `_sync_server_version` and
  the stored-scope map.
- `getRow` / `scanRows` / `readCommitWindow`'s current-row reads: read
  typed columns → **re-encode** to payload bytes (the wire shape callers
  expect) via the existing row codec `encodeRow`. Scope filtering uses the
  retained inverted index (below) or real indexed columns.

### Scope index

Keep the `sync_row_scopes` inverted index as the scope-filter mechanism
(uniform, already tuned, covering). Scope columns being real columns is a
bonus (server-side SQL can filter by them directly), but the pull scope
filter continues to use the inverted index so its performance is unchanged.

### User indexes (bonus — closes a prior finding)

`CREATE INDEX` in migrations currently applies client-side only (the server
had no real tables to index). With real server tables, the same declared
indexes are created server-side too — server queries over app data get the
app's indexes for free.

### Commit log — stays opaque (decision)

`sync_changes` keeps payload blobs. It is an append-only delta history, not
queried relationally; relationalizing it is large work for little value.
Benjamin's requirement (live SQL/FKs/analytics) is satisfied by the
current-row tables. The pull/segment paths read current rows (now real) for
bootstrap and `sync_changes` (opaque, re-served verbatim) for incremental
deltas — both continue to hand the wire the same bytes.

### Server-side schema migration (the genuinely new burden)

The server must create tables on first use and `ALTER` on a schemaVersion
bump (add column, add index — the migration subset already supports exactly
these). This is what v1 had and v2 dropped. Bounded by the migration
subset: CREATE TABLE / ADD COLUMN / CREATE INDEX only. The schema-floor
response (§1.6) already gates unsupported client versions; server migration
runs at schema load / version bump.

### Special columns

`json`/`blob_ref` → TEXT, `boolean` → INTEGER, `integer`/`float` → INTEGER/
REAL, `bytes`/`crdt`/`encrypted` → BLOB affinity (crdt = merged bytes,
encrypted = ciphertext — real columns holding opaque content, exactly as
sqlite-image already does). No column type is un-storable relationally.

## Decisions (recommendations)

1. **Relational is THE storage, not a toggle** (no-fallback doctrine) —
   strictly better for the product; the generic store is retired.
2. **Commit log stays opaque** (above).
3. **Scope filter keeps the inverted index** (unchanged perf) even though
   scope columns are now real.
4. **Re-encode on serve** is accepted (the row codec is fast; the
   sqlite-image lane already pays decode). Measured against `bench:ci`;
   re-derive a budget only if a real regression shows.
5. **Stored-scope map retained** on the row (cheaper than recomputing from
   columns for the §3.4 authz read).

## Phased implementation

- **P1 — relational row store module (~1 day):** extract/generalize the
  sqlite-image DDL+decode into a shared `relational-rows` helper: IR→DDL,
  upsert (decode→columns), read (columns→encode→payload). Unit-tested in
  isolation (round-trip a row through upsert→getRow == identity bytes).
- **P2 — wire into the three backends (~1 day):** sqlite + d1 (shared
  dialect) and postgres current-row paths use the helper; retain the scope
  index and commit log. The `ServerStorage` interface and all callers
  (push/pull/segments/admin queries) unchanged.
- **P3 — server-side schema create/migrate (~0.5–1 day):** create tables at
  schema load; ALTER on version bump; user indexes created server-side.
- **P4 — tests & bench (~0.5 day):** storage contract stays green; new
  assertions that the server holds real queryable tables (`SELECT` app
  columns; a foreign-key-shaped join works); re-encode-on-read byte
  correctness; both conformance pairings green; `bench:ci` green (measure
  the encode-on-serve delta). Then the offline-sync-bench integration
  unblocks — syncular becomes layer-over-real-Postgres like the CDC
  competitors.

Total: ~2–4 agent-days, well-bounded because the expensive part
(schema-aware column materialization) already exists.

## Verification / done criteria

- `bun run check`, `bench:ci`, cargo, both Rust conformance pairings green
  throughout (this is storage-only; the wire is unchanged).
- A server integration test proves real relational structure: after a push,
  `SELECT title, completed FROM tasks WHERE project_id = ?` runs on the
  server DB and returns typed rows; a join across two app tables works.
- Re-encode-on-read is byte-identical to the pushed payload (golden).
- The bench harness's `bench-admin` can read `/admin/tasks` from the
  syncular server's real tables (integration unblocked).

## Risks

- **Encode-on-serve perf** — the pull/bootstrap-rows lane now re-encodes.
  Mitigated: the sqlite-image lane (the premier bootstrap path) reads real
  tables and builds the image directly, so it may even get *faster*; the
  rows lane pays encode. Measure; the codec is not the bottleneck.
- **Postgres type mapping** — `bytea`/`text`/`int8`/`bool`/`double`; the
  d1/sqlite affinities differ. Per-dialect column mapping (the sqlite-image
  builder handles sqlite; add the postgres map).
- **Migration correctness under version bump** — bounded by the migration
  subset (CREATE TABLE / ADD COLUMN / CREATE INDEX); server migration
  mirrors the client's DDL derivation.

## Non-goals

- Relationalizing the commit-log history (`sync_changes` stays opaque).
- Any wire/SPEC/client change (this is server storage only).
- A configurable blob-vs-relational storage mode (relational is the store).
