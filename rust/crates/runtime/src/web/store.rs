use crate::app_schema::{default_app_schema, AppSchema, AppTableMetadata};
use crate::auth_lease_selection::{
    app_table_operation_scope, select_active_auth_lease_for_operations,
    system_table_operation_scope, ActiveAuthLeasePolicy, MutationOperationScope,
};
use crate::binary_snapshot::SnapshotChunkRows;
use crate::client::{SubscriptionSpec, SyncChangedRow};
use crate::error::{Result, SyncularError};
use crate::limits::validate_unresolved_outbox_capacity;
use crate::protocol::{
    sync_operations_json_for_outbox, AuthLeaseProvenance, BootstrapState, CrdtStateVectorHint,
    OperationResult, PushCommitResponse, ScopeValues, SyncChange, SyncOperation,
};
use crate::runtime_schema::runtime_schema_version;
use crate::store::{
    now_ms, AppSchemaState, AuthLeaseRecord, BlobHealthSummary, ConflictSummary, CrdtHealthSummary,
    OutboxCommit, OutboxSummary, ScopedRowsHealthSummary, ScopedRowsTableHealth, SubscriptionState,
    VerifiedRoot, APP_SCHEMA_ID, MAX_SYNC_RETRIES, SYNC_SENDING_TIMEOUT_MS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct WebStoreApplyTimings {
    pub snapshot_chunk_reset_ms: f64,
    pub snapshot_chunk_bind_ms: f64,
    pub snapshot_chunk_step_ms: f64,
}

impl WebStoreApplyTimings {
    pub fn add(&mut self, other: WebStoreApplyTimings) {
        self.snapshot_chunk_reset_ms += other.snapshot_chunk_reset_ms;
        self.snapshot_chunk_bind_ms += other.snapshot_chunk_bind_ms;
        self.snapshot_chunk_step_ms += other.snapshot_chunk_step_ms;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebSnapshotArtifactApplyMode {
    Insert,
    Upsert,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSubscriptionState {
    pub subscription_id: String,
    pub table: String,
    pub scopes: ScopeValues,
    pub cursor: i64,
    pub bootstrap_state: Option<BootstrapState>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebVerifiedRoot {
    pub subscription_id: String,
    pub partition_id: String,
    pub commit_seq: i64,
    pub root: String,
}

pub trait AsyncWebStore {
    fn app_schema(&self) -> AppSchema {
        default_app_schema()
    }

    fn local_state_id(&self) -> String {
        "default".to_string()
    }

    fn apply_mutation<'a>(
        &'a mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>>;

    fn apply_mutation_with_active_auth_lease<'a>(
        &'a mut self,
        _actor_id: Option<&'a str>,
        _now_ms: i64,
        _operation: SyncOperation,
        _local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "strict auth-leased mutations are not supported by this store"
            )))
        })
    }

    fn pending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>>;

    fn pending_outbox_count<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<usize>> + 'a>>;

    fn sending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>>;

    fn requeue_stale_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn mark_outbox_sending<'a>(
        &'a mut self,
        row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn mark_pushed_operation_server_versions<'a>(
        &'a mut self,
        _outbox: OutboxCommit,
        _response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn mark_outbox_acked<'a>(
        &'a mut self,
        row_id: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn mark_outbox_failed<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn mark_outbox_retry<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn insert_conflict<'a>(
        &'a mut self,
        outbox: OutboxCommit,
        result: OperationResult,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn upsert_auth_lease<'a>(
        &'a mut self,
        _lease: AuthLeaseRecord,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "auth lease storage is not supported by this store"
            )))
        })
    }

    fn auth_lease<'a>(
        &'a mut self,
        _lease_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<AuthLeaseRecord>>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "auth lease storage is not supported by this store"
            )))
        })
    }

    fn active_auth_leases<'a>(
        &'a mut self,
        _actor_id: Option<&'a str>,
        _now_ms: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AuthLeaseRecord>>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "auth lease storage is not supported by this store"
            )))
        })
    }

    fn set_outbox_auth_lease<'a>(
        &'a mut self,
        _client_commit_id: &'a str,
        _provenance: Option<AuthLeaseProvenance>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "outbox auth lease provenance is not supported by this store"
            )))
        })
    }

    fn conflict_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ConflictSummary>>> + 'a>>;

    fn resolve_conflict<'a>(
        &'a mut self,
        id: &'a str,
        resolution: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn retry_conflict_keep_local<'a>(
        &'a mut self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>>;

    fn subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebSubscriptionState>>> + 'a>>;

    fn upsert_subscription_state<'a>(
        &'a mut self,
        state: WebSubscriptionState,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn delete_subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn subscription_states<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SubscriptionState>>> + 'a>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn verified_root<'a>(
        &'a mut self,
        _subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebVerifiedRoot>>> + 'a>> {
        Box::pin(async { Ok(None) })
    }

    fn upsert_verified_root<'a>(
        &'a mut self,
        _root: WebVerifiedRoot,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn delete_verified_root<'a>(
        &'a mut self,
        _subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn verified_roots<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<VerifiedRoot>>> + 'a>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn app_schema_state<'a>(
        &'a mut self,
        current_schema_version: i32,
    ) -> Pin<Box<dyn Future<Output = Result<AppSchemaState>> + 'a>> {
        Box::pin(async move {
            Ok(AppSchemaState {
                schema_id: APP_SCHEMA_ID.to_string(),
                schema_version: Some(current_schema_version),
                current_schema_version,
                updated_at: Some(now_ms()),
            })
        })
    }

    fn outbox_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxSummary>>> + 'a>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn blob_health_summary<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<BlobHealthSummary>>> + 'a>> {
        Box::pin(async { Ok(None) })
    }

    fn crdt_health_summary<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CrdtHealthSummary>>> + 'a>> {
        Box::pin(async { Ok(None) })
    }

    fn scoped_rows_health_summary<'a>(
        &'a mut self,
        _subscriptions: &'a [SubscriptionSpec],
    ) -> Pin<Box<dyn Future<Output = Result<Option<ScopedRowsHealthSummary>>> + 'a>> {
        Box::pin(async { Ok(None) })
    }

    fn clear_orphaned_synced_rows<'a>(
        &'a mut self,
        _subscriptions: &'a [SubscriptionSpec],
        _tables: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Result<ScopedRowsHealthSummary>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "clearing orphaned synced rows is not supported by this store"
            )))
        })
    }

    fn crdt_state_vector_hints<'a>(
        &'a mut self,
        _table: &'a str,
        _scopes: &'a ScopeValues,
        _limit: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<CrdtStateVectorHint>>> + 'a>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn begin_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn commit_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn checkpoint_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn rollback_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn drain_apply_timings(&mut self) -> WebStoreApplyTimings {
        WebStoreApplyTimings::default()
    }

    fn supports_sqlite_snapshot_artifacts(&self) -> bool {
        false
    }

    fn apply_sqlite_snapshot_artifact_rows<'a>(
        &'a mut self,
        _table: &'a str,
        _artifact_bytes: Vec<u8>,
        _mode: WebSnapshotArtifactApplyMode,
    ) -> Pin<Box<dyn Future<Output = Result<usize>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::protocol_message(
                "direct snapshot artifact apply is not supported by this store",
            ))
        })
    }

    fn clear_table_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn clear_table_for_scopes_except<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
        retained_scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        let _ = retained_scopes;
        self.clear_table_for_scopes(table, scopes)
    }

    fn clear_synced_rows_for_scopes<'a>(
        &'a mut self,
        _table: &'a str,
        _scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<i64>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::storage(anyhow::anyhow!(
                "clearing synced rows is not supported by this store"
            )))
        })
    }

    fn clear_table_for_scopes_preserving_local_crdt<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        self.clear_table_for_scopes(table, scopes)
    }

    fn current_row_json<'a>(
        &'a mut self,
        _table: &'a str,
        _row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + 'a>> {
        Box::pin(async { Ok(None) })
    }

    fn upsert_row<'a>(
        &'a mut self,
        table: &'a str,
        row: Value,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn upsert_rows<'a>(
        &'a mut self,
        table: &'a str,
        rows: Vec<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            for row in rows {
                self.upsert_row(table, row).await?;
            }
            Ok(())
        })
    }

    fn upsert_snapshot_chunk_rows<'a>(
        &'a mut self,
        table: &'a str,
        rows: SnapshotChunkRows,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move { self.upsert_rows(table, rows.try_into_value_rows()?).await })
    }

    fn insert_cleared_snapshot_chunk_rows<'a>(
        &'a mut self,
        table: &'a str,
        rows: SnapshotChunkRows,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        self.upsert_snapshot_chunk_rows(table, rows)
    }

    fn apply_change<'a>(
        &'a mut self,
        change: SyncChange,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn list_table_json<'a>(
        &'a mut self,
        table: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>>;

    fn notify_tables_changed<'a>(
        &'a mut self,
        _tables: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn notify_tables_changed_with_rows<'a>(
        &'a mut self,
        tables: &'a [String],
        _changed_rows: &'a [SyncChangedRow],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        self.notify_tables_changed(tables)
    }

    fn notify_tables_changed_with_rows_meta<'a>(
        &'a mut self,
        tables: &'a [String],
        changed_rows: &'a [SyncChangedRow],
        _changed_rows_truncated: bool,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        self.notify_tables_changed_with_rows(tables, changed_rows)
    }

    fn notify_local_tables_changed_with_rows<'a>(
        &'a mut self,
        tables: &'a [String],
        changed_rows: &'a [SyncChangedRow],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        self.notify_tables_changed_with_rows(tables, changed_rows)
    }
}

