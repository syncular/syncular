use crate::binary_snapshot::SnapshotChunkRows;
use crate::client::SubscriptionSpec;
use crate::error::{Result, SyncularError};
use crate::protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(not(all(target_arch = "wasm32", feature = "web-transport")))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(all(target_arch = "wasm32", feature = "web-transport")))]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(all(target_arch = "wasm32", feature = "web-transport"))]
pub fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

pub const MAX_SYNC_RETRIES: i32 = 5;
pub const SYNC_SENDING_TIMEOUT_MS: i64 = 30_000;
pub const MAX_BLOB_UPLOAD_RETRIES: i32 = 3;
pub const BLOB_UPLOAD_STALE_TIMEOUT_MS: i64 = 30_000;
pub const SQLITE_BUSY_TIMEOUT_MS: i32 = 5_000;
pub const APP_SCHEMA_ID: &str = "syncular-app";

const RETRY_BASE_DELAY_MS: i64 = 1_000;
const RETRY_MAX_DELAY_MS: i64 = 30_000;
const BLOB_UPLOAD_RETRY_BASE_DELAY_MS: i64 = 100;
const BLOB_UPLOAD_RETRY_MAX_DELAY_MS: i64 = 5_000;

pub fn retry_backoff_delay_ms(attempt_count: i32) -> i64 {
    let exponent = attempt_count.saturating_sub(1).min(12) as u32;
    RETRY_BASE_DELAY_MS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(RETRY_MAX_DELAY_MS)
}

pub fn next_retry_at(now: i64, attempt_count: i32) -> i64 {
    now.saturating_add(retry_backoff_delay_ms(attempt_count))
}

pub fn blob_upload_retry_backoff_delay_ms(attempt_count: i32) -> i64 {
    let exponent = attempt_count.saturating_sub(1).min(12) as u32;
    BLOB_UPLOAD_RETRY_BASE_DELAY_MS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(BLOB_UPLOAD_RETRY_MAX_DELAY_MS)
}

