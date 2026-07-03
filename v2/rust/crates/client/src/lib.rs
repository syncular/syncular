//! # syncular-client — Syncular v2 Rust client core (POC stage 2)
//!
//! A clean-room client implementation of the SPEC.md client-behavior
//! contract on rusqlite local storage, consuming the committed `ssp2`
//! codec as its wire layer. Built without reading the v1 Rust tree or the
//! v2 TypeScript client — the conformance catalog (packages/conformance)
//! is the proof that both cores implement one written protocol.
//!
//! The API is synchronous request/response: the host drives `sync()` /
//! `sync_until_idle()` and feeds inbound realtime traffic through
//! `on_realtime_text` / `on_realtime_binary`. Scheduling is host policy
//! (§8.4); the core exposes the coalesced `sync_needed` signal only.

pub mod api;
pub mod client;
pub mod schema;
pub mod transport;
pub mod values;

pub use api::{
    ClientLimits, ConflictRecord, Mutation, PresencePeer, RejectionRecord, RowState, SchemaFloor,
    SubscriptionStateView, SyncOutcome, SyncReport,
};
pub use client::SyncClient;
pub use schema::{compile_schema, parse_schema_json, ClientSchema};
pub use transport::{SegmentRequest, Transport, TransportError};
