use crate::binary_snapshot::SnapshotChunkRows;
use crate::error::Result;
use crate::protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub const MAX_SYNC_RETRIES: i32 = 5;
pub const SYNC_SENDING_TIMEOUT_MS: i64 = 30_000;
pub const MAX_BLOB_UPLOAD_RETRIES: i32 = 3;
pub const BLOB_UPLOAD_STALE_TIMEOUT_MS: i64 = 30_000;
pub const SQLITE_BUSY_TIMEOUT_MS: i32 = 5_000;

const RETRY_BASE_DELAY_MS: i64 = 1_000;
const RETRY_MAX_DELAY_MS: i64 = 30_000;

pub fn retry_backoff_delay_ms(attempt_count: i32) -> i64 {
    let exponent = attempt_count.saturating_sub(1).min(12) as u32;
    RETRY_BASE_DELAY_MS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(RETRY_MAX_DELAY_MS)
}

pub fn next_retry_at(now: i64, attempt_count: i32) -> i64 {
    now.saturating_add(retry_backoff_delay_ms(attempt_count))
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
pub struct AppliedMigration {
    pub version: String,
    pub name: String,
    pub checksum: String,
    pub applied_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxSummary {
    pub client_commit_id: String,
    pub status: String,
    pub schema_version: i32,
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

pub trait SyncStore {
    type Tx<'a>: SyncStoreTx
    where
        Self: 'a;

    fn transaction<T>(&mut self, f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T>) -> Result<T>;
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

    fn subscription_state(
        &mut self,
        state_id: &str,
        subscription_id: &str,
    ) -> Result<Option<SubscriptionState>>;
    fn upsert_subscription_state(&mut self, state: &SubscriptionState) -> Result<()>;
    fn delete_subscription_state(&mut self, state_id: &str, subscription_id: &str) -> Result<()>;

    fn clear_table_for_scopes(&mut self, table: &str, scopes: &ScopeValues) -> Result<()>;
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

    fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>>;

    fn next_outbox_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(None)
    }

    fn next_blob_upload_retry_at(&mut self) -> Result<Option<i64>> {
        Ok(None)
    }

    fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>>;

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
