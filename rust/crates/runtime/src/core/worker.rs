#[cfg(feature = "native")]
use crate::client::sync_changed_crdt_field_from_metadata;
#[cfg(feature = "native")]
use crate::client::BootstrapStatus;
#[cfg(feature = "native")]
use crate::client::CrdtFieldCompactionReceipt;
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
use crate::store::{now_ms, retry_backoff_delay_ms, SyncStateStore, SyncStore};
#[cfg(feature = "native")]
use crate::transport::BlobTransport;
use crate::transport::{
    RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
#[cfg(feature = "native")]
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEFAULT_COMMAND_QUEUE_CAPACITY: usize = 1024;
const DEFAULT_EVENT_QUEUE_CAPACITY: usize = 1024;
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
    ApplyMutationJson {
        command_id: String,
        mutation_json: String,
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
    ProcessBlobUploadQueue {
        command_id: String,
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
        #[cfg(feature = "native")]
        bootstrap: BootstrapStatus,
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
        outbox_count: usize,
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
        client_commit_id: Option<String>,
        table: String,
        row_id: String,
        field: String,
        changed_tables: Vec<String>,
        checkpoint_created: bool,
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
    BlobUploadsChanged {
        stats_json: Value,
    },
    EventsOverflowed {
        dropped_count: usize,
    },
}

impl Clone for SyncWorkerEvent {
    fn clone(&self) -> Self {
        match self {
            Self::SyncStarted { command_id } => Self::SyncStarted {
                command_id: command_id.clone(),
            },
            Self::SyncCompleted {
                command_id,
                report,
                #[cfg(feature = "native")]
                bootstrap,
                outbox_count,
                conflict_count,
                duration_ms,
            } => Self::SyncCompleted {
                command_id: command_id.clone(),
                report: report.clone(),
                #[cfg(feature = "native")]
                bootstrap: bootstrap.clone(),
                outbox_count: *outbox_count,
                conflict_count: *conflict_count,
                duration_ms: *duration_ms,
            },
            Self::SyncFailed {
                command_id,
                error,
                retry_scheduled,
                duration_ms,
            } => Self::SyncFailed {
                command_id: command_id.clone(),
                error: clone_worker_error(error),
                retry_scheduled: *retry_scheduled,
                duration_ms: *duration_ms,
            },
            Self::LocalWriteCommitted {
                command_id,
                client_commit_id,
                changed_tables,
                changed_rows,
                outbox_count,
                duration_ms,
            } => Self::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: client_commit_id.clone(),
                changed_tables: changed_tables.clone(),
                changed_rows: changed_rows.clone(),
                outbox_count: *outbox_count,
                duration_ms: *duration_ms,
            },
            Self::CrdtFieldChanged {
                command_id,
                client_commit_id,
                table,
                row_id,
                field,
                changed_tables,
                payload_json,
                duration_ms,
            } => Self::CrdtFieldChanged {
                command_id: command_id.clone(),
                client_commit_id: client_commit_id.clone(),
                table: table.clone(),
                row_id: row_id.clone(),
                field: field.clone(),
                changed_tables: changed_tables.clone(),
                payload_json: payload_json.clone(),
                duration_ms: *duration_ms,
            },
            Self::CrdtFieldCompacted {
                command_id,
                client_commit_id,
                table,
                row_id,
                field,
                changed_tables,
                checkpoint_created,
                payload_json,
                duration_ms,
            } => Self::CrdtFieldCompacted {
                command_id: command_id.clone(),
                client_commit_id: client_commit_id.clone(),
                table: table.clone(),
                row_id: row_id.clone(),
                field: field.clone(),
                changed_tables: changed_tables.clone(),
                checkpoint_created: *checkpoint_created,
                payload_json: payload_json.clone(),
                duration_ms: *duration_ms,
            },
            Self::LocalWriteFailed {
                command_id,
                error,
                payload_json,
                duration_ms,
            } => Self::LocalWriteFailed {
                command_id: command_id.clone(),
                error: clone_worker_error(error),
                payload_json: payload_json.clone(),
                duration_ms: *duration_ms,
            },
            Self::ConflictResolutionCompleted {
                command_id,
                retry_client_commit_id,
                duration_ms,
            } => Self::ConflictResolutionCompleted {
                command_id: command_id.clone(),
                retry_client_commit_id: retry_client_commit_id.clone(),
                duration_ms: *duration_ms,
            },
            Self::ConflictResolutionFailed {
                command_id,
                error,
                duration_ms,
            } => Self::ConflictResolutionFailed {
                command_id: command_id.clone(),
                error: clone_worker_error(error),
                duration_ms: *duration_ms,
            },
            Self::SnapshotReady {
                command_id,
                payload_json,
                duration_ms,
            } => Self::SnapshotReady {
                command_id: command_id.clone(),
                payload_json: payload_json.clone(),
                duration_ms: *duration_ms,
            },
            Self::WorkerCommandCompleted {
                command_id,
                operation,
                payload_json,
                duration_ms,
            } => Self::WorkerCommandCompleted {
                command_id: command_id.clone(),
                operation: *operation,
                payload_json: payload_json.clone(),
                duration_ms: *duration_ms,
            },
            Self::WorkerCommandFailed {
                command_id,
                operation,
                error,
                duration_ms,
            } => Self::WorkerCommandFailed {
                command_id: command_id.clone(),
                operation: *operation,
                error: clone_worker_error(error),
                duration_ms: *duration_ms,
            },
            Self::BlobUploadsChanged { stats_json } => Self::BlobUploadsChanged {
                stats_json: stats_json.clone(),
            },
            Self::EventsOverflowed { dropped_count } => Self::EventsOverflowed {
                dropped_count: *dropped_count,
            },
        }
    }
}

impl SyncWorkerEvent {
    pub fn requires_full_refresh(&self) -> bool {
        match self {
            Self::SyncFailed { error, .. } => error.requires_full_snapshot_resync(),
            Self::EventsOverflowed { .. } => true,
            _ => false,
        }
    }
}

fn clone_worker_error(error: &SyncularError) -> SyncularError {
    SyncularError::message(error.kind(), error.to_string())
}

pub trait SyncWorkerClientExt {
    fn apply_worker_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String>;

    fn apply_worker_mutation(
        &mut self,
        mutation: SyncOperation,
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

    fn worker_crdt_field_changed_row(
        &mut self,
        _table: &str,
        _row_id: &str,
        _field: &str,
        _client_commit_id: &str,
    ) -> Result<Option<SyncChangedRow>> {
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

    fn worker_process_blob_upload_queue_json(&mut self) -> Result<Option<String>> {
        Ok(None)
    }

    fn worker_blob_upload_queue_stats_json(&mut self) -> Result<Option<String>> {
        Ok(None)
    }

    fn worker_next_outbox_retry_at_ms(&mut self) -> Result<Option<i64>> {
        Ok(None)
    }

    fn worker_next_blob_upload_retry_at_ms(&mut self) -> Result<Option<i64>> {
        Ok(None)
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
    T: SyncTransport + BlobTransport,
{
    fn apply_worker_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        self.apply_mutation_json(mutation_json, local_row_json)
    }

    fn apply_worker_mutation(
        &mut self,
        mutation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        let mutation_json = serde_json::to_string(&mutation)?;
        let local_row_json = local_row.as_ref().map(serde_json::to_string).transpose()?;
        self.apply_mutation_json(&mutation_json, local_row_json.as_deref())
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
            crdt_field_compaction_payload_for_worker_current(
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
            &receipt,
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

    fn worker_crdt_field_changed_row(
        &mut self,
        table: &str,
        row_id: &str,
        field: &str,
        client_commit_id: &str,
    ) -> Result<Option<SyncChangedRow>> {
        let field = self.open_crdt_field(CrdtFieldId::new(table, row_id, field))?;
        Ok(Some(crdt_field_changed_row_for_worker(
            &field,
            client_commit_id,
        )))
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

    fn worker_process_blob_upload_queue_json(&mut self) -> Result<Option<String>> {
        Ok(Some(serde_json::to_string(
            &self.process_blob_upload_queue()?,
        )?))
    }

    fn worker_blob_upload_queue_stats_json(&mut self) -> Result<Option<String>> {
        Ok(Some(serde_json::to_string(
            &self.blob_upload_queue_stats()?,
        )?))
    }

    fn worker_next_outbox_retry_at_ms(&mut self) -> Result<Option<i64>> {
        self.next_outbox_retry_at_ms()
    }

    fn worker_next_blob_upload_retry_at_ms(&mut self) -> Result<Option<i64>> {
        self.next_blob_upload_retry_at_ms()
    }
}

#[cfg(feature = "demo-todo-native-fixture")]
impl<T> SyncWorkerClientExt for SyncularClient<RusqliteStore, T>
where
    T: SyncTransport,
{
    fn apply_worker_mutation_json(
        &mut self,
        mutation_json: &str,
        local_row_json: Option<&str>,
    ) -> Result<String> {
        self.apply_mutation_json(mutation_json, local_row_json)
    }

    fn apply_worker_mutation(
        &mut self,
        mutation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        let mutation_json = serde_json::to_string(&mutation)?;
        let local_row_json = local_row.as_ref().map(serde_json::to_string).transpose()?;
        self.apply_mutation_json(&mutation_json, local_row_json.as_deref())
    }

    fn worker_current_row_json(&mut self, table: &str, row_id: &str) -> Result<Option<Value>> {
        self.current_row_json(table, row_id)
    }

    fn worker_next_outbox_retry_at_ms(&mut self) -> Result<Option<i64>> {
        self.next_outbox_retry_at_ms()
    }
}

pub struct SyncWorker {
    command_tx: SyncSender<WorkerCommand>,
    events: SyncWorkerEventHub,
    default_events: SyncWorkerEventSubscription,
    join: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct SyncWorkerEventHub {
    subscriber_seq: Arc<Mutex<u64>>,
    subscribers: Arc<Mutex<BTreeMap<u64, Arc<WorkerEventQueue>>>>,
}

pub struct SyncWorkerEventSubscription {
    hub: SyncWorkerEventHub,
    subscriber_id: u64,
    queue: Arc<WorkerEventQueue>,
}

struct WorkerEventQueue {
    capacity: usize,
    state: Mutex<WorkerEventQueueState>,
    ready: Condvar,
}

struct WorkerEventQueueState {
    events: VecDeque<SyncWorkerEvent>,
    closed: bool,
}

impl Default for SyncWorkerEventHub {
    fn default() -> Self {
        Self {
            subscriber_seq: Arc::new(Mutex::new(0)),
            subscribers: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

impl SyncWorkerEventSubscription {
    pub fn next_event(&self) -> Option<SyncWorkerEvent> {
        self.queue.next_event()
    }

    pub fn next_event_timeout(&self, timeout: Duration) -> Option<SyncWorkerEvent> {
        self.queue.next_event_timeout(timeout)
    }

    pub fn close(&self) {
        if let Ok(mut subscribers) = self.hub.subscribers.lock() {
            subscribers.remove(&self.subscriber_id);
        }
        self.queue.close();
    }
}

impl Drop for SyncWorkerEventSubscription {
    fn drop(&mut self) {
        self.close();
    }
}

impl SyncWorkerEventHub {
    fn subscribe(&self, capacity: usize) -> SyncWorkerEventSubscription {
        let queue = Arc::new(WorkerEventQueue::new(capacity));
        let subscriber_id = self.next_subscriber_id();
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(subscriber_id, queue.clone());
        }
        SyncWorkerEventSubscription {
            hub: self.clone(),
            subscriber_id,
            queue,
        }
    }

    fn publish_event(&self, event: SyncWorkerEvent) {
        let Ok(mut subscribers) = self.subscribers.lock() else {
            return;
        };

        subscribers.retain(|_, queue| {
            queue.push(event.clone());
            !queue.is_closed()
        });
    }

    fn close_all(&self) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            for queue in subscribers.values() {
                queue.close_after_drain();
            }
            subscribers.clear();
        }
    }

    fn next_subscriber_id(&self) -> u64 {
        if let Ok(mut seq) = self.subscriber_seq.lock() {
            *seq = seq.saturating_add(1);
            *seq
        } else {
            0
        }
    }
}

impl WorkerEventQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(WorkerEventQueueState {
                events: VecDeque::new(),
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn push(&self, event: SyncWorkerEvent) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        if state.events.len() >= self.capacity {
            let dropped_count = state.events.len().saturating_add(1);
            state.events.clear();
            state
                .events
                .push_back(SyncWorkerEvent::EventsOverflowed { dropped_count });
            state.closed = true;
        } else {
            state.events.push_back(event);
        }
        self.ready.notify_one();
    }

    fn next_event(&self) -> Option<SyncWorkerEvent> {
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

    fn next_event_timeout(&self, timeout: Duration) -> Option<SyncWorkerEvent> {
        let deadline = Instant::now().checked_add(timeout)?;
        let mut state = self.state.lock().ok()?;
        loop {
            if let Some(event) = state.events.pop_front() {
                return Some(event);
            }
            if state.closed {
                return None;
            }
            let now = Instant::now();
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

    fn close_after_drain(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.ready.notify_all();
        }
    }

    fn is_closed(&self) -> bool {
        self.state.lock().map(|state| state.closed).unwrap_or(true)
    }
}

struct CloseWorkerEventsOnDrop(SyncWorkerEventHub);

impl Drop for CloseWorkerEventsOnDrop {
    fn drop(&mut self) {
        self.0.close_all();
    }
}

enum WorkerWake {
    Command(WorkerCommand),
    FlushYjs,
    Retry,
}

#[derive(Clone)]
pub struct SyncWorkerTrigger {
    command_tx: SyncSender<WorkerCommand>,
}

pub struct PersistentRealtimeWorker {
    command_tx: SyncSender<RealtimeWorkerCommand>,
    join: Option<JoinHandle<()>>,
}

enum RealtimeWorkerCommand {
    Stop,
    SetAuthHeaders(SyncAuthHeaders),
    SendPresence {
        action: String,
        scope_key: String,
        metadata: Option<Value>,
    },
}

type RealtimeEventHandler = Arc<dyn Fn(RealtimeEvent) + Send + Sync>;

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

impl PersistentRealtimeWorker {
    pub fn start<T>(transport: T, trigger: SyncWorkerTrigger) -> Self
    where
        T: SyncTransport + SyncAuthHeaderStore + Send + 'static,
    {
        Self::start_with_event_handler(transport, trigger, None)
    }

    pub fn start_with_event_handler<T>(
        transport: T,
        trigger: SyncWorkerTrigger,
        event_handler: Option<RealtimeEventHandler>,
    ) -> Self
    where
        T: SyncTransport + SyncAuthHeaderStore + Send + 'static,
    {
        let (command_tx, command_rx) = mpsc::sync_channel(32);
        let join = thread::spawn(move || {
            run_persistent_realtime_worker(transport, trigger, command_rx, event_handler)
        });
        Self {
            command_tx,
            join: Some(join),
        }
    }

    pub fn set_auth_headers(&self, headers: SyncAuthHeaders) -> Result<()> {
        self.command_tx
            .try_send(RealtimeWorkerCommand::SetAuthHeaders(headers))
            .map_err(|err| match err {
                TrySendError::Full(_) => {
                    SyncularError::busy("realtime worker command queue is full")
                }
                TrySendError::Disconnected(_) => {
                    SyncularError::message(ErrorKind::Internal, "realtime worker is not running")
                }
            })
    }

    pub fn send_presence(
        &self,
        action: impl Into<String>,
        scope_key: impl Into<String>,
        metadata: Option<Value>,
    ) -> Result<()> {
        self.command_tx
            .try_send(RealtimeWorkerCommand::SendPresence {
                action: action.into(),
                scope_key: scope_key.into(),
                metadata,
            })
            .map_err(|err| match err {
                TrySendError::Full(_) => {
                    SyncularError::busy("realtime worker command queue is full")
                }
                TrySendError::Disconnected(_) => {
                    SyncularError::message(ErrorKind::Internal, "realtime worker is not running")
                }
            })
    }

    pub fn stop(&mut self) -> Result<()> {
        let _ = self.command_tx.send(RealtimeWorkerCommand::Stop);
        if let Some(join) = self.join.take() {
            join.join().map_err(|_| {
                SyncularError::message(ErrorKind::Internal, "realtime worker panicked")
            })?;
        }
        Ok(())
    }
}

impl Drop for PersistentRealtimeWorker {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn run_persistent_realtime_worker<T>(
    mut transport: T,
    trigger: SyncWorkerTrigger,
    command_rx: Receiver<RealtimeWorkerCommand>,
    event_handler: Option<RealtimeEventHandler>,
) where
    T: SyncTransport + SyncAuthHeaderStore,
{
    let mut reconnect_attempt: i32 = 0;
    let mut active_presence: BTreeMap<String, Option<Value>> = BTreeMap::new();
    loop {
        if drain_realtime_commands(&mut transport, None, &command_rx, &mut active_presence)
            .is_none()
        {
            return;
        }

        match transport.connect_realtime() {
            Ok(mut socket) => {
                reconnect_attempt = 0;
                rejoin_realtime_presence(&mut socket, &active_presence);
                if !run_connected_realtime_socket(
                    &mut transport,
                    &mut socket,
                    &trigger,
                    &command_rx,
                    &mut active_presence,
                    event_handler.as_deref(),
                ) {
                    return;
                }
            }
            Err(_) => {
                reconnect_attempt = reconnect_attempt.saturating_add(1);
            }
        }

        let delay =
            Duration::from_millis(retry_backoff_delay_ms(reconnect_attempt).max(250) as u64);
        match command_rx.recv_timeout(delay) {
            Ok(RealtimeWorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(RealtimeWorkerCommand::SetAuthHeaders(headers)) => {
                transport.set_auth_headers(headers);
                reconnect_attempt = 0;
            }
            Ok(RealtimeWorkerCommand::SendPresence {
                action,
                scope_key,
                metadata,
            }) => {
                apply_active_presence_command(&mut active_presence, &action, &scope_key, metadata);
                reconnect_attempt = 0;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn run_connected_realtime_socket<T>(
    transport: &mut T,
    socket: &mut T::Realtime,
    trigger: &SyncWorkerTrigger,
    command_rx: &Receiver<RealtimeWorkerCommand>,
    active_presence: &mut BTreeMap<String, Option<Value>>,
    event_handler: Option<&(dyn Fn(RealtimeEvent) + Send + Sync)>,
) -> bool
where
    T: SyncTransport + SyncAuthHeaderStore,
{
    loop {
        match drain_realtime_commands(transport, Some(&mut *socket), command_rx, active_presence) {
            Some(true) => {
                socket.close();
                return true;
            }
            Some(false) => {}
            None => {
                socket.close();
                return false;
            }
        }

        match socket.read_event() {
            Ok(Some(RealtimeEvent::Sync)) => {
                let _ = trigger.trigger_sync();
            }
            Ok(Some(event @ RealtimeEvent::Presence(_))) => {
                if let Some(handler) = event_handler {
                    handler(event);
                }
            }
            Ok(Some(RealtimeEvent::Other(_))) => {}
            Ok(None) => match command_rx.recv_timeout(Duration::from_millis(250)) {
                Ok(RealtimeWorkerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    socket.close();
                    return false;
                }
                Ok(RealtimeWorkerCommand::SetAuthHeaders(headers)) => {
                    transport.set_auth_headers(headers);
                    socket.close();
                    return true;
                }
                Ok(RealtimeWorkerCommand::SendPresence {
                    action,
                    scope_key,
                    metadata,
                }) => {
                    apply_active_presence_command(
                        active_presence,
                        &action,
                        &scope_key,
                        metadata.clone(),
                    );
                    let _ = socket.send_presence(&action, &scope_key, metadata.as_ref());
                }
                Err(RecvTimeoutError::Timeout) => {}
            },
            Err(_) => {
                socket.close();
                return true;
            }
        }
    }
}

fn drain_realtime_commands<T>(
    transport: &mut T,
    mut socket: Option<&mut T::Realtime>,
    command_rx: &Receiver<RealtimeWorkerCommand>,
    active_presence: &mut BTreeMap<String, Option<Value>>,
) -> Option<bool>
where
    T: SyncAuthHeaderStore + SyncTransport,
{
    let mut reconnect = false;
    loop {
        match command_rx.try_recv() {
            Ok(RealtimeWorkerCommand::Stop) | Err(mpsc::TryRecvError::Disconnected) => {
                return None;
            }
            Ok(RealtimeWorkerCommand::SetAuthHeaders(headers)) => {
                transport.set_auth_headers(headers);
                reconnect = true;
            }
            Ok(RealtimeWorkerCommand::SendPresence {
                action,
                scope_key,
                metadata,
            }) => {
                apply_active_presence_command(
                    active_presence,
                    &action,
                    &scope_key,
                    metadata.clone(),
                );
                if let Some(socket) = socket.as_deref_mut() {
                    let _ = socket.send_presence(&action, &scope_key, metadata.as_ref());
                }
            }
            Err(mpsc::TryRecvError::Empty) => return Some(reconnect),
        }
    }
}

fn apply_active_presence_command(
    active_presence: &mut BTreeMap<String, Option<Value>>,
    action: &str,
    scope_key: &str,
    metadata: Option<Value>,
) {
    match action {
        "leave" => {
            active_presence.remove(scope_key);
        }
        "join" | "update" => {
            active_presence.insert(scope_key.to_string(), metadata);
        }
        _ => {}
    }
}

fn rejoin_realtime_presence<T>(socket: &mut T, active_presence: &BTreeMap<String, Option<Value>>)
where
    T: RealtimeTransport,
{
    for (scope_key, metadata) in active_presence {
        let _ = socket.send_presence("join", scope_key, metadata.as_ref());
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
        let events = SyncWorkerEventHub::default();
        let default_events = events.subscribe(DEFAULT_EVENT_QUEUE_CAPACITY);
        let worker_events = events.clone();
        let join = thread::spawn(move || {
            let _close_events = CloseWorkerEventsOnDrop(worker_events.clone());
            let mut pending_yjs = BTreeMap::new();
            loop {
                let wake = if pending_yjs.is_empty() {
                    match next_retry_timeout(&mut client) {
                        Some(timeout) => match command_rx.recv_timeout(timeout) {
                            Ok(command) => WorkerWake::Command(command),
                            Err(RecvTimeoutError::Timeout) => WorkerWake::Retry,
                            Err(RecvTimeoutError::Disconnected) => return,
                        },
                        None => match command_rx.recv() {
                            Ok(command) => WorkerWake::Command(command),
                            Err(_) => return,
                        },
                    }
                } else {
                    match command_rx.recv_timeout(config.yjs_flush_window) {
                        Ok(command) => WorkerWake::Command(command),
                        Err(RecvTimeoutError::Timeout) => WorkerWake::FlushYjs,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                };

                match wake {
                    WorkerWake::FlushYjs => {
                        if flush_pending_yjs(&mut client, &mut pending_yjs, &worker_events) {
                            if !run_until_settled(
                                &mut client,
                                &command_rx,
                                &worker_events,
                                &mut pending_yjs,
                                None,
                                false,
                                WorkerSyncTransport::Http,
                            ) {
                                return;
                            }
                        }
                    }
                    WorkerWake::Retry => {
                        if !run_due_retry_work(
                            &mut client,
                            &command_rx,
                            &worker_events,
                            &mut pending_yjs,
                        ) {
                            return;
                        }
                    }
                    WorkerWake::Command(command) => {
                        if !handle_command(
                            &mut client,
                            &command_rx,
                            &worker_events,
                            &mut pending_yjs,
                            command,
                        ) {
                            return;
                        }
                    }
                }
            }
        });

        Self {
            command_tx,
            events,
            default_events,
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

    pub fn subscribe_events(&self, capacity: usize) -> SyncWorkerEventSubscription {
        self.events.subscribe(capacity)
    }

    pub fn event_source(&self) -> SyncWorkerEventSubscription {
        self.subscribe_events(DEFAULT_EVENT_QUEUE_CAPACITY)
    }

    pub fn enqueue_sync_now(&self, command_id: String) -> Result<()> {
        self.trigger_sync_inner(Some(command_id), true, WorkerSyncTransport::Http)
    }

    pub fn enqueue_sync_websocket(&self, command_id: String) -> Result<()> {
        self.trigger_sync_inner(Some(command_id), true, WorkerSyncTransport::WebSocket)
    }

    pub fn enqueue_mutation_json(
        &self,
        command_id: String,
        mutation_json: String,
        local_row_json: Option<String>,
        auto_sync: bool,
    ) -> Result<()> {
        self.try_send(WorkerCommand::ApplyMutationJson {
            command_id,
            mutation_json,
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

    pub fn enqueue_process_blob_upload_queue(&self, command_id: String) -> Result<()> {
        self.try_send(WorkerCommand::ProcessBlobUploadQueue { command_id })
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
        self.default_events.next_event_timeout(timeout)
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
    event_tx: &SyncWorkerEventHub,
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
        WorkerCommand::ApplyMutationJson {
            command_id,
            mutation_json,
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
            let should_sync = apply_mutation_json(
                client,
                event_tx,
                command_id,
                &mutation_json,
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
            if run_worker_json_command(client, event_tx, command_id, "storeBlobFile", |client| {
                client.worker_store_blob_file_json(&path, options_json.as_deref())
            }) {
                publish_blob_uploads_changed(client, event_tx);
            }
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
        WorkerCommand::ProcessBlobUploadQueue { command_id } => {
            if run_worker_json_command(
                client,
                event_tx,
                command_id,
                "processBlobUploadQueue",
                |client| {
                    client
                        .worker_process_blob_upload_queue_json()?
                        .ok_or_else(|| {
                            SyncularError::config(
                                "worker-owned blob upload queue processing is not available for this client",
                            )
                        })
                },
            ) {
                publish_blob_uploads_changed(client, event_tx);
            }
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

fn run_due_retry_work<S, T>(
    client: &mut SyncularClient<S, T>,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &SyncWorkerEventHub,
    pending_yjs: &mut BTreeMap<YjsBatchKey, PendingYjsBatch>,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport + SyncAuthHeaderStore,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    if due_now(client.worker_next_blob_upload_retry_at_ms()) {
        process_due_blob_upload_queue(client, event_tx);
    }

    if due_now(client.worker_next_outbox_retry_at_ms()) {
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

fn process_due_blob_upload_queue<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &SyncWorkerEventHub,
) where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let command_id = retry_wakeup_command_id("blob-retry");
    let started = Instant::now();
    match client.worker_process_blob_upload_queue_json() {
        Ok(Some(payload_json)) => {
            let payload_json = serde_json::from_str(&payload_json).ok();
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation: "processBlobUploadQueue",
                payload_json,
                duration_ms: duration_ms(started),
            });
            publish_blob_uploads_changed(client, event_tx);
        }
        Ok(None) => {}
        Err(error) => {
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandFailed {
                command_id,
                operation: "processBlobUploadQueue",
                error,
                duration_ms: duration_ms(started),
            });
        }
    }
}

fn run_until_settled<S, T>(
    client: &mut SyncularClient<S, T>,
    command_rx: &Receiver<WorkerCommand>,
    event_tx: &SyncWorkerEventHub,
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
                Ok(WorkerCommand::ApplyMutationJson {
                    command_id,
                    mutation_json,
                    local_row_json,
                    auto_sync,
                }) => {
                    if flush_pending_yjs(client, pending_yjs, event_tx) {
                        next_sync = Some((None, false, WorkerSyncTransport::Http));
                    }
                    if apply_mutation_json(
                        client,
                        event_tx,
                        command_id,
                        &mutation_json,
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
                    if run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "storeBlobFile",
                        |client| client.worker_store_blob_file_json(&path, options_json.as_deref()),
                    ) {
                        publish_blob_uploads_changed(client, event_tx);
                    }
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
                Ok(WorkerCommand::ProcessBlobUploadQueue { command_id }) => {
                    if run_worker_json_command(
                        client,
                        event_tx,
                        command_id,
                        "processBlobUploadQueue",
                        |client| {
                            client
                                .worker_process_blob_upload_queue_json()?
                                .ok_or_else(|| {
                                    SyncularError::config(
                                        "worker-owned blob upload queue processing is not available for this client",
                                    )
                                })
                        },
                    ) {
                        publish_blob_uploads_changed(client, event_tx);
                    }
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
    event_tx: &SyncWorkerEventHub,
    command_id: Option<String>,
    emit_started: bool,
    transport: WorkerSyncTransport,
) where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    if emit_started {
        let _ = event_tx.publish_event(SyncWorkerEvent::SyncStarted {
            command_id: command_id.clone(),
        });
    }

    let started = Instant::now();
    let result = match transport {
        WorkerSyncTransport::Http => client.sync_http(),
        WorkerSyncTransport::WebSocket => client.sync_ws(),
    };
    #[cfg(feature = "native")]
    let result = result.and_then(|report| {
        let bootstrap = client.bootstrap_status()?;
        Ok((report, bootstrap))
    });

    match result {
        #[cfg(feature = "native")]
        Ok((report, bootstrap)) => {
            let (outbox_count, conflict_count) = worker_counts(client).unwrap_or((0, 0));
            let _ = event_tx.publish_event(SyncWorkerEvent::SyncCompleted {
                command_id,
                report,
                bootstrap,
                outbox_count,
                conflict_count,
                duration_ms: duration_ms(started),
            });
        }
        #[cfg(not(feature = "native"))]
        Ok(report) => {
            let (outbox_count, conflict_count) = worker_counts(client).unwrap_or((0, 0));
            let _ = event_tx.publish_event(SyncWorkerEvent::SyncCompleted {
                command_id,
                report,
                outbox_count,
                conflict_count,
                duration_ms: duration_ms(started),
            });
        }
        Err(error) => {
            let retry_scheduled = retry_scheduled_after_error(client);
            let _ = event_tx.publish_event(SyncWorkerEvent::SyncFailed {
                command_id,
                error,
                retry_scheduled,
                duration_ms: duration_ms(started),
            });
        }
    }
}

fn apply_mutation_json<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &SyncWorkerEventHub,
    command_id: String,
    mutation_json: &str,
    local_row_json: Option<&str>,
    auto_sync: bool,
) -> bool
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let started = Instant::now();
    let mutation = serde_json::from_str::<SyncOperation>(mutation_json).ok();
    let table = mutation
        .as_ref()
        .map(|mutation| mutation.table.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let previous_row = mutation.as_ref().and_then(|mutation| {
        client
            .worker_current_row_json(&mutation.table, &mutation.row_id)
            .ok()
            .flatten()
    });
    let local_row = local_row_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .ok()
        .flatten();
    match client.apply_worker_mutation_json(mutation_json, local_row_json) {
        Ok(client_commit_id) => {
            let changed_rows = mutation
                .as_ref()
                .and_then(|mutation| {
                    sync_changed_row_for_local_operation(
                        client.app_schema(),
                        mutation,
                        previous_row.as_ref(),
                        local_row.as_ref(),
                        Some(client_commit_id.clone()),
                    )
                })
                .into_iter()
                .collect();
            let outbox_count = worker_outbox_count(client);
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteCommitted {
                command_id,
                client_commit_id,
                changed_tables: vec![table],
                changed_rows,
                outbox_count,
                duration_ms: duration_ms(started),
            });
            auto_sync
        }
        Err(error) => {
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
    event_tx: &SyncWorkerEventHub,
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
            let outbox_count = worker_outbox_count(client);
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                outbox_count,
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event.and_then(WorkerEncryptedCrdtRequest::field_identity) {
                let _ = event_tx.publish_event(SyncWorkerEvent::CrdtFieldChanged {
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
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
    event_tx: &SyncWorkerEventHub,
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
            let outbox_count = worker_outbox_count(client);
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                outbox_count,
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event.and_then(WorkerEncryptedCrdtRequest::field_identity) {
                let _ = event_tx.publish_event(SyncWorkerEvent::CrdtFieldCompacted {
                    command_id,
                    client_commit_id: Some(receipt.client_commit_id),
                    table: request.table,
                    row_id: request.row_id,
                    field: request.field,
                    changed_tables: receipt.changed_tables,
                    checkpoint_created: true,
                    payload_json: receipt.crdt_event_payload_json,
                    duration_ms: duration_ms(started),
                });
            }
            auto_sync
        }
        Ok(None) => {
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandCompleted {
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
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
    event_tx: &SyncWorkerEventHub,
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
            let outbox_count = worker_outbox_count(client);
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                outbox_count,
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event {
                let _ = event_tx.publish_event(SyncWorkerEvent::CrdtFieldChanged {
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
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
    event_tx: &SyncWorkerEventHub,
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
            let outbox_count = worker_outbox_count(client);
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteCommitted {
                command_id: command_id.clone(),
                client_commit_id: receipt.client_commit_id.clone(),
                changed_tables: receipt.changed_tables.clone(),
                changed_rows: receipt.changed_rows.clone(),
                outbox_count,
                duration_ms: duration_ms(started),
            });
            if let Some(request) = crdt_event {
                let _ = event_tx.publish_event(SyncWorkerEvent::CrdtFieldCompacted {
                    command_id,
                    client_commit_id: Some(receipt.client_commit_id),
                    table: request.table,
                    row_id: request.row_id,
                    field: request.field,
                    changed_tables: receipt.changed_tables,
                    checkpoint_created: true,
                    payload_json: receipt.crdt_event_payload_json,
                    duration_ms: duration_ms(started),
                });
            }
            auto_sync
        }
        Ok(None) => {
            let payload_json = compact_crdt_field_skipped_payload(client, request_json);
            let request = WorkerCrdtFieldCompactionRequest::from_json(request_json).ok();
            let compacted_server_merge_document = payload_json
                .get("syncMode")
                .and_then(Value::as_str)
                .is_some_and(|sync_mode| sync_mode == "server-merge");
            if compacted_server_merge_document {
                if let Some(request) = request {
                    let _ = event_tx.publish_event(SyncWorkerEvent::CrdtFieldCompacted {
                        command_id: command_id.clone(),
                        client_commit_id: None,
                        table: request.table.clone(),
                        row_id: request.row_id.clone(),
                        field: request.field.clone(),
                        changed_tables: vec![request.table],
                        checkpoint_created: false,
                        payload_json: Some(payload_json.clone()),
                        duration_ms: duration_ms(started),
                    });
                }
            }
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation: "compactCrdtField",
                payload_json: Some(payload_json),
                duration_ms: duration_ms(started),
            });
            false
        }
        Err(error) => {
            let payload_json = crdt_field_failure_payload_json("compactCrdtField", request_json);
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
    event_tx: &SyncWorkerEventHub,
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
            let _ = event_tx.publish_event(SyncWorkerEvent::ConflictResolutionCompleted {
                command_id,
                retry_client_commit_id,
                duration_ms: duration_ms(started),
            });
            should_sync
        }
        Err(error) => {
            let _ = event_tx.publish_event(SyncWorkerEvent::ConflictResolutionFailed {
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
    event_tx: &SyncWorkerEventHub,
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
            let _ = event_tx.publish_event(SyncWorkerEvent::SnapshotReady {
                command_id,
                payload_json,
                duration_ms: duration_ms(started),
            });
        }
        Err(error) => {
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandFailed {
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
    event_tx: &SyncWorkerEventHub,
    command_id: String,
    operation: &'static str,
    f: impl FnOnce(&mut SyncularClient<S, T>) -> Result<String>,
) -> bool
where
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
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandCompleted {
                command_id,
                operation,
                payload_json,
                duration_ms: duration_ms(started),
            });
            true
        }
        Err(error) => {
            let _ = event_tx.publish_event(SyncWorkerEvent::WorkerCommandFailed {
                command_id,
                operation,
                error,
                duration_ms: duration_ms(started),
            });
            false
        }
    }
}

fn publish_blob_uploads_changed<S, T>(
    client: &mut SyncularClient<S, T>,
    event_tx: &SyncWorkerEventHub,
) where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let Ok(Some(stats_json)) = client.worker_blob_upload_queue_stats_json() else {
        return;
    };
    let Ok(stats_json) = serde_json::from_str::<Value>(&stats_json) else {
        return;
    };
    let _ = event_tx.publish_event(SyncWorkerEvent::BlobUploadsChanged { stats_json });
}

fn queue_yjs_update_json(
    pending_yjs: &mut BTreeMap<YjsBatchKey, PendingYjsBatch>,
    event_tx: &SyncWorkerEventHub,
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
            let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
    event_tx: &SyncWorkerEventHub,
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
                        let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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
        let mutation = SyncOperation {
            table: key.table.clone(),
            row_id: key.row_id.clone(),
            op: "upsert".to_string(),
            payload: Some(payload),
            base_version: None,
        };
        match client.apply_worker_mutation(mutation, batch.materialized) {
            Ok(client_commit_id) => {
                should_sync |= batch.auto_sync;
                let crdt_event_payload_json = client
                    .worker_crdt_field_event_payload_json(&key.table, &key.row_id, &key.field)
                    .ok()
                    .flatten();
                let outbox_count = worker_outbox_count(client);
                let changed_rows = client
                    .worker_crdt_field_changed_row(
                        &key.table,
                        &key.row_id,
                        &key.field,
                        &client_commit_id,
                    )
                    .ok()
                    .flatten()
                    .map(|row| vec![row])
                    .unwrap_or_else(|| {
                        vec![SyncChangedRow {
                            table: key.table.clone(),
                            row_id: Some(key.row_id.clone()),
                            operation: "update".to_string(),
                            changed_fields: vec![key.field.clone()],
                            crdt_fields: vec![key.field.clone()],
                            crdt_field_changes: Vec::new(),
                            commit_id: Some(client_commit_id.clone()),
                            commit_seq: None,
                            subscription_id: None,
                            server_version: None,
                        }]
                    });
                for command_id in batch.command_ids {
                    let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteCommitted {
                        command_id: command_id.clone(),
                        client_commit_id: client_commit_id.clone(),
                        changed_tables: vec![key.table.clone()],
                        changed_rows: changed_rows.clone(),
                        outbox_count,
                        duration_ms: duration_ms(started),
                    });
                    let _ = event_tx.publish_event(SyncWorkerEvent::CrdtFieldChanged {
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
                    let _ = event_tx.publish_event(SyncWorkerEvent::LocalWriteFailed {
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

fn worker_outbox_count<S, T>(client: &mut SyncularClient<S, T>) -> usize
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
{
    worker_counts(client)
        .map(|(outbox_count, _)| outbox_count)
        .unwrap_or(0)
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

fn next_retry_timeout<S, T>(client: &mut SyncularClient<S, T>) -> Option<Duration>
where
    S: SyncStore + SyncStateStore,
    T: SyncTransport,
    SyncularClient<S, T>: SyncWorkerClientExt,
{
    let next = [
        client.worker_next_outbox_retry_at_ms().ok().flatten(),
        client.worker_next_blob_upload_retry_at_ms().ok().flatten(),
    ]
    .into_iter()
    .flatten()
    .min()?;
    Some(duration_until_ms(next))
}

fn due_now(next: Result<Option<i64>>) -> bool {
    next.ok()
        .flatten()
        .is_some_and(|next_attempt_at| next_attempt_at <= now_ms())
}

fn duration_until_ms(timestamp_ms: i64) -> Duration {
    let now = now_ms();
    if timestamp_ms <= now {
        Duration::ZERO
    } else {
        Duration::from_millis((timestamp_ms - now) as u64)
    }
}

fn retry_wakeup_command_id(prefix: &str) -> String {
    format!("{prefix}-{}", now_ms())
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
    let crdt_field_changes = vec![sync_changed_crdt_field_from_metadata(
        field.field_metadata(),
    )];
    SyncChangedRow {
        table: field.table().to_string(),
        row_id: Some(field.row_id().to_string()),
        operation: "update".to_string(),
        changed_fields: vec![field.field().to_string(), field.state_column().to_string()],
        crdt_fields: crdt_field_changes
            .iter()
            .map(|field| field.state_column.clone())
            .collect(),
        crdt_field_changes,
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
    receipt: &CrdtFieldCompactionReceipt,
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

#[cfg(feature = "native")]
fn crdt_field_compaction_payload_for_worker_current<T>(
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