#[derive(Debug, Default)]
pub struct WebMemoryStore {
    states: HashMap<String, WebSubscriptionState>,
    verified_roots: HashMap<String, WebVerifiedRoot>,
    rows: HashMap<String, HashMap<String, Value>>,
    outbox: Vec<OutboxCommit>,
    conflicts: Vec<WebConflictRecord>,
    auth_leases: HashMap<String, AuthLeaseRecord>,
}

#[derive(Debug, Clone)]
struct WebConflictRecord {
    id: String,
    outbox_commit_id: String,
    client_commit_id: String,
    op_index: i32,
    result_status: String,
    message: String,
    code: Option<String>,
    server_version: Option<i64>,
    created_at: i64,
    resolved_at: Option<i64>,
    resolution: Option<String>,
}

impl WebMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn row_count(&self, table: &str) -> usize {
        self.rows.get(table).map(HashMap::len).unwrap_or_default()
    }

    pub fn outbox_count(&self) -> usize {
        self.outbox.len()
    }

    pub fn conflict_count(&self) -> usize {
        self.conflicts.len()
    }
}

impl AsyncWebStore for WebMemoryStore {
    fn app_schema(&self) -> AppSchema {
        #[cfg(all(test, feature = "demo-todo-fixture"))]
        {
            crate::fixtures::todo::app_schema()
        }
        #[cfg(not(all(test, feature = "demo-todo-fixture")))]
        {
            default_app_schema()
        }
    }

