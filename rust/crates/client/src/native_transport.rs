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
//! - `Local` (the `local-authority` feature, a `localAuthorityPath` config):
//!   §12.4 routing over either shape above. Sync rounds reach the in-process
//!   local authority until attach completes, then the remote transport.
//!
//! Inbound realtime frames land in a shared queue the host drains after each
//! command. An optional wake callback lets mailbox-driven hosts react without
//! polling. The socket implementation is deliberately singular: fairness and
//! wire fixes therefore reach FFI, Tauri, and future Rust hosts together.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::{
    BlobDownload, BlobUploadGrant, SegmentFetch, SegmentRequest, Transport, TransportError,
};

/// Redirect handling for native HTTP requests and the WebSocket handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RedirectPolicy {
    /// Never follow a 3xx. A redirected request would replay configured
    /// headers, URL userinfo, or a signed capability to an unverified
    /// destination, so refusal is the default. A refused redirect surfaces
    /// `transport.redirect`.
    #[default]
    Deny,
    /// Follow a redirect for a request that carries neither configured
    /// headers, base-URL userinfo, nor a signed capability URL. A
    /// credential-bearing request is still refused even under this policy,
    /// because ureq forwards configured headers and URL userinfo to the
    /// redirect target, and tungstenite forwards configured headers to a
    /// WebSocket redirect target. A WebSocket handshake additionally may not
    /// follow a redirect when its realtime URL carries userinfo or a query
    /// (a signed capability). Enable only for a deployment whose
    /// unauthenticated requests may safely move.
    Follow,
}

/// Bounds and behavior for the native host transport. `Default` matches the
/// reference HTTP binding: no deadline and no body cap, with redirects denied.
#[derive(Debug, Clone, Default)]
pub struct HostTransportPolicy {
    /// End-to-end deadline for one request (DNS through response body).
    pub request_timeout: Option<Duration>,
    /// One monotonic deadline for a whole sync round: uploads, continuations,
    /// the main request, and every segment fetch. Anchored once on the round's
    /// first network call; a continuation never resets it. Independent of the
    /// per-request deadline, which still bounds each individual call.
    pub round_deadline: Option<Duration>,
    /// Largest HTTP request body the transport will send. Checked before any
    /// network I/O. Does not cap realtime socket buffers.
    pub max_request_bytes: Option<u64>,
    /// Largest decoded (post-decompression) HTTP response body the transport
    /// will accept. Does not cap realtime socket buffers.
    pub max_response_bytes: Option<u64>,
    pub redirects: RedirectPolicy,
}

impl HostTransportPolicy {
    /// Reject a bound the transport cannot honor: a zero or unrepresentable
    /// duration, or a zero byte limit. Called on both the JSON and the
    /// programmatic path, so `Follow`/`Deny` and every numeric field agree.
    pub fn validate(&self) -> Result<(), String> {
        let now = std::time::Instant::now();
        if let Some(timeout) = self.request_timeout {
            if timeout.is_zero() || now.checked_add(timeout).is_none() {
                return Err(
                    "sync.invalid_request: transport config requestTimeoutMs is out of range"
                        .to_owned(),
                );
            }
        }
        if let Some(deadline) = self.round_deadline {
            if deadline.is_zero() || now.checked_add(deadline).is_none() {
                return Err(
                    "sync.invalid_request: transport config roundDeadlineMs is out of range"
                        .to_owned(),
                );
            }
        }
        if self.max_request_bytes == Some(0) {
            return Err(
                "sync.invalid_request: transport config maxRequestBytes must be a positive integer"
                    .to_owned(),
            );
        }
        if self.max_response_bytes == Some(0) {
            return Err("sync.invalid_request: transport config maxResponseBytes must be a positive integer".to_owned());
        }
        Ok(())
    }

    /// Parse the policy from the transport JSON config. Absent keys keep their
    /// defaults; a wrong type or an out-of-range bound is rejected loudly.
    pub fn from_config(config: &serde_json::Value) -> Result<Self, String> {
        let bound = |key: &str, message: &'static str| -> Result<Option<u64>, String> {
            match config.get(key) {
                None | Some(serde_json::Value::Null) => Ok(None),
                Some(value) => match value.as_u64() {
                    Some(number) if number >= 1 => Ok(Some(number)),
                    _ => Err(message.to_owned()),
                },
            }
        };
        let redirects = match config.get("redirects") {
            None | Some(serde_json::Value::Null) => RedirectPolicy::Deny,
            Some(serde_json::Value::String(value)) if value == "deny" => RedirectPolicy::Deny,
            Some(serde_json::Value::String(value)) if value == "follow" => RedirectPolicy::Follow,
            Some(_) => return Err(
                "sync.invalid_request: transport config redirects must be \"deny\" or \"follow\""
                    .to_owned(),
            ),
        };
        let policy = Self {
            request_timeout: bound(
                "requestTimeoutMs",
                "sync.invalid_request: transport config requestTimeoutMs must be a positive integer",
            )?
            .map(Duration::from_millis),
            round_deadline: bound(
                "roundDeadlineMs",
                "sync.invalid_request: transport config roundDeadlineMs must be a positive integer",
            )?
            .map(Duration::from_millis),
            max_request_bytes: bound(
                "maxRequestBytes",
                "sync.invalid_request: transport config maxRequestBytes must be a positive integer",
            )?,
            max_response_bytes: bound(
                "maxResponseBytes",
                "sync.invalid_request: transport config maxResponseBytes must be a positive integer",
            )?,
            redirects,
        };
        policy.validate()?;
        Ok(policy)
    }
}

/// One inbound realtime frame buffered for the client's `on_realtime_*`.
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
    /// The realtime connection ended without the host closing it (the peer closed an idle socket, a read or write failed, or a
    /// send was abandoned). Pushed before any round or send waiter is woken, so the host drains it before it reconnects.
    Disconnected(TransportError),
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

// One transport is held per host, so the native arm's size is not worth an
// indirection; boxing it would change the public variant's payload type.
#[allow(clippy::large_enum_variant)]
pub enum HostTransport {
    /// No network: client-local commands only (dependency-lean default).
    Null {
        signed_urls: bool,
        inbound: Arc<InboundBuffer>,
    },
    #[cfg(feature = "native-transport")]
    Native(native::NativeTransport),
    /// §12 local authority in front of the `Null` or `Native` remote.
    #[cfg(feature = "local-authority")]
    Local(Box<LocalAuthorityTransport<HostTransport>>),
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
        let policy = HostTransportPolicy::from_config(config)?;
        Self::from_config_with_policy(config, policy, notify)
    }

    /// Build the transport with an explicit programmatic policy, ignoring any
    /// policy keys the JSON config carries. `baseUrl` selection is unchanged;
    /// a `localAuthorityPath` puts the §12 local authority in front of it.
    pub fn from_config_with_policy(
        config: &serde_json::Value,
        policy: HostTransportPolicy,
        notify: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Result<Self, String> {
        let local_authority_path = match config.get("localAuthorityPath") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(path)) if !path.is_empty() => Some(path.clone()),
            Some(_) => return Err("localAuthorityPath must be a non-empty string".to_owned()),
        };
        #[cfg(not(feature = "local-authority"))]
        if local_authority_path.is_some() {
            return Err(format!(
                "{}: this build has no local authority (rebuild with --features local-authority)",
                crate::LOCAL_AUTHORITY_UNCONFIGURED_CODE
            ));
        }
        let remote = match config.get("baseUrl").and_then(|v| v.as_str()) {
            #[cfg(feature = "native-transport")]
            Some(base_url) => HostTransport::Native(native::NativeTransport::with_policy(
                base_url, config, policy, notify,
            )?),
            _ => {
                #[cfg(not(feature = "native-transport"))]
                {
                    policy.validate()?;
                    if config.get("baseUrl").is_some() {
                        return Err(
                            "this build has no native transport (rebuild with --features native-transport)"
                                .to_owned(),
                        );
                    }
                }
                HostTransport::Null {
                    signed_urls: false,
                    inbound: Arc::new(match notify {
                        Some(notify) => InboundBuffer::with_notify(notify),
                        None => InboundBuffer::default(),
                    }),
                }
            }
        };
        #[cfg(feature = "local-authority")]
        if let Some(path) = local_authority_path {
            let remote_configured = !matches!(remote, HostTransport::Null { .. });
            return Ok(HostTransport::Local(Box::new(
                LocalAuthorityTransport::new(path, remote, remote_configured),
            )));
        }
        Ok(remote)
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
            #[cfg(feature = "local-authority")]
            Self::Local(t) => Self::Local(Box::new(t.fork_round())),
        }
    }

    pub fn set_signed_urls(&mut self, value: bool) {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls = value,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls = value,
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.remote.set_signed_urls(value),
        }
    }

    /// Replace auth/application headers for subsequent HTTP requests and the
    /// next realtime connection. A live socket retains its handshake headers.
    pub fn set_headers(&mut self, headers: Vec<(String, String)>) {
        match self {
            HostTransport::Null { .. } => drop(headers),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.set_headers(headers),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.remote.set_headers(headers),
        }
    }

    /// Replace the transport's bounds for subsequent network calls. A round
    /// past its first exchange keeps its anchored deadline; every other bound
    /// takes effect on the next call. An invalid policy is rejected and the
    /// current policy stays in force.
    pub fn set_policy(&mut self, policy: HostTransportPolicy) -> Result<(), String> {
        policy.validate()?;
        match self {
            HostTransport::Null { .. } => {}
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.set_policy(policy)?,
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.remote.set_policy(policy)?,
        }
        Ok(())
    }

    /// Drain the inbound realtime frames buffered since the last call.
    pub fn take_inbound(&mut self) -> Vec<Inbound> {
        match self {
            HostTransport::Null { inbound, .. } => inbound.take(),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.inbound.take(),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.remote.take_inbound(),
        }
    }

    /// Release the socket/reader thread and close the local authority.
    /// Idempotent.
    pub fn shutdown(&mut self) {
        match self {
            HostTransport::Null { .. } => {}
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.shutdown(),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.shutdown(),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.sync(request),
        }
    }

    fn remote_operation(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("remoteOperation")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.remote_operation(request),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.remote_operation(request),
        }
    }

    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeSync")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_sync(request),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.realtime_sync(request),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.download_segment(request, on_progress),
        }
    }

    fn supports_url_fetch(&self) -> bool {
        match self {
            HostTransport::Null { signed_urls, .. } => *signed_urls,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.signed_urls,
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.supports_url_fetch(),
        }
    }

    fn download_segments(
        &mut self,
        fetches: &[SegmentFetch],
        on_progress: &mut (dyn FnMut(usize, u64) + Send),
    ) -> Vec<Result<Vec<u8>, TransportError>> {
        match self {
            HostTransport::Null { .. } => fetches
                .first()
                .map(|_| Err(unavailable("downloadSegments")))
                .into_iter()
                .collect(),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.download_segments(fetches, on_progress),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.download_segments(fetches, on_progress),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.fetch_url(url, on_progress),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.blob_upload(blob_id, bytes, media_type),
        }
    }

    fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("blobDownload")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.blob_download(blob_id),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.blob_download(blob_id),
        }
    }

    fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("fetchBlobUrl")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.fetch_blob_url(url),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.fetch_blob_url(url),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.blob_upload_grant(blob_id, byte_length, media_type),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.blob_put_url(url, bytes, media_type),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.realtime_connect(),
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
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.realtime_connect_for_client(client_id),
        }
    }

    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Err(unavailable("realtimeSend")),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_send(text),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.realtime_send(text),
        }
    }

    fn realtime_close(&mut self) -> Result<(), TransportError> {
        match self {
            HostTransport::Null { .. } => Ok(()),
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.realtime_close(),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.realtime_close(),
        }
    }

    fn round_deadline(&self) -> Option<std::time::Duration> {
        match self {
            HostTransport::Null { .. } => None,
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.round_deadline(),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.round_deadline(),
        }
    }

    fn set_round_deadline(&mut self, deadline: Option<std::time::Instant>) {
        match self {
            HostTransport::Null { .. } => {}
            #[cfg(feature = "native-transport")]
            HostTransport::Native(t) => t.set_round_deadline(deadline),
            #[cfg(feature = "local-authority")]
            HostTransport::Local(t) => t.set_round_deadline(deadline),
        }
    }

    #[cfg(feature = "local-authority")]
    fn open_local_authority(
        &mut self,
        schema: &serde_json::Value,
        replica_path: Option<&str>,
    ) -> Result<(), TransportError> {
        match self {
            HostTransport::Local(t) => t.open_local_authority(schema, replica_path),
            _ => Ok(()),
        }
    }

    #[cfg(feature = "local-authority")]
    fn local_authority_state(&self) -> Option<&'static str> {
        match self {
            HostTransport::Local(t) => t.local_authority_state(),
            _ => None,
        }
    }

    #[cfg(feature = "local-authority")]
    fn attach_local_authority(&mut self) -> Result<(), TransportError> {
        match self {
            HostTransport::Local(t) => t.attach_local_authority(),
            _ => Err(local::unconfigured("this transport has no local authority")),
        }
    }

    #[cfg(feature = "local-authority")]
    fn abandon_local_authority_attach(&mut self) -> Result<(), TransportError> {
        match self {
            HostTransport::Local(t) => t.abandon_local_authority_attach(),
            _ => Err(local::unconfigured("this transport has no local authority")),
        }
    }
}

