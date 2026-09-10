//! Shared benchmark commands for the repository runner and external harness.
//! The binary owns shipping socket transport. The private cdylib supplies an
//! in-process callback transport for repository engine replay.
//!
//! JSON lines over stdio, one request per line — the SAME envelope the
//! conformance shim speaks (`{"id": n, "method": "...", "params": {...}}` →
//! `{"id": n, "result": ...}` | `{"id": n, "error": {"code","message"}}`,
//! bytes as `{"$bytes": hex}`) — but with the transport OWNED by this
//! process: the FFI crate's native HTTP+WS transport (ureq + tungstenite)
//! against a real running server, instead of the shim's host inversion.
//!
//! The command surface is the shared `syncular-command` router (create/
//! subscribe/mutate/sync/syncUntilIdle/readRows/query/uploadBlob/fetchBlob/
//! connectRealtime/…), plus bench-only commands:
//!
//! - `create` additionally takes `transport: {baseUrl, wsUrl?, headers?}` —
//!   the native transport config (an explicit full `wsUrl` with query params
//!   is honored verbatim).
//! - `waitForQuery {sql, params?, matchCount?: {op: "eq"|"gte", value},
//!   timeoutMs?, forceSyncIntervalMs?}`: an internal ~1ms poll loop — drain
//!   inbound realtime frames into the client, sync when `sync_needed` (or on
//!   the forced interval), run the local query, return as soon as the row
//!   count matches. Sub-ms propagation latency without stdio round-trips.
//! - `benchQuery {sql, params?, iterations?}`: per-iteration nanosecond
//!   timings measured inside this process (no stdio noise per iteration).
//! - `stats`: transport byte counters.
//! - `sleep {ms}` / `destroy` (drop the client + socket) / `close` (exit).

mod engine;

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::io::{BufRead, Write};
use std::ptr::NonNull;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use syncular_client::{
    BlobDownload, BlobUploadGrant, SegmentRequest, SyncClient, Transport, TransportError,
};
use syncular_command::{dispatch, CommandError, CreateEffects};
// The FFI crate's lib name is `syncular` (see crates/ffi/Cargo.toml [lib]).
use syncular::transport::{HostTransport, Inbound};

/// Benchmark host for the exported C ABI. Commands own their returned strings;
/// copy before release, parse the owned copy, and close the handle once on drop.
struct FfiClient {
    handle: NonNull<syncular::Handle>,
}

impl FfiClient {
    fn new(config: &Value) -> Result<Self, CommandError> {
        let config =
            CString::new(config.to_string()).map_err(|error| client_err(error.to_string()))?;
        let handle = NonNull::new(syncular::syncular_client_new(config.as_ptr()))
            .ok_or_else(|| client_err("FFI constructor returned null".to_owned()))?;
        Ok(Self { handle })
    }

    fn command(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<(Result<Value, CommandError>, Value), CommandError> {
        let started = Instant::now();
        let request = CString::new(json!({"method": method, "params": params}).to_string())
            .map_err(|error| client_err(error.to_string()))?;
        let serialize_ns = started.elapsed().as_nanos() as u64;
        let started = Instant::now();
        let response = NonNull::new(syncular::syncular_client_command(
            self.handle.as_ptr(),
            request.as_ptr(),
        ))
        .ok_or_else(|| client_err("FFI command returned null".to_owned()))?;
        let call_ns = started.elapsed().as_nanos() as u64;
        let started = Instant::now();
        // SAFETY: the live handle's command returned a library-owned, NUL-terminated
        // string. Copy it while it is live; no reference survives free_string.
        let bytes = unsafe { CStr::from_ptr(response.as_ptr()) }
            .to_bytes()
            .to_vec();
        let copy_ns = started.elapsed().as_nanos() as u64;
        let started = Instant::now();
        syncular::syncular_free_string(response.as_ptr());
        let free_ns = started.elapsed().as_nanos() as u64;
        let started = Instant::now();
        let mut envelope: Value =
            serde_json::from_slice(&bytes).map_err(|error| client_err(error.to_string()))?;
        let parse_ns = started.elapsed().as_nanos() as u64;
        let result = if let Some(error) = envelope.get_mut("error") {
            Err((
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .ok_or_else(|| client_err("FFI error has no code".to_owned()))?
                    .to_owned(),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| client_err("FFI error has no message".to_owned()))?
                    .to_owned(),
            ))
        } else {
            Ok(envelope
                .get_mut("result")
                .ok_or_else(|| client_err("FFI response has no result".to_owned()))?
                .take())
        };
        Ok((
            result,
            json!({"requestSerializeNs": serialize_ns, "callNs": call_ns,
            "responseCopyNs": copy_ns, "responseFreeNs": free_ns, "responseParseNs": parse_ns,
            "requestBytes": request.as_bytes_with_nul().len(), "responseBytes": bytes.len() + 1}),
        ))
    }

    fn handle(&mut self, method: &str, mut params: Value) -> Result<Value, CommandError> {
        if method == "stats"
            && (params.get("sqlCounts").is_some() || params.get("phases").is_some())
        {
            return Err((
                "bench.unsupported_capability".into(),
                "Internal counters require the direct or command driver".into(),
            ));
        }
        if method == "benchRead" {
            return bench_read(ReadClient::Ffi(self), &params);
        }
        let operation = match method {
            "benchBlob" => {
                let object = params
                    .as_object_mut()
                    .ok_or_else(|| client_err("FFI blob parameters are invalid".to_owned()))?;
                if object.remove("mode").as_ref().and_then(Value::as_str) != Some("ffi") {
                    return Err(client_err("FFI benchmark requires ffi mode".to_owned()));
                }
                object
                    .remove("operation")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .filter(|operation| operation == "uploadBlob" || operation == "fetchBlob")
                    .ok_or_else(|| client_err("FFI blob operation is invalid".to_owned()))?
            }
            "benchSync" => {
                if params.get("mode").and_then(Value::as_str) != Some("ffi") {
                    return Err(client_err("FFI benchmark requires ffi mode".to_owned()));
                }
                params = json!({"maxRounds": 10_100});
                "syncUntilIdle".to_owned()
            }
            "create" => {
                if let Some(object) = params.as_object_mut() {
                    object.remove("benchBoundary");
                    object.remove("transport");
                }
                method.to_owned()
            }
            _ => method.to_owned(),
        };
        let (result, timing) = self.command(&operation, &params)?;
        if method == "benchBlob" {
            Ok(match result {
                Ok(value) => json!({"value": value, "elapsedNs": timing["callNs"], "ffi": timing}),
                Err((code, message)) => json!({"error": {"code": code, "message": message},
                    "elapsedNs": timing["callNs"], "ffi": timing}),
            })
        } else if method == "benchSync" {
            Ok(json!({"outcome": result?, "elapsedNs": timing["callNs"], "ffi": timing}))
        } else {
            result
        }
    }
}

impl Drop for FfiClient {
    fn drop(&mut self) {
        syncular::syncular_client_close(self.handle.as_ptr());
    }
}

// -- counting transport -------------------------------------------------------

/// Byte/request counters over the wrapped native transport. WS counters are
/// split out: outbound frames (round requests, control sends) and inbound
/// frames (deltas, wakes) — inbound is counted at drain time in
/// [`BenchTransport::take_inbound`].
#[derive(Debug, Default)]
struct TransportStats {
    request_bytes: u64,
    response_bytes: u64,
    ws_in_bytes: u64,
    ws_out_bytes: u64,
    request_count: u64,
    pushes: Vec<Vec<(String, usize)>>,
    sync_ns: u64,
    apply_ns: u64,
    inbound_frames: u64,
    send_ns: u64,
    blob_requests: Vec<Value>,
}

trait BenchBackend: Transport {
    fn take_inbound(&mut self) -> Result<Vec<Inbound>, CommandError>;
    fn shutdown(&mut self);
    fn set_signed_urls(&mut self, enabled: bool) -> Result<(), CommandError>;
}

