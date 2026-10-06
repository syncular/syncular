//! Shared native host transport for every Rust-backed Syncular binding.
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
//! Inbound realtime frames land in a shared queue the host drains after each
//! command. An optional wake callback lets mailbox-driven hosts react without
//! polling. The socket implementation is deliberately singular: fairness and
//! wire fixes therefore reach FFI, Tauri, and future Rust hosts together.

use std::sync::{Arc, Mutex};

use crate::{BlobDownload, BlobUploadGrant, SegmentRequest, Transport, TransportError};

/// One inbound realtime frame buffered for the client's `on_realtime_*`.
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
}

/// The shared inbound buffer the WS reader thread fills and the command path
/// drains. The optional callback carries no data; it only wakes an owning
/// mailbox so the host can drain the buffer promptly.
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
        inbound: Arc<InboundBuffer>,
    },
    #[cfg(feature = "native-transport")]
    Native(native::NativeTransport),
}

impl HostTransport {
    /// Build the transport from the `new` config. `{}` (or no `baseUrl`) →
    /// `Null`; a `baseUrl` under the `native-transport` feature → `Native`.
    pub fn from_config(config: &serde_json::Value) -> Result<Self, String> {
        Self::new_from_config(config)
    }

    /// [`Self::from_config`] for hosts outside this crate (the bench driver)
    /// that own their inbound-frame drain and need no FFI event queue.
    pub fn new_from_config(config: &serde_json::Value) -> Result<Self, String> {
        Self::from_config_with_notify(config, None)
    }

    /// Build a transport whose realtime reader wakes a mailbox/event loop.
    /// The callback is invoked after a frame is buffered and never carries
    /// protocol data itself.
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
                return Err(
                    "this build has no native transport (rebuild with --features native-transport)"
                        .to_owned(),
                );
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

    /// Network view for one I/O executor. The mutable owner keeps the reader
    /// and inbound queue; no SQLite state or new socket is created.
    pub fn fork_round(&self) -> Self {
        match self {
            Self::Null {
                signed_urls,
                inbound,
            } => Self::Null {
                signed_urls: *signed_urls,
                inbound: inbound.clone(),
            },
            #[cfg(feature = "native-transport")]
            Self::Native(t) => Self::Native(t.fork_round()),
        }
    }

