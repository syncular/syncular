//! # syncular-ffi — the Syncular v2 Rust client core as a C-ABI native library
//!
//! The POC client crate, packaged for shipping. Five C functions expose the
//! whole client over a JSON command surface — the v1-proven bindings shape,
//! and the SAME `syncular-command` router the conformance shim locks:
//!
//! ```c
//! void*  syncular_client_new(const char* config_json);
//! char*  syncular_client_command(void* handle, const char* command_json);
//! char*  syncular_client_poll_event(void* handle, int64_t timeout_ms);
//! void   syncular_client_close(void* handle);
//! void   syncular_free_string(char* ptr);
//! ```
//!
//! `command_json` is `{"method": "...", "params": {...}}` — every method the
//! shim speaks (create/subscribe/mutate/sync/syncUntilIdle/readRows/…). The
//! reply is `{"result": ...}` or `{"error": {"code", "message"}}`. Bytes ride
//! as `{"$bytes": "<hex>"}`, unchanged from the driver protocol, so a
//! JSI/TurboModule bridge marshals plain JSON.
//!
//! ## Transport ownership (native vs. inverted)
//!
//! The conformance shim inverts transport to the harness (the host holds the
//! sync/segment/realtime endpoints). A native app cannot do that — there is
//! no host loop to call back into. So under the `native-transport` feature
//! this crate OWNS a real HTTP + WS transport (see [`transport`]); the config
//! carries a `baseUrl` and the core drives the network itself. Without the
//! feature (the dependency-lean default), network commands fail loudly with
//! `transport.unavailable` and only client-local commands run — which is all
//! the C smoke test and pure-logic tests need.
//!
//! ## Events (lean queue over exact core output)
//!
//! The client core exposes no callbacks. Each observer transaction instead
//! commits an exact revisioned change batch, and commands which create network
//! work emit an explicit sync intent. After every command — and after draining
//! inbound realtime traffic — the FFI forwards those outputs verbatim as
//! `change` and `sync-intent` events. `poll_event` drains them. Native hosts do
//! not infer changes by diffing counters or method names.

use std::collections::VecDeque;
use std::ffi::{c_char, CStr, CString};
use std::os::raw::c_longlong;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{json, Value};
use syncular_client::{ClientDiagnosticsRequest, SyncClient};
use syncular_command::{dispatch, CreateEffects};

pub mod transport;

use transport::HostTransport;

/// One client-observable event (§8 realtime signals + §6 conflicts + §1.6
/// schema floor + §7.3 lease). JSON-able; delivered by `poll_event`.
#[derive(Debug, Clone)]
struct Event {
    json: Value,
}

/// The opaque handle behind the `void*`. One `SyncClient` instance, its owned
/// transport, and the exact core-output queue, guarded for cross-thread polling.
pub struct Handle {
    client: Option<SyncClient>,
    transport: HostTransport,
    effects: CreateEffects,
    queue: Arc<EventQueue>,
    last_diagnostics_fingerprint: Option<Value>,
}

/// A bounded, blocking event queue: `poll_event` waits up to `timeout_ms` for
/// the next event. The native WS reader thread and the command path both push.
pub(crate) struct EventQueue {
    inner: Mutex<VecDeque<Event>>,
    ready: Condvar,
}

impl EventQueue {
    fn new() -> Self {
        EventQueue {
            inner: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
        }
    }

    fn push(&self, event: Event) {
        let mut guard = self.inner.lock().expect("event queue lock");
        guard.push_back(event);
        self.ready.notify_one();
    }

    /// Pop the next event, waiting up to `timeout_ms` (< 0 = block until one
    /// arrives, 0 = non-blocking). Returns `None` on timeout.
    fn pop(&self, timeout_ms: i64) -> Option<Event> {
        let mut guard = self.inner.lock().expect("event queue lock");
        if let Some(event) = guard.pop_front() {
            return Some(event);
        }
        if timeout_ms == 0 {
            return None;
        }
        if timeout_ms < 0 {
            loop {
                guard = self.ready.wait(guard).expect("event queue wait");
                if let Some(event) = guard.pop_front() {
                    return Some(event);
                }
            }
        }
        let dur = std::time::Duration::from_millis(timeout_ms as u64);
        let (mut guard2, _timeout) = self
            .ready
            .wait_timeout(guard, dur)
            .expect("event queue wait_timeout");
        guard2.pop_front()
    }
}

