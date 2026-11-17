# Bootstrap & segments

A new [unit](/concepts-subscriptions/#a-unit) **bootstraps**: the client downloads a snapshot of the current rows of every table the unit covers, which costs far less than replaying the commit log. The snapshot travels as **segments**. This page is for developers who want to know what a new client downloads, how the download resumes and stays readable, and what the server must provide.

::meta{for="App developers and server operators" time="8 minutes" first="concepts-subscriptions" spec="4.7 5"}

:::terms
- **Bootstrap**: The first sync of a unit: a snapshot of its covered tables pinned at one `commitSeq`, then the unit joins the live set.
- **Segment**: A content-addressed, scope-bound snapshot artifact. Its id is the SHA-256 of its bytes.
- **`rows` segment**: A columnar block of encoded rows. The mandatory-to-implement fallback.
- **`sqlite` segment**: A prebuilt SQLite database image. The preferred lane.
- **Signed URL**: A short-lived URL in a segment descriptor, fetched without host credentials.
:::

:::figure{title="How a new unit bootstraps" note="Pinned to one commitSeq" ticks}
<div class="d-row">
<div class="node"><span class="t">1 · Pull</span>The unit with cursor -1; the server resolves its effective scopes</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">2 · Descriptors</span>Server answers with segment descriptors, in pages</div>
<span class="d-arrow"></span>
<div class="node hot"><span class="t">3 · Download</span>Inline, direct, or signed URL; client verifies the hash</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">4 · Apply</span>One transaction per rows block or image chunk; the unit's cursor set at the end</div>
</div>

::caption[After the last page, the unit catches up from its pin and joins the live set: from then on the replica cursor covers it.]
:::

## The segment

A segment is content-addressed, scope-bound, and carries a `mediaType`.

| `mediaType` | What it is | When |
|---|---|---|
| `rows` | A columnar block of encoded rows | The mandatory fallback. Small tables ship inline. |
| `sqlite` | A prebuilt SQLite database image | The preferred lane. The client copies whole tables in. |

The client attaches a SQLite image and imports it in primary-key order. The first transaction of a table holds 1,024 rows, and a later [range image](#range-images) of the table continues at the size the transactions before it reached. Each later one holds at least 1,024 rows, at most twice the rows of the one before, at most 65,536, and at most the rows the one before applied per 250 ms from its start to its commit; while local writes to the table wait for replay, a transaction holds at most 1,024 rows ([SPEC §5.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#53-sqlite-segments-mediatype--sqlite--premier-path)). Each commit rewrites the pages of the table's secondary indexes, so fewer commits write less: 67,302 + 87,267 catalogue rows (351 MB of images, two secondary indexes per table) import into an OPFS replica in Chromium in 1,645 ms with 317 MB written, against 4,287 ms and 1.16 GB with 1,024-row transactions (`bench/src/image-import-lane.ts`, Apple M5 Pro). Journaling and `synchronous=FULL` stay on, because the replica file also holds the outbox. After the last transaction, a WAL replica truncates its `-wal` file. The server builds each image once per scope set and snapshot pin and reuses it for every client that requests the same snapshot.

### Range images

The server cuts a table's image into **range images** of at most `maxImageSegmentBytes` each (default 32 MiB, [server limits](/guide-server/#request-limits)). Each range image is a complete SQLite file holding a contiguous run of the table's rows in row order, and a row larger than the bound gets an image of its own. A pull delivers up to `maxSnapshotPages` range images per unit (default 4), each counting as one page, and the next pull continues at the next range through the resume token. Only the table's first range clears the unit's scope; every range applies in its own transactions and its row count is checked on its own ([SPEC §5.3](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#53-sqlite-segments-mediatype--sqlite--premier-path)).

The client holds at most two image bodies at once, the one it applies and the next one downloading, so its peak memory follows `maxImageSegmentBytes` and not the table size. The Rust core downloads at most two images per round and leaves the rest of the section to the next round. A download that fails repeats only that image: the client remembers which segments it applied since the unit's last checkpoint and skips them when the next pull serves them again. 67,302 + 87,267 catalogue rows (351 MB of images) bootstrap into an OPFS replica in Chromium with a peak renderer memory of 434 to 490 MiB as 32 MiB range images, against 1,310 to 1,351 MiB as one image per table, and in 1.6 to 1.7 s against 1.5 s (`bench/src/image-range-lane.ts`, Apple M5 Pro).

## Where segments are delivered

Segments are the CDN and bulk path. They travel over HTTP only, so the sync socket carries no bulk data. The client's `accept` bitmask negotiates one of three shapes ([SPEC §4.2](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#42-pull_header-frame)).

:::figure{title="Three delivery shapes"}
<div class="d-cols-3">
<div class="node"><span class="t">Inline</span>Small rows segments ride in the sync response and save a round trip.</div>
<div class="node cool"><span class="t">Direct download</span>The client fetches <code>&lt;mount&gt;/segments/{id}</code>. The server re-authorizes every request (<a href="https://github.com/syncular/syncular/blob/main/docs/SPEC.md#55-the-direct-download-endpoint">SPEC §5.5</a>).</div>
<div class="node ok"><span class="t">Signed URL</span>The descriptor carries a short-lived URL (native HMAC or S3/R2 presign). Server egress for cold starts approaches zero (<a href="https://github.com/syncular/syncular/blob/main/docs/SPEC.md#54-signed-url-segment-delivery">SPEC §5.4</a>).</div>
</div>
:::

The client verifies every segment's content address after download and applies it in one transaction per rows block or image chunk. The Rust core runs consecutive frames and blocks of one response as savepoints of one transaction of at most 1,024 rows and publishes their change batches after it commits ([SPEC §1.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#14-streaming-contract)), so a response with many small sections pays for one SQLite commit. Bootstrap is resumable, paged, and pinned to the `commitSeq` at which it started.

Segment bytes are content-addressed uncompressed. Compression is a transport and storage concern (zstd preferred, gzip fallback) and does not appear on the wire ([SPEC §5.8](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#58-compression)). Clients rely on native fetch decoding, so the client bundle ships no decompression code. A client stops reading a segment body once it exceeds the descriptor's `byteLength` and fails the round with `sync.invalid_request`.

Segment transfer errors omit request URLs, including signed paths, and raw exception messages. They report a static message with `causeKind` and optional `httpStatus` details ([transfer failures](/concepts-blobs/#transfer-failures)).

## Reading during import

The import yields after each committed rows block or image transaction, so local queries can read the committed prefix while later transactions import. An image transaction holds the worker while it runs. From the second transaction on, each holds at most the rows the one before applied in 250 ms, so a local query waits about 250 ms while row cost stays even. A catalogue of 114,007 codes with a [local FTS5 projection](/tooling-local-search/) (a 424 MB image) imports into an OPFS replica on disk in 3.0 s, in transactions of up to 345 ms. A browser profile that keeps OPFS in memory, such as a private window, slows every write as the file grows: the same import takes 64 s, and a transaction that holds 1,024 rows takes up to 881 ms. The client restores pending optimistic edits before it publishes each revision. Window coverage stays pending until the unit's checkpoint commits, so render partial results with the query's coverage state.

- **Interruption.** An interrupted import keeps earlier committed chunks and leaves the unit's checkpoint incomplete. The retry skips the segments the client applied completely since the unit's last checkpoint and applies the rest. A client that restarted in between has no record of them; it clears the snapshot's scope in the first segment's first transaction and applies the snapshot again.
- **Failure.** A failing chunk rolls back its rows, search index changes, and revision together. Malformed image primary keys and mismatched applied row counts fail the import without advancing its checkpoint.
- **Rust.** The Rust core reconciles imported rows and pending row identities under secondary unique constraints without rebuilding unrelated tables. Each chunk restores the imported rows and the rows touched by pending operations, then replays those operations.
- **Transaction time.** A transaction holds at least 1,024 rows whatever they cost, and the first one also runs the first-page scope clear. A transaction that runs past 250 ms shrinks the next one, down to 1,024 rows. A native host that serializes reads behind sync commands needs a separate read connection to serve reads during sync.

## Running rounds until idle

`syncUntilIdle()` continues through nonempty bootstrap pages that advance durable resume state. Rounds without that progress consume the default budget of 20 rounds. An explicit round limit is a hard cap and must be an integer in `1..=4294967295`.

When the budget runs out, the call returns a partial-success result. The result keeps the aggregate report of every round that ran and reports `budgetExhausted: true`. It does not claim the run is idle and does not raise `sync.invalid_request`. A transport or protocol failure still fails the call.

The round budget does not bound elapsed time, so one drive also has a total deadline: `syncUntilIdle({ timeoutMs })` (default 60,000 ms) bounds the whole drive across rounds. The client checks it on its clock before each round after the first. A drive that is past its deadline after at least one completed round ends like an exhausted round budget: it resolves with `budgetExhausted: true` and the rounds it ran, `lastRound` stays the last succeeded round, and progress does not turn `failed`. A long catch-up, such as a unit that bootstraps page by page for several minutes, therefore runs as a sequence of drives that each resume from the persisted resume token.

Each round is also bounded by `timeoutMs` on its own. A round that reaches that bound fails with the retryable `sync.idle_timeout`, the drive rejects with it, and `lastRound` and progress record the failure; a transport that never answers ends this way. The web client passes one `AbortSignal` to every transport call of a round (the second argument of a `SyncTransport`, `signal` on a segment request, the last argument of the `BlobTransport` upload calls) and aborts it at the round bound. The `http*` transports pass the signal to `fetch`. A custom transport that ignores it keeps that round outstanding until it answers, and `sync()` refuses to start another meanwhile. Pass `Infinity` to disable both bounds for a deliberately long batch. The Rust client takes the same bound with `sync_until_idle_with_deadline(&mut transport, max_rounds, Some(timeout_ms))`; `sync_until_idle` defaults to 60 s. It scopes the round bound onto the transport's round deadline, and the tighter of `timeout_ms` and the transport's own `roundDeadlineMs` applies; only an expiry of the drive's bound reports `sync.idle_timeout`.

A transport failure that reports a refused or unreachable connection (`causeKind` `connect` from the native transport, `network` from a browser `fetch`) stops the round without scheduling a background retry and leaves `syncNeeded` raised. Re-arm the drive from your own connectivity signal. In the browser, the [realtime supervisor](/platform-web-realtime/) does this: each `online` report from its connectivity signal, each failed connect attempt of its retry schedule, and each return to the foreground while no attempt starts at once run `syncUntilIdle()`, with or without realtime.

Every host loop (the direct-client scheduler, the worker auto-sync loop, the Tauri plugin and the React Native client) starts the next drive at once after one of its drives resolves with `budgetExhausted`. The direct-client scheduler and the worker auto-sync loop retry a drive that rejected with a retryable error and left no background intent, such as a `sync.idle_timeout` from a transport that ignores the abort signal: after 250 ms, doubling per further rejection up to 30,000 ms, and back to 250 ms after a drive succeeds. An unreachable endpoint is not retried this way. A round after which a unit still holds a bootstrap resume token keeps `syncNeeded` raised, so a host that stopped mid-bootstrap sees that more rounds are owed.

The aggregate accumulates counters and outcomes, while readiness state (`bootstrapping`, `deferredCommits`, `schemaFloor`) describes the latest round, so an empty `bootstrapping` list alone does not establish readiness. The direct-client scheduler and the worker auto-sync loop schedule another batch when the budget runs out, without waiting for a new write or realtime notification.

A round that applied commits or segment rows is followed by another round, because the protocol carries no "more" flag: a window cut at `limitCommits` is visible only to the next pull, and the cut can fall below the limit when the next commit would exceed it (SPEC §4.5). The last round of a run therefore usually confirms that nothing is left. A host that renders between rounds drives `syncUntilIdle(1)` (Rust: `sync_until_idle(Some(1))`) in a loop: after the round whose report has an empty `bootstrapping` list and no `resets`, every unit holds its snapshot, so the host renders and runs the confirming round afterwards.

## Advanced: server image construction and publishing

The sqlite-image path and signed URLs are opt-in on the server. They need a segment store (`MemorySegmentStore`, `SqliteSegmentStore`, or `S3SegmentStore`) and, for signed URLs, a signer. [Server setup](/guide-server/) covers the stores and the CDN setup.

### Opting into image construction

Bun and Node hosts import `buildSqliteImage` from `@syncular/server/sqlite` and set `sqliteImageBuilder: buildSqliteImage` in the server config. Set the same field in the realtime hub config when the hub serves sync rounds. The neutral `@syncular/server` entry never loads a runtime-specific builder.

Without a builder, the server can reuse a matching stored SQLite image. Cold bootstraps use inline or external rows according to the client's accepted formats, and configured signed URLs remain available for external rows.

### Publishing images from another host

A Workers host has no SQLite engine and cannot build images. It serves an image only when one is already stored under the key its pull looks up: table, schema version, scope digest, log epoch, pin, and the range's start. A bootstrap on the sqlite lane pins at its **scope pin**: the newest commit that changed a row in its scope, capped at the round's `maxCommitSeq` and raised to the pruning horizon ([SPEC §4.7](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#47-bootstrap-state-machine)). Commits to other tables or other scopes leave the pin, and so the stored image, current.

The pull reads the store only when the table's snapshot exceeds one rows page. A smaller snapshot arrives as rows, so the reuse lookup costs nothing on small tables.

`publishSqliteImage` stores that image from a host that has an engine, such as a Bun process with the production PostgreSQL storage and the segment store the serving host reads.

```ts title="scripts/publish-image.ts"
import { publishSqliteImage, S3SegmentStore } from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';

const segments = new S3SegmentStore({ ...r2, ttlMs: 30 * 24 * 60 * 60 * 1000 });
const image = await publishSqliteImage({
  config: { ...syncConfig, segments, sqliteImageBuilder: buildSqliteImage },
  partition: 'main',
  table: 'catalogue_codes',
  scopes: { catalogue_set_id: catalogueSetId },
});
// { segmentIds, asOfCommitSeq, scopeDigest, rowCount, byteLength, origin }
```

`publishSqliteImage` runs the pull's own bootstrap path, so the stored identities are the ones a serving pull finds. It stores every range image of the table and returns their ids in row order; `rowCount` and `byteLength` sum over them. `origin` is `reused` when every range image already exists. `scopes` is the unit whose clients bootstrap the table, and the unit must cover `table`. `allowed` is the allowed scopes of the actors that register the unit; it defaults to `'*'` for every declared variable, which leaves the unit's own scope map. Pass it when a wildcard fence adds variables on the table, because the fenced scopes change the image. Publish once per table, unit and distinct `allowed` map. The image lives for the segment store's `ttlMs` at publication, so publish again after every change to the scope and before the TTL runs out. A change to the scope moves the pin, and until the next publication the serving host answers on the rows lane. Give the publisher the same `maxImageSegmentBytes` as the serving host. A host serves no stored image larger than its own bound unless the image holds one row, so a whole-table image published by an earlier release arrives as rows until the next publication.

### Streaming large segments

`GET /segments/:id` relays a segment above 16 MiB as a stream, gzip-encoded when the client accepts it, when the segment store implements `open` (`S3SegmentStore` and `MemorySegmentStore` do). The server reads a custom store without `open` whole into memory. The route marks every body it encodes with `encodeBody: 'manual'`, so workerd delivers it once, and a Workers host needs no wrapper of its own. With `signedUrls: s3PresignedUrls(store)`, image descriptors carry a presigned URL and clients download from the bucket directly.
