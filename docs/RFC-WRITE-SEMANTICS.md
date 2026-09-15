# RFC: Column-granular writes, delete precedence, and declared references

- Status: proposed
- Date: 2026-09-16
- Review baseline: `dafb91fb7f6bd8a165ff64b37594bf803e28c06c` (0.20.1)
- Scope: SPEC §2, §5.10, §6, §7, §9, §10, Appendix B; typegen DDL subset and
  schema IR; server push pipeline and relational storage; TS and Rust clients;
  conformance catalog; docs site

## 1. Decision

Adopt three write-semantics changes as defaults. None is a flag.

| ID | Change | Wire break |
| --- | --- | --- |
| A | Declared references: `REFERENCES` in the DDL subset, server-enforced with `RESTRICT`, `CASCADE`, `SET NULL` | new error code and details only |
| B | Delete precedence: a delete beats a concurrent unversioned update; an explicit insert recreates | new error code only |
| C | Sparse rows: push payloads carry a presence bitmap, the server writes present columns and tracks a version per column; `changedFields` is removed | yes, wire version 3 |

A ships alone. B and C ship together in one wire-version bump because both
depend on operation intent being explicit in the operation record.

The maintainer authorized breaking changes for this work on 2026-09-16.
Publishing remains outside the authorized scope.

## 2. Evidence

### 2.1 External reference

Synql (Ignat, Elvinger, Ba, DAIS 2024; reference implementation at
`github.com/coast-team/synql`) replicates SQLite without coordination. Its
design points that matter here:

- A per-field log resolves each column by labeled timestamp, so concurrent
  edits to disjoint columns of one row both survive.
- A foreign-key log stores the referenced row identity. Declared actions
  (`RESTRICT`, `CASCADE`, `SET NULL`) decide every concurrent delete/insert
  case deterministically on every replica.
- A row carries an undo counter. Writes to an undone row are inert; only an
  explicit redo revives it.

Synql reaches these outcomes through undo/redo compensation because no
replica is authoritative. Syncular serializes every push per partition
(SPEC §6.3), so the server reaches the same outcomes through rejection and
the client's outbox rebuild (SPEC §7.2), without undo metadata.

### 2.2 Current behavior at the baseline

| Case | Today | Reference |
| --- | --- | --- |
| Parent deleted, child inserted concurrently | Orphan child, silent, unless the host writes a §6.8 whole-commit validator per table pair | `packages/typegen/src/sql.ts:606-614` rejects `FOREIGN KEY`; `push.ts` has no reference path |
| Row deleted, stale unversioned upsert arrives later | Row recreated at `server_version = 1` | `packages/server/src/push.ts:540-556` insert path |
| Two clients edit disjoint columns without `baseVersion` | Second push overwrites every column of the first | SPEC §6.2 "last-write-wins"; payload is the full row (§6.1) |
| Two clients edit disjoint columns with `baseVersion` | `sync.version_conflict`; the app rebases by hand | SPEC §6.2, §6.5 |
| crdt-only edit | MUST push without `baseVersion`; every non-crdt column is rewritten with the client's stale copy | SPEC §5.10.3 pinned rule |
| Edit intent | `changedFields` lives in local metadata only and MUST NOT reach the wire | SPEC §7.2.1; `packages/web-client/src/outbox.ts:36`; `rust/crates/client/src/api.rs:655` |

### 2.3 Performance baseline

`bench/RESULTS.md` records write-ack p50 of 0.1 ms on the local loopback
lane. The server stores the verbatim codec bytes in `_sync_payload` and
serves them without re-encoding (`packages/server/src/relational-rows.ts`);
the crdt merge path already re-encodes (`push.ts:400-405`, `505-513`).

## 3. Contracts to preserve

- Whole-commit atomicity and partition serialization (§6.3, §6.4).
- Idempotent replay under (partition, `clientId`, `clientCommitId`) (§2.3).
- FIFO outbox, contiguous prefix per request (§7.1).
- Authorization against the stored row, never the payload (§3.4 rule 2).
- Full-row codec for `COMMIT` frames, rows segments, SQLite images, and
  conflict `serverRow` (§2.4). Pull and bootstrap bytes do not change.
