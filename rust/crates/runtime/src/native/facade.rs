use crate::app_schema::{app_schema_from_json, default_app_schema, AppSchema, AppTableMetadata};
use crate::client::{
    sync_changed_crdt_field_from_metadata, sync_changed_row_for_local_operation, BootstrapStatus,
    CrdtFieldCompactionReceipt, CrdtFieldMaterialization, CrdtFieldWriteReceipt, SubscriptionSpec,
    SyncChangedRow, SyncReport, SyncularClient, SyncularClientConfig,
};
use crate::crdt_field::{CrdtField, CrdtFieldId, CrdtFieldSyncMode};
use crate::crdt_yjs::{
    validate_crdt_request_json_size, validate_yjs_text_input_size,
    validate_yjs_update_envelope_size, YjsUpdateEnvelope,
};
use crate::diesel_sqlite::DieselSqliteStore;
use crate::encrypted_crdt::{EncryptedCrdt, CRDT_CHECKPOINTS_TABLE, CRDT_UPDATES_TABLE};
use crate::encryption::{encryption_helpers_json, FieldEncryption};
use crate::error::{ErrorKind, Result, SyncularError};
use crate::limits::{
    runtime_default_limits, RuntimeLimits, DEFAULT_CRDT_UPDATE_LOG_LIMIT,
    DEFAULT_NATIVE_EVENT_STREAM_CAPACITY, DEFAULT_NATIVE_RECENT_EVENT_LIMIT,
    DEFAULT_READONLY_QUERY_STATEMENT_CACHE_CAPACITY,
    MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES,
};
use crate::protocol::{
    validate_mutation_json_input_size, AuthLeaseProvenance, BlobRef, BootstrapState,
};
use crate::runtime_schema::runtime_schema_version;
use crate::sqlite_query::ReadonlySqlQueryExecutor;
use crate::store::{now_ms, AuthLeaseRecord, ConflictSummary, OutboxSummary};
use crate::transport::{
    HttpSyncTransport, RealtimeEvent, RealtimePresenceEntry, RealtimePresenceEvent,
    SyncAuthHeaderStore, SyncAuthHeaders, SyncTransportConfig,
};
use crate::worker::{
    PersistentRealtimeWorker, SyncWorker, SyncWorkerEvent, SyncWorkerEventSubscription,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeClientConfig {
    pub db_path: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub app_schema_json: Option<String>,
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
    worker_event_pump: Option<JoinHandle<()>>,
    realtime_worker: Option<PersistentRealtimeWorker>,
    presence_by_scope: Arc<Mutex<BTreeMap<String, Vec<NativePresenceEntry>>>>,
    auth_headers: SyncAuthHeaders,
    field_encryption: Option<FieldEncryption>,
    encrypted_crdt: Option<EncryptedCrdt>,
    auto_sync_local_writes: bool,
    shutdown_on_drop: bool,
    command_seq: Mutex<u64>,
    events: NativeEventHub,
    default_events: NativeEventSubscription,
    read_executor: Mutex<ReadonlySqlQueryExecutor>,
}

pub struct NativeClientOpenTask {
    command_id: String,
    result_rx: Option<Receiver<Result<NativeSyncularClient>>>,
    completed: Option<Result<NativeSyncularClient>>,
    finished: bool,
    taken: bool,
}

#[derive(Debug, Clone)]
pub struct NativeSyncularClientBuilder {
    config: NativeClientConfig,
    options: NativeClientOptions,
    realtime: bool,
    auth_headers: Option<SyncAuthHeaders>,
    subscriptions: Option<Vec<SubscriptionSpec>>,
    initial_sync: bool,
    initial_websocket_sync: bool,
    process_blob_uploads_on_open: bool,
    shutdown_on_drop: bool,
}

pub struct NativePresenceHandle<'a> {
    client: &'a mut NativeSyncularClient,
    scope_key: String,
    active: bool,
}

