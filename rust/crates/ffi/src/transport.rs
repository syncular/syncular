//! The transport the FFI core OWNS.
//!
//! Two shapes behind one `HostTransport`:
//!
//! - `Null` (the dependency-lean default build): every network op fails loudly
//!   with `transport.unavailable`. Client-local commands (create, subscribe,
//!   mutate, readRows, conflicts, …) still run — enough for the C smoke test
//!   and pure-logic tests, with zero HTTP/WS dependency compiled in.
//! - `Native` (the `native-transport` feature): a real HTTP + WS client the
//!   core drives itself, because a native app has no host loop to invert
//!   transport into (unlike the conformance shim). `ureq` for blocking HTTP,
//!   `tungstenite` for the WS socket; a reader thread buffers inbound frames.
//!
//! Inbound realtime frames land in a shared queue the FFI drains after each
//! command via [`HostTransport::take_inbound`].

use std::sync::{Arc, Mutex};

use syncular_client::{BlobDownload, BlobUploadGrant, SegmentRequest, Transport, TransportError};

/// One inbound realtime frame buffered for the client's `on_realtime_*`.
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
}

/// The shared inbound buffer the WS reader thread fills and the command path
/// drains. Separate from the event queue: raw frames go here, committed core
/// outputs go to the `EventQueue`.
#[derive(Default)]
pub struct InboundBuffer {
    frames: Mutex<Vec<Inbound>>,
}

impl InboundBuffer {
    pub fn push(&self, frame: Inbound) {
        self.frames.lock().expect("inbound lock").push(frame);
    }
    fn take(&self) -> Vec<Inbound> {
        std::mem::take(&mut *self.frames.lock().expect("inbound lock"))
    }
}

pub enum HostTransport {
    /// No network: client-local commands only (dependency-lean default).
    Null {
        signed_urls: bool,
        inbound: Arc<InboundBuffer>,
    },
    #[cfg(feature = "native-transport")]
    Native(native::NativeTransport),
}

impl HostTransport {
    /// Build the transport from the `new` config. `{}` (or no `baseUrl`) →
    /// `Null`; a `baseUrl` under the `native-transport` feature → `Native`.
    pub(crate) fn from_config(config: &serde_json::Value) -> Result<Self, String> {
        Self::new_from_config(config)
    }

    /// [`Self::from_config`] for hosts outside this crate (the bench driver)
    /// that own their inbound-frame drain and need no FFI event queue.
    pub fn new_from_config(config: &serde_json::Value) -> Result<Self, String> {
        #[cfg(feature = "native-transport")]
        {
            if let Some(base_url) = config.get("baseUrl").and_then(|v| v.as_str()) {
                return Ok(HostTransport::Native(native::NativeTransport::new(
                    base_url, config,
                )?));
            }
        }
        #[cfg(not(feature = "native-transport"))]
        {
            if config.get("baseUrl").is_some() {
                return Err(
                    "this build has no native transport (rebuild with --features native-transport)"
                        .to_owned(),
                );
            }
        }
        Ok(HostTransport::Null {
            signed_urls: false,
            inbound: Arc::new(InboundBuffer::default()),
        })
    }

    pub fn set_signed_urls(&mut self, value: bool) {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls = value,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls = value,
        }
    }

    /// Drain the inbound realtime frames buffered since the last call.
    pub fn take_inbound(&mut self) -> Vec<Inbound> {
        match self {
            HostTransport::Null { inbound, .. } => inbound.take(),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.inbound.take(),
        }
    }

    /// Release the socket/reader thread. Idempotent.
    pub fn shutdown(&mut self) {
        match self {
            HostTransport::Null { .. } => {}
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.shutdown(),
        }
    }
}

fn unavailable(op: &str) -> TransportError {
    TransportError::new(
        "transport.unavailable",
        format!("{op} needs the native transport (build with --features native-transport)"),
    )
}