- Single-column text primary key as row identity (§0 non-goals).
- No client-side migration engine; schema bump wipes and replays (§7.4).
- Both cores implement every change; a conformance scenario locks each.

## 4. Change A: declared references

### 4.1 DDL subset and IR

`packages/typegen/src/sql.ts` accepts one column constraint:

```
REFERENCES parent_table(parent_pk) [ON DELETE RESTRICT | CASCADE | SET NULL]
```

Rules, each a typegen hard error when violated:

- `parent_pk` is the parent's primary key column. References to other
  columns stay unsupported.
- The child column type equals the parent primary-key type.
- The parent and child tables declare the same scope patterns (§3.1) so a
  cascade never crosses an authorization boundary.
- `ON UPDATE` clauses are rejected: the primary key is immutable (§0).
- `SET DEFAULT` and `NO ACTION` are rejected. An absent `ON DELETE` clause
  means `RESTRICT`.
- `SET NULL` requires a nullable child column.

Typegen records `{ column, parentTable, onDelete }` under a `references`
array on the table IR and emits a non-unique index over the child column
into the table's `indexes` so the server reaches children through
`scanRowsByIndex` (§6.8). Table-level `FOREIGN KEY` syntax stays rejected;
one syntax per concept.

The local replica DDL omits the `REFERENCES` clause. Windowing (§4.8) evicts
parents independently of children, and segment application (§5.2) writes
parents before children only as an ordering aid. Local SQLite never enforces
references.

### 4.2 Server enforcement

The check runs once per commit after every client operation is staged and
before whole-commit validation (§6.8 pipeline). It reads candidate state,
so a commit that deletes a parent and its children together passes.

| Situation | Outcome |
| --- | --- |
| Staged upsert whose present, non-null reference column names an absent parent | reject `sync.reference_violation`, `reason = missing_parent`, `fieldPaths = [column]`, `references = { parent: <table>, row: <rowId> }` |
| Staged delete of a parent with remaining children, `RESTRICT` | reject `sync.reference_violation`, `reason = restricted_delete`, `references = { child: <table> }` |
| Staged delete of a parent, `CASCADE` | server appends one `delete` operation per child to the same commit; recursive through further `CASCADE` references with a visited set |
| Staged delete of a parent, `SET NULL` | server appends one sparse upsert per child that sets the reference column to `NULL` |
| Appended operations exceed the cascade cap (reference default 1,000 per commit) | reject `sync.reference_violation`, `reason = cascade_limit` |

Appended operations run the §6.7 row validators with `op` set to `delete`
or `upsert`, appear in the §6.8 staged operation list, emit ordinary changes
(§2.2) with the child's stored scopes, and record tombstones (§5). A
rejection attributes to the `opIndex` of the originating client delete. The
`RejectionDetails` frame (§6.3.1) carries the tokens above; the `message`
stays static.

`sync.reference_violation`: category `invalid-request`, not retryable,
action `fixRequest`.

### 4.3 Client outcome

The client receives a rejection and rebuilds visible state from the last
confirmed server row plus later pending commits (§7.2). A rejected parent
delete restores the parent locally. A rejected child insert removes the
child. The outcome journal (§7.2.1) records both with details.

## 5. Change B: delete precedence

### 5.1 Tombstones

The server records `(partition, tbl, row_id, commit_seq)` for every applied
delete, including cascaded deletes, in a tombstone table. Pruning (§4.6)
removes tombstones with `commit_seq ≤ horizonSeq` in the same pass as the
commit log. An upsert consults the table only when the stored row is absent,
so the hot path performs no additional read.

### 5.2 Rules

For an upsert whose stored row is absent:

| `baseVersion` | Tombstone within horizon | Outcome |
| --- | --- | --- |
| `0` | any | insert (explicit intent recreates) |
| `> 0` | any | `sync.row_missing` (unchanged) |
| absent | yes | reject `sync.row_deleted` |
| absent | no | insert when every column is present (§6.3); otherwise `sync.row_missing` |

