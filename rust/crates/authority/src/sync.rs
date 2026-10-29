//! One combined push+pull round (§1.5), following the reference
//! `handleSyncRequest`: request validation fails before any response byte
//! (an `Err`), the schema floor and the §2.1 log-epoch reset answer with a
//! bare `RESP_HEADER`, pushes answer in frame order (§6.4), and each
//! subscription answers one `SUB_START … SUB_END` section (§4).
//! Bootstrap rides inline rows segments only (§5.7).

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::{json, Value};
use ssp2::model::{Change, Frame, Message, MsgKind, Op, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{encode_rows_segment, RowsSegment, SegmentRow};
use ssp2::{decode_message, encode_message};

use crate::push::process_commit;
use crate::schema::{Schema, Table};
use crate::store;
use crate::AuthorityError;

/// §6.1 operation cap per request (the reference default).
const MAX_OPERATIONS_PER_REQUEST: usize = 500;
/// §4.2 accept bit 0: inline rows segments.
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;

type ScopeMap = Vec<(String, Vec<String>)>;

/// §4.2 defaults and silent clamps.
struct Limits {
    commits: usize,
    snapshot_rows: usize,
    snapshot_pages: usize,
}

fn clamp(value: i32, max: i32, default: i32) -> usize {
    (if value == 0 {
        default
    } else {
        value.clamp(1, max)
    }) as usize
}

struct Subscription<'a> {
    id: &'a str,
    table: &'a Table,
    scopes: &'a ScopeMap,
    cursor: i64,
    bootstrap_state: Option<&'a str>,
}

fn sub_start(
    id: &str,
    status: SubStatus,
    reason: &str,
    effective: ScopeMap,
    bootstrap: bool,
) -> Frame {
    Frame::SubStart {
        id: id.to_owned(),
        status,
        reason_code: reason.to_owned(),
        effective_scopes: effective,
        bootstrap,
    }
}

/// One subscription section; returns the cursor recorded for the §4.5
/// retention watermark when the section is active.
fn section(
    conn: &Connection,
    schema: &Schema,
    limits: &Limits,
    sub: &Subscription<'_>,
    max_seq: i64,
    horizon: i64,
    frames: &mut Vec<Frame>,
) -> Result<Option<i64>, AuthorityError> {
    // §3.2 with every value granted: effective = requested, revoked when
    // nothing is requested.
    if sub.scopes.is_empty() || sub.scopes.iter().any(|(_, values)| values.is_empty()) {
        frames.push(sub_start(
            sub.id,
            SubStatus::Revoked,
            "sync.scope_revoked",
            Vec::new(),
            false,
        ));
        frames.push(Frame::SubEnd {
            next_cursor: sub.cursor,
            bootstrap_state: None,
        });
        return Ok(None);
    }
    let effective = sub.scopes;
    let table = sub.table;
    // §4.7 resume token `{asOfCommitSeq, tables: [table], tableIndex,
    // rowCursor}`; an unusable token restarts the bootstrap.
    let token = sub.bootstrap_state.and_then(|raw| {
        let parsed: Value = serde_json::from_str(raw).ok()?;
        let as_of = parsed.get("asOfCommitSeq")?.as_i64()?;
        if parsed.get("tables")?.as_array()?.first()?.as_str()? != table.name
            || !parsed.get("tableIndex")?.is_number()
        {
            return None;
        }
        let row_cursor = match parsed.get("rowCursor")? {
            Value::Null => None,
            Value::String(cursor) => Some(cursor.clone()),
            _ => return None,
        };
        Some((as_of, row_cursor))
    });
    // §4.6: a cursor behind the horizon cannot compute deltas.
    if token.is_none() && sub.cursor >= 0 && sub.cursor < horizon {
        frames.push(sub_start(
            sub.id,
            SubStatus::Reset,
            "sync.cursor_expired",
            Vec::new(),
            false,
        ));
        frames.push(Frame::SubEnd {
            next_cursor: sub.cursor,
            bootstrap_state: None,
        });
        return Ok(None);
    }
    if token.is_some() || sub.cursor < 0 || sub.cursor > max_seq {
        // §4.7: resume at the pin unless it fell behind the horizon.
        let resume = token.filter(|(as_of, _)| *as_of >= horizon);
        let as_of = resume.as_ref().map_or(max_seq, |(as_of, _)| *as_of);
        let mut row_cursor = resume.and_then(|(_, row_cursor)| row_cursor);
        frames.push(sub_start(
            sub.id,
            SubStatus::Active,
            "",
            effective.clone(),
            true,
        ));
        let mut complete = false;
        for _ in 0..limits.snapshot_pages {
            let mut rows = store::scan_rows(
                conn,
                &table.name,
                effective,
                row_cursor.as_deref(),
                limits.snapshot_rows + 1,
            )?;
            let more = rows.len() > limits.snapshot_rows;
            rows.truncate(limits.snapshot_rows);
            let decoded = rows
                .iter()
                .map(|row| {
                    Ok(SegmentRow {
                        server_version: row.version,
                        values: store::decode_payload(&table.columns, &row.payload)?,
                    })
                })
                .collect::<Result<Vec<_>, AuthorityError>>()?;
            let payload = encode_rows_segment(&RowsSegment {
                table: table.name.clone(),
                schema_version: schema.version,
                columns: table.columns.clone(),
                blocks: decoded.chunks(1000).map(<[SegmentRow]>::to_vec).collect(),
            });
            frames.push(Frame::SegmentInline { payload });
            if !more {
                complete = true;
                break;
            }
            row_cursor = rows.last().map(|row| row.row_id.clone());
        }
        frames.push(Frame::SubEnd {
            next_cursor: as_of,
            bootstrap_state: (!complete).then(|| {
                RawJson(format!(
                    "{{\"asOfCommitSeq\":{as_of},\"tables\":[{}],\"tableIndex\":0,\"rowCursor\":{}}}",
                    Value::from(table.name.as_str()),
                    Value::from(row_cursor.as_deref())
                ))
            }),
        });
        return Ok(Some(as_of));
    }
    // §4.5 incremental: oldest first, cut at `limits.commits` changes, never
    // splitting a commit.
    frames.push(sub_start(
        sub.id,
        SubStatus::Active,
        "",
        effective.clone(),
        false,
    ));
    let commits = store::commit_window(
        conn,
        &table.name,
        effective,
        sub.cursor,
        max_seq,
        limits.commits + 1,
    )?;
    let mut delivered = 0;
    let mut delivered_commits = 0;
    let mut last_seq = sub.cursor;
    for commit in &commits {
        if delivered > 0 && delivered + commit.changes.len() > limits.commits {
            break;
        }
        frames.push(Frame::Commit {
            commit_seq: commit.commit_seq,
            created_at_ms: commit.created_at_ms,
            actor_id: commit.actor_id.clone(),
            tables: vec![table.name.clone()],
            changes: commit
                .changes
                .iter()
                .map(|change| Change {
                    table_index: 0,
                    row_id: change.row_id.clone(),
                    op: if change.upsert {
                        Op::Upsert
                    } else {
                        Op::Delete
                    },
                    row_version: change.row_version,
                    // Canonical map order: UTF-16 code units.
                    scopes: {
                        let mut entries: Vec<(String, String)> =
                            change.scopes.clone().into_iter().collect();
                        entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                        entries
                    },
                    row: change.payload.clone(),
                })
                .collect(),
        });
        delivered += commit.changes.len();
        delivered_commits += 1;
        last_seq = commit.commit_seq;
        if delivered >= limits.commits {
            break;
        }
    }
    let returned: usize = commits.iter().map(|commit| commit.changes.len()).sum();
    let exhausted = returned <= limits.commits && delivered_commits == commits.len();
    let next_cursor = sub.cursor.max(if exhausted { max_seq } else { last_seq });
    frames.push(Frame::SubEnd {
        next_cursor,
        bootstrap_state: None,
    });
    Ok(Some(next_cursor))
}