#[cfg(feature = "local-authority")]
pub use local::LocalAuthorityTransport;

#[cfg(feature = "local-authority")]
mod local {
    //! §12.4 routing: sync rounds reach the in-process local authority until
    //! attach completes, then the remote transport. The replica rebinds to the
    //! remote server through the §2.1 log-epoch reset, so the client core adds
    //! no logic. While the authority serves the client there is no realtime
    //! channel and no segment endpoint: the authority delivers bootstrap rows
    //! inline (§5.7).

    use std::sync::{Arc, Mutex};

    use syncular_authority::{AuthorityError, AuthorityState, LocalAuthority};

    use super::HostTransport;
    use crate::{
        BlobDownload, BlobUploadGrant, SegmentFetch, SegmentRequest, Transport, TransportError,
        LOCAL_AUTHORITY_UNCONFIGURED_CODE,
    };

    pub(super) fn unconfigured(message: &'static str) -> TransportError {
        TransportError::new(LOCAL_AUTHORITY_UNCONFIGURED_CODE, message)
    }

    fn transport_error(error: AuthorityError) -> TransportError {
        TransportError {
            code: error.code,
            message: error.message,
            details: error.details,
        }
    }

    fn authority_error(error: TransportError) -> AuthorityError {
        AuthorityError {
            code: error.code,
            message: error.message,
            details: error.details,
        }
    }

    fn refused(message: &'static str) -> TransportError {
        TransportError::new("sync.invalid_request", message)
    }

    /// The §12 local authority in front of a remote transport `R`.
    pub struct LocalAuthorityTransport<R> {
        path: String,
        /// Opened by `create` with the client's schema. Every round view
        /// (`fork_round`) shares it, so attach and rounds serialize on it.
        authority: Arc<Mutex<Option<LocalAuthority>>>,
        pub(super) remote: R,
        /// A remote server is configured (`baseUrl`): attach and abandon
        /// need it.
        remote_configured: bool,
    }

    impl<R> LocalAuthorityTransport<R> {
        /// `path` is the authority's own SQLite file (`":memory:"` for
        /// tests), never the replica's: the client's schema reset drops
        /// every replica table outside `_syncular_*`.
        pub fn new(path: impl Into<String>, remote: R, remote_configured: bool) -> Self {
            Self {
                path: path.into(),
                authority: Arc::new(Mutex::new(None)),
                remote,
                remote_configured,
            }
        }

        fn local_active(&self) -> bool {
            self.authority
                .lock()
                .expect("local authority lock")
                .as_ref()
                .is_none_or(|authority| authority.state() != AuthorityState::Attached)
        }
    }

    impl LocalAuthorityTransport<HostTransport> {
        pub(super) fn fork_round(&self) -> Self {
            Self {
                path: self.path.clone(),
                authority: self.authority.clone(),
                remote: self.remote.fork_round(),
                remote_configured: self.remote_configured,
            }
        }

        pub(super) fn shutdown(&mut self) {
            self.remote.shutdown();
            *self.authority.lock().expect("local authority lock") = None;
        }
    }

    impl<R: Transport> Transport for LocalAuthorityTransport<R> {
        fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            let mut authority = self.authority.lock().expect("local authority lock");
            match authority.as_mut() {
                None => Err(unconfigured(
                    "the local authority opens with create; create a client first",
                )),
                Some(local) if local.state() != AuthorityState::Attached => {
                    local.sync(request).map_err(transport_error)
                }
                Some(_) => {
                    drop(authority);
                    self.remote.sync(request)
                }
            }
        }

        fn remote_operation(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.remote.remote_operation(request)
        }

        fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
            if self.local_active() {
                return Err(refused("the local authority has no realtime channel"));
            }
            self.remote.realtime_sync(request)
        }

        fn download_segment(
            &mut self,
            request: &SegmentRequest,
            on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            if self.local_active() {
                return Err(refused("the local authority has no segment endpoint"));
            }
            self.remote.download_segment(request, on_progress)
        }

        fn download_segments(
            &mut self,
            fetches: &[SegmentFetch],
            on_progress: &mut (dyn FnMut(usize, u64) + Send),
        ) -> Vec<Result<Vec<u8>, TransportError>> {
            if self.local_active() {
                return fetches
                    .first()
                    .map(|_| Err(refused("the local authority has no segment endpoint")))
                    .into_iter()
                    .collect();
            }
            self.remote.download_segments(fetches, on_progress)
        }

        fn supports_url_fetch(&self) -> bool {
            self.remote.supports_url_fetch()
        }

        fn fetch_url(
            &mut self,
            url: &str,
            on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            if self.local_active() {
                return Err(refused("the local authority has no segment endpoint"));
            }
            self.remote.fetch_url(url, on_progress)
        }

        fn blob_upload(
            &mut self,
            blob_id: &str,
            bytes: &[u8],
            media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            self.remote.blob_upload(blob_id, bytes, media_type)
        }

        fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
            self.remote.blob_download(blob_id)
        }

        fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
            self.remote.fetch_blob_url(url)
        }

        fn blob_upload_grant(
            &mut self,
            blob_id: &str,
            byte_length: u64,
            media_type: Option<&str>,
        ) -> Result<BlobUploadGrant, TransportError> {
            self.remote
                .blob_upload_grant(blob_id, byte_length, media_type)
        }

        fn blob_put_url(
            &mut self,
            url: &str,
            bytes: &[u8],
            media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            self.remote.blob_put_url(url, bytes, media_type)
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            if self.local_active() {
                return Err(refused("the local authority has no realtime channel"));
            }
            self.remote.realtime_connect()
        }

        fn realtime_connect_for_client(&mut self, client_id: &str) -> Result<(), TransportError> {
            if self.local_active() {
                return Err(refused("the local authority has no realtime channel"));
            }
            self.remote.realtime_connect_for_client(client_id)
        }

        fn round_deadline(&self) -> Option<std::time::Duration> {
            self.remote.round_deadline()
        }

        fn set_round_deadline(&mut self, deadline: Option<std::time::Instant>) {
            self.remote.set_round_deadline(deadline);
        }

        fn realtime_send(&mut self, text: &str) -> Result<(), TransportError> {
            self.remote.realtime_send(text)
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            self.remote.realtime_close()
        }

        fn open_local_authority(
            &mut self,
            schema: &serde_json::Value,
            replica_path: Option<&str>,
        ) -> Result<(), TransportError> {
            if self.path != ":memory:" && replica_path == Some(self.path.as_str()) {
                return Err(TransportError::new(
                    "sync.invalid_request",
                    "localAuthorityPath must name a file other than the replica's dbPath",
                ));
            }
            let mut authority = self.authority.lock().expect("local authority lock");
            // Close the previous authority before reopening its file.
            *authority = None;
            *authority = Some(LocalAuthority::open(&self.path, schema).map_err(transport_error)?);
            Ok(())
        }

        fn local_authority_state(&self) -> Option<&'static str> {
            self.authority
                .lock()
                .expect("local authority lock")
                .as_ref()
                .map(|authority| match authority.state() {
                    AuthorityState::Local => "local",
                    AuthorityState::Attaching => "attaching",
                    AuthorityState::Attached => "attached",
                })
        }

        fn attach_local_authority(&mut self) -> Result<(), TransportError> {
            if !self.remote_configured {
                return Err(unconfigured(
                    "attachLocalAuthority needs a baseUrl for the remote server",
                ));
            }
            let remote = &mut self.remote;
            let mut authority = self.authority.lock().expect("local authority lock");
            authority
                .as_mut()
                .ok_or_else(|| {
                    unconfigured("the local authority opens with create; create a client first")
                })?
                .attach(&mut |request: &[u8]| remote.sync(request).map_err(authority_error))
                .map_err(transport_error)
        }

        fn abandon_local_authority_attach(&mut self) -> Result<(), TransportError> {
            if !self.remote_configured {
                return Err(unconfigured(
                    "abandonLocalAuthorityAttach needs a baseUrl for the remote server",
                ));
            }
            let remote = &mut self.remote;
            let mut authority = self.authority.lock().expect("local authority lock");
            authority
                .as_mut()
                .ok_or_else(|| {
                    unconfigured("the local authority opens with create; create a client first")
                })?
                .abandon_attach(Some(&mut |request: &[u8]| {
                    remote.sync(request).map_err(authority_error)
                }))
                .map_err(transport_error)
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

    use std::io::{self, Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use polling::{Event, Events, Poller};
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::Message;
    use ureq::unversioned::resolver::DefaultResolver;
    use ureq::unversioned::transport::{
        time::Duration as UreqDuration, ConnectionDetails, Connector, DefaultConnector,
        NextTimeout, Transport as UreqTransport,
    };
    use ureq::Timeout as UreqTimeout;

    use super::{HostTransportPolicy, Inbound, InboundBuffer, RedirectPolicy};
    use crate::{
        BlobDownload, BlobUploadGrant, RealtimeRound, RoundInbound, SegmentFetch, SegmentRequest,
        Transport, TransportError,
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

    /// How long a socket round tolerates silence: no inbound byte of the
    /// response, or no outbound request chunk flushed, for this long fails the
    /// round (§1.8). The bound restarts on every chunk of progress, so a slow
    /// link that keeps delivering never trips it; the host's whole-round
    /// deadline is the only ceiling on total transfer time.
    const ROUND_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
    /// Largest `0x01` chunk of a request. Each chunk's flush is one unit of
    /// outbound progress; chunk boundaries carry no meaning (§8.7).
    const REQUEST_CHUNK_BYTES: usize = 64 * 1024;

    /// When a round with `last_progress` and a silence bound `idle` expires,
    /// and whether the host's whole-round `ceiling` is the bound that binds.
    fn round_expiry(
        last_progress: Instant,
        idle: Duration,
        ceiling: Option<Instant>,
    ) -> (Instant, bool) {
        let silent_at = last_progress + idle;
        match ceiling {
            Some(ceiling) if ceiling < silent_at => (ceiling, true),
            _ => (silent_at, false),
        }
    }
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
        /// When the round last moved: its request was framed, a request chunk
        /// flushed, or a response chunk arrived.
        last_progress: Option<Instant>,
        /// The connection ended; no round can ever complete on it.
        lost: bool,
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
            let framed = state.round.begin(request)?;
            state.last_progress = Some(Instant::now());
            Ok(framed)
        }

        /// Record that a request chunk flushed.
        fn progressed(&self) {
            self.state.lock().expect("round lock").last_progress = Some(Instant::now());
        }

        /// Whether the connection already ended. The reader thread publishes
        /// `Inbound::Disconnected` itself in that case.
        fn lost(&self) -> bool {
            self.state.lock().expect("round lock").lost
        }

        /// Route one inbound binary frame from the reader thread. Returns the
        /// delta payload to enqueue on the inbound buffer, if any; a completed
        /// or failed round is stored and the waiting `realtime_sync` woken.
        fn route_binary(&self, frame: &[u8]) -> Option<Vec<u8>> {
            let mut state = self.state.lock().expect("round lock");
            match state.round.route_binary(frame) {
                Ok(RoundInbound::Delta(body)) => Some(body),
                Ok(RoundInbound::RoundProgress) => {
                    state.last_progress = Some(Instant::now());
                    None
                }
                Ok(RoundInbound::Ignored) => None,
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
            state.lost = true;
            if state.round.in_flight() && state.outcome.is_none() {
                state.round.abort();
                state.outcome = Some(Err(error));
                self.ready.notify_all();
            }
        }

        /// Block until the round completes, fails, goes `idle` without
        /// progress, or reaches the host's whole-round `ceiling`.
        fn wait(
            &self,
            ceiling: Option<Instant>,
            idle: Duration,
        ) -> Result<Vec<u8>, TransportError> {
            let mut state = self.state.lock().expect("round lock");
            while state.outcome.is_none() {
                let (deadline, ceiling_binds) = round_expiry(
                    state.last_progress.unwrap_or_else(Instant::now),
                    idle,
                    ceiling,
                );
                let now = Instant::now();
                if now >= deadline {
                    state.round.abort();
                    return Err(if ceiling_binds {
                        timeout_error("sync round deadline exceeded", "round_deadline")
                    } else {
                        TransportError::new(
                            "sync.transport_failed",
                            "realtime sync round made no progress (§8.7)",
                        )
                    });
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

    /// A configured deadline elapsed. `cause_kind` distinguishes the
    /// per-request timeout from the whole-round deadline.
    fn timeout_error(message: &'static str, cause_kind: &'static str) -> TransportError {
        let mut error = TransportError::new("transport.timeout", message);
        error.details = Some(serde_json::json!({ "causeKind": cause_kind }));
        error
    }

    /// A 3xx was refused (either by policy or by exhausting the follow budget).
    fn redirect_error(message: &'static str, http_status: Option<u16>) -> TransportError {
        let mut details = serde_json::json!({ "causeKind": "redirect" });
        if let Some(status) = http_status {
            details["httpStatus"] = status.into();
        }
        let mut error = TransportError::new("transport.redirect", message);
        error.details = Some(details);
        error
    }

    /// A 3xx that reached the caller means the redirect was refused (the
    /// request was credential bearing or the policy denies redirects). ureq
    /// returns such a response as-is when the ceiling is zero, so the refusal
    /// is detected here rather than in the error classifier.
    fn redirect_refused(resp: &ureq::http::Response<ureq::Body>) -> Result<(), TransportError> {
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            return Err(redirect_error("redirect refused", Some(status)));
        }
        Ok(())
    }

    /// Classify a body-read timeout through ureq's wrapping chain without
    /// formatting it: `Error::into_io` boxes a non-io ureq error as
    /// `io::Error::other`, and the gzip decoder re-wraps a plain io error as
    /// `Error::Decompress("gzip", e)`. Direct, nested, and plain shapes all
    /// count.
    fn is_timeout_io(error: &std::io::Error) -> bool {
        if error.kind() == std::io::ErrorKind::TimedOut {
            return true;
        }
        let Some(inner) = error.get_ref() else {
            return false;
        };
        let Some(ureq_error) = inner.downcast_ref::<ureq::Error>() else {
            return false;
        };
        match ureq_error {
            ureq::Error::Timeout(_) => true,
            ureq::Error::Io(nested) => is_timeout_io(nested),
            ureq::Error::Decompress(_, nested) => is_timeout_io(nested),
            _ => false,
        }
    }

    fn http_err(message: &'static str, error: ureq::Error) -> TransportError {
        let (kind, status) = match error {
            ureq::Error::StatusCode(status) if (300..400).contains(&status) => {
                return redirect_error(message, Some(status))
            }
            ureq::Error::StatusCode(status) => ("status", Some(status)),
            ureq::Error::Timeout(_) => return timeout_error(message, "timeout"),
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
            ureq::Error::RedirectFailed | ureq::Error::TooManyRedirects => {
                return redirect_error(message, None)
            }
            _ => ("unknown", None),
        };
        transfer_error(message, kind, status)
    }

    fn io_err(message: &'static str, error: std::io::Error) -> TransportError {
        if is_timeout_io(&error) {
            return timeout_error(message, "timeout");
        }
        let kind = match error.kind() {
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
            // A 3xx that reached the caller was refused (the policy denies
            // redirects or the handshake request is credential bearing).
            tungstenite::Error::Http(response) if response.status().is_redirection() => {
                redirect_error(message, Some(response.status().as_u16()))
            }
            tungstenite::Error::Http(response) => {
                transfer_error(message, "status", Some(response.status().as_u16()))
            }
            tungstenite::Error::Url(_) | tungstenite::Error::HttpFormat(_) => {
                transfer_error(message, "request", None)
            }
            _ => transfer_error(message, "protocol", None),
        }
    }

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

    fn remaining(deadline: Instant) -> io::Result<Duration> {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "websocket establishment deadline exceeded",
                )
            })
    }

    struct EstablishingStream {
        socket: TcpStream,
        deadline: Option<Instant>,
    }

    impl EstablishingStream {
        fn timeout(&self) -> io::Result<Option<Duration>> {
            self.deadline.map(remaining).transpose()
        }
        fn established(&mut self) -> io::Result<TcpStream> {
            self.deadline = None;
            self.socket.set_read_timeout(None)?;
            self.socket.set_write_timeout(None)?;
            self.socket.try_clone()
        }
    }

    fn establishment_io<T>(result: io::Result<T>, establishing: bool) -> io::Result<T> {
        result.map_err(|error| {
            if establishing
                && matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                )
            {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "websocket establishment deadline exceeded",
                )
            } else {
                error
            }
        })
    }

    impl Read for EstablishingStream {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.deadline.is_some() {
                self.socket.set_read_timeout(self.timeout()?)?;
            }
            establishment_io(self.socket.read(bytes), self.deadline.is_some())
        }
    }
    impl Write for EstablishingStream {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.deadline.is_some() {
                self.socket.set_write_timeout(self.timeout()?)?;
            }
            establishment_io(self.socket.write(bytes), self.deadline.is_some())
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.deadline.is_some() {
                self.socket.set_write_timeout(self.timeout()?)?;
            }
            establishment_io(self.socket.flush(), self.deadline.is_some())
        }
    }

    fn connect_websocket(
        request: tungstenite::handshake::client::Request,
        deadline: Instant,
    ) -> Result<tungstenite::WebSocket<MaybeTlsStream<EstablishingStream>>, TransportError> {
        let host = request
            .uri()
            .host()
            .ok_or_else(|| transfer_error("realtime URL invalid", "request", None))?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let port = match request.uri().scheme_str() {
            Some("ws") => request.uri().port_u16().unwrap_or(80),
            Some("wss") => request.uri().port_u16().unwrap_or(443),
            _ => return Err(transfer_error("realtime URL invalid", "request", None)),
        };
        // System DNS has no cancellable deadline. Only resolution runs here:
        // a late result cannot open a socket or issue an authenticated request.
        let host = host.to_owned();
        let (resolved, addresses) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("syncular-dns".to_owned())
            .spawn(move || {
                let result = (host.as_str(), port)
                    .to_socket_addrs()
                    .map(|items| items.collect::<Vec<_>>());
                let _ = resolved.send(result);
            })
            .map_err(|e| io_err("realtime DNS failed", e))?;
        let addresses = addresses
            .recv_timeout(remaining(deadline).map_err(|e| io_err("realtime DNS failed", e))?)
            .map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => {
                    timeout_error("realtime DNS timed out", "timeout")
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    transfer_error("realtime DNS failed", "io", None)
                }
            })?
            .map_err(|e| io_err("realtime DNS failed", e))?;
        let mut last_error = io::Error::new(io::ErrorKind::NotFound, "DNS returned no addresses");
        let mut socket = None;
        for address in addresses {
            match TcpStream::connect_timeout(
                &address,
                remaining(deadline).map_err(|e| io_err("realtime TCP connect failed", e))?,
            ) {
                Ok(stream) => {
                    socket = Some(stream);
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        let socket = socket.ok_or_else(|| io_err("realtime TCP connect failed", last_error))?;
        socket
            .set_nodelay(true)
            .map_err(|e| io_err("realtime TCP connect failed", e))?;
        let stream = EstablishingStream {
            socket,
            deadline: Some(deadline),
        };
        // Same pinned rustls / WebPKI connector, certificate and hostname checks.
        // Redirects are errors: credentials stay bound to the configured endpoint.
        let (ws, _) = tungstenite::client_tls_with_config(request, stream, None, None).map_err(
            |e| match e {
                tungstenite::HandshakeError::Failure(error) => {
                    ws_err("realtime connection failed", error)
                }
                // The establishment socket is blocking with a deadline, so the
                // handshake cannot report an interrupted (would-block) state.
                tungstenite::HandshakeError::Interrupted(_) => {
                    transfer_error("realtime connection failed", "protocol", None)
                }
            },
        )?;
        remaining(deadline).map_err(|e| io_err("realtime connection failed", e))?;
        Ok(ws)
    }

    #[cfg(test)]
    mod establishment_tests {
        use super::*;
        use std::net::{Shutdown, TcpListener};
        use tungstenite::client::IntoClientRequest;

        // A peer consumes the initial request/ClientHello, then withholds its
        // upgrade/TLS response until released. Cleanup also unblocks the old path.
        fn withheld_response(tls: bool, old: bool) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!(
                "{}://{}/realtime",
                if tls { "wss" } else { "ws" },
                listener.local_addr().unwrap()
            );
            let (accepted_tx, accepted_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let peer = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = [0; 4096];
                assert!(stream.read(&mut bytes).unwrap() > 0);
                accepted_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                let _ = stream.shutdown(Shutdown::Both);
            });
            let (done_tx, done_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = if old {
                    tungstenite::connect(url)
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                } else {
                    connect_websocket(
                        url.into_client_request().unwrap(),
                        Instant::now() + Duration::from_millis(250),
                    )
                    .map(|_| ())
                    .map_err(|e| format!("{}: {}", e.code, e.message))
                };
                done_tx.send(result).unwrap();
            });
            accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if old {
                assert!(
                    matches!(
                        done_rx.recv_timeout(Duration::from_millis(500)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ),
                    "original connect unexpectedly had a deadline"
                );
                release_tx.send(()).unwrap();
                assert!(done_rx
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap()
                    .is_err());
            } else {
                let error = done_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("establishment remained blocked")
                    .unwrap_err();
                assert_eq!(error, "transport.timeout: realtime connection failed");
                eprintln!(
                    "withheld {} produces {error}",
                    if tls { "TLS" } else { "upgrade" }
                );
                release_tx.send(()).unwrap();
            }
            worker.join().unwrap();
            peer.join().unwrap();
        }

        #[test]
        fn original_connect_blocks_on_withheld_upgrade_and_tls() {
            withheld_response(false, true);
            withheld_response(true, true);
        }
        #[test]
        fn establishment_deadline_errors_on_withheld_upgrade_and_tls() {
            withheld_response(false, false);
            withheld_response(true, false);
        }

        #[test]
        fn slow_upgrade_bytes_cannot_renew_the_absolute_deadline() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let peer = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = [0; 4096];
                let _ = stream.read(&mut bytes).unwrap();
                for byte in b"HTTP/1.1 101 Switching Protocols\r\n" {
                    if stream.write_all(&[*byte]).is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            });
            let started = Instant::now();
            assert!(connect_websocket(
                url.into_client_request().unwrap(),
                started + Duration::from_millis(250)
            )
            .is_err());
            assert!(started.elapsed() < Duration::from_secs(1));
            peer.join().unwrap();
        }

        #[test]
        fn saturated_tcp_accept_queue_returns_an_observable_error() {
            // Fill a loopback listener's kernel accept queue without accepting.
            // No unroutable external host or firewall mutation is needed.
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let mut queued = Vec::new();
            loop {
                match TcpStream::connect_timeout(&address, Duration::from_millis(50)) {
                    Ok(stream) => queued.push(stream),
                    Err(error) => {
                        assert!(
                            matches!(
                                error.kind(),
                                io::ErrorKind::TimedOut
                                    | io::ErrorKind::WouldBlock
                                    | io::ErrorKind::ConnectionRefused
                                    | io::ErrorKind::ConnectionReset
                            ),
                            "{error:?}"
                        );
                        break;
                    }
                }
                assert!(queued.len() < 4096, "listener queue did not saturate");
            }
            let started = Instant::now();
            let url = format!("ws://{address}");
            let error = match connect_websocket(
                url.into_client_request().unwrap(),
                started + Duration::from_millis(250),
            ) {
                Err(error) => error,
                Ok(_) => panic!("full accept queue unexpectedly connected"),
            };
            assert!(
                (error.code == "transport.timeout" || error.code == "transport.failed")
                    && (error.message == "realtime TCP connect failed"
                        || error.message == "realtime connection failed"),
                "{}: {}",
                error.code,
                error.message
            );
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }

    /// Segment fetches keep their own generic surface (`sync.transport_failed`)
    /// but must not swallow a typed policy failure: a refused redirect or an
    /// exceeded deadline/byte budget survives to the caller.
    fn segment_error(mut error: TransportError) -> TransportError {
        if error.code == "transport.failed" {
            error.code = "sync.transport_failed".into();
            error.message = "segment transfer failed".into();
        }
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
        /// The base URL carries `user:pass@`, which ureq turns into request
        /// credentials; a request to it is credential bearing even without
        /// configured headers.
        base_url_has_userinfo: bool,
        agent: ureq::Agent,
        policy: HostTransportPolicy,
        /// Absolute whole-round deadline scoped by `set_round_deadline` for
        /// one exchange; `None` outside a round or when the policy sets no
        /// round budget.
        round_deadline_at: Option<std::time::Instant>,
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

    /// Enforces `request_timeout` as a silence bound. ureq measures each
    /// request phase from its start, so a body that keeps arriving still
    /// expires; this connector caps every socket read and write at the bound
    /// instead, which restarts with each byte moved. The remaining phases
    /// (resolve, connect, request head, response head) keep ureq's own
    /// per-phase deadlines.
    #[derive(Debug)]
    struct IdleConnector(Option<Duration>);

    impl Connector<Box<dyn UreqTransport>> for IdleConnector {
        type Out = Box<dyn UreqTransport>;

        fn connect(
            &self,
            _: &ConnectionDetails,
            chained: Option<Box<dyn UreqTransport>>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            Ok(chained.map(|inner| match self.0 {
                Some(idle) => IdleTransport { inner, idle }.boxed(),
                None => inner,
            }))
        }
    }

    #[derive(Debug)]
    struct IdleTransport {
        inner: Box<dyn UreqTransport>,
        idle: Duration,
    }

    /// Cap a wait at `idle`: a wait with no deadline or a longer one becomes
    /// `idle`; a shorter ceiling (the round deadline) stays.
    fn idle_bound(timeout: NextTimeout, idle: Duration) -> NextTimeout {
        let idle = UreqDuration::Exact(idle);
        if timeout.after.is_not_happening() || timeout.after.as_nanos() > idle.as_nanos() {
            NextTimeout {
                after: idle,
                reason: UreqTimeout::RecvBody,
            }
        } else {
            timeout
        }
    }

    impl UreqTransport for IdleTransport {
        fn buffers(&mut self) -> &mut dyn ureq::unversioned::transport::Buffers {
            self.inner.buffers()
        }
        fn transmit_output(
            &mut self,
            amount: usize,
            timeout: NextTimeout,
        ) -> Result<(), ureq::Error> {
            self.inner
                .transmit_output(amount, idle_bound(timeout, self.idle))
        }
        fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            self.inner.await_input(idle_bound(timeout, self.idle))
        }
        fn is_open(&mut self) -> bool {
            self.inner.is_open()
        }
        fn is_tls(&self) -> bool {
            self.inner.is_tls()
        }
    }

    fn build_agent(policy: &HostTransportPolicy) -> ureq::Agent {
        let config = ureq::Agent::config_builder()
            .timeout_resolve(policy.request_timeout)
            .timeout_connect(policy.request_timeout)
            .timeout_send_request(policy.request_timeout)
            .timeout_recv_response(policy.request_timeout)
            .max_redirects(match policy.redirects {
                RedirectPolicy::Deny => 0,
                RedirectPolicy::Follow => 10,
            })
            .max_redirects_will_error(matches!(policy.redirects, RedirectPolicy::Follow))
            .redirect_auth_headers(ureq::config::RedirectAuthHeaders::Never)
            // A 4xx/5xx carries the server's §10.1 JSON error body. Read it so
            // the code, recommendedAction, details and HTTP status can reach
            // the caller; read_body turns a non-2xx response into a typed
            // TransportError before any payload is treated as data.
            .http_status_as_error(false)
            .build();
        ureq::Agent::with_parts(
            config,
            DefaultConnector::new().chain(IdleConnector(policy.request_timeout)),
            DefaultResolver::default(),
        )
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
                base_url_has_userinfo: self.base_url_has_userinfo,
                agent: self.agent.clone(),
                policy: self.policy.clone(),
                round_deadline_at: None,
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
            let policy = HostTransportPolicy::from_config(config)?;
            Self::with_policy(base_url, config, policy, notify)
        }

        pub fn with_policy(
            base_url: &str,
            config: &serde_json::Value,
            policy: HostTransportPolicy,
            notify: Option<Arc<dyn Fn() + Send + Sync>>,
        ) -> Result<Self, String> {
            policy.validate()?;
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
            // ureq replays `user:pass@` as Basic auth, so a base URL with
            // userinfo is credential bearing even when no headers are set.
            let base_url_has_userinfo = url::Url::parse(base_url)
                .map(|url| !url.username().is_empty() || url.password().is_some())
                .unwrap_or(false);
            Ok(NativeTransport {
                base_url: base_url.trim_end_matches('/').to_owned(),
                ws_url,
                headers,
                base_url_has_userinfo,
                agent: build_agent(&policy),
                policy,
                round_deadline_at: None,
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

        /// Replace the policy for subsequent calls; an invalid policy is
        /// rejected and the current policy stays in force. The agent is
        /// rebuilt so the new redirect ceiling and timeout defaults apply.
        pub fn set_policy(&mut self, policy: HostTransportPolicy) -> Result<(), String> {
            policy.validate()?;
            self.agent = build_agent(&policy);
            self.policy = policy;
            Ok(())
        }

        pub fn round_deadline(&self) -> Option<Duration> {
            self.policy.round_deadline
        }

        pub fn set_round_deadline(&mut self, deadline: Option<std::time::Instant>) {
            self.round_deadline_at = deadline;
        }

        /// What remains of the whole-round deadline, or `None` without one.
        /// Fails before any network I/O once the deadline has passed. The
        /// per-request bound is not part of this: it restarts on every byte
        /// (see [`IdleConnector`]).
        fn round_remaining(&self) -> Result<Option<Duration>, TransportError> {
            match self.round_deadline_at {
                Some(deadline) => deadline
                    .checked_duration_since(std::time::Instant::now())
                    .map(Some)
                    .ok_or_else(|| timeout_error("sync round deadline exceeded", "round_deadline")),
                None => Ok(None),
            }
        }

        /// Whether a request to the base URL carries credentials: configured
        /// headers, or `user:pass@` userinfo ureq replays as Basic auth.
        fn credentialed(&self) -> bool {
            !self.headers.is_empty() || self.base_url_has_userinfo
        }

        /// Apply the per-call bounds to a request: the round's remaining time, and
        /// a redirect ceiling of zero whenever the request is credential
        /// bearing or the policy denies redirects. A credential-bearing
        /// request is refused a redirect under every policy, because ureq
        /// forwards configured headers to the redirect target.
        fn finish_request<B>(
            &self,
            req: ureq::RequestBuilder<B>,
            credentialed: bool,
        ) -> Result<ureq::RequestBuilder<B>, TransportError> {
            let timeout = self.round_remaining()?;
            let follow = self.policy.redirects == RedirectPolicy::Follow && !credentialed;
            Ok(req
                .config()
                .timeout_global(timeout)
                .max_redirects(if follow { 10 } else { 0 })
                .max_redirects_will_error(true)
                .build())
        }

        /// Refuse an oversized request body before any network I/O.
        fn check_request_bytes(&self, len: u64) -> Result<(), TransportError> {
            match self.policy.max_request_bytes {
                Some(max) if len > max => {
                    let mut error = TransportError::new(
                        "transport.request_too_large",
                        "request body exceeds the configured transport limit",
                    );
                    error.details = Some(serde_json::json!({ "limit": max, "size": len }));
                    Err(error)
                }
                _ => Ok(()),
            }
        }

        fn post_sync(&self, path: &str, body: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.check_request_bytes(body.len() as u64)?;
            let credentialed = self.credentialed();
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
            let req = self.finish_request(req, credentialed)?;
            let resp = req
                .send(body)
                .map_err(|e| http_err("sync request failed", e))?;
            read_body(resp, None, self.policy.max_response_bytes)
        }

        fn post_operation(&self, body: &[u8]) -> Result<Vec<u8>, TransportError> {
            self.check_request_bytes(body.len() as u64)?;
            let credentialed = self.credentialed();
            let url = format!("{}/operations", self.base_url);
            let mut req = self.agent.post(&url).header(
                "content-type",
                "application/vnd.syncular.operations.v1+json",
            );
            for (key, value) in &self.headers {
                req = req.header(key.as_str(), value.as_str());
            }
            let req = self.finish_request(req, credentialed)?;
            let response = req
                .send(body)
                .map_err(|error| http_err("remote operation request failed", error))?;
            read_body(response, None, self.policy.max_response_bytes)
        }

        fn get_bytes(&self, url: &str, with_headers: bool) -> Result<Vec<u8>, TransportError> {
            // The only caller is a signed blob URL: the URL is the capability,
            // so the request is credential bearing either way.
            let mut req = self.agent.get(url);
            if with_headers {
                for (k, v) in &self.headers {
                    req = req.header(k.as_str(), v.as_str());
                }
            }
            let req = self.finish_request(req, true)?;
            let resp = req.call().map_err(|e| http_err("URL fetch failed", e))?;
            read_body(resp, None, self.policy.max_response_bytes)
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
            // A whole-round deadline bounds the write wait too: intersect it
            // with the socket's own ceiling and report the round budget as a
            // typed timeout. The per-request HTTP deadline does not apply to a
            // socket send.
            let (wait, round_bound) = match self.round_deadline_at {
                Some(deadline) => {
                    match deadline.checked_duration_since(std::time::Instant::now()) {
                        Some(remaining) if remaining < ROUND_IDLE_TIMEOUT => (remaining, true),
                        Some(_) => (ROUND_IDLE_TIMEOUT, false),
                        // The round is already spent: refuse before queuing the
                        // frame so a later send cannot deliver it.
                        None => {
                            return Err(timeout_error("realtime send timed out", "round_deadline"));
                        }
                    }
                }
                None => (ROUND_IDLE_TIMEOUT, false),
            };
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
                result.recv_timeout(wait).map_err(|_| {
                    if round_bound {
                        timeout_error("realtime send timed out", "round_deadline")
                    } else {
                        TransportError::new("transport.failed", "realtime send did not complete")
                    }
                })?
            })();
            // A failed/timed-out write must not remain eligible for delivery
            // behind a later command on the same connection.
            if let Err(error) = &result {
                self.shutdown();
                // Some callers (delta acknowledgement) intentionally ignore a
                // send error. It still invalidates the connection for the host.
                self.inbound.push(Inbound::Disconnected(error.clone()));
            }
            result
        }
    }

    /// A non-2xx response. Preserve the authenticated server catalog error
    /// body (§10.1) so callers see its code, recommendedAction, details and
    /// HTTP status; a non-JSON body keeps the transport classification.
    fn http_status_body_error(status: u16, body: &[u8]) -> TransportError {
        let mut error = TransportError::new("transport.failed", "HTTP request failed");
        let mut details = serde_json::Map::new();
        if let Ok(serde_json::Value::Object(parsed)) =
            serde_json::from_slice::<serde_json::Value>(body)
        {
            if let Some(code) = parsed.get("code").and_then(serde_json::Value::as_str) {
                if !code.is_empty() {
                    error.code = code.to_owned();
                }
            }
            if let Some(message) = parsed.get("message").and_then(serde_json::Value::as_str) {
                error.message = message.to_owned();
            }
            for key in ["category", "recommendedAction"] {
                if let Some(value) = parsed.get(key).and_then(serde_json::Value::as_str) {
                    details.insert(key.to_owned(), serde_json::Value::from(value));
                }
            }
            if let Some(retryable) = parsed.get("retryable").and_then(serde_json::Value::as_bool) {
                details.insert("retryable".to_owned(), serde_json::Value::from(retryable));
            }
            if let Some(serde_json::Value::Object(inner)) = parsed.get("details") {
                for (key, value) in inner {
                    details.insert(key.clone(), value.clone());
                }
            }
        }
        details.insert("causeKind".to_owned(), serde_json::Value::from("status"));
        details.insert("httpStatus".to_owned(), serde_json::Value::from(status));
        error.details = Some(serde_json::Value::Object(details));
        error
    }

    fn read_body(
        resp: ureq::http::Response<ureq::Body>,
        mut progress: Option<&mut dyn FnMut(u64)>,
        max: Option<u64>,
    ) -> Result<Vec<u8>, TransportError> {
        redirect_refused(&resp)?;
        use std::io::Read;
        let status = resp.status().as_u16();
        let mut reader = resp.into_body().into_with_config().reader();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        let mut reported = 0;
        loop {
            let n = reader.read(&mut chunk).map_err(|error| {
                if is_timeout_io(&error) {
                    timeout_error("response body read times out", "timeout")
                } else {
                    transfer_error("response body read failed", "body", Some(status))
                }
            })?;
            if n == 0 {
                break;
            }
            // The cap counts decoded bytes: ureq's reader decompresses before
            // this loop, so a gzip bomb hits the limit before the buffer grows.
            if let Some(max) = max {
                if bytes.len() as u64 + n as u64 > max {
                    return Err(response_too_large(max));
                }
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
        if status >= 400 {
            return Err(http_status_body_error(status, &bytes));
        }
        Ok(bytes)
    }

    fn response_too_large(max: u64) -> TransportError {
        let mut error = TransportError::new(
            "transport.response_too_large",
            "response body exceeds the configured transport limit",
        );
        error.details = Some(serde_json::json!({ "limit": max }));
        error
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
            self.round_remaining()?;
            let framed = self.round.begin(request)?;
            let (tag, body) = framed.split_first().expect("framed request carries a tag");
            for chunk in body.chunks(REQUEST_CHUNK_BYTES) {
                let mut message = Vec::with_capacity(chunk.len() + 1);
                message.push(*tag);
                message.extend_from_slice(chunk);
                if let Err(error) = self.send_message(Message::Binary(message.into())) {
                    self.round.fail_in_flight(error);
                    break;
                }
                self.round.progressed();
            }
            let outcome = self.round.wait(self.round_deadline_at, ROUND_IDLE_TIMEOUT);
            // A round that ends without its response END leaves the rest of
            // that response in flight on the socket, and the next round would
            // read it as its own (§8.7). Close the connection and report the
            // loss; the reader thread already did both when the peer ended it.
            if let Err(error) = &outcome {
                if !self.round.lost() {
                    self.shutdown();
                    self.inbound.push(Inbound::Disconnected(error.clone()));
                }
            }
            outcome
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
            let credentialed = self.credentialed();
            let mut req = self
                .agent
                .get(&url)
                .header("x-syncular-scopes", &request.requested_scopes_json);
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let req = self.finish_request(req, credentialed)?;
            let resp = req
                .call()
                .map_err(|error| segment_error(http_err("segment request failed", error)))?;
            read_body(resp, Some(on_progress), self.policy.max_response_bytes)
                .map_err(segment_error)
        }

        fn supports_url_fetch(&self) -> bool {
            self.signed_urls
        }

        fn download_segments(
            &mut self,
            fetches: &[SegmentFetch],
            on_progress: &mut (dyn FnMut(usize, u64) + Send),
        ) -> Vec<Result<Vec<u8>, TransportError>> {
            // A segment GET is pure network I/O over immutable transport
            // state, so a page list downloads on a bounded pool instead of one
            // blocking request after the other: four pages of a paged
            // bootstrap overlap (§5.2). `fork_round` hands each worker the same
            // agent (a cheap clone) and headers; the round's anchored deadline
            // is copied over explicitly, because a fork starts without one.
            // Every fetch is attempted; the client stops consuming at the
            // first error in wire order.
            let workers = (0..fetches.len().min(4))
                .map(|_| {
                    let mut worker = self.fork_round();
                    worker.round_deadline_at = self.round_deadline_at;
                    worker
                })
                .collect::<Vec<_>>();
            let slots = fetches.iter().map(|_| Mutex::new(None)).collect::<Vec<_>>();
            let progress = Mutex::new(on_progress);
            let next = std::sync::atomic::AtomicUsize::new(0);
            std::thread::scope(|scope| {
                for worker in workers {
                    let (slots, progress, next) = (&slots, &progress, &next);
                    scope.spawn(move || {
                        let mut worker = worker;
                        loop {
                            let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let Some(fetch) = fetches.get(index) else {
                                break;
                            };
                            let mut report = |bytes: u64| {
                                (*progress.lock().expect("segment progress lock"))(index, bytes);
                            };
                            let result = match fetch {
                                SegmentFetch::Direct(request) => {
                                    worker.download_segment(request, &mut report)
                                }
                                SegmentFetch::Url(url) => worker.fetch_url(url, &mut report),
                            };
                            *slots[index].lock().expect("segment result slot") = Some(result);
                        }
                    });
                }
            });
            slots
                .into_iter()
                .map(|slot| slot.into_inner().expect("segment result slot"))
                .map(|result| result.expect("every fetch is attempted"))
                .collect()
        }

        fn fetch_url(
            &mut self,
            url: &str,
            on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            // §5.4: the URL is the entire grant — no host credentials attached.
            let req = self.finish_request(self.agent.get(url), true)?;
            let resp = req
                .call()
                .map_err(|error| segment_error(http_err("segment request failed", error)))?;
            read_body(resp, Some(on_progress), self.policy.max_response_bytes)
                .map_err(segment_error)
        }

        fn blob_upload(
            &mut self,
            blob_id: &str,
            bytes: &[u8],
            media_type: Option<&str>,
        ) -> Result<(), TransportError> {
            // Full `sha256:<hex>` id in the path — the reference server's
            // isBlobId check rejects a bare hex id (§5.9.1).
            self.check_request_bytes(bytes.len() as u64)?;
            let credentialed = self.credentialed();
            let url = format!("{}/blobs/{}", self.base_url, blob_id);
            let mut req = self.agent.put(&url).header(
                "content-type",
                media_type.unwrap_or("application/octet-stream"),
            );
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let req = self.finish_request(req, credentialed)?;
            let resp = req
                .send(bytes)
                .map_err(|e| http_err("blob upload failed", e))?;
            read_body(resp, None, self.policy.max_response_bytes)?;
            Ok(())
        }

        fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
            // Full `sha256:<hex>` id in the path — the reference server's
            // isBlobId check rejects a bare hex id (§5.9.1).
            let credentialed = self.credentialed();
            let url = format!("{}/blobs/{}", self.base_url, blob_id);
            let mut req = self.agent.get(&url);
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let req = self.finish_request(req, credentialed)?;
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
            let body =
                read_body(resp, None, self.policy.max_response_bytes).map_err(|mut error| {
                    // The blob endpoint keeps its status classification: an
                    // error body supplies details, but the HTTP status decides
                    // the code.
                    let status = error
                        .details
                        .as_ref()
                        .filter(|details| {
                            details.get("causeKind").and_then(serde_json::Value::as_str)
                                == Some("status")
                        })
                        .and_then(|details| details.get("httpStatus"))
                        .and_then(serde_json::Value::as_u64);
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
                        Some(_) => {
                            error.code = "transport.failed".into();
                            error.message = "blob download failed".into();
                        }
                        None => {}
                    }
                    error
                })?;
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
            let body = serde_json::json!({
                "byteLength": byte_length,
                "mediaType": media_type,
            })
            .to_string();
            self.check_request_bytes(body.len() as u64)?;
            let credentialed = self.credentialed();
            let mut req = self
                .agent
                .post(&url)
                .header("content-type", "application/json");
            for (k, v) in &self.headers {
                req = req.header(k.as_str(), v.as_str());
            }
            let req = self.finish_request(req, credentialed)?;
            let resp = req
                .send(body)
                .map_err(|e| http_err("blob upload grant request failed", e))?;
            let grant_body = read_body(resp, None, self.policy.max_response_bytes)?;
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
            self.check_request_bytes(bytes.len() as u64)?;
            let req = self.finish_request(
                self.agent.put(url).header(
                    "content-type",
                    media_type.unwrap_or("application/octet-stream"),
                ),
                true,
            )?;
            let resp = req
                .send(bytes)
                .map_err(|e| http_err("signed blob upload failed", e))?;
            read_body(resp, None, self.policy.max_response_bytes)?;
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
            // The bounded establishment never follows a redirect, so a transport configured with
            // `RedirectPolicy::Follow` fails here instead of having the policy silently ignored.
            if self.policy.redirects == RedirectPolicy::Follow {
                return Err(redirect_error(
                    "realtime establishment does not follow redirects",
                    None,
                ));
            }
            let mut ws = connect_websocket(request, Instant::now() + CONNECT_TIMEOUT)?;
            let stream = match ws.get_mut() {
                MaybeTlsStream::Plain(stream) => stream.established(),
                MaybeTlsStream::Rustls(stream) => stream.get_mut().established(),
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
                // Publish before waking a round/send waiter: the host must
                // drain this old connection's event before it can reconnect.
                // An idle close has no round waiter at all. Explicit shutdown
                // is owned by its caller and must not leave a stale close.
                if !stop.load(Ordering::SeqCst) {
                    inbound.push(Inbound::Disconnected(failure.clone()));
                }
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

        fn round_deadline(&self) -> Option<Duration> {
            NativeTransport::round_deadline(self)
        }

        fn set_round_deadline(&mut self, deadline: Option<std::time::Instant>) {
            NativeTransport::set_round_deadline(self, deadline);
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
                        (_, "timeout") => "transport.timeout",
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
            let error = segment_error(read_body(response, None, None).unwrap_err());
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

        #[test]
        fn body_read_timeouts_are_classified_through_ureq_wrapping() {
            // Direct: Error::into_io boxes a non-io ureq error as io::Error::other.
            let direct = ureq::Error::Timeout(ureq::Timeout::Global).into_io();
            assert!(is_timeout_io(&direct));
            // Compressed: gzip wraps the io error again as Error::Decompress.
            let wrapped = ureq::Error::Decompress(
                "gzip",
                ureq::Error::Timeout(ureq::Timeout::Global).into_io(),
            )
            .into_io();
            assert!(is_timeout_io(&wrapped));
            // A plain socket timeout and a non-timeout are handled too.
            assert!(is_timeout_io(&std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "plain"
            )));
            assert!(!is_timeout_io(&std::io::Error::other("other")));
            assert!(!is_timeout_io(&ureq::Error::StatusCode(500).into_io()));
        }

        #[test]
        fn body_read_wrapped_timeouts_surface_the_typed_code() {
            struct TimeoutRead(bool);
            impl std::io::Read for TimeoutRead {
                fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                    Err(if self.0 {
                        ureq::Error::Timeout(ureq::Timeout::Global).into_io()
                    } else {
                        ureq::Error::Decompress(
                            "gzip",
                            ureq::Error::Timeout(ureq::Timeout::Global).into_io(),
                        )
                        .into_io()
                    })
                }
            }
            for compressed in [false, true] {
                let response = ureq::http::Response::builder()
                    .status(200)
                    .body(ureq::Body::builder().reader(TimeoutRead(compressed)))
                    .unwrap();
                let error = read_body(response, None, None).unwrap_err();
                assert_eq!(error.code, "transport.timeout", "{compressed}");
                assert_eq!(
                    error.details,
                    Some(serde_json::json!({ "causeKind": "timeout" }))
                );
            }
        }

        #[test]
        fn policy_validation_rejects_zero_and_unrepresentable_bounds() {
            assert_eq!(
                HostTransportPolicy {
                    request_timeout: Some(Duration::ZERO),
                    ..Default::default()
                }
                .validate()
                .unwrap_err(),
                "sync.invalid_request: transport config requestTimeoutMs is out of range"
            );
            assert_eq!(
                HostTransportPolicy {
                    round_deadline: Some(Duration::MAX),
                    ..Default::default()
                }
                .validate()
                .unwrap_err(),
                "sync.invalid_request: transport config roundDeadlineMs is out of range"
            );
            assert!(HostTransportPolicy {
                max_request_bytes: Some(0),
                ..Default::default()
            }
            .validate()
            .is_err());
            assert!(HostTransportPolicy {
                max_response_bytes: Some(0),
                ..Default::default()
            }
            .validate()
            .is_err());
            // A programmatic zero or an unrepresentable duration matches the
            // JSON rejection instead of panicking at `Instant::now() + budget`.
            assert!(HostTransportPolicy::default().validate().is_ok());
            assert_eq!(
                HostTransportPolicy::from_config(&serde_json::json!({ "requestTimeoutMs": 0 }))
                    .unwrap_err(),
                "sync.invalid_request: transport config requestTimeoutMs must be a positive integer"
            );
        }

        #[test]
        fn set_policy_rejects_invalid_and_preserves_the_current_policy() {
            let mut transport =
                NativeTransport::new("http://127.0.0.1", &serde_json::json!({}), None).unwrap();
            assert_eq!(transport.policy.max_response_bytes, None);
            let error = transport
                .set_policy(HostTransportPolicy {
                    max_response_bytes: Some(0),
                    ..Default::default()
                })
                .unwrap_err();
            assert_eq!(
                error,
                "sync.invalid_request: transport config maxResponseBytes must be a positive integer"
            );
            assert_eq!(transport.policy.max_response_bytes, None);
        }

        #[test]
        fn an_expired_round_deadline_is_typed_and_cleared_for_the_next_round() {
            let mut transport =
                NativeTransport::new("http://127.0.0.1:9", &serde_json::json!({}), None).unwrap();
            transport.set_round_deadline(Some(std::time::Instant::now() - Duration::from_secs(1)));
            let error = transport.blob_download("sha256:test").unwrap_err();
            assert_eq!(error.code, "transport.timeout");
            assert_eq!(
                error.details,
                Some(serde_json::json!({ "causeKind": "round_deadline" }))
            );
            // Clearing the scope leaves no stale deadline for the next round.
            transport.set_round_deadline(None);
            assert!(transport.round_remaining().is_ok());
        }

        #[test]
        fn an_expired_round_deadline_refuses_before_queuing_a_realtime_send() {
            let mut transport =
                NativeTransport::new("http://127.0.0.1:9", &serde_json::json!({}), None).unwrap();
            transport.set_round_deadline(Some(std::time::Instant::now() - Duration::from_secs(1)));
            // The refusal precedes the connection check, so a not-connected
            // transport reports the typed round timeout and leaves no frame
            // queued behind it for a later send.
            let error = transport.realtime_send("blocked").unwrap_err();
            assert_eq!(error.code, "transport.timeout");
            assert_eq!(
                error.details,
                Some(serde_json::json!({ "causeKind": "round_deadline" }))
            );
            // With the deadline cleared the same call reaches the connection
            // check instead.
            transport.set_round_deadline(None);
            let error = transport.realtime_send("blocked").unwrap_err();
            assert_eq!(error.code, "transport.failed");
        }

        #[test]
        fn the_request_timeout_bounds_phases_and_the_round_deadline_bounds_the_call() {
            #[derive(Debug)]
            struct TimeoutRecording(Arc<Mutex<Vec<Option<Duration>>>>);
            impl Connector for TimeoutRecording {
                type Out = ();
                fn connect(
                    &self,
                    details: &ConnectionDetails,
                    _: Option<()>,
                ) -> Result<Option<()>, ureq::Error> {
                    self.0
                        .lock()
                        .unwrap()
                        .push(details.config.timeouts().global);
                    Err(ureq::Error::ConnectionFailed)
                }
            }
            let mut transport =
                NativeTransport::new("http://127.0.0.1", &serde_json::json!({}), None).unwrap();
            transport
                .set_policy(HostTransportPolicy {
                    request_timeout: Some(Duration::from_millis(1234)),
                    ..Default::default()
                })
                .unwrap();
            let timeouts = transport.agent.config().timeouts();
            for phase in [
                timeouts.resolve,
                timeouts.connect,
                timeouts.send_request,
                timeouts.recv_response,
            ] {
                assert_eq!(phase, Some(Duration::from_millis(1234)));
            }
            assert_eq!(timeouts.global, None, "the request bound is not end to end");
            assert_eq!(timeouts.recv_body, None, "a body is bounded by silence");
            let seen = Arc::new(Mutex::new(Vec::new()));
            transport.agent = ureq::Agent::with_parts(
                ureq::Agent::config_builder().build(),
                TimeoutRecording(Arc::clone(&seen)),
                DefaultResolver::default(),
            );
            let _ = transport.blob_upload("sha256:test", &[0u8; 4], None);
            transport.set_round_deadline(Some(std::time::Instant::now() + Duration::from_secs(60)));
            let _ = transport.blob_upload("sha256:test", &[0u8; 4], None);
            let seen = seen.lock().unwrap();
            assert_eq!(seen[0], None, "no round deadline, no call ceiling");
            assert!(seen[1].is_some_and(|ceiling| ceiling <= Duration::from_secs(60)));
        }

        #[test]
        fn the_idle_bound_replaces_an_unbounded_or_longer_wait_and_keeps_a_shorter_one() {
            let idle = Duration::from_secs(30);
            let unbounded = NextTimeout {
                after: UreqDuration::NotHappening,
                reason: UreqTimeout::Global,
            };
            assert_eq!(idle_bound(unbounded, idle).after, UreqDuration::Exact(idle));
            let longer = NextTimeout {
                after: UreqDuration::from_secs(90),
                reason: UreqTimeout::Global,
            };
            assert_eq!(idle_bound(longer, idle).after, UreqDuration::Exact(idle));
            let shorter = NextTimeout {
                after: UreqDuration::from_secs(5),
                reason: UreqTimeout::Global,
            };
            assert_eq!(idle_bound(shorter, idle), shorter);
        }

        /// Arrival offsets of a response of `total` bytes in `chunk`-byte
        /// pieces over a link with a one-way `latency`, a `rate` in bytes per
        /// second, and `stalls` (start, length) windows in which nothing
        /// arrives. Virtual time: nothing sleeps.
        fn shaped_link(
            total: u64,
            chunk: u64,
            latency: Duration,
            rate: u64,
            stalls: &[(Duration, Duration)],
        ) -> Vec<Duration> {
            let mut at = latency;
            let mut arrivals = Vec::new();
            let mut left = total;
            while left > 0 {
                let piece = left.min(chunk);
                at += Duration::from_micros(piece * 1_000_000 / rate);
                for (start, length) in stalls {
                    if at > *start && at < *start + *length {
                        at = *start + *length;
                    }
                }
                arrivals.push(at);
                left -= piece;
            }
            arrivals
        }

        /// Run `round_expiry` over a link: `Ok(finished_at)` when every chunk
        /// arrives before the bound, `Err((expired_at, ceiling_bound))`
        /// otherwise.
        fn round_over(
            arrivals: &[Duration],
            idle: Duration,
            ceiling: Option<Duration>,
        ) -> Result<Duration, (Duration, bool)> {
            let base = Instant::now();
            let mut last = base;
            for arrival in arrivals {
                let (deadline, ceiling_binds) =
                    round_expiry(last, idle, ceiling.map(|ceiling| base + ceiling));
                if base + *arrival > deadline {
                    return Err((deadline - base, ceiling_binds));
                }
                last = base + *arrival;
            }
            Ok(last - base)
        }

        #[test]
        fn a_slow_link_that_keeps_delivering_never_trips_the_idle_bound() {
            // Nori's phone behind a relay: an 8.6 MB page at 100 KB/s, 80 ms.
            let link = shaped_link(
                8_600_000,
                64 * 1024,
                Duration::from_millis(80),
                100_000,
                &[],
            );
            let finished = round_over(&link, ROUND_IDLE_TIMEOUT, None).unwrap();
            assert!(
                finished > ROUND_IDLE_TIMEOUT * 2,
                "the transfer outlasts the old whole-transfer bound ({finished:?})"
            );
        }

        #[test]
        fn a_stall_shorter_than_the_idle_bound_is_survived_and_a_longer_one_is_not() {
            let link = |length| {
                shaped_link(
                    4_000_000,
                    64 * 1024,
                    Duration::from_millis(80),
                    100_000,
                    &[(Duration::from_secs(10), length)],
                )
            };
            round_over(&link(Duration::from_secs(29)), ROUND_IDLE_TIMEOUT, None).unwrap();
            let (expired, ceiling_bound) =
                round_over(&link(Duration::from_secs(31)), ROUND_IDLE_TIMEOUT, None).unwrap_err();
            assert!(!ceiling_bound);
            assert!(
                expired >= Duration::from_secs(30) && expired < Duration::from_secs(41),
                "the bound counts from the last chunk before the stall ({expired:?})"
            );
        }

        #[test]
        fn the_host_ceiling_still_bounds_a_link_that_keeps_delivering() {
            let link = shaped_link(
                8_600_000,
                64 * 1024,
                Duration::from_millis(80),
                100_000,
                &[],
            );
            let (expired, ceiling_bound) =
                round_over(&link, ROUND_IDLE_TIMEOUT, Some(Duration::from_secs(60))).unwrap_err();
            assert!(ceiling_bound);
            assert_eq!(expired, Duration::from_secs(60));
        }

        #[test]
        fn an_expired_round_deadline_bounds_the_socket_wait() {
            let channel = RoundChannel::default();
            let error = channel
                .wait(
                    Some(std::time::Instant::now() - Duration::from_secs(1)),
                    ROUND_IDLE_TIMEOUT,
                )
                .unwrap_err();
            assert_eq!(error.code, "transport.timeout");
            assert_eq!(
                error.details,
                Some(serde_json::json!({ "causeKind": "round_deadline" }))
            );
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

    fn minimal_response() -> Vec<u8> {
        use ssp2::model::{Frame, Message, MsgKind};
        ssp2::encode_message(&Message {
            wire_version: ssp2::decode::WIRE_VERSION,
            msg_kind: MsgKind::Response,
            frames: vec![Frame::RespHeader {
                required_schema_version: None,
                latest_schema_version: None,
                log_epoch: Some("epoch".into()),
                reset_required: Some(true),
            }],
        })
    }

    #[test]
    fn a_stalled_response_body_times_out_on_silence() {
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
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n0123456789")
                .unwrap();
            // Withhold the rest until the client gives up and closes.
            let mut rest = Vec::new();
            let _ = std::io::Read::read_to_end(&mut reader, &mut rest);
        });
        let mut transport = HostTransport::new_from_config(
            &serde_json::json!({"baseUrl": base, "requestTimeoutMs": 200}),
        )
        .unwrap();
        let mut received = 0;
        let error = transport
            .download_segment(
                &SegmentRequest {
                    segment_id: "sha256:test".into(),
                    table: "tasks".into(),
                    requested_scopes_json: "{}".into(),
                },
                &mut |bytes| received = bytes,
            )
            .unwrap_err();
        assert_eq!(error.code, "transport.timeout");
        assert_eq!(
            error.details,
            Some(serde_json::json!({ "causeKind": "timeout" }))
        );
        server.join().unwrap();
    }

    #[test]
    fn a_timed_out_socket_round_closes_the_socket_and_reports_the_loss() {
        use std::sync::mpsc::channel;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (closed_tx, closed_rx) = channel();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(socket).unwrap();
            socket.read().unwrap();
            // The head of a response that never finishes.
            let response = minimal_response();
            let mut chunk = vec![crate::REALTIME_TAG_ROUND];
            chunk.extend_from_slice(&response[..response.len() / 2]);
            socket
                .send(tungstenite::Message::Binary(chunk.into()))
                .unwrap();
            // The client must close; the tail is never delivered to a round.
            while let Ok(message) = socket.read() {
                if matches!(message, tungstenite::Message::Close(_)) {
                    break;
                }
            }
            closed_tx.send(()).unwrap();
        });
        let mut transport =
            HostTransport::new_from_config(&serde_json::json!({"baseUrl": base})).unwrap();
        transport.realtime_connect_for_client("slow").unwrap();
        transport.set_round_deadline(Some(
            std::time::Instant::now() + std::time::Duration::from_millis(300),
        ));
        let error = transport.realtime_sync(b"request").unwrap_err();
        assert_eq!(error.code, "transport.timeout");
        closed_rx.recv().unwrap();
        let lost = transport
            .take_inbound()
            .into_iter()
            .filter(|inbound| matches!(inbound, Inbound::Disconnected(e) if e.code == "transport.timeout"))
            .count();
        assert_eq!(lost, 1, "the loss is reported once");
        server.join().unwrap();
    }

    #[test]
    fn a_request_larger_than_a_chunk_rides_as_several_round_chunks() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let request: Vec<u8> = (0..3 * 64 * 1024 + 5).map(|i| (i % 251) as u8).collect();
        let expected = request.clone();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(socket).unwrap();
            let mut body = Vec::new();
            let mut messages = 0;
            while body.len() < expected.len() {
                let message = socket.read().unwrap().into_data();
                assert_eq!(message[0], crate::REALTIME_TAG_ROUND);
                body.extend_from_slice(&message[1..]);
                messages += 1;
            }
            assert_eq!(body, expected);
            assert_eq!(messages, 4);
            let mut chunk = vec![crate::REALTIME_TAG_ROUND];
            chunk.extend(minimal_response());
            socket
                .send(tungstenite::Message::Binary(chunk.into()))
                .unwrap();
        });
        let mut transport =
            HostTransport::new_from_config(&serde_json::json!({"baseUrl": base})).unwrap();
        transport.realtime_connect_for_client("chunked").unwrap();
        let response = transport.realtime_sync(&request).unwrap();
        assert_eq!(response, minimal_response());
        transport.shutdown();
        server.join().unwrap();
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
                Some(serde_json::json!({
                    "causeKind": "status",
                    "httpStatus": status,
                    "retryable": false
                }))
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

    #[test]
    fn request_over_cap_is_refused_before_network() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mut transport =
            HostTransport::from_config(&serde_json::json!({"baseUrl": base, "maxRequestBytes": 4}))
                .unwrap();
        let error = transport
            .blob_upload("sha256:test", &[0u8; 8], None)
            .unwrap_err();
        assert_eq!(error.code, "transport.request_too_large");
        assert_eq!(
            error.details,
            Some(serde_json::json!({ "limit": 4, "size": 8 }))
        );
        assert!(
            matches!(listener.accept(), Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the request cap is checked before any connection"
        );
    }

    #[test]
    fn credential_bearing_redirects_are_refused_without_contacting_the_destination() {
        for credentials in ["headers", "userinfo", "password"] {
            for redirects in ["deny", "follow"] {
                let destination = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                destination.set_nonblocking(true).unwrap();
                let location = format!("http://{}/landed", destination.local_addr().unwrap());
                let origin = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let host = origin.local_addr().unwrap();
                let (base, headers) = match credentials {
                    "headers" => (
                        format!("http://{host}"),
                        serde_json::json!({"authorization": "Bearer secret"}),
                    ),
                    "userinfo" => (format!("http://user:secret@{host}"), serde_json::json!({})),
                    _ => (format!("http://:secret@{host}"), serde_json::json!({})),
                };
                let server = std::thread::spawn(move || {
                    let (mut socket, _) = origin.accept().unwrap();
                    let mut reader = BufReader::new(socket.try_clone().unwrap());
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                    }
                    let _ = write!(
                        socket,
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                });
                let mut transport = HostTransport::from_config(&serde_json::json!({
                    "baseUrl": base,
                    "redirects": redirects,
                    "headers": headers,
                }))
                .unwrap();
                let error = transport.blob_download("sha256:test").unwrap_err();
                assert_eq!(
                    error.code, "transport.redirect",
                    "{credentials} {redirects}"
                );
                let details = error.details.unwrap();
                assert_eq!(details["causeKind"], "redirect");
                assert_eq!(details["httpStatus"], 302);
                assert!(
                    matches!(destination.accept(), Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock),
                    "{credentials} {redirects}: the destination is never contacted"
                );
                server.join().unwrap();
            }
        }
    }

    #[test]
    fn websocket_handshake_redirects_obey_the_redirect_policy() {
        // The handshake request carries the configured headers and the realtime
        // URL's query, so a redirect response is an error and never replays
        // them to the Location. The Location points at a second listener so
        // the test can prove it was never contacted. A `follow` policy cannot
        // establish at all and fails before any connection (see
        // `tests/realtime_disconnect.rs`).
        for credential in ["headers", "userinfo", "query", "none"] {
            let redirects = "deny";
            let destination = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let destination_addr = destination.local_addr().unwrap();
            let location = format!("ws://{destination_addr}/realtime");
            // The redirect target answers every handshake with 400 and stops
            // on an explicit sentinel connection, so a leaked redirect fails
            // the assertions below instead of hanging the test.
            let landed = Arc::new(Mutex::new(Vec::new()));
            let landed_writer = Arc::clone(&landed);
            let destination_thread = std::thread::spawn(move || loop {
                let (mut socket, _) = destination.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let sentinel = head.starts_with("GET /sentinel");
                landed_writer.lock().unwrap().push(head);
                let _ = write!(
                    socket,
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                if sentinel {
                    break;
                }
            });
            let origin = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let origin_addr = origin.local_addr().unwrap();
            let (headers, ws_url) = match credential {
                "headers" => (serde_json::json!({"authorization": "Bearer secret"}), None),
                "userinfo" => (
                    serde_json::json!({}),
                    Some(format!("ws://user:secret@{origin_addr}/realtime")),
                ),
                "query" => (
                    serde_json::json!({}),
                    Some(format!("ws://{origin_addr}/realtime?token=secret")),
                ),
                _ => (serde_json::json!({}), None),
            };
            let (head_tx, head_rx) = std::sync::mpsc::channel();
            let origin_thread = std::thread::spawn(move || {
                let (mut socket, _) = origin.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let _ = head_tx.send(head);
                let _ = write!(
                    socket,
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
            });
            let mut config = serde_json::json!({
                "baseUrl": format!("http://{origin_addr}"),
                "headers": headers,
                "redirects": redirects,
            });
            if let Some(ws_url) = &ws_url {
                config["wsUrl"] = serde_json::json!(ws_url);
            }
            let mut transport = HostTransport::from_config(&config).unwrap();
            let result = transport.realtime_connect();
            // Stop the responder even when the redirect was refused; the
            // sentinel is the only connection it may have seen.
            let mut sentinel = std::net::TcpStream::connect(destination_addr).unwrap();
            let _ = write!(sentinel, "GET /sentinel HTTP/1.1\r\nHost: sentinel\r\n\r\n");
            destination_thread.join().unwrap();
            let landed = landed.lock().unwrap().clone();
            origin_thread.join().unwrap();
            let error = result.unwrap_err();
            assert_eq!(
                error.code, "transport.redirect",
                "{credential}: a refused handshake redirect surfaces the redirect code"
            );
            let details = error.details.unwrap();
            assert_eq!(details["causeKind"], "redirect");
            assert_eq!(details["httpStatus"], 302);
            assert_eq!(
                landed.len(),
                1,
                "{credential}: the redirect target is never contacted: {landed:?}"
            );
            assert!(landed[0].starts_with("GET /sentinel"), "{landed:?}");
            let head = head_rx.recv().unwrap();
            if credential == "userinfo" {
                assert!(
                    !head.contains("secret"),
                    "the handshake request line drops URL userinfo"
                );
            }
            if credential == "query" {
                assert!(
                    head.contains("token=secret"),
                    "the handshake request line carries the realtime query"
                );
            }
        }
    }

    // 200000 decoded bytes in 548 compressed bytes: a decompression bomb the
    // decoded cap must stop before the buffer grows.
    const GZIP_BOMB: [u8; 548] = [
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0xed, 0xc9, 0xb1, 0x11, 0x80,
        0x20, 0x10, 0x00, 0xb0, 0x59, 0x1c, 0x80, 0xa1, 0xfe, 0x90, 0xb3, 0x41, 0xf0, 0x7c, 0x2d,
        0xd8, 0xde, 0x09, 0xdc, 0x20, 0x69, 0x93, 0x6b, 0xd4, 0xb7, 0xc7, 0x5d, 0xb2, 0x1d, 0x67,
        0x1b, 0x4f, 0xb9, 0x62, 0xf5, 0x19, 0xfb, 0x96, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08,
        0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0x10, 0x42, 0x08, 0x21, 0x84, 0xf8, 0x8b, 0x0f,
        0xdb, 0x82, 0xf4, 0xa9, 0x40, 0x0d, 0x03, 0x00,
    ];

    #[test]
    fn decoded_response_cap_counts_decompressed_bytes() {
        for cap in [200000u64, 199999] {
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
                }
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    GZIP_BOMB.len()
                );
                let _ = socket.write_all(&GZIP_BOMB);
            });
            let mut transport = HostTransport::from_config(
                &serde_json::json!({"baseUrl": base, "maxResponseBytes": cap}),
            )
            .unwrap();
            let result = transport.fetch_blob_url(&format!("{base}/signed"));
            if cap == 200000 {
                let body = result.expect("a cap equal to the decoded size admits the body");
                assert_eq!(body.len(), 200000);
            } else {
                let error = result.unwrap_err();
                assert_eq!(error.code, "transport.response_too_large");
                assert_eq!(error.details, Some(serde_json::json!({ "limit": cap })));
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn a_json_http_error_body_reaches_the_caller() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let body = r#"{"code":"sync.invalid_client_id","category":"invalid-request","retryable":false,"recommendedAction":"resetClientId","message":"clientId is bound to a different actor in this partition (§1.5)","details":{"actorId":"actor-b"}}"#;
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            let _ = write!(
                socket,
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        });
        let mut transport =
            HostTransport::new_from_config(&serde_json::json!({"baseUrl": base})).unwrap();
        let error = transport.sync(&[]).unwrap_err();
        assert_eq!(error.code, "sync.invalid_client_id");
        assert_eq!(
            error.message,
            "clientId is bound to a different actor in this partition (§1.5)"
        );
        let details = error.details.unwrap();
        assert_eq!(details["recommendedAction"], "resetClientId");
        assert_eq!(details["category"], "invalid-request");
        assert_eq!(details["retryable"], false);
        assert_eq!(details["httpStatus"], 400);
        assert_eq!(details["actorId"], "actor-b");
        server.join().unwrap();
    }
}

