use crate::app_schema::{default_app_schema, AppSchema, AppTableMetadata};
use crate::crdt_yjs::YjsUpdateEnvelope;
#[cfg(feature = "native")]
use crate::diesel_sqlite::DieselSqliteStore;
use crate::encrypted_crdt::EncryptedCrdt;
#[cfg(feature = "native")]
use crate::encrypted_crdt::{
    encrypted_crdt_stream_id, encrypted_field_metadata, BuildEncryptedCrdtCheckpointArgs,
    BuildEncryptedCrdtTextUpdateArgs, BuildEncryptedCrdtYjsUpdateArgs,
};
use crate::encryption::{FieldEncryption, FieldEncryptionContext};
use crate::error::{ErrorKind, Result, SyncularError};
use crate::protocol::*;
#[cfg(feature = "native")]
use crate::rusqlite_sqlite::RusqliteStore;
#[cfg(feature = "native")]
use crate::store::MAX_BLOB_UPLOAD_RETRIES;
use crate::store::{
    next_retry_at, now_ms, DemoTaskStore, OutboxCommit, SubscriptionState, SyncStateStore,
    SyncStore, SyncStoreTx, Task, MAX_SYNC_RETRIES,
};
#[cfg(feature = "native")]
use crate::transport::BlobTransport;
#[cfg(feature = "native")]
use crate::transport::{HttpSyncTransport, SyncTransportConfig};
use crate::transport::{
    RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport,
};
#[cfg(feature = "native")]
use crate::transport::{SyncAuthSigner, SyncAuthSignerStore};
use serde::{Deserialize, Serialize};
#[cfg(feature = "native")]
use serde_json::json;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;
#[cfg(feature = "native")]
use std::fs;
#[cfg(feature = "native")]
use std::fs::File;
#[cfg(feature = "native")]
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const DEFAULT_STATE_ID: &str = "default";
const MAX_PULL_ROUNDS: usize = 20;

static ACTIVE_SYNC_KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct SyncularClientConfig {
    pub db_path: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
}

pub trait SyncularMutationExecutor {
    fn apply_mutation<M>(&mut self, mutation: M) -> Result<MutationReceipt>
    where
        M: IntoSyncularMutation;

    fn apply_mutation_batch(&mut self, batch: SyncularMutationBatch) -> Result<MutationReceipt>;

    fn commit_mutations<R>(
        &mut self,
        f: impl FnOnce(&mut SyncularMutationBatch) -> Result<R>,
    ) -> Result<MutationCommit<R>> {
        let mut batch = SyncularMutationBatch::new();
        let result = f(&mut batch)?;
        let commit = self.apply_mutation_batch(batch)?;
        Ok(MutationCommit { result, commit })
    }
}

pub trait SyncularEncryptedCrdtMutationExecutor {
    fn apply_encrypted_crdt_text_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        next_text: &str,
    ) -> Result<MutationReceipt>;

    fn apply_encrypted_crdt_yjs_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        update: YjsUpdateEnvelope,
    ) -> Result<MutationReceipt>;

    fn apply_encrypted_crdt_checkpoint(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        min_uncheckpointed_updates: i64,
    ) -> Result<Option<MutationReceipt>>;
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCrdtUpdateJsonRequest {
    table: String,
    field: String,
    #[serde(alias = "row_id")]
    row_id: String,
    #[serde(default)]
    next_text: Option<String>,
    #[serde(default)]
    update: Option<YjsUpdateEnvelope>,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCrdtCheckpointJsonRequest {
    table: String,
    field: String,
    #[serde(alias = "row_id")]
    row_id: String,
    #[serde(default)]
    min_uncheckpointed_updates: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionSpec {
    pub id: String,
    pub table: String,
    pub scopes: ScopeValues,
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub changed_tables: Vec<String>,
    pub conflicts_changed: bool,
}

impl SyncReport {
    pub fn table_changed(table: impl Into<String>) -> Self {
        Self {
            changed_tables: vec![table.into()],
            conflicts_changed: false,
        }
    }

    pub fn tables_changed<I, Table>(tables: I) -> Self
    where
        I: IntoIterator<Item = Table>,
        Table: Into<String>,
    {
        let mut report = Self::default();
        for table in tables {
            report.add_changed_table(&table.into());
        }
        report
    }

    pub fn conflicts_changed() -> Self {
        Self {
            changed_tables: Vec::new(),
            conflicts_changed: true,
        }
    }

    fn add_changed_table(&mut self, table: &str) {
        if !self.changed_tables.iter().any(|existing| existing == table) {
            self.changed_tables.push(table.to_string());
        }
    }

    pub fn changes_table(&self, table: &str) -> bool {
        self.changed_tables.iter().any(|existing| existing == table)
    }

    pub fn changes_any_table<'a>(&self, tables: impl IntoIterator<Item = &'a str>) -> bool {
        tables.into_iter().any(|table| self.changes_table(table))
    }

    fn merge(&mut self, other: SyncReport) {
        self.conflicts_changed |= other.conflicts_changed;
        for table in other.changed_tables {
            self.add_changed_table(&table);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictResolution {
    KeepLocal,
    AcceptServer,
    Dismiss,
}

impl ConflictResolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeepLocal => "keep-local",
            Self::AcceptServer => "accept-server",
            Self::Dismiss => "dismiss",
        }
    }
}

impl fmt::Display for ConflictResolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictResolutionReceipt {
    pub conflict_id: String,
    pub resolution: ConflictResolution,
    pub retry_client_commit_id: Option<String>,
}

pub struct SyncularConflicts<'a, S, T> {
    client: &'a mut SyncularClient<S, T>,
}

#[cfg(feature = "native")]
#[derive(Debug)]
pub struct SyncularLiveQuery<QF, Row> {
    tables: Vec<String>,
    build_query: QF,
    rows: Vec<Row>,
    revision: u64,
}