fn response(wire_version: u16, frames: Vec<Frame>) -> Vec<u8> {
    encode_message(&Message {
        wire_version,
        msg_kind: MsgKind::Response,
        frames,
    })
}

pub(crate) fn handle(
    conn: &Connection,
    schema: &Schema,
    now: i64,
    request: &[u8],
) -> Result<Vec<u8>, AuthorityError> {
    let message = decode_message(request).map_err(|e| {
        AuthorityError::with_details(
            e.code.as_str(),
            "the request failed to decode",
            json!({ "detail": e.detail }),
        )
    })?;
    let result = respond(conn, schema, now, &message);
    if let (Err(error), MsgKind::Request, Some(Frame::ReqHeader { client_id, .. })) =
        (&result, message.msg_kind, message.frames.first())
    {
        // §4.5: a failed outcome write never replaces the round's own outcome.
        let _ = store::record_round_failure(conn, client_id, &error.code, now);
    }
    result
}

fn respond(
    conn: &Connection,
    schema: &Schema,
    now: i64,
    message: &Message,
) -> Result<Vec<u8>, AuthorityError> {
    if message.msg_kind != MsgKind::Request {
        return Err(AuthorityError::new(
            "sync.invalid_request",
            "expected a request message",
        ));
    }
    let Some(Frame::ReqHeader {
        client_id,
        schema_version,
        log_epoch,
    }) = message.frames.first()
    else {
        return Err(AuthorityError::new(
            "sync.invalid_request",
            "missing REQ_HEADER",
        ));
    };
    let mut round_failure = None;
    let mut pushes = Vec::new();
    let mut pull = None;
    let mut subscriptions = Vec::new();
    for frame in &message.frames {
        match frame {
            Frame::RoundFailure { code } => round_failure = Some(code),
            Frame::PushCommit {
                client_commit_id,
                operations,
            } => pushes.push((client_commit_id, operations)),
            Frame::PullHeader {
                limit_commits,
                limit_snapshot_rows,
                max_snapshot_pages,
                accept,
            } => {
                pull = Some((
                    *limit_commits,
                    *limit_snapshot_rows,
                    *max_snapshot_pages,
                    *accept,
                ))
            }
            Frame::Subscription {
                id,
                table,
                scopes,
                cursor,
                bootstrap_state,
                ..
            } => subscriptions.push((id, table, scopes, *cursor, bootstrap_state)),
            _ => {}
        }
    }
    if log_epoch.is_none() && !pushes.is_empty() {
        return Err(AuthorityError::new(
            "sync.invalid_request",
            "epoch acquisition requests must not carry push commits (§2.1)",
        ));
    }
    let log = store::log_state(conn)?;
    let epoch_reset = log_epoch.as_deref() != Some(log.log_epoch.as_str());
    let header = |required_schema_version: Option<i32>| Frame::RespHeader {
        required_schema_version,
        latest_schema_version: Some(schema.version),
        log_epoch: Some(log.log_epoch.clone()),
        reset_required: Some(epoch_reset),
    };
    // §1.5/§4.5: the reported failure lands on the existing record before
    // the round runs; a failed outcome write never replaces the round's own.
    let report = || {
        if let Some(code) = round_failure {
            let _ = store::record_round_failure(conn, client_id, code, now);
        }
    };
    if *schema_version != schema.version {
        // §2.4: no degraded encoding; answer the schema floor (§1.6).
        report();
        return Ok(response(
            message.wire_version,
            vec![header(Some(schema.version))],
        ));
    }
    if epoch_reset {
        report();
        return Ok(response(message.wire_version, vec![header(None)]));
    }
    // §1.5: the server-command clientId namespace.
    if client_id.starts_with("[\"remote-command\",") {
        return Err(AuthorityError::new(
            "sync.invalid_client_id",
            "clientId uses a reserved server-command namespace (§1.5)",
        ));
    }
    let operations: usize = pushes.iter().map(|(_, operations)| operations.len()).sum();
    if operations > MAX_OPERATIONS_PER_REQUEST {
        return Err(AuthorityError::with_details(
            "sync.too_many_operations",
            "the request exceeds the operation cap (§6.1)",
            json!({ "operations": operations, "cap": MAX_OPERATIONS_PER_REQUEST }),
        ));
    }
    if let Some((.., accept)) = pull {
        if accept & (ACCEPT_INLINE_ROWS | 1 << 1) == 0 {
            return Err(AuthorityError::new(
                "sync.invalid_request",
                "accept must include rows-segment support (bits 0 and 1, §4.2)",
            ));
        }
        if accept & ACCEPT_INLINE_ROWS == 0 {
            return Err(AuthorityError::new(
                "sync.invalid_request",
                "the local authority serves inline rows segments only (§12.2)",
            ));
        }
    }
    let mut seen = HashSet::new();
    let mut plans = Vec::with_capacity(subscriptions.len());
    for (id, table, scopes, cursor, bootstrap_state) in subscriptions {
        if !seen.insert(id.as_str()) {
            return Err(AuthorityError::with_details(
                "sync.invalid_subscription",
                "duplicate subscription id (§4.1)",
                json!({ "subscription": id }),
            ));
        }
        let Some(compiled) = schema.table(table) else {
            return Err(AuthorityError::with_details(
                "sync.unknown_table",
                "subscription names an unknown table (§4.3)",
                json!({ "table": table }),
            ));
        };
        for (key, values) in scopes {
            if !compiled.declares(key) {
                return Err(AuthorityError::with_details(
                    "sync.invalid_subscription",
                    "requested scope key is not declared by the table (§3.2)",
                    json!({ "table": table, "variable": key }),
                ));
            }
            if values.iter().any(|value| value == "*") {
                return Err(AuthorityError::new(
                    "sync.invalid_subscription",
                    "requested scope value '*' is reserved for allowed scopes (§3.2)",
                ));
            }
        }
        plans.push(Subscription {
            id,
            table: compiled,
            scopes,
            cursor,
            bootstrap_state: bootstrap_state.as_ref().map(|raw| raw.0.as_str()),
        });
    }

    report();
    let mut frames = vec![header(None)];
    for (client_commit_id, operations) in pushes {
        frames.extend(process_commit(
            conn,
            schema,
            client_id,
            client_commit_id,
            operations,
            now,
        )?);
    }
    let mut cursors = Vec::new();
    if let Some((limit_commits, limit_snapshot_rows, max_snapshot_pages, _)) = pull {
        let limits = Limits {
            commits: clamp(limit_commits, 1000, 1000),
            snapshot_rows: clamp(limit_snapshot_rows, 50_000, 1000),
            snapshot_pages: clamp(max_snapshot_pages, 50, 4),
        };
        let log = store::log_state(conn)?;
        for plan in &plans {
            if let Some(cursor) = section(
                conn,
                schema,
                &limits,
                plan,
                log.max_seq,
                log.horizon,
                &mut frames,
            )? {
                cursors.push(cursor);
            }
        }
    }
    // §4.5: the cursor watermark the §4.6 floor reads.
    let cursor = match cursors.iter().min() {
        Some(cursor) => *cursor,
        None => store::client_cursor(conn, client_id)?.unwrap_or(-1),
    };
    store::put_client(conn, client_id, cursor, now, round_failure.is_some())?;
    Ok(response(message.wire_version, frames))
}
