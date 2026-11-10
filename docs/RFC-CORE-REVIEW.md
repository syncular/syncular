# RFC: Core review findings and fix program

- Status: implemented on local branch `core-review` (34 commits, not pushed); N5 and the §3.2 questions wait on the maintainer
- Date: 2026-11-10
- Review baseline: `a531dcea` (0.58.0)
- Scope: `packages/core`, `packages/crypto`, `packages/server`,
  `packages/server-hono`, `packages/server-workers`, `packages/web-client`,
  `rust/crates/ssp2`, `rust/crates/client`, `rust/crates/command`,
  `rust/crates/ffi`, `rust/crates/authority`; SPEC sections named per finding;
  conformance catalog; docs site

## 1. One page

**Decision asked.** Accept the fix program in §5 and the six semantic
decisions in §3. Answer the three open questions in §3.2 when convenient; each
has a default that the program executes.

**Why.** Seven reviewers read about 150k lines of core code against
`docs/SPEC.md`. They reported 83 confirmed defects and 40 unconfirmed leads.
Authorization of writes, commit atomicity, cursor durability and SQL
construction held up. The defects cluster in four places: missing resource
limits, liveness after a failure, behavior that differs between the TS and
Rust cores, and client logic that assumes subscriptions never overlap.

**What changes.**

| Area | Findings | Largest risk closed |
| --- | --- | --- |
| Wire codec, both cores | 5 | A value the TS server accepts fails to decode on a Rust client |
| Server request path | 15 | A client reads rows outside a scope fence; a forged resume token poisons the image cache |
| Server network surfaces | 15 | An authenticated client exhausts memory with one gzip body; the orphan sweep deletes live blobs |
| Server storage | 12 | The SQLite backend serves uncommitted rows; Postgres reactions never run under the documented Bun.sql adapter |
| TS client | 23 | One tab's reply settles another tab's call; a rejected commit restores a stale row |
| Rust client | 11 | A revocation purge deletes nothing for integer scope columns |
| Rust transport, FFI, command, authority | 15 | Native bindings receive no realtime traffic while idle; a retried attach drops rows on both sides |
| Simplifications | 10 | Three storage backends and two local row models carry the same bugs separately |

**What stays.** Wire version 3. No new frame types. The public client API
keeps its shape; new server limits have defaults. Nothing is pushed or
published by this program.

**What you get and when.** Fixes land in five waves (§5), each ending in a
green `bun run check` and Rust gate and one or more local commits. §4 carries
a status column per finding that the coordinating session updates as fixes
land.

**Cost.** About 20 agent tasks on Opus and Sonnet, at most three running at a
time, sharing one checkout.

**Biggest risks.**

- Decision D1 narrows what a wildcard grant delivers. An app that relied on
  the unfenced read loses rows it should never have received.
- Decision D2 rejects pushed values that SQLite-backed servers accepted
  before (U+0000 in strings, non-finite floats, non-canonical BlobRefs).
- The storage-backend unification (X2) is a large refactor of 9k lines. It
  runs last and is dropped from this program if the contract test does not
  stay green.

## 2. Evidence labels

Each finding carries one label.

- `R`: reproduced by running the real modules (scratch test or in-memory
  script, since deleted).
- `C`: the cited code was read by the coordinating reviewer and matches the
  claim; nothing was executed.
- `U`: reported by one reviewer with file and line; not re-checked.

Severity is the reviewer's: critical, high, medium, low.

## 3. Decisions

### 3.1 Taken (binding for the fix work)

**D1. Wildcard grants are fenced by the actor's other lists (§3.2).** When a
requested scope key passes through an allowed `'*'`, the server adds every
variable the table declares, the request omits, and the actor holds a
non-wildcard list for, to the effective scopes with the actor's list. The
subscription stays active and `SUB_START` echoes the widened effective map.
A request that names every variable is unchanged. An actor whose allowed map
holds only wildcards is unchanged. The rule applies wherever
`computeEffective` runs: pull, segment download, realtime, admin.

**D2. Push admission accepts one value set on every backend and core
(§2.4, §6.1).** The server and the local authority reject, per operation with
`sync.invalid_request`:

- a `string`, `rowId` or scope value containing U+0000;
- a `json` value that nests deeper than 64 containers, holds a number that is
  not a finite binary64, holds a string with U+0000 or an unpaired surrogate;
- a `float` that is NaN or infinite;
- a `blob_ref` whose text differs from the canonical serialization of its
  parsed fields.

Clients refuse the same values at authoring. The full-row decoders used for
`COMMIT` frames and segments stay as permissive as they are today so rows
already stored keep decoding. `blob_ref` is the exception: §5.9.1 already
defines the value as canonical, so both cores check canonical equality on
every path.

**D3. One limits object (§1.7).** `ServerLimits` gains
`maxRequestBytes` (decoded bytes, HTTP and socket), `maxSubscriptionsPerRequest`,
`maxScopeValuesPerSubscription` and `maxWatchesPerSession`, each with a
default and each answered with a catalog error. No other limit mechanism is
added.

**D4. Idempotency results survive pruning (§4.6, §4.6.1).** A pruned result
would let a late retry apply twice. The spec keeps the sentence at §4.6 and
drops the contradicting one in §4.6.1. Scope erasure strips `serverRow` from
stored conflict results of the erased binding.

**D5. Read-only means what SQLite says.** Both clients decide read-only by
asking the prepared statement, and `PRAGMA` leaves the allowlist. The lexical
`WITH` scanner is deleted in both cores.

**D6. An interrupted abandon blocks attach (§12.3).** The authority persists
an undo marker before the first undo commit. `attach` refuses while the
marker is set. A retried abandon uses fresh undo commit ids.

### 3.2 Open (default executes unless overturned)

| # | Question | Default |
| --- | --- | --- |
| Q1 | Should D1 apply to every omitted variable, wildcard or not? Today an actor allowed `{workspace_id:[w1], surgery_id:[s1]}` who subscribes by workspace alone receives `(w1, s9)`. | No. Keep D1 narrow; record the general case as a documented property of §3.2. |
| Q2 | Should idempotency results get a retention bound (age or count)? The table grows by one row per push forever. | No bound in this program. |
| Q3 | Should a recreated row start above the version its tombstone ended at (S14)? It needs a tombstone column in three backends and the authority. | Yes, in wave 5, if waves 1 to 4 are green. |

## 4. Findings