#[cfg(feature = "native")]
impl<QF, Row> SyncularLiveQuery<QF, Row> {
    pub fn new<I, Table>(tables: I, build_query: QF) -> Self
    where
        I: IntoIterator<Item = Table>,
        Table: Into<String>,
    {
        Self {
            tables: tables.into_iter().map(Into::into).collect(),
            build_query,
            rows: Vec::new(),
            revision: 0,
        }
    }

    pub fn tables(&self) -> &[String] {
        &self.tables
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn into_rows(self) -> Vec<Row> {
        self.rows
    }

    pub fn is_affected_by(&self, report: &SyncReport) -> bool {
        report.changes_any_table(self.tables.iter().map(String::as_str))
    }

    pub fn refresh<T, Q>(
        &mut self,
        client: &mut SyncularClient<DieselSqliteStore, T>,
    ) -> Result<&[Row]>
    where
        T: SyncTransport,
        QF: FnMut() -> Q,
        for<'query> Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
    {
        self.rows = client.read((self.build_query)())?;
        self.revision = self.revision.saturating_add(1);
        Ok(&self.rows)
    }

    pub fn refresh_if_changed<T, Q>(
        &mut self,
        client: &mut SyncularClient<DieselSqliteStore, T>,
        report: &SyncReport,
    ) -> Result<bool>
    where
        T: SyncTransport,
        QF: FnMut() -> Q,
        for<'query> Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
    {
        if !self.is_affected_by(report) {
            return Ok(false);
        }
        self.refresh(client)?;
        Ok(true)
    }
}

pub struct SyncularClient<
    #[cfg(feature = "native")] S = DieselSqliteStore,
    #[cfg(not(feature = "native"))] S,
    #[cfg(feature = "native")] T = HttpSyncTransport,
    #[cfg(not(feature = "native"))] T,
> {
    config: SyncularClientConfig,
    store: S,
    transport: T,
    subscriptions: Vec<SubscriptionSpec>,
    app_schema: AppSchema,
    schema_version: i32,
    sync_lock_key: String,
    field_encryption: Option<FieldEncryption>,
    encrypted_crdt: Option<EncryptedCrdt>,
}

#[cfg(feature = "native")]
impl SyncularClient<DieselSqliteStore, HttpSyncTransport> {
    pub fn open(config: SyncularClientConfig) -> Result<Self> {
        Self::open_with_schema(config, default_app_schema())
    }

