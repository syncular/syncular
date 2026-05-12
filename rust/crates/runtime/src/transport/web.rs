use crate::error::{ErrorKind, Result, SyncularError};
use crate::migrations::current_schema_version;
use crate::protocol::{
    BlobDownloadUrlResponse, BlobRef, BlobUploadCompleteResponse, BlobUploadInitRequest,
    BlobUploadInitResponse, CombinedRequest, CombinedResponse, PushCommitRequest, ScopeValues,
    SnapshotChunkRef,
};
use crate::transport::{SyncAuthHeaderStore, SyncAuthHeaders};
use flate2::read::GzDecoder;
use js_sys::{Function, Promise, Reflect, Uint8Array};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AbortSignal, BinaryType, Request, RequestInit, RequestMode, Response, Url, WebSocket,
};

#[derive(Debug, Clone)]
pub struct WebSyncTransportConfig {
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
}

#[derive(Clone)]
pub struct WebSyncTransport {
    config: WebSyncTransportConfig,
    auth_headers: SyncAuthHeaders,
    abort_signal: Option<JsValue>,
}

pub struct WebRealtimeSocket {
    socket: WebSocket,
}

pub trait AsyncSyncTransport {
    type Realtime;

    fn post_sync<'a>(
        &'a self,
        request: &'a CombinedRequest,
    ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>>;

    fn fetch_snapshot_chunk_rows<'a>(
        &'a self,
        chunk: &'a SnapshotChunkRef,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>>> + 'a>>;

    fn connect_realtime(&self) -> Result<Self::Realtime>;
}

pub trait AsyncBlobTransport {
    fn upload_blob<'a>(
        &'a self,
        blob: &'a BlobRef,
        bytes: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>;

    fn download_blob<'a>(
        &'a self,
        blob: &'a BlobRef,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>>> + 'a>>;
}

impl WebSyncTransport {
    pub fn new(config: WebSyncTransportConfig) -> Self {
        Self {
            config,
            auth_headers: SyncAuthHeaders::new(),
            abort_signal: None,
        }
    }

    pub fn config(&self) -> &WebSyncTransportConfig {
        &self.config
    }

    pub fn set_abort_signal(&mut self, signal: Option<JsValue>) {
        self.abort_signal = signal;
    }
}

impl SyncAuthHeaderStore for WebSyncTransport {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.auth_headers = headers;
    }
}

impl AsyncSyncTransport for WebSyncTransport {
    type Realtime = WebRealtimeSocket;

    fn post_sync<'a>(
        &'a self,
        request: &'a CombinedRequest,
    ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
        Box::pin(async move {
            let mut headers = vec![
                ("content-type".to_string(), "application/json".to_string()),
                (
                    "x-syncular-schema-version".to_string(),
                    current_schema_version().to_string(),
                ),
                (
                    "x-syncular-transport-path".to_string(),
                    "direct".to_string(),
                ),
            ];
            headers.extend(effective_auth_headers(&self.auth_headers));
            let response = fetch_json(
                "POST",
                &self.config.base_url,
                Some(serde_json::to_string(request)?),
                &headers,
                self.abort_signal.as_ref(),
            )
            .await?;
            serde_wasm_bindgen::from_value(response)
                .map_err(|err| SyncularError::protocol(err).context("decode browser sync response"))
        })
    }

    fn fetch_snapshot_chunk_rows<'a>(
        &'a self,
        chunk: &'a SnapshotChunkRef,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>>> + 'a>> {
        Box::pin(async move {
            let url = format!(
                "{}/snapshot-chunks/{}",
                self.config.base_url.trim_end_matches('/'),
                chunk.id
            );
            let mut headers = vec![(
                "x-syncular-snapshot-scopes".to_string(),
                serde_json::to_string(scopes)?,
            )];
            headers.extend(effective_auth_headers(&self.auth_headers));
            let compressed = fetch_bytes(&url, &headers, self.abort_signal.as_ref()).await?;
            decode_snapshot_rows(chunk, &compressed)
        })
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        WebRealtimeSocket::connect(&self.config)
    }
}

