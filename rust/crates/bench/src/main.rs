//! Benchmark driver binary (`syncular-bench`) for the offline-sync-bench
//! harness.
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

use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use syncular_client::{
    BlobDownload, BlobUploadGrant, SegmentRequest, SyncClient, Transport, TransportError,
};
use syncular_command::{dispatch, CommandError, CreateEffects};
// The FFI crate's lib name is `syncular` (see crates/ffi/Cargo.toml [lib]).
use syncular::transport::{HostTransport, Inbound};

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
}

struct BenchTransport {
    inner: HostTransport,
    stats: TransportStats,
}

impl BenchTransport {
    /// A no-network placeholder until `create` supplies the real config.
    fn null() -> Self {
        BenchTransport {
            inner: HostTransport::new_from_config(&json!({})).expect("null transport"),
            stats: TransportStats::default(),
        }
    }

    fn from_config(config: &Value) -> Result<Self, String> {
        Ok(BenchTransport {
            inner: HostTransport::new_from_config(config)?,
            stats: TransportStats::default(),
        })
    }

    fn take_inbound(&mut self) -> Vec<Inbound> {
        let frames = self.inner.take_inbound();
        for frame in &frames {
            self.stats.ws_in_bytes += match frame {
                Inbound::Text(text) => text.len() as u64,
                Inbound::Binary(bytes) => bytes.len() as u64,
            };
        }
        frames
    }

    fn shutdown(&mut self) {
        self.inner.shutdown();
    }

    fn stats_json(&self) -> Value {
        json!({
            "requestBytes": self.stats.request_bytes,
            "responseBytes": self.stats.response_bytes,
            "wsInBytes": self.stats.ws_in_bytes,
            "wsOutBytes": self.stats.ws_out_bytes,
            "requestCount": self.stats.request_count,
        })
    }

    fn count_request(&mut self, bytes: u64) {
        self.stats.request_count += 1;
        self.stats.request_bytes += bytes;
    }
}

impl Transport for BenchTransport {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        self.count_request(request.len() as u64);
        let response = self.inner.sync(request)?;
        self.stats.response_bytes += response.len() as u64;
        Ok(response)
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        // Rides the socket when connected (falls back to HTTP inside the
        // native transport when it is not); counted on the WS side either way
        // so socket rounds do not vanish from the totals.
        self.stats.ws_out_bytes += request.len() as u64;
        let response = self.inner.realtime_sync(request)?;
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
        self.count_request(bytes.len() as u64);
        self.inner.blob_upload(blob_id, bytes, media_type)
    }

    fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
        self.count_request(0);
        let download = self.inner.blob_download(blob_id)?;
        if let BlobDownload::Bytes(bytes) = &download {
            self.stats.response_bytes += bytes.len() as u64;
        }
        Ok(download)
    }

    fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        self.count_request(0);
        let response = self.inner.fetch_blob_url(url)?;
        self.stats.response_bytes += response.len() as u64;
        Ok(response)
    }

    fn blob_upload_grant(
        &mut self,
        blob_id: &str,
        byte_length: u64,
        media_type: Option<&str>,
    ) -> Result<BlobUploadGrant, TransportError> {
        self.count_request(0);
        self.inner
            .blob_upload_grant(blob_id, byte_length, media_type)
    }

    fn blob_put_url(
        &mut self,
        url: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        self.count_request(bytes.len() as u64);
        self.inner.blob_put_url(url, bytes, media_type)
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        self.inner.realtime_connect()
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.stats.ws_out_bytes += text.len() as u64;
        self.inner.realtime_send(text)
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
fn drain_inbound(transport: &mut BenchTransport, client: &mut Option<SyncClient>) {
    let frames = transport.take_inbound();
    let Some(instance) = client.as_mut() else {
        return;
    };
    for frame in frames {
        match frame {
            Inbound::Text(text) => instance.on_realtime_text(&text),
            Inbound::Binary(bytes) => instance.on_realtime_binary(transport, &bytes),
        }
    }
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
        drain_inbound(transport, client);
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

fn handle(
    transport: &mut BenchTransport,
    client: &mut Option<SyncClient>,
    effects: &mut CreateEffects,
    method: &str,
    params: &Value,
) -> Result<Value, CommandError> {
    match method {
        "create" => {
            // Bench extension: the transport config rides the create params
            // (the shim has no transport to configure; a native app passes it
            // to the FFI constructor). Replace the placeholder before the
            // shared router installs the client.
            if let Some(config) = params.get("transport") {
                transport.shutdown();
                *transport = BenchTransport::from_config(config).map_err(client_err)?;
            }
            let result = dispatch(transport, client, effects, method, params)?;
            transport.inner.set_signed_urls(effects.signed_urls);
            Ok(result)
        }
        "waitForQuery" => wait_for_query(transport, client, params),
        "benchQuery" => bench_query(client, params),
        "stats" => Ok(transport.stats_json()),
        "sleep" => {
            let ms = params.get("ms").and_then(Value::as_u64).unwrap_or(0);
            std::thread::sleep(Duration::from_millis(ms));
            Ok(json!({}))
        }
        "destroy" => {
            *client = None;
            transport.shutdown();
            Ok(json!({}))
        }
        _ => dispatch(transport, client, effects, method, params),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut client: Option<SyncClient> = None;
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
        let result = handle(&mut transport, &mut client, &mut effects, &method, &params);
        // Deliver any realtime traffic buffered while the command ran.
        drain_inbound(&mut transport, &mut client);
        respond(&id, result);
    }
    transport.shutdown();
}
