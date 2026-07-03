//! The transport seam handed TO the client by its host (the conformance
//! harness, an app shell, …). Bytes and strings only — mirroring the
//! `ClientEndpoints` inversion of the conformance driver contract. The
//! client is synchronous: the driver protocol is request/response.

/// A transport-level or request-level failure (§1.1 HTTP-JSON surface).
#[derive(Debug, Clone)]
pub struct TransportError {
    pub code: String,
    pub message: String,
}

impl TransportError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        TransportError {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Direct-endpoint segment fetch (§5.5). Signed-URL descriptors never
/// reach this call: the §5.4 resolution lives in the client core, which
/// routes url-carrying descriptors through `fetch_url` instead.
#[derive(Debug, Clone)]
pub struct SegmentRequest {
    pub segment_id: String,
    pub table: String,
    /// Canonical JSON (§11.2) of the requested scope map (§5.5).
    pub requested_scopes_json: String,
}

pub trait Transport {
    /// One combined push+pull round trip (§1.5) over the request/response
    /// binding (`POST /sync`, loopback, …).
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError>;
    /// One combined push+pull round over the realtime socket (§8.7). The
    /// host owns the WS-binding mechanics — channel tags, chunk assembly
    /// to the response's END — and returns the assembled response bytes.
    /// The client calls this instead of `sync` whenever realtime is
    /// connected (Direction decision 1: the socket IS the sync-round
    /// transport, not a fallback pair); the server registers the round's
    /// subscriptions on the connection at round end, so no reconnect is
    /// needed after subscription changes.
    fn realtime_sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError>;
    /// Segment download via the direct endpoint (§5.5).
    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError>;
    /// §5.4 direct URL fetch capability: `true` makes the client
    /// advertise accept bit 3 (capability negotiation, §4.2). Default:
    /// not capable.
    fn supports_url_fetch(&self) -> bool {
        false
    }
    /// Plain GET of a signed URL (§5.4). The URL is the entire grant —
    /// implementations MUST NOT attach sync-server authentication or the
    /// `X-Syncular-Scopes` header. Only called when `supports_url_fetch`
    /// returned `true`.
    fn fetch_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        let _ = url;
        Err(TransportError::new(
            "sync.invalid_request",
            "this transport has no direct URL fetch (§5.4)",
        ))
    }
    /// Realtime attach (§8.1). Inbound traffic is delivered by the host via
    /// `SyncClient::on_realtime_text` / `on_realtime_binary`.
    fn realtime_connect(&mut self) -> Result<(), TransportError>;
    /// Client → server JSON control message (acks, §8.2).
    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError>;
    fn realtime_close(&mut self) -> Result<(), TransportError>;
}