impl BenchBackend for HostTransport {
    fn take_inbound(&mut self) -> Result<Vec<Inbound>, CommandError> {
        Ok(HostTransport::take_inbound(self))
    }
    fn shutdown(&mut self) {
        HostTransport::shutdown(self);
    }
    fn set_signed_urls(&mut self, enabled: bool) -> Result<(), CommandError> {
        HostTransport::set_signed_urls(self, enabled);
        Ok(())
    }
}

struct BenchTransport {
    inner: Box<dyn BenchBackend>,
    blob_diagnostics: bool,
    stats: TransportStats,
    wait_for_inbound: Box<dyn FnMut(Duration) -> Result<(), CommandError>>,
    last_ack: i64,
}

impl BenchTransport {
    /// A no-network placeholder until `create` supplies the real config.
    fn null() -> Self {
        Self::from_config(&json!({})).expect("null transport")
    }

    fn from_config(config: &Value) -> Result<Self, String> {
        let (notify, notification) = mpsc::sync_channel(1);
        Ok(BenchTransport {
            inner: Box::new(HostTransport::from_config_with_notify(
                config,
                Some(Arc::new(move || {
                    let _ = notify.try_send(());
                })),
            )?),
            stats: TransportStats::default(),
            blob_diagnostics: true,
            wait_for_inbound: Box::new(move |remaining| {
                notification
                    .recv_timeout(remaining)
                    .map_err(|_| client_err("waitForAck deadline exceeded".to_owned()))
            }),
            last_ack: -1,
        })
    }

    fn take_inbound(&mut self) -> Result<Vec<Inbound>, CommandError> {
        let frames = self.inner.take_inbound()?;
        for frame in &frames {
            self.stats.ws_in_bytes += match frame {
                Inbound::Text(text) => text.len() as u64,
                Inbound::Binary(bytes) => bytes.len() as u64,
            };
        }
        Ok(frames)
    }

    fn shutdown(&mut self) {
        self.inner.shutdown();
    }

    fn stats_json(&self) -> Value {
        let mut value = json!({
            "blobDiagnostics": self.blob_diagnostics,
            "requestBytes": self.stats.request_bytes,
            "responseBytes": self.stats.response_bytes,
            "wsInBytes": self.stats.ws_in_bytes,
            "wsOutBytes": self.stats.ws_out_bytes,
            "requestCount": self.stats.request_count,
            "pushes": self.stats.pushes,
            "syncNs": self.stats.sync_ns,
            "applyNs": self.stats.apply_ns,
            "inboundFrames": self.stats.inbound_frames,
            "sendNs": self.stats.send_ns,
            "blobRequests": self.stats.blob_requests,
        });
        SQL_COUNTS.with(|counts| {
            if let Some(counts) = counts.borrow().as_ref() {
                value["sqliteCounts"] = json!({
                    "statements": counts.statements,
                    "commitHookCalls": counts.commits,
                    "rollbackHookCalls": counts.rollbacks,
                    "scope": "Connection executions since diagnostic enable/reset. Commit hooks run before commit and do not prove durability. Statement labels omit SQL text and values. No SQL timings are collected."
                });
            }
        });
        value
    }

    fn count_request(&mut self, bytes: u64) {
        self.stats.request_count += 1;
        self.stats.request_bytes += bytes;
    }

    fn record_pushes(&mut self, request: &[u8]) -> Result<(), TransportError> {
        let message = ssp2::decode_message(request)
            .map_err(|error| TransportError::new("bench.invalid_request", error.to_string()))?;
        let commits: Vec<_> = message
            .frames
            .into_iter()
            .filter_map(|frame| {
                if let ssp2::Frame::PushCommit {
                    client_commit_id,
                    operations,
                } = frame
                {
                    Some((client_commit_id, operations.len()))
                } else {
                    None
                }
            })
            .collect();
        if !commits.is_empty() {
            self.stats.pushes.push(commits);
        }
        Ok(())
    }
}

impl Transport for BenchTransport {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.record_pushes(request)?;
        self.count_request(request.len() as u64);
        let started = Instant::now();
        let response = self.inner.sync(request)?;
        self.stats.sync_ns += started.elapsed().as_nanos() as u64;
        self.stats.response_bytes += response.len() as u64;
        Ok(response)
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.record_pushes(request)?;
        // Rides the socket when connected (falls back to HTTP inside the
        // native transport when it is not); counted on the WS side either way
        // so socket rounds do not vanish from the totals.
        self.stats.ws_out_bytes += request.len() as u64;
        let started = Instant::now();
        let response = self.inner.realtime_sync(request)?;
        self.stats.sync_ns += started.elapsed().as_nanos() as u64;
        self.stats.ws_in_bytes += response.len() as u64;
        Ok(response)
    }

    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError> {
        self.count_request(0);
        let response = self.inner.download_segment(request)?;
        self.stats.response_bytes += response.len() as u64;
        Ok(response)
    }

    fn supports_url_fetch(&self) -> bool {
        self.inner.supports_url_fetch()
    }

    fn fetch_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        self.count_request(0);
        let response = self.inner.fetch_url(url)?;
        self.stats.response_bytes += response.len() as u64;
        Ok(response)
    }

    fn blob_upload(
        &mut self,
        blob_id: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        if !self.blob_diagnostics {
            return self.inner.blob_upload(blob_id, bytes, media_type);
        }
        self.count_request(bytes.len() as u64);
        let started = Instant::now();
        let result = self.inner.blob_upload(blob_id, bytes, media_type);
        self.stats.blob_requests.push(json!({"method": "upload", "blobId": blob_id,
            "elapsedNs": started.elapsed().as_nanos() as u64, "bytes": bytes.len(), "failed": result.is_err()}));
        result
    }

    fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
        if !self.blob_diagnostics {
            return self.inner.blob_download(blob_id);
        }
        self.count_request(0);
        let started = Instant::now();
        let result = self.inner.blob_download(blob_id);
        let elapsed_ns = started.elapsed().as_nanos() as u64;
        let bytes = match &result {
            Ok(BlobDownload::Bytes(bytes)) => bytes.len(),
            _ => 0,
        };
        self.stats.response_bytes += bytes as u64;
        self.stats
            .blob_requests
            .push(json!({"method": "download", "blobId": blob_id,
            "elapsedNs": elapsed_ns, "bytes": bytes, "failed": result.is_err()}));
        result
    }

    fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        if !self.blob_diagnostics {
            return self.inner.fetch_blob_url(url);
        }
        self.count_request(0);
        let started = Instant::now();
        let result = self.inner.fetch_blob_url(url);
        let elapsed_ns = started.elapsed().as_nanos() as u64;
        let bytes = result.as_ref().map_or(0, Vec::len);
        self.stats.response_bytes += bytes as u64;
        self.stats
            .blob_requests
            .push(json!({"method": "fetchUrl", "elapsedNs": elapsed_ns,
            "bytes": bytes, "failed": result.is_err()}));
        result
    }

    fn blob_upload_grant(
        &mut self,
        blob_id: &str,
        byte_length: u64,
        media_type: Option<&str>,
    ) -> Result<BlobUploadGrant, TransportError> {
        if !self.blob_diagnostics {
            return self
                .inner
                .blob_upload_grant(blob_id, byte_length, media_type);
        }
        self.count_request(0);
        let started = Instant::now();
        let result = self
            .inner
            .blob_upload_grant(blob_id, byte_length, media_type);
        self.stats.blob_requests.push(json!({"method": "uploadGrant", "blobId": blob_id,
            "elapsedNs": started.elapsed().as_nanos() as u64, "bytes": 0, "failed": result.is_err()}));
        result
    }

    fn blob_put_url(
        &mut self,
        url: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        if !self.blob_diagnostics {
            return self.inner.blob_put_url(url, bytes, media_type);
        }
        self.count_request(bytes.len() as u64);
        let started = Instant::now();
        let result = self.inner.blob_put_url(url, bytes, media_type);
        self.stats.blob_requests.push(json!({"method": "putUrl",
            "elapsedNs": started.elapsed().as_nanos() as u64,
            "bytes": bytes.len(), "failed": result.is_err()}));
        result
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        self.inner.realtime_connect()
    }

    fn realtime_connect_for_client(&mut self, client_id: &str) -> Result<(), TransportError> {
        self.inner.realtime_connect_for_client(client_id)
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.stats.ws_out_bytes += text.len() as u64;
        let started = Instant::now();
        self.inner.realtime_send(text)?;
        self.stats.send_ns += started.elapsed().as_nanos() as u64;
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            if value.get("type").and_then(Value::as_str) == Some("ack") {
                if let Some(cursor) = value.get("cursor").and_then(Value::as_i64) {
                    self.last_ack = self.last_ack.max(cursor);
                }
            }
        }
        Ok(())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        self.inner.realtime_close()
    }
}

