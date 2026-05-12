#[cfg(feature = "native")]
use crate::app_schema::default_app_schema;
use crate::error::Result;
#[cfg(feature = "native")]
use crate::error::{ErrorKind, SyncularError};
use crate::protocol::*;
#[cfg(feature = "native")]
use flate2::read::GzDecoder;
#[cfg(feature = "native")]
use reqwest::blocking::Body as BlockingBody;
#[cfg(feature = "native")]
use reqwest::blocking::Client as HttpClient;
#[cfg(feature = "native")]
use reqwest::Method;
#[cfg(not(feature = "native"))]
use serde_json::Value;
#[cfg(feature = "native")]
use serde_json::{json, Value};
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
use std::net::TcpStream;
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
use tungstenite::{connect as ws_connect, Message, WebSocket};
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
}

#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    Sync,
    Other(String),
}

pub trait SyncTransport {
    type Realtime: RealtimeTransport;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse>;
    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &ScopeValues,
    ) -> Result<Vec<Value>>;
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
    fn read_event(&mut self) -> Result<Option<RealtimeEvent>>;
    fn close(&mut self);
}

#[cfg(feature = "native")]
impl HttpSyncTransport {
    pub fn new(config: SyncTransportConfig) -> Self {
        Self {
            http: HttpClient::new(),
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

        Ok(response.json()?)
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &ScopeValues,
    ) -> Result<Vec<Value>> {
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
        let compressed = response.bytes()?.to_vec();
        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded)?;

        let actual_hash = hex::encode(Sha256::digest(&decoded));
        if actual_hash != chunk.sha256 {
            return Err(SyncularError::message(
                ErrorKind::Protocol,
                format!(
                    "snapshot chunk hash mismatch: expected {}, got {}",
                    chunk.sha256, actual_hash
                ),
            ));
        }

        decode_snapshot_rows(&decoded)
    }

    fn connect_realtime(&self) -> Result<RealtimeSocket> {
        RealtimeSocket::connect(&self.config, &self.auth_headers, self.schema_version)
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
        schema_version: i32,
    ) -> Result<Self> {
        let url = ws_url(&config.base_url, &config.client_id, schema_version)?;
        let mut request = url
            .into_client_request()
            .map_err(|err| SyncularError::transport(err).context("build websocket request"))?;
        for (name, value) in effective_auth_headers(auth_headers) {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(SyncularError::transport)?;
            let value = reqwest::header::HeaderValue::from_str(&value)?;
            request.headers_mut().insert(name, value);
        }
        request.headers_mut().insert(
            "x-syncular-schema-version",
            schema_version.to_string().parse()?,
        );

        let (mut socket, _response) = ws_connect(request)
            .map_err(|err| SyncularError::transport(err).context("connect websocket"))?;
        if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
            stream.set_read_timeout(Some(Duration::from_secs(1))).ok();
        }
        Ok(Self { socket })
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
            .checked_add(Duration::from_secs(10))
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
fn blob_hash_path(hash: &str) -> Result<String> {
    validate_blob_hash(hash)?;
    let hex = hash
        .strip_prefix("sha256:")
        .expect("validated hash should have sha256 prefix");
    Ok(format!("sha256%3A{hex}"))
}

#[cfg(feature = "native")]
fn decode_snapshot_rows(bytes: &[u8]) -> Result<Vec<Value>> {
    if bytes.len() < 4 || &bytes[0..4] != b"SRF1" {
        return Err(SyncularError::protocol_message(
            "unexpected snapshot chunk frame header",
        ));
    }

    let mut offset = 4usize;
    let mut rows = Vec::new();
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

#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;

    #[test]
    fn effective_auth_headers_are_empty_without_app_headers() {
        let headers = effective_auth_headers(&SyncAuthHeaders::new());

        assert_eq!(headers, Vec::<(String, String)>::new());
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
}
