//! The Syncular v2 Rust client core (SPEC.md client-behavior contract):
//! rusqlite local storage, §3.2/§3.3 effective-scope persistence + purge,
//! §4 pull/cursor/bootstrap (§4.7 resume, §5.6 segment application), §6
//! push with outbox order, §7 optimistic apply / rollback / replay-on-top,
//! §2.3 clientCommitId idempotency, §8 realtime client rules, §10 errors.
//!
//! Built from `v2/SPEC.md` and the committed `ssp2` codec alone — no
//! reference to the v1 Rust tree or the v2 TypeScript client.

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use ssp2::model::{Frame, MediaType, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_rows_segment, Column, ColumnValue, Row, RowsSegment};
use ssp2::{decode_message, encode_message, parse_control, ControlMessage};

use crate::api::{
    ClientLimits, ConflictRecord, Mutation, RejectionRecord, RowState, SchemaFloor,
    SubscriptionStateView, SyncOutcome, SyncReport,
};
use crate::schema::{parse_schema_json, ClientSchema};
use crate::transport::{SegmentRequest, Transport, TransportError};
use crate::values::{
    bytes_to_hex, canonical_scope_json, column_value_to_json, decode_row_bytes, encode_row_json,
    json_to_column_value, render_row_id_json, scope_map_to_json, sort_scope_map,
};

/// §4.2 client baseline: inline + external rows segments.
const DEFAULT_ACCEPT: u8 = 0b0011;
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;
const ACCEPT_EXTERNAL_ROWS: u8 = 1 << 1;
const ACCEPT_SQLITE: u8 = 1 << 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubState {
    Active,
    Revoked,
    Failed,
}

impl SubState {
    fn name(self) -> &'static str {
        match self {
            SubState::Active => "active",
            SubState::Revoked => "revoked",
            SubState::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
struct Subscription {
    id: String,
    table: String,
    requested: Vec<(String, Vec<String>)>,
    params: Option<String>,
    cursor: i64,
    /// §4.7 resume token, round-tripped opaquely.
    bootstrap_state: Option<String>,
    state: SubState,
    reason_code: Option<String>,
    /// Last effective scopes echoed while active (§3.3: persisted for the
    /// purge contract; each active echo replaces it).
    effective: Option<Vec<(String, Vec<String>)>>,
    synced_once: bool,
}

#[derive(Debug, Clone)]
struct OutboxOp {
    upsert: bool,
    table: String,
    row_id: String,
    base_version: Option<i64>,
    /// Schema-agnostic local form (§0): driver JSON values, encoded with
    /// the current codec at send time.
    values: Option<Map<String, Value>>,
}

#[derive(Debug, Clone)]
struct OutboxCommit {
    client_commit_id: String,
    ops: Vec<OutboxOp>,
}

/// Section outcome distinguishing the §5.6 subscription-local fail-closed
/// path from a round-aborting failure (§1.4 rule 5).
enum SectionError {
    FailClosed,
    Abort(String, String),
}

struct RequestMeta {
    pushed_ids: Vec<String>,
    /// Subscription id → the request carried `cursor < 0` and no resume
    /// token (§5.6 first-page detection: a *fresh* bootstrap).
    fresh: Vec<(String, bool)>,
    accept: u8,
}

pub struct SyncClient {
    conn: Connection,
    schema: ClientSchema,
    client_id: String,
    limits: ClientLimits,
    subs: Vec<Subscription>,
    outbox: Vec<OutboxCommit>,
    conflicts: Vec<ConflictRecord>,
    rejections: Vec<RejectionRecord>,
    schema_floor: Option<SchemaFloor>,
    /// §1.6: the schema-floor response stops syncing until an upgrade.
    stopped: bool,
    /// §8.4 coalesced sync-needed signal.
    sync_needed: bool,
    realtime_connected: bool,
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn base_table(name: &str) -> String {
    quote_ident(&format!("_syncular_base_{name}"))
}

fn visible_table(name: &str) -> String {
    quote_ident(name)
}

fn cv_to_sql(value: &Option<ColumnValue>) -> SqlValue {
    match value {
        None => SqlValue::Null,
        Some(ColumnValue::String(s)) => SqlValue::Text(s.clone()),
        Some(ColumnValue::Integer(i)) => SqlValue::Integer(*i),
        Some(ColumnValue::Float(f)) => SqlValue::Real(*f),
        Some(ColumnValue::Boolean(b)) => SqlValue::Integer(i64::from(*b)),
        Some(ColumnValue::Json(raw)) => SqlValue::Text(raw.0.clone()),
        Some(ColumnValue::Bytes(b)) => SqlValue::Blob(b.clone()),
    }
}

fn sql_ref_to_json(column: &Column, value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => match column.ty {
            ssp2::segment::ColumnType::Boolean => Value::Bool(i != 0),
            ssp2::segment::ColumnType::Float => {
                serde_json::Number::from_f64(i as f64).map_or(Value::Null, Value::Number)
            }
            _ => Value::from(i),
        },
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let mut map = Map::new();
            map.insert("$bytes".to_owned(), Value::from(bytes_to_hex(b)));
            Value::Object(map)
        }
    }
}

impl SyncClient {
    pub fn new(
        client_id: String,
        schema_json: &Value,
        limits: ClientLimits,
    ) -> Result<Self, String> {
        let schema = parse_schema_json(schema_json)?;
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let client = SyncClient {
            conn,
            schema,
            client_id,
            limits,
            subs: Vec::new(),
            outbox: Vec::new(),
            conflicts: Vec::new(),
            rejections: Vec::new(),
            schema_floor: None,
            stopped: false,
            sync_needed: false,
            realtime_connected: false,
        };
        client.create_tables()?;
        Ok(client)
    }

