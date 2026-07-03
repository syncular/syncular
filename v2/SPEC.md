# Syncular Protocol Specification (v2) — DRAFT

Status: **B1 — full normative text, golden vectors generated.** This document
is normative: implementations conform to this spec and the golden vectors in
`spec/vectors/`; divergence is an implementation bug. A change to wire
format or semantics requires a version bump per §9 and updated vectors in
the same commit.

Audience: implementers (human and agent) building a client or server
**without access to the v1 source tree**. Everything needed to interoperate
is in this document plus the golden vectors.

Source material: extracted from the 0.1.x implementation (SSP1, wire v14) —
`../packages/core/src/sync-packs.ts` (encoder ground truth),
`../packages/core/src/snapshot-chunks.ts` (binary-table-v1 and artifact
manifests), `../packages/core/src/schemas/sync.ts` (request shapes),
`../packages/server/src/{push,pull,prune,auth-leases}.ts` and
`subscriptions/resolve.ts` (semantics), `../packages/core/src/error-responses.ts`
(error catalog), `../tests/load/lib/ssp1.js` (independent reader). Semantics
were extracted, not code. Where a v1 semantic is kept byte- or
rule-identical this document says **"unchanged from v1"** explicitly.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

---

## Conventions and primitive encodings

All multi-byte integers are **little-endian**. There are no varints
anywhere in this protocol; every integer field is fixed-width (unchanged
from v1 — fixed offsets keep independent readers trivial and the cost is
absorbed by transport compression, §1.3).

