# Syncular Protocol Specification (v2) — DRAFT SKELETON

Status: **skeleton — B1 in progress.** This document is normative once B1
completes: implementations conform to this spec and the golden vectors in
`spec/vectors/`; divergence is an implementation bug. A change to wire
format or semantics requires a version bump per §9 and updated vectors in
the same commit.

Source material: extracted from the 0.1.x implementation (wire v14) —
`../packages/core/src/sync-packs.ts` (encoder/decoder ground truth),
`../packages/core/src/schemas/sync.ts` (request shapes),
`../packages/core/src/error-responses.ts` (error catalog),
`../tests/load/lib/ssp1.js` (independent reader; documents what is parseable
without decompression), and the semantics honed in
`../apps/docs/content/docs/reference/protocol.mdx` +
`../rust/docs/` conformance gates. Extract semantics, not code.

---

## 0. Deliberate simplifications vs wire v14 (decide during B1)

Candidates — each gets an explicit keep/change decision recorded here:

- [ ] Single self-describing envelope version field; drop v14's accumulated
      optional-section variance where a section can simply always be present
      (possibly empty).
- [ ] Unify snapshot **chunks** vs **artifacts** into one content-addressed
      "bootstrap segment" concept with a media-type field (row-frames |
      sqlite-artifact), one cache/auth story, one download endpoint.
- [ ] **Compression moves to the transport.** Sections travel raw; HTTP
      responses use native `Content-Encoding` (zstd preferred, gzip
      fallback) and segment downloads use `DecompressionStream`. Removes
      decompression code from the client bundle, uses native zlib on the
      server, keeps responses CDN-cacheable. Decide at-rest compression for
      stored segments separately (server-side concern).
- [ ] **Streaming-friendly framing.** Table segments are self-delimiting so
      the server can stream-encode and the client can begin applying while
      later segments are still in flight (v1 decoded whole packs; 500k
      row-chunk bootstrap was 2.07s of sequential fetch→decode→apply).
- [ ] **Schema-known encoding is mandatory.** Codecs are generated from the
      schema IR on both sides; runtime column inference does not exist in
      v2 (v1's generic path paid +46% encode overhead — make that class of
      cost unrepresentable).
- [ ] **Signed-URL segment delivery.** Bootstrap segments are
      content-addressed and may be served via short-lived signed URLs
      (R2/S3/CDN) instead of proxying bytes through the sync server —
      the bootstrap-storm answer. Direct serving stays as the fallback.
- [ ] **SQLite-image segments are the premier bootstrap format** (v1
      evidence: 204ms vs 467ms at 100k). In the TS core, importing a
      prebuilt scoped DB image via sqlite-wasm is near file-copy speed.
      Row-frame segments remain the fallback media type.
- [ ] **Pruning horizon is normative.** Define the log-retention contract:
      a cursor older than the horizon ⇒ forced re-bootstrap, with the exact
      client-visible signaling (v1 has prune/compact but the semantics live
      only in code).
- [ ] Error envelope: keep the 63-code catalog's *shape* (code, category,
      retryable, recommendedAction) but prune codes that no longer have a
      producer.
- [ ] Realtime: one delta message kind + one "pull required" wake-up kind;
      drop legacy variants.
- [ ] Canonical JSON debug rendering specified alongside binary (dev-only,
      explicitly non-contractual) so tooling never silently rots again.
- [ ] Explicit forward-compat rule: unknown trailing sections are skippable
      by length prefix.

## 1. Transport bindings
One combined sync endpoint (`POST <mount>/sync`, binary request/response),
segment download endpoint, websocket endpoint. Auth is host-provided
(headers → host `authenticate()`); the protocol carries no credential
semantics beyond auth-lease replay (§7).

## 2. Data model & identity
Commits (server-ordered, per-partition monotonic `commitSeq`), operations
(upsert/delete with `row_id`, payload, `base_version`), server_version per
row, scopes as stored row attributes. `clientCommitId` as the idempotency
key — exactly-once apply per client commit, replay returns the cached
result.

## 3. Scopes & authorization  ← the crown jewels; port semantics verbatim
Scope patterns (`user:{user_id}`), requested-scopes on subscriptions,
host-resolved allowed scopes, effective = requested ∩ resolved, validation
of both sides against declared patterns (fail loud), revocation semantics
(effective-empty ⇒ subscription revoked + local purge contract), `'*'`
wildcard, write-path scope authorization (all declared keys required).

## 4. Subscriptions, cursors, pull
Subscription identity, cursor advancement rules, limits (commits, snapshot
rows, pages), dedupe, bootstrap-state machine (phases: critical /
interactive / background), catch-up semantics after gaps.

## 5. Bootstrap segments
Content-addressed, scope-authorized snapshot delivery; precomputed
artifacts as the default path; row-frame fallback; hashing, compression,
TTL/caching, and the re-authorization requirement on download (the `scopes`
query param lesson).

## 6. Push, conflicts, results
Batched commits, per-operation results (applied | conflict | error),
atomic rollback on rejection, `base_version` conflict detection, conflict
payload shape, app-level resolution contract (keep-local / keep-server /
custom), retry-with-rebase semantics.

## 7. Offline writes & auth leases
Outbox semantics, replay ordering, idempotent retry, lease issuance /
signed payload / expiry / server validation on replay.

## 8. Realtime
Delta push with cursor continuity, "pull required" wake-ups with reason
codes, heartbeat, reconnect + catch-up contract, presence (scope-keyed
ephemera) as an extension section. Reconnect storms are a first-class
design input: catch-up prefers bootstrap segments over row pulls, and
clients apply jittered coalescing (v1's WP-32 evidence: server fanout to
100 clients in 13ms, but ~2s client-side wake-contention tail at 250+).

## 9. Versioning & evolution
Explicit wire version; what constitutes a breaking change; client/server
schema-version negotiation (`requiredSchemaVersion` / `latestSchemaVersion`
semantics); unknown-section skip rule.

## 10. Error catalog
Shape + the pruned code table (from `error-responses.ts`), with category /
retryable / recommendedAction semantics normative.

## Appendix A. Golden vectors
`spec/vectors/` — for each message kind: canonical binary fixture + JSON
rendering + round-trip requirements. CI-blocking for every implementation
in this tree.

## Appendix B. Conformance scenarios
Index of the implementation-agnostic scenarios in `packages/conformance`
(ported from the 0.1.x testkit gates): two-client convergence, offline
replay, idempotent retry under ack-loss, scope revocation purge, bootstrap
resume mid-phase, conflict resolve/rebase.
