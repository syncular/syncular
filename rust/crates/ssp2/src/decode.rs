//! SSP2 envelope decoding (SPEC.md §1.2), request/response frame grammar
//! (§1.5, §1.6), and the closed decode-error boundary of §1.7: exactly the
//! listed violations are rejected here, nothing more.

use crate::error::{DecodeError, Result};
use crate::model::frame_type as ft;
use crate::model::{
    fenced_in_order, valid_outbox_id, valid_round_failure_code, valid_unit_id, Change, EchoStatus,
    FencedRecord, Frame, LiveStatus, MediaType, Message, MsgKind, Op, OpResult, Operation,
    PushStatus, SubStatus,
};
use crate::primitives::Reader;
use crate::segment::decode_rows_segment;

pub const SSP2_MAGIC: &[u8; 4] = b"SSP2";
/// The one wire version this codec speaks; every other version is rejected
/// as unknown (§1.2, §9).
pub const WIRE_VERSION: u16 = 4;

/// Decode a complete SSP2 message, enforcing envelope rules and the per-kind
/// frame grammar. Unknown frame types are preserved byte-for-byte (§1.2
/// rule 2).
pub fn decode_message(bytes: &[u8]) -> Result<Message> {
    let mut r = Reader::new(bytes);
    let magic = r.take(4, "envelope magic")?;
    if magic != SSP2_MAGIC {
        return Err(DecodeError::invalid("bad envelope magic (expected SSP2)"));
    }
    let wire_version = r.u16("wireVersion")?;
    if wire_version != WIRE_VERSION {
        return Err(DecodeError::invalid(format!(
            "unsupported wireVersion {wire_version}"
        )));
    }
    let msg_kind = match r.u8("msgKind")? {
        0x01 => MsgKind::Request,
        0x02 => MsgKind::Response,
        other => {
            return Err(DecodeError::invalid(format!(
                "unknown msgKind 0x{other:02x}"
            )))
        }
    };
    let flags = r.u8("flags")?;
    if flags != 0 {
        return Err(DecodeError::invalid(format!(
            "envelope flags must be 0x00, got 0x{flags:02x}"
        )));
    }

    let frames = match msg_kind {
        MsgKind::Request => decode_request_frames(&mut r)?,
        MsgKind::Response => decode_response_frames(&mut r)?,
    };
    if !r.is_empty() {
        return Err(DecodeError::invalid(
            "trailing bytes after the END frame (canonical encoding)",
        ));
    }
    Ok(Message {
        wire_version,
        msg_kind,
        frames,
    })
}

/// Read one frame header + payload. Returns `None` for END.
fn next_frame<'a>(r: &mut Reader<'a>) -> Result<Option<(u8, &'a [u8])>> {
    if r.is_empty() {
        return Err(DecodeError::invalid(
            "truncated message: body ends without an END frame",
        ));
    }
    let ty = r.u8("frameType")?;
    let len = r.u32("frameLength")? as usize;
    if len > r.remaining() {
        return Err(DecodeError::invalid(format!(
            "frame 0x{ty:02x} length {len} exceeds the {} remaining bytes",
            r.remaining()
        )));
    }
    let payload = r.take(len, "frame payload")?;
    if ty == ft::END {
        if len != 0 {
            return Err(DecodeError::invalid("END frame must have frameLength 0"));
        }
        return Ok(None);
    }
    Ok(Some((ty, payload)))
}

/// "Unknown" per §1.2 rule 2: a frameType with no layout in this wire version
/// for *either* message kind. A type registered for the other kind is a
/// decode error, not unknown.
fn classify(ty: u8, kind: MsgKind) -> Result<bool> {
    let (own, other) = match kind {
        MsgKind::Request => (ft::REQUEST_TYPES, ft::RESPONSE_TYPES),
        MsgKind::Response => (ft::RESPONSE_TYPES, ft::REQUEST_TYPES),
    };
    if own.contains(&ty) {
        Ok(true)
    } else if other.contains(&ty) {
        Err(DecodeError::invalid(format!(
            "frame type 0x{ty:02x} is registered for the other message kind"
        )))
    } else {
        Ok(false)
    }
}

