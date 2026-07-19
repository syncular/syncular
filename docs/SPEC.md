# Syncular Protocol Specification (SSP2) — DRAFT

Status: **B1 — full normative text, golden vectors generated.** This document
is normative: implementations conform to this spec and the golden vectors in
`spec/vectors/`; divergence is an implementation bug. A change to wire
format or semantics requires a version bump per §9 and updated vectors in
the same commit.

Audience: implementers (human and agent) building a client or server.
Everything needed to interoperate is in this document plus the golden
vectors.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

---

## Conventions and primitive encodings

All multi-byte integers are **little-endian**. There are no varints
anywhere in this protocol; every integer field is fixed-width (fixed
offsets keep independent readers trivial and the cost is absorbed by
transport compression, §1.3).

| Primitive | Encoding |
|---|---|
| `u8` | 1 byte unsigned |
| `u16` | 2 bytes unsigned LE |
| `u32` | 4 bytes unsigned LE |
| `i32` | 4 bytes signed two's-complement LE |
| `i64` | 8 bytes signed two's-complement LE. Values MUST be within ±(2^53−1); a reader MUST reject values outside that range (JS safe-integer contract) |
| `f64` | 8 bytes IEEE-754 binary64 LE |
| `bool` | `u8`, `0x00` = false, `0x01` = true; any other byte is a decode error |
| `str` | `u32` byte length + UTF-8 bytes. One string encoding only. Bytes that are not well-formed UTF-8 are a decode error |
| `bytes` | `u32` byte length + raw bytes |
| `opt(T)` | presence `u8` (`0x00` absent, `0x01` present; other values are a decode error) followed by `T` iff present. Used **only** where a field is semantically nullable — structural optionality is expressed by frame presence (§1.2), never by option bytes |
| `list(T)` | `u32` count + count × `T` |
| `map` | `u32` count + count × (`str` key, value). Keys MUST be unique; encoders MUST emit keys in ascending code-unit order (canonical encoding). "Code unit" means **UTF-16 code units** — the order JavaScript string comparison yields; it diverges from UTF-8 byte order exactly when keys mix U+E000–U+FFFF characters with supplementary-plane characters, so implementations in byte-oriented languages MUST compare by UTF-16 code units, not encoded bytes. A decoder MUST reject duplicate or out-of-order keys — non-canonical key order is a decode error, not a tolerated variant |
| `json` | `str` containing a JSON document. A JSON document is any RFC 8259 JSON value — top-level scalars (`true`, `7`, `"x"`, `null`) included, not just objects and arrays. Used only for host-opaque values (`params`, `details`, resume tokens). A decoder MUST validate that the string parses as a JSON document (a value that does not is a decode error) but MUST NOT act on or re-serialize the parsed value. Host-opaque means exactly that: a decoder MUST preserve the raw string byte-for-byte and a re-encoder MUST emit it unchanged — round-trip fidelity, never re-canonicalization |

**Canonical encoding.** For every value there is exactly one valid byte
sequence (map key ordering, minimal presence bytes, no padding). Golden
vectors verify byte-for-byte round-trips; an encoder that produces
different bytes for the same value is non-conformant. For `json`-typed
values the one-byte-sequence rule applies to the container (`str`
framing); the JSON text itself is an opaque payload preserved verbatim
(see the `json` row above).

**Enums and presence invariants.** Every `u8` enum field in this
document (`msgKind`, `op`, `status`, `mediaType`, …) admits only the
values listed in its field table; any other byte is a decode error (the
`bool` rule above, generalized). Where a field table ties an `opt()`
field's presence to another field's value (e.g. `row` present iff
`op` = upsert), a violation is likewise a decode error. Wire version 1
has exactly four such ties, all enforced by the envelope codec: push
operation `payload` present iff `op` = upsert (§6.1); change
`rowVersion` and `row` each present iff `op` = upsert (§4.5);
`PUSH_RESULT.commitSeq` present iff `status` is `applied` or `cached`
(§6.3); `urlExpiresAtMs` present iff `url` is (§5.4).

Hashes are SHA-256 rendered as 64 lowercase hex characters unless stated
otherwise. Timestamps are Unix epoch **milliseconds** as `i64`.

---

## 0. Design decisions

The load-bearing protocol design decisions, recorded with their
rationale; the referenced sections carry the normative detail.

- [x] **Single self-describing envelope; no optional-section variance.**
      SSP2 has one 8-byte header and a flat frame sequence (§1.2); a
      section is present iff its frame is present, and every frame is
      length-prefixed. Option bytes survive only for semantically nullable
      *fields*: there is nothing optional about the structure itself.

- [x] **One bootstrap concept: the segment.** SSP2 has exactly one
      snapshot delivery concept — the **segment** (§5): content-addressed,
      scope-bound, with a `mediaType` of `rows` or `sqlite`. One
      descriptor, one download endpoint, one auth story, one cache key —
      never parallel snapshot systems.

- [x] **Compression lives in the transport.** Envelope and segment
      bytes travel raw; HTTP responses
      use `Content-Encoding` (zstd preferred, gzip required fallback), and
      segment downloads likewise (§1.3). Clients use native decompression
      (`DecompressionStream` / fetch built-ins); no decompression code
      ships in the client bundle. Segment **content addresses are computed
      over uncompressed bytes**, so at-rest compression is a private
      server/storage concern and never visible on the wire.

- [x] **Streaming-friendly framing.**
      The frame grammar (§1.2) is strictly sequential: `SUB_START …
      COMMIT/SEGMENT frames … SUB_END`, each frame length-prefixed, rows
      segments internally split into self-delimiting blocks (§5.2). A
      server MUST be able to encode a response without buffering it whole;
      a client MUST be able to apply commit and segment frames as they
      arrive. §1.4 specifies the exact state a streaming reader needs.

- [x] **Schema-known encoding is mandatory.** All server→client row data (commit change payloads
      and rows segments) is encoded by codecs **generated from the schema
      IR** (§2.4). Runtime column inference does not exist in SSP2.
      Segments still carry a
      compact column descriptor table — not for inference, but as a
      checksum the receiver validates against its generated schema, and so
      independent tooling can decode segments.
      Client→server push payloads use the **same generated row codec**
      (§6.1): the wire is binary in both directions, one encoding per
      table per schema version, no JSON/binary asymmetry to specify or
      conformance-test twice. RESOLVED (Benjamin, 2026-07-02): binary
      both ways — the draft's JSON-push alternative was rejected. The
      server still treats decoded payloads as hostile input and
      authorizes/validates per §3.4; the codec only enforces shape
      (types, null bitmap), never trust. Consequence for outboxes: a
      push is encoded for the request's `schemaVersion`, so clients
      SHOULD persist outbox entries in a schema-agnostic local form and
      encode at send time with their current codec — a pending commit
      written under schema N replays after an upgrade to N+1 by
      re-encoding, not by the server accepting retired encodings.

- [x] **Signed-URL segment delivery.** Segment descriptors MAY carry a short-lived signed URL; authorization
      happens at URL issuance (inside the pull, where effective scopes were
      just resolved). §5.4 specifies the descriptor fields, the native
      HMAC token claims (`v`, `seg`, `sd`, `aud`, `exp`), and the
      delegated-presign (S3/R2) equivalence rule. The direct download
      endpoint remains as fallback and re-authorizes on every request
      (§5.5) — a MUST, never an optimization.

- [x] **SQLite-image segments are the premier bootstrap format.**
      `mediaType = sqlite` (§5.3) is
      the default bootstrap path servers SHOULD produce and clients SHOULD
      prefer (importing a database image beats inserting rows by an order
      of magnitude at 100k rows; see `bench/RESULTS.md`). Rows segments
      (`mediaType = rows`, §5.2) remain the mandatory-to-implement
      fallback; inline rows segments cover small tables without a second
      round-trip.

- [x] **Pruning horizon is normative.** The server maintains a
      per-partition `horizonSeq`
      (§4.6). A pull whose cursor is behind the horizon gets subscription
      `status = reset` with reason code `sync.cursor_expired` (category
      `reset-required`, action `rebootstrap`) and MUST re-bootstrap.
      Retention floors (≥1000 newest commits, 14-day active window,
      30-day age force) are normative minimum-behavior.

- [x] **Error envelope: one shape, a closed catalog.** The shape is
      `code`, `category`, `retryable`, `recommendedAction`, `message`,
      `details?`. The wire catalog (§10) is deliberately small:
      client-local codes (`worker.*`, `storage.*`, `runtime.*`,
      `sync.offline`, `sync.transport_failed`) are out of protocol scope;
      `console.*` and `proxy.*` are *reserved*, not specified (§10.3).

- [x] **Realtime: one delta kind + one wake-up kind.** Binary deltas
      are ordinary SSP2 response messages pushed over the socket (no
      separate delta format); the only other data-plane server message is
      the JSON `sync` wake-up with exactly three reason codes (§8.3):
      `delta-too-large`, `catchup-required`, `reset-required`.

- [x] **WebSocket-native sync loop** (Direction decision 1,
      2026-07-03). The realtime channel is a full transport
      binding for sync rounds: request/response SSP2 messages travel over
      the socket as tagged binary byte streams (§8.7), driven by the same
      handler as `POST /sync` — one handler, two framings, zero semantic
      divergence. Reference clients run every sync round on the socket
      once it is connected; no polling mode exists. `POST /sync` remains
      for push-only producers, debugging, and server-to-server
      integration. Segments stay on HTTP (the CDN bulk path).

- [x] **Canonical JSON debug rendering** (§11).
      Non-contractual for the wire; contractual for golden vectors —
      so tooling that rots fails CI instead of rotting silently.

- [x] **Explicit forward-compat rule.** Unknown frame types MUST be skipped via their length prefix (§1.2,
      §9). Record layouts inside a frame are fixed per wire version —
      fields are never appended to existing frames; new data means a new
      frame type.

Two capabilities are deliberately **absent from the core wire**, each
with a frame slot reserved:

- [x] **Commit-chain integrity metadata** (`partitionId` /
      `previousChainRoot` / `commitChainRoot`, `verifiedRoot` request
      field). It exists to serve verification features that are
      post-gate non-goals; frame type `0x17` is reserved for its return.

      > RESOLVED (Benjamin, 2026-07-02): approved — kept out of the SSP2
      > core wire. Frame `0x17` stays reserved; when verified history
      > returns at the parity ladder, the request-side `verifiedRoot`
      > companion will also need a new frame slot.

- [x] **CRDT state-vector hints** (`crdtStateVectors`) — the
      delta-request state-vector optimization stays out. CRDT **columns**
      themselves landed as the §5.10 rung (tag 8, server-merged), but they
      need no wire hint: a merged crdt column rides the ordinary upsert
      change (§5.10.3), so frame `0x18` stays reserved for a future
      state-vector hint, not for CRDT columns.

Two smaller shape decisions:

- [x] **No `dedupeRows` request flag.** Big-gap catch-up prefers
      segments (§8.4), which makes a dedupe mode's payload savings moot,
      and its absence removes a whole response-shape variant. A dedupe
      path that regroups only the latest change per row into synthetic
      commit objects would also let clients observe partial commits —
      violating the commit-atomicity spine (§6.4).

      > RESOLVED (Benjamin, 2026-07-02): approved.

- [x] **Commit `createdAt` is epoch-ms `i64`.**
      Cheap, fixed-width, no timezone ambiguity. The JSON rendering
      (§11) shows it as a number.

- [x] **Scope values are always lists on the wire.** SSP2
      canonicalizes to `list(str)` everywhere (§3.2); a single value is a
      one-element list. One shape, no `string | string[]` variance.

---

## 1. Transport bindings and envelope

### 1.1 Endpoints

A server mounts these routes under a host-chosen prefix `<mount>`:

| Route | Method | Purpose |
|---|---|---|
| `<mount>/sync` | POST | Combined push+pull (§4, §6). Request and response bodies are SSP2 envelopes |
| `<mount>/segments/{segmentId}` | GET | Bootstrap segment download, direct-serve fallback (§5.5) |
| `<mount>/blobs/{blobId}` | PUT | Blob upload with server-side content-address verification (§5.9.3) |
| `<mount>/blobs/{blobId}/upload-grant` | POST | Presigned-upload grant: mint a direct-to-storage PUT URL (§5.9.3) |
| `<mount>/blobs/{blobId}` | GET | Blob download with row-derived re-authorization (§5.9.5) |
| `<mount>/realtime` | GET (WebSocket upgrade) | Realtime channel (§8) |

Content type for SSP2 bodies is `application/vnd.syncular.sync.v2`. A
server MUST reject a `<mount>/sync` request with any other content type
with HTTP 415.

**Two bindings, one handler.** `<mount>/sync` and the realtime channel
are two framings of the same request/response semantics: the socket
carries sync rounds as tagged binary byte streams (§8.7) with identical
message grammar and validation — nothing in §§4–7 distinguishes the
bindings. Reference clients sync exclusively over the socket once it is
connected (Direction decision 1: one loop, no polling mode, no fallback
pair); `POST /sync` remains fully conformant and is the binding for
push-only producers, curl debugging, and server-to-server integration.
Segment downloads are HTTP-only (§5.5) — the CDN bulk path, not a
fallback.

**Authentication is host-provided and out of protocol scope.** The host's
`authenticate(request)` runs on every HTTP request and WebSocket upgrade;
its result supplies `actorId` and the partition. The protocol carries no
credential fields. (Auth-lease replay is a reserved extension, §7.3.)

**Errors at HTTP level** (auth failure, malformed envelope, rate limits —
anything detected before a 200 status is committed) are returned as JSON
(`application/json`) with the error shape of §10.1 and an appropriate HTTP
status. Errors detected *after* streaming has begun are delivered in-band
via the `ERROR` frame (§1.2). Error responses
are JSON and human-readable; only success responses are binary.

### 1.2 The SSP2 envelope

Every SSP2 message is:

```
offset  size  field
0       4     magic          0x53 0x53 0x50 0x32  ("SSP2")
4       2     wireVersion    u16 — this document specifies version 1
6       1     msgKind        u8  — 0x01 request, 0x02 response
7       1     flags          u8  — MUST be 0x00; non-zero is a decode error
8       …     frames         sequence of frames, terminated by END
```

The version field is a `u16`, not a varint: a fixed 8-byte header lets any
tool classify a body by reading 8 bytes. A reader
MUST reject an unknown `wireVersion` or `msgKind` before reading frames.

Each **frame** is:

```
frameType   u8
frameLength u32   — byte length of payload (may be 0)
payload     frameLength bytes
```

Rules:

1. The frame sequence MUST end with an `END` frame (`frameType 0x00`,
   `frameLength 0`). A body that ends without `END` is **truncated** and
   MUST be rejected; the abort rule of §1.4 rule 5 applies. An `END`
   frame with a non-zero `frameLength` is a decode error, and bytes
   after the `END` frame are a decode error (canonical encoding: one
   byte sequence per message, mirroring the SSG2 end-marker rule of
   §5.2).
2. A reader MUST skip an unknown `frameType` by consuming `frameLength`
   bytes. This is the forward-compat rule (§9). Unknown frame types may
   appear at any position **strictly between** the header frame and
   `END` — and only there: a message whose *first* frame is unknown is a
   decode error (the header frame is always first, §1.5/§1.6), and no
   frame of any type — unknown included — may follow `ERROR` (§1.6); the
   ordering constraints of rule 4 apply to known frame types only.
   "Unknown" means a `frameType` with no layout in this wire version for
   *either* message kind: a frame type registered for the other message
   kind (e.g. `SUB_START` in a request) is not unknown — it is a decode
   error. Registry entries that are *reserved* without a message kind
   (`0x17`, `0x18`, `0x1A`, `0x1C`–`0x1E`, `0x20`–`0x2F`) have no layout in wire version 1 and
   are therefore unknown — skippable, not errors — until a future
   version assigns them one. Preservation is the **only** source of
   unknown frames on the encode side: an encoder MUST NOT emit an
   unknown frame under a `frameType` that is registered in its wire
   version — a codec MUST refuse to encode one (an encoder error, not a
   decode error). Skipping means "do not interpret", never
   "drop": a decoder
   whose output is re-encoded (golden-vector round-trips, proxies,
   tooling) MUST preserve skipped frames byte-for-byte in their original
   positions, so re-encoding reproduces the input exactly. Their debug
   rendering is defined in §11.1 rule 9.
3. A frame's payload MUST be exactly `frameLength` bytes when decoded per
   its record layout; trailing bytes inside a known frame are a decode
   error (frames are versioned by `wireVersion`, never extended in place).
4. Frame ordering constraints are per message kind (§1.5, §1.6); a frame
   out of legal order is a decode error.

Frame type registry (wire version 1):

| Type | Name | Message | §
|---|---|---|---|
| `0x00` | `END` | both | 1.2 |
| `0x01` | `REQ_HEADER` | request | 1.5 |
| `0x02` | `PUSH_COMMIT` | request | 6.1 |
| `0x03` | `PULL_HEADER` | request | 4.2 |
| `0x04` | `SUBSCRIPTION` | request | 4.3 |
| `0x10` | `RESP_HEADER` | response | 1.6 |
| `0x11` | `PUSH_RESULT` | response | 6.3 |
| `0x12` | `SUB_START` | response | 4.4 |
| `0x13` | `COMMIT` | response | 4.5 |
| `0x14` | `SEGMENT_REF` | response | 5.4 |
| `0x15` | `SEGMENT_INLINE` | response | 5.2 |
| `0x16` | `SUB_END` | response | 4.4 |
| `0x17` | *reserved* (commit-chain integrity) | — | §0 |
| `0x18` | *reserved* (CRDT state vectors) | — | §0 |
| `0x19` | `LEASE` | response | 7.3.2 |
| `0x1A` | *reserved* (request-side lease assertion) | — | §7.3.2 |
| `0x1B` | `PUSH_RESULT_DETAILS` | response | 6.3.1 |
| `0x1F` | `ERROR` | response | 1.6 |
| `0x20`–`0x2F` | *reserved* (realtime extensions, presence) | — | §8.6 |

### 1.3 Transport compression

- Envelope and segment bytes are **never compressed at the protocol
  layer**. There is no compression field anywhere in SSP2.
- Servers MUST support `gzip` and SHOULD support `zstd` for
  `Content-Encoding` on `<mount>/sync` responses and segment downloads,
  honoring the request's `Accept-Encoding`. Clients SHOULD send
  `Accept-Encoding: zstd, gzip`.
- Clients MAY compress request bodies with `Content-Encoding: gzip`;
  servers MUST accept it (push batches after long offline periods are the
  one large client body).
- Segment content addresses (`segmentId`, §5.1) are computed over
  **uncompressed** bytes. How a server stores segments at rest
  (compressed or not) is a private concern and MUST NOT be observable on
  the wire.

### 1.4 Streaming contract

Servers MUST be able to produce a response incrementally (no full-response
buffering — response-sized server memory is the anti-goal). Clients SHOULD apply frames as they arrive. The complete state
a streaming reader needs:

1. **Header state**: wire version and msgKind (8 bytes).
2. **Frame cursor**: the current frame type + remaining payload byte
   count. Because every frame is length-prefixed, the reader never needs
   lookahead beyond the 5-byte frame header.
3. **Subscription context**: the currently open `SUB_START` (id, status),
   if any. Frames `COMMIT`, `SEGMENT_REF`, `SEGMENT_INLINE`, `SUB_END`
   are only legal inside an open subscription context; subscriptions
   never nest or interleave.
4. **Apply transaction**: one local write transaction per `COMMIT` frame,
   and one per rows-segment *block* (§5.2). Durable client state (cursor,
   bootstrap resume token) is persisted only when `SUB_END` is processed.
5. **Abort rule**: on a decode error, an in-band `ERROR` frame, or a
   truncated stream, the reader MUST abort the currently open
   subscription: roll back the *current in-progress* local transaction
   (the open `COMMIT` frame or rows-segment block, rule 4) and MUST NOT
   persist that subscription's `SUB_END` values (`nextCursor`,
   `bootstrapState`). Frames already committed under rule 4 stay
   committed — they are repaired by re-pull idempotency: the cursor and
   resume token were not advanced, so the next pull re-delivers the same
   window, and re-applying commits and segment blocks is safe (upserts
   and deletes are idempotent, §5.6). Subscriptions whose `SUB_END` was
   already processed keep their applied data and cursors — each
   subscription is an independent unit of progress.

This is why `nextCursor` and the bootstrap resume token live in `SUB_END`
(a trailer), not `SUB_START`: the server may not know them until it has
streamed the frames, and the client must not persist them earlier anyway.

### 1.5 Request message grammar

```
REQ_HEADER                      exactly once, first
PUSH_COMMIT × N                 N ≥ 0, in client commit order
PULL_HEADER                     0 or 1
SUBSCRIPTION × M                M ≥ 0, only if PULL_HEADER present
END
```

A request with neither `PUSH_COMMIT` nor `PULL_HEADER` frames is invalid
(`sync.invalid_request`). This is a frame-grammar rule, not request
validation: the production above is read together with it, and the
envelope codec rejects a no-content request as a **decode error** under
§1.7.

**`REQ_HEADER` payload:**

| Field | Type | Semantics |
|---|---|---|
| `clientId` | `str` | Stable per-device identifier, non-empty. A server MUST reject a `clientId` already bound to a different actor in the same partition (`sync.invalid_client_id`) |
| `schemaVersion` | `i32` | The client's generated schema version, ≥ 1. Gates codec selection and segment reuse |

### 1.6 Response message grammar

```
RESP_HEADER                     exactly once, first
LEASE                           0 or 1 (§7.3.2), immediately after RESP_HEADER
(PUSH_RESULT [PUSH_RESULT_DETAILS]) × N
                                one result per PUSH_COMMIT, in request order;
                                optional details immediately follow their result
per subscription, in request order:
  SUB_START
  COMMIT × k                    incremental changes (§4.5)
  (SEGMENT_REF | SEGMENT_INLINE) × m    bootstrap data (§5)
  SUB_END
ERROR                           0 or 1, may appear anywhere after RESP_HEADER;
                                if present, the next frame MUST be END
END
```

A response MUST echo subscriptions **in request order** — this is
normative so clients can prioritize critical tables by ordering their
subscription list (see §4.7 on bootstrap phases). `COMMIT` and segment
frames MUST NOT both appear for the same subscription in one response
(a subscription is either catching up on the log or bootstrapping).
The no-mixing rule is part of the frame grammar: a message that carries
both `COMMIT` and segment frames inside one subscription context is a
**decode error** under §1.7 (in either order), like any other
frame-grammar violation. Echoing subscriptions in request order, by
contrast, is cross-message state and stays a producer conformance rule.

**`RESP_HEADER` payload:**

| Field | Type | Semantics |
|---|---|---|
| `requiredSchemaVersion` | `opt(i32)` | If present, the client's `schemaVersion` is no longer served; the client MUST stop syncing and surface an upgrade requirement (`sync.client_schema_unsupported` semantics). The stop state is the trigger for the schema-bump flow once the app updates (§7.4.2) |
| `latestSchemaVersion` | `opt(i32)` | Informational: newest schema version the server knows. MUST NOT block syncing |

**Schema-floor response.** When the request's `schemaVersion` is not
served — below the floor *or* newer than anything the server knows —
the entire response is `RESP_HEADER` with **both**
`requiredSchemaVersion` and `latestSchemaVersion` present, followed by
`END`. Nothing else is processed: no push commit is attempted and no
subscription is answered (§2.4 forbids degraded encodings, and an
unserved version cannot codec row payloads in either direction).

**`ERROR` frame payload** (in-band, mid-stream failure):

| Field | Type |
|---|---|
| `code` | `str` (a §10 code) |
| `message` | `str` |
| `category` | `str` |
| `retryable` | `bool` |
| `recommendedAction` | `str` |
| `details` | `opt(json)` |

On receiving `ERROR`, the client applies §1.4 rule 5, then treats the
whole request as having failed with that error (already-completed
subscriptions keep their applied data and cursors). A server MUST NOT
emit further frames after `ERROR` except the terminating `END`. The
"next frame MUST be END" rule admits no frame of **any** type between
`ERROR` and `END` — unknown frame types included; a decoder MUST reject
a message that carries one (the skip rule of §1.2 rule 2 does not apply
past `ERROR`).

### 1.7 Decode errors vs request validation

