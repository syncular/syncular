# @syncular/server

Framework-free embeddable SSP2 protocol library. Core surface:
`handleSyncRequest(bytes, ctx) → bytes` over host-provided storage /
scope-resolution / segment-store interfaces, plus the transport-agnostic
realtime hub (§8), the direct segment download handler (§5.5), commit-log
pruning (§4.6), and signed-URL token issuance (§5.4). `SPEC.md` is
normative for everything on the wire; this README covers the **host
surface** — in particular the ops seam and the pruning runbook.

## Deployment matrix (runtime adapters, TODO §4.2)

The server core is **runtime-neutral TypeScript** — `handleSyncRequest` and
the realtime session speak only Web `Request`/`Response`/`fetch`/Web-Crypto,
no Bun- or Node-only builtin (enforced by a static import-graph scan,
`test/runtime-neutrality.test.ts`). Adapters wire that core to a runtime.
The supported set, and what deliberately does **not** get an adapter:

| Runtime | Adapter | Transport | Storage | Status |
| --- | --- | --- | --- | --- |
| **Bun / Node** | `@syncular/server-hono` | HTTP (`POST /sync`, segments, blobs) **+ WS realtime** (§8, host-driven upgrade) | any: `SqliteServerStorage`, `PostgresServerStorage`, memory | **Supported now** — the reference deployment; runs the full conformance catalog on both bindings. |
| **Cloudflare Workers** | `@syncular/server-workers` | HTTP binding via Hono (Workers-native) **+ WS realtime** (§8, Durable Object host with hibernation) | `D1ServerStorage` (D1); R2-as-S3 for segments/blobs (§5.4 delegated presign) | **Supported now** — this rung. Realtime rides a **Durable Object** (`SyncularRealtimeDO`), opt-in; HTTP-only is also fully conformant (below). |
| Raw Deno / edge-misc | — | — | — | **Not adapted** (policy below). |

**The policy for "not adapted".** Untested ≠ unsupported forever. The core
is runtime-neutral TS, so Deno/edge would very likely run it — but an adapter
is only *supported* where the conformance catalog can run against it. We ship
adapters for the runtimes where we run conformance (Bun/Node fully; Workers
HTTP via the fetch-handler round-trip tests), and we do not claim runtimes we
do not test. Deno is a plausible future adapter the day someone runs the
catalog on it; until then it is neutral-core-friendly, not supported.

**Workers realtime — the Durable Object.** SPEC §1.1's two bindings are two
framings of one handler; an **HTTP-only deployment is fully conformant**
(clients that cannot open the socket sync over `POST /sync`, identical
semantics — a smaller complete deployment, not a degraded one), so realtime on
Workers is opt-in. When enabled it rides a **Durable Object**
(`SyncularRealtimeDO`): one DO per partition hosting the `RealtimeHub` (the DO
id derived from the partition, so a partition's sockets and its commit fan-out
are co-located and single-threaded — also the natural per-partition write
serialization point the D1 storage wants); WebSocket **hibernation** so idle
sockets don't bill wall time (the existing `RealtimeSession` is the
per-connection state machine, driven from the hibernation callbacks and
rehydrated from a minimal socket attachment + the D1 client record on wake);
storage via the same **D1** binding so realtime rounds and `POST /sync` rounds
share one commit log and one segment store; commit fan-out (§8.2) runs in-DO
(no LISTEN/NOTIFY needed — writes and sockets are co-located), and an HTTP push
landing in a plain isolate wakes the partition's DO (the in-platform
LISTEN/NOTIFY analogue). Full shape, wiring, hibernation semantics, and the
manual real-workerd smoke recipe in `@syncular/server-workers/README.md`.

**Relay does not return (decision).** v1 shipped a *relay* — a bridge that let
a self-hosted server forward realtime to a managed realtime service, because
v1's realtime was a separate socketed subsystem the self-hosted core couldn't
serve on its own. v2 has no such gap: realtime is the **second binding of the
same handler** (§8.7, Direction decision 1 — the WS-native loop), so any host
that runs the core serves realtime directly; multi-instance fanout is covered
by **LISTEN/NOTIFY** on Postgres (below), and the Workers case is covered by
the **DO design** (writes and sockets co-located per partition). Every job the
relay did is now done by a binding of the core or by in-database fanout —
reintroducing a relay would add a hop, a second protocol surface, and a
managed dependency for zero capability the core lacks. So it is retired, not
ported.

## Structured events (the ops seam)

