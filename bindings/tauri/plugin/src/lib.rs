//! # tauri-plugin-syncular — a native syncular instance inside the Tauri process
//!
//! A NATIVE syncular client (the Rust `syncular-client` core, consumed
//! DIRECTLY — no FFI) runs in the Tauri host process and is exposed to the
//! webview as Tauri commands + events. The JS bridge (`@syncular/tauri`)
//! implements the same `SyncClientLike` interface the React package
//! normalizes, so the hooks work unchanged — the fourth host of one interface
//! after direct / worker-leader / follower.
//!
//! The webview does not run JS syncular. Webview OPFS is eviction-prone and inconsistent across
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

use std::collections::BTreeSet;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Manager, RunEvent, Runtime};

pub mod core;
pub mod transport;

use core::SyncularCore;
use syncular_client::{
    FileQuerySnapshotReader, QueryReadFailure, WindowBase, WindowCoverage,
    MAX_DIAGNOSTIC_QUERY_FAILURES,
};

/// The Tauri event name carrying derived client-observable events.
pub const EVENT_NAME: &str = "syncular://event";

/// Plugin configuration. Passed to [`init`]; every field is optional except a
/// caller almost always wants a `base_url` (for real network sync) and a
/// `database_dir` or `db_path` (for persistence — defaults to an in-memory core
/// if both are absent).
#[derive(Debug, Clone)]
pub struct SyncularConfig {
    /// Server base URL for the native HTTP+WS transport (needs the
    /// `native-transport` feature). Absent → client-local only.
    pub base_url: Option<String>,
    /// Optional realtime WS URL; derived from `base_url` when absent.
    pub ws_url: Option<String>,
    /// Extra request headers (auth, actor/project ids) as (name, value).
    pub headers: Vec<(String, String)>,
    /// Per-request network deadline in milliseconds. `None` (the default)
    /// leaves requests unbounded, matching the reference HTTP binding.
    pub request_timeout_ms: Option<u64>,
    /// One monotonic deadline for a whole sync round (uploads, continuations,
    /// main request, and every segment fetch) in milliseconds. `None` (the
    /// default) leaves the round unbounded.
    pub round_deadline_ms: Option<u64>,
    /// Largest request body the transport will send, in bytes. `None` (the
    /// default) is unbounded.
    pub max_request_bytes: Option<u64>,
    /// Largest decoded (post-decompression) response body, in bytes. `None`
    /// (the default) is unbounded.
    pub max_response_bytes: Option<u64>,
    /// Redirect handling: `"deny"` (the default) refuses every redirect so
    /// configured credentials, URL userinfo, and signed capabilities never
    /// replay to another origin; `"follow"` follows a redirect only for a
    /// request with none of those, and still refuses a credential-bearing
    /// request.
    pub redirects: Option<String>,
    /// On-disk SQLite path a `create` opens when it names no database. Absent →
    /// in-memory (nothing survives a restart). Apps usually set this to a file
    /// under the app-data dir; see [`init`].
    pub db_path: Option<String>,
    /// Directory of the named databases. A `create` that carries `database`
    /// (for example one replica per signed-in actor) opens
    /// `<database_dir>/<database>.db`; the plugin creates the directory. The
    /// webview names a database and never supplies a path.
    pub database_dir: Option<String>,
    /// Run the background host loop (§8.4). Default true.
    pub auto_sync: bool,
    /// Native app-approved table/column ceiling. Webview create selects scopes
    /// and a subset; raw IPC cannot expand this policy.
    pub authority_columns: std::collections::BTreeMap<String, Vec<String>>,
}

