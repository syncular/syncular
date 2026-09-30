# Bootstrap & segments

When a client subscribes with no cursor, it **bootstraps**: it downloads a
snapshot of the current state of its scoped rows, which is far cheaper than
replaying the whole commit log. Bootstrap data travels as **segments**:
content-addressed, scope-bound snapshot artifacts.

Normative detail: [SPEC.md §4.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#47-bootstrap-state-machine) and
[§5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5-bootstrap-segments-and-the-download-endpoint).

## The segment

A **segment** is
content-addressed (its id is the SHA-256 of its bytes), scope-bound, and
carries a `mediaType`:

| `mediaType` | What it is | When |
|---|---|---|
| `rows` | A columnar block of encoded rows | Mandatory-to-implement fallback; small tables ship inline |
| `sqlite` | A prebuilt SQLite database image | The preferred lane; the client copies whole tables in |

The client attaches a SQLite image and imports primary-key ranges of at most
1,024 rows per transaction. The server builds each image once per scope set and
snapshot pin and reuses it for clients requesting the same snapshot.

## Reads during import

Imports yield automatically after each committed rows block or SQLite image
chunk. Local queries can read that committed prefix while later chunks import.
The client restores pending optimistic edits before publishing each revision.
Rust reconciles imported rows and pending row identities under secondary unique
constraints without rebuilding unrelated tables. Each chunk restores the imported
rows and rows touched by pending operations, then replays those operations.
Window coverage stays pending until the subscription checkpoint commits; render
partial results using the query's coverage state.

An interrupted import preserves earlier committed chunks and leaves the
subscription checkpoint incomplete. Retry clears the fresh snapshot's scope in
its first transaction and reapplies the snapshot. A failing chunk rolls back its
rows, search index changes, and revision together. Malformed image primary keys
and mismatched applied row counts fail the import without advancing its checkpoint.

Chunk size bounds imported rows, not transaction duration. A first-page scope
clear, large rows, constraints, and storage latency can extend a transaction.
Native hosts that serialize reads behind sync commands need a separate read
connection to serve reads during sync.

`syncUntilIdle()` continues through nonempty bootstrap pages that advance durable
resume state. Rounds without that progress consume a 20-round budget; an explicit
round limit remains a hard cap. Exhaustion reports `sync.invalid_request`.

## Where segments are delivered

Segments are the CDN/bulk path and are delivered over HTTP only, by design;
the sync socket stays free of bulk data. Three delivery shapes, negotiated
by the client's `accept` bitmask
([SPEC §4.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#42-pull_header-frame)):

- **Inline**: small rows segments are included in the sync response, saving a
  second round-trip.
- **Direct download**: the client fetches `<mount>/segments/{id}`, which
  re-authorizes on every request ([SPEC §5.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#55-the-direct-download-endpoint)).
- **Signed URL**: the descriptor carries a short-lived URL (native HMAC or
  S3/R2 presign); the client fetches it with no host credentials, so server
  egress for cold starts approaches zero
  ([SPEC §5.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#54-signed-url-segment-delivery)).

The client verifies every segment's content address after download and applies
it in one transaction per rows block or image chunk. Bootstrap is resumable and paged, pinned to
the `commitSeq` at which it started.

## Compression

Segment bytes are content-addressed **uncompressed**; compression is a
transport/storage concern (zstd preferred, gzip fallback) and is invisible on
the wire ([SPEC §5.8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#58-compression)).
Clients rely on native fetch decoding, so no decompression code ships in the
client bundle.

## Publishing images from another host

A Workers host has no SQLite engine, so it cannot build images; it serves an
image only when one is already stored under the key its pull looks up (table,
schema version, scope digest, log epoch, pin). A bootstrap on the sqlite lane
pins at its **scope pin**: the newest commit that changed a row in its scope, capped
at the round's `maxCommitSeq` and raised to the pruning horizon
([SPEC §4.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#47-bootstrap-state-machine)).
Commits to other tables or other scopes leave the pin, and so the stored
image, current.

`publishSqliteImage` stores that image from a host that has an engine, such
as a Bun process with the production PostgreSQL storage and the segment store
the serving host reads:

```ts
import { publishSqliteImage, S3SegmentStore } from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';

const segments = new S3SegmentStore({ ...r2, ttlMs: 30 * 24 * 60 * 60 * 1000 });
const image = await publishSqliteImage({
  config: { ...syncConfig, segments, sqliteImageBuilder: buildSqliteImage },
  partition: 'main',
  table: 'catalogue_codes',
  scopes: { catalogue_set_id: [catalogueSetId] },
});
// { segmentId, asOfCommitSeq, scopeDigest, rowCount, byteLength, origin }
```

It runs the pull's own bootstrap path, so the stored identity is exactly the
one a serving pull finds; `origin` is `reused` when the current image already
exists. `scopes` are the effective scopes the subscribing clients hold: publish
once per distinct scope set. The image lives for the segment store's `ttlMs`
at publication; publish again after every change to the scope and before the
TTL runs out. A change to the scope moves the pin, and until the next
publication the serving host answers on the rows lane.

`GET /segments/:id` relays a segment above 16 MiB as a stream, gzip-encoded
when the client accepts it, when the segment store implements `open`
(`S3SegmentStore` and `MemorySegmentStore` do). A custom store without `open`
is read whole into memory. With `signedUrls: s3PresignedUrls(store)`, image
descriptors carry a presigned URL and clients download from the bucket
directly.

## Setting it up

The sqlite-image path and signed URLs are opt-in on the server side (a segment
store plus, for signed URLs, a signer). See [Server setup](/guide-server/) for
`MemorySegmentStore` / `SqliteSegmentStore` / `S3SegmentStore` and the CDN
story.
