//! # tauri-plugin-syncular — a native syncular instance inside the Tauri process
//!
//! A NATIVE syncular client (the Rust `syncular-client` core, consumed
//! DIRECTLY — no FFI) runs in the Tauri host process and is exposed to the
//! webview as Tauri commands + events. The JS bridge (`@syncular/tauri`)
//! implements the same `SyncClientLike` interface the React package
//! normalizes, so the hooks work unchanged — the fourth host of one interface
//! after direct / worker-leader / follower.
//!
//! Decided architecture (ROADMAP.md block 1): NOT JS syncular in the
//! webview — webview OPFS is eviction-prone and inconsistent across
//! WKWebView/webkitgtk; the Rust core gives a real file DB and native perf.
//!
//! ## The surface (mirrors the FFI / conformance shim)
//!
//! - `syncular_command(command_json)` — the WHOLE command surface in one
//!   command (`{"method","params"}`), dispatched through the shared
//!   `syncular-command` router (the plugin is its THIRD consumer, so the
//!   surface stays conformance-locked).
//! - `syncular_query(sql, params)` — the React live-query fast path (arbitrary
//!   read-only SQL); routed through the same `query` command.
//! - `syncular_query_snapshot(sql, params, coverage)` — atomic reactive reads
//!   on an independent read-only SQLite connection for file-backed clients.
//! - `syncular://event` — exact revisioned `change` batches plus ephemeral
//!   `presence`; command/realtime sync intents stay inside the event-driven
//!   owner loop.
//!
//! ## Thread-safety, honestly
//!
//! [`core::SyncularCore`] owns a rusqlite connection and is NOT `Sync`. One
//! owning thread holds the mutable client; every command arrives over a mailbox
//! (mpsc). The background host loop (§8.4 wake-driven `syncUntilIdle` with
//! deadlines) runs on that thread. File-backed clients add one read owner with
//! an independent read-only SQLite connection for snapshots, so network work
//! cannot block local views while the mutable client remains single-owned.

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Manager, RunEvent, Runtime};

pub mod core;
pub mod transport;

use core::SyncularCore;
use syncular_client::{FileQuerySnapshotReader, WindowBase, WindowCoverage};

/// The Tauri event name carrying derived client-observable events.
pub const EVENT_NAME: &str = "syncular://event";

/// Plugin configuration. Passed to [`init`]; every field is optional except a
/// caller almost always wants a `base_url` (for real network sync) and a
/// `db_path` (for persistence — defaults to an in-memory core if absent).
#[derive(Debug, Clone)]
pub struct SyncularConfig {
    /// Server base URL for the native HTTP+WS transport (needs the
    /// `native-transport` feature). Absent → client-local only.
    pub base_url: Option<String>,
    /// Optional realtime WS URL; derived from `base_url` when absent.
    pub ws_url: Option<String>,
    /// Extra request headers (auth, actor/project ids) as (name, value).
    pub headers: Vec<(String, String)>,
    /// On-disk SQLite path. Absent → in-memory (nothing survives a restart).
    /// Apps usually set this to a file under the app-data dir; see [`init`].
    pub db_path: Option<String>,
    /// Run the background host loop (§8.4). Default true.
    pub auto_sync: bool,
}

impl Default for SyncularConfig {
    fn default() -> Self {
        Self {
            base_url: None,
            ws_url: None,
            headers: Vec::new(),
            db_path: None,
            auto_sync: true,
        }
    }
}

impl SyncularConfig {
    /// Build the JSON config the core's transport reads.
    fn to_transport_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        if let Some(base) = &self.base_url {
            map.insert("baseUrl".to_owned(), Value::from(base.clone()));
        }
        if let Some(ws) = &self.ws_url {
            map.insert("wsUrl".to_owned(), Value::from(ws.clone()));
        }
        if !self.headers.is_empty() {
            let headers: serde_json::Map<String, Value> = self
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), Value::from(v.clone())))
                .collect();
            map.insert("headers".to_owned(), Value::Object(headers));
        }
        Value::Object(map)
    }
}

