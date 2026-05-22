# Rust-First Runtime Limits

This page records the current operational limits that app hosts can inspect and
that future hardening work must enforce with explicit errors.

## Native Runtime Defaults

Native hosts can read these through `native_runtime_manifest_json()` and through
`diagnostic_snapshot_json().limits`.

| Limit | Default | Meaning |
| --- | ---: | --- |
| `workerCommandQueueCapacity` | 1024 | Maximum queued worker commands before enqueue APIs return `runtime.busy` |
| `workerEventQueueCapacity` | 1024 | Default Rust worker event subscription capacity |
| `nativeDefaultEventStreamCapacity` | 256 | Native facade default event stream capacity |
| `nativeRecentEventLimit` | 100 | Recent native events retained in diagnostics |
| `readonlyQueryStatementCacheCapacity` | 64 | Prepared read-only query statements retained by the native read executor |
| `pullLimitCommits` | 1000 | Client-requested incremental commits per pull |
| `pullLimitSnapshotRows` | 50000 | Client-requested snapshot rows per page |
| `pullMaxSnapshotPages` | 10 | Client-requested snapshot pages per pull |
| `outboxPushBatchLimit` | 20 | Pending outbox commits loaded for one push round |
| `maxUnresolvedOutboxCommits` | 10000 | Maximum pending/sending/failed outbox commits retained before new local writes fail |
| `maxSyncRetries` | 5 | Maximum retry attempts for one outbox commit before it becomes failed |
| `syncSendingTimeoutMs` | 30000 | Stale `sending` outbox age before it is requeued or failed |
| `maxBlobUploadRetries` | 3 | Maximum retry attempts for one queued blob upload before it becomes failed |
| `blobUploadStaleTimeoutMs` | 30000 | Stale `uploading` blob age before it is requeued or failed |
| `blobUploadBatchLimit` | 10 | Pending blob uploads processed in one queue-drain call |
| `sqliteBusyTimeoutMs` | 5000 | SQLite busy timeout applied to native Diesel SQLite connections |
| `crdtStateVectorHintLimit` | 256 | CRDT state-vector hints included in a pull request |
| `crdtUpdateQueueCapacity` | 1024 | Pending server-merge CRDT updates per document before local writes fail |
| `crdtUpdateLogDefaultLimit` | 100 | Default CRDT update-log rows returned by host APIs |
| `yjsFlushWindowMs` | 12 | Worker coalescing window for queued Yjs updates |
| `maxSubscriptionsPerClient` | 256 | Maximum configured subscriptions accepted by a client |
| `maxScopeKeysPerSubscription` | 16 | Maximum distinct scope keys on one subscription |
| `maxScopeValuesPerSubscription` | 4096 | Maximum scalar/array scope values on one subscription |
| `maxScopeValuesPerClient` | 16384 | Maximum total scalar/array scope values across all subscriptions |
| `maxSubscriptionParamsPerSubscription` | 32 | Maximum params keys on one subscription |
| `maxMutationOperationJsonBytes` | 1048576 | Maximum low-level mutation operation JSON accepted by Rust/native/browser APIs |
| `maxMutationLocalRowJsonBytes` | 1048576 | Maximum local-row JSON paired with one low-level mutation |
| `maxMutationBatchJsonBytes` | 4194304 | Maximum low-level mutation batch JSON or typed mutation batch serialization |
| `maxOutboxOperationsJsonBytes` | 4194304 | Maximum serialized operations stored in one outbox commit |
| `maxBlobPayloadBytes` | 67108864 | Maximum blob payload accepted for local cache, upload, or download |
| `maxCrdtRequestJsonBytes` | 4194304 | Maximum CRDT/Yjs JSON request accepted by native/browser helpers |
| `maxCrdtUpdateBase64Bytes` | 1048576 | Maximum Yjs update envelope `updateBase64` length |
| `maxCrdtStateBase64Bytes` | 4194304 | Maximum materialized Yjs document state length |
| `maxCrdtStateVectorBase64Bytes` | 65536 | Maximum Yjs state-vector length |
| `maxCrdtTextBytes` | 1048576 | Maximum CRDT text input accepted by text helper APIs |
| `maxNativeDiagnosticEventPayloadJsonBytes` | 16384 | Maximum event payload retained in native diagnostic snapshots before redaction |
| `maxSnapshotChunkCompressedBytes` | 67108864 | Maximum compressed snapshot chunk payload accepted by runtime transports |
| `maxSnapshotChunkDecompressedBytes` | 268435456 | Maximum decompressed snapshot chunk payload before row decoding |
| `maxSnapshotArtifactCompressedBytes` | 268435456 | Maximum compressed SQLite snapshot artifact payload accepted by runtime transports |
| `maxSnapshotArtifactDecompressedBytes` | 536870912 | Maximum decompressed SQLite snapshot artifact payload before SQLite apply |
| `maxRealtimeSyncPackBytes` | 16777216 | Maximum realtime binary sync-pack payload accepted by browser runtime |
| `maxWebsocketTextFrameBytes` | 8388608 | Maximum native websocket text frame sent or accepted by realtime transport |

