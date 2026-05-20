use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::json;
use syncular_runtime::error::ErrorKind;
use syncular_runtime::fixtures::todo;
use syncular_runtime::native::{NativeClientOptions, NativeEventKind};
use syncular_runtime::protocol::{PushCommitRequest, SyncOperation};
use syncular_runtime::transport::{
    HttpSyncTransport, RealtimeEvent, RealtimeTransport, SyncTransport, SyncTransportConfig,
};
use syncular_testkit::{
    actor_project_scopes, apply_crdt_field_text, apply_native_crdt_field_text,
    apply_native_todo_task_upsert, assert_blob_upload_queue, assert_conflict_count,
    assert_crdt_field_materializes, assert_crdt_field_text_nonblank,
    assert_native_crdt_field_materializes, assert_native_error_kind, assert_native_rows_changed,
    assert_native_table_row_count, assert_no_conflicts, assert_outbox_empty,
    assert_outbox_statuses, assert_table_has_row, assert_table_row_count,
    default_combined_response, encoded_blob_hash, open_app_client, open_app_client_in_memory,
    open_app_client_with_server, open_app_client_with_transport,
    open_native_client_with_schema_json_options, open_native_client_with_schema_options,
    open_todo_client, open_todo_client_with_transport, push_conflict_response,
    snapshot_combined_response, todo_app_schema_json, todo_snapshot_response, todo_task_row,
    AppFixtureOptions, AppTestHttpServer, AppTestServer, FaultOperation, FaultPhase, FaultStep,
    FaultTransport, NativeFixtureOptions, TestBlobServer, TestBlobServerOptions, TestSyncServer,
    TestTransport, TodoFixtureOptions,
};
use tungstenite::{connect, stream::MaybeTlsStream, Message};

#[test]
fn todo_fixture_uses_real_sqlite_and_generated_mutations() {
    let mut fixture = open_todo_client().expect("todo fixture");

    fixture
        .client
        .add_task("Testkit local task".to_string(), Some("task-1".to_string()))
        .expect("add task");
    assert_outbox_statuses(&mut fixture.client, &["pending"]);

    let report = fixture.client.sync_http().expect("sync");
    assert!(report.changed_tables.is_empty());
    assert_outbox_statuses(&mut fixture.client, &["acked"]);

    let requests = fixture.transport.handle().requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].client_id, "test-client");
    assert_eq!(
        requests[0].push.as_ref().expect("push").commits[0].operations[0].row_id,
        "task-1"
    );
}

#[test]
fn scripted_snapshot_applies_remote_rows() {
    let mut fixture = open_todo_client().expect("todo fixture");
    fixture
        .transport
        .push_http_response(todo_snapshot_response(vec![todo_task_row(
            "remote-1",
            "Remote task",
            9,
        )]));

    let report = fixture.client.sync_http().expect("sync");
    assert_eq!(report.changed_tables, vec!["tasks".to_string()]);

    let rows = fixture.client.list_tasks().expect("list tasks");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "remote-1");
    assert_eq!(rows[0].title, "Remote task");
    assert_no_conflicts(&mut fixture.client);
}

#[test]
fn app_fixture_accepts_generated_app_schema() {
    let mut fixture = open_app_client(todo::app_schema()).expect("app fixture");
    fixture
        .transport
        .push_http_response(todo_snapshot_response(vec![todo_task_row(
            "schema-app-1",
            "Generated schema row",
            3,
        )]));

    fixture.client.sync_http().expect("sync");
    let rows = assert_table_row_count(&mut fixture.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "schema-app-1");
}

#[test]
fn in_memory_app_fixture_uses_generated_schema() {
    let mut fixture = open_app_client_in_memory(todo::app_schema()).expect("in-memory fixture");
    fixture
        .transport
        .push_http_response(todo_snapshot_response(vec![todo_task_row(
            "memory-1",
            "In memory",
            2,
        )]));

    fixture.client.sync_http().expect("sync");
    let rows = assert_table_row_count(&mut fixture.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "memory-1");
}