    pub fn open_with_schema(config: SyncularClientConfig, app_schema: AppSchema) -> Result<Self> {
        let store = DieselSqliteStore::open_with_schema(&config.db_path, app_schema)?;
        let transport = HttpSyncTransport::new(SyncTransportConfig {
            base_url: config.base_url.clone(),
            client_id: config.client_id.clone(),
            actor_id: config.actor_id.clone(),
        })
        .with_schema_version(app_schema.current_schema_version());
        Ok(Self::with_app_schema_parts(
            config, store, transport, app_schema,
        ))
    }
}

#[cfg(feature = "native")]
impl<S> SyncularClient<S, HttpSyncTransport>
where
    S: SyncStore,
{
    pub fn with_store(config: SyncularClientConfig, store: S) -> Self {
        let app_schema = default_app_schema();
        let transport = HttpSyncTransport::new(SyncTransportConfig {
            base_url: config.base_url.clone(),
            client_id: config.client_id.clone(),
            actor_id: config.actor_id.clone(),
        })
        .with_schema_version(app_schema.current_schema_version());
        Self::with_parts(config, store, transport)
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport,
{
    pub fn with_parts(config: SyncularClientConfig, store: S, transport: T) -> Self {
        Self::with_app_schema_parts(config, store, transport, default_app_schema())
    }

    pub fn with_app_schema_parts(
        config: SyncularClientConfig,
        store: S,
        transport: T,
        app_schema: AppSchema,
    ) -> Self {
        let subscriptions = app_schema.default_subscriptions(&config);
        Self::with_subscriptions_and_schema(
            config,
            store,
            transport,
            subscriptions,
            app_schema,
            app_schema.current_schema_version(),
        )
    }

    pub fn with_subscriptions(
        config: SyncularClientConfig,
        store: S,
        transport: T,
        subscriptions: Vec<SubscriptionSpec>,
        schema_version: i32,
    ) -> Self {
        Self::with_subscriptions_and_schema(
            config,
            store,
            transport,
            subscriptions,
            default_app_schema(),
            schema_version,
        )
    }

    fn with_subscriptions_and_schema(
        config: SyncularClientConfig,
        store: S,
        transport: T,
        subscriptions: Vec<SubscriptionSpec>,
        app_schema: AppSchema,
        schema_version: i32,
    ) -> Self {
        Self {
            sync_lock_key: config.db_path.clone(),
            config,
            store,
            transport,
            subscriptions,
            app_schema,
            schema_version,
            field_encryption: None,
            encrypted_crdt: None,
        }
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

    pub fn table_metadata(&self, table: &str) -> Option<&'static AppTableMetadata> {
        self.app_schema.table_metadata(table)
    }

    pub fn sync_http(&mut self) -> Result<SyncReport> {
        let _guard = SyncLockGuard::acquire(&self.sync_lock_key)?;
        self.sync_http_unlocked()
    }

    fn sync_http_unlocked(&mut self) -> Result<SyncReport> {
        let pending = self.prepare_sync()?;
        let request = CombinedRequest {
            client_id: self.config.client_id.clone(),
            push: self.build_push_request(&pending)?,
            pull: Some(self.build_pull_request()?),
        };

        let response = match self.transport.post_sync(&request) {
            Ok(response) => response,
            Err(error) => {
                self.schedule_outbox_retry(&pending, &error)?;
                return Err(error);
            }
        };
        self.apply_combined_response(&pending, response)
    }

    pub fn sync_ws(&mut self) -> Result<SyncReport> {
        let _guard = SyncLockGuard::acquire(&self.sync_lock_key)?;
        self.sync_ws_unlocked()
    }

    fn sync_ws_unlocked(&mut self) -> Result<SyncReport> {
        let pending = self.prepare_sync()?;
        let mut report = SyncReport::default();
        if !pending.is_empty() {
            let mut socket = match self.transport.connect_realtime() {
                Ok(socket) => socket,
                Err(error) => {
                    self.schedule_outbox_retry(&pending, &error)?;
                    return Err(error);
                }
            };

            for commit in &pending {
                let operations = self.operations_for_push(commit)?;
                let response = match socket.push_commit(PushCommitRequest {
                    client_commit_id: commit.client_commit_id.clone(),
                    operations,
                    schema_version: commit.schema_version,
                }) {
                    Ok(response) => response,
                    Err(error) => {
                        self.schedule_outbox_retry(std::slice::from_ref(commit), &error)?;
                        return Err(error);
                    }
                };
                report.merge(self.apply_single_push_response(commit, response)?);
            }

            socket.close();
        }

        let request = CombinedRequest {
            client_id: self.config.client_id.clone(),
            push: None,
            pull: Some(self.build_pull_request()?),
        };
        let response = match self.transport.post_sync(&request) {
            Ok(response) => response,
            Err(error) => {
                self.schedule_outbox_retry(&[], &error)?;
                return Err(error);
            }
        };
        report.merge(self.apply_combined_response(&[], response)?);
        Ok(report)
    }

    pub fn watch<F>(&mut self, seconds: u64, mut on_event: F) -> Result<()>
    where
        F: FnMut(&RealtimeEvent),
    {
        let mut socket = self.transport.connect_realtime()?;
        let deadline = SystemTime::now()
            .checked_add(Duration::from_secs(seconds))
            .unwrap_or_else(SystemTime::now);

        while SystemTime::now() < deadline {
            let Some(event) = socket.read_event()? else {
                continue;
            };
            on_event(&event);
            if matches!(event, RealtimeEvent::Sync) {
                let _ = self.sync_http_unlocked()?;
            }
        }

        socket.close();
        Ok(())
    }

    pub fn process_realtime_events<F>(
        &mut self,
        max_events: usize,
        mut on_event: F,
    ) -> Result<usize>
    where
        F: FnMut(&RealtimeEvent),
    {
        let mut socket = self.transport.connect_realtime()?;
        let mut processed = 0usize;

        for _ in 0..max_events {
            let Some(event) = socket.read_event()? else {
                break;
            };
            on_event(&event);
            processed += 1;
            if matches!(event, RealtimeEvent::Sync) {
                let _ = self.sync_http_unlocked()?;
            }
        }

        socket.close();
        Ok(processed)
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport + SyncAuthHeaderStore,
{
    pub fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.transport.set_auth_headers(headers);
    }
}

#[cfg(feature = "native")]
impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport + SyncAuthSignerStore,
{
    pub fn set_auth_signer(&mut self, signer: Option<SyncAuthSigner>) {
        self.transport.set_auth_signer(signer);
    }
}

#[cfg(feature = "native")]
impl SyncularClient<DieselSqliteStore, HttpSyncTransport> {
    pub fn store_blob_bytes(
        &mut self,
        data: &[u8],
        mime_type: &str,
        immediate: bool,
    ) -> Result<BlobRef> {
        let blob = self.store.store_blob_bytes(data, mime_type, !immediate)?;
        if immediate {
            self.transport.upload_blob(&blob, data)?;
        }
        Ok(blob)
    }

    pub fn store_blob_file(
        &mut self,
        path: &Path,
        mime_type: &str,
        immediate: bool,
        cache_local: bool,
    ) -> Result<BlobRef> {
        if cache_local {
            let data = fs::read(path).map_err(|err| {
                SyncularError::storage(err).context(format!("read blob file {path:?}"))
            })?;
            let blob = self.store.store_blob_bytes(&data, mime_type, !immediate)?;
            if immediate {
                self.transport.upload_blob_file(&blob, path)?;
            }
            return Ok(blob);
        }

        if !immediate {
            return Err(SyncularError::config(
                "native blob file storage with cacheLocal=false requires immediate=true",
            ));
        }

        let file = File::open(path).map_err(|err| {
            SyncularError::storage(err).context(format!("open blob file {path:?}"))
        })?;
        let (hash, size) = blob_hash_reader(file)?;
        let blob = BlobRef {
            hash,
            size,
            mime_type: if mime_type.trim().is_empty() {
                "application/octet-stream".to_string()
            } else {
                mime_type.to_string()
            },
            encrypted: false,
            key_id: None,
        };
        self.transport.upload_blob_file(&blob, path)?;
        Ok(blob)
    }

    pub fn retrieve_blob_bytes(&mut self, blob: &BlobRef) -> Result<Vec<u8>> {
        if let Some(bytes) = self.store.read_cached_blob(&blob.hash)? {
            return Ok(bytes);
        }
        let bytes = self.transport.download_blob(blob)?;
        self.store.cache_blob_bytes(blob, &bytes)?;
        Ok(bytes)
    }

    pub fn retrieve_blob_file(
        &mut self,
        blob: &BlobRef,
        path: &Path,
        cache_local: bool,
    ) -> Result<()> {
        if let Some(bytes) = self.store.read_cached_blob(&blob.hash)? {
            fs::write(path, bytes).map_err(|err| {
                SyncularError::storage(err).context(format!("write blob file {path:?}"))
            })?;
            return Ok(());
        }

        if cache_local {
            let bytes = self.transport.download_blob(blob)?;
            self.store.cache_blob_bytes(blob, &bytes)?;
            fs::write(path, bytes).map_err(|err| {
                SyncularError::storage(err).context(format!("write blob file {path:?}"))
            })?;
        } else {
            self.transport.download_blob_to_file(blob, path)?;
        }
        Ok(())
    }

    pub fn process_blob_upload_queue(
        &mut self,
    ) -> Result<crate::diesel_sqlite::BlobUploadQueueResult> {
        self.store.requeue_stale_blob_uploads()?;
        let pending = self.store.pending_blob_uploads(10)?;
        let mut result = crate::diesel_sqlite::BlobUploadQueueResult {
            uploaded: 0,
            failed: 0,
        };
        for item in pending {
            let next_attempt_count = item.attempt_count + 1;
            self.store
                .mark_blob_uploading(&item.hash, next_attempt_count)?;
            let blob = BlobRef {
                hash: item.hash.clone(),
                size: item.size,
                mime_type: item.mime_type.clone(),
                encrypted: false,
                key_id: None,
            };
            match self.transport.upload_blob(&blob, &item.body) {
                Ok(()) => {
                    self.store.delete_blob_upload(&item.hash)?;
                    result.uploaded += 1;
                }
                Err(error) => {
                    let failed = next_attempt_count >= MAX_BLOB_UPLOAD_RETRIES;
                    let now = now_ms();
                    self.store.mark_blob_upload_error(
                        &item.hash,
                        if failed { "failed" } else { "pending" },
                        &error.to_string(),
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
}

#[cfg(feature = "native")]
impl<T> SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    pub fn store_blob_file_local_json(
        &mut self,
        path: &Path,
        mime_type: &str,
        enqueue_upload: bool,
    ) -> Result<String> {
        let data = fs::read(path).map_err(|err| {
            SyncularError::storage(err).context(format!("read blob file {path:?}"))
        })?;
        let blob = self
            .store
            .store_blob_bytes(&data, mime_type, enqueue_upload)?;
        Ok(serde_json::to_string(&blob)?)
    }

    pub fn retrieve_cached_blob_file_json(
        &mut self,
        blob: &BlobRef,
        path: &Path,
    ) -> Result<String> {
        let Some(bytes) = self.store.read_cached_blob(&blob.hash)? else {
            return Err(SyncularError::config(
                "blob is not present in the local cache",
            ));
        };
        fs::write(path, bytes).map_err(|err| {
            SyncularError::storage(err).context(format!("write blob file {path:?}"))
        })?;
        Ok(serde_json::to_string(&json!({ "ok": true }))?)
    }

    pub fn is_blob_local(&mut self, hash: &str) -> Result<bool> {
        self.store.is_blob_local(hash)
    }

    pub fn blob_upload_queue_stats(
        &mut self,
    ) -> Result<crate::diesel_sqlite::BlobUploadQueueStats> {
        self.store.blob_upload_queue_stats()
    }

    pub fn blob_cache_stats(&mut self) -> Result<crate::diesel_sqlite::BlobCacheStats> {
        self.store.blob_cache_stats()
    }

    pub fn prune_blob_cache(&mut self, max_bytes: i64) -> Result<i64> {
        self.store.prune_blob_cache(max_bytes)
    }

    pub fn clear_blob_cache(&mut self) -> Result<()> {
        self.store.clear_blob_cache()
    }

    pub fn compact_storage_json(&mut self, options_json: Option<&str>) -> Result<String> {
        self.store.compact_storage_json(options_json)
    }

    pub fn readonly_query_json(&self, request_json: &str) -> Result<String> {
        crate::sqlite_query::execute_readonly_query_json(&self.config.db_path, request_json)
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport,
{
    fn prepare_sync(&mut self) -> Result<Vec<OutboxCommit>> {
        self.store.transaction(|tx| {
            tx.requeue_stale_outbox()?;
            let pending = tx.pending_outbox(20)?;
            for commit in &pending {
                validate_outbox_schema_version(commit, self.schema_version)?;
            }
            for commit in &pending {
                tx.mark_outbox_sending(&commit.id)?;
            }
            Ok(pending)
        })
    }

    fn build_pull_request(&mut self) -> Result<PullRequest> {
        let specs = self.subscriptions.clone();
        self.store.transaction(|tx| {
            let mut subscriptions = Vec::new();
            for spec in specs {
                let state = tx.subscription_state(DEFAULT_STATE_ID, &spec.id)?;
                let scopes_changed = state
                    .as_ref()
                    .map(|row| {
                        let scopes: ScopeValues = serde_json::from_str(&row.scopes_json)?;
                        Ok::<bool, SyncularError>(scopes != spec.scopes)
                    })
                    .transpose()?
                    .unwrap_or(false);
                subscriptions.push(SubscriptionRequest {
                    id: spec.id,
                    table: spec.table,
                    scopes: spec.scopes,
                    params: spec.params,
                    cursor: if scopes_changed {
                        -1
                    } else {
                        state.as_ref().map(|row| row.cursor).unwrap_or(-1)
                    },
                    bootstrap_state: if scopes_changed {
                        None
                    } else {
                        state
                            .and_then(|row| row.bootstrap_state_json)
                            .map(|json| serde_json::from_str(&json))
                            .transpose()?
                    },
                });
            }

            Ok(PullRequest {
                limit_commits: 50,
                limit_snapshot_rows: 1000,
                max_snapshot_pages: 4,
                dedupe_rows: None,
                subscriptions,
            })
        })
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

    fn operations_for_push(&self, commit: &OutboxCommit) -> Result<Vec<SyncOperation>> {
        let operations: Vec<SyncOperation> = serde_json::from_str(&commit.operations_json)?;
        if let Some(encryption) = &self.field_encryption {
            encryption.transform_operations_for_push(&self.encryption_context(), operations)
        } else {
            Ok(operations)
        }
    }

    fn transform_push_response(
        &self,
        outbox: &OutboxCommit,
        response: PushCommitResponse,
    ) -> Result<PushCommitResponse> {
        let Some(encryption) = &self.field_encryption else {
            return Ok(response);
        };
        let operations: Vec<SyncOperation> = serde_json::from_str(&outbox.operations_json)?;
        encryption.transform_push_response(&self.encryption_context(), &operations, response)
    }

    fn transform_pull_response(&self, response: PullResponse) -> Result<PullResponse> {
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

    fn apply_single_push_response(
        &mut self,
        outbox: &OutboxCommit,
        response: PushCommitResponse,
    ) -> Result<SyncReport> {
        let response = self.transform_push_response(outbox, response)?;
        self.store.transaction(|tx| {
            let conflicts_changed = apply_push_commit_response(tx, outbox, &response)?;
            Ok(SyncReport {
                changed_tables: Vec::new(),
                conflicts_changed,
            })
        })
    }

    fn apply_combined_response(
        &mut self,
        pending: &[OutboxCommit],
        response: CombinedResponse,
    ) -> Result<SyncReport> {
        if let Err(error) = validate_server_schema_version(&response, self.schema_version) {
            self.schedule_outbox_retry(pending, &error)?;
            return Err(error);
        }

        if !response.ok {
            let error = SyncularError::protocol_message("combined sync response was not ok");
            self.schedule_outbox_retry(pending, &error)?;
            return Err(error);
        }

        let mut report = SyncReport::default();
        if let Some(push) = response.push {
            if !push.ok {
                let error = SyncularError::protocol_message("push response was not ok");
                self.schedule_outbox_retry(pending, &error)?;
                return Err(error);
            }

            let mut transformed_commits = Vec::new();
            for commit_response in push.commits {
                let Some(index) = pending
                    .iter()
                    .position(|row| row.client_commit_id == commit_response.client_commit_id)
                else {
                    continue;
                };
                let commit_response =
                    self.transform_push_response(&pending[index], commit_response)?;
                transformed_commits.push((index, commit_response));
            }

            report.conflicts_changed |= self.store.transaction(|tx| {
                let mut conflicts_changed = false;
                for (index, commit_response) in transformed_commits {
                    let outbox = &pending[index];
                    conflicts_changed |= apply_push_commit_response(tx, outbox, &commit_response)?;
                }
                Ok(conflicts_changed)
            })?;
        }

        if let Some(pull) = response.pull {
            report.merge(self.apply_pull_until_settled(pull)?);
        }

        Ok(report)
    }

    fn apply_pull_until_settled(&mut self, mut response: PullResponse) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        for round in 0..MAX_PULL_ROUNDS {
            if !response.ok {
                return Err(SyncularError::protocol_message("pull response was not ok"));
            }

            let transformed_response = self.transform_pull_response(response)?;
            let needs_more = pull_response_needs_another_round(&transformed_response, 50);
            report.merge(self.apply_pull_response(transformed_response)?);

            if !needs_more {
                return Ok(report);
            }

            if round + 1 == MAX_PULL_ROUNDS {
                return Ok(report);
            }

            let request = CombinedRequest {
                client_id: self.config.client_id.clone(),
                push: None,
                pull: Some(self.build_pull_request()?),
            };
            let combined = self.transport.post_sync(&request)?;
            validate_server_schema_version(&combined, self.schema_version)?;
            response = combined.pull.unwrap_or(PullResponse {
                ok: true,
                subscriptions: Vec::new(),
            });
        }

        Ok(report)
    }

    fn apply_pull_response(&mut self, response: PullResponse) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        for sub in response.subscriptions {
            if sub.status == "revoked" {
                self.store.transaction(|tx| {
                    if let Some(prev) = tx.subscription_state(DEFAULT_STATE_ID, &sub.id)? {
                        let scopes: ScopeValues = serde_json::from_str(&prev.scopes_json)?;
                        tx.clear_table_for_scopes(&prev.table, &scopes)?;
                        report.add_changed_table(&prev.table);
                    }
                    tx.delete_subscription_state(DEFAULT_STATE_ID, &sub.id)
                })?;
                continue;
            }
            let spec = self
                .subscriptions
                .iter()
                .find(|candidate| candidate.id == sub.id);
            let table = spec
                .map(|spec| spec.table.clone())
                .unwrap_or_else(|| "tasks".to_string());
            let params_json = spec
                .map(|spec| serde_json::to_string(&spec.params))
                .transpose()?
                .unwrap_or_else(|| "{}".to_string());

            let mut prepared_snapshots = Vec::new();
            if let Some(snapshots) = sub.snapshots.as_ref() {
                for snapshot in snapshots {
                    let mut chunk_rows = Vec::new();
                    if let Some(chunks) = &snapshot.chunks {
                        for chunk in chunks {
                            for row in self
                                .transport
                                .fetch_snapshot_chunk_rows(chunk, &sub.scopes)?
                            {
                                chunk_rows.push(self.transform_snapshot_row(&snapshot.table, row)?);
                            }
                        }
                    }
                    if snapshot.is_first_page || !snapshot.rows.is_empty() || !chunk_rows.is_empty()
                    {
                        report.add_changed_table(&snapshot.table);
                    }
                    prepared_snapshots.push((snapshot.clone(), chunk_rows));
                }
            }

            self.store.transaction(|tx| {
                if let Some(prev) = tx.subscription_state(DEFAULT_STATE_ID, &sub.id)? {
                    let previous_scopes: ScopeValues = serde_json::from_str(&prev.scopes_json)?;
                    if previous_scopes != sub.scopes {
                        tx.clear_table_for_scopes(&prev.table, &previous_scopes)?;
                        report.add_changed_table(&prev.table);
                    }
                }

                for (snapshot, chunk_rows) in &prepared_snapshots {
                    if snapshot.is_first_page {
                        tx.clear_table_for_scopes(&snapshot.table, &sub.scopes)?;
                    }
                    for row in &snapshot.rows {
                        tx.upsert_row(&snapshot.table, row, None)?;
                    }
                    for row in chunk_rows {
                        tx.upsert_row(&snapshot.table, row, None)?;
                    }
                }

                for commit in &sub.commits {
                    for change in &commit.changes {
                        report.add_changed_table(&change.table);
                        tx.apply_change(change)?;
                    }
                }

                tx.upsert_subscription_state(&SubscriptionState {
                    state_id: DEFAULT_STATE_ID.to_string(),
                    subscription_id: sub.id.clone(),
                    table: table.clone(),
                    scopes_json: serde_json::to_string(&sub.scopes)?,
                    params_json,
                    cursor: sub.next_cursor,
                    bootstrap_state_json: sub
                        .bootstrap_state
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    status: sub.status.clone(),
                })?;

                Ok(())
            })?;
        }

        Ok(report)
    }

    fn schedule_outbox_retry(
        &mut self,
        pending: &[OutboxCommit],
        error: &SyncularError,
    ) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }

        let now = now_ms();
        let message = error.to_string();
        let auth_error = is_auth_transport_error(error);
        self.store.transaction(|tx| {
            for commit in pending {
                let attempt_count = commit.attempt_count.saturating_add(1);
                let failed = attempt_count >= MAX_SYNC_RETRIES;
                let next_attempt_at = if failed || auth_error {
                    0
                } else {
                    next_retry_at(now, attempt_count)
                };
                tx.mark_outbox_retry(&commit.id, &message, next_attempt_at, failed)?;
            }
            Ok(())
        })
    }
}

#[cfg(feature = "native")]
impl<T> SyncularClient<RusqliteStore, T>
where
    T: SyncTransport,
{
    pub fn list_table_json(&mut self, table: &str) -> Result<String> {
        Ok(serde_json::to_string(&self.store.list_table_json(table)?)?)
    }

    pub fn apply_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let operation: SyncOperation = serde_json::from_str(operation_json)?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        self.store.apply_local_operation(operation, local_row)
    }

    pub fn apply_encrypted_crdt_update_json(
        &mut self,
        request_json: &str,
    ) -> Result<MutationReceipt> {
        let _request: EncryptedCrdtUpdateJsonRequest = serde_json::from_str(request_json)?;
        Err(SyncularError::config(
            "encrypted CRDT update JSON is not supported by RusqliteStore",
        ))
    }

    pub fn apply_encrypted_crdt_checkpoint_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<MutationReceipt>> {
        let _request: EncryptedCrdtCheckpointJsonRequest = serde_json::from_str(request_json)?;
        Err(SyncularError::config(
            "encrypted CRDT checkpoint JSON is not supported by RusqliteStore",
        ))
    }
}

#[cfg(feature = "native")]
impl<T> SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    pub fn read<'query, Q, Row>(&mut self, query: Q) -> Result<Vec<Row>>
    where
        Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
    {
        self.store.read(query)
    }

    pub fn live_query<QF, Q, Row, I, Table>(
        &mut self,
        tables: I,
        build_query: QF,
    ) -> Result<SyncularLiveQuery<QF, Row>>
    where
        QF: FnMut() -> Q,
        for<'query> Q: diesel::query_dsl::LoadQuery<'query, diesel::sqlite::SqliteConnection, Row>,
        I: IntoIterator<Item = Table>,
        Table: Into<String>,
    {
        let mut live_query = SyncularLiveQuery::new(tables, build_query);
        live_query.refresh(self)?;
        Ok(live_query)
    }

    pub fn apply<M>(&mut self, mutation: M) -> Result<MutationReceipt>
    where
        M: IntoSyncularMutation,
    {
        self.apply_mutation(mutation)
    }

    pub fn apply_mutation_batch(
        &mut self,
        batch: SyncularMutationBatch,
    ) -> Result<MutationReceipt> {
        <Self as SyncularMutationExecutor>::apply_mutation_batch(self, batch)
    }

    pub fn commit_mutations<R>(
        &mut self,
        f: impl FnOnce(&mut SyncularMutationBatch) -> Result<R>,
    ) -> Result<MutationCommit<R>> {
        let mut batch = SyncularMutationBatch::new();
        let result = f(&mut batch)?;
        let commit = self.apply_mutation_batch(batch)?;
        Ok(MutationCommit { result, commit })
    }

    pub fn list_table_json(&mut self, table: &str) -> Result<String> {
        Ok(serde_json::to_string(&self.store.list_table_json(table)?)?)
    }

    pub fn apply_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        let operation: SyncOperation = serde_json::from_str(operation_json)?;
        let local_row = local_row_json.map(serde_json::from_str).transpose()?;
        self.store.apply_local_operation(operation, local_row)
    }

    pub fn apply_encrypted_crdt_update_json(
        &mut self,
        request_json: &str,
    ) -> Result<MutationReceipt> {
        let request: EncryptedCrdtUpdateJsonRequest = serde_json::from_str(request_json)?;
        let (metadata, field) =
            self.encrypted_crdt_metadata_field(&request.table, &request.field)?;
        match (request.next_text, request.update) {
            (Some(next_text), None) => {
                self.apply_encrypted_crdt_text_update(metadata, field, &request.row_id, &next_text)
            }
            (None, Some(update)) => {
                self.apply_encrypted_crdt_yjs_update(metadata, field, &request.row_id, update)
            }
            (Some(_), Some(_)) => Err(SyncularError::config(
                "encrypted CRDT update JSON must provide either nextText or update, not both",
            )),
            (None, None) => Err(SyncularError::config(
                "encrypted CRDT update JSON requires nextText or update",
            )),
        }
    }

    pub fn apply_encrypted_crdt_checkpoint_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<MutationReceipt>> {
        let request: EncryptedCrdtCheckpointJsonRequest = serde_json::from_str(request_json)?;
        let (metadata, field) =
            self.encrypted_crdt_metadata_field(&request.table, &request.field)?;
        self.apply_encrypted_crdt_checkpoint(
            metadata,
            field,
            &request.row_id,
            request.min_uncheckpointed_updates.unwrap_or(1),
        )
    }

    fn encrypted_crdt_metadata_field(
        &self,
        table: &str,
        field: &str,
    ) -> Result<(&'static AppTableMetadata, &'static str)> {
        let metadata = self.table_metadata(table).ok_or_else(|| {
            SyncularError::config(format!("unknown generated app table: {table}"))
        })?;
        let field = encrypted_field_metadata(metadata, field)?.field;
        Ok((metadata, field))
    }
}

#[cfg(feature = "native")]
impl<T> SyncularMutationExecutor for SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_mutation<M>(&mut self, mutation: M) -> Result<MutationReceipt>
    where
        M: IntoSyncularMutation,
    {
        self.store
            .apply_syncular_mutations(vec![mutation.into_syncular_mutation()])
    }

    fn apply_mutation_batch(&mut self, batch: SyncularMutationBatch) -> Result<MutationReceipt> {
        self.store.apply_syncular_mutations(batch.into_mutations())
    }
}

#[cfg(feature = "native")]
impl<T> SyncularEncryptedCrdtMutationExecutor for SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_encrypted_crdt_text_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        next_text: &str,
    ) -> Result<MutationReceipt> {
        let Some(encryption) = &self.encrypted_crdt else {
            return Err(SyncularError::config(
                "encrypted CRDT updates require set_encrypted_crdt(...)",
            ));
        };
        let existing_row = self
            .store
            .read_row_json(metadata.name, row_id)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot update encrypted CRDT field {}.{} before local row {row_id} exists",
                    metadata.name, field
                ))
            })?;
        let mutation = encryption.build_text_update_mutation(BuildEncryptedCrdtTextUpdateArgs {
            ctx: self.encryption_context(),
            metadata,
            field,
            row_id,
            existing_row: &existing_row,
            next_text,
        })?;
        self.store.apply_syncular_mutations(vec![mutation])
    }

    fn apply_encrypted_crdt_yjs_update(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        update: YjsUpdateEnvelope,
    ) -> Result<MutationReceipt> {
        let Some(encryption) = &self.encrypted_crdt else {
            return Err(SyncularError::config(
                "encrypted CRDT updates require set_encrypted_crdt(...)",
            ));
        };
        let existing_row = self
            .store
            .read_row_json(metadata.name, row_id)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot update encrypted CRDT field {}.{} before local row {row_id} exists",
                    metadata.name, field
                ))
            })?;
        let mutation = encryption.build_yjs_update_mutation(BuildEncryptedCrdtYjsUpdateArgs {
            ctx: self.encryption_context(),
            metadata,
            field,
            row_id,
            existing_row: &existing_row,
            update,
        })?;
        self.store.apply_syncular_mutations(vec![mutation])
    }

    fn apply_encrypted_crdt_checkpoint(
        &mut self,
        metadata: &'static AppTableMetadata,
        field: &'static str,
        row_id: &str,
        min_uncheckpointed_updates: i64,
    ) -> Result<Option<MutationReceipt>> {
        if min_uncheckpointed_updates < 1 {
            return Err(SyncularError::config(
                "encrypted CRDT checkpoint threshold must be at least 1",
            ));
        }
        let Some(encryption) = &self.encrypted_crdt else {
            return Err(SyncularError::config(
                "encrypted CRDT checkpoints require set_encrypted_crdt(...)",
            ));
        };
        let stream_id = encrypted_crdt_stream_id(metadata.name, row_id, field);
        let stats = self
            .store
            .encrypted_crdt_stream_stats(encryption.partition_id(), &stream_id)?;
        if stats.checkpointable_update_count < min_uncheckpointed_updates {
            return Ok(None);
        }
        let Some(covers_seq) = stats.max_server_seq else {
            return Ok(None);
        };
        if stats
            .latest_checkpoint_covers_seq
            .is_some_and(|latest| latest >= covers_seq)
        {
            return Ok(None);
        }
        let existing_row = self
            .store
            .read_row_json(metadata.name, row_id)?
            .ok_or_else(|| {
                SyncularError::protocol_message(format!(
                    "cannot checkpoint encrypted CRDT field {}.{} before local row {row_id} exists",
                    metadata.name, field
                ))
            })?;
        let mutation = encryption.build_checkpoint_mutation(BuildEncryptedCrdtCheckpointArgs {
            ctx: self.encryption_context(),
            metadata,
            field,
            row_id,
            existing_row: &existing_row,
            covers_seq,
        })?;
        Ok(Some(self.store.apply_syncular_mutations(vec![mutation])?))
    }
}

