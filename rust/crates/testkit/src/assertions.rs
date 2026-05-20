use serde_json::Value;
use std::time::Duration;
use syncular_runtime::client::SyncularClient;
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::store::{ConflictSummary, OutboxSummary};
use syncular_runtime::transport::{SyncAuthHeaders, SyncTransport};

use crate::app_server::{AppTestServer, AppTestServerCommit};
use crate::transport::{BlobUploadRecord, TestTransportHandle};

pub fn assert_outbox_empty<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
) -> Vec<OutboxSummary>
where
    T: SyncTransport,
{
    let summaries = client.outbox_summaries().expect("outbox summaries");
    assert_eq!(summaries.len(), 0, "expected empty outbox: {summaries:?}");
    summaries
}

pub fn assert_outbox_statuses<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    expected: &[&str],
) -> Vec<OutboxSummary>
where
    T: SyncTransport,
{
    let summaries = client.outbox_summaries().expect("outbox summaries");
    let actual = summaries
        .iter()
        .map(|summary| summary.status.as_str())
        .collect::<Vec<_>>();
    assert_eq!(actual, expected, "unexpected outbox statuses");
    summaries
}

pub fn assert_outbox_count<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    expected: usize,
) -> Vec<OutboxSummary>
where
    T: SyncTransport,
{
    let summaries = client.outbox_summaries().expect("outbox summaries");
    assert_eq!(
        summaries.len(),
        expected,
        "unexpected outbox count: {summaries:?}"
    );
    summaries
}

pub fn assert_latest_outbox_status<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    expected: &str,
) -> OutboxSummary
where
    T: SyncTransport,
{
    let summaries = client.outbox_summaries().expect("outbox summaries");
    let latest = summaries.last().expect("latest outbox summary").clone();
    assert_eq!(latest.status, expected, "unexpected latest outbox status");
    latest
}

pub fn assert_conflict_count<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    expected: usize,
) -> Vec<ConflictSummary>
where
    T: SyncTransport,
{
    let conflicts = client.conflict_summaries().expect("conflict summaries");
    assert_eq!(
        conflicts.len(),
        expected,
        "unexpected conflict count: {conflicts:?}"
    );
    conflicts
}

pub fn assert_no_conflicts<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
) -> Vec<ConflictSummary>
where
    T: SyncTransport,
{
    assert_conflict_count(client, 0)
}

pub fn assert_table_row_count<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    table: &str,
    expected: usize,
) -> Vec<Value>
where
    T: SyncTransport,
{
    let rows_json = client.list_table_json(table).expect("table rows");
    let rows: Vec<Value> = serde_json::from_str(&rows_json).expect("table rows json");
    assert_eq!(rows.len(), expected, "unexpected row count for {table}");
    rows
}

pub fn assert_table_has_row<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    table: &str,
    primary_key: &str,
    row_id: &str,
) -> Value
where
    T: SyncTransport,
{
    let rows_json = client.list_table_json(table).expect("table rows");
    let rows: Vec<Value> = serde_json::from_str(&rows_json).expect("table rows json");
    rows.into_iter()
        .find(|row| row.get(primary_key).and_then(Value::as_str) == Some(row_id))
        .unwrap_or_else(|| panic!("expected row {table}.{primary_key}={row_id}"))
}

pub fn assert_blob_upload_queue<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    pending: i64,
    uploading: i64,
    failed: i64,
) where
    T: SyncTransport,
{
    let stats = client.blob_upload_queue_stats().expect("blob queue stats");
    assert_eq!(stats.pending, pending, "unexpected pending blob uploads");
    assert_eq!(
        stats.uploading, uploading,
        "unexpected uploading blob uploads"
    );
    assert_eq!(stats.failed, failed, "unexpected failed blob uploads");
}

pub fn assert_blob_cache<T>(
    client: &mut SyncularClient<DieselSqliteStore, T>,
    count: i64,
    total_bytes: i64,
) where
    T: SyncTransport,
{
    let stats = client.blob_cache_stats().expect("blob cache stats");
    assert_eq!(stats.count, count, "unexpected cached blob count");
    assert_eq!(
        stats.total_bytes, total_bytes,
        "unexpected cached blob bytes"
    );
}

pub fn assert_blob_upload_count(
    handle: &TestTransportHandle,
    expected: usize,
) -> Vec<BlobUploadRecord> {
    let uploads = handle.blob_uploads();
    assert_eq!(
        uploads.len(),
        expected,
        "unexpected blob upload count: {uploads:?}"
    );
    uploads
}

pub fn assert_blob_uploaded(handle: &TestTransportHandle, hash: &str) -> BlobUploadRecord {
    handle
        .blob_uploads()
        .into_iter()
        .find(|upload| upload.blob.hash == hash)
        .unwrap_or_else(|| panic!("expected uploaded blob {hash}"))
}

pub fn assert_app_server_row_count(
    server: &AppTestServer,
    table: &str,
    expected: usize,
) -> Vec<Value> {
    let rows = server.rows(table);
    assert_eq!(
        rows.len(),
        expected,
        "unexpected AppTestServer row count for {table}: {rows:?}"
    );
    rows
}

pub fn assert_app_server_has_row(server: &AppTestServer, table: &str, row_id: &str) -> Value {
    server
        .row(table, row_id)
        .unwrap_or_else(|| panic!("expected AppTestServer row {table}.{row_id}"))
}

pub fn assert_app_server_missing_row(server: &AppTestServer, table: &str, row_id: &str) {
    assert!(
        server.row(table, row_id).is_none(),
        "expected missing AppTestServer row {table}.{row_id}"
    );
}

pub fn assert_app_server_commit_count(
    server: &AppTestServer,
    expected: usize,
    timeout: Duration,
) -> Vec<AppTestServerCommit> {
    let commits = server.wait_for_commit_count(expected, timeout);
    assert_eq!(
        commits.len(),
        expected,
        "unexpected AppTestServer commit count: {commits:?}"
    );
    commits
}

pub fn assert_app_server_auth_header(
    server: &AppTestServer,
    name: &str,
    expected: &str,
) -> SyncAuthHeaders {
    let name = name.to_ascii_lowercase();
    server
        .auth_headers()
        .into_iter()
        .find(|headers| headers.get(&name).map(String::as_str) == Some(expected))
        .unwrap_or_else(|| panic!("expected AppTestServer auth header {name}={expected}"))
}
