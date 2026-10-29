# RFC: Local authority for serverless clients

- Status: accepted 2026-10-29; phases 1, 1b and 2 implemented (Bun, Node,
  browser worker, and the native cores through `syncular-authority`; SPEC
  §12, Appendix B.24)
- Date: 2026-10-29
- Review baseline: `e4b4255b` (0.48.0)
- Scope: SPEC §2.1, §6.10, §10, new §12, Appendix B; `@syncular/server`
  (new `local` entry point); new Rust crate `syncular-authority`;
  conformance drivers, harness and catalog; binding configuration; docs site.
  The client cores do not change.

## 1. Decision

An app runs without a server by pairing its client with a **local
authority**: the Syncular server semantics running in-process over a second
SQLite file on the device, reached through the ordinary transport seam
(`SyncTransport` in TypeScript, `Transport` in Rust). Commits drain, receive
acknowledgements, and reach the replica's base tables exactly as they do with
a remote server.

Attaching a cloud server later is a one-time upload: the authority sends its
live rows to the cloud as a §6.10 database-less producer, then the app reopens
the client against the cloud. The client's stored `logEpoch` differs from the
cloud's, so the existing §2.1 log-epoch reset rebinds the replica.

The design adds no wire frame and no client-core behavior. The client cannot
distinguish a local authority from a remote server.

| Platform | Authority |
|---|---|
| TypeScript (Bun, Node) | `openLocalAuthority` in `@syncular/server`: the shipped handler over `SqliteServerStorage` |
| Rust core (Tauri, Swift, Kotlin, Flutter, React Native) | New crate `syncular-authority` implementing the §12 authority profile, conformance-locked against the reference server |

Phase 1 ships the TypeScript authority and attach for Bun and Node. The
browser worker needs a sqlite-wasm `SqliteDatabase` adapter and a worker
configuration field; it follows as phase 1b. Phase 2 ships the Rust crate and
the binding configuration.

## 2. Evidence

### 2.1 Request

Hamukko v2 (filed 2026-10-11) keeps budgets on one Mac with no server and
adds sync in v3. Without a serverless mode, v2 uses plain SQLite and v3
migrates storage. The request: start serverless and attach sync later
without migrating storage.

### 2.2 The client alone cannot hold authoritative data

| Fact | Reference |
|---|---|
| `mutate` always appends an outbox commit | `appendOutboxCommit` in `packages/web-client/src/outbox.ts:61`; `record_outbox_commit` in `rust/crates/client/src/client.rs:15779` |
| A row reaches the base tables only through server delivery; acknowledged intent stays protected until a delivery covers it | SPEC §7.1 |
| A schema-version reset drops every table outside `_syncular_*`, app-owned tables included | SPEC §7.4.3; `dropAndRecreateSyncedTables` in `packages/web-client/src/schema.ts:663`; `is_synced_table_name` in `rust/crates/client/src/client.rs:11111` |
| No code compacts the outbox or records whether a commit was sent | `_syncular_outbox` in both cores; SPEC §7.1 forbids coalescing after a possible send |
| The transport gate refuses rounds with `sync.offline` and is not persisted | SPEC §8.8 |
| Declared references are enforced by the server only; the replica DDL omits them | SPEC §6.11 |

Without an authority, every write remains an overlay that each
reconciliation replays, a schema bump has nothing to bootstrap from, and
deleting a parent never cascades.

### 2.3 A server on the device costs little in TypeScript

- `SqliteServerStorage` takes a five-method `SqliteDatabase` adapter
  (`packages/server/src/sqlite-driver.ts:24`) and migrates its own app tables
  on a schema bump: `ensureSchema` applies `CREATE TABLE`, `ADD COLUMN` and
  index changes in one transaction (`packages/server/src/sqlite-storage.ts:732`).
  The app runs no migration SQL.
- `@syncular/testkit` already runs the shipped server in-process and connects
  clients through `handleSyncRequest` (`packages/testing/src/server.ts`,
  `packages/server/src/handler.ts:1053`).
