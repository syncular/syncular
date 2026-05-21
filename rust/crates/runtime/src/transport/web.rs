use crate::binary_snapshot::{decode_binary_snapshot_payload, SnapshotChunkRows};
use crate::binary_sync_pack::{decode_binary_sync_pack, is_binary_sync_pack_content_type};
use crate::error::{ErrorKind, Result, SyncularError};
#[cfg(feature = "web-blobs")]
use crate::protocol::{
    validate_blob_bytes, validate_blob_hash, validate_blob_ref_size, BlobDownloadUrlResponse,
    BlobRef, BlobUploadCompleteResponse, BlobUploadInitRequest, BlobUploadInitResponse,
};
use crate::protocol::{
    CombinedRequest, CombinedResponse, ScopeValues, ScopedSnapshotArtifactRef, SnapshotChunkRef,
    SNAPSHOT_CHUNK_COMPRESSION_GZIP, SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
    SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
};
use crate::runtime_schema::runtime_schema_version;
use crate::transport::{SyncAuthHeaderStore, SyncAuthHeaders};
use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortSignal, Request, RequestInit, RequestMode, Response};

#[derive(Debug, Clone)]
pub struct WebSyncTransportConfig {
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub collect_server_timings: bool,
}

#[derive(Clone)]
pub struct WebSyncTransport {
    config: WebSyncTransportConfig,
    auth_headers: SyncAuthHeaders,
    abort_signal: Option<JsValue>,
    stats: Rc<RefCell<WebTransportStats>>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTransportStats {
    pub request_count: u64,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub snapshot_chunk_count: u64,
    pub snapshot_chunk_json_count: u64,
    pub snapshot_chunk_binary_count: u64,
    pub snapshot_chunk_row_count: u64,
    pub snapshot_chunk_fetch_ms: f64,
    pub snapshot_chunk_decompress_ms: f64,
    pub snapshot_chunk_hash_ms: f64,
    pub snapshot_chunk_decode_ms: f64,
    pub snapshot_artifact_count: u64,
    pub snapshot_artifact_bytes: u64,
    pub snapshot_artifact_fetch_ms: f64,
    pub snapshot_artifact_decompress_ms: f64,
    pub snapshot_artifact_hash_ms: f64,
    pub sync_pack_decode_ms: f64,
    pub server_bootstrap_snapshot_query_ms: f64,
    pub server_bootstrap_row_frame_encode_ms: f64,
    pub server_bootstrap_snapshot_binary_encode_ms: f64,
    pub server_bootstrap_chunk_cache_lookup_ms: f64,
    pub server_bootstrap_artifact_cache_lookup_ms: f64,
    pub server_bootstrap_chunk_gzip_ms: f64,
    pub server_bootstrap_chunk_hash_ms: f64,
    pub server_bootstrap_chunk_persist_ms: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebServerBootstrapTimings {
    snapshot_query_ms: f64,
    row_frame_encode_ms: f64,
    #[serde(default, alias = "snapshotBinaryEncodeMs")]
    binary_encode_ms: f64,
    chunk_cache_lookup_ms: f64,
    #[serde(default)]
    artifact_cache_lookup_ms: f64,
    chunk_gzip_ms: f64,
    chunk_hash_ms: f64,
    chunk_persist_ms: f64,
}

pub trait AsyncSyncTransport {
    fn post_sync<'a>(
        &'a self,
        request: &'a CombinedRequest,
    ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>>;

    fn fetch_snapshot_chunk_rows<'a>(
        &'a self,
        chunk: &'a SnapshotChunkRef,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>>;

    fn fetch_snapshot_artifact_bytes<'a>(
        &'a self,
        _artifact: &'a ScopedSnapshotArtifactRef,
        _scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>>> + 'a>> {
        Box::pin(async {
            Err(SyncularError::protocol_message(
                "snapshot artifact transport is not implemented",
            ))
        })
    }
}

#[cfg(feature = "web-blobs")]
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
            stats: Rc::new(RefCell::new(WebTransportStats::default())),
        }
    }

    pub fn config(&self) -> &WebSyncTransportConfig {
        &self.config
    }

    pub fn set_abort_signal(&mut self, signal: Option<JsValue>) {
        self.abort_signal = signal;
    }

    pub fn stats(&self) -> WebTransportStats {
        self.stats.borrow().clone()
    }

    pub fn stats_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.stats())?)
    }

    pub fn reset_stats(&self) {
        *self.stats.borrow_mut() = WebTransportStats::default();
    }
}

