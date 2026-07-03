# DESIGN — Windowed sync / local eviction

Status: **design doc only** (TODO §5 item 2). Nothing here is normative
yet; §8 lists exactly which SPEC.md sections gain rules when the feature
is implemented. Written early — post-parity feature, spec-shape now —
because its semantics constrain blobs (TODO 2.1) and live-query
invalidation (TODO 3.1); §7 enumerates those constraints so both features
are built compatible.

Problem, one line: a client should hold a **partial local replica** —
the last 90 days, only hot projects — while the server keeps everything,
with correct sync semantics throughout. None of the benchmarked
competitors do partial local retention well (REVISE.md, post-parity
differentiators); most either tombstone forever, re-download the world,
or silently serve queries from a replica they can't prove complete.

Recommendation summary (one line per design question, argued below):

| # | Question | Recommendation |
|---|---|---|
| 1 | Window definition | A window is a **set of scope values**; windowing is dynamic scope-set change built on §3 — no second mechanism. Time windows are bucketed scope columns |
| 2 | Eviction semantics | Eviction = local delete fused with **unsubscription**; voluntary, never server-signaled; rows pinned while outbox commits reference them; version state deleted with the row |
| 3 | Cursor correctness | **Window-scoped subscriptions**: the window is part of subscription identity; window change = new sub id + fresh bootstrap; old sub unsubscribed + evicted + cursor discarded. No per-window cursors, no mutable-identity re-bootstrap |
| 4 | Re-entry | Always a **fresh bootstrap of the re-entering sub** (image lane); log-replay backfill rejected — unsound past the §4.6 horizon by construction |
| 5 | Blobs / invalidation | Constraints enumerated in §7: refcounted blob cache keyed off row presence with evicted ≠ revoked; one apply-path choke point emitting (table, scope-key) invalidation; the window registry doubles as the query-completeness oracle |
| 6 | Staging | v1 = window-scoped subs + eviction-on-unsubscribe + image re-bootstrap, **zero wire changes**; TTL sugar, blob integration, mid-session registration updates staged after |

---

## 1. Constraints from the existing spec

Everything below follows from six existing rules; the design's job is to
not break them.

- **C1 — the cursor invariant (§4.5, §4.3).** `cursor = N` on a
  subscription asserts: *the local replica is an exact image of the
  subscription's effective scope set as of seq N*. Incremental pull
  delivers only `cursor < commitSeq ≤ latest`; everything at or before
  `N` is assumed present. Any local deletion outside the protocol's own
  purge/clear rules (§3.3, §5.6) silently falsifies this assertion — the
  client would skip re-delivery of rows it no longer has. **This is the
  theorem the whole design orbits: eviction and cursor discard must be
  atomic.**
- **C2 — the server filters incrementals by scopes only (§3.1, §3.2).**
  The commit→scope inverted index is the sole log filter. `params` is
  host-opaque and touches only bootstrap snapshots (§4.1). Any window
  mechanism that is not expressible as scope values needs a second
  server-side filtering machine — rejected on the REVISE no-fallback /
  one-mechanism doctrine before we even start.
