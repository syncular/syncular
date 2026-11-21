//! # syncular-ffi — the Syncular v2 Rust client core as a C-ABI native library
//!
//! The POC client crate, packaged for shipping. Seven C functions expose the
//! whole client over a JSON command surface — the v1-proven bindings shape,
//! and the SAME `syncular-command` router the conformance shim locks:
//!
//! ```c
//! void*  syncular_client_new(const char* config_json);
//! char*  syncular_client_command(void* handle, const char* command_json);
//! char*  syncular_client_poll_event(void* handle, int64_t timeout_ms);
//! char*  syncular_client_poll_headers(void* handle, int64_t timeout_ms);
//! char*  syncular_client_provide_headers(void* handle, uint64_t request_id,
//!                                        const char* headers_json);
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
//! `change` and `sync-intent` events, and each §8.7 `scopes` notice as a
//! `scopes-changed` event. `poll_event` drains them. Native hosts do
//! not infer changes by diffing counters or method names.
//!
//! Inbound realtime traffic (a delta, a presence fanout, a socket loss) is
//! applied only on the command path. When the socket reader buffers such
//! traffic, the transport's wake callback queues one `realtime-wake` event;
//! further traffic adds none until a command drains the buffer. The host
//! answers the event with the `drainRealtime` command.
//!
//! ## Request headers
//!
//! The transport asks the host for its request headers before every
//! host-authenticated HTTP request and realtime handshake, on a channel of
//! its own beside the event queue. `poll_headers` returns each question once,
//! `{"requestId":n,"rejected":{name:value}|null,"clientId":"..","round":n|null,
//! "target":"sync"|"segment"|"blob"|"realtime"}`, and the request blocks
//! until `provide_headers` answers that id with a header object, or `null`
//! when the host has none. `rejected` carries the headers the server just
//! answered 401 to; the transport resends that request once with the answer.
//! `null` headers, or no answer within `HEADER_ANSWER_WAIT_MS` (30 s), fail
//! the request with the retryable `sync.auth_required`
//! (`causeKind: "header_source"`). Neither call takes the core lock, so a
//! header thread answers while a command waits.
//!
//! ## Threading
//!
//! The event queue and the header channel sit outside the mutex that guards
//! the client, so pump threads may block in `poll_event` and `poll_headers`
//! while another thread issues commands.
//! Commands are not concurrent: the host serializes them.

use std::collections::VecDeque;
use std::ffi::{c_char, CStr, CString};
use std::os::raw::c_longlong;
use std::sync::{Arc, Condvar, Mutex, PoisonError};

use serde_json::{json, Value};
use syncular_client::{ClientDiagnosticsSnapshot, SyncClient};
use syncular_command::{diagnostics_event, dispatch, presence_event, reply, CreateEffects};

use syncular_client::native_transport::{HeaderContext, HeaderQuestions, HostTransport, Inbound};

/// One client-observable event (§8 realtime signals + §6 conflicts + §1.6
/// schema floor + §7.3 lease). JSON-able; delivered by `poll_event`.
#[derive(Debug, Clone)]
struct Event {
    json: Value,
}

/// The opaque handle behind the `void*`. `poll_event` reads only `queue`,
/// `poll_headers` only `asked`, `provide_headers` only `questions`;
/// `command` locks `core`, so a pump thread never aliases the state a
/// command mutates.
pub struct Handle {
    queue: Arc<EventQueue>,
    questions: Arc<HeaderQuestions>,
    asked: Arc<AskedHeaders>,
    core: Mutex<Core>,
}

/// Header questions not yet handed to `poll_headers`, and the header calls
/// in progress that `close` waits out.
#[derive(Default)]
struct AskedHeaders {
    state: Mutex<AskedState>,
    changed: Condvar,
}

#[derive(Default)]
struct AskedState {
    questions: VecDeque<Value>,
    /// Threads inside `poll_headers` or `provide_headers`.
    pollers: usize,
    closed: bool,
}

/// One `SyncClient` instance, its owned transport, and the producer side of the
/// event queue.
struct Core {
    client: Option<SyncClient>,
    transport: HostTransport,
    effects: CreateEffects,
    queue: Arc<EventQueue>,
    progress_subscription: Option<syncular_client::ProgressSubscription>,
    last_diagnostics_snapshot: Option<ClientDiagnosticsSnapshot>,
}

