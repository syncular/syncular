use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use diesel::prelude::*;
use diesel::sql_query;
use serde_json::{json, Value};
use syncular_runtime::client::{BootstrapStatus, SyncChangedCrdtField, SyncChangedRow, SyncReport};
use syncular_runtime::crdt_yjs::{build_yjs_text_update, BuildYjsTextUpdateArgs};
use syncular_runtime::error::{ErrorKind, Result, SyncularError, FULL_SNAPSHOT_RESYNC_REQUIRED};
use syncular_runtime::fixtures::todo::app_schema as demo_todo_app_schema;
use syncular_runtime::native::{
    native_event_json_from_worker_event, native_events_from_worker_event_with_observed_queries,
    NativeClientConfig, NativeClientOptions, NativeEventKind, NativeLifecyclePhase,
    NativeObservedQuery, NativeSyncularClient, NativeWorkerEventConverter,
};
use syncular_runtime::worker::SyncWorkerEvent;
use syncular_testkit::{
    todo_app_schema_json, unique_temp_db_path, TestHttpResponse, TestSyncServer,
};

#[test]
fn native_facade_auto_triggers_sync_after_local_write() -> Result<()> {
    let path = temp_db_path("syncular-native-auto-trigger");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-auto-trigger"),
        NativeClientOptions {
            auto_sync_local_writes: true,
        },
    )?;

    apply_task_upsert(&mut client, "native-write-task", "Native write")?;

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("local rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);
    assert_eq!(
        event.diagnostic.as_ref().map(|item| item.code.as_str()),
        Some("storage.rows_changed")
    );

    let event = client
        .next_event_timeout(Duration::from_secs(5))
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
    let mut client = open_demo_native_with_options(
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
    assert_eq!(metadata_json[0]["scopes"][0]["source"], "actorId");
    assert_eq!(metadata_json[1]["name"], "projects");
    assert_eq!(metadata_json[1]["subscription_id"], "sub-projects");
    assert_eq!(metadata_json[2]["name"], "tasks");
    assert_eq!(metadata_json[2]["subscription_id"], "sub-tasks");

    let schema_state: Value = serde_json::from_str(&client.app_schema_state_json()?)?;
    assert_eq!(schema_state["schemaId"], "syncular-app");
    assert_eq!(schema_state["schemaVersion"], 7);
    assert_eq!(schema_state["currentSchemaVersion"], 7);
    assert!(schema_state["updatedAt"].as_i64().is_some());

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
        .next_event_timeout(Duration::from_millis(100))
        .expect("local rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(local_event.tables, vec!["tasks".to_string()]);

    assert!(client
        .next_event_timeout(Duration::from_millis(100))
        .is_none());

    client.trigger_sync()?;
    let event_json = client
        .next_event_json_timeout(Duration::from_secs(5))
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
fn native_facade_lifecycle_aliases_control_realtime_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-lifecycle-aliases");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-lifecycle-aliases"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.start()?;
    client.start()?;
    client.stop()?;
    client.stop()?;
    client.shutdown()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_builder_starts_realtime_by_default() -> Result<()> {
    let path = temp_db_path("syncular-native-builder-realtime");
    let mut client = NativeSyncularClient::builder(test_config(&path, "native-builder-realtime"))
        .auto_sync_local_writes(false)
        .open()?;

    client.stop()?;
    client.shutdown()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_presence_handle_leaves_on_drop() -> Result<()> {
    let path = temp_db_path("syncular-native-presence-handle");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-presence-handle"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    {
        let mut presence =
            client.join_presence_handle("user:presence", Some(json!({ "view": "a" })))?;
        presence.update_metadata(json!({ "view": "b" }))?;
    }

    let entries: Value = serde_json::from_str(&client.presence_json("user:presence")?)?;
    assert_eq!(entries.as_array().map(Vec::len), Some(0));
    client.shutdown()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_emits_auth_expired_event_for_sync_401() -> Result<()> {
    let path = temp_db_path("syncular-native-auth-expired");
    let mut config = test_config(&path, "native-auth-expired");
    let server = TestSyncServer::status(401, "Unauthorized", "expired token")?;
    config.base_url = server.url();
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.trigger_sync()?;

    let event = client
        .next_event_timeout(Duration::from_secs(5))
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
    let server = TestSyncServer::empty_success()?;
    config.base_url = server.url();
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
        .next_event_timeout(Duration::from_secs(5))
        .expect("auth header sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert!(event.error.is_none());
    let requests = server.wait_for_requests(1, Duration::from_secs(1));
    assert_eq!(
        requests
            .first()
            .and_then(|request| request.header("authorization")),
        Some("Bearer native-test")
    );

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_successful_empty_sync_emits_completion_only() -> Result<()> {
    let path = temp_db_path("syncular-native-success-sync");
    let mut config = test_config(&path, "native-success-sync");
    let server = TestSyncServer::empty_success()?;
    config.base_url = server.url();
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.trigger_sync()?;

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("successful sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert!(event.error.is_none());
    assert!(event.tables.is_empty());
    assert_eq!(
        event.lifecycle.as_ref().map(|state| &state.phase),
        Some(&NativeLifecyclePhase::Complete)
    );
    assert_eq!(
        event
            .lifecycle
            .as_ref()
            .and_then(|state| state.outbox.as_ref()),
        Some(&syncular_runtime::native::NativeLifecycleOutbox { pending: 0 })
    );
    assert!(client
        .next_event_timeout(Duration::from_millis(100))
        .is_none());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_successful_pull_emits_completion_then_rows_and_queries_changed() -> Result<()> {
    let path = temp_db_path("syncular-native-pull-sync");
    let mut config = test_config(&path, "native-pull-sync");
    let server = TestSyncServer::spawn([TestHttpResponse::json(json!({
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
    }))])?;
    config.base_url = server.url();
    let mut client = open_demo_native_with_options(
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
        .next_event_timeout(Duration::from_secs(5))
        .expect("successful sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert_eq!(event.tables, vec!["tasks".to_string()]);
    assert_eq!(event.changed_rows.len(), 1);
    assert_eq!(event.changed_rows[0].row_id.as_deref(), Some("server-task"));
    assert_eq!(event.changed_rows[0].operation, "insert");
    assert!(event.changed_rows[0]
        .changed_fields
        .contains(&"title".to_string()));

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("post-sync rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);
    assert_eq!(event.changed_rows.len(), 1);
    assert_eq!(
        event
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("source")),
        Some(&json!("remotePull"))
    );

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("post-sync queries changed event");
    assert_eq!(event.kind, NativeEventKind::QueriesChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);
    assert_eq!(event.queries, vec!["task-list".to_string()]);
    assert_eq!(event.changed_rows.len(), 1);

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "server-task");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_worker_event_converter_preserves_rows_queries_and_sequence() -> Result<()> {
    let changed_row = SyncChangedRow {
        table: "tasks".to_string(),
        row_id: Some("converter-task".to_string()),
        operation: "update".to_string(),
        changed_fields: vec!["title".to_string(), "title_yjs_state".to_string()],
        crdt_fields: vec!["title_yjs_state".to_string()],
        crdt_field_changes: vec![SyncChangedCrdtField {
            field: "title".to_string(),
            state_column: "title_yjs_state".to_string(),
            container_key: "title".to_string(),
            row_id_field: "id".to_string(),
            kind: "text".to_string(),
            sync_mode: "server-merge".to_string(),
        }],
        commit_id: Some("server-commit".to_string()),
        commit_seq: Some(42),
        subscription_id: Some("sub-tasks".to_string()),
        server_version: Some(7),
    };
    let worker_event = SyncWorkerEvent::SyncCompleted {
        command_id: Some("converter-sync".to_string()),
        report: SyncReport {
            changed_tables: vec!["tasks".to_string()],
            changed_rows: vec![changed_row.clone()],
            conflicts_changed: false,
        },
        bootstrap: test_bootstrap_status(),
        outbox_count: 0,
        conflict_count: 0,
        duration_ms: 12,
    };

    let events = native_events_from_worker_event_with_observed_queries(
        worker_event.clone(),
        &[NativeObservedQuery {
            id: "task-list".to_string(),
            tables: vec!["tasks".to_string()],
            label: None,
        }],
    );
    assert_eq!(events.len(), 4);
    assert_eq!(events[0].event_seq, 1);
    assert_eq!(events[0].kind, NativeEventKind::SyncCompleted);
    assert_eq!(events[0].changed_rows, vec![changed_row.clone()]);
    assert_eq!(
        events[0].lifecycle.as_ref().map(|state| &state.phase),
        Some(&NativeLifecyclePhase::Complete)
    );
    assert_eq!(
        events[0]
            .lifecycle
            .as_ref()
            .and_then(|state| state.bootstrap.as_ref())
            .map(|bootstrap| bootstrap.progress_percent),
        Some(100)
    );
    assert!(events[0]
        .bootstrap
        .as_ref()
        .is_some_and(|status| status.complete));
    assert_eq!(events[1].event_seq, 2);
    assert_eq!(events[1].kind, NativeEventKind::RowsChanged);
    assert_eq!(events[1].changed_rows, vec![changed_row.clone()]);
    assert_eq!(
        events[1]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("source")),
        Some(&json!("remotePull"))
    );
    assert_eq!(events[2].event_seq, 3);
    assert_eq!(events[2].kind, NativeEventKind::QueriesChanged);
    assert_eq!(events[2].queries, vec!["task-list".to_string()]);
    assert_eq!(events[2].changed_rows, vec![changed_row.clone()]);
    assert_eq!(events[3].event_seq, 4);
    assert_eq!(events[3].kind, NativeEventKind::CrdtFieldChanged);
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("source")),
        Some(&json!("remotePull"))
    );
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("table")),
        Some(&json!("tasks"))
    );
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("rowId")),
        Some(&json!("converter-task"))
    );
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("field")),
        Some(&json!("title"))
    );
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("stateColumn")),
        Some(&json!("title_yjs_state"))
    );
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("commitSeq")),
        Some(&json!(42))
    );
    assert_eq!(
        events[3]
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("subscriptionId")),
        Some(&json!("sub-tasks"))
    );

    let converter = NativeWorkerEventConverter::new();
    let first = converter.convert(worker_event.clone());
    let second = converter.convert(worker_event.clone());
    assert_eq!(first[0].event_seq, 1);
    assert_eq!(second[0].event_seq, 4);

    let json_events = native_event_json_from_worker_event(worker_event)?;
    let first_json: Value = serde_json::from_str(&json_events[0])?;
    assert_eq!(first_json["kind"], "SyncCompleted");
    assert_eq!(first_json["changedRows"][0]["rowId"], "converter-task");
    assert_eq!(first_json["bootstrap"]["complete"], true);
    assert_eq!(first_json["lifecycle"]["phase"], "complete");
    assert_eq!(first_json["lifecycle"]["outbox"]["pending"], 0);

    let overflow_json = native_event_json_from_worker_event(SyncWorkerEvent::EventsOverflowed {
        dropped_count: 7,
    })?;
    let overflow: Value = serde_json::from_str(&overflow_json[0])?;
    assert_eq!(overflow["kind"], "EventsOverflowed");
    assert_eq!(overflow["droppedCount"], 7);
    assert_eq!(overflow["resyncRequired"], true);
    assert_eq!(overflow["payload_json"]["resyncRequired"], true);
    Ok(())
}

