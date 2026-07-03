//! Conformance ClientDriver shim (stage 2 of the Rust POC).
//!
//! Speaks the conformance driver protocol over stdio as JSON lines — one
//! request, one response — around one `syncular_client::SyncClient`
//! instance (spawned per `ClientInstance`), plus the ssp2 codec surface
//! for the golden-vector stage.
//!
//! The command surface (the `method → result` dispatch) lives in the shared
//! `syncular-command` crate so the FFI native core runs the SAME router — the
//! shim is what conformance-locks it. This binary owns only the stdio host:
//! the transport inversion (the harness holds the sync/segment/realtime
//! endpoints), realtime notification draining, and deferred-request ordering.
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
use syncular_client::{SegmentRequest, SyncClient, Transport, TransportError};
use syncular_command::{bytes_value, dispatch, value_bytes, CreateEffects};

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
    /// §5.4 capability of the harness endpoints (create `signedUrls`).
    signed_urls: bool,
}

impl HostIo {
    fn new() -> Self {
        HostIo {
            reader: BufReader::new(std::io::stdin().lock()),
            out: std::io::stdout(),
            next_id: 0,
            rt_queue: VecDeque::new(),
            deferred: VecDeque::new(),
            signed_urls: false,
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

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        // §8.7 socket round: the host bridge owns tagging and response
        // assembly; the core sees assembled bytes, same as `sync`.
        let result = self.call_host("realtimeSync", json!({ "request": bytes_value(request) }))?;
        value_bytes(result.get("response")).map_err(|m| TransportError::new("transport.failed", m))
    }

    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError> {
        let mut params = Map::new();
        params.insert(
            "segmentId".to_owned(),
            Value::from(request.segment_id.clone()),
        );
        params.insert("table".to_owned(), Value::from(request.table.clone()));
        params.insert(
            "requestedScopesJson".to_owned(),
            Value::from(request.requested_scopes_json.clone()),
        );
        let result = self.call_host("downloadSegment", Value::Object(params))?;
        value_bytes(result.get("bytes")).map_err(|m| TransportError::new("transport.failed", m))
    }

    fn supports_url_fetch(&self) -> bool {
        // Announced by the harness at create time — the loopback endpoint
        // set decides its own §5.4 capability (negotiation, not fallback).
        self.signed_urls
    }

    fn fetch_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        // The URL is the entire grant (§5.4): nothing but the URL crosses.
        let result = self.call_host("fetchUrl", json!({ "url": url }))?;
        value_bytes(result.get("bytes")).map_err(|m| TransportError::new("transport.failed", m))
    }

    fn blob_upload(
        &mut self,
        blob_id: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        let mut params = Map::new();
        params.insert("blobId".to_owned(), Value::from(blob_id.to_owned()));
        params.insert("bytes".to_owned(), bytes_value(bytes));
        if let Some(mt) = media_type {
            params.insert("mediaType".to_owned(), Value::from(mt.to_owned()));
        }
        self.call_host("blobUpload", Value::Object(params))
            .map(|_| ())
    }

    fn blob_download(&mut self, blob_id: &str) -> Result<Vec<u8>, TransportError> {
        let result = self.call_host("blobDownload", json!({ "blobId": blob_id }))?;
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

fn main() {
    let mut io = HostIo::new();
    let mut client: Option<SyncClient> = None;
    let mut effects = CreateEffects::default();
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
                let result = dispatch(&mut io, &mut client, &mut effects, &method, &params);
                // The shared router parses `create`'s signedUrls into effects;
                // apply it to this stdio host's transport capability.
                if method == "create" {
                    io.signed_urls = effects.signed_urls;
                }
                drain_realtime(&mut io, &mut client);
                io.respond(&id, result);
            }
            Incoming::Response { .. } => {}
        }
    }
}
