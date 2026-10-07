# Blobs

Use blobs when rows must point at files or other large binary bodies, such as photos, PDFs, or recordings. The sync stream never carries those bytes. A row holds a small reference, the bytes live in a content-addressed blob store, and any client authorized for a referencing row can fetch them. This page is for developers adding attachments on any SDK; the storage backends are on [Storage backends](/server-storage/).

::meta{for="App developers adding file attachments" time="9 minutes" first="concepts-subscriptions" spec="5.9"}

:::terms
- **Blob**: A durable, immutable byte body addressed by the SHA-256 of its content.
- **`blob_ref`**: A column type whose value is a canonical BlobRef JSON string.
- **BlobRef**: The reference document: `blobId`, byte length, and optional media type and name.
- **Blob store**: The server object store that holds blob bodies (memory, SQLite, or S3/R2).
- **Body pin**: A durable local record that keeps a cached body until its pending commit resolves.
:::

:::figure{title="Upload before push, fetch on demand" note="Bytes never ride the sync stream" ticks}
<div class="d-row">
<div class="node hot"><span class="t">01 · Stage</span>uploadBlob(bytes) hashes, caches, and queues the upload<br><span class="chip">blobId = sha256</span></div>
<span class="d-arrow"></span>
<div class="node"><span class="t">02 · Reference</span>A row write carries the BlobRef string in its <code>blob_ref</code> column</div>
<span class="d-arrow"></span>
<div class="node cool"><span class="t">03 · Round</span>The client uploads the body, then pushes the commit</div>
</div>
<div class="d-down ok">▼ Another client pulls the row<small>the reference arrives, the bytes do not</small></div>
<div class="node ok"><span class="t">04 · Fetch</span>fetchBlob(ref): a cache hit costs no network; a miss downloads, checks the content address, and caches</div>

::caption[The server re-authorizes every download against the rows that reference the blob. A `blobId` alone grants no access.]
:::

## The `blob_ref` column

A `blob_ref` column holds a canonical BlobRef document: the content address (`blobId`, the SHA-256 of the bytes), the byte length, and an optional media type and name. On the wire it is byte-for-byte a JSON string, so commits, pushes, and segments carry it at no added codec cost. The distinct type tells the schema, apply, and query layers that the value references blob bytes.

```sql title="migrations/001_todos.sql"
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  attachment BLOB_REF          -- nullable reference to an uploaded file
);
```

## Upload, reference, fetch

The client flow is upload-before-push, then reference the blob from a row. `uploadBlob` stages the bytes locally and returns the BlobRef; the next sync round uploads the body before it pushes the commit that references it.

:::tabs
```ts sdk=web title="src/attachments.ts"
// 1. Stage the bytes. This caches them locally and queues the upload.
const ref = await client.uploadBlob(fileBytes, {
  mediaType: 'image/png',
  name: 'photo.png',
});

// 2. Reference the blob from a row, like any other mutation.
client.mutate([{
  table: 'todos',
  op: 'upsert',
  values: {
    id: 't1',
    list_id: 'demo',
    title: 'Photo',
    attachment: client.blobRefString(ref),
  },
}]);
await client.sync();

// 3. Any authorized client resolves the reference to bytes.
const cached = await client.fetchBlob(row.attachment);
```
```rust sdk=rust title="src/attachments.rs"
// 1. Stage the bytes. Returns the BlobRef as JSON.
let blob_ref = client.upload_blob(&file_bytes, Some("image/png".into()), Some("photo.png".into()))?;

// 2. Store its JSON string in the blob_ref column of a row write.
// 3. Resolve a reference (a BlobRef string or a bare blobId) to bytes:
let fetched = client.fetch_blob_bytes(&mut transport, &row_attachment)?;
```
```swift sdk=swift title="Attachments.swift"
// Native bindings reach blobs through the shared command router.
let result = try client.command(method: "uploadBlob", params: .object([
    "bytes": .object(["$bytes": .string(hexOfBytes)]),
    "mediaType": .string("image/png"), "name": .string("photo.png"),
]))   // result["ref"] is the BlobRef

let fetched = try client.command(method: "fetchBlob",
    params: .object(["blob": .string(rowAttachment)]))
```
```kotlin sdk=kotlin title="Attachments.kt"
// Native bindings reach blobs through the shared command router.
val result = client.command("uploadBlob", JsonValue.obj(
    "bytes" to JsonValue.obj("\$bytes" to JsonValue.of(hexOfBytes)),
    "mediaType" to JsonValue.of("image/png"), "name" to JsonValue.of("photo.png"),
))   // result["ref"] is the BlobRef

val fetched = client.command("fetchBlob",
    JsonValue.obj("blob" to JsonValue.of(rowAttachment)))
```
```dart sdk=flutter title="lib/attachments.dart"
// Native bindings reach blobs through the shared command router.
final result = client.command('uploadBlob', {
  'bytes': {r'$bytes': hexOfBytes},
  'mediaType': 'image/png', 'name': 'photo.png',
}); // result['ref'] is the BlobRef

final fetched = client.command('fetchBlob', {'blob': rowAttachment});
```
:::

