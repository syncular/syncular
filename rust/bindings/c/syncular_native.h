#ifndef SYNCULAR_NATIVE_H
#define SYNCULAR_NATIVE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SYNCULAR_NATIVE_FFI_ABI_VERSION 2

typedef struct SyncularNativeHandle SyncularNativeHandle;
typedef struct SyncularNativeOpenHandle SyncularNativeOpenHandle;
typedef struct SyncularNativeEventSubscription SyncularNativeEventSubscription;
typedef struct SyncularNativePresenceHandle SyncularNativePresenceHandle;

typedef void (*SyncularNativeEventCallback)(
    const char *event_json,
    void *user_data
);
typedef void (*SyncularNativeEventErrorCallback)(
    const char *error_json,
    void *user_data
);

/*
 * All returned strings are UTF-8 JSON unless a function documents otherwise.
 * The caller owns every non-null returned string and must release it with
 * syncular_string_free().
 *
 * error_out is optional. When provided, functions clear it before work starts.
 * On failure they write a JSON NativeErrorInfo object:
 * { "kind": "...", "message": "...", "debug": "..." }
 */
void syncular_string_free(char *value);

char *syncular_native_runtime_manifest_json(char **error_out);

SyncularNativeHandle *syncular_native_client_open(
    const char *config_json,
    bool auto_sync_local_writes,
    char **error_out
);

SyncularNativeOpenHandle *syncular_native_client_open_async(
    const char *config_json,
    bool auto_sync_local_writes,
    char **error_out
);

char *syncular_native_client_open_async_command_id(
    SyncularNativeOpenHandle *handle,
    char **error_out
);

bool syncular_native_client_open_async_is_finished(
    SyncularNativeOpenHandle *handle,
    char **error_out
);

SyncularNativeHandle *syncular_native_client_open_async_finish_timeout(
    SyncularNativeOpenHandle *handle,
    uint64_t timeout_ms,
    char **error_out
);

bool syncular_native_client_open_async_close(
    SyncularNativeOpenHandle *handle,
    char **error_out
);

