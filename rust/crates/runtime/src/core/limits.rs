use serde::Serialize;

pub const DEFAULT_WORKER_COMMAND_QUEUE_CAPACITY: usize = 1024;
pub const DEFAULT_WORKER_EVENT_QUEUE_CAPACITY: usize = 1024;
pub const DEFAULT_NATIVE_EVENT_STREAM_CAPACITY: usize = 256;
pub const DEFAULT_NATIVE_RECENT_EVENT_LIMIT: usize = 100;
pub const DEFAULT_READONLY_QUERY_STATEMENT_CACHE_CAPACITY: usize = 64;

pub const DEFAULT_PULL_LIMIT_COMMITS: i64 = 1000;
pub const DEFAULT_PULL_LIMIT_SNAPSHOT_ROWS: i64 = 50_000;
pub const DEFAULT_PULL_MAX_SNAPSHOT_PAGES: i64 = 10;
pub const DEFAULT_OUTBOX_PUSH_BATCH_LIMIT: i64 = 20;

pub const DEFAULT_CRDT_STATE_VECTOR_HINT_LIMIT: i64 = 256;
pub const DEFAULT_CRDT_UPDATE_QUEUE_CAPACITY: i64 = 1024;
pub const DEFAULT_CRDT_UPDATE_LOG_LIMIT: i64 = 100;

pub const DEFAULT_YJS_FLUSH_WINDOW_MS: u64 = 12;

pub const MAX_SUBSCRIPTIONS_PER_CLIENT: usize = 256;
pub const MAX_SCOPE_KEYS_PER_SUBSCRIPTION: usize = 16;
pub const MAX_SCOPE_VALUES_PER_SUBSCRIPTION: usize = 4096;
pub const MAX_SCOPE_VALUES_PER_CLIENT: usize = 16_384;
pub const MAX_SUBSCRIPTION_PARAMS_PER_SUBSCRIPTION: usize = 32;
pub const MAX_MUTATION_OPERATION_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_MUTATION_LOCAL_ROW_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_MUTATION_BATCH_JSON_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OUTBOX_OPERATIONS_JSON_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_BLOB_PAYLOAD_BYTES: i64 = 64 * 1024 * 1024;
pub const MAX_CRDT_REQUEST_JSON_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CRDT_UPDATE_BASE64_BYTES: usize = 1024 * 1024;
pub const MAX_CRDT_STATE_BASE64_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CRDT_STATE_VECTOR_BASE64_BYTES: usize = 64 * 1024;
pub const MAX_CRDT_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLimits {
    pub worker_command_queue_capacity: usize,
    pub worker_event_queue_capacity: usize,
    pub native_default_event_stream_capacity: usize,
    pub native_recent_event_limit: usize,
    pub readonly_query_statement_cache_capacity: usize,
    pub pull_limit_commits: i64,
    pub pull_limit_snapshot_rows: i64,
    pub pull_max_snapshot_pages: i64,
    pub outbox_push_batch_limit: i64,
    pub crdt_state_vector_hint_limit: i64,
    pub crdt_update_queue_capacity: i64,
    pub crdt_update_log_default_limit: i64,
    pub yjs_flush_window_ms: u64,
    pub max_subscriptions_per_client: usize,
    pub max_scope_keys_per_subscription: usize,
    pub max_scope_values_per_subscription: usize,
    pub max_scope_values_per_client: usize,
    pub max_subscription_params_per_subscription: usize,
    pub max_mutation_operation_json_bytes: usize,
    pub max_mutation_local_row_json_bytes: usize,
    pub max_mutation_batch_json_bytes: usize,
    pub max_outbox_operations_json_bytes: usize,
    pub max_blob_payload_bytes: i64,
    pub max_crdt_request_json_bytes: usize,
    pub max_crdt_update_base64_bytes: usize,
    pub max_crdt_state_base64_bytes: usize,
    pub max_crdt_state_vector_base64_bytes: usize,
    pub max_crdt_text_bytes: usize,
    pub max_native_diagnostic_event_payload_json_bytes: usize,
}

pub fn runtime_default_limits() -> RuntimeLimits {
    RuntimeLimits {
        worker_command_queue_capacity: DEFAULT_WORKER_COMMAND_QUEUE_CAPACITY,
        worker_event_queue_capacity: DEFAULT_WORKER_EVENT_QUEUE_CAPACITY,
        native_default_event_stream_capacity: DEFAULT_NATIVE_EVENT_STREAM_CAPACITY,
        native_recent_event_limit: DEFAULT_NATIVE_RECENT_EVENT_LIMIT,
        readonly_query_statement_cache_capacity: DEFAULT_READONLY_QUERY_STATEMENT_CACHE_CAPACITY,
        pull_limit_commits: DEFAULT_PULL_LIMIT_COMMITS,
        pull_limit_snapshot_rows: DEFAULT_PULL_LIMIT_SNAPSHOT_ROWS,
        pull_max_snapshot_pages: DEFAULT_PULL_MAX_SNAPSHOT_PAGES,
        outbox_push_batch_limit: DEFAULT_OUTBOX_PUSH_BATCH_LIMIT,
        crdt_state_vector_hint_limit: DEFAULT_CRDT_STATE_VECTOR_HINT_LIMIT,
        crdt_update_queue_capacity: DEFAULT_CRDT_UPDATE_QUEUE_CAPACITY,
        crdt_update_log_default_limit: DEFAULT_CRDT_UPDATE_LOG_LIMIT,
        yjs_flush_window_ms: DEFAULT_YJS_FLUSH_WINDOW_MS,
        max_subscriptions_per_client: MAX_SUBSCRIPTIONS_PER_CLIENT,
        max_scope_keys_per_subscription: MAX_SCOPE_KEYS_PER_SUBSCRIPTION,
        max_scope_values_per_subscription: MAX_SCOPE_VALUES_PER_SUBSCRIPTION,
        max_scope_values_per_client: MAX_SCOPE_VALUES_PER_CLIENT,
        max_subscription_params_per_subscription: MAX_SUBSCRIPTION_PARAMS_PER_SUBSCRIPTION,
        max_mutation_operation_json_bytes: MAX_MUTATION_OPERATION_JSON_BYTES,
        max_mutation_local_row_json_bytes: MAX_MUTATION_LOCAL_ROW_JSON_BYTES,
        max_mutation_batch_json_bytes: MAX_MUTATION_BATCH_JSON_BYTES,
        max_outbox_operations_json_bytes: MAX_OUTBOX_OPERATIONS_JSON_BYTES,
        max_blob_payload_bytes: MAX_BLOB_PAYLOAD_BYTES,
        max_crdt_request_json_bytes: MAX_CRDT_REQUEST_JSON_BYTES,
        max_crdt_update_base64_bytes: MAX_CRDT_UPDATE_BASE64_BYTES,
        max_crdt_state_base64_bytes: MAX_CRDT_STATE_BASE64_BYTES,
        max_crdt_state_vector_base64_bytes: MAX_CRDT_STATE_VECTOR_BASE64_BYTES,
        max_crdt_text_bytes: MAX_CRDT_TEXT_BYTES,
        max_native_diagnostic_event_payload_json_bytes:
            MAX_NATIVE_DIAGNOSTIC_EVENT_PAYLOAD_JSON_BYTES,
    }
}
