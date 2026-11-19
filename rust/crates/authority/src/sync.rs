//! One combined push+pull round (§1.5), following the reference
//! `handleSyncRequest`: request validation fails before any response byte
//! (an `Err`), the schema floor and the §2.1 log-epoch reset answer with a
//! bare `RESP_HEADER`, pushes answer in frame order (§6.4), and a pull
//! answers unit sections (§4.4) and one live section (§4.5). Bootstrap rides
//! inline rows segments only (§5.7).

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde_json::{json, Value};
use ssp2::model::{Change, EchoStatus, Frame, LiveStatus, Message, MsgKind, Op, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{encode_rows_segment, RowsSegment, SegmentRow};
use ssp2::{decode_message, encode_message, UnitEcho};

use crate::push::process_commit;
use crate::schema::{Schema, Table};
use crate::store;
use crate::AuthorityError;

/// §6.1 operation cap per request (the reference default).
const MAX_OPERATIONS_PER_REQUEST: usize = 500;
/// §4.2 accept bit 0: inline rows segments.
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;

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

/// One unit of the effective list (§4.1). Every scope value is granted
/// (§12.2), so every covered pair is active with the unit's own scopes as
/// its effective scopes and the echo is empty (§3.2, §4.4).
struct Unit<'a> {
    id: String,
    scopes: &'a [(String, String)],
    /// Covered tables in bootstrap order (§4.7).
    tables: Vec<&'a Table>,
}