/// A request posted to the owning thread's mailbox. Each carries a one-shot
/// reply channel; the Tauri command blocks on it (`spawn_blocking`-friendly).
enum Request {
    Command {
        command: Value,
        reply: Sender<Value>,
    },
    Query {
        sql: String,
        params: Value,
        reply: Sender<Value>,
    },
    /// Replace the transport's request headers (RFC 0002 §2.3). Header state
    /// lives on the core-owned transport, so mutation rides the same mailbox
    /// as every other access — the one-owning-thread invariant holds.
    SetHeaders {
        headers: Vec<(String, String)>,
        reply: Sender<Value>,
    },
    /// Native realtime reader wake; contains no data (the transport buffer does).
    TransportWake,
    #[cfg(test)]
    Block {
        duration: Duration,
        entered: Sender<()>,
    },
    Shutdown,
}

/// Latency-critical reads use a second, read-only SQLite connection. This
/// mailbox is deliberately independent from [`Request`]: a network round on
/// the mutable owner must never head-of-line-block a local UI snapshot.
enum ReadRequest {
    QuerySnapshot {
        sql: String,
        params: Vec<Value>,
        coverage: Vec<WindowCoverage>,
        reply: Sender<Value>,
    },
    Shutdown,
}

/// The plugin's managed state: the mailbox sender the commands post to. Wrapped
/// in a `Mutex` only to be `Sync` for Tauri state (the `Sender` is `Send`).
struct SyncularState {
    sender: Mutex<Sender<Request>>,
    reader: Option<Mutex<Sender<ReadRequest>>>,
    security_gate: SecurityGate,
}

struct SecurityGateState {
    preflight: bool,
    active_reads: usize,
}

struct SecurityGate {
    state: Mutex<SecurityGateState>,
    idle: Condvar,
}

struct SecurityReadGuard<'a> {
    gate: &'a SecurityGate,
}

impl SecurityGate {
    fn new_preflight() -> Self {
        Self {
            state: Mutex::new(SecurityGateState {
                preflight: true,
                active_reads: 0,
            }),
            idle: Condvar::new(),
        }
    }

    fn begin_preflight(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "syncular security gate poisoned".to_owned())?;
        state.preflight = true;
        while state.active_reads > 0 {
            state = self
                .idle
                .wait(state)
                .map_err(|_| "syncular security gate poisoned".to_owned())?;
        }
        Ok(())
    }

    fn activate(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "syncular security gate poisoned".to_owned())?;
        state.preflight = false;
        Ok(())
    }

    fn enter_read(&self) -> Result<SecurityReadGuard<'_>, Value> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| client_error("syncular security gate poisoned"))?;
        if state.preflight {
            return Err(security_preflight_error());
        }
        state.active_reads += 1;
        Ok(SecurityReadGuard { gate: self })
    }
}

impl Drop for SecurityReadGuard<'_> {
    fn drop(&mut self) {
        let Ok(mut state) = self.gate.state.lock() else {
            return;
        };
        state.active_reads = state.active_reads.saturating_sub(1);
        if state.active_reads == 0 {
            self.gate.idle.notify_all();
        }
    }
}

impl SyncularState {
    fn send(&self, request: Request) -> Result<(), String> {
        self.sender
            .lock()
            .map_err(|_| "syncular mailbox poisoned".to_owned())?
            .send(request)
            .map_err(|_| "the syncular core thread has stopped".to_owned())
    }

    fn send_read(&self, request: ReadRequest) -> Result<(), String> {
        let Some(reader) = &self.reader else {
            return Err("this syncular client has no file snapshot reader".to_owned());
        };
        reader
            .lock()
            .map_err(|_| "syncular read mailbox poisoned".to_owned())?
            .send(request)
            .map_err(|_| "the syncular read thread has stopped".to_owned())?;
        Ok(())
    }
}

