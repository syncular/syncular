use crate::crdt_yjs::{
    apply_yjs_envelope_to_payload_json, apply_yjs_text_updates_json, build_yjs_text_update_json,
    materialize_yjs_row_json,
};
use crate::encryption::encryption_helpers_json;
use crate::native::{
    native_runtime_manifest_json, NativeClientConfig, NativeClientOpenTask, NativeClientOptions,
    NativeEventSubscription, NativeSyncularClient,
};
use boltffi::{data, export};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static LAST_OPEN_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[data]
#[derive(Clone)]
pub struct SyncularBoltClientConfig {
    pub db_path: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
    pub app_schema_json: Option<String>,
    pub auto_sync_local_writes: bool,
}

pub struct SyncularBoltClient {
    inner: Mutex<SyncularBoltClientInner>,
    events: Mutex<Option<Arc<NativeEventSubscription>>>,
}

enum SyncularBoltClientInner {
    Opening(NativeClientOpenTask),
    Ready(NativeSyncularClient),
}

#[export]
pub fn syncular_runtime_manifest_json() -> Result<String, String> {
    native_runtime_manifest_json().map_err(binding_error)
}

#[export]
pub fn syncular_take_last_open_error() -> Option<String> {
    take_last_open_error()
}

#[export]
pub fn syncular_yjs_build_text_update_json(args_json: &str) -> Result<String, String> {
    build_yjs_text_update_json(args_json).map_err(binding_error)
}

#[export]
pub fn syncular_yjs_apply_text_updates_json(args_json: &str) -> Result<String, String> {
    apply_yjs_text_updates_json(args_json).map_err(binding_error)
}

#[export]
pub fn syncular_yjs_apply_envelope_to_payload_json(args_json: &str) -> Result<String, String> {
    apply_yjs_envelope_to_payload_json(args_json).map_err(binding_error)
}

#[export]
pub fn syncular_yjs_materialize_row_json(args_json: &str) -> Result<String, String> {
    materialize_yjs_row_json(args_json).map_err(binding_error)
}

#[export]
pub fn syncular_encryption_helper_json(method: &str, args_json: &str) -> Result<String, String> {
    encryption_helpers_json(method, args_json).map_err(binding_error)
}

#[export]
impl SyncularBoltClient {
    pub fn open(config: SyncularBoltClientConfig) -> Result<Self, String> {
        match Self::open_from_config(config) {
            Ok(client) => {
                set_last_open_error(None);
                Ok(client)
            }
            Err(error) => {
                set_last_open_error(Some(error.clone()));
                Err(error)
            }
        }
    }

    pub fn open_async(config: SyncularBoltClientConfig) -> Result<Self, String> {
        let options = NativeClientOptions {
            auto_sync_local_writes: config.auto_sync_local_writes,
        };
        let task = NativeSyncularClient::open_native_async_with_options(config.into(), options);
        set_last_open_error(None);
        Ok(Self {
            inner: Mutex::new(SyncularBoltClientInner::Opening(task)),
            events: Mutex::new(None),
        })
    }

    pub fn open_command_id(&self) -> Result<Option<String>, String> {
        let client = self
            .inner
            .lock()
            .map_err(|_| "syncular native client mutex is poisoned".to_string())?;
        match &*client {
            SyncularBoltClientInner::Opening(task) => Ok(Some(task.command_id().to_string())),
            SyncularBoltClientInner::Ready(_) => Ok(None),
        }
    }

    pub fn is_open_finished(&self) -> Result<bool, String> {
        let mut client = self
            .inner
            .lock()
            .map_err(|_| "syncular native client mutex is poisoned".to_string())?;
        match &mut *client {
            SyncularBoltClientInner::Opening(task) => Ok(task.is_finished()),
            SyncularBoltClientInner::Ready(_) => Ok(true),
        }
    }