- **C3 — narrowing currently purges nothing (§3.3).** Only
  `status = revoked` purges; a narrowing `effectiveScopes` echo just
  stops delivery. Windowing extends this hole deliberately left open —
  it must not repurpose revocation (revocation is authorization loss,
  eviction is voluntary retention policy; conflating them would make
  §3.3's mandatory outbox-drop fire on cache trims).
- **C4 — bootstrap snapshots state, never replays log (§4.7, §4.6).**
  A bootstrap pins `asOfCommitSeq` and pages current rows as segments;
  it is valid regardless of how much log was pruned. This is the only
  re-entry path that survives the horizon.
- **C5 — segments seed optimistic concurrency (§5.2, §5.6, §6.2).**
  Every segment row carries `serverVersion`; a bootstrap alone fully
  re-seeds `baseVersion` conflict detection. (The SSG2 version-column
  decision, TODO §5 item 1, is what makes eviction+re-entry cheap — a
  re-entered row is immediately writable with optimistic concurrency.)
- **C6 — realtime registration is the last pull's subscription list,
  fixed per connection (§8.1); the ack floor is the min cursor across
  active, non-bootstrapping, synced-at-least-once subscriptions
  (§8.2).** Any design adding/removing subscriptions at runtime must
  work inside these two rules or explicitly amend them.

## 2. Q1 — What is a window?

Three candidate shapes:

**(a) Row TTL** — evict rows older than X inside a live subscription.
Violates C1 directly: the subscription's cursor keeps asserting
possession of rows the client deleted. Repairing that requires per-row
re-sync bookkeeping — a shadow cursor per row — which is a second sync
mechanism and the exact tombstone-swamp competitors are stuck in.
Rejected as a *primitive* (it returns as sugar in §6).

**(b) Per-subscription predicate** — an arbitrary query window
(`updatedAt > now-90d`). Violates C2: the server cannot filter the
commit log by predicate without new machinery, and predicate membership
*drifts* (rows age in and out with no commit touching them), which means
no event ever tells either side a row left the window. Rejected.

**(c) Scope-value sets** — the window is the set of scope values a
client currently holds locally: subscribe to `project:{A,B}` now,
`{B,C}` later; or to time buckets `bucket:{2026-05, 2026-06, 2026-07}`.
Windowing is then **dynamic scope narrowing/widening done right** — the
§3 machinery (request∩allow, stored-scope index, scope digest, purge
matching by local scope columns) is reused wholesale; what's new is
*only* the eviction/cursor semantics §3.3 currently leaves undefined for
narrowing.

**Recommendation: (c).** A window is a set of scope values; the window
*unit* — the atom of eviction and re-entry — is one scope value (or one
app-chosen value group, see §4). Consequences, stated honestly:

- **Windowing granularity = scope granularity.** You can only window by
  what you scope. This is a feature: the scope column is already the
  authorization boundary, the fanout index, the purge matcher, and the
  segment cache key — windowing by anything finer would bypass all four.
- **Time windows are bucketed scope columns.** "Last 90 days" is modeled
  as a `bucket` scope column (e.g. creation month) and a sliding set of
  bucket values. Because scope columns are immutable on update (§3.4
  rule 5), **creation-time buckets work with zero server support**;
  activity-time buckets would need server-emitted scope migrations
  (§2.2) per boundary crossing — supported but write-amplifying, so
  creation-time bucketing is the documented idiom. Codegen can emit the
  bucket column + helper (staged, §6).

## 3. Q2 — Eviction semantics

Eviction is a **client-local delete of all rows matching a scope value
set that is leaving the window**, performed at unsubscription time (§4
makes those the same event). It is voluntary; the server is never told
and never tombstones anything. How it differs from the two existing
delete-shaped contracts:

| | §3.3 revocation purge | §5.6 clear-first | Eviction |
|---|---|---|---|
| Trigger | Server: `status=revoked` | Client: fresh bootstrap first page | Client: window shrink (unsubscribe) |
| Authorization | Lost | Still held | Still held |
| Mandatory? | MUST purge | MUST clear | Client policy (the *fusion with cursor discard* is the MUST) |
| Outbox commits into the scope | SHOULD drop (replay guaranteed-rejected) | Untouched | **Kept** — they remain valid writes; see pin rule |
| Match rule | Last effective scopes, local scope columns, fail closed | Same | Same rule, same fail-closed clause (no mapping ⇒ don't evict, surface config error) |

Rules:

- **E1 — Outbox pin.** A row referenced by any still-pending outbox
  commit MUST NOT be evicted; eviction of pinned rows completes when the
  pinning commit drains (`applied`/`cached`/dropped). Rationale: §7.1
  replay-on-top re-applies pending commits over server state — evicting
  the base row would just have replay resurrect it as an orphan outside
  the window, and a rejected commit's conflict record (§6.3) is resolved
  against the local row. Deferred eviction is cancelled if the value
  re-enters the window first. The pending commits themselves are
  untouched: the server authorizes against stored rows (§3.4), so they
  push fine after local eviction of *other* rows in the scope.
- **E2 — Version state dies with the row.** Eviction MUST delete the
  stored `server_version` alongside the row — no residual version
  cache. `baseVersion` for a row that was evicted and re-enters comes
  exclusively from its re-delivery (segment `serverVersion` per C5, or a
  commit's `rowVersion`). There is no legal way to hold a `baseVersion`
  for a row you don't hold: any client API that mints optimistic writes
  reads the version from the local row, and the row is gone.
- **E3 — Eviction is fused with unsubscription** (the C1 consequence,
  mechanics in §4): evict rows + discard cursor + discard
  `bootstrapState` + discard the persisted effective-scope echo, one
  atomic local transaction. A client MUST NOT keep syncing a
  subscription whose rows it partially deleted, and MUST NOT keep a
  cursor for a subscription it evicted.
- **E4 — Local-only rows** (created optimistically, never
  server-confirmed) are covered by E1 — they exist only because a
  pending commit wrote them, so they're pinned until drain, then evicted
  like any row.

## 4. Q3 — Cursor correctness

The hard one. A single per-subscription cursor says "I have everything
through N" — a partial replica breaks that unless the *scope of the
claim* shrinks with the replica. Three options:

**(A) Per-window cursor vectors.** The subscription carries
(value-set → cursor) pairs; `SUB_END` returns a vector; realtime acks
become vectors. Every consumer of "the cursor" — horizon comparison
(§4.6), resume (§4.7), ack floor (§8.2), the retention watermark
(§4.5) — forks into per-window variants. This is the most invasive
possible change to the consistency spine, for zero capability the next
option doesn't deliver. Rejected.

**(B) Re-bootstrap on window change, same subscription id.** The server
detects that requested scopes differ from the persisted last request and
voids the cursor (forced fresh bootstrap). Keeps one cursor, but makes
subscription identity mutable: the server must persist+diff requested
scopes per sub; a pull raced with a window change has undefined cursor
meaning; §8.1's persisted registration list now changes meaning
mid-stream; and the client still has to run the eviction logic for the
departed values — so it saves nothing client-side. All cost, no savings
over (C). Rejected.

**(C) Window-scoped subscriptions — the window is part of subscription
identity.** Recommended. A window change is not a mutation, it is a
**set difference on subscriptions**:

- The client SDK's windowed surface manages a *family* of subscriptions,
  one per window unit (scope value, or app-chosen value group). Sub ids
  are derived deterministically, e.g.
  `w:<table>:<sha256(canonical scope map)[0..16]>` — ids are echoed, not
  interpreted (§4.1), so this is pure client convention.
- **Widen** `{A,B} → {A,B,C}`: add sub for `C`, `cursor = -1`, normal
  fresh bootstrap (image lane). Subs for `A`,`B` are untouched — their
  cursors stay honest.
- **Shrink** `{A,B,C} → {B,C}`: stop requesting `A`'s sub and run E3 for
  it (evict + discard cursor) in the same local transaction as the
  window-registry update.
- **Replace** `{A,B} → {B,C}` = shrink + widen. Because subs are
  value-sharded, `B` is *not* re-bootstrapped — the naive "new window =
  re-download everything" cost of coarse window-scoped subs is dissolved
  by choosing the sharding unit well. Apps trade sub count against
  re-entry granularity by picking the unit (per-project: exact;
  per-bucket: exact; one sub for a 500-value set: whole-set re-bootstrap
  on any change — their call, one mechanism either way).

Why (C) preserves every existing rule:

- **C1 (cursor invariant):** each cursor's claim is scoped to exactly
  one window unit, and that unit is either fully local (sub active,
  cursor honest) or fully evicted (sub gone, cursor gone). The invariant
  is never *weakened*; its scope is narrowed to match reality. No
  spec-level cursor semantics change at all.
- **§4.6 horizon:** unchanged per sub — a dormant client's window subs
  hit `reset`/`sync.cursor_expired` and re-bootstrap individually,
  exactly like any sub today.
- **§4.7 resume:** unchanged — a new window unit's bootstrap is a
  normal pinned, paged, resumable bootstrap; an interrupted one resumes
  by `bootstrapState` as today. Unsubscribing a mid-bootstrap sub =
  discard its resume token (E3), nothing server-side to clean up
  (bootstrap state lives in the token, §4.7).
- **§8.2 delta contiguity + acks:** a freshly added sub is bootstrapping
  and not yet synced-once, so it is excluded from the ack floor by the
  existing rule — window changes cannot drag the ack floor down or
  create false contiguity claims. Removed subs simply stop appearing in
  the pull; the §4.5 cursor record is computed per request, so the
  retention watermark forgets them on the next pull. No amendment
  needed.
- **§8.1 registration:** replace-semantics ("the subscription list of
  the most recent pull") already implements
  unsubscribe-by-omission server-side. Two wrinkles, both handled in
  §6/§8: (i) registrations are fixed per connection, so a new window
  unit receives no deltas until reconnect — v1 answer: cycle the socket
  after a window change (cheap; and the WS-native sync loop, TODO §1,
  will make registration follow the sync round naturally — windowing v1
  should land after it); (ii) replace-semantics means a *partial* pull
  (the §4.7 phasing note blesses pulling critical subs in a separate
  request) would silently unregister the rest — a latent ambiguity today
  that windowing sharpens; see Conflicts, §9.

**One normative client rule makes omission-as-unsubscribe sound:**
steady-state pulls MUST carry the client's complete current
subscription list. The single-sync-loop client (Direction decision 1)
does this naturally; phased partial pulls are legal only before the
omitted subs have ever synced (nothing to unregister). This rule costs
nothing and avoids a wire change (an explicit `UNSUBSCRIBE` frame —
which per §9's append-only rule would be a new frame type — stays in
the drawer unless partial pulls become a real feature).

Sub-count scaling: a 100-project window is 100 `SUBSCRIPTION` frames per
pull. Quiet subs are cheap by design (§4.5 cursor advancement without
matches), `resolveScopes` runs once per request (§3.2), and each sub is
one indexed log lookup. Guidance, not limit: value-sharding is
comfortable to a few hundred units; beyond that, group values into
coarser units.

## 5. Q4 — Re-entry

Widening the window (or a TTL bucket warming back) re-enters a value set
that was previously evicted. Two candidate mechanisms:

- **Fresh bootstrap of the re-entering sub** (recommended): `cursor =
  -1`, pinned snapshot, sqlite-image lane, first-page clear (§5.6)
  sweeps any stragglers (e.g. rows whose E1 pin drained after the
  eviction), segment `serverVersion` re-seeds optimistic concurrency
  (C5). Cost is proportional to the re-entering unit only, because the
  unit is the sharding grain (§4). Correct at any distance: bootstrap
  snapshots current state (C4), so it does not care how much log was
  pruned since eviction.
- **Incremental backfill from the log** (resume the old cursor):
  rejected, twice over. First, it is *unsound after eviction* — the old
  cursor claimed local possession through N, eviction falsified that
  claim, so replaying `N..latest` misses every row unmodified since N
  (this is C1 again; it is why E3 discards the cursor rather than
  parking it). Second, even a hypothetical "replay from 0 for this
  scope" backfill dies at the horizon: the log before `horizonSeq` is
  gone (§4.6), and compaction (§4.6 last rule) only guarantees
  convergence for cursors ≥ horizon. Backfill needs *state*, not log —
  and paged, content-addressed, CDN-cacheable state delivery already
  exists: it is the segment system. A dedicated "backfill segment" would
  be a second name for a bootstrap.

So re-entry needs **no new protocol object at all** — it is the §4.7
bootstrap, made cheap by the image lane (Direction decision 4: 204 ms at
100k rows is the motivating number; re-entry of one project or one month
bucket is far smaller) and made *correct for writes* by the SSG2
`serverVersion` decision. This is the payoff of doing this design after
those two decisions landed.

## 6. Staged rollout

**Stage W1 — "windowed subscriptions v1"** (post-parity, first
differentiator rung; requires the WS-native sync loop from TODO §1 to
be in, see §4 wrinkle (i)):

- Client SDK windowed-subscription surface: value-sharded sub families,
  deterministic sub ids, the **window registry** (a local table mapping
  table → windowed-in scope values → sub state; also the invalidation
  oracle, §7).
- E1–E4 eviction on unsubscribe; omission-as-unsubscribe with the
  complete-list client rule (§4).
- Re-entry via fresh bootstrap (nothing to build — exercised, not
  implemented).
- Socket cycle on window change (until registration follows sync
  rounds).
- Conformance scenarios (new, in Appendix B style): window shrink evicts
  exactly the departed unit and pins outbox-referenced rows; widen
  bootstraps exactly the new unit; shrink+widen leaves the intersection
  untouched (cursor unchanged, no re-download — assert on segment
  traffic); evict→drain→deferred-evict; evict→re-enter→push with
  segment-seeded `baseVersion`; re-enter across a pruned horizon.
- **Zero wire changes. Zero server changes** beyond what §8.1/§4.5
  already require.

**Stage W2 — TTL sugar:** codegen emits creation-time bucket scope
columns + a sliding-window helper (`window: { bucket: last(3,
'month') }`); pure client/codegen sugar over W1.

**Stage W3 — blob integration:** lands with blobs (TODO 2.1) honoring
the §7 constraints — refcount release on eviction, evicted ≠ revoked
retention policy.

**Deferred until evidence demands:** `UNSUBSCRIBE` frame type (only if
partial pulls become a feature); server-side segment diffing for
coarse-unit windows (only if bench shows re-bootstrap overlap cost);
activity-time buckets via scope migration (only on user demand).

## 7. Constraints on blobs (2.1) and live-query invalidation (3.1)

The reason this doc exists now. These are **requirements on those
designs**, to be carried into their spec work verbatim.

Blobs:

- **B1 — Blob bodies are cache entries keyed by content address,
  refcounted by referencing local rows.** Row eviction releases refs;
  zero-ref bodies become *evictable* (LRU / storage-pressure policy),
  not synchronously deleted. Blob cache design must not assume a
  referencing row exists for a cached body, nor a body for a row.
- **B2 — Evicted ≠ revoked, in the blob lifecycle enum.** Revocation
  (§3.3) MUST delete no-longer-authorized bodies (the WP-25 v1 rule);
  window eviction MAY retain them. The lifecycle states (v1 prior art:
  pinned / online-only / available / evicted) need both transitions,
  distinctly triggered.
- **B3 — BlobRefs must be resolvable to a download at any time.**
  Re-entry re-delivers rows whose bodies may or may not still be cached;
  no bookkeeping required for download may live only in row-adjacent
  local state that eviction deletes.
- **B4 — Upload state is keyed by the outbox, not by row presence** —
  and E1 already pins rows referenced by pending commits, so a pending
  upload's row and body are both pinned by the same rule. Blob upload
  tracking must attach to the pending commit so the pin covers it.

Live-query invalidation (design-time rule from REVISE: invalidate by
(table, scope-key) touched per commit, never re-run-everything):

- **I1 — One apply-path choke point.** Every local mutation — commit
  apply, segment apply, revocation purge, first-page clear, **and
  eviction** — MUST emit invalidation keys through the same path.
  Eviction is a bulk delete; a query over evicted rows must re-run. An
  invalidation design wired only to server-delivered changes is
  incompatible.
- **I2 — Shared key vocabulary.** Invalidation keys use the stored-scope
  key form of §3.1 (`prefix:value`). The window registry (§6) is keyed
  the same way. One vocabulary, three consumers: delta routing (server,
  already spec'd), invalidation (client), window membership (client).
- **I3 — The window registry is the completeness oracle.** A live query
  is answerable from the local replica iff every scope value its
  predicate touches is windowed-in (registry hit) — otherwise the result
  is partial and the API must say so (surface as "window miss", host
  decides: widen, or render partial with a flag; never silently return
  partial data as complete). Query bindings built before windowing must
  therefore route every query's scope footprint through the registry
  from day one, even while the registry trivially contains "everything
  subscribed" — retrofitting completeness checks into a query API is the
  one thing we know from competitors doesn't happen.
- **I4 — Bucketed invalidation stays fine-grained under sharding.**
  Because window units are scope values, eviction/re-entry invalidate
  exactly the touched (table, scope-key) pairs — never table-wide.
  Invalidation key cardinality = window unit cardinality; no new
  mechanism at either end.

## 8. SPEC.md sections that gain rules at W1 (none before)

- **§3.3** — a paragraph distinguishing *eviction* from purge: narrowing
  still purges nothing; voluntary eviction is legal **only** fused with
  unsubscription (E3), matched by the same local-scope-column rule
  including fail-closed.
- **§4.1** — subscription lifecycle: omission-as-unsubscribe made
  normative; the complete-list client rule; the sub-id derivation
  convention as non-normative guidance.
- **new §4.8 "Windowed subscriptions"** — the window model (Q1), E1–E4,
  re-entry-is-bootstrap (Q4), registry requirements. Mostly client
  conformance rules; server text is confined to confirming §8.1
  replace-semantics and the §4.5 watermark already behave correctly.
- **§8.1** — registration update timing once the WS-native sync loop
  lands (registration follows the sync round; the fixed-per-connection
  rule is relaxed or the socket-cycle behavior is codified).
- **Appendix B** — the six conformance scenarios of §6.
- **No golden-vector changes**: W1 adds no frames, fields, or codes.

## 9. Conflicts with the current SPEC as written

1. **§4.7 phasing note vs §8.1 replace-semantics** (pre-existing,
   sharpened here): "pull critical subscriptions first, even in a
   separate request" silently unregisters the omitted subs from realtime
   under §8.1's "most recent pull" rule. Windowing's
   omission-as-unsubscribe leans on exactly that replace behavior, so
   the ambiguity must be resolved *in windowing's favor*: partial pulls
   are legal only for never-synced subs (§4), or the phasing note gets
   softened to same-request ordering only. Either fix is a one-line SPEC
   edit; flagged rather than made here (design doc only).
2. **§8.1 fixed-per-connection registration** makes newly widened window
   units delta-blind until reconnect. Not a correctness bug (the sync
   loop covers the gap) but a UX wart windowing amplifies; resolved by
   sequencing W1 after the WS-native sync loop (TODO §1) rather than by
   amending §8.1 for HTTP-registered sockets.
3. Nothing else: E1–E4 and window-scoped subscriptions were checked
   against §3.3 (purge), §4.5 (cursor + watermark), §4.6 (horizon),
   §4.7 (resume, fresh-vs-resumed first-page clear), §5.6 (clear +
   version seeding), §6.2/§6.3 (baseVersion, conflicts), §7.1/§7.2
   (replay-on-top, rejection handling), §8.2 (contiguity, ack floor) —
   all hold without amendment.

## 10. Open questions for Benjamin (product-level only)

1. **Eviction disposition on shrink:** v1 proposes *evict immediately*
   as the only mode (no fallback ladders). The alternative product
   stance — keep departed rows queryable but flagged stale ("local
   archive") — is a real feature some file-sync-ish apps want, but it
   reintroduces partial-replica queries by design. In or out of the
   product, ever? (Determines whether I3's "window miss" surface needs a
   three-state answer: complete / miss / stale.)
2. **Public API altitude:** is windowing a first-class client API
   (`subscribeWindow(table, values)` + `setWindow()`), or low-level sub
   management the app composes? First-class is the differentiator story;
   low-level ships sooner.
3. **Blob retention default on eviction (B1/B2):** LRU-retain
   (device-storage friendly, "it was just here" re-entry UX) vs
   delete-on-zero-refs (predictable disk usage). Pick a shipped default;
   both stay policy-configurable.