One optional interface, `SyncularServerEvents`, carries every
operator-relevant signal as a typed, JSON-able, stable-shaped event:

```ts
import { consoleJsonEvents, type SyncServerConfig } from '@syncular/server';

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
| `blob.swept` | Every `sweepOrphanBlobs` pass (§5.9.2 orphan GC) | `partition`, `swept` (deleted count), `referenced` (keep-set size), `graceMs` |
| `realtime.opened` | A socket registered with the hub and got `hello` (§8.1) | `sessionId`, `clientId`, `registrations`, `cursor`, `latestSeq` |
| `realtime.closed` | A session left the hub (once per session) | `sessionId`, `durationMs` |
| `realtime.delta` | A delta message pushed over the socket (§8.2) | `sessionId`, `commitSeq`, `bytes`, `changes` |
| `realtime.wake` | A `sync` wake-up sent (§8.3) | `sessionId`, `reason` (`catchup-required` \| `delta-too-large` \| `reset-required`) |
| `prune.completed` | Every `pruneCommitLog` pass, moved or not | `partition`, `previousHorizonSeq`, `horizonSeq`, `advanced`, `removedCommits` |
| `scopes.resolve_failed` | The host `resolveScopes` callback threw — the §3.2/§3.4 fail-loud path | `phase` (`request` \| `realtime` \| `segment-download`), `message` |

All events also carry `type`, `atMs`, and (where a request identity
exists) `partition` / `actorId`.

## Admin / console surface (`SyncularAdmin`)

The operator-facing read surface over the server core. It is a module in
this package — **not** a separate UI package — and adds **zero** wire
protocol: SPEC.md says nothing about it, because authorization for these
reads is entirely the host's. It is the v2 answer to v1's full React
console app: the same 80% operator value (who's connected, what's flowing,
horizon health, the event tail) as a handful of read-only, partition-scoped,
JSON-able queries.

### The event ring (the "event stream")

`RingBufferEvents` is a `SyncularServerEvents` sink that retains the last N
events in memory (bounded — oldest dropped when full) with a
`query({type?, sinceMs?, limit})`. It is the event stream without any
infrastructure dependency. Compose it with any other sink so the console
tail and your logs/metrics see the same emissions:

```ts
import {
  RingBufferEvents, composeEvents, consoleJsonEvents, SyncularAdmin,
} from '@syncular/server';

const ring = new RingBufferEvents({ capacity: 1000 });
const config: SyncServerConfig = {
  schema, storage, segments, resolveScopes,
  events: composeEvents(ring, consoleJsonEvents()), // both see every event
};
const admin = SyncularAdmin.fromConfig(config, { ring });
```

### Query surface

Every method is read-only and partition-scoped:

| Method | Returns |
| --- | --- |
| `listClients(partition)` | Known clients: `clientId`, `actorId`, `cursor`, `updatedAtMs`, `subscriptions[]`, and an `active` flag (cursor touched within the §4.6 active window). |
| `listCommits(partition, {afterSeq?, limit?, table?})` | Commit-log **metadata** (never payloads), newest first: `commitSeq`, `clientId`, `clientCommitId`, `actorId`, `createdAtMs`, `changeCount`, `tables[]`. |
| `inspectRow(partition, table, rowId)` | `{exists, serverVersion?, scopes?}` — current row version + stored scopes, payload **not** decoded. |
| `scopeActivity(partition, {variable, value}, {limit?})` | Recent commits touching one scope key, via the §3.1 change-scope index (never a log scan). |
| `horizonStatus(partition)` | `{maxCommitSeq, horizonSeq, retainedCommits, activeCursorFloor, recommendedHorizonSeq, recommendation}` — the horizon a prune pass would reach now (§4.6) + a coarse `up-to-date` / `prune-recommended`. |
| `segmentStats()` / `blobStats(partition)` / `stats(partition)` | Counts/bytes where the stores expose them (segments split rows/sqlite). `undefined` when a store omits `stats()`. |
| `events({type?, sinceMs?, limit?})` | The ring tail, newest first. Empty when no ring is wired (`hasEventStream` reports which). |

The query surface leans on **additive, optional** storage/store methods
(`ServerStorage.listClientRecords` / `listCommitMetadata` / `scopeActivity` /
`getRowScopes`; `SegmentStore.stats`; `BlobStore.stats`) — the established
optional-method pattern. `SqliteServerStorage`, `PostgresServerStorage`,
`D1ServerStorage`, and the memory/sqlite stores implement them; the shared
`ServerStorage` contract suite exercises them on all backends. A backend that
omits one makes the corresponding admin read fail loud (it never returns a
silently-empty console). The `S3SegmentStore` **does** report `stats()` — from
a LIST-free pointer-object accumulator (see "S3 stats" below) — but its
counters are marked `approximate: true`, an additive field the admin surface
carries through so the console can label them honestly. The exact in-process
stores (memory/sqlite) omit the marker.

### HTTP routes + the single console page

`@syncular/server-hono` exports `createSyncularAdminRoutes(admin, opts)`,
a mountable Hono sub-app. **The auth seam is required**: the factory throws
if you omit the `authorize` guard — there is no default-open admin. Every
endpoint (including the page) runs the guard first; a falsy result is a 401.

```ts
import { createSyncularAdminRoutes } from '@syncular/server-hono';

