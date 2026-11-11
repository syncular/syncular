//! Decoded SSP2 message model, wire version 4 (SPEC.md §1.2, §1.5, §1.6,
//! §4–§6).
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
    pub wire_version: u16,
    pub msg_kind: MsgKind,
    pub frames: Vec<Frame>,
}

/// Frame types, wire version 4 (§1.2 registry). `END` is structural
/// and not represented in the model.
pub mod frame_type {
    pub const END: u8 = 0x00;
    pub const REQ_HEADER: u8 = 0x01;
    pub const PUSH_COMMIT: u8 = 0x02;
    pub const PULL_HEADER: u8 = 0x03;
    pub const UNIT: u8 = 0x04;
    pub const ROUND_FAILURE: u8 = 0x05;
    pub const PROGRESS: u8 = 0x06;
    pub const RESP_HEADER: u8 = 0x10;
    pub const PUSH_RESULT: u8 = 0x11;
    pub const SUB_START: u8 = 0x12;
    pub const COMMIT: u8 = 0x13;
    pub const SEGMENT_REF: u8 = 0x14;
    pub const SEGMENT_INLINE: u8 = 0x15;
    pub const SUB_END: u8 = 0x16;
    pub const LEASE: u8 = 0x19;
    pub const PUSH_RESULT_DETAILS: u8 = 0x1B;
    pub const LIVE_START: u8 = 0x1C;
    pub const LIVE_END: u8 = 0x1D;
    pub const ERROR: u8 = 0x1F;

    pub const REQUEST_TYPES: &[u8] = &[
        REQ_HEADER,
        PUSH_COMMIT,
        PULL_HEADER,
        UNIT,
        ROUND_FAILURE,
        PROGRESS,
    ];
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
        LIVE_START,
        LIVE_END,
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

/// §1.5 `ROUND_FAILURE.code`: `[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+`, at
/// most 64 UTF-8 bytes. Hand-checked; the codec takes no regex dependency.
pub fn valid_round_failure_code(code: &str) -> bool {
    code.len() <= 64
        && code.split('.').count() >= 2
        && code.split('.').all(|segment| {
            let mut chars = segment.chars();
            matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
}

/// §1.5: a present `REQ_HEADER.outboxId` is non-empty and at most 64 bytes.
pub fn valid_outbox_id(outbox_id: &str) -> bool {
    !outbox_id.is_empty() && outbox_id.len() <= 64
}

/// §4.3, §4.4: a unit id is 32 lowercase hex characters.
pub fn valid_unit_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// §4.4: fenced records in strictly ascending code-unit order of `table`.
pub fn fenced_in_order(fenced: &[FencedRecord]) -> bool {
    fenced
        .windows(2)
        .all(|pair| crate::util::utf16_lt(&pair[0].table, &pair[1].table))
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

/// The status of a unit or a (unit, table) pair in an echo (§4.4): the
/// fenced-record status byte (`1`, `2`) and the echo-digest status value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EchoStatus {
    Active,
    Revoked,
}

impl EchoStatus {
    pub fn name(self) -> &'static str {
        match self {
            EchoStatus::Active => "active",
            EchoStatus::Revoked => "revoked",
        }
    }
}

/// `LIVE_START.status` (§4.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveStatus {
    Active,
    Reset,
    Unregistered,
}

impl LiveStatus {
    pub fn name(self) -> &'static str {
        match self {
            LiveStatus::Active => "active",
            LiveStatus::Reset => "reset",
            LiveStatus::Unregistered => "unregistered",
        }
    }
}

/// One (unit, table) pair the §3.2 rule 4 wildcard fence touched (§4.4).
#[derive(Debug, Clone, PartialEq)]
pub struct FencedRecord {
    pub table: String,
    pub status: EchoStatus,
    /// Effective lists of the variables the fence added; empty when revoked.
    pub scopes: Vec<(String, Vec<String>)>,
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
    /// The row's `server_version` after the write, deletes included (§2.2).
    pub row_version: i64,
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
        /// §6.3: presence-bitmap layout over the row's
        /// columns, marking the present columns whose `column_version`
        /// exceeded the operation's `baseVersion`.
        conflict_columns: Vec<u8>,
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
        log_epoch: Option<String>,
        /// §6.3.2, §7.1: the sender's outbox identity; absent for a sender
        /// without an outbox. Non-empty, at most 64 bytes.
        outbox_id: Option<String>,
    },
    PushCommit {
        client_commit_id: String,
        /// Outbox sequence number (§6.3.2, §7.1), `≥ 0`; `0` without an outbox.
        client_seq: i64,
        operations: Vec<Operation>,
    },
    PullHeader {
        limit_commits: i32,
        limit_snapshot_rows: i32,
        max_snapshot_pages: i32,
        accept: u8,
        /// The replica cursor (§4.5), `≥ -1`; `-1` when no unit is live.
        cursor: i64,
        /// §4.1 registration digest.
        registration_digest: [u8; 32],
        /// The last processed `LIVE_END.echoDigest`; `None` (empty on the
        /// wire) before the first.
        echo_digest: Option<[u8; 32]>,
    },
    /// §1.5: the code of the client's last round that failed where the server
    /// could not see it. Optional, at most one, immediately after REQ_HEADER.
    RoundFailure { code: String },
    /// §4.3: one unit of a traveling registration list.
    Unit { scopes: Vec<(String, String)> },
    /// §4.3: the progress of one catching-up unit.
    Progress {
        /// The unit id (§4.1).
        id: String,
        /// `-1`, the §4.7 pin while a resume token is held, or the unit cursor.
        cursor: i64,
        /// Opaque resume token, round-tripped byte for byte (§4.7).
        bootstrap_state: Option<RawJson>,
    },
    RespHeader {
        required_schema_version: Option<i32>,
        latest_schema_version: Option<i32>,
        /// Partition log identity, non-empty.
        log_epoch: String,
        /// True produces a header-only reset response.
        reset_required: bool,
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
        bootstrap: bool,
        /// The unit's echo, in ascending table order (§4.4).
        fenced: Vec<FencedRecord>,
    },
    LiveStart {
        status: LiveStatus,
        reason_code: String,
    },
    LiveEnd {
        /// Highest commitSeq the live section is complete through; `-1` for
        /// `reset` and `unregistered` (§4.4).
        through_seq: i64,
        /// The request's echo digest; `None` (empty on the wire) for
        /// `unregistered` and realtime deltas.
        echo_digest: Option<[u8; 32]>,
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
