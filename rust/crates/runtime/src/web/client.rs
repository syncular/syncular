use crate::app_schema::{
    validate_blob_encryption_against_app_schema, validate_encrypted_crdt_against_app_schema,
    validate_field_encryption_rules_against_app_schema, AppSchema,
};
use crate::binary_snapshot::SnapshotChunkRows;
use crate::binary_sync_pack::decode_binary_sync_pack;
use crate::client::{
    sync_changed_row_for_change, sync_changed_row_for_local_operation,
    sync_changed_row_for_snapshot, sync_changed_rows_for_cleared_snapshot_chunk_limited,
    validate_subscription_limits, SubscriptionSpec, SyncChangedRow,
};
use crate::crdt_yjs::YJS_PAYLOAD_KEY;
use crate::encrypted_crdt::{is_encrypted_crdt_system_table, EncryptedCrdt};
use crate::encryption::{BlobEncryption, FieldEncryption, FieldEncryptionContext};
use crate::error::{ErrorKind, Result, SyncularError};
use crate::limits::{
    DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT, DEFAULT_ADAPTIVE_OUTBOX_PUSH_THRESHOLD,
    DEFAULT_OUTBOX_PUSH_BATCH_LIMIT, MAX_OUTBOX_PUSH_BATCH_LIMIT,
};
use crate::protocol::{
    validate_mutation_json_input_size, validate_pull_commit_integrity_metadata,
    validate_pull_snapshot_manifests, validate_realtime_sync_pack_bytes,
    validate_sqlite_snapshot_artifact_for_apply, verify_subscription_commit_integrity,
    BootstrapState, CombinedRequest, CombinedResponse, PullRequest, PullResponse, PushBatchRequest,
    PushCommitRequest, ScopeValues, SnapshotArtifactsRequest, SubscriptionRequest, SyncChange,
    SyncCommit, SyncOperation, VerifiedCommitRoot, SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
    SNAPSHOT_CHUNK_COMPRESSION_GZIP,
};
use crate::store::{next_retry_at, now_ms, ConflictSummary, OutboxCommit, MAX_SYNC_RETRIES};
use crate::transport::web::{AsyncSyncTransport, WebSyncTransport, WebSyncTransportConfig};
use crate::transport::{SyncAuthHeaderStore, SyncAuthHeaders};
use crate::web_store::{
    AsyncWebStore, WebMemoryStore, WebSnapshotArtifactApplyMode, WebStoreApplyTimings,
    WebSubscriptionState, WebVerifiedRoot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const CRDT_STATE_VECTOR_HINT_LIMIT: i64 = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSyncularClientConfig {
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub pull: WebSyncPullOptions,
    #[serde(default)]
    pub push: WebSyncPushOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSyncPullOptions {
    #[serde(default = "default_limit_commits")]
    pub limit_commits: i64,
    #[serde(default = "default_limit_snapshot_rows")]
    pub limit_snapshot_rows: i64,
    #[serde(default = "default_max_snapshot_pages")]
    pub max_snapshot_pages: i64,
    #[serde(default)]
    pub dedupe_rows: Option<bool>,
    #[serde(default = "default_critical_bootstrap_phase")]
    pub critical_bootstrap_phase: i64,
    #[serde(default = "default_interactive_bootstrap_phase")]
    pub interactive_bootstrap_phase: i64,
    #[serde(default = "default_include_snapshot_rows")]
    pub include_snapshot_rows: bool,
    #[serde(default = "default_collect_changed_rows")]
    pub collect_changed_rows: bool,
    #[serde(default = "default_max_snapshot_changed_rows")]
    pub max_snapshot_changed_rows: Option<usize>,
    #[serde(default)]
    pub collect_server_timings: bool,
}

impl Default for WebSyncPullOptions {
    fn default() -> Self {
        Self {
            limit_commits: 1000,
            limit_snapshot_rows: 50_000,
            max_snapshot_pages: 10,
            dedupe_rows: None,
            critical_bootstrap_phase: default_critical_bootstrap_phase(),
            interactive_bootstrap_phase: default_interactive_bootstrap_phase(),
            include_snapshot_rows: false,
            collect_changed_rows: true,
            max_snapshot_changed_rows: default_max_snapshot_changed_rows(),
            collect_server_timings: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSyncPushOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbox_batch_limit: Option<i64>,
    #[serde(default = "default_adaptive_outbox_push_batch_limit")]
    pub adaptive_outbox_batch_limit: i64,
    #[serde(default = "default_adaptive_outbox_push_threshold")]
    pub adaptive_outbox_batch_threshold: i64,
}

impl Default for WebSyncPushOptions {
    fn default() -> Self {
        Self {
            outbox_batch_limit: None,
            adaptive_outbox_batch_limit: default_adaptive_outbox_push_batch_limit(),
            adaptive_outbox_batch_threshold: default_adaptive_outbox_push_threshold(),
        }
    }
}

fn default_limit_commits() -> i64 {
    1000
}

fn default_outbox_push_batch_limit() -> i64 {
    DEFAULT_OUTBOX_PUSH_BATCH_LIMIT
}

fn default_adaptive_outbox_push_batch_limit() -> i64 {
    DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT
}

fn default_adaptive_outbox_push_threshold() -> i64 {
    DEFAULT_ADAPTIVE_OUTBOX_PUSH_THRESHOLD
}

fn default_limit_snapshot_rows() -> i64 {
    50_000
}

fn default_max_snapshot_pages() -> i64 {
    10
}

fn default_critical_bootstrap_phase() -> i64 {
    0
}

fn default_interactive_bootstrap_phase() -> i64 {
    1
}

fn default_include_snapshot_rows() -> bool {
    false
}

fn default_collect_changed_rows() -> bool {
    true
}

fn default_max_snapshot_changed_rows() -> Option<usize> {
    Some(5_000)
}

pub struct WebSyncularClient<T = WebSyncTransport, S = WebMemoryStore> {
    config: WebSyncularClientConfig,
    transport: T,
    store: S,
    subscriptions: Vec<SubscriptionSpec>,
    field_encryption: Option<FieldEncryption>,
    encrypted_crdt: Option<EncryptedCrdt>,
    blob_encryption: Option<BlobEncryption>,
    adaptive_outbox_batch_active: bool,
    adaptive_outbox_pending_count_hint: Option<usize>,
}

#[derive(Debug, Default, Serialize)]
pub struct WebSyncResult {
    pub changed_tables: Vec<String>,
    pub changed_rows: Vec<SyncChangedRow>,
    pub changed_rows_truncated: bool,
    pub subscriptions: Vec<WebSubscriptionResult>,
    pub pushed_commits: usize,
    pub timings: WebSyncTimings,
}

#[derive(Debug, Default, Serialize)]
pub struct WebSyncTimings {
    pub total_ms: f64,
    pub push_ms: f64,
    pub pull_ms: f64,
    pub pull_request_ms: f64,
    pub sync_pack_decode_ms: f64,
    pub pull_transform_ms: f64,
    pub integrity_verify_ms: f64,
    pub snapshot_fetch_ms: f64,
    pub pull_apply_ms: f64,
    pub scope_clear_ms: f64,
    pub snapshot_row_apply_ms: f64,
    pub snapshot_artifact_apply_ms: f64,
    pub snapshot_artifact_checkpoint_ms: f64,
    pub snapshot_artifact_checkpoint_count: u64,
    pub snapshot_chunk_apply_ms: f64,
    pub snapshot_chunk_materialize_ms: f64,
    pub snapshot_chunk_reset_ms: f64,
    pub snapshot_chunk_bind_ms: f64,
    pub snapshot_chunk_step_ms: f64,
    pub commit_apply_ms: f64,
    pub subscription_state_ms: f64,
    pub notify_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct WebSubscriptionResult {
    pub id: String,
    pub table: String,
    pub status: String,
    pub scopes: ScopeValues,
    pub next_cursor: i64,
    #[serde(default)]
    pub bootstrap_phase: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap_state: Option<BootstrapState>,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub progress_percent: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub snapshot_rows: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commits: Vec<SyncCommit>,
}

impl WebSyncularClient<WebSyncTransport, WebMemoryStore> {
    pub fn open(config: WebSyncularClientConfig) -> Self {
        let transport = WebSyncTransport::new(WebSyncTransportConfig {
            base_url: config.base_url.clone(),
            client_id: config.client_id.clone(),
            actor_id: config.actor_id.clone(),
            collect_server_timings: config.pull.collect_server_timings,
        });
        Self::with_parts(config, transport, WebMemoryStore::new())
    }
}

impl<T, S> WebSyncularClient<T, S>
where
    T: AsyncSyncTransport,
    S: AsyncWebStore,
{
    pub fn with_parts(config: WebSyncularClientConfig, transport: T, store: S) -> Self {
        Self {
            config,
            transport,
            store,
            subscriptions: Vec::new(),
            field_encryption: None,
            encrypted_crdt: None,
            blob_encryption: None,
            adaptive_outbox_batch_active: false,
            adaptive_outbox_pending_count_hint: None,
        }
    }

    pub fn set_subscriptions(&mut self, subscriptions: Vec<SubscriptionSpec>) -> Result<()> {
        validate_subscription_limits(&subscriptions)?;
        self.subscriptions = subscriptions;
        Ok(())
    }

    pub fn subscriptions(&self) -> &[SubscriptionSpec] {
        &self.subscriptions
    }

    pub async fn force_subscriptions_bootstrap(
        &mut self,
        subscription_ids: &[String],
    ) -> Result<usize> {
        let ids = if subscription_ids.is_empty() {
            self.subscriptions
                .iter()
                .map(|subscription| subscription.id.clone())
                .collect::<Vec<_>>()
        } else {
            subscription_ids.to_vec()
        };
        for subscription_id in &ids {
            self.store.delete_verified_root(subscription_id).await?;
            self.store
                .delete_subscription_state(subscription_id)
                .await?;
        }
        Ok(ids.len())
    }

    pub async fn force_subscriptions_bootstrap_json(
        &mut self,
        subscription_ids_json: &str,
    ) -> Result<String> {
        let subscription_ids: Vec<String> = serde_json::from_str(subscription_ids_json)?;
        Ok(serde_json::to_string(
            &self
                .force_subscriptions_bootstrap(&subscription_ids)
                .await?,
        )?)
    }

    pub async fn local_health_check(&mut self) -> Result<crate::health::LocalHealthReport> {
        let state_id = self.store.local_state_id();
        let states = self.store.subscription_states().await?;
        let roots = self.store.verified_roots().await?;
        let mut report = crate::health::check_local_health_records(
            &state_id,
            &self.subscriptions,
            &states,
            &roots,
        );
        let current_schema_version = self.schema_version();
        let app_schema_state = self.store.app_schema_state(current_schema_version).await?;
        let outbox = self.store.outbox_summaries().await?;
        let conflicts = self.store.conflict_summaries().await?;
        let scoped_rows = self
            .store
            .scoped_rows_health_summary(&self.subscriptions)
            .await?;
        let blob_health = self.store.blob_health_summary().await?;
        let crdt_health = self.store.crdt_health_summary().await?;
        crate::health::check_local_sync_state_health(
            &mut report,
            current_schema_version,
            &app_schema_state,
            &outbox,
            &conflicts,
            scoped_rows.as_ref(),
            blob_health.as_ref(),
            crdt_health.as_ref(),
        );
        Ok(report)
    }

    pub async fn local_health_check_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.local_health_check().await?)?)
    }

    pub async fn export_local_support_bundle(
        &mut self,
    ) -> Result<crate::health::LocalSupportBundle> {
        let states = self.store.subscription_states().await?;
        let roots = self.store.verified_roots().await?;
        let state_id = self.store.local_state_id();
        let current_schema_version = self.schema_version();
        let mut health = crate::health::check_local_health_records(
            &state_id,
            &self.subscriptions,
            &states,
            &roots,
        );
        let app_schema_state = self.store.app_schema_state(current_schema_version).await?;
        let outbox = self.store.outbox_summaries().await?;
        let conflicts = self.store.conflict_summaries().await?;
        let scoped_rows = self
            .store
            .scoped_rows_health_summary(&self.subscriptions)
            .await?;
        let blob_health = self.store.blob_health_summary().await?;
        let crdt_health = self.store.crdt_health_summary().await?;
        crate::health::check_local_sync_state_health(
            &mut health,
            current_schema_version,
            &app_schema_state,
            &outbox,
            &conflicts,
            scoped_rows.as_ref(),
            blob_health.as_ref(),
            crdt_health.as_ref(),
        );
        Ok(crate::health::local_support_bundle_from_records(
            "browser",
            health,
            &self.subscriptions,
            &states,
            &roots,
            app_schema_state,
            &outbox,
            &conflicts,
            blob_health,
            crdt_health,
        ))
    }

    pub async fn export_local_support_bundle_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(
            &self.export_local_support_bundle().await?,
        )?)
    }

    pub async fn import_local_support_bundle_json(&mut self, bundle_json: &str) -> Result<String> {
        Ok(serde_json::to_string(
            &crate::health::import_local_support_bundle_json(bundle_json)?,
        )?)
    }

    pub async fn repair_local_health(
        &mut self,
        request: crate::health::LocalHealthRepairRequest,
    ) -> Result<crate::health::LocalHealthRepairReport> {
        match request.action {
            crate::health::LocalHealthRepairAction::ForceRebootstrap => {
                self.repair_force_rebootstrap(&request.subscription_ids)
                    .await
            }
            crate::health::LocalHealthRepairAction::ClearOrphanedState => {
                self.repair_clear_orphaned_state(&request.subscription_ids)
                    .await
            }
            crate::health::LocalHealthRepairAction::ClearOrphanedSyncedRows => {
                self.repair_clear_orphaned_synced_rows(&request).await
            }
            crate::health::LocalHealthRepairAction::ManualInspection => Err(SyncularError::config(
                "manualInspection health findings cannot be repaired automatically",
            )),
        }
    }

    pub async fn repair_local_health_json(&mut self, request_json: &str) -> Result<String> {
        let request: crate::health::LocalHealthRepairRequest = serde_json::from_str(request_json)?;
        Ok(serde_json::to_string(
            &self.repair_local_health(request).await?,
        )?)
    }

    pub async fn reset_local_sync_state(
        &mut self,
        request: crate::health::LocalSyncResetRequest,
    ) -> Result<crate::health::LocalSyncResetReport> {
        let selected = self.selected_reset_subscriptions(&request.subscription_ids)?;
        if request.clear_synced_rows {
            let unresolved_outbox = self
                .store
                .outbox_summaries()
                .await?
                .iter()
                .filter(|commit| commit.status != "acked")
                .count();
            if unresolved_outbox > 0 {
                return Err(SyncularError::config(format!(
                    "resetLocalSyncState clearSyncedRows requires an empty local outbox; found {unresolved_outbox} unresolved commits"
                )));
            }
        }

        let selected_ids = selected
            .iter()
            .map(|subscription| subscription.id.clone())
            .collect::<HashSet<_>>();
        let deleted_subscription_states = self
            .store
            .subscription_states()
            .await?
            .iter()
            .filter(|state| selected_ids.contains(&state.subscription_id))
            .count();
        let deleted_verified_roots = self
            .store
            .verified_roots()
            .await?
            .iter()
            .filter(|root| selected_ids.contains(&root.subscription_id))
            .count();

        self.store.begin_apply_batch().await?;
        let reset_result = async {
            let mut cleared_synced_rows = 0i64;
            let mut cleared_tables = Vec::new();
            if request.clear_synced_rows {
                for subscription in &selected {
                    let deleted = self
                        .store
                        .clear_synced_rows_for_scopes(&subscription.table, &subscription.scopes)
                        .await?;
                    if deleted > 0 {
                        cleared_synced_rows += deleted;
                        if !cleared_tables
                            .iter()
                            .any(|table| table == &subscription.table)
                        {
                            cleared_tables.push(subscription.table.clone());
                        }
                    }
                }
            }
            for subscription in &selected {
                self.store.delete_verified_root(&subscription.id).await?;
                self.store
                    .delete_subscription_state(&subscription.id)
                    .await?;
            }
            Ok(crate::health::LocalSyncResetReport {
                reset_subscriptions: selected.len(),
                deleted_subscription_states,
                deleted_verified_roots,
                cleared_synced_rows,
                cleared_tables,
            })
        }
        .await;
        match reset_result {
            Ok(report) => {
                self.store.commit_apply_batch().await?;
                if !report.cleared_tables.is_empty() {
                    self.store
                        .notify_local_tables_changed_with_rows(&report.cleared_tables, &[])
                        .await?;
                }
                Ok(report)
            }
            Err(error) => {
                let _ = self.store.rollback_apply_batch().await;
                Err(error)
            }
        }
    }

    pub async fn reset_local_sync_state_json(&mut self, request_json: &str) -> Result<String> {
        let request: crate::health::LocalSyncResetRequest = serde_json::from_str(request_json)?;
        Ok(serde_json::to_string(
            &self.reset_local_sync_state(request).await?,
        )?)
    }

    fn selected_reset_subscriptions(
        &self,
        subscription_ids: &[String],
    ) -> Result<Vec<SubscriptionSpec>> {
        if subscription_ids.is_empty() {
            return Ok(self.subscriptions.clone());
        }
        let requested = subscription_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let selected = self
            .subscriptions
            .iter()
            .filter(|subscription| requested.contains(subscription.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if selected.len() != requested.len() {
            let configured = self
                .subscriptions
                .iter()
                .map(|subscription| subscription.id.as_str())
                .collect::<HashSet<_>>();
            let missing = subscription_ids
                .iter()
                .find(|id| !configured.contains(id.as_str()))
                .map(String::as_str)
                .unwrap_or("unknown");
            return Err(SyncularError::config(format!(
                "cannot reset unconfigured subscription {missing}"
            )));
        }
        Ok(selected)
    }

    async fn repair_force_rebootstrap(
        &mut self,
        subscription_ids: &[String],
    ) -> Result<crate::health::LocalHealthRepairReport> {
        if subscription_ids.is_empty() {
            return Err(SyncularError::config(
                "forceRebootstrap repair requires explicit subscriptionIds",
            ));
        }
        let configured = self
            .subscriptions
            .iter()
            .map(|subscription| subscription.id.clone())
            .collect::<HashSet<_>>();
        for subscription_id in subscription_ids {
            if !configured.contains(subscription_id) {
                return Err(SyncularError::config(format!(
                    "cannot force rebootstrap for unconfigured subscription {subscription_id}"
                )));
            }
        }
        let requested = subscription_ids.iter().cloned().collect::<HashSet<_>>();
        let deleted_subscription_states = self
            .store
            .subscription_states()
            .await?
            .iter()
            .filter(|state| requested.contains(&state.subscription_id))
            .count();
        let deleted_verified_roots = self
            .store
            .verified_roots()
            .await?
            .iter()
            .filter(|root| requested.contains(&root.subscription_id))
            .count();
        for subscription_id in subscription_ids {
            self.store.delete_verified_root(subscription_id).await?;
            self.store
                .delete_subscription_state(subscription_id)
                .await?;
        }
        Ok(crate::health::LocalHealthRepairReport {
            action: crate::health::LocalHealthRepairAction::ForceRebootstrap,
            deleted_subscription_states,
            deleted_verified_roots,
            forced_rebootstrap_subscriptions: subscription_ids.len(),
            cleared_orphaned_synced_rows: 0,
            cleared_tables: Vec::new(),
        })
    }

    async fn repair_clear_orphaned_state(
        &mut self,
        subscription_ids: &[String],
    ) -> Result<crate::health::LocalHealthRepairReport> {
        let configured = self
            .subscriptions
            .iter()
            .map(|subscription| subscription.id.clone())
            .collect::<HashSet<_>>();
        for subscription_id in subscription_ids {
            if configured.contains(subscription_id) {
                return Err(SyncularError::config(format!(
                    "clearOrphanedState refuses configured subscription {subscription_id}"
                )));
            }
        }
        let requested = subscription_ids.iter().cloned().collect::<HashSet<_>>();
        let states = self.store.subscription_states().await?;
        let roots = self.store.verified_roots().await?;
        let state_ids = states
            .iter()
            .map(|state| state.subscription_id.clone())
            .filter(|id| !configured.contains(id))
            .filter(|id| requested.is_empty() || requested.contains(id))
            .collect::<HashSet<_>>();
        let root_ids = roots
            .iter()
            .map(|root| root.subscription_id.clone())
            .filter(|id| !configured.contains(id))
            .filter(|id| requested.is_empty() || requested.contains(id))
            .collect::<HashSet<_>>();
        let mut all_ids = state_ids.iter().cloned().collect::<HashSet<_>>();
        all_ids.extend(root_ids.iter().cloned());
        for subscription_id in &all_ids {
            self.store
                .delete_subscription_state(subscription_id)
                .await?;
            self.store.delete_verified_root(subscription_id).await?;
        }
        Ok(crate::health::LocalHealthRepairReport {
            action: crate::health::LocalHealthRepairAction::ClearOrphanedState,
            deleted_subscription_states: state_ids.len(),
            deleted_verified_roots: root_ids.len(),
            forced_rebootstrap_subscriptions: 0,
            cleared_orphaned_synced_rows: 0,
            cleared_tables: Vec::new(),
        })
    }

    async fn repair_clear_orphaned_synced_rows(
        &mut self,
        request: &crate::health::LocalHealthRepairRequest,
    ) -> Result<crate::health::LocalHealthRepairReport> {
        if !request.subscription_ids.is_empty() {
            return Err(SyncularError::config(
                "clearOrphanedSyncedRows uses tables, not subscriptionIds",
            ));
        }
        let unresolved_outbox = self
            .store
            .outbox_summaries()
            .await?
            .iter()
            .filter(|commit| commit.status != "acked")
            .count();
        if unresolved_outbox > 0 {
            return Err(SyncularError::config(format!(
                "clearOrphanedSyncedRows requires an empty local outbox; found {unresolved_outbox} unresolved commits"
            )));
        }

        self.store.begin_apply_batch().await?;
        let repair_result = async {
            self.store
                .clear_orphaned_synced_rows(&self.subscriptions, &request.tables)
                .await
        }
        .await;
        let summary = match repair_result {
            Ok(summary) => {
                self.store.commit_apply_batch().await?;
                summary
            }
            Err(error) => {
                let _ = self.store.rollback_apply_batch().await;
                return Err(error);
            }
        };
        let cleared_orphaned_synced_rows = summary.orphaned_synced_rows;
        let cleared_tables = summary
            .tables
            .into_iter()
            .filter(|table| table.orphaned_synced_rows > 0)
            .map(|table| table.table)
            .collect::<Vec<_>>();
        if !cleared_tables.is_empty() {
            self.store
                .notify_local_tables_changed_with_rows(&cleared_tables, &[])
                .await?;
        }
        Ok(crate::health::LocalHealthRepairReport {
            action: crate::health::LocalHealthRepairAction::ClearOrphanedSyncedRows,
            deleted_subscription_states: 0,
            deleted_verified_roots: 0,
            forced_rebootstrap_subscriptions: 0,
            cleared_orphaned_synced_rows,
            cleared_tables,
        })
    }

    pub fn set_field_encryption(&mut self, encryption: Option<FieldEncryption>) -> Result<()> {
        if let Some(encryption) = &encryption {
            validate_field_encryption_rules_against_app_schema(
                self.store.app_schema(),
                encryption.rules(),
            )?;
        }
        self.field_encryption = encryption;
        Ok(())
    }

    pub fn set_field_encryption_json(&mut self, config_json: &str) -> Result<()> {
        self.set_field_encryption(FieldEncryption::from_static_config_json(config_json)?)
    }

    pub fn set_encrypted_crdt(&mut self, encryption: Option<EncryptedCrdt>) -> Result<()> {
        if encryption.is_some() {
            validate_encrypted_crdt_against_app_schema(self.store.app_schema())?;
        }
        self.encrypted_crdt = encryption;
        Ok(())
    }

    pub fn set_encrypted_crdt_json(&mut self, config_json: &str) -> Result<()> {
        self.set_encrypted_crdt(EncryptedCrdt::from_static_config_json(config_json)?)
    }

    pub fn set_blob_encryption(&mut self, encryption: Option<BlobEncryption>) -> Result<()> {
        if encryption.is_some() {
            validate_blob_encryption_against_app_schema(self.store.app_schema())?;
        }
        self.blob_encryption = encryption;
        Ok(())
    }

    pub fn set_blob_encryption_json(&mut self, config_json: &str) -> Result<()> {
        self.set_blob_encryption(BlobEncryption::from_static_config_json(config_json)?)
    }

    pub fn blob_encryption(&self) -> Option<&BlobEncryption> {
        self.blob_encryption.as_ref()
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        self.adaptive_outbox_pending_count_hint = None;
        &mut self.store
    }

    pub fn config(&self) -> &WebSyncularClientConfig {
        &self.config
    }

    fn schema_version(&self) -> i32 {
        self.store.app_schema().current_schema_version()
    }

    pub fn encrypted_crdt(&self) -> Option<&EncryptedCrdt> {
        self.encrypted_crdt.as_ref()
    }

    pub async fn sync_pull(&mut self) -> Result<WebSyncResult> {
        let total_started_at = timing_now_ms();
        let request = CombinedRequest {
            client_id: self.config.client_id.clone(),
            push: None,
            pull: Some(self.build_pull_request().await?),
        };
        let request_started_at = timing_now_ms();
        let response = self.transport.post_sync(&request).await?;
        let pull_request_ms = elapsed_ms_since(request_started_at);
        validate_server_schema_version(
            response.required_schema_version,
            response.latest_schema_version,
            self.schema_version(),
        )?;
        if !response.ok {
            return Err(SyncularError::protocol_message(
                "combined browser sync response was not ok",
            ));
        }

        let Some(pull) = response.pull else {
            let mut result = WebSyncResult::default();
            result.timings.total_ms = elapsed_ms_since(total_started_at);
            result.timings.pull_ms = result.timings.total_ms;
            result.timings.pull_request_ms = pull_request_ms;
            return Ok(result);
        };
        if !pull.ok {
            return Err(SyncularError::protocol_message(
                "browser pull response was not ok",
            ));
        }

        let mut result = WebSyncResult::default();
        let integrity_verify_started_at = timing_now_ms();
        let verified_roots = self.verify_pull_response_integrity(&pull).await?;
        result.timings.integrity_verify_ms += elapsed_ms_since(integrity_verify_started_at);
        let transform_started_at = timing_now_ms();
        let pull = self.transform_pull_response(pull)?;
        let pull_transform_ms = elapsed_ms_since(transform_started_at);
        self.store.begin_apply_batch().await?;
        let apply_started_at = timing_now_ms();
        let apply_result = self
            .apply_pull_response(pull, &mut result, verified_roots)
            .await;
        result.timings.pull_apply_ms = elapsed_ms_since(apply_started_at);
        add_store_apply_timings(&mut result.timings, self.store.drain_apply_timings());
        match apply_result {
            Ok(()) => self.store.commit_apply_batch().await?,
            Err(error) => {
                let _ = self.store.rollback_apply_batch().await;
                return Err(error);
            }
        }

        let notify_started_at = timing_now_ms();
        self.store
            .notify_tables_changed_with_rows_meta(
                &result.changed_tables,
                &result.changed_rows,
                result.changed_rows_truncated,
            )
            .await?;
        result.timings.notify_ms = elapsed_ms_since(notify_started_at);
        result.timings.pull_request_ms = pull_request_ms;
        result.timings.pull_transform_ms = pull_transform_ms;
        result.timings.total_ms = elapsed_ms_since(total_started_at);
        result.timings.pull_ms = result.timings.total_ms;
        Ok(result)
    }

    async fn apply_pull_response(
        &mut self,
        pull: PullResponse,
        result: &mut WebSyncResult,
        mut verified_roots: HashMap<String, Option<VerifiedCommitRoot>>,
    ) -> Result<()> {
        let app_schema = self.store.app_schema();
        let include_snapshot_rows = self.config.pull.include_snapshot_rows;
        let collect_changed_rows = self.config.pull.collect_changed_rows;
        let max_snapshot_changed_rows = self.config.pull.max_snapshot_changed_rows;
        let mut snapshot_changed_rows = 0usize;
        for mut sub in pull.subscriptions {
            let previous_state = self.store.subscription_state(&sub.id).await?;
            let scopes_changed = previous_state
                .as_ref()
                .is_some_and(|state| state.scopes != sub.scopes);
            let verified_root = verified_roots.remove(&sub.id).flatten();
            let table = self
                .subscriptions
                .iter()
                .find(|candidate| candidate.id == sub.id)
                .map(|spec| spec.table.clone())
                .or_else(|| previous_state.as_ref().map(|state| state.table.clone()))
                .unwrap_or_else(|| sub.id.clone());

            let mut snapshot_rows = Vec::new();
            let mut last_checkpointed_bootstrap_state: Option<BootstrapState> = None;
            if let Some(snapshots) = &sub.snapshots {
                let continuing_cleared_snapshot = previous_state.as_ref().is_some_and(|state| {
                    state.bootstrap_state.is_some()
                        && state.scopes == sub.scopes
                        && snapshot_clear_removes_all_rows(app_schema, &table)
                });
                let mut scope_cleared_for_snapshot = continuing_cleared_snapshot;
                for snapshot in snapshots {
                    let snapshot_table = snapshot.table.clone();
                    let direct_artifact_apply = self.should_request_sqlite_snapshot_artifacts();
                    let mut artifact_refs = Vec::new();
                    if let Some(artifacts) = &snapshot.artifacts {
                        if !artifacts.is_empty() && !self.store.supports_sqlite_snapshot_artifacts()
                        {
                            return Err(SyncularError::protocol_message(
                                "snapshot artifacts are not supported by this store",
                            ));
                        }
                        for artifact in artifacts {
                            validate_sqlite_snapshot_artifact_for_apply(
                                artifact,
                                &sub.id,
                                &snapshot_table,
                            )?;
                            if direct_artifact_apply {
                                artifact_refs.push(artifact.clone());
                            } else {
                                return Err(SyncularError::protocol_message(
                                    "sqlite snapshot artifacts require direct browser apply",
                                ));
                            }
                        }
                    }
                    let mut chunk_batches = Vec::new();
                    if let Some(chunks) = &snapshot.chunks {
                        for chunk in chunks {
                            let snapshot_fetch_started_at = timing_now_ms();
                            let fetched = self
                                .transport
                                .fetch_snapshot_chunk_rows(chunk, &sub.scopes)
                                .await?;
                            if self.field_encryption.is_some() {
                                let rows = fetched
                                    .try_into_value_rows()?
                                    .into_iter()
                                    .map(|row| self.transform_snapshot_row(&snapshot_table, row))
                                    .collect::<Result<Vec<_>>>()?;
                                chunk_batches.push(SnapshotChunkRows::Json(rows));
                            } else {
                                chunk_batches.push(fetched);
                            }
                            result.timings.snapshot_fetch_ms +=
                                elapsed_ms_since(snapshot_fetch_started_at);
                        }
                    }
                    let chunk_row_count = chunk_batches
                        .iter()
                        .map(SnapshotChunkRows::row_count)
                        .sum::<usize>();
                    let mut checkpoint_after_snapshot = false;
                    if snapshot.is_first_page
                        || !snapshot.rows.is_empty()
                        || !artifact_refs.is_empty()
                        || chunk_row_count > 0
                    {
                        add_changed_table(&mut result.changed_tables, &snapshot_table);
                    }

                    let inline_rows = snapshot.rows.clone();
                    let mut prefetched_artifacts = Vec::with_capacity(artifact_refs.len());
                    if !collect_changed_rows && !include_snapshot_rows {
                        for artifact in artifact_refs {
                            let snapshot_fetch_started_at = timing_now_ms();
                            let bytes = self
                                .transport
                                .fetch_snapshot_artifact_bytes(&artifact, &sub.scopes)
                                .await?;
                            result.timings.snapshot_fetch_ms +=
                                elapsed_ms_since(snapshot_fetch_started_at);
                            prefetched_artifacts.push((artifact, bytes));
                        }
                    }
                    if snapshot.is_first_page {
                        let scope_clear_started_at = timing_now_ms();
                        self.store
                            .clear_table_for_scopes_preserving_local_crdt(
                                &snapshot_table,
                                &sub.scopes,
                            )
                            .await?;
                        result.timings.scope_clear_ms += elapsed_ms_since(scope_clear_started_at);
                        scope_cleared_for_snapshot = true;
                    }
                    if include_snapshot_rows {
                        snapshot_rows.extend(inline_rows.clone());
                    }
                    if !collect_changed_rows && !include_snapshot_rows {
                        let row_apply_started_at = timing_now_ms();
                        self.store.upsert_rows(&snapshot_table, inline_rows).await?;
                        result.timings.snapshot_row_apply_ms +=
                            elapsed_ms_since(row_apply_started_at);
                        let mut applied_direct_artifact = false;
                        for (_artifact, bytes) in prefetched_artifacts {
                            let artifact_apply_started_at = timing_now_ms();
                            let mode = if scope_cleared_for_snapshot {
                                WebSnapshotArtifactApplyMode::Insert
                            } else {
                                WebSnapshotArtifactApplyMode::Upsert
                            };
                            self.store
                                .apply_sqlite_snapshot_artifact_rows(&snapshot_table, bytes, mode)
                                .await?;
                            applied_direct_artifact = true;
                            let artifact_apply_ms = elapsed_ms_since(artifact_apply_started_at);
                            result.timings.snapshot_row_apply_ms += artifact_apply_ms;
                            result.timings.snapshot_artifact_apply_ms += artifact_apply_ms;
                        }
                        for rows in chunk_batches {
                            let chunk_apply_started_at = timing_now_ms();
                            if scope_cleared_for_snapshot {
                                self.store
                                    .insert_cleared_snapshot_chunk_rows(&snapshot_table, rows)
                                    .await?;
                            } else {
                                self.store
                                    .upsert_snapshot_chunk_rows(&snapshot_table, rows)
                                    .await?;
                            }
                            result.timings.snapshot_chunk_apply_ms +=
                                elapsed_ms_since(chunk_apply_started_at);
                        }
                        if applied_direct_artifact && snapshot.bootstrap_state_after.is_some() {
                            checkpoint_after_snapshot = true;
                        }
                    } else {
                        let mut rows_to_upsert = Vec::with_capacity(inline_rows.len());
                        for row in inline_rows {
                            let previous_row =
                                if !collect_changed_rows || scope_cleared_for_snapshot {
                                    None
                                } else {
                                    previous_web_snapshot_row(
                                        &mut self.store,
                                        app_schema,
                                        &snapshot_table,
                                        &row,
                                    )
                                    .await?
                                };
                            if collect_changed_rows {
                                if let Some(changed_row) = sync_changed_row_for_snapshot(
                                    app_schema,
                                    &snapshot_table,
                                    &row,
                                    previous_row.as_ref(),
                                    &sub.id,
                                ) {
                                    push_snapshot_changed_row(
                                        result,
                                        &mut snapshot_changed_rows,
                                        max_snapshot_changed_rows,
                                        changed_row,
                                    );
                                }
                            }
                            rows_to_upsert.push(row);
                        }
                        let row_apply_started_at = timing_now_ms();
                        self.store
                            .upsert_rows(&snapshot_table, rows_to_upsert)
                            .await?;
                        result.timings.snapshot_row_apply_ms +=
                            elapsed_ms_since(row_apply_started_at);

                        for batch in chunk_batches {
                            if scope_cleared_for_snapshot && !include_snapshot_rows {
                                if collect_changed_rows {
                                    let remaining = snapshot_changed_row_budget(
                                        snapshot_changed_rows,
                                        max_snapshot_changed_rows,
                                    );
                                    let (changed_rows, truncated) =
                                        sync_changed_rows_for_cleared_snapshot_chunk_limited(
                                            app_schema,
                                            &snapshot_table,
                                            &batch,
                                            &sub.id,
                                            remaining,
                                        );
                                    snapshot_changed_rows =
                                        snapshot_changed_rows.saturating_add(changed_rows.len());
                                    result.changed_rows.extend(changed_rows);
                                    if truncated {
                                        result.changed_rows_truncated = true;
                                    }
                                }
                                let chunk_apply_started_at = timing_now_ms();
                                self.store
                                    .insert_cleared_snapshot_chunk_rows(&snapshot_table, batch)
                                    .await?;
                                result.timings.snapshot_chunk_apply_ms +=
                                    elapsed_ms_since(chunk_apply_started_at);
                                continue;
                            }
                            let materialize_started_at = timing_now_ms();
                            let chunk_rows = batch.try_into_value_rows()?;
                            result.timings.snapshot_chunk_materialize_ms +=
                                elapsed_ms_since(materialize_started_at);
                            let mut chunk_rows_to_upsert = Vec::with_capacity(chunk_rows.len());
                            for row in chunk_rows {
                                let previous_row =
                                    if !collect_changed_rows || scope_cleared_for_snapshot {
                                        None
                                    } else {
                                        previous_web_snapshot_row(
                                            &mut self.store,
                                            app_schema,
                                            &snapshot_table,
                                            &row,
                                        )
                                        .await?
                                    };
                                if collect_changed_rows {
                                    if let Some(changed_row) = sync_changed_row_for_snapshot(
                                        app_schema,
                                        &snapshot_table,
                                        &row,
                                        previous_row.as_ref(),
                                        &sub.id,
                                    ) {
                                        push_snapshot_changed_row(
                                            result,
                                            &mut snapshot_changed_rows,
                                            max_snapshot_changed_rows,
                                            changed_row,
                                        );
                                    }
                                }
                                if include_snapshot_rows {
                                    snapshot_rows.push(row.clone());
                                }
                                chunk_rows_to_upsert.push(row);
                            }
                            let row_apply_started_at = timing_now_ms();
                            self.store
                                .upsert_rows(&snapshot_table, chunk_rows_to_upsert)
                                .await?;
                            result.timings.snapshot_row_apply_ms +=
                                elapsed_ms_since(row_apply_started_at);
                        }
                    }
                    if let Some(bootstrap_state_after) = snapshot.bootstrap_state_after.clone() {
                        let subscription_state_started_at = timing_now_ms();
                        self.store
                            .upsert_subscription_state(WebSubscriptionState {
                                subscription_id: sub.id.clone(),
                                table: table.clone(),
                                scopes: sub.scopes.clone(),
                                cursor: sub.next_cursor,
                                bootstrap_state: Some(bootstrap_state_after.clone()),
                                status: sub.status.clone(),
                            })
                            .await?;
                        result.timings.subscription_state_ms +=
                            elapsed_ms_since(subscription_state_started_at);
                        last_checkpointed_bootstrap_state = Some(bootstrap_state_after);
                    }
                    if checkpoint_after_snapshot {
                        let checkpoint_started_at = timing_now_ms();
                        self.store.checkpoint_apply_batch().await?;
                        result.timings.snapshot_artifact_checkpoint_ms +=
                            elapsed_ms_since(checkpoint_started_at);
                        result.timings.snapshot_artifact_checkpoint_count += 1;
                    }
                }
            }
            let commits = std::mem::take(&mut sub.commits);
            let commit_apply_started_at = timing_now_ms();
            if collect_changed_rows {
                for commit in commits {
                    for change in commit.changes {
                        add_changed_table(&mut result.changed_tables, &change.table);
                        let previous_row = self
                            .store
                            .current_row_json(&change.table, &change.row_id)
                            .await?;
                        self.store.apply_change(change.clone()).await?;
                        if let Some(changed_row) = sync_changed_row_for_change(
                            app_schema,
                            &change,
                            previous_row.as_ref(),
                            commit.commit_seq,
                            &sub.id,
                        ) {
                            result.changed_rows.push(changed_row);
                        }
                    }
                }
            } else {
                apply_commits_without_changed_rows(&mut self.store, result, commits).await?;
            }
            result.timings.commit_apply_ms += elapsed_ms_since(commit_apply_started_at);

            let subscription_state_started_at = timing_now_ms();
            if sub.status == "revoked" {
                if let Some(previous_state) = &previous_state {
                    let scope_clear_started_at = timing_now_ms();
                    self.store
                        .clear_table_for_scopes(&previous_state.table, &previous_state.scopes)
                        .await?;
                    result.timings.scope_clear_ms += elapsed_ms_since(scope_clear_started_at);
                    add_changed_table(&mut result.changed_tables, &previous_state.table);
                }
                self.store.delete_verified_root(&sub.id).await?;
                self.store.delete_subscription_state(&sub.id).await?;
            } else {
                if let Some(previous_state) = &previous_state {
                    if scopes_changed {
                        let scope_clear_started_at = timing_now_ms();
                        if previous_state.table == table {
                            self.store
                                .clear_table_for_scopes_except(
                                    &previous_state.table,
                                    &previous_state.scopes,
                                    &sub.scopes,
                                )
                                .await?;
                        } else {
                            self.store
                                .clear_table_for_scopes(
                                    &previous_state.table,
                                    &previous_state.scopes,
                                )
                                .await?;
                        }
                        result.timings.scope_clear_ms += elapsed_ms_since(scope_clear_started_at);
                        add_changed_table(&mut result.changed_tables, &previous_state.table);
                        self.store.delete_verified_root(&sub.id).await?;
                    }
                }
                let subscription_state_already_checkpointed = last_checkpointed_bootstrap_state
                    .as_ref()
                    .is_some_and(|state| Some(state) == sub.bootstrap_state.as_ref());
                if !subscription_state_already_checkpointed {
                    self.store
                        .upsert_subscription_state(WebSubscriptionState {
                            subscription_id: sub.id.clone(),
                            table: table.clone(),
                            scopes: sub.scopes.clone(),
                            cursor: sub.next_cursor,
                            bootstrap_state: sub.bootstrap_state.clone(),
                            status: sub.status.clone(),
                        })
                        .await?;
                }
                if let Some(root) = verified_root {
                    self.store
                        .upsert_verified_root(WebVerifiedRoot {
                            subscription_id: sub.id.clone(),
                            partition_id: root.partition_id,
                            commit_seq: root.commit_seq,
                            root: root.root,
                        })
                        .await?;
                }
            }
            result.timings.subscription_state_ms += elapsed_ms_since(subscription_state_started_at);

            result.subscriptions.push(WebSubscriptionResult {
                bootstrap_phase: self.subscription_bootstrap_phase(&sub.id),
                bootstrap_state: sub.bootstrap_state.clone(),
                ready: web_subscription_ready_parts(
                    &sub.status,
                    sub.next_cursor,
                    sub.bootstrap_state.as_ref(),
                ),
                phase: web_subscription_phase(
                    &sub.status,
                    sub.next_cursor,
                    sub.bootstrap_state.as_ref(),
                ),
                progress_percent: web_subscription_progress_percent(
                    &sub.status,
                    sub.next_cursor,
                    sub.bootstrap_state.as_ref(),
                ),
                id: sub.id,
                table,
                status: sub.status,
                scopes: sub.scopes,
                next_cursor: sub.next_cursor,
                snapshot_rows,
                commits: sub.commits,
            });
        }
        Ok(())
    }

    async fn verify_pull_response_integrity(
        &mut self,
        pull: &PullResponse,
    ) -> Result<HashMap<String, Option<VerifiedCommitRoot>>> {
        validate_pull_commit_integrity_metadata(pull)?;
        validate_pull_snapshot_manifests(pull)?;
        let mut verified_roots = HashMap::new();
        for sub in &pull.subscriptions {
            if sub.status == "revoked" {
                verified_roots.insert(sub.id.clone(), None);
                continue;
            }

            let previous_state = self.store.subscription_state(&sub.id).await?;
            let scopes_changed = previous_state
                .as_ref()
                .is_some_and(|state| state.scopes != sub.scopes);
            let stored_root = if scopes_changed {
                None
            } else {
                self.store.verified_root(&sub.id).await?
            };
            let verified_root = verify_subscription_commit_integrity(
                &sub.id,
                stored_root.as_ref().map(|root| root.root.as_str()),
                sub.integrity.as_ref(),
                &sub.commits,
            )?;
            verified_roots.insert(sub.id.clone(), verified_root);
        }
        Ok(verified_roots)
    }

    pub async fn sync_pull_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.sync_pull().await?)?)
    }

    pub async fn apply_realtime_sync_pack_bytes(&mut self, bytes: &[u8]) -> Result<WebSyncResult> {
        validate_realtime_sync_pack_bytes(bytes)?;
        let total_started_at = timing_now_ms();
        let response = decode_binary_sync_pack(bytes)?;
        let sync_pack_decode_ms = elapsed_ms_since(total_started_at);
        let mut result = self
            .apply_realtime_combined_response(response, total_started_at)
            .await?;
        result.timings.sync_pack_decode_ms = sync_pack_decode_ms;
        Ok(result)
    }

    async fn apply_realtime_combined_response(
        &mut self,
        response: CombinedResponse,
        total_started_at: i64,
    ) -> Result<WebSyncResult> {
        validate_server_schema_version(
            response.required_schema_version,
            response.latest_schema_version,
            self.schema_version(),
        )?;
        if !response.ok {
            return Err(SyncularError::protocol_message(
                "realtime sync-pack response was not ok",
            ));
        }
        if !self.store.pending_outbox(1).await?.is_empty() {
            return Err(SyncularError::message(
                ErrorKind::Busy,
                "realtime sync-pack apply requires an empty local outbox",
            ));
        }

        let Some(pull) = response.pull else {
            let mut result = WebSyncResult::default();
            result.timings.total_ms = elapsed_ms_since(total_started_at);
            result.timings.pull_ms = result.timings.total_ms;
            return Ok(result);
        };
        let mut result = WebSyncResult::default();
        let integrity_verify_started_at = timing_now_ms();
        let mut verified_roots = self.verify_pull_response_integrity(&pull).await?;
        result.timings.integrity_verify_ms += elapsed_ms_since(integrity_verify_started_at);
        let transform_started_at = timing_now_ms();
        let pull = self.transform_pull_response(pull)?;
        result.timings.pull_transform_ms = elapsed_ms_since(transform_started_at);
        if !pull
            .subscriptions
            .iter()
            .any(|subscription| !subscription.commits.is_empty())
        {
            result.timings.total_ms = elapsed_ms_since(total_started_at);
            result.timings.pull_ms = result.timings.total_ms;
            return Ok(result);
        }

        self.store.begin_apply_batch().await?;
        let apply_started_at = timing_now_ms();
        let apply_result = async {
            for subscription in pull.subscriptions {
                let verified_root = verified_roots.remove(&subscription.id).flatten();
                self.apply_realtime_subscription_response(&mut result, subscription, verified_root)
                    .await?;
            }
            Ok(())
        }
        .await;
        result.timings.pull_apply_ms = elapsed_ms_since(apply_started_at);
        match apply_result {
            Ok(()) => self.store.commit_apply_batch().await?,
            Err(error) => {
                let _ = self.store.rollback_apply_batch().await;
                return Err(error);
            }
        }

        let notify_started_at = timing_now_ms();
        self.store
            .notify_tables_changed_with_rows_meta(
                &result.changed_tables,
                &result.changed_rows,
                result.changed_rows_truncated,
            )
            .await?;
        result.timings.notify_ms = elapsed_ms_since(notify_started_at);
        result.timings.total_ms = elapsed_ms_since(total_started_at);
        result.timings.pull_ms = result.timings.total_ms;
        Ok(result)
    }

    async fn apply_realtime_subscription_response(
        &mut self,
        result: &mut WebSyncResult,
        subscription: crate::protocol::SubscriptionResponse,
        verified_root: Option<VerifiedCommitRoot>,
    ) -> Result<()> {
        if subscription.status != "active" {
            return Err(SyncularError::protocol_message(
                "realtime sync-pack cannot revoke subscriptions",
            ));
        }

        let subscription_state_started_at = timing_now_ms();
        let Some(mut state) = self.store.subscription_state(&subscription.id).await? else {
            return Err(SyncularError::protocol_message(format!(
                "realtime sync-pack subscription {} has no active local state",
                subscription.id
            )));
        };
        if state.status == "revoked" {
            return Err(SyncularError::protocol_message(format!(
                "realtime sync-pack subscription {} is locally revoked",
                subscription.id
            )));
        }
        if state.scopes != subscription.scopes {
            return Err(SyncularError::protocol_message(format!(
                "realtime sync-pack subscription {} scopes do not match local state",
                subscription.id
            )));
        }
        if !subscription.commits.is_empty() && subscription.integrity.is_none() {
            return Err(SyncularError::protocol_message(format!(
                "realtime sync-pack subscription {} is missing integrity metadata",
                subscription.id
            )));
        }

        result.timings.subscription_state_ms += elapsed_ms_since(subscription_state_started_at);

        result.subscriptions.push(WebSubscriptionResult {
            id: subscription.id.clone(),
            table: state.table.clone(),
            status: subscription.status.clone(),
            scopes: subscription.scopes.clone(),
            next_cursor: subscription.next_cursor,
            bootstrap_phase: self.subscription_bootstrap_phase(&subscription.id),
            bootstrap_state: subscription.bootstrap_state.clone(),
            ready: web_subscription_ready_parts(
                &subscription.status,
                subscription.next_cursor,
                subscription.bootstrap_state.as_ref(),
            ),
            phase: web_subscription_phase(
                &subscription.status,
                subscription.next_cursor,
                subscription.bootstrap_state.as_ref(),
            ),
            progress_percent: web_subscription_progress_percent(
                &subscription.status,
                subscription.next_cursor,
                subscription.bootstrap_state.as_ref(),
            ),
            snapshot_rows: Vec::new(),
            commits: Vec::new(),
        });

        let commit_apply_started_at = timing_now_ms();
        self.apply_realtime_commits(result, &subscription.id, subscription.commits)
            .await?;
        result.timings.commit_apply_ms += elapsed_ms_since(commit_apply_started_at);

        let subscription_state_started_at = timing_now_ms();
        if state.cursor < subscription.next_cursor {
            state.cursor = subscription.next_cursor;
        }
        state.status = subscription.status;
        self.store.upsert_subscription_state(state).await?;
        if let Some(root) = verified_root {
            self.store
                .upsert_verified_root(WebVerifiedRoot {
                    subscription_id: subscription.id,
                    partition_id: root.partition_id,
                    commit_seq: root.commit_seq,
                    root: root.root,
                })
                .await?;
        }
        result.timings.subscription_state_ms += elapsed_ms_since(subscription_state_started_at);

        Ok(())
    }

    pub async fn sync_push(&mut self) -> Result<WebSyncResult> {
        let total_started_at = timing_now_ms();
        let pending = self.prepare_push().await?;
        if pending.is_empty() {
            let mut result = WebSyncResult::default();
            result.timings.total_ms = elapsed_ms_since(total_started_at);
            result.timings.push_ms = result.timings.total_ms;
            return Ok(result);
        }

        let request = CombinedRequest {
            client_id: self.config.client_id.clone(),
            push: self.build_push_request(&pending)?,
            pull: None,
        };
        let response = match self.transport.post_sync(&request).await {
            Ok(response) => response,
            Err(error) => {
                self.adaptive_outbox_pending_count_hint = None;
                return Err(error);
            }
        };
        if let Err(error) = validate_server_schema_version(
            response.required_schema_version,
            response.latest_schema_version,
            self.schema_version(),
        ) {
            self.adaptive_outbox_pending_count_hint = None;
            self.schedule_outbox_retry(&pending, &error).await?;
            return Err(error);
        }
        if !response.ok {
            let error =
                SyncularError::protocol_message("combined browser push response was not ok");
            self.adaptive_outbox_pending_count_hint = None;
            self.schedule_outbox_retry(&pending, &error).await?;
            return Err(error);
        }

        let mut pushed_commits = 0usize;
        if let Some(push) = response.push {
            if !push.ok {
                let error = SyncularError::protocol_message("browser push response was not ok");
                self.adaptive_outbox_pending_count_hint = None;
                self.schedule_outbox_retry(&pending, &error).await?;
                return Err(error);
            }

            for commit_response in push.commits {
                let Some(outbox) = pending
                    .iter()
                    .find(|row| row.client_commit_id == commit_response.client_commit_id)
                else {
                    continue;
                };
                let commit_response = self.transform_push_response(outbox, commit_response)?;

                match commit_response.status.as_str() {
                    "applied" | "cached" => {
                        self.store
                            .mark_pushed_operation_server_versions(
                                outbox.clone(),
                                commit_response.clone(),
                            )
                            .await?;
                        self.store
                            .mark_outbox_acked(&outbox.id, commit_response)
                            .await?;
                        pushed_commits += 1;
                    }
                    _ => {
                        for result in &commit_response.results {
                            if result.status == "conflict" || result.status == "error" {
                                self.store
                                    .insert_conflict(outbox.clone(), result.clone())
                                    .await?;
                            }
                        }
                        self.store
                            .mark_outbox_failed(&outbox.id, "REJECTED", commit_response)
                            .await?;
                    }
                }
            }
        }

        let mut result = WebSyncResult {
            pushed_commits,
            ..WebSyncResult::default()
        };
        if let Some(count) = &mut self.adaptive_outbox_pending_count_hint {
            *count = count.saturating_sub(pushed_commits);
        }
        result.timings.total_ms = elapsed_ms_since(total_started_at);
        result.timings.push_ms = result.timings.total_ms;
        Ok(result)
    }

    pub async fn sync_push_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.sync_push().await?)?)
    }

    pub async fn recover_sending_outbox_after_sync_error(
        &mut self,
        error_message: &str,
    ) -> Result<()> {
        let sending = self
            .store
            .sending_outbox(self.outbox_recovery_batch_limit()?)
            .await?;
        let error = SyncularError::message(ErrorKind::Transport, error_message);
        self.schedule_outbox_retry_inner(&sending, &error, true)
            .await
    }

    pub async fn sync_once(&mut self) -> Result<WebSyncResult> {
        let total_started_at = timing_now_ms();
        let mut result = self.sync_push().await?;
        let push_ms = result.timings.total_ms;
        let pull_result = self.sync_pull().await?;
        let pull_ms = pull_result.timings.total_ms;
        for table in pull_result.changed_tables {
            add_changed_table(&mut result.changed_tables, &table);
        }
        result.changed_rows_truncated =
            result.changed_rows_truncated || pull_result.changed_rows_truncated;
        result.changed_rows = pull_result.changed_rows;
        result.subscriptions = pull_result.subscriptions;
        result.timings = pull_result.timings;
        result.timings.push_ms = push_ms;
        result.timings.pull_ms = pull_ms;
        result.timings.total_ms = elapsed_ms_since(total_started_at);
        Ok(result)
    }

    async fn apply_realtime_commits(
        &mut self,
        result: &mut WebSyncResult,
        subscription_id: &str,
        commits: Vec<SyncCommit>,
    ) -> Result<()> {
        let app_schema = self.store.app_schema();
        if self.config.pull.collect_changed_rows {
            for commit in commits {
                for change in commit.changes {
                    add_changed_table(&mut result.changed_tables, &change.table);
                    let previous_row = self
                        .store
                        .current_row_json(&change.table, &change.row_id)
                        .await?;
                    self.store.apply_change(change.clone()).await?;
                    if let Some(changed_row) = sync_changed_row_for_change(
                        app_schema,
                        &change,
                        previous_row.as_ref(),
                        commit.commit_seq,
                        subscription_id,
                    ) {
                        result.changed_rows.push(changed_row);
                    }
                }
            }
            Ok(())
        } else {
            apply_commits_without_changed_rows(&mut self.store, result, commits).await
        }
    }

    pub async fn apply_mutation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        validate_mutation_json_input_size(operation_json, local_row_json)?;
        let operation: SyncOperation = serde_json::from_str(operation_json)?;
        let changed_tables = vec![operation.table.clone()];
        let previous_row = self
            .store
            .current_row_json(&operation.table, &operation.row_id)
            .await?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        let client_commit_id = self
            .store
            .apply_mutation(operation.clone(), local_row.clone())
            .await?;
        self.adaptive_outbox_pending_count_hint = None;
        let changed_rows = sync_changed_row_for_local_operation(
            self.store.app_schema(),
            &operation,
            previous_row.as_ref(),
            local_row.as_ref(),
            Some(client_commit_id.clone()),
        )
        .into_iter()
        .collect::<Vec<_>>();
        self.store
            .notify_local_tables_changed_with_rows(&changed_tables, &changed_rows)
            .await?;
        Ok(client_commit_id)
    }

    pub async fn apply_leased_mutation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        validate_mutation_json_input_size(operation_json, local_row_json)?;
        let operation: SyncOperation = serde_json::from_str(operation_json)?;
        let changed_tables = vec![operation.table.clone()];
        let previous_row = self
            .store
            .current_row_json(&operation.table, &operation.row_id)
            .await?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        let client_commit_id = self
            .store
            .apply_mutation_with_active_auth_lease(
                Some(&self.config.actor_id),
                now_ms(),
                operation.clone(),
                local_row.clone(),
            )
            .await?;
        self.adaptive_outbox_pending_count_hint = None;
        let changed_rows = sync_changed_row_for_local_operation(
            self.store.app_schema(),
            &operation,
            previous_row.as_ref(),
            local_row.as_ref(),
            Some(client_commit_id.clone()),
        )
        .into_iter()
        .collect::<Vec<_>>();
        self.store
            .notify_local_tables_changed_with_rows(&changed_tables, &changed_rows)
            .await?;
        Ok(client_commit_id)
    }

    pub async fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>> {
        self.store.conflict_summaries().await
    }

    pub async fn conflict_summaries_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.conflict_summaries().await?)?)
    }

    pub async fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()> {
        self.store.resolve_conflict(id, resolution).await
    }

    pub async fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String> {
        self.store.retry_conflict_keep_local(id).await
    }

    pub async fn list_table_json(&mut self, table: &str) -> Result<String> {
        self.store.list_table_json(table).await
    }

    fn subscription_bootstrap_phase(&self, subscription_id: &str) -> i64 {
        self.subscriptions
            .iter()
            .find(|spec| spec.id == subscription_id)
            .map(|spec| normalize_bootstrap_phase(spec.bootstrap_phase))
            .unwrap_or(0)
    }

    async fn build_pull_request(&mut self) -> Result<PullRequest> {
        let mut entries = Vec::new();
        for spec in &self.subscriptions {
            let state = self.store.subscription_state(&spec.id).await?;
            entries.push((spec.clone(), state));
        }
        let active_phase = resolve_active_bootstrap_phase_for_web(&entries);

        let mut subscriptions = Vec::new();
        for (spec, state) in entries {
            if !should_include_web_pull_subscription(&spec, state.as_ref(), active_phase) {
                continue;
            }
            let scopes_changed = state
                .as_ref()
                .is_some_and(|state| state.scopes != spec.scopes);
            let verified_root = if scopes_changed {
                None
            } else {
                self.store
                    .verified_root(&spec.id)
                    .await?
                    .map(|root| root.root)
            };
            let crdt_state_vectors = if is_encrypted_crdt_system_table(&spec.table) {
                Vec::new()
            } else {
                self.store
                    .crdt_state_vector_hints(
                        &spec.table,
                        &spec.scopes,
                        CRDT_STATE_VECTOR_HINT_LIMIT,
                    )
                    .await?
            };
            subscriptions.push(SubscriptionRequest {
                id: spec.id.clone(),
                table: spec.table.clone(),
                scopes: spec.scopes.clone(),
                params: spec.params.clone(),
                cursor: if scopes_changed {
                    -1
                } else {
                    state.as_ref().map(|state| state.cursor).unwrap_or(-1)
                },
                bootstrap_state: if scopes_changed {
                    None
                } else {
                    state.and_then(|state| state.bootstrap_state)
                },
                verified_root,
                crdt_state_vectors,
            });
        }

        let request_sqlite_snapshot_artifacts = self.should_request_sqlite_snapshot_artifacts();
        let max_snapshot_pages = if request_sqlite_snapshot_artifacts {
            self.config.pull.max_snapshot_pages.max(1).min(2)
        } else {
            self.config.pull.max_snapshot_pages
        };

        Ok(PullRequest {
            schema_version: self.schema_version(),
            limit_commits: self.config.pull.limit_commits,
            limit_snapshot_rows: self.config.pull.limit_snapshot_rows,
            max_snapshot_pages,
            dedupe_rows: self.config.pull.dedupe_rows,
            snapshot_artifacts: request_sqlite_snapshot_artifacts.then(|| {
                SnapshotArtifactsRequest {
                    artifact_kinds: vec![SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1.to_string()],
                    compressions: vec![SNAPSHOT_CHUNK_COMPRESSION_GZIP.to_string()],
                    feature_set: Vec::new(),
                }
            }),
            subscriptions,
        })
    }

    fn should_request_sqlite_snapshot_artifacts(&self) -> bool {
        self.store.supports_sqlite_snapshot_artifacts()
            && !self.config.pull.collect_changed_rows
            && !self.config.pull.include_snapshot_rows
            && self.field_encryption.is_none()
            && self.encrypted_crdt.is_none()
    }

    async fn prepare_push(&mut self) -> Result<Vec<OutboxCommit>> {
        let schema_version = self.schema_version();
        self.store.requeue_stale_outbox().await?;
        let pending = self.pending_outbox_for_next_push().await?;
        for commit in &pending {
            validate_outbox_schema_version(commit, schema_version)?;
        }
        for commit in &pending {
            self.store.mark_outbox_sending(&commit.id).await?;
        }
        Ok(pending)
    }

    async fn pending_outbox_for_next_push(&mut self) -> Result<Vec<OutboxCommit>> {
        let fixed_limit = self.outbox_push_batch_limit()?;
        if self.config.push.outbox_batch_limit.is_some() {
            self.adaptive_outbox_batch_active = false;
            return self.store.pending_outbox(fixed_limit).await;
        }

        let adaptive_limit = self.outbox_adaptive_batch_limit()?;
        let adaptive_threshold = self.outbox_adaptive_batch_threshold()?;
        if adaptive_limit <= fixed_limit {
            self.adaptive_outbox_batch_active = false;
            return self.store.pending_outbox(fixed_limit).await;
        }

        if self.adaptive_outbox_batch_active {
            let pending = self.store.pending_outbox(adaptive_limit).await?;
            if pending.len() < adaptive_limit {
                self.adaptive_outbox_batch_active = false;
            }
            return Ok(pending);
        }

        let pending_count = match self.adaptive_outbox_pending_count_hint {
            Some(count) => count,
            None => {
                let count = self.store.pending_outbox_count().await?;
                self.adaptive_outbox_pending_count_hint = Some(count);
                count
            }
        };
        if pending_count > adaptive_threshold {
            self.adaptive_outbox_batch_active = true;
            return self.store.pending_outbox(adaptive_limit).await;
        }

        self.adaptive_outbox_batch_active = false;
        self.store.pending_outbox(fixed_limit).await
    }

    fn outbox_push_batch_limit(&self) -> Result<usize> {
        self.validate_outbox_batch_limit(
            "push.outboxBatchLimit",
            self.config
                .push
                .outbox_batch_limit
                .unwrap_or_else(default_outbox_push_batch_limit),
        )
    }

    fn outbox_adaptive_batch_limit(&self) -> Result<usize> {
        self.validate_outbox_batch_limit(
            "push.adaptiveOutboxBatchLimit",
            self.config.push.adaptive_outbox_batch_limit,
        )
    }

    fn outbox_adaptive_batch_threshold(&self) -> Result<usize> {
        self.validate_outbox_batch_limit(
            "push.adaptiveOutboxBatchThreshold",
            self.config.push.adaptive_outbox_batch_threshold,
        )
    }

    fn outbox_recovery_batch_limit(&self) -> Result<usize> {
        if self.config.push.outbox_batch_limit.is_some() {
            return self.outbox_push_batch_limit();
        }
        Ok(self
            .outbox_push_batch_limit()?
            .max(self.outbox_adaptive_batch_limit()?))
    }

    fn validate_outbox_batch_limit(&self, name: &str, limit: i64) -> Result<usize> {
        if !(1..=MAX_OUTBOX_PUSH_BATCH_LIMIT).contains(&limit) {
            return Err(SyncularError::config(format!(
                "{name} must be between 1 and {MAX_OUTBOX_PUSH_BATCH_LIMIT}; got {limit}"
            )));
        }
        usize::try_from(limit)
            .map_err(|_| SyncularError::config(format!("{name} cannot be represented: {limit}")))
    }

    fn build_push_request(&self, pending: &[OutboxCommit]) -> Result<Option<PushBatchRequest>> {
        if pending.is_empty() {
            return Ok(None);
        }
        let ctx = self.encryption_context();
        Ok(Some(PushBatchRequest {
            commits: pending
                .iter()
                .map(|commit| {
                    let operations: Vec<SyncOperation> =
                        serde_json::from_str(&commit.operations_json)?;
                    let operations = if let Some(encryption) = &self.field_encryption {
                        encryption.transform_operations_for_push(&ctx, operations)?
                    } else {
                        operations
                    };
                    Ok(PushCommitRequest {
                        client_commit_id: commit.client_commit_id.clone(),
                        operations,
                        schema_version: commit.schema_version,
                        auth_lease: commit.auth_lease.clone(),
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        }))
    }

    fn transform_push_response(
        &self,
        outbox: &OutboxCommit,
        response: crate::protocol::PushCommitResponse,
    ) -> Result<crate::protocol::PushCommitResponse> {
        let Some(encryption) = &self.field_encryption else {
            return Ok(response);
        };
        let operations: Vec<SyncOperation> = serde_json::from_str(&outbox.operations_json)?;
        encryption.transform_push_response(&self.encryption_context(), &operations, response)
    }

    fn transform_pull_response(
        &self,
        response: crate::protocol::PullResponse,
    ) -> Result<crate::protocol::PullResponse> {
        let response = if let Some(encryption) = &self.field_encryption {
            encryption.transform_pull_response(&self.encryption_context(), response)?
        } else {
            response
        };
        if let Some(encryption) = &self.encrypted_crdt {
            encryption.transform_pull_response(response)
        } else {
            Ok(response)
        }
    }

    fn transform_snapshot_row(&self, snapshot_table: &str, row: Value) -> Result<Value> {
        if let Some(encryption) = &self.field_encryption {
            encryption.transform_snapshot_row(&self.encryption_context(), snapshot_table, row)
        } else {
            Ok(row)
        }
    }

    fn encryption_context(&self) -> FieldEncryptionContext {
        FieldEncryptionContext {
            actor_id: self.config.actor_id.clone(),
            client_id: self.config.client_id.clone(),
        }
    }

    async fn schedule_outbox_retry(
        &mut self,
        pending: &[OutboxCommit],
        error: &SyncularError,
    ) -> Result<()> {
        self.schedule_outbox_retry_inner(pending, error, false)
            .await
    }

    async fn schedule_outbox_retry_inner(
        &mut self,
        pending: &[OutboxCommit],
        error: &SyncularError,
        attempt_already_recorded: bool,
    ) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }

        let now = now_ms();
        let message = error.to_string();
        let auth_error = is_auth_transport_error(error);
        for commit in pending {
            let attempt_count = if attempt_already_recorded {
                commit.attempt_count
            } else {
                commit.attempt_count.saturating_add(1)
            };
            let failed = attempt_count >= MAX_SYNC_RETRIES;
            let next_attempt_at = if failed || auth_error {
                0
            } else {
                next_retry_at(now, attempt_count)
            };
            self.store
                .mark_outbox_retry(&commit.id, &message, next_attempt_at, failed)
                .await?;
        }
        Ok(())
    }
}

fn add_store_apply_timings(timings: &mut WebSyncTimings, store: WebStoreApplyTimings) {
    timings.snapshot_chunk_reset_ms += store.snapshot_chunk_reset_ms;
    timings.snapshot_chunk_bind_ms += store.snapshot_chunk_bind_ms;
    timings.snapshot_chunk_step_ms += store.snapshot_chunk_step_ms;
}

impl<T, S> WebSyncularClient<T, S>
where
    T: AsyncSyncTransport + SyncAuthHeaderStore,
    S: AsyncWebStore,
{
    pub fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.transport.set_auth_headers(headers);
    }
}

