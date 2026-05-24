//! Reserved canonical crate name for the Rust-first Syncular client SDK.
//!
//! Most Rust apps should depend directly on `syncular-client` once the SDK
//! crates are published. This crate keeps the canonical package name available
//! for a future higher-level re-export surface.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn package_name() -> &'static str {
    "syncular"
}