#[cfg(test)]
mod local_authority_tests {
    use super::HostTransport;
    use crate::Transport;

    #[cfg(not(feature = "local-authority"))]
    #[test]
    fn a_local_authority_path_without_the_feature_fails_with_the_unconfigured_code() {
        let error = HostTransport::from_config(
            &serde_json::json!({ "localAuthorityPath": "authority.sqlite" }),
        )
        .err()
        .expect("a build without local-authority refuses localAuthorityPath");
        assert!(
            error.starts_with("client.local_authority_unconfigured:"),
            "{error}"
        );
    }

    #[test]
    fn a_config_without_a_local_authority_reports_none() {
        let mut transport = HostTransport::from_config(&serde_json::json!({}))
            .ok()
            .unwrap();
        assert_eq!(transport.local_authority_state(), None);
        let error = transport.attach_local_authority().unwrap_err();
        assert_eq!(error.code, "client.local_authority_unconfigured");
        let error = transport.abandon_local_authority_attach().unwrap_err();
        assert_eq!(error.code, "client.local_authority_unconfigured");
    }

    #[cfg(feature = "local-authority")]
    mod with_feature {
        use serde_json::{json, Map, Value};
        use syncular_authority::LocalAuthority;

        use super::super::{HostTransport, LocalAuthorityTransport};
        use crate::{
            ClientLimits, Mutation, SegmentFetch, SegmentRequest, SubscriptionRequest, SyncClient,
            SyncOutcome, Transport, TransportError,
        };