Two validation layers exist, and the boundary is normative so that
independent codecs agree byte-for-byte on which messages are
*undecodable* (the golden vectors' `invalid/` cases pin this layer):

- **Decode errors** — detectable from one message alone, with no host,
  schema, or cross-frame state. Exactly these, and nothing more:
  envelope and framing violations (§1.2); frame-grammar violations
  (§1.5, §1.6 — including the prose constraints stated alongside the
  productions: the no-content-request rule of §1.5 and the
  COMMIT/segment no-mixing rule of §1.6); primitive-encoding
  violations, enum bytes, and `opt()` presence invariants (Conventions
  — the four ties enumerated there); and the following single-frame
  field-table constraints — `clientId` non-empty and
  `schemaVersion ≥ 1` (§1.5), `clientCommitId` non-empty and
  `operations ≥ 1` (§6.1, the latter as `sync.empty_commit`), change
  `tableIndex` in range (§4.5), `accept` bits 4–7 zero (§4.2), the
  `url`/`urlExpiresAtMs` presence tie (§5.4), and the structural
  validity of a `SEGMENT_INLINE` payload as a rows segment (§5.7 —
  structural only; the column-table schema check stays with the
  receiver, §5.2). A conformant decoder MUST
  reject all of these with the named error (`sync.invalid_request`
  unless a code is named above) and MUST NOT reject anything else at
  decode time.
- **Request validation** — everything requiring cross-frame, host, or
  schema state, performed by the server *after* a successful decode:
  duplicate subscription ids and requested `'*'` values
  (`sync.invalid_subscription`, §3.2, §4.1), unknown tables
  (`sync.unknown_table`), `clientId` actor binding
  (`sync.invalid_client_id`), operation caps
  (`sync.too_many_operations`), and row-payload decode against the
  generated row codec (§6.1 — still reported as `sync.invalid_request`,
  but by the server: the envelope codec carries payloads as opaque
  `bytes` and cannot know the schema). These MUST NOT be decode errors
  of the envelope codec.

Request validation has **two failure surfaces**, split by request half:

- **Request-level** — fails the whole request (HTTP-level JSON per
  §1.1, or an in-band `ERROR` frame if streaming already began):
  duplicate subscription ids, requested `'*'` values, undeclared scope
  keys (requested *or* resolved, §3.2), a **subscription** naming an
  unknown table (§4.3), `clientId` actor binding (§1.5), and the
  operation cap (§6.1).
- **Commit-level** — rejects only the enclosing `PUSH_COMMIT`: its
  `PUSH_RESULT` is `rejected` with one `error` result record (§6.3)
  and the batch continues (§6.4). This is the surface for a push
  **operation** naming an unknown table (`sync.unknown_table`) and for
  a `payload` that fails row-codec decode (`sync.invalid_request`).

Response-side semantic expectations that are not `opt()` ties (e.g.
`reasonCode` emptiness for `active`, `effectiveScopes` emptiness when
not `active`, `results` cardinality in §6.3) are producer conformance
rules, not decode errors. The `accept` bitmask illustrates the line: a
set bit 4–7 is a decode error (explicitly flagged in the §4.2 field
table); the "client MUST set at least bits 0 and 1" requirement is a
client conformance rule, not a decode error — the server rejects the
joint absence of bits 0 and 1 as request validation
(`sync.invalid_request`, §4.2).

---

## 2. Data model and identity

### 2.1 Commits and the log

- All server-side writes flow through **commits**. A commit is the atomic
  unit: it either applies entirely or not at all (§6.4).
- Every applied commit is assigned a **`commitSeq`**: a strictly
  increasing `i64` ≥ 1, monotonic **per partition**. One `commitSeq` per
  commit; all changes in the commit share it.
- A **partition** is a host concept (e.g., a tenant): the host's
  `authenticate()` maps a request to exactly one partition. Partitions
  never appear on the wire; commit logs, cursors, idempotency keys,
  horizons, and segments are all partition-local.
- Each commit records `createdAtMs` (server clock, epoch ms) and
  `actorId` (the authenticated actor that pushed it).

### 2.2 Changes, rows, versions

A commit contains one or more **changes**:

| Field | Semantics |
|---|---|
| `table` | Target table name |
| `rowId` | Primary key rendered as a string |
| `op` | `upsert` or `delete` — the only two operations |
| `row` | The full row payload after the write (absent for `delete`) |
| `rowVersion` | The row's `server_version` after the write (absent for `delete`) |
| `scopes` | The stored scope values extracted from the row (§3.1) |

Every synced row carries a **`server_version`** (`i64`, ≥ 1): starts at 1
on insert, increments by exactly 1 on every applied upsert. It is the
optimistic-concurrency token for `baseVersion` conflict detection (§6.2).

**Scope migration** (a row's scope column changes value): the server MUST
emit, in the same commit, a `delete` change tagged with the old scope
values and an `upsert` tagged with the new ones, so subscribers of the
old scope remove the row and subscribers of the new scope receive it.

### 2.3 Idempotency identity

The idempotency key for a push commit is the triple
**(partition, `clientId`, `clientCommitId`)**. A server MUST persist the
full commit result before acknowledging, and a replay of the same key
MUST return the persisted result byte-equivalent: an
originally-`applied` commit is returned with `status = cached`; an
originally-`rejected` commit is returned with `status` still `rejected`
(§6.3). `cached` means "this already applied — you may have missed the
ack"; a rejection replays as itself. Exactly-once apply per client
commit; at-least-once delivery of results.

### 2.4 Schema IR and the generated row codec

Column types (shared by the row codec and rows segments; tags on the wire):

| Tag | Type | Value encoding |
|---|---|---|
| `1` | `string` | `str` |
| `2` | `integer` | `i64` |
| `3` | `float` | `f64` |
| `4` | `boolean` | `bool` |
| `5` | `json` | `str` containing a JSON document (raw string preserved on round-trip, see Conventions). The Conventions `json` MUST applies at **row-codec decode**: a value that does not parse as a JSON document is a decode error (`sync.invalid_request`, part of the "row-codec violations" of §5.2's closed list) — decode validates exactly what the §11 rendering would later parse, so the two can never disagree. The raw string is still preserved verbatim for re-encoding |
| `6` | `bytes` | `bytes` |
| `7` | `blob_ref` | `str` containing a **canonical BlobRef JSON document** (§5.9.1). On the wire and in the codec a `blob_ref` is byte-for-byte a `str`, decoded and re-encoded exactly like `json` (tag 5): the value MUST parse as JSON **and** satisfy the BlobRef shape (§5.9.1) at row-codec decode, else a decode error (`sync.invalid_request`, in §5.2's closed list); the raw string is preserved verbatim for re-encoding. The distinct tag exists so schema, apply, and query surfaces recognize a column as a *reference to blob bytes* — but SSG2, `COMMIT` payloads, push payloads, and conflict `serverRow` carry it with zero codec cost because it rides the `json` machinery |
| `8` | `crdt` | `bytes` containing an **opaque CRDT update/state** (§5.10). On the wire and in the codec a `crdt` value is byte-for-byte a `bytes` (tag 6): a `u32` length prefix plus raw bytes, with **no structural validation at decode** — the bytes are host/merger-opaque (a Yjs update, a state vector, an RGA log; the codec neither parses nor trusts them). The distinct tag exists so schema, apply, and query surfaces recognize a column as *collaborative state the server merges rather than overwrites* (§5.10, §6.2 crdt interaction) — but SSG2, `COMMIT` payloads, push payloads, and conflict `serverRow` carry it with zero codec cost because it rides the `bytes` machinery. Beyond the tag, the schema IR marks a `crdt` column with a `crdtType` name (§5.10.1) that selects the server merger; `crdtType` is IR metadata, **never on the wire** (unlike `nullable`, which is), so it does not appear in the SSG2 column table |

**Encrypted columns (§5.11).** A column marked for client-side encryption
carries `type = bytes` (tag 6) on the wire and in the codec — the ciphertext
envelope (§5.11) rides the `bytes` machinery with zero new codec branch,
exactly like `crdt`. The IR additionally records `encrypted: true` and
`declaredType` (the pre-flip app type); both are **IR metadata, never on the
wire** (like `crdtType`), so the SSG2 column table still carries only
name/type/nullable and the golden vectors are untouched. The codec neither
encrypts nor decrypts — that is the client apply/encode seam (§5.11).

Tags 1–6 follow the binary-table-v1 tag assignment; tag 7 (`blob_ref`)
serves the blobs rung (§5.9) and tag 8 (`crdt`) the CRDT-fields rung
(§5.10). Both are codec-shaped identically to an
existing type (`blob_ref` rides `json`, `crdt` rides `bytes`), so each
added **no new codec branch**. A `crdt` column exercised by a fresh golden
vector (`segment/crdt-column`, `response/commit-crdt-merge`) so the new tag
is byte-pinned; existing vectors stay byte-identical (no `crdt` column was
added to an existing fixture — the §9 rule that a new tag needs pinning is
met by a *new* case, not by mutating old ones).

For every synced table, codegen (B5) emits from the schema IR, for both
sides, a **row codec** for each supported `schemaVersion`:

- Columns are encoded **positionally in schema-IR declaration order** —
  no names, no tags on the wire.
- A row is: a null bitmap of `ceil(columnCount / 8)` bytes (bit `i` set =
  column `i` is NULL; LSB-first within each byte, byte `i/8`), followed
  by the non-null values in column order, each encoded
  per the table above.
- Setting a null bit for a non-nullable column is a decode error.
- Padding bits of the bitmap (bit positions ≥ columnCount in the final
  byte) MUST be zero; a set padding bit is a decode error (canonical
  encoding — one byte sequence per row).

The row codec is used for change payloads in `COMMIT` frames (§4.5),
row data inside rows segments (§5.2), push operation payloads (§6.1),
and conflict `serverRow` values (§6.3). There is no runtime fallback: a
server that cannot codec a table for the client's `schemaVersion` MUST
answer with `requiredSchemaVersion` — the schema-floor response of
§1.6, which processes nothing — never with a degraded encoding.

**Client-local FTS5 projections (RFC 0005).** The schema IR MAY attach an
`ftsIndexes` array to a synced table. Each entry names a local FTS5 virtual
table, 1–32 local string columns, and an allowlisted built-in tokenizer. An
encrypted column is eligible only when its `declaredType` is `string`: apply
decrypts it before the local base-table write, so the projection indexes the
same plaintext already present in the protected local mirror and never the
ciphertext envelope. This metadata is client-only: it MUST NOT create a server table,
wire table, scope, codec column, subscription target, or mutation target.
Reference clients materialize the same contentful FTS5 projection over the
visible table with an internal `_syncular_source_id UNINDEXED` column equal to
the string form of the application primary key. They MUST keep it
transactionally current across insert/update/delete, optimistic overlay
rebuild, purge, and schema reset. If FTS5 is unavailable, local schema creation
MUST fail loudly; a client MUST NOT silently omit the projection or replace
`MATCH` with a `LIKE` scan. Purge, revocation, schema reset, and protected local
database deletion MUST remove the base plaintext and its FTS copy together.
Named-query invalidation maps an FTS projection back to its owning synced
table; the projection never claims independent scope coverage.

**App-facing row versions.** Every client query surface MUST expose the
protocol-owned per-row version through the public pseudo-column
`_sync_version`. Implementations MAY use a different private physical column
name, but `query` and atomic query-snapshot preparation MUST lower an authored
`_sync_version` identifier to that physical storage column before SQLite
prepares the statement. The lowering is identifier-aware: string literals and
comments are unchanged. An explicit non-reserved alias is returned as ordinary
query data; an unaliased reserved version column remains engine-internal. This
query-only column never enters schema IR, mutation values, wire rows, or
application-table star projections.

---

## 3. Scopes and authorization

Scopes are the crown jewels of the design. Scope values are always
lists on the wire (§0), and one fail-loud rule applies throughout:
`'*'` is rejected in *requested* scopes (§3.2).

### 3.1 Scope patterns and stored scopes

- A table handler declares **scope patterns**: `'prefix:{variable}'` or
  `{ pattern: 'prefix:{variable}', column: 'column_name' }`. Exactly one
  `{variable}` per pattern; a variable MUST NOT map to two different
  columns.
- Every synced table MUST declare **at least one** scope pattern — a
  schema-compile-time requirement (configuring a table without one is a
  server bug, rejected before serving). Rationale: a zero-scope table
  can never produce a non-empty effective map, so every subscription to
  it would revoke under §3.2 rule 5; "global" tables are modeled with
  an explicit scope column shared by all rows, never by omitting
  patterns.
- On every applied change the server extracts the declared columns from
  the row (upsert: the row after the write; delete: the row before
  removal) and stores them as **stored scopes**: a `map` of
  variable → single string value.
- A change emitted without a stored-scope object is a server bug and MUST
  reject the commit with `sync.missing_scopes` (fail loud, roll back).
- Stored scopes index the log: the server maintains a commit→scope-key
  inverted index (scope key = the pattern's literal prefix + `:` +
  value) so pulls filter by scope without scanning (an SSP2 storage-schema
  requirement per REVISE B2; the index itself is not wire-visible).

### 3.2 Requested, allowed, effective

On every pull (and on realtime connect), per subscription:

1. The client sends **requested scopes**: `map` of variable →
   `list(str)`.
2. The server validates that every requested key is a variable declared
   by the table's patterns. An unknown key fails the whole request with
   `sync.invalid_subscription` (fail loud — a typo'd scope key must never
   silently widen or narrow access). A requested *value* of `'*'` also
   fails the request with `sync.invalid_subscription`: the wildcard is
   reserved for allowed scopes (fail loud — a requested `'*'` that
   passed through would match only rows whose stored value is literally
   `*`, a silent-empty-data footgun).
3. The host's `resolveScopes(actor)` returns **allowed scopes** for the
   actor as one map covering every scope variable the actor holds,
   across all tables: variable → list of values, where the value `'*'`
   means "any value for this variable". There is one resolver per
   server, not one per table; it is invoked **at most once per
   request** and the result memoized — §3.4 step 1 authorizes writes
   against the same memoized result, and resolvers MUST be stable
   within a request. Key validation on the result is against the
   **union of variables declared by any table in the schema**: a key
   declared by no table is a server bug and fails the whole request
   with `sync.invalid_subscription` (fail loud, do not guess). Keys
   declared only by *other* tables are legal in the result; they simply
   do not participate in this table's intersection (rule 4).
4. **Effective = requested ∩ allowed**, computed per requested key —
   the intersection therefore runs over this table's declared variables
   only, since requested keys were validated in rule 2 (keys present
   only in allowed never enter effective):
   - key absent from allowed → key excluded entirely;
   - allowed contains `'*'` → the requested values pass through;
   - otherwise set intersection of the value lists; an **empty
     intersection excludes the key entirely** — a requested key never
     survives with an empty list (it then revokes via rule 5).
5. The subscription is **revoked** when any of:
   - `resolveScopes` threw (fail-loud: no data on errors — an
     authorization bug must fence, not leak);
   - a requested key is missing from effective (partial scope loss must
     not silently deliver a subset the client didn't ask to trust);
   - effective is empty.
6. Otherwise the subscription is **active** with the effective scopes,
   which are echoed in `SUB_START` so the client knows exactly what it is
   receiving.

A pull for an active subscription returns exactly the changes whose
stored scopes match the effective scopes: for every effective key, the
change's stored value for that key is in the effective value list.

**Scope variables are independent dimensions, not correlated tuples.**
An allowed map such as `{ workspace_id: ['w1', 'w2'], surgery_id: ['s1',
's2'] }` authorizes every row whose `workspace_id` is in the first list
and whose `surgery_id` is in the second. It does not encode only the pairs
`(w1, s1)` and `(w2, s2)`. A host that needs parent/child authorization
MUST therefore do one of the following: declare and request the parent
scope on every child table as well as the child scope, while validating
the parent reference server-side; enumerate the exact authorized child
values; or perform the operation behind a server-authoritative command.
Granting `'*'` for a child variable is safe only while another declared
scope independently fences every read and write path for that child. A
later table that declares only the child variable does not inherit the
parent fence and MUST be treated as a new authorization decision.

### 3.3 Revocation and the purge contract

When `SUB_START.status = revoked`:

- The server sends no commits and no segments for the subscription;
  effective scopes are echoed as an empty map; `nextCursor` in `SUB_END`
  echoes the request cursor unchanged.
- The client MUST stop pulling the subscription and MUST purge local rows
  belonging to it: delete rows whose generated local scope columns match
  the **last effective scopes** echoed in `SUB_START` while the
  subscription was active — the client MUST persist those per
  subscription for exactly this purpose. Requested
  values that never became effective are not purged: the grant being
  revoked is the effective one, and local-only rows outside it are not
  the server's to destroy.
- **Fail closed**: if the client's generated schema has no local
  scope-column mapping for the table, the client MUST NOT clear the whole
  table as an approximation; it MUST surface `sync.scope_revoked` as a
  fatal configuration error and stop syncing the table. (Doctrine:
  precision or nothing.)
- Pending outbox commits that write into the revoked scope will be
  rejected on push by write-path authorization (§3.4); the client SHOULD
  drop them locally on revocation instead of replaying them into
  guaranteed rejections. The drop is **whole-commit**: when any upsert
  in a pending commit provably lands in the revoked effective scopes
  (its scope-column values match them under the purge rule above), the
  entire commit is dropped — commits are atomic (§6.4) and their content
  is pinned by the idempotency key (§2.3), so operations are never
  removed individually. Delete operations carry no row values to test,
  so delete-only commits are not provably in scope: they replay and rely
  on server-side rejection (§3.4) or the idempotent absent-row `applied`
  of §6.2. Both outcomes surface to the app — a local drop and a
  `rejected` result are each visible, never silent.

While the subscription stays `active`, each pull's `effectiveScopes`
echo **replaces** the persisted copy. A narrowing echo (fewer values
than before) purges nothing: the purge contract fires only on
`status = revoked`. Rows outside the narrowed effective scopes simply
stop receiving changes; they are cleaned up by the §5.6 first-page rule
on the next fresh bootstrap, or by an eventual revocation.

**Eviction is not purge.** A client MAY *voluntarily* delete local rows
it still holds authorization for — the windowed-sync retention policy of
§4.8. This is distinct from the revocation purge above along every axis:
its trigger is the client's own window shrink, never a server signal;
authorization is still held (the server is never told and tombstones
nothing); and it is legal **only when fused with unsubscription** — a
client MUST NOT delete rows of a subscription it keeps syncing, because
the surviving cursor would then silently over-assert local possession
(§4.5 C1). Eviction matches rows by the **same** local-scope-column rule
as the purge (§5.6), **including its fail-closed clause**: with no local
mapping for a scope key, a client MUST NOT clear by approximation. A
narrowing echo on a *live* subscription still purges nothing; only the
§4.8 unsubscribe-fused eviction removes rows a client remains
authorized for. See §4.8 for the full contract (E1–E4, the outbox pin,
version-state disposal, and re-entry).

### 3.4 Write-path authorization

On every push operation:

1. The server resolves allowed scopes for the actor (same
   `resolveScopes`). The result is resolved at most once per
   request and memoized; resolvers MUST be stable within a request.
2. It selects the **authorization row**: for an operation targeting an
   existing row (upsert onto an existing row, or delete), the row **as
   currently stored** — never the pushed payload; for an insert (no
   existing row), the pushed payload plus the primary key. It extracts
   that row's scope values for **all** declared scope variables of the
   table. A missing or empty scope column value ⇒ deny. A delete
   targeting an absent row has no authorization row: it is applied
   idempotently, emits no change, and performs no scope check (§6.2).
3. For every declared variable: the row's value MUST be present in the
   actor's allowed values for that variable, or the allowed values
   contain `'*'`. **All declared keys are required** — there is no
   partial pass.
4. Any denial, or a throwing `resolveScopes`, rejects the operation with
   `sync.forbidden` (non-retryable) and rolls back the commit (§6.4).
5. **Scope columns are immutable on update.** The server MUST strip all
   declared scope columns from the update set of every upsert that
   targets an existing row (both the `baseVersion` and last-write-wins
   paths). Clients cannot re-home a row across scopes by push; scope
   migration is server-emitted only (§2.2). Scope columns are written
   only on insert, where step 2 authorized exactly those values.

Rules 2 and 5 are load-bearing together: authorizing the pushed payload
instead of the stored row, or letting an update change a scope column,
each opens a cross-scope write hole.

### 3.5 Scope digest

Segments are bound to the effective scopes they were built for via the
**scope digest**: SHA-256 over the canonical JSON rendering (§11.2) of
the effective-scope map (keys sorted, values as sorted unique lists),
rendered as lowercase hex. Servers MUST recompute and compare digests on
segment download (§5.5); a digest mismatch is `sync.forbidden`.

---

## 4. Subscriptions, cursors, pull

### 4.1 Subscription identity

A subscription is client-defined: `id` (client-chosen, unique within the
request — duplicates fail the request with `sync.invalid_subscription`),
`table`, requested scopes, optional host-opaque `params` (passed to the
host snapshot function), and a `cursor`. Subscription ids are echoed, not
interpreted, by the server.

Within one durable client replica, the tuple `(table, canonical requested
scopes, params)` is immutable for a registered `id`. Re-declaring the same
tuple is idempotent and MUST retain its cursor, bootstrap state, effective
scopes, status, and reason. Reusing that id for a different table, scope map,
or params fails locally with `client.subscription_intent_mismatch` before the
registration changes; it MUST NOT inherit or reset the prior tuple's progress.
Hosts that need a different query use a distinct deterministic id, or explicitly
unsubscribe the old registration and apply the relevant eviction policy before
registering another. This is a client safety rule, not a new wire error.

**Omission is unregistration.** A pull's subscription list replaces the
persisted registration list (§8.1) and, for socket rounds, the live
connection's registrations (§8.7). A subscription present in an earlier
pull and absent from a later steady-state pull is therefore
**unsubscribed**: it stops receiving deltas and its cursor record is
forgotten on the next §4.5 watermark computation. Windowing (§4.8)
leans on exactly this replace-semantics: it subscribes and unsubscribes
purely by including or omitting a unit's subscription.
Steady-state pulls MUST carry the client's complete current subscription
list; the one latitude — phased partial pulls that omit never-synced
subscriptions — is stated in §4.7, and there is nothing to unregister in
that case.

**Sub-id derivation (non-normative guidance).** Because ids are opaque to
the server, a windowed client MAY derive one deterministically per window
unit so the same unit always maps to the same subscription — e.g.
`w:<table>:<sha256(canonical scope map, §11.2)[0..16]>`. This is pure
client convention; the server neither computes nor validates it. §4.8
relies on it to turn a window change into a set difference on ids.

### 4.2 `PULL_HEADER` frame

| Field | Type | Semantics |
|---|---|---|
| `limitCommits` | `i32` | Max changes across returned commits per subscription. Server clamps to [1, 1000]; `0` = server default (1000) |
| `limitSnapshotRows` | `i32` | Bootstrap page size in rows. Server clamps to [1, 50000]; `0` = default (1000) |
| `maxSnapshotPages` | `i32` | Max bootstrap pages materialized per pull. Server clamps to [1, 50]; `0` = default (4) |
| `accept` | `u8` bitmask | Segment delivery capabilities: bit 0 = inline rows segments, bit 1 = external rows segments, bit 2 = sqlite segments, bit 3 = signed URLs; bits 4–7 MUST be 0 (a set unknown bit is a decode error). A client MUST set at least bits 0 and 1 (rows support is mandatory) |

The clamp is silent (the
response reflects the clamped behavior, not an error). **Deliberately,**
`limitCommits` counts *changes*, not commits — bounding the number of
commits scanned would leave response size unbounded for large commits. The limit is where the server stops adding
further commits; a single commit whose own change count exceeds it is
still delivered whole and alone (commits are never split, §4.5).

**Rows acceptance is enforced.** A `PULL_HEADER` whose `accept` has
neither bit 0 nor bit 1 set MUST be rejected as request validation with
`sync.invalid_request` (this specifies the behavior §1.7 assigns to the
server). Bit 0 without bit 1 means the server delivers every rows
segment **inline**, regardless of the §5.7 size guidance — the SHOULD
yields to the client's declared capability. Bit 1 without bit 0 means
every rows segment is delivered as a `SEGMENT_REF`.

**Client baseline.** A client that implements no optional segment
capability sends `accept = 0b0011` (inline + external rows). The
reference clients advertise bit 2 in addition (`0b0111`) whenever their
database backend can import sqlite images (§5.3) and a segment
downloader is configured, and bit 3 in addition whenever that
downloader exposes a direct URL fetch (§5.4) — the premier path is the
default wherever it is possible, per §0. The mask is also a client-side contract: a
client MUST reject a `SEGMENT_REF` whose `mediaType` it did not
advertise (fail loud as `sync.invalid_request`, aborting per §1.4
rule 5) rather than skip or guess — a server that ignores the mask is
broken, and silently dropping a bootstrap segment would corrupt the
snapshot.

### 4.3 `SUBSCRIPTION` frame

| Field | Type | Semantics |
|---|---|---|
| `id` | `str` | §4.1 |
| `table` | `str` | Unknown table fails the **whole request**: `sync.unknown_table` (request-level, §1.7 — contrast the commit-level rule for push operations, §6.1) |
| `scopes` | `map` of `str` → `list(str)` | Requested scopes (§3.2) |
| `params` | `opt(json)` | Host-opaque snapshot parameters |
| `cursor` | `i64` | Last fully-applied `commitSeq`; `-1` = never synced (bootstrap needed) |
| `bootstrapState` | `opt(json)` | Resume token from a previous `SUB_END`, round-tripped **unchanged and uninspected** (§4.7) |

### 4.4 `SUB_START` and `SUB_END` frames

**`SUB_START`:**

| Field | Type | Semantics |
|---|---|---|
| `id` | `str` | Echo of the request subscription id |
| `status` | `u8` | `1` = `active`, `2` = `revoked` (§3.3), `3` = `reset` (§4.6) |
| `reasonCode` | `str` | Empty for `active`; a §10 code for `revoked` (`sync.scope_revoked`) and `reset` (`sync.cursor_expired`) |
| `effectiveScopes` | `map` of `str` → `list(str)` | The computed effective scopes (empty when not `active`) |
| `bootstrap` | `bool` | True iff this response delivers bootstrap segments for the subscription |

**`SUB_END`:**

| Field | Type | Semantics |
|---|---|---|
| `nextCursor` | `i64` | The cursor to persist and send next time (§4.5, §4.7) |
| `bootstrapState` | `opt(json)` | Present iff the bootstrap is incomplete; round-trip in the next request. Absent = bootstrap complete (or not bootstrapping) |

The client persists `nextCursor` / `bootstrapState` only on processing
`SUB_END` (§1.4).

### 4.5 Incremental pull and `COMMIT` frames

When the subscription is active, not bootstrapping, and
`horizonSeq ≤ cursor ≤ maxCommitSeq`, the server returns the log window
`cursor < commitSeq ≤ maxCommitSeq`, filtered to the effective scopes,
oldest first, cut off at `limitCommits` total changes (never splitting a
commit across responses).

**`COMMIT` frame payload** (one frame per commit):

| Field | Type | Semantics |
|---|---|---|
| `commitSeq` | `i64` | |
| `createdAtMs` | `i64` | Server commit time |
| `actorId` | `str` | Pushing actor |
| `tables` | `list(str)` | Frame-local table dictionary |
| `changes` | `u32` count × change record | |

Change record:

| Field | Type | Semantics |
|---|---|---|
| `tableIndex` | `u16` | Index into `tables`; out of range is a decode error |
| `rowId` | `str` | |
| `op` | `u8` | `1` = upsert, `2` = delete |
| `rowVersion` | `opt(i64)` | Present for upsert, absent for delete |
| `scopes` | `map` of `str` → `str` | Stored scopes (§3.1) |
| `row` | `opt(bytes)` | Present for upsert: the row encoded with the generated row codec (§2.4) for the response's schema version. Absent for delete |

Frames are self-contained (dictionary per frame, no cross-frame state) so
a streaming reader can apply commit-by-commit — one representation,
no cross-frame dictionaries, with transport compression absorbing the
repetition.

**Cursor advancement.** `nextCursor = max(request cursor, highest
commitSeq scanned)` — the cursor advances even when no matching changes
exist in the window (this is what makes quiet
subscriptions cheap). If the change limit truncated the window,
`nextCursor` is the last fully delivered `commitSeq`; the client observes
`nextCursor < latest` only implicitly by pulling again — there is no
`hasMore` flag. Clients SHOULD pull again immediately
whenever a response contained commits.

The server records, per (partition, clientId), the minimum `nextCursor`
across the request's active subscriptions, with a timestamp — this feeds
the retention watermark (§4.6).

### 4.6 The pruning horizon

Servers prune the commit log. The contract:

- **`horizonSeq`** (per partition): every commit with
  `commitSeq ≤ horizonSeq` may have been deleted. `horizonSeq` starts
  at 0.
- A server MUST NOT advance `horizonSeq` past
  `min(active-client cursors) `, where "active" means clients whose
  cursor record was updated within the **active window** (default 14
  days), except that it MAY force-advance past commits older than the
  **age force limit** (default 30 days) regardless of laggard cursors.
  A server MUST always retain at least the newest **1000** commits.
  (Hosts may raise any of the defaults.)
- Pull with `0 ≤ cursor < horizonSeq` ⇒ the server cannot compute deltas.
  It MUST answer `SUB_START.status = reset` with
  `reasonCode = "sync.cursor_expired"`, send no commits, and echo the
  request cursor in `SUB_END`.
- On `reset`, the client MUST discard its cursor and bootstrap state for
  the subscription and re-request with `cursor = -1` (fresh bootstrap).
  It SHOULD keep local rows in place until bootstrap application
  replaces them (§5.6) — `reset` is a staleness signal, not a purge
  signal; only `revoked` purges (§3.3).
- Compaction (dropping superseded intermediate changes for the same
  (table, rowId, scope) older than a host-configured full-history window)
  is allowed and invisible to correct clients: any client whose cursor is
  at or above the horizon still converges, because the latest change per
  row survives compaction. Normative rule: compaction MUST preserve, for
  every row, the change that a fresh scan from any cursor ≥ horizonSeq
  would need to converge.

### 4.7 Bootstrap state machine

A subscription **bootstraps** when any of: the request carries a
`bootstrapState` token (a resume — this is what keeps a part-way
bootstrap in bootstrap mode, since its cursor already equals the pin);
`cursor < 0`; `cursor < horizonSeq` (after the `reset` round-trip);
`cursor > maxCommitSeq` (client from the future — treat as corrupt
state); or the server has declared its log discontinuous
(host-initiated resync).

Bootstrap is **resumable, pinned, and paged**:

- On start, the server pins `asOfCommitSeq = maxCommitSeq` and computes
  the table list for the subscription (the handler-declared bootstrap
  order — parents before children so foreign keys apply cleanly).
- The resume token (`SUB_END.bootstrapState`) is a JSON document with the
  shape `{ "asOfCommitSeq": i, "tables": [..], "tableIndex": i,
  "rowCursor": string|null }`. **Clients MUST treat it as opaque** and
  round-trip it byte-for-byte; only servers interpret it. (The shape is
  specified so vectors and tooling can render it, not for clients.)
- Each pull continues from (`tableIndex`, `rowCursor`), emitting up to
  `maxSnapshotPages` pages of up to `limitSnapshotRows` rows as segments
  (§5), then returns the advanced resume token — or omits it when every
  table is exhausted, which is the completion signal. A table served as
  a sqlite image (§5.3) is exhausted by that single segment: the image
  is whole-table, counts as one page, and is only chosen when the resume
  position is at the table's start (null row cursor).
- If a resumed `asOfCommitSeq < horizonSeq`, the server MUST restart the
  bootstrap from scratch (fresh pin) rather than resume across pruned
  history.
- A `bootstrapState` that does not parse as the shape above, or whose
  `tables` do not correspond to the subscription, MUST be handled the
  same way: silently restart the bootstrap with a fresh pin. An
  unusable resume token is never a request error — clients round-trip
  the token opaquely, so a bad token means corrupt client state, and
  bootstrap is self-healing by construction (a fresh bootstrap always
  converges).
- **Every** bootstrap response — complete or not — sets
  `SUB_END.nextCursor = asOfCommitSeq`. A resuming client therefore
  presents `cursor = asOfCommitSeq` plus the round-tripped resume token;
  the token, not the cursor, is what marks the subscription as still
  bootstrapping.
- On completion (`bootstrapState` omitted), incremental pulls take over
  from the pinned point; nothing is lost between the pin and now because
  the next pull replays `asOfCommitSeq < commitSeq ≤ latest`.

**Phases.** SSP2 does not encode bootstrap phases (critical /
interactive / background) in the protocol:
subscription order in the request is the priority order, responses echo
it (§1.6), and a client achieves phasing by pulling critical
subscriptions first (even in a separate request) before enqueueing the
rest. DECISION (recorded): phases are client policy, not wire state —
one less coupled enum, same capability.

One constraint bounds the "separate request" latitude (resolving the
ambiguity with §8.1's replace-semantics in windowing's favor, per
DESIGN-eviction.md §9.1): a pull's subscription list replaces both the
persisted registration list (§8.1) and — for socket rounds — the live
connection's registrations (§8.7), so **omission is unregistration**.
Steady-state pulls MUST therefore carry the client's complete current
subscription list; phased partial pulls are legal only while the
omitted subscriptions have never synced (nothing registered, nothing to
unregister).

### 4.8 Windowed subscriptions

A **window** is a partial local replica: a client holds rows for a
chosen set of scope values (hot projects, recent time buckets) while the
server keeps everything. Windowing adds **no wire frames, fields, codes,
or server behavior** beyond §8.1 replace-semantics and the §4.5
watermark — it is built entirely on §3 scopes and §4 subscriptions. This
section specifies the client contract; the server text confined here
confirms existing rules already suffice.

**The model.** A window is a set of **scope values** for one scope
variable of a table (the *window unit* = one scope value, or an
app-chosen group of values treated atomically). The client SDK manages a
*family* of subscriptions, one per live unit, with deterministic ids
(§4.1 guidance). A window change is a **set difference on that family**,
never a mutation of an existing subscription:

- **Widen** (a unit enters): add its subscription with `cursor = -1`; it
  fresh-bootstraps via the image lane (§5.3) / rows lane exactly like any
  new subscription. Units already present are untouched — their cursors
  stay honest. Because units are value-sharded, a widen re-downloads
  **only** the entering unit; unchanged units are not re-bootstrapped.
- **Shrink** (a unit leaves): stop including its subscription in pulls
  (§4.1 omission-as-unregistration) and run **eviction** for it, fused
  with the local unsubscription in one transaction (E3).
- **Replace** `{A,B}→{B,C}` = shrink `A` + widen `C`; `B` is neither
  re-bootstrapped nor evicted.

**Eviction (E1–E4).** When a unit leaves the window, the client
performs, as **one atomic local transaction** (E3):

- delete the local rows matching the departing unit's effective scopes,
  by the §5.6 local-scope-column rule **including its fail-closed
  clause** (no local mapping ⇒ do not clear, surface a configuration
  error), **except** rows pinned by E1;
- discard that subscription's cursor, `bootstrapState`, and persisted
  effective-scope echo, and remove it from the local registration list
  (so it is omitted from the next pull, §4.1);
- emit the deleted rows' invalidation keys through the client's single
  apply-path choke point, exactly like a purge (a live query over evicted
  rows MUST re-run).

- **E1 — Outbox pin.** A row referenced by any still-pending outbox
  commit MUST NOT be evicted. Its eviction is *deferred* and completes
  when the pinning commit drains (`applied` / `cached` / dropped). The
  pending commits themselves are untouched — the server authorizes
  against stored rows (§3.4), so they push normally after other rows in
  the unit are evicted. A deferred eviction is **cancelled** if the unit
  re-enters the window before the pin drains.
- **E2 — Version state dies with the row.** Eviction MUST delete the
  row's stored `server_version` (§2.2) with the row — no residual version
  cache. A `baseVersion` for an evicted-then-re-entered row comes
  exclusively from its re-delivery (segment `serverVersion` §5.6, or a
  `COMMIT` change's `rowVersion` §4.5). There is no legal way to hold a
  `baseVersion` for a row you do not hold.
- **E3 — Fusion with unsubscription** is the MUST (above): a client MUST
  NOT keep syncing a subscription whose rows it partially evicted, and
  MUST NOT keep a cursor for a unit it evicted (§4.5 C1 — the cursor
  invariant is never weakened, only narrowed to match the replica).
- **E4 — Local-only rows** (optimistic, never server-confirmed) are
  covered by E1: they exist only because a pending commit wrote them, so
  they are pinned until the commit drains, then evicted like any row.

**Re-entry is bootstrap.** A unit that re-enters after eviction is a
**fresh bootstrap** of its subscription (`cursor = -1`): pinned snapshot,
image lane, §5.6 first-page clear (which sweeps any straggler whose E1
pin drained after the eviction), segment `serverVersion` re-seeding
optimistic concurrency. It is correct at any distance — a bootstrap
snapshots current state (§4.7) regardless of how much log was pruned
since eviction — so a client MUST NOT attempt to resume a
previously-evicted unit from a parked cursor (that cursor's possession
claim was falsified by the eviction; §4.5 C1). Re-entry needs no new
protocol object.

**The window registry.** The client persists which units are live per
window base (table + variable + the fixed remainder of the scope map).
The registry is authoritative for two things: (i) which subscriptions the
next pull carries (so omission-as-unregistration, §4.1, drives shrink),
and (ii) whether a local query is **answerable in full**. Registration
alone is not completeness: a registered unit is **pending** from
`setWindow` until its subscription completes a bootstrap round — that
is, while its cursor is `-1` (never synced, §4.3) or a §4.7 resume token
is held (mid-bootstrap; a §4.6 reset re-enters this state). A unit is
**complete** iff it is registered and not pending. A bootstrap round
that finishes with zero rows completes its unit — an empty replica is a
truthful one (emptiness ≠ pendency). A query is answerable in full iff
every scope value its predicate touches is complete; otherwise the
  result is partial and the client MUST be able to say so (never silently
  return partial data as complete). A client MAY expose the per-unit
  verdict to the host; it MUST NOT represent a windowed-out or
  still-pending unit's result as complete. Because the verdict can flip
  with no row changing (a zero-row bootstrap completing), a client that
  exposes the local-observation seam (§7.5) MUST emit a **window-domain**
  change for the subscription's base and unit when bootstrap completes.
  It MUST NOT invent a row/table change for that transition. Coverage-aware
  views re-read; unrelated table-only views do not, and no oracle is polled.

**Server confirmation (no new rules).** A newly widened unit's
subscription is bootstrapping and not yet synced-once, so it is excluded
from the §8.2 ack floor by the existing rule; a shrunk unit simply stops
appearing in pulls and the §4.5 per-request cursor record forgets it on
the next pull. A socket round's registration replace (§8.7) makes a
window change take effect on the very round that carries it — no
reconnect, no socket cycle. Nothing in §§4.5, 4.6, 8.1, 8.2, 8.7 is
amended.

---

## 5. Bootstrap segments

One concept (§0): the **segment** — an
immutable, content-addressed, scope-bound container of snapshot rows for
one table at one `asOfCommitSeq`.

### 5.1 Identity, integrity, caching

- **`segmentId` = `"sha256:"` + lowercase-hex SHA-256 of the segment's
  uncompressed bytes.** Content addressing makes segments immutable,
  dedupable across clients with identical effective scopes, and safely
  CDN-cacheable.
- A client MUST verify the hash of downloaded segment bytes against the
  `segmentId` before applying, and reject on mismatch
  (`sync.integrity_rejected` is *not* in the SSP2 catalog — the client
  discards the segment and re-pulls; a persistent mismatch is
  `sync.not_found` territory server-side).
- Segments are cache entries, not durable state: servers MAY expire them
  at any time (default TTL 24 h). An expired segment yields
  `sync.segment_expired` on download; the client recovers by re-pulling
  (the server will mint fresh descriptors).
- Servers SHOULD build segments once per (partition, table, scope digest,
  `asOfCommitSeq`, page window, schemaVersion) and share them across
  clients — this is the bootstrap-storm answer together with §5.4.

### 5.2 Rows segments (`mediaType = rows`) — mandatory

A standalone binary format (own magic so a segment file is
self-identifying at rest and in caches):

```
offset  size  field
0       4     magic         0x53 0x53 0x47 0x32  ("SSG2")
4       2     formatVersion u16 — this document specifies 1
6       2     flags         u16 — MUST be 0
8       …     header, then row blocks, then end block
```

Header:

| Field | Type | Semantics |
|---|---|---|
| `table` | `str` | |
| `schemaVersion` | `i32` | Schema the rows are encoded for |
| `columns` | `u16` count × column record | Column record: `name str`, `type u8` (§2.4 tags), `flags u8` (bit 0 = nullable; other bits MUST be 0) |

The column table MUST match the receiver's generated schema for
(`table`, `schemaVersion`) — order, names, types, nullability. A mismatch
is a fatal decode error (`sync.schema_mismatch` semantics): the
descriptor exists to *validate*, never to *infer* (§0, schema-known
encoding).

Row blocks, repeated:

| Field | Type | Semantics |
|---|---|---|
| `rowCount` | `u32` | `0` = end-of-segment marker (no further fields; nothing follows it) |
| `byteLength` | `u32` | Byte length of `rows` |
| `rows` | bytes | `rowCount` consecutive **row records** (below) |

Row record, `rowCount` per block:

| Field | Type | Semantics |
|---|---|---|
| `serverVersion` | `i64` | The row's current `server_version` (§2.2) at `asOfCommitSeq`. MUST be ≥ 1 (a snapshot row has by definition been written at least once) |
| row | bytes | The row in row-codec encoding (§2.4: null bitmap + positional values) |

`serverVersion` leads the record so a streaming reader holds version and
row together; it exists so segment-applied rows participate in §6.2
`baseVersion` conflict detection identically to commit-delivered rows
(§5.6) — a bootstrap alone fully seeds optimistic concurrency.

Encoders SHOULD target blocks of ~1000 rows or ~256 KiB, whichever comes
first. Blocks make the format streamable: a reader applies each block in
one local transaction as it completes, holding only (header state +
current partial block) in memory — this is the §1.4 requirement carried
into segment application. The end marker (`rowCount = 0`) is mandatory;
a segment that ends without it is truncated.

**Error codes.** Structural decode failures of a rows segment — bad
magic, unsupported `formatVersion`, non-zero flags, reserved column
flag bits, an unknown column type tag, a block whose rows do not consume
exactly `byteLength`, a row `serverVersion` < 1, row-codec violations
(§2.4), truncation, a missing
end marker, or trailing bytes after it — are `sync.invalid_request`.
`sync.schema_mismatch` is reserved for the column-table-vs-generated-
schema comparison above, which only the receiver can perform: a
standalone segment decode (tooling, vectors) never produces it.

### 5.3 SQLite segments (`mediaType = sqlite`) — premier path

The segment bytes are a complete, well-formed **SQLite database file**
(the motivating property: bootstrap becomes "import a database", not
"insert N rows").

**Whole-table, never paged.** A sqlite segment covers the subscription's
**entire** effective-scope row set for one table at the bootstrap pin —
the same rows a complete sequence of §5.2 rows pages would deliver (same
matching rule, same `asOfCommitSeq`). Consequences, all normative:

- The descriptor's `rowCursor` and `nextRowCursor` MUST be absent (the
  image is both the first and the last page of its table); a client
  receiving a sqlite `SEGMENT_REF` with either present MUST reject it
  (`sync.invalid_request`, aborting per §1.4 rule 5).
- `limitSnapshotRows` and `maxSnapshotPages` (§4.2) do not constrain the
  image lane; against `maxSnapshotPages` an image counts as one page.
- The sqlite lane is chosen only at the **start of a table** (§4.7
  resume position with a null row cursor). A bootstrap resumed mid-table
  MUST continue on the rows lane at the same pin — a server MUST NOT
  switch lanes mid-table (re-clearing already-applied pages is the §5.6
  first-page rule's job, and a resumed bootstrap never re-clears).
- Delivery is by `SEGMENT_REF` only; servers MUST NOT inline sqlite
  segments (§5.7).

**File contents.** Exactly two tables:

- One data table named as the target table: the schema-IR columns in
  declaration order (§2.4), **plus a `_syncular_version INTEGER NOT
  NULL` column last**, holding each row's `server_version` (§2.2, value
  ≥ 1) — the sqlite-image form of §5.2's per-row `serverVersion`, so
  both segment formats seed §6.2 conflict detection (§5.6). Declared
  column type affinities follow the §2.4 types (`string`/`json` →
  `TEXT`, `integer` → `INTEGER`, `float` → `REAL`, `boolean` →
  `INTEGER`, `bytes` → `BLOB`); non-nullable columns are declared `NOT
  NULL` and the primary-key column `PRIMARY KEY`. Cell encodings:
  `boolean` as `0`/`1`, `json` as the raw string preserved verbatim
  (already validated when the row entered the log — receivers do not
  re-validate it at image apply), NULL for null, everything else its
  natural SQLite type.
- A metadata table `_syncular_segment` with **exactly one row** and
  exactly these columns: `format INTEGER NOT NULL` (this document
  specifies format `1`), `"table" TEXT NOT NULL`, `schemaVersion
  INTEGER NOT NULL`, `asOfCommitSeq INTEGER NOT NULL`, `scopeDigest
  TEXT NOT NULL` (§3.5), `rowCount INTEGER NOT NULL` — the descriptor
  duplicated inside the file so a segment at rest is self-describing.
  (DECISION: the draft's `rowCursor`/`nextRowCursor`/`isFirstPage`/
  `isLastPage` columns are dropped — a format-1 image is inherently
  whole-table, and dead always-NULL variance is exactly what SSP2 kills.)

**Application contract** (the §5.6 rules, specialized): the client
applies the whole image in **one local transaction** — the §5.6
fresh-bootstrap first-page clear (an image is always the first page),
then replace-or-upsert every image row by primary key with
`_syncular_version` landing as the row's last-known `server_version`.
Mechanics are implementation detail (ATTACH + `INSERT INTO … SELECT`,
`sqlite3_deserialize`, or row copy); the contract is replace-all
semantics plus version seeding. Before applying, the client MUST:

1. verify the content address (§5.1) — this is the sole integrity check
   for the bytes themselves;
2. reject bytes that do not open as a SQLite database, a missing or
   multi-row `_syncular_segment`, or metadata that does not match the
   descriptor and the client's own state (`format` = 1, `"table"`,
   `asOfCommitSeq`, `scopeDigest`, `rowCount` each equal to the
   descriptor's fields; `schemaVersion` equal to the client's) — all
   `sync.invalid_request`, aborting per §1.4 rule 5 (the cursor and
   resume token stay unpersisted; re-pulling recovers);
3. validate the data table's column names **and order** against the
   generated schema for (`table`, `schemaVersion`) plus the trailing
   `_syncular_version` — a mismatch is fatal (`sync.schema_mismatch`),
   exactly the §5.2 column-table rule (validate, never infer). Declared
   affinities and NOT NULL constraints are producer conformance rules;
   receivers MAY additionally check them.

**Determinism and reuse.** Sqlite images are **not** required to be
byte-deterministic: SQLite files embed page-layout and library-version
detail that no cross-implementation canon can reasonably pin. The
content address pins exactly the bytes the server served (integrity and
cacheability per §5.1), not a canonical encoding — golden vectors
therefore never pin image bytes, and two conformant servers may produce
different `segmentId`s for the same logical snapshot. Cross-client dedup
consequently comes from server-side reuse, not hash convergence: a
server SHOULD serve one stored image per (partition, table,
schemaVersion, scope digest, `asOfCommitSeq`) and MUST NOT rebuild per
client while an unexpired one exists for that key — the §5.1
build-once SHOULD made hard for the format where identical bytes cannot
be assumed. This is the bootstrap-storm answer: N clients holding the
same scopes at the same pin download one image (from the CDN, with
§5.4 signed URLs).

**Eligibility.** Servers SHOULD produce a sqlite segment when the
client advertises `accept` bit 2 (§4.2) and the table's snapshot
exceeds one rows page (more than the clamped `limitSnapshotRows` rows
at the pin — the reference server's rule); below that, inline rows
segments already avoid the extra round-trip. A client that does not
advertise bit 2 is served the rows lane (§5.2) by capability
negotiation — rows segments remain mandatory-to-implement, so this is
version-skew tolerance, not a fallback path in the REVISE sense.

**Error codes.** No new codes: structural/metadata failures are
`sync.invalid_request`, the column check is `sync.schema_mismatch`,
download-side failures are §5.5's (`sync.not_found`,
`sync.segment_expired`, `sync.forbidden`).

### 5.4 `SEGMENT_REF` frame — the descriptor

| Field | Type | Semantics |
|---|---|---|
| `segmentId` | `str` | §5.1 |
| `mediaType` | `u8` | `1` = rows, `2` = sqlite |
| `table` | `str` | |
| `byteLength` | `i64` | Uncompressed size (progress UI, sanity cap) |
| `rowCount` | `i64` | |
| `asOfCommitSeq` | `i64` | MUST equal the bootstrap pin |
| `scopeDigest` | `str` | §3.5 |
| `rowCursor` | `opt(str)` | Page start (absent = first page) |
| `nextRowCursor` | `opt(str)` | Page continuation (absent = last page of the table) |
| `url` | `opt(str)` | Short-lived signed URL (see below); present only if the client advertised `accept` bit 3 |
| `urlExpiresAtMs` | `opt(i64)` | MUST be present iff `url` is |

**Download resolution (capability negotiation, not fallback).** A
client advertises `accept` bit 3 (§4.2) iff it can fetch a bare URL;
the reference clients advertise it whenever their segment downloader
exposes a direct URL fetch. Which path a segment travels is decided at
issuance: a descriptor with a `url` MUST be fetched from that URL (zero
sync-server egress); a descriptor without one is downloaded via the
direct endpoint (§5.5) — the path for clients that did not advertise
bit 3. Three MUSTs pin the url path:

- **The URL is the entire grant.** The client MUST NOT attach host
  authentication, `X-Syncular-Scopes`, or any other sync-server
  credential to a signed-URL fetch — signed URLs point at CDN/object
  hosts that must never see host auth.
- **No fetch past expiry.** A client MUST NOT start a fetch at or after
  `urlExpiresAtMs` (client clock; the ≤ 60 s verify skew in the native
  scheme exists for clock error, not as a client allowance). An
  already-expired descriptor is a failed descriptor (next rule), with
  `sync.segment_expired` semantics (§10.2): re-pulling mints fresh
  descriptors.
- **Failure invalidates the descriptor.** A failed url fetch — expired
  before fetch, transport error, non-success status, or a §5.1
  content-address mismatch — invalidates the whole descriptor. The
  client MUST NOT fall through to the direct endpoint (a second
  delivery attempt under a different auth story is exactly the fallback
  class SSP2 removes) and MUST abort the subscription per §1.4 rule 5;
  recovery is the next pull, which re-authorizes and mints fresh
  descriptors (§5.5 recovery contract).

A `url` on a descriptor when the client did not advertise bit 3 is a
broken server: reject as `sync.invalid_request`, aborting per §1.4
rule 5 (the §4.2 mask contract, applied to delivery capability).
Content-address verification (§5.1) applies to the transport-decoded
bytes exactly as on the direct endpoint (§5.8).

**Signed URL claims (native scheme).** When the host serves segments
itself (or via a store that delegates auth to it), the URL carries a
token query parameter `st`:

```
st = base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, payloadJson))
payloadJson = {"v":1,"seg":"<segmentId>","sd":"<scopeDigest>",
               "aud":"<partition token>","exp":<unix seconds>}
```

`exp` is unix **seconds** (JWT convention) — the sole non-millisecond
timestamp in this spec. `aud` is an opaque host-chosen value that MUST
be stable per partition and MUST NOT let clients derive the internal
partition id (a keyed derivation such as `HMAC(key, partitionId)`
satisfies both); it is minted and verified by the same host, and clients
treat the whole `st` token as opaque — §2.1's "partitions never appear
on the wire" holds in the sense that no *client-interpretable* partition
field exists. The verifier MUST check the MAC, `exp` (with ≤ 60 s skew
allowance), `seg` equality with the requested segment, `sd` equality
with the segment's stored `scopeDigest`, and `aud` equality with the
value derived from the segment's partition. `sd` binds the token to the
effective scopes that were authorized at issuance — issuance happens
inside the pull, immediately after scope resolution, so a signed URL is
never minted for scopes the actor did not hold at that moment. TTL SHOULD be ≤ 15 minutes: the
revocation window for already-issued URLs equals the TTL, which is the
accepted trade for CDN offload (the pull itself re-authorizes every
time, so new URLs stop immediately on revocation).

**Delegated presign (S3/R2/GCS).** A server MAY instead emit provider
presigned URLs. Equivalence rule: the signed object key MUST embed the
`segmentId` (so the grant is bound to exactly one immutable object) and
the expiry MUST obey the same TTL guidance. Provider-presigned delivery
is behaviorally indistinguishable to the client. The native token's
`sd`/`aud` bindings are *intentionally* absent here: issuance happens
inside the pull, immediately after scope resolution, so authorization
is bound at issuance time and the object is immutable — the provider's
signature replaces the claim checks, not the authorization. Providers
enforce presign expiry with zero skew (the ≤ 60 s skew allowance above
is native-token-only); this changes nothing for clients, which MUST
NOT retry a URL past `urlExpiresAtMs` regardless of issuer.

### 5.5 Direct download endpoint and re-authorization

`GET <mount>/segments/{segmentId}` — the fallback path, and the only path
for clients without signed-URL support.

- The request carries normal host authentication plus the header
  `X-Syncular-Scopes`: the canonical JSON (§11.2) of the requested scope
  map for the owning subscription.
- The server MUST re-authorize on **every** download: run
  `resolveScopes` for the actor, compute effective scopes against the
  supplied requested scopes (§3.2), compute the scope digest (§3.5), and
  compare with the segment's `scopeDigest`. Mismatch, revoked status, or
  resolution failure ⇒ HTTP 403 `sync.forbidden`. A segment reference
  obtained earlier is not a bearer capability; only signed URLs are
  (deliberately, with short TTL).
- A server MAY eventually *forget* an expired segment entirely (object
  stores garbage-collect); from that point the segment is
  indistinguishable from never-existing and `sync.not_found` applies —
  the expired→forgotten transition is legal and clients MUST treat both
  codes' recovery path identically (re-pull mints fresh descriptors).
- Unknown segment ⇒ HTTP 404 `sync.not_found`; known-but-expired
  segment ⇒ HTTP 404 `sync.segment_expired` (§10.2 — the retryable one:
  re-pulling mints fresh descriptors).
- Response headers: `Content-Type: application/octet-stream`,
  `ETag: "<segmentId>"`, `Cache-Control: private, max-age=0`,
  `Vary: Authorization, X-Syncular-Scopes, Accept-Encoding`.
  `If-None-Match` with a matching ETag returns 304. `Content-Encoding`
  per §1.3 and §5.8.

### 5.6 Segment application contract (client)

- Segments for a table upsert by primary key: an existing row with the same
  primary key is updated and an absent row is inserted. Constraints outside
  the primary key retain their ordinary database semantics. In particular, a
  client MUST NOT use replace-style conflict handling that can delete a
  different row after a secondary unique-index collision; the colliding
  segment application aborts and preserves the existing row. On the **first page** of
  a table in a **fresh** bootstrap, the client MUST first delete local
  rows for the subscription's scope (same matching rule as the purge
  contract, §3.3, against the `SUB_START` effective-scope echo) so
  removed rows don't survive re-bootstrap.
- **First-page detection.** A bootstrap is *fresh* iff the request
  carried `cursor < 0` and no `bootstrapState` (a resumed bootstrap
  never re-clears — its earlier pages already applied). For a
  `SEGMENT_REF`, the first page is the descriptor with `rowCursor`
  absent. A `SEGMENT_INLINE` carries no descriptor: the first segment
  delivered for the subscription in the response is the first page.
- **Fail closed at the clear too.** The first-page delete uses the §3.3
  matching rule *including its fail-closed clause*: with no local
  scope-column mapping for an effective key, the client MUST NOT clear
  the table, MUST mark the subscription failed with
  `sync.scope_revoked` (a fatal configuration error — stop syncing the
  table), and MUST NOT persist the subscription's `SUB_END` values. The
  failure is subscription-local: the rest of the response still
  applies.
- Rows-segment blocks are applied transactionally per §1.4/§5.2; a
  sqlite image applies as one transaction (§5.3). The resume token is
  persisted only at `SUB_END`, so a crash mid-segment resumes
  conservatively (re-applying a block is safe by upsert idempotency).
- **Segment rows carry their server version** (per-row `serverVersion`
  in SSG2, §5.2; the `_syncular_version` column in sqlite images, §5.3).
  A client MUST store it as the row's last-known `server_version`,
  exactly as it stores a `COMMIT` change's `rowVersion` (§4.5):
  segment-applied rows participate in §6.2 `baseVersion` conflict
  detection identically to commit-delivered rows — a bootstrapped
  client can push optimistic-concurrency writes immediately, with no
  commit delivery in between.

### 5.7 `SEGMENT_INLINE` frame

Payload = one complete rows segment (§5.2, including magic). A payload
that is not a structurally valid rows segment is a decode error
(`sync.invalid_request`, per §5.2's error-code rule; the column-table
schema check remains the receiver's, and the raw payload bytes are
preserved for re-encoding like any other binary field). Servers
SHOULD inline segments smaller than 256 KiB (uncompressed) to avoid a
second round-trip for small tables; servers MUST NOT inline sqlite
segments. Semantics are identical to a referenced rows segment.

### 5.8 Compression

Transport compression for segments is §1.3 applied to the §5 delivery
paths; this section pins the shipped posture. The invariants first —
each already normative elsewhere, restated because this is where they
bite:

- `segmentId` hashes **uncompressed** bytes (§5.1); nothing in this
  section is visible to identity, golden vectors, or cache keys.
- Clients MUST handle `Content-Encoding` transparently (native fetch
  decompression, §0 — no decompression code in the client bundle) and
  MUST verify the content address over the decoded bytes.
- Servers MUST NOT double-compress: segment bytes are stored and
  addressed uncompressed; compression is applied per response by the
  serving hop, never baked into the stored object.

Shipped defaults (reference server; decided 2026-07-03 on measured
data — 100k-row bench table, Bun 1.3):

- **Direct endpoint (§5.5): compress both formats**, negotiated from
  the request's `Accept-Encoding` — `zstd` preferred, `gzip` fallback,
  identity when the client offers neither. Measured: rows segments
  (7.2 MB) compress 6.2× in 8 ms (zstd) / 7.7× in 42 ms (gzip); sqlite
  images (7.8 MB) compress 3.4× in 14 ms (zstd) / 51 ms (gzip);
  client-side decompression ≤ 8 ms either way. The transfer saving
  dwarfs the CPU cost on any real network, and the latency-critical
  image lane keeps its §5.3 win: 14 ms of zstd against a 3.4× smaller
  multi-MB transfer. The 304 path is unaffected; `Vary` includes
  `Accept-Encoding` (§5.5).
- **Signed-URL path (§5.4): objects are stored and served
  uncompressed.** The content address pins the stored bytes and
  presigned GETs serve them verbatim (§5.4 equivalence rule); a host
  MUST NOT store pre-compressed bytes under the segment id. Transfer
  compression on this path is a deployment concern (CDN edge
  compression), deliberately out of protocol scope.
- **Inline segments and WS-delivered frames: no per-segment
  compression.** They ride inside the SSP2 stream, whose transport
  compression is §1.3's concern (§0: compression moves to the
  transport — there is no compression field anywhere in SSP2).

### 5.9 Blobs — file attachments

Blobs are opaque
byte payloads (images, documents, arbitrary files) too large or too binary
to ride inline in rows. A row **references** a blob through a `blob_ref`
column (§2.4 tag 7); the bytes live as **content-addressed objects** in the
same store family segments use, uploaded before the referencing row is
pushed and downloaded on demand — never in the pull stream. Blobs reuse the
codec (rides `json`), the content-address discipline (§5.1), the store
abstraction, and the signed-URL machinery (§5.4); the genuinely new
surfaces are the reference index, the download authorization rule, and the
client refcounted cache lifecycle.

**Explicit non-goals this rung** (deferred until evidence demands):
chunked/resumable upload, client-side encryption, blob versioning
(content addressing makes bytes immutable — a "new version" is a new blob
and a row update to the new ref), and inline-blob optimization (small
blobs still round-trip as an upload + a `blob_ref`, never embedded in the
row payload).

#### 5.9.1 The `blob_ref` value — canonical BlobRef

A `blob_ref` column value is a `str` carrying a **canonical BlobRef JSON
document**. The shape is pinned (so the digest, the codec round-trip, and
cross-implementation rendering all agree):

```json
{"blobId":"sha256:<64 lowercase hex>","byteLength":<int ≥ 0>,
 "mediaType":"<string>","name":"<string>"}
```

- `blobId` (**required**): `"sha256:"` + lowercase-hex SHA-256 of the blob
  bytes — the content address, identical in form to `segmentId` (§5.1).
- `byteLength` (**required**): non-negative integer within the i64
  safe-integer contract (§0), the blob's uncompressed size.
- `mediaType` (**optional**): an advisory MIME type; the server never
  parses or trusts it (content addressing is over bytes, not type).
- `name` (**optional**): an advisory display filename.

**Canonical key order is exactly `blobId`, `byteLength`, `mediaType`,
`name`**, absent optional keys omitted; the JSON has no insignificant
whitespace. A `blob_ref` value that parses as JSON but violates this shape
(missing/malformed `blobId`, missing/negative/non-integer `byteLength`,
non-string optional fields, unknown keys, or non-canonical key order) is a
**row-codec decode error** (`sync.invalid_request`, in §5.2's closed
list) — validated at the same decode point as the `json` tag-5 parse, so
codec and rendering never disagree. The BlobRef is host-opaque beyond this
shape check: the codec preserves the raw string byte-for-byte for
re-encoding exactly as it does a `json` value.

A `blob_ref` column is nullable like any other; NULL means "no
attachment". Two rows MAY reference the same `blobId` (content dedup is
the point). A `blob_ref` column is never a primary key (`rowId` rendering
excludes it, the same rule as `bytes`).

#### 5.9.2 The blob store and existence model

Blob bytes are **content-addressed objects** keyed by `blobId`, held in
the same store family as segments (a `BlobStore` sharing the S3/R2 backend
and its presign machinery; the reference server ships an in-memory, a
SQLite, and an S3-backed store, mirroring segments). Unlike segments,
blobs are **durable**, not TTL cache entries: a blob referenced by a live
row must remain downloadable indefinitely (§5.9.5 B3).

Existence model for this rung (kept minimal and honest):

- **Upload-before-reference.** A client uploads blob bytes (§5.9.3)
  *before* pushing a row that references the `blobId`. The content address
  is known client-side, so the upload needs no server round-trip to
  discover the id.
- **A push referencing an absent blob fails loud** (§5.9.6): the commit is
  `rejected` with `blob.not_found`. This makes "referenced ⇒ present" an
  enforced invariant, not a hope.
- **Orphans are swept, not row-tied-deleted.** A blob uploaded but never
  referenced (an abandoned upload) becomes an orphan. Row-tied deletion
  ("delete the bytes when the last referencing row is deleted") is a hard
  distributed-GC problem — refcounting across partitions, races with
  in-flight uploads, replay — and is **deliberately out of scope this
  rung**. Instead: a blob unreferenced by any live row for longer than a
  host-configured grace period (default 24 h, comfortably longer than any
  upload→push window) is eligible for a **host-scheduled sweep**
  (`blobStore.sweepOrphans(olderThanMs)`), analogous to segment TTL
  expiry. The sweep consults the reference index (§5.9.4): a blob with
  zero index entries and an upload age past the grace period is deleted.
  Deleting a still-referenced blob is a host bug; the sweep never does it.

#### 5.9.3 Upload — `PUT <mount>/blobs/{blobId}`

The fourth mounted route (§1.1). Request carries **normal host
authentication** (the same `authenticate(request)` as `/sync`); the body
is the raw blob bytes (`Content-Type: application/octet-stream`,
`Content-Encoding` per §1.3 handled by the serving hop — the server hashes
the *decoded* bytes).

- The server **MUST verify the content address**: SHA-256 of the received
  bytes, rendered `"sha256:"+hex`, MUST equal the `{blobId}` path
  parameter. A mismatch is HTTP 400 `blob.hash_mismatch` (non-retryable —
  the client computed the wrong id or corrupted the body). This is the
  whole trust model: a client cannot poison a content address, because the
  server recomputes it.
- A blob that already exists (same `blobId`) is an **idempotent success**
  (HTTP 200) — content addressing makes re-upload a no-op; the server MAY
  skip re-storing identical bytes.
- The server MAY enforce a **maximum blob size** (host-configured); an
  over-limit body is HTTP 413 `blob.too_large` (non-retryable). Enforced
  by declared `Content-Length` where present and again on the streamed
  byte count.
- On success the response is HTTP 200 with an empty body; the blob is now
  present for reference by a subsequent push. Upload authorization is
  **host authentication only** — uploading bytes is not a scope-bearing
  act (the uploader already holds the bytes; content addressing means the
  id discloses nothing). Read authorization is enforced at *download*
  (§5.9.5), which is where a `blobId` could otherwise become a capability.

**Presigned upload — direct-to-storage (`POST <mount>/blobs/{blobId}/upload-grant`).**
A capability, not a fallback (the §5.4 doctrine): when the host configured
a presigned-upload store the client MAY skip the server bandwidth path and
`PUT` the bytes straight to the object store. The direct upload above
(`PUT <mount>/blobs/{blobId}`) **remains the path** when no presign config
exists — no server ever *requires* the grant flow, and a client that gets
no grant simply streams through the server (§5.9.7 B4 flushes either way).

The grant flow, three hops, no new trust model:

1. **Ask.** `POST <mount>/blobs/{blobId}/upload-grant` under **normal host
   authentication** (the same `authenticate(request)` as `/sync` and the
   direct PUT), body `{"byteLength":<int ≥ 0>,"mediaType":"<string>"?}` —
   the JSON envelope, not raw bytes. The `{blobId}` is the client-computed
   content address (the client holds the bytes; content addressing means it
   knows the id before any round-trip, §5.9.2).
2. **Authorize + presign.** Upload authorization is **host authentication
   only**, identical to the direct PUT — uploading bytes is not a
   scope-bearing act, because the id discloses nothing and the content
   address is verified at *reference* time, not upload time. *Any
   authenticated actor may obtain a grant within the host size cap.* The
   server enforces the §5.9.3 size cap **here, up front**, against the
   declared `byteLength`: an over-cap request is HTTP 413 `blob.too_large`
   before any URL is minted (the direct path's streamed-byte cap check is
   gone from the object-store hop, so the cap MUST be applied at grant
   issuance). If the blob already exists (idempotent §5.9.3), the server MAY
   return no URL and a present marker — the client then skips the PUT. The
   server presigns a **single** PUT (never a multipart or chunk protocol —
   an explicit non-goal, this rung and the next; resumable upload, when it
   comes, is provider multipart behind this same grant, never our own chunk
   framing) whose signed object key embeds exactly the `{blobId}` and whose
   expiry obeys the §5.4 TTL guidance (≤ 15 min). The presign SHOULD bind
   `Content-Length` (S3 conditional) to the declared `byteLength` so the
   object cannot exceed the granted size. Response:
   `{"url":"<presigned PUT>","urlExpiresAtMs":<i64>}` (the JSON envelope;
   `urlExpiresAtMs` present iff `url` is, the §5.4 pairing), or
   `{"present":true}` for the idempotent-skip case.
3. **PUT direct.** The client `PUT`s the raw bytes to `url` with **no host
   authentication attached** — the presigned URL is the entire grant, the
   §5.4 rule verbatim: a signed URL points at an object host that must never
   see host auth. All §5.4 client URL MUSTs apply: no `PUT` at or past
   `urlExpiresAtMs`; a failed `PUT` (expired, transport error, non-success
   status) **invalidates the grant** — the client MUST NOT fall through to
   the direct `PUT` endpoint under the grant's authority (a second delivery
   under a different auth story is the fallback class SSP2 removes). Recovery
   is a *fresh* grant request (which re-authorizes and re-presigns), or — a
   client MAY, as a capability choice, stream the same bytes through the
   direct `PUT <mount>/blobs/{blobId}` endpoint instead, because that is a
   **different, host-authenticated capability**, not a fall-through of the
   grant (the direct endpoint was always the client's other path, §5.9.7 B4).

**The content address is still the whole trust model.** The object store
does not recompute the SHA-256 (it is not the sync server); the presign
merely places bytes at the content-addressed key. Integrity is enforced
**at reference time**: the §5.9.6 push existence check verifies the
`{blobId}` object *exists* (a HEAD/`has`), and the §5.9.1 download check on
every consumer re-verifies the content address over the received bytes
(§5.9.5 inherits §5.1). A client that PUTs bytes not matching `{blobId}`
poisons only its own upload — the object lands at the wrong key or a
`Content-Length`-conditioned PUT rejects it, and no honest reference ever
resolves to it. So presigned upload adds **no new integrity surface**: the
address check that made the direct PUT safe still runs, just at the two
points that already run it (push existence, download verify). This mirrors
§5.4's stance — presign is an equivalence, not a new contract.

#### 5.9.4 The reference index

The server maintains a **blob reference index**: for each
(partition, `blobId`), the set of (table, rowId) rows that currently
reference it, derived from applied `blob_ref` column values. It is the
exact analogue of the §3.1 scope index — maintained on the write path, in
the same commit transaction as the row write (§6.4), never scanned for:

- On an applied **upsert** whose row has a non-NULL `blob_ref` column, the
  server inserts an index entry (partition, blobId, table, rowId). If the
  upsert *changes* the column from one blob to another (or to NULL), the
  old (rowId → old blobId) entry is removed in the same transaction.
- On an applied **delete**, all index entries for that (table, rowId) are
  removed.
- The index feeds two consumers: the **download authorization rule**
  (§5.9.5 — "is there a referencing row the actor may see?") and the
  **orphan sweep** (§5.9.2 — "does any live row reference this blob?").

This is additive to storage: it is the blob analogue of the mandated
commit→scope inverted index (§3.1), and Postgres/SQLite implement it as
one covering-indexed table.

#### 5.9.5 Download — `GET <mount>/blobs/{blobId}` and authorization

Blobs are fetched **on demand**, never delivered in the pull stream. The
download path is the segment path's twin (§5.5): re-authorization on every
request, native + presigned signed-URL issuance, no bearer-capability.

**The authorization rule — a `blobId` is never a capability.** The server
MUST verify the actor is authorized to see the blob, and authorization
**derives from the referencing rows, not the blob id**:

> The actor may download `blobId` iff **at least one row in the reference
> index for (partition, blobId) is authorized for the actor** under the
> write-path scope check (§3.4 steps 1–3): resolve the actor's allowed
> scopes once (§3.2 step 3), and for each candidate referencing row, test
> the row's stored scope values against the allowed values for every
> declared scope variable of that row's table. The first row that passes
> authorizes the download; if none pass (or the index is empty, or
> `resolveScopes` threw), the download is **HTTP 403 `blob.forbidden`**
> (never 404 — leaking existence-vs-authorization is the same class of
> footgun §5.5 closes for segments).

Rationale for reusing the §3.4 stored-row check rather than a segment-style
scope digest: a blob is referenced by *rows across potentially several
scopes*, not built for one effective-scope set, so there is no single
digest to bind. The reference index makes the check a bounded indexed
lookup (candidate rows for the blob) followed by the existing per-row scope
test — the same machinery write authorization already runs. `'*'` in the
actor's allowed values passes as everywhere else.

- **Unknown blob** (no object stored) ⇒ HTTP 404 `blob.not_found`.
- **Signed URLs — always-issue (no capability negotiation).** When the host
  configured signed URLs, download **is** served as a signed URL: after the
  row-derived authorization above passes, the server returns
  `{"url":"<presigned GET>","urlExpiresAtMs":<i64>}` and **does not stream
  the bytes** (the whole point — the sync server exits the download egress
  path). Native HMAC token (payload
  `{"v":1,"blob":"<blobId>","aud":"<partition token>","exp":<unix
  seconds>}` — note it binds `blob` + `aud`, **not** a scope digest,
  because authorization was resolved against the referencing rows at
  issuance, immediately after the reference-index authorization check
  above; the object is immutable, so an issued URL is a
  short-TTL bearer grant to exactly those bytes) or delegated presign (the
  signed object key embeds the `blobId`). **Why always-issue, not accept-bit
  negotiation** (the pinned decision): segments gate URL issuance on accept
  bit 3 (§5.4) because a segment descriptor rides the *pull stream* to a
  client that may be unable to fetch a bare URL — so the server must know at
  descriptor-emission time whether to embed one. A blob download is a plain
  request/response on `/blobs/{blobId}`: the response envelope carries the
  URL, and a client that cannot consume it re-requests without any negotiated
  bit. Always-issue is *harmless* because the authorized endpoint is the same
  route — there is no descriptor stuck on a stream — and *simpler* because it
  needs no accept-bit plumbing on a non-pull path. The reference clients
  always consume the URL when present; a client that does not understand the
  field re-requests and the host MAY serve inline for a request that signals
  no URL capability, but that inline path is a host convenience, not a
  protocol negotiation. All §5.4 client MUSTs apply verbatim: the URL is the
  entire grant (no host auth attached), no fetch past `urlExpiresAtMs`,
  failure invalidates and recovery is a fresh download request — never a
  fall-through. TTL SHOULD be ≤ 15 minutes; the revocation window equals the
  TTL (a fresh download request re-authorizes every time).

**The recovery rule (mirrors §5.4, pinned).** A blob download URL is a
descriptor with exactly one delivery attempt. A client that received
`{url, urlExpiresAtMs}`:

- MUST fetch the bytes from `url` with **no host authentication** attached
  (§5.4: the URL points at a CDN/object host that must never see host auth).
- MUST NOT start a fetch at or past `urlExpiresAtMs` (client clock).
- MUST verify the §5.1 content address over the received bytes before
  caching — a mismatch is a failed fetch, exactly as on the inline path.
- On any failure (expired before fetch, transport error, non-success status,
  or content-address mismatch) MUST NOT fall through to a second delivery of
  the same download response. **Recovery is re-requesting the authorized
  endpoint** (`GET <mount>/blobs/{blobId}`), which re-authorizes against live
  rows (§5.9.5) and mints a *fresh* URL. Because a blob download is a single
  request (not a bootstrap stream), a failed URL simply means the client
  calls `fetchBlob` again — there is no cursor or resume token to leave
  unpersisted; the cache stays a miss until a fetch succeeds. This is the
  §5.4 rule 5 discipline reduced to its blob shape: failure ⇒ re-request,
  never fall-through.
- Response headers on the direct path: `Content-Type` from the stored
  `mediaType` if the host chose to persist it, else
  `application/octet-stream`; `ETag: "<blobId>"`;
  `Cache-Control: private, max-age=0`;
  `Vary: Authorization, Accept-Encoding`. `If-None-Match` with a matching
  ETag returns 304. Blobs are opaque bytes; the server MUST NOT
  re-compress at rest (content address = stored bytes, §5.8 rule), though
  the serving hop MAY apply transport compression (`Content-Encoding`)
  over the wire like any other body.

#### 5.9.6 Push-time existence check

The point where "referenced ⇒ present" is enforced (§6.6 restates it in
push terms). During push apply (§6.4), for every upsert operation whose
row carries a non-NULL `blob_ref` value, **the server MUST verify the
referenced `blobId` exists in the blob store before the commit is
applied**. An absent blob rejects the operation with **`blob.not_found`**
(non-retryable in the sense that *this* payload won't succeed until the
blob is uploaded; the client's recovery is to upload the blob and re-push,
which the outbox does automatically since the commit stays pending). The
check runs inside the commit transaction, so a commit that references any
absent blob is rolled back whole (§6.4). Delete operations carry no row
payload and reference no blob — they skip the check.

#### 5.9.7 Client cache lifecycle (constraints B1–B4)

The client caches blob bytes locally, **content-addressed and refcounted
by referencing rows** — the DESIGN-eviction.md B1–B4 constraints, now
normative:

- **B1 — Refcounted, content-addressed cache.** Cached blob bodies are
  keyed by `blobId`; the refcount for a `blobId` is the number of local
  rows whose `blob_ref` columns currently reference it. The cache does not
  assume a body exists for a referencing row (it may be online-only, not
  yet fetched) nor a referencing row for a body (a fetched body whose rows
  were all deleted is zero-ref). A zero-ref body is **evictable** (LRU /
  storage-pressure policy) — the shipped default is **retain until storage
  pressure** (device-friendly re-entry UX; delete-on-zero-refs stays
  policy-configurable). Reference counting is maintained through the one
  apply-path choke point (§5.6 apply, §4.5 commit apply, §3.3 purge, §5.6
  first-page clear): every mutation that adds, changes, or removes a
  `blob_ref` value adjusts the refcount.

  **Where the bytes live — the pinned storage model.** Cached blob bodies
  are stored as **BLOB columns in the client's own SQLite database**, in a
  `_syncular_blobs` cache table alongside the synced rows and the refcounts.
  Decision, justified against the alternatives: (a) *one storage system* —
  the bytes are transactional with the refcount rows that pin them (a
  refcount adjust and a body insert/delete commit atomically, so a crash
  never strands a body against a stale count); (b) *survives restarts for
  free* — the client DB already rides OPFS via the SQLite sahpool VFS in the
  browser and a plain file under `rusqlite` on native, so no second
  persistence surface (an OPFS blob directory, an IndexedDB store, a native
  filesystem cache) and no second eviction policy to keep coherent; (c)
  *SQLite handles multi-MB images fine* — a page-cached BLOB read is a
  memory copy, well within the image-attachment envelope this rung targets.
  The alternatives rejected: a separate OPFS/filesystem blob directory would
  double the storage systems and break the transactional pin (the classic
  "row says present, file is gone" skew); IndexedDB adds a third async store
  the native core cannot mirror. **The "very large media" caveat**: SQLite
  is not the store for gigabyte video — a single BLOB must fit the client's
  memory and the SQLite row-size envelope. An app attaching very large media
  SHOULD store it presigned-URL-only (fetch bytes through the §5.9.5 URL and
  hand them straight to a media element, never through the byte cache) or
  run the client in a no-body-cache mode (resolve `blob_ref` → download URL
  on demand, cache nothing). The refcounted-BLOB cache is the default for
  images and documents; the presigned-URL path is the escape hatch for media
  that must not sit in the row store.

  **Size cap + LRU eviction (the shipped trim).** The client MAY be given a
  cache size cap (bytes). When the sum of cached body sizes exceeds the cap,
  the client evicts **zero-ref, non-pinned bodies in least-recently-used
  order** until the cache is back under the cap. Eviction NEVER touches a
  body that is (i) currently referenced by a live row (refcount > 0 — a
  referenced body stays resolvable without a re-download, the cache-hit
  contract) or (ii) pinned by a pending upload (§5.9.7 B4 — its bytes are the
  only copy until the push drains). An evicted referenced body is a
  contradiction the eviction MUST NOT create; if every body over the cap is
  referenced or pinned, the cache stays over the cap (correctness beats the
  cap — the alternative is dropping bytes an app still needs). Evicting a
  zero-ref body is always safe: B3 guarantees any surviving `blob_ref` value
  re-enables the fetch, so eviction only costs a future re-download, never
  correctness. "Recently used" is touched on both `putCachedBlob` (a fetch or
  an upload stage) and a cache-hit read, so a hot image survives a trim.
- **B2 — Evicted ≠ revoked.** Two distinct transitions delete blob bytes
  differently: **revocation** (§3.3 — authorization lost) MUST delete the
  no-longer-authorized bodies whose only referencing rows are being purged
  (losing the grant means losing the bytes); **window
  eviction** (future §4.8; a voluntary retention trim) MAY retain a
  zero-ref body as an LRU cache entry. This rung implements the revocation
  side (purge drops refs and deletes now-zero-ref bodies that were
  reachable *only* through purged rows); the eviction side is a no-op
  until windowed sync lands, but the refcount discipline is built so it
  slots in.
- **B3 — BlobRefs are always resolvable.** A `blob_ref` value on any local
  row is sufficient to fetch its bytes: the `blobId` in the value is the
  whole download key, and download is re-authorized server-side against
  live rows (§5.9.5). No download-necessary bookkeeping lives in
  row-adjacent state that a purge or eviction deletes — re-entry
  re-delivers the row's `blob_ref`, and that alone re-enables the fetch.
- **B4 — Upload state keys off the outbox.** A pending blob upload is
  tracked **on the outbox commit that will reference it**, not on row
  presence. When a mutation attaches a blob, the client records the blob
  bytes (or a handle to them) against the pending commit; the sync loop
  uploads any not-yet-present blobs (§5.9.3) **before** pushing the
  commit's `PUSH_COMMIT` frame, so the §5.9.6 server check passes. The
  optimistic local row and its blob body are both pinned by the same
  outbox pin (a pending commit references the row; E1 of the eviction
  design) until the commit drains. A rejected commit (§6.3) drops its
  outbox entry and releases its upload state; the uploaded bytes become an
  orphan swept by §5.9.2.

Client download resolution: a query/read that surfaces a `blob_ref` value
gives the app the `blobId` + metadata; the app requests bytes through the
client's blob API, which returns a cache hit if present (no network) or
fetches via the blob transport (§5.9.5) and populates the cache. **A cache
hit MUST avoid re-download** — the conformance harness asserts this with a
download counter.

### 5.10 CRDT columns — opt-in collaborative state

A `crdt` column
(§2.4 tag 8) carries opaque CRDT bytes — a Yjs update, a state, an RGA log
— that the **server merges** on push instead of last-write-wins overwriting
or `baseVersion`-conflicting. This is the hybrid-consistency pillar:
a table mixes ordinary LWW/optimistic columns and CRDT columns freely, and
each column type gets the consistency model it needs, on the same row and in
the same commit. The merge function is **pluggable** (the core stays
dependency-light and Rust-portable), and the exact §6.2 interaction is
pinned below.

**Explicit non-goals this rung** (deferred until evidence demands): CRDT
state-vector hints on the wire (kept out of the SSP2 core, §0; a delta-request
optimization, not correctness), client-side merge (merging is server-side
this rung — see §5.10.4), presence/awareness (a §8.6 reserved extension, not
a column type), and more than one built-in `crdtType` (`yjs-doc` only;
the registry is open for hosts to add others).

#### 5.10.1 The schema-IR shape and `crdtType`

A `crdt` column declares, beyond the tag, a **`crdtType`** name — a string
selecting the server-side merger (this rung defines exactly one:
`'yjs-doc'`). `crdtType` is schema-IR metadata: it is **never encoded on
the wire** (the SSG2 column table carries only name/type-tag/nullable, and
`crdt` shares the `bytes` tag), so it neither appears in golden vectors nor
participates in the §5.2 column-table validation — a receiver validates a
`crdt` column as a `bytes` column by tag, and the `crdtType` is a local
concern of whichever side merges. A schema whose `crdt` column names an
unknown `crdtType` is a **compile-time server bug** (rejected before
serving), never a wire error.

A `crdt` column is nullable like any other; NULL means "no CRDT state yet"
(the empty document). A `crdt` column is never a primary key or a scope
column (`rowId` and scope rendering exclude it, the same rule as `bytes`).

#### 5.10.2 The merger registry (`CrdtMerger`) — pluggability

The server core MUST NOT hard-depend on any CRDT library. Merging is a host
capability supplied through the request context (§ server B2): a
**`CrdtMerger` registry** mapping `crdtType` → a merge function

> `merge(stored: bytes | null, incoming: bytes) → merged: bytes`

where `stored` is the column's current value (`null` if the row is new or
the column was NULL) and `incoming` is the pushed value. The result is the
new column value written to storage and emitted in the change. A merger MUST
be **commutative, associative, and idempotent** over the updates it consumes
(the CRDT contract — this is what makes concurrent-order-independent
convergence and idempotent replay hold); the reference `yjs-doc` merger
satisfies this because Yjs updates are a CRDT.