Columns: id, severity, evidence, where, defect, fix, status. Status values:
`open`, `fixed <commit>`, `deferred <reason>`.

### 4.1 Wire codec (`packages/core`, `rust/crates/ssp2`)

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | high | R | `core/src/row-codec.ts:150-164`, `core/src/message.ts:289-296`, `ssp2/src/primitives.rs:131-139` | TS `JSON.parse` accepts 128+ nested containers, `1e999` and `"\ud800"`; `serde_json` rejects all three. A value the TS server accepts fails to decode on a Rust client. | D2. One documented validity rule, enforced in both cores at authoring and push admission; golden vectors at each boundary. | fixed 466a9813, f8976d10 |
| C2 | high | R | `core/src/blob-ref.ts:44-110`, `ssp2/src/blob_ref.rs:26-85` | Rust iterates a sorted map, so its key-order check never fires and reordered keys pass; TS rejects them. TS accepts `byteLength` as `1e2`, `3.0`, `-0`; Rust rejects them. Both accept duplicate keys and whitespace. | D2. Validate by comparing the raw text with the canonical serialization in both cores; delete the per-field order logic. | fixed 466a9813 |
| C3 | high | R | `server/src/storage-errors.ts:142-145`, `server/src/relational-rows.ts:526-534` | A pushed string with U+0000, or `json` with `\u0000` or a lone surrogate escape, applies on SQLite and throws SQLSTATE 22021/22P05/22P02 on Postgres. The round answers retryable `sync.internal_error`, so the outbox retries forever. | D2. Reject at admission. | fixed 466a9813, a04b2623 |
| C4 | medium | R | `server/src/push.ts` (no finite check), `core/src/row-codec.ts:115-122` | `NaN` in a non-nullable `float` applies on Postgres and is rejected with `sync.constraint_violation` on SQLite. Client SQLite stores `NaN` as NULL. | D2. | fixed 466a9813 |
| C5 | low | C | 17 sites: `core/src/message.ts`, `server/src/handler.ts`, `server/src/realtime.ts`, `ssp2/src/decode.rs`, `ssp2/src/encode.rs` | Branches on `wireVersion >= 2` are dead: the minimum is 3. | Delete; `logEpoch` and `resetRequired` become required fields. | fixed 466a9813, 156e1356 |

Checked and sound: bounds checks on every read, canonical map order by UTF-16
code unit in both cores, presence invariants, AES-GCM nonce generation, the
X25519 wrap envelope. The empty AAD is a §5.11 decision: a server can replay
a ciphertext across rows that share a key.

### 4.2 Server request path (`packages/server/src`)

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | high | R | `scopes.ts:28-50`, `handler.ts:334-347` | `computeEffective` intersects only requested keys. With allowed `{clinic_id:['clinic-a'], appointment_id:['*']}`, a subscription by `appointment_id` alone reads other clinics' rows. `concepts-scopes.md:141` promises the fence. | D1. Spec §3.2 first; docs page; conformance scenario. | fixed 156e1356 |
| S2 | high | C | `handler.ts:317-349`, `handler.ts:968-986`, `pull.ts:529-613` | Subscriptions per request are uncapped, every first page (up to 50,001 rows) is read concurrently, and the response is buffered whole. A 12 KB request holds gigabytes. `Math.min(...cursors)` throws at large counts. | D3. Read first pages per section as emitted. | fixed 156e1356 |
| S3 | high | R | `pull.ts:91-116`, `pull.ts:554-604`, `pull.ts:720-724` | A client resume token's `asOfCommitSeq` has no upper bound or integer check and becomes the sqlite-image reuse key and `nextCursor`. A reader stores a stale image under a future sequence; later clients skip commits. | Require a safe integer `<= maxSeq`; never take the image reuse key from a token. | fixed 156e1356 |
| S4 | high | R | `pull.ts:581-613` | The `lane` promise has no handler when `firstPage` rejects. One failed storage read raises an unhandled rejection, which terminates Node by default. | Derive the lane inside the per-plan async mapper. | fixed 156e1356 |
| S5 | medium | R | `pull.ts:532-548`, `pull.ts:714-715` | An unparseable `bootstrapState` with an in-range cursor is served as an incremental pull; the client is marked synced with partial rows. §4.7 requires a restart. | Decide `bootstrapping` on `sub.bootstrapState !== undefined`. | fixed 156e1356 |
| S6 | medium | U | `push.ts:1337-1360`, `push.ts:1446-1453` | A child insert is authorized on the child's scopes only; the parent check is existence anywhere in the partition. An actor inserts a child under another scope's parent and blocks its deletion; `missing_parent` is an existence oracle. | Treat a parent the actor cannot authorize as `missing_parent`. §6.11 first; authority parity. | fixed a04b2623 |
| S7 | medium | U | `push.ts:1412-1426` | Reference enforcement loads every child with payloads before applying `RESTRICT` or the cascade cap, inside the partition lock. | `RESTRICT` reads one row; cascades stop at the cap plus one. | fixed a04b2623 |
| S8 | medium | U | `operations-realtime.ts:86-142` | A watch session accepts unlimited watches; each commit reruns all of them concurrently. | D3 cap, answered with `watch_error`; serialize a session's refreshes. | fixed 156e1356 |
| S9 | medium | U | `push.ts:1012-1020` | Blob existence checks run one store round trip per reference, sequentially, inside the locked transaction. | One deduplicated, concurrent existence set per commit. | fixed a04b2623 |
| S10 | medium | U | `push.ts:342`, `push.ts:718-745`, `push.ts:1944-1947` | A conflict record's `serverVersion` and `serverRow` are read from candidate state that includes the same commit's earlier, rolled-back operations. | Re-read the row after the savepoint rollback. | fixed a04b2623 |
| S11 | low | U | `schema.ts:404-456` | `compileSchema` accepts a reference whose child table has `materialize: false`; every parent delete then fails with a non-catalog error. | One more throw in the reference loop. | fixed a04b2623 |
| S12 | low | U | `push.ts:1316-1346` | `missing_parent` is judged on the merged row; §6.11 limits it to a present, non-null reference column. | Carry presence in the staged write and skip absent columns. | fixed a04b2623 |
| S13 | low | U | `push.ts:864-875` | The tombstone probe runs before payload authorization, so `sync.row_deleted` versus `sync.forbidden` discloses deletion. | Move the probe below `authorizeWrite`. | fixed a04b2623, 4b2f77ce |
| S14 | low | U | `push.ts:946-951`, `push.ts:691-697` | A recreated row restarts at version 1, so a `baseVersion` from the previous incarnation is accepted. | Q3. | fixed 4b2f77ce |
| S15 | low | U | `handler.ts:705-734`, `handler.ts:968-985` | The client record is written before the serve-gate verification that can still refuse the round. §4.5 forbids a failed round changing the cursor. | Move `putClientRecord` and `notifySubscriptions` after the gate. | fixed 156e1356 |

