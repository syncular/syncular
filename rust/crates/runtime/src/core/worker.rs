use crate::client::{
    sync_changed_row_for_local_operation, SubscriptionSpec, SyncChangedRow, SyncReport,
    SyncularClient,
};
#[cfg(feature = "native")]
use crate::crdt_field::{CrdtField, CrdtFieldId, CrdtFieldSyncMode};
use crate::crdt_yjs::{YjsUpdateEnvelope, YJS_PAYLOAD_KEY};
#[cfg(feature = "native")]
use crate::diesel_sqlite::DieselSqliteStore;
use crate::encrypted_crdt::EncryptedCrdt;
#[cfg(feature = "native")]
use crate::encrypted_crdt::{CRDT_CHECKPOINTS_TABLE, CRDT_UPDATES_TABLE};
use crate::encryption::FieldEncryption;
use crate::error::{ErrorKind, Result, SyncularError};
#[cfg(feature = "demo-todo-native-fixture")]
use crate::fixtures::todo::rusqlite_sqlite::RusqliteStore;
#[cfg(feature = "native")]
use crate::protocol::BlobRef;
use crate::protocol::SyncOperation;
use crate::store::{SyncStateStore, SyncStore};
use crate::transport::{SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[cfg(feature = "native")]
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEFAULT_COMMAND_QUEUE_CAPACITY: usize = 1024;
const YJS_FLUSH_WINDOW: Duration = Duration::from_millis(12);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncWorkerConfig {
    pub command_queue_capacity: usize,
    pub yjs_flush_window: Duration,
}

impl Default for SyncWorkerConfig {
    fn default() -> Self {
        Self {
            command_queue_capacity: DEFAULT_COMMAND_QUEUE_CAPACITY,
            yjs_flush_window: YJS_FLUSH_WINDOW,
        }
    }
}

enum WorkerCommand {
    Trigger {
        command_id: Option<String>,
        emit_started: bool,
        transport: WorkerSyncTransport,
    },
    ApplyLocalOperationJson {
        command_id: String,
        operation_json: String,
        local_row_json: Option<String>,
        auto_sync: bool,
    },
    SaveYjsUpdateJson {
        command_id: String,
        update_json: String,
        auto_sync: bool,
    },
    ApplyCrdtFieldTextJson {
        command_id: String,
        request_json: String,
        auto_sync: bool,
    },
    CompactCrdtFieldJson {
        command_id: String,
        request_json: String,
        auto_sync: bool,
    },
    ApplyEncryptedCrdtUpdateJson {
        command_id: String,
        request_json: String,
        auto_sync: bool,
    },
    ApplyEncryptedCrdtCheckpointJson {
        command_id: String,
        request_json: String,
        auto_sync: bool,
    },
    ResolveConflict {
        command_id: String,
        conflict_id: String,
        resolution: String,
        auto_sync: bool,
    },
    RefreshSnapshotJson {
        command_id: String,
        request_json: String,
    },
    CompactStorageJson {
        command_id: String,
        options_json: Option<String>,
    },
    StoreBlobFileJson {
        command_id: String,
        path: String,
        options_json: Option<String>,
    },
    RetrieveBlobFileJson {
        command_id: String,
        ref_json: String,
        path: String,
        options_json: Option<String>,
    },
    PruneBlobCache {
        command_id: String,
        max_bytes: i64,
    },
    ClearBlobCache {
        command_id: String,
    },
    SetSubscriptions(Vec<SubscriptionSpec>),
    SetAuthHeaders(SyncAuthHeaders),
    SetFieldEncryption(Option<FieldEncryption>),
    SetEncryptedCrdt(Option<EncryptedCrdt>),
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerSyncTransport {
    Http,
    WebSocket,
}

impl WorkerSyncTransport {
    fn coalesce(self, next: Self) -> Self {
        if matches!(self, Self::WebSocket) || matches!(next, Self::WebSocket) {
            Self::WebSocket
        } else {
            Self::Http
        }
    }
}

#[derive(Debug)]
pub enum SyncWorkerEvent {
    SyncStarted {
        command_id: Option<String>,
    },
    SyncCompleted {
        command_id: Option<String>,
        report: SyncReport,
        outbox_count: usize,
        conflict_count: usize,
        duration_ms: u64,
    },
    SyncFailed {
        command_id: Option<String>,
        error: SyncularError,
        retry_scheduled: bool,
        duration_ms: u64,
    },
    LocalWriteCommitted {
        command_id: String,
        client_commit_id: String,
        changed_tables: Vec<String>,
        changed_rows: Vec<SyncChangedRow>,
        duration_ms: u64,
    },
    CrdtFieldChanged {
        command_id: String,
        client_commit_id: String,
        table: String,
        row_id: String,
        field: String,
        changed_tables: Vec<String>,
        payload_json: Option<Value>,
        duration_ms: u64,
    },
    CrdtFieldCompacted {
        command_id: String,
        client_commit_id: String,
        table: String,
        row_id: String,
        field: String,
        changed_tables: Vec<String>,
        payload_json: Option<Value>,
        duration_ms: u64,
    },
    LocalWriteFailed {
        command_id: String,
        error: SyncularError,
        payload_json: Option<Value>,
        duration_ms: u64,
    },
    ConflictResolutionCompleted {
        command_id: String,
        retry_client_commit_id: Option<String>,
        duration_ms: u64,
    },
    ConflictResolutionFailed {
        command_id: String,
        error: SyncularError,
        duration_ms: u64,
    },
    SnapshotReady {
        command_id: String,
        payload_json: Value,
        duration_ms: u64,
    },
    WorkerCommandCompleted {
        command_id: String,
        operation: &'static str,
        payload_json: Option<Value>,
        duration_ms: u64,
    },
    WorkerCommandFailed {
        command_id: String,
        operation: &'static str,
        error: SyncularError,
        duration_ms: u64,
    },
}

pub trait SyncWorkerClientExt {
    fn apply_worker_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String>;

    fn apply_worker_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String>;

    fn worker_current_row_json(&mut self, _table: &str, _row_id: &str) -> Result<Option<Value>> {
        Ok(None)
    }

    fn apply_worker_encrypted_crdt_update_json(
        &mut self,
        _request_json: &str,
    ) -> Result<WorkerLocalWriteReceipt> {
        Err(SyncularError::config(
            "worker-owned encrypted CRDT updates are not available for this client",
        ))
    }

    fn apply_worker_encrypted_crdt_checkpoint_json(
        &mut self,
        _request_json: &str,
    ) -> Result<Option<WorkerLocalWriteReceipt>> {
        Err(SyncularError::config(
            "worker-owned encrypted CRDT checkpoints are not available for this client",
        ))
    }

    fn apply_worker_crdt_field_text_json(
        &mut self,
        _request_json: &str,
    ) -> Result<WorkerLocalWriteReceipt> {
        Err(SyncularError::config(
            "worker-owned CRDT field text updates are not available for this client",
        ))
    }

    fn compact_worker_crdt_field_json(
        &mut self,
        _request_json: &str,
    ) -> Result<Option<WorkerLocalWriteReceipt>> {
        Err(SyncularError::config(
            "worker-owned CRDT field compaction is not available for this client",
        ))
    }

    fn worker_crdt_field_event_payload_json(
        &mut self,
        _table: &str,
        _row_id: &str,
        _field: &str,
    ) -> Result<Option<Value>> {
        Ok(None)
    }

    fn worker_query_json(&mut self, _request_json: &str) -> Result<String> {
        Err(SyncularError::config(
            "worker-owned snapshot refresh is not available for this client",
        ))
    }

    fn worker_compact_storage_json(&mut self, _options_json: Option<&str>) -> Result<String> {
        Err(SyncularError::config(
            "worker-owned storage compaction is not available for this client",
        ))
    }

    fn worker_store_blob_file_json(
        &mut self,
        _path: &str,
        _options_json: Option<&str>,
    ) -> Result<String> {
        Err(SyncularError::config(
            "worker-owned blob file storage is not available for this client",
        ))
    }

    fn worker_retrieve_blob_file_json(
        &mut self,
        _ref_json: &str,
        _path: &str,
        _options_json: Option<&str>,
    ) -> Result<String> {
        Err(SyncularError::config(
            "worker-owned blob file retrieval is not available for this client",
        ))
    }

    fn worker_prune_blob_cache_json(&mut self, _max_bytes: i64) -> Result<String> {
        Err(SyncularError::config(
            "worker-owned blob cache pruning is not available for this client",
        ))
    }

    fn worker_clear_blob_cache_json(&mut self) -> Result<String> {
        Err(SyncularError::config(
            "worker-owned blob cache clearing is not available for this client",
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerLocalWriteReceipt {
    pub client_commit_id: String,
    pub changed_tables: Vec<String>,
    pub changed_rows: Vec<SyncChangedRow>,
    pub crdt_event_payload_json: Option<Value>,
}

#[cfg(feature = "native")]
impl<T> SyncWorkerClientExt for SyncularClient<DieselSqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_worker_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        self.apply_local_operation_json(operation_json, local_row_json)
    }

    fn apply_worker_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        let operation_json = serde_json::to_string(&operation)?;
        let local_row_json = local_row.as_ref().map(serde_json::to_string).transpose()?;
        self.apply_local_operation_json(&operation_json, local_row_json.as_deref())
    }

    fn worker_current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        self.current_row_json(table, row_id)
    }

    fn apply_worker_encrypted_crdt_update_json(
        &mut self,
        request_json: &str,
    ) -> Result<WorkerLocalWriteReceipt> {
        let request: WorkerEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let field = request
            .field_identity_ref()
            .and_then(|identity| self.open_crdt_field(identity.id()).ok());
        let receipt = self.apply_encrypted_crdt_update_json(request_json)?;
        let crdt_event_payload_json = field
            .as_ref()
            .and_then(|field| crdt_field_event_payload_for_worker(self, field));
        Ok(WorkerLocalWriteReceipt {
            changed_rows: field
                .as_ref()
                .map(|field| crdt_field_changed_row_for_worker(field, &receipt.client_commit_id))
                .into_iter()
                .collect(),
            client_commit_id: receipt.client_commit_id,
            changed_tables: vec![request.table, CRDT_UPDATES_TABLE.to_string()],
            crdt_event_payload_json,
        })
    }

    fn apply_worker_encrypted_crdt_checkpoint_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<WorkerLocalWriteReceipt>> {
        let request: WorkerEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let field = request
            .field_identity_ref()
            .and_then(|identity| self.open_crdt_field(identity.id()).ok());
        let receipt = self.apply_encrypted_crdt_checkpoint_json(request_json)?;
        let crdt_event_payload_json = field.as_ref().and_then(|field| {
            crdt_field_compaction_payload_for_worker(
                self,
                field,
                true,
                encrypted_crdt_min_uncheckpointed_updates(request_json),
            )
        });
        Ok(receipt.map(|receipt| WorkerLocalWriteReceipt {
            changed_rows: field
                .as_ref()
                .map(|field| crdt_field_compacted_row_for_worker(field, &receipt.client_commit_id))
                .into_iter()
                .collect(),
            client_commit_id: receipt.client_commit_id,
            changed_tables: vec![CRDT_CHECKPOINTS_TABLE.to_string()],
            crdt_event_payload_json,
        }))
    }

    fn apply_worker_crdt_field_text_json(
        &mut self,
        request_json: &str,
    ) -> Result<WorkerLocalWriteReceipt> {
        let request: WorkerCrdtFieldTextRequest = serde_json::from_str(request_json)?;
        let field = self.open_crdt_field(request.id())?;
        let receipt = self.apply_crdt_field_text(&field, &request.next_text)?;
        let crdt_event_payload_json = crdt_field_event_payload_for_worker(self, &field);
        Ok(WorkerLocalWriteReceipt {
            changed_rows: vec![crdt_field_changed_row_for_worker(
                &field,
                &receipt.client_commit_id,
            )],
            client_commit_id: receipt.client_commit_id,
            changed_tables: crdt_field_write_tables_for_worker(&field),
            crdt_event_payload_json,
        })
    }

    fn compact_worker_crdt_field_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<WorkerLocalWriteReceipt>> {
        let request: WorkerCrdtFieldCompactionRequest = serde_json::from_str(request_json)?;
        let field = self.open_crdt_field(request.id())?;
        let receipt =
            self.compact_crdt_field(&field, request.min_uncheckpointed_updates.unwrap_or(1))?;
        let crdt_event_payload_json = crdt_field_compaction_payload_for_worker(
            self,
            &field,
            receipt.checkpoint_created,
            request.min_uncheckpointed_updates.unwrap_or(1),
        );
        Ok(receipt
            .client_commit_id
            .map(|client_commit_id| WorkerLocalWriteReceipt {
                changed_rows: vec![crdt_field_compacted_row_for_worker(
                    &field,
                    &client_commit_id,
                )],
                client_commit_id,
                changed_tables: crdt_field_compaction_tables_for_worker(&field),
                crdt_event_payload_json,
            }))
    }

    fn worker_crdt_field_event_payload_json(
        &mut self,
        table: &str,
        row_id: &str,
        field: &str,
    ) -> Result<Option<Value>> {
        let field = self.open_crdt_field(CrdtFieldId::new(table, row_id, field))?;
        Ok(crdt_field_event_payload_for_worker(self, &field))
    }

    fn worker_query_json(&mut self, request_json: &str) -> Result<String> {
        self.readonly_query_json(request_json)
    }

    fn worker_compact_storage_json(&mut self, options_json: Option<&str>) -> Result<String> {
        self.compact_storage_json(options_json)
    }

    fn worker_store_blob_file_json(
        &mut self,
        path: &str,
        options_json: Option<&str>,
    ) -> Result<String> {
        let options: WorkerBlobStoreOptions = options_json
            .filter(|value| !value.trim().is_empty())
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        if options.immediate.unwrap_or(false) {
            return Err(SyncularError::config(
                "queued blob file storage currently supports immediate=false",
            ));
        }
        if !options.cache_local.unwrap_or(true) {
            return Err(SyncularError::config(
                "queued blob file storage with cacheLocal=false requires immediate=true",
            ));
        }
        let mime_type = options
            .mime_type
            .as_deref()
            .unwrap_or("application/octet-stream");
        self.store_blob_file_local_json(Path::new(path), mime_type, true)
    }

    fn worker_retrieve_blob_file_json(
        &mut self,
        ref_json: &str,
        path: &str,
        options_json: Option<&str>,
    ) -> Result<String> {
        let options: WorkerBlobRetrieveOptions = options_json
            .filter(|value| !value.trim().is_empty())
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        let blob: BlobRef = serde_json::from_str(ref_json)?;
        self.retrieve_cached_blob_file_json(&blob, Path::new(path))?;
        let payload = json!({
            "ok": true,
            "cacheLocal": options.cache_local.unwrap_or(true)
        });
        Ok(serde_json::to_string(&payload)?)
    }

    fn worker_prune_blob_cache_json(&mut self, max_bytes: i64) -> Result<String> {
        Ok(serde_json::to_string(&json!({
            "bytesPruned": self.prune_blob_cache(max_bytes)?
        }))?)
    }

    fn worker_clear_blob_cache_json(&mut self) -> Result<String> {
        self.clear_blob_cache()?;
        Ok(serde_json::to_string(&json!({ "ok": true }))?)
    }
}

#[cfg(feature = "demo-todo-native-fixture")]
impl<T> SyncWorkerClientExt for SyncularClient<RusqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_worker_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        self.apply_local_operation_json(operation_json, local_row_json)
    }

    fn apply_worker_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        let operation_json = serde_json::to_string(&operation)?;
        let local_row_json = local_row.as_ref().map(serde_json::to_string).transpose()?;
        self.apply_local_operation_json(&operation_json, local_row_json.as_deref())
    }

    fn worker_current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        self.current_row_json(table, row_id)
    }
}

