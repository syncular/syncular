//! Private, same-process benchmark transport. The host runs async server work
//! while the client worker blocks in its callback. No shipping C ABI changes.

use super::*;
use std::ffi::{c_char, c_void};
use std::thread::{self, ThreadId};

type Callback = unsafe extern "C" fn(u32, *const u8, u32) -> i32;

#[derive(Clone, Copy)]
struct Host {
    callback: Callback,
    response: *const u8,
    capacity: usize,
    thread: ThreadId,
}

impl Host {
    fn call(&self, method: u32, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        if thread::current().id() != self.thread || request.len() > u32::MAX as usize {
            return Err(TransportError::new(
                "bench.invalid_host_call",
                "Invalid engine host call",
            ));
        }
        // SAFETY: construction records the owning worker thread and a live host
        // callback. Calls are synchronous and serialized on that worker. The
        // request remains borrowed until the callback returns.
        let size = unsafe { (self.callback)(method, request.as_ptr(), request.len() as u32) };
        let failed = size < 0;
        let length = if failed {
            -(i64::from(size)) - 1
        } else {
            i64::from(size)
        } as usize;
        if length > self.capacity {
            return Err(TransportError::new(
                "bench.invalid_host_response",
                "Engine response exceeds capacity",
            ));
        }
        // SAFETY: the callback publishes its complete response before returning,
        // then leaves this live host-owned buffer unchanged until the next call.
        // Copy before allowing another call. Bounds were checked above.
        let bytes = unsafe { std::slice::from_raw_parts(self.response, length) }.to_vec();
        if failed {
            let error: Value = serde_json::from_slice(&bytes).map_err(|_| {
                TransportError::new("bench.invalid_host_response", "Invalid engine host error")
            })?;
            let (Some(code), Some(message)) = (
                error.get("code").and_then(Value::as_str),
                error.get("message").and_then(Value::as_str),
            ) else {
                return Err(TransportError::new(
                    "bench.invalid_host_response",
                    "Invalid engine host error",
                ));
            };
            return Err(TransportError::new(code, message));
        }
        Ok(bytes)
    }
}

struct EngineBackend(Host);

impl Transport for EngineBackend {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.0.call(1, request)
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.0.call(2, request)
    }

    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError> {
        self.0.call(
            3,
            &serde_json::to_vec(&json!({
                "segmentId": request.segment_id, "table": request.table,
                "requestedScopesJson": request.requested_scopes_json,
            }))
            .expect("JSON segment metadata"),
        )
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        Err(TransportError::new(
            "bench.invalid_host_call",
            "Engine realtime requires a client identity",
        ))
    }

    fn realtime_connect_for_client(&mut self, client_id: &str) -> Result<(), TransportError> {
        self.0.call(4, client_id.as_bytes()).map(|_| ())
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.0.call(5, text.as_bytes()).map(|_| ())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        self.0.call(7, &[]).map(|_| ())
    }
}

impl BenchBackend for EngineBackend {
    fn take_inbound(&mut self) -> Result<Vec<Inbound>, CommandError> {
        let bytes = self
            .0
            .call(6, &[])
            .map_err(|error| (error.code, error.message))?;
        let mut frames = Vec::new();
        let mut remaining = bytes.as_slice();
        while !remaining.is_empty() {
            if remaining.len() < 5 {
                return Err((
                    "bench.invalid_host_response".into(),
                    "Invalid engine event header".into(),
                ));
            }
            let length =
                u32::from_le_bytes(remaining[1..5].try_into().expect("four-byte length")) as usize;
            let Some(body) = remaining.get(5..).and_then(|bytes| bytes.get(..length)) else {
                return Err((
                    "bench.invalid_host_response".into(),
                    "Invalid engine event length".into(),
                ));
            };
            frames.push(match remaining[0] {
                0 => Inbound::Binary(body.to_vec()),
                1 => Inbound::Text(String::from_utf8(body.to_vec()).map_err(|_| {
                    (
                        "bench.invalid_host_response".into(),
                        "Invalid engine event text".into(),
                    )
                })?),
                _ => {
                    return Err((
                        "bench.invalid_host_response".into(),
                        "Invalid engine event kind".into(),
                    ))
                }
            });
            remaining = &remaining[5 + length..];
        }
        Ok(frames)
    }

    fn shutdown(&mut self) {
        // Explicit engine_close reports shutdown failures to the host. This
        // method also supports the shared driver's idempotent destroy command.
        let _ = self.realtime_close();
    }

    fn set_signed_urls(&mut self, enabled: bool) -> Result<(), CommandError> {
        if enabled {
            return Err((
                "bench.unsupported_capability".into(),
                "Engine transport does not fetch signed URLs".into(),
            ));
        }
        Ok(())
    }
}

