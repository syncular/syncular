use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use syncular_runtime::error::Result;
use syncular_runtime::protocol::CombinedResponse;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestHttpRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

impl TestHttpRequest {
    pub fn json(&self) -> Option<Value> {
        serde_json::from_str(&self.body).ok()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestHttpResponse {
    pub status: u16,
    pub reason: String,
    pub content_type: String,
    pub body: String,
}

impl TestHttpResponse {
    pub fn json(body: Value) -> Self {
        Self {
            status: 200,
            reason: "OK".to_string(),
            content_type: "application/json".to_string(),
            body: body.to_string(),
        }
    }

    pub fn status(status: u16, reason: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            status,
            reason: reason.into(),
            content_type: "text/plain".to_string(),
            body: body.into(),
        }
    }

    pub fn sync(response: CombinedResponse) -> Self {
        Self::json(serde_json::to_value(response).expect("combined response JSON"))
    }

    pub fn auth_expired() -> Self {
        Self::status(401, "Unauthorized", "expired token")
    }
}

#[derive(Debug, Default)]
struct TestHttpState {
    requests: Vec<TestHttpRequest>,
    responses: VecDeque<TestHttpResponse>,
}

pub struct TestSyncServer {
    url: String,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<TestHttpState>>,
    join: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestBlobHttpRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl TestBlobHttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[derive(Debug, Clone)]
pub struct TestBlobServerOptions {
    pub bytes: Vec<u8>,
    pub hash: String,
    pub upload_path: String,
    pub download_path: String,
    pub upload_token: String,
}

impl TestBlobServerOptions {
    pub fn new(bytes: Vec<u8>, hash: impl Into<String>) -> Self {
        Self {
            bytes,
            hash: hash.into(),
            upload_path: "/upload-target".to_string(),
            download_path: "/download-target".to_string(),
            upload_token: "upload-token".to_string(),
        }
    }

    pub fn upload_path(mut self, upload_path: impl Into<String>) -> Self {
        self.upload_path = upload_path.into();
        self
    }

    pub fn download_path(mut self, download_path: impl Into<String>) -> Self {
        self.download_path = download_path.into();
        self
    }

    pub fn upload_token(mut self, upload_token: impl Into<String>) -> Self {
        self.upload_token = upload_token.into();
        self
    }
}

#[derive(Debug, Default)]
struct TestBlobState {
    requests: Vec<TestBlobHttpRequest>,
}

pub struct TestBlobServer {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<TestBlobState>>,
    join: Option<JoinHandle<()>>,
}

impl TestBlobServer {
    pub fn start(bytes: Vec<u8>, hash: impl Into<String>) -> Result<Self> {
        Self::start_with_options(TestBlobServerOptions::new(bytes, hash))
    }

    pub fn start_with_options(options: TestBlobServerOptions) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(TestBlobState::default()));
        let thread_stop = stop.clone();
        let thread_state = state.clone();
        let join = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        handle_blob_connection(stream, addr, &options, &thread_state);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            addr,
            stop,
            state,
            join: Some(join),
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn sync_base_url(&self) -> String {
        format!("http://{}/sync", self.addr)
    }

    pub fn requests(&self) -> Vec<TestBlobHttpRequest> {
        self.state
            .lock()
            .expect("test blob server state")
            .requests
            .clone()
    }

    pub fn wait_for_requests(
        &self,
        expected: usize,
        timeout: Duration,
    ) -> Vec<TestBlobHttpRequest> {
        let deadline = Instant::now() + timeout;
        loop {
            let requests = self.requests();
            if requests.len() >= expected || Instant::now() >= deadline {
                return requests;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for TestBlobServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.addr);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl TestSyncServer {
    pub fn spawn(responses: impl IntoIterator<Item = TestHttpResponse>) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(TestHttpState {
            requests: Vec::new(),
            responses: responses.into_iter().collect(),
        }));
        let thread_stop = stop.clone();
        let thread_state = state.clone();
        let join = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => handle_connection(&mut stream, &thread_state),
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            url: format!("http://{addr}/sync"),
            stop,
            state,
            join: Some(join),
        })
    }

    pub fn empty_success() -> Result<Self> {
        Self::spawn([empty_success_response()])
    }

    pub fn sync_responses(responses: impl IntoIterator<Item = CombinedResponse>) -> Result<Self> {
        Self::spawn(responses.into_iter().map(TestHttpResponse::sync))
    }

    pub fn status(status: u16, reason: impl Into<String>, body: impl Into<String>) -> Result<Self> {
        Self::spawn([TestHttpResponse::status(status, reason, body)])
    }

    pub fn url(&self) -> String {
        self.url.clone()
    }

    pub fn requests(&self) -> Vec<TestHttpRequest> {
        self.state
            .lock()
            .expect("test http server state")
            .requests
            .clone()
    }

    pub fn request_jsons(&self) -> Vec<Value> {
        self.requests()
            .into_iter()
            .filter_map(|request| request.json())
            .collect()
    }

