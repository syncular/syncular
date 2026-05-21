use crate::app_schema::{
    app_schema_from_config, checksum, empty_app_schema, split_sql_statements,
    validate_app_schema_runtime_features, AppSchema, AppSchemaJson, AppTableMetadata,
};
use crate::binary_snapshot::{
    BinarySnapshotCell, BinarySnapshotPayload, BinarySnapshotRowCursor,
    BorrowedBinarySnapshotRawCellVisitor, DecodedBinarySnapshotRows, SnapshotChunkRows,
};
use crate::client::{
    sync_changed_crdt_field_from_metadata, sync_changed_row_for_local_operation, SubscriptionSpec,
    SyncChangedRow,
};
use crate::compaction::{
    required_compaction_cutoff, tombstone_delete_statements, tombstone_table_names,
    StorageCompactionOptions, StorageCompactionReport,
};
use crate::crdt_field::{validate_crdt_field, CrdtField, CrdtFieldId, CrdtFieldSyncMode};
use crate::crdt_yjs::{
    apply_yjs_envelope_to_payload_json as crdt_apply_yjs_envelope_to_payload_json,
    apply_yjs_text_updates_json as crdt_apply_yjs_text_updates_json, build_yjs_text_update,
    build_yjs_text_update_json as crdt_build_yjs_text_update_json, materialize_row_for_metadata,
    materialize_yjs_row_json as crdt_materialize_yjs_row_json, materialize_yjs_state,
    transform_local_row_for_metadata, validate_crdt_request_json_size,
    validate_yjs_text_input_size, validate_yjs_update_envelope_size,
    yjs_state_vector_base64 as crdt_yjs_state_vector_base64, BuildYjsTextUpdateArgs,
    YjsUpdateEnvelope, YJS_PAYLOAD_KEY,
};
use crate::encrypted_crdt::{
    apply_encrypted_crdt_plaintext_to_row, encrypted_crdt_identity_column,
    encrypted_crdt_normalize_row, encrypted_crdt_row_matches_scopes, encrypted_crdt_scopes_json,
    encrypted_crdt_stream_id, is_encrypted_crdt_system_table, BuildEncryptedCrdtCheckpointArgs,
    BuildEncryptedCrdtTextUpdateArgs, BuildEncryptedCrdtYjsUpdateArgs, EncryptedCrdtStreamStats,
    CRDT_CHECKPOINTS_TABLE, CRDT_UPDATES_TABLE,
};
use crate::encryption::encryption_helpers_json;
use crate::encryption::FieldEncryptionContext;
use crate::error::{ErrorKind, Result, SyncularError};
#[cfg(feature = "web-blobs")]
use crate::limits::DEFAULT_BLOB_UPLOAD_BATCH_LIMIT;
use crate::limits::{validate_unresolved_outbox_capacity, DEFAULT_CRDT_UPDATE_QUEUE_CAPACITY};
#[cfg(feature = "web-blobs")]
use crate::protocol::{
    blob_hash, validate_blob_bytes, validate_blob_hash, validate_blob_ref_size,
    validate_blob_size_bytes, BlobRef,
};
use crate::protocol::{
    sync_operations_json_for_outbox, validate_mutation_batch_json_input_size,
    validate_pending_mutation_batch_size, AuthLeaseProvenance, CrdtStateVectorHint,
    OperationResult, PendingSyncularMutation, PushCommitResponse, ScopeValues, SyncChange,
    SyncOperation,
};
use crate::runtime_schema::{runtime_schema_version, RUNTIME_SYSTEM_SCHEMA_SQL};
use crate::store::{
    next_retry_at, AppSchemaState, AuthLeaseRecord, BlobHealthSummary, ConflictSummary,
    CrdtHealthSummary, OutboxCommit, OutboxSummary, ScopedRowsHealthSummary, ScopedRowsTableHealth,
    SubscriptionState, VerifiedRoot, MAX_SYNC_RETRIES, SYNC_SENDING_TIMEOUT_MS,
};
#[cfg(feature = "web-blobs")]
use crate::store::{BLOB_UPLOAD_STALE_TIMEOUT_MS, MAX_BLOB_UPLOAD_RETRIES};
#[cfg(feature = "web-blobs")]
use crate::transport::web::AsyncBlobTransport;
use crate::transport::web::{WebSyncTransport, WebSyncTransportConfig};
use crate::transport::SyncAuthHeaders;
use crate::web_client::{WebSyncPullOptions, WebSyncularClient, WebSyncularClientConfig};
use crate::web_store::{
    AsyncWebStore, WebSnapshotArtifactApplyMode, WebStoreApplyTimings, WebSubscriptionState,
    WebVerifiedRoot,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use sqlite_wasm_rs as ffi;
use sqlite_wasm_vfs::relaxed_idb::{
    install as install_relaxed_idb, RelaxedIdbCfg, RelaxedIdbCfgBuilder,
};
use sqlite_wasm_vfs::sahpool::{
    install as install_opfs_sahpool, OpfsSAHPoolCfg, OpfsSAHPoolCfgBuilder,
};
use std::ffi::{CStr, CString};
use std::future::Future;
use std::os::raw::{c_char, c_void};
use std::pin::Pin;
use std::ptr;
use uuid::Uuid;
use wasm_bindgen::prelude::*;

const GENERATED_SCHEMA_ID: &str = "syncular-app";
const SNAPSHOT_UPSERT_BATCH_ROWS: usize = 2048;
const SQLITE_BIND_PARAMETER_LIMIT: usize = 32_000;
const QUERY_STATEMENT_CACHE_CAPACITY: usize = 64;
const SNAPSHOT_STATEMENT_CACHE_CAPACITY: usize = 16;
const SQLITE_SNAPSHOT_ARTIFACT_SCHEMA: &str = "__syncular_snapshot_artifact";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedSqliteConfig {
    file_name: Option<String>,
    storage: Option<RustOwnedSqliteStorage>,
    clear_on_init: Option<bool>,
    state_id: Option<String>,
    schema_version: Option<i32>,
    app_schema: Option<AppSchemaJson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedSqliteClientConfig {
    base_url: String,
    client_id: String,
    actor_id: String,
    project_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_pull_options")]
    pull: WebSyncPullOptions,
    file_name: Option<String>,
    storage: Option<RustOwnedSqliteStorage>,
    clear_on_init: Option<bool>,
    state_id: Option<String>,
    schema_version: Option<i32>,
    app_schema: Option<AppSchemaJson>,
}

fn deserialize_pull_options<'de, D>(
    deserializer: D,
) -> std::result::Result<WebSyncPullOptions, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<WebSyncPullOptions>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RustOwnedSqliteStorage {
    Memory,
    IndexedDb,
    OpfsSahPool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedLocalOperationBatchEntry {
    operation: SyncOperation,
    local_row: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedCrdtFieldRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedCrdtFieldTextRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(alias = "next_text")]
    next_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedCrdtFieldYjsUpdateRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    update: YjsUpdateEnvelope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedCrdtFieldCompactionRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(default, alias = "min_uncheckpointed_updates")]
    min_uncheckpointed_updates: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedCrdtFieldLogRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(default)]
    limit: Option<i64>,
}

impl RustOwnedCrdtFieldRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl RustOwnedCrdtFieldTextRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl RustOwnedCrdtFieldYjsUpdateRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl RustOwnedCrdtFieldCompactionRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl RustOwnedCrdtFieldLogRequest {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SqlExecutionMode {
    Readonly,
    Unchecked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BinarySnapshotWriteMode {
    Upsert,
    Insert,
}

#[cfg(feature = "web-blobs")]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RustOwnedBlobStoreOptions {
    mime_type: Option<String>,
    immediate: Option<bool>,
}

#[cfg(feature = "web-blobs")]
#[derive(Debug)]
struct PendingBlobUpload {
    hash: String,
    size: i64,
    mime_type: String,
    body: Vec<u8>,
    attempt_count: i32,
}

#[cfg(feature = "web-blobs")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlobUploadQueueResult {
    uploaded: i32,
    failed: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncularV2WasmRuntimeInfo {
    crate_name: &'static str,
    crate_version: &'static str,
    schema_version: i32,
    features: Vec<&'static str>,
}

#[wasm_bindgen(js_name = syncularV2RuntimeInfoJson)]
pub fn syncular_v2_runtime_info_json() -> String {
    let mut features = vec!["web-owned-sqlite-core"];
    if cfg!(feature = "web-owned-sqlite") {
        features.push("web-owned-sqlite");
    }
    if cfg!(feature = "web-blobs") {
        features.push("blobs");
    }
    if cfg!(feature = "crdt-yjs") {
        features.push("crdt-yjs");
    }
    if cfg!(feature = "e2ee") {
        features.push("e2ee");
    }
    serde_json::to_string(&SyncularV2WasmRuntimeInfo {
        crate_name: env!("CARGO_PKG_NAME"),
        crate_version: env!("CARGO_PKG_VERSION"),
        schema_version: runtime_schema_version(),
        features,
    })
    .expect("runtime info serializes")
}

#[wasm_bindgen(js_name = syncularV2BuildYjsTextUpdateJson)]
pub fn syncular_v2_build_yjs_text_update_json(
    args_json: &str,
) -> std::result::Result<String, JsValue> {
    crdt_build_yjs_text_update_json(args_json).map_err(error_to_js)
}

#[wasm_bindgen(js_name = syncularV2ApplyYjsTextUpdatesJson)]
pub fn syncular_v2_apply_yjs_text_updates_json(
    args_json: &str,
) -> std::result::Result<String, JsValue> {
    crdt_apply_yjs_text_updates_json(args_json).map_err(error_to_js)
}

#[wasm_bindgen(js_name = syncularV2ApplyYjsEnvelopeToPayloadJson)]
pub fn syncular_v2_apply_yjs_envelope_to_payload_json(
    args_json: &str,
) -> std::result::Result<String, JsValue> {
    crdt_apply_yjs_envelope_to_payload_json(args_json).map_err(error_to_js)
}

#[wasm_bindgen(js_name = syncularV2MaterializeYjsRowJson)]
pub fn syncular_v2_materialize_yjs_row_json(
    args_json: &str,
) -> std::result::Result<String, JsValue> {
    crdt_materialize_yjs_row_json(args_json).map_err(error_to_js)
}

#[wasm_bindgen(js_name = syncularV2EncryptionHelperJson)]
pub fn syncular_v2_encryption_helper_json(
    method: &str,
    args_json: &str,
) -> std::result::Result<String, JsValue> {
    encryption_helpers_json(method, args_json).map_err(error_to_js)
}

#[wasm_bindgen(js_name = openSyncularRustOwnedSqlite)]
pub async fn open_syncular_rust_owned_sqlite(
    config: JsValue,
) -> std::result::Result<SyncularRustOwnedSqlite, JsValue> {
    let config: RustOwnedSqliteConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|err| JsValue::from_str(&format!("decode rust-owned sqlite config: {err}")))?;
    SyncularRustOwnedSqlite::open(config)
        .await
        .map_err(error_to_js)
}

#[wasm_bindgen(js_name = openSyncularRustOwnedSqliteClient)]
pub async fn open_syncular_rust_owned_sqlite_client(
    config: JsValue,
) -> std::result::Result<SyncularRustOwnedSqliteClient, JsValue> {
    let config: RustOwnedSqliteClientConfig =
        serde_wasm_bindgen::from_value(config).map_err(|err| {
            JsValue::from_str(&format!("decode rust-owned sqlite client config: {err}"))
        })?;
    SyncularRustOwnedSqliteClient::open(config)
        .await
        .map_err(error_to_js)
}

#[wasm_bindgen(js_name = SyncularRustOwnedSqlite)]
pub struct SyncularRustOwnedSqlite {
    db: *mut ffi::sqlite3,
    state_id: String,
    schema_version: i32,
    app_schema: AppSchema,
    query_statement_cache: Vec<QueryStatementCacheEntry>,
    query_statement_cache_tick: u64,
    snapshot_statement_cache: Vec<SnapshotStatementCacheEntry>,
    snapshot_statement_cache_tick: u64,
    apply_timings: WebStoreApplyTimings,
    live_queries: Vec<LiveQuery>,
    live_events: Vec<LiveQueryEvent>,
    row_events: Vec<RowsChangedEvent>,
    attached_snapshot_artifacts: Vec<AttachedSnapshotArtifact>,
}

#[derive(Debug)]
struct QueryStatementCacheEntry {
    sql: String,
    stmt: *mut ffi::sqlite3_stmt,
    last_used: u64,
}

#[derive(Debug)]
struct SnapshotStatementCacheEntry {
    table: String,
    primary_key_column: String,
    columns: Vec<String>,
    on_conflict: Option<String>,
    row_count: usize,
    mode: BinarySnapshotWriteMode,
    stmt: *mut ffi::sqlite3_stmt,
    last_used: u64,
}

#[derive(Debug)]
struct AttachedSnapshotArtifact {
    schema: String,
    _buffer: Vec<u8>,
}

#[derive(Debug)]
struct LiveQuery {
    id: String,
    params: Vec<Value>,
    tables: Vec<String>,
    dependency_hints: Vec<LiveQueryDependencyHint>,
    last_hash: String,
    stmt: *mut ffi::sqlite3_stmt,
    rerun_count: u64,
    skipped_rerun_count: u64,
    emitted_event_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveQueryDependencyHint {
    table: String,
    #[serde(default)]
    row_ids: Vec<String>,
    #[serde(default)]
    fields: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveQueryEvent {
    query_id: String,
    version: i64,
    changed_rows: Vec<SyncChangedRow>,
    rows: Vec<Value>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveQueryDiagnostics {
    queries: Vec<LiveQueryDiagnostic>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveQueryDiagnostic {
    id: String,
    tables: Vec<String>,
    dependency_hint_count: usize,
    rerun_count: u64,
    skipped_rerun_count: u64,
    emitted_event_count: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RowsChangedEvent {
    source: String,
    changed_tables: Vec<String>,
    changed_rows: Vec<SyncChangedRow>,
}

#[wasm_bindgen(js_name = SyncularRustOwnedSqliteClient)]
pub struct SyncularRustOwnedSqliteClient {
    inner: WebSyncularClient<WebSyncTransport, SyncularRustOwnedSqlite>,
}

#[wasm_bindgen(js_class = SyncularRustOwnedSqlite)]
impl SyncularRustOwnedSqlite {
    async fn open(config: RustOwnedSqliteConfig) -> Result<Self> {
        let storage = config.storage.unwrap_or(RustOwnedSqliteStorage::Memory);
        let file_name = config
            .file_name
            .unwrap_or_else(|| "syncular-rust-owned.sqlite".into());
        let vfs_name = match storage {
            RustOwnedSqliteStorage::Memory => None,
            RustOwnedSqliteStorage::IndexedDb => {
                let cfg = RelaxedIdbCfgBuilder::new()
                    .clear_on_init(config.clear_on_init.unwrap_or(false))
                    .build();
                install_relaxed_idb::<ffi::WasmOsCallback>(&cfg, false)
                    .await
                    .map_err(|err| {
                        SyncularError::message(
                            ErrorKind::Storage,
                            format!("install relaxed-idb vfs: {err}"),
                        )
                    })?;
                Some(RelaxedIdbCfg::default().vfs_name)
            }
            RustOwnedSqliteStorage::OpfsSahPool => {
                let cfg = OpfsSAHPoolCfgBuilder::new()
                    .clear_on_init(config.clear_on_init.unwrap_or(false))
                    .build();
                install_opfs_sahpool::<ffi::WasmOsCallback>(&cfg, false)
                    .await
                    .map_err(|err| {
                        SyncularError::message(
                            ErrorKind::Storage,
                            format!("install opfs-sahpool vfs: {err}"),
                        )
                    })?;
                Some(OpfsSAHPoolCfg::default().vfs_name)
            }
        };

        let mut db = ptr::null_mut();
        let file_name = CString::new(file_name).map_err(cstring_error("sqlite file name"))?;
        let vfs_name = vfs_name
            .map(|name| CString::new(name).map_err(cstring_error("sqlite vfs name")))
            .transpose()?;
        let flags = ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE;
        let rc = unsafe {
            ffi::sqlite3_open_v2(
                file_name.as_ptr(),
                &mut db as *mut _,
                flags,
                vfs_name
                    .as_ref()
                    .map(|name| name.as_ptr())
                    .unwrap_or(ptr::null()),
            )
        };
        if rc != ffi::SQLITE_OK {
            let err = sqlite_error(db, "open sqlite database");
            close_db(db);
            return Err(err);
        }

        let app_schema = config
            .app_schema
            .map(app_schema_from_config)
            .unwrap_or_else(|| {
                empty_app_schema(config.schema_version.unwrap_or_else(runtime_schema_version))
            });
        validate_app_schema_runtime_features(&app_schema)?;
        let schema_version = config
            .schema_version
            .unwrap_or_else(|| app_schema.current_schema_version());

        let store = Self {
            db,
            state_id: config.state_id.unwrap_or_else(|| "default".into()),
            schema_version,
            app_schema,
            query_statement_cache: Vec::new(),
            query_statement_cache_tick: 0,
            snapshot_statement_cache: Vec::new(),
            snapshot_statement_cache_tick: 0,
            apply_timings: WebStoreApplyTimings::default(),
            live_queries: Vec::new(),
            live_events: Vec::new(),
            row_events: Vec::new(),
            attached_snapshot_artifacts: Vec::new(),
        };
        store.configure_sqlite_pragmas(storage)?;
        store.ensure_internal_migrations()?;
        store.ensure_generated_schema_state()?;
        Ok(store)
    }

    #[wasm_bindgen(js_name = applyMutationsBatchJson)]
    pub fn apply_mutations_batch_json(
        &mut self,
        operations_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.apply_mutations_batch_json_inner(operations_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyMutationsCommitJson)]
    pub fn apply_mutations_commit_json(
        &mut self,
        operations_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.apply_mutations_commit_json_inner(operations_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = countRows)]
    pub fn count_rows(&self, table: &str) -> std::result::Result<i32, JsValue> {
        self.count_rows_inner(table).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = generatedSchemaStateJson)]
    pub fn generated_schema_state_json(&self) -> std::result::Result<String, JsValue> {
        self.generated_schema_state_json_inner()
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeSqlJson)]
    pub fn execute_sql_json(
        &mut self,
        sql: &str,
        params_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.execute_sql_json_inner(sql, params_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeSqlValue)]
    pub fn execute_sql_value(
        &mut self,
        sql: &str,
        params: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        self.execute_sql_value_inner_with_mode(sql, params, SqlExecutionMode::Readonly)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeUnsafeSqlJson)]
    pub fn execute_unsafe_sql_json(
        &mut self,
        sql: &str,
        params_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.execute_unsafe_sql_json_inner(sql, params_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeUnsafeSqlValue)]
    pub fn execute_unsafe_sql_value(
        &mut self,
        sql: &str,
        params: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        self.execute_sql_value_inner_with_mode(sql, params, SqlExecutionMode::Unchecked)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = subscribeQueryJson)]
    pub fn subscribe_query_json(
        &mut self,
        sql: &str,
        params_json: &str,
        tables_json: &str,
        hints_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.subscribe_query_json_inner(sql, params_json, tables_json, hints_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = unsubscribeQuery)]
    pub fn unsubscribe_query(&mut self, id: &str) {
        if let Some(index) = self.live_queries.iter().position(|query| query.id == id) {
            let query = self.live_queries.remove(index);
            let _ = finalize_stmt(query.stmt, self.db, "finalize live query");
        }
        self.live_events.retain(|event| event.query_id != id);
    }

    #[wasm_bindgen(js_name = drainLiveQueryEventsJson)]
    pub fn drain_live_query_events_json(&mut self) -> std::result::Result<String, JsValue> {
        let events = std::mem::take(&mut self.live_events);
        serde_json::to_string(&events)
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = liveQueryDiagnosticsJson)]
    pub fn live_query_diagnostics_json(&self) -> std::result::Result<String, JsValue> {
        self.live_query_diagnostics_json_inner()
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = drainRowsChangedEventsJson)]
    pub fn drain_rows_changed_events_json(&mut self) -> std::result::Result<String, JsValue> {
        let events = std::mem::take(&mut self.row_events);
        serde_json::to_string(&events)
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = pendingOutboxJson)]
    pub async fn pending_outbox_json(
        &mut self,
        limit: usize,
    ) -> std::result::Result<String, JsValue> {
        AsyncWebStore::pending_outbox(self, limit)
            .await
            .and_then(|rows| Ok(serde_json::to_string(&rows)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = upsertAuthLeaseJson)]
    pub fn upsert_auth_lease_json(&mut self, lease_json: &str) -> std::result::Result<(), JsValue> {
        let lease: AuthLeaseRecord = serde_json::from_str(lease_json)
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)?;
        self.upsert_auth_lease_sync(&lease).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = authLeaseJson)]
    pub fn auth_lease_json(&self, lease_id: &str) -> std::result::Result<String, JsValue> {
        self.auth_lease_sync(lease_id)
            .and_then(|lease| Ok(serde_json::to_string(&lease)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = activeAuthLeasesJson)]
    pub fn active_auth_leases_json(
        &self,
        actor_id: Option<String>,
        now_ms: i64,
    ) -> std::result::Result<String, JsValue> {
        self.active_auth_leases_sync(actor_id.as_deref(), now_ms)
            .and_then(|leases| Ok(serde_json::to_string(&leases)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = setOutboxAuthLeaseJson)]
    pub fn set_outbox_auth_lease_json(
        &mut self,
        client_commit_id: &str,
        provenance_json: Option<String>,
    ) -> std::result::Result<(), JsValue> {
        let provenance: Option<AuthLeaseProvenance> = provenance_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)?;
        self.set_outbox_auth_lease_sync(client_commit_id, provenance.as_ref())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = insertConflictJson)]
    pub async fn insert_conflict_json(
        &mut self,
        outbox_json: &str,
        result_json: &str,
    ) -> std::result::Result<(), JsValue> {
        let outbox: OutboxCommit = serde_json::from_str(outbox_json)
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)?;
        let result: OperationResult = serde_json::from_str(result_json)
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)?;
        AsyncWebStore::insert_conflict(self, outbox, result)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = conflictSummariesJson)]
    pub async fn conflict_summaries_json(&mut self) -> std::result::Result<String, JsValue> {
        AsyncWebStore::conflict_summaries(self)
            .await
            .and_then(|rows| Ok(serde_json::to_string(&rows)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = retryConflictKeepLocal)]
    pub async fn retry_conflict_keep_local(
        &mut self,
        id: &str,
    ) -> std::result::Result<String, JsValue> {
        AsyncWebStore::retry_conflict_keep_local(self, id)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = resolveConflict)]
    pub async fn resolve_conflict(
        &mut self,
        id: &str,
        resolution: &str,
    ) -> std::result::Result<(), JsValue> {
        AsyncWebStore::resolve_conflict(self, id, resolution)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = subscriptionStateJson)]
    pub async fn subscription_state_json(
        &mut self,
        subscription_id: &str,
    ) -> std::result::Result<String, JsValue> {
        AsyncWebStore::subscription_state(self, subscription_id)
            .await
            .and_then(|state| Ok(serde_json::to_string(&state)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = upsertSubscriptionStateJson)]
    pub async fn upsert_subscription_state_json(
        &mut self,
        state_json: &str,
    ) -> std::result::Result<(), JsValue> {
        let state: WebSubscriptionState = serde_json::from_str(state_json)
            .map_err(SyncularError::protocol)
            .map_err(error_to_js)?;
        AsyncWebStore::upsert_subscription_state(self, state)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = deleteSubscriptionState)]
    pub async fn delete_subscription_state(
        &mut self,
        subscription_id: &str,
    ) -> std::result::Result<(), JsValue> {
        AsyncWebStore::delete_subscription_state(self, subscription_id)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = clearTableForScopesJson)]
    pub async fn clear_table_for_scopes_json(
        &mut self,
        table: &str,
        scopes_json: &str,
    ) -> std::result::Result<(), JsValue> {
        async {
            let scopes: ScopeValues =
                serde_json::from_str(scopes_json).map_err(SyncularError::protocol)?;
            AsyncWebStore::clear_table_for_scopes(self, table, &scopes).await?;
            self.invalidate_live_queries(&[table.to_string()])
        }
        .await
        .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyChangeJson)]
    pub async fn apply_change_json(
        &mut self,
        change_json: &str,
    ) -> std::result::Result<(), JsValue> {
        async {
            let change: SyncChange =
                serde_json::from_str(change_json).map_err(SyncularError::protocol)?;
            let changed_tables = vec![change.table.clone()];
            AsyncWebStore::apply_change(self, change).await?;
            self.invalidate_live_queries(&changed_tables)
        }
        .await
        .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = listTableJson)]
    pub async fn list_table_json(&mut self, table: &str) -> std::result::Result<String, JsValue> {
        AsyncWebStore::list_table_json(self, table)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = close)]
    pub fn close(&mut self) {
        close_db(self.db);
        self.db = ptr::null_mut();
    }
}

#[wasm_bindgen(js_class = SyncularRustOwnedSqliteClient)]
impl SyncularRustOwnedSqliteClient {
    async fn open(config: RustOwnedSqliteClientConfig) -> Result<Self> {
        let store = SyncularRustOwnedSqlite::open(RustOwnedSqliteConfig {
            file_name: config.file_name,
            storage: config.storage,
            clear_on_init: config.clear_on_init,
            state_id: config.state_id,
            schema_version: config.schema_version,
            app_schema: config.app_schema,
        })
        .await?;
        let collect_server_timings = config.pull.collect_server_timings;
        let inner_config = WebSyncularClientConfig {
            base_url: config.base_url,
            client_id: config.client_id,
            actor_id: config.actor_id,
            project_id: config.project_id,
            pull: config.pull,
        };
        let transport = WebSyncTransport::new(WebSyncTransportConfig {
            base_url: inner_config.base_url.clone(),
            client_id: inner_config.client_id.clone(),
            actor_id: inner_config.actor_id.clone(),
            collect_server_timings,
        });
        Ok(Self {
            inner: WebSyncularClient::with_parts(inner_config, transport, store),
        })
    }