const routes = createSyncularAdminRoutes(admin, {
  defaultPartition: 'main',
  authorize: ({ request }) => isOperator(request), // YOUR check — mandatory
});
app.route('/admin', routes);
```

| Route | Mirrors |
| --- | --- |
| `GET /` | The console page (see below). |
| `GET /clients` | `listClients` |
| `GET /commits?afterSeq&limit&table` | `listCommits` |
| `GET /rows/:table/:rowId` | `inspectRow` |
| `GET /scope-activity?variable&value&limit` | `scopeActivity` |
| `GET /horizon` | `horizonStatus` |
| `GET /stats` | `stats` |
| `GET /events?type&sinceMs&limit` | `events` (ring tail) |

`?partition=` selects the partition (falls back to `defaultPartition`).

`GET /` (or `/admin`) serves a **single static HTML page** — zero
framework, no build step, no React. It fetches the sibling JSON endpoints
(relative to its own mount path, so it works under any prefix and the same
guard covers its XHRs), renders tables for horizon, store stats, clients,
recent commits, and the event tail, with an auto-refresh toggle (2 s poll).
This is the ~300-line answer to v1's console app: 5% of the code, the 80%
operator value.

**No SSE (yet).** `GET /events` is a polled ring query; the page's
auto-refresh polls it. Server-Sent-Events streaming was deliberately
skipped for this rung — the ring is pull-only, so SSE would need a
push-notification path from the sink into open connections (extra
machinery for marginal benefit at admin cadence). Polling is the right
rung; SSE is a noted follow-up.

The demo server (`apps/demo`) mounts the admin behind a dev guard:
`SYNCULAR_DEMO_ADMIN=1` enables `/admin` (optionally token-gated with
`SYNCULAR_DEMO_ADMIN_TOKEN`), so the console is inspectable live.

> Docs-site coverage of the console is a follow-up: the docs app is owned
> by a concurrent workstream this round (the schema-bump page), so this
> README is the console's documentation home for now.

## Segment storage on S3 / R2 (`S3SegmentStore`)

Three `SegmentStore` backends ship in-tree and pass one shared contract
suite (`test/segment-store-contract.ts`): `MemorySegmentStore` (tests,
single process), `SqliteSegmentStore` (single node), and
`S3SegmentStore` — the production backend for any S3-compatible object
store (AWS S3, Cloudflare R2, MinIO). It is dependency-free: SigV4 is
hand-rolled over `fetch` (`sigv4.ts`, pinned by the published AWS test
vectors).

```ts
import { S3SegmentStore, s3PresignedUrls } from '@syncular/server';

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

### S3 stats — a LIST-free, approximate accumulator

`S3SegmentStore.stats()` reports store-wide `{count, bytes, rowsSegments,
sqliteSegments}` for the admin console **without a bucket LIST** — a LIST
would defeat the store's whole every-lookup-is-a-GET/HEAD design and cost
real money at scale. Instead the store keeps a tiny counter object under a
fixed key (`{keyPrefix}stats/segments.json`) and folds each new segment into
it read-modify-write on `put`. A `HEAD` before the segment PUT detects an
idempotent re-put (same content address ⇒ same key), so each distinct
segment is counted once.

The accumulator write is guarded by an **ETag compare-and-swap** — `If-Match`
against the ETag we read (or `If-None-Match: *` to create) — and the store
retries on a `412 PreconditionFailed`, so two writers folding concurrently do
not silently clobber each other's increment. AWS S3 and Cloudflare R2 both
honor these conditional headers.

