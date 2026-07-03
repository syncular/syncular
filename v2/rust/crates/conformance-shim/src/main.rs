//! Conformance ClientDriver shim (stage 2 of the Rust POC).
//!
//! Speaks the conformance driver protocol over stdio as JSON lines — one
//! request, one response — around one `syncular_client::SyncClient`
//! instance (spawned per `ClientInstance`), plus the ssp2 codec surface
//! for the golden-vector stage.
//!
//! Framing (all lines are single JSON documents; bytes travel as
//! `{"$bytes": "<lowercase hex>"}`):
//!
//! - host → shim request: `{"id": n, "method": "...", "params": {...}}`
//! - host → shim notification: `{"method": "realtimeText"|"realtimeBinary", "params": {...}}`
//! - shim → host response: `{"id": n, "result": ...}` or
//!   `{"id": n, "error": {"code": ..., "message": ...}}`
//! - shim → host request (the transport inversion — the harness owns the
//!   sync/downloadSegment/realtime endpoints):
//!   `{"id": "t<n>", "method": "sync"|"downloadSegment"|"realtimeConnect"|
//!   "realtimeSend"|"realtimeClose", "params": {...}}`
//! - host → shim response: same response shape, echoing the "t<n>" id.
//!
//! Nested callbacks work because ids are direction-local and the shim keeps
//! reading (and queueing realtime notifications) while it waits for the
//! response to its own transport request.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, StdinLock, Stdout, Write};

use serde_json::{json, Map, Value};
use ssp2::segment::{decode_rows_segment, encode_rows_segment};
use ssp2::{
    decode_message, encode_message, parse_control, render_message, render_rows_segment,
    ControlMessage,
};
use syncular_client::{
    ClientLimits, Mutation, SegmentRequest, SyncClient, Transport, TransportError,
};

fn bytes_to_hex(bytes: &[u8]) -> String {
    syncular_client::values::bytes_to_hex(bytes)
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    syncular_client::values::hex_to_bytes(hex)
}

fn bytes_value(bytes: &[u8]) -> Value {
    json!({ "$bytes": bytes_to_hex(bytes) })
}

fn value_bytes(value: Option<&Value>) -> Result<Vec<u8>, String> {
    let hex = value
        .and_then(|v| v.get("$bytes"))
        .and_then(Value::as_str)
        .ok_or_else(|| "expected a {\"$bytes\": hex} value".to_owned())?;
    hex_to_bytes(hex)
}

enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<Value>,
    },
}

enum RtEvent {
    Text(String),
    Binary(Vec<u8>),
}

struct HostIo {
    reader: BufReader<StdinLock<'static>>,
    out: Stdout,
    next_id: u64,
    rt_queue: VecDeque<RtEvent>,
    /// Driver requests that arrived while a transport call was in flight
    /// (the harness may issue the next driver call as soon as a seam
    /// observation resolves); replayed by the main loop in order.
    deferred: VecDeque<(Value, String, Value)>,
}

impl HostIo {
    fn new() -> Self {
        HostIo {
            reader: BufReader::new(std::io::stdin().lock()),
            out: std::io::stdout(),
            next_id: 0,
            rt_queue: VecDeque::new(),
            deferred: VecDeque::new(),
        }
    }

    fn write_line(&mut self, value: &Value) {
        let mut handle = self.out.lock();
        let _ = writeln!(handle, "{value}");
        let _ = handle.flush();
    }

