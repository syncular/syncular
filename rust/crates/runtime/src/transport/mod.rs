#[cfg(feature = "native")]
use crate::app_schema::default_app_schema;
#[cfg(feature = "native")]
use crate::binary_snapshot::decode_binary_snapshot_rows;
use crate::binary_snapshot::SnapshotChunkRows;
#[cfg(feature = "native")]
use crate::binary_sync_pack::{decode_binary_sync_pack, is_binary_sync_pack_content_type};
use crate::error::{ErrorKind, Result, SyncularError};
use crate::protocol::*;
#[cfg(feature = "native")]
use flate2::read::GzDecoder;
#[cfg(feature = "native")]
use reqwest::blocking::Body as BlockingBody;
#[cfg(feature = "native")]
use reqwest::blocking::Client as HttpClient;
#[cfg(feature = "native")]
use reqwest::Method;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
#[cfg(feature = "native")]
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[cfg(feature = "native")]
use std::fs;
#[cfg(feature = "native")]
use std::fs::File;
#[cfg(feature = "native")]
use std::io::{Read, Write};
#[cfg(feature = "native")]
use std::net::{TcpStream, ToSocketAddrs};
#[cfg(feature = "native")]
use std::path::{Path, PathBuf};
#[cfg(feature = "native")]
use std::sync::{Arc, Mutex};
#[cfg(feature = "native")]
use std::time::{Duration, SystemTime};
#[cfg(feature = "native")]
use tungstenite::client::IntoClientRequest;
#[cfg(feature = "native")]
use tungstenite::stream::MaybeTlsStream;
#[cfg(feature = "native")]
use tungstenite::{client_tls_with_config, Message, WebSocket};
#[cfg(feature = "native")]
use uuid::Uuid;

#[cfg(all(feature = "web-transport", target_arch = "wasm32"))]
pub mod web;

pub type SyncAuthHeaders = BTreeMap<String, String>;

#[cfg(feature = "native")]
#[derive(Debug, Clone)]
pub struct SyncRequestToSign {
    pub method: String,
    pub url: String,
    pub body: Vec<u8>,
}

#[cfg(feature = "native")]
pub type SyncAuthSigner =
    Arc<dyn Fn(SyncRequestToSign) -> std::result::Result<SyncAuthHeaders, String> + Send + Sync>;

pub trait SyncAuthHeaderStore {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders);
}

#[cfg(feature = "native")]
pub trait SyncAuthSignerStore {
    fn set_auth_signer(&mut self, signer: Option<SyncAuthSigner>);
}

#[cfg(feature = "native")]
#[derive(Debug, Clone)]
pub struct SyncTransportConfig {
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub timeouts: SyncTransportTimeouts,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncTransportTimeouts {
    pub http_connect: Duration,
    pub http_request: Duration,
    pub http_response_body: Duration,
    pub websocket_open: Duration,
    pub websocket_idle: Duration,
    pub websocket_push_response: Duration,
    pub websocket_shutdown: Duration,
}

#[cfg(feature = "native")]
impl Default for SyncTransportTimeouts {
    fn default() -> Self {
        Self {
            http_connect: Duration::from_secs(10),
            http_request: Duration::from_secs(30),
            http_response_body: Duration::from_secs(30),
            websocket_open: Duration::from_secs(10),
            websocket_idle: Duration::from_secs(1),
            websocket_push_response: Duration::from_secs(10),
            websocket_shutdown: Duration::from_secs(2),
        }
    }
}

#[cfg(feature = "native")]
impl SyncTransportConfig {
    pub fn new(
        base_url: impl Into<String>,
        client_id: impl Into<String>,
        actor_id: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            client_id: client_id.into(),
            actor_id: actor_id.into(),
            timeouts: SyncTransportTimeouts::default(),
        }
    }
}

#[cfg(feature = "native")]
pub struct HttpSyncTransport {
    http: HttpClient,
    config: SyncTransportConfig,
    auth_headers: SyncAuthHeaders,
    auth_signer: Option<SyncAuthSigner>,
    schema_version: i32,
    sync_trace_context: Mutex<Option<SyncTraceContext>>,
}

#[cfg(feature = "native")]
pub struct RealtimeSocket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    push_response_timeout: Duration,
    shutdown_timeout: Duration,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncTraceContext {
    sync_attempt_id: String,
    trace_id: String,
    span_id: String,
}

pub use crate::protocol::{RealtimePresenceEntry, RealtimePresenceEvent};

#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    Sync,
    Presence(RealtimePresenceEvent),
    Other(String),
}

pub trait SyncTransport {
    type Realtime: RealtimeTransport;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse>;
    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &ScopeValues,
    ) -> Result<SnapshotChunkRows>;
    fn fetch_snapshot_artifact_bytes(
        &self,
        _artifact: &ScopedSnapshotArtifactRef,
        _scopes: &ScopeValues,
    ) -> Result<Vec<u8>> {
        Err(SyncularError::protocol_message(
            "snapshot artifact transport is not implemented",
        ))
    }
    fn connect_realtime(&self) -> Result<Self::Realtime>;
}

pub trait BlobTransport {
    fn upload_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<()>;
    fn download_blob(&self, blob: &BlobRef) -> Result<Vec<u8>>;

    #[cfg(feature = "native")]
    fn upload_blob_file(&self, blob: &BlobRef, path: &Path) -> Result<()> {
        let bytes = fs::read(path).map_err(|err| {
            SyncularError::storage(err).context(format!("read blob file {path:?}"))
        })?;
        self.upload_blob(blob, &bytes)
    }