| Primitive | Encoding |
|---|---|
| `u8` | 1 byte unsigned |
| `u16` | 2 bytes unsigned LE |
| `u32` | 4 bytes unsigned LE |
| `i32` | 4 bytes signed two's-complement LE |
| `i64` | 8 bytes signed two's-complement LE. Values MUST be within ±(2^53−1); a reader MUST reject values outside that range (JS safe-integer contract, unchanged from v1) |
| `f64` | 8 bytes IEEE-754 binary64 LE |
| `bool` | `u8`, `0x00` = false, `0x01` = true; any other byte is a decode error |
| `str` | `u32` byte length + UTF-8 bytes. One string encoding only (v1's dual string16/string32 is dropped). Bytes that are not well-formed UTF-8 are a decode error |
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

## 0. Deliberate simplifications vs wire v14 — decisions

Each candidate from the B1 checklist, decided. The six perf/architecture
items added 2026-07-02 were pre-approved directionally; they are spec'd
concretely below and in the referenced sections.

- [x] **Single self-describing envelope; drop optional-section variance.**
      DECISION: **change.** SSP1 accumulated eight wire revisions of
      `opt()` markers around whole response regions. SSP2 has one 8-byte
      header and a flat frame sequence (§1.2); a section is present iff its
      frame is present, and every frame is length-prefixed. Option bytes
      survive only for semantically nullable *fields*. This kills the
      "version 7–14 drift" class of bug: there is nothing optional about
      the structure itself.

- [x] **Unify snapshot chunks vs artifacts into one "bootstrap segment".**
      DECISION: **change.** v1 grew two parallel systems (gzip row chunks
      with manifests + scoped SQLite artifacts) with two cache keys, two
      download endpoints, and a schema-level mutual-exclusion rule. v2 has
      one concept — the **segment** (§5): content-addressed, scope-bound,
      with a `mediaType` of `rows` or `sqlite`. One descriptor, one
      download endpoint, one auth story, one cache key.

- [x] **Compression moves to the transport.** DECISION: **change**
      (pre-approved). Envelope and segment bytes travel raw; HTTP responses
      use `Content-Encoding` (zstd preferred, gzip required fallback), and
      segment downloads likewise (§1.3). Clients use native decompression
      (`DecompressionStream` / fetch built-ins); no decompression code
      ships in the client bundle. Segment **content addresses are computed
      over uncompressed bytes**, so at-rest compression is a private
      server/storage concern and never visible on the wire.

- [x] **Streaming-friendly framing.** DECISION: **change** (pre-approved).
      The frame grammar (§1.2) is strictly sequential: `SUB_START …
      COMMIT/SEGMENT frames … SUB_END`, each frame length-prefixed, rows
      segments internally split into self-delimiting blocks (§5.2). A
      server MUST be able to encode a response without buffering it whole;
      a client MUST be able to apply commit and segment frames as they
      arrive. §1.4 specifies the exact state a streaming reader needs.
      (v1 decoded whole packs; 500k-row bootstrap paid 2.07 s of
      sequential fetch→decode→apply.)

- [x] **Schema-known encoding is mandatory.** DECISION: **change**
      (pre-approved). All server→client row data (commit change payloads
      and rows segments) is encoded by codecs **generated from the schema
      IR** (§2.4). Runtime column inference does not exist in v2 (v1's
      generic path paid +46 % encode overhead). Segments still carry a
      compact column descriptor table — not for inference, but as a
      checksum the receiver validates against its generated schema, and so
      independent tooling can decode segments (the ssp1.js lesson).
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

- [x] **Signed-URL segment delivery.** DECISION: **change** (pre-approved).
      Segment descriptors MAY carry a short-lived signed URL; authorization
      happens at URL issuance (inside the pull, where effective scopes were
      just resolved). §5.4 specifies the descriptor fields, the native
      HMAC token claims (`v`, `seg`, `sd`, `aud`, `exp`), and the
      delegated-presign (S3/R2) equivalence rule. The direct download
      endpoint remains as fallback and re-authorizes on every request
      (§5.5) — the v1 "scopes query param lesson" is now a MUST.

- [x] **SQLite-image segments are the premier bootstrap format.**
      DECISION: **change** (pre-approved). `mediaType = sqlite` (§5.3) is
      the default bootstrap path servers SHOULD produce and clients SHOULD
      prefer (v1 evidence: 204 ms vs 467 ms at 100k rows). Rows segments
      (`mediaType = rows`, §5.2) remain the mandatory-to-implement
      fallback; inline rows segments cover small tables without a second
      round-trip.

- [x] **Pruning horizon is normative.** DECISION: **change**
      (pre-approved). The server maintains a per-partition `horizonSeq`
      (§4.6). A pull whose cursor is behind the horizon gets subscription
      `status = reset` with reason code `sync.cursor_expired` (new code,
      category `reset-required`, action `rebootstrap`) and MUST
      re-bootstrap. Retention floors (≥1000 newest commits, 14-day active
      window, 30-day age force) are normative minimum-behavior, not code
      folklore.

- [x] **Error envelope: keep the shape, prune the codes.** DECISION:
      **change.** The shape (`code`, `category`, `retryable`,
      `recommendedAction`, `message`, `details?`) is unchanged from v1.
      The wire catalog (§10) is pruned from 63 codes to 21: client-local
      codes (`worker.*`, `storage.*`, `runtime.*`, `sync.offline`,
      `sync.transport_failed`) are out of protocol scope; `console.*`,
      `proxy.*`, `blob.*` and the seven `sync.auth_lease_*` codes belong to
      post-gate extensions and are *reserved*, not specified.

- [x] **Realtime: one delta kind + one wake-up kind.** DECISION:
      **change.** Binary deltas are ordinary SSP2 response messages pushed
      over the socket (no separate delta format); the only other
      data-plane server message is the JSON `sync` wake-up with exactly
      three reason codes (§8.3). v1's legacy variants
      (`payload-too-large`/`server-wakeup`/`reconnect-catchup`/
      `resync-required` overlap) collapse into `delta-too-large`,
      `catchup-required`, `reset-required`.

- [x] **Canonical JSON debug rendering.** DECISION: **keep** (specified in
      §11). Non-contractual for the wire; contractual for golden vectors —
      so tooling that rots fails CI instead of rotting silently.

- [x] **Explicit forward-compat rule.** DECISION: **change** (adopt).
      Unknown frame types MUST be skipped via their length prefix (§1.2,
      §9). Record layouts inside a frame are fixed per wire version —
      fields are never appended to existing frames; new data means a new
      frame type.

Two v1 features are **removed from the core wire** (not simplified —
removed), both accreted in wire v10–v13:

- [x] **Commit-chain integrity metadata** (`partitionId` /
      `previousChainRoot` / `commitChainRoot`, `verifiedRoot` request
      field) — dropped. It exists to serve verification features that are
      post-gate non-goals; frame type `0x17` is reserved for its return.

      > RESOLVED (Benjamin, 2026-07-02): approved — dropped from the v2
      > core wire. Frame `0x17` stays reserved; when verified history
      > returns at the parity ladder, the request-side `verifiedRoot`
      > companion will also need a new frame slot.

- [x] **CRDT state-vector hints** (`crdtStateVectors`) — dropped; CRDT is
      a named skeleton non-goal. Frame-level room is reserved (§9).

Two smaller cuts, recorded here because they change request shapes:

- [x] **`dedupeRows` request flag** — dropped. Big-gap catch-up prefers
      segments (§8.4), which makes the dedupe mode's payload savings moot,
      and it removes a whole response-shape variant. It was also a
      correctness wart: v1's dedupe path regrouped only the latest change
      per row into synthetic commit objects, so clients could observe
      partial commits — violating the commit-atomicity spine (§6.4).

      > RESOLVED (Benjamin, 2026-07-02): approved — dropped.

- [x] **Commit `createdAt` becomes epoch-ms `i64`** (v1: ISO-8601 string).
      Cheaper, fixed-width, no timezone ambiguity. The JSON rendering
      (§11) shows it as a number.

- [x] **Scope values are always lists on the wire.** v1 preserved a
      `string | string[]` distinction through intersection and echo. v2
      canonicalizes to `list(str)` everywhere (§3.2); a single value is a
      one-element list. Same semantics, one shape.

---

## 1. Transport bindings and envelope

### 1.1 Endpoints

A server mounts three routes under a host-chosen prefix `<mount>`:

| Route | Method | Purpose |
|---|---|---|
| `<mount>/sync` | POST | Combined push+pull (§4, §6). Request and response bodies are SSP2 envelopes |
| `<mount>/segments/{segmentId}` | GET | Bootstrap segment download, direct-serve fallback (§5.5) |
| `<mount>/realtime` | GET (WebSocket upgrade) | Realtime channel (§8) |

Content type for SSP2 bodies is `application/vnd.syncular.sync.v2`. A
server MUST reject a `<mount>/sync` request with any other content type
with HTTP 415.

**Authentication is host-provided and out of protocol scope.** The host's
`authenticate(request)` runs on every HTTP request and WebSocket upgrade;
its result supplies `actorId` and the partition. The protocol carries no
credential fields. (Auth-lease replay is a reserved extension, §7.3.)

**Errors at HTTP level** (auth failure, malformed envelope, rate limits —
anything detected before a 200 status is committed) are returned as JSON
(`application/json`) with the error shape of §10.1 and an appropriate HTTP
status. Errors detected *after* streaming has begun are delivered in-band
via the `ERROR` frame (§1.2). Unchanged from v1 in spirit: error responses
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
tool classify a body by reading 8 bytes (the ssp1.js lesson). A reader
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
   (`0x17`, `0x18`, `0x20`–`0x2F`) have no layout in wire version 1 and
   are therefore unknown — skippable, not errors — until a future
   version assigns them one. Skipping means "do not interpret", never
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
buffering; v1's 295–400 MB steady-state during large bootstraps is the
anti-goal). Clients SHOULD apply frames as they arrive. The complete state
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
PUSH_RESULT × N                 one per PUSH_COMMIT, in request order
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
| `requiredSchemaVersion` | `opt(i32)` | If present, the client's `schemaVersion` is no longer served; the client MUST stop syncing and surface an upgrade requirement (`sync.client_schema_unsupported` semantics). Unchanged from v1 |
| `latestSchemaVersion` | `opt(i32)` | Informational: newest schema version the server knows. MUST NOT block syncing. Unchanged from v1 |

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
  commit; all changes in the commit share it. Unchanged from v1.
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
| `op` | `upsert` or `delete` — the only two operations (unchanged from v1) |
| `row` | The full row payload after the write (absent for `delete`) |
| `rowVersion` | The row's `server_version` after the write (absent for `delete`) |
| `scopes` | The stored scope values extracted from the row (§3.1) |