impl Default for SyncularConfig {
    fn default() -> Self {
        Self {
            base_url: None,
            ws_url: None,
            headers: Vec::new(),
            request_timeout_ms: None,
            round_deadline_ms: None,
            max_request_bytes: None,
            max_response_bytes: None,
            redirects: None,
            db_path: None,
            database_dir: None,
            auto_sync: true,
            authority_columns: std::collections::BTreeMap::new(),
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
        if let Some(ms) = self.request_timeout_ms {
            map.insert("requestTimeoutMs".to_owned(), Value::from(ms));
        }
        if let Some(ms) = self.round_deadline_ms {
            map.insert("roundDeadlineMs".to_owned(), Value::from(ms));
        }
        if let Some(bytes) = self.max_request_bytes {
            map.insert("maxRequestBytes".to_owned(), Value::from(bytes));
        }
        if let Some(bytes) = self.max_response_bytes {
            map.insert("maxResponseBytes".to_owned(), Value::from(bytes));
        }
        if let Some(redirects) = &self.redirects {
            map.insert("redirects".to_owned(), Value::from(redirects.clone()));
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
    /// Replace the transport's request headers. Header state
    /// lives on the core-owned transport, so mutation rides the same mailbox
    /// as every other access — the one-owning-thread invariant holds.
    SetHeaders {
        headers: Vec<(String, String)>,
        reply: Sender<Value>,
    },
    /// Native realtime reader wake; contains no data (the transport buffer does).
    TransportWake,
    RoundFinished(
        Box<(
            syncular_client::CompletedSyncRound,
            crate::transport::HostTransport,
        )>,
    ),
    /// §7.6: an owned read-sidecar failure, or the first success after one.
    QueryRead {
        id: String,
        tables: Vec<String>,
        failure: Option<QueryReadFailure>,
    },
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
        owner: Option<(String, Vec<String>)>,
        reply: Sender<Value>,
    },
    /// §7.5: one atomic read over the shared primitive, carrying every
    /// requested statement, catch-up state, and delivery.
    SnapshotRead {
        statements: Vec<(String, Vec<Value>)>,
        coverage: Vec<WindowCoverage>,
        subscriptions: Vec<String>,
        commit_ids: Vec<String>,
        owner: Option<(String, Vec<String>)>,
        reply: Sender<Value>,
    },
    /// Stop the reader thread.
    Shutdown,
}

/// The `{error: {code, message, details?, retryable?}}` envelope the read
/// sidecar returns. `retryable` mirrors the §7.5 write-failure classification
/// so a `SQLITE_BUSY` read keeps `client.storage_busy` retryability.
fn read_failure_json(failure: syncular_client::QueryReadFailure) -> Value {
    json!({
        "error": {
            "code": failure.code.unwrap_or("client.failed"),
            "message": failure.message,
            "details": failure.details(),
            "retryable": failure.retryable(),
        }
    })
}

/// The plugin's managed state: the mailbox sender the commands post to. Wrapped
/// in a `Mutex` only to be `Sync` for Tauri state (the `Sender` is `Send`).
struct SyncularState {
    sender: Mutex<Sender<Request>>,
    /// The snapshot reader of the file database the last successful `create`
    /// opened; `None` before it, after `shutdown`, and for an in-memory client.
    /// `create` and `shutdown` hold this lock until their reply, so the reader
    /// always reads the database the owner has open.
    reader: Mutex<Option<Sender<ReadRequest>>>,
    config: SyncularConfig,
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

    fn reader(&self) -> Result<Option<Sender<ReadRequest>>, String> {
        Ok(self
            .reader
            .lock()
            .map_err(|_| "syncular read mailbox poisoned".to_owned())?
            .clone())
    }
}

fn spawn_reader(path: String, owner_tx: Sender<Request>) -> Result<Sender<ReadRequest>, String> {
    let (reader_tx, reader_rx) = std::sync::mpsc::channel::<ReadRequest>();
    std::thread::Builder::new()
        .name("syncular-read".to_owned())
        .spawn(move || run_reader_thread(path, reader_rx, owner_tx))
        .map_err(|e| format!("failed to spawn syncular read thread: {e}"))?;
    Ok(reader_tx)
}

/// One owner the read sidecar has reported a failure for, carrying exactly the
/// fields the owning core journals it under (`record_query_read` compares
/// tables, code, and sqlite code before re-ordering an entry).
struct ReportedQueryFailure {
    id: String,
    tables: Vec<String>,
    code: &'static str,
    sqlite_code: Option<i32>,
}

/// §7.6: report an owned read to the owner mailbox only on a failure
/// transition: every failure, plus the first success that clears one, so a
/// clean success loop enqueues nothing and the reader never waits for the owner
/// to catch up on an earlier message. The mirror follows the core journal's
/// retention: the tables are normalized the same way, an unchanged failure
/// signature keeps its position, and passing `MAX_DIAGNOSTIC_QUERY_FAILURES`
/// evicts the oldest id, so no owner id is kept without a bound.
fn report_owned_read(
    reported: &mut Vec<ReportedQueryFailure>,
    owner_tx: &Sender<Request>,
    id: String,
    tables: Vec<String>,
    failure: Option<QueryReadFailure>,
) {
    let position = reported.iter().position(|entry| entry.id == id);
    let Some(failure) = failure else {
        // Only the success that clears an outstanding failure is a transition.
        let Some(index) = position else {
            return;
        };
        reported.remove(index);
        let _ = owner_tx.send(Request::QueryRead {
            id,
            tables,
            failure: None,
        });
        return;
    };
    let code = failure.code.unwrap_or("client.query_failed");
    let sqlite_code = failure.sqlite_code;
    let signature: Vec<String> = BTreeSet::from_iter(tables.iter().cloned())
        .into_iter()
        .collect();
    let unchanged = position.is_some_and(|index| {
        let entry = &reported[index];
        entry.tables == signature && entry.code == code && entry.sqlite_code == sqlite_code
    });
    if !unchanged {
        if let Some(index) = position {
            reported.remove(index);
        }
        reported.push(ReportedQueryFailure {
            id: id.clone(),
            tables: signature,
            code,
            sqlite_code,
        });
        if reported.len() > MAX_DIAGNOSTIC_QUERY_FAILURES {
            reported.remove(0);
        }
    }
    let _ = owner_tx.send(Request::QueryRead {
        id,
        tables,
        failure: Some(failure),
    });
}

fn run_reader_thread(path: String, rx: Receiver<ReadRequest>, owner_tx: Sender<Request>) {
    let mut reader = FileQuerySnapshotReader::new(path);
    // The read sidecar's own reports, bounded like the core journal.
    let mut reported: Vec<ReportedQueryFailure> = Vec::new();
    while let Ok(request) = rx.recv() {
        match request {
            ReadRequest::QuerySnapshot {
                sql,
                params,
                coverage,
                owner,
                reply,
            } => {
                let result = reader.query_snapshot(&sql, &params, &coverage);
                let value = match &result {
                    Ok(snapshot) => json!({ "result": snapshot }),
                    Err(failure) => read_failure_json(failure.clone()),
                };
                if let Some((id, tables)) = owner {
                    report_owned_read(&mut reported, &owner_tx, id, tables, result.err());
                }
                let _ = reply.send(value);
            }
            ReadRequest::SnapshotRead {
                statements,
                coverage,
                subscriptions,
                commit_ids,
                owner,
                reply,
            } => {
                let request = syncular_client::SnapshotReadRequest {
                    statements: statements
                        .iter()
                        .map(|(sql, params)| syncular_client::SnapshotStatement { sql, params })
                        .collect(),
                    coverage: &coverage,
                    subscriptions,
                    commit_ids,
                };
                let result = reader.snapshot_read(&request);
                let value = match &result {
                    Ok(read) => json!({ "result": read }),
                    Err(failure) => read_failure_json(failure.clone()),
                };
                // §7.6: the same owner-failure bookkeeping the QuerySnapshot
                // read uses, so a named owner gets one diagnostic path.
                if let Some((id, tables)) = owner {
                    report_owned_read(&mut reported, &owner_tx, id, tables, result.err());
                }
                let _ = reply.send(value);
            }
            ReadRequest::Shutdown => return,
        }
    }
}

/// The owning thread: builds the core, then loops over the mailbox and the
/// background host policy. `emit` pushes drained events onto the Tauri channel.
/// One serialized I/O executor per owner. It never owns a SQLite connection.
enum NetworkWork {
    Round(
        Box<syncular_client::PreparedSyncRound>,
        crate::transport::HostTransport,
    ),
    Controls(Vec<String>, crate::transport::HostTransport),
}

struct RoundRun {
    reply: Option<Sender<Value>>,
    until_idle: bool,
    max_rounds: Option<u32>,
    spent: u32,
    aggregate: syncular_client::SyncReport,
}

fn run_owner_thread<F>(config: SyncularConfig, tx: Sender<Request>, rx: Receiver<Request>, emit: F)
where
    F: Fn(&Value) + Send + Sync + 'static,
{
    let emit = std::sync::Arc::new(emit);
    let wake_tx = tx.clone();
    let notify: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
        let _ = wake_tx.send(Request::TransportWake);
    });
    let mut core = match SyncularCore::new_with_notify(&config.to_transport_json(), Some(notify)) {
        Ok(core) => core,
        Err(message) => {
            emit(&json!({ "type": "error", "message": message }));
            return;
        }
    };
    let progress_emit = emit.clone();
    core.progress_listener = Some(std::sync::Arc::new(move |progress| {
        progress_emit(&json!({ "type": "progress", "progress": progress }));
    }));
    let (network_tx, network_rx) = std::sync::mpsc::channel();
    let completed_tx = tx.clone();
    let network = std::thread::spawn(move || {
        use syncular_client::Transport;
        while let Ok(work) = network_rx.recv() {
            match work {
                NetworkWork::Round(prepared, mut transport) => {
                    let completed = (*prepared).exchange(&mut transport);
                    if completed_tx
                        .send(Request::RoundFinished(Box::new((completed, transport))))
                        .is_err()
                    {
                        return;
                    }
                }
                NetworkWork::Controls(controls, mut transport) => {
                    for text in controls {
                        let _ = transport.realtime_send(&text);
                    }
                }
            }
        }
    });
    let mut active: Option<RoundRun> = None;
    let mut queued = std::collections::VecDeque::new();
    let mut background_deadline: Option<Instant> = None;
    loop {
        if !core.transport_enabled() {
            background_deadline = None;
        }
        if let Some((controls, transport)) = core.take_controls() {
            if network_tx
                .send(NetworkWork::Controls(controls, transport))
                .is_err()
            {
                break;
            }
        }
        // Consume sync intent only while idle. Mutations arriving mid-round
        // retain their coalesced intent and enter the next captured request.
        if active.is_none() {
            if let Some(run) = queued.pop_front() {
                active = Some(run);
            } else if config.auto_sync {
                match core.take_sync_intent() {
                    syncular_client::SyncIntent::Interactive => {
                        background_deadline = None;
                        active = Some(RoundRun {
                            reply: None,
                            until_idle: true,
                            max_rounds: None,
                            spent: 0,
                            aggregate: Default::default(),
                        });
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
            if active.is_some() {
                match core.prepare_round() {
                    Ok((prepared, transport)) => {
                        active.as_mut().expect("active run").spent += 1;
                        if network_tx
                            .send(NetworkWork::Round(Box::new(prepared), transport))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(outcome) => {
                        if let Some(reply) = active.take().and_then(|run| run.reply) {
                            let _ = reply.send(json!({ "result": outcome.to_json() }));
                        }
                    }
                }
                pump_events(&mut core, &*emit);
                if active.is_none() {
                    continue;
                }
            }
        }
        let request = if active.is_none() {
            if let Some(deadline) = background_deadline {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(request) => request,
                    Err(RecvTimeoutError::Timeout) => {
                        background_deadline = None;
                        queued.push_back(RoundRun {
                            reply: None,
                            until_idle: true,
                            max_rounds: None,
                            spent: 0,
                            aggregate: Default::default(),
                        });
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match rx.recv() {
                    Ok(request) => request,
                    Err(_) => break,
                }
            }
        } else {
            match rx.recv() {
                Ok(request) => request,
                Err(_) => break,
            }
        };
        match request {
            Request::RoundFinished(completed) => {
                let (completed, transport) = *completed;
                let applied = core.apply_round(completed);
                let (mut outcome, more, bootstrap_advanced) = match applied {
                    syncular_client::AppliedSyncRound::Continue(prepared) => {
                        if network_tx
                            .send(NetworkWork::Round(Box::new(prepared), transport))
                            .is_err()
                        {
                            break;
                        }
                        pump_events(&mut core, &*emit);
                        continue;
                    }
                    syncular_client::AppliedSyncRound::Complete {
                        outcome,
                        more,
                        bootstrap_advanced,
                        ..
                    } => (outcome, more, bootstrap_advanced),
                };
                let Some(mut run) = active.take() else {
                    continue;
                };
                let mut keep_running = false;
                if run.until_idle {
                    if let syncular_client::SyncOutcome::Ok(report) = &outcome {
                        run.aggregate.merge(report);
                        if bootstrap_advanced && run.max_rounds.is_none() {
                            run.spent = 0;
                        }
                        keep_running = more && core.transport_enabled();
                        if keep_running && run.spent >= run.max_rounds.unwrap_or(20) {
                            keep_running = false;
                            outcome = syncular_client::SyncOutcome::BudgetExhausted(
                                run.aggregate.clone(),
                            );
                        } else if !keep_running {
                            outcome = syncular_client::SyncOutcome::Ok(run.aggregate.clone());
                        }
                    }
                }
                if keep_running {
                    queued.push_front(run);
                } else if let Some(reply) = run.reply {
                    let _ = reply.send(json!({ "result": outcome.to_json() }));
                }
                pump_events(&mut core, &*emit);
            }
            Request::Command { command, reply } => {
                let method = command.get("method").and_then(Value::as_str);
                if matches!(method, Some("sync" | "syncUntilIdle")) && core.transport_enabled() {
                    let until_idle = method == Some("syncUntilIdle");
                    // The shared router ignores `maxRounds` for `sync`; only
                    // `syncUntilIdle` carries a round budget.
                    let max_rounds = if until_idle {
                        match command.pointer("/params/maxRounds") {
                            None | Some(Value::Null) => None,
                            Some(value) => match value
                                .as_u64()
                                .and_then(|n| u32::try_from(n).ok())
                                .filter(|n| *n >= 1)
                            {
                                Some(n) => Some(n),
                                None => {
                                    let _ = reply.send(json!({
                                        "error": {
                                            "code": "sync.invalid_request",
                                            "message": "maxRounds must be a positive integer",
                                            "retryable": false
                                        }
                                    }));
                                    continue;
                                }
                            },
                        }
                    } else {
                        None
                    };
                    queued.push_back(RoundRun {
                        reply: Some(reply),
                        until_idle,
                        max_rounds,
                        spent: 0,
                        aggregate: Default::default(),
                    });
                    continue;
                }
                let result = core.command(&command);
                let _ = reply.send(result);
                pump_events(&mut core, &*emit);
            }
            Request::Query { sql, params, reply } => {
                let _ = reply.send(core.query(&sql, params));
                pump_events(&mut core, &*emit);
            }
            Request::SetHeaders { headers, reply } => {
                core.set_headers(headers);
                let _ = reply.send(json!({ "result": null }));
            }
            Request::TransportWake => {
                core.poll_transport();
                pump_events(&mut core, &*emit);
            }
            Request::QueryRead {
                id,
                tables,
                failure,
            } => {
                core.record_query_read(&id, &tables, failure.as_ref());
                pump_events(&mut core, &*emit);
            }
            #[cfg(test)]
            Request::Block { duration, entered } => {
                let _ = entered.send(());
                std::thread::sleep(duration);
            }
            Request::Shutdown => break,
        }
    }
    core.shutdown();
    drop(network_tx);
    // Transport shutdown releases a pending socket round. An HTTP request
    // finishes on its own bounded transport timeout, outside the owner.
    let _ = network.join();
    for run in active.into_iter().chain(queued) {
        if let Some(reply) = run.reply {
            let _ = reply.send(json!({ "error": { "code": "client.closed", "message": "client owner has closed" } }));
        }
    }
}

/// The database file a `create` opens: `<database_dir>/<database>.db` for a
/// named database, otherwise the configured `db_path` (`None` → in-memory; a
/// configuration with only `database_dir` requires the name). A
/// database name is one file name of ASCII letters, digits, `-`, `_` and `.`,
/// starting with a letter or digit, so it cannot leave the directory. The
/// webview never supplies a path itself.
fn resolve_database(config: &SyncularConfig, params: &Value) -> Result<Option<String>, Value> {
    if params.get("dbPath").is_some() {
        return Err(invalid_request(
            "sync.invalid_request: create.dbPath is host configuration; name a database with create.database",
        ));
    }
    let Some(database) = params.get("database") else {
        if config.db_path.is_none() && config.database_dir.is_some() {
            return Err(invalid_request(
                "sync.invalid_request: create.database is required when SyncularConfig sets database_dir without db_path",
            ));
        }
        return Ok(config.db_path.clone());
    };
    let Some(name) = database.as_str().filter(|name| {
        (1..=128).contains(&name.len())
            && name.starts_with(|c: char| c.is_ascii_alphanumeric())
            && !name.contains("..")
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }) else {
        return Err(invalid_request(
            "sync.invalid_request: create.database must be 1 to 128 ASCII letters, digits, '-', '_' or '.', start with a letter or digit, and contain no '..'",
        ));
    };
    let Some(dir) = &config.database_dir else {
        return Err(invalid_request(
            "sync.invalid_request: create.database needs SyncularConfig.database_dir",
        ));
    };
    std::fs::create_dir_all(dir)
        .map_err(|error| client_error(format!("cannot create the database directory: {error}")))?;
    Ok(Some(
        std::path::Path::new(dir)
            .join(format!("{name}.db"))
            .to_string_lossy()
            .into_owned(),
    ))
}

fn invalid_request(message: &str) -> Value {
    json!({ "error": { "code": "sync.invalid_request", "message": message } })
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
    let method = command
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    // §7.6: the generic command entry delegates both owned snapshot reads to
    // the dedicated Tauri read commands, so one existing read path produces the
    // owner-failure bookkeeping the sidecar's transition mirror tracks. It runs
    // before any state borrow, because those commands take the app handle.
    // In-memory replicas keep their own owner fallback inside those commands,
    // and only the required fields below keep the router's error text; every
    // other malformed shape gets the dedicated command's validation.
    if matches!(method.as_str(), "querySnapshot" | "snapshotRead") {
        let params = command.get("params").unwrap_or(&Value::Null);
        if method == "querySnapshot" {
            let Some(sql) = params.get("sql").and_then(Value::as_str) else {
                return Ok(client_error("querySnapshot missing sql"));
            };
            return syncular_query_snapshot(
                app,
                sql.to_owned(),
                params.get("params").cloned(),
                params.get("coverage").cloned(),
                params.get("owner").cloned(),
            )
            .await;
        }
        let statements = params.get("statements").cloned().unwrap_or(Value::Null);
        if !statements.is_array() {
            return Ok(invalid_request(
                "sync.invalid_request: snapshotRead statements must be a list",
            ));
        }
        return syncular_snapshot_read(
            app,
            statements,
            params.get("coverage").cloned(),
            params.get("subscriptions").cloned(),
            params.get("commitIds").cloned(),
            params.get("owner").cloned(),
        )
        .await;
    }
    let state = app.state::<SyncularState>();
    if method == "create" || method == "beginSecurityPreflight" || method == "shutdown" {
        // Gate fast reads and wait for already-started sidecar snapshots before
        // the owner-thread barrier is enqueued.
        state.security_gate.begin_preflight()?;
    }
    // Taken after the gate drained, so no admitted read still waits for it.
    let mut reader = if method == "create" || method == "shutdown" {
        Some(
            state
                .reader
                .lock()
                .map_err(|_| "syncular read mailbox poisoned".to_owned())?,
        )
    } else {
        None
    };
    let mut command = command;
    let mut database = None;
    if method == "create" {
        if let Some(reads) = command.pointer("/params/authorityReads") {
            let declarations: Vec<syncular_client::AuthorityReadDeclaration> =
                match serde_json::from_value(reads.clone()) {
                    Ok(value) => value,
                    Err(_) => {
                        return Ok(
                            json!({"error": {"code": "client.authority_read_forbidden", "message": "invalid authority declaration"}}),
                        )
                    }
                };
            if !declarations.iter().all(|read| {
                state
                    .config
                    .authority_columns
                    .get(&read.table)
                    .is_some_and(|columns| read.columns.iter().all(|c| columns.contains(c)))
            }) {
                return Ok(
                    json!({"error": {"code": "client.authority_read_forbidden", "message": "authority declaration exceeds the native app policy"}}),
                );
            }
        }
        database =
            match resolve_database(&state.config, command.get("params").unwrap_or(&Value::Null)) {
                Ok(path) => path,
                Err(reply) => return Ok(reply),
            };
        if let Some(path) = &database {
            match command.get_mut("params").and_then(Value::as_object_mut) {
                Some(params) => {
                    params.insert("dbPath".to_owned(), Value::from(path.clone()));
                }
                None => {
                    if let Some(object) = command.as_object_mut() {
                        object.insert("params".to_owned(), json!({ "dbPath": path }));
                    }
                }
            }
        }
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
    if let (true, Some(slot)) = (succeeded, reader.as_mut()) {
        let next = match database.filter(|path| path.as_str() != ":memory:") {
            Some(path) => Some(spawn_reader(
                path,
                state
                    .sender
                    .lock()
                    .map_err(|_| "syncular mailbox poisoned".to_owned())?
                    .clone(),
            )?),
            None => None,
        };
        if let Some(previous) = std::mem::replace(&mut **slot, next) {
            let _ = previous.send(ReadRequest::Shutdown);
        }
    }
    drop(reader);
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
/// Header rotation path: a fresh JWT reaches the transport without
/// re-registering the plugin. HTTP requests use the new set from the next
/// call; the realtime socket applies it on its next (re)connect.
#[tauri::command]
async fn syncular_set_headers<R: Runtime>(
    app: tauri::AppHandle<R>,
    headers: std::collections::BTreeMap<String, String>,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    // Runtime bearer replacement is an active-session operation. Hold the
    // same gate as fast reads so beginSecurityPreflight both rejects new
    // replacements and waits for an already-started mailbox update.
    let _active_guard = match state.security_gate.enter_read() {
        Ok(guard) => guard,
        Err(reply) => return Ok(reply),
    };
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
    owner: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    let _read_guard = match state.security_gate.enter_read() {
        Ok(guard) => guard,
        Err(reply) => return Ok(reply),
    };
    let params_value = params.unwrap_or_else(|| Value::Array(Vec::new()));
    let coverage_value = coverage.unwrap_or_else(|| Value::Array(Vec::new()));

    if let Some(reader) = state.reader()? {
        let bind = match params_value.as_array() {
            Some(values) => values.clone(),
            None => return Ok(client_error("querySnapshot params must be a list")),
        };
        let parsed_coverage = match parse_coverage(Some(&coverage_value)) {
            Ok(value) => value,
            Err(message) => return Ok(client_error(message)),
        };
        // §7.5 owner: the same `{id, tables}` contract the command router parses.
        let parsed_owner = match parse_owner(owner.as_ref()) {
            Ok(value) => value,
            Err(reply) => return Ok(reply),
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        reader
            .send(ReadRequest::QuerySnapshot {
                sql,
                params: bind,
                coverage: parsed_coverage,
                owner: parsed_owner,
                reply: reply_tx,
            })
            .map_err(|_| "the syncular read thread has stopped".to_owned())?;
        return reply_rx
            .recv()
            .map_err(|_| "the syncular read thread dropped the reply".to_owned());
    }

    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Command {
        command: json!({
            "method": "querySnapshot",
            "params": {
                "sql": sql,
                "params": params_value,
                "coverage": coverage_value,
                "owner": owner.unwrap_or(Value::Null),
            }
        }),
        reply: reply_tx,
    })?;
    reply_rx
        .recv()
        .map_err(|_| "the syncular core dropped the reply".to_owned())
}

/// §7.5 owner `{id, tables}`, both required when present. Shared by the
/// `querySnapshot` and `snapshotRead` commands.
fn parse_owner(value: Option<&Value>) -> Result<Option<(String, Vec<String>)>, Value> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            let tables = value
                .get("tables")
                .and_then(Value::as_array)
                .and_then(|list| {
                    list.iter()
                        .map(|table| table.as_str().map(str::to_owned))
                        .collect::<Option<Vec<String>>>()
                });
            match (id, tables) {
                (Some(id), Some(tables)) => Ok(Some((id.to_owned(), tables))),
                _ => Err(json!({ "error": {
                    "code": "sync.invalid_request",
                    "message": "sync.invalid_request: owner must be {id: non-empty string, tables: string[]}",
                } })),
            }
        }
    }
}

fn parse_string_list(value: Option<&Value>) -> Result<Vec<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<String>>>()
            .ok_or_else(|| "expected a list of strings".to_owned()),
        Some(_) => Err("expected a list of strings".to_owned()),
    }
}

/// §7.5: one atomic read over the file-backed sidecar, or the owner command
/// for an in-memory replica (SQLite cannot share an anonymous database across
/// connections). `statements` is a list of `{sql, params?}`; `subscriptions`
/// and `commitIds` name the catch-up and delivery reads. All results share one
/// revision and one read transaction.
#[tauri::command]
async fn syncular_snapshot_read<R: Runtime>(
    app: tauri::AppHandle<R>,
    statements: Value,
    coverage: Option<Value>,
    subscriptions: Option<Value>,
    commit_ids: Option<Value>,
    owner: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<SyncularState>();
    let _read_guard = match state.security_gate.enter_read() {
        Ok(guard) => guard,
        Err(reply) => return Ok(reply),
    };
    let Some(items) = statements.as_array() else {
        return Ok(invalid_request(
            "sync.invalid_request: snapshotRead statements must be a list",
        ));
    };
    let mut parsed_statements = Vec::with_capacity(items.len());
    for item in items {
        let Some(sql) = item.get("sql").and_then(Value::as_str) else {
            return Ok(invalid_request(
                "sync.invalid_request: each snapshotRead statement needs a sql string",
            ));
        };
        // A present `params` must be a list; never fabricate an empty bind set.
        let params = match item.get("params") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(values)) => values.clone(),
            Some(_) => {
                return Ok(invalid_request(
                    "sync.invalid_request: snapshotRead statement params must be a list",
                ))
            }
        };
        parsed_statements.push((sql.to_owned(), params));
    }
    let coverage_value = coverage.clone().unwrap_or(Value::Null);
    let parsed_coverage = match parse_coverage(coverage.as_ref()) {
        Ok(value) => value,
        Err(message) => return Ok(invalid_request(&format!("sync.invalid_request: {message}"))),
    };
    let parsed_subscriptions = match parse_string_list(subscriptions.as_ref()) {
        Ok(value) => value,
        Err(message) => return Ok(invalid_request(&format!("sync.invalid_request: {message}"))),
    };
    let parsed_commit_ids = match parse_string_list(commit_ids.as_ref()) {
        Ok(value) => value,
        Err(message) => return Ok(invalid_request(&format!("sync.invalid_request: {message}"))),
    };
    let parsed_owner = match parse_owner(owner.as_ref()) {
        Ok(value) => value,
        Err(reply) => return Ok(reply),
    };

