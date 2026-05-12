use crate::client::{SyncReport, SyncularClient, SyncularClientConfig};
use crate::diesel_sqlite::DieselSqliteStore;
use crate::encrypted_crdt::{EncryptedCrdt, CRDT_CHECKPOINTS_TABLE, CRDT_UPDATES_TABLE};
use crate::encryption::{encryption_helpers_json, FieldEncryption};
use crate::error::{ErrorKind, Result, SyncularError};
use crate::generated::{APP_TABLES, APP_TABLE_METADATA};
use crate::migrations::current_schema_version;
use crate::protocol::BlobRef;
use crate::sqlite_query::execute_readonly_query_json;
use crate::store::{now_ms, ConflictSummary, OutboxSummary};
use crate::transport::{HttpSyncTransport, SyncAuthHeaders};
use crate::worker::{SyncWorker, SyncWorkerEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeClientConfig {
    pub db_path: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NativeClientOptions {
    pub auto_sync_local_writes: bool,
}

impl Default for NativeClientOptions {
    fn default() -> Self {
        Self {
            auto_sync_local_writes: true,
        }
    }
}

pub struct NativeSyncularClient {
    config: SyncularClientConfig,
    writer: SyncularClient<DieselSqliteStore, HttpSyncTransport>,
    worker: Option<SyncWorker>,
    auth_headers: SyncAuthHeaders,
    field_encryption: Option<FieldEncryption>,
    encrypted_crdt: Option<EncryptedCrdt>,
    auto_sync_local_writes: bool,
    command_seq: Mutex<u64>,
    event_seq: Mutex<u64>,
    pending_events: Mutex<VecDeque<NativeEvent>>,
    query_observers: Mutex<BTreeMap<String, NativeObservedQuery>>,
}

pub const NATIVE_FFI_ABI_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct NativeRuntimeManifest {
    pub ffi_abi_version: u32,
    pub crate_name: &'static str,
    pub crate_version: &'static str,
    pub schema_version: i32,
    pub storage_backend: &'static str,
    pub transport_backends: &'static [&'static str],
    pub worker_model: &'static str,
    pub string_encoding: &'static str,
    pub error_shape: &'static str,
    pub event_model: &'static str,
    pub capabilities: &'static [&'static str],
    pub app_tables: &'static [&'static str],
    pub app_table_metadata: &'static [crate::generated::AppTableMetadata],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NativeEventKind {
    SyncStarted,
    SyncCompleted,
    SyncFailed,
    AuthExpired,
    LocalWriteCommitted,
    LocalWriteFailed,
    ConflictResolutionCompleted,
    ConflictResolutionFailed,
    SnapshotReady,
    WorkerCommandCompleted,
    WorkerCommandFailed,
    RowsChanged,
    QueriesChanged,
    ConflictsChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeErrorInfo {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeEvent {
    #[serde(default)]
    pub event_seq: u64,
    pub kind: NativeEventKind,
    pub error: Option<NativeErrorInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_commit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbox_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_scheduled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<NativeAuthInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<NativeDiagnostic>,
    pub tables: Vec<String>,
    #[serde(default)]
    pub queries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_json: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeDiagnostic {
    pub at: i64,
    pub level: String,
    pub source: String,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeAuthInfo {
    pub operation: String,
    pub status: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeObservedQuery {
    pub id: String,
    pub tables: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct NativeObservedQueryRegistration {
    #[serde(default)]
    id: Option<String>,
    tables: Vec<String>,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeEncryptedCrdtRequest {
    table: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBlobStoreOptions {
    pub mime_type: Option<String>,
    pub immediate: Option<bool>,
    pub cache_local: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBlobRetrieveOptions {
    pub cache_local: Option<bool>,
}

pub fn native_runtime_manifest() -> NativeRuntimeManifest {
    NativeRuntimeManifest {
        ffi_abi_version: NATIVE_FFI_ABI_VERSION,
        crate_name: env!("CARGO_PKG_NAME"),
        crate_version: env!("CARGO_PKG_VERSION"),
        schema_version: current_schema_version(),
        storage_backend: "diesel-sqlite",
        transport_backends: &["http", "websocket"],
        worker_model: "background-sync-worker",
        string_encoding: "utf-8-json",
        error_shape: "native-error-info-v1",
        event_model: "poll-json-v1",
        capabilities: &[
            "dynamic-auth-headers",
            "auth-expired-events",
            "generated-app-table-metadata",
            "generated-json-table-reads",
            "generated-json-local-operations",
            "generated-json-mutations",
            "queued-json-local-operations",
            "queued-yjs-updates",
            "queued-snapshot-refresh",
            "queued-storage-compaction",
            "queued-blob-cache-work",
            "worker-command-queue",
            "ordered-native-events",
            "read-only-query-json",
            "outbox-json",
            "conflicts-json",
            "table-level-rows-changed-events",
            "query-observer-events",
            "conflicts-changed-events",
            "blob-file-api",
            "background-worker-lifecycle",
            "structured-diagnostics",
            "storage-compaction",
            "streaming-blob-file-api",
            "crdt-yjs",
            "field-encryption",
            "encrypted-crdt",
            "queued-encrypted-crdt",
            "encryption-key-sharing",
        ],
        app_tables: APP_TABLES,
        app_table_metadata: APP_TABLE_METADATA,
    }
}

pub fn native_runtime_manifest_json() -> Result<String> {
    Ok(serde_json::to_string(&native_runtime_manifest())?)
}

impl NativeSyncularClient {
    pub fn open(config: SyncularClientConfig) -> Result<Self> {
        Self::open_with_options(config, NativeClientOptions::default())
    }

    pub fn open_native(config: NativeClientConfig) -> Result<Self> {
        Self::open(config.into())
    }

    pub fn open_native_with_options(
        config: NativeClientConfig,
        options: NativeClientOptions,
    ) -> Result<Self> {
        Self::open_with_options(config.into(), options)
    }

    pub fn open_with_options(
        config: SyncularClientConfig,
        options: NativeClientOptions,
    ) -> Result<Self> {
        let writer_store = DieselSqliteStore::open(&config.db_path)?;
        let worker_store = DieselSqliteStore::open(&config.db_path)?;
        let writer = SyncularClient::with_store(config.clone(), writer_store);
        let worker_client = SyncularClient::with_store(config.clone(), worker_store);

        Ok(Self {
            config,
            writer,
            worker: Some(SyncWorker::start(worker_client)),
            auth_headers: SyncAuthHeaders::new(),
            field_encryption: None,
            encrypted_crdt: None,
            auto_sync_local_writes: options.auto_sync_local_writes,
            command_seq: Mutex::new(0),
            event_seq: Mutex::new(0),
            pending_events: Mutex::new(VecDeque::new()),
            query_observers: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn trigger_sync(&self) -> Result<()> {
        self.worker()?.trigger_sync()
    }

    pub fn enqueue_sync_now(&self) -> Result<String> {
        let command_id = self.next_command_id("sync")?;
        self.worker()?.enqueue_sync_now(command_id.clone())?;
        Ok(command_id)
    }

    pub fn enqueue_local_operation_json(
        &self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let command_id = self.next_command_id("local-write")?;
        self.worker()?.enqueue_local_operation_json(
            command_id.clone(),
            operation_json.to_string(),
            local_row_json.map(str::to_string),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        self.enqueue_local_operation_json(mutation_json, local_row_json)
    }

    pub fn enqueue_yjs_update_json(&self, update_json: &str) -> Result<String> {
        let command_id = self.next_command_id("yjs")?;
        self.worker()?.enqueue_yjs_update_json(
            command_id.clone(),
            update_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_encrypted_crdt_update_json(&self, request_json: &str) -> Result<String> {
        let command_id = self.next_command_id("encrypted-crdt")?;
        self.worker()?.enqueue_encrypted_crdt_update_json(
            command_id.clone(),
            request_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_encrypted_crdt_checkpoint_json(&self, request_json: &str) -> Result<String> {
        let command_id = self.next_command_id("encrypted-crdt-checkpoint")?;
        self.worker()?.enqueue_encrypted_crdt_checkpoint_json(
            command_id.clone(),
            request_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_resolve_conflict(&self, id: &str, resolution: &str) -> Result<String> {
        let command_id = self.next_command_id("conflict")?;
        self.worker()?.enqueue_conflict_resolution(
            command_id.clone(),
            id.to_string(),
            resolution.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_refresh_snapshot_json(&self, request_json: &str) -> Result<String> {
        let command_id = self.next_command_id("snapshot")?;
        self.worker()?
            .enqueue_refresh_snapshot_json(command_id.clone(), request_json.to_string())?;
        Ok(command_id)
    }

    pub fn enqueue_compact_storage_json(&self, options_json: Option<&str>) -> Result<String> {
        let command_id = self.next_command_id("compact")?;
        self.worker()?
            .enqueue_compact_storage_json(command_id.clone(), options_json.map(str::to_string))?;
        Ok(command_id)
    }

    pub fn enqueue_store_blob_file_json(
        &self,
        path: &str,
        options_json: Option<&str>,
    ) -> Result<String> {
        let command_id = self.next_command_id("blob-store")?;
        self.worker()?.enqueue_store_blob_file_json(
            command_id.clone(),
            path.to_string(),
            options_json.map(str::to_string),
        )?;
        Ok(command_id)
    }

    pub fn enqueue_retrieve_blob_file_json(
        &self,
        ref_json: &str,
        path: &str,
        options_json: Option<&str>,
    ) -> Result<String> {
        let command_id = self.next_command_id("blob-retrieve")?;
        self.worker()?.enqueue_retrieve_blob_file_json(
            command_id.clone(),
            ref_json.to_string(),
            path.to_string(),
            options_json.map(str::to_string),
        )?;
        Ok(command_id)
    }

    pub fn enqueue_prune_blob_cache(&self, max_bytes: i64) -> Result<String> {
        let command_id = self.next_command_id("blob-prune")?;
        self.worker()?
            .enqueue_prune_blob_cache(command_id.clone(), max_bytes)?;
        Ok(command_id)
    }

    pub fn enqueue_clear_blob_cache(&self) -> Result<String> {
        let command_id = self.next_command_id("blob-clear")?;
        self.worker()?
            .enqueue_clear_blob_cache(command_id.clone())?;
        Ok(command_id)
    }

    pub fn set_auth_headers(&mut self, headers: SyncAuthHeaders) -> Result<()> {
        self.auth_headers = headers.clone();
        self.writer.set_auth_headers(headers.clone());
        if let Some(worker) = &self.worker {
            worker.set_auth_headers(headers)?;
        }
        Ok(())
    }

    pub fn set_auth_headers_json(&mut self, headers_json: &str) -> Result<()> {
        let headers: SyncAuthHeaders = serde_json::from_str(headers_json)?;
        self.set_auth_headers(headers)
    }

    pub fn set_field_encryption(&mut self, encryption: Option<FieldEncryption>) -> Result<()> {
        self.field_encryption = encryption.clone();
        self.writer.set_field_encryption(encryption.clone());
        if let Some(worker) = &self.worker {
            worker.set_field_encryption(encryption)?;
        }
        Ok(())
    }

    pub fn set_field_encryption_json(&mut self, config_json: &str) -> Result<()> {
        self.set_field_encryption(FieldEncryption::from_static_config_json(config_json)?)
    }

    pub fn set_encrypted_crdt(&mut self, encryption: Option<EncryptedCrdt>) -> Result<()> {
        self.encrypted_crdt = encryption.clone();
        self.writer.set_encrypted_crdt(encryption.clone());
        if let Some(worker) = &self.worker {
            worker.set_encrypted_crdt(encryption)?;
        }
        Ok(())
    }

    pub fn set_encrypted_crdt_json(&mut self, config_json: &str) -> Result<()> {
        self.set_encrypted_crdt(EncryptedCrdt::from_static_config_json(config_json)?)
    }

    pub fn encryption_helper_json(&self, method: &str, args_json: &str) -> Result<String> {
        encryption_helpers_json(method, args_json)
    }

    pub fn pause_sync_worker(&mut self) -> Result<()> {
        if let Some(worker) = self.worker.take() {
            worker.stop()?;
        }
        Ok(())
    }

    pub fn resume_sync_worker(&mut self) -> Result<()> {
        if self.worker.is_some() {
            return Ok(());
        }
        let worker_store = DieselSqliteStore::open(&self.config.db_path)?;
        let mut worker_client = SyncularClient::with_store(self.config.clone(), worker_store);
        worker_client.set_auth_headers(self.auth_headers.clone());
        worker_client.set_field_encryption(self.field_encryption.clone());
        worker_client.set_encrypted_crdt(self.encrypted_crdt.clone());
        self.worker = Some(SyncWorker::start(worker_client));
        Ok(())
    }

    pub fn sync_worker_running(&self) -> bool {
        self.worker.is_some()
    }

    pub fn recv_sync_result_timeout(&self, timeout: Duration) -> Option<Result<SyncReport>> {
        self.worker
            .as_ref()
            .and_then(|worker| worker.recv_result_timeout(timeout))
    }

    pub fn poll_event_timeout(&self, timeout: Duration) -> Option<NativeEvent> {
        if let Some(event) = self.pop_pending_event() {
            return Some(event);
        }

        let worker_event = self
            .worker
            .as_ref()
            .and_then(|worker| worker.recv_event_timeout(timeout))?;
        let mut events = self.events_from_worker_event(worker_event);
        if events.is_empty() {
            return None;
        }
        let first = self.stamp_event(events.remove(0));
        for event in events {
            self.push_pending_event(event);
        }
        Some(first)
    }

    pub fn poll_event_json_timeout(&self, timeout: Duration) -> Option<Result<String>> {
        self.poll_event_timeout(timeout)
            .map(|event| serde_json::to_string(&event).map_err(Into::into))
    }

    pub fn apply_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let operation: crate::protocol::SyncOperation = serde_json::from_str(operation_json)?;
        let table = operation.table.clone();
        let client_commit_id = self
            .writer
            .apply_local_operation_json(operation_json, local_row_json)?;
        self.push_rows_changed_events([table.as_str()]);
        self.trigger_after_local_write()?;
        Ok(client_commit_id)
    }

    pub fn apply_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        self.apply_local_operation_json(mutation_json, local_row_json)
    }

    pub fn apply_encrypted_crdt_update_json(&mut self, request_json: &str) -> Result<String> {
        let request: NativeEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let receipt = self.writer.apply_encrypted_crdt_update_json(request_json)?;
        self.push_rows_changed_events([request.table.as_str(), CRDT_UPDATES_TABLE]);
        self.trigger_after_local_write()?;
        Ok(receipt.client_commit_id)
    }

    pub fn apply_encrypted_crdt_checkpoint_json(&mut self, request_json: &str) -> Result<String> {
        let _request: NativeEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let receipt = self
            .writer
            .apply_encrypted_crdt_checkpoint_json(request_json)?;
        if let Some(receipt) = receipt {
            self.push_rows_changed_events([CRDT_CHECKPOINTS_TABLE]);
            self.trigger_after_local_write()?;
            Ok(serde_json::to_string(&json!({
                "checkpointed": true,
                "clientCommitId": receipt.client_commit_id,
                "commitId": receipt.commit_id
            }))?)
        } else {
            Ok(serde_json::to_string(&json!({ "checkpointed": false }))?)
        }
    }

    pub fn list_table_json(&mut self, table: &str) -> Result<String> {
        self.writer.list_table_json(table)
    }

    pub fn query_json(&self, request_json: &str) -> Result<String> {
        execute_readonly_query_json(&self.config.db_path, request_json)
    }

    pub fn store_blob_file_json(
        &mut self,
        path: &str,
        options_json: Option<&str>,
    ) -> Result<String> {
        let options: NativeBlobStoreOptions = options_json
            .filter(|value| !value.trim().is_empty())
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        let blob = self.writer.store_blob_file(
            Path::new(path),
            options
                .mime_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
            options.immediate.unwrap_or(false),
            options.cache_local.unwrap_or(true),
        )?;
        Ok(serde_json::to_string(&blob)?)
    }

    pub fn retrieve_blob_file(&mut self, ref_json: &str, path: &str) -> Result<()> {
        self.retrieve_blob_file_with_options(ref_json, path, None)
    }

    pub fn retrieve_blob_file_with_options(
        &mut self,
        ref_json: &str,
        path: &str,
        options_json: Option<&str>,
    ) -> Result<()> {
        let options: NativeBlobRetrieveOptions = options_json
            .filter(|value| !value.trim().is_empty())
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        let blob: BlobRef = serde_json::from_str(ref_json)?;
        self.writer
            .retrieve_blob_file(&blob, Path::new(path), options.cache_local.unwrap_or(true))
    }

    pub fn is_blob_local(&mut self, hash: &str) -> Result<bool> {
        self.writer.is_blob_local(hash)
    }

    pub fn process_blob_upload_queue_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(
            &self.writer.process_blob_upload_queue()?,
        )?)
    }

    pub fn blob_upload_queue_stats_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(
            &self.writer.blob_upload_queue_stats()?,
        )?)
    }

    pub fn blob_cache_stats_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.writer.blob_cache_stats()?)?)
    }

    pub fn prune_blob_cache(&mut self, max_bytes: i64) -> Result<i64> {
        self.writer.prune_blob_cache(max_bytes)
    }

    pub fn clear_blob_cache(&mut self) -> Result<()> {
        self.writer.clear_blob_cache()
    }

    pub fn compact_storage_json(&mut self, options_json: Option<&str>) -> Result<String> {
        self.writer.compact_storage_json(options_json)
    }

    pub fn app_tables(&self) -> Vec<String> {
        APP_TABLE_METADATA
            .iter()
            .map(|metadata| metadata.name.to_string())
            .collect()
    }

    pub fn app_tables_json(&self) -> Result<String> {
        Ok(serde_json::to_string(APP_TABLES)?)
    }

    pub fn app_table_metadata_json(&self) -> Result<String> {
        Ok(serde_json::to_string(APP_TABLE_METADATA)?)
    }

    pub fn register_query_json(&self, query_json: &str) -> Result<String> {
        let registration: NativeObservedQueryRegistration = serde_json::from_str(query_json)?;
        let observed_query = registration.into_observed_query()?;
        let id = observed_query.id.clone();
        let mut observers = self.query_observers.lock().map_err(|_| {
            SyncularError::message(
                ErrorKind::Internal,
                "native query observer registry is poisoned",
            )
        })?;
        observers.insert(id.clone(), observed_query);
        Ok(id)
    }

    pub fn unregister_query(&self, id: &str) -> Result<()> {
        let mut observers = self.query_observers.lock().map_err(|_| {
            SyncularError::message(
                ErrorKind::Internal,
                "native query observer registry is poisoned",
            )
        })?;
        observers.remove(id);
        Ok(())
    }

    pub fn observed_queries(&self) -> Result<Vec<NativeObservedQuery>> {
        let observers = self.query_observers.lock().map_err(|_| {
            SyncularError::message(
                ErrorKind::Internal,
                "native query observer registry is poisoned",
            )
        })?;
        Ok(observers.values().cloned().collect())
    }

    pub fn observed_queries_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.observed_queries()?)?)
    }

    pub fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>> {
        self.writer.outbox_summaries()
    }

    pub fn outbox_summaries_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.outbox_summaries()?)?)
    }

    pub fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>> {
        self.writer.conflict_summaries()
    }

    pub fn conflict_summaries_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.conflict_summaries()?)?)
    }

    pub fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()> {
        self.writer.resolve_conflict(id, resolution)?;
        self.push_pending_event(conflicts_changed_event());
        Ok(())
    }

    pub fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String> {
        let client_commit_id = self.writer.retry_conflict_keep_local(id)?;
        self.push_pending_event(conflicts_changed_event());
        self.trigger_after_local_write()?;
        Ok(client_commit_id)
    }

    pub fn close(&mut self) -> Result<()> {
        if let Some(worker) = self.worker.take() {
            worker.stop()?;
        }
        Ok(())
    }

    fn trigger_after_local_write(&self) -> Result<()> {
        if self.auto_sync_local_writes && self.worker.is_some() {
            self.trigger_sync()
                .map_err(|err| err.context("local write succeeded but sync trigger failed"))?;
        }
        Ok(())
    }

    fn next_command_id(&self, prefix: &str) -> Result<String> {
        let mut seq = self.command_seq.lock().map_err(|_| {
            SyncularError::message(ErrorKind::Internal, "native command sequence is poisoned")
        })?;
        *seq = seq.saturating_add(1);
        Ok(format!("native-{prefix}-{seq}"))
    }

    fn worker(&self) -> Result<&SyncWorker> {
        self.worker.as_ref().ok_or_else(|| {
            SyncularError::message(ErrorKind::Internal, "native sync client is closed")
        })
    }

    fn push_pending_event(&self, event: NativeEvent) {
        if let Ok(mut pending) = self.pending_events.lock() {
            pending.push_back(self.stamp_event(event));
        }
    }

    fn push_rows_changed_events<'a>(&self, tables: impl IntoIterator<Item = &'a str>) {
        let tables = unique_event_tables(tables);
        if tables.is_empty() {
            return;
        }

        self.push_pending_event(rows_changed_event(tables.iter().map(String::as_str)));
        let queries = self.changed_query_ids(&tables);
        if !queries.is_empty() {
            self.push_pending_event(queries_changed_event(&tables, queries));
        }
    }

    fn changed_query_ids(&self, tables: &[String]) -> Vec<String> {
        let changed = tables.iter().map(String::as_str).collect::<BTreeSet<_>>();
        let Ok(observers) = self.query_observers.lock() else {
            return Vec::new();
        };

        observers
            .values()
            .filter(|query| {
                query
                    .tables
                    .iter()
                    .any(|table| changed.contains(table.as_str()))
            })
            .map(|query| query.id.clone())
            .collect()
    }

    fn pop_pending_event(&self) -> Option<NativeEvent> {
        self.pending_events
            .lock()
            .ok()
            .and_then(|mut pending| pending.pop_front())
    }

    fn stamp_event(&self, mut event: NativeEvent) -> NativeEvent {
        if let Ok(mut seq) = self.event_seq.lock() {
            *seq = seq.saturating_add(1);
            event.event_seq = *seq;
        }
        event
    }

    fn events_from_worker_event(&self, event: SyncWorkerEvent) -> Vec<NativeEvent> {
        match event {
            SyncWorkerEvent::SyncStarted { command_id } => {
                vec![sync_started_event(command_id)]
            }
            SyncWorkerEvent::SyncCompleted {
                command_id,
                report,
                outbox_count,
                conflict_count,
                duration_ms,
            } => {
                let mut events = vec![sync_completed_event(
                    report.clone(),
                    command_id,
                    outbox_count,
                    conflict_count,
                    duration_ms,
                )];
                if !report.changed_tables.is_empty() {
                    events.push(rows_changed_event(
                        report.changed_tables.iter().map(String::as_str),
                    ));
                    let queries = self.changed_query_ids(&report.changed_tables);
                    if !queries.is_empty() {
                        events.push(queries_changed_event(&report.changed_tables, queries));
                    }
                }
                if report.conflicts_changed {
                    events.push(conflicts_changed_event());
                }
                events
            }
            SyncWorkerEvent::SyncFailed {
                command_id,
                error,
                retry_scheduled,
                duration_ms,
            } => vec![sync_failed_event(
                &error,
                command_id,
                retry_scheduled,
                duration_ms,
            )],
            SyncWorkerEvent::LocalWriteCommitted {
                command_id,
                client_commit_id,
                changed_tables,
                duration_ms,
            } => {
                let mut events = vec![local_write_committed_event(
                    command_id,
                    client_commit_id,
                    changed_tables.clone(),
                    duration_ms,
                )];
                if !changed_tables.is_empty() {
                    events.push(rows_changed_event(
                        changed_tables.iter().map(String::as_str),
                    ));
                    let queries = self.changed_query_ids(&changed_tables);
                    if !queries.is_empty() {
                        events.push(queries_changed_event(&changed_tables, queries));
                    }
                }
                events
            }
            SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                duration_ms,
            } => vec![local_write_failed_event(&error, command_id, duration_ms)],
            SyncWorkerEvent::ConflictResolutionCompleted {
                command_id,
                retry_client_commit_id,
                duration_ms,
            } => vec![
                conflict_resolution_completed_event(
                    command_id,
                    retry_client_commit_id,
                    duration_ms,
                ),
                conflicts_changed_event(),
            ],
            SyncWorkerEvent::ConflictResolutionFailed {
                command_id,
                error,
                duration_ms,
            } => vec![conflict_resolution_failed_event(
                &error,
                command_id,
                duration_ms,
            )],
            SyncWorkerEvent::SnapshotReady {
                command_id,
                payload_json,
                duration_ms,
            } => vec![snapshot_ready_event(command_id, payload_json, duration_ms)],
            SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation,
                payload_json,
                duration_ms,
            } => vec![worker_command_completed_event(
                command_id,
                operation,
                payload_json,
                duration_ms,
            )],
            SyncWorkerEvent::WorkerCommandFailed {
                command_id,
                operation,
                error,
                duration_ms,
            } => vec![worker_command_failed_event(
                &error,
                command_id,
                operation,
                duration_ms,
            )],
        }
    }
}

