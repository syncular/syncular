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

## Current Inventory

- Server pull currently clamps requests to `1..1000` commits, `1..50000`
  snapshot rows, and `1..50` snapshot pages. The Rust client requests the
  defaults above.
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
- Blob and CRDT/Yjs entry points reject oversized blob payloads, CRDT request
  JSON, Yjs update/state/state-vector payloads, and CRDT text with
  `runtime.limit_exceeded`.
- Native diagnostic snapshots keep bounded recent event payloads by redacting
  oversized `payload_json` values instead of retaining full host/app payloads.
- Snapshot chunk/artifact transports reject oversized declared, compressed, and
  decompressed payloads before hash/decode/apply work where possible.
- Realtime websocket text frames and browser realtime sync-pack bytes are
  bounded with stable limit errors.
- Blob upload retries and sync retries are bounded by the runtime store
  constants and should become public limit fields in a later WP-18 slice.

## Rules

- A limit must either be visible in diagnostics/manifest or be tracked here as
  implicit inventory until it is made public.
- Limit failures should map to stable error codes and diagnostics, not silent
  clamping, background fallback, or unbounded memory growth.
- Performance-sensitive limit changes need before/after benchmark evidence in
  `rust/docs/BENCHMARK_LOG.md`.
