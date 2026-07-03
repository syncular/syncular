//! Canonical SSP2 encoding (SPEC.md §1.2). Re-encoding a decoded message
//! reproduces the input byte-for-byte: raw `json` strings, map entry order,
//! and unknown frames are all preserved by the model.

use crate::decode::{SSP2_MAGIC, WIRE_VERSION};
use crate::model::frame_type as ft;
use crate::model::{Frame, MediaType, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
use crate::primitives::Writer;

pub fn encode_message(msg: &Message) -> Vec<u8> {
    let mut w = Writer::new();
    w.raw(SSP2_MAGIC);
    w.u16(WIRE_VERSION);
    w.u8(match msg.msg_kind {
        MsgKind::Request => 0x01,
        MsgKind::Response => 0x02,
    });
    w.u8(0x00); // flags
    for frame in &msg.frames {
        let (ty, payload) = encode_frame(frame);
        w.u8(ty);
        w.u32(payload.len() as u32);
        w.raw(&payload);
    }
    w.u8(ft::END);
    w.u32(0);
    w.into_bytes()
}

fn op_byte(op: Op) -> u8 {
    match op {
        Op::Upsert => 1,
        Op::Delete => 2,
    }
}

fn encode_frame(frame: &Frame) -> (u8, Vec<u8>) {
    let mut w = Writer::new();
    let ty = match frame {
        Frame::ReqHeader {
            client_id,
            schema_version,
        } => {
            w.str(client_id);
            w.i32(*schema_version);
            ft::REQ_HEADER
        }
        Frame::PushCommit {
            client_commit_id,
            operations,
        } => {
            w.str(client_commit_id);
            w.u32(operations.len() as u32);
            for op in operations {
                w.str(&op.table);
                w.str(&op.row_id);
                w.u8(op_byte(op.op));
                w.opt(&op.base_version, |w, v| w.i64(*v));
                w.opt(&op.payload, |w, p| w.bytes(p));
            }
            ft::PUSH_COMMIT
        }
        Frame::PullHeader {
            limit_commits,
            limit_snapshot_rows,
            max_snapshot_pages,
            accept,
        } => {
            w.i32(*limit_commits);
            w.i32(*limit_snapshot_rows);
            w.i32(*max_snapshot_pages);
            w.u8(*accept);
            ft::PULL_HEADER
        }
        Frame::Subscription {
            id,
            table,
            scopes,
            params,
            cursor,
            bootstrap_state,
        } => {
            w.str(id);
            w.str(table);
            w.scope_map(scopes);
            w.opt(params, |w, j| w.str(&j.0));
            w.i64(*cursor);
            w.opt(bootstrap_state, |w, j| w.str(&j.0));
            ft::SUBSCRIPTION
        }
        Frame::RespHeader {
            required_schema_version,
            latest_schema_version,
        } => {
            w.opt(required_schema_version, |w, v| w.i32(*v));
            w.opt(latest_schema_version, |w, v| w.i32(*v));
            ft::RESP_HEADER
        }
        Frame::PushResult {
            client_commit_id,
            status,
            commit_seq,
            results,
        } => {
            w.str(client_commit_id);
            w.u8(match status {
                PushStatus::Applied => 1,
                PushStatus::Cached => 2,
                PushStatus::Rejected => 3,
            });
            w.opt(commit_seq, |w, v| w.i64(*v));
            w.u32(results.len() as u32);
            for result in results {
                match result {
                    OpResult::Applied { op_index } => {
                        w.i32(*op_index);
                        w.u8(1);
                    }
                    OpResult::Conflict {
                        op_index,
                        code,
                        message,
                        server_version,
                        server_row,
                    } => {
                        w.i32(*op_index);
                        w.u8(2);
                        w.str(code);
                        w.str(message);
                        w.i64(*server_version);
                        w.bytes(server_row);
                    }
                    OpResult::Error {
                        op_index,
                        code,
                        message,
                        retryable,
                    } => {
                        w.i32(*op_index);
                        w.u8(3);
                        w.str(code);
                        w.str(message);
                        w.bool(*retryable);
                    }
                }
            }
            ft::PUSH_RESULT
        }
        Frame::SubStart {
            id,
            status,
            reason_code,
            effective_scopes,
            bootstrap,
        } => {
            w.str(id);
            w.u8(match status {
                SubStatus::Active => 1,
                SubStatus::Revoked => 2,
                SubStatus::Reset => 3,
            });
            w.str(reason_code);
            w.scope_map(effective_scopes);
            w.bool(*bootstrap);
            ft::SUB_START
        }
        Frame::Commit {
            commit_seq,
            created_at_ms,
            actor_id,
            tables,
            changes,
        } => {
            w.i64(*commit_seq);
            w.i64(*created_at_ms);
            w.str(actor_id);
            w.u32(tables.len() as u32);
            for table in tables {
                w.str(table);
            }
            w.u32(changes.len() as u32);
            for change in changes {
                w.u16(change.table_index);
                w.str(&change.row_id);
                w.u8(op_byte(change.op));
                w.opt(&change.row_version, |w, v| w.i64(*v));
                w.str_map(&change.scopes);
                w.opt(&change.row, |w, row| w.bytes(row));
            }
            ft::COMMIT
        }
        Frame::SegmentRef {
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
        } => {
            w.str(segment_id);
            w.u8(match media_type {
                MediaType::Rows => 1,
                MediaType::Sqlite => 2,
            });
            w.str(table);
            w.i64(*byte_length);
            w.i64(*row_count);
            w.i64(*as_of_commit_seq);
            w.str(scope_digest);
            w.opt(row_cursor, |w, s| w.str(s));
            w.opt(next_row_cursor, |w, s| w.str(s));
            w.opt(url, |w, s| w.str(s));
            w.opt(url_expires_at_ms, |w, v| w.i64(*v));
            ft::SEGMENT_REF
        }
        Frame::SegmentInline { payload } => {
            w.raw(payload);
            ft::SEGMENT_INLINE
        }
        Frame::SubEnd {
            next_cursor,
            bootstrap_state,
        } => {
            w.i64(*next_cursor);
            w.opt(bootstrap_state, |w, j| w.str(&j.0));
            ft::SUB_END
        }
        Frame::Error {
            code,
            message,
            category,
            retryable,
            recommended_action,
            details,
        } => {
            w.str(code);
            w.str(message);
            w.str(category);
            w.bool(*retryable);
            w.str(recommended_action);
            w.opt(details, |w, j| w.str(&j.0));
            ft::ERROR
        }
        Frame::Unknown {
            frame_type,
            payload,
        } => {
            w.raw(payload);
            *frame_type
        }
    };
    (ty, w.into_bytes())
}