    #[wasm_bindgen(js_name = syncPullJson)]
    pub async fn sync_pull_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner.sync_pull_json().await.map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyRealtimeSyncPackBytes)]
    pub async fn apply_realtime_sync_pack_bytes(
        &mut self,
        bytes: &[u8],
    ) -> std::result::Result<String, JsValue> {
        let result = self
            .inner
            .apply_realtime_sync_pack_bytes(bytes)
            .await
            .map_err(error_to_js)?;
        serde_json::to_string(&result).map_err(|err| error_to_js(SyncularError::from(err)))
    }

    #[wasm_bindgen(js_name = syncPushJson)]
    pub async fn sync_push_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner.sync_push_json().await.map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = recoverSyncPushErrorJson)]
    pub fn recover_sync_push_error_json(
        &mut self,
        error_message: &str,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .store_mut()
            .recover_sending_outbox_after_sync_error(error_message)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = syncOnceJson)]
    pub async fn sync_once_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner
            .sync_once()
            .await
            .and_then(|result| Ok(serde_json::to_string(&result)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = transportStatsJson)]
    pub fn transport_stats_json(&self) -> std::result::Result<String, JsValue> {
        self.inner.transport().stats_json().map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = resetTransportStats)]
    pub fn reset_transport_stats(&self) {
        self.inner.transport().reset_stats();
    }

    #[wasm_bindgen(js_name = applyMutationJson)]
    pub async fn apply_mutation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<String>,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .apply_mutation_json(operation_json, local_row_json.as_deref())
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = setSubscriptionsJson)]
    pub fn set_subscriptions_json(
        &mut self,
        subscriptions_json: &str,
    ) -> std::result::Result<(), JsValue> {
        let subscriptions: Vec<SubscriptionSpec> = serde_json::from_str(subscriptions_json)
            .map_err(|err| JsValue::from_str(&format!("decode subscriptions: {err}")))?;
        self.inner
            .set_subscriptions(subscriptions)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = forceSubscriptionsBootstrapJson)]
    pub async fn force_subscriptions_bootstrap_json(
        &mut self,
        subscription_ids_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .force_subscriptions_bootstrap_json(subscription_ids_json)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = localHealthCheckJson)]
    pub async fn local_health_check_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner
            .local_health_check_json()
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = exportLocalSupportBundleJson)]
    pub async fn export_local_support_bundle_json(
        &mut self,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .export_local_support_bundle_json()
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = importLocalSupportBundleJson)]
    pub async fn import_local_support_bundle_json(
        &mut self,
        bundle_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .import_local_support_bundle_json(bundle_json)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = repairLocalHealthJson)]
    pub async fn repair_local_health_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .repair_local_health_json(request_json)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = resetLocalSyncStateJson)]
    pub async fn reset_local_sync_state_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .reset_local_sync_state_json(request_json)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = setAuthHeadersJson)]
    pub fn set_auth_headers_json(
        &mut self,
        headers_json: &str,
    ) -> std::result::Result<(), JsValue> {
        let headers: SyncAuthHeaders = serde_json::from_str(headers_json)
            .map_err(|err| JsValue::from_str(&format!("decode auth headers: {err}")))?;
        self.inner.set_auth_headers(headers);
        Ok(())
    }

    #[wasm_bindgen(js_name = setFieldEncryptionJson)]
    pub fn set_field_encryption_json(
        &mut self,
        config_json: &str,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .set_field_encryption_json(config_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = setEncryptedCrdtJson)]
    pub fn set_encrypted_crdt_json(
        &mut self,
        config_json: &str,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .set_encrypted_crdt_json(config_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = encryptionHelperJson)]
    pub fn encryption_helper_json(
        &mut self,
        method: &str,
        args_json: &str,
    ) -> std::result::Result<String, JsValue> {
        encryption_helpers_json(method, args_json).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = setAbortSignal)]
    pub fn set_abort_signal(&mut self, signal: JsValue) {
        let signal = if signal.is_null() || signal.is_undefined() {
            None
        } else {
            Some(signal)
        };
        self.inner.transport_mut().set_abort_signal(signal);
    }

    #[wasm_bindgen(js_name = generatedSchemaStateJson)]
    pub fn generated_schema_state_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .generated_schema_state_json_inner()
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeSqlJson)]
    pub fn execute_sql_json(
        &mut self,
        sql: &str,
        params_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .execute_sql_json_inner(sql, params_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeSqlValue)]
    pub fn execute_sql_value(
        &mut self,
        sql: &str,
        params: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        self.inner
            .store_mut()
            .execute_sql_value_inner_with_mode(sql, params, SqlExecutionMode::Readonly)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeUnsafeSqlJson)]
    pub fn execute_unsafe_sql_json(
        &mut self,
        sql: &str,
        params_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .execute_unsafe_sql_json_inner(sql, params_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = executeUnsafeSqlValue)]
    pub fn execute_unsafe_sql_value(
        &mut self,
        sql: &str,
        params: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        self.inner
            .store_mut()
            .execute_sql_value_inner_with_mode(sql, params, SqlExecutionMode::Unchecked)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = buildYjsTextUpdateJson)]
    pub fn build_yjs_text_update_json(
        &mut self,
        args_json: &str,
    ) -> std::result::Result<String, JsValue> {
        crdt_build_yjs_text_update_json(args_json).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyYjsTextUpdatesJson)]
    pub fn apply_yjs_text_updates_json(
        &mut self,
        args_json: &str,
    ) -> std::result::Result<String, JsValue> {
        crdt_apply_yjs_text_updates_json(args_json).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyYjsEnvelopeToPayloadJson)]
    pub fn apply_yjs_envelope_to_payload_json(
        &mut self,
        args_json: &str,
    ) -> std::result::Result<String, JsValue> {
        crdt_apply_yjs_envelope_to_payload_json(args_json).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = materializeYjsRowJson)]
    pub fn materialize_yjs_row_json(
        &mut self,
        args_json: &str,
    ) -> std::result::Result<String, JsValue> {
        crdt_materialize_yjs_row_json(args_json).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = yjsStateVectorBase64)]
    pub fn yjs_state_vector_base64(
        &mut self,
        state_base64: Option<String>,
    ) -> std::result::Result<String, JsValue> {
        crdt_yjs_state_vector_base64(state_base64.as_deref()).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = openCrdtFieldJson)]
    pub fn open_crdt_field_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        let field = self
            .inner
            .store()
            .open_crdt_field(request.id())
            .and_then(|field| self.validate_crdt_field_encryption(field))
            .map_err(error_to_js)?;
        Ok(crdt_field_descriptor_json(&field).to_string())
    }

    #[wasm_bindgen(js_name = applyCrdtFieldTextJson)]
    pub fn apply_crdt_field_text_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldTextRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.apply_crdt_field_text(request)
            .map(|receipt| receipt.to_string())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyCrdtFieldYjsUpdateJson)]
    pub fn apply_crdt_field_yjs_update_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldYjsUpdateRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.apply_crdt_field_yjs_update(request)
            .map(|receipt| receipt.to_string())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = materializeCrdtFieldJson)]
    pub fn materialize_crdt_field_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.materialize_crdt_field(request)
            .map(|materialization| materialization.to_string())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = crdtDocumentSnapshotJson)]
    pub fn crdt_document_snapshot_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.crdt_document_snapshot(request)
            .map(|snapshot| snapshot.to_string())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = crdtUpdateLogJson)]
    pub fn crdt_update_log_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldLogRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.crdt_update_log(request)
            .map(|log| log.to_string())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = snapshotCrdtFieldStateVectorJson)]
    pub fn snapshot_crdt_field_state_vector_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.snapshot_crdt_field_state_vector(request)
            .map(|snapshot| snapshot.to_string())
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = compactCrdtFieldJson)]
    pub fn compact_crdt_field_json(
        &mut self,
        request_json: &str,
    ) -> std::result::Result<String, JsValue> {
        validate_crdt_request_json_size(request_json).map_err(error_to_js)?;
        let request: RustOwnedCrdtFieldCompactionRequest = serde_json::from_str(request_json)
            .map_err(|err| error_to_js(SyncularError::from(err)))?;
        self.compact_crdt_field(request)
            .map(|receipt| receipt.to_string())
            .map_err(error_to_js)
    }

    fn validate_crdt_field_encryption(&self, field: CrdtField) -> Result<CrdtField> {
        if field.sync_mode() == CrdtFieldSyncMode::EncryptedUpdateLog
            && self.inner.encrypted_crdt().is_none()
        {
            return Err(SyncularError::config(
                "encrypted CRDT fields require setEncryptedCrdt(...)",
            ));
        }
        Ok(field)
    }

    fn open_validated_crdt_field(&self, id: CrdtFieldId) -> Result<CrdtField> {
        self.inner
            .store()
            .open_crdt_field(id)
            .and_then(|field| self.validate_crdt_field_encryption(field))
    }

    fn apply_crdt_field_text(&mut self, request: RustOwnedCrdtFieldTextRequest) -> Result<Value> {
        validate_yjs_text_input_size(&request.next_text)?;
        let field = self.open_validated_crdt_field(request.id())?;
        if field.field_metadata().kind != "text" {
            return Err(SyncularError::config(format!(
                "applyCrdtFieldText requires a text CRDT field, got {}",
                field.field_metadata().kind
            )));
        }

        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                let current_row = self.inner.store().current_crdt_field_row(&field)?;
                let previous_state_base64 = current_row.as_ref().and_then(|row| {
                    row.get(field.state_column())
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                });
                if previous_state_base64.is_none() {
                    if let Some(existing_text) = current_row
                        .as_ref()
                        .and_then(|row| row.get(field.field()))
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty() && *value != request.next_text)
                    {
                        return Err(SyncularError::config(format!(
                            "cannot replace non-empty CRDT text field {}.{} row {} without existing Yjs state; migrate or initialize {} first (current value: {existing_text:?})",
                            field.table(),
                            field.field(),
                            field.row_id(),
                            field.state_column()
                        )));
                    }
                }
                let update = build_yjs_text_update(BuildYjsTextUpdateArgs {
                    previous_state_base64,
                    next_text: request.next_text,
                    container_key: Some(field.container_key().to_string()),
                    update_id: None,
                })?;
                self.apply_crdt_field_yjs_update(RustOwnedCrdtFieldYjsUpdateRequest {
                    table: field.table().to_string(),
                    row_id: field.row_id().to_string(),
                    field: field.field().to_string(),
                    update: update.update,
                })
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                let encryption = self.inner.encrypted_crdt().cloned().ok_or_else(|| {
                    SyncularError::config("encrypted CRDT fields require setEncryptedCrdt(...)")
                })?;
                let existing_row = self.require_crdt_field_row(&field)?;
                let mutation =
                    encryption.build_text_update_mutation(BuildEncryptedCrdtTextUpdateArgs {
                        ctx: self.crdt_encryption_context(),
                        metadata: field.metadata(),
                        field: field.field(),
                        row_id: field.row_id(),
                        existing_row: &existing_row,
                        next_text: &request.next_text,
                    })?;
                let client_commit_id = self
                    .inner
                    .store_mut()
                    .apply_pending_mutation_commit(mutation, &[field.table()])?;
                Ok(crdt_field_write_receipt(
                    &client_commit_id,
                    field.sync_mode(),
                ))
            }
        }
    }

    fn apply_crdt_field_yjs_update(
        &mut self,
        request: RustOwnedCrdtFieldYjsUpdateRequest,
    ) -> Result<Value> {
        validate_yjs_update_envelope_size(&request.update)?;
        let field = self.open_validated_crdt_field(request.id())?;
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                self.inner.store().assert_crdt_document_capacity(
                    &field.document_key(),
                    DEFAULT_CRDT_UPDATE_QUEUE_CAPACITY,
                )?;
                let mut envelope = Map::new();
                envelope.insert(
                    field.field().to_string(),
                    serde_json::to_value(&request.update)?,
                );
                let mut payload = Map::new();
                payload.insert(YJS_PAYLOAD_KEY.to_string(), Value::Object(envelope));
                let operation = SyncOperation {
                    table: field.table().to_string(),
                    row_id: field.row_id().to_string(),
                    op: "upsert".to_string(),
                    payload: Some(Value::Object(payload)),
                    base_version: None,
                };
                let client_commit_id = self.inner.store_mut().apply_crdt_field_operation(
                    &field,
                    operation,
                    request.update,
                )?;
                Ok(crdt_field_write_receipt(
                    &client_commit_id,
                    field.sync_mode(),
                ))
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                let encryption = self.inner.encrypted_crdt().cloned().ok_or_else(|| {
                    SyncularError::config("encrypted CRDT fields require setEncryptedCrdt(...)")
                })?;
                let existing_row = self.require_crdt_field_row(&field)?;
                let mutation =
                    encryption.build_yjs_update_mutation(BuildEncryptedCrdtYjsUpdateArgs {
                        ctx: self.crdt_encryption_context(),
                        metadata: field.metadata(),
                        field: field.field(),
                        row_id: field.row_id(),
                        existing_row: &existing_row,
                        update: request.update,
                    })?;
                let client_commit_id = self
                    .inner
                    .store_mut()
                    .apply_pending_mutation_commit(mutation, &[field.table()])?;
                Ok(crdt_field_write_receipt(
                    &client_commit_id,
                    field.sync_mode(),
                ))
            }
        }
    }

    fn materialize_crdt_field(&mut self, request: RustOwnedCrdtFieldRequest) -> Result<Value> {
        let field = self.open_validated_crdt_field(request.id())?;
        let row = self.require_crdt_field_row(&field)?;
        let state_base64 = row
            .get(field.state_column())
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let value = match state_base64.as_deref() {
            Some(state_base64) => materialize_yjs_state(state_base64, &field.yjs_rule()?)?,
            None => row.get(field.field()).cloned().unwrap_or(Value::Null),
        };
        Ok(json!({
            "value": value,
            "stateBase64": state_base64,
            "stateVectorBase64": crdt_yjs_state_vector_base64(state_base64.as_deref())?
        }))
    }

    fn crdt_document_snapshot(&mut self, request: RustOwnedCrdtFieldRequest) -> Result<Value> {
        let field = self.open_validated_crdt_field(request.id())?;
        self.inner.store().crdt_document_snapshot(&field)
    }

    fn crdt_update_log(&mut self, request: RustOwnedCrdtFieldLogRequest) -> Result<Value> {
        let field = self.open_validated_crdt_field(request.id())?;
        self.inner
            .store()
            .crdt_update_log(&field, request.limit.unwrap_or(100))
    }

    fn snapshot_crdt_field_state_vector(
        &mut self,
        request: RustOwnedCrdtFieldRequest,
    ) -> Result<Value> {
        let field = self.open_validated_crdt_field(request.id())?;
        let row = self.inner.store().current_crdt_field_row(&field)?;
        let state_base64 = row.as_ref().and_then(|row| {
            row.get(field.state_column())
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
        Ok(json!({
            "stateVectorBase64": crdt_yjs_state_vector_base64(state_base64)?
        }))
    }

    fn compact_crdt_field(
        &mut self,
        request: RustOwnedCrdtFieldCompactionRequest,
    ) -> Result<Value> {
        let field = self.open_validated_crdt_field(request.id())?;
        let before_snapshot = self.inner.store().crdt_document_snapshot(&field)?;
        let before = crdt_compaction_stats_from_snapshot(&before_snapshot);
        let encrypted_stream_before = self.encrypted_crdt_stream_stats_for_field(&field)?;
        match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => {
                let after_snapshot = self.inner.store().compact_crdt_document(&field)?;
                self.inner
                    .store_mut()
                    .notify_local_tables_changed_with_rows(
                        &[field.table().to_string()],
                        &[crdt_field_compacted_changed_row(&field, None)],
                    )?;
                Ok(json!({
                    "checkpointCreated": false,
                    "clientCommitId": Value::Null,
                    "before": before,
                    "after": crdt_compaction_stats_from_snapshot(&after_snapshot),
                    "encryptedStreamBefore": encrypted_stream_before,
                    "encryptedStreamAfter": self.encrypted_crdt_stream_stats_for_field(&field)?
                }))
            }
            CrdtFieldSyncMode::EncryptedUpdateLog => {
                let min_uncheckpointed_updates = request.min_uncheckpointed_updates.unwrap_or(1);
                if min_uncheckpointed_updates < 1 {
                    return Err(SyncularError::config(
                        "encrypted CRDT checkpoint threshold must be at least 1",
                    ));
                }
                let encryption = self.inner.encrypted_crdt().cloned().ok_or_else(|| {
                    SyncularError::config("encrypted CRDT fields require setEncryptedCrdt(...)")
                })?;
                let stream_id =
                    encrypted_crdt_stream_id(field.table(), field.row_id(), field.field());
                let stats = self
                    .inner
                    .store()
                    .encrypted_crdt_stream_stats(encryption.partition_id(), &stream_id)?;
                if stats.checkpointable_update_count < min_uncheckpointed_updates {
                    let after_snapshot = self.inner.store().crdt_document_snapshot(&field)?;
                    return Ok(json!({
                        "checkpointCreated": false,
                        "clientCommitId": Value::Null,
                        "before": before,
                        "after": crdt_compaction_stats_from_snapshot(&after_snapshot),
                        "encryptedStreamBefore": encrypted_stream_before,
                        "encryptedStreamAfter": self.encrypted_crdt_stream_stats_for_field(&field)?
                    }));
                }
                let Some(covers_seq) = stats.max_server_seq else {
                    let after_snapshot = self.inner.store().crdt_document_snapshot(&field)?;
                    return Ok(json!({
                        "checkpointCreated": false,
                        "clientCommitId": Value::Null,
                        "before": before,
                        "after": crdt_compaction_stats_from_snapshot(&after_snapshot),
                        "encryptedStreamBefore": encrypted_stream_before,
                        "encryptedStreamAfter": self.encrypted_crdt_stream_stats_for_field(&field)?
                    }));
                };
                if stats
                    .latest_checkpoint_covers_seq
                    .is_some_and(|latest| latest >= covers_seq)
                {
                    let after_snapshot = self.inner.store().crdt_document_snapshot(&field)?;
                    return Ok(json!({
                        "checkpointCreated": false,
                        "clientCommitId": Value::Null,
                        "before": before,
                        "after": crdt_compaction_stats_from_snapshot(&after_snapshot),
                        "encryptedStreamBefore": encrypted_stream_before,
                        "encryptedStreamAfter": self.encrypted_crdt_stream_stats_for_field(&field)?
                    }));
                }
                let existing_row = self.require_crdt_field_row(&field)?;
                let mutation =
                    encryption.build_checkpoint_mutation(BuildEncryptedCrdtCheckpointArgs {
                        ctx: self.crdt_encryption_context(),
                        metadata: field.metadata(),
                        field: field.field(),
                        row_id: field.row_id(),
                        existing_row: &existing_row,
                        covers_seq,
                    })?;
                let client_commit_id = self
                    .inner
                    .store_mut()
                    .apply_pending_mutation_commit(mutation, &[field.table()])?;
                let after_snapshot = self.inner.store().crdt_document_snapshot(&field)?;
                Ok(json!({
                    "checkpointCreated": true,
                    "clientCommitId": client_commit_id,
                    "before": before,
                    "after": crdt_compaction_stats_from_snapshot(&after_snapshot),
                    "encryptedStreamBefore": encrypted_stream_before,
                    "encryptedStreamAfter": self.encrypted_crdt_stream_stats_for_field(&field)?
                }))
            }
        }
    }

    fn encrypted_crdt_stream_stats_for_field(
        &self,
        field: &CrdtField,
    ) -> Result<Option<EncryptedCrdtStreamStats>> {
        if field.sync_mode() != CrdtFieldSyncMode::EncryptedUpdateLog {
            return Ok(None);
        }
        let Some(encryption) = self.inner.encrypted_crdt() else {
            return Ok(None);
        };
        let stream_id = encrypted_crdt_stream_id(field.table(), field.row_id(), field.field());
        self.inner
            .store()
            .encrypted_crdt_stream_stats(encryption.partition_id(), &stream_id)
            .map(Some)
    }

    fn require_crdt_field_row(&self, field: &CrdtField) -> Result<Value> {
        self.inner
            .store()
            .current_crdt_field_row(field)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot update CRDT field {}.{} before local row {} exists",
                    field.table(),
                    field.field(),
                    field.row_id()
                ))
            })
    }

    fn crdt_encryption_context(&self) -> FieldEncryptionContext {
        FieldEncryptionContext {
            actor_id: self.inner.config().actor_id.clone(),
            client_id: self.inner.config().client_id.clone(),
        }
    }

    #[wasm_bindgen(js_name = subscribeQueryJson)]
    pub fn subscribe_query_json(
        &mut self,
        sql: &str,
        params_json: &str,
        tables_json: &str,
        hints_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .subscribe_query_json_inner(sql, params_json, tables_json, hints_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = unsubscribeQuery)]
    pub fn unsubscribe_query(&mut self, id: &str) {
        self.inner.store_mut().unsubscribe_query(id);
    }

    #[wasm_bindgen(js_name = drainLiveQueryEventsJson)]
    pub fn drain_live_query_events_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner.store_mut().drain_live_query_events_json()
    }

    #[wasm_bindgen(js_name = liveQueryDiagnosticsJson)]
    pub fn live_query_diagnostics_json(&self) -> std::result::Result<String, JsValue> {
        self.inner.store().live_query_diagnostics_json()
    }

    #[wasm_bindgen(js_name = drainRowsChangedEventsJson)]
    pub fn drain_rows_changed_events_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner.store_mut().drain_rows_changed_events_json()
    }

    #[wasm_bindgen(js_name = applyMutationsBatchJson)]
    pub fn apply_mutations_batch_json(
        &mut self,
        operations_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .apply_mutations_batch_json_inner(operations_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyMutationsCommitJson)]
    pub fn apply_mutations_commit_json(
        &mut self,
        operations_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .apply_mutations_commit_json_inner(operations_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = upsertAuthLeaseJson)]
    pub fn upsert_auth_lease_json(&mut self, lease_json: &str) -> std::result::Result<(), JsValue> {
        self.inner.store_mut().upsert_auth_lease_json(lease_json)
    }

    #[wasm_bindgen(js_name = authLeaseJson)]
    pub fn auth_lease_json(&self, lease_id: &str) -> std::result::Result<String, JsValue> {
        self.inner.store().auth_lease_json(lease_id)
    }

    #[wasm_bindgen(js_name = activeAuthLeasesJson)]
    pub fn active_auth_leases_json(
        &self,
        actor_id: Option<String>,
        now_ms: i64,
    ) -> std::result::Result<String, JsValue> {
        self.inner.store().active_auth_leases_json(actor_id, now_ms)
    }

    #[wasm_bindgen(js_name = setOutboxAuthLeaseJson)]
    pub fn set_outbox_auth_lease_json(
        &mut self,
        client_commit_id: &str,
        provenance_json: Option<String>,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .store_mut()
            .set_outbox_auth_lease_json(client_commit_id, provenance_json)
    }

    #[wasm_bindgen(js_name = conflictSummariesJson)]
    pub async fn conflict_summaries_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner
            .conflict_summaries_json()
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = resolveConflict)]
    pub async fn resolve_conflict(
        &mut self,
        id: &str,
        resolution: &str,
    ) -> std::result::Result<(), JsValue> {
        self.inner
            .resolve_conflict(id, resolution)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = retryConflictKeepLocal)]
    pub async fn retry_conflict_keep_local(
        &mut self,
        id: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .retry_conflict_keep_local(id)
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = listTableJson)]
    pub async fn list_table_json(&mut self, table: &str) -> std::result::Result<String, JsValue> {
        self.inner.list_table_json(table).await.map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = storeBlobJson)]
    pub async fn store_blob_json(
        &mut self,
        data: Vec<u8>,
        options_json: &str,
    ) -> std::result::Result<String, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            let _ = data;
            let _ = options_json;
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        async {
            let options = parse_blob_store_options(options_json)?;
            let immediate = options.immediate.unwrap_or(false);
            let transport = self.inner.transport().clone();
            let blob = self
                .inner
                .store_mut()
                .store_blob_inner(&data, &options, !immediate)?;
            if immediate {
                transport.upload_blob(&blob, &data).await?;
            }
            Ok(serde_json::to_string(&blob)?)
        }
        .await
        .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = retrieveBlob)]
    pub async fn retrieve_blob(&mut self, ref_json: &str) -> std::result::Result<Vec<u8>, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            let _ = ref_json;
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        async {
            let blob: BlobRef = serde_json::from_str(ref_json).map_err(SyncularError::protocol)?;
            if let Some(bytes) = self.inner.store_mut().read_cached_blob(&blob.hash)? {
                return Ok(bytes);
            }
            let transport = self.inner.transport().clone();
            let bytes = transport.download_blob(&blob).await?;
            validate_blob_bytes(&blob, &bytes)?;
            self.inner.store_mut().cache_blob(&blob, &bytes)?;
            Ok(bytes)
        }
        .await
        .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = isBlobLocal)]
    pub fn is_blob_local(&mut self, hash: &str) -> std::result::Result<bool, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            let _ = hash;
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        self.inner
            .store_mut()
            .is_blob_local_inner(hash)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = processBlobUploadQueueJson)]
    pub async fn process_blob_upload_queue_json(&mut self) -> std::result::Result<String, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        async {
            let transport = self.inner.transport().clone();
            let result = self
                .inner
                .store_mut()
                .process_blob_upload_queue(&transport)
                .await?;
            Ok(serde_json::to_string(&result)?)
        }
        .await
        .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = blobUploadQueueStatsJson)]
    pub fn blob_upload_queue_stats_json(&mut self) -> std::result::Result<String, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        self.inner
            .store_mut()
            .blob_upload_queue_stats_json_inner()
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = blobCacheStatsJson)]
    pub fn blob_cache_stats_json(&mut self) -> std::result::Result<String, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        self.inner
            .store_mut()
            .blob_cache_stats_json_inner()
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = pruneBlobCache)]
    pub fn prune_blob_cache(&mut self, max_bytes: i64) -> std::result::Result<i64, JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            let _ = max_bytes;
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        self.inner
            .store_mut()
            .prune_blob_cache_inner(max_bytes)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = clearBlobCache)]
    pub fn clear_blob_cache(&mut self) -> std::result::Result<(), JsValue> {
        #[cfg(not(feature = "web-blobs"))]
        {
            return Err(web_blobs_feature_disabled()).map_err(error_to_js);
        }
        #[cfg(feature = "web-blobs")]
        self.inner
            .store_mut()
            .clear_blob_cache_inner()
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = compactStorageJson)]
    pub fn compact_storage_json(
        &mut self,
        options_json: &str,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .store_mut()
            .compact_storage_json_inner(options_json)
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = close)]
    pub fn close(&mut self) {
        self.inner.store_mut().close();
    }
}

impl SyncularRustOwnedSqlite {
    fn configure_sqlite_pragmas(&self, storage: RustOwnedSqliteStorage) -> Result<()> {
        self.exec("PRAGMA foreign_keys = ON")?;
        self.exec("PRAGMA busy_timeout = 5000")?;
        self.exec("PRAGMA temp_store = MEMORY")?;
        match storage {
            RustOwnedSqliteStorage::Memory => {
                self.exec("PRAGMA locking_mode = EXCLUSIVE")?;
                self.exec("PRAGMA journal_mode = MEMORY")?;
                self.exec("PRAGMA synchronous = OFF")?;
            }
            RustOwnedSqliteStorage::IndexedDb | RustOwnedSqliteStorage::OpfsSahPool => {
                let _ = self.exec("PRAGMA journal_mode = WAL");
                let _ = self.exec("PRAGMA synchronous = NORMAL");
            }
        }
        Ok(())
    }

    fn ensure_internal_migrations(&self) -> Result<()> {
        self.exec(
            "CREATE TABLE IF NOT EXISTS sync_migrations (\
             version TEXT PRIMARY KEY, \
             name TEXT NOT NULL, \
             checksum TEXT NOT NULL, \
             applied_at BIGINT NOT NULL)",
        )?;

        let version = "__syncular_runtime";
        let name = "runtime_system_schema";
        let expected_checksum = checksum(RUNTIME_SYSTEM_SCHEMA_SQL);

        self.exec("BEGIN IMMEDIATE")?;
        let result = (|| {
            for statement in split_sql_statements(RUNTIME_SYSTEM_SCHEMA_SQL) {
                self.exec(&statement)?;
            }
            self.ensure_runtime_system_schema_upgrades()?;
            self.exec(&format!(
                "INSERT INTO sync_migrations (version, name, checksum, applied_at) \
                 VALUES ({version}, {name}, {checksum}, {applied_at}) \
                 ON CONFLICT(version) DO UPDATE SET \
                   name = excluded.name, \
                   checksum = excluded.checksum, \
                   applied_at = excluded.applied_at",
                version = sql_string(version),
                name = sql_string(name),
                checksum = sql_string(&expected_checksum),
                applied_at = now_ms()
            ))
        })();

        match result {
            Ok(()) => self.exec("COMMIT")?,
            Err(err) => {
                let _ = self.exec("ROLLBACK");
                return Err(err);
            }
        }

        Ok(())
    }