    #[cfg(feature = "native")]
    fn download_blob_to_file(&self, blob: &BlobRef, path: &Path) -> Result<()> {
        let bytes = self.download_blob(blob)?;
        fs::write(path, bytes)
            .map_err(|err| SyncularError::storage(err).context(format!("write blob file {path:?}")))
    }
}

pub trait RealtimeTransport {
    fn push_commit(&mut self, commit: PushCommitRequest) -> Result<PushCommitResponse>;
    fn send_presence(
        &mut self,
        action: &str,
        scope_key: &str,
        metadata: Option<&Value>,
    ) -> Result<()> {
        let _ = (action, scope_key, metadata);
        Err(SyncularError::message(
            ErrorKind::Transport,
            "realtime presence is not supported by this transport",
        ))
    }
    fn read_event(&mut self) -> Result<Option<RealtimeEvent>>;
    fn close(&mut self);
}

#[cfg(feature = "native")]
impl HttpSyncTransport {
    pub fn new(config: SyncTransportConfig) -> Self {
        let http = HttpClient::builder()
            .connect_timeout(config.timeouts.http_connect)
            .timeout(config.timeouts.http_request)
            .build()
            .unwrap_or_else(|_| HttpClient::new());
        Self {
            http,
            config,
            auth_headers: SyncAuthHeaders::new(),
            auth_signer: None,
            schema_version: default_app_schema().current_schema_version(),
            sync_trace_context: Mutex::new(None),
        }
    }

    pub fn with_schema_version(mut self, schema_version: i32) -> Self {
        self.schema_version = schema_version;
        self
    }

    pub fn issue_auth_lease(
        &self,
        request: &AuthLeaseIssueRequest,
    ) -> Result<AuthLeaseIssueResponse> {
        let url = format!(
            "{}/auth-leases/issue",
            self.config.base_url.trim_end_matches('/')
        );
        let body = serde_json::to_vec(request)?;
        let builder = self
            .http
            .post(&url)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("x-syncular-schema-version", self.schema_version.to_string());
        let response = self
            .apply_auth(builder, "POST", &url, &body)?
            .body(body)
            .send()
            .map_err(|err| SyncularError::transport(err).context(format!("POST {url}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("auth lease issue failed with HTTP {status}: {body}"),
            ));
        }

        let response: AuthLeaseIssueResponse = response.json()?;
        if !response.ok {
            return Err(SyncularError::message(
                ErrorKind::Transport,
                "auth lease issue returned ok=false",
            ));
        }
        Ok(response)
    }
}

#[cfg(feature = "native")]
impl SyncAuthHeaderStore for HttpSyncTransport {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.auth_headers = headers;
    }
}

#[cfg(feature = "native")]
impl SyncAuthSignerStore for HttpSyncTransport {
    fn set_auth_signer(&mut self, signer: Option<SyncAuthSigner>) {
        self.auth_signer = signer;
    }
}

#[cfg(feature = "native")]
impl SyncTransport for HttpSyncTransport {
    type Realtime = RealtimeSocket;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let body = serde_json::to_vec(request)?;
        let mut headers = self.signed_auth_headers("POST", &self.config.base_url, &body)?;
        let trace_context = SyncTraceContext::from_headers_or_new(&headers);
        trace_context.insert_missing_headers(&mut headers);
        self.set_sync_trace_context(trace_context);
        let builder = self
            .http
            .post(&self.config.base_url)
            .header("content-type", "application/json")
            .header("x-syncular-schema-version", self.schema_version.to_string())
            .header("x-syncular-transport-path", "direct");
        let response = self
            .apply_headers(builder, &headers)
            .body(body)
            .send()
            .map_err(|err| {
                SyncularError::transport(err).context(format!("POST {}", self.config.base_url))
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("sync failed with HTTP {status}: {body}"),
            ));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if is_binary_sync_pack_content_type(content_type.as_deref()) {
            let bytes = response.bytes()?.to_vec();
            return decode_binary_sync_pack(&bytes);
        }

        Ok(response.json()?)
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &ScopeValues,
    ) -> Result<SnapshotChunkRows> {
        validate_snapshot_chunk_ref_size(chunk)?;
        let url = format!(
            "{}/snapshot-chunks/{}",
            self.config.base_url.trim_end_matches('/'),
            chunk.id
        );
        let request = self
            .http
            .get(&url)
            .header("x-syncular-snapshot-scopes", serde_json::to_string(scopes)?);
        let mut headers = self.signed_auth_headers("GET", &url, &[])?;
        let trace_context = self.sync_trace_context(&headers);
        trace_context.insert_missing_headers(&mut headers);
        let response = self
            .apply_headers(request, &headers)
            .send()
            .map_err(|err| SyncularError::transport(err).context(format!("GET {url}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("snapshot chunk failed with HTTP {status}: {body}"),
            ));
        }
        syncular_protocol::validate_snapshot_chunk_format(chunk)?;
        let compressed = response.bytes()?.to_vec();
        decode_compressed_snapshot_chunk_rows(chunk, &compressed)
    }

    fn fetch_snapshot_artifact_bytes(
        &self,
        artifact: &ScopedSnapshotArtifactRef,
        scopes: &ScopeValues,
    ) -> Result<Vec<u8>> {
        validate_snapshot_artifact_ref_size(artifact)?;
        let url = format!(
            "{}/snapshot-artifacts/{}",
            self.config.base_url.trim_end_matches('/'),
            artifact.id
        );
        let request = self
            .http
            .get(&url)
            .header("x-syncular-snapshot-scopes", serde_json::to_string(scopes)?);
        let mut headers = self.signed_auth_headers("GET", &url, &[])?;
        let trace_context = self.sync_trace_context(&headers);
        trace_context.insert_missing_headers(&mut headers);
        let response = self
            .apply_headers(request, &headers)
            .send()
            .map_err(|err| SyncularError::transport(err).context(format!("GET {url}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("snapshot artifact failed with HTTP {status}: {body}"),
            ));
        }
        let bytes = response.bytes()?.to_vec();
        decode_snapshot_artifact_bytes(artifact, &bytes)
    }

    fn connect_realtime(&self) -> Result<RealtimeSocket> {
        RealtimeSocket::connect(
            &self.config,
            &self.auth_headers,
            self.auth_signer.clone(),
            self.schema_version,
        )
    }
}