## Server Route Defaults

`@syncular/server-hono` enforces these boundaries at HTTP route edges. They are
configured through `createSyncRoutes({ sync: ... })` / `createSyncServer({
routes: ... })` and return `runtime.limit_exceeded` envelopes when exceeded.

| Limit | Default | Meaning |
| --- | ---: | --- |
| `maxSyncRequestJsonBytes` | 4194304 | Maximum JSON body accepted by combined `POST /` sync requests |
| `maxSyncBinaryPackBytes` | 16777216 | Maximum binary sync-pack body emitted by combined `POST /` sync responses |
| `maxSnapshotChunkResponseBytes` | 67108864 | Maximum snapshot chunk body emitted by `GET /snapshot-chunks/:chunkId` |
| `maxSnapshotArtifactResponseBytes` | 268435456 | Maximum scoped snapshot artifact body emitted by `GET /snapshot-artifacts/:artifactId` |

## Current Inventory

- Server pull currently clamps requests to `1..1000` commits, `1..50000`
  snapshot rows, and `1..50` snapshot pages. The Rust client requests the
  defaults above.
- Server Hono sync routes reject oversized request JSON, JSON responses, binary
  sync packs, snapshot chunk downloads, and scoped snapshot artifact downloads
  with stable `runtime.limit_exceeded` envelopes.
- Server console request events surface combined-level request/response limit
  pressure. Pre-parse HTTP combined failures use event type `sync`; oversized
  response failures are recorded as rejected events and do not record successful
  pull cursor side effects.
- Server console stats expose snapshot chunk/artifact cache pressure counters,
  including total cached rows/bytes and expired rows/bytes, filtered by
  partition where requested.
- Server snapshot bundling currently uses `512 KiB` default row-frame bundle
  bytes, `4 MiB` adaptive max bundle bytes, `256 KiB` inline row-frame bytes,
  `50000` binary bundle rows, and gzip level `1`.
- Browser diagnostics keep `100` recent diagnostic events and `20` sync timing
  entries.
- Browser-owned SQLite uses a `64` statement cache for queries and `16`
  statement cache for snapshot apply.
- Native and Rust worker event streams are bounded and emit
  `EventsOverflowed` / `events.overflowed` when a subscriber falls behind.
- Rust/native/browser subscription setters reject the configured subscription
  and scope limits above with `runtime.limit_exceeded`.
- Rust/native/browser mutation entry points reject oversized mutation operation,
  local row, batch, typed mutation, and outbox JSON with
  `runtime.limit_exceeded`.
- Rust/native/browser local writes reject new outbox commits once unresolved
  pending/sending/failed commits reach `maxUnresolvedOutboxCommits`; acked
  commits do not count against this pressure cap.
- Blob and CRDT/Yjs entry points reject oversized blob payloads, CRDT request
  JSON, Yjs update/state/state-vector payloads, and CRDT text with
  `runtime.limit_exceeded`.
- Native diagnostic snapshots keep bounded recent event payloads by redacting
  oversized `payload_json` values instead of retaining full host/app payloads.
- Snapshot chunk/artifact transports reject oversized declared, compressed, and
  decompressed payloads before hash/decode/apply work where possible.
- Realtime websocket text frames and browser realtime sync-pack bytes are
  bounded with stable limit errors.
- Blob upload retries, sync retries, stale sending/uploading timeouts, blob
  upload processing batch size, and SQLite busy timeout are public native
  runtime limits.

## Rules

- A limit must either be visible in diagnostics/manifest or be tracked here as
  implicit inventory until it is made public.
- Limit failures should map to stable error codes and diagnostics, not silent
  clamping, background fallback, or unbounded memory growth.
- Performance-sensitive limit changes need before/after benchmark evidence in
  `rust/docs/BENCHMARK_LOG.md`.