Unconfirmed leads: remote query params are cast, never type-checked
(`operations.ts:372`); `limitsOf` spreads unvalidated limits, so `NaN`
disables the cap (`context.ts:238`); the lease slides in `planRequest` before
the round succeeds (`handler.ts:194-203`); a cascade-write
`StorageConstraintError` carries the synthetic op index (`push.ts:2043-2055`);
`errorBody` parses host-supplied `details` (`errors.ts:337-339`).

Checked and sound: stored-row authorization on update and delete, scope
column immutability, idempotency re-check under the partition lock, window
truncation and `nextCursor`, horizon recheck, SQL identifier quoting, the
error catalog against §10.2.

### 4.3 Server network surfaces (`packages/server`, `server-hono`, `server-workers`)

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | high | C | `server/src/content-encoding.ts:172-197` | `decodeRequestBody` inflates a gzip body fully with no output bound. A 130 KB body of zeros exhausts the process or the Durable Object. | D3. One counting read loop for identity and gzip. | fixed 156e1356 |
| N2 | high | C | `server/src/bucket-blob-store.ts:325-333`, `server/src/blob-store.ts:232-237` | A presign-uploaded object has no metadata, so `sweepOrphans` reads `createdAtMs: 0` and deletes it regardless of grace. The referenced set is snapshotted once before the paged loop. | Re-check the reference index per candidate before delete; take age from the backend's last-modified time; skip when neither exists. | fixed 55f9d816 |
| N3 | medium | C | `server/src/s3-blob-store.ts:110-132`, `server/src/sigv4.ts:245`, `server/src/blob-handlers.ts:343-354` | The presigned PUT signs only `host`. `maxBlobBytes` is bypassed, and an actor who knows a file's hash uploads garbage under that id; other clients then skip their upload. | Sign `content-length` and `x-amz-checksum-sha256`; §5.9.3 first; both clients send the headers. | fixed 55f9d816 |
| N4 | medium | C | `server-workers/src/realtime-do.ts:455-467`, `:367-370` | `#rehydrated` is set before the awaited per-socket loop, and pull-only rounds call it outside the FIFO. A concurrent push fans out to an empty session set. | One rehydration promise awaited from every entry point. | fixed bb3b4d8e |
| N5 | medium | U | `server/src/realtime.ts:129-134`, `server-workers/src/realtime-do.ts:643-719` | Presence lives in hub memory; hibernation discards it while sockets stay open, and no `leave` is sent on a later close. | Persist each socket's published docs in the socket attachment and reload on rehydration. | open: the 16,384-byte attachment limit equals the presence document cap; needs a decision (smaller Workers cap, DO storage, or accept) |
| N6 | medium | U | `server/src/realtime.ts:556-560`, `core/src/stream.ts:85-96` | Socket round assembly doubles its buffer without bound. Presence text frames are parsed twice before the 16 KiB cap, which counts UTF-16 units. | D3 limit in the scanner path; one parse; count bytes. | fixed 156e1356 |
| N7 | medium | U | `server/src/realtime.ts:806-813`, `:977-997`, `server-workers/src/realtime-do.ts:766-776` | No bound on sent-but-unacked deltas or send buffering. | Track unacked deltas per session; past a limit switch to the existing `catchup-required` wake (§8.2). | fixed bb3b4d8e |
| N8 | medium | U | `server/src/blob-handlers.ts:183-193`, `server/src/bucket-blob-store.ts:279-281`, `server-hono/src/index.ts:132-150` | Inline blob delivery reads bytes before authorization, buffers them whole and recompresses them. `server-workers.md:66` says the route re-authorizes before it reads. | `has`, authorize, then read; stream through the segment store's `open` shape; serve identity. | fixed 55f9d816 |
| N9 | medium | U | `server/src/realtime.ts:131-134`, `:445-451`, `:1088-1100` | Presence is keyed by session; §8.6.1 keys it by `(actorId, clientId)`. A stale socket's close fans `leave` for a client that reconnected. | On publish, drop docs held by other sessions of the same identity on that key. | fixed bb3b4d8e |
| N10 | medium | U | `server-hono/src/admin.ts:129-140`, `:518-536`, `server-workers/src/index.ts:385-401` | Admin POSTs have no cross-site check; the realtime upgrade has no `Origin` check or option. `guide-auth.md:256` says a cookie session needs nothing extra. | Reject cross-site POSTs in the admin guard; add an allowed-origins option to the upgrade; correct the auth guide. | fixed bb3b4d8e |
| N11 | low | U | `server/src/realtime.ts:1082-1101`, `:219-234` | Presence fanout rebuilds every session's scope-key set per publish. | Compute a session's scope keys when registrations are assigned. | fixed bb3b4d8e |
| N12 | low | U | `server-workers/src/realtime-do.ts:455-467`, `server/src/realtime.ts:1223-1252` | Each hibernation wake rehydrates all sockets sequentially: four storage calls and one resolver call per socket. | Hoist partition-level calls; pass the read record into `loadRegistrations`. | fixed bb3b4d8e |
| N13 | low | R | `server/src/bucket-blob-store.ts:148-150`, `server/src/s3-object-bucket.ts:117-120` | `new URL()` normalizes the raw partition in S3 keys: `a/../victim` resolves into another partition's namespace, `acme#eu` collapses a partition to one object. | Percent-encode each key segment in `urlFor`. | fixed 55f9d816 |
| N14 | low | U | `server/src/bucket-segment-store.ts:448-464`, `server/src/pull.ts:449`, `server-hono/src/index.ts:132-150` | Identical segment bytes are re-uploaded and byte-compared per bootstrap pull, and recompressed per download. | HEAD before PUT and compare size or checksum; cache the encoded variant by `(segmentId, encoding)`. | partial 55f9d816: publish fixed; per-download recompression left as is |
| N15a | low | U | `server-hono/src/index.ts:270`, `server/src/blob-handlers.ts:90-96` | Blob PUT enforces the cap after buffering the whole body. | `Content-Length` precheck and counted read. | fixed 55f9d816 |
| N15b | medium | C | `server/src/realtime.ts:815` | `sendHeartbeat` has no caller; §8.5 heartbeats are never sent by any shipped host. | Drive it from the hub on a host-configured interval; DO alarm in the Workers host. | fixed bb3b4d8e, f2c37b9c |
| N15c | low | U | `server/src/handler.ts:1053-1071` | Both HTTP adapters buffer the whole response; §1.4 requires streaming capability. | Addressed with S2. | partial 156e1356: read memory bounded; the serve gate still buffers the response |
| N15d | low | U | `server/src/signed-url.ts:289-290` | `atob` throws on a malformed token; the contract says every failure is `sync.forbidden`. | Catch and map. | fixed 55f9d816 |
| N15e | low | U | `server-hono/src/index.ts:327-331` | The blob signed-URL response drops the handler's `Cache-Control: private` and `Vary`. | Forward the handler's headers. | fixed 55f9d816 |