fn normalize_bootstrap_phase(phase: i64) -> i64 {
    phase.max(0)
}

fn web_subscription_ready(state: Option<&WebSubscriptionState>) -> bool {
    state.is_some_and(|state| {
        web_subscription_ready_parts(&state.status, state.cursor, state.bootstrap_state.as_ref())
    })
}

fn web_subscription_bootstrapping(state: Option<&WebSubscriptionState>) -> bool {
    state.is_some_and(|state| state.status == "active" && state.bootstrap_state.is_some())
}

fn resolve_active_bootstrap_phase_for_web(
    entries: &[(SubscriptionSpec, Option<WebSubscriptionState>)],
) -> Option<i64> {
    entries
        .iter()
        .filter(|(_, state)| !web_subscription_ready(state.as_ref()))
        .map(|(spec, _)| normalize_bootstrap_phase(spec.bootstrap_phase))
        .min()
}

fn should_include_web_pull_subscription(
    spec: &SubscriptionSpec,
    state: Option<&WebSubscriptionState>,
    active_phase: Option<i64>,
) -> bool {
    let Some(active_phase) = active_phase else {
        return true;
    };
    let phase = normalize_bootstrap_phase(spec.bootstrap_phase);
    phase <= active_phase || web_subscription_ready(state) || web_subscription_bootstrapping(state)
}