// -- driver host ---------------------------------------------------------------

fn client_err(message: String) -> CommandError {
    ("client.failed".to_owned(), message)
}

fn need_client(client: &mut Option<SyncClient>) -> Result<&mut SyncClient, CommandError> {
    client
        .as_mut()
        .ok_or_else(|| client_err("no client instance created".to_owned()))
}

/// Feed buffered inbound WS frames (deltas, wakes, presence) to the client.
fn drain_inbound(
    transport: &mut BenchTransport,
    client: &mut Option<SyncClient>,
) -> Result<(), CommandError> {
    let frames = transport.take_inbound()?;
    let Some(instance) = client.as_mut() else {
        return Ok(());
    };
    for frame in frames {
        transport.stats.inbound_frames += 1;
        let started = Instant::now();
        match frame {
            Inbound::Text(text) => instance.on_realtime_text(&text),
            Inbound::Binary(bytes) => instance.on_realtime_binary(transport, &bytes),
        }
        transport.stats.apply_ns += started.elapsed().as_nanos() as u64;
    }
    Ok(())
}

fn parse_bind(params: &Value) -> Result<Vec<Value>, CommandError> {
    match params.get("params") {
        Some(Value::Array(list)) => Ok(list.clone()),
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => Err(client_err("query params must be a list".to_owned())),
    }
}

/// `matchCount` predicate over a result-row count: `{op: "eq"|"gte", value}`;
/// absent ⇒ non-empty (`gte 1`).
fn parse_match_count(params: &Value) -> Result<(String, usize), CommandError> {
    let Some(spec) = params.get("matchCount") else {
        return Ok(("gte".to_owned(), 1));
    };
    let op = spec
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("gte")
        .to_owned();
    if op != "eq" && op != "gte" {
        return Err(client_err(format!("unknown matchCount op {op:?}")));
    }
    let value = spec
        .get("value")
        .and_then(Value::as_u64)
        .ok_or_else(|| client_err("matchCount missing value".to_owned()))?;
    Ok((op, value as usize))
}