    fn subscription_states<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SubscriptionState>>> + 'a>> {
        Box::pin(async move {
            self.states
                .values()
                .map(|state| {
                    Ok(SubscriptionState {
                        state_id: "default".to_string(),
                        subscription_id: state.subscription_id.clone(),
                        table: state.table.clone(),
                        scopes_json: serde_json::to_string(&state.scopes)?,
                        params_json: "{}".to_string(),
                        cursor: state.cursor,
                        bootstrap_state_json: state
                            .bootstrap_state
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                        status: state.status.clone(),
                    })
                })
                .collect()
        })
    }

    fn verified_roots<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<VerifiedRoot>>> + 'a>> {
        Box::pin(async move {
            Ok(self
                .verified_roots
                .values()
                .map(|root| VerifiedRoot {
                    state_id: "default".to_string(),
                    subscription_id: root.subscription_id.clone(),
                    partition_id: root.partition_id.clone(),
                    commit_seq: root.commit_seq,
                    root: root.root.clone(),
                })
                .collect())
        })
    }

    fn scoped_rows_health_summary<'a>(
        &'a mut self,
        subscriptions: &'a [SubscriptionSpec],
    ) -> Pin<Box<dyn Future<Output = Result<Option<ScopedRowsHealthSummary>>> + 'a>> {
        Box::pin(async move {
            let app_schema = self.app_schema();
            let mut summary = ScopedRowsHealthSummary::default();
            for metadata in app_schema.app_table_metadata {
                let rows = self.rows.get(metadata.name);
                let checked_synced_rows = rows
                    .map(|rows| {
                        rows.values()
                            .filter(|row| row_is_server_synced(row, metadata.server_version_column))
                            .count() as i64
                    })
                    .unwrap_or_default();
                let table_subscriptions = subscriptions
                    .iter()
                    .filter(|subscription| subscription.table == metadata.name)
                    .collect::<Vec<_>>();
                let orphaned_synced_rows = rows
                    .map(|rows| {
                        rows.values()
                            .filter(|row| row_is_server_synced(row, metadata.server_version_column))
                            .filter(|row| {
                                table_subscriptions.is_empty()
                                    || !table_subscriptions.iter().any(|subscription| {
                                        row_matches_scope_values(
                                            row,
                                            metadata,
                                            &subscription.scopes,
                                        )
                                    })
                            })
                            .count() as i64
                    })
                    .unwrap_or_default();
                summary.checked_synced_rows += checked_synced_rows;
                summary.orphaned_synced_rows += orphaned_synced_rows;
                summary.tables.push(ScopedRowsTableHealth {
                    table: metadata.name.to_string(),
                    checked_synced_rows,
                    orphaned_synced_rows,
                });
            }
            Ok(Some(summary))
        })
    }

    fn clear_orphaned_synced_rows<'a>(
        &'a mut self,
        subscriptions: &'a [SubscriptionSpec],
        tables: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Result<ScopedRowsHealthSummary>> + 'a>> {
        Box::pin(async move {
            let app_schema = self.app_schema();
            validate_requested_app_tables(app_schema, tables)?;
            let mut summary = ScopedRowsHealthSummary::default();
            for metadata in app_schema.app_table_metadata.iter().filter(|metadata| {
                tables.is_empty() || tables.iter().any(|table| table == metadata.name)
            }) {
                let table_subscriptions = subscriptions
                    .iter()
                    .filter(|subscription| subscription.table == metadata.name)
                    .collect::<Vec<_>>();
                let Some(rows) = self.rows.get_mut(metadata.name) else {
                    summary.tables.push(ScopedRowsTableHealth {
                        table: metadata.name.to_string(),
                        checked_synced_rows: 0,
                        orphaned_synced_rows: 0,
                    });
                    continue;
                };
                let checked_synced_rows = rows
                    .values()
                    .filter(|row| row_is_server_synced(row, metadata.server_version_column))
                    .count() as i64;
                let orphaned_ids = rows
                    .iter()
                    .filter(|(_, row)| row_is_server_synced(row, metadata.server_version_column))
                    .filter(|(_, row)| {
                        table_subscriptions.is_empty()
                            || !table_subscriptions.iter().any(|subscription| {
                                row_matches_scope_values(row, metadata, &subscription.scopes)
                            })
                    })
                    .map(|(row_id, _)| row_id.clone())
                    .collect::<Vec<_>>();
                for row_id in &orphaned_ids {
                    rows.remove(row_id);
                }
                let orphaned_synced_rows = orphaned_ids.len() as i64;
                summary.checked_synced_rows += checked_synced_rows;
                summary.orphaned_synced_rows += orphaned_synced_rows;
                summary.tables.push(ScopedRowsTableHealth {
                    table: metadata.name.to_string(),
                    checked_synced_rows,
                    orphaned_synced_rows,
                });
            }
            Ok(summary)
        })
    }

    fn outbox_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxSummary>>> + 'a>> {
        Box::pin(async move {
            Ok(self
                .outbox
                .iter()
                .map(|commit| OutboxSummary {
                    outbox_id: commit.id.clone(),
                    client_commit_id: commit.client_commit_id.clone(),
                    status: commit.status.clone(),
                    schema_version: commit.schema_version,
                    acked_commit_seq: commit.acked_commit_seq,
                    auth_lease: commit.auth_lease.clone(),
                })
                .collect())
        })
    }

    fn apply_mutation<'a>(
        &'a mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            match operation.op.as_str() {
                "upsert" => {
                    let row = local_row.unwrap_or_else(|| row_from_operation_payload(&operation));
                    self.upsert_row(&operation.table, row).await?;
                }
                "delete" => {
                    self.apply_change(SyncChange {
                        table: operation.table.clone(),
                        row_id: operation.row_id.clone(),
                        op: "delete".to_string(),
                        row_json: None,
                        row_version: operation.base_version,
                        scopes: ScopeValues::new(),
                    })
                    .await?;
                }
                op => {
                    return Err(SyncularError::protocol_message(format!(
                        "unsupported local operation: {op}"
                    )));
                }
            }

            self.enqueue_outbox(vec![operation])
        })
    }

    fn apply_mutation_with_active_auth_lease<'a>(
        &'a mut self,
        actor_id: Option<&'a str>,
        now_ms_value: i64,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            let schema = self.app_schema();
            let mut local_row = local_row;
            let scope = match operation.op.as_str() {
                "upsert" => {
                    let row =
                        local_row.get_or_insert_with(|| row_from_operation_payload(&operation));
                    memory_operation_scope(&schema, &operation, Some(row), true)?
                }
                "delete" => {
                    let previous_row = self
                        .rows
                        .get(&operation.table)
                        .and_then(|rows| rows.get(&operation.row_id))
                        .cloned();
                    memory_operation_scope(
                        &schema,
                        &operation,
                        previous_row.as_ref(),
                        previous_row.is_some(),
                    )?
                }
                op => {
                    return Err(SyncularError::protocol_message(format!(
                        "unsupported local operation: {op}"
                    )));
                }
            };
            let mut candidate_leases = self
                .auth_leases
                .values()
                .filter(|lease| lease.status == "active")
                .filter(|lease| actor_id.map_or(true, |actor_id| lease.actor_id == actor_id))
                .cloned()
                .collect::<Vec<_>>();
            candidate_leases.sort_by_key(|lease| lease.expires_at_ms);
            let provenance = select_active_auth_lease_for_operations(
                ActiveAuthLeasePolicy {
                    actor_id,
                    now_ms: now_ms_value,
                },
                candidate_leases,
                schema.current_schema_version(),
                &[scope],
            )?;

            match operation.op.as_str() {
                "upsert" => {
                    let row = local_row.unwrap_or_else(|| row_from_operation_payload(&operation));
                    self.upsert_row(&operation.table, row).await?;
                }
                "delete" => {
                    self.apply_change(SyncChange {
                        table: operation.table.clone(),
                        row_id: operation.row_id.clone(),
                        op: "delete".to_string(),
                        row_json: None,
                        row_version: operation.base_version,
                        scopes: ScopeValues::new(),
                    })
                    .await?;
                }
                _ => unreachable!("operation was validated before lease selection"),
            }

            let client_commit_id = self.enqueue_outbox(vec![operation])?;
            self.set_outbox_auth_lease(&client_commit_id, Some(provenance))
                .await?;
            Ok(client_commit_id)
        })
    }

    fn pending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            Ok(self
                .outbox
                .iter()
                .filter(|commit| {
                    commit.status == "pending"
                        && commit.attempt_count < MAX_SYNC_RETRIES
                        && commit.next_attempt_at <= now
                })
                .take(limit)
                .cloned()
                .collect())
        })
    }

    fn pending_outbox_count<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<usize>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            Ok(self
                .outbox
                .iter()
                .filter(|commit| {
                    commit.status == "pending"
                        && commit.attempt_count < MAX_SYNC_RETRIES
                        && commit.next_attempt_at <= now
                })
                .count())
        })
    }

    fn sending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>> {
        Box::pin(async move {
            Ok(self
                .outbox
                .iter()
                .filter(|commit| commit.status == "sending")
                .take(limit)
                .cloned()
                .collect())
        })
    }

    fn requeue_stale_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            let stale_before = now - SYNC_SENDING_TIMEOUT_MS;
            for commit in self
                .outbox
                .iter_mut()
                .filter(|commit| commit.status == "sending" && commit.updated_at < stale_before)
            {
                if commit.attempt_count >= MAX_SYNC_RETRIES {
                    commit.status = "failed".to_string();
                    commit.error =
                        Some("Sync attempt timed out while in sending state".to_string());
                    commit.next_attempt_at = 0;
                } else {
                    commit.status = "pending".to_string();
                    commit.error =
                        Some("Sync attempt timed out while in sending state; retrying".to_string());
                    commit.next_attempt_at = now;
                }
                commit.updated_at = now;
            }
            Ok(())
        })
    }

    fn mark_outbox_sending<'a>(
        &'a mut self,
        row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if let Some(commit) = self.outbox.iter_mut().find(|commit| commit.id == row_id) {
                commit.status = "sending".to_string();
                commit.attempt_count += 1;
                commit.updated_at = now_ms();
                commit.next_attempt_at = 0;
                commit.error = None;
            }
            Ok(())
        })
    }

    fn mark_outbox_acked<'a>(
        &'a mut self,
        row_id: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if let Some(commit) = self.outbox.iter_mut().find(|commit| commit.id == row_id) {
                commit.status = "acked".to_string();
                commit.last_response_json = Some(serde_json::to_string(&response)?);
                commit.error = None;
                commit.acked_commit_seq = response.commit_seq;
                commit.updated_at = now_ms();
                commit.next_attempt_at = 0;
            }
            Ok(())
        })
    }

    fn mark_outbox_failed<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if let Some(commit) = self.outbox.iter_mut().find(|commit| commit.id == row_id) {
                commit.status = "failed".to_string();
                commit.last_response_json = Some(serde_json::to_string(&response)?);
                commit.error = Some(error.to_string());
                commit.updated_at = now_ms();
                commit.next_attempt_at = 0;
            }
            Ok(())
        })
    }

    fn mark_outbox_retry<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if let Some(commit) = self.outbox.iter_mut().find(|commit| commit.id == row_id) {
                commit.status = if failed { "failed" } else { "pending" }.to_string();
                commit.error = Some(error.to_string());
                commit.next_attempt_at = if failed { 0 } else { next_attempt_at };
                commit.updated_at = now_ms();
            }
            Ok(())
        })
    }

    fn insert_conflict<'a>(
        &'a mut self,
        outbox: OutboxCommit,
        result: OperationResult,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.conflicts.push(WebConflictRecord {
                id: uuid::Uuid::new_v4().to_string(),
                outbox_commit_id: outbox.id,
                client_commit_id: outbox.client_commit_id,
                op_index: result.op_index,
                result_status: result.status.clone(),
                message: result
                    .message
                    .clone()
                    .or_else(|| result.error.clone())
                    .unwrap_or(result.status),
                code: result.code,
                server_version: result.server_version,
                created_at: now_ms(),
                resolved_at: None,
                resolution: None,
            });
            Ok(())
        })
    }

    fn upsert_auth_lease<'a>(
        &'a mut self,
        lease: AuthLeaseRecord,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.auth_leases.insert(lease.lease_id.clone(), lease);
            Ok(())
        })
    }

    fn auth_lease<'a>(
        &'a mut self,
        lease_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<AuthLeaseRecord>>> + 'a>> {
        Box::pin(async move { Ok(self.auth_leases.get(lease_id).cloned()) })
    }

    fn active_auth_leases<'a>(
        &'a mut self,
        actor_id: Option<&'a str>,
        now_ms_value: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AuthLeaseRecord>>> + 'a>> {
        Box::pin(async move {
            let mut leases = self
                .auth_leases
                .values()
                .filter(|lease| lease.status == "active")
                .filter(|lease| lease.not_before_ms <= now_ms_value)
                .filter(|lease| lease.expires_at_ms > now_ms_value)
                .filter(|lease| actor_id.map_or(true, |actor_id| lease.actor_id == actor_id))
                .cloned()
                .collect::<Vec<_>>();
            leases.sort_by_key(|lease| lease.expires_at_ms);
            Ok(leases)
        })
    }

    fn set_outbox_auth_lease<'a>(
        &'a mut self,
        client_commit_id: &'a str,
        provenance: Option<AuthLeaseProvenance>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let Some(commit) = self
                .outbox
                .iter_mut()
                .find(|commit| commit.client_commit_id == client_commit_id)
            else {
                return Err(SyncularError::storage(anyhow::anyhow!(
                    "outbox commit {client_commit_id} does not exist"
                )));
            };
            let mut provenance = provenance;
            if let Some(lease) = provenance.as_mut() {
                if lease.lease_token.is_none() {
                    lease.lease_token = self
                        .auth_leases
                        .get(&lease.lease_id)
                        .map(|record| record.token.clone());
                }
            }
            commit.auth_lease = provenance;
            Ok(())
        })
    }

    fn conflict_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ConflictSummary>>> + 'a>> {
        Box::pin(async move {
            let mut records = self
                .conflicts
                .iter()
                .filter(|conflict| conflict.resolved_at.is_none())
                .cloned()
                .collect::<Vec<_>>();
            records.sort_by_key(|conflict| -conflict.created_at);
            Ok(records
                .into_iter()
                .map(|conflict| ConflictSummary {
                    id: conflict.id,
                    client_commit_id: conflict.client_commit_id,
                    op_index: conflict.op_index,
                    result_status: conflict.result_status,
                    message: conflict.message,
                    code: conflict.code,
                    server_version: conflict.server_version,
                    resolved_at: conflict.resolved_at,
                    resolution: conflict.resolution,
                })
                .collect())
        })
    }

    fn resolve_conflict<'a>(
        &'a mut self,
        id: &'a str,
        resolution: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if let Some(conflict) = self
                .conflicts
                .iter_mut()
                .find(|conflict| conflict.id == id && conflict.resolved_at.is_none())
            {
                conflict.resolved_at = Some(now_ms());
                conflict.resolution = Some(resolution.to_string());
            }
            Ok(())
        })
    }

    fn retry_conflict_keep_local<'a>(
        &'a mut self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            let Some(conflict) = self
                .conflicts
                .iter()
                .find(|conflict| conflict.id == id && conflict.resolved_at.is_none())
                .cloned()
            else {
                return Err(SyncularError::config(format!(
                    "pending conflict not found: {id}"
                )));
            };

            let Some(server_version) = conflict.server_version else {
                return Err(SyncularError::protocol_message(format!(
                    "conflict {id} cannot be retried keep-local without server version"
                )));
            };

            let outbox = self
                .outbox
                .iter()
                .find(|outbox| outbox.id == conflict.outbox_commit_id)
                .ok_or_else(|| {
                    SyncularError::config(format!(
                        "outbox commit not found for conflict {}",
                        conflict.id
                    ))
                })?;
            let mut operations: Vec<SyncOperation> = serde_json::from_str(&outbox.operations_json)?;
            let op_index = usize::try_from(conflict.op_index).map_err(|_| {
                SyncularError::protocol_message(format!(
                    "conflict {} references invalid operation index {}",
                    conflict.id, conflict.op_index
                ))
            })?;
            let Some(operation) = operations.get_mut(op_index) else {
                return Err(SyncularError::protocol_message(format!(
                    "conflict {} references missing operation index {}",
                    conflict.id, conflict.op_index
                )));
            };
            operation.base_version = Some(server_version);
            let client_commit_id = self.enqueue_outbox(vec![operation.clone()])?;
            self.resolve_conflict(id, "keep-local").await?;
            Ok(client_commit_id)
        })
    }

    fn subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebSubscriptionState>>> + 'a>> {
        Box::pin(async move { Ok(self.states.get(subscription_id).cloned()) })
    }

    fn upsert_subscription_state<'a>(
        &'a mut self,
        state: WebSubscriptionState,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.states.insert(state.subscription_id.clone(), state);
            Ok(())
        })
    }

    fn delete_subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.states.remove(subscription_id);
            Ok(())
        })
    }

    fn verified_root<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebVerifiedRoot>>> + 'a>> {
        Box::pin(async move { Ok(self.verified_roots.get(subscription_id).cloned()) })
    }

    fn upsert_verified_root<'a>(
        &'a mut self,
        root: WebVerifiedRoot,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.verified_roots
                .insert(root.subscription_id.clone(), root);
            Ok(())
        })
    }

    fn delete_verified_root<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.verified_roots.remove(subscription_id);
            Ok(())
        })
    }

    fn clear_table_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let app_schema = self.app_schema();
            let metadata = app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            let Some(rows) = self.rows.get_mut(table) else {
                return Ok(());
            };
            rows.retain(|_, row| !row_matches_scope_values(row, metadata, scopes));
            Ok(())
        })
    }

    fn clear_table_for_scopes_except<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
        retained_scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let app_schema = self.app_schema();
            let metadata = app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            let Some(rows) = self.rows.get_mut(table) else {
                return Ok(());
            };
            rows.retain(|_, row| {
                !row_matches_scope_values(row, metadata, scopes)
                    || row_matches_scope_values(row, metadata, retained_scopes)
            });
            Ok(())
        })
    }

    fn clear_synced_rows_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<i64>> + 'a>> {
        Box::pin(async move {
            let app_schema = self.app_schema();
            let metadata = app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            let Some(rows) = self.rows.get_mut(table) else {
                return Ok(0);
            };
            let before = rows.len();
            rows.retain(|_, row| {
                let server_synced = row_is_server_synced(row, metadata.server_version_column);
                !(server_synced && row_matches_scope_values(row, metadata, scopes))
            });
            Ok(before.saturating_sub(rows.len()) as i64)
        })
    }

    fn current_row_json<'a>(
        &'a mut self,
        table: &'a str,
        row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + 'a>> {
        Box::pin(async move {
            Ok(self
                .rows
                .get(table)
                .and_then(|rows| rows.get(row_id))
                .cloned())
        })
    }

    fn upsert_row<'a>(
        &'a mut self,
        table: &'a str,
        row: Value,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let row_id = row_id_for_table(table, &row)?;
            self.rows
                .entry(table.to_string())
                .or_default()
                .insert(row_id, row);
            Ok(())
        })
    }

    fn apply_change<'a>(
        &'a mut self,
        change: SyncChange,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            match change.op.as_str() {
                "delete" => {
                    if let Some(rows) = self.rows.get_mut(&change.table) {
                        rows.remove(&change.row_id);
                    }
                }
                _ => {
                    if let Some(row) = change.row_json {
                        self.rows
                            .entry(change.table)
                            .or_default()
                            .insert(change.row_id, row);
                    }
                }
            }
            Ok(())
        })
    }

    fn list_table_json<'a>(
        &'a mut self,
        table: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            if table.starts_with("sync_") {
                return Err(SyncularError::config(format!(
                    "internal sync table is not readable through app table API: {table}"
                )));
            }
            let rows = self
                .rows
                .get(table)
                .map(|rows| rows.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            Ok(serde_json::to_string(&rows)?)
        })
    }
}

