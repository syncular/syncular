use crate::crdt_yjs::{
    apply_yjs_envelope_to_payload_json, apply_yjs_text_updates_json, build_yjs_text_update_json,
    materialize_yjs_row_json,
};
use crate::encryption::encryption_helpers_json;
use crate::native::{
    native_runtime_manifest_json, NativeClientConfig, NativeClientOptions, NativeSyncularClient,
};
use boltffi::{data, export};
use std::sync::Mutex;
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
    pub auto_sync_local_writes: bool,
}

pub struct SyncularBoltClient {
    inner: Mutex<NativeSyncularClient>,
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

    pub fn runtime_manifest_json(&self) -> Result<String, String> {
        syncular_runtime_manifest_json()
    }

    pub fn set_auth_headers_json(&self, headers_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_auth_headers_json(headers_json).map(|_| true))
    }

    pub fn set_field_encryption_json(&self, config_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_field_encryption_json(config_json).map(|_| true))
    }

    pub fn set_encrypted_crdt_json(&self, config_json: &str) -> Result<bool, String> {
        self.with_client_mut(|client| client.set_encrypted_crdt_json(config_json).map(|_| true))
    }

    pub fn trigger_sync(&self) -> Result<bool, String> {
        self.with_client(|client| client.trigger_sync().map(|_| true))
    }

    pub fn enqueue_sync_now(&self) -> Result<String, String> {
        self.with_client(|client| client.enqueue_sync_now())
    }

    pub fn pause_sync_worker(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.pause_sync_worker().map(|_| true))
    }

    pub fn resume_sync_worker(&self) -> Result<bool, String> {
        self.with_client_mut(|client| client.resume_sync_worker().map(|_| true))
    }

    pub fn sync_worker_running(&self) -> Result<bool, String> {
        self.with_client(|client| Ok(client.sync_worker_running()))
    }

    pub fn poll_event_json_timeout(&self, timeout_ms: u64) -> Result<Option<String>, String> {
        self.with_client(|client| {
            client
                .poll_event_json_timeout(Duration::from_millis(timeout_ms))
                .transpose()
        })
    }

    pub fn apply_local_operation_json(
        &self,
        operation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client_mut(|client| {
            client.apply_local_operation_json(operation_json, local_row_json.as_deref())
        })
    }

    pub fn enqueue_local_operation_json(
        &self,
        operation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| {
            client.enqueue_local_operation_json(operation_json, local_row_json.as_deref())
        })
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

    pub fn enqueue_mutation_json(
        &self,
        mutation_json: &str,
        local_row_json: Option<String>,
    ) -> Result<String, String> {
        self.with_client(|client| {
            client.enqueue_mutation_json(mutation_json, local_row_json.as_deref())
        })
    }

    pub fn enqueue_yjs_update_json(&self, update_json: &str) -> Result<String, String> {
        self.with_client(|client| client.enqueue_yjs_update_json(update_json))
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

    pub fn register_query_json(&self, query_json: &str) -> Result<String, String> {
        self.with_client(|client| client.register_query_json(query_json))
    }

    pub fn unregister_query(&self, id: &str) -> Result<bool, String> {
        self.with_client(|client| client.unregister_query(id).map(|_| true))
    }

    pub fn observed_queries_json(&self) -> Result<String, String> {
        self.with_client(|client| client.observed_queries_json())
    }

    pub fn outbox_summaries_json(&self) -> Result<String, String> {
        self.with_client_mut(|client| client.outbox_summaries_json())
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
        self.with_client_mut(|client| client.close().map(|_| true))
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
            inner: Mutex::new(client),
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
        f(&client).map_err(binding_error)
    }

    fn with_client_mut<T>(
        &self,
        f: impl FnOnce(&mut NativeSyncularClient) -> crate::error::Result<T>,
    ) -> Result<T, String> {
        let mut client = self
            .inner
            .lock()
            .map_err(|_| "syncular native client mutex is poisoned".to_string())?;
        f(&mut client).map_err(binding_error)
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