/// §1.5 grammar: REQ_HEADER, ROUND_FAILURE 0|1 immediately after it,
/// PUSH_COMMIT × N, PULL_HEADER 0|1, UNIT × M then PROGRESS × K (only if
/// PULL_HEADER present), END. A request with neither push nor pull frames is
/// invalid.
fn decode_request_frames(r: &mut Reader<'_>) -> Result<Vec<Frame>> {
    let mut frames = Vec::new();
    let mut seen_header = false;
    let mut seen_body = false;
    let mut seen_failure = false;
    let mut seen_pull = false;
    let mut seen_push = false;
    let mut seen_progress = false;

    while let Some((ty, payload)) = next_frame(r)? {
        let known = classify(ty, MsgKind::Request)?;
        if !known {
            if !seen_header {
                return Err(DecodeError::invalid(
                    "unknown frame before REQ_HEADER (unknown frames are only legal between the header frame and END)",
                ));
            }
            frames.push(Frame::Unknown {
                frame_type: ty,
                payload: payload.to_vec(),
            });
            seen_body = true;
            continue;
        }
        if !seen_header {
            if ty != ft::REQ_HEADER {
                return Err(DecodeError::invalid(
                    "first frame of a request must be REQ_HEADER",
                ));
            }
            frames.push(decode_req_header(payload)?);
            seen_header = true;
            continue;
        }
        match ty {
            ft::REQ_HEADER => {
                return Err(DecodeError::invalid("duplicate REQ_HEADER frame"));
            }
            ft::ROUND_FAILURE => {
                if seen_failure {
                    return Err(DecodeError::invalid("duplicate ROUND_FAILURE frame"));
                }
                if seen_body {
                    return Err(DecodeError::invalid(
                        "ROUND_FAILURE must immediately follow REQ_HEADER",
                    ));
                }
                frames.push(decode_round_failure(payload)?);
                seen_body = true;
                seen_failure = true;
            }
            ft::PUSH_COMMIT => {
                if seen_pull {
                    return Err(DecodeError::invalid(
                        "PUSH_COMMIT after PULL_HEADER (out of grammar order)",
                    ));
                }
                frames.push(decode_push_commit(payload)?);
                seen_body = true;
                seen_push = true;
            }
            ft::PULL_HEADER => {
                if seen_pull {
                    return Err(DecodeError::invalid("duplicate PULL_HEADER frame"));
                }
                frames.push(decode_pull_header(payload)?);
                seen_body = true;
                seen_pull = true;
            }
            ft::UNIT => {
                if !seen_pull {
                    return Err(DecodeError::invalid(
                        "UNIT frame without a preceding PULL_HEADER",
                    ));
                }
                if seen_progress {
                    return Err(DecodeError::invalid("UNIT frame after a PROGRESS frame"));
                }
                frames.push(frame_payload(payload, "UNIT", |r| {
                    Ok(Frame::Unit {
                        scopes: r.str_map("scopes")?,
                    })
                })?);
                seen_body = true;
            }
            ft::PROGRESS => {
                if !seen_pull {
                    return Err(DecodeError::invalid(
                        "PROGRESS frame without a preceding PULL_HEADER",
                    ));
                }
                frames.push(decode_progress(payload)?);
                seen_body = true;
                seen_progress = true;
            }
            _ => unreachable!("classified as known request type"),
        }
    }
    if !seen_header {
        return Err(DecodeError::invalid("request has no REQ_HEADER frame"));
    }
    if !seen_push && !seen_pull {
        return Err(DecodeError::invalid(
            "request has neither PUSH_COMMIT nor PULL_HEADER frames",
        ));
    }
    Ok(frames)
}

/// The open section of a response (§1.4 rule 3).
#[derive(PartialEq)]
enum Section {
    None,
    Unit,
    Live,
}