Unconfirmed leads: silent delta loss if Bun's `ws.send` drops past its
backpressure limit; SigV4 `canonicalPath` leaves `:@+=` raw; `hub.connect`
reads the max sequence before adding the session; rehydration subrequest
limits; no FIFO deadline for a hung host callback; frames dropped before
`hub.connect` resolves in the documented Bun wiring; blob read authorization
uses write variables.

Checked and sound: the native segment token (MAC before parse, constant-time
compare, `exp`/`seg`/`sd`/`aud`), §5.5 re-authorization per request, blob
download fail-closed without a reference index, server-side hash on direct
upload, admin guard on every route, admin page escaping.

### 4.4 Server storage (`packages/server/src`)

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | high | R | `sqlite-storage.ts:225`, reads at `:1068`, `:1502`, `:1767`, `:1814`, writes at `:866`, `:1927`, `:1961`, `:1978`, `:1995` | Non-transaction reads and five writes use the connection of an open push transaction without the write queue. A bootstrap reads rows that are then rolled back; `putClientRecord` is undone by another request's rollback. Needs an I/O await inside the transaction. | Route the five writes through `#serializeWrite`; queue reads behind the transaction tail. | fixed c5f8a838 |
| D2 | high | C | `postgres-storage.ts:2854-2916`, `:3387-3411`, `:2598`; adapter at `server-storage-reference.md:122-124`, `server/README.md:1237` | Five statements read `rowCount` from a bare `UPDATE`/`DELETE`. The documented Bun.sql adapter returns `rows.length`, which is 0. Reactions never run; `eraseScopeValueHistory` reports done after one step. pglite hides it. | Add `RETURNING` and count rows; delete `rowCount` from `PgQueryable`. | fixed c5f8a838 |
| D3 | medium | C | `sync_push_results` DDL in three backends, `postgres-storage.ts:685-694`, `push.ts:1954-1974` | No code deletes idempotency results, and stored conflicts keep `serverRow` after a scope erase. SPEC lines 1607 and 1654 contradict each other. | D4. | fixed c5f8a838 |
| D4 | medium | U | `d1-storage.ts:2322-2381`, `:441-460`, `relational-rows.ts:697`, `:748` | One bind per scope value; D1 caps a statement at 100. A subscription with 92 values fails every pull of the request. | Bind values as one JSON array (`json_each`). | fixed 025d6b00 |
| D5 | medium | R | `postgres-storage.ts:2446-2479` | `begin()` awaits a promise only the transaction callback resolves. If the executor cannot open a transaction, every push hangs and the error is an unhandled rejection. | Reject `ready` from the same `.catch`. | fixed c5f8a838 |
| D6 | medium | R | `relational-rows.ts:696-699`, `sqlite-dialect.ts:64-65` | With two or more scope values the SQLite planner walks `sync_row_scopes_by_row`: 0.07 ms for one value, 19 ms for two, on 300k rows. | Drop that index from `SQLITE_DDL`; verify the plans with `EXPLAIN` in a test. | fixed 025d6b00 |
| D7 | medium | U | `d1-storage.ts:350-396`, `:640-716` | A D1 push issues two to three sequential round trips per operation. | `prefetchRows` on `D1Transaction` as one `db.batch`. | fixed 025d6b00 |
| D9 | low | U | `postgres-storage.ts:2586-2589`, `sqlite-storage.ts:1207-1211`, `d1-storage.ts:1886-1897` | Pruning deletes scope entries by a predicate that scans the partition's whole scope index under the write lock. | Delete by key derived from the `sync_changes` rows being pruned. | fixed 025d6b00 |
| D10 | low | U | `postgres-storage.ts:3285-3289`, `sqlite-storage.ts:2014-2019`, `d1-storage.ts:2552-2558` | A client record at cursor -1 holds the pruning floor at -1. | `AND cursor >= 0` in the floor query. | fixed c5f8a838 |
| D11 | low | U | `postgres-storage.ts:3520-3525`, `:3669-3683`, `:3332-3338` and SQLite/D1 twins | `listCommitMetadata`, `scopeActivity` and `listRowsReferencingBlob` issue one statement per row. | One grouped statement per page. | fixed 025d6b00 |
| D12 | low | U | `sqlite-lease-store.ts:132-144`, `:44-74` | `revoke` is two autocommit statements and `get()` ignores the revocation table. | Derive `revoked` from the revocations table. | fixed c5f8a838 |

Unconfirmed leads: the Postgres plan for multi-value scans; D1 batch size for
a 500-operation commit; cross-request coupling in batched reads; `NOTIFY`
after `COMMIT` can be lost; erased rows remain in cached segments until TTL;
`pgliteExecutor.query` bypasses its transaction FIFO.

Checked and sound: partition filtering on every statement, Postgres
`commitSeq` allocation under the partition row lock, the idempotency race,
staged-write ordering and parameter chunking, pruning atomicity.