fn wait_for_query(
    transport: &mut BenchTransport,
    client: &mut Option<SyncClient>,
    params: &Value,
) -> Result<Value, CommandError> {
    let sql = params
        .get("sql")
        .and_then(Value::as_str)
        .ok_or_else(|| client_err("waitForQuery missing sql".to_owned()))?
        .to_owned();
    let bind = parse_bind(params)?;
    let (op, target) = parse_match_count(params)?;
    let timeout = Duration::from_millis(
        params
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(30_000),
    );
    // Optional poll-driven syncing for flows with no realtime wake (or where
    // the wake itself is what got revoked): force a sync round every N ms
    // even while `sync_needed` stays false.
    let force_every = params
        .get("forceSyncIntervalMs")
        .and_then(Value::as_u64)
        .map(Duration::from_millis);
    let started = Instant::now();
    // First forced round fires immediately.
    let mut last_forced: Option<Instant> = None;
    loop {
        drain_inbound(transport, client)?;
        let instance = need_client(client)?;
        if instance.sync_needed() {
            let _ = instance.sync(transport);
        } else if let Some(interval) = force_every {
            let due = last_forced.is_none_or(|at| at.elapsed() >= interval);
            if due {
                let _ = instance.sync(transport);
                last_forced = Some(Instant::now());
            }
        }
        let rows = instance.query(&sql, &bind).map_err(client_err)?;
        let count = rows.len();
        let matched = match op.as_str() {
            "eq" => count == target,
            _ => count >= target,
        };
        let waited_ms = started.elapsed().as_secs_f64() * 1_000.0;
        if matched {
            return Ok(json!({ "ok": true, "waitedMs": waited_ms, "rows": rows }));
        }
        if started.elapsed() >= timeout {
            return Ok(json!({ "ok": false, "waitedMs": waited_ms, "rows": rows }));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn bench_query(client: &mut Option<SyncClient>, params: &Value) -> Result<Value, CommandError> {
    let sql = params
        .get("sql")
        .and_then(Value::as_str)
        .ok_or_else(|| client_err("benchQuery missing sql".to_owned()))?
        .to_owned();
    let bind = parse_bind(params)?;
    let iterations = params
        .get("iterations")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .max(1);
    let instance = need_client(client)?;
    let mut ns_per_iteration = Vec::with_capacity(iterations as usize);
    let mut row_count = 0usize;
    for _ in 0..iterations {
        let started = Instant::now();
        let rows = instance.query(&sql, &bind).map_err(client_err)?;
        ns_per_iteration.push(started.elapsed().as_nanos() as u64);
        row_count = rows.len();
    }
    Ok(json!({
        "iterations": iterations,
        "nsPerIteration": ns_per_iteration,
        "rowCount": row_count,
    }))
}

thread_local! {
    static READ_STATEMENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    // Enabled only by the stdio driver, which owns one client on this thread.
    static SQL_COUNTS: RefCell<Option<SqlCounts>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct SqlCounts {
    statements: std::collections::BTreeMap<&'static str, u64>,
    commits: u64,
    rollbacks: u64,
}

fn set_sql_counts(connection: &mut rusqlite::Connection, enabled: bool) {
    SQL_COUNTS.with(|counts| *counts.borrow_mut() = enabled.then(SqlCounts::default));
    if enabled {
        connection.trace(Some(|sql| {
            let verb = sql
                .trim_start()
                .split(|character: char| !character.is_ascii_alphabetic())
                .next()
                .unwrap_or("");
            let label = [
                "SELECT",
                "INSERT",
                "UPDATE",
                "DELETE",
                "SAVEPOINT",
                "RELEASE",
                "BEGIN",
                "COMMIT",
                "ROLLBACK",
                "PRAGMA",
            ]
            .into_iter()
            .find(|candidate| verb.eq_ignore_ascii_case(candidate))
            .unwrap_or("OTHER");
            SQL_COUNTS.with(|counts| {
                if let Some(counts) = counts.borrow_mut().as_mut() {
                    *counts.statements.entry(label).or_default() += 1;
                }
            });
        }));
        connection.commit_hook(Some(|| {
            SQL_COUNTS.with(|counts| {
                if let Some(counts) = counts.borrow_mut().as_mut() {
                    counts.commits += 1;
                }
            });
            false
        }));
        connection.rollback_hook(Some(|| {
            SQL_COUNTS.with(|counts| {
                if let Some(counts) = counts.borrow_mut().as_mut() {
                    counts.rollbacks += 1;
                }
            });
        }));
    } else {
        connection.trace(None);
        connection.commit_hook(None::<fn() -> bool>);
        connection.rollback_hook(None::<fn()>);
    }
}

// Raw baseline for the fixed read fixture, including dynamic row materialization.
// It shares the client's connection while bypassing the public query guard.
fn read_database(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<serde_json::Map<String, Value>>, CommandError> {
    let bind = params
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| client_err("Read fixture expects string parameters".to_owned()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(sql).map_err(|e| client_err(e.to_string()))?;
    if !stmt.readonly() {
        return Err(client_err("Read fixture requires read-only SQL".to_owned()));
    }
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(bind))
        .map_err(|e| client_err(e.to_string()))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| client_err(e.to_string()))? {
        let mut values = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index).map_err(|e| client_err(e.to_string()))? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(value)
                    if value.unsigned_abs() <= 9_007_199_254_740_991 =>
                {
                    Value::from(value)
                }
                rusqlite::types::ValueRef::Real(value) => {
                    Value::Number(serde_json::Number::from_f64(value).ok_or_else(|| {
                        client_err("Read fixture has non-finite numbers".to_owned())
                    })?)
                }
                rusqlite::types::ValueRef::Text(value) => Value::from(
                    std::str::from_utf8(value)
                        .map_err(|e| client_err(e.to_string()))?
                        .to_owned(),
                ),
                _ => {
                    return Err(client_err(
                        "Read fixture has unsupported cell types".to_owned(),
                    ))
                }
            };
            values.insert(name.clone(), value);
        }
        result.push(values);
    }
    Ok(result)
}

enum ReadClient<'a> {
    Direct {
        transport: &'a mut BenchTransport,
        client: &'a mut Option<SyncClient>,
        effects: &'a mut CreateEffects,
    },
    Ffi(&'a mut FfiClient),
}

impl ReadClient<'_> {
    fn instance(&mut self) -> Result<&mut SyncClient, CommandError> {
        match self {
            Self::Direct { client, .. } => need_client(client),
            Self::Ffi(ffi) => {
                // SAFETY: this driver owns the live handle and invokes commands
                // sequentially. The borrow ends before any exported C call.
                unsafe { ffi.handle.as_mut() }
                    .benchmark_client()
                    .ok_or_else(|| client_err("FFI read client is not created".to_owned()))
            }
        }
    }

    fn command(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<(Value, Option<Value>), CommandError> {
        match self {
            Self::Direct {
                transport,
                client,
                effects,
            } => dispatch(*transport, client, effects, method, params).map(|value| (value, None)),
            Self::Ffi(ffi) => {
                let (result, timing) = ffi.command(method, params)?;
                result.map(|value| (value, Some(timing)))
            }
        }
    }
}

fn bench_read(mut client: ReadClient<'_>, params: &Value) -> Result<Value, CommandError> {
    let mode = params.get("mode").and_then(Value::as_str).unwrap_or("");
    if !matches!(mode, "direct" | "command" | "ffi")
        || (mode == "ffi") != matches!(client, ReadClient::Ffi(_))
    {
        return Err(client_err(
            "Read benchmark mode differs from its client boundary".to_owned(),
        ));
    }
    let iterations = params
        .get("iterations")
        .and_then(Value::as_u64)
        .filter(|value| (1..=100).contains(value))
        .ok_or_else(|| client_err("Read iterations must be in 1..100".to_owned()))?
        as usize;
    let queries = params
        .get("queries")
        .and_then(Value::as_array)
        .filter(|queries| queries.len() == 2)
        .ok_or_else(|| client_err("Read fixture requires two queries".to_owned()))?;
    let revision = client.instance()?.local_revision().to_string();
    let mut results = Vec::new();
    for query in queries {
        let sql = query
            .get("sql")
            .and_then(Value::as_str)
            .ok_or_else(|| client_err("Read fixture SQL missing".to_owned()))?;
        let inputs = query
            .get("inputs")
            .and_then(Value::as_array)
            .filter(|inputs| inputs.len() == iterations + 3)
            .ok_or_else(|| {
                client_err("Read fixture input count differs from iterations".to_owned())
            })?;
        let mut samples = serde_json::Map::new();
        let mut work = serde_json::Map::new();
        let mut ffi_samples = serde_json::Map::new();
        if mode == "ffi" {
            for surface in ["query", "snapshot"] {
                ffi_samples.insert(surface.to_owned(), Value::Array(Vec::new()));
            }
        }
        for surface in ["database", "query", "snapshot"] {
            samples.insert(surface.to_owned(), Value::Array(Vec::new()));
        }
        for iteration in 0..=inputs.len() {
            let counter_pass = iteration == inputs.len();
            let input = &inputs[if counter_pass { 0 } else { iteration }];
            let bind = input
                .get("params")
                .and_then(Value::as_array)
                .ok_or_else(|| client_err("Read fixture parameters missing".to_owned()))?;
            let expected = input
                .get("rows")
                .and_then(Value::as_array)
                .ok_or_else(|| client_err("Read fixture expected rows missing".to_owned()))?;
            for offset in 0..3 {
                let surface = ["database", "query", "snapshot"][(iteration + offset) % 3];
                let command_params = json!({"sql": sql, "params": bind});
                if counter_pass {
                    READ_STATEMENTS.with(|statements| statements.borrow_mut().clear());
                    client.instance()?.benchmark_connection().trace(Some(|sql| {
                        READ_STATEMENTS
                            .with(|statements| statements.borrow_mut().push(sql.to_owned()));
                    }));
                }
                let started = Instant::now();
                let measured = if surface == "database" || (mode == "direct" && surface == "query")
                {
                    let rows = if surface == "database" {
                        read_database(client.instance()?.benchmark_connection(), sql, bind)
                    } else {
                        client.instance()?.query(sql, bind).map_err(client_err)
                    };
                    let elapsed = started.elapsed().as_nanos() as u64;
                    rows.map(|rows| {
                        (
                            elapsed,
                            Value::Object(serde_json::Map::from_iter([(
                                "rows".to_owned(),
                                Value::Array(rows.into_iter().map(Value::Object).collect()),
                            )])),
                            None,
                        )
                    })
                } else if mode == "direct" {
                    let snapshot = client
                        .instance()?
                        .query_snapshot(sql, bind, &[])
                        .map_err(client_err);
                    let elapsed = started.elapsed().as_nanos() as u64;
                    snapshot.and_then(|snapshot| {
                        serde_json::to_value(snapshot)
                            .map(|value| (elapsed, value, None))
                            .map_err(|e| client_err(e.to_string()))
                    })
                } else {
                    let result = client.command(
                        if surface == "snapshot" {
                            "querySnapshot"
                        } else {
                            "query"
                        },
                        &command_params,
                    );
                    let elapsed = started.elapsed().as_nanos() as u64;
                    result.map(|(value, timing)| {
                        let elapsed = timing
                            .as_ref()
                            .map_or(elapsed, |timing| timing["callNs"].as_u64().unwrap());
                        (elapsed, value, timing)
                    })
                };
                if counter_pass {
                    client.instance()?.benchmark_connection().trace(None);
                    let statements = READ_STATEMENTS
                        .with(|statements| std::mem::take(&mut *statements.borrow_mut()));
                    if statements.is_empty()
                        || statements.len()
                            > (if surface == "snapshot" { 4 } else { 1 })
                                + if mode == "ffi" && surface != "database" {
                                    5
                                } else {
                                    0
                                }
                    {
                        return Err(client_err("Read statement budget exceeded".to_owned()));
                    }
                    work.insert(surface.to_owned(), json!({"statements": statements}));
                }
                let (elapsed, result, timing) = measured?;
                if result.get("rows").and_then(Value::as_array) != Some(expected) {
                    return Err(client_err(
                        "Read result differs from generated fixture".to_owned(),
                    ));
                }
                if surface == "snapshot"
                    && (result.get("revision").and_then(Value::as_str) != Some(&revision)
                        || result
                            .pointer("/coverage/complete")
                            .and_then(Value::as_bool)
                            != Some(true))
                {
                    return Err(client_err(
                        "Read snapshot changed revision or coverage".to_owned(),
                    ));
                }
                if iteration >= 3 && !counter_pass {
                    if let Some(timing) = timing {
                        ffi_samples
                            .get_mut(surface)
                            .and_then(Value::as_array_mut)
                            .unwrap()
                            .push(timing);
                    }
                    samples
                        .get_mut(surface)
                        .and_then(Value::as_array_mut)
                        .unwrap()
                        .push(Value::from(elapsed));
                }
            }
        }
        let plan = read_database(
            client.instance()?.benchmark_connection(),
            &format!("EXPLAIN QUERY PLAN {sql}"),
            inputs[0]["params"].as_array().unwrap(),
        )?;
        let mut result = json!({"name": query.get("name"), "sql": sql, "samplesNs": samples, "work": work, "plan": plan});
        if mode == "ffi" {
            result["ffi"] = Value::Object(ffi_samples);
        }
        results.push(result);
    }
    if client.instance()?.local_revision().to_string() != revision {
        return Err(client_err(
            "Read benchmark changed local revision".to_owned(),
        ));
    }
    let conn = client.instance()?.benchmark_connection();
    let schema = read_database(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name", &[])?;
    let sqlite = read_database(conn, "SELECT sqlite_version() AS version", &[])?;
    Ok(
        json!({"iterations": iterations, "warmups": 3, "revision": revision, "queries": results, "schema": schema, "sqlite": sqlite}),
    )
}

fn handle(
    transport: &mut BenchTransport,
    client: &mut Option<SyncClient>,
    effects: &mut CreateEffects,
    method: &str,
    params: &Value,
) -> Result<Value, CommandError> {
    match method {
        "create" => {
            if SQL_COUNTS.with(|counts| counts.borrow().is_some()) {
                return Err((
                    "bench.incompatible_diagnostic".into(),
                    "Disable SQL counters before replacing the client".into(),
                ));
            }
            // Bench extension: the transport config rides the create params
            // (the shim has no transport to configure; a native app passes it
            // to the FFI constructor). Replace the placeholder before the
            // shared router installs the client.
            if let Some(config) = params.get("transport") {
                transport.shutdown();
                *transport = BenchTransport::from_config(config).map_err(client_err)?;
            }
            transport.blob_diagnostics = match params.get("blobDiagnostics") {
                None => true,
                Some(Value::Bool(enabled)) => *enabled,
                _ => return Err(client_err("Blob diagnostics must be boolean".to_owned())),
            };
            let result = dispatch(transport, client, effects, method, params)?;
            transport.inner.set_signed_urls(effects.signed_urls)?;
            Ok(result)
        }
        "waitForQuery" => wait_for_query(transport, client, params),
        "benchQuery" => bench_query(client, params),
        "benchRead" if SQL_COUNTS.with(|counts| counts.borrow().is_some()) => Err((
            "bench.incompatible_diagnostic".into(),
            "Read diagnostics require SQL counters disabled".into(),
        )),
        "benchRead" => bench_read(
            ReadClient::Direct {
                transport,
                client,
                effects,
            },
            params,
        ),
        "benchMutate" => {
            let commits = params
                .get("commits")
                .and_then(Value::as_array)
                .filter(|commits| !commits.is_empty() && commits.len() <= 10_000)
                .ok_or_else(|| client_err("benchMutate requires 1..=10000 commits".to_owned()))?;
            let mode = params.get("mode").and_then(Value::as_str);
            let mut ids = Vec::with_capacity(commits.len());
            let mut durations = Vec::with_capacity(commits.len());
            match mode {
                Some("direct") => {
                    let parsed = commits
                        .iter()
                        .map(|commit| syncular_command::parse_mutations(commit.get("mutations")))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(client_err)?;
                    let instance = need_client(client)?;
                    for mutations in parsed {
                        let started = Instant::now();
                        let id = instance.mutate(mutations).map_err(client_err)?;
                        durations.push(started.elapsed().as_nanos() as u64);
                        ids.push(id);
                    }
                }
                Some("command") => {
                    for commit in commits {
                        let started = Instant::now();
                        let result = dispatch(transport, client, effects, "mutate", commit)?;
                        durations.push(started.elapsed().as_nanos() as u64);
                        ids.push(
                            result
                                .get("clientCommitId")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    client_err("mutate returned no commit identity".to_owned())
                                })?
                                .to_owned(),
                        );
                    }
                }
                _ => {
                    return Err(client_err(
                        "benchMutate mode must be direct or command".to_owned(),
                    ))
                }
            }
            Ok(json!({ "ids": ids, "nsPerCommit": durations }))
        }
        "benchBlobFile" => {
            if params.get("mode").and_then(Value::as_str) != Some("direct") {
                return Err(client_err(
                    "Blob file measurement requires direct boundary".to_owned(),
                ));
            }
            let operation = params
                .get("operation")
                .and_then(Value::as_str)
                .filter(|operation| matches!(*operation, "uploadBlob" | "fetchBlob"))
                .ok_or_else(|| client_err("Invalid blob file operation".to_owned()))?;
            let (reference, elapsed_ns, source_read_ns, validation_ns, byte_length, sha256) =
                if operation == "uploadBlob" {
                    let path = params
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| client_err("Missing blob fixture path".to_owned()))?;
                    let source_started = Instant::now();
                    let bytes =
                        std::fs::read(path).map_err(|error| client_err(error.to_string()))?;
                    let source_read_ns = source_started.elapsed().as_nanos() as u64;
                    let started = Instant::now();
                    let reference = need_client(client)?
                        .upload_blob(&bytes, Some("application/octet-stream".to_owned()), None)
                        .map_err(client_err)?;
                    let elapsed_ns = started.elapsed().as_nanos() as u64;
                    let validation_started = Instant::now();
                    let sha256 = format!("{:x}", Sha256::digest(&bytes));
                    (
                        reference,
                        elapsed_ns,
                        Some(source_read_ns),
                        validation_started.elapsed().as_nanos() as u64,
                        bytes.len(),
                        sha256,
                    )
                } else {
                    let blob = params
                        .get("blob")
                        .and_then(Value::as_str)
                        .ok_or_else(|| client_err("Missing blob reference".to_owned()))?;
                    let started = Instant::now();
                    let mut value = need_client(client)?.fetch_blob(transport, blob)?;
                    let elapsed_ns = started.elapsed().as_nanos() as u64;
                    let validation_started = Instant::now();
                    let object = value
                        .as_object_mut()
                        .ok_or_else(|| client_err("Invalid blob result".to_owned()))?;
                    let encoded = object
                        .remove("bytes")
                        .ok_or_else(|| client_err("Missing blob bytes".to_owned()))?;
                    let hex = encoded
                        .get("$bytes")
                        .and_then(Value::as_str)
                        .filter(|hex| hex.len() % 2 == 0 && hex.is_ascii())
                        .ok_or_else(|| client_err("Invalid blob byte encoding".to_owned()))?;
                    let mut hasher = Sha256::new();
                    // Decode only bounded pieces after the public API clock. The full
                    // hex result remains an explicit cost of the shipping legacy API.
                    for chunk in hex.as_bytes().chunks(128 * 1024) {
                        let text = std::str::from_utf8(chunk)
                            .map_err(|error| client_err(error.to_string()))?;
                        let bytes = syncular_command::value_bytes(Some(&json!({"$bytes": text})))
                            .map_err(client_err)?;
                        hasher.update(bytes);
                    }
                    let byte_length = hex.len() / 2;
                    let sha256 = format!("{:x}", hasher.finalize());
                    (
                        value,
                        elapsed_ns,
                        None,
                        validation_started.elapsed().as_nanos() as u64,
                        byte_length,
                        sha256,
                    )
                };
            if reference.get("blobId").and_then(Value::as_str)
                != Some(format!("sha256:{sha256}").as_str())
                || reference.get("byteLength").and_then(Value::as_u64) != Some(byte_length as u64)
            {
                return Err(client_err(
                    "Blob result differs from complete bytes".to_owned(),
                ));
            }
            let mut result = json!({"ref": reference, "elapsedNs": elapsed_ns,
                "validation": {"byteLength": byte_length, "sha256": sha256},
                "validationNs": validation_ns, "stats": transport.stats_json()});
            if let Some(source_read_ns) = source_read_ns {
                result["sourceReadNs"] = json!(source_read_ns);
            }
            Ok(result)
        }
        "benchBlob" => {
            let operation = params
                .get("operation")
                .and_then(Value::as_str)
                .filter(|operation| *operation == "uploadBlob" || *operation == "fetchBlob")
                .ok_or_else(|| {
                    client_err("benchBlob requires uploadBlob or fetchBlob".to_owned())
                })?;
            let mode = params
                .get("mode")
                .and_then(Value::as_str)
                .filter(|mode| *mode == "direct" || *mode == "command")
                .ok_or_else(|| {
                    client_err("benchBlob requires direct or command mode".to_owned())
                })?;
            // Direct operation excludes the command's byte-envelope decoding.
            let bytes = if operation == "uploadBlob" && mode == "direct" {
                Some(syncular_command::value_bytes(params.get("bytes")).map_err(client_err)?)
            } else {
                None
            };
            let (result, elapsed_ns) = if mode == "command" {
                let started = Instant::now();
                let result = dispatch(transport, client, effects, operation, params);
                (result, started.elapsed().as_nanos() as u64)
            } else if let Some(bytes) = bytes {
                let media_type = params
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let instance = need_client(client)?;
                let started = Instant::now();
                let result = instance.upload_blob(&bytes, media_type, None);
                let elapsed_ns = started.elapsed().as_nanos() as u64;
                (
                    result
                        .map(|reference| json!({"ref": reference}))
                        .map_err(client_err),
                    elapsed_ns,
                )
            } else {
                let blob = params
                    .get("blob")
                    .and_then(Value::as_str)
                    .ok_or_else(|| client_err("benchBlob fetch requires blob".to_owned()))?;
                let instance = need_client(client)?;
                let started = Instant::now();
                let result = instance.fetch_blob(transport, blob);
                let elapsed_ns = started.elapsed().as_nanos() as u64;
                (result.map(|blob| json!({"blob": blob})), elapsed_ns)
            };
            // Failed downloads retain timing and transport evidence for the fault fixture.
            Ok(match result {
                Ok(value) => {
                    json!({"value": value, "elapsedNs": elapsed_ns, "stats": transport.stats_json()})
                }
                Err((code, message)) => json!({"error": {"code": code, "message": message},
                    "elapsedNs": elapsed_ns, "stats": transport.stats_json()}),
            })
        }
        "benchSync" => {
            let started = Instant::now();
            let (outcome, elapsed_ns) = match params.get("mode").and_then(Value::as_str) {
                Some("direct") => {
                    let outcome = need_client(client)?.sync_until_idle(transport, Some(10_100));
                    let elapsed = started.elapsed().as_nanos() as u64;
                    (outcome.to_json(), elapsed)
                }
                Some("command") => {
                    let outcome = dispatch(
                        transport,
                        client,
                        effects,
                        "syncUntilIdle",
                        &json!({"maxRounds": 10_100}),
                    )?;
                    (outcome, started.elapsed().as_nanos() as u64)
                }
                _ => {
                    return Err(client_err(
                        "benchSync mode must be direct or command".to_owned(),
                    ))
                }
            };
            Ok(
                json!({ "outcome": outcome, "elapsedNs": elapsed_ns, "stats": transport.stats_json() }),
            )
        }
        "waitForAck" => {
            let cursor = params
                .get("cursor")
                .and_then(Value::as_i64)
                .filter(|cursor| *cursor >= 0)
                .ok_or_else(|| client_err("waitForAck requires a nonnegative cursor".to_owned()))?;
            let started = Instant::now();
            let timeout = Duration::from_secs(120);
            let mut wakeups = 0;
            loop {
                drain_inbound(transport, client)?;
                let instance = need_client(client)?;
                if instance.status_snapshot().sync_needed {
                    let outcome = instance.sync_until_idle(transport, Some(10_100));
                    if let syncular_client::SyncOutcome::Failed {
                        error_code,
                        message,
                    } = outcome
                    {
                        return Err((error_code, message));
                    }
                }
                if transport.last_ack >= cursor {
                    break;
                }
                let remaining = timeout
                    .checked_sub(started.elapsed())
                    .ok_or_else(|| client_err("waitForAck deadline exceeded".to_owned()))?;
                (transport.wait_for_inbound)(remaining)?;
                wakeups += 1;
            }
            Ok(
                json!({ "cursor": transport.last_ack, "elapsedNs": started.elapsed().as_nanos() as u64,
                "wakeups": wakeups, "stats": transport.stats_json() }),
            )
        }
        "benchBytes" => {
            let byte_length = params
                .get("byteLength")
                .and_then(Value::as_u64)
                .filter(|size| *size > 0 && *size <= 16 * 1024 * 1024)
                .ok_or_else(|| {
                    client_err("benchBytes requires byteLength in 1..=16777216".to_owned())
                })? as usize;
            let iterations = params
                .get("iterations")
                .and_then(Value::as_u64)
                .filter(|count| *count > 0 && *count <= 100)
                .ok_or_else(|| {
                    client_err("benchBytes requires iterations in 1..=100".to_owned())
                })?;
            let bytes: Vec<u8> = (0..byte_length).map(|index| index as u8).collect();
            let mut encode_ns = Vec::new();
            let mut serialize_ns = Vec::new();
            let mut parse_ns = Vec::new();
            let mut decode_ns = Vec::new();
            let mut serialized_bytes = 0;
            for iteration in 0..iterations + 3 {
                let started = Instant::now();
                let value = syncular_command::bytes_value(std::hint::black_box(&bytes));
                let encoded = started.elapsed().as_nanos() as u64;
                let started = Instant::now();
                let json =
                    serde_json::to_vec(&value).map_err(|error| client_err(error.to_string()))?;
                let serialized = started.elapsed().as_nanos() as u64;
                let started = Instant::now();
                let parsed: Value = serde_json::from_slice(std::hint::black_box(&json))
                    .map_err(|error| client_err(error.to_string()))?;
                let parsed_ns = started.elapsed().as_nanos() as u64;
                let started = Instant::now();
                let decoded = syncular_command::value_bytes(Some(&parsed)).map_err(client_err)?;
                let decoded_ns = started.elapsed().as_nanos() as u64;
                if decoded != bytes {
                    return Err(client_err("benchBytes round trip mismatch".to_owned()));
                }
                serialized_bytes = json.len();
                if iteration >= 3 {
                    encode_ns.push(encoded);
                    serialize_ns.push(serialized);
                    parse_ns.push(parsed_ns);
                    decode_ns.push(decoded_ns);
                }
            }
            Ok(json!({
                "byteLength": byte_length,
                "iterations": iterations,
                "warmups": 3,
                "encodeNs": encode_ns,
                "serializeNs": serialize_ns,
                "parseNs": parse_ns,
                "decodeNs": decode_ns,
                "serializedBytes": serialized_bytes,
                "validation": "exact-byte-roundtrip",
            }))
        }
        "stats" => {
            let phases = params
                .get("phases")
                .map(|value| {
                    value.as_bool().ok_or_else(|| {
                        (
                            "bench.invalid_request".to_owned(),
                            "Phase counters require a boolean".to_owned(),
                        )
                    })
                })
                .transpose()?;
            if let Some(enabled) = params.get("sqlCounts") {
                let enabled = enabled.as_bool().ok_or_else(|| {
                    (
                        "bench.invalid_request".to_owned(),
                        "SQL counters require a boolean".to_owned(),
                    )
                })?;
                set_sql_counts(need_client(client)?.benchmark_connection(), enabled);
            }
            if params.get("reset").and_then(Value::as_bool) == Some(true) {
                transport.stats = TransportStats::default();
                SQL_COUNTS.with(|counts| {
                    let mut counts = counts.borrow_mut();
                    if counts.is_some() {
                        *counts = Some(SqlCounts::default());
                    }
                });
            }
            let mut result = transport.stats_json();
            if let Some(client) = client.as_ref() {
                if let Some(phases) = client
                    .benchmark_phases(
                        phases,
                        params.get("reset").and_then(Value::as_bool) == Some(true),
                    )
                    .map_err(|message| ("bench.clock_unavailable".to_owned(), message))?
                {
                    result["phases"] = phases;
                }
            } else if phases.is_some() {
                return Err(client_err("Phase counters require a client".to_owned()));
            }
            Ok(result)
        }
        "sleep" => {
            let ms = params.get("ms").and_then(Value::as_u64).unwrap_or(0);
            std::thread::sleep(Duration::from_millis(ms));
            Ok(json!({}))
        }
        "destroy" => {
            if let Some(client) = client.as_mut() {
                set_sql_counts(client.benchmark_connection(), false);
            }
            *client = None;
            transport.shutdown();
            Ok(json!({}))
        }
        _ => dispatch(transport, client, effects, method, params),
    }
}