`sync.row_deleted`: category `not-found`, not retryable, action
`fixRequest`. The client drops the operation on rebuild and journals it.

Beyond the horizon the tombstone is gone and the insert rule applies.
The docs state this limit next to the retention defaults.

## 6. Change C: sparse rows and column versions

### 6.1 Sparse row encoding (§2.4)

A push payload is a **sparse row**:

1. presence bitmap, `ceil(columnCount / 8)` bytes, bit `i` set when column
   `i` is present (LSB-first, byte `i / 8`, padding bits zero);
2. null bitmap over the present columns, `ceil(presentCount / 8)` bytes,
   same bit layout, padding bits zero;
3. the non-null present values in declaration order, encoded per the
   column-type table.

The primary-key column MUST be present. A set padding bit, a null bit for
an absent or non-nullable column, or an absent primary key is a decode error
(`sync.invalid_request`). A full row is a sparse row with every presence bit
set. The full-row codec stays unchanged for every other surface.

### 6.2 Column versions (§2.2)

Every stored column carries `column_version`: the row's `server_version`
at the column's last write. Insert sets every column to `1`. An applied
upsert increments `server_version` by 1 and sets `column_version` of each
present column to the new value. Absent columns keep their version.
`column_version` is server-internal: it never appears in `COMMIT` frames,
segments, images, or conflict records.

Relational storage adds one `_sync_column_versions` blob per row encoding
`(ordinal, version)` varint pairs for columns whose version exceeds `1`.
D1 and Postgres use the same encoding in `BLOB`/`BYTEA`.

### 6.3 Conflict detection (§6.2, rewritten)

For an upsert against an existing row:

- `baseVersion > server_version`: `sync.invalid_request`.
- `baseVersion == 0`: lost-insert race, unchanged (re-authorize, then
  conflict or `sync.forbidden`).
- `baseVersion` present: conflict (`sync.version_conflict`) when any
  present non-crdt column has `column_version > baseVersion`. Otherwise
  apply.
- `baseVersion` absent: apply.
- Apply writes present non-crdt columns, merges present crdt columns
  (`merge(stored, incoming)`), leaves absent columns unchanged, and
  increments `server_version`.
- A present scope column: `sync.invalid_request`. This replaces §3.4 rule
  5's silent strip. Scope migration stays server-emitted (§2.2).

For an upsert against an absent row, §5.2 applies. An insert requires every
column present; a partial payload on an absent row without a tombstone is
`sync.row_missing`.

`delete` is unchanged apart from the tombstone.

### 6.4 Conflict record (§6.3)

The conflict record gains `conflictColumns: bytes`, a bitmap in the
presence-bitmap layout marking the present columns whose `column_version`
exceeded `baseVersion`. `serverRow` stays the full row. `serverVersion`
stays the row version.

### 6.5 Client contract (§6.5)

- keep-server: apply `serverRow`, drop the operation.
- keep-local: re-push the same sparse operation with
  `baseVersion = serverVersion`.
- custom merge: compute new values for the columns in `conflictColumns`,
  push a sparse operation carrying those columns with
  `baseVersion = serverVersion`.

Sibling operations of the conflicted one are still unapplied; the client
rebases the whole commit as today.

### 6.6 CRDT interaction (§5.10.3)

Delete the pinned rule "a crdt-only mutation MUST push with `baseVersion`
absent" and the consequence bullets that depend on it. Replacement text: a
present crdt column merges on every clean apply; an absent crdt column is
unchanged; crdt columns never participate in the `baseVersion` comparison. A
crdt-only sparse operation carries no comparable column and therefore never
conflicts, with or without `baseVersion`. §5.10.4 loses the sentence about
non-crdt columns writing last-write-wins during a crdt push, because a crdt
patch no longer carries them.

### 6.7 Client APIs and the outbox (§7.1, §7.2.1)

- `insert`: every column present, `baseVersion = 0`.
- `patch`: primary key plus the supplied non-scope columns present.
  `baseVersion` per the caller's optimistic-concurrency choice.