fn run_reader_thread(path: String, rx: Receiver<ReadRequest>) {
    let mut reader = FileQuerySnapshotReader::new(path);
    while let Ok(request) = rx.recv() {
        match request {
            ReadRequest::QuerySnapshot {
                sql,
                params,
                coverage,
                reply,
            } => {
                let value = match reader.query_snapshot(&sql, &params, &coverage) {
                    Ok(snapshot) => json!({ "result": snapshot }),
                    Err(message) => json!({
                        "error": { "code": "client.failed", "message": message }
                    }),
                };
                let _ = reply.send(value);
            }
            ReadRequest::Shutdown => return,
        }
    }
}

/// The owning thread: builds the core, then loops over the mailbox and the
/// background host policy. `emit` pushes drained events onto the Tauri channel.
fn run_owner_thread<F>(config: SyncularConfig, tx: Sender<Request>, rx: Receiver<Request>, emit: F)
where
    F: Fn(&Value) + Send + 'static,
{
    let transport_json = config.to_transport_json();
    let wake_tx = tx.clone();
    let notify: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
        let _ = wake_tx.send(Request::TransportWake);
    });
    let mut core = match SyncularCore::new_with_notify(&transport_json, Some(notify)) {
        Ok(core) => core,
        Err(message) => {
            // A construction failure is terminal for this instance; surface it
            // once on the channel so the webview can show it, then stop.
            emit(&json!({ "type": "error", "message": message }));
            return;
        }
    };

    // No idle poll: commands/realtime wake the mailbox, while a retryable
    // transport failure contributes one real monotonic deadline.
    let mut background_deadline: Option<Instant> = None;
    loop {
        if config.auto_sync {
            match core.take_sync_intent() {
                syncular_client::SyncIntent::Interactive => {
                    background_deadline = None;
                    core.sync_until_idle();
                    pump_events(&mut core, &emit);
                    continue;
                }
                syncular_client::SyncIntent::Background { delay_ms } => {
                    let candidate = Instant::now()
                        .checked_add(Duration::from_millis(delay_ms))
                        .unwrap_or_else(Instant::now);
                    background_deadline = Some(
                        background_deadline.map_or(candidate, |current| current.min(candidate)),
                    );
                }
                syncular_client::SyncIntent::None => {}
            }
        }

        let request = if let Some(deadline) = background_deadline {
            let now = Instant::now();
            if deadline <= now {
                background_deadline = None;
                core.sync_until_idle();
                pump_events(&mut core, &emit);
                continue;
            }
            match rx.recv_timeout(deadline.saturating_duration_since(now)) {
                Ok(request) => request,
                Err(RecvTimeoutError::Timeout) => {
                    background_deadline = None;
                    core.sync_until_idle();
                    pump_events(&mut core, &emit);
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    core.shutdown();
                    return;
                }
            }
        } else {
            match rx.recv() {
                Ok(request) => request,
                Err(std::sync::mpsc::RecvError) => {
                    core.shutdown();
                    return;
                }
            }
        };

        match request {
            Request::Command { command, reply } => {
                let command = inject_db_path(command, &config);
                let result = core.command(&command);
                let _ = reply.send(result);
                pump_events(&mut core, &emit);
            }
            Request::Query { sql, params, reply } => {
                let result = core.query(&sql, params);
                let _ = reply.send(result);
                pump_events(&mut core, &emit);
            }
            Request::SetHeaders { headers, reply } => {
                core.set_headers(headers);
                let _ = reply.send(json!({ "result": null }));
            }
            Request::TransportWake => {
                core.poll_transport();
                pump_events(&mut core, &emit);
            }
            #[cfg(test)]
            Request::Block { duration, entered } => {
                let _ = entered.send(());
                std::thread::sleep(duration);
            }
            Request::Shutdown => {
                core.shutdown();
                return;
            }
        }
    }
}

/// Inject the configured `db_path` into a `create` command's params if the JS
/// side did not already supply one — so persistence is a plugin-config concern,
/// not something every app must thread through the bridge.
fn inject_db_path(mut command: Value, config: &SyncularConfig) -> Value {
    if command.get("method").and_then(Value::as_str) != Some("create") {
        return command;
    }
    let Some(db_path) = &config.db_path else {
        return command;
    };
    let params = command.get_mut("params").and_then(Value::as_object_mut);
    if let Some(params) = params {
        params
            .entry("dbPath")
            .or_insert_with(|| Value::from(db_path.clone()));
    } else if let Some(obj) = command.as_object_mut() {
        obj.insert("params".to_owned(), json!({ "dbPath": db_path }));
    }
    command
}

