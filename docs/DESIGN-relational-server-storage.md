# DESIGN — relational server storage

**Status: IMPLEMENTED 2026-07-06** — `packages/server/src/relational-rows.ts`
(shared helper), wired into all three backends; `ServerStorage.ensureSchema`
creates/migrates the per-app tables (the handler calls it on first contact).
Verified: full repo suite, both conformance pairings, cargo, `bench:ci` all
green; relational assertions live in
`packages/server/test/relational-rows.test.ts`.

Decided to plan with Benjamin 2026-07-05, after the offline-sync-bench
integration surfaced that the v2 server persists synced rows as opaque
payload blobs rather than real relational tables (a property v1 had and
this rebuild dropped by default).

Revised 2026-07-06 after critical review: the row payload is **retained**
in the per-app tables (typed columns are a projection, not a
re-materialization source), partition is part of the primary key, and the
D1 number model / Postgres JSONB decisions are made explicit. Rationale
inline; the superseded choices are recorded under "Rejected alternatives".

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

**Scope caveat (E2EE):** for encrypted columns the server materializes
ciphertext — a real column holding opaque bytes. The relational value
proposition (live SQL, joins, analytics) applies to **plaintext columns
only**. Apps that encrypt everything get correctly-shaped but unreadable
tables; that is inherent to E2EE, not a defect of this design, but it
bounds the motivation and the bench-harness expectations.

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
   Caveat: implementations are schema-*agnostic* today; this design makes
   them schema-*aware* (the `CompiledSchema` is injected at construction
   and refreshed on version bump) — the interface is unchanged, the
   lifecycle is not.
4. **The server already holds the full `CompiledSchema`** (columns,
   primaryKeyIndex, scopePatterns, blob/crdt/encrypted column indices) — it
   knows every table's shape.
5. **The commit log is separate** (`sync_commits` / `sync_changes`) — an
   append-only history, not queried relationally.
6. **Two dialects, three backends**: sqlite + d1 share `sqlite-dialect`;
   postgres is its own.
7. **The migration subset is small**: CREATE TABLE / ADD COLUMN /
   CREATE INDEX / DROP INDEX / DROP TABLE. Note: this subset existed **client-side only**
   before relational server storage —
   v2 has no server-side DDL-application machinery at all
   (web-client/test/indexes.test.ts states this explicitly). P3 is
   greenfield, bounded by the subset, not a revival of existing code.

## The design

Replace the generic **current-row** store (`sync_rows`) with **real
per-app tables** that carry both the typed columns *and* the verbatim
payload:

- **Typed columns are the queryable projection** — what Benjamin's
  requirement needs: `SELECT title FROM tasks`, joins, FK-shaped queries,
  BI, the bench-admin endpoint.
- **`_sync_payload` is the wire source of truth** — the serve path
  (pull/bootstrap/segments) reads it verbatim, exactly as today. No
  re-encode on the hot path, no codec-canonicality proofs, no
  byte-identity risk, no conformance exposure.

Round-trip identity (`encodeRow(decodeRow(payload)) === payload`) becomes a
**test-time invariant** asserted continuously in the storage contract
tests, not a runtime correctness requirement. If it holds across dialects
for long enough, dropping `_sync_payload` is a cheap follow-up migration
(see Non-goals) — it is not a fork in this design.

### Current-row tables

- On schema load, compile the IR into per-table DDL (generalize the
  sqlite-image builder):

  ```sql
  CREATE TABLE <app_table>(
    _sync_partition       TEXT NOT NULL,
    <app cols with affinities>,
    _sync_server_version  INTEGER NOT NULL,
    _sync_scopes          <TEXT|JSONB> NOT NULL,
    _sync_payload         <BLOB|BYTEA> NOT NULL,
    PRIMARY KEY (_sync_partition, <app pk>)
  );
  ```

  **Partition is part of the primary key.** The current store keys
  everything by `(partition, tbl, row_id)` and multiple partitions share
  one database; per-app tables must preserve that or same-PK rows in two
  partitions collide. (Single-partition deployments simply see a constant
  column; server-side app queries add `WHERE _sync_partition = ?` or a
  view per partition if ergonomics warrant it later.)
- App table and column names are validated at schema compile: reject the
  `sync_` / `_sync_` prefixes (namespace shared with `sync_commits`,
  `sync_changes`, `sync_row_scopes`), reject identifiers over 63 bytes
  (Postgres truncation), and always emit quoted identifiers (the
  sqlite-image `quoteIdent` generalizes).