// Without the native transport the `Null` arm ignores every request payload;
// the params are only consumed by the feature-gated `Native` arm.
#[cfg_attr(not(feature = "native-transport"), allow(unused_variables))]
impl Transport for HostTransport {
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("sync")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.sync(request),
        }
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeSync")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_sync(request),
        }
    }

    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("downloadSegment")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.download_segment(request),
        }
    }

    fn supports_url_fetch(&self) -> bool {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls,
        }
    }

    fn fetch_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("fetchUrl")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.fetch_url(url),
        }
    }

    fn blob_upload(
        &mut self,
        blob_id: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("blobUpload")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.blob_upload(blob_id, bytes, media_type),
        }
    }

    fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("blobDownload")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.blob_download(blob_id),
        }
    }

    fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("fetchBlobUrl")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.fetch_blob_url(url),
        }
    }

    fn blob_upload_grant(
        &mut self,
        blob_id: &str,
        byte_length: u64,
        media_type: Option<&str>,
    ) -> Result<BlobUploadGrant, TransportError> {
        match self {
            // No grant available ⇒ the client streams through the direct
            // upload endpoint (§5.9.3 capability, not fallback).
            HostTransport::Null { .. } => Ok(BlobUploadGrant::None),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.blob_upload_grant(blob_id, byte_length, media_type),
        }
    }

    fn blob_put_url(
        &mut self,
        url: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("blobPutUrl")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.blob_put_url(url, bytes, media_type),
        }
    }

    fn realtime_connect(&mut self) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeConnect")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_connect(),
        }
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeSend")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_send(text),
        }
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Ok(()),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_close(),
        }
    }
}

#[cfg(feature = "native-transport")]
mod native {
    //! The real native HTTP + WS transport. HTTP via `ureq` (blocking, no
    //! async runtime — matches the client's synchronous API); WS via
    //! `tungstenite`, with a reader thread pushing inbound frames into the
    //! shared `InboundBuffer`.
    //!
    //! Wire contract mirrors the reference HTTP+WS bindings (§1.1, §8.7):
    //! `POST {baseUrl}/sync` (application/vnd.syncular.sync.v2, `X-Syncular-Scopes`
    //! not needed here — the native app authenticates via configured headers),
    //! `GET {baseUrl}/segments/{id}`, `PUT/GET {baseUrl}/blobs/{id}`, and the
    //! realtime socket at `{wsUrl}` (ws(s):// derived from baseUrl).

    use std::io::Read;
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{Message, WebSocket};

    use super::{Inbound, InboundBuffer};
    use syncular_client::{
        BlobDownload, BlobUploadGrant, RealtimeRound, RoundInbound, SegmentRequest, Transport,
        TransportError,
    };

    type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

    /// How long a single response round waits before giving up (§8.7 rounds
    /// are bounded — bulk rides segments over HTTP). Generous; a stuck socket
    /// surfaces as a transport failure rather than hanging the caller forever.
    const ROUND_TIMEOUT: Duration = Duration::from_secs(30);
    /// The reader's per-iteration socket read timeout: bounds how long the
    /// reader holds the socket lock across `ws.read()`, so `realtime_send`
    /// (round request bytes + §8.2 acks) can interleave sends promptly. A
    /// pending send waits out at most one read window, so this is the
    /// worst-case send latency — keep it small (the wakeup churn on a quiet
    /// socket is a few hundred cheap syscalls per second).
    const READ_TIMEOUT: Duration = Duration::from_millis(5);
    /// How long the reader parks OUTSIDE the socket lock after an empty read
    /// window. Load-bearing for fairness, not just politeness: without it the
    /// reader re-acquires the (unfair) mutex faster than a parked sender can
    /// wake, and sends starve for seconds on a quiet socket (observed on
    /// macOS: 30-150s per §8.7 round).
    const READ_YIELD: Duration = Duration::from_micros(500);

    /// The §8.7 round rendezvous shared between the reader thread (which
    /// demuxes inbound `0x01` chunks into the round via [`RealtimeRound`]) and
    /// `realtime_sync` (which begins the round, sends the request, and blocks
    /// here for the reassembled response). The transport-agnostic framing
    /// logic lives in [`RealtimeRound`] (the lean client crate, shared with
    /// the Tauri plugin); this struct is just the thread rendezvous.
    #[derive(Default)]
    pub(super) struct RoundChannel {
        state: Mutex<RoundState>,
        ready: Condvar,
    }

    #[derive(Default)]
    struct RoundState {
        round: RealtimeRound,
        /// The completed round outcome, taken by `realtime_sync` once set.
        outcome: Option<Result<Vec<u8>, TransportError>>,
    }