    fn ensure_runtime_system_schema_upgrades(&self) -> Result<()> {
        self.add_column_if_missing(
            "sync_outbox_commits",
            "lease_id",
            "ALTER TABLE sync_outbox_commits ADD COLUMN lease_id TEXT NULL",
        )?;
        self.add_column_if_missing(
            "sync_outbox_commits",
            "lease_expires_at_ms",
            "ALTER TABLE sync_outbox_commits ADD COLUMN lease_expires_at_ms BIGINT NULL",
        )?;
        self.add_column_if_missing(
            "sync_outbox_commits",
            "lease_status_at_enqueue",
            "ALTER TABLE sync_outbox_commits ADD COLUMN lease_status_at_enqueue TEXT NULL",
        )?;
        self.add_column_if_missing(
            "sync_outbox_commits",
            "lease_scope_summary_json",
            "ALTER TABLE sync_outbox_commits ADD COLUMN lease_scope_summary_json TEXT NULL",
        )
    }

    fn add_column_if_missing(&self, table: &str, column: &str, alter_sql: &str) -> Result<()> {
        let columns = self.query_rows(
            &format!("SELECT name FROM pragma_table_info({})", sql_string(table)),
            |row| row.string("name"),
        )?;
        if columns.iter().any(|name| name == column) {
            return Ok(());
        }
        self.exec(alter_sql)
    }

    fn ensure_generated_schema_state(&self) -> Result<()> {
        self.exec(
            "CREATE TABLE IF NOT EXISTS syncular_app_schema (\
             schema_id TEXT PRIMARY KEY, \
             schema_version INTEGER NOT NULL, \
             updated_at BIGINT NOT NULL)",
        )?;
        let rows = self.query_rows(
            &format!(
                "SELECT schema_version FROM syncular_app_schema WHERE schema_id = {} LIMIT 1",
                sql_string(GENERATED_SCHEMA_ID)
            ),
            |row| row.i32("schema_version"),
        )?;
        if let Some(local_version) = rows.first().copied() {
            let current = self.schema_version;
            if local_version > current {
                return Err(SyncularError::schema(format!(
                    "Syncular app schema version mismatch: local {local_version}, configured {current}"
                )));
            }
            if local_version == current {
                self.validate_generated_app_schema()?;
            }
        }
        Ok(())
    }

    fn validate_generated_app_schema(&self) -> Result<()> {
        for table in self.app_schema.app_table_metadata {
            let actual = self.query_rows(
                &format!(
                    "SELECT name, type, \"notnull\" AS not_null, pk FROM pragma_table_info({})",
                    sql_string(table.name)
                ),
                |row| {
                    Ok(SqliteColumnInfo {
                        name: row.string("name")?,
                        type_family: sqlite_type_family(&row.string("type")?),
                        notnull: row.i32("not_null")? > 0,
                        primary_key: row.i32("pk")? > 0,
                    })
                },
            )?;

            for expected in table.columns {
                let Some(found) = actual.iter().find(|column| column.name == expected.name) else {
                    return Err(SyncularError::schema(format!(
                        "Syncular app schema mismatch: {}.{} is missing",
                        table.name, expected.name
                    )));
                };
                if found.type_family != expected.type_family {
                    return Err(SyncularError::schema(format!(
                        "Syncular app schema mismatch: {}.{} has type {}, expected {}",
                        table.name, expected.name, found.type_family, expected.type_family
                    )));
                }
                if expected.primary_key && !found.primary_key {
                    return Err(SyncularError::schema(format!(
                        "Syncular app schema mismatch: {}.{} is not a primary key",
                        table.name, expected.name
                    )));
                }
                if expected.notnull_required && !found.notnull && !found.primary_key {
                    return Err(SyncularError::schema(format!(
                        "Syncular app schema mismatch: {}.{} is nullable",
                        table.name, expected.name
                    )));
                }
            }
        }
        Ok(())
    }

    fn generated_schema_state_json_inner(&self) -> Result<String> {
        let rows = self.query_rows(
            &format!(
                "SELECT schema_version, updated_at FROM syncular_app_schema WHERE schema_id = {} LIMIT 1",
                sql_string(GENERATED_SCHEMA_ID)
            ),
            |row| {
                Ok(serde_json::json!({
                    "schemaId": GENERATED_SCHEMA_ID,
                    "schemaVersion": row.i32("schema_version")?,
                    "currentSchemaVersion": self.schema_version,
                    "updatedAt": row.i64("updated_at")?,
                }))
            },
        )?;
        Ok(serde_json::to_string(
            &rows.into_iter().next().unwrap_or_else(|| {
                serde_json::json!({
                    "schemaId": GENERATED_SCHEMA_ID,
                    "schemaVersion": null,
                    "currentSchemaVersion": self.schema_version,
                    "updatedAt": null,
                })
            }),
        )?)
    }

    #[cfg(feature = "web-blobs")]
    fn store_blob_inner(
        &self,
        data: &[u8],
        options: &RustOwnedBlobStoreOptions,
        enqueue_upload: bool,
    ) -> Result<BlobRef> {
        let mime_type = options
            .mime_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let size = i64::try_from(data.len()).map_err(|_| {
            SyncularError::protocol_message("blob is too large for SQLite size metadata")
        })?;
        validate_blob_size_bytes(size)?;
        let blob = BlobRef {
            hash: blob_hash(data),
            size,
            mime_type,
            encrypted: false,
            key_id: None,
        };
        self.exec("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.cache_blob(&blob, data)?;
            if enqueue_upload {
                self.enqueue_blob_upload(&blob, data)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.exec("COMMIT")?;
                Ok(blob)
            }
            Err(err) => {
                let _ = self.exec("ROLLBACK");
                Err(err)
            }
        }
    }

    #[cfg(feature = "web-blobs")]
    fn cache_blob(&self, blob: &BlobRef, data: &[u8]) -> Result<()> {
        validate_blob_bytes(blob, data)?;
        let now = now_ms();
        self.execute_blob_statement(
            "INSERT INTO sync_blob_cache \
             (hash, size, mime_type, body, encrypted, key_id, cached_at, last_accessed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(hash) DO UPDATE SET \
               size = excluded.size, mime_type = excluded.mime_type, body = excluded.body, \
               encrypted = excluded.encrypted, key_id = excluded.key_id, \
               last_accessed_at = excluded.last_accessed_at",
            |stmt| {
                bind_text(stmt, 1, &blob.hash)?;
                bind_i64(stmt, 2, blob.size)?;
                bind_text(stmt, 3, &blob.mime_type)?;
                bind_blob(stmt, 4, data)?;
                bind_i64(stmt, 5, if blob.encrypted { 1 } else { 0 })?;
                bind_optional_text(stmt, 6, blob.key_id.as_deref())?;
                bind_i64(stmt, 7, now)?;
                bind_i64(stmt, 8, now)
            },
        )
    }

    #[cfg(feature = "web-blobs")]
    fn enqueue_blob_upload(&self, blob: &BlobRef, data: &[u8]) -> Result<()> {
        let now = now_ms();
        self.execute_blob_statement(
            "INSERT INTO sync_blob_outbox \
             (hash, size, mime_type, body, encrypted, key_id, status, attempt_count, error, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, NULL, ?7, ?8) \
             ON CONFLICT(hash) DO NOTHING",
            |stmt| {
                bind_text(stmt, 1, &blob.hash)?;
                bind_i64(stmt, 2, blob.size)?;
                bind_text(stmt, 3, &blob.mime_type)?;
                bind_blob(stmt, 4, data)?;
                bind_i64(stmt, 5, if blob.encrypted { 1 } else { 0 })?;
                bind_optional_text(stmt, 6, blob.key_id.as_deref())?;
                bind_i64(stmt, 7, now)?;
                bind_i64(stmt, 8, now)
            },
        )
    }

    #[cfg(feature = "web-blobs")]
    fn read_cached_blob(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        validate_blob_hash(hash)?;
        let rows = self.query_rows(
            &format!(
                "SELECT body FROM sync_blob_cache WHERE hash = {} LIMIT 1",
                sql_string(hash)
            ),
            |row| row.bytes("body"),
        )?;
        let Some(bytes) = rows.into_iter().next() else {
            return Ok(None);
        };
        self.exec(&format!(
            "UPDATE sync_blob_cache SET last_accessed_at = {now} WHERE hash = {hash}",
            now = now_ms(),
            hash = sql_string(hash)
        ))?;
        Ok(Some(bytes))
    }

    #[cfg(feature = "web-blobs")]
    fn is_blob_local_inner(&self, hash: &str) -> Result<bool> {
        validate_blob_hash(hash)?;
        let rows = self.query_rows(
            &format!(
                "SELECT 1 AS found FROM sync_blob_cache WHERE hash = {} LIMIT 1",
                sql_string(hash)
            ),
            |row| row.i32("found"),
        )?;
        Ok(!rows.is_empty())
    }

    #[cfg(feature = "web-blobs")]
    async fn process_blob_upload_queue<T: AsyncBlobTransport>(
        &self,
        transport: &T,
    ) -> Result<BlobUploadQueueResult> {
        self.requeue_stale_blob_uploads()?;
        let pending = self.pending_blob_uploads(DEFAULT_BLOB_UPLOAD_BATCH_LIMIT)?;
        let mut result = BlobUploadQueueResult {
            uploaded: 0,
            failed: 0,
        };

        for item in pending {
            let next_attempt_count = item.attempt_count + 1;
            self.mark_blob_uploading(&item.hash, next_attempt_count)?;
            let blob = BlobRef {
                hash: item.hash.clone(),
                size: item.size,
                mime_type: item.mime_type.clone(),
                encrypted: false,
                key_id: None,
            };

            match transport.upload_blob(&blob, &item.body).await {
                Ok(()) => {
                    self.delete_blob_upload(&item.hash)?;
                    result.uploaded += 1;
                }
                Err(err) => {
                    let failed = next_attempt_count >= MAX_BLOB_UPLOAD_RETRIES;
                    let now = now_ms();
                    self.mark_blob_upload_error(
                        &item.hash,
                        if failed { "failed" } else { "pending" },
                        &err.to_string(),
                        if failed {
                            0
                        } else {
                            next_retry_at(now, next_attempt_count)
                        },
                    )?;
                    if failed {
                        result.failed += 1;
                    }
                }
            }
        }

        Ok(result)
    }

    #[cfg(feature = "web-blobs")]
    fn requeue_stale_blob_uploads(&self) -> Result<()> {
        let now = now_ms();
        let stale_before = now - BLOB_UPLOAD_STALE_TIMEOUT_MS;
        self.exec(&format!(
            "UPDATE sync_blob_outbox SET \
               status = CASE WHEN attempt_count >= {max_retries} THEN 'failed' ELSE 'pending' END, \
               error = CASE WHEN attempt_count >= {max_retries} \
                 THEN 'Upload timed out while in uploading state' \
                 ELSE 'Upload timed out while in uploading state; retrying' END, \
               next_attempt_at = CASE WHEN attempt_count >= {max_retries} THEN 0 ELSE {now} END, \
               updated_at = {now} \
             WHERE status = 'uploading' AND updated_at < {stale_before}",
            max_retries = MAX_BLOB_UPLOAD_RETRIES,
        ))
    }

    #[cfg(feature = "web-blobs")]
    fn pending_blob_uploads(&self, limit: i64) -> Result<Vec<PendingBlobUpload>> {
        let now = now_ms();
        self.query_rows(
            &format!(
                "SELECT hash, size, mime_type, body, attempt_count \
                 FROM sync_blob_outbox \
                 WHERE status = 'pending' AND attempt_count < {max_retries} AND next_attempt_at <= {now} \
                 ORDER BY created_at ASC LIMIT {limit}",
                max_retries = MAX_BLOB_UPLOAD_RETRIES
            ),
            |row| {
                Ok(PendingBlobUpload {
                    hash: row.string("hash")?,
                    size: row.i64("size")?,
                    mime_type: row.string("mime_type")?,
                    body: row.bytes("body")?,
                    attempt_count: row.i32("attempt_count")?,
                })
            },
        )
    }

    #[cfg(feature = "web-blobs")]
    fn mark_blob_uploading(&self, hash: &str, attempt_count: i32) -> Result<()> {
        self.exec(&format!(
            "UPDATE sync_blob_outbox SET status = 'uploading', attempt_count = {attempt_count}, \
             error = NULL, next_attempt_at = 0, updated_at = {now} WHERE hash = {hash} AND status = 'pending'",
            now = now_ms(),
            hash = sql_string(hash)
        ))
    }

    #[cfg(feature = "web-blobs")]
    fn mark_blob_upload_error(
        &self,
        hash: &str,
        status: &str,
        error: &str,
        next_attempt_at: i64,
    ) -> Result<()> {
        self.exec(&format!(
            "UPDATE sync_blob_outbox SET status = {status}, error = {error}, \
             next_attempt_at = {next_attempt_at}, updated_at = {now} \
             WHERE hash = {hash}",
            status = sql_string(status),
            error = sql_string(error),
            next_attempt_at = next_attempt_at,
            now = now_ms(),
            hash = sql_string(hash)
        ))
    }

    #[cfg(feature = "web-blobs")]
    fn delete_blob_upload(&self, hash: &str) -> Result<()> {
        self.exec(&format!(
            "DELETE FROM sync_blob_outbox WHERE hash = {}",
            sql_string(hash)
        ))
    }

    #[cfg(feature = "web-blobs")]
    fn blob_upload_queue_stats_json_inner(&self) -> Result<String> {
        let rows = self.query_rows(
            "SELECT status, COUNT(hash) AS count FROM sync_blob_outbox GROUP BY status",
            |row| Ok((row.string("status")?, row.i64("count")?)),
        )?;
        let mut pending = 0i64;
        let mut uploading = 0i64;
        let mut failed = 0i64;
        for (status, count) in rows {
            match status.as_str() {
                "pending" => pending = count,
                "uploading" => uploading = count,
                "failed" => failed = count,
                _ => {}
            }
        }
        Ok(serde_json::to_string(&serde_json::json!({
            "pending": pending,
            "uploading": uploading,
            "failed": failed,
        }))?)
    }

    #[cfg(feature = "web-blobs")]
    fn blob_cache_stats_json_inner(&self) -> Result<String> {
        let rows = self.query_rows(
            "SELECT COUNT(hash) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM sync_blob_cache",
            |row| {
                Ok(serde_json::json!({
                    "count": row.i64("count")?,
                    "totalBytes": row.i64("total_bytes")?,
                }))
            },
        )?;
        Ok(serde_json::to_string(
            &rows.into_iter().next().unwrap_or_else(|| {
                serde_json::json!({
                    "count": 0,
                    "totalBytes": 0,
                })
            }),
        )?)
    }

    #[cfg(feature = "web-blobs")]
    fn prune_blob_cache_inner(&self, max_bytes: i64) -> Result<i64> {
        if max_bytes <= 0 {
            return Ok(0);
        }
        let stats = self.query_rows(
            "SELECT COALESCE(SUM(size), 0) AS total_bytes FROM sync_blob_cache",
            |row| row.i64("total_bytes"),
        )?;
        let total_bytes = stats.first().copied().unwrap_or(0);
        if total_bytes <= max_bytes {
            return Ok(0);
        }

        let mut freed = 0i64;
        let target = total_bytes - max_bytes;
        let entries = self.query_rows(
            "SELECT hash, size FROM sync_blob_cache ORDER BY last_accessed_at ASC",
            |row| Ok((row.string("hash")?, row.i64("size")?)),
        )?;
        for (hash, size) in entries {
            if freed >= target {
                break;
            }
            self.exec(&format!(
                "DELETE FROM sync_blob_cache WHERE hash = {}",
                sql_string(&hash)
            ))?;
            freed += size;
        }
        Ok(freed)
    }

    #[cfg(feature = "web-blobs")]
    fn clear_blob_cache_inner(&self) -> Result<()> {
        self.exec("DELETE FROM sync_blob_cache")
    }

    fn compact_storage_json_inner(&mut self, options_json: &str) -> Result<String> {
        let options = StorageCompactionOptions::from_json(Some(options_json))?;
        let report = self.compact_storage_inner(&options)?;
        Ok(serde_json::to_string(&report)?)
    }

    fn compact_storage_inner(
        &mut self,
        options: &StorageCompactionOptions,
    ) -> Result<StorageCompactionReport> {
        let cutoff = options.cutoff_ms_now()?;
        let mut report = StorageCompactionReport::default();

        if options.should_prune_acked_outbox() {
            let cutoff = required_compaction_cutoff(cutoff, "acked outbox")?;
            report.acked_outbox_commits_deleted = self.exec_with_changes(&format!(
                "DELETE FROM sync_outbox_commits WHERE status = 'acked' AND updated_at <= {cutoff}"
            ))?;
        }

        if options.should_prune_resolved_conflicts() {
            let cutoff = required_compaction_cutoff(cutoff, "resolved conflicts")?;
            report.resolved_conflicts_deleted = self.exec_with_changes(&format!(
                "DELETE FROM sync_conflicts WHERE resolved_at IS NOT NULL AND resolved_at <= {cutoff}"
            ))?;
        }

        if options.should_prune_failed_blob_uploads() {
            #[cfg(not(feature = "web-blobs"))]
            {
                return Err(web_blobs_feature_disabled());
            }
            #[cfg(feature = "web-blobs")]
            {
                let cutoff = required_compaction_cutoff(cutoff, "failed blob uploads")?;
                report.failed_blob_uploads_deleted = self.exec_with_changes(&format!(
                "DELETE FROM sync_blob_outbox WHERE status = 'failed' AND updated_at <= {cutoff}"
            ))?;
            }
        }

        if options.should_prune_inactive_subscription_states() {
            let cutoff = required_compaction_cutoff(cutoff, "inactive subscription states")?;
            report.inactive_subscription_states_deleted = self.exec_with_changes(&format!(
                "DELETE FROM sync_subscription_state WHERE status != 'active' AND updated_at <= {cutoff}"
            ))?;
        }

        if options.should_prune_tombstones() {
            let max_server_version = options.max_tombstone_server_version.ok_or_else(|| {
                SyncularError::config(
                    "storage compaction tombstone cleanup requires maxTombstoneServerVersion",
                )
            })?;
            for statement in
                tombstone_delete_statements(self.app_schema.app_table_metadata, max_server_version)?
            {
                report.tombstone_rows_deleted += self.exec_with_changes(&statement)?;
            }
            if report.tombstone_rows_deleted > 0 {
                self.invalidate_live_queries(&tombstone_table_names(
                    self.app_schema.app_table_metadata,
                ))?;
            }
        }

        if let Some(max_bytes) = options.max_blob_cache_bytes {
            #[cfg(not(feature = "web-blobs"))]
            {
                let _ = max_bytes;
                return Err(web_blobs_feature_disabled());
            }
            #[cfg(feature = "web-blobs")]
            {
                report.blob_cache_bytes_pruned = self.prune_blob_cache_inner(max_bytes)?;
            }
        }

        if options.should_prune_encrypted_crdt_updates() {
            report.encrypted_crdt_updates_deleted = self.exec_with_changes(
                "DELETE FROM sync_crdt_updates \
                 WHERE server_seq IS NOT NULL \
                   AND EXISTS ( \
                     SELECT 1 FROM sync_crdt_checkpoints \
                     WHERE sync_crdt_checkpoints.partition_id = sync_crdt_updates.partition_id \
                       AND sync_crdt_checkpoints.stream_id = sync_crdt_updates.stream_id \
                       AND sync_crdt_checkpoints.key_id = sync_crdt_updates.key_id \
                       AND sync_crdt_checkpoints.server_seq IS NOT NULL \
                       AND sync_crdt_checkpoints.covers_seq >= sync_crdt_updates.server_seq \
                   )",
            )?;
        }

        if let Some(keep) = options.encrypted_crdt_checkpoint_keep_count()? {
            report.encrypted_crdt_checkpoints_deleted = self.exec_with_changes(&format!(
                "DELETE FROM sync_crdt_checkpoints \
                 WHERE checkpoint_id IN ( \
                   SELECT checkpoint_id FROM ( \
                     SELECT checkpoint_id, \
                       row_number() OVER ( \
                         PARTITION BY partition_id, stream_id, key_id \
                         ORDER BY covers_seq DESC, coalesce(server_seq, 0) DESC, seq DESC \
                       ) AS checkpoint_rank \
                     FROM sync_crdt_checkpoints \
                   ) ranked \
                   WHERE checkpoint_rank > {keep} \
                 )"
            ))?;
        }

        if options.should_prune_crdt_update_log() {
            let cutoff = required_compaction_cutoff(cutoff, "CRDT update log")?;
            report.crdt_update_log_deleted = self.exec_with_changes(&format!(
                "DELETE FROM sync_crdt_update_log \
                 WHERE status IN ('acked', 'pruned') \
                   AND coalesce(acked_at, flushed_at, created_at) <= {cutoff}"
            ))?;
            self.refresh_all_crdt_document_counts()?;
        }

        Ok(report)
    }

    fn execute_blob_statement(
        &self,
        sql: &str,
        bind: impl FnOnce(*mut ffi::sqlite3_stmt) -> Result<()>,
    ) -> Result<()> {
        let sql = CString::new(sql).map_err(cstring_error("blob statement sql"))?;
        let mut stmt = ptr::null_mut();
        let rc = unsafe {
            ffi::sqlite3_prepare_v2(
                self.db,
                sql.as_ptr(),
                -1,
                &mut stmt as *mut _,
                ptr::null_mut(),
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(self.db, "prepare blob statement"));
        }
        if let Err(err) = bind(stmt) {
            let _ = finalize_stmt(stmt, self.db, "finalize blob statement after bind failure");
            return Err(err);
        }
        let step = unsafe { ffi::sqlite3_step(stmt) };
        let result = if step == ffi::SQLITE_DONE {
            Ok(())
        } else {
            Err(sqlite_error(self.db, "execute blob statement"))
        };
        finalize_stmt(stmt, self.db, "finalize blob statement")?;
        result
    }

    fn apply_mutations_batch_json_inner(&mut self, operations_json: &str) -> Result<String> {
        validate_mutation_batch_json_input_size(operations_json)?;
        let operations: Vec<RustOwnedLocalOperationBatchEntry> =
            serde_json::from_str(operations_json).map_err(SyncularError::protocol)?;
        let mut client_commit_ids = Vec::with_capacity(operations.len());
        let mut changed_tables = Vec::new();
        let mut changed_rows = Vec::new();

        self.begin_write_transaction()?;
        let result = (|| {
            for entry in operations {
                let (operation, local_row) =
                    self.transform_local_operation_entry(entry.operation, entry.local_row)?;
                let client_commit_id = Uuid::new_v4().to_string();
                if !changed_tables.iter().any(|table| table == &operation.table) {
                    changed_tables.push(operation.table.clone());
                }
                let previous_row = self.previous_local_operation_row(&operation)?;
                if let Some(changed_row) = sync_changed_row_for_local_operation(
                    self.app_schema,
                    &operation,
                    previous_row.as_ref(),
                    local_row.as_ref(),
                    Some(client_commit_id.clone()),
                ) {
                    changed_rows.push(changed_row);
                }
                self.apply_local_mutation(&operation, local_row.as_ref())?;
                self.enqueue_outbox_commit(&client_commit_id, &operation)?;
                client_commit_ids.push(client_commit_id);
            }
            Ok(())
        })();

        match result {
            Ok(()) => {
                self.exec("COMMIT")?;
                self.notify_local_tables_changed_with_rows(&changed_tables, &changed_rows)?;
            }
            Err(err) => {
                let _ = self.exec("ROLLBACK");
                return Err(err);
            }
        }

        Ok(serde_json::to_string(&client_commit_ids)?)
    }

    fn apply_mutations_commit_json_inner(&mut self, operations_json: &str) -> Result<String> {
        validate_mutation_batch_json_input_size(operations_json)?;
        let operations: Vec<RustOwnedLocalOperationBatchEntry> =
            serde_json::from_str(operations_json).map_err(SyncularError::protocol)?;
        if operations.is_empty() {
            return Err(SyncularError::protocol_message(
                "applyMutationsCommit requires at least one operation",
            ));
        }
        let mut changed_tables = Vec::new();
        let mut sync_operations = Vec::with_capacity(operations.len());
        let mut changed_rows = Vec::new();

        self.begin_write_transaction()?;
        let result = (|| {
            for entry in operations {
                let (operation, local_row) =
                    self.transform_local_operation_entry(entry.operation, entry.local_row)?;
                if !changed_tables.iter().any(|table| table == &operation.table) {
                    changed_tables.push(operation.table.clone());
                }
                let previous_row = self.previous_local_operation_row(&operation)?;
                if let Some(changed_row) = sync_changed_row_for_local_operation(
                    self.app_schema,
                    &operation,
                    previous_row.as_ref(),
                    local_row.as_ref(),
                    None,
                ) {
                    changed_rows.push(changed_row);
                }
                self.apply_local_mutation(&operation, local_row.as_ref())?;
                sync_operations.push(operation);
            }
            self.enqueue_outbox_operations(&sync_operations)
        })();

        match result {
            Ok(client_commit_id) => {
                self.exec("COMMIT")?;
                for row in &mut changed_rows {
                    row.commit_id = Some(client_commit_id.clone());
                }
                self.notify_local_tables_changed_with_rows(&changed_tables, &changed_rows)?;
                Ok(serde_json::to_string(&client_commit_id)?)
            }
            Err(err) => {
                let _ = self.exec("ROLLBACK");
                Err(err)
            }
        }
    }

    fn open_crdt_field(&self, id: CrdtFieldId) -> Result<CrdtField> {
        validate_crdt_field(self.app_schema, &id)
    }

    fn current_crdt_field_row(&self, field: &CrdtField) -> Result<Option<Value>> {
        self.current_row_json(field.metadata(), field.table(), field.row_id())
    }

    #[cfg(feature = "web-blobs")]
    fn blob_reference_health_counts(&self) -> Result<(i64, i64)> {
        let mut checked = 0i64;
        let mut invalid = 0i64;
        for metadata in self.app_schema.app_table_metadata {
            validate_table_name(metadata.name)?;
            for column in metadata.blob_columns {
                validate_table_name(column)?;
                let rows = self.query_rows(
                    &format!(
                        "SELECT {column} AS value FROM {table} \
                         WHERE {column} IS NOT NULL AND {column} <> ''",
                        table = metadata.name
                    ),
                    |row| row.string("value"),
                )?;
                for value in rows {
                    checked += 1;
                    let parsed = serde_json::from_str::<BlobRef>(&value);
                    match parsed {
                        Ok(blob) if validate_blob_ref_size(&blob).is_ok() => {}
                        _ => invalid += 1,
                    }
                }
            }
        }
        Ok((checked, invalid))
    }

    fn orphaned_crdt_document_count(&self) -> Result<i64> {
        let documents = self.query_rows(
            "SELECT app_table, row_id FROM sync_crdt_documents ORDER BY app_table ASC, row_id ASC",
            |row| Ok((row.string("app_table")?, row.string("row_id")?)),
        )?;
        let mut orphaned = 0i64;
        for (table, row_id) in documents {
            let Some(metadata) = self.app_schema.table_metadata(&table) else {
                orphaned += 1;
                continue;
            };
            if self.current_row_json(metadata, &table, &row_id)?.is_none() {
                orphaned += 1;
            }
        }
        Ok(orphaned)
    }

    fn crdt_document_snapshot(&self, field: &CrdtField) -> Result<Value> {
        let row = self.current_crdt_field_row(field)?;
        let state_base64 = crdt_field_state_base64(field, row.as_ref());
        let state_vector_base64 = crdt_yjs_state_vector_base64(state_base64.as_deref())?;
        self.upsert_crdt_document_snapshot(
            field,
            state_base64.as_deref(),
            &state_vector_base64,
            None,
        )?;
        self.select_crdt_document_snapshot(&field.document_key())
    }

