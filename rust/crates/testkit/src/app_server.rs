use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use syncular_runtime::app_schema::{AppSchema, AppTableMetadata};
use syncular_runtime::binary_snapshot::SnapshotChunkRows;
use syncular_runtime::crdt_yjs::{transform_operation_payload_for_metadata, YJS_PAYLOAD_KEY};
use syncular_runtime::error::{ErrorKind, Result, SyncularError};
use syncular_runtime::protocol::{
    BlobRef, CombinedRequest, CombinedResponse, OperationResult, PullResponse, PushBatchResponse,
    PushCommitRequest, PushCommitResponse, ScopeValues, SnapshotChunkRef, SubscriptionResponse,
    SyncChange, SyncCommit, SyncOperation, SyncSnapshot,
};
use syncular_runtime::transport::{
    BlobTransport, RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders,
    SyncTransport,
};

#[derive(Debug, Clone)]
pub struct AppTestServerOptions {
    pub actor_id: String,
    pub created_at_prefix: String,
    pub emit_realtime_sync: bool,
    pub delivery_mode: AppTestServerDeliveryMode,
    pub required_authorization: Option<String>,
    pub required_schema_version: Option<i32>,
    pub latest_schema_version: Option<i32>,
}

impl Default for AppTestServerOptions {
    fn default() -> Self {
        Self {
            actor_id: "test-server".to_string(),
            created_at_prefix: "2026-01-01T00:00:00".to_string(),
            emit_realtime_sync: true,
            delivery_mode: AppTestServerDeliveryMode::Normal,
            required_authorization: None,
            required_schema_version: None,
            latest_schema_version: None,
        }
    }
}

impl AppTestServerOptions {
    pub fn require_authorization(mut self, authorization: impl Into<String>) -> Self {
        self.required_authorization = Some(authorization.into());
        self
    }

    pub fn require_schema_version(mut self, schema_version: i32) -> Self {
        self.required_schema_version = Some(schema_version);
        self.latest_schema_version = Some(
            self.latest_schema_version
                .map_or(schema_version, |latest| latest.max(schema_version)),
        );
        self
    }