struct SyncLockGuard {
    key: String,
}

impl SyncLockGuard {
    fn acquire(key: &str) -> Result<Self> {
        let locks = ACTIVE_SYNC_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = locks
            .lock()
            .map_err(|_| SyncularError::busy("sync lock is poisoned"))?;
        if !active.insert(key.to_string()) {
            return Err(SyncularError::busy(format!(
                "sync already active for local database {key}"
            )));
        }
        Ok(Self {
            key: key.to_string(),
        })
    }
}

impl Drop for SyncLockGuard {
    fn drop(&mut self) {
        if let Some(locks) = ACTIVE_SYNC_KEYS.get() {
            if let Ok(mut active) = locks.lock() {
                active.remove(&self.key);
            }
        }
    }
}

fn pull_response_needs_another_round(response: &PullResponse, limit_commits: i64) -> bool {
    let mut total_commits = 0usize;
    for sub in &response.subscriptions {
        if sub.status != "active" {
            continue;
        }
        if sub.bootstrap_state.is_some() {
            return true;
        }
        total_commits += sub.commits.len();
    }
    total_commits >= limit_commits as usize
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore + DemoTaskStore,
    T: SyncTransport,
{
    pub fn add_task(&mut self, title: String, id: Option<String>) -> Result<String> {
        let task_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        self.store.add_task(
            &self.config.actor_id,
            self.config.project_id.as_deref(),
            task_id.clone(),
            title,
        )?;
        Ok(task_id)
    }

    pub fn patch_task_title(&mut self, id: String, title: String) -> Result<()> {
        self.store
            .patch_task_title(self.config.project_id.as_deref(), id, title)
    }

    pub fn list_tasks(&mut self) -> Result<Vec<Task>> {
        self.store.list_tasks()
    }
}

impl<S, T> SyncularClient<S, T>
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    pub fn applied_migrations(&mut self) -> Result<Vec<crate::store::AppliedMigration>> {
        self.store.applied_migrations()
    }

    pub fn outbox_summaries(&mut self) -> Result<Vec<crate::store::OutboxSummary>> {
        self.store.outbox_summaries()
    }

    pub fn conflict_summaries(&mut self) -> Result<Vec<crate::store::ConflictSummary>> {
        self.store.conflict_summaries()
    }

    pub fn conflicts(&mut self) -> SyncularConflicts<'_, S, T> {
        SyncularConflicts { client: self }
    }

    pub fn pending_conflicts(&mut self) -> Result<Vec<crate::store::ConflictSummary>> {
        self.conflict_summaries()
    }

    pub fn has_pending_conflicts(&mut self) -> Result<bool> {
        Ok(!self.pending_conflicts()?.is_empty())
    }

    pub fn resolve_conflict(&mut self, id: &str, resolution: &str) -> Result<()> {
        self.store.resolve_conflict(id, resolution)
    }

    pub fn retry_conflict_keep_local(&mut self, id: &str) -> Result<String> {
        self.store.retry_conflict_keep_local(id)
    }
}