### 4.5 TS client (`packages/web-client/src`)

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | critical | C | `multi-tab.ts:191-203`, `:471`, `:641`, `:743-763` | `res` carries no recipient and `reqId` counts from 1 per follower. One follower's reply settles another's call with the same id. | `to` on `res`, dropped when it does not match; bump the multi-tab protocol version. | fixed 6831597b |
| T2 | high | R | `client.ts:5439-5442`, `:5256-5261`, `:5306-5311`, `:6128-6145` | A realtime delta applies to a subscription at cursor -1 and its `SUB_END` marks it bootstrapped with a fraction of its rows. | Add `sub.cursor < 0` to one shared skip predicate; treat the skip as a drop. Rust parity; conformance scenario. | fixed 24ed7c61 |
| T3 | high | R | `client.ts:6400-6449`, `:6357-6379`, `apply.ts:157-160` | Rollback of a rejected commit restores the before-image captured at `mutate` time, though a server write to that row landed since. §7.2 requires the last server-delivered base. | Re-capture pending images for affected rows inside `#replayOutbox`. | fixed 03702c25 |
| T4 | high | R | `apply.ts:278-290`, `:302-343`, `client.ts:3331`, `:6233` | Eviction and revocation purge delete rows another live subscription still covers; the survivor keeps claiming completeness. | Exclude rows matched by any other active subscription's effective scopes on that table. Both cores; conformance scenario. | fixed 24ed7c61 |
| T5 | high | R | `client.ts:4529-4530`, `:2288-2299`, `realtime-supervisor.ts:328-347` | A round failing with `network`/`connect` schedules nothing and latches the supervisor offline. The pending edit is not pushed until the next local write. | The supervisor uses the host connectivity signal only; resume calls `syncUntilIdle`. | fixed 6cbc6721 |
| T6 | high | R | `client.ts:4380-4388`, `:2685-2710` | One staged blob the server refuses fails every round before push and pull; no API removes it. | A non-retryable refusal is that blob's outcome: clear the upload, reject its commits through the existing drop path. §5.9.7; Rust parity. | fixed 6cbc6721, a78cb90b |
| T7 | high | R | `outbox.ts:282`, `apply.ts:135`, `apply.ts:583`, `remote.ts:366` | A schema with encrypted columns and no `encryption` config skips the crypto seam: plaintext is pushed, ciphertext is stored as the value. | Delete the `encryption !== undefined &&` conjunct at the four sites. | fixed f698148c |
| T8 | medium | R | `http.ts:120-139`, `client.ts:4660-4679`, `sync-scheduler.ts:88-114`, `worker-core.ts:233-251` | No fetch carries an abort signal; the idle deadline aborts only a socket round; both host loops treat retryable `sync.idle_timeout` as terminal. | One `AbortSignal` from the drive deadline into transport calls; host loops queue a background intent on a retryable rejection. | fixed 6cbc6721 |
| T9 | medium | U | `invalidation.ts:162-168`, `client.ts:6233-6234` | A bulk scoped delete records only the scope keys of the subscription's own variables; a live query keyed by another variable keeps publishing the deleted row. | Fall back to table-level invalidation when the map does not name every variable. Rust parity. | fixed 24ed7c61 |
| T10 | medium | R | `client.ts:3175-3183`, `:5155-5157`, `:6132-6145`, `state.ts:84-85` | `unsubscribe()` during a round is undone by that round's `SUB_END` (`INSERT OR REPLACE`). | `UPDATE ... WHERE id=?`; skip the section when the row is gone. | fixed 24ed7c61 |
| T11 | medium | U | `reactive-store.ts:610-632`, `:545-550`, `:1224-1235` | Recovery re-reads only `blocked` entries; a read rejected by a leader handover is already `error` and stays there. | Request a read for every active entry on each transition to `leader` or `follower`. | fixed 6831597b |
| T12 | medium | U | `multi-tab.ts:1443-1460` | A promoted follower whose core fails to start swallows the error and never contests the lock again. | Publish the error through `onStateChange`; re-issue `lock.acquire`, bounded. | fixed 6831597b |
| T13 | medium | U | `multi-tab.ts:340-351`, `:708-712`, `:890-910` | A newer tab sends one `hello`, deposing one older leader; a second older tab promotes and never hears it. | One `hello` per newly seen older leader. | fixed 6831597b |
| T14 | medium | R | `apply.ts:157-160`, `client.ts:5895-5911`, `outbox.ts:93-96` | Every applied change scans and JSON-parses the whole outbox: 500 commits take 52 ms with an empty outbox and 3.6 s with 4,000 pending. | Store `tbl` and `row_id` on `_syncular_outbox_before_images` with an index. | fixed 03702c25 |
| T15 | medium | R | `query-guard.ts:28-34`, `:153-160` | `PRAGMA` assignments pass the read-only guard; the `WITH` scanner disagrees with SQLite's tokenizer. | D5. | fixed f698148c |
| T16 | medium | U | `apply.ts:380-402` | A `sqlite` image is accepted for a table with encrypted columns, so a server writes unauthenticated values into them. | Reject in `applySqliteSegment`. Rust parity check. | fixed f698148c |
| T17 | low | U | `client.ts:5247-5283` | Every `SEGMENT_REF` downloads concurrently and the prefetch map is never pruned. | Bound concurrency; drop each entry after apply. | fixed f2c37b9c |
| T18 | low | U | `worker-core.ts:468`, `client.ts:2410-2423` | Worker mode builds a full diagnostics snapshot per revision. | Build it on request. | fixed f8976d10 |
| T19 | low | U | `reactive-store.ts:958-971` | The outcome journal is re-read in full on every change. | Read the changed entries. | partial 6831597b: refreshes collapse into one read; the event carries no key |
| T20 | low | U | `multi-tab.ts:376-386` | Every request and reply, including keys and `Authorization` headers, is broadcast to all same-origin tabs. | Covered in part by T1; a per-follower port is recorded under next-up. | open |
| T21 | low | U | `worker-host.ts:865` | `config.worker()` throws outside the `try`, leaking the leader lease. | Move it inside. | fixed 6831597b |
| T22 | low | U | `previous-version.ts:609-614` | Capture starts at `rowid > -1` and omits negative integer primary keys. | Start below the minimum. | fixed f8976d10 |
| T23 | low | U | `wasm-database.ts:176-196` | SQL is compiled on every `exec`/`query`, per row on rows-segment import. | Statement cache keyed by SQL text. | fixed f8976d10 |

Unconfirmed leads: `close()` does not wait for an in-flight HTTP round;
`COMMIT` changes are not checked against the section's table; sqlite image
hardening (`trusted_schema`, value types); encrypted `blob_ref` columns skip
blob bookkeeping; bfcache leaves a zombie leader; a worker `error` after init
leaves in-flight calls unknown; a failed window release is never retried.

