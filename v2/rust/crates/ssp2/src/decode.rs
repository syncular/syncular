//! SSP2 envelope decoding (SPEC.md §1.2), request/response frame grammar
//! (§1.5, §1.6), and the closed decode-error boundary of §1.7: exactly the
//! listed violations are rejected here, nothing more.

use crate::error::{DecodeError, Result};
use crate::model::frame_type as ft;
use crate::model::{
    Change, Frame, MediaType, Message, MsgKind, Op, OpResult, Operation, PushStatus, SubStatus,
};
use crate::primitives::Reader;
use crate::segment::decode_rows_segment;

pub const SSP2_MAGIC: &[u8; 4] = b"SSP2";
pub const WIRE_VERSION: u16 = 1;

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
    Ok(Message { msg_kind, frames })
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

/// §1.5 grammar: REQ_HEADER, PUSH_COMMIT × N, PULL_HEADER 0|1,
/// SUBSCRIPTION × M (only if PULL_HEADER present), END. A request with
/// neither push nor pull frames is invalid.
fn decode_request_frames(r: &mut Reader<'_>) -> Result<Vec<Frame>> {
    let mut frames = Vec::new();
    let mut seen_header = false;
    let mut seen_pull = false;
    let mut seen_push = false;

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
            ft::PUSH_COMMIT => {
                if seen_pull {
                    return Err(DecodeError::invalid(
                        "PUSH_COMMIT after PULL_HEADER (out of grammar order)",
                    ));
                }
                frames.push(decode_push_commit(payload)?);
                seen_push = true;
            }
            ft::PULL_HEADER => {
                if seen_pull {
                    return Err(DecodeError::invalid("duplicate PULL_HEADER frame"));
                }
                frames.push(decode_pull_header(payload)?);
                seen_pull = true;
            }
            ft::SUBSCRIPTION => {
                if !seen_pull {
                    return Err(DecodeError::invalid(
                        "SUBSCRIPTION frame without a preceding PULL_HEADER",
                    ));
                }
                frames.push(decode_subscription(payload)?);
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

/// §1.6 grammar: RESP_HEADER, PUSH_RESULT × N, then per subscription
/// SUB_START (COMMIT × k | segment frames × m) SUB_END; ERROR 0|1 anywhere
/// after RESP_HEADER, and if present the next frame MUST be END (no frame of
/// any type, unknown included, may follow it).
fn decode_response_frames(r: &mut Reader<'_>) -> Result<Vec<Frame>> {
    let mut frames = Vec::new();
    let mut seen_header = false;
    let mut seen_lease = false; // §7.3.2: at most one LEASE, before the body
    let mut seen_body = false; // any non-RESP_HEADER/non-LEASE frame
    let mut past_results = false; // a SUB_START has been seen
    let mut sub_open = false;
    let mut sub_seen_commit = false;
    let mut sub_seen_segment = false;
    let mut error_seen = false;

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
                if past_results {
                    return Err(DecodeError::invalid(
                        "PUSH_RESULT after a SUB_START (out of grammar order)",
                    ));
                }
                frames.push(decode_push_result(payload)?);
                seen_body = true;
            }
            ft::SUB_START => {
                if sub_open {
                    return Err(DecodeError::invalid(
                        "SUB_START while a subscription context is already open",
                    ));
                }
                frames.push(decode_sub_start(payload)?);
                past_results = true;
                seen_body = true;
                sub_open = true;
                sub_seen_commit = false;
                sub_seen_segment = false;
            }
            ft::COMMIT => {
                if !sub_open {
                    return Err(DecodeError::invalid(
                        "COMMIT frame outside an open subscription context",
                    ));
                }
                if sub_seen_segment {
                    return Err(DecodeError::invalid(
                        "COMMIT and segment frames must not both appear for one subscription",
                    ));
                }
                frames.push(decode_commit(payload)?);
                sub_seen_commit = true;
                seen_body = true;
            }
            ft::SEGMENT_REF | ft::SEGMENT_INLINE => {
                if !sub_open {
                    return Err(DecodeError::invalid(
                        "segment frame outside an open subscription context",
                    ));
                }
                if sub_seen_commit {
                    return Err(DecodeError::invalid(
                        "COMMIT and segment frames must not both appear for one subscription",
                    ));
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
                sub_seen_segment = true;
                seen_body = true;
            }
            ft::SUB_END => {
                if !sub_open {
                    return Err(DecodeError::invalid(
                        "SUB_END without an open subscription context",
                    ));
                }
                frames.push(decode_sub_end(payload)?);
                sub_open = false;
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
    if sub_open && !error_seen {
        return Err(DecodeError::invalid(
            "message ended with an open subscription context (missing SUB_END)",
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
        Ok(Frame::ReqHeader {
            client_id,
            schema_version,
        })
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
        Ok(Frame::PullHeader {
            limit_commits,
            limit_snapshot_rows,
            max_snapshot_pages,
            accept,
        })
    })
}

fn decode_subscription(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "SUBSCRIPTION", |r| {
        let id = r.str("id")?;
        let table = r.str("table")?;
        let scopes = r.scope_map("scopes")?;
        let params = if r.presence("params")? {
            Some(r.json("params")?)
        } else {
            None
        };
        let cursor = r.i64("cursor")?;
        let bootstrap_state = if r.presence("bootstrapState")? {
            Some(r.json("bootstrapState")?)
        } else {
            None
        };
        Ok(Frame::Subscription {
            id,
            table,
            scopes,
            params,
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
        Ok(Frame::RespHeader {
            required_schema_version,
            latest_schema_version,
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

fn decode_sub_start(payload: &[u8]) -> Result<Frame> {
    frame_payload(payload, "SUB_START", |r| {
        let id = r.str("id")?;
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
        let effective_scopes = r.scope_map("effectiveScopes")?;
        let bootstrap = r.bool("bootstrap")?;
        Ok(Frame::SubStart {
            id,
            status,
            reason_code,
            effective_scopes,
            bootstrap,
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
            let row_version = if r.presence("rowVersion")? {
                Some(r.i64("rowVersion")?)
            } else {
                None
            };
            let scopes = r.str_map("change scopes")?;
            let row = if r.presence("row")? {
                Some(r.bytes("row")?)
            } else {
                None
            };
            // §4.5 presence ties: rowVersion and row present iff upsert.
            let ok = match op {
                Op::Upsert => row_version.is_some() && row.is_some(),
                Op::Delete => row_version.is_none() && row.is_none(),
            };
            if !ok {
                return Err(DecodeError::invalid(
                    "change rowVersion/row presence does not match op (presence invariant)",
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
