//! Driver-facing API shapes (JSON-able), mirroring the conformance
//! `ClientInstance` contract: sync reports, conflicts, rejections, row
//! states, subscription states. Serialized as camelCase to cross the shim
//! boundary unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Stable dynamic value boundary used by generated named queries.
pub type QueryValue = Value;
/// One dynamic query result row, keyed by QueryIR runtime projection name.
pub type QueryRow = Map<String, QueryValue>;

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
    pub current_schema_version: i32,
    pub outbox: usize,
    pub upgrading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_state: Option<LeaseState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_floor: Option<SchemaFloor>,
    pub sync_needed: bool,
}

pub const CLIENT_DIAGNOSTICS_VERSION: u8 = 1;
pub const MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedDiagnosticSubscription {
    pub id: String,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientDiagnosticsRequest {
    #[serde(default)]
    pub expected_subscriptions: Vec<ExpectedDiagnosticSubscription>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticsHost {
    pub kind: String,
    pub role: String,
    pub connectivity: String,
    pub realtime: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSubscription {
    pub id: String,
    pub table: String,
    pub state: String,
    pub complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRoundCounters {
    pub pushed: u32,
    pub applied: usize,
    pub rejected: usize,
    pub retryable: usize,
    pub conflicts: u32,
    pub commits_applied: u32,
    pub segment_rows_applied: u32,
    pub bootstrapping: usize,
    pub resets: usize,
    pub revoked: usize,
    pub failed: usize,
    pub deferred_commits: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLastRound {
    pub status: String,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counters: Option<DiagnosticRoundCounters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLastChange {
    pub revision: String,
    pub recorded_at_ms: i64,
    pub tables: Vec<String>,
    pub windows: Vec<String>,
    pub domains_truncated: bool,
    pub status_changed: bool,
    pub conflicts_changed: bool,
    pub rejections_changed: bool,
    pub outcomes_changed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticsStorage {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_bytes_approx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_outbox_bytes_approx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_outcome_bytes_approx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_outcome_entries: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_cache_bytes_approx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressure_reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticsSnapshot {
    pub version: u8,
    pub captured_at_ms: i64,
    pub host: ClientDiagnosticsHost,
    pub security_lifecycle: String,
    pub schema: ClientDiagnosticsSchema,
    pub replica: ClientDiagnosticsReplica,
    pub lease: ClientDiagnosticsLease,
    pub subscriptions: Vec<DiagnosticSubscription>,
    pub subscriptions_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_round: Option<DiagnosticLastRound>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_change: Option<DiagnosticLastChange>,
    pub storage: ClientDiagnosticsStorage,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticsSchema {
    pub current_version: i32,
    pub upgrading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_version: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticsReplica {
    pub local_revision: String,
    pub sync_needed: bool,
    pub pending_outbox: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticsLease {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
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
    pub outcomes_changed: bool,
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
    pub rows: Vec<QueryRow>,
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
    pub deferred_commits: usize,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRecord {
    pub client_commit_id: String,
    pub op_index: i32,
    pub table: String,
    pub row_id: String,
    pub code: String,
    pub message: String,
    pub server_version: i64,
    /// Driver row (bytes as `{"$bytes": hex}`), decoded from the conflict
    /// record's `serverRow` (§6.3).
    pub server_row: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<CommitOperation>,
}

/// Bounded code-like metadata explicitly declared safe for authorized client
/// recovery UI. Diagnostic prose remains in `RejectionRecord.message`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectionDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<BTreeMap<String, String>>,
}

impl RejectionDetails {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > 4_096 {
            return Err("rejection details exceed 4096 encoded bytes".to_owned());
        }
        let details: Self = serde_json::from_str(raw)
            .map_err(|error| format!("invalid rejection details: {error}"))?;
        details.validate()?;
        Ok(details)
    }

    fn validate(&self) -> Result<(), String> {
        let mut members = 0;
        if let Some(paths) = &self.field_paths {
            members += 1;
            if paths.is_empty() || paths.len() > 32 {
                return Err("fieldPaths must contain 1-32 paths".to_owned());
            }
            let mut seen = std::collections::BTreeSet::new();
            for path in paths {
                if path.len() > 160 || !path.split('.').all(valid_identifier) || !seen.insert(path)
                {
                    return Err("fieldPaths contains an invalid or duplicate path".to_owned());
                }
            }
        }
        if let Some(reason) = &self.reason {
            members += 1;
            if !valid_token(reason, 96) {
                return Err("reason must be a lowercase stable token".to_owned());
            }
        }
        if let Some(action) = &self.required_action {
            members += 1;
            if !valid_token(action, 96) {
                return Err("requiredAction must be a lowercase stable token".to_owned());
            }
        }
        if let Some(references) = &self.references {
            members += 1;
            if references.is_empty() || references.len() > 16 {
                return Err("references must contain 1-16 entries".to_owned());
            }
            for (key, value) in references {
                if !valid_token(key, 64)
                    || value.is_empty()
                    || value.len() > 256
                    || value.trim() != value
                    || value.chars().any(char::is_control)
                {
                    return Err("references contains an invalid key or value".to_owned());
                }
            }
        }
        if members == 0 {
            return Err("rejection details must not be empty".to_owned());
        }
        Ok(())
    }
}

fn valid_identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn valid_token(token: &str, max: usize) -> bool {
    if token.is_empty() || token.len() > max || !token.starts_with(|c: char| c.is_ascii_lowercase())
    {
        return false;
    }
    let mut previous_separator = false;
    for character in token.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            previous_separator = false;
        } else if matches!(character, '.' | '_' | '-') && !previous_separator {
            previous_separator = true;
        } else {
            return false;
        }
    }
    !previous_separator
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RejectionRecord {
    pub client_commit_id: String,
    pub op_index: i32,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<RejectionDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<CommitOperation>,
}

/// Schema-agnostic local operation retained with a failed final outcome.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitOperation {
    pub table: String,
    pub row_id: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Map<String, Value>>,
    /// Normalized columns intentionally supplied to `patch()`; absent for a
    /// full-row mutate/upsert because intent is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommitOutcomeStatus {
    Applied,
    Cached,
    Conflict,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommitOutcomeResolution {
    Active,
    ResolvedKeepServer,
    Superseded,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommitOperationOutcome {
    Applied {
        #[serde(rename = "opIndex")]
        op_index: i32,
    },
    Conflict {
        conflict: ConflictRecord,
    },
    Error {
        rejection: RejectionRecord,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub sequence: i64,
    pub client_commit_id: String,
    pub status: CommitOutcomeStatus,
    pub recorded_at_ms: i64,
    pub results: Vec<CommitOperationOutcome>,
    /// Complete local failed-commit envelope retained after outbox drain.
    /// Absent for successful and historical outcomes; never sent over wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operations: Option<Vec<CommitOperation>>,
    pub resolution: CommitOutcomeResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_client_commit_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcomeQuery {
    pub limit: Option<usize>,
    #[serde(default)]
    pub active_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCommitOutcomeInput {
    pub client_commit_id: String,
    pub resolution: CommitOutcomeResolution,
    pub replacement_client_commit_id: Option<String>,
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

/// One AND-combined application-authorized local purge target. Targets in
/// one input are OR-combined. Selector columns must compile to plaintext
/// strings; values are bounded code-like routing identifiers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDataPurgeTarget {
    pub table: String,
    pub selectors: BTreeMap<String, Vec<String>>,
}

/// Durable local idempotency key plus exact routing targets. The host owns
/// directive authenticity and subscription gating; the client owns SQLite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDataPurgeInput {
    pub purge_id: String,
    pub targets: Vec<LocalDataPurgeTarget>,
}

/// Privacy-safe local purge acknowledgement; row ids never cross the bridge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataPurgeResult {
    pub already_applied: bool,
    pub purged_rows: usize,
    pub dropped_commits: usize,
}

/// Durable application repair id. Reusing the id is an exact no-op.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDataRebootstrapInput {
    pub rebootstrap_id: String,
}

/// Privacy-safe acknowledgement for a replicated-projection recovery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataRebootstrapResult {
    pub already_applied: bool,
    pub retained_commits: usize,
    pub reset_subscriptions: usize,
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
    /// Maximum durable final outcomes. Active conflicts/rejections are never
    /// pruned to satisfy the cap. Defaults to 1,000.
    pub outcome_retention_max_entries: Option<usize>,
}