- Schema evolution is append-only: added tables and appended nullable columns
  (`apps/docs/src/content/guide-schema.md:212`,
  `apps/docs/src/content/concepts-schema-upgrades.md:100`). Server storage
  reaches the next version without transforming data.
- `ClientDatabase.openSibling(name)` (`packages/web-client/src/database.ts:62`)
  already opens a second database file beside the replica on Bun, Node and
  browser OPFS; previous-version context uses it (SPEC §7.4.6). The Rust core
  has the same capability.

### 2.4 Rust needs a new crate

The Rust workspace has the client, the SSP2 codec, FFI and command crates,
and no server. `syncular-ssp2` encodes and decodes request and response
messages (`rust/crates/ssp2/src/encode.rs:10`, `rust/crates/ssp2/src/decode.rs:21`),
so the new crate adds push and pull semantics and no codec work.

### 2.5 The conformance harness already abstracts the server

`packages/conformance` runs each catalog scenario against a `Pairing` of
client, server and codec drivers and skips a scenario whose required
`ServerCapability` the server driver lacks
(`packages/conformance/src/driver.ts:239`, `packages/conformance/src/runner.ts:46`).
The Rust authority becomes one more server driver.

## 3. Design

### 3.1 Topology

```
app ── client core ── replica database         (unchanged)
            │  SyncTransport / Transport, in-process
       local authority ── authority database   (sibling file)
```

The authority database holds server tables: `sync_*` bookkeeping and
materialized app tables named like the replica's synced tables. It therefore
lives in its own file, opened through the sibling-database capability. A
crash between the authority's apply and the replica's apply is the ordinary
lost-acknowledgement case: the client retries under the same
`clientCommitId` and the authority returns `cached` (§2.3).

The authority runs where the client core runs: inside the browser worker on
a second OPFS file, and synchronously behind `Transport::sync` in the Rust
core.

### 3.2 Host context

The authority authenticates every request to partition `local` and actor
`local`, resolves every scope variable to all values (`*`), and issues no
leases. The app supplies the generated schema and, for `crdt` columns, the
mergers it would give a server.

The authority has no validators, commit validators, reactions, domain-event
consumers, remote operations, realtime channel or blob routes. A client that
calls one of these features fails at the seam it fails at today when the
feature is unconfigured: remote operations raise
`client.remote_operations_unconfigured`, blob calls fail as with no blob
transport, and no realtime connector exists. The authority adds no
alternative behavior for them.

### 3.3 Write path

`mutate` appends to the outbox, the scheduler runs a round, the authority
applies the push (§6.1 to §6.4 and §6.11) and returns `PUSH_RESULT`, and the
pull delivers the change into the replica's base tables. Version conflicts,
tombstones, declared references, unique constraints and CRDT merges follow
the reference server, because in TypeScript the authority is the reference
server.

The latency from `mutate` to a delivered base row through an in-process
authority is unmeasured. Phase 1 measures it with the existing loopback
write-acknowledgement benchmark in `bench/`.

### 3.4 Schema upgrades

The app binary carries one generated schema for both components. On open,
the authority runs `ensureSchema` and migrates its tables in place; the
client runs the §7.4 reset and bootstraps from the authority at the new
version. Commits pending at the bump replay under the §7.4.4 encode-at-send
rule, and the authority answers an incompatible commit as any server does.
The client keeps the §7.4 rule that it never transforms local tables; the
authority carries the data across the bump.

### 3.5 Retention

The authority keeps the commit log, idempotency records and tombstones of
any server and runs `pruneCommitLog` with the §4.6 floors at open. Storage
equals the replica plus the authority's rows plus the retained log. The
overhead is unmeasured; phase 1 records it for a 100k-row fixture.

### 3.6 Attach

1. The app runs a round that leaves the client outbox empty, then closes the
   transport gate (`setTransportEnabled(false)`, §8.8).