/// §1.6 grammar: RESP_HEADER, LEASE 0|1, PUSH_RESULT × N, then per unit
/// SUB_START segment frames × m SUB_END, then at most one live section
/// LIVE_START COMMIT × k LIVE_END; ERROR 0|1 anywhere after RESP_HEADER, and
/// if present the next frame MUST be END (no frame of any type, unknown
/// included, may follow it). §4.5 "Section order" lists the order errors.
fn decode_response_frames(r: &mut Reader<'_>) -> Result<Vec<Frame>> {
    let mut frames = Vec::new();
    let mut seen_header = false;
    let mut seen_lease = false; // §7.3.2: at most one LEASE, before the body
    let mut seen_body = false; // any non-RESP_HEADER/non-LEASE frame
    let mut section = Section::None;
    let mut seen_section = false; // a unit or live section has started
    let mut seen_live = false;
    let mut error_seen = false;
    let mut last_push_result: Option<(String, bool, Vec<i32>)> = None;
    let mut last_push_result_has_details = false;

    while let Some((ty, payload)) = next_frame(r)? {
        if error_seen {
            return Err(DecodeError::invalid(
                "frame after ERROR: the next frame after ERROR must be END",
            ));
        }
        let known = classify(ty, MsgKind::Response)?;
        if !known {
            if !seen_header {
                return Err(DecodeError::invalid(
                    "unknown frame before RESP_HEADER (unknown frames are only legal between the header frame and END)",
                ));
            }
            frames.push(Frame::Unknown {
                frame_type: ty,
                payload: payload.to_vec(),
            });
            seen_body = true;
            last_push_result = None;
            continue;
        }
        if !seen_header {
            if ty != ft::RESP_HEADER {
                return Err(DecodeError::invalid(
                    "first frame of a response must be RESP_HEADER",
                ));
            }
            frames.push(decode_resp_header(payload)?);
            seen_header = true;
            continue;
        }
        match ty {
            ft::RESP_HEADER => {
                return Err(DecodeError::invalid("duplicate RESP_HEADER frame"));
            }
            ft::LEASE => {
                // §7.3.2: at most one LEASE, immediately after RESP_HEADER.
                if seen_lease {
                    return Err(DecodeError::invalid("duplicate LEASE frame"));
                }
                if seen_body {
                    return Err(DecodeError::invalid(
                        "LEASE frame must immediately follow RESP_HEADER",
                    ));
                }
                frames.push(decode_lease(payload)?);
                seen_lease = true;
            }
            ft::PUSH_RESULT => {
                if seen_section {
                    return Err(DecodeError::invalid(
                        "PUSH_RESULT after a unit or live section (out of grammar order)",
                    ));
                }
                let frame = decode_push_result(payload)?;
                if let Frame::PushResult {
                    client_commit_id,
                    status,
                    results,
                    ..
                } = &frame
                {
                    let error_indexes = results
                        .iter()
                        .filter_map(|result| match result {
                            OpResult::Error { op_index, .. } => Some(*op_index),
                            _ => None,
                        })
                        .collect();
                    last_push_result = Some((
                        client_commit_id.clone(),
                        *status == PushStatus::Rejected,
                        error_indexes,
                    ));
                    last_push_result_has_details = false;
                }
                frames.push(frame);
                seen_body = true;
            }
            ft::PUSH_RESULT_DETAILS => {
                if seen_section {
                    return Err(DecodeError::invalid(
                        "PUSH_RESULT_DETAILS after a unit or live section (out of grammar order)",
                    ));
                }
                let frame = decode_push_result_details(payload)?;
                let Some((result_commit_id, result_rejected, error_indexes)) = &last_push_result
                else {
                    return Err(DecodeError::invalid(
                        "PUSH_RESULT_DETAILS without a preceding PUSH_RESULT",
                    ));
                };
                if last_push_result_has_details {
                    return Err(DecodeError::invalid(
                        "duplicate PUSH_RESULT_DETAILS companion",
                    ));
                }
                if let Frame::PushResultDetails {
                    client_commit_id,
                    entries,
                } = &frame
                {
                    if !*result_rejected || client_commit_id != result_commit_id {
                        return Err(DecodeError::invalid(
                            "PUSH_RESULT_DETAILS does not match its rejected PUSH_RESULT",
                        ));
                    }
                    if entries
                        .iter()
                        .any(|entry| !error_indexes.contains(&entry.op_index))
                    {
                        return Err(DecodeError::invalid(
                            "PUSH_RESULT_DETAILS entry does not match an error result",
                        ));
                    }
                }
                last_push_result_has_details = true;
                frames.push(frame);
                seen_body = true;
            }
            ft::SUB_START => {
                if section == Section::Unit {
                    return Err(DecodeError::invalid(
                        "SUB_START while a unit section is already open",
                    ));
                }
                if seen_live {
                    return Err(DecodeError::invalid(
                        "SUB_START inside or after the live section",
                    ));
                }
                frames.push(decode_sub_start(payload)?);
                section = Section::Unit;
                seen_section = true;
                seen_body = true;
                last_push_result = None;
            }
            ft::SEGMENT_REF | ft::SEGMENT_INLINE => {
                if section != Section::Unit {
                    return Err(DecodeError::invalid("segment frame outside a unit section"));
                }
                if ty == ft::SEGMENT_REF {
                    frames.push(decode_segment_ref(payload)?);
                } else {
                    // §5.7: the payload must be a structurally valid rows
                    // segment; the raw bytes are preserved for re-encoding.
                    decode_rows_segment(payload)?;
                    frames.push(Frame::SegmentInline {
                        payload: payload.to_vec(),
                    });
                }
                seen_body = true;
            }
            ft::SUB_END => {
                if section != Section::Unit {
                    return Err(DecodeError::invalid("SUB_END without an open unit section"));
                }
                frames.push(decode_sub_end(payload)?);
                section = Section::None;
                seen_body = true;
            }
            ft::LIVE_START => {
                if section == Section::Unit {
                    return Err(DecodeError::invalid("LIVE_START inside a unit section"));
                }
                if seen_live {
                    return Err(DecodeError::invalid("second LIVE_START frame"));
                }
                frames.push(decode_live_start(payload)?);
                section = Section::Live;
                seen_section = true;
                seen_live = true;
                seen_body = true;
                last_push_result = None;
            }
            ft::COMMIT => {
                if section != Section::Live {
                    return Err(DecodeError::invalid(
                        "COMMIT frame outside the live section",
                    ));
                }
                frames.push(decode_commit(payload)?);
                seen_body = true;
            }
            ft::LIVE_END => {
                if section != Section::Live {
                    return Err(DecodeError::invalid("LIVE_END without an open LIVE_START"));
                }
                frames.push(decode_live_end(payload)?);
                section = Section::None;
                seen_body = true;
            }
            ft::ERROR => {
                frames.push(decode_error_frame(payload)?);
                error_seen = true;
                seen_body = true;
            }
            _ => unreachable!("classified as known response type"),
        }
    }
    if !seen_header {
        return Err(DecodeError::invalid("response has no RESP_HEADER frame"));
    }
    if section != Section::None && !error_seen {
        return Err(DecodeError::invalid(
            "message ended with an open unit or live section",
        ));
    }
    Ok(frames)
}