#[test]
fn app_test_server_applies_pushes_and_later_pull_reads_state() {
    let server = AppTestServer::new(todo::app_schema());
    let mut writer = open_app_client_with_server(
        todo::app_schema(),
        server.clone(),
        app_server_options("app-server-writer"),
    )
    .expect("writer fixture");
    let mut reader = open_app_client_with_server(
        todo::app_schema(),
        server.clone(),
        app_server_options("app-server-reader"),
    )
    .expect("reader fixture");

    writer
        .client
        .add_task(
            "Stateful server task".to_string(),
            Some("app-server-task".to_string()),
        )
        .expect("add task");
    let report = writer.client.sync_http().expect("writer sync");
    assert!(report.changed_tables.contains(&"tasks".to_string()));
    assert_eq!(
        server.row("tasks", "app-server-task").unwrap()["title"],
        "Stateful server task"
    );
    assert_eq!(
        server
            .wait_for_commit_count(1, Duration::from_secs(1))
            .len(),
        1
    );

    let report = reader.client.sync_http().expect("reader sync");
    assert!(report.changed_tables.contains(&"tasks".to_string()));
    let rows = assert_table_row_count(&mut reader.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "app-server-task");
    assert_eq!(rows[0]["title"], "Stateful server task");
    assert_outbox_statuses(&mut writer.client, &["acked"]);
}

#[test]
fn app_test_server_realtime_wakeup_pulls_committed_rows() {
    let server = AppTestServer::new(todo::app_schema());
    let mut writer = open_app_client_with_server(
        todo::app_schema(),
        server.clone(),
        app_server_options("app-server-rt-writer"),
    )
    .expect("writer fixture");
    let mut reader = open_app_client_with_server(
        todo::app_schema(),
        server.clone(),
        app_server_options("app-server-rt-reader"),
    )
    .expect("reader fixture");

    reader.client.sync_http().expect("establish cursor");
    writer
        .client
        .add_task(
            "Realtime server task".to_string(),
            Some("app-server-rt-task".to_string()),
        )
        .expect("add task");
    writer.client.sync_http().expect("writer sync");

    let mut seen = Vec::new();
    let processed = reader
        .client
        .process_realtime_events(1, |event| seen.push(format!("{event:?}")))
        .expect("process realtime");
    assert_eq!(processed, 1);
    assert_eq!(seen, vec!["Sync"]);
    let rows = assert_table_row_count(&mut reader.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "app-server-rt-task");
}

#[test]
fn app_test_http_server_serves_stateful_sync_and_realtime_wakeups() {
    let server = AppTestHttpServer::start(todo::app_schema()).expect("stateful HTTP server");
    let mut socket = connect(server.realtime_url("app-server-http-reader").as_str())
        .expect("websocket")
        .0;
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set websocket timeout");
    }

    let mut writer_options = app_server_options("app-server-http-writer");
    writer_options.base_url = server.url();
    let writer_transport = HttpSyncTransport::new(SyncTransportConfig::new(
        server.url(),
        writer_options.client_id.clone(),
        writer_options.actor_id.clone(),
    ));
    let mut writer =
        open_app_client_with_transport(todo::app_schema(), writer_transport, writer_options)
            .expect("writer fixture");

    let mut reader_options = app_server_options("app-server-http-reader");
    reader_options.base_url = server.url();
    let reader_transport = HttpSyncTransport::new(SyncTransportConfig::new(
        server.url(),
        reader_options.client_id.clone(),
        reader_options.actor_id.clone(),
    ));
    let mut reader =
        open_app_client_with_transport(todo::app_schema(), reader_transport, reader_options)
            .expect("reader fixture");

    reader.client.sync_http().expect("establish cursor");
    writer
        .client
        .add_task(
            "Stateful HTTP task".to_string(),
            Some("app-server-http-task".to_string()),
        )
        .expect("add task");
    writer.client.sync_http().expect("writer HTTP sync");

    let wakeup = socket.read().expect("realtime wakeup");
    assert_eq!(
        wakeup,
        Message::Text(json!({ "event": "sync" }).to_string().into())
    );
    reader.client.sync_http().expect("reader HTTP sync");
    let rows = assert_table_row_count(&mut reader.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "app-server-http-task");
    assert_eq!(rows[0]["title"], "Stateful HTTP task");
    assert_eq!(
        server
            .app_server()
            .row("tasks", "app-server-http-task")
            .unwrap()["title"],
        "Stateful HTTP task"
    );
}