Even so, the counters are **approximate**, and `stats()` marks them
`approximate: true` (an additive field the admin surface carries through, so
`admin.segmentStats()` / `admin.stats()` expose it and the console labels the
numbers honestly). They can drift: a crash between the segment PUT and the
accumulator CAS, lifecycle GC deleting objects the accumulator still counts,
or enough concurrent writers to exhaust the CAS retry budget. They are a
health gauge, not an invoice — reconcile against a periodic inventory report
if you need an exact number. The exact in-process stores (memory / sqlite)
count on demand and omit the marker.

The blob store's `stats()` uses the same accumulator + `approximate: true`
marker (see "Blob bytes on S3 / R2" below).

## Blob bytes on S3 / R2 (`S3BlobStore`)

File-attachment bytes (§5.9) get the same object-store backend as segments.
`S3BlobStore` is the blob twin of `S3SegmentStore` — same hand-rolled SigV4,
same content-addressed key layout, same LIST-free-on-the-hot-path stats
accumulator — for AWS S3, Cloudflare R2, or MinIO. It closes the
"attachments are SQLite-only" gap: a Workers/edge or horizontally-scaled
deployment can now store blobs durably in an object store instead of the
database.

```ts
import { S3BlobStore, s3PresignedBlobUrls } from '@syncular/server';

const blobs = new S3BlobStore({
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  region: 'us-east-1',
  bucket: 'my-attachments',
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECRET_ACCESS_KEY,
  keyPrefix: 'syncular/', // optional namespace inside the bucket
});

const config: SyncServerConfig = {
  // …schema, storage, segments, resolveScopes…
  blobs,
  // Optional: serve blob downloads as provider-presigned URLs (§5.9.5).
  blobSignedUrls: s3PresignedBlobUrls(blobs, { ttlSeconds: 900 }),
};
```

**Cloudflare R2.** Identical to the segment store — point `endpoint` at
`https://<account-id>.r2.cloudflarestorage.com`, `region: 'auto'`, and use an
R2 API-token access-key pair. R2 honors the SigV4 header/query auth and the
`ListObjectsV2` the sweep uses.

**Key layout.** `{keyPrefix}blob/{partition}/sha256/{hex}` — content-addressed
and **partition-scoped** (the same bytes uploaded under two partitions are two
objects; a partition cannot read another's attachment by guessing a content
address). The object body is the blob bytes **verbatim**, so a presigned GET
serves exactly the content-addressed bytes and the client's §5.9.1 hash check
passes. `byteLength` + optional `mediaType` + `createdAtMs` ride along as
object user metadata (`x-amz-meta-syncular-blob` = base64url(JSON)), so `get`
is a single GET.

### Durability, not TTL — the difference from segments

This is the honest interface difference from `S3SegmentStore`. **Segments are
TTL cache entries; blobs are durable.** A blob referenced by a live row must
stay downloadable **indefinitely** (§5.9.5 B3). So `S3BlobStore` writes **no
`expiresAtMs`, has no `ttlMs` config, and maps to no S3 lifecycle-expiration
rule.** Reclamation is **reference-driven, not time-driven**: the only thing
that deletes a blob is the orphan sweep, and it deletes only blobs *no live
row references*.

> **Do NOT put an S3/R2 lifecycle-expiration rule on the `blob/` prefix.** It
> would delete still-referenced attachments out from under live rows. This is
> the exact opposite of the segment guidance (where lifecycle expiration above
> `ttlMs` is *encouraged* as GC). Blobs are cleaned by the sweep below.

### Orphan sweep (the GC runbook)

Nothing reclaims blobs automatically — the host schedules the sweep, the blob
analogue of `pruneCommitLog`. `sweepOrphanBlobs(storage, blobStore, partition,
{ graceMs })` reads the live keep-set from the §5.9.4 reference index
(`storage.listReferencedBlobIds`) and deletes every blob that is **both**
unreferenced **and** older than the grace period. It emits one `blob.swept`
ops event (`{ swept, referenced, graceMs }`) and returns the deleted ids.

```ts
import { sweepOrphanBlobs } from '@syncular/server';

// A periodic per-partition GC job (hourly to daily is sensible).
const { swept } = await sweepOrphanBlobs(storage, blobs, partition, {
  graceMs: 24 * 60 * 60 * 1000, // default; see the race note below
  events,
});
```

