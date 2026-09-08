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

    fn http_err(op: &str, e: impl std::fmt::Display) -> TransportError {
        TransportError::new("transport.failed", format!("{op}: {e}"))
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
            let resp = req.send(body).map_err(|e| http_err("POST", e))?;
            read_body(resp)
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
                .map_err(|error| http_err("POST operation", error))?;
            read_body(response)
        }

        fn get_bytes(&self, url: &str, with_headers: bool) -> Result<Vec<u8>, TransportError> {
            let mut req = self.agent.get(url);
            if with_headers {
                for (k, v) in &self.headers {
                    req = req.header(k.as_str(), v.as_str());
                }
            }
            let resp = req.call().map_err(|e| http_err("GET", e))?;
            read_body(resp)
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
                    .map_err(|e| http_err("ws wake", e))?;
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

    fn read_body(resp: ureq::http::Response<ureq::Body>) -> Result<Vec<u8>, TransportError> {
        resp.into_body()
            .into_with_config()
            .read_to_vec()
            .map_err(|e| http_err("read", e))
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
            let mut req = self.agent.put(&url).header(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            req.send(bytes).map_err(|e| http_err("PUT blob", e))?;
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
                .headers()
                .get(ureq::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("application/json"));
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
            let req = self.agent.put(url).header(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            req.send(bytes).map_err(|e| http_err("PUT blob url", e))?;
            Ok(())
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            if self.outgoing.is_some() {
                return Ok(());
            }
            // Build the client request VIA `IntoClientRequest` so tungstenite
            // fills the mandatory handshake headers (Host / Connection /
            // Upgrade / Sec-WebSocket-Version / Sec-WebSocket-Key); a
            // hand-built `http::Request` is taken as-is and would omit them.
            // Then layer the configured auth/actor headers on top.
            use tungstenite::client::IntoClientRequest;
            let mut url = url::Url::parse(&self.ws_url)
                .map_err(|e| TransportError::new("transport.failed", format!("ws url: {e}")))?;
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
            .map_err(|e| http_err("ws clone", e))?;
            stream
                .set_nonblocking(true)
                .map_err(|e| http_err("ws nonblocking", e))?;
            let poller = Arc::new(Poller::new().map_err(|e| http_err("ws poller", e))?);
            // SAFETY: SocketRegistration owns this handle and unregisters it before drop.
            unsafe { poller.add(&stream, Event::readable(0)) }
                .map_err(|e| http_err("ws register", e))?;
            let registration = SocketRegistration {
                poller: Arc::clone(&poller),
                stream,
            };
            let (outgoing, queued) = mpsc::sync_channel::<Outgoing>(1);
            self.outgoing = Some(Box::new(SocketSender {
                queue: outgoing,
                poller,
            }));
            self.reader_stop.store(false, Ordering::SeqCst);
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
                                    break http_err("ws write", error);
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
                        Err(error) => break http_err("ws flush", error),
                    };
                    if !drained {
                        continue;
                    }
                    if let Err(error) = registration.poller.modify(&registration.stream, interest) {
                        break http_err("ws rearm", error);
                    }
                    events.clear();
                    if let Err(error) = registration.poller.wait(&mut events, None) {
                        if error.kind() != std::io::ErrorKind::Interrupted {
                            break http_err("ws wait", error);
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
}
