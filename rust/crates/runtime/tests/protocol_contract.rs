use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use serde_json::{json, Map, Value};
use syncular_runtime::binary_snapshot::SnapshotChunkRows;
use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::encryption::{
    FieldEncryption, FieldEncryptionContext, FieldEncryptionRule, StaticFieldEncryptionConfig,
};
use syncular_runtime::error::{ErrorKind, Result, SyncularError};
use syncular_runtime::fixtures::todo::rusqlite_sqlite::RusqliteStore;
use syncular_runtime::fixtures::todo::{
    app_schema as demo_todo_app_schema, migrations::current_schema_version,
};
use syncular_runtime::protocol::{
    snapshot_manifest_digest, validate_pull_commit_integrity_metadata,
    validate_pull_snapshot_manifests, wire_commit_chain_root, wire_commit_digest, BootstrapState,
    CombinedRequest, CombinedResponse, OperationResult, PullResponse, PushBatchResponse,
    PushCommitResponse, SnapshotChunkRef, SnapshotManifest, SnapshotManifestChunkRef,
    SubscriptionIntegrity, SubscriptionResponse, SyncChange, SyncCommit, SyncSnapshot,
    COMMIT_INTEGRITY_GENESIS_ROOT,
};
use syncular_runtime::store::{SyncStore, SyncStoreTx};
use syncular_runtime::transport::{
    RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport,
};
use syncular_runtime::worker::{PersistentRealtimeWorker, SyncWorker, SyncWorkerEvent};
use syncular_testkit::{
    combined_not_ok_response, commits_combined_response, default_combined_response,
    pull_not_ok_response, push_conflict_response, push_not_ok_response,
    revoked_subscription_response, schema_latest_response, schema_required_response,
    snapshot_chunks_combined_response, snapshot_combined_response, snapshot_page_combined_response,
    todo_snapshot_response, todo_task_row, unique_temp_db_path, FaultOperation, FaultPhase,
    FaultStep, FaultTransport, TestTransport,
};

