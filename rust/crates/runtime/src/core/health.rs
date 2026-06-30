use crate::client::SubscriptionSpec;
use crate::error::{Result, SyncularError};
use crate::protocol::{BootstrapState, ScopeValues, COMMIT_INTEGRITY_HEX_LENGTH};
use crate::store::{
    now_ms, AppSchemaState, BlobHealthSummary, ConflictSummary, CrdtHealthSummary, OutboxSummary,
    ScopedRowsHealthSummary, SubscriptionState, SyncStore, SyncStoreTx, VerifiedRoot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub const LOCAL_SUPPORT_BUNDLE_FORMAT_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealthReport {
    pub generated_at: i64,
    pub ok: bool,
    pub checked_subscriptions: usize,
    pub checked_subscription_states: usize,
    pub checked_verified_roots: usize,
    pub checked_outbox_commits: usize,
    pub checked_conflicts: usize,
    pub checked_synced_rows: i64,
    pub checked_blob_references: i64,
    pub checked_crdt_documents: i64,
    pub checked_crdt_update_log_entries: i64,
    pub findings: Vec<LocalHealthFinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealthFinding {
    pub severity: LocalHealthSeverity,
    pub code: String,
    pub component: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repair_action: Option<LocalHealthRepairAction>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealthRepairRequest {
    pub action: LocalHealthRepairAction,
    #[serde(default)]
    pub subscription_ids: Vec<String>,
    #[serde(default)]
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealthRepairReport {
    pub action: LocalHealthRepairAction,
    pub deleted_subscription_states: usize,
    pub deleted_verified_roots: usize,
    pub forced_rebootstrap_subscriptions: usize,
    pub cleared_orphaned_synced_rows: i64,
    pub cleared_tables: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalSyncResetRequest {
    pub subscription_ids: Vec<String>,
    pub clear_synced_rows: bool,
}

impl Default for LocalSyncResetRequest {
    fn default() -> Self {
        Self {
            subscription_ids: Vec::new(),
            clear_synced_rows: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncResetReport {
    pub reset_subscriptions: usize,
    pub deleted_subscription_states: usize,
    pub deleted_verified_roots: usize,
    pub cleared_synced_rows: i64,
    pub cleared_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportBundle {
    pub format_version: u32,
    pub generated_at: i64,
    pub redacted: bool,
    pub source: String,
    pub health: LocalHealthReport,
    pub app_schema_state: AppSchemaState,
    pub subscriptions: Vec<LocalSupportSubscription>,
    pub subscription_states: Vec<LocalSupportSubscriptionState>,
    pub verified_roots: Vec<LocalSupportVerifiedRoot>,
    pub outbox: LocalSupportOutboxSummary,
    pub outbox_commits: Vec<LocalSupportOutboxCommit>,
    pub conflicts: LocalSupportConflictSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<BlobHealthSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crdt: Option<CrdtHealthSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportSubscription {
    pub id: String,
    pub table: String,
    pub scope_keys: Vec<String>,
    pub scope_value_count: usize,
    pub params_keys: Vec<String>,
    pub params_value_count: usize,
    pub bootstrap_phase: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportSubscriptionState {
    pub state_id: String,
    pub subscription_id: String,
    pub table: String,
    pub scope_keys: Vec<String>,
    pub scope_value_count: usize,
    pub params_keys: Vec<String>,
    pub params_value_count: usize,
    pub cursor: i64,
    pub status: String,
    pub bootstrap_state_present: bool,
    pub bootstrap_state_byte_len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportVerifiedRoot {
    pub state_id: String,
    pub subscription_id: String,
    pub partition_id_present: bool,
    pub partition_id_byte_len: usize,
    pub commit_seq: i64,
    pub root_byte_len: usize,
    pub root_is_canonical_hex: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportOutboxSummary {
    pub total: usize,
    pub by_status: BTreeMap<String, usize>,
    pub by_schema_version: BTreeMap<i32, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportOutboxCommit {
    pub client_commit_id: String,
    pub status: String,
    pub schema_version: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acked_commit_seq: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportConflictSummary {
    pub total: usize,
    pub unresolved: usize,
    pub resolved: usize,
    pub by_result_status: BTreeMap<String, usize>,
    pub by_code: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSupportBundleImportReport {
    pub format_version: u32,
    pub generated_at: i64,
    pub redacted: bool,
    pub source: String,
    pub health_ok: bool,
    pub finding_count: usize,
    pub subscription_count: usize,
    pub subscription_state_count: usize,
    pub verified_root_count: usize,
    pub checked_subscription_states: usize,
    pub checked_verified_roots: usize,
    pub checked_outbox_commits: usize,
    pub checked_conflicts: usize,
    pub checked_synced_rows: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalHealthSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalHealthRepairAction {
    ForceRebootstrap,
    ClearOrphanedState,
    ClearOrphanedSyncedRows,
    ManualInspection,
}

impl LocalHealthReport {
    fn new(checked_subscriptions: usize) -> Self {
        Self {
            generated_at: now_ms(),
            ok: true,
            checked_subscriptions,
            checked_subscription_states: 0,
            checked_verified_roots: 0,
            checked_outbox_commits: 0,
            checked_conflicts: 0,
            checked_synced_rows: 0,
            checked_blob_references: 0,
            checked_crdt_documents: 0,
            checked_crdt_update_log_entries: 0,
            findings: Vec::new(),
        }
    }

    fn add_finding(&mut self, finding: LocalHealthFinding) {
        if finding.severity == LocalHealthSeverity::Error {
            self.ok = false;
        }
        self.findings.push(finding);
    }
}

pub fn check_local_health<S: SyncStore>(
    store: &mut S,
    state_id: &str,
    subscriptions: &[SubscriptionSpec],
) -> Result<LocalHealthReport> {
    let mut states = Vec::new();
    let mut roots = Vec::new();
    store.transaction(|tx| {
        states = tx.subscription_states(state_id)?;
        roots = tx.verified_roots(state_id)?;
        Ok(())
    })?;
    Ok(check_local_health_records(
        state_id,
        subscriptions,
        &states,
        &roots,
    ))
}

pub fn check_local_health_records(
    state_id: &str,
    subscriptions: &[SubscriptionSpec],
    states: &[SubscriptionState],
    roots: &[VerifiedRoot],
) -> LocalHealthReport {
    let mut report = LocalHealthReport::new(subscriptions.len());
    report.checked_subscription_states = states.len();
    report.checked_verified_roots = roots.len();

    let specs_by_id = subscriptions
        .iter()
        .map(|spec| (spec.id.as_str(), spec))
        .collect::<HashMap<_, _>>();
    let states_by_id = states
        .iter()
        .map(|state| (state.subscription_id.as_str(), state))
        .collect::<HashMap<_, _>>();
    let rooted_subscription_ids = roots
        .iter()
        .map(|root| root.subscription_id.as_str())
        .collect::<HashSet<_>>();

    for state in states {
        if let Some(spec) = specs_by_id.get(state.subscription_id.as_str()) {
            check_subscription_state(&mut report, spec, state);
        } else {
            check_orphaned_subscription_state(
                &mut report,
                state,
                rooted_subscription_ids.contains(state.subscription_id.as_str()),
            );
        }
    }

    for root in roots {
        if let Some(spec) = specs_by_id.get(root.subscription_id.as_str()) {
            check_verified_root(
                &mut report,
                spec,
                states_by_id.get(root.subscription_id.as_str()).copied(),
                root,
                state_id,
            );
        } else {
            check_orphaned_verified_root(&mut report, root);
        }
    }

    report
}

pub fn check_local_sync_state_health(
    report: &mut LocalHealthReport,
    current_schema_version: i32,
    app_schema_state: &AppSchemaState,
    outbox: &[OutboxSummary],
    conflicts: &[ConflictSummary],
    scoped_rows: Option<&ScopedRowsHealthSummary>,
    blob: Option<&BlobHealthSummary>,
    crdt: Option<&CrdtHealthSummary>,
) {
    check_app_schema_state(report, current_schema_version, app_schema_state);
    check_outbox_summaries(report, current_schema_version, outbox);
    check_conflict_summaries(report, conflicts);
    if let Some(scoped_rows) = scoped_rows {
        check_scoped_rows_health_summary(report, scoped_rows);
    }
    if let Some(blob) = blob {
        check_blob_health_summary(report, blob);
    }
    if let Some(crdt) = crdt {
        check_crdt_health_summary(report, crdt);
    }
}

#[allow(clippy::too_many_arguments)]
pub fn local_support_bundle_from_records(
    source: impl Into<String>,
    health: LocalHealthReport,
    subscriptions: &[SubscriptionSpec],
    states: &[SubscriptionState],
    roots: &[VerifiedRoot],
    app_schema_state: AppSchemaState,
    outbox: &[OutboxSummary],
    conflicts: &[ConflictSummary],
    blob: Option<BlobHealthSummary>,
    crdt: Option<CrdtHealthSummary>,
) -> LocalSupportBundle {
    LocalSupportBundle {
        format_version: LOCAL_SUPPORT_BUNDLE_FORMAT_VERSION,
        generated_at: now_ms(),
        redacted: true,
        source: source.into(),
        health,
        app_schema_state,
        subscriptions: subscriptions
            .iter()
            .map(redacted_subscription)
            .collect::<Vec<_>>(),
        subscription_states: states
            .iter()
            .map(redacted_subscription_state)
            .collect::<Vec<_>>(),
        verified_roots: roots.iter().map(redacted_verified_root).collect::<Vec<_>>(),
        outbox: redacted_outbox_summary(outbox),
        outbox_commits: redacted_outbox_commits(outbox),
        conflicts: redacted_conflict_summary(conflicts),
        blob,
        crdt,
    }
}

pub fn import_local_support_bundle_json(
    bundle_json: &str,
) -> Result<LocalSupportBundleImportReport> {
    let bundle: LocalSupportBundle = serde_json::from_str(bundle_json)?;
    if bundle.format_version != LOCAL_SUPPORT_BUNDLE_FORMAT_VERSION {
        return Err(SyncularError::config(format!(
            "unsupported local support bundle format version {}",
            bundle.format_version
        )));
    }
    if !bundle.redacted {
        return Err(SyncularError::config(
            "local support bundle import requires a redacted bundle",
        ));
    }
    Ok(LocalSupportBundleImportReport {
        format_version: bundle.format_version,
        generated_at: bundle.generated_at,
        redacted: bundle.redacted,
        source: bundle.source,
        health_ok: bundle.health.ok,
        finding_count: bundle.health.findings.len(),
        subscription_count: bundle.subscriptions.len(),
        subscription_state_count: bundle.subscription_states.len(),
        verified_root_count: bundle.verified_roots.len(),
        checked_subscription_states: bundle.health.checked_subscription_states,
        checked_verified_roots: bundle.health.checked_verified_roots,
        checked_outbox_commits: bundle.health.checked_outbox_commits,
        checked_conflicts: bundle.health.checked_conflicts,
        checked_synced_rows: bundle.health.checked_synced_rows,
    })
}

fn redacted_subscription(spec: &SubscriptionSpec) -> LocalSupportSubscription {
    let mut scope_keys = spec.scopes.keys().cloned().collect::<Vec<_>>();
    scope_keys.sort();
    let mut params_keys = spec.params.keys().cloned().collect::<Vec<_>>();
    params_keys.sort();
    LocalSupportSubscription {
        id: spec.id.clone(),
        table: spec.table.clone(),
        scope_keys,
        scope_value_count: count_json_values(spec.scopes.values()),
        params_keys,
        params_value_count: count_json_values(spec.params.values()),
        bootstrap_phase: spec.bootstrap_phase,
    }
}

fn redacted_subscription_state(state: &SubscriptionState) -> LocalSupportSubscriptionState {
    let (scope_keys, scope_value_count) = redacted_json_map_shape(&state.scopes_json);
    let (params_keys, params_value_count) = redacted_json_map_shape(&state.params_json);
    LocalSupportSubscriptionState {
        state_id: state.state_id.clone(),
        subscription_id: state.subscription_id.clone(),
        table: state.table.clone(),
        scope_keys,
        scope_value_count,
        params_keys,
        params_value_count,
        cursor: state.cursor,
        status: state.status.clone(),
        bootstrap_state_present: state.bootstrap_state_json.is_some(),
        bootstrap_state_byte_len: state
            .bootstrap_state_json
            .as_ref()
            .map_or(0, |value| value.len()),
    }
}

fn redacted_verified_root(root: &VerifiedRoot) -> LocalSupportVerifiedRoot {
    LocalSupportVerifiedRoot {
        state_id: root.state_id.clone(),
        subscription_id: root.subscription_id.clone(),
        partition_id_present: !root.partition_id.is_empty(),
        partition_id_byte_len: root.partition_id.len(),
        commit_seq: root.commit_seq,
        root_byte_len: root.root.len(),
        root_is_canonical_hex: is_canonical_hex_root(&root.root),
    }
}

fn redacted_outbox_summary(outbox: &[OutboxSummary]) -> LocalSupportOutboxSummary {
    let mut by_status = BTreeMap::new();
    let mut by_schema_version = BTreeMap::new();
    for item in outbox {
        *by_status.entry(item.status.clone()).or_insert(0) += 1;
        *by_schema_version.entry(item.schema_version).or_insert(0) += 1;
    }
    LocalSupportOutboxSummary {
        total: outbox.len(),
        by_status,
        by_schema_version,
    }
}

fn redacted_outbox_commits(outbox: &[OutboxSummary]) -> Vec<LocalSupportOutboxCommit> {
    outbox
        .iter()
        .map(|item| LocalSupportOutboxCommit {
            client_commit_id: item.client_commit_id.clone(),
            status: item.status.clone(),
            schema_version: item.schema_version,
            acked_commit_seq: item.acked_commit_seq,
        })
        .collect()
}

fn redacted_conflict_summary(conflicts: &[ConflictSummary]) -> LocalSupportConflictSummary {
    let mut by_result_status = BTreeMap::new();
    let mut by_code = BTreeMap::new();
    let mut resolved = 0usize;
    for item in conflicts {
        *by_result_status
            .entry(item.result_status.clone())
            .or_insert(0) += 1;
        if let Some(code) = &item.code {
            *by_code.entry(code.clone()).or_insert(0) += 1;
        }
        if item.resolved_at.is_some() || item.resolution.is_some() {
            resolved += 1;
        }
    }
    LocalSupportConflictSummary {
        total: conflicts.len(),
        unresolved: conflicts.len().saturating_sub(resolved),
        resolved,
        by_result_status,
        by_code,
    }
}

fn redacted_json_map_shape(json: &str) -> (Vec<String>, usize) {
    match serde_json::from_str::<BTreeMap<String, Value>>(json) {
        Ok(map) => {
            let keys = map.keys().cloned().collect::<Vec<_>>();
            let value_count = count_json_values(map.values());
            (keys, value_count)
        }
        Err(_) => (Vec::new(), 0),
    }
}

fn count_json_values<'a>(values: impl Iterator<Item = &'a Value>) -> usize {
    values
        .map(|value| value.as_array().map_or(1, Vec::len))
        .sum()
}

fn check_app_schema_state(
    report: &mut LocalHealthReport,
    current_schema_version: i32,
    app_schema_state: &AppSchemaState,
) {
    let Some(schema_version) = app_schema_state.schema_version else {
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.app_schema_state_missing",
            "appSchemaState",
            "local app schema state has not been recorded",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            BTreeMap::new(),
        ));
        return;
    };

    if schema_version > current_schema_version {
        let mut details = BTreeMap::new();
        details.insert(
            "localSchemaVersion".to_string(),
            Value::from(schema_version),
        );
        details.insert(
            "currentSchemaVersion".to_string(),
            Value::from(current_schema_version),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.app_schema_state_future_version",
            "appSchemaState",
            "local app schema state was written by a newer generated client",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    } else if schema_version < current_schema_version {
        let mut details = BTreeMap::new();
        details.insert(
            "localSchemaVersion".to_string(),
            Value::from(schema_version),
        );
        details.insert(
            "currentSchemaVersion".to_string(),
            Value::from(current_schema_version),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.app_schema_state_stale_version",
            "appSchemaState",
            "local app schema state is older than the generated client",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }
}

fn check_outbox_summaries(
    report: &mut LocalHealthReport,
    current_schema_version: i32,
    outbox: &[OutboxSummary],
) {
    report.checked_outbox_commits = outbox.len();
    let future_schema_count = outbox
        .iter()
        .filter(|item| item.schema_version > current_schema_version)
        .count();
    if future_schema_count > 0 {
        let max_schema_version = outbox
            .iter()
            .map(|item| item.schema_version)
            .max()
            .unwrap_or(current_schema_version);
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(future_schema_count));
        details.insert(
            "currentSchemaVersion".to_string(),
            Value::from(current_schema_version),
        );
        details.insert(
            "maxSchemaVersion".to_string(),
            Value::from(max_schema_version),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.outbox_future_schema_version",
            "outbox",
            "pending local outbox commits require a newer generated client",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }

    let failed_count = outbox.iter().filter(|item| item.status == "failed").count();
    if failed_count > 0 {
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(failed_count));
        report.add_finding(finding(
            LocalHealthSeverity::Warning,
            "local.outbox_failed_commits",
            "outbox",
            "local outbox contains failed commits that need app/user action",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }
}

fn check_conflict_summaries(report: &mut LocalHealthReport, conflicts: &[ConflictSummary]) {
    report.checked_conflicts = conflicts.len();
    if conflicts.is_empty() {
        return;
    }

    let mut details = BTreeMap::new();
    details.insert("count".to_string(), Value::from(conflicts.len()));
    report.add_finding(finding(
        LocalHealthSeverity::Warning,
        "local.conflicts_unresolved",
        "conflicts",
        "local store has unresolved sync conflicts",
        None,
        None,
        Some(LocalHealthRepairAction::ManualInspection),
        details,
    ));
}

fn check_scoped_rows_health_summary(
    report: &mut LocalHealthReport,
    scoped_rows: &ScopedRowsHealthSummary,
) {
    report.checked_synced_rows = scoped_rows.checked_synced_rows;
    for table in scoped_rows
        .tables
        .iter()
        .filter(|table| table.orphaned_synced_rows > 0)
    {
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(table.orphaned_synced_rows));
        details.insert(
            "checkedSyncedRows".to_string(),
            Value::from(table.checked_synced_rows),
        );
        details.insert(
            "totalOrphanedSyncedRows".to_string(),
            Value::from(scoped_rows.orphaned_synced_rows),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.synced_rows_orphaned",
            "appRows",
            "local synced app rows are outside the configured subscription scopes",
            None,
            Some(&table.table),
            Some(LocalHealthRepairAction::ClearOrphanedSyncedRows),
            details,
        ));
    }
}

fn check_blob_health_summary(report: &mut LocalHealthReport, blob: &BlobHealthSummary) {
    report.checked_blob_references = blob.checked_references;
    if blob.invalid_references > 0 {
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(blob.invalid_references));
        details.insert(
            "checkedReferences".to_string(),
            Value::from(blob.checked_references),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.blob_refs_invalid",
            "blobs",
            "local synced rows contain invalid blob references",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }

    if blob.upload_failed > 0 {
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(blob.upload_failed));
        report.add_finding(finding(
            LocalHealthSeverity::Warning,
            "local.blob_uploads_failed",
            "blobs",
            "local blob upload queue contains failed uploads",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }
}

fn check_crdt_health_summary(report: &mut LocalHealthReport, crdt: &CrdtHealthSummary) {
    report.checked_crdt_documents = crdt.document_count;
    report.checked_crdt_update_log_entries = crdt.log_updates;
    if crdt.orphaned_documents > 0 {
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(crdt.orphaned_documents));
        details.insert(
            "documentCount".to_string(),
            Value::from(crdt.document_count),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.crdt_documents_orphaned",
            "crdt",
            "local CRDT document metadata references missing app rows",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }

    if crdt.orphaned_log_entries > 0 {
        let mut details = BTreeMap::new();
        details.insert("count".to_string(), Value::from(crdt.orphaned_log_entries));
        details.insert("logUpdates".to_string(), Value::from(crdt.log_updates));
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.crdt_update_log_orphaned",
            "crdt",
            "local CRDT update log contains entries without document metadata",
            None,
            None,
            Some(LocalHealthRepairAction::ManualInspection),
            details,
        ));
    }
}

fn check_subscription_state(
    report: &mut LocalHealthReport,
    spec: &SubscriptionSpec,
    state: &SubscriptionState,
) {
    if state.table != spec.table {
        let mut details = BTreeMap::new();
        details.insert(
            "expectedTable".to_string(),
            Value::String(spec.table.clone()),
        );
        details.insert(
            "storedTable".to_string(),
            Value::String(state.table.clone()),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.subscription_state_table_mismatch",
            "subscriptionState",
            "stored subscription state belongs to a different table",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            details,
        ));
    }

    if state.cursor < -1 {
        let mut details = BTreeMap::new();
        details.insert("cursor".to_string(), Value::from(state.cursor));
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.subscription_state_invalid_cursor",
            "subscriptionState",
            "stored subscription cursor is below the bootstrap sentinel",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            details,
        ));
    }

    if let Err(error) = serde_json::from_str::<ScopeValues>(&state.scopes_json) {
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.subscription_state_invalid_scopes_json",
            "subscriptionState",
            "stored subscription scopes are not valid JSON",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            parse_error_details(error, state.scopes_json.len()),
        ));
    }

    if let Err(error) = serde_json::from_str::<serde_json::Map<String, Value>>(&state.params_json) {
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.subscription_state_invalid_params_json",
            "subscriptionState",
            "stored subscription params are not valid JSON",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            parse_error_details(error, state.params_json.len()),
        ));
    }

    if let Some(bootstrap_state_json) = state.bootstrap_state_json.as_deref() {
        if let Err(error) = serde_json::from_str::<BootstrapState>(bootstrap_state_json) {
            report.add_finding(finding(
                LocalHealthSeverity::Error,
                "local.subscription_state_invalid_bootstrap_json",
                "subscriptionState",
                "stored subscription bootstrap state is not valid",
                Some(&spec.id),
                Some(&spec.table),
                Some(LocalHealthRepairAction::ForceRebootstrap),
                parse_error_details(error, bootstrap_state_json.len()),
            ));
        }
    }
}

fn check_orphaned_subscription_state(
    report: &mut LocalHealthReport,
    state: &SubscriptionState,
    has_verified_root: bool,
) {
    let mut details = BTreeMap::new();
    details.insert("status".to_string(), Value::String(state.status.clone()));
    details.insert("cursor".to_string(), Value::from(state.cursor));
    details.insert(
        "hasVerifiedRoot".to_string(),
        Value::from(has_verified_root),
    );
    report.add_finding(finding(
        LocalHealthSeverity::Error,
        "local.subscription_state_orphaned",
        "subscriptionState",
        "stored subscription state is not configured on this client",
        Some(&state.subscription_id),
        Some(&state.table),
        Some(LocalHealthRepairAction::ClearOrphanedState),
        details,
    ));
}

fn check_orphaned_verified_root(report: &mut LocalHealthReport, root: &VerifiedRoot) {
    let mut details = BTreeMap::new();
    details.insert("commitSeq".to_string(), Value::from(root.commit_seq));
    details.insert(
        "partitionId".to_string(),
        Value::String(root.partition_id.clone()),
    );
    report.add_finding(finding(
        LocalHealthSeverity::Error,
        "local.verified_root_orphaned",
        "verifiedRoot",
        "stored verified root is not configured on this client",
        Some(&root.subscription_id),
        None,
        Some(LocalHealthRepairAction::ClearOrphanedState),
        details,
    ));
}

fn check_verified_root(
    report: &mut LocalHealthReport,
    spec: &SubscriptionSpec,
    state: Option<&SubscriptionState>,
    root: &VerifiedRoot,
    state_id: &str,
) {
    if state.is_none() {
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.verified_root_without_subscription_state",
            "verifiedRoot",
            "stored verified root has no matching subscription state",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            BTreeMap::new(),
        ));
    }

    if root.state_id != state_id {
        let mut details = BTreeMap::new();
        details.insert(
            "expectedStateId".to_string(),
            Value::String(state_id.to_string()),
        );
        details.insert(
            "storedStateId".to_string(),
            Value::String(root.state_id.clone()),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.verified_root_state_mismatch",
            "verifiedRoot",
            "stored verified root belongs to a different state",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            details,
        ));
    }

    if root.subscription_id != spec.id {
        let mut details = BTreeMap::new();
        details.insert(
            "storedSubscriptionId".to_string(),
            Value::String(root.subscription_id.clone()),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.verified_root_subscription_mismatch",
            "verifiedRoot",
            "stored verified root belongs to a different subscription",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            details,
        ));
    }

    if root.partition_id.is_empty() {
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.verified_root_empty_partition",
            "verifiedRoot",
            "stored verified root has an empty partition",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            BTreeMap::new(),
        ));
    }

    if root.commit_seq < 0 {
        let mut details = BTreeMap::new();
        details.insert("commitSeq".to_string(), Value::from(root.commit_seq));
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.verified_root_invalid_commit_seq",
            "verifiedRoot",
            "stored verified root has a negative commit sequence",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            details,
        ));
    }

    if !is_canonical_hex_root(&root.root) {
        let mut details = BTreeMap::new();
        details.insert("rootLength".to_string(), Value::from(root.root.len()));
        details.insert(
            "expectedRootLength".to_string(),
            Value::from(COMMIT_INTEGRITY_HEX_LENGTH),
        );
        report.add_finding(finding(
            LocalHealthSeverity::Error,
            "local.verified_root_invalid_hex",
            "verifiedRoot",
            "stored verified root is not a canonical lowercase hex digest",
            Some(&spec.id),
            Some(&spec.table),
            Some(LocalHealthRepairAction::ForceRebootstrap),
            details,
        ));
    }

    if let Some(state) = state {
        if state.cursor >= 0 && root.commit_seq > state.cursor {
            let mut details = BTreeMap::new();
            details.insert("cursor".to_string(), Value::from(state.cursor));
            details.insert("commitSeq".to_string(), Value::from(root.commit_seq));
            report.add_finding(finding(
                LocalHealthSeverity::Error,
                "local.verified_root_ahead_of_cursor",
                "verifiedRoot",
                "stored verified root is ahead of the persisted subscription cursor",
                Some(&spec.id),
                Some(&spec.table),
                Some(LocalHealthRepairAction::ForceRebootstrap),
                details,
            ));
        }
    }
}

fn finding(
    severity: LocalHealthSeverity,
    code: &str,
    component: &str,
    message: &str,
    subscription_id: Option<&str>,
    table: Option<&str>,
    repair_action: Option<LocalHealthRepairAction>,
    details: BTreeMap<String, Value>,
) -> LocalHealthFinding {
    LocalHealthFinding {
        severity,
        code: code.to_string(),
        component: component.to_string(),
        message: message.to_string(),
        subscription_id: subscription_id.map(str::to_string),
        table: table.map(str::to_string),
        repair_action,
        details,
    }
}

fn parse_error_details(error: serde_json::Error, byte_len: usize) -> BTreeMap<String, Value> {
    let mut details = BTreeMap::new();
    details.insert("byteLength".to_string(), Value::from(byte_len));
    details.insert("line".to_string(), Value::from(error.line()));
    details.insert("column".to_string(), Value::from(error.column()));
    details.insert("error".to_string(), Value::String(error.to_string()));
    details
}

fn is_canonical_hex_root(root: &str) -> bool {
    root.len() == COMMIT_INTEGRITY_HEX_LENGTH
        && root
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