Checked and sound: outbox append and optimistic write in one transaction,
commit id reuse across retries, cursor persistence only at `SUB_END`, content
address verified before apply, lock-before-core on every multi-tab path.

### 4.6 Rust client (`rust/crates/client/src/client.rs`)

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | high | C | `:15717-15747`, `:18033`, `:19299-19356` | `evict_unit` does not cancel the prepared round. A unit evicted and re-added mid-round is marked complete without its earlier rows. | Call `cancel_sync_round()` as `unsubscribe` does. | fixed 24ed7c61 |
| R2 | high | C | `:14418-14425`, `:20791-20814`, `:15764-15792`, `:13817-13841` | Synced columns have no declared type and scope values bind as TEXT, so an INTEGER scope column never matches. Revocation purge, eviction and the first-page clear delete nothing; pinned-id exclusion fails on integer keys. | Bind scope values and pinned ids by the column's declared type, as `row_id_predicate` does. | fixed 24ed7c61 |
| R3 | medium | U | `:16025-16028`, `:18938-18940`, `:15026-15029` | With `retainFailedCommits`, an operation on a table the schema removed fails every round and makes its outcome unlistable. | Skip removed-table operations in `retain_failed_commit` and `attach_retained_rows`. | fixed 5c14eb5d |
| R4 | medium | U | `:18805-18807`, `:21502-21567`, `:19835-19836`, `:19894-19906` | Each acknowledged push rebuilds whole visible tables plus FTS; one acked row or retained conflict anywhere disables incremental import, so a bootstrap rebuilds per 1,024-row block. | Make both gates per table; reuse the keyed restore for the ack path. | fixed ae437fdb |
| R5 | medium | C | `:21321-21329`, `:17783-17785` | `has_acknowledged_rows` and `finish_sync_round` call `.expect()` on storage reads; a corrupt page aborts the host. | Return `Result` through `sqlite_failure`. | fixed 5c14eb5d |
| R6 | medium | C | `:11196-11217`, `:12490-12495`, `:14055` | `meta_set`/`meta_delete` discard errors and `meta_get` maps them to `None`. A failed security-preflight marker write goes unreported; a failed epoch read adopts the new epoch without a wipe. | The three helpers return `Result`. | fixed 5c14eb5d |
| R7 | medium | U | `:19958-19981`, `:20121-20253` | The sqlite image is written to the shared temp dir with default permissions and never swept; the chunk loop never ends when the scan count differs from `count(*)`. | End on a short chunk and compare counts; create the file 0600 beside the replica. | fixed 5c14eb5d |
| R8 | low | U | `:15475-15480`, `:15508-15518` | `subscribe`/`unsubscribe` do not raise sync-needed as TS does (`client.ts:3168-3183`). | Raise it unconditionally; pin the rule in SPEC. | fixed 5c14eb5d |
| R9 | low | U | `:16455-16458`, `:16511-16521` | A failed key-selector read is treated as "no stored key" and the commit is dropped as `client.encrypt_failed`. | Return `Result<Option<Row>>`; fail the round. | fixed 5c14eb5d |
| R10 | low | U | `:19714-19715` | A `COMMIT` decrypt failure reports `sync.invalid_request`; §5.11 names `client.decrypt_failed`. | Keep the identity. | fixed 5c14eb5d |
| R11 | low | U | `:19638-19656`, `:18726`, `:13510-13539` | Per-change `execute` re-prepares, `_syncular_acked_rows` has no `(tbl, id)` index, and `begin_coalesced_apply` deep-clones the outbox per 1,024 rows. | `prepare_cached`; one pinned-row set per frame. | fixed 5c14eb5d, ae437fdb |

Unconfirmed leads: `temp_dir()` on wasm and Android for image import; a delta
applied over an earlier failed delta; a payload-less upsert after an
unclassified encode error; the pinned-id bind limit; `reset_client_id` during
a round; malformed CRDT bytes into `yrs`.

Checked and sound: identifier quoting on every SQL site, outbox insert and
overlay in one savepoint, cursor and data in one transaction, content
addresses verified before use, no reachable panic from server frames.

### 4.7 Rust transport, FFI, command, authority

| Id | Sev | Ev | Where | Defect | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | high | C | `ffi/src/lib.rs:133-135`, `:399-412`, `client/src/native_transport.rs:263-265` | The C ABI builds its transport without a wake callback; `poll_event` only pops the queue. Deltas and disconnects are processed only on the next host command. | Pass a notify that pushes one wake event; bindings answer it with a command. | fixed c4e48fe3: core; f7d56e4d: bindings (Kotlin and Flutter not run locally) |
| F2 | high | C | `authority/src/lib.rs:201-247`, `:282-316`, `authority/src/attach.rs:298-300` | A lost undo response followed by a retried `attach` counts `cached` uploads as done, drops the local tables, and the server already deleted the rows. TS `local-authority.ts:440-521` shares the logic. | D6. Both cores; conformance scenario. | fixed 3d3f47e9 |
| F3 | medium | R | `client/src/query_guard.rs:13`, `:189-203` | `WITH x$select AS (SELECT 1) DELETE FROM tasks` passes the guard and runs; `PRAGMA query_only = ON` passes. | D5. | fixed f698148c |
| F4 | medium | C | `client/src/native_transport.rs:2698`, `:1370-1375` | An established socket has no silence detection. | Give the poller wait a timeout from transport config; treat silence as loss. Depends on N15b. | fixed bb3b4d8e, f2c37b9c |
| F5 | medium | C | `client/Cargo.toml:87`, `authority/Cargo.toml:23-25` | The client's `crdt-yjs` feature does not forward to the authority; every CRDT commit under local authority is rejected. | `crdt-yjs = ["dep:yrs", "syncular-authority?/crdt-yjs"]`. | fixed c4e48fe3 |
| F6 | medium | C | `client/src/crdt.rs:26`, `:59-91` | `Doc::new()` uses byte offsets; the contract is UTF-16 code units. "éa" plus insert at 2 gives "éax" in TS and "éxa" in Rust. | `OffsetKind::Utf16`; non-ASCII conformance case; `u32::try_from` for the index. | fixed c4e48fe3 |
| F7 | medium | U | `client/src/client.rs:11511-11515` | `SELECT *` returns the physical `_syncular_version` column; §2.4 says it never enters star projections. | Strip it in `query_connection`. | fixed c4e48fe3 |
| F8 | medium | U | `client/src/native_transport.rs:2126-2173`, `client/src/round.rs:373-424` | A segment or blob body has no size bound unless the host sets `maxResponseBytes`. | Enforce the descriptor's `byteLength` as the cap for segment and blob bodies; §5.4 wording. TS parity check. | fixed 55f9d816, a78cb90b, f2c37b9c |
| F9 | medium | U | `client/src/remote.rs:291`, `:381`, `:438` | `SyncRemoteClient` marks every transport failure retryable. | Take `retryable` from the error details when present. | fixed c4e48fe3 |
| F10 | low | U | `command/src/lib.rs:902-910`, `:405`, `:262-282` | Parsers coerce malformed fields to absent: `setWindow` with wrong-typed units evicts every unit; `baseVersion: "7"` drops the conflict check. | Reject wrong-typed values with `sync.invalid_request`. | fixed c4e48fe3 |
| F11 | low | U | `authority/src/lib.rs:310-315` | Undo commit ids are deterministic, so a rejected undo replays its rejection forever. | D6. | fixed 3d3f47e9 |
| F12 | low | U | `ffi/src/lib.rs:378`, `:407`, `rust/ffi.h:39`, `:54-55` | `command` forms `&mut Handle` while `poll_event` forms `&Handle` from the same pointer; the header states a different threading contract and a stale event list. | Keep the queue outside the mutable part; correct `ffi.h` and the comments. | fixed c4e48fe3 |
| F13 | low | U | `client/src/native_transport.rs:2015-2022`, `:2079-2084` | A deadline expiring during a socket send surfaces `sync.transport_failed`, not the typed timeout. | Record the round failure before `shutdown()`. | fixed c4e48fe3 |
| F14 | low | U | `command/src/lib.rs:137-150` | `client_err` splits on `:`; a colon-less identity becomes `client.failed`. | Route through `ClientError::from(String)`. | fixed c4e48fe3: code kept, message unchanged |
| F15 | low | U | `authority/src/push.rs:705-707` | An unreadable idempotency record fails the whole round; §6.3 requires a per-commit `sync.idempotency_cache_miss`. | Map to the §6.3 rejected frame. | fixed 3d3f47e9 |