    impl RoundChannel {
        /// Begin a round: frame the request (`0x01` tag + envelope) for the
        /// socket and mark it in flight. Errors if one is already in flight
        /// (§8.7 one-in-flight, enforced client-side).
        fn begin(&self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            let mut state = self.state.lock().expect("round lock");
            state.outcome = None;
            state.round.begin(request)
        }

        /// Route one inbound binary frame from the reader thread. Returns the
        /// delta payload to enqueue on the inbound buffer, if any; a completed
        /// or failed round is stored and the waiting `realtime_sync` woken.
        fn route_binary(&self, frame: &[u8]) -> Option<Vec<u8>> {
            let mut state = self.state.lock().expect("round lock");
            match state.round.route_binary(frame) {
                Ok(RoundInbound::Delta(body)) => Some(body),
                Ok(RoundInbound::RoundProgress) | Ok(RoundInbound::Ignored) => None,
                Ok(RoundInbound::RoundComplete(bytes)) => {
                    state.outcome = Some(Ok(bytes));
                    self.ready.notify_all();
                    None
                }
                Err(error) => {
                    state.outcome = Some(Err(error));
                    self.ready.notify_all();
                    None
                }
            }
        }

        /// Fail any in-flight round (socket dropped) and wake the waiter.
        fn fail_in_flight(&self, error: TransportError) {
            let mut state = self.state.lock().expect("round lock");
            if state.round.in_flight() && state.outcome.is_none() {
                state.round.abort();
                state.outcome = Some(Err(error));
                self.ready.notify_all();
            }
        }

        /// Block until the round completes, fails, or `ROUND_TIMEOUT` elapses.
        fn wait(&self) -> Result<Vec<u8>, TransportError> {
            let mut state = self.state.lock().expect("round lock");
            let deadline = std::time::Instant::now() + ROUND_TIMEOUT;
            while state.outcome.is_none() {
                let now = std::time::Instant::now();
                if now >= deadline {
                    state.round.abort();
                    return Err(TransportError::new(
                        "sync.transport_failed",
                        "realtime sync round timed out (§8.7)",
                    ));
                }
                let (guard, _timeout) = self
                    .ready
                    .wait_timeout(state, deadline - now)
                    .expect("round wait");
                state = guard;
            }
            state.outcome.take().expect("outcome present")
        }
    }

    fn http_err(op: &str, e: impl std::fmt::Display) -> TransportError {
        TransportError::new("transport.failed", format!("{op}: {e}"))
    }

    /// A read error that is merely "no data within the timeout" — the reader
    /// loops instead of tearing the socket down.
    fn is_would_block(e: &tungstenite::Error) -> bool {
        matches!(
            e,
            tungstenite::Error::Io(io) if matches!(
                io.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
        )
    }

    /// Apply the reader's per-iteration read timeout to the live stream so
    /// `ws.read()` yields the socket lock periodically (see `READ_TIMEOUT`).
    fn set_read_timeout(ws: &mut Ws, timeout: Option<Duration>) {
        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => {
                let _ = s.set_read_timeout(timeout);
            }
            MaybeTlsStream::Rustls(s) => {
                let _ = s.get_ref().set_read_timeout(timeout);
            }
            _ => {}
        }
    }

    pub struct NativeTransport {
        base_url: String,
        ws_url: String,
        /// Extra request headers (auth, actor/project ids) as (name, value).
        headers: Vec<(String, String)>,
        agent: ureq::Agent,
        pub signed_urls: bool,
        pub inbound: Arc<InboundBuffer>,
        /// The live socket, shared with the reader thread for sends.
        socket: Option<Arc<Mutex<Ws>>>,
        reader: Option<JoinHandle<()>>,
        reader_stop: Arc<AtomicBool>,
        /// §8.7 round rendezvous, shared with the reader thread.
        round: Arc<RoundChannel>,
    }