pub const NATIVE_FFI_ABI_VERSION: u32 = 2;

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
    pub limits: RuntimeLimits,
    pub capabilities: &'static [&'static str],
    pub app_tables: &'static [&'static str],
    pub app_table_metadata: &'static [AppTableMetadata],
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
    CrdtFieldChanged,
    CrdtFieldCompacted,
    WorkerCommandCompleted,
    WorkerCommandFailed,
    RowsChanged,
    QueriesChanged,
    ConflictsChanged,
    PresenceChanged,
    BlobUploadsChanged,
    EventsOverflowed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeLifecyclePhase {
    Offline,
    Syncing,
    Recovering,
    AuthRequired,
    Degraded,
    Complete,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLifecycleBootstrap {
    pub complete: bool,
    pub critical_ready: bool,
    pub interactive_ready: bool,
    pub is_bootstrapping: bool,
    pub progress_percent: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLifecycleOutbox {
    pub pending: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLifecycleConflicts {
    pub unresolved: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLifecycleBlobUploads {
    pub pending: i64,
    pub uploading: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLifecycleState {
    pub phase: NativeLifecyclePhase,
    pub online: bool,
    pub requires_action: bool,
    pub pending_requests: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap: Option<NativeLifecycleBootstrap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbox: Option<NativeLifecycleOutbox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<NativeLifecycleConflicts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_uploads: Option<NativeLifecycleBlobUploads>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<NativeErrorInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_diagnostic: Option<NativeDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeErrorInfo {
    pub kind: ErrorKind,
    pub code: String,
    pub category: String,
    pub retryable: bool,
    #[serde(rename = "recommendedAction")]
    pub recommended_action: String,
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
    #[serde(
        default,
        rename = "droppedCount",
        skip_serializing_if = "Option::is_none"
    )]
    pub dropped_count: Option<usize>,
    #[serde(
        default,
        rename = "resyncRequired",
        skip_serializing_if = "Option::is_none"
    )]
    pub resync_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<NativeAuthInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<NativeDiagnostic>,
    pub tables: Vec<String>,
    #[serde(default, rename = "changedRows", skip_serializing_if = "Vec::is_empty")]
    pub changed_rows: Vec<SyncChangedRow>,
    #[serde(default)]
    pub queries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap: Option<BootstrapStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<NativeLifecycleState>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnosticSnapshot {
    pub generated_at: i64,
    pub runtime: NativeRuntimeManifest,
    pub connection: NativeDiagnosticConnectionSnapshot,
    pub subscriptions: Vec<NativeDiagnosticSubscriptionSnapshot>,
    pub recent_events: Vec<NativeEvent>,
    pub recent_diagnostics: Vec<NativeDiagnostic>,
    pub recent_sync_timings: Vec<NativeSyncTimingSnapshot>,
    pub limits: RuntimeLimits,
    pub bootstrap: BootstrapStatus,
    pub outbox_stats: NativeOutboxStats,
    pub conflict_stats: NativeConflictStats,
    pub blob_upload_queue_stats: Value,
    pub blob_cache_stats: Value,
    pub observed_queries: Vec<NativeObservedQuery>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnosticConnectionSnapshot {
    pub sync_worker_running: bool,
    pub realtime_worker_running: bool,
    pub auto_sync_local_writes: bool,
    pub event_subscriber_count: usize,
    pub observed_query_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnosticSubscriptionSnapshot {
    pub id: String,
    pub table: String,
    pub scope_keys: Vec<String>,
    pub scope_value_count: usize,
    pub params_keys: Vec<String>,
    pub params_value_count: usize,
    pub status: Option<String>,
    pub ready: bool,
    pub phase: String,
    pub progress_percent: i64,
    pub cursor: Option<i64>,
    pub bootstrap_phase: i64,
    pub bootstrap_state: Option<BootstrapState>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOutboxStats {
    pub pending: usize,
    pub sending: usize,
    pub failed: usize,
    pub acked: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConflictStats {
    pub unresolved: usize,
    pub resolved: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncTimingSnapshot {
    pub event_seq: u64,
    pub kind: String,
    pub command_id: Option<String>,
    pub total_ms: u64,
    pub success: bool,
    pub retry_scheduled: Option<bool>,
    pub outbox_count: Option<usize>,
    pub conflict_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeAuthInfo {
    pub operation: String,
    pub status: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePresenceEntry {
    pub client_id: String,
    pub actor_id: String,
    pub joined_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeObservedQueryDependencyHint {
    pub table: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub row_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeObservedQuery {
    pub id: String,
    pub tables: Vec<String>,
    #[serde(
        default,
        rename = "dependencyHints",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub dependency_hints: Vec<NativeObservedQueryDependencyHint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Default)]
struct NativeEventHub {
    event_seq: Arc<Mutex<u64>>,
    subscriber_seq: Arc<Mutex<u64>>,
    subscribers: Arc<Mutex<BTreeMap<u64, Arc<NativeEventQueue>>>>,
    query_observers: Arc<Mutex<BTreeMap<String, NativeObservedQuery>>>,
    recent_events: Arc<Mutex<VecDeque<NativeEvent>>>,
}

pub struct NativeEventSubscription {
    hub: NativeEventHub,
    subscriber_id: u64,
    queue: Arc<NativeEventQueue>,
}

pub struct NativeEventJsonIterator {
    subscription: NativeEventSubscription,
}

struct NativeEventQueue {
    capacity: usize,
    state: Mutex<NativeEventQueueState>,
    ready: Condvar,
}

struct NativeEventQueueState {
    events: VecDeque<NativeEvent>,
    closed: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct NativeObservedQueryRegistration {
    #[serde(default)]
    id: Option<String>,
    tables: Vec<String>,
    #[serde(default, rename = "dependencyHints")]
    dependency_hints: Vec<NativeObservedQueryDependencyHint>,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeEncryptedCrdtRequest {
    table: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCrdtFieldRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCrdtFieldTextRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(alias = "next_text")]
    next_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCrdtFieldYjsUpdateRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    update: YjsUpdateEnvelope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCrdtFieldCompactionRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(default, alias = "min_uncheckpointed_updates")]
    min_uncheckpointed_updates: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCrdtFieldLogRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(default)]
    limit: Option<i64>,
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
        schema_version: runtime_schema_version(),
        storage_backend: "diesel-sqlite",
        transport_backends: &["http", "websocket"],
        worker_model: "background-sync-worker",
        string_encoding: "utf-8-json",
        error_shape: "native-error-info-v1",
        event_model: "native-event-stream-json-v1",
        limits: runtime_default_limits(),
        capabilities: &[
            "dynamic-auth-headers",
            "dynamic-subscriptions",
            "auth-expired-events",
            "generated-app-table-metadata",
            "generated-app-schema-state",
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
            "native-event-stream",
            "read-only-query-json",
            "outbox-json",
            "conflicts-json",
            "table-level-rows-changed-events",
            "query-observer-events",
            "conflicts-changed-events",
            "realtime-presence",
            "presence-changed-events",
            "blob-file-api",
            "background-worker-lifecycle",
            "background-resume-recovery",
            "structured-diagnostics",
            "diagnostic-snapshot",
            "runtime-limits",
            "storage-compaction",
            "streaming-blob-file-api",
            "crdt-yjs",
            "field-encryption",
            "encrypted-crdt",
            "queued-encrypted-crdt",
            "generic-crdt-field-api",
            "queued-crdt-field-updates",
            "encryption-key-sharing",
            "async-native-open",
        ],
        app_tables: &[],
        app_table_metadata: &[],
    }
}

pub fn native_runtime_manifest_json() -> Result<String> {
    Ok(serde_json::to_string(&native_runtime_manifest())?)
}

impl NativeSyncularClient {
    pub fn builder(config: NativeClientConfig) -> NativeSyncularClientBuilder {
        NativeSyncularClientBuilder::new(config)
    }

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
        let app_schema = config.app_schema()?;
        Self::open_with_options_and_schema(config.into(), options, app_schema)
    }

    pub fn open_native_async_with_options(
        config: NativeClientConfig,
        options: NativeClientOptions,
    ) -> NativeClientOpenTask {
        NativeClientOpenTask::open_native_with_options(config, options)
    }

    pub fn open_with_options(
        config: SyncularClientConfig,
        options: NativeClientOptions,
    ) -> Result<Self> {
        Self::open_with_options_and_schema(config, options, default_app_schema())
    }

    pub fn open_with_options_and_schema(
        config: SyncularClientConfig,
        options: NativeClientOptions,
        app_schema: AppSchema,
    ) -> Result<Self> {
        let writer = SyncularClient::open_with_schema(config.clone(), app_schema)?;
        let worker_client = SyncularClient::open_with_schema(config.clone(), app_schema)?;
        let events = NativeEventHub::default();
        let default_events = events.subscribe(DEFAULT_NATIVE_EVENT_STREAM_CAPACITY);
        let worker = SyncWorker::start(worker_client);
        let worker_event_pump = Some(start_worker_event_pump(
            events.clone(),
            worker.event_source(),
        ));
        let read_executor = ReadonlySqlQueryExecutor::open(
            &config.db_path,
            app_schema,
            DEFAULT_READONLY_QUERY_STATEMENT_CACHE_CAPACITY,
        )?;
        let presence_by_scope = Arc::new(Mutex::new(BTreeMap::new()));

        Ok(Self {
            config,
            writer,
            worker: Some(worker),
            worker_event_pump,
            realtime_worker: None,
            presence_by_scope,
            auth_headers: SyncAuthHeaders::new(),
            field_encryption: None,
            encrypted_crdt: None,
            auto_sync_local_writes: options.auto_sync_local_writes,
            shutdown_on_drop: false,
            command_seq: Mutex::new(0),
            events,
            default_events,
            read_executor: Mutex::new(read_executor),
        })
    }

    pub fn trigger_sync(&self) -> Result<()> {
        self.worker()?.trigger_sync()
    }

    pub fn trigger_sync_websocket(&self) -> Result<()> {
        self.worker()?.trigger_sync_websocket()
    }

    pub fn enqueue_sync_now(&self) -> Result<String> {
        let command_id = self.next_command_id("sync")?;
        self.worker()?.enqueue_sync_now(command_id.clone())?;
        Ok(command_id)
    }

    pub fn enqueue_sync_websocket(&self) -> Result<String> {
        let command_id = self.next_command_id("sync-ws")?;
        self.worker()?.enqueue_sync_websocket(command_id.clone())?;
        Ok(command_id)
    }

    pub fn enqueue_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let command_id = self.next_command_id("mutation")?;
        self.worker()?.enqueue_mutation_json(
            command_id.clone(),
            mutation_json.to_string(),
            local_row_json.map(str::to_string),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_yjs_update_json(&self, update_json: &str) -> Result<String> {
        validate_crdt_request_json_size(update_json)?;
        let command_id = self.next_command_id("yjs")?;
        self.worker()?.enqueue_yjs_update_json(
            command_id.clone(),
            update_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_crdt_field_yjs_update_json(&self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldYjsUpdateRequest = serde_json::from_str(request_json)?;
        validate_yjs_update_envelope_size(&request.update)?;
        let field = self.writer.open_crdt_field(request.id())?;
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => self.enqueue_yjs_update_json(request_json),
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                self.enqueue_encrypted_crdt_update_json(request_json)
            }
        }
    }

    pub fn enqueue_crdt_field_text_json(&self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldTextRequest = serde_json::from_str(request_json)?;
        validate_yjs_text_input_size(&request.next_text)?;
        self.writer.open_crdt_field(request.id())?;
        let command_id = self.next_command_id("crdt-text")?;
        self.worker()?.enqueue_crdt_field_text_json(
            command_id.clone(),
            request_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_crdt_field_compaction_json(&self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldCompactionRequest = serde_json::from_str(request_json)?;
        self.writer.open_crdt_field(request.id())?;
        let command_id = self.next_command_id("crdt-compact")?;
        self.worker()?.enqueue_crdt_field_compaction_json(
            command_id.clone(),
            request_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_encrypted_crdt_update_json(&self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let command_id = self.next_command_id("encrypted-crdt")?;
        self.worker()?.enqueue_encrypted_crdt_update_json(
            command_id.clone(),
            request_json.to_string(),
            self.auto_sync_local_writes,
        )?;
        Ok(command_id)
    }

    pub fn enqueue_encrypted_crdt_checkpoint_json(&self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
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

    pub fn enqueue_process_blob_upload_queue(&self) -> Result<String> {
        let command_id = self.next_command_id("blob-upload")?;
        self.worker()?
            .enqueue_process_blob_upload_queue(command_id.clone())?;
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
        if let Some(realtime_worker) = &self.realtime_worker {
            realtime_worker.set_auth_headers(self.auth_headers.clone())?;
        }
        Ok(())
    }

    pub fn set_auth_headers_json(&mut self, headers_json: &str) -> Result<()> {
        let headers: SyncAuthHeaders = serde_json::from_str(headers_json)?;
        self.set_auth_headers(headers)
    }

    pub fn set_subscriptions(&mut self, subscriptions: Vec<SubscriptionSpec>) -> Result<()> {
        self.writer.set_subscriptions(subscriptions.clone())?;
        if let Some(worker) = &self.worker {
            worker.set_subscriptions(subscriptions)?;
        }
        Ok(())
    }

    pub fn set_subscriptions_json(&mut self, subscriptions_json: &str) -> Result<()> {
        let subscriptions: Vec<SubscriptionSpec> = serde_json::from_str(subscriptions_json)?;
        self.set_subscriptions(subscriptions)
    }

    pub fn force_subscriptions_bootstrap(
        &mut self,
        subscription_ids: Vec<String>,
    ) -> Result<usize> {
        self.writer.force_subscriptions_bootstrap(&subscription_ids)
    }

    pub fn force_subscriptions_bootstrap_json(
        &mut self,
        subscription_ids_json: &str,
    ) -> Result<String> {
        let subscription_ids: Vec<String> = serde_json::from_str(subscription_ids_json)?;
        Ok(serde_json::to_string(
            &self.force_subscriptions_bootstrap(subscription_ids)?,
        )?)
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
        self.stop_realtime_worker()?;
        if let Some(worker) = self.worker.take() {
            worker.stop()?;
        }
        self.join_worker_event_pump()?;
        Ok(())
    }

    pub fn resume_sync_worker(&mut self) -> Result<()> {
        if self.worker.is_some() {
            return Ok(());
        }
        let mut worker_client =
            SyncularClient::open_with_schema(self.config.clone(), self.writer.app_schema())?;
        worker_client.set_subscriptions(self.writer.subscriptions().to_vec())?;
        worker_client.set_auth_headers(self.auth_headers.clone());
        worker_client.set_field_encryption(self.field_encryption.clone());
        worker_client.set_encrypted_crdt(self.encrypted_crdt.clone());
        let worker = SyncWorker::start(worker_client);
        self.worker_event_pump = Some(start_worker_event_pump(
            self.events.clone(),
            worker.event_source(),
        ));
        self.worker = Some(worker);
        Ok(())
    }

    pub fn resume_from_background(&mut self) -> Result<String> {
        self.resume_sync_worker()?;
        self.start_realtime_worker()?;
        self.enqueue_sync_now()
    }

    pub fn start(&mut self) -> Result<()> {
        self.start_realtime_worker()
    }

    pub fn stop(&mut self) -> Result<()> {
        self.stop_realtime_worker()
    }

    pub fn shutdown(&mut self) -> Result<()> {
        self.close()
    }

    pub fn start_realtime_worker(&mut self) -> Result<()> {
        if self.realtime_worker.is_some() {
            return Ok(());
        }
        let trigger = self.worker()?.trigger_handle();
        let mut transport = HttpSyncTransport::new(SyncTransportConfig::new(
            self.config.base_url.clone(),
            self.config.client_id.clone(),
            self.config.actor_id.clone(),
        ))
        .with_schema_version(self.writer.app_schema().current_schema_version());
        transport.set_auth_headers(self.auth_headers.clone());
        let events = self.events.clone();
        let presence_by_scope = self.presence_by_scope.clone();
        self.realtime_worker = Some(PersistentRealtimeWorker::start_with_event_handler(
            transport,
            trigger,
            Some(Arc::new(move |event| {
                if let RealtimeEvent::Presence(presence) = event {
                    apply_native_presence_event(&presence_by_scope, &events, presence);
                }
            })),
        ));
        if let Some(realtime_worker) = &self.realtime_worker {
            for (scope_key, metadata) in self.local_presence_metadata()? {
                realtime_worker.send_presence("join", scope_key, metadata)?;
            }
        }
        Ok(())
    }

    pub fn stop_realtime_worker(&mut self) -> Result<()> {
        if let Some(mut realtime_worker) = self.realtime_worker.take() {
            realtime_worker.stop()?;
        }
        Ok(())
    }

    pub fn sync_worker_running(&self) -> bool {
        self.worker.is_some()
    }

    pub fn join_presence(&mut self, scope_key: &str, metadata: Option<Value>) -> Result<()> {
        let event = RealtimePresenceEvent {
            action: "join".to_string(),
            scope_key: scope_key.to_string(),
            client_id: Some(self.config.client_id.clone()),
            actor_id: Some(self.config.actor_id.clone()),
            metadata: metadata.clone(),
            entries: Vec::new(),
        };
        apply_native_presence_event(&self.presence_by_scope, &self.events, event);
        if let Some(realtime_worker) = &self.realtime_worker {
            realtime_worker.send_presence("join", scope_key, metadata)?;
        }
        Ok(())
    }

    pub fn join_presence_handle(
        &mut self,
        scope_key: &str,
        metadata: Option<Value>,
    ) -> Result<NativePresenceHandle<'_>> {
        self.join_presence(scope_key, metadata)?;
        Ok(NativePresenceHandle {
            client: self,
            scope_key: scope_key.to_string(),
            active: true,
        })
    }

    pub fn leave_presence(&mut self, scope_key: &str) -> Result<()> {
        let event = RealtimePresenceEvent {
            action: "leave".to_string(),
            scope_key: scope_key.to_string(),
            client_id: Some(self.config.client_id.clone()),
            actor_id: Some(self.config.actor_id.clone()),
            metadata: None,
            entries: Vec::new(),
        };
        apply_native_presence_event(&self.presence_by_scope, &self.events, event);
        if let Some(realtime_worker) = &self.realtime_worker {
            realtime_worker.send_presence("leave", scope_key, None)?;
        }
        Ok(())
    }

    pub fn update_presence_metadata(&mut self, scope_key: &str, metadata: Value) -> Result<()> {
        let event = RealtimePresenceEvent {
            action: "update".to_string(),
            scope_key: scope_key.to_string(),
            client_id: Some(self.config.client_id.clone()),
            actor_id: Some(self.config.actor_id.clone()),
            metadata: Some(metadata.clone()),
            entries: Vec::new(),
        };
        apply_native_presence_event(&self.presence_by_scope, &self.events, event);
        if let Some(realtime_worker) = &self.realtime_worker {
            realtime_worker.send_presence("update", scope_key, Some(metadata))?;
        }
        Ok(())
    }

    pub fn presence_json(&self, scope_key: &str) -> Result<String> {
        let presence = self
            .presence_by_scope
            .lock()
            .map_err(|_| {
                SyncularError::message(ErrorKind::Internal, "native presence is poisoned")
            })?
            .get(scope_key)
            .cloned()
            .unwrap_or_default();
        Ok(serde_json::to_string(&presence)?)
    }

    fn local_presence_metadata(&self) -> Result<Vec<(String, Option<Value>)>> {
        let client_id = self.config.client_id.as_str();
        let joined = self
            .presence_by_scope
            .lock()
            .map_err(|_| {
                SyncularError::message(ErrorKind::Internal, "native presence is poisoned")
            })?
            .iter()
            .filter_map(|(scope_key, entries)| {
                entries
                    .iter()
                    .find(|entry| entry.client_id == client_id)
                    .map(|entry| (scope_key.clone(), entry.metadata.clone()))
            })
            .collect();
        Ok(joined)
    }

    pub fn subscribe_events(&self, capacity: usize) -> NativeEventSubscription {
        self.events.subscribe(capacity)
    }

    pub fn event_receiver(&self, capacity: usize) -> NativeEventSubscription {
        self.subscribe_events(capacity)
    }

    pub fn next_event(&self) -> Option<NativeEvent> {
        self.default_events.next_event()
    }

    pub fn next_event_timeout(&self, timeout: Duration) -> Option<NativeEvent> {
        self.default_events.next_event_timeout(timeout)
    }

    pub fn next_event_json(&self) -> Option<Result<String>> {
        self.default_events.next_event_json()
    }

    pub fn next_event_json_timeout(&self, timeout: Duration) -> Option<Result<String>> {
        self.default_events.next_event_json_timeout(timeout)
    }

    pub fn apply_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        validate_mutation_json_input_size(mutation_json, local_row_json)?;
        let operation: crate::protocol::SyncOperation = serde_json::from_str(mutation_json)?;
        let table = operation.table.clone();
        let previous_row = self
            .writer
            .current_row_json(&operation.table, &operation.row_id)?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        let client_commit_id = self
            .writer
            .apply_mutation_json(mutation_json, local_row_json)?;
        let changed_rows = sync_changed_row_for_local_operation(
            self.writer.app_schema(),
            &operation,
            previous_row.as_ref(),
            local_row.as_ref(),
            Some(client_commit_id.clone()),
        )
        .into_iter()
        .collect();
        self.events.push_rows_changed_events_with_details(
            [table.as_str()],
            changed_rows,
            Some("localWrite"),
        );
        self.trigger_after_local_write()?;
        Ok(client_commit_id)
    }

    pub fn open_crdt_field_json(&self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldRequest = serde_json::from_str(request_json)?;
        let field = self.writer.open_crdt_field(request.id())?;
        Ok(serde_json::to_string(&crdt_field_descriptor(&field))?)
    }

    pub fn apply_crdt_field_text_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldTextRequest = serde_json::from_str(request_json)?;
        validate_yjs_text_input_size(&request.next_text)?;
        let field = self.writer.open_crdt_field(request.id())?;
        let receipt = self
            .writer
            .apply_crdt_field_text(&field, &request.next_text)?;
        self.after_crdt_field_write(&field, Some(receipt.client_commit_id.clone()))?;
        crdt_field_write_receipt_json(receipt)
    }

    pub fn apply_crdt_field_yjs_update_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldYjsUpdateRequest = serde_json::from_str(request_json)?;
        validate_yjs_update_envelope_size(&request.update)?;
        let field = self.writer.open_crdt_field(request.id())?;
        let receipt = self
            .writer
            .apply_crdt_field_yjs_update(&field, request.update)?;
        self.after_crdt_field_write(&field, Some(receipt.client_commit_id.clone()))?;
        crdt_field_write_receipt_json(receipt)
    }

    pub fn materialize_crdt_field_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldRequest = serde_json::from_str(request_json)?;
        let field = self.writer.open_crdt_field(request.id())?;
        crdt_field_materialization_json(self.writer.materialize_crdt_field(&field)?)
    }

    pub fn crdt_document_snapshot_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldRequest = serde_json::from_str(request_json)?;
        let field = self.writer.open_crdt_field(request.id())?;
        self.writer.crdt_document_snapshot_json(&field)
    }

    pub fn crdt_update_log_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldLogRequest = serde_json::from_str(request_json)?;
        let field = self.writer.open_crdt_field(request.id())?;
        self.writer.crdt_update_log_json(
            &field,
            request.limit.unwrap_or(DEFAULT_CRDT_UPDATE_LOG_LIMIT),
        )
    }

    pub fn snapshot_crdt_field_state_vector_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldRequest = serde_json::from_str(request_json)?;
        let field = self.writer.open_crdt_field(request.id())?;
        Ok(serde_json::to_string(&json!({
            "stateVectorBase64": self.writer.snapshot_crdt_field_state_vector_base64(&field)?
        }))?)
    }

    pub fn compact_crdt_field_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeCrdtFieldCompactionRequest = serde_json::from_str(request_json)?;
        let field = self.writer.open_crdt_field(request.id())?;
        let receipt = self
            .writer
            .compact_crdt_field(&field, request.min_uncheckpointed_updates.unwrap_or(1))?;
        let should_emit_compaction_event =
            receipt.checkpoint_created || field.sync_mode() == CrdtFieldSyncMode::ServerMerge;
        if should_emit_compaction_event {
            let extra_payload_json = crdt_field_compaction_event_payload(
                &mut self.writer,
                &field,
                &receipt,
                receipt.checkpoint_created,
                request.min_uncheckpointed_updates.unwrap_or(1),
            );
            self.events.publish_event(crdt_field_compacted_event(
                &field,
                receipt.client_commit_id.clone(),
                crdt_field_compaction_tables(&field)
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                None,
                None,
                receipt.checkpoint_created,
                extra_payload_json,
            ));
            self.events.push_rows_changed_events_with_details(
                crdt_field_compaction_tables(&field),
                vec![crdt_field_compacted_row(
                    &field,
                    receipt.client_commit_id.clone(),
                )],
                Some("localWrite"),
            );
            self.trigger_after_local_write()?;
        }
        crdt_field_compaction_receipt_json(receipt)
    }

    pub fn apply_encrypted_crdt_update_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let request: NativeEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let receipt = self.writer.apply_encrypted_crdt_update_json(request_json)?;
        self.events
            .push_rows_changed_events([request.table.as_str(), CRDT_UPDATES_TABLE]);
        self.trigger_after_local_write()?;
        Ok(receipt.client_commit_id)
    }

    pub fn apply_encrypted_crdt_checkpoint_json(&mut self, request_json: &str) -> Result<String> {
        validate_crdt_request_json_size(request_json)?;
        let _request: NativeEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let receipt = self
            .writer
            .apply_encrypted_crdt_checkpoint_json(request_json)?;
        if let Some(receipt) = receipt {
            self.events
                .push_rows_changed_events([CRDT_CHECKPOINTS_TABLE]);
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
        self.read_executor
            .lock()
            .map_err(|_| {
                SyncularError::message(ErrorKind::Internal, "native read executor lock poisoned")
            })?
            .execute_json(request_json)
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
        self.writer
            .app_schema()
            .app_table_metadata
            .iter()
            .map(|metadata| metadata.name.to_string())
            .collect()
    }

    pub fn app_tables_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.writer.app_schema().app_tables)?)
    }

    pub fn app_table_metadata_json(&self) -> Result<String> {
        Ok(serde_json::to_string(
            self.writer.app_schema().app_table_metadata,
        )?)
    }

    pub fn app_schema_state_json(&mut self) -> Result<String> {
        self.writer.app_schema_state_json()
    }

    pub fn local_health_check_json(&mut self) -> Result<String> {
        self.writer.local_health_check_json()
    }

    pub fn export_local_support_bundle_json(&mut self) -> Result<String> {
        self.writer.export_local_support_bundle_json()
    }

    pub fn import_local_support_bundle_json(&mut self, bundle_json: &str) -> Result<String> {
        self.writer.import_local_support_bundle_json(bundle_json)
    }

    pub fn repair_local_health_json(&mut self, request_json: &str) -> Result<String> {
        self.writer.repair_local_health_json(request_json)
    }

    pub fn reset_local_sync_state_json(&mut self, request_json: &str) -> Result<String> {
        self.writer.reset_local_sync_state_json(request_json)
    }

    pub fn register_query_json(&self, query_json: &str) -> Result<String> {
        let registration: NativeObservedQueryRegistration = serde_json::from_str(query_json)?;
        let observed_query = registration.into_observed_query(self.writer.app_schema())?;
        let id = observed_query.id.clone();
        let mut observers = self.events.query_observers.lock().map_err(|_| {
            SyncularError::message(
                ErrorKind::Internal,
                "native query observer registry is poisoned",
            )
        })?;
        observers.insert(id.clone(), observed_query);
        Ok(id)
    }

    pub fn unregister_query(&self, id: &str) -> Result<()> {
        let mut observers = self.events.query_observers.lock().map_err(|_| {
            SyncularError::message(
                ErrorKind::Internal,
                "native query observer registry is poisoned",
            )
        })?;
        observers.remove(id);
        Ok(())
    }

    pub fn observed_queries(&self) -> Result<Vec<NativeObservedQuery>> {
        let observers = self.events.query_observers.lock().map_err(|_| {
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

    pub fn diagnostic_snapshot(&mut self) -> Result<NativeDiagnosticSnapshot> {
        let bootstrap = self.writer.bootstrap_status()?;
        let outbox = self.writer.outbox_summaries()?;
        let conflicts = self.writer.conflict_summaries()?;
        let observed_queries = self.observed_queries()?;
        let recent_events = self.events.recent_events();
        let recent_diagnostics = recent_events
            .iter()
            .filter_map(|event| event.diagnostic.clone())
            .collect();
        let recent_sync_timings = native_sync_timing_snapshots(&recent_events);
        let connection = NativeDiagnosticConnectionSnapshot {
            sync_worker_running: self.sync_worker_running(),
            realtime_worker_running: self.realtime_worker.is_some(),
            auto_sync_local_writes: self.auto_sync_local_writes,
            event_subscriber_count: self.events.subscriber_count(),
            observed_query_count: observed_queries.len(),
        };
        Ok(NativeDiagnosticSnapshot {
            generated_at: now_ms(),
            runtime: native_runtime_manifest(),
            connection,
            subscriptions: native_diagnostic_subscription_snapshots(
                self.writer.subscriptions(),
                &bootstrap,
            ),
            recent_events,
            recent_diagnostics,
            recent_sync_timings,
            limits: runtime_default_limits(),
            bootstrap,
            outbox_stats: native_outbox_stats(&outbox),
            conflict_stats: native_conflict_stats(&conflicts),
            blob_upload_queue_stats: serde_json::to_value(self.writer.blob_upload_queue_stats()?)?,
            blob_cache_stats: serde_json::to_value(self.writer.blob_cache_stats()?)?,
            observed_queries,
        })
    }

    pub fn diagnostic_snapshot_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.diagnostic_snapshot()?)?)
    }

    pub fn outbox_summaries(&mut self) -> Result<Vec<OutboxSummary>> {
        self.writer.outbox_summaries()
    }

    pub fn outbox_summaries_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.outbox_summaries()?)?)
    }

    pub fn upsert_auth_lease_json(&mut self, lease_json: &str) -> Result<()> {
        let lease: AuthLeaseRecord = serde_json::from_str(lease_json)?;
        self.writer.upsert_auth_lease(&lease)
    }

    pub fn auth_lease_json(&mut self, lease_id: &str) -> Result<String> {
        Ok(serde_json::to_string(&self.writer.auth_lease(lease_id)?)?)
    }

    pub fn active_auth_leases_json(
        &mut self,
        actor_id: Option<&str>,
        now_ms_value: i64,
    ) -> Result<String> {
        Ok(serde_json::to_string(
            &self.writer.active_auth_leases(actor_id, now_ms_value)?,
        )?)
    }

    pub fn set_outbox_auth_lease_json(
        &mut self,
        client_commit_id: &str,
        provenance_json: Option<&str>,
    ) -> Result<()> {
        let provenance: Option<AuthLeaseProvenance> =
            provenance_json.map(serde_json::from_str).transpose()?;
        self.writer
            .set_outbox_auth_lease(client_commit_id, provenance.as_ref())
    }

    pub fn conflict_summaries(&mut self) -> Result<Vec<ConflictSummary>> {
        self.writer.conflict_summaries()
    }

    pub fn conflict_summaries_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.conflict_summaries()?)?)
    }

    pub fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()> {
        self.writer.resolve_conflict(id, resolution)?;
        self.events.publish_event(conflicts_changed_event());
        Ok(())
    }

    pub fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String> {
        let client_commit_id = self.writer.retry_conflict_keep_local(id)?;
        self.events.publish_event(conflicts_changed_event());
        self.trigger_after_local_write()?;
        Ok(client_commit_id)
    }

    pub fn close(&mut self) -> Result<()> {
        self.stop_realtime_worker()?;
        if let Some(worker) = self.worker.take() {
            worker.stop()?;
        }
        self.join_worker_event_pump()?;
        Ok(())
    }

    fn join_worker_event_pump(&mut self) -> Result<()> {
        if let Some(join) = self.worker_event_pump.take() {
            join.join().map_err(|_| {
                SyncularError::message(ErrorKind::Internal, "native worker event pump panicked")
            })?;
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

    fn after_crdt_field_write(
        &mut self,
        field: &CrdtField,
        client_commit_id: Option<String>,
    ) -> Result<()> {
        let extra_payload_json = crdt_field_event_payload(&mut self.writer, field);
        self.events.publish_event(crdt_field_changed_event(
            field,
            client_commit_id.clone(),
            crdt_field_write_tables(field)
                .into_iter()
                .map(str::to_string)
                .collect(),
            None,
            None,
            extra_payload_json,
        ));
        self.events.push_rows_changed_events_with_details(
            crdt_field_write_tables(field),
            vec![crdt_field_changed_row(field, client_commit_id)],
            Some("localWrite"),
        );
        self.trigger_after_local_write()
    }
}

impl NativeSyncularClientBuilder {
    pub fn new(config: NativeClientConfig) -> Self {
        Self {
            config,
            options: NativeClientOptions::default(),
            realtime: true,
            auth_headers: None,
            subscriptions: None,
            initial_sync: false,
            initial_websocket_sync: false,
            process_blob_uploads_on_open: false,
            shutdown_on_drop: false,
        }
    }

    pub fn auto_sync_local_writes(mut self, enabled: bool) -> Self {
        self.options.auto_sync_local_writes = enabled;
        self
    }

    pub fn realtime(mut self, enabled: bool) -> Self {
        self.realtime = enabled;
        self
    }

    pub fn auth_headers(mut self, headers: SyncAuthHeaders) -> Self {
        self.auth_headers = Some(headers);
        self
    }

    pub fn auth_headers_json(mut self, headers_json: &str) -> Result<Self> {
        self.auth_headers = Some(serde_json::from_str(headers_json)?);
        Ok(self)
    }

    pub fn subscriptions(mut self, subscriptions: Vec<SubscriptionSpec>) -> Self {
        self.subscriptions = Some(subscriptions);
        self
    }

    pub fn subscriptions_json(mut self, subscriptions_json: &str) -> Result<Self> {
        self.subscriptions = Some(serde_json::from_str(subscriptions_json)?);
        Ok(self)
    }

    pub fn initial_sync(mut self, enabled: bool) -> Self {
        self.initial_sync = enabled;
        self
    }

    pub fn initial_websocket_sync(mut self, enabled: bool) -> Self {
        self.initial_websocket_sync = enabled;
        self
    }

    pub fn process_blob_uploads_on_open(mut self, enabled: bool) -> Self {
        self.process_blob_uploads_on_open = enabled;
        self
    }

    pub fn shutdown_on_drop(mut self, enabled: bool) -> Self {
        self.shutdown_on_drop = enabled;
        self
    }

    pub fn open(self) -> Result<NativeSyncularClient> {
        let mut client = NativeSyncularClient::open_native_with_options(self.config, self.options)?;
        client.shutdown_on_drop = self.shutdown_on_drop;
        if let Some(headers) = self.auth_headers {
            client.set_auth_headers(headers)?;
        }
        if let Some(subscriptions) = self.subscriptions {
            client.set_subscriptions(subscriptions)?;
        }
        if self.realtime {
            client.start()?;
        }
        if self.initial_websocket_sync {
            client.trigger_sync_websocket()?;
        } else if self.initial_sync {
            client.trigger_sync()?;
        }
        if self.process_blob_uploads_on_open {
            let _ = client.process_blob_upload_queue_json()?;
        }
        Ok(client)
    }
}

impl Drop for NativeSyncularClient {
    fn drop(&mut self) {
        if self.shutdown_on_drop {
            let _ = self.close();
        }
    }
}

impl NativePresenceHandle<'_> {
    pub fn update_metadata(&mut self, metadata: Value) -> Result<()> {
        self.client
            .update_presence_metadata(&self.scope_key, metadata)
    }

    pub fn leave(mut self) -> Result<()> {
        self.leave_inner()
    }

    fn leave_inner(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        self.active = false;
        self.client.leave_presence(&self.scope_key)
    }
}

