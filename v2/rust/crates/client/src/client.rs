//! The Syncular v2 Rust client core (SPEC.md client-behavior contract):
//! rusqlite local storage, §3.2/§3.3 effective-scope persistence + purge,
//! §4 pull/cursor/bootstrap (§4.7 resume, §5.6 segment application), §6
//! push with outbox order, §7 optimistic apply / rollback / replay-on-top,
//! §2.3 clientCommitId idempotency, §8 realtime client rules, §10 errors.
//!
//! Built from `v2/SPEC.md` and the committed `ssp2` codec alone — no
//! reference to the v1 Rust tree or the v2 TypeScript client.

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use ssp2::model::{Frame, MediaType, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_rows_segment, Column, ColumnType, ColumnValue, Row, RowsSegment};
use ssp2::{
    decode_message, encode_message, encode_presence_publish, parse_control, ControlMessage,
    PresenceKind,
};

use crate::api::{
    ClientLimits, ConflictRecord, LeaseState, Mutation, PresencePeer, RejectionRecord, RowState,
    SchemaFloor, SubscriptionStateView, SyncOutcome, SyncReport, WindowBase,
};
use crate::schema::{parse_schema_json, ClientSchema};
use crate::transport::{SegmentRequest, Transport, TransportError};
use crate::values::{
    bytes_to_hex, canonical_scope_json, column_value_to_json, decode_row_bytes, encode_row_json,
    json_to_column_value, json_to_scope_map, render_row_id_json, scope_map_to_json, sort_scope_map,
};

/// §4.2 default: the rows baseline plus sqlite images (§5.3) — rusqlite
/// can always import an image, so the premier path is advertised unless
/// the host overrides `limits.accept`. Bit 3 (signed URLs, §5.4) is
/// added per transport capability at request-build time.
const DEFAULT_ACCEPT: u8 = 0b0111;
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;
const ACCEPT_EXTERNAL_ROWS: u8 = 1 << 1;
const ACCEPT_SQLITE: u8 = 1 << 2;
const ACCEPT_SIGNED_URLS: u8 = 1 << 3;

/// §7.4.1 persisted local schema-version marker (`_syncular_meta` key).
const LOCAL_SCHEMA_VERSION_KEY: &str = "localSchemaVersion";
/// §7.4.4 client-local code: a pending outbox commit cannot re-encode under
/// the new schema after a bump. Never a wire code (§10.3).
const OUTBOX_INCOMPATIBLE_CODE: &str = "sync.outbox_incompatible";

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
    /// §7.3.5: the opaque auth-lease state (from LEASE frames + lease errors).
    lease_state: Option<LeaseState>,
    /// §1.6: the schema-floor response stops syncing until an upgrade.
    stopped: bool,
    /// §7.4.5: true while a schema-bump reset + first re-bootstrap is in flight.
    upgrading: bool,
    /// §8.4 coalesced sync-needed signal.
    sync_needed: bool,
    realtime_connected: bool,
    /// §8.6 presence: scopeKey → (`actorId clientId` peer key → peer).
    presence: HashMap<String, HashMap<String, PresencePeer>>,
    /// Client clock (epoch ms) for the §5.4 `urlExpiresAtMs` check; the
    /// host may pin it (conformance runs on a virtual clock).
    now_ms: Option<i64>,
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn base_table(name: &str) -> String {
    quote_ident(&format!("_syncular_base_{name}"))
}

/// §4.8: a stable, server-opaque key for a window base — table + variable +
/// canonical fixed scopes. Two `set_window` calls with the same base
/// address the same registry rows.
/// §4.8 deferred eviction record: (sub id, table, effective scope map).
type PendingEvict = (String, String, Vec<(String, Vec<String>)>);

fn window_base_key(base: &WindowBase) -> String {
    format!(
        "{} {} {}",
        base.table,
        base.variable,
        canonical_scope_json(&base.fixed_scopes)
    )
}

/// §4.8: the full requested scope map for one unit (fixed scopes + unit).
fn unit_scopes(base: &WindowBase, unit: &str) -> Vec<(String, Vec<String>)> {
    let mut scopes = base.fixed_scopes.clone();
    scopes.retain(|(k, _)| k != &base.variable);
    scopes.push((base.variable.clone(), vec![unit.to_owned()]));
    scopes
}

/// §4.1 guidance: `w:<table>:<sha256(canonical scope map)[0..16]>`. Ids are
/// echoed not interpreted by the server, so the exact hash is client
/// convention; SHA-256 matches the SPEC's worked example.
fn derive_sub_id(base: &WindowBase, unit: &str) -> String {
    let canonical = canonical_scope_json(&unit_scopes(base, unit));
    let digest = Sha256::digest(canonical.as_bytes());
    let hex = bytes_to_hex(&digest);
    format!("w:{}:{}", base.table, &hex[..16])
}

fn visible_table(name: &str) -> String {
    quote_ident(name)
}

/// §7.4.3: is a `sqlite_master` table name a synced table (visible or base),
/// i.e. NOT one of the durable bookkeeping tables the reset preserves?
fn is_synced_table_name(name: &str) -> bool {
    if name.starts_with("sqlite_") {
        return false;
    }
    if name.starts_with("_syncular_base_") {
        return true; // the base half of a synced table pair
    }
    // Bookkeeping: outbox, subscriptions, meta, blob cache/uploads.
    !name.starts_with("_syncular_")
}

/// `"sha256:" + hex` of the bytes — the content address (§5.9.1).
fn blob_id_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", bytes_to_hex(&digest))
}

fn cv_to_sql(value: &Option<ColumnValue>) -> SqlValue {
    match value {
        None => SqlValue::Null,
        Some(ColumnValue::String(s)) => SqlValue::Text(s.clone()),
        Some(ColumnValue::Integer(i)) => SqlValue::Integer(*i),
        Some(ColumnValue::Float(f)) => SqlValue::Real(*f),
        Some(ColumnValue::Boolean(b)) => SqlValue::Integer(i64::from(*b)),
        Some(ColumnValue::Json(raw)) => SqlValue::Text(raw.0.clone()),
        Some(ColumnValue::BlobRef(raw)) => SqlValue::Text(raw.0.clone()),
        Some(ColumnValue::Bytes(b)) => SqlValue::Blob(b.clone()),
        // §5.10: crdt bytes store as BLOB, like bytes.
        Some(ColumnValue::Crdt(b)) => SqlValue::Blob(b.clone()),
    }
}

