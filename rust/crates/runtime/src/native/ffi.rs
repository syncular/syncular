use crate::error::{ErrorKind, Result, SyncularError};
use crate::native::{
    native_runtime_manifest_json, NativeClientConfig, NativeClientOpenTask, NativeClientOptions,
    NativeErrorInfo, NativeEventSubscription, NativeSyncularClient,
};
use std::any::Any;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct SyncularNativeHandle {
    client: Mutex<NativeSyncularClient>,
}

pub struct SyncularNativeOpenHandle {
    task: Mutex<NativeClientOpenTask>,
}

pub struct SyncularNativeEventSubscription {
    subscription: Arc<NativeEventSubscription>,
    join: Mutex<Option<JoinHandle<()>>>,
}

pub struct SyncularNativePresenceHandle {
    client: *mut SyncularNativeHandle,
    scope_key: String,
    active: Mutex<bool>,
}

pub type SyncularNativeEventCallback =
    extern "C" fn(event_json: *const c_char, user_data: *mut c_void);
pub type SyncularNativeEventErrorCallback =
    extern "C" fn(error_json: *const c_char, user_data: *mut c_void);

#[no_mangle]
pub extern "C" fn syncular_string_free(value: *mut c_char) {
    if value.is_null() {
        return;
    }

    unsafe {
        let _ = CString::from_raw(value);
    }
}

