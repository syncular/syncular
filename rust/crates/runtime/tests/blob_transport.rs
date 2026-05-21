use std::path::Path;
use std::thread;
use std::time::Duration;

use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::error::Result;
use syncular_runtime::protocol::{blob_hash, BlobRef};
use syncular_runtime::transport::SyncAuthHeaders;
use syncular_testkit::{
    encoded_blob_hash, sync_conformance_bytes, sync_conformance_i32, sync_conformance_i64,
    sync_conformance_str, sync_conformance_usize, unique_temp_db_path, unique_temp_file_path,
    TestBlobServer, TestBlobServerOptions,
};

#[test]
fn native_http_blob_transport_uploads_and_downloads() -> Result<()> {
    let bytes = blob_conformance_bytes(&["bytes"]);
    let hash = blob_hash(&bytes);
    let server = blob_server(bytes.clone(), hash.clone())?;
    let path = temp_db_path("syncular-native-blob-transport");
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: server.sync_base_url(),
        client_id: blob_conformance_str(&["clientId"]),
        actor_id: blob_conformance_str(&["actorId"]),
        project_id: Some("p0".to_string()),
    })?;
    let mut headers = SyncAuthHeaders::new();
    headers.insert(
        "authorization".to_string(),
        blob_conformance_str(&["authorization"]),
    );
    client.set_auth_headers(headers);

    let blob = client.store_blob_bytes(&bytes, &blob_conformance_str(&["mimeType"]), false)?;
    assert_eq!(blob.hash, hash);
    assert_eq!(
        client.blob_upload_queue_stats()?.pending,
        blob_conformance_i64(&["expectedUploadQueueBefore", "pending"])
    );

    let uploaded = client.process_blob_upload_queue()?;
    assert_eq!(
        uploaded.uploaded,
        blob_conformance_i32(&["expectedProcessUploaded", "uploaded"])
    );
    assert_eq!(
        uploaded.failed,
        blob_conformance_i32(&["expectedProcessUploaded", "failed"])
    );
    assert_eq!(
        client.blob_upload_queue_stats()?.pending,
        blob_conformance_i64(&["expectedUploadQueueAfter", "pending"])
    );

    client.clear_blob_cache()?;
    assert!(!client.is_blob_local(&blob.hash)?);
    let downloaded = client.retrieve_blob_bytes(&blob)?;
    assert_eq!(downloaded, bytes);
    assert!(client.is_blob_local(&blob.hash)?);

    let requests = server.wait_for_requests(5, Duration::from_secs(1));
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.clone())
            .collect::<Vec<_>>(),
        vec![
            "/sync/blobs/upload".to_string(),
            blob_conformance_str(&["uploadPath"]),
            format!("/sync/blobs/{}/complete", encoded_blob_hash(&hash)),
            format!("/sync/blobs/{}/url", encoded_blob_hash(&hash)),
            blob_conformance_str(&["downloadPath"]),
        ]
    );
    let expected_authorization = blob_conformance_str(&["authorization"]);
    let expected_upload_token = blob_conformance_str(&["uploadToken"]);
    assert_eq!(
        requests[0].headers.get("authorization").map(String::as_str),
        Some(expected_authorization.as_str())
    );
    assert_eq!(requests[1].body, bytes);
    assert_eq!(
        requests[1]
            .headers
            .get("x-upload-token")
            .map(String::as_str),
        Some(expected_upload_token.as_str())
    );
    assert_eq!(
        requests[2].headers.get("authorization").map(String::as_str),
        Some(expected_authorization.as_str())
    );
    assert_eq!(
        requests[3].headers.get("authorization").map(String::as_str),
        Some(expected_authorization.as_str())
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_blob_encryption_stores_uploads_and_downloads_ciphertext() -> Result<()> {
    let plaintext = blob_conformance_bytes(&["bytes"]);
    let plaintext_hash = blob_hash(&plaintext);
    let path = temp_db_path("syncular-native-encrypted-blob");
    let encryption_json = encrypted_blob_config_json();
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
        client_id: blob_conformance_str(&["clientId"]),
        actor_id: blob_conformance_str(&["actorId"]),
        project_id: Some("p0".to_string()),
    })?;
    client.set_blob_encryption_json(&encryption_json)?;

    let blob = client.store_blob_bytes(&plaintext, "text/plain", false)?;
    assert!(blob.encrypted);
    assert_eq!(blob.key_id.as_deref(), Some("default"));
    assert_ne!(blob.hash, plaintext_hash);
    let cached_ciphertext = DieselSqliteStore::open(&path)?
        .read_cached_blob(&blob.hash)?
        .expect("cached encrypted blob");
    assert_ne!(cached_ciphertext, plaintext);
    assert_eq!(blob.hash, blob_hash(&cached_ciphertext));
    assert_eq!(client.retrieve_blob_bytes(&blob)?, plaintext);

    let server = blob_server(cached_ciphertext.clone(), blob.hash.clone())?;
    let mut upload_client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: server.sync_base_url(),
        client_id: blob_conformance_str(&["clientId"]),
        actor_id: blob_conformance_str(&["actorId"]),
        project_id: Some("p0".to_string()),
    })?;
    upload_client.set_blob_encryption_json(&encryption_json)?;
    assert_eq!(upload_client.process_blob_upload_queue()?.uploaded, 1);
    upload_client.clear_blob_cache()?;
    assert_eq!(upload_client.retrieve_blob_bytes(&blob)?, plaintext);

    let requests = server.wait_for_requests(5, Duration::from_secs(1));
    assert_eq!(requests[1].body, cached_ciphertext);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_http_blob_transport_rejects_corrupted_downloads_without_caching() -> Result<()> {
    let bytes = blob_conformance_bytes(&["bytes"]);
    let hash = blob_hash(&bytes);
    let mut corrupted = bytes.clone();
    corrupted[0] ^= 0xff;
    let server = blob_server(corrupted, hash.clone())?;
    let path = temp_db_path("syncular-native-blob-corrupt-download");
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: server.sync_base_url(),
        client_id: blob_conformance_str(&["missingClientId"]),
        actor_id: blob_conformance_str(&["actorId"]),
        project_id: Some("p0".to_string()),
    })?;
    let mut headers = SyncAuthHeaders::new();
    headers.insert(
        "authorization".to_string(),
        blob_conformance_str(&["authorization"]),
    );
    client.set_auth_headers(headers);
    let blob = BlobRef {
        hash: hash.clone(),
        size: bytes.len() as i64,
        mime_type: blob_conformance_str(&["mimeType"]),
        encrypted: false,
        key_id: None,
    };

    let error = client
        .retrieve_blob_bytes(&blob)
        .expect_err("corrupted blob body must be rejected");
    assert!(
        error.message_text().contains("hash")
            || error.message_text().contains("digest")
            || error.message_text().contains("integrity"),
        "unexpected corrupted blob error: {error:?}"
    );
    assert!(!client.is_blob_local(&hash)?);

    let requests = server.wait_for_requests(2, Duration::from_secs(1));
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.clone())
            .collect::<Vec<_>>(),
        vec![
            format!("/sync/blobs/{}/url", encoded_blob_hash(&hash)),
            blob_conformance_str(&["downloadPath"]),
        ]
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_http_blob_transport_streams_files_without_local_cache() -> Result<()> {
    let bytes = (0..blob_conformance_usize(&["streamingByteCount"]))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let hash = blob_hash(&bytes);
    let server = blob_server(bytes.clone(), hash.clone())?;
    let path = temp_db_path("syncular-native-blob-streaming");
    let input_path = temp_file_path("syncular-native-blob-streaming-input");
    let output_path = temp_file_path("syncular-native-blob-streaming-output");
    std::fs::write(&input_path, &bytes)?;
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: server.sync_base_url(),
        client_id: blob_conformance_str(&["streamingClientId"]),
        actor_id: blob_conformance_str(&["actorId"]),
        project_id: Some("p0".to_string()),
    })?;
    let mut headers = SyncAuthHeaders::new();
    headers.insert(
        "authorization".to_string(),
        blob_conformance_str(&["authorization"]),
    );
    client.set_auth_headers(headers);

    let blob = client.store_blob_file(
        Path::new(&input_path),
        &blob_conformance_str(&["mimeType"]),
        true,
        false,
    )?;
    assert_eq!(blob.hash, hash);
    assert_eq!(blob.size, bytes.len() as i64);
    assert!(!client.is_blob_local(&blob.hash)?);

    client.retrieve_blob_file(&blob, Path::new(&output_path), false)?;
    assert_eq!(std::fs::read(&output_path)?, bytes);
    assert!(!client.is_blob_local(&blob.hash)?);

    let requests = server.wait_for_requests(5, Duration::from_secs(1));
    assert_eq!(
        requests[1].body.len(),
        blob_conformance_usize(&["streamingByteCount"])
    );
    assert_eq!(requests[1].body, std::fs::read(&input_path)?);

    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(input_path);
    let _ = std::fs::remove_file(output_path);
    Ok(())
}