#[cfg(feature = "native")]
impl BlobTransport for HttpSyncTransport {
    fn upload_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<()> {
        validate_blob_bytes(blob, bytes)?;
        self.upload_blob_body(blob, BlockingBody::from(bytes.to_vec()))
    }

    fn upload_blob_file(&self, blob: &BlobRef, path: &Path) -> Result<()> {
        let file = File::open(path).map_err(|err| {
            SyncularError::storage(err).context(format!("open blob file {path:?}"))
        })?;
        let (actual_hash, actual_size) = blob_hash_reader(file)?;
        validate_blob_digest(blob, &actual_hash, actual_size)?;
        let file = File::open(path).map_err(|err| {
            SyncularError::storage(err).context(format!("reopen blob file {path:?}"))
        })?;
        let len = u64::try_from(blob.size)
            .map_err(|_| SyncularError::protocol_message("blob size cannot be negative"))?;
        self.upload_blob_body(blob, BlockingBody::sized(file, len))
    }

    fn download_blob(&self, blob: &BlobRef) -> Result<Vec<u8>> {
        validate_blob_hash(&blob.hash)?;
        validate_blob_ref_size(blob)?;
        let response = self.open_blob_download(blob)?;
        let bytes = response.bytes()?.to_vec();
        validate_blob_bytes(blob, &bytes)?;
        Ok(bytes)
    }

    fn download_blob_to_file(&self, blob: &BlobRef, path: &Path) -> Result<()> {
        validate_blob_hash(&blob.hash)?;
        validate_blob_ref_size(blob)?;
        let mut response = self.open_blob_download(blob)?;
        let temp_path = temp_download_path(path);
        let mut file = File::create(&temp_path).map_err(|err| {
            SyncularError::storage(err).context(format!("create blob temp file {temp_path:?}"))
        })?;
        let mut hasher = Sha256::new();
        let mut size = 0i64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = response.read(&mut buffer).map_err(|err| {
                SyncularError::transport(err).context("read blob download response")
            })?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(i64::try_from(read).map_err(|_| {
                    SyncularError::protocol_message("blob chunk is too large for size metadata")
                })?)
                .ok_or_else(|| SyncularError::protocol_message("blob is too large"))?;
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read]).map_err(|err| {
                SyncularError::storage(err).context(format!("write blob temp file {temp_path:?}"))
            })?;
        }
        file.flush().map_err(|err| {
            SyncularError::storage(err).context(format!("flush blob temp file {temp_path:?}"))
        })?;
        validate_blob_digest(
            blob,
            &format!("sha256:{}", hex::encode(hasher.finalize())),
            size,
        )?;
        fs::rename(&temp_path, path).map_err(|err| {
            SyncularError::storage(err)
                .context(format!("move blob temp file {temp_path:?} to {path:?}"))
        })?;
        Ok(())
    }
}

#[cfg(feature = "native")]
impl HttpSyncTransport {
    fn apply_auth(
        &self,
        builder: reqwest::blocking::RequestBuilder,
        method: &str,
        url: &str,
        body: &[u8],
    ) -> Result<reqwest::blocking::RequestBuilder> {
        Ok(self.apply_headers(builder, &self.signed_auth_headers(method, url, body)?))
    }

    fn signed_auth_headers(&self, method: &str, url: &str, body: &[u8]) -> Result<SyncAuthHeaders> {
        let mut headers = self.auth_headers.clone();
        if let Some(signer) = &self.auth_signer {
            let signed = signer(SyncRequestToSign {
                method: method.to_string(),
                url: url.to_string(),
                body: body.to_vec(),
            })
            .map_err(|err| {
                SyncularError::message(ErrorKind::Transport, format!("sign sync request: {err}"))
            })?;
            headers.extend(signed);
        }
        Ok(headers)
    }

    fn apply_headers(
        &self,
        builder: reqwest::blocking::RequestBuilder,
        headers: &SyncAuthHeaders,
    ) -> reqwest::blocking::RequestBuilder {
        apply_auth_headers(builder, headers)
    }

    fn set_sync_trace_context(&self, trace_context: SyncTraceContext) {
        if let Ok(mut current) = self.sync_trace_context.lock() {
            *current = Some(trace_context);
        }
    }

    fn sync_trace_context(&self, headers: &SyncAuthHeaders) -> SyncTraceContext {
        self.sync_trace_context
            .lock()
            .ok()
            .and_then(|current| current.clone())
            .unwrap_or_else(|| SyncTraceContext::from_headers_or_new(headers))
    }