    fn read_next(&mut self) -> Option<Incoming> {
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => return None, // EOF: host is gone
                Ok(_) => {}
                Err(_) => return None,
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let method = value.get("method").and_then(Value::as_str);
            let id = value.get("id").cloned();
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            return Some(match (method, id) {
                (Some(m), Some(id)) => Incoming::Request {
                    id,
                    method: m.to_owned(),
                    params,
                },
                (Some(m), None) => Incoming::Notification {
                    method: m.to_owned(),
                    params,
                },
                (None, Some(id)) => Incoming::Response {
                    id,
                    result: value.get("result").cloned(),
                    error: value.get("error").cloned(),
                },
                (None, None) => continue,
            });
        }
    }

    fn queue_notification(&mut self, method: &str, params: &Value) {
        match method {
            "realtimeText" => {
                if let Some(text) = params.get("text").and_then(Value::as_str) {
                    self.rt_queue.push_back(RtEvent::Text(text.to_owned()));
                }
            }
            "realtimeBinary" => {
                if let Ok(bytes) = value_bytes(params.get("bytes")) {
                    self.rt_queue.push_back(RtEvent::Binary(bytes));
                }
            }
            _ => {}
        }
    }

    /// Ask the harness (a JSON-line callback flowing the other way on the
    /// same stdio channel) and block until its response, queueing any
    /// realtime notifications that interleave.
    fn call_host(&mut self, method: &str, params: Value) -> Result<Value, TransportError> {
        self.next_id += 1;
        let id = Value::from(format!("t{}", self.next_id));
        self.write_line(&json!({ "id": id, "method": method, "params": params }));
        loop {
            match self.read_next() {
                None => {
                    return Err(TransportError::new(
                        "transport.failed",
                        "host closed the channel",
                    ));
                }
                Some(Incoming::Notification { method, params }) => {
                    self.queue_notification(&method, &params);
                }
                Some(Incoming::Request {
                    id: rid,
                    method,
                    params,
                }) => {
                    // A driver request racing our transport call: defer it
                    // for the main loop, never drop it.
                    self.deferred.push_back((rid, method, params));
                }
                Some(Incoming::Response {
                    id: rid,
                    result,
                    error,
                }) if rid == id => {
                    if let Some(error) = error {
                        let code = error
                            .get("code")
                            .and_then(Value::as_str)
                            .unwrap_or("transport.failed")
                            .to_owned();
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        return Err(TransportError::new(code, message));
                    }
                    return Ok(result.unwrap_or(Value::Null));
                }
                Some(_) => {} // unexpected mid-call traffic: ignore
            }
        }
    }

    fn respond(&mut self, id: &Value, result: Result<Value, (String, String)>) {
        let line = match result {
            Ok(value) => json!({ "id": id, "result": value }),
            Err((code, message)) => {
                json!({ "id": id, "error": { "code": code, "message": message } })
            }
        };
        self.write_line(&line);
    }
}

impl Transport for HostIo {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        let result = self.call_host("sync", json!({ "request": bytes_value(request) }))?;
        value_bytes(result.get("response")).map_err(|m| TransportError::new("transport.failed", m))
    }

    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError> {
        let mut params = Map::new();
        params.insert(
            "segmentId".to_owned(),
            Value::from(request.segment_id.clone()),
        );
        params.insert("table".to_owned(), Value::from(request.table.clone()));
        if let Some(url) = &request.url {
            params.insert("url".to_owned(), Value::from(url.clone()));
        }
        if let Some(exp) = request.url_expires_at_ms {
            params.insert("urlExpiresAtMs".to_owned(), Value::from(exp));
        }
        params.insert(
            "requestedScopesJson".to_owned(),
            Value::from(request.requested_scopes_json.clone()),
        );
        let result = self.call_host("downloadSegment", Value::Object(params))?;
        value_bytes(result.get("bytes")).map_err(|m| TransportError::new("transport.failed", m))
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        self.call_host("realtimeConnect", json!({})).map(|_| ())
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        self.call_host("realtimeSend", json!({ "text": text }))
            .map(|_| ())
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        self.call_host("realtimeClose", json!({})).map(|_| ())
    }
}

fn drain_realtime(io: &mut HostIo, client: &mut Option<SyncClient>) {
    while let Some(event) = io.rt_queue.pop_front() {
        let Some(instance) = client.as_mut() else {
            continue;
        };
        match event {
            RtEvent::Text(text) => instance.on_realtime_text(&text),
            RtEvent::Binary(bytes) => instance.on_realtime_binary(io, &bytes),
        }
    }
}