fn client_error(message: impl Into<String>) -> Value {
    json!({ "error": { "code": "client.failed", "message": message.into() } })
}

fn security_preflight_error() -> Value {
    json!({
        "error": {
            "code": syncular_client::SECURITY_PREFLIGHT_REQUIRED_CODE,
            "message": "the local replica is in security preflight; complete quarantine checks and call activateSecurity before accessing protected data"
        }
    })
}

fn parse_window_base(value: Option<&Value>) -> Result<WindowBase, String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "querySnapshot coverage missing base object".to_owned())?;
    let table = object
        .get("table")
        .and_then(Value::as_str)
        .ok_or_else(|| "window base missing table".to_owned())?
        .to_owned();
    let variable = object
        .get("variable")
        .and_then(Value::as_str)
        .ok_or_else(|| "window base missing variable".to_owned())?
        .to_owned();
    let fixed_scopes = match object.get("fixedScopes") {
        Some(value) => syncular_client::values::json_to_scope_map(value)?,
        None => Vec::new(),
    };
    let params = object
        .get("params")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(WindowBase {
        table,
        variable,
        fixed_scopes,
        params,
    })
}

fn parse_coverage(value: Option<&Value>) -> Result<Vec<WindowCoverage>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let entries = value
        .as_array()
        .ok_or_else(|| "querySnapshot coverage must be a list".to_owned())?;
    entries
        .iter()
        .map(|entry| {
            let units = entry
                .get("units")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            Ok(WindowCoverage {
                base: parse_window_base(entry.get("base"))?,
                units,
            })
        })
        .collect()
}

fn pump_events<F: Fn(&Value)>(core: &mut SyncularCore, emit: &F) {
    for event in core.drain_events() {
        emit(&event.json);
    }
}

// -- Tauri commands (the thin shell) -----------------------------------------

#[tauri::command]
async fn syncular_command<R: Runtime>(
    app: tauri::AppHandle<R>,
    command: Value,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    let method = command
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if method == "create" || method == "beginSecurityPreflight" || method == "shutdown" {
        // Gate fast reads and wait for already-started sidecar snapshots before
        // the owner-thread barrier is enqueued.
        state.security_gate.begin_preflight()?;
    }
    let create_preflight = method == "create"
        && command
            .pointer("/params/securityPreflight")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Command {
        command,
        reply: reply_tx,
    })?;
    let reply = reply_rx
        .recv()
        .map_err(|_| "the syncular core dropped the reply".to_owned())?;
    let succeeded = reply.get("error").is_none();
    if succeeded && method == "create" {
        if !create_preflight {
            state.security_gate.activate()?;
        }
    } else if succeeded && method == "activateSecurity" {
        state.security_gate.activate()?;
    }
    Ok(reply)
}

/// Replace the native transport's request headers at runtime — the auth
/// rotation path (RFC 0002 §2.3): a fresh JWT reaches the transport without
/// re-registering the plugin. HTTP requests use the new set from the next
/// call; the realtime socket applies it on its next (re)connect.
#[tauri::command]
async fn syncular_set_headers<R: Runtime>(
    app: tauri::AppHandle<R>,
    headers: std::collections::BTreeMap<String, String>,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::SetHeaders {
        headers: headers.into_iter().collect(),
        reply: reply_tx,
    })?;
    reply_rx
        .recv()
        .map_err(|_| "the syncular core dropped the reply".to_owned())
}

#[tauri::command]
async fn syncular_query<R: Runtime>(
    app: tauri::AppHandle<R>,
    sql: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    let _read_guard = match state.security_gate.enter_read() {
        Ok(guard) => guard,
        Err(reply) => return Ok(reply),
    };
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Query {
        sql,
        params: params.unwrap_or(Value::Null),
        reply: reply_tx,
    })?;
    reply_rx
        .recv()
        .map_err(|_| "the syncular core dropped the reply".to_owned())
}