    pub fn finish_open_timeout(&self, timeout_ms: u64) -> Result<bool, String> {
        let mut client = self
            .inner
            .lock()
            .map_err(|_| "syncular native client mutex is poisoned".to_string())?;
        let SyncularBoltClientInner::Opening(task) = &mut *client else {
            return Ok(true);
        };
        match task.take_client_timeout(Duration::from_millis(timeout_ms)) {
            Some(Ok(ready)) => {
                *client = SyncularBoltClientInner::Ready(ready);
                set_last_open_error(None);
                Ok(true)
            }
            Some(Err(error)) => {
                let error = binding_error(error);
                set_last_open_error(Some(error.clone()));
                Err(error)
            }
            None => Ok(false),
        }
    }

    pub fn runtime_manifest_json(&self) -> Result<String, String> {
        syncular_runtime_manifest_json()
    }

    pub fn set_auth_headers_json(&self, headers_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_auth_headers_json(headers_json).map(|_| true))
    }

    pub fn set_subscriptions_json(&self, subscriptions_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| {
            client
                .set_subscriptions_json(subscriptions_json)
                .map(|_| true)
        })
    }

    pub fn force_subscriptions_bootstrap_json(
        &self,
        subscription_ids_json: &str,
    ) -> Result<String, String> {
        self.with_client_mut(|client| {
            client.force_subscriptions_bootstrap_json(subscription_ids_json)
        })
    }

    pub fn reset_local_sync_state_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.reset_local_sync_state_json(request_json))
    }

    pub fn set_field_encryption_json(&self, config_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_field_encryption_json(config_json).map(|_| true))
    }

    pub fn set_encrypted_crdt_json(&self, config_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_encrypted_crdt_json(config_json).map(|_| true))
    }

    pub fn set_blob_encryption_json(&self, config_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_blob_encryption_json(config_json).map(|_| true))
    }

    pub fn trigger_sync(&self) -> Result<bool, String> {
        self.with_client(|client| client.trigger_sync().map(|_| true))
    }

    pub fn trigger_sync_websocket(&self) -> Result<bool, String> {
        self.with_client(|client| client.trigger_sync_websocket().map(|_| true))
    }

    pub fn enqueue_sync_now(&self) -> Result<String, String> {
        self.with_client(|client| client.enqueue_sync_now())
    }

    pub fn enqueue_sync_websocket(&self) -> Result<String, String> {
        self.with_client(|client| client.enqueue_sync_websocket())
    }

    pub fn pause_sync_worker(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.pause_sync_worker().map(|_| true))
    }

    pub fn resume_sync_worker(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.resume_sync_worker().map(|_| true))
    }

    pub fn resume_from_background(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.resume_from_background())
    }

    pub fn sync_worker_running(&self) -> Result<bool, String> {
        self.with_client(|client| Ok(client.sync_worker_running()))
    }

    pub fn start_realtime_worker(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.start_realtime_worker().map(|_| true))
    }

    pub fn start(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.start().map(|_| true))
    }

    pub fn stop_realtime_worker(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.stop_realtime_worker().map(|_| true))
    }

    pub fn stop(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.stop().map(|_| true))
    }

    pub fn join_presence(
        &self,
        scope_key: &str,
        metadata_json: Option<String>,
    ) -> Result<bool, String> {
        self.with_client_mut(|client| {
            let metadata = metadata_json
                .map(|json| serde_json::from_str(&json))
                .transpose()?;
            client.join_presence(scope_key, metadata).map(|_| true)
        })
    }

    pub fn leave_presence(&self, scope_key: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.leave_presence(scope_key).map(|_| true))
    }

    pub fn update_presence_metadata(
        &self,
        scope_key: &str,
        metadata_json: &str,
    ) -> Result<bool, String> {
        self.with_client_mut(|client| {
            let metadata = serde_json::from_str(metadata_json)?;
            client
                .update_presence_metadata(scope_key, metadata)
                .map(|_| true)
        })
    }

    pub fn presence_json(&self, scope_key: &str) -> Result<String, String> {
        self.with_client(|client| client.presence_json(scope_key))
    }

    pub fn start_event_stream(&self, capacity: u64) -> Result<bool, String> {
        let subscription =
            Arc::new(self.with_client(|client| Ok(client.subscribe_events(capacity as usize)))?);
        let mut events = self
            .events
            .lock()
            .map_err(|_| "syncular event stream mutex is poisoned".to_string())?;
        if let Some(previous) = events.replace(subscription) {
            previous.close();
        }
        Ok(true)
    }

    pub fn next_event_json(&self) -> Result<Option<String>, String> {
        let subscription = self
            .events
            .lock()
            .map_err(|_| "syncular event stream mutex is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "syncular event stream is not started".to_string())?;
        subscription
            .next_event_json()
            .transpose()
            .map_err(binding_error)
    }

    pub fn next_event_json_timeout(&self, timeout_ms: u64) -> Result<Option<String>, String> {
        let subscription = self
            .events
            .lock()
            .map_err(|_| "syncular event stream mutex is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "syncular event stream is not started".to_string())?;
        subscription
            .next_event_json_timeout(Duration::from_millis(timeout_ms))
            .transpose()
            .map_err(binding_error)
    }

    pub fn close_event_stream(&self) -> Result<bool, String> {
        let subscription = self
            .events
            .lock()
            .map_err(|_| "syncular event stream mutex is poisoned".to_string())?
            .take();
        if let Some(subscription) = subscription {
            subscription.close();
        }
        Ok(true)
    }

    pub fn apply_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client_mut(|client| {
            client.apply_mutation_json(mutation_json, local_row_json.as_deref())
        })
    }

    pub fn apply_leased_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client_mut(|client| {
            client.apply_leased_mutation_json(mutation_json, local_row_json.as_deref())
        })
    }

    pub fn enqueue_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| {
            client.enqueue_mutation_json(mutation_json, local_row_json.as_deref())
        })
    }

    pub fn enqueue_leased_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| {
            client.enqueue_leased_mutation_json(mutation_json, local_row_json.as_deref())
        })
    }

    pub fn enqueue_yjs_update_json(&self, update_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_yjs_update_json(update_json))
    }

    pub fn open_crdt_field_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.open_crdt_field_json(request_json))
    }

    pub fn apply_crdt_field_text_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.apply_crdt_field_text_json(request_json))
    }

    pub fn apply_crdt_field_yjs_update_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.apply_crdt_field_yjs_update_json(request_json))
    }

    pub fn enqueue_crdt_field_yjs_update_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_crdt_field_yjs_update_json(request_json))
    }

    pub fn enqueue_crdt_field_text_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_crdt_field_text_json(request_json))
    }

    pub fn enqueue_crdt_field_compaction_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_crdt_field_compaction_json(request_json))
    }

    pub fn materialize_crdt_field_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.materialize_crdt_field_json(request_json))
    }

    pub fn crdt_document_snapshot_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.crdt_document_snapshot_json(request_json))
    }

    pub fn crdt_update_log_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.crdt_update_log_json(request_json))
    }

    pub fn snapshot_crdt_field_state_vector_json(
        &self,
        request_json: &str,
    ) -> Result<String, String> {
        self.with_client_mut(|client| client.snapshot_crdt_field_state_vector_json(request_json))
    }

    pub fn compact_crdt_field_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.compact_crdt_field_json(request_json))
    }

    pub fn apply_encrypted_crdt_update_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.apply_encrypted_crdt_update_json(request_json))
    }

    pub fn enqueue_encrypted_crdt_update_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_encrypted_crdt_update_json(request_json))
    }

    pub fn apply_encrypted_crdt_checkpoint_json(
        &self,
        request_json: &str,
    ) -> Result<String, String> {
        self.with_client_mut(|client| client.apply_encrypted_crdt_checkpoint_json(request_json))
    }

    pub fn enqueue_encrypted_crdt_checkpoint_json(
        &self,
        request_json: &str,
    ) -> Result<String, String> {
        self.with_client(|client| client.enqueue_encrypted_crdt_checkpoint_json(request_json))
    }

    pub fn list_table_json(&self, table: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.list_table_json(table))
    }

    pub fn query_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.query_json(request_json))
    }

    pub fn enqueue_refresh_snapshot_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_refresh_snapshot_json(request_json))
    }

    pub fn store_blob_file_json(
        &self,
        path: &str,
        options_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client_mut(|client| client.store_blob_file_json(path, options_json.as_deref()))
    }

    pub fn enqueue_store_blob_file_json(
        &self,
        path: &str,
        options_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| {
            client.enqueue_store_blob_file_json(path, options_json.as_deref())
        })
    }

    pub fn retrieve_blob_file_json(
        &self,
        ref_json: &str,
        path: &str,
        options_json: Option<String>,
    ) -> Result<bool, String> {
        self.with_client_mut(|client| {
            client
                .retrieve_blob_file_with_options(ref_json, path, options_json.as_deref())
                .map(|_| true)
        })
    }

    pub fn enqueue_retrieve_blob_file_json(
        &self,
        ref_json: &str,
        path: &str,
        options_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| {
            client.enqueue_retrieve_blob_file_json(ref_json, path, options_json.as_deref())
        })
    }

    pub fn is_blob_local(&self, hash: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.is_blob_local(hash))
    }

    pub fn process_blob_upload_queue_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.process_blob_upload_queue_json())
    }

    pub fn enqueue_process_blob_upload_queue(&self) -> Result<String, String> {
        self.with_client(|client| client.enqueue_process_blob_upload_queue())
    }

    pub fn blob_upload_queue_stats_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.blob_upload_queue_stats_json())
    }

    pub fn blob_cache_stats_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.blob_cache_stats_json())
    }

    pub fn prune_blob_cache(&self, max_bytes: i64) -> Result<i64, String> {
        self.with_client_mut(|client| client.prune_blob_cache(max_bytes))
    }

    pub fn enqueue_prune_blob_cache(&self, max_bytes: i64) -> Result<String, String> {
        self.with_client(|client| client.enqueue_prune_blob_cache(max_bytes))
    }

    pub fn clear_blob_cache(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.clear_blob_cache().map(|_| true))
    }

    pub fn enqueue_clear_blob_cache(&self) -> Result<String, String> {
        self.with_client(|client| client.enqueue_clear_blob_cache())
    }

    pub fn compact_storage_json(&self, options_json: Option<String>) -> Result<String, String> {
        self.with_client_mut(|client| client.compact_storage_json(options_json.as_deref()))
    }

    pub fn enqueue_compact_storage_json(
        &self,
        options_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| client.enqueue_compact_storage_json(options_json.as_deref()))
    }

    pub fn app_tables_json(&self) -> Result<String, String> {
        self.with_client(|client| client.app_tables_json())
    }

    pub fn app_table_metadata_json(&self) -> Result<String, String> {
        self.with_client(|client| client.app_table_metadata_json())
    }

    pub fn app_schema_state_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.app_schema_state_json())
    }

    pub fn register_query_json(&self, query_json: &str) -> Result<String, String> {
        self.with_client(|client| client.register_query_json(query_json))
    }

    pub fn unregister_query(&self, id: &str) -> Result<bool, String> {
        self.with_client(|client| client.unregister_query(id).map(|_| true))
    }

    pub fn observed_queries_json(&self) -> Result<String, String> {
        self.with_client(|client| client.observed_queries_json())
    }

    pub fn diagnostic_snapshot_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.diagnostic_snapshot_json())
    }

    pub fn local_health_check_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.local_health_check_json())
    }

    pub fn export_local_support_bundle_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.export_local_support_bundle_json())
    }

    pub fn import_local_support_bundle_json(&self, bundle_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.import_local_support_bundle_json(bundle_json))
    }

    pub fn repair_local_health_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.repair_local_health_json(request_json))
    }

    pub fn outbox_summaries_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.outbox_summaries_json())
    }

    pub fn upsert_auth_lease_json(&self, lease_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.upsert_auth_lease_json(lease_json).map(|_| true))
    }

    pub fn issue_auth_lease_json(&self, request_json: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.issue_auth_lease_json(request_json))
    }

    pub fn auth_lease_json(&self, lease_id: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.auth_lease_json(lease_id))
    }

    pub fn active_auth_leases_json(
        &self,
        actor_id: Option<String>,
        now_ms: i64,
    ) -> Result<String, String> {
        self.with_client_mut(|client| client.active_auth_leases_json(actor_id.as_deref(), now_ms))
    }

    pub fn set_outbox_auth_lease_json(
        &self,
        client_commit_id: &str,
        provenance_json: Option<String>,
    ) -> Result<bool, String> {
        self.with_client_mut(|client| {
            client
                .set_outbox_auth_lease_json(client_commit_id, provenance_json.as_deref())
                .map(|_| true)
        })
    }

    pub fn conflict_summaries_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.conflict_summaries_json())
    }

    pub fn resolve_conflict(&self, id: &str, resolution: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.resolve_conflict(id, resolution).map(|_| true))
    }

    pub fn enqueue_resolve_conflict(&self, id: &str, resolution: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_resolve_conflict(id, resolution))
    }

    pub fn retry_conflict_keep_local(&self, id: &str) -> Result<String, String> {
        self.with_client_mut(|client| client.retry_conflict_keep_local(id))
    }

    pub fn shutdown(&self) -> Result<bool, String> {
        let _ = self.close_event_stream();
        self.with_client_mut(|client| client.shutdown().map(|_| true))
    }
}