impl Handle {
    fn new(config: &Value) -> Result<Self, String> {
        let queue = Arc::new(EventQueue::new());
        let transport = HostTransport::from_config(config)?;
        Ok(Handle {
            client: None,
            transport,
            effects: CreateEffects::default(),
            queue,
            last_diagnostics_fingerprint: None,
        })
    }

    /// Run one JSON command through the shared router, then drain inbound
    /// realtime traffic and forward exact core outputs.
    fn command(&mut self, command: &Value) -> Value {
        let method = command.get("method").and_then(Value::as_str).unwrap_or("");
        let params = command.get("params").cloned().unwrap_or(Value::Null);
        let result = dispatch(
            &mut self.transport,
            &mut self.client,
            &mut self.effects,
            method,
            &params,
        );
        if method == "create" {
            self.last_diagnostics_fingerprint = None;
            self.transport.set_signed_urls(self.effects.signed_urls);
        }
        // Command-local work is an explicit router effect (mutation and
        // window changes); realtime/retry work is drained from the core queue
        // below. Forward both sources without inferring from the method name.
        if let Ok(value) = &result {
            if let Some(intent) = value.pointer("/effects/sync") {
                if intent.get("kind").and_then(Value::as_str) != Some("none") {
                    self.queue.push(Event {
                        json: json!({ "type": "sync-intent", "intent": intent }),
                    });
                }
            }
        }
        // Deliver any realtime traffic the owned transport buffered, then
        // forward the core's committed observation output.
        self.drain_realtime();
        self.drain_core_outputs();
        self.emit_diagnostics_if_changed();
        match result {
            Ok(value) => json!({ "result": value }),
            Err((code, message)) => json!({ "error": { "code": code, "message": message } }),
        }
    }

    /// Feed buffered inbound WS frames to the client (which may send acks back
    /// through the same transport). A no-op without a native socket.
    fn drain_realtime(&mut self) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        for frame in self.transport.take_inbound() {
            match frame {
                transport::Inbound::Text(text) => {
                    // A presence fanout is the client-observable event a native
                    // host wants pushed; detect it on the wire (the core has no
                    // presence callback) before handing the control frame off.
                    if is_presence_control(&text) {
                        self.queue.push(Event {
                            json: json!({ "type": "presence" }),
                        });
                    }
                    client.on_realtime_text(&text);
                }
                transport::Inbound::Binary(bytes) => {
                    client.on_realtime_binary(&mut self.transport, &bytes)
                }
            }
        }
    }

    /// Forward exact observer batches and sync intents produced by the Rust
    /// core. The FFI is a manual-sync host; consumers may schedule an intent
    /// on their own event loop without polling core state.
    fn drain_core_outputs(&mut self) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        for batch in client.drain_change_batches() {
            self.queue.push(Event {
                json: json!({ "type": "change", "batch": batch }),
            });
        }
        for intent in client.drain_sync_intents() {
            self.queue.push(Event {
                json: json!({ "type": "sync-intent", "intent": intent }),
            });
        }
    }

    /// Forward a privacy-safe snapshot only when its state (excluding capture
    /// time) changes. This keeps the event atomic with the command/realtime
    /// observation while avoiding noise from read-only calls and polling.
    fn emit_diagnostics_if_changed(&mut self) {
        let Some(client) = self.client.as_ref() else {
            return;
        };
        if client.security_preflight() {
            return;
        }
        let Ok(snapshot) = client.diagnostics_snapshot(&ClientDiagnosticsRequest::default()) else {
            return;
        };
        let Ok(mut fingerprint) = serde_json::to_value(&snapshot) else {
            return;
        };
        if let Some(object) = fingerprint.as_object_mut() {
            object.remove("capturedAtMs");
        }
        if self.last_diagnostics_fingerprint.as_ref() == Some(&fingerprint) {
            return;
        }
        self.last_diagnostics_fingerprint = Some(fingerprint);
        self.queue.push(Event {
            json: json!({ "type": "diagnostics", "snapshot": snapshot }),
        });
    }
}

