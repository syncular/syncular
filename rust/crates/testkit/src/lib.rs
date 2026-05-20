//! Test utilities for Rust-first Syncular clients.
//!
//! The crate intentionally uses real Syncular runtime pieces by default: Diesel
//! SQLite stores, generated app schemas, transport implementations, and runtime
//! assertions. It is meant to replace ad hoc mocks in app test suites.

pub mod app;
pub mod app_server;
pub mod assertions;
pub mod conformance;
pub mod crdt;
pub mod deterministic;
pub mod http;
pub mod native;
pub mod protocol;
pub mod temp;
pub mod todo;
pub mod transport;

pub use app::*;
pub use app_server::*;
pub use assertions::*;
pub use conformance::*;
pub use crdt::*;
pub use deterministic::*;
pub use http::*;
pub use native::*;
pub use protocol::*;
pub use temp::*;
pub use todo::*;
pub use transport::*;
