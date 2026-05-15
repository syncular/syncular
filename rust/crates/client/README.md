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