    pub fn set_signed_urls(&mut self, value: bool) {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls = value,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls = value,
        }
    }

    /// Replace auth/application headers for subsequent HTTP requests and the
    /// next realtime connection. A live socket retains its handshake headers.
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

    fn remote_operation(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("remoteOperation")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.remote_operation(request),
        }
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeSync")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_sync(request),
        }
    }

    fn download_segment(
        &mut self,
        request: &SegmentRequest,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("downloadSegment")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.download_segment(request, on_progress),
        }
    }

    fn supports_url_fetch(&self) -> bool {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls,
        }
    }

    fn fetch_url(
        &mut self,
        url: &str,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("fetchUrl")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.fetch_url(url, on_progress),
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
            HostTransport::Native(t) => {
                t.set_realtime_client_id(None);
                t.realtime_connect()
            }
        }
    }

    fn realtime_connect_for_client(&mut self, client_id: &str) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeConnect")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => {
                t.set_realtime_client_id(Some(client_id));
                t.realtime_connect()
            }
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

    use std::net::TcpStream;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use polling::{Event, Events, Poller};
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::Message;

    use super::{Inbound, InboundBuffer};
    use crate::{
        BlobDownload, BlobUploadGrant, RealtimeRound, RoundInbound, SegmentRequest, Transport,
        TransportError,
    };

    // Unregister before the cloned socket handle is closed, including on unwind.
    struct SocketRegistration {
        poller: Arc<Poller>,
        stream: TcpStream,
    }

    impl Drop for SocketRegistration {
        fn drop(&mut self) {
            let _ = self.poller.delete(&self.stream);
        }
    }

    #[derive(Clone)]
    struct SocketSender {
        queue: mpsc::SyncSender<Outgoing>,
        poller: Arc<Poller>,
    }

    struct Outgoing {
        message: Message,
        completed: mpsc::Sender<Result<(), TransportError>>,
    }

    /// How long a single response round waits before giving up (§8.7 rounds
    /// are bounded — bulk rides segments over HTTP). Generous; a stuck socket
    /// surfaces as a transport failure rather than hanging the caller forever.
    const ROUND_TIMEOUT: Duration = Duration::from_secs(30);
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

    fn transfer_error(
        message: &'static str,
        cause_kind: &'static str,
        http_status: Option<u16>,
    ) -> TransportError {
        let mut details = serde_json::json!({ "causeKind": cause_kind });
        if let Some(status) = http_status {
            details["httpStatus"] = status.into();
        }
        let mut error = TransportError::new("transport.failed", message);
        error.details = Some(details);
        error
    }

    fn http_err(message: &'static str, error: ureq::Error) -> TransportError {
        let (kind, status) = match error {
            ureq::Error::StatusCode(status) => ("status", Some(status)),
            ureq::Error::Timeout(_) => ("timeout", None),
            ureq::Error::Io(error) => return io_err(message, error),
            ureq::Error::HostNotFound
            | ureq::Error::ConnectionFailed
            | ureq::Error::ConnectProxyFailed(_) => ("connect", None),
            ureq::Error::Tls(_)
            | ureq::Error::Rustls(_)
            | ureq::Error::Pem(_)
            | ureq::Error::TlsRequired => ("tls", None),
            ureq::Error::BadUri(_)
            | ureq::Error::Http(_)
            | ureq::Error::RequireHttpsOnly(_)
            | ureq::Error::InvalidProxyUrl => ("request", None),
            ureq::Error::Protocol(_) => ("protocol", None),
            ureq::Error::BodyExceedsLimit(_)
            | ureq::Error::BodyStalled
            | ureq::Error::Decompress(_, _) => ("body", None),
            ureq::Error::RedirectFailed | ureq::Error::TooManyRedirects => ("redirect", None),
            _ => ("unknown", None),
        };
        transfer_error(message, kind, status)
    }

    fn io_err(message: &'static str, error: std::io::Error) -> TransportError {
        let kind = match error.kind() {
            std::io::ErrorKind::TimedOut => "timeout",
            std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::NotConnected => "connect",
            _ => "io",
        };
        transfer_error(message, kind, None)
    }

    fn ws_err(message: &'static str, error: tungstenite::Error) -> TransportError {
        match error {
            tungstenite::Error::Io(error) => io_err(message, error),
            tungstenite::Error::Tls(_) => transfer_error(message, "tls", None),
            tungstenite::Error::Http(response) => {
                transfer_error(message, "status", Some(response.status().as_u16()))
            }
            tungstenite::Error::Url(_) | tungstenite::Error::HttpFormat(_) => {
                transfer_error(message, "request", None)
            }
            _ => transfer_error(message, "protocol", None),
        }
    }

    fn segment_error(mut error: TransportError) -> TransportError {
        error.code = "sync.transport_failed".into();
        error.message = "segment transfer failed".into();
        error
    }

    /// Nonblocking I/O needs a readiness notification before it can continue.
    fn is_would_block(e: &tungstenite::Error) -> bool {
        matches!(
            e,
            tungstenite::Error::Io(io) if matches!(
                io.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
        )
    }

    pub struct NativeTransport {
        base_url: String,
        ws_url: String,
        /// Extra request headers (auth, actor/project ids) as (name, value).
        headers: Vec<(String, String)>,
        agent: ureq::Agent,
        pub signed_urls: bool,
        pub inbound: Arc<InboundBuffer>,
        /// One I/O thread owns the socket; callers wait for their write to flush.
        outgoing: Option<Box<SocketSender>>,
        reader: Option<JoinHandle<()>>,
        reader_stop: Arc<AtomicBool>,
        /// §8.7 round rendezvous, shared with the reader thread.
        round: Arc<RoundChannel>,
        realtime_client_id: Option<String>,
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
        pub fn fork_round(&self) -> Self {
            Self {
                base_url: self.base_url.clone(),
                ws_url: self.ws_url.clone(),
                headers: self.headers.clone(),
                agent: self.agent.clone(),
                signed_urls: self.signed_urls,
                inbound: self.inbound.clone(),
                outgoing: self.outgoing.clone(),
                reader: None,
                reader_stop: self.reader_stop.clone(),
                round: self.round.clone(),
                realtime_client_id: self.realtime_client_id.clone(),
            }
        }

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
                agent: ureq::Agent::new_with_defaults(),
                signed_urls: false,
                inbound: Arc::new(match notify {
                    Some(notify) => InboundBuffer::with_notify(notify),
                    None => InboundBuffer::default(),
                }),
                outgoing: None,
                reader: None,
                reader_stop: Arc::new(AtomicBool::new(false)),
                round: Arc::new(RoundChannel::default()),
                realtime_client_id: None,
            })
        }

        fn post_sync(&self, path: &str, body: &[u8]) -> Result<Vec<u8>, TransportError> {
            let url = format!("{}{}", self.base_url, path);
            // SSP2 requests carry their own media type (SPEC 1.1); a stock
            // server answers 415 to anything else.
            let mut req = self
                .agent
                .post(&url)
                .header("content-type", "application/vnd.syncular.sync.v2");
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let resp = req
                .send(body)
                .map_err(|e| http_err("sync request failed", e))?;
            read_body(resp, None)
        }

        fn post_operation(&self, body: &[u8]) -> Result<Vec<u8>, TransportError> {
            let url = format!("{}/operations", self.base_url);
            let mut req = self.agent.post(&url).header(
                "content-type",
                "application/vnd.syncular.operations.v1+json",
            );
            for (key, value) in &self.headers {
                req = req.header(key.as_str(), value.as_str());
            }
            let response = req
                .send(body)
                .map_err(|error| http_err("remote operation request failed", error))?;
            read_body(response, None)
        }

        fn get_bytes(&self, url: &str, with_headers: bool) -> Result<Vec<u8>, TransportError> {
            let mut req = self.agent.get(url);
            if with_headers {
                for (k, v) in &self.headers {
                    req = req.header(k.as_str(), v.as_str());
                }
            }
            let resp = req.call().map_err(|e| http_err("URL fetch failed", e))?;
            read_body(resp, None)
        }

        pub fn set_headers(&mut self, headers: Vec<(String, String)>) {
            self.headers = headers;
        }

        pub fn set_realtime_client_id(&mut self, client_id: Option<&str>) {
            self.realtime_client_id = client_id.map(str::to_owned);
        }

        pub fn shutdown(&mut self) {
            self.reader_stop.store(true, Ordering::SeqCst);
            // Wake any `realtime_sync` blocked on a round: the socket is going
            // away, so the round can never complete (§8.7 mid-round drop).
            self.round.fail_in_flight(TransportError::new(
                "sync.transport_failed",
                "realtime disconnected mid-round (§8.7)",
            ));
            if let Some(outgoing) = &self.outgoing {
                let _ = outgoing.poller.notify();
            }
            if let Some(handle) = self.reader.take() {
                let _ = handle.join();
            }
            self.outgoing = None;
        }

        fn send_message(&mut self, message: Message) -> Result<(), TransportError> {
            let result = (|| {
                let Some(outgoing) = &self.outgoing else {
                    return Err(TransportError::new(
                        "transport.failed",
                        "realtime not connected",
                    ));
                };
                let (completed, result) = mpsc::channel();
                outgoing
                    .queue
                    .try_send(Outgoing { message, completed })
                    .map_err(|_| {
                        TransportError::new("transport.failed", "realtime send queue unavailable")
                    })?;
                outgoing
                    .poller
                    .notify()
                    .map_err(|e| io_err("realtime wake failed", e))?;
                result.recv_timeout(ROUND_TIMEOUT).map_err(|_| {
                    TransportError::new("transport.failed", "realtime send did not complete")
                })?
            })();
            // A failed/timed-out write must not remain eligible for delivery
            // behind a later command on the same connection.
            if result.is_err() {
                self.shutdown();
            }
            result
        }
    }

    fn read_body(
        resp: ureq::http::Response<ureq::Body>,
        mut progress: Option<&mut dyn FnMut(u64)>,
    ) -> Result<Vec<u8>, TransportError> {
        use std::io::Read;
        let status = resp.status().as_u16();
        let mut reader = resp.into_body().into_with_config().reader();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        let mut reported = 0;
        loop {
            let n = reader.read(&mut chunk).map_err(|error| {
                transfer_error(
                    "response body read failed",
                    if error.kind() == std::io::ErrorKind::TimedOut {
                        "timeout"
                    } else {
                        "body"
                    },
                    Some(status),
                )
            })?;
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
            if bytes.len() - reported >= 64 * 1024 {
                if let Some(callback) = progress.as_mut() {
                    callback(bytes.len() as u64);
                }
                reported = bytes.len();
            }
        }
        if bytes.len() != reported {
            if let Some(callback) = progress {
                callback(bytes.len() as u64);
            }
        }
        Ok(bytes)
    }

    impl Transport for NativeTransport {
        fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.post_sync("/sync", request)
        }

        fn remote_operation(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.post_operation(request)
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
            if self.outgoing.is_none() {
                return self.post_sync("/sync", request);
            }
            let framed = self.round.begin(request)?;
            if let Err(error) = self.send_message(Message::Binary(framed.into())) {
                self.round.fail_in_flight(error);
            }
            self.round.wait()
        }

        fn download_segment(
            &mut self,
            request: &SegmentRequest,
            on_progress: &mut dyn FnMut(u64),
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
                .header("x-syncular-scopes", &request.requested_scopes_json);
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let resp = req
                .call()
                .map_err(|error| segment_error(http_err("segment request failed", error)))?;
            read_body(resp, Some(on_progress)).map_err(segment_error)
        }

        fn supports_url_fetch(&self) -> bool {
            self.signed_urls
        }

        fn fetch_url(
            &mut self,
            url: &str,
            on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            // §5.4: the URL is the entire grant — no host credentials attached.
            let resp = self
                .agent
                .get(url)
                .call()
                .map_err(|error| segment_error(http_err("segment request failed", error)))?;
            read_body(resp, Some(on_progress)).map_err(segment_error)
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
            let mut req = self.agent.put(&url).header(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            req.send(bytes)
                .map_err(|e| http_err("blob upload failed", e))?;
            Ok(())
        }

        fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
            // Full `sha256:<hex>` id in the path — the reference server's
            // isBlobId check rejects a bare hex id (§5.9.1).
            let url = format!("{}/blobs/{}", self.base_url, blob_id);
            let mut req = self.agent.get(&url);
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let resp = req.call().map_err(|cause| {
                let status = match &cause {
                    ureq::Error::StatusCode(status) => Some(*status),
                    _ => None,
                };
                let mut error = http_err("blob download failed", cause);
                match status {
                    Some(404) => {
                        error.code = "blob.not_found".into();
                        error.message = "blob not found".into();
                    }
                    Some(403) => {
                        error.code = "blob.forbidden".into();
                        error.message = "blob download forbidden".into();
                    }
                    Some(401) => {
                        error.code = "sync.auth_required".into();
                        error.message = "host authentication required".into();
                    }
                    _ => {}
                }
                error
            })?;
            // §5.9.5 always-issue: a JSON body carries a presigned `url`; an
            // octet-stream body is inline bytes.
            let is_json = resp
                .headers()
                .get(ureq::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("application/json"));
            let body = read_body(resp, None)?;
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
                .header("content-type", "application/json");
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let body = serde_json::json!({
                "byteLength": byte_length,
                "mediaType": media_type,
            });
            let resp = req
                .send(body.to_string())
                .map_err(|e| http_err("blob upload grant request failed", e))?;
            let grant_body = read_body(resp, None)?;
            let parsed: serde_json::Value = serde_json::from_slice(&grant_body)
                .map_err(|_| transfer_error("blob upload grant decode failed", "decode", None))?;
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
            let req = self.agent.put(url).header(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            req.send(bytes)
                .map_err(|e| http_err("signed blob upload failed", e))?;
            Ok(())
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            if self.outgoing.is_some() {
                if self.reader_stop.load(Ordering::SeqCst)
                    || self
                        .reader
                        .as_ref()
                        .is_some_and(|reader| reader.is_finished())
                {
                    self.shutdown();
                } else {
                    return Ok(());
                }
            }
            // Build the client request VIA `IntoClientRequest` so tungstenite
            // fills the mandatory handshake headers (Host / Connection /
            // Upgrade / Sec-WebSocket-Version / Sec-WebSocket-Key); a
            // hand-built `http::Request` is taken as-is and would omit them.
            // Then layer the configured auth/actor headers on top.
            use tungstenite::client::IntoClientRequest;
            let mut url = url::Url::parse(&self.ws_url)
                .map_err(|_| transfer_error("realtime URL invalid", "request", None))?;
            if let Some(client_id) = self.realtime_client_id.as_deref() {
                let retained_query: Vec<(String, String)> = url
                    .query_pairs()
                    .filter(|(key, _)| key != "clientId")
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect();
                url.set_query(None);
                url.query_pairs_mut()
                    .extend_pairs(retained_query)
                    .append_pair("clientId", client_id);
            }
            let mut request = url
                .as_str()
                .into_client_request()
                .map_err(|error| ws_err("realtime request failed", error))?;
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
                .map_err(|error| ws_err("realtime connection failed", error))?;
            let stream = match ws.get_mut() {
                MaybeTlsStream::Plain(stream) => stream.try_clone(),
                MaybeTlsStream::Rustls(stream) => stream.get_ref().try_clone(),
                _ => {
                    return Err(TransportError::new(
                        "transport.failed",
                        "unsupported websocket stream",
                    ))
                }
            }
            .map_err(|e| io_err("realtime clone failed", e))?;
            stream
                .set_nonblocking(true)
                .map_err(|e| io_err("realtime nonblocking failed", e))?;
            let poller = Arc::new(Poller::new().map_err(|e| io_err("realtime poller failed", e))?);
            // SAFETY: SocketRegistration owns this handle and unregisters it before drop.
            unsafe { poller.add(&stream, Event::readable(0)) }
                .map_err(|e| io_err("realtime register failed", e))?;
            let registration = SocketRegistration {
                poller: Arc::clone(&poller),
                stream,
            };
            let (outgoing, queued) = mpsc::sync_channel::<Outgoing>(1);
            self.outgoing = Some(Box::new(SocketSender {
                queue: outgoing,
                poller,
            }));
            self.reader_stop = Arc::new(AtomicBool::new(false));
            self.round = Arc::new(RoundChannel::default());
            let inbound = Arc::clone(&self.inbound);
            let stop = Arc::clone(&self.reader_stop);
            let round = Arc::clone(&self.round);
            self.reader = Some(std::thread::spawn(move || {
                let mut events = Events::new();
                let mut pending: Option<mpsc::Sender<Result<(), TransportError>>> = None;
                let failure = 'io: loop {
                    if stop.load(Ordering::SeqCst) {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        break TransportError::new(
                            "sync.transport_failed",
                            "realtime disconnected mid-round (§8.7)",
                        );
                    }
                    if pending.is_none() {
                        if let Ok(outgoing) = queued.try_recv() {
                            pending = Some(outgoing.completed);
                            // WouldBlock retains the frame in tungstenite's write buffer.
                            if let Err(error) = ws.write(outgoing.message) {
                                if !is_would_block(&error) {
                                    break ws_err("realtime write failed", error);
                                }
                            }
                        }
                    }
                    // Bound receive work so a continuously readable peer cannot starve sends.
                    let mut drained = false;
                    for _ in 0..64 {
                        match ws.read() {
                            Ok(Message::Text(text)) => {
                                inbound.push(Inbound::Text(text.to_string()))
                            }
                            Ok(Message::Binary(bytes)) => {
                                if let Some(delta) = round.route_binary(&bytes) {
                                    inbound.push(Inbound::Binary(delta));
                                }
                            }
                            Err(error) if is_would_block(&error) => {
                                drained = true;
                                break;
                            }
                            Ok(Message::Close(_)) => {
                                let _ = ws.flush();
                                break 'io TransportError::new(
                                    "sync.transport_failed",
                                    "realtime disconnected mid-round (§8.7)",
                                );
                            }
                            Err(_) => {
                                break 'io TransportError::new(
                                    "sync.transport_failed",
                                    "realtime disconnected mid-round (§8.7)",
                                );
                            }
                            Ok(_) => {}
                        }
                    }
                    let interest = match ws.flush() {
                        Ok(()) => {
                            if let Some(completed) = pending.take() {
                                let _ = completed.send(Ok(()));
                            }
                            Event::readable(0)
                        }
                        Err(error) if is_would_block(&error) => Event::all(0),
                        Err(error) => break ws_err("realtime flush failed", error),
                    };
                    if !drained {
                        continue;
                    }
                    if let Err(error) = registration.poller.modify(&registration.stream, interest) {
                        break io_err("realtime rearm failed", error);
                    }
                    events.clear();
                    if let Err(error) = registration.poller.wait(&mut events, None) {
                        if error.kind() != std::io::ErrorKind::Interrupted {
                            break io_err("realtime wait failed", error);
                        }
                    }
                };
                if let Some(completed) = pending {
                    let _ = completed.send(Err(failure.clone()));
                }
                while let Ok(outgoing) = queued.try_recv() {
                    let _ = outgoing.completed.send(Err(failure.clone()));
                }
                round.fail_in_flight(failure);
            }));
            Ok(())
        }

        fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
            self.send_message(Message::Text(text.to_owned().into()))
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            self.shutdown();
            Ok(())
        }
    }
    #[cfg(test)]
    mod transfer_tests {
        use super::*;
        use ureq::unversioned::resolver::DefaultResolver;
        use ureq::unversioned::transport::{ConnectionDetails, Connector};

        const SECRET: &str = "https://user:password@cdn.example/secret-capability-path?secret-query=value#secret-fragment";

        #[derive(Debug)]
        struct SecretError;
        impl std::fmt::Display for SecretError {
            fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                panic!("transport error must never be formatted")
            }
        }
        impl std::error::Error for SecretError {}

        #[derive(Debug)]
        struct FailingConnector(&'static str);
        impl Connector for FailingConnector {
            type Out = ();
            fn connect(
                &self,
                _: &ConnectionDetails,
                _: Option<()>,
            ) -> Result<Option<()>, ureq::Error> {
                Err(match self.0 {
                    "io" => ureq::Error::Io(std::io::Error::new(
                        std::io::ErrorKind::ConnectionRefused,
                        format!("404 {SECRET}"),
                    )),
                    "tls" => ureq::Error::Tls(SECRET),
                    "request" => ureq::Error::BadUri(SECRET.into()),
                    "timeout" => ureq::Error::Timeout(ureq::Timeout::Global),
                    "404" => ureq::Error::StatusCode(404),
                    "401" => ureq::Error::StatusCode(401),
                    "403" => ureq::Error::StatusCode(403),
                    "503" => ureq::Error::StatusCode(503),
                    _ => ureq::Error::Other(Box::new(SecretError)),
                })
            }
        }

        #[test]
        fn injected_http_failures_never_expose_capabilities_or_format_the_cause() {
            for kind in [
                "io", "tls", "request", "timeout", "unknown", "404", "401", "403", "503",
            ] {
                for operation in [
                    "sync",
                    "remote",
                    "segment",
                    "signed_segment",
                    "blob",
                    "signed_blob",
                    "upload",
                    "grant",
                    "signed_put",
                ] {
                    let mut transport =
                        NativeTransport::new("http://127.0.0.1", &serde_json::json!({}), None)
                            .unwrap();
                    transport.agent = ureq::Agent::with_parts(
                        ureq::Agent::config_builder().build(),
                        FailingConnector(kind),
                        DefaultResolver::default(),
                    );
                    let mut progress = |_| {};
                    let result = match operation {
                        "sync" => transport.sync(&[]).map(|_| ()),
                        "remote" => transport.remote_operation(&[]).map(|_| ()),
                        "segment" => transport.download_segment(&SegmentRequest { segment_id: "sha256:test".into(), table: "tasks".into(), requested_scopes_json: "{}".into() }, &mut progress).map(|_| ()),
                        "signed_segment" => transport.fetch_url("http://127.0.0.1/secret-capability-path?secret-query=value#secret-fragment", &mut progress).map(|_| ()),
                        "blob" => transport.blob_download("sha256:test").map(|_| ()),
                        "signed_blob" => transport.fetch_blob_url("http://127.0.0.1/secret-capability-path?secret-query=value#secret-fragment").map(|_| ()),
                        "upload" => transport.blob_upload("sha256:test", &[], None),
                        "grant" => transport.blob_upload_grant("sha256:test", 0, None).map(|_| ()),
                        _ => transport.blob_put_url("http://127.0.0.1/secret-capability-path?secret-query=value#secret-fragment", &[], None),
                    };
                    let error = result.unwrap_err();
                    let expected_code = match (operation, kind) {
                        ("segment" | "signed_segment", _) => "sync.transport_failed",
                        ("blob", "404") => "blob.not_found",
                        ("blob", "401") => "sync.auth_required",
                        ("blob", "403") => "blob.forbidden",
                        _ => "transport.failed",
                    };
                    assert_eq!(error.code, expected_code, "{operation} {kind}");
                    let details = error.details.unwrap();
                    assert_eq!(
                        details["causeKind"],
                        match kind {
                            "io" => "connect",
                            "404" | "401" | "403" | "503" => "status",
                            other => other,
                        }
                    );
                    assert_eq!(
                        details.get("httpStatus").and_then(|value| value.as_u64()),
                        kind.parse::<u64>().ok()
                    );
                    let rendered = format!("{}{}", error.message, details);
                    for secret in [
                        "http://",
                        "https://",
                        "password",
                        "secret-capability-path",
                        "secret-query",
                        "secret-fragment",
                    ] {
                        assert!(!rendered.contains(secret), "{operation} {kind}");
                    }
                    assert!(details.get("causeMessage").is_none());
                    assert!(details.get("path").is_none());
                }
            }
        }

        #[test]
        fn injected_body_and_websocket_errors_do_not_expose_payloads_or_source_chains() {
            struct FailingRead;
            impl std::io::Read for FailingRead {
                fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                    Err(std::io::Error::other(SECRET))
                }
            }
            let response = ureq::http::Response::builder()
                .status(200)
                .body(ureq::Body::builder().reader(FailingRead))
                .unwrap();
            let error = segment_error(read_body(response, None).unwrap_err());
            assert_eq!(error.code, "sync.transport_failed");
            assert_eq!(error.message, "segment transfer failed");
            assert_eq!(
                error.details,
                Some(serde_json::json!({ "causeKind": "body", "httpStatus": 200 }))
            );
            for cause in [
                tungstenite::Error::Io(std::io::Error::other(SecretError)),
                tungstenite::Error::Http(Box::new(
                    tungstenite::http::Response::builder()
                        .status(403)
                        .header("location", SECRET)
                        .body(Some(SECRET.as_bytes().to_vec()))
                        .unwrap(),
                )),
            ] {
                let error = ws_err("realtime connection failed", cause);
                assert_eq!(error.message, "realtime connection failed");
                let details = error.details.unwrap();
                assert!(details.get("path").is_none());
                assert!(details.get("causeMessage").is_none());
                assert!(!details.to_string().contains("secret"));
            }
        }
    }
}