/// Run `parse` over a frame payload; trailing bytes inside a known frame are
/// a decode error (§1.2 rule 3).
fn frame_payload<T>(
    payload: &[u8],
    name: &str,
    parse: impl FnOnce(&mut Reader<'_>) -> Result<T>,
) -> Result<T> {
    let mut r = Reader::new(payload);
    let value = parse(&mut r)?;
    if !r.is_empty() {
        return Err(DecodeError::invalid(format!(
            "trailing bytes inside {name} frame ({} bytes unconsumed)",
            r.remaining()
        )));
    }
    Ok(value)
}

fn decode_req_header(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "REQ_HEADER", |r| {
        let client_id = r.str("clientId")?;
        if client_id.is_empty() {
            return Err(DecodeError::invalid("clientId must be non-empty"));
        }
        let schema_version = r.i32("schemaVersion")?;
        if schema_version < 1 {
            return Err(DecodeError::invalid(format!(
                "schemaVersion must be ≥ 1, got {schema_version}"
            )));
        }
        let log_epoch = if r.presence("logEpoch")? {
            let value = r.str("logEpoch")?;
            if value.is_empty() {
                return Err(DecodeError::invalid(
                    "REQ_HEADER.logEpoch must be non-empty",
                ));
            }
            Some(value)
        } else {
            None
        };
        let outbox_id = if r.presence("outboxId")? {
            let value = r.str("outboxId")?;
            if !valid_outbox_id(&value) {
                return Err(DecodeError::invalid(
                    "REQ_HEADER.outboxId must be non-empty and at most 64 bytes",
                ));
            }
            Some(value)
        } else {
            None
        };
        Ok(Frame::ReqHeader {
            client_id,
            schema_version,
            log_epoch,
            outbox_id,
        })
    })
}

fn decode_round_failure(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "ROUND_FAILURE", |r| {
        let code = r.str("code")?;
        if !valid_round_failure_code(&code) {
            return Err(DecodeError::invalid(format!(
                "ROUND_FAILURE.code {code:?} is not a lowercase dotted code of at most 64 bytes"
            )));
        }
        Ok(Frame::RoundFailure { code })
    })
}

fn decode_op(r: &mut Reader<'_>) -> Result<Op> {
    match r.u8("op")? {
        1 => Ok(Op::Upsert),
        2 => Ok(Op::Delete),
        other => Err(DecodeError::invalid(format!("unknown op byte {other}"))),
    }
}