impl NativeObservedQueryRegistration {
    fn into_observed_query(self) -> Result<NativeObservedQuery> {
        let id = match self.id {
            Some(id) => {
                let id = id.trim();
                if id.is_empty() {
                    return Err(SyncularError::config("native observed query id is empty"));
                }
                id.to_string()
            }
            None => format!("native-query-{}", Uuid::new_v4()),
        };

        Ok(NativeObservedQuery {
            id,
            tables: normalize_observed_tables(self.tables)?,
            label: self.label,
        })
    }
}

impl NativeErrorInfo {
    pub fn from_error(error: &SyncularError) -> Self {
        Self {
            kind: error.kind(),
            message: error.message_text(),
            debug: Some(error.debug_text()),
        }
    }
}

impl From<NativeClientConfig> for SyncularClientConfig {
    fn from(config: NativeClientConfig) -> Self {
        Self {
            db_path: config.db_path,
            base_url: config.base_url,
            client_id: config.client_id,
            actor_id: config.actor_id,
            project_id: config.project_id,
        }
    }
}

fn rows_changed_event<'a>(tables: impl IntoIterator<Item = &'a str>) -> NativeEvent {
    let tables = tables.into_iter().map(str::to_string).collect::<Vec<_>>();
    native_event(
        NativeEventKind::RowsChanged,
        tables.clone(),
        Some(native_diagnostic(
            "info",
            "storage",
            "storage.rows_changed",
            "Native Syncular rows changed",
            [("tables", json!(tables))],
        )),
    )
}