impl WebMemoryStore {
    fn enqueue_outbox(&mut self, operations: Vec<SyncOperation>) -> Result<String> {
        let unresolved = self
            .outbox
            .iter()
            .filter(|commit| commit.status != "acked")
            .count();
        validate_unresolved_outbox_capacity(unresolved)?;

        let client_commit_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        self.outbox.push(OutboxCommit {
            id: uuid::Uuid::new_v4().to_string(),
            client_commit_id: client_commit_id.clone(),
            status: "pending".to_string(),
            operations_json: sync_operations_json_for_outbox(&operations)?,
            last_response_json: None,
            error: None,
            created_at: now,
            updated_at: now,
            attempt_count: 0,
            acked_commit_seq: None,
            schema_version: runtime_schema_version(),
            next_attempt_at: 0,
            auth_lease: None,
        });
        Ok(client_commit_id)
    }
}

fn row_id_for_table(table: &str, row: &Value) -> Result<String> {
    row.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            SyncularError::protocol_message(format!(
                "row for table {table} is missing string primary key id"
            ))
        })
}

fn row_from_operation_payload(operation: &SyncOperation) -> Value {
    let mut row = operation
        .payload
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    row.entry("id".to_string())
        .or_insert_with(|| Value::String(operation.row_id.clone()));
    Value::Object(row)
}

