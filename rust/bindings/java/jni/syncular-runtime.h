#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdatomic.h>

typedef struct FfiStatus { int32_t code; } FfiStatus;
typedef struct FfiString { uint8_t* ptr; size_t len; size_t cap; } FfiString;
typedef struct FfiBuf_u8 { uint8_t* ptr; size_t len; size_t cap; size_t align; } FfiBuf_u8;
typedef struct FfiError { FfiString message; } FfiError;
typedef struct BoltFFICallbackHandle { uint64_t handle; const void* vtable; } BoltFFICallbackHandle;

static inline bool boltffi_atomic_u8_cas(volatile uint8_t* target, uint8_t expected, uint8_t desired) {
    return atomic_compare_exchange_strong((_Atomic uint8_t*)target, &expected, desired);
}

static inline uint64_t boltffi_atomic_u64_exchange(volatile uint64_t* target, uint64_t value) {
    return atomic_exchange((_Atomic uint64_t*)target, value);
}

static inline bool boltffi_atomic_u64_cas(volatile uint64_t* target, uint64_t expected, uint64_t desired) {
    return atomic_compare_exchange_strong((_Atomic uint64_t*)target, &expected, desired);
}

static inline uint64_t boltffi_atomic_u64_load(const volatile uint64_t* target) {
    return atomic_load_explicit((const _Atomic uint64_t*)target, memory_order_acquire);
}



struct SyncularBoltClient;

FfiBuf_u8 boltffi_syncular_runtime_manifest_json(void);FfiBuf_u8 boltffi_syncular_take_last_open_error(void);struct SyncularBoltClient * boltffi_syncular_bolt_client_open(const uint8_t* config, uintptr_t config_len);void boltffi_syncular_bolt_client_free(struct SyncularBoltClient * handle);FfiBuf_u8 boltffi_syncular_bolt_client_runtime_manifest_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_set_auth_headers_json(const struct SyncularBoltClient * self, const uint8_t* headers_json, uintptr_t headers_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_trigger_sync(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_pause_sync_worker(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_resume_sync_worker(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_sync_worker_running(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_poll_event_json_timeout(const struct SyncularBoltClient * self, uint64_t timeout_ms);FfiBuf_u8 boltffi_syncular_bolt_client_apply_local_operation_json(const struct SyncularBoltClient * self, const uint8_t* operation_json, uintptr_t operation_json_len, const uint8_t* local_row_json, uintptr_t local_row_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_apply_mutation_json(const struct SyncularBoltClient * self, const uint8_t* mutation_json, uintptr_t mutation_json_len, const uint8_t* local_row_json, uintptr_t local_row_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_list_table_json(const struct SyncularBoltClient * self, const uint8_t* table, uintptr_t table_len);FfiBuf_u8 boltffi_syncular_bolt_client_query_json(const struct SyncularBoltClient * self, const uint8_t* request_json, uintptr_t request_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_store_blob_file_json(const struct SyncularBoltClient * self, const uint8_t* path, uintptr_t path_len, const uint8_t* options_json, uintptr_t options_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_retrieve_blob_file_json(const struct SyncularBoltClient * self, const uint8_t* ref_json, uintptr_t ref_json_len, const uint8_t* path, uintptr_t path_len, const uint8_t* options_json, uintptr_t options_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_is_blob_local(const struct SyncularBoltClient * self, const uint8_t* hash, uintptr_t hash_len);FfiBuf_u8 boltffi_syncular_bolt_client_process_blob_upload_queue_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_blob_upload_queue_stats_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_blob_cache_stats_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_prune_blob_cache(const struct SyncularBoltClient * self, int64_t max_bytes);FfiBuf_u8 boltffi_syncular_bolt_client_clear_blob_cache(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_compact_storage_json(const struct SyncularBoltClient * self, const uint8_t* options_json, uintptr_t options_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_app_tables_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_app_table_metadata_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_register_query_json(const struct SyncularBoltClient * self, const uint8_t* query_json, uintptr_t query_json_len);FfiBuf_u8 boltffi_syncular_bolt_client_unregister_query(const struct SyncularBoltClient * self, const uint8_t* id, uintptr_t id_len);FfiBuf_u8 boltffi_syncular_bolt_client_observed_queries_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_outbox_summaries_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_conflict_summaries_json(const struct SyncularBoltClient * self);FfiBuf_u8 boltffi_syncular_bolt_client_resolve_conflict(const struct SyncularBoltClient * self, const uint8_t* id, uintptr_t id_len, const uint8_t* resolution, uintptr_t resolution_len);FfiBuf_u8 boltffi_syncular_bolt_client_retry_conflict_keep_local(const struct SyncularBoltClient * self, const uint8_t* id, uintptr_t id_len);FfiBuf_u8 boltffi_syncular_bolt_client_shutdown(const struct SyncularBoltClient * self);

void boltffi_free_string(FfiString s);
void boltffi_free_buf(FfiBuf_u8 buf);
FfiStatus boltffi_last_error_message(FfiString *out);
void boltffi_clear_last_error(void);
