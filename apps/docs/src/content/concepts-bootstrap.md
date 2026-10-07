# Bootstrap & segments

A client that subscribes with no cursor **bootstraps**: it downloads a snapshot of the current state of its scoped rows, which costs far less than replaying the commit log. The snapshot travels as **segments**. This page is for developers who want to know what a new client downloads, how the download resumes and stays readable, and what the server must provide.

::meta{for="App developers and server operators" time="8 minutes" first="concepts-subscriptions" spec="4.7 5"}

:::terms
- **Bootstrap**: The first sync of a subscription: a snapshot at one `commitSeq`, then ordinary pulls.
- **Segment**: A content-addressed, scope-bound snapshot artifact. Its id is the SHA-256 of its bytes.
- **`rows` segment**: A columnar block of encoded rows. The mandatory-to-implement fallback.
- **`sqlite` segment**: A prebuilt SQLite database image. The preferred lane.
- **Signed URL**: A short-lived URL in a segment descriptor, fetched without host credentials.
:::

:::figure{title="How a new subscription bootstraps" note="Pinned to one commitSeq" ticks}
<div class="d-row">
<div class="node"><span class="t">1 · Pull</span>Cursor -1 and the subscription's effective scopes</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">2 · Descriptors</span>Server answers with segment descriptors, in pages</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">3 · Download</span>Inline, direct, or signed URL; client verifies the hash</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">4 · Apply</span>One transaction per rows block or image chunk; cursor set at the end</div>
</div>

::caption[After the last page, the subscription is caught up and receives ordinary commits above its cursor.]
:::

## The segment

A segment is content-addressed, scope-bound, and carries a `mediaType`.

| `mediaType` | What it is | When |
|---|---|---|
| `rows` | A columnar block of encoded rows | The mandatory fallback. Small tables ship inline. |
| `sqlite` | A prebuilt SQLite database image | The preferred lane. The client copies whole tables in. |

The client attaches a SQLite image and imports primary-key ranges of at most 1,024 rows per transaction. The server builds each image once per scope set and snapshot pin and reuses it for every client that requests the same snapshot.

## Where segments are delivered

Segments are the CDN and bulk path. They travel over HTTP only, so the sync socket carries no bulk data. The client's `accept` bitmask negotiates one of three shapes ([SPEC §4.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#42-pull_header-frame)).

:::figure{title="Three delivery shapes"}
<div class="d-cols-3">
<div class="node"><span class="t">Inline</span>Small rows segments ride in the sync response and save a round trip.</div>
<div class="node cool"><span class="t">Direct download</span>The client fetches <code>&lt;mount&gt;/segments/{id}</code>. The server re-authorizes every request (<a href="https://github.com/syncular/syncular/blob/main/docs/SPEC.md#55-the-direct-download-endpoint">SPEC §5.5</a>).</div>
<div class="node ok"><span class="t">Signed URL</span>The descriptor carries a short-lived URL (native HMAC or S3/R2 presign). Server egress for cold starts approaches zero (<a href="https://github.com/syncular/syncular/blob/main/docs/SPEC.md#54-signed-url-segment-delivery">SPEC §5.4</a>).</div>
</div>
:::

The client verifies every segment's content address after download and applies it in one transaction per rows block or image chunk. Bootstrap is resumable, paged, and pinned to the `commitSeq` at which it started.