/// Atomic rows + revision + window coverage on the independent read-only
/// connection. In-memory configurations fall back to the core owner because
/// SQLite cannot share an anonymous database across connections.
#[tauri::command]
async fn syncular_query_snapshot<R: Runtime>(
    app: tauri::AppHandle<R>,
    sql: String,
    params: Option<Value>,
    coverage: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    let _read_guard = match state.security_gate.enter_read() {
        Ok(guard) => guard,
        Err(reply) => return Ok(reply),
    };
    let params_value = params.unwrap_or_else(|| Value::Array(Vec::new()));
    let coverage_value = coverage.unwrap_or_else(|| Value::Array(Vec::new()));

    if state.reader.is_some() {
        let bind = match params_value.as_array() {
            Some(values) => values.clone(),
            None => return Ok(client_error("querySnapshot params must be a list")),
        };
        let parsed_coverage = match parse_coverage(Some(&coverage_value)) {
            Ok(value) => value,
            Err(message) => return Ok(client_error(message)),
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        state.send_read(ReadRequest::QuerySnapshot {
            sql,
            params: bind,
            coverage: parsed_coverage,
            reply: reply_tx,
        })?;
        return reply_rx
            .recv()
            .map_err(|_| "the syncular read thread dropped the reply".to_owned());
    }

    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Command {
        command: json!({
            "method": "querySnapshot",
            "params": { "sql": sql, "params": params_value, "coverage": coverage_value }
        }),
        reply: reply_tx,
    })?;
    reply_rx
        .recv()
        .map_err(|_| "the syncular core dropped the reply".to_owned())
}

