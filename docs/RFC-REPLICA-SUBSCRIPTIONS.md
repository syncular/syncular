# RFC: Unit subscriptions, one replica cursor, registration by reference

- Status: accepted with the decisions in §0; implementation on branch `wire-v4`
- Date: 2026-11-10
- Review baseline: `806a45bc` (0.59.0 plus docs)
- Scope: SPEC §3.2, §3.3, §4.1 to §4.8, §5.4, §5.6, §8.1, §8.2, §8.7, §9,
  §12.2; TS and Rust codecs; TS server, its SQLite, D1 and Postgres
  storages, realtime hub; TS and Rust clients; TS and Rust local authority;
  the native bindings' subscribe surface; conformance catalog; docs pages
  `concepts-subscriptions`, `concepts-windowing`, `pitfalls`, `guide-server`

## 0. Decisions

The maintainer delegated the open questions on 2026-11-10 with one rule:
decide for the future of the project, do not preserve compatibility for its
own sake, and schedule what should be done. These decisions override the
text below where they differ.

- **One wire version.** The server reads version 4 only, as it reads
  version 3 only today. Stages 1 and 3 collapse: there is no side-by-side
  pull path. A version 3 client receives the existing wire-version error
  until it updates.
- **The scope index ships in the same release** (stage 2), so the live scan
  costs one index range per unit from the first version 4 release.
- **An upgraded replica keeps its outbox and its rows and registers its units
  fresh.** It converts no per-table subscription record; every unit
  bootstraps once. This removes the conversion of multi-value and
  mixed-table subscriptions and the explicit table lists it needed.
- **A unit has no table list.** It covers every table that declares all of
  its scope variables. An app that wants part of a unit's tables on a device
  gives those tables their own scope variable. `UNIT` carries no `tables`
  field.
- **`params` is deleted** from the wire, both clients and the spec. No server
  reads it.
- **`maxScopeValuesPerSubscription` is deleted**; `maxSubscriptionsPerRequest`
  counts units and keeps its default of 500.
- **The head-of-line delay is accepted.** One stream in commit order is the
  invariant that makes apply safe without row-version checks. A replica
  behind the pruning horizon re-bootstraps under the existing §4.6 rule;
  there is no per-unit fallback.
- **The idempotency watermark of `RFC-IDEMPOTENCY-RETENTION.md` rides the
  same wire version.**

## 1. Decision asked

Replace the per-table subscription with a **unit**, give each replica **one
cursor**, and let a steady-state pull **refer to** the registration list by
digest. Ship the three as wire version 4 in one bump.