impl Drop for NativePresenceHandle<'_> {
    fn drop(&mut self) {
        let _ = self.leave_inner();
    }
}

impl NativeClientOpenTask {
    pub fn open_native_with_options(
        config: NativeClientConfig,
        options: NativeClientOptions,
    ) -> Self {
        let command_id = format!("native-open-{}", Uuid::new_v4());
        let (result_tx, result_rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = result_tx.send(NativeSyncularClient::open_native_with_options(
                config, options,
            ));
        });
        Self {
            command_id,
            result_rx: Some(result_rx),
            completed: None,
            finished: false,
            taken: false,
        }
    }

    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    pub fn is_finished(&mut self) -> bool {
        self.fill_completed(Duration::ZERO);
        self.finished
    }

    pub fn take_client_timeout(
        &mut self,
        timeout: Duration,
    ) -> Option<Result<NativeSyncularClient>> {
        if self.taken {
            return Some(Err(SyncularError::message(
                ErrorKind::Internal,
                "native async open result was already taken",
            )));
        }
        self.fill_completed(timeout);
        let result = self.completed.take();
        if result.is_some() {
            self.taken = true;
        }
        result
    }

    fn fill_completed(&mut self, timeout: Duration) {
        if self.completed.is_some() {
            return;
        }
        let Some(result_rx) = &self.result_rx else {
            return;
        };
        match result_rx.recv_timeout(timeout) {
            Ok(result) => {
                self.completed = Some(result);
                self.result_rx = None;
                self.finished = true;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                self.completed = Some(Err(SyncularError::message(
                    ErrorKind::Internal,
                    "native async open worker stopped before returning a client",
                )));
                self.result_rx = None;
                self.finished = true;
            }
        }
    }
}