    if let Some(reader) = state.reader()? {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        reader
            .send(ReadRequest::SnapshotRead {
                statements: parsed_statements,
                coverage: parsed_coverage,
                subscriptions: parsed_subscriptions,
                commit_ids: parsed_commit_ids,
                owner: parsed_owner,
                reply: reply_tx,
            })
            .map_err(|_| "the syncular read thread has stopped".to_owned())?;
        return reply_rx
            .recv()
            .map_err(|_| "the syncular read thread dropped the reply".to_owned());
    }

    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Command {
        command: json!({
            "method": "snapshotRead",
            "params": {
                "statements": parsed_statements
                    .into_iter()
                    .map(|(sql, params)| json!({ "sql": sql, "params": params }))
                    .collect::<Vec<_>>(),
                "coverage": coverage_value,
                "subscriptions": parsed_subscriptions,
                "commitIds": parsed_commit_ids,
                "owner": parsed_owner.map_or(Value::Null, |(id, tables)| json!({
                    "id": id,
                    "tables": tables,
                })),
            }
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
            syncular_snapshot_read,
            syncular_set_headers
        ])
        .setup(move |app, _api| {
            let (tx, rx) = std::sync::mpsc::channel::<Request>();
            app.manage(SyncularState {
                sender: Mutex::new(tx.clone()),
                reader: Mutex::new(None),
                config: config.clone(),
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
                    if let Ok(Some(reader)) = state.reader() {
                        let _ = reader.send(ReadRequest::Shutdown);
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
            request_timeout_ms: Some(1000),
            round_deadline_ms: Some(2000),
            max_request_bytes: Some(1024),
            max_response_bytes: Some(2048),
            redirects: Some("deny".to_owned()),
            ..Default::default()
        };
        let json = config.to_transport_json();
        assert_eq!(json["baseUrl"], "https://api.example.com");
        assert_eq!(json["headers"]["authorization"], "Bearer x");
        assert_eq!(json["requestTimeoutMs"], 1000);
        assert_eq!(json["roundDeadlineMs"], 2000);
        assert_eq!(json["maxRequestBytes"], 1024);
        assert_eq!(json["maxResponseBytes"], 2048);
        assert_eq!(json["redirects"], "deny");
    }

    #[test]
    fn transport_policy_config_is_validated_at_the_core_boundary() {
        // A headerless core still validates the policy it is handed.
        let core = SyncularCore::new(&serde_json::json!({"requestTimeoutMs": 1000}));
        assert!(core.is_ok());
        let error = SyncularCore::new(&serde_json::json!({"requestTimeoutMs": 0}))
            .err()
            .unwrap();
        assert_eq!(
            error,
            "sync.invalid_request: transport config requestTimeoutMs must be a positive integer"
        );
        let error = SyncularCore::new(&serde_json::json!({"redirects": "sometimes"}))
            .err()
            .unwrap();
        assert_eq!(
            error,
            "sync.invalid_request: transport config redirects must be \"deny\" or \"follow\""
        );
        let mut core = SyncularCore::new(&serde_json::json!({})).unwrap();
        assert_eq!(
            core.set_transport_policy(crate::transport::HostTransportPolicy {
                max_response_bytes: Some(0),
                ..Default::default()
            })
            .unwrap_err(),
            "sync.invalid_request: transport config maxResponseBytes must be a positive integer"
        );
    }

    #[test]
    fn security_gate_blocks_new_operations_and_waits_for_in_flight_work() {
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
    fn direct_set_headers_command_respects_the_native_preflight_gate() {
        use std::collections::BTreeMap;
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build mock app");

        let blocked = tauri::async_runtime::block_on(syncular_set_headers(
            app.handle().clone(),
            BTreeMap::from([("authorization".to_owned(), "Bearer blocked".to_owned())]),
        ))
        .expect("preflight reply");
        assert_eq!(
            blocked["error"]["code"],
            Value::from("client.security_preflight_required")
        );

        let created = tauri::async_runtime::block_on(syncular_command(
            app.handle().clone(),
            json!({
                "method": "create",
                "params": {
                    "clientId": "native-header-gate",
                    "schema": { "version": 1, "tables": [] }
                }
            }),
        ))
        .expect("create reply");
        assert!(created.get("error").is_none(), "{created}");

        let active = tauri::async_runtime::block_on(syncular_set_headers(
            app.handle().clone(),
            BTreeMap::from([("authorization".to_owned(), "Bearer active".to_owned())]),
        ))
        .expect("active reply");
        assert_eq!(active["result"], Value::Null);
    }

    #[test]
    fn preflight_refuses_plain_replacement_creates_through_the_plugin() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build mock app");
        let command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(app.handle().clone(), value))
                .expect("command reply")
        };

        let created = command(json!({
            "method": "create",
            "params": {
                "clientId": "native-preflight-escape",
                "schema": { "version": 1, "tables": [] },
                "securityPreflight": true
            }
        }));
        assert!(created.get("error").is_none(), "{created}");

        // The escape attempt: a plain re-create must be refused by the shared
        // router, and the plugin's fast-read gate must stay engaged.
        let escape = command(json!({
            "method": "create",
            "params": {
                "clientId": "native-preflight-escape",
                "schema": { "version": 1, "tables": [] }
            }
        }));
        assert_eq!(
            escape["error"]["code"],
            Value::from("client.security_preflight_required"),
            "{escape}"
        );
        let read = tauri::async_runtime::block_on(syncular_query(
            app.handle().clone(),
            "SELECT 1".to_owned(),
            None,
        ))
        .expect("query reply");
        assert_eq!(
            read["error"]["code"],
            Value::from("client.security_preflight_required")
        );

        // Activation (with a fresh header set) releases both gates.
        let activated = command(json!({
            "method": "activateSecurity",
            "params": { "headers": { "authorization": "Bearer fresh" } }
        }));
        assert!(activated.get("error").is_none(), "{activated}");
        let read = tauri::async_runtime::block_on(syncular_query(
            app.handle().clone(),
            "SELECT 1 AS value".to_owned(),
            None,
        ))
        .expect("query reply");
        assert_eq!(read["result"]["rows"][0]["value"], 1);
        let recreated = command(json!({
            "method": "create",
            "params": {
                "clientId": "native-preflight-escape",
                "schema": { "version": 1, "tables": [] }
            }
        }));
        assert!(recreated.get("error").is_none(), "{recreated}");
    }

    #[test]
    fn authority_snapshot_raw_ipc_obeys_native_columns_and_never_opens_protected_reads() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let path =
            std::env::temp_dir().join(format!("syncular-authority-ipc-{}.db", std::process::id()));
        let app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                db_path: Some(path.to_string_lossy().into_owned()),
                authority_columns: [(
                    "authority".into(),
                    vec!["id".into(), "actor_id".into(), "role".into()],
                )]
                .into(),
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let handle = app.handle().clone();
        let command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(handle.clone(), value))
                .expect("IPC reply")
        };
        let schema = json!({"version": 1, "tables": [{"name": "authority", "primaryKey": "id", "scopes": [{"pattern": "actor:{actor_id}"}], "columns": [
            {"name": "id", "type": "string", "nullable": false}, {"name": "actor_id", "type": "string", "nullable": false}, {"name": "role", "type": "string", "nullable": false}, {"name": "secret", "type": "bytes", "encrypted": true, "declaredType": "string", "nullable": true}
        ]}]});
        let policy = json!([{"table": "authority", "columns": ["id", "actor_id", "role"], "scopes": {"actor_id": ["a", "b"]}}]);
        let create = |reads: Value| json!({"method": "create", "params": {"schema": schema, "securityPreflight": true, "transportEnabled": false, "authorityReads": reads}});
        let created = command(create(policy.clone()));
        assert!(created.get("error").is_none(), "{created}");
        let conn = rusqlite::Connection::open(&path).expect("fixture db");
        conn.execute_batch("INSERT INTO _syncular_base_authority(id,actor_id,role,secret,_syncular_version)VALUES('one','a','accepted','clinical plaintext',7); INSERT INTO authority SELECT * FROM _syncular_base_authority;").expect("fixture base");
        for actor in ["a", "b"] {
            let state = json!({"requested": {"actor_id": [actor]}, "effectiveScopes": {"actor_id": [actor]}, "status": "active", "cursor": 7});
            conn.execute(
                "INSERT INTO _syncular_subscriptions(id,tbl,state_json)VALUES(?1,'authority',?2)",
                rusqlite::params![actor, state.to_string()],
            )
            .expect("fixture subscription");
        }
        let snapshot = command(json!({"method": "authoritySnapshot", "params": {}}));
        assert_eq!(snapshot["result"]["complete"], true, "{snapshot}");
        assert_eq!(
            snapshot["result"]["tables"][0]["rows"][0]["values"],
            json!({"id": "one", "actor_id": "a", "role": "accepted"})
        );
        assert!(!snapshot.to_string().contains("clinical plaintext"));
        assert_eq!(
            command(json!({"method": "securityLifecycle", "params": {}}))["result"]["state"],
            "preflight"
        );
        for params in [
            json!({"sql": "SELECT secret FROM authority"}),
            json!({"columns": ["secret"]}),
            json!({"table": "_syncular_meta"}),
            json!({"scopes": {"actor_id": ["outside"]}}),
            json!({"authorityReads": policy}),
        ] {
            assert_eq!(
                command(json!({"method": "authoritySnapshot", "params": params}))["error"]["code"],
                "client.authority_read_forbidden"
            );
        }
        for columns in [
            json!(["id", "actor_id", "secret"]),
            json!([
                "id",
                "actor_id",
                "role FROM authority; DELETE FROM authority"
            ]),
        ] {
            assert_eq!(
                command(create(
                    json!([{"table": "authority", "columns": columns, "scopes": {"actor_id": ["a"]}}])
                ))["error"]["code"],
                "client.authority_read_forbidden"
            );
        }
        for method in [
            "query",
            "querySnapshot",
            "mutate",
            "setHeaders",
            "subscribe",
            "sync",
        ] {
            assert_eq!(
                command(json!({"method": method, "params": {"sql": "SELECT id FROM authority"}}))
                    ["error"]["code"],
                "client.security_preflight_required"
            );
        }
        assert_eq!(
            tauri::async_runtime::block_on(syncular_query(
                app.handle().clone(),
                "SELECT id FROM authority".into(),
                None
            ))
            .unwrap()["error"]["code"],
            "client.security_preflight_required"
        );
        assert_eq!(
            tauri::async_runtime::block_on(syncular_query_snapshot(
                app.handle().clone(),
                "SELECT id FROM authority".into(),
                None,
                None,
                None
            ))
            .unwrap()["error"]["code"],
            "client.security_preflight_required"
        );
        let before = snapshot["result"]["revision"].clone();
        assert_eq!(
            command(json!({"method": "authoritySnapshot", "params": {}}))["result"]["revision"],
            before
        );
        conn.execute("UPDATE _syncular_subscriptions SET state_json=?1 WHERE id='b'", [json!({"requested": {"actor_id": ["b"]}, "effectiveScopes": {"actor_id": ["b"]}, "status": "active", "cursor": 7, "bootstrapState": "credential-do-not-expose"}).to_string()]).unwrap();
        let partial = command(json!({"method": "authoritySnapshot", "params": {}}));
        assert_eq!(partial["result"]["complete"], false);
        assert!(!partial.to_string().contains("credential-do-not-expose"));
        conn.execute(
            "UPDATE _syncular_subscriptions SET state_json='credential-do-not-expose' WHERE id='b'",
            [],
        )
        .unwrap();
        let corrupt = command(json!({"method": "authoritySnapshot", "params": {}}));
        assert_eq!(corrupt["error"]["code"], "sync.local_corrupt");
        assert!(!corrupt.to_string().contains("credential-do-not-expose"));
        conn.execute("DELETE FROM _syncular_subscriptions WHERE id='b'", [])
            .unwrap();
        command(json!({"method": "beginSecurityPreflight", "params": {}}));
        assert!(
            command(json!({"method": "authoritySnapshot", "params": {}}))
                .get("error")
                .is_none()
        );
        // The owner's mailbox serializes a lock/read race without admitting SQL.
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let locking = scope.spawn(|| {
                barrier.wait();
                command(json!({"method": "beginSecurityPreflight", "params": {}}))
            });
            barrier.wait();
            let reading = command(json!({"method": "authoritySnapshot", "params": {}}));
            assert_eq!(reading["result"]["revision"], before);
            assert!(locking.join().unwrap().get("error").is_none());
        });
        // A racing close either follows the entire snapshot or rejects it.
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let closing = scope.spawn(|| {
                barrier.wait();
                command(json!({"method": "shutdown", "params": {}}))
            });
            barrier.wait();
            let reading = command(json!({"method": "authoritySnapshot", "params": {}}));
            assert!(
                reading["result"]["revision"] == before
                    || reading["error"]["code"] == "client.closed",
                "{reading}"
            );
            assert!(closing.join().unwrap().get("error").is_none());
        });
        assert_eq!(
            command(json!({"method": "authoritySnapshot", "params": {}}))["error"]["code"],
            "client.closed"
        );
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn resolve_database_names_a_file_inside_the_configured_directory() {
        let dir =
            std::env::temp_dir().join(format!("syncular-tauri-resolve-{}", std::process::id()));
        let config = SyncularConfig {
            db_path: Some("/tmp/default.db".to_owned()),
            database_dir: Some(dir.to_string_lossy().into_owned()),
            ..Default::default()
        };
        // No name → the configured default path.
        assert_eq!(
            resolve_database(&config, &json!({ "clientId": "c1" })),
            Ok(Some("/tmp/default.db".to_owned()))
        );
        // A name → `<database_dir>/<name>.db`, directory created.
        assert_eq!(
            resolve_database(&config, &json!({ "database": "app-actor-0f.v2" })),
            Ok(Some(
                dir.join("app-actor-0f.v2.db")
                    .to_string_lossy()
                    .into_owned()
            ))
        );
        assert!(dir.is_dir());
        // A webview-supplied path and every name that could leave the
        // directory are refused.
        for params in [
            json!({ "dbPath": "/etc/other.db" }),
            json!({ "database": "../escape" }),
            json!({ "database": "a/b" }),
            json!({ "database": "a\\b" }),
            json!({ "database": "/abs" }),
            json!({ "database": ".hidden" }),
            json!({ "database": "a..b" }),
            json!({ "database": "" }),
            json!({ "database": "x".repeat(129) }),
            json!({ "database": 7 }),
        ] {
            let refused = resolve_database(&config, &params).expect_err("refused");
            assert_eq!(refused["error"]["code"], "sync.invalid_request", "{params}");
        }
        // A configuration with only a directory never opens an unnamed
        // create in memory.
        let refused = resolve_database(
            &SyncularConfig {
                database_dir: Some(dir.to_string_lossy().into_owned()),
                ..Default::default()
            },
            &json!({ "clientId": "c1" }),
        )
        .expect_err("name required");
        assert_eq!(refused["error"]["code"], "sync.invalid_request");
        // A name without a configured directory is refused, never placed
        // somewhere else.
        let refused = resolve_database(&SyncularConfig::default(), &json!({ "database": "actor" }))
            .expect_err("no directory");
        assert_eq!(refused["error"]["code"], "sync.invalid_request");
        std::fs::remove_dir_all(dir).expect("remove temp directory");
    }

    /// One replica per actor: each `create` opens its named database, keeps
    /// its own client id, and the snapshot reader follows the open database.
    #[test]
    fn named_databases_keep_one_replica_and_client_id_per_actor() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let dir =
            std::env::temp_dir().join(format!("syncular-tauri-actors-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = mock_builder()
            .plugin(init(SyncularConfig {
                database_dir: Some(dir.to_string_lossy().into_owned()),
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build mock app");
        let command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(app.handle().clone(), value))
                .expect("command reply")
        };
        let snapshot = |sql: &str| {
            tauri::async_runtime::block_on(syncular_query_snapshot(
                app.handle().clone(),
                sql.to_owned(),
                None,
                None,
                None,
            ))
            .expect("snapshot reply")
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
        let create = |database: &str, client_id: &str| {
            command(json!({ "method": "create", "params": {
                "database": database, "clientId": client_id, "schema": schema
            } }))
        };

        assert_eq!(create("actor-a", "client-a")["result"], json!({}));
        command(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "t1", "title": "a" }
        }] } }));
        assert_eq!(
            snapshot("SELECT title FROM todo")["result"]["rows"][0]["title"],
            "a"
        );
        assert_eq!(
            command(json!({ "method": "shutdown" }))["result"],
            json!({})
        );

        assert_eq!(create("actor-b", "client-b")["result"], json!({}));
        assert_eq!(
            snapshot("SELECT title FROM todo")["result"]["rows"],
            json!([]),
            "the reader follows the second actor's database"
        );
        assert!(dir.join("actor-a.db").is_file());
        assert!(dir.join("actor-b.db").is_file());
        assert_eq!(
            command(json!({ "method": "shutdown" }))["result"],
            json!({})
        );

        // Each replica keeps the client id it was created with.
        assert_eq!(
            create("actor-a", "client-b")["error"]["code"],
            "client.identity_mismatch"
        );
        assert_eq!(create("actor-a", "client-a")["result"], json!({}));
        assert_eq!(
            snapshot("SELECT title FROM todo")["result"]["rows"][0]["title"],
            "a"
        );
        assert_eq!(
            create("../actor-a", "client-a")["error"]["code"],
            "sync.invalid_request"
        );
        command(json!({ "method": "shutdown" }));
        std::fs::remove_dir_all(dir).expect("remove temp directory");
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

        // Header rotation rides the same mailbox; a
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

    #[cfg(feature = "native-transport")]
    #[test]
    fn pending_network_round_keeps_local_mutations_and_queries_responsive() {
        use ssp2::model::{Change, Frame, Message, MsgKind, Op, OpResult, PushStatus, SubStatus};
        use ssp2::segment::{encode_row, Column, ColumnType, ColumnValue};
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        let (delivered_tx, delivered_rx) = channel();
        let (ack_tx, ack_rx) = channel();
        let image_sent = Arc::new(AtomicBool::new(false));
        let server_image_sent = image_sent.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let server_requests = requests.clone();
        let server = std::thread::spawn(move || {
            let mut pushed = Vec::new();
            loop {
                let (mut socket, _) = listener.accept().unwrap();
                server_requests.fetch_add(1, Ordering::SeqCst);
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                assert!(header
                    .to_ascii_lowercase()
                    .contains("authorization: bearer fresh"));
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut bytes = vec![0; length];
                socket.read_exact(&mut bytes).unwrap();
                let request = ssp2::decode_message(&bytes).unwrap();
                let reset = matches!(
                    &request.frames[0],
                    Frame::ReqHeader {
                        log_epoch: None,
                        ..
                    }
                );
                let deliver = !reset && pushed.len() == 3;
                let mut frames = vec![Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch".into()),
                    reset_required: Some(reset),
                }];
                if !reset {
                    let commits: Vec<_> = request
                        .frames
                        .iter()
                        .filter_map(|frame| {
                            if let Frame::PushCommit {
                                client_commit_id,
                                operations,
                            } = frame
                            {
                                Some((client_commit_id.clone(), operations.len()))
                            } else {
                                None
                            }
                        })
                        .collect();
                    if !commits.is_empty() && pushed.is_empty() {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                    }
                    for (id, count) in commits {
                        pushed.push(id.clone());
                        frames.push(Frame::PushResult {
                            client_commit_id: id,
                            status: PushStatus::Applied,
                            commit_seq: Some(pushed.len() as i64),
                            results: (0..count)
                                .map(|i| OpResult::Applied { op_index: i as i32 })
                                .collect(),
                        });
                    }
                }
                if !reset
                    && request
                        .frames
                        .iter()
                        .any(|frame| matches!(frame, Frame::Subscription { id, .. } if id == "own"))
                {
                    frames.push(Frame::SubStart {
                        id: "own".into(),
                        status: SubStatus::Active,
                        reason_code: String::new(),
                        effective_scopes: vec![("id".into(), vec!["one".into()])],
                        bootstrap: false,
                    });
                    if deliver {
                        assert!(request
                            .frames
                            .iter()
                            .any(|frame| matches!(frame, Frame::PullHeader { .. })));
                        assert!(!request
                            .frames
                            .iter()
                            .any(|frame| matches!(frame, Frame::PushCommit { .. })));
                        let columns = ["id", "title"].map(|name| Column {
                            name: name.into(),
                            ty: ColumnType::String,
                            nullable: false,
                        });
                        let mut row = ssp2::primitives::Writer::new();
                        encode_row(
                            &mut row,
                            &columns,
                            &vec![
                                Some(ColumnValue::String("one".into())),
                                Some(ColumnValue::String("300/v3".into())),
                            ],
                        );
                        frames.push(Frame::Commit {
                            commit_seq: 3,
                            created_at_ms: 0,
                            actor_id: "actor".into(),
                            tables: vec!["todo".into()],
                            changes: vec![Change {
                                table_index: 0,
                                row_id: "one".into(),
                                op: Op::Upsert,
                                row_version: Some(3),
                                scopes: vec![("id".into(), "one".into())],
                                row: Some(row.into_bytes()),
                            }],
                        });
                        server_image_sent.store(true, Ordering::SeqCst);
                    }
                    frames.push(Frame::SubEnd {
                        next_cursor: if deliver { 3 } else { 0 },
                        bootstrap_state: None,
                    });
                }
                let response = ssp2::encode_message(&Message {
                    wire_version: ssp2::decode::WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames,
                });
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                socket.write_all(&response).unwrap();
                if deliver {
                    break;
                }
            }
            pushed
        });
        let (tx, rx) = channel();
        let owner_tx = tx.clone();
        let owner = std::thread::spawn(move || {
            run_owner_thread(
                SyncularConfig {
                    base_url: Some(format!("http://{address}")),
                    auto_sync: true,
                    ..Default::default()
                },
                owner_tx,
                rx,
                move |event| {
                    if event["type"] == "change" && event["batch"]["outcomesChanged"] == true {
                        let _ = ack_tx.send(());
                    }
                    if image_sent.load(Ordering::SeqCst) && event["type"] == "change" {
                        let _ = delivered_tx.send(());
                    }
                },
            )
        });
        let call = |command: Value| {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result
        };
        let created = call(json!({ "method": "create", "params": {
            "clientId": "pending-round", "transportEnabled": false, "securityPreflight": true, "schema": { "version": 1, "tables": [{
                "name": "todo", "primaryKey": "id", "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ], "scopes": [{ "pattern": "todo:{id}" }]
            }] }
        } }));
        assert!(created.recv().unwrap().get("error").is_none());
        assert!(call(json!({ "method": "activateSecurity", "params": {} }))
            .recv()
            .unwrap()
            .get("error")
            .is_none());
        assert!(call(json!({ "method": "subscribe", "params": { "id": "own", "table": "todo", "scopes": { "id": ["one"] } } })).recv().unwrap().get("error").is_none());
        let first = call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "one", "title": "100/v1" }
        }] } }))
        .recv()
        .unwrap();
        let queued_second = call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "patch", "table": "todo", "values": { "id": "one", "title": "200/v2" }
        }] } }))
        .recv()
        .unwrap();
        assert_eq!(
            call(json!({ "method": "sync" })).recv().unwrap()["result"]["errorCode"],
            "sync.offline"
        );
        assert_eq!(
            call(json!({ "method": "connectRealtime" })).recv().unwrap()["error"]["code"],
            "sync.offline"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        let (reply, result) = channel();
        tx.send(Request::SetHeaders {
            headers: vec![("authorization".into(), "Bearer fresh".into())],
            reply,
        })
        .unwrap();
        assert_eq!(result.recv().unwrap()["result"], Value::Null);
        assert!(
            call(json!({ "method": "setTransportEnabled", "params": { "enabled": true } }))
                .recv()
                .unwrap()
                .get("error")
                .is_none()
        );
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            call(json!({ "method": "setTransportEnabled", "params": { "enabled": false } }))
                .recv()
                .unwrap()
                .get("error")
                .is_none()
        );
        let started = Instant::now();
        let second = call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "patch", "table": "todo", "values": { "id": "one", "title": "300/v3" }
        }] } }));
        let local_reply = second.recv_timeout(Duration::from_millis(100));
        let elapsed = started.elapsed();
        let (query_tx, query_rx) = channel();
        tx.send(Request::Query {
            sql: "SELECT title FROM todo ORDER BY id".into(),
            params: Value::Null,
            reply: query_tx,
        })
        .unwrap();
        let local_rows = query_rx.recv_timeout(Duration::from_millis(100));
        // Release even on the old blocking implementation, so a failing test
        // joins its transport and owner rather than leaving network threads.
        release_tx.send(()).unwrap();
        let second_reply = local_reply
            .clone()
            .unwrap_or_else(|_| second.recv().unwrap());
        let rows = local_rows
            .clone()
            .unwrap_or_else(|_| query_rx.recv().unwrap());
        // Local mutation emits an outcome batch too; wait for both captured commits' applied outcomes.
        loop {
            ack_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let outcomes = call(json!({ "method": "commitOutcomes" })).recv().unwrap();
            if outcomes["result"]["outcomes"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|o| o["status"] == "applied")
                .count()
                == 2
            {
                break;
            }
        }
        let paused_count = requests.load(Ordering::SeqCst);
        assert_eq!(
            call(json!({ "method": "sync" })).recv().unwrap()["result"]["errorCode"],
            "sync.offline"
        );
        assert_eq!(requests.load(Ordering::SeqCst), paused_count);
        assert!(
            call(json!({ "method": "setTransportEnabled", "params": { "enabled": true } }))
                .recv()
                .unwrap()
                .get("error")
                .is_none()
        );
        delivered_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("ACK schedules the own-image pull without realtime or a manual round");
        let (query_tx, query_rx) = channel();
        tx.send(Request::Query {
            sql: "SELECT title,_sync_version AS version FROM todo WHERE id='one'".into(),
            params: Value::Null,
            reply: query_tx,
        })
        .unwrap();
        let delivered = query_rx.recv().unwrap();
        assert_eq!(delivered["result"]["rows"][0]["title"], "300/v3");
        assert_eq!(delivered["result"]["rows"][0]["version"], 3);
        let pushed = server.join().unwrap();
        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
        assert!(
            local_reply.is_ok(),
            "local mutation waited for network reply"
        );
        assert!(local_rows.is_ok(), "local query waited for network reply");
        eprintln!("second local mutation while network pending: {elapsed:?}");
        assert_eq!(rows["result"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(
            pushed,
            vec![
                first["result"]["clientCommitId"].as_str().unwrap(),
                queued_second["result"]["clientCommitId"].as_str().unwrap(),
                second_reply["result"]["clientCommitId"].as_str().unwrap()
            ]
        );
    }

    #[cfg(feature = "native-transport")]
    #[test]
    fn owner_thread_sync_until_idle_reports_budget_exhaustion_with_the_report() {
        use ssp2::model::{Change, Frame, Message, MsgKind, Op, SubStatus};
        use ssp2::segment::{encode_row, Column, ColumnType, ColumnValue};
        use std::io::{ErrorKind, Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let server_requests = Arc::clone(&requests);
        let server_stop = Arc::clone(&stop);
        let server = std::thread::spawn(move || {
            let columns = ["id", "title"].map(|name| Column {
                name: name.into(),
                ty: ColumnType::String,
                nullable: false,
            });
            while !server_stop.load(Ordering::SeqCst) {
                let (mut socket, _) = match listener.accept() {
                    Ok(accepted) => accepted,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        std::thread::yield_now();
                        continue;
                    }
                    Err(error) => panic!("accept: {error}"),
                };
                socket.set_nonblocking(false).unwrap();
                let round = server_requests.fetch_add(1, Ordering::SeqCst) + 1;
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut bytes = vec![0; length];
                socket.read_exact(&mut bytes).unwrap();
                let request = ssp2::decode_message(&bytes).unwrap();
                let reset = matches!(
                    &request.frames[0],
                    Frame::ReqHeader {
                        log_epoch: None,
                        ..
                    }
                );
                let mut frames = vec![Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: Some("epoch".into()),
                    reset_required: Some(reset),
                }];
                if !reset
                    && request
                        .frames
                        .iter()
                        .any(|frame| matches!(frame, Frame::Subscription { id, .. } if id == "own"))
                {
                    frames.push(Frame::SubStart {
                        id: "own".into(),
                        status: SubStatus::Active,
                        reason_code: String::new(),
                        effective_scopes: vec![("id".into(), vec!["one".into()])],
                        bootstrap: false,
                    });
                    let mut row = ssp2::primitives::Writer::new();
                    encode_row(
                        &mut row,
                        &columns,
                        &vec![
                            Some(ColumnValue::String("one".into())),
                            Some(ColumnValue::String(format!("v{round}"))),
                        ],
                    );
                    frames.push(Frame::Commit {
                        commit_seq: round as i64,
                        created_at_ms: 0,
                        actor_id: "actor".into(),
                        tables: vec!["todo".into()],
                        changes: vec![Change {
                            table_index: 0,
                            row_id: "one".into(),
                            op: Op::Upsert,
                            row_version: Some(round as i64),
                            scopes: vec![("id".into(), "one".into())],
                            row: Some(row.into_bytes()),
                        }],
                    });
                    frames.push(Frame::SubEnd {
                        next_cursor: round as i64,
                        bootstrap_state: None,
                    });
                }
                let response = ssp2::encode_message(&Message {
                    wire_version: ssp2::decode::WIRE_VERSION,
                    msg_kind: MsgKind::Response,
                    frames,
                });
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                socket.write_all(&response).unwrap();
            }
        });

        let (tx, rx) = channel::<Request>();
        let owner_tx = tx.clone();
        let owner = std::thread::spawn(move || {
            run_owner_thread(
                SyncularConfig {
                    base_url: Some(format!("http://{address}")),
                    auto_sync: false,
                    ..Default::default()
                },
                owner_tx,
                rx,
                |_| {},
            )
        });
        let call = |command: Value| -> Value {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result.recv().unwrap()
        };

        let created = call(json!({ "method": "create", "params": {
            "clientId": "budget-tauri", "transportEnabled": true, "schema": { "version": 1, "tables": [{
                "name": "todo", "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "todo:{id}" }]
            }] }
        } }));
        assert!(created.get("error").is_none(), "{created}");
        assert!(
            call(json!({ "method": "subscribe", "params": { "id": "own", "table": "todo", "scopes": { "id": ["one"] } } }))
                .get("error")
                .is_none()
        );

        // An invalid budget is refused before any network round.
        let before = requests.load(Ordering::SeqCst);
        let invalid = call(json!({ "method": "syncUntilIdle", "params": { "maxRounds": 0 } }));
        assert_eq!(
            invalid["error"]["code"], "sync.invalid_request",
            "{invalid}"
        );
        assert_eq!(
            requests.load(Ordering::SeqCst),
            before,
            "an invalid budget performs no round"
        );

        // `sync` ignores an irrelevant maxRounds (0 would be invalid for the
        // capped command) and performs one round.
        let single = call(json!({ "method": "sync", "params": { "maxRounds": 0 } }));
        assert!(single["result"].get("errorCode").is_none(), "{single}");

        let before_capped = requests.load(Ordering::SeqCst);
        let exhausted = call(json!({ "method": "syncUntilIdle", "params": { "maxRounds": 2 } }));
        assert!(
            exhausted["result"].get("errorCode").is_none(),
            "{exhausted}"
        );
        assert_eq!(exhausted["result"]["ok"], json!(true), "{exhausted}");
        assert_eq!(
            exhausted["result"]["budgetExhausted"],
            json!(true),
            "{exhausted}"
        );
        assert_eq!(
            requests.load(Ordering::SeqCst) - before_capped,
            2,
            "the capped run made exactly two rounds: {exhausted}"
        );
        assert_eq!(
            exhausted["result"]["report"]["commitsApplied"],
            json!(2),
            "the aggregate retains every round's work: {exhausted}"
        );

        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
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
        let owner_tx = tx.clone();
        let reader = std::thread::spawn(move || run_reader_thread(read_path, read_rx, owner_tx));

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
                owner: None,
                reply: snapshot_tx,
            })
            .expect("post snapshot");
        let snapshot = snapshot_rx
            .recv_timeout(Duration::from_millis(50))
            .expect("local snapshot must not wait for the owner");
        assert_eq!(snapshot["result"]["rows"][0]["value"], 1);

        let (failed_tx, failed_rx) = channel();
        read_tx
            .send(ReadRequest::QuerySnapshot {
                sql: "SELECT private_value FROM missing_private_table".to_owned(),
                params: Vec::new(),
                coverage: Vec::new(),
                owner: Some(("queries:missing".to_owned(), vec!["tasks".to_owned()])),
                reply: failed_tx,
            })
            .expect("post failed snapshot");
        assert_eq!(
            failed_rx.recv().expect("failed snapshot reply")["error"]["code"],
            "client.failed"
        );
        let (diagnostics_tx, diagnostics_rx) = channel();
        tx.send(Request::Command {
            command: json!({ "method": "diagnosticsSnapshot", "params": {} }),
            reply: diagnostics_tx,
        })
        .expect("post diagnostics");
        assert_eq!(
            diagnostics_rx.recv().expect("diagnostics reply")["result"]["queryFailures"][0]["id"],
            "queries:missing"
        );

        let (recovered_tx, recovered_rx) = channel();
        read_tx
            .send(ReadRequest::QuerySnapshot {
                sql: "SELECT 1 AS value".to_owned(),
                params: Vec::new(),
                coverage: Vec::new(),
                owner: Some(("queries:missing".to_owned(), vec!["tasks".to_owned()])),
                reply: recovered_tx,
            })
            .expect("post recovered snapshot");
        assert!(recovered_rx.recv().expect("recovered snapshot reply")["result"].is_object());
        let (cleared_tx, cleared_rx) = channel();
        tx.send(Request::Command {
            command: json!({ "method": "diagnosticsSnapshot", "params": {} }),
            reply: cleared_tx,
        })
        .expect("post cleared diagnostics");
        assert_eq!(
            cleared_rx.recv().expect("cleared diagnostics reply")["result"]["queryFailures"],
            json!([])
        );

        // More distinct failed owners than the diagnostic cap cannot leave
        // extra process-lifetime bookkeeping in the sidecar.
        for index in 0..300 {
            let (reply, result) = channel();
            read_tx
                .send(ReadRequest::QuerySnapshot {
                    sql: "SELECT value FROM absent_owner_table".to_owned(),
                    params: Vec::new(),
                    coverage: Vec::new(),
                    owner: Some((format!("owner-{index}"), vec!["tasks".to_owned()])),
                    reply,
                })
                .expect("post owner failure");
            assert!(result.recv().expect("failure reply")["error"].is_object());
        }
        let (reply, result) = channel();
        tx.send(Request::Command {
            command: json!({ "method": "diagnosticsSnapshot", "params": {} }),
            reply,
        })
        .expect("post bounded diagnostics");
        let value = result.recv().expect("bounded diagnostics");
        let failures = value["result"]["queryFailures"].as_array().unwrap();
        assert_eq!(failures.len(), 256);
        assert_eq!(failures.last().unwrap()["id"], "owner-299");

        read_tx.send(ReadRequest::Shutdown).expect("stop reader");
        reader.join().expect("join reader");
        tx.send(Request::Shutdown).expect("stop owner");
        owner.join().expect("join owner");
        std::fs::remove_file(path).expect("remove temp database");
    }
    #[test]
    fn read_failure_json_preserves_retryability_and_storage_details() {
        let busy = QueryReadFailure {
            code: Some("client.storage_busy"),
            sqlite_code: Some(5),
            sqlite_message: Some("database is locked".to_owned()),
            rollback_failure: Some(Box::new(QueryReadFailure {
                code: Some("client.storage_busy"),
                sqlite_code: Some(6),
                sqlite_message: Some("rollback could not lock".to_owned()),
                rollback_failure: None,
                message: "local SQLite storage is busy".to_owned(),
            })),
            message: "local SQLite storage is busy".to_owned(),
        };
        let value = read_failure_json(busy);
        assert_eq!(value["error"]["code"], "client.storage_busy");
        assert_eq!(value["error"]["retryable"], true);
        assert_eq!(value["error"]["details"]["sqliteCode"], 5);
        assert_eq!(
            value["error"]["details"]["sqliteMessage"],
            "database is locked"
        );
        assert_eq!(
            value["error"]["details"]["rollbackFailure"]["sqliteCode"],
            6
        );
        let corrupt = read_failure_json(QueryReadFailure {
            code: Some("sync.local_corrupt"),
            sqlite_code: None,
            sqlite_message: None,
            rollback_failure: None,
            message: "persisted local revision is invalid".to_owned(),
        });
        assert_eq!(corrupt["error"]["code"], "sync.local_corrupt");
        assert_eq!(corrupt["error"]["retryable"], false);
        assert!(corrupt["error"]["details"].is_null());
    }

    #[test]
    fn snapshot_read_command_is_strict_and_dispatches_by_storage_mode() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let path =
            std::env::temp_dir().join(format!("syncular-tauri-snapshot-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let file_app = mock_builder()
            .plugin(init(SyncularConfig {
                db_path: Some(path.to_string_lossy().into_owned()),
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build file app");
        let command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(file_app.handle().clone(), value))
                .expect("command reply")
        };
        let read = |statements: Value, owner: Option<Value>| {
            tauri::async_runtime::block_on(syncular_snapshot_read(
                file_app.handle().clone(),
                statements,
                None,
                None,
                None,
                owner,
            ))
            .expect("read reply")
        };
        let schema = json!({
            "version": 1,
            "tables": [{
                "name": "todo", "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "n", "type": "integer", "nullable": true }
                ],
                "scopes": []
            }]
        });
        assert_eq!(
            command(json!({ "method": "create", "params": {
                "clientId": "c1", "schema": schema.clone()
            } }))["result"],
            json!({})
        );
        // §2.4: authored row integers are bounded to the JavaScript safe range
        // (±(2^53−1)); the boundary value must queue a commit.
        let mutation = command(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo",
            "values": { "id": "r1", "n": 9_007_199_254_740_991u64 }
        }] } }));
        assert!(
            mutation["result"]["clientCommitId"].as_str().is_some(),
            "safe authoring must queue a commit: {mutation}"
        );

        // File-backed: one sidecar read returns the revision and every row.
        // The literal keeps the driver's full-width i64 `$bigint` envelope
        // covered through the same multi-statement read, because the
        // synchronized-row contract cannot carry that value through authoring.
        let ok = read(
            json!([
                { "sql": "SELECT id, n FROM todo" },
                { "sql": "SELECT CAST('9007199254740993' AS INTEGER) AS n FROM todo" }
            ]),
            None,
        );
        assert!(
            ok["result"]["revision"].as_str().is_some(),
            "expected a decimal revision: {ok}"
        );
        assert_eq!(ok["result"]["queries"][0][0]["id"], "r1");
        assert_eq!(
            ok["result"]["queries"][0][0]["n"],
            json!(9_007_199_254_740_991u64)
        );
        assert_eq!(
            ok["result"]["queries"][1][0]["n"]["$bigint"],
            "9007199254740993"
        );

        // A malformed statement `params` and a non-array `statements` are
        // stable invalid requests, never silently defaulted.
        let malformed = read(json!([{ "sql": "SELECT ?", "params": "oops" }]), None);
        assert_eq!(
            malformed["error"]["code"], "sync.invalid_request",
            "{malformed}"
        );
        let nonarray = read(json!("oops"), None);
        assert_eq!(
            nonarray["error"]["code"], "sync.invalid_request",
            "{nonarray}"
        );

        // §7.6: an owned sidecar failure reaches diagnostics.
        let failed = read(
            json!([{ "sql": "SELECT * FROM does_not_exist" }]),
            Some(json!({ "id": "queries:snapshot", "tables": ["todo"] })),
        );
        assert!(failed["error"].is_object(), "{failed}");
        let diagnostics = command(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(
            diagnostics["result"]["queryFailures"][0]["id"], "queries:snapshot",
            "{diagnostics}"
        );
        // An owned success on the file route clears the recorded failure.
        let recovered = read(
            json!([{ "sql": "SELECT 1 AS n" }]),
            Some(json!({ "id": "queries:snapshot", "tables": ["todo"] })),
        );
        assert!(recovered["result"].is_object(), "{recovered}");
        let cleared = command(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(
            cleared["result"]["queryFailures"],
            json!([]),
            "a successful owned file read clears the failure: {cleared}"
        );

        command(json!({ "method": "shutdown" }));

        // In-memory: the same command falls back to the owner connection.
        let memory_app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build memory app");
        let memory_command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(memory_app.handle().clone(), value))
                .expect("command reply")
        };
        let memory_read = |statements: Value| {
            tauri::async_runtime::block_on(syncular_snapshot_read(
                memory_app.handle().clone(),
                statements,
                None,
                None,
                None,
                None,
            ))
            .expect("read reply")
        };
        assert_eq!(
            memory_command(json!({ "method": "create", "params": {
                "clientId": "c2", "schema": schema
            } }))["result"],
            json!({})
        );
        let memory_ok = memory_read(json!([{ "sql": "SELECT 7 AS n" }]));
        assert_eq!(memory_ok["result"]["queries"][0][0]["n"], 7, "{memory_ok}");

        // The in-memory route uses the owner connection with the same owner
        // contract: failure is recorded and a later success clears it.
        let memory_failed = tauri::async_runtime::block_on(syncular_snapshot_read(
            memory_app.handle().clone(),
            json!([{ "sql": "SELECT * FROM does_not_exist" }]),
            None,
            None,
            None,
            Some(json!({ "id": "queries:memory", "tables": ["todo"] })),
        ))
        .expect("read reply");
        assert!(memory_failed["error"].is_object(), "{memory_failed}");
        let memory_diagnostics =
            memory_command(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(
            memory_diagnostics["result"]["queryFailures"][0]["id"], "queries:memory",
            "{memory_diagnostics}"
        );
        let memory_recovered = tauri::async_runtime::block_on(syncular_snapshot_read(
            memory_app.handle().clone(),
            json!([{ "sql": "SELECT 1 AS n" }]),
            None,
            None,
            None,
            Some(json!({ "id": "queries:memory", "tables": ["todo"] })),
        ))
        .expect("read reply");
        assert!(memory_recovered["result"].is_object(), "{memory_recovered}");
        let memory_cleared =
            memory_command(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(
            memory_cleared["result"]["queryFailures"],
            json!([]),
            "a successful owned in-memory read clears the failure: {memory_cleared}"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_backed_owned_read_serves_the_same_reply_on_both_public_routes() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let path = std::env::temp_dir().join(format!(
            "syncular-tauri-read-routes-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let app = mock_builder()
            .plugin(init(SyncularConfig {
                db_path: Some(path.to_string_lossy().into_owned()),
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build file app");
        let command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(app.handle().clone(), value))
                .expect("command reply")
        };
        let dedicated_snapshot = |sql: &str, owner: Option<Value>| {
            tauri::async_runtime::block_on(syncular_query_snapshot(
                app.handle().clone(),
                sql.to_owned(),
                None,
                None,
                owner,
            ))
            .expect("dedicated snapshot reply")
        };
        let dedicated_read = |statements: Value, owner: Option<Value>| {
            tauri::async_runtime::block_on(syncular_snapshot_read(
                app.handle().clone(),
                statements,
                None,
                None,
                None,
                owner,
            ))
            .expect("dedicated read reply")
        };
        let ids = || -> Vec<String> {
            command(json!({ "method": "diagnosticsSnapshot", "params": {} }))["result"]
                ["queryFailures"]
                .as_array()
                .expect("query failures array")
                .iter()
                .map(|failure| failure["id"].as_str().expect("failure id").to_owned())
                .collect()
        };
        assert_eq!(
            command(json!({ "method": "create", "params": {
                "clientId": "read-routes",
                "schema": { "version": 1, "tables": [] },
            } }))["result"],
            json!({})
        );
        let owner = json!({ "id": "queries:routes", "tables": ["tasks"] });

        // A successful owned read has one reply shape on both public routes,
        // because the generic entry is normalized onto the file sidecar.
        assert_eq!(
            command(json!({ "method": "querySnapshot", "params": {
                "sql": "SELECT 1 AS value",
                "owner": owner,
            } })),
            dedicated_snapshot("SELECT 1 AS value", Some(owner.clone())),
            "querySnapshot serves one reply on both routes"
        );
        assert_eq!(
            command(json!({ "method": "snapshotRead", "params": {
                "statements": [{ "sql": "SELECT 1 AS value" }],
                "owner": owner,
            } })),
            dedicated_read(json!([{ "sql": "SELECT 1 AS value" }]), Some(owner.clone()),),
            "snapshotRead serves one reply on both routes"
        );
        assert_eq!(ids(), Vec::<String>::new(), "clean reads record nothing");

        // A failure on either route is cleared by a success on the other.
        assert!(command(json!({ "method": "querySnapshot", "params": {
            "sql": "SELECT value FROM absent_owner_table",
            "owner": owner,
        } }))["error"]
            .is_object());
        assert_eq!(ids(), ["queries:routes"]);
        assert!(
            dedicated_read(json!([{ "sql": "SELECT 1 AS value" }]), Some(owner.clone()),)["result"]
                .is_object()
        );
        assert_eq!(
            ids(),
            Vec::<String>::new(),
            "the dedicated route cleared the generic route's failure"
        );
        assert!(
            dedicated_snapshot("SELECT value FROM absent_owner_table", Some(owner.clone()))
                ["error"]
                .is_object()
        );
        assert_eq!(ids(), ["queries:routes"]);
        assert!(command(json!({ "method": "snapshotRead", "params": {
            "statements": [{ "sql": "SELECT 1 AS value" }],
            "owner": owner,
        } }))["result"]
            .is_object());
        assert_eq!(
            ids(),
            Vec::<String>::new(),
            "the generic route cleared the dedicated route's failure"
        );

        // Required fields and malformed shapes keep the errors they had before
        // the delegation, so nothing about invalid requests changes.
        let missing_sql = command(json!({ "method": "querySnapshot", "params": {} }));
        assert_eq!(missing_sql["error"]["code"], "client.failed");
        assert_eq!(missing_sql["error"]["message"], "querySnapshot missing sql");
        let malformed = command(json!({ "method": "querySnapshot", "params": {
            "sql": "SELECT 1",
            "params": "oops",
            "owner": owner,
        } }));
        assert_eq!(malformed["error"]["code"], "client.failed");
        assert_eq!(
            malformed["error"]["message"],
            "querySnapshot params must be a list"
        );
        let malformed = command(json!({ "method": "snapshotRead", "params": {
            "statements": "oops",
            "owner": owner,
        } }));
        assert_eq!(malformed["error"]["code"], "sync.invalid_request");
        assert_eq!(
            malformed["error"]["message"],
            "sync.invalid_request: snapshotRead statements must be a list"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_delayed_owner_receives_only_reader_failure_transitions() {
        use std::sync::mpsc::channel;

        let path = std::env::temp_dir().join(format!(
            "syncular-tauri-read-transitions-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        // A real replica: the sidecar's snapshot read needs the bookkeeping
        // tables the client creates on open, and the absent table drives the
        // owned failures.
        drop(
            syncular_client::SyncClient::open_path(
                "read-transitions".to_owned(),
                &json!({ "version": 1, "tables": [] }),
                syncular_client::ClientLimits::default(),
                &path.to_string_lossy(),
            )
            .expect("create replica"),
        );

        let (owner_tx, owner_rx) = channel::<Request>();
        let (read_tx, read_rx) = channel::<ReadRequest>();
        let read_path = path.to_string_lossy().into_owned();
        // The owning thread is deliberately absent: it neither records nor
        // publishes anything, so the reader has to decide every transition on
        // its own and must never wait for the owner to drain an earlier message.
        let reader = std::thread::spawn(move || run_reader_thread(read_path, read_rx, owner_tx));

        let clean = "SELECT 1 AS value";
        let failing = "SELECT value FROM absent_owner_table";
        let owner = |id: &str, tables: &[&str]| {
            Some((
                id.to_owned(),
                tables.iter().map(|table| (*table).to_owned()).collect(),
            ))
        };
        let query_snapshot = |sql: &str, owner: Option<(String, Vec<String>)>| {
            let (reply, result) = channel();
            read_tx
                .send(ReadRequest::QuerySnapshot {
                    sql: sql.to_owned(),
                    params: Vec::new(),
                    coverage: Vec::new(),
                    owner,
                    reply,
                })
                .expect("post snapshot read");
            result.recv().expect("snapshot reply")
        };
        let snapshot_read = |sql: &str, owner: Option<(String, Vec<String>)>| {
            let (reply, result) = channel();
            read_tx
                .send(ReadRequest::SnapshotRead {
                    statements: vec![(sql.to_owned(), Vec::<syncular_client::QueryValue>::new())],
                    coverage: Vec::new(),
                    subscriptions: Vec::new(),
                    commit_ids: Vec::new(),
                    owner,
                    reply,
                })
                .expect("post multi-statement read");
            result.recv().expect("multi-statement read reply")
        };
        /// Drain the queued owner messages without processing them: the count
        /// and each outcome are the assertion.
        fn drain(owner_rx: &Receiver<Request>) -> Vec<Option<QueryReadFailure>> {
            let mut messages = Vec::new();
            while let Ok(Request::QueryRead { failure, .. }) = owner_rx.try_recv() {
                messages.push(failure);
            }
            messages
        }

        // Failure, then success, then many successes, with the owner never
        // draining: exactly the failure and the one clearing success are sent.
        assert!(
            query_snapshot(failing, owner("queries:transition", &["tasks"]))["error"].is_object()
        );
        assert!(
            query_snapshot(clean, owner("queries:transition", &["tasks"]))["result"].is_object()
        );
        for round in 0..8 {
            assert!(
                query_snapshot(clean, owner("queries:transition", &["tasks"]))["result"]
                    .is_object(),
                "{round}"
            );
        }
        let transitions = drain(&owner_rx);
        assert_eq!(
            transitions.len(),
            2,
            "a delayed owner sees the failure and one clear, not one message per read"
        );
        assert!(transitions[0].is_some(), "the failure is reported");
        assert!(transitions[1].is_none(), "the clearing success is reported");

        // The same transitions hold on the SnapshotRead route.
        assert!(
            snapshot_read(failing, owner("queries:transition", &["tasks"]))["error"].is_object()
        );
        assert!(
            snapshot_read(clean, owner("queries:transition", &["tasks"]))["result"].is_object()
        );
        for round in 0..8 {
            assert!(
                snapshot_read(clean, owner("queries:transition", &["tasks"]))["result"].is_object(),
                "{round}"
            );
        }
        let transitions = drain(&owner_rx);
        assert_eq!(transitions.len(), 2);
        assert!(transitions[0].is_some());
        assert!(transitions[1].is_none());

        // A recovered owner reports nothing further while it stays clean.
        for round in 0..16 {
            assert!(
                query_snapshot(clean, owner("queries:transition", &["tasks"]))["result"]
                    .is_object(),
                "{round}"
            );
            assert!(
                snapshot_read(clean, owner("queries:transition", &["tasks"]))["result"].is_object(),
                "{round}"
            );
        }
        assert!(
            drain(&owner_rx).is_empty(),
            "a clean success loop enqueues nothing"
        );

        // A changed failure signature still clears on the next success.
        assert!(
            query_snapshot(failing, owner("queries:signature", &["tasks"]))["error"].is_object()
        );
        assert!(
            query_snapshot(failing, owner("queries:signature", &["docs"]))["error"].is_object()
        );
        assert!(!drain(&owner_rx).is_empty(), "both failures are reported");
        assert!(query_snapshot(clean, owner("queries:signature", &["docs"]))["result"].is_object());
        let transitions = drain(&owner_rx);
        assert_eq!(transitions.len(), 1);
        assert!(
            transitions[0].is_none(),
            "a changed signature keeps the recovery report"
        );
        assert!(query_snapshot(clean, owner("queries:signature", &["docs"]))["result"].is_object());
        assert!(drain(&owner_rx).is_empty());

        // A fresh failure re-arms the transition even for the same owner.
        assert!(
            query_snapshot(failing, owner("queries:signature", &["docs"]))["error"].is_object()
        );
        assert!(query_snapshot(clean, owner("queries:signature", &["docs"]))["result"].is_object());
        let transitions = drain(&owner_rx);
        assert_eq!(transitions.len(), 2);
        assert!(transitions[0].is_some());
        assert!(transitions[1].is_none());

        // Keep the same bounded retention order as the owner, even while its
        // mailbox is paused. An unchanged repeat must not rescue the oldest id.
        for index in 0..MAX_DIAGNOSTIC_QUERY_FAILURES {
            assert!(
                query_snapshot(failing, owner(&format!("bounded-{index}"), &["tasks"]))["error"]
                    .is_object()
            );
        }
        assert!(query_snapshot(failing, owner("bounded-0", &["tasks"]))["error"].is_object());
        assert!(query_snapshot(failing, owner("bounded-1", &["changed"]))["error"].is_object());
        assert!(query_snapshot(failing, owner("bounded-new", &["tasks"]))["error"].is_object());
        assert_eq!(drain(&owner_rx).len(), MAX_DIAGNOSTIC_QUERY_FAILURES + 3);
        assert!(query_snapshot(clean, owner("bounded-0", &["tasks"]))["result"].is_object());
        assert!(
            drain(&owner_rx).is_empty(),
            "the evicted oldest id has no retained failure to clear"
        );
        assert!(snapshot_read(clean, owner("bounded-1", &["changed"]))["result"].is_object());
        let retained = drain(&owner_rx);
        assert_eq!(retained.len(), 1);
        assert!(
            retained[0].is_none(),
            "the changed, retained signature still clears"
        );

        read_tx.send(ReadRequest::Shutdown).expect("stop reader");
        reader.join().expect("join reader");
        std::fs::remove_file(path).expect("remove replica file");
    }

    #[test]
    fn owned_read_failures_clear_from_either_route_and_keep_journal_order() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let path = std::env::temp_dir().join(format!(
            "syncular-tauri-read-order-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let app = mock_builder()
            .plugin(init(SyncularConfig {
                db_path: Some(path.to_string_lossy().into_owned()),
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build file app");
        let command = |value: Value| {
            tauri::async_runtime::block_on(syncular_command(app.handle().clone(), value))
                .expect("command reply")
        };
        let read = |statements: Value, owner: Value| {
            tauri::async_runtime::block_on(syncular_snapshot_read(
                app.handle().clone(),
                statements,
                None,
                None,
                None,
                Some(owner),
            ))
            .expect("read reply")
        };
        let failures = || {
            command(json!({ "method": "diagnosticsSnapshot", "params": {} }))["result"]
                ["queryFailures"]
                .clone()
        };
        let ids = || -> Vec<String> {
            failures()
                .as_array()
                .expect("query failures array")
                .iter()
                .map(|failure| failure["id"].as_str().expect("failure id").to_owned())
                .collect()
        };
        let owner = |id: &str, tables: Value| json!({ "id": id, "tables": tables });
        // The generic command entry, carrying an owner. In file-backed mode it
        // is normalized onto the same sidecar as the dedicated commands, so one
        // producer owns the transition bookkeeping.
        let owned_command = |id: &str, tables: Value, sql: &str| {
            command(json!({ "method": "snapshotRead", "params": {
                "statements": [{ "sql": sql, "params": [] }],
                "owner": owner(id, tables),
            } }))
        };
        assert_eq!(
            command(json!({ "method": "create", "params": {
                "clientId": "read-routes",
                "schema": { "version": 1, "tables": [] },
            } }))["result"],
            json!({}),
            "the config db_path opens the replica the sidecar reads"
        );

        // Journal retention: an unchanged failure signature keeps its position,
        // a changed one moves last.
        for (id, tables) in [
            ("owner-x", json!(["tasks"])),
            ("owner-y", json!(["docs"])),
            ("owner-x", json!(["tasks"])),
        ] {
            assert!(
                owned_command(id, tables, "SELECT value FROM absent_owner_table")["error"]
                    .is_object()
            );
        }
        assert_eq!(
            ids(),
            ["owner-x", "owner-y"],
            "an unchanged failure keeps its journal position"
        );
        assert!(owned_command(
            "owner-x",
            json!(["other"]),
            "SELECT value FROM absent_owner_table"
        )["error"]
            .is_object());
        assert_eq!(
            ids(),
            ["owner-y", "owner-x"],
            "a changed failure signature moves the entry last"
        );

        // A success on one read route clears the failure the other route had
        // the sidecar report, and the journal keeps rejection order.
        assert!(read(
            json!([{ "sql": "SELECT 1 AS value" }]),
            owner("owner-x", json!(["tasks"]))
        )["result"]
            .is_object());
        assert_eq!(ids(), ["owner-y"], "the sidecar success cleared owner-x");
        assert!(read(
            json!([{ "sql": "SELECT 1 AS value" }]),
            owner("owner-y", json!(["docs"]))
        )["result"]
            .is_object());
        assert_eq!(ids(), Vec::<String>::new());

        assert!(owned_command(
            "owner-z",
            json!(["tasks"]),
            "SELECT value FROM absent_owner_table"
        )["error"]
            .is_object());
        assert_eq!(ids(), ["owner-z"]);
        assert!(read(
            json!([{ "sql": "SELECT 1 AS value" }]),
            owner("owner-z", json!(["tasks"]))
        )["result"]
            .is_object());
        assert_eq!(
            ids(),
            Vec::<String>::new(),
            "a success on one route clears the other route's failure"
        );

        assert!(read(
            json!([{ "sql": "SELECT value FROM absent_owner_table" }]),
            owner("owner-w", json!(["tasks"]))
        )["error"]
            .is_object());
        assert_eq!(ids(), ["owner-w"]);
        assert!(
            owned_command("owner-w", json!(["tasks"]), "SELECT 1 AS value")["result"].is_object()
        );
        assert_eq!(
            ids(),
            Vec::<String>::new(),
            "the generic route's success clears the sidecar failure"
        );

        // Clean sidecar reads never enter the journal.
        for round in 0..8 {
            assert!(
                read(
                    json!([{ "sql": "SELECT 1 AS value" }]),
                    owner("owner-clean", json!(["tasks"]))
                )["result"]
                    .is_object(),
                "{round}"
            );
        }
        assert_eq!(ids(), Vec::<String>::new());

        let _ = std::fs::remove_file(&path);
    }
}