    fn create_tables(&self) -> Result<(), String> {
        for table in &self.schema.tables {
            for full in [base_table(&table.name), visible_table(&table.name)] {
                let mut cols: Vec<String> =
                    table.columns.iter().map(|c| quote_ident(&c.name)).collect();
                cols.push("\"_syncular_version\" INTEGER NOT NULL".to_owned());
                let sql = format!(
                    "CREATE TABLE {full} ({} , PRIMARY KEY ({}))",
                    cols.join(", "),
                    quote_ident(&table.primary_key)
                );
                self.conn.execute(&sql, []).map_err(|e| e.to_string())?;
            }
        }
        // Durable client bookkeeping (outbox + subscription persistence).
        self.conn
            .execute_batch(
                "CREATE TABLE _syncular_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   commit_id TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL);
                 CREATE TABLE _syncular_subscriptions (id TEXT PRIMARY KEY,
                   tbl TEXT NOT NULL, state_json TEXT NOT NULL);",
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // -- persistence write-through --------------------------------------------

    fn persist_sub(&self, sub: &Subscription) {
        let state = serde_json::json!({
            "requested": scope_map_to_json(&sub.requested),
            "params": sub.params,
            "cursor": sub.cursor,
            "bootstrapState": sub.bootstrap_state,
            "status": sub.state.name(),
            "reasonCode": sub.reason_code,
            "effectiveScopes": sub.effective.as_ref().map(|e| scope_map_to_json(e)),
            "syncedOnce": sub.synced_once,
        });
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_subscriptions (id, tbl, state_json) VALUES (?1, ?2, ?3)",
            rusqlite::params![sub.id, sub.table, state.to_string()],
        );
    }

    fn persist_outbox_insert(&self, commit: &OutboxCommit) {
        let ops: Vec<Value> = commit
            .ops
            .iter()
            .map(|op| {
                serde_json::json!({
                    "op": if op.upsert { "upsert" } else { "delete" },
                    "table": op.table,
                    "rowId": op.row_id,
                    "baseVersion": op.base_version,
                    "values": op.values.clone().map(Value::Object),
                })
            })
            .collect();
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_outbox (commit_id, ops_json) VALUES (?1, ?2)",
            rusqlite::params![commit.client_commit_id, Value::Array(ops).to_string()],
        );
    }

    fn persist_outbox_delete(&self, client_commit_id: &str) {
        let _ = self.conn.execute(
            "DELETE FROM _syncular_outbox WHERE commit_id = ?1",
            rusqlite::params![client_commit_id],
        );
    }

    // -- driver surface ---------------------------------------------------------

    pub fn subscribe(
        &mut self,
        id: String,
        table: String,
        scopes: Vec<(String, Vec<String>)>,
        params: Option<String>,
    ) -> Result<(), String> {
        if self.schema.table(&table).is_none() {
            return Err(format!("unknown table {table:?}"));
        }
        let sub = Subscription {
            id: id.clone(),
            table,
            requested: scopes,
            params,
            cursor: -1,
            bootstrap_state: None,
            state: SubState::Active,
            reason_code: None,
            effective: None,
            synced_once: false,
        };
        self.persist_sub(&sub);
        if let Some(existing) = self.subs.iter_mut().find(|s| s.id == id) {
            *existing = sub;
        } else {
            self.subs.push(sub);
        }
        Ok(())
    }

    pub fn unsubscribe(&mut self, id: &str) {
        self.subs.retain(|s| s.id != id);
        let _ = self.conn.execute(
            "DELETE FROM _syncular_subscriptions WHERE id = ?1",
            rusqlite::params![id],
        );
    }

    /// Record one atomic local commit (§7.1) and apply it optimistically.
    pub fn mutate(&mut self, mutations: Vec<Mutation>) -> Result<String, String> {
        if mutations.is_empty() {
            return Err("a commit must contain at least one operation (§6.1)".to_owned());
        }
        let mut ops = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            match mutation {
                Mutation::Upsert {
                    table,
                    values,
                    base_version,
                } => {
                    let schema_table = self
                        .schema
                        .table(&table)
                        .ok_or_else(|| format!("unknown table {table:?}"))?;
                    // Validate the payload encodes with the current codec.
                    encode_row_json(schema_table, &values)?;
                    let row_id = render_row_id_json(values.get(&schema_table.primary_key))?;
                    ops.push(OutboxOp {
                        upsert: true,
                        table,
                        row_id,
                        base_version,
                        values: Some(values),
                    });
                }
                Mutation::Delete {
                    table,
                    row_id,
                    base_version,
                } => {
                    if self.schema.table(&table).is_none() {
                        return Err(format!("unknown table {table:?}"));
                    }
                    ops.push(OutboxOp {
                        upsert: false,
                        table,
                        row_id,
                        base_version,
                        values: None,
                    });
                }
            }
        }
        let commit = OutboxCommit {
            client_commit_id: uuid::Uuid::new_v4().to_string(),
            ops,
        };
        self.persist_outbox_insert(&commit);
        let id = commit.client_commit_id.clone();
        self.outbox.push(commit);
        self.rebuild_overlay();
        Ok(id)
    }

    pub fn pending_commit_ids(&self) -> Vec<String> {
        self.outbox
            .iter()
            .map(|c| c.client_commit_id.clone())
            .collect()
    }

    pub fn conflicts(&self) -> &[ConflictRecord] {
        &self.conflicts
    }

    pub fn rejections(&self) -> &[RejectionRecord] {
        &self.rejections
    }

    pub fn schema_floor(&self) -> Option<&SchemaFloor> {
        self.schema_floor.as_ref()
    }

