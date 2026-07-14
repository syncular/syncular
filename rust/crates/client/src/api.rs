//! Driver-facing API shapes (JSON-able), mirroring the conformance
//! `ClientInstance` contract: sync reports, conflicts, rejections, row
//! states, subscription states. Serialized as camelCase to cross the shim
//! boundary unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// §4.8 window base: one table, the scope variable whose values are the
/// window units, any fixed scopes shared by every unit, and host-opaque
/// `params` carried onto each unit's subscription.
#[derive(Debug, Clone)]
pub struct WindowBase {
    pub table: String,
    pub variable: String,
    /// Scopes shared by every unit (other variables), if any.
    pub fixed_scopes: Vec<(String, Vec<String>)>,
    pub params: Option<String>,
}

/// §4.8 completeness oracle (I3): the windowed-in units for a base, plus
/// the subset whose bootstrap has not yet completed. Registration alone is
/// not completeness — a `pending` unit's local replica may be empty or
/// partial (its subscription still has `cursor: -1` or holds a resume
/// token), and MUST NOT be rendered as complete. A unit with zero server
/// rows still completes once its bootstrap round finishes.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    /// Windowed-in units for this base, ordered by value.
    pub units: Vec<String>,
    /// Registered units whose bootstrap has not yet completed.
    pub pending: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChange {
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_keys: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChange {
    pub base_key: String,
    pub table: String,
    pub units: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusSnapshot {
    pub outbox: usize,
    pub upgrading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_state: Option<LeaseState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_floor: Option<SchemaFloor>,
    pub sync_needed: bool,
}

/// JSON bindings carry the u64 revision as a decimal string (§7.5).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientChangeBatch {
    pub revision: String,
    pub tables: Vec<TableChange>,
    pub windows: Vec<WindowChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SyncStatusSnapshot>,
    pub conflicts_changed: bool,
    pub rejections_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncIntent {
    None,
    Interactive,
    Background {
        #[serde(rename = "delayMs")]
        delay_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandEffects {
    pub sync: SyncIntent,
}

impl CommandEffects {
    #[must_use]
    pub fn none() -> Self {
        Self {
            sync: SyncIntent::None,
        }
    }

    #[must_use]
    pub fn interactive() -> Self {
        Self {
            sync: SyncIntent::Interactive,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WindowCoverage {
    pub base: WindowBase,
    pub units: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowUnitRef {
    pub base_key: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageSnapshot {
    pub complete: bool,
    pub pending: Vec<WindowUnitRef>,
    pub missing: Vec<WindowUnitRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySnapshot {
    pub revision: String,
    pub rows: Vec<Map<String, Value>>,
    pub coverage: CoverageSnapshot,
}

impl WindowState {
    /// The per-unit verdict: registered AND bootstrap-complete.
    #[must_use]
    pub fn complete(&self, unit: &str) -> bool {
        self.units.iter().any(|u| u == unit) && !self.pending.iter().any(|u| u == unit)
    }
}

/// One local mutation (§6.1 shapes, schema-agnostic local form per §0).
#[derive(Debug, Clone)]
pub enum Mutation {
    Upsert {
        table: String,
        values: Map<String, Value>,
        base_version: Option<i64>,
    },
    Delete {
        table: String,
        row_id: String,
        base_version: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFloor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_schema_version: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_schema_version: Option<i32>,
}

/// §7.3.5: the client's opaque auth-lease state — `leaseId`/`expiresAtMs`
/// from the last `LEASE` frame, and `errorCode` once a round was rejected
/// with a request-level lease code (stop-and-surface; no data purge).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

/// §8.6 a peer's ephemeral presence document on a scope key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePeer {
    pub actor_id: String,
    pub client_id: String,
    pub doc: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: u32,
    pub applied: Vec<String>,
    pub rejected: Vec<String>,
    pub retryable: Vec<String>,
    pub conflicts: u32,
    pub commits_applied: u32,
    pub segment_rows_applied: u32,
    pub bootstrapping: Vec<String>,
    pub resets: Vec<String>,
    pub revoked: Vec<String>,
    pub failed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_floor: Option<SchemaFloor>,
}

/// `sync()` never panics or errors out-of-band: transport and protocol
/// failures come back as `Failed` (the driver's `{ ok: false }`).
#[derive(Debug, Clone)]
pub enum SyncOutcome {
    Ok(SyncReport),
    Failed { error_code: String, message: String },
}

impl SyncOutcome {
    pub fn to_json(&self) -> Value {
        match self {
            SyncOutcome::Ok(report) => {
                let mut map = Map::new();
                map.insert("ok".to_owned(), Value::Bool(true));
                map.insert(
                    "report".to_owned(),
                    serde_json::to_value(report).expect("report serializes"),
                );
                Value::Object(map)
            }
            SyncOutcome::Failed {
                error_code,
                message,
            } => {
                let mut map = Map::new();
                map.insert("ok".to_owned(), Value::Bool(false));
                map.insert("errorCode".to_owned(), Value::from(error_code.clone()));
                map.insert("message".to_owned(), Value::from(message.clone()));
                Value::Object(map)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRecord {
    pub client_commit_id: String,
    pub op_index: i32,
    pub table: String,
    pub row_id: String,
    pub code: String,
    pub server_version: i64,
    /// Driver row (bytes as `{"$bytes": hex}`), decoded from the conflict
    /// record's `serverRow` (§6.3).
    pub server_row: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectionRecord {
    pub client_commit_id: String,
    pub op_index: i32,
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowState {
    pub row_id: String,
    /// Local synced version: `-1` = optimistic, else the server version
    /// (from a `COMMIT` change or a segment row record, §5.2/§5.6).
    pub version: i64,
    pub values: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStateView {
    pub id: String,
    pub table: String,
    /// `active` | `revoked` | `failed`.
    pub status: String,
    pub cursor: i64,
    pub has_resume_token: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_scopes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

/// Client limits (§4.2 request knobs).
#[derive(Debug, Clone, Default)]
pub struct ClientLimits {
    pub limit_commits: Option<i32>,
    pub limit_snapshot_rows: Option<i32>,
    pub max_snapshot_pages: Option<i32>,
    /// §4.2 accept bitmask; this client defaults to `0b0111` (rows
    /// baseline + sqlite images, §5.3 — rusqlite can always import).
    pub accept: Option<u8>,
    /// §5.9.7 B1 blob-cache size cap (bytes). When set and the sum of cached
    /// body sizes exceeds it, zero-ref, non-pinned bodies are evicted LRU-first
    /// after each cache write. `None` ⇒ retain until storage pressure (default).
    pub blob_cache_max_bytes: Option<i64>,
}