bool syncular_native_client_close(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_trigger_sync(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_trigger_sync_websocket(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_enqueue_sync_now(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_enqueue_sync_websocket(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_pause_sync_worker(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_resume_sync_worker(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_sync_worker_running(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_start_realtime_worker(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_start(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_stop_realtime_worker(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_stop(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_join_presence(
    SyncularNativeHandle *handle,
    const char *scope_key,
    const char *metadata_json,
    char **error_out
);

bool syncular_native_client_leave_presence(
    SyncularNativeHandle *handle,
    const char *scope_key,
    char **error_out
);

bool syncular_native_client_update_presence_metadata(
    SyncularNativeHandle *handle,
    const char *scope_key,
    const char *metadata_json,
    char **error_out
);

char *syncular_native_client_presence_json(
    SyncularNativeHandle *handle,
    const char *scope_key,
    char **error_out
);

/*
 * Owning presence token for C hosts. Close the presence handle before closing
 * the client handle. close() leaves the scope if leave() was not called.
 */
SyncularNativePresenceHandle *syncular_native_client_join_presence_handle(
    SyncularNativeHandle *handle,
    const char *scope_key,
    const char *metadata_json,
    char **error_out
);

char *syncular_native_presence_handle_scope_key(
    SyncularNativePresenceHandle *handle,
    char **error_out
);

bool syncular_native_presence_handle_update_metadata(
    SyncularNativePresenceHandle *handle,
    const char *metadata_json,
    char **error_out
);

bool syncular_native_presence_handle_leave(
    SyncularNativePresenceHandle *handle,
    char **error_out
);

bool syncular_native_presence_handle_close(
    SyncularNativePresenceHandle *handle,
    char **error_out
);

bool syncular_native_client_set_auth_headers_json(
    SyncularNativeHandle *handle,
    const char *headers_json,
    char **error_out
);

bool syncular_native_client_set_subscriptions_json(
    SyncularNativeHandle *handle,
    const char *subscriptions_json,
    char **error_out
);

char *syncular_native_client_force_subscriptions_bootstrap_json(
    SyncularNativeHandle *handle,
    const char *subscription_ids_json,
    char **error_out
);

bool syncular_native_client_set_field_encryption_json(
    SyncularNativeHandle *handle,
    const char *config_json,
    char **error_out
);

bool syncular_native_client_set_encrypted_crdt_json(
    SyncularNativeHandle *handle,
    const char *config_json,
    char **error_out
);

char *syncular_native_encryption_helper_json(
    const char *method,
    const char *args_json,
    char **error_out
);

char *syncular_native_client_apply_mutation_json(
    SyncularNativeHandle *handle,
    const char *mutation_json,
    const char *local_row_json,
    char **error_out
);

char *syncular_native_client_enqueue_mutation_json(
    SyncularNativeHandle *handle,
    const char *mutation_json,
    const char *local_row_json,
    char **error_out
);

char *syncular_native_client_enqueue_yjs_update_json(
    SyncularNativeHandle *handle,
    const char *update_json,
    char **error_out
);

char *syncular_native_client_open_crdt_field_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_apply_crdt_field_text_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_apply_crdt_field_yjs_update_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_enqueue_crdt_field_yjs_update_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_enqueue_crdt_field_text_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_enqueue_crdt_field_compaction_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_materialize_crdt_field_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_crdt_document_snapshot_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_crdt_update_log_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_snapshot_crdt_field_state_vector_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_compact_crdt_field_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_apply_encrypted_crdt_update_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_enqueue_encrypted_crdt_update_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_apply_encrypted_crdt_checkpoint_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_enqueue_encrypted_crdt_checkpoint_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_app_tables_json(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_app_table_metadata_json(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_list_table_json(
    SyncularNativeHandle *handle,
    const char *table,
    char **error_out
);

char *syncular_native_client_query_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_enqueue_refresh_snapshot_json(
    SyncularNativeHandle *handle,
    const char *request_json,
    char **error_out
);

char *syncular_native_client_store_blob_file_json(
    SyncularNativeHandle *handle,
    const char *file_path,
    const char *options_json,
    char **error_out
);

char *syncular_native_client_enqueue_store_blob_file_json(
    SyncularNativeHandle *handle,
    const char *file_path,
    const char *options_json,
    char **error_out
);

bool syncular_native_client_retrieve_blob_file(
    SyncularNativeHandle *handle,
    const char *ref_json,
    const char *file_path,
    char **error_out
);

bool syncular_native_client_retrieve_blob_file_with_options(
    SyncularNativeHandle *handle,
    const char *ref_json,
    const char *file_path,
    const char *options_json,
    char **error_out
);

char *syncular_native_client_enqueue_retrieve_blob_file_json(
    SyncularNativeHandle *handle,
    const char *ref_json,
    const char *file_path,
    const char *options_json,
    char **error_out
);

bool syncular_native_client_is_blob_local(
    SyncularNativeHandle *handle,
    const char *hash,
    char **error_out
);

char *syncular_native_client_process_blob_upload_queue_json(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_enqueue_process_blob_upload_queue(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_blob_upload_queue_stats_json(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_blob_cache_stats_json(
    SyncularNativeHandle *handle,
    char **error_out
);

int64_t syncular_native_client_prune_blob_cache(
    SyncularNativeHandle *handle,
    int64_t max_bytes,
    char **error_out
);

char *syncular_native_client_enqueue_prune_blob_cache(
    SyncularNativeHandle *handle,
    int64_t max_bytes,
    char **error_out
);

bool syncular_native_client_clear_blob_cache(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_enqueue_clear_blob_cache(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_compact_storage_json(
    SyncularNativeHandle *handle,
    const char *options_json,
    char **error_out
);

char *syncular_native_client_enqueue_compact_storage_json(
    SyncularNativeHandle *handle,
    const char *options_json,
    char **error_out
);

char *syncular_native_client_register_query_json(
    SyncularNativeHandle *handle,
    const char *query_json,
    char **error_out
);

bool syncular_native_client_unregister_query(
    SyncularNativeHandle *handle,
    const char *query_id,
    char **error_out
);

char *syncular_native_client_observed_queries_json(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_outbox_summaries_json(
    SyncularNativeHandle *handle,
    char **error_out
);

char *syncular_native_client_conflict_summaries_json(
    SyncularNativeHandle *handle,
    char **error_out
);

bool syncular_native_client_resolve_conflict(
    SyncularNativeHandle *handle,
    const char *conflict_id,
    const char *resolution,
    char **error_out
);

char *syncular_native_client_enqueue_resolve_conflict(
    SyncularNativeHandle *handle,
    const char *conflict_id,
    const char *resolution,
    char **error_out
);

char *syncular_native_client_retry_conflict_keep_local(
    SyncularNativeHandle *handle,
    const char *conflict_id,
    char **error_out
);

SyncularNativeEventSubscription *syncular_native_client_subscribe_events_json(
    SyncularNativeHandle *handle,
    uint32_t capacity,
    SyncularNativeEventCallback callback,
    SyncularNativeEventErrorCallback error_callback,
    void *user_data,
    char **error_out
);

bool syncular_native_event_subscription_close(
    SyncularNativeEventSubscription *handle,
    char **error_out
);

#ifdef __cplusplus
}
#endif

#endif