fn parse_limits(value: Option<&Value>) -> ClientLimits {
    let mut limits = ClientLimits::default();
    let Some(object) = value.and_then(Value::as_object) else {
        return limits;
    };
    limits.limit_commits = object
        .get("limitCommits")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    limits.limit_snapshot_rows = object
        .get("limitSnapshotRows")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    limits.max_snapshot_pages = object
        .get("maxSnapshotPages")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    limits.accept = object
        .get("accept")
        .and_then(Value::as_u64)
        .map(|v| v as u8);
    limits
}

fn parse_mutations(value: Option<&Value>) -> Result<Vec<Mutation>, String> {
    let list = value
        .and_then(Value::as_array)
        .ok_or_else(|| "mutations must be a list".to_owned())?;
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        let op = entry
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| "mutation missing op".to_owned())?;
        let table = entry
            .get("table")
            .and_then(Value::as_str)
            .ok_or_else(|| "mutation missing table".to_owned())?
            .to_owned();
        let base_version = entry.get("baseVersion").and_then(Value::as_i64);
        match op {
            "upsert" => {
                let values = entry
                    .get("values")
                    .and_then(Value::as_object)
                    .cloned()
                    .ok_or_else(|| "upsert missing values".to_owned())?;
                out.push(Mutation::Upsert {
                    table,
                    values,
                    base_version,
                });
            }
            "delete" => {
                let row_id = entry
                    .get("rowId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "delete missing rowId".to_owned())?
                    .to_owned();
                out.push(Mutation::Delete {
                    table,
                    row_id,
                    base_version,
                });
            }
            other => return Err(format!("unknown mutation op {other:?}")),
        }
    }
    Ok(out)
}

fn scopes_from_params(value: Option<&Value>) -> Result<Vec<(String, Vec<String>)>, String> {
    match value {
        Some(v) => syncular_client::values::json_to_scope_map(v),
        None => Ok(Vec::new()),
    }
}

fn client_err(message: String) -> (String, String) {
    ("client.failed".to_owned(), message)
}

fn need_client(client: &mut Option<SyncClient>) -> Result<&mut SyncClient, (String, String)> {
    client
        .as_mut()
        .ok_or_else(|| client_err("no client instance created".to_owned()))
}