#[test]
fn app_test_http_server_accepts_production_realtime_pushes() {
    let app_schema = todo::app_schema();
    let server = AppTestHttpServer::start(app_schema).expect("stateful HTTP server");
    let schema_version = app_schema.current_schema_version();

    let writer_transport = HttpSyncTransport::new(SyncTransportConfig::new(
        server.url(),
        "app-server-ws-push-writer".to_string(),
        "actor-writer".to_string(),
    ))
    .with_schema_version(schema_version);
    let reader_transport = HttpSyncTransport::new(SyncTransportConfig::new(
        server.url(),
        "app-server-ws-push-reader".to_string(),
        "actor-reader".to_string(),
    ))
    .with_schema_version(schema_version);
    let mut writer_socket = writer_transport
        .connect_realtime()
        .expect("writer websocket");
    let mut reader_socket = reader_transport
        .connect_realtime()
        .expect("reader websocket");

    let response = writer_socket
        .push_commit(PushCommitRequest {
            client_commit_id: "app-server-ws-push-commit".to_string(),
            operations: vec![SyncOperation {
                table: "tasks".to_string(),
                row_id: "app-server-ws-push-task".to_string(),
                op: "upsert".to_string(),
                payload: Some(json!({
                    "id": "app-server-ws-push-task",
                    "title": "WebSocket pushed task",
                    "completed": 0,
                    "user_id": "user-rust",
                    "project_id": "p0"
                })),
                base_version: Some(0),
            }],
            schema_version,
        })
        .expect("websocket push");

    assert_eq!(response.status, "applied");
    assert_eq!(response.commit_seq, Some(1));
    assert_eq!(
        server
            .app_server()
            .row("tasks", "app-server-ws-push-task")
            .expect("server row")["title"],
        "WebSocket pushed task"
    );
    assert_eq!(
        next_realtime_event(&mut reader_socket, Duration::from_secs(2)),
        Some("Sync".to_string())
    );

    writer_socket.close();
    reader_socket.close();
}

#[test]
fn app_test_http_server_reports_stateful_version_conflicts() {
    let server = AppTestHttpServer::start(todo::app_schema()).expect("stateful HTTP server");
    server
        .app_server()
        .seed_row(
            "tasks",
            json!({
                "id": "app-server-http-conflict",
                "title": "Base task",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0",
                "server_version": 1
            }),
        )
        .expect("seed row");

    let mut options = app_server_options("app-server-http-conflict");
    options.base_url = server.url();
    let transport = HttpSyncTransport::new(SyncTransportConfig::new(
        server.url(),
        options.client_id.clone(),
        options.actor_id.clone(),
    ));
    let mut fixture = open_app_client_with_transport(todo::app_schema(), transport, options)
        .expect("client fixture");

    fixture.client.sync_http().expect("bootstrap");
    server
        .app_server()
        .commit_row(
            "tasks",
            json!({
                "id": "app-server-http-conflict",
                "title": "Server edit",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            }),
        )
        .expect("server edit");

    fixture
        .client
        .apply_mutation_json(
            &json!({
                "table": "tasks",
                "row_id": "app-server-http-conflict",
                "op": "upsert",
                "payload": { "title": "Local edit" },
                "base_version": 1
            })
            .to_string(),
            None,
        )
        .expect("local edit");
    let report = fixture.client.sync_http().expect("conflict sync");
    assert!(report.conflicts_changed);

    let conflicts = assert_conflict_count(&mut fixture.client, 1);
    assert_eq!(conflicts[0].code.as_deref(), Some("VERSION_CONFLICT"));
    assert_eq!(conflicts[0].server_version, Some(2));
    assert_eq!(
        server
            .app_server()
            .row("tasks", "app-server-http-conflict")
            .expect("server row")["title"],
        "Server edit"
    );
    let row = assert_table_has_row(
        &mut fixture.client,
        "tasks",
        "id",
        "app-server-http-conflict",
    );
    assert_eq!(row["title"], "Server edit");
}