impl AsyncBlobTransport for WebSyncTransport {
    fn upload_blob<'a>(
        &'a self,
        blob: &'a BlobRef,
        bytes: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            let init = self
                .initiate_blob_upload(&BlobUploadInitRequest {
                    hash: blob.hash.clone(),
                    size: blob.size,
                    mime_type: blob.mime_type.clone(),
                })
                .await?;
            if init.exists {
                return Ok(());
            }
            let upload_url = init.upload_url.ok_or_else(|| {
                SyncularError::protocol_message("blob upload init response missing uploadUrl")
            })?;
            upload_blob_bytes(
                &upload_url,
                init.upload_method.as_deref().unwrap_or("PUT"),
                &init.upload_headers,
                bytes,
                self.abort_signal.as_ref(),
            )
            .await?;
            let complete = self.complete_blob_upload(&blob.hash).await?;
            if !complete.ok {
                return Err(SyncularError::protocol_message(
                    complete
                        .error
                        .unwrap_or_else(|| "failed to complete blob upload".to_string()),
                ));
            }
            Ok(())
        })
    }

    fn download_blob<'a>(
        &'a self,
        blob: &'a BlobRef,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>>> + 'a>> {
        Box::pin(async move {
            let download = self.get_blob_download_url(&blob.hash).await?;
            fetch_bytes(&download.url, &[], self.abort_signal.as_ref()).await
        })
    }
}

impl WebSyncTransport {
    async fn initiate_blob_upload(
        &self,
        request: &BlobUploadInitRequest,
    ) -> Result<BlobUploadInitResponse> {
        let url = format!(
            "{}/blobs/upload",
            self.config.base_url.trim_end_matches('/')
        );
        let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
        headers.extend(effective_auth_headers(&self.auth_headers));
        let response = fetch_json(
            "POST",
            &url,
            Some(serde_json::to_string(request)?),
            &headers,
            self.abort_signal.as_ref(),
        )
        .await?;
        serde_wasm_bindgen::from_value(response)
            .map_err(|err| SyncularError::protocol(err).context("decode blob upload init"))
    }

    async fn complete_blob_upload(&self, hash: &str) -> Result<BlobUploadCompleteResponse> {
        let url = format!(
            "{}/blobs/{}/complete",
            self.config.base_url.trim_end_matches('/'),
            blob_hash_path(hash)?
        );
        let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
        headers.extend(effective_auth_headers(&self.auth_headers));
        let response = fetch_json("POST", &url, None, &headers, self.abort_signal.as_ref()).await?;
        serde_wasm_bindgen::from_value(response)
            .map_err(|err| SyncularError::protocol(err).context("decode blob upload complete"))
    }

    async fn get_blob_download_url(&self, hash: &str) -> Result<BlobDownloadUrlResponse> {
        let url = format!(
            "{}/blobs/{}/url",
            self.config.base_url.trim_end_matches('/'),
            blob_hash_path(hash)?
        );
        let headers = effective_auth_headers(&self.auth_headers);
        let response = fetch_json("GET", &url, None, &headers, self.abort_signal.as_ref()).await?;
        serde_wasm_bindgen::from_value(response)
            .map_err(|err| SyncularError::protocol(err).context("decode blob download url"))
    }
}

impl WebRealtimeSocket {
    pub fn connect(config: &WebSyncTransportConfig) -> Result<Self> {
        let url = ws_url(&config.base_url, &config.client_id)?;
        let socket = WebSocket::new(&url)
            .map_err(|err| js_error(ErrorKind::Transport, "connect browser websocket", err))?;
        socket.set_binary_type(BinaryType::Arraybuffer);
        Ok(Self { socket })
    }

    pub fn socket(&self) -> &WebSocket {
        &self.socket
    }

    pub fn send_push_commit(&self, commit: PushCommitRequest) -> Result<String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let message = json!({
            "type": "push",
            "requestId": request_id,
            "clientCommitId": commit.client_commit_id,
            "operations": commit.operations,
            "schemaVersion": commit.schema_version,
        });
        self.socket
            .send_with_str(&message.to_string())
            .map_err(|err| js_error(ErrorKind::Transport, "send browser websocket push", err))?;
        Ok(request_id)
    }

    pub fn close(&self) -> Result<()> {
        self.socket
            .close()
            .map_err(|err| js_error(ErrorKind::Transport, "close browser websocket", err))
    }
}