fn decode_push_commit(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "PUSH_COMMIT", |r| {
        let client_commit_id = r.str("clientCommitId")?;
        if client_commit_id.is_empty() {
            return Err(DecodeError::invalid("clientCommitId must be non-empty"));
        }
        let client_seq = r.i64("clientSeq")?;
        if client_seq < 0 {
            return Err(DecodeError::invalid("PUSH_COMMIT.clientSeq must be >= 0"));
        }
        let count = r.u32("operations count")? as usize;
        if count == 0 {
            return Err(DecodeError::empty_commit(
                "PUSH_COMMIT with zero operations",
            ));
        }
        let mut operations = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            let table = r.str("operation table")?;
            let row_id = r.str("operation rowId")?;
            let op = decode_op(r)?;
            let base_version = if r.presence("baseVersion")? {
                Some(r.i64("baseVersion")?)
            } else {
                None
            };
            let payload_bytes = if r.presence("payload")? {
                Some(r.bytes("payload")?)
            } else {
                None
            };
            // §6.1 presence tie: payload present iff upsert.
            match op {
                Op::Upsert if payload_bytes.is_none() => {
                    return Err(DecodeError::invalid(
                        "upsert operation without a payload (presence invariant)",
                    ));
                }
                Op::Delete if payload_bytes.is_some() => {
                    return Err(DecodeError::invalid(
                        "delete operation with a payload (presence invariant)",
                    ));
                }
                _ => {}
            }
            operations.push(Operation {
                table,
                row_id,
                op,
                base_version,
                payload: payload_bytes,
            });
        }
        Ok(Frame::PushCommit {
            client_commit_id,
            client_seq,
            operations,
        })
    })
}

fn decode_pull_header(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "PULL_HEADER", |r| {
        let limit_commits = r.i32("limitCommits")?;
        let limit_snapshot_rows = r.i32("limitSnapshotRows")?;
        let max_snapshot_pages = r.i32("maxSnapshotPages")?;
        let accept = r.u8("accept")?;
        if accept & 0xF0 != 0 {
            return Err(DecodeError::invalid(format!(
                "accept bits 4–7 must be zero, got 0b{accept:08b}"
            )));
        }
        let cursor = r.i64("cursor")?;
        if cursor < -1 {
            return Err(DecodeError::invalid("PULL_HEADER.cursor must be >= -1"));
        }
        let registration_digest = r
            .bytes("registrationDigest")?
            .try_into()
            .map_err(|_| DecodeError::invalid("PULL_HEADER.registrationDigest must be 32 bytes"))?;
        let echo_digest = read_echo_digest(r, "PULL_HEADER.echoDigest")?;
        Ok(Frame::PullHeader {
            limit_commits,
            limit_snapshot_rows,
            max_snapshot_pages,
            accept,
            cursor,
            registration_digest,
            echo_digest,
        })
    })
}

/// §4.2, §4.4: an echo digest is empty or 32 bytes.
fn read_echo_digest(r: &mut Reader<'_>, field: &str) -> Result<Option<[u8; 32]>> {
    let bytes = r.bytes(field)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    bytes
        .try_into()
        .map(Some)
        .map_err(|_| DecodeError::invalid(format!("{field} must be 0 or 32 bytes")))
}

fn decode_progress(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "PROGRESS", |r| {
        let id = r.str("id")?;
        if !valid_unit_id(&id) {
            return Err(DecodeError::invalid(
                "PROGRESS.id must be 32 lowercase hex characters",
            ));
        }
        let cursor = r.i64("cursor")?;
        if cursor < -1 {
            return Err(DecodeError::invalid("PROGRESS.cursor must be >= -1"));
        }
        let bootstrap_state = if r.presence("bootstrapState")? {
            Some(r.json("bootstrapState")?)
        } else {
            None
        };
        Ok(Frame::Progress {
            id,
            cursor,
            bootstrap_state,
        })
    })
}

fn decode_resp_header(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "RESP_HEADER", |r| {
        let required_schema_version = if r.presence("requiredSchemaVersion")? {
            Some(r.i32("requiredSchemaVersion")?)
        } else {
            None
        };
        let latest_schema_version = if r.presence("latestSchemaVersion")? {
            Some(r.i32("latestSchemaVersion")?)
        } else {
            None
        };
        let log_epoch = r.str("logEpoch")?;
        if log_epoch.is_empty() {
            return Err(DecodeError::invalid(
                "RESP_HEADER.logEpoch must be non-empty",
            ));
        }
        let reset_required = r.bool("resetRequired")?;
        Ok(Frame::RespHeader {
            required_schema_version,
            latest_schema_version,
            log_epoch,
            reset_required,
        })
    })
}

