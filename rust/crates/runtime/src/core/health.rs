use crate::client::SubscriptionSpec;
use crate::error::Result;
use crate::protocol::{BootstrapState, ScopeValues, COMMIT_INTEGRITY_HEX_LENGTH};
use crate::store::{now_ms, SubscriptionState, SyncStore, SyncStoreTx, VerifiedRoot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealthReport {
    pub generated_at: i64,
    pub ok: bool,
    pub checked_subscriptions: usize,
    pub checked_verified_roots: usize,
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
    ManualInspection,
}

impl LocalHealthReport {
    fn new(checked_subscriptions: usize) -> Self {
        Self {
            generated_at: now_ms(),
            ok: true,
            checked_subscriptions,
            checked_verified_roots: 0,
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
    store.transaction(|tx| {
        for spec in subscriptions {
            let state = tx.subscription_state(state_id, &spec.id)?;
            if let Some(state) = state.as_ref() {
                check_subscription_state(&mut report, spec, state);
            }

            let root = tx.verified_root(state_id, &spec.id)?;
            if let Some(root) = root.as_ref() {
                report.checked_verified_roots += 1;
                check_verified_root(&mut report, spec, state.as_ref(), root, state_id);
            }
        }
        Ok(())
    })?;
    Ok(report)
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
