# Syncular Standout Sync Plan

## Goal

Make Syncular stand out as the server-authoritative sync system for apps that
need local SQL, auditable authorization, high-performance offline replicas, and
trustworthy replication.

This plan assumes protocol and library changes are acceptable. Because the repo
is moving Rust-first, do not preserve old JS/client protocol behavior as a
compatibility branch unless explicitly required for a migration release.

## Product Thesis

Syncular should not compete only on "offline-first works." It should compete on
properties that are hard to bolt onto existing sync systems:

- Verifiable server-authoritative replication.
- Fast local SQLite replicas with generated apply/read paths.
- Explicit, inspectable scope-based authorization.
- Hybrid structured row sync plus first-class encrypted CRDT field islands.
- Operable sync: traceable commits, snapshots, clients, errors, and performance.

The sharp external claim should become:

> Syncular gives apps local SQL with server authority, auditable scopes, and
> verifiable sync history.

## Triage Summary

| Item | Recommendation | Novelty | Confidence | Main Risk |
| --- | --- | --- | --- | --- |
| Verifiable sync log | Pursue first, but start with integrity roots before full proofs | High | Medium | Designing proof semantics for scoped snapshots incorrectly |
| Binary protocol v2 | Pursue after measurement prototype | Medium-high | High | Complexity without enough apply-time improvement |
| Adaptive bootstrap and Sync QoS | Pursue incrementally | Medium | High | Product/API complexity and confusing readiness states |
| First-class local read models | Pursue as opt-in generator feature | Medium | Medium-high | Hidden write amplification and projection drift |
| Hybrid row sync plus CRDT field islands | Pursue as flagship positioning and targeted protocol polish | High | High | Blurring row-sync and editor-realtime expectations |
| Offline auth leases | Design now, implement later | Medium-high | Medium | Security model can become misleading or unsafe |
| Rust protocol kernel | Pursue as enabling infrastructure | Medium | High | Duplicate TypeScript protocol definitions for too long |

The most defensible sequence is:

1. Protocol fixtures and a Rust protocol kernel.
2. Verifiable sync roots over the existing protocol.
3. Binary v2 proof-of-performance for one generated table.
4. Adaptive bootstrap readiness states.
5. Opt-in local read models.
6. CRDT stream polish.
7. Offline auth leases.

This keeps the first work items grounded in correctness and measurement instead
of jumping straight into new public APIs.

## Progress Log

- 2026-05-19: Started protocol fixture baseline. Added a checked-in
  TypeScript-encoded `binary-sync-pack-v1` combined response fixture and a Rust
  decoder contract test under `syncular-runtime`, plus a TypeScript encoder
  fixture test in `packages/core`. This is the first slice of "protocol
  fixtures and compatibility tests for current JSON/binary sync."
- 2026-05-19: Extended the fixture baseline to `binary-table-v1` snapshot
  chunks. The fixture covers table metadata, typed scalar cells, JSON cells,
  and nullable values in both TypeScript and Rust decoders.
- 2026-05-19: Started the verifiable sync log slice. Server dialect schemas
  now include nullable `commit_digest` and `commit_chain_root` columns, and
  the normal push, external notification, and proxy oplog writers finalize
  each new commit by hashing the persisted commit row plus ordered
  `sync_changes` rows and chaining that digest to the previous partition root.
  Focused tests cover deterministic roots, persisted-change tamper sensitivity,
  old SQLite schema migration, synthetic external commits, and proxy oplog
  compatibility. Next: expose the digest/root metadata on pull responses and
  teach the Rust client to verify it before cursor advancement.

## Priority Roadmap

### P0: Verifiable Sync Log

Build a cryptographic integrity layer for commits, snapshot chunks, and
bootstrap responses.

#### Why

Syncular already has an append-only commit log, scoped changes, snapshot chunk
hashing, and audit surfaces. Adding chain roots and inclusion proofs makes the
system meaningfully different from a normal JSON sync API. Clients can verify
that received commits and snapshots are consistent with server history, and
edge/object-storage caches can serve chunks without becoming trusted data
authorities.

#### Sensecheck

This is the most strategically interesting idea, but it must be scoped
carefully. "Verifiable sync" can mean several different things:

- Integrity: the client can detect transport/storage corruption.
- Consistency: the client can detect that a response does not match a committed
  server history.