Every synced row carries a **`server_version`** (`i64`, ≥ 1): starts at 1
on insert, increments by exactly 1 on every applied upsert. It is the
optimistic-concurrency token for `baseVersion` conflict detection (§6.2).
Unchanged from v1.

**Scope migration** (a row's scope column changes value): the server MUST
emit, in the same commit, a `delete` change tagged with the old scope
values and an `upsert` tagged with the new ones, so subscribers of the
old scope remove the row and subscribers of the new scope receive it.
Unchanged from v1.

### 2.3 Idempotency identity

The idempotency key for a push commit is the triple
**(partition, `clientId`, `clientCommitId`)**. A server MUST persist the
full commit result before acknowledging, and a replay of the same key
MUST return the persisted result byte-equivalent: an
originally-`applied` commit is returned with `status = cached`; an
originally-`rejected` commit is returned with `status` still `rejected`
(§6.3). `cached` means "this already applied — you may have missed the
ack"; a rejection replays as itself. Exactly-once apply per client
commit; at-least-once delivery of results. Unchanged from v1.

### 2.4 Schema IR and the generated row codec

Column types (shared by the row codec and rows segments; tags on the wire):

| Tag | Type | Value encoding |
|---|---|---|
| `1` | `string` | `str` |
| `2` | `integer` | `i64` |
| `3` | `float` | `f64` |
| `4` | `boolean` | `bool` |
| `5` | `json` | `str` containing a JSON document (raw string preserved on round-trip, see Conventions) |
| `6` | `bytes` | `bytes` |

Unchanged from v1's binary-table-v1 tag assignment.

For every synced table, codegen (B5) emits from the schema IR, for both
sides, a **row codec** for each supported `schemaVersion`:

- Columns are encoded **positionally in schema-IR declaration order** —
  no names, no tags on the wire.
- A row is: a null bitmap of `ceil(columnCount / 8)` bytes (bit `i` set =
  column `i` is NULL; LSB-first within each byte, byte `i/8` — unchanged
  from v1), followed by the non-null values in column order, each encoded
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

---

## 3. Scopes and authorization

**Unchanged from v1 — semantics ported verbatim.** Scopes are the crown
jewels of the design; nothing in this section is simplified except the
wire shape of scope values (always lists, §0) and one fail-loud
tightening: `'*'` is rejected in *requested* scopes (§3.2).

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
  value) so pulls filter by scope without scanning (a v2 storage-schema
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
   reserved for allowed scopes (v2 tightening — in v1 a requested `'*'`
   passed through and then matched only rows whose stored value was
   literally `*`, a silent-empty-data footgun).
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

### 3.3 Revocation and the purge contract

When `SUB_START.status = revoked`:

- The server sends no commits and no segments for the subscription;
  effective scopes are echoed as an empty map; `nextCursor` in `SUB_END`
  echoes the request cursor unchanged.
- The client MUST stop pulling the subscription and MUST purge local rows
  belonging to it: delete rows whose generated local scope columns match
  the **last effective scopes** echoed in `SUB_START` while the
  subscription was active — the client MUST persist those per
  subscription for exactly this purpose (unchanged from v1). Requested
  values that never became effective are not purged: the grant being
  revoked is the effective one, and local-only rows outside it are not
  the server's to destroy.
- **Fail closed**: if the client's generated schema has no local
  scope-column mapping for the table, the client MUST NOT clear the whole
  table as an approximation; it MUST surface `sync.scope_revoked` as a
  fatal configuration error and stop syncing the table. (Unchanged from
  v1 doctrine: precision or nothing.)
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

### 3.4 Write-path authorization

On every push operation (semantics unchanged from v1):

1. The server resolves allowed scopes for the actor (same
   `resolveScopes`). In v2 the result is resolved at most once per
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
each opens a cross-scope write that v1 forbids.

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
interpreted, by the server. Unchanged from v1.

### 4.2 `PULL_HEADER` frame

| Field | Type | Semantics |
|---|---|---|
| `limitCommits` | `i32` | Max changes across returned commits per subscription. Server clamps to [1, 1000]; `0` = server default (1000) |
| `limitSnapshotRows` | `i32` | Bootstrap page size in rows. Server clamps to [1, 50000]; `0` = default (1000) |
| `maxSnapshotPages` | `i32` | Max bootstrap pages materialized per pull. Server clamps to [1, 50]; `0` = default (4) |
| `accept` | `u8` bitmask | Segment delivery capabilities: bit 0 = inline rows segments, bit 1 = external rows segments, bit 2 = sqlite segments, bit 3 = signed URLs; bits 4–7 MUST be 0 (a set unknown bit is a decode error). A client MUST set at least bits 0 and 1 (rows support is mandatory) |

Defaults and clamp ranges are the v1 values; the clamp is silent (the
response reflects the clamped behavior, not an error). **Deliberate
change from v1:** `limitCommits` counts *changes*, not commits — v1
bounded the number of commits scanned, which left response size
unbounded for large commits. The limit is where the server stops adding
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
capability sends `accept = 0b0011` (inline + external rows) — the
reference client's default. The mask is also a client-side contract: a
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
a streaming reader can apply commit-by-commit; v1's per-pack scope
dictionaries and the dual inline-JSON/row-group representation are gone —
one representation, with transport compression absorbing the repetition.

**Cursor advancement.** `nextCursor = max(request cursor, highest
commitSeq scanned)` — the cursor advances even when no matching changes
exist in the window (unchanged from v1; this is what makes quiet
subscriptions cheap). If the change limit truncated the window,
`nextCursor` is the last fully delivered `commitSeq`; the client observes
`nextCursor < latest` only implicitly by pulling again — there is no
`hasMore` flag (unchanged from v1). Clients SHOULD pull again immediately
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
  (Defaults are the v1 values; hosts may raise any of them.)
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

Bootstrap is **resumable, pinned, and paged** (mechanics unchanged from
v1):

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
  table is exhausted, which is the completion signal.
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

**Phases.** v1's client had named bootstrap phases (critical /
interactive / background). v2 does not encode phases in the protocol:
subscription order in the request is the priority order, responses echo
it (§1.6), and a client achieves phasing by pulling critical
subscriptions first (even in a separate request) before enqueueing the
rest. DECISION (recorded): phases are client policy, not wire state —
one less coupled enum, same capability.