- `mutate`: every column present. A full-row write has full-row intent.
- `delete`: unchanged.

The optimistic overlay applies each pending operation's present columns over
the current local row. When the local row is absent and the operation is
partial, the overlay leaves the row absent; this matches the server's
`sync.row_deleted` and `sync.row_missing` outcomes.

§7.2.1 drops the `changedFields` paragraph. The retained schema-agnostic
operation envelope already contains the sparse operation, so recovery UI
derives intent from the presence set. One sentence remains: "`mutate` marks
every column present; clients MUST NOT narrow intent by diffing against a
mutable local base."

Remove `changedFields` from `packages/web-client/src/outbox.ts`, the
`changedFieldsByIndex` plumbing in `packages/web-client/src/client.ts`,
`changed_fields` in `rust/crates/client/src/api.rs` and `client.rs`, and
every docs mention.

### 6.8 Schema bump (§7.4.4)

Encode-at-send resolves present columns by name against the new IR. A
pending sparse operation that names a dropped column fails with the existing
client-local `sync.outbox_incompatible`. No new code.

## 7. Rejected concepts

- Version vectors, pairwise replica sync, and replica-labeled row identity:
  the server hub with `commitSeq` cursors already converges clients and
  prunes history; Synql's log never compacts.
- Undo/redo compensation, including reviving a deleted parent: rejection
  plus outbox rebuild produces the same visible state without unbounded
  metadata.
- Reference by row identity in a separate log: the immutable text primary
  key already provides it.
- Partial payloads for `COMMIT` frames or segments: the pull path stays
  full-row so images and segments remain byte-identical to stored payloads.
- Per-column merge as an opt-in mode: one rule set, always on.
- Keeping wire versions 1 and 2 serviceable alongside version 3: the
  reference server would need two conflict-detection semantics.

## 8. Specification changes

| Section | Change |
| --- | --- |
| §0 | Record the decisions: sparse push payloads, column versions, tombstones, declared references |
| §2.2 | `column_version` definition; tombstone recording |
| §2.4 | Sparse row encoding; push payloads use it; new golden vector |
| §3.4 | Rule 5 becomes "a present scope column on an existing row is `sync.invalid_request`" |
| §4.6 | Tombstone pruning shares `horizonSeq` |
| §5.10.3, §5.10.4 | Per §6.6 of this RFC |
| §6.1 | `payload` = sparse row |
| §6.2 | Rewritten per §5.2 and §6.3 of this RFC |
| §6.3 | `conflictColumns` field |
| §6.5 | Per §6.5 of this RFC |
| §6.8 | Reference enforcement step in the pipeline; cascade operations in the staged list |
| new §6.11 | Declared references: rules table of §4.2 |
| §7.1 | Overlay applies present columns |
| §7.2.1 | Remove `changedFields` |
| §9 | Wire version 3; window `[3]`; versions 1 and 2 rejected as unknown |
| §10.2 | `sync.reference_violation`, `sync.row_deleted`; `sync.row_missing` text updated |
| Appendix A | New vectors: `push/sparse-row`, `response/conflict-columns`; existing push vectors re-pinned under version 3 |
| Appendix B | Scenarios 19 to 21 (§9 of this RFC) |

`docs/SYQL.md` is unaffected: `_sync_version` stays the row version.

## 9. Conformance and golden vectors

New catalog scenarios in `packages/conformance/src/catalog/`:

19. **Declared references.** (a) child insert against an absent parent
    rejects with `missing_parent` details; (b) `RESTRICT` delete with a
    concurrent child insert: each arrival order yields the documented
    outcome and both clients converge; (c) `CASCADE` delete emits child
    deletes in the same commit and subscribers remove them; (d) `SET NULL`
    delete nulls the child column; (e) cascade cap rejection; (f) a commit
    deleting parent and children together passes `RESTRICT`.
20. **Delete precedence.** (a) delete then stale unversioned patch rejects
    `sync.row_deleted` and the row stays absent on both clients; (b) delete
    then explicit insert recreates at version 1; (c) tombstone pruned past
    the horizon restores the insert rule.
