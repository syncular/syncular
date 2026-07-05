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

/// A §5.9.5 blob download result: inline bytes, or a presigned url the client
/// fetches directly (always-issue). `url_expires_at_ms` is present iff `url`.
#[derive(Debug, Clone)]
pub enum BlobDownload {
    Bytes(Vec<u8>),
    Url {
        url: String,
        url_expires_at_ms: Option<i64>,
    },
}

/// A §5.9.3 presigned-upload grant: a single PUT url, an already-present
/// marker (skip the PUT), or none (stream through the direct endpoint).
#[derive(Debug, Clone)]
pub enum BlobUploadGrant {
    Url {
        url: String,
        url_expires_at_ms: Option<i64>,
    },
    Present,
    None,
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
    /// §5.9.3 blob upload: host-authenticated `PUT <mount>/blobs/{blobId}`.
    /// The server verifies the content address. Default: unsupported.
    fn blob_upload(
        &mut self,
        blob_id: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        let _ = (blob_id, bytes, media_type);
        Err(TransportError::new(
            "sync.invalid_request",
            "this transport has no blob upload (§5.9)",
        ))
    }
    /// §5.9.5 blob download: host-authenticated `GET <mount>/blobs/{blobId}`,
    /// re-authorized server-side against referencing rows. Returns inline
    /// bytes OR (always-issue, presign configured) a signed url the client
    /// fetches directly. Default: none.
    fn blob_download(&mut self, blob_id: &str) -> Result<BlobDownload, TransportError> {
        let _ = blob_id;
        Err(TransportError::new(
            "blob.not_found",
            "this transport has no blob download (§5.9)",
        ))
    }
    /// §5.9.5 presigned-download fetch: a bare GET of the signed url. MUST
    /// attach NO host authentication — the url is the entire grant (§5.4).
    /// Only called when `blob_download` returned a `Url` arm.
    fn fetch_blob_url(&mut self, url: &str) -> Result<Vec<u8>, TransportError> {
        let _ = url;
        Err(TransportError::new(
            "sync.invalid_request",
            "this transport has no blob url fetch (§5.9.5)",
        ))
    }
    /// §5.9.3 presigned-upload grant: `POST /blobs/{blobId}/upload-grant` with
    /// the declared size. Absent (`None`) ⇒ the client always streams through
    /// `blob_upload`. A `Url` grant is PUT via `blob_put_url`.
    fn blob_upload_grant(
        &mut self,
        blob_id: &str,
        byte_length: u64,
        media_type: Option<&str>,
    ) -> Result<BlobUploadGrant, TransportError> {
        let _ = (blob_id, byte_length, media_type);
        Ok(BlobUploadGrant::None)
    }
    /// §5.9.3 direct-to-storage PUT of the granted url. MUST attach NO host
    /// authentication — the presigned url is the entire grant (§5.4). Only
    /// called when `blob_upload_grant` returned a `Url` arm.
    fn blob_put_url(
        &mut self,
        url: &str,
        bytes: &[u8],
        media_type: Option<&str>,
    ) -> Result<(), TransportError> {
        let _ = (url, bytes, media_type);
        Err(TransportError::new(
            "sync.invalid_request",
            "this transport has no blob put url (§5.9.3)",
        ))
    }
    /// Realtime attach (§8.1). Inbound traffic is delivered by the host via
    /// `SyncClient::on_realtime_text` / `on_realtime_binary`.
    fn realtime_connect(&mut self) -> Result<(), TransportError>;
    /// Client → server JSON control message (acks, §8.2).
    fn realtime_send(&mut self, text: &str) -> Result<(), TransportError>;
    fn realtime_close(&mut self) -> Result<(), TransportError>;
}
