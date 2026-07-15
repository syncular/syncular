//! Canonical JSON debug rendering (SPEC.md §11.1). Non-contractual for the
//! wire; contractual for golden vectors — rendered values must deep-equal the
//! committed `.json` files when parsed as JSON.

use serde_json::{Map, Value};

use crate::model::{Frame, Message, MsgKind, OpResult};
use crate::segment::{ColumnValue, RowsSegment};
use crate::util::base64;

fn obj(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (k, v) in entries {
        map.insert(k.to_string(), v);
    }
    Value::Object(map)
}

fn scope_map_value(scopes: &[(String, Vec<String>)]) -> Value {
    let mut map = Map::new();
    for (k, vs) in scopes {
        map.insert(
            k.clone(),
            Value::Array(vs.iter().map(|v| Value::String(v.clone())).collect()),
        );
    }
    Value::Object(map)
}

/// Render a decoded message per §11.1 rule 1: one JSON document, frames in
/// wire order, `END` omitted.
pub fn render_message(msg: &Message) -> Value {
    obj(vec![
        ("magic", Value::from("SSP2")),
        ("wireVersion", Value::from(1)),
        (
            "msgKind",
            Value::from(match msg.msg_kind {
                MsgKind::Request => "request",
                MsgKind::Response => "response",
            }),
        ),
        (
            "frames",
            Value::Array(msg.frames.iter().map(render_frame).collect()),
        ),
    ])
}

