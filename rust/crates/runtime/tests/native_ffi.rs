use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use syncular_runtime::fixtures::todo::migrations::current_schema_version;
use syncular_runtime::native_ffi::{
    syncular_native_client_app_table_metadata_json, syncular_native_client_app_tables_json,
    syncular_native_client_apply_crdt_field_text_json,
    syncular_native_client_apply_local_operation_json, syncular_native_client_apply_mutation_json,
    syncular_native_client_blob_cache_stats_json,
    syncular_native_client_blob_upload_queue_stats_json, syncular_native_client_clear_blob_cache,
    syncular_native_client_close, syncular_native_client_compact_storage_json,
    syncular_native_client_list_table_json, syncular_native_client_materialize_crdt_field_json,
    syncular_native_client_observed_queries_json, syncular_native_client_open,
    syncular_native_client_open_async, syncular_native_client_open_async_close,
    syncular_native_client_open_async_command_id, syncular_native_client_open_async_finish_timeout,
    syncular_native_client_open_async_is_finished, syncular_native_client_open_crdt_field_json,
    syncular_native_client_outbox_summaries_json, syncular_native_client_pause_sync_worker,
    syncular_native_client_process_blob_upload_queue_json, syncular_native_client_query_json,
    syncular_native_client_register_query_json, syncular_native_client_resume_sync_worker,
    syncular_native_client_retrieve_blob_file, syncular_native_client_retry_conflict_keep_local,
    syncular_native_client_set_auth_headers_json, syncular_native_client_set_encrypted_crdt_json,
    syncular_native_client_set_field_encryption_json, syncular_native_client_store_blob_file_json,
    syncular_native_client_subscribe_events_json, syncular_native_client_sync_worker_running,
    syncular_native_client_trigger_sync, syncular_native_client_unregister_query,
    syncular_native_encryption_helper_json, syncular_native_event_subscription_close,
    syncular_native_runtime_manifest_json, syncular_string_free, SyncularNativeEventSubscription,
    SyncularNativeHandle,
};
use syncular_testkit::{todo_app_schema_json, unique_temp_db_path, unique_temp_file_path};

#[test]
fn native_ffi_exposes_runtime_manifest_without_handle() {
    let mut error = ptr::null_mut();
    let manifest_json = syncular_native_runtime_manifest_json(&mut error);
    assert!(error.is_null());

    let manifest: Value = serde_json::from_str(&take_string(manifest_json)).unwrap();
    assert_eq!(manifest["ffi_abi_version"], 2);
    assert_eq!(manifest["crate_name"], "syncular-runtime");
    assert_eq!(manifest["crate_version"], "0.1.0");
    assert_eq!(manifest["schema_version"], current_schema_version());
    assert_eq!(manifest["storage_backend"], "diesel-sqlite");
    assert_eq!(manifest["transport_backends"][0], "http");
    assert_eq!(manifest["transport_backends"][1], "websocket");
    assert_eq!(manifest["worker_model"], "background-sync-worker");
    assert_eq!(manifest["error_shape"], "native-error-info-v1");
    assert_eq!(manifest["event_model"], "native-event-stream-json-v1");
    assert_eq!(manifest["app_tables"].as_array().map(Vec::len), Some(0));
    assert_eq!(
        manifest["app_table_metadata"].as_array().map(Vec::len),
        Some(0)
    );
    assert_eq!(
        manifest["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec![
            "dynamic-auth-headers",
            "dynamic-subscriptions",
            "auth-expired-events",
            "generated-app-table-metadata",
            "generated-json-table-reads",
            "generated-json-local-operations",
            "generated-json-mutations",
            "queued-json-local-operations",
            "queued-yjs-updates",
            "queued-snapshot-refresh",
            "queued-storage-compaction",
            "queued-blob-cache-work",
            "worker-command-queue",
            "ordered-native-events",
            "native-event-stream",
            "read-only-query-json",
            "outbox-json",
            "conflicts-json",
            "table-level-rows-changed-events",
            "query-observer-events",
            "conflicts-changed-events",
            "blob-file-api",
            "background-worker-lifecycle",
            "structured-diagnostics",
            "storage-compaction",
            "streaming-blob-file-api",
            "crdt-yjs",
            "field-encryption",
            "encrypted-crdt",
            "queued-encrypted-crdt",
            "generic-crdt-field-api",
            "queued-crdt-field-updates",
            "encryption-key-sharing",
            "async-native-open"
        ]
    );
}

