use crate::app_schema::AppSchema;
use crate::binary_snapshot::SnapshotChunkRows;
use crate::client::{
    sync_changed_row_for_change, sync_changed_row_for_local_operation,
    sync_changed_row_for_snapshot, sync_changed_rows_for_cleared_snapshot_chunk_limited,
    SubscriptionSpec, SyncChangedRow,
};
use crate::encrypted_crdt::EncryptedCrdt;
use crate::encryption::{FieldEncryption, FieldEncryptionContext};
use crate::error::{ErrorKind, Result, SyncularError};
use crate::protocol::{
    CombinedRequest, PullRequest, PullResponse, PushBatchRequest, PushCommitRequest, ScopeValues,
    SubscriptionRequest, SyncCommit, SyncOperation, SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
    SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1, SYNC_PACK_ENCODING_BINARY_V1,
    SYNC_PACK_ENCODING_JSON_V1,
};
use crate::runtime_schema::runtime_schema_version;
use crate::store::{next_retry_at, now_ms, ConflictSummary, OutboxCommit, MAX_SYNC_RETRIES};
use crate::transport::web::{
    AsyncSyncTransport, WebRealtimeSocket, WebSyncTransport, WebSyncTransportConfig,
};
use crate::transport::{SyncAuthHeaderStore, SyncAuthHeaders};
use crate::web_store::{AsyncWebStore, WebMemoryStore, WebSubscriptionState};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSyncularClientConfig {
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub pull: WebSyncPullOptions,
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
            limit_commits: 50,
            limit_snapshot_rows: 1000,
            max_snapshot_pages: 4,
            dedupe_rows: None,
            include_snapshot_rows: true,
            collect_changed_rows: true,
            max_snapshot_changed_rows: default_max_snapshot_changed_rows(),
            collect_server_timings: false,
        }
    }
}

fn default_limit_commits() -> i64 {
    50
}

fn default_limit_snapshot_rows() -> i64 {
    1000
}

fn default_max_snapshot_pages() -> i64 {
    4
}