2. The app calls `attach` on the authority with an authenticated cloud
   `SyncTransport`. The authority persists `attaching` and a random
   `attachId`; the producer `clientId` is `authority-<attachId>` and the
   operation budget is fixed at 500, so neither needs persisting. From then
   on it refuses every request with `sync.authority_unavailable`.
3. The authority uploads its live rows as a §6.10 producer: push-only
   requests of `PUSH_COMMIT` frames in which every operation is an insert
   (`baseVersion = 0`, every column present).
   - Commit order follows declared references. The authority builds the
     row-level reference graph over all tables, groups each strongly
     connected component into one commit (§6.11 judges a commit's candidate
     state, so a cycle passes inside one commit), and emits components
     parents first. Ties break by table name, then row ID. Consecutive
     components share a commit up to the operation budget. A component
     larger than the budget fails attach before any upload with
     `sync.attach_rejected`, `reason = cycle_too_large`.
   - Each `clientCommitId` derives from `attachId` and the commit's ordinal.
     The authority is frozen while attaching, so the plan is reproducible
     after a restart, and a retry resends the byte-equivalent commit and
     receives `cached` (§2.3).
   - Encrypted columns upload the stored ciphertext; the cloud needs no
     keys. A `crdt` column uploads the stored state, and `merge(null, state)`
     stores it unchanged.
   - A schema-floor response (§1.6) stops attach with the floor details.
4. A result other than `applied` or `cached` stops attach with
   `sync.attach_rejected` and details `{ reason: "commit_rejected",
   clientCommitId, code, opIndex }`. The cloud retains a rejected result
   under its idempotency key (§2.3), so resuming replays the rejection: a
   rejected commit is terminal for its `attachId`. `abandonAttach(transport)`
   deletes the rows of every commit the cloud applied, children first, and
   returns the authority to `local`; the next `attach` uses a new `attachId`
   and recreates the rows over their tombstones. A
   transport failure leaves the state `attaching`, and the next `attach`
   resumes with the applied commits returned as `cached`.
5. When every commit is applied, the authority records `attached` and keeps
   refusing requests. The app reopens the client against the cloud over the
   same replica file. The first round meets a different `logEpoch` and takes
   the §2.1 reset: the client discards synced rows and cursors, keeps
   `clientId`, the outbox and outcomes, and bootstraps from the cloud. Query
   availability reports the subscriptions incomplete until the bootstrap
   completes, as on a first install.
6. The app removes the authority file.

The upload reads the authority, so rows outside the replica's windows (§4.8)
reach the cloud and the client outbox stays out of the upload. The cloud
receives one insert per live row and no edit history.

Writes made while attaching wait in the client outbox and reach the cloud
after step 5. A queued commit that carries `baseVersion` refers to the
authority's version numbers, and every seeded cloud row starts at version 1:
a `baseVersion` above 1 is rejected with `sync.invalid_request`. Apps hold
versioned writes while attaching.

Insert semantics make an attach into a partition that already holds a seeded
row ID a `sync.version_conflict`, so attach never overwrites cloud rows.

**Scope values.** In local mode every scope value is granted. The cloud's
`resolveScopes` must grant the attaching actor every scope value the local
rows carry, or the upload stops with `sync.forbidden`. An app that plans to
attach uses scope values the cloud will grant, for example a device-generated
owner ID that the host registers to the account at sign-up.

### 3.7 Rust authority profile

`syncular-authority` stores its data in SQLite through `rusqlite`, as the
client does. Its storage layout is private and MUST reach a new schema
version by appending tables and nullable columns. It implements:

- §2.1 `logEpoch`; §2.2 row versions, column versions and tombstones; §2.3
  idempotency records
- §4.1 to §4.5 subscriptions and incremental pull; §4.6 pruning; §4.7
  bootstrap with inline rows segments (§5.7) only
- §6.1 to §6.4 push, conflicts and atomicity; §6.11 declared references;
  secondary unique indexes
- §5.10 CRDT merge behind the existing `crdt-yjs` feature
- §12.3 attach