pub struct SyncWorker {
    command_tx: SyncSender<WorkerCommand>,
    events: SyncWorkerEvents,
    join: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct SyncWorkerEvents {
    event_rx: Arc<Mutex<Receiver<SyncWorkerEvent>>>,
}

impl SyncWorkerEvents {
    pub fn recv_event_timeout(&self, timeout: Duration) -> Option<SyncWorkerEvent> {
        self.event_rx
            .lock()
            .ok()
            .and_then(|event_rx| event_rx.recv_timeout(timeout).ok())
    }
}

#[derive(Clone)]
pub struct SyncWorkerTrigger {
    command_tx: SyncSender<WorkerCommand>,
}

impl SyncWorkerTrigger {
    pub fn trigger_sync(&self) -> Result<()> {
        self.command_tx
            .try_send(WorkerCommand::Trigger {
                command_id: None,
                emit_started: false,
                transport: WorkerSyncTransport::Http,
            })
            .map_err(|err| match err {
                TrySendError::Full(_) => SyncularError::busy("sync worker command queue is full"),
                TrySendError::Disconnected(_) => {
                    SyncularError::message(ErrorKind::Internal, "sync worker is not running")
                }
            })
    }
}

impl SyncWorker {
    pub fn start<S, T>(client: SyncularClient<S, T>) -> Self
    where
        S: SyncStore + SyncStateStore + Send + 'static,
        T: SyncTransport + SyncAuthHeaderStore + Send + 'static,
        SyncularClient<S, T>: SyncWorkerClientExt,
    {
        Self::start_with_config(client, SyncWorkerConfig::default())
    }