#[test]
fn native_ffi_can_open_client_asynchronously() {
    let path = temp_db_path("syncular-native-ffi-async-open");
    let mut error = ptr::null_mut();
    let config = ffi_config(&path, "native-ffi-async-open");

    let open_handle = syncular_native_client_open_async(config.as_ptr(), false, &mut error);
    assert!(!open_handle.is_null());
    assert!(error.is_null());

    let command_id = syncular_native_client_open_async_command_id(open_handle, &mut error);
    assert!(take_string(command_id).starts_with("native-open-"));
    assert!(error.is_null());

    let _ = syncular_native_client_open_async_is_finished(open_handle, &mut error);
    assert!(error.is_null());

    let handle = syncular_native_client_open_async_finish_timeout(open_handle, 5_000, &mut error);
    assert!(!handle.is_null());
    assert!(error.is_null());
    assert!(syncular_native_client_open_async_is_finished(
        open_handle,
        &mut error
    ));
    assert!(error.is_null());

    let tables_json = syncular_native_client_app_tables_json(handle, &mut error);
    let tables: Value = serde_json::from_str(&take_string(tables_json)).unwrap();
    assert_eq!(tables.as_array().map(Vec::len), Some(3));
    assert_eq!(tables[0], "comments");
    assert_eq!(tables[2], "tasks");

    assert!(syncular_native_client_open_async_close(
        open_handle,
        &mut error
    ));
    assert!(syncular_native_client_close(handle, &mut error));
    assert!(error.is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn native_ffi_covers_handle_lifecycle_and_json_methods() {
    let path = temp_db_path("syncular-native-ffi");
    let mut error = ptr::null_mut();
    let config = ffi_config(&path, "native-ffi");

    let handle = syncular_native_client_open(config.as_ptr(), false, &mut error);
    assert!(!handle.is_null());
    assert!(error.is_null());
    assert!(syncular_native_client_sync_worker_running(
        handle, &mut error
    ));
    assert!(syncular_native_client_pause_sync_worker(handle, &mut error));
    assert!(!syncular_native_client_sync_worker_running(
        handle, &mut error
    ));
    assert!(syncular_native_client_resume_sync_worker(
        handle, &mut error
    ));
    assert!(syncular_native_client_sync_worker_running(
        handle, &mut error
    ));
    let events = FfiEventStream::subscribe(handle);

    let auth_headers = CString::new(
        json!({
            "authorization": "Bearer native-ffi-token"
        })
        .to_string(),
    )
    .unwrap();
    assert!(syncular_native_client_set_auth_headers_json(
        handle,
        auth_headers.as_ptr(),
        &mut error
    ));
    assert!(error.is_null());

    let encryption_config = CString::new(
        json!({
            "rules": [
                { "scope": "tasks", "table": "tasks", "fields": ["title"] }
            ],
            "keys": {
                "default": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
            }
        })
        .to_string(),
    )
    .unwrap();
    assert!(syncular_native_client_set_field_encryption_json(
        handle,
        encryption_config.as_ptr(),
        &mut error
    ));
    assert!(error.is_null());

    let encrypted_crdt_config = CString::new(
        json!({
            "keys": {
                "default": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
            }
        })
        .to_string(),
    )
    .unwrap();
    assert!(syncular_native_client_set_encrypted_crdt_json(
        handle,
        encrypted_crdt_config.as_ptr(),
        &mut error
    ));
    assert!(error.is_null());

    let method = CString::new("generateSymmetricKey").unwrap();
    let args = CString::new("{}").unwrap();
    let helper_result =
        syncular_native_encryption_helper_json(method.as_ptr(), args.as_ptr(), &mut error);
    let generated_key = take_string(helper_result);
    assert!(error.is_null());
    assert!(!generated_key.is_empty());

    let query = CString::new(
        json!({
            "id": "ffi-task-list",
            "tables": ["tasks"],
            "label": "FFI task list"
        })
        .to_string(),
    )
    .unwrap();
    let query_id = syncular_native_client_register_query_json(handle, query.as_ptr(), &mut error);
    assert_eq!(take_string(query_id), "ffi-task-list");
    assert!(error.is_null());

    let observed_json = syncular_native_client_observed_queries_json(handle, &mut error);
    let observed: Value = serde_json::from_str(&take_string(observed_json)).unwrap();
    assert_eq!(observed.as_array().map(Vec::len), Some(1));
    assert_eq!(observed[0]["id"], "ffi-task-list");
    assert_eq!(observed[0]["tables"][0], "tasks");
    assert!(error.is_null());

    let operation = CString::new(
        json!({
            "table": "tasks",
            "row_id": "ffi-task",
            "op": "upsert",
            "payload": {
                "title": "FFI task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
    )
    .unwrap();
    let returned_id = syncular_native_client_apply_mutation_json(
        handle,
        operation.as_ptr(),
        ptr::null(),
        &mut error,
    );
    assert!(!take_string(returned_id).is_empty());
    assert!(error.is_null());

    let table = CString::new("tasks").unwrap();
    let tasks_json = syncular_native_client_list_table_json(handle, table.as_ptr(), &mut error);
    let tasks: Value = serde_json::from_str(&take_string(tasks_json)).unwrap();
    assert_eq!(tasks.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks[0]["id"], "ffi-task");
    assert_eq!(tasks[0]["title"], "FFI task");

    let request = CString::new(
        json!({
            "sql": "select id, title from tasks where id = ?",
            "params": ["ffi-task"],
            "tables": ["tasks"]
        })
        .to_string(),
    )
    .unwrap();
    let query_json = syncular_native_client_query_json(handle, request.as_ptr(), &mut error);
    let query_result: Value = serde_json::from_str(&take_string(query_json)).unwrap();
    assert_eq!(query_result["rows"].as_array().map(Vec::len), Some(1));
    assert_eq!(query_result["rows"][0]["id"], "ffi-task");
    assert_eq!(query_result["rows"][0]["title"], "FFI task");
    assert!(error.is_null());

    let request = CString::new(
        json!({
            "sql": "delete from tasks where id = ?",
            "params": ["ffi-task"],
            "tables": ["tasks"]
        })
        .to_string(),
    )
    .unwrap();
    let query_json = syncular_native_client_query_json(handle, request.as_ptr(), &mut error);
    assert!(query_json.is_null());
    let error_value: Value = serde_json::from_str(&take_string(error)).unwrap();
    assert_eq!(error_value["kind"], "Config");
    assert!(error_value["message"]
        .as_str()
        .unwrap()
        .contains("queryJson only allows read-only SELECT statements"));

    let app_tables_json = syncular_native_client_app_tables_json(handle, &mut error);
    let app_tables: Value = serde_json::from_str(&take_string(app_tables_json)).unwrap();
    assert_eq!(app_tables.as_array().map(Vec::len), Some(3));
    assert_eq!(app_tables[0], "comments");
    assert_eq!(app_tables[1], "projects");
    assert_eq!(app_tables[2], "tasks");

    let metadata_json = syncular_native_client_app_table_metadata_json(handle, &mut error);
    let metadata: Value = serde_json::from_str(&take_string(metadata_json)).unwrap();
    assert_eq!(metadata.as_array().map(Vec::len), Some(3));
    assert_eq!(metadata[0]["name"], "comments");
    assert_eq!(metadata[0]["primary_key_column"], "id");
    assert_eq!(metadata[0]["server_version_column"], "server_version");
    assert_eq!(metadata[0]["subscription_id"], "sub-comments");
    assert_eq!(metadata[0]["scopes"][0]["source"], "actorId");
    assert_eq!(metadata[1]["name"], "projects");
    assert_eq!(metadata[1]["subscription_id"], "sub-projects");
    assert_eq!(metadata[2]["name"], "tasks");
    assert_eq!(metadata[2]["subscription_id"], "sub-tasks");

    let table = CString::new("tasks").unwrap();
    let table_json = syncular_native_client_list_table_json(handle, table.as_ptr(), &mut error);
    let table_rows: Value = serde_json::from_str(&take_string(table_json)).unwrap();
    assert_eq!(table_rows.as_array().map(Vec::len), Some(1));
    assert_eq!(table_rows[0]["id"], "ffi-task");

    let table = CString::new("sync_outbox_commits").unwrap();
    let table_json = syncular_native_client_list_table_json(handle, table.as_ptr(), &mut error);
    assert!(table_json.is_null());
    let error_value: Value = serde_json::from_str(&take_string(error)).unwrap();
    assert_eq!(error_value["kind"], "Config");
    assert_eq!(
        error_value["message"],
        "unknown generated app table: sync_outbox_commits"
    );
    assert!(error_value["debug"]
        .as_str()
        .unwrap()
        .starts_with("Config: "));

    let outbox_json = syncular_native_client_outbox_summaries_json(handle, &mut error);
    let outbox: Value = serde_json::from_str(&take_string(outbox_json)).unwrap();
    assert_eq!(outbox.as_array().map(Vec::len), Some(1));
    assert_eq!(outbox[0]["status"], "pending");

    let local_event: Value =
        serde_json::from_str(&events.next_json(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(local_event["kind"], "RowsChanged");
    assert_eq!(local_event["tables"][0], "tasks");
    assert_eq!(local_event["changedRows"][0]["table"], "tasks");
    assert_eq!(local_event["changedRows"][0]["rowId"], "ffi-task");
    assert_eq!(local_event["changedRows"][0]["operation"], "insert");
    assert!(local_event["changedRows"][0]["changedFields"]
        .as_array()
        .is_some_and(|fields| fields.iter().any(|field| field == "title")));
    assert_eq!(local_event["queries"].as_array().map(Vec::len), Some(0));
    assert!(error.is_null());

    let query_event: Value =
        serde_json::from_str(&events.next_json(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(query_event["kind"], "QueriesChanged");
    assert_eq!(query_event["tables"][0], "tasks");
    assert_eq!(query_event["queries"][0], "ffi-task-list");
    assert!(error.is_null());

    let query_id = CString::new("ffi-task-list").unwrap();
    assert!(syncular_native_client_unregister_query(
        handle,
        query_id.as_ptr(),
        &mut error
    ));
    assert!(error.is_null());

    assert!(events.next_json(Duration::from_millis(10)).is_none());
    assert!(error.is_null());

    assert!(syncular_native_client_trigger_sync(handle, &mut error));
    let event: Value =
        serde_json::from_str(&events.next_json(Duration::from_secs(5)).unwrap()).unwrap();
    assert_eq!(event["kind"], "SyncFailed");
    assert_eq!(event["error"]["kind"], "Transport");
    assert!(event["error"]["message"].as_str().unwrap().len() > 10);
    assert!(event["error"]["debug"]
        .as_str()
        .unwrap()
        .starts_with("Transport: "));

    events.close();
    assert!(syncular_native_client_close(handle, &mut error));
    assert!(error.is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn native_ffi_exposes_generic_crdt_field_methods() {
    let path = temp_db_path("syncular-native-ffi-crdt-field");
    let mut error = ptr::null_mut();
    let config = ffi_config(&path, "native-ffi-crdt-field");

    let handle = syncular_native_client_open(config.as_ptr(), false, &mut error);
    assert!(!handle.is_null());
    assert!(error.is_null());
    let events = FfiEventStream::subscribe(handle);

    let operation = CString::new(
        json!({
            "table": "tasks",
            "row_id": "ffi-crdt-task",
            "op": "upsert",
            "payload": {
                "title": "",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
    )
    .unwrap();
    let returned_id = syncular_native_client_apply_mutation_json(
        handle,
        operation.as_ptr(),
        ptr::null(),
        &mut error,
    );
    assert!(!take_string(returned_id).is_empty());
    assert!(error.is_null());

    let _ = events.next_json(Duration::from_secs(1));
    assert!(error.is_null());

    let request = CString::new(
        json!({
            "table": "tasks",
            "rowId": "ffi-crdt-task",
            "field": "title"
        })
        .to_string(),
    )
    .unwrap();
    let descriptor_json =
        syncular_native_client_open_crdt_field_json(handle, request.as_ptr(), &mut error);
    let descriptor: Value = serde_json::from_str(&take_string(descriptor_json)).unwrap();
    assert_eq!(descriptor["table"], "tasks");
    assert_eq!(descriptor["field"], "title");
    assert_eq!(descriptor["syncMode"], "server-merge");
    assert!(error.is_null());

    let update_request = CString::new(
        json!({
            "table": "tasks",
            "rowId": "ffi-crdt-task",
            "field": "title",
            "nextText": "FFI CRDT field"
        })
        .to_string(),
    )
    .unwrap();
    let receipt_json = syncular_native_client_apply_crdt_field_text_json(
        handle,
        update_request.as_ptr(),
        &mut error,
    );
    if receipt_json.is_null() {
        panic!("apply_crdt_field_text_json failed: {}", take_string(error));
    }
    let receipt: Value = serde_json::from_str(&take_string(receipt_json)).unwrap();
    assert_eq!(receipt["syncMode"], "server-merge");
    assert!(receipt["clientCommitId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert!(error.is_null());

    let materialized_json =
        syncular_native_client_materialize_crdt_field_json(handle, request.as_ptr(), &mut error);
    let materialized: Value = serde_json::from_str(&take_string(materialized_json)).unwrap();
    assert_eq!(materialized["value"], "FFI CRDT field");
    assert!(materialized["stateVectorBase64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(error.is_null());

    let mut saw_crdt_field_changed = false;
    let mut saw_rows_changed = false;
    for _ in 0..3 {
        let Some(event_json) = events.next_json(Duration::from_millis(10)) else {
            break;
        };
        let event: Value = serde_json::from_str(&event_json).unwrap();
        match event["kind"].as_str() {
            Some("CrdtFieldChanged") => {
                saw_crdt_field_changed = true;
                assert_eq!(event["tables"][0], "tasks");
                assert_eq!(event["payload_json"]["field"], "title");
                assert_eq!(event["payload_json"]["syncMode"], "server-merge");
                assert_eq!(event["payload_json"]["materializationAvailable"], true);
                assert_eq!(event["payload_json"]["hasState"], true);
                assert!(event["payload_json"]["stateVectorBase64"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()));
            }
            Some("RowsChanged") => {
                saw_rows_changed = true;
                assert_eq!(event["tables"][0], "tasks");
                assert_eq!(event["changedRows"][0]["table"], "tasks");
                assert_eq!(event["changedRows"][0]["rowId"], "ffi-crdt-task");
                assert_eq!(event["changedRows"][0]["operation"], "update");
                assert!(event["changedRows"][0]["crdtFields"]
                    .as_array()
                    .is_some_and(|fields| fields.iter().any(|field| field == "title_yjs_state")));
            }
            _ => {}
        }
    }
    assert!(saw_crdt_field_changed);
    assert!(saw_rows_changed);

    events.close();
    assert!(syncular_native_client_close(handle, &mut error));
    assert!(error.is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn native_ffi_stages_blob_files_locally() {
    let path = temp_db_path("syncular-native-ffi-blobs");
    let input_path = temp_file_path("syncular-native-ffi-blob-input");
    let output_path = temp_file_path("syncular-native-ffi-blob-output");
    std::fs::write(&input_path, [1u8, 2, 3, 4]).unwrap();

    let mut error = ptr::null_mut();
    let config = CString::new(
        json!({
            "db_path": path,
            "base_url": "http://127.0.0.1:9/sync",
            "client_id": "native-ffi-blobs",
            "actor_id": "user-rust",
            "project_id": "p0"
        })
        .to_string(),
    )
    .unwrap();
    let handle = syncular_native_client_open(config.as_ptr(), false, &mut error);
    assert!(!handle.is_null());

    let input = CString::new(input_path.clone()).unwrap();
    let options = CString::new(json!({ "mimeType": "application/test" }).to_string()).unwrap();
    let ref_json = syncular_native_client_store_blob_file_json(
        handle,
        input.as_ptr(),
        options.as_ptr(),
        &mut error,
    );
    assert!(error.is_null());
    let blob: Value = serde_json::from_str(&take_string(ref_json)).unwrap();
    assert_eq!(blob["size"], 4);
    assert_eq!(blob["mimeType"], "application/test");
    assert!(blob["hash"].as_str().unwrap().starts_with("sha256:"));

    let cache_stats = syncular_native_client_blob_cache_stats_json(handle, &mut error);
    let cache_stats: Value = serde_json::from_str(&take_string(cache_stats)).unwrap();
    assert_eq!(cache_stats["count"], 1);
    assert_eq!(cache_stats["totalBytes"], 4);

    let queue_stats = syncular_native_client_blob_upload_queue_stats_json(handle, &mut error);
    let queue_stats: Value = serde_json::from_str(&take_string(queue_stats)).unwrap();
    assert_eq!(queue_stats["pending"], 1);
    assert_eq!(queue_stats["uploading"], 0);
    assert_eq!(queue_stats["failed"], 0);

    let process_result = syncular_native_client_process_blob_upload_queue_json(handle, &mut error);
    let process_result: Value = serde_json::from_str(&take_string(process_result)).unwrap();
    assert_eq!(process_result["uploaded"], 0);
    assert_eq!(process_result["failed"], 0);

    let ref_c = CString::new(blob.to_string()).unwrap();
    let output = CString::new(output_path.clone()).unwrap();
    assert!(syncular_native_client_retrieve_blob_file(
        handle,
        ref_c.as_ptr(),
        output.as_ptr(),
        &mut error
    ));
    assert_eq!(std::fs::read(&output_path).unwrap(), vec![1u8, 2, 3, 4]);

    assert!(syncular_native_client_clear_blob_cache(handle, &mut error));
    let cache_stats = syncular_native_client_blob_cache_stats_json(handle, &mut error);
    let cache_stats: Value = serde_json::from_str(&take_string(cache_stats)).unwrap();
    assert_eq!(cache_stats["count"], 0);

    let compaction = syncular_native_client_compact_storage_json(handle, ptr::null(), &mut error);
    assert!(error.is_null());
    let compaction: Value = serde_json::from_str(&take_string(compaction)).unwrap();
    assert_eq!(compaction["ackedOutboxCommitsDeleted"], 0);
    assert_eq!(compaction["blobCacheBytesPruned"], 0);

    assert!(syncular_native_client_close(handle, &mut error));
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(input_path);
    let _ = std::fs::remove_file(output_path);
}

#[test]
fn native_ffi_writes_structured_errors() {
    let mut error = ptr::null_mut();
    let result = syncular_native_client_app_tables_json(ptr::null_mut(), &mut error);

    assert!(result.is_null());
    let error_value: Value = serde_json::from_str(&take_string(error)).unwrap();
    assert_eq!(error_value["kind"], "Config");
    assert_eq!(error_value["message"], "native handle is null");
    assert_eq!(error_value["debug"], "Config: native handle is null");

    let conflict_id = CString::new("missing-conflict").unwrap();
    let retry = syncular_native_client_retry_conflict_keep_local(
        ptr::null_mut(),
        conflict_id.as_ptr(),
        &mut error,
    );
    assert!(retry.is_null());
    let error_value: Value = serde_json::from_str(&take_string(error)).unwrap();
    assert_eq!(error_value["kind"], "Config");
    assert_eq!(error_value["message"], "native handle is null");
}

#[test]
fn native_ffi_applies_generic_local_operation_json() {
    let path = temp_db_path("syncular-native-ffi-generic-operation");
    let mut error = ptr::null_mut();
    let config = ffi_config(&path, "native-ffi-generic-operation");
    let handle = syncular_native_client_open(config.as_ptr(), false, &mut error);
    assert!(!handle.is_null());
    let events = FfiEventStream::subscribe(handle);

    let operation = CString::new(
        json!({
            "table": "tasks",
            "row_id": "ffi-generic-task",
            "op": "upsert",
            "payload": {
                "title": "FFI generic task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
    )
    .unwrap();
    let commit_id = syncular_native_client_apply_local_operation_json(
        handle,
        operation.as_ptr(),
        ptr::null(),
        &mut error,
    );
    assert!(!take_string(commit_id).is_empty());

    let table = CString::new("tasks").unwrap();
    let rows = syncular_native_client_list_table_json(handle, table.as_ptr(), &mut error);
    let rows: Value = serde_json::from_str(&take_string(rows)).unwrap();
    assert_eq!(rows.as_array().map(Vec::len), Some(1));
    assert_eq!(rows[0]["id"], "ffi-generic-task");

    let local_event: Value =
        serde_json::from_str(&events.next_json(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(local_event["kind"], "RowsChanged");
    assert_eq!(local_event["tables"][0], "tasks");
    assert_eq!(local_event["changedRows"][0]["table"], "tasks");
    assert_eq!(local_event["changedRows"][0]["rowId"], "ffi-generic-task");
    assert_eq!(local_event["changedRows"][0]["operation"], "insert");

    let update = CString::new(
        json!({
            "table": "tasks",
            "row_id": "ffi-generic-task",
            "op": "upsert",
            "payload": {
                "title": "FFI generic task updated"
            },
            "base_version": 0
        })
        .to_string(),
    )
    .unwrap();
    let commit_id = syncular_native_client_apply_local_operation_json(
        handle,
        update.as_ptr(),
        ptr::null(),
        &mut error,
    );
    assert!(!take_string(commit_id).is_empty());
    let update_event: Value =
        serde_json::from_str(&events.next_json(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(update_event["kind"], "RowsChanged");
    assert_eq!(update_event["changedRows"][0]["operation"], "update");
    assert_eq!(update_event["changedRows"][0]["changedFields"][0], "title");

    events.close();
    assert!(syncular_native_client_close(handle, &mut error));
    let _ = std::fs::remove_file(path);
}

#[test]
fn native_ffi_event_callback_subscription_does_not_hold_handle_lock() {
    let path = temp_db_path("syncular-native-ffi-event-callback-lock");
    let mut error = ptr::null_mut();
    let config = ffi_config(&path, "native-ffi-event-callback-lock");

    let handle = syncular_native_client_open(config.as_ptr(), false, &mut error);
    assert!(!handle.is_null());
    assert!(error.is_null());

    let events = FfiEventStream::subscribe(handle);
    let started = Instant::now();
    assert!(syncular_native_client_sync_worker_running(
        handle, &mut error
    ));
    assert!(error.is_null());
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "event callback subscription held the native handle lock"
    );

    events.close();
    assert!(syncular_native_client_close(handle, &mut error));
    assert!(error.is_null());
    let _ = std::fs::remove_file(path);
}

struct FfiEventStream {
    handle: *mut SyncularNativeEventSubscription,
    user_data: *mut c_void,
    rx: Receiver<String>,
}

impl FfiEventStream {
    fn subscribe(handle: *mut SyncularNativeHandle) -> Self {
        let (tx, rx) = mpsc::channel::<String>();
        let user_data = Box::into_raw(Box::new(tx)) as *mut c_void;
        let mut error = ptr::null_mut();
        let subscription = syncular_native_client_subscribe_events_json(
            handle,
            256,
            Some(native_event_callback),
            Some(native_event_error_callback),
            user_data,
            &mut error,
        );
        assert!(error.is_null());
        assert!(!subscription.is_null());
        Self {
            handle: subscription,
            user_data,
            rx,
        }
    }

    fn next_json(&self, timeout: Duration) -> Option<String> {
        self.rx.recv_timeout(timeout).ok()
    }

    fn close(self) {
        let mut error = ptr::null_mut();
        assert!(syncular_native_event_subscription_close(
            self.handle,
            &mut error
        ));
        assert!(error.is_null());
        unsafe {
            drop(Box::from_raw(self.user_data as *mut Sender<String>));
        }
    }
}

extern "C" fn native_event_callback(event_json: *const c_char, user_data: *mut c_void) {
    if event_json.is_null() || user_data.is_null() {
        return;
    }
    let event_json = unsafe { CStr::from_ptr(event_json) }
        .to_str()
        .expect("event json utf8")
        .to_string();
    let tx = unsafe { &*(user_data as *const Sender<String>) };
    let _ = tx.send(event_json);
}

extern "C" fn native_event_error_callback(error_json: *const c_char, user_data: *mut c_void) {
    native_event_callback(error_json, user_data);
}

fn ffi_config(path: &str, client_id: &str) -> CString {
    CString::new(
        json!({
            "db_path": path,
            "base_url": "http://127.0.0.1:9/sync",
            "client_id": client_id,
            "actor_id": "user-rust",
            "project_id": "p0",
            "app_schema_json": todo_app_schema_json()
        })
        .to_string(),
    )
    .unwrap()
}

fn take_string(value: *mut c_char) -> String {
    assert!(!value.is_null());
    let output = unsafe { CStr::from_ptr(value) }
        .to_str()
        .unwrap()
        .to_string();
    syncular_string_free(value);
    output
}

fn temp_db_path(prefix: &str) -> String {
    unique_temp_db_path(prefix)
}

fn temp_file_path(prefix: &str) -> String {
    unique_temp_file_path(prefix)
}