impl SyncAuthHeaderStore for WebSyncTransport {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.auth_headers = headers;
    }
}

impl AsyncSyncTransport for WebSyncTransport {
    fn post_sync<'a>(
        &'a self,
        request: &'a CombinedRequest,
    ) -> Pin<Box<dyn Future<Output = Result<CombinedResponse>> + 'a>> {
        Box::pin(async move {
            let mut headers = vec![
                ("content-type".to_string(), "application/json".to_string()),
                (
                    "x-syncular-schema-version".to_string(),
                    runtime_schema_version().to_string(),
                ),
                (
                    "x-syncular-transport-path".to_string(),
                    "direct".to_string(),
                ),
            ];
            if self.config.collect_server_timings {
                headers.push(("x-syncular-bench-timings".to_string(), "1".to_string()));
            }
            headers.extend(effective_auth_headers(&self.auth_headers));
            fetch_sync_response_metered(
                "POST",
                &self.config.base_url,
                Some(serde_json::to_string(request)?),
                &headers,
                self.abort_signal.as_ref(),
                &self.stats,
            )
            .await
        })
    }

    fn fetch_snapshot_chunk_rows<'a>(
        &'a self,
        chunk: &'a SnapshotChunkRef,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<SnapshotChunkRows>> + 'a>> {
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
            let fetch_started_at = timing_now_ms();
            let compressed = fetch_bytes_metered(
                "snapshot chunk",
                &url,
                &headers,
                self.abort_signal.as_ref(),
                &self.stats,
            )
            .await?;
            record_snapshot_chunk_fetch(&self.stats, elapsed_ms_since(fetch_started_at));
            decode_snapshot_rows(chunk, &compressed, &self.stats).await
        })
    }

    fn fetch_snapshot_artifact_bytes<'a>(
        &'a self,
        artifact: &'a ScopedSnapshotArtifactRef,
        scopes: &'a ScopeValues,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>>> + 'a>> {
        Box::pin(async move {
            let url = format!(
                "{}/snapshot-artifacts/{}",
                self.config.base_url.trim_end_matches('/'),
                artifact.id
            );
            let mut headers = vec![(
                "x-syncular-snapshot-scopes".to_string(),
                serde_json::to_string(scopes)?,
            )];
            headers.extend(effective_auth_headers(&self.auth_headers));
            let fetch_started_at = timing_now_ms();
            let bytes = fetch_bytes_metered(
                "snapshot artifact",
                &url,
                &headers,
                self.abort_signal.as_ref(),
                &self.stats,
            )
            .await?;
            record_snapshot_artifact_fetch(
                &self.stats,
                bytes.len(),
                elapsed_ms_since(fetch_started_at),
            );
            decode_snapshot_artifact_bytes(artifact, &bytes, &self.stats).await
        })
    }
}

#[cfg(feature = "web-blobs")]
impl AsyncBlobTransport for WebSyncTransport {
    fn upload_blob<'a>(
        &'a self,
        blob: &'a BlobRef,
        bytes: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>> {
        Box::pin(async move {
            validate_blob_bytes(blob, bytes)?;
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
            validate_blob_hash(&blob.hash)?;
            validate_blob_ref_size(blob)?;
            let download = self.get_blob_download_url(&blob.hash).await?;
            let bytes = fetch_bytes(
                "blob download",
                &download.url,
                &[],
                self.abort_signal.as_ref(),
            )
            .await?;
            validate_blob_bytes(blob, &bytes)?;
            Ok(bytes)
        })
    }
}