**The grace period is not optional cleverness — it is the correctness
mechanism.** Uploads are *content-addressed and land before the referencing
push* (§5.9.2 upload-before-reference): a client `PUT`s the bytes, then pushes
the row. Between those two steps the blob is legitimately **unreferenced**. If
the sweep ran with no grace it would delete that fresh upload before its push
arrived. So the grace period must comfortably exceed any sane upload→push
latency — the **default is 24 h**, deliberately far above any push window.
Lower it only if you fully understand your clients' outbox latency; there is
no upside to a tight grace and a real data-loss risk. The sweep compares
against the blob's **upload time** (`createdAtMs` from object metadata), and an
idempotent re-upload does **not** reset that clock.

`sweepOrphanBlobs` **requires** `storage.listReferencedBlobIds` (the §5.9.4
reference index — SQLite, D1, and Postgres all implement it). Against a
storage without it, the helper throws rather than sweep with an empty keep-set
(which would delete everything). The `S3BlobStore` sweep is the store's **only
LISTing operation** — it pages `ListObjectsV2` over the partition's `blob/`
prefix, an admin/GC path off the hot path; every point lookup is still a
GET/HEAD.

### Blob stats — the same approximate accumulator

`S3BlobStore.stats()` reports store-wide `{count, bytes}` from a fixed counter
object (`{keyPrefix}stats/blobs.json`) folded read-modify-write on `put` under
the same ETag compare-and-swap as segments, and marks the result
`approximate: true` (the marker already present on `BlobStoreStats`, carried
through `admin.blobStats()`). A `HEAD` before the PUT detects an idempotent
re-upload so distinct blobs count once; the sweep decrements on delete. Same
caveats as segment stats — a health gauge, not an invoice. The in-process
stores (memory / sqlite) count on demand and omit the marker.

### Presigned blob downloads (§5.9.5)

Setting `blobSignedUrls: s3PresignedBlobUrls(blobs)` makes the server issue a
provider-presigned GET URL for a blob download — **but only after the
row-derived authorization check passes** (`handleBlobDownload` resolves the
actor's scopes and tests the referencing rows first; a `blobId` is never a
bearer capability minted from the id alone). The signed object key embeds the
`blobId`, TTL SHOULD be ≤ 15 min (default 900 s), and the URL is a short-lived
grant to exactly those immutable bytes. The issued `url`/`urlExpiresAtMs` ride
additively on `BlobDownloadResult` alongside the bytes; the mounted §5.9.5
direct-download endpoint stays the default serving path. Client consumption of
the presigned URL (following it instead of streaming bytes through the sync
server) is a later rung — the server-side issuance ships now.

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

## Postgres storage (the production database path)