    fn upload_blob_body(&self, blob: &BlobRef, body: BlockingBody) -> Result<()> {
        let url = format!(
            "{}/blobs/upload",
            self.config.base_url.trim_end_matches('/')
        );
        let request = BlobUploadInitRequest {
            hash: blob.hash.clone(),
            size: blob.size,
            mime_type: blob.mime_type.clone(),
        };
        let request_body = serde_json::to_vec(&request)?;
        let response = self
            .apply_auth(
                self.http
                    .post(&url)
                    .header("content-type", "application/json"),
                "POST",
                &url,
                &request_body,
            )?
            .body(request_body)
            .send()
            .map_err(|err| SyncularError::transport(err).context(format!("POST {url}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("blob upload init failed with HTTP {status}: {body}"),
            ));
        }
        let init: BlobUploadInitResponse = response.json()?;
        if init.exists {
            return Ok(());
        }
        let upload_url = init.upload_url.ok_or_else(|| {
            SyncularError::protocol_message("blob upload init response missing uploadUrl")
        })?;
        let method = init.upload_method.as_deref().unwrap_or("PUT");
        let method = Method::from_bytes(method.as_bytes())
            .map_err(|err| SyncularError::protocol(err).context("blob upload method"))?;
        let mut upload = self.http.request(method, &upload_url).body(body);
        for (name, value) in init.upload_headers {
            upload = upload.header(name, value);
        }
        let response = upload.send().map_err(|err| {
            SyncularError::transport(err).context(format!("upload blob to {upload_url}"))
        })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("blob upload failed with HTTP {status}: {body}"),
            ));
        }

        let complete_url = format!(
            "{}/blobs/{}/complete",
            self.config.base_url.trim_end_matches('/'),
            blob_hash_path(&blob.hash)?
        );
        let response = self
            .apply_auth(self.http.post(&complete_url), "POST", &complete_url, &[])?
            .send()
            .map_err(|err| SyncularError::transport(err).context(format!("POST {complete_url}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("blob upload complete failed with HTTP {status}: {body}"),
            ));
        }
        let complete: BlobUploadCompleteResponse = response.json()?;
        if !complete.ok {
            return Err(SyncularError::protocol_message(
                complete
                    .error
                    .unwrap_or_else(|| "failed to complete blob upload".to_string()),
            ));
        }
        Ok(())
    }

    fn open_blob_download(&self, blob: &BlobRef) -> Result<reqwest::blocking::Response> {
        let url = format!(
            "{}/blobs/{}/url",
            self.config.base_url.trim_end_matches('/'),
            blob_hash_path(&blob.hash)?
        );
        let response = self
            .apply_auth(self.http.get(&url), "GET", &url, &[])?
            .send()
            .map_err(|err| SyncularError::transport(err).context(format!("GET {url}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("blob download url failed with HTTP {status}: {body}"),
            ));
        }
        let download: BlobDownloadUrlResponse = response.json()?;
        let response = self.http.get(&download.url).send().map_err(|err| {
            SyncularError::transport(err).context(format!("GET {}", download.url))
        })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("blob download failed with HTTP {status}: {body}"),
            ));
        }
        Ok(response)
    }
}

#[cfg(feature = "native")]
fn temp_download_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("blob");
    let temp_name = format!(".{file_name}.syncular-download-{}", Uuid::new_v4());
    path.with_file_name(temp_name)
}

#[cfg(feature = "native")]
impl RealtimeSocket {
    pub fn connect(
        config: &SyncTransportConfig,
        auth_headers: &SyncAuthHeaders,
        auth_signer: Option<SyncAuthSigner>,
        schema_version: i32,
    ) -> Result<Self> {
        let url = ws_url(&config.base_url, &config.client_id, schema_version)?;
        let mut auth_headers = signed_realtime_auth_headers(auth_headers, auth_signer, &url)?;
        let trace_context = SyncTraceContext::from_headers_or_new(&auth_headers);
        trace_context.insert_missing_headers(&mut auth_headers);
        let mut request = url
            .into_client_request()
            .map_err(|err| SyncularError::transport(err).context("build websocket request"))?;
        for (name, value) in effective_auth_headers(&auth_headers) {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(SyncularError::transport)?;
            let value = reqwest::header::HeaderValue::from_str(&value)?;
            request.headers_mut().insert(name, value);
        }
        request.headers_mut().insert(
            "x-syncular-schema-version",
            schema_version.to_string().parse()?,
        );

        let stream = connect_websocket_tcp(request.uri(), config.timeouts.websocket_open)?;
        stream.set_nodelay(true).ok();
        stream
            .set_read_timeout(Some(config.timeouts.websocket_open))
            .ok();
        stream
            .set_write_timeout(Some(config.timeouts.websocket_open))
            .ok();

        let (mut socket, _response) = client_tls_with_config(request, stream, None, None)
            .map_err(|err| SyncularError::transport(err).context("connect websocket handshake"))?;
        set_websocket_stream_timeouts(
            socket.get_mut(),
            Some(config.timeouts.websocket_idle),
            Some(config.timeouts.websocket_shutdown),
        );
        Ok(Self {
            socket,
            push_response_timeout: config.timeouts.websocket_push_response,
            shutdown_timeout: config.timeouts.websocket_shutdown,
        })
    }
}

#[cfg(feature = "native")]
impl SyncTraceContext {
    fn new() -> Self {
        let trace_id = Uuid::new_v4().simple().to_string();
        let span_seed = Uuid::new_v4().simple().to_string();
        let span_id = span_seed[..16].to_string();
        Self {
            sync_attempt_id: trace_id.clone(),
            trace_id,
            span_id,
        }
    }

    fn from_headers_or_new(headers: &SyncAuthHeaders) -> Self {
        if let Some(traceparent) =
            header_value(headers, "traceparent").and_then(parse_w3c_traceparent)
        {
            return Self {
                sync_attempt_id: header_value(headers, "x-syncular-sync-attempt-id")
                    .map(str::to_string)
                    .unwrap_or_else(|| traceparent.0.clone()),
                trace_id: traceparent.0,
                span_id: traceparent.1,
            };
        }

        Self::new()
    }

