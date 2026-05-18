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
use serde::{Deserialize, Serialize};
#[cfg(feature = "native")]
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
use std::sync::Arc;
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
}

#[cfg(feature = "native")]
pub struct RealtimeSocket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    push_response_timeout: Duration,
    shutdown_timeout: Duration,
}

#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    Sync,
    Presence(RealtimePresenceEvent),
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePresenceEntry {
    pub client_id: String,
    pub actor_id: String,
    pub joined_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePresenceEvent {
    pub action: String,
    pub scope_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<RealtimePresenceEntry>,
}

pub trait SyncTransport {
    type Realtime: RealtimeTransport;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse>;
    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &ScopeValues,
    ) -> Result<SnapshotChunkRows>;
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
        }
    }

    pub fn with_schema_version(mut self, schema_version: i32) -> Self {
        self.schema_version = schema_version;
        self
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
        let builder = self
            .http
            .post(&self.config.base_url)
            .header("content-type", "application/json")
            .header("x-syncular-schema-version", self.schema_version.to_string())
            .header("x-syncular-transport-path", "direct");
        let response = self
            .apply_auth(builder, "POST", &self.config.base_url, &body)?
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
        let url = format!(
            "{}/snapshot-chunks/{}",
            self.config.base_url.trim_end_matches('/'),
            chunk.id
        );
        let request = self
            .http
            .get(&url)
            .header("x-syncular-snapshot-scopes", serde_json::to_string(scopes)?);
        let response = self
            .apply_auth(request, "GET", &url, &[])?
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
        validate_snapshot_chunk_format(chunk)?;
        let compressed = response.bytes()?.to_vec();
        decode_compressed_snapshot_chunk_rows(chunk, &compressed)
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
        let response = self.open_blob_download(blob)?;
        let bytes = response.bytes()?.to_vec();
        validate_blob_bytes(blob, &bytes)?;
        Ok(bytes)
    }

    fn download_blob_to_file(&self, blob: &BlobRef, path: &Path) -> Result<()> {
        validate_blob_hash(&blob.hash)?;
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
        Ok(apply_auth_headers(builder, &headers))
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
        let auth_headers = signed_realtime_auth_headers(auth_headers, auth_signer, &url)?;
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
impl RealtimeTransport for RealtimeSocket {
    fn push_commit(&mut self, commit: PushCommitRequest) -> Result<PushCommitResponse> {
        let request_id = Uuid::new_v4().to_string();
        let message = json!({
            "type": "push",
            "requestId": request_id,
            "clientCommitId": commit.client_commit_id,
            "operations": commit.operations,
            "schemaVersion": commit.schema_version,
        });

        self.socket
            .send(Message::Text(message.to_string().into()))?;

        let deadline = SystemTime::now()
            .checked_add(self.push_response_timeout)
            .unwrap_or_else(SystemTime::now);

        while SystemTime::now() < deadline {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    let value: Value = match serde_json::from_str(&text) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    let event = value.get("event").and_then(Value::as_str).unwrap_or("");
                    if event != "push-response" {
                        continue;
                    }
                    let data = value
                        .get("data")
                        .and_then(Value::as_object)
                        .ok_or_else(|| {
                            SyncularError::protocol_message("push-response missing data")
                        })?;
                    let response_request_id =
                        data.get("requestId").and_then(Value::as_str).unwrap_or("");
                    if response_request_id != request_id {
                        continue;
                    }

                    let results = data
                        .get("results")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()?
                        .unwrap_or_default();

                    return Ok(PushCommitResponse {
                        client_commit_id: commit.client_commit_id,
                        status: data
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("rejected")
                            .to_string(),
                        commit_seq: data.get("commitSeq").and_then(Value::as_i64),
                        results,
                    });
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
        let message = json!({
            "type": "presence",
            "action": action,
            "scopeKey": scope_key,
            "metadata": metadata,
        });
        self.socket
            .send(Message::Text(message.to_string().into()))?;
        Ok(())
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        match self.socket.read() {
            Ok(Message::Text(text)) => {
                let value: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => return Ok(None),
                };
                let event = value.get("event").and_then(Value::as_str).unwrap_or("");
                if event == "sync" {
                    Ok(Some(RealtimeEvent::Sync))
                } else if event == "presence" {
                    Ok(read_realtime_presence_event(&value).map(RealtimeEvent::Presence))
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
fn read_realtime_presence_event(value: &Value) -> Option<RealtimePresenceEvent> {
    let presence = value
        .get("data")
        .and_then(|data| data.get("presence"))
        .or_else(|| value.get("presence"))
        .or_else(|| value.get("data"))?;
    serde_json::from_value(presence.clone()).ok()
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
    validate_snapshot_chunk_format(chunk)?;
    let actual_hash = hex::encode(Sha256::digest(compressed));
    if actual_hash != chunk.sha256 {
        return Err(SyncularError::message(
            ErrorKind::Protocol,
            format!(
                "snapshot chunk hash mismatch: expected {}, got {}",
                chunk.sha256, actual_hash
            ),
        ));
    }

    let mut decoder = GzDecoder::new(compressed);
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded)?;

    decode_snapshot_chunk_rows(chunk, &decoded)
}

#[cfg(feature = "native")]
fn validate_snapshot_chunk_format(chunk: &SnapshotChunkRef) -> Result<()> {
    if chunk.compression != "gzip" {
        return Err(SyncularError::protocol_message(format!(
            "unsupported snapshot chunk compression: {}",
            chunk.compression
        )));
    }
    match chunk.encoding.as_str() {
        SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1 | SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 => {
            Ok(())
        }
        encoding => Err(SyncularError::protocol_message(format!(
            "unsupported snapshot chunk encoding: {encoding}"
        ))),
    }
}

#[cfg(feature = "native")]
fn decode_snapshot_chunk_rows(chunk: &SnapshotChunkRef, bytes: &[u8]) -> Result<SnapshotChunkRows> {
    validate_snapshot_chunk_format(chunk)?;

    match chunk.encoding.as_str() {
        SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1 => {
            decode_snapshot_rows(bytes).map(SnapshotChunkRows::Json)
        }
        SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 => {
            decode_binary_snapshot_rows(bytes).map(SnapshotChunkRows::Binary)
        }
        encoding => Err(SyncularError::protocol_message(format!(
            "unsupported snapshot chunk encoding: {encoding}"
        ))),
    }
}

#[cfg(feature = "native")]
fn decode_snapshot_rows(bytes: &[u8]) -> Result<Vec<Value>> {
    if bytes.len() < 4 || &bytes[0..4] != b"SRF1" {
        return Err(SyncularError::protocol_message(
            "unexpected snapshot chunk frame header",
        ));
    }

    let mut offset = 4usize;
    let mut rows = Vec::with_capacity(estimated_snapshot_row_count(bytes.len()));
    while offset < bytes.len() {
        if offset + 4 > bytes.len() {
            return Err(SyncularError::protocol_message(
                "snapshot frame ended mid-header",
            ));
        }
        let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if offset + len > bytes.len() {
            return Err(SyncularError::protocol_message(
                "snapshot frame ended mid-body",
            ));
        }
        let row: Value = serde_json::from_slice(&bytes[offset..offset + len])?;
        rows.push(row);
        offset += len;
    }

    Ok(rows)
}

#[cfg(feature = "native")]
fn estimated_snapshot_row_count(byte_len: usize) -> usize {
    (byte_len / 160).clamp(1, 20_000)
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
}