    pub fn start_with_config<S, T>(
        mut client: SyncularClient<S, T>,
        config: SyncWorkerConfig,
    ) -> Self
    where
        S: SyncStore + SyncStateStore + Send + 'static,
        T: SyncTransport + SyncAuthHeaderStore + Send + 'static,
        SyncularClient<S, T>: SyncWorkerClientExt,
    {
        let (command_tx, command_rx) = mpsc::sync_channel(config.command_queue_capacity);
        let (event_tx, event_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            let mut pending_yjs = BTreeMap::new();
            loop {
                let command = if pending_yjs.is_empty() {
                    match command_rx.recv() {
                        Ok(command) => command,
                        Err(_) => return,
                    }
                } else {
                    match command_rx.recv_timeout(config.yjs_flush_window) {
                        Ok(command) => command,
                        Err(RecvTimeoutError::Timeout) => {
                            if flush_pending_yjs(&mut client, &mut pending_yjs, &event_tx) {
                                if !run_until_settled(
                                    &mut client,
                                    &command_rx,
                                    &event_tx,
                                    &mut pending_yjs,
                                    None,
                                    false,
                                    WorkerSyncTransport::Http,
                                ) {
                                    return;
                                }
                            }
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                };

                if !handle_command(
                    &mut client,
                    &command_rx,
                    &event_tx,
                    &mut pending_yjs,
                    command,
                ) {
                    return;
                }
            }
        });

        Self {
            command_tx,
            events: SyncWorkerEvents {
                event_rx: Arc::new(Mutex::new(event_rx)),
            },
            join: Some(join),
        }
    }

    pub fn trigger_sync(&self) -> Result<()> {
        self.trigger_sync_inner(None, false, WorkerSyncTransport::Http)
    }

    pub fn trigger_sync_websocket(&self) -> Result<()> {
        self.trigger_sync_inner(None, false, WorkerSyncTransport::WebSocket)
    }

    pub fn trigger_handle(&self) -> SyncWorkerTrigger {
        SyncWorkerTrigger {
            command_tx: self.command_tx.clone(),
        }
    }

    pub fn event_source(&self) -> SyncWorkerEvents {
        self.events.clone()
    }

    pub fn enqueue_sync_now(&self, command_id: String) -> Result<()> {
        self.trigger_sync_inner(Some(command_id), true, WorkerSyncTransport::Http)
    }

    pub fn enqueue_sync_websocket(&self, command_id: String) -> Result<()> {
        self.trigger_sync_inner(Some(command_id), true, WorkerSyncTransport::WebSocket)
    }

    pub fn enqueue_local_operation_json(
        &self,
        command_id: String,
        operation_json: String,
        local_row_json: Option<String>,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::ApplyLocalOperationJson {
            command_id,
            operation_json,
            local_row_json,
            auto_sync,
        })
    }

    pub fn enqueue_yjs_update_json(
        &self,
        command_id: String,
        update_json: String,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::SaveYjsUpdateJson {
            command_id,
            update_json,
            auto_sync,
        })
    }