fn web_subscription_ready_parts(
    status: &str,
    cursor: i64,
    bootstrap_state: Option<&BootstrapState>,
) -> bool {
    status == "active" && bootstrap_state.is_none() && cursor >= 0
}

fn web_subscription_phase(
    status: &str,
    cursor: i64,
    bootstrap_state: Option<&BootstrapState>,
) -> String {
    if status == "revoked" {
        "error".to_string()
    } else if bootstrap_state.is_some() {
        "bootstrapping".to_string()
    } else if status == "active" && cursor >= 0 {
        "live".to_string()
    } else {
        "pending".to_string()
    }
}

fn web_subscription_progress_percent(
    status: &str,
    cursor: i64,
    bootstrap_state: Option<&BootstrapState>,
) -> i64 {
    if web_subscription_ready_parts(status, cursor, bootstrap_state) {
        return 100;
    }
    let Some(state) = bootstrap_state else {
        return 0;
    };
    let total = state.tables.len() as i64;
    if total <= 0 {
        return 0;
    }
    let processed = state.table_index.clamp(0, total);
    ((processed * 100) / total).clamp(0, 100)
}

fn validate_server_schema_version(
    required_schema_version: Option<i32>,
    latest_schema_version: Option<i32>,
    current: i32,
) -> Result<()> {
    if let Some(required) = required_schema_version {
        if required < 1 {
            return Err(SyncularError::schema(format!(
                "server reported invalid required schema version {required}"
            )));
        }
        if required > current {
            return Err(SyncularError::schema(format!(
                "server requires schema version {required}, but this client supports {current}"
            )));
        }
    }

    if let Some(latest) = latest_schema_version {
        if latest < 1 {
            return Err(SyncularError::schema(format!(
                "server reported invalid latest schema version {latest}"
            )));
        }
    }

    Ok(())
}

