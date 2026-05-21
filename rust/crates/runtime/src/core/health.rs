use crate::client::SubscriptionSpec;
use crate::error::Result;
use crate::protocol::{BootstrapState, ScopeValues, COMMIT_INTEGRITY_HEX_LENGTH};
use crate::store::{
    now_ms, AppSchemaState, ConflictSummary, OutboxSummary, SubscriptionState, SyncStore,
    SyncStoreTx, VerifiedRoot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

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
    let mut report = LocalHealthReport::new(subscriptions.len());
    let specs_by_id = subscriptions
        .iter()
        .map(|spec| (spec.id.as_str(), spec))
        .collect::<HashMap<_, _>>();
    store.transaction(|tx| {
        let states = tx.subscription_states(state_id)?;
        let roots = tx.verified_roots(state_id)?;
        report.checked_subscription_states = states.len();
        report.checked_verified_roots = roots.len();

        let states_by_id = states
            .iter()
            .map(|state| (state.subscription_id.as_str(), state))
            .collect::<HashMap<_, _>>();
        let rooted_subscription_ids = roots
            .iter()
            .map(|root| root.subscription_id.as_str())
            .collect::<HashSet<_>>();

        for state in &states {
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

        for root in &roots {
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
        Ok(())
    })?;
    Ok(report)
}

pub fn check_local_sync_state_health(
    report: &mut LocalHealthReport,
    current_schema_version: i32,
    app_schema_state: &AppSchemaState,
    outbox: &[OutboxSummary],
    conflicts: &[ConflictSummary],
) {
    check_app_schema_state(report, current_schema_version, app_schema_state);
    check_outbox_summaries(report, current_schema_version, outbox);
    check_conflict_summaries(report, conflicts);
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