async fn fetch_json(
    method: &str,
    url: &str,
    body: Option<String>,
    headers: &[(String, String)],
    abort_signal: Option<&JsValue>,
) -> Result<JsValue> {
    let response = fetch_response(method, url, body, headers, abort_signal).await?;
    let status = response.status();
    if !response.ok() {
        let body = response_text(&response).await.unwrap_or_default();
        return Err(SyncularError::message(
            ErrorKind::Transport,
            format!("browser fetch failed with HTTP {status}: {body}"),
        ));
    }
    let json = response
        .json()
        .map_err(|err| js_error(ErrorKind::Transport, "read browser response json", err))?;
    JsFuture::from(json)
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await browser response json", err))
}

async fn fetch_bytes(
    url: &str,
    headers: &[(String, String)],
    abort_signal: Option<&JsValue>,
) -> Result<Vec<u8>> {
    let response = fetch_response("GET", url, None, headers, abort_signal).await?;
    let status = response.status();
    if !response.ok() {
        let body = response_text(&response).await.unwrap_or_default();
        return Err(SyncularError::message(
            ErrorKind::Transport,
            format!("browser snapshot chunk fetch failed with HTTP {status}: {body}"),
        ));
    }
    let buffer = response
        .array_buffer()
        .map_err(|err| js_error(ErrorKind::Transport, "read browser response bytes", err))?;
    let buffer = JsFuture::from(buffer)
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await browser response bytes", err))?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

async fn upload_blob_bytes(
    url: &str,
    method: &str,
    headers: &std::collections::BTreeMap<String, String>,
    bytes: &[u8],
    abort_signal: Option<&JsValue>,
) -> Result<()> {
    let headers = headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    let response = fetch_response_bytes_body(method, url, bytes, &headers, abort_signal).await?;
    let status = response.status();
    if !response.ok() {
        let body = response_text(&response).await.unwrap_or_default();
        return Err(SyncularError::message(
            ErrorKind::Transport,
            format!("browser blob upload failed with HTTP {status}: {body}"),
        ));
    }
    Ok(())
}

fn effective_auth_headers(auth_headers: &SyncAuthHeaders) -> Vec<(String, String)> {
    auth_headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

async fn fetch_response(
    method: &str,
    url: &str,
    body: Option<String>,
    headers: &[(String, String)],
    abort_signal: Option<&JsValue>,
) -> Result<Response> {
    let init = RequestInit::new();
    init.set_method(method);
    init.set_mode(RequestMode::Cors);
    if let Some(body) = body {
        init.set_body(&JsValue::from_str(&body));
    }
    set_abort_signal(&init, abort_signal);

    let request = Request::new_with_str_and_init(url, &init)
        .map_err(|err| js_error(ErrorKind::Transport, "build browser request", err))?;
    for (name, value) in headers {
        request
            .headers()
            .set(name, value)
            .map_err(|err| js_error(ErrorKind::Transport, "set browser request header", err))?;
    }

    let global = js_sys::global();
    let fetch = global_fetch(&global)?;
    let response = fetch
        .call1(&global, &request)
        .map_err(|err| js_error(ErrorKind::Transport, "call browser fetch", err))?;
    let response = JsFuture::from(Promise::from(response))
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await browser fetch", err))?;
    response
        .dyn_into::<Response>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast browser fetch response", err))
}

async fn fetch_response_bytes_body(
    method: &str,
    url: &str,
    body: &[u8],
    headers: &[(String, String)],
    abort_signal: Option<&JsValue>,
) -> Result<Response> {
    let init = RequestInit::new();
    init.set_method(method);
    init.set_mode(RequestMode::Cors);
    let body = Uint8Array::from(body);
    init.set_body(&body);
    set_abort_signal(&init, abort_signal);

    let request = Request::new_with_str_and_init(url, &init)
        .map_err(|err| js_error(ErrorKind::Transport, "build browser blob request", err))?;
    for (name, value) in headers {
        if is_forbidden_fetch_upload_header(name) {
            continue;
        }
        request
            .headers()
            .set(name, value)
            .map_err(|err| js_error(ErrorKind::Transport, "set blob request header", err))?;
    }

    let global = js_sys::global();
    let fetch = global_fetch(&global)?;
    let response = fetch
        .call1(&global, &request)
        .map_err(|err| js_error(ErrorKind::Transport, "call browser blob fetch", err))?;
    let response = JsFuture::from(Promise::from(response))
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await browser blob fetch", err))?;
    response
        .dyn_into::<Response>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast browser blob response", err))
}

fn is_forbidden_fetch_upload_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length" | "host" | "connection" | "transfer-encoding"
    )
}

