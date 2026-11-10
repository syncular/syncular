# RFC: Bounding idempotency results with a per-outbox acknowledged watermark

- Status: proposal; no implementation, no SPEC change
- Date: 2026-11-10
- Review baseline: `3bb94ddc` (0.59.0)
- Scope: SPEC §1.5, §2.3, §4.6, §6.3, §6.10, §10, §12.3; TS and Rust codecs;
  TS and Rust clients; SQLite, Postgres and D1 server storage; TS and Rust
  local authority; conformance catalog

## 1. Decision asked

Adopt a per-outbox acknowledged watermark so a server deletes an idempotency
result once the pushing replica can no longer resend that commit.

Today every push stores one row in `sync_push_results`, and SPEC §4.6 keeps
those rows through pruning, because a missing result lets a late retry apply a
second time. The table grows by one row per push for the life of the
partition. A one-operation applied commit stores a 114-byte result JSON plus
two 36-character UUID keys and the partition, before the primary-key index.
An age bound would be unsafe: a replica that pushed, lost the acknowledgement
and stayed offline past the bound would apply the commit twice on reconnect.

The protocol already pins the fact that makes a safe bound possible. A
request carries a contiguous prefix of the surviving outbox in creation order
(SPEC §7.1), and a commit leaves the outbox only after its terminal result or
a local discard, never to return. The first commit of a request therefore
proves that every older commit of that outbox is gone for good. Both clients
already number their outbox rows with `seq INTEGER PRIMARY KEY AUTOINCREMENT`
(`packages/web-client/src/schema.ts:597`, `rust/crates/client/src/client.rs:2113`);
the server only needs to see those numbers.

| Area | Change |
| --- | --- |
| Wire | New optional request frame `PUSH_ORDER` (`0x06`): `outboxId: str`, `clientSeqs: u32 count × i64`, one entry per `PUSH_COMMIT`. Unknown-frame skipping (§9) makes it additive: no wire-version bump |
| Server state | `sync_push_results` gains `outbox_id` and `client_seq` (nullable) and an index on (partition, client_id, outbox_id, client_seq). New table `sync_push_watermarks(partition, client_id, outbox_id, through_seq, updated_at_ms)` |
| Server push path | Under the partition serialization of §6.3: raise the watermark to the request's first `clientSeq`, delete results of that outbox below it, refuse a commit below it that has no result with the new terminal code `sync.commit_expired` |
| Clients (TS, Rust) | Persist a random `outboxId` beside the outbox, send `PUSH_ORDER` with the existing `seq` values, treat `sync.commit_expired` as a rejection |
| Local authority (TS, Rust) | Same storage change; its single replica keeps at most one request's results |

What stays: the idempotency key (§2.3) and its replay rules, the
byte-equivalent cached result, §4.6 pruning of the commit log, the outbox
order and push budgets, and every result written by a sender that does not
send `PUSH_ORDER`. Old clients, §6.10 database-less producers and the §12.3
attach upload keep today's retention.

Cost: two codecs gain one frame and golden vectors; three server storages and
the Rust authority store gain two columns, one table, one upsert and one
indexed delete per push request; both clients gain one meta value and one
frame; the conformance catalog gains four scenarios. Code size is unmeasured.
Per request the wire grows by the `outboxId` (a 36-byte UUID plus its length
prefix) and 8 bytes per commit.

Biggest risks:

- A copied replica (device migration that copies app data, a restored app
  backup, two hosts configured with one fixed `clientId` and one copied
  database) shares `clientId`, `outboxId` and the sequence. Today its retries
  read `cached`. Under this RFC, a copy that resends a commit below the other
  copy's watermark receives `sync.commit_expired`, and a copy whose new
  commits reuse sequence numbers the other copy already passed loses those
  writes as rejections. Both are loud; neither applies twice.
- The invariant depends on the sequence never restarting under one
  `outboxId`. A client that recreates its outbox table, or resets
  `sqlite_sequence`, without rotating `outboxId` in the same transaction
  would have its new commits refused.
- Rows that remain: one watermark row per (client, outbox), the results of
  each outbox's last push request, results from old clients, and every
  §6.10 producer result. A fleet of short-lived replicas still grows by one
  watermark row per replica.

Questions only the maintainer can answer:

1. Ship `PUSH_ORDER` as an additive frame under wire version 3, or fold
   `clientSeq` into `PUSH_COMMIT` and `outboxId` into `REQ_HEADER` under
   wire version 4?
2. Keep a watermark row forever, or delete the row of an outbox whose results
   are gone and whose `updated_at_ms` is older than a host window? Deleting it
   lets a request delayed longer than that window, or a copied replica, apply
   a commit again.