---

## 5. Bootstrap segments

One concept replaces v1's chunks + artifacts (§0): the **segment** — an
immutable, content-addressed, scope-bound container of snapshot rows for
one table at one `asOfCommitSeq`.

### 5.1 Identity, integrity, caching

- **`segmentId` = `"sha256:"` + lowercase-hex SHA-256 of the segment's
  uncompressed bytes.** Content addressing makes segments immutable,
  dedupable across clients with identical effective scopes, and safely
  CDN-cacheable.
- A client MUST verify the hash of downloaded segment bytes against the
  `segmentId` before applying, and reject on mismatch
  (`sync.integrity_rejected` is *not* in the v2 catalog — the client
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
| `rows` | bytes | `rowCount` consecutive rows in row-codec encoding (§2.4: null bitmap + positional values) |

Encoders SHOULD target blocks of ~1000 rows or ~256 KiB, whichever comes
first. Blocks make the format streamable: a reader applies each block in
one local transaction as it completes, holding only (header state +
current partial block) in memory — this is the §1.4 requirement carried
into segment application. The end marker (`rowCount = 0`) is mandatory;
a segment that ends without it is truncated.

**Error codes.** Structural decode failures of a rows segment — bad
magic, unsupported `formatVersion`, non-zero flags, reserved column
flag bits, an unknown column type tag, a block whose rows do not consume
exactly `byteLength`, row-codec violations (§2.4), truncation, a missing
end marker, or trailing bytes after it — are `sync.invalid_request`.
`sync.schema_mismatch` is reserved for the column-table-vs-generated-
schema comparison above, which only the receiver can perform: a
standalone segment decode (tooling, vectors) never produces it.

### 5.3 SQLite segments (`mediaType = sqlite`) — premier path

The segment bytes are a complete, well-formed **SQLite database file**
containing:

- one table named as the target table, with the schema-IR columns, holding
  exactly the snapshot rows; and
- a metadata table `_syncular_segment` with a single row:
  `(format INTEGER = 1, "table" TEXT, schemaVersion INTEGER,
  asOfCommitSeq INTEGER, scopeDigest TEXT, rowCount INTEGER,
  rowCursor TEXT NULL, nextRowCursor TEXT NULL, isFirstPage INTEGER,
  isLastPage INTEGER)` — the descriptor duplicated inside the file so a
  segment at rest is self-describing.

Clients import via ATTACH + `INSERT INTO … SELECT` or direct image adoption
where the whole local table is being replaced (near file-copy speed in
sqlite-wasm; the v1 artifact lane's 204 ms vs 467 ms at 100k rows is the
motivating number). A client MUST validate `_syncular_segment` against
the descriptor before applying. Servers SHOULD produce sqlite segments as
the default bootstrap path when the client advertises support
(`accept` bit 2); rows segments remain the fallback for clients that
don't.

**Skeleton status (B2).** The reference server does not yet *generate*
sqlite segments — production is the SHOULD above; rows segments and
`SEGMENT_INLINE` are the mandatory paths (§5.2, §5.7). Descriptors,
segment stores, and the download endpoint MUST nevertheless carry and
accept `mediaType = sqlite` (§5.4), so the premier path lands later
without a wire or interface change.

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

Download resolution order: a client with a fresh `url` SHOULD fetch it
directly (zero sync-server egress); on a missing/expired/failed `url` it
MUST fall back to `GET <mount>/segments/{segmentId}` (§5.5). A client
MUST NOT retry a signed URL after `urlExpiresAtMs`; it re-pulls or falls
back instead.

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
is behaviorally indistinguishable to the client.

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
  resolution failure ⇒ HTTP 403 `sync.forbidden`. This is the v1
  "scopes query param lesson" as a MUST: a segment reference obtained
  earlier is not a bearer capability; only signed URLs are (deliberately,
  with short TTL).
- Unknown segment ⇒ HTTP 404 `sync.not_found`; known-but-expired
  segment ⇒ HTTP 404 `sync.segment_expired` (§10.2 — the retryable one:
  re-pulling mints fresh descriptors).
- Response headers: `Content-Type: application/octet-stream`,
  `ETag: "<segmentId>"`, `Cache-Control: private, max-age=0`,
  `Vary: Authorization, X-Syncular-Scopes`. `If-None-Match` with a
  matching ETag returns 304. `Content-Encoding` per §1.3.

### 5.6 Segment application contract (client)

- Segments for a table replace-or-upsert: the client applies rows by
  primary key (`INSERT OR REPLACE` semantics). On the **first page** of
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
- Rows-segment blocks and sqlite-segment imports are applied
  transactionally per §1.4/§5.2; the resume token is persisted only at
  `SUB_END`, so a crash mid-segment resumes conservatively (re-applying a
  block is safe by upsert idempotency).
- **Segment rows have no server version** (SSG2 carries none, §5.2; the
  sqlite metadata table stores no per-row versions either, §5.3). A
  client MUST NOT synthesize a `baseVersion` from a segment-applied
  row; until a `COMMIT` change (§4.5) or a conflict record (§6.3)
  supplies the row's `server_version`, optimistic-concurrency pushes
  for it need an app-supplied version or fall back to last-write-wins
  (§6.2).

### 5.7 `SEGMENT_INLINE` frame

Payload = one complete rows segment (§5.2, including magic). A payload
that is not a structurally valid rows segment is a decode error
(`sync.invalid_request`, per §5.2's error-code rule; the column-table
schema check remains the receiver's, and the raw payload bytes are
preserved for re-encoding like any other binary field). Servers
SHOULD inline segments smaller than 256 KiB (uncompressed) to avoid a
second round-trip for small tables; servers MUST NOT inline sqlite
segments. Semantics are identical to a referenced rows segment.

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

Unchanged from v1:

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
| `commitSeq` | `opt(i64)` | Present for `applied` and `cached`; absent for `rejected` — deliberate change from v1, which sometimes echoed the rolled-back sequence number (a rejected commit is invisible to pulls, so its number means nothing to clients) |
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

Semantics (unchanged from v1):

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
  after it were never attempted). Unchanged from v1.