impl<'a, S, T> SyncularConflicts<'a, S, T>
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    pub fn pending(&mut self) -> Result<Vec<crate::store::ConflictSummary>> {
        self.client.store.conflict_summaries()
    }

    pub fn is_empty(&mut self) -> Result<bool> {
        Ok(self.pending()?.is_empty())
    }

    pub fn keep_local(&mut self, conflict_id: &str) -> Result<ConflictResolutionReceipt> {
        let retry_client_commit_id = self.client.store.retry_conflict_keep_local(conflict_id)?;
        Ok(ConflictResolutionReceipt {
            conflict_id: conflict_id.to_string(),
            resolution: ConflictResolution::KeepLocal,
            retry_client_commit_id: Some(retry_client_commit_id),
        })
    }

    pub fn accept_server(&mut self, conflict_id: &str) -> Result<ConflictResolutionReceipt> {
        self.resolve(conflict_id, ConflictResolution::AcceptServer)
    }

    pub fn dismiss(&mut self, conflict_id: &str) -> Result<ConflictResolutionReceipt> {
        self.resolve(conflict_id, ConflictResolution::Dismiss)
    }

    pub fn resolve(
        &mut self,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> Result<ConflictResolutionReceipt> {
        if resolution == ConflictResolution::KeepLocal {
            return self.keep_local(conflict_id);
        }

        self.client
            .store
            .resolve_conflict(conflict_id, resolution.as_str())?;
        Ok(ConflictResolutionReceipt {
            conflict_id: conflict_id.to_string(),
            resolution,
            retry_client_commit_id: None,
        })
    }
}