pub struct EngineHandle {
    client: Option<SyncClient>,
    effects: CreateEffects,
    transport: BenchTransport,
    host: Host,
}

/// Create the private client on its owning worker thread.
///
/// # Safety
/// The callback and non-null response buffer must remain live until close. The
/// callback writes at most capacity bytes and publishes them before returning.
/// It returns their length, or -(length + 1) for a JSON transport error. It must
/// not unwind or reenter the handle. All handle calls stay on this thread.
#[no_mangle]
pub unsafe extern "C" fn syncular_bench_engine_new(
    callback: Option<Callback>,
    response: *const c_void,
    capacity: u32,
) -> *mut EngineHandle {
    let Some(callback) = callback else {
        return std::ptr::null_mut();
    };
    if response.is_null() || capacity == 0 || capacity > 32 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    let host = Host {
        callback,
        response: response.cast(),
        capacity: capacity as usize,
        thread: thread::current().id(),
    };
    Box::into_raw(Box::new(EngineHandle {
        client: None,
        effects: CreateEffects::default(),
        host,
        transport: BenchTransport {
            blob_diagnostics: true,
            inner: Box::new(EngineBackend(host)),
            stats: TransportStats::default(),
            last_ack: -1,
            wait_for_inbound: Box::new(move |remaining| {
                host.call(
                    8,
                    &(remaining.as_millis().min(u128::from(u32::MAX)) as u32).to_le_bytes(),
                )
                .map(|_| ())
                .map_err(|error| (error.code, error.message))
            }),
        },
    }))
}

/// Execute the same commands as the stdio benchmark driver.
///
/// # Safety
/// Handle must be live on its owning worker thread, and request must point to a
/// NUL-terminated JSON envelope for this call. Free the result exactly once with
/// engine_free. No concurrent calls, reentry, or close during a call are allowed.
#[no_mangle]
pub unsafe extern "C" fn syncular_bench_engine_command(
    handle: *mut EngineHandle,
    request: *const c_char,
) -> *mut c_char {
    if handle.is_null() || request.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the caller supplies the live, exclusively borrowed handle.
    let handle = unsafe { &mut *handle };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if thread::current().id() != handle.host.thread {
            return Err(("bench.wrong_thread".into(), "Engine handle belongs to another thread".into()));
        }
        // SAFETY: the request is live and NUL-terminated for this call.
        let request: Value = serde_json::from_slice(unsafe { CStr::from_ptr(request) }.to_bytes())
            .map_err(|_| ("bench.invalid_request".to_owned(), "Invalid engine command".to_owned()))?;
        let method = request.get("method").and_then(Value::as_str)
            .ok_or_else(|| ("bench.invalid_request".to_owned(), "Missing engine command".to_owned()))?;
        let params = request.get("params").unwrap_or(&Value::Null);
        if params.get("transport").is_some() || params.get("benchBoundary").is_some() {
            return Err(("bench.invalid_request".into(), "Engine transport cannot change".into()));
        }
        if params.get("signedUrls").and_then(Value::as_bool) == Some(true) {
            return Err(("bench.unsupported_capability".into(), "Engine transport does not fetch signed URLs".into()));
        }
        if method == "stats" && params.get("sqlCounts").is_some() {
            return Err(("bench.unsupported_capability".into(), "SQL counters require the direct or command socket driver".into()));
        }
        if method == "benchEngineInfo" {
            return Ok(json!({"processId": std::process::id(), "threadId": format!("{:?}", handle.host.thread), "responseCapacity": handle.host.capacity}));
        }
        let result = super::handle(&mut handle.transport, &mut handle.client, &mut handle.effects, method, params);
        let drained = drain_inbound(&mut handle.transport, &mut handle.client);
        result.and_then(|value| drained.map(|()| value))
    })).unwrap_or_else(|_| Err(("bench.native_panic".into(), "Engine command panicked".into())));
    let envelope = match result {
        Ok(value) => json!({"result": value}),
        Err((code, message)) => json!({"error": {"code": code, "message": message}}),
    };
    CString::new(envelope.to_string())
        .expect("JSON contains no raw NUL")
        .into_raw()
}

/// Close an idle handle and release its database. Returns 1 on successful host
/// disconnect, 0 on failure, and -1 for an invalid thread or null handle.
///
/// # Safety
/// The handle must be live, idle, and owned by this thread. Its callback and
/// response buffer remain live until this function returns. Close exactly once.
#[no_mangle]
pub unsafe extern "C" fn syncular_bench_engine_close(handle: *mut EngineHandle) -> i32 {
    if handle.is_null() {
        return -1;
    }
    // SAFETY: the caller provides a live handle; inspect ownership before drop.
    if unsafe { (*handle).host.thread } != thread::current().id() {
        return -1;
    }
    // SAFETY: close consumes this live handle once, on its owning thread.
    let handle = unsafe { Box::from_raw(handle) };
    i32::from(handle.host.call(7, &[]).is_ok())
}