#[test]
fn http_sync_sends_schema_version_and_applies_snapshot() -> Result<()> {
    let path = temp_db_path("syncular-protocol-applied");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response_fn(|request| {
        let mut response =
            todo_snapshot_response(vec![todo_task_row("remote-task", "Remote snapshot", 42)]);
        response.push = default_combined_response(request).push;
        Ok(response)
    });
    let config = test_config(&path, "client-http-applied");
    let mut client = demo_client(config, store, transport);

    client.add_task(
        "Local before sync".to_string(),
        Some("local-task".to_string()),
    )?;
    let report = client.sync_http()?;
    assert_eq!(report.changed_tables, vec!["tasks".to_string()]);

    let requests = handle.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.client_id, "client-http-applied");

    let push = request.push.as_ref().expect("push request");
    assert_eq!(push.commits.len(), 1);
    assert_eq!(push.commits[0].schema_version, current_schema_version());
    assert_eq!(push.commits[0].operations[0].table, "tasks");
    assert_eq!(push.commits[0].operations[0].row_id, "local-task");

    let pull = request.pull.as_ref().expect("pull request");
    assert_eq!(pull.subscriptions.len(), 3);
    let task_subscription = pull
        .subscriptions
        .iter()
        .find(|subscription| subscription.id == "sub-tasks")
        .expect("task subscription request");
    assert_eq!(task_subscription.cursor, -1);
    assert_eq!(
        task_subscription
            .scopes
            .get("user_id")
            .and_then(Value::as_str),
        Some("user-rust")
    );
    assert_eq!(
        task_subscription
            .scopes
            .get("project_id")
            .and_then(Value::as_str),
        Some("p0")
    );

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "acked");

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "remote-task");
    assert_eq!(tasks[0].title, "Remote snapshot");
    assert_eq!(tasks[0].server_version, 42);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn http_sync_encrypts_push_payload_just_in_time() -> Result<()> {
    let scenario = sync_conformance_value(&["e2ee"]);
    let path = temp_db_path("syncular-protocol-encrypted-push");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    let config = test_config(
        &path,
        scenario["clientId"].as_str().expect("e2ee client id"),
    );
    let mut client = demo_client(config, store, transport);
    client.set_field_encryption(Some(test_field_encryption()?));

    client.add_task(
        scenario["task"]["title"]
            .as_str()
            .expect("e2ee task title")
            .to_string(),
        Some(
            scenario["task"]["id"]
                .as_str()
                .expect("e2ee task id")
                .to_string(),
        ),
    )?;
    client.sync_http()?;

    let requests = handle.requests();
    let operation = &requests[0].push.as_ref().expect("push").commits[0].operations[0];
    let title = operation
        .payload
        .as_ref()
        .and_then(|payload| payload.get("title"))
        .and_then(Value::as_str)
        .expect("encrypted title");
    assert!(title.starts_with(
        scenario["envelopePrefix"]
            .as_str()
            .expect("e2ee envelope prefix")
    ));
    assert_ne!(
        title,
        scenario["task"]["title"].as_str().expect("e2ee title")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn http_sync_decrypts_encrypted_snapshot_rows() -> Result<()> {
    let scenario = sync_conformance_value(&["e2ee"]);
    let path = temp_db_path("syncular-protocol-encrypted-pull");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::EncryptedSnapshot);
    let config = test_config(
        &path,
        scenario["pullClientId"]
            .as_str()
            .expect("e2ee pull client id"),
    );
    let mut client = demo_client(config, store, transport);
    client.set_field_encryption(Some(test_field_encryption()?));

    client.sync_http()?;

    let tasks = client.list_tasks()?;
    assert_eq!(
        tasks.len(),
        scenario["expectedDecryptedRowCount"]
            .as_u64()
            .expect("expected decrypted row count") as usize
    );
    assert_eq!(
        tasks[0].id,
        scenario["task"]["id"].as_str().expect("task id")
    );
    assert_eq!(
        tasks[0].title,
        scenario["task"]["title"].as_str().expect("task title")
    );
    assert_eq!(
        tasks[0].server_version,
        scenario["serverVersion"]
            .as_i64()
            .expect("e2ee server version")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn http_sync_decrypts_encrypted_conflict_server_rows() -> Result<()> {
    let scenario = sync_conformance_value(&["e2ee"]);
    let conflict = &scenario["conflict"];
    let path = temp_db_path("syncular-protocol-encrypted-conflict");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::EncryptedConflict);
    let config = test_config(
        &path,
        conflict["clientId"]
            .as_str()
            .expect("e2ee conflict client id"),
    );
    let mut client = demo_client(config, store, transport);
    client.set_field_encryption(Some(test_field_encryption()?));

    client.add_task(
        conflict["localTitle"]
            .as_str()
            .expect("e2ee conflict local title")
            .to_string(),
        Some(
            conflict["rowId"]
                .as_str()
                .expect("e2ee conflict row id")
                .to_string(),
        ),
    )?;
    let report = client.sync_http()?;
    assert!(report.conflicts_changed);
    assert_eq!(
        client.conflict_summaries()?.len(),
        conflict["expectedConflictCount"]
            .as_u64()
            .expect("e2ee conflict count") as usize
    );

    let conn = rusqlite::Connection::open(&path)?;
    let server_row_json: String = conn.query_row(
        "select server_row_json from sync_conflicts limit 1",
        [],
        |row| row.get(0),
    )?;
    assert!(!server_row_json.contains(
        scenario["envelopePrefix"]
            .as_str()
            .expect("e2ee envelope prefix")
    ));
    let server_row: Value = serde_json::from_str(&server_row_json)?;
    assert_eq!(
        server_row["title"].as_str(),
        conflict["serverTitle"].as_str()
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn http_sync_decrypts_encrypted_snapshot_chunk_rows() -> Result<()> {
    let scenario = sync_conformance_value(&["e2ee"]);
    let path = temp_db_path("syncular-protocol-encrypted-chunk");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::EncryptedChunkedSnapshot);
    let config = test_config(
        &path,
        scenario["chunk"]["clientId"]
            .as_str()
            .expect("e2ee chunk client id"),
    );
    let mut client = demo_client(config, store, transport);
    client.set_field_encryption(Some(test_field_encryption()?));

    client.sync_http()?;

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        tasks[0].id,
        scenario["task"]["id"].as_str().expect("e2ee task id")
    );
    assert_eq!(
        tasks[0].title,
        scenario["task"]["title"].as_str().expect("e2ee task title")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn http_sync_diesel_applies_blob_ref_snapshot_rows() -> Result<()> {
    let scenario = sync_conformance_value(&["blob", "referenceSync"]);
    let path = temp_db_path("syncular-protocol-blob-ref-snapshot");
    let store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;
    let transport = MockTransport::new(MockMode::BlobReferenceSnapshot);
    let config = test_config(
        &path,
        scenario["readerClientId"]
            .as_str()
            .expect("blob reference reader client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.sync_http()?;

    let rows: Vec<Value> = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], scenario["task"]["id"]);
    assert_eq!(rows[0]["title"], scenario["task"]["title"]);
    let image = rows[0]["image"]
        .as_str()
        .expect("blob ref is stored as SQLite JSON text");
    assert_eq!(
        serde_json::from_str::<Value>(image)?,
        blob_reference_value()
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rejected_push_marks_outbox_failed() -> Result<()> {
    let scenario = sync_conformance_value(&["conflictKeepLocal"]);
    let path = temp_db_path("syncular-protocol-rejected");
    let store = RusqliteStore::open(&path)?;
    let transport = rejected_push_transport();
    let config = test_config(
        &path,
        scenario["keepServerClientId"]
            .as_str()
            .expect("keep server client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.add_task(
        "Conflict candidate".to_string(),
        Some(
            scenario["rowId"]
                .as_str()
                .expect("conflict row id")
                .to_string(),
        ),
    )?;
    let report = client.sync_http()?;
    assert!(report.changed_tables.is_empty());
    assert!(report.conflicts_changed);

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "failed");
    assert_eq!(outbox[0].schema_version, current_schema_version());

    let conflicts = client.conflict_summaries()?;
    assert_eq!(
        conflicts.len(),
        scenario["expectedInitialConflictCount"]
            .as_u64()
            .expect("expected initial conflict count") as usize
    );
    assert_eq!(conflicts[0].op_index, 0);
    assert_eq!(conflicts[0].result_status, "conflict");
    assert_eq!(
        conflicts[0].code.as_deref(),
        scenario["conflictCode"].as_str()
    );
    assert_eq!(
        conflicts[0].server_version,
        scenario["serverVersion"].as_i64()
    );
    assert_eq!(
        conflicts[0].message,
        scenario["conflictMessage"]
            .as_str()
            .expect("conflict message")
    );
    assert!(conflicts[0].resolved_at.is_none());
    assert!(conflicts[0].resolution.is_none());

    client.resolve_conflict(
        &conflicts[0].id,
        scenario["keepServerResolution"]
            .as_str()
            .expect("keep server resolution"),
    )?;
    assert_eq!(
        client.conflict_summaries()?.len(),
        scenario["expectedAfterResolveConflictCount"]
            .as_u64()
            .expect("expected after resolve conflict count") as usize
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rejected_push_conflict_can_be_dismissed_without_retry() -> Result<()> {
    let scenario = sync_conformance_value(&["conflictKeepLocal"]);
    let path = temp_db_path("syncular-protocol-dismiss-conflict");
    let store = RusqliteStore::open(&path)?;
    let transport = rejected_push_transport();
    let config = test_config(
        &path,
        scenario["dismissClientId"]
            .as_str()
            .expect("dismiss conflict client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.add_task(
        scenario["localTitle"]
            .as_str()
            .expect("conflict local title")
            .to_string(),
        Some(
            scenario["rowId"]
                .as_str()
                .expect("conflict row id")
                .to_string(),
        ),
    )?;
    client.sync_http()?;

    let conflicts = client.conflict_summaries()?;
    assert_eq!(
        conflicts.len(),
        scenario["expectedInitialConflictCount"]
            .as_u64()
            .expect("expected initial conflict count") as usize
    );
    let conflict_id = conflicts[0].id.clone();
    client.resolve_conflict(
        &conflict_id,
        scenario["dismissResolution"]
            .as_str()
            .expect("dismiss resolution"),
    )?;
    assert_eq!(
        client.conflict_summaries()?.len(),
        scenario["expectedAfterResolveConflictCount"]
            .as_u64()
            .expect("expected after resolve conflict count") as usize
    );
    assert_eq!(client.outbox_summaries()?.len(), 1);

    {
        let conn = rusqlite::Connection::open(&path)?;
        let resolution: String = conn.query_row(
            "select resolution from sync_conflicts where id = ?1",
            params![conflict_id],
            |row| row.get(0),
        )?;
        assert_eq!(
            resolution,
            scenario["dismissResolution"]
                .as_str()
                .expect("dismiss resolution")
        );
    }

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn keep_local_conflict_retry_requeues_with_server_base_version() -> Result<()> {
    let scenario = sync_conformance_value(&["conflictKeepLocal"]);
    let path = temp_db_path("syncular-protocol-keep-local");
    let store = RusqliteStore::open(&path)?;
    let transport = rejected_push_transport();
    let config = test_config(
        &path,
        scenario["clientId"].as_str().expect("conflict client id"),
    );
    let mut client = demo_client(config.clone(), store, transport);

    client.add_task(
        scenario["localTitle"]
            .as_str()
            .expect("conflict local title")
            .to_string(),
        Some(
            scenario["rowId"]
                .as_str()
                .expect("conflict row id")
                .to_string(),
        ),
    )?;
    client.sync_http()?;

    let conflicts = client.conflict_summaries()?;
    assert_eq!(
        conflicts.len(),
        scenario["expectedInitialConflictCount"]
            .as_u64()
            .expect("expected initial conflict count") as usize
    );
    let retry_commit_id = client.retry_conflict_keep_local(&conflicts[0].id)?;
    assert!(!retry_commit_id.is_empty());
    assert_eq!(
        client.conflict_summaries()?.len(),
        scenario["expectedAfterRetryConflictCount"]
            .as_u64()
            .expect("expected after retry conflict count") as usize
    );

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 2);
    assert_eq!(outbox[0].status, "failed");
    assert_eq!(outbox[1].status, "pending");

    let retry_store = RusqliteStore::open(&path)?;
    let retry_transport = TestTransport::new();
    let retry_handle = retry_transport.handle();
    let mut retry_client = demo_client(config, retry_store, retry_transport);

    retry_client.sync_http()?;

    let requests = retry_handle.requests();
    let push = requests[0].push.as_ref().expect("retry push request");
    assert_eq!(push.commits.len(), 1);
    let operation = &push.commits[0].operations[0];
    assert_eq!(operation.table, "tasks");
    assert_eq!(
        operation.row_id,
        scenario["rowId"].as_str().expect("conflict row id")
    );
    assert_eq!(
        operation.base_version,
        scenario["retryBaseVersion"].as_i64()
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn duplicate_push_responses_keep_outbox_acked_once() -> Result<()> {
    let scenario = sync_conformance_value(&["duplicatePush"]);
    let path = temp_db_path("syncular-protocol-duplicate-push");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response_fn(|request| {
        let mut response = default_combined_response(request);
        if let Some(push) = response.push.as_mut() {
            push.commits.extend(push.commits.clone());
        }
        Ok(response)
    });
    let config = test_config(
        &path,
        scenario["clientId"]
            .as_str()
            .expect("duplicate push client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.add_task(
        scenario["task"]["title"]
            .as_str()
            .expect("duplicate push task title")
            .to_string(),
        Some(
            scenario["task"]["id"]
                .as_str()
                .expect("duplicate push task id")
                .to_string(),
        ),
    )?;
    client.sync_http()?;

    let requests = handle.requests();
    let push = requests[0].push.as_ref().expect("push request");
    assert_eq!(
        push.commits.len(),
        scenario["expectedFirstPushCommits"]
            .as_u64()
            .expect("expected first push commits") as usize
    );

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(
        outbox[0].status,
        scenario["expectedOutboxStatus"]
            .as_str()
            .expect("expected outbox status")
    );
    assert_eq!(
        client.conflict_summaries()?.len(),
        scenario["expectedConflictCount"]
            .as_u64()
            .expect("expected conflict count") as usize
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn repeated_pull_commits_are_idempotent() -> Result<()> {
    let scenario = sync_conformance_value(&["repeatedPull"]);
    let path = temp_db_path("syncular-protocol-repeated-pull");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    for _ in 0..scenario["expectedPullCount"]
        .as_i64()
        .expect("expected pull count")
    {
        transport.push_http_response(duplicate_pull_commits_response());
    }
    let config = test_config(
        &path,
        scenario["clientId"]
            .as_str()
            .expect("repeated pull client id"),
    );
    let mut client = demo_client(config, store, transport);

    for _ in 0..scenario["expectedPullCount"]
        .as_i64()
        .expect("expected pull count")
    {
        client.sync_http()?;
    }

    let tasks = client.list_tasks()?;
    assert_eq!(
        tasks.len(),
        scenario["expectedRowCount"]
            .as_u64()
            .expect("expected row count") as usize
    );
    assert_eq!(
        tasks[0].id,
        scenario["task"]["id"]
            .as_str()
            .expect("repeated pull task id")
    );
    assert_eq!(
        tasks[0].title,
        scenario["task"]["title"]
            .as_str()
            .expect("repeated pull task title")
    );
    assert_eq!(
        tasks[0].server_version,
        scenario["task"]["serverVersion"]
            .as_i64()
            .expect("repeated pull server version")
    );

    let requests = handle.requests();
    assert_eq!(
        requests.len(),
        scenario["expectedPullCount"]
            .as_u64()
            .expect("expected pull count") as usize
    );
    let second_pull = requests[1].pull.as_ref().expect("second pull request");
    let task_subscription = second_pull
        .subscriptions
        .iter()
        .find(|subscription| subscription.id == "sub-tasks")
        .expect("task subscription request");
    assert_eq!(
        task_subscription.cursor,
        scenario["expectedCursor"]
            .as_i64()
            .expect("repeated pull expected cursor")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn client_id_ownership_conflict_is_reported_from_shared_fixture() -> Result<()> {
    let scenario = sync_conformance_value(&["ownerConflict"]);
    let path = temp_db_path("syncular-protocol-owner-conflict");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response_fn(|_request| {
        Err(SyncularError::message(
            ErrorKind::Transport,
            format!(
                "sync failed with {}: clientId is already bound to a different actor",
                sync_conformance_str(&["ownerConflict", "expectedErrorPattern"])
            ),
        ))
    });
    let mut client = demo_client(
        test_config(
            &path,
            scenario["clientId"]
                .as_str()
                .expect("owner conflict client id"),
        ),
        store,
        transport,
    );

    let error = client.sync_http().expect_err("owner conflict");
    assert_eq!(error.kind(), ErrorKind::Transport);
    assert!(
        error.to_string().contains(
            scenario["expectedErrorPattern"]
                .as_str()
                .expect("owner conflict expected error")
        ),
        "{error}"
    );
    assert_eq!(client.outbox_summaries()?.len(), 0);

    let requests = handle.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].client_id,
        scenario["clientId"]
            .as_str()
            .expect("owner conflict client id")
    );
    assert!(requests[0].push.is_none());
    assert!(requests[0].pull.is_some());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn transport_errors_schedule_outbox_retry_without_immediate_repush() -> Result<()> {
    let scenario = sync_conformance_value(&["retryBackoff"]);
    let path = temp_db_path("syncular-protocol-transport-retry");
    let store = RusqliteStore::open(&path)?;
    let inner = TestTransport::new();
    let handle = inner.handle();
    let transport = FaultTransport::new(
        inner,
        [FaultStep::fail(FaultPhase::After, FaultOperation::AnySync, "network down").repeat(2)],
    );
    let config = test_config(
        &path,
        scenario["clientId"].as_str().expect("retry client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.add_task(
        scenario["localRow"]["title"]
            .as_str()
            .expect("retry task title")
            .to_string(),
        Some(
            scenario["localRow"]["id"]
                .as_str()
                .expect("retry task id")
                .to_string(),
        ),
    )?;
    let before = current_time_ms();
    let error = client.sync_http().expect_err("transport failure");
    assert_eq!(error.kind(), ErrorKind::Transport);

    {
        let conn = rusqlite::Connection::open(&path)?;
        let (status, attempt_count, next_attempt_at): (String, i32, i64) = conn.query_row(
            "select status, attempt_count, next_attempt_at from sync_outbox_commits limit 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(status, "pending");
        assert_eq!(attempt_count, 1);
        assert!(next_attempt_at >= before);
    }

    let error = client.sync_http().expect_err("second transport failure");
    assert_eq!(error.kind(), ErrorKind::Transport);

    let requests = handle.requests();
    assert_eq!(
        requests.len(),
        scenario["expectedSyncPostCounts"][2]
            .as_u64()
            .expect("third retry post count") as usize
    );
    assert!(requests[0].push.is_some());
    assert!(requests[1].push.is_none());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn websocket_push_uses_same_commit_contract() -> Result<()> {
    let path = temp_db_path("syncular-protocol-ws");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    let config = test_config(&path, "client-ws");
    let mut client = demo_client(config, store, transport);

    client.add_task("WS task".to_string(), Some("ws-task".to_string()))?;
    client.sync_ws()?;

    let ws_pushes = handle.ws_pushes();
    assert_eq!(ws_pushes.len(), 1);
    assert_eq!(ws_pushes[0].schema_version, current_schema_version());
    assert_eq!(ws_pushes[0].operations[0].row_id, "ws-task");
    let requests = handle.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].push.is_none());
    assert!(requests[0].pull.is_some());

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox[0].status, "acked");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn bootstrap_continuation_uses_stored_bootstrap_state() -> Result<()> {
    let path = temp_db_path("syncular-protocol-bootstrap");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response(snapshot_page_combined_response(
        "sub-tasks",
        "tasks",
        vec![task_row("bootstrap-1", "Bootstrap page 1", 11)],
        scopes(),
        42,
        true,
        false,
        Some(BootstrapState {
            as_of_commit_seq: 10,
            tables: vec!["tasks".to_string()],
            table_index: 0,
            row_cursor: Some("page-1".to_string()),
        }),
    ));
    transport.push_http_response(snapshot_page_combined_response(
        "sub-tasks",
        "tasks",
        vec![task_row("bootstrap-2", "Bootstrap page 2", 12)],
        scopes(),
        42,
        false,
        true,
        None,
    ));
    let config = test_config(&path, "client-bootstrap");
    let mut client = demo_client(config, store, transport);

    client.sync_http()?;

    let requests = handle.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0]
        .pull
        .as_ref()
        .unwrap()
        .subscriptions
        .iter()
        .find(|subscription| subscription.id == "sub-tasks")
        .expect("initial task subscription")
        .bootstrap_state
        .is_none());

    let second_sub = requests[1]
        .pull
        .as_ref()
        .unwrap()
        .subscriptions
        .iter()
        .find(|subscription| subscription.id == "sub-tasks")
        .expect("continuation task subscription");
    let bootstrap_state = second_sub
        .bootstrap_state
        .as_ref()
        .expect("bootstrap continuation state");
    assert_eq!(bootstrap_state.as_of_commit_seq, 10);
    assert_eq!(bootstrap_state.table_index, 0);
    assert_eq!(bootstrap_state.row_cursor.as_deref(), Some("page-1"));

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0].id, "bootstrap-1");
    assert_eq!(tasks[1].id, "bootstrap-2");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn snapshot_chunk_rows_are_fetched_with_subscription_scopes() -> Result<()> {
    let scenario = sync_conformance_value(&["snapshotChunk"]);
    let path = temp_db_path("syncular-protocol-chunk");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response(snapshot_chunks_combined_response(
        "sub-tasks",
        "tasks",
        vec![SnapshotChunkRef {
            id: scenario["chunkId"]
                .as_str()
                .expect("snapshot chunk id")
                .to_string(),
            byte_length: scenario["byteLength"]
                .as_i64()
                .expect("snapshot chunk byte length")
                .try_into()
                .expect("snapshot chunk byte length"),
            sha256: scenario["sha256"]
                .as_str()
                .expect("snapshot chunk sha256")
                .to_string(),
            encoding: scenario["encoding"]
                .as_str()
                .expect("snapshot chunk encoding")
                .to_string(),
            compression: scenario["compression"]
                .as_str()
                .expect("snapshot chunk compression")
                .to_string(),
        }],
        scopes(),
        42,
    ));
    transport.push_snapshot_chunk_rows(vec![task_row(
        scenario["serverTask"]["id"]
            .as_str()
            .expect("snapshot chunk server task id"),
        scenario["serverTask"]["title"]
            .as_str()
            .expect("snapshot chunk server task title"),
        scenario["serverTask"]["serverVersion"]
            .as_i64()
            .expect("snapshot chunk server version"),
    )]);
    let config = test_config(
        &path,
        scenario["clientId"]
            .as_str()
            .expect("snapshot chunk client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.sync_http()?;

    let chunk_fetches = handle.chunk_fetches();
    assert_eq!(chunk_fetches.len(), 1);
    assert_eq!(
        chunk_fetches[0].chunk.id,
        scenario["chunkId"].as_str().expect("snapshot chunk id")
    );
    assert_eq!(
        chunk_fetches[0]
            .scopes
            .get("project_id")
            .and_then(Value::as_str),
        Some("p0")
    );

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        tasks[0].id,
        scenario["serverTask"]["id"]
            .as_str()
            .expect("snapshot chunk server task id")
    );
    assert_eq!(
        tasks[0].title,
        scenario["serverTask"]["title"]
            .as_str()
            .expect("snapshot chunk server task title")
    );
    assert_eq!(
        tasks[0].server_version,
        scenario["serverTask"]["serverVersion"]
            .as_i64()
            .expect("snapshot chunk server version")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn revoked_subscription_clears_scoped_rows_and_resets_cursor() -> Result<()> {
    let scenario = sync_conformance_value(&["revokedSubscription"]);
    let path = temp_db_path("syncular-protocol-revoked");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response(snapshot_combined_response(
        "sub-tasks",
        "tasks",
        vec![task_row(
            scenario["seedTask"]["id"]
                .as_str()
                .expect("revoked task id"),
            scenario["seedTask"]["title"]
                .as_str()
                .expect("revoked task title"),
            scenario["seedTask"]["serverVersion"]
                .as_i64()
                .expect("revoked server version"),
        )],
        scopes(),
        42,
    ));
    transport.push_http_response(revoked_subscription_response("sub-tasks", scopes(), 42));
    let config = test_config(
        &path,
        scenario["clientId"].as_str().expect("revoked client id"),
    );
    let mut client = demo_client(config, store, transport);

    client.sync_http()?;
    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        tasks[0].id,
        scenario["seedTask"]["id"]
            .as_str()
            .expect("revoked task id")
    );

    client.sync_http()?;
    assert!(client.list_tasks()?.is_empty());

    client.sync_http()?;
    let requests = handle.requests();
    assert_eq!(requests.len(), 3);
    let expected_cursors = scenario["expectedCursorSequence"]
        .as_array()
        .expect("revoked cursor sequence");
    assert_eq!(
        requests[0]
            .pull
            .as_ref()
            .unwrap()
            .subscriptions
            .iter()
            .find(|subscription| subscription.id == "sub-tasks")
            .expect("first task subscription")
            .cursor,
        expected_cursors[0].as_i64().expect("first cursor")
    );
    assert_eq!(
        requests[1]
            .pull
            .as_ref()
            .unwrap()
            .subscriptions
            .iter()
            .find(|subscription| subscription.id == "sub-tasks")
            .expect("second task subscription")
            .cursor,
        expected_cursors[1].as_i64().expect("second cursor")
    );
    assert_eq!(
        requests[2]
            .pull
            .as_ref()
            .unwrap()
            .subscriptions
            .iter()
            .find(|subscription| subscription.id == "sub-tasks")
            .expect("third task subscription")
            .cursor,
        expected_cursors[2].as_i64().expect("third cursor")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn realtime_sync_event_triggers_http_pull() -> Result<()> {
    let scenario = sync_conformance_value(&["realtime"]);
    let path = temp_db_path("syncular-protocol-wakeup");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_realtime_event(RealtimeEvent::Other(sync_conformance_str(&[
        "realtime",
        "presenceEvent",
    ])));
    transport.push_realtime_event(RealtimeEvent::Sync);
    transport.push_http_response(todo_snapshot_response(vec![task_row(
        scenario["task"]["id"].as_str().expect("realtime task id"),
        scenario["task"]["title"]
            .as_str()
            .expect("realtime task title"),
        scenario["task"]["serverVersion"]
            .as_i64()
            .expect("realtime server version"),
    )]));
    let config = test_config(
        &path,
        scenario["clientAId"].as_str().expect("realtime client id"),
    );
    let mut client = demo_client(config, store, transport);

    let mut events = Vec::new();
    let processed = client.process_realtime_events(4, |event| events.push(format!("{event:?}")))?;

    assert_eq!(processed, 2);
    let expected_events = scenario["expectedEventDebug"]
        .as_array()
        .expect("realtime expected events")
        .iter()
        .map(|value| value.as_str().expect("event debug").to_string())
        .collect::<Vec<_>>();
    assert_eq!(events, expected_events);

    let requests = handle.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].push.is_none());
    assert!(requests[0].pull.is_some());

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        tasks[0].id,
        scenario["task"]["id"].as_str().expect("realtime task id")
    );
    assert_eq!(
        tasks[0].title,
        scenario["task"]["title"]
            .as_str()
            .expect("realtime task title")
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn overlapping_sync_for_same_database_is_rejected() -> Result<()> {
    let path = temp_db_path("syncular-protocol-lock");
    let config = test_config(&path, "client-lock");
    let nested_store = RusqliteStore::open(&path)?;
    let nested_client = demo_client(
        config.clone(),
        nested_store,
        MockTransport::new(MockMode::RejectPush),
    );
    let nested = Arc::new(Mutex::new(Some(nested_client)));
    let nested_error = Arc::new(Mutex::new(None));
    let outer_store = RusqliteStore::open(&path)?;
    let transport = ReentrantTransport {
        nested: nested.clone(),
        nested_error: nested_error.clone(),
    };
    let mut client = demo_client(config, outer_store, transport);

    client.sync_http()?;

    assert_eq!(*nested_error.lock().unwrap(), Some(ErrorKind::Busy));
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_coalesces_triggers_while_sync_is_running() -> Result<()> {
    let path = temp_db_path("syncular-worker-coalesce");
    let config = test_config(&path, "client-worker");
    let store = RusqliteStore::open(&path)?;
    let shared = Arc::new(BlockingShared::new());
    let transport = BlockingTransport {
        shared: shared.clone(),
    };
    let client = demo_client(config, store, transport);
    let worker = SyncWorker::start(client);

    worker.trigger_sync()?;
    assert!(shared.wait_until_first_request(Duration::from_secs(2)));

    for _ in 0..5 {
        worker.trigger_sync()?;
    }
    shared.release_first_request();

    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("first sync result")?;
    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("coalesced sync result")?;
    assert!(worker
        .recv_result_timeout(Duration::from_millis(100))
        .is_none());
    assert_eq!(shared.request_count(), 2);

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_event_subscriptions_are_fanout_streams() -> Result<()> {
    let path = temp_db_path("syncular-worker-event-fanout");
    let config = test_config(&path, "client-worker-event-fanout");
    let store = RusqliteStore::open(&path)?;
    let client = demo_client(config, store, TestTransport::new());
    let worker = SyncWorker::start(client);
    let first = worker.subscribe_events(8);
    let second = worker.subscribe_events(8);

    worker.trigger_sync()?;

    let first_event = first
        .next_event_timeout(Duration::from_secs(2))
        .expect("first worker subscriber event");
    let second_event = second
        .next_event_timeout(Duration::from_secs(2))
        .expect("second worker subscriber event");

    assert!(matches!(
        first_event,
        SyncWorkerEvent::SyncCompleted { .. } | SyncWorkerEvent::SyncFailed { .. }
    ));
    assert!(matches!(
        second_event,
        SyncWorkerEvent::SyncCompleted { .. } | SyncWorkerEvent::SyncFailed { .. }
    ));

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_event_subscription_close_wakes_blocked_reader() -> Result<()> {
    let path = temp_db_path("syncular-worker-event-close");
    let config = test_config(&path, "client-worker-event-close");
    let store = RusqliteStore::open(&path)?;
    let client = demo_client(config, store, TestTransport::new());
    let worker = SyncWorker::start(client);
    let subscription = Arc::new(worker.subscribe_events(1));
    let reader = Arc::clone(&subscription);
    let join = std::thread::spawn(move || reader.next_event().is_none());

    std::thread::sleep(Duration::from_millis(25));
    subscription.close();
    assert!(join
        .join()
        .expect("event subscription reader should not panic"));

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_event_subscription_overflow_reports_resync_required() -> Result<()> {
    let path = temp_db_path("syncular-worker-event-overflow");
    let config = test_config(&path, "client-worker-event-overflow");
    let store = RusqliteStore::open(&path)?;
    let client = demo_client(config, store, TestTransport::new());
    let worker = SyncWorker::start(client);
    let slow = worker.subscribe_events(1);
    let control = worker.subscribe_events(8);

    worker.enqueue_mutation_json(
        "overflow-write".to_string(),
        json!({
            "table": "tasks",
            "row_id": "overflow-task",
            "op": "upsert",
            "payload": {
                "title": "Overflow task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
        None,
        true,
    )?;

    let mut saw_sync_result = false;
    for _ in 0..4 {
        match control
            .next_event_timeout(Duration::from_secs(2))
            .expect("control subscriber should keep receiving worker events")
        {
            SyncWorkerEvent::SyncCompleted { .. } | SyncWorkerEvent::SyncFailed { .. } => {
                saw_sync_result = true;
                break;
            }
            _ => {}
        }
    }
    assert!(saw_sync_result);

    let overflow_event = slow
        .next_event_timeout(Duration::from_secs(2))
        .expect("slow subscriber should receive overflow event");
    assert!(matches!(
        overflow_event,
        SyncWorkerEvent::EventsOverflowed { dropped_count } if dropped_count >= 2
    ));
    assert!(slow
        .next_event_timeout(Duration::from_millis(100))
        .is_none());

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_wakes_when_outbox_retry_becomes_due() -> Result<()> {
    let path = temp_db_path("syncular-worker-retry-wakeup");
    let config = test_config(&path, "client-worker-retry-wakeup");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response_fn(|_| {
        Err(SyncularError::message(
            ErrorKind::Transport,
            "test retry wakeup",
        ))
    });
    let client = demo_client(config, store, transport);
    let worker = SyncWorker::start(client);
    let events = worker.subscribe_events(16);

    worker.enqueue_mutation_json(
        "retry-wakeup-write".to_string(),
        json!({
            "table": "tasks",
            "row_id": "retry-wakeup-task",
            "op": "upsert",
            "payload": {
                "title": "Retry wakeup task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
        None,
        true,
    )?;

    let deadline = Instant::now() + Duration::from_secs(4);
    let mut saw_retry_scheduled = false;
    let mut saw_retry_success = false;
    while Instant::now() < deadline {
        let Some(event) = events.next_event_timeout(Duration::from_millis(250)) else {
            continue;
        };
        match event {
            SyncWorkerEvent::SyncFailed {
                retry_scheduled, ..
            } => {
                saw_retry_scheduled = retry_scheduled;
            }
            SyncWorkerEvent::SyncCompleted { .. } => {
                saw_retry_success = true;
                break;
            }
            _ => {}
        }
    }

    assert!(saw_retry_scheduled);
    assert!(saw_retry_success);
    assert_eq!(handle.requests().len(), 2);

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn persistent_realtime_worker_feeds_sync_worker_wakeups() -> Result<()> {
    let path = temp_db_path("syncular-worker-persistent-realtime");
    let config = test_config(&path, "client-worker-persistent-realtime");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    let client = demo_client(config, store, transport.clone());
    let worker = SyncWorker::start(client);
    let mut realtime = PersistentRealtimeWorker::start(transport.clone(), worker.trigger_handle());

    transport.push_realtime_event(RealtimeEvent::Sync);

    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("persistent realtime worker should trigger sync")?;
    assert_eq!(handle.requests().len(), 1);

    realtime.stop()?;
    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_accepts_auth_headers_before_sync() -> Result<()> {
    let scenario = sync_conformance_value(&["workerAuth"]);
    let path = temp_db_path("syncular-worker-auth-headers");
    let config = test_config(
        &path,
        scenario["clientId"]
            .as_str()
            .expect("worker auth client id"),
    );
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    let client = demo_client(config, store, transport);
    let worker = SyncWorker::start(client);
    let mut headers = SyncAuthHeaders::new();
    headers.insert(
        "authorization".to_string(),
        scenario["authorization"]
            .as_str()
            .expect("worker auth header")
            .to_string(),
    );

    worker.set_auth_headers(headers.clone())?;
    worker.trigger_sync()?;
    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("sync result")?;

    assert_eq!(handle.auth_headers(), vec![headers]);

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_stop_waits_for_in_flight_sync() -> Result<()> {
    let path = temp_db_path("syncular-worker-stop");
    let config = test_config(&path, "client-worker-stop");
    let store = RusqliteStore::open(&path)?;
    let shared = Arc::new(BlockingShared::new());
    let transport = BlockingTransport {
        shared: shared.clone(),
    };
    let client = demo_client(config, store, transport);
    let mut worker = SyncWorker::start(client);

    worker.trigger_sync()?;
    assert!(shared.wait_until_first_request(Duration::from_secs(2)));
    worker.request_stop()?;
    assert!(worker
        .recv_result_timeout(Duration::from_millis(100))
        .is_none());

    shared.release_first_request();
    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("in-flight sync result")?;
    worker.join()?;
    assert_eq!(shared.request_count(), 1);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn local_write_during_active_sync_is_queued_for_next_sync() -> Result<()> {
    let path = temp_db_path("syncular-worker-local-write");
    let config = test_config(&path, "client-worker-local-write");
    let store = RusqliteStore::open(&path)?;
    let shared = Arc::new(BlockingShared::new());
    let transport = BlockingTransport {
        shared: shared.clone(),
    };
    let client = demo_client(config.clone(), store, transport);
    let worker = SyncWorker::start(client);

    worker.trigger_sync()?;
    assert!(shared.wait_until_first_request(Duration::from_secs(2)));

    let writer_store = RusqliteStore::open(&path)?;
    let mut writer = demo_client(config, writer_store, TestTransport::new());
    writer.add_task(
        "Written while syncing".to_string(),
        Some("during-sync-task".to_string()),
    )?;

    let outbox = writer.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "pending");

    shared.release_first_request();
    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("first sync result")?;
    assert_eq!(shared.request_count(), 1);

    worker.trigger_sync()?;
    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("second sync result")?;

    let requests = shared.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].push.is_none());
    let push = requests[1].push.as_ref().expect("queued local write push");
    assert_eq!(push.commits.len(), 1);
    assert_eq!(push.commits[0].operations[0].table, "tasks");
    assert_eq!(push.commits[0].operations[0].row_id, "during-sync-task");

    worker.stop()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn invalid_outbox_schema_version_is_rejected_before_sending() -> Result<()> {
    let path = temp_db_path("syncular-protocol-invalid-schema-version");
    let store = RusqliteStore::open(&path)?;
    let config = test_config(&path, "client-invalid-schema-version");
    let operations = serde_json::to_string(&vec![syncular_runtime::protocol::SyncOperation {
        table: "tasks".to_string(),
        row_id: "bad-schema-task".to_string(),
        op: "upsert".to_string(),
        payload: Some(task_row("bad-schema-task", "Bad schema", 0)),
        base_version: None,
    }])?;

    {
        let conn = rusqlite::Connection::open(&path)?;
        conn.execute(
            r#"
            insert into sync_outbox_commits (
                id, client_commit_id, status, operations_json, last_response_json,
                error, created_at, updated_at, attempt_count, acked_commit_seq, schema_version
            ) values (?1, ?2, 'pending', ?3, null, null, 1, 1, 0, null, 0)
            "#,
            params!["bad-schema-row", "bad-schema-commit", operations],
        )?;
    }

    let mut client = demo_client(config, store, TestTransport::new());
    let error = client.sync_http().expect_err("invalid schema version");
    assert_eq!(error.kind(), ErrorKind::Schema);
    assert_eq!(client.outbox_summaries()?[0].status, "pending");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn not_ok_protocol_responses_are_rejected() -> Result<()> {
    for (case, expected_kind) in [
        ("combined", ErrorKind::Protocol),
        ("push", ErrorKind::Protocol),
        ("pull", ErrorKind::Protocol),
    ] {
        let path = temp_db_path("syncular-protocol-not-ok");
        let store = RusqliteStore::open(&path)?;
        let transport = TestTransport::new();
        match case {
            "combined" => transport.push_http_response(combined_not_ok_response()),
            "push" => transport.push_http_response_fn(|request| Ok(push_not_ok_response(request))),
            "pull" => transport.push_http_response(pull_not_ok_response()),
            _ => unreachable!("only not-ok modes are used here"),
        }
        let mut client = demo_client(test_config(&path, "client-not-ok"), store, transport);
        if case == "push" {
            client.add_task("Needs push".to_string(), Some("needs-push".to_string()))?;
        }

        let error = client.sync_http().expect_err("not-ok response");
        assert_eq!(error.kind(), expected_kind);
        let _ = std::fs::remove_file(path);
    }

    Ok(())
}

#[test]
fn malformed_commit_integrity_metadata_is_rejected_before_apply() -> Result<()> {
    let path = temp_db_path("syncular-protocol-invalid-commit-integrity");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let mut response = duplicate_pull_commits_response();
    let subscription = &mut response.pull.as_mut().expect("pull response").subscriptions[0];
    subscription.integrity = Some(SubscriptionIntegrity {
        partition_id: "default".to_string(),
        previous_chain_root: "abc".to_string(),
        commit_chain_root: "b".repeat(64),
        commit_seq: subscription.commits.last().expect("test commit").commit_seq,
    });
    transport.push_http_response(response);
    let mut client = demo_client(
        test_config(&path, "client-invalid-integrity"),
        store,
        transport,
    );

    let error = client.sync_http().expect_err("invalid integrity metadata");
    assert_eq!(error.kind(), ErrorKind::Protocol);
    assert!(client.list_tasks()?.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn canonical_commit_integrity_is_recomputed_and_verified_root_is_persisted() -> Result<()> {
    let path = temp_db_path("syncular-protocol-valid-commit-integrity");
    let change = SyncChange {
        table: "tasks".to_string(),
        row_id: "task-integrity".to_string(),
        op: "upsert".to_string(),
        row_json: Some(task_row("task-integrity", "Verified", 10)),
        row_version: Some(10),
        scopes: scopes(),
    };
    let (commit, integrity) = verified_wire_commit(10, change)?;
    let expected_root = integrity.commit_chain_root.clone();
    let transport = TestTransport::new();
    let mut response = commits_combined_response("sub-tasks", scopes(), 10, vec![commit]);
    response.pull.as_mut().expect("pull").subscriptions[0].integrity = Some(integrity);
    transport.push_http_response(response);
    let store = RusqliteStore::open(&path)?;
    let mut client = demo_client(
        test_config(&path, "client-valid-integrity"),
        store,
        transport,
    );

    client.sync_http()?;
    drop(client);

    let mut store = RusqliteStore::open(&path)?;
    let root = store
        .transaction(|tx| tx.verified_root("default", "sub-tasks"))?
        .expect("persisted verified root");
    assert_eq!(root.partition_id, "default");
    assert_eq!(root.commit_seq, 10);
    assert_eq!(root.root, expected_root);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn canonical_commit_integrity_rejects_tampered_commit_before_apply() -> Result<()> {
    let path = temp_db_path("syncular-protocol-tampered-commit-integrity");
    let change = SyncChange {
        table: "tasks".to_string(),
        row_id: "task-integrity".to_string(),
        op: "upsert".to_string(),
        row_json: Some(task_row("task-integrity", "Verified", 10)),
        row_version: Some(10),
        scopes: scopes(),
    };
    let (mut commit, integrity) = verified_wire_commit(10, change)?;
    commit.changes[0].row_json = Some(task_row("task-integrity", "Tampered", 10));
    let transport = TestTransport::new();
    let mut response = commits_combined_response("sub-tasks", scopes(), 10, vec![commit]);
    response.pull.as_mut().expect("pull").subscriptions[0].integrity = Some(integrity);
    transport.push_http_response(response);
    let store = RusqliteStore::open(&path)?;
    let mut client = demo_client(
        test_config(&path, "client-tampered-integrity"),
        store,
        transport,
    );

    let error = client.sync_http().expect_err("tampered commit");
    assert_eq!(error.kind(), ErrorKind::Protocol);
    assert!(client.list_tasks()?.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn commit_integrity_metadata_validation_rejects_malformed_or_mismatched_roots() {
    let mut pull = integrity_pull_response(
        vec![integrity_commit(41), integrity_commit(42)],
        Some(SubscriptionIntegrity {
            partition_id: "default".to_string(),
            previous_chain_root: "a".repeat(64),
            commit_chain_root: "b".repeat(64),
            commit_seq: 42,
        }),
    );
    validate_pull_commit_integrity_metadata(&pull).expect("complete metadata");

    pull.subscriptions[0]
        .integrity
        .as_mut()
        .expect("integrity")
        .commit_chain_root = "bad".to_string();
    let error = validate_pull_commit_integrity_metadata(&pull).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::Protocol);

    let pull = integrity_pull_response(
        vec![integrity_commit(41), integrity_commit(42)],
        Some(SubscriptionIntegrity {
            partition_id: "default".to_string(),
            previous_chain_root: "a".repeat(64),
            commit_chain_root: "b".repeat(64),
            commit_seq: 41,
        }),
    );
    let error = validate_pull_commit_integrity_metadata(&pull).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::Protocol);
}

#[test]
fn snapshot_manifest_validation_rejects_missing_or_tampered_manifests() -> Result<()> {
    let chunk = SnapshotChunkRef {
        id: "chunk-1".to_string(),
        byte_length: 128,
        sha256: "0".repeat(64),
        encoding: "binary-table-v1".to_string(),
        compression: "gzip".to_string(),
    };
    let manifest = snapshot_manifest_for_test("tasks", &chunk)?;
    let mut pull = snapshot_manifest_pull_response(chunk.clone(), Some(manifest));
    validate_pull_snapshot_manifests(&pull).expect("valid manifest");

    pull.subscriptions[0].snapshots.as_mut().unwrap()[0].manifest = None;
    let error = validate_pull_snapshot_manifests(&pull).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::Protocol);

    let mut tampered_manifest = snapshot_manifest_for_test("tasks", &chunk)?;
    tampered_manifest.chunks[0].sha256 = "1".repeat(64);
    let pull = snapshot_manifest_pull_response(chunk, Some(tampered_manifest));
    let error = validate_pull_snapshot_manifests(&pull).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::Protocol);
    Ok(())
}

#[test]
fn server_required_schema_version_newer_than_client_is_rejected() -> Result<()> {
    let path = temp_db_path("syncular-protocol-server-schema");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    transport.push_http_response(schema_required_response(current_schema_version() + 1));
    let mut client = demo_client(test_config(&path, "client-server-schema"), store, transport);

    let error = client.sync_http().expect_err("future server schema");
    assert_eq!(error.kind(), ErrorKind::Schema);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_required_schema_version_is_checked_on_continuation_rounds() -> Result<()> {
    let path = temp_db_path("syncular-protocol-server-schema-continuation");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response(snapshot_page_combined_response(
        "sub-tasks",
        "tasks",
        vec![task_row("bootstrap-1", "Bootstrap page 1", 11)],
        scopes(),
        42,
        true,
        false,
        Some(BootstrapState {
            as_of_commit_seq: 10,
            tables: vec!["tasks".to_string()],
            table_index: 0,
            row_cursor: Some("page-1".to_string()),
        }),
    ));
    transport.push_http_response(schema_required_response(current_schema_version() + 1));
    let mut client = demo_client(
        test_config(&path, "client-server-schema-continuation"),
        store,
        transport,
    );

    let error = client.sync_http().expect_err("future continuation schema");
    assert_eq!(error.kind(), ErrorKind::Schema);
    assert_eq!(handle.request_count(), 2);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_latest_schema_version_newer_than_client_is_tolerated() -> Result<()> {
    let path = temp_db_path("syncular-protocol-server-latest-schema");
    let store = RusqliteStore::open(&path)?;
    let transport = TestTransport::new();
    transport.push_http_response(schema_latest_response(current_schema_version() + 1));
    let mut client = demo_client(
        test_config(&path, "client-server-latest-schema"),
        store,
        transport,
    );

    let report = client.sync_http()?;
    assert!(report.changed_tables.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum MockMode {
    EncryptedSnapshot,
    EncryptedConflict,
    EncryptedChunkedSnapshot,
    BlobReferenceSnapshot,
    RejectPush,
    WakeupPull,
}

#[derive(Clone)]
struct MockTransport {
    mode: MockMode,
    shared: Arc<Mutex<MockShared>>,
}

#[derive(Default)]
struct MockShared {
    requests: Vec<CombinedRequest>,
    ws_pushes: Vec<syncular_runtime::protocol::PushCommitRequest>,
    chunk_fetches: Vec<(String, Map<String, Value>)>,
    realtime_events: VecDeque<RealtimeEvent>,
    auth_headers: Vec<SyncAuthHeaders>,
}

struct MockRealtime {
    mode: MockMode,
    shared: Arc<Mutex<MockShared>>,
}

#[derive(Clone)]
struct ReentrantTransport {
    nested: Arc<Mutex<Option<SyncularClient<RusqliteStore, MockTransport>>>>,
    nested_error: Arc<Mutex<Option<ErrorKind>>>,
}

#[derive(Clone)]
struct BlockingTransport {
    shared: Arc<BlockingShared>,
}

struct BlockingShared {
    state: Mutex<BlockingState>,
    first_entered: Condvar,
    first_released: Condvar,
}

#[derive(Default)]
struct BlockingState {
    request_count: usize,
    first_request_entered: bool,
    release_first_request: bool,
    requests: Vec<CombinedRequest>,
}

impl BlockingShared {
    fn new() -> Self {
        Self {
            state: Mutex::new(BlockingState::default()),
            first_entered: Condvar::new(),
            first_released: Condvar::new(),
        }
    }

    fn wait_until_first_request(&self, timeout: Duration) -> bool {
        let state = self.state.lock().unwrap();
        let (state, _) = self
            .first_entered
            .wait_timeout_while(state, timeout, |state| !state.first_request_entered)
            .unwrap();
        state.first_request_entered
    }

    fn release_first_request(&self) {
        let mut state = self.state.lock().unwrap();
        state.release_first_request = true;
        self.first_released.notify_all();
    }

    fn request_count(&self) -> usize {
        self.state.lock().unwrap().request_count
    }

    fn requests(&self) -> Vec<CombinedRequest> {
        self.state.lock().unwrap().requests.clone()
    }
}

impl MockTransport {
    fn new(mode: MockMode) -> Self {
        let realtime_events = match mode {
            MockMode::WakeupPull => {
                let mut events = VecDeque::new();
                events.push_back(RealtimeEvent::Other(sync_conformance_str(&[
                    "realtime",
                    "presenceEvent",
                ])));
                events.push_back(RealtimeEvent::Sync);
                events
            }
            _ => VecDeque::new(),
        };
        Self {
            mode,
            shared: Arc::new(Mutex::new(MockShared {
                realtime_events,
                ..MockShared::default()
            })),
        }
    }
}

impl SyncAuthHeaderStore for MockTransport {
    fn set_auth_headers(&mut self, headers: SyncAuthHeaders) {
        self.shared.lock().unwrap().auth_headers.push(headers);
    }
}

impl SyncTransport for MockTransport {
    type Realtime = MockRealtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        {
            let mut shared = self.shared.lock().unwrap();
            shared.requests.push(request.clone());
        }
        let push = request.push.as_ref().map(|push| {
            let commits = push
                .commits
                .iter()
                .map(|commit| push_response_for(self.mode, &commit.client_commit_id))
                .collect::<Vec<_>>();
            PushBatchResponse { ok: true, commits }
        });
        let pull = Some(pull_response_for(self.mode));
        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push,
            pull,
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &Map<String, Value>,
    ) -> Result<SnapshotChunkRows> {
        self.shared
            .lock()
            .unwrap()
            .chunk_fetches
            .push((chunk.id.clone(), scopes.clone()));
        if matches!(self.mode, MockMode::EncryptedChunkedSnapshot) {
            Ok(SnapshotChunkRows::Json(vec![encrypted_task_row()]))
        } else {
            Ok(SnapshotChunkRows::Json(vec![task_row(
                &sync_conformance_str(&["snapshotChunk", "serverTask", "id"]),
                &sync_conformance_str(&["snapshotChunk", "serverTask", "title"]),
                sync_conformance_i64(&["snapshotChunk", "serverTask", "serverVersion"]),
            )]))
        }
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(MockRealtime {
            mode: self.mode,
            shared: self.shared.clone(),
        })
    }
}

impl RealtimeTransport for MockRealtime {
    fn push_commit(
        &mut self,
        commit: syncular_runtime::protocol::PushCommitRequest,
    ) -> Result<PushCommitResponse> {
        let client_commit_id = commit.client_commit_id.clone();
        self.shared.lock().unwrap().ws_pushes.push(commit);
        Ok(push_response_for(self.mode, &client_commit_id))
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        Ok(self.shared.lock().unwrap().realtime_events.pop_front())
    }

    fn close(&mut self) {}
}

impl SyncTransport for ReentrantTransport {
    type Realtime = MockRealtime;

    fn post_sync(&self, _request: &CombinedRequest) -> Result<CombinedResponse> {
        let mut nested = self.nested.lock().unwrap();
        if let Some(client) = nested.as_mut() {
            if let Err(error) = client.sync_http() {
                *self.nested_error.lock().unwrap() = Some(error.kind());
            }
        }

        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push: None,
            pull: Some(PullResponse {
                ok: true,
                subscriptions: Vec::new(),
            }),
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _chunk: &SnapshotChunkRef,
        _scopes: &Map<String, Value>,
    ) -> Result<SnapshotChunkRows> {
        Ok(SnapshotChunkRows::Json(Vec::new()))
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(MockRealtime {
            mode: MockMode::WakeupPull,
            shared: Arc::new(Mutex::new(MockShared::default())),
        })
    }
}

impl SyncAuthHeaderStore for ReentrantTransport {
    fn set_auth_headers(&mut self, _headers: SyncAuthHeaders) {}
}

impl SyncTransport for BlockingTransport {
    type Realtime = MockRealtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let mut state = self.shared.state.lock().unwrap();
        state.requests.push(request.clone());
        state.request_count += 1;
        if state.request_count == 1 {
            state.first_request_entered = true;
            self.shared.first_entered.notify_all();
            state = self
                .shared
                .first_released
                .wait_while(state, |state| !state.release_first_request)
                .unwrap();
        }
        drop(state);

        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push: None,
            pull: Some(PullResponse {
                ok: true,
                subscriptions: Vec::new(),
            }),
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _chunk: &SnapshotChunkRef,
        _scopes: &Map<String, Value>,
    ) -> Result<SnapshotChunkRows> {
        Ok(SnapshotChunkRows::Json(Vec::new()))
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(MockRealtime {
            mode: MockMode::WakeupPull,
            shared: Arc::new(Mutex::new(MockShared::default())),
        })
    }
}

impl SyncAuthHeaderStore for BlockingTransport {
    fn set_auth_headers(&mut self, _headers: SyncAuthHeaders) {}
}

fn push_response_for(mode: MockMode, client_commit_id: &str) -> PushCommitResponse {
    match mode {
        MockMode::RejectPush | MockMode::EncryptedConflict => PushCommitResponse {
            client_commit_id: client_commit_id.to_string(),
            status: "rejected".to_string(),
            commit_seq: None,
            results: vec![OperationResult {
                op_index: 0,
                status: "conflict".to_string(),
                message: Some(sync_conformance_str(&[
                    "conflictKeepLocal",
                    "conflictMessage",
                ])),
                error: None,
                code: Some(sync_conformance_str(&["conflictKeepLocal", "conflictCode"])),
                retriable: Some(false),
                server_version: Some(sync_conformance_i64(&[
                    "conflictKeepLocal",
                    "serverVersion",
                ])),
                server_row: if matches!(mode, MockMode::EncryptedConflict) {
                    Some(encrypted_task_row_for(
                        &sync_conformance_str(&["e2ee", "conflict", "rowId"]),
                        &sync_conformance_str(&["e2ee", "conflict", "serverTitle"]),
                        sync_conformance_i64(&["conflictKeepLocal", "serverVersion"]),
                    ))
                } else {
                    Some(task_row(
                        &sync_conformance_str(&["conflictKeepLocal", "rowId"]),
                        &sync_conformance_str(&["conflictKeepLocal", "serverTitle"]),
                        sync_conformance_i64(&["conflictKeepLocal", "serverVersion"]),
                    ))
                },
            }],
        },
        MockMode::WakeupPull
        | MockMode::EncryptedSnapshot
        | MockMode::EncryptedChunkedSnapshot
        | MockMode::BlobReferenceSnapshot => PushCommitResponse {
            client_commit_id: client_commit_id.to_string(),
            status: "applied".to_string(),
            commit_seq: Some(7),
            results: Vec::new(),
        },
    }
}

fn pull_response_for(mode: MockMode) -> PullResponse {
    let snapshots = match mode {
        MockMode::EncryptedSnapshot => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: vec![encrypted_task_row()],
            chunks: None,
            artifacts: None,
            manifest: None,
            is_first_page: true,
            is_last_page: true,
            bootstrap_state_after: None,
        }]),
        MockMode::BlobReferenceSnapshot => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: vec![blob_reference_task_row()],
            chunks: None,
            artifacts: None,
            manifest: None,
            is_first_page: true,
            is_last_page: true,
            bootstrap_state_after: None,
        }]),
        MockMode::RejectPush | MockMode::EncryptedConflict => None,
        MockMode::EncryptedChunkedSnapshot => {
            let chunk = SnapshotChunkRef {
                id: sync_conformance_str(&["snapshotChunk", "chunkId"]),
                byte_length: sync_conformance_i64(&["snapshotChunk", "byteLength"])
                    .try_into()
                    .expect("snapshot chunk byte length"),
                sha256: sync_conformance_str(&["snapshotChunk", "sha256"]),
                encoding: sync_conformance_str(&["snapshotChunk", "encoding"]),
                compression: sync_conformance_str(&["snapshotChunk", "compression"]),
            };
            Some(vec![SyncSnapshot {
                table: "tasks".to_string(),
                rows: Vec::new(),
                chunks: Some(vec![chunk.clone()]),
                artifacts: None,
                manifest: Some(
                    snapshot_manifest_for_test("tasks", &chunk).expect("snapshot manifest"),
                ),
                is_first_page: true,
                is_last_page: true,
                bootstrap_state_after: None,
            }])
        }
        MockMode::WakeupPull => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: vec![task_row(
                &sync_conformance_str(&["realtime", "task", "id"]),
                &sync_conformance_str(&["realtime", "task", "title"]),
                sync_conformance_i64(&["realtime", "task", "serverVersion"]),
            )],
            chunks: None,
            artifacts: None,
            manifest: None,
            is_first_page: true,
            is_last_page: true,
            bootstrap_state_after: None,
        }]),
    };
    let bootstrap_state = None;
    let commits = Vec::new();

    PullResponse {
        ok: true,
        subscriptions: vec![SubscriptionResponse {
            id: "sub-tasks".to_string(),
            status: "active".to_string(),
            scopes: scopes(),
            bootstrap: snapshots.is_some(),
            bootstrap_state,
            next_cursor: 42,
            integrity: None,
            commits,
            snapshots,
        }],
    }
}

fn task_row(id: &str, title: &str, server_version: i64) -> Value {
    json!({
        "id": id,
        "title": title,
        "completed": 0,
        "user_id": sync_conformance_str(&["actors", "rust", "actorId"]),
        "project_id": sync_conformance_str(&["actors", "rust", "projectId"]),
        "server_version": server_version,
        "image": null,
        "title_yjs_state": null
    })
}

fn blob_reference_task_row() -> Value {
    let scenario = sync_conformance_value(&["blob", "referenceSync"]);
    let row_id = scenario["task"]["id"]
        .as_str()
        .expect("blob reference task id");
    let title = scenario["task"]["title"]
        .as_str()
        .expect("blob reference task title");
    let mut row = task_row(row_id, title, 42);
    row.as_object_mut()
        .expect("blob reference row object")
        .insert("image".to_string(), blob_reference_value());
    row
}

fn blob_reference_value() -> Value {
    sync_conformance_value(&["blob", "referenceSync", "image"])
}

fn encrypted_task_row() -> Value {
    let scenario = sync_conformance_value(&["e2ee"]);
    let row_id = scenario["task"]["id"].as_str().expect("task id");
    let title = scenario["task"]["title"].as_str().expect("task title");
    let server_version = scenario["serverVersion"]
        .as_i64()
        .expect("e2ee server version");
    encrypted_task_row_for(row_id, title, server_version)
}

fn encrypted_task_row_for(row_id: &str, title: &str, server_version: i64) -> Value {
    let operation = syncular_runtime::protocol::SyncOperation {
        table: "tasks".to_string(),
        row_id: row_id.to_string(),
        op: "upsert".to_string(),
        payload: Some(task_row(row_id, title, server_version)),
        base_version: Some(0),
    };
    let mut operations = test_field_encryption()
        .expect("e2ee encryption")
        .transform_operations_for_push(&encryption_context(), vec![operation])
        .expect("encrypt e2ee snapshot row");
    operations
        .pop()
        .and_then(|operation| operation.payload)
        .expect("encrypted operation payload")
}

fn encryption_context() -> FieldEncryptionContext {
    FieldEncryptionContext {
        actor_id: sync_conformance_str(&["actors", "rust", "actorId"]),
        client_id: sync_conformance_str(&["e2ee", "pullClientId"]),
    }
}

fn scopes() -> Map<String, Value> {
    let mut scopes = Map::new();
    scopes.insert(
        "user_id".to_string(),
        json!(sync_conformance_str(&["actors", "rust", "actorId"])),
    );
    scopes.insert(
        "project_id".to_string(),
        json!(sync_conformance_str(&["actors", "rust", "projectId"])),
    );
    scopes
}

fn rejected_push_transport() -> TestTransport {
    let transport = TestTransport::new();
    let message = sync_conformance_str(&["conflictKeepLocal", "conflictMessage"]);
    let code = sync_conformance_str(&["conflictKeepLocal", "conflictCode"]);
    let server_version = sync_conformance_i64(&["conflictKeepLocal", "serverVersion"]);
    let server_row = task_row(
        &sync_conformance_str(&["conflictKeepLocal", "rowId"]),
        &sync_conformance_str(&["conflictKeepLocal", "serverTitle"]),
        server_version,
    );
    transport.push_http_response_fn(move |request| {
        Ok(push_conflict_response(
            request,
            &message,
            &code,
            server_row.clone(),
            server_version,
        ))
    });
    transport
}

fn duplicate_pull_commits_response() -> CombinedResponse {
    let change = SyncChange {
        table: "tasks".to_string(),
        row_id: sync_conformance_str(&["repeatedPull", "task", "id"]),
        op: "upsert".to_string(),
        row_json: Some(task_row(
            &sync_conformance_str(&["repeatedPull", "task", "id"]),
            &sync_conformance_str(&["repeatedPull", "task", "title"]),
            sync_conformance_i64(&["repeatedPull", "task", "serverVersion"]),
        )),
        row_version: Some(sync_conformance_i64(&[
            "repeatedPull",
            "task",
            "serverVersion",
        ])),
        scopes: scopes(),
    };
    commits_combined_response(
        "sub-tasks",
        scopes(),
        sync_conformance_i64(&["repeatedPull", "expectedCursor"]),
        vec![
            SyncCommit {
                commit_seq: 90,
                created_at: "2026-05-08T00:00:00.000Z".to_string(),
                actor_id: "server".to_string(),
                changes: vec![change.clone()],
            },
            SyncCommit {
                commit_seq: 90,
                created_at: "2026-05-08T00:00:00.000Z".to_string(),
                actor_id: "server".to_string(),
                changes: vec![change],
            },
        ],
    )
}

fn integrity_pull_response(
    commits: Vec<SyncCommit>,
    integrity: Option<SubscriptionIntegrity>,
) -> PullResponse {
    PullResponse {
        ok: true,
        subscriptions: vec![SubscriptionResponse {
            id: "sub-tasks".to_string(),
            status: "active".to_string(),
            scopes: scopes(),
            bootstrap: false,
            bootstrap_state: None,
            next_cursor: commits
                .last()
                .map(|commit| commit.commit_seq)
                .unwrap_or_default(),
            integrity,
            commits,
            snapshots: None,
        }],
    }
}

fn integrity_commit(commit_seq: i64) -> SyncCommit {
    SyncCommit {
        commit_seq,
        created_at: "2026-05-19T00:00:00.000Z".to_string(),
        actor_id: "server".to_string(),
        changes: Vec::new(),
    }
}

fn verified_wire_commit(
    commit_seq: i64,
    change: SyncChange,
) -> Result<(SyncCommit, SubscriptionIntegrity)> {
    let commit = SyncCommit {
        commit_seq,
        created_at: "2026-05-19T00:00:00.000Z".to_string(),
        actor_id: "server".to_string(),
        changes: vec![change],
    };
    let commit_digest = wire_commit_digest("default", "sub-tasks", &commit)?;
    let commit_chain_root = wire_commit_chain_root(
        "default",
        "sub-tasks",
        COMMIT_INTEGRITY_GENESIS_ROOT,
        commit_seq,
        &commit_digest,
    )?;
    Ok((
        commit,
        SubscriptionIntegrity {
            partition_id: "default".to_string(),
            previous_chain_root: COMMIT_INTEGRITY_GENESIS_ROOT.to_string(),
            commit_chain_root,
            commit_seq,
        },
    ))
}

fn snapshot_manifest_pull_response(
    chunk: SnapshotChunkRef,
    manifest: Option<SnapshotManifest>,
) -> PullResponse {
    PullResponse {
        ok: true,
        subscriptions: vec![SubscriptionResponse {
            id: "sub-tasks".to_string(),
            status: "active".to_string(),
            scopes: scopes(),
            bootstrap: true,
            bootstrap_state: None,
            next_cursor: 42,
            integrity: None,
            commits: Vec::new(),
            snapshots: Some(vec![SyncSnapshot {
                table: "tasks".to_string(),
                rows: Vec::new(),
                chunks: Some(vec![chunk]),
                manifest,
                is_first_page: true,
                is_last_page: true,
                bootstrap_state_after: None,
            }]),
        }],
    }
}

fn snapshot_manifest_for_test(table: &str, chunk: &SnapshotChunkRef) -> Result<SnapshotManifest> {
    let mut manifest = SnapshotManifest {
        version: 1,
        digest: String::new(),
        table: table.to_string(),
        as_of_commit_seq: 42,
        scope_digest: "c".repeat(64),
        row_cursor: None,
        row_limit: 1000,
        next_row_cursor: None,
        is_first_page: true,
        is_last_page: true,
        chunks: vec![SnapshotManifestChunkRef {
            id: chunk.id.clone(),
            byte_length: chunk.byte_length,
            sha256: chunk.sha256.clone(),
            encoding: chunk.encoding.clone(),
            compression: chunk.compression.clone(),
        }],
    };
    manifest.digest = snapshot_manifest_digest(&manifest)?;
    Ok(manifest)
}

fn test_field_encryption() -> Result<FieldEncryption> {
    let scenario = sync_conformance_value(&["e2ee"]);
    let rule = &scenario["rule"];
    let mut keys = std::collections::BTreeMap::new();
    keys.insert(
        "default".to_string(),
        scenario["keyBase64"]
            .as_str()
            .expect("e2ee key")
            .to_string(),
    );
    FieldEncryption::from_static_config(StaticFieldEncryptionConfig {
        rules: vec![FieldEncryptionRule {
            scope: rule["scope"].as_str().expect("e2ee scope").to_string(),
            table: Some(rule["table"].as_str().expect("e2ee table").to_string()),
            fields: rule["fields"]
                .as_array()
                .expect("e2ee fields")
                .iter()
                .map(|value| value.as_str().expect("e2ee field").to_string())
                .collect(),
            row_id_field: None,
        }],
        keys,
        encryption_kid: None,
        decryption_error_mode: None,
        envelope_prefix: Some(
            scenario["envelopePrefix"]
                .as_str()
                .expect("e2ee envelope prefix")
                .to_string(),
        ),
    })
}

fn demo_client<S, T>(config: SyncularClientConfig, store: S, transport: T) -> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport,
{
    SyncularClient::with_app_schema_parts(config, store, transport, demo_todo_app_schema())
}

fn test_config(path: &str, client_id: &str) -> SyncularClientConfig {
    SyncularClientConfig {
        db_path: path.to_string(),
        base_url: "http://syncular.test/sync".to_string(),
        client_id: client_id.to_string(),
        actor_id: sync_conformance_str(&["actors", "rust", "actorId"]),
        project_id: Some(sync_conformance_str(&["actors", "rust", "projectId"])),
    }
}

fn sync_conformance() -> Value {
    serde_json::from_str(include_str!(
        "../../../examples/todo-app/conformance/sync-scenarios.json"
    ))
    .expect("sync conformance JSON")
}

fn sync_conformance_str(path: &[&str]) -> String {
    sync_conformance_value(path)
        .as_str()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be a string"))
        .to_string()
}

fn sync_conformance_i64(path: &[&str]) -> i64 {
    sync_conformance_value(path)
        .as_i64()
        .unwrap_or_else(|| panic!("sync conformance path {path:?} must be an integer"))
}

fn sync_conformance_value(path: &[&str]) -> Value {
    let mut value = sync_conformance();
    for segment in path {
        value = value
            .get(segment)
            .unwrap_or_else(|| panic!("missing sync conformance path {path:?}"))
            .clone();
    }
    value
}

fn temp_db_path(prefix: &str) -> String {
    unique_temp_db_path(prefix)
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
