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

/// Segment fetch request (§5.4 resolution order is the client's concern;
/// the harness endpoint receives the descriptor fields it needs).
#[derive(Debug, Clone)]
pub struct SegmentRequest {
    pub segment_id: String,
    pub table: String,
    pub url: Option<String>,
    pub url_expires_at_ms: Option<i64>,
    /// Canonical JSON (§11.2) of the requested scope map (§5.5).
    pub requested_scopes_json: String,
}

pub trait Transport {
    /// One combined push+pull round trip (§1.5).
    fn sync(&mut self, request: &[u8]) -> Result<Vec<u8>, TransportError>;
    /// Segment download (§5.4/§5.5).
    fn download_segment(&mut self, request: &SegmentRequest) -> Result<Vec<u8>, TransportError>;
    /// Realtime attach (§8.1). Inbound traffic is delivered by the host via
    /// `SyncClient::on_realtime_text` / `on_realtime_binary`.
    fn realtime_connect(&mut self) -> Result<(), TransportError>;
    /// Client → server JSON control message (acks, §8.2).
    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError>;
    fn realtime_close(&mut self) -> Result<(), TransportError>;
}
