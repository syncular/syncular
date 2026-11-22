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
//! - the `events` IPC channel the creating webview passes in `create` — exact
//!   revisioned `change` batches plus ephemeral
//!   `presence` and `scopes-changed` (§8.7); command/realtime sync intents stay inside the event-driven
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
use std::str::FromStr;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::{Channel, JavaScriptChannelId};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, RunEvent, Runtime};

pub mod core;
pub mod transport;

use core::SyncularCore;
use syncular_client::{
    FileQuerySnapshotReader, QueryReadFailure, WindowCoverage, MAX_DIAGNOSTIC_QUERY_FAILURES,
};

/// Plugin configuration. Passed to [`init`]; every field is optional except a
/// caller almost always wants a `base_url` (for real network sync) and a
/// `database_dir` or `db_path` (for persistence — defaults to an in-memory core
/// if both are absent).
#[derive(Debug, Clone)]
pub struct SyncularConfig {
    /// Server base URL for the native HTTP+WS transport (needs the
    /// `native-transport` feature). Absent → client-local only.
    pub base_url: Option<String>,
    /// Path of the SPEC §12 local authority's own SQLite file, never the
    /// replica's `db_path`. With it set, sync rounds run against the in-process
    /// authority until `attachLocalAuthority` completes, then against
    /// `base_url`. Absent → no local authority.
    pub local_authority_path: Option<String>,
    /// Optional realtime WS URL; derived from `base_url` when absent.
    pub ws_url: Option<String>,
    /// The app's Rust header source (auth, actor/project ids, per-round trace
    /// headers). The native transport reads it before every
    /// host-authenticated request and realtime handshake with the request's
    /// `HeaderContext` (client id, round attempt, target), and again after a
    /// 401 with the refused headers.
    /// It runs in the host process, so a throttled or hidden webview never
    /// holds a request back. `None` sends no host headers.
    pub header_source: Option<transport::HeaderSource>,
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
    /// Interval the server sends realtime heartbeats at, in milliseconds.
    /// `None` (the default) means 30000. Twice this interval of silence after
    /// the first heartbeat closes the socket as lost.
    pub realtime_heartbeat_ms: Option<u64>,
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
    /// §5.11 native authority ceiling, table to permitted columns. At `create`
    /// the plugin prepares each declared authority query on an in-memory
    /// replica of the schema under the SQLite authorizer and refuses one that
    /// reads a table or column outside it (`client.authority_read_forbidden`,
    /// reason `ceiling`); the webview cannot widen it.
    pub authority_columns: std::collections::BTreeMap<String, Vec<String>>,
}