fn render_frame(frame: &Frame) -> Value {
    // Rule 2: field order follows the SPEC field tables (JSON object key
    // order is irrelevant for deep-equality, but we keep it anyway).
    // Rule 3: absent opt() fields are omitted, never null.
    let mut entries: Vec<(&str, Value)> = Vec::new();
    match frame {
        Frame::ReqHeader {
            client_id,
            schema_version,
        } => {
            entries.push(("type", Value::from("REQ_HEADER")));
            entries.push(("clientId", Value::from(client_id.clone())));
            entries.push(("schemaVersion", Value::from(*schema_version)));
        }
        Frame::PushCommit {
            client_commit_id,
            operations,
        } => {
            entries.push(("type", Value::from("PUSH_COMMIT")));
            entries.push(("clientCommitId", Value::from(client_commit_id.clone())));
            let ops = operations
                .iter()
                .map(|op| {
                    let mut e: Vec<(&str, Value)> = vec![
                        ("table", Value::from(op.table.clone())),
                        ("rowId", Value::from(op.row_id.clone())),
                        ("op", Value::from(op.op.name())),
                    ];
                    if let Some(v) = op.base_version {
                        e.push(("baseVersion", Value::from(v)));
                    }
                    if let Some(p) = &op.payload {
                        e.push(("payload", Value::from(base64(p))));
                    }
                    obj(e)
                })
                .collect();
            entries.push(("operations", Value::Array(ops)));
        }
        Frame::PullHeader {
            limit_commits,
            limit_snapshot_rows,
            max_snapshot_pages,
            accept,
        } => {
            entries.push(("type", Value::from("PULL_HEADER")));
            entries.push(("limitCommits", Value::from(*limit_commits)));
            entries.push(("limitSnapshotRows", Value::from(*limit_snapshot_rows)));
            entries.push(("maxSnapshotPages", Value::from(*max_snapshot_pages)));
            // Rule 5: bitmask fields are not enums; render numerically.
            entries.push(("accept", Value::from(*accept)));
        }
        Frame::Subscription {
            id,
            table,
            scopes,
            params,
            cursor,
            bootstrap_state,
        } => {
            entries.push(("type", Value::from("SUBSCRIPTION")));
            entries.push(("id", Value::from(id.clone())));
            entries.push(("table", Value::from(table.clone())));
            entries.push(("scopes", scope_map_value(scopes)));
            if let Some(p) = params {
                // Rule 7: json-typed fields embed as parsed JSON.
                entries.push(("params", p.parse()));
            }
            entries.push(("cursor", Value::from(*cursor)));
            if let Some(b) = bootstrap_state {
                entries.push(("bootstrapState", b.parse()));
            }
        }
        Frame::RespHeader {
            required_schema_version,
            latest_schema_version,
        } => {
            entries.push(("type", Value::from("RESP_HEADER")));
            if let Some(v) = required_schema_version {
                entries.push(("requiredSchemaVersion", Value::from(*v)));
            }
            if let Some(v) = latest_schema_version {
                entries.push(("latestSchemaVersion", Value::from(*v)));
            }
        }
        Frame::Lease {
            lease_id,
            expires_at_ms,
        } => {
            entries.push(("type", Value::from("LEASE")));
            entries.push(("leaseId", Value::from(lease_id.clone())));
            entries.push(("expiresAtMs", Value::from(*expires_at_ms)));
        }
        Frame::PushResult {
            client_commit_id,
            status,
            commit_seq,
            results,
        } => {
            entries.push(("type", Value::from("PUSH_RESULT")));
            entries.push(("clientCommitId", Value::from(client_commit_id.clone())));
            entries.push(("status", Value::from(status.name())));
            if let Some(v) = commit_seq {
                entries.push(("commitSeq", Value::from(*v)));
            }
            entries.push((
                "results",
                Value::Array(results.iter().map(render_result).collect()),
            ));
        }
        Frame::PushResultDetails {
            client_commit_id,
            entries: details_entries,
        } => {
            entries.push(("type", Value::from("PUSH_RESULT_DETAILS")));
            entries.push(("clientCommitId", Value::from(client_commit_id.clone())));
            entries.push((
                "entries",
                Value::Array(
                    details_entries
                        .iter()
                        .map(|entry| {
                            obj(vec![
                                ("opIndex", Value::from(entry.op_index)),
                                ("details", entry.details.parse()),
                            ])
                        })
                        .collect(),
                ),
            ));
        }
        Frame::SubStart {
            id,
            status,
            reason_code,
            effective_scopes,
            bootstrap,
        } => {
            entries.push(("type", Value::from("SUB_START")));
            entries.push(("id", Value::from(id.clone())));
            entries.push(("status", Value::from(status.name())));
            entries.push(("reasonCode", Value::from(reason_code.clone())));
            entries.push(("effectiveScopes", scope_map_value(effective_scopes)));
            entries.push(("bootstrap", Value::from(*bootstrap)));
        }
        Frame::Commit {
            commit_seq,
            created_at_ms,
            actor_id,
            tables,
            changes,
        } => {
            entries.push(("type", Value::from("COMMIT")));
            entries.push(("commitSeq", Value::from(*commit_seq)));
            entries.push(("createdAtMs", Value::from(*created_at_ms)));
            entries.push(("actorId", Value::from(actor_id.clone())));
            entries.push((
                "tables",
                Value::Array(tables.iter().map(|t| Value::from(t.clone())).collect()),
            ));
            let rendered_changes = changes
                .iter()
                .map(|c| {
                    let mut e: Vec<(&str, Value)> = vec![
                        ("tableIndex", Value::from(c.table_index)),
                        ("rowId", Value::from(c.row_id.clone())),
                        ("op", Value::from(c.op.name())),
                    ];
                    if let Some(v) = c.row_version {
                        e.push(("rowVersion", Value::from(v)));
                    }
                    let mut scopes = Map::new();
                    for (k, v) in &c.scopes {
                        scopes.insert(k.clone(), Value::from(v.clone()));
                    }
                    e.push(("scopes", Value::Object(scopes)));
                    if let Some(row) = &c.row {
                        // Rule 4: binary fields render as base64.
                        e.push(("row", Value::from(base64(row))));
                    }
                    obj(e)
                })
                .collect();
            entries.push(("changes", Value::Array(rendered_changes)));
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
            entries.push(("type", Value::from("SEGMENT_REF")));
            entries.push(("segmentId", Value::from(segment_id.clone())));
            entries.push(("mediaType", Value::from(media_type.name())));
            entries.push(("table", Value::from(table.clone())));
            entries.push(("byteLength", Value::from(*byte_length)));
            entries.push(("rowCount", Value::from(*row_count)));
            entries.push(("asOfCommitSeq", Value::from(*as_of_commit_seq)));
            entries.push(("scopeDigest", Value::from(scope_digest.clone())));
            if let Some(v) = row_cursor {
                entries.push(("rowCursor", Value::from(v.clone())));
            }
            if let Some(v) = next_row_cursor {
                entries.push(("nextRowCursor", Value::from(v.clone())));
            }
            if let Some(v) = url {
                entries.push(("url", Value::from(v.clone())));
            }
            if let Some(v) = url_expires_at_ms {
                entries.push(("urlExpiresAtMs", Value::from(*v)));
            }
        }
        Frame::SegmentInline { payload } => {
            // Rule 4: the whole payload renders as base64, never as a nested
            // rule-8 object.
            entries.push(("type", Value::from("SEGMENT_INLINE")));
            entries.push(("payload", Value::from(base64(payload))));
        }
        Frame::SubEnd {
            next_cursor,
            bootstrap_state,
        } => {
            entries.push(("type", Value::from("SUB_END")));
            entries.push(("nextCursor", Value::from(*next_cursor)));
            if let Some(b) = bootstrap_state {
                entries.push(("bootstrapState", b.parse()));
            }
        }
        Frame::Error {
            code,
            message,
            category,
            retryable,
            recommended_action,
            details,
        } => {
            entries.push(("type", Value::from("ERROR")));
            entries.push(("code", Value::from(code.clone())));
            entries.push(("message", Value::from(message.clone())));
            entries.push(("category", Value::from(category.clone())));
            entries.push(("retryable", Value::from(*retryable)));
            entries.push(("recommendedAction", Value::from(recommended_action.clone())));
            if let Some(d) = details {
                entries.push(("details", d.parse()));
            }
        }
        Frame::Unknown {
            frame_type,
            payload,
        } => {
            // Rule 9.
            entries.push(("type", Value::from("UNKNOWN")));
            entries.push(("frameType", Value::from(*frame_type)));
            entries.push(("payload", Value::from(base64(payload))));
        }
    }
    obj(entries)
}