fn memory_operation_scope(
    app_schema: &AppSchema,
    operation: &SyncOperation,
    row: Option<&Value>,
    row_exists_or_will_be_written: bool,
) -> Result<MutationOperationScope> {
    if crate::encrypted_crdt::is_encrypted_crdt_system_table(&operation.table) {
        return Ok(system_table_operation_scope(operation));
    }
    let metadata = app_schema.table_metadata(&operation.table).ok_or_else(|| {
        SyncularError::config(format!("unknown generated app table: {}", operation.table))
    })?;
    Ok(app_table_operation_scope(
        metadata,
        operation,
        row,
        row_exists_or_will_be_written,
    ))
}

fn row_is_server_synced(row: &Value, server_version_column: &str) -> bool {
    row.get(server_version_column)
        .and_then(Value::as_i64)
        .is_some_and(|version| version > 0)
}

fn row_matches_scope_values(
    row: &Value,
    metadata: &AppTableMetadata,
    scopes: &ScopeValues,
) -> bool {
    if scopes
        .keys()
        .any(|scope_name| !metadata.scopes.iter().any(|scope| scope.name == scope_name))
    {
        return false;
    }
    metadata.scopes.iter().all(|scope| {
        let Some(expected) = scopes.get(scope.name) else {
            return !scope.required;
        };
        let actual = row.get(scope.column);
        match expected {
            Value::Array(values) => actual.is_some_and(|actual| values.iter().any(|v| v == actual)),
            value => actual == Some(value),
        }
    })
}