- A `clientCommitId` duplicated **within one request** is processed once;
  subsequent occurrences return the persisted result per the replay rule
  (§2.3): `cached` if it applied, `rejected` if it rejected.

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

The protocol reports conflicts; resolution is app policy (unchanged from
v1). The client contract:

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

---

## 7. Offline writes and replay

### 7.1 The outbox

- Local writes are recorded as commits in a durable **outbox** with
  client-generated `clientCommitId`s (unique forever per client; UUIDs
  recommended).
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
  retries); rows its upserts targeted that exist **only optimistically**
  (created by local writes, never confirmed by any server-delivered row
  or segment) MUST be deleted — the §7.1 replay re-establishes any that
  later pending commits still write. Rows the commit merely overwrote
  keep their stale-optimistic content until the pull half delivers the
  server row — for a conflict, the record's `serverRow` (§6.3) lets the
  app resolve without waiting. A rejected `delete` leaves the row
  locally absent until the server re-delivers it (a later change or a
  re-bootstrap): surfacing the rejection is the client's job; restoring
  the row is app policy.
- Push and pull SHOULD ride the same combined request (§1.5): a replaying
  client gets its own changes back in the pull half, converging in one
  round-trip.

### 7.3 Auth leases — reserved extension

Offline-write authorization leases (v1: ES256 JWS tokens,
`syncular-auth-lease+jws`, with per-scope operation grants, clock-skew
windows, and replay-time re-validation) are a **post-gate extension**
(REVISE rule 3) and not part of core conformance. Reserved for it: the
seven `sync.auth_lease_*` error codes (§10.3) and an `authLease` field
slot in a future `PUSH_COMMIT` revision (new frame type per §9). The v1
semantics — signature + expiry validation, schema-version binding, scope
coverage check at replay, current-scope re-resolution (revocation beats
the lease) — are the porting baseline when the extension lands. Until
then: a server that requires lease provenance simply rejects offline
replays with `sync.auth_required`.