fn next_realtime_event(
    socket: &mut syncular_runtime::transport::RealtimeSocket,
    timeout: Duration,
) -> Option<String> {
    let started_at = std::time::Instant::now();
    while started_at.elapsed() < timeout {
        match socket.read_event().expect("read realtime event") {
            Some(RealtimeEvent::Sync) => return Some("Sync".to_string()),
            Some(RealtimeEvent::Presence(_)) => return Some("Presence".to_string()),
            Some(RealtimeEvent::Other(event)) => return Some(event),
            None => {}
        }
    }
    None
}

#[test]
fn app_test_server_merges_concurrent_server_merge_crdt_updates() {
    let server = AppTestServer::new(todo::app_schema());
    server
        .seed_row(
            "tasks",
            json!({
                "id": "app-server-crdt-task",
                "title": "",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0",
                "server_version": 0
            }),
        )
        .expect("seed CRDT row");

    let mut client_a = open_app_client_with_server(
        todo::app_schema(),
        server.clone(),
        app_server_options("app-server-crdt-a"),
    )
    .expect("client A fixture");
    let mut client_b = open_app_client_with_server(
        todo::app_schema(),
        server.clone(),
        app_server_options("app-server-crdt-b"),
    )
    .expect("client B fixture");

    client_a.client.sync_http().expect("client A bootstrap");
    client_b.client.sync_http().expect("client B bootstrap");
    apply_crdt_field_text(
        &mut client_a.client,
        "tasks",
        "app-server-crdt-task",
        "title",
        "A",
    );
    apply_crdt_field_text(
        &mut client_b.client,
        "tasks",
        "app-server-crdt-task",
        "title",
        "B",
    );

    client_a.client.sync_http().expect("client A push");
    client_b
        .client
        .sync_http()
        .expect("client B push and pull A");
    client_a.client.sync_http().expect("client A pulls B");

    let a = assert_crdt_field_text_nonblank(
        &mut client_a.client,
        "tasks",
        "app-server-crdt-task",
        "title",
    );
    let b = assert_crdt_field_text_nonblank(
        &mut client_b.client,
        "tasks",
        "app-server-crdt-task",
        "title",
    );
    assert_eq!(a.value, b.value);
    let text = a.value.as_str().expect("materialized CRDT text");
    assert!(
        text.contains('A'),
        "merged CRDT text should contain A: {text}"
    );
    assert!(
        text.contains('B'),
        "merged CRDT text should contain B: {text}"
    );
    assert!(
        server.row("tasks", "app-server-crdt-task").unwrap()["title_yjs_state"]
            .as_str()
            .is_some_and(|state| !state.is_empty())
    );
    assert_eq!(
        server
            .wait_for_commit_count(2, Duration::from_secs(1))
            .len(),
        2
    );
}

#[test]
fn native_fixture_opens_with_direct_schema_and_waits_for_events() {
    let mut fixture = open_native_client_with_schema_options(
        todo::app_schema(),
        NativeFixtureOptions {
            client_options: NativeClientOptions {
                auto_sync_local_writes: false,
            },
            ..NativeFixtureOptions::default()
        },
    )
    .expect("native fixture");

    apply_native_todo_task_upsert(&mut fixture.client, "native-testkit-1", "Native testkit")
        .expect("native upsert");
    let event = syncular_testkit::wait_native_event(
        &fixture.events,
        NativeEventKind::RowsChanged,
        Duration::from_secs(1),
    );
    assert_native_rows_changed(&event, &["tasks"]);

    let rows = assert_native_table_row_count(&mut fixture.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "native-testkit-1");
    fixture.close().expect("close native fixture");
}

#[test]
fn native_fixture_opens_with_generated_schema_json() {
    let mut fixture = open_native_client_with_schema_json_options(
        todo_app_schema_json(),
        NativeFixtureOptions::default(),
    )
    .expect("native fixture");

    apply_native_todo_task_upsert(&mut fixture.client, "native-schema-json-1", "Schema JSON")
        .expect("native upsert");
    let rows = assert_native_table_row_count(&mut fixture.client, "tasks", 1);
    assert_eq!(rows[0]["title"], "Schema JSON");
    fixture.close().expect("close native fixture");
}