fn add_changed_table(tables: &mut Vec<String>, table: &str) {
    if !tables.iter().any(|existing| existing == table) {
        tables.push(table.to_string());
    }
}

async fn apply_commits_without_changed_rows<S>(
    store: &mut S,
    result: &mut WebSyncResult,
    commits: Vec<SyncCommit>,
) -> Result<()>
where
    S: AsyncWebStore,
{
    let mut batch_table: Option<String> = None;
    let mut batch_rows: Vec<Value> = Vec::new();

    for commit in commits {
        for mut change in commit.changes {
            add_changed_table(&mut result.changed_tables, &change.table);
            if let Some((table, row)) = take_batchable_change_row(&mut change) {
                if batch_table.as_deref() != Some(table.as_str()) {
                    flush_change_row_batch(store, &mut batch_table, &mut batch_rows).await?;
                    batch_table = Some(table);
                }
                batch_rows.push(row);
                continue;
            }

            flush_change_row_batch(store, &mut batch_table, &mut batch_rows).await?;
            store.apply_change(change).await?;
        }
    }

    flush_change_row_batch(store, &mut batch_table, &mut batch_rows).await
}

async fn flush_change_row_batch<S>(
    store: &mut S,
    table: &mut Option<String>,
    rows: &mut Vec<Value>,
) -> Result<()>
where
    S: AsyncWebStore,
{
    let Some(table_name) = table.take() else {
        return Ok(());
    };
    let batch = std::mem::take(rows);
    if batch.is_empty() {
        return Ok(());
    }
    store.upsert_rows(&table_name, batch).await
}