fn validate_requested_app_tables(app_schema: AppSchema, tables: &[String]) -> Result<()> {
    for table in tables {
        if app_schema.table_metadata(table).is_none() {
            return Err(SyncularError::config(format!(
                "unknown generated app table: {table}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{OperationResult, PushCommitResponse, SyncChange, SyncOperation};
    use serde_json::json;
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

    #[test]
    fn memory_store_applies_rows_changes_and_scope_clearing() -> Result<()> {
        let mut store = WebMemoryStore::new();

        block_on(store.upsert_row("tasks", task_row("task-1", "p0")))?;
        block_on(store.upsert_row("tasks", task_row("task-2", "p1")))?;
        assert_eq!(store.row_count("tasks"), 2);

        let mut scopes = ScopeValues::new();
        scopes.insert("user_id".to_string(), json!("user-rust"));
        scopes.insert("project_id".to_string(), json!("p0"));
        block_on(store.clear_table_for_scopes("tasks", &scopes))?;
        let rows: Value = serde_json::from_str(&block_on(store.list_table_json("tasks"))?)?;
        assert_eq!(rows.as_array().map(Vec::len), Some(1));
        assert_eq!(rows[0]["id"], "task-2");

        block_on(store.apply_change(SyncChange {
            table: "tasks".to_string(),
            row_id: "task-2".to_string(),
            op: "delete".to_string(),
            row_json: None,
            row_version: Some(3),
            scopes: ScopeValues::new(),
        }))?;
        assert_eq!(store.row_count("tasks"), 0);

        Ok(())
    }

    #[test]
    fn memory_store_clears_scope_difference_without_removing_retained_rows() -> Result<()> {
        let mut store = WebMemoryStore::new();

        block_on(store.upsert_row("tasks", task_row("revoked-task", "p0")))?;
        block_on(store.upsert_row("tasks", task_row("retained-task", "p1")))?;

        let mut old_scopes = ScopeValues::new();
        old_scopes.insert("user_id".to_string(), json!("user-rust"));
        old_scopes.insert("project_id".to_string(), json!(["p0", "p1"]));
        let mut retained_scopes = ScopeValues::new();
        retained_scopes.insert("user_id".to_string(), json!("user-rust"));
        retained_scopes.insert("project_id".to_string(), json!("p1"));

        block_on(store.clear_table_for_scopes_except("tasks", &old_scopes, &retained_scopes))?;
        let rows: Value = serde_json::from_str(&block_on(store.list_table_json("tasks"))?)?;
        assert_eq!(rows.as_array().map(Vec::len), Some(1));
        assert_eq!(rows[0]["id"], "retained-task");

        Ok(())
    }

    #[test]
    fn memory_store_persists_subscription_state() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let mut scopes = ScopeValues::new();
        scopes.insert("user_id".to_string(), json!("user-rust"));

        block_on(store.upsert_subscription_state(WebSubscriptionState {
            subscription_id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            scopes,
            cursor: 42,
            bootstrap_state: None,
            status: "active".to_string(),
        }))?;

        let state = block_on(store.subscription_state("sub-tasks"))?.expect("stored state");
        assert_eq!(state.table, "tasks");
        assert_eq!(state.cursor, 42);

        block_on(store.delete_subscription_state("sub-tasks"))?;
        assert!(block_on(store.subscription_state("sub-tasks"))?.is_none());

        Ok(())
    }

    #[test]
    fn memory_store_rejects_unknown_tables() {
        let mut store = WebMemoryStore::new();
        let error = block_on(store.list_table_json("sync_outbox_commits"))
            .expect_err("internal table should be hidden");
        assert_eq!(error.kind(), crate::error::ErrorKind::Config);
    }

    #[test]
    fn memory_store_applies_local_operation_and_tracks_outbox() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let operation = SyncOperation {
            table: "tasks".to_string(),
            row_id: "local-task".to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({
                "title": "Local task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            })),
            base_version: Some(0),
        };

        let client_commit_id = block_on(store.apply_mutation(operation, None))?;
        assert!(!client_commit_id.is_empty());
        assert_eq!(store.row_count("tasks"), 1);
        assert_eq!(store.outbox_count(), 1);

        let pending = block_on(store.pending_outbox(20))?;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].client_commit_id, client_commit_id);
        assert_eq!(pending[0].status, "pending");
        assert_eq!(
            pending[0].schema_version,
            crate::runtime_schema::runtime_schema_version()
        );

        block_on(store.mark_outbox_sending(&pending[0].id))?;
        assert!(block_on(store.pending_outbox(20))?.is_empty());

        block_on(store.mark_outbox_acked(
            &pending[0].id,
            PushCommitResponse {
                client_commit_id,
                status: "applied".to_string(),
                commit_seq: Some(5),
                results: Vec::new(),
            },
        ))?;

        let outbox = &store.outbox[0];
        assert_eq!(outbox.status, "acked");
        assert_eq!(outbox.acked_commit_seq, Some(5));
        assert!(outbox.last_response_json.is_some());

        Ok(())
    }

    #[test]
    fn memory_store_marks_failed_outbox() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let operation = SyncOperation {
            table: "tasks".to_string(),
            row_id: "failed-task".to_string(),
            op: "delete".to_string(),
            payload: None,
            base_version: Some(1),
        };
        block_on(store.apply_mutation(operation, None))?;
        let pending = block_on(store.pending_outbox(20))?;

        block_on(store.mark_outbox_failed(
            &pending[0].id,
            "REJECTED",
            PushCommitResponse {
                client_commit_id: pending[0].client_commit_id.clone(),
                status: "rejected".to_string(),
                commit_seq: None,
                results: Vec::new(),
            },
        ))?;

        assert_eq!(store.outbox[0].status, "failed");
        assert_eq!(store.outbox[0].error.as_deref(), Some("REJECTED"));

        Ok(())
    }

    #[test]
    fn memory_store_persists_and_resolves_conflict_summaries() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let pending = enqueue_conflicting_task(&mut store, "conflict-task")?;

        block_on(store.insert_conflict(
            pending.clone(),
            OperationResult {
                op_index: 0,
                status: "conflict".to_string(),
                message: Some("version conflict".to_string()),
                error: None,
                code: Some("sync.version_conflict".to_string()),
                retriable: Some(true),
                server_version: Some(9),
                server_row: Some(task_row("conflict-task", "p0")),
            },
        ))?;

        assert_eq!(store.conflict_count(), 1);
        let summaries = block_on(store.conflict_summaries())?;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].client_commit_id, pending.client_commit_id);
        assert_eq!(summaries[0].op_index, 0);
        assert_eq!(summaries[0].result_status, "conflict");
        assert_eq!(summaries[0].message, "version conflict");
        assert_eq!(summaries[0].code.as_deref(), Some("sync.version_conflict"));
        assert_eq!(summaries[0].server_version, Some(9));

        block_on(store.resolve_conflict(&summaries[0].id, "keep-server"))?;
        assert!(block_on(store.conflict_summaries())?.is_empty());
        assert_eq!(store.conflict_count(), 1);

        Ok(())
    }

    #[test]
    fn memory_store_retries_conflict_with_keep_local_version() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let pending = enqueue_conflicting_task(&mut store, "retry-task")?;

        block_on(store.insert_conflict(
            pending,
            OperationResult {
                op_index: 0,
                status: "conflict".to_string(),
                message: Some("version conflict".to_string()),
                error: None,
                code: Some("sync.version_conflict".to_string()),
                retriable: Some(true),
                server_version: Some(12),
                server_row: Some(task_row("retry-task", "p0")),
            },
        ))?;

        let conflict_id = block_on(store.conflict_summaries())?[0].id.clone();
        let retry_commit_id = block_on(store.retry_conflict_keep_local(&conflict_id))?;
        assert!(!retry_commit_id.is_empty());
        assert!(block_on(store.conflict_summaries())?.is_empty());

        let pending = block_on(store.pending_outbox(20))?;
        let retry = pending
            .iter()
            .find(|commit| commit.client_commit_id == retry_commit_id)
            .expect("retry outbox commit");
        let operations: Vec<SyncOperation> = serde_json::from_str(&retry.operations_json)?;
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].table, "tasks");
        assert_eq!(operations[0].row_id, "retry-task");
        assert_eq!(operations[0].base_version, Some(12));

        Ok(())
    }

    #[test]
    fn memory_store_requires_server_version_for_keep_local_retry() -> Result<()> {
        let mut store = WebMemoryStore::new();
        let pending = enqueue_conflicting_task(&mut store, "no-version-task")?;

        block_on(store.insert_conflict(
            pending,
            OperationResult {
                op_index: 0,
                status: "conflict".to_string(),
                message: Some("version conflict".to_string()),
                error: None,
                code: Some("sync.version_conflict".to_string()),
                retriable: Some(true),
                server_version: None,
                server_row: None,
            },
        ))?;

        let conflict_id = block_on(store.conflict_summaries())?[0].id.clone();
        let error = block_on(store.retry_conflict_keep_local(&conflict_id))
            .expect_err("retry should require server version");
        assert_eq!(error.kind(), crate::error::ErrorKind::Protocol);
        assert_eq!(block_on(store.conflict_summaries())?.len(), 1);

        Ok(())
    }

    fn task_row(id: &str, project_id: &str) -> Value {
        json!({
            "id": id,
            "title": id,
            "completed": 0,
            "user_id": "user-rust",
            "project_id": project_id,
            "server_version": 1
        })
    }

    fn enqueue_conflicting_task(store: &mut WebMemoryStore, row_id: &str) -> Result<OutboxCommit> {
        let operation = SyncOperation {
            table: "tasks".to_string(),
            row_id: row_id.to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({
                "title": "Local task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            })),
            base_version: Some(1),
        };
        block_on(store.apply_mutation(operation, None))?;
        Ok(block_on(store.pending_outbox(20))?
            .into_iter()
            .next()
            .expect("pending outbox commit"))
    }

    fn block_on<T>(future: Pin<Box<dyn Future<Output = T> + '_>>) -> T {
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        let mut future = future;
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("test future unexpectedly pending"),
        }
    }

    fn noop_waker() -> Waker {
        unsafe fn clone(_: *const ()) -> RawWaker {
            raw_waker()
        }
        unsafe fn wake(_: *const ()) {}
        unsafe fn wake_by_ref(_: *const ()) {}
        unsafe fn drop(_: *const ()) {}

        fn raw_waker() -> RawWaker {
            RawWaker::new(
                std::ptr::null(),
                &RawWakerVTable::new(clone, wake, wake_by_ref, drop),
            )
        }

        unsafe { Waker::from_raw(raw_waker()) }
    }
}