---

## 8. Realtime

### 8.1 Channel and handshake

WebSocket at `GET <mount>/realtime?clientId=<id>`. Host authentication
runs at upgrade; the server resolves the actor's effective scopes for the
client's known subscriptions and registers the connection against the
matching scope keys.

**Where "known subscriptions" come from:** the subscription list (ids,
tables, requested scopes) of the client's most recent HTTP pull. Servers
MUST persist that list per (partition, `clientId`) when processing a
pull — alongside the cursor record of §4.5 — and load it at WebSocket
upgrade (unchanged from v1 mechanics). A client that has never pulled
has no registered subscriptions: it receives `hello` with
`requiresSync: true` and no deltas until a pull registers them.
Registrations are **fixed for the life of the connection**: a pull that
changes the subscription list takes effect at the next connect, not
mid-session.

Control messages are JSON text frames; deltas are binary frames
containing a complete SSP2 **response** message (§1.6) — one envelope
grammar for HTTP and socket (§0 decision). A binary frame is recognized
by the SSP2 magic; a client MUST tolerate and ignore unknown JSON control
events (forward compat mirror of the frame-skip rule). "Unknown" is
scoped to the **event name**: a JSON object whose `event` value is not
defined by this section is tolerated, never a parse error. A *known*
event whose `data` is missing or of the wrong shape is malformed — a
parse error, not a tolerated variant. Direction is carried by the
discriminator key: server→client events carry `event`; client→server
control messages carry `type` (§8.2).

Server → client on connect:

```json
{"event":"hello","data":{"protocolVersion":1,"sessionId":"…",
 "actorId":"…","clientId":"…","cursor":<lastAckedCursor>,
 "latestCursor":<serverLatest>,"requiresSync":<bool>,"timestamp":<ms>}}
```