#[test]
fn disposable_http_sync_server_captures_native_requests() {
    let server = TestSyncServer::sync_responses([snapshot_combined_response(
        "sub-tasks",
        "tasks",
        vec![todo_task_row("http-snapshot-1", "HTTP snapshot", 12)],
        actor_project_scopes("user-rust", Some("p0")),
        12,
    )])
    .expect("server");
    let fixture = open_native_client_with_schema_options(
        todo::app_schema(),
        NativeFixtureOptions {
            base_url: server.url(),
            ..NativeFixtureOptions::default()
        },
    )
    .expect("native fixture");

    fixture.client.trigger_sync().expect("trigger sync");
    let event = syncular_testkit::wait_native_event(
        &fixture.events,
        NativeEventKind::SyncCompleted,
        Duration::from_secs(2),
    );
    assert_eq!(event.kind, NativeEventKind::SyncCompleted);

    let requests = server.wait_for_requests(1, Duration::from_secs(1));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/sync");
    assert_eq!(
        requests[0].json().expect("sync body")["clientId"],
        "native-test-client"
    );
    let mut fixture = fixture;
    let rows = assert_native_table_row_count(&mut fixture.client, "tasks", 1);
    assert_eq!(rows[0]["id"], "http-snapshot-1");
    fixture.close().expect("close native fixture");
}

#[test]
fn disposable_http_sync_server_covers_auth_expired() {
    let server = TestSyncServer::status(401, "Unauthorized", "expired token").expect("server");
    let fixture = open_native_client_with_schema_options(
        todo::app_schema(),
        NativeFixtureOptions {
            base_url: server.url(),
            ..NativeFixtureOptions::default()
        },
    )
    .expect("native fixture");

    fixture.client.trigger_sync().expect("trigger sync");
    let event = syncular_testkit::wait_native_event(
        &fixture.events,
        NativeEventKind::AuthExpired,
        Duration::from_secs(2),
    );
    assert_native_error_kind(&event, ErrorKind::Transport);
    fixture.close().expect("close native fixture");
}

