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
- Blob upload retries and sync retries are bounded by the runtime store
  constants and should become public limit fields in a later WP-18 slice.

## Rules

- A limit must either be visible in diagnostics/manifest or be tracked here as
  implicit inventory until it is made public.
- Limit failures should map to stable error codes and diagnostics, not silent
  clamping, background fallback, or unbounded memory growth.
- Performance-sensitive limit changes need before/after benchmark evidence in
  `rust/docs/BENCHMARK_LOG.md`.