/// §5.3 image cell → row-codec value, strict per the declared column type
/// (`boolean` from INTEGER 0/1, `json` from its raw TEXT, NULL only when
/// nullable). Mismatches are image-producer violations.
fn sql_ref_to_column_value(
    column: &Column,
    value: rusqlite::types::ValueRef<'_>,
) -> Result<Option<ColumnValue>, String> {
    use rusqlite::types::ValueRef;
    use ssp2::segment::ColumnType;
    let mismatch = || {
        Err(format!(
            "image column {:?} holds a value of the wrong type",
            column.name
        ))
    };
    match value {
        ValueRef::Null => {
            if !column.nullable {
                return Err(format!(
                    "image column {:?} is NULL but not nullable",
                    column.name
                ));
            }
            Ok(None)
        }
        ValueRef::Integer(i) => match column.ty {
            ColumnType::Integer => Ok(Some(ColumnValue::Integer(i))),
            ColumnType::Boolean => Ok(Some(ColumnValue::Boolean(i != 0))),
            ColumnType::Float => Ok(Some(ColumnValue::Float(i as f64))),
            _ => mismatch(),
        },
        ValueRef::Real(f) => match column.ty {
            ColumnType::Float => Ok(Some(ColumnValue::Float(f))),
            _ => mismatch(),
        },
        ValueRef::Text(t) => {
            let text = std::str::from_utf8(t)
                .map_err(|_| format!("image column {:?} is not UTF-8", column.name))?;
            match column.ty {
                ColumnType::String => Ok(Some(ColumnValue::String(text.to_owned()))),
                ColumnType::Json => Ok(Some(ColumnValue::Json(RawJson(text.to_owned())))),
                ColumnType::BlobRef => Ok(Some(ColumnValue::BlobRef(RawJson(text.to_owned())))),
                _ => mismatch(),
            }
        }
        ValueRef::Blob(b) => match column.ty {
            ColumnType::Bytes => Ok(Some(ColumnValue::Bytes(b.to_vec()))),
            // §5.10: a crdt column stores its opaque bytes as BLOB, like bytes.
            ColumnType::Crdt => Ok(Some(ColumnValue::Crdt(b.to_vec()))),
            _ => mismatch(),
        },
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

/// Bind a driver JSON value form as a rusqlite parameter for [`SyncClient::query`].
/// Objects are only accepted in the `{"$bytes": hex}` byte-envelope form.
fn json_param_to_sql(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("query param number {n} is out of range"));
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(_) => {
            let hex = value
                .get("$bytes")
                .and_then(Value::as_str)
                .ok_or_else(|| "query object param must be a {\"$bytes\": hex} value".to_owned())?;
            SqlValue::Blob(crate::values::hex_to_bytes(hex)?)
        }
        Value::Array(_) => return Err("query array params are not supported".to_owned()),
    })
}

