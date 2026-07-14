//! Compatibility export for the shared Rust native transport.
//!
//! The implementation lives in `syncular-client` so FFI and Tauri cannot
//! drift in socket fairness, wire behavior, or blob/segment support.

pub use syncular_client::native_transport::*;