fn dispatch(
    io: &mut HostIo,
    client: &mut Option<SyncClient>,
    method: &str,
    params: &Value,
) -> Result<Value, (String, String)> {
    match method {
        "create" => {
            let client_id = params
                .get("clientId")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("create missing clientId".to_owned()))?
                .to_owned();
            let schema = params
                .get("schema")
                .ok_or_else(|| client_err("create missing schema".to_owned()))?;
            let limits = parse_limits(params.get("limits"));
            let instance = SyncClient::new(client_id, schema, limits).map_err(client_err)?;
            *client = Some(instance);
            Ok(json!({}))
        }
        "subscribe" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscribe missing id".to_owned()))?
                .to_owned();
            let table = params
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscribe missing table".to_owned()))?
                .to_owned();
            let scopes = scopes_from_params(params.get("scopes")).map_err(client_err)?;
            let sub_params = params
                .get("params")
                .and_then(Value::as_str)
                .map(str::to_owned);
            need_client(client)?
                .subscribe(id, table, scopes, sub_params)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "unsubscribe" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("unsubscribe missing id".to_owned()))?;
            need_client(client)?.unsubscribe(id);
            Ok(json!({}))
        }
        "mutate" => {
            let mutations = parse_mutations(params.get("mutations")).map_err(client_err)?;
            let id = need_client(client)?.mutate(mutations).map_err(client_err)?;
            Ok(json!({ "clientCommitId": id }))
        }
        "sync" => {
            let outcome = need_client(client)?.sync(io);
            Ok(outcome.to_json())
        }
        "syncUntilIdle" => {
            let max_rounds = params
                .get("maxRounds")
                .and_then(Value::as_u64)
                .map(|v| v as u32);
            let outcome = need_client(client)?.sync_until_idle(io, max_rounds);
            Ok(outcome.to_json())
        }
        "readRows" => {
            let table = params
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("readRows missing table".to_owned()))?;
            let rows = need_client(client)?.read_rows(table).map_err(client_err)?;
            Ok(json!({ "rows": rows }))
        }
        "conflicts" => {
            let conflicts = need_client(client)?.conflicts().to_vec();
            Ok(json!({ "conflicts": conflicts }))
        }
        "rejections" => {
            let rejections = need_client(client)?.rejections().to_vec();
            Ok(json!({ "rejections": rejections }))
        }
        "pendingCommitIds" => {
            let ids = need_client(client)?.pending_commit_ids();
            Ok(json!({ "ids": ids }))
        }
        "subscriptionState" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscriptionState missing id".to_owned()))?;
            let state = need_client(client)?.subscription_state(id);
            Ok(json!({ "state": state }))
        }
        "schemaFloor" => {
            let floor = need_client(client)?.schema_floor().cloned();
            Ok(json!({ "floor": floor }))
        }
        "connectRealtime" => {
            need_client(client)?
                .connect_realtime(io)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "disconnectRealtime" => {
            need_client(client)?.disconnect_realtime(io);
            Ok(json!({}))
        }
        "syncNeeded" => {
            let value = need_client(client)?.sync_needed();
            Ok(json!({ "value": value }))
        }

        // -- CodecDriver surface (Appendix A) — no client instance needed --
        "messageRoundtrip" => {
            let bytes = value_bytes(params.get("bytes")).map_err(client_err)?;
            match decode_message(&bytes) {
                Ok(message) => Ok(json!({
                    "ok": true,
                    "bytes": bytes_value(&encode_message(&message)),
                    "renderedJson": render_message(&message).to_string(),
                })),
                Err(error) => Ok(json!({ "ok": false, "errorCode": error.code.as_str() })),
            }
        }
        "segmentRoundtrip" => {
            let bytes = value_bytes(params.get("bytes")).map_err(client_err)?;
            match decode_rows_segment(&bytes) {
                Ok(segment) => Ok(json!({
                    "ok": true,
                    "bytes": bytes_value(&encode_rows_segment(&segment)),
                    "renderedJson": render_rows_segment(&segment).to_string(),
                })),
                Err(error) => Ok(json!({ "ok": false, "errorCode": error.code.as_str() })),
            }
        }
        "realtimeKnown" => {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("realtimeKnown missing text".to_owned()))?;
            let known = matches!(
                parse_control(text),
                Ok(ControlMessage::Hello { .. })
                    | Ok(ControlMessage::Wake { .. })
                    | Ok(ControlMessage::Heartbeat { .. })
            );
            Ok(json!({ "value": known }))
        }

        other => Err(client_err(format!("unknown method {other:?}"))),
    }
}

fn main() {
    let mut io = HostIo::new();
    let mut client: Option<SyncClient> = None;
    // Runs until stdin EOF (the host is gone) or an explicit `close`.
    loop {
        let incoming = if let Some((id, method, params)) = io.deferred.pop_front() {
            Incoming::Request { id, method, params }
        } else {
            match io.read_next() {
                Some(incoming) => incoming,
                None => break,
            }
        };
        match incoming {
            Incoming::Notification { method, params } => {
                io.queue_notification(&method, &params);
                drain_realtime(&mut io, &mut client);
            }
            Incoming::Request { id, method, params } => {
                if method == "close" {
                    io.respond(&id, Ok(json!({})));
                    break;
                }
                let result = dispatch(&mut io, &mut client, &method, &params);
                drain_realtime(&mut io, &mut client);
                io.respond(&id, result);
            }
            Incoming::Response { .. } => {}
        }
    }
}
