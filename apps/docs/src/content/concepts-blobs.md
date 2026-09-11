# Blobs

Files and other large binary bodies do not belong in the sync stream. Syncular
models them as **blobs**: durable, content-addressed objects that live in a
blob store, referenced from rows by a small `blob_ref` value.

Normative detail: [SPEC.md §5.9](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5-bootstrap-segments-and-the-download-endpoint).

## The `blob_ref` column

A `blob_ref` column holds a canonical BlobRef document: a content address
(`blobId` = SHA-256 of the bytes), byte length, and optional media type / name.
On the wire it is byte-for-byte a JSON string, so commits, pushes, and
segments carry it at zero added codec cost. It travels everywhere a `json`
value does; the distinct type only tells the schema, apply, and query layers
"this is a reference to blob bytes."

Declare one with a `BLOB_REF` column in your migration:

```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  attachment BLOB_REF          -- nullable reference to an uploaded file
);
```

## Upload, reference, fetch

The client flow is upload-before-push, then reference the blob from a row:

```ts
// 1. Stage the bytes → get the canonical ref string. This caches locally
//    and queues the upload, flushed before the next push.
const ref = await client.uploadBlob(fileBytes, { mediaType: 'image/png', name: 'photo.png' });

// 2. Reference it from a row (written like any other mutation).
client.mutate([
  { table: 'todos', op: 'upsert', values: { id: 't1', list_id: 'demo', title: 'Photo', attachment: client.blobRefString(ref) } },
]);
await client.sync();

// 3. Any authorized client resolves the ref to bytes (cache hit avoids
//    a network fetch; a miss downloads, verifies the content address, caches).
const cached = await client.fetchBlob(row.attachment);
```

`uploadBlob` writes the cached bytes and a small upload row in one atomic SQLite
transaction. A storage failure rejects the call and preserves the previous body,
metadata, and upload state. Retry staging after repairing the storage failure;
the same bytes retain their content address and do not create duplicate cache
entries. The method snapshots the exact supplied byte view before it yields, so
the caller can mutate or reuse its buffer after receiving the promise without
changing the staged body.

Before uploading a queued body, the client checks its stored length and SHA-256,
including when the server already has the object. Missing or corrupt pending
bytes or upload metadata fail the round with `sync.local_corrupt`. A storage
read or upload-row deletion failure also stops the round. The affected upload
state and original pending commit remain available for retry after storage is
repaired. This verification adds one full-body hash to each queued upload.

The client keeps a durable body pin for every pending commit that references
locally cached bytes. Upload completion deletes the upload row while
the commit pin remains. Acknowledgement, rejection, revocation, and an
application-authorized purge remove the commit pin with the outbox entry.
Restart preserves the explicit commit pins. A reference to a body that exists
only on the server does not create a local pin or require a local upload.

The current clients accept one local blob-table layout. Opening a database from
an older blob implementation fails with `sync.schema_mismatch`; create a fresh
local database and resync it.

## Download authorization

Every blob **download re-authorizes** against the rows that reference the
blob, on every request; a blobId on its own grants no access. The server keeps a
commit→blob reference index, and a download is denied (`blob.forbidden`) when
the actor holds no referencing row
([SPEC §5.9.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5-bootstrap-segments-and-the-download-endpoint)).
A push that references a blob the server has never received is rejected with
`blob.not_found`, and an upload whose bytes do not match the claimed address
is rejected with `blob.hash_mismatch`.

The local cache is content-addressed. Cache trimming reads live references
directly from `blob_ref` columns and keeps bodies referenced by pending commits.
When a scope is revoked, the client purges now-unauthorized blob bodies along
with their rows. Window eviction treats cached bodies differently; see
[Windowed sync](/concepts-windowing/).

Synced rows and unsent optimistic rows protect their referenced bodies. If those
bodies exceed the configured cache cap, the client retains them and subsequent
reads remain cache hits. Revocation updates the visible rows before removing
orphaned bodies. The client stores upload state in a small row outside the body
table and writes commit dependencies in the same transaction as the outbox commit.
The body row remains immutable after insertion. Cache hits perform no metadata
write, and a completed fresh download checkpoints its body out of the WAL before
returning bytes.

## Storage backends

Blobs share the same store abstractions as segments: `MemoryBlobStore` for
tests, `SqliteBlobStore` for a single node, and the S3/R2 backend for
production. Wire one into `SyncServerConfig.blobs`; see [Server setup](/guide-server/).