fn set_abort_signal(init: &RequestInit, abort_signal: Option<&JsValue>) {
    let Some(signal) = abort_signal.and_then(|value| value.dyn_ref::<AbortSignal>()) else {
        return;
    };
    init.set_signal(Some(signal));
}

fn global_fetch(global: &JsValue) -> Result<Function> {
    Reflect::get(global, &JsValue::from_str("fetch"))
        .map_err(|err| js_error(ErrorKind::Config, "read browser fetch", err))?
        .dyn_into::<Function>()
        .map_err(|err| js_error(ErrorKind::Config, "cast browser fetch", err))
}

async fn response_text(response: &Response) -> Result<String> {
    let text = response
        .text()
        .map_err(|err| js_error(ErrorKind::Transport, "read browser response text", err))?;
    let text = JsFuture::from(text)
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await browser response text", err))?;
    Ok(text.as_string().unwrap_or_default())
}

fn decode_snapshot_rows(chunk: &SnapshotChunkRef, compressed: &[u8]) -> Result<Vec<Value>> {
    if chunk.encoding != "json-row-frame-v1" || chunk.compression != "gzip" {
        return Err(SyncularError::protocol_message(format!(
            "unsupported snapshot chunk format: encoding={} compression={}",
            chunk.encoding, chunk.compression
        )));
    }

    let mut decoder = GzDecoder::new(compressed);
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

    decode_srf1_rows(&decoded)
}

fn decode_srf1_rows(bytes: &[u8]) -> Result<Vec<Value>> {
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

fn ws_url(base_url: &str, client_id: &str) -> Result<String> {
    let url = Url::new(base_url)
        .map_err(|err| js_error(ErrorKind::Config, "parse websocket base url", err))?;
    match url.protocol().as_str() {
        "http:" => url.set_protocol("ws:"),
        "https:" => url.set_protocol("wss:"),
        "ws:" | "wss:" => {}
        scheme => {
            return Err(SyncularError::config(format!(
                "unsupported websocket base url scheme: {scheme}"
            )));
        }
    }
    let path = url.pathname().trim_end_matches('/').to_string();
    url.set_pathname(&format!("{path}/realtime"));
    url.search_params().set("clientId", client_id);
    url.search_params()
        .set("schemaVersion", &current_schema_version().to_string());
    url.search_params().set("transportPath", "direct");
    Ok(url.href())
}

fn blob_hash_path(hash: &str) -> Result<String> {
    let Some(hex) = hash.strip_prefix("sha256:") else {
        return Err(SyncularError::protocol_message(format!(
            "invalid blob hash: {hash}"
        )));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SyncularError::protocol_message(format!(
            "invalid blob hash: {hash}"
        )));
    }
    Ok(format!("sha256%3A{hex}"))
}

fn js_error(kind: ErrorKind, context: &str, value: JsValue) -> SyncularError {
    SyncularError::message(kind, format!("{context}: {}", js_value_string(value)))
}

fn js_value_string(value: JsValue) -> String {
    if let Some(value) = value.as_string() {
        return value;
    }
    if let Some(message) = js_object_string_property(&value, "message") {
        if let Some(name) = js_object_string_property(&value, "name") {
            return format!("{name}: {message}");
        }
        return message;
    }
    js_sys::JSON::stringify(&value)
        .ok()
        .and_then(|value| value.as_string())
        .unwrap_or_else(|| "unknown JavaScript error".to_string())
}

fn js_object_string_property(value: &JsValue, property: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_string())
        .filter(|value| !value.is_empty())
}