#[test]
fn native_sync_failed_marks_required_crdt_resync() -> Result<()> {
    let event = SyncWorkerEvent::SyncFailed {
        command_id: Some("sync-crdt-resync".to_string()),
        error: SyncularError::protocol_message(format!(
            "Yjs diff envelope for table \"tasks\" row \"task-1\" field \"title\" requires local base state vector AQID, but no local state is available; {FULL_SNAPSHOT_RESYNC_REQUIRED}"
        )),
        retry_scheduled: false,
        duration_ms: 17,
    };
    assert!(event.requires_full_refresh());

    let events = native_event_json_from_worker_event(event)?;
    let event: Value = serde_json::from_str(&events[0])?;
    assert_eq!(event["kind"], "SyncFailed");
    assert_eq!(event["resyncRequired"], true);
    assert_eq!(event["payload_json"]["type"], "syncResyncRequired");
    assert_eq!(event["diagnostic"]["code"], "sync.resync_required");
    assert_eq!(event["diagnostic"]["details"]["resyncRequired"], true);
    Ok(())
}

fn test_bootstrap_status() -> BootstrapStatus {
    BootstrapStatus {
        channel_phase: "live".to_string(),
        progress_percent: 100,
        is_bootstrapping: false,
        critical_ready: true,
        interactive_ready: true,
        complete: true,
        active_phase: None,
        expected_subscription_ids: Vec::new(),
        ready_subscription_ids: Vec::new(),
        pending_subscription_ids: Vec::new(),
        subscriptions: Vec::new(),
        phases: Vec::new(),
    }
}