The registry is optional in the context. If a table has a `crdt` column but
**no merger is registered for its `crdtType`**, a push touching that column
fails the operation with the new code **`sync.crdt_merge_failed`**
(category `internal`, non-retryable, action `inspectServer` — a server
misconfiguration, fail loud) and rolls the commit back (§6.4). A merger that
**throws** produces the same rejection. `sync.crdt_merge_failed` never rides
the pull stream and is never a `SUB_START` reason — it surfaces only as a
push operation-result `error` record (§6.3).

The reference `yjs-doc` merger lives in a **separate package**
(`@syncular/crdt-yjs`), not in core or server — Yjs enters the dependency
tree there and nowhere else. `packages/server` and `packages/core` stay
Yjs-free; a host opts in by importing the merger and putting it in the
registry, exactly as it opts into a blob store (§5.9.2). Placement rationale:
the merger and the client Yjs helper (§5.10.4) are two faces of the same
Yjs binding, so one small package owns both.

#### 5.10.3 The §6.2 push interaction — the pinned merge semantics

This is the heart of the rung. On a push **upsert** against a row (§6.4
apply), after the §3.4 scope-column strip and the §6.2 `baseVersion`
resolution, columns split by kind:

1. **`baseVersion` governs only the non-crdt columns.** The comparison
   `baseVersion == server_version` (§6.2) and the resulting
   `sync.version_conflict` are computed **exactly as today** — `crdt`
   columns are **excluded from the comparison**. The row's single
   `server_version` still increments by 1 on every applied upsert (§2.2),
   as the optimistic-concurrency token for the non-crdt columns.