fn decode_lease(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "LEASE", |r| {
        let lease_id = r.str("leaseId")?;
        if lease_id.is_empty() {
            return Err(DecodeError::invalid("LEASE.leaseId must be non-empty"));
        }
        let expires_at_ms = r.i64("expiresAtMs")?;
        Ok(Frame::Lease {
            lease_id,
            expires_at_ms,
        })
    })
}

fn decode_push_result(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "PUSH_RESULT", |r| {
        let client_commit_id = r.str("clientCommitId")?;
        let status = match r.u8("status")? {
            1 => PushStatus::Applied,
            2 => PushStatus::Cached,
            3 => PushStatus::Rejected,
            other => {
                return Err(DecodeError::invalid(format!(
                    "unknown PUSH_RESULT status byte {other}"
                )))
            }
        };
        let commit_seq = if r.presence("commitSeq")? {
            Some(r.i64("commitSeq")?)
        } else {
            None
        };
        // §6.3 presence tie: commitSeq present for applied/cached, absent for
        // rejected.
        match status {
            PushStatus::Rejected if commit_seq.is_some() => {
                return Err(DecodeError::invalid(
                    "commitSeq present on a rejected PUSH_RESULT (presence invariant)",
                ));
            }
            PushStatus::Applied | PushStatus::Cached if commit_seq.is_none() => {
                return Err(DecodeError::invalid(
                    "commitSeq absent on an applied/cached PUSH_RESULT (presence invariant)",
                ));
            }
            _ => {}
        }
        let count = r.u32("results count")? as usize;
        let mut results = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            let op_index = r.i32("opIndex")?;
            results.push(match r.u8("result status")? {
                1 => OpResult::Applied { op_index },
                2 => OpResult::Conflict {
                    op_index,
                    code: r.str("conflict code")?,
                    message: r.str("conflict message")?,
                    server_version: r.i64("serverVersion")?,
                    server_row: r.bytes("serverRow")?,
                    conflict_columns: r.bytes("conflictColumns")?,
                },
                3 => OpResult::Error {
                    op_index,
                    code: r.str("error code")?,
                    message: r.str("error message")?,
                    retryable: r.bool("retryable")?,
                },
                other => {
                    return Err(DecodeError::invalid(format!(
                        "unknown result record status byte {other}"
                    )))
                }
            });
        }
        Ok(Frame::PushResult {
            client_commit_id,
            status,
            commit_seq,
            results,
        })
    })
}

fn valid_detail_identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn valid_detail_token(token: &str, max: usize) -> bool {
    if token.is_empty() || token.len() > max || !token.starts_with(|c: char| c.is_ascii_lowercase())
    {
        return false;
    }
    let mut prev_sep = false;
    for c in token.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            prev_sep = false;
        } else if matches!(c, '.' | '_' | '-') && !prev_sep {
            prev_sep = true;
        } else {
            return false;
        }
    }
    !prev_sep
}

