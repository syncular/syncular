use crate::client::SubscriptionSpec;
use crate::encryption::encryption_helpers_json;
use crate::error::SyncularError;
use crate::protocol::SyncOperation;
use crate::transport::web::{WebSyncTransport, WebSyncTransportConfig};
use crate::transport::SyncAuthHeaders;
use crate::web_client::{WebSyncPullOptions, WebSyncularClient, WebSyncularClientConfig};
use crate::web_host_store::{WebHostLocalOperation, WebHostStore};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmClientConfig {
    base_url: String,
    client_id: String,
    actor_id: String,
    project_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_pull_options")]
    pull: WebSyncPullOptions,
}

fn deserialize_pull_options<'de, D>(
    deserializer: D,
) -> std::result::Result<WebSyncPullOptions, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<WebSyncPullOptions>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmLocalOperationBatchEntry {
    operation: SyncOperation,
    local_row: Option<Value>,
}

#[wasm_bindgen(js_name = SyncularWasmClient)]
pub struct SyncularWasmClient {
    inner: WebSyncularClient<WebSyncTransport, WebHostStore>,
}

#[wasm_bindgen(js_class = SyncularWasmClient)]
impl SyncularWasmClient {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue, host_store: JsValue) -> std::result::Result<Self, JsValue> {
        let config: WasmClientConfig = serde_wasm_bindgen::from_value(config)
            .map_err(|err| JsValue::from_str(&format!("decode browser client config: {err}")))?;
        let store = WebHostStore::new(host_store).map_err(error_to_js)?;
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

    #[wasm_bindgen(js_name = syncPushJson)]
    pub async fn sync_push_json(&mut self) -> std::result::Result<String, JsValue> {
        self.inner.sync_push_json().await.map_err(error_to_js)
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

    #[wasm_bindgen(js_name = applyLocalOperationJson)]
    pub async fn apply_local_operation_json(
        &mut self,
        operation_json: &str,
        local_row_json: Option<String>,
    ) -> std::result::Result<String, JsValue> {
        self.inner
            .apply_local_operation_json(operation_json, local_row_json.as_deref())
            .await
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyLocalOperationsBatchJson)]
    pub async fn apply_local_operations_batch_json(
        &mut self,
        operations_json: &str,
    ) -> std::result::Result<String, JsValue> {
        let operations: Vec<WasmLocalOperationBatchEntry> = serde_json::from_str(operations_json)
            .map_err(|err| {
            JsValue::from_str(&format!("decode local operations batch: {err}"))
        })?;
        let operations = operations
            .into_iter()
            .map(|entry| WebHostLocalOperation {
                operation: entry.operation,
                local_row: entry.local_row,
            })
            .collect::<Vec<_>>();
        self.inner
            .store_mut()
            .apply_local_operations_batch(&operations)
            .await
            .and_then(|client_commit_ids| Ok(serde_json::to_string(&client_commit_ids)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = applyLocalOperationsCommitJson)]
    pub async fn apply_local_operations_commit_json(
        &mut self,
        operations_json: &str,
    ) -> std::result::Result<String, JsValue> {
        let operations: Vec<WasmLocalOperationBatchEntry> = serde_json::from_str(operations_json)
            .map_err(|err| {
            JsValue::from_str(&format!("decode local operations commit: {err}"))
        })?;
        let operations = operations
            .into_iter()
            .map(|entry| WebHostLocalOperation {
                operation: entry.operation,
                local_row: entry.local_row,
            })
            .collect::<Vec<_>>();
        self.inner
            .store_mut()
            .apply_local_operations_commit(&operations)
            .await
            .and_then(|client_commit_id| Ok(serde_json::to_string(&client_commit_id)?))
            .map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = setSubscriptionsJson)]
    pub fn set_subscriptions_json(
        &mut self,
        subscriptions_json: &str,
    ) -> std::result::Result<(), JsValue> {
        let subscriptions: Vec<SubscriptionSpec> = serde_json::from_str(subscriptions_json)
            .map_err(|err| JsValue::from_str(&format!("decode subscriptions: {err}")))?;
        self.inner.set_subscriptions(subscriptions);
        Ok(())
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