/// Initialize the plugin with a config. Register with
/// `tauri::Builder::default().plugin(tauri_plugin_syncular::init(config))`.
///
/// The owning thread is spawned in `setup`; it builds the core (native
/// transport if `base_url` + the `native-transport` feature), pumps events onto
/// [`EVENT_NAME`], and runs the §8.4 host loop. The mailbox `Sender` is managed
/// as plugin state and torn down on `RunEvent::Exit`.
pub fn init<R: Runtime>(config: SyncularConfig) -> TauriPlugin<R> {
    Builder::<R>::new("syncular")
        .invoke_handler(tauri::generate_handler![
            syncular_command,
            syncular_query,
            syncular_query_snapshot,
            syncular_set_headers
        ])
        .setup(move |app, _api| {
            let (tx, rx) = std::sync::mpsc::channel::<Request>();
            let reader = match config
                .db_path
                .as_ref()
                .filter(|path| path.as_str() != ":memory:")
            {
                Some(path) => {
                    let (reader_tx, reader_rx) = std::sync::mpsc::channel::<ReadRequest>();
                    let path = path.clone();
                    std::thread::Builder::new()
                        .name("syncular-read".to_owned())
                        .spawn(move || run_reader_thread(path, reader_rx))
                        .map_err(|e| format!("failed to spawn syncular read thread: {e}"))?;
                    Some(Mutex::new(reader_tx))
                }
                None => None,
            };
            app.manage(SyncularState {
                sender: Mutex::new(tx.clone()),
                reader,
                // Fail closed until the first successful `create` declares
                // whether this process starts active or in preflight.
                security_gate: SecurityGate::new_preflight(),
            });
            let app_handle = app.clone();
            let emit = move |value: &Value| {
                // Best-effort: a webview that has gone away must not crash the
                // owning thread. Emit to all windows on the syncular channel.
                let _ = app_handle.emit(EVENT_NAME, value.clone());
            };
            std::thread::Builder::new()
                .name("syncular-core".to_owned())
                .spawn(move || run_owner_thread(config, tx, rx, emit))
                .map_err(|e| format!("failed to spawn syncular core thread: {e}"))?;
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SyncularState>() {
                    let _ = state.send(Request::Shutdown);
                    if state.reader.is_some() {
                        let _ = state.send_read(ReadRequest::Shutdown);
                    }
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_to_transport_json_shapes_fields() {
        let config = SyncularConfig {
            base_url: Some("https://api.example.com".to_owned()),
            headers: vec![("authorization".to_owned(), "Bearer x".to_owned())],
            ..Default::default()
        };
        let json = config.to_transport_json();
        assert_eq!(json["baseUrl"], "https://api.example.com");
        assert_eq!(json["headers"]["authorization"], "Bearer x");
    }

    #[test]
    fn security_gate_blocks_new_reads_and_waits_for_in_flight_snapshots() {
        let gate = std::sync::Arc::new(SecurityGate::new_preflight());
        gate.activate().expect("activate test gate");
        let read = gate.enter_read().expect("active read");
        let gate_for_barrier = std::sync::Arc::clone(&gate);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let barrier = std::thread::spawn(move || {
            gate_for_barrier.begin_preflight().expect("enter preflight");
            done_tx.send(()).expect("barrier reply");
        });

        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
        drop(read);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("barrier drains after the read");
        barrier.join().expect("barrier thread");
        assert!(gate.enter_read().is_err());
    }

    #[test]
    fn inject_db_path_adds_to_create_only() {
        let config = SyncularConfig {
            db_path: Some("/tmp/app.db".to_owned()),
            ..Default::default()
        };
        // create gains the path…
        let created = inject_db_path(
            json!({ "method": "create", "params": { "clientId": "c1" } }),
            &config,
        );
        assert_eq!(created["params"]["dbPath"], "/tmp/app.db");
        // …a create with no params object gets one…
        let created2 = inject_db_path(json!({ "method": "create" }), &config);
        assert_eq!(created2["params"]["dbPath"], "/tmp/app.db");
        // …an explicit dbPath is preserved…
        let explicit = inject_db_path(
            json!({ "method": "create", "params": { "dbPath": "/other.db" } }),
            &config,
        );
        assert_eq!(explicit["params"]["dbPath"], "/other.db");
        // …and a non-create command is untouched.
        let mutate = inject_db_path(json!({ "method": "mutate", "params": {} }), &config);
        assert!(mutate["params"].get("dbPath").is_none());
    }

    #[test]
    fn snapshot_coverage_parser_preserves_the_generated_window_descriptor() {
        let parsed = parse_coverage(Some(&json!([{
            "base": {
                "table": "tasks",
                "variable": "project_id",
                "fixedScopes": { "tenant_id": ["one", "two"] },
                "params": "opaque"
            },
            "units": ["a", "b"]
        }])))
        .expect("parse coverage");
        assert_eq!(parsed.len(), 1);
        let entry = &parsed[0];
        assert_eq!(entry.base.table, "tasks");
        assert_eq!(entry.base.variable, "project_id");
        assert_eq!(
            entry.base.fixed_scopes,
            vec![(
                "tenant_id".to_owned(),
                vec!["one".to_owned(), "two".to_owned()]
            )]
        );
        assert_eq!(entry.base.params.as_deref(), Some("opaque"));
        assert_eq!(entry.units, vec!["a".to_owned(), "b".to_owned()]);
    }

    /// The owner-thread mailbox loop end-to-end, without any Tauri window: post
    /// commands, collect emitted events. This is the real host path — the Tauri
    /// commands are a two-line channel forward over exactly this.
    #[test]
    fn owner_thread_round_trips_over_mailbox() {
        use std::sync::mpsc::channel;
        use std::sync::{Arc, Mutex as StdMutex};

        let (tx, rx) = channel::<Request>();
        let events: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let events_for_thread = Arc::clone(&events);
        let config = SyncularConfig {
            auto_sync: false,
            ..Default::default()
        };
        let owner_tx = tx.clone();
        let handle = std::thread::spawn(move || {
            run_owner_thread(config, owner_tx, rx, move |v| {
                events_for_thread.lock().unwrap().push(v.clone());
            });
        });

        let call = |command: Value| -> Value {
            let (rtx, rrx) = channel();
            tx.send(Request::Command {
                command,
                reply: rtx,
            })
            .unwrap();
            rrx.recv().unwrap()
        };

        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "todo", "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ],
                "scopes": []
            }]
        });
        assert_eq!(
            call(json!({ "method": "create", "params": { "clientId": "c1", "schema": schema } }))
                ["result"],
            json!({})
        );
        call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "t1", "title": "hi" }
        }] } }));

        // A query over the mailbox.
        let (qtx, qrx) = channel();
        tx.send(Request::Query {
            sql: "SELECT title FROM todo".to_owned(),
            params: Value::Null,
            reply: qtx,
        })
        .unwrap();
        let rows = qrx.recv().unwrap();
        assert_eq!(rows["result"]["rows"][0]["title"], "hi");

        // RFC 0002 §2.3: header rotation rides the same mailbox; a
        // client-local (Null-transport) core accepts and ignores the set.
        let (htx, hrx) = channel();
        tx.send(Request::SetHeaders {
            headers: vec![("authorization".to_owned(), "Bearer fresh".to_owned())],
            reply: htx,
        })
        .unwrap();
        assert_eq!(hrx.recv().unwrap()["result"], Value::Null);

        tx.send(Request::Shutdown).unwrap();
        handle.join().unwrap();

        let seen = events.lock().unwrap();
        let kinds: Vec<String> = seen
            .iter()
            .filter_map(|e| e.get("type").and_then(Value::as_str).map(str::to_owned))
            .collect();
        // The local mutate emits the exact revisioned batch onto the channel.
        assert!(kinds.iter().any(|k| k == "change"), "kinds: {kinds:?}");
    }

    #[test]
    fn snapshot_reader_is_not_blocked_by_the_network_owner_mailbox() {
        use std::sync::mpsc::channel;

        let path =
            std::env::temp_dir().join(format!("syncular-tauri-sidecar-{}.db", std::process::id()));
        let config = SyncularConfig {
            db_path: Some(path.to_string_lossy().into_owned()),
            auto_sync: false,
            ..Default::default()
        };
        let (tx, rx) = channel::<Request>();
        let owner_tx = tx.clone();
        let owner = std::thread::spawn(move || run_owner_thread(config, owner_tx, rx, |_| {}));

        let (create_tx, create_rx) = channel();
        tx.send(Request::Command {
            command: json!({
                "method": "create",
                "params": {
                    "clientId": "sidecar-client",
                    "schema": { "version": 1, "tables": [] },
                    "dbPath": path.to_string_lossy()
                }
            }),
            reply: create_tx,
        })
        .expect("post create");
        assert_eq!(create_rx.recv().expect("create reply")["result"], json!({}));

        let (read_tx, read_rx) = channel::<ReadRequest>();
        let read_path = path.to_string_lossy().into_owned();
        let reader = std::thread::spawn(move || run_reader_thread(read_path, read_rx));

        // Model a slow HTTP/WS round on the mutable owner. The dedicated read
        // mailbox must still return the durable local snapshot immediately.
        let (entered_tx, entered_rx) = channel();
        tx.send(Request::Block {
            duration: Duration::from_millis(200),
            entered: entered_tx,
        })
        .expect("block owner");
        entered_rx.recv().expect("owner entered blocking round");
        let (snapshot_tx, snapshot_rx) = channel();
        read_tx
            .send(ReadRequest::QuerySnapshot {
                sql: "SELECT 1 AS value".to_owned(),
                params: Vec::new(),
                coverage: Vec::new(),
                reply: snapshot_tx,
            })
            .expect("post snapshot");
        let snapshot = snapshot_rx
            .recv_timeout(Duration::from_millis(50))
            .expect("local snapshot must not wait for the owner");
        assert_eq!(snapshot["result"]["rows"][0]["value"], 1);

        read_tx.send(ReadRequest::Shutdown).expect("stop reader");
        reader.join().expect("join reader");
        tx.send(Request::Shutdown).expect("stop owner");
        owner.join().expect("join owner");
        std::fs::remove_file(path).expect("remove temp database");
    }
}