pub fn next_blob_upload_retry_at(now: i64, attempt_count: i32) -> i64 {
    now.saturating_add(blob_upload_retry_backoff_delay_ms(attempt_count))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg(feature = "demo-todo-fixture")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub completed: i32,
    pub user_id: String,
    pub project_id: Option<String>,
    pub server_version: i64,
    pub image: Option<String>,
    pub title_yjs_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxCommit {
    pub id: String,
    pub client_commit_id: String,
    pub status: String,
    pub operations_json: String,
    pub last_response_json: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub attempt_count: i32,
    pub acked_commit_seq: Option<i64>,
    pub schema_version: i32,
    pub next_attempt_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_lease: Option<AuthLeaseProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionState {
    pub state_id: String,
    pub subscription_id: String,
    pub table: String,
    pub scopes_json: String,
    pub params_json: String,
    pub cursor: i64,
    pub bootstrap_state_json: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedRoot {
    pub state_id: String,
    pub subscription_id: String,
    pub partition_id: String,
    pub commit_seq: i64,
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedMigration {
    pub version: String,
    pub name: String,
    pub checksum: String,
    pub applied_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSchemaState {
    pub schema_id: String,
    pub schema_version: Option<i32>,
    pub current_schema_version: i32,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxSummary {
    pub client_commit_id: String,
    pub status: String,
    pub schema_version: i32,
    pub acked_commit_seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_lease: Option<AuthLeaseProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeaseRecord {
    pub lease_id: String,
    pub kid: String,
    pub actor_id: String,
    pub issued_at_ms: i64,
    pub not_before_ms: i64,
    pub expires_at_ms: i64,
    pub schema_version: i32,
    pub payload_json: String,
    pub token: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_validation_error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictSummary {
    pub id: String,
    pub client_commit_id: String,
    pub op_index: i32,
    pub result_status: String,
    pub message: String,
    pub code: Option<String>,
    pub server_version: Option<i64>,
    pub resolved_at: Option<i64>,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobHealthSummary {
    pub cache_count: i64,
    pub cache_bytes: i64,
    pub upload_pending: i64,
    pub upload_uploading: i64,
    pub upload_failed: i64,
    pub checked_references: i64,
    pub invalid_references: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrdtHealthSummary {
    pub document_count: i64,
    pub pending_updates: i64,
    pub flushed_updates: i64,
    pub acked_updates: i64,
    pub log_updates: i64,
    pub orphaned_documents: i64,
    pub orphaned_log_entries: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedRowsHealthSummary {
    pub checked_synced_rows: i64,
    pub orphaned_synced_rows: i64,
    pub tables: Vec<ScopedRowsTableHealth>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedRowsTableHealth {
    pub table: String,
    pub checked_synced_rows: i64,
    pub orphaned_synced_rows: i64,
}

pub trait SyncStore {
    type Tx<'a>: SyncStoreTx
    where
        Self: 'a;

    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T>) -> Result<T>;

    fn supports_sqlite_snapshot_artifacts(&self) -> bool {
        false
    }

    fn decode_sqlite_snapshot_artifact_rows(
        &self,
        _table: &str,
        _artifact_bytes: &[u8],
    ) -> Result<Vec<Value>> {
        Err(SyncularError::protocol_message(
            "snapshot artifacts are not supported by this store",
        ))
    }
}

pub trait SyncStoreTx {
    fn pending_outbox(&mut self, limit: i64) -> Result<Vec<OutboxCommit>>;
    fn requeue_stale_outbox(&mut self) -> Result<()>;
    fn mark_outbox_sending(&mut self, row_id: &str) -> Result<()>;
    fn mark_pushed_operation_server_versions(
        &mut self,
        _outbox: &OutboxCommit,
        _response: &PushCommitResponse,
    ) -> Result<()> {
        Ok(())
    }
    fn mark_outbox_acked(&mut self, row_id: &str, response: &PushCommitResponse) -> Result<()>;
    fn mark_outbox_failed(
        &mut self,
        row_id: &str,
        error: &str,
        response: &PushCommitResponse,
    ) -> Result<()>;
    fn mark_outbox_retry(
        &mut self,
        row_id: &str,
        error: &str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Result<()>;
    fn insert_conflict(&mut self, outbox: &OutboxCommit, result: &OperationResult) -> Result<()>;

    fn upsert_auth_lease(&mut self, _lease: &AuthLeaseRecord) -> Result<()> {
        Err(SyncularError::storage(anyhow::anyhow!(
            "auth lease storage is not supported by this store"
        )))
    }

    fn auth_lease(&mut self, _lease_id: &str) -> Result<Option<AuthLeaseRecord>> {
        Err(SyncularError::storage(anyhow::anyhow!(
            "auth lease storage is not supported by this store"
        )))
    }

    fn active_auth_leases(
        &mut self,
        _actor_id: Option<&str>,
        _now_ms: i64,
    ) -> Result<Vec<AuthLeaseRecord>> {
        Err(SyncularError::storage(anyhow::anyhow!(
            "auth lease storage is not supported by this store"
        )))
    }

    fn set_outbox_auth_lease(
        &mut self,
        _client_commit_id: &str,
        _provenance: Option<&AuthLeaseProvenance>,
    ) -> Result<()> {
        Err(SyncularError::storage(anyhow::anyhow!(
            "outbox auth lease provenance is not supported by this store"
        )))
    }

    fn subscription_state(
        &mut self,
        state_id: &str,
        subscription_id: &str,
    ) -> Result<Option<SubscriptionState>>;
    fn subscription_states(&mut self, _state_id: &str) -> Result<Vec<SubscriptionState>> {
        Ok(Vec::new())
    }
    fn upsert_subscription_state(&mut self, state: &SubscriptionState) -> Result<()>;
    fn delete_subscription_state(&mut self, state_id: &str, subscription_id: &str) -> Result<()>;
    fn verified_root(
        &mut self,
        _state_id: &str,
        _subscription_id: &str,
    ) -> Result<Option<VerifiedRoot>> {
        Ok(None)
    }
    fn verified_roots(&mut self, _state_id: &str) -> Result<Vec<VerifiedRoot>> {
        Ok(Vec::new())
    }
    fn upsert_verified_root(&mut self, _root: &VerifiedRoot) -> Result<()> {
        Ok(())
    }
    fn delete_verified_root(&mut self, _state_id: &str, _subscription_id: &str) -> Result<()> {
        Ok(())
    }
    fn crdt_state_vector_hints(
        &mut self,
        _table: &str,
        _scopes: &ScopeValues,
        _limit: i64,
    ) -> Result<Vec<CrdtStateVectorHint>> {
        Ok(Vec::new())
    }

    fn clear_table_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<()>;
    fn clear_synced_rows_for_scopes(&mut self, _table: &str, _scopes: &ScopeValues) -> Result<i64> {
        Err(SyncularError::storage(anyhow::anyhow!(
            "clearing synced rows is not supported by this store"
        )))
    }
    fn clear_table_for_scopes_preserving_local_crdt(
        &mut self,
        table: &str,
        scopes: &ScopeValues,
    ) -> Result<()> {
        self.clear_table_for_scopes(table, scopes)
    }
    fn current_row_json(&mut self, _table: &str, _row_id: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    fn upsert_row(&mut self, table: &str, row: &Value, fallback_version: Option<i64>)
        -> Result<()>;
    fn upsert_rows(
        &mut self,
        table: &str,
        rows: &[Value],
        fallback_version: Option<i64>,
    ) -> Result<()> {
        for row in rows {
            self.upsert_row(table, row, fallback_version)?;
        }
        Ok(())
    }
    fn upsert_snapshot_chunk_rows(
        &mut self,
        table: &str,
        rows: &SnapshotChunkRows,
        fallback_version: Option<i64>,
    ) -> Result<()> {
        let rows = rows.clone().try_into_value_rows()?;
        self.upsert_rows(table, &rows, fallback_version)
    }
    fn apply_change(&mut self, change: &SyncChange) -> Result<()>;
}

pub trait SyncStateStore {
    fn applied_migrations(&mut self) -> Result<Vec<AppliedMigration>>;

    fn app_schema_state(&mut self, current_schema_version: i32) -> Result<AppSchemaState> {
        Ok(AppSchemaState {
            schema_id: APP_SCHEMA_ID.to_string(),
            schema_version: None,
            current_schema_version,
            updated_at: None,
        })
    }

    fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>>;

    fn next_outbox_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(None)
    }

    fn next_blob_upload_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(None)
    }

    fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>>;

    fn blob_health_summary(&mut self) -> Result<Option<BlobHealthSummary>> {
        Ok(None)
    }

    fn crdt_health_summary(&mut self) -> Result<Option<CrdtHealthSummary>> {
        Ok(None)
    }

    fn scoped_rows_health_summary(
        &mut self,
        _subscriptions: &[SubscriptionSpec],
    ) -> Result<Option<ScopedRowsHealthSummary>> {
        Ok(None)
    }

    fn clear_orphaned_synced_rows(
        &mut self,
        _subscriptions: &[SubscriptionSpec],
        _tables: &[String],
    ) -> Result<ScopedRowsHealthSummary> {
        Err(SyncularError::storage(anyhow::anyhow!(
            "clearing orphaned synced rows is not supported by this store"
        )))
    }

    fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()>;

    fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String>;
}

#[cfg(feature = "demo-todo-fixture")]
pub trait DemoTaskStore {
    fn add_task(
        &mut self,
        actor_id: &str,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()>;

    fn patch_task_title(
        &mut self,
        project_id: Option<&str>,
        task_id: String,
        title_value: String,
    ) -> Result<()>;

    fn list_tasks(&mut self) -> Result<Vec<Task>>;
}