It omits realtime (§8), segment references and SQLite images (§5.3 to §5.5),
windows (§4.8), leases (§7.3), validators (§6.7, §6.8), reactions (§6.9),
blobs (§5.9), erasure, backfill checkpoints, remote operations, and scope
revocation. Every included feature produces the client-observable outcome
of the reference server, and the conformance lane in §5 enforces that.

### 3.8 Public surface

TypeScript:

```ts
import { BunSqliteDatabase, openLocalAuthority } from '@syncular/server';

const authority = await openLocalAuthority({
  database: new BunSqliteDatabase('./data/authority.sqlite'),
  schema,
});
const client = new SyncClient({
  database: replica,
  schema,
  clientId,
  transport: authority.sync,
  segments: authority.downloadSegment,
});

// Later, with the client's transport gate closed:
await authority.attach(cloudTransport);
```

The host passes the authority's own `SqliteDatabase` (`BunSqliteDatabase` or
`NodeSqliteDatabase`); the server package keeps no dependency on the client
package. The browser adapter and its bundle size belong to phase 1b.

Rust and bindings: `Authority::open(sibling_path, &schema)` returns a value
that implements `Transport`. Each binding gains one configuration field for
the authority path, mutually exclusive with `base_url`, plus an `attach`
call.

## 4. SPEC changes

Shipped as SPEC §12, the `sync.authority_unavailable` row in §10.2, the
client-local `sync.attach_rejected` in §10.3, one sentence in §6.10, and
Appendix B.24. The shipped §12.3 adds what phase 1 settled: the Tarjan
ordering rule, the derived producer `clientId`, the fixed 500-operation
budget, and the terminal rejection with abandon. The draft text below is
kept for review history.

### 4.1 New §12 Local authority

> **§12.1 Definition.** A local authority is a server that runs in the
> client's process, serves exactly one partition, and is reached through the
> client's transport seam. It follows every server rule of this
> specification for the features in its profile (§12.2). A client treats it
> as a server and applies no rule specific to it.
>
> **§12.2 Profile.** A local authority MUST implement §2.1 to §2.3, §4.1 to
> §4.7, §5.2 and §5.7, §5.10, §6.1 to §6.4, and §6.11. It authenticates
> every request to one fixed partition and actor and resolves every scope
> variable to all values. A feature outside the profile is absent: the
> authority emits no frame for it and accepts no configuration for it.
>
> **§12.3 Attach.** Attach moves a local authority's rows to a remote server.
> The authority persists the attaching state and an `attachId`, then refuses
> every request with `sync.authority_unavailable`. It uploads every live row
> as a §6.10 producer, one insert (`baseVersion = 0`, all columns present)
> per row. Commits contain whole strongly connected components of the
> row-level reference graph and follow parents-first order with ties broken
> by table name and row ID. A `clientCommitId` derives from `attachId` and
> the commit ordinal. The authority MUST NOT change its rows while
> attaching. Any result other than `applied` or `cached` stops attach with
> the client-local error `sync.attach_rejected`; attach resumes from the
> same plan. After every commit is applied, the authority records the
> attached state and serves no further request.
>
> **§12.4 Rebinding the client.** A client reopened against the remote
> server keeps its replica file. The remote server's `logEpoch` differs from
> the stored value, and the §2.1 reset applies unchanged.

### 4.2 §10.2 new code

| Code | Category | Retryable | Action | Produced when |
|---|---|---|---|---|
| `sync.authority_unavailable` | internal | no | inspectServer | A local authority is attaching or attached (§12.3) and serves no request; `details.state` is `attaching` or `attached` |

### 4.3 §10.3 new client-local code

`sync.attach_rejected`: the remote server did not apply an attach commit
(§12.3), or a reference cycle exceeds the operation budget.
`details`: `{ clientCommitId, code, opIndex }` or `{ reason: "cycle_too_large", table, size }`.

### 4.4 §6.10

Add one sentence: a local authority's attach upload (§12.3) is a
database-less producer.

## 5. Conformance