/// A unit's `PROGRESS` (§4.3): its cursor, resume token, and the kept cursor
/// and tables of the `RESTRICT` frame that follows it.
type Progress<'a> = (i64, Option<&'a str>, Option<(i64, &'a [String])>);

/// A unit's section kind and its scan-set bound (§4.5).
enum State {
    Live,
    Reset,
    Post(i64),
    /// `join` is the §4.7 join cursor: the pin, or the `RESTRICT` cursor.
    Bootstrap {
        join: i64,
        frames: Vec<Frame>,
        token: Option<String>,
    },
}

fn scopes_value(scopes: &[(String, String)]) -> Value {
    Value::Object(
        scopes
            .iter()
            .map(|(key, value)| (key.clone(), Value::from(value.as_str())))
            .collect(),
    )
}

/// §4.7: one bootstrap section's frames (its `UNIT_EXTENT`, then segments)
/// from a usable resume token, or from a fresh pin at `max_seq` that counts
/// the extent of `tables`, the unit's bootstrap tables; returns the pin, the
/// frames and the advanced token, `None` once every table is exhausted. A
/// token pinned below `floor` (the horizon, or a restricted unit's kept
/// cursor, raised to the table horizons of `tables`) restarts.
#[allow(clippy::too_many_arguments)]
fn bootstrap(
    conn: &Connection,
    schema: &Schema,
    limits: &Limits,
    scopes: &[(String, String)],
    tables: &[&Table],
    token: Option<&str>,
    max_seq: i64,
    floor: i64,
) -> Result<(i64, Vec<Frame>, Option<String>), AuthorityError> {
    // A token whose pin is no commit of this log, whose tables differ from
    // the bootstrap tables, or whose position names none of them restarts the
    // bootstrap, as does a pin below `floor`.
    let resume = token.and_then(|raw| {
        let parsed: Value = serde_json::from_str(raw).ok()?;
        let as_of = parsed.get("asOfCommitSeq")?.as_i64()?;
        let names = parsed.get("tables")?.as_array()?;
        let index = usize::try_from(parsed.get("tableIndex")?.as_i64()?).ok()?;
        let row_cursor = match parsed.get("rowCursor")? {
            Value::Null => None,
            Value::String(cursor) => Some(cursor.clone()),
            _ => return None,
        };
        // The extent: both counts or neither; anything else restarts.
        let extent = match (parsed.get("rowsTotal"), parsed.get("rowsDone")) {
            (None, None) => None,
            (Some(total), Some(done)) => Some((
                total.as_i64().filter(|count| *count >= 0)?,
                done.as_i64().filter(|count| *count >= 0)?,
            )),
            _ => return None,
        };
        let same_tables = names.len() == tables.len()
            && names
                .iter()
                .zip(tables)
                .all(|(name, table)| name.as_str() == Some(table.name.as_str()));
        (same_tables && (floor..=max_seq).contains(&as_of) && index < tables.len())
            .then_some((as_of, index, row_cursor, extent))
    });
    // One seek per table for the whole section, so a page never probes.
    let seeks = tables
        .iter()
        .map(|table| store::scope_seek(conn, table, scopes))
        .collect::<Result<Vec<_>, AuthorityError>>()?;
    let (pin, mut index, mut row_cursor, extent) = match resume {
        Some(resume) => resume,
        // A fresh pin counts the rows the bootstrap delivers.
        None => {
            let mut total = 0;
            for (table, seek) in tables.iter().zip(&seeks) {
                total += store::count_rows(conn, table, seek, scopes)?;
            }
            (max_seq, 0, None, Some((total, 0)))
        }
    };
    let mut frames: Vec<Frame> = extent
        .map(|(rows_total, rows_done)| Frame::UnitExtent {
            rows_total,
            rows_done,
        })
        .into_iter()
        .collect();
    let mut delivered = 0;
    let mut pages = 0;
    while index < tables.len() {
        if pages == limits.snapshot_pages {
            let names: Vec<&str> = tables.iter().map(|table| table.name.as_str()).collect();
            let token = format!(
                "{{\"asOfCommitSeq\":{pin},\"tables\":{},\"tableIndex\":{index},\"rowCursor\":{}{}}}",
                Value::from(names),
                Value::from(row_cursor.as_deref()),
                extent.map_or(String::new(), |(total, done)| format!(
                    ",\"rowsTotal\":{total},\"rowsDone\":{}",
                    done + delivered
                ))
            );
            return Ok((pin, frames, Some(token)));
        }
        let table = tables[index];
        let mut rows = store::scan_rows(
            conn,
            table,
            &seeks[index],
            scopes,
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
        delivered += decoded.len() as i64;
        frames.push(Frame::SegmentInline {
            payload: encode_rows_segment(&RowsSegment {
                table: table.name.clone(),
                schema_version: schema.version,
                columns: table.columns.clone(),
                blocks: decoded.chunks(1000).map(<[SegmentRow]>::to_vec).collect(),
            }),
        });
        pages += 1;
        if more {
            row_cursor = rows.last().map(|row| row.row_id.clone());
        } else {
            row_cursor = None;
            index += 1;
        }
    }
    Ok((pin, frames, None))
}

fn sub_start(id: &str, status: SubStatus, reason: &str, bootstrap: bool) -> Frame {
    Frame::SubStart {
        id: id.to_owned(),
        status,
        reason_code: reason.to_owned(),
        bootstrap,
        fenced: Vec::new(),
    }
}

/// The pull half (§4): unit sections in registration order, then one live
/// section. Returns the record cursor and the units still catching up
/// (§4.5 join rule J).
#[allow(clippy::too_many_arguments)]
fn pull(
    conn: &Connection,
    schema: &Schema,
    limits: &Limits,
    units: &[Unit<'_>],
    progress: &HashMap<&str, Progress<'_>>,
    replica_cursor: i64,
    echo_sections: bool,
    echo: [u8; 32],
    frames: &mut Vec<Frame>,
) -> Result<(i64, Vec<(String, i64)>), AuthorityError> {
    let log = store::log_state(conn)?;
    let (max_seq, horizon) = (log.max_seq, log.horizon);
    // §4.6 table horizons: a table's changes at or below its own are never
    // served.
    let table_horizons = store::table_horizons(conn)?;
    let table_horizon = |table: &Table| table_horizons.get(&table.name).copied().unwrap_or(-1);
    let r = replica_cursor;
    // §4.6 replica reset: a live unit with R outside [horizon, max].
    let live_reset = units
        .iter()
        .any(|unit| !progress.contains_key(unit.id.as_str()))
        && (r < horizon || r > max_seq);
    // §4.6 unit reset: `cursor` lies below the table horizon of one of the
    // unit's tables outside its `RESTRICT` tables.
    let below = |unit: &Unit<'_>, cursor: i64, restricted: &[String]| {
        unit.tables
            .iter()
            .any(|table| cursor < table_horizon(table) && !restricted.contains(&table.name))
    };
    let states = units
        .iter()
        .map(|unit| {
            let Some((cursor, token, restrict)) = progress.get(unit.id.as_str()) else {
                return Ok(if !live_reset && below(unit, r, &[]) {
                    State::Reset
                } else {
                    State::Live
                });
            };
            // §4.7 restricted bootstrap: only the `RESTRICT` tables, joining at
            // the kept cursor; a kept cursor the log cannot serve resets (§4.6).
            if let Some((kept, names)) = restrict {
                if *kept < horizon || *kept > max_seq || below(unit, *kept, names) {
                    return Ok(State::Reset);
                }
                let tables: Vec<&Table> = unit
                    .tables
                    .iter()
                    .copied()
                    .filter(|table| names.contains(&table.name))
                    .collect();
                let (_, frames, token) = bootstrap(
                    conn,
                    schema,
                    limits,
                    unit.scopes,
                    &tables,
                    *token,
                    max_seq,
                    tables
                        .iter()
                        .map(|table| table_horizon(table))
                        .fold(*kept, i64::max),
                )?;
                return Ok(State::Bootstrap {
                    join: *kept,
                    frames,
                    token,
                });
            }
            // §4.7: a token, cursor -1 or a cursor from the future bootstraps.
            if token.is_none() && (0..=max_seq).contains(cursor) {
                return Ok(if *cursor < horizon || below(unit, *cursor, &[]) {
                    State::Reset
                } else {
                    State::Post(*cursor)
                });
            }
            let (join, frames, token) = bootstrap(
                conn,
                schema,
                limits,
                unit.scopes,
                &unit.tables,
                *token,
                max_seq,
                unit.tables
                    .iter()
                    .map(|table| table_horizon(table))
                    .fold(horizon, i64::max),
            )?;
            Ok(State::Bootstrap {
                join,
                frames,
                token,
            })
        })
        .collect::<Result<Vec<_>, AuthorityError>>()?;
    let bounds: Vec<Option<i64>> = states
        .iter()
        .map(|state| match state {
            State::Live => Some(r),
            State::Post(cursor) => Some(*cursor),
            State::Bootstrap {
                join, token: None, ..
            } => Some(*join),
            _ => None,
        })
        .collect();
    // The horizon cannot move inside a round: `prune` and `sync` both take
    // the authority mutably, so the §4.6 recheck has nothing to find.
    let (commits, through) = match bounds.iter().flatten().min() {
        Some(after) if !live_reset => store::live_window(
            conn,
            *after,
            max_seq,
            limits.commits,
            |seq, table, scopes| {
                // §4.5: a table reaches a unit only above its table horizon.
                units.iter().zip(&bounds).any(|(unit, bound)| {
                    bound.is_some_and(|bound| {
                        seq > bound.max(table_horizons.get(table).copied().unwrap_or(-1))
                    }) && unit.tables.iter().any(|covered| covered.name == table)
                        && unit
                            .scopes
                            .iter()
                            .all(|(key, value)| scopes.get(key) == Some(value))
                })
            },
        )?,
        _ => (Vec::new(), max_seq),
    };
    let t = if live_reset { -1 } else { through };

    // §4.5 join rule J and the record the round writes: the units still
    // catching up with their cursors, and the record cursor.
    let joined = r.max(t);
    let mut any_live = false;
    let mut catching_up = Vec::new();
    for (unit, state) in units.iter().zip(&states) {
        let cursor = match state {
            State::Live if live_reset => Some(-1),
            State::Live => None,
            State::Reset => Some(-1),
            State::Bootstrap {
                join,
                token: Some(_),
                ..
            } => Some(*join),
            State::Post(cursor) | State::Bootstrap { join: cursor, .. } => {
                if live_reset {
                    Some(*cursor)
                } else if (*cursor).max(t) >= joined {
                    None
                } else {
                    Some((*cursor).max(t))
                }
            }
        };
        match cursor {
            Some(cursor) => catching_up.push((unit.id.clone(), cursor)),
            None => any_live = true,
        }
    }
    let record = catching_up
        .iter()
        .map(|(_, cursor)| *cursor)
        .filter(|cursor| *cursor >= 0)
        .chain(any_live.then_some(joined))
        .min()
        .unwrap_or(-1);

    for (unit, state) in units.iter().zip(states) {
        // A section that delivers no bootstrap echoes the request's cursor.
        let cursor = progress
            .get(unit.id.as_str())
            .map_or(r, |(cursor, _, _)| *cursor);
        match state {
            State::Reset => {
                frames.push(sub_start(
                    &unit.id,
                    SubStatus::Reset,
                    "sync.cursor_expired",
                    false,
                ));
                frames.push(Frame::SubEnd {
                    next_cursor: cursor,
                    bootstrap_state: None,
                });
            }
            State::Bootstrap {
                join,
                frames: segments,
                token,
            } => {
                frames.push(sub_start(&unit.id, SubStatus::Active, "", true));
                frames.extend(segments);
                frames.push(Frame::SubEnd {
                    next_cursor: join,
                    bootstrap_state: token.map(RawJson),
                });
            }
            State::Live | State::Post(_) if echo_sections => {
                frames.push(sub_start(&unit.id, SubStatus::Active, "", false));
                frames.push(Frame::SubEnd {
                    next_cursor: cursor,
                    bootstrap_state: None,
                });
            }
            State::Live | State::Post(_) => {}
        }
    }
    frames.push(Frame::LiveStart {
        status: if live_reset {
            LiveStatus::Reset
        } else {
            LiveStatus::Active
        },
        reason_code: if live_reset {
            "sync.cursor_expired"
        } else {
            ""
        }
        .to_owned(),
    });
    for commit in commits {
        let mut tables: Vec<String> = Vec::new();
        let changes = commit
            .changes
            .into_iter()
            .map(|change| {
                let table_index = match tables.iter().position(|table| *table == change.table) {
                    Some(index) => index,
                    None => {
                        tables.push(change.table.clone());
                        tables.len() - 1
                    }
                };
                // Canonical map order: UTF-16 code units.
                let mut scopes: Vec<(String, String)> = change.scopes.into_iter().collect();
                scopes.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                Change {
                    table_index: table_index as u16,
                    row_id: change.row_id,
                    op: if change.upsert {
                        Op::Upsert
                    } else {
                        Op::Delete
                    },
                    row_version: change.row_version,
                    scopes,
                    row: change.payload,
                }
            })
            .collect();
        frames.push(Frame::Commit {
            commit_seq: commit.commit_seq,
            created_at_ms: commit.created_at_ms,
            actor_id: commit.actor_id,
            tables,
            changes,
        });
    }
    frames.push(Frame::LiveEnd {
        through_seq: t,
        echo_digest: Some(echo),
    });

    Ok((record, catching_up))
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
    max_units: usize,
    cascade_cap: usize,
    request: &[u8],
) -> Result<Vec<u8>, AuthorityError> {
    let message = decode_message(request).map_err(|e| {
        AuthorityError::with_details(
            e.code.as_str(),
            "the request failed to decode",
            json!({ "detail": e.detail }),
        )
    })?;
    let result = respond(conn, schema, now, max_units, cascade_cap, &message);
    if let (Err(error), MsgKind::Request, Some(Frame::ReqHeader { client_id, .. })) =
        (&result, message.msg_kind, message.frames.first())
    {
        // §4.5: a failed outcome write never replaces the round's own outcome.
        let _ = store::record_round_failure(conn, client_id, &error.code, now);
    }
    result
}

fn invalid_subscription(message: &str, details: Value) -> AuthorityError {
    AuthorityError::with_details("sync.invalid_subscription", message, details)
}

fn respond(
    conn: &Connection,
    schema: &Schema,
    now: i64,
    max_units: usize,
    cascade_cap: usize,
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
        outbox_id,
    }) = message.frames.first()
    else {
        return Err(AuthorityError::new(
            "sync.invalid_request",
            "missing REQ_HEADER",
        ));
    };
    let mut round_failure = None;
    let mut pushes = Vec::new();
    let mut pull_header = None;
    let mut unit_frames = Vec::new();
    let mut progress_frames = Vec::new();
    for frame in &message.frames {
        match frame {
            Frame::RoundFailure { code } => round_failure = Some(code),
            Frame::PushCommit {
                client_commit_id,
                client_seq,
                operations,
            } => pushes.push((client_commit_id.as_str(), *client_seq, operations)),
            Frame::PullHeader { .. } => pull_header = Some(frame),
            Frame::Unit { scopes } => unit_frames.push(scopes.as_slice()),
            Frame::Progress {
                id,
                cursor,
                bootstrap_state,
            } => progress_frames.push((
                id.as_str(),
                (
                    *cursor,
                    bootstrap_state.as_ref().map(|raw| raw.0.as_str()),
                    None,
                ),
            )),
            // §4.3: the decoder placed it right after its PROGRESS.
            Frame::Restrict { cursor, tables } => {
                if let Some((_, (_, _, restrict))) = progress_frames.last_mut() {
                    *restrict = Some((*cursor, tables.as_slice()));
                }
            }
            _ => {}
        }
    }
    if log_epoch.is_none() && !pushes.is_empty() {
        return Err(AuthorityError::new(
            "sync.invalid_request",
            "epoch acquisition requests must not carry push commits (§2.1)",
        ));
    }
    let adopt = message.frames.contains(&Frame::AdoptEpoch);
    if adopt && log_epoch.is_some() {
        return Err(AuthorityError::new(
            "sync.invalid_request",
            "epoch adoption requests must not carry logEpoch (§2.1)",
        ));
    }
    let log = store::log_state(conn)?;
    // §2.1: adoption serves the request under the current epoch.
    let epoch_reset = !adopt && log_epoch.as_deref() != Some(log.log_epoch.as_str());
    let header = |required_schema_version: Option<i32>| Frame::RespHeader {
        required_schema_version,
        latest_schema_version: Some(schema.version),
        log_epoch: log.log_epoch.clone(),
        reset_required: epoch_reset,
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
    let operations: usize = pushes
        .iter()
        .map(|(_, _, operations)| operations.len())
        .sum();
    if operations > MAX_OPERATIONS_PER_REQUEST {
        return Err(AuthorityError::with_details(
            "sync.too_many_operations",
            "request carries more operations than the server accepts (§6.1)",
            json!({ "max": MAX_OPERATIONS_PER_REQUEST, "actual": operations }),
        ));
    }
    // §6.1 sequence rules: with an outbox every clientSeq is ≥ 1 and strictly
    // increasing in frame order; without one every clientSeq is 0.
    if pushes
        .iter()
        .enumerate()
        .any(|(index, (_, seq, _))| match outbox_id {
            None => *seq != 0,
            Some(_) => *seq < 1 || (index > 0 && *seq <= pushes[index - 1].1),
        })
    {
        return Err(AuthorityError::with_details(
            "sync.invalid_request",
            "push commits break the clientSeq rules (§6.1)",
            json!({
                "outbox": outbox_id.is_some(),
                "clientSeqs": pushes.iter().map(|(_, seq, _)| *seq).collect::<Vec<_>>(),
            }),
        ));
    }
    // §1.7: the UNIT cap (the reference `maxSubscriptionsPerRequest`).
    if unit_frames.len() > max_units {
        return Err(AuthorityError::with_details(
            "sync.limit_exceeded",
            "request carries more units than the server accepts (§1.7)",
            json!({ "limit": "maxSubscriptionsPerRequest", "max": max_units, "actual": unit_frames.len() }),
        ));
    }

    // §4.1: the effective list is the traveling list, or the stored list the
    // digest names; a digest naming neither answers `unregistered`.
    let stored;
    let mut traveled = None;
    let mut units = None;
    if let Some(Frame::PullHeader {
        accept,
        registration_digest,
        ..
    }) = pull_header
    {
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
        let empty = ssp2::registration_digest(std::iter::empty());
        let list: Option<Vec<&[(String, String)]>> =
            if !unit_frames.is_empty() || *registration_digest == empty {
                if ssp2::registration_digest(unit_frames.iter().copied()) != *registration_digest {
                    return Err(invalid_subscription(
                        "the registration digest differs from the traveling list (§4.1)",
                        json!({ "reason": "registration_digest" }),
                    ));
                }
                traveled = Some(registration_digest);
                Some(unit_frames.clone())
            } else {
                stored = store::client_registration(conn, client_id, registration_digest)?;
                stored
                    .as_ref()
                    .map(|units| units.iter().map(Vec::as_slice).collect())
            };
        if let Some(list) = list {
            let mut ids = HashSet::new();
            let mut planned = Vec::with_capacity(list.len());
            for scopes in list {
                // §4.1: a unit covers every table declaring all its variables.
                let reason = if scopes.is_empty() {
                    Some("empty_scope_map")
                } else if scopes.iter().any(|(_, value)| value == "*") {
                    Some("wildcard_value")
                } else if scopes
                    .iter()
                    .any(|(key, _)| !schema.tables.iter().any(|table| table.declares(key)))
                {
                    Some("undeclared_variable")
                } else {
                    None
                };
                let tables: Vec<&Table> = schema
                    .tables
                    .iter()
                    .filter(|table| {
                        reason.is_none() && scopes.iter().all(|(key, _)| table.declares(key))
                    })
                    .collect();
                if tables.is_empty() {
                    return Err(invalid_subscription(
                        "the server cannot serve this unit (§4.1)",
                        json!({ "reason": reason.unwrap_or("no_covered_table"), "scopes": scopes_value(scopes) }),
                    ));
                }
                let id = ssp2::unit_id(scopes);
                if !ids.insert(id.clone()) {
                    return Err(invalid_subscription(
                        "the registration list names a scope map twice (§4.1)",
                        json!({ "reason": "duplicate_unit", "scopes": scopes_value(scopes) }),
                    ));
                }
                planned.push(Unit { id, scopes, tables });
            }
            let mut progressed = HashSet::new();
            for (id, (_, _, restrict)) in &progress_frames {
                if !ids.contains(*id) || !progressed.insert(*id) {
                    return Err(invalid_subscription(
                        "a PROGRESS frame names no registered unit or repeats one (§4.1)",
                        json!({
                            "reason": if ids.contains(*id) { "duplicate_progress" } else { "unknown_unit" },
                            "id": id,
                        }),
                    ));
                }
                // §4.3: a restriction names covered tables, never all of them.
                if let Some((_, names)) = restrict {
                    let covered = &planned
                        .iter()
                        .find(|unit| unit.id == *id)
                        .expect("ids holds every planned unit")
                        .tables;
                    if names.len() >= covered.len()
                        || names
                            .iter()
                            .any(|name| !covered.iter().any(|table| table.name == *name))
                    {
                        return Err(invalid_subscription(
                            "a RESTRICT frame names a table its unit does not cover, or every covered table (§4.3)",
                            json!({ "reason": "restrict_tables", "id": id, "tables": names }),
                        ));
                    }
                }
            }
            units = Some(planned);
        }
    }

    report();
    let mut frames = vec![header(None)];
    // §6.3.2: the request's first commit settles the outbox and reads `W`.
    let commits: Vec<(&str, i64)> = pushes.iter().map(|(id, seq, _)| (*id, *seq)).collect();
    let mut watermark = 0;
    for (index, (client_commit_id, client_seq, operations)) in pushes.iter().enumerate() {
        frames.extend(process_commit(
            conn,
            schema,
            client_id,
            client_commit_id,
            operations,
            outbox_id
                .as_deref()
                .map(|outbox_id| (outbox_id, *client_seq)),
            (index == 0).then_some(commits.as_slice()),
            &mut watermark,
            now,
            cascade_cap,
        )?);
    }
    let keep_outcome = round_failure.is_some();
    let Some(Frame::PullHeader {
        limit_commits,
        limit_snapshot_rows,
        max_snapshot_pages,
        cursor,
        echo_digest,
        ..
    }) = pull_header
    else {
        // A push-only round keeps the registration, its states and the
        // cursor (§4.5).
        store::put_client(conn, client_id, None, None, now, keep_outcome)?;
        return Ok(response(message.wire_version, frames));
    };
    let Some(units) = units else {
        // §4.1: no unit section, no COMMIT; PROGRESS frames are ignored, and
        // the round writes only its outcome (§4.5).
        frames.push(Frame::LiveStart {
            status: LiveStatus::Unregistered,
            reason_code: String::new(),
        });
        frames.push(Frame::LiveEnd {
            through_seq: -1,
            echo_digest: None,
        });
        store::record_round(conn, client_id, now, keep_outcome)?;
        return Ok(response(message.wire_version, frames));
    };
    let limits = Limits {
        commits: clamp(*limit_commits, 1000, 1000),
        snapshot_rows: clamp(*limit_snapshot_rows, 50_000, 1000),
        snapshot_pages: clamp(*max_snapshot_pages, 50, 4),
    };
    let echo = ssp2::echo_digest(units.iter().map(|unit| UnitEcho {
        id: &unit.id,
        status: EchoStatus::Active,
        fenced: &[],
    }));
    // §4.4 rule 1: every unit gets a section when the list traveled or the
    // client holds another echo.
    let echo_sections = traveled.is_some() || *echo_digest != Some(echo);
    let progress: HashMap<&str, Progress<'_>> = progress_frames.into_iter().collect();
    let (record, catching_up) = pull(
        conn,
        schema,
        &limits,
        &units,
        &progress,
        *cursor,
        echo_sections,
        echo,
        &mut frames,
    )?;
    let listed: Option<Vec<store::UnitScopes>> =
        traveled.map(|_| units.iter().map(|unit| unit.scopes.to_vec()).collect());
    store::put_client(
        conn,
        client_id,
        Some((record, &catching_up)),
        listed.as_deref().zip(traveled),
        now,
        keep_outcome,
    )?;
    Ok(response(message.wire_version, frames))
}