    fn crdt_state_vector_hints_for_subscription(
        &self,
        table: &str,
        scopes: &ScopeValues,
        limit: i64,
    ) -> Result<Vec<CrdtStateVectorHint>> {
        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        validate_table_name(table)?;
        let rows = self.query_rows(
            &format!(
                "SELECT row_id, field_name, state_column, sync_mode, state_vector_base64, updated_at \
                 FROM sync_crdt_documents \
                 WHERE app_table = {table} AND state_vector_base64 != '' \
                 ORDER BY updated_at DESC LIMIT {limit}",
                table = sql_string(table),
                limit = limit.max(0)
            ),
            |row| {
                Ok(CrdtStateVectorHint {
                    row_id: row.string("row_id")?,
                    field: row.string("field_name")?,
                    state_column: row.string("state_column")?,
                    state_vector_base64: row.string("state_vector_base64")?,
                    sync_mode: row.string("sync_mode")?,
                    updated_at: row.i64("updated_at")?,
                })
            },
        )?;

        let mut hints = Vec::new();
        for hint in rows {
            let Some(app_row) = self.current_row_json(metadata, table, &hint.row_id)? else {
                continue;
            };
            if !row_matches_scope_values(metadata, &app_row, scopes) {
                continue;
            }
            hints.push(hint);
        }
        Ok(hints)
    }

    fn crdt_update_log(&self, field: &CrdtField, limit: i64) -> Result<Value> {
        let document_key = sql_string(&field.document_key());
        let rows = self.query_rows(
            &format!(
                "SELECT id, document_key, update_id, client_commit_id, origin, status, update_base64, \
                 state_vector_base64, created_at, flushed_at, acked_at \
                 FROM sync_crdt_update_log WHERE document_key = {document_key} \
                 ORDER BY id ASC LIMIT {limit}",
                limit = limit.max(0)
            ),
            |row| {
                Ok(json!({
                    "id": row.i64("id")?,
                    "documentKey": row.string("document_key")?,
                    "updateId": row.string("update_id")?,
                    "clientCommitId": row.optional_string("client_commit_id"),
                    "origin": row.string("origin")?,
                    "status": row.string("status")?,
                    "updateBase64": row.string("update_base64")?,
                    "stateVectorBase64": row.string("state_vector_base64")?,
                    "createdAt": row.i64("created_at")?,
                    "flushedAt": row.optional_i64("flushed_at"),
                    "ackedAt": row.optional_i64("acked_at"),
                }))
            },
        )?;
        Ok(Value::Array(rows))
    }

    fn compact_crdt_document(&self, field: &CrdtField) -> Result<Value> {
        let row = self.current_crdt_field_row(field)?;
        let state_base64 = crdt_field_state_base64(field, row.as_ref());
        let state_vector_base64 = crdt_yjs_state_vector_base64(state_base64.as_deref())?;
        self.upsert_crdt_document_snapshot(
            field,
            state_base64.as_deref(),
            &state_vector_base64,
            Some(now_ms()),
        )?;
        self.select_crdt_document_snapshot(&field.document_key())
    }

    fn assert_crdt_document_capacity(
        &self,
        document_key: &str,
        max_pending_updates: i64,
    ) -> Result<()> {
        if max_pending_updates < 1 {
            return Err(SyncularError::config(
                "CRDT update queue capacity must be at least 1",
            ));
        }
        let document_key_sql = sql_string(document_key);
        let pending = self
            .query_rows(
                &format!(
                    "SELECT count(*) AS count FROM sync_crdt_update_log \
                     WHERE document_key = {document_key_sql} AND status IN ('pending', 'flushed')"
                ),
                |row| row.i64("count"),
            )?
            .into_iter()
            .next()
            .unwrap_or(0);
        if pending >= max_pending_updates {
            return Err(SyncularError::message(
                ErrorKind::Storage,
                format!(
                    "CRDT update queue is full for document {document_key}; pending={pending}, capacity={max_pending_updates}"
                ),
            ));
        }
        Ok(())
    }

    fn upsert_crdt_document_snapshot(
        &self,
        field: &CrdtField,
        state_base64: Option<&str>,
        state_vector_base64: &str,
        compacted_at: Option<i64>,
    ) -> Result<()> {
        let now = now_ms();
        let sync_mode = match field.sync_mode() {
            CrdtFieldSyncMode::ServerMerge => "server-merge",
            CrdtFieldSyncMode::EncryptedUpdateLog => "encrypted-update-log",
        };
        self.exec(&format!(
            "INSERT INTO sync_crdt_documents (\
               document_key, app_table, row_id, field_name, state_column, sync_mode, \
               state_base64, state_vector_base64, pending_updates, flushed_updates, \
               acked_updates, log_updates, created_at, updated_at, compacted_at\
             ) VALUES ({document_key}, {table}, {row_id}, {field_name}, {state_column}, {sync_mode}, \
               {state_base64}, {state_vector_base64}, 0, 0, 0, 0, {created_at}, {updated_at}, {compacted_at}) \
             ON CONFLICT(document_key) DO UPDATE SET \
               state_base64 = excluded.state_base64, \
               state_vector_base64 = excluded.state_vector_base64, \
               state_column = excluded.state_column, \
               sync_mode = excluded.sync_mode, \
               updated_at = excluded.updated_at, \
               compacted_at = coalesce(excluded.compacted_at, sync_crdt_documents.compacted_at)",
            document_key = sql_string(&field.document_key()),
            table = sql_string(field.table()),
            row_id = sql_string(field.row_id()),
            field_name = sql_string(field.field()),
            state_column = sql_string(field.state_column()),
            sync_mode = sql_string(sync_mode),
            state_base64 = optional_sql_string(state_base64),
            state_vector_base64 = sql_string(state_vector_base64),
            created_at = now,
            updated_at = now,
            compacted_at = optional_sql_number(compacted_at)
        ))?;
        self.refresh_crdt_document_counts(&field.document_key())
    }

    fn record_crdt_update_log(
        &self,
        field: &CrdtField,
        update: &YjsUpdateEnvelope,
        client_commit_id: Option<&str>,
        origin: &str,
        status: &str,
        state_base64: Option<&str>,
        state_vector_base64: &str,
    ) -> Result<()> {
        self.upsert_crdt_document_snapshot(field, state_base64, state_vector_base64, None)?;
        let now = now_ms();
        self.exec(&format!(
            "INSERT INTO sync_crdt_update_log (\
               document_key, app_table, row_id, field_name, update_id, client_commit_id, \
               origin, status, update_base64, state_vector_base64, created_at, flushed_at, acked_at\
             ) VALUES ({document_key}, {table}, {row_id}, {field_name}, {update_id}, {client_commit_id}, \
               {origin}, {status}, {update_base64}, {state_vector_base64}, {created_at}, \
               CASE WHEN {status} IN ('flushed', 'acked') THEN {created_at} ELSE NULL END, \
               CASE WHEN {status} = 'acked' THEN {created_at} ELSE NULL END) \
             ON CONFLICT(update_id) DO UPDATE SET \
               state_vector_base64 = excluded.state_vector_base64, \
               status = CASE WHEN sync_crdt_update_log.status = 'acked' THEN sync_crdt_update_log.status ELSE excluded.status END, \
               flushed_at = coalesce(sync_crdt_update_log.flushed_at, excluded.flushed_at), \
               acked_at = coalesce(sync_crdt_update_log.acked_at, excluded.acked_at)",
            document_key = sql_string(&field.document_key()),
            table = sql_string(field.table()),
            row_id = sql_string(field.row_id()),
            field_name = sql_string(field.field()),
            update_id = sql_string(&update.update_id),
            client_commit_id = optional_sql_string(client_commit_id),
            origin = sql_string(origin),
            status = sql_string(status),
            update_base64 = sql_string(&update.update_base64),
            state_vector_base64 = sql_string(state_vector_base64),
            created_at = now
        ))?;
        self.refresh_crdt_document_counts(&field.document_key())
    }

    fn select_crdt_document_snapshot(&self, document_key: &str) -> Result<Value> {
        let document_key_sql = sql_string(document_key);
        self.query_rows(
            &format!(
                "SELECT document_key, app_table, row_id, field_name, state_column, sync_mode, \
                 state_base64, state_vector_base64, pending_updates, flushed_updates, \
                 acked_updates, log_updates, updated_at, compacted_at \
                 FROM sync_crdt_documents WHERE document_key = {document_key_sql} LIMIT 1"
            ),
            |row| {
                Ok(json!({
                    "documentKey": row.string("document_key")?,
                    "table": row.string("app_table")?,
                    "rowId": row.string("row_id")?,
                    "field": row.string("field_name")?,
                    "stateColumn": row.string("state_column")?,
                    "syncMode": row.string("sync_mode")?,
                    "stateBase64": row.optional_string("state_base64"),
                    "stateVectorBase64": row.string("state_vector_base64")?,
                    "pendingUpdates": row.i64("pending_updates")?,
                    "flushedUpdates": row.i64("flushed_updates")?,
                    "ackedUpdates": row.i64("acked_updates")?,
                    "logUpdates": row.i64("log_updates")?,
                    "updatedAt": row.i64("updated_at")?,
                    "compactedAt": row.optional_i64("compacted_at"),
                }))
            },
        )?
        .into_iter()
        .next()
        .ok_or_else(|| {
            SyncularError::message(
                ErrorKind::Storage,
                format!("CRDT document not found: {document_key}"),
            )
        })
    }

    fn refresh_crdt_document_counts(&self, document_key: &str) -> Result<()> {
        let document_key = sql_string(document_key);
        self.exec(&format!(
            "UPDATE sync_crdt_documents SET \
               pending_updates = (SELECT count(*) FROM sync_crdt_update_log WHERE document_key = {document_key} AND status = 'pending'), \
               flushed_updates = (SELECT count(*) FROM sync_crdt_update_log WHERE document_key = {document_key} AND status = 'flushed'), \
               acked_updates = (SELECT count(*) FROM sync_crdt_update_log WHERE document_key = {document_key} AND status = 'acked'), \
               log_updates = (SELECT count(*) FROM sync_crdt_update_log WHERE document_key = {document_key}), \
               updated_at = {updated_at} \
             WHERE document_key = {document_key}",
            updated_at = now_ms()
        ))
    }

    fn refresh_all_crdt_document_counts(&self) -> Result<()> {
        let keys = self.query_rows("SELECT document_key FROM sync_crdt_documents", |row| {
            row.string("document_key")
        })?;
        for key in keys {
            self.refresh_crdt_document_counts(&key)?;
        }
        Ok(())
    }

    fn previous_local_operation_row(&self, operation: &SyncOperation) -> Result<Option<Value>> {
        let Some(metadata) = self.app_schema.table_metadata(&operation.table) else {
            return Ok(None);
        };
        self.current_row_json(metadata, &operation.table, &operation.row_id)
    }

    fn apply_pending_mutation_commit(
        &mut self,
        mutation: PendingSyncularMutation,
        extra_changed_tables: &[&str],
    ) -> Result<String> {
        validate_pending_mutation_batch_size(std::slice::from_ref(&mutation))?;
        let operation = mutation.operation(mutation.base_version);
        let local_row = mutation.local_row;
        let mut changed_tables = Vec::new();
        push_unique_table(&mut changed_tables, &operation.table);
        for table in extra_changed_tables {
            push_unique_table(&mut changed_tables, table);
        }

        self.begin_write_transaction()?;
        let result = (|| {
            let (operation, local_row) =
                self.transform_local_operation_entry(operation, local_row)?;
            let previous_row = self.previous_local_operation_row(&operation)?;
            let changed_row = sync_changed_row_for_local_operation(
                self.app_schema,
                &operation,
                previous_row.as_ref(),
                local_row.as_ref(),
                None,
            );
            self.apply_local_mutation(&operation, local_row.as_ref())?;
            let client_commit_id = self.enqueue_outbox_operations(&[operation])?;
            Ok((client_commit_id, changed_row))
        })();

        match result {
            Ok((client_commit_id, changed_row)) => {
                self.exec("COMMIT")?;
                let changed_rows = changed_row
                    .map(|mut row| {
                        row.commit_id = Some(client_commit_id.clone());
                        row
                    })
                    .into_iter()
                    .collect::<Vec<_>>();
                self.notify_local_tables_changed_with_rows(&changed_tables, &changed_rows)?;
                Ok(client_commit_id)
            }
            Err(err) => {
                let _ = self.exec("ROLLBACK");
                Err(err)
            }
        }
    }

    fn apply_crdt_field_operation(
        &mut self,
        field: &CrdtField,
        operation: SyncOperation,
        update: YjsUpdateEnvelope,
    ) -> Result<String> {
        self.begin_write_transaction()?;
        let result = (|| {
            let previous_row = self.previous_local_operation_row(&operation)?;
            let (operation, local_row) = self.transform_local_operation_entry(operation, None)?;
            let changed_row = sync_changed_row_for_local_operation(
                self.app_schema,
                &operation,
                previous_row.as_ref(),
                local_row.as_ref(),
                None,
            );
            self.apply_local_mutation(&operation, local_row.as_ref())?;
            let client_commit_id = self.enqueue_outbox_operations(&[operation])?;
            let row = self.current_crdt_field_row(field)?;
            let state_base64 = crdt_field_state_base64(field, row.as_ref());
            let state_vector_base64 = crdt_yjs_state_vector_base64(state_base64.as_deref())?;
            self.record_crdt_update_log(
                field,
                &update,
                Some(&client_commit_id),
                "local",
                "pending",
                state_base64.as_deref(),
                &state_vector_base64,
            )?;
            Ok((client_commit_id, changed_row))
        })();

        match result {
            Ok((client_commit_id, changed_row)) => {
                self.exec("COMMIT")?;
                let changed_rows = changed_row
                    .map(|mut row| {
                        row.commit_id = Some(client_commit_id.clone());
                        row
                    })
                    .into_iter()
                    .collect::<Vec<_>>();
                self.notify_local_tables_changed_with_rows(
                    &[field.table().to_string()],
                    &changed_rows,
                )?;
                Ok(client_commit_id)
            }
            Err(err) => {
                let _ = self.exec("ROLLBACK");
                Err(err)
            }
        }
    }

    fn encrypted_crdt_stream_stats(
        &self,
        partition_id: &str,
        stream_id: &str,
    ) -> Result<EncryptedCrdtStreamStats> {
        let partition_id = sql_string(partition_id);
        let stream_id = sql_string(stream_id);
        self.query_rows(
            &format!(
                "select \
                    (select count(*) from sync_crdt_updates where partition_id = {partition_id} and stream_id = {stream_id}) as update_count, \
                    (select count(*) from sync_crdt_checkpoints where partition_id = {partition_id} and stream_id = {stream_id}) as checkpoint_count, \
                    (select count(*) from sync_crdt_updates where partition_id = {partition_id} and stream_id = {stream_id} \
                        and server_seq is not null \
                        and server_seq > coalesce((select max(covers_seq) from sync_crdt_checkpoints where partition_id = {partition_id} and stream_id = {stream_id}), 0)) as checkpointable_update_count, \
                    (select max(server_seq) from sync_crdt_updates where partition_id = {partition_id} and stream_id = {stream_id}) as max_server_seq, \
                    (select max(covers_seq) from sync_crdt_checkpoints where partition_id = {partition_id} and stream_id = {stream_id}) as latest_checkpoint_covers_seq"
            ),
            |row| {
                Ok(EncryptedCrdtStreamStats {
                    update_count: row.i64("update_count")?,
                    checkpoint_count: row.i64("checkpoint_count")?,
                    checkpointable_update_count: row.i64("checkpointable_update_count")?,
                    max_server_seq: row.optional_i64("max_server_seq"),
                    latest_checkpoint_covers_seq: row.optional_i64("latest_checkpoint_covers_seq"),
                })
            },
        )?
        .into_iter()
        .next()
        .ok_or_else(|| SyncularError::storage(anyhow::anyhow!("missing encrypted CRDT stats row")))
    }