/// Map a rusqlite value with no schema column to consult (arbitrary query
/// output): integers/reals/text pass through by stored affinity, blobs ride
/// as `{"$bytes": hex}`. Distinct from [`sql_ref_to_json`], which uses the
/// schema column type to recover booleans/floats/json.
fn sql_ref_to_json_dynamic(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
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
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::with_connection(client_id, schema_json, limits, conn)
    }

    /// Build a client backed by an on-disk SQLite database at `path` — the
    /// seam a native host (Tauri plugin, FFI file-DB variant) uses to persist
    /// across process restarts. `create_tables` runs `IF NOT EXISTS`, so
    /// re-opening the same file reuses the persisted rows. Keeps rusqlite out
    /// of the command router's dependency set (the router only holds a path).
    pub fn open_path(
        client_id: String,
        schema_json: &Value,
        limits: ClientLimits,
        path: &str,
    ) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        Self::with_connection(client_id, schema_json, limits, conn)
    }

    /// Build a client over a caller-supplied rusqlite connection — the seam a
    /// native host (Tauri plugin, FFI file-DB variant) uses to back the core
    /// with an on-disk database (`Connection::open(path)`) rather than the
    /// default `:memory:`. The connection MUST be fresh (no pre-existing
    /// syncular tables); `create_tables` runs `IF NOT EXISTS`, so re-opening
    /// the same file across process restarts reuses the persisted rows.
    pub fn with_connection(
        client_id: String,
        schema_json: &Value,
        limits: ClientLimits,
        conn: Connection,
    ) -> Result<Self, String> {
        let schema = parse_schema_json(schema_json)?;
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
            lease_state: None,
            stopped: false,
            upgrading: false,
            sync_needed: false,
            realtime_connected: false,
            presence: HashMap::new(),
            now_ms: None,
        };
        client.create_tables()?;
        Ok(client)
    }

    /// Pin the client clock (epoch ms) — the §5.4 expiry check runs
    /// against this instead of system time (conformance virtual clock).
    pub fn set_now_ms(&mut self, now_ms: i64) {
        self.now_ms = Some(now_ms);
    }

    fn clock_now_ms(&self) -> i64 {
        self.now_ms.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        })
    }

    fn create_tables(&self) -> Result<(), String> {
        self.create_synced_tables()?;
        // Durable client bookkeeping (outbox + subscription + meta).
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS _syncular_outbox (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   commit_id TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_subscriptions (
                   id TEXT PRIMARY KEY, tbl TEXT NOT NULL, state_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_meta (
                   key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_windows (
                   base TEXT NOT NULL, unit TEXT NOT NULL, sub_id TEXT NOT NULL,
                   PRIMARY KEY (base, unit));
                 CREATE TABLE IF NOT EXISTS _syncular_window_pending_evict (
                   sub_id TEXT PRIMARY KEY, tbl TEXT NOT NULL,
                   effective_scopes TEXT NOT NULL);",
            )
            .map_err(|e| e.to_string())?;
        // §7.4.1: seed the persisted local schema-version marker on first
        // create (a fresh install is already at its generated version).
        if self.get_meta(LOCAL_SCHEMA_VERSION_KEY).is_none() {
            self.set_meta(LOCAL_SCHEMA_VERSION_KEY, &self.schema.version.to_string());
        }
        // §5.9.7 blob cache + pending-upload queue (created only when the
        // schema declares blob_ref columns; harmless otherwise).
        if self.schema_has_blobs() {
            self.conn
                .execute_batch(
                    "CREATE TABLE _syncular_blobs (blob_id TEXT PRIMARY KEY,
                       bytes BLOB NOT NULL, byte_length INTEGER NOT NULL,
                       media_type TEXT, refcount INTEGER NOT NULL DEFAULT 0,
                       created_at_ms INTEGER NOT NULL);
                     CREATE TABLE _syncular_blob_uploads (blob_id TEXT PRIMARY KEY,
                       media_type TEXT, created_at_ms INTEGER NOT NULL);",
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// True iff any synced table declares a `blob_ref` column (§5.9).
    fn schema_has_blobs(&self) -> bool {
        self.schema
            .tables
            .iter()
            .any(|t| t.columns.iter().any(|c| c.ty == ColumnType::BlobRef))
    }

    // -- meta (§7.4.1 marker, bookkeeping) ------------------------------------

    fn get_meta(&self, key: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .ok()
    }

    fn set_meta(&self, key: &str, value: &str) {
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        );
    }

    /// §7.4.5: true while a schema-bump reset + first re-bootstrap runs.
    pub fn upgrading(&self) -> bool {
        self.upgrading
    }

    /// §7.4.2 "app ships new code": swap to a NEW generated schema while
    /// keeping this client's local database (identity, outbox, tables). The
    /// §7.4.1 marker check then fires the wipe/re-bootstrap flow when the
    /// version changed. Mirrors the TS client's boot-time detection —
    /// the Rust core has no persistent restart, so recreation IS the boot.
    pub fn recreate_with_schema(&mut self, schema_json: &Value) -> Result<(), String> {
        let new_schema = parse_schema_json(schema_json)?;
        let marker: Option<i32> = self
            .get_meta(LOCAL_SCHEMA_VERSION_KEY)
            .and_then(|v| v.parse().ok());
        self.schema = new_schema;
        if marker == Some(self.schema.version) {
            // No version change — nothing to reset.
            return Ok(());
        }
        self.run_schema_reset()
    }

    /// §7.4.3 reset: whole-database local reset EXCEPT the outbox, clientId,
    /// and leaseState. Drops/recreates every synced table from the new
    /// schema, resets subscription sync-state (keeping registrations), clears
    /// the schema-floor stop state, rewrites the marker, drops outbox commits
    /// that cannot re-encode (§7.4.4), and replays the survivors on top.
    fn run_schema_reset(&mut self) -> Result<(), String> {
        self.upgrading = true;
        // Drop every synced table (base + visible) that currently exists —
        // discovered from sqlite_master so a bump that adds/removes tables is
        // handled. Bookkeeping tables (`_syncular_outbox/_subscriptions/_meta`
        // and the blob cache) are preserved; base tables are `_syncular_base_*`
        // so they are matched explicitly, not by the bookkeeping filter.
        let existing: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok)
                .filter(|name| is_synced_table_name(name))
                .collect()
        };
        for name in existing {
            let _ = self
                .conn
                .execute(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)), []);
        }
        // Recreate the synced tables from the NEW schema.
        self.create_synced_tables()?;
        // Reset every subscription's sync-state, keeping the registration.
        for sub in &mut self.subs {
            sub.cursor = -1;
            sub.bootstrap_state = None;
            sub.effective = None;
            sub.state = SubState::Active;
            sub.reason_code = None;
            sub.synced_once = false;
        }
        let subs = self.subs.clone();
        for sub in &subs {
            self.persist_sub(sub);
        }
        // The stop state is over: this client now ships a servable schema.
        self.stopped = false;
        self.schema_floor = None;
        // Rewrite the marker LAST so a crash mid-reset re-runs the reset.
        self.set_meta(LOCAL_SCHEMA_VERSION_KEY, &self.schema.version.to_string());
        // §7.4.4: drop outbox commits that cannot re-encode under the new
        // schema (a referenced column/table the bump removed), surfacing each
        // as a `sync.outbox_incompatible` rejection.
        self.drop_incompatible_outbox();
        // Re-apply the surviving outbox optimistically over the empty tables.
        self.rebuild_overlay();
        Ok(())
    }

    /// §7.4.4: a persisted upsert whose values reference a column the current
    /// schema lacks (or a removed table) cannot be encoded. Drop the commit
    /// and raise a client-local `sync.outbox_incompatible` rejection.
    fn drop_incompatible_outbox(&mut self) {
        let schema = &self.schema;
        let mut incompatible: Vec<String> = Vec::new();
        self.outbox.retain(|commit| {
            let bad = commit.ops.iter().any(|op| {
                if !op.upsert {
                    return false;
                }
                match schema.table(&op.table) {
                    None => true,
                    Some(table) => op.values.as_ref().is_some_and(|values| {
                        values
                            .keys()
                            .any(|key| !table.columns.iter().any(|c| &c.name == key))
                    }),
                }
            });
            if bad {
                incompatible.push(commit.client_commit_id.clone());
            }
            !bad
        });
        for client_commit_id in incompatible {
            self.persist_outbox_delete(&client_commit_id);
            self.rejections.push(RejectionRecord {
                client_commit_id,
                op_index: 0,
                code: OUTBOX_INCOMPATIBLE_CODE.to_owned(),
                retryable: false,
            });
        }
    }

    /// §7.4.3: (re)create the base + visible table pair for every synced
    /// table in the CURRENT schema (idempotent — `IF NOT EXISTS`).
    fn create_synced_tables(&self) -> Result<(), String> {
        for table in &self.schema.tables {
            for full in [base_table(&table.name), visible_table(&table.name)] {
                let mut cols: Vec<String> =
                    table.columns.iter().map(|c| quote_ident(&c.name)).collect();
                cols.push("\"_syncular_version\" INTEGER NOT NULL".to_owned());
                let sql = format!(
                    "CREATE TABLE IF NOT EXISTS {full} ({} , PRIMARY KEY ({}))",
                    cols.join(", "),
                    quote_ident(&table.primary_key)
                );
                self.conn.execute(&sql, []).map_err(|e| e.to_string())?;
            }
        }
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

    // -- windowed subscriptions (§4.8) ------------------------------------------

    /// §4.8: set the live window units for a base — a value-sharded family
    /// of subscriptions, one per unit. Added units get fresh subscriptions
    /// (image-lane bootstrap on the next sync); removed units are
    /// unsubscribed and evicted, fused in one local transaction (E1–E4).
    /// Idempotent; re-entry cancels any deferred eviction.
    pub fn set_window(&mut self, base: &WindowBase, units: &[String]) -> Result<(), String> {
        let table = self
            .schema
            .table(&base.table)
            .ok_or_else(|| format!("unknown table {:?}", base.table))?;
        if table.scope_column(&base.variable).is_none() {
            return Err(format!(
                "setWindow: table {:?} has no scope variable {:?} (§4.8)",
                base.table, base.variable
            ));
        }
        let base_key = window_base_key(base);
        let wanted: std::collections::HashSet<&String> = units.iter().collect();
        let live = self.load_window_units(&base_key);

        // Widen: units wanted but not live → fresh subscription + registry row.
        for unit in units {
            if live.iter().any(|(u, _)| u == unit) {
                continue;
            }
            let sub_id = derive_sub_id(base, unit);
            self.delete_pending_evict(&sub_id);
            self.insert_window_unit(&base_key, unit, &sub_id);
            self.subscribe(
                sub_id,
                base.table.clone(),
                unit_scopes(base, unit),
                base.params.clone(),
            )?;
        }

        // Shrink: units live but not wanted → unsubscribe fused with eviction.
        for (unit, sub_id) in live {
            if wanted.contains(&unit) {
                continue;
            }
            self.evict_unit(&base_key, base, &unit, &sub_id);
        }
        Ok(())
    }

    /// §4.8 completeness oracle (I3): the windowed-in units for a base.
    pub fn window_state(&self, base: &WindowBase) -> Vec<String> {
        self.load_window_units(&window_base_key(base))
            .into_iter()
            .map(|(unit, _)| unit)
            .collect()
    }

    fn load_window_units(&self, base_key: &str) -> Vec<(String, String)> {
        let mut stmt = match self
            .conn
            .prepare("SELECT unit, sub_id FROM _syncular_windows WHERE base = ?1 ORDER BY unit ASC")
        {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(rusqlite::params![base_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn insert_window_unit(&self, base_key: &str, unit: &str, sub_id: &str) {
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_windows(base, unit, sub_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![base_key, unit, sub_id],
        );
    }

    fn delete_window_unit(&self, base_key: &str, unit: &str) {
        let _ = self.conn.execute(
            "DELETE FROM _syncular_windows WHERE base = ?1 AND unit = ?2",
            rusqlite::params![base_key, unit],
        );
    }

    /// §4.8 E1–E4: evict one departing unit, fused with unsubscription.
    /// Deletes the unit's rows except those pinned by a pending outbox
    /// commit (E1); records a deferred eviction if any pin remains; discards
    /// the subscription's cursor/resume/effective-echo (E3) and version
    /// state with the rows (E2). Fail-closed: no local mapping ⇒ evict
    /// nothing.
    fn evict_unit(&mut self, base_key: &str, base: &WindowBase, unit: &str, sub_id: &str) {
        let effective = self
            .subs
            .iter()
            .find(|s| s.id == sub_id)
            .and_then(|s| s.effective.clone())
            .unwrap_or_else(|| unit_scopes(base, unit));
        let pinned = self.pinned_row_ids(&base.table);
        let deferred = self
            .evict_scope_rows(&base.table, &effective, &pinned)
            .unwrap_or(false);
        self.delete_window_unit(base_key, unit);
        self.unsubscribe(sub_id);
        if deferred {
            self.save_pending_evict(sub_id, &base.table, &effective);
        } else {
            self.delete_pending_evict(sub_id);
        }
        self.rebuild_overlay();
    }

    /// §4.8 E1: delete base rows matching effective scopes EXCEPT pinned
    /// primary keys; returns `Ok(true)` iff a pinned row was left behind (so
    /// the eviction must be deferred). `Err(())` = fail-closed (no mapping).
    fn evict_scope_rows(
        &mut self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
        pinned: &std::collections::HashSet<String>,
    ) -> Result<bool, ()> {
        if effective.is_empty() {
            return Ok(false);
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
        let mut sql = format!(
            "DELETE FROM {} WHERE {}",
            base_table(table_name),
            clauses.join(" AND ")
        );
        if !pinned.is_empty() {
            let pk = quote_ident(&table.primary_key);
            let holes: Vec<String> = pinned
                .iter()
                .map(|id| {
                    params.push(SqlValue::Text(id.clone()));
                    "?".to_owned()
                })
                .collect();
            sql.push_str(&format!(" AND {} NOT IN ({})", pk, holes.join(", ")));
        }
        self.conn
            .execute(&sql, rusqlite::params_from_iter(params))
            .map_err(|_| ())?;
        if pinned.is_empty() {
            return Ok(false);
        }
        // A pin defers the eviction only if a pinned row actually falls
        // inside this unit's effective scopes — re-select the survivors.
        let mut where_params: Vec<SqlValue> = Vec::new();
        let mut where_clauses = Vec::new();
        for (variable, values) in effective {
            let column = table.scope_column(variable).ok_or(())?;
            let placeholders: Vec<String> = values
                .iter()
                .map(|v| {
                    where_params.push(SqlValue::Text(v.clone()));
                    "?".to_owned()
                })
                .collect();
            where_clauses.push(format!(
                "{} IN ({})",
                quote_ident(column),
                placeholders.join(", ")
            ));
        }
        let pk = quote_ident(&table.primary_key);
        let select = format!(
            "SELECT {} FROM {} WHERE {}",
            pk,
            base_table(table_name),
            where_clauses.join(" AND ")
        );
        let mut stmt = self.conn.prepare(&select).map_err(|_| ())?;
        let survivors: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(where_params), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| ())?
            .filter_map(Result::ok)
            .collect();
        Ok(survivors.iter().any(|id| pinned.contains(id)))
    }

    /// §4.8 E1: retry deferred evictions after the outbox drains.
    fn drain_pending_evictions(&mut self) {
        let pending = self.load_pending_evictions();
        for (sub_id, table_name, effective) in pending {
            if self.schema.table(&table_name).is_none() {
                self.delete_pending_evict(&sub_id);
                continue;
            }
            let pinned = self.pinned_row_ids(&table_name);
            let deferred = self
                .evict_scope_rows(&table_name, &effective, &pinned)
                .unwrap_or(false);
            if !deferred {
                self.delete_pending_evict(&sub_id);
            }
        }
        self.rebuild_overlay();
    }

    /// §4.8 E1: primary keys of `table` referenced by a pending outbox
    /// commit — rows that MUST NOT be evicted until the commit drains.
    fn pinned_row_ids(&self, table: &str) -> std::collections::HashSet<String> {
        let mut pinned = std::collections::HashSet::new();
        for commit in &self.outbox {
            for op in &commit.ops {
                if op.table == table {
                    pinned.insert(op.row_id.clone());
                }
            }
        }
        pinned
    }

    fn save_pending_evict(&self, sub_id: &str, table: &str, effective: &[(String, Vec<String>)]) {
        let _ = self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_window_pending_evict(sub_id, tbl, effective_scopes)
               VALUES (?1, ?2, ?3)",
            rusqlite::params![sub_id, table, scope_map_to_json(effective).to_string()],
        );
    }

    fn delete_pending_evict(&self, sub_id: &str) {
        let _ = self.conn.execute(
            "DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?1",
            rusqlite::params![sub_id],
        );
    }

    fn load_pending_evictions(&self) -> Vec<PendingEvict> {
        let mut stmt = match self
            .conn
            .prepare("SELECT sub_id, tbl, effective_scopes FROM _syncular_window_pending_evict")
        {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        });
        let mut out = Vec::new();
        if let Ok(rows) = rows {
            for entry in rows.filter_map(Result::ok) {
                let (sub_id, table, json) = entry;
                if let Ok(value) = serde_json::from_str::<Value>(&json) {
                    if let Ok(effective) = json_to_scope_map(&value) {
                        out.push((sub_id, table, effective));
                    }
                }
            }
        }
        out
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

    /// §7.3.5: the client's opaque auth-lease state, if any.
    pub fn lease_state(&self) -> Option<&LeaseState> {
        self.lease_state.as_ref()
    }

    /// §7.3.5: record a request-level lease error (stop-and-surface). Only
    /// the two lease codes set it; other errors leave leaseState untouched.
    fn record_lease_error(&mut self, code: &str) {
        if code != "sync.auth_lease_required" && code != "sync.auth_lease_revoked" {
            return;
        }
        let mut next = self.lease_state.clone().unwrap_or_default();
        next.error_code = Some(code.to_owned());
        self.lease_state = Some(next);
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

    /// Run an arbitrary read-only SQL query against the local database and
    /// return each row as a `column-name → JSON value` map. This is the seam
    /// the React `useSyncQuery` live-query API needs (it takes app-authored
    /// SQL over the visible tables/views, not a fixed table read like
    /// [`read_rows`]).
    ///
    /// Bound `params` are the driver value forms: JSON strings/numbers/bools/
    /// null bind directly; a `{"$bytes": hex}` object binds as a BLOB — the
    /// same envelope the command surface uses everywhere else. Output BLOB
    /// columns come back as `{"$bytes": hex}` to round-trip cleanly.
    ///
    /// The result column typing is dynamic (SQLite's stored affinity), because
    /// arbitrary SQL can alias, join, and compute — there is no schema column
    /// to consult per output cell, unlike [`read_rows`].
    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
        let bound: Vec<SqlValue> = params
            .iter()
            .map(json_param_to_sql)
            .collect::<Result<_, _>>()?;
        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;
        let column_names: Vec<String> =
            stmt.column_names().into_iter().map(str::to_owned).collect();
        let bound_refs: Vec<&dyn rusqlite::ToSql> =
            bound.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let mut sql_rows = stmt
            .query(bound_refs.as_slice())
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = sql_rows.next().map_err(|e| e.to_string())? {
            let mut record = Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let value = row.get_ref(i).map_err(|e| e.to_string())?;
                record.insert(name.clone(), sql_ref_to_json_dynamic(value));
            }
            out.push(record);
        }
        Ok(out)
    }

    // -- request building ---------------------------------------------------------

    fn build_request(&self, url_capable: bool) -> (Message, RequestMeta) {
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
        // §4.2/§5.4: bit 3 is advertised iff the transport can fetch a
        // bare URL — capability negotiation, decided per transport.
        let accept = self.limits.accept.unwrap_or(if url_capable {
            DEFAULT_ACCEPT | ACCEPT_SIGNED_URLS
        } else {
            DEFAULT_ACCEPT
        });
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
        // §5.9.7 B4: upload pending blobs before pushing the referencing
        // rows, so the server-side existence check (§6.6) passes.
        if self.schema_has_blobs() {
            if let Err(TransportError { code, message }) = self.flush_blob_uploads(transport) {
                return SyncOutcome::Failed {
                    error_code: code,
                    message,
                };
            }
        }
        let (message, meta) = self.build_request(transport.supports_url_fetch());
        let request_bytes = encode_message(&message);
        // §8.7: rounds ride the socket whenever it is connected (one
        // loop, no fallback pair); the transport seam stays bytes-in /
        // bytes-out either way. Registration-at-round-end is server-side.
        let round = if self.realtime_connected {
            transport.realtime_sync(&request_bytes)
        } else {
            transport.sync(&request_bytes)
        };
        let response_bytes = match round {
            Ok(bytes) => bytes,
            Err(TransportError { code, message }) => {
                // §7.3.5: a request-level lease code stops-and-surfaces —
                // record it in leaseState (no local-data purge, §7.3.4).
                self.record_lease_error(&code);
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
                Frame::Lease {
                    lease_id,
                    expires_at_ms,
                } => {
                    // §7.3.5: persist the opaque lease; a fresh lease clears
                    // any prior lease error (the outage/revocation is over).
                    self.lease_state = Some(LeaseState {
                        lease_id: Some(lease_id),
                        expires_at_ms: Some(expires_at_ms),
                        error_code: None,
                    });
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
        // §5.9.7 B1: refcounts follow live rows after every apply (benign —
        // zero-ref bodies are retained as LRU entries, not deleted here).
        self.reconcile_blob_refcounts(false);

        if let Some((error_code, message)) = failure {
            return SyncOutcome::Failed {
                error_code,
                message,
            };
        }
        // §4.8 E1: the push half may have drained commits that pinned rows of
        // a shrunk window unit — retry any deferred evictions now.
        self.drain_pending_evictions();
        self.ack_after_pull(transport);
        // §7.4.5: the reset is over once the first post-reset pull round
        // leaves no subscription mid-bootstrap — the tables are rebuilt.
        if self.upgrading && report.bootstrapping.is_empty() {
            self.upgrading = false;
        }
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
                        // §5.9.7 B2: revocation deletes now-unauthorized blob
                        // bodies (evicted ≠ revoked).
                        self.reconcile_blob_refcounts(true);
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
                    row_count,
                    as_of_commit_seq,
                    scope_digest,
                    row_cursor,
                    next_row_cursor,
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
                    let bytes = if let Some(url) = url {
                        // §5.4: a url-carrying descriptor MUST be fetched
                        // from that URL; failure invalidates the whole
                        // descriptor (no fall-through to §5.5 — re-pull
                        // recovers, §1.4 rule 5).
                        if meta.accept & ACCEPT_SIGNED_URLS == 0 {
                            return Err(SectionError::Abort(
                                "sync.invalid_request".to_owned(),
                                "SEGMENT_REF carries a url but accept bit 3 was not advertised (§5.4)"
                                    .to_owned(),
                            ));
                        }
                        // §5.4: MUST NOT start a fetch at/past expiry.
                        if url_expires_at_ms.is_some_and(|exp| exp <= self.clock_now_ms()) {
                            return Err(SectionError::Abort(
                                "sync.segment_expired".to_owned(),
                                format!(
                                    "signed URL for segment {segment_id} expired before fetch — re-pull mints fresh descriptors (§5.4)"
                                ),
                            ));
                        }
                        transport
                            .fetch_url(&url)
                            .map_err(|e| SectionError::Abort(e.code, e.message))?
                    } else {
                        let requested_scopes_json =
                            canonical_scope_json(&self.subs[sub_index].requested);
                        transport
                            .download_segment(&SegmentRequest {
                                segment_id: segment_id.clone(),
                                table,
                                requested_scopes_json,
                            })
                            .map_err(|e| SectionError::Abort(e.code, e.message))?
                    };
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
                    if media_type == MediaType::Sqlite {
                        // §5.3: images are whole-table — a paged sqlite
                        // descriptor is invalid.
                        if row_cursor.is_some() || next_row_cursor.is_some() {
                            return Err(SectionError::Abort(
                                "sync.invalid_request".to_owned(),
                                "sqlite segments are whole-table: rowCursor/nextRowCursor must be absent (§5.3)"
                                    .to_owned(),
                            ));
                        }
                        let first = !saw_segment;
                        saw_segment = true;
                        let applied = self.apply_sqlite_segment(
                            sub_index,
                            &bytes,
                            fresh && first,
                            row_count,
                            as_of_commit_seq,
                            &scope_digest,
                        )?;
                        report.segment_rows_applied += applied;
                    } else {
                        let segment = decode_rows_segment(&bytes).map_err(|e| {
                            SectionError::Abort(e.code.as_str().to_owned(), e.detail)
                        })?;
                        let first = row_cursor.is_none();
                        saw_segment = true;
                        let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                        report.segment_rows_applied += applied;
                    }
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
    /// without a mapping), then replace-or-upsert each row with its
    /// segment-carried server version (§5.2).
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
                // §5.6: the row record's serverVersion is the row's
                // last-known server_version, same as a COMMIT rowVersion.
                self.write_base_row(&table.name, &row.values, row.server_version)
                    .map_err(|m| SectionError::Abort("sync.invalid_request".to_owned(), m))?;
                applied += 1;
            }
        }
        Ok(applied)
    }

    /// §5.3 sqlite-image application: validate the in-file metadata
    /// against the descriptor, validate column names/order against the
    /// generated schema, run the §5.6 first-page clear when fresh, then
    /// replace-or-upsert every image row with its `_syncular_version`.
    /// Mechanics: the image lands in a temp file read through a second
    /// rusqlite connection (semantics identical to ATTACH + INSERT…SELECT;
    /// ATTACH is unavailable inside the open section savepoint).
    fn apply_sqlite_segment(
        &mut self,
        sub_index: usize,
        bytes: &[u8],
        first_fresh_page: bool,
        row_count: i64,
        as_of_commit_seq: i64,
        scope_digest: &str,
    ) -> Result<u32, SectionError> {
        let invalid = |detail: &str| {
            SectionError::Abort(
                "sync.invalid_request".to_owned(),
                format!("sqlite segment rejected: {detail} (§5.3)"),
            )
        };
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

        let path = std::env::temp_dir().join(format!("syncular-image-{}.db", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).map_err(|_| invalid("image temp file write failed"))?;
        let img = match rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            Ok(conn) => conn,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                return Err(invalid("bytes do not open as a SQLite database"));
            }
        };
        let outcome = self.apply_sqlite_image(
            &img,
            &table,
            first_fresh_page,
            &effective,
            row_count,
            as_of_commit_seq,
            scope_digest,
        );
        drop(img);
        let _ = std::fs::remove_file(&path);
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_sqlite_image(
        &mut self,
        img: &rusqlite::Connection,
        table: &crate::schema::TableSchema,
        first_fresh_page: bool,
        effective: &[(String, Vec<String>)],
        row_count: i64,
        as_of_commit_seq: i64,
        scope_digest: &str,
    ) -> Result<u32, SectionError> {
        let invalid = |detail: String| {
            SectionError::Abort(
                "sync.invalid_request".to_owned(),
                format!("sqlite segment rejected: {detail} (§5.3)"),
            )
        };

        // 1. Metadata vs descriptor + client state (§5.3 rule 2; exactly
        //    one row).
        type MetaRow = (i64, String, i64, i64, String, i64, i64);
        let meta: MetaRow = img
            .query_row(
                "SELECT format, \"table\", \"schemaVersion\", \"asOfCommitSeq\",
                        \"scopeDigest\", \"rowCount\",
                        (SELECT count(*) FROM _syncular_segment)
                 FROM _syncular_segment",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .map_err(|_| invalid("missing or unreadable _syncular_segment metadata".to_owned()))?;
        let (format, meta_table, schema_version, pin, digest, meta_rows, meta_count) = meta;
        if meta_count != 1 {
            return Err(invalid(format!(
                "_syncular_segment must contain exactly one row, found {meta_count}"
            )));
        }
        if format != 1 {
            return Err(invalid(format!("format {format}")));
        }
        if meta_table != table.name {
            return Err(invalid(format!("image table {meta_table:?}")));
        }
        if schema_version != i64::from(self.schema.version) {
            return Err(invalid(format!("schemaVersion {schema_version}")));
        }
        if pin != as_of_commit_seq {
            return Err(invalid(format!("asOfCommitSeq {pin}")));
        }
        if digest != scope_digest {
            return Err(invalid("scopeDigest mismatch".to_owned()));
        }
        if meta_rows != row_count {
            return Err(invalid(format!("rowCount {meta_rows}")));
        }

        // 2. Column names and order vs the generated schema (§5.3 rule 3).
        let mut names: Vec<String> = Vec::new();
        {
            let mut stmt = img
                .prepare(&format!("PRAGMA table_info({})", quote_ident(&table.name)))
                .map_err(|_| invalid("image data table missing".to_owned()))?;
            let mut rows = stmt
                .query([])
                .map_err(|_| invalid("image data table unreadable".to_owned()))?;
            while let Some(row) = rows
                .next()
                .map_err(|_| invalid("image data table unreadable".to_owned()))?
            {
                names.push(
                    row.get::<_, String>(1)
                        .map_err(|_| invalid("image data table unreadable".to_owned()))?,
                );
            }
        }
        let mut expected: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
        expected.push("_syncular_version");
        if names.len() != expected.len() || names.iter().zip(expected.iter()).any(|(a, b)| a != b) {
            return Err(SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                "sqlite segment columns do not match the generated schema (§5.3)".to_owned(),
            ));
        }

        // 3. §5.6 first-page clear (fail closed without a mapping), then
        //    replace-or-upsert with the image-carried server versions.
        if first_fresh_page {
            self.purge_scope_rows(&table.name, effective)
                .map_err(|()| SectionError::FailClosed)?;
        }
        let column_list: Vec<String> = names.iter().map(|n| quote_ident(n)).collect();
        let mut stmt = img
            .prepare(&format!(
                "SELECT {} FROM {}",
                column_list.join(", "),
                quote_ident(&table.name)
            ))
            .map_err(|_| invalid("image data table unreadable".to_owned()))?;
        let mut rows = stmt
            .query([])
            .map_err(|_| invalid("image data table unreadable".to_owned()))?;
        let mut applied = 0u32;
        while let Some(row) = rows
            .next()
            .map_err(|_| invalid("image row unreadable".to_owned()))?
        {
            let mut values: Row = Vec::with_capacity(table.columns.len());
            for (i, column) in table.columns.iter().enumerate() {
                let cell = row
                    .get_ref(i)
                    .map_err(|_| invalid("image row unreadable".to_owned()))?;
                values.push(sql_ref_to_column_value(column, cell).map_err(&invalid)?);
            }
            let version: i64 = row
                .get(table.columns.len())
                .map_err(|_| invalid("image row unreadable".to_owned()))?;
            if version < 1 {
                return Err(invalid(format!(
                    "row _syncular_version must be >= 1, got {version}"
                )));
            }
            self.write_base_row(&table.name, &values, version)
                .map_err(|m| SectionError::Abort("sync.invalid_request".to_owned(), m))?;
            applied += 1;
        }
        if i64::from(applied) != row_count {
            return Err(invalid(format!(
                "image holds {applied} rows, descriptor says {row_count}"
            )));
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

    // -- blobs (§5.9) ----------------------------------------------------------------

    /// §5.9.7: hash bytes into the content address, cache them, queue the
    /// upload (flushed before the next push, B4). Returns the canonical
    /// BlobRef JSON `{blobId, byteLength, mediaType?}` for a `blob_ref`
    /// column value.
    pub fn upload_blob(
        &mut self,
        bytes: &[u8],
        media_type: Option<String>,
        name: Option<String>,
    ) -> Result<Value, String> {
        let blob_id = blob_id_for(bytes);
        let now = self.clock_now_ms();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, refcount, created_at_ms) VALUES (?,?,?,?,0,?)",
                rusqlite::params![blob_id, bytes, bytes.len() as i64, media_type, now],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blob_uploads(blob_id, media_type, created_at_ms) VALUES (?,?,?)",
                rusqlite::params![blob_id, media_type, now],
            )
            .map_err(|e| e.to_string())?;
        let mut obj = Map::new();
        obj.insert("blobId".to_owned(), Value::from(blob_id));
        obj.insert("byteLength".to_owned(), Value::from(bytes.len() as i64));
        if let Some(mt) = media_type {
            obj.insert("mediaType".to_owned(), Value::from(mt));
        }
        if let Some(n) = name {
            obj.insert("name".to_owned(), Value::from(n));
        }
        Ok(Value::Object(obj))
    }

    /// §5.9.7: resolve blob bytes — a content-addressed cache hit serves
    /// with no fetch (B1); a miss downloads (§5.9.5), verifies the address,
    /// caches, and returns `{blobId, byteLength, bytes:{$bytes:hex}}`.
    pub fn fetch_blob(
        &mut self,
        transport: &mut dyn Transport,
        blob_id_or_ref: &str,
    ) -> Result<Value, (String, String)> {
        let simple = |m: String| ("client.failed".to_owned(), m);
        let blob_id = if blob_id_or_ref.starts_with("sha256:") {
            blob_id_or_ref.to_owned()
        } else {
            let value: Value = serde_json::from_str(blob_id_or_ref)
                .map_err(|_| simple("blob ref is not JSON".to_owned()))?;
            value
                .get("blobId")
                .and_then(Value::as_str)
                .ok_or_else(|| simple("blob ref has no blobId".to_owned()))?
                .to_owned()
        };
        if let Some(cached) = self.get_cached_blob(&blob_id).map_err(simple)? {
            return Ok(cached);
        }
        // §5.9.5: propagate the server's blob.* code (blob.forbidden /
        // blob.not_found) verbatim so the harness can assert on it.
        let bytes = transport
            .blob_download(&blob_id)
            .map_err(|e| (e.code, e.message))?;
        // §5.9.5 inherits §5.1: verify the content address, reject mismatch.
        if blob_id_for(&bytes) != blob_id {
            return Err(simple(format!(
                "blob content address mismatch for {blob_id}"
            )));
        }
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, refcount, created_at_ms) VALUES (?,?,?,NULL,0,?)",
                rusqlite::params![blob_id, bytes, bytes.len() as i64, self.clock_now_ms()],
            )
            .map_err(|e| simple(e.to_string()))?;
        self.get_cached_blob(&blob_id)
            .map_err(simple)?
            .ok_or_else(|| simple("blob cache write failed".to_owned()))
    }

    fn get_cached_blob(&self, blob_id: &str) -> Result<Option<Value>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT bytes, byte_length, media_type FROM _syncular_blobs WHERE blob_id = ?")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![blob_id])
            .map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let bytes: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
            let byte_length: i64 = row.get(1).map_err(|e| e.to_string())?;
            let media_type: Option<String> = row.get(2).map_err(|e| e.to_string())?;
            let mut obj = Map::new();
            obj.insert("blobId".to_owned(), Value::from(blob_id.to_owned()));
            obj.insert("byteLength".to_owned(), Value::from(byte_length));
            let mut bytes_obj = Map::new();
            bytes_obj.insert("$bytes".to_owned(), Value::from(bytes_to_hex(&bytes)));
            obj.insert("bytes".to_owned(), Value::Object(bytes_obj));
            if let Some(mt) = media_type {
                obj.insert("mediaType".to_owned(), Value::from(mt));
            }
            return Ok(Some(Value::Object(obj)));
        }
        Ok(None)
    }

    /// §5.9.7 B4: upload every queued blob before push.
    fn flush_blob_uploads(&mut self, transport: &mut dyn Transport) -> Result<(), TransportError> {
        let pending: Vec<(String, Option<String>)> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT blob_id, media_type FROM _syncular_blob_uploads ORDER BY created_at_ms",
                )
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            rows.filter_map(Result::ok).collect()
        };
        for (blob_id, media_type) in pending {
            let bytes: Option<Vec<u8>> = self
                .conn
                .query_row(
                    "SELECT bytes FROM _syncular_blobs WHERE blob_id = ?",
                    rusqlite::params![blob_id],
                    |row| row.get(0),
                )
                .ok();
            match bytes {
                Some(bytes) => {
                    transport.blob_upload(&blob_id, &bytes, media_type.as_deref())?;
                    let _ = self.conn.execute(
                        "DELETE FROM _syncular_blob_uploads WHERE blob_id = ?",
                        rusqlite::params![blob_id],
                    );
                }
                None => {
                    let _ = self.conn.execute(
                        "DELETE FROM _syncular_blob_uploads WHERE blob_id = ?",
                        rusqlite::params![blob_id],
                    );
                }
            }
        }
        Ok(())
    }

    /// §5.9.7 B1/B2: recompute cache refcounts from live `blob_ref` columns
    /// in the BASE tables; `delete_orphans` deletes zero-ref bodies not
    /// pinned by a pending upload (the revocation side, B2).
    fn reconcile_blob_refcounts(&mut self, delete_orphans: bool) {
        if !self.schema_has_blobs() {
            return;
        }
        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for table in self.schema.tables.clone() {
            let blob_cols: Vec<String> = table
                .columns
                .iter()
                .filter(|c| c.ty == ColumnType::BlobRef)
                .map(|c| c.name.clone())
                .collect();
            for column in blob_cols {
                let sql = format!(
                    "SELECT {} FROM {} WHERE {} IS NOT NULL",
                    quote_ident(&column),
                    base_table(&table.name),
                    quote_ident(&column)
                );
                let Ok(mut stmt) = self.conn.prepare(&sql) else {
                    continue;
                };
                let Ok(rows) = stmt.query_map([], |row| row.get::<_, Option<String>>(0)) else {
                    continue;
                };
                for raw in rows.flatten().flatten() {
                    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                        if let Some(id) = value.get("blobId").and_then(Value::as_str) {
                            *counts.entry(id.to_owned()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
        let _ = self
            .conn
            .execute("UPDATE _syncular_blobs SET refcount = 0", []);
        for (blob_id, count) in &counts {
            let _ = self.conn.execute(
                "UPDATE _syncular_blobs SET refcount = ? WHERE blob_id = ?",
                rusqlite::params![count, blob_id],
            );
        }
        if delete_orphans {
            let _ = self.conn.execute(
                "DELETE FROM _syncular_blobs WHERE refcount = 0 AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)",
                [],
            );
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
        self.presence.clear(); // §8.6.1: presence is per-connection
    }

    /// §8.6.2: publish (or clear, `doc: None`) this client's presence
    /// document for `scope_key`. Requires a live socket; the document is
    /// ephemeral (lost on disconnect). Authorization is the connection's
    /// registration (§8.6.3) — an unheld key is rejected loudly by the
    /// server with `presence.forbidden`.
    pub fn set_presence(
        &mut self,
        transport: &mut dyn Transport,
        scope_key: &str,
        doc: Option<&Value>,
    ) -> Result<(), String> {
        if !self.realtime_connected {
            return Err("setPresence requires a connected realtime socket (§8.6)".to_string());
        }
        let text = encode_presence_publish(scope_key, doc);
        transport
            .realtime_send(&text)
            .map_err(|e| format!("{}: {}", e.code, e.message))
    }

    /// §8.6: the peers currently present on a scope key (ephemeral).
    pub fn presence(&self, scope_key: &str) -> Vec<PresencePeer> {
        self.presence
            .get(scope_key)
            .map(|peers| peers.values().cloned().collect())
            .unwrap_or_default()
    }

    /// §8.6 apply an inbound presence fanout to the local map.
    fn apply_presence(
        &mut self,
        scope_key: String,
        kind: Option<PresenceKind>,
        actor_id: Option<String>,
        client_id: Option<String>,
        doc: Option<Value>,
        error: Option<String>,
    ) {
        // The publisher-directed error variant is out-of-band; nothing to
        // record in the peer map.
        if error.is_some() {
            return;
        }
        let (Some(kind), Some(actor_id), Some(client_id)) = (kind, actor_id, client_id) else {
            return;
        };
        let peer_key = format!("{actor_id} {client_id}");
        match kind {
            PresenceKind::Leave => {
                if let Some(peers) = self.presence.get_mut(&scope_key) {
                    peers.remove(&peer_key);
                    if peers.is_empty() {
                        self.presence.remove(&scope_key);
                    }
                }
            }
            _ => {
                let doc = match doc {
                    Some(Value::Object(_)) => doc.unwrap(),
                    _ => return,
                };
                self.presence.entry(scope_key).or_default().insert(
                    peer_key,
                    PresencePeer {
                        actor_id,
                        client_id,
                        doc,
                    },
                );
            }
        }
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
            Ok(ControlMessage::Presence {
                scope_key,
                kind,
                actor_id,
                client_id,
                doc,
                error,
                ..
            }) => {
                self.apply_presence(scope_key, kind, actor_id, client_id, doc, error);
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
            self.reconcile_blob_refcounts(false);
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