#[test]
fn native_event_stream_overflow_reports_resync_required() -> Result<()> {
    let path = temp_db_path("syncular-native-event-overflow");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-event-overflow"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;
    let events = client.subscribe_events(1);

    apply_task_upsert(&mut client, "overflow-a", "Overflow A")?;
    apply_task_upsert(&mut client, "overflow-b", "Overflow B")?;

    let event = events
        .next_event_timeout(Duration::from_secs(2))
        .expect("overflow event");
    assert_eq!(event.kind, NativeEventKind::EventsOverflowed);
    assert_eq!(
        event
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("resyncRequired")),
        Some(&json!(true))
    );
    assert!(event.dropped_count.unwrap_or_default() >= 2);
    assert_eq!(event.resync_required, Some(true));
    assert!(
        event
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("droppedCount"))
            .and_then(Value::as_u64)
            .unwrap_or_default()
            >= 2
    );
    assert!(events
        .next_event_timeout(Duration::from_millis(100))
        .is_none());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_event_subscription_can_be_used_as_iterators() -> Result<()> {
    let path = temp_db_path("syncular-native-event-iterator");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-event-iterator"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    let mut events = client.event_receiver(8);
    apply_task_upsert(&mut client, "iterator-a", "Iterator A")?;
    let event = events.next().expect("iterator event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.changed_rows[0].row_id.as_deref(), Some("iterator-a"));

    let mut json_events = client.subscribe_events(8).into_json_iter();
    apply_task_upsert(&mut client, "iterator-b", "Iterator B")?;
    let event_json = json_events.next().expect("json iterator event")?;
    let event: Value = serde_json::from_str(&event_json)?;
    assert_eq!(event["kind"], "RowsChanged");
    assert_eq!(event["changedRows"][0]["rowId"], "iterator-b");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_rejected_push_emits_conflicts_changed() -> Result<()> {
    let path = temp_db_path("syncular-native-push-conflict");
    let mut config = test_config(&path, "native-push-conflict");
    config.base_url = spawn_rejecting_push_server()?;
    let mut client = open_demo_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "native-conflict-task", "Conflict candidate")?;
    let local_event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("local rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);

    client.trigger_sync()?;

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("conflict sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    assert!(event.tables.is_empty());

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("conflicts changed event");
    assert_eq!(event.kind, NativeEventKind::ConflictsChanged);
    assert!(event.tables.is_empty());

    let conflicts = client.conflict_summaries()?;
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].result_status, "conflict");
    assert_eq!(conflicts[0].code.as_deref(), Some("sync.version_conflict"));

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_applies_generic_mutation_json() -> Result<()> {
    let path = temp_db_path("syncular-native-generic-operation");
    let mut client = open_demo_native_with_options(
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
    let commit_id = client.apply_mutation_json(&operation, None)?;
    assert!(!commit_id.is_empty());

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "generic-task");
    assert_eq!(tasks_json[0]["title"], "Generic task");

    let local_event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("generic operation rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(local_event.tables, vec!["tasks".to_string()]);
    assert_eq!(local_event.changed_rows.len(), 1);
    assert_eq!(local_event.changed_rows[0].table, "tasks");
    assert_eq!(
        local_event.changed_rows[0].row_id.as_deref(),
        Some("generic-task")
    );
    assert_eq!(local_event.changed_rows[0].operation, "insert");
    assert_eq!(
        local_event.changed_rows[0].changed_fields,
        vec![
            "title".to_string(),
            "completed".to_string(),
            "user_id".to_string(),
            "project_id".to_string()
        ]
    );
    assert_eq!(
        local_event
            .payload_json
            .as_ref()
            .and_then(|payload| payload.get("source")),
        Some(&json!("localWrite"))
    );

    let update = json!({
        "table": "tasks",
        "row_id": "generic-task",
        "op": "upsert",
        "payload": {
            "title": "Generic task updated"
        },
        "base_version": 0
    })
    .to_string();
    client.apply_mutation_json(&update, None)?;
    let local_event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("generic update rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(local_event.changed_rows.len(), 1);
    assert_eq!(local_event.changed_rows[0].operation, "update");
    assert_eq!(
        local_event.changed_rows[0].changed_fields,
        vec!["title".to_string()]
    );

    let delete = json!({
        "table": "tasks",
        "row_id": "generic-task",
        "op": "delete",
        "payload": null,
        "base_version": 0
    })
    .to_string();
    client.apply_mutation_json(&delete, None)?;
    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(0));
    let delete_event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("generic delete rows changed event");
    assert_eq!(delete_event.changed_rows.len(), 1);
    assert_eq!(delete_event.changed_rows[0].operation, "delete");
    assert!(delete_event.changed_rows[0].changed_fields.is_empty());

    let error = client
        .apply_mutation_json(
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
fn native_facade_opens_with_generated_app_schema_json() -> Result<()> {
    let path = temp_db_path("syncular-native-dynamic-schema");
    {
        let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
        sql_query(
            r#"
            create table notes (
                note_key text primary key,
                body text not null,
                owner_id text not null,
                server_version bigint not null default 0
            )
            "#,
        )
        .execute(&mut conn)?;
    }
    let mut config = test_config(&path, "native-dynamic-schema");
    config.project_id = None;
    config.app_schema_json = Some(
        json!({
            "schemaVersion": 21,
            "tables": [{
                "name": "notes",
                "primaryKeyColumn": "note_key",
                "serverVersionColumn": "server_version",
                "subscriptionId": "sub-notes",
                "columns": [
                    { "name": "note_key", "typeFamily": "text", "notnullRequired": true, "primaryKey": true },
                    { "name": "body", "typeFamily": "text", "notnullRequired": true },
                    { "name": "owner_id", "typeFamily": "text", "notnullRequired": true },
                    { "name": "server_version", "typeFamily": "integer", "notnullRequired": true }
                ],
                "scopes": [
                    { "name": "user_id", "column": "owner_id", "source": "actorId", "required": true }
                ]
            }]
        })
        .to_string(),
    );
    let mut client = NativeSyncularClient::open_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    let tables_json: Value = serde_json::from_str(&client.app_tables_json()?)?;
    assert_eq!(tables_json, json!(["notes"]));

    client.apply_mutation_json(
        &json!({
            "table": "notes",
            "row_id": "note-1",
            "op": "upsert",
            "payload": {
                "body": "Native dynamic note",
                "owner_id": "user-rust"
            },
            "base_version": 0
        })
        .to_string(),
        None,
    )?;
    let notes_json: Value = serde_json::from_str(&client.list_table_json("notes")?)?;
    assert_eq!(notes_json.as_array().map(Vec::len), Some(1));
    assert_eq!(notes_json[0]["note_key"], "note-1");
    assert_eq!(notes_json[0]["body"], "Native dynamic note");

    client.pause_sync_worker()?;
    client.resume_sync_worker()?;
    client.apply_mutation_json(
        &json!({
            "table": "notes",
            "row_id": "note-1",
            "op": "upsert",
            "payload": { "body": "After resume" },
            "base_version": 0
        })
        .to_string(),
        None,
    )?;
    let notes_json: Value = serde_json::from_str(&client.list_table_json("notes")?)?;
    assert_eq!(notes_json[0]["body"], "After resume");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_can_open_and_migrate_on_background_task() -> Result<()> {
    let path = temp_db_path("syncular-native-async-open");
    let mut config = test_config(&path, "native-async-open");
    config.app_schema_json = Some(todo_app_schema_json());

    let mut task = NativeSyncularClient::open_native_async_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    );
    assert!(task.command_id().starts_with("native-open-"));

    let mut client = task
        .take_client_timeout(Duration::from_secs(5))
        .expect("async native open should finish")?;
    assert!(task.is_finished());
    assert!(client.sync_worker_running());

    let tables_json: Value = serde_json::from_str(&client.app_tables_json()?)?;
    assert_eq!(tables_json.as_array().map(Vec::len), Some(3));
    assert_eq!(tables_json[0], "comments");
    assert_eq!(tables_json[2], "tasks");
    client.apply_mutation_json(
        &json!({
            "table": "tasks",
            "row_id": "task-async-open",
            "op": "upsert",
            "payload": {
                "title": "Opened off the caller thread",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
        None,
    )?;
    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["id"], "task-async-open");
    assert_eq!(tasks_json[0]["title"], "Opened off the caller thread");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_mutation_on_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-operation");
    let mut client = open_demo_native_with_options(
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
    let command_id = client.enqueue_mutation_json(&operation, None)?;
    assert!(command_id.starts_with("native-mutation-"));

    let committed = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("queued local write committed event");
    assert_eq!(committed.kind, NativeEventKind::LocalWriteCommitted);
    assert_eq!(committed.command_id.as_deref(), Some(command_id.as_str()));
    assert_eq!(committed.tables, vec!["tasks".to_string()]);
    assert_eq!(committed.changed_rows.len(), 1);
    assert_eq!(
        committed.changed_rows[0].row_id.as_deref(),
        Some("queued-task")
    );
    assert_eq!(committed.changed_rows[0].operation, "insert");
    assert!(committed.client_commit_id.is_some());
    assert!(committed.event_seq > 0);
    assert_eq!(
        committed.lifecycle.as_ref().map(|state| &state.phase),
        Some(&NativeLifecyclePhase::Offline)
    );
    assert_eq!(
        committed
            .lifecycle
            .as_ref()
            .and_then(|state| state.outbox.as_ref())
            .map(|outbox| outbox.pending),
        Some(1)
    );

    let rows = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("queued local rows changed event");
    assert_eq!(rows.kind, NativeEventKind::RowsChanged);
    assert_eq!(rows.tables, vec!["tasks".to_string()]);
    assert_eq!(rows.changed_rows.len(), 1);
    assert_eq!(rows.changed_rows[0].changed_fields[0], "title");
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
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-enqueue-yjs"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "queued-yjs-task", "")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

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
    let mut yjs_changed_row = None;
    for _ in 0..6 {
        let event = client
            .next_event_timeout(Duration::from_secs(2))
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
                yjs_changed_row = event.changed_rows.first().cloned();
            }
            _ => {}
        }
        if first_commit_id.is_some() && second_commit_id.is_some() && yjs_changed_row.is_some() {
            break;
        }
    }
    assert_eq!(first_commit_id, second_commit_id);
    assert!(saw_rows_changed);
    let yjs_changed_row = yjs_changed_row.expect("queued Yjs changed row");
    assert_eq!(
        yjs_changed_row.crdt_fields,
        vec!["title_yjs_state".to_string()]
    );
    assert_eq!(
        yjs_changed_row
            .crdt_field_changes
            .first()
            .map(|field| field.field.as_str()),
        Some("title")
    );

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks_json[0]["title"], "Queued Yjs");
    assert!(tasks_json[0]["title_yjs_state"].as_str().is_some());

    let snapshot_json: Value = serde_json::from_str(
        &client.crdt_document_snapshot_json(
            &json!({
                "table": "tasks",
                "rowId": "queued-yjs-task",
                "field": "title"
            })
            .to_string(),
        )?,
    )?;
    assert_eq!(snapshot_json["logUpdates"], 2);
    assert_eq!(snapshot_json["pendingUpdates"], 2);
    assert!(snapshot_json["stateBase64"].as_str().is_some());

    let update_log_json: Value = serde_json::from_str(
        &client.crdt_update_log_json(
            &json!({
                "table": "tasks",
                "rowId": "queued-yjs-task",
                "field": "title",
                "limit": 10
            })
            .to_string(),
        )?,
    )?;
    assert_eq!(update_log_json.as_array().map(Vec::len), Some(2));
    assert_eq!(update_log_json[0]["updateId"], "queued-yjs-1");
    assert_eq!(update_log_json[1]["updateId"], "queued-yjs-2");
    assert_eq!(
        update_log_json[0]["clientCommitId"].as_str(),
        first_commit_id.as_deref()
    );
    assert_eq!(
        update_log_json[1]["clientCommitId"].as_str(),
        second_commit_id.as_deref()
    );

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_exposes_generic_crdt_field_api() -> Result<()> {
    let path = temp_db_path("syncular-native-crdt-field");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-crdt-field"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "native-crdt-field-task", "")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

    let field_request = json!({
        "table": "tasks",
        "rowId": "native-crdt-field-task",
        "field": "title"
    })
    .to_string();
    let descriptor: Value = serde_json::from_str(&client.open_crdt_field_json(&field_request)?)?;
    assert_eq!(descriptor["table"], "tasks");
    assert_eq!(descriptor["field"], "title");
    assert_eq!(descriptor["stateColumn"], "title_yjs_state");
    assert_eq!(descriptor["syncMode"], "server-merge");

    let receipt: Value = serde_json::from_str(
        &client.apply_crdt_field_text_json(
            &json!({
                "table": "tasks",
                "rowId": "native-crdt-field-task",
                "field": "title",
                "nextText": "Native CRDT field"
            })
            .to_string(),
        )?,
    )?;
    assert_eq!(receipt["syncMode"], "server-merge");
    assert!(receipt["clientCommitId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));

    let crdt_event = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT field changed event");
    assert_eq!(crdt_event.kind, NativeEventKind::CrdtFieldChanged);
    assert_eq!(crdt_event.tables, vec!["tasks".to_string()]);
    assert_eq!(
        crdt_event.client_commit_id,
        receipt["clientCommitId"].as_str().map(str::to_string)
    );
    assert_eq!(crdt_event.payload_json.as_ref().unwrap()["table"], "tasks");
    assert_eq!(
        crdt_event.payload_json.as_ref().unwrap()["rowId"],
        "native-crdt-field-task"
    );
    assert_eq!(crdt_event.payload_json.as_ref().unwrap()["field"], "title");
    assert_eq!(
        crdt_event.payload_json.as_ref().unwrap()["syncMode"],
        "server-merge"
    );
    assert_eq!(crdt_event.payload_json.as_ref().unwrap()["kind"], "text");
    assert_eq!(
        crdt_event.payload_json.as_ref().unwrap()["stateColumn"],
        "title_yjs_state"
    );
    assert_eq!(
        crdt_event.payload_json.as_ref().unwrap()["materializationAvailable"],
        true
    );
    assert_eq!(crdt_event.payload_json.as_ref().unwrap()["hasState"], true);
    assert!(
        crdt_event.payload_json.as_ref().unwrap()["stateVectorBase64"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );

    let event = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT field rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["tasks".to_string()]);

    let materialized: Value =
        serde_json::from_str(&client.materialize_crdt_field_json(&field_request)?)?;
    assert_eq!(materialized["value"], "Native CRDT field");
    assert!(materialized["stateBase64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(materialized["stateVectorBase64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));

    let snapshot: Value =
        serde_json::from_str(&client.snapshot_crdt_field_state_vector_json(&field_request)?)?;
    assert_eq!(
        snapshot["stateVectorBase64"],
        materialized["stateVectorBase64"]
    );

    let compaction: Value = serde_json::from_str(
        &client.compact_crdt_field_json(
            &json!({
                "table": "tasks",
                "rowId": "native-crdt-field-task",
                "field": "title",
                "minUncheckpointedUpdates": 1
            })
            .to_string(),
        )?,
    )?;
    assert_eq!(compaction["checkpointCreated"], false);
    assert!(compaction["clientCommitId"].is_null());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_generic_crdt_field_yjs_update() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-crdt-field");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-enqueue-crdt-field"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "queued-crdt-field-task", "")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

    let update = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Queued generic CRDT".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("queued-crdt-field-1".to_string()),
    })?;
    let command_id = client.enqueue_crdt_field_yjs_update_json(
        &json!({
            "table": "tasks",
            "rowId": "queued-crdt-field-task",
            "field": "title",
            "update": update.update
        })
        .to_string(),
    )?;
    assert!(command_id.starts_with("native-yjs-"));

    let committed = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued commit event");
    assert_eq!(committed.kind, NativeEventKind::LocalWriteCommitted);
    assert_eq!(committed.command_id.as_deref(), Some(command_id.as_str()));
    assert_eq!(committed.tables, vec!["tasks".to_string()]);

    let rows = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued rows changed event");
    assert_eq!(rows.kind, NativeEventKind::RowsChanged);
    assert_eq!(rows.tables, vec!["tasks".to_string()]);

    let crdt = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued field event");
    assert_eq!(crdt.kind, NativeEventKind::CrdtFieldChanged);
    assert_eq!(crdt.command_id.as_deref(), Some(command_id.as_str()));
    assert_eq!(crdt.tables, vec!["tasks".to_string()]);
    assert_eq!(crdt.payload_json.as_ref().unwrap()["table"], "tasks");
    assert_eq!(
        crdt.payload_json.as_ref().unwrap()["rowId"],
        "queued-crdt-field-task"
    );
    assert_eq!(crdt.payload_json.as_ref().unwrap()["field"], "title");
    assert_eq!(
        crdt.payload_json.as_ref().unwrap()["syncMode"],
        "server-merge"
    );
    assert_eq!(
        crdt.payload_json.as_ref().unwrap()["materializationAvailable"],
        true
    );
    assert_eq!(crdt.payload_json.as_ref().unwrap()["hasState"], true);
    assert!(crdt.payload_json.as_ref().unwrap()["stateVectorBase64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json[0]["title"], "Queued generic CRDT");
    assert!(tasks_json[0]["title_yjs_state"].as_str().is_some());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_generic_crdt_field_text_and_compaction() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-crdt-field-text");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-enqueue-crdt-field-text"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "queued-crdt-field-text-task", "")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

    let text_command_id = client.enqueue_crdt_field_text_json(
        &json!({
            "table": "tasks",
            "rowId": "queued-crdt-field-text-task",
            "field": "title",
            "nextText": "Queued generic CRDT text"
        })
        .to_string(),
    )?;
    assert!(text_command_id.starts_with("native-crdt-text-"));

    let committed = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued text commit event");
    assert_eq!(committed.kind, NativeEventKind::LocalWriteCommitted);
    assert_eq!(
        committed.command_id.as_deref(),
        Some(text_command_id.as_str())
    );
    assert_eq!(committed.tables, vec!["tasks".to_string()]);

    let rows = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued text rows changed event");
    assert_eq!(rows.kind, NativeEventKind::RowsChanged);
    assert_eq!(rows.tables, vec!["tasks".to_string()]);

    let crdt = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued text field event");
    assert_eq!(crdt.kind, NativeEventKind::CrdtFieldChanged);
    assert_eq!(crdt.command_id.as_deref(), Some(text_command_id.as_str()));
    assert_eq!(crdt.payload_json.as_ref().unwrap()["table"], "tasks");
    assert_eq!(
        crdt.payload_json.as_ref().unwrap()["rowId"],
        "queued-crdt-field-text-task"
    );
    assert_eq!(crdt.payload_json.as_ref().unwrap()["field"], "title");
    assert_eq!(
        crdt.payload_json.as_ref().unwrap()["syncMode"],
        "server-merge"
    );
    assert_eq!(
        crdt.payload_json.as_ref().unwrap()["materializationAvailable"],
        true
    );
    assert_eq!(crdt.payload_json.as_ref().unwrap()["hasState"], true);
    assert!(crdt.payload_json.as_ref().unwrap()["stateVectorBase64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));

    let field_request = json!({
        "table": "tasks",
        "rowId": "queued-crdt-field-text-task",
        "field": "title"
    })
    .to_string();
    let materialized: Value =
        serde_json::from_str(&client.materialize_crdt_field_json(&field_request)?)?;
    assert_eq!(materialized["value"], "Queued generic CRDT text");

    let compact_command_id = client.enqueue_crdt_field_compaction_json(
        &json!({
            "table": "tasks",
            "rowId": "queued-crdt-field-text-task",
            "field": "title",
            "minUncheckpointedUpdates": 1
        })
        .to_string(),
    )?;
    assert!(compact_command_id.starts_with("native-crdt-compact-"));

    let compacted = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("server-merge CRDT queued compaction event");
    assert_eq!(compacted.kind, NativeEventKind::CrdtFieldCompacted);
    assert_eq!(
        compacted.command_id.as_deref(),
        Some(compact_command_id.as_str())
    );
    assert_eq!(compacted.client_commit_id.as_deref(), None);
    assert_eq!(compacted.tables, vec!["tasks"]);
    assert_eq!(
        compacted.payload_json.as_ref().unwrap()["checkpointCreated"],
        false
    );
    assert_eq!(compacted.payload_json.as_ref().unwrap()["table"], "tasks");
    assert_eq!(
        compacted.payload_json.as_ref().unwrap()["rowId"],
        "queued-crdt-field-text-task"
    );
    assert_eq!(compacted.payload_json.as_ref().unwrap()["field"], "title");
    assert_eq!(
        compacted.payload_json.as_ref().unwrap()["syncMode"],
        "server-merge"
    );
    assert_eq!(
        compacted.payload_json.as_ref().unwrap()["minUncheckpointedUpdates"],
        1
    );

    let completed = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("server-merge CRDT queued compaction completion event");
    assert_eq!(completed.kind, NativeEventKind::WorkerCommandCompleted);
    assert_eq!(
        completed.command_id.as_deref(),
        Some(compact_command_id.as_str())
    );

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_failed_queued_crdt_field_write_reports_field_payload() -> Result<()> {
    let path = temp_db_path("syncular-native-failed-crdt-field");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-failed-crdt-field"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "failed-crdt-field-task", "Legacy title")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

    let command_id = client.enqueue_crdt_field_text_json(
        &json!({
            "table": "tasks",
            "rowId": "failed-crdt-field-task",
            "field": "title",
            "nextText": "Edited title"
        })
        .to_string(),
    )?;

    let failed = client
        .next_event_timeout(Duration::from_secs(2))
        .expect("generic CRDT queued text failure event");
    assert_eq!(failed.kind, NativeEventKind::LocalWriteFailed);
    assert_eq!(failed.command_id.as_deref(), Some(command_id.as_str()));
    assert!(failed
        .error
        .as_ref()
        .is_some_and(|error| error.message.contains("without existing Yjs state")));
    let payload = failed.payload_json.as_ref().expect("failure payload");
    assert_eq!(payload["operation"], "crdtFieldText");
    assert_eq!(payload["table"], "tasks");
    assert_eq!(payload["rowId"], "failed-crdt-field-task");
    assert_eq!(payload["field"], "title");
    assert_eq!(payload["failedBeforeCommit"], true);
    assert_eq!(payload["retryScheduled"], false);

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_queued_crdt_field_update_does_not_wait_for_busy_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-crdt-field-nonblocking");
    let (started_tx, started_rx) = mpsc::channel();
    let mut config = test_config(&path, "native-crdt-field-nonblocking");
    config.base_url = spawn_delayed_success_sync_server(Duration::from_millis(900), started_tx)?;
    let mut client = open_demo_native_with_options(
        config,
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "nonblocking-crdt-field-task", "")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

    let sync_command_id = client.enqueue_sync_now()?;
    started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("slow sync server received worker request");

    let update = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Queued while sync is busy".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("queued-crdt-field-nonblocking-1".to_string()),
    })?;
    let request_json = json!({
        "table": "tasks",
        "rowId": "nonblocking-crdt-field-task",
        "field": "title",
        "update": update.update
    })
    .to_string();

    let started = Instant::now();
    let command_id = client.enqueue_crdt_field_yjs_update_json(&request_json)?;
    let enqueue_duration = started.elapsed();
    assert!(
        enqueue_duration < Duration::from_millis(450),
        "queued CRDT field update waited for busy worker for {enqueue_duration:?}"
    );

    let mut saw_sync_started = false;
    let mut saw_sync_completed = false;
    let mut saw_local_commit = false;
    for _ in 0..8 {
        let event = client
            .next_event_timeout(Duration::from_secs(2))
            .expect("worker event after queued CRDT field update");
        match event.kind {
            NativeEventKind::SyncStarted
                if event.command_id.as_deref() == Some(sync_command_id.as_str()) =>
            {
                saw_sync_started = true;
            }
            NativeEventKind::SyncCompleted
                if event.command_id.as_deref() == Some(sync_command_id.as_str()) =>
            {
                saw_sync_completed = true;
            }
            NativeEventKind::LocalWriteCommitted
                if event.command_id.as_deref() == Some(command_id.as_str()) =>
            {
                saw_local_commit = true;
            }
            _ => {}
        }
        if saw_sync_started && saw_sync_completed && saw_local_commit {
            break;
        }
    }
    assert!(saw_sync_started);
    assert!(saw_sync_completed);
    assert!(saw_local_commit);

    let tasks_json: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(tasks_json[0]["title"], "Queued while sync is busy");

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_enqueues_snapshot_refresh_on_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-enqueue-snapshot");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-enqueue-snapshot"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    apply_task_upsert(&mut client, "snapshot-task", "Snapshot task")?;
    let _ = client.next_event_timeout(Duration::from_millis(100));

    let command_id = client.enqueue_refresh_snapshot_json(
        &json!({
            "sql": "select id, title from tasks where id = ?",
            "params": ["snapshot-task"],
            "tables": ["tasks"]
        })
        .to_string(),
    )?;
    let event = client
        .next_event_timeout(Duration::from_secs(2))
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
    let mut client = open_demo_native_with_options(
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
        .next_event_timeout(Duration::from_secs(2))
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
        .next_event_timeout(Duration::from_secs(2))
        .expect("queued retrieve blob event");
    assert_eq!(
        retrieve_event.command_id.as_deref(),
        Some(retrieve_command.as_str())
    );
    assert_eq!(fs::read(&output_path).unwrap(), b"queued blob");

    let compact_command = client.enqueue_compact_storage_json(None)?;
    let compact_event = client
        .next_event_timeout(Duration::from_secs(2))
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
    let mut client = open_demo_native_with_options(
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
    client.apply_mutation_json(&operation, None)?;

    let rows_event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("rows changed event");
    assert_eq!(rows_event.kind, NativeEventKind::RowsChanged);
    assert_eq!(rows_event.tables, vec!["tasks".to_string()]);
    assert!(rows_event.queries.is_empty());

    let query_event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("queries changed event");
    assert_eq!(query_event.kind, NativeEventKind::QueriesChanged);
    assert_eq!(query_event.tables, vec!["tasks".to_string()]);
    assert_eq!(query_event.queries, vec!["task-list".to_string()]);

    client.unregister_query("task-list")?;
    client.apply_mutation_json(
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
        .next_event_timeout(Duration::from_millis(100))
        .expect("rows changed event after unregister");
    assert_eq!(rows_event.kind, NativeEventKind::RowsChanged);
    assert!(client
        .next_event_timeout(Duration::from_millis(100))
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
fn native_facade_exposes_redacted_diagnostic_snapshot() -> Result<()> {
    let path = temp_db_path("syncular-native-diagnostic-snapshot");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-diagnostic-snapshot"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;

    client.set_subscriptions_json(
        &json!([
            {
                "id": "tasks-private",
                "table": "tasks",
                "scopes": {
                    "project_id": ["secret-project-1", "secret-project-2"],
                    "user_id": "secret-user"
                },
                "params": {
                    "limit": 50
                },
                "bootstrapPhase": 1
            }
        ])
        .to_string(),
    )?;
    client.register_query_json(
        &json!({
            "id": "task-diagnostics",
            "tables": ["tasks"],
            "label": "Task diagnostics"
        })
        .to_string(),
    )?;
    apply_task_upsert(&mut client, "diagnostic-task", "Diagnostic task")?;
    client.trigger_sync()?;
    let mut saw_sync_failed = false;
    for _ in 0..4 {
        if matches!(
            client
                .next_event_timeout(Duration::from_secs(5))
                .map(|event| event.kind),
            Some(NativeEventKind::SyncFailed)
        ) {
            saw_sync_failed = true;
            break;
        }
    }
    assert!(saw_sync_failed);

    let snapshot_json = client.diagnostic_snapshot_json()?;
    let snapshot: Value = serde_json::from_str(&snapshot_json)?;
    assert_eq!(snapshot["runtime"]["crate_name"], "syncular-runtime");
    assert_eq!(snapshot["connection"]["syncWorkerRunning"], true);
    assert_eq!(snapshot["connection"]["realtimeWorkerRunning"], false);
    assert_eq!(snapshot["connection"]["autoSyncLocalWrites"], false);
    assert_eq!(snapshot["connection"]["observedQueryCount"], 1);
    assert!(snapshot["connection"]["eventSubscriberCount"]
        .as_u64()
        .is_some_and(|count| count >= 1));

    assert_eq!(snapshot["subscriptions"].as_array().map(Vec::len), Some(1));
    assert_eq!(snapshot["subscriptions"][0]["id"], "tasks-private");
    assert_eq!(snapshot["subscriptions"][0]["table"], "tasks");
    assert_eq!(
        snapshot["subscriptions"][0]["scopeKeys"],
        json!(["project_id", "user_id"])
    );
    assert_eq!(snapshot["subscriptions"][0]["scopeValueCount"], 3);
    assert_eq!(snapshot["subscriptions"][0]["paramsKeys"], json!(["limit"]));
    assert_eq!(snapshot["subscriptions"][0]["paramsValueCount"], 1);
    assert_eq!(snapshot["subscriptions"][0]["bootstrapPhase"], 1);

    assert!(!snapshot_json.contains("secret-user"));
    assert!(!snapshot_json.contains("secret-project-1"));
    assert!(!snapshot_json.contains("secret-project-2"));
    assert_eq!(snapshot["outboxStats"]["pending"], 1);
    assert_eq!(snapshot["outboxStats"]["total"], 1);
    assert_eq!(snapshot["conflictStats"]["total"], 0);
    assert_eq!(
        snapshot["observedQueries"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(snapshot["observedQueries"][0]["id"], "task-diagnostics");
    assert!(snapshot["recentEvents"]
        .as_array()
        .is_some_and(|events| events.iter().any(|event| event["kind"] == "RowsChanged")));
    assert!(snapshot["recentDiagnostics"]
        .as_array()
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item["code"] == "storage.rows_changed")
        }));
    assert!(snapshot["recentSyncTimings"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| {
            item["kind"] == "syncFailed"
                && item["success"] == false
                && item["totalMs"].as_u64().is_some()
        })));

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_replaces_duplicate_query_observer_dependencies() -> Result<()> {
    let path = temp_db_path("syncular-native-query-observer-replace");
    let mut client = open_demo_native_with_options(
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
        .next_event_timeout(Duration::from_millis(100))
        .expect("task rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    let event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("task queries changed event");
    assert_eq!(event.kind, NativeEventKind::QueriesChanged);
    assert_eq!(event.queries, vec!["live-list".to_string()]);

    apply_project_upsert(&mut client, "query-replace-project", "Ignored project")?;
    let event = client
        .next_event_timeout(Duration::from_millis(100))
        .expect("project rows changed event");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert_eq!(event.tables, vec!["projects".to_string()]);
    assert!(client
        .next_event_timeout(Duration::from_millis(100))
        .is_none());

    client.unregister_query("live-list")?;
    client.unregister_query("live-list")?;
    client.apply_mutation_json(
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
        .next_event_timeout(Duration::from_millis(100))
        .expect("task rows changed after duplicate unregister");
    assert_eq!(event.kind, NativeEventKind::RowsChanged);
    assert!(client
        .next_event_timeout(Duration::from_millis(100))
        .is_none());

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_reports_closed_worker_as_structured_error() -> Result<()> {
    let path = temp_db_path("syncular-native-closed");
    let mut client = open_demo_native(test_config(&path, "native-closed"))?;

    client.close()?;
    let error = client.trigger_sync().expect_err("closed client error");
    assert_eq!(error.kind(), ErrorKind::Internal);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_builder_applies_lifecycle_options() -> Result<()> {
    let path = temp_db_path("syncular-native-builder");
    let mut config = test_config(&path, "native-builder");
    let server = TestSyncServer::empty_success()?;
    config.base_url = server.url();
    let mut client = NativeSyncularClient::builder(config)
        .auto_sync_local_writes(false)
        .realtime(false)
        .auth_headers_json(
            &json!({
                "authorization": "Bearer builder-test"
            })
            .to_string(),
        )?
        .subscriptions_json("[]")?
        .initial_sync(true)
        .process_blob_uploads_on_open(true)
        .shutdown_on_drop(true)
        .open()?;

    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("builder initial sync result event");
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);
    let requests = server.wait_for_requests(1, Duration::from_secs(1));
    assert_eq!(
        requests
            .first()
            .and_then(|request| request.header("authorization")),
        Some("Bearer builder-test")
    );

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn native_facade_can_pause_and_resume_background_worker() -> Result<()> {
    let path = temp_db_path("syncular-native-worker-lifecycle");
    let mut client = open_demo_native_with_options(
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
        .next_event_timeout(Duration::from_millis(100))
        .expect("local rows changed event");
    assert_eq!(local_event.kind, NativeEventKind::RowsChanged);
    assert!(client
        .next_event_timeout(Duration::from_millis(100))
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

#[test]
fn native_facade_tracks_presence_and_emits_events() -> Result<()> {
    let path = temp_db_path("syncular-native-presence");
    let mut client = open_demo_native_with_options(
        test_config(&path, "native-presence-client"),
        NativeClientOptions {
            auto_sync_local_writes: false,
        },
    )?;
    let scope_key = "user:user-rust";

    client.join_presence(scope_key, Some(json!({ "editing": "task-1" })))?;
    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("presence event");
    assert_eq!(event.kind, NativeEventKind::PresenceChanged);
    assert_eq!(
        event
            .payload_json
            .as_ref()
            .and_then(|value| value.get("scopeKey")),
        Some(&json!(scope_key))
    );
    let presence: Value = serde_json::from_str(&client.presence_json(scope_key)?)?;
    assert_eq!(presence[0]["clientId"], "native-presence-client");
    assert_eq!(presence[0]["metadata"]["editing"], "task-1");

    client.update_presence_metadata(scope_key, json!({ "editing": "task-2" }))?;
    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("presence update event");
    assert_eq!(event.kind, NativeEventKind::PresenceChanged);
    let presence: Value = serde_json::from_str(&client.presence_json(scope_key)?)?;
    assert_eq!(presence[0]["metadata"]["editing"], "task-2");

    client.leave_presence(scope_key)?;
    let event = client
        .next_event_timeout(Duration::from_secs(5))
        .expect("presence leave event");
    assert_eq!(event.kind, NativeEventKind::PresenceChanged);
    let presence: Value = serde_json::from_str(&client.presence_json(scope_key)?)?;
    assert_eq!(presence.as_array().map(Vec::len), Some(0));

    client.close()?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

fn apply_task_upsert(
    client: &mut NativeSyncularClient,
    task_id: &str,
    title: &str,
) -> Result<String> {
    client.apply_mutation_json(
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
    client.apply_mutation_json(
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

fn open_demo_native(config: NativeClientConfig) -> Result<NativeSyncularClient> {
    open_demo_native_with_options(config, NativeClientOptions::default())
}

fn open_demo_native_with_options(
    config: NativeClientConfig,
    options: NativeClientOptions,
) -> Result<NativeSyncularClient> {
    NativeSyncularClient::open_with_options_and_schema(
        config.into(),
        options,
        demo_todo_app_schema(),
    )
}

fn test_config(path: &str, client_id: &str) -> NativeClientConfig {
    NativeClientConfig {
        db_path: path.to_string(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
        client_id: client_id.to_string(),
        actor_id: "user-rust".to_string(),
        project_id: Some("p0".to_string()),
        app_schema_json: None,
    }
}

fn temp_db_path(prefix: &str) -> String {
    unique_temp_db_path(prefix)
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
                            "code": "sync.version_conflict",
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

fn spawn_delayed_success_sync_server(
    delay: Duration,
    started_tx: mpsc::Sender<()>,
) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = read_http_request(&mut stream);
            let _ = started_tx.send(());
            std::thread::sleep(delay);
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

fn write_http_json_response(stream: &mut std::net::TcpStream, body: Value) {
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}