#[test]
fn native_blob_cache_prunes_oldest_entries_to_byte_budget() -> Result<()> {
    let path = temp_db_path("syncular-native-blob-cache-prune");
    let mut client = SyncularClient::open(SyncularClientConfig {
        db_path: path.clone(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
        client_id: blob_conformance_str(&["cachePruneClientId"]),
        actor_id: blob_conformance_str(&["actorId"]),
        project_id: Some("p0".to_string()),
    })?;

    let old_bytes = blob_conformance_str(&["cachePruneOldText"]).into_bytes();
    let old_blob =
        client.store_blob_bytes(&old_bytes, &blob_conformance_str(&["textMimeType"]), false)?;
    thread::sleep(Duration::from_millis(5));
    let new_bytes = blob_conformance_str(&["cachePruneNewText"]).into_bytes();
    let new_blob =
        client.store_blob_bytes(&new_bytes, &blob_conformance_str(&["textMimeType"]), false)?;

    let before = client.blob_cache_stats()?;
    assert_eq!(
        before.count,
        blob_conformance_i64(&["expectedCacheBeforePrune", "count"])
    );
    assert_eq!(
        before.total_bytes,
        blob_conformance_i64(&["expectedCacheBeforePrune", "totalBytes"])
    );
    assert_eq!(
        client.prune_blob_cache(blob_conformance_i64(&["cachePruneMaxBytes"]))?,
        blob_conformance_i64(&["expectedCachePrunedBytes"])
    );
    let after = client.blob_cache_stats()?;
    assert_eq!(
        after.count,
        blob_conformance_i64(&["expectedCacheAfterPrune", "count"])
    );
    assert_eq!(
        after.total_bytes,
        blob_conformance_i64(&["expectedCacheAfterPrune", "totalBytes"])
    );
    assert!(!client.is_blob_local(&old_blob.hash)?);
    assert!(client.is_blob_local(&new_blob.hash)?);

    let _ = std::fs::remove_file(path);
    Ok(())
}

fn blob_server(bytes: Vec<u8>, hash: String) -> Result<TestBlobServer> {
    TestBlobServer::start_with_options(
        TestBlobServerOptions::new(bytes, hash)
            .upload_path(blob_conformance_str(&["uploadPath"]))
            .download_path(blob_conformance_str(&["downloadPath"]))
            .upload_token(blob_conformance_str(&["uploadToken"])),
    )
}

fn temp_db_path(prefix: &str) -> String {
    unique_temp_db_path(prefix)
}

fn temp_file_path(prefix: &str) -> String {
    unique_temp_file_path(prefix)
}

fn blob_conformance_str(path: &[&str]) -> String {
    sync_conformance_str(&blob_conformance_path(path))
}

fn blob_conformance_i64(path: &[&str]) -> i64 {
    sync_conformance_i64(&blob_conformance_path(path))
}

fn blob_conformance_i32(path: &[&str]) -> i32 {
    sync_conformance_i32(&blob_conformance_path(path))
}

fn blob_conformance_usize(path: &[&str]) -> usize {
    sync_conformance_usize(&blob_conformance_path(path))
}

fn blob_conformance_bytes(path: &[&str]) -> Vec<u8> {
    sync_conformance_bytes(&blob_conformance_path(path))
}

fn encrypted_blob_config_json() -> String {
    serde_json::json!({
        "keys": {
            "default": "0909090909090909090909090909090909090909090909090909090909090909"
        }
    })
    .to_string()
}

fn blob_conformance_path<'a>(path: &'a [&'a str]) -> Vec<&'a str> {
    let mut full_path = Vec::with_capacity(path.len() + 1);
    full_path.push("blob");
    full_path.extend_from_slice(path);
    full_path
}