Segment bytes are content-addressed uncompressed. Compression is a transport and storage concern (zstd preferred, gzip fallback) and does not appear on the wire ([SPEC §5.8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#58-compression)). Clients rely on native fetch decoding, so the client bundle ships no decompression code.

Segment transfer errors omit request URLs, including signed paths, and raw exception messages. They report a static message with `causeKind` and optional `httpStatus` details ([transfer failures](/concepts-blobs/#transfer-failures)).

## Reading during import

The import yields after each committed rows block or image chunk, so local queries can read the committed prefix while later chunks import. The client restores pending optimistic edits before it publishes each revision. Window coverage stays pending until the subscription checkpoint commits, so render partial results with the query's coverage state.

- **Interruption.** An interrupted import keeps earlier committed chunks and leaves the subscription checkpoint incomplete. The retry clears the fresh snapshot's scope in its first transaction and applies the snapshot again.
- **Failure.** A failing chunk rolls back its rows, search index changes, and revision together. Malformed image primary keys and mismatched applied row counts fail the import without advancing its checkpoint.
- **Rust.** The Rust core reconciles imported rows and pending row identities under secondary unique constraints without rebuilding unrelated tables. Each chunk restores the imported rows and the rows touched by pending operations, then replays those operations.
- **Transaction time.** Chunk size bounds imported rows. A first-page scope clear, large rows, constraints, and storage latency can extend a transaction's duration. A native host that serializes reads behind sync commands needs a separate read connection to serve reads during sync.

## Running rounds until idle

`syncUntilIdle()` continues through nonempty bootstrap pages that advance durable resume state. Rounds without that progress consume the default budget of 20 rounds. An explicit round limit is a hard cap and must be an integer in `1..=4294967295`.

When the budget runs out, the call returns a partial-success result. The result keeps the aggregate report of every round that ran and reports `budgetExhausted: true`. It does not claim the run is idle and does not raise `sync.invalid_request`. A transport or protocol failure still fails the call.

The aggregate accumulates counters and outcomes, while readiness state (`bootstrapping`, `deferredCommits`, `schemaFloor`) describes the latest round, so an empty `bootstrapping` list alone does not establish readiness. The direct-client scheduler and the worker auto-sync loop schedule another batch when the budget runs out, without waiting for a new write or realtime notification.

## Advanced: server image construction and publishing

The sqlite-image path and signed URLs are opt-in on the server. They need a segment store (`MemorySegmentStore`, `SqliteSegmentStore`, or `S3SegmentStore`) and, for signed URLs, a signer. [Server setup](/guide-server/) covers the stores and the CDN setup.

### Opting into image construction

Bun and Node hosts import `buildSqliteImage` from `@syncular/server/sqlite` and set `sqliteImageBuilder: buildSqliteImage` in the server config. Set the same field in the realtime hub config when the hub serves sync rounds. The neutral `@syncular/server` entry never loads a runtime-specific builder.

Without a builder, the server can reuse a matching stored SQLite image. Cold bootstraps use inline or external rows according to the client's accepted formats, and configured signed URLs remain available for external rows.

### Publishing images from another host

A Workers host has no SQLite engine and cannot build images. It serves an image only when one is already stored under the key its pull looks up: table, schema version, scope digest, log epoch, and pin. A bootstrap on the sqlite lane pins at its **scope pin**: the newest commit that changed a row in its scope, capped at the round's `maxCommitSeq` and raised to the pruning horizon ([SPEC §4.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#47-bootstrap-state-machine)). Commits to other tables or other scopes leave the pin, and so the stored image, current.

`publishSqliteImage` stores that image from a host that has an engine, such as a Bun process with the production PostgreSQL storage and the segment store the serving host reads.

```ts title="scripts/publish-image.ts"
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

`publishSqliteImage` runs the pull's own bootstrap path, so the stored identity is the one a serving pull finds. `origin` is `reused` when the current image already exists. `scopes` are the effective scopes the subscribing clients hold: publish once per distinct scope set. The image lives for the segment store's `ttlMs` at publication, so publish again after every change to the scope and before the TTL runs out. A change to the scope moves the pin, and until the next publication the serving host answers on the rows lane.

### Streaming large segments

`GET /segments/:id` relays a segment above 16 MiB as a stream, gzip-encoded when the client accepts it, when the segment store implements `open` (`S3SegmentStore` and `MemorySegmentStore` do). The server reads a custom store without `open` whole into memory. The route marks every body it encodes with `encodeBody: 'manual'`, so workerd delivers it once, and a Workers host needs no wrapper of its own. With `signedUrls: s3PresignedUrls(store)`, image descriptors carry a presigned URL and clients download from the bucket directly.