3. Results stored before the upgrade carry no sequence. Keep them forever, or
   add an operator command that deletes them after a cutover the operator
   chooses (an age bound with the risk described above)?
4. Is the copied-replica behavior of §4.4 acceptable, or does the deferred
   per-device identity of §2.3 have to land first?
5. `admin.findWrite` (`packages/server/src/admin.ts:1104`) returns nothing for
   a deleted result. Accept that, or keep a key-only record for a window?

Recommendation: adopt the watermark (§3) as specified, answer question 1 with
the additive frame, question 2 with "keep forever", question 3 with "keep
forever", and defer the age-bound alternative of §5.2.

## 2. What the protocol guarantees today

### 2.1 Retention

SPEC §4.6 deletes commits, changes, scope-index records and tombstones
through the horizon; "Application rows, idempotency results, and durable
reactions survive pruning." The storages create the result table without a
retention column:

- `packages/server/src/sqlite-dialect.ts:158` (SQLite and D1):
  `sync_push_results(partition, client_id, client_commit_id, result)`;
- `packages/server/src/postgres-storage.ts:225` (Postgres): the same columns;
- `rust/crates/authority/src/store.rs:73` (Rust local authority):
  `sync_push_results(client_id, client_commit_id, result)`.

No code path deletes from these tables except a partition reset. §4.6.1
scope-value erasure rewrites row-bearing results in place
(`sqlite-dialect.ts:1472`, `postgres-storage.ts:3474`), so its work also
grows with the table. `listPushResults` scans the retained results for one
`clientCommitId` without an index (`storage.ts:1172`).

### 2.2 What a replica may resend

- **Order.** "The outbox is FIFO: commits are pushed strictly in creation
  order" and "Each request contains a contiguous prefix of the surviving
  outbox" (§7.1). Push budgets defer the complete suffix; they never skip a
  commit. Retries preserve order and identity.
- **Leaving the outbox.** An `applied` or `cached` acknowledgement "drains the
  send queue atomically" (§7.1); acknowledged intent "never enters the send
  queue again". A `rejected` commit leaves the outbox (§7.2), except
  `sync.idempotency_cache_miss`, which stays queued and stays the head. With
  `retainFailedCommits`, failed rows "leave the send queue and are never
  retried implicitly"; keep-mine and edit create a replacement commit with a
  new ID (§7.2), which the outbox appends with a new `seq`. An
  `outbox_incompatible` commit after a schema bump is dropped (§7.4.4).
- **Sequence.** Both clients order the outbox by an `AUTOINCREMENT` key:
  `ORDER BY seq ASC` in `packages/web-client/src/outbox.ts:96` and
  `rust/crates/client/src/client.rs:2265`. SQLite never reuses an
  `AUTOINCREMENT` value while the table and `sqlite_sequence` survive. The
  outbox survives a schema bump (§7.4) and a `logEpoch` reset (§2.1).
- **Concurrency.** Overlapping deliveries of one key run one pipeline (§6.3).
  Nothing in the protocol stops a transport from delivering an abandoned
  request late: a request can wait on the partition lock while the client
  times out, retries, receives the acknowledgement and moves on.

### 2.3 Identity

`clientId` is a client-supplied namespace bound to one actor (§1.5, §2.3),
and §2.3 defers per-device namespacing. A host may supply `clientId`:
`SyncClientConfig.clientId` in TS (`client.ts:461`), and
`new_with_identity` in Rust, which opens an in-memory connection
(`client.rs:1644`). A process that restarts with a fixed `clientId` and an
in-memory database therefore starts a new outbox whose `seq` begins at 1
under an old `clientId`. A watermark keyed by `clientId` alone would refuse
every new commit of that process; the `outboxId` in §3 exists for this case.

### 2.4 Replay rules the proposal must keep

§2.3: a replay of a retained key returns the stored result (`cached` or
`rejected`), skips every validator, and re-authorizes a cached conflict row.
§6.3: `sync.idempotency_cache_miss` is a non-persisted rejected result with
one error record at `opIndex = 0`. §6.4: the result commits in the same
transaction as the commit's writes. §2.1: after a `logEpoch` rotation the
server may hold no result for a commit and applies it in the new continuity;
the protocol already accepts that case.

## 3. Proposal

### 3.1 Wire

`PUSH_ORDER` (`0x06`, request), 0 or 1 per request, after `ROUND_FAILURE`
and before the first `PUSH_COMMIT`, only when the request carries at least one
`PUSH_COMMIT`:

