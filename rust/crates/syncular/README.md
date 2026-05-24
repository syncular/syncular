# syncular

Reserved canonical crate name for the Rust-first Syncular client SDK.

The crate is intentionally tiny in `0.1.x` so the canonical package name can be
published independently before the lower-level SDK crates are all available on
crates.io.

Use the narrower crates for real app work:

- `syncular-client`: developer-facing Rust SDK
- `syncular-runtime`: shared runtime, storage, transport, and binding surface
- `syncular-protocol`: protocol and integrity types
- `syncular-testkit`: optional app/server/client testing helpers

For most Rust apps, the narrower `syncular-client` dependency is still the
recommended direct dependency:

```toml
syncular-client = { version = "0.1", default-features = false, features = ["native", "crdt-yjs"] }
```

A later `syncular` release can become the higher-level re-export entry point
after the lower-level crates are published.