    pub fn latest_schema_version(mut self, schema_version: i32) -> Self {
        self.latest_schema_version = Some(schema_version);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppTestServerDeliveryMode {
    Normal,
    ReverseAndDuplicate,
}

#[derive(Debug, Clone)]
pub struct AppTestServerCommit {
    pub commit_seq: i64,
    pub client_id: String,
    pub changes: Vec<SyncChange>,
}

#[derive(Debug, Default)]
struct AppTestServerState {
    rows: BTreeMap<String, BTreeMap<String, Value>>,
    commits: Vec<AppTestServerCommit>,
    requests: Vec<CombinedRequest>,
    ws_pushes: Vec<PushCommitRequest>,
    auth_headers: Vec<SyncAuthHeaders>,
    realtime_events: VecDeque<RealtimeEvent>,
    blobs: BTreeMap<String, Vec<u8>>,
    required_schema_version: Option<i32>,
    latest_schema_version: Option<i32>,
    next_server_version: i64,
    next_commit_seq: i64,
    closed_realtime_count: usize,
}

#[derive(Clone)]
pub struct AppTestServer {
    app_schema: AppSchema,
    options: AppTestServerOptions,
    state: Arc<Mutex<AppTestServerState>>,
}

#[derive(Clone)]
pub struct AppTestRealtime {
    app_schema: AppSchema,
    options: AppTestServerOptions,
    state: Arc<Mutex<AppTestServerState>>,
}

impl AppTestServer {
    pub fn new(app_schema: AppSchema) -> Self {
        Self::with_options(app_schema, AppTestServerOptions::default())
    }

    pub fn with_options(app_schema: AppSchema, options: AppTestServerOptions) -> Self {
        let required_schema_version = options.required_schema_version;
        let latest_schema_version = options.latest_schema_version;
        Self {
            app_schema,
            options,
            state: Arc::new(Mutex::new(AppTestServerState {
                required_schema_version,
                latest_schema_version,
                next_server_version: 1,
                next_commit_seq: 1,
                ..AppTestServerState::default()
            })),
        }
    }

    pub fn seed_row(&self, table: &str, row: Value) -> Result<Value> {
        let metadata = self.table_metadata(table)?;
        let row_id = row_id_from_row(metadata, &row)?;
        let row = self.prepare_server_row(metadata, &row_id, row, None)?;
        let version = row_server_version(metadata, &row).unwrap_or(0);
        let mut state = self.state.lock().expect("app test server state");
        bump_next_server_version_locked(&mut state, version);
        state
            .rows
            .entry(table.to_string())
            .or_default()
            .insert(row_id, row.clone());
        Ok(row)
    }

    pub fn set_schema_versions(
        &self,
        required_schema_version: Option<i32>,
        latest_schema_version: Option<i32>,
    ) {
        let mut state = self.state.lock().expect("app test server state");
        state.required_schema_version = required_schema_version;
        state.latest_schema_version = latest_schema_version;
    }

    pub fn require_schema_version(&self, schema_version: i32) {
        let mut state = self.state.lock().expect("app test server state");
        state.required_schema_version = Some(schema_version);
        state.latest_schema_version = Some(
            state
                .latest_schema_version
                .map_or(schema_version, |latest| latest.max(schema_version)),
        );
    }

    pub fn commit_row(&self, table: &str, row: Value) -> Result<i64> {
        let metadata = self.table_metadata(table)?;
        let row_id = row_id_from_row(metadata, &row)?;
        let mut state = self.state.lock().expect("app test server state");
        let version = row
            .get(metadata.server_version_column)
            .and_then(Value::as_i64)
            .unwrap_or_else(|| next_server_version_locked(&mut state));
        let row = self.prepare_server_row(metadata, &row_id, row, Some(version))?;
        let scopes = scopes_for_row(metadata, &row);
        let change = SyncChange {
            table: table.to_string(),
            row_id: row_id.clone(),
            op: "upsert".to_string(),
            row_json: Some(row.clone()),
            row_version: Some(version),
            scopes,
        };
        state
            .rows
            .entry(table.to_string())
            .or_default()
            .insert(row_id, row);
        let client_id = self.options.actor_id.clone();
        let commit_seq = self.append_commit_locked(&mut state, client_id, vec![change]);
        Ok(commit_seq)
    }

    pub fn delete_row(&self, table: &str, row_id: &str) -> Result<i64> {
        let metadata = self.table_metadata(table)?;
        let mut state = self.state.lock().expect("app test server state");
        let old_row = state
            .rows
            .entry(table.to_string())
            .or_default()
            .remove(row_id);
        let scopes = old_row
            .as_ref()
            .map(|row| scopes_for_row(metadata, row))
            .unwrap_or_default();
        let version = next_server_version_locked(&mut state);
        let change = SyncChange {
            table: table.to_string(),
            row_id: row_id.to_string(),
            op: "delete".to_string(),
            row_json: None,
            row_version: Some(version),
            scopes,
        };
        let client_id = self.options.actor_id.clone();
        Ok(self.append_commit_locked(&mut state, client_id, vec![change]))
    }

    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.state
            .lock()
            .expect("app test server state")
            .rows
            .get(table)
            .map(|rows| rows.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn row(&self, table: &str, row_id: &str) -> Option<Value> {
        self.state
            .lock()
            .expect("app test server state")
            .rows
            .get(table)
            .and_then(|rows| rows.get(row_id))
            .cloned()
    }

    pub fn requests(&self) -> Vec<CombinedRequest> {
        self.state
            .lock()
            .expect("app test server state")
            .requests
            .clone()
    }

    pub fn ws_pushes(&self) -> Vec<PushCommitRequest> {
        self.state
            .lock()
            .expect("app test server state")
            .ws_pushes
            .clone()
    }

    pub fn commits(&self) -> Vec<AppTestServerCommit> {
        self.state
            .lock()
            .expect("app test server state")
            .commits
            .clone()
    }

    pub fn auth_headers(&self) -> Vec<SyncAuthHeaders> {
        self.state
            .lock()
            .expect("app test server state")
            .auth_headers
            .clone()
    }

    pub fn record_auth_headers(&self, headers: SyncAuthHeaders) {
        self.state
            .lock()
            .expect("app test server state")
            .auth_headers
            .push(headers);
    }

    pub fn is_authorized_headers(&self, headers: &SyncAuthHeaders) -> bool {
        match self.options.required_authorization.as_ref() {
            Some(required) => headers.get("authorization") == Some(required),
            None => true,
        }
    }

    pub fn closed_realtime_count(&self) -> usize {
        self.state
            .lock()
            .expect("app test server state")
            .closed_realtime_count
    }

    pub fn push_realtime_sync(&self) {
        self.state
            .lock()
            .expect("app test server state")
            .realtime_events
            .push_back(RealtimeEvent::Sync);
    }

    pub fn wait_for_commit_count(
        &self,
        expected: usize,
        timeout: Duration,
    ) -> Vec<AppTestServerCommit> {
        let deadline = Instant::now() + timeout;
        loop {
            let commits = self.commits();
            if commits.len() >= expected || Instant::now() >= deadline {
                return commits;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn table_metadata(&self, table: &str) -> Result<&'static AppTableMetadata> {
        self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown app table for AppTestServer: {table}"))
        })
    }

    fn prepare_server_row(
        &self,
        metadata: &AppTableMetadata,
        row_id: &str,
        row: Value,
        server_version: Option<i64>,
    ) -> Result<Value> {
        let Value::Object(mut row) = row else {
            return Err(SyncularError::protocol_message(format!(
                "row for table {} must be an object",
                metadata.name
            )));
        };
        row.insert(
            metadata.primary_key_column.to_string(),
            Value::String(row_id.to_string()),
        );
        let version = server_version
            .or_else(|| {
                row.get(metadata.server_version_column)
                    .and_then(Value::as_i64)
            })
            .unwrap_or(0);
        row.insert(
            metadata.server_version_column.to_string(),
            Value::Number(version.into()),
        );
        Ok(Value::Object(row))
    }

    fn post_sync_locked(
        &self,
        state: &mut AppTestServerState,
        request: &CombinedRequest,
    ) -> Result<CombinedResponse> {
        state.requests.push(request.clone());
        if !self.is_authorized_locked(state) {
            return Err(unauthorized_error());
        }
        let push = request
            .push
            .as_ref()
            .map(|push| {
                let mut commits = Vec::new();
                for commit in &push.commits {
                    commits.push(self.apply_push_commit_locked(
                        state,
                        &request.client_id,
                        commit,
                    )?);
                }
                Ok::<PushBatchResponse, SyncularError>(PushBatchResponse { ok: true, commits })
            })
            .transpose()?;
        let pull = request.pull.as_ref().map(|pull| PullResponse {
            ok: true,
            subscriptions: pull
                .subscriptions
                .iter()
                .map(|subscription| {
                    self.subscription_response_locked(state, subscription, &request.client_id)
                })
                .collect(),
        });
        let required_schema_version = state.required_schema_version;
        let latest_schema_version = state
            .latest_schema_version
            .or(required_schema_version)
            .or(Some(self.app_schema.current_schema_version()));
        Ok(CombinedResponse {
            ok: true,
            required_schema_version,
            latest_schema_version,
            push,
            pull,
        })
    }

    fn apply_push_commit_locked(
        &self,
        state: &mut AppTestServerState,
        client_id: &str,
        commit: &PushCommitRequest,
    ) -> Result<PushCommitResponse> {
        let conflict = commit
            .operations
            .iter()
            .enumerate()
            .find_map(|(index, operation)| {
                self.preflight_operation_conflict(state, index, operation)
            });
        if let Some(response) = conflict {
            return Ok(PushCommitResponse {
                client_commit_id: commit.client_commit_id.clone(),
                status: "rejected".to_string(),
                commit_seq: None,
                results: response,
            });
        }

        let mut changes = Vec::new();
        let mut results = Vec::new();
        for (index, operation) in commit.operations.iter().enumerate() {
            let result = self.apply_operation_locked(state, index, operation, &mut changes)?;
            results.push(result);
        }
        let commit_seq = if changes.is_empty() {
            None
        } else {
            Some(self.append_commit_locked(state, client_id.to_string(), changes))
        };
        Ok(PushCommitResponse {
            client_commit_id: commit.client_commit_id.clone(),
            status: "applied".to_string(),
            commit_seq,
            results,
        })
    }

    fn preflight_operation_conflict(
        &self,
        state: &AppTestServerState,
        index: usize,
        operation: &SyncOperation,
    ) -> Option<Vec<OperationResult>> {
        let metadata = self.app_schema.table_metadata(&operation.table)?;
        if is_server_merge_yjs_operation(operation, metadata) {
            return None;
        }
        let base_version = operation.base_version?;
        let current_row = state
            .rows
            .get(&operation.table)
            .and_then(|rows| rows.get(&operation.row_id));
        let current_version = current_row
            .and_then(|row| row_server_version(metadata, row))
            .unwrap_or(0);
        if current_version == base_version {
            return None;
        }
        Some(vec![OperationResult {
            op_index: index as i32,
            status: "conflict".to_string(),
            message: Some("version conflict".to_string()),
            error: None,
            code: Some("sync.version_conflict".to_string()),
            retriable: Some(false),
            server_version: Some(current_version),
            server_row: current_row.cloned(),
        }])
    }

    fn apply_operation_locked(
        &self,
        state: &mut AppTestServerState,
        index: usize,
        operation: &SyncOperation,
        changes: &mut Vec<SyncChange>,
    ) -> Result<OperationResult> {
        let metadata = self.table_metadata(&operation.table)?;
        match operation.op.as_str() {
            "upsert" => {
                let existing_row = state
                    .rows
                    .get(&operation.table)
                    .and_then(|rows| rows.get(&operation.row_id))
                    .cloned();
                let mut transformed = operation.clone();
                transform_operation_payload_for_metadata(
                    &mut transformed,
                    existing_row.as_ref(),
                    metadata,
                )?;
                let version = next_server_version_locked(state);
                let row = merged_server_row(
                    metadata,
                    &operation.row_id,
                    existing_row,
                    transformed.payload,
                    version,
                )?;
                let scopes = scopes_for_row(metadata, &row);
                let change_row_json = if is_server_merge_yjs_operation(operation, metadata) {
                    operation.payload.clone()
                } else {
                    Some(row.clone())
                };
                state
                    .rows
                    .entry(operation.table.clone())
                    .or_default()
                    .insert(operation.row_id.clone(), row.clone());
                changes.push(SyncChange {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    op: "upsert".to_string(),
                    row_json: change_row_json,
                    row_version: Some(version),
                    scopes,
                });
                Ok(applied_result(index, Some(version)))
            }
            "delete" => {
                let old_row = state
                    .rows
                    .entry(operation.table.clone())
                    .or_default()
                    .remove(&operation.row_id);
                let version = next_server_version_locked(state);
                let scopes = old_row
                    .as_ref()
                    .map(|row| scopes_for_row(metadata, row))
                    .unwrap_or_default();
                changes.push(SyncChange {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    op: "delete".to_string(),
                    row_json: None,
                    row_version: Some(version),
                    scopes,
                });
                Ok(applied_result(index, Some(version)))
            }
            op => Ok(OperationResult {
                op_index: index as i32,
                status: "error".to_string(),
                message: Some(format!("unsupported operation: {op}")),
                error: Some(format!("unsupported operation: {op}")),
                code: Some("sync.unsupported_operation".to_string()),
                retriable: Some(false),
                server_version: None,
                server_row: None,
            }),
        }
    }

    fn subscription_response_locked(
        &self,
        state: &AppTestServerState,
        subscription: &syncular_runtime::protocol::SubscriptionRequest,
        request_client_id: &str,
    ) -> SubscriptionResponse {
        let metadata = self.app_schema.table_metadata(&subscription.table);
        let next_cursor = state.next_commit_seq.saturating_sub(1).max(0);
        if subscription.cursor < 0 {
            let rows = metadata
                .map(|metadata| {
                    state
                        .rows
                        .get(&subscription.table)
                        .into_iter()
                        .flat_map(|rows| rows.values())
                        .filter(|row| row_matches_scopes(metadata, row, &subscription.scopes))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            return SubscriptionResponse {
                id: subscription.id.clone(),
                status: "active".to_string(),
                scopes: subscription.scopes.clone(),
                bootstrap: !rows.is_empty(),
                bootstrap_state: None,
                next_cursor,
                integrity: None,
                commits: Vec::new(),
                snapshots: Some(vec![SyncSnapshot {
                    table: subscription.table.clone(),
                    rows,
                    chunks: None,
                    artifacts: None,
                    manifest: None,
                    is_first_page: true,
                    is_last_page: true,
                    bootstrap_state_after: None,
                }]),
            };
        }

        let mut commits = metadata
            .map(|metadata| {
                state
                    .commits
                    .iter()
                    .filter(|commit| {
                        commit.commit_seq > subscription.cursor
                            && commit.client_id != request_client_id
                    })
                    .filter_map(|commit| {
                        let changes = commit
                            .changes
                            .iter()
                            .filter(|change| {
                                change.table == subscription.table
                                    && change_matches_scopes(metadata, change, &subscription.scopes)
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        if changes.is_empty() {
                            None
                        } else {
                            Some(SyncCommit {
                                commit_seq: commit.commit_seq,
                                created_at: self.created_at(commit.commit_seq),
                                actor_id: self.options.actor_id.clone(),
                                changes,
                            })
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        match self.options.delivery_mode {
            AppTestServerDeliveryMode::Normal => {}
            AppTestServerDeliveryMode::ReverseAndDuplicate => {
                commits.reverse();
                let duplicates = commits.clone();
                commits.extend(duplicates);
            }
        }

        SubscriptionResponse {
            id: subscription.id.clone(),
            status: "active".to_string(),
            scopes: subscription.scopes.clone(),
            bootstrap: false,
            bootstrap_state: None,
            next_cursor,
            integrity: None,
            commits,
            snapshots: None,
        }
    }

    fn append_commit_locked(
        &self,
        state: &mut AppTestServerState,
        client_id: String,
        changes: Vec<SyncChange>,
    ) -> i64 {
        let commit_seq = state.next_commit_seq;
        state.next_commit_seq = state.next_commit_seq.saturating_add(1);
        state.commits.push(AppTestServerCommit {
            commit_seq,
            client_id,
            changes,
        });
        if self.options.emit_realtime_sync {
            state.realtime_events.push_back(RealtimeEvent::Sync);
        }
        commit_seq
    }

    fn created_at(&self, commit_seq: i64) -> String {
        format!("{}.{commit_seq:03}Z", self.options.created_at_prefix)
    }

    fn is_authorized_locked(&self, state: &AppTestServerState) -> bool {
        match self.options.required_authorization.as_ref() {
            Some(required) => {
                state
                    .auth_headers
                    .last()
                    .and_then(|headers| headers.get("authorization"))
                    == Some(required)
            }
            None => true,
        }
    }
}

impl SyncAuthHeaderStore for AppTestServer {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.record_auth_headers(headers);
    }
}

impl SyncTransport for AppTestServer {
    type Realtime = AppTestRealtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let mut state = self.state.lock().expect("app test server state");
        self.post_sync_locked(&mut state, request)
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _chunk: &SnapshotChunkRef,
        _scopes: &Map<String, Value>,
    ) -> Result<SnapshotChunkRows> {
        Ok(SnapshotChunkRows::Json(Vec::new()))
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(AppTestRealtime {
            app_schema: self.app_schema,
            options: self.options.clone(),
            state: self.state.clone(),
        })
    }
}

impl RealtimeTransport for AppTestRealtime {
    fn push_commit(&mut self, commit: PushCommitRequest) -> Result<PushCommitResponse> {
        let server = AppTestServer {
            app_schema: self.app_schema,
            options: self.options.clone(),
            state: self.state.clone(),
        };
        let mut state = self.state.lock().expect("app test server state");
        state.ws_pushes.push(commit.clone());
        let client_id = server.options.actor_id.clone();
        server.apply_push_commit_locked(&mut state, &client_id, &commit)
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        Ok(self
            .state
            .lock()
            .expect("app test server state")
            .realtime_events
            .pop_front())
    }

    fn close(&mut self) {
        self.state
            .lock()
            .expect("app test server state")
            .closed_realtime_count += 1;
    }
}

impl BlobTransport for AppTestServer {
    fn upload_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<()> {
        self.state
            .lock()
            .expect("app test server state")
            .blobs
            .insert(blob.hash.clone(), bytes.to_vec());
        Ok(())
    }

    fn download_blob(&self, blob: &BlobRef) -> Result<Vec<u8>> {
        self.state
            .lock()
            .expect("app test server state")
            .blobs
            .get(&blob.hash)
            .cloned()
            .ok_or_else(|| {
                SyncularError::message(
                    ErrorKind::Transport,
                    format!("app test server blob not found: {}", blob.hash),
                )
            })
    }
}

fn next_server_version_locked(state: &mut AppTestServerState) -> i64 {
    let version = state.next_server_version;
    state.next_server_version = state.next_server_version.saturating_add(1);
    version
}

fn bump_next_server_version_locked(state: &mut AppTestServerState, version: i64) {
    state.next_server_version = state.next_server_version.max(version.saturating_add(1));
}

fn row_id_from_row(metadata: &AppTableMetadata, row: &Value) -> Result<String> {
    row.get(metadata.primary_key_column)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            SyncularError::protocol_message(format!(
                "row for table {} is missing text primary key {}",
                metadata.name, metadata.primary_key_column
            ))
        })
}

fn row_server_version(metadata: &AppTableMetadata, row: &Value) -> Option<i64> {
    row.get(metadata.server_version_column)
        .and_then(Value::as_i64)
}

fn scopes_for_row(metadata: &AppTableMetadata, row: &Value) -> ScopeValues {
    let mut scopes = Map::new();
    for scope in metadata.scopes {
        if let Some(value) = row.get(scope.column) {
            scopes.insert(scope.name.to_string(), value.clone());
        }
    }
    scopes
}

fn row_matches_scopes(metadata: &AppTableMetadata, row: &Value, scopes: &ScopeValues) -> bool {
    metadata.scopes.iter().all(|scope| {
        let Some(expected) = scopes.get(scope.name) else {
            return !scope.required;
        };
        row.get(scope.column) == Some(expected)
    })
}

fn change_matches_scopes(
    metadata: &AppTableMetadata,
    change: &SyncChange,
    scopes: &ScopeValues,
) -> bool {
    if let Some(row) = &change.row_json {
        if row_matches_scopes(metadata, row, scopes) {
            return true;
        }
    }
    metadata.scopes.iter().all(|scope| {
        let Some(expected) = scopes.get(scope.name) else {
            return !scope.required;
        };
        change.scopes.get(scope.name) == Some(expected)
    })
}

fn is_server_merge_yjs_operation(operation: &SyncOperation, metadata: &AppTableMetadata) -> bool {
    let Some(Value::Object(payload)) = &operation.payload else {
        return false;
    };
    let Some(Value::Object(envelope)) = payload.get(YJS_PAYLOAD_KEY) else {
        return false;
    };
    metadata.crdt_yjs_fields.iter().any(|field| {
        (field.sync_mode == "server-merge" || field.sync_mode.is_empty())
            && envelope.contains_key(field.field)
    })
}

fn merged_server_row(
    metadata: &AppTableMetadata,
    row_id: &str,
    existing_row: Option<Value>,
    payload: Option<Value>,
    version: i64,
) -> Result<Value> {
    let mut row = match existing_row {
        Some(Value::Object(row)) => row,
        Some(_) | None => Map::new(),
    };
    if let Some(payload) = payload {
        let Value::Object(payload) = payload else {
            return Err(SyncularError::protocol_message(format!(
                "upsert payload for table {} must be an object",
                metadata.name
            )));
        };
        for (key, value) in payload {
            row.insert(key, value);
        }
    }
    row.insert(
        metadata.primary_key_column.to_string(),
        Value::String(row_id.to_string()),
    );
    row.insert(
        metadata.server_version_column.to_string(),
        Value::Number(version.into()),
    );
    Ok(Value::Object(row))
}

fn applied_result(index: usize, server_version: Option<i64>) -> OperationResult {
    OperationResult {
        op_index: index as i32,
        status: "applied".to_string(),
        message: None,
        error: None,
        code: None,
        retriable: None,
        server_version,
        server_row: None,
    }
}

fn unauthorized_error() -> SyncularError {
    SyncularError::message(
        ErrorKind::Transport,
        "unauthorized: missing or invalid authorization header",
    )
}
