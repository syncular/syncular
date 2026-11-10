//! The Syncular v2 Rust client core (SPEC.md client-behavior contract):
//! rusqlite local storage, §3.2/§3.3 effective-scope persistence + purge,
//! §4 pull/cursor/bootstrap (§4.7 resume, §5.6 segment application), §6
//! push with outbox order, §7 optimistic apply / rollback / replay-on-top,
//! §2.3 clientCommitId idempotency, §8 realtime client rules, §10 errors.
//!
//! Built from `SPEC.md` and the committed `ssp2` codec alone — no
//! reference to the v1 Rust tree or the v2 TypeScript client.

use crate::{ProgressObserver, ProgressPhase, ProgressState};
use ssp2::encode_message;
use std::borrow::Cow;
#[cfg(test)]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use rusqlite::types::{ToSqlOutput, Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use ssp2::decode::WIRE_VERSION;
use ssp2::model::{Frame, MediaType, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
use ssp2::primitives::RawJson;
use ssp2::segment::{decode_rows_segment, Column, ColumnType, ColumnValue, Row, RowsSegment};
use ssp2::{decode_message, encode_presence_publish, parse_control, ControlMessage, PresenceKind};

use crate::api::{
    AppliedServerCommit, AppliedServerCommitSource, ClientChangeBatch, ClientDiagnosticsHost,
    ClientDiagnosticsLease, ClientDiagnosticsReplica, ClientDiagnosticsRequest,
    ClientDiagnosticsSchema, ClientDiagnosticsSnapshot, ClientDiagnosticsStorage, ClientError,
    ClientLimits, CommandEffects, CommitDelivery, CommitOperation, CommitOperationOutcome,
    CommitOutcome, CommitOutcomeQuery, CommitOutcomeResolution, CommitOutcomeStatus,
    ConflictRecord, CoverageSnapshot, CurrentBaseProof, CurrentBaseProofReason,
    DiagnosticLastChange, DiagnosticLastRound, DiagnosticQueryFailure, DiagnosticRoundCounters,
    DiagnosticSubscription, FetchedBlob, LeaseState, LocalDataPurgeInput, LocalDataPurgeResult,
    LocalDataPurgeTarget, LocalDataRebootstrapInput, LocalDataRebootstrapResult, Mutation,
    PresencePeer, PreviousVersionStatus, QueryOwner, QueryReadFailure, QueryRow, QuerySnapshot,
    QueryValue, RejectionDetails, RejectionRecord, ResolveCommitOutcomeInput, RetainedCommitRow,
    RetainedUniqueConflict, RowState, SchemaFloor, SnapshotRead, SubscriptionCatchup,
    SubscriptionRequest, SubscriptionStateView, SyncIntent, SyncOutcome, SyncReport,
    SyncStatusSnapshot, TableChange, WindowBase, WindowChange, WindowCoverage, WindowState,
    WindowUnitRef, CLIENT_DIAGNOSTICS_VERSION, MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS,
    MAX_DIAGNOSTIC_QUERY_FAILURES,
};
use crate::api::{RealtimePolicy, RealtimeState, REALTIME_UNAVAILABLE_CODE};
#[cfg(feature = "bench-internals")]
use crate::bench::{Phase, Recorder};
use crate::previous_version::{
    capture_previous_version_from_replica, first_incompatibility,
    reconcile_previous_version_at_boot, set_local_schema_descriptor,
    sweep_previous_version_container, PendingCommitAudit, PreviousVersionContextConfig,
    PreviousVersionLifecycle, PreviousVersionReadSpec, PreviousVersionSnapshot,
};
use crate::schema::{parse_schema_json, ClientSchema, FtsIndexSchema, TableSchema};
use crate::transport::{BlobDownload, SegmentRequest, Transport, TransportError};
use crate::values::{
    bytes_to_hex, canonical_scope_json, column_value_to_json, decode_row_bytes,
    encode_sparse_row_json, full_row_values, is_canonical_bytes_envelope, json_to_column_value,
    json_to_scope_map, normalize_values_casing, render_row_id_json, scope_map_to_json,
    sort_scope_map,
};

/// §4.2 default: rows and SQLite images, both applied in committed chunks.
/// Bit 3 (signed URLs, §5.4) is
/// added per transport capability at request-build time.
const DEFAULT_ACCEPT: u8 = 0b0111;
const ACCEPT_INLINE_ROWS: u8 = 1 << 0;
const ACCEPT_EXTERNAL_ROWS: u8 = 1 << 1;
const ACCEPT_SQLITE: u8 = 1 << 2;
const ACCEPT_SIGNED_URLS: u8 = 1 << 3;
const MAX_DIAGNOSTIC_DOMAINS: usize = 256;

/// §10.1 `recommendedAction` carried by a server HTTP error body.
fn recommended_action_of(details: &Option<Value>) -> Option<String> {
    details
        .as_ref()?
        .get("recommendedAction")?
        .as_str()
        .map(str::to_owned)
}

/// §2.2 scope migration: one commit carries the delete under the old scope and
/// the upsert under the new one. A reader that holds both scopes receives the
/// two changes in separate subscription sections, so section order would
/// otherwise decide whether the row survives. Collect the `(commitSeq, table,
/// rowId)` keys whose delete must be skipped because the same commit delivers
/// the row's upsert in another applied section. A section that carries both
/// changes itself keeps its own operation order.
fn coalesced_delete_keys(
    frames: &[Frame],
    mut applies: impl FnMut(&str, SubStatus, Option<i64>) -> bool,
) -> HashSet<(i64, String, String)> {
    let mut sections = Vec::new();
    let mut open: Option<(usize, String, SubStatus)> = None;
    for (index, frame) in frames.iter().enumerate() {
        match frame {
            Frame::SubStart { id, status, .. } => {
                open = Some((index, id.clone(), *status));
            }
            Frame::SubEnd { next_cursor, .. } => {
                if let Some((start, id, status)) = open.take() {
                    sections.push((start, index, id, status, Some(*next_cursor)));
                }
            }
            _ => {}
        }
    }
    type Key = (i64, String, String);
    let mut ops: HashMap<Key, (HashSet<usize>, HashSet<usize>)> = HashMap::new();
    let mut both_in_frame: HashSet<Key> = HashSet::new();
    let mut frame_ordinal = 0usize;
    for (start, end, id, status, next_cursor) in sections {
        if !applies(&id, status, next_cursor) {
            continue;
        }
        for frame in &frames[start + 1..end] {
            let Frame::Commit {
                commit_seq,
                tables,
                changes,
                ..
            } = frame
            else {
                continue;
            };
            frame_ordinal += 1;
            let mut local: HashMap<(String, String), (bool, bool)> = HashMap::new();
            for change in changes {
                let Some(table) = tables.get(change.table_index as usize) else {
                    continue;
                };
                let key = (*commit_seq, table.clone(), change.row_id.clone());
                let entry = ops.entry(key).or_default();
                let local_entry = local
                    .entry((table.clone(), change.row_id.clone()))
                    .or_default();
                match change.op {
                    Op::Upsert => {
                        entry.0.insert(frame_ordinal);
                        local_entry.0 = true;
                    }
                    Op::Delete => {
                        entry.1.insert(frame_ordinal);
                        local_entry.1 = true;
                    }
                }
            }
            for ((table, row_id), (has_upsert, has_delete)) in local {
                if has_upsert && has_delete {
                    both_in_frame.insert((*commit_seq, table, row_id));
                }
            }
        }
    }
    ops.into_iter()
        .filter_map(|(key, (upserts, deletes))| {
            (!both_in_frame.contains(&key) && !upserts.is_empty() && !deletes.is_empty())
                .then_some(key)
        })
        .collect()
}

/// §7.4.1 persisted local schema-version marker (`_syncular_meta` key).
pub(crate) const LOCAL_SCHEMA_VERSION_KEY: &str = "localSchemaVersion";
const LOCAL_REVISION_KEY: &str = "localRevision";
const CLIENT_ID_KEY: &str = "clientId";
const LEASE_STATE_KEY: &str = "leaseState";
const SCHEMA_FLOOR_KEY: &str = "schemaFloor";
pub(crate) const LOG_EPOCH_KEY: &str = "logEpoch";
/// Persisted fail-closed quarantine marker: present while a security preflight
/// is pending and `activateSecurity` has yet to run. Storing it in the replica
/// keeps the gate with the data it protects, so a rebuilt host handle reopening
/// the same file returns in preflight even though its in-memory state is fresh.
const SECURITY_PREFLIGHT_PENDING_KEY: &str = "securityPreflightPending";
const LOCAL_REBOOTSTRAP_RECEIPT_VERSION: u8 = 2;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// §7.4.4 client-local code: a pending outbox commit cannot re-encode under
/// the new schema after a bump. Never a wire code (§10.3).
const OUTBOX_INCOMPATIBLE_CODE: &str = "sync.outbox_incompatible";
/// §5.11 client-local code: an encode at the push seam resolved no usable key
/// id or named an unknown key. Never a wire code (§10.3).
const ENCRYPT_FAILED_CODE: &str = "client.encrypt_failed";
const INVALID_REQUEST_CODE: &str = "sync.invalid_request:";
/// §7.4.4: static text for a persisted commit the current codec refuses.
const LEGACY_VALUE_REFUSAL_MESSAGE: &str =
    "the persisted commit carries values the current codec refuses";
/// §7.4.4: bounded reason on every intrinsic value drop.
const INVALID_STORED_VALUES_REASON: &str = "invalid_stored_values";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedLocalDataRebootstrapReceipt {
    version: u8,
    retained_commits: u64,
    reset_subscriptions: u64,
}

fn invalid_local_rebootstrap_receipt() -> String {
    "sync.local_corrupt: persisted local rebootstrap receipt is invalid".to_owned()
}

fn encode_local_rebootstrap_receipt(
    retained_commits: usize,
    reset_subscriptions: usize,
) -> Result<String, String> {
    let retained_commits =
        u64::try_from(retained_commits).map_err(|_| invalid_local_rebootstrap_receipt())?;
    let reset_subscriptions =
        u64::try_from(reset_subscriptions).map_err(|_| invalid_local_rebootstrap_receipt())?;
    if retained_commits > MAX_JS_SAFE_INTEGER || reset_subscriptions > MAX_JS_SAFE_INTEGER {
        return Err(invalid_local_rebootstrap_receipt());
    }
    serde_json::to_string(&PersistedLocalDataRebootstrapReceipt {
        version: LOCAL_REBOOTSTRAP_RECEIPT_VERSION,
        retained_commits,
        reset_subscriptions,
    })
    .map_err(|_| invalid_local_rebootstrap_receipt())
}

fn decode_local_rebootstrap_receipt(value: &str) -> Result<(usize, usize), String> {
    // Pre-0.15.36 markers proved application but did not retain the receipt.
    if value == "v1" {
        return Ok((0, 0));
    }
    let receipt: PersistedLocalDataRebootstrapReceipt =
        serde_json::from_str(value).map_err(|_| invalid_local_rebootstrap_receipt())?;
    if receipt.version != LOCAL_REBOOTSTRAP_RECEIPT_VERSION
        || receipt.retained_commits > MAX_JS_SAFE_INTEGER
        || receipt.reset_subscriptions > MAX_JS_SAFE_INTEGER
    {
        return Err(invalid_local_rebootstrap_receipt());
    }
    Ok((
        usize::try_from(receipt.retained_commits)
            .map_err(|_| invalid_local_rebootstrap_receipt())?,
        usize::try_from(receipt.reset_subscriptions)
            .map_err(|_| invalid_local_rebootstrap_receipt())?,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubState {
    Active,
    Revoked,
    Failed,
}

#[cfg(test)]
mod observation_tests;

impl SubState {
    fn name(self) -> &'static str {
        match self {
            SubState::Active => "active",
            SubState::Revoked => "revoked",
            SubState::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "revoked" => Self::Revoked,
            "failed" => Self::Failed,
            _ => Self::Active,
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

impl Subscription {
    /// §8.2: a delta section applies only to a locally active subscription
    /// that holds a cursor and no resume token. A subscription at cursor -1
    /// (never synced, reset, or rebootstrapped) bootstraps on its own pull.
    fn takes_delta(&self) -> bool {
        self.state == SubState::Active
            && self.cursor >= 0
            && self.bootstrap_state.is_none()
            && self.synced_once
    }
}

/// Internal state for hosts that perform network I/O outside the client owner.
#[doc(hidden)]
pub struct CurrentBasePreparation {
    client_commit_id: String,
    sequence: i64,
    subscriptions: Vec<Subscription>,
    transport_epoch: u64,
    subscription_epoch: u64,
    security_epoch: u64,
}

#[cfg(test)]
mod row_ownership_tests;

#[cfg(test)]
mod subscription_rearm_tests;

#[derive(Debug, Clone)]
struct OutboxOp {
    upsert: bool,
    table: String,
    row_id: String,
    base_version: Option<i64>,
    /// Schema-agnostic local form (§0): driver JSON values, encoded with
    /// the current codec at send time. A key's presence IS the §6.1 sparse
    /// presence set — both the overlay and the wire payload derive from it.
    values: Option<Map<String, Value>>,
    /// §7.1 insert intent: `mutate` recorded this upsert while the row was
    /// absent from the visible replica. Replay and send-time encoding present
    /// every current-schema column; a column `values` lacks is NULL.
    insert: bool,
}

impl OutboxOp {
    /// The values this upsert presents under the current `table` (§7.1). An
    /// insert-intent operation presents every column, a missing one as NULL;
    /// `None` when a missing column is non-nullable, which leaves the commit
    /// unencodable (§7.4.4), or when the operation carries no values.
    fn presented_values(&self, table: &TableSchema) -> Option<Cow<'_, Map<String, Value>>> {
        let values = self.values.as_ref()?;
        if !self.insert || table.columns.iter().all(|c| values.contains_key(&c.name)) {
            return Some(Cow::Borrowed(values));
        }
        full_row_values(table, values.clone()).ok().map(Cow::Owned)
    }
}

impl From<&OutboxOp> for CommitOperation {
    fn from(operation: &OutboxOp) -> Self {
        Self {
            table: operation.table.clone(),
            row_id: operation.row_id.clone(),
            op: if operation.upsert { "upsert" } else { "delete" }.to_owned(),
            base_version: operation.base_version,
            values: operation.values.clone(),
            insert: operation.insert,
        }
    }
}

#[derive(Debug, Clone)]
struct OutboxCommit {
    client_commit_id: String,
    ops: Vec<OutboxOp>,
}

/// One commit's `(table, value keys, insert intent)` per upsert operation — the classification
/// shape the §7.4.4 send-time drop and the RFC 0005 D6 audit share, so the two
/// can never disagree about which commits cannot re-encode.
fn commit_audit_operations(commit: &OutboxCommit) -> Vec<(&str, Vec<&str>, bool)> {
    commit
        .ops
        .iter()
        .filter(|operation| operation.upsert)
        .map(|operation| {
            (
                operation.table.as_str(),
                operation
                    .values
                    .as_ref()
                    .map(|values| values.keys().map(String::as_str).collect())
                    .unwrap_or_default(),
                operation.insert,
            )
        })
        .collect()
}

type FailedCommit = (OutboxCommit, Map<String, Value>);

#[derive(Debug, Clone)]
struct CompiledLocalDataPurgeTarget {
    table: String,
    selectors: Vec<(String, Vec<String>)>,
}

struct StoredCommitOutcomeRow {
    sequence: i64,
    client_commit_id: String,
    status: String,
    recorded_at_ms: i64,
    results_json: String,
    operations_json: Option<String>,
    resolution: String,
    resolved_at_ms: Option<i64>,
    replacement_client_commit_id: Option<String>,
}

impl StoredCommitOutcomeRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            sequence: row.get(0)?,
            client_commit_id: row.get(1)?,
            status: row.get(2)?,
            recorded_at_ms: row.get(3)?,
            results_json: row.get(4)?,
            operations_json: row.get(5)?,
            resolution: row.get(6)?,
            resolved_at_ms: row.get(7)?,
            replacement_client_commit_id: row.get(8)?,
        })
    }
}

/// Section outcome distinguishing the §5.6 subscription-local fail-closed
/// path from a round-aborting failure (§1.4 rule 5).
enum SectionError {
    FailClosed,
    Abort(String, String),
    Transport(TransportError),
}

#[derive(Debug)]
pub(crate) struct RequestMeta {
    pushed_ids: Vec<String>,
    /// Subscription id → the request carried `cursor < 0` and no resume
    /// token (§5.6 first-page detection: a *fresh* bootstrap).
    fresh: Vec<(String, bool)>,
    pub(crate) accept: u8,
    /// §6.1 splitBatch: outbox commits held back from THIS request because
    /// the running operation count reached the push cap — the next round
    /// pushes them (`sync_needed` stays set while any remain).
    deferred_commits: usize,
}

#[derive(Default)]
struct ChangeAccumulator {
    /// None means table-wide; Some is the exact scoped domain.
    tables: BTreeMap<String, Option<BTreeSet<String>>>,
    windows: BTreeMap<(String, String), BTreeSet<String>>,
    status: bool,
    conflicts: bool,
    rejections: bool,
    outcomes: bool,
}

impl ChangeAccumulator {
    fn table(&mut self, table: &str) {
        self.tables.insert(table.to_owned(), None);
    }

    fn scope(&mut self, table: &str, key: String) {
        match self.tables.get_mut(table) {
            Some(None) => {}
            Some(Some(keys)) => {
                keys.insert(key);
            }
            None => {
                self.tables
                    .insert(table.to_owned(), Some(BTreeSet::from([key])));
            }
        }
    }

    fn window(&mut self, base_key: &str, table: &str, unit: &str) {
        self.windows
            .entry((base_key.to_owned(), table.to_owned()))
            .or_default()
            .insert(unit.to_owned());
    }

    fn touched(&self) -> bool {
        !self.tables.is_empty()
            || !self.windows.is_empty()
            || self.status
            || self.conflicts
            || self.rejections
            || self.outcomes
    }
}

/// §6.1: the server caps total operations per request (reference default
/// 500) and rejects the whole batch with `sync.too_many_operations`; the
/// client "splits and retries". Splitting happens at build time: commits are
/// included IN ORDER until the operation budget is spent, the rest wait for
/// the next round.
const PUSH_OPS_PER_REQUEST: usize = 500;
const MAX_LOCAL_PURGE_TARGETS: usize = 64;
const MAX_LOCAL_PURGE_SELECTORS: usize = 8;
const MAX_LOCAL_PURGE_VALUES: usize = 128;
const MAX_LOCAL_PURGE_VALUE_LENGTH: usize = 256;
pub const SECURITY_PREFLIGHT_REQUIRED_CODE: &str = "client.security_preflight_required";

/// Dirty visible tables; `None` means a whole-replica recovery/reset.
struct OverlayDirty(RefCell<Option<BTreeSet<String>>>);

impl OverlayDirty {
    fn clean() -> Self {
        Self(RefCell::new(Some(BTreeSet::new())))
    }
    fn get(&self) -> bool {
        self.0
            .borrow()
            .as_ref()
            .is_none_or(|tables| !tables.is_empty())
    }
    fn set(&self, dirty: bool) {
        *self.0.borrow_mut() = if dirty { None } else { Some(BTreeSet::new()) };
    }
    fn table(&self, table: &str) {
        if let Some(tables) = self.0.borrow_mut().as_mut() {
            tables.insert(table.to_owned());
        }
    }
    fn snapshot(&self) -> Option<BTreeSet<String>> {
        self.0.borrow().clone()
    }
    fn restore(&self, tables: Option<BTreeSet<String>>) {
        *self.0.borrow_mut() = tables;
    }
}

/// A copy-on-write in-memory mirror: a [`Rollback`] shares it, and the first
/// write after a capture copies it once.
#[derive(Debug, Clone, Default)]
struct Shared<T>(Arc<T>);

impl<T> std::ops::Deref for Shared<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T: Clone> std::ops::DerefMut for Shared<T> {
    fn deref_mut(&mut self) -> &mut T {
        Arc::make_mut(&mut self.0)
    }
}

impl<T> From<T> for Shared<T> {
    fn from(value: T) -> Self {
        Self(Arc::new(value))
    }
}

/// The in-memory mirrors of durable state, captured before a local
/// transaction and restored when it rolls back. Queues only grow inside a
/// transaction, so their lengths suffice.
#[derive(Debug, Clone)]
struct Rollback {
    subs: Shared<Vec<Subscription>>,
    outbox: Shared<Vec<Arc<OutboxCommit>>>,
    failed_commits: Shared<Vec<FailedCommit>>,
    conflicts: Shared<Vec<ConflictRecord>>,
    rejections: Shared<Vec<RejectionRecord>>,
    schema_floor: Option<SchemaFloor>,
    lease_state: Option<LeaseState>,
    stopped: bool,
    upgrading: bool,
    sync_needed: bool,
    active_round: Option<uuid::Uuid>,
    overlay_dirty: Option<BTreeSet<String>>,
    change_queue: usize,
    sync_intent_queue: usize,
    last_change: Option<DiagnosticLastChange>,
}

pub struct SyncClient {
    #[cfg(feature = "bench-internals")]
    benchmark_phases: Recorder,
    conn: Connection,
    schema: ClientSchema,
    client_id: String,
    limits: ClientLimits,
    subs: Shared<Vec<Subscription>>,
    outbox: Shared<Vec<Arc<OutboxCommit>>>,
    failed_commits: Shared<Vec<FailedCommit>>,
    retain_failed_commits: bool,
    conflicts: Shared<Vec<ConflictRecord>>,
    rejections: Shared<Vec<RejectionRecord>>,
    schema_floor: Option<SchemaFloor>,
    /// §7.3.5: the opaque auth-lease state (from LEASE frames + lease errors).
    lease_state: Option<LeaseState>,
    /// §1.6: the schema-floor response stops syncing until an upgrade.
    stopped: bool,
    /// §7.4.5: true while a schema-bump reset + first re-bootstrap is in flight.
    upgrading: bool,
    /// §8.4 coalesced sync-needed signal.
    sync_needed: bool,
    /// §8.8: how sync rounds treat the realtime binding, and its exact
    /// availability state with the evidence behind a lost or refused one.
    realtime_policy: RealtimePolicy,
    realtime_state: RealtimeState,
    realtime_reason_code: Option<String>,
    realtime_retry_delay_ms: Option<u64>,
    /// §8.6 presence: scopeKey → (`actorId clientId` peer key → peer).
    presence: HashMap<String, HashMap<String, PresencePeer>>,
    /// Client clock (epoch ms) for the §5.4 `urlExpiresAtMs` check; the
    /// host may pin it (conformance runs on a virtual clock).
    now_ms: Option<i64>,
    /// §5.11 client-side encryption keys (`keyId → key bytes`). Empty ⇒ E2EE
    /// off. The encrypt/decrypt seam (`values.rs`) is compiled only under the
    /// `e2ee` feature; without it, a schema with encrypted columns fails loud.
    encryption: crate::values::EncryptionConfig,
    /// Fail-closed host bootstrap gate. While set, command hosts permit only
    /// status/lifecycle inspection and an exact authorized local purge.
    security_preflight: bool,
    security_epoch: u64,
    transport_enabled: bool,
    transport_epoch: u64,
    subscription_epoch: u64,
    /// RFC 0005 D2/D8: the previous-version capture config. `None` (default)
    /// means the feature is off; the descriptor write and the container orphan
    /// sweep still happen.
    previous_version: Option<PreviousVersionContextConfig>,
    /// Per-table primary-key upsert SQL, built once per (full table name) —
    /// the row write path runs per row during bootstrap (§5.6), so the SQL
    /// string (and, via `prepare_cached`, its compiled statement) is reused
    /// instead of being rebuilt and re-prepared per row. Cleared on a §7.4.3
    /// schema reset (the column lists may have changed).
    insert_sql: RefCell<HashMap<String, String>>,
    /// §7.1: reconcile only tables whose base/outbox changed. Whole-replica
    /// reset and restart explicitly invalidate every table.
    overlay_dirty: OverlayDirty,
    // First SQLite failure of the current operation, before savepoint cleanup.
    storage_failure: RefCell<Option<QueryReadFailure>>,
    /// Test-only structural performance signal: response processing must not
    /// turn a batch of acknowledgements into one full overlay rebuild each.
    #[cfg(test)]
    overlay_rebuild_count: Cell<usize>,
    #[cfg(test)]
    acknowledged_replay_count: Cell<usize>,
    /// Test-only structural performance signal: outcome retention is enforced
    /// once per response rather than once per acknowledgement.
    #[cfg(test)]
    outcome_prune_count: Cell<usize>,
    /// Exact observer-transaction output drained by command/FFI hosts.
    progress: ProgressObserver,
    change_queue: VecDeque<ClientChangeBatch>,
    sync_intent_queue: VecDeque<SyncIntent>,
    /// Explicit exponential retry policy for transient transport failures.
    retry_delay_ms: u64,
    /// §7.6: the background retry the current round scheduled, if any.
    round_retry_delay_ms: Option<u64>,
    /// A round whose response never completed (§1.5): the client keeps its
    /// code and reports it on every following request until a round receives a
    /// complete, decodable response. The server already recorded the round, so
    /// nothing else can tell it the round failed on this side.
    round_failure: Option<String>,
    active_round: Option<uuid::Uuid>,
    last_round: Option<DiagnosticLastRound>,
    last_change: Option<DiagnosticLastChange>,
    /// §7.6: latest failed owned snapshot read per owner id, oldest first.
    query_failures: Vec<DiagnosticQueryFailure>,
    /// SPEC §1.4 rule 4: the open coalesced apply transaction of a response.
    coalesced: Option<CoalescedApply>,
    /// A coalesced apply transaction of the current response failed; every
    /// later observation of that response fails until it ends.
    coalesced_failure: Option<String>,
}

/// SPEC §1.4 rule 4: the frames and blocks of one response share one local
/// write transaction of at most `COALESCED_APPLY_ROWS` rows. The in-memory
/// state captured at its `BEGIN` is restored when its `COMMIT` fails.
struct CoalescedApply {
    rows: usize,
    rollback: Rollback,
}

const COALESCED_APPLY_ROWS: usize = 1024;

pub(crate) fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
/// §7.4.1 `_syncular_meta` helpers. Free functions so RFC 0005's
/// previous-version module reads and writes the SAME records as the client
/// instead of growing a parallel meta layer.
pub(crate) fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM _syncular_meta WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO _syncular_meta (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map(|_| ())
}

pub(crate) fn meta_delete(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM _syncular_meta WHERE key = ?1",
        rusqlite::params![key],
    )
    .map(|_| ())
}

/// Seek by the existing key while retaining the exact legacy text match.
fn row_id_predicate(table: &TableSchema) -> String {
    let key = quote_ident(&table.primary_key);
    let text_match = format!("CAST({key} AS TEXT) = ?1");
    match table.columns[table.pk_index].ty {
        ColumnType::String | ColumnType::Json => {
            format!("{key} = ?1 AND {text_match}")
        }
        // Native columns have no declared SQLite affinity. Match the stored
        // integer bind type explicitly. Unary + removes expression affinity so
        // SQLite can seek the typeless key; the text check preserves exact IDs.
        ColumnType::Integer | ColumnType::Boolean => {
            format!("{key} = +CAST(?1 AS INTEGER) AND {text_match}")
        }
        // REAL-to-text conversion can round distinct values to the same text.
        // Narrowing those matches by numeric equality would change behavior.
        _ => text_match,
    }
}

/// §3.3/§4.8/§5.6 row ownership: rows whose local scope columns match
/// `effective` and that no entry of `owners` matches. `owners` holds the
/// effective scopes of every other active subscription on the table that
/// holds rows; a scoped delete never removes a row one of them still covers.
/// Scope values bind by the column's declared type, as `row_id_predicate`
/// does. `Ok(None)` matches nothing (an empty map or value list); `Err(())`
/// is a missing local scope-column mapping (the fail-closed case).
fn local_scope_predicate(
    table: &TableSchema,
    effective: &[(String, Vec<String>)],
    owners: &[Vec<(String, Vec<String>)>],
) -> Result<Option<(String, Vec<SqlValue>)>, ()> {
    if effective.is_empty() || effective.iter().any(|(_, values)| values.is_empty()) {
        return Ok(None);
    }
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for (variable, values) in effective {
        let name = table.scope_column(variable).ok_or(())?;
        let column = table
            .columns
            .iter()
            .find(|column| column.name == name)
            .ok_or(())?;
        let key = quote_ident(name);
        let holes = vec!["?"; values.len()].join(", ");
        clauses.push(if column.ty == ColumnType::Integer {
            params.extend(values.iter().cloned().map(SqlValue::Text));
            let seek = vec!["+CAST(? AS INTEGER)"; values.len()].join(", ");
            format!("{key} IN ({seek}) AND CAST({key} AS TEXT) IN ({holes})")
        } else {
            format!("{key} IN ({holes})")
        });
        params.extend(values.iter().cloned().map(SqlValue::Text));
    }
    for owner in owners {
        if let Some((sql, owner_params)) = local_scope_predicate(table, owner, &[])? {
            clauses.push(format!("NOT ({sql})"));
            params.extend(owner_params);
        }
    }
    Ok(Some((clauses.join(" AND "), params)))
}

/// [`local_scope_predicate`] over decoded row values (retained rows).
fn owns_local_row(
    table: &TableSchema,
    effective: &[(String, Vec<String>)],
    owners: &[Vec<(String, Vec<String>)>],
    values: &Map<String, Value>,
) -> bool {
    let matches = |scopes: &[(String, Vec<String>)]| {
        !scopes.is_empty()
            && scopes.iter().all(|(variable, allowed)| {
                table
                    .scope_column(variable)
                    .and_then(|column| values.get(column))
                    .filter(|value| !value.is_null())
                    .is_some_and(|value| {
                        allowed.contains(
                            &value
                                .as_str()
                                .map_or_else(|| value.to_string(), str::to_owned),
                        )
                    })
            })
    };
    matches(effective) && !owners.iter().any(|owner| matches(owner))
}

fn is_local_operation_code_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
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
        "{}\0{}\0{}",
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

const FTS_SOURCE_ID_COLUMN: &str = "_syncular_source_id";

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

/// One [`SyncClient::write_row`] bind parameter, borrowing the row-codec
/// value it wraps — strings/JSON/bytes bind as borrowed TEXT/BLOB (no copy
/// per row on the §5.6 bootstrap path), scalars bind owned.
enum RowParam<'a> {
    Cell(&'a Option<ColumnValue>),
    Version(i64),
}

impl rusqlite::ToSql for RowParam<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            RowParam::Version(v) => ToSqlOutput::Owned(SqlValue::Integer(*v)),
            RowParam::Cell(cell) => match cell {
                None => ToSqlOutput::Owned(SqlValue::Null),
                Some(ColumnValue::String(s)) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
                Some(ColumnValue::Integer(i)) => ToSqlOutput::Owned(SqlValue::Integer(*i)),
                Some(ColumnValue::Float(f)) => ToSqlOutput::Owned(SqlValue::Real(*f)),
                Some(ColumnValue::Boolean(b)) => {
                    ToSqlOutput::Owned(SqlValue::Integer(i64::from(*b)))
                }
                Some(ColumnValue::Json(raw)) | Some(ColumnValue::BlobRef(raw)) => {
                    ToSqlOutput::Borrowed(ValueRef::Text(raw.0.as_bytes()))
                }
                // §5.10: crdt bytes store as BLOB, like bytes.
                Some(ColumnValue::Bytes(b)) | Some(ColumnValue::Crdt(b)) => {
                    ToSqlOutput::Borrowed(ValueRef::Blob(b))
                }
            },
        })
    }
}

// Retain a typed primary key across the current import chunk without copying row payloads.
fn owned_sql_value(param: impl rusqlite::ToSql) -> Result<SqlValue, String> {
    match param.to_sql().map_err(|error| error.to_string())? {
        ToSqlOutput::Owned(value) => Ok(value),
        ToSqlOutput::Borrowed(value) => {
            SqlValue::try_from(value).map_err(|error| error.to_string())
        }
        _ => Err("sync.invalid_request: unsupported SQLite key parameter".into()),
    }
}

/// §5.3 image cell → bind parameter, strict per the declared column type
/// (`boolean` from INTEGER 0/1, `json` from its raw TEXT, NULL only when
/// nullable). Mismatches are image-producer violations. Returns the cell
/// borrowed when the stored representation already matches what the row
/// codec would write, or the normalized scalar (boolean → 0/1, float from
/// INTEGER → REAL) otherwise — the local write is byte-identical to the
/// old convert-then-insert path without allocating per cell.
fn image_cell_param<'a>(column: &Column, value: ValueRef<'a>) -> Result<ToSqlOutput<'a>, String> {
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
            Ok(ToSqlOutput::Owned(SqlValue::Null))
        }
        ValueRef::Integer(i) => match column.ty {
            ColumnType::Integer => Ok(ToSqlOutput::Borrowed(value)),
            ColumnType::Boolean => Ok(ToSqlOutput::Owned(SqlValue::Integer(i64::from(i != 0)))),
            ColumnType::Float => Ok(ToSqlOutput::Owned(SqlValue::Real(i as f64))),
            _ => mismatch(),
        },
        ValueRef::Real(_) => match column.ty {
            ColumnType::Float => Ok(ToSqlOutput::Borrowed(value)),
            _ => mismatch(),
        },
        ValueRef::Text(t) => {
            std::str::from_utf8(t)
                .map_err(|_| format!("image column {:?} is not UTF-8", column.name))?;
            match column.ty {
                ColumnType::String | ColumnType::Json | ColumnType::BlobRef => {
                    Ok(ToSqlOutput::Borrowed(value))
                }
                _ => mismatch(),
            }
        }
        ValueRef::Blob(_) => match column.ty {
            // §5.10: a crdt column stores its opaque bytes as BLOB, like bytes.
            ColumnType::Bytes | ColumnType::Crdt => Ok(ToSqlOutput::Borrowed(value)),
            _ => mismatch(),
        },
    }
}

pub(crate) fn sql_ref_to_json(column: &Column, value: rusqlite::types::ValueRef<'_>) -> Value {
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
/// Objects are accepted in lossless `{"$bytes": hex}` and
/// `{"$bigint": decimal}` envelope forms.
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
            if let Some(hex) = value.get("$bytes").and_then(Value::as_str) {
                SqlValue::Blob(crate::values::hex_to_bytes(hex)?)
            } else if let Some(decimal) = value.get("$bigint").and_then(Value::as_str) {
                SqlValue::Integer(decimal.parse::<i64>().map_err(|_| {
                    format!("query bigint param {decimal:?} is outside SQLite's i64 range")
                })?)
            } else {
                return Err(
                    "query object param must be a {$bytes: hex} or {$bigint: decimal} value"
                        .to_owned(),
                );
            }
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
        ValueRef::Integer(i) => {
            // JSON/Tauri IPC cannot represent every SQLite i64 exactly. Keep
            // ordinary UI-sized integers ergonomic and envelope only values
            // beyond JavaScript's safe range.
            const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
            if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                Value::from(i)
            } else {
                let mut map = Map::new();
                map.insert("$bigint".to_owned(), Value::from(i.to_string()));
                Value::Object(map)
            }
        }
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let mut map = Map::new();
            map.insert("$bytes".to_owned(), Value::from(bytes_to_hex(b)));
            Value::Object(map)
        }
    }
}

/// §7.5: SQLite failures classify by result code into [`QueryReadFailure`].
fn query_connection(
    conn: &Connection,
    sql: &str,
    params: &[QueryValue],
) -> Result<Vec<QueryRow>, QueryReadFailure> {
    let lowered_sql = crate::query_guard::lower_public_query_sql(sql);
    let mut stmt = crate::query_guard::prepare_read_only(conn, &lowered_sql)?;
    let bound: Vec<SqlValue> = params
        .iter()
        .map(json_param_to_sql)
        .collect::<Result<_, _>>()?;
    // §2.4: an unaliased physical version column stays engine-internal, so a
    // `SELECT *` row feeds straight back into mutation values. An explicit
    // alias (`_sync_version AS v`) returns it as ordinary query data.
    let columns: Vec<(usize, String)> = stmt
        .column_names()
        .enumerate()
        .filter(|(_, name)| *name != "_syncular_version")
        .map(|(i, name)| (i, name.to_owned()))
        .collect();
    let bound_refs: Vec<&dyn rusqlite::ToSql> =
        bound.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let mut sql_rows = stmt.query(bound_refs.as_slice())?;
    let mut out = Vec::new();
    while let Some(row) = sql_rows.next()? {
        let mut record = Map::new();
        for (i, name) in &columns {
            let value = row.get_ref(*i)?;
            record.insert(name.clone(), sql_ref_to_json_dynamic(value));
        }
        out.push(record);
    }
    Ok(out)
}

fn persisted_window_state(
    conn: &Connection,
    base: &WindowBase,
) -> Result<WindowState, QueryReadFailure> {
    let mut stmt = conn.prepare(
        "SELECT windows.unit, subscriptions.state_json
           FROM _syncular_windows AS windows
           JOIN _syncular_subscriptions AS subscriptions
             ON subscriptions.id = windows.sub_id
          WHERE windows.base = ?1
          ORDER BY windows.unit ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![window_base_key(base)], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut units = Vec::new();
    let mut pending = Vec::new();
    for row in rows {
        let (unit, raw) = row?;
        let state: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("invalid persisted window subscription: {error}"))?;
        let is_pending = state.get("status").and_then(Value::as_str) != Some("active")
            || state.get("cursor").and_then(Value::as_i64).unwrap_or(-1) < 0
            || state
                .get("bootstrapState")
                .is_some_and(|value| !value.is_null());
        if is_pending {
            pending.push(unit.clone());
        }
        units.push(unit);
    }
    Ok(WindowState { units, pending })
}

/// One read-only statement in a §7.5 snapshot read.
#[derive(Debug, Clone, Copy)]
pub struct SnapshotStatement<'a> {
    pub sql: &'a str,
    pub params: &'a [Value],
}

/// A §7.5 atomic read request: read-only statements, window coverage,
/// subscription catch-up states, and commit deliveries, all resolved from one
/// SQLite read transaction and one revision.
#[derive(Debug, Clone, Default)]
pub struct SnapshotReadRequest<'a> {
    pub statements: Vec<SnapshotStatement<'a>>,
    pub coverage: &'a [WindowCoverage],
    pub subscriptions: Vec<String>,
    pub commit_ids: Vec<String>,
}

#[cfg(test)]
thread_local! {
    /// Test-only rendezvous that runs between the statements of one snapshot
    /// read. A test uses it to commit on another connection mid-read and prove
    /// the read transaction's snapshot and revision stay stable.
    static SNAPSHOT_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn run_snapshot_read_hook() {
    SNAPSHOT_READ_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

/// §7.5: resolve a request over one SQLite read transaction. The revision,
/// every statement's rows, coverage, catch-up states, and deliveries are
/// captured under one `SAVEPOINT`; any statement's failure rolls the whole
/// read back and releases the connection.
fn snapshot_read_connection(
    conn: &Connection,
    request: &SnapshotReadRequest<'_>,
) -> Result<SnapshotRead, QueryReadFailure> {
    conn.execute_batch("SAVEPOINT syncular_snapshot_read")?;
    let corrupt = |message: &str| QueryReadFailure {
        code: Some("sync.local_corrupt"),
        sqlite_code: None,
        sqlite_message: None,
        rollback_failure: None,
        message: message.to_owned(),
    };
    let stored_failure = |error: rusqlite::Error, message: &str| match error {
        rusqlite::Error::Utf8Error(..)
        | rusqlite::Error::InvalidColumnType(..)
        | rusqlite::Error::FromSqlConversionFailure(..)
        | rusqlite::Error::IntegralValueOutOfRange(..) => corrupt(message),
        _ => QueryReadFailure::from(error),
    };
    let result: Result<SnapshotRead, QueryReadFailure> = (|| {
        // The durable revision as a canonical decimal `u64`; a missing marker
        // is the legacy zero, and any other non-canonical value is corrupt.
        let revision: Option<String> = conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![LOCAL_REVISION_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| stored_failure(error, "persisted local revision is invalid"))?;
        let revision = match revision {
            None => "0".to_owned(),
            Some(value)
                if value == "0"
                    || (matches!(value.as_bytes().first(), Some(b'1'..=b'9'))
                        && value.bytes().all(|b| b.is_ascii_digit())
                        && value.parse::<u64>().is_ok()) =>
            {
                value
            }
            Some(_) => return Err(corrupt("persisted local revision is invalid")),
        };
        let mut queries = Vec::with_capacity(request.statements.len());
        for statement in &request.statements {
            queries.push(query_connection(conn, statement.sql, statement.params)?);
            #[cfg(test)]
            run_snapshot_read_hook();
        }
        let mut pending = Vec::new();
        let mut missing = Vec::new();
        for requested in request.coverage {
            let base_key = window_base_key(&requested.base);
            let state = persisted_window_state(conn, &requested.base)?;
            for unit in BTreeSet::from_iter(requested.units.iter().cloned()) {
                let reference = WindowUnitRef {
                    base_key: base_key.clone(),
                    unit: unit.clone(),
                };
                if !state.units.iter().any(|held| held == &unit) {
                    missing.push(reference);
                } else if state.pending.iter().any(|held| held == &unit) {
                    pending.push(reference);
                }
            }
        }
        let mut subscriptions = Vec::with_capacity(request.subscriptions.len());
        for id in &request.subscriptions {
            let row: Option<(String, String)> = conn
                .query_row(
                    "SELECT tbl, state_json FROM _syncular_subscriptions WHERE id = ?1",
                    rusqlite::params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| {
                    stored_failure(error, "persisted subscription state is invalid")
                })?;
            let Some((table, raw)) = row else {
                subscriptions.push(SubscriptionCatchup::Unknown { id: id.clone() });
                continue;
            };
            // Every persisted field is required to be well typed; a corrupt
            // record fails typed instead of inventing a state.
            let state: Value = serde_json::from_str(&raw)
                .map_err(|_| corrupt("persisted subscription state is invalid"))?;
            let status = match state.get("status").and_then(Value::as_str) {
                Some(value @ ("active" | "revoked" | "failed")) => value,
                _ => return Err(corrupt("persisted subscription state is invalid")),
            };
            let Some(cursor) = state.get("cursor").and_then(Value::as_i64) else {
                return Err(corrupt("persisted subscription state is invalid"));
            };
            if cursor.unsigned_abs() > MAX_JS_SAFE_INTEGER {
                return Err(corrupt("persisted subscription state is invalid"));
            }
            let effective_scopes = state
                .get("effectiveScopes")
                .filter(|value| !value.is_null());
            if let Some(scopes) = effective_scopes {
                json_to_scope_map(scopes)
                    .map_err(|_| corrupt("persisted subscription state is invalid"))?;
            }
            let has_resume_token = match state.get("bootstrapState") {
                None | Some(Value::Null) => false,
                Some(Value::String(_)) => true,
                Some(_) => return Err(corrupt("persisted subscription state is invalid")),
            };
            // A present reasonCode must be a string; a non-string value is a
            // corrupt record, never silently dropped.
            let reason_code = match state.get("reasonCode") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.clone()),
                Some(_) => return Err(corrupt("persisted subscription state is invalid")),
            };
            let active = status == "active";
            subscriptions.push(SubscriptionCatchup::Known {
                id: id.clone(),
                table,
                status: status.to_owned(),
                cursor,
                has_resume_token,
                bootstrap_complete: active && cursor >= 0 && !has_resume_token,
                known_pending_pages: active && (has_resume_token || cursor < 0),
                effective_scopes: effective_scopes.cloned(),
                reason_code,
            });
        }
        let mut deliveries = Vec::with_capacity(request.commit_ids.len());
        for id in &request.commit_ids {
            let pending: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM _syncular_outbox WHERE commit_id = ?1)",
                rusqlite::params![id],
                |row| row.get(0),
            )?;
            if pending {
                deliveries.push(CommitDelivery::Pending {
                    client_commit_id: id.clone(),
                });
                continue;
            }
            let row = conn
                .query_row(
                    "SELECT seq, client_commit_id, status, recorded_at_ms, results_json, operations_json,
                            resolution, resolved_at_ms, replacement_client_commit_id
                       FROM _syncular_commit_outcomes WHERE client_commit_id = ?1",
                    rusqlite::params![id],
                    StoredCommitOutcomeRow::from_row,
                )
                .optional()
                .map_err(|error| stored_failure(error, "persisted commit outcome is invalid"))?;
            deliveries.push(match row {
                Some(row) => CommitDelivery::Known {
                    client_commit_id: id.clone(),
                    outcome: SyncClient::outcome_from_row(row)
                        .map_err(|_| corrupt("persisted commit outcome is invalid"))?,
                },
                None => CommitDelivery::Unknown {
                    client_commit_id: id.clone(),
                },
            });
        }
        Ok(SnapshotRead {
            revision,
            queries,
            coverage: CoverageSnapshot {
                complete: pending.is_empty() && missing.is_empty(),
                pending,
                missing,
            },
            subscriptions,
            deliveries,
        })
    })();
    match result {
        Ok(read) => {
            conn.execute_batch("RELEASE syncular_snapshot_read")?;
            Ok(read)
        }
        Err(mut error) => {
            if let Err(rollback) = conn
                .execute_batch("ROLLBACK TO syncular_snapshot_read; RELEASE syncular_snapshot_read")
            {
                error.rollback_failure = Some(Box::new(QueryReadFailure::from(rollback)));
            }
            Err(error)
        }
    }
}

fn snapshot_connection(
    conn: &Connection,
    sql: &str,
    params: &[Value],
    coverage: &[WindowCoverage],
) -> Result<QuerySnapshot, QueryReadFailure> {
    let read = snapshot_read_connection(
        conn,
        &SnapshotReadRequest {
            statements: vec![SnapshotStatement { sql, params }],
            coverage,
            subscriptions: Vec::new(),
            commit_ids: Vec::new(),
        },
    )?;
    Ok(QuerySnapshot {
        revision: read.revision,
        rows: read
            .queries
            .into_iter()
            .next()
            .expect("single-query snapshot returns one result"),
        coverage: read.coverage,
    })
}

/// A long-lived read-only SQLite sidecar for latency-critical native views.
/// Network rounds stay serialized on the mutable core owner, while atomic
/// query snapshots use this independent connection and therefore never queue
/// behind HTTP/WebSocket latency.
pub struct FileQuerySnapshotReader {
    path: String,
    conn: Option<Connection>,
}

impl FileQuerySnapshotReader {
    #[must_use]
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            conn: None,
        }
    }

    fn connection(&mut self) -> Result<&Connection, QueryReadFailure> {
        if self.conn.is_none() {
            let conn = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(QueryReadFailure::from)?;
            conn.busy_timeout(std::time::Duration::from_millis(250))
                .map_err(QueryReadFailure::from)?;
            self.conn = Some(conn);
        }
        self.conn
            .as_ref()
            .ok_or_else(|| QueryReadFailure::from("read sidecar connection missing".to_owned()))
    }

    /// One atomic read over the shared primitive: every statement, coverage,
    /// catch-up, and delivery under one `SAVEPOINT` and one revision.
    pub fn snapshot_read(
        &mut self,
        request: &SnapshotReadRequest<'_>,
    ) -> Result<SnapshotRead, QueryReadFailure> {
        snapshot_read_connection(self.connection()?, request)
    }

    /// The current durable local revision. A host can skip a read when it is
    /// unchanged; a corrupt or unreadable marker fails typed.
    pub fn local_revision(&mut self) -> Result<String, QueryReadFailure> {
        Ok(self
            .snapshot_read(&SnapshotReadRequest::default())?
            .revision)
    }

    /// One subscription's persisted catch-up state (see the §7.5 contract).
    pub fn subscription_catchup(
        &mut self,
        id: &str,
    ) -> Result<SubscriptionCatchup, QueryReadFailure> {
        let read = self.snapshot_read(&SnapshotReadRequest {
            subscriptions: vec![id.to_owned()],
            ..Default::default()
        })?;
        Ok(read
            .subscriptions
            .into_iter()
            .next()
            .expect("one requested catch-up"))
    }

    /// One client commit's delivery status: pending, its retained outcome, or
    /// an explicit unknown (never held, or pruned by retention).
    pub fn commit_delivery(&mut self, id: &str) -> Result<CommitDelivery, QueryReadFailure> {
        let read = self.snapshot_read(&SnapshotReadRequest {
            commit_ids: vec![id.to_owned()],
            ..Default::default()
        })?;
        Ok(read
            .deliveries
            .into_iter()
            .next()
            .expect("one requested delivery"))
    }

    /// Hosts report an owned failure, and the first success after it, to the
    /// owning core through [`SyncClient::record_query_read`] (§7.6).
    pub fn query_snapshot(
        &mut self,
        sql: &str,
        params: &[Value],
        coverage: &[WindowCoverage],
    ) -> Result<QuerySnapshot, QueryReadFailure> {
        snapshot_connection(self.connection()?, sql, params, coverage)
    }
}

fn validate_authority_reads(
    schema: &ClientSchema,
    declarations: &[crate::api::AuthorityReadDeclaration],
) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for read in declarations {
        let table = schema
            .table(&read.table)
            .ok_or("client.authority_read_forbidden: authority table is not declared")?;
        let plain = |name: &str| {
            table.columns.iter().enumerate().any(|(i, c)| {
                c.name == name
                    && name != "authority_version"
                    && !name.starts_with("_sync")
                    && !table.encrypted_columns.iter().any(|e| e.index == i)
                    && matches!(
                        c.ty,
                        ssp2::segment::ColumnType::String
                            | ssp2::segment::ColumnType::Integer
                            | ssp2::segment::ColumnType::Float
                            | ssp2::segment::ColumnType::Boolean
                            | ssp2::segment::ColumnType::Json
                    )
            })
        };
        if !seen.insert(&read.table)
            || read.columns.is_empty()
            || read.columns.iter().collect::<BTreeSet<_>>().len() != read.columns.len()
            || !read.columns.contains(&table.primary_key)
            || !read.columns.iter().all(|c| plain(c))
            || read.scopes.is_empty()
            || !read.scopes.iter().all(|(v, values)| {
                table
                    .scope_column(v)
                    .is_some_and(|c| read.columns.iter().any(|column| column == c) && plain(c))
                    && !values.is_empty()
                    && values.iter().all(|v| !v.is_empty() && v != "*")
            })
        {
            return Err("client.authority_read_forbidden: authority reads require plain columns, a primary key and nonempty plain scope selectors".into());
        }
    }
    Ok(())
}

// §7.4.2: every open and recreation checks before any persistent writes.
/// A marker read that hit a recognized SQLite storage failure keeps that
/// classification (BUSY/LOCKED stay retryable); only an unclassified read
/// failure is the invalid-marker `sync.local_corrupt`.
fn schema_marker_read_failure(error: rusqlite::Error) -> String {
    let failure = QueryReadFailure::from(error);
    if failure.code.is_some() {
        failure.to_string()
    } else {
        "sync.local_corrupt: persisted local schema marker is unreadable or invalid".to_owned()
    }
}

/// §7.1: reject an invalid configured client limit before any storage is
/// opened or written. Zero would wedge the push queue and an out-of-range
/// value would differ per target; the TS core enforces the same bounds.
fn validate_client_limits(limits: &crate::api::ClientLimits) -> Result<(), String> {
    if limits.outcome_retention_max_entries == Some(0) {
        return Err("sync.invalid_request: outcomeRetentionMaxEntries must be positive".to_owned());
    }
    if [
        limits.max_push_commits_per_request,
        limits.max_push_operations_per_request,
        limits.max_push_request_bytes,
    ]
    .into_iter()
    .flatten()
    .any(|value| value == 0 || value > u32::MAX as usize)
    {
        return Err(
            "sync.invalid_request: push limit must be an integer in 1..=4294967295".to_owned(),
        );
    }
    Ok(())
}

fn read_local_schema_version(conn: &Connection, requested: i32) -> Result<Option<i32>, String> {
    let corrupt =
        || "sync.local_corrupt: persisted local schema marker is unreadable or invalid".to_owned();
    let table_type: Option<String> = conn
        .query_row(
            "SELECT type FROM sqlite_master WHERE name = '_syncular_meta'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(schema_marker_read_failure)?;
    let Some(table_type) = table_type else {
        return Ok(None);
    };
    if table_type != "table" {
        return Err(corrupt());
    }
    // §7.4.2: a duplicated marker cannot be resolved. `query_row` would take
    // whichever row SQLite returns first, and an older one would drive a
    // destructive reset over a newer replica.
    let mut statement = conn
        .prepare("SELECT value FROM _syncular_meta WHERE key = ?1")
        .map_err(schema_marker_read_failure)?;
    let mut rows = statement
        .query([LOCAL_SCHEMA_VERSION_KEY])
        .map_err(schema_marker_read_failure)?;
    let value: Option<String> = rows
        .next()
        .map_err(schema_marker_read_failure)?
        .map(|row| row.get(0))
        .transpose()
        .map_err(schema_marker_read_failure)?;
    if rows.next().map_err(schema_marker_read_failure)?.is_some() {
        return Err(corrupt());
    }
    let Some(value) = value else {
        let has_descriptor = conn
            .query_row(
                "SELECT 1 FROM _syncular_meta WHERE key = ?1 LIMIT 1",
                [crate::previous_version::LOCAL_SCHEMA_DESCRIPTOR_KEY],
                |_| Ok(()),
            )
            .optional()
            .map_err(schema_marker_read_failure)?
            .is_some();
        if has_descriptor {
            return Err(corrupt());
        }
        return Ok(None);
    };
    if !matches!(value.as_bytes().first(), Some(b'1'..=b'9'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(corrupt());
    }
    let version = value.parse::<i32>().map_err(|_| corrupt())?;
    if version > requested {
        return Err(
            "client.schema_downgrade: persisted local schema is newer than the requested schema"
                .to_owned(),
        );
    }
    Ok(Some(version))
}

/// A file replica on a browser worker must recover a hot journal before any
/// statement reads it. `wasm_vfs` replaces the installed OPFS VFS's reserved
/// lock callback, so install it before the connection opens its file.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn prepare_wasm_replica(path: &str) -> Result<(), String> {
    if path.is_empty() || path == ":memory:" {
        return Ok(());
    }
    crate::wasm_vfs::disable_foreign_lock_check()
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn prepare_wasm_replica(_path: &str) -> Result<(), String> {
    Ok(())
}

impl SyncClient {
    pub fn new_with_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
    ) -> Result<Self, String> {
        let resolved = client_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::with_connection(resolved, schema_json, limits, conn)
    }

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
        validate_client_limits(&limits)?;
        parse_schema_json(schema_json)?;
        prepare_wasm_replica(path)?;
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        Self::with_connection(client_id, schema_json, limits, conn)
    }

    /// Open a file replica and resolve its client id. Native targets require
    /// WAL for the independent snapshot reader; `wasm32-unknown-unknown`
    /// accepts the sqlite-wasm worker journal instead.
    pub fn open_path_with_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
        path: &str,
    ) -> Result<Self, String> {
        Self::open_path_with_identity_journal(
            client_id,
            schema_json,
            limits,
            path,
            !cfg!(all(target_arch = "wasm32", target_os = "unknown")),
        )
    }

    fn open_path_with_identity_journal(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
        path: &str,
        require_wal: bool,
    ) -> Result<Self, String> {
        validate_client_limits(&limits)?;
        // §7.4.2: an invalid requested version is refused before the replica is
        // even created, so a rejected constructor leaves no file behind.
        parse_schema_json(schema_json)?;
        prepare_wasm_replica(path)?;
        let conn = Connection::open(path).map_err(|e| format!("open db {path:?}: {e}"))?;
        // A file-backed native client uses an independent read connection for
        // latency-critical snapshots. WAL is SQLite's intended reader/writer
        // concurrency mode: a view read never holds a rollback-journal lock
        // that delays the client's next commit. The busy timeout must precede
        // this replica's own startup transaction; WAL is applied only after
        // startup succeeded, because a refused open must leave the replica's
        // journal mode and contents untouched (§7.4.2).
        conn.busy_timeout(std::time::Duration::from_millis(250))
            .map_err(|error| format!("configure db {path:?} busy timeout: {error}"))?;
        // Durability is the caller's contract here, not the VFS default: a
        // rollback-journal commit needs FULL before it writes the database
        // pages, or a killed worker can leave a half-written image behind.
        // WAL below inherits the same setting.
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|error| format!("configure db {path:?} synchronous: {error}"))?;
        let client = Self::with_connection_identity(client_id, schema_json, limits, conn)?;
        // A browser worker's sqlite-wasm VFS has no WAL mode, and the wasm
        // host has no independent snapshot reader. The WAL requirement exists
        // for native file replicas, where it is the reader/writer boundary.
        if require_wal {
            let journal_mode: String = client
                .conn
                .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
                .map_err(|error| Self::sqlite_failure(&client.storage_failure, error))?;
            if journal_mode != "wal" {
                return Err(
                    "sync.invalid_request: file-backed client requires WAL journal mode".to_owned(),
                );
            }
        }
        Ok(client)
    }

    /// Delete a file replica at `path`, including its `-journal`, `-wal`, and
    /// `-shm` sidecars, through the VFS that owns it. Use this after
    /// `client.storage_corrupt`: an OPFS SAH pool stores those files under
    /// opaque names, so deleting the pool directory behind SQLite bypasses the
    /// pool's slot accounting.
    ///
    /// Close the client and every [`FileQuerySnapshotReader`] on `path` first;
    /// a VFS cannot delete a file another handle still owns. A file that does
    /// not exist counts as deleted, so a cleanly closed replica without
    /// sidecars resets. The next open
    /// creates a fresh replica (new client id) and re-bootstraps from the
    /// server. A memory replica has nothing to delete and fails with
    /// `sync.invalid_request`.
    pub fn reset_replica(path: &str) -> Result<(), String> {
        if path.is_empty() || path == ":memory:" {
            return Err("sync.invalid_request: a memory replica has nothing to reset".to_owned());
        }
        // SAFETY: a null VFS name asks SQLite for its process-wide default VFS,
        // the same one `Connection::open(path)` above selects. `xDelete` is
        // that VFS's own function pointer, and `c_name` outlives the call.
        let vfs = unsafe { rusqlite::ffi::sqlite3_vfs_find(std::ptr::null()) };
        if vfs.is_null() {
            return Err("client.storage_io: no SQLite VFS is registered".to_owned());
        }
        let delete = unsafe { (*vfs).xDelete }
            .ok_or_else(|| "client.storage_io: the SQLite VFS cannot delete files".to_owned())?;
        for suffix in ["-wal", "-shm", "-journal", ""] {
            let file_name = format!("{path}{suffix}");
            let c_name = std::ffi::CString::new(file_name.as_str()).map_err(|_| {
                format!("sync.invalid_request: replica path {file_name:?} contains a NUL byte")
            })?;
            // SAFETY: `vfs` and its `xDelete` pointer come from the live
            // SQLite library; `c_name` is a valid NUL-terminated path.
            let code = unsafe { delete(vfs, c_name.as_ptr(), 1) };
            // A cleanly closed WAL replica has no sidecars; a missing file is
            // already deleted.
            if code != rusqlite::ffi::SQLITE_OK && code != rusqlite::ffi::SQLITE_IOERR_DELETE_NOENT
            {
                return Err(format!(
                    "client.storage_io: deleting replica file {file_name:?} failed with SQLite code {code}"
                ));
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Rotate the caller's client id (§1.5) and return the new one. Use it
    /// after a `sync.invalid_client_id` refusal (`recommendedAction:
    /// resetClientId`): the next round carries the new id. A live realtime
    /// socket is closed so the next connection registers with the new id.
    /// The replica and its outbox stay in place; wipe them yourself when the
    /// stored data belongs to the account that signed out.
    pub fn reset_client_id(&mut self, transport: &mut dyn Transport) -> Result<String, String> {
        self.disconnect_realtime(transport);
        let client_id = uuid::Uuid::new_v4().to_string();
        self.set_meta(CLIENT_ID_KEY, &client_id)?;
        self.client_id.clone_from(&client_id);
        self.round_failure = None;
        Ok(client_id)
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
        Self::with_connection_identity(Some(client_id), schema_json, limits, conn)
    }

    /// [`Self::with_connection`] for `open_path_with_identity`: no requested id
    /// means a durable replica's persisted `clientId` wins over a fresh one.
    fn with_connection_identity(
        client_id: Option<String>,
        schema_json: &Value,
        limits: ClientLimits,
        conn: Connection,
    ) -> Result<Self, String> {
        validate_client_limits(&limits)?;
        let schema = parse_schema_json(schema_json)?;
        validate_authority_reads(&schema, &limits.authority_reads)?;
        // RFC 0005 D8: resolve the previous-version config before the opening
        // reset runs — the capture happens inside it. Bad bounds fail loud.
        let previous_version = match limits.previous_version_context {
            Some(config) => {
                config.validate()?;
                Some(config)
            }
            None => None,
        };
        let mut client = SyncClient {
            #[cfg(feature = "bench-internals")]
            benchmark_phases: Recorder::default(),
            conn,
            schema,
            client_id: client_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            limits,
            subs: Shared::default(),
            outbox: Shared::default(),
            failed_commits: Shared::default(),
            retain_failed_commits: false,
            conflicts: Shared::default(),
            rejections: Shared::default(),
            schema_floor: None,
            lease_state: None,
            stopped: false,
            upgrading: false,
            sync_needed: false,
            realtime_policy: RealtimePolicy::Optional,
            realtime_state: RealtimeState::Disconnected,
            realtime_reason_code: None,
            realtime_retry_delay_ms: None,
            presence: HashMap::new(),
            now_ms: None,
            encryption: crate::values::EncryptionConfig::default(),
            security_preflight: false,
            security_epoch: 0,
            transport_enabled: true,
            transport_epoch: 0,
            subscription_epoch: 0,
            previous_version,
            insert_sql: RefCell::new(HashMap::new()),
            overlay_dirty: OverlayDirty::clean(),
            storage_failure: RefCell::new(None),
            #[cfg(test)]
            overlay_rebuild_count: Cell::new(0),
            #[cfg(test)]
            acknowledged_replay_count: Cell::new(0),
            #[cfg(test)]
            outcome_prune_count: Cell::new(0),
            progress: ProgressObserver::default(),
            change_queue: VecDeque::new(),
            sync_intent_queue: VecDeque::new(),
            retry_delay_ms: 250,
            round_retry_delay_ms: None,
            round_failure: None,
            active_round: None,
            last_round: None,
            last_change: None,
            query_failures: Vec::new(),
            coalesced: None,
            coalesced_failure: None,
        };
        // The row write path leans on the prepared-statement cache (two
        // insert statements per synced table, plus the bookkeeping
        // statements); size it so a multi-table schema never thrashes.
        client
            .conn
            .set_prepared_statement_cache_capacity(64.max(client.schema.tables.len() * 4));
        // §7.4.2: one write transaction (SQLite `BEGIN IMMEDIATE`, a reserved
        // writer) covers the marker read, the identity check, and every
        // bookkeeping/schema write, so a concurrent open that upgraded the
        // replica cannot interleave between the guard and the writes, and a
        // refusal leaves the replica unchanged.
        client
            .conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| Self::sqlite_failure(&client.storage_failure, error))?;
        let startup = (|| -> Result<(), String> {
            // The marker guard runs inside the write transaction, so the version
            // it validates is the version every write below commits under.
            let marker = read_local_schema_version(&client.conn, client.schema.version)?;
            // New app indexes may reference columns that only exist after a
            // version-bump reset.
            client.create_bookkeeping_tables()?;
            match client.get_meta(CLIENT_ID_KEY)? {
                Some(existing) => match client_id {
                    Some(requested) if existing != requested => {
                        return Err(format!(
                            "client.identity_mismatch: this database belongs to {existing:?}; refusing to rebind it to {requested:?}"
                        ))
                    }
                    _ => client.client_id = existing,
                },
                None => client.set_meta(CLIENT_ID_KEY, &client.client_id)?,
            }
            client.restore_persisted_state()?;
            client.failed_commits = client.load_failed_commits()?.into();
            match marker {
                None => {
                    client.create_synced_tables()?;
                    client.persist_schema_version()?;
                    client.save_subscription_scope_schema()?;
                }
                Some(version) if version == client.schema.version => {
                    client.create_synced_tables()?;
                    // RFC 0005 D1: the same-version open backfills the descriptor
                    // for a database first opened by an unaware binary, so the
                    // NEXT bump can capture without needing a schema bump first.
                    set_local_schema_descriptor(&client.conn, &client.schema)
                        .map_err(|error| Self::sqlite_failure(&client.storage_failure, error))?;
                    client.save_subscription_scope_schema()?;
                }
                Some(_) => client.run_schema_reset()?,
            }
            // RFC 0005 D9: the reset sweep cannot see a container whose capture
            // committed in its OWN file while the replica's savepoint never
            // released — a crash at that seam leaves a container beside a matching
            // OLD marker, and the next open at that version runs no reset. Discard
            // it before anything can read it. No-op when no container exists.
            client.reconcile_previous_version_at_boot()?;
            client.clear_satisfied_persisted_schema_floor()?;
            client.prune_unknown_subscriptions(false)?;
            // §7.1/§7.4.4: recover intrinsically codec-invalid persisted values at
            // the full startup/reset reconciliation boundary, inside this open
            // transaction and after the schema and identity guards, so a commit
            // an earlier version accepted is dropped with durable rejection
            // evidence before any replay. A table the current schema removed
            // keeps the §7.4.4 send-time classification, and an unresolved
            // encryption key stays with the send seam because hosts configure
            // keys after open.
            client.drop_unencodable_outbox(false, None)?;
            if marker == Some(client.schema.version)
                && (!client.outbox.is_empty()
                    || !client.failed_commits.is_empty()
                    || client.has_acknowledged_rows()?)
            {
                // Reconstruct the visible optimistic overlay from the durable
                // base plus outbox instead of trusting a process-interrupted
                // mirror.
                client.overlay_dirty.set(true);
                client.rebuild_overlay()?;
            }
            // Every persisted active subscription needs one catch-up pull on
            // open: realtime only covers changes after connection, while an
            // idempotent setWindow correctly creates no fresh command effect.
            // Pending outbox work has the same restart requirement. The core
            // owns this intent so native hosts never poll or require an
            // application-issued sync().
            client.enqueue_startup_sync_if_needed()?;
            Ok(())
        })();
        match startup {
            Ok(()) => match client.conn.execute_batch("COMMIT") {
                Ok(()) => Ok(client),
                Err(error) => {
                    let failure = Self::sqlite_failure(&client.storage_failure, error);
                    if let Err(rollback) = client.conn.execute_batch("ROLLBACK") {
                        // Keep a failed rollback's typed storage classification.
                        let _ = Self::sqlite_failure(&client.storage_failure, rollback);
                    }
                    Err(failure)
                }
            },
            Err(error) => {
                if let Err(rollback) = client.conn.execute_batch("ROLLBACK") {
                    // Keep a failed rollback's typed storage classification.
                    let _ = Self::sqlite_failure(&client.storage_failure, rollback);
                }
                Err(error)
            }
        }
    }

    /// Pin the client clock (epoch ms) — the §5.4 expiry check runs
    /// against this instead of system time (conformance virtual clock).
    pub fn set_now_ms(&mut self, now_ms: i64) {
        self.now_ms = Some(now_ms);
    }

    /// §5.11: install the client-side encryption keys (`keyId → key bytes`).
    /// The command router parses these from the `create` command's
    /// `encryption` config (keys as `{$bytes: hex}`).
    pub fn set_encryption(&mut self, encryption: crate::values::EncryptionConfig) {
        self.encryption = encryption;
    }

    #[must_use]
    pub fn security_lifecycle(&self) -> &'static str {
        if self.security_preflight {
            "preflight"
        } else {
            "active"
        }
    }

    #[must_use]
    pub fn security_preflight(&self) -> bool {
        self.security_preflight
    }

    /// Host-owned, non-persisted network gate. Local operations remain available.
    pub fn set_transport_enabled(&mut self, transport: &mut dyn Transport, enabled: bool) {
        if self.transport_enabled != enabled {
            self.transport_enabled = enabled;
            self.transport_epoch = self.transport_epoch.wrapping_add(1);
            self.sync_intent_queue.clear();
            self.sync_intent_queue
                .push_back(if enabled && !self.security_preflight {
                    SyncIntent::Interactive
                } else {
                    SyncIntent::None
                });
        }
        // A captured reply keeps its normal apply/revocation semantics.
        if !enabled && self.active_round.is_none() {
            self.disconnect_realtime(transport);
        }
    }

    pub fn transport_enabled(&self) -> bool {
        self.transport_enabled
    }

    /// Quarantine this replica: enter the fail-closed gate, release all
    /// core-owned key material, and record the gate in the database so
    /// reopening re-enters preflight until `activate_security` clears it.
    ///
    /// Use [`SyncClient::seal_security_on_teardown`] for the shutdown barrier,
    /// which must NOT leave that durable mark.
    pub fn begin_security_preflight(&mut self) -> Result<(), String> {
        self.seal_security_on_teardown();
        // Persist the quarantine so it survives handle teardown and restart:
        // reopening this replica re-enters preflight until activation clears it.
        self.set_meta(SECURITY_PREFLIGHT_PENDING_KEY, "1")
    }

    /// Release core-owned key material as a host tears the client down,
    /// WITHOUT recording a quarantine.
    ///
    /// Shutting an activated client down is not a quarantine event. Persisting
    /// the gate here marks every cleanly closed replica as pending, and the
    /// next plain `create` is then refused permanently: the reopen path
    /// restores the flag from the marker and the create guard rejects it. The
    /// in-memory flag still closes the gate for anything still holding this
    /// instance, which is all a teardown barrier needs.
    pub fn seal_security_on_teardown(&mut self) {
        self.cancel_sync_round();
        self.security_preflight = true;
        self.security_epoch = self.security_epoch.wrapping_add(1);
        self.encryption = crate::values::EncryptionConfig::default();
        self.sync_intent_queue.clear();
    }

    /// Install the post-authentication keyring and release the host loop.
    pub fn activate_security(
        &mut self,
        encryption: crate::values::EncryptionConfig,
    ) -> Result<(), String> {
        if !self.security_preflight {
            return Err(
                "sync.invalid_request: activateSecurity requires security preflight".to_owned(),
            );
        }
        self.enqueue_startup_sync_if_needed()?;
        self.delete_meta(SECURITY_PREFLIGHT_PENDING_KEY)?;
        self.encryption = encryption;
        self.security_preflight = false;
        Ok(())
    }

    fn clock_now_ms(&self) -> i64 {
        self.now_ms.unwrap_or_else(crate::wall_clock_ms)
    }

    fn create_bookkeeping_tables(&self) -> Result<(), String> {
        // Durable client bookkeeping (outbox + subscription + meta).
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS _syncular_outbox (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   commit_id TEXT NOT NULL UNIQUE, ops_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_row_deliveries (
                   tbl TEXT NOT NULL, id TEXT NOT NULL, commit_seq INTEGER NOT NULL, PRIMARY KEY(tbl,id));
                 CREATE TABLE IF NOT EXISTS _syncular_acked_rows (
                   commit_id TEXT NOT NULL, idx INTEGER NOT NULL, tbl TEXT NOT NULL, id TEXT NOT NULL,
                   commit_seq INTEGER NOT NULL, op_json TEXT NOT NULL, intent_json TEXT,
                   PRIMARY KEY(commit_id, idx));
                 CREATE INDEX IF NOT EXISTS _syncular_acked_rows_row
                   ON _syncular_acked_rows(tbl, id);
                 CREATE TABLE IF NOT EXISTS _syncular_failed_commits (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT, client_commit_id TEXT NOT NULL UNIQUE,
                   operations_json TEXT NOT NULL, initial_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_commit_outcomes (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   client_commit_id TEXT NOT NULL UNIQUE,
                   status TEXT NOT NULL CHECK(status IN ('applied', 'cached', 'conflict', 'rejected')),
                   recorded_at_ms INTEGER NOT NULL,
                   results_json TEXT NOT NULL,
                   operations_json TEXT,
                   resolution TEXT NOT NULL DEFAULT 'active'
                     CHECK(resolution IN ('active', 'resolved_keep_server', 'superseded', 'dismissed')),
                   resolved_at_ms INTEGER,
                   replacement_client_commit_id TEXT);
                 CREATE INDEX IF NOT EXISTS _syncular_commit_outcomes_resolution_seq
                   ON _syncular_commit_outcomes(resolution, seq);
                 CREATE TABLE IF NOT EXISTS _syncular_subscriptions (
                   id TEXT PRIMARY KEY, tbl TEXT NOT NULL, state_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_meta (
                   key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_windows (
                   base TEXT NOT NULL, unit TEXT NOT NULL, sub_id TEXT NOT NULL,
                   PRIMARY KEY (base, unit));
                 CREATE TABLE IF NOT EXISTS _syncular_window_pending_evict (
                   sub_id TEXT PRIMARY KEY, tbl TEXT NOT NULL,
                   effective_scopes TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS _syncular_blob_commit_refs(
                   commit_id TEXT NOT NULL, blob_id TEXT NOT NULL,
                   PRIMARY KEY(commit_id, blob_id));
                 CREATE INDEX IF NOT EXISTS _syncular_blob_commit_refs_body
                   ON _syncular_blob_commit_refs(blob_id);",
            )
            .map_err(|e| e.to_string())?;
        // Migrate an outcome journal created before failed aggregate
        // envelopes were retained. Historical rows intentionally stay NULL.
        let _ = self
            .conn
            .execute_batch("ALTER TABLE _syncular_commit_outcomes ADD COLUMN operations_json TEXT");
        if self.get_meta(LOCAL_REVISION_KEY)?.is_none() {
            self.set_meta(LOCAL_REVISION_KEY, "0")?;
        }
        // §5.9.7 blob cache. Mutable upload state stays off the body row so
        // completing a large upload does not rewrite its BLOB record.
        if self.schema_has_blobs() {
            let exists = self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_syncular_blobs')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?;
            if exists {
                let mut statement = self
                    .conn
                    .prepare("PRAGMA table_info(_syncular_blobs)")
                    .map_err(|e| e.to_string())?;
                let mut columns = statement
                    .query_map([], |row| row.get::<_, String>(1))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                columns.sort();
                let mut expected = vec![
                    "blob_id",
                    "byte_length",
                    "bytes",
                    "created_at_ms",
                    "media_type",
                ];
                expected.sort_unstable();
                if columns != expected {
                    return Err(
                        "sync.schema_mismatch: Local blob schema is incompatible".to_owned()
                    );
                }
            } else {
                self.conn
                    .execute_batch(
                        "CREATE TABLE _syncular_blobs(
                           blob_id TEXT PRIMARY KEY,
                           bytes BLOB NOT NULL,
                           byte_length INTEGER NOT NULL,
                           media_type TEXT,
                           created_at_ms INTEGER NOT NULL);",
                    )
                    .map_err(|e| e.to_string())?;
            }
            self.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS _syncular_blob_uploads(
                       blob_id TEXT PRIMARY KEY,
                       media_type TEXT,
                       created_at_ms INTEGER NOT NULL);",
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

    fn get_meta(&self, key: &str) -> Result<Option<String>, String> {
        meta_get(&self.conn, key)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    // The caller holds the startup/reset transaction. Either both schema
    // records persist or the enclosing operation fails and rolls back.
    fn persist_schema_version(&self) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES (?1,?2)",
                rusqlite::params![LOCAL_SCHEMA_VERSION_KEY, self.schema.version.to_string()],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        set_local_schema_descriptor(&self.conn, &self.schema)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    pub(crate) fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        meta_set(&self.conn, key, value)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn delete_meta(&self, key: &str) -> Result<(), String> {
        meta_delete(&self.conn, key)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// §7.1: the durable outbox in FIFO order, in schema-agnostic local form.
    fn load_outbox(&self) -> Result<Vec<Arc<OutboxCommit>>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT commit_id, ops_json FROM _syncular_outbox ORDER BY seq ASC")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut commits = Vec::new();
        for row in rows {
            let (client_commit_id, raw) = row.map_err(|error| error.to_string())?;
            let entries: Vec<Value> = serde_json::from_str(&raw).map_err(|error| {
                format!("invalid persisted outbox {client_commit_id:?}: {error}")
            })?;
            let mut ops = Vec::with_capacity(entries.len());
            for entry in entries {
                let op = entry.get("op").and_then(Value::as_str).unwrap_or("delete");
                ops.push(OutboxOp {
                    upsert: op == "upsert",
                    table: entry
                        .get("table")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "persisted outbox operation missing table".to_owned())?
                        .to_owned(),
                    row_id: entry
                        .get("rowId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "persisted outbox operation missing rowId".to_owned())?
                        .to_owned(),
                    base_version: entry.get("baseVersion").and_then(Value::as_i64),
                    // A legacy entry's `changedFields` key is ignored:
                    // the values map is the presence set (§6.1).
                    values: entry.get("values").and_then(Value::as_object).cloned(),
                    insert: entry.get("insert") == Some(&Value::Bool(true)),
                });
            }
            commits.push(Arc::new(OutboxCommit {
                client_commit_id,
                ops,
            }));
        }
        Ok(commits)
    }

    fn restore_persisted_state(&mut self) -> Result<(), String> {
        self.subs = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, tbl, state_json FROM _syncular_subscriptions ORDER BY id ASC")
                .map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            let mut subscriptions = Vec::new();
            for row in rows {
                let (id, table, raw) = row.map_err(|error| error.to_string())?;
                let state: Value = serde_json::from_str(&raw)
                    .map_err(|error| format!("invalid persisted subscription {id:?}: {error}"))?;
                let requested = json_to_scope_map(
                    state.get("requested").unwrap_or(&Value::Object(Map::new())),
                )?;
                let effective = state
                    .get("effectiveScopes")
                    .filter(|value| !value.is_null())
                    .map(json_to_scope_map)
                    .transpose()?;
                subscriptions.push(Subscription {
                    id,
                    table,
                    requested,
                    params: state
                        .get("params")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    cursor: state.get("cursor").and_then(Value::as_i64).unwrap_or(-1),
                    bootstrap_state: state
                        .get("bootstrapState")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    state: SubState::parse(
                        state
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("active"),
                    ),
                    reason_code: state
                        .get("reasonCode")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    effective,
                    synced_once: state
                        .get("syncedOnce")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
            subscriptions.into()
        };

        self.outbox = self.load_outbox()?.into();

        self.prune_commit_outcomes()?;
        let active = self.commit_outcomes(CommitOutcomeQuery {
            active_only: true,
            ..CommitOutcomeQuery::default()
        })?;
        self.conflicts = active
            .iter()
            .flat_map(|outcome| outcome.results.iter())
            .filter_map(|result| match result {
                CommitOperationOutcome::Conflict { conflict } => Some(conflict.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .into();
        self.rejections = active
            .iter()
            .flat_map(|outcome| outcome.results.iter())
            .filter_map(|result| match result {
                CommitOperationOutcome::Error { rejection } => Some(rejection.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .into();

        self.lease_state = self
            .get_meta(LEASE_STATE_KEY)?
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|error| format!("invalid persisted lease state: {error}"))?;
        self.schema_floor = self
            .get_meta(SCHEMA_FLOOR_KEY)?
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|error| format!("invalid persisted schema floor: {error}"))?;
        self.stopped = self.schema_floor.is_some();
        // A replica left in unactivated preflight reopens gated: the quarantine
        // decision persists with the data across handle teardown and restart.
        if self.get_meta(SECURITY_PREFLIGHT_PENDING_KEY)?.as_deref() == Some("1") {
            self.security_preflight = true;
        }
        Ok(())
    }

    fn save_subscription_scope_schema(&self) -> Result<(), String> {
        let declarations: BTreeMap<_, BTreeMap<_, _>> = self
            .schema
            .tables
            .iter()
            .map(|table| {
                (
                    table.name.clone(),
                    table
                        .scope_variables
                        .iter()
                        .map(|scope| {
                            (
                                scope.variable.clone(),
                                [scope.prefix.clone(), scope.column.clone()],
                            )
                        })
                        .collect(),
                )
            })
            .collect();
        self.set_meta(
            "subscriptionScopeSchema",
            &serde_json::to_string(&declarations).expect("scope schema serialization"),
        )
    }

    /// Remove registrations with incompatible table/key/prefix/column meaning.
    fn prune_unknown_subscriptions(&mut self, bump: bool) -> Result<(), String> {
        let previous: Option<BTreeMap<String, BTreeMap<String, [String; 2]>>> = if bump {
            self.get_meta("subscriptionScopeSchema")?
                .map(|raw| serde_json::from_str(&raw))
                .transpose()
                .map_err(|error| format!("invalid persisted scope schema: {error}"))?
        } else {
            None
        };
        let compatible = |table_name: &str, requested: &[(String, Vec<String>)]| {
            let Some(table) = self.schema.table(table_name) else {
                return false;
            };
            if requested
                .iter()
                .any(|(variable, _)| table.scope_column(variable).is_none())
            {
                return false;
            }
            if !bump {
                return true;
            }
            let Some(old) = previous.as_ref().and_then(|tables| tables.get(table_name)) else {
                return false;
            };
            let variables: BTreeSet<_> = if requested.is_empty() {
                old.keys()
                    .cloned()
                    .chain(
                        table
                            .scope_variables
                            .iter()
                            .map(|scope| scope.variable.clone()),
                    )
                    .collect()
            } else {
                requested
                    .iter()
                    .map(|(variable, _)| variable.clone())
                    .collect()
            };
            variables.iter().all(|variable| {
                let current = table
                    .scope_variables
                    .iter()
                    .find(|scope| &scope.variable == variable);
                match (old.get(variable), current) {
                    (Some(old), Some(current)) => {
                        old == &[current.prefix.clone(), current.column.clone()]
                    }
                    _ => false,
                }
            })
        };
        let mut stale_ids: BTreeSet<_> = self
            .subs
            .iter()
            .filter(|sub| !compatible(&sub.table, &sub.requested))
            .map(|sub| sub.id.clone())
            .collect();
        for (id, table, effective) in self.load_pending_evictions()? {
            if !compatible(&table, &effective) {
                stale_ids.insert(id);
            }
        }
        for id in &stale_ids {
            for sql in [
                "DELETE FROM _syncular_windows WHERE sub_id = ?1",
                "DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?1",
                "DELETE FROM _syncular_subscriptions WHERE id = ?1",
            ] {
                self.conn
                    .execute(sql, rusqlite::params![id])
                    .map_err(|error| error.to_string())?;
            }
        }
        self.subs.retain(|sub| !stale_ids.contains(&sub.id));
        Ok(())
    }

    pub fn local_revision(&self) -> Result<u64, String> {
        Ok(self
            .get_meta(LOCAL_REVISION_KEY)?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0))
    }

    /// §7.5: resolve a snapshot read on the mutable owner connection through
    /// the same primitive the read-only sidecar uses, so the command surface
    /// and the file sidecar return one revision, rows, coverage, catch-up, and
    /// delivery shape. The structured [`QueryReadFailure`] is preserved; an
    /// `owner` records its failure (and its next success) in diagnostics.
    pub fn snapshot_read(
        &mut self,
        request: &SnapshotReadRequest<'_>,
        owner: Option<QueryOwner<'_>>,
    ) -> Result<SnapshotRead, QueryReadFailure> {
        let result = snapshot_read_connection(&self.conn, request);
        if let Some(owner) = owner {
            self.record_query_read(owner, result.as_ref().err());
        }
        result
    }

    #[must_use]
    pub fn status_snapshot(&self) -> SyncStatusSnapshot {
        SyncStatusSnapshot {
            current_schema_version: self.schema.version,
            outbox: self.outbox.len(),
            upgrading: self.upgrading,
            lease_state: self.lease_state.clone(),
            schema_floor: self.schema_floor.clone(),
            sync_needed: self.sync_needed,
            previous_version_context: self.previous_version_status(),
        }
    }

    /// RFC 0005 A2: container presence for a host that must act on it (Diego's
    /// rollback precondition), read without creating the file.
    fn previous_version_status(&self) -> PreviousVersionStatus {
        let Some(replica_path) = self.previous_version_replica_path() else {
            return PreviousVersionStatus {
                present: false,
                created_at_ms: None,
            };
        };
        match crate::previous_version::read_previous_version_record(&replica_path) {
            Ok(Some(record)) => PreviousVersionStatus {
                present: true,
                created_at_ms: Some(record.created_at_ms),
            },
            _ => PreviousVersionStatus {
                present: std::path::Path::new(
                    &crate::previous_version::previous_version_container_path(&replica_path),
                )
                .exists(),
                created_at_ms: None,
            },
        }
    }

    /// RFC 0005 D7: read captured rows from the previous local schema. `state`
    /// is always `previousVersion`; the container never makes
    /// `query_snapshot()` coverage complete. Lease stop/expiry, scope
    /// revocation, coverage completion and the TTL DISCARD the container and
    /// close the read with their own reason.
    pub fn previous_version_snapshot(
        &self,
        spec: &PreviousVersionReadSpec,
    ) -> Result<PreviousVersionSnapshot, String> {
        let now_ms = self.clock_now_ms();
        crate::previous_version::previous_version_snapshot(
            &self.conn,
            self.previous_version_replica_path().as_deref(),
            self.previous_version.as_ref(),
            PreviousVersionLifecycle {
                lease_inactive: self.previous_version_lease_inactive(now_ms),
                scope_revoked: self.subs.iter().any(|sub| sub.state == SubState::Revoked),
                coverage_complete: self.previous_version_coverage_complete(),
            },
            now_ms,
            self.schema.version,
            spec,
        )
    }

    /// RFC 0005 D6: the advisory pre-reset compatibility audit.
    pub fn previous_version_audit(
        &self,
    ) -> Result<Option<crate::previous_version::PreviousVersionAudit>, String> {
        crate::previous_version::stored_previous_version_audit(&self.conn)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// RFC 0005 A2/D9: the executable downgrade step. Drop the container file
    /// and both metadata records, and report whether anything was present.
    /// Idempotent: absence is a successful no-op.
    pub fn previous_version_discard(
        &self,
    ) -> Result<crate::previous_version::PreviousVersionDiscardOutcome, String> {
        self.drop_previous_version()
    }

    fn drop_previous_version(
        &self,
    ) -> Result<crate::previous_version::PreviousVersionDiscardOutcome, String> {
        let Some(replica_path) = self.previous_version_replica_path() else {
            return Ok(crate::previous_version::PreviousVersionDiscardOutcome {
                present: false,
                discarded: false,
            });
        };
        crate::previous_version::discard_previous_version(&self.conn, &replica_path)
    }

    /// RFC 0005 D7: `leaseState.errorCode` or an expired lease.
    fn previous_version_lease_inactive(&self, now_ms: i64) -> bool {
        let Some(lease) = &self.lease_state else {
            return false;
        };
        if lease.error_code.is_some() {
            return true;
        }
        lease.expires_at_ms.is_some_and(|expires| expires <= now_ms)
    }

    /// RFC 0005 D7: §7.4.5 replacement coverage — every ACTIVE subscription
    /// has `cursor >= 0` and no resume token. An empty active set is not
    /// completion (mirrors the TS predicate exactly).
    fn previous_version_coverage_complete(&self) -> bool {
        let active = self
            .subs
            .iter()
            .filter(|sub| sub.state == SubState::Active)
            .collect::<Vec<_>>();
        if active.is_empty() {
            return false;
        }
        active
            .iter()
            .all(|sub| sub.cursor >= 0 && sub.bootstrap_state.is_none())
    }

    /// RFC 0005 D7: lifetime triggers evaluated once per sync round, after the
    /// apply. A container that no longer has a reason to exist is discarded so
    /// the rows do not outlive the window they were kept for.
    fn previous_version_lifetime_check(&self) {
        let Some(config) = self.previous_version.filter(|config| config.enabled) else {
            return;
        };
        let now_ms = self.clock_now_ms();
        if self.previous_version_lease_inactive(now_ms) {
            let _ = self.drop_previous_version();
            return;
        }
        let Some(replica_path) = self.previous_version_replica_path() else {
            return;
        };
        let Ok(Some(record)) = crate::previous_version::read_previous_version_record(&replica_path)
        else {
            return;
        };
        if self.subs.iter().any(|sub| sub.state == SubState::Revoked) {
            let _ = self.drop_previous_version();
            return;
        }
        if now_ms - record.created_at_ms > config.max_age_ms {
            let _ = self.drop_previous_version();
            return;
        }
        if self.previous_version_coverage_complete() {
            let _ = self.drop_previous_version();
        }
    }

    pub fn diagnostics_snapshot(
        &self,
        request: &ClientDiagnosticsRequest,
    ) -> Result<ClientDiagnosticsSnapshot, String> {
        if request.expected_subscriptions.len() > MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS {
            return Err(format!(
                "sync.invalid_request: diagnosticsSnapshot accepts at most {MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS} expected subscriptions"
            ));
        }
        let mut subscriptions = BTreeMap::<String, DiagnosticSubscription>::new();
        for sub in self.subs.iter() {
            let reset = sub.cursor < 0 && sub.reason_code.as_deref() == Some("sync.cursor_expired");
            let complete =
                sub.state == SubState::Active && sub.cursor >= 0 && sub.bootstrap_state.is_none();
            let state = match sub.state {
                SubState::Revoked => "revoked",
                SubState::Failed => "failed",
                SubState::Active if reset => "reset",
                SubState::Active if complete => "complete",
                SubState::Active => "bootstrapping",
            };
            subscriptions.insert(
                sub.id.clone(),
                DiagnosticSubscription {
                    id: sub.id.clone(),
                    table: sub.table.clone(),
                    state: state.to_owned(),
                    complete,
                    cursor: Some(sub.cursor),
                    reason_code: sub.reason_code.as_deref().map(Self::diagnostic_code),
                },
            );
        }
        for expected in &request.expected_subscriptions {
            if expected.id.is_empty() || expected.table.is_empty() {
                return Err("sync.invalid_request: diagnosticsSnapshot expected subscriptions require non-empty id and table strings".to_owned());
            }
            if subscriptions
                .get(&expected.id)
                .is_some_and(|registered| registered.table != expected.table)
            {
                subscriptions.insert(
                    expected.id.clone(),
                    DiagnosticSubscription {
                        id: expected.id.clone(),
                        table: expected.table.clone(),
                        state: "failed".to_owned(),
                        complete: false,
                        cursor: None,
                        reason_code: Some("client.subscription_intent_mismatch".to_owned()),
                    },
                );
            } else {
                subscriptions.entry(expected.id.clone()).or_insert_with(|| {
                    DiagnosticSubscription {
                        id: expected.id.clone(),
                        table: expected.table.clone(),
                        state: "unregistered".to_owned(),
                        complete: false,
                        cursor: None,
                        reason_code: None,
                    }
                });
            }
        }
        let mut ordered_subscriptions = Vec::new();
        let mut included = BTreeSet::new();
        for expected in &request.expected_subscriptions {
            if included.insert(expected.id.clone()) {
                if let Some(subscription) = subscriptions.get(&expected.id) {
                    ordered_subscriptions.push(subscription.clone());
                }
            }
        }
        for (id, subscription) in &subscriptions {
            if included.insert(id.clone()) {
                ordered_subscriptions.push(subscription.clone());
            }
        }
        let subscriptions_truncated =
            ordered_subscriptions.len() > MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS;
        ordered_subscriptions.truncate(MAX_DIAGNOSTIC_EXPECTED_SUBSCRIPTIONS);
        let captured_at_ms = self.clock_now_ms();
        let lease = if let Some(error_code) = self
            .lease_state
            .as_ref()
            .and_then(|state| state.error_code.clone())
        {
            ClientDiagnosticsLease {
                state: "stopped".to_owned(),
                expires_at_ms: self
                    .lease_state
                    .as_ref()
                    .and_then(|state| state.expires_at_ms),
                error_code: Some(Self::diagnostic_code(&error_code)),
            }
        } else if let Some(expires_at_ms) = self
            .lease_state
            .as_ref()
            .and_then(|state| state.expires_at_ms)
        {
            ClientDiagnosticsLease {
                state: if expires_at_ms <= captured_at_ms {
                    "expired".to_owned()
                } else {
                    "active".to_owned()
                },
                expires_at_ms: Some(expires_at_ms),
                error_code: None,
            }
        } else {
            ClientDiagnosticsLease {
                state: "none".to_owned(),
                expires_at_ms: None,
                error_code: None,
            }
        };
        let connectivity = match self.last_round.as_ref() {
            _ if !self.transport_enabled && self.active_round.is_none() => "offline",
            Some(round) if round.status == "succeeded" => "online",
            Some(round)
                if round.status == "failed"
                    && matches!(
                        round.cause_kind,
                        Some(
                            crate::TransportCauseKind::Network | crate::TransportCauseKind::Connect
                        )
                    ) =>
            {
                "offline"
            }
            Some(round) if round.status == "failed" && round.http_status.is_some() => "online",
            _ => "unknown",
        };
        Ok(ClientDiagnosticsSnapshot {
            version: CLIENT_DIAGNOSTICS_VERSION,
            captured_at_ms,
            host: ClientDiagnosticsHost {
                kind: "direct".to_owned(),
                role: "single".to_owned(),
                connectivity: connectivity.to_owned(),
                realtime: self.realtime_state,
                realtime_policy: self.realtime_policy,
                realtime_reason_code: self.realtime_reason_code.clone(),
                realtime_retry_delay_ms: self.realtime_retry_delay_ms,
            },
            security_lifecycle: self.security_lifecycle().to_owned(),
            schema: ClientDiagnosticsSchema {
                current_version: self.schema.version,
                upgrading: self.upgrading,
                required_version: self
                    .schema_floor
                    .as_ref()
                    .and_then(|floor| floor.required_schema_version),
                latest_version: self
                    .schema_floor
                    .as_ref()
                    .and_then(|floor| floor.latest_schema_version),
            },
            replica: ClientDiagnosticsReplica {
                local_revision: self.local_revision()?.to_string(),
                sync_needed: self.sync_needed,
                pending_outbox: self.outbox.len(),
            },
            lease,
            subscriptions: ordered_subscriptions,
            subscriptions_truncated,
            last_round: self.last_round.clone(),
            last_change: self.last_change.clone(),
            storage: self.diagnostics_storage(),
            query_failures: self.query_failures.clone(),
        })
    }

    fn diagnostics_storage(&self) -> ClientDiagnosticsStorage {
        let read = || -> Result<ClientDiagnosticsStorage, rusqlite::Error> {
            let page_count: i64 = self
                .conn
                .query_row("PRAGMA page_count", [], |row| row.get(0))?;
            let page_size: i64 = self
                .conn
                .query_row("PRAGMA page_size", [], |row| row.get(0))?;
            // Reuse compiled aggregates; every invocation still reads current storage.
            let outbox_bytes: i64 = self
                .conn
                .prepare_cached("SELECT COALESCE(SUM(LENGTH(ops_json)), 0) FROM _syncular_outbox")?
                .query_row([], |row| row.get(0))?;
            let (outcome_entries, outcome_bytes): (i64, i64) = self.conn.prepare_cached(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(results_json) + COALESCE(LENGTH(operations_json), 0)), 0) FROM _syncular_commit_outcomes",
            )?.query_row([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let blob_bytes = if self.schema_has_blobs() {
                self.conn
                    .prepare_cached("SELECT COALESCE(SUM(byte_length), 0) FROM _syncular_blobs")?
                    .query_row([], |row| row.get(0))?
            } else {
                0
            };
            let pressure = self
                .limits
                .blob_cache_max_bytes
                .is_some_and(|limit| blob_bytes > limit);
            Ok(ClientDiagnosticsStorage {
                status: if pressure { "pressure" } else { "healthy" }.to_owned(),
                database_bytes_approx: Some(page_count.saturating_mul(page_size).max(0)),
                pending_outbox_bytes_approx: Some(outbox_bytes.max(0)),
                retained_outcome_bytes_approx: Some(outcome_bytes.max(0)),
                retained_outcome_entries: Some(outcome_entries.max(0)),
                blob_cache_bytes_approx: Some(blob_bytes.max(0)),
                pressure_reason_code: pressure.then(|| "client.blob_cache_over_limit".to_owned()),
            })
        };
        read().unwrap_or_else(|_| ClientDiagnosticsStorage {
            status: "unreadable".to_owned(),
            database_bytes_approx: None,
            pending_outbox_bytes_approx: None,
            retained_outcome_bytes_approx: None,
            retained_outcome_entries: None,
            blob_cache_bytes_approx: None,
            pressure_reason_code: None,
        })
    }

    pub fn drain_change_batches(&mut self) -> Vec<ClientChangeBatch> {
        self.change_queue.drain(..).collect()
    }

    pub fn drain_sync_intents(&mut self) -> Vec<SyncIntent> {
        let intents = self.sync_intent_queue.drain(..).collect();
        if self.transport_enabled {
            intents
        } else {
            vec![SyncIntent::None]
        }
    }

    fn schedule_background_retry(&mut self) -> u64 {
        let delay_ms = self.retry_delay_ms;
        self.sync_intent_queue
            .push_back(SyncIntent::Background { delay_ms });
        self.retry_delay_ms = (self.retry_delay_ms * 2).min(30_000);
        self.round_retry_delay_ms = Some(delay_ms);
        delay_ms
    }

    fn reset_background_retry(&mut self) {
        self.retry_delay_ms = 250;
    }

    fn retryable_transport_code(code: &str) -> bool {
        code == "transport.failed"
            || code == "transport.timeout"
            || code == "transport.unavailable"
            || code == "sync.transport_failed"
    }

    /// §1.8: the transport reported a refused or unreachable endpoint. The
    /// native transport says `connect` (DNS failure, connection refused,
    /// reset, or aborted); a browser fetch transport says `network`. Repeating
    /// the request on a backoff repairs neither, so no retry is scheduled.
    fn unreachable_transport(details: &Option<serde_json::Value>) -> bool {
        matches!(
            details
                .as_ref()
                .and_then(|details| details.get("causeKind"))
                .and_then(serde_json::Value::as_str),
            Some("connect" | "network")
        )
    }

    /// §1.5: a segment fetch that fails inside an otherwise complete round is
    /// invisible to the server (the round response arrived whole), so its code
    /// rides the following requests like a socket-round failure. A code the
    /// frame grammar rejects is not reportable and the previous code stays.
    fn segment_fetch_failed(&mut self, error: TransportError) -> SectionError {
        if ssp2::model::valid_round_failure_code(&error.code) {
            self.round_failure = Some(error.code.clone());
        }
        SectionError::Transport(error)
    }

    /// A failed round worth a background retry: a transport failure, or a
    /// §10.2 code the catalog marks retryable (clients may hardcode the
    /// catalog metadata, §10.1). Matches the TypeScript core, which retries
    /// on the server's `retryable` flag.
    fn retryable_failure_code(code: &str) -> bool {
        Self::retryable_transport_code(code)
            || matches!(
                code,
                "sync.auth_required"
                    | "sync.auth_lease_required"
                    | "sync.auth_lease_revoked"
                    | "sync.internal_error"
                    | "sync.idempotency_cache_miss"
                    | "sync.schema_not_ready"
                    | "sync.segment_expired"
                    | "sync.rate_limited"
                    | "sync.websocket_connection_limit"
            )
    }

    fn diagnostic_code(code: &str) -> String {
        let valid = !code.is_empty()
            && code.len() <= 96
            && code.contains('.')
            && code
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase())
            && code.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            });
        if valid {
            code.to_owned()
        } else {
            "client.unknown_failure".to_owned()
        }
    }

    fn set_sync_needed(&mut self, value: bool, interactive: bool) {
        if self.sync_needed != value {
            if self.begin_observation("syncular_status").is_ok() {
                self.sync_needed = value;
                let batch = ChangeAccumulator {
                    status: true,
                    ..ChangeAccumulator::default()
                };
                if self.finish_observation("syncular_status", batch).is_err() {
                    self.rollback_observation("syncular_status");
                }
            } else {
                self.sync_needed = value;
            }
        }
        if value && interactive {
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
    }

    fn sqlite_failure(
        storage_failure: &RefCell<Option<QueryReadFailure>>,
        error: rusqlite::Error,
    ) -> String {
        let message = error.to_string();
        let failure = QueryReadFailure::from(error);
        let code = failure.code;
        if code.is_some() && storage_failure.borrow().is_none() {
            *storage_failure.borrow_mut() = Some(failure);
        }
        match code {
            Some(code) => format!("{code}: {message}"),
            None => message,
        }
    }

    fn begin_observation(&self, name: &str) -> Result<(), String> {
        if let Some(failure) = &self.coalesced_failure {
            return Err(failure.clone());
        }
        // SQLite rolls a whole transaction back on some I/O and capacity
        // errors; later frames must not commit on their own after that.
        if self.coalesced.is_some() && self.conn.is_autocommit() {
            return Err("the coalesced apply transaction was rolled back".to_owned());
        }
        self.conn
            .execute_batch(&format!("SAVEPOINT {name}"))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// SPEC §1.4 rule 4: open a coalesced apply transaction unless a caller
    /// already owns one.
    fn begin_coalesced_apply(&mut self) -> Result<(), String> {
        if self.coalesced.is_some() || !self.conn.is_autocommit() {
            return Ok(());
        }
        self.conn
            .execute_batch("BEGIN")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.coalesced = Some(CoalescedApply {
            rows: 0,
            rollback: self.capture(),
        });
        Ok(())
    }

    fn capture(&self) -> Rollback {
        Rollback {
            subs: self.subs.clone(),
            outbox: self.outbox.clone(),
            failed_commits: self.failed_commits.clone(),
            conflicts: self.conflicts.clone(),
            rejections: self.rejections.clone(),
            schema_floor: self.schema_floor.clone(),
            lease_state: self.lease_state.clone(),
            stopped: self.stopped,
            upgrading: self.upgrading,
            sync_needed: self.sync_needed,
            active_round: self.active_round,
            overlay_dirty: self.overlay_dirty.snapshot(),
            change_queue: self.change_queue.len(),
            sync_intent_queue: self.sync_intent_queue.len(),
            last_change: self.last_change.clone(),
        }
    }

    fn restore(&mut self, rollback: Rollback) {
        self.subs = rollback.subs;
        self.outbox = rollback.outbox;
        self.failed_commits = rollback.failed_commits;
        self.conflicts = rollback.conflicts;
        self.rejections = rollback.rejections;
        self.schema_floor = rollback.schema_floor;
        self.lease_state = rollback.lease_state;
        self.stopped = rollback.stopped;
        self.upgrading = rollback.upgrading;
        self.sync_needed = rollback.sync_needed;
        self.active_round = rollback.active_round;
        self.overlay_dirty.restore(rollback.overlay_dirty);
        self.change_queue.truncate(rollback.change_queue);
        self.sync_intent_queue.truncate(rollback.sync_intent_queue);
        self.last_change = rollback.last_change;
    }

    /// Account the rows of the next frame or block. A unit that would take the
    /// coalesced transaction past the bound commits the earlier units first.
    fn coalesce_unit(&mut self, rows: usize) -> Result<(), String> {
        let Some(open) = &self.coalesced else {
            return Ok(());
        };
        if open.rows > 0 && open.rows + rows > COALESCED_APPLY_ROWS {
            self.commit_coalesced_apply()?;
            self.begin_coalesced_apply()?;
        }
        if let Some(open) = &mut self.coalesced {
            open.rows += rows;
        }
        Ok(())
    }

    /// COMMIT the coalesced transaction. A failed COMMIT rolls every coalesced
    /// frame back, restores the in-memory state of its `BEGIN`, drops the
    /// change batches and sync intents queued since, and fails the rest of the
    /// response.
    fn commit_coalesced_apply(&mut self) -> Result<(), String> {
        let Some(open) = self.coalesced.take() else {
            return Ok(());
        };
        let committed = if self.conn.is_autocommit() {
            Err("the coalesced apply transaction was rolled back".to_owned())
        } else {
            self.conn
                .execute_batch("COMMIT")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
        };
        let Err(error) = committed else {
            return Ok(());
        };
        if !self.conn.is_autocommit() {
            if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                let _ = Self::sqlite_failure(&self.storage_failure, rollback);
            }
        }
        self.restore(open.rollback);
        self.coalesced_failure = Some(error.clone());
        Err(error)
    }

    /// End the response's coalescing: COMMIT what is open and clear a failure.
    fn finish_coalesced_apply(&mut self) -> Result<(), String> {
        let committed = self.commit_coalesced_apply();
        match self.coalesced_failure.take() {
            Some(failure) => Err(failure),
            None => committed,
        }
    }

    fn rollback_observation(&self, name: &str) {
        if let Err(error) = self
            .conn
            .execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
        {
            if let Some(failure) = self.storage_failure.borrow_mut().as_mut() {
                if failure.rollback_failure.is_none() {
                    failure.rollback_failure = Some(Box::new(QueryReadFailure::from(error)));
                }
            }
        }
    }

    fn finish_observation(
        &mut self,
        name: &str,
        mut batch: ChangeAccumulator,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::ObservationCommit);
        if self.failed_commits.iter().any(|(commit, _)| {
            commit
                .ops
                .iter()
                .any(|operation| batch.tables.contains_key(&operation.table))
        }) {
            batch.outcomes = true;
        }
        if !batch.touched() {
            self.conn
                .execute_batch(&format!("RELEASE {name}"))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            return Ok(());
        }
        let revision = self
            .local_revision()?
            .checked_add(1)
            .ok_or_else(|| "local revision exhausted u64".to_owned())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES (?1, ?2)",
                rusqlite::params![LOCAL_REVISION_KEY, revision.to_string()],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let status = batch.status.then(|| self.status_snapshot());
        let event = ClientChangeBatch {
            revision: revision.to_string(),
            tables: batch
                .tables
                .into_iter()
                .map(|(table, scope_keys)| TableChange {
                    table,
                    scope_keys: scope_keys.map(|keys| keys.into_iter().collect()),
                })
                .collect(),
            windows: batch
                .windows
                .into_iter()
                .map(|((base_key, table), units)| WindowChange {
                    base_key,
                    table,
                    units: units.into_iter().collect(),
                })
                .collect(),
            status,
            conflicts_changed: batch.conflicts,
            rejections_changed: batch.rejections,
            outcomes_changed: batch.outcomes,
            applied_commits: Vec::new(),
        };
        self.conn
            .execute_batch(&format!("RELEASE {name}"))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut diagnostic_tables = event
            .tables
            .iter()
            .map(|entry| entry.table.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut diagnostic_windows = event
            .windows
            .iter()
            .map(|entry| entry.table.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let domains_truncated = diagnostic_tables.len() > MAX_DIAGNOSTIC_DOMAINS
            || diagnostic_windows.len() > MAX_DIAGNOSTIC_DOMAINS;
        diagnostic_tables.truncate(MAX_DIAGNOSTIC_DOMAINS);
        diagnostic_windows.truncate(MAX_DIAGNOSTIC_DOMAINS);
        self.last_change = Some(DiagnosticLastChange {
            revision: event.revision.clone(),
            recorded_at_ms: self.clock_now_ms(),
            tables: diagnostic_tables,
            windows: diagnostic_windows,
            domains_truncated,
            status_changed: event.status.is_some(),
            conflicts_changed: event.conflicts_changed,
            rejections_changed: event.rejections_changed,
            outcomes_changed: event.outcomes_changed,
        });
        self.change_queue.push_back(event);
        Ok(())
    }

    fn record_scope_map(
        &self,
        batch: &mut ChangeAccumulator,
        table_name: &str,
        scopes: &[(String, Vec<String>)],
    ) {
        let Some(table) = self.schema.table(table_name) else {
            return;
        };
        // A bulk scoped delete whose map leaves a declared variable unnamed
        // cannot list the deleted rows' keys for it: the change is table-wide.
        if table.scope_variables.iter().any(|scope| {
            !scopes
                .iter()
                .any(|(variable, _)| *variable == scope.variable)
        }) {
            batch.table(table_name);
            return;
        }
        for (variable, values) in scopes {
            let Some(scope) = table
                .scope_variables
                .iter()
                .find(|scope| &scope.variable == variable)
            else {
                continue;
            };
            for value in values {
                batch.scope(table_name, format!("{}:{value}", scope.prefix));
            }
        }
    }

    /// Record a row's current scope keys from the base or visible table.
    fn record_row_scopes(
        &self,
        batch: &mut ChangeAccumulator,
        table_name: &str,
        row_id: &str,
        base: bool,
    ) -> bool {
        let Some(table) = self.schema.table(table_name) else {
            return false;
        };
        if table.scope_variables.is_empty() {
            return false;
        }
        let columns = table
            .scope_variables
            .iter()
            .map(|scope| quote_ident(&scope.column))
            .collect::<Vec<_>>()
            .join(", ");
        let full_table = if base {
            base_table(table_name)
        } else {
            visible_table(table_name)
        };
        let sql = format!(
            "SELECT {columns} FROM {full_table} WHERE {} LIMIT 1",
            row_id_predicate(table)
        );
        let Ok(mut stmt) = self.conn.prepare_cached(&sql) else {
            return false;
        };
        let values = stmt.query_row(rusqlite::params![row_id], |row| {
            let mut values = Vec::with_capacity(table.scope_variables.len());
            for index in 0..table.scope_variables.len() {
                values.push(row.get::<_, Option<String>>(index)?);
            }
            Ok(values)
        });
        let Ok(values) = values else {
            return false;
        };
        let mut recorded = false;
        for (scope, value) in table.scope_variables.iter().zip(values) {
            if let Some(value) = value {
                batch.scope(table_name, format!("{}:{value}", scope.prefix));
                recorded = true;
            }
        }
        recorded
    }

    fn record_commit_changes(
        &self,
        batch: &mut ChangeAccumulator,
        tables: &[String],
        changes: &[ssp2::model::Change],
    ) {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::ObservationPrepare);
        for change in changes {
            let Some(table_name) = tables.get(change.table_index as usize) else {
                continue;
            };
            let mut precise = self.record_row_scopes(batch, table_name, &change.row_id, true);
            if let Some(table) = self.schema.table(table_name) {
                for (variable, value) in &change.scopes {
                    if let Some(scope) = table
                        .scope_variables
                        .iter()
                        .find(|scope| &scope.variable == variable)
                    {
                        batch.scope(table_name, format!("{}:{value}", scope.prefix));
                        precise = true;
                    }
                }
            }
            if !precise {
                batch.table(table_name);
            }
        }
    }

    fn scoped_rows_exist(
        &self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
        owners: &[Vec<(String, Vec<String>)>],
    ) -> bool {
        let Some(table) = self.schema.table(table_name) else {
            return false;
        };
        let Ok(Some((predicate, params))) = local_scope_predicate(table, effective, owners) else {
            return false;
        };
        let sql = format!(
            "SELECT 1 FROM {} WHERE {predicate} LIMIT 1",
            base_table(table_name)
        );
        self.conn
            .query_row(&sql, rusqlite::params_from_iter(params), |_| Ok(()))
            .is_ok()
    }

    /// §7.4.5: true while a schema-bump reset + first re-bootstrap runs.
    pub fn upgrading(&self) -> bool {
        self.upgrading
    }

    /// §7.4.2 "app ships new code": swap to a NEW generated schema while
    /// keeping this client's local database (identity, outbox, tables). The
    /// §7.4.1 marker check then fires the wipe/re-bootstrap flow when the
    /// version increases. Recreation runs the same marker guard as opening
    /// a durable replica, holds the guard and every write it authorizes under
    /// one write transaction, and preserves the current client (compiled
    /// schema, outbox, tables) on refusal.
    pub fn recreate_with_schema(&mut self, schema_json: &Value) -> Result<(), String> {
        let new_schema = parse_schema_json(schema_json)?;
        validate_authority_reads(&new_schema, &self.limits.authority_reads)?;
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let prior_schema = std::mem::replace(&mut self.schema, new_schema);
        // §7.4.3/§7.4.4: a reset inside this transaction mutates in-memory
        // state (dropped outbox commits, rejections, upgrade and floor flags,
        // overlay dirtiness) and appends change/intent batches. A COMMIT that
        // fails after the reset succeeded rolls the database back, so every
        // one of those fields is captured here and restored with it.
        let rollback = self.capture();
        let guarded = (|| -> Result<(), String> {
            // §7.4.2: the marker is re-read under the write lock the caller
            // holds, so a replica another process upgraded meanwhile refuses
            // this recreation instead of having its marker and tables
            // downgraded.
            let marker = read_local_schema_version(&self.conn, self.schema.version)?;
            self.create_bookkeeping_tables()?;
            match marker {
                Some(version) if version < self.schema.version => self.run_schema_reset()?,
                None => {
                    self.create_synced_tables()?;
                    self.persist_schema_version()?;
                }
                _ => {}
            }
            // §7.4.2: recreation IS the boot for the in-memory core, so reload the
            // durable outbox the same-version path is about to replay. Only the
            // outbox is reloaded: the recovery below reads it, and the caller's
            // rollback snapshot already covers this field.
            self.outbox = self.load_outbox()?.into();
            // §7.1/§7.4.4: recover intrinsically codec-invalid persisted values at
            // this guarded boundary once the schema and marker agree. A bump went
            // through `run_schema_reset`, which performs the same recovery after
            // it creates the new physical tables and before its final replay.
            self.drop_unencodable_outbox(false, None)?;
            if marker == Some(self.schema.version)
                && (!self.outbox.is_empty()
                    || !self.failed_commits.is_empty()
                    || self.has_acknowledged_rows()?)
            {
                self.overlay_dirty.set(true);
                self.rebuild_overlay()?;
            }
            self.prune_unknown_subscriptions(false)?;
            self.save_subscription_scope_schema()?;
            // The conformance recreate is the in-memory equivalent of reopening
            // a durable client. Apply the same startup catch-up contract even
            // when the schema itself did not change.
            self.enqueue_startup_sync_if_needed()?;
            Ok(())
        })();
        let outcome = match guarded {
            Ok(()) => self
                .conn
                .execute_batch("COMMIT")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error)),
            Err(error) => Err(error),
        };
        if let Err(error) = outcome {
            if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                // Keep a failed rollback's typed storage classification.
                let _ = Self::sqlite_failure(&self.storage_failure, rollback);
            }
            self.schema = prior_schema;
            self.restore(rollback);
            // Prepared insert statements were derived from the reverted schema.
            self.insert_sql.borrow_mut().clear();
            return Err(error);
        }
        Ok(())
    }

    fn enqueue_startup_sync_if_needed(&mut self) -> Result<(), String> {
        let startup_work = !self.stopped
            && (!self.outbox.is_empty()
                || self.has_acknowledged_rows()?
                || !self.load_pending_evictions()?.is_empty()
                || self.subs.iter().any(|sub| sub.state == SubState::Active));
        if startup_work {
            self.sync_needed = true;
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
        Ok(())
    }

    /// A native client persists schema-floor stops across process restarts.
    /// Once the running app already satisfies that floor, the persisted stop
    /// is only stale evidence from an older server round (for example, the
    /// server was restarted after catching up to an app that was ahead).
    /// Clear it and let the normal startup pull re-negotiate. If the server is
    /// still incompatible it will return the floor again in that first round.
    fn clear_satisfied_persisted_schema_floor(&mut self) -> Result<(), String> {
        let satisfied = self
            .schema_floor
            .as_ref()
            .and_then(|floor| floor.required_schema_version)
            .is_some_and(|required| self.schema.version >= required);
        if !satisfied {
            return Ok(());
        }
        self.delete_meta(SCHEMA_FLOOR_KEY)?;
        self.schema_floor = None;
        self.stopped = false;
        Ok(())
    }

    /// RFC 0005 D1: discard an orphan or stale container at boot. The reset
    /// path already swept it; this covers a same-version or fresh-install open,
    /// which runs no reset and therefore no sweep — plus the D7 TTL, which only
    /// an aware binary can apply.
    fn reconcile_previous_version_at_boot(&self) -> Result<(), String> {
        let Some(replica_path) = self.previous_version_replica_path() else {
            return Ok(());
        };
        let max_age_ms = self
            .previous_version
            .filter(|config| config.enabled)
            .map(|config| config.max_age_ms);
        reconcile_previous_version_at_boot(
            &self.conn,
            &replica_path,
            self.schema.version,
            max_age_ms,
            self.clock_now_ms(),
        )
    }

    /// RFC 0005 D3: the sibling container path, or `None` when the replica has
    /// no file — an in-memory replica returns an empty path, and a `file:` URI
    /// has no plain sibling path — so the feature resolves as off there.
    fn previous_version_replica_path(&self) -> Option<String> {
        let path = self.conn.path()?;
        if path.is_empty() || path.starts_with("file:") {
            return None;
        }
        Some(path.to_owned())
    }

    /// §7.4.3 reset: whole-database local reset EXCEPT the outbox, clientId,
    /// and leaseState. Drops/recreates every synced table from the new
    /// schema, resets subscription sync-state (keeping registrations), clears
    /// the schema-floor stop state, rewrites the marker, drops outbox commits
    /// that cannot re-encode (§7.4.4), and replays the survivors on top.
    fn run_schema_reset(&mut self) -> Result<(), String> {
        self.begin_observation("syncular_schema_reset")?;
        let rollback = self.capture();
        let mut batch = ChangeAccumulator::default();
        let result = self
            .run_schema_reset_observed(&mut batch, true)
            .and_then(|()| self.finish_observation("syncular_schema_reset", batch));
        if let Err(error) = result {
            self.rollback_observation("syncular_schema_reset");
            self.restore(rollback);
            return Err(error);
        }
        Ok(())
    }

    fn run_log_epoch_reset(&mut self, log_epoch: &str) -> Result<Vec<String>, String> {
        if self.get_meta(LOG_EPOCH_KEY)?.is_none() {
            self.begin_observation("syncular_epoch_acquisition")?;
            let rollback = self.capture();
            if let Err(error) = self.conn.execute(
                "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES (?1,?2)",
                rusqlite::params![LOG_EPOCH_KEY, log_epoch],
            ) {
                self.rollback_observation("syncular_epoch_acquisition");
                return Err(Self::sqlite_failure(&self.storage_failure, error));
            }
            self.sync_needed = true;
            let batch = ChangeAccumulator {
                status: true,
                ..ChangeAccumulator::default()
            };
            if let Err(error) = self.finish_observation("syncular_epoch_acquisition", batch) {
                self.rollback_observation("syncular_epoch_acquisition");
                self.restore(rollback);
                return Err(error);
            }
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
            return Ok(Vec::new());
        }
        let resets = self.subs.iter().map(|sub| sub.id.clone()).collect();
        self.begin_observation("syncular_log_epoch_reset")?;
        let rollback = self.capture();
        let mut batch = ChangeAccumulator::default();
        let result = self
            .run_schema_reset_observed(&mut batch, false)
            .and_then(|()| {
                self.conn
                    .execute(
                        "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES (?1,?2)",
                        rusqlite::params![LOG_EPOCH_KEY, log_epoch],
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                self.sync_needed = true;
                batch.status = true;
                self.finish_observation("syncular_log_epoch_reset", batch)
            });
        if let Err(error) = result {
            self.rollback_observation("syncular_log_epoch_reset");
            self.restore(rollback);
            return Err(error);
        }
        self.sync_intent_queue.push_back(SyncIntent::Interactive);
        Ok(resets)
    }

    fn run_schema_reset_observed(
        &mut self,
        batch: &mut ChangeAccumulator,
        capture: bool,
    ) -> Result<(), String> {
        // §7.4.2: the reset is the only path that wipes local tables for a
        // version bump, and it rewrites the marker last. Re-read the marker
        // under this reset's transaction: a replica another process upgraded
        // meanwhile refuses here instead of being reset to this client's
        // older schema.
        read_local_schema_version(&self.conn, self.schema.version)?;
        self.conn
            .execute_batch(
                "DELETE FROM _syncular_acked_rows; DELETE FROM _syncular_row_deliveries;",
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.cancel_sync_round();
        self.upgrading = true;
        batch.status = true;
        // RFC 0005 D6: classify the pending outbox against the NEW compiled
        // schema BEFORE the wipe, and record the advisory audit. This pass
        // drops nothing, so the audit sees the original pending intent; the
        // §7.4.4 send-time drop and the intrinsic value recovery later in this
        // reset are the paths that remove a commit. The classification is
        // shared with the send-time drop so the two cannot disagree about what
        // is incompatible.
        if self.previous_version.is_some_and(|config| config.enabled) {
            let previous_version = self
                .get_meta(LOCAL_SCHEMA_VERSION_KEY)?
                .and_then(|value| value.parse::<i32>().ok())
                .unwrap_or(self.schema.version);
            let pending = self
                .outbox
                .iter()
                .map(|commit| PendingCommitAudit {
                    commit_id: &commit.client_commit_id,
                    operations: commit_audit_operations(commit),
                })
                .collect::<Vec<_>>();
            crate::previous_version::write_previous_version_audit(
                &self.conn,
                &crate::previous_version::build_previous_version_audit(
                    &self.schema,
                    &pending,
                    previous_version,
                    self.schema.version,
                    self.clock_now_ms(),
                ),
            )?;
        }
        // RFC 0005 D5: the container lives in its own FILE, so the reset can
        // never reach it. Sweep first (unconditional — also on the log-epoch
        // reset, which captures nothing), then capture BEFORE the wipe drops
        // any row. A refused capture records its reason and leaves no file.
        if let Some(replica_path) = self.previous_version_replica_path() {
            sweep_previous_version_container(&self.conn, &replica_path)?;
            if capture {
                if let Some(config) = self.previous_version.filter(|config| config.enabled) {
                    let previous_version = self
                        .get_meta(LOCAL_SCHEMA_VERSION_KEY)?
                        .and_then(|value| value.parse::<i32>().ok())
                        .unwrap_or(self.schema.version);
                    capture_previous_version_from_replica(
                        &self.conn,
                        &replica_path,
                        previous_version,
                        self.schema.version,
                        &config,
                        self.clock_now_ms(),
                    )?;
                }
            }
        }
        for table in &self.schema.tables {
            batch.table(&table.name);
        }
        for (base_key, unit, table) in self.load_registered_window_units() {
            batch.window(&base_key, &table, &unit);
        }
        if capture {
            self.prune_unknown_subscriptions(true)?;
        }
        // The per-table insert SQL is derived from the OLD column lists.
        self.insert_sql.borrow_mut().clear();
        self.overlay_dirty.set(true);
        // Drop every synced table (base + visible) that currently exists —
        // discovered from sqlite_master so a bump that adds/removes tables is
        // handled. Bookkeeping tables (`_syncular_outbox/_subscriptions/_meta`
        // and the blob cache) are preserved; base tables are `_syncular_base_*`
        // so they are matched explicitly, not by the bookkeeping filter.
        // Drop virtual tables first so SQLite removes every FTS shadow table
        // atomically instead of the generic discovery tearing it apart.
        let virtual_tables: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            rows.filter_map(Result::ok)
                .filter(|name| is_synced_table_name(name))
                .collect()
        };
        for name in virtual_tables {
            self.conn
                .execute_batch(&format!(
                    "DROP TABLE IF EXISTS {}",
                    quote_ident(&format!("_syncular_fts_{name}"))
                ))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            self.conn
                .execute(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)), [])
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        let existing: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            rows.filter_map(Result::ok)
                .filter(|name| is_synced_table_name(name))
                .collect()
        };
        for name in &existing {
            if let Some(table) = name.strip_prefix("_syncular_base_") {
                batch.table(table);
            } else if !name.starts_with("_syncular_") {
                batch.table(name);
            }
        }
        for name in existing {
            self.conn
                .execute(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)), [])
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        // Recreate the synced tables from the NEW schema.
        self.create_synced_tables()?;
        // Reset every subscription's sync-state, keeping the registration.
        for sub in self.subs.iter_mut() {
            sub.cursor = -1;
            sub.bootstrap_state = None;
            sub.effective = None;
            sub.state = SubState::Active;
            sub.reason_code = None;
            sub.synced_once = false;
        }
        let subs = self.subs.clone();
        for sub in subs.iter() {
            self.persist_sub(sub)?;
        }
        // The stop state is over: this client now ships a servable schema.
        self.stopped = false;
        self.schema_floor = None;
        self.delete_meta(SCHEMA_FLOOR_KEY)?;
        // Rewrite the marker LAST so a crash mid-reset re-runs the reset.
        self.persist_schema_version()?;
        self.save_subscription_scope_schema()?;
        // §7.1/§7.4.4: the previous-version capture and audit above saw the
        // original pending intent; the synced tables now carry the new schema, so
        // recover intrinsically codec-invalid persisted values here, before the
        // final replay. A pending upsert that names a column the new schema
        // removed stays pending for the send-time `drop_incompatible_outbox`
        // prepass. The reset wrapper snapshots and restores the outbox,
        // rejections, and change queues, so a failed commit rolls this recovery
        // back with the rest of the reset.
        // §7.4.4: the enclosing reset observation owns the publication, so the
        // recovery contributes its rejection, outcome, and table domains to it.
        self.drop_unencodable_outbox(false, Some(batch))?;
        // Re-apply the surviving outbox optimistically over the empty tables.
        self.rebuild_overlay()?;
        Ok(())
    }

    /// §7.4.4 send-time prepass: a persisted upsert whose values reference a
    /// column the current schema lacks (or a removed table) cannot be encoded
    /// (`commit_audit_operations` inspects upserts, so a value-free delete stays
    /// encodable and is validated by the server), nor can an insert-intent
    /// upsert that lacks a non-nullable column (§7.1, the audit's
    /// `missing-required-column`). Drop the commit, undo
    /// its optimistic projection, and raise a client-local
    /// `sync.outbox_incompatible` rejection.
    fn drop_incompatible_outbox(&mut self) -> Result<bool, String> {
        let incompatible = self
            .outbox
            .iter()
            .filter(|commit| {
                first_incompatibility(&self.schema, &commit_audit_operations(commit)).is_some()
            })
            .cloned()
            .collect::<Vec<_>>();
        if incompatible.is_empty() {
            return Ok(false);
        }
        self.drop_outbox_commits(
            &incompatible,
            OUTBOX_INCOMPATIBLE_CODE,
            "the persisted commit cannot encode under the current schema",
        )?;
        Ok(true)
    }

    /// §7.4.4 incompatible-commit path, also taken by a refused blob upload
    /// (§5.9.7) with the server's code: reject every operation of `commits`,
    /// remove them from the outbox, and undo their optimistic rows.
    fn drop_outbox_commits(
        &mut self,
        incompatible: &[Arc<OutboxCommit>],
        code: &str,
        message: &str,
    ) -> Result<(), String> {
        // §7.4.4: one observation covers the durable outcome writes, the outbox
        // removal, the in-memory drop, and the overlay rebuild, so a storage
        // fault leaves the replica and the client unchanged and publishes no
        // change; a successful drop publishes exactly one batch carrying the
        // rejections, outcomes, status, and the tables whose projection changed.
        let rollback = self.capture();
        let owns_transaction = self.conn.is_autocommit();
        self.begin_observation("syncular_outbox_drop")?;
        let mut batch = ChangeAccumulator::default();
        let dropped = (|| -> Result<(), String> {
            let mut rejections = Vec::new();
            for commit in incompatible {
                let results = commit
                    .ops
                    .iter()
                    .enumerate()
                    .map(|(op_index, operation)| {
                        let rejection = RejectionRecord {
                            client_commit_id: commit.client_commit_id.clone(),
                            op_index: op_index as i32,
                            code: code.to_owned(),
                            message: message.to_owned(),
                            retryable: false,
                            details: None,
                            operation: Some(CommitOperation::from(operation)),
                        };
                        rejections.push(rejection.clone());
                        CommitOperationOutcome::Error { rejection }
                    })
                    .collect::<Vec<_>>();
                self.persist_commit_outcome(
                    &commit.client_commit_id,
                    CommitOutcomeStatus::Rejected,
                    &results,
                    Some(&commit.ops),
                )?;
                self.delete_outbox_persisted(&commit.client_commit_id)?;
                // A removed table has no local projection to invalidate; every
                // surviving table the dropped commit touched does.
                for operation in &commit.ops {
                    if self.schema.table(&operation.table).is_some() {
                        batch.table(&operation.table);
                    }
                }
            }
            self.prune_commit_outcomes()?;
            let incompatible_ids = incompatible
                .iter()
                .map(|commit| commit.client_commit_id.as_str())
                .collect::<BTreeSet<_>>();
            self.outbox
                .retain(|commit| !incompatible_ids.contains(commit.client_commit_id.as_str()));
            self.rejections.extend(rejections);
            // The dropped commits' purely-optimistic rows are undone: the
            // visible projection is re-derived from the surviving base + outbox.
            self.overlay_dirty.set(true);
            self.rebuild_overlay()?;
            batch.status = true;
            batch.rejections = true;
            batch.outcomes = true;
            Ok(())
        })();
        let result = dropped.and_then(|()| self.finish_observation("syncular_outbox_drop", batch));
        if let Err(error) = result {
            // An outer RELEASE is the COMMIT. Roll back that transaction
            // directly: retrying RELEASE after ROLLBACK TO still needs the
            // reader's lock. A nested observation only rolls back its savepoint.
            if owns_transaction {
                if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                    let mut failure = self.storage_failure.borrow_mut();
                    let failure =
                        failure.get_or_insert_with(|| QueryReadFailure::from(error.clone()));
                    failure.rollback_failure = Some(Box::new(QueryReadFailure::from(rollback)));
                }
            } else {
                self.rollback_observation("syncular_outbox_drop");
            }
            self.restore(rollback);
            return Err(error);
        }
        Ok(())
    }

    /// §7.4.3: (re)create the base + visible table pair for every synced
    /// table in the CURRENT schema (idempotent — `IF NOT EXISTS`).
    fn create_synced_tables(&self) -> Result<(), String> {
        for table in &self.schema.tables {
            // The base half + the visible half form the synced-table pair. An
            // index name is global in SQLite, so the base half's indexes are
            // name-prefixed (`_syncular_base_<index>`) to stay distinct.
            for (full, index_prefix) in [
                (base_table(&table.name), "_syncular_base_"),
                (visible_table(&table.name), ""),
            ] {
                let mut cols: Vec<String> =
                    table.columns.iter().map(|c| quote_ident(&c.name)).collect();
                cols.push("\"_syncular_version\" INTEGER NOT NULL".to_owned());
                let sql = format!(
                    "CREATE TABLE IF NOT EXISTS {full} ({} , PRIMARY KEY ({}))",
                    cols.join(", "),
                    quote_ident(&table.primary_key)
                );
                self.conn
                    .execute(&sql, [])
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                // Local secondary indexes (CREATE INDEX subset). Created on
                // both halves so mirror reads hit an index on either. Runs on
                // both the initial create and the §7.4.3 reset recreate path.
                for index in &table.indexes {
                    let unique = if index.unique { "UNIQUE " } else { "" };
                    let index_name = quote_ident(&format!("{index_prefix}{}", index.name));
                    let cols_sql = index
                        .columns
                        .iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let index_sql = format!(
                        "CREATE {unique}INDEX IF NOT EXISTS {index_name} ON {full} ({cols_sql})"
                    );
                    self.conn
                        .execute(&index_sql, [])
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                }
            }
        }
        // FTS exists only on the visible half. It is a local search
        // projection, never a synced/base table or a wire-schema member.
        for table in &self.schema.tables {
            for index in &table.fts_indexes {
                self.create_fts_projection(table, index)?;
            }
        }
        Ok(())
    }

    fn fts_projection_exists(&self, index: &FtsIndexSchema) -> Result<bool, String> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![index.name],
                |row| row.get(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(count > 0)
    }

    fn drop_fts_triggers(&self, index: &FtsIndexSchema) -> Result<(), String> {
        for suffix in ["ai", "ad", "au"] {
            self.conn
                .execute(
                    &format!(
                        "DROP TRIGGER IF EXISTS {}",
                        quote_ident(&format!("{}_{suffix}", index.name))
                    ),
                    [],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(())
    }

    fn create_fts_triggers(
        &self,
        table: &TableSchema,
        index: &FtsIndexSchema,
    ) -> Result<(), String> {
        let fts = quote_ident(&index.name);
        let source = visible_table(&table.name);
        let source_id = quote_ident(FTS_SOURCE_ID_COLUMN);
        let pk = quote_ident(&table.primary_key);
        let projection_columns = std::iter::once(source_id.clone())
            .chain(index.columns.iter().map(|column| quote_ident(column)))
            .collect::<Vec<_>>()
            .join(", ");
        let new_values = std::iter::once(format!("CAST(new.{pk} AS TEXT)"))
            .chain(
                index
                    .columns
                    .iter()
                    .map(|column| format!("new.{}", quote_ident(column))),
            )
            .collect::<Vec<_>>()
            .join(", ");
        let mapping = quote_ident(&format!("_syncular_fts_{}", index.name));
        let delete_new = format!("DELETE FROM {fts} WHERE rowid = (SELECT id FROM {mapping} WHERE source_id = CAST(new.{pk} AS TEXT)); DELETE FROM {mapping} WHERE source_id = CAST(new.{pk} AS TEXT)");
        let delete_old = format!("DELETE FROM {fts} WHERE rowid = (SELECT id FROM {mapping} WHERE source_id = CAST(old.{pk} AS TEXT)); DELETE FROM {mapping} WHERE source_id = CAST(old.{pk} AS TEXT)");
        let insert_new = format!("INSERT INTO {mapping}(source_id) VALUES (CAST(new.{pk} AS TEXT)); INSERT INTO {fts} (rowid, {projection_columns}) VALUES ((SELECT id FROM {mapping} WHERE source_id = CAST(new.{pk} AS TEXT)), {new_values})");
        let bi = quote_ident(&format!("{}_bi", index.name));
        let ai = quote_ident(&format!("{}_ai", index.name));
        let ad = quote_ident(&format!("{}_ad", index.name));
        let au = quote_ident(&format!("{}_au", index.name));
        let replacement_exists = format!("EXISTS (SELECT 1 FROM {source} WHERE {pk} = new.{pk})");
        let sql = format!(
            "DROP TRIGGER IF EXISTS {bi};
             DROP TRIGGER IF EXISTS {ai};
             DROP TRIGGER IF EXISTS {ad};
             DROP TRIGGER IF EXISTS {au};
             CREATE TRIGGER {bi} BEFORE INSERT ON {source} WHEN {replacement_exists} BEGIN {delete_new}; END;
             CREATE TRIGGER {ai} AFTER INSERT ON {source} BEGIN {insert_new}; END;
             CREATE TRIGGER {ad} AFTER DELETE ON {source} BEGIN {delete_old}; END;
             CREATE TRIGGER {au} AFTER UPDATE ON {source} BEGIN {delete_old}; {delete_new}; {insert_new}; END;",
        );
        self.conn
            .execute_batch(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn rebuild_fts_projection(
        &self,
        table: &TableSchema,
        index: &FtsIndexSchema,
    ) -> Result<(), String> {
        let fts = quote_ident(&index.name);
        let source_id = quote_ident(FTS_SOURCE_ID_COLUMN);
        let pk = quote_ident(&table.primary_key);
        let indexed_columns = index
            .columns
            .iter()
            .map(|column| quote_ident(column))
            .collect::<Vec<_>>();
        let projection_columns = std::iter::once(source_id.clone())
            .chain(indexed_columns.iter().cloned())
            .collect::<Vec<_>>()
            .join(", ");
        let mapping = quote_ident(&format!("_syncular_fts_{}", index.name));
        let sql = format!(
            "DELETE FROM {fts}; DELETE FROM {mapping}; INSERT INTO {fts} ({projection_columns}) SELECT CAST({pk} AS TEXT), {columns} FROM {source}; INSERT INTO {mapping}(id, source_id) SELECT rowid, {source_id} FROM {fts};",
            columns = indexed_columns.join(", "),
            source = visible_table(&table.name),
        );
        self.conn
            .execute_batch(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn create_fts_projection(
        &self,
        table: &TableSchema,
        index: &FtsIndexSchema,
    ) -> Result<(), String> {
        self.begin_observation("syncular_fts_schema")?;
        let result = (|| {
            let existed = self.fts_projection_exists(index)?;
            let tokenizer = index.tokenize.replace('\'', "''");
            let columns = index
                .columns
                .iter()
                .map(|column| quote_ident(column))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {fts} USING fts5({source_id} UNINDEXED, {columns}, tokenize='{tokenizer}')",
            fts = quote_ident(&index.name),
            source_id = quote_ident(FTS_SOURCE_ID_COLUMN),
        );
            self.conn.execute(&sql, []).map_err(|error| {
                format!(
                    "cannot create local FTS5 projection {:?}: {error}",
                    index.name
                )
            })?;
            let mapping = quote_ident(&format!("_syncular_fts_{}", index.name));
            let mapped: bool = self
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [format!("_syncular_fts_{}", index.name)],
                    |row| row.get(0),
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            self.conn.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {mapping}(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE)")).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            if !mapped && existed {
                self.conn
                    .execute_batch(&format!(
                        "INSERT INTO {mapping}(id, source_id) SELECT rowid, {} FROM {}",
                        quote_ident(FTS_SOURCE_ID_COLUMN),
                        quote_ident(&index.name)
                    ))
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
            self.create_fts_triggers(table, index)?;
            if !existed {
                self.rebuild_fts_projection(table, index)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.rollback_observation("syncular_fts_schema");
            return Err(error);
        }
        if let Err(error) = self.conn.execute_batch("RELEASE syncular_fts_schema") {
            self.rollback_observation("syncular_fts_schema");
            return Err(error.to_string());
        }
        Ok(())
    }

    // -- persistence write-through --------------------------------------------

    fn persist_sub(&self, sub: &Subscription) -> Result<(), String> {
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
        self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_subscriptions (id, tbl, state_json) VALUES (?1, ?2, ?3)",
            rusqlite::params![sub.id, sub.table, state.to_string()],
        ).map(|_| ()).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn persist_outbox_insert(&self, commit: &OutboxCommit) -> Result<(), String> {
        let ops: Vec<Value> = commit
            .ops
            .iter()
            .map(|op| {
                let mut entry = serde_json::json!({
                    "op": if op.upsert { "upsert" } else { "delete" },
                    "table": op.table,
                    "rowId": op.row_id,
                    "baseVersion": op.base_version,
                    "values": op.values.clone().map(Value::Object),
                });
                if op.insert {
                    entry["insert"] = Value::Bool(true);
                }
                entry
            })
            .collect();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_outbox (commit_id, ops_json) VALUES (?1, ?2)",
                rusqlite::params![commit.client_commit_id, Value::Array(ops).to_string()],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        for operation in &commit.ops {
            let Some(values) = &operation.values else {
                continue;
            };
            let Some(table) = self.schema.table(&operation.table) else {
                continue;
            };
            for column in table
                .columns
                .iter()
                .filter(|column| column.ty == ColumnType::BlobRef)
            {
                let Some(Value::String(raw)) = values.get(&column.name) else {
                    continue;
                };
                let Ok(blob_ref) = serde_json::from_str::<Value>(raw) else {
                    continue;
                };
                let Some(blob_id) = blob_ref.get("blobId").and_then(Value::as_str) else {
                    continue;
                };
                self.conn
                    .execute(
                        "INSERT OR IGNORE INTO _syncular_blob_commit_refs(commit_id, blob_id)
                         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM _syncular_blobs WHERE blob_id = ?2)",
                        rusqlite::params![commit.client_commit_id, blob_id],
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
        }
        Ok(())
    }

    fn delete_outbox_persisted(&self, client_commit_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM _syncular_blob_commit_refs WHERE commit_id = ?1",
                rusqlite::params![client_commit_id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.conn
            .execute(
                "DELETE FROM _syncular_outbox WHERE commit_id = ?1",
                rusqlite::params![client_commit_id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.conn.execute("DELETE FROM _syncular_row_deliveries WHERE NOT EXISTS(SELECT 1 FROM _syncular_outbox,json_each(ops_json) WHERE json_extract(json_each.value,'$.table')=tbl AND json_extract(json_each.value,'$.rowId')=id)", [])
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn outcome_status_name(status: CommitOutcomeStatus) -> &'static str {
        match status {
            CommitOutcomeStatus::Applied => "applied",
            CommitOutcomeStatus::Cached => "cached",
            CommitOutcomeStatus::Conflict => "conflict",
            CommitOutcomeStatus::Rejected => "rejected",
        }
    }

    fn outcome_resolution_name(resolution: CommitOutcomeResolution) -> &'static str {
        match resolution {
            CommitOutcomeResolution::Active => "active",
            CommitOutcomeResolution::ResolvedKeepServer => "resolved_keep_server",
            CommitOutcomeResolution::Superseded => "superseded",
            CommitOutcomeResolution::Dismissed => "dismissed",
        }
    }

    fn parse_outcome_status(value: &str) -> Result<CommitOutcomeStatus, String> {
        match value {
            "applied" => Ok(CommitOutcomeStatus::Applied),
            "cached" => Ok(CommitOutcomeStatus::Cached),
            "conflict" => Ok(CommitOutcomeStatus::Conflict),
            "rejected" => Ok(CommitOutcomeStatus::Rejected),
            _ => Err(format!("invalid persisted commit outcome status {value:?}")),
        }
    }

    fn parse_outcome_resolution(value: &str) -> Result<CommitOutcomeResolution, String> {
        match value {
            "active" => Ok(CommitOutcomeResolution::Active),
            "resolved_keep_server" => Ok(CommitOutcomeResolution::ResolvedKeepServer),
            "superseded" => Ok(CommitOutcomeResolution::Superseded),
            "dismissed" => Ok(CommitOutcomeResolution::Dismissed),
            _ => Err(format!(
                "invalid persisted commit outcome resolution {value:?}"
            )),
        }
    }

    fn persist_commit_outcome(
        &self,
        client_commit_id: &str,
        status: CommitOutcomeStatus,
        results: &[CommitOperationOutcome],
        operations: Option<&[OutboxOp]>,
    ) -> Result<(), String> {
        let results_json = serde_json::to_string(results).map_err(|error| error.to_string())?;
        let operations_json = operations
            .map(|items| {
                serde_json::to_string(&items.iter().map(CommitOperation::from).collect::<Vec<_>>())
            })
            .transpose()
            .map_err(|error| error.to_string())?;
        self.conn
            .execute(
                "INSERT INTO _syncular_commit_outcomes (
                   client_commit_id, status, recorded_at_ms, results_json,
                   operations_json, resolution
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'active')",
                rusqlite::params![
                    client_commit_id,
                    Self::outcome_status_name(status),
                    self.clock_now_ms(),
                    results_json,
                    operations_json
                ],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// §7.2: the journal holds a stored cell only in its canonical shape. A cell
    /// the byte-envelope rule refuses cannot be journaled verbatim.
    fn stored_cell_is_representable(cell: &Value) -> bool {
        cell.is_null()
            || cell.is_string()
            || cell.is_boolean()
            || cell.is_number()
            || is_canonical_bytes_envelope(cell)
    }

    fn stored_row_is_representable(value: &Value) -> bool {
        value
            .as_object()
            .is_some_and(|row| row.values().all(Self::stored_cell_is_representable))
    }

    fn stored_operation_is_representable(value: &Value) -> bool {
        value.get("table").is_some_and(Value::is_string)
            && value.get("rowId").is_some_and(Value::is_string)
            && value.get("baseVersion").is_none_or(|v| {
                v.as_i64()
                    .is_some_and(|n| n.unsigned_abs() <= MAX_JS_SAFE_INTEGER)
            })
            && match value.get("op").and_then(Value::as_str) {
                Some("upsert") => {
                    value
                        .get("values")
                        .is_some_and(Self::stored_row_is_representable)
                        && value
                            .get("insert")
                            .is_none_or(|insert| *insert == Value::Bool(true))
                }
                Some("delete") => value.get("values").is_none() && value.get("insert").is_none(),
                _ => false,
            }
    }

    /// §7.2/§7.4.4: a dropped commit keeps its operation envelope in the journal
    /// only when the journal reader accepts the serialized operation, which is the
    /// rule `outcome_from_row` applies to this same row later.
    fn outbox_op_is_journalable(operation: &OutboxOp) -> bool {
        serde_json::to_value(CommitOperation::from(operation))
            .is_ok_and(|value| Self::stored_operation_is_representable(&value))
    }

    fn outcome_from_row(row: StoredCommitOutcomeRow) -> Result<CommitOutcome, String> {
        let StoredCommitOutcomeRow {
            sequence,
            client_commit_id,
            status,
            recorded_at_ms,
            results_json,
            operations_json,
            resolution,
            resolved_at_ms,
            replacement_client_commit_id,
        } = row;
        if sequence.unsigned_abs() > MAX_JS_SAFE_INTEGER
            || recorded_at_ms.unsigned_abs() > MAX_JS_SAFE_INTEGER
            || resolved_at_ms.is_some_and(|value| value.unsigned_abs() > MAX_JS_SAFE_INTEGER)
        {
            return Err("sync.local_corrupt: persisted commit outcome is invalid".to_owned());
        }
        let invalid = || "sync.local_corrupt: persisted commit outcome is invalid".to_owned();
        let stored: Vec<Value> = serde_json::from_str(&results_json).map_err(|_| invalid())?;
        for result in &stored {
            let nested = match result.get("status").and_then(Value::as_str) {
                Some("conflict") => result.get("conflict"),
                Some("error") => result.get("rejection"),
                _ => None,
            };
            if nested
                .and_then(|record| record.get("operation"))
                .is_some_and(|op| !Self::stored_operation_is_representable(op))
                || (result.get("status").and_then(Value::as_str) == Some("conflict")
                    && nested
                        .and_then(|record| record.get("serverRow"))
                        .is_some_and(|row| !Self::stored_row_is_representable(row)))
            {
                return Err(invalid());
            }
        }
        let results: Vec<CommitOperationOutcome> =
            serde_json::from_value(Value::Array(stored)).map_err(|_| invalid())?;
        let has_conflict = results
            .iter()
            .any(|result| matches!(result, CommitOperationOutcome::Conflict { .. }));
        let has_error = results
            .iter()
            .any(|result| matches!(result, CommitOperationOutcome::Error { .. }));
        let status = Self::parse_outcome_status(&status).map_err(|_| invalid())?;
        let redacted = results.is_empty() && operations_json.is_none();
        if match status {
            CommitOutcomeStatus::Applied | CommitOutcomeStatus::Cached => has_conflict || has_error,
            CommitOutcomeStatus::Conflict => !(has_conflict || redacted),
            CommitOutcomeStatus::Rejected => has_conflict || !(has_error || redacted),
        } {
            return Err(invalid());
        }
        let operations: Option<Vec<CommitOperation>> = operations_json
            .map(|raw| {
                let stored: Vec<Value> = serde_json::from_str(&raw).map_err(|_| invalid())?;
                if !stored.iter().all(Self::stored_operation_is_representable) {
                    return Err(invalid());
                }
                serde_json::from_value(Value::Array(stored)).map_err(|_| invalid())
            })
            .transpose()?;
        for result in &results {
            match result {
                CommitOperationOutcome::Conflict { conflict }
                    if conflict.server_version.unsigned_abs() > MAX_JS_SAFE_INTEGER =>
                {
                    return Err("sync.local_corrupt: persisted commit outcome is invalid".to_owned())
                }
                CommitOperationOutcome::Error { rejection } => {
                    if let Some(details) = &rejection.details {
                        let encoded = serde_json::to_string(details).map_err(|_| {
                            "sync.local_corrupt: persisted commit outcome is invalid".to_owned()
                        })?;
                        RejectionDetails::parse(&encoded).map_err(|_| {
                            "sync.local_corrupt: persisted commit outcome is invalid".to_owned()
                        })?;
                    }
                }
                _ => {}
            }
        }
        Ok(CommitOutcome {
            sequence,
            client_commit_id,
            status,
            recorded_at_ms,
            results,
            operations,
            retained_rows: None,
            resolution: Self::parse_outcome_resolution(&resolution)?,
            resolved_at_ms,
            replacement_client_commit_id,
        })
    }

    /// Resolve declared unique keys through SQLite, including affinity and NULL semantics.
    fn unique_conflicts(
        &self,
        table: &TableSchema,
        values: &Map<String, Value>,
        base: bool,
    ) -> Result<Vec<RetainedUniqueConflict>, String> {
        let source = if base {
            base_table(&table.name)
        } else {
            visible_table(&table.name)
        };
        let mut conflicts = Vec::new();
        for index in table.indexes.iter().filter(|index| index.unique) {
            let mut params = vec![json_param_to_sql(
                values.get(&table.primary_key).ok_or("sync.local_corrupt")?,
            )?];
            for name in &index.columns {
                let column = table
                    .columns
                    .iter()
                    .find(|column| column.name == *name)
                    .ok_or("sync.local_corrupt")?;
                let cell = json_to_column_value(column, values.get(name))?;
                params.push(owned_sql_value(RowParam::Cell(&cell))?);
            }
            let sql = format!(
                "SELECT * FROM {source} WHERE {} != ? AND {}",
                quote_ident(&table.primary_key),
                index
                    .columns
                    .iter()
                    .map(|column| format!("{} = ?", quote_ident(column)))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            );
            let mut statement = self
                .conn
                .prepare_cached(&sql)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let records = statement
                .query_map(rusqlite::params_from_iter(params), |record| {
                    let values = table
                        .columns
                        .iter()
                        .enumerate()
                        .map(|(index, column)| {
                            let value = sql_ref_to_json(column, record.get_ref(index)?);
                            json_to_column_value(column, Some(&value)).map_err(|message| {
                                rusqlite::Error::ToSqlConversionFailure(message.into())
                            })
                        })
                        .collect::<Result<Row, _>>()?;
                    Ok((values, record.get::<_, i64>(table.columns.len())?))
                })
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            for record in records {
                let (row, version) =
                    record.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let row_id = render_row_id_json(Some(&column_value_to_json(&row[table.pk_index])))?;
                conflicts.push(RetainedUniqueConflict {
                    index: index.name.clone(),
                    columns: index.columns.clone(),
                    row_id,
                    server_row: table
                        .columns
                        .iter()
                        .zip(&row)
                        .map(|(column, value)| (column.name.clone(), column_value_to_json(value)))
                        .collect(),
                    server_version: version,
                });
            }
        }
        Ok(conflicts)
    }

    fn attach_retained_rows(&self, mut outcome: CommitOutcome) -> Result<CommitOutcome, String> {
        if let Some((commit, initial)) = self
            .failed_commits
            .iter()
            .find(|(commit, _)| commit.client_commit_id == outcome.client_commit_id)
        {
            let mut rows = Vec::new();
            for operation in &commit.ops {
                // A table the current schema removed has no rows to retain.
                let Some(table) = self.schema.table(&operation.table) else {
                    continue;
                };
                let key =
                    serde_json::to_string(&(operation.table.clone(), operation.row_id.clone()))
                        .map_err(|_| "sync.local_corrupt".to_owned())?;
                let base = self.stored_row(table, &operation.row_id, true)?;
                rows.push(RetainedCommitRow {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    unique_conflicts: if operation.upsert {
                        self.unique_conflicts(
                            table,
                            initial
                                .get(&key)
                                .and_then(Value::as_object)
                                .or(operation.values.as_ref())
                                .ok_or("sync.local_corrupt")?,
                            true,
                        )?
                    } else {
                        Vec::new()
                    },
                    local_row: if operation.upsert {
                        initial
                            .get(&key)
                            .and_then(Value::as_object)
                            .cloned()
                            .or_else(|| operation.values.clone())
                    } else {
                        None
                    },
                    server_row: base.as_ref().map(|(values, _)| {
                        table
                            .columns
                            .iter()
                            .zip(values)
                            .map(|(column, value)| {
                                (column.name.clone(), column_value_to_json(value))
                            })
                            .collect()
                    }),
                    server_version: base.map(|(_, version)| version),
                });
            }
            outcome.retained_rows = Some(rows);
        }
        Ok(outcome)
    }

    pub fn commit_outcome(&self, client_commit_id: &str) -> Result<Option<CommitOutcome>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT seq, client_commit_id, status, recorded_at_ms, results_json, operations_json,
                        resolution, resolved_at_ms, replacement_client_commit_id
                   FROM _syncular_commit_outcomes WHERE client_commit_id = ?1",
                rusqlite::params![client_commit_id],
                |row| {
                    Ok(StoredCommitOutcomeRow {
                        sequence: row.get(0)?,
                        client_commit_id: row.get(1)?,
                        status: row.get(2)?,
                        recorded_at_ms: row.get(3)?,
                        results_json: row.get(4)?,
                        operations_json: row.get(5)?,
                        resolution: row.get(6)?,
                        resolved_at_ms: row.get(7)?,
                        replacement_client_commit_id: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        row.map(|row| self.attach_retained_rows(Self::outcome_from_row(row)?))
            .transpose()
    }

    /// Internal host step. The host must run its idle drive before finishing.
    #[doc(hidden)]
    pub fn prepare_current_base(
        &self,
        client_commit_id: &str,
        sequence: i64,
    ) -> Result<CurrentBasePreparation, CurrentBaseProof> {
        let outcome = self
            .commit_outcome(client_commit_id)
            .map_err(|_| CurrentBaseProof::failure(CurrentBaseProofReason::SnapshotFailed))?;
        let valid = outcome.as_ref().is_some_and(|outcome| {
            outcome.sequence == sequence
                && outcome.resolution == CommitOutcomeResolution::Active
                && matches!(
                    outcome.status,
                    CommitOutcomeStatus::Conflict | CommitOutcomeStatus::Rejected
                )
                && outcome
                    .operations
                    .as_ref()
                    .zip(outcome.retained_rows.as_ref())
                    .is_some_and(|(operations, rows)| {
                        !rows.is_empty() && operations.len() == rows.len()
                    })
        });
        if !valid {
            return Err(CurrentBaseProof::failure(
                CurrentBaseProofReason::OutcomeUnavailable,
            ));
        }
        if !self.transport_enabled {
            return Err(CurrentBaseProof::failure(CurrentBaseProofReason::Offline));
        }
        Ok(CurrentBasePreparation {
            client_commit_id: client_commit_id.to_owned(),
            sequence,
            subscriptions: self.subs.to_vec(),
            transport_epoch: self.transport_epoch,
            subscription_epoch: self.subscription_epoch,
            security_epoch: self.security_epoch,
        })
    }

    /// Internal host step after the completed post-rejection idle drive.
    #[doc(hidden)]
    pub fn finish_current_base(
        &mut self,
        prepared: CurrentBasePreparation,
        drive: SyncOutcome,
    ) -> CurrentBaseProof {
        if !self.transport_enabled || self.transport_epoch != prepared.transport_epoch {
            return CurrentBaseProof::failure(CurrentBaseProofReason::Offline);
        }
        if self.subscription_epoch != prepared.subscription_epoch {
            return CurrentBaseProof::failure(CurrentBaseProofReason::MissingCoverage);
        }
        if self.security_preflight || self.security_epoch != prepared.security_epoch {
            return CurrentBaseProof::failure(CurrentBaseProofReason::SyncFailed);
        }
        let report = match drive {
            SyncOutcome::Ok(report) => report,
            SyncOutcome::BudgetExhausted(_) => {
                return CurrentBaseProof::failure(CurrentBaseProofReason::BudgetExhausted)
            }
            _ => return CurrentBaseProof::failure(CurrentBaseProofReason::SyncFailed),
        };
        if report.schema_floor.is_some() {
            return CurrentBaseProof::failure(CurrentBaseProofReason::SchemaFloor);
        }
        if self
            .conn
            .execute_batch("SAVEPOINT syncular_base_proof")
            .is_err()
        {
            return CurrentBaseProof::failure(CurrentBaseProofReason::SnapshotFailed);
        }
        let proof = (|| {
            let snapshot = snapshot_read_connection(
                &self.conn,
                &SnapshotReadRequest {
                    subscriptions: prepared
                        .subscriptions
                        .iter()
                        .map(|sub| sub.id.clone())
                        .collect(),
                    commit_ids: vec![prepared.client_commit_id.clone()],
                    ..Default::default()
                },
            )
            .map_err(|_| CurrentBaseProofReason::SnapshotFailed)?;
            let current = self
                .commit_outcome(&prepared.client_commit_id)
                .map_err(|_| CurrentBaseProofReason::SnapshotFailed)?;
            let unavailable = if report.revoked.is_empty() {
                CurrentBaseProofReason::OutcomeUnavailable
            } else {
                CurrentBaseProofReason::Revoked
            };
            let Some(outcome) = current else {
                return Err(unavailable);
            };
            if !matches!(
                snapshot.deliveries.first(),
                Some(CommitDelivery::Known { .. })
            ) || outcome.sequence != prepared.sequence
                || outcome.resolution != CommitOutcomeResolution::Active
                || !matches!(
                    outcome.status,
                    CommitOutcomeStatus::Conflict | CommitOutcomeStatus::Rejected
                )
            {
                return Err(unavailable);
            }
            let (Some(operations), Some(rows)) = (outcome.operations, outcome.retained_rows) else {
                return Err(unavailable);
            };
            if rows.is_empty() || operations.len() != rows.len() {
                return Err(unavailable);
            }
            let after: HashMap<&str, &Subscription> =
                self.subs.iter().map(|sub| (sub.id.as_str(), sub)).collect();
            let complete: HashSet<&str> = snapshot
                .subscriptions
                .iter()
                .filter_map(|sub| match sub {
                    SubscriptionCatchup::Known {
                        id,
                        bootstrap_complete: true,
                        ..
                    } => Some(id.as_str()),
                    _ => None,
                })
                .collect();
            let candidates: Vec<_> = prepared
                .subscriptions
                .iter()
                .filter_map(|before| {
                    let after = after.get(before.id.as_str())?;
                    if before.table != after.table
                        || before.params != after.params
                        || canonical_scope_json(&before.requested)
                            != canonical_scope_json(&after.requested)
                        || !complete.contains(before.id.as_str())
                    {
                        return None;
                    }
                    after
                        .effective
                        .as_ref()
                        .map(|scopes| (after.table.as_str(), scopes))
                })
                .collect();
            let covered = |table_name: &str, row: &Map<String, Value>| {
                let Some(table) = self.schema.table(table_name) else {
                    return false;
                };
                candidates.iter().any(|(candidate_table, scopes)| {
                    *candidate_table == table_name
                        && !scopes.is_empty()
                        && scopes.iter().all(|(variable, allowed)| {
                            table
                                .scope_column(variable)
                                .and_then(|column| match row.get(column) {
                                    Some(Value::String(value)) => Some(value.clone()),
                                    Some(Value::Bool(value)) => Some(value.to_string()),
                                    Some(Value::Number(value)) => value.as_f64().map(|number| {
                                        ryu_js::Buffer::new().format_finite(number).to_owned()
                                    }),
                                    _ => None,
                                })
                                .is_some_and(|value| !value.is_empty() && allowed.contains(&value))
                        })
                })
            };
            for row in &rows {
                let Some(base) = row.server_row.as_ref().or(row.local_row.as_ref()) else {
                    return Err(if report.revoked.is_empty() {
                        CurrentBaseProofReason::MissingCoverage
                    } else {
                        CurrentBaseProofReason::Revoked
                    });
                };
                if !covered(&row.table, base)
                    || row
                        .unique_conflicts
                        .iter()
                        .any(|conflict| !covered(&row.table, &conflict.server_row))
                {
                    return Err(if report.revoked.is_empty() {
                        CurrentBaseProofReason::MissingCoverage
                    } else {
                        CurrentBaseProofReason::Revoked
                    });
                }
            }
            Ok(rows)
        })();
        if self
            .conn
            .execute_batch("RELEASE syncular_base_proof")
            .is_err()
        {
            return CurrentBaseProof::failure(CurrentBaseProofReason::SnapshotFailed);
        }
        match proof {
            Ok(rows) => CurrentBaseProof {
                proven: true,
                rows: Some(rows),
                reason: None,
            },
            Err(reason) => CurrentBaseProof::failure(reason),
        }
    }

    pub fn prove_current_base(
        &mut self,
        transport: &mut dyn Transport,
        client_commit_id: &str,
        sequence: i64,
        max_rounds: Option<u32>,
    ) -> CurrentBaseProof {
        let prepared = match self.prepare_current_base(client_commit_id, sequence) {
            Ok(prepared) => prepared,
            Err(proof) => return proof,
        };
        let drive = self.sync_until_idle(transport, max_rounds);
        self.finish_current_base(prepared, drive)
    }

    pub fn commit_outcomes(&self, query: CommitOutcomeQuery) -> Result<Vec<CommitOutcome>, String> {
        if query.limit == Some(0) {
            return Err("sync.invalid_request: commit outcome limit must be positive".to_owned());
        }
        let mut sql = String::from(
            "SELECT seq, client_commit_id, status, recorded_at_ms, results_json, operations_json,
                    resolution, resolved_at_ms, replacement_client_commit_id
               FROM _syncular_commit_outcomes",
        );
        if query.active_only {
            sql.push_str(" WHERE resolution = 'active' AND status IN ('conflict', 'rejected')");
        }
        sql.push_str(" ORDER BY seq DESC");
        if let Some(limit) = query.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(StoredCommitOutcomeRow {
                    sequence: row.get(0)?,
                    client_commit_id: row.get(1)?,
                    status: row.get(2)?,
                    recorded_at_ms: row.get(3)?,
                    results_json: row.get(4)?,
                    operations_json: row.get(5)?,
                    resolution: row.get(6)?,
                    resolved_at_ms: row.get(7)?,
                    replacement_client_commit_id: row.get(8)?,
                })
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut outcomes = Vec::new();
        for row in rows {
            outcomes.push(self.attach_retained_rows(Self::outcome_from_row(
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
            )?)?);
        }
        Ok(outcomes)
    }

    fn prune_commit_outcomes(&self) -> Result<(), String> {
        #[cfg(test)]
        self.outcome_prune_count
            .set(self.outcome_prune_count.get() + 1);
        let max_entries = self.limits.outcome_retention_max_entries.unwrap_or(1_000);
        let count = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM _syncular_commit_outcomes",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
            as usize;
        let excess = count.saturating_sub(max_entries);
        if excess == 0 {
            return Ok(());
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq FROM _syncular_commit_outcomes
                  WHERE status IN ('applied', 'cached') OR resolution != 'active'
                  ORDER BY seq ASC LIMIT ?1",
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = stmt
            .query_map(rusqlite::params![excess as i64], |row| row.get::<_, i64>(0))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let sequences = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        drop(stmt);
        for sequence in sequences {
            self.conn
                .execute(
                    "DELETE FROM _syncular_commit_outcomes WHERE seq = ?1",
                    rusqlite::params![sequence],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(())
    }

    // -- driver surface ---------------------------------------------------------

    /// Register one subscription; see [`SyncClient::subscribe_many`].
    pub fn subscribe(
        &mut self,
        id: String,
        table: String,
        scopes: Vec<(String, Vec<String>)>,
        params: Option<String>,
    ) -> Result<(), String> {
        self.subscribe_many(vec![SubscriptionRequest {
            id,
            table,
            scopes,
            params,
        }])
    }

    /// Persist one registration or re-arm without raising sync-needed.
    /// Returns whether the registry changed.
    fn register_subscription(
        &mut self,
        id: String,
        table: String,
        scopes: Vec<(String, Vec<String>)>,
        params: Option<String>,
    ) -> Result<bool, String> {
        if self.schema.table(&table).is_none() {
            return Err(format!("unknown table {table:?}"));
        }
        let registered_at = self
            .subs
            .iter()
            .position(|subscription| subscription.id == id);
        if let Some(index) = registered_at {
            let existing = &self.subs[index];
            let same_intent = existing.table == table
                && canonical_scope_json(&existing.requested) == canonical_scope_json(&scopes)
                && existing.params == params;
            if !same_intent {
                return Err(
                    "client.subscription_intent_mismatch: the subscription id is already registered for a different table, scopes, or params"
                        .to_owned(),
                );
            }
            // §3.3: a revoked registration keeps its id and intent but no
            // progress. Subscribing again with the same intent re-arms it and
            // asks for a pull, which resolves its scopes from scratch. A
            // `failed` registration is a configuration error and stays put.
            if existing.state != SubState::Revoked {
                return Ok(false);
            }
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
        self.persist_sub(&sub)?;
        match registered_at {
            Some(index) => self.subs[index] = sub,
            None => self.subs.push(sub),
        }
        self.subscription_epoch = self.subscription_epoch.wrapping_add(1);
        Ok(true)
    }

    /// Register several subscriptions in one local transaction: the same
    /// rules as `subscribe` for each request, and one commit for all of them
    /// (on OPFS a commit costs milliseconds, so a cold start with hundreds of
    /// registrations pays it once). An error rolls back every registration
    /// of the call. A call that registers or re-arms anything raises
    /// sync-needed with an interactive intent (§4.1), as the TS client does;
    /// `set_window` (§4.8) registers through the same path without it and
    /// batches its own intent.
    pub fn subscribe_many(&mut self, requests: Vec<SubscriptionRequest>) -> Result<(), String> {
        let rollback = self.capture();
        self.begin_observation("syncular_subscribe")?;
        let mut registered_any = false;
        let registered = (|| {
            for request in requests {
                registered_any |= self.register_subscription(
                    request.id,
                    request.table,
                    request.scopes,
                    request.params,
                )?;
            }
            self.conn
                .execute_batch("RELEASE syncular_subscribe")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
        })();
        if let Err(error) = registered {
            self.rollback_observation("syncular_subscribe");
            self.restore(rollback);
            return Err(error);
        }
        if registered_any {
            self.set_sync_needed(true, true);
        }
        Ok(())
    }

    /// Remove a registration. Removing a registered id raises sync-needed with
    /// an interactive intent (§4.1), as the TS client does; an unknown id is a
    /// no-op.
    pub fn unsubscribe(&mut self, id: &str) -> Result<(), String> {
        if !self.subs.iter().any(|s| s.id == id) {
            return Ok(());
        }
        self.conn
            .execute(
                "DELETE FROM _syncular_subscriptions WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.cancel_sync_round();
        self.subscription_epoch = self.subscription_epoch.wrapping_add(1);
        self.subs.retain(|s| s.id != id);
        self.set_sync_needed(true, true);
        Ok(())
    }

    // -- windowed subscriptions (§4.8) ------------------------------------------

    /// §4.8: set the live window units for a base — a value-sharded family
    /// of subscriptions, one per unit. Added units get fresh subscriptions
    /// (image-lane bootstrap on the next sync); removed units are
    /// unsubscribed with their first eviction chunk in one transaction (E1–E4).
    /// Idempotent; re-entry cancels any deferred eviction.
    pub fn set_window(
        &mut self,
        base: &WindowBase,
        units: &[String],
    ) -> Result<CommandEffects, String> {
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
        self.begin_observation("syncular_window")?;
        let mut batch = ChangeAccumulator::default();
        let mut changed = false;

        let rollback = self.capture();
        let widened = (|| {
            // Widen: units wanted but not live → fresh subscription + registry row.
            for unit in units {
                if live.iter().any(|(u, _)| u == unit) {
                    continue;
                }
                let sub_id = derive_sub_id(base, unit);
                self.delete_pending_evict(&sub_id)?;
                self.insert_window_unit(&base_key, unit, &sub_id)?;
                self.register_subscription(
                    sub_id,
                    base.table.clone(),
                    unit_scopes(base, unit),
                    base.params.clone(),
                )?;
                batch.window(&base_key, &base.table, unit);
                changed = true;
            }

            self.finish_observation("syncular_window", batch)
        })();
        if let Err(error) = widened {
            self.rollback_observation("syncular_window");
            self.restore(rollback);
            return Err(error);
        }
        for (unit, sub_id) in live {
            if wanted.contains(&unit) {
                continue;
            }
            self.rebuild_overlay_if_dirty()?;
            let rollback = self.capture();
            self.begin_observation("syncular_window")?;
            let effective = self
                .subs
                .iter()
                .find(|sub| sub.id == sub_id)
                .and_then(|sub| sub.effective.clone())
                .unwrap_or_else(|| unit_scopes(base, &unit));
            let mut batch = ChangeAccumulator::default();
            self.record_scope_map(&mut batch, &base.table, &effective);
            batch.window(&base_key, &base.table, &unit);
            let remaining =
                self.evict_unit(&base_key, base, &unit, &sub_id)
                    .and_then(|remaining| {
                        self.finish_observation("syncular_window", batch)
                            .map(|()| remaining)
                    });
            let remaining = match remaining {
                Ok(remaining) => remaining,
                Err(error) => {
                    self.rollback_observation("syncular_window");
                    self.restore(rollback);
                    return Err(error);
                }
            };
            if remaining {
                self.drain_pending_evictions()?;
            }
            changed = true;
        }
        Ok(if changed {
            CommandEffects::interactive()
        } else {
            CommandEffects::none()
        })
    }

    /// §4.8 completeness oracle (I3): the windowed-in units for a base plus
    /// the subset still bootstrap-pending. Registration alone is not
    /// completeness — a unit is pending until its subscription completes a
    /// bootstrap round (cursor advances past -1 with no resume token held).
    pub fn window_state(&self, base: &WindowBase) -> WindowState {
        let mut units = Vec::new();
        let mut pending = Vec::new();
        for (unit, sub_id) in self.load_window_units(&window_base_key(base)) {
            let is_pending = match self.subs.iter().find(|s| s.id == sub_id) {
                Some(sub) => {
                    sub.state != SubState::Active || sub.cursor < 0 || sub.bootstrap_state.is_some()
                }
                None => true,
            };
            if is_pending {
                pending.push(unit.clone());
            }
            units.push(unit);
        }
        WindowState { units, pending }
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

    fn load_registered_window_units(&self) -> Vec<(String, String, String)> {
        let mut stmt = match self.conn.prepare(
            "SELECT windows.base, windows.unit, subscriptions.tbl
               FROM _syncular_windows AS windows
               JOIN _syncular_subscriptions AS subscriptions
                 ON subscriptions.id = windows.sub_id
               ORDER BY windows.base, windows.unit",
        ) {
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
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn window_unit_by_sub_id(&self, sub_id: &str) -> Option<(String, String)> {
        self.conn
            .query_row(
                "SELECT base, unit FROM _syncular_windows WHERE sub_id = ?1 LIMIT 1",
                rusqlite::params![sub_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    }

    fn insert_window_unit(&self, base_key: &str, unit: &str, sub_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO _syncular_windows(base, unit, sub_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![base_key, unit, sub_id],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn delete_window_unit(&self, base_key: &str, unit: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM _syncular_windows WHERE base = ?1 AND unit = ?2",
                rusqlite::params![base_key, unit],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// §4.8 E1–E4: evict one departing unit, fused with unsubscription.
    /// Deletes the unit's rows except those pinned by a pending outbox
    /// commit (E1); records a deferred eviction if any pin remains; discards
    /// the subscription's cursor/resume/effective-echo (E3) and version
    /// state with the rows (E2). Fail-closed: no local mapping ⇒ evict
    /// nothing.
    fn evict_unit(
        &mut self,
        base_key: &str,
        base: &WindowBase,
        unit: &str,
        sub_id: &str,
    ) -> Result<bool, String> {
        let effective = self
            .subs
            .iter()
            .find(|s| s.id == sub_id)
            .and_then(|s| s.effective.clone())
            .unwrap_or_else(|| unit_scopes(base, unit));
        let pinned = self.pinned_row_ids(&base.table);
        let owners = self.scope_owners(&base.table, sub_id);
        let (remaining, deferred) =
            self.evict_scope_rows(&base.table, &effective, &owners, &pinned)?;
        self.delete_window_unit(base_key, unit)?;
        self.conn
            .execute(
                "DELETE FROM _syncular_subscriptions WHERE id = ?1",
                [sub_id],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.subs.retain(|sub| sub.id != sub_id);
        // A prepared round still carries this unit; its SUB_END must not
        // complete a re-added unit that lost these rows (as `unsubscribe`).
        self.cancel_sync_round();
        self.subscription_epoch = self.subscription_epoch.wrapping_add(1);
        if deferred {
            self.save_pending_evict(sub_id, &base.table, &effective)?;
        } else {
            self.delete_pending_evict(sub_id)?;
        }
        Ok(remaining)
    }

    /// §4.8 E1: delete base rows owned by the effective scopes
    /// ([`local_scope_predicate`]) EXCEPT pinned primary keys. Returns (more
    /// unpinned work, any scoped rows remain). A missing scope-column mapping
    /// fails without deleting rows.
    fn evict_scope_rows(
        &self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
        owners: &[Vec<(String, Vec<String>)>],
        pinned: &std::collections::HashSet<String>,
    ) -> Result<(bool, bool), String> {
        let table = self.schema.table(table_name).ok_or("sync.unknown_table")?;
        let Some((scope, mut params)) = local_scope_predicate(table, effective, owners)
            .map_err(|()| "sync.scope_revoked".to_owned())?
        else {
            return Ok((false, false));
        };
        let scope_params = params.len();
        let pk = quote_ident(&table.primary_key);
        // Pinned ids are rowId text; the text form matches every key type.
        let predicate = if pinned.is_empty() {
            scope.clone()
        } else {
            params.extend(pinned.iter().cloned().map(SqlValue::Text));
            let holes = vec!["?"; pinned.len()].join(", ");
            format!("{scope} AND CAST({pk} AS TEXT) NOT IN ({holes})")
        };
        let base = base_table(table_name);
        let visible = visible_table(table_name);
        let mut ids: Vec<SqlValue> = Vec::new();
        for source in [&base, &visible] {
            let mut stmt = self
                .conn
                .prepare_cached(&format!(
                    "SELECT {pk} FROM {source} WHERE {predicate} LIMIT 1024"
                ))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            ids = stmt
                .query_map(rusqlite::params_from_iter(&params), |row| row.get(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
                .collect::<Result<_, _>>()
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            if !ids.is_empty() {
                break;
            }
        }
        if !ids.is_empty() {
            for id in &ids {
                self.conn
                    .execute(
                        "DELETE FROM _syncular_acked_rows WHERE tbl=?1 AND id=?2",
                        rusqlite::params![table_name, id],
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
            let holes = vec!["?"; ids.len()].join(", ");
            for source in [&base, &visible] {
                self.conn
                    .execute(
                        &format!("DELETE FROM {source} WHERE {pk} IN ({holes})"),
                        rusqlite::params_from_iter(&ids),
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
        }
        let mut remaining = false;
        let mut deferred = false;
        for source in [&base, &visible] {
            remaining |= self
                .conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {source} WHERE {predicate})"),
                    rusqlite::params_from_iter(&params),
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            deferred |= self
                .conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {source} WHERE {scope})"),
                    rusqlite::params_from_iter(&params[..scope_params]),
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok((remaining, deferred))
    }

    /// Resume committed eviction chunks, retaining outbox pins and their durable marker.
    fn drain_pending_evictions(&mut self) -> Result<(), String> {
        let pending = self.load_pending_evictions()?;
        if pending.is_empty() {
            return Ok(());
        }
        self.rebuild_overlay_if_dirty()?;
        for (sub_id, table_name, effective) in pending {
            if self.schema.table(&table_name).is_none() {
                self.delete_pending_evict(&sub_id)?;
                continue;
            }
            loop {
                std::thread::yield_now();
                self.begin_observation("syncular_evict")?;
                let pinned = self.pinned_row_ids(&table_name);
                let owners = self.scope_owners(&table_name, &sub_id);
                let result = self.evict_scope_rows(&table_name, &effective, &owners, &pinned);
                let (remaining, deferred) = match result {
                    Ok(result) => result,
                    Err(error) => {
                        self.rollback_observation("syncular_evict");
                        return Err(error);
                    }
                };
                if !deferred {
                    if let Err(error) = self.delete_pending_evict(&sub_id) {
                        self.rollback_observation("syncular_evict");
                        return Err(error);
                    }
                }
                let mut batch = ChangeAccumulator::default();
                self.record_scope_map(&mut batch, &table_name, &effective);
                if let Err(error) = self.finish_observation("syncular_evict", batch) {
                    self.rollback_observation("syncular_evict");
                    return Err(error);
                }
                if !remaining {
                    break;
                }
            }
        }
        Ok(())
    }

    /// §3.3/§4.8/§5.6 row ownership: the effective scopes of every other
    /// active subscription on `table` that holds rows (`cursor >= 0`). A
    /// scoped delete keeps every row one of them still covers.
    fn scope_owners(&self, table: &str, except_id: &str) -> Vec<Vec<(String, Vec<String>)>> {
        self.subs
            .iter()
            .filter(|sub| {
                sub.id != except_id
                    && sub.table == table
                    && sub.state == SubState::Active
                    && sub.cursor >= 0
            })
            .filter_map(|sub| sub.effective.clone())
            .collect()
    }

    /// §4.8 E1: primary keys of `table` referenced by a pending outbox
    /// commit — rows that MUST NOT be evicted until the commit drains.
    fn pinned_row_ids(&self, table: &str) -> std::collections::HashSet<String> {
        let mut pinned = std::collections::HashSet::new();
        for commit in self
            .outbox
            .iter()
            .map(|commit| &**commit)
            .chain(self.failed_commits.iter().map(|(commit, _)| commit))
        {
            for op in &commit.ops {
                if op.table == table {
                    pinned.insert(op.row_id.clone());
                }
            }
        }
        pinned
    }

    fn save_pending_evict(
        &self,
        sub_id: &str,
        table: &str,
        effective: &[(String, Vec<String>)],
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO _syncular_window_pending_evict(sub_id, tbl, effective_scopes) VALUES (?1, ?2, ?3)",
            rusqlite::params![sub_id, table, scope_map_to_json(effective).to_string()],
        ).map(|_| ()).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn delete_pending_evict(&self, sub_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM _syncular_window_pending_evict WHERE sub_id = ?1",
                rusqlite::params![sub_id],
            )
            .map(|_| ())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn load_pending_evictions(&self) -> Result<Vec<PendingEvict>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT sub_id, tbl, effective_scopes FROM _syncular_window_pending_evict")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        rows.map(|row| {
            let (sub_id, table, json) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let value: Value = serde_json::from_str(&json)
                .map_err(|_| "sync.local_corrupt: invalid pending eviction scopes".to_owned())?;
            let effective = json_to_scope_map(&value)
                .map_err(|_| "sync.local_corrupt: invalid pending eviction scopes".to_owned())?;
            Ok((sub_id, table, effective))
        })
        .collect()
    }

    /// Select failed-intent retention; reload durable retained aggregates.
    pub fn set_retain_failed_commits(&mut self, enabled: bool) -> Result<(), String> {
        self.retain_failed_commits = enabled;
        for (commit, _) in self.failed_commits.iter() {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }
        self.failed_commits = self.load_failed_commits()?.into();
        for (commit, _) in self.failed_commits.iter() {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }
        Ok(())
    }

    fn load_failed_commits(&self) -> Result<Vec<FailedCommit>, String> {
        let mut statement = self.conn.prepare("SELECT client_commit_id, operations_json, initial_json FROM _syncular_failed_commits ORDER BY seq")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        rows.map(|row| {
            let (id, operations, initial) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let operations: Vec<CommitOperation> =
                serde_json::from_str(&operations).map_err(|_| "sync.local_corrupt".to_owned())?;
            let initial =
                serde_json::from_str(&initial).map_err(|_| "sync.local_corrupt".to_owned())?;
            Ok((
                OutboxCommit {
                    client_commit_id: id,
                    ops: operations
                        .into_iter()
                        .map(|op| OutboxOp {
                            upsert: op.op == "upsert",
                            table: op.table,
                            row_id: op.row_id,
                            base_version: op.base_version,
                            values: op.values,
                            insert: op.insert,
                        })
                        .collect(),
                },
                initial,
            ))
        })
        .collect()
    }

    fn retain_failed_commit(&mut self, id: &str, operations: &[OutboxOp]) -> Result<(), String> {
        let mut initial = Map::new();
        for operation in operations {
            // A table the current schema removed has no rows to retain.
            let Some(table) = self.schema.table(&operation.table) else {
                continue;
            };
            let initial_row = match self.stored_row(table, &operation.row_id, true)? {
                Some(row) => Some(row),
                None => self.visible_row(table, &operation.row_id)?,
            };
            if let Some((values, _)) = initial_row {
                let mut intended: Map<String, Value> = table
                    .columns
                    .iter()
                    .zip(values.iter())
                    .map(|(column, value)| (column.name.clone(), column_value_to_json(value)))
                    .collect();
                if let Some(patch) = &operation.values {
                    intended.extend(patch.clone());
                }
                initial.insert(
                    serde_json::to_string(&(operation.table.clone(), operation.row_id.clone()))
                        .map_err(|_| "sync.local_corrupt".to_owned())?,
                    Value::Object(intended),
                );
            }
        }
        self.conn.execute("INSERT INTO _syncular_failed_commits(client_commit_id, operations_json, initial_json) VALUES (?1, ?2, ?3)", rusqlite::params![id,
            serde_json::to_string(&operations.iter().map(CommitOperation::from).collect::<Vec<_>>()).map_err(|_| "sync.local_corrupt".to_owned())?,
            serde_json::to_string(&initial).map_err(|_| "sync.local_corrupt".to_owned())?])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.failed_commits.push((
            OutboxCommit {
                client_commit_id: id.to_owned(),
                ops: operations.to_vec(),
            },
            initial,
        ));
        Ok(())
    }

    fn drop_failed_commits(
        &mut self,
        matches: impl Fn(&str, &Map<String, Value>) -> bool,
    ) -> Result<Vec<OutboxCommit>, String> {
        let mut doomed = self.drop_acknowledged_rows(&matches)?;
        for (commit, initial) in self.failed_commits.iter() {
            for operation in &commit.ops {
                let key =
                    serde_json::to_string(&(operation.table.clone(), operation.row_id.clone()))
                        .map_err(|_| "sync.local_corrupt".to_owned())?;
                if initial
                    .get(&key)
                    .and_then(Value::as_object)
                    .is_some_and(|values| matches(&operation.table, values))
                {
                    doomed.push(commit.clone());
                    break;
                }
            }
        }
        for commit in &doomed {
            self.conn
                .execute(
                    "DELETE FROM _syncular_failed_commits WHERE client_commit_id = ?1",
                    rusqlite::params![commit.client_commit_id],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        for commit in &doomed {
            self.conn.execute("UPDATE _syncular_commit_outcomes SET operations_json = NULL, results_json = '[]' WHERE client_commit_id = ?1", rusqlite::params![commit.client_commit_id]).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        self.conflicts.retain(|record| {
            !doomed
                .iter()
                .any(|commit| commit.client_commit_id == record.client_commit_id)
        });
        self.rejections.retain(|record| {
            !doomed
                .iter()
                .any(|commit| commit.client_commit_id == record.client_commit_id)
        });
        self.failed_commits.retain(|(commit, _)| {
            !doomed
                .iter()
                .any(|dropped| dropped.client_commit_id == commit.client_commit_id)
        });
        for commit in &doomed {
            for operation in &commit.ops {
                self.overlay_dirty.table(&operation.table);
            }
        }
        Ok(doomed)
    }

    /// Record one commit of local mutations. The returned commit ID is the
    /// §2.3 idempotency key. Failures are structured so callers read
    /// `code`/`message`/`details` instead of parsing a string prefix.
    pub fn mutate(&mut self, mutations: Vec<Mutation>) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            if mutations.is_empty() {
                return Err(
                    "sync.invalid_request: a commit must contain at least one operation (§6.1)"
                        .to_owned(),
                );
            }
            let mut ops = Vec::with_capacity(mutations.len());
            for mutation in mutations {
                match mutation {
                    Mutation::Patch {
                        table,
                        values,
                        base_version,
                    } => {
                        let schema_table = self
                            .schema
                            .table(&table)
                            .ok_or_else(|| "sync.unknown_table".to_owned())?;
                        let values = normalize_values_casing(schema_table, values)?;
                        let row_id = render_row_id_json(values.get(&schema_table.primary_key))?;
                        ops.push(self.prepare_patch(&table, &row_id, values, base_version)?);
                    }
                    Mutation::Upsert {
                        table,
                        values,
                        base_version,
                    } => {
                        let schema_table = self.schema.table(&table).ok_or_else(|| {
                            format!("sync.unknown_table: unknown table {table:?}")
                        })?;
                        // §5: value keys are accepted in snake_case AND the
                        // generated row types' camelCase; normalize to SQL truth
                        // before the pk lookup / codec see them.
                        let values = normalize_values_casing(schema_table, values)?;
                        let row_id = render_row_id_json(values.get(&schema_table.primary_key))?;
                        // §6.7 `mutate` marks every column present: fill missing
                        // nullable columns with NULL before the payload is built.
                        let values = full_row_values(schema_table, values)?;
                        // §5.11: validate the payload encodes with the current
                        // codec. A key-selection or unknown-key failure is a
                        // durable rejection at the push seam (§10.3), never an
                        // author-time error. Full-row `mutate` presents every
                        // column, so no stored fallback is needed.
                        self.validate_author_encode(schema_table, &row_id, &values)?;
                        // §7.1 insert intent: the row is absent from the
                        // visible replica at call time, before this batch
                        // applies anything.
                        let insert = !self.visible_row_exists(schema_table, &row_id)?;
                        ops.push(OutboxOp {
                            upsert: true,
                            table,
                            row_id,
                            base_version,
                            values: Some(values),
                            insert,
                        });
                    }
                    Mutation::Delete {
                        table,
                        row_id,
                        base_version,
                    } => {
                        if self.schema.table(&table).is_none() {
                            return Err(format!("sync.unknown_table: unknown table {table:?}"));
                        }
                        // §2.4: the server rejects a rowId holding U+0000.
                        if row_id.contains('\0') {
                            return Err(
                                "sync.invalid_request: rowId holds U+0000 (§2.4)".to_owned()
                            );
                        }
                        ops.push(OutboxOp {
                            upsert: false,
                            table,
                            row_id,
                            base_version,
                            values: None,
                            insert: false,
                        });
                    }
                }
            }
            self.record_outbox_commit(ops)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// Scope the retained `storage_failure` diagnostic to this call so an
    /// earlier operation's failure cannot classify a new one, and surface the
    /// call's own classified failure with its details. A fresh classified
    /// failure replaces the retained diagnostic; otherwise the earlier one is
    /// kept for the next sync.
    fn finish_authoring(
        &self,
        prior: Option<QueryReadFailure>,
        outcome: Result<String, String>,
    ) -> Result<String, ClientError> {
        let fresh = self.storage_failure.borrow_mut().take();
        *self.storage_failure.borrow_mut() = fresh.clone().or(prior);
        match outcome {
            Ok(id) => Ok(id),
            Err(message) => Err(fresh
                .map(ClientError::from)
                .unwrap_or_else(|| ClientError::from(message))),
        }
    }

    fn record_outbox_commit(&mut self, ops: Vec<OutboxOp>) -> Result<String, String> {
        let commit = OutboxCommit {
            client_commit_id: uuid::Uuid::new_v4().to_string(),
            ops,
        };
        self.begin_observation("syncular_mutation")?;
        let mut batch = ChangeAccumulator::default();
        for op in &commit.ops {
            let mut precise = self.record_row_scopes(&mut batch, &op.table, &op.row_id, false);
            if let Some(values) = &op.values {
                if let Some(table) = self.schema.table(&op.table) {
                    for scope in &table.scope_variables {
                        if let Some(Value::String(value)) = values.get(&scope.column) {
                            batch.scope(&op.table, format!("{}:{value}", scope.prefix));
                            precise = true;
                        }
                    }
                }
            }
            if !precise {
                batch.table(&op.table);
            }
        }
        if let Err(error) = self.persist_outbox_insert(&commit) {
            self.rollback_observation("syncular_mutation");
            return Err(error);
        }
        // A clean overlay contains the FIFO fold of every previous commit, so
        // the new commit applies over it. §7.1: an operation that does not
        // apply (a secondary unique collision) fails the whole commit; the
        // savepoint rollback removes the outbox entry and every visible write.
        // The append undoes itself: a rollback capture would copy the outbox.
        let was_dirty = self.overlay_dirty.snapshot();
        let id = commit.client_commit_id.clone();
        let appended = self.rebuild_overlay_if_dirty().and_then(|()| {
            commit
                .ops
                .iter()
                .try_for_each(|op| self.apply_outbox_op(op))?;
            self.outbox.push(Arc::new(commit));
            batch.status = true;
            self.finish_observation("syncular_mutation", batch)
                .inspect_err(|_| drop(self.outbox.pop()))
        });
        if let Err(error) = appended {
            self.rollback_observation("syncular_mutation");
            self.overlay_dirty.restore(was_dirty);
            return Err(error);
        }
        Ok(id)
    }

    /// Record one §6.1 sparse upsert: the primary key plus the supplied
    /// non-scope columns are present; every other column is absent and stays
    /// untouched on the server and in the local overlay. An absent local base
    /// refuses the whole batch with sync.row_missing before enqueueing (§7.1).
    /// Failures are structured so callers read `code`/`message`/`details`.
    pub fn patch(
        &mut self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = self.perform_patch(table, row_id, partial, base_version);
        self.finish_authoring(prior, outcome)
    }

    /// The unscoped patch body. Public authoring entry points scope
    /// `storage_failure` around the whole operation, including any pre-read.
    fn perform_patch(
        &mut self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<String, String> {
        let operation = self.prepare_patch(table, row_id, partial, base_version)?;
        self.record_outbox_commit(vec![operation])
    }

    fn prepare_patch(
        &self,
        table: &str,
        row_id: &str,
        partial: Map<String, Value>,
        base_version: Option<i64>,
    ) -> Result<OutboxOp, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("sync.unknown_table: unknown table {table:?}"))?;
        let partial = normalize_values_casing(schema_table, partial)?;
        if let Some(pk) = partial.get(&schema_table.primary_key) {
            if render_row_id_json(Some(pk)).ok().as_deref() != Some(row_id) {
                return Err(format!(
                    "sync.invalid_request: table {table:?}: patch cannot change the primary key"
                ));
            }
        }
        if !self.visible_row_exists(schema_table, row_id)? {
            return Err("sync.row_missing: a sparse patch requires a local row".to_owned());
        }
        // §3.4 rule 5 / §6.2: scope columns are immutable on update. The
        // server accepts a present scope column whose value equals the
        // stored row and applies it as a no-op, so a decoded envelope
        // round-trips. The local row is the only value the client can prove
        // equality against; when the row is absent locally the client cannot
        // prove equality against the server's stored row and fails closed.
        // A primary key that is also a scope column needs no stored-row
        // read: the primary key in a sparse payload is by construction the
        // row id being patched (§6.1), so its value is proven equal already.
        for scope in &schema_table.scope_variables {
            if !partial.contains_key(&scope.column) || scope.column == schema_table.primary_key {
                continue;
            }
            let Some(column) = schema_table
                .columns
                .iter()
                .find(|column| column.name == scope.column)
            else {
                continue;
            };
            let stored = self
                .conn
                .query_row(
                    &format!(
                        "SELECT {} FROM {} WHERE {}",
                        quote_ident(&scope.column),
                        visible_table(&schema_table.name),
                        row_id_predicate(schema_table)
                    ),
                    rusqlite::params![row_id],
                    |row| Ok(sql_ref_to_json(column, row.get_ref(0)?)),
                )
                .optional()
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            // Decode the supplied value through the same column-type path the
            // rest of the patch encoding uses, so a value that only equals
            // the stored one in another number representation still compares
            // equal.
            let incoming = json_to_column_value(column, partial.get(&scope.column))
                .ok()
                .map(|value| column_value_to_json(&value));
            // A stored blob never equals a patch value, matching the server's
            // scope-column comparison (§3.4): bytes are unstorable as scope
            // values.
            let equal = stored.as_ref().is_some_and(|stored| {
                stored.get("$bytes").is_none() && incoming.as_ref() == Some(stored)
            });
            if !equal {
                return Err(format!(
                    "sync.invalid_request: table {table:?}: patch cannot write scope column {:?} (§3.4)",
                    scope.column
                ));
            }
        }
        let mut values = partial;
        // Presence-set semantics: a proven-equal scope column is dropped, so
        // the patch leaves the stored value untouched (§6.2).
        for scope in &schema_table.scope_variables {
            values.remove(&scope.column);
        }
        let pk_value = match schema_table.columns[schema_table.pk_index].ty {
            // §2.4: the rowId of an integer key is its canonical decimal form.
            ColumnType::Integer => match row_id.parse::<i64>() {
                Ok(v)
                    if v.to_string() == row_id
                        && (-ssp2::primitives::I64_SAFE_MAX..=ssp2::primitives::I64_SAFE_MAX)
                            .contains(&v) =>
                {
                    Value::from(v)
                }
                _ => {
                    return Err(format!(
                    "sync.invalid_request: table {table:?}: invalid integer primary key {row_id:?}"
                ))
                }
            },
            ColumnType::Boolean => match row_id {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => {
                    return Err(format!(
                    "sync.invalid_request: table {table:?}: invalid boolean primary key {row_id:?}"
                ))
                }
            },
            _ => Value::from(row_id.to_owned()),
        };
        values.insert(schema_table.primary_key.clone(), pk_value);
        // §5.11: structural validation only; an absent key-id selector is
        // resolved at the push seam from the stored local row, and a
        // key-selection or unknown-key failure becomes a durable
        // `client.encrypt_failed` rejection there (§10.3), never an
        // author-time error.
        self.validate_author_encode(schema_table, row_id, &values)?;
        Ok(OutboxOp {
            upsert: true,
            table: table.to_owned(),
            row_id: row_id.to_owned(),
            base_version,
            values: Some(values),
            insert: false,
        })
    }

    /// §5.11 key-id fallback: the stored local row's selector value as a
    /// positional row (only the selector slot filled). Returns None when no
    /// selector is configured, the row is locally absent, or the stored
    /// value is not a usable key id. A failed storage read is an error.
    fn stored_key_fallback(
        &self,
        table: &TableSchema,
        row_id: &str,
    ) -> Result<Option<Row>, String> {
        let Some(selector) = self.encryption.key_id_columns.get(&table.name) else {
            return Ok(None);
        };
        let Some(index) = table
            .columns
            .iter()
            .position(|column| &column.name == selector)
        else {
            return Ok(None);
        };
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            quote_ident(selector),
            visible_table(&table.name),
            row_id_predicate(table)
        );
        let key = self
            .conn
            .query_row(&sql, rusqlite::params![row_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
            .flatten()
            .filter(|key| !key.is_empty());
        let Some(key) = key else {
            return Ok(None);
        };
        let mut fallback: Row = vec![None; table.columns.len()];
        fallback[index] = Some(ColumnValue::String(key));
        Ok(Some(fallback))
    }

    /// §5.11/§10.3 author-time encode check: a structural failure (a
    /// non-nullable NULL, a value the codec rejects) is an author-time
    /// error; a key-selection or unknown-key failure is deferred to the push
    /// seam, where it becomes a durable `client.encrypt_failed` rejection.
    fn validate_author_encode(
        &self,
        table: &TableSchema,
        row_id: &str,
        values: &Map<String, Value>,
    ) -> Result<(), String> {
        match encode_sparse_row_json(table, row_id, values, &self.encryption, None) {
            Err(error) if error.starts_with(ENCRYPT_FAILED_CODE) => Ok(()),
            result => result.map(|_| ()),
        }
    }

    /// §5.11/§10.3: drop every pending commit whose push encode fails with
    /// `client.encrypt_failed` (an unresolvable key id or an unknown key) and
    /// raise one durable rejection per commit. `sync()` never aborts for an
    /// encode failure. Mirrors §7.4.4's `drop_incompatible_outbox`, including
    /// undoing the dropped commit's purely-optimistic rows.
    /// §7.1/§7.4.4: drop pending commits whose values the current codec refuses
    /// (an envelope or a type an earlier version accepted). `with_encryption`
    /// additionally drops commits whose §5.11 encryption cannot resolve a key;
    /// the startup boundary leaves those to the send seam, where hosts configure
    /// keys after open.
    /// Recovery runs as one observation. An enclosing observation (the guarded
    /// schema reset) passes its `batch`, so the rejection, outcome, and table
    /// domains join that change event instead of publishing a second one.
    fn drop_unencodable_outbox(
        &mut self,
        with_encryption: bool,
        batch: Option<&mut ChangeAccumulator>,
    ) -> Result<bool, String> {
        let mut failures = Vec::new();
        for commit in self.outbox.iter() {
            for op in &commit.ops {
                let Some(table) = self.schema.table(&op.table).filter(|_| op.upsert) else {
                    continue;
                };
                // An insert lacking a non-nullable column is left to
                // `drop_incompatible_outbox` (§7.4.4).
                let Some(values) = op.presented_values(table) else {
                    continue;
                };
                let fallback = self.stored_key_fallback(table, &op.row_id)?;
                let failure = match encode_sparse_row_json(
                    table,
                    &op.row_id,
                    &values,
                    &self.encryption,
                    fallback.as_ref(),
                ) {
                    Err(error) if error.starts_with(ENCRYPT_FAILED_CODE) => {
                        with_encryption.then_some((error, ENCRYPT_FAILED_CODE))
                    }
                    // §7.1/§7.4.4: a value the current codec refuses was
                    // persisted by a version that accepted it; it leaves
                    // through the incompatible-outbox path, so the FIFO
                    // queue never wedges.
                    Err(error) if error.starts_with(INVALID_REQUEST_CODE) => Some((
                        LEGACY_VALUE_REFUSAL_MESSAGE.to_owned(),
                        OUTBOX_INCOMPATIBLE_CODE,
                    )),
                    _ => None,
                };
                if let Some((error, code)) = failure {
                    failures.push((commit.clone(), error, code));
                    break;
                }
            }
        }
        if failures.is_empty() {
            return Ok(false);
        }
        // §7.4.4: one observation covers the durable outcome writes, the outbox
        // removal, the in-memory drop, and the overlay rebuild, so a storage fault
        // leaves the replica and the client unchanged, a successful recovery
        // publishes one batch with the rejection, outcome, and table domains, and
        // an ordinary open with nothing to recover publishes nothing.
        let rollback = self.capture();
        let owns_observation = batch.is_none();
        let owns_transaction = self.conn.is_autocommit();
        let mut domains = ChangeAccumulator::default();
        if owns_observation {
            self.begin_observation("syncular_value_recovery")?;
        }
        let dropped = (|| -> Result<(), String> {
            for (commit, message, code) in failures {
                if self.retain_failed_commits && code == ENCRYPT_FAILED_CODE {
                    self.retain_failed_commit(&commit.client_commit_id, &commit.ops)?;
                }
                let representable = commit.ops.iter().all(Self::outbox_op_is_journalable);
                let rejection = RejectionRecord {
                    client_commit_id: commit.client_commit_id.clone(),
                    op_index: 0,
                    code: code.to_owned(),
                    message,
                    retryable: false,
                    details: (code == OUTBOX_INCOMPATIBLE_CODE).then(|| RejectionDetails {
                        field_paths: None,
                        reason: Some(INVALID_STORED_VALUES_REASON.to_owned()),
                        required_action: None,
                        references: None,
                    }),
                    operation: representable
                        .then(|| commit.ops.first())
                        .flatten()
                        .map(CommitOperation::from),
                };
                self.persist_commit_outcome(
                    &commit.client_commit_id,
                    CommitOutcomeStatus::Rejected,
                    &[CommitOperationOutcome::Error {
                        rejection: rejection.clone(),
                    }],
                    representable.then_some(commit.ops.as_slice()),
                )?;
                self.delete_outbox_persisted(&commit.client_commit_id)?;
                self.outbox
                    .retain(|candidate| candidate.client_commit_id != commit.client_commit_id);
                self.rejections.push(rejection);
                for operation in &commit.ops {
                    domains.table(operation.table.as_str());
                }
            }
            domains.status = true;
            domains.rejections = true;
            domains.outcomes = true;
            self.prune_commit_outcomes()?;
            // The visible projection is re-derived from the surviving base + outbox.
            self.overlay_dirty.set(true);
            self.rebuild_overlay()?;
            Ok(())
        })();
        let result = match batch {
            Some(batch) => {
                if dropped.is_ok() {
                    for table in domains.tables.keys() {
                        batch.table(table.as_str());
                    }
                    batch.status |= domains.status;
                    batch.rejections |= domains.rejections;
                    batch.outcomes |= domains.outcomes;
                }
                dropped
            }
            None => {
                dropped.and_then(|()| self.finish_observation("syncular_value_recovery", domains))
            }
        };
        if let Err(error) = result {
            if owns_observation {
                if owns_transaction {
                    if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                        let mut failure = self.storage_failure.borrow_mut();
                        let failure =
                            failure.get_or_insert_with(|| QueryReadFailure::from(error.clone()));
                        failure.rollback_failure = Some(Box::new(QueryReadFailure::from(rollback)));
                    }
                } else {
                    self.rollback_observation("syncular_value_recovery");
                }
            }
            self.restore(rollback);
            return Err(error);
        }
        Ok(true)
    }

    pub fn pending_commit_ids(&self) -> Vec<String> {
        self.outbox
            .iter()
            .map(|c| c.client_commit_id.clone())
            .collect()
    }

    /// §6.1: the sparse push payload bytes of every pending upsert operation,
    /// FIFO — exactly what the next push round would put on the wire. Used by
    /// conformance B.21(h) to pin cross-core byte identity.
    pub fn pending_payloads(&self) -> Result<Vec<Vec<u8>>, String> {
        let mut payloads = Vec::new();
        for commit in self.outbox.iter() {
            for op in &commit.ops {
                let Some(table) = self.schema.table(&op.table).filter(|_| op.upsert) else {
                    continue;
                };
                let Some(values) = op.presented_values(table) else {
                    continue;
                };
                let fallback = self.stored_key_fallback(table, &op.row_id)?;
                if let Ok(payload) = encode_sparse_row_json(
                    table,
                    &op.row_id,
                    &values,
                    &self.encryption,
                    fallback.as_ref(),
                ) {
                    payloads.push(payload);
                }
            }
        }
        Ok(payloads)
    }

    pub fn conflicts(&self) -> &[ConflictRecord] {
        &self.conflicts
    }

    pub fn rejections(&self) -> &[RejectionRecord] {
        &self.rejections
    }

    pub fn resolve_commit_outcome(
        &mut self,
        input: ResolveCommitOutcomeInput,
    ) -> Result<CommitOutcome, String> {
        let current = self
            .commit_outcome(&input.client_commit_id)?
            .ok_or_else(|| {
                format!(
                    "sync.outcome_not_found: no durable outcome exists for {:?}",
                    input.client_commit_id
                )
            })?;
        if current.resolution != CommitOutcomeResolution::Active {
            return Ok(current);
        }
        if input.resolution == CommitOutcomeResolution::Active {
            return Err("sync.invalid_request: resolution must leave active state".to_owned());
        }
        match input.resolution {
            CommitOutcomeResolution::Superseded => {
                let replacement = input
                    .replacement_client_commit_id
                    .as_deref()
                    .filter(|value| !value.is_empty() && *value != input.client_commit_id)
                    .ok_or_else(|| {
                        "sync.invalid_request: superseded outcomes require a distinct replacementClientCommitId"
                            .to_owned()
                    })?;
                let _ = replacement;
            }
            _ if input.replacement_client_commit_id.is_some() => {
                return Err(
                    "sync.invalid_request: replacementClientCommitId is valid only for superseded outcomes"
                        .to_owned(),
                );
            }
            _ => {}
        }
        let allowed = match current.status {
            CommitOutcomeStatus::Conflict => matches!(
                input.resolution,
                CommitOutcomeResolution::ResolvedKeepServer | CommitOutcomeResolution::Superseded
            ),
            CommitOutcomeStatus::Rejected => {
                matches!(
                    input.resolution,
                    CommitOutcomeResolution::Superseded
                        | CommitOutcomeResolution::ResolvedKeepServer
                )
            }
            CommitOutcomeStatus::Applied | CommitOutcomeStatus::Cached => {
                input.resolution == CommitOutcomeResolution::Dismissed
            }
        };
        if !allowed {
            return Err(format!(
                "sync.invalid_request: resolution {:?} is invalid for {:?} outcome",
                input.resolution, current.status
            ));
        }

        let rollback = self.capture();
        self.begin_observation("syncular_outcome_resolution")?;
        let result = (|| {
            self.conn
                .execute(
                    "UPDATE _syncular_commit_outcomes
                        SET resolution = ?1, resolved_at_ms = ?2,
                            replacement_client_commit_id = ?3
                      WHERE client_commit_id = ?4 AND resolution = 'active'",
                    rusqlite::params![
                        Self::outcome_resolution_name(input.resolution),
                        self.clock_now_ms(),
                        input.replacement_client_commit_id,
                        input.client_commit_id
                    ],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let resolved = self
                .commit_outcome(&current.client_commit_id)?
                .ok_or_else(|| "sync.outcome_not_found: outcome disappeared".to_owned())?;
            self.conn
                .execute(
                    "DELETE FROM _syncular_failed_commits WHERE client_commit_id = ?1",
                    rusqlite::params![input.client_commit_id],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            for (commit, _) in self.failed_commits.iter() {
                if commit.client_commit_id == input.client_commit_id {
                    for operation in &commit.ops {
                        self.overlay_dirty.table(&operation.table);
                    }
                }
            }
            self.failed_commits
                .retain(|(commit, _)| commit.client_commit_id != input.client_commit_id);
            self.prune_commit_outcomes()?;
            Ok(resolved)
        })();
        let resolved = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                self.rollback_observation("syncular_outcome_resolution");
                self.restore(rollback);
                return Err(error);
            }
        };
        self.conflicts
            .retain(|record| record.client_commit_id != current.client_commit_id);
        self.rejections
            .retain(|record| record.client_commit_id != current.client_commit_id);
        let mut batch = ChangeAccumulator {
            conflicts: current.status == CommitOutcomeStatus::Conflict,
            rejections: current.status == CommitOutcomeStatus::Rejected,
            outcomes: true,
            ..ChangeAccumulator::default()
        };
        if let Some(operations) = &current.operations {
            for operation in operations {
                batch.table(&operation.table);
            }
        }
        if let Err(error) = self
            .rebuild_overlay_if_dirty()
            .and_then(|()| self.finish_observation("syncular_outcome_resolution", batch))
        {
            self.rollback_observation("syncular_outcome_resolution");
            self.restore(rollback);
            return Err(error);
        }
        Ok(resolved)
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
    fn record_lease_error(&mut self, code: &str) -> Result<(), String> {
        if code != "sync.auth_lease_required" && code != "sync.auth_lease_revoked" {
            return Ok(());
        }
        let mut next = self.lease_state.clone().unwrap_or_default();
        next.error_code = Some(code.to_owned());
        self.set_lease_state(Some(next))
    }

    fn set_lease_state(&mut self, next: Option<LeaseState>) -> Result<(), String> {
        if self.lease_state == next {
            return Ok(());
        }
        self.begin_observation("syncular_lease")?;
        let rollback = self.capture();
        self.lease_state = next;
        let persisted = match &self.lease_state {
            Some(lease) => serde_json::to_string(lease)
                .map_err(|error| error.to_string())
                .and_then(|json| self.set_meta(LEASE_STATE_KEY, &json)),
            None => self.delete_meta(LEASE_STATE_KEY),
        };
        let batch = ChangeAccumulator {
            status: true,
            ..ChangeAccumulator::default()
        };
        if let Err(error) =
            persisted.and_then(|()| self.finish_observation("syncular_lease", batch))
        {
            self.rollback_observation("syncular_lease");
            self.restore(rollback);
            return Err(error);
        }
        Ok(())
    }

    fn set_schema_floor(&mut self, next: Option<SchemaFloor>) -> Result<(), String> {
        if self.schema_floor == next {
            return Ok(());
        }
        self.begin_observation("syncular_schema_floor")?;
        let rollback = self.capture();
        self.stopped = next.is_some();
        self.schema_floor = next;
        let persisted = match &self.schema_floor {
            Some(floor) => serde_json::to_string(floor)
                .map_err(|error| error.to_string())
                .and_then(|json| self.set_meta(SCHEMA_FLOOR_KEY, &json)),
            None => self.delete_meta(SCHEMA_FLOOR_KEY),
        };
        let batch = ChangeAccumulator {
            status: true,
            ..ChangeAccumulator::default()
        };
        if let Err(error) =
            persisted.and_then(|()| self.finish_observation("syncular_schema_floor", batch))
        {
            self.rollback_observation("syncular_schema_floor");
            self.restore(rollback);
            return Err(error);
        }
        Ok(())
    }

    fn set_upgrading(&mut self, value: bool) {
        if self.upgrading == value {
            return;
        }
        if self.begin_observation("syncular_upgrading").is_err() {
            return;
        }
        self.upgrading = value;
        let batch = ChangeAccumulator {
            status: true,
            ..ChangeAccumulator::default()
        };
        if self
            .finish_observation("syncular_upgrading", batch)
            .is_err()
        {
            self.rollback_observation("syncular_upgrading");
        }
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
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut rows = stmt
            .query([])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut out = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
        {
            let mut values = Map::new();
            for (i, column) in schema_table.columns.iter().enumerate() {
                let value = row
                    .get_ref(i)
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                values.insert(column.name.clone(), sql_ref_to_json(column, value));
            }
            let version: i64 = row
                .get(schema_table.columns.len())
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
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

    // -- §5.10.5 native CRDT (the `crdt-yjs` feature) --------------------------
    //
    // The Rust face of the §5.10.4 client model: a local crdt edit loads the
    // current stored (server-merged ⊕ pending-overlay) column bytes, applies
    // the op with `yrs`, re-encodes the whole doc state, and records a
    // baseVersion-less sparse upsert carrying only the primary key and the
    // crdt column (§5.10.3, §6.6). No local merge — merging is server-side;
    // the overlay re-materializes the edit immediately (optimistic apply,
    // §7.1) and the server-merged bytes arrive on the next pull, idempotently.
    // Byte-compatible with `@syncular/crdt-yjs`.

    /// The current stored value of a `crdt` column for one row — the visible
    /// (optimistic) bytes, or `None` when the row is absent or the column is
    /// NULL (the empty document, §5.10.1). Errors if the column is not a
    /// `crdt` column (guards the app against a typo'd column name).
    #[cfg(feature = "crdt-yjs")]
    fn crdt_column_bytes(
        &self,
        table: &str,
        row_id: &str,
        column: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let schema_table = self
            .schema
            .table(table)
            .ok_or_else(|| format!("unknown table {table:?}"))?;
        let col = schema_table
            .columns
            .iter()
            .find(|c| c.name == column)
            .ok_or_else(|| format!("table {table:?} has no column {column:?}"))?;
        if col.ty != ColumnType::Crdt {
            return Err(format!("column {column:?} is not a crdt column (§5.10.1)"));
        }
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            quote_ident(column),
            visible_table(table),
            row_id_predicate(schema_table)
        );
        let bytes: Option<Vec<u8>> = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
            .query_row(rusqlite::params![row_id], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => "no such row".to_owned(),
                other => Self::sqlite_failure(&self.storage_failure, other),
            })?;
        Ok(bytes)
    }

    /// §5.10.4 materialize: the collaborative text of a `crdt` column, decoded
    /// from the stored bytes with `yrs` — `YjsColumn.text(name).toString()`.
    /// An absent row / NULL column is the empty document (empty string).
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_text(
        &self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
    ) -> Result<String, String> {
        let bytes = self
            .crdt_column_bytes(table, row_id, column)?
            .unwrap_or_default();
        crate::crdt::text(&bytes, name)
    }

    /// §5.10.4 push-an-update: apply a text insert to a `crdt` column and
    /// record the resulting crdt-only sparse operation. Returns the enqueued
    /// `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_insert_text(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
        index: u32,
        value: &str,
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            let current = self
                .crdt_column_bytes(table, row_id, column)?
                .unwrap_or_default();
            let update = crate::crdt::insert_text(&current, name, index, value)?;
            self.perform_crdt_push_update(table, row_id, column, &update)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// §5.10.4 push-an-update: apply a text delete to a `crdt` column and
    /// record the resulting crdt-only sparse operation. Returns the enqueued
    /// `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_delete_text(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        name: &str,
        index: u32,
        len: u32,
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            let current = self
                .crdt_column_bytes(table, row_id, column)?
                .unwrap_or_default();
            let update = crate::crdt::delete_text(&current, name, index, len)?;
            self.perform_crdt_push_update(table, row_id, column, &update)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// §5.10.4 generic escape hatch: apply an arbitrary Yjs update onto a
    /// `crdt` column's current state and record the resulting crdt-only sparse
    /// operation. The app authored the update with its own `yrs` model.
    /// Returns the enqueued `clientCommitId`.
    #[cfg(feature = "crdt-yjs")]
    pub fn crdt_apply_update(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        update: &[u8],
    ) -> Result<String, ClientError> {
        let prior = self.storage_failure.borrow_mut().take();
        let outcome = (|| -> Result<String, String> {
            let current = self
                .crdt_column_bytes(table, row_id, column)?
                .unwrap_or_default();
            let next = crate::crdt::apply_update(&current, update)?;
            self.perform_crdt_push_update(table, row_id, column, &next)
        })();
        self.finish_authoring(prior, outcome)
    }

    /// Shared tail of the crdt edit methods: record a §6.1 sparse crdt-only
    /// upsert — the primary key plus the crdt column, no `baseVersion` — and
    /// enqueue it. The server merges the crdt column and leaves every other
    /// column untouched (§5.10.3), so a baseVersion-less crdt edit cannot
    /// clobber a concurrent edit to another column. A locally absent row
    /// records the same partial operation; the server answers per §6.2.
    #[cfg(feature = "crdt-yjs")]
    fn perform_crdt_push_update(
        &mut self,
        table: &str,
        row_id: &str,
        column: &str,
        crdt_bytes: &[u8],
    ) -> Result<String, String> {
        let mut bytes_obj = Map::new();
        bytes_obj.insert("$bytes".to_owned(), Value::from(bytes_to_hex(crdt_bytes)));
        let mut partial = Map::new();
        partial.insert(column.to_owned(), Value::Object(bytes_obj));
        self.perform_patch(table, row_id, partial, None)
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
    pub fn query(&self, sql: &str, params: &[QueryValue]) -> Result<Vec<QueryRow>, String> {
        query_connection(&self.conn, sql, params).map_err(|failure| failure.to_string())
    }

    /// Repository benchmark and conformance access, present only with `bench-internals`.
    #[cfg(feature = "bench-internals")]
    #[doc(hidden)]
    pub fn benchmark_connection(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Private benchmark intervals; absent from ordinary builds and diagnostics.
    #[cfg(feature = "bench-internals")]
    #[doc(hidden)]
    pub fn benchmark_phases(
        &self,
        enabled: Option<bool>,
        reset: bool,
    ) -> Result<Option<Value>, String> {
        self.benchmark_phases.configure(enabled, reset)?;
        Ok(self.benchmark_phases.snapshot())
    }

    /// One serialized, read-only authority observation, including durable coverage.
    pub fn authority_snapshot(&self) -> Result<Value, String> {
        validate_authority_reads(&self.schema, &self.limits.authority_reads)?;
        if self.limits.authority_reads.is_empty() {
            return Err("client.authority_read_forbidden: no authority reads were declared at client creation".into());
        }
        self.conn
            .execute_batch("SAVEPOINT authority_snapshot")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let revision = self
                .get_meta(LOCAL_REVISION_KEY)?
                .ok_or("sync.local_corrupt: authority revision is missing")?;
            let parsed_revision = revision
                .parse::<u64>()
                .map_err(|_| "sync.local_corrupt: authority revision is invalid")?;
            if parsed_revision.to_string() != revision {
                return Err("sync.local_corrupt: authority revision is invalid".into());
            }
            let mut tables = Vec::new();
            for read in &self.limits.authority_reads {
                let table = self
                    .schema
                    .table(&read.table)
                    .ok_or("client.authority_read_forbidden: authority table is not declared")?;
                let scalar = |column: &str, value: &Value| -> Result<String, String> {
                    let ty = table
                        .columns
                        .iter()
                        .find(|c| c.name == column)
                        .expect("validated authority column")
                        .ty;
                    if ty == ColumnType::Boolean {
                        if let Some(value) = value.as_bool() {
                            return Ok(value.to_string());
                        }
                        return match value.as_i64() {
                            Some(0) => Ok("false".into()),
                            Some(1) => Ok("true".into()),
                            _ => Err("sync.local_corrupt: authority boolean is invalid".into()),
                        };
                    }
                    match value {
                        Value::String(s) => Ok(s.clone()),
                        Value::Number(n) => Ok(n.to_string()),
                        Value::Object(o) if ty == ColumnType::Integer && o.len() == 1 => o
                            .get("$bigint")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .ok_or("sync.local_corrupt: authority integer is invalid".into()),
                        _ => {
                            Err("sync.local_corrupt: authority scalar is missing or invalid".into())
                        }
                    }
                };
                let matches = |row: &QueryRow| -> Result<bool, String> {
                    for (variable, values) in &read.scopes {
                        let column = table
                            .scope_column(variable)
                            .expect("validated authority scope");
                        let value = row
                            .get(column)
                            .ok_or("sync.local_corrupt: authority scope column is missing")?;
                        if value.is_null() || !values.contains(&scalar(column, value)?) {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                };
                let selected = read
                    .columns
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(",");
                let mut intent = BTreeSet::new();
                let mut relevant = BTreeSet::new();
                for row in query_connection(&self.conn,
                    "SELECT id,values_json FROM (SELECT json_extract(value,'$.table') AS tbl,json_extract(value,'$.rowId') AS id,json_extract(value,'$.values') AS values_json FROM _syncular_outbox,json_each(ops_json) UNION ALL SELECT json_extract(value,'$.table'),json_extract(value,'$.rowId'),json_extract(value,'$.values') FROM _syncular_failed_commits,json_each(operations_json) UNION ALL SELECT tbl,id,intent_json FROM _syncular_acked_rows) WHERE tbl=?",
                    &[Value::String(read.table.clone())]).map_err(|e| e.to_string())? {
                    let id = row.get("id").and_then(Value::as_str).ok_or("sync.local_corrupt: authority intent id is invalid")?.to_owned();
                    intent.insert(id.clone());
                    if let Some(raw) = row.get("values_json").and_then(Value::as_str) {
                        let values: QueryRow = serde_json::from_str(raw).map_err(|_| "sync.local_corrupt: authority intent values are invalid")?;
                        if read.scopes.keys().all(|v| values.contains_key(table.scope_column(v).expect("validated scope"))) && matches(&values)? {relevant.insert(id);}
                    }
                }
                let mut rows = BTreeMap::new();
                for full in [base_table(&read.table), visible_table(&read.table)] {
                    for mut values in query_connection(
                        &self.conn,
                        &format!(
                            "SELECT {selected},_syncular_version AS authority_version FROM {full}"
                        ),
                        &[],
                    )
                    .map_err(|e| e.to_string())?
                    {
                        if !matches(&values)? {
                            continue;
                        }
                        let id = scalar(
                            &table.primary_key,
                            values
                                .get(&table.primary_key)
                                .expect("selected primary key"),
                        )?;
                        relevant.insert(id.clone());
                        if full == base_table(&read.table) {
                            let version = values
                                .remove("authority_version")
                                .expect("selected version");
                            let version = version
                                .as_i64()
                                .ok_or("sync.local_corrupt: authority server version is invalid")?;
                            if version >= 0 {
                                rows.insert(id.clone(), json!({"values": values, "version": version, "hasLocalIntent": intent.contains(&id)}));
                            }
                        }
                    }
                }
                intent.retain(|id| relevant.contains(id));
                let rows = rows.into_values().collect::<Vec<_>>();
                let mut persisted = Vec::new();
                for row in query_connection(
                    &self.conn,
                    "SELECT state_json FROM _syncular_subscriptions WHERE tbl=? ORDER BY rowid",
                    &[Value::String(read.table.clone())],
                )
                .map_err(|e| e.message)?
                {
                    let state: Value = serde_json::from_str(
                        row.get("state_json")
                            .and_then(Value::as_str)
                            .ok_or("sync.local_corrupt: authority subscription state is missing")?,
                    )
                    .map_err(|_| "sync.local_corrupt: authority subscription state is invalid")?;
                    let effective = state.get("effectiveScopes").and_then(Value::as_object);
                    let status = state
                        .get("status")
                        .and_then(Value::as_str)
                        .ok_or("sync.local_corrupt: authority subscription status is missing")?;
                    let cursor = state
                        .get("cursor")
                        .and_then(Value::as_i64)
                        .ok_or("sync.local_corrupt: authority subscription cursor is missing")?;
                    let complete = effective.is_some_and(|s| s.len() == read.scopes.len())
                        && status == "active"
                        && cursor >= 0
                        && state.get("bootstrapState").is_none_or(Value::is_null)
                        && state.get("params").is_none_or(Value::is_null);
                    let exposed = effective.map(|s| {
                        read.scopes
                            .keys()
                            .map(|v| (v.clone(), s.get(v).cloned().unwrap_or(json!([]))))
                            .collect::<Map<_, _>>()
                    });
                    let requested = read
                        .scopes
                        .keys()
                        .map(|v| {
                            (
                                v.clone(),
                                state
                                    .get("requested")
                                    .and_then(|s| s.get(v))
                                    .cloned()
                                    .unwrap_or(json!([])),
                            )
                        })
                        .collect::<Map<_, _>>();
                    persisted.push(json!({"requestedScopes": requested, "status": status, "cursor": cursor, "effectiveScopes": exposed, "complete": complete}));
                }
                fn covered(selectors: &[(&String, &Vec<String>)], candidates: &[&Value]) -> bool {
                    match selectors.split_first() {
                        None => !candidates.is_empty(),
                        Some(((variable, values), rest)) => values.iter().all(|value| {
                            covered(
                                rest,
                                &candidates
                                    .iter()
                                    .copied()
                                    .filter(|p| {
                                        p["effectiveScopes"][variable.as_str()]
                                            .as_array()
                                            .is_some_and(|held| {
                                                held.contains(&Value::String(value.clone()))
                                                    || held.contains(&Value::String("*".into()))
                                            })
                                    })
                                    .collect::<Vec<_>>(),
                            )
                        }),
                    }
                }
                let coverage = if covered(
                    &read.scopes.iter().collect::<Vec<_>>(),
                    &persisted
                        .iter()
                        .filter(|p| p["complete"] == true)
                        .collect::<Vec<_>>(),
                ) {
                    "complete"
                } else if persisted.iter().any(|p| {
                    p["status"] == "active"
                        && read.scopes.iter().all(|(v, values)| {
                            values.iter().any(|value| {
                                p["requestedScopes"][v].as_array().is_some_and(|held| {
                                    held.contains(&Value::String(value.clone()))
                                        || held.contains(&Value::String("*".into()))
                                })
                            })
                        })
                }) {
                    "pending"
                } else {
                    "missing"
                };
                tables.push(json!({"table": read.table, "rows": rows, "localIntentRowIds": intent, "scopes": read.scopes, "coverage": coverage, "persisted": persisted}));
            }
            Ok(
                json!({"revision": revision, "complete": tables.iter().all(|t| t["coverage"] == "complete"), "tables": tables}),
            )
        })();
        match result {
            Ok(snapshot) => {
                self.conn
                    .execute_batch("RELEASE authority_snapshot")
                    .map_err(|e| e.to_string())?;
                Ok(snapshot)
            }
            Err(error) => {
                self.conn
                    .execute_batch("ROLLBACK TO authority_snapshot; RELEASE authority_snapshot")
                    .map_err(|e| format!("{error}; rollback failed: {e}"))?;
                Err(error)
            }
        }
    }

    /// Rows, coverage, and local revision from one SQLite read snapshot.
    /// §7.5 atomic snapshot read. An `owner` records a failure in
    /// `diagnostics_snapshot().query_failures` until its next successful read.
    pub fn query_snapshot(
        &mut self,
        sql: &str,
        params: &[QueryValue],
        coverage: &[WindowCoverage],
        owner: Option<QueryOwner<'_>>,
    ) -> Result<QuerySnapshot, String> {
        let result = snapshot_connection(&self.conn, sql, params, coverage);
        if let Some(owner) = owner {
            self.record_query_read(owner, result.as_ref().err());
        }
        result.map_err(|failure| failure.to_string())
    }

    /// §7.6: record the outcome of one owned snapshot read, including reads a
    /// host ran on a separate connection. A success removes the owner's entry;
    /// an identical failure leaves it unchanged; a changed failure moves last.
    pub fn record_query_read(&mut self, owner: QueryOwner<'_>, failure: Option<&QueryReadFailure>) {
        let position = self
            .query_failures
            .iter()
            .position(|entry| entry.id == owner.id);
        let Some(failure) = failure else {
            if let Some(index) = position {
                self.query_failures.remove(index);
            }
            return;
        };
        let tables: Vec<String> = BTreeSet::from_iter(owner.tables.iter().copied())
            .into_iter()
            .map(str::to_owned)
            .collect();
        let code = failure.code.unwrap_or("client.query_failed").to_owned();
        if position.is_some_and(|index| {
            let entry = &self.query_failures[index];
            entry.tables == tables && entry.code == code && entry.sqlite_code == failure.sqlite_code
        }) {
            return;
        }
        if let Some(index) = position {
            self.query_failures.remove(index);
        }
        self.query_failures.push(DiagnosticQueryFailure {
            id: owner.id.to_owned(),
            tables,
            code,
            sqlite_code: failure.sqlite_code,
            at_ms: self.clock_now_ms(),
        });
        if self.query_failures.len() > MAX_DIAGNOSTIC_QUERY_FAILURES {
            self.query_failures.remove(0);
        }
    }

    // -- request building ---------------------------------------------------------

    fn build_request(&self, url_capable: bool) -> Result<(Message, RequestMeta), Box<SyncOutcome>> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::RequestPrepare);
        let log_epoch = self.get_meta(LOG_EPOCH_KEY).map_err(|message| {
            Box::new(SyncOutcome::Failed {
                error_code: "storage.failed".into(),
                message,
                details: None,
                recommended_action: None,
            })
        })?;
        let max_commits = self.limits.max_push_commits_per_request;
        let max_ops = self
            .limits
            .max_push_operations_per_request
            .unwrap_or(PUSH_OPS_PER_REQUEST);
        let byte_cap = self.limits.max_push_request_bytes;
        // §4.2/§5.4: bit 3 is advertised iff the transport can fetch a
        // bare URL — capability negotiation, decided per transport.
        let accept = self.limits.accept.unwrap_or(if url_capable {
            DEFAULT_ACCEPT | ACCEPT_SIGNED_URLS
        } else {
            DEFAULT_ACCEPT
        });
        let header = Frame::ReqHeader {
            client_id: self.client_id.clone(),
            schema_version: self.schema.version,
            log_epoch: log_epoch.clone(),
        };
        // §1.5: the lead frames are REQ_HEADER plus the optional ROUND_FAILURE,
        // which stays ahead of every push, pull and subscription frame; the
        // byte-capacity probes below measure this exact sequence.
        let mut lead = vec![header];
        lead.extend(
            self.round_failure
                .iter()
                .map(|code| Frame::RoundFailure { code: code.clone() }),
        );
        let pull = Frame::PullHeader {
            limit_commits: self.limits.limit_commits.unwrap_or(0),
            limit_snapshot_rows: self.limits.limit_snapshot_rows.unwrap_or(0),
            max_snapshot_pages: self.limits.max_snapshot_pages.unwrap_or(0),
            accept,
        };
        let mut fresh = Vec::new();
        let mut sub_frames = Vec::new();
        for sub in self.subs.iter() {
            if sub.state != SubState::Active {
                continue;
            }
            let mut scopes = sub.requested.clone();
            sort_scope_map(&mut scopes);
            sub_frames.push(Frame::Subscription {
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
        // The fixed frames (order-independent size) and the header+pull probe
        // both encode canonically, so the byte budget is the exact wire size.
        let fixed_bytes = match byte_cap {
            Some(_) => {
                let mut frames = lead.clone();
                frames.push(pull.clone());
                frames.extend(sub_frames.iter().cloned());
                encode_message(&Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Request,
                    frames,
                })
                .len()
            }
            None => 0,
        };
        if let Some(cap) = byte_cap {
            if fixed_bytes > cap {
                return Err(Self::push_capacity_outcome("bytes", cap, fixed_bytes, None));
            }
        }
        let base_bytes = match byte_cap {
            Some(_) => {
                let mut frames = lead.clone();
                frames.push(pull.clone());
                encode_message(&Message {
                    wire_version: WIRE_VERSION,
                    msg_kind: MsgKind::Request,
                    frames,
                })
                .len()
            }
            None => 0,
        };
        let total_outbox = if log_epoch.is_some() {
            self.outbox.len()
        } else {
            0
        };
        let mut push_frames: Vec<Frame> = Vec::new();
        let mut pushed_ids = Vec::new();
        let mut ops_in_request = 0usize;
        let mut bytes_in_request = 0usize;
        let mut deferred_commits = 0usize;
        #[cfg(feature = "bench-internals")]
        let outbox_phase = self.benchmark_phases.start(Phase::OutboxEncode);
        for (index, commit) in self.outbox.iter().take(total_outbox).enumerate() {
            // §6.1/§7.1: the commit-count and operation caps are hard. A
            // first commit over the operation cap is a typed capacity error
            // and stays queued; a later one defers with the complete suffix.
            if max_commits.is_some_and(|cap| push_frames.len() >= cap) {
                deferred_commits = total_outbox - index;
                break;
            }
            if ops_in_request + commit.ops.len() > max_ops {
                if push_frames.is_empty() {
                    return Err(Self::push_capacity_outcome(
                        "operations",
                        max_ops,
                        commit.ops.len(),
                        Some(commit.client_commit_id.as_str()),
                    ));
                }
                deferred_commits = total_outbox - index;
                break;
            }
            let operations = commit
                .ops
                .iter()
                .map(|op| {
                    let payload = match self
                        .schema
                        .table(&op.table)
                        .and_then(|table| Some((table, op.presented_values(table)?)))
                    {
                        Some((table, values)) => {
                            // §0: outbox entries encode at send time with the
                            // current codec (validated at mutate()). §6.1: the
                            // values map's keys are the sparse presence set; an
                            // insert-intent operation presents every column (§7.1).
                            // §5.11: encrypted columns are encrypted here, with
                            // an absent key-id selector read from the stored row.
                            // `sync_inner` runs `drop_unencodable_outbox` first,
                            // so an encrypt failure cannot reach this encode; the
                            // author seam validated every other failure.
                            let fallback =
                                self.stored_key_fallback(table, &op.row_id)
                                    .map_err(|message| {
                                        Box::new(SyncOutcome::Failed {
                                            error_code: "storage.failed".into(),
                                            message,
                                            details: None,
                                            recommended_action: None,
                                        })
                                    })?;
                            encode_sparse_row_json(
                                table,
                                &op.row_id,
                                &values,
                                &self.encryption,
                                fallback.as_ref(),
                            )
                            .ok()
                        }
                        None => None,
                    };
                    Ok(ssp2::model::Operation {
                        table: op.table.clone(),
                        row_id: op.row_id.clone(),
                        op: if op.upsert { Op::Upsert } else { Op::Delete },
                        base_version: op.base_version,
                        payload,
                    })
                })
                .collect::<Result<Vec<_>, Box<SyncOutcome>>>()?;
            let frame = Frame::PushCommit {
                client_commit_id: commit.client_commit_id.clone(),
                operations,
            };
            let frame_bytes = match byte_cap {
                Some(_) => {
                    let mut frames = lead.clone();
                    frames.push(frame.clone());
                    frames.push(pull.clone());
                    encode_message(&Message {
                        wire_version: WIRE_VERSION,
                        msg_kind: MsgKind::Request,
                        frames,
                    })
                    .len()
                        - base_bytes
                }
                None => 0,
            };
            // The head is always encoded so the caller can report the full
            // projected request size; a later commit defers once it no longer
            // fits.
            if let Some(cap) = byte_cap {
                if !push_frames.is_empty() && fixed_bytes + bytes_in_request + frame_bytes > cap {
                    deferred_commits = total_outbox - index;
                    break;
                }
            }
            push_frames.push(frame);
            pushed_ids.push(commit.client_commit_id.clone());
            ops_in_request += commit.ops.len();
            bytes_in_request += frame_bytes;
        }
        #[cfg(feature = "bench-internals")]
        drop(outbox_phase);
        if let Some(cap) = byte_cap {
            if fixed_bytes + bytes_in_request > cap {
                // The head alone does not fit this budget; the commit stays
                // queued and no transport round is attempted.
                let blocked = if push_frames.is_empty() {
                    None
                } else {
                    self.outbox.first().map(|c| c.client_commit_id.as_str())
                };
                return Err(Self::push_capacity_outcome(
                    "bytes",
                    cap,
                    fixed_bytes + bytes_in_request,
                    blocked,
                ));
            }
        }
        let mut frames = lead;
        frames.extend(push_frames);
        frames.push(pull);
        frames.extend(sub_frames);
        let message = Message {
            wire_version: WIRE_VERSION,
            msg_kind: MsgKind::Request,
            frames,
        };
        Ok((
            message,
            RequestMeta {
                pushed_ids,
                fresh,
                accept,
                deferred_commits,
            },
        ))
    }

    /// §7.1: a configured push capacity limit cannot carry this request.
    fn push_capacity_outcome(
        kind: &str,
        limit: usize,
        size: usize,
        client_commit_id: Option<&str>,
    ) -> Box<SyncOutcome> {
        let mut details = Map::new();
        details.insert("kind".to_owned(), Value::from(kind));
        details.insert("limit".to_owned(), Value::from(limit as u64));
        details.insert("size".to_owned(), Value::from(size as u64));
        if let Some(id) = client_commit_id {
            details.insert("clientCommitId".to_owned(), Value::from(id));
        }
        Box::new(SyncOutcome::Failed {
            error_code: "client.push_request_too_large".into(),
            message: "the push request exceeds a configured capacity limit".into(),
            details: Some(Value::Object(details)),
            recommended_action: None,
        })
    }

    // -- sync -------------------------------------------------------------------

    /// Cloneable observation handle; no client lock is needed to read it.
    pub fn progress(&self) -> ProgressObserver {
        self.progress.clone()
    }

    pub fn sync(&mut self, transport: &mut dyn Transport) -> SyncOutcome {
        let prepared = match self.prepare_sync_round(transport.supports_url_fetch()) {
            Ok(prepared) => prepared,
            Err(outcome) => return *outcome,
        };
        // The round's network deadline rides `PreparedSyncRound` and is scoped
        // to each exchange, so uploads, continuations, the main request, and
        // every segment fetch share one monotonic anchor without leaving
        // deadline state on a reused transport.
        let mut next = prepared;
        loop {
            match self.apply_sync_round(next.exchange(transport)) {
                crate::AppliedSyncRound::Continue(prepared) => next = prepared,
                crate::AppliedSyncRound::Complete {
                    outcome, controls, ..
                } => {
                    if self.transport_enabled {
                        for text in controls {
                            let _ = transport.realtime_send(&text);
                        }
                    } else {
                        self.disconnect_realtime(transport);
                    }
                    return outcome;
                }
            }
        }
    }

    fn finish_sync_round(&mut self, started_at_ms: i64, mut outcome: SyncOutcome) -> SyncOutcome {
        if let SyncOutcome::Failed {
            error_code,
            message,
            details,
            ..
        } = &mut outcome
        {
            if let Some((failure, code)) = self
                .storage_failure
                .borrow()
                .as_ref()
                .and_then(|failure| failure.code.map(|code| (failure, code)))
            {
                *error_code = code.to_owned();
                *message = match code {
                    "client.storage_busy" => "local SQLite storage is busy",
                    "client.storage_full" => "local SQLite storage is full",
                    "client.storage_io" => "local SQLite storage I/O failed",
                    "client.storage_corrupt" => "local SQLite storage is corrupt",
                    _ => unreachable!("unrecognized classified storage failure"),
                }
                .to_owned();
                *details = failure.details();
            }
        }
        let details = match &outcome {
            SyncOutcome::Failed { details, .. } => details.as_ref(),
            _ => None,
        };
        let cause_kind = details
            .and_then(|details| details.get("causeKind"))
            .and_then(Value::as_str)
            .and_then(|cause| match cause {
                "network" => Some(crate::TransportCauseKind::Network),
                "connect" => Some(crate::TransportCauseKind::Connect),
                "tls" => Some(crate::TransportCauseKind::Tls),
                "io" => Some(crate::TransportCauseKind::Io),
                "request" => Some(crate::TransportCauseKind::Request),
                "protocol" => Some(crate::TransportCauseKind::Protocol),
                "timeout" => Some(crate::TransportCauseKind::Timeout),
                "round_deadline" => Some(crate::TransportCauseKind::RoundDeadline),
                "aborted" => Some(crate::TransportCauseKind::Aborted),
                "body" => Some(crate::TransportCauseKind::Body),
                "status" => Some(crate::TransportCauseKind::Status),
                "redirect" => Some(crate::TransportCauseKind::Redirect),
                "unknown" => Some(crate::TransportCauseKind::Unknown),
                _ => None,
            });
        let http_status = if matches!(
            cause_kind,
            Some(
                crate::TransportCauseKind::Status
                    | crate::TransportCauseKind::Body
                    | crate::TransportCauseKind::Redirect
            )
        ) {
            details
                .and_then(|details| details.get("httpStatus"))
                .and_then(Value::as_f64)
                .filter(|status| status.fract() == 0.0 && (100.0..=599.0).contains(status))
                .map(|status| status as u16)
        } else {
            None
        };
        let retry_delay_ms = self.round_retry_delay_ms;
        self.progress.update(|p| match &outcome {
            SyncOutcome::Ok(report) | SyncOutcome::BudgetExhausted(report)
                if report.failed.is_empty() =>
            {
                p.state = ProgressState::Complete
            }
            SyncOutcome::Ok(_) | SyncOutcome::BudgetExhausted(_) => {
                p.state = ProgressState::Failed;
                p.error_code = Some("sync.scope_revoked".into());
            }
            SyncOutcome::Failed { error_code, .. } => {
                p.state = ProgressState::Failed;
                p.error_code = Some(Self::diagnostic_code(error_code));
                p.cause_kind = cause_kind;
                p.http_status = http_status;
                p.retry_delay_ms = retry_delay_ms;
            }
            SyncOutcome::RealtimeUnavailable { .. } => {
                p.state = ProgressState::Failed;
                p.error_code = Some(REALTIME_UNAVAILABLE_CODE.to_owned());
                p.retry_delay_ms = retry_delay_ms;
            }
        });
        let completed_at_ms = self.clock_now_ms();
        self.last_round = Some(match &outcome {
            SyncOutcome::Ok(report) | SyncOutcome::BudgetExhausted(report) => DiagnosticLastRound {
                status: "succeeded".to_owned(),
                started_at_ms,
                completed_at_ms,
                duration_ms: completed_at_ms.saturating_sub(started_at_ms).max(0),
                counters: Some(DiagnosticRoundCounters {
                    pushed: report.pushed,
                    applied: report.applied.len(),
                    rejected: report.rejected.len(),
                    retryable: report.retryable.len(),
                    conflicts: report.conflicts,
                    commits_applied: report.commits_applied,
                    segment_rows_applied: report.segment_rows_applied,
                    bootstrapping: report.bootstrapping.len(),
                    resets: report.resets.len(),
                    revoked: report.revoked.len(),
                    failed: report.failed.len(),
                    deferred_commits: report.deferred_commits,
                }),
                error_code: None,
                cause_kind: None,
                http_status: None,
            },
            SyncOutcome::Failed { error_code, .. } => DiagnosticLastRound {
                status: "failed".to_owned(),
                started_at_ms,
                completed_at_ms,
                duration_ms: completed_at_ms.saturating_sub(started_at_ms).max(0),
                counters: None,
                error_code: Some(Self::diagnostic_code(error_code)),
                cause_kind,
                http_status,
            },
            SyncOutcome::RealtimeUnavailable { .. } => DiagnosticLastRound {
                status: "failed".to_owned(),
                started_at_ms,
                completed_at_ms,
                duration_ms: completed_at_ms.saturating_sub(started_at_ms).max(0),
                counters: None,
                error_code: Some(REALTIME_UNAVAILABLE_CODE.to_owned()),
                cause_kind: None,
                http_status: None,
            },
        });
        outcome
    }

    /// Capture one request on the client owner. Mutations made after this
    /// call remain in the outbox for a later round; no network I/O occurs here.
    pub fn prepare_sync_round(
        &mut self,
        url_capable: bool,
    ) -> Result<crate::PreparedSyncRound, Box<SyncOutcome>> {
        if !self.transport_enabled {
            return Err(Box::new(SyncOutcome::Failed {
                error_code: "sync.offline".into(),
                message: "transport gate is closed".into(),
                details: None,
                recommended_action: None,
            }));
        }
        if self.active_round.is_some() {
            return Err(Box::new(SyncOutcome::Failed {
                error_code: "client.round_in_progress".into(),
                message: "a sync round is already in flight".into(),
                details: None,
                recommended_action: None,
            }));
        }
        self.storage_failure.borrow_mut().take();
        self.progress.start();
        self.round_retry_delay_ms = None;
        let started_at_ms = self.clock_now_ms();
        let prepared = (|| {
            if self.stopped {
                return Err(Box::new(SyncOutcome::Ok(SyncReport {
                    schema_floor: self.schema_floor.clone(),
                    ..SyncReport::default()
                })));
            }
            if self.security_preflight {
                return Err(Box::new(SyncOutcome::Failed {
                    error_code: SECURITY_PREFLIGHT_REQUIRED_CODE.into(),
                    message: "security preflight must complete before syncing".into(),
                    details: None,
                    recommended_action: None,
                }));
            }
            self.set_sync_needed(false, false);
            self.drain_pending_evictions()
                .and_then(|_| self.drop_incompatible_outbox())
                .and_then(|_| self.drop_unencodable_outbox(true, None))
                .map_err(|message| {
                    Box::new(SyncOutcome::Failed {
                        error_code: "storage.failed".into(),
                        message,
                        details: None,
                        recommended_action: None,
                    })
                })?;
            let has_log_epoch = self.get_meta(LOG_EPOCH_KEY).map_err(|message| {
                Box::new(SyncOutcome::Failed {
                    error_code: "storage.failed".into(),
                    message,
                    details: None,
                    recommended_action: None,
                })
            })?;
            let uploads = if has_log_epoch.is_some() && self.schema_has_blobs() {
                self.pending_blob_uploads().map_err(|e| {
                    Box::new(SyncOutcome::Failed {
                        error_code: e.code,
                        message: e.message,
                        details: e.details,
                        recommended_action: None,
                    })
                })?
            } else {
                Vec::new()
            };
            if self.realtime_state != RealtimeState::Connected
                && self.realtime_policy == RealtimePolicy::Required
            {
                let retry_delay_ms = self.schedule_background_retry();
                self.realtime_retry_delay_ms = Some(retry_delay_ms);
                return Err(Box::new(SyncOutcome::RealtimeUnavailable {
                    state: self.realtime_state,
                    reason_code: self.realtime_reason_code.clone(),
                    retry_delay_ms,
                }));
            }
            let (message, meta) = self.build_request(url_capable)?;
            let id = uuid::Uuid::new_v4();
            self.active_round = Some(id);
            let phase = if uploads.is_empty() {
                crate::round::RoundPhase::Sync
            } else {
                crate::round::RoundPhase::UploadGrant
            };
            Ok(crate::PreparedSyncRound {
                id,
                started_at_ms,
                message,
                meta,
                uploads: uploads.into(),
                phase,
                encoded: None,
                continuation: None,
                completed: None,
                realtime: self.realtime_state == RealtimeState::Connected,
                scopes: self
                    .subs
                    .iter()
                    .map(|s| (s.id.clone(), canonical_scope_json(&s.requested)))
                    .collect(),
                #[cfg(feature = "bench-internals")]
                benchmark_phases: self.benchmark_phases.clone(),
                progress: self.progress.clone(),
                fixed_now: self.now_ms,
                round_deadline_at: None,
            })
        })();
        prepared.map_err(|outcome| Box::new(self.finish_sync_round(started_at_ms, *outcome)))
    }

    /// Discard the reply of an old authorization/subscription context. Its
    /// submitted commits stay durable and can be retried with the same ids.
    pub fn cancel_sync_round(&mut self) {
        self.active_round = None;
    }

    /// Apply captured network results on the owner, preserving all normal
    /// version, schema, content-address and cursor checks. No network I/O.
    pub fn apply_sync_round(
        &mut self,
        completed: crate::CompletedSyncRound,
    ) -> crate::AppliedSyncRound {
        let mut prepared = completed.prepared;
        if self.active_round != Some(prepared.id) || self.security_preflight {
            return crate::AppliedSyncRound::Complete {
                outcome: SyncOutcome::Failed {
                    error_code: "client.round_cancelled".into(),
                    message: "sync round belongs to a released client context".into(),
                    details: None,
                    recommended_action: None,
                },
                controls: Vec::new(),
                more: false,
                bootstrap_advanced: false,
            };
        }
        self.storage_failure.borrow_mut().take();
        let (response, mut downloads, transport_failed) = match completed.exchange {
            crate::round::ExchangeResult::Upload { id, result } => {
                let result = match result {
                    // §5.9.7: a non-retryable server refusal (`blob.too_large`)
                    // is the body's final outcome. The commits naming it take
                    // the incompatible-commit path with the server's code and
                    // leave this round's request; the round continues.
                    Err(error)
                        if error
                            .details
                            .as_ref()
                            .and_then(|details| details.get("retryable"))
                            == Some(&Value::Bool(false)) =>
                    {
                        self.conn
                            .prepare(
                                "SELECT commit_id FROM _syncular_blob_commit_refs WHERE blob_id = ?",
                            )
                            .and_then(|mut statement| {
                                statement
                                    .query_map(rusqlite::params![id], |row| row.get::<_, String>(0))?
                                    .collect::<Result<HashSet<_>, _>>()
                            })
                            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
                            .and_then(|refused| {
                                let commits = self
                                    .outbox
                                    .iter()
                                    .filter(|commit| refused.contains(&commit.client_commit_id))
                                    .cloned()
                                    .collect::<Vec<_>>();
                                if !commits.is_empty() {
                                    self.drop_outbox_commits(&commits, &error.code, &error.message)?;
                                }
                                prepared.message.frames.retain(|frame| {
                                    !matches!(frame, Frame::PushCommit { client_commit_id, .. }
                                        if refused.contains(client_commit_id))
                                });
                                prepared.meta.pushed_ids.retain(|id| !refused.contains(id));
                                prepared.continuation = Some(crate::round::RoundPhase::UploadGrant);
                                Ok(())
                            })
                            .map_err(|message| TransportError::new("client.failed", message))
                    }
                    result => result,
                };
                let result = result.and_then(|()| {
                    self.conn
                        .execute(
                            "DELETE FROM _syncular_blob_uploads WHERE blob_id = ?",
                            rusqlite::params![id],
                        )
                        .map(|_| ())
                        .map_err(|error| {
                            TransportError::new(
                                "client.failed",
                                Self::sqlite_failure(&self.storage_failure, error),
                            )
                        })
                });
                match result {
                    Ok(()) => return crate::AppliedSyncRound::Continue(prepared),
                    Err(TransportError {
                        code,
                        message,
                        details,
                    }) => {
                        self.active_round = None;
                        if Self::unreachable_transport(&details) {
                            // The round's work is still owed; the host's
                            // connectivity resume runs it.
                            self.set_sync_needed(true, false);
                        } else if Self::retryable_failure_code(&code) {
                            self.schedule_background_retry();
                        }
                        let recommended_action = recommended_action_of(&details);
                        let outcome = self.finish_sync_round(
                            prepared.started_at_ms,
                            SyncOutcome::Failed {
                                error_code: code,
                                message,
                                details,
                                recommended_action,
                            },
                        );
                        return crate::AppliedSyncRound::Complete {
                            outcome,
                            controls: Vec::new(),
                            more: false,
                            bootstrap_advanced: false,
                        };
                    }
                }
            }
            crate::round::ExchangeResult::Reply {
                response,
                downloads,
                transport_failed,
            } => (response, downloads, transport_failed),
        };
        self.active_round = None;
        let before = self
            .subs
            .iter()
            .map(|s| (s.id.clone(), s.bootstrap_state.clone()))
            .collect::<Vec<_>>();
        let outcome = (|| {
            let response = match response {
                Ok(response) => {
                    // §1.5: a complete, decodable response ends the report, an
                    // in-band ERROR included (the server already recorded it).
                    self.round_failure = None;
                    response
                }
                Err(TransportError {
                    code,
                    message,
                    details,
                }) => {
                    // §1.5: the server cannot see a round whose transport
                    // failed or whose response never decoded, so its code rides
                    // the following requests. A code the frame grammar rejects
                    // is not reportable, and the previous code stays.
                    if ssp2::model::valid_round_failure_code(&code) {
                        self.round_failure = Some(code.clone());
                    }
                    if transport_failed {
                        if prepared.realtime {
                            self.set_realtime_state(RealtimeState::Lost, Some(&code));
                        }
                        if let Err(message) = self.record_lease_error(&code) {
                            return SyncOutcome::Failed {
                                error_code: "storage.failed".to_owned(),
                                message,
                                details: None,
                                recommended_action: None,
                            };
                        }
                    }
                    if Self::retryable_failure_code(&code) && !Self::unreachable_transport(&details)
                    {
                        let delay = self.schedule_background_retry();
                        if prepared.realtime && transport_failed {
                            self.realtime_retry_delay_ms = Some(delay);
                        }
                    }
                    let recommended_action = recommended_action_of(&details);
                    return SyncOutcome::Failed {
                        error_code: code,
                        message,
                        details,
                        recommended_action,
                    };
                }
            };
            let mut outcome = self.process_response(&mut downloads, response, &prepared.meta);
            if let SyncOutcome::Ok(report) = &mut outcome {
                report.deferred_commits = prepared.meta.deferred_commits;
            }
            match &outcome {
                SyncOutcome::Ok(_) => self.reset_background_retry(),
                SyncOutcome::Failed {
                    error_code,
                    details,
                    ..
                } if Self::retryable_failure_code(error_code)
                    && !Self::unreachable_transport(details) =>
                {
                    self.schedule_background_retry();
                }
                _ => {}
            }
            if prepared.meta.deferred_commits > 0 {
                self.set_sync_needed(true, true);
            }
            self.previous_version_lifetime_check();
            outcome
        })();
        match &outcome {
            // §4.7: a subscription that still holds a resume token needs
            // another round, also when the drive that started it ends early.
            SyncOutcome::Ok(report) if !report.bootstrapping.is_empty() => {
                self.set_sync_needed(true, false)
            }
            // The round's work is still owed; the host's connectivity resume
            // runs it.
            SyncOutcome::Failed { details, .. } if Self::unreachable_transport(details) => {
                self.set_sync_needed(true, false)
            }
            _ => {}
        }
        let more = self.transport_enabled
            && matches!(&outcome, SyncOutcome::Ok(report)
                if report.schema_floor.is_none()
                    && (!report.bootstrapping.is_empty()
                        || report.commits_applied > 0
                        || report.segment_rows_applied > 0
                        || !report.resets.is_empty()
                        || report.deferred_commits > 0
                        || self.sync_needed));
        let bootstrap_advanced = matches!(&outcome, SyncOutcome::Ok(report) if report.segment_rows_applied > 0 && !report.bootstrapping.is_empty())
            && before
                != self
                    .subs
                    .iter()
                    .map(|s| (s.id.clone(), s.bootstrap_state.clone()))
                    .collect::<Vec<_>>();
        crate::AppliedSyncRound::Complete {
            outcome: self.finish_sync_round(prepared.started_at_ms, outcome),
            controls: if self.transport_enabled {
                downloads.controls
            } else {
                Vec::new()
            },
            more,
            bootstrap_advanced,
        }
    }

    /// §7.7: one idle drive's default total deadline, the TS client's value.
    pub const SYNC_IDLE_TIMEOUT_MS: u64 = 60_000;

    pub fn sync_until_idle(
        &mut self,
        transport: &mut dyn Transport,
        max_rounds: Option<u32>,
    ) -> SyncOutcome {
        self.sync_until_idle_with_deadline(transport, max_rounds, Some(Self::SYNC_IDLE_TIMEOUT_MS))
    }

    /// As [`SyncClient::sync_until_idle`], with an explicit total deadline in
    /// milliseconds (`None` disables it). The deadline is checked between
    /// rounds; one blocking transport call is bounded by the transport's own
    /// whole-round deadline (§1.8).
    pub fn sync_until_idle_with_deadline(
        &mut self,
        transport: &mut dyn Transport,
        max_rounds: Option<u32>,
        timeout_ms: Option<u64>,
    ) -> SyncOutcome {
        // §7.7: an explicit budget is a strict positive round count. Zero is a
        // caller error, not an exhaustion.
        if max_rounds == Some(0) {
            return SyncOutcome::Failed {
                details: None,
                error_code: "sync.invalid_request".into(),
                message: "maxRounds must be a positive integer".into(),
                recommended_action: None,
            };
        }
        if timeout_ms.is_some_and(|ms| ms == 0 || i64::try_from(ms).is_err()) {
            return SyncOutcome::Failed {
                details: None,
                error_code: "sync.invalid_request".into(),
                message: "timeoutMs must be a positive integer".into(),
                recommended_action: None,
            };
        }
        let started_at_ms = self.clock_now_ms();
        let deadline_ms = timeout_ms.map(|ms| started_at_ms.saturating_add(ms as i64));
        self.sync_until_idle_bounded(transport, max_rounds, started_at_ms, deadline_ms)
    }

    fn sync_until_idle_bounded(
        &mut self,
        transport: &mut dyn Transport,
        max_rounds: Option<u32>,
        started_at_ms: i64,
        deadline_ms: Option<i64>,
    ) -> SyncOutcome {
        let rounds = max_rounds.unwrap_or(20);
        let mut aggregate = SyncReport::default();
        let mut spent = 0;
        while spent < rounds {
            if let Some(deadline_ms) = deadline_ms {
                if self.clock_now_ms() >= deadline_ms {
                    return SyncOutcome::Failed {
                        error_code: "sync.idle_timeout".into(),
                        message: "sync_until_idle exceeded its deadline".into(),
                        details: Some(serde_json::json!({
                            "timeoutMs": deadline_ms
                                .saturating_sub(started_at_ms) as u64,
                            "rounds": spent,
                        })),
                        recommended_action: Some("retryLater".into()),
                    };
                }
            }
            spent += 1;
            let before = self
                .subs
                .iter()
                .map(|sub| (sub.id.clone(), sub.bootstrap_state.clone()))
                .collect::<Vec<_>>();
            match self.sync(transport) {
                SyncOutcome::Failed {
                    error_code,
                    message,
                    details,
                    recommended_action,
                } => {
                    return SyncOutcome::Failed {
                        details,
                        error_code,
                        message,
                        recommended_action,
                    };
                }
                outcome @ SyncOutcome::RealtimeUnavailable { .. } => return outcome,
                SyncOutcome::BudgetExhausted(_) => {
                    unreachable!("sync() never exhausts a round budget")
                }
                SyncOutcome::Ok(report) => {
                    if max_rounds.is_none()
                        && report.segment_rows_applied > 0
                        && !report.bootstrapping.is_empty()
                        && before
                            != self
                                .subs
                                .iter()
                                .map(|sub| (sub.id.clone(), sub.bootstrap_state.clone()))
                                .collect::<Vec<_>>()
                    {
                        spent = 0;
                    }
                    // TS parity: a disabled transport or a schema floor ends
                    // the loop. The latest round still merges first.
                    let stop = !self.transport_enabled() || report.schema_floor.is_some();
                    aggregate.merge(&report);
                    if stop {
                        return SyncOutcome::Ok(aggregate);
                    }
                    // §4.5: pull again whenever the response contained
                    // commits or segments; resets re-bootstrap; a pending
                    // resume token continues paging (§4.7); deferred outbox
                    // commits and a raised sync-needed signal push on the next
                    // round.
                    let more = !report.bootstrapping.is_empty()
                        || report.commits_applied > 0
                        || report.segment_rows_applied > 0
                        || !report.resets.is_empty()
                        || report.deferred_commits > 0
                        || self.sync_needed;
                    if !more {
                        return SyncOutcome::Ok(aggregate);
                    }
                }
            }
        }
        // §7.7: partial success. The aggregate report is retained and the run
        // is explicitly not idle.
        SyncOutcome::BudgetExhausted(aggregate)
    }

    fn process_response(
        &mut self,
        transport: &mut dyn Transport,
        response: Message,
        meta: &RequestMeta,
    ) -> SyncOutcome {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::ResponseApply);
        let mut report = SyncReport {
            pushed: meta.pushed_ids.len() as u32,
            ..SyncReport::default()
        };
        let mut rejection_details_by_commit: HashMap<String, BTreeMap<i32, RejectionDetails>> =
            HashMap::new();
        let pushed_ids = meta
            .pushed_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut incomplete_subscriptions: HashSet<&str> =
            meta.fresh.iter().map(|(id, _)| id.as_str()).collect();
        let mut last_final_push_result_id: Option<String> = None;
        for frame in &response.frames {
            match frame {
                Frame::PushResultDetails {
                    client_commit_id,
                    entries,
                } => {
                    let details = rejection_details_by_commit
                        .entry(client_commit_id.clone())
                        .or_default();
                    for entry in entries {
                        let parsed = match RejectionDetails::parse(&entry.details.0) {
                            Ok(value) => value,
                            Err(message) => {
                                return SyncOutcome::Failed {
                                    details: None,
                                    error_code: "sync.invalid_request".to_owned(),
                                    message,
                                    recommended_action: None,
                                };
                            }
                        };
                        details.insert(entry.op_index, parsed);
                    }
                }
                Frame::PushResult {
                    client_commit_id,
                    status,
                    results,
                    ..
                } if pushed_ids.contains(client_commit_id.as_str())
                    && Self::push_result_is_final(*status, results) =>
                {
                    last_final_push_result_id = Some(client_commit_id.clone());
                }
                _ => {}
            }
        }
        if response.wire_version < 2 {
            return SyncOutcome::Failed {
                details: None,
                error_code: "client.invalid_host_response".to_owned(),
                message: "server response does not carry wire version 2 log-epoch state".to_owned(),
                recommended_action: None,
            };
        }
        let coalesced_deletes = coalesced_delete_keys(&response.frames, |id, status, _| {
            status == SubStatus::Active && self.subs.iter().any(|sub| sub.id == id)
        });
        let mut frames = response.frames.into_iter().peekable();
        match frames.next() {
            Some(Frame::RespHeader {
                required_schema_version,
                latest_schema_version,
                log_epoch,
                reset_required,
            }) => {
                if let Some(required) = required_schema_version {
                    // §1.6 schema-floor response: nothing else is processed;
                    // stop syncing and surface the upgrade requirement.
                    let floor = SchemaFloor {
                        required_schema_version: Some(required),
                        latest_schema_version,
                    };
                    if let Err(message) = self.set_schema_floor(Some(floor.clone())) {
                        return SyncOutcome::Failed {
                            details: None,
                            error_code: "storage.failed".to_owned(),
                            message,
                            recommended_action: None,
                        };
                    }
                    report.schema_floor = Some(floor);
                    return SyncOutcome::Ok(report);
                }
                if reset_required {
                    if frames.next().is_some() {
                        return SyncOutcome::Failed {
                            details: None,
                            error_code: "client.invalid_host_response".to_owned(),
                            message: "log-epoch reset response contains body frames".to_owned(),
                            recommended_action: None,
                        };
                    }
                    match self.run_log_epoch_reset(&log_epoch) {
                        Ok(resets) => {
                            report.resets = resets;
                            return SyncOutcome::Ok(report);
                        }
                        Err(message) => {
                            return SyncOutcome::Failed {
                                details: None,
                                error_code: "sync.local_corrupt".to_owned(),
                                message,
                                recommended_action: None,
                            };
                        }
                    }
                }
                let stored_epoch = match self.get_meta(LOG_EPOCH_KEY) {
                    Ok(stored) => stored,
                    Err(message) => {
                        return SyncOutcome::Failed {
                            details: None,
                            error_code: "storage.failed".to_owned(),
                            message,
                            recommended_action: None,
                        };
                    }
                };
                if stored_epoch.as_deref() != Some(log_epoch.as_str()) {
                    return SyncOutcome::Failed {
                        details: None,
                        error_code: "client.invalid_host_response".to_owned(),
                        message: "server changed logEpoch without requiring a reset".to_owned(),
                        recommended_action: None,
                    };
                }
            }
            _ => {
                return SyncOutcome::Failed {
                    details: None,
                    error_code: "sync.invalid_request".to_owned(),
                    message: "response does not start with RESP_HEADER".to_owned(),
                    recommended_action: None,
                };
            }
        }

        if let Err(message) = self.begin_coalesced_apply() {
            return SyncOutcome::Failed {
                details: None,
                error_code: "storage.failed".into(),
                message,
                recommended_action: None,
            };
        }
        let mut failure: Option<(String, String, Option<String>, Option<Value>)> = None;
        while let Some(frame) = frames.next() {
            match frame {
                frame @ Frame::PushResult { .. } => {
                    let successful = matches!(
                        &frame,
                        Frame::PushResult {
                            status: PushStatus::Applied | PushStatus::Cached,
                            ..
                        }
                    );
                    let mut results = vec![frame];
                    if successful {
                        while matches!(
                            frames.peek(),
                            Some(Frame::PushResult {
                                status: PushStatus::Applied | PushStatus::Cached,
                                ..
                            })
                        ) {
                            if let Some(next) = frames.next() {
                                results.push(next);
                            }
                        }
                    }
                    if self
                        .handle_push_results(
                            &results,
                            &pushed_ids,
                            &rejection_details_by_commit,
                            &mut report,
                            last_final_push_result_id.as_deref(),
                        )
                        .is_err()
                    {
                        failure = Some((
                            "client.outcome_persistence_failed".to_owned(),
                            "local commit outcome could not be persisted".to_owned(),
                            None,
                            None,
                        ));
                        break;
                    }
                }
                Frame::PushResultDetails { .. } => {}
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
                    if sub_end.is_some() {
                        incomplete_subscriptions.remove(id.as_str());
                    }
                    let section_failure = match self.process_section(
                        transport,
                        &id,
                        status,
                        &reason_code,
                        effective_scopes,
                        body,
                        sub_end,
                        meta,
                        &mut report,
                        &coalesced_deletes,
                    ) {
                        Err(SectionError::Abort(code, message)) => {
                            Some((code, message, None, None))
                        }
                        Err(SectionError::Transport(error)) => {
                            Some((error.code, error.message, None, error.details))
                        }
                        _ => None,
                    };
                    if section_failure.is_some() {
                        failure = section_failure;
                        break;
                    }
                }
                Frame::Lease {
                    lease_id,
                    expires_at_ms,
                } => {
                    // §7.3.5: persist the opaque lease; a fresh lease clears
                    // any prior lease error (the outage/revocation is over).
                    if let Err(message) = self.set_lease_state(Some(LeaseState {
                        lease_id: Some(lease_id),
                        expires_at_ms: Some(expires_at_ms),
                        error_code: None,
                    })) {
                        failure = Some(("storage.failed".to_owned(), message, None, None));
                        break;
                    }
                }
                Frame::Error {
                    code,
                    message,
                    recommended_action,
                    details,
                    ..
                } => {
                    // §1.6: the whole request failed; already-completed
                    // subscriptions keep their applied data and cursors.
                    let recommended_action =
                        (!recommended_action.is_empty()).then_some(recommended_action);
                    let details = details
                        .and_then(|details| serde_json::from_str::<Value>(&details.0).ok())
                        .filter(Value::is_object);
                    failure = Some((code, message, recommended_action, details));
                    break;
                }
                Frame::Unknown { .. } => {}
                _ => {
                    failure = Some((
                        "sync.invalid_request".to_owned(),
                        "unexpected frame in response".to_owned(),
                        None,
                        None,
                    ));
                    break;
                }
            }
        }

        let applied = match failure {
            Some(failure) => Err(failure),
            // Local apply boundaries already reconciled their affected overlay.
            // Refuse round success if any remaining dirty work fails to
            // reconcile. §4.8 E1: the push half may have drained commits that
            // pinned rows of a shrunk window unit, so retry deferred evictions.
            None => self
                .rebuild_overlay_if_dirty()
                .and_then(|()| self.drain_pending_evictions())
                .map_err(|message| ("storage.failed".to_owned(), message, None, None)),
        };
        // §1.4 rule 4: frames completed before a failure stay committed; a
        // failed COMMIT of the coalesced transaction fails the round.
        if let Err(message) = self.finish_coalesced_apply() {
            return SyncOutcome::Failed {
                details: None,
                error_code: "storage.failed".into(),
                message,
                recommended_action: None,
            };
        }
        if let Err((error_code, message, recommended_action, details)) = applied {
            return SyncOutcome::Failed {
                details,
                error_code,
                message,
                recommended_action,
            };
        }
        if !incomplete_subscriptions.is_empty() {
            self.set_sync_needed(true, true);
        }
        self.ack_after_pull(transport);
        // §7.4.5: the reset is over once the first post-reset pull round
        // leaves no subscription mid-bootstrap — the tables are rebuilt.
        if self.upgrading && report.bootstrapping.is_empty() {
            self.set_upgrading(false);
        }
        SyncOutcome::Ok(report)
    }

    // -- push results (§6.3, §7.2) ------------------------------------------------

    fn handle_push_results(
        &mut self,
        frames: &[Frame],
        pushed_ids: &HashSet<&str>,
        rejection_details_by_commit: &HashMap<String, BTreeMap<i32, RejectionDetails>>,
        report: &mut SyncReport,
        last_final_push_result_id: Option<&str>,
    ) -> Result<(), String> {
        self.begin_observation("syncular_push_results")?;
        let rollback = self.capture();
        let conflict_count = self.conflicts.len();
        let applied_count = report.applied.len();
        let rejected_count = report.rejected.len();
        let retryable_count = report.retryable.len();
        let mut drained = Vec::new();
        let mut batch = ChangeAccumulator::default();
        let persisted = (|| {
            for frame in frames {
                let Frame::PushResult {
                    client_commit_id,
                    status,
                    results,
                    commit_seq,
                } = frame
                else {
                    return Err("unexpected acknowledgement frame".to_owned());
                };
                if !pushed_ids.contains(client_commit_id.as_str()) {
                    continue;
                }
                let Some(index) = self
                    .outbox
                    .iter()
                    .position(|commit| commit.client_commit_id == *client_commit_id)
                else {
                    continue;
                };
                let status = *status;
                let rejection_details = rejection_details_by_commit.get(client_commit_id);
                let operations = self.outbox[index].ops.clone();
                match status {
                    PushStatus::Applied | PushStatus::Cached => {
                        // §7.2: a lost ack replays as `cached` — proceed as if the
                        // ack had arrived.
                        let sequence =
                            commit_seq.ok_or_else(|| "ACK lacks a commit sequence".to_owned())?;
                        let affected: HashSet<_> = operations
                            .iter()
                            .map(|op| (op.table.as_str(), op.row_id.as_str()))
                            .collect();
                        let prior = self.acknowledged_operations(Some(&affected), None)?;
                        for (op_index, operation) in operations.iter().enumerate() {
                            let delivered: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM _syncular_row_deliveries WHERE tbl=?1 AND id=?2 AND commit_seq>=?3)", rusqlite::params![operation.table, operation.row_id, sequence], |row| row.get(0))
                                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                            if delivered {
                                continue;
                            }
                            let table = self
                                .schema
                                .table(&operation.table)
                                .ok_or_else(|| "sync.unknown_table".to_owned())?;
                            let mut intended: Map<String, Value> = self
                                .stored_row(table, &operation.row_id, true)?
                                .map(|(row, _)| {
                                    table
                                        .columns
                                        .iter()
                                        .zip(&row)
                                        .map(|(column, value)| {
                                            (column.name.clone(), column_value_to_json(value))
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            let mut scope_image = intended.clone();
                            for op in prior
                                .iter()
                                .chain(
                                    self.failed_commits
                                        .iter()
                                        .flat_map(|(commit, _)| &commit.ops),
                                )
                                .chain(
                                    self.outbox
                                        .iter()
                                        .take(index)
                                        .flat_map(|commit| &commit.ops),
                                )
                                .chain(operations.iter().take(op_index + 1))
                            {
                                if op.table != operation.table || op.row_id != operation.row_id {
                                    continue;
                                }
                                if let Some(values) = &op.values {
                                    intended.extend(values.clone());
                                } else {
                                    scope_image = intended.clone();
                                    intended.clear();
                                }
                            }
                            self.conn.execute("INSERT INTO _syncular_acked_rows(commit_id,idx,tbl,id,commit_seq,op_json,intent_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                                rusqlite::params![client_commit_id, op_index as i64, operation.table, operation.row_id, sequence,
                                    serde_json::to_string(&CommitOperation::from(operation)).map_err(|_| "sync.local_corrupt".to_owned())?,
                                    serde_json::to_string(if operation.upsert { &intended } else { &scope_image }).map_err(|_| "sync.local_corrupt".to_owned())?])
                                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                        }
                        let journal_results = results
                            .iter()
                            .map(|result| {
                                let op_index = match result {
                                    OpResult::Applied { op_index }
                                    | OpResult::Conflict { op_index, .. }
                                    | OpResult::Error { op_index, .. } => *op_index,
                                };
                                CommitOperationOutcome::Applied { op_index }
                            })
                            .collect::<Vec<_>>();
                        let outcome_status = if status == PushStatus::Applied {
                            CommitOutcomeStatus::Applied
                        } else {
                            CommitOutcomeStatus::Cached
                        };
                        let persisted = self
                            .persist_commit_outcome(
                                client_commit_id,
                                outcome_status,
                                &journal_results,
                                None,
                            )
                            .and_then(|()| self.delete_outbox_persisted(client_commit_id));
                        persisted?;
                        self.sync_needed = true;
                        batch.status = true;
                        batch.outcomes = true;
                    }
                    PushStatus::Rejected => {
                        if results.iter().any(|result| {
                            matches!(
                                result,
                                OpResult::Error {
                                    code,
                                    retryable: true,
                                    ..
                                } if code == "sync.idempotency_cache_miss"
                            )
                        }) {
                            // §6.3/§7.2: a serving failure, not an outcome — keep the
                            // exact commit queued for an identical retry.
                            report.retryable.push(client_commit_id.to_owned());
                            continue;
                        }

                        let mut journal_results = Vec::with_capacity(results.len());
                        let mut conflicts = Vec::new();
                        let mut rejections = Vec::new();
                        for result in results {
                            match result {
                                OpResult::Applied { op_index } => {
                                    journal_results.push(CommitOperationOutcome::Applied {
                                        op_index: *op_index,
                                    });
                                }
                                OpResult::Conflict {
                                    op_index,
                                    code,
                                    message,
                                    server_version,
                                    server_row,
                                    conflict_columns: conflict_columns_bitmap,
                                } => {
                                    let operation = operations
                                        .get(*op_index as usize)
                                        .map(CommitOperation::from);
                                    let (table, row_id) = operation
                                        .as_ref()
                                        .map(|op| (op.table.clone(), op.row_id.clone()))
                                        .unwrap_or_default();
                                    let server_row_json = self
                                        .schema
                                        .table(&table)
                                        .and_then(|t| {
                                            decode_row_bytes(t, server_row, &self.encryption)
                                                .ok()
                                                .map(|row| (t, row))
                                        })
                                        .map(|(t, row)| {
                                            let mut map = Map::new();
                                            for (i, column) in t.columns.iter().enumerate() {
                                                map.insert(
                                                    column.name.clone(),
                                                    column_value_to_json(
                                                        row.get(i).unwrap_or(&None),
                                                    ),
                                                );
                                            }
                                            map
                                        })
                                        .unwrap_or_default();
                                    // §6.3: decode the presence-layout bitmap
                                    // into the marked column names.
                                    let conflict_columns = self
                                        .schema
                                        .table(&table)
                                        .map(|t| {
                                            t.columns
                                                .iter()
                                                .enumerate()
                                                .filter(|(index, _)| {
                                                    conflict_columns_bitmap
                                                        .get(index / 8)
                                                        .is_some_and(|byte| {
                                                            byte & (1 << (index % 8)) != 0
                                                        })
                                                })
                                                .map(|(_, column)| column.name.clone())
                                                .collect::<Vec<_>>()
                                        })
                                        .unwrap_or_default();
                                    let conflict = ConflictRecord {
                                        client_commit_id: client_commit_id.to_owned(),
                                        op_index: *op_index,
                                        table,
                                        row_id,
                                        code: code.clone(),
                                        message: message.clone(),
                                        server_version: *server_version,
                                        server_row: server_row_json,
                                        conflict_columns,
                                        operation,
                                    };
                                    journal_results.push(CommitOperationOutcome::Conflict {
                                        conflict: conflict.clone(),
                                    });
                                    conflicts.push(conflict);
                                }
                                OpResult::Error {
                                    op_index,
                                    code,
                                    message,
                                    retryable,
                                } => {
                                    let rejection = RejectionRecord {
                                        client_commit_id: client_commit_id.to_owned(),
                                        op_index: *op_index,
                                        code: code.clone(),
                                        message: message.clone(),
                                        retryable: *retryable,
                                        details: rejection_details
                                            .and_then(|details| details.get(op_index))
                                            .cloned(),
                                        operation: operations
                                            .get(*op_index as usize)
                                            .map(CommitOperation::from),
                                    };
                                    journal_results.push(CommitOperationOutcome::Error {
                                        rejection: rejection.clone(),
                                    });
                                    rejections.push(rejection);
                                }
                            }
                        }
                        if self.retain_failed_commits {
                            self.retain_failed_commit(client_commit_id, &operations)?;
                        }
                        let outcome_status = if conflicts.is_empty() {
                            CommitOutcomeStatus::Rejected
                        } else {
                            CommitOutcomeStatus::Conflict
                        };
                        let persisted = self
                            .persist_commit_outcome(
                                client_commit_id,
                                outcome_status,
                                &journal_results,
                                Some(&operations),
                            )
                            .and_then(|()| self.delete_outbox_persisted(client_commit_id));
                        persisted?;
                        batch.conflicts = !conflicts.is_empty();
                        batch.rejections = !rejections.is_empty();
                        batch.status = true;
                        batch.outcomes = true;
                        self.conflicts.extend(conflicts);
                        self.rejections.extend(rejections);
                    }
                }
                drained.push(self.outbox.remove(index));
                if batch.status {
                    for operation in &operations {
                        if !self.record_row_scopes(
                            &mut batch,
                            &operation.table,
                            &operation.row_id,
                            false,
                        ) {
                            batch.table(&operation.table);
                        }
                    }
                }
                match status {
                    PushStatus::Applied | PushStatus::Cached => {
                        report.applied.push(client_commit_id.to_owned())
                    }
                    PushStatus::Rejected => report.rejected.push(client_commit_id.to_owned()),
                }
            }
            if batch.outcomes && frames.iter().any(|frame| matches!(frame, Frame::PushResult { client_commit_id, .. } if Some(client_commit_id.as_str()) == last_final_push_result_id)) {
                self.prune_commit_outcomes()?;
            }
            self.reconcile_rows(&drained)?;
            self.rebuild_overlay_if_dirty()?;
            self.finish_observation("syncular_push_results", batch)
        })();
        if let Err(error) = persisted {
            self.rollback_observation("syncular_push_results");
            self.restore(rollback);
            report.applied.truncate(applied_count);
            report.rejected.truncate(rejected_count);
            report.retryable.truncate(retryable_count);
            return Err(error);
        }
        if !rollback.sync_needed && self.sync_needed {
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
        }
        report.conflicts += (self.conflicts.len() - conflict_count) as u32;
        Ok(())
    }

    fn push_result_is_final(status: PushStatus, results: &[OpResult]) -> bool {
        status != PushStatus::Rejected
            || !results.iter().any(|result| {
                matches!(
                    result,
                    OpResult::Error {
                        code,
                        retryable: true,
                        ..
                    } if code == "sync.idempotency_cache_miss"
                )
            })
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
        sub_end: Option<(i64, Option<String>)>,
        meta: &RequestMeta,
        report: &mut SyncReport,
        coalesced_deletes: &HashSet<(i64, String, String)>,
    ) -> Result<(), SectionError> {
        let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
            return Ok(()); // unknown echo: ignore
        };
        if status != SubStatus::Active && sub_end.is_none() {
            return Err(SectionError::Abort(
                "sync.invalid_request".into(),
                "subscription section without SUB_END".into(),
            ));
        }
        match status {
            SubStatus::Revoked => {
                self.begin_observation("syncular_revocation")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let rollback = self.capture();
                let revoked_count = report.revoked.len();
                let failed_count = report.failed.len();
                let result = (|| {
                    let mut batch = ChangeAccumulator::default();
                    let registered = self.window_unit_by_sub_id(id);
                    // §3.3: stop pulling, purge exactly the last effective grant.
                    let (table, effective) = {
                        let sub = &self.subs[sub_index];
                        (sub.table.clone(), sub.effective.clone().unwrap_or_default())
                    };
                    let owners = self.scope_owners(&table, id);
                    let scoped_table = self.schema.table(&table).cloned().ok_or_else(|| {
                        SectionError::Abort(
                            "sync.unknown_table".to_owned(),
                            "revoked scope references an unknown table".to_owned(),
                        )
                    })?;
                    let dropped = self
                        .drop_failed_commits(|name, values| {
                            name == table
                                && owns_local_row(&scoped_table, &effective, &owners, values)
                        })
                        .map_err(|message| {
                            SectionError::Abort("storage.failed".to_owned(), message)
                        })?;
                    for commit in dropped {
                        batch.conflicts = true;
                        batch.rejections = true;
                        batch.outcomes = true;
                        for operation in commit.ops {
                            batch.table(&operation.table);
                        }
                    }
                    let purged = self.purge_scope_rows(&table, &effective, &owners);
                    match purged {
                        Ok(()) => {
                            self.record_scope_map(&mut batch, &table, &effective);
                            let sub = &mut self.subs[sub_index];
                            sub.state = SubState::Revoked;
                            sub.reason_code = Some(if reason_code.is_empty() {
                                "sync.scope_revoked".to_owned()
                            } else {
                                reason_code.to_owned()
                            });
                            report.revoked.push(id.to_owned());
                            self.persist_sub(&self.subs[sub_index].clone())
                                .map_err(|message| {
                                    SectionError::Abort("storage.failed".into(), message)
                                })?;
                            let dropped = self
                                .drop_doomed_outbox(&scoped_table, &effective, &owners)
                                .map_err(|message| {
                                    SectionError::Abort("storage.failed".to_owned(), message)
                                })?;
                            if dropped {
                                batch.status = true;
                                batch.rejections = true;
                                batch.outcomes = true;
                            }
                            // §5.9.7 B2: revocation deletes now-unauthorized blob
                            // bodies (evicted ≠ revoked).
                            self.delete_unreferenced_cached_blobs().map_err(|message| {
                                SectionError::Abort("storage.failed".into(), message)
                            })?;
                        }
                        Err(()) => {
                            // §3.3 fail closed: no local mapping — never clear by
                            // approximation; fatal configuration error.
                            let sub = &mut self.subs[sub_index];
                            sub.state = SubState::Failed;
                            sub.reason_code = Some("sync.scope_revoked".to_owned());
                            report.failed.push(id.to_owned());
                            self.persist_sub(&self.subs[sub_index].clone())
                                .map_err(|message| {
                                    SectionError::Abort("storage.failed".into(), message)
                                })?;
                        }
                    }
                    if let Some((base_key, unit)) = registered {
                        batch.window(&base_key, &self.subs[sub_index].table, &unit);
                    }
                    self.rebuild_overlay_if_dirty()
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    self.finish_observation("syncular_revocation", batch)
                        .map_err(|message| {
                            SectionError::Abort("storage.failed".to_owned(), message)
                        })?;
                    Ok(())
                })();
                if result.is_err() {
                    self.rollback_observation("syncular_revocation");
                    self.restore(rollback);
                    report.revoked.truncate(revoked_count);
                    report.failed.truncate(failed_count);
                }
                result
            }
            SubStatus::Reset => {
                self.begin_observation("syncular_reset")
                    .map_err(|message| SectionError::Abort("storage.failed".to_owned(), message))?;
                let rollback = self.capture();
                let reset_count = report.resets.len();
                let result = (|| {
                    let mut batch = ChangeAccumulator::default();
                    let registered = self.window_unit_by_sub_id(id);
                    // §4.6: discard cursor + bootstrap state, keep local rows —
                    // reset is a staleness signal, not a purge signal.
                    let sub = &mut self.subs[sub_index];
                    sub.cursor = -1;
                    sub.bootstrap_state = None;
                    sub.reason_code = Some(if reason_code.is_empty() {
                        "sync.cursor_expired".to_owned()
                    } else {
                        reason_code.to_owned()
                    });
                    report.resets.push(id.to_owned());
                    self.persist_sub(&self.subs[sub_index].clone())
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    if let Some((base_key, unit)) = registered {
                        batch.window(&base_key, &self.subs[sub_index].table, &unit);
                    }
                    self.finish_observation("syncular_reset", batch)
                        .map_err(|message| {
                            SectionError::Abort("storage.failed".to_owned(), message)
                        })?;
                    Ok(())
                })();
                if result.is_err() {
                    self.rollback_observation("syncular_reset");
                    self.restore(rollback);
                    report.resets.truncate(reset_count);
                }
                result
            }
            SubStatus::Active => {
                let fresh = meta
                    .fresh
                    .iter()
                    .find(|(fid, _)| fid == id)
                    .map(|(_, fresh)| *fresh)
                    .unwrap_or(false);
                let previous = self.subs[sub_index].clone();
                self.subs[sub_index].effective = Some(effective_scopes);
                let outcome = self
                    .apply_section_body(
                        transport,
                        sub_index,
                        body,
                        fresh,
                        meta,
                        report,
                        coalesced_deletes,
                    )
                    .and_then(|()| {
                        let (cursor, bootstrap_state) = sub_end.ok_or_else(|| {
                            SectionError::Abort(
                                "sync.invalid_request".into(),
                                "subscription section without SUB_END".into(),
                            )
                        })?;
                        self.apply_sub_end(sub_index, cursor, bootstrap_state)
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".into(), message)
                            })
                    });
                match outcome {
                    Ok(()) => {
                        if self.subs[sub_index].bootstrap_state.is_some() {
                            report.bootstrapping.push(id.to_owned());
                        }
                        Ok(())
                    }
                    Err(SectionError::FailClosed) => {
                        self.subs[sub_index] = previous.clone();
                        self.begin_observation("syncular_section_failure")
                            .map_err(|message| {
                                SectionError::Abort("storage.failed".into(), message)
                            })?;
                        let persisted = (|| {
                            let mut batch = ChangeAccumulator::default();
                            if let Some((base_key, unit)) = self.window_unit_by_sub_id(id) {
                                batch.window(&base_key, &self.subs[sub_index].table, &unit);
                            }
                            self.subs[sub_index].state = SubState::Failed;
                            self.subs[sub_index].reason_code = Some("sync.scope_revoked".into());
                            self.persist_sub(&self.subs[sub_index])?;
                            self.finish_observation("syncular_section_failure", batch)
                        })();
                        if let Err(message) = persisted {
                            self.rollback_observation("syncular_section_failure");
                            self.subs[sub_index] = previous;
                            return Err(SectionError::Abort("storage.failed".into(), message));
                        }
                        report.failed.push(id.to_owned());
                        Ok(())
                    }
                    Err(error) => {
                        // Frame/block transactions already completed. Preserve their
                        // rows and revisions, but leave this subscription cursor unchanged.
                        self.subs[sub_index] = previous;
                        Err(error)
                    }
                }
            }
        }
    }

    fn apply_sub_end(
        &mut self,
        sub_index: usize,
        cursor: i64,
        bootstrap_state: Option<String>,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::CursorPersist);
        let previous = self.subs[sub_index].clone();
        self.begin_observation("syncular_sub_end")?;
        let persisted = (|| {
            let mut batch = ChangeAccumulator::default();
            let completed = (previous.cursor < 0 || previous.bootstrap_state.is_some())
                && cursor >= 0
                && bootstrap_state.is_none();
            if completed {
                let table = self
                    .schema
                    .table(&previous.table)
                    .ok_or_else(|| "sync.unknown_table".to_owned())?;
                let effective = previous.effective.as_deref().unwrap_or(&[]);
                let mut statement = self.conn.prepare("SELECT id,intent_json FROM _syncular_acked_rows WHERE tbl=?1 AND commit_seq<=?2")
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let rows = statement
                    .query_map(rusqlite::params![previous.table, cursor], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let mut covered = HashSet::new();
                for row in rows {
                    let (id, intent) =
                        row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                    let values: Map<String, Value> = serde_json::from_str(&intent)
                        .map_err(|_| "sync.local_corrupt".to_owned())?;
                    if !effective.is_empty()
                        && effective.iter().all(|(variable, allowed)| {
                            table
                                .scope_column(variable)
                                .and_then(|column| values.get(column))
                                .is_some_and(|value| {
                                    allowed.contains(
                                        &value
                                            .as_str()
                                            .map_or_else(|| value.to_string(), str::to_owned),
                                    )
                                })
                        })
                    {
                        covered.insert(id);
                    }
                }
                drop(statement);
                for id in covered {
                    self.conn.execute("DELETE FROM _syncular_acked_rows WHERE tbl=?1 AND id=?2 AND commit_seq<=?3", rusqlite::params![previous.table, id, cursor])
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                    self.overlay_dirty.table(&previous.table);
                    batch.table(&previous.table);
                }
                self.rebuild_overlay_if_dirty()?;
                if let Some((base_key, unit)) = self.window_unit_by_sub_id(&previous.id) {
                    batch.window(&base_key, &previous.table, &unit);
                }
            }
            let sub = &mut self.subs[sub_index];
            sub.cursor = cursor;
            sub.bootstrap_state = bootstrap_state;
            // §4.6: a completed (or continuing) active end clears the reset /
            // revocation reason, matching the TS core's active-state persist.
            sub.reason_code = None;
            sub.synced_once = true;
            self.persist_sub(&self.subs[sub_index])?;
            self.finish_observation("syncular_sub_end", batch)
        })();
        if persisted.is_err() {
            self.rollback_observation("syncular_sub_end");
            self.subs[sub_index] = previous;
        }
        persisted
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_section_body(
        &mut self,
        transport: &mut dyn Transport,
        sub_index: usize,
        body: Vec<Frame>,
        fresh: bool,
        meta: &RequestMeta,
        report: &mut SyncReport,
        coalesced_deletes: &HashSet<(i64, String, String)>,
    ) -> Result<(), SectionError> {
        let mut saw_segment = false;
        for frame in body {
            match frame {
                Frame::Commit {
                    tables,
                    changes,
                    commit_seq,
                    ..
                } => {
                    if self
                        .apply_commit_frame_coalesced(
                            &tables,
                            changes,
                            commit_seq,
                            coalesced_deletes,
                            sub_index,
                            AppliedServerCommitSource::Pull,
                        )
                        .map_err(|(c, m)| SectionError::Abort(c, m))?
                    {
                        report.commits_applied += 1;
                    }
                }
                Frame::SegmentInline { payload } => {
                    let segment = decode_rows_segment(&payload)
                        .map_err(|e| SectionError::Abort(e.code.as_str().to_owned(), e.detail))?;
                    self.progress.update(|p| {
                        p.phase = ProgressPhase::Import;
                        p.subscription_id = Some(self.subs[sub_index].id.clone());
                        p.table = Some(self.subs[sub_index].table.clone());
                        p.segment_id = None;
                        p.bytes_received = payload.len() as u64;
                        p.bytes_total = Some(payload.len() as u64);
                        p.rows_processed = 0;
                        p.rows_total =
                            Some(segment.blocks.iter().map(|block| block.len() as u64).sum());
                    });
                    let first = !saw_segment;
                    saw_segment = true;
                    let applied = self.apply_segment(sub_index, &segment, fresh && first)?;
                    report.segment_rows_applied += applied;
                }
                Frame::SegmentRef {
                    segment_id,
                    byte_length,
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
                    self.progress.update(|p| {
                        p.phase = ProgressPhase::Download;
                        p.subscription_id = Some(self.subs[sub_index].id.clone());
                        p.table = Some(table.clone());
                        p.segment_id = Some(segment_id.clone());
                        p.bytes_received = 0;
                        p.bytes_total = u64::try_from(byte_length).ok();
                        p.rows_processed = 0;
                        p.rows_total = u64::try_from(row_count).ok();
                    });
                    let observer = self.progress.clone();
                    let mut on_progress = |bytes| observer.update(|p| p.bytes_received = bytes);
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
                        if url_expires_at_ms.is_some_and(|exp| {
                            exp <= transport
                                .segment_fetch_started_at(&url)
                                .unwrap_or_else(|| self.clock_now_ms())
                        }) {
                            return Err(SectionError::Abort(
                                "sync.segment_expired".to_owned(),
                                format!(
                                    "signed URL for segment {segment_id} expired before fetch — re-pull mints fresh descriptors (§5.4)"
                                ),
                            ));
                        }
                        transport
                            .fetch_url(
                                &url,
                                u64::try_from(byte_length).unwrap_or(0),
                                &mut on_progress,
                            )
                            .map_err(|e| self.segment_fetch_failed(e))?
                    } else {
                        let requested_scopes_json =
                            canonical_scope_json(&self.subs[sub_index].requested);
                        transport
                            .download_segment(
                                &SegmentRequest {
                                    segment_id: segment_id.clone(),
                                    table,
                                    requested_scopes_json,
                                    byte_length: u64::try_from(byte_length).unwrap_or(0),
                                },
                                &mut on_progress,
                            )
                            .map_err(|e| self.segment_fetch_failed(e))?
                    };
                    // §5.4: the descriptor's byteLength caps the body before
                    // §5.1 verifies the content address; the client discards
                    // the segment and re-pulls on either failure.
                    if bytes.len() as i64 > byte_length {
                        self.schedule_background_retry();
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            "segment exceeds its byteLength".to_owned(),
                        ));
                    }
                    on_progress(bytes.len() as u64);
                    let digest = Sha256::digest(&bytes);
                    let expected = segment_id
                        .strip_prefix("sha256:")
                        .unwrap_or(segment_id.as_str());
                    if bytes_to_hex(&digest) != expected {
                        // §5.1: the client discards the segment and re-pulls.
                        self.schedule_background_retry();
                        return Err(SectionError::Abort(
                            "sync.invalid_request".to_owned(),
                            "segment bytes do not match the content address (§5.1)".to_owned(),
                        ));
                    }
                    self.progress.update(|p| p.phase = ProgressPhase::Import);
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
                Frame::Error { code, message, .. } => {
                    return Err(SectionError::Abort(code, message))
                }
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

    /// Apply one commit frame after dropping a scope move's duplicate delete
    /// when the same commit carries the row's upsert in another applied
    /// section (§2.2). A frame that carried both itself is untouched.
    fn apply_commit_frame_coalesced(
        &mut self,
        tables: &[String],
        changes: Vec<ssp2::model::Change>,
        commit_seq: i64,
        coalesced_deletes: &HashSet<(i64, String, String)>,
        sub_index: usize,
        source: AppliedServerCommitSource,
    ) -> Result<bool, (String, String)> {
        let changes: Vec<ssp2::model::Change> = changes
            .into_iter()
            .filter(|change| {
                if change.op != Op::Delete {
                    return true;
                }
                let Some(table) = tables.get(change.table_index as usize) else {
                    return true;
                };
                !coalesced_deletes.contains(&(commit_seq, table.clone(), change.row_id.clone()))
            })
            .collect();
        if changes.is_empty() {
            return Ok(false);
        }
        let affected_tables = changes
            .iter()
            .filter_map(|change| tables.get(change.table_index as usize))
            .cloned()
            .collect::<BTreeSet<_>>();
        let previous_batches = self.change_queue.len();
        self.apply_commit_frame(tables, &changes, Some(commit_seq))?;
        if self.change_queue.len() > previous_batches {
            let subscription_id = self.subs[sub_index].id.clone();
            if let Some(batch) = self.change_queue.back_mut() {
                batch
                    .applied_commits
                    .extend(
                        affected_tables
                            .into_iter()
                            .map(|table| AppliedServerCommit {
                                subscription_id: subscription_id.clone(),
                                table,
                                commit_seq,
                                source,
                            }),
                    );
            }
        }
        Ok(true)
    }

    // Both pull and realtime frames use the same durable observation boundary.
    fn apply_commit_frame(
        &mut self,
        tables: &[String],
        changes: &[ssp2::model::Change],
        commit_seq: Option<i64>,
    ) -> Result<(), (String, String)> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::CommitApply);
        let rollback = self.capture();
        self.coalesce_unit(changes.len())
            .and_then(|()| self.begin_observation("syncular_commit"))
            .map_err(|message| ("storage.failed".into(), message))?;
        let applied = (|| {
            let mut batch = ChangeAccumulator::default();
            self.record_commit_changes(&mut batch, tables, changes);
            if let Some(sequence) = commit_seq {
                let storage_failed = |error| {
                    (
                        "storage.failed".to_owned(),
                        Self::sqlite_failure(&self.storage_failure, error),
                    )
                };
                let pinned: HashSet<(&str, &str)> = self
                    .outbox
                    .iter()
                    .flat_map(|commit| &commit.ops)
                    .map(|op| (op.table.as_str(), op.row_id.as_str()))
                    .collect();
                for change in changes {
                    let table = tables.get(change.table_index as usize).ok_or_else(|| {
                        (
                            "sync.invalid_request".to_owned(),
                            "change tableIndex out of range".to_owned(),
                        )
                    })?;
                    if pinned.contains(&(table.as_str(), change.row_id.as_str())) {
                        self.conn.prepare_cached("INSERT INTO _syncular_row_deliveries(tbl,id,commit_seq) VALUES (?1,?2,?3) ON CONFLICT(tbl,id) DO UPDATE SET commit_seq=MAX(commit_seq,excluded.commit_seq)")
                            .and_then(|mut statement| statement.execute(rusqlite::params![table, change.row_id, sequence]))
                            .map_err(storage_failed)?;
                    }
                    self.conn.prepare_cached("DELETE FROM _syncular_acked_rows WHERE tbl=?1 AND id=?2 AND commit_seq<=?3")
                        .and_then(|mut statement| statement.execute(rusqlite::params![table, change.row_id, sequence]))
                        .map_err(storage_failed)?;
                }
            }
            self.apply_commit_changes(tables, changes)?;
            self.rebuild_overlay_if_dirty()
                .map_err(|message| ("storage.failed".into(), message))?;
            self.finish_observation("syncular_commit", batch)
                .map_err(|message| ("storage.failed".into(), message))
        })();
        if applied.is_err() {
            self.rollback_observation("syncular_commit");
            self.restore(rollback);
        }
        applied
    }

    fn apply_commit_changes(
        &mut self,
        tables: &[String],
        changes: &[ssp2::model::Change],
    ) -> Result<(), (String, String)> {
        // A clean overlay can reconcile changed primary keys independently
        // when their tables have no secondary unique constraints. Such a
        // constraint can change whether another row's write succeeds, so a
        // table with one and any local intent takes the table rebuild.
        let changed_tables: BTreeSet<&str> = changes
            .iter()
            .filter_map(|change| tables.get(change.table_index as usize))
            .map(String::as_str)
            .collect();
        let mut mirror_visible = !self.overlay_dirty.get();
        for name in &changed_tables {
            if mirror_visible
                && self
                    .schema
                    .table(name)
                    .is_some_and(|table| table.indexes.iter().any(|index| index.unique))
            {
                let (pending, protected) = self
                    .table_intent(name)
                    .map_err(|message| ("storage.failed".to_owned(), message))?;
                mirror_visible = !pending && !protected;
            }
        }
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
                    // §5.11: decrypt encrypted columns on apply.
                    let row = {
                        #[cfg(feature = "bench-internals")]
                        let _phase = self.benchmark_phases.start(Phase::RowDecode);
                        decode_row_bytes(table, payload, &self.encryption).map_err(|m| {
                            // §5.11: a decrypt failure keeps its own identity.
                            match m.strip_prefix("client.decrypt_failed: ") {
                                Some(detail) => {
                                    ("client.decrypt_failed".to_owned(), detail.to_owned())
                                }
                                None => ("sync.invalid_request".to_owned(), m),
                            }
                        })?
                    };
                    let version = change.row_version.unwrap_or(0);
                    let table_name = table.name.clone();
                    self.write_base_row(&table_name, &row, version)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    if mirror_visible {
                        self.write_row(&visible_table(&table_name), &table_name, &row, version)
                            .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    }
                }
                Op::Delete => {
                    self.delete_base_row(table_name, &change.row_id)
                        .map_err(|m| ("sync.invalid_request".to_owned(), m))?;
                    if mirror_visible {
                        let sql = format!(
                            "DELETE FROM {} WHERE {}",
                            visible_table(table_name),
                            row_id_predicate(table)
                        );
                        self.conn
                            .prepare_cached(&sql)
                            .and_then(|mut statement| {
                                statement.execute(rusqlite::params![change.row_id])
                            })
                            .map_err(|error| {
                                ("sync.invalid_request".to_owned(), error.to_string())
                            })?;
                    }
                }
            }
        }
        if mirror_visible {
            let changed_rows: HashSet<(&str, &str)> = changes
                .iter()
                .map(|change| {
                    (
                        tables[change.table_index as usize].as_str(),
                        change.row_id.as_str(),
                    )
                })
                .collect();
            self.replay_overlay(&changed_tables, Some(&changed_rows))
                .map_err(|message| ("storage.failed".to_owned(), message))?;
            self.overlay_dirty.set(false);
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
        let (sub_table, effective, owners) = {
            let sub = &self.subs[sub_index];
            (
                sub.table.clone(),
                sub.effective.clone().unwrap_or_default(),
                self.scope_owners(&sub.table, &sub.id),
            )
        };
        let table = self.schema.table(&sub_table).cloned().ok_or_else(|| {
            SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                format!("subscription table {sub_table:?} is not in the client schema"),
            )
        })?;
        // §5.2: the column table validates against the generated schema —
        // order, names, types, nullability; mismatch is fatal. §5.11: the
        // server sends the WIRE types (bytes for an encrypted column), so
        // validate against wire_columns.
        let matches = segment.table == table.name
            && segment.schema_version == self.schema.version
            && segment.columns.len() == table.wire_columns.len()
            && segment
                .columns
                .iter()
                .zip(table.wire_columns.iter())
                .all(|(a, b)| a.name == b.name && a.ty == b.ty && a.nullable == b.nullable);
        if !matches {
            return Err(SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                "segment column table does not match the generated schema (§5.2)".to_owned(),
            ));
        }
        let mut applied = 0u32;
        let empty = Vec::new();
        let blocks = if segment.blocks.is_empty() {
            std::slice::from_ref(&empty)
        } else {
            &segment.blocks
        };
        for (index, block) in blocks.iter().enumerate() {
            let clear = first_fresh_page && index == 0;
            if !clear && block.is_empty() {
                continue;
            }
            let rollback = self.capture();
            let (pending, protected) = self
                .table_intent(&table.name)
                .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
            let reconcile_pending =
                !protected && pending && table.indexes.iter().any(|index| index.unique);
            let mirror_visible = !protected && !reconcile_pending;
            self.coalesce_unit(block.len())
                .and_then(|()| self.begin_observation("syncular_segment_block"))
                .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
            let outcome = (|| {
                self.rebuild_overlay_if_dirty()
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                let mut changed_keys = Vec::new();
                let mut batch = ChangeAccumulator::default();
                if !block.is_empty()
                    || (clear && self.scoped_rows_exist(&table.name, &effective, &owners))
                {
                    batch.table(&table.name);
                }
                if clear {
                    self.purge_scope_rows(&table.name, &effective, &owners)
                        .map_err(|()| SectionError::FailClosed)?;
                }
                for (row_index, row) in block.iter().enumerate() {
                    let decrypted;
                    let values = if table.has_encrypted_columns() {
                        let mut values = row.values.clone();
                        crate::values::decrypt_segment_row(&table, &mut values, &self.encryption)
                            .map_err(|message| {
                            SectionError::Abort("client.decrypt_failed".into(), message)
                        })?;
                        decrypted = values;
                        &decrypted
                    } else {
                        &row.values
                    };
                    self.write_base_row(&table.name, values, row.server_version)
                        .map_err(|message| {
                            SectionError::Abort("sync.invalid_request".into(), message)
                        })?;
                    if reconcile_pending {
                        changed_keys.push(
                            owned_sql_value(RowParam::Cell(&values[table.pk_index])).map_err(
                                |message| SectionError::Abort("storage.failed".into(), message),
                            )?,
                        );
                    }
                    if mirror_visible {
                        self.write_row(
                            &visible_table(&table.name),
                            &table.name,
                            values,
                            row.server_version,
                        )
                        .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                    }
                    let processed = u64::from(applied) + row_index as u64 + 1;
                    if processed.is_multiple_of(1024) {
                        self.progress.update(|p| p.rows_processed = processed);
                    }
                }
                self.reconcile_import(&table, &mut changed_keys, protected, reconcile_pending)
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                self.finish_observation("syncular_segment_block", batch)
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))
            })();
            if let Err(error) = outcome {
                self.rollback_observation("syncular_segment_block");
                self.restore(rollback);
                return Err(error);
            }
            applied += block.len() as u32;
            self.progress
                .update(|p| p.rows_processed = u64::from(applied));
            std::thread::yield_now();
        }
        self.progress
            .update(|p| p.rows_processed = u64::from(applied));
        Ok(applied)
    }

    /// §5.3 sqlite-image application: validate the in-file metadata
    /// against the descriptor, validate column names/order against the
    /// generated schema, run the §5.6 first-page clear when fresh, then
    /// replace-or-upsert every image row with its `_syncular_version`.
    /// Mechanics: the image lands in a temp file read through a second
    /// rusqlite connection, equivalent to ATTACH + INSERT…SELECT.
    /// Each image chunk commits its writes and revision before readers continue.
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
        let (sub_table, effective, owners) = {
            let sub = &self.subs[sub_index];
            (
                sub.table.clone(),
                sub.effective.clone().unwrap_or_default(),
                self.scope_owners(&sub.table, &sub.id),
            )
        };
        let table = self.schema.table(&sub_table).cloned().ok_or_else(|| {
            SectionError::Abort(
                "sync.schema_mismatch".to_owned(),
                format!("subscription table {sub_table:?} is not in the client schema"),
            )
        })?;
        // §5.11: an image bypasses the decrypt seam, so a server cannot serve
        // one for a table with encrypted columns.
        if table.has_encrypted_columns() {
            return Err(invalid("table has encrypted columns"));
        }

        // The image lands beside the replica so it shares the replica's
        // directory permissions and volume; an in-memory replica has no
        // directory and uses the system temp dir. The file is owner-only.
        let directory = self
            .previous_version_replica_path()
            .and_then(|replica| std::path::Path::new(&replica).parent().map(Into::into))
            .unwrap_or_else(std::env::temp_dir);
        let path = directory.join(format!(".syncular-image-{}.tmp", uuid::Uuid::new_v4()));
        let outcome = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            std::io::Write::write_all(
                &mut options
                    .open(&path)
                    .map_err(|_| invalid("image temp file write failed"))?,
                bytes,
            )
            .map_err(|_| invalid("image temp file write failed"))?;
            let img = rusqlite::Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|_| invalid("bytes do not open as a SQLite database"))?;
            self.apply_sqlite_image(
                &img,
                &table,
                first_fresh_page,
                &effective,
                &owners,
                row_count,
                as_of_commit_seq,
                scope_digest,
            )
        })();
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
        owners: &[Vec<(String, Vec<String>)>],
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
        let mut primary_keys: Vec<String> = Vec::new();
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
                if row
                    .get::<_, i64>(5)
                    .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?
                    > 0
                {
                    primary_keys.push(row.get(1).map_err(|error| {
                        invalid(Self::sqlite_failure(&self.storage_failure, error))
                    })?);
                }
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

        if primary_keys != vec![table.primary_key.clone()] {
            return Err(invalid(
                "image primary key does not match generated schema".into(),
            ));
        }
        let actual_count: i64 = img
            .query_row(
                &format!("SELECT count(*) FROM {}", quote_ident(&table.name)),
                [],
                |row| row.get(0),
            )
            .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?;
        if actual_count != row_count {
            return Err(invalid("image row count does not match descriptor".into()));
        }
        let insert = self.insert_row_sql(&base_table(&table.name), table);
        let visible_insert = self.insert_row_sql(&visible_table(&table.name), table);
        let column_list = names
            .iter()
            .map(|n| quote_ident(n))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = img
            .prepare(&format!(
                "SELECT {column_list} FROM {} ORDER BY {}",
                quote_ident(&table.name),
                quote_ident(&table.primary_key)
            ))
            .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?;
        let mut rows = stmt
            .query([])
            .map_err(|error| invalid(Self::sqlite_failure(&self.storage_failure, error)))?;
        let mut applied = 0u32;
        loop {
            let clear = applied == 0 && first_fresh_page;
            let rollback = self.capture();
            let (pending, protected) = self
                .table_intent(&table.name)
                .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
            let reconcile_pending =
                !protected && pending && table.indexes.iter().any(|index| index.unique);
            let mirror_visible = !protected && !reconcile_pending;
            // A chunk holds up to 1,024 rows (§5.3).
            self.coalesce_unit(1024)
                .and_then(|()| self.begin_observation("syncular_image_chunk"))
                .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
            let result = (|| {
                self.rebuild_overlay_if_dirty()
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                let mut changed_keys = Vec::new();
                let mut batch = ChangeAccumulator::default();
                if clear {
                    if self.scoped_rows_exist(&table.name, effective, owners) {
                        batch.table(&table.name);
                    }
                    self.purge_scope_rows(&table.name, effective, owners)
                        .map_err(|()| SectionError::FailClosed)?;
                }
                let mut processed = 0u32;
                {
                    let mut ins = self.conn.prepare_cached(&insert).map_err(|error| {
                        invalid(Self::sqlite_failure(&self.storage_failure, error))
                    })?;
                    let mut mirror = if mirror_visible {
                        Some(self.conn.prepare_cached(&visible_insert).map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?)
                    } else {
                        None
                    };
                    for _ in 0..1024 {
                        let Some(row) = rows.next().map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?
                        else {
                            break;
                        };
                        for (i, column) in table.columns.iter().enumerate() {
                            let cell = row.get_ref(i).map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                            let param = image_cell_param(column, cell).map_err(invalid)?;
                            ins.raw_bind_parameter(i + 1, &param).map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                            if let Some(mirror) = &mut mirror {
                                mirror.raw_bind_parameter(i + 1, &param).map_err(|error| {
                                    invalid(Self::sqlite_failure(&self.storage_failure, error))
                                })?;
                            }
                        }
                        let version_index = table.columns.len();
                        let version: i64 = row.get(version_index).map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?;
                        if version < 1 {
                            return Err(invalid("image row version must be positive".into()));
                        }
                        ins.raw_bind_parameter(version_index + 1, version)
                            .map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                        ins.raw_execute().map_err(|error| {
                            invalid(Self::sqlite_failure(&self.storage_failure, error))
                        })?;
                        if let Some(mirror) = &mut mirror {
                            mirror
                                .raw_bind_parameter(version_index + 1, version)
                                .map_err(|error| {
                                    invalid(Self::sqlite_failure(&self.storage_failure, error))
                                })?;
                            mirror.raw_execute().map_err(|error| {
                                invalid(Self::sqlite_failure(&self.storage_failure, error))
                            })?;
                        }
                        if reconcile_pending {
                            changed_keys.push(row.get::<_, SqlValue>(table.pk_index).map_err(
                                |error| invalid(Self::sqlite_failure(&self.storage_failure, error)),
                            )?);
                        }
                        processed += 1;
                    }
                }
                if processed > 0 {
                    batch.table(&table.name);
                    self.overlay_dirty.table(&table.name);
                }
                self.reconcile_import(table, &mut changed_keys, protected, reconcile_pending)
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                self.finish_observation("syncular_image_chunk", batch)
                    .map_err(|message| SectionError::Abort("storage.failed".into(), message))?;
                Ok(processed)
            })();
            let processed = match result {
                Ok(processed) => processed,
                Err(error) => {
                    self.rollback_observation("syncular_image_chunk");
                    self.restore(rollback);
                    return Err(error);
                }
            };
            applied += processed;
            self.progress
                .update(|p| p.rows_processed = u64::from(applied));
            std::thread::yield_now();
            if processed < 1024 || i64::from(applied) == actual_count {
                break;
            }
        }
        if i64::from(applied) != actual_count {
            return Err(invalid(format!(
                "image yielded {applied} rows, expected {actual_count}"
            )));
        }
        Ok(applied)
    }

    /// §7.1 keyed reconciliation of the rows `drained` commits touch: restore
    /// them from the base and replay their remaining intent. A table with a
    /// secondary unique index restores and replays every row with intent,
    /// since one row's value can admit or defer another row's write.
    fn reconcile_rows(&self, drained: &[Arc<OutboxCommit>]) -> Result<(), String> {
        let names: BTreeSet<&str> = drained
            .iter()
            .flat_map(|commit| &commit.ops)
            .map(|op| op.table.as_str())
            .collect();
        for name in names {
            let Some(table) = self.schema.table(name) else {
                continue;
            };
            let ops = drained.iter().flat_map(|commit| &commit.ops);
            let tables = BTreeSet::from([name]);
            let rows: HashSet<_> = ops
                .clone()
                .map(|op| (op.table.as_str(), op.row_id.as_str()))
                .collect();
            let unique = table.indexes.iter().any(|index| index.unique);
            let acknowledged = if unique {
                self.acknowledged_operations(None, Some(&tables))?
            } else {
                Vec::new()
            };
            let peers = acknowledged
                .iter()
                .chain(
                    self.failed_commits
                        .iter()
                        .flat_map(|(commit, _)| &commit.ops),
                )
                .chain(self.outbox.iter().flat_map(|commit| &commit.ops))
                .filter(|_| unique);
            self.restore_base_rows(table, &mut Vec::new(), peers.chain(ops.clone()))?;
            self.replay_overlay(&tables, (!unique).then_some(&rows))?;
        }
        Ok(())
    }

    /// Whether `table` has pending outbox intent, and whether it has protected
    /// (acknowledged or retained failed) intent.
    fn table_intent(&self, table: &str) -> Result<(bool, bool), String> {
        let touches = |op: &OutboxOp| op.table == table;
        Ok((
            self.outbox
                .iter()
                .flat_map(|commit| &commit.ops)
                .any(touches),
            self.failed_commits
                .iter()
                .flat_map(|(commit, _)| &commit.ops)
                .any(touches)
                || self
                    .conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM _syncular_acked_rows WHERE tbl=?1)",
                        [table],
                        |row| row.get(0),
                    )
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
        ))
    }

    /// §7.1 reconciliation after an import block or chunk. Keyed replay covers
    /// only pending intent, so a table with protected intent rebuilds; a
    /// `restore` restores the imported `keys` and every pending row first.
    fn reconcile_import(
        &mut self,
        table: &TableSchema,
        keys: &mut Vec<SqlValue>,
        protected: bool,
        restore: bool,
    ) -> Result<(), String> {
        if protected {
            return self.rebuild_overlay_if_dirty();
        }
        let pending = self.outbox.iter().flat_map(|commit| &commit.ops);
        if restore {
            self.restore_base_rows(table, keys, pending.clone())?;
        }
        self.apply_outbox_ops(pending.filter(|op| op.table == table.name))?;
        self.overlay_dirty.set(false);
        Ok(())
    }

    /// Restore the visible rows of `keys` and of the rows `ops` touch in
    /// `table` from the base before the caller replays their intent. The
    /// caller owns the transaction and publishes its revision after replay.
    fn restore_base_rows<'a>(
        &self,
        table: &TableSchema,
        keys: &mut Vec<SqlValue>,
        ops: impl IntoIterator<Item = &'a OutboxOp>,
    ) -> Result<(), String> {
        let visible = visible_table(&table.name);
        let base = base_table(&table.name);
        let pk = quote_ident(&table.primary_key);
        let predicate = row_id_predicate(table);
        let mut lookup = self.conn.prepare_cached(&format!(
            "SELECT {pk} FROM {base} WHERE {predicate} UNION SELECT {pk} FROM {visible} WHERE {predicate}"
        )).map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut deleted = HashSet::new();
        for op in ops.into_iter().filter(|op| op.table == table.name) {
            if op.upsert {
                if let Some(values) = &op.values {
                    let key = json_to_column_value(
                        &table.columns[table.pk_index],
                        values.get(&table.primary_key),
                    )?;
                    keys.push(owned_sql_value(RowParam::Cell(&key))?);
                }
            } else if deleted.insert(&op.row_id) {
                keys.extend(
                    lookup
                        .query_map([&op.row_id], |row| row.get::<_, SqlValue>(0))
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
                );
            }
        }
        // Delete the complete affected set before restoring any base value, so
        // old optimistic unique values cannot collide with the new server rows.
        for chunk in keys.chunks(400) {
            let holes = vec!["?"; chunk.len()].join(",");
            self.conn
                .prepare_cached(&format!("DELETE FROM {visible} WHERE {pk} IN ({holes})"))
                .and_then(|mut statement| statement.execute(rusqlite::params_from_iter(chunk)))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        let updates = table
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .chain(std::iter::once("_syncular_version"))
            .filter(|name| *name != table.primary_key)
            .map(|name| {
                let name = quote_ident(name);
                format!("{name}=excluded.{name}")
            })
            .collect::<Vec<_>>()
            .join(",");
        for chunk in keys.chunks(400) {
            let holes = vec!["?"; chunk.len()].join(",");
            self.conn.prepare_cached(&format!("INSERT INTO {visible} SELECT * FROM {base} WHERE {pk} IN ({holes}) ON CONFLICT ({pk}) DO UPDATE SET {updates}"))
                .and_then(|mut statement| statement.execute(rusqlite::params_from_iter(chunk)))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(())
    }

    // -- application-authorized local purge ---------------------------------------

    fn compile_local_data_purge(
        &self,
        input: &LocalDataPurgeInput,
    ) -> Result<(Vec<CompiledLocalDataPurgeTarget>, String), String> {
        let invalid = |message: String| format!("sync.invalid_request: {message}");
        if input.purge_id.is_empty()
            || input.purge_id.len() > 128
            || !is_local_operation_code_like(&input.purge_id)
        {
            return Err(invalid(
                "local purge purgeId must be a 1–128 character code-like identifier".to_owned(),
            ));
        }
        if input.targets.is_empty() || input.targets.len() > MAX_LOCAL_PURGE_TARGETS {
            return Err(invalid(format!(
                "local purge needs between 1 and {MAX_LOCAL_PURGE_TARGETS} targets"
            )));
        }

        let mut deduplicated: BTreeMap<
            String,
            (CompiledLocalDataPurgeTarget, LocalDataPurgeTarget),
        > = BTreeMap::new();
        for target in &input.targets {
            let table = self.schema.table(&target.table).ok_or_else(|| {
                invalid(format!(
                    "local purge names unknown table {:?}",
                    target.table
                ))
            })?;
            if target.selectors.is_empty() || target.selectors.len() > MAX_LOCAL_PURGE_SELECTORS {
                return Err(invalid(format!(
                    "local purge target {:?} needs between 1 and {MAX_LOCAL_PURGE_SELECTORS} selectors",
                    target.table
                )));
            }
            let mut selectors = Vec::with_capacity(target.selectors.len());
            let mut canonical_selectors = BTreeMap::new();
            for (column_name, raw_values) in &target.selectors {
                let Some((column_index, column)) = table
                    .columns
                    .iter()
                    .enumerate()
                    .find(|(_, column)| column.name == *column_name)
                else {
                    return Err(invalid(format!(
                        "local purge target {:?} names unknown column {:?}",
                        target.table, column_name
                    )));
                };
                let encrypted = table
                    .encrypted_columns
                    .iter()
                    .any(|candidate| candidate.index == column_index);
                if column.ty != ColumnType::String || encrypted {
                    return Err(invalid(format!(
                        "local purge selector {:?}.{:?} must be a plaintext string column",
                        target.table, column_name
                    )));
                }
                if raw_values.is_empty() || raw_values.len() > MAX_LOCAL_PURGE_VALUES {
                    return Err(invalid(format!(
                        "local purge selector {:?}.{:?} needs between 1 and {MAX_LOCAL_PURGE_VALUES} values",
                        target.table, column_name
                    )));
                }
                let mut values = raw_values.clone();
                values.sort();
                values.dedup();
                if values.iter().any(|value| {
                    value.is_empty()
                        || value.len() > MAX_LOCAL_PURGE_VALUE_LENGTH
                        || !is_local_operation_code_like(value)
                }) {
                    return Err(invalid(format!(
                        "local purge selector values must be 1–{MAX_LOCAL_PURGE_VALUE_LENGTH} character code-like identifiers"
                    )));
                }
                selectors.push((column_name.clone(), values.clone()));
                canonical_selectors.insert(column_name.clone(), values);
            }
            let canonical = LocalDataPurgeTarget {
                table: target.table.clone(),
                selectors: canonical_selectors,
            };
            let key = serde_json::to_string(&canonical).map_err(|error| error.to_string())?;
            deduplicated.insert(
                key,
                (
                    CompiledLocalDataPurgeTarget {
                        table: target.table.clone(),
                        selectors,
                    },
                    canonical,
                ),
            );
        }
        let targets = deduplicated
            .values()
            .map(|(compiled, _)| compiled.clone())
            .collect::<Vec<_>>();
        let canonical = deduplicated
            .values()
            .map(|(_, target)| target.clone())
            .collect::<Vec<_>>();
        let canonical_plan =
            serde_json::to_string(&canonical).map_err(|error| error.to_string())?;
        Ok((targets, canonical_plan))
    }

    fn local_purge_base_row_ids(
        &self,
        targets: &[CompiledLocalDataPurgeTarget],
    ) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
        let mut by_table: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for target in targets {
            let table = self
                .schema
                .table(&target.table)
                .ok_or_else(|| format!("sync.invalid_request: unknown table {:?}", target.table))?;
            let mut clauses = Vec::with_capacity(target.selectors.len());
            let mut params = Vec::new();
            for (column, values) in &target.selectors {
                clauses.push(format!(
                    "{} IN ({})",
                    quote_ident(column),
                    values.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
                ));
                params.extend(values.iter().cloned().map(SqlValue::Text));
            }
            let sql = format!(
                "SELECT CAST({} AS TEXT) FROM {} WHERE {}",
                quote_ident(&table.primary_key),
                base_table(&target.table),
                clauses.join(" AND ")
            );
            let mut statement = self
                .conn
                .prepare(&sql)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(params), |row| {
                    let value = sql_ref_to_json(&table.columns[table.pk_index], row.get_ref(0)?);
                    render_row_id_json(Some(&value))
                        .map_err(|message| rusqlite::Error::ToSqlConversionFailure(message.into()))
                })
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let ids = by_table.entry(target.table.clone()).or_default();
            for row in rows {
                ids.insert(
                    row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?,
                );
            }
        }
        Ok(by_table)
    }

    fn local_purge_values_match(
        target: &CompiledLocalDataPurgeTarget,
        values: &Map<String, Value>,
    ) -> bool {
        target.selectors.iter().all(|(column, allowed)| {
            values
                .get(column)
                .and_then(Value::as_str)
                .is_some_and(|value| allowed.iter().any(|candidate| candidate == value))
        })
    }

    /// Apply one host-authorized local security purge. The host MUST gate the
    /// corresponding subscriptions first; this primitive owns local SQLite
    /// cleanup and never grants/revokes server authority by itself.
    pub fn purge_local_data(
        &mut self,
        input: &LocalDataPurgeInput,
    ) -> Result<LocalDataPurgeResult, String> {
        let (targets, canonical_plan) = self.compile_local_data_purge(input)?;
        let meta_key = format!("localPurge:{}", input.purge_id);
        let applied_plan = self
            .conn
            .query_row(
                "SELECT value FROM _syncular_meta WHERE key = ?1",
                rusqlite::params![meta_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        if let Some(applied_plan) = applied_plan {
            if applied_plan != canonical_plan {
                return Err(format!(
                    "sync.invalid_request: local purge id {:?} was already used with a different plan",
                    input.purge_id
                ));
            }
            return Ok(LocalDataPurgeResult {
                already_applied: true,
                purged_rows: 0,
                dropped_commits: 0,
            });
        }

        // RFC 0005 D7: the container file cannot be a purge target (its name is
        // not in the running schema), so purge drops it as a fixed step, before
        // any mirror row is touched and unconditionally.
        let _ = self.drop_previous_version();

        let rollback = self.capture();
        self.begin_observation("syncular_local_purge")?;
        let applied = (|| -> Result<(ChangeAccumulator, LocalDataPurgeResult), String> {
            let row_ids = self.local_purge_base_row_ids(&targets)?;
            let retained_dropped = self.drop_failed_commits(|table, values| {
                targets.iter().any(|target| {
                    target.table == table && Self::local_purge_values_match(target, values)
                })
            })?;
            let doomed = self
                .outbox
                .iter()
                .filter(|commit| {
                    commit.ops.iter().any(|operation| {
                        let matching_targets = targets
                            .iter()
                            .filter(|target| target.table == operation.table)
                            .collect::<Vec<_>>();
                        if matching_targets.is_empty() {
                            return false;
                        }
                        if row_ids
                            .get(&operation.table)
                            .is_some_and(|ids| ids.contains(&operation.row_id))
                        {
                            return true;
                        }
                        operation.values.as_ref().is_some_and(|values| {
                            matching_targets
                                .iter()
                                .any(|target| Self::local_purge_values_match(target, values))
                        })
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            let doomed_ids = doomed
                .iter()
                .map(|commit| commit.client_commit_id.clone())
                .collect::<BTreeSet<_>>();
            let mut batch = ChangeAccumulator::default();
            for commit in &retained_dropped {
                batch.conflicts = true;
                batch.rejections = true;
                batch.outcomes = true;
                for operation in &commit.ops {
                    batch.table(&operation.table);
                }
            }
            let mut rejections = Vec::new();
            for commit in &doomed {
                for operation in &commit.ops {
                    batch.table(&operation.table);
                    self.overlay_dirty.table(&operation.table);
                }
                let results = commit
                    .ops
                    .iter()
                    .enumerate()
                    .map(|(op_index, operation)| {
                        let rejection = RejectionRecord {
                            client_commit_id: commit.client_commit_id.clone(),
                            op_index: op_index as i32,
                            code: "client.local_data_purged".to_owned(),
                            message: "the commit was dropped by an application-authorized local data purge".to_owned(),
                            retryable: false,
                            details: None,
                            operation: Some(CommitOperation::from(operation)),
                        };
                        rejections.push(rejection.clone());
                        CommitOperationOutcome::Error { rejection }
                    })
                    .collect::<Vec<_>>();
                self.persist_commit_outcome(
                    &commit.client_commit_id,
                    CommitOutcomeStatus::Rejected,
                    &results,
                    Some(&commit.ops),
                )?;
                self.delete_outbox_persisted(&commit.client_commit_id)?;
            }
            if !doomed.is_empty() {
                self.outbox
                    .retain(|commit| !doomed_ids.contains(&commit.client_commit_id));
                self.rejections.extend(rejections);
                self.prune_commit_outcomes()?;
                batch.status = true;
                batch.rejections = true;
                batch.outcomes = true;
            }

            let mut purged_rows = 0usize;
            for (table, ids) in &row_ids {
                if ids.is_empty() {
                    continue;
                }
                batch.table(table);
                for row_id in ids {
                    self.delete_base_row(table, row_id)?;
                    purged_rows += 1;
                }
            }
            self.rebuild_overlay_if_dirty()?;
            self.delete_unreferenced_cached_blobs()?;
            self.conn
                .execute(
                    "INSERT INTO _syncular_meta(key, value) VALUES (?1, ?2)",
                    rusqlite::params![meta_key, canonical_plan],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            Ok((
                batch,
                LocalDataPurgeResult {
                    already_applied: false,
                    purged_rows,
                    dropped_commits: doomed.len(),
                },
            ))
        })()
        .and_then(|(batch, result)| {
            self.finish_observation("syncular_local_purge", batch)
                .map(|()| result)
        });
        let result = match applied {
            Ok(result) => result,
            Err(error) => {
                self.rollback_observation("syncular_local_purge");
                self.restore(rollback);
                return Err(error);
            }
        };
        self.cancel_sync_round();
        Ok(result)
    }

    /// Application-authorized recovery of the replicated projection. Unlike a
    /// local security purge, this retains the entire outbox, device identity,
    /// lease, outcomes, subscription registrations, and protected bookkeeping.
    /// The projection reset, subscription rewind, optimistic replay, and
    /// idempotency marker share one savepoint for interruption safety.
    pub fn rebootstrap_local_data(
        &mut self,
        input: &LocalDataRebootstrapInput,
    ) -> Result<LocalDataRebootstrapResult, String> {
        if input.rebootstrap_id.is_empty()
            || input.rebootstrap_id.len() > 128
            || !is_local_operation_code_like(&input.rebootstrap_id)
        {
            return Err(
                "sync.invalid_request: local rebootstrap rebootstrapId must be a 1–128 character code-like identifier"
                    .to_owned(),
            );
        }
        let meta_key = format!("localRebootstrap:{}", input.rebootstrap_id);
        if let Some(persisted) = meta_get(&self.conn, &meta_key).map_err(|_| {
            "sync.local_corrupt: persisted local rebootstrap receipt is unreadable".to_owned()
        })? {
            let (retained_commits, reset_subscriptions) =
                decode_local_rebootstrap_receipt(&persisted)?;
            return Ok(LocalDataRebootstrapResult {
                already_applied: true,
                retained_commits,
                reset_subscriptions,
            });
        }
        if self.stopped || self.schema_floor.is_some() {
            return Err(
                "sync.invalid_request: local rebootstrap cannot bypass an active schema-floor stop; update the application first"
                    .to_owned(),
            );
        }

        let retained_commits = self.outbox.len();
        let reset_subscriptions = self.subs.len();
        let receipt = encode_local_rebootstrap_receipt(retained_commits, reset_subscriptions)?;
        let rollback = self.capture();
        self.begin_observation("syncular_local_rebootstrap")?;
        let mut batch = ChangeAccumulator::default();
        let applied = (|| -> Result<(), String> {
            self.run_schema_reset_observed(&mut batch, false)?;
            self.conn
                .execute(
                    "INSERT INTO _syncular_meta(key, value) VALUES (?1, ?2)",
                    rusqlite::params![meta_key, receipt],
                )
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            self.sync_needed = true;
            self.sync_intent_queue.push_back(SyncIntent::Interactive);
            batch.status = true;
            Ok(())
        })()
        .and_then(|()| self.finish_observation("syncular_local_rebootstrap", batch));
        if let Err(error) = applied {
            self.rollback_observation("syncular_local_rebootstrap");
            self.restore(rollback);
            return Err(error);
        }

        Ok(LocalDataRebootstrapResult {
            already_applied: false,
            retained_commits,
            reset_subscriptions,
        })
    }

    // -- scope purge + doomed outbox (§3.3) ----------------------------------------

    /// Delete base and visible rows owned by the effective scopes
    /// ([`local_scope_predicate`]); `Err(())` = no local scope-column mapping
    /// for a key (the fail-closed case).
    fn purge_scope_rows(
        &mut self,
        table_name: &str,
        effective: &[(String, Vec<String>)],
        owners: &[Vec<(String, Vec<String>)>],
    ) -> Result<(), ()> {
        let table = self.schema.table(table_name).ok_or(())?;
        let Some((predicate, params)) = local_scope_predicate(table, effective, owners)? else {
            return Ok(());
        };
        self.overlay_dirty.table(table_name);
        for source in [base_table(table_name), visible_table(table_name)] {
            self.conn
                .execute(
                    &format!("DELETE FROM {source} WHERE {predicate}"),
                    rusqlite::params_from_iter(&params),
                )
                .map_err(|_| ())?;
        }
        Ok(())
    }

    /// §3.3: drop pending commits whose upserts provably land in the
    /// revoked effective scopes and no other owner covers (row ownership)
    /// — whole-commit, never per-operation.
    fn drop_doomed_outbox(
        &mut self,
        table: &TableSchema,
        effective: &[(String, Vec<String>)],
        owners: &[Vec<(String, Vec<String>)>],
    ) -> Result<bool, String> {
        let doomed: Vec<_> =
            self.outbox
                .iter()
                .filter(|commit| {
                    commit.ops.iter().any(|op| {
                        op.upsert
                            && op.table == table.name
                            && op.values.as_ref().is_some_and(|values| {
                                owns_local_row(table, effective, owners, values)
                            })
                    })
                })
                .cloned()
                .collect();
        if doomed.is_empty() {
            return Ok(false);
        }
        let mut rejections = Vec::new();
        for commit in &doomed {
            let results = commit
                .ops
                .iter()
                .enumerate()
                .map(|(op_index, operation)| {
                    self.overlay_dirty.table(&operation.table);
                    let rejection = RejectionRecord {
                        client_commit_id: commit.client_commit_id.clone(),
                        op_index: op_index as i32,
                        code: "sync.scope_revoked".to_owned(),
                        message: "the commit was dropped because its effective scope was revoked"
                            .to_owned(),
                        retryable: false,
                        details: None,
                        operation: Some(CommitOperation::from(operation)),
                    };
                    rejections.push(rejection.clone());
                    CommitOperationOutcome::Error { rejection }
                })
                .collect::<Vec<_>>();
            self.persist_commit_outcome(
                &commit.client_commit_id,
                CommitOutcomeStatus::Rejected,
                &results,
                Some(&commit.ops),
            )?;
            self.delete_outbox_persisted(&commit.client_commit_id)?;
        }
        self.prune_commit_outcomes()?;
        let doomed_ids = doomed
            .iter()
            .map(|commit| commit.client_commit_id.as_str())
            .collect::<BTreeSet<_>>();
        self.outbox
            .retain(|commit| !doomed_ids.contains(commit.client_commit_id.as_str()));
        self.rejections.extend(rejections);
        Ok(true)
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
        let tx = self
            .conn
            .transaction()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        tx.execute(
            "INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms) VALUES (?,?,?,?,?)
             ON CONFLICT(blob_id) DO NOTHING",
            rusqlite::params![blob_id, bytes, bytes.len() as i64, media_type, now],
        )
        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        tx.execute(
            "INSERT OR IGNORE INTO _syncular_blob_uploads(blob_id, media_type, created_at_ms) VALUES (?,?,?)",
            rusqlite::params![blob_id, media_type, now],
        )
        .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        tx.commit()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        self.enforce_blob_cache_cap();
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

    /// §5.9.7: resolve an owned blob body without driver encoding. A
    /// content-addressed cache hit serves with no fetch (B1); a miss downloads
    /// (§5.9.5), verifies the address, caches the bytes, and returns them.
    pub fn fetch_blob_bytes(
        &mut self,
        transport: &mut dyn Transport,
        blob_id_or_ref: &str,
    ) -> Result<FetchedBlob, (String, String)> {
        let simple = |m: String| ("client.failed".to_owned(), m);
        // A BlobRef declares the size that caps the download (§5.9.5); a bare
        // blobId declares none.
        let (blob_id, byte_length) = if blob_id_or_ref.starts_with("sha256:") {
            (blob_id_or_ref.to_owned(), None)
        } else {
            let value: Value = serde_json::from_str(blob_id_or_ref)
                .map_err(|_| simple("blob ref is not JSON".to_owned()))?;
            (
                value
                    .get("blobId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| simple("blob ref has no blobId".to_owned()))?
                    .to_owned(),
                value.get("byteLength").and_then(Value::as_u64),
            )
        };
        if let Some(cached) = self.get_cached_blob_bytes(&blob_id).map_err(simple)? {
            return Ok(cached);
        }
        if !self.transport_enabled {
            return Err(("sync.offline".into(), "transport gate is closed".into()));
        }
        // §5.9.5: propagate the server's blob.* code (blob.forbidden /
        // blob.not_found) verbatim so the harness can assert on it. The
        // authorized endpoint serves bytes inline OR (always-issue, presign
        // configured) a signed url the client fetches directly — no host auth,
        // no fall-through: failure => re-request (the caller's next fetch_blob_bytes).
        #[cfg(feature = "bench-internals")]
        let download_phase = self.benchmark_phases.start(Phase::BlobDownload);
        let bytes = match transport
            .blob_download(&blob_id, byte_length)
            .map_err(|e| (e.code, e.message))?
        {
            BlobDownload::Bytes(bytes) => bytes,
            BlobDownload::Url {
                url,
                url_expires_at_ms,
            } => {
                // §5.9.5: MUST NOT start a fetch at/past expiry.
                if url_expires_at_ms.is_some_and(|exp| exp <= self.clock_now_ms()) {
                    return Err((
                        "sync.segment_expired".to_owned(),
                        format!(
                            "blob url for {blob_id} expired before fetch — re-request mints a fresh url (§5.9.5)"
                        ),
                    ));
                }
                transport
                    .fetch_blob_url(&url, byte_length)
                    .map_err(|e| (e.code, e.message))?
            }
        };
        #[cfg(feature = "bench-internals")]
        drop(download_phase);
        #[cfg(feature = "bench-internals")]
        let validate_phase = self.benchmark_phases.start(Phase::BlobValidate);
        // §5.9.5 inherits §5.1: the declared size caps the body before the
        // content address is verified.
        if byte_length.is_some_and(|cap| bytes.len() as u64 > cap) {
            return Err((
                "sync.invalid_request".to_owned(),
                "blob exceeds its byteLength".to_owned(),
            ));
        }
        if blob_id_for(&bytes) != blob_id {
            return Err(simple(format!(
                "blob content address mismatch for {blob_id}"
            )));
        }
        #[cfg(feature = "bench-internals")]
        drop(validate_phase);
        #[cfg(feature = "bench-internals")]
        let insert_phase = self.benchmark_phases.start(Phase::BlobCacheInsert);
        let now = self.clock_now_ms();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms) VALUES (?,?,?,NULL,?)",
                rusqlite::params![blob_id, bytes, bytes.len() as i64, now],
            )
            .map_err(|e| simple(e.to_string()))?;
        self.conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(|e| simple(e.to_string()))?;
        self.enforce_blob_cache_cap();
        #[cfg(feature = "bench-internals")]
        drop(insert_phase);
        self.get_cached_blob_bytes(&blob_id)
            .map_err(simple)?
            .ok_or_else(|| simple("blob cache write failed".to_owned()))
    }

    fn get_cached_blob_bytes(&self, blob_id: &str) -> Result<Option<FetchedBlob>, String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::BlobCacheRead);
        let mut stmt = self
            .conn
            .prepare("SELECT bytes, byte_length, media_type FROM _syncular_blobs WHERE blob_id = ?")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut rows = stmt
            .query(rusqlite::params![blob_id])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        if let Some(row) = rows
            .next()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
        {
            let bytes: Vec<u8> = row
                .get(0)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let byte_length: i64 = row
                .get(1)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let media_type: Option<String> = row
                .get(2)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            return Ok(Some(FetchedBlob {
                blob_id: blob_id.to_owned(),
                byte_length,
                bytes,
                media_type,
            }));
        }
        Ok(None)
    }

    /// §5.9.7 B4: upload every queued blob before push.
    fn pending_blob_uploads(&self) -> Result<Vec<crate::round::PendingUpload>, TransportError> {
        let pending: Vec<(String, Option<String>)> = {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT blob_id, media_type FROM (
                      SELECT blob_id, media_type, created_at_ms FROM _syncular_blob_uploads
                      UNION ALL
                      SELECT DISTINCT r.blob_id, b.media_type, 9223372036854775807 AS created_at_ms
                      FROM _syncular_blob_commit_refs r LEFT JOIN _syncular_blobs b ON b.blob_id = r.blob_id
                      WHERE NOT EXISTS (SELECT 1 FROM _syncular_blob_uploads u WHERE u.blob_id = r.blob_id)
                    ) ORDER BY created_at_ms, blob_id",
                )
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
            rows.collect::<Result<_, _>>()
                .map_err(|error| match error {
                    rusqlite::Error::InvalidColumnType(..)
                    | rusqlite::Error::FromSqlConversionFailure(..) => TransportError::new(
                        "sync.local_corrupt",
                        "Pending blob upload metadata is invalid",
                    ),
                    _ => TransportError::new("client.failed", error.to_string()),
                })?
        };
        let mut uploads = Vec::new();
        for (blob_id, media_type) in pending {
            let bytes = (|| {
                let stored: Option<(SqlValue, SqlValue)> = self
                    .conn
                    .query_row(
                        "SELECT bytes, byte_length FROM _syncular_blobs WHERE blob_id = ?",
                        rusqlite::params![blob_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| TransportError::new("client.failed", e.to_string()))?;
                let Some((SqlValue::Blob(bytes), SqlValue::Integer(byte_length))) = stored else {
                    return Err(TransportError::new(
                        "sync.local_corrupt",
                        "Pending blob upload body is missing or corrupt",
                    ));
                };
                if byte_length != bytes.len() as i64 || blob_id_for(&bytes) != blob_id {
                    return Err(TransportError::new(
                        "sync.local_corrupt",
                        "Pending blob upload body is missing or corrupt",
                    ));
                }
                Ok(bytes)
            })();
            let failed = bytes.is_err();
            uploads.push(crate::round::PendingUpload {
                id: blob_id,
                bytes,
                media_type,
            });
            if failed {
                break;
            }
        }
        Ok(uploads)
    }

    fn visible_blob_ids_sql(&self) -> String {
        let mut selects = Vec::new();
        for table in &self.schema.tables {
            for column in table
                .columns
                .iter()
                .filter(|column| column.ty == ColumnType::BlobRef)
            {
                let identifier = quote_ident(&column.name);
                selects.push(format!(
                    "SELECT json_extract({identifier}, '$.blobId') AS blob_id FROM {} \
                     WHERE typeof({identifier}) = 'text' AND json_valid({identifier}) \
                     AND json_type({identifier}, '$.blobId') = 'text'",
                    quote_ident(&table.name),
                ));
            }
        }
        if selects.is_empty() {
            "SELECT NULL AS blob_id WHERE 0".to_owned()
        } else {
            selects.join(" UNION ")
        }
    }

    /// §5.9.7 B1 size cap. Visible rows, pending commits, and
    /// staged uploads pin bodies directly; no derived refcount is stored.
    fn enforce_blob_cache_cap(&self) {
        let Some(max_bytes) = self.limits.blob_cache_max_bytes else {
            return;
        };
        let mut total: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(byte_length), 0) FROM _syncular_blobs",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if total <= max_bytes {
            return;
        }
        let query = format!(
            "SELECT blob_id, byte_length FROM _syncular_blobs
             WHERE blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
               AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_commit_refs)
               AND blob_id NOT IN ({})
             ORDER BY created_at_ms ASC, blob_id ASC",
            self.visible_blob_ids_sql(),
        );
        let candidates: Vec<(String, i64)> = {
            let Ok(mut stmt) = self.conn.prepare(&query) else {
                return;
            };
            let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            }) else {
                return;
            };
            rows.filter_map(Result::ok).collect()
        };
        for (blob_id, byte_length) in candidates {
            if total <= max_bytes {
                break;
            }
            let _ = self.conn.execute(
                "DELETE FROM _syncular_blobs WHERE blob_id = ?",
                rusqlite::params![blob_id],
            );
            total -= byte_length;
        }
    }

    fn delete_unreferenced_cached_blobs(&mut self) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::BlobRetention);
        if !self.schema_has_blobs() {
            return Ok(());
        }
        self.rebuild_overlay_if_dirty()?;
        self.conn
            .execute(
                &format!(
                    "DELETE FROM _syncular_blobs
                 WHERE blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
                   AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_commit_refs)
                   AND blob_id NOT IN ({})",
                    self.visible_blob_ids_sql(),
                ),
                [],
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(())
    }

    // -- local row storage ----------------------------------------------------------

    /// The cached per-table primary-key upsert SQL for `full_table` (see
    /// the `insert_sql` field: built once, reused per row).
    fn insert_row_sql(&self, full_table: &str, table: &crate::schema::TableSchema) -> String {
        if let Some(sql) = self.insert_sql.borrow().get(full_table) {
            return sql.clone();
        }
        let mut columns: Vec<String> = table.columns.iter().map(|c| quote_ident(&c.name)).collect();
        columns.push(quote_ident("_syncular_version"));
        let placeholders: Vec<&str> = columns.iter().map(|_| "?").collect();
        let primary_key = quote_ident(&table.primary_key);
        let updates = columns
            .iter()
            .filter(|column| **column != primary_key)
            .map(|column| format!("{column}=excluded.{column}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO {full_table} ({}) VALUES ({}) ON CONFLICT ({primary_key}) DO UPDATE SET {updates}",
            columns.join(", "),
            placeholders.join(", ")
        );
        self.insert_sql
            .borrow_mut()
            .insert(full_table.to_owned(), sql.clone());
        sql
    }

    fn write_base_row(&self, table_name: &str, row: &Row, version: i64) -> Result<(), String> {
        self.overlay_dirty.table(table_name);
        self.write_row(&base_table(table_name), table_name, row, version)
    }

    fn write_row(
        &self,
        full_table: &str,
        table_name: &str,
        row: &Row,
        version: i64,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::RowWrite);
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        let sql = self.insert_row_sql(full_table, table);
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let params = row
            .iter()
            .map(RowParam::Cell)
            .chain(std::iter::once(RowParam::Version(version)));
        stmt.execute(rusqlite::params_from_iter(params))
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(())
    }

    fn delete_base_row(&self, table_name: &str, row_id: &str) -> Result<(), String> {
        let table = self
            .schema
            .table(table_name)
            .ok_or_else(|| format!("unknown table {table_name:?}"))?;
        self.overlay_dirty.table(table_name);
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            base_table(table_name),
            row_id_predicate(table)
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        stmt.execute(rusqlite::params![row_id])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(())
    }

    fn has_acknowledged_rows(&self) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM _syncular_acked_rows)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    fn acknowledged_operations(
        &self,
        rows: Option<&HashSet<(&str, &str)>>,
        tables: Option<&BTreeSet<&str>>,
    ) -> Result<Vec<OutboxOp>, String> {
        let keys = rows.map(|rows| {
            serde_json::to_string(
                &rows
                    .iter()
                    .map(|(table, id)| serde_json::to_string(&(table, id)).expect("row key"))
                    .collect::<Vec<_>>(),
            )
            .expect("row keys")
        });
        let mut statement = self
            .conn
            .prepare("SELECT op_json,intent_json FROM _syncular_acked_rows WHERE (?1 IS NULL OR json_array(tbl,id) IN(SELECT value FROM json_each(?1))) AND (?2 IS NULL OR tbl IN(SELECT value FROM json_each(?2))) ORDER BY commit_seq,idx")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = statement
            .query_map(
                rusqlite::params![
                    keys,
                    tables.map(|tables| serde_json::to_string(tables).expect("table keys"))
                ],
                |row| {
                    #[cfg(test)]
                    self.acknowledged_replay_count
                        .set(self.acknowledged_replay_count.get() + 1);
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                },
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        rows.map(|row| {
            let (op, intent) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let op: CommitOperation =
                serde_json::from_str(&op).map_err(|_| "sync.local_corrupt".to_owned())?;
            let table = self
                .schema
                .table(&op.table)
                .ok_or_else(|| "sync.unknown_table".to_owned())?;
            let values = if op.op == "upsert" && self.visible_row(table, &op.row_id)?.is_none() {
                Some(serde_json::from_str(&intent).map_err(|_| "sync.local_corrupt".to_owned())?)
            } else {
                op.values
            };
            Ok(OutboxOp {
                table: op.table,
                row_id: op.row_id,
                upsert: op.op == "upsert",
                base_version: op.base_version,
                values,
                insert: op.insert,
            })
        })
        .collect()
    }

    fn drop_acknowledged_rows(
        &self,
        matches: impl Fn(&str, &Map<String, Value>) -> bool,
    ) -> Result<Vec<OutboxCommit>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT commit_id,tbl,intent_json,id FROM _syncular_acked_rows")
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut doomed = HashSet::new();
        for row in rows {
            let (id, table, intent, row_id) =
                row.map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let values =
                serde_json::from_str(&intent).map_err(|_| "sync.local_corrupt".to_owned())?;
            let base_matches = self
                .schema
                .table(&table)
                .map(|schema| self.stored_row(schema, &row_id, true))
                .transpose()?
                .flatten()
                .is_some_and(|(base, _)| {
                    let schema = self.schema.table(&table).expect("acknowledged table");
                    let values = schema
                        .columns
                        .iter()
                        .zip(base.iter())
                        .map(|(column, value)| (column.name.clone(), column_value_to_json(value)))
                        .collect();
                    matches(&table, &values)
                });
            if matches(&table, &values) || base_matches {
                doomed.insert(id);
            }
        }
        let mut dropped = Vec::new();
        for id in doomed {
            let mut statement = self
                .conn
                .prepare("SELECT op_json FROM _syncular_acked_rows WHERE commit_id=?1 ORDER BY idx")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let operations = statement
                .query_map([&id], |row| row.get::<_, String>(0))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            let mut ops = Vec::new();
            for operation in operations {
                let json = operation
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
                let op: CommitOperation =
                    serde_json::from_str(&json).map_err(|_| "sync.local_corrupt".to_owned())?;
                self.overlay_dirty.table(&op.table);
                ops.push(OutboxOp {
                    table: op.table,
                    row_id: op.row_id,
                    upsert: op.op == "upsert",
                    base_version: op.base_version,
                    values: op.values,
                    insert: op.insert,
                });
            }
            dropped.push(OutboxCommit {
                client_commit_id: id.clone(),
                ops,
            });
            self.conn
                .execute("DELETE FROM _syncular_acked_rows WHERE commit_id=?1", [id])
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        }
        Ok(dropped)
    }

    /// [`Self::rebuild_overlay`], skipped when neither the base tables nor
    /// the outbox changed since the last rebuild (the no-op sync round).
    fn rebuild_overlay_if_dirty(&mut self) -> Result<(), String> {
        if self.overlay_dirty.get() {
            self.rebuild_overlay()?;
        }
        Ok(())
    }

    /// §7.1: local reads see outbox state applied optimistically — rebuild
    /// every visible table as (base server state) + (pending outbox replay
    /// on top). Optimistic rows carry version `-1`.
    fn rebuild_overlay(&mut self) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let _phase = self.benchmark_phases.start(Phase::OverlayRebuild);
        #[cfg(test)]
        self.overlay_rebuild_count
            .set(self.overlay_rebuild_count.get() + 1);
        let dirty = self.overlay_dirty.snapshot();
        let tables: Vec<_> = self
            .schema
            .tables
            .iter()
            .filter(|table| {
                dirty
                    .as_ref()
                    .is_none_or(|names| names.is_empty() || names.contains(&table.name))
            })
            .cloned()
            .collect();
        let names: BTreeSet<_> = tables.iter().map(|table| table.name.as_str()).collect();
        self.begin_observation("syncular_overlay")?;
        let rebuilt = (|| {
            for table in &tables {
                for index in &table.fts_indexes {
                    self.drop_fts_triggers(index)?;
                }
                let visible = visible_table(&table.name);
                let base = base_table(&table.name);
                self.conn
                    .execute_batch(&format!(
                        "DELETE FROM {visible}; INSERT INTO {visible} SELECT * FROM {base}"
                    ))
                    .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            }
            self.replay_overlay(&names, None)?;
            for table in &tables {
                for index in &table.fts_indexes {
                    self.rebuild_fts_projection(table, index)?;
                    self.create_fts_triggers(table, index)?;
                }
            }
            self.conn
                .execute_batch("RELEASE syncular_overlay")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            Ok(())
        })();
        if rebuilt.is_err() {
            self.conn
                .execute_batch("ROLLBACK TO syncular_overlay; RELEASE syncular_overlay")
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        } else {
            self.overlay_dirty.set(false);
        }
        rebuilt
    }

    /// §7.1 replay of acknowledged, retained failed and pending intent, in
    /// that order, for the operations of `tables` on `rows` (every row for
    /// `None`) over their current visible state.
    fn replay_overlay(
        &self,
        tables: &BTreeSet<&str>,
        rows: Option<&HashSet<(&str, &str)>>,
    ) -> Result<(), String> {
        let replays = |op: &&OutboxOp| {
            tables.contains(op.table.as_str())
                && rows.is_none_or(|rows| rows.contains(&(op.table.as_str(), op.row_id.as_str())))
        };
        self.apply_outbox_ops(&self.acknowledged_operations(rows, Some(tables))?)?;
        for (commit, initial) in self.failed_commits.iter() {
            for operation in commit.ops.iter().filter(replays) {
                let Some(table) = self.schema.table(&operation.table) else {
                    continue;
                };
                if operation.upsert
                    && self.visible_row(table, &operation.row_id)?.is_none()
                    && operation.presented_values(table).is_some_and(|values| {
                        table
                            .columns
                            .iter()
                            .all(|column| values.contains_key(&column.name))
                    })
                {
                    let key = serde_json::to_string(&(&operation.table, &operation.row_id))
                        .expect("row key serialization");
                    if let Some(Value::Object(values)) = initial.get(&key) {
                        self.apply_outbox_ops(&[OutboxOp {
                            values: Some(values.clone()),
                            ..operation.clone()
                        }])?;
                    }
                }
            }
            self.apply_outbox_ops(commit.ops.iter().filter(replays))?;
        }
        self.apply_outbox_ops(
            self.outbox
                .iter()
                .flat_map(|commit| &commit.ops)
                .filter(replays),
        )
    }

    /// §7.1 replay: every operation is applied over the current visible
    /// state. An operation that no longer applies (a server row now holds its
    /// unique value) stays pending and invisible until a later replay admits
    /// it or the server answers its push.
    fn apply_outbox_ops<'a>(
        &self,
        ops: impl IntoIterator<Item = &'a OutboxOp>,
    ) -> Result<(), String> {
        #[cfg(feature = "bench-internals")]
        let mut phase = self.benchmark_phases.start(Phase::PendingReplay);
        for op in ops {
            #[cfg(feature = "bench-internals")]
            if let Some(phase) = &mut phase {
                phase.unit();
            }
            if op.upsert {
                if let Some((table, values)) = self
                    .schema
                    .table(&op.table)
                    .filter(|table| table.indexes.iter().any(|index| index.unique))
                    .and_then(|table| Some((table, op.presented_values(table)?)))
                {
                    let mut intended: Map<String, Value> = self
                        .visible_row(table, &op.row_id)?
                        .map(|(row, _)| {
                            table
                                .columns
                                .iter()
                                .zip(&row)
                                .map(|(column, value)| {
                                    (column.name.clone(), column_value_to_json(value))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    intended.extend(values.into_owned());
                    if !self.unique_conflicts(table, &intended, false)?.is_empty() {
                        continue;
                    }
                }
            }
            self.apply_outbox_op(op)?;
        }
        Ok(())
    }

    fn apply_outbox_op(&self, op: &OutboxOp) -> Result<(), String> {
        let Some(table) = self.schema.table(&op.table) else {
            return Ok(());
        };
        let visible = visible_table(&table.name);
        if !op.upsert {
            let sql = format!("DELETE FROM {visible} WHERE {}", row_id_predicate(table));
            self.conn
                .prepare_cached(&sql)
                .and_then(|mut statement| statement.execute(rusqlite::params![op.row_id]))
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            return Ok(());
        }
        // §7.1: an insert-intent operation that lacks a non-nullable column
        // cannot encode; it stays invisible until the send-time prepass drops
        // it as sync.outbox_incompatible (§7.4.4).
        let Some(values) = op.presented_values(table) else {
            return Ok(());
        };
        // §7.1: the overlay applies the operation's PRESENT columns
        // over the current local row. A partial operation over an
        // absent local row leaves it absent — the server answers it
        // with sync.row_deleted or sync.row_missing (§6.2). An
        // insert-intent operation presents every column.
        let full = table
            .columns
            .iter()
            .all(|column| values.contains_key(&column.name));
        let local = self.visible_row(table, &op.row_id)?;
        if local.is_none() && !full {
            return Ok(());
        }
        let mut row: Row = Vec::with_capacity(table.columns.len());
        for (index, column) in table.columns.iter().enumerate() {
            let incoming = match values.get(&column.name) {
                Some(raw) => json_to_column_value(
                    if raw.get("$bytes").is_some()
                        && table
                            .encrypted_columns
                            .iter()
                            .any(|encrypted| encrypted.index == index)
                    {
                        &table.wire_columns[index]
                    } else {
                        column
                    },
                    Some(raw),
                ),
                None => Ok(local
                    .as_ref()
                    .and_then(|(values, _)| values.get(index).cloned())
                    .flatten()),
            };
            row.push(incoming.map_err(|_| {
                "sync.local_corrupt: persisted optimistic row value is invalid".to_owned()
            })?);
        }
        let version = local.as_ref().map_or(-1, |(_, version)| *version);
        self.write_row(&visible, &table.name, &row, version)
            .map_err(|error| {
                if error.starts_with("UNIQUE constraint failed:") {
                    "sync.constraint_violation: local write violates a unique constraint".to_owned()
                } else {
                    error
                }
            })
    }

    /// Whether the row is present in the overlay. Existence reads only the
    /// key: locked encrypted values stay opaque, and decoding the complete row
    /// would reject a valid plain write.
    fn visible_row_exists(&self, table: &TableSchema, row_id: &str) -> Result<bool, String> {
        self.conn
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {} WHERE {})",
                    visible_table(&table.name),
                    row_id_predicate(table)
                ),
                rusqlite::params![row_id],
                |row| row.get(0),
            )
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))
    }

    /// The visible (optimistic) row's values plus version, or `None` when the
    /// row is absent from the overlay.
    fn visible_row(&self, table: &TableSchema, row_id: &str) -> Result<Option<(Row, i64)>, String> {
        self.stored_row(table, row_id, false)
    }

    fn stored_row(
        &self,
        table: &TableSchema,
        row_id: &str,
        base: bool,
    ) -> Result<Option<(Row, i64)>, String> {
        let sql = format!(
            "SELECT * FROM {} WHERE {}",
            if base {
                base_table(&table.name)
            } else {
                visible_table(&table.name)
            },
            row_id_predicate(table)
        );
        let mut stmt = self
            .conn
            .prepare_cached(&sql)
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let mut rows = stmt
            .query(rusqlite::params![row_id])
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        let Some(row) = rows
            .next()
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?
        else {
            return Ok(None);
        };
        let mut values = Vec::with_capacity(table.columns.len());
        for (index, column) in table.columns.iter().enumerate() {
            let raw = row
                .get_ref(index)
                .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
            if let rusqlite::types::ValueRef::Blob(bytes) = raw {
                if table
                    .encrypted_columns
                    .iter()
                    .any(|encrypted| encrypted.index == index)
                {
                    values.push(Some(ColumnValue::Bytes(bytes.to_vec())));
                    continue;
                }
            }
            let json = sql_ref_to_json(column, raw);
            values.push(json_to_column_value(column, Some(&json)).map_err(|_| {
                "sync.local_corrupt: persisted local row value is invalid".to_owned()
            })?);
        }
        let version: i64 = row
            .get(table.columns.len())
            .map_err(|error| Self::sqlite_failure(&self.storage_failure, error))?;
        Ok(Some((values, version)))
    }

    // -- realtime (§8) ---------------------------------------------------------------

    /// §8.8: the configured realtime policy.
    #[must_use]
    pub fn realtime_policy(&self) -> RealtimePolicy {
        self.realtime_policy
    }

    /// §8.8: the explicit realtime availability state.
    #[must_use]
    pub fn realtime_state(&self) -> RealtimeState {
        self.realtime_state
    }

    /// §8.8: set the realtime policy. Refused while the socket is connected:
    /// a policy change never silently re-routes an ownership state.
    pub fn set_realtime_policy(&mut self, policy: RealtimePolicy) -> Result<(), String> {
        if self.realtime_state == RealtimeState::Connected && policy != self.realtime_policy {
            return Err(
                "sync.invalid_request: disconnect realtime before changing the realtime policy"
                    .to_owned(),
            );
        }
        self.realtime_policy = policy;
        match policy {
            RealtimePolicy::Off => self.set_realtime_state(RealtimeState::Disabled, None),
            RealtimePolicy::Required | RealtimePolicy::Optional
                if self.realtime_state == RealtimeState::Disabled =>
            {
                self.set_realtime_state(RealtimeState::Disconnected, None);
            }
            RealtimePolicy::Required | RealtimePolicy::Optional => {}
        }
        Ok(())
    }

    /// Record an availability transition, keeping the reason code bounded and
    /// code-like (§7.6) and clearing it where it cannot apply.
    fn set_realtime_state(&mut self, state: RealtimeState, reason_code: Option<&str>) {
        self.realtime_state = state;
        self.realtime_reason_code = reason_code.map(Self::diagnostic_code);
        if matches!(state, RealtimeState::Connected | RealtimeState::Disabled) {
            self.realtime_reason_code = None;
            self.realtime_retry_delay_ms = None;
        }
    }

    #[must_use]
    fn realtime_connected(&self) -> bool {
        self.realtime_state == RealtimeState::Connected
    }

    pub fn connect_realtime(&mut self, transport: &mut dyn Transport) -> Result<(), String> {
        if !self.transport_enabled {
            return Err("sync.offline: transport gate is closed".into());
        }
        if self.realtime_policy == RealtimePolicy::Off {
            return Err(
                "sync.invalid_request: realtime is off; realtime connect is refused".to_owned(),
            );
        }
        if self.realtime_connected() {
            return Ok(());
        }
        self.realtime_state = RealtimeState::Connecting;
        match transport.realtime_connect_for_client(&self.client_id) {
            Ok(()) => {
                self.set_realtime_state(RealtimeState::Connected, None);
                Ok(())
            }
            Err(error) => {
                self.set_realtime_state(RealtimeState::Refused, Some(&error.code));
                Err(format!("{}: {}", error.code, error.message))
            }
        }
    }

    pub fn disconnect_realtime(&mut self, transport: &mut dyn Transport) {
        self.cancel_sync_round();
        // A deliberately disconnected or policy-disabled client has nothing
        // to release; a `lost` socket still does (the host owns the handle).
        if self.realtime_state == RealtimeState::Disconnected
            || self.realtime_state == RealtimeState::Disabled
        {
            return;
        }
        let _ = transport.realtime_close();
        self.set_realtime_state(
            if self.realtime_policy == RealtimePolicy::Off {
                RealtimeState::Disabled
            } else {
                RealtimeState::Disconnected
            },
            None,
        );
        self.presence.clear(); // §8.6.1: presence is per-connection
    }

    /// §8.8: the host observed the socket end without disconnecting it (a
    /// peer close, an I/O error, a failed send; the native transport reports
    /// these as `Inbound::Disconnected`). Releases the transport, moves a
    /// `Connected` state to `Lost` with the transport's code as the reason, and schedules
    /// one background retry intent so the host reconnects and catches up.
    pub fn realtime_lost(&mut self, transport: &mut dyn Transport, error: &TransportError) {
        if self.realtime_state != RealtimeState::Connected {
            return;
        }
        self.cancel_sync_round();
        let _ = transport.realtime_close();
        self.set_realtime_state(RealtimeState::Lost, Some(&error.code));
        self.realtime_retry_delay_ms = Some(self.schedule_background_retry());
        self.presence.clear();
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
        if !self.transport_enabled {
            return Err("sync.offline: transport gate is closed".into());
        }
        if !self.realtime_connected() {
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
        if self.stopped || !self.transport_enabled || self.security_preflight {
            return;
        }
        match parse_control(text) {
            Ok(ControlMessage::Hello { requires_sync, .. }) => {
                if requires_sync {
                    // §8.1: pull before trusting the socket for continuity.
                    self.set_sync_needed(true, true);
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
                self.set_sync_needed(true, true);
            }
            _ => {}
        }
    }

    /// Inbound binary delta: a complete SSP2 response (§8.2), applied like
    /// a pull response per section; an unapplied delta is a wake-up.
    /// Mailbox hosts send durable acknowledgements on their I/O executor.
    pub fn on_realtime_binary_queued(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut transport = crate::round::DownloadResults::default();
        self.on_realtime_binary(&mut transport, bytes);
        transport.controls
    }

    pub fn on_realtime_binary(&mut self, transport: &mut dyn Transport, bytes: &[u8]) {
        if self.stopped || !self.transport_enabled || self.security_preflight {
            return;
        }
        #[cfg(feature = "bench-internals")]
        let decode_phase = self.benchmark_phases.start(Phase::ResponseDecode);
        let message = match decode_message(bytes) {
            Ok(m) if m.msg_kind == MsgKind::Response => m,
            _ => {
                self.set_sync_needed(true, true);
                return;
            }
        };
        #[cfg(feature = "bench-internals")]
        drop(decode_phase);
        let coalesced_deletes =
            coalesced_delete_keys(&message.frames, |id, status, next_cursor| {
                if status != SubStatus::Active {
                    return false;
                }
                let Some(sub) = self.subs.iter().find(|sub| sub.id == id) else {
                    return false;
                };
                sub.takes_delta() && next_cursor.is_some_and(|cursor| cursor > sub.cursor)
            });
        let mut frames = message.frames.into_iter();
        let mut applied_cursor: Option<i64> = None;
        let mut any_covered = false;
        let mut dropped = self.begin_coalesced_apply().is_err();
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
            let Some(sub_index) = self.subs.iter().position(|s| s.id == id) else {
                dropped = true;
                continue;
            };
            let sub = &self.subs[sub_index];
            // §8.2: skipped sections are repaired by the next pull.
            if status != SubStatus::Active || !sub.takes_delta() {
                dropped = true;
                continue;
            }
            if next_cursor.is_some_and(|cursor| cursor <= sub.cursor) {
                // Idempotent redelivery of an already-covered window.
                any_covered = true;
                continue;
            }
            let previous_effective = self.subs[sub_index].effective.clone();
            let previous_cursor = self.subs[sub_index].cursor;
            self.subs[sub_index].effective = Some(effective_scopes);
            let mut failed = false;
            for inner in body {
                match inner {
                    Frame::Commit {
                        tables,
                        changes,
                        commit_seq,
                        ..
                    } => {
                        if self
                            .apply_commit_frame_coalesced(
                                &tables,
                                changes,
                                commit_seq,
                                &coalesced_deletes,
                                sub_index,
                                AppliedServerCommitSource::Delta,
                            )
                            .is_err()
                        {
                            failed = true;
                            break;
                        }
                    }
                    _ => {
                        failed = true;
                        break;
                    }
                }
            }
            let committed = next_cursor.filter(|_| !failed).and_then(|cursor| {
                self.apply_sub_end(sub_index, cursor, None)
                    .ok()
                    .map(|()| cursor)
            });
            let Some(next_cursor) = committed else {
                self.subs[sub_index].effective = previous_effective;
                self.subs[sub_index].cursor = previous_cursor;
                dropped = true;
                continue;
            };
            applied_cursor = Some(applied_cursor.map_or(next_cursor, |c| c.max(next_cursor)));
        }
        // §1.4 rule 4: the ack follows the COMMIT. A failed COMMIT restored
        // the cursors, so the delta counts as a wake-up.
        if self.finish_coalesced_apply().is_err() {
            applied_cursor = None;
            dropped = true;
        }
        if let Some(cursor) = applied_cursor {
            // §8.2 ack point: the highest applied SUB_END.nextCursor.
            let ack = format!("{{\"type\":\"ack\",\"cursor\":{cursor}}}");
            let _ = transport.realtime_send(&ack);
        }
        if dropped || (applied_cursor.is_none() && !any_covered) {
            // §8.2: a skipped section or an unapplied delta is a wake-up.
            self.set_sync_needed(true, true);
        }
    }

    /// §8.2 ack point after an HTTP pull on a live connection: the minimum
    /// cursor across active, non-bootstrapping subscriptions that have
    /// synced at least once. No such subscription, no ack.
    fn ack_after_pull(&mut self, transport: &mut dyn Transport) {
        if !self.realtime_connected() {
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

#[cfg(test)]
mod previous_version_wiring_tests;

#[cfg(test)]
mod scope_move_delivery_tests;

#[cfg(test)]
mod insert_intent_tests;

#[cfg(test)]
mod robustness_tests;
