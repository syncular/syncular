# syncular (deprecated)

The Syncular Rust client core has **moved to the
[`syncular-client`](https://crates.io/crates/syncular-client)** crate.

This crate is an empty placeholder, published only to redirect existing
users to the new crate name.

```toml
[dependencies]
syncular-client = "0.2"
```

## Related crates

| Crate | Purpose |
| --- | --- |
| [`syncular-client`](https://crates.io/crates/syncular-client) | Rust client core (on rusqlite) |
| [`syncular-ssp2`](https://crates.io/crates/syncular-ssp2) | SSP2 wire codec (`use ssp2::...`) |
| [`syncular-command`](https://crates.io/crates/syncular-command) | Shared JSON command router |
| [`syncular-ffi`](https://crates.io/crates/syncular-ffi) | C-ABI native library (`libsyncular`) |

## License

Apache-2.0