fn render_result(result: &OpResult) -> Value {
    match result {
        OpResult::Applied { op_index } => obj(vec![
            ("opIndex", Value::from(*op_index)),
            ("status", Value::from("applied")),
        ]),
        OpResult::Conflict {
            op_index,
            code,
            message,
            server_version,
            server_row,
        } => obj(vec![
            ("opIndex", Value::from(*op_index)),
            ("status", Value::from("conflict")),
            ("code", Value::from(code.clone())),
            ("message", Value::from(message.clone())),
            ("serverVersion", Value::from(*server_version)),
            ("serverRow", Value::from(base64(server_row))),
        ]),
        OpResult::Error {
            op_index,
            code,
            message,
            retryable,
        } => obj(vec![
            ("opIndex", Value::from(*op_index)),
            ("status", Value::from("error")),
            ("code", Value::from(code.clone())),
            ("message", Value::from(message.clone())),
            ("retryable", Value::from(*retryable)),
        ]),
    }
}

/// Render a rows segment per §11.1 rule 8: row records as
/// `{"serverVersion":…,"values":{name→value}}`, NULLs as JSON `null`,
/// `bytes` as base64, `json` columns parsed.
pub fn render_rows_segment(seg: &RowsSegment) -> Value {
    let columns = seg
        .columns
        .iter()
        .map(|c| {
            obj(vec![
                ("name", Value::from(c.name.clone())),
                ("type", Value::from(c.ty.name())),
                ("nullable", Value::from(c.nullable)),
            ])
        })
        .collect();
    let blocks = seg
        .blocks
        .iter()
        .map(|block| {
            Value::Array(
                block
                    .iter()
                    .map(|row| {
                        let mut values = Map::new();
                        for (col, value) in seg.columns.iter().zip(row.values.iter()) {
                            values.insert(col.name.clone(), render_column_value(value));
                        }
                        obj(vec![
                            ("serverVersion", Value::from(row.server_version)),
                            ("values", Value::Object(values)),
                        ])
                    })
                    .collect(),
            )
        })
        .collect();
    obj(vec![
        ("magic", Value::from("SSG2")),
        ("formatVersion", Value::from(1)),
        ("table", Value::from(seg.table.clone())),
        ("schemaVersion", Value::from(seg.schema_version)),
        ("columns", Value::Array(columns)),
        ("blocks", Value::Array(blocks)),
    ])
}

fn render_column_value(value: &Option<ColumnValue>) -> Value {
    match value {
        None => Value::Null,
        Some(ColumnValue::String(s)) => Value::from(s.clone()),
        Some(ColumnValue::Integer(v)) => Value::from(*v),
        Some(ColumnValue::Float(v)) => {
            serde_json::Number::from_f64(*v).map_or(Value::Null, Value::Number)
        }
        Some(ColumnValue::Boolean(v)) => Value::from(*v),
        Some(ColumnValue::Json(j)) => j.parse(),
        Some(ColumnValue::Bytes(b)) => Value::from(base64(b)),
        // §11: blob_ref (tag 7) renders as embedded parsed JSON, like json.
        Some(ColumnValue::BlobRef(j)) => j.parse(),
        // §11: crdt (tag 8) renders as base64, like bytes.
        Some(ColumnValue::Crdt(b)) => Value::from(base64(b)),
    }
}