fn take_batchable_change_row(change: &mut SyncChange) -> Option<(String, Value)> {
    if change.op != "upsert" || is_encrypted_crdt_system_table(&change.table) {
        return None;
    }

    let row_json = change.row_json.as_ref()?;
    if row_json
        .as_object()
        .is_some_and(|row| row.contains_key(YJS_PAYLOAD_KEY))
    {
        return None;
    }

    let row_json = change.row_json.take()?;
    match row_json {
        Value::Object(row) => Some((change.table.clone(), Value::Object(row))),
        other => {
            change.row_json = Some(other);
            None
        }
    }
}

fn push_snapshot_changed_row(
    result: &mut WebSyncResult,
    snapshot_changed_rows: &mut usize,
    max_snapshot_changed_rows: Option<usize>,
    row: SyncChangedRow,
) {
    if snapshot_changed_row_budget(*snapshot_changed_rows, max_snapshot_changed_rows) == 0 {
        result.changed_rows_truncated = true;
        return;
    }
    result.changed_rows.push(row);
    *snapshot_changed_rows = snapshot_changed_rows.saturating_add(1);
}

fn snapshot_changed_row_budget(
    snapshot_changed_rows: usize,
    max_snapshot_changed_rows: Option<usize>,
) -> usize {
    max_snapshot_changed_rows
        .map(|max| max.saturating_sub(snapshot_changed_rows))
        .unwrap_or(usize::MAX)
}

