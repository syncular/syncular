use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use serde_json::{json, Value};
use syncular_runtime::crdt_yjs::{build_yjs_text_update, BuildYjsTextUpdateArgs};
use syncular_runtime::error::{ErrorKind, Result};
use syncular_runtime::native::{
    NativeClientConfig, NativeClientOptions, NativeEventKind, NativeSyncularClient,
};
use uuid::Uuid;

#[test]
fn native_facade_auto_triggers_sync_after_local_write() -> Result<()> {
    let path = temp_db_path("syncular-native-auto-trigger");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-auto-trigger"),
        NativeClientOptions {
            auto_sync_local_writes: true,
        },
    )?;

    apply_task_upsert(&mut client, "native-write-task", "Native write")?;

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("local rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);
    assert_eq!(
        event.diagnostic.as_ref().map(|item| item.code.as_str()),
        Some("storage.rows_changed")
    );

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncFailed);
    assert_eq!(
        event.diagnostic.as_ref().map(|item| item.code.as_str()),
        Some("sync.failed")
    );
    assert_eq!(
        event.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::Transport)
    );
    let error = event.error.as_ref().expect("sync failure error");
    assert!(error.message.len() > 10);
    assert!(error
        .debug
        .as_deref()
        .unwrap_or_default()
        .starts_with("Transport: "));
    assert!(client.outbox_summaries()?.len() == 1);

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_can_disable_auto_sync_after_local_write() -> Result<()> {
    let path = temp_db_path("syncular-native-manual-trigger");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-manual-trigger"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "native-manual-task", "Manual native write")?;

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "native-manual-task");
    assert_eq!(tasks_json[0]["title"], "Manual native write");

    let app_tables_json: Value = serde_json::from_str(&client.app_tables_json()?)?;
    assert_eq!(app_tables_json.as_array().map(Vec::len), Some(3));
    assert_eq!(app_tables_json[0], "comments");
    assert_eq!(app_tables_json[1], "projects");
    assert_eq!(app_tables_json[2], "tasks");

    let metadata_json: Value = serde_json::from_str(&client.app_table_metadata_json()?)?;
    assert_eq!(metadata_json.as_array().map(Vec::len), Some(3));
    assert_eq!(metadata_json[0]["name"], "comments");
    assert_eq!(metadata_json[0]["primary_key_column"], "id");
    assert_eq!(metadata_json[0]["server_version_column"], "server_version");
    assert_eq!(metadata_json[0]["subscription_id"], "sub-comments");
    assert_eq!(metadata_json[0]["scopes"][0]["source"], "ActorId");
    assert_eq!(metadata_json[1]["name"], "projects");
    assert_eq!(metadata_json[1]["subscription_id"], "sub-projects");
    assert_eq!(metadata_json[2]["name"], "tasks");
    assert_eq!(metadata_json[2]["subscription_id"], "sub-tasks");

    let generic_tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(generic_tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(generic_tasks_json[0]["id"], "native-manual-task");

    let query_result: Value = serde_json::from_str(
        &client.query_json(
            &json!({
                "sql": "select id, title from tasks where id = ?",
                "params": ["native-manual-task"],
                "tables": ["tasks"]
            })
            .to_string(),
        )?,
    )?;
    assert_eq!(query_result["rows"].as_array().map(Vec::len), Some(1));
    assert_eq!(query_result["rows"][0]["id"], "native-manual-task");
    assert_eq!(query_result["rows"][0]["title"], "Manual native write");

    let error = client
        .query_json(
            &json!({
                "sql": "update tasks set title = ? where id = ?",
                "params": ["Blocked", "native-manual-task"],
                "tables": ["tasks"]
            })
            .to_string(),
        )
        .expect_err("queryJson should reject mutating SQL");
    assert_eq!(error.kind(), ErrorKind::Config);
    assert!(error
        .message_text()
        .contains("queryJson only allows read-only SELECT statements"));

    let error = client
        .query_json(
            &json!({
                "sql": "select id from sync_outbox_commits",
                "tables": ["tasks"]
            })
            .to_string(),
        )
        .expect_err("queryJson should reject internal tables");
    assert_eq!(error.kind(), ErrorKind::Config);
    assert!(error
        .message_text()
        .contains("denied table: sync_outbox_commits"));

    let error = client
        .query_json(
            &json!({
                "sql": "select id from tasks",
                "tables": []
            })
            .to_string(),
        )
        .expect_err("queryJson should require declared table dependencies");
    assert_eq!(error.kind(), ErrorKind::Config);
    assert!(error.message_text().contains("denied table: tasks"));

    let error = client
        .list_table_json("sync_outbox_commits")
        .expect_err("internal table should not be exposed");
    assert_eq!(error.kind(), ErrorKind::Config);

    let outbox_json: Value = serde_json::from_str(&client.outbox_summaries_json()?)?;
    assert_eq!(outbox_json.as_array().map(Vec::len), Some(1));
    assert_eq!(outbox_json[0]["status"], "pending");

    let local_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("local rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(local_event.tables, vec!["tasks".to_string()]);

    assert!(client
        .poll_event_timeout(Duration::from_millis(100))
        .is_none());

    client.trigger_sync()?;
    let event_json = client
        .poll_event_json_timeout(Duration::from_secs(5))
        .expect("manual sync result event");
    let event_json: Value = serde_json::from_str(&event_json?)?;
    assert_eq!(event_json["kind"], "SyncFailed");
    assert_eq!(event_json["error"]["kind"], "Transport");
    assert!(event_json["error"]["message"].as_str().unwrap().len() > 10);
    assert!(event_json["error"]["debug"]
        .as_str()
        .unwrap()
        .starts_with("Transport: "));

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_emits_auth_expired_event_for_sync_401() -> Result<()> {
    let path = temp_db_path("syncular-native-auth-expired");
    let mut config = test_config(&path, "native-auth-expired");
    config.base_url = spawn_status_sync_server(401, "Unauthorized", "expired token")?;
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.trigger_sync()?;

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("auth expired event");
    assert_eq!(event.kind, NativeEventKind::AuthExpired);
    assert_eq!(
        event.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::Transport)
    );
    assert!(event
        .error
        .as_ref()
        .map(|error| error.message.contains("HTTP 401"))
        .unwrap_or(false));
    let auth = event.auth.as_ref().expect("auth event info");
    assert_eq!(auth.operation, "sync");
    assert_eq!(auth.status, 401);

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_applies_dynamic_auth_headers_to_worker_sync() -> Result<()> {
    let path = temp_db_path("syncular-native-auth-headers");
    let mut config = test_config(&path, "native-auth-headers");
    config.base_url = spawn_auth_header_sync_server("authorization", "Bearer native-test")?;
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.set_auth_headers_json(
        &json!({
            "authorization": "Bearer native-test"
        })
        .to_string(),
    )?;
    client.trigger_sync()?;

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("auth header sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert!(event.error.is_none());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_successful_empty_sync_emits_completion_only() -> Result<()> {
    let path = temp_db_path("syncular-native-success-sync");
    let mut config = test_config(&path, "native-success-sync");
    config.base_url = spawn_empty_success_sync_server()?;
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.trigger_sync()?;

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("successful sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert!(event.error.is_none());
    assert!(event.tables.is_empty());
    assert!(client
        .poll_event_timeout(Duration::from_millis(100))
        .is_none());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_successful_pull_emits_completion_then_rows_and_queries_changed() -> Result<()> {
    let path = temp_db_path("syncular-native-pull-sync");
    let mut config = test_config(&path, "native-pull-sync");
    config.base_url = spawn_sync_server(json!({
        "ok": true,
        "push": null,
        "pull": {
            "ok": true,
            "subscriptions": [{
                "id": "sub-tasks",
                "status": "active",
                "scopes": {
                    "user_id": "user-rust",
                    "project_id": "p0"
                },
                "bootstrap": false,
                "bootstrapState": null,
                "nextCursor": 1,
                "commits": [],
                "snapshots": [{
                    "table": "tasks",
                    "rows": [{
                        "id": "server-task",
                        "title": "Server task",
                        "completed": 0,
                        "user_id": "user-rust",
                        "project_id": "p0",
                        "server_version": 1
                    }],
                    "chunks": null,
                    "isFirstPage": true,
                    "isLastPage": true
                }]
            }]
        }
    }))?;
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;
    client.register_query_json(
        &json!({
            "id": "task-list",
            "tables": ["tasks"]
        })
        .to_string(),
    )?;

    client.trigger_sync()?;

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("successful sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert_eq!(event.tables, vec!["tasks".to_string()]);

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("post-sync rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("post-sync queries changed event");
    assert_eq!(event.kind, NativeEventKind::QueriesChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);
    assert_eq!(event.queries, vec!["task-list".to_string()]);

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "server-task");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_rejected_push_emits_conflicts_changed() -> Result<()> {
    let path = temp_db_path("syncular-native-push-conflict");
    let mut config = test_config(&path, "native-push-conflict");
    config.base_url = spawn_rejecting_push_server()?;
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "native-conflict-task", "Conflict candidate")?;
    let local_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("local rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);

    client.trigger_sync()?;

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("conflict sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert!(event.tables.is_empty());

    let event = client
        .poll_event_timeout(Duration::from_secs(5))
        .expect("conflicts changed event");
    assert_eq!(event.kind, NativeEventKind::ConflictsChanged);
    assert!(event.tables.is_empty());

    let conflicts = client.conflict_summaries()?;
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].result_status, "conflict");
    assert_eq!(conflicts[0].code.as_deref(), Some("VERSION_CONFLICT"));

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_applies_generic_local_operation_json() -> Result<()> {
    let path = temp_db_path("syncular-native-generic-operation");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-generic-operation"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    let operation = json!({
        "table": "tasks",
        "row_id": "generic-task",
        "op": "upsert",
        "payload": {
            "title": "Generic task",
            "completed": 0,
            "user_id": "user-rust",
            "project_id": "p0"
        },
        "base_version": 0
    })
    .to_string();
    let commit_id = client.apply_local_operation_json(&operation, None)?;
    assert!(!commit_id.is_empty());

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "generic-task");
    assert_eq!(tasks_json[0]["title"], "Generic task");

    let local_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("generic operation rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(local_event.tables, vec!["tasks".to_string()]);

    let delete = json!({
        "table": "tasks",
        "row_id": "generic-task",
        "op": "delete",
        "payload": null,
        "base_version": 0
    })
    .to_string();
    client.apply_local_operation_json(&delete, None)?;
    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(0));

    let error = client
        .apply_local_operation_json(
            &json!({
                "table": "sync_outbox_commits",
                "row_id": "x",
                "op": "upsert",
                "payload": {},
                "base_version": 0
            })
            .to_string(),
            None,
        )
        .expect_err("internal table should not be mutable");
    assert_eq!(error.kind(), ErrorKind::Config);

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_local_operation_on_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-operation");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-enqueue-operation"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    let operation = json!({
        "table": "tasks",
        "row_id": "queued-task",
        "op": "upsert",
        "payload": {
            "title": "Queued task",
            "completed": 0,
            "user_id": "user-rust",
            "project_id": "p0"
        },
        "base_version": 0
    })
    .to_string();
    let command_id = client.enqueue_local_operation_json(&operation, None)?;
    assert!(command_id.starts_with("native-local-write-"));

    let committed = client
        .poll_event_timeout(Duration::from_secs(2))
        .expect("queued local write committed event");
    assert_eq!(committed.kind, NativeEventKind::LocalWriteCommitted);
    assert_eq!(committed.command_id.as_deref(), Some(command_id.as_str()));
    assert_eq!(committed.tables, vec!["tasks".to_string()]);
    assert!(committed.client_commit_id.is_some());
    assert!(committed.event_seq > 0);

    let rows = client
        .poll_event_timeout(Duration::from_secs(2))
        .expect("queued local rows changed event");
    assert_eq!(rows.kind, NativeEventKind::RowsChanged);
    assert_eq!(rows.tables, vec!["tasks".to_string()]);
    assert!(rows.event_seq > committed.event_seq);

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "queued-task");
    assert_eq!(tasks_json[0]["title"], "Queued task");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_coalesces_enqueued_yjs_updates_on_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-yjs");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-enqueue-yjs"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "queued-yjs-task", "")?;
    let _ = client.poll_event_timeout(Duration::from_millis(100));

    let first = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Queued".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("queued-yjs-1".to_string()),
    })?;
    let second = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: Some(first.next_state_base64.clone()),
        next_text: "Queued Yjs".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("queued-yjs-2".to_string()),
    })?;

    let first_command = client.enqueue_yjs_update_json(
        &json!({
            "table": "tasks",
            "rowId": "queued-yjs-task",
            "field": "title",
            "update": first.update
        })
        .to_string(),
    )?;
    let second_command = client.enqueue_yjs_update_json(
        &json!({
            "table": "tasks",
            "rowId": "queued-yjs-task",
            "field": "title",
            "update": second.update
        })
        .to_string(),
    )?;

    let mut first_commit_id = None;
    let mut second_commit_id = None;
    let mut saw_rows_changed = false;
    for _ in 0..6 {
        let event = client
            .poll_event_timeout(Duration::from_secs(2))
            .expect("Yjs worker event");
        match event.kind {
            NativeEventKind::LocalWriteCommitted
                if event.command_id.as_deref() == Some(first_command.as_str()) =>
            {
                first_commit_id = event.client_commit_id;
            }
            NativeEventKind::LocalWriteCommitted
                if event.command_id.as_deref() == Some(second_command.as_str()) =>
            {
                second_commit_id = event.client_commit_id;
            }
            NativeEventKind::RowsChanged if event.tables == vec!["tasks".to_string()] => {
                saw_rows_changed = true;
            }
            _ => {}
        }
        if first_commit_id.is_some() && second_commit_id.is_some() && saw_rows_changed {
            break;
        }
    }
    assert_eq!(first_commit_id, second_commit_id);
    assert!(saw_rows_changed);

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["title"], "Queued Yjs");
    assert!(tasks_json[0]["title_yjs_state"].as_str().is_some());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_snapshot_refresh_on_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-snapshot");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-enqueue-snapshot"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "snapshot-task", "Snapshot task")?;
    let _ = client.poll_event_timeout(Duration::from_millis(100));

    let command_id = client.enqueue_refresh_snapshot_json(
        &json!({
            "sql": "select id, title from tasks where id = ?",
            "params": ["snapshot-task"],
            "tables": ["tasks"]
        })
        .to_string(),
    )?;
    let event = client
        .poll_event_timeout(Duration::from_secs(2))
        .expect("snapshot ready event");
    assert_eq!(event.kind, NativeEventKind::SnapshotReady);
    assert_eq!(event.command_id.as_deref(), Some(command_id.as_str()));
    assert_eq!(
        event
            .payload_json
            .as_ref()
            .and_then(|payload| { payload["rows"][0]["title"].as_str() }),
        Some("Snapshot task")
    );

    client.close()?;
    let _ = fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_compaction_and_blob_cache_work_on_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-heavy");
    let input_path = temp_db_path("syncular-native-enqueue-heavy-input");
    let output_path = temp_db_path("syncular-native-enqueue-heavy-output");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-enqueue-heavy"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;
    fs::write(&input_path, b"queued blob").map_err(syncular_runtime::error::SyncularError::from)?;

    let store_command = client.enqueue_store_blob_file_json(
        &input_path,
        Some(
            &json!({
                "mimeType": "application/test",
                "immediate": false,
                "cacheLocal": true
            })
            .to_string(),
        ),
    )?;
    let store_event = client
        .poll_event_timeout(Duration::from_secs(2))
        .expect("queued store blob event");
    assert_eq!(store_event.kind, NativeEventKind::WorkerCommandCompleted);
    assert_eq!(
        store_event.command_id.as_deref(),
        Some(store_command.as_str())
    );
    let blob_ref = store_event.payload_json.as_ref().expect("blob ref payload");
    assert_eq!(blob_ref["mimeType"], "application/test");

    let retrieve_command =
        client.enqueue_retrieve_blob_file_json(&blob_ref.to_string(), &output_path, None)?;
    let retrieve_event = client
        .poll_event_timeout(Duration::from_secs(2))
        .expect("queued retrieve blob event");
    assert_eq!(
        retrieve_event.command_id.as_deref(),
        Some(retrieve_command.as_str())
    );
    assert_eq!(fs::read(&output_path).unwrap(), b"queued blob");

    let compact_command = client.enqueue_compact_storage_json(None)?;
    let compact_event = client
        .poll_event_timeout(Duration::from_secs(2))
        .expect("queued compaction event");
    assert_eq!(compact_event.kind, NativeEventKind::WorkerCommandCompleted);
    assert_eq!(
        compact_event.command_id.as_deref(),
        Some(compact_command.as_str())
    );
    assert!(compact_event.payload_json.is_some());

    client.close()?;
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(input_path);
    let _ = fs::remove_file(output_path);
    Ok(())
}

