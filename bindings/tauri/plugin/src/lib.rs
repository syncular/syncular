//! # tauri-plugin-syncular — a native syncular instance inside the Tauri process
//!
//! A NATIVE syncular client (the Rust `syncular-client` core, consumed
//! DIRECTLY — no FFI) runs in the Tauri host process and is exposed to the
//! webview as Tauri commands + events. The JS bridge (`@syncular-v2/tauri`)
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
//! - `syncular://event` — a Tauri event carrying the derived client-observable
//!   events (`sync-needed` / `conflict` / `presence` / `invalidate` / …), the
//!   invalidation-equivalent set the FFI `poll_event` surfaces.
//!
//! ## Thread-safety, honestly
//!
//! [`core::SyncularCore`] owns a rusqlite connection and is NOT `Sync`. One
//! owning thread holds it; every command arrives over a mailbox (mpsc). The
//! background host loop (§8.4 wake-driven `syncUntilIdle` with jitter) runs ON
//! that same thread, interleaved with mailbox requests, so the connection is
//! never touched concurrently — the same one-owning-thread pattern as the shim.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Manager, RunEvent, Runtime};

pub mod core;
pub mod transport;

use core::SyncularCore;

/// The Tauri event name carrying derived client-observable events.
pub const EVENT_NAME: &str = "syncular://event";

/// Plugin configuration. Passed to [`init`]; every field is optional except a
/// caller almost always wants a `base_url` (for real network sync) and a
/// `db_path` (for persistence — defaults to an in-memory core if absent).
#[derive(Debug, Clone, Default)]
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
    /// §8.4 host-loop jitter cap (ms) applied to each wake before a
    /// `syncUntilIdle`. 0 disables jitter. Default 250.
    pub wake_jitter_ms: u64,
    /// Run the background host loop (§8.4). Default true.
    pub auto_sync: bool,
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
    Shutdown,
}

/// The plugin's managed state: the mailbox sender the commands post to. Wrapped
/// in a `Mutex` only to be `Sync` for Tauri state (the `Sender` is `Send`).
struct SyncularState {
    sender: Mutex<Sender<Request>>,
}

impl SyncularState {
    fn send(&self, request: Request) -> Result<(), String> {
        self.sender
            .lock()
            .map_err(|_| "syncular mailbox poisoned".to_owned())?
            .send(request)
            .map_err(|_| "the syncular core thread has stopped".to_owned())
    }
}

/// The owning thread: builds the core, then loops over the mailbox and the
/// background host policy. `emit` pushes drained events onto the Tauri channel.
fn run_owner_thread<F>(config: SyncularConfig, rx: Receiver<Request>, emit: F)
where
    F: Fn(&Value) + Send + 'static,
{
    let transport_json = config.to_transport_json();
    let mut core = match SyncularCore::new(&transport_json) {
        Ok(core) => core,
        Err(message) => {
            // A construction failure is terminal for this instance; surface it
            // once on the channel so the webview can show it, then stop.
            emit(&json!({ "type": "error", "message": message }));
            return;
        }
    };

    // The host loop cadence: block on the mailbox with a timeout so we wake
    // periodically to run a sync round when the core wants one (§8.4). The
    // db_path is injected into the FIRST `create` command so the app does not
    // have to thread it through the JS side.
    let idle_poll = Duration::from_millis(200);
    let jitter_cap = config.wake_jitter_ms;
    let mut next_seed: u64 = std::process::id() as u64 ^ 0x9E37_79B9_7F4A_7C15;

    // A tiny xorshift for jitter — no rand dependency for one number.
    let mut jitter = || {
        if jitter_cap == 0 {
            return Duration::ZERO;
        }
        next_seed ^= next_seed << 13;
        next_seed ^= next_seed >> 7;
        next_seed ^= next_seed << 17;
        Duration::from_millis(next_seed % (jitter_cap + 1))
    };

    let mut last_sync = Instant::now();
    loop {
        let request = rx.recv_timeout(idle_poll);
        match request {
            Ok(Request::Command { command, reply }) => {
                let command = inject_db_path(command, &config);
                let result = core.command(&command);
                let _ = reply.send(result);
                pump_events(&mut core, &emit);
            }
            Ok(Request::Query { sql, params, reply }) => {
                let result = core.query(&sql, params);
                let _ = reply.send(result);
                pump_events(&mut core, &emit);
            }
            Ok(Request::Shutdown) => {
                core.shutdown();
                return;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Background host loop (§8.4): if the core wants a sync and the
                // transport can reach the network, run one syncUntilIdle round
                // after a jittered wait. Client-local (`Null` transport) cores
                // simply never report sync_needed usefully → cheap no-op.
                if config.auto_sync && core.sync_needed() {
                    let wait = jitter();
                    if !wait.is_zero() {
                        std::thread::sleep(wait);
                    }
                    core.sync_until_idle();
                    last_sync = Instant::now();
                    pump_events(&mut core, &emit);
                }
                let _ = last_sync;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
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
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Command {
        command,
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

/// Initialize the plugin with a config. Register with
/// `tauri::Builder::default().plugin(tauri_plugin_syncular::init(config))`.
///
/// The owning thread is spawned in `setup`; it builds the core (native
/// transport if `base_url` + the `native-transport` feature), pumps events onto
/// [`EVENT_NAME`], and runs the §8.4 host loop. The mailbox `Sender` is managed
/// as plugin state and torn down on `RunEvent::Exit`.
pub fn init<R: Runtime>(config: SyncularConfig) -> TauriPlugin<R> {
    // Default the auto_sync flag on (the caller-built Default has it false).
    let config = SyncularConfig {
        auto_sync: true,
        wake_jitter_ms: if config.wake_jitter_ms == 0 && config.base_url.is_none() {
            0
        } else if config.wake_jitter_ms == 0 {
            250
        } else {
            config.wake_jitter_ms
        },
        ..config
    };

    Builder::<R>::new("syncular")
        .invoke_handler(tauri::generate_handler![syncular_command, syncular_query])
        .setup(move |app, _api| {
            let (tx, rx) = std::sync::mpsc::channel::<Request>();
            app.manage(SyncularState {
                sender: Mutex::new(tx),
            });
            let app_handle = app.clone();
            let emit = move |value: &Value| {
                // Best-effort: a webview that has gone away must not crash the
                // owning thread. Emit to all windows on the syncular channel.
                let _ = app_handle.emit(EVENT_NAME, value.clone());
            };
            std::thread::Builder::new()
                .name("syncular-core".to_owned())
                .spawn(move || run_owner_thread(config, rx, emit))
                .map_err(|e| format!("failed to spawn syncular core thread: {e}"))?;
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SyncularState>() {
                    let _ = state.send(Request::Shutdown);
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
        let handle = std::thread::spawn(move || {
            run_owner_thread(config, rx, move |v| {
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

        tx.send(Request::Shutdown).unwrap();
        handle.join().unwrap();

        let seen = events.lock().unwrap();
        let kinds: Vec<String> = seen
            .iter()
            .filter_map(|e| e.get("type").and_then(Value::as_str).map(str::to_owned))
            .collect();
        // The local mutate emits an `invalidate` onto the channel (the signal
        // the JS bridge fans out to onInvalidate so live queries re-run).
        assert!(kinds.iter().any(|k| k == "invalidate"), "kinds: {kinds:?}");
    }
}