fn validate_outbox_schema_version(commit: &OutboxCommit, current: i32) -> Result<()> {
    if commit.schema_version < 1 {
        return Err(SyncularError::schema(format!(
            "outbox commit {} has invalid schema version {}",
            commit.client_commit_id, commit.schema_version
        )));
    }

    if commit.schema_version > current {
        return Err(SyncularError::schema(format!(
            "outbox commit {} was created with schema version {}, but this client supports {}",
            commit.client_commit_id, commit.schema_version, current
        )));
    }

    Ok(())
}

fn validate_server_schema_version(response: &CombinedResponse, current: i32) -> Result<()> {
    if let Some(required) = response.required_schema_version {
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

    if let Some(latest) = response.latest_schema_version {
        if latest < 1 {
            return Err(SyncularError::schema(format!(
                "server reported invalid latest schema version {latest}"
            )));
        }
    }

    Ok(())
}

fn apply_push_commit_response(
    tx: &mut impl SyncStoreTx,
    outbox: &OutboxCommit,
    response: &PushCommitResponse,
) -> Result<bool> {
    let mut conflicts_changed = false;
    match response.status.as_str() {
        "applied" | "cached" => tx.mark_outbox_acked(&outbox.id, response)?,
        _ => {
            for result in &response.results {
                if result.status == "conflict" || result.status == "error" {
                    tx.insert_conflict(outbox, result)?;
                    conflicts_changed = true;
                }
            }
            tx.mark_outbox_failed(&outbox.id, "REJECTED", response)?;
        }
    }
    Ok(conflicts_changed)
}

fn is_auth_transport_error(error: &SyncularError) -> bool {
    if error.kind() != ErrorKind::Transport {
        return false;
    }
    let message = error.message_text();
    message.contains("HTTP 401") || message.contains("HTTP 403")
}