/// Release a private command response.
///
/// # Safety
/// Pointer must be null or an unfreed string returned by engine_command.
#[no_mangle]
pub unsafe extern "C" fn syncular_bench_engine_free(pointer: *mut c_char) {
    if !pointer.is_null() {
        // SAFETY: ownership of this original CString is returned exactly once.
        drop(unsafe { CString::from_raw(pointer) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    thread_local! { static RESPONSE_SIZE: Cell<i32> = const { Cell::new(0) }; }

    unsafe extern "C" fn callback(_: u32, _: *const u8, _: u32) -> i32 {
        RESPONSE_SIZE.with(Cell::get)
    }

    #[test]
    fn validates_host_error_and_capacity_before_reading() {
        for (bytes, size, expected) in [
            (
                br#"{"code":"test.failure","message":"Rejected"}"#.as_slice(),
                -45,
                "test.failure",
            ),
            (b"{}".as_slice(), -3, "bench.invalid_host_response"),
            (b"?".as_slice(), -2, "bench.invalid_host_response"),
            (b"".as_slice(), i32::MIN, "bench.invalid_host_response"),
            (b"".as_slice(), 1, "bench.invalid_host_response"),
        ] {
            // A negative size carries the error JSON length, independent of its
            // contents. Keep the valid error's length tied to the fixture.
            RESPONSE_SIZE.with(|value| {
                value.set(if expected == "test.failure" {
                    -(bytes.len() as i32 + 1)
                } else {
                    size
                })
            });
            let host = Host {
                callback,
                response: bytes.as_ptr(),
                capacity: bytes.len(),
                thread: thread::current().id(),
            };
            assert_eq!(host.call(1, &[]).unwrap_err().code, expected);
        }
    }

    #[test]
    fn validates_packed_event_boundaries_kinds_and_utf8() {
        for bytes in [
            vec![0, 1],
            vec![0, 2, 0, 0, 0, 1],
            vec![2, 0, 0, 0, 0],
            vec![1, 1, 0, 0, 0, 255],
        ] {
            RESPONSE_SIZE.with(|value| value.set(bytes.len() as i32));
            let mut backend = EngineBackend(Host {
                callback,
                response: bytes.as_ptr(),
                capacity: bytes.len(),
                thread: thread::current().id(),
            });
            assert_eq!(
                backend.take_inbound().err().unwrap().0,
                "bench.invalid_host_response"
            );
        }
        let bytes = [0, 1, 0, 0, 0, 42, 1, 2, 0, 0, 0, b'o', b'k'];
        RESPONSE_SIZE.with(|value| value.set(bytes.len() as i32));
        let mut backend = EngineBackend(Host {
            callback,
            response: bytes.as_ptr(),
            capacity: bytes.len(),
            thread: thread::current().id(),
        });
        let frames = backend.take_inbound().unwrap();
        assert!(matches!(&frames[0], Inbound::Binary(value) if value == &[42]));
        assert!(matches!(&frames[1], Inbound::Text(value) if value == "ok"));
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn private_handle_reports_identity_rejects_replacement_and_frees_responses() {
        let buffer = [0_u8; 64];
        RESPONSE_SIZE.with(|value| value.set(0));
        // SAFETY: all calls stay on this test thread, the callback and buffer
        // outlive the handle, and each owned response/handle is freed once.
        unsafe {
            assert!(syncular_bench_engine_new(None, buffer.as_ptr().cast(), 64).is_null());
            assert!(syncular_bench_engine_new(Some(callback), std::ptr::null(), 64).is_null());
            let handle = syncular_bench_engine_new(Some(callback), buffer.as_ptr().cast(), 64);
            assert!(!handle.is_null());
            for (request, expected) in [
                (json!({"method":"benchEngineInfo"}), None),
                (
                    json!({"method":"stats", "params":{"sqlCounts":true}}),
                    Some("bench.unsupported_capability"),
                ),
                (
                    json!({"method":"create","params":{"transport":{}}}),
                    Some("bench.invalid_request"),
                ),
                (
                    json!({"method":"create","params":{"signedUrls":true}}),
                    Some("bench.unsupported_capability"),
                ),
            ] {
                let input = CString::new(request.to_string()).unwrap();
                let output = syncular_bench_engine_command(handle, input.as_ptr());
                assert!(!output.is_null());
                let decoded: Value =
                    serde_json::from_slice(CStr::from_ptr(output).to_bytes()).unwrap();
                syncular_bench_engine_free(output);
                if let Some(code) = expected {
                    assert_eq!(decoded["error"]["code"], code);
                } else {
                    assert_eq!(decoded["result"]["processId"], std::process::id());
                }
            }
            assert_eq!(syncular_bench_engine_close(handle), 1);
        }
    }
}