| Field | Type | Semantics |
| --- | --- | --- |
| `outboxId` | `str` | Identity of one outbox sequence. Non-empty, at most 64 bytes. A client generates a random value when it creates its outbox and replaces it in the same transaction whenever the sequence could restart |
| `clientSeqs` | `u32` count × `i64` | The outbox `seq` of each `PUSH_COMMIT`, in frame order. Count equals the number of `PUSH_COMMIT` frames; values are ≥ 1 and strictly increasing |

A count mismatch, a non-increasing value, a misplaced or repeated frame is a
decode error (§1.7), following the `ROUND_FAILURE` precedent. A server that
predates the frame skips it (§1.2 rule 2) and keeps today's retention.

Ignoring the frame is safe in both directions, which is the §9 condition for
shipping without a version bump. A wire-version-4 variant puts `clientSeq` in
`PUSH_COMMIT` and `outboxId` in `REQ_HEADER`; it saves the separate frame and
forces every sender, including §6.10 producers, to supply a sequence.

### 3.2 Server rule

Let `W(p, c, o)` be the stored `through_seq` for partition `p`, client `c`,
outbox `o`, 0 when absent. For a request carrying `PUSH_ORDER` with first
sequence `s₀`, after authentication, envelope validation, the clientId-actor
binding and the `logEpoch` match, and inside the partition serialization of
§6.3:

1. Set `W ← max(W, s₀)` and upsert the watermark row.
2. Delete results of `(p, c, o)` with `client_seq < W`.
3. For each commit with sequence `s`: a retained result replays as today
   (§2.3). With no retained result and `s < W`, answer `rejected` with one
   error record at `opIndex = 0`, `code = "sync.commit_expired"`,
   `retryable = false`, and do not persist it. Otherwise process the commit
   and store its result with `outbox_id = o`, `client_seq = s`.

Steps 1 and 2 commit in the same transaction as the first commit result of
the request, or alone when every commit replays. Results stored without
`PUSH_ORDER` keep `client_seq = NULL` and never match step 2.

### 3.3 The invariant

For every outbox `o` of client `c` in partition `p`, the replica holding `o`
never sends a commit with `seq < W(p, c, o)` again.

Proof. `W` is the first sequence of a request the replica built. At build time
that commit was the oldest surviving outbox entry (§7.1 contiguous prefix), so
every commit with a smaller sequence had left the outbox. Leaving is permanent
(§2.2 of this RFC), and `seq` values under one `outboxId` are never reused,
because the `AUTOINCREMENT` counter only grows and the client rotates
`outboxId` whenever the counter could restart. New commits receive larger
sequences. `W` only grows, so the property holds for every later value.

Consequences:

- Deleting a result with `client_seq < W` never removes a result the replica
  can still ask for. A lost-ack retry always carries `seq ≥ W`, because its
  commit is still in the outbox, so its result is still stored.
- A commit that arrives with `seq < W` and no result comes from a delayed
  copy of an abandoned request or from a copied replica. Refusing it with
  `sync.commit_expired` never applies a commit twice, and the abandoned
  request's sender is no longer waiting for the answer.
- A delayed request carrying a lower `s₀` does not lower `W`.
- An actor can only raise the watermark of a `clientId` bound to itself
  (§1.5); a higher value harms only that actor's own replica.

### 3.4 What each storage does

| Storage | Push path | Notes |
| --- | --- | --- |
| SQLite (`sqlite-dialect.ts`) | Upsert and `DELETE` inside the storage transaction queue that already serializes pushes | Shared by `SqliteServerStorage` and the TS local authority (`openLocalAuthority`) |
| D1 (`d1-storage.ts`, extends the SQLite dialect) | Same statements in the atomic batch under the partition coordinator | No extra round trip if batched with the result insert |
| Postgres (`postgres-storage.ts`) | Same statements on the connection that holds the partition lock | Index on (partition, client_id, outbox_id, client_seq) |
| Rust authority (`rust/crates/authority/src/store.rs`) | Same, without the partition column | Its one replica keeps at most one request's results |

The delete is bounded by the number of commits of the replica's previous
push request, so it runs inline; `pruneCommitLog` needs no new step. §4.6
changes from "idempotency results survive pruning" to "idempotency results
survive pruning; §3.2 deletes them by watermark". A `logEpoch` rotation
leaves watermark rows in place: a restored database holds an older, lower
watermark, which deletes less and refuses less.

### 3.5 Clients

Both clients store `outboxId` in their meta table at outbox creation, send
`PUSH_ORDER` with the `seq` of each admitted commit, and handle
`sync.commit_expired` through the existing rejected path: the commit leaves the
outbox, the overlay rebuilds, the outcome journal records it. If the commit
had applied, the next pull delivers its rows. Encoding at send time (§7.4.4)
keeps the `seq`. No new client state machine.

### 3.6 Senders without an outbox