2. **On a clean apply** (`baseVersion` matches, or `baseVersion` absent =
   last-write-wins, or an insert), each `crdt` column's stored value is
   replaced by `merge(stored, incoming)` (§5.10.2) — **never** the raw
   pushed bytes. Non-crdt columns write last-write-wins / optimistically as
   today. The merge runs inside the commit transaction (§6.4), so it is part
   of the atomic apply: a throwing/absent merger rejects the whole commit.

3. **On a conflict** (`baseVersion` mismatch on the row's non-crdt state),
   the operation is rejected `sync.version_conflict` and the commit rolls
   back atomically (§6.4) — **no merge is applied**, preserving commit
   atomicity (a half-applied commit is impossible, §6.4). The crdt edit is
   not lost: the client rebases (§6.5) and re-pushes. The conflict record's
   `serverRow` carries the **current** (already-merged, from prior clean
   applies) crdt column state, so the rebasing client sees live collaborative
   state without another round-trip.

**The "crdt-only divergence merges cleanly" rule, pinned.** A client whose
mutation touches **only** `crdt` columns MUST push it with **`baseVersion`
absent** (last-write-wins mode). In LWW mode there is no `baseVersion`
comparison, so the push never conflicts regardless of how far the row's
`server_version` has advanced; its crdt columns merge (rule 2) and its
non-crdt columns — which the mutation left at their last-known values — write
last-write-wins. This is what makes concurrent collaborative editing
conflict-free: two clients editing the same `crdt` column concurrently each
push a baseVersion-less upsert, both merge, and the merger's commutativity
makes the result independent of arrival order (Appendix B.14). A client that
*also* changes a non-crdt column in the same mutation MAY carry a
`baseVersion` to get optimistic concurrency on that column — and then a
concurrent non-crdt conflict fires per rule 3, with the crdt state merged
into the winner's row (rule 2 on the winning push) and surfaced in the
loser's `serverRow`.

Consequences, all normative:

- A `crdt` column **never** produces `sync.version_conflict` on its own
  account; conflicts are a non-crdt-column phenomenon.
- CRDT merges do **not** create a distinct commit shape: the merged column
  rides the ordinary upsert change (§4.5) with the row's incremented
  `server_version`. Subscribers receive the merged bytes as a normal row
  upsert — no CRDT-specific delta frame exists (§0: crdtStateVectors
  dropped; frame `0x18` stays reserved).
- **Idempotent replay is doubly safe.** A push replayed under the §2.3
  idempotency key returns the persisted result `cached` and is **not
  re-merged** (the merge already happened in the original apply). Even if a
  buggy client bypassed idempotency and re-pushed identical crdt bytes, the
  merger's idempotency (§5.10.2) makes the re-merge a no-op — Yjs updates
  are idempotent by CRDT nature. Offline outbox replay (§7.2) therefore
  converges regardless of how many times a crdt update is delivered
  (Appendix B.14 offline scenario).

#### 5.10.4 Client semantics — push updates, server merges

**Decision (pinned): clients push CRDT updates; the server merges; clients
apply the server-merged state on delivery.** The rejected alternative was
"push the full merged document state as the column value." Justification:

- **Update-push is smaller.** A keystroke is a few-byte Yjs update; the full
  document can be kilobytes. Pushing updates keeps the outbox and the wire
  proportional to the edit, not the document — the reason
  CRDTs are attractive over LWW-on-a-blob.
- **Server-side merge keeps the client thin and the core portable.** The
  merge (the only place a CRDT library is *required*) lives server-side in
  one pluggable function; the client only needs to *produce* updates and
  *apply* merged state — which a Yjs `Y.Doc` does natively, and which a
  native (Rust) app can defer entirely this rung (§5.10.5).
- **Idempotency covers the replay hazard.** The one risk of update-push
  over state-push is double-application of a replayed update; §5.10.3
  pins it closed twice over (idempotency-key `cached` + merger idempotency).

Mechanics for a Yjs client (reference TS path, `@syncular/crdt-yjs`):

- A `crdt` column is backed by a `Y.Doc` per (table, rowId, column). A local
  edit mutates the doc and yields a Yjs **update** (the bytes since the last
  push). The client writes those update bytes as the column value in a
  baseVersion-less `mutate` (§5.10.3), applies them to the local doc
  optimistically (§7.1), and pushes.
- On delivery of the server-merged column value (a pull `COMMIT` upsert, a
  segment row, or a conflict `serverRow`), the client applies the merged
  bytes into the local `Y.Doc` — idempotent, so a value that already
  incorporates the local edit is a no-op. The doc's text/map/array is the
  app-visible collaborative value; the raw column bytes are the transport.
- The stored column value is thus always "the latest server-merged bytes",
  and the local doc is "server-merged ⊕ local-pending". This mirrors the
  §7.1 outbox-replay-on-top model exactly, one layer down.

The reference row-value surface keeps the column a plain `Uint8Array` in
generated types (§ typegen); the `Y.Doc` accessor is a helper in the client
package (`@syncular/crdt-yjs`), **not** in generated code — codegen has no
Yjs dependency, matching the core/server rule.

#### 5.10.5 Native (Rust) clients

The Rust client does **not** merge (merging is server-side, §5.10.3). It
MUST round-trip `crdt` column bytes through push / pull / segments
byte-for-byte — a `crdt` column is a `bytes` column to the codec, so this is
free — and expose the bytes to the app. A native app integrating a CRDT
library (the `yrs` crate is the Rust Yjs port) applies and produces updates
in app code exactly as the TS client's helper does; wiring `yrs` into the
Rust core is a **follow-up**, not this rung. What this rung pins for the
native side is the **wire contract**: `crdt` = tag 8 = `bytes`, merged
server-side, exposed as opaque bytes. The conformance pairing (Appendix
B.14) proves this by having the Rust client push **fixture Yjs updates**
(generated by the TS side) and asserting the server-merged result equals the
expected merged bytes — byte-level convergence with no Rust-side merge.

#### 5.10.6 Error codes

One new code: **`sync.crdt_merge_failed`** (§10.2) — a `crdt` column was
pushed but no merger is registered for its `crdtType`, or the registered
merger threw (§5.10.2). Category `internal`, non-retryable, action
`inspectServer`; delivered only as a push operation-result `error` record
(§6.3), rolling the commit back (§6.4). No other new codes: a `crdt` column
that fails `bytes` decode is `sync.invalid_request` like any bytes column,
and there is no download/upload surface (CRDT state rides the row, never a
separate object).

---

### 5.11 Client-side encryption (E2EE) — opt-in per column

Selected columns may be **encrypted end-to-end**: the client encrypts the
value before it leaves the device and decrypts it after it arrives; the
server stores and serves **ciphertext** and never holds a key. This is the
one rung where a value's plaintext is invisible to the server, so its scope
is deliberately narrow and its constraints are hard.

**The architecture — encrypt at the wire boundary, plaintext locally.** The
local SQLite mirror stays **plaintext** (local queries, named queries, and
indexes keep working over real values). Encryption happens only at the
wire boundary: a configured column is encrypted when the outbox **encodes a
commit for send** (§6.1, §7.1) and decrypted when a `COMMIT` (§4.5) or a
rows segment (§5.2) **applies** to the local mirror. The row codec (§2.4) is
**unchanged** — it never encrypts. An encrypted column's **wire and stored
type is `bytes` (tag 6)** regardless of its declared app type; the codec
sees an ordinary `bytes` value carrying the ciphertext envelope below. Both
cores implement encrypt-on-encode and decrypt-on-apply symmetric to each
other; the golden vectors (§ Appendix A) are untouched because no wire tag
or frame is added.

**The schema IR marks the column.** A column's encryption is **app
configuration**, not DDL — it is declared in the generated-client manifest
(`syncular.json`, per-table `encryptedColumns`), not in a migration. The IR
records it as two additive per-column fields (like `crdtType`, never on the
wire): `encrypted: true` and `declaredType` (the pre-flip app type —
`string`, `json`, `integer`, …). The IR's `type` is set to `bytes` (the
wire type). Emitters keep typing the **app-side** value as `declaredType`;
the codec and local storage carry the ciphertext/plaintext per that type.
Columns without `encrypted` are byte-identical in the IR to before this
rung.

Named-query result inference follows the same application boundary. A direct
projection of an encrypted column is typed as its `declaredType` (including
nullability), because every supported query host reads the decrypted local
mirror. It MUST NOT expose the IR's `bytes` wire type in TypeScript, Swift,
Kotlin, or Dart query rows; ciphertext exists only across the wire and in
server storage.

**Hard generate-time errors (fail loud, §typegen).** A generated client
**MUST** reject at generate time:

1. an **encrypted scope column** — scope values are extracted server-side
   (§3.1) and MUST stay plaintext;
2. an **encrypted `crdt` column** — the server merges `crdt` bytes
   plaintext (§5.10.3), which is impossible over ciphertext;
3. an **encrypted primary key** — the pk renders the `rowId` (§2.2), a
   plaintext server-side identity;
4. an `encryptedColumns` entry naming a column the table does not declare.

**The ciphertext envelope — byte-exact, cross-core.** An encrypted column's
`bytes` value is the following envelope. All fields are contiguous, no
padding; the whole thing is the `bytes` payload the row codec length-prefixes
(§2.4). A `NULL` value is **not** encrypted — it stays `NULL` (the null
bitmap already hides it; encrypting NULL would leak nothing and cost a
distinguishable envelope), so an encrypted column is exactly as nullable as
declared.

| Field | Bytes | Value |
|---|---|---|
| `version` | 1 | `0x01` (envelope version; any other byte is `client.decrypt_failed`) |
| `keyIdLen` | 1 | `u8` length of `keyId` in UTF-8 bytes |
| `keyId` | `keyIdLen` | UTF-8 key identifier (selects the key; see below) |
| `nonce` | 12 | AES-GCM nonce (96-bit, the GCM standard) |
| `ciphertext` | rest | AES-256-GCM ciphertext **with the 16-byte tag appended** (the standard "combined" GCM output) |