- Non-equivocation: two clients can detect if the server showed different
  histories.
- Full transparency: clients can audit global append-only history independent
  of the server.

Syncular should start with integrity and consistency, not full transparency.
The server remains authoritative, so the goal is not to make the server
untrusted. The useful product value is: clients, edge caches, object storage,
and debugging tools cannot accidentally or silently mutate sync history.

The part that is genuinely novel for this repo is not "hash a chunk." That
already exists in spirit. The novelty is tying commits, chunks, scopes, and
bootstrap manifests into one verifiable story that the Rust client enforces
before local apply.

#### What To Avoid

- Do not claim this prevents a malicious server from lying unless we add signed
  roots, external witnesses, or client gossip.
- Do not make clients verify every historical commit on every pull. Store
  checkpoints and verify incrementally.
- Do not start with per-row Merkle proofs. They add complexity before we know
  the product needs them.
- Do not let verification metadata become optional in the Rust-first path once
  the protocol version requires it.

#### Shape

- Add a canonical commit digest for every committed sync transaction.
- Add a partition-level commit chain root:
  `root_n = hash(root_{n-1}, commit_seq, commit_digest)`.
- Add snapshot manifests that include:
  - `asOfCommitSeq`
  - table name
  - scope digest
  - chunk refs
  - row range/cursor metadata
  - per-chunk hash
  - manifest root
- Return verification metadata in pull responses and chunk refs.
- Store the last verified root in the Rust client state.
- Fail loudly on digest/root mismatch.

#### Minimal Viable Version

The smallest useful version is:

- Commit digest:
  `hash(canonical(partition_id, commit_seq, actor_id, created_at, changes))`.
- Commit root:
  `hash(previous_root, commit_digest)`.
- Pull response includes `fromRoot`, `toRoot`, and digest metadata for returned
  commits.
- Snapshot chunk refs continue to include `sha256`, but are tied to a snapshot
  manifest digest.
- Client verifies all returned chunks and advances `verifiedCommitSeq`.

This does not yet prove that a snapshot contains every row in a scope. It does
prove that returned commits and chunks match the server's declared digest chain.

#### Strong Version

The stronger version adds:

- Snapshot manifests with chunk ordering, row cursor bounds, scope digest, and
  `asOfCommitSeq`.
- Signed root checkpoints using a server signing key.
- Console/audit route for root lookup by `commit_seq`.
- Optional root pinning in clients for high-security apps.

#### Server Work

- Extend sync metadata tables with commit digest/root columns or a side table.
- Compute digests inside the same transaction that writes `sync_commits` and
  `sync_changes`.
- Include snapshot manifest metadata during bootstrap.
- Add console views for commit root, digest, and verification failures.

#### Rust Client Work

- Verify sync-pack, snapshot manifest, and chunk integrity before apply.
- Persist verified roots and last verified `commit_seq`.
- Emit ordered native/browser events for verification failures.

#### Open Questions

- Do we want per-scope proof roots, or only partition-level roots plus scoped
  snapshot manifests?
- Should signed server roots be optional deployment hardening or always-on?
- How much proof data should be returned during normal incremental pull?
- How do we represent canonical JSON for row payloads across JS and Rust
  without accidental ordering or number-format drift?
- How does compaction/pruning interact with historical verification?
- Does a client need to verify revoked-scope clearing, or is that a separate
  auth-state guarantee?

#### Acceptance Criteria

- A test can tamper with a snapshot chunk body and the Rust client rejects it
  before apply.
- A test can tamper with commit order or commit contents and the Rust client
  rejects it before cursor advancement.
- Console can show digest/root information for a commit.
- Existing benchmarks show negligible overhead for normal incremental pulls.

### P1: Binary Protocol V2, Direct To SQLite

Make the Rust apply path schema-aware and avoid generic JSON materialization on
hot paths.

#### Why

Current binary snapshot chunks and binary sync packs already remove much of the
wire overhead. The performance plan shows decode is no longer the main cost;
SQLite apply and memory pressure are now the important targets. A protocol that
maps directly into generated bind plans is the next high-leverage step.

#### Sensecheck