    fn traceparent(&self) -> String {
        format!("00-{}-{}-01", self.trace_id, self.span_id)
    }

    fn sentry_trace(&self) -> String {
        format!("{}-{}-1", self.trace_id, self.span_id)
    }

    fn insert_missing_headers(&self, headers: &mut SyncAuthHeaders) {
        insert_header_if_missing(headers, "traceparent", self.traceparent());
        insert_header_if_missing(headers, "sentry-trace", self.sentry_trace());
        insert_header_if_missing(
            headers,
            "x-syncular-sync-attempt-id",
            self.sync_attempt_id.clone(),
        );
    }
}

#[cfg(feature = "native")]
impl RealtimeTransport for RealtimeSocket {
    fn push_commit(&mut self, commit: PushCommitRequest) -> Result<PushCommitResponse> {
        let request_id = Uuid::new_v4().to_string();
        let client_commit_id = commit.client_commit_id.clone();
        let message = RealtimePushRequest::from_commit(request_id.clone(), commit);

        let message = serde_json::to_string(&message)?;
        validate_websocket_text_frame_size(&message)?;
        self.socket.send(Message::Text(message.into()))?;

        let deadline = SystemTime::now()
            .checked_add(self.push_response_timeout)
            .unwrap_or_else(SystemTime::now);

        while SystemTime::now() < deadline {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    validate_websocket_text_frame_size(&text)?;
                    let value: Value = match serde_json::from_str(&text) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    if let Some(response) = syncular_protocol::realtime_push_response_from_value(
                        &value,
                        &request_id,
                        &client_commit_id,
                    )? {
                        return Ok(response);
                    }
                }
                Ok(Message::Ping(bytes)) => {
                    self.socket.send(Message::Pong(bytes))?;
                }
                Ok(Message::Close(_)) => {
                    return Err(SyncularError::message(
                        ErrorKind::Transport,
                        "websocket closed during push",
                    ));
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(err))
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut => {}
                Err(err) => {
                    return Err(
                        SyncularError::transport(err).context("read websocket push response")
                    );
                }
            }
        }

        Err(SyncularError::message(
            ErrorKind::Transport,
            "timed out waiting for websocket push-response",
        ))
    }

    fn send_presence(
        &mut self,
        action: &str,
        scope_key: &str,
        metadata: Option<&Value>,
    ) -> Result<()> {
        let message = RealtimePresenceRequest::new(action, scope_key, metadata.cloned());
        let message = serde_json::to_string(&message)?;
        validate_websocket_text_frame_size(&message)?;
        self.socket.send(Message::Text(message.into()))?;
        Ok(())
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        match self.socket.read() {
            Ok(Message::Text(text)) => {
                validate_websocket_text_frame_size(&text)?;
                let value: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => return Ok(None),
                };
                let event = value.get("event").and_then(Value::as_str).unwrap_or("");
                if event == REALTIME_SERVER_EVENT_SYNC {
                    Ok(Some(RealtimeEvent::Sync))
                } else if event == REALTIME_SERVER_EVENT_PRESENCE {
                    Ok(
                        syncular_protocol::realtime_presence_event_from_value(&value)
                            .map(RealtimeEvent::Presence),
                    )
                } else {
                    Ok(Some(RealtimeEvent::Other(event.to_string())))
                }
            }
            Ok(Message::Ping(bytes)) => {
                self.socket.send(Message::Pong(bytes))?;
                Ok(None)
            }
            Ok(Message::Close(_)) => Err(SyncularError::message(
                ErrorKind::Transport,
                "websocket closed",
            )),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(err))
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                Ok(None)
            }
            Err(err) => Err(SyncularError::transport(err).context("read websocket message")),
        }
    }

    fn close(&mut self) {
        set_websocket_stream_timeouts(
            self.socket.get_mut(),
            Some(self.shutdown_timeout),
            Some(self.shutdown_timeout),
        );
        self.socket.close(None).ok();
    }
}

#[cfg(feature = "native")]
fn apply_auth_headers(
    mut request: reqwest::blocking::RequestBuilder,
    auth_headers: &SyncAuthHeaders,
) -> reqwest::blocking::RequestBuilder {
    for (name, value) in effective_auth_headers(auth_headers) {
        request = request.header(name.as_str(), value.as_str());
    }
    request
}

#[cfg(feature = "native")]
fn effective_auth_headers(auth_headers: &SyncAuthHeaders) -> Vec<(String, String)> {
    auth_headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

#[cfg(feature = "native")]
fn header_value<'a>(headers: &'a SyncAuthHeaders, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

#[cfg(feature = "native")]
fn insert_header_if_missing(headers: &mut SyncAuthHeaders, name: &str, value: String) {
    if header_value(headers, name).is_none() {
        headers.insert(name.to_string(), value);
    }
}

#[cfg(feature = "native")]
fn parse_w3c_traceparent(traceparent: &str) -> Option<(String, String)> {
    let mut parts = traceparent.trim().split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some()
        || version != "00"
        || !is_valid_trace_hex(trace_id, 32)
        || !is_valid_trace_hex(span_id, 16)
        || !is_valid_trace_hex(flags, 2)
        || trace_id.chars().all(|ch| ch == '0')
        || span_id.chars().all(|ch| ch == '0')
    {
        return None;
    }
    Some((trace_id.to_ascii_lowercase(), span_id.to_ascii_lowercase()))
}

#[cfg(feature = "native")]
fn is_valid_trace_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.as_bytes().iter().all(u8::is_ascii_hexdigit)
}

