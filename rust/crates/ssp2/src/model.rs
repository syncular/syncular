//! Decoded SSP2 message model (SPEC.md §1.2, §1.5, §1.6, §4–§6).
//!
//! The model preserves everything needed for byte-identical re-encoding:
//! raw `json` strings, unknown frames in their original positions, map entry
//! order (validated canonical at decode), and opaque row payload bytes (the
//! envelope codec never decodes rows — §1.7).

use crate::primitives::RawJson;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgKind {
    Request,
    Response,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub msg_kind: MsgKind,
    pub frames: Vec<Frame>,
}

/// Frame types, wire version 1 (§1.2 registry). `END` is structural and not
/// represented in the model.
pub mod frame_type {
    pub const END: u8 = 0x00;
    pub const REQ_HEADER: u8 = 0x01;
    pub const PUSH_COMMIT: u8 = 0x02;
    pub const PULL_HEADER: u8 = 0x03;
    pub const SUBSCRIPTION: u8 = 0x04;
    pub const RESP_HEADER: u8 = 0x10;
    pub const PUSH_RESULT: u8 = 0x11;
    pub const SUB_START: u8 = 0x12;
    pub const COMMIT: u8 = 0x13;
    pub const SEGMENT_REF: u8 = 0x14;
    pub const SEGMENT_INLINE: u8 = 0x15;
    pub const SUB_END: u8 = 0x16;
    pub const LEASE: u8 = 0x19;
    pub const PUSH_RESULT_DETAILS: u8 = 0x1B;
    pub const ERROR: u8 = 0x1F;

    pub const REQUEST_TYPES: &[u8] = &[REQ_HEADER, PUSH_COMMIT, PULL_HEADER, SUBSCRIPTION];
    pub const RESPONSE_TYPES: &[u8] = &[
        RESP_HEADER,
        PUSH_RESULT,
        SUB_START,
        COMMIT,
        SEGMENT_REF,
        SEGMENT_INLINE,
        SUB_END,
        LEASE,
        PUSH_RESULT_DETAILS,
        ERROR,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Upsert,
    Delete,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Op::Upsert => "upsert",
            Op::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubStatus {
    Active,
    Revoked,
    Reset,
}

impl SubStatus {
    pub fn name(self) -> &'static str {
        match self {
            SubStatus::Active => "active",
            SubStatus::Revoked => "revoked",
            SubStatus::Reset => "reset",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushStatus {
    Applied,
    Cached,
    Rejected,
}

impl PushStatus {
    pub fn name(self) -> &'static str {
        match self {
            PushStatus::Applied => "applied",
            PushStatus::Cached => "cached",
            PushStatus::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Rows,
    Sqlite,
}

impl MediaType {
    pub fn name(self) -> &'static str {
        match self {
            MediaType::Rows => "rows",
            MediaType::Sqlite => "sqlite",
        }
    }
}

/// Push operation record (§6.1).
#[derive(Debug, Clone, PartialEq)]
pub struct Operation {
    pub table: String,
    pub row_id: String,
    pub op: Op,
    pub base_version: Option<i64>,
    /// Row-codec bytes, opaque at the envelope layer (§1.7).
    pub payload: Option<Vec<u8>>,
}

/// Commit change record (§4.5).
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub table_index: u16,
    pub row_id: String,
    pub op: Op,
    pub row_version: Option<i64>,
    pub scopes: Vec<(String, String)>,
    /// Row-codec bytes, opaque at the envelope layer.
    pub row: Option<Vec<u8>>,
}

/// Push result record — tagged union (§6.3).
#[derive(Debug, Clone, PartialEq)]
pub enum OpResult {
    Applied {
        op_index: i32,
    },
    Conflict {
        op_index: i32,
        code: String,
        message: String,
        server_version: i64,
        server_row: Vec<u8>,
    },
    Error {
        op_index: i32,
        code: String,
        message: String,
        retryable: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResultDetail {
    pub op_index: i32,
    pub details: RawJson,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    ReqHeader {
        client_id: String,
        schema_version: i32,
    },
    PushCommit {
        client_commit_id: String,
        operations: Vec<Operation>,
    },
    PullHeader {
        limit_commits: i32,
        limit_snapshot_rows: i32,
        max_snapshot_pages: i32,
        accept: u8,
    },
    Subscription {
        id: String,
        table: String,
        scopes: Vec<(String, Vec<String>)>,
        params: Option<RawJson>,
        cursor: i64,
        bootstrap_state: Option<RawJson>,
    },
    RespHeader {
        required_schema_version: Option<i32>,
        latest_schema_version: Option<i32>,
    },
    /// §7.3.2: a server-issued auth lease delivered to the client (opaque).
    Lease {
        lease_id: String,
        expires_at_ms: i64,
    },
    PushResult {
        client_commit_id: String,
        status: PushStatus,
        commit_seq: Option<i64>,
        results: Vec<OpResult>,
    },
    /// Additive host-safe metadata for rejection records. Older clients skip
    /// this frame under the unknown-frame rule and still process PUSH_RESULT.
    PushResultDetails {
        client_commit_id: String,
        entries: Vec<PushResultDetail>,
    },
    SubStart {
        id: String,
        status: SubStatus,
        reason_code: String,
        effective_scopes: Vec<(String, Vec<String>)>,
        bootstrap: bool,
    },
    Commit {
        commit_seq: i64,
        created_at_ms: i64,
        actor_id: String,
        tables: Vec<String>,
        changes: Vec<Change>,
    },
    SegmentRef {
        segment_id: String,
        media_type: MediaType,
        table: String,
        byte_length: i64,
        row_count: i64,
        as_of_commit_seq: i64,
        scope_digest: String,
        row_cursor: Option<String>,
        next_row_cursor: Option<String>,
        url: Option<String>,
        url_expires_at_ms: Option<i64>,
    },
    /// Raw payload bytes, validated at decode as a structurally valid rows
    /// segment (§5.7) and preserved verbatim for re-encoding.
    SegmentInline { payload: Vec<u8> },
    SubEnd {
        next_cursor: i64,
        bootstrap_state: Option<RawJson>,
    },
    Error {
        code: String,
        message: String,
        category: String,
        retryable: bool,
        recommended_action: String,
        details: Option<RawJson>,
    },
    /// Unknown frame preserved by the §1.2 rule-2 skip rule: never dropped,
    /// re-encoded byte-for-byte in its original position.
    Unknown { frame_type: u8, payload: Vec<u8> },
}