        fn schema() -> Value {
            json!({
                "version": 1,
                "tables": [{
                    "name": "todos",
                    "columns": [
                        { "name": "id", "type": "string", "nullable": false },
                        { "name": "list_id", "type": "string", "nullable": false }
                    ],
                    "primaryKey": "id",
                    "scopes": [{ "pattern": "list:{list_id}", "column": "list_id" }]
                }]
            })
        }

        /// The remote server: a second authority that serves the requests the
        /// first one's attach and the client's later rounds send it.
        struct AuthorityServer {
            server: LocalAuthority,
            syncs: usize,
        }

        impl Transport for AuthorityServer {
            fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError> {
                self.syncs += 1;
                self.server.sync(request).map_err(|error| TransportError {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                })
            }
            fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
                Err(TransportError::new("sync.transport_failed", "no socket"))
            }
            fn download_segment(
                &mut self,
                _request: &SegmentRequest,
                _on_progress: &mut dyn FnMut(u64),
            ) -> Result<Vec<u8>, TransportError> {
                Err(TransportError::new("sync.transport_failed", "no segments"))
            }
            fn realtime_connect(&mut self) -> Result<(), TransportError> {
                Err(TransportError::new("sync.transport_failed", "no socket"))
            }
            fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
                Ok(())
            }
            fn realtime_close(&mut self) -> Result<(), TransportError> {
                Ok(())
            }
        }

        #[test]
        fn a_configured_path_routes_to_the_authority_and_refuses_what_it_lacks() {
            let mut transport =
                HostTransport::from_config(&json!({ "localAuthorityPath": ":memory:" }))
                    .ok()
                    .unwrap();
            assert!(matches!(transport, HostTransport::Local(_)));
            // The authority opens with the client's schema at create.
            assert_eq!(transport.local_authority_state(), None);
            assert_eq!(
                transport.sync(b"").unwrap_err().code,
                "client.local_authority_unconfigured"
            );
            assert_eq!(
                transport
                    .realtime_connect_for_client("device-1")
                    .unwrap_err()
                    .code,
                "sync.invalid_request"
            );
            let refused = transport.download_segments(
                &[SegmentFetch::Url("https://cdn.example.com/s1".to_owned())],
                &mut |_, _| {},
            );
            assert_eq!(refused.len(), 1);
            assert_eq!(
                refused[0].as_ref().unwrap_err().code,
                "sync.invalid_request"
            );
            // Attach needs a remote server.
            let error = transport.attach_local_authority().unwrap_err();
            assert_eq!(error.code, "client.local_authority_unconfigured");
        }

        #[test]
        fn the_authority_path_must_differ_from_the_replica_and_be_a_string() {
            let mut transport =
                HostTransport::from_config(&json!({ "localAuthorityPath": "/data/app.sqlite" }))
                    .ok()
                    .unwrap();
            let error = transport
                .open_local_authority(&schema(), Some("/data/app.sqlite"))
                .unwrap_err();
            assert_eq!(error.code, "sync.invalid_request");
            for path in [json!(""), json!(7)] {
                assert!(
                    HostTransport::from_config(&json!({ "localAuthorityPath": path })).is_err()
                );
            }
        }

        #[test]
        fn rounds_reach_the_authority_until_attach_then_the_remote_server() {
            let schema = schema();
            let remote = AuthorityServer {
                server: LocalAuthority::open(":memory:", &schema).expect("open the remote"),
                syncs: 0,
            };
            let mut transport = LocalAuthorityTransport::new(":memory:", remote, true);
            transport
                .open_local_authority(&schema, None)
                .expect("open the local authority");
            assert_eq!(transport.local_authority_state(), Some("local"));

            let mut client = SyncClient::new_with_identity(
                Some("device-1".to_owned()),
                &schema,
                ClientLimits::default(),
            )
            .expect("client");
            client
                .subscribe_many(vec![SubscriptionRequest {
                    id: "todos".to_owned(),
                    table: "todos".to_owned(),
                    scopes: vec![("list_id".to_owned(), vec!["l1".to_owned()])],
                    params: None,
                }])
                .expect("subscribe");
            client
                .mutate(vec![Mutation::Upsert {
                    table: "todos".to_owned(),
                    values: Map::from_iter([
                        ("id".to_owned(), json!("t1")),
                        ("list_id".to_owned(), json!("l1")),
                    ]),
                    base_version: None,
                }])
                .expect("mutate");
            let outcome = client.sync_until_idle(&mut transport, None);
            assert!(
                matches!(outcome, SyncOutcome::Ok(_)),
                "{:?}",
                outcome.to_json()
            );
            assert!(client.pending_commit_ids().is_empty());
            assert_eq!(
                transport.remote.syncs, 0,
                "the local authority served the round"
            );
            let error = client.connect_realtime(&mut transport).unwrap_err();
            assert!(error.starts_with("sync.invalid_request:"), "{error}");

            transport.attach_local_authority().expect("attach");
            assert_eq!(transport.local_authority_state(), Some("attached"));
            let uploads = transport.remote.syncs;
            assert!(uploads > 0, "attach uploaded through the remote transport");

            // The remote server's log epoch differs, so the replica resets and
            // bootstraps the attached row from it.
            let outcome = client.sync_until_idle(&mut transport, None);
            assert!(
                matches!(outcome, SyncOutcome::Ok(_)),
                "{:?}",
                outcome.to_json()
            );
            assert!(transport.remote.syncs > uploads);
            let rows = client.read_rows("todos").expect("rows");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].row_id, "t1");
            assert!(rows[0].version >= 1);
        }
    }
}