impl NativeCrdtFieldRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl NativeCrdtFieldLogRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl NativeCrdtFieldTextRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl NativeCrdtFieldYjsUpdateRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl NativeCrdtFieldCompactionRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl NativeEventSubscription {
    pub fn recv(&self) -> Option<NativeEvent> {
        self.next_event()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Option<NativeEvent> {
        self.next_event_timeout(timeout)
    }

    pub fn next_event(&self) -> Option<NativeEvent> {
        self.queue.next_event()
    }

    pub fn next_event_timeout(&self, timeout: Duration) -> Option<NativeEvent> {
        self.queue.next_event_timeout(timeout)
    }

    pub fn next_event_json(&self) -> Option<Result<String>> {
        self.next_event()
            .map(|event| serde_json::to_string(&event).map_err(Into::into))
    }

    pub fn next_event_json_timeout(&self, timeout: Duration) -> Option<Result<String>> {
        self.next_event_timeout(timeout)
            .map(|event| serde_json::to_string(&event).map_err(Into::into))
    }

    pub fn into_json_iter(self) -> NativeEventJsonIterator {
        NativeEventJsonIterator { subscription: self }
    }

    pub fn close(&self) {
        if let Ok(mut subscribers) = self.hub.subscribers.lock() {
            subscribers.remove(&self.subscriber_id);
        }
        self.queue.close();
    }
}

impl Iterator for NativeEventSubscription {
    type Item = NativeEvent;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_event()
    }
}

impl Iterator for NativeEventJsonIterator {
    type Item = Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        self.subscription.next_event_json()
    }
}

impl Drop for NativeEventSubscription {
    fn drop(&mut self) {
        self.close();
    }
}

impl NativeEventQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(NativeEventQueueState {
                events: VecDeque::new(),
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn push(&self, event: NativeEvent, overflow_event: impl FnOnce(usize) -> NativeEvent) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        if state.events.len() >= self.capacity {
            let dropped_count = state.events.len().saturating_add(1);
            state.events.clear();
            state.events.push_back(overflow_event(dropped_count));
            state.closed = true;
        } else {
            state.events.push_back(event);
        }
        self.ready.notify_one();
    }

    fn next_event(&self) -> Option<NativeEvent> {
        let mut state = self.state.lock().ok()?;
        loop {
            if let Some(event) = state.events.pop_front() {
                return Some(event);
            }
            if state.closed {
                return None;
            }
            state = self.ready.wait(state).ok()?;
        }
    }

    fn next_event_timeout(&self, timeout: Duration) -> Option<NativeEvent> {
        let deadline = std::time::Instant::now().checked_add(timeout)?;
        let mut state = self.state.lock().ok()?;
        loop {
            if let Some(event) = state.events.pop_front() {
                return Some(event);
            }
            if state.closed {
                return None;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return None;
            }
            let wait = deadline.saturating_duration_since(now);
            let (next_state, timeout) = self.ready.wait_timeout(state, wait).ok()?;
            state = next_state;
            if timeout.timed_out() && state.events.is_empty() {
                return None;
            }
        }
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.events.clear();
            self.ready.notify_all();
        }
    }

    fn is_closed(&self) -> bool {
        self.state.lock().map(|state| state.closed).unwrap_or(true)
    }
}

fn start_worker_event_pump(
    events: NativeEventHub,
    worker_events: SyncWorkerEventSubscription,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Some(event) = worker_events.next_event() {
            events.publish_worker_event(event);
        }
    })
}