21. **Column-granular writes.** (a) disjoint patches without `baseVersion`
    both land; (b) disjoint patches with `baseVersion` both land; (c) same
    column with `baseVersion` conflicts and `conflictColumns` marks exactly
    that column; (d) crdt-only patch with `baseVersion` applies clean while
    a concurrent non-crdt patch also applies; (e) partial payload on an
    absent row rejects `sync.row_missing`; (f) present scope column rejects
    `sync.invalid_request`; (g) optimistic overlay shows a concurrent server
    change to an untouched column while a patch is pending; (h) Rust and TS
    clients produce byte-identical sparse payloads for the same patch.

Scenario 14 (CRDT) drops its baseVersion-absent precondition. Scenario 6
(conflict resolve and rebase) adds a `conflictColumns` assertion.

Golden vectors change bytes for every push vector, which is the §9
breaking-change definition and the reason for wire version 3.

## 10. Implementation sequence

Release 1 (Change A, additive):

1. SPEC §6.11, §6.8, §10.2, Appendix B.19.
2. Typegen: `REFERENCES` parsing, IR `references`, emitted index, local DDL
   omission, golden fixture with a two-table reference.
3. Server: reference check and cascade step, cascade cap, details tokens,
   tombstone-free at this stage.
4. Rust client: no wire change; conformance shim consumes the new details.
5. Conformance scenario 19; `bun run check`; `cargo test`, `clippy`.
6. Docs: `guide-schema.md` DDL subset, `concepts-conflicts.md` reference
   outcomes, `guide-concurrency-correction.md` example replaced by the
   declared-reference version; changelog entry.

Release 2 (Changes B and C, wire version 3):

1. SPEC sections listed in §8 of this RFC; golden vectors re-pinned.
2. Codec: sparse row encode/decode in `packages/core` and `rust/crates/ssp2`;
   vector `push/sparse-row`.
3. Server: `_sync_column_versions` column and migration for SQLite,
   Postgres, D1; tombstone table and pruning; §6.2 rules; `conflictColumns`;
   scope-column rejection; crdt simplification.
4. TS client: `patch` builds sparse operations; overlay applies present
   columns; `changedFields` removal; journal reads intent from the
   operation.
5. Rust client: same, including `changed_fields` removal and FFI surface.
6. Conformance scenarios 20 and 21; scenario 6 and 14 updates.
7. Docs: `concepts-conflicts.md` rewritten around column rules,
   `concepts-crdt.md` pinned-rule removal, `concepts-commits.md` payload
   description, retention page for the tombstone limit; changelog entry.
8. Version bump per `docs/RELEASE.md`.

Each step lands with its tests. `bun run check` and the Rust gates pass
before each local commit. Pushing and publishing wait for the maintainer's
instruction.

## 11. Performance expectations

| Change | Hot path | Cold path | Storage |
| --- | --- | --- | --- |
| A | none for tables without references or operations that leave the reference column absent | one primary-key lookup per present reference column; one index probe per child table on parent delete; cascade proportional to children, capped | one index per reference column |
| B | none (the lookup runs only when the stored row is absent) | one point read in the tombstone table | tombstone rows until pruned |
| C | per update: decode stored, decode incoming, merge, encode | none | `_sync_column_versions` varint pairs, absent for never-updated columns |

Postgres and D1 hosts batch the reference lookups per commit (one `IN`
query per parent table) to avoid one round-trip per operation.

Add a `bench/` lane: 500-operation commits of `patch` writes touching two of
twenty columns, measured before and after Release 2 on the existing
loopback harness. Record the result in `bench/RESULTS.md`. A regression above
the lane's noise band blocks the release until attributed.

## 12. Docs and changelog

Reader-facing pages follow the prose rules in `CLAUDE.md`. Each release adds
one entry to `apps/docs/src/changelog.mjs` linking to the page that documents
the behavior: `guide-schema.md` for references, `concepts-conflicts.md` for
delete precedence and column-granular writes.
