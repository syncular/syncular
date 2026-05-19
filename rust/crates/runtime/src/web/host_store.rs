use crate::error::{ErrorKind, Result, SyncularError};
use crate::protocol::{
    OperationResult, PushCommitResponse, ScopeValues, SyncChange, SyncOperation,
};
use crate::store::{ConflictSummary, OutboxCommit};
use crate::web_store::{AsyncWebStore, WebSubscriptionState};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

/// Browser store adapter backed by JavaScript.
///
/// This keeps the Rust browser client independent from a specific durable
/// storage choice. The host object can be implemented with OPFS sqlite-wasm,
/// IndexedDB, or a framework-owned persistence layer as long as it satisfies the
/// method contract used here.
pub struct WebHostStore {
    host: JsValue,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebHostLocalOperation {
    #[serde(rename = "operation")]
    pub operation: SyncOperation,
    #[serde(rename = "localRow")]
    pub local_row: Option<Value>,
}

impl WebHostStore {
    pub fn new(host: JsValue) -> Result<Self> {
        if host.is_null() || host.is_undefined() || !host.is_object() {
            return Err(SyncularError::config(
                "browser host store must be a JavaScript object",
            ));
        }
        Ok(Self { host })
    }

    pub fn host(&self) -> &JsValue {
        &self.host
    }

    fn call_promise(&self, method: &str, args: &[JsValue]) -> Result<js_sys::Promise> {
        let value = js_sys::Reflect::get(&self.host, &JsValue::from_str(method))
            .map_err(|err| js_error(ErrorKind::Storage, method, err))?;
        let function = value.dyn_into::<js_sys::Function>().map_err(|_| {
            SyncularError::config(format!("browser host store is missing method {method}"))
        })?;
        let args_array = js_sys::Array::new();
        for arg in args {
            args_array.push(arg);
        }
        let value = function
            .apply(&self.host, &args_array)
            .map_err(|err| js_error(ErrorKind::Storage, method, err))?;
        value.dyn_into::<js_sys::Promise>().map_err(|_| {
            SyncularError::storage(anyhow::anyhow!(
                "browser host store method {method} must return a Promise"
            ))
        })
    }

    async fn call_json<T: DeserializeOwned>(&self, method: &str, args: &[JsValue]) -> Result<T> {
        let value = self.await_method(method, args).await?;
        serde_wasm_bindgen::from_value(value)
            .map_err(|err| SyncularError::protocol(err).context(format!("decode {method} result")))
    }

    async fn call_unit(&self, method: &str, args: &[JsValue]) -> Result<()> {
        self.await_method(method, args).await?;
        Ok(())
    }

    async fn await_method(&self, method: &str, args: &[JsValue]) -> Result<JsValue> {
        JsFuture::from(self.call_promise(method, args)?)
            .await
            .map_err(|err| js_error(ErrorKind::Storage, method, err))
    }

    pub async fn apply_mutations_batch(
        &self,
        operations: &[WebHostLocalOperation],
    ) -> Result<Vec<String>> {
        let operations = to_js_value(operations, "encode applyMutationsBatch operations")?;
        self.call_json("applyMutationsBatch", &[operations]).await
    }