This is a good engineering bet, but it is less novel than verifiable sync.
Many sync systems eventually build binary encodings. The reason it is still
worth doing is that Syncular's Rust-owned SQLite architecture makes direct bind
plans unusually valuable: we can skip generic row objects and bind typed cells
straight into prepared statements.

The risk is overbuilding a new wire format when v1 is already pretty good. The
only acceptable reason to keep v2 is measured improvement in release WASM or
native apply behavior. A feature-complete v2 that does not improve apply time
or memory should be deleted.

#### What To Avoid

- Do not add negotiated legacy branches beyond one current v2 path and clear
  unsupported-version failures.
- Do not make v2 depend on server/client schema being identical. Syncular's
  model allows server and client schemas to differ.
- Do not optimize tiny commits at the cost of larger bootstrap/catch-up apply.
- Do not hide JSON fallback in the Rust client once a schema declares v2
  support.

#### Shape

- Introduce `binary-sync-pack-v2`.
- Add schema fingerprint negotiation to pull requests.
- Encode incremental changes as:
  - table id
  - op tag
  - row id
  - row version
  - changed-column bitset
  - typed column values
  - optional scope dictionary ref
- Generate Rust apply plans per app schema:
  - stable column order
  - bind index map
  - upsert/delete SQL templates
  - nullable/default handling
- Keep encrypted fields as opaque typed payloads until field decryption.
- Keep clear failures for unsupported schema fingerprints.

#### Key Design Detail: Client Apply Schema

The schema fingerprint should describe the client apply shape, not merely the
server table shape. For each synced client table, the generated metadata should
include:

- table name
- stable apply column order
- primary row id column
- local version/server version columns
- nullable columns
- encoded column type tags
- encrypted/opaque columns
- generated SQL templates

The server can still use app-specific handlers and server schema mapping. The
binary response must be encoded to the client apply schema that the generated
client advertised.

#### Server Work

- Generate table encoders from server/client schema metadata.
- Encode incremental commit row groups with changed-column bitsets.
- Emit v2 only when the client requests it and schema fingerprints match.

#### Rust Client Work

- Decode v2 into borrowed typed cells.
- Bind directly into prepared SQLite statements.
- Track timing buckets separately:
  - sync-pack decode
  - bind-plan lookup
  - SQLite bind
  - SQLite step
  - conflict/local-row refresh

#### Measurement Gate

Keep only if release WASM improves at least one of:

- 500k bootstrap/apply time.
- Incremental pull/apply time.
- Peak memory during bootstrap or catch-up.

No change should stay without before/after numbers in the performance plan.

#### Acceptance Criteria

- One generated fixture table can roundtrip through v2 without `serde_json`
  row materialization on the Rust hot path.
- v2 is covered by JS encoder and Rust decoder fixture tests.
- Release WASM benchmark shows an apply or memory improvement large enough to
  justify the added protocol surface.
- Unsupported schema fingerprints fail with a clear protocol error.

### P1: Adaptive Bootstrap And Sync QoS

Turn bootstrap from "page through everything" into an explicit quality-of-service
contract between generated app client and server.

#### Why

Apps care about time-to-useful-local-SQL more than total sync time. Syncular
already has subscriptions, bootstrap state, limits, and phased startup docs.
Make this core protocol behavior so a client can become useful quickly and keep
large tables moving in the background.

#### Sensecheck

This is highly practical and likely to improve product feel, but it is less of
a technical novelty than verifiable sync. The value is in making Syncular
honest about what apps actually need: they do not need all local data before
they can render a useful first screen.

The repo already has pieces of this idea: subscription bootstrap state, limits,
snapshot pages, and docs that mention `bootstrapPhase`. The next step should
not be a large scheduler. It should be a small protocol/readiness model that
makes existing phase behavior visible and reliable.

#### What To Avoid

- Do not promise "ready" as a single boolean. Apps need multiple readiness
  levels.
- Do not let background tables starve forever.
- Do not create a scheduler that requires the server to understand UI routes.
- Do not mix bootstrap priority with authorization semantics.

#### Shape

- Add generated subscription metadata:
  - bootstrap phase
  - priority
  - first-screen requirement
  - optional row budget
  - optional stale-while-refresh policy
- Let clients send runtime budgets:
  - target first-ready deadline
  - memory budget
  - network mode
  - background/foreground state
- Server returns a bootstrap schedule:
  - critical tables first
  - deferred tables later
  - stable `asOfCommitSeq` per phase