#[test]
fn native_facade_emits_query_observer_events_for_changed_tables() -> Result<()> {
    let path = temp_db_path("syncular-native-query-observer");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-query-observer"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    let query_id = client.register_query_json(
        &json!({
            "id": "task-list",
            "tables": ["tasks"],
            "label": "Task list"
        })
        .to_string(),
    )?;
    assert_eq!(query_id, "task-list");
    client.register_query_json(
        &json!({
            "id": "project-list",
            "tables": ["projects"]
        })
        .to_string(),
    )?;
    let observed: Value = serde_json::from_str(&client.observed_queries_json()?)?;
    assert_eq!(observed.as_array().map(Vec::len), Some(2));
    assert_eq!(observed[0]["id"], "project-list");
    assert_eq!(observed[1]["id"], "task-list");
    assert_eq!(observed[1]["tables"][0], "tasks");

    let operation = json!({
        "table": "tasks",
        "row_id": "query-observer-task",
        "op": "upsert",
        "payload": {
            "title": "Observed task",
            "completed": 0,
            "user_id": "user-rust",
            "project_id": "p0"
        },
        "base_version": 0
    })
    .to_string();
    client.apply_local_operation_json(&operation, None)?;

    let rows_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("rows changed event");
    assert_eq!(rows_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(rows_event.tables, vec!["tasks".to_string()]);
    assert!(rows_event.queries.is_empty());

    let query_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("queries changed event");
    assert_eq!(query_event.kind, NativeEventKind::QueriesChanged);
    assert_eq!(query_event.tables, vec!["tasks".to_string()]);
    assert_eq!(query_event.queries, vec!["task-list".to_string()]);

    client.unregister_query("task-list")?;
    client.apply_local_operation_json(
        &json!({
            "table": "tasks",
            "row_id": "query-observer-task",
            "op": "delete",
            "payload": null,
            "base_version": 0
        })
        .to_string(),
        None,
    )?;

    let rows_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("rows changed event after unregister");
    assert_eq!(rows_event.kind, NativeEventKind::RowsChanged);
    assert!(client
        .poll_event_timeout(Duration::from_millis(100))
        .is_none());

    let error = client
        .register_query_json(
            &json!({
                "id": "internal-table",
                "tables": ["sync_outbox_commits"]
            })
            .to_string(),
        )
        .expect_err("internal table should not be observable");
    assert_eq!(error.kind(), ErrorKind::Config);

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_replaces_duplicate_query_observer_dependencies() -> Result<()> {
    let path = temp_db_path("syncular-native-query-observer-replace");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-query-observer-replace"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.register_query_json(
        &json!({
            "id": "live-list",
            "tables": ["projects"],
            "label": "Initial project dependency"
        })
        .to_string(),
    )?;
    client.register_query_json(
        &json!({
            "id": "live-list",
            "tables": ["tasks"],
            "label": "Replacement task dependency"
        })
        .to_string(),
    )?;

    let observed: Value = serde_json::from_str(&client.observed_queries_json()?)?;
    assert_eq!(observed.as_array().map(Vec::len), Some(1));
    assert_eq!(observed[0]["id"], "live-list");
    assert_eq!(observed[0]["tables"], json!(["tasks"]));
    assert_eq!(observed[0]["label"], "Replacement task dependency");

    apply_task_upsert(&mut client, "query-replace-task", "Replacement task")?;
    let event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("task rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    let event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("task queries changed event");
    assert_eq!(event.kind, NativeEventKind::QueriesChanged);
    assert_eq!(event.queries, vec!["live-list".to_string()]);

    apply_project_upsert(&mut client, "query-replace-project", "Ignored project")?;
    let event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("project rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["projects".to_string()]);
    assert!(client
        .poll_event_timeout(Duration::from_millis(100))
        .is_none());

    client.unregister_query("live-list")?;
    client.unregister_query("live-list")?;
    client.apply_local_operation_json(
        &json!({
            "table": "tasks",
            "row_id": "query-replace-task",
            "op": "delete",
            "payload": null,
            "base_version": 0
        })
        .to_string(),
        None,
    )?;
    let event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("task rows changed after duplicate unregister");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert!(client
        .poll_event_timeout(Duration::from_millis(100))
        .is_none());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_reports_closed_worker_as_structured_error() -> Result<()> {
    let path = temp_db_path("syncular-native-closed");
    let mut client = NativeSyncularClient::open_native(test_config(&path, "native-closed"))?;

    client.close()?;
    let error = client.trigger_sync().expect_err("closed client error");
    assert_eq!(error.kind(), ErrorKind::Internal);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_can_pause_and_resume_background_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-worker-lifecycle");
    let mut client = NativeSyncularClient::open_native_with_options(
        test_config(&path, "native-worker-lifecycle"),
        NativeClientOptions {
            auto_sync_local_writes: true,
        },
    )?;

    assert!(client.sync_worker_running());
    client.pause_sync_worker()?;
    assert!(!client.sync_worker_running());
    client.pause_sync_worker()?;
    assert!(!client.sync_worker_running());

    apply_task_upsert(&mut client, "paused-worker-task", "Queued while paused")?;
    let local_event = client
        .poll_event_timeout(Duration::from_millis(100))
        .expect("local rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert!(client
        .poll_event_timeout(Duration::from_millis(100))
        .is_none());

    let error = client
        .trigger_sync()
        .expect_err("paused worker should reject manual trigger");
    assert_eq!(error.kind(), ErrorKind::Internal);

    client.resume_sync_worker()?;
    assert!(client.sync_worker_running());
    client.resume_sync_worker()?;
    assert!(client.sync_worker_running());
    client.trigger_sync()?;

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

fn apply_task_upsert(
    client: &mut NativeSyncularClient,
    task_id: &str,
    title: &str,
) -> Result<String> {
    client.apply_local_operation_json(
        &json!({
            "table": "tasks",
            "row_id": task_id,
            "op": "upsert",
            "payload": {
                "title": title,
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
        None,
    )
}

fn apply_project_upsert(
    client: &mut NativeSyncularClient,
    project_id: &str,
    name: &str,
) -> Result<String> {
    client.apply_local_operation_json(
        &json!({
            "table": "projects",
            "row_id": project_id,
            "op": "upsert",
            "payload": {
                "name": name,
                "owner_id": "user-rust"
            },
            "base_version": 0
        })
        .to_string(),
        None,
    )
}

fn test_config(path: &str, client_id: &str) -> NativeClientConfig {
    NativeClientConfig {
        db_path: path.to_string(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
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

fn spawn_empty_success_sync_server() -> Result<String> {
    spawn_sync_server(json!({
        "ok": true,
        "push": null,
        "pull": {
            "ok": true,
            "subscriptions": []
        }
    }))
}

fn spawn_rejecting_push_server() -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let request = read_http_request(&mut stream);
            let client_commit_id = request
                .get("push")
                .and_then(|push| push.get("commits"))
                .and_then(Value::as_array)
                .and_then(|commits| commits.first())
                .and_then(|commit| commit.get("clientCommitId"))
                .and_then(Value::as_str)
                .unwrap_or("missing-client-commit");

            let body = json!({
                "ok": true,
                "push": {
                    "ok": true,
                    "commits": [{
                        "clientCommitId": client_commit_id,
                        "status": "rejected",
                        "commitSeq": null,
                        "results": [{
                            "opIndex": 0,
                            "status": "conflict",
                            "message": "version conflict",
                            "error": null,
                            "code": "VERSION_CONFLICT",
                            "retriable": false,
                            "server_version": 9,
                            "server_row": {
                                "id": "native-conflict-task",
                                "title": "Server winner",
                                "completed": 0,
                                "user_id": "user-rust",
                                "project_id": "p0",
                                "server_version": 9
                            }
                        }]
                    }]
                },
                "pull": {
                    "ok": true,
                    "subscriptions": []
                }
            });
            write_http_json_response(&mut stream, body);
        }
    });
    Ok(format!("http://{addr}/sync"))
}

fn spawn_auth_header_sync_server(
    header_name: &'static str,
    header_value: &'static str,
) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let request = read_http_request_raw(&mut stream);
            if request_header(&request, header_name).as_deref() == Some(header_value) {
                write_http_json_response(
                    &mut stream,
                    json!({
                        "ok": true,
                        "push": null,
                        "pull": {
                            "ok": true,
                            "subscriptions": []
                        }
                    }),
                );
            } else {
                write_http_status_response(&mut stream, 401, "Unauthorized", "missing auth header");
            }
        }
    });
    Ok(format!("http://{addr}/sync"))
}

fn spawn_sync_server(body: Value) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = read_http_request(&mut stream);
            write_http_json_response(&mut stream, body);
        }
    });
    Ok(format!("http://{addr}/sync"))
}

fn spawn_status_sync_server(
    status: u16,
    reason: &'static str,
    body: &'static str,
) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = read_http_request(&mut stream);
            write_http_status_response(&mut stream, status, reason, body);
        }
    });
    Ok(format!("http://{addr}/sync"))
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Value {
    let request = read_http_request_raw(stream);
    let Some((_, body)) = request.split_once("\r\n\r\n") else {
        return Value::Null;
    };
    serde_json::from_str(body).unwrap_or(Value::Null)
}

fn read_http_request_raw(stream: &mut std::net::TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = [0; 8192];
    let Ok(n) = stream.read(&mut buffer) else {
        return String::new();
    };
    String::from_utf8_lossy(&buffer[..n]).into_owned()
}

fn request_header(request: &str, name: &str) -> Option<String> {
    request.lines().skip(1).find_map(|line| {
        if line.is_empty() {
            return None;
        }
        let (header_name, header_value) = line.split_once(':')?;
        if header_name.eq_ignore_ascii_case(name) {
            Some(header_value.trim().to_string())
        } else {
            None
        }
    })
}

fn write_http_json_response(stream: &mut std::net::TcpStream, body: Value) {
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn write_http_status_response(
    stream: &mut std::net::TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}
