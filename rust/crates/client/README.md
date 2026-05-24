# syncular-client

Canonical Rust SDK package for Syncular.

The shared engine and binding surface lives in `syncular-runtime`
(`rust/crates/runtime`). This crate is the Rust developer-facing SDK layer: it
re-exports the runtime APIs, keeps Diesel as the canonical Rust query/storage
integration, and owns the local CLI/demo entry point.

The Rust API shape is intentionally query-builder-first:

- reads are normal Diesel expressions executed with `client.read(query)`.
- writes use generated Syncular mutation namespaces so local rows, outbox, and
  conflicts stay on the sync path.
- conflicts are handled through `client.conflicts()` helpers.
- live reads use `client.live_query(["table"], || query)` and refresh from
  table-level `SyncReport` invalidation.

Native apps should depend on the SDK with explicit features, for example:

```toml
syncular-client = { default-features = false, features = ["native", "crdt-yjs"] }
```

That profile avoids CLI/testkit dependencies while keeping native SQLite,
sync transport, and CRDT/Yjs support.

## Rich editor CRDT fields

Treat the Yjs document field as canonical editor state. ProseMirror JSON,
title, preview, outline, search text, and other read models should be
materialized from CRDT state after local apply, remote apply, or compaction.

The runtime stores a compact binary Yjs state and state vector per document
field, plus an append-only binary Yjs update log with `pending`, `flushed`, and
`acked` statuses. Use `crdtDocumentSnapshot` to inspect the persisted state,
state vector, and queue counts; use `crdtUpdateLog` for adapter diagnostics or
retry policy; use `compactCrdtField` and storage compaction pruning to keep the
log bounded without making derived columns canonical.
