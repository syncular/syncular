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
/// §5.10.5 native CRDT helpers (the `crdt-yjs` feature) — the Rust face of the
/// Yjs binding, mirroring `@syncular/crdt-yjs`. Off by default (dependency-lean).
#[cfg(feature = "crdt-yjs")]
pub mod crdt;
/// Shared blocking HTTP/WebSocket host transport for Rust-backed bindings.
/// The network stack is feature-gated; its no-network shape remains available
/// in dependency-lean builds so host code needs only one transport type.
pub mod native_transport;
pub mod query_guard;
pub mod realtime_round;
pub mod schema;
pub mod transport;
pub mod values;

pub use api::{
    ClientChangeBatch, ClientDiagnosticsHost, ClientDiagnosticsLease, ClientDiagnosticsReplica,
    ClientDiagnosticsRequest, ClientDiagnosticsSchema, ClientDiagnosticsSnapshot,
    ClientDiagnosticsStorage, ClientLimits, CommandEffects, CommitOperation,
    CommitOperationOutcome, CommitOutcome, CommitOutcomeQuery, CommitOutcomeResolution,
    CommitOutcomeStatus, ConflictRecord, CoverageSnapshot, DiagnosticLastChange,
    DiagnosticLastRound, DiagnosticRoundCounters, DiagnosticSubscription,
    ExpectedDiagnosticSubscription, LocalDataPurgeInput, LocalDataPurgeResult,
    LocalDataPurgeTarget, LocalDataRebootstrapInput, LocalDataRebootstrapResult, Mutation,
    PresencePeer, QueryRow, QuerySnapshot, QueryValue, RejectionRecord, ResolveCommitOutcomeInput,
    RowState, SchemaFloor, SubscriptionStateView, SyncIntent, SyncOutcome, SyncReport,
    SyncStatusSnapshot, TableChange, WindowBase, WindowChange, WindowCoverage, WindowState,
    WindowUnitRef, CLIENT_DIAGNOSTICS_VERSION, MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
};
pub use client::{FileQuerySnapshotReader, SyncClient, SECURITY_PREFLIGHT_REQUIRED_CODE};
pub use schema::{compile_schema, parse_schema_json, ClientSchema};
pub use transport::{BlobDownload, BlobUploadGrant, SegmentRequest, Transport, TransportError};

// Re-export the SSP2 stream scanner (§8.7 round-response reassembly) so the
// native transports (FFI + Tauri plugin) reach it through their existing
// `syncular-client` dependency, without each adding a direct `ssp2` path dep.
pub use realtime_round::{RealtimeRound, RoundInbound, REALTIME_TAG_DELTA, REALTIME_TAG_ROUND};
pub use ssp2::{MessageStreamScanner, ScannedMessage};
