use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rusqlite::params;
use serde_json::{json, Map, Value};
use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::encryption::{
    FieldEncryption, FieldEncryptionRule, StaticFieldEncryptionConfig,
};
use syncular_runtime::error::{ErrorKind, Result, SyncularError};
use syncular_runtime::migrations::current_schema_version;
use syncular_runtime::protocol::{
    BootstrapState, CombinedRequest, CombinedResponse, OperationResult, PullResponse,
    PushBatchResponse, PushCommitResponse, SnapshotChunkRef, SubscriptionResponse, SyncChange,
    SyncCommit, SyncSnapshot,
};
use syncular_runtime::rusqlite_sqlite::RusqliteStore;
use syncular_runtime::transport::{
    RealtimeEvent, RealtimeTransport, SyncAuthHeaderStore, SyncAuthHeaders, SyncTransport,
};
use syncular_runtime::worker::SyncWorker;
use uuid::Uuid;

#[test]
fn http_sync_sends_schema_version_and_applies_snapshot() -> Result<()> {
    let path = temp_db_path("syncular-protocol-applied");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::ApplyAndSnapshot);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-http-applied");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.add_task(
        "Local before sync".to_string(),
        Some("local-task".to_string()),
    )?;
    let report = client.sync_http()?;
    assert_eq!(report.changed_tables, vec!["tasks".to_string()]);

    let requests = shared.lock().unwrap().requests.clone();
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
    let path = temp_db_path("syncular-protocol-encrypted-push");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::ApplyAndSnapshot);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-http-encrypted-push");
    let mut client = SyncularClient::with_parts(config, store, transport);
    client.set_field_encryption(Some(test_field_encryption()?));

    client.add_task("Local secret".to_string(), Some("local-secret".to_string()))?;
    client.sync_http()?;

    let requests = shared.lock().unwrap().requests.clone();
    let operation = &requests[0].push.as_ref().expect("push").commits[0].operations[0];
    let title = operation
        .payload
        .as_ref()
        .and_then(|payload| payload.get("title"))
        .and_then(Value::as_str)
        .expect("encrypted title");
    assert!(title.starts_with("dgsync:e2ee:1:"));
    assert_ne!(title, "Local secret");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rejected_push_marks_outbox_failed() -> Result<()> {
    let path = temp_db_path("syncular-protocol-rejected");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::RejectPush);
    let config = test_config(&path, "client-http-rejected");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.add_task(
        "Conflict candidate".to_string(),
        Some("conflict-task".to_string()),
    )?;
    let report = client.sync_http()?;
    assert!(report.changed_tables.is_empty());
    assert!(report.conflicts_changed);

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "failed");
    assert_eq!(outbox[0].schema_version, current_schema_version());

    let conflicts = client.conflict_summaries()?;
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].op_index, 0);
    assert_eq!(conflicts[0].result_status, "conflict");
    assert_eq!(conflicts[0].code.as_deref(), Some("VERSION_CONFLICT"));
    assert_eq!(conflicts[0].server_version, Some(9));
    assert_eq!(conflicts[0].message, "version conflict");
    assert!(conflicts[0].resolved_at.is_none());
    assert!(conflicts[0].resolution.is_none());

    client.resolve_conflict(&conflicts[0].id, "keep-server")?;
    assert!(client.conflict_summaries()?.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn keep_local_conflict_retry_requeues_with_server_base_version() -> Result<()> {
    let path = temp_db_path("syncular-protocol-keep-local");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::RejectPush);
    let config = test_config(&path, "client-keep-local");
    let mut client = SyncularClient::with_parts(config.clone(), store, transport);

    client.add_task(
        "Local winner".to_string(),
        Some("conflict-task".to_string()),
    )?;
    client.sync_http()?;

    let conflicts = client.conflict_summaries()?;
    assert_eq!(conflicts.len(), 1);
    let retry_commit_id = client.retry_conflict_keep_local(&conflicts[0].id)?;
    assert!(!retry_commit_id.is_empty());
    assert!(client.conflict_summaries()?.is_empty());

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 2);
    assert_eq!(outbox[0].status, "failed");
    assert_eq!(outbox[1].status, "pending");

    let retry_store = RusqliteStore::open(&path)?;
    let retry_transport = MockTransport::new(MockMode::ApplyAndSnapshot);
    let shared = retry_transport.shared.clone();
    let mut retry_client = SyncularClient::with_parts(config, retry_store, retry_transport);

    retry_client.sync_http()?;

    let requests = shared.lock().unwrap().requests.clone();
    let push = requests[0].push.as_ref().expect("retry push request");
    assert_eq!(push.commits.len(), 1);
    let operation = &push.commits[0].operations[0];
    assert_eq!(operation.table, "tasks");
    assert_eq!(operation.row_id, "conflict-task");
    assert_eq!(operation.base_version, Some(9));

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn duplicate_push_responses_keep_outbox_acked_once() -> Result<()> {
    let path = temp_db_path("syncular-protocol-duplicate-push");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::DuplicatePushResponses);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-duplicate-push");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.add_task(
        "Duplicate push ack".to_string(),
        Some("duplicate-push-task".to_string()),
    )?;
    client.sync_http()?;

    let requests = shared.lock().unwrap().requests.clone();
    let push = requests[0].push.as_ref().expect("push request");
    assert_eq!(push.commits.len(), 1);

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "acked");
    assert!(client.conflict_summaries()?.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn repeated_pull_commits_are_idempotent() -> Result<()> {
    let path = temp_db_path("syncular-protocol-repeated-pull");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::DuplicatePullCommits);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-repeated-pull");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.sync_http()?;
    client.sync_http()?;

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "duplicate-pull-task");
    assert_eq!(tasks[0].title, "Repeated pull commit");
    assert_eq!(tasks[0].server_version, 91);

    let requests = shared.lock().unwrap().requests.clone();
    assert_eq!(requests.len(), 2);
    let second_pull = requests[1].pull.as_ref().expect("second pull request");
    let task_subscription = second_pull
        .subscriptions
        .iter()
        .find(|subscription| subscription.id == "sub-tasks")
        .expect("task subscription request");
    assert_eq!(task_subscription.cursor, 90);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn transport_errors_schedule_outbox_retry_without_immediate_repush() -> Result<()> {
    let path = temp_db_path("syncular-protocol-transport-retry");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::TransportError);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-transport-retry");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.add_task(
        "Retry after transport failure".to_string(),
        Some("transport-retry-task".to_string()),
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

    let requests = shared.lock().unwrap().requests.clone();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].push.is_some());
    assert!(requests[1].push.is_none());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn websocket_push_uses_same_commit_contract() -> Result<()> {
    let path = temp_db_path("syncular-protocol-ws");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::ApplyAndSnapshot);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-ws");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.add_task("WS task".to_string(), Some("ws-task".to_string()))?;
    client.sync_ws()?;

    let shared = shared.lock().unwrap();
    assert_eq!(shared.ws_pushes.len(), 1);
    assert_eq!(shared.ws_pushes[0].schema_version, current_schema_version());
    assert_eq!(shared.ws_pushes[0].operations[0].row_id, "ws-task");
    assert_eq!(shared.requests.len(), 1);
    assert!(shared.requests[0].push.is_none());
    assert!(shared.requests[0].pull.is_some());

    drop(shared);
    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox[0].status, "acked");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn bootstrap_continuation_uses_stored_bootstrap_state() -> Result<()> {
    let path = temp_db_path("syncular-protocol-bootstrap");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::BootstrapPages);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-bootstrap");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.sync_http()?;

    let requests = shared.lock().unwrap().requests.clone();
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
    let path = temp_db_path("syncular-protocol-chunk");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::ChunkedSnapshot);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-chunk");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.sync_http()?;

    let shared = shared.lock().unwrap();
    assert_eq!(shared.chunk_fetches.len(), 1);
    assert_eq!(shared.chunk_fetches[0].0, "chunk-1");
    assert_eq!(
        shared.chunk_fetches[0]
            .1
            .get("project_id")
            .and_then(Value::as_str),
        Some("p0")
    );
    drop(shared);

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "chunk-task");
    assert_eq!(tasks[0].title, "Chunk task");
    assert_eq!(tasks[0].server_version, 77);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn revoked_subscription_clears_scoped_rows_and_resets_cursor() -> Result<()> {
    let path = temp_db_path("syncular-protocol-revoked");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::ActiveThenRevoked);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-revoked");
    let mut client = SyncularClient::with_parts(config, store, transport);

    client.sync_http()?;
    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "revoked-task");

    client.sync_http()?;
    assert!(client.list_tasks()?.is_empty());

    client.sync_http()?;
    let requests = shared.lock().unwrap().requests.clone();
    assert_eq!(requests.len(), 3);
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
        -1
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
        42
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
        -1
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn realtime_sync_event_triggers_http_pull() -> Result<()> {
    let path = temp_db_path("syncular-protocol-wakeup");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::WakeupPull);
    let shared = transport.shared.clone();
    let config = test_config(&path, "client-wakeup");
    let mut client = SyncularClient::with_parts(config, store, transport);

    let mut events = Vec::new();
    let processed = client.process_realtime_events(4, |event| events.push(format!("{event:?}")))?;

    assert_eq!(processed, 2);
    assert_eq!(events, vec!["Other(\"presence\")", "Sync"]);

    let requests = shared.lock().unwrap().requests.clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].push.is_none());
    assert!(requests[0].pull.is_some());

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "wakeup-task");
    assert_eq!(tasks[0].title, "Wakeup task");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn overlapping_sync_for_same_database_is_rejected() -> Result<()> {
    let path = temp_db_path("syncular-protocol-lock");
    let config = test_config(&path, "client-lock");
    let nested_store = RusqliteStore::open(&path)?;
    let nested_client = SyncularClient::with_parts(
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
    let mut client = SyncularClient::with_parts(config, outer_store, transport);

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
    let client = SyncularClient::with_parts(config, store, transport);
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
fn sync_worker_accepts_auth_headers_before_sync() -> Result<()> {
    let path = temp_db_path("syncular-worker-auth-headers");
    let config = test_config(&path, "client-worker-auth");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::WakeupPull);
    let shared = transport.shared.clone();
    let client = SyncularClient::with_parts(config, store, transport);
    let worker = SyncWorker::start(client);
    let mut headers = SyncAuthHeaders::new();
    headers.insert(
        "authorization".to_string(),
        "Bearer worker-token".to_string(),
    );

    worker.set_auth_headers(headers.clone())?;
    worker.trigger_sync()?;
    worker
        .recv_result_timeout(Duration::from_secs(2))
        .expect("sync result")?;

    assert_eq!(shared.lock().unwrap().auth_headers, vec![headers]);

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
    let client = SyncularClient::with_parts(config, store, transport);
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
    let client = SyncularClient::with_parts(config.clone(), store, transport);
    let worker = SyncWorker::start(client);

    worker.trigger_sync()?;
    assert!(shared.wait_until_first_request(Duration::from_secs(2)));

    let writer_store = RusqliteStore::open(&path)?;
    let mut writer = SyncularClient::with_parts(
        config,
        writer_store,
        MockTransport::new(MockMode::ApplyAndSnapshot),
    );
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

    let mut client = SyncularClient::with_parts(
        config,
        store,
        MockTransport::new(MockMode::ApplyAndSnapshot),
    );
    let error = client.sync_http().expect_err("invalid schema version");
    assert_eq!(error.kind(), ErrorKind::Schema);
    assert_eq!(client.outbox_summaries()?[0].status, "pending");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn not_ok_protocol_responses_are_rejected() -> Result<()> {
    for (mode, expected_kind) in [
        (MockMode::CombinedNotOk, ErrorKind::Protocol),
        (MockMode::PushNotOk, ErrorKind::Protocol),
        (MockMode::PullNotOk, ErrorKind::Protocol),
    ] {
        let path = temp_db_path("syncular-protocol-not-ok");
        let store = RusqliteStore::open(&path)?;
        let mut client = SyncularClient::with_parts(
            test_config(&path, "client-not-ok"),
            store,
            MockTransport::new(mode),
        );
        if matches!(mode, MockMode::PushNotOk) {
            client.add_task("Needs push".to_string(), Some("needs-push".to_string()))?;
        }

        let error = client.sync_http().expect_err("not-ok response");
        assert_eq!(error.kind(), expected_kind);
        let _ = std::fs::remove_file(path);
    }

    Ok(())
}

#[test]
fn server_required_schema_version_newer_than_client_is_rejected() -> Result<()> {
    let path = temp_db_path("syncular-protocol-server-schema");
    let store = RusqliteStore::open(&path)?;
    let mut client = SyncularClient::with_parts(
        test_config(&path, "client-server-schema"),
        store,
        MockTransport::new(MockMode::RequiresFutureSchema),
    );

    let error = client.sync_http().expect_err("future server schema");
    assert_eq!(error.kind(), ErrorKind::Schema);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_required_schema_version_is_checked_on_continuation_rounds() -> Result<()> {
    let path = temp_db_path("syncular-protocol-server-schema-continuation");
    let store = RusqliteStore::open(&path)?;
    let transport = MockTransport::new(MockMode::RequiresFutureSchemaOnContinuation);
    let shared = transport.shared.clone();
    let mut client = SyncularClient::with_parts(
        test_config(&path, "client-server-schema-continuation"),
        store,
        transport,
    );

    let error = client.sync_http().expect_err("future continuation schema");
    assert_eq!(error.kind(), ErrorKind::Schema);
    assert_eq!(shared.lock().unwrap().requests.len(), 2);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_latest_schema_version_newer_than_client_is_tolerated() -> Result<()> {
    let path = temp_db_path("syncular-protocol-server-latest-schema");
    let store = RusqliteStore::open(&path)?;
    let mut client = SyncularClient::with_parts(
        test_config(&path, "client-server-latest-schema"),
        store,
        MockTransport::new(MockMode::ReportsNewerLatestSchema),
    );

    let report = client.sync_http()?;
    assert!(report.changed_tables.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum MockMode {
    ApplyAndSnapshot,
    RejectPush,
    BootstrapPages,
    ChunkedSnapshot,
    ActiveThenRevoked,
    WakeupPull,
    CombinedNotOk,
    PushNotOk,
    PullNotOk,
    RequiresFutureSchema,
    RequiresFutureSchemaOnContinuation,
    ReportsNewerLatestSchema,
    DuplicatePushResponses,
    DuplicatePullCommits,
    TransportError,
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
                events.push_back(RealtimeEvent::Other("presence".to_string()));
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
        if matches!(self.mode, MockMode::CombinedNotOk) {
            return Ok(CombinedResponse {
                ok: false,
                required_schema_version: None,
                latest_schema_version: None,
                push: None,
                pull: None,
            });
        }

        let round = {
            let mut shared = self.shared.lock().unwrap();
            shared.requests.push(request.clone());
            shared.requests.len()
        };
        if matches!(self.mode, MockMode::TransportError) {
            return Err(SyncularError::message(ErrorKind::Transport, "network down"));
        }
        let push = if matches!(self.mode, MockMode::PushNotOk) {
            request.push.as_ref().map(|_| PushBatchResponse {
                ok: false,
                commits: Vec::new(),
            })
        } else {
            request.push.as_ref().map(|push| {
                let mut commits = push
                    .commits
                    .iter()
                    .map(|commit| push_response_for(self.mode, &commit.client_commit_id))
                    .collect::<Vec<_>>();
                if matches!(self.mode, MockMode::DuplicatePushResponses) {
                    commits.extend(commits.clone());
                }
                PushBatchResponse { ok: true, commits }
            })
        };
        let pull = if matches!(self.mode, MockMode::PullNotOk) {
            Some(PullResponse {
                ok: false,
                subscriptions: Vec::new(),
            })
        } else {
            Some(pull_response_for(self.mode, round))
        };
        Ok(CombinedResponse {
            ok: true,
            required_schema_version: if matches!(self.mode, MockMode::RequiresFutureSchema)
                || (matches!(self.mode, MockMode::RequiresFutureSchemaOnContinuation) && round > 1)
            {
                Some(current_schema_version() + 1)
            } else {
                None
            },
            latest_schema_version: if matches!(self.mode, MockMode::ReportsNewerLatestSchema) {
                Some(current_schema_version() + 1)
            } else {
                None
            },
            push,
            pull,
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        chunk: &SnapshotChunkRef,
        scopes: &Map<String, Value>,
    ) -> Result<Vec<Value>> {
        self.shared
            .lock()
            .unwrap()
            .chunk_fetches
            .push((chunk.id.clone(), scopes.clone()));
        Ok(vec![task_row("chunk-task", "Chunk task", 77)])
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
    ) -> Result<Vec<Value>> {
        Ok(Vec::new())
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
    ) -> Result<Vec<Value>> {
        Ok(Vec::new())
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
        MockMode::ApplyAndSnapshot => PushCommitResponse {
            client_commit_id: client_commit_id.to_string(),
            status: "applied".to_string(),
            commit_seq: Some(7),
            results: vec![OperationResult {
                op_index: 0,
                status: "applied".to_string(),
                message: None,
                error: None,
                code: None,
                retriable: None,
                server_version: Some(7),
                server_row: None,
            }],
        },
        MockMode::RejectPush => PushCommitResponse {
            client_commit_id: client_commit_id.to_string(),
            status: "rejected".to_string(),
            commit_seq: None,
            results: vec![OperationResult {
                op_index: 0,
                status: "conflict".to_string(),
                message: Some("version conflict".to_string()),
                error: None,
                code: Some("VERSION_CONFLICT".to_string()),
                retriable: Some(false),
                server_version: Some(9),
                server_row: Some(task_row("conflict-task", "Server winner", 9)),
            }],
        },
        MockMode::BootstrapPages
        | MockMode::ChunkedSnapshot
        | MockMode::ActiveThenRevoked
        | MockMode::WakeupPull
        | MockMode::CombinedNotOk
        | MockMode::PushNotOk
        | MockMode::PullNotOk
        | MockMode::RequiresFutureSchema
        | MockMode::RequiresFutureSchemaOnContinuation
        | MockMode::ReportsNewerLatestSchema
        | MockMode::DuplicatePushResponses
        | MockMode::DuplicatePullCommits
        | MockMode::TransportError => PushCommitResponse {
            client_commit_id: client_commit_id.to_string(),
            status: "applied".to_string(),
            commit_seq: Some(7),
            results: Vec::new(),
        },
    }
}

fn pull_response_for(mode: MockMode, round: usize) -> PullResponse {
    let status = match mode {
        MockMode::ActiveThenRevoked if round >= 2 => "revoked",
        _ => "active",
    };
    let snapshots = match mode {
        MockMode::ApplyAndSnapshot => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: vec![task_row("remote-task", "Remote snapshot", 42)],
            chunks: None,
            is_first_page: true,
            is_last_page: true,
        }]),
        MockMode::RejectPush => None,
        MockMode::BootstrapPages | MockMode::RequiresFutureSchemaOnContinuation if round == 1 => {
            Some(vec![SyncSnapshot {
                table: "tasks".to_string(),
                rows: vec![task_row("bootstrap-1", "Bootstrap page 1", 11)],
                chunks: None,
                is_first_page: true,
                is_last_page: false,
            }])
        }
        MockMode::BootstrapPages | MockMode::RequiresFutureSchemaOnContinuation => {
            Some(vec![SyncSnapshot {
                table: "tasks".to_string(),
                rows: vec![task_row("bootstrap-2", "Bootstrap page 2", 12)],
                chunks: None,
                is_first_page: false,
                is_last_page: true,
            }])
        }
        MockMode::ChunkedSnapshot => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: Vec::new(),
            chunks: Some(vec![SnapshotChunkRef {
                id: "chunk-1".to_string(),
                byte_length: 100,
                sha256: "unused-in-mock".to_string(),
                encoding: "srf1".to_string(),
                compression: "gzip".to_string(),
            }]),
            is_first_page: true,
            is_last_page: true,
        }]),
        MockMode::ActiveThenRevoked if round == 1 => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: vec![task_row("revoked-task", "Revoked task", 42)],
            chunks: None,
            is_first_page: true,
            is_last_page: true,
        }]),
        MockMode::ActiveThenRevoked => None,
        MockMode::WakeupPull => Some(vec![SyncSnapshot {
            table: "tasks".to_string(),
            rows: vec![task_row("wakeup-task", "Wakeup task", 88)],
            chunks: None,
            is_first_page: true,
            is_last_page: true,
        }]),
        MockMode::DuplicatePullCommits => None,
        MockMode::CombinedNotOk
        | MockMode::PushNotOk
        | MockMode::PullNotOk
        | MockMode::RequiresFutureSchema
        | MockMode::ReportsNewerLatestSchema
        | MockMode::DuplicatePushResponses
        | MockMode::TransportError => None,
    };
    let bootstrap_state = match mode {
        MockMode::BootstrapPages | MockMode::RequiresFutureSchemaOnContinuation if round == 1 => {
            Some(BootstrapState {
                as_of_commit_seq: 10,
                tables: vec!["tasks".to_string()],
                table_index: 0,
                row_cursor: Some("page-1".to_string()),
            })
        }
        _ => None,
    };
    let commits = match mode {
        MockMode::DuplicatePullCommits => {
            let change = SyncChange {
                table: "tasks".to_string(),
                row_id: "duplicate-pull-task".to_string(),
                op: "upsert".to_string(),
                row_json: Some(task_row("duplicate-pull-task", "Repeated pull commit", 91)),
                row_version: Some(91),
                scopes: scopes(),
            };
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
            ]
        }
        _ => Vec::new(),
    };

    PullResponse {
        ok: true,
        subscriptions: vec![SubscriptionResponse {
            id: "sub-tasks".to_string(),
            status: status.to_string(),
            scopes: scopes(),
            bootstrap: snapshots.is_some(),
            bootstrap_state,
            next_cursor: if matches!(mode, MockMode::DuplicatePullCommits) {
                90
            } else {
                42
            },
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
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": server_version,
        "image": null,
        "title_yjs_state": null
    })
}