Unconfirmed leads: no `catch_unwind` at the C ABI; a partial request left on
a live socket after a deadline between chunks; `create` over a live client
keeps the old socket; a failed `COMMIT` leaves the authority transaction open.

Checked and sound: TLS validation, credential isolation on redirects and
signed URLs, static transport error messages, one absolute establishment
deadline, FFI string ownership, `ffi.h` signatures.

### 4.8 Simplifications

| Id | Change | Removes | Status |
| --- | --- | --- | --- |
| X1 | Delete the dead wire-version branches (C5). | 17 branches, two optional fields | fixed 466a9813, 156e1356 |
| X2 | One SQL module for the SQLite and D1 backends behind a `run(sql, params)` seam; one shared admin read surface for all three. | Most of `d1-storage.ts` (2,964 lines) or `sqlite-storage.ts` (2,418 lines); the class of one-backend-only fixes | fixed cef0dc01: net -1,445 lines; the Postgres admin surface stays separate |
| X3 | One bootstrap decision in `pull.ts` (`prepareSections` and `preparedSection` decide separately today). | The seam behind S3, S4, S5 | fixed 156e1356 |
| X4 | One row-ownership predicate for eviction, purge, first-page clear and invalidation, in both cores. | The seam behind T4, T9, R2 | fixed 24ed7c61 |
| X5 | One optimistic base store in the TS client, updated by every server write. | Three stores with different rules; the outbox scans of T14 | declined: touches retained rows, authority and unique-conflict evidence for a 40-line fix |
| X6 | Ask SQLite whether a statement is read-only (D5). | Two lexical scanners | fixed f698148c: PRAGMA is refused by prefix and node:sqlite keeps a small check |
| X7 | A typed error enum at the Rust storage and codec boundary. | `starts_with` branching; R9, R10, F14 as a class | declined: about 700 edits for a net change between -50 and +10 lines; six sites branch on error text |
| X8 | One rollback snapshot type in the Rust client. | About ten hand-rolled snapshot sites | fixed ae437fdb |
| X9 | Move the test modules out of `client.rs` (12,490 of 24,101 lines). | A 24k-line file | fixed b151b552 |
| X10 | Split `docs/RELEASE.md` into the runbook and a release-notes file. (The review also claimed the RFC files carry no status line; they all do.) | A 3,898-line runbook | fixed a5470c66 |

Not in this program: aligning the Rust base/visible table model with the TS
before-image model. It is the largest remaining source of cross-core drift
and needs its own RFC.

## 5. Work plan

One checkout, branch `core-review`, three lanes by file ownership so agents do
not collide: TS server (`packages/server*`), TS client and core
(`packages/web-client`, `packages/core`), Rust (`rust/`). A cross-core task
holds two lanes. Each task is one fresh agent with a brief that points at the
finding ids here. The coordinating session reviews each diff, runs the gates
between waves and commits.

| Wave | Task | Findings | Lanes | Model |
| --- | --- | --- | --- | --- |
| 1 | Pull, scopes, limits | S1 S2 S3 S4 S5 S8 S15 N1 N6 N15c X3, C5 server sites | server | Opus |
| 1 | Codec parity | C1 C2 C5 X1, D2 codec side | core, Rust `ssp2` | Opus |
| 1 | Multi-tab and reactive store | T1 T11 T12 T13 T19 T21 | client | Opus |
| 2 | Push path | S6 S7 S9 S10 S11 S12 S13 C3 C4 | server, Rust `authority` | Opus |
| 2 | Client round fencing and ownership | T2 T4 T9 T10 R1 R2 X4 | client, Rust `client` | Opus |
| 3 | Storage correctness | D1 D2 D3 D5 D10 D12 | server | Opus |
| 3 | Client rollback base and liveness | T3 T14 T5 T8 X5 | client | Opus |
| 3 | Rust client robustness | R3 R5 R6 R7 R8 R9 R10 R11 | Rust `client` | Sonnet |
| 4 | Blobs and segments | N2 N3 N8 N13 N14 N15a N15d N15e T6 | server, client, Rust | Opus |
| 4 | Realtime hosts | N4 N5 N7 N9 N10 N11 N12 N15b F4 | server, Rust transport | Opus |
| 4 | FFI, command, authority | F1 F2 F5 F6 F9 F10 F11 F12 F13 F14 F15 | Rust, `local-authority.ts` | Opus |
| 5 | Query guard and small client items | T7 T15 T16 T17 T18 T22 T23 F3 F7 F8 X6 | client, Rust | Sonnet |
| 5 | Storage performance | D4 D6 D7 D9 D11 | server | Sonnet |
| 5 | Rust overlay performance | R4 | Rust `client` | Opus |
| 5 | Mechanical simplifications | X9 X10, S14 if Q3 stands | Rust, docs | Sonnet |
| 6 | Structural simplifications | X2 X7 X8 | server, Rust | Opus |

