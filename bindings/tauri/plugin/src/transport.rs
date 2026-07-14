//! The transport the plugin core OWNS — the same two-shape design as the FFI
//! crate's transport (a native app has no host loop to invert transport into,
//! unlike the conformance shim, so the Rust core drives the network itself).
//!
//! - `Null` (dependency-lean default): every network op fails loudly with
//!   `transport.unavailable`; client-local commands (create/subscribe/mutate/
//!   query/…) still run. Enough for the unit tests and an offline app.
//! - `Native` (the `native-transport` feature): a real blocking HTTP (`ureq`)
//!   plus WS (`tungstenite`) client with a reader thread buffering inbound
//!   frames. This is what apps get so sync/segments/blobs/realtime all work.
//!
//! Kept deliberately parallel to `rust/crates/ffi/src/transport.rs`; the only
//! difference is that this one carries no `EventQueue` (the plugin core derives
//! events from client state after each drain, so the transport just buffers raw
//! inbound frames).

use std::sync::{Arc, Mutex};

use syncular_client::{BlobDownload, BlobUploadGrant, SegmentRequest, Transport, TransportError};

/// One inbound realtime frame buffered for the client's `on_realtime_*`.
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
}

/// The shared inbound buffer the WS reader thread fills and the command path
/// drains after each command.
pub struct InboundBuffer {
    frames: Mutex<Vec<Inbound>>,
    notify: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Default for InboundBuffer {
    fn default() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            notify: None,
        }
    }
}

impl InboundBuffer {
    pub fn with_notify(notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            notify: Some(notify),
        }
    }

    pub fn push(&self, frame: Inbound) {
        self.frames.lock().expect("inbound lock").push(frame);
        if let Some(notify) = &self.notify {
            notify();
        }
    }
    fn take(&self) -> Vec<Inbound> {
        std::mem::take(&mut *self.frames.lock().expect("inbound lock"))
    }
}

pub enum HostTransport {
    /// No network: client-local commands only (dependency-lean default).
    Null {
        signed_urls: bool,
        inbound: std::sync::Arc<InboundBuffer>,
    },
    #[cfg(feature = "native-transport")]
    Native(native::NativeTransport),
}

impl HostTransport {
    /// Build the transport from the plugin config. `{}` (or no `baseUrl`) →
    /// `Null`; a `baseUrl` under the `native-transport` feature → `Native`.
    pub fn from_config(config: &serde_json::Value) -> Result<Self, String> {
        Self::from_config_with_notify(config, None)
    }

    pub fn from_config_with_notify(
        config: &serde_json::Value,
        notify: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Result<Self, String> {
        #[cfg(feature = "native-transport")]
        {
            if let Some(base_url) = config.get("baseUrl").and_then(|v| v.as_str()) {
                return Ok(HostTransport::Native(native::NativeTransport::new(
                    base_url, config, notify,
                )?));
            }
        }
        #[cfg(not(feature = "native-transport"))]
        {
            if config.get("baseUrl").is_some() {
                return Err("this build has no native transport (enable the \
                    native-transport feature on tauri-plugin-syncular)"
                    .to_owned());
            }
        }
        Ok(HostTransport::Null {
            signed_urls: false,
            inbound: Arc::new(match notify {
                Some(notify) => InboundBuffer::with_notify(notify),
                None => InboundBuffer::default(),
            }),
        })
    }

    pub fn set_signed_urls(&mut self, value: bool) {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls = value,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls = value,
        }
    }

