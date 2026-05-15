use crate::app_schema::{default_app_schema, AppSchema};
use crate::client::SyncChangedRow;
use crate::error::{Result, SyncularError};
use crate::protocol::{
    BootstrapState, OperationResult, PushCommitResponse, ScopeValues, SyncChange, SyncOperation,
};
use crate::runtime_schema::runtime_schema_version;
use crate::store::{
    now_ms, ConflictSummary, OutboxCommit, MAX_SYNC_RETRIES, SYNC_SENDING_TIMEOUT_MS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSubscriptionState {
    pub subscription_id: String,
    pub table: String,
    pub scopes: ScopeValues,
    pub cursor: i64,
    pub bootstrap_state: Option<BootstrapState>,
    pub status: String,
}

pub trait AsyncWebStore {
    fn app_schema(&self) -> AppSchema {
        default_app_schema()
    }

    fn apply_local_operation<'a>(
        &'a mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>>;

    fn pending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>>;

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

    fn clear_table_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

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
    rows: HashMap<String, HashMap<String, Value>>,
    outbox: Vec<OutboxCommit>,
    conflicts: Vec<WebConflictRecord>,
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
    fn apply_local_operation<'a>(
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

    fn clear_table_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let Some(rows) = self.rows.get_mut(table) else {
                return Ok(());
            };
            rows.retain(|_, row| !row_matches_scopes(row, scopes));
            Ok(())
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
        let client_commit_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        self.outbox.push(OutboxCommit {
            id: uuid::Uuid::new_v4().to_string(),
            client_commit_id: client_commit_id.clone(),
            status: "pending".to_string(),
            operations_json: serde_json::to_string(&operations)?,
            last_response_json: None,
            error: None,
            created_at: now,
            updated_at: now,
            attempt_count: 0,
            acked_commit_seq: None,
            schema_version: runtime_schema_version(),
            next_attempt_at: 0,
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

fn row_matches_scopes(row: &Value, scopes: &ScopeValues) -> bool {
    scopes
        .iter()
        .all(|(column, expected)| row.get(column) == Some(expected))
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

        let client_commit_id = block_on(store.apply_local_operation(operation, None))?;
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
        block_on(store.apply_local_operation(operation, None))?;
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
                code: Some("VERSION_CONFLICT".to_string()),
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
        assert_eq!(summaries[0].code.as_deref(), Some("VERSION_CONFLICT"));
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
                code: Some("VERSION_CONFLICT".to_string()),
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
                code: Some("VERSION_CONFLICT".to_string()),
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
        block_on(store.apply_local_operation(operation, None))?;
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