Shipped in `packages/conformance/src/catalog/local-authority.ts` as B.24.
The harness gained `ServerDriver.createLocalAuthority`, the
`local-authority` capability, `ScenarioContext.newLocalAuthority`, and a
mutable `ClientHandle.route` that rebinds a client to another server. All
six scenarios pass with both client cores against the TypeScript and the
Rust authority. Differences from the draft: the encrypted and `crdt` columns
of scenario 3 moved into two scenarios of their own (B.24 e and f), and
scenario 4 uses a scope denial and a new attach instead of a validator and a
resume, because a rejection is terminal (§3.6 step 4). A Chromium test
(`packages/web-client/test/local-authority.browser.test.ts`, `test:browser`)
runs the browser worker entry over OPFS through reloads, attach, a follower
tab and a leader handover. `packages/server/test/local-authority.test.ts` covers commit
packing at the 500-operation boundary and `cycle_too_large`.

Draft list:

1. **Local round trip.** A client writes through a local authority. After
   `syncUntilIdle` the outbox is empty, the rows sit in the replica's base
   tables with server versions, and deleting a parent with `CASCADE`
   children removes the children locally.
2. **Local schema bump.** Rows written at version 1; both components reopen
   at version 2 with an appended nullable column and a new table. Every row
   survives with the new column `NULL`, and a commit pending at the bump
   replays.
3. **Attach.** An authority holds rows that include a self-referencing chain,
   a two-table reference cycle, an encrypted column and a `crdt` column.
   Attach to the reference server with one dropped response and one process
   restart mid-upload. Every row is applied exactly once; the client reopens
   on the cloud, takes the epoch reset and converges with the authority's
   final state; an unversioned write queued during attach applies afterward.
4. **Attach rejection.** A cloud validator rejects one row. Attach stops with
   `sync.attach_rejected` and its details; after the validator is removed,
   attach resumes and completes with the applied prefix returned as `cached`.

Scenarios 3 and 4 need a second server in one scenario context; the harness
gains a `newServer` factory.

Phase 2 adds a `rust-authority` server driver. Every catalog scenario whose
capabilities fall inside §12.2 runs against it with both client drivers. New
`ServerCapability` tags gate the scenarios outside the profile: `realtime`
(§8), `scope-authorization` (grants narrower than every value, revocation,
resolver faults), `multi-actor` (§1.5 clientId binding), `segment-refs` (§5.4,
§5.5), `sqlite-image` (§5.3), `schema-window` (§9) and `server-limits`
(host-configured limits). The reference server advertises all of them, so its
lane keeps its current coverage.

## 6. Alternatives rejected

- **Compact a never-sent outbox** (the 2026-10-11 proposal). Every row stays
  an overlay, so each reconciliation replays all serverless data; a commit
  that no longer encodes after a bump waits for a send that never happens;
  references never cascade locally.
- **Apply commits straight to the replica's base tables.** The §7.4 reset
  drops those rows on the first bump unless the client gains a migration
  engine, which §7.4 rejects, and the client would reimplement §6.2 and
  §6.11.
- **A schema-agnostic row store inside the replica file.** It reimplements
  server push semantics in TypeScript beside the reference server.
- **Upload from the replica through the client outbox.** Rows outside a
  window are missing, and until the upload drains each reconciliation
  replays every pending seed operation, roughly n²/budget row writes.
- **Import the authority file as the cloud partition.** The client avoids
  the epoch reset, but device data bypasses cloud authorization and
  validators, and every storage needs an operator import path. It stays
  available as an operator migration and is out of scope here.

## 7. Open questions

1. **Abandoning a failed attach.** Resolved without operator tooling: the
   authority persists which upload commit it sent and which applied, and
   `abandonAttach(transport)` deletes the applied rows through ordinary
   delete commits (SPEC §12.3 step 6). A rollback delete can itself be
   refused, for example by a `RESTRICT` reference from a row another client
   added; abandon then stops and the attach stays in place.