#[cfg(all(test, feature = "native-transport"))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    fn detached_round_uses_the_owned_socket_and_shutdown_releases_it() {
        use ssp2::model::{Frame, Message, MsgKind};
        use std::sync::mpsc::channel;
        for cancelled in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let (entered_tx, entered_rx) = channel();
            let (release_tx, release_rx) = channel();
            let server = std::thread::spawn(move || {
                let (socket, _) = listener.accept().unwrap();
                let mut socket = tungstenite::accept(socket).unwrap();
                let request = socket.read().unwrap().into_data();
                assert_eq!(request[0], crate::REALTIME_TAG_ROUND);
                assert_eq!(
                    ssp2::decode_message(&request[1..]).unwrap().msg_kind,
                    MsgKind::Request
                );
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                if !cancelled {
                    let response = ssp2::encode_message(&Message {
                        wire_version: ssp2::decode::WIRE_VERSION,
                        msg_kind: MsgKind::Response,
                        frames: vec![Frame::RespHeader {
                            required_schema_version: None,
                            latest_schema_version: None,
                            log_epoch: Some("epoch".into()),
                            reset_required: Some(true),
                        }],
                    });
                    let mut chunk = vec![crate::REALTIME_TAG_ROUND];
                    chunk.extend(response);
                    socket
                        .send(tungstenite::Message::Binary(chunk.into()))
                        .unwrap();
                }
            });
            let mut owner =
                HostTransport::new_from_config(&serde_json::json!({"baseUrl":base})).unwrap();
            owner.realtime_connect_for_client("detached-round").unwrap();
            let mut detached = owner.fork_round();
            let network = std::thread::spawn(move || {
                let request = ssp2::encode_message(&Message {
                    wire_version: ssp2::decode::WIRE_VERSION,
                    msg_kind: MsgKind::Request,
                    frames: vec![
                        Frame::ReqHeader {
                            client_id: "detached-round".into(),
                            schema_version: 1,
                            log_epoch: None,
                        },
                        Frame::PullHeader {
                            limit_commits: 0,
                            limit_snapshot_rows: 0,
                            max_snapshot_pages: 0,
                            accept: 3,
                        },
                    ],
                });
                detached.realtime_sync(&request)
            });
            entered_rx.recv().unwrap();
            owner.set_headers(vec![("authorization".into(), "Bearer rotated".into())]);
            assert!(owner.take_inbound().is_empty());
            if cancelled {
                owner.shutdown();
            }
            release_tx.send(()).unwrap();
            let response = network.join().unwrap();
            if cancelled {
                assert!(response.is_err());
            } else {
                assert_eq!(
                    ssp2::decode_message(&response.unwrap()).unwrap().msg_kind,
                    MsgKind::Response
                );
                owner.shutdown();
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn segment_http_failures_have_named_codes_and_safe_cause_details() {
        for signed in [false, true] {
            for body_failure in [false, true] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let base = format!("http://{}", listener.local_addr().unwrap());
                let server = std::thread::spawn(move || {
                    let (mut socket, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(socket.try_clone().unwrap());
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        assert!(!line.is_empty());
                    }
                    socket.write_all(if body_failure {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\nshort"
                    } else {
                        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    }).unwrap();
                });
                let mut transport =
                    HostTransport::new_from_config(&serde_json::json!({"baseUrl": base})).unwrap();
                let mut progress = |_| {};
                let error = if signed {
                    transport.fetch_url(&format!("{base}/signed?signature=secret"), &mut progress)
                } else {
                    transport.download_segment(
                        &SegmentRequest {
                            segment_id: "sha256:test".into(),
                            table: "tasks".into(),
                            requested_scopes_json: "{}".into(),
                        },
                        &mut progress,
                    )
                }
                .unwrap_err();
                assert_eq!(error.code, "sync.transport_failed");
                assert_eq!(error.message, "segment transfer failed");
                let details = error.details.unwrap();
                assert!(details.get("path").is_none());
                assert!(details.get("causeMessage").is_none());
                assert_eq!(
                    details["causeKind"],
                    if body_failure { "body" } else { "status" }
                );
                assert_eq!(details["httpStatus"], if body_failure { 200 } else { 403 });
                server.join().unwrap();
            }
        }
    }

    #[test]
    fn blob_status_classification_uses_the_actual_http_response() {
        for (status, expected) in [
            (404, "blob.not_found"),
            (401, "sync.auth_required"),
            (403, "blob.forbidden"),
            (500, "transport.failed"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    assert!(!line.is_empty());
                }
                let body = r#"{"code":"blob.not_found","message":"https://host/secret-path?secret-query#secret-fragment","retryable":false}"#;
                write!(socket, "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let mut transport =
                HostTransport::new_from_config(&serde_json::json!({"baseUrl":base})).unwrap();
            let error = transport.blob_download("sha256:test").unwrap_err();
            assert_eq!(error.code, expected);
            assert_eq!(
                error.details,
                Some(serde_json::json!({ "causeKind":"status", "httpStatus":status }))
            );
            assert!(!error.message.contains("secret"));
            assert!(!error.message.contains("http"));
            server.join().unwrap();
        }
    }

    #[test]
    fn refused_segment_connection_has_a_named_code_without_an_invented_status() {
        for signed in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            drop(listener);
            let mut transport =
                HostTransport::new_from_config(&serde_json::json!({"baseUrl": base})).unwrap();
            let mut progress = |_| {};
            let error = if signed {
                transport.fetch_url(&format!("{base}/signed?signature=secret"), &mut progress)
            } else {
                transport.download_segment(
                    &SegmentRequest {
                        segment_id: "sha256:test".into(),
                        table: "tasks".into(),
                        requested_scopes_json: "{}".into(),
                    },
                    &mut progress,
                )
            }
            .unwrap_err();
            assert_eq!(error.code, "sync.transport_failed");
            assert!(error.details.as_ref().unwrap().get("httpStatus").is_none());
        }
    }

    #[test]
    fn segment_http_reports_intermediate_bytes_for_direct_and_signed_urls() {
        for signed in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    assert!(!line.is_empty());
                    headers.push_str(&line.to_ascii_lowercase());
                }
                assert_eq!(headers.contains("authorization: bearer test"), !signed);
                assert_eq!(headers.contains("x-syncular-scopes:"), !signed);
                let bytes = vec![7; 128 * 1024 + 17];
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                )
                .unwrap();
                socket.write_all(&bytes).unwrap();
            });
            let mut transport = HostTransport::from_config(
                &serde_json::json!({"baseUrl": base, "headers": {"authorization": "Bearer test"}}),
            )
            .unwrap();
            let mut updates = Vec::new();
            let mut progress = |bytes| updates.push(bytes);
            let bytes = if signed {
                transport
                    .fetch_url(&format!("{base}/signed"), &mut progress)
                    .unwrap()
            } else {
                transport
                    .download_segment(
                        &SegmentRequest {
                            segment_id: "sha256:test".into(),
                            table: "tasks".into(),
                            requested_scopes_json: "{}".into(),
                        },
                        &mut progress,
                    )
                    .unwrap()
            };
            assert_eq!(bytes.len(), 128 * 1024 + 17);
            assert!(updates.iter().any(|n| *n > 0 && *n < bytes.len() as u64));
            assert_eq!(updates.last(), Some(&(bytes.len() as u64)));
            assert!(updates.windows(2).all(|pair| pair[0] < pair[1]));
            server.join().unwrap();
        }
    }
}