    pub fn enqueue_crdt_field_text_json(
        &self,
        command_id: String,
        request_json: String,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::ApplyCrdtFieldTextJson {
            command_id,
            request_json,
            auto_sync,
        })
    }

    pub fn enqueue_crdt_field_compaction_json(
        &self,
        command_id: String,
        request_json: String,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::CompactCrdtFieldJson {
            command_id,
            request_json,
            auto_sync,
        })
    }

    pub fn enqueue_encrypted_crdt_update_json(
        &self,
        command_id: String,
        request_json: String,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::ApplyEncryptedCrdtUpdateJson {
            command_id,
            request_json,
            auto_sync,
        })
    }

    pub fn enqueue_encrypted_crdt_checkpoint_json(
        &self,
        command_id: String,
        request_json: String,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::ApplyEncryptedCrdtCheckpointJson {
            command_id,
            request_json,
            auto_sync,
        })
    }

    pub fn enqueue_conflict_resolution(
        &self,
        command_id: String,
        conflict_id: String,
        resolution: String,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::ResolveConflict {
            command_id,
            conflict_id,
            resolution,
            auto_sync,
        })
    }

    pub fn enqueue_refresh_snapshot_json(
        &self,
        command_id: String,
        request_json: String,
    ) -> Result<()> {
        self.try_send(WorkerCommand::RefreshSnapshotJson {
            command_id,
            request_json,
        })
    }

    pub fn enqueue_compact_storage_json(
        &self,
        command_id: String,
        options_json: Option<String>,
    ) -> Result<()> {
        self.try_send(WorkerCommand::CompactStorageJson {
            command_id,
            options_json,
        })
    }

    pub fn enqueue_store_blob_file_json(
        &self,
        command_id: String,
        path: String,
        options_json: Option<String>,
    ) -> Result<()> {
        self.try_send(WorkerCommand::StoreBlobFileJson {
            command_id,
            path,
            options_json,
        })
    }

    pub fn enqueue_retrieve_blob_file_json(
        &self,
        command_id: String,
        ref_json: String,
        path: String,
        options_json: Option<String>,
    ) -> Result<()> {
        self.try_send(WorkerCommand::RetrieveBlobFileJson {
            command_id,
            ref_json,
            path,
            options_json,
        })
    }

    pub fn enqueue_prune_blob_cache(&self, command_id: String, max_bytes: i64) -> Result<()> {
        self.try_send(WorkerCommand::PruneBlobCache {
            command_id,
            max_bytes,
        })
    }

    pub fn enqueue_clear_blob_cache(&self, command_id: String) -> Result<()> {
        self.try_send(WorkerCommand::ClearBlobCache { command_id })
    }

    pub fn set_auth_headers(&self, headers: SyncAuthHeaders) -> Result<()> {
        self.try_send(WorkerCommand::SetAuthHeaders(headers))
    }

    pub fn set_subscriptions(&self, subscriptions: Vec<SubscriptionSpec>) -> Result<()> {
        self.try_send(WorkerCommand::SetSubscriptions(subscriptions))
    }

    pub fn set_field_encryption(&self, encryption: Option<FieldEncryption>) -> Result<()> {
        self.try_send(WorkerCommand::SetFieldEncryption(encryption))
    }

    pub fn set_encrypted_crdt(&self, encryption: Option<EncryptedCrdt>) -> Result<()> {
        self.try_send(WorkerCommand::SetEncryptedCrdt(encryption))
    }

    pub fn recv_event_timeout(&self, timeout: Duration) -> Option<SyncWorkerEvent> {
        self.events.recv_event_timeout(timeout)
    }

    pub fn recv_result_timeout(&self, timeout: Duration) -> Option<Result<SyncReport>> {
        let deadline = Instant::now().checked_add(timeout)?;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let remaining = deadline.saturating_duration_since(now);
            match self.recv_event_timeout(remaining)? {
                SyncWorkerEvent::SyncCompleted { report, .. } => return Some(Ok(report)),
                SyncWorkerEvent::SyncFailed { error, .. } => return Some(Err(error)),
                _ => continue,
            }
        }
    }

    pub fn request_stop(&self) -> Result<()> {
        self.command_tx
            .send(WorkerCommand::Stop)
            .map_err(|_| SyncularError::message(ErrorKind::Internal, "sync worker is not running"))
    }

    pub fn join(&mut self) -> Result<()> {
        if let Some(join) = self.join.take() {
            join.join()
                .map_err(|_| SyncularError::message(ErrorKind::Internal, "sync worker panicked"))?;
        }
        Ok(())
    }

    pub fn stop(mut self) -> Result<()> {
        let _ = self.request_stop();
        self.join()
    }

    fn trigger_sync_inner(
        &self,
        command_id: Option<String>,
        emit_started: bool,
        transport: WorkerSyncTransport,
    ) -> Result<()> {
        self.try_send(WorkerCommand::Trigger {
            command_id,
            emit_started,
            transport,
        })
    }

    fn try_send(&self, command: WorkerCommand) -> Result<()> {
        self.command_tx.try_send(command).map_err(|err| match err {
            TrySendError::Full(_) => SyncularError::busy("sync worker command queue is full"),
            TrySendError::Disconnected(_) => {
                SyncularError::message(ErrorKind::Internal, "sync worker is not running")
            }
        })
    }
}

impl Drop for SyncWorker {
    fn drop(&mut self) {
        let _ = self.command_tx.send(WorkerCommand::Stop);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn handle_command<S, T>(
    client: &mut SyncularClient<S, T>,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    pending_yjs: &mut BTreeMap<YjsBatchKey, PendingYjsBatch>,
    command: WorkerCommand,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport + SyncAuthHeaderStore,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    match command {
        WorkerCommand::Trigger {
            command_id,
            emit_started,
            transport,
        } => run_until_settled(
            client,
            command_rx,
            event_tx,
            pending_yjs,
            command_id,
            emit_started,
            transport,
        ),
        WorkerCommand::ApplyLocalOperationJson {
            command_id,
            operation_json,
            local_row_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            let should_sync = apply_local_operation_json(
                client,
                event_tx,
                command_id,
                &operation_json,
                local_row_json.as_deref(),
                auto_sync,
            );
            if should_sync {
                run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                )
            } else {
                true
            }
        }
        WorkerCommand::SaveYjsUpdateJson {
            command_id,
            update_json,
            auto_sync,
        } => {
            queue_yjs_update_json(pending_yjs, event_tx, command_id, &update_json, auto_sync);
            true
        }
        WorkerCommand::ApplyCrdtFieldTextJson {
            command_id,
            request_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            let should_sync =
                apply_crdt_field_text_json(client, event_tx, command_id, &request_json, auto_sync);
            if should_sync {
                run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                )
            } else {
                true
            }
        }
        WorkerCommand::CompactCrdtFieldJson {
            command_id,
            request_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            let should_sync =
                compact_crdt_field_json(client, event_tx, command_id, &request_json, auto_sync);
            if should_sync {
                run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                )
            } else {
                true
            }
        }
        WorkerCommand::ApplyEncryptedCrdtUpdateJson {
            command_id,
            request_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            let should_sync = apply_encrypted_crdt_update_json(
                client,
                event_tx,
                command_id,
                &request_json,
                auto_sync,
            );
            if should_sync {
                run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                )
            } else {
                true
            }
        }
        WorkerCommand::ApplyEncryptedCrdtCheckpointJson {
            command_id,
            request_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            let should_sync = apply_encrypted_crdt_checkpoint_json(
                client,
                event_tx,
                command_id,
                &request_json,
                auto_sync,
            );
            if should_sync {
                run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                )
            } else {
                true
            }
        }
        WorkerCommand::ResolveConflict {
            command_id,
            conflict_id,
            resolution,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            let should_sync = resolve_conflict(
                client,
                event_tx,
                command_id,
                &conflict_id,
                &resolution,
                auto_sync,
            );
            if should_sync {
                run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                )
            } else {
                true
            }
        }
        WorkerCommand::RefreshSnapshotJson {
            command_id,
            request_json,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            refresh_snapshot_json(client, event_tx, command_id, &request_json);
            true
        }
        WorkerCommand::CompactStorageJson {
            command_id,
            options_json,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(
                    client,
                    command_rx,
                    event_tx,
                    pending_yjs,
                    None,
                    false,
                    WorkerSyncTransport::Http,
                ) {
                    return false;
                }
            }
            run_worker_json_command(client, event_tx, command_id, "compactStorage", |client| {
                client.worker_compact_storage_json(options_json.as_deref())
            });
            true
        }
        WorkerCommand::StoreBlobFileJson {
            command_id,
            path,
            options_json,
        } => {
            run_worker_json_command(client, event_tx, command_id, "storeBlobFile", |client| {
                client.worker_store_blob_file_json(&path, options_json.as_deref())
            });
            true
        }
        WorkerCommand::RetrieveBlobFileJson {
            command_id,
            ref_json,
            path,
            options_json,
        } => {
            run_worker_json_command(client, event_tx, command_id, "retrieveBlobFile", |client| {
                client.worker_retrieve_blob_file_json(&ref_json, &path, options_json.as_deref())
            });
            true
        }
        WorkerCommand::PruneBlobCache {
            command_id,
            max_bytes,
        } => {
            run_worker_json_command(client, event_tx, command_id, "pruneBlobCache", |client| {
                client.worker_prune_blob_cache_json(max_bytes)
            });
            true
        }
        WorkerCommand::ClearBlobCache { command_id } => {
            run_worker_json_command(client, event_tx, command_id, "clearBlobCache", |client| {
                client.worker_clear_blob_cache_json()
            });
            true
        }
        WorkerCommand::SetAuthHeaders(headers) => {
            client.set_auth_headers(headers);
            true
        }
        WorkerCommand::SetSubscriptions(subscriptions) => {
            client.set_subscriptions(subscriptions);
            true
        }
        WorkerCommand::SetFieldEncryption(encryption) => {
            client.set_field_encryption(encryption);
            true
        }
        WorkerCommand::SetEncryptedCrdt(encryption) => {
            client.set_encrypted_crdt(encryption);
            true
        }
        WorkerCommand::Stop => {
            let _ = flush_pending_yjs(client, pending_yjs, event_tx);
            false
        }
    }
}