fn default_include_snapshot_rows() -> bool {
    true
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WebSyncResult {
    pub changed_tables: Vec<String>,
    pub changed_rows: Vec<SyncChangedRow>,
    pub changed_rows_truncated: bool,
    pub subscriptions: Vec<WebSubscriptionResult>,
    pub pushed_commits: usize,
    pub timings: WebSyncTimings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WebSyncTimings {
    pub total_ms: f64,
    pub push_ms: f64,
    pub pull_ms: f64,
    pub pull_request_ms: f64,
    pub pull_transform_ms: f64,
    pub snapshot_fetch_ms: f64,
    pub pull_apply_ms: f64,
    pub notify_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSubscriptionResult {
    pub id: String,
    pub table: String,
    pub status: String,
    pub scopes: ScopeValues,
    pub next_cursor: i64,
    pub snapshot_rows: Vec<Value>,
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
    T: AsyncSyncTransport<Realtime = WebRealtimeSocket>,
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
        }
    }

    pub fn set_subscriptions(&mut self, subscriptions: Vec<SubscriptionSpec>) {
        self.subscriptions = subscriptions;
    }

    pub fn subscriptions(&self) -> &[SubscriptionSpec] {
        &self.subscriptions
    }

    pub fn set_field_encryption(&mut self, encryption: Option<FieldEncryption>) {
        self.field_encryption = encryption;
    }

    pub fn set_field_encryption_json(&mut self, config_json: &str) -> Result<()> {
        self.field_encryption = FieldEncryption::from_static_config_json(config_json)?;
        Ok(())
    }

    pub fn set_encrypted_crdt(&mut self, encryption: Option<EncryptedCrdt>) {
        self.encrypted_crdt = encryption;
    }

    pub fn set_encrypted_crdt_json(&mut self, config_json: &str) -> Result<()> {
        self.encrypted_crdt = EncryptedCrdt::from_static_config_json(config_json)?;
        Ok(())
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
        &mut self.store
    }

    pub fn config(&self) -> &WebSyncularClientConfig {
        &self.config
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
        let transform_started_at = timing_now_ms();
        let pull = self.transform_pull_response(pull)?;
        let pull_transform_ms = elapsed_ms_since(transform_started_at);
        if !pull.ok {
            return Err(SyncularError::protocol_message(
                "browser pull response was not ok",
            ));
        }

        let mut result = WebSyncResult::default();
        self.store.begin_apply_batch().await?;
        let apply_started_at = timing_now_ms();
        let apply_result = self.apply_pull_response(pull, &mut result).await;
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
            .notify_tables_changed_with_rows(&result.changed_tables, &result.changed_rows)
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
    ) -> Result<()> {
        let app_schema = self.store.app_schema();
        let include_snapshot_rows = self.config.pull.include_snapshot_rows;
        let collect_changed_rows = self.config.pull.collect_changed_rows;
        let max_snapshot_changed_rows = self.config.pull.max_snapshot_changed_rows;
        let mut snapshot_changed_rows = 0usize;
        for sub in pull.subscriptions {
            let previous_state = self.store.subscription_state(&sub.id).await?;
            let table = self
                .subscriptions
                .iter()
                .find(|candidate| candidate.id == sub.id)
                .map(|spec| spec.table.clone())
                .or_else(|| previous_state.as_ref().map(|state| state.table.clone()))
                .unwrap_or_else(|| sub.id.clone());

            let mut snapshot_rows = Vec::new();
            if let Some(snapshots) = &sub.snapshots {
                let continuing_cleared_snapshot = previous_state.as_ref().is_some_and(|state| {
                    state.bootstrap_state.is_some()
                        && state.scopes == sub.scopes
                        && snapshot_clear_removes_all_rows(app_schema, &table)
                });
                let mut scope_cleared_for_snapshot = continuing_cleared_snapshot;
                for snapshot in snapshots {
                    let snapshot_table = snapshot.table.clone();
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
                    if snapshot.is_first_page || !snapshot.rows.is_empty() || chunk_row_count > 0 {
                        add_changed_table(&mut result.changed_tables, &snapshot_table);
                    }

                    let inline_rows = snapshot.rows.clone();
                    if snapshot.is_first_page {
                        self.store
                            .clear_table_for_scopes_preserving_local_crdt(
                                &snapshot_table,
                                &sub.scopes,
                            )
                            .await?;
                        scope_cleared_for_snapshot = true;
                    }
                    if include_snapshot_rows {
                        snapshot_rows.extend(inline_rows.clone());
                    }
                    if !collect_changed_rows && !include_snapshot_rows {
                        self.store.upsert_rows(&snapshot_table, inline_rows).await?;
                        for rows in chunk_batches {
                            if scope_cleared_for_snapshot {
                                self.store
                                    .insert_cleared_snapshot_chunk_rows(&snapshot_table, rows)
                                    .await?;
                            } else {
                                self.store
                                    .upsert_snapshot_chunk_rows(&snapshot_table, rows)
                                    .await?;
                            }
                        }
                    } else {
                        let mut rows_to_upsert = Vec::with_capacity(inline_rows.len());
                        for row in inline_rows {
                            let previous_row = if scope_cleared_for_snapshot {
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
                        self.store
                            .upsert_rows(&snapshot_table, rows_to_upsert)
                            .await?;

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
                                self.store
                                    .insert_cleared_snapshot_chunk_rows(&snapshot_table, batch)
                                    .await?;
                                continue;
                            }
                            let chunk_rows = batch.try_into_value_rows()?;
                            let mut chunk_rows_to_upsert = Vec::with_capacity(chunk_rows.len());
                            for row in chunk_rows {
                                let previous_row = if scope_cleared_for_snapshot {
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
                            self.store
                                .upsert_rows(&snapshot_table, chunk_rows_to_upsert)
                                .await?;
                        }
                    }
                }
            }
            for commit in &sub.commits {
                for change in &commit.changes {
                    add_changed_table(&mut result.changed_tables, &change.table);
                    let previous_row = self
                        .store
                        .current_row_json(&change.table, &change.row_id)
                        .await?;
                    self.store.apply_change(change.clone()).await?;
                    if collect_changed_rows {
                        if let Some(changed_row) = sync_changed_row_for_change(
                            app_schema,
                            change,
                            previous_row.as_ref(),
                            commit.commit_seq,
                            &sub.id,
                        ) {
                            result.changed_rows.push(changed_row);
                        }
                    }
                }
            }

            if sub.status == "revoked" {
                if let Some(previous_state) = &previous_state {
                    self.store
                        .clear_table_for_scopes(&previous_state.table, &previous_state.scopes)
                        .await?;
                    add_changed_table(&mut result.changed_tables, &previous_state.table);
                }
                self.store.delete_subscription_state(&sub.id).await?;
            } else {
                if let Some(previous_state) = &previous_state {
                    if previous_state.scopes != sub.scopes {
                        self.store
                            .clear_table_for_scopes(&previous_state.table, &previous_state.scopes)
                            .await?;
                        add_changed_table(&mut result.changed_tables, &previous_state.table);
                    }
                }
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

            result.subscriptions.push(WebSubscriptionResult {
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

    pub async fn sync_pull_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.sync_pull().await?)?)
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
                return Err(error);
            }
        };
        if let Err(error) = validate_server_schema_version(
            response.required_schema_version,
            response.latest_schema_version,
        ) {
            self.schedule_outbox_retry(&pending, &error).await?;
            return Err(error);
        }
        if !response.ok {
            let error =
                SyncularError::protocol_message("combined browser push response was not ok");
            self.schedule_outbox_retry(&pending, &error).await?;
            return Err(error);
        }

        let mut pushed_commits = 0usize;
        if let Some(push) = response.push {
            if !push.ok {
                let error = SyncularError::protocol_message("browser push response was not ok");
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
        let sending = self.store.sending_outbox(20).await?;
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

    pub async fn apply_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let operation: SyncOperation = serde_json::from_str(operation_json)?;
        let changed_tables = vec![operation.table.clone()];
        let previous_row = self
            .store
            .current_row_json(&operation.table, &operation.row_id)
            .await?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        let client_commit_id = self
            .store
            .apply_local_operation(operation.clone(), local_row.clone())
            .await?;
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

    pub fn connect_realtime(&self) -> Result<WebRealtimeSocket> {
        self.transport.connect_realtime()
    }

    pub fn send_push_commit_json(
        &self,
        socket: &WebRealtimeSocket,
        commit_json: &str,
    ) -> Result<String> {
        let operation: SyncOperation = serde_json::from_str(commit_json)?;
        let operations = if let Some(encryption) = &self.field_encryption {
            encryption.transform_operations_for_push(&self.encryption_context(), vec![operation])?
        } else {
            vec![operation]
        };
        socket.send_push_commit(crate::protocol::PushCommitRequest {
            client_commit_id: uuid::Uuid::new_v4().to_string(),
            operations,
            schema_version: runtime_schema_version(),
        })
    }

    async fn build_pull_request(&mut self) -> Result<PullRequest> {
        let mut subscriptions = Vec::new();
        for spec in &self.subscriptions {
            let state = self.store.subscription_state(&spec.id).await?;
            let scopes_changed = state
                .as_ref()
                .is_some_and(|state| state.scopes != spec.scopes);
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
            });
        }

        Ok(PullRequest {
            limit_commits: self.config.pull.limit_commits,
            limit_snapshot_rows: self.config.pull.limit_snapshot_rows,
            max_snapshot_pages: self.config.pull.max_snapshot_pages,
            dedupe_rows: self.config.pull.dedupe_rows,
            snapshot_encodings: vec![
                SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1.to_string(),
                SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1.to_string(),
            ],
            sync_pack_encodings: vec![
                SYNC_PACK_ENCODING_BINARY_V1.to_string(),
                SYNC_PACK_ENCODING_JSON_V1.to_string(),
            ],
            subscriptions,
        })
    }

    async fn prepare_push(&mut self) -> Result<Vec<OutboxCommit>> {
        self.store.requeue_stale_outbox().await?;
        let pending = self.store.pending_outbox(20).await?;
        for commit in &pending {
            validate_outbox_schema_version(commit)?;
        }
        for commit in &pending {
            self.store.mark_outbox_sending(&commit.id).await?;
        }
        Ok(pending)
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

impl<T, S> WebSyncularClient<T, S>
where
    T: AsyncSyncTransport<Realtime = WebRealtimeSocket> + SyncAuthHeaderStore,
    S: AsyncWebStore,
{
    pub fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.transport.set_auth_headers(headers);
    }
}

fn validate_server_schema_version(
    required_schema_version: Option<i32>,
    latest_schema_version: Option<i32>,
) -> Result<()> {
    let current = runtime_schema_version();

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

fn validate_outbox_schema_version(commit: &OutboxCommit) -> Result<()> {
    if commit.schema_version < 1 {
        return Err(SyncularError::schema(format!(
            "web outbox commit {} has invalid schema version {}",
            commit.client_commit_id, commit.schema_version
        )));
    }

    let current = runtime_schema_version();
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
        CombinedResponse, PullResponse, SnapshotChunkRef, SubscriptionResponse, SyncSnapshot,
    };
    use crate::transport::web::WebRealtimeSocket;
    use serde_json::{json, Map, Value};
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

    #[test]
    fn pull_fetches_snapshot_chunks_before_mutating_store() -> Result<()> {
        let mut store = WebMemoryStore::new();
        block_on(store.upsert_row("tasks", task_row("existing-task", "p0")))?;
        let transport = FailingChunkTransport;
        let config = WebSyncularClientConfig {
            base_url: "http://syncular.test/sync".to_string(),
            client_id: "web-client-chunk-failure".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("p0".to_string()),
        };
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

    struct FailingChunkTransport;

    impl AsyncSyncTransport for FailingChunkTransport {
        type Realtime = WebRealtimeSocket;

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
                            commits: Vec::new(),
                            snapshots: Some(vec![SyncSnapshot {
                                table: "tasks".to_string(),
                                rows: vec![task_row("incoming-inline-task", "p0")],
                                chunks: Some(vec![SnapshotChunkRef {
                                    id: "missing-chunk".to_string(),
                                    byte_length: 1,
                                    sha256: "unused".to_string(),
                                    encoding: "json-row-frame-v1".to_string(),
                                    compression: "gzip".to_string(),
                                    body: None,
                                }]),
                                is_first_page: true,
                                is_last_page: true,
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

        fn connect_realtime(&self) -> Result<Self::Realtime> {
            panic!("realtime not used in this test")
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