/// A presence fanout control frame (§8.6.2) — `{"event":"presence",...}`, the
/// one inbound realtime event a native host surfaces as an event.
fn is_presence_control(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("event")
                .and_then(Value::as_str)
                .map(|e| e == "presence")
        })
        .unwrap_or(false)
}

// -- C-ABI surface (the 5 functions kept exactly in sync with rust/ffi.h) ----

/// Turn a Rust string into a heap `char*` the caller frees with
/// `syncular_free_string`. Never returns null for a valid string.
fn into_c_string(value: String) -> *mut c_char {
    match CString::new(value) {
        Ok(s) => s.into_raw(),
        // A NUL byte cannot occur in our JSON output, but never panic across
        // the FFI boundary: fall back to an empty string.
        Err(_) => CString::new("").expect("empty CString").into_raw(),
    }
}

fn c_str_to_value(ptr: *const c_char) -> Result<Value, String> {
    if ptr.is_null() {
        return Err("null pointer".to_owned());
    }
    // Safety: the caller contract is a valid NUL-terminated C string.
    let bytes = unsafe { CStr::from_ptr(ptr) };
    let text = bytes
        .to_str()
        .map_err(|_| "config is not UTF-8".to_owned())?;
    serde_json::from_str(text).map_err(|e| format!("config is not JSON: {e}"))
}

/// Create a client core. `config_json` is a JSON object: `{}` for the
/// dependency-lean default (client-local commands only); with the
/// `native-transport` feature it carries `{"baseUrl": "...", ...}` for the
/// owned HTTP+WS transport. Returns an opaque handle, or null on a malformed
/// config.
///
/// # Safety
/// `config_json` must be a valid NUL-terminated UTF-8 C string (or null).
#[no_mangle]
pub extern "C" fn syncular_client_new(config_json: *const c_char) -> *mut Handle {
    let config = match c_str_to_value(config_json) {
        Ok(value) => value,
        Err(_) => return std::ptr::null_mut(),
    };
    match Handle::new(&config) {
        Ok(handle) => Box::into_raw(Box::new(handle)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Run one JSON command (`{"method","params"}`) against the client. Returns a
/// freshly-allocated `{"result"|"error"}` JSON string the caller frees with
/// `syncular_free_string`. Returns null only on a null handle.
///
/// # Safety
/// `handle` must be a live handle from `syncular_client_new`; `command_json`
/// a valid NUL-terminated UTF-8 C string.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_client_command(
    handle: *mut Handle,
    command_json: *const c_char,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    // Safety: non-null per the contract; we do not free it here.
    let handle = unsafe { &mut *handle };
    let command = match c_str_to_value(command_json) {
        Ok(value) => value,
        Err(message) => {
            return into_c_string(
                json!({ "error": { "code": "client.failed", "message": message } }).to_string(),
            )
        }
    };
    let reply = handle.command(&command);
    into_c_string(reply.to_string())
}

/// Poll the next client-observable event, waiting up to `timeout_ms`
/// (negative = block until one arrives, 0 = non-blocking). Returns a
/// freshly-allocated event JSON string, or null if none arrived in time.
///
/// # Safety
/// `handle` must be a live handle from `syncular_client_new`.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_client_poll_event(
    handle: *mut Handle,
    timeout_ms: c_longlong,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    // Safety: non-null per the contract.
    let handle = unsafe { &*handle };
    match handle.queue.pop(timeout_ms) {
        Some(event) => into_c_string(event.json.to_string()),
        None => std::ptr::null_mut(),
    }
}

/// Close a client core, releasing its database, transport, and socket thread.
/// The handle is invalid after this call.
///
/// # Safety
/// `handle` must be a live handle from `syncular_client_new`, closed once.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_client_close(handle: *mut Handle) {
    if handle.is_null() {
        return;
    }
    // Safety: reclaim the Box; dropping shuts down the transport/socket.
    let mut handle = unsafe { Box::from_raw(handle) };
    handle.transport.shutdown();
    drop(handle);
}

/// Free a string returned by `syncular_client_command` /
/// `syncular_client_poll_event`.
///
/// # Safety
/// `ptr` must be a string from one of those functions, freed once.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // Safety: reclaim the CString allocation to drop it.
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod round_tests;
