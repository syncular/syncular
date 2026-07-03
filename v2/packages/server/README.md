# @syncular-v2/server

Framework-free embeddable SSP2 protocol library. Core surface:
`handleSyncRequest(bytes, ctx) → bytes` over host-provided storage /
scope-resolution / segment-store interfaces, plus the transport-agnostic
realtime hub (§8), the direct segment download handler (§5.5), commit-log
pruning (§4.6), and signed-URL token issuance (§5.4). `SPEC.md` is
normative for everything on the wire; this README covers the **host
surface** — in particular the ops seam and the pruning runbook.

## Structured events (the ops seam)

One optional interface, `SyncularServerEvents`, carries every
operator-relevant signal as a typed, JSON-able, stable-shaped event:

```ts
import { consoleJsonEvents, type SyncServerConfig } from '@syncular-v2/server';

const config: SyncServerConfig = {
  schema, storage, segments, resolveScopes,
  events: consoleJsonEvents(),          // one JSON line per event on stdout
};
```

There is no logger dependency and no formatting — emission only. The same
shapes feed one-line JSON logs, metrics counters, and error trackers; a
Sentry adapter is a ~20-line `emit` implementation over this seam. The
events sink rides on `SyncServerConfig`, so the Hono adapter (and any
other adapter that spreads the config into the request context) passes it
through with no extra wiring. The realtime hub and `pruneCommitLog` take
the same sink via their own config/options (they run outside the request
context). The demo server wires it behind `SYNCULAR_DEMO_EVENTS=1`.

### Guarantees

- **Never throws through.** Emission is fire-and-forget: a throwing
  `emit` is swallowed at the seam and cannot affect request processing,
  realtime delivery, or pruning. (Tested.)
- **Zero cost when off.** With no sink configured, no event object is
  ever built — every call site checks the sink before constructing the
  event. The benches run with events unset.
- **Stable, JSON-able shapes.** Flat objects, no `undefined` values, no
  classes; `JSON.stringify` round-trips every event. Shapes and `type`
  strings are append-only surface.
- **Virtual-clock clean.** All timestamps and durations come from the ctx
  clock (`clock` on the config / hub; `nowMs` for prune), so conformance
  and tests under a virtual clock stay deterministic. Wall clock is never
  read behind the host's back.

### Event catalog

| Event | When | Key fields |
| --- | --- | --- |
| `request.handled` | Once per `POST /sync`, after the response bytes are fully produced (or the request was rejected up front) | `kind` (`sync`), `partition`, `actorId`, `durationMs`, `bytesIn`, `bytesOut`, `outcome` (`ok` \| `schema_floor` \| `rejected` \| `error`), `errorCode?`, `pushCommits`, `pulled`, `subscriptions` |
| `push.applied` | A `PUSH_COMMIT` applied, or replayed from the idempotency cache (§2.3) | `clientId`, `clientCommitId`, `operations`, `commitSeq?`, `replay` |
| `push.rejected` | A commit rejected (§6.3) | `clientId`, `clientCommitId`, `operations`, `code` (§10.2), `opIndex` |
| `push.conflicted` | A commit terminated by a version conflict (§6.2) | `clientId`, `clientCommitId`, `operations`, `opIndex` |
| `pull.served` | Once per served pull half, after all sections streamed | `clientId`, `subscriptions[]`: `{id, table, status, mode` (`bootstrap` \| `incremental` \| `none`)`, fromCursor, nextCursor, commits, changes, segments[]}`; each segment: `{mediaType` (`rows` \| `sqlite`)`, delivery` (`inline` \| `ref`)`, origin` (`built` \| `reused`)`, bytes, rows}` |
| `segment.downloaded` | Every direct segment download (§5.5), success or failure | `segmentId`, `outcome` (`ok` \| `error`), `errorCode?`, `mediaType?`, `bytes?`, `durationMs` |
| `realtime.opened` | A socket registered with the hub and got `hello` (§8.1) | `sessionId`, `clientId`, `registrations`, `cursor`, `latestSeq` |
| `realtime.closed` | A session left the hub (once per session) | `sessionId`, `durationMs` |
| `realtime.delta` | A delta message pushed over the socket (§8.2) | `sessionId`, `commitSeq`, `bytes`, `changes` |
| `realtime.wake` | A `sync` wake-up sent (§8.3) | `sessionId`, `reason` (`catchup-required` \| `delta-too-large` \| `reset-required`) |
| `prune.completed` | Every `pruneCommitLog` pass, moved or not | `partition`, `previousHorizonSeq`, `horizonSeq`, `advanced`, `removedCommits` |
| `scopes.resolve_failed` | The host `resolveScopes` callback threw — the §3.2/§3.4 fail-loud path | `phase` (`request` \| `realtime` \| `segment-download`), `message` |