fn validate_rejection_details(raw: &str) -> Result<()> {
    if raw.len() > 4_096 {
        return Err(DecodeError::invalid(
            "PUSH_RESULT_DETAILS.details exceeds 4096 encoded bytes",
        ));
    }
    let val: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| DecodeError::invalid(format!("invalid PUSH_RESULT_DETAILS.details: {e}")))?;
    let Some(obj) = val.as_object() else {
        return Err(DecodeError::invalid(
            "PUSH_RESULT_DETAILS.details must be a JSON object",
        ));
    };
    if obj.is_empty() {
        return Err(DecodeError::invalid(
            "PUSH_RESULT_DETAILS.details must not be empty",
        ));
    }
    for (k, v) in obj {
        match k.as_str() {
            "fieldPaths" => {
                let Some(arr) = v.as_array() else {
                    return Err(DecodeError::invalid("fieldPaths must be an array"));
                };
                if arr.is_empty() || arr.len() > 32 {
                    return Err(DecodeError::invalid("fieldPaths must contain 1-32 paths"));
                }
                let mut seen = std::collections::BTreeSet::new();
                for item in arr {
                    let Some(s) = item.as_str() else {
                        return Err(DecodeError::invalid("fieldPaths entries must be strings"));
                    };
                    if s.is_empty()
                        || s.len() > 160
                        || !s.split('.').all(valid_detail_identifier)
                        || !seen.insert(s)
                    {
                        return Err(DecodeError::invalid(
                            "fieldPaths contains an invalid or duplicate path",
                        ));
                    }
                }
            }
            "reason" | "requiredAction" => {
                let Some(s) = v.as_str() else {
                    return Err(DecodeError::invalid(format!("{k} must be a string")));
                };
                if !valid_detail_token(s, 96) {
                    return Err(DecodeError::invalid(format!(
                        "{k} must be a lowercase stable token"
                    )));
                }
            }
            "references" => {
                let Some(refs) = v.as_object() else {
                    return Err(DecodeError::invalid("references must be a JSON object"));
                };
                if refs.is_empty() || refs.len() > 16 {
                    return Err(DecodeError::invalid("references must contain 1-16 entries"));
                }
                for (rk, rv) in refs {
                    let Some(rvs) = rv.as_str() else {
                        return Err(DecodeError::invalid("references values must be strings"));
                    };
                    if !valid_detail_token(rk, 64)
                        || rvs.is_empty()
                        || rvs.len() > 256
                        || rvs.trim() != rvs
                        || rvs.chars().any(char::is_control)
                    {
                        return Err(DecodeError::invalid(
                            "references contains an invalid key or value",
                        ));
                    }
                }
            }
            other => {
                return Err(DecodeError::invalid(format!(
                    "unknown rejection details member {other:?}"
                )));
            }
        }
    }
    Ok(())
}

fn decode_push_result_details(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "PUSH_RESULT_DETAILS", |r| {
        let client_commit_id = r.str("clientCommitId")?;
        if client_commit_id.is_empty() {
            return Err(DecodeError::invalid(
                "PUSH_RESULT_DETAILS.clientCommitId must be non-empty",
            ));
        }
        let count = r.u32("entries count")? as usize;
        if count == 0 {
            return Err(DecodeError::invalid(
                "PUSH_RESULT_DETAILS must carry at least one entry",
            ));
        }
        let mut entries = Vec::with_capacity(count.min(64));
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..count {
            let op_index = r.i32("opIndex")?;
            if op_index < 0 || !seen.insert(op_index) {
                return Err(DecodeError::invalid(
                    "PUSH_RESULT_DETAILS opIndex values must be unique and non-negative",
                ));
            }
            let details = r.json("details")?;
            validate_rejection_details(&details.0)?;
            entries.push(crate::model::PushResultDetail { op_index, details });
        }
        Ok(Frame::PushResultDetails {
            client_commit_id,
            entries,
        })
    })
}

fn decode_sub_start(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "SUB_START", |r| {
        let id = r.str("id")?;
        if !valid_unit_id(&id) {
            return Err(DecodeError::invalid(
                "SUB_START.id must be 32 lowercase hex characters",
            ));
        }
        let status = match r.u8("status")? {
            1 => SubStatus::Active,
            2 => SubStatus::Revoked,
            3 => SubStatus::Reset,
            other => {
                return Err(DecodeError::invalid(format!(
                    "unknown SUB_START status byte {other}"
                )))
            }
        };
        let reason_code = r.str("reasonCode")?;
        let bootstrap = r.bool("bootstrap")?;
        let count = r.u32("fenced count")? as usize;
        let mut fenced = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            fenced.push(FencedRecord {
                table: r.str("fenced table")?,
                status: match r.u8("fenced status")? {
                    1 => EchoStatus::Active,
                    2 => EchoStatus::Revoked,
                    other => {
                        return Err(DecodeError::invalid(format!(
                            "unknown fenced record status byte {other}"
                        )))
                    }
                },
                scopes: r.scope_map("fenced scopes")?,
            });
        }
        if !fenced_in_order(&fenced) {
            return Err(DecodeError::invalid(
                "SUB_START.fenced tables must be unique and in ascending order",
            ));
        }
        Ok(Frame::SubStart {
            id,
            status,
            reason_code,
            bootstrap,
            fenced,
        })
    })
}

fn decode_live_start(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "LIVE_START", |r| {
        let status = match r.u8("status")? {
            1 => LiveStatus::Active,
            3 => LiveStatus::Reset,
            4 => LiveStatus::Unregistered,
            other => {
                return Err(DecodeError::invalid(format!(
                    "unknown LIVE_START status byte {other}"
                )))
            }
        };
        Ok(Frame::LiveStart {
            status,
            reason_code: r.str("reasonCode")?,
        })
    })
}