- **Cipher:** AES-256-GCM. The key is 32 bytes. The GCM **additional
  authenticated data (AAD)** is the empty string (no AAD): key scoping is by
  `keyId`, and binding to table/row is an app choice via the key it selects,
  not baked into the envelope.
- **The GCM plaintext is the declared-type value serialized to canonical
  bytes** by the value serializer below — *not* a re-run of the row codec.
  This makes the envelope self-describing per `declaredType` (both cores
  agree byte-for-byte), and it means a `string`/`json`/`integer` column
  encrypts and decrypts to exactly its declared JS/Rust value.

**Value serializer (declared type ⇄ plaintext bytes), byte-exact:**

| `declaredType` | Plaintext bytes fed to GCM |
|---|---|
| `string` | UTF-8 bytes of the string |
| `json` | UTF-8 bytes of the raw JSON document string (preserved verbatim, §2.4 tag 5) |
| `blob_ref` | UTF-8 bytes of the canonical BlobRef string (§5.9.1) |
| `integer` | 8 bytes, `i64` little-endian (the ±(2^53−1) contract, §Conventions) |
| `float` | 8 bytes, `f64` IEEE-754 little-endian |
| `boolean` | 1 byte, `0x00`/`0x01` |
| `bytes` | the raw bytes verbatim |

`crdt` is absent by rule 2 above. On decrypt, the plaintext bytes are parsed
back per `declaredType` (a `json`/`blob_ref` value is re-validated exactly as
the row codec would, §2.4); a parse failure is `client.decrypt_failed`.

**Key selection — `keyId` and the `keyProvider`.** The client is configured
with a **key provider**: `keyId → 32-byte key`, plus a **`keyIdFor(table,
rowId, plaintextRow) → keyId`** hook that names the key for a given write.
Portable Worker and native/Tauri hosts additionally accept `keyIdColumns`, a
map from table name to one non-encrypted string column whose row value is the
active `keyId`. This supports per-Practice/per-Facility keys and rotation via an
explicit plaintext key-grant identifier without deriving it from an opaque row
id. The selection order is custom `keyIdFor`, configured `keyIdColumns`, then
the default **per-table** `keyId = table`. A missing, encrypted, empty, or
non-string selector column fails locally; it never falls back to another key.
On encode the client resolves `keyId`, embeds it in the envelope, and encrypts with
`keyProvider(keyId)`. On apply the client reads `keyId` **from the
envelope** and decrypts with `keyProvider(keyId)` — so key rotation and
per-scope keys work without a schema change: the envelope is
self-describing. A `keyId` the provider does not know, or a wrong key
(GCM tag mismatch), is `client.decrypt_failed`.

Worker-hosted clients accept a structured-clone-safe `{ keys, keyIdColumns }`
keyring and install the provider inside the leader worker. Tauri and React
Native clients accept the same public shape; their JavaScript bridges encode
raw keys into local IPC/FFI commands and the Rust core installs them before
encrypted rows are accessed. Keys are client-local configuration and MUST NOT
enter SSP2 requests, server logs, or application telemetry.

**Security preflight and key lifecycle.** A host that must authenticate the
device, evaluate a signed quarantine/revocation directive, or recover an
interrupted purge **MUST** be able to open the persistent replica without
exposing or transporting protected application data. Every shipped client host
therefore implements the same two-state lifecycle:

- `preflight`: local bookkeeping/schema open and migration are complete, but
  protected queries, mutations, subscriptions/windows, outbox inspection,
  sync, realtime/presence, blobs, and automatic host-loop work fail with the
  stable client-local code `client.security_preflight_required`;
- `active`: the accepted keyring is installed and the ordinary client surface
  and host loop are available.

Construction with `securityPreflight: true` MUST NOT accept an `encryption`
keyring in the same call. During preflight the host MAY inspect
`securityLifecycle`, `statusSnapshot`, and `localRevision`; it MAY execute the
bounded, application-authorized `purgeLocalData` primitive (§7.3.4); and it MAY
close/shut down the client. No other application-data operation is permitted.
In particular, runtime transport-header replacement is an active-session
operation; native bridges MUST gate it independently rather than relying only
on a JavaScript wrapper.
The host installs the accepted keyring and releases the gate only through
`activateSecurity({ encryption? })`.

`beginSecurityPreflight()` closes the gate synchronously for new calls, closes
realtime, waits for already-started serialized/network/read-sidecar work to
settle, and releases the core's keyring reference before resolving. Activation
MUST NOT overtake that barrier. Entering preflight clears pending automatic
sync/retry intents; activation emits one startup intent when persisted active
subscriptions or outbox work exist. A Worker follower requesting preflight
applies it to the one shared origin leader, not merely to its local proxy.

Native key buffers MUST be overwritten before replacement/drop where the
runtime permits deterministic memory ownership. JavaScript hosts release every
core-owned reference; the application remains responsible for zeroing/removing
its own key buffers and OS-secure-store entries. Tauri `close()` MUST dispose
the native client and keyring rather than only detaching a JavaScript listener.
React Native `close()` continues to release the FFI handle. The local SQLite
mirror remains plaintext by architecture, so platform storage encryption,
device lock policy, secure key storage, and the exact purge protocol remain
mandatory application responsibilities.

**`client.decrypt_failed` (client-local, §10.3).** Decrypt failures —
unknown envelope version, unknown `keyId`, GCM authentication failure,
malformed envelope, or a post-decrypt value-parse failure — surface as the
client-local code `client.decrypt_failed` (never on the wire; the `client.`
family is client-only per §10.3). It is not retryable: a wrong or missing
key does not fix itself. The client raises it at the apply seam
(§4.5/§5.6); the app decides whether to skip the row, halt, or surface a
re-key prompt.