fn elapsed_ms_since(started_at: i64) -> f64 {
    timing_now_ms().saturating_sub(started_at) as f64
}

#[cfg(target_arch = "wasm32")]
fn timing_now_ms() -> i64 {
    js_sys::Date::now() as i64
}

#[cfg(not(target_arch = "wasm32"))]
fn timing_now_ms() -> i64 {
    now_ms()
}

async fn previous_web_snapshot_row<S>(
    store: &mut S,
    app_schema: AppSchema,
    table: &str,
    row: &Value,
) -> Result<Option<Value>>
where
    S: AsyncWebStore,
{
    let Some(metadata) = app_schema.table_metadata(table) else {
        return Ok(None);
    };
    let Some(row_id) = row
        .get(metadata.primary_key_column)
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(None);
    };
    store.current_row_json(table, &row_id).await
}

fn snapshot_clear_removes_all_rows(app_schema: AppSchema, table: &str) -> bool {
    app_schema.table_metadata(table).is_some_and(|metadata| {
        !metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
    })
}

fn validate_outbox_schema_version(commit: &OutboxCommit, current: i32) -> Result<()> {
    if commit.schema_version < 1 {
        return Err(SyncularError::schema(format!(
            "web outbox commit {} has invalid schema version {}",
            commit.client_commit_id, commit.schema_version
        )));
    }

    if commit.schema_version > current {
        return Err(SyncularError::schema(format!(
            "web outbox commit {} was created with schema version {}, but this client supports {}",
            commit.client_commit_id, commit.schema_version, current
        )));
    }

    Ok(())
}