All events also carry `type`, `atMs`, and (where a request identity
exists) `partition` / `actorId`.

## Segment storage on S3 / R2 (`S3SegmentStore`)

Three `SegmentStore` backends ship in-tree and pass one shared contract
suite (`test/segment-store-contract.ts`): `MemorySegmentStore` (tests,
single process), `SqliteSegmentStore` (single node), and
`S3SegmentStore` — the production backend for any S3-compatible object
store (AWS S3, Cloudflare R2, MinIO). It is dependency-free: SigV4 is
hand-rolled over `fetch` (`sigv4.ts`, pinned by the published AWS test
vectors).

```ts
import { S3SegmentStore, s3PresignedUrls } from '@syncular-v2/server';

const segments = new S3SegmentStore({
  endpoint: 'https://s3.eu-central-1.amazonaws.com', // origin only, no bucket
  region: 'eu-central-1',
  bucket: 'my-app-segments',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  keyPrefix: 'syncular/',       // optional namespace inside the bucket
  ttlMs: 24 * 60 * 60 * 1000,   // §5.1 default
});

const config: SyncServerConfig = {
  schema, storage, resolveScopes,
  segments,
  signedUrls: s3PresignedUrls(segments, { ttlSeconds: 900 }), // §5.4 delegated presign
};
```

**Cloudflare R2 specifics.** The endpoint is your account's S3 API host
and the region is always `auto`:

```ts
const segments = new S3SegmentStore({
  endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'my-app-segments',
  accessKeyId: R2_ACCESS_KEY_ID,      // R2 API token pair
  secretAccessKey: R2_SECRET_ACCESS_KEY,
});
```

MinIO works the same way (`endpoint: 'http://127.0.0.1:9000'`, any
region string). Requests are path-style (`{endpoint}/{bucket}/{key}`),
which all three providers accept.

**Key layout.** Deterministic, so every lookup is a GET/HEAD — never a
LIST:

- `{keyPrefix}seg/sha256/{hex}` — the segment bytes, verbatim (the
  object body is exactly the content-addressed bytes, so presigned GETs
  serve them directly and the client's §5.1 hash check passes). The
  record metadata rides in object user metadata
  (`x-amz-meta-syncular-record`, base64url JSON), so `get` is one GET.
- `{keyPrefix}find/{sha256(reuse key)}.json` — the §5.3 whole-table
  reuse pointer, written only for `rowCursor: null` segments; `find` is
  one GET plus a HEAD to confirm the segment object still exists.

**TTL and lifecycle.** Expiry is store-side and authoritative:
`expiresAtMs` (`put` time + `ttlMs`, default 24 h) is recorded with the
record; `get` returns expired records so the §5.5 endpoint can answer
the precise, retryable `sync.segment_expired`, and `find` filters them
itself. Bucket lifecycle expiration is *garbage collection only* — set
it comfortably **above** `ttlMs` (e.g. 2 days for the 24 h default) and
never below it. After lifecycle deletes an object, clients see
`sync.not_found` instead of `sync.segment_expired`; both recover by
re-pulling, but the former loses the "just re-pull, this is normal"
signal, so keep the GC margin generous.

### Native HMAC vs delegated presign (§5.4)

`SyncServerConfig.signedUrls` accepts either scheme; the pull emits
`SEGMENT_REF.url`/`urlExpiresAtMs` identically for both (issuance always
happens inside the pull, immediately after scope resolution), and
clients cannot tell them apart.

- **Native HMAC (`SignedUrlConfig`)** — you serve the segment bytes
  yourself (or from something that delegates auth to you, e.g. a CDN
  worker calling `verifySegmentToken` at the edge). The `st` token binds
  segment + scope digest + partition audience. Choose this when segments
  live in `SqliteSegmentStore` or when you want claim-level binding at
  your own edge.
- **Delegated presign (`DelegatedPresignConfig`, via
  `s3PresignedUrls(store)`)** — the object store enforces the grant; the
  sync server never proxies segment bytes (zero egress through it — the
  bootstrap-storm answer). The §5.4 equivalence rule holds by
  construction: the signed object key embeds exactly one `segmentId`,
  and the expiry obeys the same ≤ 15 min TTL guidance (default 900 s for
  both schemes).

Either way, keep the §5.5 direct-download endpoint mounted: it is the
mandatory fallback for expired/failed URLs and for clients that never
advertised accept bit 3.

### CDN in front

Segment URLs are safe to cache *by content*: the object key is the
content address (`seg/sha256/{hex}`), the bytes are immutable for a
given key, and the client verifies the hash after download (§5.1) — so
a CDN can cache segment objects keyed on the path alone and can never
serve wrong bytes, only stale-but-correct ones. Two rules:

- **Strip the query from the cache key, never from the auth check.**
  Presigned query parameters (or the native `st` token) differ per
  client; the path is the content address. Configure the CDN to cache on
  the path while still forwarding the query for origin authorization
  (or validate at the edge: `verifySegmentToken` for native tokens).
  Never cache the *authorization decision*.
- **Align the CDN TTL with the store TTL.** Cache lifetime at or below
  `ttlMs` keeps the CDN from serving objects the store already declared
  expired (harmless — the client would still verify and apply — but it
  masks the §5.1 cache-entry semantics and can hide lifecycle GC).
  Content-addressing makes over-caching safe, not useful.

The §5.5 endpoint responses stay `Cache-Control: private, max-age=0`
— only segment-object URLs are CDN-cacheable, never the re-authorized
download path.

## Horizon & pruning: operational guidance

The commit log grows forever unless you prune it. `pruneCommitLog`
(SPEC §4.6) advances the per-partition `horizonSeq` and deletes commits
at or below it. Nothing prunes automatically — the host schedules it.

**When to run.** A periodic job per partition — hourly to daily is the
sensible range; there is no benefit below the granularity of your
`activeWindowMs`. Prune is cheap when there is nothing to do (one cursor
scan + two point reads), so err on the side of running it often rather
than letting a backlog build. Pass `events` to get `prune.completed`
per pass.

**The retention floors (§4.6, encoded in `RetentionPolicy`).** The
horizon never advances past `min(cursor)` of *active* clients — clients
whose cursor record was touched within `activeWindowMs` (default 14
days). Two escape hatches keep laggards from pinning the log forever:
commits older than `ageForceMs` (default 30 days) may be pruned
regardless, and at least the newest `minRetainedCommits` (default 1000)
commits are always kept. Defaults are the v1 production values; raise
them freely, lower them with care.

**What `sync.cursor_expired` means operationally.** A client whose
cursor fell behind the horizon gets `SUB_START.status = reset` and
re-bootstraps from scratch (§4.7). That is correct behavior, not an
error — but its *rate* is your pruning health signal. A steady trickle
means devices returning from >30-day absences (expected). A spike means
you pruned faster than your fleet syncs: `ageForceMs` or
`activeWindowMs` is too tight for real usage, and you are paying for it
in bootstrap load (full re-scans + segment builds), not just in resets.
Observe it via `pull.served` subscriptions with `status: "reset"`.

**Segment TTL interplay.** Segments are cache entries, not durable state
(§5.1; default TTL 24 h). A bootstrap that resumes past segment expiry
answers `sync.segment_expired` and the client re-pulls for fresh
descriptors — again correct, again a cost signal. Keep the segment TTL
comfortably longer than the slowest plausible bootstrap (a multi-page
bootstrap must finish while its segments live), and note that pruning
and segment expiry compound: a reset storm triggers a bootstrap storm,
which the §5.3 image-reuse rule absorbs only while images stay
unexpired. If you see `origin: "built"` dominating `"reused"` for the
same table+scope during a storm, your TTL is shorter than the storm.

**What to alert on.**

- `push.rejected` rate, by `code` — a rising `sync.forbidden` share
  usually means an authorization regression, not misbehaving clients.
  (`push.conflicted` is normal offline-first traffic; alert only on
  gross shifts.)
- `scopes.resolve_failed` — any nonzero rate. This is the fail-loud
  path: every occurrence revokes subscriptions or rejects writes for a
  real request, and it is almost always a host bug or a dead dependency
  of the resolver.
- `request.handled` with `outcome: "error"` and `errorCode: "internal"`
  — storage failures surfacing mid-stream.
- Reset rate (`pull.served` → `status: "reset"`) — see above; alert on
  spikes relative to fleet size.
- Prune backlog: `prune.completed` with `advanced: false` for many
  consecutive passes *while the log grows* means one laggard cursor
  inside the active window is pinning retention — inspect
  `listClientCursors` for the offender; the §4.6 floors bound the damage
  to `ageForceMs`.
- `realtime.wake` with `reason: "delta-too-large"` — sustained
  occurrences mean commits routinely exceed `maxDeltaBytes` and clients
  are falling back to HTTP pulls; raise the limit or shrink commits.