    fn derive_ws_url(base_url: &str) -> String {
        // {scheme}://host/path → ws(s)://host/path/realtime — the reference
        // realtime endpoint sits alongside /sync under the mount (§8.7).
        let ws = if let Some(rest) = base_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            base_url.to_owned()
        };
        let trimmed = ws.trim_end_matches('/');
        format!("{trimmed}/realtime")
    }

    impl NativeTransport {
        pub fn new(base_url: &str, config: &serde_json::Value) -> Result<Self, String> {
            let mut headers = Vec::new();
            if let Some(map) = config.get("headers").and_then(|v| v.as_object()) {
                for (k, v) in map {
                    if let Some(s) = v.as_str() {
                        headers.push((k.clone(), s.to_owned()));
                    }
                }
            }
            let ws_url = config
                .get("wsUrl")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| derive_ws_url(base_url));
            Ok(NativeTransport {
                base_url: base_url.trim_end_matches('/').to_owned(),
                ws_url,
                headers,
                agent: ureq::AgentBuilder::new().build(),
                signed_urls: false,
                inbound: Arc::new(InboundBuffer::default()),
                socket: None,
                reader: None,
                reader_stop: Arc::new(AtomicBool::new(false)),
                round: Arc::new(RoundChannel::default()),
            })
        }

        fn post_sync(&self, path: &str, body: &[u8]) -> Result<Vec<u8>, TransportError> {
            let url = format!("{}{}", self.base_url, path);
            // SSP2 requests carry their own media type (SPEC 1.1); a stock
            // server answers 415 to anything else.
            let mut req = self
                .agent
                .post(&url)
                .set("content-type", "application/vnd.syncular.sync.v2");
            for (k, v) in &self.headers {
                req = req.set(k, v);
            }
            let resp = req.send_bytes(body).map_err(|e| http_err("POST", e))?;
            read_body(resp)
        }

        fn get_bytes(&self, url: &str, with_headers: bool) -> Result<Vec<u8>, TransportError> {
            let mut req = self.agent.get(url);
            if with_headers {
                for (k, v) in &self.headers {
                    req = req.set(k, v);
                }
            }
            let resp = req.call().map_err(|e| http_err("GET", e))?;
            read_body(resp)
        }

        pub fn shutdown(&mut self) {
            self.reader_stop.store(true, Ordering::SeqCst);
            // Wake any `realtime_sync` blocked on a round: the socket is going
            // away, so the round can never complete (§8.7 mid-round drop).
            self.round.fail_in_flight(TransportError::new(
                "sync.transport_failed",
                "realtime disconnected mid-round (§8.7)",
            ));
            if let Some(socket) = &self.socket {
                if let Ok(mut ws) = socket.lock() {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                }
            }
            if let Some(handle) = self.reader.take() {
                let _ = handle.join();
            }
            self.socket = None;
        }
    }

    fn read_body(resp: ureq::Response) -> Result<Vec<u8>, TransportError> {
        let mut buf = Vec::new();
        resp.into_reader()
            .read_to_end(&mut buf)
            .map_err(|e| http_err("read", e))?;
        Ok(buf)
    }

    impl Transport for NativeTransport {
        fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.post_sync("/sync", request)
        }

        fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            // §8.7 socket round: send the request as a `0x01`-tagged chunk on
            // the connected socket and block for the reassembled response
            // stream (the reader thread demuxes `0x01` chunks to END, routing
            // any `0x00` delta / text that interleaves to the inbound queue).
            // When no socket is connected this is the client's "not connected"
            // path — the caller (client core) only calls `realtime_sync` while
            // `realtime_connected`, and connect established the socket; a
            // missing socket here means the round rides HTTP instead (same
            // rule as the TS client: `POST /sync` when the socket is absent).
            let Some(socket) = self.socket.clone() else {
                return self.post_sync("/sync", request);
            };
            let framed = self.round.begin(request)?;
            // Send the whole request as one `0x01` chunk (boundaries are
            // arbitrary, §8.7; the request is bounded — bulk rides segments).
            let send = {
                let mut ws = socket
                    .lock()
                    .map_err(|_| TransportError::new("transport.failed", "ws lock poisoned"))?;
                ws.send(Message::Binary(framed))
                    .map_err(|e| http_err("ws round send", &e))
                    .and_then(|()| ws.flush().map_err(|e| http_err("ws round flush", &e)))
            };
            if let Err(e) = send {
                // Fail the started round so `wait` returns the send error, not
                // a timeout.
                self.round.fail_in_flight(e);
            }
            self.round.wait()
        }

        fn download_segment(
            &mut self,
            request: &SegmentRequest,
        ) -> Result<Vec<u8>, TransportError> {
            // The FULL content address (`sha256:<hex>`) is the path param —
            // the reference server keys its segment store by it (§5.1) and
            // answers `sync.not_found` to a bare hex id. The requested-scopes
            // header carries what the pull round granted; the server
            // re-authorizes the download against it (§5.5) and answers
            // `sync.forbidden` when it is missing.
            let url = format!("{}/segments/{}", self.base_url, request.segment_id);
            let mut req = self
                .agent
                .get(&url)
                .set("x-syncular-scopes", &request.requested_scopes_json);
            for (k, v) in &self.headers {
                req = req.set(k, v);
            }
            let resp = req.call().map_err(|e| http_err("GET segment", e))?;
            read_body(resp)
        }

        fn supports_url_fetch(&self) -> bool {
            self.signed_urls
        }

        fn fetch_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
            // §5.4: the URL is the entire grant — no host credentials attached.
            self.get_bytes(url, false)
        }

        fn blob_upload(
            &mut self,
            blob_id: &str,
            bytes: &[u8],
            media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            // Full `sha256:<hex>` id in the path — the reference server's
            // isBlobId check rejects a bare hex id (§5.9.1).
            let url = format!("{}/blobs/{}", self.base_url, blob_id);
            let mut req = self.agent.put(&url).set(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            for (k, v) in &self.headers {
                req = req.set(k, v);
            }
            req.send_bytes(bytes).map_err(|e| http_err("PUT blob", e))?;
            Ok(())
        }

        fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
            // Full `sha256:<hex>` id in the path — the reference server's
            // isBlobId check rejects a bare hex id (§5.9.1).
            let url = format!("{}/blobs/{}", self.base_url, blob_id);
            let mut req = self.agent.get(&url);
            for (k, v) in &self.headers {
                req = req.set(k, v);
            }
            let resp = req.call().map_err(|e| {
                let e = http_err("GET blob", e);
                // Preserve a blob.* semantics hint (§5.9.5) for the caller.
                if e.code == "transport.failed" {
                    TransportError::new("blob.not_found", e.message)
                } else {
                    e
                }
            })?;
            // §5.9.5 always-issue: a JSON body carries a presigned `url`; an
            // octet-stream body is inline bytes.
            let is_json = resp
                .header("content-type")
                .is_some_and(|ct| ct.contains("application/json"));
            let body = read_body(resp)?;
            if is_json {
                if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&body) {
                    if let Some(u) = parsed.get("url").and_then(|v| v.as_str()) {
                        return Ok(BlobDownload::Url {
                            url: u.to_owned(),
                            url_expires_at_ms: parsed
                                .get("urlExpiresAtMs")
                                .and_then(|v| v.as_i64()),
                        });
                    }
                }
            }
            Ok(BlobDownload::Bytes(body))
        }

        fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
            // §5.9.5: the URL is the entire grant — no host credentials.
            self.get_bytes(url, false)
        }

        fn blob_upload_grant(
            &mut self,
            blob_id: &str,
            byte_length: u64,
            media_type: Option<&str>,
        ) -> Result<BlobUploadGrant, TransportError> {
            let url = format!("{}/blobs/{}/upload-grant", self.base_url, blob_id);
            let mut req = self
                .agent
                .post(&url)
                .set("content-type", "application/json");
            for (k, v) in &self.headers {
                req = req.set(k, v);
            }
            let body = serde_json::json!({
                "byteLength": byte_length,
                "mediaType": media_type,
            });
            let resp = req
                .send_string(&body.to_string())
                .map_err(|e| http_err("POST upload-grant", e))?;
            let grant_body = read_body(resp)?;
            let parsed: serde_json::Value = serde_json::from_slice(&grant_body)
                .map_err(|e| TransportError::new("transport.failed", format!("read grant: {e}")))?;
            if let Some(u) = parsed.get("url").and_then(|v| v.as_str()) {
                return Ok(BlobUploadGrant::Url {
                    url: u.to_owned(),
                    url_expires_at_ms: parsed.get("urlExpiresAtMs").and_then(|v| v.as_i64()),
                });
            }
            if parsed.get("present").and_then(|v| v.as_bool()) == Some(true) {
                return Ok(BlobUploadGrant::Present);
            }
            Ok(BlobUploadGrant::None)
        }

        fn blob_put_url(
            &mut self,
            url: &str,
            bytes: &[u8],
            media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            // §5.9.3: the presigned URL is the entire grant — no host auth.
            let req = self.agent.put(url).set(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            req.send_bytes(bytes)
                .map_err(|e| http_err("PUT blob url", e))?;
            Ok(())
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            if self.socket.is_some() {
                return Ok(());
            }
            // Build the client request VIA `IntoClientRequest` so tungstenite
            // fills the mandatory handshake headers (Host / Connection /
            // Upgrade / Sec-WebSocket-Version / Sec-WebSocket-Key); a
            // hand-built `http::Request` is taken as-is and would omit them.
            // Then layer the configured auth/actor headers on top.
            use tungstenite::client::IntoClientRequest;
            let mut request = self
                .ws_url
                .as_str()
                .into_client_request()
                .map_err(|e| TransportError::new("transport.failed", format!("ws url: {e}")))?;
            {
                let out = request.headers_mut();
                for (k, v) in &self.headers {
                    if let (Ok(name), Ok(value)) = (
                        tungstenite::http::HeaderName::try_from(k.as_str()),
                        tungstenite::http::HeaderValue::try_from(v.as_str()),
                    ) {
                        out.insert(name, value);
                    }
                }
            }
            let (mut ws, _resp) = tungstenite::connect(request)
                .map_err(|e| TransportError::new("transport.failed", format!("ws connect: {e}")))?;
            // Bound how long the reader holds the socket lock across `ws.read()`
            // so `realtime_sync` / ack sends can interleave promptly (§8.7 sends
            // and reads share one socket).
            set_read_timeout(&mut ws, Some(READ_TIMEOUT));
            let socket = Arc::new(Mutex::new(ws));
            self.socket = Some(Arc::clone(&socket));
            // Reader thread: demux inbound binary frames by §8.7 channel tag —
            // `0x01` round chunks feed the in-flight round (reassembled to END,
            // handed back to the blocked `realtime_sync`); `0x00` deltas + text
            // control frames go to the inbound buffer the command path drains.
            self.reader_stop.store(false, Ordering::SeqCst);
            let inbound = Arc::clone(&self.inbound);
            let stop = Arc::clone(&self.reader_stop);
            let reader_socket = Arc::clone(&socket);
            let round = Arc::clone(&self.round);
            self.reader = Some(std::thread::spawn(move || loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let msg = {
                    let mut ws = match reader_socket.lock() {
                        Ok(ws) => ws,
                        Err(_) => break,
                    };
                    ws.read()
                };
                match msg {
                    Ok(Message::Text(text)) => inbound.push(Inbound::Text(text)),
                    Ok(Message::Binary(bytes)) => {
                        // §8.7 tag demux: round chunk → round channel; delta →
                        // inbound (stripped of its tag, a bare SSP2 response
                        // the client applies exactly like a pull, §8.2).
                        if let Some(delta) = round.route_binary(&bytes) {
                            inbound.push(Inbound::Binary(delta));
                        }
                    }
                    // A read timeout is not a disconnect — loop and retry so a
                    // quiet socket stays open. The yield sleep runs OUTSIDE
                    // the socket lock so pending sends can interleave (see
                    // `READ_YIELD` — senders starve without it).
                    Err(e) if is_would_block(&e) => {
                        std::thread::sleep(READ_YIELD);
                        continue;
                    }
                    Ok(Message::Close(_)) | Err(_) => {
                        // The socket is gone: fail any in-flight round so a
                        // blocked `realtime_sync` wakes (§8.7 mid-round drop).
                        round.fail_in_flight(TransportError::new(
                            "sync.transport_failed",
                            "realtime disconnected mid-round (§8.7)",
                        ));
                        break;
                    }
                    Ok(_) => {}
                }
            }));
            Ok(())
        }

        fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
            let Some(socket) = &self.socket else {
                return Err(TransportError::new(
                    "transport.failed",
                    "realtime not connected",
                ));
            };
            let mut ws = socket
                .lock()
                .map_err(|_| TransportError::new("transport.failed", "ws lock poisoned"))?;
            ws.send(Message::Text(text.to_owned()))
                .map_err(|e| http_err("ws send", e))?;
            ws.flush().map_err(|e| http_err("ws flush", e))?;
            Ok(())
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            self.shutdown();
            Ok(())
        }
    }
}