fn run_until_settled<S, T>(
    client: &mut SyncularClient<S, T>,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    pending_yjs: &mut BTreeMap<YjsBatchKey, PendingYjsBatch>,
    initial_command_id: Option<String>,
    initial_emit_started: bool,
    initial_transport: WorkerSyncTransport,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport + SyncAuthHeaderStore,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let mut should_sync = Some((initial_command_id, initial_emit_started, initial_transport));
    while let Some((command_id, emit_started, transport)) = should_sync.take() {
        run_sync(client, event_tx, command_id, emit_started, transport);

        let mut next_sync: Option<(Option<String>, bool, WorkerSyncTransport)> = None;
        loop {
            match command_rx.try_recv() {
                Ok(WorkerCommand::Trigger {
                    command_id,
                    emit_started,
                    transport,
                }) => {
                    next_sync = Some(match next_sync {
                        Some((existing_id, existing_emit_started, existing_transport)) => (
                            existing_id.or(command_id),
                            existing_emit_started || emit_started,
                            existing_transport.coalesce(transport),
                        ),
                        None => (command_id, emit_started, transport),
                    });
                }
                Ok(WorkerCommand::SetAuthHeaders(headers)) => {
                    client.set_auth_headers(headers);
                }
                Ok(WorkerCommand::SetSubscriptions(subscriptions)) => {
                    client.set_subscriptions(subscriptions);
                }
                Ok(WorkerCommand::SetFieldEncryption(encryption)) => {
                    client.set_field_encryption(encryption);
                }
                Ok(WorkerCommand::SetEncryptedCrdt(encryption)) => {
                    client.set_encrypted_crdt(encryption);
                }
                Ok(WorkerCommand::ApplyLocalOperationJson {
                    command_id,
                    operation_json,
                    local_row_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if apply_local_operation_json(
                        client,
                        event_tx,
                        command_id,
                        &operation_json,
                        local_row_json.as_deref(),
                        auto_sync,
                    ) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                }
                Ok(WorkerCommand::SaveYjsUpdateJson {
                    command_id,
                    update_json,
                    auto_sync,
                }) => {
                    queue_yjs_update_json(
                        pending_yjs,
                        event_tx,
                        command_id,
                        &update_json,
                        auto_sync,
                    );
                }
                Ok(WorkerCommand::ApplyCrdtFieldTextJson {
                    command_id,
                    request_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if apply_crdt_field_text_json(
                        client,
                        event_tx,
                        command_id,
                        &request_json,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                }
                Ok(WorkerCommand::CompactCrdtFieldJson {
                    command_id,
                    request_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if compact_crdt_field_json(
                        client,
                        event_tx,
                        command_id,
                        &request_json,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                }
                Ok(WorkerCommand::ApplyEncryptedCrdtUpdateJson {
                    command_id,
                    request_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if apply_encrypted_crdt_update_json(
                        client,
                        event_tx,
                        command_id,
                        &request_json,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                }
                Ok(WorkerCommand::ApplyEncryptedCrdtCheckpointJson {
                    command_id,
                    request_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if apply_encrypted_crdt_checkpoint_json(
                        client,
                        event_tx,
                        command_id,
                        &request_json,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                }
                Ok(WorkerCommand::ResolveConflict {
                    command_id,
                    conflict_id,
                    resolution,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if resolve_conflict(
                        client,
                        event_tx,
                        command_id,
                        &conflict_id,
                        &resolution,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                }
                Ok(WorkerCommand::RefreshSnapshotJson {
                    command_id,
                    request_json,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    refresh_snapshot_json(client, event_tx, command_id, &request_json);
                }
                Ok(WorkerCommand::CompactStorageJson {
                    command_id,
                    options_json,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "compactStorage",
                        |client| client.worker_compact_storage_json(options_json.as_deref()),
                    );
                }
                Ok(WorkerCommand::StoreBlobFileJson {
                    command_id,
                    path,
                    options_json,
                }) => {
                    run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "storeBlobFile",
                        |client| client.worker_store_blob_file_json(&path, options_json.as_deref()),
                    );
                }
                Ok(WorkerCommand::RetrieveBlobFileJson {
                    command_id,
                    ref_json,
                    path,
                    options_json,
                }) => {
                    run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "retrieveBlobFile",
                        |client| {
                            client.worker_retrieve_blob_file_json(
                                &ref_json,
                                &path,
                                options_json.as_deref(),
                            )
                        },
                    );
                }
                Ok(WorkerCommand::PruneBlobCache {
                    command_id,
                    max_bytes,
                }) => {
                    run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "pruneBlobCache",
                        |client| client.worker_prune_blob_cache_json(max_bytes),
                    );
                }
                Ok(WorkerCommand::ClearBlobCache { command_id }) => {
                    run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "clearBlobCache",
                        |client| client.worker_clear_blob_cache_json(),
                    );
                }
                Ok(WorkerCommand::Stop) | Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = flush_pending_yjs(client, pending_yjs, event_tx);
                    return false;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        if flush_pending_yjs(client, pending_yjs, event_tx) {
            next_sync = Some((None, false, WorkerSyncTransport::Http));
        }
        should_sync = next_sync;
    }
    true
}

fn run_sync<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: Option<String>,
    emit_started: bool,
    transport: WorkerSyncTransport,
) where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    if emit_started {
        let _ = event_tx.send(SyncWorkerEvent::SyncStarted {
            command_id: command_id.clone(),
        });
    }

    let started = Instant::now();
    let result = match transport {
        WorkerSyncTransport::Http => client.sync_http(),
        WorkerSyncTransport::WebSocket => client.sync_ws(),
    };
    match result {
        Ok(report) => {
            let (outbox_count, conflict_count) = worker_counts(client).unwrap_or((0, 0));
            let _ = event_tx.send(SyncWorkerEvent::SyncCompleted {
                command_id,
                report,
                outbox_count,
                conflict_count,
                duration_ms: duration_ms(started),
            });
        }
        Err(error) => {
            let retry_scheduled = retry_scheduled_after_error(client);
            let _ = event_tx.send(SyncWorkerEvent::SyncFailed {
                command_id,
                error,
                retry_scheduled,
                duration_ms: duration_ms(started),
            });
        }
    }
}

fn apply_local_operation_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    operation_json: &str,
    local_row_json: Option<&str>,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    let operation = serde_json::from_str::<SyncOperation>(operation_json).ok();
    let table = operation
        .as_ref()
        .map(|operation| operation.table.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let previous_row = operation.as_ref().and_then(|operation| {
        client
            .worker_current_row_json(&operation.table, &operation.row_id)
            .ok()
            .flatten()
    });
    let local_row = local_row_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .ok()
        .flatten();
    match client.apply_worker_local_operation_json(operation_json, local_row_json) {
        Ok(client_commit_id) => {
            let changed_rows = operation
                .as_ref()
                .and_then(|operation| {
                    sync_changed_row_for_local_operation(
                        client.app_schema(),
                        operation,
                        previous_row.as_ref(),
                        local_row.as_ref(),
                        Some(client_commit_id.clone()),
                    )
                })
                .into_iter()
                .collect();
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id,
                client_commit_id,
                changed_tables: vec![table],
                changed_rows,
                duration_ms: duration_ms(started),
            });
            auto_sync
        }
        Err(error) => {
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json: None,
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn apply_encrypted_crdt_update_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    request_json: &str,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    match client.apply_worker_encrypted_crdt_update_json(request_json) {
        Ok(receipt) => {
            let crdt_event = WorkerEncryptedCrdtRequest::from_json(request_json).ok();
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event.and_then(WorkerEncryptedCrdtRequest::field_identity) {
                let _ = event_tx.send(SyncWorkerEvent::CrdtFieldChanged {
                    command_id,
                    client_commit_id: receipt.client_commit_id,
                    table: request.table,
                    row_id: request.row_id,
                    field: request.field,
                    changed_tables: receipt.changed_tables,
                    payload_json: receipt.crdt_event_payload_json,
                    duration_ms: duration_ms(started),
                });
            }
            auto_sync
        }
        Err(error) => {
            let payload_json = crdt_field_failure_payload_json("encryptedCrdtUpdate", request_json);
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn apply_encrypted_crdt_checkpoint_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    request_json: &str,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    match client.apply_worker_encrypted_crdt_checkpoint_json(request_json) {
        Ok(Some(receipt)) => {
            let crdt_event = WorkerEncryptedCrdtRequest::from_json(request_json).ok();
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event.and_then(WorkerEncryptedCrdtRequest::field_identity) {
                let _ = event_tx.send(SyncWorkerEvent::CrdtFieldCompacted {
                    command_id,
                    client_commit_id: receipt.client_commit_id,
                    table: request.table,
                    row_id: request.row_id,
                    field: request.field,
                    changed_tables: receipt.changed_tables,
                    payload_json: receipt.crdt_event_payload_json,
                    duration_ms: duration_ms(started),
                });
            }
            auto_sync
        }
        Ok(None) => {
            let _ = event_tx.send(SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation: "encryptedCrdtCheckpoint",
                payload_json: Some(json!({ "checkpointed": false })),
                duration_ms: duration_ms(started),
            });
            false
        }
        Err(error) => {
            let payload_json =
                crdt_field_failure_payload_json("encryptedCrdtCheckpoint", request_json);
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn apply_crdt_field_text_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    request_json: &str,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    match client.apply_worker_crdt_field_text_json(request_json) {
        Ok(receipt) => {
            let crdt_event = WorkerCrdtFieldTextRequest::from_json(request_json).ok();
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event {
                let _ = event_tx.send(SyncWorkerEvent::CrdtFieldChanged {
                    command_id,
                    client_commit_id: receipt.client_commit_id,
                    table: request.table,
                    row_id: request.row_id,
                    field: request.field,
                    changed_tables: receipt.changed_tables,
                    payload_json: receipt.crdt_event_payload_json,
                    duration_ms: duration_ms(started),
                });
            }
            auto_sync
        }
        Err(error) => {
            let payload_json = crdt_field_failure_payload_json("crdtFieldText", request_json);
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn compact_crdt_field_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    request_json: &str,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    match client.compact_worker_crdt_field_json(request_json) {
        Ok(Some(receipt)) => {
            let crdt_event = WorkerCrdtFieldCompactionRequest::from_json(request_json).ok();
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event {
                let _ = event_tx.send(SyncWorkerEvent::CrdtFieldCompacted {
                    command_id,
                    client_commit_id: receipt.client_commit_id,
                    table: request.table,
                    row_id: request.row_id,
                    field: request.field,
                    changed_tables: receipt.changed_tables,
                    payload_json: receipt.crdt_event_payload_json,
                    duration_ms: duration_ms(started),
                });
            }
            auto_sync
        }
        Ok(None) => {
            let payload_json = compact_crdt_field_skipped_payload(client, request_json);
            let _ = event_tx.send(SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation: "compactCrdtField",
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
            false
        }
        Err(error) => {
            let payload_json = crdt_field_failure_payload_json("compactCrdtField", request_json);
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn resolve_conflict<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    conflict_id: &str,
    resolution: &str,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    let started = Instant::now();
    let result = if resolution == "keep-local" {
        client.retry_conflict_keep_local(conflict_id).map(Some)
    } else {
        client
            .resolve_conflict(conflict_id, resolution)
            .map(|_| None)
    };

    match result {
        Ok(retry_client_commit_id) => {
            let should_sync = retry_client_commit_id.is_some() && auto_sync;
            let _ = event_tx.send(SyncWorkerEvent::ConflictResolutionCompleted {
                command_id,
                retry_client_commit_id,
                duration_ms: duration_ms(started),
            });
            should_sync
        }
        Err(error) => {
            let _ = event_tx.send(SyncWorkerEvent::ConflictResolutionFailed {
                command_id,
                error,
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn refresh_snapshot_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    request_json: &str,
) where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    match client
        .worker_query_json(request_json)
        .and_then(|json| serde_json::from_str::<Value>(&json).map_err(Into::into))
    {
        Ok(payload_json) => {
            let _ = event_tx.send(SyncWorkerEvent::SnapshotReady {
                command_id,
                payload_json,
                duration_ms: duration_ms(started),
            });
        }
        Err(error) => {
            let _ = event_tx.send(SyncWorkerEvent::WorkerCommandFailed {
                command_id,
                operation: "refreshSnapshot",
                error,
                duration_ms: duration_ms(started),
            });
        }
    }
}

fn compact_crdt_field_skipped_payload<S, T>(
    client: &mut SyncularClient<S, T>,
    request_json: &str,
) -> Value
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let request = WorkerCrdtFieldCompactionRequest::from_json(request_json).ok();
    let mut payload = request
        .as_ref()
        .and_then(|request| {
            client
                .worker_crdt_field_event_payload_json(
                    &request.table,
                    &request.row_id,
                    &request.field,
                )
                .ok()
                .flatten()
        })
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    if let Some(request) = request {
        payload.insert("table".to_string(), json!(request.table));
        payload.insert("rowId".to_string(), json!(request.row_id));
        payload.insert("field".to_string(), json!(request.field));
        payload.insert(
            "minUncheckpointedUpdates".to_string(),
            json!(request.min_uncheckpointed_updates.unwrap_or(1)),
        );
    }
    payload.insert("checkpointCreated".to_string(), json!(false));
    Value::Object(payload)
}

fn crdt_field_failure_payload_json(operation: &'static str, request_json: &str) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("operation".to_string(), json!(operation));
    payload.insert("failedBeforeCommit".to_string(), json!(true));
    payload.insert("retryScheduled".to_string(), json!(false));

    match serde_json::from_str::<Value>(request_json) {
        Ok(Value::Object(request)) => {
            copy_crdt_request_field(&mut payload, &request, "table", "table");
            copy_crdt_request_field(&mut payload, &request, "rowId", "rowId");
            copy_crdt_request_field(&mut payload, &request, "row_id", "rowId");
            copy_crdt_request_field(&mut payload, &request, "field", "field");
            copy_crdt_request_field(
                &mut payload,
                &request,
                "minUncheckpointedUpdates",
                "minUncheckpointedUpdates",
            );
            copy_crdt_request_field(
                &mut payload,
                &request,
                "min_uncheckpointed_updates",
                "minUncheckpointedUpdates",
            );
        }
        Ok(_) => {
            payload.insert("requestShape".to_string(), json!("non-object"));
        }
        Err(error) => {
            payload.insert("requestParseError".to_string(), json!(error.to_string()));
        }
    }

    Value::Object(payload)
}

fn crdt_field_failure_payload_from_parts(
    operation: &'static str,
    table: &str,
    row_id: &str,
    field: &str,
) -> Value {
    json!({
        "operation": operation,
        "table": table,
        "rowId": row_id,
        "field": field,
        "failedBeforeCommit": true,
        "retryScheduled": false,
    })
}

fn copy_crdt_request_field(
    payload: &mut serde_json::Map<String, Value>,
    request: &serde_json::Map<String, Value>,
    from: &str,
    to: &str,
) {
    if !payload.contains_key(to) {
        if let Some(value) = request.get(from) {
            payload.insert(to.to_string(), value.clone());
        }
    }
}

fn run_worker_json_command<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    operation: &'static str,
    f: impl FnOnce(&mut SyncularClient<S, T>) -> Result<String>,
) where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    let started = Instant::now();
    match f(client).and_then(|json| {
        if json.trim().is_empty() {
            Ok(None)
        } else {
            serde_json::from_str::<Value>(&json)
                .map(Some)
                .map_err(Into::into)
        }
    }) {
        Ok(payload_json) => {
            let _ = event_tx.send(SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation,
                payload_json,
                duration_ms: duration_ms(started),
            });
        }
        Err(error) => {
            let _ = event_tx.send(SyncWorkerEvent::WorkerCommandFailed {
                command_id,
                operation,
                error,
                duration_ms: duration_ms(started),
            });
        }
    }
}

fn queue_yjs_update_json(
    pending_yjs: &mut BTreeMap<YjsBatchKey, PendingYjsBatch>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
    command_id: String,
    update_json: &str,
    auto_sync: bool,
) {
    let started = Instant::now();
    let update: Result<SaveYjsUpdate> = serde_json::from_str(update_json).map_err(Into::into);
    match update {
        Ok(update) => {
            let key = YjsBatchKey {
                table: update.table,
                row_id: update.row_id,
                field: update.field,
            };
            let batch = pending_yjs.entry(key).or_default();
            batch.command_ids.push(command_id);
            batch.updates.push(update.update);
            if update.materialized.is_some() {
                batch.materialized = update.materialized;
            }
            if update.server_payload.is_some() {
                batch.server_payload = update.server_payload;
            }
            batch.auto_sync |= auto_sync;
        }
        Err(error) => {
            let payload_json = crdt_field_failure_payload_json("crdtFieldYjsUpdate", update_json);
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
        }
    }
}

fn flush_pending_yjs<S, T>(
    client: &mut SyncularClient<S, T>,
    pending_yjs: &mut BTreeMap<YjsBatchKey, PendingYjsBatch>,
    event_tx: &mpsc::Sender<SyncWorkerEvent>,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let mut should_sync = false;
    let batches = std::mem::take(pending_yjs);
    for (key, batch) in batches {
        let started = Instant::now();
        let payload = {
            let mut payload = match batch.server_payload {
                Some(Value::Object(payload)) => payload,
                Some(_) => {
                    let error = SyncularError::config(
                        "queued Yjs serverPayload must be a JSON object when provided",
                    );
                    let message = error.message_text();
                    let kind = error.kind();
                    for command_id in batch.command_ids {
                        let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                            command_id,
                            error: SyncularError::message(kind, &message),
                            payload_json: Some(crdt_field_failure_payload_from_parts(
                                "crdtFieldYjsUpdate",
                                &key.table,
                                &key.row_id,
                                &key.field,
                            )),
                            duration_ms: duration_ms(started),
                        });
                    }
                    continue;
                }
                None => serde_json::Map::new(),
            };
            let mut envelope = serde_json::Map::new();
            envelope.insert(key.field.clone(), json!(batch.updates));
            payload.insert(YJS_PAYLOAD_KEY.to_string(), Value::Object(envelope));
            Value::Object(payload)
        };
        let operation = SyncOperation {
            table: key.table.clone(),
            row_id: key.row_id.clone(),
            op: "upsert".to_string(),
            payload: Some(payload),
            base_version: None,
        };
        match client.apply_worker_local_operation(operation, batch.materialized) {
            Ok(client_commit_id) => {
                should_sync |= batch.auto_sync;
                let crdt_event_payload_json = client
                    .worker_crdt_field_event_payload_json(&key.table, &key.row_id, &key.field)
                    .ok()
                    .flatten();
                for command_id in batch.command_ids {
                    let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                        command_id: command_id.clone(),
                        client_commit_id: client_commit_id.clone(),
                        changed_tables: vec![key.table.clone()],
                        changed_rows: vec![SyncChangedRow {
                            table: key.table.clone(),
                            row_id: Some(key.row_id.clone()),
                            operation: "update".to_string(),
                            changed_fields: vec![key.field.clone()],
                            crdt_fields: vec![key.field.clone()],
                            commit_id: Some(client_commit_id.clone()),
                            commit_seq: None,
                            subscription_id: None,
                            server_version: None,
                        }],
                        duration_ms: duration_ms(started),
                    });
                    let _ = event_tx.send(SyncWorkerEvent::CrdtFieldChanged {
                        command_id,
                        client_commit_id: client_commit_id.clone(),
                        table: key.table.clone(),
                        row_id: key.row_id.clone(),
                        field: key.field.clone(),
                        changed_tables: vec![key.table.clone()],
                        payload_json: crdt_event_payload_json.clone(),
                        duration_ms: duration_ms(started),
                    });
                }
            }
            Err(error) => {
                let message = error.message_text();
                let kind = error.kind();
                for command_id in batch.command_ids {
                    let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                        command_id,
                        error: SyncularError::message(kind, &message),
                        payload_json: Some(crdt_field_failure_payload_from_parts(
                            "crdtFieldYjsUpdate",
                            &key.table,
                            &key.row_id,
                            &key.field,
                        )),
                        duration_ms: duration_ms(started),
                    });
                }
            }
        }
    }
    should_sync
}

fn worker_counts<S, T>(client: &mut SyncularClient<S, T>) -> Result<(usize, usize)>
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    let outbox_count = client
        .outbox_summaries()?
        .into_iter()
        .filter(|item| item.status != "acked")
        .count();
    let conflict_count = client.conflict_summaries()?.len();
    Ok((outbox_count, conflict_count))
}

fn retry_scheduled_after_error<S, T>(client: &mut SyncularClient<S, T>) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    client
        .outbox_summaries()
        .map(|items| {
            items
                .into_iter()
                .any(|item| item.status == "pending" || item.status == "sending")
        })
        .unwrap_or(false)
}

fn duration_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct YjsBatchKey {
    table: String,
    row_id: String,
    field: String,
}

#[derive(Debug, Default)]
struct PendingYjsBatch {
    command_ids: Vec<String>,
    updates: Vec<YjsUpdateEnvelope>,
    materialized: Option<Value>,
    server_payload: Option<Value>,
    auto_sync: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveYjsUpdate {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    update: YjsUpdateEnvelope,
    #[serde(default)]
    materialized: Option<Value>,
    #[serde(default, alias = "server_payload")]
    server_payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerEncryptedCrdtRequest {
    table: String,
    #[serde(default, alias = "row_id")]
    row_id: Option<String>,
    #[serde(default)]
    field: Option<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(feature = "native"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
struct WorkerCrdtFieldTextRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(alias = "next_text")]
    next_text: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(feature = "native"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
struct WorkerCrdtFieldCompactionRequest {
    table: String,
    #[serde(alias = "row_id")]
    row_id: String,
    field: String,
    #[serde(default, alias = "min_uncheckpointed_updates")]
    min_uncheckpointed_updates: Option<i64>,
}

struct WorkerCrdtFieldIdentity {
    table: String,
    row_id: String,
    field: String,
}

#[cfg(feature = "native")]
struct WorkerCrdtFieldIdentityRef<'a> {
    table: &'a str,
    row_id: &'a str,
    field: &'a str,
}

impl WorkerEncryptedCrdtRequest {
    fn from_json(request_json: &str) -> Result<Self> {
        serde_json::from_str(request_json).map_err(Into::into)
    }

    #[cfg(feature = "native")]
    fn field_identity_ref(&self) -> Option<WorkerCrdtFieldIdentityRef<'_>> {
        Some(WorkerCrdtFieldIdentityRef {
            table: &self.table,
            row_id: self.row_id.as_deref()?,
            field: self.field.as_deref()?,
        })
    }

    fn field_identity(self) -> Option<WorkerCrdtFieldIdentity> {
        Some(WorkerCrdtFieldIdentity {
            table: self.table,
            row_id: self.row_id?,
            field: self.field?,
        })
    }
}

#[cfg(feature = "native")]
impl WorkerCrdtFieldIdentityRef<'_> {
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table, self.row_id, self.field)
    }
}

impl WorkerCrdtFieldTextRequest {
    fn from_json(request_json: &str) -> Result<Self> {
        serde_json::from_str(request_json).map_err(Into::into)
    }

    #[cfg(feature = "native")]
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

impl WorkerCrdtFieldCompactionRequest {
    fn from_json(request_json: &str) -> Result<Self> {
        serde_json::from_str(request_json).map_err(Into::into)
    }

    #[cfg(feature = "native")]
    fn id(&self) -> CrdtFieldId {
        CrdtFieldId::new(self.table.clone(), self.row_id.clone(), self.field.clone())
    }
}

#[cfg(feature = "native")]
fn crdt_field_write_tables_for_worker(field: &CrdtField) -> Vec<String> {
    match field.sync_mode() {
        CrdtFieldSyncMode::ServerMerge => vec![field.table().to_string()],
        CrdtFieldSyncMode::EncryptedUpdateLog => {
            vec![field.table().to_string(), CRDT_UPDATES_TABLE.to_string()]
        }
    }
}

#[cfg(feature = "native")]
fn crdt_field_compaction_tables_for_worker(field: &CrdtField) -> Vec<String> {
    match field.sync_mode() {
        CrdtFieldSyncMode::ServerMerge => Vec::new(),
        CrdtFieldSyncMode::EncryptedUpdateLog => vec![CRDT_CHECKPOINTS_TABLE.to_string()],
    }
}

#[cfg(feature = "native")]
fn crdt_field_changed_row_for_worker(field: &CrdtField, client_commit_id: &str) -> SyncChangedRow {
    SyncChangedRow {
        table: field.table().to_string(),
        row_id: Some(field.row_id().to_string()),
        operation: "update".to_string(),
        changed_fields: vec![field.field().to_string(), field.state_column().to_string()],
        crdt_fields: vec![field.state_column().to_string()],
        commit_id: Some(client_commit_id.to_string()),
        commit_seq: None,
        subscription_id: None,
        server_version: None,
    }
}

#[cfg(feature = "native")]
fn crdt_field_compacted_row_for_worker(
    field: &CrdtField,
    client_commit_id: &str,
) -> SyncChangedRow {
    SyncChangedRow {
        table: field.table().to_string(),
        row_id: Some(field.row_id().to_string()),
        operation: "compact".to_string(),
        changed_fields: vec![field.state_column().to_string()],
        crdt_fields: vec![field.state_column().to_string()],
        commit_id: Some(client_commit_id.to_string()),
        commit_seq: None,
        subscription_id: None,
        server_version: None,
    }
}

#[cfg(feature = "native")]
fn crdt_field_event_payload_for_worker<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    field: &CrdtField,
) -> Option<Value>
where
    T: SyncTransport,
{
    let mut payload = crdt_field_base_payload_for_worker(field);
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

#[cfg(feature = "native")]
fn crdt_field_compaction_payload_for_worker<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    field: &CrdtField,
    checkpoint_created: bool,
    min_uncheckpointed_updates: i64,
) -> Option<Value>
where
    T: SyncTransport,
{
    let mut payload = crdt_field_event_payload_for_worker(client, field)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_else(|| crdt_field_base_payload_for_worker(field));
    payload.insert("checkpointCreated".to_string(), json!(checkpoint_created));
    payload.insert(
        "minUncheckpointedUpdates".to_string(),
        json!(min_uncheckpointed_updates),
    );
    Some(Value::Object(payload))
}

#[cfg(feature = "native")]
fn crdt_field_base_payload_for_worker(field: &CrdtField) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert("syncMode".to_string(), json!(field.sync_mode()));
    payload.insert("kind".to_string(), json!(field.field_metadata().kind));
    payload.insert("stateColumn".to_string(), json!(field.state_column()));
    payload.insert("containerKey".to_string(), json!(field.container_key()));
    payload.insert("rowIdField".to_string(), json!(field.row_id_field()));
    payload
}

#[cfg(feature = "native")]
fn encrypted_crdt_min_uncheckpointed_updates(request_json: &str) -> i64 {
    serde_json::from_str::<WorkerCrdtFieldCompactionRequest>(request_json)
        .ok()
        .and_then(|request| request.min_uncheckpointed_updates)
        .unwrap_or(1)
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBlobStoreOptions {
    mime_type: Option<String>,
    immediate: Option<bool>,
    cache_local: Option<bool>,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBlobRetrieveOptions {
    cache_local: Option<bool>,
}
