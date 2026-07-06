//! # `syncular` is deprecated
//!
//! The Syncular Rust client core has moved to the
//! [`syncular-client`](https://crates.io/crates/syncular-client) crate.
//!
//! This crate is an empty placeholder published only to point existing
//! users at the new crate name. Depend on `syncular-client` instead:
//!
//! ```toml
//! [dependencies]
//! syncular-client = "0.2"
//! ```
//!
//! Related crates:
//! - `syncular-client` — the Rust client core
//! - `syncular-ssp2` — the SSP2 wire codec (`use ssp2::...`)
//! - `syncular-command` — the shared JSON command router
//! - `syncular-ffi` — the C-ABI native library (`libsyncular`)