Rules for every task: SPEC first for behavior on the wire or the client
surface; both cores plus a conformance catalog scenario for semantics; a test
beside each fix; docs and changelog with user-visible changes; no push.

## 6. Next up (not in this program)

1. **Conformance catalog.** It missed every cross-core drift item in §4.1 and
   F6. Add non-ASCII, non-finite, overlapping-subscription and
   multi-follower cases, then audit which SPEC MUSTs have no scenario.
2. **Bindings** (`bindings/kotlin`, `swift`, `flutter`, `react-native`):
   answer the F1 wake event, check threading against the corrected `ffi.h`,
   and run each `check.sh`.
3. **Docs against behavior.** A pass over `apps/docs/src/content` for claims
   the code does not keep; the review found four by accident (S1, D2, N8,
   N10).
4. **`packages/typegen`** (19k lines, unreviewed): scope column types,
   reference declarations, what each emitter guarantees.
5. **`packages/react` and `packages/tauri`**, then the demos and
   `create-app` output that new users copy.
6. **Local row model.** One model for both client cores (see §4.8).
7. **Unconfirmed leads** listed under each area: confirm or dismiss each.
8. **Per-follower message ports** in multi-tab (T20), which stops broadcasting
   keys and headers to every same-origin tab.

## 7. Program log

- 2026-11-10: wave 1 landed `6831597b` (multi-tab), `466a9813` (codec),
  `03702c25` (client rollback base, pulled forward from wave 3).
- 2026-11-10: the wave 1 server task stopped once on an account limit,
  resumed, and landed as `156e1356`. New code `sync.limit_exceeded`; defaults
  16 MiB request, 500 subscriptions, 1,000 scope values, 100 watches.
- 2026-11-10: wave 1 gate green on `16585749`: typecheck, lint, knip,
  `test:main` (3,834 pass), `test:isolated`, `test:downgrade`,
  `verify:runtimes`, Rust workspace tests and clippy. Wave 2 started: push
  path and authority parity, client round fencing and row ownership, storage
  correctness.
- 2026-11-10: waves 2 and 3 landed in part: row ownership and round fencing
  (`24ed7c61`), Rust client robustness (`5c14eb5d`), client liveness
  (`6cbc6721`), storage correctness, push path and authority parity, FFI wake
  and command parsing. The catalog holds 284 scenarios.
- 2026-11-10: waves 4 and 5 landed: authority attach (`3d3f47e9`), shared
  SQLite and D1 SQL (`cef0dc01`), query guard and bundle size (`f698148c`),
  realtime hosts (`bb3b4d8e`), storage performance (`025d6b00`), the JSON
  rule on raw text (`f8976d10`), binding poll loops (`f7d56e4d`), the
  release-notes split (`a5470c66`), Rust overlay and rollback (`ae437fdb`),
  blobs (`55f9d816`), Rust parity (`a78cb90b`), heartbeat watchdog and
  download caps (`f2c37b9c`). The catalog holds 290 scenarios. Web bundles:
  client 165,007 and worker 185,969 bytes, under the original ceilings.
- 2026-11-10: final gate green on `9da02bed`: `bun run check` (4,042 tests
  in the main lane, the multi-tab lane, the downgrade test, runtime
  verification), the Rust workspace tests, clippy, `cargo fmt`, the Tauri
  plugin check and the React Native tests. Not run locally: the Kotlin and
  Flutter binding checks and the browser test lane. Production source
  against `main`: `server` -559 lines, `web-client` +412, `server-workers`
  +54, `server-hono` +15, `core` +8.

Follow-ups found while fixing:

- **Conformance shim staleness.** The harness reuses the shim binary on disk
  without rebuilding it, so local Rust lanes can test old code.
- **Subscription cap and windows.** A client sends its complete
  subscription list on every pull (§4.7), so an app holding more than
  `maxSubscriptionsPerRequest` subscriptions fails every pull. Check consumer
  apps before release.
- **N15c remainder.** Bound the buffered response: a per-response inline-byte
  budget that switches to `SEGMENT_REF`, or let the server end a bootstrap
  section early with a resume token (§4.2, §4.7).
- **Authority limits.** The Rust authority has no allowed map and none of the
  four limits; the wildcard-fence scenario skips it.
- **Remote docs.** `docs/REMOTE.md` and `guide-remote-operations.md` do not
  mention the watch cap or serialized refreshes.
- **Worker bundle ceiling.** `authority-bundle.test.ts` caps the worker at
  186,000 bytes and the margin is a few dozen bytes.
- **Image temp file.** A crash between staging and removal leaves a
  `.syncular-image-*.tmp`; nothing sweeps it at startup.
- **Code size.** Through wave 3 the fixes added about 1,100 production lines
  net and 1 to 2.5 KB to the web bundles. The remaining program carries a
  size rule: a task that grows a bundle or a package's production line count
  names the removal that offsets it, and bundle ceilings are not raised.
- **Unacked-delta limit and bursts.** One push batch of more than
  `maxUnackedDeltas` (256) commits sends connected readers into one
  catch-up pull. The bench hub raises the limit to keep measuring deltas.
- **Bucket sweep race.** The bucket store's DELETE has no `If-Match`; a
  re-upload between the last reference check and the delete is lost.
- **Presigned uploads carry no media type**, so inline downloads serve them
  as `application/octet-stream`.
- **Whole-table rebuilds left in the Rust client** where the rows are known:
  outcome resolution, `set_retain_failed_commits`, bootstrap completion.
- **Binding tests have no socket.** No binding test covers a remote change
  arriving end to end; Kotlin and Flutter changes ran only in CI.
- **UNIQUE text match.** The Rust client classifies a unique violation by
  SQLite's message text; only a string reaches that site (`write_row`).