Why. A subscription covers one table (§4.1, §4.3), the documented pattern is
one subscription per scope unit per table (`pitfalls.md`, "Do give each scope
unit that can be lost its own subscription"), and every steady-state pull
carries the complete list with one cursor per entry (§4.1, "Omission is
unregistration"). One measured account with 6 campaigns and 7 rulesets sends
223 subscriptions per round: 33.8 KB in the request, 32 KB in the answer,
about 150 bytes each way and 0.4 ms of server time per subscription, whether
or not a row changed (`pitfalls.md`, "Don't subscribe every table of every
scope up front"). 0.59.0 caps a request at 500 subscriptions
(`packages/server/src/context.ts:105`); past that, every pull of the account
fails with `sync.limit_exceeded`.

Terms used throughout:

- **Unit**: a registration naming one value per requested scope variable,
  for example `{ campaign_id: "c1" }`. It covers every table that declares
  all of its variables, or a listed subset of those tables.
- **Live set**: the units whose changes the replica cursor covers.
- **Replica cursor**: the `commitSeq` through which the replica holds every
  change of every live unit.
- **Catching-up unit**: a registered unit outside the live set. It carries
  its own cursor or §4.7 resume token until it joins.
- **Registration digest**: a 32-byte value the client computes over its unit
  list; the server stores it with the list and compares it by equality.

| Area | Change |
| --- | --- |
| Wire | Version 4. `SUBSCRIPTION` becomes `UNIT` (`id`, `tables`, single-valued `scopes`; no `table`, `params`, `cursor`). New request frames `REPLICA` (replica cursor, registration digest, echo digest) and `PROGRESS` (one per catching-up unit). New response frames `LIVE_START` and `LIVE_END` around one ordered `COMMIT` stream. `SUB_START` echoes per-table fence additions instead of a full map |
| Pull semantics | A steady-state pull carries `REPLICA` and no `UNIT` frames. The server scans the log once from the replica cursor for the keys of the live set. Per-unit sections appear only for bootstrap, revocation, reset, or a changed echo |
| Server state | The client record stores units, the registration digest and the catching-up ids in the existing `subscriptions` column, tagged by the existing `wire_version` column. New index `(partition, var, value, commit_seq)` on `sync_change_scopes` (stage 2) |
| Clients (TS, Rust) | `_syncular_subscriptions` holds units; one replica cursor in meta; ids derived from the unit intent; window bases lose the table; ack is the replica cursor |
| Realtime | One live section per delta; catching-up units receive no deltas; ack floor computation disappears |
| Local authority (TS, Rust) | Same sections; the Rust authority scans `sync_changes` once from the replica cursor |
| Limits | `maxSubscriptionsPerRequest` counts units (default 500); `maxScopeValuesPerSubscription` is deleted |

What stays: scopes, resolver, effective-scope computation and the wildcard
fence (§3.2), write authorization (§3.4), the `COMMIT` frame layout (already
multi-table, §4.5), segments and their re-authorization (§5), the §4.7 resume
token shape (already a table list), the pruning contract (§4.6), revocation
purge and row ownership as rules (§3.3), eviction E1 to E4 (§4.8), push
(§6), the outbox (§7), and the realtime transport (§8.1, §8.3 to §8.8).

What the maintainer gets, for the 223-subscription account (§6 has the
numbers): stage 1 sends a list of 13 units when it changes (about 1.6 KB) and
about 0.2 KB per steady-state request; a quiet answer is about 0.12 KB; the
server runs one commit-window statement per round instead of 223 (SQLite) or
3 (Postgres). Stage 2 shrinks that statement from 223 index ranges to 13.
Stage 3 deletes the version-3 path.

Cost: both codecs gain version 4 and golden vectors; the server's pull
planning, realtime delta builder and three storages change; both clients
change their subscription store, response processing and window code; the
native bindings change their subscribe signature; about 12 conformance
scenarios are added and about 40 rewritten. Code size is estimated in §8 and
unmeasured.

Biggest risks:

- **Head-of-line blocking.** One live stream has one `limitCommits` budget.
  A backlog of 10,000 changes in one unit costs 10 rounds of 1,000 changes
  before a newer change of another unit arrives; today that other
  subscription advances in the first round (§4.2 counts per subscription).
- **Version window.** Until stage 3 the server keeps the version-3 pull path
  beside the new one, which the doctrine forbids as a permanent state.
- **Migration of consumer replicas.** A persisted subscription that does not
  fit a unit (several values, `params`, a table subset that differs per
  unit) converts to a unit with an explicit table list or splits into
  several units. An app that later widens a unit to all tables bootstraps
  that unit once more.

Questions only the maintainer can answer:

1. Can the consumer apps upgrade server and installed clients together, so
   stage 3 (a server that reads only version 4) follows stage 1 in the next
   release? A client that has not updated receives a decode error from a
   version-4-only server and stops syncing until it updates.
2. Does any consumer app send `params`? Neither reference server reads it
   (§2.6); this RFC deletes it.
3. Is a per-unit table subset a feature apps need, or is "every table that
   declares the variables" enough? This RFC keeps the subset, because the
   conversion of existing replicas needs it and `pitfalls.md` tells apps to
   leave out tables no screen reads.
4. Is the head-of-line delay above acceptable for the consumer apps' largest
   units, or does the server need a rule that sends a unit with a large
   backlog back to bootstrap (§10.1)?

Recommendation: adopt §4 as wire version 4 in one bump (§7), implement stage
1 and stage 2 in one release when Postgres index builds on existing data
measure acceptable, and schedule stage 3 for the release after.

## 2. Today, exactly

### 2.1 What the server does per subscription on a pull

`handleSyncRequest` plans the request in `packages/server/src/handler.ts`:

1. Reads the client record once for the actor binding (`handler.ts:278`).
2. Rejects more than `maxSubscriptionsPerRequest` frames and more than
   `maxScopeValuesPerSubscription` values in one subscription
   (`handler.ts:299` to `323`).
3. Validates every frame: duplicate id, unknown table, undeclared key,
   requested `'*'` (`handler.ts:340` to `372`).
4. Calls the resolver once per request (`resolveOnce`, `handler.ts:374`;
   SPEC §3.2 rule 3).
5. Computes effective scopes per subscription with `computeEffective`
   (`handler.ts:383`), which applies the wildcard fence per table.

The pull half (`handler.ts:630` onward) reads `maxCommitSeq` and the horizon
once, then walks the subscriptions in batches of
`floor(100,000 / (max(limitSnapshotRows, limitCommits) + 1))`, 99 with the
default limits (`handler.ts:645` to `660`). For each batch,
`prepareSections` (`packages/server/src/pull.ts:526`) starts one storage read
per subscription: `readCommitWindow` for an incremental cursor
(`pull.ts:549`), `scanRows` plus `latestScopedChangeSeq` for a bootstrap
(`pull.ts:566` to `592`). It then re-reads the horizon once for the batch
(`pull.ts:620`). Each subscription emits `SUB_START`, its `COMMIT` or segment
frames, and `SUB_END` (§1.6).

At round end the server reads the client record again (`handler.ts:753`) and
writes it with `cursor = min(nextCursor of the request's active
subscriptions)` (`handler.ts:766`) and the whole subscription list as JSON
(`handler.ts:757` to `765`; `sqlite-dialect.ts:1279` to `1300` rewrites the
`subscriptions` column on every round). A changed list re-registers realtime
connections (`handler.ts:786` to `795`).

Statements per incremental round for 223 subscriptions, with the default
limits:

| Storage | Commit-window reads | Mechanism |
| --- | --- | --- |
| SQLite | 223 statements | `readCommitWindow` per subscription (`sqlite-dialect.ts:1153`) |
| D1 | 223 statements in 3 `db.batch` round trips | reads queued per turn (`d1-storage.ts:844` to `884`) |
| Postgres | 3 statements, 223 `LATERAL` index ranges | `#batchedPage` folds concurrent reads into `COMMIT_WINDOW_BATCH_SQL` (`postgres-storage.ts:1992`, `relational-rows.ts:822`) |

### 2.2 How commits are indexed by scope

- SQLite and D1: `sync_change_scopes(partition, tbl, var, value,
  commit_seq)` with that column order as primary key
  (`sqlite-dialect.ts:153` to `157`); the push path inserts one entry per
  (change table, variable, value) (`sqlite-dialect.ts:1922`). D1 uses the
  same DDL (`d1-storage.ts:795`).
- Postgres: the same table and key, `sync_change_scopes_pk`
  (`postgres-storage.ts:159`, `220`).
- The candidate query filters `tbl = ? AND var = ? AND value IN (…) AND
  commit_seq > ?`, then joins `sync_commits` and the table's
  `sync_changes`, and verifies the full multi-variable match in code
  (`relational-rows.ts:747` to `770`; `collectCommitWindowPage`,
  `sqlite-dialect.ts:475`).
- Rust local authority: no inverted index. `commit_window` reads
  `sync_changes` of one table after the cursor through
  `sync_changes_by_table(tbl, commit_seq, idx)` and filters scopes in Rust
  (`rust/crates/authority/src/store.rs:589` to `605`).

The index leads with the table. A scan for "any change after N whose scope
matches one of these keys, in any table" cannot range over that key without
naming the table. §4.4 answers this.

### 2.3 What the client record holds

SQLite and D1 `sync_clients(partition, client_id, actor_id, wire_version,
cursor, subscriptions, updated_at_ms, last_round_at_ms, last_error_code,
consecutive_failures)` (`sqlite-dialect.ts:183` to `192`); Postgres the same
with `subscriptions JSONB` (`postgres-storage.ts:250` to `258`). Each
persisted subscription is `{ id, table, scopes, schemaVersion }`
(`handler.ts:757` to `765`). The Rust authority's `sync_clients` has no
subscription column (`store.rs:78` to `85`): it has no realtime channel.

The record already holds **one cursor per replica**: the minimum `nextCursor`
of the request's active subscriptions, bootstrap pins included (§4.5). The
pruning horizon reads that value per client (§4.6;
`packages/server/src/prune.ts:57` to `67`). Realtime acks update the same
single value (§8.2). The per-subscription cursors exist only on the wire and
in the client.

### 2.4 Realtime

At connect and at socket-round end, `loadRegistrations`
(`realtime.ts:1212` to `1275`) resolves scopes and recomputes effective
scopes for every persisted subscription. On each commit, `notifyCommit`
(`realtime.ts:1523`) visits every session, and `deliverCommit`
(`realtime.ts:937` to `1040`) filters the commit's changes per registration
and builds one `SUB_START`, `COMMIT`, `SUB_END` triple per matching
registration, so a commit touching three tables of one campaign produces
three sections with three copies of the commit metadata. Contiguity is
already tracked per connection (`lastKnownSeq`), and the client already acks
one value: after a delta the highest applied `nextCursor`, after a pull the
minimum cursor across active, synced subscriptions
(`packages/web-client/src/client.ts:5280` to `5291`;
`rust/crates/client/src/client.rs:11811`).

### 2.5 Client storage

TS: `_syncular_subscriptions(id, tbl, requested_scopes, params, cursor,
bootstrap_state, effective_scopes, status, reason_code)`, `_syncular_windows
(base, unit, sub_id)` and the pending-eviction registry
(`packages/web-client/src/schema.ts:620` to `637`). Rust:
`_syncular_subscriptions(id, tbl, state_json)` (`client.rs:2139`). Both
reject a reused id with a different tuple as
`client.subscription_intent_mismatch` (`client.ts:3228` to `3233`,
`client.rs:4990`).

The client applies a `COMMIT` change as an unconditional upsert or delete
(`packages/web-client/src/apply.ts:87`, `169`); it does not compare
`rowVersion` with the stored version. Apply order is therefore the only
thing that decides which state of a row survives.

### 2.6 `params`

§4.1 says `params` is "passed to the host snapshot function". Neither
reference server has one: the planner and pull code never read the field
(`handler.ts`, `pull.ts`, `realtime.ts`), the persisted subscription omits it
(`handler.ts:757` to `765`), and the Rust authority's `section` ignores it
(`rust/crates/authority/src/sync.rs:70` to `253`). The client stores it and
uses it only for the intent-mismatch check (`client.ts:2952`, `3228`).

### 2.7 Measurement

No lane in `bench/` measures server time per pull against the subscription
count: `server-prepare-lane.ts` counts statements for one subscription, and
the diagnostic workloads time replay, fanout, reconnect, reads and blobs
(`bench/README.md`). This RFC keeps the recorded figure: about 0.4 ms of
server time and 150 bytes each way per subscription, measured in one app on a
dev API (`pitfalls.md`, `guide-server.md`). At that slope the 223-subscription
account spends about 89 ms of server time per round on subscriptions. A lane
that pulls 10, 100 and 500 quiet subscriptions against `SqliteServerStorage`
and Postgres belongs to the stage 1 verification plan (§9).

## 3. Contradictions with the brief

1. **One scan per replica needs a different index.** §2.2: the change-scope
   index leads with `tbl`. Smallest adjustment: add `(partition, var, value,
   commit_seq)` (§4.4). Until then the live scan names every (table, key)
   pair in one statement, which still replaces 223 statements by one.
2. **Row versions do not order apply.** §2.5: the client upserts without a
   version guard. The join rule (§4.5) therefore relies on one ordered stream
   per response and on bootstrap sections preceding it.
3. **Change 1 cannot ship additively.** `SUBSCRIPTION` has one `table` field
   and frame layouts are frozen per wire version (§9). A new frame beside it
   would be a parallel subscription path, and a version-3 server that skipped
   it would silently subscribe nothing. Change 1 alone is a wire version
   bump; §7 weighs one bump against two.
4. **One cursor per replica already exists server-side** (§2.3). Change 2
   moves the wire and the client to the model the server and the realtime
   ack already use.
5. **The resume token already lists tables** (§4.7: `{ asOfCommitSeq,
   tables, tableIndex, rowCursor }`); a unit bootstrap fits it unchanged.
6. **`params` is dead in both reference servers** (§2.6).

## 4. The target model

### 4.1 Registration

- A unit's `scopes` maps each requested variable to exactly one value.
  Several values are several units.
- A unit's `tables` is empty or a list of table names. Empty covers every
  table that declares all requested variables, at the request's
  `schemaVersion`. A listed table must declare them all
  (`sync.invalid_subscription` otherwise). An empty cover set is
  `sync.invalid_subscription`.
- A unit's `id` is the lowercase hex of the first 16 bytes of SHA-256 over
  the canonical JSON (§11.2) of `{ "scopes": …, "tables": [sorted] }`. The
  client derives it; the server treats it as opaque and unique. Two
  registrations with one intent have one id, and one id never names two
  intents, so `client.subscription_intent_mismatch` and the §4.1 sub-id
  guidance have nothing left to guard.
- The registration list replaces the persisted one whenever it travels
  (today's replace semantics). Omitting a unit from a list that travels
  unregisters it. A request without `UNIT` frames changes nothing.
- The server validates and resolves the list on every pull, from the request
  or from storage: one resolver call, then `computeEffective` per (unit,
  table) pair, in memory.

### 4.2 The replica cursor

Invariant C1 (replaces §4.5 C1 for live units): for replica cursor `R`, the
replica has applied every change with `commitSeq ≤ R` that matches the
effective scopes of a live unit on a covered table.

- A replica without live units has `R = -1`.
- The live section returns the commits in `R < commitSeq ≤ T` that carry a
  matching change, oldest first, each `COMMIT` frame holding every matching
  change of that commit across tables (the frame's table dictionary already
  supports this). `T` is `maxCommitSeq`, or the last fully delivered commit
  when `limitCommits` changes (counted per live section) cut the stream.
  `LIVE_END.nextCursor = max(R, T)`, with today's §4.5 advancement rule.
- `R < horizonSeq` answers `LIVE_START.status = reset`: no commits,
  `nextCursor = R`. The client discards `R`, moves every live unit to
  catching-up with cursor `-1`, and keeps rows until each unit's first-page
  clear (§5.6).
- The server records `min(R', cursors and pins of catching-up units)` as
  the client-record cursor. §4.6 needs no change: it already reads one cursor
  per client.

### 4.3 Catching-up units and the join

A catching-up unit is in one of two states. **Bootstrapping**: it holds a
§4.7 token or cursor `-1`, and its section delivers segments for its tables
in schema bootstrap order. **Post-bootstrap**: it holds cursor `P ≥ 0`
without a token.

The live scan also covers post-bootstrap units: their changes appear in the
same ordered stream when `commitSeq > P`. A bootstrap that completes in this
response gives its unit `P = pin` in its `SUB_END`, and the server adds the
unit to the scan of the same response.

**Join rule.** After the live section, every post-bootstrap unit with
`P ≤ LIVE_END.nextCursor` is live. The client drops its cursor; the server
applies the same rule when it persists the record. A unit with
`P > nextCursor` (possible only when the stream was cut) stays catching-up
and joins in a later round.

No change is lost across the join: before it, the unit's changes with
`commitSeq > P` travel in the stream; after it, they are covered by `R`. A
bootstrapping unit does not hold back `R`; it holds only the pruning
horizon at its pin, as today.

**Apply order.** Within one response, unit sections precede the live
section, and the live section is one stream in `commitSeq` order. A row
reachable through two units therefore receives its changes once each, in
commit order, after any segment that wrote it. Segments hold rows at least
as new as their pin (§4.7, rows lane pages read current rows); the stream
re-applies every later change. When the stream is not cut, every row ends
the response at its state as of `maxCommitSeq`. When it is cut, a row
can show an older state than its segment until the next round; today two
subscriptions sharing a row at different cursors show the same transient.

### 4.4 The live scan

The keys of a pull are the distinct (variable, value) pairs of the live and
post-bootstrap units. One statement reads the candidates:

```sql
SELECT DISTINCT commit_seq FROM sync_change_scopes
 WHERE partition = ? AND (var, value) IN (<keys>)
   AND commit_seq > ? AND commit_seq <= ?
 ORDER BY commit_seq LIMIT ?
```

joined to `sync_commits` and to all of the commit's `sync_changes`, as
`commitWindowPageSql` does for one table today. Code then keeps a change of
table `t` when some unit covering `t` matches it under that pair's effective
map (fence variables included), and, for a post-bootstrap unit, when
`commitSeq > P`.

Stage 1 runs this on the existing primary key by expanding keys to
`(tbl, var, value)` triples for the covered tables: 223 index ranges in one
statement for the example account. Stage 2 adds `sync_change_scopes_by_key
(partition, var, value, commit_seq)` in SQLite, D1 and Postgres: 13 ranges.
`latestScopedChangeSeq` and erasure keep the table-led key. The Rust
authority scans `sync_changes` from `R` through its primary key and filters
in code; it serves one replica.

### 4.5 Effective scopes, revocation and purge

- **Echo.** `SUB_START` for a unit echoes `status` and `fenced`: the tables
  where the §3.2 rule 4 wildcard fence added variables, with those
  variables' effective lists. For an active single-valued unit the unit
  variables' effective values equal the requested values, so the echo omits
  them.
- **When echoes travel.** The server computes an echo digest over the
  canonical echo of every unit and returns it in `LIVE_END`. The client
  stores it and returns it in `REPLICA`. The server sends the `SUB_START`
  echo of every unit when the list traveled, when the returned digest differs
  from its own, or for a unit in a bootstrapping or revoked state. Only the
  server computes the digest, so the cores need no agreement on it.
- **Revocation.** A unit is revoked when §3.2 rule 5 revokes the unit's own
  variables (resolver failure, a missing key). A fence variable with an
  empty allowed list revokes that (unit, table) pair only: `fenced` carries
  the table with status `revoked`, and the client purges that table under the
  last echo. The §3.3 purge, its fail-closed clause and the outbox drop apply
  per (unit, table) with the persisted echo.
- **Row ownership** (§3.3) keeps its rule with (unit, table) as the owner
  grain: an owner is another active unit covering the table that is live or
  post-bootstrap, with a persisted echo matching the row.

### 4.6 Windows and eviction

A window base becomes (requested variable, fixed scopes, tables); a unit is
one value. The family is the set of unit ids, and a window change remains a
set difference on ids, now one id per value for all covered tables. Eviction
deletes per covered table in chunks of at most 1,024 rows (§4.8), with E1 to
E4 unchanged. A unit is pending until its bootstrap completes for every
covered table; the completeness oracle reports at unit grain.

### 4.7 Bootstrap

A unit bootstrap pins once and walks its tables in schema bootstrap order
with today's token. The rows lane pins at `maxCommitSeq`. A sqlite-lane table
keeps its own scope pin as the image reuse key and in its `SEGMENT_REF`
(`asOfCommitSeq`, §5.4); the unit's `SUB_END.nextCursor` is the lowest pin
among its tables. A lower cursor only re-applies changes the snapshot already
holds. First-page detection (§5.6) becomes per (unit, table): the first
segment of a table in a fresh bootstrap. Segment download (§5.5) is
unchanged: the server already takes the table from the stored publication
(`segment-download.ts:267` to `276`), and `X-Syncular-Scopes` carries the
unit's requested scopes.

### 4.8 Realtime

- Registrations are the live units' (unit, table) effective maps; the hub
  loads them from the record minus the catching-up ids.
- A delta is `LIVE_START`, one `COMMIT` with the matching changes across
  tables, `LIVE_END`. A catching-up unit receives nothing, so the client
  rule that skips sections of never-synced or mid-bootstrap subscriptions
  (§8.2) has no case left; a drop is a delta message the client did not
  apply.
- The client acks `LIVE_END.nextCursor` after a delta and `R` after a pull.
  `hello.cursor` stays the record cursor.
- A socket round's registration replace (§8.7) happens when the list
  traveled or a unit joined.

### 4.9 Local authority

§12.2 holds: the authority answers units with every variable granted, serves
one replica, and has no realtime channel. Attach (§12.3) is unaffected: it
pushes.

### 4.10 What happens to existing rules

| Rule | Fate |
| --- | --- |
| `maxSubscriptionsPerRequest` | Counts units in a traveling list; default stays 500, 13 for the example account |
| `maxScopeValuesPerSubscription` | Deleted: a unit holds one value per variable |
| `client.subscription_intent_mismatch` | Deleted: ids are derived from intent |
| Omission is unregistration | Kept for a traveling list; the "steady-state pulls MUST carry the complete list" rule and the §4.7 phase latitude are deleted |
| Sub-id derivation guidance (§4.1) | Replaced by the normative derivation of §4.1 of this RFC |
| `params` | Deleted |
| `PULL_HEADER.limitCommits` | Counts changes per live section and per unit section |

## 5. Wire

### 5.1 Request grammar, version 4

```
REQ_HEADER                      exactly once, first
ROUND_FAILURE                   0 or 1
PUSH_COMMIT × N
PULL_HEADER                     0 or 1
REPLICA                         exactly once iff PULL_HEADER
UNIT × M                        the complete list, or none (by reference)
PROGRESS × K                    one per catching-up unit
END
```

| Frame | Field | Type | Semantics |
| --- | --- | --- | --- |
| `REPLICA` | `cursor` | `i64` | Replica cursor; `-1` without live units |
| | `registrationDigest` | `bytes` (32) | Client-computed over its unit list |
| | `echoDigest` | `bytes` (0 or 32) | Last `LIVE_END.echoDigest` processed; empty before the first |
| `UNIT` (replaces `SUBSCRIPTION`, `0x04`) | `id` | `str` | §4.1 derivation |
| | `tables` | `list(str)` | Empty = every declaring table |
| | `scopes` | `map` `str` → `str` | One value per variable |
| `PROGRESS` | `id` | `str` | A registered unit |
| | `cursor` | `i64` | `-1` or the unit's pin or cursor |
| | `bootstrapState` | `opt(json)` | §4.7 token, round-tripped |

A `PROGRESS` id absent from the effective list (sent or persisted) is
`sync.invalid_subscription`. When `M > 0`, the server stores the list with
`registrationDigest`. When `M = 0` and the digest differs from the stored
one, or no list is stored, the server answers `LIVE_START.status =
unregistered`; the client resends the list in its next round, which it starts
at once.

### 5.2 Response grammar, version 4

```
RESP_HEADER, LEASE?, (PUSH_RESULT [PUSH_RESULT_DETAILS]) × N
per echoed or catching-up unit, in registration order:
  SUB_START, (SEGMENT_REF | SEGMENT_INLINE) × m, SUB_END
LIVE_START                      iff PULL_HEADER
COMMIT × k
LIVE_END
ERROR?, END
```

| Frame | Field | Type | Semantics |
| --- | --- | --- | --- |
| `SUB_START` (v4 layout) | `id`, `status`, `reasonCode`, `bootstrap` | as v3 | `status`: active, revoked, reset |
| | `fenced` | `list` of (`table: str`, `status: u8`, `scopes: map str → list(str)`) | §4.5 |
| `SUB_END` | unchanged | | |
| `LIVE_START` | `status` | `u8` | `1` active, `3` reset (`sync.cursor_expired`), `4` unregistered |
| | `reasonCode` | `str` | |
| `LIVE_END` | `nextCursor` | `i64` | §4.2 |
| | `echoDigest` | `bytes` (32) | §4.5 |

Unit sections carry no `COMMIT` frames; the no-mixing rule of §1.6 holds
trivially.

### 5.3 Version 3 and version 4 side by side

The server's codec window becomes `[3, 4]` (§9 already allows N versions). A
version-3 client keeps per-table subscriptions on the version-3 pull path and
never sees a version-4 frame. A version-4 client sent to a version-3-only
server receives a decode error for the unknown version (§1.2) and stops; a
deployment upgrades the server first. The client record's `wire_version`
column (`sqlite-dialect.ts:185`) tells the hub which shape `subscriptions`
holds; deltas already encode per session wire version. No step of this RFC
is additive under version 3 (§3 item 3).

### 5.4 Bytes for the 223-subscription account

Assumptions: 36-byte UUIDs for `clientId`, `logEpoch` and scope values, the
variable `campaign_id` or `ruleset_id`, every unit covering all tables,
frame header 5 bytes (§1.2), no push.

| Message | Today (measured) | Stage 1, steady state | Stage 1, list changed |
| --- | --- | --- | --- |
| Request | 33.8 KB, 223 `SUBSCRIPTION` frames | 206 B: envelope 8, `REQ_HEADER` 90, `PULL_HEADER` 18, `REPLICA` 85, `END` 5 | 1.56 KB: plus 13 `UNIT` frames of 104 B |
| Response, quiet | 32 KB, 223 sections | 124 B: envelope 8, `RESP_HEADER` 52, `LIVE_START` 10, `LIVE_END` 49, `END` 5 | 0.97 KB: plus 13 echoes of 65 B |
| Server commit-window statements | 223 (SQLite), 3 (Postgres) | 1 with 223 ranges; 13 ranges after stage 2 | same |
| Client record writes | full 223-entry JSON every round | cursor and timestamps | list once |

A delta for a commit touching three tables of one campaign carries one
section instead of three.

## 6. Migration

### 6.1 Client replicas

At open, a client whose stored registrations are version 3 converts in one
local transaction:

1. Group active subscriptions by canonical requested scopes. A subscription
   with several values per variable splits into one unit per value
   combination; each inherits the subscription's cursor and echo. `params`
   are dropped.
2. A group whose tables equal every declaring table becomes a unit with
   empty `tables`; any other group keeps its tables as the unit's list.
3. A unit inherits the lowest cursor of its tables. A unit with any
   bootstrapping table (token or cursor `-1`) becomes bootstrapping with
   cursor `-1`; its first-page clear keeps rows other units own.
4. `R` = the lowest cursor among units that are not bootstrapping; those
   units are live. Without such units `R = -1`.
5. Window registry rows rewrite to the new base and derived ids; pending
   evictions keep their per-table rows.

Why the lowest cursor is safe: every converted subscription holds every
matching change through its own cursor, so it holds them through the minimum.
Replaying from the minimum re-delivers changes the replica holds, and each
change carries the full row or a delete, so re-application converges (§1.4
rule 5). The minimum is the value the client already acks
(`client.ts:5280` to `5291`) and the server already stores as the record
cursor (`handler.ts:766`), so the horizon already protects it. If it lies
below the horizon (a client offline past the 14-day active window), the
first version-4 pull answers `reset`, which is the outcome today's
per-subscription cursors produce in the same case. Cost: one replay from the
lowest cursor, bounded by `limitCommits` per round.

### 6.2 Server records

No DDL for records. The first version-4 pull of a client carries the full
list (the client holds no digest the server stored), and the round-end write
replaces the version-3 JSON with the version-4 shape `{ units, digest,
catchingUp }` and sets `wire_version = 4`. Postgres keeps `JSONB`. The Rust
authority has no list to convert. Stage 2 adds one index per backend; on
Postgres it builds with `CREATE INDEX CONCURRENTLY` outside the schema
transaction, on D1 inside the §2.4 readiness flow. Build time on existing
data is unmeasured.

## 7. Stages

Dependencies after reading the code:

- **Change 1 alone** ships only as its own wire version (§3 item 3). It
  gives the example account 13 subscriptions per round, about 13 × 120 B =
  1.6 KB per request including cursors, 13 response sections and 13
  commit-window reads (each over all covered tables, which needs the stage 2
  index or a table list per read).
- **Change 2 alone** works on the existing index: one statement over 223
  (table, key) triples, one live section in the response (32 KB to about
  0.1 KB quiet), and requests of about 223 × 140 B = 31 KB, because the list
  still travels.
- **Change 3 depends on change 2.** Without one replica cursor, a request
  that omits the list must still carry 223 cursors, or the server must store
  them (§11.1).

Each wire stage costs one compatibility window in both codecs and the
server. One bump is recommended:

| Stage | Contents | Wire | Example account per round |
| --- | --- | --- | --- |
| 1 | All three changes; live scan on the existing primary key | Version 4, window `[3, 4]` | 0 to 13 units sent; 206 B request, 124 B quiet response; 1 statement, 223 ranges |
| 2 | `sync_change_scopes_by_key` in SQLite, D1, Postgres | none | 1 statement, 13 ranges |
| 3 | Server reads only version 4; delete the version-3 pull path, per-table registration code and the old client conversion | window `[4]` | unchanged |

Stage 1 cannot be split across releases without a second wire version.
Stage 2 can ship in the same release as stage 1.

## 8. Cost and proof

| Package or crate | Stage | Change | Rough size |
| --- | --- | --- | --- |
| `packages/core` codec, golden vectors | 1 | Version-4 frames, grammar, vectors | +500 lines |
| `rust/crates/ssp2` | 1 | Same | +500 lines |
| `packages/server` | 1 | Unit validation, live scan, unit sections, record shape, realtime delta and registrations, limits | +1,200, −300 (v3 kept until stage 3) |
| `packages/server` storages | 1, 2 | `readLiveWindow` in SQLite, D1, Postgres; index | +300 |
| `packages/web-client` | 1 | Unit store, conversion, replica cursor, response processing, ack, window base, API | +900, −700 |
| `rust/crates/client`, `command`, `ffi` | 1 | Same | +1,000, −800 |
| `rust/crates/authority` | 1 | Unit sections, live scan | +250, −150 |
| `packages/react`, `packages/tauri`, `bindings/*` | 1 | Subscribe signature and handles | +300, −300 |
| `packages/conformance` | 1 | Driver API; about 12 new and 40 rewritten scenarios | +1,500 |
| SPEC, docs pages, changelog | 1 | §4 rewrite; four docs pages | |
| Stage 3 removal | 3 | Version-3 pull path, per-table registration, `readCommitWindow` per subscription | about −1,500 |

The sizes are estimates read off the files named in §2; none is measured.
Scenarios touching subscriptions directly sit in `window` (11), `scopes`
(16), `realtime` (10), `ws-round` (5), `bootstrap` (7), `sqlite-image` (4),
`lifecycle` (6): 59 of the 255 literal scenario names in
`packages/conformance/src/catalog/` (the brief cites 293; I did not reconcile
the difference). Most other scenarios subscribe through the driver and change
with its API.

Unmeasured: server time per pull before and after; index build time and
write amplification of the stage 2 index; client conversion time on a
replica with 400 subscriptions.

### 8.1 What gets deleted

- **Wire**: per-subscription cursors in steady state, `SUBSCRIPTION.table`,
  `params`, the full effective map in every `SUB_START`, 2 × 223 section
  frames per quiet response.
- **SPEC**: the §4.1 intent-binding paragraph and sub-id guidance (about 20
  lines), "Steady-state pulls MUST carry the complete list" in §4.1 and §4.7
  (about 20 lines), the §4.8 family-per-table text and deterministic-id
  dependency (about 15 lines), the §8.2 rules for skipped sections and the
  ack floor (about 30 lines, replaced by about 8), the
  `maxScopeValuesPerSubscription` row.
- **Server**: the scope-value cap loop (`handler.ts:312` to `323`), batching
  windows by subscription count (`handler.ts:645` to `660`), per-subscription
  `readCommitWindow` and `COMMIT_WINDOW_BATCH_SQL` with `commitWindowPageSql`
  (about 120 lines with comments, `relational-rows.ts:718` to `833`), the
  per-registration section loop in `deliverCommit` (`realtime.ts:943` to
  `966`); the full-list write per round. The version-3 copies go in stage 3.
- **Clients**: the ack floor (`client.ts:5280` to `5291`), the intent
  mismatch checks (`client.ts:2310` to `2325`, `3220` to `3235`;
  `client.rs:2740` to `2750`, `4985` to `4995`), per-table window ids
  (`client.rs:823` to `850`; `window.ts`), the per-section skip logic for
  deltas, `params` storage.
- **Docs**: `pitfalls.md` sections "Do give each scope unit that can be lost
  its own subscription" and "Don't reuse a subscription id for a different
  query"; "Don't subscribe every table of every scope up front" shrinks to
  the limit on units.

## 9. Verification plan

Conformance scenarios, both cores, every storage:

1. A unit covers every declaring table; a second unit with a table list
   covers only those tables.
2. A widened unit bootstraps and joins in the same round.
3. A cut live stream leaves a post-bootstrap unit with `P > R`; it joins in
   the next round with no lost change.
4. Two units share a row; evicting one keeps the row; the survivor receives
   its next change.
5. Revocation of a unit variable purges every covered table; revocation of a
   fence variable purges one table.
6. A steady-state pull without `UNIT` frames returns the live section; a
   server whose stored digest differs answers `unregistered`, and the
   resend restores sync in the next round.
7. A changed effective scope after a resolver change reaches the client
   through the echo digest.
8. `R < horizonSeq` resets the replica; every unit re-bootstraps.
9. A delta carries one section for a three-table commit and nothing for a
   catching-up unit; the ack equals `R`.
10. A version-3 replica converts; its first version-4 round replays from the
    lowest cursor and converges.
11. A version-3 client and a version-4 client sync against one server.
12. The limit counts units in a traveling list.

A bench lane pulls 10, 100 and 500 quiet registrations against SQLite and
Postgres, before and after, and records server time per round and request
and response bytes.

## 10. Risks in detail

### 10.1 Head-of-line blocking

Today a subscription with a backlog consumes its own 1,000-change budget and
leaves the others current. Under one stream, a unit with 10,000 pending
changes delays every newer change of other units by 10 rounds; with realtime,
deltas stay suppressed until the catch-up round acks (§8.2). A rule that
answers a unit whose backlog exceeds `limitCommits` with a fresh bootstrap
(§8.4 "catch-up prefers segments") removes the delay at the cost of a
per-key count before the scan and a new demotion path. This RFC leaves it out
and asks question 4.

### 10.2 Unit granularity of completeness

A unit is pending until its last table finishes. A unit whose largest table
needs several rounds of segments keeps its small tables reported as partial
for that time, though their rows are present. Schema bootstrap order puts
parents first; it does not put small tables first.

### 10.3 Table-set changes

A unit's table list is part of its id. Changing it is an unsubscribe and a
subscribe: the new unit bootstraps every covered table, and the first-page
clear keeps rows the old unit owned only while the old unit stays
registered. Converted replicas with explicit lists pay one bootstrap per unit
when the app moves them to every declaring table.

### 10.4 Digest handling

The registration digest is client-computed and compared by equality, so a
client that changes its list without changing the digest would keep the old
list on the server. The client computes the digest in the same transaction
that changes the list. A copied replica with one `clientId` and two lists
resends its list on every round (each copy's digest differs from the stored
one), which is visible as `unregistered` answers in the client record.

## 11. Alternatives

### 11.1 Per-table subscriptions, registration by reference, cursors on the server

The server stores each subscription's cursor and the request names a digest.
Request bytes drop to the stage 1 figure. The server still runs 223 window
reads and writes 223 cursors per round (one JSON rewrite today, §2.3), the
response still carries 223 sections, and the cursor of record moves to the
server, which cannot know whether the client applied a response the transport
lost; it would need a per-subscription ack. Cheaper than this RFC in client
code, more expensive in server state, and the limit still counts tables times
units.

### 11.2 A subscription-group frame

One frame names a table list and a unit list; the server expands it to 223
subscriptions. The request shrinks to about 2 KB and the frame can be
additive if the client checks the response echo. The response keeps 223
sections, the server keeps 223 reads, and the limit applies to the expansion.
It is the cheapest change that cuts request bytes, and it adds a second way to
express a subscription.

### 11.3 Raising the limit

`limits.maxSubscriptionsPerRequest` is a host option today
(`guide-server.md`). At the measured slope, 1,000 subscriptions cost about
400 ms of server time and 150 KB each way per round, wake-ups included. No
code; it is the right answer for the weeks before stage 1 ships.

## 12. Implementation lanes

The normative text is `docs/SPEC.md` at wire version 4: units and the
registration list §4.1, frames §4.2 to §4.4, the replica cursor, live section
and join rule §4.5, bootstrap §4.7, windows §4.8, the watermark §6.3.2, the
outbox sequence §7.1, realtime §8.1, §8.2 and §8.7, the migration note §9,
codes §10.2, golden vectors Appendix A, scenarios Appendix B 25 to 27. Where
the spec and §1 to §11 of this RFC differ, the spec wins.

Lanes that share a phase own disjoint paths and run in parallel in one
checkout. A lane edits only the paths it owns; it changes another lane's
paths only through the coordinator. Every lane adds or rewrites the `bun:test`
or `cargo test` files next to its change.

| Lane | Owns | Depends on | Acceptance | Conformance it must make pass |
| --- | --- | --- | --- | --- |
| A1 TS codec and vectors | `packages/core/src/**` (frames, message, stream, render, constants, canonical JSON, the unit id and registration digest helpers), `packages/core/scripts/generate-vectors.ts`, `spec/vectors/**` | SPEC | `bun test packages/core` | `vectors/request-roundtrip`, `vectors/response-roundtrip` against the TS codec |
| A2 Rust codec | `rust/crates/ssp2/**` | SPEC; A1's vectors for its acceptance | `bun run rust test -p syncular-ssp2` | the same vectors, Rust side |
| A3 Server storages | `packages/server/src/{storage,storage-query,sqlite-dialect,sqlite-storage,d1-storage,postgres-storage,relational-rows,prune,admin,restore}.ts` and their tests: `sync_change_scopes_by_key (partition, var, value, commit_seq)` in SQLite, D1 and Postgres; `readLiveWindow`; the client record (list, digest, catching-up ids, record cursor, schema version); `outbox_id` and `client_seq` on results, `sync_push_watermarks`, the §6.3.2 upsert and delete, the §9 settlement of sequence-less results; `admin.findWrite` reporting the watermark | SPEC | `bun test packages/server/test` (storage files) | storage half of 27(e) |
| B1 Server pull, push and realtime | `packages/server/src/{handler,pull,push,realtime,scopes,context,validate,segment-download,local-authority,postgres-fanout,erase,events}.ts`, `packages/server-hono/**`, `packages/server-workers/**` | A1, A3 | `bun test packages/server packages/server-hono packages/server-workers` | 25(a, c, f), 26(a, b, c, e), 27(a, b, c, d) against the TS server with the reference codec driver |
| B2 TS client | `packages/web-client/src/**` and `packages/web-client/test/**`: unit store, registration list and digest, `PROGRESS`, replica cursor, live-section apply with the local unit filter, join rule, first-page tracking per table, window bases without tables and unit reference counts, `outboxId` and `clientSeq`, `sync.commit_expired`, diagnostics without unit ids, catch-up state, the §9 replica upgrade, `worker-local-authority.ts` | A1 | `bun test packages/web-client`, `bun run test:isolated`, `bun run test:browser` | every TS×TS scenario once C4 lands |
| B3 Rust client | `rust/crates/client/**` (same scope as B2) | A2 | `bun run rust test -p syncular-client`; `bun run rust clippy --all-targets -- -D warnings` | every Rust×TS scenario once C4 lands |
| B4 Rust local authority | `rust/crates/authority/**`: unit sections, one scan of `sync_changes` from `R`, the client record with list and digest, the watermark tables | A2 | `bun run rust test -p syncular-authority` | `local-authority/*` in the Rust pairing, 27(e) on the authority |
| B5 Typegen | `packages/typegen/**` with its golden fixtures: manifest `subscriptions` entries lose `table` and multi-value scopes and become unit templates (one value per variable); TS, Swift, Kotlin, Dart and Rust emitters | the B2 `subscribe` signature (B2 publishes it before other work) | `bun test packages/typegen` | none |
| C1 Native surface | `rust/crates/command/**`, `rust/crates/ffi/**`, `rust/crates/conformance-shim/**`, `packages/tauri/**`, `bindings/**` | B3, B5 | `bun run rust test`; `bindings/tauri/check.sh`, `bindings/kotlin/check.sh`, `bindings/swift/check.sh` (macOS), `bindings/flutter/check.sh`, `bindings/react-native/check.sh` | Rust×TS pairing through the shim |
| C2 React and testkit | `packages/react/**`, `packages/testing/**` | B2 | `bun test packages/react packages/testing` | none |
| C3 Conformance catalog | `packages/conformance/src/**` (driver API with units, the reference-codec, TS and Rust drivers, catalog) | A1; driver API first, scenarios pass after B1 to B4 and C1 | `bun test packages/conformance` | all |
| C4 Docs | `apps/docs/src/content/**` (`concepts-subscriptions`, `concepts-windowing`, `concepts-realtime`, `pitfalls`, `guide-server`, `reference`, the client and binding guides), `apps/docs/src/changelog.mjs`, `apps/docs/src/pages/index.astro`, `apps/docs/src/content/blog/syncular-write-path.md` (scenario count only) | B2's API, C3's final count | `bun test apps/docs`; `bun run lint` | none |
| C5 Examples, templates, demos | `examples/quickstart/**`, `packages/create-app/**`, `apps/demo/**`, `apps/demo-react/**`, including their regenerated `syncular.generated.ts` | B5, B2, C2 | `bun test examples/quickstart packages/create-app apps/demo apps/demo-react` | none |
| C6 Bench | new `bench/src/server-units-lane.ts`, `bench/README.md`, `bench/RESULTS.md` | B1, A3 | `bun test bench`; one recorded run | none |

**Order.** Phase A: A1, A2 and A3 in parallel (A2 finishes against A1's
vectors). Phase B: B1, B2, B3, B4 and B5 in parallel once their phase A
inputs land; C3 starts its driver API in phase B. Phase C: C1, C2, C3's
scenarios, then C4, C5 and C6. The release ships when every lane's
acceptance passes and `bun run check` is green.

**Expected red between lanes.** Until A1 and A2 both land, `vectors/*` fails
in the pairing that lacks the new codec. Between A1 and B1 the server and
web-client suites fail wherever they decode a version 3 message. Between B1
and B2, every TS×TS conformance scenario fails (the server reads version 4
only); between B1 and B3 every Rust×TS scenario fails, and the Rust pairing
stays red until C1 updates the shim. Between B2 and C2, C5 the React,
testkit, example and template tests fail on the subscribe signature. The docs
count test stays green until C3 changes the catalog size, and C4 restores it.

**Conformance catalog.** The catalog holds 293 scenarios
(`CATALOG.length`, pinned by `apps/docs/test/conformance-count.test.ts`). A
count of literal names finds 255: 255 `name: '…'` properties, plus 2 names
passed to a helper as plain strings
(`conflict/rollback-restores-pulled-server-base`,
`conflict/rollback-replays-later-edit-over-pulled-base`), plus 36 generated by
7 template-literal sites (outbox budgets, schema-bump marker and
scope-compatibility families, blob fault matrices, the bootstrap progress
lanes). Lane C3 changes it as follows:

- Delete 2: `subscription/identity-is-immutable-and-idempotent` (ids are
  derived; the intent-mismatch error is gone) and
  `realtime/delta-skips-a-reset-subscription` (a catching-up unit receives no
  delta; covered by the new 25(a)).
- Rewrite the assertions of about 70 that read per-table subscriptions,
  per-subscription cursors, echoes or the late-duplicate outcome: `scopes/*`
  (16), `window/*` (11), the 9 remaining `realtime/*`, `ws-round/*` (5),
  `bootstrap/*` (9), `sqlite-image/*` (4),
  `schema-bump/subscription-scope-*` (4), `convergence/quiet-subscription-cursor-advances`,
  `cursor/horizon-reset-rebootstrap-and-boundary`,
  `lifecycle/pruning-during-pull-resets-and-rebootstraps`,
  `observation/applied-commits-distinguish-subscriptions-and-snapshots`,
  `observation/snapshot-read-catchup-states`,
  `observation/snapshot-read-corrupt-subscription-classification`,
  `observation/zero-row-window-completion`,
  `offline/duplicate-request-delivery`, `offline/stale-retransmit-is-harmless`
  (a late duplicate now answers `sync.commit_expired`),
  `errors/request-level-catalog`, `security/authority-snapshot-*` (2). Every
  other scenario changes only through the driver's subscribe call.
- Add 16: Appendix B 25(a) to (f), 26(a) to (e), 27(a) to (e).

The catalog then holds 307 scenarios; C4 sets the landing-page constant and
the blog sentence to `CATALOG.length`. The rewrite count is read off scenario
names and categories; C3 confirms it scenario by scenario.

**Bench lane.** C6 pulls 10, 100 and 500 registered units with no change
against `SqliteServerStorage` and Postgres (PGlite in CI, a real server for
the recorded run), steady state by reference and one round with the list
traveling, and records server time per pull, statements per pull, and request
and response bytes. It records the same figures for one unit with a backlog of
10,000 changes beside 99 quiet units, which measures the accepted head-of-line
delay in rounds.