fn is_auth_transport_error(error: &SyncularError) -> bool {
    if error.kind() != ErrorKind::Transport {
        return false;
    }
    let message = error.message_text();
    message.contains("HTTP 401") || message.contains("HTTP 403")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        snapshot_manifest_digest, wire_commit_chain_root, wire_commit_digest, CombinedResponse,
        OperationResult, PullResponse, PushBatchResponse, PushCommitResponse,
        ScopedSnapshotArtifactManifest, ScopedSnapshotArtifactRef, SnapshotChunkRef,
        SnapshotManifest, SnapshotManifestChunkRef, SubscriptionIntegrity, SubscriptionResponse,
        SyncSnapshot, COMMIT_INTEGRITY_GENESIS_ROOT, SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
        SNAPSHOT_CHUNK_COMPRESSION_GZIP,
    };
    use crate::store::AuthLeaseRecord;
    use serde_json::{json, Map, Value};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

    #[test]
    fn pull_rejects_snapshot_artifacts_before_mutating_store() -> Result<()> {
        let mut store = WebMemoryStore::new();
        block_on(store.upsert_row("tasks", task_row("existing-task", "p0")))?;
        let transport = ArtifactTransport;
        let config = test_config("web-client-artifact-failure");
        let mut client = WebSyncularClient::with_parts(config, transport, store);

        let error = block_on(client.sync_pull()).expect_err("artifact apply failure");
        assert_eq!(error.kind(), ErrorKind::Protocol);
        assert!(error
            .message_text()
            .contains("snapshot artifacts are not supported"));

        let rows: Value =
            serde_json::from_str(&block_on(client.store_mut().list_table_json("tasks"))?)?;
        let rows = rows.as_array().expect("task rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "existing-task");

        Ok(())
    }

    #[test]
    fn default_push_batch_stays_small_for_hundred_commit_queue() -> Result<()> {
        let batch_sizes = Arc::new(Mutex::new(Vec::new()));
        let transport = PushCaptureTransport {
            batch_sizes: Arc::clone(&batch_sizes),
        };
        let config = test_config("web-client-default-small-outbox");
        let mut client = WebSyncularClient::with_parts(config, transport, WebMemoryStore::new());
        enqueue_task_mutations(&mut client, 100)?;

        let result = block_on(client.sync_push())?;

        assert_eq!(
            result.pushed_commits,
            DEFAULT_OUTBOX_PUSH_BATCH_LIMIT as usize
        );
        assert_eq!(
            *batch_sizes.lock().expect("captured push batches"),
            vec![DEFAULT_OUTBOX_PUSH_BATCH_LIMIT as usize]
        );
        Ok(())
    }

    #[test]
    fn default_push_batch_adapts_for_large_commit_queue() -> Result<()> {
        let batch_sizes = Arc::new(Mutex::new(Vec::new()));
        let transport = PushCaptureTransport {
            batch_sizes: Arc::clone(&batch_sizes),
        };
        let config = test_config("web-client-default-large-outbox");
        let mut client = WebSyncularClient::with_parts(config, transport, WebMemoryStore::new());
        enqueue_task_mutations(&mut client, 101)?;

        let result = block_on(client.sync_push())?;

        assert_eq!(
            result.pushed_commits,
            DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT as usize
        );
        assert_eq!(
            *batch_sizes.lock().expect("captured push batches"),
            vec![DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT as usize]
        );
        Ok(())
    }

    #[test]
    fn configured_push_batch_limit_disables_adaptive_default() -> Result<()> {
        let batch_sizes = Arc::new(Mutex::new(Vec::new()));
        let transport = PushCaptureTransport {
            batch_sizes: Arc::clone(&batch_sizes),
        };
        let mut config = test_config("web-client-configured-outbox");
        config.push.outbox_batch_limit = Some(25);
        let mut client = WebSyncularClient::with_parts(config, transport, WebMemoryStore::new());
        enqueue_task_mutations(&mut client, 101)?;

        let result = block_on(client.sync_push())?;

        assert_eq!(result.pushed_commits, 25);
        assert_eq!(
            *batch_sizes.lock().expect("captured push batches"),
            vec![25]
        );
        Ok(())
    }

    #[test]
    fn pull_fetches_snapshot_chunks_before_mutating_store() -> Result<()> {
        let mut store = WebMemoryStore::new();
        block_on(store.upsert_row("tasks", task_row("existing-task", "p0")))?;
        let transport = FailingChunkTransport;
        let config = test_config("web-client-chunk-failure");
        let mut client = WebSyncularClient::with_parts(config, transport, store);

        let error = block_on(client.sync_pull()).expect_err("chunk fetch failure");
        assert_eq!(error.kind(), ErrorKind::Transport);

        let rows: Value =
            serde_json::from_str(&block_on(client.store_mut().list_table_json("tasks"))?)?;
        let rows = rows.as_array().expect("task rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "existing-task");

        Ok(())
    }

    #[test]
    fn leased_mutation_json_tags_web_memory_outbox() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let schema_version = store.app_schema().current_schema_version();
        let now = now_ms();
        block_on(
            store.upsert_auth_lease(AuthLeaseRecord {
                lease_id: "lease-web-active".to_string(),
                kid: "test-kid".to_string(),
                actor_id: "user-rust".to_string(),
                issued_at_ms: now - 1_000,
                not_before_ms: now - 1_000,
                expires_at_ms: now + 60_000,
                schema_version,
                payload_json: json!({
                    "version": 1,
                    "leaseId": "lease-web-active",
                    "issuer": "syncular-test",
                    "audience": "syncular-client",
                    "actorId": "user-rust",
                    "schemaVersion": schema_version,
                    "protocolVersion": 1,
                    "issuedAtMs": now - 1_000,
                    "notBeforeMs": now - 1_000,
                    "expiresAtMs": now + 60_000,
                    "maxClockSkewMs": 0,
                    "scopes": [{
                        "subscriptionId": "sub-tasks",
                        "table": "tasks",
                        "values": {},
                        "operations": ["upsert", "delete"]
                    }],
                    "capabilities": {
                        "allowBlobs": true,
                        "allowCrdt": true,
                        "allowEncryptedFields": true
                    }
                })
                .to_string(),
                token: "lease-token".to_string(),
                status: "active".to_string(),
                last_validation_error: None,
                created_at_ms: now,
                updated_at_ms: now,
            }),
        )?;
        let transport = PhaseCaptureTransport {
            requested: Arc::new(Mutex::new(Vec::new())),
        };
        let mut client =
            WebSyncularClient::with_parts(test_config("web-client-lease"), transport, store);

        let operation = json!({
            "table": "tasks",
            "row_id": "task-web-lease",
            "op": "upsert",
            "payload": { "title": "leased web task" },
            "base_version": null
        })
        .to_string();
        let local_row = json!({
            "id": "task-web-lease",
            "title": "leased web task",
            "server_version": 0
        })
        .to_string();
        let commit_id = block_on(client.apply_leased_mutation_json(&operation, Some(&local_row)))?;
        let outbox = block_on(client.store_mut().outbox_summaries())?;

        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0].client_commit_id, commit_id);
        assert_eq!(
            outbox[0]
                .auth_lease
                .as_ref()
                .map(|lease| lease.lease_id.as_str()),
            Some("lease-web-active")
        );

        Ok(())
    }

    #[test]
    fn pull_advances_bootstrap_phases_and_reports_readiness() -> Result<()> {
        let requested = Arc::new(Mutex::new(Vec::new()));
        let transport = PhaseCaptureTransport {
            requested: requested.clone(),
        };
        let mut client = WebSyncularClient::with_parts(
            test_config("web-client-bootstrap-phases"),
            transport,
            WebMemoryStore::new(),
        );
        client.set_subscriptions(vec![
            SubscriptionSpec {
                id: "sub-critical".to_string(),
                table: "tasks".to_string(),
                scopes: scopes(),
                params: Map::new(),
                bootstrap_phase: 0,
            },
            SubscriptionSpec {
                id: "sub-interactive".to_string(),
                table: "comments".to_string(),
                scopes: scopes(),
                params: Map::new(),
                bootstrap_phase: 1,
            },
        ])?;

        let first = block_on(client.sync_pull())?;
        assert_eq!(
            requested.lock().expect("requests").first().cloned(),
            Some(vec!["sub-critical".to_string()])
        );
        assert_eq!(
            first.subscriptions.first().map(|subscription| (
                subscription.id.as_str(),
                subscription.ready,
                subscription.phase.as_str(),
                subscription.progress_percent
            )),
            Some(("sub-critical", true, "live", 100))
        );

        let second = block_on(client.sync_pull())?;
        assert_eq!(
            requested.lock().expect("requests").get(1).cloned(),
            Some(vec![
                "sub-critical".to_string(),
                "sub-interactive".to_string()
            ])
        );
        assert!(second
            .subscriptions
            .iter()
            .all(|subscription| subscription.ready));

        Ok(())
    }

    #[test]
    fn realtime_sync_pack_verifies_and_persists_subscription_root() -> Result<()> {
        let mut store = WebMemoryStore::new();
        block_on(store.upsert_subscription_state(WebSubscriptionState {
            subscription_id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            scopes: scopes(),
            cursor: 0,
            bootstrap_state: None,
            status: "active".to_string(),
        }))?;
        let config = test_config("web-client-realtime-integrity");
        let mut client = WebSyncularClient::with_parts(config, NoopTransport, store);
        client.set_subscriptions(vec![SubscriptionSpec {
            id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            scopes: scopes(),
            params: Map::new(),
            bootstrap_phase: 0,
        }])?;

        let commit = SyncCommit {
            commit_seq: 1,
            created_at: "2026-05-19T00:00:00.000Z".to_string(),
            actor_id: "server".to_string(),
            changes: vec![SyncChange {
                table: "tasks".to_string(),
                row_id: "task-1".to_string(),
                op: "upsert".to_string(),
                row_json: Some(task_row("task-1", "p0")),
                row_version: Some(1),
                scopes: scopes(),
            }],
        };
        let digest = wire_commit_digest("default", "sub-tasks", &commit)?;
        let root = wire_commit_chain_root(
            "default",
            "sub-tasks",
            COMMIT_INTEGRITY_GENESIS_ROOT,
            commit.commit_seq,
            &digest,
        )?;

        let result = block_on(client.apply_realtime_combined_response(
            CombinedResponse {
                ok: true,
                required_schema_version: None,
                latest_schema_version: None,
                push: None,
                pull: Some(PullResponse {
                    ok: true,
                    subscriptions: vec![SubscriptionResponse {
                        id: "sub-tasks".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: false,
                        bootstrap_state: None,
                        next_cursor: 1,
                        integrity: Some(SubscriptionIntegrity {
                            partition_id: "default".to_string(),
                            previous_chain_root: COMMIT_INTEGRITY_GENESIS_ROOT.to_string(),
                            commit_chain_root: root.clone(),
                            commit_seq: 1,
                        }),
                        commits: vec![commit],
                        snapshots: None,
                    }],
                }),
            },
            0,
        ))?;

        assert_eq!(result.changed_tables, vec!["tasks".to_string()]);
        assert_eq!(
            result
                .changed_rows
                .first()
                .and_then(|row| row.subscription_id.as_deref()),
            Some("sub-tasks")
        );
        assert_eq!(
            result.subscriptions.first().map(|sub| sub.commits.len()),
            Some(0)
        );
        let verified =
            block_on(client.store_mut().verified_root("sub-tasks"))?.expect("verified root");
        assert_eq!(verified.root, root);
        assert_eq!(verified.commit_seq, 1);

        let rows: Value =
            serde_json::from_str(&block_on(client.store_mut().list_table_json("tasks"))?)?;
        assert_eq!(rows.as_array().expect("task rows").len(), 1);

        Ok(())
    }

    #[test]
    fn realtime_sync_pack_rejects_root_mismatch_before_mutating_store() -> Result<()> {
        let mut store = WebMemoryStore::new();
        block_on(store.upsert_subscription_state(WebSubscriptionState {
            subscription_id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            scopes: scopes(),
            cursor: 0,
            bootstrap_state: None,
            status: "active".to_string(),
        }))?;
        let config = test_config("web-client-realtime-root-mismatch");
        let mut client = WebSyncularClient::with_parts(config, NoopTransport, store);

        let error = block_on(client.apply_realtime_combined_response(
            CombinedResponse {
                ok: true,
                required_schema_version: None,
                latest_schema_version: None,
                push: None,
                pull: Some(PullResponse {
                    ok: true,
                    subscriptions: vec![SubscriptionResponse {
                        id: "sub-tasks".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: false,
                        bootstrap_state: None,
                        next_cursor: 1,
                        integrity: Some(SubscriptionIntegrity {
                            partition_id: "default".to_string(),
                            previous_chain_root: "1".repeat(64),
                            commit_chain_root: "2".repeat(64),
                            commit_seq: 1,
                        }),
                        commits: vec![SyncCommit {
                            commit_seq: 1,
                            created_at: "2026-05-19T00:00:00.000Z".to_string(),
                            actor_id: "server".to_string(),
                            changes: vec![SyncChange {
                                table: "tasks".to_string(),
                                row_id: "task-1".to_string(),
                                op: "upsert".to_string(),
                                row_json: Some(task_row("task-1", "p0")),
                                row_version: Some(1),
                                scopes: scopes(),
                            }],
                        }],
                        snapshots: None,
                    }],
                }),
            },
            0,
        ))
        .expect_err("root mismatch");

        assert_eq!(error.kind(), ErrorKind::Protocol);
        assert!(error.message_text().contains("previousChainRoot mismatch"));
        let rows: Value =
            serde_json::from_str(&block_on(client.store_mut().list_table_json("tasks"))?)?;
        assert_eq!(rows.as_array().expect("task rows").len(), 0);

        Ok(())
    }

    struct NoopTransport;

    impl AsyncSyncTransport for NoopTransport {
        fn post_sync<'a>(
            &'a self,
            _request: &'a CombinedRequest,
        ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
            Box::pin(async move {
                Err(SyncularError::message(
                    ErrorKind::Transport,
                    "noop transport does not post sync",
                ))
            })
        }

        fn fetch_snapshot_chunk_rows<'a>(
            &'a self,
            _chunk: &'a SnapshotChunkRef,
            _scopes: &'a ScopeValues,
        ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>> {
            Box::pin(async move {
                Err(SyncularError::message(
                    ErrorKind::Transport,
                    "noop transport does not fetch chunks",
                ))
            })
        }
    }

    struct PushCaptureTransport {
        batch_sizes: Arc<Mutex<Vec<usize>>>,
    }

    impl AsyncSyncTransport for PushCaptureTransport {
        fn post_sync<'a>(
            &'a self,
            request: &'a CombinedRequest,
        ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
            Box::pin(async move {
                let commits = request
                    .push
                    .as_ref()
                    .map(|push| push.commits.clone())
                    .unwrap_or_default();
                self.batch_sizes
                    .lock()
                    .expect("captured push batches")
                    .push(commits.len());
                Ok(CombinedResponse {
                    ok: true,
                    required_schema_version: None,
                    latest_schema_version: None,
                    push: Some(PushBatchResponse {
                        ok: true,
                        commits: commits
                            .into_iter()
                            .enumerate()
                            .map(|(index, commit)| PushCommitResponse {
                                client_commit_id: commit.client_commit_id,
                                status: "applied".to_string(),
                                commit_seq: Some((index + 1) as i64),
                                results: commit
                                    .operations
                                    .into_iter()
                                    .enumerate()
                                    .map(|(op_index, _operation)| OperationResult {
                                        op_index: op_index as i32,
                                        status: "applied".to_string(),
                                        message: None,
                                        error: None,
                                        code: None,
                                        retriable: None,
                                        server_version: Some(2),
                                        server_row: None,
                                    })
                                    .collect(),
                            })
                            .collect(),
                    }),
                    pull: None,
                })
            })
        }

        fn fetch_snapshot_chunk_rows<'a>(
            &'a self,
            _chunk: &'a SnapshotChunkRef,
            _scopes: &'a ScopeValues,
        ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>> {
            Box::pin(async move {
                Err(SyncularError::message(
                    ErrorKind::Transport,
                    "push capture transport does not fetch chunks",
                ))
            })
        }
    }

    struct ArtifactTransport;

    impl AsyncSyncTransport for ArtifactTransport {
        fn post_sync<'a>(
            &'a self,
            _request: &'a CombinedRequest,
        ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
            Box::pin(async move {
                Ok(CombinedResponse {
                    ok: true,
                    required_schema_version: None,
                    latest_schema_version: None,
                    push: None,
                    pull: Some(PullResponse {
                        ok: true,
                        subscriptions: vec![SubscriptionResponse {
                            id: "sub-tasks".to_string(),
                            status: "active".to_string(),
                            scopes: scopes(),
                            bootstrap: true,
                            bootstrap_state: None,
                            next_cursor: 1,
                            integrity: None,
                            commits: Vec::new(),
                            snapshots: Some(vec![SyncSnapshot {
                                table: "tasks".to_string(),
                                rows: Vec::new(),
                                chunks: None,
                                artifacts: Some(vec![snapshot_artifact_for_test()]),
                                manifest: None,
                                is_first_page: true,
                                is_last_page: true,
                                bootstrap_state_after: None,
                            }]),
                        }],
                    }),
                })
            })
        }

        fn fetch_snapshot_chunk_rows<'a>(
            &'a self,
            _chunk: &'a SnapshotChunkRef,
            _scopes: &'a ScopeValues,
        ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>> {
            Box::pin(async move {
                Err(SyncularError::message(
                    ErrorKind::Transport,
                    "chunk fetch should not run",
                ))
            })
        }
    }

    struct FailingChunkTransport;

    impl AsyncSyncTransport for FailingChunkTransport {
        fn post_sync<'a>(
            &'a self,
            _request: &'a CombinedRequest,
        ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
            Box::pin(async move {
                let chunk = SnapshotChunkRef {
                    id: "missing-chunk".to_string(),
                    byte_length: 1,
                    sha256: "0".repeat(64),
                    encoding: "binary-table-v1".to_string(),
                    compression: "gzip".to_string(),
                };
                let manifest = snapshot_manifest_for_test(&chunk)?;
                Ok(CombinedResponse {
                    ok: true,
                    required_schema_version: None,
                    latest_schema_version: None,
                    push: None,
                    pull: Some(PullResponse {
                        ok: true,
                        subscriptions: vec![SubscriptionResponse {
                            id: "sub-tasks".to_string(),
                            status: "active".to_string(),
                            scopes: scopes(),
                            bootstrap: true,
                            bootstrap_state: None,
                            next_cursor: 1,
                            integrity: None,
                            commits: Vec::new(),
                            snapshots: Some(vec![SyncSnapshot {
                                table: "tasks".to_string(),
                                rows: vec![task_row("incoming-inline-task", "p0")],
                                chunks: Some(vec![chunk]),
                                artifacts: None,
                                manifest: Some(manifest),
                                is_first_page: true,
                                is_last_page: true,
                                bootstrap_state_after: None,
                            }]),
                        }],
                    }),
                })
            })
        }

        fn fetch_snapshot_chunk_rows<'a>(
            &'a self,
            _chunk: &'a SnapshotChunkRef,
            _scopes: &'a ScopeValues,
        ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>> {
            Box::pin(async move {
                Err(SyncularError::message(
                    ErrorKind::Transport,
                    "chunk fetch failed",
                ))
            })
        }
    }

    struct PhaseCaptureTransport {
        requested: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl AsyncSyncTransport for PhaseCaptureTransport {
        fn post_sync<'a>(
            &'a self,
            request: &'a CombinedRequest,
        ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
            Box::pin(async move {
                let requested = request
                    .pull
                    .as_ref()
                    .map(|pull| {
                        pull.subscriptions
                            .iter()
                            .map(|subscription| subscription.id.clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                self.requested
                    .lock()
                    .expect("requested subscription capture")
                    .push(requested.clone());
                Ok(CombinedResponse {
                    ok: true,
                    required_schema_version: None,
                    latest_schema_version: None,
                    push: None,
                    pull: Some(PullResponse {
                        ok: true,
                        subscriptions: requested
                            .into_iter()
                            .map(|id| SubscriptionResponse {
                                id,
                                status: "active".to_string(),
                                scopes: scopes(),
                                bootstrap: false,
                                bootstrap_state: None,
                                next_cursor: 1,
                                integrity: None,
                                commits: Vec::new(),
                                snapshots: None,
                            })
                            .collect(),
                    }),
                })
            })
        }

        fn fetch_snapshot_chunk_rows<'a>(
            &'a self,
            _chunk: &'a SnapshotChunkRef,
            _scopes: &'a ScopeValues,
        ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>> {
            Box::pin(async move {
                Err(SyncularError::message(
                    ErrorKind::Transport,
                    "phase transport does not fetch chunks",
                ))
            })
        }
    }

    fn test_config(client_id: &str) -> WebSyncularClientConfig {
        WebSyncularClientConfig {
            base_url: "http://syncular.test/sync".to_string(),
            client_id: client_id.to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("p0".to_string()),
            pull: WebSyncPullOptions::default(),
            push: WebSyncPushOptions::default(),
        }
    }

    fn task_row(id: &str, project_id: &str) -> Value {
        json!({
            "id": id,
            "title": id,
            "completed": 0,
            "user_id": "user-rust",
            "project_id": project_id,
            "server_version": 1,
            "image": null,
            "title_yjs_state": null
        })
    }

    fn enqueue_task_mutations<T>(
        client: &mut WebSyncularClient<T, WebMemoryStore>,
        count: usize,
    ) -> Result<()>
    where
        T: AsyncSyncTransport,
    {
        for index in 0..count {
            let id = format!("task-{index}");
            let operation = SyncOperation {
                table: "tasks".to_string(),
                row_id: id.clone(),
                op: "upsert".to_string(),
                payload: Some(json!({ "title": id })),
                base_version: Some(1),
            };
            let operation_json = serde_json::to_string(&operation)?;
            let local_row_json = serde_json::to_string(&task_row(&id, "p0"))?;
            block_on(client.apply_mutation_json(&operation_json, Some(&local_row_json)))?;
        }
        Ok(())
    }

    fn snapshot_artifact_for_test() -> ScopedSnapshotArtifactRef {
        let manifest = ScopedSnapshotArtifactManifest {
            version: 1,
            artifact_kind: SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1.to_string(),
            digest: "artifact-digest".to_string(),
            partition_id: "default".to_string(),
            subscription_id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            schema_version: "7".to_string(),
            as_of_commit_seq: 1,
            scope_digest: "0".repeat(64),
            row_cursor: None,
            row_limit: 50_000,
            row_count: 1,
            next_row_cursor: None,
            is_first_page: true,
            is_last_page: true,
            compression: SNAPSHOT_CHUNK_COMPRESSION_GZIP.to_string(),
            byte_length: 64,
            sha256: "a".repeat(64),
            feature_set: Vec::new(),
        };
        ScopedSnapshotArtifactRef {
            id: "artifact-1".to_string(),
            byte_length: manifest.byte_length,
            sha256: manifest.sha256.clone(),
            manifest_digest: manifest.digest.clone(),
            artifact_kind: manifest.artifact_kind.clone(),
            compression: manifest.compression.clone(),
            row_count: manifest.row_count,
            next_row_cursor: manifest.next_row_cursor.clone(),
            is_first_page: manifest.is_first_page,
            is_last_page: manifest.is_last_page,
            manifest,
        }
    }

    fn snapshot_manifest_for_test(chunk: &SnapshotChunkRef) -> Result<SnapshotManifest> {
        let mut manifest = SnapshotManifest {
            version: 1,
            digest: String::new(),
            table: "tasks".to_string(),
            as_of_commit_seq: 1,
            scope_digest: "0".repeat(64),
            row_cursor: None,
            row_limit: 1000,
            next_row_cursor: None,
            is_first_page: true,
            is_last_page: true,
            chunks: vec![SnapshotManifestChunkRef {
                id: chunk.id.clone(),
                byte_length: chunk.byte_length,
                sha256: chunk.sha256.clone(),
                encoding: chunk.encoding.clone(),
                compression: chunk.compression.clone(),
            }],
        };
        manifest.digest = snapshot_manifest_digest(&manifest)?;
        Ok(manifest)
    }

    fn scopes() -> ScopeValues {
        let mut scopes = Map::new();
        scopes.insert("user_id".to_string(), json!("user-rust"));
        scopes.insert("project_id".to_string(), json!("p0"));
        scopes
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);
        loop {
            match Future::poll(future.as_mut(), &mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn noop_waker() -> Waker {
        unsafe fn clone(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        unsafe fn wake(_: *const ()) {}
        unsafe fn wake_by_ref(_: *const ()) {}
        unsafe fn drop(_: *const ()) {}
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_by_ref, drop);
        unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
    }
}