`requiresSync: true` ⇒ the client MUST run an HTTP pull before trusting
the socket for continuity.

### 8.2 Delta delivery and acks

- After a commit, the server pushes to each registered connection whose
  effective scopes match any of the commit's stored scope keys a binary
  delta: an SSP2 response containing, per affected subscription,
  `SUB_START` / `COMMIT`(s) / `SUB_END` with the advanced `nextCursor`.
- Deltas MUST be cursor-contiguous per connection: a delta starting past
  the client's last delivered cursor is forbidden — the server sends a
  wake-up (§8.3) instead when it cannot bridge the gap. A per-connection
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
  applied `SUB_END.nextCursor` in it. After an HTTP pull while the
  connection is live, the client acks the minimum cursor across its
  active, non-bootstrapping subscriptions that have synced at least
  once — the contiguity-safe floor, and the ack that lifts the
  reference server's delta suppression after a catch-up pull. No such
  subscription, no ack.
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
| `delta-too-large` | The delta exceeded message limits | HTTP pull |
| `catchup-required` | Gap not bridgeable from the replay buffer (reconnect, drops, flow control) | HTTP pull |
| `reset-required` | Server-declared discontinuity (schema rollover, horizon, forced resync) | HTTP pull; expect `reset`/`requiredSchemaVersion` there |

Wake-ups are idempotent and coalescible; the client MUST treat any
wake-up as "run a pull soon", never as data.

The three reason strings are a **closed set**: a `sync` event whose
`reason` is not one of them is malformed (a parse error under §8.1's
known-event rule), not an unknown-event case. Forward compatibility for
the realtime channel means new *event* names (tolerated per §8.1),
never new reason strings on an existing event.

### 8.4 Reconnect and catch-up

- Client reconnect uses exponential backoff (suggested: initial 1 s, ×2,
  cap 30 s) **with jitter**; after `hello.requiresSync` or any wake-up,
  the client MUST apply jitter (suggested uniform 0–2 s, host-tunable)
  before the recovery pull. Jittered coalescing is normative-SHOULD
  because reconnect storms are a first-class design input (v1 WP-32
  evidence: 13 ms server fanout, ~2 s client-side wake-contention tail at
  250+ clients).
- Multiple wake-ups and local triggers MUST coalesce into one pull.
- **Scheduling is host policy.** Timers — reconnect backoff, wake
  jitter, when the coalesced pull actually runs — live in the app
  shell, not the protocol core. The core exposes one coalesced
  **sync-needed signal**: set by `hello.requiresSync`, by every
  wake-up, and by every client-side delta drop (§8.2); cleared when a
  pull round *begins*, so a wake-up landing mid-round survives the
  round and triggers another pull.
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

### 8.6 Presence — reserved extension

Scope-keyed ephemeral presence (join/leave/update/snapshot keyed by
(actor, client) per scope key, v1 semantics) is a post-gate extension.
Reserved for it: the `presence` JSON event name in both directions and
binary frame types `0x20`–`0x2F`. Core conformance ignores presence
events (per the unknown-control-event rule, §8.1).

---

## 9. Versioning and evolution

- **Wire version** (`u16` in the envelope): incremented for any change to
  frame layouts, record fields, primitive encodings, or frame grammar.
  Readers reject unknown versions (§1.2). There are no minor versions:
  vectors pin exact bytes.
- **Frame types are append-only**: new capabilities are new frame types;
  existing frame payload layouts are frozen per wire version. Unknown
  frame types are skipped by length — so a v1-wire reader survives a
  server that emits optional new frames, and features can ship without a
  version bump when ignoring them is safe. If ignoring a frame is *not*
  safe, that is by definition a wire-version bump.
- **Segment format version** (`u16` in SSG2) evolves independently under
  the same rules; the `mediaType` byte in descriptors names formats, so
  new media types are additive.
- **Schema versioning** (application-level, unchanged from v1):
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
by this table — clients MAY hardcode them. (Shape unchanged from v1.)

Recommended actions: `refreshAuth`, `checkPermissions`, `fixRequest`,
`resetClientId`, `regenerateClient`, `upgradeClient`, `resolveConflict`,
`rebootstrap`, `forceResync`, `retryLater`, `splitBatch`,
`inspectServer`.

### 10.2 Codes (wire version 1)