2. **Attaching into a non-empty partition**, including a second device's
   upload. Insert semantics turn every overlap into a conflict; merging two
   serverless histories is out of scope.
3. **Several devices without a server.** Out of scope.
4. **Costs.** Measured on macOS arm64, Bun 1.4.4, file-backed databases:
   `mutate` plus `syncUntilIdle` with the row delivered took 2.05 ms at p50
   and 2.97 ms at p95 over 500 writes. After 100,500 rows in 700 commits the
   replica held 11.1 MB and the authority 51.0 MB; the §4.6 floor of 1,000
   retained commits kept every change. A fresh client bootstrapped the
   100,500 rows from the authority in 161 ms. In a browser bundle that
   already holds the client core, the authority adds 134.6 KB minified and
   36.3 KB gzipped; only a worker entry that passes `openLocalAuthority`
   bundles it, so no separate package is needed.
   The Rust authority, measured on an Apple M6 (12 cores, 16 GB, macOS
   27.0.1) with Rust 1.99.1, a release build, and file-backed databases
   (`bench/README.md`, `authority-bench`): `mutate` plus a sync until idle took
   1.41 ms at p50 and 1.99 ms at p95 over 500 writes. After 100,500 rows in 700
   commits the replica held 18.9 MB and the authority 38.9 MB, with all 700
   commits retained. The 100,000 bulk rows took 8.4 s in 500-row commits, with
   about 4.3 ms per commit in the authority's push handler. A fresh client
   bootstrapped the 100,500 rows from inline rows segments in 340 ms, and
   attach to a second authority took 1.03 s. Four runs ranged from 315 to
   614 ms for bootstrap and from 0.97 to 1.79 s for attach.
5. **Platform priority.** Hamukko's platform decides whether phase 2 is on
   its critical path.
6. **Queued inserts across an appended column.** Found while writing
   scenario 2, and independent of the local authority: a queued insert
   recorded before a bump that appends a nullable column re-encodes without
   that column, and §6.2 refuses a partial payload for an absent row with
   `sync.row_missing`. §7.4.4 classifies only commits that cannot encode, so
   the insert reaches the server and is lost. Every remote server shows the
   same behavior. Fixed by SPEC §7.1 insert intent in both cores: `mutate`
   marks an upsert of a row absent from the replica, and replay and encoding
   fill the columns it lacks with NULL. Conformance scenario
   `schema-bump/queued-insert-survives-appended-column` pins it.

## 8. Plan

| Phase | Work | Gate |
|---|---|---|
| 0 | Maintainer review of this RFC | Accepted text moves into SPEC §12 |
| 1 | Done: `openLocalAuthority` in `@syncular/server`, attach, `sync.authority_unavailable`, `sync.attach_rejected`; harness `createLocalAuthority` and `route`; scenarios 1 to 4 against both clients; measurements in §7 item 4; docs page `guide-local-authority` and changelog entry | `bun run check` |
| 1b | Done: `clientSqliteDatabase` adapter, `startSyncWorker({ openLocalAuthority })`, `localAuthority` init flag, handle methods `localAuthorityState`, `attachLocalAuthority`, `abandonLocalAuthorityAttach`; the authority drops its rows once attached; bundle cost measured (134.6 KB minified, 36.3 KB gzipped) | `bun run check` |
| 2 | Done: `syncular-authority` crate (storage layout of `SqliteServerStorage`, append-only migration at open, inline rows segments only); `rustAuthorityServerDriver` running B.24 with both client cores; `local-authority` client feature selected by `localAuthorityPath`, with `localAuthorityState`, `attachLocalAuthority` and `abandonLocalAuthorityAttach` in the FFI, Tauri, Swift, Kotlin, Flutter and React Native. `rustAuthorityDriver` runs the 131 catalog scenarios inside §12.2 with both client cores; the authority records the §4.5 round outcome, reads a host clock (`open_with_clock`) and prunes under host floors (`prune`) | `bun run check`, `bun run rust test`, `bun run rust clippy --all-targets -- -D warnings`, binding `check.sh` gates |