pub fn run_stdio() {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut client: Option<SyncClient> = None;
    let mut ffi: Option<FfiClient> = None;
    let mut transport = BenchTransport::null();
    let mut effects = CreateEffects::default();
    let mut line = String::new();

    let respond = |id: &Value, result: Result<Value, CommandError>| {
        let reply = match result {
            Ok(value) => json!({ "id": id, "result": value }),
            Err((code, message)) => {
                json!({ "id": id, "error": { "code": code, "message": message } })
            }
        };
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{reply}");
        let _ = handle.flush();
    };

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF: the harness is gone
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = value
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        if method == "close" {
            respond(&id, Ok(json!({})));
            break;
        }
        let result = if let Some(ffi) = ffi.as_mut() {
            ffi.handle(&method, params)
        } else if method == "create"
            && params.get("benchBoundary").and_then(Value::as_str) == Some("ffi")
        {
            if client.is_some() {
                Err(client_err(
                    "Benchmark boundary cannot change after create".to_owned(),
                ))
            } else {
                FfiClient::new(params.get("transport").unwrap_or(&Value::Null)).and_then(
                    |mut instance| {
                        let result = instance.handle("create", params)?;
                        ffi = Some(instance);
                        Ok(result)
                    },
                )
            }
        } else {
            handle(&mut transport, &mut client, &mut effects, &method, &params)
        };
        // Deliver any realtime traffic buffered while the command ran.
        let drained = drain_inbound(&mut transport, &mut client);
        respond(&id, result.and_then(|value| drained.map(|()| value)));
    }
    if let Some(client) = client.as_mut() {
        set_sql_counts(client.benchmark_connection(), false);
    }
    transport.shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_counts_track_outer_commits_and_rollback_without_retaining_values() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE entries (value TEXT)")
            .unwrap();
        let transport = BenchTransport::null();
        assert!(transport.stats_json().get("sqliteCounts").is_none());
        set_sql_counts(&mut connection, true);
        connection.execute_batch("BEGIN; INSERT INTO entries VALUES ('first'); SAVEPOINT inner; INSERT INTO entries VALUES ('second'); RELEASE inner; COMMIT;
            SAVEPOINT outside; INSERT INTO entries VALUES ('third'); RELEASE outside;
            BEGIN; INSERT INTO entries VALUES ('rolled back'); ROLLBACK;
            BEGIN; SELECT * FROM entries; COMMIT;").unwrap();
        connection
            .execute("INSERT INTO entries VALUES (?)", ["secret-bound-value"])
            .unwrap();
        let counts = transport.stats_json();
        assert_eq!(
            counts["sqliteCounts"]["statements"],
            json!({"BEGIN": 3, "COMMIT": 2, "INSERT": 5, "RELEASE": 2, "ROLLBACK": 1, "SAVEPOINT": 2, "SELECT": 1})
        );
        assert_eq!(counts["sqliteCounts"]["commitHookCalls"], 3);
        assert_eq!(counts["sqliteCounts"]["rollbackHookCalls"], 1);
        assert!(!counts.to_string().contains("secret-bound-value"));
        // Enabling resets the interval. Disabling detaches all hooks.
        set_sql_counts(&mut connection, true);
        assert_eq!(
            transport.stats_json()["sqliteCounts"]["statements"],
            json!({})
        );
        set_sql_counts(&mut connection, false);
        connection
            .execute("INSERT INTO entries VALUES ('disabled')", [])
            .unwrap();
        assert!(transport.stats_json().get("sqliteCounts").is_none());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            5
        );
    }

    #[test]
    fn phase_stats_are_private_per_client_and_reset_after_failures() {
        let mut transport = BenchTransport::null();
        let mut client = Some(
            SyncClient::new(
                "private-phase-client".into(),
                &json!({"version":1,"tables":[]}),
                Default::default(),
            )
            .unwrap(),
        );
        let mut effects = CreateEffects::default();
        assert!(handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({})
        )
        .unwrap()
        .get("phases")
        .is_none());
        assert_eq!(
            handle(
                &mut transport,
                &mut client,
                &mut effects,
                "stats",
                &json!({"phases":"true"})
            )
            .unwrap_err()
            .0,
            "bench.invalid_request"
        );
        handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({"phases":true}),
        )
        .unwrap();
        assert!(matches!(
            client.as_mut().unwrap().sync(&mut transport),
            syncular_client::SyncOutcome::Failed { .. }
        ));
        let snapshot = handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({}),
        )
        .unwrap();
        assert_eq!(
            snapshot["phases"]["measurements"]["requestPrepare"]["calls"],
            1
        );
        assert_eq!(
            snapshot["phases"]["measurements"]["requestEncode"]["calls"],
            1
        );
        assert!(!snapshot["phases"]
            .to_string()
            .contains("private-phase-client"));
        let reset = handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({"reset":true}),
        )
        .unwrap();
        assert_eq!(reset["phases"]["measurements"], json!({}));
        handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({"phases":false}),
        )
        .unwrap();
        assert!(client
            .as_ref()
            .unwrap()
            .benchmark_phases(None, false)
            .unwrap()
            .is_none());
        let mut ffi = FfiClient::new(
            &json!({"clientId":"ffi-phase-test", "schema":{"version":1,"tables":[]}}),
        )
        .unwrap();
        assert_eq!(
            ffi.handle("stats", json!({"phases":true})).unwrap_err().0,
            "bench.unsupported_capability"
        );
    }

    #[test]
    fn sql_diagnostic_reset_and_destroy_preserve_driver_lifecycle() {
        let mut transport = BenchTransport::null();
        let mut client = Some(
            SyncClient::new(
                "sql-counter-test".into(),
                &json!({"version": 1, "tables": []}),
                Default::default(),
            )
            .unwrap(),
        );
        let mut effects = CreateEffects::default();
        assert_eq!(
            handle(
                &mut transport,
                &mut client,
                &mut effects,
                "stats",
                &json!({"sqlCounts": "true"})
            )
            .unwrap_err()
            .0,
            "bench.invalid_request"
        );
        handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({"sqlCounts": true}),
        )
        .unwrap();
        client.as_mut().unwrap().benchmark_connection().execute_batch("CREATE TABLE counter_entries (id INTEGER); INSERT INTO counter_entries VALUES (1);").unwrap();
        assert!(
            transport.stats_json()["sqliteCounts"]["commitHookCalls"]
                .as_u64()
                .unwrap()
                > 0
        );
        for method in ["create", "benchRead"] {
            assert_eq!(
                handle(
                    &mut transport,
                    &mut client,
                    &mut effects,
                    method,
                    &json!({})
                )
                .unwrap_err()
                .0,
                "bench.incompatible_diagnostic"
            );
        }
        let reset = handle(
            &mut transport,
            &mut client,
            &mut effects,
            "stats",
            &json!({"reset": true}),
        )
        .unwrap();
        assert_eq!(reset["sqliteCounts"]["commitHookCalls"], 0);
        assert_eq!(reset["sqliteCounts"]["statements"], json!({}));
        handle(
            &mut transport,
            &mut client,
            &mut effects,
            "destroy",
            &json!({}),
        )
        .unwrap();
        assert!(client.is_none());
        assert!(transport.stats_json().get("sqliteCounts").is_none());
        let mut ffi = FfiClient::new(&json!({})).unwrap();
        assert_eq!(
            ffi.handle("stats", json!({"sqlCounts": true}))
                .unwrap_err()
                .0,
            "bench.unsupported_capability"
        );
    }

    #[test]
    fn ffi_read_controls_stay_outside_the_exported_command_surface() {
        let mut client = FfiClient::new(&json!({})).unwrap();
        assert!(client
            .handle("benchRead", json!({"mode": "direct"}))
            .unwrap_err()
            .1
            .contains("boundary"));
        client
            .handle(
                "create",
                json!({"clientId": "ffi-read-control", "schema": {
                    "version": 1, "tables": []
                }}),
            )
            .unwrap();
        // A public C command cannot select the private benchmark loop.
        assert!(client
            .command("benchRead", &json!({"mode": "ffi"}))
            .unwrap()
            .0
            .is_err());
        let inputs = vec![json!({"params": [], "rows": [{"id": 1}]} ); 4];
        let result = client
            .handle(
                "benchRead",
                json!({"mode": "ffi", "iterations": 1,
                    "queries": [{"name": "first", "sql": "SELECT 1 AS id", "inputs": inputs},
                        {"name": "second", "sql": "SELECT 1 AS id", "inputs": inputs}]
                }),
            )
            .unwrap();
        for query in result["queries"].as_array().unwrap() {
            assert_eq!(
                query["work"]["database"]["statements"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                query["work"]["query"]["statements"]
                    .as_array()
                    .unwrap()
                    .len(),
                6
            );
            assert_eq!(
                query["work"]["snapshot"]["statements"]
                    .as_array()
                    .unwrap()
                    .len(),
                9
            );
            for surface in ["query", "snapshot"] {
                assert_eq!(
                    query["samplesNs"][surface][0],
                    query["ffi"][surface][0]["callNs"]
                );
                assert!(query["ffi"][surface][0]["responseBytes"].as_u64().unwrap() > 1);
            }
        }
    }

    #[test]
    fn raw_read_fixture_materializes_supported_cells_and_rejects_other_inputs() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let rows = read_database(
            &conn,
            "SELECT ? AS id, NULL AS empty, 42 AS count, 1.25 AS real",
            &[Value::from("snow 雪")],
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(rows).unwrap(),
            json!([{"id": "snow 雪", "empty": null, "count": 42, "real": 1.25}])
        );
        for sql in [
            "SELECT x'00' AS bytes",
            "SELECT 9223372036854775807 AS integer",
            "SELECT 9e999 AS real",
            "CREATE TABLE forbidden (id TEXT)",
        ] {
            assert!(read_database(&conn, sql, &[]).is_err(), "{sql}");
        }
        assert!(read_database(&conn, "SELECT ?", &[Value::from(1)]).is_err());
        assert_eq!(
            read_database(
                &conn,
                "SELECT name FROM sqlite_master WHERE name = 'forbidden'",
                &[]
            )
            .unwrap()
            .len(),
            0
        );
    }

    #[test]
    fn timed_mutations_keep_independent_commits_and_match_the_shared_router() {
        let schema = json!({"version": 1, "tables": [{"name": "tasks", "primaryKey": "id",
            "columns": [
                {"name": "id", "type": "string", "nullable": false},
                {"name": "project_id", "type": "string", "nullable": false},
                {"name": "title", "type": "string", "nullable": false}],
            "scopes": [{"pattern": "project:{project_id}"}]}]});
        let commits: Vec<Value> = (0..10).map(|index| json!({"mutations": [{"op": "upsert", "table": "tasks",
            "values": {"id": format!("t{}", index % 2), "project_id": "p", "title": format!("edit{index}")}}]})).collect();
        let mut snapshots = Vec::new();
        for mode in ["direct", "command"] {
            let mut transport = BenchTransport::null();
            let mut client = Some(
                SyncClient::new("bench-test".to_owned(), &schema, Default::default()).unwrap(),
            );
            let mut effects = CreateEffects::default();
            let result = handle(
                &mut transport,
                &mut client,
                &mut effects,
                "benchMutate",
                &json!({"mode": mode, "commits": commits}),
            )
            .unwrap();
            let ids = result["ids"].as_array().unwrap();
            assert_eq!(ids.len(), 10);
            assert_eq!(
                ids.iter()
                    .map(|id| id.as_str().unwrap())
                    .collect::<std::collections::HashSet<_>>()
                    .len(),
                10
            );
            assert_eq!(result["nsPerCommit"].as_array().unwrap().len(), 10);
            let instance = client.as_mut().unwrap();
            assert_eq!(instance.status_snapshot().outbox, 10);
            assert_eq!(instance.local_revision(), 10);
            snapshots.push(
                instance
                    .query("SELECT * FROM tasks ORDER BY id", &[])
                    .unwrap(),
            );
            assert_eq!(
                transport.stats.request_count, 0,
                "construction must remain offline"
            );
        }
        assert_eq!(snapshots[0], snapshots[1]);
    }
    #[test]
    fn timed_blob_operations_preserve_cache_hits_and_both_boundaries() {
        let schema = json!({"version": 1, "tables": [{"name": "attachments", "primaryKey": "id",
            "columns": [{"name": "id", "type": "string", "nullable": false},
                {"name": "body", "type": "blob_ref", "nullable": false}], "scopes": []}]});
        let bytes: Vec<u8> = (0..4096).map(|index| (index % 251) as u8).collect();
        let mut returned = Vec::new();
        for mode in ["direct", "command"] {
            let mut transport = BenchTransport::null();
            let mut client = Some(
                SyncClient::new("blob-bench".to_owned(), &schema, Default::default()).unwrap(),
            );
            let mut effects = CreateEffects::default();
            let staged = handle(&mut transport, &mut client, &mut effects, "benchBlob",
                &json!({"mode": mode, "operation": "uploadBlob", "bytes": syncular_command::bytes_value(&bytes)})).unwrap();
            assert!(staged.get("error").is_none(), "{staged}");
            assert!(staged["elapsedNs"].is_u64());
            let blob_id = staged["value"]["ref"]["blobId"].as_str().unwrap();
            for _ in 0..2 {
                let fetched = handle(
                    &mut transport,
                    &mut client,
                    &mut effects,
                    "benchBlob",
                    &json!({"mode": mode, "operation": "fetchBlob", "blob": blob_id}),
                )
                .unwrap();
                assert!(fetched.get("error").is_none(), "{fetched}");
                assert_eq!(
                    syncular_command::value_bytes(fetched["value"]["blob"].get("bytes")).unwrap(),
                    bytes
                );
                assert!(fetched["elapsedNs"].is_u64());
                returned.push(fetched["value"].clone());
            }
            assert_eq!(transport.stats.request_count, 0);
            assert!(transport.stats.blob_requests.is_empty());
            let failed = handle(&mut transport, &mut client, &mut effects, "benchBlob",
                &json!({"mode": mode, "operation": "fetchBlob", "blob": format!("sha256:{}", "0".repeat(64))})).unwrap();
            assert!(failed["error"]["code"].is_string(), "{failed}");
            assert!(failed["elapsedNs"].is_u64());
            assert_eq!(failed["stats"]["blobRequests"][0]["failed"], true);
        }
        assert!(returned.windows(2).all(|pair| pair[0] == pair[1]));
    }
    #[test]
    fn ffi_commands_copy_and_release_results_before_host_parsing() {
        let schema = json!({"version": 1, "tables": [{"name": "attachments", "primaryKey": "id",
            "columns": [{"name": "id", "type": "string", "nullable": false},
                {"name": "body", "type": "blob_ref", "nullable": false}], "scopes": []}]});
        let mut client = FfiClient::new(&json!({})).unwrap();
        client
            .handle("create", json!({"schema": schema, "clientId": "ffi-test"}))
            .unwrap();
        let bytes: Vec<u8> = (0..=255).cycle().take(4096).collect();
        let staged = client
            .handle(
                "benchBlob",
                json!({"mode": "ffi", "operation": "uploadBlob",
            "bytes": syncular_command::bytes_value(&bytes)}),
            )
            .unwrap();
        let blob_id = staged["value"]["ref"]["blobId"].as_str().unwrap();
        for _ in 0..3 {
            let result = client
                .handle(
                    "benchBlob",
                    json!({"mode": "ffi", "operation": "fetchBlob", "blob": blob_id}),
                )
                .unwrap();
            assert!(result.get("error").is_none(), "{result}");
            assert_eq!(
                syncular_command::value_bytes(result["value"]["blob"].get("bytes")).unwrap(),
                bytes
            );
            assert_eq!(
                result["ffi"]["responseBytes"].as_u64().unwrap() as usize,
                json!({"result": result["value"]}).to_string().len() + 1
            );
            for field in [
                "requestSerializeNs",
                "callNs",
                "responseCopyNs",
                "responseFreeNs",
                "responseParseNs",
            ] {
                assert!(result["ffi"][field].is_u64(), "{field}: {result}");
            }
        }
        let (failed, timing) = client.command("unknown-method", &json!({})).unwrap();
        assert!(failed.is_err());
        assert!(timing["responseBytes"].as_u64().unwrap() > 0);
        assert!(client
            .handle("benchSync", json!({"mode": "direct"}))
            .is_err());
    }
}