- Client exposes readiness states:
  - `localOpen`
  - `criticalReady`
  - `allSubscribedReady`
  - `backgroundRefreshing`

#### Server Work

- Sort and page bootstrap work by requested phase and dependency order.
- Include phase completion metadata in pull responses.
- Add console visibility for slow phases and deferred subscriptions.

#### Rust Client Work

- Persist phase state.
- Emit readiness events across browser/native bindings.
- Avoid blocking first-screen query refresh on background tables.

#### Minimal Viable Version

- Add explicit phase metadata to subscription state.
- Apply existing bootstrap paging in phase order.
- Emit `criticalReady` after all phase-0 subscriptions have a valid cursor or
  completed bootstrap state.
- Continue background sync for later phases.
- Add tests proving a large phase-1 table cannot delay a small phase-0 table.

#### Acceptance Criteria

- Demo or fixture can bootstrap a small critical table before a large
  background table.
- Rust browser/native event streams expose phase readiness consistently.
- Console can show subscriptions by phase and current bootstrap progress.
- Existing pull correctness tests still pass when phases are absent.

### P1: First-Class Local Read Models

Generate and maintain local projections/materialized views during sync apply.

#### Why

Local SQL is Syncular's core product promise. For expensive repeated reads,
generated read models can make the Rust client feel much faster than generic
query-cache systems while staying deterministic and offline.

#### Sensecheck

This is a strong fit for Syncular because the product already commits to local
SQL as the hot path. It is also where the system can feel "unfairly fast" in
real apps: instead of asking every app to hand-tune local aggregate tables,
Syncular can generate and maintain them as part of sync apply.

The risk is that this becomes an ORM-like abstraction that tries to understand
arbitrary SQL. That would be too broad. Start with a small declarative model
for projections that can be maintained from known changed tables.

#### What To Avoid

- Do not infer read models automatically from arbitrary queries.
- Do not add hidden indexes/projections by default.
- Do not update projections outside the same local transaction as base row
  apply.
- Do not let apps write to generated projection tables.

#### Shape

- Add schema metadata for local-only read models.
- Generate migration SQL for read model tables/indexes.
- Generate apply hooks that update projections in the same local transaction as
  row apply.
- Support rebuild/check commands for corruption recovery and test assertions.

#### Candidate Use Cases

- Aggregate counters.
- Search/document index tables.
- Denormalized list rows for mobile views.
- "Unread", "assigned to me", or "recent activity" projections.

#### Constraints

- Read models must not bypass Syncular mutations for synced app tables.
- Read model maintenance must be deterministic and testable.
- Apps should opt in explicitly; no hidden default indexes or projections.

#### Candidate API Shape

Start with generated projection definitions rather than free-form SQL:

- `sourceTables`: tables that invalidate/maintain the model.
- `key`: projection primary key.
- `columns`: generated projection columns.
- `maintain`: generated Rust/TypeScript maintenance function.
- `rebuild`: full rebuild SQL/function for validation and repair.

The first implementation can target simple aggregate/count/read-list models.
Full arbitrary materialized SQL can wait.

#### Acceptance Criteria

- A generated read model updates transactionally during local mutation apply and
  remote pull apply.
- A rebuild command can verify and repair the projection.
- Tests prove projection tables reject direct app writes.
- Benchmarks show a meaningful win over the equivalent raw aggregate query.

### P1: Hybrid Row Sync Plus CRDT Field Islands

Make CRDT-backed fields a flagship capability rather than a hidden advanced
primitive.

#### Why

The repo already has generic CRDT document fields, Yrs storage, encrypted update
logs, checkpoints, materialization, queued APIs, and conformance. That is a
strong differentiator if presented as "structured server-authoritative rows,
with selected fields that merge like documents."

#### Sensecheck

This is already one of the strongest areas in the repo. The main work is not
inventing a new CRDT engine; it is making the boundary crisp:

- Rows remain server-authoritative.
- Selected fields can use CRDT semantics.
- The server stores and scopes encrypted update/checkpoint streams.
- Apps own editor schemas and UI adapters.

That boundary is valuable because most apps need structured business data and a
few collaborative fields, not a whole database implemented as CRDTs.

#### What To Avoid

