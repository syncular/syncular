use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::error::Result;
use syncular_runtime::protocol::blob_hash;
use syncular_runtime::transport::SyncAuthHeaders;
use uuid::Uuid;

#[test]
fn native_http_blob_transport_uploads_and_downloads() -> Result<()> {
    let bytes = vec![9u8, 8, 7, 6];
    let hash = blob_hash(&bytes);
    let server = BlobServer::start(bytes.clone(), hash.clone());
    let path = temp_db_path("syncular-native-blob-transport");
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: format!("http://{}/sync", server.addr),
        client_id: "blob-transport-client".to_string(),
        actor_id: "actor-blob".to_string(),
        project_id: Some("p0".to_string()),
    })?;
    let mut headers = SyncAuthHeaders::new();
    headers.insert("authorization".to_string(), "Bearer blob-token".to_string());
    client.set_auth_headers(headers);

    let blob = client.store_blob_bytes(&bytes, "application/test", false)?;
    assert_eq!(blob.hash, hash);
    assert_eq!(client.blob_upload_queue_stats()?.pending, 1);

    let uploaded = client.process_blob_upload_queue()?;
    assert_eq!(uploaded.uploaded, 1);
    assert_eq!(uploaded.failed, 0);
    assert_eq!(client.blob_upload_queue_stats()?.pending, 0);

    client.clear_blob_cache()?;
    assert!(!client.is_blob_local(&blob.hash)?);
    let downloaded = client.retrieve_blob_bytes(&blob)?;
    assert_eq!(downloaded, bytes);
    assert!(client.is_blob_local(&blob.hash)?);

    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.clone())
            .collect::<Vec<_>>(),
        vec![
            "/sync/blobs/upload".to_string(),
            "/upload-target".to_string(),
            format!("/sync/blobs/{}/complete", encoded_hash(&hash)),
            format!("/sync/blobs/{}/url", encoded_hash(&hash)),
            "/download-target".to_string(),
        ]
    );
    assert_eq!(
        requests[0].headers.get("authorization").map(String::as_str),
        Some("Bearer blob-token")
    );
    assert_eq!(requests[1].body, bytes);
    assert_eq!(
        requests[1]
            .headers
            .get("x-upload-token")
            .map(String::as_str),
        Some("upload-token")
    );
    assert_eq!(
        requests[2].headers.get("authorization").map(String::as_str),
        Some("Bearer blob-token")
    );
    assert_eq!(
        requests[3].headers.get("authorization").map(String::as_str),
        Some("Bearer blob-token")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_http_blob_transport_streams_files_without_local_cache() -> Result<()> {
    let bytes = (0..128_000)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let hash = blob_hash(&bytes);
    let server = BlobServer::start(bytes.clone(), hash.clone());
    let path = temp_db_path("syncular-native-blob-streaming");
    let input_path = temp_file_path("syncular-native-blob-streaming-input");
    let output_path = temp_file_path("syncular-native-blob-streaming-output");
    std::fs::write(&input_path, &bytes)?;
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: format!("http://{}/sync", server.addr),
        client_id: "blob-streaming-client".to_string(),
        actor_id: "actor-blob".to_string(),
        project_id: Some("p0".to_string()),
    })?;

    let blob = client.store_blob_file(Path::new(&input_path), "application/test", true, false)?;
    assert_eq!(blob.hash, hash);
    assert_eq!(blob.size, bytes.len() as i64);
    assert!(!client.is_blob_local(&blob.hash)?);

    client.retrieve_blob_file(&blob, Path::new(&output_path), false)?;
    assert_eq!(std::fs::read(&output_path)?, bytes);
    assert!(!client.is_blob_local(&blob.hash)?);

    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(requests[1].body.len(), 128_000);
    assert_eq!(requests[1].body, std::fs::read(&input_path)?);

    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(input_path);
    let _ = std::fs::remove_file(output_path);
    Ok(())
}

#[derive(Clone, Debug)]
struct RecordedRequest {
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

struct BlobServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl BlobServer {
    fn start(bytes: Vec<u8>, hash: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind blob test server");
        let addr = listener.local_addr().expect("blob test server addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_requests = Arc::clone(&requests);
        thread::spawn(move || {
            for stream in listener.incoming().take(5) {
                let Ok(stream) = stream else {
                    continue;
                };
                let (request, mut stream) = read_request(stream).expect("read blob test request");
                let response = response_for(&request, addr, &hash, &bytes);
                stream
                    .write_all(response.as_slice())
                    .expect("write blob test response");
                thread_requests.lock().unwrap().push(request);
            }
        });
        Self { addr, requests }
    }
}

fn read_request(stream: TcpStream) -> std::io::Result<(RecordedRequest, TcpStream)> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();
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
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let stream = reader.into_inner();
    Ok((
        RecordedRequest {
            path,
            headers,
            body,
        },
        stream,
    ))
}

fn response_for(request: &RecordedRequest, addr: SocketAddr, hash: &str, bytes: &[u8]) -> Vec<u8> {
    let body = match request.path.as_str() {
        "/sync/blobs/upload" => format!(
            r#"{{"exists":false,"uploadUrl":"http://{addr}/upload-target","uploadMethod":"PUT","uploadHeaders":{{"x-upload-token":"upload-token"}}}}"#
        )
        .into_bytes(),
        "/upload-target" => b"OK".to_vec(),
        path if path == format!("/sync/blobs/{}/complete", encoded_hash(hash)) => {
            br#"{"ok":true}"#.to_vec()
        }
        path if path == format!("/sync/blobs/{}/url", encoded_hash(hash)) => format!(
            r#"{{"url":"http://{addr}/download-target","expiresAt":"2099-01-01T00:00:00.000Z"}}"#
        )
        .into_bytes(),
        "/download-target" => bytes.to_vec(),
        _ => br#"{"error":"NOT_FOUND"}"#.to_vec(),
    };
    let status = if request.path == "/download-target" || request.path == "/upload-target" {
        "200 OK"
    } else if request.path.starts_with("/sync/blobs/") {
        "200 OK"
    } else {
        "404 Not Found"
    };
    let content_type = if request.path == "/download-target" {
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

fn encoded_hash(hash: &str) -> String {
    hash.replace(':', "%3A")
}

fn temp_db_path(prefix: &str) -> String {
    std::env::temp_dir()
        .join(format!("{prefix}-{}.sqlite", Uuid::new_v4()))
        .to_string_lossy()
        .into_owned()
}

fn temp_file_path(prefix: &str) -> String {
    std::env::temp_dir()
        .join(format!("{prefix}-{}", Uuid::new_v4()))
        .to_string_lossy()
        .into_owned()
}