fn queries_changed_event(tables: &[String], queries: Vec<String>) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::QueriesChanged,
        tables.to_vec(),
        Some(native_diagnostic(
            "info",
            "storage",
            "storage.queries_changed",
            "Native Syncular observed queries changed",
            [
                ("tables", json!(tables)),
                ("queries", json!(queries.clone())),
            ],
        )),
    );
    event.queries = queries;
    event
}

fn conflicts_changed_event() -> NativeEvent {
    native_event(
        NativeEventKind::ConflictsChanged,
        Vec::new(),
        Some(native_diagnostic(
            "warn",
            "sync",
            "sync.conflicts_changed",
            "Native Syncular conflicts changed",
            std::iter::empty::<(&str, Value)>(),
        )),
    )
}

fn sync_started_event(command_id: Option<String>) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::SyncStarted,
        Vec::new(),
        Some(native_diagnostic(
            "info",
            "sync",
            "sync.started",
            "Native Syncular sync started",
            std::iter::empty::<(&str, Value)>(),
        )),
    );
    event.command_id = command_id;
    event
}

fn sync_completed_event(
    report: SyncReport,
    command_id: Option<String>,
    outbox_count: usize,
    conflict_count: usize,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::SyncCompleted,
        report.changed_tables.clone(),
        Some(native_diagnostic(
            "info",
            "sync",
            "sync.completed",
            "Native Syncular sync completed",
            [
                ("changedTables", json!(report.changed_tables.clone())),
                ("changedTableCount", json!(report.changed_tables.len())),
                ("conflictsChanged", json!(report.conflicts_changed)),
                ("outboxCount", json!(outbox_count)),
                ("conflictCount", json!(conflict_count)),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = command_id;
    event.outbox_count = Some(outbox_count);
    event.conflict_count = Some(conflict_count);
    event.duration_ms = Some(duration_ms);
    event
}

fn sync_failed_event(
    error: &SyncularError,
    command_id: Option<String>,
    retry_scheduled: bool,
    duration_ms: u64,
) -> NativeEvent {
    match native_auth_info_from_error(error) {
        Some(auth) => {
            let operation = auth.operation.clone();
            let status = auth.status;
            let mut event = native_event(
                NativeEventKind::AuthExpired,
                Vec::new(),
                Some(native_diagnostic(
                    "warn",
                    "auth",
                    "auth.expired",
                    "Native Syncular auth expired",
                    [
                        ("operation", json!(operation)),
                        ("status", json!(status)),
                        ("retryScheduled", json!(retry_scheduled)),
                        ("durationMs", json!(duration_ms)),
                    ],
                )),
            );
            event.error = Some(NativeErrorInfo::from_error(error));
            event.auth = Some(auth);
            event.command_id = command_id;
            event.retry_scheduled = Some(retry_scheduled);
            event.duration_ms = Some(duration_ms);
            event
        }
        None => {
            let mut event = native_event(
                NativeEventKind::SyncFailed,
                Vec::new(),
                Some(native_diagnostic(
                    "error",
                    "sync",
                    "sync.failed",
                    "Native Syncular sync failed",
                    [
                        ("errorKind", json!(format!("{:?}", error.kind()))),
                        ("retryScheduled", json!(retry_scheduled)),
                        ("durationMs", json!(duration_ms)),
                    ],
                )),
            );
            event.error = Some(NativeErrorInfo::from_error(error));
            event.command_id = command_id;
            event.retry_scheduled = Some(retry_scheduled);
            event.duration_ms = Some(duration_ms);
            event
        }
    }
}

fn local_write_committed_event(
    command_id: String,
    client_commit_id: String,
    changed_tables: Vec<String>,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::LocalWriteCommitted,
        changed_tables.clone(),
        Some(native_diagnostic(
            "info",
            "storage",
            "storage.local_write_committed",
            "Native Syncular local write committed",
            [
                ("commandId", json!(command_id.clone())),
                ("clientCommitId", json!(client_commit_id.clone())),
                ("tables", json!(changed_tables)),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = Some(command_id);
    event.client_commit_id = Some(client_commit_id);
    event.duration_ms = Some(duration_ms);
    event
}

fn local_write_failed_event(
    error: &SyncularError,
    command_id: String,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::LocalWriteFailed,
        Vec::new(),
        Some(native_diagnostic(
            "error",
            "storage",
            "storage.local_write_failed",
            "Native Syncular local write failed",
            [
                ("commandId", json!(command_id.clone())),
                ("errorKind", json!(format!("{:?}", error.kind()))),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.error = Some(NativeErrorInfo::from_error(error));
    event.command_id = Some(command_id);
    event.duration_ms = Some(duration_ms);
    event
}

fn conflict_resolution_completed_event(
    command_id: String,
    retry_client_commit_id: Option<String>,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::ConflictResolutionCompleted,
        Vec::new(),
        Some(native_diagnostic(
            "info",
            "sync",
            "sync.conflict_resolution_completed",
            "Native Syncular conflict resolution completed",
            [
                ("commandId", json!(command_id.clone())),
                ("retryClientCommitId", json!(retry_client_commit_id.clone())),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = Some(command_id);
    event.client_commit_id = retry_client_commit_id;
    event.duration_ms = Some(duration_ms);
    event
}

fn conflict_resolution_failed_event(
    error: &SyncularError,
    command_id: String,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::ConflictResolutionFailed,
        Vec::new(),
        Some(native_diagnostic(
            "error",
            "sync",
            "sync.conflict_resolution_failed",
            "Native Syncular conflict resolution failed",
            [
                ("commandId", json!(command_id.clone())),
                ("errorKind", json!(format!("{:?}", error.kind()))),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.error = Some(NativeErrorInfo::from_error(error));
    event.command_id = Some(command_id);
    event.duration_ms = Some(duration_ms);
    event
}

fn snapshot_ready_event(command_id: String, payload_json: Value, duration_ms: u64) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::SnapshotReady,
        Vec::new(),
        Some(native_diagnostic(
            "info",
            "storage",
            "storage.snapshot_ready",
            "Native Syncular snapshot ready",
            [
                ("commandId", json!(command_id.clone())),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = Some(command_id);
    event.payload_json = Some(payload_json);
    event.duration_ms = Some(duration_ms);
    event
}

fn worker_command_completed_event(
    command_id: String,
    operation: &str,
    payload_json: Option<Value>,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::WorkerCommandCompleted,
        Vec::new(),
        Some(native_diagnostic(
            "info",
            "worker",
            "worker.command_completed",
            "Native Syncular worker command completed",
            [
                ("commandId", json!(command_id.clone())),
                ("operation", json!(operation)),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = Some(command_id);
    event.payload_json = payload_json;
    event.duration_ms = Some(duration_ms);
    event
}

fn worker_command_failed_event(
    error: &SyncularError,
    command_id: String,
    operation: &str,
    duration_ms: u64,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::WorkerCommandFailed,
        Vec::new(),
        Some(native_diagnostic(
            "error",
            "worker",
            "worker.command_failed",
            "Native Syncular worker command failed",
            [
                ("commandId", json!(command_id.clone())),
                ("operation", json!(operation)),
                ("errorKind", json!(format!("{:?}", error.kind()))),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.error = Some(NativeErrorInfo::from_error(error));
    event.command_id = Some(command_id);
    event.duration_ms = Some(duration_ms);
    event
}

fn native_event(
    kind: NativeEventKind,
    tables: Vec<String>,
    diagnostic: Option<NativeDiagnostic>,
) -> NativeEvent {
    NativeEvent {
        event_seq: 0,
        kind,
        error: None,
        command_id: None,
        client_commit_id: None,
        outbox_count: None,
        conflict_count: None,
        retry_scheduled: None,
        duration_ms: None,
        auth: None,
        diagnostic,
        tables,
        queries: Vec::new(),
        payload_json: None,
    }
}

fn native_diagnostic<'a>(
    level: &str,
    source: &str,
    code: &str,
    message: &str,
    details: impl IntoIterator<Item = (&'a str, Value)>,
) -> NativeDiagnostic {
    NativeDiagnostic {
        at: now_ms(),
        level: level.to_string(),
        source: source.to_string(),
        code: code.to_string(),
        message: message.to_string(),
        details: details
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    }
}

fn native_auth_info_from_error(error: &SyncularError) -> Option<NativeAuthInfo> {
    if error.kind() != ErrorKind::Transport {
        return None;
    }

    let message = error.message_text();
    let status = if message.contains("HTTP 401") {
        401
    } else if message.contains("HTTP 403") {
        403
    } else {
        return None;
    };

    Some(NativeAuthInfo {
        operation: auth_operation_from_message(&message).to_string(),
        status,
    })
}

fn auth_operation_from_message(message: &str) -> &'static str {
    if message.contains("snapshot chunk failed") {
        "snapshotChunk"
    } else if message.contains("blob upload init failed") {
        "blobInitiateUpload"
    } else if message.contains("blob upload complete failed") {
        "blobCompleteUpload"
    } else if message.contains("blob download url failed") {
        "blobGetDownloadUrl"
    } else {
        "sync"
    }
}

fn normalize_observed_tables(tables: Vec<String>) -> Result<Vec<String>> {
    if tables.is_empty() {
        return Err(SyncularError::config(
            "native observed query must depend on at least one app table",
        ));
    }

    let mut normalized = BTreeSet::new();
    for table in tables {
        let table = table.trim();
        if table.is_empty() {
            return Err(SyncularError::config(
                "native observed query table is empty",
            ));
        }
        validate_app_table_name(table)?;
        normalized.insert(table.to_string());
    }
    Ok(normalized.into_iter().collect())
}

fn validate_app_table_name(table: &str) -> Result<()> {
    if APP_TABLE_METADATA
        .iter()
        .any(|metadata| metadata.name == table)
    {
        return Ok(());
    }

    Err(SyncularError::config(format!(
        "unknown generated app table: {table}"
    )))
}

fn unique_event_tables<'a>(tables: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();
    for table in tables {
        if seen.insert(table) {
            unique.push(table.to_string());
        }
    }
    unique
}