#[no_mangle]
pub extern "C" fn syncular_native_runtime_manifest_json(
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, native_runtime_manifest_json)
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open(
    config_json: *const c_char,
    auto_sync_local_writes: bool,
    error_out: *mut *mut c_char,
) -> *mut SyncularNativeHandle {
    clear_error(error_out);
    ffi_catch_ptr(error_out, || {
        let config: NativeClientConfig = serde_json::from_str(&read_c_string(config_json)?)?;
        let client = NativeSyncularClient::open_native_with_options(
            config,
            NativeClientOptions {
                auto_sync_local_writes,
            },
        )?;
        Ok(Box::into_raw(Box::new(SyncularNativeHandle {
            client: Mutex::new(client),
        })))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open_async(
    config_json: *const c_char,
    auto_sync_local_writes: bool,
    error_out: *mut *mut c_char,
) -> *mut SyncularNativeOpenHandle {
    clear_error(error_out);
    ffi_catch_ptr(error_out, || {
        let config: NativeClientConfig = serde_json::from_str(&read_c_string(config_json)?)?;
        let task = NativeSyncularClient::open_native_async_with_options(
            config,
            NativeClientOptions {
                auto_sync_local_writes,
            },
        );
        Ok(Box::into_raw(Box::new(SyncularNativeOpenHandle {
            task: Mutex::new(task),
        })))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open_async_command_id(
    handle: *mut SyncularNativeOpenHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_open_task(handle, |task| Ok(task.command_id().to_string()))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open_async_is_finished(
    handle: *mut SyncularNativeOpenHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool_value(error_out, || {
        with_open_task(handle, |task| Ok(task.is_finished()))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open_async_finish_timeout(
    handle: *mut SyncularNativeOpenHandle,
    timeout_ms: u64,
    error_out: *mut *mut c_char,
) -> *mut SyncularNativeHandle {
    clear_error(error_out);
    ffi_catch_ptr(error_out, || {
        with_open_task(handle, |task| {
            match task.take_client_timeout(Duration::from_millis(timeout_ms)) {
                Some(Ok(client)) => Ok(Box::into_raw(Box::new(SyncularNativeHandle {
                    client: Mutex::new(client),
                }))),
                Some(Err(error)) => Err(error),
                None => Ok(ptr::null_mut()),
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open_async_close(
    handle: *mut SyncularNativeOpenHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        if handle.is_null() {
            return Ok(());
        }

        let _ = unsafe { Box::from_raw(handle) };
        Ok(())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_close(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        if handle.is_null() {
            return Ok(());
        }

        let boxed = unsafe { Box::from_raw(handle) };
        let mut client = boxed.client.into_inner().map_err(|_| {
            SyncularError::message(ErrorKind::Internal, "native handle is poisoned")
        })?;
        client.close()
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_trigger_sync(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.trigger_sync())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_trigger_sync_websocket(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.trigger_sync_websocket())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_pause_sync_worker(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.pause_sync_worker())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_resume_sync_worker(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.resume_sync_worker())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_resume_from_background(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.resume_from_background())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_sync_worker_running(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool_value(error_out, || {
        with_client(handle, |client| Ok(client.sync_worker_running()))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_start_realtime_worker(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.start_realtime_worker())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_start(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    syncular_native_client_start_realtime_worker(handle, error_out)
}

#[no_mangle]
pub extern "C" fn syncular_native_client_stop_realtime_worker(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.stop_realtime_worker())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_stop(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    syncular_native_client_stop_realtime_worker(handle, error_out)
}

#[no_mangle]
pub extern "C" fn syncular_native_client_join_presence(
    handle: *mut SyncularNativeHandle,
    scope_key: *const c_char,
    metadata_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let scope_key = read_c_string(scope_key)?;
        let metadata = read_optional_c_string(metadata_json)?
            .map(|json| serde_json::from_str(&json))
            .transpose()?;
        with_client(handle, |client| client.join_presence(&scope_key, metadata))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_leave_presence(
    handle: *mut SyncularNativeHandle,
    scope_key: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let scope_key = read_c_string(scope_key)?;
        with_client(handle, |client| client.leave_presence(&scope_key))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_update_presence_metadata(
    handle: *mut SyncularNativeHandle,
    scope_key: *const c_char,
    metadata_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let scope_key = read_c_string(scope_key)?;
        let metadata_json = read_c_string(metadata_json)?;
        let metadata = serde_json::from_str(&metadata_json)?;
        with_client(handle, |client| {
            client.update_presence_metadata(&scope_key, metadata)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_presence_json(
    handle: *mut SyncularNativeHandle,
    scope_key: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let scope_key = read_c_string(scope_key)?;
        with_client(handle, |client| client.presence_json(&scope_key))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_join_presence_handle(
    handle: *mut SyncularNativeHandle,
    scope_key: *const c_char,
    metadata_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut SyncularNativePresenceHandle {
    clear_error(error_out);
    ffi_catch_ptr(error_out, || {
        let scope_key = read_c_string(scope_key)?;
        let metadata = read_optional_c_string(metadata_json)?
            .map(|json| serde_json::from_str(&json))
            .transpose()?;
        with_client(handle, |client| client.join_presence(&scope_key, metadata))?;
        Ok(Box::into_raw(Box::new(SyncularNativePresenceHandle {
            client: handle,
            scope_key,
            active: Mutex::new(true),
        })))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_presence_handle_scope_key(
    handle: *mut SyncularNativePresenceHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_presence_handle(handle, |presence| Ok(presence.scope_key.clone()))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_presence_handle_update_metadata(
    handle: *mut SyncularNativePresenceHandle,
    metadata_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let metadata_json = read_c_string(metadata_json)?;
        let metadata = serde_json::from_str(&metadata_json)?;
        with_presence_handle(handle, |presence| {
            let active = presence.active.lock().map_err(|_| {
                SyncularError::message(ErrorKind::Internal, "native presence handle is poisoned")
            })?;
            if !*active {
                return Err(SyncularError::message(
                    ErrorKind::Config,
                    "native presence handle is inactive",
                ));
            }
            with_client(presence.client, |client| {
                client.update_presence_metadata(&presence.scope_key, metadata)
            })
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_presence_handle_leave(
    handle: *mut SyncularNativePresenceHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool_value(error_out, || {
        with_presence_handle(handle, leave_presence_handle_inner)
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_presence_handle_close(
    handle: *mut SyncularNativePresenceHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        if handle.is_null() {
            return Ok(());
        }

        let presence = unsafe { Box::from_raw(handle) };
        let _ = leave_presence_handle_inner(&presence)?;
        Ok(())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_set_auth_headers_json(
    handle: *mut SyncularNativeHandle,
    headers_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let headers_json = read_c_string(headers_json)?;
        with_client(handle, |client| client.set_auth_headers_json(&headers_json))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_set_subscriptions_json(
    handle: *mut SyncularNativeHandle,
    subscriptions_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let subscriptions_json = read_c_string(subscriptions_json)?;
        with_client(handle, |client| {
            client.set_subscriptions_json(&subscriptions_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_force_subscriptions_bootstrap_json(
    handle: *mut SyncularNativeHandle,
    subscription_ids_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let subscription_ids_json = read_c_string(subscription_ids_json)?;
        with_client(handle, |client| {
            client.force_subscriptions_bootstrap_json(&subscription_ids_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_set_field_encryption_json(
    handle: *mut SyncularNativeHandle,
    config_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let config_json = read_c_string(config_json)?;
        with_client(handle, |client| {
            client.set_field_encryption_json(&config_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_set_encrypted_crdt_json(
    handle: *mut SyncularNativeHandle,
    config_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let config_json = read_c_string(config_json)?;
        with_client(handle, |client| {
            client.set_encrypted_crdt_json(&config_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_encryption_helper_json(
    method: *const c_char,
    args_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let method = read_c_string(method)?;
        let args_json = read_c_string(args_json)?;
        crate::encryption::encryption_helpers_json(&method, &args_json)
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_apply_mutation_json(
    handle: *mut SyncularNativeHandle,
    mutation_json: *const c_char,
    local_row_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let mutation_json = read_c_string(mutation_json)?;
        let local_row_json = read_optional_c_string(local_row_json)?;
        with_client(handle, |client| {
            client.apply_mutation_json(&mutation_json, local_row_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_apply_leased_mutation_json(
    handle: *mut SyncularNativeHandle,
    mutation_json: *const c_char,
    local_row_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let mutation_json = read_c_string(mutation_json)?;
        let local_row_json = read_optional_c_string(local_row_json)?;
        with_client(handle, |client| {
            client.apply_leased_mutation_json(&mutation_json, local_row_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_mutation_json(
    handle: *mut SyncularNativeHandle,
    mutation_json: *const c_char,
    local_row_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let mutation_json = read_c_string(mutation_json)?;
        let local_row_json = read_optional_c_string(local_row_json)?;
        with_client(handle, |client| {
            client.enqueue_mutation_json(&mutation_json, local_row_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_leased_mutation_json(
    handle: *mut SyncularNativeHandle,
    mutation_json: *const c_char,
    local_row_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let mutation_json = read_c_string(mutation_json)?;
        let local_row_json = read_optional_c_string(local_row_json)?;
        with_client(handle, |client| {
            client.enqueue_leased_mutation_json(&mutation_json, local_row_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_yjs_update_json(
    handle: *mut SyncularNativeHandle,
    update_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let update_json = read_c_string(update_json)?;
        with_client(handle, |client| {
            client.enqueue_yjs_update_json(&update_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_open_crdt_field_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| client.open_crdt_field_json(&request_json))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_apply_crdt_field_text_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.apply_crdt_field_text_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_apply_crdt_field_yjs_update_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.apply_crdt_field_yjs_update_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_crdt_field_yjs_update_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.enqueue_crdt_field_yjs_update_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_crdt_field_text_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.enqueue_crdt_field_text_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_crdt_field_compaction_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.enqueue_crdt_field_compaction_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_materialize_crdt_field_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.materialize_crdt_field_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_crdt_document_snapshot_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.crdt_document_snapshot_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_crdt_update_log_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| client.crdt_update_log_json(&request_json))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_snapshot_crdt_field_state_vector_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.snapshot_crdt_field_state_vector_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_compact_crdt_field_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.compact_crdt_field_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_apply_encrypted_crdt_update_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.apply_encrypted_crdt_update_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_encrypted_crdt_update_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.enqueue_encrypted_crdt_update_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_apply_encrypted_crdt_checkpoint_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.apply_encrypted_crdt_checkpoint_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_encrypted_crdt_checkpoint_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.enqueue_encrypted_crdt_checkpoint_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_sync_now(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.enqueue_sync_now())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_sync_websocket(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.enqueue_sync_websocket())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_app_tables_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.app_tables_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_app_table_metadata_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.app_table_metadata_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_app_schema_state_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.app_schema_state_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_list_table_json(
    handle: *mut SyncularNativeHandle,
    table: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let table = read_c_string(table)?;
        with_client(handle, |client| client.list_table_json(&table))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_query_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| client.query_json(&request_json))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_refresh_snapshot_json(
    handle: *mut SyncularNativeHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let request_json = read_c_string(request_json)?;
        with_client(handle, |client| {
            client.enqueue_refresh_snapshot_json(&request_json)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_store_blob_file_json(
    handle: *mut SyncularNativeHandle,
    file_path: *const c_char,
    options_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let file_path = read_c_string(file_path)?;
        let options_json = read_optional_c_string(options_json)?;
        with_client(handle, |client| {
            client.store_blob_file_json(&file_path, options_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_store_blob_file_json(
    handle: *mut SyncularNativeHandle,
    file_path: *const c_char,
    options_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let file_path = read_c_string(file_path)?;
        let options_json = read_optional_c_string(options_json)?;
        with_client(handle, |client| {
            client.enqueue_store_blob_file_json(&file_path, options_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_retrieve_blob_file(
    handle: *mut SyncularNativeHandle,
    ref_json: *const c_char,
    file_path: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let ref_json = read_c_string(ref_json)?;
        let file_path = read_c_string(file_path)?;
        with_client(handle, |client| {
            client.retrieve_blob_file(&ref_json, &file_path)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_retrieve_blob_file_with_options(
    handle: *mut SyncularNativeHandle,
    ref_json: *const c_char,
    file_path: *const c_char,
    options_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let ref_json = read_c_string(ref_json)?;
        let file_path = read_c_string(file_path)?;
        let options_json = read_optional_c_string(options_json)?;
        with_client(handle, |client| {
            client.retrieve_blob_file_with_options(&ref_json, &file_path, options_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_retrieve_blob_file_json(
    handle: *mut SyncularNativeHandle,
    ref_json: *const c_char,
    file_path: *const c_char,
    options_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let ref_json = read_c_string(ref_json)?;
        let file_path = read_c_string(file_path)?;
        let options_json = read_optional_c_string(options_json)?;
        with_client(handle, |client| {
            client.enqueue_retrieve_blob_file_json(&ref_json, &file_path, options_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_is_blob_local(
    handle: *mut SyncularNativeHandle,
    hash: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool_value(error_out, || {
        let hash = read_c_string(hash)?;
        with_client(handle, |client| client.is_blob_local(&hash))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_process_blob_upload_queue_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.process_blob_upload_queue_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_process_blob_upload_queue(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.enqueue_process_blob_upload_queue())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_blob_upload_queue_stats_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.blob_upload_queue_stats_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_blob_cache_stats_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.blob_cache_stats_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_prune_blob_cache(
    handle: *mut SyncularNativeHandle,
    max_bytes: i64,
    error_out: *mut *mut c_char,
) -> i64 {
    clear_error(error_out);
    ffi_catch_i64(error_out, || {
        with_client(handle, |client| client.prune_blob_cache(max_bytes))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_prune_blob_cache(
    handle: *mut SyncularNativeHandle,
    max_bytes: i64,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.enqueue_prune_blob_cache(max_bytes))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_clear_blob_cache(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        with_client(handle, |client| client.clear_blob_cache())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_clear_blob_cache(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.enqueue_clear_blob_cache())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_compact_storage_json(
    handle: *mut SyncularNativeHandle,
    options_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let options_json = read_optional_c_string(options_json)?;
        with_client(handle, |client| {
            client.compact_storage_json(options_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_compact_storage_json(
    handle: *mut SyncularNativeHandle,
    options_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let options_json = read_optional_c_string(options_json)?;
        with_client(handle, |client| {
            client.enqueue_compact_storage_json(options_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_register_query_json(
    handle: *mut SyncularNativeHandle,
    query_json: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let query_json = read_c_string(query_json)?;
        with_client(handle, |client| client.register_query_json(&query_json))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_unregister_query(
    handle: *mut SyncularNativeHandle,
    query_id: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let query_id = read_c_string(query_id)?;
        with_client(handle, |client| client.unregister_query(&query_id))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_observed_queries_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.observed_queries_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_diagnostic_snapshot_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.diagnostic_snapshot_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_outbox_summaries_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.outbox_summaries_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_upsert_auth_lease_json(
    handle: *mut SyncularNativeHandle,
    lease_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let lease_json = read_c_string(lease_json)?;
        with_client(handle, |client| client.upsert_auth_lease_json(&lease_json))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_auth_lease_json(
    handle: *mut SyncularNativeHandle,
    lease_id: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let lease_id = read_c_string(lease_id)?;
        with_client(handle, |client| client.auth_lease_json(&lease_id))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_active_auth_leases_json(
    handle: *mut SyncularNativeHandle,
    actor_id: *const c_char,
    now_ms: i64,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let actor_id = read_optional_c_string(actor_id)?;
        with_client(handle, |client| {
            client.active_auth_leases_json(actor_id.as_deref(), now_ms)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_set_outbox_auth_lease_json(
    handle: *mut SyncularNativeHandle,
    client_commit_id: *const c_char,
    provenance_json: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let client_commit_id = read_c_string(client_commit_id)?;
        let provenance_json = read_optional_c_string(provenance_json)?;
        with_client(handle, |client| {
            client.set_outbox_auth_lease_json(&client_commit_id, provenance_json.as_deref())
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_conflict_summaries_json(
    handle: *mut SyncularNativeHandle,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        with_client(handle, |client| client.conflict_summaries_json())
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_resolve_conflict(
    handle: *mut SyncularNativeHandle,
    conflict_id: *const c_char,
    resolution: *const c_char,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        let conflict_id = read_c_string(conflict_id)?;
        let resolution = read_c_string(resolution)?;
        with_client(handle, |client| {
            client.resolve_conflict(&conflict_id, &resolution)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_enqueue_resolve_conflict(
    handle: *mut SyncularNativeHandle,
    id: *const c_char,
    resolution: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let id = read_c_string(id)?;
        let resolution = read_c_string(resolution)?;
        with_client(handle, |client| {
            client.enqueue_resolve_conflict(&id, &resolution)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_retry_conflict_keep_local(
    handle: *mut SyncularNativeHandle,
    conflict_id: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut c_char {
    clear_error(error_out);
    ffi_catch_string(error_out, || {
        let conflict_id = read_c_string(conflict_id)?;
        with_client(handle, |client| {
            client.retry_conflict_keep_local(&conflict_id)
        })
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_client_subscribe_events_json(
    handle: *mut SyncularNativeHandle,
    capacity: u32,
    callback: Option<SyncularNativeEventCallback>,
    error_callback: Option<SyncularNativeEventErrorCallback>,
    user_data: *mut c_void,
    error_out: *mut *mut c_char,
) -> *mut SyncularNativeEventSubscription {
    clear_error(error_out);
    ffi_catch_ptr(error_out, || {
        let callback = callback.ok_or_else(|| {
            SyncularError::message(ErrorKind::Config, "native event callback is null")
        })?;
        let subscription = Arc::new(with_client(handle, |client| {
            Ok(client.subscribe_events(capacity as usize))
        })?);
        let thread_subscription = Arc::clone(&subscription);
        let user_data = user_data as usize;
        let join = thread::spawn(move || {
            while let Some(event) = thread_subscription.next_event_json() {
                match event {
                    Ok(event_json) => call_event_callback(callback, &event_json, user_data),
                    Err(error) => {
                        if let Some(error_callback) = error_callback {
                            let error_json = serde_json::to_string(&NativeErrorInfo::from_error(
                                &error,
                            ))
                            .unwrap_or_else(|_| {
                                r#"{"kind":"Internal","message":"failed to serialize native event error"}"#
                                    .to_string()
                            });
                            call_error_callback(error_callback, &error_json, user_data);
                        }
                    }
                }
            }
        });

        Ok(Box::into_raw(Box::new(SyncularNativeEventSubscription {
            subscription,
            join: Mutex::new(Some(join)),
        })))
    })
}

#[no_mangle]
pub extern "C" fn syncular_native_event_subscription_close(
    handle: *mut SyncularNativeEventSubscription,
    error_out: *mut *mut c_char,
) -> bool {
    clear_error(error_out);
    ffi_catch_bool(error_out, || {
        if handle.is_null() {
            return Ok(());
        }

        let subscription = unsafe { Box::from_raw(handle) };
        subscription.subscription.close();
        if let Ok(mut join) = subscription.join.lock() {
            if let Some(join) = join.take() {
                let _ = join.join();
            }
        }
        Ok(())
    })
}

fn call_event_callback(callback: SyncularNativeEventCallback, event_json: &str, user_data: usize) {
    let value = callback_c_string(event_json);
    callback(value.as_ptr(), user_data as *mut c_void);
}

fn call_error_callback(
    callback: SyncularNativeEventErrorCallback,
    error_json: &str,
    user_data: usize,
) {
    let value = callback_c_string(error_json);
    callback(value.as_ptr(), user_data as *mut c_void);
}

fn callback_c_string(value: &str) -> CString {
    CString::new(value.replace('\0', "\\u0000")).expect("sanitized string should not contain nul")
}

fn with_client<T>(
    handle: *mut SyncularNativeHandle,
    f: impl FnOnce(&mut NativeSyncularClient) -> Result<T>,
) -> Result<T> {
    if handle.is_null() {
        return Err(SyncularError::message(
            ErrorKind::Config,
            "native handle is null",
        ));
    }

    let handle = unsafe { &*handle };
    let mut client = handle
        .client
        .lock()
        .map_err(|_| SyncularError::message(ErrorKind::Internal, "native handle is poisoned"))?;
    f(&mut client)
}

fn with_presence_handle<T>(
    handle: *mut SyncularNativePresenceHandle,
    f: impl FnOnce(&SyncularNativePresenceHandle) -> Result<T>,
) -> Result<T> {
    if handle.is_null() {
        return Err(SyncularError::message(
            ErrorKind::Config,
            "native presence handle is null",
        ));
    }

    let handle = unsafe { &*handle };
    f(handle)
}

fn leave_presence_handle_inner(presence: &SyncularNativePresenceHandle) -> Result<bool> {
    let mut active = presence.active.lock().map_err(|_| {
        SyncularError::message(ErrorKind::Internal, "native presence handle is poisoned")
    })?;
    if !*active {
        return Ok(false);
    }
    with_client(presence.client, |client| {
        client.leave_presence(&presence.scope_key)
    })?;
    *active = false;
    Ok(true)
}

fn with_open_task<T>(
    handle: *mut SyncularNativeOpenHandle,
    f: impl FnOnce(&mut NativeClientOpenTask) -> Result<T>,
) -> Result<T> {
    if handle.is_null() {
        return Err(SyncularError::message(
            ErrorKind::Internal,
            "native async open handle is null",
        ));
    }

    let task = unsafe { &*handle };
    let mut task = task.task.lock().map_err(|_| {
        SyncularError::message(ErrorKind::Internal, "native async open handle is poisoned")
    })?;
    f(&mut task)
}

fn read_c_string(value: *const c_char) -> Result<String> {
    if value.is_null() {
        return Err(SyncularError::config("required string pointer is null"));
    }

    let value = unsafe { CStr::from_ptr(value) };
    value
        .to_str()
        .map(str::to_string)
        .map_err(|err| SyncularError::config(format!("string is not valid UTF-8: {err}")))
}

fn read_optional_c_string(value: *const c_char) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }

    read_c_string(value).map(Some)
}

fn ffi_catch_bool(error_out: *mut *mut c_char, f: impl FnOnce() -> Result<()>) -> bool {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            write_error(error_out, error);
            false
        }
        Err(payload) => {
            write_error(error_out, panic_error(payload));
            false
        }
    }
}

fn ffi_catch_bool_value(error_out: *mut *mut c_char, f: impl FnOnce() -> Result<bool>) -> bool {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            write_error(error_out, error);
            false
        }
        Err(payload) => {
            write_error(error_out, panic_error(payload));
            false
        }
    }
}

fn ffi_catch_i64(error_out: *mut *mut c_char, f: impl FnOnce() -> Result<i64>) -> i64 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            write_error(error_out, error);
            0
        }
        Err(payload) => {
            write_error(error_out, panic_error(payload));
            0
        }
    }
}

fn ffi_catch_ptr<T>(error_out: *mut *mut c_char, f: impl FnOnce() -> Result<*mut T>) -> *mut T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            write_error(error_out, error);
            ptr::null_mut()
        }
        Err(payload) => {
            write_error(error_out, panic_error(payload));
            ptr::null_mut()
        }
    }
}

fn ffi_catch_string(
    error_out: *mut *mut c_char,
    f: impl FnOnce() -> Result<String>,
) -> *mut c_char {
    ffi_catch_ptr(error_out, || f().map(alloc_c_string))
}

fn panic_error(payload: Box<dyn Any + Send>) -> SyncularError {
    let message = payload
        .downcast_ref::<&str>()
        .map(|value| (*value).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".to_string());
    SyncularError::message(
        ErrorKind::Internal,
        format!("panic crossed FFI boundary: {message}"),
    )
}

fn clear_error(error_out: *mut *mut c_char) {
    if !error_out.is_null() {
        unsafe {
            *error_out = ptr::null_mut();
        }
    }
}

fn write_error(error_out: *mut *mut c_char, error: SyncularError) {
    if error_out.is_null() {
        return;
    }

    let value = serde_json::to_string(&NativeErrorInfo::from_error(&error)).unwrap_or_else(|_| {
        r#"{"kind":"Internal","message":"failed to serialize native error"}"#.to_string()
    });

    unsafe {
        *error_out = alloc_c_string(value);
    }
}

fn alloc_c_string(value: String) -> *mut c_char {
    let sanitized = value.replace('\0', "\\u0000");
    CString::new(sanitized)
        .expect("sanitized string should not contain nul")
        .into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn ffi_boundary_converts_panics_to_structured_errors() {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let mut error = ptr::null_mut();
        let ok = ffi_catch_bool(&mut error, || -> Result<()> {
            panic!("ffi boundary test panic");
        });
        std::panic::set_hook(previous_hook);

        assert!(!ok);
        assert!(!error.is_null());
        let error_json = unsafe { CStr::from_ptr(error) }
            .to_str()
            .expect("utf8 error")
            .to_string();
        syncular_string_free(error);

        let value: Value = serde_json::from_str(&error_json).expect("error json");
        assert_eq!(value["kind"], "Internal");
        assert!(value["message"]
            .as_str()
            .unwrap_or_default()
            .contains("panic crossed FFI boundary: ffi boundary test panic"));
    }
}