| Code | Category | Retryable | Action | Produced when |
|---|---|---|---|---|
| `sync.auth_required` | auth-required | yes | refreshAuth | Host authentication absent/failed (HTTP 401; WS close) |
| `sync.forbidden` | forbidden | no | checkPermissions | Write-path scope denial (§3.4); segment scope-digest mismatch (§5.5); `resolveScopes` threw on a write |
| `sync.invalid_request` | invalid-request | no | fixRequest | Malformed envelope/frame, bad content type, missing required fields |
| `sync.invalid_client_id` | invalid-request | no | resetClientId | `clientId` bound to a different actor (§1.5) |
| `sync.invalid_subscription` | invalid-request | no | fixRequest | Duplicate subscription id; undeclared scope key (requested **or** resolved — §3.2) |
| `sync.empty_commit` | invalid-request | no | fixRequest | `PUSH_COMMIT` with zero operations |
| `sync.unknown_table` | schema-mismatch | no | regenerateClient | Subscription (request-level) or push operation (commit-level, §1.7) names a table the server doesn't handle |
| `sync.row_missing` | not-found | no | forceResync | Upsert with `baseVersion ≠ 0` targeting an absent row (§6.2) |
| `sync.version_conflict` | conflict | no | resolveConflict | `baseVersion` mismatch (§6.2) — appears as a conflict result, not a request error |
| `sync.constraint_violation` | invalid-request | no | fixRequest | Server-side data constraint (unique/FK/not-null) rejected the write |
| `sync.missing_scopes` | internal | no | inspectServer | Handler emitted a change without stored scopes (§3.1) |
| `sync.idempotency_cache_miss` | internal | yes | retryLater | Cached push result unreadable on replay (§6.3) |
| `sync.too_many_operations` | invalid-request | no | splitBatch | Push exceeds the operation cap (§6.1) |
| `sync.not_found` | not-found | no | forceResync | Unknown segment id (§5.5) or sync resource |
| `sync.segment_expired` | not-found | yes | retryLater | Segment TTL elapsed (§5.1); re-pull mints fresh descriptors — *new in v2* |
| `sync.cursor_expired` | reset-required | no | rebootstrap | Cursor behind the pruning horizon (§4.6) — *new in v2*; delivered as `SUB_START` reason code |
| `sync.scope_revoked` | scope-revoked | no | checkPermissions | Subscription revoked (§3.3) — delivered as `SUB_START` reason code |
| `sync.rate_limited` | rate-limited | yes | retryLater | Request or connection rate cap |
| `sync.schema_mismatch` | schema-mismatch | no | regenerateClient | Generated client artifacts incompatible with the server (e.g., segment column-table mismatch, §5.2) |
| `sync.client_schema_unsupported` | schema-mismatch | no | upgradeClient | `schemaVersion` below the server floor (accompanies `requiredSchemaVersion`) |
| `sync.websocket_connection_limit` | rate-limited | yes | retryLater | Realtime connection cap (global or per client) |

### 10.3 Pruned and reserved codes

Removed from the wire catalog (v1 had 63 codes): all client-local codes
(`sync.offline`, `sync.transport_failed`, `storage.*`, `worker.*`,
`runtime.*`) — client SDKs may keep such codes internally but they are
not protocol; `sync.integrity_rejected`, `sync.websocket_not_configured`,
and `sync.unsupported_operation` (no v2 producer — the wire `op` byte
admits only upsert/delete and v2 defines no per-table operation
restriction; reserved if such a capability lands); `console.*`,
`proxy.*`, `blob.*` (post-gate features).
**Reserved** (must not be reused for other meanings): the seven
`sync.auth_lease_*` codes (§7.3).

---

## 11. Canonical JSON debug rendering

**Non-contractual for the wire; contractual for golden vectors.** No
implementation may parse JSON renderings in production paths; every
implementation SHOULD ship a `render(bytes) → json` developer tool, and
the vectors CI keeps it honest (the lesson of v1's silently-broken
tooling).

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
   "table":…,"schemaVersion":…,"columns":[…],"blocks":[[…rows as
   objects…]]}` with rows as name→value objects (names from the column
   table; columns as `{"name":…,"type":…,"nullable":…}` with the type
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
[`spec/vectors/README.md`](spec/vectors/README.md): for each case a
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
| 16 | `segment/rows-two-blocks` | SSG2 with two row blocks + end marker, all column types, nullable columns |
| 17 | `realtime/wake` + `realtime/hello` | JSON control vectors (`.json` only — no binary form) |
| — | `request/invalid/*` | Truncated envelope (no END), bad magic, unsupported wireVersion, non-zero flags, overlong frame length, unknown enum byte (`op = 3`), upsert without payload |
| — | `response/invalid/*` | Bool byte > 1 (`SUB_START.bootstrap` = `0x02`) |
| — | `segment/invalid/*` | Null bit on non-nullable column, rows segment without end marker |

---

## Appendix B. Conformance scenarios

Implementation-agnostic scenario definitions executed by
`packages/conformance` (B4) against any (client, server) pairing over the
loopback transport, with fault injection at the transport interface.
Ported from the v1 testkit gates; each becomes a driver-interface script,
not a prose test.

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