    pub fn wait_for_requests(&self, expected: usize, timeout: Duration) -> Vec<TestHttpRequest> {
        let deadline = Instant::now() + timeout;
        loop {
            let requests = self.requests();
            if requests.len() >= expected || Instant::now() >= deadline {
                return requests;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn push_response(&self, response: TestHttpResponse) {
        self.state
            .lock()
            .expect("test http server state")
            .responses
            .push_back(response);
    }

    pub fn push_sync_response(&self, response: CombinedResponse) {
        self.push_response(TestHttpResponse::sync(response));
    }

    pub fn push_json_response(&self, body: Value) {
        self.push_response(TestHttpResponse::json(body));
    }
}

impl Drop for TestSyncServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(
            self.url
                .trim_start_matches("http://")
                .trim_end_matches("/sync"),
        );
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

pub fn empty_success_response() -> TestHttpResponse {
    TestHttpResponse::json(json!({
        "ok": true,
        "push": null,
        "pull": {
            "ok": true,
            "subscriptions": []
        }
    }))
}

pub fn encoded_blob_hash(hash: &str) -> String {
    hash.replace(':', "%3A")
}

fn handle_blob_connection(
    stream: TcpStream,
    addr: SocketAddr,
    options: &TestBlobServerOptions,
    state: &Arc<Mutex<TestBlobState>>,
) {
    let Ok((request, mut stream)) = read_blob_http_request(stream) else {
        return;
    };
    let response = blob_response_for(&request, addr, options);
    let _ = stream.write_all(response.as_slice());
    state
        .lock()
        .expect("test blob server state")
        .requests
        .push(request);
}

fn read_blob_http_request(stream: TcpStream) -> std::io::Result<(TestBlobHttpRequest, TcpStream)> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or("/").to_string();
    let mut headers = BTreeMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        read_chunked_body(&mut reader)?
    } else {
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body)?;
        body
    };
    let stream = reader.into_inner();
    Ok((
        TestBlobHttpRequest {
            method,
            path,
            headers,
            body,
        },
        stream,
    ))
}

fn read_chunked_body(reader: &mut BufReader<TcpStream>) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        reader.read_line(&mut size_line)?;
        let size_text = size_line
            .trim()
            .split_once(';')
            .map(|(size, _)| size)
            .unwrap_or_else(|| size_line.trim());
        let size = usize::from_str_radix(size_text, 16).unwrap_or(0);
        if size == 0 {
            loop {
                let mut trailer = String::new();
                reader.read_line(&mut trailer)?;
                if trailer == "\r\n" || trailer.is_empty() {
                    return Ok(body);
                }
            }
        }
        let mut chunk = vec![0u8; size];
        reader.read_exact(&mut chunk)?;
        body.extend(chunk);
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf)?;
    }
}

fn blob_response_for(
    request: &TestBlobHttpRequest,
    addr: SocketAddr,
    options: &TestBlobServerOptions,
) -> Vec<u8> {
    let encoded_hash = encoded_blob_hash(&options.hash);
    let complete_path = format!("/sync/blobs/{encoded_hash}/complete");
    let signed_url_path = format!("/sync/blobs/{encoded_hash}/url");
    let body = match request.path.as_str() {
        "/sync/blobs/upload" => format!(
            r#"{{"exists":false,"uploadUrl":"http://{addr}{}","uploadMethod":"PUT","uploadHeaders":{{"x-upload-token":"{}"}}}}"#,
            options.upload_path, options.upload_token
        )
        .into_bytes(),
        path if path == options.upload_path.as_str() => b"OK".to_vec(),
        path if path == complete_path.as_str() => br#"{"ok":true}"#.to_vec(),
        path if path == signed_url_path.as_str() => format!(
            r#"{{"url":"http://{addr}{}","expiresAt":"2099-01-01T00:00:00.000Z"}}"#,
            options.download_path
        )
        .into_bytes(),
        path if path == options.download_path.as_str() => options.bytes.clone(),
        _ => br#"{"error":"NOT_FOUND"}"#.to_vec(),
    };
    let status = if request.path == options.download_path
        || request.path == options.upload_path
        || request.path.starts_with("/sync/blobs/")
    {
        "200 OK"
    } else {
        "404 Not Found"
    };
    let content_type = if request.path == options.download_path {
        "application/octet-stream"
    } else {
        "application/json"
    };
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let mut response = head.into_bytes();
    response.extend(body);
    response
}

fn handle_connection(stream: &mut TcpStream, state: &Arc<Mutex<TestHttpState>>) {
    let request = read_http_request(stream);
    if request.body.is_empty() && request.method.is_empty() {
        return;
    }
    let response = {
        let mut state = state.lock().expect("test http server state");
        state.requests.push(request);
        state
            .responses
            .pop_front()
            .unwrap_or_else(empty_success_response)
    };
    write_http_response(stream, response);
}

fn read_http_request(stream: &mut TcpStream) -> TestHttpRequest {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let Ok(read) = stream.read(&mut chunk) else {
            break;
        };
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if request_body_complete(&buffer) {
            break;
        }
    }
    parse_http_request(&String::from_utf8_lossy(&buffer))
}

fn request_body_complete(buffer: &[u8]) -> bool {
    let text = String::from_utf8_lossy(buffer);
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    body.as_bytes().len() >= content_length
}

fn parse_http_request(raw: &str) -> TestHttpRequest {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    TestHttpRequest {
        method,
        path,
        headers,
        body: body.to_string(),
    }
}

fn write_http_response(stream: &mut TcpStream, response: TestHttpResponse) {
    let body = response.body;
    let message = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        response.status,
        response.reason,
        response.content_type,
        body.len(),
        body
    );
    let _ = stream.write_all(message.as_bytes());
}
