use crate::client::{SyncReport, SyncularClient};
use crate::crdt_yjs::{YjsUpdateEnvelope, YJS_PAYLOAD_KEY};
#[cfg(feature = "native")]
use crate::diesel_sqlite::DieselSqliteStore;
use crate::encrypted_crdt::EncryptedCrdt;
#[cfg(feature = "native")]
use crate::encrypted_crdt::{CRDT_CHECKPOINTS_TABLE, CRDT_UPDATES_TABLE};
use crate::encryption::FieldEncryption;
use crate::error::{ErrorKind, Result, SyncularError};
#[cfg(feature = "native")]
use crate::protocol::BlobRef;
use crate::protocol::SyncOperation;
#[cfg(feature = "native")]
use crate::rusqlite_sqlite::RusqliteStore;
use crate::store::{SyncStateStore, SyncStore};
use crate::transport::{SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[cfg(feature = "native")]
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
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
    SetAuthHeaders(SyncAuthHeaders),
    SetFieldEncryption(Option<FieldEncryption>),
    SetEncryptedCrdt(Option<EncryptedCrdt>),
    Stop,
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
        duration_ms: u64,
    },
    LocalWriteFailed {
        command_id: String,
        error: SyncularError,
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

    fn apply_worker_encrypted_crdt_update_json(
        &mut self,
        request_json: &str,
    ) -> Result<WorkerLocalWriteReceipt> {
        let request: WorkerEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let receipt = self.apply_encrypted_crdt_update_json(request_json)?;
        Ok(WorkerLocalWriteReceipt {
            client_commit_id: receipt.client_commit_id,
            changed_tables: vec![request.table, CRDT_UPDATES_TABLE.to_string()],
        })
    }

    fn apply_worker_encrypted_crdt_checkpoint_json(
        &mut self,
        request_json: &str,
    ) -> Result<Option<WorkerLocalWriteReceipt>> {
        let _request: WorkerEncryptedCrdtRequest = serde_json::from_str(request_json)?;
        let receipt = self.apply_encrypted_crdt_checkpoint_json(request_json)?;
        Ok(receipt.map(|receipt| WorkerLocalWriteReceipt {
            client_commit_id: receipt.client_commit_id,
            changed_tables: vec![CRDT_CHECKPOINTS_TABLE.to_string()],
        }))
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

#[cfg(feature = "native")]
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
}

pub struct SyncWorker {
    command_tx: SyncSender<WorkerCommand>,
    event_rx: Receiver<SyncWorkerEvent>,
    join: Option<JoinHandle<()>>,
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
            event_rx,
            join: Some(join),
        }
    }

    pub fn trigger_sync(&self) -> Result<()> {
        self.trigger_sync_inner(None, false)
    }

    pub fn trigger_handle(&self) -> SyncWorkerTrigger {
        SyncWorkerTrigger {
            command_tx: self.command_tx.clone(),
        }
    }

    pub fn enqueue_sync_now(&self, command_id: String) -> Result<()> {
        self.trigger_sync_inner(Some(command_id), true)
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

    pub fn set_field_encryption(&self, encryption: Option<FieldEncryption>) -> Result<()> {
        self.try_send(WorkerCommand::SetFieldEncryption(encryption))
    }

    pub fn set_encrypted_crdt(&self, encryption: Option<EncryptedCrdt>) -> Result<()> {
        self.try_send(WorkerCommand::SetEncryptedCrdt(encryption))
    }

    pub fn recv_event_timeout(&self, timeout: Duration) -> Option<SyncWorkerEvent> {
        self.event_rx.recv_timeout(timeout).ok()
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

    fn trigger_sync_inner(&self, command_id: Option<String>, emit_started: bool) -> Result<()> {
        self.try_send(WorkerCommand::Trigger {
            command_id,
            emit_started,
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
        } => run_until_settled(
            client,
            command_rx,
            event_tx,
            pending_yjs,
            command_id,
            emit_started,
        ),
        WorkerCommand::ApplyLocalOperationJson {
            command_id,
            operation_json,
            local_row_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(client, command_rx, event_tx, pending_yjs, None, false) {
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
                run_until_settled(client, command_rx, event_tx, pending_yjs, None, false)
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
        WorkerCommand::ApplyEncryptedCrdtUpdateJson {
            command_id,
            request_json,
            auto_sync,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(client, command_rx, event_tx, pending_yjs, None, false) {
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
                run_until_settled(client, command_rx, event_tx, pending_yjs, None, false)
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
                if !run_until_settled(client, command_rx, event_tx, pending_yjs, None, false) {
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
                run_until_settled(client, command_rx, event_tx, pending_yjs, None, false)
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
                if !run_until_settled(client, command_rx, event_tx, pending_yjs, None, false) {
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
                run_until_settled(client, command_rx, event_tx, pending_yjs, None, false)
            } else {
                true
            }
        }
        WorkerCommand::RefreshSnapshotJson {
            command_id,
            request_json,
        } => {
            if flush_pending_yjs(client, pending_yjs, event_tx) {
                if !run_until_settled(client, command_rx, event_tx, pending_yjs, None, false) {
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
                if !run_until_settled(client, command_rx, event_tx, pending_yjs, None, false) {
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
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport + SyncAuthHeaderStore,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let mut should_sync = Some((initial_command_id, initial_emit_started));
    while let Some((command_id, emit_started)) = should_sync.take() {
        run_sync(client, event_tx, command_id, emit_started);

        let mut next_sync: Option<(Option<String>, bool)> = None;
        loop {
            match command_rx.try_recv() {
                Ok(WorkerCommand::Trigger {
                    command_id,
                    emit_started,
                }) => {
                    next_sync = Some(match next_sync {
                        Some((existing_id, existing_emit_started)) => (
                            existing_id.or(command_id),
                            existing_emit_started || emit_started,
                        ),
                        None => (command_id, emit_started),
                    });
                }
                Ok(WorkerCommand::SetAuthHeaders(headers)) => {
                    client.set_auth_headers(headers);
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
                        next_sync = Some((None, false));
                    }
                    if apply_local_operation_json(
                        client,
                        event_tx,
                        command_id,
                        &operation_json,
                        local_row_json.as_deref(),
                        auto_sync,
                    ) {
                        next_sync = Some((None, false));
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
                Ok(WorkerCommand::ApplyEncryptedCrdtUpdateJson {
                    command_id,
                    request_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false));
                    }
                    if apply_encrypted_crdt_update_json(
                        client,
                        event_tx,
                        command_id,
                        &request_json,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false));
                    }
                }
                Ok(WorkerCommand::ApplyEncryptedCrdtCheckpointJson {
                    command_id,
                    request_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false));
                    }
                    if apply_encrypted_crdt_checkpoint_json(
                        client,
                        event_tx,
                        command_id,
                        &request_json,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false));
                    }
                }
                Ok(WorkerCommand::ResolveConflict {
                    command_id,
                    conflict_id,
                    resolution,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false));
                    }
                    if resolve_conflict(
                        client,
                        event_tx,
                        command_id,
                        &conflict_id,
                        &resolution,
                        auto_sync,
                    ) {
                        next_sync = Some((None, false));
                    }
                }
                Ok(WorkerCommand::RefreshSnapshotJson {
                    command_id,
                    request_json,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false));
                    }
                    refresh_snapshot_json(client, event_tx, command_id, &request_json);
                }
                Ok(WorkerCommand::CompactStorageJson {
                    command_id,
                    options_json,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false));
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
            next_sync = Some((None, false));
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
    match client.sync_http() {
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
    let table = serde_json::from_str::<SyncOperation>(operation_json)
        .map(|operation| operation.table)
        .unwrap_or_else(|_| "unknown".to_string());
    match client.apply_worker_local_operation_json(operation_json, local_row_json) {
        Ok(client_commit_id) => {
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id,
                client_commit_id,
                changed_tables: vec![table],
                duration_ms: duration_ms(started),
            });
            auto_sync
        }
        Err(error) => {
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
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
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id,
                client_commit_id: receipt.client_commit_id,
                changed_tables: receipt.changed_tables,
                duration_ms: duration_ms(started),
            });
            auto_sync
        }
        Err(error) => {
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
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
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                command_id,
                client_commit_id: receipt.client_commit_id,
                changed_tables: receipt.changed_tables,
                duration_ms: duration_ms(started),
            });
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
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
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
            let _ = event_tx.send(SyncWorkerEvent::LocalWriteFailed {
                command_id,
                error,
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
                for command_id in batch.command_ids {
                    let _ = event_tx.send(SyncWorkerEvent::LocalWriteCommitted {
                        command_id,
                        client_commit_id: client_commit_id.clone(),
                        changed_tables: vec![key.table.clone()],
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

#[cfg(feature = "native")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerEncryptedCrdtRequest {
    table: String,
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