    fn apply_local_mutation(
        &self,
        operation: &SyncOperation,
        local_row: Option<&Value>,
    ) -> Result<()> {
        if is_encrypted_crdt_system_table(&operation.table) {
            return match operation.op.as_str() {
                "upsert" => {
                    let row = self.upsert_encrypted_crdt_system_row(
                        &operation.table,
                        &operation.row_id,
                        local_row.or(operation.payload.as_ref()),
                        None,
                    )?;
                    self.materialize_encrypted_crdt_system_row(&operation.table, &row)
                }
                "delete" => {
                    self.delete_encrypted_crdt_system_row(&operation.table, &operation.row_id)
                }
                op => Err(SyncularError::protocol_message(format!(
                    "unsupported local operation: {op}"
                ))),
            };
        }

        let metadata = self
            .app_schema
            .table_metadata(&operation.table)
            .ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {}", operation.table))
            })?;

        match operation.op.as_str() {
            "upsert" => {
                let mut row = object_from_value(local_row.or(operation.payload.as_ref()))?;
                row.insert(
                    metadata.primary_key_column.to_string(),
                    Value::String(operation.row_id.clone()),
                );
                let row = self.preserve_encrypted_crdt_materialized_columns(metadata, row)?;
                self.upsert_row_object(&operation.table, metadata.primary_key_column, &row)
            }
            "delete" => self.delete_row(
                &operation.table,
                metadata.primary_key_column,
                &operation.row_id,
            ),
            op => Err(SyncularError::protocol_message(format!(
                "unsupported local operation: {op}"
            ))),
        }
    }

    fn transform_local_operation_entry(
        &self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<(SyncOperation, Option<Value>)> {
        if is_encrypted_crdt_system_table(&operation.table) {
            return Ok((operation, local_row));
        }

        let metadata = self
            .app_schema
            .table_metadata(&operation.table)
            .ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {}", operation.table))
            })?;
        let current_row = self.current_row_json(metadata, &operation.table, &operation.row_id)?;
        let local_row = transform_local_row_for_metadata(
            &operation.table,
            &operation.row_id,
            local_row,
            operation.payload.as_ref(),
            current_row.as_ref(),
            metadata,
        )?;
        Ok((operation, local_row))
    }

    fn current_row_json(
        &self,
        metadata: &crate::app_schema::AppTableMetadata,
        table: &str,
        row_id: &str,
    ) -> Result<Option<Value>> {
        validate_table_name(table)?;
        validate_table_name(metadata.primary_key_column)?;
        let rows = self.query_rows(
            &format!(
                "SELECT * FROM {table} WHERE {pk} = {row_id} LIMIT 1",
                pk = metadata.primary_key_column,
                row_id = sql_string(row_id)
            ),
            |row| row.to_json(),
        )?;
        Ok(rows.into_iter().next())
    }

    fn enqueue_outbox_commit(
        &self,
        client_commit_id: &str,
        operation: &SyncOperation,
    ) -> Result<()> {
        self.assert_outbox_capacity()?;
        let now = now_ms();
        let operations_json = sync_operations_json_for_outbox(std::slice::from_ref(operation))?;
        self.exec(&format!(
            "INSERT INTO sync_outbox_commits \
             (id, client_commit_id, status, operations_json, created_at, updated_at, schema_version, next_attempt_at) \
             VALUES ({id}, {client_commit_id}, 'pending', {operations_json}, {created_at}, {updated_at}, {schema_version}, 0)",
            id = sql_string(&Uuid::new_v4().to_string()),
            client_commit_id = sql_string(client_commit_id),
            operations_json = sql_string(&operations_json),
            created_at = now,
            updated_at = now,
            schema_version = self.schema_version
        ))
    }

    fn enqueue_outbox_operations(&self, operations: &[SyncOperation]) -> Result<String> {
        self.assert_outbox_capacity()?;
        let client_commit_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let operations_json = sync_operations_json_for_outbox(operations)?;
        self.exec(&format!(
            "INSERT INTO sync_outbox_commits \
             (id, client_commit_id, status, operations_json, created_at, updated_at, schema_version, next_attempt_at) \
             VALUES ({id}, {client_commit_id}, 'pending', {operations_json}, {created_at}, {updated_at}, {schema_version}, 0)",
            id = sql_string(&Uuid::new_v4().to_string()),
            client_commit_id = sql_string(&client_commit_id),
            operations_json = sql_string(&operations_json),
            created_at = now,
            updated_at = now,
            schema_version = self.schema_version
        ))?;
        Ok(client_commit_id)
    }

    fn assert_outbox_capacity(&self) -> Result<()> {
        let unresolved = self
            .query_rows(
                "SELECT COUNT(*) AS count FROM sync_outbox_commits WHERE status <> 'acked'",
                |row| row.i64("count"),
            )?
            .into_iter()
            .next()
            .unwrap_or(0);
        validate_unresolved_outbox_capacity(usize::try_from(unresolved).unwrap_or(usize::MAX))
    }

    fn upsert_row_object(
        &self,
        table: &str,
        primary_key_column: &str,
        row: &Map<String, Value>,
    ) -> Result<()> {
        validate_table_name(table)?;
        validate_table_name(primary_key_column)?;
        row.get(primary_key_column)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "row for table {table} is missing string primary key {primary_key_column}"
                ))
            })?;
        let columns = row.keys().map(String::as_str).collect::<Vec<_>>();
        if columns.is_empty() {
            return Ok(());
        }
        for column in &columns {
            validate_table_name(column)?;
        }
        let update_columns = columns
            .iter()
            .copied()
            .filter(|column| *column != primary_key_column)
            .collect::<Vec<_>>();
        let on_conflict = if update_columns.is_empty() {
            "DO NOTHING".to_string()
        } else {
            format!(
                "DO UPDATE SET {}",
                update_columns
                    .iter()
                    .map(|column| format!("{column} = excluded.{column}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let values = columns
            .iter()
            .map(|column| sql_value(row.get(*column).unwrap_or(&Value::Null)))
            .collect::<Vec<_>>()
            .join(", ");
        self.exec(&format!(
            "INSERT INTO {table} ({columns}) VALUES ({values}) ON CONFLICT({primary_key_column}) {on_conflict}",
            columns = columns.join(", "),
        ))
    }

    fn upsert_encrypted_crdt_system_row(
        &self,
        table: &str,
        row_id: &str,
        row: Option<&Value>,
        server_seq: Option<i64>,
    ) -> Result<Map<String, Value>> {
        let row = encrypted_crdt_normalize_row(table, row_id, row)?;
        let server_seq = server_seq
            .or_else(|| row.get("server_seq").and_then(Value::as_i64))
            .or_else(|| row.get("seq").and_then(Value::as_i64));
        let scopes_json = encrypted_crdt_scopes_json(&row)?;
        let partition_id = row
            .get("partition_id")
            .and_then(Value::as_str)
            .unwrap_or("default");
        let stream_id = row.get("stream_id").and_then(Value::as_str).unwrap();
        let app_table = row.get("app_table").and_then(Value::as_str).unwrap();
        let app_row_id = row.get("row_id").and_then(Value::as_str).unwrap();
        let field_name = row.get("field_name").and_then(Value::as_str).unwrap();
        let key_id = row.get("key_id").and_then(Value::as_str).unwrap();
        let ciphertext = row.get("ciphertext").and_then(Value::as_str).unwrap();
        let actor_id = row.get("actor_id").and_then(Value::as_str);
        let client_id = row.get("client_id").and_then(Value::as_str);
        let created_at = row
            .get("created_at")
            .and_then(Value::as_i64)
            .unwrap_or_else(now_ms);

        match table {
            CRDT_UPDATES_TABLE => {
                let update_id = row.get("update_id").and_then(Value::as_str).unwrap();
                self.exec(&format!(
                    "INSERT INTO sync_crdt_updates \
                     (partition_id, stream_id, app_table, row_id, field_name, update_id, actor_id, client_id, key_id, ciphertext, scopes, created_at, server_seq) \
                     VALUES ({partition_id}, {stream_id}, {app_table}, {row_id}, {field_name}, {update_id}, {actor_id}, {client_id}, {key_id}, {ciphertext}, {scopes}, {created_at}, {server_seq}) \
                     ON CONFLICT(update_id) DO UPDATE SET server_seq = coalesce(excluded.server_seq, sync_crdt_updates.server_seq)",
                    partition_id = sql_string(partition_id),
                    stream_id = sql_string(stream_id),
                    app_table = sql_string(app_table),
                    row_id = sql_string(app_row_id),
                    field_name = sql_string(field_name),
                    update_id = sql_string(update_id),
                    actor_id = optional_sql_string(actor_id),
                    client_id = optional_sql_string(client_id),
                    key_id = sql_string(key_id),
                    ciphertext = sql_string(ciphertext),
                    scopes = sql_string(&scopes_json),
                    server_seq = optional_sql_number(server_seq),
                ))?;
            }
            CRDT_CHECKPOINTS_TABLE => {
                let checkpoint_id = row.get("checkpoint_id").and_then(Value::as_str).unwrap();
                let covers_seq = row.get("covers_seq").and_then(Value::as_i64).unwrap();
                self.exec(&format!(
                    "INSERT INTO sync_crdt_checkpoints \
                     (partition_id, stream_id, app_table, row_id, field_name, checkpoint_id, covers_seq, actor_id, client_id, key_id, ciphertext, scopes, created_at, server_seq) \
                     VALUES ({partition_id}, {stream_id}, {app_table}, {row_id}, {field_name}, {checkpoint_id}, {covers_seq}, {actor_id}, {client_id}, {key_id}, {ciphertext}, {scopes}, {created_at}, {server_seq}) \
                     ON CONFLICT(checkpoint_id) DO UPDATE SET server_seq = coalesce(excluded.server_seq, sync_crdt_checkpoints.server_seq)",
                    partition_id = sql_string(partition_id),
                    stream_id = sql_string(stream_id),
                    app_table = sql_string(app_table),
                    row_id = sql_string(app_row_id),
                    field_name = sql_string(field_name),
                    checkpoint_id = sql_string(checkpoint_id),
                    actor_id = optional_sql_string(actor_id),
                    client_id = optional_sql_string(client_id),
                    key_id = sql_string(key_id),
                    ciphertext = sql_string(ciphertext),
                    scopes = sql_string(&scopes_json),
                    server_seq = optional_sql_number(server_seq),
                ))?;
            }
            _ => unreachable!("validated encrypted CRDT table"),
        }
        Ok(row)
    }

    fn delete_encrypted_crdt_system_row(&self, table: &str, row_id: &str) -> Result<()> {
        let identity = encrypted_crdt_identity_column(table)?;
        self.exec(&format!(
            "DELETE FROM {table} WHERE {identity} = {}",
            sql_string(row_id)
        ))
    }

    fn preserve_encrypted_crdt_materialized_columns(
        &self,
        metadata: &'static AppTableMetadata,
        mut row: Map<String, Value>,
    ) -> Result<Map<String, Value>> {
        if !metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
        {
            return Ok(row);
        }
        let Some(row_id) = row
            .get(metadata.primary_key_column)
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return Ok(row);
        };
        let Some(existing_row) = self.current_row_json(metadata, metadata.name, &row_id)? else {
            return Ok(row);
        };
        let Some(existing) = existing_row.as_object() else {
            return Ok(row);
        };
        for field in metadata
            .crdt_yjs_fields
            .iter()
            .filter(|field| field.sync_mode == "encrypted-update-log")
        {
            let Some(state) = existing
                .get(field.state_column)
                .and_then(Value::as_str)
                .filter(|state| !state.is_empty())
            else {
                continue;
            };
            row.insert(
                field.state_column.to_string(),
                Value::String(state.to_string()),
            );
            if let Some(value) = existing.get(field.field) {
                row.insert(field.field.to_string(), value.clone());
            }
        }
        Ok(row)
    }

    fn materialize_app_row_object(
        &self,
        table: &str,
        row: Value,
        metadata: &'static AppTableMetadata,
    ) -> Result<Map<String, Value>> {
        if !row_needs_crdt_materialization(&row, metadata) {
            return object_from_owned_value(row);
        }
        let row = materialize_row_for_metadata(table, None, row, metadata)?;
        let row = object_from_owned_value(row)?;
        self.preserve_encrypted_crdt_materialized_columns(metadata, row)
    }

    fn write_sqlite_snapshot_artifact_rows(
        &mut self,
        table: &str,
        mut artifact_buffer: Vec<u8>,
        mode: WebSnapshotArtifactApplyMode,
    ) -> Result<usize> {
        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        if metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
        {
            return Err(SyncularError::config(format!(
                "direct sqlite snapshot artifact apply is not supported for encrypted CRDT table {table}"
            )));
        }
        validate_table_name(table)?;
        validate_table_name(metadata.primary_key_column)?;

        let schema = format!(
            "{SQLITE_SNAPSHOT_ARTIFACT_SCHEMA}_{}",
            self.attached_snapshot_artifacts.len()
        );
        validate_table_name(&schema)?;
        self.exec(&format!("ATTACH ':memory:' AS {schema}"))?;
        if let Err(err) =
            deserialize_sqlite_snapshot_artifact_schema(self.db, &schema, &mut artifact_buffer)
        {
            let _ = self.exec(&format!("DETACH {schema}"));
            return Err(err);
        }
        self.attached_snapshot_artifacts
            .push(AttachedSnapshotArtifact {
                schema: schema.clone(),
                _buffer: artifact_buffer,
            });
        {
            let columns = sqlite_table_column_names(self.db, Some(&schema), table)?;
            if columns.is_empty() {
                return Ok(0);
            }
            if !columns
                .iter()
                .any(|column| column == metadata.primary_key_column)
            {
                return Err(SyncularError::protocol_message(format!(
                    "sqlite snapshot artifact for table {table} is missing primary key {}",
                    metadata.primary_key_column
                )));
            }
            for column in &columns {
                validate_table_name(column)?;
            }

            let write_mode = match mode {
                WebSnapshotArtifactApplyMode::Insert => BinarySnapshotWriteMode::Insert,
                WebSnapshotArtifactApplyMode::Upsert => BinarySnapshotWriteMode::Upsert,
            };
            let on_conflict =
                binary_snapshot_on_conflict(&columns, metadata.primary_key_column, write_mode);
            let conflict_sql = on_conflict
                .as_ref()
                .map(|action| format!(" ON CONFLICT({}) {action}", metadata.primary_key_column))
                .unwrap_or_default();
            let columns_sql = columns.join(", ");
            let changes = self.exec_with_changes(&format!(
                "INSERT INTO {table} ({columns_sql}) \
                 SELECT {columns_sql} FROM {schema}.{table} \
                 WHERE true{conflict_sql}"
            ))?;
            usize::try_from(changes)
                .map_err(|_| SyncularError::storage(anyhow::anyhow!("negative sqlite changes")))
        }
    }

    fn write_app_rows(&mut self, table: &str, rows: Vec<Value>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }

        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        validate_table_name(table)?;
        validate_table_name(metadata.primary_key_column)?;

        let columns = metadata
            .columns
            .iter()
            .map(|column| column.name.to_string())
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return Ok(());
        }
        for column in &columns {
            validate_table_name(column)?;
        }
        let update_columns = columns
            .iter()
            .map(String::as_str)
            .filter(|column| *column != metadata.primary_key_column)
            .collect::<Vec<_>>();
        let on_conflict = if update_columns.is_empty() {
            "DO NOTHING".to_string()
        } else {
            format!(
                "DO UPDATE SET {}",
                update_columns
                    .iter()
                    .map(|column| format!("{column} = excluded.{column}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let batch_rows = snapshot_write_batch_rows(columns.len());
        let mut batch = Vec::with_capacity(batch_rows);

        for row in rows {
            let row = self.materialize_app_row_object(table, row, metadata)?;
            batch.push(row);
            if batch.len() == batch_rows {
                let stmt = self.cached_binary_snapshot_statement(
                    table,
                    metadata.primary_key_column,
                    &columns,
                    Some(&on_conflict),
                    batch.len(),
                    BinarySnapshotWriteMode::Upsert,
                )?;
                execute_prepared_multirow_upsert(
                    self.db,
                    stmt,
                    &batch,
                    &columns,
                    "app row upsert",
                )?;
                batch.clear();
            }
        }
        if !batch.is_empty() {
            let stmt = self.cached_binary_snapshot_statement(
                table,
                metadata.primary_key_column,
                &columns,
                Some(&on_conflict),
                batch.len(),
                BinarySnapshotWriteMode::Upsert,
            )?;
            execute_prepared_multirow_upsert(self.db, stmt, &batch, &columns, "app row upsert")?;
        }
        Ok(())
    }

    fn write_binary_snapshot_rows(
        &mut self,
        table: &str,
        rows: DecodedBinarySnapshotRows,
        mode: BinarySnapshotWriteMode,
    ) -> Result<()> {
        if rows.rows.is_empty() {
            return Ok(());
        }
        if rows.table != table {
            return Err(SyncularError::protocol_message(format!(
                "binary snapshot table mismatch: expected {table}, got {}",
                rows.table
            )));
        }

        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        if metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
        {
            return self.write_app_rows(table, rows.into_value_rows());
        }
        validate_table_name(table)?;
        validate_table_name(metadata.primary_key_column)?;

        let columns = rows
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        if !columns
            .iter()
            .any(|column| column == metadata.primary_key_column)
        {
            return Err(SyncularError::protocol_message(format!(
                "binary snapshot for table {table} is missing primary key {}",
                metadata.primary_key_column
            )));
        }
        for column in &columns {
            validate_table_name(column)?;
        }
        if rows.rows.iter().any(|row| row.len() != columns.len()) {
            return Err(SyncularError::protocol_message(format!(
                "binary snapshot for table {table} has a row with the wrong column count"
            )));
        }
        let on_conflict = binary_snapshot_on_conflict(&columns, metadata.primary_key_column, mode);

        let write_result = (|| -> Result<()> {
            let batch_rows = snapshot_write_batch_rows(columns.len());
            for batch in rows.rows.chunks(batch_rows) {
                if batch.len() == batch_rows {
                    let full_batch_stmt = self.cached_binary_snapshot_statement(
                        table,
                        metadata.primary_key_column,
                        &columns,
                        on_conflict.as_deref(),
                        batch_rows,
                        mode,
                    )?;
                    let timings =
                        execute_prepared_binary_multirow_upsert(self.db, full_batch_stmt, batch)?;
                    self.apply_timings.add(timings);
                } else {
                    let timings = execute_binary_snapshot_write(
                        self.db,
                        table,
                        metadata.primary_key_column,
                        &columns,
                        on_conflict.as_deref(),
                        mode,
                        batch,
                    )?;
                    self.apply_timings.add(timings);
                }
            }
            Ok(())
        })();
        write_result
    }

    fn write_binary_snapshot_payload(
        &mut self,
        table: &str,
        payload: BinarySnapshotPayload,
        mode: BinarySnapshotWriteMode,
    ) -> Result<()> {
        if payload.row_count() == 0 {
            return Ok(());
        }
        if payload.table != table {
            return Err(SyncularError::protocol_message(format!(
                "binary snapshot table mismatch: expected {table}, got {}",
                payload.table
            )));
        }

        let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        if metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.sync_mode == "encrypted-update-log")
        {
            return self.write_app_rows(table, payload.into_value_rows()?);
        }
        validate_table_name(table)?;
        validate_table_name(metadata.primary_key_column)?;

        let columns = payload
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        if !columns
            .iter()
            .any(|column| column == metadata.primary_key_column)
        {
            return Err(SyncularError::protocol_message(format!(
                "binary snapshot for table {table} is missing primary key {}",
                metadata.primary_key_column
            )));
        }
        for column in &columns {
            validate_table_name(column)?;
        }
        let on_conflict = binary_snapshot_on_conflict(&columns, metadata.primary_key_column, mode);

        let write_result = (|| -> Result<()> {
            let mut cursor = payload.row_cursor();
            let mut remaining = payload.row_count();
            let batch_rows = snapshot_write_batch_rows(columns.len());
            while remaining >= batch_rows {
                let full_batch_stmt = self.cached_binary_snapshot_statement(
                    table,
                    metadata.primary_key_column,
                    &columns,
                    on_conflict.as_deref(),
                    batch_rows,
                    mode,
                )?;
                let timings = execute_prepared_binary_payload_batch(
                    self.db,
                    full_batch_stmt,
                    &mut cursor,
                    batch_rows,
                )?;
                self.apply_timings.add(timings);
                remaining -= batch_rows;
            }
            if remaining > 0 {
                let timings = execute_binary_snapshot_payload_write(
                    self.db,
                    table,
                    metadata.primary_key_column,
                    &columns,
                    on_conflict.as_deref(),
                    mode,
                    &mut cursor,
                    remaining,
                )?;
                self.apply_timings.add(timings);
            }
            cursor.assert_done()?;
            Ok(())
        })();
        write_result
    }

    fn update_encrypted_crdt_system_server_seq(
        &self,
        table: &str,
        row_id: &str,
        server_seq: i64,
    ) -> Result<()> {
        let identity = encrypted_crdt_identity_column(table)?;
        self.exec(&format!(
            "UPDATE {table} SET server_seq = {server_seq} WHERE {identity} = {row_id}",
            row_id = sql_string(row_id)
        ))
    }

    fn clear_encrypted_crdt_system_table_for_scopes(
        &self,
        table: &str,
        scopes: &ScopeValues,
    ) -> Result<()> {
        let identity = encrypted_crdt_identity_column(table)?;
        if scopes.is_empty() {
            return self.exec(&format!("DELETE FROM {table}"));
        }
        let rows = self.query_rows(
            &format!("SELECT {identity} AS identity, scopes FROM {table}"),
            |row| Ok((row.string("identity")?, row.string("scopes")?)),
        )?;
        for (row_id, scopes_json) in rows {
            let stored_scopes: Value = serde_json::from_str(&scopes_json)?;
            let mut row = Map::new();
            row.insert("scopes".to_string(), stored_scopes);
            if encrypted_crdt_row_matches_scopes(&row, scopes) {
                self.delete_encrypted_crdt_system_row(table, &row_id)?;
            }
        }
        Ok(())
    }

    fn materialize_encrypted_crdt_system_row(
        &self,
        system_table: &str,
        system_row: &Map<String, Value>,
    ) -> Result<()> {
        let app_table = system_row
            .get("app_table")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                SyncularError::protocol_message("encrypted CRDT row missing app_table")
            })?;
        let app_row_id = system_row
            .get("row_id")
            .and_then(Value::as_str)
            .ok_or_else(|| SyncularError::protocol_message("encrypted CRDT row missing row_id"))?;
        let field_name = system_row
            .get("field_name")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                SyncularError::protocol_message("encrypted CRDT row missing field_name")
            })?;
        let Some(metadata) = self.app_schema.table_metadata(app_table) else {
            return Ok(());
        };
        if !metadata
            .crdt_yjs_fields
            .iter()
            .any(|field| field.field == field_name && field.sync_mode == "encrypted-update-log")
        {
            return Ok(());
        }
        let current_row = self.current_row_json(metadata, app_table, app_row_id)?;
        let Some(row) = apply_encrypted_crdt_plaintext_to_row(
            metadata,
            field_name,
            app_row_id,
            system_table,
            system_row,
            current_row,
        )?
        else {
            return Ok(());
        };
        let row = object_from_value(Some(&row))?;
        self.upsert_row_object(app_table, metadata.primary_key_column, &row)
    }

    fn delete_row(&self, table: &str, primary_key_column: &str, row_id: &str) -> Result<()> {
        validate_table_name(table)?;
        validate_table_name(primary_key_column)?;
        self.exec(&format!(
            "DELETE FROM {table} WHERE {primary_key_column} = {}",
            sql_string(row_id)
        ))
    }

    fn upsert_auth_lease_sync(&self, lease: &AuthLeaseRecord) -> Result<()> {
        self.exec(&format!(
            "INSERT INTO sync_auth_leases \
             (lease_id, kid, actor_id, issued_at_ms, not_before_ms, expires_at_ms, \
              schema_version, payload_json, token, status, last_validation_error, \
              created_at_ms, updated_at_ms) \
             VALUES ({lease_id}, {kid}, {actor_id}, {issued_at_ms}, {not_before_ms}, \
              {expires_at_ms}, {schema_version}, {payload_json}, {token}, {status}, \
              {last_validation_error}, {created_at_ms}, {updated_at_ms}) \
             ON CONFLICT(lease_id) DO UPDATE SET \
               kid = excluded.kid, \
               actor_id = excluded.actor_id, \
               issued_at_ms = excluded.issued_at_ms, \
               not_before_ms = excluded.not_before_ms, \
               expires_at_ms = excluded.expires_at_ms, \
               schema_version = excluded.schema_version, \
               payload_json = excluded.payload_json, \
               token = excluded.token, \
               status = excluded.status, \
               last_validation_error = excluded.last_validation_error, \
               updated_at_ms = excluded.updated_at_ms",
            lease_id = sql_string(&lease.lease_id),
            kid = sql_string(&lease.kid),
            actor_id = sql_string(&lease.actor_id),
            issued_at_ms = lease.issued_at_ms,
            not_before_ms = lease.not_before_ms,
            expires_at_ms = lease.expires_at_ms,
            schema_version = lease.schema_version,
            payload_json = sql_string(&lease.payload_json),
            token = sql_string(&lease.token),
            status = sql_string(&lease.status),
            last_validation_error = optional_sql_string(lease.last_validation_error.as_deref()),
            created_at_ms = lease.created_at_ms,
            updated_at_ms = lease.updated_at_ms
        ))
    }

    fn auth_lease_sync(&self, lease_id: &str) -> Result<Option<AuthLeaseRecord>> {
        let rows = self.query_rows(
            &format!(
                "SELECT lease_id, kid, actor_id, issued_at_ms, not_before_ms, expires_at_ms, \
                        schema_version, payload_json, token, status, last_validation_error, \
                        created_at_ms, updated_at_ms \
                 FROM sync_auth_leases WHERE lease_id = {} LIMIT 1",
                sql_string(lease_id)
            ),
            auth_lease_record_from_row,
        )?;
        Ok(rows.into_iter().next())
    }

    fn active_auth_leases_sync(
        &self,
        actor_id: Option<&str>,
        now_ms_value: i64,
    ) -> Result<Vec<AuthLeaseRecord>> {
        let actor_filter = actor_id.map_or_else(String::new, |actor_id| {
            format!(" AND actor_id = {}", sql_string(actor_id))
        });
        self.query_rows(
            &format!(
                "SELECT lease_id, kid, actor_id, issued_at_ms, not_before_ms, expires_at_ms, \
                        schema_version, payload_json, token, status, last_validation_error, \
                        created_at_ms, updated_at_ms \
                 FROM sync_auth_leases \
                 WHERE status = 'active' \
                   AND not_before_ms <= {now_ms_value} \
                   AND expires_at_ms > {now_ms_value}{actor_filter} \
                 ORDER BY expires_at_ms ASC"
            ),
            auth_lease_record_from_row,
        )
    }

    fn set_outbox_auth_lease_sync(
        &self,
        client_commit_id: &str,
        provenance: Option<&AuthLeaseProvenance>,
    ) -> Result<()> {
        let count = self
            .query_rows(
                &format!(
                    "SELECT COUNT(*) AS count FROM sync_outbox_commits WHERE client_commit_id = {}",
                    sql_string(client_commit_id)
                ),
                |row| row.i64("count"),
            )?
            .into_iter()
            .next()
            .unwrap_or(0);
        if count == 0 {
            return Err(SyncularError::storage(anyhow::anyhow!(
                "outbox commit {client_commit_id} does not exist"
            )));
        }
        self.exec(&format!(
            "UPDATE sync_outbox_commits SET \
               lease_id = {lease_id}, \
               lease_expires_at_ms = {lease_expires_at_ms}, \
               lease_status_at_enqueue = {lease_status_at_enqueue}, \
               lease_scope_summary_json = {lease_scope_summary_json} \
             WHERE client_commit_id = {client_commit_id}",
            lease_id = optional_sql_string(provenance.map(|lease| lease.lease_id.as_str())),
            lease_expires_at_ms =
                optional_sql_number(provenance.map(|lease| lease.lease_expires_at_ms)),
            lease_status_at_enqueue =
                optional_sql_string(provenance.map(|lease| lease.lease_status_at_enqueue.as_str())),
            lease_scope_summary_json = optional_sql_string(
                provenance.and_then(|lease| lease.lease_scope_summary_json.as_deref()),
            ),
            client_commit_id = sql_string(client_commit_id)
        ))
    }

    fn select_outbox(&self, sql: &str) -> Result<Vec<OutboxCommit>> {
        self.query_rows(sql, |row| {
            Ok(OutboxCommit {
                id: row.string("id")?,
                client_commit_id: row.string("client_commit_id")?,
                status: row.string("status")?,
                operations_json: row.string("operations_json")?,
                last_response_json: row.optional_string("last_response_json"),
                error: row.optional_string("error"),
                created_at: row.i64("created_at")?,
                updated_at: row.i64("updated_at")?,
                attempt_count: row.i32("attempt_count")?,
                acked_commit_seq: row.optional_i64("acked_commit_seq"),
                schema_version: row.optional_i32("schema_version").unwrap_or(1),
                next_attempt_at: row.optional_i64("next_attempt_at").unwrap_or(0),
                auth_lease: auth_lease_provenance_from_columns(
                    row.optional_string("lease_id"),
                    row.optional_i64("lease_expires_at_ms"),
                    row.optional_string("lease_status_at_enqueue"),
                    row.optional_string("lease_scope_summary_json"),
                ),
            })
        })
    }

    fn recover_sending_outbox_after_sync_error(&self, error_message: &str) -> Result<()> {
        let sending = self.select_outbox(
            "SELECT * FROM sync_outbox_commits WHERE status = 'sending' ORDER BY updated_at ASC",
        )?;
        if sending.is_empty() {
            return Ok(());
        }

        let now = now_ms();
        let auth_error = error_message.contains("HTTP 401") || error_message.contains("HTTP 403");
        for commit in sending {
            let failed = commit.attempt_count >= MAX_SYNC_RETRIES;
            let next_attempt_at = if failed || auth_error {
                0
            } else {
                next_retry_at(now, commit.attempt_count)
            };
            self.mark_outbox_retry_sync(&commit.id, error_message, next_attempt_at, failed)?;
        }
        Ok(())
    }

    fn mark_outbox_retry_sync(
        &self,
        row_id: &str,
        error: &str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Result<()> {
        let now = now_ms();
        self.execute_blob_statement(
            "UPDATE sync_outbox_commits \
             SET status = ?1, error = ?2, next_attempt_at = ?3, updated_at = ?4 \
             WHERE id = ?5",
            |stmt| {
                bind_text(stmt, 1, if failed { "failed" } else { "pending" })?;
                bind_text(stmt, 2, error)?;
                bind_i64(stmt, 3, if failed { 0 } else { next_attempt_at })?;
                bind_i64(stmt, 4, now)?;
                bind_text(stmt, 5, row_id)
            },
        )?;
        if !failed {
            self.exec(&format!(
                "UPDATE sync_crdt_update_log SET status = 'pending' \
                 WHERE status = 'flushed' \
                   AND client_commit_id = (SELECT client_commit_id FROM sync_outbox_commits WHERE id = {id})",
                id = sql_string(row_id)
            ))?;
            self.refresh_all_crdt_document_counts()?;
        }
        Ok(())
    }

    fn query_rows<T>(
        &self,
        sql: &str,
        mut map: impl FnMut(SqliteRow<'_>) -> Result<T>,
    ) -> Result<Vec<T>> {
        let sql = CString::new(sql).map_err(cstring_error("query sql"))?;
        let mut stmt = ptr::null_mut();
        let rc = unsafe {
            ffi::sqlite3_prepare_v2(
                self.db,
                sql.as_ptr(),
                -1,
                &mut stmt as *mut _,
                ptr::null_mut(),
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(self.db, "prepare query"));
        }

        let mut rows = Vec::new();
        loop {
            match unsafe { ffi::sqlite3_step(stmt) } {
                ffi::SQLITE_ROW => rows.push(map(SqliteRow::new(stmt))?),
                ffi::SQLITE_DONE => break,
                _ => {
                    let err = sqlite_error(self.db, "step query");
                    let _ = finalize_stmt(stmt, self.db, "finalize query after step failure");
                    return Err(err);
                }
            }
        }
        finalize_stmt(stmt, self.db, "finalize query")?;
        Ok(rows)
    }

    fn execute_sql_json_inner(&mut self, sql: &str, params_json: &str) -> Result<String> {
        self.execute_sql_json_inner_with_mode(sql, params_json, SqlExecutionMode::Readonly)
    }

    fn execute_unsafe_sql_json_inner(&mut self, sql: &str, params_json: &str) -> Result<String> {
        self.execute_sql_json_inner_with_mode(sql, params_json, SqlExecutionMode::Unchecked)
    }

    fn execute_sql_json_inner_with_mode(
        &mut self,
        sql: &str,
        params_json: &str,
        mode: SqlExecutionMode,
    ) -> Result<String> {
        let params = parse_params(params_json)?;
        let result = self.execute_sql_result(sql, &params, mode)?;
        Ok(serde_json::to_string(&result)?)
    }

    fn execute_sql_value_inner_with_mode(
        &mut self,
        sql: &str,
        params: JsValue,
        mode: SqlExecutionMode,
    ) -> Result<JsValue> {
        let params: Vec<Value> = serde_wasm_bindgen::from_value(params).map_err(|err| {
            SyncularError::protocol(err).context("decode SQL parameters from JS value")
        })?;
        let result = self.execute_sql_result(sql, &params, mode)?;
        serialize_js_value(&result, "encode SQL result as JS value")
    }

    fn execute_sql_result(
        &mut self,
        sql: &str,
        params: &[Value],
        mode: SqlExecutionMode,
    ) -> Result<Value> {
        let rows = self.execute_sql(sql, params, mode)?;
        let result = serde_json::json!({
            "rows": rows,
            "numAffectedRows": unsafe { ffi::sqlite3_changes(self.db) },
            "insertId": unsafe { ffi::sqlite3_last_insert_rowid(self.db) },
        });
        if mode == SqlExecutionMode::Unchecked {
            self.clear_query_statement_cache();
            self.clear_snapshot_statement_cache();
            let changed_tables = changed_tables_for_sql(sql);
            if !changed_tables.is_empty() {
                self.invalidate_live_queries(&changed_tables)?;
            }
        }
        Ok(result)
    }

    fn subscribe_query_json_inner(
        &mut self,
        sql: &str,
        params_json: &str,
        tables_json: &str,
        hints_json: &str,
    ) -> Result<String> {
        let params = parse_params(params_json)?;
        let tables: Vec<String> = serde_json::from_str(tables_json)?;
        for table in &tables {
            validate_table_name(table)?;
        }
        let dependency_hints: Vec<LiveQueryDependencyHint> = serde_json::from_str(hints_json)?;
        for hint in &dependency_hints {
            validate_table_name(&hint.table)?;
        }
        let stmt = prepare_sql_statement(self.db, sql, SqlExecutionMode::Readonly)?;
        let rows = match execute_prepared_sql(self.db, stmt, &params, "live query") {
            Ok(rows) => rows,
            Err(err) => {
                let _ = finalize_stmt(stmt, self.db, "finalize live query after initial failure");
                return Err(err);
            }
        };
        let id = Uuid::new_v4().to_string();
        let last_hash = result_hash(&rows)?;
        self.live_queries.push(LiveQuery {
            id: id.clone(),
            params,
            tables,
            dependency_hints,
            last_hash,
            stmt,
            rerun_count: 0,
            skipped_rerun_count: 0,
            emitted_event_count: 0,
        });
        Ok(serde_json::to_string(&serde_json::json!({
            "id": id,
            "rows": rows,
        }))?)
    }

    fn execute_sql(
        &mut self,
        sql: &str,
        params: &[Value],
        mode: SqlExecutionMode,
    ) -> Result<Vec<Value>> {
        if mode == SqlExecutionMode::Readonly {
            return self.execute_cached_readonly_sql(sql, params);
        }

        let stmt = prepare_sql_statement(self.db, sql, mode)?;
        let rows = match execute_prepared_sql(self.db, stmt, params, "execute sql") {
            Ok(rows) => rows,
            Err(err) => {
                let _ = finalize_stmt(stmt, self.db, "finalize execute after failure");
                return Err(err);
            }
        };
        finalize_stmt(stmt, self.db, "finalize execute sql")?;
        Ok(rows)
    }

    fn execute_cached_readonly_sql(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        self.query_statement_cache_tick = self.query_statement_cache_tick.wrapping_add(1);
        let now = self.query_statement_cache_tick;
        if let Some(index) = self
            .query_statement_cache
            .iter()
            .position(|entry| entry.sql == sql)
        {
            let stmt = self.query_statement_cache[index].stmt;
            match execute_prepared_sql(self.db, stmt, params, "cached execute sql") {
                Ok(rows) => {
                    self.query_statement_cache[index].last_used = now;
                    return Ok(rows);
                }
                Err(err) => {
                    let entry = self.query_statement_cache.remove(index);
                    let _ = finalize_stmt(entry.stmt, self.db, "finalize failed cached query");
                    return Err(err);
                }
            }
        }

        let stmt = prepare_sql_statement(self.db, sql, SqlExecutionMode::Readonly)?;
        let rows = match execute_prepared_sql(self.db, stmt, params, "execute sql") {
            Ok(rows) => rows,
            Err(err) => {
                let _ = finalize_stmt(stmt, self.db, "finalize execute after failure");
                return Err(err);
            }
        };
        self.insert_cached_query_statement(QueryStatementCacheEntry {
            sql: sql.to_string(),
            stmt,
            last_used: now,
        });
        Ok(rows)
    }

    fn insert_cached_query_statement(&mut self, entry: QueryStatementCacheEntry) {
        if self.query_statement_cache.len() >= QUERY_STATEMENT_CACHE_CAPACITY {
            if let Some(index) = self
                .query_statement_cache
                .iter()
                .enumerate()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(index, _)| index)
            {
                let evicted = self.query_statement_cache.remove(index);
                let _ = finalize_stmt(evicted.stmt, self.db, "finalize evicted cached query");
            }
        }
        self.query_statement_cache.push(entry);
    }

    fn cached_binary_snapshot_statement(
        &mut self,
        table: &str,
        primary_key_column: &str,
        columns: &[String],
        on_conflict: Option<&str>,
        row_count: usize,
        mode: BinarySnapshotWriteMode,
    ) -> Result<*mut ffi::sqlite3_stmt> {
        self.snapshot_statement_cache_tick = self.snapshot_statement_cache_tick.wrapping_add(1);
        let now = self.snapshot_statement_cache_tick;
        if let Some(index) = self.snapshot_statement_cache.iter().position(|entry| {
            entry.table == table
                && entry.primary_key_column == primary_key_column
                && entry.columns == columns
                && entry.on_conflict.as_deref() == on_conflict
                && entry.row_count == row_count
                && entry.mode == mode
        }) {
            self.snapshot_statement_cache[index].last_used = now;
            return Ok(self.snapshot_statement_cache[index].stmt);
        }

        let stmt = prepare_binary_snapshot_write(
            self.db,
            table,
            primary_key_column,
            columns,
            on_conflict,
            row_count,
            mode,
        )?;
        self.insert_cached_snapshot_statement(SnapshotStatementCacheEntry {
            table: table.to_string(),
            primary_key_column: primary_key_column.to_string(),
            columns: columns.to_vec(),
            on_conflict: on_conflict.map(str::to_string),
            row_count,
            mode,
            stmt,
            last_used: now,
        });
        Ok(stmt)
    }

    fn insert_cached_snapshot_statement(&mut self, entry: SnapshotStatementCacheEntry) {
        if self.snapshot_statement_cache.len() >= SNAPSHOT_STATEMENT_CACHE_CAPACITY {
            if let Some(index) = self
                .snapshot_statement_cache
                .iter()
                .enumerate()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(index, _)| index)
            {
                let evicted = self.snapshot_statement_cache.remove(index);
                let _ = finalize_stmt(
                    evicted.stmt,
                    self.db,
                    "finalize evicted cached snapshot statement",
                );
            }
        }
        self.snapshot_statement_cache.push(entry);
    }

    fn clear_query_statement_cache(&mut self) {
        for entry in self.query_statement_cache.drain(..) {
            let _ = finalize_stmt(entry.stmt, self.db, "finalize cached query");
        }
    }

    fn clear_snapshot_statement_cache(&mut self) {
        for entry in self.snapshot_statement_cache.drain(..) {
            let _ = finalize_stmt(entry.stmt, self.db, "finalize cached snapshot statement");
        }
    }

    fn invalidate_live_queries(&mut self, changed_tables: &[String]) -> Result<()> {
        self.invalidate_live_queries_with_rows(changed_tables, &[], false)
    }

    fn notify_local_tables_changed_with_rows(
        &mut self,
        changed_tables: &[String],
        changed_rows: &[SyncChangedRow],
    ) -> Result<()> {
        self.invalidate_live_queries_with_rows(changed_tables, changed_rows, false)?;
        self.push_rows_changed_event("localWrite", changed_tables, changed_rows);
        Ok(())
    }

    fn push_rows_changed_event(
        &mut self,
        source: &str,
        changed_tables: &[String],
        changed_rows: &[SyncChangedRow],
    ) {
        if changed_tables.is_empty() && changed_rows.is_empty() {
            return;
        }
        self.row_events.push(RowsChangedEvent {
            source: source.to_string(),
            changed_tables: changed_tables.to_vec(),
            changed_rows: changed_rows.to_vec(),
        });
    }

    fn invalidate_live_queries_with_rows(
        &mut self,
        changed_tables: &[String],
        changed_rows: &[SyncChangedRow],
        changed_rows_truncated: bool,
    ) -> Result<()> {
        let changed = changed_tables
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let mut next_events = Vec::new();
        for index in 0..self.live_queries.len() {
            if !Self::live_query_should_rerun(
                &self.live_queries[index],
                &changed,
                changed_rows,
                changed_rows_truncated,
            ) {
                self.live_queries[index].skipped_rerun_count = self.live_queries[index]
                    .skipped_rerun_count
                    .saturating_add(1);
                continue;
            }

            self.live_queries[index].rerun_count =
                self.live_queries[index].rerun_count.saturating_add(1);
            let rows = execute_prepared_sql(
                self.db,
                self.live_queries[index].stmt,
                &self.live_queries[index].params,
                "live query rerun",
            )?;
            let hash = result_hash(&rows)?;
            if hash != self.live_queries[index].last_hash {
                self.live_queries[index].last_hash = hash;
                self.live_queries[index].emitted_event_count = self.live_queries[index]
                    .emitted_event_count
                    .saturating_add(1);
                next_events.push(LiveQueryEvent {
                    query_id: self.live_queries[index].id.clone(),
                    version: now_ms(),
                    changed_rows: changed_rows.to_vec(),
                    rows,
                });
            }
        }
        self.live_events.extend(next_events);
        Ok(())
    }

    fn live_query_diagnostics_json_inner(&self) -> Result<String> {
        Ok(serde_json::to_string(&LiveQueryDiagnostics {
            queries: self
                .live_queries
                .iter()
                .map(|query| LiveQueryDiagnostic {
                    id: query.id.clone(),
                    tables: query.tables.clone(),
                    dependency_hint_count: query.dependency_hints.len(),
                    rerun_count: query.rerun_count,
                    skipped_rerun_count: query.skipped_rerun_count,
                    emitted_event_count: query.emitted_event_count,
                })
                .collect(),
        })?)
    }

    fn live_query_should_rerun(
        query: &LiveQuery,
        changed_tables: &std::collections::HashSet<&str>,
        changed_rows: &[SyncChangedRow],
        changed_rows_truncated: bool,
    ) -> bool {
        let affected_tables = query
            .tables
            .iter()
            .filter(|table| changed_tables.contains(table.as_str()))
            .collect::<Vec<_>>();
        if affected_tables.is_empty() {
            return false;
        }
        if query.dependency_hints.is_empty() || changed_rows.is_empty() || changed_rows_truncated {
            return true;
        }

        for table in affected_tables {
            let table_rows = changed_rows
                .iter()
                .filter(|row| row.table == *table)
                .collect::<Vec<_>>();
            if table_rows.is_empty() {
                return true;
            }
            let table_hints = query
                .dependency_hints
                .iter()
                .filter(|hint| hint.table == *table)
                .collect::<Vec<_>>();
            if table_hints.is_empty() {
                return true;
            }
            if table_rows.iter().any(|row| {
                table_hints
                    .iter()
                    .any(|hint| Self::hint_matches_changed_row(hint, row))
            }) {
                return true;
            }
        }
        false
    }

    fn hint_matches_changed_row(hint: &LiveQueryDependencyHint, row: &SyncChangedRow) -> bool {
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

    fn count_rows_inner(&self, table: &str) -> Result<i32> {
        validate_table_name(table)?;
        let sql = CString::new(format!("SELECT COUNT(*) FROM {table}"))
            .map_err(cstring_error("count rows sql"))?;
        let mut stmt = ptr::null_mut();
        let rc = unsafe {
            ffi::sqlite3_prepare_v2(
                self.db,
                sql.as_ptr(),
                -1,
                &mut stmt as *mut _,
                ptr::null_mut(),
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(self.db, "prepare count rows"));
        }

        let step = unsafe { ffi::sqlite3_step(stmt) };
        let result = if step == ffi::SQLITE_ROW {
            Ok(unsafe { ffi::sqlite3_column_int(stmt, 0) })
        } else {
            Err(sqlite_error(self.db, "step count rows"))
        };
        finalize_stmt(stmt, self.db, "finalize count rows")?;
        result
    }

    fn begin_write_transaction(&mut self) -> Result<()> {
        self.clear_query_statement_cache();
        self.exec("BEGIN IMMEDIATE")
    }

    fn exec(&self, sql: &str) -> Result<()> {
        let sql_text = sql;
        let sql = CString::new(sql_text).map_err(cstring_error("sqlite exec sql"))?;
        let rc = unsafe {
            ffi::sqlite3_exec(
                self.db,
                sql.as_ptr(),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if rc == ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(sqlite_error(
                self.db,
                &format!("execute sqlite sql `{sql_text}`"),
            ))
        }
    }

    fn exec_with_changes(&self, sql: &str) -> Result<i64> {
        self.exec(sql)?;
        Ok(unsafe { ffi::sqlite3_changes(self.db) as i64 })
    }

    fn query_count(&self, sql: &str) -> Result<i64> {
        Ok(self
            .query_rows(sql, |row| row.i64("count"))?
            .into_iter()
            .next()
            .unwrap_or_default())
    }

    fn detach_snapshot_artifacts(&mut self) -> Result<()> {
        let mut remaining = Vec::new();
        let mut first_error = None;
        for artifact in std::mem::take(&mut self.attached_snapshot_artifacts) {
            match self.exec(&format!("DETACH {}", artifact.schema)) {
                Ok(()) => {}
                Err(err) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                    remaining.push(artifact);
                }
            }
        }
        self.attached_snapshot_artifacts = remaining;
        if let Some(err) = first_error {
            Err(err)
        } else {
            Ok(())
        }
    }
}