impl NativeEventHub {
    fn subscribe(&self, capacity: usize) -> NativeEventSubscription {
        let queue = Arc::new(NativeEventQueue::new(capacity));
        let subscriber_id = self.next_subscriber_id();
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(subscriber_id, queue.clone());
        }
        NativeEventSubscription {
            hub: self.clone(),
            subscriber_id,
            queue,
        }
    }

    fn publish_event(&self, event: NativeEvent) {
        let event = self.stamp_event(event);
        self.record_recent_event(event.clone());
        let Ok(mut subscribers) = self.subscribers.lock() else {
            return;
        };

        subscribers.retain(|_, queue| {
            queue.push(event.clone(), |dropped_count| {
                self.stamp_event(events_overflowed_event(dropped_count))
            });
            !queue.is_closed()
        });
    }

    fn publish_worker_event(&self, event: SyncWorkerEvent) {
        for event in self.events_from_worker_event(event) {
            self.publish_event(event);
        }
    }

    fn recent_events(&self) -> Vec<NativeEvent> {
        self.recent_events
            .lock()
            .map(|events| events.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn subscriber_count(&self) -> usize {
        self.subscribers
            .lock()
            .map(|subscribers| subscribers.len())
            .unwrap_or_default()
    }

    fn record_recent_event(&self, event: NativeEvent) {
        let Ok(mut events) = self.recent_events.lock() else {
            return;
        };
        events.push_back(native_event_for_recent_diagnostics(event));
        while events.len() > DEFAULT_NATIVE_RECENT_EVENT_LIMIT {
            events.pop_front();
        }
    }

    fn push_rows_changed_events<'a>(&self, tables: impl IntoIterator<Item = &'a str>) {
        self.push_rows_changed_events_with_details(tables, Vec::new(), None);
    }

    fn push_rows_changed_events_with_details<'a>(
        &self,
        tables: impl IntoIterator<Item = &'a str>,
        changed_rows: Vec<SyncChangedRow>,
        source: Option<&str>,
    ) {
        let tables = unique_event_tables(tables);
        if tables.is_empty() {
            return;
        }

        self.publish_event(rows_changed_event_with_details(
            tables.iter().map(String::as_str),
            changed_rows.clone(),
            source,
        ));
        let queries = self.changed_query_ids(&tables, &changed_rows);
        if !queries.is_empty() {
            self.publish_event(queries_changed_event_with_details(
                &tables,
                queries,
                changed_rows,
                source,
            ));
        }
    }

    fn changed_query_ids(&self, tables: &[String], changed_rows: &[SyncChangedRow]) -> Vec<String> {
        let changed = tables.iter().map(String::as_str).collect::<BTreeSet<_>>();
        let Ok(observers) = self.query_observers.lock() else {
            return Vec::new();
        };

        observers
            .values()
            .filter(|query| observed_query_should_notify(query, &changed, changed_rows))
            .map(|query| query.id.clone())
            .collect()
    }

    fn stamp_event(&self, mut event: NativeEvent) -> NativeEvent {
        if let Ok(mut seq) = self.event_seq.lock() {
            *seq = seq.saturating_add(1);
            event.event_seq = *seq;
        }
        event
    }

    fn next_subscriber_id(&self) -> u64 {
        if let Ok(mut seq) = self.subscriber_seq.lock() {
            *seq = seq.saturating_add(1);
            *seq
        } else {
            0
        }
    }

    fn events_from_worker_event(&self, event: SyncWorkerEvent) -> Vec<NativeEvent> {
        match event {
            SyncWorkerEvent::SyncStarted { command_id } => {
                vec![sync_started_event(command_id)]
            }
            SyncWorkerEvent::SyncCompleted {
                command_id,
                report,
                bootstrap,
                outbox_count,
                conflict_count,
                duration_ms,
            } => {
                let mut events = vec![sync_completed_event(
                    report.clone(),
                    bootstrap,
                    command_id.clone(),
                    outbox_count,
                    conflict_count,
                    duration_ms,
                )];
                if !report.changed_tables.is_empty() {
                    events.push(rows_changed_event_with_details(
                        report.changed_tables.iter().map(String::as_str),
                        report.changed_rows.clone(),
                        Some("remotePull"),
                    ));
                    let queries =
                        self.changed_query_ids(&report.changed_tables, &report.changed_rows);
                    if !queries.is_empty() {
                        events.push(queries_changed_event_with_details(
                            &report.changed_tables,
                            queries,
                            report.changed_rows.clone(),
                            Some("remotePull"),
                        ));
                    }
                    events.extend(crdt_field_changed_events_from_changed_rows(
                        &report.changed_rows,
                        "remotePull",
                        command_id,
                        Some(duration_ms),
                    ));
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
                changed_rows,
                outbox_count,
                duration_ms,
            } => {
                let mut events = vec![local_write_committed_event(
                    command_id,
                    client_commit_id,
                    changed_tables.clone(),
                    changed_rows.clone(),
                    outbox_count,
                    duration_ms,
                )];
                if !changed_tables.is_empty() {
                    events.push(rows_changed_event_with_details(
                        changed_tables.iter().map(String::as_str),
                        changed_rows.clone(),
                        Some("localWrite"),
                    ));
                    let queries = self.changed_query_ids(&changed_tables, &changed_rows);
                    if !queries.is_empty() {
                        events.push(queries_changed_event_with_details(
                            &changed_tables,
                            queries,
                            changed_rows,
                            Some("localWrite"),
                        ));
                    }
                }
                events
            }
            SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json,
                duration_ms,
            } => vec![local_write_failed_event(
                &error,
                command_id,
                payload_json,
                duration_ms,
            )],
            SyncWorkerEvent::CrdtFieldChanged {
                command_id,
                client_commit_id,
                table,
                row_id,
                field,
                changed_tables,
                payload_json,
                duration_ms,
            } => vec![crdt_field_changed_event_from_parts(
                CrdtFieldEventParts {
                    table,
                    row_id,
                    field,
                    changed_tables,
                    client_commit_id: Some(client_commit_id),
                    checkpoint_created: None,
                    extra_payload_json: payload_json,
                },
                Some(command_id),
                Some(duration_ms),
            )],
            SyncWorkerEvent::CrdtFieldCompacted {
                command_id,
                client_commit_id,
                table,
                row_id,
                field,
                changed_tables,
                checkpoint_created,
                payload_json,
                duration_ms,
            } => vec![crdt_field_compacted_event_from_parts(
                CrdtFieldEventParts {
                    table,
                    row_id,
                    field,
                    changed_tables,
                    client_commit_id,
                    checkpoint_created: Some(checkpoint_created),
                    extra_payload_json: payload_json,
                },
                Some(command_id),
                Some(duration_ms),
            )],
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
            SyncWorkerEvent::BlobUploadsChanged { stats_json } => {
                vec![blob_uploads_changed_event(stats_json)]
            }
            SyncWorkerEvent::EventsOverflowed { dropped_count } => {
                vec![events_overflowed_event(dropped_count)]
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeWorkerEventConverter {
    hub: NativeEventHub,
}

impl NativeWorkerEventConverter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_observed_queries(&self, observed_queries: &[NativeObservedQuery]) {
        if let Ok(mut observers) = self.hub.query_observers.lock() {
            observers.clear();
            for query in observed_queries {
                observers.insert(query.id.clone(), query.clone());
            }
        }
    }

    pub fn convert(&self, event: SyncWorkerEvent) -> Vec<NativeEvent> {
        self.hub
            .events_from_worker_event(event)
            .into_iter()
            .map(|event| self.hub.stamp_event(event))
            .collect()
    }

    pub fn convert_json(&self, event: SyncWorkerEvent) -> Result<Vec<String>> {
        self.convert(event)
            .into_iter()
            .map(|event| serde_json::to_string(&event).map_err(Into::into))
            .collect()
    }
}

pub fn native_events_from_worker_event(event: SyncWorkerEvent) -> Vec<NativeEvent> {
    NativeWorkerEventConverter::new().convert(event)
}

pub fn native_events_from_worker_event_with_observed_queries(
    event: SyncWorkerEvent,
    observed_queries: &[NativeObservedQuery],
) -> Vec<NativeEvent> {
    let converter = NativeWorkerEventConverter::new();
    converter.set_observed_queries(observed_queries);
    converter.convert(event)
}

pub fn native_event_json_from_worker_event(event: SyncWorkerEvent) -> Result<Vec<String>> {
    NativeWorkerEventConverter::new().convert_json(event)
}

impl NativeObservedQueryRegistration {
    fn into_observed_query(self, app_schema: AppSchema) -> Result<NativeObservedQuery> {
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

        let tables = normalize_observed_tables(self.tables, app_schema)?;
        let dependency_hints =
            normalize_observed_query_dependency_hints(self.dependency_hints, &tables, app_schema)?;

        Ok(NativeObservedQuery {
            id,
            tables,
            dependency_hints,
            label: self.label,
        })
    }
}

impl NativeErrorInfo {
    pub fn from_error(error: &SyncularError) -> Self {
        let classification = error.classification();
        Self {
            kind: error.kind(),
            code: classification.code,
            category: classification.category,
            retryable: classification.retryable,
            recommended_action: classification.recommended_action,
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

impl NativeClientConfig {
    fn app_schema(&self) -> Result<AppSchema> {
        match self.app_schema_json.as_deref() {
            Some(schema_json) => app_schema_from_json(schema_json),
            None => Ok(default_app_schema()),
        }
    }
}

fn native_diagnostic_subscription_snapshots(
    subscriptions: &[SubscriptionSpec],
    bootstrap: &BootstrapStatus,
) -> Vec<NativeDiagnosticSubscriptionSnapshot> {
    subscriptions
        .iter()
        .map(|subscription| {
            let status = bootstrap
                .subscriptions
                .iter()
                .find(|status| status.id == subscription.id);
            NativeDiagnosticSubscriptionSnapshot {
                id: subscription.id.clone(),
                table: subscription.table.clone(),
                scope_keys: sorted_json_map_keys(&subscription.scopes),
                scope_value_count: count_redacted_values(&subscription.scopes),
                params_keys: sorted_json_map_keys(&subscription.params),
                params_value_count: count_redacted_values(&subscription.params),
                status: status.and_then(|status| status.status.clone()),
                ready: status.is_some_and(|status| status.ready),
                phase: status
                    .map(|status| status.phase.clone())
                    .unwrap_or_else(|| "pending".to_string()),
                progress_percent: status.map_or(0, |status| status.progress_percent),
                cursor: status.and_then(|status| status.cursor),
                bootstrap_phase: subscription.bootstrap_phase,
                bootstrap_state: status.and_then(|status| status.bootstrap_state.clone()),
            }
        })
        .collect()
}

fn sorted_json_map_keys(map: &Map<String, Value>) -> Vec<String> {
    let mut keys = map.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys
}

fn count_redacted_values(map: &Map<String, Value>) -> usize {
    map.values()
        .map(|value| match value {
            Value::Array(values) => values.len(),
            Value::Null => 0,
            _ => 1,
        })
        .sum()
}

fn native_outbox_stats(outbox: &[OutboxSummary]) -> NativeOutboxStats {
    let mut stats = NativeOutboxStats {
        total: outbox.len(),
        ..NativeOutboxStats::default()
    };
    for item in outbox {
        match item.status.as_str() {
            "pending" => stats.pending += 1,
            "sending" => stats.sending += 1,
            "failed" => stats.failed += 1,
            "acked" => stats.acked += 1,
            _ => {}
        }
    }
    stats
}

fn native_conflict_stats(conflicts: &[ConflictSummary]) -> NativeConflictStats {
    let mut stats = NativeConflictStats {
        total: conflicts.len(),
        ..NativeConflictStats::default()
    };
    for conflict in conflicts {
        if conflict.resolved_at.is_some() {
            stats.resolved += 1;
        } else {
            stats.unresolved += 1;
        }
    }
    stats
}

fn native_sync_timing_snapshots(events: &[NativeEvent]) -> Vec<NativeSyncTimingSnapshot> {
    events
        .iter()
        .filter_map(|event| {
            let total_ms = event.duration_ms?;
            let (kind, success) = match event.kind {
                NativeEventKind::SyncCompleted => ("syncCompleted", true),
                NativeEventKind::SyncFailed => ("syncFailed", false),
                NativeEventKind::AuthExpired => ("authExpired", false),
                _ => return None,
            };
            Some(NativeSyncTimingSnapshot {
                event_seq: event.event_seq,
                kind: kind.to_string(),
                command_id: event.command_id.clone(),
                total_ms,
                success,
                retry_scheduled: event.retry_scheduled,
                outbox_count: event.outbox_count,
                conflict_count: event.conflict_count,
            })
        })
        .collect()
}

fn crdt_field_descriptor(field: &CrdtField) -> Value {
    json!({
        "table": field.table(),
        "rowId": field.row_id(),
        "field": field.field(),
        "stateColumn": field.state_column(),
        "containerKey": field.container_key(),
        "rowIdField": field.row_id_field(),
        "syncMode": field.sync_mode(),
        "kind": field.field_metadata().kind,
    })
}

fn crdt_field_write_receipt_json(receipt: CrdtFieldWriteReceipt) -> Result<String> {
    Ok(serde_json::to_string(&receipt)?)
}

fn crdt_field_materialization_json(materialization: CrdtFieldMaterialization) -> Result<String> {
    Ok(serde_json::to_string(&materialization)?)
}

fn crdt_field_compaction_receipt_json(receipt: CrdtFieldCompactionReceipt) -> Result<String> {
    Ok(serde_json::to_string(&receipt)?)
}

fn crdt_field_write_tables(field: &CrdtField) -> Vec<&'static str> {
    match field.sync_mode() {
        CrdtFieldSyncMode::ServerMerge => vec![field.table()],
        CrdtFieldSyncMode::EncryptedUpdateLog => vec![field.table(), CRDT_UPDATES_TABLE],
    }
}

fn crdt_field_compaction_tables(field: &CrdtField) -> Vec<&'static str> {
    match field.sync_mode() {
        CrdtFieldSyncMode::ServerMerge => vec![field.table()],
        CrdtFieldSyncMode::EncryptedUpdateLog => vec![CRDT_CHECKPOINTS_TABLE],
    }
}

fn crdt_field_changed_row(field: &CrdtField, client_commit_id: Option<String>) -> SyncChangedRow {
    let crdt_field_changes = vec![sync_changed_crdt_field_from_metadata(
        field.field_metadata(),
    )];
    SyncChangedRow {
        table: field.table().to_string(),
        row_id: Some(field.row_id().to_string()),
        operation: "update".to_string(),
        changed_fields: vec![field.field().to_string(), field.state_column().to_string()],
        crdt_fields: vec![field.state_column().to_string()],
        crdt_field_changes,
        commit_id: client_commit_id,
        commit_seq: None,
        subscription_id: None,
        server_version: None,
    }
}

fn crdt_field_compacted_row(field: &CrdtField, client_commit_id: Option<String>) -> SyncChangedRow {
    let crdt_field_changes = vec![sync_changed_crdt_field_from_metadata(
        field.field_metadata(),
    )];
    SyncChangedRow {
        table: field.table().to_string(),
        row_id: Some(field.row_id().to_string()),
        operation: "compact".to_string(),
        changed_fields: vec![field.state_column().to_string()],
        crdt_fields: vec![field.state_column().to_string()],
        crdt_field_changes,
        commit_id: client_commit_id,
        commit_seq: None,
        subscription_id: None,
        server_version: None,
    }
}

#[derive(Debug)]
struct CrdtFieldEventParts {
    table: String,
    row_id: String,
    field: String,
    changed_tables: Vec<String>,
    client_commit_id: Option<String>,
    checkpoint_created: Option<bool>,
    extra_payload_json: Option<Value>,
}

fn crdt_field_changed_event(
    field: &CrdtField,
    client_commit_id: Option<String>,
    changed_tables: Vec<String>,
    command_id: Option<String>,
    duration_ms: Option<u64>,
    extra_payload_json: Option<Value>,
) -> NativeEvent {
    crdt_field_changed_event_from_parts(
        CrdtFieldEventParts {
            table: field.table().to_string(),
            row_id: field.row_id().to_string(),
            field: field.field().to_string(),
            changed_tables,
            client_commit_id,
            checkpoint_created: None,
            extra_payload_json,
        },
        command_id,
        duration_ms,
    )
}

fn crdt_field_changed_event_from_parts(
    parts: CrdtFieldEventParts,
    command_id: Option<String>,
    duration_ms: Option<u64>,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::CrdtFieldChanged,
        parts.changed_tables.clone(),
        Some(native_diagnostic(
            "info",
            "storage",
            "crdt.field_changed",
            "Native Syncular CRDT field changed",
            [
                ("commandId", json!(command_id.clone())),
                ("clientCommitId", json!(parts.client_commit_id.clone())),
                ("table", json!(parts.table.clone())),
                ("rowId", json!(parts.row_id.clone())),
                ("field", json!(parts.field.clone())),
                ("tables", json!(parts.changed_tables.clone())),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = command_id;
    event.client_commit_id = parts.client_commit_id.clone();
    event.duration_ms = duration_ms;
    event.payload_json = Some(crdt_field_payload(parts));
    event
}

fn crdt_field_compacted_event(
    field: &CrdtField,
    client_commit_id: Option<String>,
    changed_tables: Vec<String>,
    command_id: Option<String>,
    duration_ms: Option<u64>,
    checkpoint_created: bool,
    extra_payload_json: Option<Value>,
) -> NativeEvent {
    crdt_field_compacted_event_from_parts(
        CrdtFieldEventParts {
            table: field.table().to_string(),
            row_id: field.row_id().to_string(),
            field: field.field().to_string(),
            changed_tables,
            client_commit_id,
            checkpoint_created: Some(checkpoint_created),
            extra_payload_json,
        },
        command_id,
        duration_ms,
    )
}

fn crdt_field_compacted_event_from_parts(
    parts: CrdtFieldEventParts,
    command_id: Option<String>,
    duration_ms: Option<u64>,
) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::CrdtFieldCompacted,
        parts.changed_tables.clone(),
        Some(native_diagnostic(
            "info",
            "storage",
            "crdt.field_compacted",
            "Native Syncular CRDT field compacted",
            [
                ("commandId", json!(command_id.clone())),
                ("clientCommitId", json!(parts.client_commit_id.clone())),
                ("table", json!(parts.table.clone())),
                ("rowId", json!(parts.row_id.clone())),
                ("field", json!(parts.field.clone())),
                (
                    "checkpointCreated",
                    json!(parts.checkpoint_created.unwrap_or(true)),
                ),
                ("tables", json!(parts.changed_tables.clone())),
                ("durationMs", json!(duration_ms)),
            ],
        )),
    );
    event.command_id = command_id;
    event.client_commit_id = parts.client_commit_id.clone();
    event.duration_ms = duration_ms;
    event.payload_json = Some(crdt_field_payload(parts));
    event
}

fn crdt_field_event_payload(
    client: &mut SyncularClient<DieselSqliteStore, HttpSyncTransport>,
    field: &CrdtField,
) -> Option<Value> {
    let mut payload = crdt_field_base_event_payload(field);
    match client.materialize_crdt_field(field) {
        Ok(materialization) => {
            payload.insert("materializationAvailable".to_string(), json!(true));
            payload.insert(
                "hasState".to_string(),
                json!(materialization.state_base64.is_some()),
            );
            payload.insert(
                "stateVectorBase64".to_string(),
                json!(materialization.state_vector_base64),
            );
        }
        Err(error) => {
            payload.insert("materializationAvailable".to_string(), json!(false));
            payload.insert(
                "materializationError".to_string(),
                json!(error.message_text()),
            );
        }
    }
    Some(Value::Object(payload))
}

fn crdt_field_compaction_event_payload(
    client: &mut SyncularClient<DieselSqliteStore, HttpSyncTransport>,
    field: &CrdtField,
    receipt: &CrdtFieldCompactionReceipt,
    checkpoint_created: bool,
    min_uncheckpointed_updates: i64,
) -> Option<Value> {
    let mut payload = crdt_field_event_payload(client, field)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_else(|| crdt_field_base_event_payload(field));
    payload.insert("checkpointCreated".to_string(), json!(checkpoint_created));
    payload.insert(
        "minUncheckpointedUpdates".to_string(),
        json!(min_uncheckpointed_updates),
    );
    payload.insert("before".to_string(), json!(&receipt.before));
    payload.insert("after".to_string(), json!(&receipt.after));
    payload.insert(
        "encryptedStreamBefore".to_string(),
        json!(&receipt.encrypted_stream_before),
    );
    payload.insert(
        "encryptedStreamAfter".to_string(),
        json!(&receipt.encrypted_stream_after),
    );
    Some(Value::Object(payload))
}

fn crdt_field_base_event_payload(field: &CrdtField) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert("syncMode".to_string(), json!(field.sync_mode()));
    payload.insert("kind".to_string(), json!(field.field_metadata().kind));
    payload.insert("stateColumn".to_string(), json!(field.state_column()));
    payload.insert("containerKey".to_string(), json!(field.container_key()));
    payload.insert("rowIdField".to_string(), json!(field.row_id_field()));
    payload
}

fn crdt_field_payload(parts: CrdtFieldEventParts) -> Value {
    let mut payload = json!({
        "table": parts.table,
        "rowId": parts.row_id,
        "field": parts.field,
        "changedTables": parts.changed_tables,
    });
    if let Value::Object(ref mut object) = payload {
        if let Some(client_commit_id) = parts.client_commit_id {
            object.insert("clientCommitId".to_string(), json!(client_commit_id));
        }
        if let Some(checkpoint_created) = parts.checkpoint_created {
            object.insert("checkpointCreated".to_string(), json!(checkpoint_created));
        }
        if let Some(Value::Object(extra)) = parts.extra_payload_json {
            for (key, value) in extra {
                object.entry(key).or_insert(value);
            }
        }
    }
    payload
}

fn crdt_field_changed_events_from_changed_rows(
    changed_rows: &[SyncChangedRow],
    source: &str,
    command_id: Option<String>,
    duration_ms: Option<u64>,
) -> Vec<NativeEvent> {
    let mut events = Vec::new();
    for row in changed_rows {
        let Some(row_id) = row.row_id.as_ref() else {
            continue;
        };
        for field in &row.crdt_field_changes {
            events.push(crdt_field_changed_event_from_parts(
                CrdtFieldEventParts {
                    table: row.table.clone(),
                    row_id: row_id.clone(),
                    field: field.field.clone(),
                    changed_tables: vec![row.table.clone()],
                    client_commit_id: None,
                    checkpoint_created: None,
                    extra_payload_json: Some(json!({
                        "source": source,
                        "operation": row.operation,
                        "stateColumn": field.state_column,
                        "containerKey": field.container_key,
                        "rowIdField": field.row_id_field,
                        "kind": field.kind,
                        "syncMode": field.sync_mode,
                        "commitId": row.commit_id,
                        "commitSeq": row.commit_seq,
                        "subscriptionId": row.subscription_id,
                        "serverVersion": row.server_version,
                        "changedFields": row.changed_fields,
                        "crdtFields": row.crdt_fields,
                    })),
                },
                command_id.clone(),
                duration_ms,
            ));
        }
    }
    events
}

fn native_event_for_recent_diagnostics(mut event: NativeEvent) -> NativeEvent {
    if let Some(payload_json) = event.payload_json.as_ref() {
        if let Ok(bytes) = serde_json::to_vec(payload_json) {
            if bytes.len() > MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES {
                event.payload_json = Some(json!({
                    "truncated": true,
                    "reason": "diagnosticPayloadLimit",
                    "originalBytes": bytes.len(),
                    "maxBytes": MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES,
                    "limit": "maxNativeDiagnosticEventPayloadJsonBytes"
                }));
            }
        }
    }
    event
}

fn rows_changed_event_with_details<'a>(
    tables: impl IntoIterator<Item = &'a str>,
    changed_rows: Vec<SyncChangedRow>,
    source: Option<&str>,
) -> NativeEvent {
    let tables = tables.into_iter().map(str::to_string).collect::<Vec<_>>();
    let mut event = native_event(
        NativeEventKind::RowsChanged,
        tables.clone(),
        Some(native_diagnostic(
            "info",
            "storage",
            "storage.rows_changed",
            "Native Syncular rows changed",
            [
                ("tables", json!(tables)),
                ("source", json!(source)),
                ("changedRows", json!(changed_rows.clone())),
            ],
        )),
    );
    event.changed_rows = changed_rows.clone();
    event.payload_json = Some(json!({
        "type": "rowsChanged",
        "source": source,
        "changedRows": changed_rows,
    }));
    event
}

fn apply_native_presence_event(
    presence_by_scope: &Arc<Mutex<BTreeMap<String, Vec<NativePresenceEntry>>>>,
    events: &NativeEventHub,
    event: RealtimePresenceEvent,
) {
    let scope_key = event.scope_key.clone();
    let Ok(mut state) = presence_by_scope.lock() else {
        return;
    };
    let current = state.get(&scope_key).cloned().unwrap_or_default();
    let next = match event.action.as_str() {
        "snapshot" => event
            .entries
            .into_iter()
            .map(native_presence_entry_from_realtime)
            .collect::<Vec<_>>(),
        "leave" => {
            let Some(client_id) = event.client_id.as_deref() else {
                return;
            };
            current
                .into_iter()
                .filter(|entry| entry.client_id != client_id)
                .collect()
        }
        "update" => {
            let Some(client_id) = event.client_id.as_deref() else {
                return;
            };
            if !current.iter().any(|entry| entry.client_id == client_id) {
                return;
            }
            current
                .into_iter()
                .map(|entry| {
                    if entry.client_id == client_id {
                        NativePresenceEntry {
                            metadata: event.metadata.clone(),
                            ..entry
                        }
                    } else {
                        entry
                    }
                })
                .collect()
        }
        "join" => {
            let (Some(client_id), Some(actor_id)) = (event.client_id, event.actor_id) else {
                return;
            };
            let joined_at = current
                .iter()
                .find(|entry| entry.client_id == client_id)
                .map(|entry| entry.joined_at)
                .unwrap_or_else(now_ms);
            let mut next = current
                .into_iter()
                .filter(|entry| entry.client_id != client_id)
                .collect::<Vec<_>>();
            next.push(NativePresenceEntry {
                client_id,
                actor_id,
                joined_at,
                metadata: event.metadata,
            });
            next
        }
        _ => return,
    };
    if next.is_empty() {
        state.remove(&scope_key);
    } else {
        state.insert(scope_key.clone(), next.clone());
    }
    drop(state);
    events.publish_event(presence_changed_event(scope_key, next));
}

fn native_presence_entry_from_realtime(entry: RealtimePresenceEntry) -> NativePresenceEntry {
    NativePresenceEntry {
        client_id: entry.client_id,
        actor_id: entry.actor_id,
        joined_at: entry.joined_at,
        metadata: entry.metadata,
    }
}

fn presence_changed_event(scope_key: String, presence: Vec<NativePresenceEntry>) -> NativeEvent {
    let mut event = native_event(
        NativeEventKind::PresenceChanged,
        Vec::new(),
        Some(native_diagnostic(
            "info",
            "realtime",
            "realtime.presence_changed",
            "Native Syncular presence changed",
            [
                ("scopeKey", json!(scope_key.clone())),
                ("presence", json!(presence.clone())),
            ],
        )),
    );
    event.payload_json = Some(json!({
        "type": "presenceChanged",
        "scopeKey": scope_key,
        "presence": presence,
    }));
    event
}

fn queries_changed_event_with_details(
    tables: &[String],
    queries: Vec<String>,
    changed_rows: Vec<SyncChangedRow>,
    source: Option<&str>,
) -> NativeEvent {
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
                ("source", json!(source)),
                ("changedRows", json!(changed_rows.clone())),
            ],
        )),
    );
    event.changed_rows = changed_rows;
    event.queries = queries;
    event
}