- Do not imply Syncular is a low-latency multiplayer transport.
- Do not put TipTap, ProseMirror, Excalidraw, or editor schema semantics in
  core.
- Do not make CRDT pull behavior violate the normal scoped authorization model.
- Do not allow checkpoint compaction to erase the last known materialized state.

#### Shape

- Add protocol-level CRDT field hints to pull:
  - known state vector
  - checkpoint preference
  - max update bytes
  - materialization freshness
- Let server return compact CRDT update bundles for requested fields.
- Keep editor adapters outside core.
- Improve generated APIs around:
  - opening a field
  - observing remote updates
  - checkpointing
  - materializing preview values

#### Server Work

- Keep encrypted CRDT system handlers as first-class sync tables.
- Add optional compaction scheduling policy by stream.
- Surface stream size, checkpoint age, and prune status in console.

#### Rust Client Work

- Prefer state-vector delta pulls where possible.
- Keep no-blanking guards and ordered events.
- Add native/browser diagnostics for large update streams.

#### Product Positioning

The right claim is:

> Structured data sync stays server-authoritative. Document-like fields can
> converge with CRDT semantics and still use Syncular's scopes, encryption,
> storage, and operational tooling.

This avoids competing with pure CRDT databases on their terms while still
offering a feature they often cannot combine with server-authoritative SQL as
cleanly.

#### Acceptance Criteria

- Two clients can catch up a large CRDT field using less payload than replaying
  all historical updates after a checkpoint exists.
- Stream diagnostics expose update count, checkpoint age, encrypted/plain
  status, and last materialization state.
- State-vector hints never bypass scope checks.
- Existing no-blanking and convergence tests remain green.

### P2: Offline Auth Leases

Allow apps to keep accepting local mutations offline under explicit signed
authorization bounds.

#### Why

Syncular's scopes are already inspectable. Signed offline leases would make
that model more useful for mobile/field apps: a client can keep working while
offline, but its local authority is bounded and later auditable.

#### Sensecheck

This is useful but security-sensitive. It should not be implemented casually.
The concept is sound for apps where users need to work offline for hours or
days, but the messaging must be precise: a lease allows local intent capture
under previously granted authority. It does not guarantee the server will accept
the mutation later, and it does not remove final server validation.

The hard part is revocation. If an admin removes access while a device is
offline, the device cannot know immediately. The lease expiry is the maximum
revocation delay the product is willing to tolerate. That must be explicit.

#### What To Avoid

- Do not call leased mutations "authorized" until the server accepts them.
- Do not make leases unlimited or silently refreshable without server contact.
- Do not let leases encode broad wildcards unless an app explicitly opts in.
- Do not allow lease validation failures to discard local user intent.

#### Shape

- Server issues signed leases containing:
  - actor id
  - partition id
  - allowed scope values
  - allowed mutation tables
  - expiry
  - schema version
  - key id
- Client stores the active lease and tags queued commits with lease metadata.
- Server validates the lease during push replay.
- Expired or revoked leases produce clear conflict/auth states.

#### Constraints

- A lease is not a bypass for server validation.
- Lease failure should not silently drop local intent.
- Console should show which commits were made under which lease.

#### Design Requirements

- Lease signature algorithm and key rotation must be explicit.
- Lease payload must include a stable schema/protocol version.
- Client must store lease provenance and expiry with every queued commit.
- Server must distinguish:
  - invalid lease
  - expired lease
  - lease valid but business validation failed
  - lease valid but scope was revoked after replay
- UI/event APIs must let apps show "needs reconnect/review" rather than losing
  work.

#### Acceptance Criteria

- A client can queue a mutation offline with a valid lease and later push it.
- An expired lease produces a recoverable local conflict/auth state.
- A tampered lease is rejected by the server.
- Console/audit surfaces show lease id/key id/expiry for leased commits.

### P2: Rust Protocol Kernel

Create a shared Rust protocol crate before considering a Rust server or edge
proxy.

#### Why

The JS/Hono server owns much more than HTTP routing: handlers, scope resolution,
plugins, blobs, console, rate limits, dialect behavior, and encrypted CRDT
system tables. A full Rust server should not be the next step. A protocol
kernel is smaller and useful immediately.

#### Sensecheck