    pub async fn apply_mutations_commit(
        &self,
        operations: &[WebHostLocalOperation],
    ) -> Result<String> {
        let operations = to_js_value(operations, "encode applyMutationsCommit operations")?;
        self.call_json("applyMutationsCommit", &[operations]).await
    }
}

impl AsyncWebStore for WebHostStore {
    fn apply_mutation<'a>(
        &'a mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            let operation = to_js_value(&operation, "encode applyMutation operation")?;
            let local_row = match local_row {
                Some(row) => to_js_value(&row, "encode applyMutation local row")?,
                None => JsValue::NULL,
            };
            self.call_json("applyMutation", &[operation, local_row])
                .await
        })
    }

    fn pending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>> {
        Box::pin(async move {
            self.call_json("pendingOutbox", &[JsValue::from_f64(limit as f64)])
                .await
        })
    }

    fn sending_outbox<'a>(
        &'a mut self,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OutboxCommit>>> + 'a>> {
        Box::pin(async move {
            self.call_json("sendingOutbox", &[JsValue::from_f64(limit as f64)])
                .await
        })
    }

    fn requeue_stale_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move { self.call_unit("requeueStaleOutbox", &[]).await })
    }

    fn mark_outbox_sending<'a>(
        &'a mut self,
        row_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.call_unit("markOutboxSending", &[JsValue::from_str(row_id)])
                .await
        })
    }

    fn mark_outbox_acked<'a>(
        &'a mut self,
        row_id: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let response = to_js_value(&response, "encode markOutboxAcked response")?;
            self.call_unit("markOutboxAcked", &[JsValue::from_str(row_id), response])
                .await
        })
    }

    fn mark_outbox_failed<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        response: PushCommitResponse,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let response = to_js_value(&response, "encode markOutboxFailed response")?;
            self.call_unit(
                "markOutboxFailed",
                &[
                    JsValue::from_str(row_id),
                    JsValue::from_str(error),
                    response,
                ],
            )
            .await
        })
    }

    fn mark_outbox_retry<'a>(
        &'a mut self,
        row_id: &'a str,
        error: &'a str,
        next_attempt_at: i64,
        failed: bool,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.call_unit(
                "markOutboxRetry",
                &[
                    JsValue::from_str(row_id),
                    JsValue::from_str(error),
                    JsValue::from_f64(next_attempt_at as f64),
                    JsValue::from_bool(failed),
                ],
            )
            .await
        })
    }

    fn insert_conflict<'a>(
        &'a mut self,
        outbox: OutboxCommit,
        result: OperationResult,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let outbox = to_js_value(&outbox, "encode insertConflict outbox")?;
            let result = to_js_value(&result, "encode insertConflict result")?;
            self.call_unit("insertConflict", &[outbox, result]).await
        })
    }

    fn conflict_summaries<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ConflictSummary>>> + 'a>> {
        Box::pin(async move { self.call_json("conflictSummaries", &[]).await })
    }

    fn resolve_conflict<'a>(
        &'a mut self,
        id: &'a str,
        resolution: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.call_unit(
                "resolveConflict",
                &[JsValue::from_str(id), JsValue::from_str(resolution)],
            )
            .await
        })
    }

    fn retry_conflict_keep_local<'a>(
        &'a mut self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            self.call_json("retryConflictKeepLocal", &[JsValue::from_str(id)])
                .await
        })
    }

    fn subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<WebSubscriptionState>>> + 'a>> {
        Box::pin(async move {
            self.call_json("subscriptionState", &[JsValue::from_str(subscription_id)])
                .await
        })
    }

    fn upsert_subscription_state<'a>(
        &'a mut self,
        state: WebSubscriptionState,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let state = to_js_value(&state, "encode upsertSubscriptionState state")?;
            self.call_unit("upsertSubscriptionState", &[state]).await
        })
    }

    fn delete_subscription_state<'a>(
        &'a mut self,
        subscription_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            self.call_unit(
                "deleteSubscriptionState",
                &[JsValue::from_str(subscription_id)],
            )
            .await
        })
    }

    fn clear_table_for_scopes<'a>(
        &'a mut self,
        table: &'a str,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let scopes = to_js_value(scopes, "encode clearTableForScopes scopes")?;
            self.call_unit("clearTableForScopes", &[JsValue::from_str(table), scopes])
                .await
        })
    }

    fn upsert_row<'a>(
        &'a mut self,
        table: &'a str,
        row: Value,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let row = to_js_value(&row, "encode upsertRow row")?;
            self.call_unit("upsertRow", &[JsValue::from_str(table), row])
                .await
        })
    }

    fn apply_change<'a>(
        &'a mut self,
        change: SyncChange,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let change = to_js_value(&change, "encode applyChange change")?;
            self.call_unit("applyChange", &[change]).await
        })
    }

    fn list_table_json<'a>(
        &'a mut self,
        table: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + 'a>> {
        Box::pin(async move {
            self.call_json("listTableJson", &[JsValue::from_str(table)])
                .await
        })
    }
}

fn to_js_value(value: &(impl Serialize + ?Sized), context: &str) -> Result<JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value
        .serialize(&serializer)
        .map_err(|err| SyncularError::protocol(err).context(context))
}

fn js_error(kind: ErrorKind, context: &str, value: JsValue) -> SyncularError {
    SyncularError::message(kind, format!("{context}: {}", js_value_string(value)))
}

fn js_value_string(value: JsValue) -> String {
    if let Some(value) = value.as_string() {
        return value;
    }
    if let Some(message) = js_object_string_property(&value, "message") {
        if let Some(name) = js_object_string_property(&value, "name") {
            return format!("{name}: {message}");
        }
        return message;
    }
    js_sys::JSON::stringify(&value)
        .ok()
        .and_then(|value| value.as_string())
        .unwrap_or_else(|| "unknown JavaScript error".to_string())
}

fn js_object_string_property(value: &JsValue, property: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_string())
        .filter(|value| !value.is_empty())
}