fn conflicts_changed_event() -> NativeEvent {
    let diagnostic = native_diagnostic(
        "warn",
        "sync",
        "sync.conflicts_changed",
        "Native Syncular conflicts changed",
        std::iter::empty::<(&str, Value)>(),
    );
    let mut event = native_event(
        NativeEventKind::ConflictsChanged,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.lifecycle = Some(native_lifecycle_state(
        NativeLifecyclePhase::Degraded,
        false,
        true,
        0,
        None,
        None,
        Some(NativeLifecycleConflicts { unresolved: 1 }),
        None,
        None,
        Some(diagnostic),
    ));
    event
}

fn native_lifecycle_blob_uploads(stats_json: &Value) -> Option<NativeLifecycleBlobUploads> {
    Some(NativeLifecycleBlobUploads {
        pending: stats_json.get("pending")?.as_i64()?,
        uploading: stats_json.get("uploading")?.as_i64()?,
        failed: stats_json.get("failed")?.as_i64()?,
    })
}

fn native_lifecycle_bootstrap(status: &BootstrapStatus) -> NativeLifecycleBootstrap {
    NativeLifecycleBootstrap {
        complete: status.complete,
        critical_ready: status.critical_ready,
        interactive_ready: status.interactive_ready,
        is_bootstrapping: status.is_bootstrapping,
        progress_percent: status.progress_percent,
    }
}

fn native_lifecycle_state(
    phase: NativeLifecyclePhase,
    online: bool,
    requires_action: bool,
    pending_requests: usize,
    bootstrap: Option<NativeLifecycleBootstrap>,
    outbox: Option<NativeLifecycleOutbox>,
    conflicts: Option<NativeLifecycleConflicts>,
    blob_uploads: Option<NativeLifecycleBlobUploads>,
    last_error: Option<NativeErrorInfo>,
    last_diagnostic: Option<NativeDiagnostic>,
) -> NativeLifecycleState {
    NativeLifecycleState {
        phase,
        online,
        requires_action,
        pending_requests,
        bootstrap,
        outbox,
        conflicts,
        blob_uploads,
        last_error,
        last_diagnostic,
    }
}

fn native_lifecycle_for_sync_completed(
    bootstrap: &BootstrapStatus,
    outbox_count: usize,
    conflict_count: usize,
    diagnostic: NativeDiagnostic,
) -> NativeLifecycleState {
    let has_conflicts = conflict_count > 0;
    let phase = if has_conflicts {
        NativeLifecyclePhase::Degraded
    } else if bootstrap.complete {
        NativeLifecyclePhase::Complete
    } else {
        NativeLifecyclePhase::Recovering
    };
    native_lifecycle_state(
        phase,
        true,
        has_conflicts,
        0,
        Some(native_lifecycle_bootstrap(bootstrap)),
        Some(NativeLifecycleOutbox {
            pending: outbox_count,
        }),
        Some(NativeLifecycleConflicts {
            unresolved: conflict_count,
        }),
        None,
        None,
        Some(diagnostic),
    )
}

fn native_lifecycle_for_error(
    error: &SyncularError,
    retry_scheduled: bool,
    diagnostic: NativeDiagnostic,
) -> NativeLifecycleState {
    let error_info = NativeErrorInfo::from_error(error);
    let classification = error.classification();
    let resync_required = error.requires_full_snapshot_resync();
    let phase = if classification.code == "sync.auth_required" {
        NativeLifecyclePhase::AuthRequired
    } else if resync_required {
        NativeLifecyclePhase::Recovering
    } else if classification.category == "offline" || retry_scheduled {
        NativeLifecyclePhase::Offline
    } else {
        NativeLifecyclePhase::Degraded
    };
    let requires_action = matches!(phase, NativeLifecyclePhase::AuthRequired)
        || (matches!(phase, NativeLifecyclePhase::Degraded) && !classification.retryable);
    native_lifecycle_state(
        phase,
        false,
        requires_action,
        0,
        None,
        None,
        None,
        None,
        Some(error_info),
        Some(diagnostic),
    )
}

fn events_overflowed_event(dropped_count: usize) -> NativeEvent {
    let diagnostic = native_diagnostic(
        "warn",
        "events",
        "events.overflowed",
        "Native Syncular event stream overflowed",
        [
            ("droppedCount", json!(dropped_count)),
            ("resyncRequired", json!(true)),
        ],
    );
    let mut event = native_event(
        NativeEventKind::EventsOverflowed,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.dropped_count = Some(dropped_count);
    event.resync_required = Some(true);
    event.lifecycle = Some(native_lifecycle_state(
        NativeLifecyclePhase::Recovering,
        false,
        true,
        0,
        None,
        None,
        None,
        None,
        None,
        Some(diagnostic),
    ));
    event.payload_json = Some(json!({
        "type": "eventsOverflowed",
        "droppedCount": dropped_count,
        "resyncRequired": true
    }));
    event
}

fn sync_started_event(command_id: Option<String>) -> NativeEvent {
    let diagnostic = native_diagnostic(
        "info",
        "sync",
        "sync.started",
        "Native Syncular sync started",
        std::iter::empty::<(&str, Value)>(),
    );
    let mut event = native_event(
        NativeEventKind::SyncStarted,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.command_id = command_id;
    event.lifecycle = Some(native_lifecycle_state(
        NativeLifecyclePhase::Syncing,
        false,
        false,
        1,
        None,
        None,
        None,
        None,
        None,
        Some(diagnostic),
    ));
    event
}

fn sync_completed_event(
    report: SyncReport,
    bootstrap: BootstrapStatus,
    command_id: Option<String>,
    outbox_count: usize,
    conflict_count: usize,
    duration_ms: u64,
) -> NativeEvent {
    let diagnostic = native_diagnostic(
        "info",
        "sync",
        "sync.completed",
        "Native Syncular sync completed",
        [
            ("changedTables", json!(report.changed_tables.clone())),
            ("changedTableCount", json!(report.changed_tables.len())),
            ("changedRows", json!(report.changed_rows.clone())),
            ("conflictsChanged", json!(report.conflicts_changed)),
            ("bootstrap", json!(bootstrap.clone())),
            ("outboxCount", json!(outbox_count)),
            ("conflictCount", json!(conflict_count)),
            ("durationMs", json!(duration_ms)),
        ],
    );
    let mut event = native_event(
        NativeEventKind::SyncCompleted,
        report.changed_tables.clone(),
        Some(diagnostic.clone()),
    );
    event.command_id = command_id;
    event.outbox_count = Some(outbox_count);
    event.conflict_count = Some(conflict_count);
    event.duration_ms = Some(duration_ms);
    event.changed_rows = report.changed_rows;
    event.lifecycle = Some(native_lifecycle_for_sync_completed(
        &bootstrap,
        outbox_count,
        conflict_count,
        diagnostic,
    ));
    event.bootstrap = Some(bootstrap);
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
            let mut details = vec![
                ("operation", json!(operation)),
                ("status", json!(status)),
                ("retryScheduled", json!(retry_scheduled)),
                ("durationMs", json!(duration_ms)),
            ];
            push_native_error_details(&mut details, error);
            let diagnostic = native_diagnostic(
                "warn",
                "auth",
                "auth.expired",
                "Native Syncular auth expired",
                details,
            );
            let mut event = native_event(
                NativeEventKind::AuthExpired,
                Vec::new(),
                Some(diagnostic.clone()),
            );
            event.error = Some(NativeErrorInfo::from_error(error));
            event.auth = Some(auth);
            event.command_id = command_id;
            event.retry_scheduled = Some(retry_scheduled);
            event.duration_ms = Some(duration_ms);
            event.lifecycle = Some(native_lifecycle_for_error(
                error,
                retry_scheduled,
                diagnostic,
            ));
            event
        }
        None => {
            let resync_required = error.requires_full_snapshot_resync();
            let mut details = vec![
                ("retryScheduled", json!(retry_scheduled)),
                ("durationMs", json!(duration_ms)),
                ("resyncRequired", json!(resync_required)),
            ];
            push_native_error_details(&mut details, error);
            let diagnostic = native_diagnostic(
                "error",
                "sync",
                if resync_required {
                    "sync.resync_required"
                } else {
                    "sync.failed"
                },
                if resync_required {
                    "Native Syncular sync requires full resync"
                } else {
                    "Native Syncular sync failed"
                },
                details,
            );
            let mut event = native_event(
                NativeEventKind::SyncFailed,
                Vec::new(),
                Some(diagnostic.clone()),
            );
            event.error = Some(NativeErrorInfo::from_error(error));
            event.command_id = command_id;
            event.retry_scheduled = Some(retry_scheduled);
            event.duration_ms = Some(duration_ms);
            event.lifecycle = Some(native_lifecycle_for_error(
                error,
                retry_scheduled,
                diagnostic,
            ));
            if resync_required {
                event.resync_required = Some(true);
                event.payload_json = Some(json!({
                    "type": "syncResyncRequired",
                    "resyncRequired": true,
                    "retryScheduled": retry_scheduled
                }));
            }
            event
        }
    }
}

fn local_write_committed_event(
    command_id: String,
    client_commit_id: String,
    changed_tables: Vec<String>,
    changed_rows: Vec<SyncChangedRow>,
    outbox_count: usize,
    duration_ms: u64,
) -> NativeEvent {
    let diagnostic = native_diagnostic(
        "info",
        "storage",
        "storage.local_write_committed",
        "Native Syncular local write committed",
        [
            ("commandId", json!(command_id.clone())),
            ("clientCommitId", json!(client_commit_id.clone())),
            ("tables", json!(changed_tables.clone())),
            ("changedRows", json!(changed_rows.clone())),
            ("outboxCount", json!(outbox_count)),
            ("durationMs", json!(duration_ms)),
        ],
    );
    let mut event = native_event(
        NativeEventKind::LocalWriteCommitted,
        changed_tables.clone(),
        Some(diagnostic.clone()),
    );
    event.command_id = Some(command_id);
    event.client_commit_id = Some(client_commit_id);
    event.outbox_count = Some(outbox_count);
    event.duration_ms = Some(duration_ms);
    event.changed_rows = changed_rows;
    event.lifecycle = Some(native_lifecycle_state(
        NativeLifecyclePhase::Offline,
        false,
        false,
        0,
        None,
        Some(NativeLifecycleOutbox {
            pending: outbox_count,
        }),
        None,
        None,
        None,
        Some(diagnostic),
    ));
    event
}

fn local_write_failed_event(
    error: &SyncularError,
    command_id: String,
    payload_json: Option<Value>,
    duration_ms: u64,
) -> NativeEvent {
    let mut details = vec![
        ("commandId", json!(command_id.clone())),
        ("durationMs", json!(duration_ms)),
    ];
    push_native_error_details(&mut details, error);
    let diagnostic = native_diagnostic(
        "error",
        "storage",
        "storage.local_write_failed",
        "Native Syncular local write failed",
        details,
    );
    let mut event = native_event(
        NativeEventKind::LocalWriteFailed,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.error = Some(NativeErrorInfo::from_error(error));
    event.command_id = Some(command_id);
    event.payload_json = payload_json;
    event.duration_ms = Some(duration_ms);
    event.lifecycle = Some(native_lifecycle_for_error(error, false, diagnostic));
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
    let mut details = vec![
        ("commandId", json!(command_id.clone())),
        ("durationMs", json!(duration_ms)),
    ];
    push_native_error_details(&mut details, error);
    let diagnostic = native_diagnostic(
        "error",
        "sync",
        "sync.conflict_resolution_failed",
        "Native Syncular conflict resolution failed",
        details,
    );
    let mut event = native_event(
        NativeEventKind::ConflictResolutionFailed,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.error = Some(NativeErrorInfo::from_error(error));
    event.command_id = Some(command_id);
    event.duration_ms = Some(duration_ms);
    event.lifecycle = Some(native_lifecycle_for_error(error, false, diagnostic));
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
    let mut details = vec![
        ("commandId", json!(command_id.clone())),
        ("operation", json!(operation)),
        ("durationMs", json!(duration_ms)),
    ];
    push_native_error_details(&mut details, error);
    let diagnostic = native_diagnostic(
        "error",
        "worker",
        "worker.command_failed",
        "Native Syncular worker command failed",
        details,
    );
    let mut event = native_event(
        NativeEventKind::WorkerCommandFailed,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.error = Some(NativeErrorInfo::from_error(error));
    event.command_id = Some(command_id);
    event.duration_ms = Some(duration_ms);
    event.lifecycle = Some(native_lifecycle_for_error(error, false, diagnostic));
    event
}

fn blob_uploads_changed_event(stats_json: Value) -> NativeEvent {
    let blob_uploads = native_lifecycle_blob_uploads(&stats_json);
    let failed_count = blob_uploads.as_ref().map_or(0, |stats| stats.failed);
    let diagnostic = native_diagnostic(
        if failed_count > 0 { "warn" } else { "info" },
        "blob",
        "blob.uploads_changed",
        "Native Syncular blob upload queue changed",
        [("blobUploads", stats_json.clone())],
    );
    let mut event = native_event(
        NativeEventKind::BlobUploadsChanged,
        Vec::new(),
        Some(diagnostic.clone()),
    );
    event.payload_json = Some(stats_json);
    event.lifecycle = Some(native_lifecycle_state(
        if failed_count > 0 {
            NativeLifecyclePhase::Degraded
        } else {
            NativeLifecyclePhase::Offline
        },
        false,
        failed_count > 0,
        0,
        None,
        None,
        None,
        blob_uploads,
        None,
        Some(diagnostic),
    ));
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
        dropped_count: None,
        resync_required: None,
        auth: None,
        diagnostic,
        tables,
        changed_rows: Vec::new(),
        queries: Vec::new(),
        bootstrap: None,
        lifecycle: None,
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

fn push_native_error_details(details: &mut Vec<(&'static str, Value)>, error: &SyncularError) {
    let classification = error.classification();
    details.push(("errorKind", json!(format!("{:?}", error.kind()))));
    details.push(("errorCode", json!(classification.code)));
    details.push(("errorCategory", json!(classification.category)));
    details.push(("retryable", json!(classification.retryable)));
    details.push((
        "recommendedAction",
        json!(classification.recommended_action),
    ));
}

fn native_auth_info_from_error(error: &SyncularError) -> Option<NativeAuthInfo> {
    if error.kind() != ErrorKind::Transport {
        return None;
    }

    let message = error.message_text();
    let classification = error.classification();
    if classification.code != "sync.auth_required" {
        return None;
    }
    Some(NativeAuthInfo {
        operation: auth_operation_from_message(&message).to_string(),
        status: 401,
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

fn normalize_observed_tables(tables: Vec<String>, app_schema: AppSchema) -> Result<Vec<String>> {
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
        validate_app_table_name(table, app_schema)?;
        normalized.insert(table.to_string());
    }
    Ok(normalized.into_iter().collect())
}

fn normalize_observed_query_dependency_hints(
    hints: Vec<NativeObservedQueryDependencyHint>,
    observed_tables: &[String],
    app_schema: AppSchema,
) -> Result<Vec<NativeObservedQueryDependencyHint>> {
    let observed_tables = observed_tables
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut normalized = Vec::new();
    for hint in hints {
        let table = hint.table.trim();
        if table.is_empty() {
            return Err(SyncularError::config(
                "native observed query dependency hint table is empty",
            ));
        }
        if !observed_tables.contains(table) {
            return Err(SyncularError::config(format!(
                "native observed query dependency hint table {table} is not one of the observed tables"
            )));
        }
        validate_app_table_name(table, app_schema)?;
        let metadata = app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;

        let mut row_ids = BTreeSet::new();
        for row_id in hint.row_ids {
            if row_id.is_empty() {
                return Err(SyncularError::config(
                    "native observed query dependency hint row id is empty",
                ));
            }
            row_ids.insert(row_id);
        }

        let mut fields = BTreeSet::new();
        for field in hint.fields {
            let field = field.trim();
            if field.is_empty() {
                return Err(SyncularError::config(
                    "native observed query dependency hint field is empty",
                ));
            }
            validate_app_column_name(metadata, field)?;
            fields.insert(field.to_string());
        }

        normalized.push(NativeObservedQueryDependencyHint {
            table: table.to_string(),
            row_ids: row_ids.into_iter().collect(),
            fields: fields.into_iter().collect(),
        });
    }
    Ok(normalized)
}

fn observed_query_should_notify(
    query: &NativeObservedQuery,
    changed_tables: &BTreeSet<&str>,
    changed_rows: &[SyncChangedRow],
) -> bool {
    let affected_tables = query
        .tables
        .iter()
        .filter(|table| changed_tables.contains(table.as_str()))
        .collect::<Vec<_>>();
    if affected_tables.is_empty() {
        return false;
    }
    if query.dependency_hints.is_empty() || changed_rows.is_empty() {
        return true;
    }

    for table in affected_tables {
        let table_rows = changed_rows
            .iter()
            .filter(|row| row.table == table.as_str())
            .collect::<Vec<_>>();
        if table_rows.is_empty() {
            return true;
        }
        let table_hints = query
            .dependency_hints
            .iter()
            .filter(|hint| hint.table == table.as_str())
            .collect::<Vec<_>>();
        if table_hints.is_empty() {
            return true;
        }
        if table_rows.iter().any(|row| {
            table_hints
                .iter()
                .any(|hint| hint_matches_changed_row(hint, row))
        }) {
            return true;
        }
    }
    false
}

fn hint_matches_changed_row(
    hint: &NativeObservedQueryDependencyHint,
    row: &SyncChangedRow,
) -> bool {
    let Some(row_id) = row.row_id.as_deref() else {
        return true;
    };
    if !hint.row_ids.is_empty() && !hint.row_ids.iter().any(|id| id == row_id) {
        return false;
    }
    if hint.fields.is_empty() || row.changed_fields.is_empty() {
        return true;
    }
    row.changed_fields
        .iter()
        .any(|field| hint.fields.iter().any(|hint_field| hint_field == field))
}

fn validate_app_table_name(table: &str, app_schema: AppSchema) -> Result<()> {
    if app_schema.table_metadata(table).is_some() {
        return Ok(());
    }

    Err(SyncularError::config(format!(
        "unknown generated app table: {table}"
    )))
}

fn validate_app_column_name(metadata: &AppTableMetadata, column: &str) -> Result<()> {
    if metadata.primary_key_column == column
        || metadata.server_version_column == column
        || metadata
            .columns
            .iter()
            .any(|metadata| metadata.name == column)
    {
        return Ok(());
    }

    Err(SyncularError::config(format!(
        "unknown generated app column {}.{}",
        metadata.name, column
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

#[cfg(test)]
mod tests {
    use super::*;

    fn first_native_event_json(event: SyncWorkerEvent) -> Value {
        let json_events = native_event_json_from_worker_event(event).unwrap();
        serde_json::from_str(&json_events[0]).unwrap()
    }

    #[test]
    fn native_sync_failed_exposes_server_error_classification() {
        let value = first_native_event_json(SyncWorkerEvent::SyncFailed {
            command_id: Some("cmd-1".to_string()),
            error: SyncularError::message(
                ErrorKind::Transport,
                r#"sync failed with HTTP 403: {"error":"sync.forbidden","code":"sync.forbidden","category":"forbidden","retryable":false,"recommendedAction":"checkPermissions","message":"Forbidden"}"#,
            ),
            retry_scheduled: false,
            duration_ms: 12,
        });

        assert_eq!(value["kind"], "SyncFailed");
        assert_eq!(value["error"]["code"], "sync.forbidden");
        assert_eq!(value["error"]["category"], "forbidden");
        assert_eq!(value["error"]["retryable"], false);
        assert_eq!(value["error"]["recommendedAction"], "checkPermissions");
        assert_eq!(
            value["diagnostic"]["details"]["errorCode"],
            "sync.forbidden"
        );
        assert_eq!(
            value["diagnostic"]["details"]["recommendedAction"],
            "checkPermissions"
        );
    }

    #[test]
    fn native_sync_failed_maps_auth_required_to_auth_expired_event() {
        let value = first_native_event_json(SyncWorkerEvent::SyncFailed {
            command_id: Some("cmd-2".to_string()),
            error: SyncularError::message(ErrorKind::Transport, "sync failed with HTTP 401"),
            retry_scheduled: true,
            duration_ms: 34,
        });

        assert_eq!(value["kind"], "AuthExpired");
        assert_eq!(value["auth"]["status"], 401);
        assert_eq!(value["error"]["code"], "sync.auth_required");
        assert_eq!(value["error"]["category"], "auth-required");
        assert_eq!(value["error"]["retryable"], true);
        assert_eq!(value["error"]["recommendedAction"], "refreshAuth");
    }

    #[test]
    fn recent_diagnostic_event_payload_is_redacted_when_too_large() {
        let mut event = native_event(NativeEventKind::WorkerCommandCompleted, Vec::new(), None);
        event.payload_json = Some(json!({
            "body": "x".repeat(MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES + 1)
        }));

        let event = native_event_for_recent_diagnostics(event);
        let payload = event.payload_json.expect("redacted payload");
        assert_eq!(payload["truncated"], true);
        assert_eq!(payload["reason"], "diagnosticPayloadLimit");
        assert_eq!(payload["limit"], "maxNativeDiagnosticEventPayloadJsonBytes");
        assert!(
            payload["originalBytes"].as_u64().unwrap()
                > MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES as u64
        );
    }

    #[test]
    fn native_local_write_failed_exposes_storage_classification() {
        let value = first_native_event_json(SyncWorkerEvent::LocalWriteFailed {
            command_id: "cmd-3".to_string(),
            error: SyncularError::message(ErrorKind::Storage, "database is locked"),
            payload_json: None,
            duration_ms: 56,
        });

        assert_eq!(value["kind"], "LocalWriteFailed");
        assert_eq!(value["error"]["code"], "storage.failed");
        assert_eq!(value["error"]["category"], "storage");
        assert_eq!(value["error"]["recommendedAction"], "inspectStorage");
        assert_eq!(value["diagnostic"]["details"]["errorCategory"], "storage");
    }
}