#[test]
fn disposable_blob_server_captures_upload_and_download_requests() {
    let hash = "sha256:test-hash";
    let server = TestBlobServer::start_with_options(
        TestBlobServerOptions::new(vec![1, 2, 3, 4], hash)
            .upload_path("/upload")
            .download_path("/download")
            .upload_token("blob-token"),
    )
    .expect("blob server");

    let upload_start = raw_http_request(
        server.addr(),
        "POST",
        "/sync/blobs/upload",
        &[("authorization", "Bearer blob")],
        &[],
    );
    let upload_start_body = String::from_utf8_lossy(response_body(&upload_start));
    assert!(
        upload_start_body.contains(r#""x-upload-token":"blob-token""#),
        "unexpected upload-start body: {upload_start_body}"
    );

    let upload = raw_http_request(
        server.addr(),
        "PUT",
        "/upload",
        &[("x-upload-token", "blob-token")],
        &[9, 8, 7],
    );
    assert_eq!(response_body(&upload), b"OK");

    let complete = raw_http_request(
        server.addr(),
        "POST",
        &format!("/sync/blobs/{}/complete", encoded_blob_hash(hash)),
        &[],
        &[],
    );
    assert_eq!(response_body(&complete), br#"{"ok":true}"#);

    let url = raw_http_request(
        server.addr(),
        "POST",
        &format!("/sync/blobs/{}/url", encoded_blob_hash(hash)),
        &[],
        &[],
    );
    let url_body = String::from_utf8_lossy(response_body(&url));
    assert!(url_body.contains("http://"));
    assert!(url_body.contains("/download"));

    let download = raw_http_request(server.addr(), "GET", "/download", &[], &[]);
    assert_eq!(response_body(&download), &[1, 2, 3, 4]);

    let requests = server.wait_for_requests(5, Duration::from_secs(1));
    let expected_paths = [
        "/sync/blobs/upload",
        "/upload",
        "/sync/blobs/sha256%3Atest-hash/complete",
        "/sync/blobs/sha256%3Atest-hash/url",
        "/download",
    ];
    let paths = requests
        .iter()
        .map(|request| request.path.as_str())
        .collect::<Vec<_>>();
    assert!(
        paths
            .windows(expected_paths.len())
            .any(|window| window == expected_paths),
        "expected blob request path sequence in {paths:?}"
    );
    assert!(requests.iter().any(|request| {
        request.path == "/sync/blobs/upload"
            && request.header("authorization") == Some("Bearer blob")
    }));
    assert!(requests
        .iter()
        .any(|request| request.path == "/upload" && request.body == vec![9, 8, 7]));
}

#[test]
fn protocol_builders_cover_conflict_flow() {
    let mut fixture = open_todo_client().expect("todo fixture");
    fixture
        .client
        .add_task(
            "Local conflict".to_string(),
            Some("conflict-builder-task".to_string()),
        )
        .expect("local task");

    let requests_before = fixture.transport.handle().requests();
    assert!(requests_before.is_empty());
    fixture.transport.push_http_response_fn(|request| {
        Ok(push_conflict_response(
            request,
            "version conflict",
            "VERSION_CONFLICT",
            todo_task_row("conflict-builder-task", "Server conflict", 9),
            9,
        ))
    });

    fixture.client.sync_http().expect("sync conflict");
    assert_eq!(fixture.transport.handle().request_count(), 1);
    let conflicts = syncular_testkit::assert_conflict_count(&mut fixture.client, 1);
    assert_eq!(conflicts[0].code.as_deref(), Some("VERSION_CONFLICT"));
    let row = assert_table_has_row(&mut fixture.client, "tasks", "id", "conflict-builder-task");
    assert_eq!(row["title"], "Local conflict");
}

#[test]
fn crdt_helpers_assert_materialized_text() {
    let mut fixture = open_todo_client().expect("todo fixture");
    fixture
        .client
        .apply_mutation_json(
            &json!({
                "table": "tasks",
                "row_id": "crdt-testkit-1",
                "op": "upsert",
                "payload": {
                    "title": "",
                    "completed": 0,
                    "user_id": "user-rust",
                    "project_id": "p0"
                },
                "base_version": 0
            })
            .to_string(),
            None,
        )
        .expect("seed CRDT row");

    let receipt = apply_crdt_field_text(
        &mut fixture.client,
        "tasks",
        "crdt-testkit-1",
        "title",
        "CRDT testkit",
    );
    assert!(!receipt.client_commit_id.is_empty());
    assert_crdt_field_materializes(
        &mut fixture.client,
        "tasks",
        "crdt-testkit-1",
        "title",
        json!("CRDT testkit"),
    );
}

#[test]
fn native_crdt_helpers_assert_materialized_text() {
    let mut fixture =
        open_native_client_with_schema_options(todo::app_schema(), NativeFixtureOptions::default())
            .expect("native fixture");
    apply_native_todo_task_upsert(&mut fixture.client, "native-crdt-testkit-1", "")
        .expect("seed native row");

    let receipt = apply_native_crdt_field_text(
        &mut fixture.client,
        "tasks",
        "native-crdt-testkit-1",
        "title",
        "Native CRDT testkit",
    );
    assert!(receipt["clientCommitId"].as_str().is_some());
    assert_native_crdt_field_materializes(
        &mut fixture.client,
        "tasks",
        "native-crdt-testkit-1",
        "title",
        json!("Native CRDT testkit"),
    );
    fixture.close().expect("close native fixture");
}

#[test]
fn realtime_events_are_scriptable() {
    let mut fixture = open_todo_client().expect("todo fixture");
    fixture
        .transport
        .push_http_response(todo_snapshot_response(vec![todo_task_row(
            "remote-ws",
            "Realtime task",
            10,
        )]));
    fixture
        .transport
        .push_realtime_event(RealtimeEvent::Other("presence".to_string()));
    fixture.transport.push_realtime_event(RealtimeEvent::Sync);

    let mut seen = Vec::new();
    let processed = fixture
        .client
        .process_realtime_events(2, |event| seen.push(format!("{event:?}")))
        .expect("realtime events");

    assert_eq!(processed, 2);
    assert_eq!(seen[0], "Other(\"presence\")");
    assert_eq!(fixture.transport.handle().closed_realtime_count(), 1);
    assert_eq!(fixture.client.list_tasks().expect("list tasks").len(), 1);
}

#[test]
fn fault_transport_can_fail_before_sync() {
    let base = TestTransport::new();
    let handle = base.handle();
    let transport = FaultTransport::new(
        base,
        [FaultStep::fail(
            FaultPhase::Before,
            FaultOperation::AnySync,
            "network down",
        )],
    );
    let fault_handle = transport.handle();
    let mut fixture = open_todo_client_with_transport(transport, TodoFixtureOptions::default())
        .expect("todo fixture");

    let error = fixture
        .client
        .sync_http()
        .expect_err("expected sync failure");
    assert_eq!(error.kind(), ErrorKind::Transport);
    assert!(error.message_text().contains("network down"));
    assert_eq!(fault_handle.failures(), 1);
    assert!(handle.requests().is_empty());
}

#[test]
fn fault_transport_can_delay_after_sync() {
    let base = TestTransport::new();
    let transport = FaultTransport::new(
        base,
        [FaultStep::delay(
            FaultPhase::After,
            FaultOperation::Pull,
            Duration::from_millis(1),
        )],
    );
    let fault_handle = transport.handle();
    let mut fixture = open_todo_client_with_transport(transport, TodoFixtureOptions::default())
        .expect("todo fixture");

    fixture.client.sync_http().expect("sync");
    assert_eq!(fault_handle.delays(), 1);
}

#[test]
fn blob_queue_assertions_use_real_store() {
    let mut fixture = open_todo_client().expect("todo fixture");

    let blob_json = fixture
        .client
        .store_blob_file_local_json(
            fixture.db_path().as_ref(),
            "application/octet-stream",
            false,
        )
        .expect("local blob");
    let blob: serde_json::Value = serde_json::from_str(&blob_json).expect("blob json");
    assert!(blob["hash"].as_str().expect("hash").starts_with("sha256:"));
    assert_blob_upload_queue(&mut fixture.client, 0, 0, 0);
}

#[test]
fn default_response_acknowledges_pushes() {
    let request = syncular_runtime::protocol::CombinedRequest {
        client_id: "client".to_string(),
        sync_pack_encodings: Vec::new(),
        push: Some(syncular_runtime::protocol::PushBatchRequest {
            commits: vec![syncular_runtime::protocol::PushCommitRequest {
                client_commit_id: "commit-1".to_string(),
                operations: vec![syncular_runtime::protocol::SyncOperation {
                    table: "tasks".to_string(),
                    row_id: "task-1".to_string(),
                    op: "upsert".to_string(),
                    payload: Some(json!({ "id": "task-1" })),
                    base_version: None,
                }],
                schema_version: 1,
            }],
        }),
        pull: None,
    };

    let response = default_combined_response(&request);
    let commit = &response.push.expect("push").commits[0];
    assert_eq!(commit.status, "applied");
    assert_eq!(commit.results[0].server_version, Some(1));
}

#[test]
fn outbox_empty_assertion_reports_real_state() {
    let mut fixture = open_todo_client().expect("todo fixture");
    assert_outbox_empty(&mut fixture.client);
}

fn app_server_options(client_id: &str) -> AppFixtureOptions {
    AppFixtureOptions {
        db_prefix: format!("syncular-app-server-{client_id}"),
        client_id: client_id.to_string(),
        ..AppFixtureOptions::default()
    }
}

fn raw_http_request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Vec<u8> {
    for _ in 0..5 {
        let response = raw_http_request_once(addr, method, path, headers, body);
        if !response_body(&response).is_empty() {
            return response;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    raw_http_request_once(addr, method, path, headers, body)
}

fn raw_http_request_once(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).expect("connect test server");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nhost: {addr}\r\ncontent-length: {}\r\n",
        body.len()
    )
    .into_bytes();
    for (name, value) in headers {
        request.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(body);
    stream.write_all(&request).expect("write request");
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&buffer[..n]),
            Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => break,
            Err(err) => panic!("read response: {err}"),
        }
    }
    response
}

fn response_body(response: &[u8]) -> &[u8] {
    let marker = b"\r\n\r\n";
    response
        .windows(marker.len())
        .position(|window| window == marker)
        .map(|index| &response[index + marker.len()..])
        .unwrap_or_default()
}
