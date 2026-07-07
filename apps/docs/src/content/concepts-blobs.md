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

## Download authorization

Every blob **download re-authorizes** against the rows that reference the
blob, on every request; a blobId on its own grants no access. The server keeps a
commit→blob reference index, and a download is denied (`blob.forbidden`) when
the actor holds no referencing row
([SPEC §5.9.5](https://github.com/syncular/syncular/blob/main/docs/SPEC.md#5-bootstrap-segments-and-the-download-endpoint)).
A push that references a blob the server has never received is rejected with
`blob.not_found`, and an upload whose bytes do not match the claimed address
is rejected with `blob.hash_mismatch`.

The local cache is content-addressed and refcounted by live rows: when a
scope is revoked, the now-unauthorized blob bodies are purged along with their
rows. Window eviction treats cached bodies differently; see
[Windowed sync](/concepts-windowing/).

## Storage backends

Blobs share the same store abstractions as segments: `MemoryBlobStore` for
tests, `SqliteBlobStore` for a single node, and the S3/R2 backend for
production. Wire one into `SyncServerConfig.blobs`; see [Server setup](/guide-server/).