fn decode_live_end(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "LIVE_END", |r| {
        Ok(Frame::LiveEnd {
            through_seq: r.i64("throughSeq")?,
            echo_digest: read_echo_digest(r, "LIVE_END.echoDigest")?,
        })
    })
}

fn decode_commit(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "COMMIT", |r| {
        let commit_seq = r.i64("commitSeq")?;
        let created_at_ms = r.i64("createdAtMs")?;
        let actor_id = r.str("actorId")?;
        let table_count = r.u32("tables count")? as usize;
        let mut tables = Vec::with_capacity(table_count.min(4096));
        for _ in 0..table_count {
            tables.push(r.str("table")?);
        }
        let change_count = r.u32("changes count")? as usize;
        let mut changes = Vec::with_capacity(change_count.min(4096));
        for _ in 0..change_count {
            let table_index = r.u16("tableIndex")?;
            if table_index as usize >= tables.len() {
                return Err(DecodeError::invalid(format!(
                    "change tableIndex {table_index} out of range (tables: {})",
                    tables.len()
                )));
            }
            let row_id = r.str("rowId")?;
            let op = decode_op(r)?;
            let row_version = r.i64("rowVersion")?;
            if row_version < 1 {
                return Err(DecodeError::invalid("change rowVersion must be at least 1"));
            }
            let scopes = r.str_map("change scopes")?;
            let row = if r.presence("row")? {
                Some(r.bytes("row")?)
            } else {
                None
            };
            // §4.5 presence tie: row present iff upsert.
            if row.is_some() != (op == Op::Upsert) {
                return Err(DecodeError::invalid(
                    "change row presence does not match op (presence invariant)",
                ));
            }
            changes.push(Change {
                table_index,
                row_id,
                op,
                row_version,
                scopes,
                row,
            });
        }
        Ok(Frame::Commit {
            commit_seq,
            created_at_ms,
            actor_id,
            tables,
            changes,
        })
    })
}

fn decode_segment_ref(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "SEGMENT_REF", |r| {
        let segment_id = r.str("segmentId")?;
        let media_type = match r.u8("mediaType")? {
            1 => MediaType::Rows,
            2 => MediaType::Sqlite,
            other => {
                return Err(DecodeError::invalid(format!(
                    "unknown mediaType byte {other}"
                )))
            }
        };
        let table = r.str("table")?;
        let byte_length = r.i64("byteLength")?;
        let row_count = r.i64("rowCount")?;
        let as_of_commit_seq = r.i64("asOfCommitSeq")?;
        let scope_digest = r.str("scopeDigest")?;
        let row_cursor = if r.presence("rowCursor")? {
            Some(r.str("rowCursor")?)
        } else {
            None
        };
        let next_row_cursor = if r.presence("nextRowCursor")? {
            Some(r.str("nextRowCursor")?)
        } else {
            None
        };
        let url = if r.presence("url")? {
            Some(r.str("url")?)
        } else {
            None
        };
        let url_expires_at_ms = if r.presence("urlExpiresAtMs")? {
            Some(r.i64("urlExpiresAtMs")?)
        } else {
            None
        };
        // §5.4 presence tie: urlExpiresAtMs present iff url is.
        if url.is_some() != url_expires_at_ms.is_some() {
            return Err(DecodeError::invalid(
                "url and urlExpiresAtMs must be present together (presence invariant)",
            ));
        }
        Ok(Frame::SegmentRef {
            segment_id,
            media_type,
            table,
            byte_length,
            row_count,
            as_of_commit_seq,
            scope_digest,
            row_cursor,
            next_row_cursor,
            url,
            url_expires_at_ms,
        })
    })
}

fn decode_sub_end(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "SUB_END", |r| {
        let next_cursor = r.i64("nextCursor")?;
        let bootstrap_state = if r.presence("bootstrapState")? {
            Some(r.json("bootstrapState")?)
        } else {
            None
        };
        Ok(Frame::SubEnd {
            next_cursor,
            bootstrap_state,
        })
    })
}

fn decode_error_frame(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "ERROR", |r| {
        let code = r.str("code")?;
        let message = r.str("message")?;
        let category = r.str("category")?;
        let retryable = r.bool("retryable")?;
        let recommended_action = r.str("recommendedAction")?;
        let details = if r.presence("details")? {
            Some(r.json("details")?)
        } else {
            None
        };
        Ok(Frame::Error {
            code,
            message,
            category,
            retryable,
            recommended_action,
            details,
        })
    })
}