impl Default for SyncularConfig {
    fn default() -> Self {
        Self {
            base_url: None,
            local_authority_path: None,
            ws_url: None,
            header_source: None,
            request_timeout_ms: None,
            round_deadline_ms: None,
            max_request_bytes: None,
            max_response_bytes: None,
            redirects: None,
            realtime_heartbeat_ms: None,
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
        if let Some(path) = &self.local_authority_path {
            map.insert("localAuthorityPath".to_owned(), Value::from(path.clone()));
        }
        if let Some(ws) = &self.ws_url {
            map.insert("wsUrl".to_owned(), Value::from(ws.clone()));
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
        if let Some(ms) = self.realtime_heartbeat_ms {
            map.insert("realtimeHeartbeatMs".to_owned(), Value::from(ms));
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
        units: Vec<String>,
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
    /// The IPC channel of the webview whose `create` opened the client. Only
    /// that webview receives the client's events.
    events: Arc<Mutex<Option<Channel<Value>>>>,
    host_events: Arc<Mutex<Vec<Sender<Value>>>>,
    /// The label of the webview whose `create` succeeded last. The app has one
    /// client, so every other command from another webview is refused.
    owner: Mutex<Option<Option<String>>>,
}

/// Access the plugin's owner thread from the Rust host.
pub trait SyncularExt<R: Runtime> {
    fn syncular(&self) -> SyncularHost;
}

impl<R: Runtime, M: Manager<R>> SyncularExt<R> for M {
    fn syncular(&self) -> SyncularHost {
        SyncularHost(Arc::clone(&self.state::<Arc<SyncularState>>()))
    }
}

/// Commands and events for the replica owned by the Tauri plugin.
#[derive(Clone)]
pub struct SyncularHost(Arc<SyncularState>);

impl SyncularHost {
    /// Run a command on the owner thread and wait for its JSON reply.
    pub fn command(&self, command: &Value) -> Value {
        self.0
            .command(command.clone(), None)
            .unwrap_or_else(|error| client_error(&error))
    }

    /// Read the same events delivered to the owning webview.
    pub fn subscribe(&self) -> Receiver<Value> {
        let (send, receive) = std::sync::mpsc::channel();
        self.0
            .host_events
            .lock()
            .expect("syncular event readers")
            .push(send);
        receive
    }
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
    /// `Err` is the structured reply for a webview that does not own the
    /// client. Before the first `create` nobody owns it, and the router
    /// answers with its own no-client error.
    fn require_owner(&self, label: &str) -> Result<(), Value> {
        let owner = self
            .owner
            .lock()
            .map_err(|_| client_error("syncular owner poisoned"))?;
        match owner.as_ref() {
            Some(owner) if owner.as_deref() != Some(label) => Err(json!({ "error": {
                "code": "sync.client_owned_by_another_webview",
                "message": "the native client belongs to another webview"
            } })),
            _ => Ok(()),
        }
    }

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
                units,
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
                    units,
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
    /// §7.8 drive bound of an until-idle run: total deadline and per-round bound.
    timeout_ms: u64,
    started_at: Instant,
    spent: u32,
    aggregate: syncular_client::SyncReport,
    proof: Option<syncular_client::CurrentBasePreparation>,
    /// §7.2.2: the decisions pending when this until-idle drive started.
    decisions: Option<Vec<syncular_client::CurrentBasePreparation>>,
}

impl RoundRun {
    /// A drive the host loop starts on its own, with no caller to reply to.
    fn host() -> Self {
        Self {
            reply: None,
            until_idle: true,
            max_rounds: None,
            timeout_ms: syncular_client::SyncClient::SYNC_IDLE_TIMEOUT_MS,
            started_at: Instant::now(),
            spent: 0,
            aggregate: Default::default(),
            proof: None,
            decisions: None,
        }
    }
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
            // The webview learns of a startup failure as the structured reply
            // to its `create` (and to every later call), keeping the core's code.
            let error = syncular_client::ClientError::from(message);
            let reply = json!({ "error": {
                "code": error.code,
                "message": error.message,
                "details": error.details,
            } });
            while let Ok(request) = rx.recv() {
                match request {
                    Request::Command { reply: tx, .. } | Request::Query { reply: tx, .. } => {
                        let _ = tx.send(reply.clone());
                    }
                    Request::Shutdown => return,
                    _ => {}
                }
            }
            return;
        }
    };
    if let Some(source) = &config.header_source {
        core.set_header_source(source.clone());
    }
    core.set_authority_ceiling(config.authority_columns.clone());
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
    // §7.2.3: a pending-commit replacement fences on the owner, between rounds.
    let mut replacements: std::collections::VecDeque<(Value, Sender<Value>)> =
        std::collections::VecDeque::new();
    let mut background_deadline: Option<Instant> = None;
    // §8.4: while the app is in the background the host starts no drive of
    // its own; app drives still run.
    let mut suspended = false;
    loop {
        if core.transport_closed() {
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
            if let Some((command, reply)) = replacements.pop_front() {
                let _ = reply.send(core.command(&command));
                pump_events(&mut core, &*emit);
                continue;
            }
            if let Some(index) = queued
                .iter()
                .position(|run: &RoundRun| !suspended || run.reply.is_some())
            {
                active = queued.remove(index);
            } else if config.auto_sync && !suspended {
                match core.take_sync_intent() {
                    syncular_client::SyncIntent::Interactive => {
                        background_deadline = None;
                        active = Some(RoundRun::host());
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
            if active
                .as_ref()
                .is_some_and(|run| run.until_idle && run.decisions.is_none())
            {
                match core.prepare_replacements() {
                    Ok(decisions) => {
                        active.as_mut().expect("active run").decisions = Some(decisions)
                    }
                    Err(message) => {
                        if let Some(reply) = active.take().and_then(|run| run.reply) {
                            let _ = reply.send(
                                json!({ "result": syncular_client::SyncOutcome::Failed {
                                details: None,
                                error_code: "storage.failed".into(),
                                message,
                                recommended_action: None,
                            }.to_json() }),
                            );
                        }
                        continue;
                    }
                }
            }
            if active.is_some() {
                match core.prepare_round() {
                    Ok((mut prepared, transport)) => {
                        let run = active.as_mut().expect("active run");
                        if run.until_idle {
                            prepared.set_idle_deadline(run.timeout_ms, run.spent);
                        }
                        run.spent += 1;
                        if network_tx
                            .send(NetworkWork::Round(Box::new(prepared), transport))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(outcome) => {
                        if let Some(mut run) = active.take() {
                            let result = match run.proof.take() {
                                Some(proof) => json!(core.finish_current_base(proof, *outcome)),
                                None => outcome.to_json(),
                            };
                            if let Some(reply) = run.reply {
                                let _ = reply.send(json!({ "result": result }));
                            }
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
            if let Some(deadline) = background_deadline.filter(|_| !suspended) {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(request) => request,
                    Err(RecvTimeoutError::Timeout) => {
                        background_deadline = None;
                        queued.push_back(RoundRun::host());
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
                        keep_running = more && !core.transport_closed();
                        // §7.8: an elapsed round budget or drive deadline
                        // ends the drive with the aggregate report.
                        if keep_running
                            && (run.spent >= run.max_rounds.unwrap_or(20)
                                || run.started_at.elapsed()
                                    >= Duration::from_millis(run.timeout_ms))
                        {
                            keep_running = false;
                            outcome = syncular_client::SyncOutcome::BudgetExhausted(
                                run.aggregate.clone(),
                            );
                        } else if !keep_running {
                            outcome = syncular_client::SyncOutcome::Ok(run.aggregate.clone());
                            // §7.2.2: a written decision runs another round,
                            // which pushes it.
                            match core.settle_replacements(
                                run.decisions.as_deref().unwrap_or_default(),
                                &outcome,
                            ) {
                                Ok(true) if run.spent >= run.max_rounds.unwrap_or(20) => {
                                    outcome = syncular_client::SyncOutcome::BudgetExhausted(
                                        run.aggregate.clone(),
                                    );
                                }
                                Ok(written) => keep_running = written,
                                Err(message) => {
                                    outcome = syncular_client::SyncOutcome::Failed {
                                        details: None,
                                        error_code: "storage.failed".into(),
                                        message,
                                        recommended_action: None,
                                    };
                                }
                            }
                        }
                    }
                }
                if keep_running {
                    queued.push_front(run);
                } else if let Some(reply) = run.reply {
                    let result = match run.proof.take() {
                        Some(proof) => json!(core.finish_current_base(proof, outcome)),
                        None => outcome.to_json(),
                    };
                    let _ = reply.send(json!({ "result": result }));
                } else if matches!(outcome, syncular_client::SyncOutcome::BudgetExhausted(_)) {
                    // §7.8: an exhausted host drive queues the next drive at once.
                    queued.push_back(RoundRun {
                        started_at: Instant::now(),
                        spent: 0,
                        aggregate: Default::default(),
                        decisions: None,
                        ..run
                    });
                }
                pump_events(&mut core, &*emit);
            }
            Request::Command { command, reply } => {
                let method = command.get("method").and_then(Value::as_str);
                if method == Some("setHostLifecycle") {
                    match command.pointer("/params/state").and_then(Value::as_str) {
                        Some(state @ ("active" | "background")) => {
                            let background = state == "background";
                            // A round in flight would be suspended with the
                            // app and fail on return; it ends now, and its
                            // work runs as a held drive on return.
                            if background && !suspended && active.is_some() {
                                core.cancel_round();
                                queued.push_back(RoundRun::host());
                                pump_events(&mut core, &*emit);
                            }
                            suspended = background;
                            let _ = reply.send(json!({ "result": null }));
                        }
                        _ => {
                            let _ = reply.send(json!({ "error": {
                                "code": "sync.invalid_request",
                                "message": "setHostLifecycle state must be active or background",
                                "retryable": false
                            } }));
                        }
                    }
                    continue;
                }
                if method == Some("replacePendingCommit") && active.is_some() {
                    replacements.push_back((command, reply));
                    continue;
                }
                if matches!(method, Some("sync" | "syncUntilIdle" | "proveCurrentBase"))
                    && !core.transport_closed()
                {
                    let until_idle = method != Some("sync");
                    let proof = if method == Some("proveCurrentBase") {
                        let outcome = command.pointer("/params/outcome");
                        let id = outcome
                            .and_then(|v| v.get("clientCommitId"))
                            .and_then(Value::as_str);
                        let sequence = outcome
                            .and_then(|v| v.get("sequence"))
                            .and_then(Value::as_i64);
                        let (Some(id), Some(sequence)) = (id, sequence) else {
                            let _ = reply.send(json!({ "error": { "code": "sync.invalid_request", "message": "proveCurrentBase requires an outcome identity", "retryable": false } }));
                            continue;
                        };
                        match core.prepare_current_base(id, sequence) {
                            Ok(proof) => Some(proof),
                            Err(proof) => {
                                let _ = reply.send(json!({ "result": proof }));
                                continue;
                            }
                        }
                    } else {
                        None
                    };
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
                    // `sync` carries no drive bound either.
                    let timeout_ms = match command.pointer("/params/timeoutMs") {
                        Some(value) if until_idle && !value.is_null() => match value
                            .as_u64()
                            .filter(|ms| *ms >= 1 && i64::try_from(*ms).is_ok())
                        {
                            Some(ms) => ms,
                            None => {
                                let _ = reply.send(json!({
                                    "error": {
                                        "code": "sync.invalid_request",
                                        "message": "timeoutMs must be a positive integer",
                                        "retryable": false
                                    }
                                }));
                                continue;
                            }
                        },
                        _ => syncular_client::SyncClient::SYNC_IDLE_TIMEOUT_MS,
                    };
                    queued.push_back(RoundRun {
                        reply: Some(reply),
                        until_idle,
                        max_rounds,
                        timeout_ms,
                        started_at: Instant::now(),
                        spent: 0,
                        aggregate: Default::default(),
                        proof,
                        decisions: None,
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
    for reply in active
        .into_iter()
        .chain(queued)
        .filter_map(|run| run.reply)
        .chain(replacements.into_iter().map(|(_, reply)| reply))
    {
        let _ = reply.send(
            json!({ "error": { "code": "client.closed", "message": "client owner has closed" } }),
        );
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

fn pump_events<F: Fn(&Value)>(core: &mut SyncularCore, emit: &F) {
    for event in core.drain_events() {
        emit(&event.json);
    }
}

// -- Tauri commands (the thin shell) -----------------------------------------

#[tauri::command]
async fn syncular_command<R: Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    mut command: Value,
) -> Result<Value, String> {
    let method = command
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if method != "create" {
        if let Err(reply) = app
            .state::<Arc<SyncularState>>()
            .require_owner(webview.label())
        {
            return Ok(reply);
        }
    }
    let label = webview.label().to_owned();
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
                webview,
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
            params.get("units").cloned(),
            params.get("commitIds").cloned(),
            params.get("owner").cloned(),
        )
        .await;
    }
    let state = app.state::<Arc<SyncularState>>();
    let owner = if method == "create" {
        let channel = command
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .and_then(|params| params.remove("events"));
        match channel
            .as_ref()
            .and_then(Value::as_str)
            .map(JavaScriptChannelId::from_str)
        {
            Some(Ok(id)) => Some((label, id.channel_on(webview))),
            _ => {
                return Ok(invalid_request(
                    "sync.invalid_request: create requires an events channel",
                ))
            }
        }
    } else {
        None
    };
    state.command(command, owner)
}

impl SyncularState {
    fn command(
        &self,
        mut command: Value,
        webview: Option<(String, Channel<Value>)>,
    ) -> Result<Value, String> {
        let method = command
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if method == "create" || method == "beginSecurityPreflight" || method == "shutdown" {
            // Gate fast reads and wait for already-started sidecar snapshots before
            // the owner-thread barrier is enqueued.
            self.security_gate.begin_preflight()?;
        }
        // Taken after the gate drained, so no admitted read still waits for it.
        let mut reader = if method == "create" || method == "shutdown" {
            Some(
                self.reader
                    .lock()
                    .map_err(|_| "syncular read mailbox poisoned".to_owned())?,
            )
        } else {
            None
        };
        let mut database = None;
        if method == "create" {
            database =
                match resolve_database(&self.config, command.get("params").unwrap_or(&Value::Null))
                {
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
        // Installed before the create runs, so its first events reach the channel.
        let previous_events = if method == "create" {
            Some(std::mem::replace(
                &mut *self
                    .events
                    .lock()
                    .map_err(|_| "syncular event channel poisoned".to_owned())?,
                webview.as_ref().map(|(_, channel)| channel.clone()),
            ))
        } else {
            None
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.send(Request::Command {
            command,
            reply: reply_tx,
        })?;
        let reply = reply_rx
            .recv()
            .map_err(|_| "the syncular core dropped the reply".to_owned())?;
        let succeeded = reply.get("error").is_none();
        // A refused create leaves the previous client, and its webview, in place.
        if let (false, Some(previous)) = (succeeded, previous_events) {
            *self
                .events
                .lock()
                .map_err(|_| "syncular event channel poisoned".to_owned())? = previous;
        }
        if succeeded && method == "create" {
            *self
                .owner
                .lock()
                .map_err(|_| "syncular owner poisoned".to_owned())? =
                Some(webview.map(|(label, _)| label));
        }
        if let (true, Some(slot)) = (succeeded, reader.as_mut()) {
            let next = match database.filter(|path| path.as_str() != ":memory:") {
                Some(path) => Some(spawn_reader(
                    path,
                    self.sender
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
                self.security_gate.activate()?;
            }
        } else if succeeded && method == "activateSecurity" {
            self.security_gate.activate()?;
        }
        Ok(reply)
    }
}

#[tauri::command]
async fn syncular_query<R: Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    sql: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<Arc<SyncularState>>();
    if let Err(reply) = state.require_owner(webview.label()) {
        return Ok(reply);
    }
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
    webview: tauri::Webview<R>,
    sql: String,
    params: Option<Value>,
    coverage: Option<Value>,
    owner: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<Arc<SyncularState>>();
    if let Err(reply) = state.require_owner(webview.label()) {
        return Ok(reply);
    }
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
        let parsed_coverage = match syncular_command::parse_window_coverage(Some(&coverage_value)) {
            Ok(value) => value,
            Err(message) => return Ok(invalid_request(&message)),
        };
        // §7.5 owner: the same `{id, tables}` contract the command router parses.
        let parsed_owner =
            match syncular_command::parse_query_owner(owner.as_ref(), "querySnapshot") {
                Ok(value) => value.map(|(id, tables)| {
                    (
                        id.to_owned(),
                        tables.into_iter().map(str::to_owned).collect(),
                    )
                }),
                Err(error) => return Ok(syncular_command::reply(Err(error))),
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

/// §7.5: one atomic read over the file-backed sidecar, or the owner command
/// for an in-memory replica (SQLite cannot share an anonymous database across
/// connections). `statements` is a list of `{sql, params?}`; `units` and
/// `commitIds` name the catch-up and delivery reads. All results share one
/// revision and one read transaction. The webview reaches it as the
/// `snapshotRead` method of `syncular_command`.
async fn syncular_snapshot_read<R: Runtime>(
    app: tauri::AppHandle<R>,
    statements: Value,
    coverage: Option<Value>,
    units: Option<Value>,
    commit_ids: Option<Value>,
    owner: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<Arc<SyncularState>>();
    let _read_guard = match state.security_gate.enter_read() {
        Ok(guard) => guard,
        Err(reply) => return Ok(reply),
    };
    let params = json!({
        "statements": statements,
        "coverage": coverage,
        "units": units,
        "commitIds": commit_ids,
        "owner": owner,
    });
    let parsed = match syncular_command::parse_snapshot_read(&params) {
        Ok(parsed) => parsed,
        Err(error) => return Ok(syncular_command::reply(Err(error))),
    };

    if let Some(reader) = state.reader()? {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        reader
            .send(ReadRequest::SnapshotRead {
                statements: parsed.statements,
                coverage: parsed.coverage,
                units: parsed.units,
                commit_ids: parsed.commit_ids,
                owner: parsed.owner,
                reply: reply_tx,
            })
            .map_err(|_| "the syncular read thread has stopped".to_owned())?;
        return reply_rx
            .recv()
            .map_err(|_| "the syncular read thread dropped the reply".to_owned());
    }

    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state.send(Request::Command {
        command: json!({ "method": "snapshotRead", "params": params }),
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
/// the creating webview's `events` channel, and runs the §8.4 host loop. The
/// mailbox `Sender` is managed as plugin state and torn down on `RunEvent::Exit`.
pub fn init<R: Runtime>(config: SyncularConfig) -> TauriPlugin<R> {
    Builder::<R>::new("syncular")
        .invoke_handler(tauri::generate_handler![
            syncular_command,
            syncular_query,
            syncular_query_snapshot
        ])
        .setup(move |app, _api| {
            let (tx, rx) = std::sync::mpsc::channel::<Request>();
            let events = Arc::new(Mutex::new(None::<Channel<Value>>));
            let emit_events = Arc::clone(&events);
            let host_events = Arc::new(Mutex::new(Vec::<Sender<Value>>::new()));
            let emit_host_events = Arc::clone(&host_events);
            app.manage(Arc::new(SyncularState {
                sender: Mutex::new(tx.clone()),
                reader: Mutex::new(None),
                config: config.clone(),
                // Fail closed until the first successful `create` declares
                // whether this process starts active or in preflight.
                security_gate: SecurityGate::new_preflight(),
                events,
                host_events,
                owner: Mutex::new(None),
            }));
            let emit = move |value: &Value| {
                if let Ok(mut readers) = emit_host_events.lock() {
                    readers.retain(|reader| reader.send(value.clone()).is_ok());
                }
                // Best-effort: a webview that has gone away must not crash the
                // owning thread.
                if let Some(channel) = emit_events.lock().ok().and_then(|slot| slot.clone()) {
                    let _ = channel.send(value.clone());
                }
            };
            std::thread::Builder::new()
                .name("syncular-core".to_owned())
                .spawn(move || run_owner_thread(config, tx, rx, emit))
                .map_err(|e| format!("failed to spawn syncular core thread: {e}"))?;
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<SyncularState>>() {
                    let _ = state.send(Request::Shutdown);
                    if let Ok(mut readers) = state.host_events.lock() {
                        readers.clear();
                    }
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

    /// The mock webview with this label, created on first use.
    fn webview(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        label: &str,
    ) -> tauri::Webview<tauri::test::MockRuntime> {
        let window = match app.get_webview_window(label) {
            Some(window) => window,
            None => tauri::WebviewWindowBuilder::new(app, label, Default::default())
                .build()
                .expect("mock webview"),
        };
        window.as_ref().clone()
    }

    /// Run one `syncular_command` from the mock webview `label`. A `create`
    /// carries that webview's events channel unless the test sets `events`.
    fn run_command_from(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        label: &str,
        mut command: Value,
    ) -> Result<Value, String> {
        if command["method"] == "create" {
            if let Some(params) = command.get_mut("params").and_then(Value::as_object_mut) {
                params
                    .entry("events")
                    .or_insert_with(|| json!("__CHANNEL__:1"));
            }
        }
        tauri::async_runtime::block_on(syncular_command(app.clone(), webview(app, label), command))
    }

    /// Run one `syncular_command` from the mock `main` webview.
    fn run_command(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        command: Value,
    ) -> Result<Value, String> {
        run_command_from(app, "main", command)
    }

    #[test]
    fn config_to_transport_json_shapes_fields() {
        let config = SyncularConfig {
            base_url: Some("https://api.example.com".to_owned()),
            local_authority_path: Some("/data/authority.db".to_owned()),
            header_source: Some(transport::HeaderSource::new(|_, _| None)),
            request_timeout_ms: Some(1000),
            round_deadline_ms: Some(2000),
            max_request_bytes: Some(1024),
            max_response_bytes: Some(2048),
            redirects: Some("deny".to_owned()),
            realtime_heartbeat_ms: Some(15000),
            ..Default::default()
        };
        let json = config.to_transport_json();
        assert_eq!(json["baseUrl"], "https://api.example.com");
        assert_eq!(json["localAuthorityPath"], "/data/authority.db");
        // The header source never crosses into the transport JSON.
        assert!(json.get("headers").is_none());
        assert_eq!(json["requestTimeoutMs"], 1000);
        assert_eq!(json["roundDeadlineMs"], 2000);
        assert_eq!(json["maxRequestBytes"], 1024);
        assert_eq!(json["maxResponseBytes"], 2048);
        assert_eq!(json["redirects"], "deny");
        assert_eq!(json["realtimeHeartbeatMs"], 15000);
    }

    #[test]
    fn rust_host_uses_the_replica_owner_and_receives_projection_events() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let host = app.syncular();
        let events = host.subscribe();
        let command = |method, params| host.command(&json!({ "method": method, "params": params }));
        let unopened = command(
            "projectionPending",
            json!({"name": "local_names", "limit":1}),
        );
        assert_eq!(unopened["error"]["message"], "no client instance created");
        let created = run_command(app.handle(), json!({"method": "create", "params": {
            "schema": {"version": 1, "tables": [{
                "name": "records", "primaryKey": "id", "scopes": [{"pattern":"workspace:{workspace_id}"}],
                "columns": [
                    {"name":"id","type":"string","nullable":false},
                    {"name":"workspace_id","type":"string","nullable":false},
                    {"name":"sealed","type":"bytes","nullable":false}
                ],
                "localProjections":[{"name":"local_names","generation":"1","columns":[{"name":"display_name","declaredType":"string"}]}]
            }]},
            "securityPreflight": true
        }})).unwrap();
        assert!(created.get("result").is_some(), "{created}");
        let refused = command(
            "writeProjection",
            json!({"name":"local_names", "epoch":0, "rows":[]}),
        );
        assert_eq!(
            refused["error"]["code"],
            "client.security_preflight_required"
        );
        assert!(command("activateSecurity", json!({}))
            .get("result")
            .is_some());
        let inserted = command(
            "mutate",
            json!({"mutations":[{
                "table":"records","op":"upsert","values":{"id":"one","workspace_id":"p1","sealed":{"$bytes":"ab12"}}
            }]}),
        );
        assert!(inserted.get("result").is_some(), "{inserted}");
        let queried = command("query", json!({"sql":"SELECT sealed FROM records"}));
        assert_eq!(queried["result"]["rows"][0]["sealed"]["$bytes"], "ab12");
        let pending: Vec<_> = events
            .try_iter()
            .filter(|event| event["type"] == "projectionPending")
            .collect();
        assert_eq!(
            pending,
            [json!({"type":"projectionPending", "name":"local_names"})]
        );
    }

    #[test]
    fn a_startup_failure_is_the_structured_reply_to_create() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(init(SyncularConfig {
                realtime_heartbeat_ms: Some(0),
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build mock app");
        let created = run_command(
            app.handle(),
            json!({ "method": "create", "params": { "schema": { "version": 1, "tables": [] } } }),
        )
        .expect("a structured create reply, not an IPC rejection");
        assert_eq!(
            created["error"]["code"], "sync.invalid_request",
            "{created}"
        );
        assert_eq!(
            created["error"]["details"]["legacyCause"],
            "sync.invalid_request: transport config realtimeHeartbeatMs must be a positive integer"
        );
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
    fn local_authority_commands_route_through_the_plugin_without_a_configured_authority() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build mock app");
        let command = |method: &str| {
            run_command(app.handle(), json!({ "method": method, "params": {} }))
                .expect("command reply")
        };

        let created = run_command(
            app.handle(),
            json!({
                "method": "create",
                "params": {
                    "clientId": "native-no-authority",
                    "schema": { "version": 1, "tables": [] }
                }
            }),
        )
        .expect("create reply");
        assert!(created.get("error").is_none(), "{created}");

        let state = command("localAuthorityState");
        assert_eq!(state["result"]["state"], Value::Null, "{state}");
        for method in ["attachLocalAuthority", "abandonLocalAuthorityAttach"] {
            let reply = command(method);
            assert_eq!(
                reply["error"]["code"], "client.local_authority_unconfigured",
                "{method}: {reply}"
            );
        }
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
        let command = |value: Value| run_command(app.handle(), value).expect("command reply");

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
            webview(app.handle(), "main"),
            "SELECT 1".to_owned(),
            None,
        ))
        .expect("query reply");
        assert_eq!(
            read["error"]["code"],
            Value::from("client.security_preflight_required")
        );

        // Activation releases both gates.
        let activated = command(json!({ "method": "activateSecurity", "params": {} }));
        assert!(activated.get("error").is_none(), "{activated}");
        let read = tauri::async_runtime::block_on(syncular_query(
            app.handle().clone(),
            webview(app.handle(), "main"),
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
    fn add_encryption_keys_runs_in_owner_order_with_preflight_and_shutdown() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(mock_context(noop_assets()))
            .expect("build mock app");
        let command = |value: Value| run_command(app.handle(), value).expect("command reply");
        let state = app.state::<Arc<SyncularState>>();
        // Both requests sit in the owner mailbox before either runs.
        let queue = |method: &str, params: Value| {
            let (reply, receiver) = std::sync::mpsc::channel();
            state
                .send(Request::Command {
                    command: json!({ "method": method, "params": params }),
                    reply,
                })
                .expect("owner mailbox");
            receiver
        };
        let key = |byte: &str| json!({ "keys": { "k2": { "$bytes": byte.repeat(32) } } });
        let created = command(json!({ "method": "create", "params": {
            "clientId": "native-add-keys", "schema": { "version": 1, "tables": [] }
        } }));
        assert!(created.get("error").is_none(), "{created}");

        // An addition queued before beginSecurityPreflight installs, and the
        // preflight then releases it: after activation the same id takes
        // different bytes without a conflict.
        let added = queue("addEncryptionKeys", key("2b"));
        let locked = queue("beginSecurityPreflight", json!({}));
        assert_eq!(added.recv().unwrap(), json!({ "result": {} }));
        assert_eq!(locked.recv().unwrap(), json!({ "result": {} }));
        let activated = command(json!({ "method": "activateSecurity", "params": {} }));
        assert!(activated.get("error").is_none(), "{activated}");
        let readded = command(json!({ "method": "addEncryptionKeys", "params": key("2c") }));
        assert_eq!(readded, json!({ "result": {} }));
        let conflict = command(json!({ "method": "addEncryptionKeys", "params": key("2b") }));
        assert_eq!(conflict["error"]["details"], json!({ "keyId": "k2" }));

        // beginSecurityPreflight queued first refuses the addition.
        let locked = queue("beginSecurityPreflight", json!({}));
        let added = queue("addEncryptionKeys", key("2d"));
        assert_eq!(locked.recv().unwrap(), json!({ "result": {} }));
        assert_eq!(
            added.recv().unwrap()["error"]["code"],
            "client.security_preflight_required"
        );

        command(json!({ "method": "activateSecurity", "params": {} }));
        assert_eq!(
            command(json!({ "method": "shutdown" }))["result"],
            json!({})
        );
        assert_eq!(
            command(json!({ "method": "addEncryptionKeys", "params": key("2b") }))["error"]["code"],
            "client.closed"
        );
    }

    #[test]
    fn authority_read_raw_ipc_obeys_the_native_ceiling_and_never_opens_protected_reads() {
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
        let command = |value: Value| run_command(&handle, value).expect("IPC reply");
        let schema = json!({"version": 1, "tables": [{"name": "authority", "primaryKey": "id", "scopes": [{"pattern": "actor:{actor_id}"}], "columns": [
            {"name": "id", "type": "string", "nullable": false}, {"name": "actor_id", "type": "string", "nullable": false}, {"name": "role", "type": "string", "nullable": false}, {"name": "secret", "type": "bytes", "encrypted": true, "declaredType": "string", "nullable": true}
        ]}]});
        let query = |name: &str, sql: &str, reads: Value| {
            json!({
                "name": name,
                "sql": sql,
                "bind": ["actorId"],
                "params": [{"name": "actorId", "type": "string", "nullable": false}],
                "coverage": [{"table": "authority", "variable": "actor_id", "units": ["actorId"]}],
                "reads": reads,
                "resultColumns": [{"name": "role", "type": "string", "nullable": false}]
            })
        };
        let policy = json!([query(
            "roleOf",
            "SELECT role FROM authority WHERE actor_id = ?",
            json!({"authority": ["actor_id", "role"]})
        )]);
        let create = |reads: Value| json!({"method": "create", "params": {"schema": schema, "securityPreflight": true, "transportGate": "closed", "authorityReads": reads}});
        let read = |actor: &str| {
            command(json!({"method": "authorityRead", "params": {"requests": [
                {"query": "roleOf", "params": {"actorId": actor}}
            ]}}))
        };
        let created = command(create(policy.clone()));
        assert!(created.get("error").is_none(), "{created}");
        let conn = rusqlite::Connection::open(&path).expect("fixture db");
        conn.execute_batch("INSERT INTO _syncular_base_authority(id,actor_id,role,secret,_syncular_version)VALUES('one','a','accepted','clinical plaintext',7); INSERT INTO authority SELECT * FROM _syncular_base_authority;").expect("fixture base");
        for actor in ["a", "b"] {
            let echo = json!([{"table": "authority", "status": "active", "scopes": {"actor_id": [actor]}}]);
            conn.execute(
                "INSERT INTO _syncular_units(id,scopes,explicit,cursor,echo)VALUES(?1,?2,1,NULL,?3)",
                rusqlite::params![actor, json!({"actor_id": actor}).to_string(), echo.to_string()],
            )
            .expect("fixture unit");
        }
        let snapshot = read("a");
        assert_eq!(
            snapshot["result"]["results"],
            json!([{
                "query": "roleOf",
                "rows": [{"role": "accepted"}],
                "coverage": [{"table": "authority", "base": {"variable": "actor_id"}, "unit": "a", "state": "complete"}],
                "complete": true
            }]),
            "{snapshot}"
        );
        assert!(snapshot["result"]["revision"].is_string());
        assert!(!snapshot.to_string().contains("clinical plaintext"));
        assert_eq!(
            command(json!({"method": "securityLifecycle", "params": {}}))["result"]["state"],
            "preflight"
        );
        for params in [
            json!({}),
            json!({"sql": "SELECT secret FROM authority"}),
            json!({"requests": {}}),
            json!({"requests": [{"query": "roleOf"}]}),
            json!({"requests": [{"query": "roleOf", "params": {}, "sql": "x"}]}),
            json!({"requests": [], "authorityReads": policy}),
        ] {
            let refused = command(json!({"method": "authorityRead", "params": params}));
            assert_eq!(refused["error"]["code"], "client.authority_read_forbidden");
            assert!(refused["error"].get("details").is_none(), "{refused}");
        }
        let unknown = command(json!({"method": "authorityRead", "params": {"requests": [
            {"query": "secretOf", "params": {}}
        ]}}));
        assert_eq!(unknown["error"]["code"], "client.authority_query_unknown");
        assert_eq!(unknown["error"]["details"], json!({"query": "secretOf"}));
        let mistyped = command(json!({"method": "authorityRead", "params": {"requests": [
            {"query": "roleOf", "params": {"actorId": 1}}
        ]}}));
        assert_eq!(mistyped["error"]["code"], "sync.invalid_request");
        assert_eq!(
            mistyped["error"]["details"],
            json!({"query": "roleOf", "param": "actorId"})
        );
        // The ceiling checks the authored statement, whatever `reads` claims.
        for (sql, reads, details) in [
            (
                "SELECT secret FROM authority WHERE actor_id = ?",
                json!({"authority": ["actor_id"]}),
                json!({"query": "probe", "reason": "ceiling", "table": "authority", "column": "secret"}),
            ),
            (
                "SELECT value FROM _syncular_meta WHERE key = ?",
                json!({}),
                json!({"query": "probe", "reason": "ceiling", "table": "_syncular_meta"}),
            ),
            (
                "SELECT role FROM authority WHERE actor_id = ? AND random() > 0",
                json!({"authority": ["actor_id", "role"]}),
                json!({"query": "probe", "reason": "ceiling"}),
            ),
            (
                "SELECT role FROM authority WHERE actor_id = ?; DELETE FROM authority",
                json!({"authority": ["actor_id", "role"]}),
                json!({"query": "probe", "reason": "shape"}),
            ),
            (
                "SELECT role FROM authority WHERE actor_id = ?",
                json!({"authority": ["actor_id", "secret"]}),
                json!({"query": "probe", "reason": "column", "table": "authority", "column": "secret"}),
            ),
        ] {
            let refused = command(create(json!([query("probe", sql, reads)])));
            assert_eq!(
                refused["error"]["code"], "client.authority_read_forbidden",
                "{sql}"
            );
            assert_eq!(refused["error"]["details"], details, "{sql}");
        }
        assert_eq!(read("a")["result"]["results"][0]["complete"], true);
        for method in ["query", "querySnapshot", "mutate", "subscribe", "sync"] {
            assert_eq!(
                command(json!({"method": method, "params": {"sql": "SELECT id FROM authority"}}))
                    ["error"]["code"],
                "client.security_preflight_required"
            );
        }
        assert_eq!(
            tauri::async_runtime::block_on(syncular_query(
                app.handle().clone(),
                webview(app.handle(), "main"),
                "SELECT id FROM authority".into(),
                None
            ))
            .unwrap()["error"]["code"],
            "client.security_preflight_required"
        );
        assert_eq!(
            tauri::async_runtime::block_on(syncular_query_snapshot(
                app.handle().clone(),
                webview(app.handle(), "main"),
                "SELECT id FROM authority".into(),
                None,
                None,
                None
            ))
            .unwrap()["error"]["code"],
            "client.security_preflight_required"
        );
        let before = snapshot["result"]["revision"].clone();
        assert_eq!(read("a")["result"]["revision"], before);
        conn.execute("UPDATE _syncular_units SET cursor=7, bootstrap_state='credential-do-not-expose' WHERE id='b'", []).unwrap();
        let partial = read("b");
        assert_eq!(partial["result"]["results"][0]["complete"], false);
        assert_eq!(
            partial["result"]["results"][0]["coverage"][0]["state"],
            "pending"
        );
        assert!(!partial.to_string().contains("credential-do-not-expose"));
        conn.execute(
            "UPDATE _syncular_units SET echo='credential-do-not-expose' WHERE id='b'",
            [],
        )
        .unwrap();
        let corrupt = read("a");
        assert_eq!(corrupt["error"]["code"], "sync.local_corrupt");
        assert!(!corrupt.to_string().contains("credential-do-not-expose"));
        conn.execute("DELETE FROM _syncular_units WHERE id='b'", [])
            .unwrap();
        assert_eq!(
            read("b")["result"]["results"][0]["coverage"][0]["state"],
            "missing"
        );
        command(json!({"method": "beginSecurityPreflight", "params": {}}));
        // Entering preflight emits one status batch (§5.11), which advances the
        // revision; a second lock does not.
        let locked = read("a");
        assert!(locked.get("error").is_none());
        let before = locked["result"]["revision"].clone();
        // The owner's mailbox serializes a lock/read race without admitting SQL.
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let locking = scope.spawn(|| {
                barrier.wait();
                command(json!({"method": "beginSecurityPreflight", "params": {}}))
            });
            barrier.wait();
            let reading = read("a");
            assert_eq!(reading["result"]["revision"], before);
            assert!(locking.join().unwrap().get("error").is_none());
        });
        // A racing close either follows the entire read or rejects it.
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let closing = scope.spawn(|| {
                barrier.wait();
                command(json!({"method": "shutdown", "params": {}}))
            });
            barrier.wait();
            let reading = read("a");
            assert!(
                reading["result"]["revision"] == before
                    || reading["error"]["code"] == "client.closed",
                "{reading}"
            );
            assert!(closing.join().unwrap().get("error").is_none());
        });
        assert_eq!(read("a")["error"]["code"], "client.closed");
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
        let command = |value: Value| run_command(app.handle(), value).expect("command reply");
        let snapshot = |sql: &str| {
            tauri::async_runtime::block_on(syncular_query_snapshot(
                app.handle().clone(),
                webview(app.handle(), "main"),
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

    /// Sync events reach only the webview that created the client. An app-wide
    /// emit reaches every webview's default `listen`, including windows the
    /// app never granted `syncular:default`.
    #[test]
    fn events_never_broadcast_app_wide() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tauri::Listener;

        let app = tauri::test::mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let broadcast = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&broadcast);
        app.listen_any("syncular://event", move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        let call = |command: Value| run_command(app.handle(), command).unwrap();
        let schema = json!({ "version": 1, "tables": [{
            "name": "todo", "primaryKey": "id",
            "columns": [{ "name": "id", "type": "string", "nullable": false }],
            "scopes": []
        }] });
        let refused = call(json!({ "method": "create", "params": {
            "schema": schema, "events": null
        } }));
        assert_eq!(
            refused["error"]["code"], "sync.invalid_request",
            "{refused}"
        );
        let created = call(json!({ "method": "create", "params": { "schema": schema } }));
        assert!(created.get("error").is_none(), "{created}");
        call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "t1" }
        }] } }));
        // The owner pumps a command's events before it serves the next one.
        call(json!({ "method": "localRevision", "params": {} }));
        assert_eq!(broadcast.load(Ordering::SeqCst), 0);
    }

    /// The app has one client, owned by the webview whose `create` succeeded
    /// last. Every other command from another webview is refused with a
    /// static code and never reaches the client.
    #[test]
    fn only_the_owning_webview_reaches_the_client() {
        let app = tauri::test::mock_builder()
            .plugin(init(SyncularConfig {
                auto_sync: false,
                ..Default::default()
            }))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let schema = json!({ "version": 1, "tables": [{
            "name": "todo", "primaryKey": "id",
            "columns": [{ "name": "id", "type": "string", "nullable": false }],
            "scopes": []
        }] });
        let from =
            |label: &str, command: Value| run_command_from(app.handle(), label, command).unwrap();
        let count = |label: &str| {
            tauri::async_runtime::block_on(syncular_query(
                app.handle().clone(),
                webview(app.handle(), label),
                "SELECT count(*) AS n FROM todo".to_owned(),
                None,
            ))
            .unwrap()
        };
        let refusal = json!({ "error": {
            "code": "sync.client_owned_by_another_webview",
            "message": "the native client belongs to another webview"
        } });
        let mutate = json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "t1" }
        }] } });

        // Before any create nobody owns the client; the router answers.
        assert_ne!(
            from("second", json!({ "method": "localRevision", "params": {} })),
            refusal
        );

        let created = from(
            "main",
            json!({ "method": "create", "params": { "schema": schema } }),
        );
        assert!(created.get("error").is_none(), "{created}");
        assert_eq!(from("second", mutate.clone()), refusal);
        assert_eq!(
            from(
                "second",
                json!({ "method": "querySnapshot", "params": { "sql": "SELECT 1" } })
            ),
            refusal
        );
        assert_eq!(
            from(
                "second",
                json!({ "method": "snapshotRead", "params": { "statements": [] } })
            ),
            refusal
        );
        assert_eq!(count("second"), refusal);
        assert_eq!(
            count("main")["result"]["rows"][0]["n"],
            0,
            "the refused mutate reached the client"
        );
        let owned = from("main", mutate.clone());
        assert!(owned.get("error").is_none(), "{owned}");
        assert_eq!(count("main")["result"]["rows"][0]["n"], 1);

        // A second webview's create takes over; the first is then refused.
        let taken = from(
            "second",
            json!({ "method": "create", "params": { "schema": schema } }),
        );
        assert!(taken.get("error").is_none(), "{taken}");
        assert_eq!(from("main", mutate.clone()), refusal);
        assert_eq!(count("main"), refusal);
        assert_eq!(count("second")["result"]["rows"][0]["n"], 0);

        // A refused create leaves the owner in place.
        let refused = from(
            "main",
            json!({ "method": "create", "params": { "schema": schema, "events": null } }),
        );
        assert_eq!(
            refused["error"]["code"], "sync.invalid_request",
            "{refused}"
        );
        assert_eq!(from("main", mutate), refusal);
        assert!(
            from("second", json!({ "method": "localRevision", "params": {} }))
                .get("error")
                .is_none()
        );
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

    /// The scripted server's sections for one non-reset round (SPEC §4.3):
    /// an empty bootstrap pinned at 0 answering the `{id: "one"}` unit's
    /// `PROGRESS`, then the live section with `commits` through `through_seq`.
    #[cfg(feature = "native-transport")]
    fn scripted_sections(
        request: &ssp2::model::Message,
        through_seq: i64,
        commits: Vec<ssp2::model::Frame>,
    ) -> Vec<ssp2::model::Frame> {
        use ssp2::model::{Frame, LiveStatus, SubStatus};
        use ssp2::segment::{Column, ColumnType, RowsSegment};
        let unit = ssp2::registration::unit_id(&[("id".into(), "one".into())]);
        let mut frames = Vec::new();
        if request
            .frames
            .iter()
            .any(|frame| matches!(frame, Frame::Progress { id, .. } if *id == unit))
        {
            frames.push(Frame::SubStart {
                id: unit,
                status: SubStatus::Active,
                reason_code: String::new(),
                bootstrap: true,
                fenced: vec![],
            });
            frames.push(Frame::SegmentInline {
                payload: ssp2::segment::encode_rows_segment(&RowsSegment {
                    table: "todo".into(),
                    schema_version: 1,
                    columns: ["id", "title"]
                        .map(|name| Column {
                            name: name.into(),
                            ty: ColumnType::String,
                            nullable: false,
                        })
                        .into(),
                    blocks: vec![],
                }),
            });
            frames.push(Frame::SubEnd {
                next_cursor: 0,
                bootstrap_state: None,
            });
        }
        frames.push(Frame::LiveStart {
            status: LiveStatus::Active,
            reason_code: String::new(),
        });
        frames.extend(commits);
        frames.push(Frame::LiveEnd {
            through_seq,
            echo_digest: Some([7; 32]),
        });
        frames
    }

    /// The app's header source reaches the native transport: each request
    /// reads it, a 401 reads it again with the refused headers, and a
    /// second 401 surfaces `sync.auth_required` after exactly two requests.
    #[cfg(feature = "native-transport")]
    #[test]
    fn the_configured_header_source_authenticates_and_refreshes_after_a_401() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::sync::mpsc::channel;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            (0..2)
                .map(|_| {
                    let (mut socket, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(socket.try_clone().unwrap());
                    let (mut head, mut length) = (String::new(), 0);
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        let line = line.to_ascii_lowercase();
                        if let Some(value) = line.strip_prefix("content-length:") {
                            length = value.trim().parse().unwrap();
                        }
                        head.push_str(&line);
                    }
                    reader.read_exact(&mut vec![0; length]).unwrap();
                    let body = r#"{"code":"sync.auth_required","message":"host authentication required"}"#;
                    write!(
                        socket,
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                    head
                })
                .collect::<Vec<_>>()
        });
        let reads = Arc::new(Mutex::new(Vec::new()));
        let seen = reads.clone();
        let (tx, rx) = channel();
        let owner_tx = tx.clone();
        let owner = std::thread::spawn(move || {
            run_owner_thread(
                SyncularConfig {
                    base_url: Some(format!("http://{address}")),
                    header_source: Some(transport::HeaderSource::new(move |context, rejected| {
                        seen.lock()
                            .unwrap()
                            .push((context.clone(), rejected.map(<[_]>::to_vec)));
                        let token = if rejected.is_none() { "stale" } else { "fresh" };
                        Some(vec![("authorization".into(), format!("Bearer {token}"))])
                    })),
                    auto_sync: false,
                    ..Default::default()
                },
                owner_tx,
                rx,
                |_| {},
            )
        });
        let call = |command: Value| {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result.recv().unwrap()
        };
        let created = call(json!({ "method": "create", "params": {
            "clientId": "header-source", "schema": { "version": 1, "tables": [{
                "name": "todo", "primaryKey": "id", "columns": [
                    { "name": "id", "type": "string", "nullable": false }
                ], "scopes": [{ "pattern": "todo:{id}" }]
            }] }
        } }));
        assert!(created.get("error").is_none(), "{created}");
        let subscribed =
            call(json!({ "method": "subscribe", "params": { "scopes": { "id": "one" } } }));
        assert!(subscribed.get("error").is_none(), "{subscribed}");
        let synced = call(json!({ "method": "sync" }));
        assert_eq!(
            synced["result"]["errorCode"], "sync.auth_required",
            "{synced}"
        );
        let heads = server.join().unwrap();
        assert!(
            heads[0].contains("authorization: bearer stale"),
            "{}",
            heads[0]
        );
        assert!(
            heads[1].contains("authorization: bearer fresh"),
            "{}",
            heads[1]
        );
        let stale = vec![("authorization".to_owned(), "Bearer stale".to_owned())];
        let reads = reads.lock().unwrap();
        assert_eq!(
            reads
                .iter()
                .map(|(_, rejected)| rejected.clone())
                .collect::<Vec<_>>(),
            vec![None, Some(stale)]
        );
        // Both reads name the created client and the one round, as a sync.
        for (context, _) in reads.iter() {
            assert_eq!(context.client_id, "header-source");
            assert_eq!(context.target, transport::HeaderTarget::Sync);
            assert!(context.round.is_some());
            assert_eq!(context.round, reads[0].0.round);
        }
        drop(reads);
        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
    }

    #[cfg(feature = "native-transport")]
    #[test]
    fn pending_network_round_keeps_local_mutations_and_queries_responsive() {
        use ssp2::model::{Change, Frame, Message, MsgKind, Op, OpResult, PushStatus};
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
                    log_epoch: "epoch".into(),
                    reset_required: reset,
                }];
                if !reset {
                    let commits: Vec<_> = request
                        .frames
                        .iter()
                        .filter_map(|frame| {
                            if let Frame::PushCommit {
                                client_commit_id,
                                operations,
                                ..
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
                if !reset {
                    let mut commits = Vec::new();
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
                        commits.push(Frame::Commit {
                            commit_seq: 3,
                            created_at_ms: 0,
                            actor_id: "actor".into(),
                            tables: vec!["todo".into()],
                            changes: vec![Change {
                                table_index: 0,
                                row_id: "one".into(),
                                op: Op::Upsert,
                                row_version: 3,
                                scopes: vec![("id".into(), "one".into())],
                                row: Some(row.into_bytes()),
                            }],
                        });
                        server_image_sent.store(true, Ordering::SeqCst);
                    }
                    frames.extend(scripted_sections(
                        &request,
                        if deliver { 3 } else { 0 },
                        commits,
                    ));
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
                    header_source: Some(transport::HeaderSource::new(|_, _| {
                        Some(vec![("authorization".into(), "Bearer fresh".into())])
                    })),
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
            "clientId": "pending-round", "transportGate": "closed", "securityPreflight": true, "schema": { "version": 1, "tables": [{
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
        assert!(
            call(json!({ "method": "subscribe", "params": { "scopes": { "id": "one" } } }))
                .recv()
                .unwrap()
                .get("error")
                .is_none()
        );
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
        assert!(
            call(json!({ "method": "setTransportGate", "params": { "state": "open" } }))
                .recv()
                .unwrap()
                .get("error")
                .is_none()
        );
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            call(json!({ "method": "setTransportGate", "params": { "state": "closed" } }))
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
            call(json!({ "method": "setTransportGate", "params": { "state": "open" } }))
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

    /// §8.4: in the background the host loop starts no drive of its own, and
    /// the round in flight ends as `client.round_cancelled` instead of failing
    /// on return; `active` runs the held work.
    #[cfg(feature = "native-transport")]
    #[test]
    fn background_lifecycle_holds_host_drives() {
        use ssp2::model::{Frame, Message, MsgKind};
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (entered_tx, entered) = channel();
        let (release, release_rx) = channel::<()>();
        let resumed = Arc::new(AtomicBool::new(false));
        let server_resumed = Arc::clone(&resumed);
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop);
        let server = std::thread::spawn(move || {
            // Whether the app was active when each request arrived. Only
            // the first request waits for `release`.
            let mut seen = Vec::new();
            for socket in listener.incoming() {
                if server_stop.load(Ordering::SeqCst) {
                    break;
                }
                let mut socket = socket.unwrap();
                seen.push(server_resumed.load(Ordering::SeqCst));
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let length: usize = String::from_utf8(header)
                    .unwrap()
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
                let _ = entered_tx.send(seen.len());
                if seen.len() == 1 {
                    release_rx.recv().unwrap();
                }
                let mut frames = vec![Frame::RespHeader {
                    required_schema_version: None,
                    latest_schema_version: None,
                    log_epoch: "epoch".into(),
                    reset_required: reset,
                }];
                if !reset {
                    frames.extend(scripted_sections(&request, 0, Vec::new()));
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
            seen
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
                |_| {},
            )
        });
        let call = |command: Value| {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result.recv().unwrap()
        };
        let lifecycle = |state: &str| {
            call(json!({ "method": "setHostLifecycle", "params": { "state": state } }))
        };
        assert!(call(json!({ "method": "create", "params": {
            "clientId": "background", "schema": { "version": 1, "tables": [{
                "name": "todo", "primaryKey": "id", "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ], "scopes": [{ "pattern": "todo:{id}" }]
            }] }
        } }))
        .get("error")
        .is_none());
        assert_eq!(lifecycle("hidden")["error"]["code"], "sync.invalid_request");

        // Held: local work raises intent, and no round begins (a round
        // beginning clears syncNeeded on the owner before the next command).
        assert_eq!(lifecycle("background")["result"], Value::Null);
        call(json!({ "method": "subscribe", "params": { "scopes": { "id": "one" } } }));
        call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "one", "title": "v1" }
        }] } }));
        assert_eq!(
            call(json!({ "method": "statusSnapshot" }))["result"]["syncNeeded"],
            true
        );

        // `active` runs the held intent.
        resumed.store(true, Ordering::SeqCst);
        lifecycle("active");
        assert_eq!(entered.recv_timeout(Duration::from_secs(10)).unwrap(), 1);

        // Background during that round ends it as cancelled, at once.
        resumed.store(false, Ordering::SeqCst);
        lifecycle("background");
        let diagnostics = call(json!({ "method": "diagnosticsSnapshot" }));
        assert_eq!(
            diagnostics["result"]["lastRound"]["errorCode"], "client.round_cancelled",
            "{diagnostics}"
        );
        release.send(()).unwrap();

        // The cancelled round's work waits for `active`; the server records
        // whether a request arrived while the app was in the background.
        resumed.store(true, Ordering::SeqCst);
        lifecycle("active");
        assert_eq!(entered.recv_timeout(Duration::from_secs(10)).unwrap(), 2);
        assert_eq!(
            call(json!({ "method": "syncUntilIdle" }))["result"]["ok"],
            true
        );
        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
        stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(address);
        let seen = server.join().unwrap();
        assert!(seen.iter().all(|active| *active), "{seen:?}");
    }

    #[cfg(feature = "native-transport")]
    #[test]
    fn owner_thread_publishes_refused_connection_evidence() {
        use std::net::TcpListener;
        use std::sync::{mpsc::channel, Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let emitted = Arc::clone(&events);
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
                move |event| emitted.lock().unwrap().push(event.clone()),
            )
        });
        let call = |command: Value| -> Value {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result.recv().unwrap()
        };
        let created = call(json!({ "method": "create", "params": {
            "clientId": "diagnostics-tauri-connect", "transportGate": "open",
            "schema": { "version": 1, "tables": [] }
        } }));
        assert!(created.get("error").is_none(), "{created}");
        call(json!({ "method": "enableDiagnostics", "params": {} }));
        let failed = call(json!({ "method": "sync", "params": {} }));
        assert_eq!(failed["result"]["details"]["causeKind"], "connect");
        let snapshot = call(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(snapshot["result"]["lastRound"]["causeKind"], "connect");
        assert_eq!(snapshot["result"]["host"]["connectivity"], "offline");
        {
            let events = events.lock().unwrap();
            assert!(events
                .iter()
                .any(|event| event["type"] == "progress"
                    && event["progress"]["causeKind"] == "connect"));
            assert!(events.iter().any(|event| event["type"] == "diagnostics"
                && event["snapshot"]["lastRound"]["causeKind"] == "connect"));
            let progress = events
                .iter()
                .rfind(|event| event["type"] == "progress")
                .unwrap();
            assert!(progress["progress"]["epoch"].is_string());
            assert_eq!(
                snapshot["result"]["lastRound"]["epoch"],
                progress["progress"]["epoch"]
            );
            assert_eq!(
                snapshot["result"]["lastRound"]["attempt"],
                progress["progress"]["attempt"]
            );
        }
        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
    }

    #[cfg(feature = "native-transport")]
    #[test]
    fn owner_thread_publishes_transport_status_and_clears_it_on_recovery() {
        use ssp2::model::{Frame, Message, MsgKind};
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{mpsc::channel, Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for round in 0..2 {
                let (mut socket, _) = listener.accept().unwrap();
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
                let mut request = vec![0; length];
                socket.read_exact(&mut request).unwrap();
                if round == 0 {
                    let body = b"private-response-secret";
                    write!(socket, "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    socket.write_all(body).unwrap();
                } else {
                    let response = ssp2::encode_message(&Message {
                        wire_version: ssp2::decode::WIRE_VERSION,
                        msg_kind: MsgKind::Response,
                        frames: vec![Frame::RespHeader {
                            required_schema_version: None,
                            latest_schema_version: None,
                            log_epoch: "epoch-1".into(),
                            reset_required: true,
                        }],
                    });
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .unwrap();
                    socket.write_all(&response).unwrap();
                }
            }
        });
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let emitted = Arc::clone(&events);
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
                move |event| emitted.lock().unwrap().push(event.clone()),
            )
        });
        let call = |command: Value| -> Value {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result.recv().unwrap()
        };
        let created = call(json!({ "method": "create", "params": {
            "clientId": "diagnostics-tauri", "transportGate": "open",
            "schema": { "version": 1, "tables": [] }
        } }));
        assert!(created.get("error").is_none(), "{created}");
        call(json!({ "method": "enableDiagnostics", "params": {} }));
        let failed = call(json!({ "method": "sync", "params": {} }));
        assert_eq!(failed["result"]["details"]["causeKind"], "status");
        assert_eq!(failed["result"]["details"]["httpStatus"], 500);
        let snapshot = call(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(snapshot["result"]["lastRound"]["causeKind"], "status");
        assert_eq!(snapshot["result"]["lastRound"]["httpStatus"], 500);
        assert_eq!(snapshot["result"]["host"]["connectivity"], "online");
        {
            let events = events.lock().unwrap();
            assert!(events.iter().any(|event| event["type"] == "progress"
                && event["progress"]["causeKind"] == "status"
                && event["progress"]["httpStatus"] == 500));
            assert!(events.iter().any(|event| event["type"] == "diagnostics"
                && event["snapshot"]["lastRound"]["httpStatus"] == 500));
            assert!(!format!("{events:?}").contains("private-response-secret"));
        }
        let recovered = call(json!({ "method": "sync", "params": {} }));
        assert_eq!(recovered["result"]["ok"], true);
        let snapshot = call(json!({ "method": "diagnosticsSnapshot", "params": {} }));
        assert_eq!(snapshot["result"]["lastRound"]["status"], "succeeded");
        assert!(snapshot["result"]["lastRound"].get("causeKind").is_none());
        assert!(snapshot["result"]["lastRound"].get("httpStatus").is_none());
        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
        server.join().unwrap();
    }

    /// A server that answers every pull with one new commit, so an until-idle
    /// drive never idles. It reports each request number on `rounds`.
    #[cfg(feature = "native-transport")]
    fn endless_commit_server() -> (
        std::net::SocketAddr,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        std::thread::JoinHandle<()>,
        std::sync::mpsc::Receiver<usize>,
    ) {
        use ssp2::model::{Change, Frame, Message, MsgKind, Op, OpResult, PushStatus};
        use ssp2::segment::{encode_row, Column, ColumnType, ColumnValue};
        use std::io::{ErrorKind, Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;

        let (rounds_tx, rounds) = std::sync::mpsc::channel();
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
                    log_epoch: "epoch".into(),
                    reset_required: reset,
                }];
                if !reset {
                    for frame in &request.frames {
                        if let Frame::PushCommit {
                            client_commit_id, ..
                        } = frame
                        {
                            frames.push(Frame::PushResult {
                                client_commit_id: client_commit_id.clone(),
                                status: PushStatus::Rejected,
                                commit_seq: None,
                                results: vec![OpResult::Error {
                                    op_index: 0,
                                    code: "app.rejected".into(),
                                    message: "rejected".into(),
                                    retryable: false,
                                }],
                            });
                        }
                    }
                }
                if !reset {
                    let mut row = ssp2::primitives::Writer::new();
                    encode_row(
                        &mut row,
                        &columns,
                        &vec![
                            Some(ColumnValue::String("one".into())),
                            Some(ColumnValue::String(format!("v{round}"))),
                        ],
                    );
                    let commit = Frame::Commit {
                        commit_seq: round as i64,
                        created_at_ms: 0,
                        actor_id: "actor".into(),
                        tables: vec!["todo".into()],
                        changes: vec![Change {
                            table_index: 0,
                            row_id: "one".into(),
                            op: Op::Upsert,
                            row_version: round as i64,
                            scopes: vec![("id".into(), "one".into())],
                            row: Some(row.into_bytes()),
                        }],
                    };
                    frames.extend(scripted_sections(&request, round as i64, vec![commit]));
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
                let _ = rounds_tx.send(round);
            }
        });
        (address, requests, stop, server, rounds)
    }

    #[cfg(feature = "native-transport")]
    #[test]
    fn owner_thread_sync_until_idle_reports_budget_exhaustion_with_the_report() {
        use std::sync::atomic::Ordering;
        use std::sync::mpsc::channel;

        let (address, requests, stop, server, _rounds) = endless_commit_server();

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
            "clientId": "budget-tauri", "transportGate": "open", "retainFailedCommits": true, "schema": { "version": 1, "tables": [{
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
            call(json!({ "method": "subscribe", "params": { "scopes": { "id": "one" } } }))
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
        for timeout in [json!(0), json!(-1), json!(1.5), json!("60000")] {
            let invalid =
                call(json!({ "method": "syncUntilIdle", "params": { "timeoutMs": timeout } }));
            assert_eq!(
                invalid["error"]["code"], "sync.invalid_request",
                "{invalid}"
            );
            assert_eq!(
                invalid["error"]["message"], "timeoutMs must be a positive integer",
                "{invalid}"
            );
        }
        assert_eq!(
            requests.load(Ordering::SeqCst),
            before,
            "an invalid timeoutMs performs no round"
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

        let mutated = call(json!({ "method": "mutate", "params": { "mutations": [{
            "op": "upsert", "table": "todo", "values": { "id": "one", "title": "mine" }
        }] } }));
        let id = mutated["result"]["clientCommitId"].as_str().unwrap();
        call(json!({ "method": "sync", "params": {} }));
        let outcome =
            call(json!({ "method": "commitDelivery", "params": { "clientCommitId": id } }));
        let before_proof = requests.load(Ordering::SeqCst);
        let proof = call(
            json!({ "method": "proveCurrentBase", "params": { "outcome": outcome["result"]["outcome"], "maxRounds": 1 } }),
        );
        assert_eq!(
            proof["result"],
            json!({ "proven": false, "reason": "budget_exhausted" }),
            "{proof}"
        );
        assert_eq!(requests.load(Ordering::SeqCst) - before_proof, 1);

        tx.send(Request::Shutdown).unwrap();
        owner.join().unwrap();
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
    }

    #[cfg(feature = "native-transport")]
    #[test]
    fn owner_thread_queues_the_next_host_drive_after_budget_exhaustion() {
        use std::sync::atomic::Ordering;
        use std::sync::mpsc::channel;

        let (address, _requests, stop, server, rounds) = endless_commit_server();
        let (tx, rx) = channel::<Request>();
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
                |_| {},
            )
        });
        let call = |command: Value| -> Value {
            let (reply, result) = channel();
            tx.send(Request::Command { command, reply }).unwrap();
            result.recv().unwrap()
        };
        let created = call(json!({ "method": "create", "params": {
            "clientId": "host-budget-tauri", "transportGate": "open", "schema": { "version": 1, "tables": [{
                "name": "todo", "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false }
                ],
                "scopes": [{ "pattern": "todo:{id}" }]
            }] }
        } }));
        assert!(created.get("error").is_none(), "{created}");
        // `create` starts the first host drive; the subscription arriving
        // during it leaves one coalesced intent for a second. The server
        // never idles, so each drive exhausts its 20-round budget, and round
        // 41 belongs to a drive no intent started.
        call(json!({ "method": "subscribe", "params": { "scopes": { "id": "one" } } }));
        for _ in 0..41 {
            rounds
                .recv_timeout(Duration::from_secs(10))
                .expect("the host drive continues after budget exhaustion");
        }

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
        let command = |value: Value| run_command(file_app.handle(), value).expect("command reply");
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
        let memory_command =
            |value: Value| run_command(memory_app.handle(), value).expect("command reply");
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
        let command = |value: Value| run_command(app.handle(), value).expect("command reply");
        let dedicated_snapshot = |sql: &str, owner: Option<Value>| {
            tauri::async_runtime::block_on(syncular_query_snapshot(
                app.handle().clone(),
                webview(app.handle(), "main"),
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
                    units: Vec::new(),
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
        let command = |value: Value| run_command(app.handle(), value).expect("command reply");
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