#[cfg(feature = "native")]
fn signed_realtime_auth_headers(
    auth_headers: &SyncAuthHeaders,
    auth_signer: Option<SyncAuthSigner>,
    url: &str,
) -> Result<SyncAuthHeaders> {
    let mut headers = auth_headers.clone();
    if let Some(signer) = auth_signer {
        let signed = signer(SyncRequestToSign {
            method: "GET".to_string(),
            url: url.to_string(),
            body: Vec::new(),
        })
        .map_err(|err| {
            SyncularError::message(
                ErrorKind::Transport,
                format!("sign websocket request: {err}"),
            )
        })?;
        headers.extend(signed);
    }
    Ok(headers)
}

#[cfg(feature = "native")]
fn ws_url(base_url: &str, client_id: &str, schema_version: i32) -> Result<String> {
    let mut url = reqwest::Url::parse(base_url).map_err(|err| {
        SyncularError::config(format!("invalid base url for websocket: {base_url}")).context(err)
    })?;
    match url.scheme() {
        "http" => url
            .set_scheme("ws")
            .map_err(|_| SyncularError::config("failed to set ws scheme"))?,
        "https" => url
            .set_scheme("wss")
            .map_err(|_| SyncularError::config("failed to set wss scheme"))?,
        "ws" | "wss" => {}
        scheme => {
            return Err(SyncularError::config(format!(
                "unsupported websocket base url scheme: {scheme}"
            )));
        }
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{path}/realtime"));
    url.query_pairs_mut()
        .append_pair("clientId", client_id)
        .append_pair("schemaVersion", &schema_version.to_string())
        .append_pair("transportPath", "direct");
    Ok(url.to_string())
}

#[cfg(feature = "native")]
fn connect_websocket_tcp(uri: &tungstenite::http::Uri, timeout: Duration) -> Result<TcpStream> {
    let host = uri.host().ok_or_else(|| {
        SyncularError::message(ErrorKind::Transport, "websocket url is missing a host")
    })?;
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
        Some("ws") => 80,
        Some("wss") => 443,
        Some(scheme) => {
            return Err(SyncularError::message(
                ErrorKind::Transport,
                format!("unsupported websocket url scheme: {scheme}"),
            ));
        }
        None => {
            return Err(SyncularError::message(
                ErrorKind::Transport,
                "websocket url is missing a scheme",
            ));
        }
    });

    let mut last_error = None;
    for address in (host, port)
        .to_socket_addrs()
        .map_err(|err| SyncularError::transport(err).context("resolve websocket host"))?
    {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => return Ok(stream),
            Err(err) => last_error = Some(err),
        }
    }

    let message = last_error
        .map(|err| format!("connect websocket tcp: {err}"))
        .unwrap_or_else(|| "connect websocket tcp: host resolved to no addresses".to_string());
    Err(SyncularError::message(ErrorKind::Transport, message))
}

#[cfg(feature = "native")]
fn set_websocket_stream_timeouts(
    stream: &mut MaybeTlsStream<TcpStream>,
    read_timeout: Option<Duration>,
    write_timeout: Option<Duration>,
) {
    match stream {
        MaybeTlsStream::Plain(stream) => {
            stream.set_read_timeout(read_timeout).ok();
            stream.set_write_timeout(write_timeout).ok();
        }
        MaybeTlsStream::Rustls(stream) => {
            stream.sock.set_read_timeout(read_timeout).ok();
            stream.sock.set_write_timeout(write_timeout).ok();
        }
        _ => {}
    }
}

#[cfg(feature = "native")]
fn blob_hash_path(hash: &str) -> Result<String> {
    validate_blob_hash(hash)?;
    let hex = hash
        .strip_prefix("sha256:")
        .expect("validated hash should have sha256 prefix");
    Ok(format!("sha256%3A{hex}"))
}

#[cfg(feature = "native")]
fn decode_compressed_snapshot_chunk_rows(
    chunk: &SnapshotChunkRef,
    compressed: &[u8],
) -> Result<SnapshotChunkRows> {
    syncular_protocol::validate_snapshot_chunk_format(chunk)?;
    validate_snapshot_chunk_compressed_bytes(chunk, compressed)?;
    let actual_hash = hex::encode(Sha256::digest(compressed));
    syncular_protocol::validate_snapshot_chunk_hash_hex(chunk, &actual_hash)?;

    let mut decoder = GzDecoder::new(compressed);
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded)?;
    validate_snapshot_chunk_decompressed_bytes(&decoded)?;

    decode_snapshot_chunk_rows(chunk, &decoded)
}

#[cfg(feature = "native")]
fn validate_snapshot_artifact_bytes(
    artifact: &ScopedSnapshotArtifactRef,
    bytes: &[u8],
) -> Result<()> {
    syncular_protocol::validate_scoped_snapshot_artifact_ref(artifact)?;
    validate_snapshot_artifact_compressed_bytes(artifact, bytes)?;
    let actual_hash = hex::encode(Sha256::digest(bytes));
    if actual_hash != artifact.sha256 {
        return Err(SyncularError::protocol_message(format!(
            "snapshot artifact sha256 mismatch: expected {}, got {}",
            artifact.sha256, actual_hash
        )));
    }
    Ok(())
}