impl AsyncWebStore for SyncularRustOwnedSqlite {
    fn app_schema(&self) -> AppSchema {
        self.app_schema
    }

    fn local_state_id(&self) -> String {
        self.state_id.clone()
    }

    fn begin_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.detach_snapshot_artifacts()?;
            self.apply_timings = WebStoreApplyTimings::default();
            self.begin_write_transaction()
        })
    }

    fn commit_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.exec("COMMIT")?;
            self.detach_snapshot_artifacts()
        })
    }

    fn checkpoint_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.exec("COMMIT")?;
            self.detach_snapshot_artifacts()?;
            self.begin_write_transaction()
        })
    }

    fn rollback_apply_batch<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let rollback = self.exec("ROLLBACK");
            let detach = self.detach_snapshot_artifacts();
            match (rollback, detach) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(err), _) => Err(err),
                (Ok(()), Err(err)) => Err(err),
            }
        })
    }

    fn drain_apply_timings(&mut self) -> WebStoreApplyTimings {
        std::mem::take(&mut self.apply_timings)
    }

    fn supports_sqlite_snapshot_artifacts(&self) -> bool {
        true
    }

    fn apply_sqlite_snapshot_artifact_rows<'a>(
        &'a mut self,
        table: &'a str,
        artifact_bytes: Vec<u8>,
        mode: WebSnapshotArtifactApplyMode,
    ) -> Pin<Box<dyn Future<Output = Result<usize>> + 'a>> {
        Box::pin(
            async move { self.write_sqlite_snapshot_artifact_rows(table, artifact_bytes, mode) },
        )
    }

    fn apply_mutation<'a>(
        &'a mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            self.begin_write_transaction()?;
            let result = (|| {
                let (operation, local_row) =
                    self.transform_local_operation_entry(operation, local_row)?;
                self.apply_local_mutation(&operation, local_row.as_ref())?;
                self.enqueue_outbox_operations(&[operation])
            })();
            match result {
                Ok(client_commit_id) => {
                    self.exec("COMMIT")?;
                    Ok(client_commit_id)
                }
                Err(err) => {
                    let _ = self.exec("ROLLBACK");
                    Err(err)
                }
            }
        })
    }

    fn current_row_json<'a>(
        &'a mut self,
        table: &'a str,
        row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + 'a>> {
        Box::pin(async move {
            let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            SyncularRustOwnedSqlite::current_row_json(self, metadata, table, row_id)
        })
    }

    fn pending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            self.select_outbox(&format!(
                "SELECT * FROM sync_outbox_commits \
                 WHERE status = 'pending' AND attempt_count < {max_retries} AND next_attempt_at <= {now} \
                 ORDER BY created_at ASC LIMIT {limit}",
                max_retries = MAX_SYNC_RETRIES,
                limit = limit.max(1)
            ))
        })
    }

    fn sending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>> {
        Box::pin(async move {
            self.select_outbox(&format!(
                "SELECT * FROM sync_outbox_commits \
                 WHERE status = 'sending' \
                 ORDER BY updated_at ASC LIMIT {limit}",
                limit = limit.max(1)
            ))
        })
    }

    fn requeue_stale_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            let stale_before = now - SYNC_SENDING_TIMEOUT_MS;
            self.exec(&format!(
                "UPDATE sync_outbox_commits SET \
                   status = CASE WHEN attempt_count >= {max_retries} THEN 'failed' ELSE 'pending' END, \
                   error = CASE WHEN attempt_count >= {max_retries} \
                     THEN 'Sync attempt timed out while in sending state' \
                     ELSE 'Sync attempt timed out while in sending state; retrying' END, \
                   next_attempt_at = CASE WHEN attempt_count >= {max_retries} THEN 0 ELSE {now} END, \
                   updated_at = {now} \
                 WHERE status = 'sending' AND updated_at < {stale_before}",
                max_retries = MAX_SYNC_RETRIES
            ))?;
            self.exec(&format!(
                "UPDATE sync_crdt_update_log SET status = 'pending' \
                 WHERE status = 'flushed' AND client_commit_id IN (\
                   SELECT client_commit_id FROM sync_outbox_commits \
                   WHERE status = 'pending' AND updated_at = {now}\
                 )"
            ))?;
            self.refresh_all_crdt_document_counts()
        })
    }

    fn mark_outbox_sending<'a>(
        &'a mut self,
        row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            self.exec(&format!(
                "UPDATE sync_outbox_commits SET status = 'sending', attempt_count = attempt_count + 1, \
                 error = NULL, next_attempt_at = 0, updated_at = {now} WHERE id = {id}",
                now = now,
                id = sql_string(row_id)
            ))?;
            self.exec(&format!(
                "UPDATE sync_crdt_update_log \
                 SET status = 'flushed', flushed_at = coalesce(flushed_at, {now}) \
                 WHERE status = 'pending' \
                   AND client_commit_id = (SELECT client_commit_id FROM sync_outbox_commits WHERE id = {id})",
                id = sql_string(row_id)
            ))?;
            self.refresh_all_crdt_document_counts()
        })
    }

    fn mark_pushed_operation_server_versions<'a>(
        &'a mut self,
        outbox: OutboxCommit,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let operations: Vec<SyncOperation> = serde_json::from_str(&outbox.operations_json)?;
            if response.results.is_empty() {
                if let Some(server_seq) = response.commit_seq {
                    for operation in &operations {
                        if is_encrypted_crdt_system_table(&operation.table) {
                            self.update_encrypted_crdt_system_server_seq(
                                &operation.table,
                                &operation.row_id,
                                server_seq,
                            )?;
                        }
                    }
                }
                return Ok(());
            }

            for result in &response.results {
                if !matches!(result.status.as_str(), "applied" | "cached") {
                    continue;
                }
                let Some(server_seq) = result.server_version.or(response.commit_seq) else {
                    continue;
                };
                let operation = operations.get(result.op_index as usize).ok_or_else(|| {
                    SyncularError::protocol_message(format!(
                        "push response op_index {} out of bounds for local outbox commit {}",
                        result.op_index, outbox.client_commit_id
                    ))
                })?;
                if is_encrypted_crdt_system_table(&operation.table) {
                    self.update_encrypted_crdt_system_server_seq(
                        &operation.table,
                        &operation.row_id,
                        server_seq,
                    )?;
                }
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
            let now = now_ms();
            self.exec(&format!(
                "UPDATE sync_outbox_commits SET status = 'acked', last_response_json = {response}, \
                 error = NULL, acked_commit_seq = {commit_seq}, next_attempt_at = 0, updated_at = {now} WHERE id = {id}",
                response = sql_string(&serde_json::to_string(&response)?),
                commit_seq = response.commit_seq.map_or_else(|| "NULL".to_string(), |value| value.to_string()),
                now = now,
                id = sql_string(row_id)
            ))?;
            self.exec(&format!(
                "UPDATE sync_crdt_update_log \
                 SET status = 'acked', flushed_at = coalesce(flushed_at, {now}), acked_at = coalesce(acked_at, {now}) \
                 WHERE status IN ('pending', 'flushed') \
                   AND client_commit_id = (SELECT client_commit_id FROM sync_outbox_commits WHERE id = {id})",
                id = sql_string(row_id)
            ))?;
            self.refresh_all_crdt_document_counts()
        })
    }

    fn mark_outbox_failed<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.exec(&format!(
                "UPDATE sync_outbox_commits SET status = 'failed', last_response_json = {response}, \
                 error = {error}, next_attempt_at = 0, updated_at = {now} WHERE id = {id}",
                response = sql_string(&serde_json::to_string(&response)?),
                error = sql_string(error),
                now = now_ms(),
                id = sql_string(row_id)
            ))
        })
    }

    fn mark_outbox_retry<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move { self.mark_outbox_retry_sync(row_id, error, next_attempt_at, failed) })
    }

    fn insert_conflict<'a>(
        &'a mut self,
        outbox: OutboxCommit,
        result: OperationResult,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let message = result
                .message
                .clone()
                .or_else(|| result.error.clone())
                .unwrap_or_else(|| result.status.clone());
            self.exec(&format!(
                "INSERT INTO sync_conflicts \
                 (id, outbox_commit_id, client_commit_id, op_index, result_status, message, code, server_version, server_row_json, created_at) \
                 VALUES ({id}, {outbox_id}, {client_commit_id}, {op_index}, {status}, {message}, {code}, {server_version}, {server_row}, {created_at})",
                id = sql_string(&Uuid::new_v4().to_string()),
                outbox_id = sql_string(&outbox.id),
                client_commit_id = sql_string(&outbox.client_commit_id),
                op_index = result.op_index,
                status = sql_string(&result.status),
                message = sql_string(&message),
                code = optional_sql_string(result.code.as_deref()),
                server_version = result.server_version.map_or_else(|| "NULL".to_string(), |value| value.to_string()),
                server_row = result.server_row.as_ref().map_or_else(|| "NULL".to_string(), |row| sql_string(&row.to_string())),
                created_at = now_ms()
            ))
        })
    }

    fn upsert_auth_lease<'a>(
        &'a mut self,
        lease: AuthLeaseRecord,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move { self.upsert_auth_lease_sync(&lease) })
    }

    fn auth_lease<'a>(
        &'a mut self,
        lease_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<AuthLeaseRecord>>> + 'a>> {
        Box::pin(async move { self.auth_lease_sync(lease_id) })
    }

    fn active_auth_leases<'a>(
        &'a mut self,
        actor_id: Option<&'a str>,
        now_ms_value: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AuthLeaseRecord>>> + 'a>> {
        Box::pin(async move { self.active_auth_leases_sync(actor_id, now_ms_value) })
    }

    fn set_outbox_auth_lease<'a>(
        &'a mut self,
        client_commit_id: &'a str,
        provenance: Option<AuthLeaseProvenance>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(
            async move { self.set_outbox_auth_lease_sync(client_commit_id, provenance.as_ref()) },
        )
    }

    fn conflict_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ConflictSummary>>> + 'a>> {
        Box::pin(async move {
            self.query_rows(
                "SELECT id, client_commit_id, op_index, result_status, message, code, server_version, resolved_at, resolution \
                 FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC",
                |row| {
                    Ok(ConflictSummary {
                        id: row.string("id")?,
                        client_commit_id: row.string("client_commit_id")?,
                        op_index: row.i32("op_index")?,
                        result_status: row.string("result_status")?,
                        message: row.string("message")?,
                        code: row.optional_string("code"),
                        server_version: row.optional_i64("server_version"),
                        resolved_at: row.optional_i64("resolved_at"),
                        resolution: row.optional_string("resolution"),
                    })
                },
            )
        })
    }

    fn resolve_conflict<'a>(
        &'a mut self,
        id: &'a str,
        resolution: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.exec(&format!(
                "UPDATE sync_conflicts SET resolved_at = {now}, resolution = {resolution} WHERE id = {id} AND resolved_at IS NULL",
                now = now_ms(),
                resolution = sql_string(resolution),
                id = sql_string(id)
            ))
        })
    }

    fn retry_conflict_keep_local<'a>(
        &'a mut self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            let rows = self.query_rows(
                &format!(
                    "SELECT c.op_index, c.server_version, o.operations_json \
                     FROM sync_conflicts c JOIN sync_outbox_commits o ON o.id = c.outbox_commit_id \
                     WHERE c.id = {} AND c.resolved_at IS NULL LIMIT 1",
                    sql_string(id)
                ),
                |row| {
                    Ok((
                        row.i32("op_index")?,
                        row.optional_i64("server_version"),
                        row.string("operations_json")?,
                    ))
                },
            )?;
            let Some((op_index, server_version, operations_json)) = rows.into_iter().next() else {
                return Err(SyncularError::config(format!(
                    "pending conflict not found: {id}"
                )));
            };
            let Some(server_version) = server_version else {
                return Err(SyncularError::protocol_message(format!(
                    "conflict {id} cannot be retried keep-local without server version"
                )));
            };
            let mut operations: Vec<SyncOperation> = serde_json::from_str(&operations_json)?;
            let op_index = usize::try_from(op_index).map_err(|_| {
                SyncularError::protocol_message(format!(
                    "conflict {id} references invalid operation index"
                ))
            })?;
            let Some(operation) = operations.get_mut(op_index) else {
                return Err(SyncularError::protocol_message(format!(
                    "conflict {id} references missing operation index {op_index}"
                )));
            };
            operation.base_version = Some(server_version);
            let retry_operation = operation.clone();

            self.begin_write_transaction()?;
            let result = (|| {
                let client_commit_id = self.enqueue_outbox_operations(&[retry_operation])?;
                self.exec(&format!(
                    "UPDATE sync_conflicts SET resolved_at = {now}, resolution = 'keep-local' WHERE id = {id}",
                    now = now_ms(),
                    id = sql_string(id)
                ))?;
                Ok(client_commit_id)
            })();
            match result {
                Ok(client_commit_id) => {
                    self.exec("COMMIT")?;
                    Ok(client_commit_id)
                }
                Err(err) => {
                    let _ = self.exec("ROLLBACK");
                    Err(err)
                }
            }
        })
    }

    fn subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebSubscriptionState>>> + 'a>> {
        Box::pin(async move {
            let rows = self.query_rows(
                &format!(
                    "SELECT subscription_id, \"table\", scopes_json, cursor, bootstrap_state_json, status \
                     FROM sync_subscription_state WHERE state_id = {} AND subscription_id = {} LIMIT 1",
                    sql_string(&self.state_id),
                    sql_string(subscription_id)
                ),
                |row| {
                    Ok(WebSubscriptionState {
                        subscription_id: row.string("subscription_id")?,
                        table: row.string("table")?,
                        scopes: parse_scope_values(&row.string("scopes_json")?)?,
                        cursor: row.i64("cursor")?,
                        bootstrap_state: row
                            .optional_string("bootstrap_state_json")
                            .map(|value| serde_json::from_str(&value))
                            .transpose()?,
                        status: row.string("status")?,
                    })
                },
            )?;
            Ok(rows.into_iter().next())
        })
    }

    fn upsert_subscription_state<'a>(
        &'a mut self,
        state: WebSubscriptionState,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            let bootstrap = state
                .bootstrap_state
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            self.exec(&format!(
                "INSERT INTO sync_subscription_state \
                 (state_id, subscription_id, \"table\", scopes_json, params_json, cursor, bootstrap_state_json, status, created_at, updated_at) \
                 VALUES ({state_id}, {subscription_id}, {table}, {scopes}, '{{}}', {cursor}, {bootstrap}, {status}, {now}, {now}) \
                 ON CONFLICT(state_id, subscription_id) DO UPDATE SET \
                   \"table\" = excluded.\"table\", scopes_json = excluded.scopes_json, cursor = excluded.cursor, \
                   bootstrap_state_json = excluded.bootstrap_state_json, status = excluded.status, updated_at = excluded.updated_at",
                state_id = sql_string(&self.state_id),
                subscription_id = sql_string(&state.subscription_id),
                table = sql_string(&state.table),
                scopes = sql_string(&serde_json::to_string(&state.scopes)?),
                cursor = state.cursor,
                bootstrap = optional_sql_string(bootstrap.as_deref()),
                status = sql_string(&state.status),
            ))
        })
    }

    fn delete_subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.exec(&format!(
                "DELETE FROM sync_subscription_state WHERE state_id = {} AND subscription_id = {}",
                sql_string(&self.state_id),
                sql_string(subscription_id)
            ))
        })
    }

    fn subscription_states<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SubscriptionState>>> + 'a>> {
        Box::pin(async move {
            self.query_rows(
                &format!(
                    "SELECT state_id, subscription_id, \"table\", scopes_json, params_json, cursor, bootstrap_state_json, status \
                     FROM sync_subscription_state WHERE state_id = {} ORDER BY subscription_id ASC",
                    sql_string(&self.state_id)
                ),
                |row| {
                    Ok(SubscriptionState {
                        state_id: row.string("state_id")?,
                        subscription_id: row.string("subscription_id")?,
                        table: row.string("table")?,
                        scopes_json: row.string("scopes_json")?,
                        params_json: row.string("params_json")?,
                        cursor: row.i64("cursor")?,
                        bootstrap_state_json: row.optional_string("bootstrap_state_json"),
                        status: row.string("status")?,
                    })
                },
            )
        })
    }

    fn verified_root<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebVerifiedRoot>>> + 'a>> {
        Box::pin(async move {
            let rows = self.query_rows(
                &format!(
                    "SELECT subscription_id, partition_id, commit_seq, root \
                     FROM sync_verified_roots WHERE state_id = {} AND subscription_id = {} LIMIT 1",
                    sql_string(&self.state_id),
                    sql_string(subscription_id)
                ),
                |row| {
                    Ok(WebVerifiedRoot {
                        subscription_id: row.string("subscription_id")?,
                        partition_id: row.string("partition_id")?,
                        commit_seq: row.i64("commit_seq")?,
                        root: row.string("root")?,
                    })
                },
            )?;
            Ok(rows.into_iter().next())
        })
    }

    fn upsert_verified_root<'a>(
        &'a mut self,
        root: WebVerifiedRoot,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let now = now_ms();
            self.exec(&format!(
                "INSERT INTO sync_verified_roots \
                 (state_id, subscription_id, partition_id, commit_seq, root, created_at, updated_at) \
                 VALUES ({state_id}, {subscription_id}, {partition_id}, {commit_seq}, {root}, {now}, {now}) \
                 ON CONFLICT(state_id, subscription_id) DO UPDATE SET \
                   partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, \
                   root = excluded.root, updated_at = excluded.updated_at",
                state_id = sql_string(&self.state_id),
                subscription_id = sql_string(&root.subscription_id),
                partition_id = sql_string(&root.partition_id),
                commit_seq = root.commit_seq,
                root = sql_string(&root.root),
            ))
        })
    }

    fn delete_verified_root<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.exec(&format!(
                "DELETE FROM sync_verified_roots WHERE state_id = {} AND subscription_id = {}",
                sql_string(&self.state_id),
                sql_string(subscription_id)
            ))
        })
    }

    fn verified_roots<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<VerifiedRoot>>> + 'a>> {
        Box::pin(async move {
            self.query_rows(
                &format!(
                    "SELECT state_id, subscription_id, partition_id, commit_seq, root \
                     FROM sync_verified_roots WHERE state_id = {} ORDER BY subscription_id ASC",
                    sql_string(&self.state_id)
                ),
                |row| {
                    Ok(VerifiedRoot {
                        state_id: row.string("state_id")?,
                        subscription_id: row.string("subscription_id")?,
                        partition_id: row.string("partition_id")?,
                        commit_seq: row.i64("commit_seq")?,
                        root: row.string("root")?,
                    })
                },
            )
        })
    }

    fn scoped_rows_health_summary<'a>(
        &'a mut self,
        subscriptions: &'a [SubscriptionSpec],
    ) -> Pin<Box<dyn Future<Output = Result<Option<ScopedRowsHealthSummary>>> + 'a>> {
        Box::pin(async move {
            let mut summary = ScopedRowsHealthSummary::default();
            for metadata in self.app_schema.app_table_metadata {
                validate_table_name(metadata.name)?;
                validate_table_name(metadata.server_version_column)?;
                let checked_synced_rows = self.query_count(&format!(
                    "SELECT COUNT(*) AS count FROM {table} WHERE {server_version} > 0",
                    table = metadata.name,
                    server_version = metadata.server_version_column
                ))?;
                let table_subscriptions = subscriptions
                    .iter()
                    .filter(|subscription| subscription.table == metadata.name)
                    .collect::<Vec<_>>();
                let orphaned_synced_rows = if checked_synced_rows == 0 {
                    0
                } else if table_subscriptions.is_empty() {
                    checked_synced_rows
                } else {
                    let scope_clauses = table_subscriptions
                        .iter()
                        .map(|subscription| scope_clause(metadata, &subscription.scopes))
                        .collect::<Result<Vec<_>>>()?;
                    self.query_count(&format!(
                        "SELECT COUNT(*) AS count FROM {table} WHERE {server_version} > 0 AND NOT ({scope_clause})",
                        table = metadata.name,
                        server_version = metadata.server_version_column,
                        scope_clause = scope_clauses.join(" OR ")
                    ))?
                };
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
            validate_requested_app_tables(self.app_schema, tables)?;
            let mut summary = ScopedRowsHealthSummary::default();
            for metadata in self
                .app_schema
                .app_table_metadata
                .iter()
                .filter(|metadata| {
                    tables.is_empty() || tables.iter().any(|table| table == metadata.name)
                })
            {
                validate_table_name(metadata.name)?;
                validate_table_name(metadata.server_version_column)?;
                let checked_synced_rows = self.query_count(&format!(
                    "SELECT COUNT(*) AS count FROM {table} WHERE {server_version} > 0",
                    table = metadata.name,
                    server_version = metadata.server_version_column
                ))?;
                let table_subscriptions = subscriptions
                    .iter()
                    .filter(|subscription| subscription.table == metadata.name)
                    .collect::<Vec<_>>();
                let orphaned_synced_rows = if checked_synced_rows == 0 {
                    0
                } else if table_subscriptions.is_empty() {
                    self.exec_with_changes(&format!(
                        "DELETE FROM {table} WHERE {server_version} > 0",
                        table = metadata.name,
                        server_version = metadata.server_version_column
                    ))?
                } else {
                    let scope_clauses = table_subscriptions
                        .iter()
                        .map(|subscription| scope_clause(metadata, &subscription.scopes))
                        .collect::<Result<Vec<_>>>()?;
                    self.exec_with_changes(&format!(
                        "DELETE FROM {table} WHERE {server_version} > 0 AND NOT ({scope_clause})",
                        table = metadata.name,
                        server_version = metadata.server_version_column,
                        scope_clause = scope_clauses.join(" OR ")
                    ))?
                };
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

    fn app_schema_state<'a>(
        &'a mut self,
        current_schema_version: i32,
    ) -> Pin<Box<dyn Future<Output = Result<AppSchemaState>> + 'a>> {
        Box::pin(async move {
            let rows = self.query_rows(
                &format!(
                    "SELECT schema_version, updated_at FROM syncular_app_schema WHERE schema_id = {} LIMIT 1",
                    sql_string(GENERATED_SCHEMA_ID)
                ),
                |row| {
                    Ok(AppSchemaState {
                        schema_id: GENERATED_SCHEMA_ID.to_string(),
                        schema_version: Some(row.i32("schema_version")?),
                        current_schema_version,
                        updated_at: row.optional_i64("updated_at"),
                    })
                },
            )?;
            Ok(rows.into_iter().next().unwrap_or(AppSchemaState {
                schema_id: GENERATED_SCHEMA_ID.to_string(),
                schema_version: None,
                current_schema_version,
                updated_at: None,
            }))
        })
    }

    fn outbox_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxSummary>>> + 'a>> {
        Box::pin(async move {
            self.query_rows(
                "SELECT client_commit_id, status, schema_version, \
                        lease_id, lease_expires_at_ms, lease_status_at_enqueue, \
                        lease_scope_summary_json \
                 FROM sync_outbox_commits ORDER BY created_at ASC",
                |row| {
                    Ok(OutboxSummary {
                        client_commit_id: row.string("client_commit_id")?,
                        status: row.string("status")?,
                        schema_version: row.i32("schema_version")?,
                        auth_lease: auth_lease_provenance_from_columns(
                            row.optional_string("lease_id"),
                            row.optional_i64("lease_expires_at_ms"),
                            row.optional_string("lease_status_at_enqueue"),
                            row.optional_string("lease_scope_summary_json"),
                        ),
                    })
                },
            )
        })
    }

    #[cfg(feature = "web-blobs")]
    fn blob_health_summary<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<BlobHealthSummary>>> + 'a>> {
        Box::pin(async move {
            let upload = self.query_rows(
                "SELECT status, COUNT(hash) AS count FROM sync_blob_outbox GROUP BY status",
                |row| Ok((row.string("status")?, row.i64("count")?)),
            )?;
            let mut upload_pending = 0i64;
            let mut upload_uploading = 0i64;
            let mut upload_failed = 0i64;
            for (status, count) in upload {
                match status.as_str() {
                    "pending" => upload_pending = count,
                    "uploading" => upload_uploading = count,
                    "failed" => upload_failed = count,
                    _ => {}
                }
            }
            let cache = self.query_rows(
                "SELECT COUNT(hash) AS count, COALESCE(SUM(size), 0) AS total_bytes FROM sync_blob_cache",
                |row| Ok((row.i64("count")?, row.i64("total_bytes")?)),
            )?;
            let (cache_count, cache_bytes) = cache.into_iter().next().unwrap_or((0, 0));
            let (checked_references, invalid_references) = self.blob_reference_health_counts()?;
            Ok(Some(BlobHealthSummary {
                cache_count,
                cache_bytes,
                upload_pending,
                upload_uploading,
                upload_failed,
                checked_references,
                invalid_references,
            }))
        })
    }

    fn crdt_health_summary<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CrdtHealthSummary>>> + 'a>> {
        Box::pin(async move {
            let stats = self.query_rows(
                "SELECT \
                   COUNT(*) AS document_count, \
                   COALESCE(SUM(pending_updates), 0) AS pending_updates, \
                   COALESCE(SUM(flushed_updates), 0) AS flushed_updates, \
                   COALESCE(SUM(acked_updates), 0) AS acked_updates, \
                   COALESCE(SUM(log_updates), 0) AS log_updates \
                 FROM sync_crdt_documents",
                |row| {
                    Ok(CrdtHealthSummary {
                        document_count: row.i64("document_count")?,
                        pending_updates: row.i64("pending_updates")?,
                        flushed_updates: row.i64("flushed_updates")?,
                        acked_updates: row.i64("acked_updates")?,
                        log_updates: row.i64("log_updates")?,
                        orphaned_documents: 0,
                        orphaned_log_entries: 0,
                    })
                },
            )?;
            let mut summary = stats.into_iter().next().unwrap_or_default();
            summary.orphaned_documents = self.orphaned_crdt_document_count()?;
            summary.orphaned_log_entries = self
                .query_rows(
                    "SELECT COUNT(*) AS count \
                     FROM sync_crdt_update_log log \
                     LEFT JOIN sync_crdt_documents documents \
                       ON documents.document_key = log.document_key \
                     WHERE documents.document_key IS NULL",
                    |row| row.i64("count"),
                )?
                .into_iter()
                .next()
                .unwrap_or(0);
            Ok(Some(summary))
        })
    }

    fn crdt_state_vector_hints<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
        limit: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<CrdtStateVectorHint>>> + 'a>> {
        Box::pin(async move { self.crdt_state_vector_hints_for_subscription(table, scopes, limit) })
    }

    fn clear_table_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if is_encrypted_crdt_system_table(table) {
                return self.clear_encrypted_crdt_system_table_for_scopes(table, scopes);
            }
            let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            validate_table_name(table)?;
            let filters = scope_sql_filters(metadata, scopes)?;
            if filters.is_empty() {
                return self.exec(&format!("DELETE FROM {table}"));
            }
            self.exec(&format!(
                "DELETE FROM {table} WHERE {}",
                filters.join(" AND ")
            ))
        })
    }

    fn clear_synced_rows_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<i64>> + 'a>> {
        Box::pin(async move {
            if is_encrypted_crdt_system_table(table) {
                return Err(SyncularError::config(
                    "resetLocalSyncState only clears generated app table rows",
                ));
            }
            let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            validate_table_name(table)?;
            validate_table_name(metadata.server_version_column)?;
            let mut filters = scope_sql_filters(metadata, scopes)?;
            filters.push(format!("{} > 0", metadata.server_version_column));
            self.exec_with_changes(&format!(
                "DELETE FROM {table} WHERE {}",
                filters.join(" AND ")
            ))
        })
    }

    fn clear_table_for_scopes_preserving_local_crdt<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if is_encrypted_crdt_system_table(table) {
                return self.clear_encrypted_crdt_system_table_for_scopes(table, scopes);
            }
            let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            let encrypted_fields = metadata
                .crdt_yjs_fields
                .iter()
                .filter(|field| field.sync_mode == "encrypted-update-log")
                .collect::<Vec<_>>();
            if encrypted_fields.is_empty() {
                return self.clear_table_for_scopes(table, scopes).await;
            }
            validate_table_name(table)?;
            let mut filters = Vec::new();
            for (scope_name, value) in scopes {
                let column = metadata
                    .scopes
                    .iter()
                    .find(|scope| scope.name == scope_name)
                    .map(|scope| scope.column)
                    .unwrap_or(scope_name.as_str());
                validate_table_name(column)?;
                if let Value::Array(values) = value {
                    if values.is_empty() {
                        filters.push("0 = 1".to_string());
                    } else {
                        filters.push(format!(
                            "{column} IN ({})",
                            values.iter().map(sql_value).collect::<Vec<_>>().join(", ")
                        ));
                    }
                } else {
                    filters.push(format!("{column} = {}", sql_value(value)));
                }
            }
            for field in encrypted_fields {
                validate_table_name(field.state_column)?;
                filters.push(format!(
                    "({state} IS NULL OR {state} = '')",
                    state = field.state_column
                ));
            }
            if filters.is_empty() {
                return self.exec(&format!("DELETE FROM {table}"));
            }
            self.exec(&format!(
                "DELETE FROM {table} WHERE {}",
                filters.join(" AND ")
            ))
        })
    }

    fn upsert_row<'a>(
        &'a mut self,
        table: &'a str,
        row: Value,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if is_encrypted_crdt_system_table(table) {
                let identity = encrypted_crdt_identity_column(table)?;
                let row_id = row.get(identity).and_then(Value::as_str).ok_or_else(|| {
                    SyncularError::protocol_message(format!(
                        "encrypted CRDT row missing identity column {identity}"
                    ))
                })?;
                let row = self.upsert_encrypted_crdt_system_row(table, row_id, Some(&row), None)?;
                self.materialize_encrypted_crdt_system_row(table, &row)?;
                return Ok(());
            }

            let metadata = self.app_schema.table_metadata(table).ok_or_else(|| {
                SyncularError::config(format!("unknown generated app table: {table}"))
            })?;
            let row = materialize_row_for_metadata(table, None, row, metadata)?;
            let row = object_from_value(Some(&row))?;
            let row = self.preserve_encrypted_crdt_materialized_columns(metadata, row)?;
            self.upsert_row_object(table, metadata.primary_key_column, &row)
        })
    }

    fn upsert_rows<'a>(
        &'a mut self,
        table: &'a str,
        rows: Vec<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if is_encrypted_crdt_system_table(table) {
                for row in rows {
                    self.upsert_row(table, row).await?;
                }
                return Ok(());
            }

            self.write_app_rows(table, rows)
        })
    }

    fn upsert_snapshot_chunk_rows<'a>(
        &'a mut self,
        table: &'a str,
        rows: SnapshotChunkRows,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            match rows {
                SnapshotChunkRows::Json(rows) => self.upsert_rows(table, rows).await,
                SnapshotChunkRows::Binary(rows) => {
                    self.write_binary_snapshot_rows(table, rows, BinarySnapshotWriteMode::Upsert)
                }
                SnapshotChunkRows::BinaryPayload(rows) => {
                    self.write_binary_snapshot_payload(table, rows, BinarySnapshotWriteMode::Upsert)
                }
            }
        })
    }

    fn insert_cleared_snapshot_chunk_rows<'a>(
        &'a mut self,
        table: &'a str,
        rows: SnapshotChunkRows,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            match rows {
                SnapshotChunkRows::Json(rows) => self.upsert_rows(table, rows).await,
                SnapshotChunkRows::Binary(rows) => {
                    self.write_binary_snapshot_rows(table, rows, BinarySnapshotWriteMode::Insert)
                }
                SnapshotChunkRows::BinaryPayload(rows) => {
                    self.write_binary_snapshot_payload(table, rows, BinarySnapshotWriteMode::Insert)
                }
            }
        })
    }

    fn apply_change<'a>(
        &'a mut self,
        change: SyncChange,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            if is_encrypted_crdt_system_table(&change.table) {
                if change.op == "delete" {
                    return self.delete_encrypted_crdt_system_row(&change.table, &change.row_id);
                }
                let row = self.upsert_encrypted_crdt_system_row(
                    &change.table,
                    &change.row_id,
                    change.row_json.as_ref(),
                    change.row_version,
                )?;
                self.materialize_encrypted_crdt_system_row(&change.table, &row)?;
                return Ok(());
            }

            let metadata = self
                .app_schema
                .table_metadata(&change.table)
                .ok_or_else(|| {
                    SyncularError::config(format!("unknown generated app table: {}", change.table))
                })?;
            if change.op == "delete" {
                return self.delete_row(&change.table, metadata.primary_key_column, &change.row_id);
            }
            let row_json = change.row_json.as_ref().ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "upsert change missing row_json for {}",
                    change.table
                ))
            })?;
            let row_json = if has_yjs_payload(row_json) {
                let existing_row = SyncularRustOwnedSqlite::current_row_json(
                    self,
                    metadata,
                    &change.table,
                    &change.row_id,
                )?;
                transform_local_row_for_metadata(
                    &change.table,
                    &change.row_id,
                    None,
                    Some(row_json),
                    existing_row.as_ref(),
                    metadata,
                )?
                .ok_or_else(|| {
                    SyncularError::protocol_message(format!(
                        "server-merge Yjs change for {}.{} did not materialize a row",
                        change.table, change.row_id
                    ))
                })?
            } else {
                materialize_row_for_metadata(
                    &change.table,
                    Some(&change.row_id),
                    row_json.clone(),
                    metadata,
                )?
            };
            let mut row = object_from_value(Some(&row_json))?;
            row.insert(
                metadata.primary_key_column.to_string(),
                Value::String(change.row_id),
            );
            if let Some(version) = change.row_version {
                row.insert(
                    metadata.server_version_column.to_string(),
                    Value::Number(version.into()),
                );
            }
            let row = self.preserve_encrypted_crdt_materialized_columns(metadata, row)?;
            self.upsert_row_object(&change.table, metadata.primary_key_column, &row)
        })
    }

    fn list_table_json<'a>(
        &'a mut self,
        table: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            if self.app_schema.table_metadata(table).is_none() {
                return Err(SyncularError::config(format!(
                    "unknown generated app table: {table}"
                )));
            }
            validate_table_name(table)?;
            let rows = self.query_rows(&format!("SELECT * FROM {table}"), |row| row.to_json())?;
            Ok(serde_json::to_string(&rows)?)
        })
    }

    fn notify_tables_changed<'a>(
        &'a mut self,
        tables: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move { self.invalidate_live_queries(tables) })
    }

    fn notify_tables_changed_with_rows<'a>(
        &'a mut self,
        tables: &'a [String],
        changed_rows: &'a [SyncChangedRow],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move { self.invalidate_live_queries_with_rows(tables, changed_rows, false) })
    }

    fn notify_tables_changed_with_rows_meta<'a>(
        &'a mut self,
        tables: &'a [String],
        changed_rows: &'a [SyncChangedRow],
        changed_rows_truncated: bool,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.invalidate_live_queries_with_rows(tables, changed_rows, changed_rows_truncated)
        })
    }

    fn notify_local_tables_changed_with_rows<'a>(
        &'a mut self,
        tables: &'a [String],
        changed_rows: &'a [SyncChangedRow],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            SyncularRustOwnedSqlite::notify_local_tables_changed_with_rows(
                self,
                tables,
                changed_rows,
            )
        })
    }
}