This is not the flashiest feature, but it is the most sensible enabling work.
The repo already has Rust protocol types and binary decoders in the runtime,
plus TypeScript schemas and encoders in core. As protocol ideas become more
ambitious, keeping those definitions split will create drift.

The kernel should be a protocol crate, not a server crate. It should not own app
handlers, SQL dialects, or deployment concerns.

#### What To Avoid

- Do not create a Rust server framework by accident.
- Do not move app-specific generated schema into the protocol crate.
- Do not fork protocol semantics between TypeScript and Rust.
- Do not introduce a published crate API before the boundaries are stable.

#### Shape

- Add `rust/crates/protocol`.
- Move or mirror canonical Rust types for:
  - combined push/pull
  - commits and changes
  - binary sync packs
  - binary snapshot chunks
  - blob refs
  - realtime messages
  - verification metadata
- Add cross-language fixtures shared with `packages/core`.
- Add JSON and binary roundtrip tests against TypeScript fixtures.

#### Non-Goals

- No Rust app table handler model yet.
- No Rust push plugin ABI yet.
- No Cloudflare Worker rewrite.

#### Migration Shape

Start with extraction, not redesign:

- Move binary snapshot/sync-pack decoding into the crate.
- Add fixture roundtrips against current TypeScript encoders.
- Re-export from `syncular-runtime` internally.
- Only after tests are stable, add verification metadata types.

#### Acceptance Criteria

- TypeScript-generated protocol fixtures decode in Rust.
- Rust-generated fixtures validate against TypeScript schemas.
- Runtime imports protocol logic from the crate instead of duplicating it.
- No server handler/dialect abstractions appear in the protocol crate.

## Suggested Implementation Order

1. Add protocol fixtures and compatibility tests for current JSON/binary sync.
2. Prototype commit digests and chain roots in server metadata.
3. Add Rust client verification for commit/chunk metadata.
4. Add snapshot manifests and bootstrap verification.
5. Prototype binary protocol v2 for one generated fixture table.
6. Measure v2 against current binary v1 in release WASM.
7. Add adaptive bootstrap readiness events and phase state.
8. Add one generated local read model to the todo fixture and benchmark it.
9. Add CRDT state-vector pull hints and stream diagnostics.
10. Add offline auth lease design and a narrow server/client smoke.

## Success Metrics

- Clients can detect tampered or inconsistent commits/chunks before applying.
- 500k bootstrap remains fast while peak memory decreases.
- Incremental apply avoids JSON materialization for common generated tables.
- First-screen data reaches `criticalReady` before full bootstrap completion.
- Generated read models beat equivalent raw aggregate queries by an order of
  magnitude on benchmark fixtures.
- CRDT field streams converge with smaller catch-up payloads.
- Offline auth lease failures are visible, recoverable, and auditable.

## Rejected Or Deferred Ideas

These are intentionally not part of the near-term plan:

- Full Rust server replacement. The current server owns too many app and
  operational semantics. Start with protocol kernel and maybe edge proxy later.
- Peer-to-peer sync. It conflicts with Syncular's server-authoritative product
  thesis.
- Fully automatic conflict resolution. Keep app-defined semantics; add better
  tools rather than hidden merges.
- Realtime data over WebSocket for normal rows. Keep WebSocket as wake-up unless
  a future CRDT/editor-specific path has a clearly separate contract.
- Automatic query planner or arbitrary materialized-query inference. Generated
  read models should be explicit.

## Cross-Cutting Design Rules

- Prefer one current protocol path with clear failures over compatibility
  branches.
- Every protocol extension must have JS/Rust fixture tests.
- Every performance-motivated change must have before/after release-WASM
  evidence.
- Every security claim must name the attacker it does and does not address.
- Every generated local feature must have a rebuild/check story.
- Console and telemetry should ship with new sync semantics, not after them.

## Messaging Updates

Once the work is real enough to claim publicly, update README and docs around:

- Native Swift/Kotlin status. Current README still says there are no native
  Swift/Kotlin SDKs, while the Rust plan says generated bindings and smoke tests
  now exist.
- "Realtime is only wake-up" should remain true for normal row data, but CRDT
  field delta behavior may need more precise wording if it gains state-vector
  pull hints.
- "Conflict resolution is not automatic" should stay, but read-model and CRDT
  field behavior should clarify where deterministic merging/maintenance is
  provided by the runtime.