`SqliteServerStorage` (bun:sqlite) is the dev-speed default. For
production, `PostgresServerStorage` implements the same `ServerStorage`
contract against Postgres, with the inverted scope index carried through
as **covering indexes** so scope fanout is an index range scan, never a
scan-before-LIMIT (REVISE B2 — this was v1's production wound). The
schema (`POSTGRES_DDL`) and its index design live in
`src/postgres-storage.ts`; `storage.migrate()` applies it idempotently
(every DDL is `CREATE … IF NOT EXISTS`, run statement-by-statement, so
`migrate()` is safe to call on every boot).

**Blobs (§5.9.4) on Postgres.** `PostgresServerStorage` implements the
optional blob-reference index — `setBlobRefs` (in the commit transaction)
plus `listRowsReferencingBlob` / `listReferencedBlobIds` — at full parity
with the SQLite and D1 storages. The `sync_blob_refs` table keys
`(partition, tbl, row_id, blob_id)` and carries a secondary
`(partition, blob_id)` index that drives the §5.9.5 download-authorization
candidate set as an index range (asserted in `postgres-explain.test.ts`, same
no-`Seq Scan` doctrine as the scope indexes). So a Bun/Node **or** Workers
deployment on Postgres supports file attachments end-to-end: push writes the
row's references atomically with the commit, and the blob-download handler
authorizes via the reference index. The shared `ServerStorage` contract runs
its blob section on pglite alongside sqlite and D1.

### The `PgExecutor` seam (zero runtime deps)

The server library never imports a Postgres driver. `PostgresServerStorage`
is written against the minimal `PgExecutor` interface (`query(text, params)`
plus a `transaction(fn)` scope) — you wire your driver of choice:

**Bun.sql** (built into bun):

```ts
import {
  PostgresServerStorage,
  type PgExecutor,
  type PgQueryable,
} from '@syncular/server';

function bunSqlExecutor(sql: import('bun').SQL): PgExecutor {
  const over = (h: any): PgQueryable => ({
    async query(text, params) {
      const rows = await h.unsafe(text, params ? [...params] : []);
      return { rows, rowCount: rows.length };
    },
  });
  return {
    query: over(sql).query,
    transaction: (fn) => sql.begin((tx: any) => fn(over(tx))),
    close: () => sql.end(),
  };
}

const storage = new PostgresServerStorage(
  bunSqlExecutor(new Bun.SQL(process.env.DATABASE_URL!)),
);
await storage.migrate();
```

**node-postgres** (`pg`) — adapt a `Pool`:

```ts
import { Pool, type PoolClient } from 'pg';
import { PostgresServerStorage, type PgExecutor } from '@syncular/server';

function pgPoolExecutor(pool: Pool): PgExecutor {
  const over = (c: Pool | PoolClient) => ({
    query: (text: string, params?: readonly unknown[]) =>
      c.query(text, params ? [...params] : []),
  });
  return {
    query: over(pool).query,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(over(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
```

**Type-parser note.** `commit_seq`/`server_version` are `int8`. Drivers
decode `int8` differently (node-postgres → `string`, Bun.sql → `bigint`,
pglite → `number`); the storage layer coerces every sequence read through
`Number(...)`, so no driver-specific type-parser config is required.
`bytea` must decode to `Uint8Array`/`Buffer` (all three do).

**Tests** wire `@electric-sql/pglite` (embedded WASM Postgres, a
devDependency — hermetic, no docker) via `pgliteExecutor` from
`@syncular/server/pglite`. Both backends run the shared
`ServerStorage` contract (`test/storage-contract.ts`), and
`test/postgres-explain.test.ts` asserts via `EXPLAIN` that the fanout
candidate scans are index-driven so the scan-before-LIMIT regression
cannot silently return.

### commitSeq allocation under concurrency

Per-partition `commitSeq` is dense and gap-free (§2.1). `appendCommit`
allocates it with `UPDATE sync_partitions SET max_commit_seq =
max_commit_seq + 1 … RETURNING`, which takes a row-level write lock on the
partition row for the transaction's duration — concurrent pushes to the
same partition serialize on that row; cross-partition pushes never
contend. A Postgres `SEQUENCE` is deliberately **not** used: it would leave
gaps on rollback, which the §4.5 pull-window arithmetic does not tolerate.

### Multi-instance fanout (LISTEN/NOTIFY)

Behind a load balancer, a commit applied on instance A fans out to A's
local realtime sessions in-memory, but a client whose socket lives on
instance B never sees it. `PostgresFanout` bridges the gap: after a commit
lands, the originating instance `NOTIFY`s `syncular_commit` with a
`<partition>:<commitSeq>` payload; every instance runs a `listen()` loop
that, on a notification, calls `hub.wake(partition, 'catchup-required')` —
remote sessions then pull the delta from the shared Postgres storage they
already read from (§8.3). NOTIFY payloads are capped (~8 KB) and are not an
ordered delta channel, so we wake rather than re-broadcast bytes; only
cross-instance delivery pays the re-pull. Single-instance deployments
install no fanout at all.

```ts
import { PostgresFanout, type PgNotificationConnection } from '@syncular/server';

// node-postgres: a dedicated Client for LISTEN + the pool for NOTIFY.
const conn: PgNotificationConnection = {
  async listen(channel, handler) {
    const client = await pool.connect(); // long-lived, NOT released
    client.on('notification', (m) => m.payload && handler(m.payload));
    await client.query(`LISTEN ${channel}`);
  },
  notify: (channel, payload) =>
    pool.query('SELECT pg_notify($1, $2)', [channel, payload]).then(() => {}),
};
const fanout = new PostgresFanout(conn);
await fanout.install(hub); // start the LISTEN loop
// after a push commit lands:
await fanout.notifyCommit(partition, commitSeq);
```

pglite is single-connection and cannot exercise cross-connection NOTIFY,
so the fanout integration test is env-gated on `SYNCULAR_PG_URL` (it wires
Bun.sql as a worked example) and skips cleanly; the payload encode/parse
and wake wiring are unit-tested hermetically.

### Bench lane

`bench` has an env-gated Postgres lane measuring 100k bootstrap +
propagation on the production path. It runs only with `SYNCULAR_PG_URL`
set and is **never** part of `bench:ci` budgets (those stay on the
deterministic in-process sqlite loopback):

```sh
SYNCULAR_PG_URL=postgres://user:pass@localhost:5432/db bun run bench
```