§6.10 producers and the §12.3 attach upload send no `PUSH_ORDER`. Attach
resends earlier commits on resume and on abandon (§12.3 steps 4 and 6), so
its first commit does not prove that older commits are gone. Their results
keep today's retention, which bounds attach to one row per uploaded commit
and leaves service producers unbounded. A producer that can keep a durable
sequence may send `PUSH_ORDER`; the RFC does not require it.

### 3.7 Clients that predate the frame

An old client sends no `PUSH_ORDER`; the server stores its results with
`client_seq = NULL` and never deletes them. After the client upgrades, the
same `clientId` sends `PUSH_ORDER`. A commit pushed by the old version whose
acknowledgement was lost is still in the outbox; its retry finds the
NULL-sequence result by key and replays it. Step 2 never deletes
NULL-sequence rows, so an upgraded replica keeps every retry it may still
need. Deleting those rows needs an operator decision (question 3).

## 4. Risks in detail

### 4.1 Sequence restart under one `outboxId`

The proof needs a strictly increasing `seq` per `outboxId`. Both clients
create the outbox table with `CREATE TABLE IF NOT EXISTS`; a future migration
that drops or rebuilds it, or a `VACUUM INTO` path that loses
`sqlite_sequence`, must rotate `outboxId` in the same transaction. A
conformance scenario pins this: a fresh outbox under an old `clientId` pushes
and applies.

### 4.2 Late duplicate delivery

Covered by step 3: the commit is refused. Without the stored sequence, a
watermark built from an acknowledged-ID list or from arrival order alone could
not tell a late duplicate from a new commit, and would apply it.

### 4.3 Server storage restored without rotation

Already a protocol violation (§2.1 backup restore rule). The watermark does
not change that outcome.

### 4.4 Copied replicas

Two live replicas with the same `clientId` and `outboxId` interleave one
sequence space. Replica A pushes sequences 10 and 11 and moves on, so `W = 12`
after its next push; replica B then pushes its own commit with sequence 11
and receives `sync.commit_expired`. Today B's commit applies. The cursor and
presence records already assume one replica per `clientId` (§1.5 "Stable
per-device identifier"), so this case is a misconfiguration today with a
silent effect on cursors; the proposal makes it visible on writes. Mitigation
in docs: rotate `clientId` when restoring app data onto a second device.

## 5. Alternatives

### 5.1 Comparison

| | A. Watermark (recommended) | B. Age bound with expiry floor | C. Key-only records | D. Status quo |
| --- | --- | --- | --- | --- |
| Rows per replica | results of the last push request plus one watermark row | results younger than the bound plus one floor row | one per push, forever | one per push, forever |
| Lost-ack retry after long offline | `cached`, any duration | `sync.commit_expired` after the bound | `cached` status without results (breaks §6.3 byte equivalence) | `cached` |
| Late duplicate | refused | refused | replayed | replayed |
| Wire change | additive frame | the same frame | none | none |
| Server work per push | one upsert, one bounded delete | none on push; a prune step | none | none |

### 5.2 B: age bound with an expiry floor

With the same `PUSH_ORDER` sequences, the prune pass deletes results older
than a host window and raises a per-outbox floor to the highest deleted
sequence plus one; step 3 refuses below the floor. This never applies twice,
but a replica offline past the window with a lost acknowledgement receives
`sync.commit_expired` for a commit that did apply, and the app sees a
rejection for a write the server kept. A also keeps a dead replica's last
batch forever; B removes it. B can be added on top of A later as a host
option for dead outboxes, reusing the same column and refusal path.

### 5.3 C: shrink the record

Keep the key and the status, drop the per-operation results after a window.
The row count still grows by one per push, and a replay can no longer return
the byte-equivalent result §2.3 and §6.3 require, so the client could not
learn a conflict's `serverRow` from a replay.

## 6. Verification plan

Conformance catalog (`packages/conformance/src/catalog/`), run against both
cores and every storage:

1. Lost acknowledgement: push A, drop the response, push B as a new request
   with A still queued; A replays `cached`, and A's result survives until a
   request whose first commit is after A.
2. Late duplicate: push [A, B], then [C]; replay the first request; A and B
   return `sync.commit_expired`, and no row changes.
3. New outbox under an old `clientId`: push with `outboxId` X up to sequence
   5, restart with an in-memory database and `outboxId` Y; sequence 1 under Y
   applies.
4. Old client: a request without `PUSH_ORDER` stores and keeps its results;
   after the same `clientId` sends `PUSH_ORDER`, an old commit still in the
   outbox replays `cached`.

Storage tests assert the row count after N pushes from one replica stays at
the size of the last request plus one watermark row, on SQLite, Postgres, D1
and the Rust authority.
