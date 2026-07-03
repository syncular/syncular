# Bootstrap & segments

When a client subscribes with no cursor, it **bootstraps**: it downloads the
current state of its scoped rows, rather than replaying the whole commit log.
Bootstrap data travels as **segments** — content-addressed, scope-bound
snapshot artifacts.

Normative detail: [SPEC.md §4.7](../../SPEC.md#47-bootstrap-state-machine) and
[§5](../../SPEC.md#5-bootstrap-segments-and-the-download-endpoint).

## One concept: the segment

v1 grew two parallel snapshot systems; v2 has exactly one. A **segment** is
content-addressed (its id is the SHA-256 of its bytes), scope-bound, and
carries a `mediaType`:

| `mediaType` | What it is | When |
|---|---|---|
| `rows` | A columnar block of encoded rows | Mandatory-to-implement fallback; small tables ride inline |
| `sqlite` | A prebuilt SQLite database image | The premier path — importing it is near file-copy speed |

The **sqlite image** is the headline. The client attaches the image and copies
whole tables in, instead of inserting rows one by one. On the in-process
bench, a 100k-row image bootstrap lands at **30 ms** warm versus 365 ms for
the rows lane ([bench results](../../bench/RESULTS.md)). The server builds each
image once per (scopes, pin) and reuses it, so a bootstrap storm — many clients
booting the same scope at once — is served from one stored image.

## Where segments are delivered

Segments are the CDN/bulk path and stay on HTTP by design (never over the sync
socket). Three delivery shapes, negotiated by the client's `accept` bitmask
([SPEC §4.2](../../SPEC.md#42-pull_header-frame)):

- **Inline** — small rows segments ride in the sync response, no second
  round-trip.
- **Direct download** — the client fetches `<mount>/segments/{id}`, which
  re-authorizes on every request ([SPEC §5.5](../../SPEC.md#55-the-direct-download-endpoint)).
- **Signed URL** — the descriptor carries a short-lived URL (native HMAC or
  S3/R2 presign); the client fetches it with no host credentials, so server
  egress for cold starts approaches zero
  ([SPEC §5.4](../../SPEC.md#54-signed-url-segment-delivery)).

The client verifies every segment's content address after download and applies
it in one transaction per block. Bootstrap is resumable and paged, pinned to
the `commitSeq` at which it started.

## Compression

Segment bytes are content-addressed **uncompressed**; compression is a
transport/storage concern (zstd preferred, gzip fallback) and never visible on
the wire ([SPEC §5.8](../../SPEC.md#0-deliberate-simplifications-vs-wire-v14--decisions)).
Clients rely on native fetch decoding — no decompression code ships in the
client bundle.

## Setting it up

The sqlite-image path and signed URLs are opt-in on the server side (a segment
store plus, for signed URLs, a signer). See [Server setup](/guide-server/) for
`MemorySegmentStore` / `SqliteSegmentStore` / `S3SegmentStore` and the CDN
story.