**Nonce discipline.** The 12-byte nonce **MUST** be from a cryptographically
secure RNG on every production encrypt (never reused with the same key —
GCM's one hard requirement). The nonce source is **injectable** so golden
crypto vectors can pin a fixed nonce (Appendix A `crypto/*`); the fixed
nonce is a test-only injection and **MUST NOT** be reachable from a
production encode path.

**Server consequences — honest about what the server sees.**

- **sqlite-image ineligibility.** A rows segment (§5.2) decodes and applies
  **per row**, so the client decrypts each encrypted value on apply. A
  **sqlite image** (§5.3) is copied into the local mirror **wholesale**
  (`INSERT … SELECT`) with no per-row codec pass, so its ciphertext would
  land undecrypted in a plaintext-typed local column. Therefore **a table
  with any encrypted column is excluded from sqlite-image eligibility**: the
  server MUST serve it via the **rows lane** only (it never mints or offers a
  `mediaType = sqlite` segment for such a table), regardless of the client's
  accept bit 2. The server knows this from the schema IR (the table has an
  encrypted column); it is a server-side eligibility rule, not a wire
  negotiation.
- **Write-validators see ciphertext (§6.7).** A §6.7 write-validator runs
  server-side and receives the row that will persist; for an encrypted
  column that value is the **ciphertext envelope** (`bytes`), which the
  server cannot decrypt. A validator therefore MUST NOT assert on the
  plaintext of an encrypted column — it can only see that a value is present
  and well-formed as `bytes`. This is the honest cost of E2EE: business
  rules over encrypted content live on the client, before the write.
- **Scopes and CRDT are unaffected** because encrypted scope/crdt columns
  are forbidden (the hard errors above): the server extracts scopes from
  plaintext scope columns (§3.1) and merges plaintext `crdt` bytes
  (§5.10.3) exactly as before.

**Asymmetric ("async") encryption — key-sharing utilities, not wire
protocol.** Sharing a table/scope key to another member is done with
**X25519 sealed-box key wrapping**, provided as **utilities on both cores**
(key generation, wrap, unwrap) — it is **not** part of the sync wire
protocol. To wrap a 32-byte symmetric key `K` to a recipient X25519 public
key `P`:

1. generate an ephemeral X25519 keypair `(e, E)`;
2. `shared = X25519(e, P)`;
3. `wrapKey = HKDF-SHA256(ikm = shared, salt = "", info = "syncular/e2ee/x25519-wrap/v1", len = 32)`;
4. `wrapped = AES-256-GCM(key = wrapKey, nonce = 12 random bytes, plaintext = K)` (tag appended);
5. the wrap output is the envelope **`0x01 | E (32 bytes) | nonce (12) |
   wrapped (K.len + 16)`** — a self-contained blob the recipient unwraps
   with their private key by recomputing `shared = X25519(recipientPriv,
   E)` and the same HKDF.

Key **distribution** rides the app's own channel or a **synced table of
wrapped keys** (the recommended pattern): a table whose rows are
`(keyId, recipientPubId, wrappedKeyBytes)` — the `wrappedKeyBytes` column is
an ordinary `bytes` column (it is already ciphertext; it does **not** need
the §5.11 per-column encryption, and MUST NOT since it carries no plaintext
the server could see anyway). A member with the matching private key
unwraps to recover `K`, then feeds it to their `keyProvider`. The docs page
gives the full recipe.

**Conformance (§Appendix B, cross-core).** New scenarios prove both cores
agree: an encrypted round-trip (TS writes / Rust reads via a shared fixture
key and vice versa; a raw-driver assertion confirms the **server row holds a
ciphertext envelope, not plaintext**), a wrong-key apply surfacing
`client.decrypt_failed`, and committed crypto **test vectors** (fixed-nonce
AES-GCM encrypt vectors and X25519 wrap/unwrap vectors under
`spec/vectors/crypto/`) that both cores reproduce byte-for-byte.

---

## 6. Push, conflicts, results

### 6.1 `PUSH_COMMIT` frame

One frame per client commit, in client (outbox) order:

| Field | Type | Semantics |
|---|---|---|
| `clientCommitId` | `str` | Idempotency key (§2.3), non-empty, unique per client |
| `operations` | `u32` count × operation record | MUST be ≥ 1 (`sync.empty_commit`) |

Operation record:

| Field | Type | Semantics |
|---|---|---|
| `table` | `str` | |
| `rowId` | `str` | |
| `op` | `u8` | `1` = upsert, `2` = delete |
| `baseVersion` | `opt(i64)` | Optimistic-concurrency token (§6.2); absent = last-write-wins. Presence is deliberately **not** tied to `op`: a `delete` operation MAY carry a `baseVersion`, which the codec accepts and preserves and the server ignores (deletes perform no version check, §6.2) |
| `payload` | `opt(bytes)` | Full row encoded with the generated row codec (§2.4) for the request's `schemaVersion` — binary both ways per the §0 decision. MUST be present for `upsert` and absent for `delete`; a violation is a decode error (`sync.invalid_request`). Bytes that fail row-codec decode are rejected by the server as **commit-level** request validation (§1.7): the enclosing commit is `rejected` with one `error` result record (`sync.invalid_request`, §6.3) — the envelope codec carries the payload as opaque `bytes` |

Servers MUST enforce an operation-count cap per request, counted as the
**total operations across all `PUSH_COMMIT` frames in the request**
(host-configured; the reference default is 500). Exceeding it is a
request-level validation failure (§1.7) rejected before any commit is
attempted: `sync.too_many_operations` with the whole batch unapplied —
the client splits and retries.

### 6.2 Conflict detection

The crdt-column interaction of §5.10.3 layers on top — `crdt` columns
are **excluded** from the `baseVersion` comparison and merge on every
clean apply; everything below governs the row's non-crdt columns and its
`server_version`:

- `baseVersion` present, row exists: if row's `server_version ==
  baseVersion`, apply with `server_version = baseVersion + 1`; else
  **conflict** (`sync.version_conflict`).
- `baseVersion == 0`, row absent: insert with `server_version = 1`. If a
  concurrent insert wins the race, the server MUST re-authorize the
  winner's row against the actor's allowed scopes (§3.4 steps 2–3)
  **before** disclosing anything: if authorized, return **conflict**
  with the winner's version and row; if denied, reject with
  `sync.forbidden` — a conflict record must never leak a row from a
  scope the actor does not hold.
- `baseVersion` present and ≠ 0, row absent: error `sync.row_missing`.
- `baseVersion` absent (upsert): last-write-wins; `server_version`
  increments from the current value (or 1 on insert).
- `delete`: no version check. Deleting an **absent** row is `applied`
  (idempotent) with **no authorization check and no emitted change**:
  there is no stored row to select as the §3.4 authorization row, and
  an unconditional `applied` discloses nothing. Deleting an
  **existing** row authorizes against the stored row per §3.4; denial
  is `sync.forbidden` — which necessarily reveals that the row exists,
  the accepted cost of fail-loud authorization.

### 6.3 `PUSH_RESULT` frame

One per `PUSH_COMMIT`, in request order:

| Field | Type | Semantics |
|---|---|---|
| `clientCommitId` | `str` | Echo |
| `status` | `u8` | `1` = `applied`, `2` = `cached`, `3` = `rejected` |
| `commitSeq` | `opt(i64)` | Present for `applied` and `cached`; absent for `rejected` — deliberately: a rejected commit is invisible to pulls, so its sequence number would mean nothing to clients |
| `results` | `u32` count × result record | See below |

Result record — tagged union:

| Field | Type | Semantics |
|---|---|---|
| `opIndex` | `i32` | Index into the commit's operations |
| `status` | `u8` | `1` = applied (no further fields), `2` = conflict, `3` = error |
| conflict: `code` | `str` | e.g. `sync.version_conflict` |
| conflict: `message` | `str` | |
| conflict: `serverVersion` | `i64` | Current server row version |
| conflict: `serverRow` | `bytes` | Current server row encoded with the generated row codec (§2.4) for the request's `schemaVersion` — the client resolves against this without another round-trip |
| error: `code` | `str` | |
| error: `message` | `str` | |
| error: `retryable` | `bool` | |

Semantics:

- **`applied`**: every operation applied; `results` lists one `applied`
  record per operation.
- **`cached`**: idempotent replay of an **applied** commit — the
  persisted original results are returned unchanged with
  `status = cached`. A replayed **rejected** commit returns its
  persisted rejected result unchanged (`status` stays `rejected`, §2.3).
  If the server cannot read its own cached result it answers
  `sync.idempotency_cache_miss` (retryable) for that commit rather than
  re-applying. Encoding of that answer: a `PUSH_RESULT` with
  `status = rejected`, no `commitSeq`, and exactly one `error` result
  record at `opIndex = 0` carrying
  `code = "sync.idempotency_cache_miss"`, `retryable = true`. This
  result MUST NOT be persisted — it reports a serving failure, not the
  commit's outcome; a later retry may find the record readable again.
- **`rejected`**: `results` contains the record(s) of the terminating
  operation only (operations before it were rolled back; operations
  after it were never attempted).
- A `clientCommitId` duplicated **within one request** is processed once;
  subsequent occurrences return the persisted result per the replay rule
  (§2.3): `cached` if it applied, `rejected` if it rejected.
- Every apparently new push is serialized by partition before any operation
  read, authorization, conflict check, row validation, CRDT merge, or staged
  write. The server then re-checks the idempotency key while holding that
  serialization boundary. It retains the boundary through the atomic commit
  of either the applied result or a rejected/conflicted terminal result. Thus
  two overlapping deliveries that both miss the optimistic lookup still run
  exactly one operation pipeline and return the first byte-equivalent result;
  callbacks, merges, row versions, commit-log entries, and realtime
  notifications are never duplicated. Hosts SHOULD retain cross-partition
  concurrency where their storage permits it (for example, one Durable Object
  per partition or independent PostgreSQL transactions); a single SQLite
  connection necessarily queues its transactions globally.

#### 6.3.1 `PUSH_RESULT_DETAILS` additive companion frame

A server MAY emit one `PUSH_RESULT_DETAILS` immediately after a rejected
`PUSH_RESULT` when at least one terminating error carries host-approved
recovery metadata. This is a new frame rather than an extension of the
`PUSH_RESULT` record so a client that predates this section treats it as an
unknown frame, preserves or skips it under §1.2, and still processes the
legacy result unchanged. A client that understands this frame MUST continue
to accept a response which omits it.

| Field | Type | Semantics |
|---|---|---|
| `clientCommitId` | `str` | Matches the immediately preceding rejected `PUSH_RESULT` |
| `entries` | `u32` count × detail entry | Non-empty; at most one entry for each terminating error operation |

Detail entry:

| Field | Type | Semantics |
|---|---|---|
| `opIndex` | `i32` | Unique, non-negative index of an `error` record in the companion result |
| `detailsJson` | `str` | UTF-8 JSON object conforming to the bounded shape below |

The normalized `detailsJson` object has only these optional members and MUST
contain at least one of them:

| Member | Shape | Semantics |
|---|---|---|
| `fieldPaths` | 1–32 unique schema paths | Fields the app may focus or explain; each path is at most 160 characters and matches `identifier(.identifier)*` |
| `reason` | stable token | Machine reason, at most 96 characters |
| `requiredAction` | stable token | Machine recovery action, at most 96 characters |
| `references` | 1–16 string entries | Explicitly approved, non-sensitive recovery identifiers; keys are stable tokens ≤ 64 characters and trimmed values contain no control characters and are ≤ 256 UTF-8 bytes |

`reason`, `requiredAction`, and reference keys use lowercase code-like tokens:
`[a-z][a-z0-9]*([._-][a-z0-9]+)*`. The encoded normalized JSON object MUST
not exceed 4,096 bytes. Unknown members, duplicates, empty members, malformed
paths or tokens, and over-limit values are decode errors. The details frame
MUST NOT carry diagnostic prose, stack traces, arbitrary host values, row
contents, protected health information, or authorization data. A host opts
every reference into replication and is responsible for classifying it as
safe for the already-authorized client.

The server persists these details with the idempotency outcome, so a replayed
rejection emits the identical companion. The client persists accepted details
with its durable rejection journal (§7.2.1). Details are recovery hints, not
trusted display copy: an app SHOULD map known codes, paths, reasons, actions,
and references to its own localized UI and MUST ignore unknown values. The
legacy `message` remains diagnostic and MUST NOT be rendered directly to end
users.

### 6.4 Atomicity and ordering

- Commits in a request are processed **sequentially in frame order**. A
  rejected commit does not stop the batch; later commits are still
  attempted (the client's outbox decides whether later commits depended
  on the rejected one — see §7.2).
- A commit is atomic: any non-`applied` operation result rolls back every
  write of that commit (savepoint or equivalent). Partially applied
  commits MUST be impossible, including their emitted changes and
  idempotency record content.
- The idempotency record and result payload MUST be persisted in the same
  transaction as the commit's writes.
- Applied commits emit changes (§2.2) that become visible to pulls and
  realtime with their assigned `commitSeq`; a puller can never observe a
  commit's changes before its push response could have reported it
  (`commitSeq` ordering is the single consistency spine).

### 6.5 Conflict resolution contract (client)

The protocol reports conflicts; resolution is app policy. The client
contract:

- On `conflict`, the losing local operation MUST NOT be blindly retried
  with the same `baseVersion`.
- The app resolves via **keep-server** (apply `serverRow` locally, drop
  the local op), **keep-local** (re-push the local payload with
  `baseVersion = serverVersion` from the conflict record — an explicit
  overwrite), or **custom merge** (compute a merged payload, push with
  `baseVersion = serverVersion`).
- Because the commit was rolled back atomically, sibling operations of
  the conflicted one are also unapplied; the client rebases the whole
  commit (see the conformance scenario in Appendix B).

### 6.6 Blob existence check

An upsert operation whose row carries a non-NULL `blob_ref` value
(§2.4 tag 7, §5.9.1) triggers a **blob existence check** during apply
(§5.9.6): the server MUST verify the referenced `blobId` is present in the
blob store *before* the commit is applied. An absent blob rejects the
operation with `blob.not_found` (a `rejected` commit result, §6.3),
rolling the whole commit back per §6.4. The check runs alongside the
§3.4 write-path scope check, on the same authorization row; it adds one
existence lookup per referenced blob. A delete carries no payload and
references no blob, so it never triggers the check. The client's recovery
is automatic: the rejected commit stays in the outbox only if the client
chooses to re-push after uploading the blob — but because upload precedes
push (§5.9.7 B4), a well-behaved client never hits this rejection; it
exists to make the "referenced ⇒ present" invariant enforced rather than
assumed (a corrupt or out-of-order client cannot smuggle a dangling
reference into the log).

### 6.7 Write-validation hooks

Scopes (§3.4) answer "may this actor write this row's scope?" — a
coarse, structural grant. They cannot express a **business rule** on the
row's contents: "title ≤ 200 chars", "amount ≥ 0", "status is one of a
fixed set", "a closed invoice's total is immutable". §6.7 is the optional
seam for exactly those rules.

**Shape.** A host MAY configure a per-table **validator**: a callback
keyed by table name. It is a **host callback, not wire protocol** — like
`resolveScopes` (§3.2), business rules live in the host process and never
appear on the wire or in any generated artifact. A server with no
validators configured behaves exactly as one that predates this section;
the feature is off by default and adds no per-operation cost when off.

**When it runs.** For each push operation on a table that has a
validator, the server runs the validator **after** two gates have already
passed — (1) the row-codec decode (§6.1) and (2) the §3.4 scope
authorization (steps 2–5, including the scope-column strip on update) —
and **inside the commit transaction** (§6.4), immediately before the
row's write. Running after §3.4 means a validator never sees a row the
actor is not authorized to write; running inside the transaction means a
rejection rolls back atomically like any other operation failure. The
order is fixed: **decode → scope authorization → validation → write.**

**What it sees.** The validator receives, per operation:

- `op` — `upsert` or `delete`.
- `table`, `rowId`.
- `row` — the row **that will persist**, keyed by column name: for an
  `upsert`, post-scope-strip and **post-CRDT-merge** (see below);
  `undefined` for a `delete`.
- `stored` — the currently-stored row keyed by column name, or `undefined`
  when there is none (an insert). Present for an update or a delete, so a
  validator can enforce transition rules ("a `closed` invoice cannot
  reopen") and distinguish create from update.
- ambient `actorId` (§1.1) and `partition`.

**CRDT columns — the pinned choice.** For a `crdt` column (§5.10) the
validator sees the **merged** value (`merge(stored, incoming)`, §5.10.3) —
the state that will actually persist — **not** the raw pushed update. The
merged state is what the store holds and what every other client will
converge to, so it is the only honest thing to validate; validating the
raw incoming update would let a rule pass on bytes that never become the
row. A validator that needs to reason about a CRDT column's decoded
content decodes the merged bytes itself (the server hands it the bytes).

**A delete only validates an existing row.** Deleting an **absent** row is
an idempotent no-op that emits no change and performs no scope check
(§6.2); it likewise runs **no** validator — there is nothing to validate.
Deleting an **existing** row runs the validator with `stored` set and
`row` undefined, after the §3.4 delete authorization passes.

**Rejection and the host code.** A validator **accepts** by returning (or
resolving); it **rejects** by throwing (or rejecting its promise). A
rejection terminates the operation and rolls the whole commit back (§6.4),
exactly as a §6.6 `blob.not_found` or a §5.10 merge failure does — the
commit's `PUSH_RESULT` is `rejected` with the single terminating `error`
record (§6.3) carrying the **host-defined code** and message. The client
surfaces that code in its rejection record unchanged (§6.3, §7.2); it is
opaque to the client runtime, which applies the generic rejection
handling (drop the commit from the outbox; the app decides whether to
re-push a corrected write).

A deliberate host rejection MAY additionally attach the bounded
`RejectionDetails` object of §6.3.1. The server validates and normalizes it at
`ValidationRejection` construction time, persists it with the idempotent
result, and emits it only through the additive companion frame. Invalid or
over-limit details fail loudly as a host programming error; the server never
falls back to replicating arbitrary exception data. Details do not broaden
authorization and MUST contain only identifiers the host has explicitly
classified as safe for the actor that already passed the row write gate.

**Host codes MUST be distinguishable from protocol codes.** A host
validation code **MUST NOT** begin with any reserved protocol-family
prefix: **`sync.`**, **`blob.`**, **`presence.`**, or **`client.`**. These
namespace the protocol's own error families (§10.2 and the client-local
codes of §10.3); reserving them guarantees a code appearing in a rejection
record is unambiguously either a protocol code or a host code, never a
collision. A host that throws a reserved-prefixed code is a **server
bug**: the server rejects it loudly at the point the code is constructed,
not silently at push time. A validator that throws something **other than
a chosen host code** (an unexpected error, not a deliberate rejection)
rejects the commit with `sync.constraint_violation` (§10.2) — the write
did not happen, and the generic constraint code says so without leaking
the thrown message as a machine code.

**Events.** A validation rejection is an ordinary push rejection: it emits
the existing `push.rejected` operational event (the §6.3 rejection seam)
carrying the host code and `opIndex`. No validation-specific event exists —
the rejection already flows through the one seam.

**Non-goals.** A validator MUST NOT mutate the row (the server writes the
row it validated; a mutation would desync the persisted bytes from the
validated ones and from the client's optimistic copy). Cross-row or
cross-table invariants use the distinct whole-commit seam in §6.8 — §6.7
remains one operation's row, not a transaction-wide assertion engine. This is
the deliberate small surface:
the reserved IR `extensions` slot (the typegen document/table passthrough)
is where a future rung MAY carry declarative validation metadata to
generate a validator skeleton, but §6.7 ships the runtime hook only — no
codegen wiring this rung.

### 6.8 Whole-commit validation hooks

Some server-authoritative invariants are aggregates rather than row rules: a
Surgery lifecycle transition and its immutable status-event append must land
together; deleting a parent may require deleting or reassigning its children;
a set of allocations may have a bounded total. A per-table §6.7 callback
cannot prove these safely because it sees only one operation. A host MAY
therefore configure one transaction-scoped **whole-commit validator**.

**Host seam, off by default.** `commitValidator` is a host callback, not a wire
feature and not generated schema metadata. With no callback configured the
server performs no candidate scan or callback; the ordinary §6.3 partition
serialization still applies to every push. The callback MUST NOT mutate storage
or its inputs; it accepts by returning (or resolving) and rejects by throwing a
deliberate validation rejection.

**Fixed order.** The server uses the ordinary §6.3 optimistic lookup,
per-partition push serialization, and locked idempotency re-check before
reading or staging any operation. If the locked lookup finds a result, the
callback does not run. Each new operation then proceeds through the ordinary
§6.1–§6.7 path,
including conflicts, authorization, CRDT merge, and per-row validation. If an
operation terminates, the whole-commit callback does not run. Otherwise every
operation is staged in the same storage transaction, and the callback runs
exactly once, after the final staged operation but before `appendCommit`, the
idempotency result, or transaction commit:

`optimistic idempotency → partition serialization → locked idempotency →
decode/auth/row validation/write × N → whole-commit validation → append
log/idempotency → commit`

Consequently the callback observes the final candidate state, including all
sibling operations regardless of their order in the pushed commit, and a
rejection rolls all staged writes back under §6.4. The storage MUST discard the
candidate writes and persist the rejected idempotency outcome **while retaining
the same serialization lock**, then finish the transaction. There is no unlock
gap between candidate rollback and rejection persistence. Replaying a commit
whose result was persisted returns the cached result and MUST NOT rerun the
callback, including when duplicate deliveries overlap in time.

**Operation evidence.** The callback receives `clientId`, `clientCommitId`,
ambient `actorId` and `partition`, plus an ordered `operations` array. Every
entry carries its original `opIndex`, `op`, `table`, `rowId`, the final `row`
(`undefined` for delete), the pre-operation `stored` row when present, and
`storedServerVersion` / `nextServerVersion` when defined. Rows use decoded
column-name keys and upserts contain the same post-scope-strip,
post-CRDT-merge value §6.7 validates. An idempotent delete of an absent row is
still operation evidence, with no stored/final row and no next version, even
though it stages no change.

**Candidate-state reader.** The callback receives a read-only transaction
reader:

- `getRow(table, rowId)` returns the final candidate row and server version,
  including a sibling's staged upsert or delete.
- `scanRows({ table, scopeFilter, afterRowId?, limit? })` returns final
  candidate rows in ascending `rowId` order. `scopeFilter` is required;
  `afterRowId` is an exclusive keyset cursor; `limit` defaults to 100 and MUST
  be an integer from 1 through 1,000. At the storage boundary an empty or
  omitted scope map MUST fail with the privacy-safe host error
  `sync.storage.scan_requires_scope`; it MUST NOT return an
  indistinguishable empty result.

The reader is a server-host capability inside the already authenticated
partition, not client-derived authorization. A host MUST request only the
tables and scope values its invariant requires. Unknown tables, invalid bounds,
or a storage without candidate scans fail loudly; Syncular never substitutes a
stale out-of-transaction read.

**Serialization is mandatory.** Every push requires the §6.3 boundary, and
candidate-state validation additionally depends on it so two commits cannot
both validate against states that exclude one another. A storage MUST
serialize the partition from the pre-operation lock through commit/rollback:

- SQLite's write transaction already provides the serialization point.
- PostgreSQL locks the partition registry row (`FOR UPDATE`) before any row
  read or write.
- D1 has no interactive transaction lock. Every sync round that can push MUST
  pass through one explicit per-partition Durable Object request queue (or an
  equivalent coordinator). `D1ServerStorage` therefore requires an explicit
  `pushApplySerialized: true` assertion from that coordinator; its default
  fails closed before every push, whether or not §6.8 is configured.
- A custom storage MUST implement the equivalent transaction lock,
  locked idempotency re-check support, and atomic rejected-result finalization
  contract. Whole-commit validation additionally requires candidate-state
  scans. Missing support fails before app-row mutation; it MUST NOT silently
  weaken the invariant.

This is deliberately partition-wide rather than row-lock inference: the host
callback may read arbitrary aggregate members, so Syncular cannot know a
smaller safe lock set in advance. Applications SHOULD keep partitions bounded
and callbacks/queries indexed and short.

**Rejection attribution.** Throw
`CommitValidationRejection(opIndex, code, message?, details?)` to attribute the
aggregate failure to a chosen operation. `opIndex` MUST name an operation in
the commit. The code namespace, bounded `RejectionDetails`, event behavior,
privacy rules, client persistence, and atomic rollback are exactly §6.7 and
§6.3.1. Throwing a plain `ValidationRejection` attributes the failure to the
first operation. Any other throw becomes `sync.constraint_violation`; an
invalid operation index is also a host bug reported with that generic code.

**Server-authoritative commands remain distinct.** §6.8 validates a commit a
client is already authorized to propose. It does not grant authority, connect
partitions/facilities, allocate globally unique resources, run privileged
workflows, or replace commands whose server must choose or transform the
write. Those remain explicit server-authoritative functions.

Such a command MAY use the server storage's trusted relational-index lookup to
find rows by an exact alternate key without declaring another client scope.
`scanRowsByIndex` names one declared index, supplies exactly one value for each
index column, uses exclusive `rowId` keyset pagination, and limits every page to
an integer from 1 through 1,000. The table MUST be materialized. Transactional
lookups MUST observe the transaction's candidate writes and deletes. Unknown
indexes, non-materialized tables, value-count mismatches, and invalid bounds
MUST fail with stable privacy-safe host errors.

The values form the complete, order-sensitive index tuple. A caller MUST NOT
omit trailing values to request a leading-prefix lookup: a declaration over
`(workspace_id, state, id)` accepts exactly three values, and one value MUST
fail with `sync.storage.index_value_count_mismatch`. A host that needs an exact
Workspace-only lookup MUST declare a separate `(workspace_id)` index. This
capability does not define prefix or range scans.

The capability belongs to the trusted server storage object and is not an SSP2
operation. It MUST NOT create a declared scope variable, participate in
requested/allowed/effective scope evaluation, alter generated named-query
coverage, or be selectable by a client. A host MUST NOT expose arbitrary
table/index/value selection to an untrusted caller. Exact server lookups,
client-visible scope indexes, correlated multi-variable scopes, and explicit
materialized reverse-index/work-queue rows remain distinct mechanisms.

---

## 7. Offline writes and replay

### 7.1 The outbox

- Local writes are recorded as commits in a durable **outbox** with
  client-generated `clientCommitId`s (unique forever per client; UUIDs
  recommended). The outbox is schema-agnostic (§0): it survives a schema
  bump and replays on top of the fresh re-bootstrap (§7.4).
- The outbox is FIFO: commits are pushed strictly in creation order, and
  a client MUST NOT reorder or coalesce commits once a push containing
  them may have reached the server (the idempotency key pins their
  content).
- Local reads see outbox state applied optimistically. Reconciliation
  is **outbox replay on top**: whenever server data has been applied (a
  pull response or a realtime delta, §8.2 — including one that aborted
  mid-way, §1.4 rule 5), the client re-applies every still-pending
  outbox commit over the fresh server state. Server rows thus replace
  optimistic state exactly when the commit that produced it has drained
  (`applied`/`cached`) or been dropped; pending writes stay visible
  throughout.

### 7.2 Replay and idempotent retry

- After reconnect, the client replays the outbox from the oldest
  unacknowledged commit. Lost acks are safe: replaying an already-applied
  commit returns `cached` with the original results (§6.3) and the client
  proceeds as if the ack had arrived.
- On `rejected`, the client MUST stop optimistic display of that commit,
  surface the terminating result, and decide (app policy) whether later
  outbox commits are still valid — commits that depended on rejected
  state SHOULD be rebased or dropped before continuing replay.
  Mechanically, "stop optimistic display" is: the commit leaves the
  outbox (exception: the `sync.idempotency_cache_miss` result of §6.3
  is a serving failure, not an outcome — the commit stays queued and
  retries). The visible state MUST then be rebuilt from the last
  server-delivered base plus every later still-pending commit, in FIFO order,
  so the rejected commit's effect disappears immediately while independent
  later offline work remains visible. Consequently a rejected optimistic
  insert disappears, a rejected update restores the last confirmed row, and a
  rejected delete restores the last confirmed row. For a conflict, the
  record's `serverRow` (§6.3) remains the authoritative resolution input.

  A client that materializes optimistic values directly into its visible
  tables MUST durably retain enough protected base state to perform that
  rebuild after a process restart. Per-commit before-images are sufficient:
  capture them atomically with the outbox append, remove them atomically with
  the outbox drain, restore the failed commit's images, rebase the images of
  later commits that touch the same rows, and replay those later operations.
  These images are client-internal protected data. They MUST NOT enter
  `PUSH_COMMIT`, durable public outcome envelopes, ordinary application
  preferences, telemetry, or generic diagnostics.
- Push and pull SHOULD ride the same combined request (§1.5): a replaying
  client gets its own changes back in the pull half, converging in one
  round-trip.

#### 7.2.1 Durable final-outcome journal

A client which exposes conflict or rejection recovery MUST persist every
final commit result in protected local bookkeeping. The journal write and the
removal of that commit from the durable outbox occur in the **same local SQLite
transaction**. A process crash therefore cannot leave an absent outbox item
without durable evidence explaining whether it was `applied`, `cached`,
`conflict`, or `rejected`. The retryable `sync.idempotency_cache_miss` serving
failure is not final and creates no journal entry.

Each journal entry contains the `clientCommitId`, local recording time,
newest-first local sequence, final status, and every operation result. A
conflict retains its stable code and message, `serverVersion`, decoded
`serverRow`, and the losing schema-agnostic local operation. An error retains
its stable code, message, retryability, accepted §6.3.1 details when present,
and local operation. For a final `conflict` or `rejected` result, the entry also
retains the complete ordered schema-agnostic local operation envelope from the
failed commit. The envelope is required because the server reports only the
terminating operation while every sibling rolled back; without it an
application cannot safely reconstruct atomic aggregate intent after the
outbox drains or the process restarts. Historical entries and successful
outcomes MAY omit the envelope. The same rule applies to client-local terminal
drops such as `sync.outbox_incompatible` and an outbox commit proven to be
inside a revoked effective scope.

The complete failed envelope is protected local payload. It MUST NOT be added
to protocol frames, copied into ordinary application preferences or telemetry,
or exposed in generic diagnostics. It follows the same active-failure-safe
retention and explicit resolution lifecycle as the rest of the outcome entry.
An application may inspect it only inside an authorized, domain-specific
recovery surface; presence of the envelope does not make full-row edit intent
known or authorize an automatic merge.

The operation journal also preserves **local edit intent** for an upsert made
through the client's partial-update API: `changedFields` is the normalized,
sorted set of non-primary-key fields supplied to `patch`. It survives restart
and appears on conflict and rejection records so recovery UI can distinguish
the fields the user meant to change from the rest of the full row payload.
This metadata is deliberately local-only: it is stored beside the
schema-agnostic outbox operation and MUST NOT be encoded into `PUSH_COMMIT` or
trusted by the server. A full-row `mutate` has unknown intent and therefore
omits `changedFields`; clients MUST NOT infer it by diffing against a mutable
local base.

The client exposes `commitOutcome(clientCommitId)` and
`commitOutcomes({ limit?, activeOnly? })`. Active conflict/rejection entries
are restored into the conflict surfaces on restart. Resolution is explicit,
durable, and one-way:

- a conflict becomes `resolved_keep_server` or `superseded`;
- a rejection becomes `superseded`;
- an applied/cached history entry may become `dismissed`;
- `superseded` requires a distinct `replacementClientCommitId`.

Resolved evidence is retained until ordinary journal retention removes it.
Retention prunes old applied/cached or resolved entries first and MUST NEVER
silently delete an active conflict or rejection; active failures may therefore
temporarily exceed the configured cap. The default cap is 1,000 entries and
clients expose it as `outcomeRetentionMaxEntries`.

### 7.3 Auth leases

An **auth lease** is a server-issued, time-bounded grant recording the
actor's resolved scopes at issuance. Its purpose is twofold: (a) the
server MAY authorize a round's push and pull against the lease **during a
host-authorization outage**, when the host opts in and its
`resolveScopes` is unreachable; and (b) the client knows how long its
offline work remains trustworthy — the lease's remaining validity is a
UX surface (`leaseState`, below).

This section specifies the lease **lifecycle** — issuance, refresh,
expiry, revocation — as the parity rung. Three things are explicit
non-goals here, noted so the skeleton stays a skeleton:

- **Client-side cryptographic verification.** A lease is *server*-issued
  and *server*-verified. Clients treat the lease as **opaque state**:
  they persist it, surface its expiry, and echo its `leaseId` back, but
  they never parse, validate, or trust its contents. (There are no
  client-verified signed tokens — the server holds the lease store and
  is the only authority.)
- **Cross-device lease transfer.** A lease is bound to
  `(partition, clientId, actorId)`; it is not portable to another device
  or client.
- **Fine-grained per-scope TTLs and per-operation grants.** The lease
  carries the actor's whole resolved allowed-scope map and one TTL — no
  per-subscription operation grants, no per-scope coverage checks. A
  future rung MAY narrow this; the skeleton does not.

The lease is **not a fallback path** in the §0 no-fallback sense. When
the host opts a request into lease authorization, the lease **is** the
authorization for its validity window — there is no second wire path, no
retry-with-different-credentials, no client-visible mode switch. The
opt-in is a host/server decision made behind the `resolveScopes` seam
(§7.3.3), invisible on the wire.

#### 7.3.1 The lease record

A lease is the tuple:

| Field | Type | Semantics |
|---|---|---|
| `leaseId` | `str` | Server-chosen unique id, non-empty. The revocation handle (§7.3.4) and the client's echo key |
| `actorId` | `str` | The actor the lease authorizes |
| `allowedScopes` | `map` of `str` → `list(str)` | The actor's resolved allowed scopes at issuance (§3.2 step 3 shape; `'*'` means "any value"). This is what the server authorizes against during an outage |
| `issuedAtMs` | `i64` | Server clock at issuance (epoch ms) |
| `expiresAtMs` | `i64` | `issuedAtMs + ttlMs`; the lease is invalid at or after this instant |

The record is **host-signed** at rest (an implementation concern of the
lease store — the server verifies its own signature on read); the
signature never appears on the wire, and clients never see it. A lease is
**valid** at time `now` iff `now < expiresAtMs` and the lease has not been
revoked (§7.3.4).

#### 7.3.2 Wire carriage — the `LEASE` frame

A lease is delivered to the client in a new response frame, `LEASE`
(`frameType 0x19`), carried in the pull/round response after
`RESP_HEADER` and before the first `PUSH_RESULT`/subscription section.
Per §9 (new data = new frame type, never a field appended to an existing
frame), the lease is **not** an added `RESP_HEADER` field; it is its own
frame, so a feature-off client skips it by length (§1.2 rule 2) with zero
awareness.

**`LEASE` payload:**

| Field | Type | Semantics |
|---|---|---|
| `leaseId` | `str` | §7.3.1, non-empty |
| `expiresAtMs` | `i64` | §7.3.1 — the client's expiry-warning input |

Only `leaseId` and `expiresAtMs` cross the wire: the client needs the id
to echo (so the server can match its stored record) and the expiry to
surface. `allowedScopes`, `issuedAtMs`, and the signature stay
server-side (the client is not an authority — §7.3, non-goal 1). At most
one `LEASE` frame per response; a second is a decode error.

There is **no request-side lease frame in wire version 1.** The client
does not present the lease on the wire; the server holds the lease store
and consults it by `(partition, clientId)` when the host opts a request
into lease authorization (§7.3.3). Reserved for a future rung that needs
the client to *assert* a specific `leaseId` on the request: frame type
`0x1A` (registered, no layout in wire version 1 — skippable per §1.2).

#### 7.3.3 Issuance, refresh, and the enforcement seam

Leases are a server feature behind a config: `leases` **absent ⇒ the
feature is off** and no `LEASE` frame is ever emitted (zero-config
discipline, the blob/segment-store pattern). When configured with a TTL:

- **Issuance and refresh (sliding).** On a successful round whose
  `resolveScopes` resolved (§3.2 step 3, `ok`), the server issues (or
  refreshes) the actor's lease: it stores a record (§7.3.1) with
  `allowedScopes` = the just-resolved allowed map, `issuedAtMs` = now,
  `expiresAtMs` = now + `ttlMs`, keyed by `(partition, clientId)`, and
  emits a `LEASE` frame. Refresh is sliding: every authorized round
  extends the window and re-captures the current allowed scopes, so a
  client that keeps syncing keeps a fresh lease. A round that does not
  resolve scopes (schema floor §1.6, or a failed resolver §3.2 rule 5)
  issues **no** lease and emits no frame. Issuance reuses the stable
  `leaseId` for the `(partition, clientId)` pair across refreshes — a
  refresh slides the same lease, it does not mint a new handle — so the
  revocation handle (§7.3.4) stays stable.

- **The enforcement seam.** `resolveScopes` stays the source of truth
  whenever it is reachable — leases never override a live resolver. The
  host opts a request into lease authorization by signalling, through the
  resolver seam, that the live authority is **unavailable** (an outage)
  rather than throwing: a thrown resolver still fails loud and revokes
  (§3.2 rule 5, unchanged). On that signal the server loads the stored
  lease for `(partition, clientId)` and, if the lease is **valid**
  (§7.3.1) and its `actorId` matches, uses its `allowedScopes` as the
  request's resolved allowed map — the request's pull filtering (§3.2)
  and write authorization (§3.4) then run **exactly as if the resolver
  had returned those scopes.** The lease is thus not a bypass: §3.4's
  stored-row authorization, scope-column immutability, and fail-loud
  denials all still apply against the leased allowed map. During
  lease-authorized service the server does **not** refresh the lease (it
  cannot re-resolve — that is the whole point of the outage); the window
  ticks down toward `expiresAtMs`.

- **No valid lease during an outage.** If the host signals the outage
  but there is no stored lease, or the stored lease is expired, or its
  `actorId` does not match, the request fails **request-level** with
  `sync.auth_lease_required` (§10.2) — the "you need a lease and don't
  have a live one" surface. A revoked lease fails with
  `sync.auth_lease_revoked` (§7.3.4).

#### 7.3.4 Revocation

The host revokes a lease by `leaseId` through a server API
(`revokeLease(partition, leaseId)` on the lease store). Revocation marks
the stored record revoked; it is durable and survives refresh attempts
(a refresh for a revoked `(partition, clientId)` mints a fresh id only
after the host clears the revocation — a revoked handle never silently
resurrects).

Revocation is about **continued sync, not local data.** A revoked lease
means: the next round that would be *lease-authorized* fails
request-level with `sync.auth_lease_revoked` (§10.2, category
`auth-required`, action `refreshAuth`). It does **not** by itself purge
the client's local rows — that is the scope-revocation contract (§3.3),
which fires per subscription via `SUB_START.status = revoked` when the
live resolver narrows. The two are distinct: `sync.scope_revoked` is
"this scope is no longer yours, purge it" (§3.3); `sync.auth_lease_revoked`
is "your offline grant was pulled, you cannot sync on it anymore — get a
live authorization." A client that hits `sync.auth_lease_revoked` stops
syncing on the lease and surfaces the state (below); when the live
resolver is reachable again, a normal authorized round re-issues a fresh
lease and the client resumes — its local data was never touched. If the
live resolver has *also* narrowed the actor's scopes, the ordinary §3.3
purge runs on that recovered round, as always.

#### 7.3.5 Client `leaseState`

A client persists the current lease (`leaseId`, `expiresAtMs`) from the
last `LEASE` frame and exposes it as `leaseState` — the mirror of
`schemaFloor` (§1.6):

- `leaseState.leaseId` / `leaseState.expiresAtMs`: the held lease, if any.
- `leaseState.remainingMs(now)`: `expiresAtMs − now`, the expiry-warning
  surface — an app shows "offline session expires in N minutes."
- The lease error codes are **stop-and-surface, not silent retry.** On
  `sync.auth_lease_required` or `sync.auth_lease_revoked` (request-level,
  so the whole round fails), the client records the code in `leaseState`
  and stops syncing on the lease; it does **not** auto-retry the same
  round into a guaranteed failure (the schema-floor discipline). The app
  drives recovery (reconnect to a live resolver). The client never purges
  local data on these codes (§7.3.4).

A client with no `LEASE` frame ever received has an empty `leaseState` —
the feature is invisible until a lease-issuing server sends one.

### 7.4 Schema-bump flow — wipe, re-bootstrap, replay

**No client-side migration engine** (Direction decision 3, 2026-07-03).
A client never transforms its local tables from schema `N` to schema
`N+1`. When the schema version changes, it **wipes its local tables,
re-bootstraps from the server at the new version, and replays the
outbox on top** (§7.1). Bootstrap-from-segment (§5, the image lane
especially, §5.3) makes a fresh bootstrap cheap enough that carrying a
migration subsystem — a rarely-exercised second apply path — is not
worth its cost, and every upgrade drills the bootstrap path instead.
The server keeps N-version codec support for transition windows if it
chooses (§9); the reference server serves exactly one version and
answers the floor (§1.6) for any other, which is sufficient for both
triggers below.

#### 7.4.1 The persisted schema-version marker

A client persists its **local schema version** — the `schemaVersion` of
the generated artifacts that last wrote the local tables — in durable
client state (the `_syncular_meta` bookkeeping row, alongside `clientId`
and `leaseState`). It is written once when the local tables are first
created and rewritten only at the end of a successful reset (§7.4.3).
A client that has never persisted a marker is treated as already at its
generated version (fresh install — the tables it just created match the
running code; nothing to reset).

#### 7.4.2 The two triggers, one flow

The reset flow (§7.4.3) fires on either of two triggers; both mean "the
local tables no longer match the schema this client can codec," and both
converge on the identical wipe-re-bootstrap-replay:

1. **Local generated-version change (on boot).** At `start()`, after
   ensuring the local tables exist, the client compares its generated
   schema version to the persisted marker (§7.4.1). If they differ (in
   either direction — an upgrade `N → N+1` or a downgrade rollback
   `N+1 → N`), it runs the reset **before its first sync round**. This
   is the ordinary upgrade path: the app ships new code plus a new
   generated schema `vN+1`; the client boots on top of `vN` local
   tables, detects the change locally with no server involvement, and
   resets. The next sync bootstraps at `vN+1` against a server that
   already serves `vN+1`.

2. **Server schema floor (`requiredSchemaVersion`, §1.6).** A running
   client whose generated schema does not match the server receives the
   schema-floor response and enters the `schemaFloor` stop state (§1.6) —
   it processes nothing and surfaces the upgrade requirement. A
   live-round floor **always stops**; it never resets on its own.
   Resetting while still generating `vN` payloads would only bootstrap
   into another floor (and if the client is *ahead* of a lagging server,
   no local reset changes the version it sends). The reset for this
   direction is deferred until the app updates — which recreates the
   client with the matching generated schema, at which point trigger 1
   fires on the next boot: the persisted marker still reads the old
   version, the generated schema reads the new one, and the boot check
   runs the reset. The floor and the boot trigger thus converge through
   the app update, not through a floor-driven reset.

   Native clients MAY persist the stop so it survives process death. On a
   later open, when the running generated version already satisfies the
   persisted `requiredSchemaVersion`, the client MUST discard that stale stop
   and schedule its ordinary startup pull without resetting local data. This
   covers an app that was ahead of a temporarily lagging server: once the
   server deployment catches up, reopening re-negotiates and resumes. If the
   server remains incompatible it simply returns the floor again. A persisted
   floor whose required version is still newer than the running generated
   version remains stopped.

Both triggers are local decisions keyed on versions the client already
holds; neither adds a wire field. `requiredSchemaVersion` /
`latestSchemaVersion` (§1.6) are unchanged.

#### 7.4.3 The reset — scope and order

The reset is a **whole-database local reset except three things**:
the **outbox**, the **client identity** (`clientId`), and the **auth
lease** (`leaseState`). Everything else is destroyed and rebuilt:

- **Dropped and recreated:** every synced table, and all
  subscription-derived state — cursors, bootstrap resume tokens
  (`bootstrapState`), the persisted effective-scope map (§3.3), and the
  `active`/`revoked`/`failed` status. The subscription *registrations*
  themselves (id, table, requested scopes, params) are **kept** — they
  are the app's declared intent, not synced data — but each is reset to
  `cursor = -1`, no resume token, `status = active`, so the next round
  is a fresh bootstrap of exactly the subscriptions the app still wants.
  Blob-cache refcount state (§5.9.7), if present, is rebuilt from the
  re-bootstrapped rows.
- **Preserved:** the outbox (schema-agnostic by construction, §0 /
  §7.1 — pending commits survive verbatim and replay on top, §7.4.4);
  `clientId` (§1.5 — the device identity is not schema state, and
  changing it would strand the server's idempotency cache); and
  `leaseState` (§7.3.5 — the grant's validity window is independent of
  the schema, distinct from §3.3 revocation which *does* purge).

Whole-database-except-those-three is chosen over a per-table reset for
correctness and simplicity: a schema bump MAY change table membership,
foreign-key shape, or scope-column mapping table-wide, and a partial
reset would have to reason about which tables a version delta touches —
exactly the migration-engine reasoning Direction decision 3 rejects.
The blunt reset is always correct and the bootstrap that follows is the
same path every fresh client runs.

**Order (all in one durable step where the storage allows):**

1. Detect (the boot-time marker check, §7.4.2 trigger 1). Clear any
   `schemaFloor` stop state carried over — the client now ships a schema
   the server serves.
2. Drop every synced local table and recreate it from the *new*
   generated schema; clear each subscription's cursor / resume token /
   effective-scope / status to the fresh-bootstrap defaults, keeping the
   registration.
3. Rewrite the persisted marker (§7.4.1) to the new generated version.
4. Surface the `upgrading` state (§7.4.5) across steps 1–3; clear it
   when the first post-reset bootstrap round completes.

The outbox is never touched by the reset. If the process dies mid-reset,
the marker still reads the old version, so the next boot re-runs the
reset — it is idempotent by the marker.

#### 7.4.4 Outbox replay after the bump — encode at send time

The reset preserves the outbox; the client replays it on top of the
fresh bootstrap exactly as §7.1/§7.2 already specify. The §0 rule pays
off here: outbox commits are persisted in schema-agnostic local form and
**encoded with the new generated codec at send time**, so a commit
recorded under `vN` pushes under `vN+1` by re-encoding — the server
never accepts a retired encoding.

Re-encoding under the new schema can *fail* when a pending commit
references a column the new schema no longer has (or newly requires and
the commit lacks): the value has nowhere to go, and there is no
migration to fill or drop it. This is not silent. The client MUST
surface it as a **rejection-like local outcome** — the same surface as a
server `rejected` (§7.2): the un-encodable commit leaves the outbox, its
purely-optimistic rows are undone (§7.2), and a rejection record is
raised carrying a client-local code `sync.outbox_incompatible`
(schema-mismatch class; the commit cannot be expressed under the new
schema and retrying it unmodified never succeeds). Later outbox commits
that *do* encode continue to replay — one incompatible commit does not
wedge the queue, matching the §7.2 rule that dependents are app policy.
`sync.outbox_incompatible` is a **client-local** code (§10.3 — never a
wire code; it is produced entirely client-side at encode time, like
`transport.failed`), surfaced through the same rejection channel the app
already watches.

#### 7.4.5 What the app sees — the `upgrading` state

The reset is observable so an app can show an "upgrading…" affordance
and know when it is safe to render:

- `upgrading` — true from the moment the reset begins (§7.4.3 step 1)
  until the first post-reset bootstrap round completes (every
  subscription past its fresh bootstrap, or the round reaching idle,
  §4.5). It is the schema-bump mirror of `schemaFloor` / `leaseState`:
  a small, queryable client state, not a wire concept.
- A completion signal fires when `upgrading` clears — the app's cue to
  re-run its live queries against the rebuilt tables. In the worker
  transport (Direction decision 2) it rides the existing event channel
  as an `upgrading` event `{ upgrading: boolean }`, so the UI thread
  learns of the reset and its completion without polling.
- While `upgrading` is true, local reads see the (possibly empty,
  mid-bootstrap) rebuilt tables plus the optimistic outbox overlay
  (§7.1) — pending offline writes stay visible across the bump, since
  the outbox was preserved.

The `upgrading` state is purely client-local; nothing about it crosses
the wire. A server sees a post-reset client as an ordinary fresh
bootstrapper at the new `schemaVersion`.

### 7.5 Local observation revisions and atomic reactive reads

This section specifies the client-local observation contract. It adds no
SSP2 frame and no server behavior. A conforming client which exposes reactive
local reads MUST implement this contract identically on every host binding.

**Revision.** Each client database persists an unsigned 64-bit `localRevision`
in durable bookkeeping state. It starts at zero and increases exactly once in
the same SQLite transaction as each committed observer-visible change. Such a
change includes materialized or optimistic rows, subscription/window
registration or completeness, deferred eviction, outbox/status state exposed
by the client, conflicts/rejections/outcome-resolution state, auth-lease or schema-floor state, and
schema-reset/upgrading state. A transaction which rolls back consumes no
revision and emits no change. The revision survives restart and schema reset;
it is destroyed only with the client database. JavaScript APIs expose it as
`bigint`; JSON bindings encode it as a decimal string so no `u64` passes through
an unsafe JSON number.

**Atomic query snapshot.** A reactive local read returns its SQL rows, required
window coverage, and `localRevision` from one SQLite read transaction. Coverage
names each required window base/unit and classifies it complete, pending, or
missing by the §4.8 registry and subscription state. A client MUST NOT compose
rows from one read with coverage or revision from another. A result at revision
`r` cannot be published as current after a matching change at revision `> r`;
promise completion order, IPC order, frame scheduling, and render timing never
override revision order.

**Change batch.** After an observer transaction commits, the core emits exactly
one batch carrying its revision and the domains changed by that transaction:

- table changes associate every optional `prefix:value` scope key with its
  table; an omitted scope-key set means honestly table-wide;
- window changes identify canonical base, table, and changed unit(s);
- status carries the complete post-commit client status when status changed;
- conflict/rejection flags identify their collection domains;
- `outcomesChanged` identifies durable journal insertion, resolution, or
  retention changes.

An empty scope-key set never means global. Scope-changing row updates record
the union of the row's before and after scope keys; deletes record before keys
and inserts record after keys. Bulk formats without row scope facts remain
table-wide. A window completeness change may occur without a table change.
Host bindings forward batches produced by the core; they MUST NOT reconstruct
them from command names, outbox/conflict counts, polling, or another proxy.

**Command sync intent.** A local command that creates network work reports one
of `none`, `interactive`, or `background(delayMs)` to its owning host loop.
Local mutations and window widening are interactive. Retry deadlines are
background. An automatic host consumes interactive intent through an
event-driven, coalescing wake and consumes background intent through one real
deadline; it does not poll a fixed interval. Realtime reconnect/catch-up jitter
required by §8.4 remains a background deadline. User-initiated local writes and
window changes are not delayed by that jitter. Manual-sync hosts may expose but
not consume the intent.

**Persistent-open sync intent.** Opening a client on durable state with at
least one active subscription or pending outbox commit MUST expose
`syncNeeded = true` and one coalescible interactive intent. This guarantees a
catch-up pull after process restart; realtime covers only changes after its
connection, and an idempotent re-declaration of the same subscription/window
does not manufacture command work. Automatic hosts consume the startup intent
through the same owner loop as command effects. Manual-sync hosts preserve it
for observability until the application runs sync.

### 7.6 Privacy-safe client diagnostics

This section specifies a client-local support contract. It adds no SSP2 frame,
server authority, telemetry upload, or permission to inspect application rows.
Every direct, Worker leader/follower, Tauri, and React Native host MUST expose
`diagnosticsSnapshot(request?)` with `version: 1` and an `onDiagnostics`
change signal. React integrations SHOULD expose the same evidence through a
hook. A host wrapper changes only topology facts (`kind`, `role`, connectivity,
realtime); the underlying evidence remains equivalent.

The snapshot is one bounded observation containing:

- capture time; host kind/role/connectivity/realtime; security lifecycle;
- generated schema version, migration state, and any required/latest floor;
- decimal local revision, sync-needed state, and pending outbox commit count;
- lease health (`none`, `active`, `expired`, or `stopped`), expiry, and a
  stable error code, never the lease id;
- every registered subscription's application id, generated table, cursor,
  completeness, state (`bootstrapping`, `complete`, `reset`, `revoked`, or
  `failed`), and optional stable reason code;
- the last sync round as bounded counters or a stable failure code, and the
  last revisioned change as generated table/window names plus changed-domain
  booleans; and
- aggregate SQLite/outbox/outcome/blob-cache byte estimates and storage state
  (`healthy`, `pressure`, or `unreadable`). Failure to open storage remains the
  stable startup error `client.storage_unavailable`; no snapshot can be read
  from a replica which did not open.

`request.expectedSubscriptions` MAY name at most 256 application-owned,
PHI-free `{id, table}` pairs. A missing registration is returned as
`unregistered`, which is distinct from a registered bootstrap that completed
with zero rows. An id registered against a different table is `failed` with
`client.subscription_intent_mismatch`. The request cannot carry scopes or
scope values. The result prioritizes expected ids, returns at most 256
subscriptions, and sets `subscriptionsTruncated` when other registrations were
omitted. Last-change table and window domains are independently capped at 256
and set `domainsTruncated` when clipped.

Diagnostics MUST NOT contain requested/effective scope values, row ids, row
values, clinical/domain row counts, SQL, database paths or filenames, client
ids, actor ids, lease ids, auth headers/tokens, encryption keys, mutation or
rollback bodies, stack traces, arbitrary server/transport prose, or
application-defined metadata. Error/reason fields are bounded code-like
values; an invalid value becomes `client.unknown_failure`. Subscription ids
are returned by design, so applications MUST keep them stable, code-like, and
free of patient/user data.

The core emits diagnostics only after the state it describes is committed.
Native hosts fingerprint snapshots without `capturedAtMs` and emit only when
evidence changes; read-only calls do not create noise. Worker and native
bridges forward core evidence and MUST NOT reconstruct it from command names.
An expected-subscription-aware observer treats the event as invalidation and
requests a fresh snapshot with its intent list. Diagnostics remains a
protected operation during security preflight because table/subscription
evidence belongs to the quarantined replica.

---

## 8. Realtime

### 8.1 Channel and handshake

WebSocket at `GET <mount>/realtime?clientId=<id>`. Host authentication
runs at upgrade; the server resolves the actor's effective scopes for the
client's known subscriptions and registers the connection against the
matching scope keys.

**Where "known subscriptions" come from:** the subscription list (ids,
tables, requested scopes) of the client's most recent pull. Servers
MUST persist that list per (partition, `clientId`) when processing a
pull — alongside the cursor record of §4.5 — and load it at WebSocket
upgrade. A client that has never pulled
has no registered subscriptions: it receives `hello` with
`requiresSync: true` and no deltas until a pull registers them — which,
for a socket-syncing client, is its first sync round on this very
connection (§8.7), so connect-then-sync is the reference boot order.
Registrations are fixed for the life of the connection **under the HTTP
binding alone**: a pull over `POST /sync` takes effect at the next
connect, not mid-session. A sync round completed **on the connection
itself** replaces them at round end (§8.7) — the reference client path.
This is what lets a **window change** (§4.8) take effect immediately: the
socket round whose subscription list added a widened unit and dropped a
shrunk one re-registers on that same round, so a widened unit begins
receiving deltas and a shrunk one stops with no reconnect or socket
cycle.

Control messages are JSON text frames. Binary WebSocket messages carry
a one-byte **channel tag** followed by their payload (§8.7): tag `0x00`
is a standalone, complete SSP2 **response** message (§1.6) — a delta —
one envelope grammar for HTTP and socket (§0 decision); tag `0x01` is a
chunk of an in-flight sync round's byte stream. A client MUST tolerate
and ignore unknown JSON control
events (forward compat mirror of the frame-skip rule). "Unknown" is
scoped to the **event name**: a JSON object whose `event` value is not
defined by this section is tolerated, never a parse error. A *known*
event whose `data` is missing or of the wrong shape is malformed — a
parse error, not a tolerated variant. All numeric fields in control
messages (`protocolVersion`, `cursor`, `latestCursor`, `timestamp`, the
ack `cursor`, …) are **integers within the ±(2^53−1) `i64` contract**
(Conventions); a fractional or non-finite number in a known event is
malformed. Direction is carried by the
discriminator key: server→client events carry `event`; client→server
control messages carry `type` (§8.2).

Server → client on connect:

```json
{"event":"hello","data":{"protocolVersion":1,"sessionId":"…",
 "actorId":"…","clientId":"…","cursor":<lastAckedCursor>,
 "latestCursor":<serverLatest>,"requiresSync":<bool>,"timestamp":<ms>}}
```

`requiresSync: true` ⇒ the client MUST run a sync round (a socket round
per §8.7, or `POST /sync`) before trusting the socket for continuity.

### 8.2 Delta delivery and acks

- After a commit, the server pushes to each registered connection whose
  effective scopes match any of the commit's stored scope keys a binary
  delta (`0x00`-tagged, §8.7): an SSP2 response containing, per affected subscription,
  `SUB_START` / `COMMIT`(s) / `SUB_END` with the advanced `nextCursor`.
- Deltas MUST be cursor-contiguous per connection: a delta starting past
  the client's last delivered cursor is forbidden — the server sends a
  wake-up (§8.3) instead when it cannot bridge the gap. The other
  direction is harmless: a delta section whose `SUB_END.nextCursor` is
  ≤ the subscription's local cursor is a duplicate and is idempotently
  skipped (or re-applied — upserts and deletes are idempotent, §5.6);
  it advances nothing and is **not** a drop, so it MUST NOT set the
  sync-needed signal. A per-connection
  replay buffer is an OPTIONAL optimization; the reference server keeps
  **none**: a session that is behind at connect
  (`cursor < latestCursor`) or that dropped a delta (flow control,
  oversize) suppresses further deltas and answers each subsequent
  matching commit with a coalescible `catchup-required` wake-up, until
  an ack reaches the highest `commitSeq` the connection has observed —
  then deltas resume.
- The client acknowledges applied deltas:
  `{"type":"ack","cursor":<highest contiguously applied commitSeq>}`.
  The ack is the sole client→server control message and is recognized
  by its `"type":"ack"` field (client→server messages carry `type`,
  not `event` — §8.1).
  The server uses acks to trim its per-connection replay buffer (if it
  keeps one) and to update the client cursor record (§4.5) without an
  HTTP pull.
- **Client-side application.** A delta applies exactly like a pull
  response (§4.5), per section: only subscriptions that are locally
  `active` and not mid-bootstrap (no resume token pending, §4.7) apply;
  skipped sections advance nothing and are repaired by the
  subscription's own next pull (a bootstrapping subscription's post-pin
  replay already covers the window). A client that does not apply a
  received delta message at all — a pull in flight over the same
  database, a decode or apply failure — MUST treat the drop as a
  wake-up (§8.3: run a pull soon): a server without a replay buffer
  never resends, and later deltas would otherwise apply over the gap
  silently.
- **Ack points.** After applying a delta, the client acks the highest
  applied `SUB_END.nextCursor` in it. After a pull round — a socket
  round (§8.7) or an HTTP pull — while the
  connection is live, the client acks the minimum cursor across its
  active, non-bootstrapping subscriptions that have synced at least
  once — the contiguity-safe floor, and the ack that lifts the
  reference server's delta suppression after a catch-up pull. No such
  subscription, no ack. "Synced at least once" means the subscription
  has processed its **first `SUB_END`** (§4.4) — the earliest point at
  which a persisted cursor exists to ack. (Origin: stage-2 conformance —
  a never-synced subscription has no cursor, and inventing `-1`/`0`
  there would drag the ack floor below commits the connection already
  observed.)
- Flow control: the server bounds in-flight unacked deltas and per-window
  message counts (host-configured); when exceeded, or when a delta would
  exceed the host's max message size, it drops to a wake-up.

### 8.3 Wake-ups

The single JSON data-plane event:

```json
{"event":"sync","data":{"cursor":<serverLatest>,"requiresPull":true,
 "reason":"delta-too-large"|"catchup-required"|"reset-required",
 "timestamp":<ms>}}
```

| Reason | Meaning | Client action |
|---|---|---|
| `delta-too-large` | The delta exceeded message limits | Sync round (pull) |
| `catchup-required` | Gap not bridgeable from the replay buffer (reconnect, drops, flow control) | Sync round (pull) |
| `reset-required` | Server-declared discontinuity (schema rollover, horizon, forced resync) | Sync round (pull); expect `reset`/`requiredSchemaVersion` there |

Wake-ups are idempotent and coalescible; the client MUST treat any
wake-up as "run a pull soon", never as data.

The three reason strings are a **closed set**: a `sync` event whose
`reason` is not one of them is malformed (a parse error under §8.1's
known-event rule), not an unknown-event case. Forward compatibility for
the realtime channel means new *event* names (tolerated per §8.1),
never new reason strings on an existing event.

`requiresPull` MUST be the literal `true`; a `sync` event carrying
anything else is malformed (a parse error). The field is redundancy,
not signal — wake-ups always require a pull — and redundant fields are
pinned, never interpreted.

### 8.4 Reconnect and catch-up

- Client reconnect uses exponential backoff (suggested: initial 1 s, ×2,
  cap 30 s) **with jitter**; after `hello.requiresSync` or any wake-up,
  the client MUST apply jitter (suggested uniform 0–2 s, host-tunable)
  before the recovery pull. Jittered coalescing is normative-SHOULD
  because reconnect storms are a first-class design input (measured:
  13 ms server fanout, ~2 s client-side wake-contention tail at
  250+ clients).
- Multiple wake-ups and local triggers MUST coalesce into one pull.
- **Scheduling is host policy.** Timers — reconnect backoff, wake
  jitter, when the coalesced pull actually runs — live in the app
  shell, not the protocol core. The core exposes one coalesced
  **sync-needed signal**: set by `hello.requiresSync`, by every
  wake-up, and by every client-side delta drop (§8.2); cleared when a
  pull round *begins*, so a wake-up landing mid-round survives the
  round and triggers another pull. Aggregate drive-to-idle helpers
  (e.g. a conformance driver's `syncUntilIdle`) are part of the
  driver/host contract, not the protocol.
- **Catch-up prefers segments**: when a recovery pull arrives with a
  cursor far behind (server heuristic; suggested threshold: the gap
  exceeds `limitCommits` or a host-set row estimate), the server SHOULD
  answer with bootstrap segments (fresh pin, §4.7) instead of replaying a
  long commit window — reconnect storms then hit the CDN/segment cache,
  not the log scan path.

### 8.5 Heartbeat

Server sends `{"event":"heartbeat","data":{"timestamp":<ms>}}` on a host
interval (suggested 30 s). A client that hears nothing (any frame counts)
for 2× the interval SHOULD reconnect. No client→server ping is specified.

### 8.6 Presence

Scope-keyed **ephemeral** presence: a connected client publishes a small
host-shaped JSON document tagged to a scope key it holds, and every other
connection registered on that scope key receives join/update/leave events.
Presence is the realtime who's-online-and-doing-what surface:
ephemeral cursors/activity per scope, never the commit log.

Presence rides the realtime channel as JSON control events under the
reserved `presence` event name in **both** directions (§8.1's
tolerate-unknown discipline: a feature-off peer ignores the whole event by
its name, so presence ships with **no wire-version bump** — it is new
*event names*, never new frames or reason strings). The binary frame types
`0x20`–`0x2F` stay reserved for a possible future high-throughput binary
presence encoding; wire version 1 carries presence as text only.

#### 8.6.1 Model — the invariants

- **Ephemeral.** A presence document lives only for the life of the
  publishing connection. It is **never persisted**, **never written to the
  commit log**, and **never delivered on a pull or delta** (§4/§8.2). It is
  not part of any cursor, horizon, or segment. A server restart loses all
  presence; a client learns the new truth by re-publishing and by the
  snapshot it receives when it re-registers (§8.6.4).
- **Scope-addressed.** Every presence document is tagged to exactly one
  **scope key** — a `prefix:value` string (§3.1), the same addressing unit
  the fanout index uses. A connection may hold presence on several scope
  keys at once (one document per key); publishing to a different key does
  not disturb the others.
- **Lost on disconnect ⇒ leave.** When a publishing connection closes
  (clean or not), the server MUST emit a `leave` for every scope key that
  connection was present on, to the remaining registered peers. A dropped
  socket and an explicit leave (§8.6.2, `doc: null`) are observationally
  identical to peers.
- **Identity is (actor, client).** A presence document is attributed to the
  publishing connection's `(actorId, clientId)` pair — the **peer identity**
  (§8.6.3). Two connections of the same actor (two devices, two tabs behind
  distinct `clientId`s) are two distinct peers, each with its own document;
  the same `clientId` reconnecting **replaces** its own prior document for
  the key (last publish wins per `(scopeKey, actorId, clientId)`).

#### 8.6.2 Wire

**Client → server** (publish or leave):

```json
{"event":"presence","data":{"scopeKey":"project:p1","doc":{…}}}
```

```json
{"event":"presence","data":{"scopeKey":"project:p1","doc":null}}
```

`doc` is a host-defined JSON **object** (or `null` to leave). `scopeKey` is
a non-empty string. A `presence` client→server message whose `data` is
missing, whose `scopeKey` is absent/empty/non-string, or whose `doc` is
neither a JSON object nor `null` is **malformed** — a parse error under
§8.1's known-event rule (a *known* event with wrong-shape `data` is never a
tolerated variant). `doc` being any JSON value other than an object or
`null` (a scalar, an array) is likewise malformed: the document shape is
host-defined but its container is pinned to `object` so the identity fields
the server injects (§8.6.3) cannot collide with a top-level scalar.

**Server → client** (fanout — one peer's presence changed on a key the
receiver holds):

```json
{"event":"presence","data":{"scopeKey":"project:p1","kind":"join"|"update"|"leave",
 "actorId":"…","clientId":"…","doc":{…}|null,"timestamp":<ms>}}
```

- `kind` is a **closed set** of three: `join` (the peer's first document on
  this key for the receiver's view), `update` (a subsequent document from an
  already-present peer), `leave` (the peer cleared the key or disconnected).
  A `presence` server→client event whose `kind` is not one of the three is
  malformed (mirrors the §8.3 closed-reason rule).
- `doc` is the peer's document for `join`/`update`, and `null` for `leave`.
  The `doc`-present-iff-not-`leave` tie is pinned: a `leave` MUST carry
  `doc: null`, and a `join`/`update` MUST carry a `doc` object.
- `actorId`/`clientId` identify the peer (§8.6.3). `timestamp` is the
  server clock (epoch ms) when the change was fanned out.

**Snapshot on register (§8.6.4).** When a connection acquires a scope-key
registration and other peers are already present there, the server delivers
the current set as a burst of `join` events (one per already-present peer),
so a newly-registered connection sees who is already there without waiting
for the next change. There is no distinct `snapshot` kind: the snapshot IS
a burst of `join`s (fewer shapes to specify and conformance-test).

**Size cap → fail loud, in-band.** A host caps the serialized size of a
published `doc` (default 16 KiB, host-tunable). An over-cap publish is
**rejected loudly on the same channel** — the server answers the publisher
(only) with:

```json
{"event":"presence","data":{"scopeKey":"…","error":"presence.too_large","timestamp":<ms>}}
```

and does **not** fan it out or change the publisher's stored document for
the key (a rejected publish is a no-op on state, per the fail-loud doctrine:
never a silent drop, never a silent truncation). `presence.*` are
**client-runtime** codes, not §10 wire codes — presence is a realtime
control surface, not a request/response with an `ERROR` frame — so they are
carried in the `error` field of a server→client `presence` event, a known
shape a feature-off peer still ignores by event name. The closed set is
two: `presence.too_large` (over the size cap) and `presence.forbidden`
(publish/subscribe to a key the connection does not hold — §8.6.3).

#### 8.6.3 Authorization and identity

Presence rides the **same registration** as delta fanout (§8.1/§8.7): the
connection's registered effective scope keys ARE its presence grant — there
is no separate presence grant, token, or resolver call.

- **Publish authorization.** A client→server publish for `scopeKey` is
  honored only if the connection is currently registered on that scope key
  (the key appears in some registration's effective scopes, §3.2). A publish
  to an unheld key is rejected loudly to the publisher with
  `presence.forbidden` (the §8.6.2 error shape) and fans out nothing — a
  connection can never inject presence into a scope it cannot see.
- **Receive authorization (the privacy floor).** A peer's presence for
  `scopeKey` is delivered to a connection only if that connection is itself
  registered on `scopeKey`. Presence for a key is visible **exactly** to
  the current scope-mates of that key and no one else — never to a
  connection holding a different scope, never partition-wide. This is the
  hard privacy boundary the cross-scope conformance probe pins (§8.6.5).
- **Identity exposed.** The fanout exposes the peer's `(actorId, clientId)`
  and its `doc`. It does NOT expose the peer's connection/session id, its
  other scope keys, or any presence on keys the receiver does not hold. A
  scope-mate already, by construction, may see that actor's rows on that
  scope (§3.2), so revealing the actor on a shared key leaks no authority
  boundary; `clientId` distinguishes that actor's devices/tabs, which
  collaborative presence (two cursors from one user) requires.
- **Registration change re-derives presence.** When a socket round replaces
  a connection's registrations (§8.7) or a reconnect re-registers (§8.1),
  the connection's presence grant follows: keys it no longer holds emit a
  `leave` of its own published documents to the remaining peers **and** stop
  delivering peers' presence to it; keys it newly holds deliver the snapshot
  (§8.6.4). A revoked scope (§3.3) drops presence on that key exactly as a
  disconnect would for that key alone. Presence never survives loss of the
  scope that authorized it.

#### 8.6.4 Server responsibilities

- A hub-level **presence registry**, keyed per `(partition, scopeKey)` →
  the set of currently-present connections and their documents. It is pure
  in-memory ephemeral state alongside the session set; it MUST NOT touch
  `ServerStorage`.
- On publish (authorized, within cap): store/replace the connection's
  document for the key and fan a `join` (first document from this connection
  on this key) or `update` (replacement) to every **other** connection
  registered on the key. A publisher does not receive its own fanout.
- On leave (`doc: null`, or disconnect, or losing the key's registration):
  remove the connection's document for the key and fan a `leave` to the
  remaining registered connections.
- On a connection acquiring a key's registration: deliver the snapshot
  (§8.6.4 join-burst) of the already-present peers to that connection only.
- **Rate cap (MAY-throttle, observable).** A host MAY bound the rate of
  client→server presence publishes per connection (default: a MAY, off in
  the reference server unless configured). When a publish exceeds the cap
  the server MUST use the **latest-wins coalesce** behavior: it keeps the
  connection's most recent in-window document as the pending state and
  drops the intermediate ones, then fans out at most one `update` per window
  carrying that latest document — never an error, never a stale document,
  never silent total loss of the latest state. Observable behavior: peers
  see the newest document at a bounded rate, and no publish is answered with
  `presence.too_large` merely for arriving quickly (the size cap and the
  rate cap are distinct surfaces). This keeps a chatty cursor-stream from
  fanning out unboundedly without dropping the truth.
- **Event seam.** Presence reuses the existing `realtime.*` ops discipline
  with no new op types in the tight catalog: presence join/leave counts are
  surfaced through the existing `realtime.opened`/`realtime.closed` events'
  session accounting where relevant, and a presence publish is not itself an
  ops event (it is ephemeral chatter, deliberately below the ops floor — the
  catalog stays tight, §4-server ops posture).

#### 8.6.5 Conformance

Presence is exercised by driver-interface scenarios (Appendix B, presence
group), both pairings:

- **Two clients, same scope, full lifecycle.** A and B register the same
  scope key over the socket; A publishes → B sees `join`; A republishes → B
  sees `update`; A publishes `doc: null` → B sees `leave`; A publishes
  again then **disconnects** → B sees `leave` (disconnect-implies-leave). A
  late-joining C receives the snapshot join-burst of whoever is present.
- **Cross-scope isolation (privacy probe).** A holds `project:p1`, D holds
  only `project:p2`. A's publish on `p1` never reaches D; D's publish on
  `p2` never reaches A; neither can publish onto the other's key
  (`presence.forbidden`). No leakage to non-scope-mates on any lifecycle
  event.
- **Feature-off silence.** A peer that never publishes and ignores
  `presence` events (the tolerate-unknown path, §8.1) is undisturbed:
  presence traffic among others changes nothing observable for it, and its
  own sync rounds/deltas are unaffected.
- **Survives a sync round on the same socket.** A is present on a key,
  interleaves a §8.7 sync round on the same connection (push + pull), and
  its presence — and the presence it observes — survives the round intact
  (presence state is independent of round state; the round's registration
  replace re-derives the same grant, §8.6.3).

### 8.7 Sync rounds over the socket

### 8.7 Sync rounds over the socket

The realtime channel is a **second, full transport binding** of the
sync handler (§1.1): a connected client runs its combined push+pull
rounds (§1.5/§1.6) over the socket instead of `POST /sync`. Semantics
are identical by construction — one handler, two framings; nothing in
§§4–7 distinguishes the bindings. The reference clients sync
**exclusively** over the socket once it is connected (Direction
decision 1: one loop, no polling mode); `POST /sync` remains fully
conformant for any client that chooses it. Segment downloads stay on
HTTP (§5.5) — the CDN bulk path — and that bounds socket traffic
naturally: bootstrap bulk SHOULD ride segments (§5.7), so a round's
response stays small even when the data it describes is not.

**Channel tags.** Every binary WebSocket message on the channel is a
one-byte **channel tag** followed by its payload:

| Tag | Direction | Payload |
|---|---|---|
| `0x00` | server → client | One complete, standalone SSP2 response message — a delta (§8.2) |
| `0x01` | both | One chunk of the in-flight sync round's byte stream (request client→server, response server→client) |

Tags are a closed registry per wire version. A client MUST ignore a
server→client binary message with an unknown tag (forward-compat
mirror of §8.1's unknown-event rule); a server MAY close the
connection on a client→server tag other than `0x01` (a broken client,
surfaced loudly). Text messages are unaffected: JSON control traffic
(§8.1–§8.3, §8.5) interleaves freely at message boundaries in both
directions, mid-round included.

Why a tag rather than bare no-interleave: a delta emitted just before
the server sees a round's first byte can reach the client after it
sent the request — no ordering rule prevents that race, and deltas and
round responses are both SSP2 response messages, indistinguishable by
content. One byte makes attribution stateless. The tag is
transport-binding framing, not part of any SSP2 message — golden
vectors are unaffected.

**Round framing.** A round is:

1. The client sends the complete SSP2 **request** message (§1.5) as
   one or more `0x01` messages. Chunk boundaries are arbitrary and
   carry no meaning; the concatenated payloads form the request byte
   stream. The envelope grammar is self-delimiting (§1.2): the request
   ends when its `END` frame is consumed. Bytes past `END` in the
   stream are a pipelining violation (below).
2. The server answers with the SSP2 **response** byte stream, produced
   per §1.4 (no full-response buffering) and sent as one or more
   `0x01` messages at arbitrary chunk boundaries — the reference
   server sends one message per encoded frame. A streaming client
   applies frames as they arrive (§1.4); reassembly is concatenation,
   nothing more. The stream ends when the response's `END` frame is
   consumed; the final chunk MUST end exactly at the `END` frame's
   last byte.
3. The round is **complete** at the response's `END`. The next `0x01`
   message in either direction belongs to a new round.

**Failures.** A request-level failure that the HTTP binding reports as
JSON with an HTTP status (§1.1 — a decode error of the request
message, or request-level validation per §1.7) is delivered on the
socket as a minimal response stream: `RESP_HEADER`, `ERROR`, `END`.
The client treats it exactly like an in-band `ERROR` (§1.6): the whole
round failed with that error. A client→server byte stream whose 8-byte
envelope header is not a valid SSP2 request header is
connection-fatal: the server MUST close the socket (an unframed stream
has no findable end). A round's `REQ_HEADER.clientId` MUST equal the
connection's `clientId` (§8.1); a mismatch fails the round with
`sync.invalid_client_id` — registration identity would otherwise be
ambiguous.

**One round in flight.** A connection carries at most one sync round
at a time: the client MUST NOT begin a new request before the current
response's `END` (no pipelining — coalescing wake-ups into the next
round is already required by §8.4). A server receiving round bytes
while a response stream is in flight MUST NOT process them and MAY
drop the connection; the reference server closes it. HTTP rounds are
not serialized against socket rounds by the server — but a client
driving both bindings concurrently against one database is outside the
reference design (one loop, §8.4).

**Interleaving.** While a response stream is in flight, the server
MUST NOT send `0x00` (delta) messages on that connection. A commit
matching the connection's registrations during that window follows the
§8.2 suppression path: the session answers with coalescible
`catchup-required` wake-ups (text — free to interleave) until an ack
covers the highest `commitSeq` the connection has observed. The
client's post-round ack (§8.2 ack point — it applies to socket rounds
exactly as to HTTP pulls) lifts the suppression when the round's pull
half already covered the commit; otherwise the wake-up's next round
does. Deltas resume with zero new machinery.

**Backpressure.** Per-connection server send buffering MUST be
bounded: when the socket cannot drain (implementation signal, e.g.
`bufferedAmount` above a host threshold), the server pauses consuming
the response stream instead of buffering it whole — §1.4's anti-goal
applies to this binding too. Observable behavior: response delivery
slows to the socket's pace; the stream is never truncated, reordered,
or interleaved with other binary traffic. Mechanics (drain events,
thresholds, chunk sizes) are host concerns. Together with the
segments-for-bulk rule above, this bounds both memory and message
sizes without a protocol-level flow-control scheme.

**Registration at round end.** On completion of a socket round whose
request carried a `PULL_HEADER`, the request's subscription list
**replaces** the connection's registrations, effective scopes
re-resolved, effective immediately for subsequent fanout. This is the
socket-native form of §8.1's persistence rule: the same list the
server persists per (partition, `clientId`) registers on the
connection that ran the round, with no reconnect. A round that fails
(request-level failure or in-band `ERROR`) or carries no `PULL_HEADER`
leaves registrations unchanged — matching §4.5/§8.1 persistence, and
the reference server implements it exactly that way: it reloads the
persisted client record at round end, which only advances on success.
Consequence: **connect-then-sync is the reference boot order**. A
client that connects the socket before its first-ever pull starts with
zero registrations (§8.1) and acquires them from its first socket
round; the "connected but silently unregistered until the next
reconnect" failure mode of an HTTP-pull-only client cannot occur.

---

## 9. Versioning and evolution

- **Wire version** (`u16` in the envelope): incremented for any change to
  frame layouts, record fields, primitive encodings, or frame grammar.
  Readers reject unknown versions (§1.2). There are no minor versions:
  vectors pin exact bytes.
- **Frame types are append-only**: new capabilities are new frame types;
  existing frame payload layouts are frozen per wire version. Unknown
  frame types are skipped by length — so a reader pinned at the current
  wire version survives a
  server that emits optional new frames, and features can ship without a
  version bump when ignoring them is safe. If ignoring a frame is *not*
  safe, that is by definition a wire-version bump.
- **Segment format version** (`u16` in SSG2) evolves independently under
  the same rules; the `mediaType` byte in descriptors names formats, so
  new media types are additive.
- **Schema versioning** (application-level):
  `schemaVersion` flows client→server in `REQ_HEADER`; the server answers
  with `requiredSchemaVersion` (hard floor — client must upgrade) and/or
  `latestSchemaVersion` (informational) in `RESP_HEADER` (§1.6). Segments
  and row codecs are minted per schema version; a server MAY serve older
  schema versions it still has codecs for, and signals the floor when it
  no longer can.
- **Breaking change definition**: anything that changes the bytes of an
  existing golden vector, removes an error code, or changes normative
  MUST behavior. Non-breaking: new frame types, new error codes, new
  segment media types, new JSON control events.
- Every wire-visible change lands **in the same commit** as its updated
  golden vectors (CI-enforced in this tree).

---

## 10. Error catalog

### 10.1 Shape

Every protocol error — HTTP JSON body (§1.1) or `ERROR` frame (§1.6) —
carries:

| Field | Semantics |
|---|---|
| `code` | Stable machine identifier from the table below |
| `category` | Coarse class, for generic client handling |
| `retryable` | May the *same* request succeed later without modification? |
| `recommendedAction` | The client-runtime action verb (below) |
| `message` | Human-readable; MAY be overridden per instance; never parsed |
| `details` | Optional JSON object, code-specific |

`category`, `retryable`, `recommendedAction` for a given `code` are fixed
by this table — clients MAY hardcode them.

Recommended actions: `refreshAuth`, `checkPermissions`, `fixRequest`,
`resetClientId`, `regenerateClient`, `upgradeClient`, `resolveConflict`,
`rebootstrap`, `forceResync`, `retryLater`, `splitBatch`,
`inspectServer`.

### 10.2 Codes (wire version 1)

| Code | Category | Retryable | Action | Produced when |
|---|---|---|---|---|
| `sync.auth_required` | auth-required | yes | refreshAuth | Host authentication absent/failed (HTTP 401; WS close) |
| `sync.auth_lease_required` | auth-required | yes | refreshAuth | The host opted the request into lease authorization (a live-resolver outage) but no valid lease exists for `(partition, clientId)` — expired, actor-mismatched, or never issued (§7.3.3) — *new in SSP2*; request-level |
| `sync.auth_lease_revoked` | auth-required | yes | refreshAuth | A lease-authorized round was attempted on a lease the host revoked by `leaseId` (§7.3.4) — *new in SSP2*; request-level. Distinct from `sync.scope_revoked` (§3.3): the grant was pulled, but no local data is purged |
| `sync.forbidden` | forbidden | no | checkPermissions | Write-path scope denial (§3.4); segment scope-digest mismatch (§5.5); `resolveScopes` threw on a write |
| `sync.invalid_request` | invalid-request | no | fixRequest | Malformed envelope/frame, bad content type, missing required fields |
| `sync.invalid_client_id` | invalid-request | no | resetClientId | `clientId` bound to a different actor (§1.5) |
| `sync.invalid_subscription` | invalid-request | no | fixRequest | Duplicate subscription id; undeclared scope key (requested **or** resolved — §3.2) |
| `sync.empty_commit` | invalid-request | no | fixRequest | `PUSH_COMMIT` with zero operations |
| `sync.unknown_table` | schema-mismatch | no | regenerateClient | Subscription (request-level) or push operation (commit-level, §1.7) names a table the server doesn't handle |
| `sync.row_missing` | not-found | no | forceResync | Upsert with `baseVersion ≠ 0` targeting an absent row (§6.2) |
| `sync.version_conflict` | conflict | no | resolveConflict | `baseVersion` mismatch (§6.2) — appears as a conflict result, not a request error |
| `sync.constraint_violation` | invalid-request | no | fixRequest | Server-side data constraint (unique/FK/not-null) rejected the write; also a §6.7 write-validator that threw a non-host-code error (an unexpected throw, not a deliberate host rejection) |
| `sync.missing_scopes` | internal | no | inspectServer | Handler emitted a change without stored scopes (§3.1) |
| `sync.crdt_merge_failed` | internal | no | inspectServer | A `crdt` column (§2.4 tag 8) was pushed but no merger is registered for its `crdtType`, or the merger threw (§5.10.2) — *new in SSP2*; a push operation-result `error` record only |
| `sync.idempotency_cache_miss` | internal | yes | retryLater | Cached push result unreadable on replay (§6.3) |
| `sync.too_many_operations` | invalid-request | no | splitBatch | Push exceeds the operation cap (§6.1) |
| `sync.not_found` | not-found | no | forceResync | Unknown segment id (§5.5) or sync resource |
| `sync.segment_expired` | not-found | yes | retryLater | Segment TTL elapsed (§5.1); re-pull mints fresh descriptors — *new in SSP2* |
| `sync.cursor_expired` | reset-required | no | rebootstrap | Cursor behind the pruning horizon (§4.6) — *new in SSP2*; delivered as `SUB_START` reason code |
| `sync.scope_revoked` | scope-revoked | no | checkPermissions | Subscription revoked (§3.3) — delivered as `SUB_START` reason code |
| `sync.rate_limited` | rate-limited | yes | retryLater | Request or connection rate cap |
| `sync.schema_mismatch` | schema-mismatch | no | regenerateClient | Generated client artifacts incompatible with the server (e.g., segment column-table mismatch, §5.2) |
| `sync.client_schema_unsupported` | schema-mismatch | no | upgradeClient | `schemaVersion` below the server floor (accompanies `requiredSchemaVersion`) |
| `sync.websocket_connection_limit` | rate-limited | yes | retryLater | Realtime connection cap (global or per client) |
| `blob.not_found` | not-found | no | fixRequest | Blob download for an unknown blob (§5.9.5), or a push referencing an absent blob (§5.9.6, §6.6) — *new in SSP2* |
| `blob.forbidden` | forbidden | no | checkPermissions | Blob download where no referencing row is authorized for the actor (§5.9.5) — *new in SSP2* |
| `blob.hash_mismatch` | invalid-request | no | fixRequest | Uploaded bytes' content address ≠ the `{blobId}` path (§5.9.3) — *new in SSP2* |
| `blob.too_large` | invalid-request | no | fixRequest | Uploaded blob exceeds the host size cap (§5.9.3) — *new in SSP2* |

The `blob.*` codes form a closed set of four: two on the download path
(`not_found`, `forbidden`), two on the upload path (`hash_mismatch`,
`too_large`). `blob.not_found` doubles as the push-time
reference-existence rejection (§6.6). No `blob.*` code is delivered as a
`SUB_START` reason or a pull `ERROR` frame — blobs never ride the pull
stream; they surface only on the dedicated `/blobs/{blobId}` routes and,
for `blob.not_found`, as a push operation-result `error` record.

### 10.3 Reserved and out-of-scope codes

Outside the wire catalog: all client-local codes
(`sync.offline`, `sync.transport_failed`, `sync.outcome_not_found`
[§7.2.1 — an explicit resolution named no retained journal entry],
`sync.outbox_incompatible`
[§7.4.4 — a pending commit cannot re-encode under the new schema after a
bump], `client.decrypt_failed` [§5.11 — an encrypted column failed to
decrypt on apply: unknown envelope version, unknown `keyId`, GCM
authentication failure (wrong key), a malformed envelope, or a post-decrypt
value-parse failure; category `crypto`, non-retryable, raised at the apply
seam, never on the wire], `client.subscription_intent_mismatch` [§4.1 — one
registered subscription id was re-declared with a different table, canonical
scope map, or params], `client.worker_failed` [a browser worker failed outside
wire semantics], `client.worker_restart_required` [a browser worker module
graph refers to a retired bundler chunk and the page must reload without
deleting its local replica], `storage.*`, `worker.*`, `runtime.*`) — client
SDKs may keep such codes internally but they are not protocol. Reserved
without a producer: `sync.integrity_rejected`,
`sync.websocket_not_configured`, and `sync.unsupported_operation` (no
SSP2 producer — the wire `op` byte admits only upsert/delete and SSP2
defines no per-table operation restriction; reserved if such a capability
lands); `console.*`, `proxy.*` (post-gate features). The `blob.*` family
is specified as four codes in §10.2 (§5.9, the blobs rung); any future
`blob.*` code stays within that family's semantics.

In the `sync.auth_lease_*` family (§7.3), exactly **two codes have a
producer and are specified in §10.2** — `sync.auth_lease_required`
(§7.3.3) and `sync.auth_lease_revoked` (§7.3.4). Five further names are
**reserved without a producer** (the §10 discipline: a code with no
producer is not in the catalog): `sync.auth_lease_invalid` and
`sync.auth_lease_scope_mismatch` (SSP2 leases are server-issued,
server-held, and client-opaque — §7.3 non-goal 1 — so there is no client
token to reject and no per-operation grant to mismatch);
`sync.auth_lease_schema_mismatch` (SSP2 already enforces the schema floor
via `requiredSchemaVersion`, §1.6 — a stale-schema round never reaches
lease authorization, so the code has no distinct producer);
`sync.auth_lease_missing` (the same "you need a lease and have none"
surface as `sync.auth_lease_required`, which names the action it
implies); and `sync.auth_lease_business_rejected` (a leased write that
violates a business rule rejects through the ordinary §3.4/§6 codes, not
a lease-specific one). The five reserved names must not be reused for
other meanings, should a future rung introduce client-presented leases or
per-scope grants.

**Host codes are outside this catalog by design.** A §6.7 write-validator
rejects with a **host-defined** code that is deliberately *not* a catalog
code — it is opaque to the client runtime, which applies generic rejection
handling and never hardcodes its `category`/`retryable`/`recommendedAction`
(those fields are catalog-fixed only for the codes in §10.2). A host code
MUST NOT begin with the reserved protocol-family prefixes `sync.`,
`blob.`, `presence.`, or `client.` (§6.7), so a code in a rejection record
is always unambiguously either a protocol code (this catalog, its fixed
metadata applies) or a host code (opaque, app-defined). This keeps the
wire catalog closed while letting hosts mint their own business-rule
codes — the same "protocol codes are closed, host codes are open" split
that lets `message` be host-overridden (§10.1) without weakening the
machine identifiers.

---

## 11. Canonical JSON debug rendering

**Non-contractual for the wire; contractual for golden vectors.** No
implementation may parse JSON renderings in production paths; every
implementation SHOULD ship a `render(bytes) → json` developer tool, and
the vectors CI keeps it honest (unexercised debug tooling rots
silently).

### 11.1 Rendering rules

1. One JSON document per SSP2 message:
   `{"magic":"SSP2","wireVersion":1,"msgKind":"request"|"response",
   "frames":[…]}` — frames as an array in wire order, each
   `{"type":"<FRAME_NAME>", …fields}`; `END` is omitted.
2. Field order within a frame object follows the field tables in this
   document, top to bottom.
3. Absent `opt()` fields are **omitted** (never `null`).
4. Binary fields (`row`, push `payload`, `serverRow`, segment payloads —
   including the whole `SEGMENT_INLINE` frame payload, which renders as
   `{"type":"SEGMENT_INLINE","payload":"<base64>"}`, never as a nested
   rule-8 object) are standard **base64** strings; hashes and
   `segmentId` stay in their native hex/string form.
5. Enums render as their spec names (`"upsert"`, `"active"`,
   `"sqlite"`, …), not their byte values. Bitmask fields (`accept`) are
   not enums and render as their numeric value.
6. `i64` renders as a JSON number (safe by the ±2^53−1 contract);
   timestamps stay numeric epoch ms.
7. `json`-typed fields are embedded as parsed JSON objects, not
   re-escaped strings.
8. Rows segments render as `{"magic":"SSG2","formatVersion":1,
   "table":…,"schemaVersion":…,"columns":[…],"blocks":[[…row
   records…]]}` with each row record as
   `{"serverVersion":…,"values":{…name→value…}}` (`values` keyed by the
   column-table names — nested so a column literally named
   `serverVersion` cannot collide; columns as
   `{"name":…,"type":…,"nullable":…}` with the type
   name, not the tag). NULL column values render as JSON `null`;
   `bytes` values are base64; `json`-typed column values render parsed
   (rule 7).
9. Unknown frames preserved by the skip rule (§1.2 rule 2) render as
   `{"type":"UNKNOWN","frameType":<byte value as number>,
   "payload":"<base64>"}`.
10. Non-finite `f64` values (NaN, ±Infinity) render as JSON `null` —
    JSON has no representation for them, and this is what JavaScript's
    JSON serialization produces. The wire bytes are unaffected (the
    codec carries any IEEE-754 bit pattern); only the debug rendering
    collapses them.

### 11.2 Canonical JSON (for digests)

Where this spec hashes JSON (scope digest §3.5, `X-Syncular-Scopes`
§5.5): UTF-8, no insignificant whitespace, object keys sorted by
code-unit, scope value lists sorted and deduplicated, numbers in
shortest-round-trip form. This sub-format IS contractual (digests must
match across implementations).

---

## Appendix A. Golden vectors

Location and per-case requirements are defined in
[`spec/vectors/README.md`](../spec/vectors/README.md): for each case a
canonical `.bin`, its §11 JSON rendering as `.json`, and a per-kind
`manifest.json`. `invalid/` cases carry descriptive slug names (several
share an error code, so names describe the violation); the expected
error code is declared per case in `manifest.json`. Decode, byte-exact
re-encode, and negative-case checks are CI-blocking for every
implementation in this tree.

Directory layout (message kind = top-level directory):

```
spec/vectors/
  request/    response/    segment/    realtime/
    <case>.bin  <case>.json  manifest.json  invalid/…
```

Initial vector set (binaries are generated deterministically by the
reference codec via `packages/core/scripts/generate-vectors.ts`, never
hand-hexed; a second implementation regenerating them must produce
byte-identical output):

| # | Case | Covers |
|---|---|---|
| 1 | `request/pull-minimal` | Smallest legal request: header + pull + one caught-up subscription |
| 2 | `request/pull-bootstrap` | Two subscriptions — a single subscription cannot carry both: fresh bootstrap (`cursor = -1`, `params`) + resumed bootstrap (`cursor` at the §4.7 pin, `bootstrapState` round-trip); `accept` bits incl. sqlite + signed URLs |
| 3 | `request/push-multi-commit` | Two commits: upsert with `baseVersion`, delete, row-codec payload edge cases (NULL bitmap, empty string, non-BMP unicode, `json`-typed column raw-string round-trip) |
| 4 | `request/combined` | Push + pull in one envelope (§1.5 ordering) |
| 5 | `response/pull-empty` | Active subscription, zero commits, cursor advanced anyway (§4.5) |
| 6 | `response/commits-incremental` | Two `COMMIT` frames; row codec exercising every column type incl. NULLs, `bytes`, non-BMP strings; scope map on changes |
| 7 | `response/bootstrap-segments` | `SEGMENT_REF` (sqlite, with signed URL) + `SEGMENT_REF` (rows, no URL) + `SEGMENT_INLINE`; incomplete `bootstrapState` in `SUB_END` |
| 8 | `response/push-applied` | All-applied result with `commitSeq` |
| 9 | `response/push-conflict` | `rejected` commit; conflict record with `serverVersion` + `serverRow` |
| 10 | `response/push-cached` | Idempotent replay: `status = cached`, original results |
| 11 | `response/subscription-revoked` | `SUB_START` status `revoked`, reason `sync.scope_revoked`, empty effective scopes |
| 12 | `response/cursor-reset` | `SUB_START` status `reset`, reason `sync.cursor_expired` (horizon signal) |
| 13 | `response/error-mid-stream` | `RESP_HEADER` + `SUB_START` + `ERROR` + `END`: partially streamed failure (§1.4 abort rule) |
| 14 | `response/unknown-frame-skip` | A reserved/unknown frame type between known frames — MUST decode with the frame skipped (§9) |
| 15 | `response/schema-floor` | `requiredSchemaVersion` present |
| 16 | `segment/rows-two-blocks` | SSG2 with two row blocks + end marker, all column types, nullable columns, varied per-row `serverVersion` incl. the i64 safe-integer boundary |
| 17 | `realtime/wake` + `realtime/hello` | JSON control vectors (`.json` only — no binary form) |
| 18 | `segment/crdt-column` | SSG2 for a table with a `crdt` column (§2.4 tag 8): the crdt value rides the `bytes` machinery (opaque bytes, incl. NULL and empty), pinning the new tag without touching existing fixtures |
| 19 | `response/commit-crdt-merge` | A `COMMIT` upsert whose row carries a merged `crdt` column (§5.10.3): the merged bytes ride the ordinary change payload, no CRDT-specific frame |
| 20 | `response/lease-issued` | `RESP_HEADER` + `LEASE` (§7.3.2) + an active subscription section: pins the new `0x19` frame (`leaseId`, `expiresAtMs`) in its grammar position; existing fixtures untouched (the §9 new-tag-needs-pinning rule met by a new case) |
| 21 | `realtime/presence-publish` + `realtime/presence-fanout` | JSON control vectors (`.json` only — no binary form): a client→server publish (§8.6.2 `{scopeKey, doc}`) and a server→client `join` fanout (`{scopeKey, kind, actorId, clientId, doc, timestamp}`). Pins the new `presence` event shape in both directions; a feature-off peer ignores it by event name (§8.6), so no binary vector or wire-version bump |
| 22 | `crypto/aes-gcm-*` | §5.11 ciphertext envelope, byte-pinned per `declaredType` with a **fixed** key and nonce (test-only injection): one case per value type (`string`, `json`, `integer`, `float`, `boolean`, `bytes`) — plaintext value, key, nonce, and expected envelope bytes. Both cores reproduce the envelope byte-for-byte and round-trip decrypt. A separate `crypto/` kind (not a wire message; the envelope is a codec-level value, exercised directly, not inside an SSP2 frame) |
| 23 | `crypto/x25519-wrap` | §5.11 X25519 sealed-box key wrap: a fixed recipient keypair, a fixed ephemeral secret and nonce, a fixed 32-byte symmetric key, and the expected wrap envelope; both cores wrap to the same bytes and unwrap back to the key. Proves the async-encryption utilities are cross-core byte-compatible |
| — | `request/invalid/*` | Truncated envelope (no END), bad magic, unsupported wireVersion, non-zero flags, overlong frame length, unknown enum byte (`op = 3`), upsert without payload |
| — | `response/invalid/*` | Bool byte > 1 (`SUB_START.bootstrap` = `0x02`) |
| — | `segment/invalid/*` | Null bit on non-nullable column, rows segment without end marker, json column value that does not parse (§2.4 tag 5), row `serverVersion` 0 (must be ≥ 1) |
| — | `realtime/invalid/*` | Malformed known events (JSON-only): `requiresPull` not the literal `true` (§8.3), fractional numeric field (§8.1), a `presence` fanout with an unknown `kind` (§8.6.2 closed set), a client→server `presence` with a non-object non-null `doc` (§8.6.2) |

---

## Appendix B. Conformance scenarios

Implementation-agnostic scenario definitions executed by
`packages/conformance` (B4) against any (client, server) pairing over the
loopback transport, with fault injection at the transport interface.
Each is a driver-interface script, not a prose test.

1. **Two-client convergence.** Clients A and B subscribe to the same
   scope; A pushes interleaved upserts/deletes while B pulls (and vice
   versa); after quiescence both local databases are row- and
   version-identical to the server. Exercises §4.5 cursor advancement,
   §2.2 versioning, and commit atomicity under concurrency.

2. **Offline replay.** Client A goes offline, accumulates a multi-commit
   outbox (including writes to rows B concurrently modifies), reconnects,
   and replays FIFO through a combined push+pull. Ends converged with all
   non-conflicting offline writes applied in order and optimistic state
   reconciled (§7.1–7.2).

3. **Idempotent retry under ack loss.** Transport fault injection drops
   the response of a successful push; the client retries the identical
   commit. Server returns `cached` with the original results; no double
   apply, no duplicate `commitSeq`, and a concurrent observer sees the
   commit exactly once (§2.3, §6.3).

4. **Scope revocation purge.** Client syncs a project scope; the host
   revokes membership; next pull returns `revoked` with reason
   `sync.scope_revoked`. Client purges exactly the scoped rows (other
   scopes' rows untouched), stops pulling the subscription, and drops
   pending outbox writes into the revoked scope; a table without a local
   scope-column mapping fails closed instead of clearing (§3.3).

5. **Bootstrap resume mid-stream.** A large multi-table bootstrap is
   interrupted (transport cut) after N pages; the client re-pulls with
   the last persisted `bootstrapState`. The server resumes at the pinned
   `asOfCommitSeq` from the recorded table/row cursor; no rows are lost
   or duplicated versus an uninterrupted bootstrap, and completion hands
   off to incremental pulls at the pin (§4.7, §5.6, §1.4 abort rule).

6. **Conflict resolve and rebase.** Clients A and B edit the same row
   from the same `baseVersion`; the loser receives a `rejected` commit
   with a conflict record carrying `serverVersion`/`serverRow`, rebases
   (keep-local, keep-server, and custom-merge variants), re-pushes with
   the new `baseVersion`, and converges. Sibling operations in the
   rejected commit are verified rolled back and re-applied by the rebase
   (§6.2–6.5).

7. **Reconnect catch-up via segments.** A client disconnects while the
   server advances the log far past `limitCommits` (but not past the
   horizon); on reconnect the realtime channel answers `requiresSync` /
   `catchup-required` and the recovery pull delivers bootstrap segments
   (fresh pin) rather than a long commit replay; the client converges and
   resumes cursor-contiguous deltas (§8.4, §4.7).

8. **Horizon-forced re-bootstrap.** The server prunes past an absent
   client's cursor (respecting the §4.6 retention floors); the returning
   client receives `reset`/`sync.cursor_expired`, discards its cursor,
   re-bootstraps, and converges — while a second client whose cursor is
   at the horizon boundary (`cursor = horizonSeq`) still pulls
   incrementally (§4.6 boundary condition).

9. **Bootstrap-seeded optimistic concurrency.** A fresh client
   bootstraps a table via segments only; its local row versions equal
   the server's. Without any commit delivery in between, a
   `baseVersion`-carrying upsert using the segment-delivered version
   applies cleanly, and a stale `baseVersion` yields
   `sync.version_conflict` with the current `serverVersion`/`serverRow`
   (§5.2, §5.6, §6.2).

10. **SQLite-image bootstrap.** (a) Equivalence: a client advertising
    `accept` bit 2 bootstraps an image-eligible table in a single pull
    (no paging, `bootstrapState` never emitted) and ends row-, value-
    and version-identical to a rows-lane control client, with
    incremental handoff at the pin (§5.3, §5.6, §4.7). (b) Descriptor
    shape and reuse: the sqlite `SEGMENT_REF` carries no
    `rowCursor`/`nextRowCursor`, and a second client with the same
    scopes at the same pin receives the **same** `segmentId` (server
    reuse, §5.3 determinism rule). (c) Integrity: corrupted image bytes
    fail the content address, abort per §1.4 rule 5 with
    `sync.invalid_request`, persist nothing, and the re-pull converges.
    (d) Capability gating: without bit 2 the same table bootstraps via
    paged rows segments (§4.2 negotiation). (e) Lane pinning: a
    bootstrap resumed mid-table stays on the rows lane even when the
    resuming pull advertises bit 2 (§5.3, §4.7).

11. **Sync rounds over the socket.** (a) Equivalence: a client syncing
    over the socket binding (§8.7) and a control client syncing over
    the transport binding end state-identical — rows, versions,
    cursors, outbox drained. (b) Registration at round end: a client
    that connects realtime BEFORE its first-ever pull, subscribes, and
    runs its first round over the socket receives subsequent deltas
    with no reconnect (the §8.1 silent-no-fanout footgun is
    structurally dead). (c) One round in flight: round bytes arriving
    while a response stream is in flight are not processed and drop
    the connection. (d) Interleaving: a commit landing during an
    in-flight round produces a text wake-up, never a mid-stream `0x00`
    message; deltas resume after the post-round ack (§8.2/§8.7).

12. **Signed-URL delivery.** (a) Issue→fetch→verify: a bit-3 client
    bootstraps through descriptor-carried URLs (native HMAC scheme) —
    every external segment is fetched from the URL host with no
    sync-server credentials attached, zero direct downloads, content
    addresses verified, state converged (§5.4). (b) Expiry: a URL
    already at `urlExpiresAtMs` is never fetched; the sync aborts with
    `sync.segment_expired` semantics, nothing persists, and a re-pull
    under a fresh TTL recovers (§5.4, §1.4 rule 5). (c) Tamper:
    corrupted bytes from the URL host fail the §5.1 content address
    with the named error and never fall through to the direct
    endpoint; the re-pull converges. (d) Gating: without bit 3
    descriptors carry no `url`/`urlExpiresAtMs`; with bit 3 they do
    (raw surface, §4.2). Delegated presign (S3/R2) is pinned by
    server-package tests against the S3 stub (§5.4 equivalence rule) —
    behaviorally indistinguishable to the client, so the pairing
    scenarios run the native scheme.

13. **Blobs / file attachments.** (a) Upload→reference→push→fetch: client
    A uploads a blob (`PUT /blobs/{blobId}`, content address verified),
    pushes a row whose `blob_ref` column references it, and client B —
    subscribed to the same scope — pulls the row and fetches the blob
    bytes on demand, converging on identical bytes; the blob never rides
    the pull stream (§5.9.3, §5.9.5, §5.9.7). (b) Push referencing a
    missing blob fails loud: a push whose row references a `blobId` never
    uploaded is `rejected` with `blob.not_found`, the commit rolls back
    whole, and no dangling reference enters the log (§5.9.6, §6.6). (c)
    Unauthorized fetch denied — the cross-scope probe: client C, holding a
    *different* scope, requests the same `blobId` (which C could learn
    from a leaked ref) and is denied with `blob.forbidden` because no
    row it may see references the blob; the blobId alone is never a
    capability (§5.9.5 authorization rule). (d) Revocation purges cache
    refs: when A's scope is revoked, the purge (§3.3) drops the blob-cache
    references for the purged rows and deletes the now-unreferenced cached
    body (evicted ≠ revoked, B2). (e) Cache hit avoids re-download: a
    second read of the same blob on the same client serves from the
    content-addressed cache without a network fetch — asserted via the
    harness blob-download counter (B1, §5.9.7). (f) Presigned download
    consumed: with the server configured for presigned blob URLs, a
    consumer's `fetchBlob` receives `{url, urlExpiresAtMs}` and fetches the
    bytes from the URL host with no sync-server credentials — the harness
    counts a CDN hop, **zero** authorized-endpoint byte downloads, content
    address verified (§5.9.5 always-issue). (g) Expiry → fresh-URL recovery:
    a download URL already at `urlExpiresAtMs` is never fetched; the client
    re-requests the authorized endpoint, which re-authorizes and mints a
    fresh URL, and the second attempt converges — no fall-through (§5.9.5
    recovery rule). (h) Presigned upload grant→PUT→reference→fetch: with the
    server configured for presigned uploads, the uploader obtains a grant
    (`POST /blobs/{blobId}/upload-grant`), PUTs the bytes direct to storage
    with no host auth, pushes the referencing row (the §5.9.6 existence check
    passes via HEAD), and another client fetches the bytes — the harness
    counts a direct-storage PUT, not a server upload (§5.9.3 grant flow). (i)
    Cache persistence across restart: a client uploads/fetches a blob, is
    closed and reopened on the SAME local database, and `fetchBlob` serves
    from cache with no network — the harness download counter proves the
    body survived the restart (B1 storage model). (j) LRU eviction respects
    refcounts/pins: with a small cache cap, staging bodies past the cap
    evicts zero-ref bodies in LRU order while a still-referenced body and a
    pending-upload-pinned body are retained (B1 cap + eviction). Both
    pairings (TS×TS, Rust×TS).

14. **CRDT fields / collaborative convergence.** A `crdt` column (§2.4 tag
    8) merged server-side (§5.10). (a) Concurrent-edit convergence, both
    orders: clients A and B each apply a distinct Yjs update to the same
    row's `crdt` column and push baseVersion-less (§5.10.3); after
    quiescence both local databases hold the **same merged bytes**, and the
    result is identical whichever push the server saw first (merger
    commutativity, §5.10.2). (b) crdt merge does not bump conflicts: neither
    baseVersion-less push produces a `sync.version_conflict` record — a crdt
    column never conflicts on its own account (§5.10.3). (c) baseVersion
    conflict on non-crdt columns still fires with the crdt column merged in
    the winner: A and B edit both a non-crdt column (from the same
    `baseVersion`) and the crdt column; the loser gets `rejected` /
    `sync.version_conflict` whose `serverRow` carries the **merged** crdt
    state, and after the loser rebases (§6.5) both converge. (d) Offline crdt
    edits replay idempotently (§2.3, §5.10.3): A accumulates offline crdt
    updates, reconnects, and replays FIFO — a dropped-ack retry delivers an
    update twice, and convergence is unaffected (idempotency-key `cached` +
    merger idempotency). Rust pairing (§5.10.5): the Rust client pushes
    **fixture Yjs update bytes generated by the TS side** and asserts the
    server-merged result equals the expected merged bytes — byte-level
    convergence with no Rust-side merge. Both pairings (TS×TS, Rust×TS).

15. **Auth leases / offline authorization.** The lease lifecycle (§7.3),
    feature enabled with a TTL. (a) Issued and refreshed on authorized
    rounds: an authorized round delivers a `LEASE` frame the client holds
    (`leaseId`, `expiresAtMs` = issuedAt + ttlMs); a later authorized
    round slides the **same** `leaseId` and extends the window (§7.3.2,
    §7.3.3, §7.3.5). (b) Outage-served then expired: with the live
    resolver in an outage (§7.3.3, a signal not a throw), an offline write
    applies under lease authorization; past the TTL the round fails
    request-level with `sync.auth_lease_required`, the client records the
    code in `leaseState` and stops-and-surfaces, no local data is purged
    (§7.3.4), the write stays queued, and recovery to a live resolver
    clears the error and drains the write (§7.3.5). (c) Revocation
    invalidates continued sync, not local data: the host revokes the
    lease, a leased round fails with `sync.auth_lease_revoked`, the synced
    rows survive (distinct from the §3.3 scope-revocation purge), and
    recovery mints a **fresh** lease id — the revoked handle never
    resurrects (§7.3.4). (d) Feature-off emits nothing: a server with no
    `leases` config never emits a `LEASE` frame and the client's
    `leaseState` stays empty (zero-config discipline, §7.3.3). Both
    pairings (TS×TS, Rust×TS); the Rust client treats the lease as opaque
    state (§7.3 non-goal 1).

16. **Presence (§8.6).** Ephemeral scope-keyed presence over the socket.
    (a) Two clients, same scope, full lifecycle: A and B register
    `project:p1` over the socket; A publishes a document → B observes a
    `join`; A republishes → B observes an `update`; A publishes `null` → B
    observes a `leave`; A publishes again then **disconnects** → B observes
    a `leave` (disconnect-implies-leave, §8.6.1); a late-joining C receives
    the snapshot join-burst of whoever is present (§8.6.4). (b) Cross-scope
    isolation — the privacy probe (§8.6.3): A holds `project:p1`, D holds
    only `project:p2`; A's publish on `p1` never reaches D, D's publish on
    `p2` never reaches A, and neither can publish onto the other's key
    (`presence.forbidden`) — no leakage to non-scope-mates on any lifecycle
    event. (c) Feature-off silence: a peer that never publishes and ignores
    `presence` events (the §8.1 tolerate-unknown path) is undisturbed —
    presence chatter among others changes nothing observable for it, and
    its own deltas/rounds are unaffected. (d) Survives a socket sync round:
    A is present on a key, interleaves a §8.7 round on the same connection
    (push + pull), and both its published presence and the presence it
    observes survive the round intact (presence state is independent of
    round state; the round's registration replace re-derives the same
    grant, §8.6.3). Both pairings (TS×TS, Rust×TS).

17. **Reconnect storm (§8.4).** ~20 sessions on the same scope connect,
    a burst of commits fans out, and all sessions churn (disconnect +
    reconnect) while the log advances; the hub stays correct under the
    fanout — every session ends registered exactly once (no leaked
    sessions in the set), each reconnecting session gets `hello` with the
    right `requiresSync`, behind sessions receive coalescible
    `catchup-required` wake-ups rather than gap deltas (§8.2), and after a
    recovery pull + ack every session converges to the server's rows. The
    scenario is deterministic (seam-observed readiness, no timers) and
    exercises the hub's per-connection accounting at N-session scale
    without a load harness. Both pairings (TS×TS, Rust×TS).

18. **Windowed sync (§4.8).** A client holds a partial replica keyed by
    window units (scope values), the family managed through `setWindow`.
    (a) **Widen bootstraps only the new unit**: a client windowed on
    `{p1}` widens to `{p1, p2}`; the p2 subscription fresh-bootstraps
    while p1's subscription and cursor are untouched — after sync, p2's
    rows are present, p1's cursor is unchanged, and the widen applied
    segment rows for p2 only (no re-download of p1, asserted on the
    bootstrap-rows-applied counter). (b) **Shrink evicts exactly the
    departed unit**: windowed on `{p1, p2}`, the client shrinks to
    `{p2}`; p1's rows are deleted, p1's subscription/cursor/effective-echo
    are discarded, p2's rows and every other unit are untouched, and the
    eviction emits an invalidation for the evicted table (I1). A live
    query over p1 re-runs and returns empty; the registry reports p1 as a
    window miss (oracle truthfulness) while p2 stays complete. (c)
    **Outbox pin defers eviction, drain completes it (E1/E4)**: with a
    pending offline write to a p1 row, shrinking `{p1, p2}→{p2}` keeps
    the pinned p1 row (and only it) local; after the write pushes and the
    outbox drains, the deferred eviction completes and the row is gone —
    while a still-pinned sibling p2 write is unaffected. (d)
    **Re-entry is a fresh bootstrap with writable versions (E2)**:
    evict p1, then re-enter `{p2}→{p1, p2}`; p1's subscription
    fresh-bootstraps, its rows and `server_version`s equal the server's,
    and an immediate `baseVersion`-carrying write on a re-entered row
    using the segment-seeded version applies cleanly (no commit delivery
    in between) — proving E2's "version from re-delivery only". (e)
    **Value-sharded replace touches only the delta**: `{p1, p2}→{p2, p3}`
    evicts p1, bootstraps p3, and leaves p2 entirely alone — p2's cursor
    unchanged and zero segment rows re-applied for p2 (the sharding proof;
    the naive "new window = re-download everything" cost is dissolved by
    the unit grain). (f) **Re-entry across a pruned horizon converges**:
    evict p1, advance and prune the server log past p1's old cursor, then
    re-enter p1; the fresh bootstrap (snapshotting current state, §4.7)
    converges with no dependence on the pruned log. (g) **Completeness is
    pending until bootstrap, and zero rows still complete**: immediately
    after `setWindow` registers new units, the oracle reports them
    registered but *pending* (not complete — the gap where a naive
    registry-membership verdict renders a false "empty" state); after the
    bootstrap round finishes, every unit is complete — including a unit
    with zero server rows (emptiness ≠ pendency). Throughout, the server
    is never told of any eviction and tombstones nothing (evicted ≠
    revoked — no `revoked` status, no server-side purge). Both pairings
    (TS×TS, Rust×TS).