impl SyncularBoltClient {
    fn open_from_config(config: SyncularBoltClientConfig) -> Result<Self, String> {
        let options = NativeClientOptions {
            auto_sync_local_writes: config.auto_sync_local_writes,
        };
        let client = NativeSyncularClient::open_native_with_options(config.into(), options)
            .map_err(binding_error)?;
        Ok(Self {
            inner: Mutex::new(SyncularBoltClientInner::Ready(client)),
            events: Mutex::new(None),
        })
    }

    fn with_client<T>(
        &self,
        f: impl FnOnce(&NativeSyncularClient) -> crate::error::Result<T>,
    ) -> Result<T, String> {
        let client = self
            .inner
            .lock()
            .map_err(|_| "syncular native client mutex is poisoned".to_string())?;
        match &*client {
            SyncularBoltClientInner::Ready(client) => f(client).map_err(binding_error),
            SyncularBoltClientInner::Opening(task) => Err(format!(
                "syncular native client open is still running ({})",
                task.command_id()
            )),
        }
    }

    fn with_client_mut<T>(
        &self,
        f: impl FnOnce(&mut NativeSyncularClient) -> crate::error::Result<T>,
    ) -> Result<T, String> {
        let mut client = self
            .inner
            .lock()
            .map_err(|_| "syncular native client mutex is poisoned".to_string())?;
        match &mut *client {
            SyncularBoltClientInner::Ready(client) => f(client).map_err(binding_error),
            SyncularBoltClientInner::Opening(task) => Err(format!(
                "syncular native client open is still running ({})",
                task.command_id()
            )),
        }
    }
}

impl From<SyncularBoltClientConfig> for NativeClientConfig {
    fn from(config: SyncularBoltClientConfig) -> Self {
        Self {
            db_path: config.db_path,
            base_url: config.base_url,
            client_id: config.client_id,
            actor_id: config.actor_id,
            project_id: config.project_id,
            app_schema_json: config.app_schema_json,
        }
    }
}

fn binding_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn set_last_open_error(error: Option<String>) {
    if let Ok(mut last_error) = LAST_OPEN_ERROR.lock() {
        *last_error = error;
    }
}

fn take_last_open_error() -> Option<String> {
    LAST_OPEN_ERROR
        .lock()
        .ok()
        .and_then(|mut last_error| last_error.take())
}