impl Drop for SyncularRustOwnedSqlite {
    fn drop(&mut self) {
        self.clear_query_statement_cache();
        self.clear_snapshot_statement_cache();
        for query in self.live_queries.drain(..) {
            let _ = finalize_stmt(query.stmt, self.db, "finalize live query on close");
        }
        let _ = self.detach_snapshot_artifacts();
        close_db(self.db);
        self.db = ptr::null_mut();
    }
}

fn validate_table_name(table: &str) -> Result<()> {
    if !table.is_empty()
        && table
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        Ok(())
    } else {
        Err(SyncularError::schema(format!(
            "invalid sqlite table identifier: {table}"
        )))
    }
}

fn binary_snapshot_on_conflict(
    columns: &[String],
    primary_key_column: &str,
    mode: BinarySnapshotWriteMode,
) -> Option<String> {
    if mode != BinarySnapshotWriteMode::Upsert {
        return None;
    }
    let update_columns = columns
        .iter()
        .map(String::as_str)
        .filter(|column| *column != primary_key_column)
        .collect::<Vec<_>>();
    Some(if update_columns.is_empty() {
        "DO NOTHING".to_string()
    } else {
        format!(
            "DO UPDATE SET {}",
            update_columns
                .iter()
                .map(|column| format!("{column} = excluded.{column}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

fn deserialize_sqlite_snapshot_artifact_schema(
    db: *mut ffi::sqlite3,
    schema: &str,
    artifact_buffer: &mut [u8],
) -> Result<()> {
    validate_table_name(schema)?;
    let artifact_len = i64::try_from(artifact_buffer.len())
        .map_err(|_| SyncularError::protocol_message("sqlite snapshot artifact is too large"))?;
    let schema = CString::new(schema).map_err(cstring_error("sqlite artifact schema"))?;
    let rc = unsafe {
        ffi::sqlite3_deserialize(
            db,
            schema.as_ptr(),
            artifact_buffer.as_mut_ptr(),
            artifact_len,
            artifact_len,
            ffi::SQLITE_DESERIALIZE_READONLY,
        )
    };
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlite_error(db, "deserialize sqlite snapshot artifact"))
    }
}

fn sqlite_table_column_names(
    db: *mut ffi::sqlite3,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<String>> {
    validate_table_name(table)?;
    let table_arg = sql_string(table);
    let sql = if let Some(schema) = schema {
        validate_table_name(schema)?;
        format!("SELECT name FROM {schema}.pragma_table_info({table_arg}) ORDER BY cid")
    } else {
        format!("SELECT name FROM pragma_table_info({table_arg}) ORDER BY cid")
    };
    let stmt = prepare_sql_statement(db, &sql, SqlExecutionMode::Readonly)?;
    let mut columns = Vec::new();
    let result = (|| {
        loop {
            match unsafe { ffi::sqlite3_step(stmt) } {
                ffi::SQLITE_ROW => {
                    let value = sqlite_column_text_json_value(stmt, 0)?;
                    let Some(column) = value.as_str() else {
                        return Err(SyncularError::storage(anyhow::anyhow!(
                            "sqlite artifact table column name is not text"
                        )));
                    };
                    columns.push(column.to_string());
                }
                ffi::SQLITE_DONE => break,
                _ => {
                    return Err(sqlite_error(db, "step sqlite artifact table columns"));
                }
            }
        }
        Ok(columns)
    })();
    let finalize = finalize_stmt(stmt, db, "finalize sqlite artifact table columns");
    match (result, finalize) {
        (Ok(columns), Ok(())) => Ok(columns),
        (Err(err), _) => Err(err),
        (Ok(_), Err(err)) => Err(err),
    }
}

fn prepare_sql_statement(
    db: *mut ffi::sqlite3,
    sql: &str,
    mode: SqlExecutionMode,
) -> Result<*mut ffi::sqlite3_stmt> {
    let sql = CString::new(sql).map_err(cstring_error("sqlite sql"))?;
    let mut stmt: *mut ffi::sqlite3_stmt = ptr::null_mut();
    let mut tail: *const c_char = ptr::null();
    let rc = unsafe {
        ffi::sqlite3_prepare_v3(
            db,
            sql.as_ptr(),
            -1,
            ffi::SQLITE_PREPARE_PERSISTENT,
            &mut stmt as *mut _,
            &mut tail as *mut _,
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, "prepare sqlite statement"));
    }
    if stmt.is_null() {
        return Err(SyncularError::config("SQL statement must not be empty"));
    }
    if c_tail_has_statement(tail) {
        let _ = finalize_stmt(stmt, db, "finalize multi-statement sql");
        return Err(SyncularError::config(
            "executeSqlJson only accepts one SQL statement",
        ));
    }
    if mode == SqlExecutionMode::Readonly && unsafe { ffi::sqlite3_stmt_readonly(stmt) } == 0 {
        let _ = finalize_stmt(stmt, db, "finalize non-read-only sql");
        return Err(SyncularError::config(
            "executeSqlJson only accepts read-only SQL; use Syncular mutations for writes",
        ));
    }
    Ok(stmt)
}

fn c_tail_has_statement(mut tail: *const c_char) -> bool {
    if tail.is_null() {
        return false;
    }
    loop {
        let byte = unsafe { *tail as u8 };
        if byte == 0 {
            return false;
        }
        if !byte.is_ascii_whitespace() && byte != b';' {
            return true;
        }
        tail = unsafe { tail.add(1) };
    }
}

fn execute_prepared_sql(
    db: *mut ffi::sqlite3,
    stmt: *mut ffi::sqlite3_stmt,
    params: &[Value],
    context: &str,
) -> Result<Vec<Value>> {
    let reset_rc = unsafe { ffi::sqlite3_reset(stmt) };
    if reset_rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, &format!("reset {context}")));
    }
    let expected_params = unsafe { ffi::sqlite3_bind_parameter_count(stmt) };
    if params.len() < usize::try_from(expected_params).unwrap_or(usize::MAX) {
        let clear_rc = unsafe { ffi::sqlite3_clear_bindings(stmt) };
        if clear_rc != ffi::SQLITE_OK {
            return Err(sqlite_error(db, &format!("clear bindings for {context}")));
        }
    }
    bind_params(stmt, params)?;

    let columns = sqlite_statement_column_names(stmt);
    let mut rows = Vec::new();
    loop {
        match unsafe { ffi::sqlite3_step(stmt) } {
            ffi::SQLITE_ROW => match sqlite_row_to_json(stmt, &columns) {
                Ok(row) => rows.push(row),
                Err(err) => {
                    let _ = unsafe { ffi::sqlite3_reset(stmt) };
                    return Err(err);
                }
            },
            ffi::SQLITE_DONE => break,
            _ => {
                let err = sqlite_error(db, &format!("step {context}"));
                let _ = unsafe { ffi::sqlite3_reset(stmt) };
                return Err(err);
            }
        }
    }
    Ok(rows)
}

fn sqlite_statement_column_names(stmt: *mut ffi::sqlite3_stmt) -> Vec<String> {
    let column_count = unsafe { ffi::sqlite3_column_count(stmt) };
    (0..column_count)
        .map(|index| unsafe {
            CStr::from_ptr(ffi::sqlite3_column_name(stmt, index))
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

fn sqlite_row_to_json(stmt: *mut ffi::sqlite3_stmt, columns: &[String]) -> Result<Value> {
    let mut row = Map::new();
    for (index, column) in columns.iter().enumerate() {
        let index = index as i32;
        let value = match unsafe { ffi::sqlite3_column_type(stmt, index) } {
            ffi::SQLITE_NULL => Value::Null,
            ffi::SQLITE_INTEGER => {
                Value::Number(unsafe { ffi::sqlite3_column_int64(stmt, index) }.into())
            }
            ffi::SQLITE_FLOAT => {
                serde_json::Number::from_f64(unsafe { ffi::sqlite3_column_double(stmt, index) })
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
            ffi::SQLITE_TEXT => sqlite_column_text_json_value(stmt, index)?,
            _ => Value::Null,
        };
        row.insert(column.clone(), value);
    }
    Ok(Value::Object(row))
}

fn sqlite_column_text_json_value(stmt: *mut ffi::sqlite3_stmt, index: i32) -> Result<Value> {
    let len = unsafe { ffi::sqlite3_column_bytes(stmt, index) };
    if len < 0 {
        return Err(SyncularError::storage(anyhow::anyhow!(
            "sqlite text column {index} has invalid length"
        )));
    }
    let ptr = unsafe { ffi::sqlite3_column_text(stmt, index) };
    if ptr.is_null() {
        return Ok(Value::Null);
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len as usize) };
    Ok(Value::String(String::from_utf8_lossy(bytes).into_owned()))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn push_unique_table(tables: &mut Vec<String>, table: &str) {
    if !tables.iter().any(|existing| existing == table) {
        tables.push(table.to_string());
    }
}

fn has_yjs_payload(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.contains_key(YJS_PAYLOAD_KEY))
}

fn row_needs_crdt_materialization(row: &Value, metadata: &AppTableMetadata) -> bool {
    if metadata.crdt_yjs_fields.is_empty() {
        return false;
    }
    let Some(object) = row.as_object() else {
        return true;
    };
    if object.contains_key(YJS_PAYLOAD_KEY) {
        return true;
    }
    metadata.crdt_yjs_fields.iter().any(|field| {
        if field.sync_mode == "encrypted-update-log" {
            return true;
        }
        object
            .get(field.state_column)
            .and_then(Value::as_str)
            .is_some_and(|state| !state.is_empty())
    })
}

fn crdt_field_descriptor_json(field: &CrdtField) -> Value {
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

fn crdt_field_write_receipt(client_commit_id: &str, sync_mode: CrdtFieldSyncMode) -> Value {
    json!({
        "clientCommitId": client_commit_id,
        "syncMode": sync_mode,
    })
}

fn crdt_compaction_stats_from_snapshot(snapshot: &Value) -> Value {
    json!({
        "pendingUpdates": snapshot.get("pendingUpdates").cloned().unwrap_or(Value::Null),
        "flushedUpdates": snapshot.get("flushedUpdates").cloned().unwrap_or(Value::Null),
        "ackedUpdates": snapshot.get("ackedUpdates").cloned().unwrap_or(Value::Null),
        "logUpdates": snapshot.get("logUpdates").cloned().unwrap_or(Value::Null),
        "stateVectorBase64": snapshot.get("stateVectorBase64").cloned().unwrap_or(Value::Null),
        "updatedAt": snapshot.get("updatedAt").cloned().unwrap_or(Value::Null),
        "compactedAt": snapshot.get("compactedAt").cloned().unwrap_or(Value::Null),
    })
}

fn crdt_field_state_base64(field: &CrdtField, row: Option<&Value>) -> Option<String> {
    row.and_then(|row| {
        row.get(field.state_column())
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn optional_sql_string(value: Option<&str>) -> String {
    value.map_or_else(|| "NULL".to_string(), sql_string)
}

fn optional_sql_number(value: Option<i64>) -> String {
    value.map_or_else(|| "NULL".to_string(), |value| value.to_string())
}

fn auth_lease_provenance_from_columns(
    lease_id: Option<String>,
    lease_expires_at_ms: Option<i64>,
    lease_status_at_enqueue: Option<String>,
    lease_scope_summary_json: Option<String>,
) -> Option<AuthLeaseProvenance> {
    Some(AuthLeaseProvenance {
        lease_id: lease_id?,
        lease_expires_at_ms: lease_expires_at_ms?,
        lease_status_at_enqueue: lease_status_at_enqueue?,
        lease_scope_summary_json,
    })
}

fn auth_lease_record_from_row(row: SqliteRow<'_>) -> Result<AuthLeaseRecord> {
    Ok(AuthLeaseRecord {
        lease_id: row.string("lease_id")?,
        kid: row.string("kid")?,
        actor_id: row.string("actor_id")?,
        issued_at_ms: row.i64("issued_at_ms")?,
        not_before_ms: row.i64("not_before_ms")?,
        expires_at_ms: row.i64("expires_at_ms")?,
        schema_version: row.i32("schema_version")?,
        payload_json: row.string("payload_json")?,
        token: row.string("token")?,
        status: row.string("status")?,
        last_validation_error: row.optional_string("last_validation_error"),
        created_at_ms: row.i64("created_at_ms")?,
        updated_at_ms: row.i64("updated_at_ms")?,
    })
}

fn bind_text(stmt: *mut ffi::sqlite3_stmt, index: i32, value: &str) -> Result<()> {
    let rc = bind_text_bytes(stmt, index, value.as_bytes())?;
    bind_result(rc, index)
}

fn bind_optional_text(stmt: *mut ffi::sqlite3_stmt, index: i32, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => bind_text(stmt, index, value),
        None => bind_result(unsafe { ffi::sqlite3_bind_null(stmt, index) }, index),
    }
}

fn bind_i64(stmt: *mut ffi::sqlite3_stmt, index: i32, value: i64) -> Result<()> {
    bind_result(
        unsafe { ffi::sqlite3_bind_int64(stmt, index, value) },
        index,
    )
}

#[cfg(feature = "web-blobs")]
fn bind_blob(stmt: *mut ffi::sqlite3_stmt, index: i32, value: &[u8]) -> Result<()> {
    let len = i32::try_from(value.len())
        .map_err(|_| SyncularError::protocol_message("blob parameter is too large"))?;
    let rc = unsafe {
        ffi::sqlite3_bind_blob(
            stmt,
            index,
            value.as_ptr().cast::<c_void>(),
            len,
            ffi::SQLITE_TRANSIENT(),
        )
    };
    bind_result(rc, index)
}

fn bind_result(rc: i32, index: i32) -> Result<()> {
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(SyncularError::storage(anyhow::anyhow!(
            "bind blob SQL parameter {index} failed with sqlite code {rc}"
        )))
    }
}

fn sql_value(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => i32::from(*value).to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => sql_string(value),
        Value::Array(_) | Value::Object(_) => sql_string(&value.to_string()),
    }
}

fn sqlite_type_family(sql_type: &str) -> &'static str {
    let upper = sql_type.to_ascii_uppercase();
    if upper.contains("INT") {
        "integer"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "real"
    } else if upper.contains("BLOB") {
        "blob"
    } else {
        "text"
    }
}

struct SqliteColumnInfo {
    name: String,
    type_family: &'static str,
    notnull: bool,
    primary_key: bool,
}

fn object_from_value(value: Option<&Value>) -> Result<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Ok(row.clone()),
        Some(_) => Err(SyncularError::protocol_message(
            "row payload must be a JSON object",
        )),
        None => Ok(Map::new()),
    }
}

fn object_from_owned_value(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Object(row) => Ok(row),
        _ => Err(SyncularError::protocol_message(
            "row payload must be a JSON object",
        )),
    }
}

fn parse_scope_values(value: &str) -> Result<ScopeValues> {
    let value: Value = serde_json::from_str(value)?;
    match value {
        Value::Object(scopes) => Ok(scopes),
        _ => Err(SyncularError::protocol_message(
            "subscription scopes_json must be a JSON object",
        )),
    }
}

fn row_matches_scope_values(
    metadata: &AppTableMetadata,
    row: &Value,
    scopes: &ScopeValues,
) -> bool {
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

fn scope_sql_filters(metadata: &AppTableMetadata, scopes: &ScopeValues) -> Result<Vec<String>> {
    for scope_name in scopes.keys() {
        if !metadata.scopes.iter().any(|scope| scope.name == scope_name) {
            return Err(SyncularError::config(format!(
                "unknown scope {scope_name} for table {}",
                metadata.name
            )));
        }
    }

    let mut filters = Vec::new();
    for scope in metadata.scopes {
        match scopes.get(scope.name) {
            Some(value) => filters.push(scope_sql_filter(scope.column, value)?),
            None if scope.required => filters.push("0 = 1".to_string()),
            None => {}
        }
    }
    Ok(filters)
}

fn scope_clause(metadata: &AppTableMetadata, scopes: &ScopeValues) -> Result<String> {
    let filters = scope_sql_filters(metadata, scopes)?;
    if filters.is_empty() {
        Ok("1 = 1".to_string())
    } else {
        Ok(format!("({})", filters.join(" AND ")))
    }
}

fn scope_sql_filter(column: &str, value: &Value) -> Result<String> {
    validate_table_name(column)?;
    Ok(match value {
        Value::Null => format!("{column} IS NULL"),
        Value::Array(values) if values.is_empty() => "0 = 1".to_string(),
        Value::Array(values) => format!(
            "{column} IN ({})",
            values.iter().map(sql_value).collect::<Vec<_>>().join(", ")
        ),
        value => format!("{column} = {}", sql_value(value)),
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

fn parse_params(params_json: &str) -> Result<Vec<Value>> {
    let value: Value = serde_json::from_str(params_json)?;
    match value {
        Value::Array(values) => Ok(values),
        _ => Err(SyncularError::protocol_message(
            "SQL parameters must be a JSON array",
        )),
    }
}

fn snapshot_write_batch_rows(column_count: usize) -> usize {
    if column_count == 0 {
        return 1;
    }
    SNAPSHOT_UPSERT_BATCH_ROWS.min((SQLITE_BIND_PARAMETER_LIMIT / column_count).max(1))
}

fn serialize_js_value(value: &(impl Serialize + ?Sized), context: &str) -> Result<JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value
        .serialize(&serializer)
        .map_err(|err| SyncularError::protocol(err).context(context))
}

#[cfg(feature = "web-blobs")]
fn parse_blob_store_options(options_json: &str) -> Result<RustOwnedBlobStoreOptions> {
    if options_json.trim().is_empty() {
        return Ok(RustOwnedBlobStoreOptions::default());
    }
    serde_json::from_str(options_json).map_err(SyncularError::protocol)
}

#[cfg(not(feature = "web-blobs"))]
fn web_blobs_feature_disabled() -> SyncularError {
    SyncularError::config("blob support is not enabled in this Syncular runtime build")
}

fn bind_params(stmt: *mut ffi::sqlite3_stmt, params: &[Value]) -> Result<()> {
    for (index, value) in params.iter().enumerate() {
        let index = i32::try_from(index + 1)
            .map_err(|_| SyncularError::protocol_message("too many SQL parameters"))?;
        bind_json_value(stmt, index, value)?;
    }
    Ok(())
}

fn bind_json_value(stmt: *mut ffi::sqlite3_stmt, index: i32, value: &Value) -> Result<()> {
    let rc = match value {
        Value::Null => unsafe { ffi::sqlite3_bind_null(stmt, index) },
        Value::Bool(value) => unsafe { ffi::sqlite3_bind_int(stmt, index, i32::from(*value)) },
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                unsafe { ffi::sqlite3_bind_int64(stmt, index, value) }
            } else if let Some(value) = value.as_f64() {
                unsafe { ffi::sqlite3_bind_double(stmt, index, value) }
            } else {
                return Err(SyncularError::protocol_message(
                    "unsupported JSON number parameter",
                ));
            }
        }
        Value::String(value) => bind_text_bytes(stmt, index, value.as_bytes())?,
        Value::Array(_) | Value::Object(_) => {
            let text = value.to_string();
            bind_text_bytes(stmt, index, text.as_bytes())?
        }
    };
    bind_sqlite_parameter_result(rc, index)
}

fn bind_binary_snapshot_cell(
    stmt: *mut ffi::sqlite3_stmt,
    index: i32,
    value: &BinarySnapshotCell,
) -> Result<()> {
    let rc = match value {
        BinarySnapshotCell::Null => unsafe { ffi::sqlite3_bind_null(stmt, index) },
        BinarySnapshotCell::String(value) => bind_text_bytes_static(stmt, index, value.as_bytes())?,
        BinarySnapshotCell::Integer(value) => unsafe {
            ffi::sqlite3_bind_int64(stmt, index, *value)
        },
        BinarySnapshotCell::Float(value) => unsafe {
            ffi::sqlite3_bind_double(stmt, index, *value)
        },
        BinarySnapshotCell::Boolean(value) => unsafe {
            ffi::sqlite3_bind_int(stmt, index, i32::from(*value))
        },
        BinarySnapshotCell::Json(value) => {
            bind_json_value(stmt, index, value).map(|_| ffi::SQLITE_OK)?
        }
        BinarySnapshotCell::Bytes(value) => bind_blob_bytes_static(stmt, index, value)?,
    };
    bind_sqlite_parameter_result(rc, index)
}

fn bind_text_bytes(stmt: *mut ffi::sqlite3_stmt, index: i32, bytes: &[u8]) -> Result<i32> {
    let len = i32::try_from(bytes.len())
        .map_err(|_| SyncularError::protocol_message("SQL text parameter is too large"))?;
    Ok(unsafe {
        ffi::sqlite3_bind_text(
            stmt,
            index,
            bytes.as_ptr() as *const c_char,
            len,
            ffi::SQLITE_TRANSIENT(),
        )
    })
}

fn bind_text_bytes_static(stmt: *mut ffi::sqlite3_stmt, index: i32, bytes: &[u8]) -> Result<i32> {
    let len = i32::try_from(bytes.len())
        .map_err(|_| SyncularError::protocol_message("SQL text parameter is too large"))?;
    Ok(unsafe {
        ffi::sqlite3_bind_text(
            stmt,
            index,
            bytes.as_ptr() as *const c_char,
            len,
            ffi::SQLITE_STATIC(),
        )
    })
}

fn bind_blob_bytes_static(stmt: *mut ffi::sqlite3_stmt, index: i32, bytes: &[u8]) -> Result<i32> {
    let len = i32::try_from(bytes.len())
        .map_err(|_| SyncularError::protocol_message("SQL blob parameter is too large"))?;
    Ok(unsafe {
        ffi::sqlite3_bind_blob(
            stmt,
            index,
            bytes.as_ptr().cast::<c_void>(),
            len,
            ffi::SQLITE_STATIC(),
        )
    })
}

fn bind_null_value(stmt: *mut ffi::sqlite3_stmt, index: i32) -> Result<()> {
    bind_sqlite_parameter_result(unsafe { ffi::sqlite3_bind_null(stmt, index) }, index)
}

fn bind_sqlite_parameter_result(rc: i32, index: i32) -> Result<()> {
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(SyncularError::storage(anyhow::anyhow!(
            "bind SQL parameter {index} failed with sqlite code {rc}"
        )))
    }
}

fn execute_binary_snapshot_write(
    db: *mut ffi::sqlite3,
    table: &str,
    primary_key_column: &str,
    columns: &[String],
    on_conflict: Option<&str>,
    mode: BinarySnapshotWriteMode,
    rows: &[Vec<BinarySnapshotCell>],
) -> Result<WebStoreApplyTimings> {
    let stmt = prepare_binary_snapshot_write(
        db,
        table,
        primary_key_column,
        columns,
        on_conflict,
        rows.len(),
        mode,
    )?;
    let timings = match execute_prepared_binary_multirow_upsert(db, stmt, rows) {
        Ok(timings) => timings,
        Err(err) => {
            let _ = finalize_stmt(
                stmt,
                db,
                "finalize binary multirow upsert after step failure",
            );
            return Err(err);
        }
    };
    finalize_stmt(stmt, db, "finalize binary multirow upsert")?;
    Ok(timings)
}

fn execute_binary_snapshot_payload_write(
    db: *mut ffi::sqlite3,
    table: &str,
    primary_key_column: &str,
    columns: &[String],
    on_conflict: Option<&str>,
    mode: BinarySnapshotWriteMode,
    cursor: &mut BinarySnapshotRowCursor<'_>,
    row_count: usize,
) -> Result<WebStoreApplyTimings> {
    let stmt = prepare_binary_snapshot_write(
        db,
        table,
        primary_key_column,
        columns,
        on_conflict,
        row_count,
        mode,
    )?;
    let timings = match execute_prepared_binary_payload_batch(db, stmt, cursor, row_count) {
        Ok(timings) => timings,
        Err(err) => {
            let _ = finalize_stmt(
                stmt,
                db,
                "finalize binary payload multirow upsert after step failure",
            );
            return Err(err);
        }
    };
    finalize_stmt(stmt, db, "finalize binary payload multirow upsert")?;
    Ok(timings)
}

fn prepare_multirow_upsert(
    db: *mut ffi::sqlite3,
    table: &str,
    primary_key_column: &str,
    columns: &[String],
    on_conflict: &str,
    row_count: usize,
) -> Result<*mut ffi::sqlite3_stmt> {
    let row_placeholders = format!(
        "({})",
        (0..columns.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ")
    );
    let placeholders = (0..row_count)
        .map(|_| row_placeholders.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = CString::new(format!(
        "INSERT INTO {table} ({columns}) VALUES {placeholders} ON CONFLICT({primary_key_column}) {on_conflict}",
        columns = columns.join(", "),
    ))
    .map_err(cstring_error("multirow upsert sql"))?;
    let mut stmt = ptr::null_mut();
    let rc = unsafe {
        ffi::sqlite3_prepare_v3(
            db,
            sql.as_ptr(),
            -1,
            ffi::SQLITE_PREPARE_PERSISTENT,
            &mut stmt as *mut _,
            ptr::null_mut(),
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, "prepare multirow upsert"));
    }
    Ok(stmt)
}

fn prepare_binary_snapshot_write(
    db: *mut ffi::sqlite3,
    table: &str,
    primary_key_column: &str,
    columns: &[String],
    on_conflict: Option<&str>,
    row_count: usize,
    mode: BinarySnapshotWriteMode,
) -> Result<*mut ffi::sqlite3_stmt> {
    if mode == BinarySnapshotWriteMode::Upsert {
        return prepare_multirow_upsert(
            db,
            table,
            primary_key_column,
            columns,
            on_conflict.unwrap_or("DO NOTHING"),
            row_count,
        );
    }

    let row_placeholders = format!(
        "({})",
        (0..columns.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ")
    );
    let placeholders = (0..row_count)
        .map(|_| row_placeholders.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = CString::new(format!(
        "INSERT INTO {table} ({columns}) VALUES {placeholders}",
        columns = columns.join(", "),
    ))
    .map_err(cstring_error("binary snapshot insert sql"))?;
    let mut stmt = ptr::null_mut();
    let rc = unsafe {
        ffi::sqlite3_prepare_v3(
            db,
            sql.as_ptr(),
            -1,
            ffi::SQLITE_PREPARE_PERSISTENT,
            &mut stmt as *mut _,
            ptr::null_mut(),
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, "prepare binary snapshot insert"));
    }
    Ok(stmt)
}

fn execute_prepared_multirow_upsert(
    db: *mut ffi::sqlite3,
    stmt: *mut ffi::sqlite3_stmt,
    rows: &[Map<String, Value>],
    columns: &[String],
    context: &str,
) -> Result<()> {
    let reset_rc = unsafe { ffi::sqlite3_reset(stmt) };
    if reset_rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, &format!("reset {context}")));
    }
    if let Err(err) = bind_multirow_upsert(stmt, rows, columns) {
        return Err(err);
    }
    match unsafe { ffi::sqlite3_step(stmt) } {
        ffi::SQLITE_DONE => {}
        _ => {
            let err = sqlite_error(db, &format!("step {context}"));
            return Err(err);
        }
    }
    Ok(())
}

