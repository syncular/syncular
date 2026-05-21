use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScenarioFixture {
    pub actors: SyncScenarioActors,
    pub subscription: SyncScenarioSubscription,
    pub owner_conflict: OwnerConflictScenario,
    pub revoked_subscription: RevokedSubscriptionScenario,
    pub retry_backoff: RetryBackoffScenario,
    pub snapshot_chunk: SnapshotChunkScenario,
    pub repeated_pull: RepeatedPullScenario,
    pub duplicate_push: DuplicatePushScenario,
    pub conflict_keep_local: ConflictKeepLocalScenario,
    pub realtime: RealtimeScenario,
    pub live_query: LiveQueryScenario,
    pub worker_auth: WorkerAuthScenario,
    pub auth_refresh: AuthRefreshScenario,
    pub revoked_session: RevokedSessionScenario,
    pub schema_version: SchemaVersionScenario,
    pub e2ee: E2eeScenario,
    pub blob: BlobScenario,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncScenarioActors {
    #[serde(rename = "ownerA")]
    pub owner_a: SyncScenarioActor,
    #[serde(rename = "ownerB")]
    pub owner_b: SyncScenarioActor,
    pub rust: RustSyncScenarioActor,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScenarioActor {
    pub actor_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustSyncScenarioActor {
    pub actor_id: String,
    pub project_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncScenarioSubscription {
    pub id: String,
    pub table: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerConflictScenario {
    pub client_id: String,
    pub first_file_name: String,
    pub second_file_name: String,
    pub expected_error_pattern: String,
    pub expected_refresh_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedSubscriptionScenario {
    pub client_id: String,
    pub revoked_actor_id: String,
    pub seed_task: SyncScenarioVersionedTask,
    pub expected_status: String,
    pub expected_scopes: BTreeMap<String, Value>,
    pub expected_cursor_sequence: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryBackoffScenario {
    pub client_id: String,
    pub local_row: SyncScenarioTaskRow,
    pub expected_sync_post_counts: Vec<i64>,
    pub expected_pending_pushes: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotChunkScenario {
    pub client_id: String,
    pub failure_client_id: String,
    pub chunk_id: String,
    pub byte_length: i64,
    pub sha256: String,
    pub encoding: String,
    pub compression: String,
    pub expected_error_pattern: String,
    pub server_task: SyncScenarioVersionedTask,
    pub browser_server_task: SyncScenarioTaskInput,
    pub local_row: SyncScenarioTaskRow,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatedPullScenario {
    pub client_id: String,
    pub task: SyncScenarioVersionedTask,
    pub expected_cursor: i64,
    pub expected_browser_cursor: i64,
    pub expected_row_count: i64,
    pub expected_pull_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePushScenario {
    pub client_id: String,
    pub task: SyncScenarioTaskRow,
    pub expected_first_push_commits: i64,
    pub expected_second_push_commits: i64,
    pub expected_server_row_count: i64,
    pub expected_outbox_status: String,
    pub expected_conflict_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictKeepLocalScenario {
    pub client_id: String,
    pub keep_server_client_id: String,
    pub dismiss_client_id: String,
    pub row_id: String,
    pub local_title: String,
    pub server_title: String,
    pub stale_base_version: i64,
    pub server_version: i64,
    pub conflict_code: String,
    pub conflict_message: String,
    pub browser_conflict_message: String,
    pub keep_server_resolution: String,
    pub dismiss_resolution: String,
    pub expected_initial_conflict_count: i64,
    pub expected_after_resolve_conflict_count: i64,
    pub expected_after_retry_conflict_count: i64,
    pub expected_retry_push_commits: i64,
    pub retry_base_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeScenario {
    pub client_a_id: String,
    pub client_b_id: String,
    pub auth_refresh_client_id: String,
    pub websocket_token: String,
    pub refreshed_websocket_token: String,
    pub expected_auth_tokens: Vec<String>,
    pub expected_connection_count: i64,
    pub presence_event: String,
    pub expected_event_debug: Vec<String>,
    pub task: SyncScenarioVersionedTask,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveQueryScenario {
    pub client_a_id: String,
    pub client_b_id: String,
    pub query_sql: String,
    pub tables: Vec<String>,
    pub expected_initial_rows: i64,
    pub expected_events_before_unsubscribe: i64,
    pub expected_events_after_unsubscribe: i64,
    pub first_task: SyncScenarioTaskInput,
    pub second_task: SyncScenarioTaskInput,
    pub third_task: SyncScenarioTaskInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerAuthScenario {
    pub client_id: String,
    pub authorization: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRefreshScenario {
    pub client_id: String,
    pub initial_authorization: String,
    pub refreshed_authorization: String,
    pub expected_refresh_count: i64,
    pub expected_auth_headers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedSessionScenario {
    pub client_id: String,
    pub authorization: String,
    pub expected_status: u16,
    pub expected_refresh_count: i64,
    pub expected_retry_count: i64,
    pub expected_error_pattern: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaVersionScenario {
    pub required_future_client_id: String,
    pub latest_future_client_id: String,
    pub invalid_outbox_client_id: String,
    pub future_version_offset: i32,
    pub expected_required_error_pattern: String,
    pub expected_invalid_outbox_error_pattern: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeScenario {
    pub client_id: String,
    pub pull_client_id: String,
    pub key_base64: String,
    pub envelope_prefix: String,
    pub rule: E2eeRuleScenario,
    pub task: SyncScenarioTaskInput,
    pub conflict: E2eeConflictScenario,
    pub chunk: E2eeChunkScenario,
    pub server_version: i64,
    pub expected_decrypted_row_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct E2eeRuleScenario {
    pub scope: String,
    pub table: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeConflictScenario {
    pub seed_client_id: String,
    pub client_id: String,
    pub row_id: String,
    pub server_title: String,
    pub local_title: String,
    pub stale_base_version: i64,
    pub expected_conflict_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeChunkScenario {
    pub seed_client_id: String,
    pub client_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobScenario {
    pub client_id: String,
    pub browser_client_id: String,
    pub streaming_client_id: String,
    pub dedupe_client_id: String,
    pub auth_failure_client_id: String,
    pub interrupted_upload_client_id: String,
    pub missing_client_id: String,
    pub cache_prune_client_id: String,
    pub actor_id: String,
    pub browser_actor_id: String,
    pub authorization: String,
    pub stale_authorization: String,
    pub mime_type: String,
    pub text_mime_type: String,
    pub bytes: Vec<u8>,
    pub browser_text: String,
    pub reference_sync: BlobReferenceSyncScenario,
    pub dedupe_text: String,
    pub auth_failure_text: String,
    pub interrupted_upload_text: String,
    pub cache_prune_old_text: String,
    pub cache_prune_new_text: String,
    pub streaming_byte_count: usize,
    pub upload_token: String,
    pub upload_path: String,
    pub download_path: String,
    pub expected_upload_queue_before: BlobQueueStats,
    pub expected_upload_queue_after: BlobQueueStats,
    pub expected_failed_queue: BlobQueueStats,
    pub cache_prune_max_bytes: i64,
    pub expected_cache_before_prune: BlobCacheStats,
    pub expected_cache_pruned_bytes: i64,
    pub expected_cache_after_prune: BlobCacheStats,
    pub expected_process_uploaded: BlobProcessResult,
    pub expected_process_retryable_failure: BlobProcessResult,
    pub expected_process_permanent_failure: BlobProcessResult,
    pub expected_auth_header_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobReferenceSyncScenario {
    pub source_client_id: String,
    pub reader_client_id: String,
    pub task: SyncScenarioTaskInput,
    pub image: SyncScenarioBlobRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScenarioBlobRef {
    pub hash: String,
    pub size: i64,
    pub mime_type: String,
    #[serde(default)]
    pub encrypted: Option<bool>,
    #[serde(default)]
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobQueueStats {
    pub pending: i64,
    pub uploading: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobCacheStats {
    pub count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobProcessResult {
    pub uploaded: i32,
    pub failed: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScenarioVersionedTask {
    pub id: String,
    pub title: String,
    pub server_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncScenarioTaskInput {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncScenarioTaskRow {
    pub id: String,
    pub title: String,
    pub completed: i64,
    #[serde(default)]
    pub user_id: Option<String>,
    pub project_id: Option<String>,
    pub server_version: i64,
    pub image: Option<String>,
    pub title_yjs_state: Option<String>,
}

pub fn sync_conformance_fixture() -> SyncScenarioFixture {
    serde_json::from_str(include_str!(
        "../../../examples/todo-app/conformance/sync-scenarios.json"
    ))
    .expect("typed sync conformance JSON")
}

pub fn sync_conformance() -> Value {
    serde_json::from_str(include_str!(
        "../../../examples/todo-app/conformance/sync-scenarios.json"
    ))
    .expect("sync conformance JSON")
}

pub fn sync_conformance_str(path: &[&str]) -> String {
    sync_conformance_value(path)
        .as_str()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be a string"))
        .to_string()
}

pub fn sync_conformance_i64(path: &[&str]) -> i64 {
    sync_conformance_value(path)
        .as_i64()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be an integer"))
}

pub fn sync_conformance_i32(path: &[&str]) -> i32 {
    sync_conformance_i64(path)
        .try_into()
        .unwrap_or_else(|_| panic!("sync conformance path {path:?} must fit in i32"))
}

pub fn sync_conformance_usize(path: &[&str]) -> usize {
    sync_conformance_i64(path)
        .try_into()
        .unwrap_or_else(|_| panic!("sync conformance path {path:?} must fit in usize"))
}

pub fn sync_conformance_bytes(path: &[&str]) -> Vec<u8> {
    sync_conformance_value(path)
        .as_array()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be an array"))
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|byte| byte.try_into().ok())
                .unwrap_or_else(|| panic!("sync conformance path {path:?} must contain bytes"))
        })
        .collect()
}

pub fn sync_conformance_value(path: &[&str]) -> Value {
    let mut value = sync_conformance();
    for segment in path {
        value = value
            .get(segment)
            .unwrap_or_else(|| panic!("missing sync conformance path {path:?}"))
            .clone();
    }
    value
}