The Tauri and React Native JavaScript wrappers have no typed blob methods; their plugin and native module accept the same `uploadBlob` and `fetchBlob` commands. The command router takes bytes as `{"$bytes": "<hex>"}` and returns fetched bodies in the same envelope with `blobId`, `byteLength`, and `mediaType`. [Native client API](/native-client-api/) describes the command encoding. A web client needs a blob transport (`httpBlobTransport(blobsUrl)`, wired by the worker handle from its `endpoints`) before `uploadBlob` and `fetchBlob` work; without one they fail with `sync.invalid_request`. Wire a blob store on the server through `SyncServerConfig.blobs` ([Server setup](/guide-server/)); [Storage backends](/server-storage/) lists the store implementations and the presigned upload and download switches.

A push that references a blob the server has never received fails with `blob.not_found`, and an upload whose bytes do not match the claimed address fails with `blob.hash_mismatch`.

## Download authorization

Every blob download re-authorizes against the rows that reference the blob, on every request. The server keeps a commit-to-blob reference index, and it denies a download with `blob.forbidden` when the actor holds no referencing row ([SPEC §5.9.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5-bootstrap-segments-and-the-download-endpoint)).

## The local blob cache

The client caches bodies in its SQLite database, keyed by `blobId`. A body row is immutable after insertion, and a cache hit performs no metadata write. A completed fresh download checkpoints its body out of the WAL before it returns bytes.

:::figure{title="What keeps a cached body"}
<div class="d-cols-3">
<div class="node ok"><span class="t">A visible row references it</span>Synced rows and unsent optimistic rows both protect the body.</div>
<div class="node hot"><span class="t">A pending commit pins it</span>The pin lasts until the commit is acknowledged, rejected, revoked, or purged.</div>
<div class="node cool"><span class="t">An upload is queued</span>The upload row lasts until the bytes reach the server.</div>
</div>

::caption[A body with none of these three is eligible for cache trimming, oldest first, when the total exceeds `blobCacheMaxBytes`. If protected bodies alone exceed the cap, the client keeps them and reads stay cache hits.]
:::

`uploadBlob` writes the cached bytes and a small upload row in one atomic SQLite transaction. A storage failure rejects the call and preserves the previous body, metadata, and upload state; retry staging after repairing the failure. The same bytes keep their content address and create no duplicate cache entry. The call snapshots the supplied byte view before it yields, so the caller can reuse its buffer after receiving the promise.

Before the client uploads a queued body, it checks the stored length and SHA-256, including when the server already has the object. Missing or corrupt pending bytes or upload metadata fail the round with `sync.local_corrupt`. A storage read failure or an upload-row deletion failure also stops the round. The upload state and the original pending commit stay available for retry after storage is repaired. This verification adds one full-body hash per queued upload.

The client writes a durable body pin for each pending commit that references a locally cached body, in the same transaction as the outbox commit. Upload completion deletes the upload row and leaves the pin. Acknowledgement, rejection, revocation, and an [authorized purge](/concepts-local-data-purge/) remove the pin together with the outbox entry. Restart preserves the pins. A reference to a body that exists only on the server creates no pin and needs no local upload.

Cache trimming reads live references directly from the `blob_ref` columns. When a scope is revoked, the client updates the visible rows first, then purges the bodies that no visible row or pending commit references. [Window eviction](/concepts-windowing/) treats cached bodies differently.

The current clients accept one local blob-table layout. Opening a database from an older blob implementation fails with `sync.schema_mismatch`; create a fresh local database and resync it.

## Transfer failures

Client-generated HTTP, body-read, segment, blob, and realtime errors use static operation messages. Structured details carry an allowlisted `causeKind` and an optional numeric `httpStatus`. Request URLs and exception messages never enter these errors. A signed capability can appear in the URL path, so the client omits the path along with credentials, query parameters, and fragments.

| Response | Code |
|---|---|
| HTTP 404 from a blob download endpoint | `blob.not_found` |
| HTTP 403 | `blob.forbidden` |
| HTTP 401 | `sync.auth_required` |
| Network, TLS, or body-read failure | Transport codes |
| Any other status | The status classification, or the decoded catalog error |

Browser HTTP bindings decode authenticated server catalog responses and keep their code, message, and retry policy. The native HTTP binding classifies the HTTP status without decoding the server's JSON error body. Both require HTTP 404 before they report `blob.not_found`. A failed signed-URL fetch means the client needs a fresh grant; it does not show that the blob is absent.