fn execute_prepared_binary_multirow_upsert(
    db: *mut ffi::sqlite3,
    stmt: *mut ffi::sqlite3_stmt,
    rows: &[Vec<BinarySnapshotCell>],
) -> Result<WebStoreApplyTimings> {
    let mut timings = WebStoreApplyTimings::default();

    let started_at = now_ms();
    let reset_rc = unsafe { ffi::sqlite3_reset(stmt) };
    timings.snapshot_chunk_reset_ms += elapsed_ms_since(started_at);
    if reset_rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, "reset binary multirow upsert"));
    }

    let started_at = now_ms();
    bind_binary_multirow_upsert(stmt, rows)?;
    timings.snapshot_chunk_bind_ms += elapsed_ms_since(started_at);

    let started_at = now_ms();
    let step_rc = unsafe { ffi::sqlite3_step(stmt) };
    timings.snapshot_chunk_step_ms += elapsed_ms_since(started_at);
    match step_rc {
        ffi::SQLITE_DONE => Ok(timings),
        _ => Err(sqlite_error(db, "step binary multirow upsert")),
    }
}

fn execute_prepared_binary_payload_batch(
    db: *mut ffi::sqlite3,
    stmt: *mut ffi::sqlite3_stmt,
    cursor: &mut BinarySnapshotRowCursor<'_>,
    row_count: usize,
) -> Result<WebStoreApplyTimings> {
    let mut timings = WebStoreApplyTimings::default();

    let started_at = now_ms();
    let reset_rc = unsafe { ffi::sqlite3_reset(stmt) };
    timings.snapshot_chunk_reset_ms += elapsed_ms_since(started_at);
    if reset_rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db, "reset binary payload multirow upsert"));
    }

    let started_at = now_ms();
    bind_binary_payload_multirow_upsert(stmt, cursor, row_count)?;
    timings.snapshot_chunk_bind_ms += elapsed_ms_since(started_at);

    let started_at = now_ms();
    let step_rc = unsafe { ffi::sqlite3_step(stmt) };
    timings.snapshot_chunk_step_ms += elapsed_ms_since(started_at);
    match step_rc {
        ffi::SQLITE_DONE => Ok(timings),
        _ => Err(sqlite_error(db, "step binary payload multirow upsert")),
    }
}

fn bind_multirow_upsert(
    stmt: *mut ffi::sqlite3_stmt,
    rows: &[Map<String, Value>],
    columns: &[String],
) -> Result<()> {
    let mut index = 1_i32;
    for row in rows {
        for column in columns {
            match row.get(column) {
                Some(value) => bind_json_value(stmt, index, value)?,
                None => bind_null_value(stmt, index)?,
            }
            index += 1;
        }
    }
    Ok(())
}

fn bind_binary_multirow_upsert(
    stmt: *mut ffi::sqlite3_stmt,
    rows: &[Vec<BinarySnapshotCell>],
) -> Result<()> {
    let mut index = 1_i32;
    for row in rows {
        for value in row {
            bind_binary_snapshot_cell(stmt, index, value)?;
            index += 1;
        }
    }
    Ok(())
}

fn bind_binary_payload_multirow_upsert(
    stmt: *mut ffi::sqlite3_stmt,
    cursor: &mut BinarySnapshotRowCursor<'_>,
    row_count: usize,
) -> Result<()> {
    let mut binder = BorrowedSqliteRawCellBinder { stmt, index: 1 };
    for _ in 0..row_count {
        let read = cursor.read_next_row_with_raw_visitor_trusted(&mut binder)?;
        if !read {
            return Err(SyncularError::protocol_message(
                "binary snapshot ended before expected row count",
            ));
        }
    }
    Ok(())
}

struct BorrowedSqliteRawCellBinder {
    stmt: *mut ffi::sqlite3_stmt,
    index: i32,
}

impl<'a> BorrowedBinarySnapshotRawCellVisitor<'a> for BorrowedSqliteRawCellBinder {
    fn visit_null(&mut self) -> Result<()> {
        self.bind_rc(unsafe { ffi::sqlite3_bind_null(self.stmt, self.index) })
    }

    fn visit_string_bytes(&mut self, value: &'a [u8]) -> Result<()> {
        let rc = bind_text_bytes_static(self.stmt, self.index, value)?;
        self.bind_rc(rc)
    }

    fn visit_integer(&mut self, value: i64) -> Result<()> {
        self.bind_rc(unsafe { ffi::sqlite3_bind_int64(self.stmt, self.index, value) })
    }

    fn visit_float(&mut self, value: f64) -> Result<()> {
        self.bind_rc(unsafe { ffi::sqlite3_bind_double(self.stmt, self.index, value) })
    }

    fn visit_boolean(&mut self, value: bool) -> Result<()> {
        self.bind_rc(unsafe { ffi::sqlite3_bind_int(self.stmt, self.index, i32::from(value)) })
    }

    fn visit_json_bytes(&mut self, value: &'a [u8]) -> Result<()> {
        let rc = bind_text_bytes_static(self.stmt, self.index, value)?;
        self.bind_rc(rc)
    }

    fn visit_bytes(&mut self, value: &'a [u8]) -> Result<()> {
        let rc = bind_blob_bytes_static(self.stmt, self.index, value)?;
        self.bind_rc(rc)
    }
}

impl BorrowedSqliteRawCellBinder {
    fn bind_rc(&mut self, rc: i32) -> Result<()> {
        bind_sqlite_parameter_result(rc, self.index)?;
        self.index += 1;
        Ok(())
    }
}

fn changed_tables_for_sql(sql: &str) -> Vec<String> {
    let normalized = sql
        .split_whitespace()
        .map(|part| part.trim_matches(|ch: char| ch == '"' || ch == '`' || ch == '[' || ch == ']'))
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Vec::new();
    }
    let first = normalized[0].to_ascii_lowercase();
    let table = match first.as_str() {
        "insert" => normalized
            .iter()
            .position(|part| part.eq_ignore_ascii_case("into"))
            .and_then(|index| normalized.get(index + 1)),
        "update" => normalized.get(1),
        "delete" => normalized
            .iter()
            .position(|part| part.eq_ignore_ascii_case("from"))
            .and_then(|index| normalized.get(index + 1)),
        "replace" => normalized
            .iter()
            .position(|part| part.eq_ignore_ascii_case("into"))
            .and_then(|index| normalized.get(index + 1)),
        _ => None,
    };
    table
        .map(|table| table.trim_matches(',').to_string())
        .filter(|table| !table.is_empty())
        .into_iter()
        .collect()
}

fn result_hash(rows: &[Value]) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(rows)?);
    Ok(hex::encode(hasher.finalize()))
}

fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

fn elapsed_ms_since(started_at: i64) -> f64 {
    now_ms().saturating_sub(started_at) as f64
}

struct SqliteRow<'a> {
    stmt: *mut ffi::sqlite3_stmt,
    columns: Vec<String>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> SqliteRow<'a> {
    fn new(stmt: *mut ffi::sqlite3_stmt) -> Self {
        let column_count = unsafe { ffi::sqlite3_column_count(stmt) };
        let columns = (0..column_count)
            .map(|index| unsafe {
                CStr::from_ptr(ffi::sqlite3_column_name(stmt, index))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        Self {
            stmt,
            columns,
            _marker: std::marker::PhantomData,
        }
    }

    fn index(&self, column: &str) -> Result<i32> {
        self.columns
            .iter()
            .position(|candidate| candidate == column)
            .map(|index| index as i32)
            .ok_or_else(|| {
                SyncularError::storage(anyhow::anyhow!("missing sqlite column {column}"))
            })
    }

    fn optional_string(&self, column: &str) -> Option<String> {
        let index = self.index(column).ok()?;
        if unsafe { ffi::sqlite3_column_type(self.stmt, index) } == ffi::SQLITE_NULL {
            return None;
        }
        let ptr = unsafe { ffi::sqlite3_column_text(self.stmt, index) };
        if ptr.is_null() {
            None
        } else {
            Some(
                unsafe { CStr::from_ptr(ptr.cast::<c_char>()) }
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    fn string(&self, column: &str) -> Result<String> {
        self.optional_string(column).ok_or_else(|| {
            SyncularError::storage(anyhow::anyhow!("sqlite column {column} is null"))
        })
    }

    fn bytes(&self, column: &str) -> Result<Vec<u8>> {
        let index = self.index(column)?;
        if unsafe { ffi::sqlite3_column_type(self.stmt, index) } == ffi::SQLITE_NULL {
            return Err(SyncularError::storage(anyhow::anyhow!(
                "sqlite column {column} is null"
            )));
        }
        let len = unsafe { ffi::sqlite3_column_bytes(self.stmt, index) };
        if len < 0 {
            return Err(SyncularError::storage(anyhow::anyhow!(
                "sqlite column {column} has invalid blob length"
            )));
        }
        if len == 0 {
            return Ok(Vec::new());
        }
        let ptr = unsafe { ffi::sqlite3_column_blob(self.stmt, index) };
        if ptr.is_null() {
            return Err(SyncularError::storage(anyhow::anyhow!(
                "sqlite column {column} blob pointer is null"
            )));
        }
        Ok(unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len as usize) }.to_vec())
    }

    fn optional_i64(&self, column: &str) -> Option<i64> {
        let index = self.index(column).ok()?;
        if unsafe { ffi::sqlite3_column_type(self.stmt, index) } == ffi::SQLITE_NULL {
            None
        } else {
            Some(unsafe { ffi::sqlite3_column_int64(self.stmt, index) })
        }
    }

    fn i64(&self, column: &str) -> Result<i64> {
        self.optional_i64(column).ok_or_else(|| {
            SyncularError::storage(anyhow::anyhow!("sqlite column {column} is null"))
        })
    }

    fn optional_i32(&self, column: &str) -> Option<i32> {
        self.optional_i64(column).map(|value| value as i32)
    }

    fn i32(&self, column: &str) -> Result<i32> {
        self.i64(column).map(|value| value as i32)
    }

    fn to_json(&self) -> Result<Value> {
        sqlite_row_to_json(self.stmt, &self.columns)
    }
}

fn crdt_field_compacted_changed_row(
    field: &CrdtField,
    client_commit_id: Option<String>,
) -> SyncChangedRow {
    let crdt_field_changes = vec![sync_changed_crdt_field_from_metadata(
        field.field_metadata(),
    )];
    SyncChangedRow {
        table: field.table().to_string(),
        row_id: Some(field.row_id().to_string()),
        operation: "compact".to_string(),
        changed_fields: vec![field.state_column().to_string()],
        crdt_fields: crdt_field_changes
            .iter()
            .map(|field| field.state_column.clone())
            .collect(),
        crdt_field_changes,
        commit_id: client_commit_id,
        commit_seq: None,
        subscription_id: None,
        server_version: None,
    }
}

fn finalize_stmt(stmt: *mut ffi::sqlite3_stmt, db: *mut ffi::sqlite3, context: &str) -> Result<()> {
    let rc = unsafe { ffi::sqlite3_finalize(stmt) };
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlite_error(db, context))
    }
}

fn close_db(db: *mut ffi::sqlite3) {
    if !db.is_null() {
        unsafe {
            ffi::sqlite3_close(db);
        }
    }
}

fn sqlite_error(db: *mut ffi::sqlite3, context: &str) -> SyncularError {
    let message = if db.is_null() {
        "sqlite database is not open".to_string()
    } else {
        unsafe {
            CStr::from_ptr(ffi::sqlite3_errmsg(db))
                .to_string_lossy()
                .into_owned()
        }
    };
    SyncularError::message(ErrorKind::Storage, format!("{context}: {message}"))
}

fn cstring_error(context: &'static str) -> impl FnOnce(std::ffi::NulError) -> SyncularError {
    move |err| SyncularError::protocol(err).context(context)
}

fn error_to_js(error: SyncularError) -> JsValue {
    let js_error = js_sys::Error::new(&error.message_text());
    js_error.set_name("SyncularWasmError");
    let _ = js_sys::Reflect::set(
        &js_error,
        &JsValue::from_str("syncularKind"),
        &JsValue::from_str(&format!("{:?}", error.kind())),
    );
    let _ = js_sys::Reflect::set(
        &js_error,
        &JsValue::from_str("syncularDebug"),
        &JsValue::from_str(&error.debug_text()),
    );
    js_error.into()
}