- `upsertRow`: `decodeRow(columns, payload)` → typed values →
  `INSERT … ON CONFLICT(_sync_partition, pk) DO UPDATE`, writing the typed
  columns, `_sync_server_version`, `_sync_scopes`, and `_sync_payload` in
  one statement. The conflict target is the row primary key only: a
  secondary unique-index collision fails the statement and preserves the
  existing row; replace-style writes are forbidden for application rows.
- `getRow` / `scanRows` / `readCommitWindow`'s current-row reads: `SELECT
  _sync_payload, _sync_server_version, _sync_scopes …` — byte-verbatim,
  same as today. Typed columns are never read on the sync serve path.

### Scope index

Keep the `sync_row_scopes` inverted index as the scope-filter mechanism
(uniform, already tuned, covering). Scope columns being real columns is a
bonus (server-side SQL can filter by them directly), but the pull scope
filter continues to use the inverted index so its performance is unchanged.

Scope data now exists in three places per row — the real app columns, the
`_sync_scopes` stored map (what the §3.4 authz read consumes), and the
inverted index. `upsertRow` writes all three in the same transaction; the
storage contract test asserts their consistency.

### User indexes (bonus — closes a prior finding)

`CREATE INDEX` in migrations currently applies client-side only (the server
had no real tables to index). With real server tables, the same declared
indexes are created server-side too — server queries over app data get the
app's indexes for free.

### Commit log — stays opaque (decision)

`sync_changes` keeps payload blobs. It is an append-only delta history, not
queried relationally; relationalizing it is large work for little value.
Benjamin's requirement (live SQL/FKs/analytics) is satisfied by the
current-row tables. The pull/segment paths read current rows (payload
verbatim) for bootstrap and `sync_changes` (opaque, re-served verbatim)
for incremental deltas — both hand the wire the same bytes as today.

### Server-side schema migration (the genuinely new burden)

The server must create tables on first use and evolve them on a schemaVersion
bump (add column, create/replace/drop index, retire table — exactly the migration subset). This is
**new code** (v2 has no server DDL machinery; see constraint 7), bounded
by the subset: CREATE TABLE / ADD COLUMN / CREATE INDEX / DROP INDEX / DROP TABLE only. The
schema-floor response (§1.6) already gates unsupported client versions;
server migration runs at schema load / version bump.

A retired table is detected from the persisted prior layouts and removed from
the relational current-row store together with its `sync_row_scopes` entries.
The append-only commit log remains under the ordinary retention policy; schema
retirement is deliberately not presented as a compliance erasure primitive.

On D1 (stateless Workers, per-request instantiation) a schema-version
marker table gates the DDL check so cold starts don't re-run `CREATE TABLE
IF NOT EXISTS` for every table on every request; sqlite/postgres do the
same at process start.

Migration boundary and the payload (**corrected during implementation**):
the row codec is STRICT — the null bitmap is sized by the decoder's column
count and decode asserts full consumption — so an N-encoded payload does
NOT decode under the N+1 column list. The write path (§3.4 scope-strip,
CRDT merge, conflict `serverRow`) and the bootstrap serve path both decode
stored payloads under the CURRENT schema, so a version bump MUST migrate
stored payloads: decode under the OLD column layout, append trailing NULLs
for added columns, re-encode under the new list. To decode old bytes the
server persists each table's column layout (name/type/nullable) in
`sync_schema_meta.layouts` at every applied version; the bump walks each
changed table keyset-paged and rewrites payload + projection in the
migration transaction. Append-only is enforced (old layout must be an
exact prefix; added columns must be nullable) — anything else fails loud.
Typegen enforces the earlier authoring boundary with the committed
`syncular.migrations.lock.json`: normalized SQL checksums make every deployed
migration immutable, and the compact format's one canonical head-schema
snapshot lets generation name the first incompatible table/column before a
client or server opens without cumulative snapshot growth. Existing projects
create the baseline once with `syncular migrations baseline`; normal generation
may append new entries but never rewrites a locked one or changes a format-1
lock until `syncular migrations upgrade-lock` is invoked explicitly.
The original design's claim that "no re-encoding of old rows is required"
was wrong. (Old `sync_changes` entries stay old-encoded: the §7.4.3 client
schema-bump reset forces a re-bootstrap, so pre-bump deltas are never
served to post-bump clients.)

### Column type mapping (per dialect)

| IR type      | sqlite / d1 affinity | postgres  | note |
|--------------|----------------------|-----------|------|
| text         | TEXT                 | TEXT      |      |
| integer      | INTEGER              | BIGINT    | D1 caveat below |
| float        | REAL                 | DOUBLE PRECISION | |
| boolean      | INTEGER              | BOOLEAN   |      |
| json         | TEXT                 | **JSONB** | queryable on pg; safe because the wire never reads typed columns |
| blob_ref     | TEXT                 | TEXT      |      |
| bytes        | BLOB                 | BYTEA     |      |
| crdt         | BLOB (merged bytes)  | BYTEA     | opaque content, real column |
| encrypted    | BLOB (ciphertext)    | BYTEA     | opaque content, real column |

`json → JSONB` on Postgres is deliberate: JSONB normalizes bytes (key
order, whitespace), which would break re-encode identity — but the wire
reads `_sync_payload`, so normalization in the projection is free, and it
buys `->>`, containment operators, and GIN indexes (the analytics story).

**D1 number model:** D1's JSON transport represents integers as JS doubles;
i64 values beyond 2⁵³ lose precision in the typed column. Because
`_sync_payload` is the wire source of truth, this is a *projection
fidelity* limitation on D1, not data corruption — sync round-trips are
exact regardless. Documented; if exact large-int projection on D1 ever
matters, the column can be stored as TEXT behind the same IR type.

**D1 bind-parameter limit (100/statement):** the per-column upsert binds
~(columns + 4) parameters. Schema compile fails fast with a clear error
for tables that exceed the limit (~95 app columns) rather than failing at
runtime; chunked upsert is a follow-up if anyone hits it.

### Optional materialization (added 2026-07-06, per Benjamin)

Materialization is **per-table optional**: `TableSchema.materialize?:
boolean`. This is NOT a blob-vs-relational mode — the storage layout
(per-app table, five `_sync_*` meta columns), scope index, and serve path
are identical either way; the flag only controls whether the app's typed
columns exist as a projection and whether upsert pays the decode.

- **Default `true`**, except tables whose every non-PK, non-scope column
  is encrypted (§5.11): their projection would be pure ciphertext, so
  fully-E2EE tables default to `false`. Explicit values always win.
- `materialize: false` skips `decodeRow` on the push path (a five-column
  meta write — the old blob-store cost), skips user indexes, and is the
  escape hatch for D1's 100-bind-parameter cap on wide tables.
- **Flipping requires a schemaVersion bump** (the marker gates DDL).
  Flipping ON backfills the projection from stored payloads in the same
  keyset-paged rewrite the payload migration uses; flipping OFF simply
  stops writing the columns (they remain, stale, until dropped manually —
  DROP COLUMN is outside the migration subset).

## Decisions

1. **Relational tables are THE storage, not a toggle** — `sync_rows` is
   retired; there is no blob-vs-relational mode. The per-table
   `materialize` flag (above) toggles the projection columns only, never
   the storage layout. (Amended 2026-07-06.)
2. **The verbatim payload is retained as `_sync_payload`** in the per-app
   tables; typed columns are a projection, the payload serves the wire.
   (Revised — was: re-encode from typed columns on read. See Rejected
   alternatives.)
3. **Partition is in the primary key** of every per-app table. (New —
   the original DDL omitted it and broke multi-partition servers.)
4. **Commit log stays opaque.** (Unchanged.)
5. **Scope filter keeps the inverted index** (unchanged perf) even though
   scope columns are now real.
6. **Stored-scope map (`_sync_scopes`) retained** on the row (cheaper than
   recomputing from columns for the §3.4 authz read); consistency with the
   scope columns and inverted index is asserted by the contract tests.
7. **`json → JSONB` on Postgres**; sqlite/d1 keep TEXT.

### Rejected alternatives

- **Re-encode-on-serve (the original design):** drop the payload, rebuild
  wire bytes from typed columns on every read. Rejected because it turns
  codec canonicality into a runtime correctness requirement on the hot
  path, is *unsatisfiable* on D1 (i64→f64 through JSON breaks byte
  identity), forbids JSONB on Postgres (normalization), and creates a
  migration-boundary re-encode problem — all to save one BLOB column on
  the smallest table in the system (current rows; the commit log dominates
  storage). The ~2× current-row storage cost is the price of deleting the
  design's three largest risks.
- **Dual-write to a separate projection database/tables while keeping
  `sync_rows`:** satisfies queryability but leaves two current-row tables
  to keep consistent and keeps the "server data isn't real tables" smell.
  The single-table projection+payload gets the same safety with one home
  per row.
- **Relationalizing `sync_changes`:** large work, no relational consumer.

## Phased implementation

- **P1 — relational row store module (~1 day):** extract/generalize the
  sqlite-image DDL+decode into a shared `relational-rows` helper: IR→DDL
  (per-dialect type map, identifier validation, `_sync_*` columns,
  partition-qualified PK), upsert (decode→columns+payload), read
  (payload verbatim). Unit tests: DDL golden per dialect; upsert→getRow
  returns identical bytes; **round-trip invariant**
  `encodeRow(decodeRow(p)) === p` asserted per column type (test-time
  property, not a serving dependency).
- **P2 — wire into the three backends (~1 day):** sqlite + d1 (shared
  dialect) and postgres current-row paths use the helper; retain the scope
  index and commit log. The `ServerStorage` interface and all callers
  (push/pull/segments/admin queries) unchanged; storage construction now
  takes the `CompiledSchema`. D1: bind-limit compile check.
- **P3 — server-side schema create/migrate (~0.5–1 day, greenfield):**
  create tables at schema load; ALTER on version bump; user indexes
  created server-side; schema-version marker table gating DDL checks.
- **P4 — tests & bench (~0.5 day):** storage contract stays green; new
  assertions that the server holds real queryable tables (`SELECT` app
  columns; a foreign-key-shaped join works; JSONB operator works on pg);
  scope-data consistency (columns vs `_sync_scopes` vs inverted index);
  both conformance pairings green; `bench:ci` green (upsert now decodes +
  binds per column — measure the push-side delta; the serve side is
  byte-identical to today by construction). Then the offline-sync-bench
  integration unblocks — syncular becomes layer-over-real-Postgres like
  the CDC competitors.

Total: ~2–4 agent-days. P1 shrank (no re-encode serving path to prove);
P3 grew slightly (honest greenfield framing); net unchanged.

## Verification / done criteria

- `bun run check`, `bench:ci`, cargo, both Rust conformance pairings green
  throughout (this is storage-only; the wire is unchanged — and with the
  payload retained, the serve path is byte-identical *by construction*,
  not by re-encode correctness).
- A server integration test proves real relational structure: after a push,
  `SELECT title, completed FROM tasks WHERE project_id = ?` runs on the
  server DB and returns typed rows; a join across two app tables works;
  on Postgres a JSONB operator query works.
- A multi-partition test: same app PK pushed in two partitions coexists.
- The round-trip invariant holds in contract tests for every column type
  on every dialect (flags codec drift early, keeps the drop-payload
  follow-up alive).
- The bench harness's `bench-admin` can read `/admin/tasks` from the
  syncular server's real tables (integration unblocked).

## Risks

- **Push-side decode+bind cost** — upsert now decodes the payload and
  binds per column instead of one blob write. The codec is fast and push
  is not the hot lane; measure in `bench:ci`. (The serve side carries
  *zero* new cost — it reads the same bytes as today.)
- **Storage growth** — current rows ~2× (payload + typed columns). Current
  rows are the small table; the commit log dominates. Accepted.
- **Projection drift** — typed columns and payload could theoretically
  disagree (a bug in decode or a missed write path). Mitigated: both are
  written in the same statement/transaction from the same source bytes,
  and the contract tests assert agreement.
- **Migration correctness under version bump** — bounded by the migration
  subset (CREATE TABLE / ADD COLUMN / CREATE INDEX / DROP INDEX / DROP TABLE); server migration
  mirrors the client's DDL derivation. Genuinely new code — the largest
  unknown in the plan.
- **D1 projection fidelity** — i64 > 2⁵³ imprecise in typed columns
  (documented; sync unaffected); 100-param bind limit caps table width
  (compile-time error).

## Non-goals

- Relationalizing the commit-log history (`sync_changes` stays opaque).
- Any wire/SPEC/client change (this is server storage only).
- A configurable blob-vs-relational storage mode (relational is the store).
- Dropping `_sync_payload`. Possible *future* follow-up on sqlite/postgres
  once the round-trip invariant has soaked in CI (never on D1 — the number
  model forbids byte-exact re-encode); not part of this work.
- Encrypted-column queryability (ciphertext columns are opaque by design).