    pub fn sync_needed(&self) -> bool {
        self.sync_needed
    }

    pub fn subscription_state(&self, id: &str) -> Option<SubscriptionStateView> {
        let sub = self.subs.iter().find(|s| s.id == id)?;
        Some(SubscriptionStateView {
            id: sub.id.clone(),
            table: sub.table.clone(),
            status: sub.state.name().to_owned(),
            cursor: sub.cursor,
            has_resume_token: sub.bootstrap_state.is_some(),
            effective_scopes: sub.effective.as_ref().map(|e| scope_map_to_json(e)),
            reason_code: sub.reason_code.clone(),
        })
    }

    pub fn read_rows(&self, table: &str) -> Result<Vec<RowState>, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("unknown table {table:?}"))?;
        let sql = format!(
            "SELECT * FROM {} ORDER BY {} ASC",
            visible_table(table),
            quote_ident(&schema_table.primary_key)
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut values = Map::new();
            for (i, column) in schema_table.columns.iter().enumerate() {
                let value = row.get_ref(i).map_err(|e| e.to_string())?;
                values.insert(column.name.clone(), sql_ref_to_json(column, value));
            }
            let version: i64 = row
                .get(schema_table.columns.len())
                .map_err(|e| e.to_string())?;
            let row_id = match values.get(&schema_table.primary_key) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::Bool(b)) => b.to_string(),
                other => format!("{}", other.cloned().unwrap_or(Value::Null)),
            };
            out.push(RowState {
                row_id,
                version,
                values,
            });
        }
        Ok(out)
    }

    // -- request building ---------------------------------------------------------

    fn build_request(&self) -> (Message, RequestMeta) {
        let mut frames = vec![Frame::ReqHeader {
            client_id: self.client_id.clone(),
            schema_version: self.schema.version,
        }];
        let mut pushed_ids = Vec::new();
        for commit in &self.outbox {
            let operations = commit
                .ops
                .iter()
                .map(|op| {
                    let payload = op.values.as_ref().and_then(|values| {
                        let table = self.schema.table(&op.table)?;
                        // §0: outbox entries encode at send time with the
                        // current codec (validated at mutate()).
                        encode_row_json(table, values).ok()
                    });
                    ssp2::model::Operation {
                        table: op.table.clone(),
                        row_id: op.row_id.clone(),
                        op: if op.upsert { Op::Upsert } else { Op::Delete },
                        base_version: op.base_version,
                        payload,
                    }
                })
                .collect();
            frames.push(Frame::PushCommit {
                client_commit_id: commit.client_commit_id.clone(),
                operations,
            });
            pushed_ids.push(commit.client_commit_id.clone());
        }
        let accept = self.limits.accept.unwrap_or(DEFAULT_ACCEPT);
        frames.push(Frame::PullHeader {
            limit_commits: self.limits.limit_commits.unwrap_or(0),
            limit_snapshot_rows: self.limits.limit_snapshot_rows.unwrap_or(0),
            max_snapshot_pages: self.limits.max_snapshot_pages.unwrap_or(0),
            accept,
        });
        let mut fresh = Vec::new();
        for sub in &self.subs {
            if sub.state != SubState::Active {
                continue;
            }
            let mut scopes = sub.requested.clone();
            sort_scope_map(&mut scopes);
            frames.push(Frame::Subscription {
                id: sub.id.clone(),
                table: sub.table.clone(),
                scopes,
                params: sub.params.clone().map(RawJson),
                cursor: sub.cursor,
                bootstrap_state: sub.bootstrap_state.clone().map(RawJson),
            });
            fresh.push((
                sub.id.clone(),
                sub.cursor < 0 && sub.bootstrap_state.is_none(),
            ));
        }
        let message = Message {
            msg_kind: MsgKind::Request,
            frames,
        };
        (
            message,
            RequestMeta {
                pushed_ids,
                fresh,
                accept,
            },
        )
    }

    // -- sync -------------------------------------------------------------------

    pub fn sync(&mut self, transport: &mut dyn Transport) -> SyncOutcome {
        if self.stopped {
            // §1.6: the client stopped at the schema floor; syncing is inert
            // until an upgrade. The outbox is preserved for replay.
            return SyncOutcome::Ok(SyncReport {
                schema_floor: self.schema_floor.clone(),
                ..SyncReport::default()
            });
        }
        // §8.4: the coalesced sync-needed signal clears when a pull round
        // BEGINS, so a wake-up landing mid-round survives it.
        self.sync_needed = false;
        let (message, meta) = self.build_request();
        let request_bytes = encode_message(&message);
        let response_bytes = match transport.sync(&request_bytes) {
            Ok(bytes) => bytes,
            Err(TransportError { code, message }) => {
                return SyncOutcome::Failed {
                    error_code: code,
                    message,
                };
            }
        };
        let response = match decode_message(&response_bytes) {
            Ok(message) => message,
            Err(error) => {
                // §1.2 rule 1 / §1.4 rule 5: truncated or malformed
                // responses abort without persisting anything.
                return SyncOutcome::Failed {
                    error_code: error.code.as_str().to_owned(),
                    message: error.detail,
                };
            }
        };
        if response.msg_kind != MsgKind::Response {
            return SyncOutcome::Failed {
                error_code: "sync.invalid_request".to_owned(),
                message: "expected a response message".to_owned(),
            };
        }
        self.process_response(transport, response, &meta)
    }

    pub fn sync_until_idle(
        &mut self,
        transport: &mut dyn Transport,
        max_rounds: Option<u32>,
    ) -> SyncOutcome {
        let rounds = max_rounds.unwrap_or(12).max(1);
        let mut aggregate = SyncReport::default();
        for _ in 0..rounds {
            match self.sync(transport) {
                SyncOutcome::Failed {
                    error_code,
                    message,
                } => {
                    return SyncOutcome::Failed {
                        error_code,
                        message,
                    };
                }
                SyncOutcome::Ok(report) => {
                    aggregate.pushed += report.pushed;
                    aggregate.applied.extend(report.applied.iter().cloned());
                    aggregate.rejected.extend(report.rejected.iter().cloned());
                    aggregate.retryable.extend(report.retryable.iter().cloned());
                    aggregate.conflicts += report.conflicts;
                    aggregate.commits_applied += report.commits_applied;
                    aggregate.segment_rows_applied += report.segment_rows_applied;
                    aggregate.bootstrapping = report.bootstrapping.clone();
                    aggregate.resets.extend(report.resets.iter().cloned());
                    aggregate.revoked.extend(report.revoked.iter().cloned());
                    aggregate.failed.extend(report.failed.iter().cloned());
                    if report.schema_floor.is_some() {
                        aggregate.schema_floor = report.schema_floor.clone();
                    }
                    // §4.5: pull again whenever the response contained
                    // commits or segments; resets re-bootstrap; a pending
                    // resume token continues paging (§4.7).
                    let more = !report.bootstrapping.is_empty()
                        || report.commits_applied > 0
                        || report.segment_rows_applied > 0
                        || !report.resets.is_empty();
                    if !more {
                        break;
                    }
                }
            }
        }
        SyncOutcome::Ok(aggregate)
    }

    fn process_response(
        &mut self,
        transport: &mut dyn Transport,
        response: Message,
        meta: &RequestMeta,
    ) -> SyncOutcome {
        let mut report = SyncReport {
            pushed: meta.pushed_ids.len() as u32,
            ..SyncReport::default()
        };
        let mut frames = response.frames.into_iter();
        match frames.next() {
            Some(Frame::RespHeader {
                required_schema_version,
                latest_schema_version,
            }) => {
                if let Some(required) = required_schema_version {
                    // §1.6 schema-floor response: nothing else is processed;
                    // stop syncing and surface the upgrade requirement.
                    let floor = SchemaFloor {
                        required_schema_version: Some(required),
                        latest_schema_version,
                    };
                    self.schema_floor = Some(floor.clone());
                    self.stopped = true;
                    report.schema_floor = Some(floor);
                    return SyncOutcome::Ok(report);
                }
            }
            _ => {
                return SyncOutcome::Failed {
                    error_code: "sync.invalid_request".to_owned(),
                    message: "response does not start with RESP_HEADER".to_owned(),
                };
            }
        }

        let mut failure: Option<(String, String)> = None;
        while let Some(frame) = frames.next() {
            match frame {
                Frame::PushResult {
                    client_commit_id,
                    status,
                    commit_seq: _,
                    results,
                } => {
                    self.handle_push_result(&client_commit_id, status, &results, &mut report);
                }
                Frame::SubStart {
                    id,
                    status,
                    reason_code,
                    effective_scopes,
                    bootstrap: _,
                } => {
                    let mut body = Vec::new();
                    let mut sub_end: Option<(i64, Option<String>)> = None;
                    for inner in frames.by_ref() {
                        match inner {
                            Frame::SubEnd {
                                next_cursor,
                                bootstrap_state,
                            } => {
                                sub_end = Some((next_cursor, bootstrap_state.map(|r| r.0)));
                                break;
                            }
                            Frame::Unknown { .. } => {}
                            other => body.push(other),
                        }
                    }
                    let Some((next_cursor, bootstrap_state)) = sub_end else {
                        failure = Some((
                            "sync.invalid_request".to_owned(),
                            "subscription section without SUB_END".to_owned(),
                        ));
                        break;
                    };
                    if let Err(SectionError::Abort(code, message)) = self.process_section(
                        transport,
                        &id,
                        status,
                        &reason_code,
                        effective_scopes,
                        body,
                        next_cursor,
                        bootstrap_state,
                        meta,
                        &mut report,
                    ) {
                        failure = Some((code, message));
                        break;
                    }
                }
                Frame::Error { code, message, .. } => {
                    // §1.6: the whole request failed; already-completed
                    // subscriptions keep their applied data and cursors.
                    failure = Some((code, message));
                    break;
                }
                Frame::Unknown { .. } => {}
                _ => {
                    failure = Some((
                        "sync.invalid_request".to_owned(),
                        "unexpected frame in response".to_owned(),
                    ));
                    break;
                }
            }
        }

        // §7.1: reconciliation is outbox replay on top — whenever server
        // data has been applied, including a round that aborted mid-way.
        self.rebuild_overlay();

        if let Some((error_code, message)) = failure {
            return SyncOutcome::Failed {
                error_code,
                message,
            };
        }
        self.ack_after_pull(transport);
        SyncOutcome::Ok(report)
    }

    // -- push results (§6.3, §7.2) ------------------------------------------------

    fn handle_push_result(
        &mut self,
        client_commit_id: &str,
        status: PushStatus,
        results: &[OpResult],
        report: &mut SyncReport,
    ) {
        let Some(index) = self
            .outbox
            .iter()
            .position(|c| c.client_commit_id == client_commit_id)
        else {
            return;
        };
        match status {
            PushStatus::Applied | PushStatus::Cached => {
                // §7.2: a lost ack replays as `cached` — proceed as if the
                // ack had arrived.
                report.applied.push(client_commit_id.to_owned());
                self.outbox.remove(index);
                self.persist_outbox_delete(client_commit_id);
            }
            PushStatus::Rejected => {
                let terminating = results
                    .iter()
                    .find(|r| !matches!(r, OpResult::Applied { .. }));
                match terminating {
                    Some(OpResult::Conflict {
                        op_index,
                        code,
                        message: _,
                        server_version,
                        server_row,
                    }) => {
                        let commit = &self.outbox[index];
                        let (table, row_id) = commit
                            .ops
                            .get(*op_index as usize)
                            .map(|op| (op.table.clone(), op.row_id.clone()))
                            .unwrap_or_default();
                        let server_row_json = self
                            .schema
                            .table(&table)
                            .and_then(|t| decode_row_bytes(t, server_row).ok().map(|row| (t, row)))
                            .map(|(t, row)| {
                                let mut map = Map::new();
                                for (i, column) in t.columns.iter().enumerate() {
                                    map.insert(
                                        column.name.clone(),
                                        column_value_to_json(row.get(i).unwrap_or(&None)),
                                    );
                                }
                                map
                            })
                            .unwrap_or_default();
                        self.conflicts.push(ConflictRecord {
                            client_commit_id: client_commit_id.to_owned(),
                            op_index: *op_index,
                            table,
                            row_id,
                            code: code.clone(),
                            server_version: *server_version,
                            server_row: server_row_json,
                        });
                        report.conflicts += 1;
                        report.rejected.push(client_commit_id.to_owned());
                        self.outbox.remove(index);
                        self.persist_outbox_delete(client_commit_id);
                    }
                    Some(OpResult::Error {
                        op_index,
                        code,
                        message: _,
                        retryable,
                    }) => {
                        if code == "sync.idempotency_cache_miss" {
                            // §6.3/§7.2: a serving failure, not an outcome —
                            // the commit stays queued for an identical retry.
                            report.retryable.push(client_commit_id.to_owned());
                        } else {
                            self.rejections.push(RejectionRecord {
                                client_commit_id: client_commit_id.to_owned(),
                                op_index: *op_index,
                                code: code.clone(),
                                retryable: *retryable,
                            });
                            report.rejected.push(client_commit_id.to_owned());
                            self.outbox.remove(index);
                            self.persist_outbox_delete(client_commit_id);
                        }
                    }
                    _ => {
                        report.rejected.push(client_commit_id.to_owned());
                        self.outbox.remove(index);
                        self.persist_outbox_delete(client_commit_id);
                    }
                }
            }
        }
    }

    // -- subscription sections ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn process_section(
        &mut self,
        transport: &mut dyn Transport,
        id: &str,
        status: SubStatus,
        reason_code: &str,
        effective_scopes: Vec<(String, Vec<String>)>,
        body: Vec<Frame>,
        next_cursor: i64,
        bootstrap_state: Option<String>,
        meta: &RequestMeta,
        report: &mut SyncReport,
    ) -> Result<(), SectionError> {
        let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
            return Ok(()); // unknown echo: ignore
        };
        match status {
            SubStatus::Revoked => {
                // §3.3: stop pulling, purge exactly the last effective grant.
                let (table, effective) = {
                    let sub = &self.subs[sub_index];
                    (sub.table.clone(), sub.effective.clone().unwrap_or_default())
                };
                let purged = self.purge_scope_rows(&table, &effective);
                let sub = &mut self.subs[sub_index];
                match purged {
                    Ok(()) => {
                        sub.state = SubState::Revoked;
                        sub.reason_code = Some(if reason_code.is_empty() {
                            "sync.scope_revoked".to_owned()
                        } else {
                            reason_code.to_owned()
                        });
                        report.revoked.push(id.to_owned());
                        let doomed_effective = effective;
                        let sub_table = table;
                        self.persist_sub(&self.subs[sub_index].clone());
                        self.drop_doomed_outbox(&sub_table, &doomed_effective);
                    }
                    Err(()) => {
                        // §3.3 fail closed: no local mapping — never clear by
                        // approximation; fatal configuration error.
                        sub.state = SubState::Failed;
                        sub.reason_code = Some("sync.scope_revoked".to_owned());
                        report.failed.push(id.to_owned());
                        self.persist_sub(&self.subs[sub_index].clone());
                    }
                }
                Ok(())
            }
            SubStatus::Reset => {
                // §4.6: discard cursor + bootstrap state, keep local rows —
                // reset is a staleness signal, not a purge signal.
                let sub = &mut self.subs[sub_index];
                sub.cursor = -1;
                sub.bootstrap_state = None;
                report.resets.push(id.to_owned());
                self.persist_sub(&self.subs[sub_index].clone());
                Ok(())
            }
            SubStatus::Active => {
                let fresh = meta
                    .fresh
                    .iter()
                    .find(|(fid, _)| fid == id)
                    .map(|(_, f)| *f)
                    .unwrap_or(false);
                // §3.3: each active echo replaces the persisted copy.
                self.subs[sub_index].effective = Some(effective_scopes);
                self.exec("SAVEPOINT syncular_section");
                let outcome =
                    self.apply_section_body(transport, sub_index, body, fresh, meta, report);
                match outcome {
                    Ok(()) => {
                        self.exec("RELEASE syncular_section");
                        let sub = &mut self.subs[sub_index];
                        // §1.4: durable cursor/resume state persists only at
                        // SUB_END.
                        sub.cursor = next_cursor;
                        sub.bootstrap_state = bootstrap_state;
                        sub.synced_once = true;
                        if sub.bootstrap_state.is_some() {
                            report.bootstrapping.push(id.to_owned());
                        }
                        self.persist_sub(&self.subs[sub_index].clone());
                        Ok(())
                    }
                    Err(SectionError::FailClosed) => {
                        // §5.6: subscription-local; the rest of the response
                        // still applies. SUB_END values are NOT persisted.
                        self.exec("ROLLBACK TO syncular_section");
                        self.exec("RELEASE syncular_section");
                        let sub = &mut self.subs[sub_index];
                        sub.state = SubState::Failed;
                        sub.reason_code = Some("sync.scope_revoked".to_owned());
                        report.failed.push(id.to_owned());
                        self.persist_sub(&self.subs[sub_index].clone());
                        Ok(())
                    }
                    Err(SectionError::Abort(code, message)) => {
                        // §1.4 rule 5: roll back the open subscription; do
                        // not persist its SUB_END values.
                        self.exec("ROLLBACK TO syncular_section");
                        self.exec("RELEASE syncular_section");
                        Err(SectionError::Abort(code, message))
                    }
                }
            }
        }
    }

    fn apply_section_body(
        &mut self,
        transport: &mut dyn Transport,
        sub_index: usize,
        body: Vec<Frame>,
        fresh: bool,
        meta: &RequestMeta,
        report: &mut SyncReport,
    ) -> Result<(), SectionError> {
        let mut saw_segment = false;
        for frame in body {
            match frame {
                Frame::Commit {
                    tables, changes, ..
                } => {
                    self.apply_commit_changes(&tables, &changes)
                        .map_err(|(c, m)| SectionError::Abort(c, m))?;
                    report.commits_applied += 1;
                }
                Frame::SegmentInline { payload } => {
                    let segment = decode_rows_segment(&payload)
                        .map_err(|e| SectionError::Abort(e.code.as_str().to_owned(), e.detail))?;
                    let first = !saw_segment;
                    saw_segment = true;
                    let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                    report.segment_rows_applied += applied;
                }
                Frame::SegmentRef {
                    segment_id,
                    media_type,
                    table,
                    row_cursor,
                    url,
                    url_expires_at_ms,
                    ..
                } => {
                    // §4.2: reject a descriptor whose mediaType was not
                    // advertised — never skip or guess.
                    let advertised = match media_type {
                        MediaType::Rows => {
                            meta.accept & ACCEPT_EXTERNAL_ROWS != 0
                                || meta.accept & ACCEPT_INLINE_ROWS != 0
                        }
                        MediaType::Sqlite => meta.accept & ACCEPT_SQLITE != 0,
                    };
                    if !advertised {
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            format!(
                                "SEGMENT_REF mediaType {} was not advertised in accept (§4.2)",
                                media_type.name()
                            ),
                        ));
                    }
                    if media_type == MediaType::Sqlite {
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            "sqlite segments are not implemented by this client".to_owned(),
                        ));
                    }
                    let requested_scopes_json =
                        canonical_scope_json(&self.subs[sub_index].requested);
                    let bytes = transport
                        .download_segment(&SegmentRequest {
                            segment_id: segment_id.clone(),
                            table,
                            url,
                            url_expires_at_ms,
                            requested_scopes_json,
                        })
                        .map_err(|e| SectionError::Abort(e.code, e.message))?;
                    // §5.1: verify the content address before applying.
                    let digest = Sha256::digest(&bytes);
                    let expected = segment_id
                        .strip_prefix("sha256:")
                        .unwrap_or(segment_id.as_str());
                    if bytes_to_hex(&digest) != expected {
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            "segment bytes do not match the content address (§5.1)".to_owned(),
                        ));
                    }
                    let segment = decode_rows_segment(&bytes)
                        .map_err(|e| SectionError::Abort(e.code.as_str().to_owned(), e.detail))?;
                    let first = row_cursor.is_none();
                    saw_segment = true;
                    let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                    report.segment_rows_applied += applied;
                }
                Frame::Unknown { .. } => {}
                _ => {
                    return Err(SectionError::Abort(
                        "sync.invalid_request".to_owned(),
                        "unexpected frame inside a subscription section".to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn apply_commit_changes(
        &mut self,
        tables: &[String],
        changes: &[ssp2::model::Change],
    ) -> Result<(), (String, String)> {
        for change in changes {
            let table_name = tables.get(change.table_index as usize).ok_or_else(|| {
                (
                    "sync.invalid_request".to_owned(),
                    "change tableIndex out of range".to_owned(),
                )
            })?;
            let table = self.schema.table(table_name).ok_or_else(|| {
                (
                    "sync.schema_mismatch".to_owned(),
                    format!("change targets unknown table {table_name:?}"),
                )
            })?;
            match change.op {
                Op::Upsert => {
                    let payload = change.row.as_ref().ok_or_else(|| {
                        (
                            "sync.invalid_request".to_owned(),
                            "upsert change without row payload".to_owned(),
                        )
                    })?;
                    let row = decode_row_bytes(table, payload)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    let version = change.row_version.unwrap_or(0);
                    self.write_base_row(&table.name.clone(), &row, version)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                }
                Op::Delete => {
                    self.delete_base_row(table_name, &change.row_id)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                }
            }
        }
        Ok(())
    }

    /// §5.6 segment application: validate against the generated schema,
    /// clear the grant on a fresh bootstrap's first page (fail closed
    /// without a mapping), then replace-or-upsert with no server version.
    fn apply_segment(
        &mut self,
        sub_index: usize,
        segment: &RowsSegment,
        first_fresh_page: bool,
    ) -> Result<u32, SectionError> {
        let (sub_table, effective) = {
            let sub = &self.subs[sub_index];
            (sub.table.clone(), sub.effective.clone().unwrap_or_default())
        };
        let table = self.schema.table(&sub_table).cloned().ok_or_else(|| {
            SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                format!("subscription table {sub_table:?} is not in the client schema"),
            )
        })?;
        // §5.2: the column table validates against the generated schema —
        // order, names, types, nullability; mismatch is fatal.
        let matches = segment.table == table.name
            && segment.schema_version == self.schema.version
            && segment.columns.len() == table.columns.len()
            && segment
                .columns
                .iter()
                .zip(table.columns.iter())
                .all(|(a, b)| a.name == b.name && a.ty == b.ty && a.nullable == b.nullable);
        if !matches {
            return Err(SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                "segment column table does not match the generated schema (§5.2)".to_owned(),
            ));
        }
        if first_fresh_page {
            // §5.6: delete local rows for the subscription's scope so
            // removed rows don't survive re-bootstrap; fail closed at the
            // clear too.
            self.purge_scope_rows(&table.name, &effective)
                .map_err(|()| SectionError::FailClosed)?;
        }
        let mut applied = 0u32;
        for block in &segment.blocks {
            for row in block {
                // Segment rows carry no server version (§5.6).
                self.write_base_row(&table.name, row, 0)
                    .map_err(|m| SectionError::Abort("sync.invalid_request".to_owned(), m))?;
                applied += 1;
            }
        }
        Ok(applied)
    }

    // -- scope purge + doomed outbox (§3.3) ----------------------------------------

    /// Delete base rows matching the effective scopes; `Err(())` = no local
    /// scope-column mapping for a key (the fail-closed case).
    fn purge_scope_rows(
        &mut self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
    ) -> Result<(), ()> {
        if effective.is_empty() {
            return Ok(());
        }
        let table = self.schema.table(table_name).ok_or(())?.clone();
        let mut clauses = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        for (variable, values) in effective {
            let column = table.scope_column(variable).ok_or(())?;
            let placeholders: Vec<String> = values
                .iter()
                .map(|v| {
                    params.push(SqlValue::Text(v.clone()));
                    "?".to_owned()
                })
                .collect();
            clauses.push(format!(
                "{} IN ({})",
                quote_ident(column),
                placeholders.join(", ")
            ));
        }
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            base_table(table_name),
            clauses.join(" AND ")
        );
        self.conn
            .execute(&sql, rusqlite::params_from_iter(params))
            .map_err(|_| ())?;
        Ok(())
    }

    /// §3.3: drop pending commits whose upserts provably land in the
    /// revoked effective scopes — whole-commit, never per-operation.
    fn drop_doomed_outbox(&mut self, table_name: &str, effective: &[(String, Vec<String>)]) {
        if effective.is_empty() {
            return;
        }
        let Some(table) = self.schema.table(table_name).cloned() else {
            return;
        };
        let mut mappings: Vec<(&str, &Vec<String>)> = Vec::new();
        for (variable, values) in effective {
            match table.scope_column(variable) {
                Some(column) => mappings.push((column, values)),
                None => return, // not provable without a mapping
            }
        }
        let doomed: Vec<String> = self
            .outbox
            .iter()
            .filter(|commit| {
                commit.ops.iter().any(|op| {
                    op.upsert
                        && op.table == table_name
                        && op.values.as_ref().is_some_and(|values| {
                            mappings
                                .iter()
                                .all(|(column, allowed)| match values.get(*column) {
                                    Some(Value::String(s)) => allowed.contains(s),
                                    Some(Value::Number(n)) => allowed.contains(&n.to_string()),
                                    _ => false,
                                })
                        })
                })
            })
            .map(|c| c.client_commit_id.clone())
            .collect();
        for id in doomed {
            self.outbox.retain(|c| c.client_commit_id != id);
            self.persist_outbox_delete(&id);
        }
    }

    // -- local row storage ----------------------------------------------------------

    fn write_base_row(&self, table_name: &str, row: &Row, version: i64) -> Result<(), String> {
        self.write_row(&base_table(table_name), table_name, row, version)
    }

    fn write_row(
        &self,
        full_table: &str,
        table_name: &str,
        row: &Row,
        version: i64,
    ) -> Result<(), String> {
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        let mut columns: Vec<String> = table.columns.iter().map(|c| quote_ident(&c.name)).collect();
        columns.push(quote_ident("_syncular_version"));
        let placeholders: Vec<String> = (0..columns.len()).map(|_| "?".to_owned()).collect();
        let mut params: Vec<SqlValue> = row.iter().map(cv_to_sql).collect();
        params.push(SqlValue::Integer(version));
        let sql = format!(
            "INSERT OR REPLACE INTO {full_table} ({}) VALUES ({})",
            columns.join(", "),
            placeholders.join(", ")
        );
        self.conn
            .execute(&sql, rusqlite::params_from_iter(params))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn delete_base_row(&self, table_name: &str, row_id: &str) -> Result<(), String> {
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        let sql = format!(
            "DELETE FROM {} WHERE CAST({} AS TEXT) = ?1",
            base_table(table_name),
            quote_ident(&table.primary_key)
        );
        self.conn
            .execute(&sql, rusqlite::params![row_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// §7.1: local reads see outbox state applied optimistically — rebuild
    /// every visible table as (base server state) + (pending outbox replay
    /// on top). Optimistic rows carry version `-1`.
    fn rebuild_overlay(&mut self) {
        self.exec("SAVEPOINT syncular_overlay");
        for table in self.schema.tables.clone() {
            let visible = visible_table(&table.name);
            let base = base_table(&table.name);
            self.exec(&format!("DELETE FROM {visible}"));
            self.exec(&format!("INSERT INTO {visible} SELECT * FROM {base}"));
        }
        for commit in self.outbox.clone() {
            for op in &commit.ops {
                let Some(table) = self.schema.table(&op.table).cloned() else {
                    continue;
                };
                if op.upsert {
                    let Some(values) = op.values.as_ref() else {
                        continue;
                    };
                    let mut row: Row = Vec::with_capacity(table.columns.len());
                    let mut ok = true;
                    for column in &table.columns {
                        match json_to_column_value(column, values.get(&column.name)) {
                            Ok(v) => row.push(v),
                            Err(_) => {
                                ok = false;
                                break;
                            }
                        }
                    }
                    if ok {
                        let _ = self.write_row(&visible_table(&table.name), &table.name, &row, -1);
                    }
                } else {
                    let sql = format!(
                        "DELETE FROM {} WHERE CAST({} AS TEXT) = ?1",
                        visible_table(&table.name),
                        quote_ident(&table.primary_key)
                    );
                    let _ = self.conn.execute(&sql, rusqlite::params![op.row_id]);
                }
            }
        }
        self.exec("RELEASE syncular_overlay");
    }

    fn exec(&self, sql: &str) {
        let _ = self.conn.execute_batch(sql);
    }

    // -- realtime (§8) ---------------------------------------------------------------

    pub fn connect_realtime(&mut self, transport: &mut dyn Transport) -> Result<(), String> {
        transport
            .realtime_connect()
            .map_err(|e| format!("{}: {}", e.code, e.message))?;
        self.realtime_connected = true;
        Ok(())
    }

    pub fn disconnect_realtime(&mut self, transport: &mut dyn Transport) {
        let _ = transport.realtime_close();
        self.realtime_connected = false;
    }

    /// Inbound JSON control message (§8.1). Unknown events are tolerated.
    pub fn on_realtime_text(&mut self, text: &str) {
        match parse_control(text) {
            Ok(ControlMessage::Hello { requires_sync, .. }) => {
                if requires_sync {
                    // §8.1: pull before trusting the socket for continuity.
                    self.sync_needed = true;
                }
            }
            Ok(ControlMessage::Wake { .. }) => {
                // §8.3: any wake-up means "run a pull soon", never data.
                self.sync_needed = true;
            }
            _ => {}
        }
    }

    /// Inbound binary delta: a complete SSP2 response (§8.2), applied like
    /// a pull response per section; an unapplied delta is a wake-up.
    pub fn on_realtime_binary(&mut self, transport: &mut dyn Transport, bytes: &[u8]) {
        if self.stopped {
            return;
        }
        let message = match decode_message(bytes) {
            Ok(m) if m.msg_kind == MsgKind::Response => m,
            _ => {
                self.sync_needed = true;
                return;
            }
        };
        let mut frames = message.frames.into_iter();
        let mut applied_cursor: Option<i64> = None;
        let mut any_covered = false;
        let mut dropped = false;
        while let Some(frame) = frames.next() {
            let Frame::SubStart {
                id,
                status,
                effective_scopes,
                ..
            } = frame
            else {
                continue;
            };
            let mut body = Vec::new();
            let mut next_cursor: Option<i64> = None;
            for inner in frames.by_ref() {
                match inner {
                    Frame::SubEnd {
                        next_cursor: nc, ..
                    } => {
                        next_cursor = Some(nc);
                        break;
                    }
                    Frame::Unknown { .. } => {}
                    other => body.push(other),
                }
            }
            let Some(next_cursor) = next_cursor else {
                dropped = true;
                break;
            };
            let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
                dropped = true;
                continue;
            };
            let sub = &self.subs[sub_index];
            // §8.2: only locally active, not mid-bootstrap subscriptions
            // apply; skipped sections are repaired by the next pull.
            if status != SubStatus::Active
                || sub.state != SubState::Active
                || sub.bootstrap_state.is_some()
                || !sub.synced_once
            {
                dropped = true;
                continue;
            }
            if next_cursor <= sub.cursor {
                // Idempotent redelivery of an already-covered window.
                any_covered = true;
                continue;
            }
            self.subs[sub_index].effective = Some(effective_scopes);
            self.exec("SAVEPOINT syncular_delta");
            let mut failed = false;
            for inner in body {
                if let Frame::Commit {
                    tables, changes, ..
                } = inner
                {
                    if self.apply_commit_changes(&tables, &changes).is_err() {
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                self.exec("ROLLBACK TO syncular_delta");
                self.exec("RELEASE syncular_delta");
                dropped = true;
                continue;
            }
            self.exec("RELEASE syncular_delta");
            let sub = &mut self.subs[sub_index];
            sub.cursor = next_cursor;
            self.persist_sub(&self.subs[sub_index].clone());
            applied_cursor = Some(applied_cursor.map_or(next_cursor, |c| c.max(next_cursor)));
        }
        if let Some(cursor) = applied_cursor {
            self.rebuild_overlay();
            // §8.2 ack point: the highest applied SUB_END.nextCursor.
            let ack = format!("{{\"type\":\"ack\",\"cursor\":{cursor}}}");
            let _ = transport.realtime_send(&ack);
        } else if !any_covered || dropped {
            // §8.2: a delta not applied at all is treated as a wake-up.
            self.sync_needed = true;
        }
    }

    /// §8.2 ack point after an HTTP pull on a live connection: the minimum
    /// cursor across active, non-bootstrapping subscriptions that have
    /// synced at least once. No such subscription, no ack.
    fn ack_after_pull(&mut self, transport: &mut dyn Transport) {
        if !self.realtime_connected {
            return;
        }
        let floor = self
            .subs
            .iter()
            .filter(|s| {
                s.state == SubState::Active
                    && s.bootstrap_state.is_none()
                    && s.synced_once
                    && s.cursor >= 0
            })
            .map(|s| s.cursor)
            .min();
        if let Some(cursor) = floor {
            let ack = format!("{{\"type\":\"ack\",\"cursor\":{cursor}}}");
            let _ = transport.realtime_send(&ack);
        }
    }
}