fn scopes() -> Map<String, Value> {
    let mut scopes = Map::new();
    scopes.insert("user_id".to_string(), json!("user-rust"));
    scopes.insert("project_id".to_string(), json!("p0"));
    scopes
}

fn test_field_encryption() -> Result<FieldEncryption> {
    let mut keys = std::collections::BTreeMap::new();
    keys.insert(
        "default".to_string(),
        "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".to_string(),
    );
    FieldEncryption::from_static_config(StaticFieldEncryptionConfig {
        rules: vec![FieldEncryptionRule {
            scope: "tasks".to_string(),
            table: Some("tasks".to_string()),
            fields: vec!["title".to_string()],
            row_id_field: None,
        }],
        keys,
        encryption_kid: None,
        decryption_error_mode: None,
        envelope_prefix: None,
    })
}

fn test_config(path: &str, client_id: &str) -> SyncularClientConfig {
    SyncularClientConfig {
        db_path: path.to_string(),
        base_url: "http://syncular.test/sync".to_string(),
        client_id: client_id.to_string(),
        actor_id: "user-rust".to_string(),
        project_id: Some("p0".to_string()),
    }
}

fn temp_db_path(prefix: &str) -> String {
    std::env::temp_dir()
        .join(format!("{prefix}-{}.sqlite", Uuid::new_v4()))
        .to_string_lossy()
        .into_owned()
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