#[cfg(feature = "web-blobs")]
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
    let text = response_text(&response).await?;
    js_sys::JSON::parse(&text)
        .map_err(|err| js_error(ErrorKind::Transport, "parse browser response json", err))
}

async fn fetch_bytes(
    label: &str,
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
            format!("browser {label} fetch failed with HTTP {status}: {body}"),
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

async fn fetch_sync_response_metered(
    method: &str,
    url: &str,
    body: Option<String>,
    headers: &[(String, String)],
    abort_signal: Option<&JsValue>,
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<CombinedResponse> {
    record_request(
        stats,
        body.as_ref().map_or(0, |value| value.as_bytes().len()),
    );
    let response = fetch_response(method, url, body, headers, abort_signal).await?;
    let status = response.status();
    if !response.ok() {
        let body = response_text(&response).await.unwrap_or_default();
        record_response(stats, body.as_bytes().len());
        return Err(SyncularError::message(
            ErrorKind::Transport,
            format!("browser fetch failed with HTTP {status}: {body}"),
        ));
    }

    record_server_bootstrap_timings(&response, stats)?;
    let content_type = response_content_type(&response)?;
    if is_binary_sync_pack_content_type(content_type.as_deref()) {
        let buffer = response
            .array_buffer()
            .map_err(|err| js_error(ErrorKind::Transport, "read browser sync pack bytes", err))?;
        let buffer = JsFuture::from(buffer)
            .await
            .map_err(|err| js_error(ErrorKind::Transport, "await browser sync pack bytes", err))?;
        let bytes = Uint8Array::new(&buffer).to_vec();
        record_response(stats, bytes.len());
        let decode_started_at = timing_now_ms();
        let response = decode_binary_sync_pack(&bytes);
        record_sync_pack_decode(stats, elapsed_ms_since(decode_started_at));
        return response;
    }

    let text = response_text(&response).await?;
    record_response(stats, text.as_bytes().len());
    serde_json::from_str(&text).map_err(|err| {
        let prefix = text.chars().take(120).collect::<String>();
        SyncularError::protocol_message(format!(
            "decode browser sync response: {err}; content-type={content_type:?}; prefix={prefix:?}"
        ))
    })
}

async fn fetch_bytes_metered(
    label: &str,
    url: &str,
    headers: &[(String, String)],
    abort_signal: Option<&JsValue>,
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<Vec<u8>> {
    record_request(stats, 0);
    let bytes = fetch_bytes(label, url, headers, abort_signal).await?;
    record_response(stats, bytes.len());
    Ok(bytes)
}

fn response_content_type(response: &Response) -> Result<Option<String>> {
    response
        .headers()
        .get("content-type")
        .map_err(|err| js_error(ErrorKind::Transport, "read response content-type", err))
}

#[cfg(feature = "web-blobs")]
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

fn record_request(stats: &Rc<RefCell<WebTransportStats>>, request_bytes: usize) {
    let mut stats = stats.borrow_mut();
    stats.request_count += 1;
    stats.request_bytes += request_bytes as u64;
}

fn record_response(stats: &Rc<RefCell<WebTransportStats>>, response_bytes: usize) {
    stats.borrow_mut().response_bytes += response_bytes as u64;
}

fn record_snapshot_chunk_fetch(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    let mut stats = stats.borrow_mut();
    stats.snapshot_chunk_count += 1;
    stats.snapshot_chunk_fetch_ms += elapsed_ms;
}

fn record_snapshot_chunk_rows(stats: &Rc<RefCell<WebTransportStats>>, rows: &SnapshotChunkRows) {
    let mut stats = stats.borrow_mut();
    match rows {
        SnapshotChunkRows::Json(_) => stats.snapshot_chunk_json_count += 1,
        SnapshotChunkRows::Binary(_) | SnapshotChunkRows::BinaryPayload(_) => {
            stats.snapshot_chunk_binary_count += 1
        }
    }
    stats.snapshot_chunk_row_count += rows.row_count() as u64;
}

fn record_snapshot_chunk_decompress(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    stats.borrow_mut().snapshot_chunk_decompress_ms += elapsed_ms;
}

fn record_snapshot_chunk_hash(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    stats.borrow_mut().snapshot_chunk_hash_ms += elapsed_ms;
}

fn record_snapshot_chunk_decode(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    stats.borrow_mut().snapshot_chunk_decode_ms += elapsed_ms;
}

fn record_snapshot_artifact_fetch(
    stats: &Rc<RefCell<WebTransportStats>>,
    bytes: usize,
    elapsed_ms: f64,
) {
    let mut stats = stats.borrow_mut();
    stats.snapshot_artifact_count += 1;
    stats.snapshot_artifact_bytes += bytes as u64;
    stats.snapshot_artifact_fetch_ms += elapsed_ms;
}

fn record_snapshot_artifact_decompress(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    stats.borrow_mut().snapshot_artifact_decompress_ms += elapsed_ms;
}

fn record_snapshot_artifact_hash(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    stats.borrow_mut().snapshot_artifact_hash_ms += elapsed_ms;
}

fn record_sync_pack_decode(stats: &Rc<RefCell<WebTransportStats>>, elapsed_ms: f64) {
    stats.borrow_mut().sync_pack_decode_ms += elapsed_ms;
}

fn record_server_bootstrap_timings(
    response: &Response,
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<()> {
    let Some(raw) = response
        .headers()
        .get("x-syncular-bench-pull-timings")
        .map_err(|err| js_error(ErrorKind::Transport, "read server timing header", err))?
    else {
        return Ok(());
    };
    let timings: WebServerBootstrapTimings = serde_json::from_str(&raw)
        .map_err(|err| SyncularError::protocol(err).context("decode server timing header"))?;
    let mut stats = stats.borrow_mut();
    stats.server_bootstrap_snapshot_query_ms += timings.snapshot_query_ms;
    stats.server_bootstrap_row_frame_encode_ms += timings.row_frame_encode_ms;
    stats.server_bootstrap_snapshot_binary_encode_ms += timings.binary_encode_ms;
    stats.server_bootstrap_chunk_cache_lookup_ms += timings.chunk_cache_lookup_ms;
    stats.server_bootstrap_artifact_cache_lookup_ms += timings.artifact_cache_lookup_ms;
    stats.server_bootstrap_chunk_gzip_ms += timings.chunk_gzip_ms;
    stats.server_bootstrap_chunk_hash_ms += timings.chunk_hash_ms;
    stats.server_bootstrap_chunk_persist_ms += timings.chunk_persist_ms;
    Ok(())
}

#[cfg(feature = "web-blobs")]
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

#[cfg(feature = "web-blobs")]
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

fn timing_now_ms() -> f64 {
    js_sys::Date::now()
}

fn elapsed_ms_since(started_at: f64) -> f64 {
    js_sys::Date::now() - started_at
}

async fn sha256_digest(bytes: &[u8]) -> Result<Vec<u8>> {
    match sha256_digest_webcrypto(bytes).await {
        Ok(Some(digest)) => Ok(digest),
        Ok(None) => Ok(Sha256::digest(bytes).to_vec()),
        Err(_) => Ok(Sha256::digest(bytes).to_vec()),
    }
}

async fn sha256_digest_webcrypto(bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    let global = js_sys::global();
    let crypto = Reflect::get(&global, &JsValue::from_str("crypto"))
        .map_err(|err| js_error(ErrorKind::Transport, "read global crypto", err))?;
    if crypto.is_undefined() || crypto.is_null() {
        return Ok(None);
    }
    let subtle = Reflect::get(&crypto, &JsValue::from_str("subtle"))
        .map_err(|err| js_error(ErrorKind::Transport, "read crypto.subtle", err))?;
    if subtle.is_undefined() || subtle.is_null() {
        return Ok(None);
    }
    let digest = Reflect::get(&subtle, &JsValue::from_str("digest"))
        .map_err(|err| js_error(ErrorKind::Transport, "read crypto.subtle.digest", err))?
        .dyn_into::<Function>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast crypto.subtle.digest", err))?;
    let data = Uint8Array::from(bytes);
    let promise = digest
        .call2(&subtle, &JsValue::from_str("SHA-256"), data.as_ref())
        .map_err(|err| js_error(ErrorKind::Transport, "call crypto.subtle.digest", err))?;
    let digest = JsFuture::from(Promise::from(promise))
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await crypto.subtle.digest", err))?;
    Ok(Some(Uint8Array::new(&digest).to_vec()))
}

async fn decode_snapshot_rows(
    chunk: &SnapshotChunkRef,
    compressed: &[u8],
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<SnapshotChunkRows> {
    let decoded = decode_snapshot_chunk_bytes(chunk, compressed, stats).await?;
    let decode_started_at = timing_now_ms();
    let rows = match chunk.encoding.as_str() {
        SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1 => {
            decode_srf1_rows(&decoded).map(SnapshotChunkRows::Json)
        }
        SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 => {
            let payload = decode_binary_snapshot_payload(decoded)?;
            Ok(SnapshotChunkRows::BinaryPayload(payload))
        }
        encoding => Err(SyncularError::protocol_message(format!(
            "unsupported snapshot chunk encoding: {encoding}"
        ))),
    };
    record_snapshot_chunk_decode(stats, elapsed_ms_since(decode_started_at));
    if let Ok(rows) = &rows {
        record_snapshot_chunk_rows(stats, rows);
    }
    rows
}

async fn validate_snapshot_artifact_bytes(
    artifact: &ScopedSnapshotArtifactRef,
    bytes: &[u8],
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<()> {
    syncular_protocol::validate_scoped_snapshot_artifact_ref(artifact)?;
    if bytes.len() as i64 != artifact.byte_length {
        return Err(SyncularError::protocol_message(format!(
            "snapshot artifact byte length mismatch: expected {}, got {}",
            artifact.byte_length,
            bytes.len()
        )));
    }
    let hash_started_at = timing_now_ms();
    let actual_hash = sha256_digest(bytes).await?;
    record_snapshot_artifact_hash(stats, elapsed_ms_since(hash_started_at));
    let actual_hash = hex::encode(actual_hash);
    if actual_hash != artifact.sha256 {
        return Err(SyncularError::protocol_message(format!(
            "snapshot artifact sha256 mismatch: expected {}, got {}",
            artifact.sha256, actual_hash
        )));
    }
    Ok(())
}

async fn decode_snapshot_artifact_bytes(
    artifact: &ScopedSnapshotArtifactRef,
    compressed: &[u8],
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<Vec<u8>> {
    validate_snapshot_artifact_bytes(artifact, compressed, stats).await?;
    if artifact.compression != SNAPSHOT_CHUNK_COMPRESSION_GZIP {
        return Err(SyncularError::protocol_message(format!(
            "unsupported snapshot artifact compression {}",
            artifact.compression
        )));
    }
    let decompress_started_at = timing_now_ms();
    let decoded = decompress_gzip_with_browser(compressed).await?;
    record_snapshot_artifact_decompress(stats, elapsed_ms_since(decompress_started_at));
    Ok(decoded)
}

async fn decode_snapshot_chunk_bytes(
    chunk: &SnapshotChunkRef,
    compressed: &[u8],
    stats: &Rc<RefCell<WebTransportStats>>,
) -> Result<Vec<u8>> {
    syncular_protocol::validate_snapshot_chunk_format(chunk)?;

    let hash_started_at = timing_now_ms();
    let actual_hash = sha256_digest(compressed).await?;
    record_snapshot_chunk_hash(stats, elapsed_ms_since(hash_started_at));
    syncular_protocol::validate_snapshot_chunk_hash_bytes(chunk, &actual_hash)?;

    let decompress_started_at = timing_now_ms();
    let decoded = decompress_gzip_with_browser(compressed).await?;
    record_snapshot_chunk_decompress(stats, elapsed_ms_since(decompress_started_at));

    Ok(decoded)
}

async fn decompress_gzip_with_browser(compressed: &[u8]) -> Result<Vec<u8>> {
    let global = js_sys::global();
    let ctor = Reflect::get(&global, &JsValue::from_str("DecompressionStream"))
        .map_err(|err| js_error(ErrorKind::Transport, "read DecompressionStream", err))?;
    if !ctor.is_function() {
        return Err(SyncularError::message(
            ErrorKind::Config,
            "browser DecompressionStream('gzip') is required for snapshot gzip decompression",
        ));
    }
    let ctor = ctor
        .dyn_into::<Function>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast DecompressionStream", err))?;
    let stream = Reflect::construct(&ctor, &Array::of1(&JsValue::from_str("gzip")))
        .map_err(|err| js_error(ErrorKind::Transport, "construct DecompressionStream", err))?;

    let input = Uint8Array::from(compressed);
    let response = Response::new_with_opt_js_u8_array(Some(&input))
        .map_err(|err| js_error(ErrorKind::Transport, "construct gzip input response", err))?;
    let body = Reflect::get(response.as_ref(), &JsValue::from_str("body"))
        .map_err(|err| js_error(ErrorKind::Transport, "read response body", err))?;
    if body.is_null() || body.is_undefined() {
        return Err(SyncularError::message(
            ErrorKind::Transport,
            "browser Response body stream is required for snapshot gzip decompression",
        ));
    }
    let pipe_through = Reflect::get(&body, &JsValue::from_str("pipeThrough"))
        .map_err(|err| js_error(ErrorKind::Transport, "read pipeThrough", err))?
        .dyn_into::<Function>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast pipeThrough", err))?;
    let decoded_stream = pipe_through
        .call1(&body, &stream)
        .map_err(|err| js_error(ErrorKind::Transport, "pipe gzip stream", err))?;

    let response_ctor = Reflect::get(&global, &JsValue::from_str("Response"))
        .map_err(|err| js_error(ErrorKind::Transport, "read Response constructor", err))?
        .dyn_into::<Function>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast Response constructor", err))?;
    let decoded_response = Reflect::construct(&response_ctor, &Array::of1(&decoded_stream))
        .map_err(|err| js_error(ErrorKind::Transport, "construct gzip output response", err))?
        .dyn_into::<Response>()
        .map_err(|err| js_error(ErrorKind::Transport, "cast gzip output response", err))?;
    let buffer = decoded_response
        .array_buffer()
        .map_err(|err| js_error(ErrorKind::Transport, "read gzip output array buffer", err))?;
    let buffer = JsFuture::from(buffer)
        .await
        .map_err(|err| js_error(ErrorKind::Transport, "await gzip output array buffer", err))?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

fn decode_srf1_rows(bytes: &[u8]) -> Result<Vec<Value>> {
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
        let row: Map<String, Value> = serde_json::from_slice(&bytes[offset..offset + len])?;
        rows.push(Value::Object(row));
        offset += len;
    }

    Ok(rows)
}

fn estimated_snapshot_row_count(byte_len: usize) -> usize {
    (byte_len / 160).clamp(1, 20_000)
}

#[cfg(feature = "web-blobs")]
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