    /// Replace the extra request headers at runtime (rotating auth — RFC 0002
    /// §2.3). HTTP requests use the new set from the next call; the WS
    /// handshake reads headers at connect, so a live realtime socket keeps
    /// its old set until it reconnects. A `Null` transport accepts and
    /// ignores the set (it never sends requests).
    pub fn set_headers(&mut self, headers: Vec<(String, String)>) {
        match self {
            HostTransport::Null { .. } => drop(headers),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.set_headers(headers),
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
        format!("{op} needs the native transport (enable the native-transport feature)"),
    )
}

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
            HostTransport::Null { .. } => Ok(BlobUploadGrant::None),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.blob_upload_grant(blob_id, byte_length, media_type),
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
    //! The real native HTTP + WS transport (mirrors the FFI crate's `native`
    //! module: `ureq` blocking HTTP, `tungstenite` sync WS, a reader thread
    //! buffering inbound frames — matching the client's synchronous API).

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
        BlobDownload, RealtimeRound, RoundInbound, SegmentRequest, Transport, TransportError,
    };

    type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

    // §8.7 round-over-socket framing — kept byte-for-byte parallel with
    // `rust/crates/ffi/src/transport.rs`'s `native` module (see that file for
    // the full commentary). The transport-agnostic tag demux + reassembly
    // lives in `syncular_client::RealtimeRound`, shared by both crates; only
    // the WS send/read plumbing is mirrored here (the crates are in separate
    // cargo workspaces and cannot share a private module).
    const ROUND_TIMEOUT: Duration = Duration::from_secs(30);
    const READ_TIMEOUT: Duration = Duration::from_millis(50);

    /// The §8.7 round rendezvous shared between the reader thread and
    /// `realtime_sync`. See the FFI crate's `RoundChannel` for details.
    #[derive(Default)]
    pub(super) struct RoundChannel {
        state: Mutex<RoundState>,
        ready: Condvar,
    }

    #[derive(Default)]
    struct RoundState {
        round: RealtimeRound,
        outcome: Option<Result<Vec<u8>, TransportError>>,
    }

    impl RoundChannel {
        fn begin(&self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            let mut state = self.state.lock().expect("round lock");
            state.outcome = None;
            state.round.begin(request)
        }

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

        fn fail_in_flight(&self, error: TransportError) {
            let mut state = self.state.lock().expect("round lock");
            if state.round.in_flight() && state.outcome.is_none() {
                state.round.abort();
                state.outcome = Some(Err(error));
                self.ready.notify_all();
            }
        }

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

    fn is_would_block(e: &tungstenite::Error) -> bool {
        matches!(
            e,
            tungstenite::Error::Io(io) if matches!(
                io.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
        )
    }

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
        headers: Vec<(String, String)>,
        agent: ureq::Agent,
        pub signed_urls: bool,
        pub inbound: Arc<InboundBuffer>,
        socket: Option<Arc<Mutex<Ws>>>,
        reader: Option<JoinHandle<()>>,
        reader_stop: Arc<AtomicBool>,
        round: Arc<RoundChannel>,
    }

    fn http_err(op: &str, e: impl std::fmt::Display) -> TransportError {
        TransportError::new("transport.failed", format!("{op}: {e}"))
    }

    fn derive_ws_url(base_url: &str) -> String {
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
        pub fn new(
            base_url: &str,
            config: &serde_json::Value,
            notify: Option<Arc<dyn Fn() + Send + Sync>>,
        ) -> Result<Self, String> {
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
                inbound: Arc::new(match notify {
                    Some(notify) => InboundBuffer::with_notify(notify),
                    None => InboundBuffer::default(),
                }),
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

        /// Replace the per-request headers (see `HostTransport::set_headers`).
        pub fn set_headers(&mut self, headers: Vec<(String, String)>) {
            self.headers = headers;
        }

        pub fn shutdown(&mut self) {
            self.reader_stop.store(true, Ordering::SeqCst);
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
            // the connected socket, block for the reassembled response stream.
            // No socket connected → the round rides HTTP (same rule as the TS
            // client: `POST /sync` when the socket is absent).
            let Some(socket) = self.socket.clone() else {
                return self.post_sync("/sync", request);
            };
            let framed = self.round.begin(request)?;
            let send = {
                let mut ws = socket
                    .lock()
                    .map_err(|_| TransportError::new("transport.failed", "ws lock poisoned"))?;
                ws.send(Message::Binary(framed))
                    .map_err(|e| http_err("ws round send", &e))
                    .and_then(|()| ws.flush().map_err(|e| http_err("ws round flush", &e)))
            };
            if let Err(e) = send {
                self.round.fail_in_flight(e);
            }
            self.round.wait()
        }

        fn download_segment(
            &mut self,
            request: &SegmentRequest,
        ) -> Result<Vec<u8>, TransportError> {
            let id = request
                .segment_id
                .strip_prefix("sha256:")
                .unwrap_or(&request.segment_id);
            let url = format!("{}/segments/{}", self.base_url, id);
            self.get_bytes(&url, true)
        }

        fn supports_url_fetch(&self) -> bool {
            self.signed_urls
        }

        fn fetch_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
            self.get_bytes(url, false)
        }

        fn blob_upload(
            &mut self,
            blob_id: &str,
            bytes: &[u8],
            media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            let id = blob_id.strip_prefix("sha256:").unwrap_or(blob_id);
            let url = format!("{}/blobs/{}", self.base_url, id);
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
            let id = blob_id.strip_prefix("sha256:").unwrap_or(blob_id);
            let url = format!("{}/blobs/{}", self.base_url, id);
            let mut req = self.agent.get(&url);
            for (k, v) in &self.headers {
                req = req.set(k, v);
            }
            let resp = req.call().map_err(|e| {
                let e = http_err("GET blob", e);
                if e.code == "transport.failed" {
                    TransportError::new("blob.not_found", e.message)
                } else {
                    e
                }
            })?;
            // 5.9.5 always-issue: a JSON body carries a presigned `url`; an
            // octet-stream body is inline bytes. (Mirrors the FFI transport.)
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
            // 5.9.5: the URL is the entire grant — no host credentials.
            self.get_bytes(url, false)
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            if self.socket.is_some() {
                return Ok(());
            }
            // Build via `IntoClientRequest` so tungstenite fills the mandatory
            // WS handshake headers (a hand-built `http::Request` would omit
            // them); then layer the configured auth/actor headers on top.
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
            set_read_timeout(&mut ws, Some(READ_TIMEOUT));
            let socket = Arc::new(Mutex::new(ws));
            self.socket = Some(Arc::clone(&socket));
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
                        // §8.7 tag demux: `0x01` round chunk → round channel;
                        // `0x00` delta → inbound (tag stripped, a bare SSP2
                        // response the client applies like a pull, §8.2).
                        if let Some(delta) = round.route_binary(&bytes) {
                            inbound.push(Inbound::Binary(delta));
                        }
                    }
                    Err(e) if is_would_block(&e) => continue,
                    Ok(Message::Close(_)) | Err(_) => {
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