/// The blocking event queue: `poll_event` waits up to `timeout_ms` for the
/// next event. Commands push their outputs; the WS reader thread pushes only
/// the `realtime-wake` event. Only commands add other events, so an idle host
/// accumulates at most one wake. Progress events coalesce to the latest.
pub(crate) struct EventQueue {
    inner: Mutex<QueueState>,
    ready: Condvar,
}

struct QueueState {
    events: VecDeque<Event>,
    /// A `realtime-wake` is queued or delivered and no command has drained the
    /// transport since.
    wake_pending: bool,
}

impl EventQueue {
    fn new() -> Self {
        EventQueue {
            inner: Mutex::new(QueueState {
                events: VecDeque::new(),
                wake_pending: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn push(&self, event: Event) {
        let mut guard = self.inner.lock().expect("event queue lock");
        if event.json.get("type").and_then(Value::as_str) == Some("progress") {
            guard.events.retain(|queued| {
                queued.json.get("type").and_then(Value::as_str) != Some("progress")
            });
        }
        guard.events.push_back(event);
        self.ready.notify_one();
    }

    /// The transport buffered inbound realtime traffic: queue one
    /// `realtime-wake` unless one is already outstanding.
    fn wake(&self) {
        let mut guard = self.inner.lock().expect("event queue lock");
        if guard.wake_pending {
            return;
        }
        guard.wake_pending = true;
        guard.events.push_back(Event {
            json: json!({ "type": "realtime-wake" }),
        });
        self.ready.notify_one();
    }

    /// A command is about to drain the transport: retire the outstanding wake.
    /// Traffic buffered after this call queues a new one.
    fn clear_wake(&self) {
        let mut guard = self.inner.lock().expect("event queue lock");
        guard.wake_pending = false;
        guard.events.retain(|queued| {
            queued.json.get("type").and_then(Value::as_str) != Some("realtime-wake")
        });
    }

    /// Pop the next event, waiting up to `timeout_ms` (< 0 = block until one
    /// arrives, 0 = non-blocking). Returns `None` on timeout.
    fn pop(&self, timeout_ms: i64) -> Option<Event> {
        let mut guard = self.inner.lock().expect("event queue lock");
        if let Some(event) = guard.events.pop_front() {
            return Some(event);
        }
        if timeout_ms == 0 {
            return None;
        }
        if timeout_ms < 0 {
            loop {
                guard = self.ready.wait(guard).expect("event queue wait");
                if let Some(event) = guard.events.pop_front() {
                    return Some(event);
                }
            }
        }
        let dur = std::time::Duration::from_millis(timeout_ms as u64);
        let (mut guard2, _timeout) = self
            .ready
            .wait_timeout(guard, dur)
            .expect("event queue wait_timeout");
        guard2.events.pop_front()
    }
}

impl Handle {
    /// Repository benchmark access; no C ABI entry point exposes this hook.
    #[cfg(feature = "bench-internals")]
    #[doc(hidden)]
    pub fn benchmark_client(&mut self) -> Option<&mut SyncClient> {
        self.core
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .client
            .as_mut()
    }

    fn new(config: &Value) -> Result<Self, String> {
        let mut core = Core::new(config)?;
        let asked = Arc::new(AskedHeaders::default());
        let asks = asked.clone();
        let started = std::time::Instant::now();
        let questions = HeaderQuestions::new(
            move |id, context: &HeaderContext, rejected| {
                let question = json!({
                    "requestId": id,
                    "clientId": context.client_id,
                    "round": context.round,
                    "target": context.target.as_str(),
                    "rejected": rejected.map(|headers| {
                        headers
                            .iter()
                            .map(|(name, value)| (name.clone(), Value::from(value.clone())))
                            .collect::<serde_json::Map<_, _>>()
                    }),
                });
                asks.state
                    .lock()
                    .expect("asked headers lock")
                    .questions
                    .push_back(question);
                asks.changed.notify_all();
            },
            move || started.elapsed().as_millis() as i64,
        );
        core.transport.set_header_source(questions.source());
        Ok(Handle {
            queue: core.queue.clone(),
            questions,
            asked,
            core: Mutex::new(core),
        })
    }

    fn command(&self, command: &Value) -> Value {
        self.core
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .command(command)
    }
}

impl Core {
    fn new(config: &Value) -> Result<Self, String> {
        let queue = Arc::new(EventQueue::new());
        let wake_queue = queue.clone();
        let transport = HostTransport::from_config_with_notify(
            config,
            Some(Arc::new(move || wake_queue.wake())),
        )?;
        Ok(Core {
            client: None,
            transport,
            effects: CreateEffects::default(),
            queue,
            progress_subscription: None,
            last_diagnostics_snapshot: None,
        })
    }

    /// Run one JSON command through the shared router, then drain inbound
    /// realtime traffic and forward exact core outputs.
    fn command(&mut self, command: &Value) -> Value {
        let method = command.get("method").and_then(Value::as_str).unwrap_or("");
        let params = command.get("params").unwrap_or(&Value::Null);
        let result = dispatch(
            &mut self.transport,
            &mut self.client,
            &mut self.effects,
            method,
            params,
        );
        if method == "create" && result.is_ok() {
            let queue = self.queue.clone();
            self.progress_subscription = self.client.as_ref().map(|client| {
                client.progress().subscribe(move |progress| {
                    queue.push(Event {
                        json: json!({ "type": "progress", "progress": progress }),
                    });
                })
            });
        }
        if method == "shutdown" {
            self.progress_subscription = None;
        }
        if method == "create" {
            self.last_diagnostics_snapshot = None;
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
        reply(result)
    }

    /// Feed buffered inbound WS frames to the client (which may send acks back
    /// through the same transport). A no-op without a native socket.
    fn drain_realtime(&mut self) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        self.queue.clear_wake();
        for frame in self.transport.take_inbound() {
            match frame {
                Inbound::Text(text) => {
                    // A presence frame is the client-observable event a native
                    // host wants pushed; detect it on the wire (the core has no
                    // presence callback) before handing the control frame off.
                    if let Some(json) = presence_event(&text) {
                        self.queue.push(Event { json });
                    }
                    client.on_realtime_text(&text);
                }
                Inbound::Binary(bytes) => client.on_realtime_binary(&mut self.transport, &bytes),
                Inbound::Disconnected(error) => client.realtime_lost(&mut self.transport, &error),
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
        for name in client.drain_projection_pending() {
            self.queue.push(Event {
                json: syncular_command::projection_pending_event(name),
            });
        }
        for intent in client.drain_sync_intents() {
            self.queue.push(Event {
                json: json!({ "type": "sync-intent", "intent": intent }),
            });
        }
        for _ in 0..client.drain_scopes_changed() {
            self.queue.push(Event {
                json: json!({ "type": "scopes-changed" }),
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
        if let Some(json) = diagnostics_event(client, &mut self.last_diagnostics_snapshot) {
            self.queue.push(Event { json });
        }
    }
}

// -- C-ABI surface (the 7 functions kept exactly in sync with rust/ffi.h) ----

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
    // Safety: non-null per the contract; we do not free it here. Shared: a
    // concurrent `poll_event` holds a shared reference too.
    let handle = unsafe { &*handle };
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

/// Poll the next header question, waiting up to `timeout_ms` (negative =
/// block until one arrives, 0 = non-blocking). Returns a freshly-allocated
/// `{"requestId": n, "rejected": {name: value} | null, "clientId": "..",
/// "round": n | null, "target": "sync" | "segment" | "blob" | "realtime"}`
/// string, or null on
/// timeout and once `syncular_client_close` has begun. Each question is
/// returned once, and never after its request failed (past the 30 s bound).
/// Takes no core lock.
///
/// # Safety
/// `handle` must be a live handle from `syncular_client_new`.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_client_poll_headers(
    handle: *mut Handle,
    timeout_ms: c_longlong,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    // Safety: non-null per the contract; close waits until this poll returns.
    let handle = unsafe { &*handle };
    let asked = &handle.asked;
    let mut state = asked.state.lock().expect("asked headers lock");
    state.pollers += 1;
    let deadline = (timeout_ms > 0)
        .then(|| std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64));
    let question = loop {
        if state.closed {
            break None;
        }
        // A question whose request already failed (bound passed, answered,
        // or closed) is dropped instead of handed out.
        if let Some(question) = state.questions.pop_front() {
            if handle
                .questions
                .is_open(question["requestId"].as_u64().expect("question id"))
            {
                break Some(question);
            }
            continue;
        }
        if timeout_ms == 0 {
            break None;
        }
        match deadline {
            None => state = asked.changed.wait(state).expect("asked headers wait"),
            Some(deadline) => {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break None;
                }
                state = asked
                    .changed
                    .wait_timeout(state, deadline - now)
                    .expect("asked headers wait")
                    .0;
            }
        }
    };
    state.pollers -= 1;
    asked.changed.notify_all();
    match question {
        Some(question) => into_c_string(question.to_string()),
        None => std::ptr::null_mut(),
    }
}

/// Answer header question `request_id`. `headers_json` is a JSON object of
/// string values, or `null` (a null pointer counts as `null`) when the host
/// cannot produce headers. Returns `{"result": {}}`, also for an unknown or
/// expired id, or `{"error": {"code": "sync.invalid_request", ...}}` for a
/// malformed answer; the caller frees it with `syncular_free_string`. Takes
/// no core lock; `close` waits for a call in progress, and a call after
/// close began answers `{"result": {}}`. Returns null only on a null handle.
///
/// # Safety
/// `handle` must be a live handle from `syncular_client_new`;
/// `headers_json` a valid NUL-terminated UTF-8 C string or null.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_client_provide_headers(
    handle: *mut Handle,
    request_id: u64,
    headers_json: *const c_char,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    // Safety: non-null per the contract; close waits until this call returns.
    let handle = unsafe { &*handle };
    {
        let mut asked = handle.asked.state.lock().expect("asked headers lock");
        if asked.closed {
            return into_c_string(json!({ "result": {} }).to_string());
        }
        asked.pollers += 1;
    }
    let headers = if headers_json.is_null() {
        Ok(Value::Null)
    } else {
        c_str_to_value(headers_json)
    };
    let provided = match headers {
        Ok(headers) => handle
            .questions
            .provide(request_id, &headers)
            .map_err(|error| error.message),
        Err(_) => Err("provided headers must be JSON".to_owned()),
    };
    let reply = match provided {
        Ok(()) => json!({ "result": {} }),
        Err(message) => json!({ "error": { "code": "sync.invalid_request", "message": message } }),
    };
    handle
        .asked
        .state
        .lock()
        .expect("asked headers lock")
        .pollers -= 1;
    handle.asked.changed.notify_all();
    into_c_string(reply.to_string())
}

/// Close a client core, releasing its database, transport, and socket thread.
/// A command waiting for headers fails with `client.closed` and a blocked
/// `poll_headers` returns null first, so close never waits on an unanswered
/// question. The handle is invalid after this call.
///
/// # Safety
/// `handle` must be a live handle from `syncular_client_new`, closed once.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn syncular_client_close(handle: *mut Handle) {
    if handle.is_null() {
        return;
    }
    // Safety: non-null per the contract. Wake header waiters, then wait for
    // the running command to release the core before shutting it down.
    let shared = unsafe { &*handle };
    shared.questions.close();
    let mut asked = shared.asked.state.lock().expect("asked headers lock");
    asked.closed = true;
    shared.asked.changed.notify_all();
    while asked.pollers > 0 {
        asked = shared
            .asked
            .changed
            .wait(asked)
            .expect("asked headers wait");
    }
    drop(asked);
    shared
        .core
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .transport
        .shutdown();
    // Safety: reclaim the Box; no command holds the core any more.
    drop(unsafe { Box::from_raw(handle) });
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

#[cfg(test)]
mod progress_event_tests {
    use super::*;

    #[test]
    fn slow_pollers_keep_only_the_latest_progress_without_losing_changes() {
        let queue = EventQueue::new();
        queue.push(Event {
            json: json!({"type": "change", "revision": 1}),
        });
        for rows in [1024, 2048, 4096] {
            queue.push(Event {
                json: json!({"type": "progress", "rows": rows}),
            });
        }
        assert_eq!(queue.pop(0).unwrap().json["type"], "change");
        assert_eq!(queue.pop(0).unwrap().json["rows"], 4096);
        assert!(queue.pop(0).is_none());
    }

    #[test]
    fn realtime_wakes_coalesce_until_a_command_drains() {
        let queue = EventQueue::new();
        queue.wake();
        queue.wake();
        assert_eq!(queue.pop(0).unwrap().json["type"], "realtime-wake");
        // Delivered but not yet answered: further traffic adds no event.
        queue.wake();
        assert!(queue.pop(0).is_none());
        queue.clear_wake();
        queue.wake();
        queue.push(Event {
            json: json!({"type": "change", "revision": 1}),
        });
        // A drain retires a queued wake and keeps every other event.
        queue.clear_wake();
        assert_eq!(queue.pop(0).unwrap().json["type"], "change");
        assert!(queue.pop(0).is_none());
    }
}