#[cfg(feature = "native")]
fn decode_snapshot_artifact_bytes(
    artifact: &ScopedSnapshotArtifactRef,
    compressed: &[u8],
) -> Result<Vec<u8>> {
    validate_snapshot_artifact_bytes(artifact, compressed)?;
    if artifact.compression != SNAPSHOT_CHUNK_COMPRESSION_GZIP {
        return Err(SyncularError::protocol_message(format!(
            "unsupported snapshot artifact compression {}",
            artifact.compression
        )));
    }
    let mut decoder = GzDecoder::new(compressed);
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded)?;
    validate_snapshot_artifact_decompressed_bytes(&decoded)?;
    Ok(decoded)
}

#[cfg(feature = "native")]
fn decode_snapshot_chunk_rows(chunk: &SnapshotChunkRef, bytes: &[u8]) -> Result<SnapshotChunkRows> {
    syncular_protocol::validate_snapshot_chunk_format(chunk)?;

    match chunk.encoding.as_str() {
        SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 => {
            decode_binary_snapshot_rows(bytes).map(SnapshotChunkRows::Binary)
        }
        encoding => Err(SyncularError::protocol_message(format!(
            "unsupported snapshot chunk encoding: {encoding}"
        ))),
    }
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Instant;

    #[test]
    fn effective_auth_headers_are_empty_without_app_headers() {
        let headers = effective_auth_headers(&SyncAuthHeaders::new());

        assert_eq!(headers, Vec::<(String, String)>::new());
    }

    #[test]
    fn transport_config_has_production_timeout_defaults() {
        let config = SyncTransportConfig::new("https://api.example.test/sync", "client", "actor");

        assert_eq!(config.timeouts.http_connect, Duration::from_secs(10));
        assert_eq!(config.timeouts.http_request, Duration::from_secs(30));
        assert_eq!(config.timeouts.http_response_body, Duration::from_secs(30));
        assert_eq!(config.timeouts.websocket_open, Duration::from_secs(10));
        assert_eq!(config.timeouts.websocket_idle, Duration::from_secs(1));
        assert_eq!(
            config.timeouts.websocket_push_response,
            Duration::from_secs(10)
        );
        assert_eq!(config.timeouts.websocket_shutdown, Duration::from_secs(2));
    }

    #[test]
    fn effective_auth_headers_use_supplied_headers_without_dev_actor_headers() {
        let mut auth_headers = SyncAuthHeaders::new();
        auth_headers.insert("authorization".to_string(), "Bearer token-1".to_string());

        let headers = effective_auth_headers(&auth_headers);

        assert_eq!(
            headers,
            vec![("authorization".to_string(), "Bearer token-1".to_string())]
        );
    }

    #[test]
    fn sync_trace_context_derives_attempt_from_existing_traceparent() {
        let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
        let span_id = "00f067aa0ba902b7";
        let headers = SyncAuthHeaders::from([(
            "TraceParent".to_string(),
            format!("00-{trace_id}-{span_id}-01"),
        )]);

        let context = SyncTraceContext::from_headers_or_new(&headers);

        assert_eq!(context.sync_attempt_id, trace_id);
        assert_eq!(context.trace_id, trace_id);
        assert_eq!(context.span_id, span_id);
    }

    #[test]
    fn http_sync_reuses_trace_context_for_snapshot_chunks() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind sync trace server");
        let address = listener.local_addr().expect("sync trace server address");
        let (headers_tx, headers_rx) = mpsc::channel::<(BTreeMap<String, String>, String)>();

        let compressed_chunk = gzip_bytes(b"not-binary-table");
        let chunk = SnapshotChunkRef {
            id: "trace-chunk".to_string(),
            byte_length: compressed_chunk.len() as i64,
            sha256: hex::encode(Sha256::digest(&compressed_chunk)),
            encoding: SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1.to_string(),
            compression: SNAPSHOT_CHUNK_COMPRESSION_GZIP.to_string(),
        };
        let server_chunk = compressed_chunk.clone();

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept sync request");
            let post = read_http_request_raw(&mut stream);
            let post_headers = http_headers(&post);
            let attempt_id = post_headers
                .get("x-syncular-sync-attempt-id")
                .expect("post sync attempt id")
                .to_string();
            headers_tx
                .send((post_headers, "post".to_string()))
                .expect("send post headers");
            write_http_json_response(
                &mut stream,
                json!({
                    "ok": true,
                    "push": null,
                    "pull": null
                }),
            );

            let (mut stream, _) = listener.accept().expect("accept snapshot chunk request");
            let get = read_http_request_raw(&mut stream);
            let get_headers = http_headers(&get);
            assert_eq!(
                get_headers.get("x-syncular-sync-attempt-id"),
                Some(&attempt_id)
            );
            headers_tx
                .send((get_headers, "get".to_string()))
                .expect("send get headers");
            write_http_bytes_response(&mut stream, "application/octet-stream", &server_chunk);
        });

        let transport = HttpSyncTransport::new(SyncTransportConfig::new(
            format!("http://{address}/sync"),
            "native-trace-client",
            "native-trace-actor",
        ));
        let request = CombinedRequest {
            client_id: "native-trace-client".to_string(),
            sync_pack_encodings: Vec::new(),
            push: None,
            pull: None,
        };
        transport.post_sync(&request).expect("post sync");
        let _ = transport.fetch_snapshot_chunk_rows(&chunk, &ScopeValues::new());

        let (post_headers, post_kind) = headers_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("post headers");
        let (get_headers, get_kind) = headers_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("get headers");
        assert_eq!(post_kind, "post");
        assert_eq!(get_kind, "get");
        let attempt_id = post_headers
            .get("x-syncular-sync-attempt-id")
            .expect("post attempt id");
        assert_eq!(
            get_headers.get("x-syncular-sync-attempt-id"),
            Some(attempt_id)
        );
        assert!(post_headers
            .get("traceparent")
            .is_some_and(|value| value.contains(attempt_id)));
        assert_eq!(post_headers.get("sentry-trace").is_some(), true);
        assert_eq!(
            get_headers.get("traceparent"),
            post_headers.get("traceparent")
        );
        server.join().expect("sync trace server finished");
    }

    #[test]
    fn realtime_auth_headers_are_signed_for_websocket_get_request() {
        let captured = Arc::new(Mutex::new(None::<SyncRequestToSign>));
        let captured_for_signer = Arc::clone(&captured);
        let signer: SyncAuthSigner = Arc::new(move |request| {
            *captured_for_signer.lock().expect("capture signer request") = Some(request);
            Ok(SyncAuthHeaders::from([(
                "x-signed-realtime".to_string(),
                "yes".to_string(),
            )]))
        });

        let headers = signed_realtime_auth_headers(
            &SyncAuthHeaders::new(),
            Some(signer),
            "wss://api.notsuru.app/sync/realtime?clientId=flutter-shell",
        )
        .expect("signed realtime headers");

        assert_eq!(headers["x-signed-realtime"], "yes");
        let request = captured
            .lock()
            .expect("captured request lock")
            .clone()
            .expect("request was signed");
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.url,
            "wss://api.notsuru.app/sync/realtime?clientId=flutter-shell"
        );
        assert!(request.body.is_empty());
    }

    #[test]
    fn realtime_socket_handshake_uses_auth_signer_and_reads_sync_wakeup() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind websocket test server");
        let address = listener.local_addr().expect("websocket server address");
        let (headers_tx, headers_rx) = mpsc::channel::<(String, String)>();

        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept websocket client");
            let mut socket = tungstenite::accept_hdr(
                stream,
                |request: &tungstenite::handshake::server::Request, response| {
                    let signed = request
                        .headers()
                        .get("x-signed-realtime")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let schema = request
                        .headers()
                        .get("x-syncular-schema-version")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    headers_tx
                        .send((signed, schema))
                        .expect("send captured websocket headers");
                    Ok(response)
                },
            )
            .expect("complete websocket handshake");
            socket
                .send(Message::Text(
                    json!({"event": "sync", "data": {"cursor": 42}})
                        .to_string()
                        .into(),
                ))
                .expect("send realtime sync event");
            socket.close(None).ok();
        });

        let signer: SyncAuthSigner = Arc::new(|request| {
            assert_eq!(request.method, "GET");
            assert!(request.url.starts_with("ws://127.0.0.1:"));
            assert!(request.url.contains("/api/sync/realtime?"));
            assert!(request.body.is_empty());
            Ok(SyncAuthHeaders::from([(
                "x-signed-realtime".to_string(),
                "yes".to_string(),
            )]))
        });
        let config = SyncTransportConfig::new(
            format!("ws://{address}/api/sync"),
            "flutter-shell",
            "passkey:user-test",
        );

        let mut socket = RealtimeSocket::connect(&config, &SyncAuthHeaders::new(), Some(signer), 7)
            .expect("connect realtime websocket");

        assert!(matches!(socket.read_event(), Ok(Some(RealtimeEvent::Sync))));
        let (signed, schema) = headers_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("captured websocket headers");
        assert_eq!(signed, "yes");
        assert_eq!(schema, "7");
        server.join().expect("websocket test server finished");
    }

    #[test]
    fn realtime_socket_connect_uses_websocket_open_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind websocket test server");
        let address = listener.local_addr().expect("websocket server address");

        let server = thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                thread::sleep(Duration::from_millis(350));
                drop(stream);
            }
        });

        let mut config = SyncTransportConfig::new(
            format!("ws://{address}/api/sync"),
            "flutter-shell",
            "passkey:user-test",
        );
        config.timeouts.websocket_open = Duration::from_millis(75);

        let started = Instant::now();
        let result = RealtimeSocket::connect(&config, &SyncAuthHeaders::new(), None, 7);

        let elapsed = started.elapsed();
        let error = match result {
            Ok(_) => panic!("websocket connect should time out"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), ErrorKind::Transport);
        assert!(
            elapsed < Duration::from_millis(250),
            "websocket open ignored configured timeout: {elapsed:?}"
        );
        server.join().expect("websocket test server finished");
    }

    fn gzip_bytes(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).expect("write gzip payload");
        encoder.finish().expect("finish gzip payload")
    }

    fn read_http_request_raw(stream: &mut std::net::TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set request read timeout");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).expect("read http request");
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if http_request_complete(&buffer) {
                break;
            }
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    fn http_request_complete(buffer: &[u8]) -> bool {
        let request = String::from_utf8_lossy(buffer);
        let Some(header_end) = request.find("\r\n\r\n") else {
            return false;
        };
        let content_length = request
            .lines()
            .find_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        buffer.len() >= header_end + 4 + content_length
    }

    fn http_headers(request: &str) -> BTreeMap<String, String> {
        request
            .lines()
            .skip(1)
            .take_while(|line| !line.trim().is_empty())
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect()
    }

    fn write_http_json_response(stream: &mut std::net::TcpStream, body: Value) {
        write_http_bytes_response(stream, "application/json", body.to_string().as_bytes());
    }

    fn write_http_bytes_response(
        stream: &mut std::net::TcpStream,
        content_type: &str,
        body: &[u8],
    ) {
        let headers = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(headers.as_bytes())
            .expect("write http response headers");
        stream.write_all(body).expect("write http response body");
    }
}
