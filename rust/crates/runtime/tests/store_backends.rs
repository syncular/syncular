use std::sync::{Arc, Mutex};
use std::time::Duration;

use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use syncular_runtime::app_schema::{
    app_schema_from_json, AppSchema, AppTableMetadata, CrdtYjsFieldMetadata,
};
use syncular_runtime::binary_snapshot::SnapshotChunkRows;
use syncular_runtime::client::{SubscriptionSpec, SyncularEncryptedCrdtMutationExecutor};
use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::compaction::{StorageCompactionOptions, StorageCompactionReport};
use syncular_runtime::crdt_yjs::{
    build_yjs_text_update, yjs_state_vector_base64, BuildYjsTextUpdateArgs, YJS_PAYLOAD_KEY,
};
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::encrypted_crdt::{
    BuildEncryptedCrdtCheckpointArgs, BuildEncryptedCrdtTextUpdateArgs,
    BuildEncryptedCrdtYjsUpdateArgs, EncryptedCrdt, StaticEncryptedCrdtConfig,
    CRDT_CHECKPOINTS_TABLE, CRDT_UPDATES_TABLE,
};
use syncular_runtime::encryption::{key_to_base64url, FieldEncryptionContext};
use syncular_runtime::error::{ErrorKind, Result, SyncularError};
use syncular_runtime::fixtures::todo::migrations::{current_schema_version, MIGRATIONS};
use syncular_runtime::fixtures::todo::rusqlite_sqlite::RusqliteStore;
use syncular_runtime::fixtures::todo::{
    app_schema as demo_todo_app_schema, diesel_tables, generated, migrations,
};
use syncular_runtime::protocol::{
    CombinedRequest, CombinedResponse, PullResponse, PushCommitRequest, PushCommitResponse,
    ScopeValues, SnapshotChunkRef, SubscriptionResponse, SyncChange, SyncCommit, SyncOperation,
    SyncSnapshot,
};
use syncular_runtime::store::{now_ms, DemoTaskStore, SyncStateStore, SyncStore, SyncStoreTx};
use syncular_runtime::transport::{RealtimeEvent, RealtimeTransport, SyncTransport};
use syncular_runtime::worker::{SyncWorker, SyncWorkerEvent};
use syncular_testkit::{
    push_conflict_response, revoked_subscription_response, snapshot_combined_response,
    unique_temp_db_path, TestTransport,
};

const ENCRYPTED_TASKS_CRDT_YJS_FIELDS: &[CrdtYjsFieldMetadata] = &[CrdtYjsFieldMetadata {
    field: "title",
    state_column: "title_yjs_state",
    container_key: "title",
    row_id_field: "id",
    kind: "text",
    sync_mode: "encrypted-update-log",
}];

const ENCRYPTED_TASKS_METADATA: AppTableMetadata = AppTableMetadata {
    name: "tasks",
    primary_key_column: "id",
    server_version_column: "server_version",
    soft_delete_column: None,
    columns: generated::TASKS_COLUMNS,
    blob_columns: generated::TASKS_BLOB_COLUMNS,
    crdt_yjs_fields: ENCRYPTED_TASKS_CRDT_YJS_FIELDS,
    encrypted_fields: generated::TASKS_ENCRYPTED_FIELDS,
    scopes: generated::TASKS_SCOPES,
    subscription_id: "sub-tasks",
};

const ENCRYPTED_APP_TABLE_METADATA: &[AppTableMetadata] = &[
    generated::COMMENTS_METADATA,
    generated::PROJECTS_METADATA,
    ENCRYPTED_TASKS_METADATA,
];

#[test]
fn diesel_store_applies_migrations_and_stamps_outbox_schema_version() -> Result<()> {
    let path = temp_db_path("syncular-diesel-store");
    let mut store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    assert_store_basics(&mut store)?;
    let schema_state = store.app_schema_state()?;
    assert_eq!(schema_state.schema_id, "syncular-app");
    assert_eq!(schema_state.schema_version, Some(current_schema_version()));
    assert_eq!(
        schema_state.current_schema_version,
        current_schema_version()
    );
    assert!(schema_state.updated_at.is_some());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_store_rejects_future_local_app_schema_state() -> Result<()> {
    let path = temp_db_path("syncular-diesel-future-app-schema");
    let store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;
    drop(store);

    let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
    sql_query("update syncular_app_schema set schema_version = ? where schema_id = 'syncular-app'")
        .bind::<Integer, _>(current_schema_version() + 1)
        .execute(&mut conn)?;
    drop(conn);

    let error = match DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema()) {
        Ok(_) => panic!("future local app schema version should be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), ErrorKind::Schema);
    assert!(error
        .message_text()
        .contains("Syncular app schema version mismatch"));

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_store_applies_sqlite_runtime_pragmas() -> Result<()> {
    let path = temp_db_path("syncular-diesel-pragmas");
    let mut store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    let pragmas = store.runtime_pragma_report()?;
    assert_eq!(pragmas.journal_mode, "wal");
    assert_eq!(pragmas.foreign_keys, 1);
    assert_eq!(pragmas.busy_timeout, 5_000);
    assert_eq!(pragmas.synchronous, 1);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_default_schema_installs_runtime_tables_without_demo_app_tables() -> Result<()> {
    let path = temp_db_path("syncular-diesel-default-schema");
    let mut store = DieselSqliteStore::open(&path)?;

    let error = store
        .list_table_json("tasks")
        .expect_err("default schema should not expose demo app tables");
    assert_eq!(error.kind(), ErrorKind::Config);
    drop(store);

    let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
    assert_eq!(
        count_rows(
            &mut conn,
            "select count(*) as count from sqlite_master where type = 'table' and name = 'sync_outbox_commits'"
        )?,
        1
    );
    assert_eq!(
        count_rows(
            &mut conn,
            "select count(*) as count from sqlite_master where type = 'table' and name in ('comments', 'projects', 'tasks')"
        )?,
        0
    );

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rusqlite_store_applies_migrations_and_stamps_outbox_schema_version() -> Result<()> {
    let path = temp_db_path("syncular-rusqlite-store");
    let mut store = RusqliteStore::open(&path)?;

    assert_store_basics(&mut store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_store_applies_generic_json_operations() -> Result<()> {
    let path = temp_db_path("syncular-diesel-json-store");
    let mut store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    assert_generic_json_operations(&mut store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_store_uses_metadata_backed_json_tables_without_generated_adapter() -> Result<()> {
    let path = temp_db_path("syncular-diesel-dynamic-schema");
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
    let app_schema = app_schema_from_json(
        &json!({
            "schemaVersion": 12,
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
    )?;
    let mut store = DieselSqliteStore::open_with_schema(&path, app_schema)?;

    store.apply_local_operation(
        SyncOperation {
            table: "notes".to_string(),
            row_id: "note-1".to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({
                "body": "First",
                "owner_id": "user-rust"
            })),
            base_version: None,
        },
        None,
    )?;

    store.apply_local_operation(
        SyncOperation {
            table: "notes".to_string(),
            row_id: "note-1".to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({ "body": "Updated" })),
            base_version: Some(0),
        },
        None,
    )?;

    let rows = store.list_table_json("notes")?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["note_key"], "note-1");
    assert_eq!(rows[0]["body"], "Updated");
    assert_eq!(rows[0]["owner_id"], "user-rust");
    assert_eq!(rows[0]["server_version"], 0);
    assert_eq!(store.outbox_summaries()?[0].schema_version, 12);

    let mut scopes = ScopeValues::new();
    scopes.insert(
        "user_id".to_string(),
        Value::String("user-rust".to_string()),
    );
    store.transaction(|tx| tx.clear_table_for_scopes("notes", &scopes))?;
    assert!(store.list_table_json("notes")?.is_empty());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_store_materializes_yjs_envelopes_before_local_write() -> Result<()> {
    let path = temp_db_path("syncular-diesel-yjs-store");
    let mut store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    let base = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Draft".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("base".to_string()),
    })?;
    store.apply_local_operation(
        SyncOperation {
            table: "tasks".to_string(),
            row_id: "yjs-task".to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({
                "title": "Draft",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0",
                "title_yjs_state": base.next_state_base64
            })),
            base_version: Some(0),
        },
        None,
    )?;

    let next = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: Some(base.next_state_base64),
        next_text: "Draft v2".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("next".to_string()),
    })?;
    store.apply_local_operation(
        SyncOperation {
            table: "tasks".to_string(),
            row_id: "yjs-task".to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({
                "__yjs": {
                    "title": next.update
                }
            })),
            base_version: Some(1),
        },
        None,
    )?;

    let rows = store.list_table_json("tasks")?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], "Draft v2");
    assert!(rows[0]["title_yjs_state"].as_str().is_some());
    assert!(rows[0].get(YJS_PAYLOAD_KEY).is_none());

    let pending = store.transaction(|tx| tx.pending_outbox(10))?;
    let latest = pending
        .last()
        .ok_or_else(|| SyncularError::protocol_message("expected pending Yjs outbox commit"))?;
    let operations: Vec<SyncOperation> = serde_json::from_str(&latest.operations_json)?;
    assert!(operations[0]
        .payload
        .as_ref()
        .and_then(|payload| payload.get(YJS_PAYLOAD_KEY))
        .is_some());

    store.transaction(|tx| {
        tx.upsert_row(
            "tasks",
            &json!({
                "id": "snapshot-yjs-task",
                "title": "stale snapshot title",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0",
                "server_version": 7,
                "title_yjs_state": rows[0]["title_yjs_state"].clone()
            }),
            None,
        )
    })?;
    let rows = store.list_table_json("tasks")?;
    let snapshot_row = rows
        .iter()
        .find(|row| row["id"] == "snapshot-yjs-task")
        .ok_or_else(|| SyncularError::protocol_message("expected materialized snapshot row"))?;
    assert_eq!(snapshot_row["title"], "Draft v2");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_store_accepts_encrypted_crdt_system_rows() -> Result<()> {
    let path = temp_db_path("syncular-diesel-encrypted-crdt-system");
    let mut store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    let update = SyncOperation {
        table: "sync_crdt_updates".to_string(),
        row_id: "update-1".to_string(),
        op: "upsert".to_string(),
        payload: Some(json!({
            "stream_id": "tasks:task-1:body",
            "app_table": "tasks",
            "row_id": "task-1",
            "field_name": "body",
            "update_id": "update-1",
            "key_id": "kid-1",
            "ciphertext": "ciphertext",
            "scopes": { "user_id": "user-rust" }
        })),
        base_version: None,
    };
    let commit_id = store.apply_local_operation(update, None)?;
    assert!(!commit_id.is_empty());
    assert_eq!(store.outbox_summaries()?.len(), 1);

    store.transaction(|tx| {
        tx.apply_change(&SyncChange {
            table: "sync_crdt_checkpoints".to_string(),
            row_id: "checkpoint-1".to_string(),
            op: "upsert".to_string(),
            row_json: Some(json!({
                "stream_id": "tasks:task-1:body",
                "app_table": "tasks",
                "row_id": "task-1",
                "field_name": "body",
                "checkpoint_id": "checkpoint-1",
                "covers_seq": 1,
                "key_id": "kid-1",
                "ciphertext": "checkpoint-ciphertext",
                "scopes": { "user_id": "user-rust" }
            })),
            row_version: Some(1),
            scopes: ScopeValues::new(),
        })
    })?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_applies_local_encrypted_crdt_text_update() -> Result<()> {
    let path = temp_db_path("syncular-diesel-encrypted-crdt-local");
    let store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let mut client = SyncularClient::with_app_schema_parts(
        test_config(&path),
        store,
        TestTransport::new(),
        encrypted_app_schema(),
    );
    client.set_encrypted_crdt(Some(test_encrypted_crdt()?));

    client.add_task(
        "Local initial".to_string(),
        Some("encrypted-local-task".to_string()),
    )?;
    client.apply_encrypted_crdt_text_update(
        &ENCRYPTED_TASKS_METADATA,
        "title",
        "encrypted-local-task",
        "Local secret",
    )?;

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "Local secret");
    assert!(tasks[0].title_yjs_state.as_deref().is_some());

    let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
    let operations = outbox_operations(&mut conn)?;
    assert_eq!(operations.len(), 2);
    let encrypted_operation = operations
        .iter()
        .flatten()
        .find(|operation| operation.table == CRDT_UPDATES_TABLE)
        .ok_or_else(|| SyncularError::protocol_message("missing encrypted CRDT outbox op"))?;
    let payload = encrypted_operation.payload.as_ref().expect("payload");
    assert!(payload.get("ciphertext").and_then(Value::as_str).is_some());
    assert!(payload.get("update_base64").is_none());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn sync_worker_enqueues_encrypted_crdt_yjs_update() -> Result<()> {
    let path = temp_db_path("syncular-worker-encrypted-crdt-yjs");
    let store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let mut client = SyncularClient::with_app_schema_parts(
        test_config(&path),
        store,
        TestTransport::new(),
        encrypted_app_schema(),
    );
    client.add_task(
        "Worker initial".to_string(),
        Some("worker-encrypted-task".to_string()),
    )?;

    let update = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Worker secret".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("worker-secret-update".to_string()),
    })?;

    let worker = SyncWorker::start(client);
    worker.set_encrypted_crdt(Some(test_encrypted_crdt()?))?;
    worker.enqueue_encrypted_crdt_update_json(
        "worker-ecrdt-1".to_string(),
        json!({
            "table": "tasks",
            "rowId": "worker-encrypted-task",
            "field": "title",
            "update": update.update
        })
        .to_string(),
        false,
    )?;

    let event = worker
        .recv_event_timeout(Duration::from_secs(2))
        .expect("encrypted CRDT worker event");
    match event {
        SyncWorkerEvent::LocalWriteCommitted {
            command_id,
            client_commit_id,
            changed_tables,
            ..
        } => {
            assert_eq!(command_id, "worker-ecrdt-1");
            assert!(!client_commit_id.is_empty());
            assert_eq!(
                changed_tables,
                vec!["tasks".to_string(), CRDT_UPDATES_TABLE.to_string()]
            );
        }
        SyncWorkerEvent::LocalWriteFailed { error, .. } => {
            panic!(
                "encrypted CRDT worker update failed: {}",
                error.debug_text()
            );
        }
        other => panic!("unexpected encrypted CRDT worker event: {other:?}"),
    }
    worker.stop()?;

    let mut store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let tasks = store.list_table_json("tasks")?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["title"], "Worker secret");
    assert!(tasks[0]["title_yjs_state"].as_str().is_some());

    let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
    let operations = outbox_operations(&mut conn)?;
    let encrypted_operation = operations
        .iter()
        .flatten()
        .find(|operation| operation.table == CRDT_UPDATES_TABLE)
        .ok_or_else(|| SyncularError::protocol_message("missing encrypted CRDT worker op"))?;
    let payload = encrypted_operation.payload.as_ref().expect("payload");
    assert!(payload.get("ciphertext").and_then(Value::as_str).is_some());
    assert!(payload.get("update_base64").is_none());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_decrypts_pulled_encrypted_crdt_update_and_materializes_row() -> Result<()> {
    let path = temp_db_path("syncular-diesel-encrypted-crdt-pull");
    let encryption = test_encrypted_crdt()?;
    let encrypted_update = encrypted_remote_title_update(&encryption, "encrypted-pull-task")?;
    let store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let transport = EncryptedCrdtPullTransport { encrypted_update };
    let mut client = SyncularClient::with_app_schema_parts(
        test_config(&path),
        store,
        transport,
        encrypted_app_schema(),
    );
    client.set_encrypted_crdt(Some(encryption));

    let report = client.sync_http()?;
    assert!(report.changes_table("tasks"));
    assert!(report.changes_table(CRDT_UPDATES_TABLE));

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "encrypted-pull-task");
    assert_eq!(tasks[0].title, "Remote secret");
    assert!(tasks[0].title_yjs_state.as_deref().is_some());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_decrypts_pulled_encrypted_crdt_checkpoint_without_updates() -> Result<()> {
    let path = temp_db_path("syncular-diesel-encrypted-crdt-checkpoint-pull");
    let encryption = test_encrypted_crdt()?;
    let encrypted_checkpoint =
        encrypted_remote_title_checkpoint(&encryption, "encrypted-checkpoint-task", 7)?;
    let store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let transport = EncryptedCrdtCheckpointPullTransport {
        encrypted_checkpoint,
    };
    let mut client = SyncularClient::with_app_schema_parts(
        test_config(&path),
        store,
        transport,
        encrypted_app_schema(),
    );
    client.set_encrypted_crdt(Some(encryption));

    let report = client.sync_http()?;
    assert!(report.changes_table("tasks"));
    assert!(report.changes_table(CRDT_CHECKPOINTS_TABLE));

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "encrypted-checkpoint-task");
    assert_eq!(tasks[0].title, "Checkpoint secret");
    assert!(tasks[0].title_yjs_state.as_deref().is_some());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_recovers_encrypted_crdt_update_after_required_base_resync() -> Result<()> {
    let path = temp_db_path("syncular-diesel-encrypted-crdt-resync");
    let encryption = test_encrypted_crdt()?;
    let (encrypted_update, recovery_checkpoint) =
        encrypted_remote_title_update_requiring_base(&encryption, "encrypted-resync-task")?;
    let transport =
        EncryptedCrdtRequiredBaseRecoveryTransport::new(encrypted_update, recovery_checkpoint);
    let store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let mut client = SyncularClient::with_app_schema_parts(
        test_config(&path),
        store,
        transport.clone(),
        encrypted_app_schema(),
    );
    client.set_encrypted_crdt(Some(encryption));
    client.set_subscriptions(encrypted_crdt_test_subscriptions());

    let err = client
        .sync_http()
        .expect_err("missing encrypted CRDT base should require resync");
    let message = err.to_string();
    assert!(message.contains("encrypted-required-next"));
    assert!(message.contains("full snapshot resync required"));

    let reset_count = client.force_subscriptions_bootstrap(&[])?;
    assert_eq!(reset_count, 3);
    client.sync_http()?;

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "encrypted-resync-task");
    assert_eq!(tasks[0].title, "Encrypted recovered");
    assert!(tasks[0].title_yjs_state.as_deref().is_some());

    let requests = transport.requests();
    let recovery_subscriptions = requests
        .iter()
        .filter_map(|request| request.pull.as_ref())
        .flat_map(|pull| pull.subscriptions.iter())
        .filter(|subscription| subscription.cursor == -1)
        .map(|subscription| subscription.id.as_str())
        .collect::<Vec<_>>();
    assert!(recovery_subscriptions.contains(&"sub-tasks-title-crdt-updates"));
    assert!(recovery_subscriptions.contains(&"sub-tasks-title-crdt-checkpoints"));

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_checkpoints_and_compacts_encrypted_crdt_updates() -> Result<()> {
    let path = temp_db_path("syncular-diesel-encrypted-crdt-checkpoint-compact");
    let encryption = test_encrypted_crdt()?;
    let encrypted_update = encrypted_remote_title_update(&encryption, "encrypted-pull-task")?;
    let store = DieselSqliteStore::open_with_schema(&path, encrypted_app_schema())?;
    let transport = EncryptedCrdtPullTransport { encrypted_update };
    let mut client = SyncularClient::with_app_schema_parts(
        test_config(&path),
        store,
        transport,
        encrypted_app_schema(),
    );
    client.set_encrypted_crdt(Some(encryption));
    client.sync_http()?;
    assert_eq!(client.list_tasks()?[0].title, "Remote secret");

    let checkpoint = client.apply_encrypted_crdt_checkpoint(
        &ENCRYPTED_TASKS_METADATA,
        "title",
        "encrypted-pull-task",
        1,
    )?;
    assert!(checkpoint.is_some());

    {
        let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
        assert_eq!(
            count_rows(
                &mut conn,
                "select count(*) as count from sync_crdt_updates where server_seq = 2"
            )?,
            1
        );
        assert_eq!(
            count_rows(
                &mut conn,
                "select count(*) as count from sync_crdt_checkpoints where covers_seq = 2"
            )?,
            1
        );
        sql_query("update sync_crdt_checkpoints set server_seq = 3").execute(&mut conn)?;
    }

    let options = StorageCompactionOptions {
        prune_encrypted_crdt_updates: Some(true),
        max_encrypted_crdt_checkpoints_per_stream: Some(1),
        ..StorageCompactionOptions::default()
    };
    let report: StorageCompactionReport = serde_json::from_str(
        &client.compact_storage_json(Some(&serde_json::to_string(&options)?))?,
    )?;
    assert_eq!(report.encrypted_crdt_updates_deleted, 1);
    assert_eq!(report.encrypted_crdt_checkpoints_deleted, 0);
    let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
    assert_eq!(
        count_rows(&mut conn, "select count(*) as count from sync_crdt_updates")?,
        0
    );

    let tasks = client.list_tasks()?;
    assert_eq!(tasks[0].title, "Remote secret");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rusqlite_store_applies_generic_json_operations() -> Result<()> {
    let path = temp_db_path("syncular-rusqlite-json-store");
    let mut store = RusqliteStore::open(&path)?;

    assert_generic_json_operations(&mut store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_retries_keep_local_conflicts() -> Result<()> {
    let path = temp_db_path("syncular-diesel-conflict-store");
    let store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    assert_keep_local_retry_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rusqlite_client_retries_keep_local_conflicts() -> Result<()> {
    let path = temp_db_path("syncular-rusqlite-conflict-store");
    let store = RusqliteStore::open(&path)?;

    assert_keep_local_retry_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_defers_transport_retry_until_backoff_is_due() -> Result<()> {
    let path = temp_db_path("syncular-diesel-retry-backoff");
    let store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    assert_transport_retry_backoff_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rusqlite_client_defers_transport_retry_until_backoff_is_due() -> Result<()> {
    let path = temp_db_path("syncular-rusqlite-retry-backoff");
    let store = RusqliteStore::open(&path)?;

    assert_transport_retry_backoff_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_applies_snapshots() -> Result<()> {
    let path = temp_db_path("syncular-diesel-snapshot-store");
    let store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    assert_snapshot_apply_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rusqlite_client_applies_snapshots() -> Result<()> {
    let path = temp_db_path("syncular-rusqlite-snapshot-store");
    let store = RusqliteStore::open(&path)?;

    assert_snapshot_apply_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn diesel_client_clears_scoped_rows_on_revocation() -> Result<()> {
    let path = temp_db_path("syncular-diesel-revocation-store");
    let store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;

    assert_revocation_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rusqlite_client_clears_scoped_rows_on_revocation() -> Result<()> {
    let path = temp_db_path("syncular-rusqlite-revocation-store");
    let store = RusqliteStore::open(&path)?;

    assert_revocation_parity(path.clone(), store)?;

    let _ = std::fs::remove_file(path);
    Ok(())
}

fn assert_store_basics(store: &mut (impl DemoTaskStore + SyncStateStore)) -> Result<()> {
    let migrations = store.applied_migrations()?;
    assert_eq!(migrations.len(), MIGRATIONS.len());
    assert_eq!(migrations[0].version, MIGRATIONS[0].version);
    assert_eq!(migrations[0].name, MIGRATIONS[0].name);

    store.add_task(
        "user-rust",
        Some("p0"),
        "task-store-parity".to_string(),
        "Store parity".to_string(),
    )?;

    let tasks = store.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task-store-parity");
    assert_eq!(tasks[0].title, "Store parity");
    assert_eq!(tasks[0].user_id, "user-rust");
    assert_eq!(tasks[0].project_id.as_deref(), Some("p0"));

    let outbox = store.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "pending");
    assert_eq!(outbox[0].schema_version, current_schema_version());

    let conflicts = store.conflict_summaries()?;
    assert!(conflicts.is_empty());

    Ok(())
}

trait GenericJsonStore {
    fn list_table_json(&mut self, table: &str) -> Result<Vec<Value>>;

    fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String>;
}

impl GenericJsonStore for DieselSqliteStore {
    fn list_table_json(&mut self, table: &str) -> Result<Vec<Value>> {
        DieselSqliteStore::list_table_json(self, table)
    }

    fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        DieselSqliteStore::apply_local_operation(self, operation, local_row)
    }
}

impl GenericJsonStore for RusqliteStore {
    fn list_table_json(&mut self, table: &str) -> Result<Vec<Value>> {
        RusqliteStore::list_table_json(self, table)
    }

    fn apply_local_operation(
        &mut self,
        operation: SyncOperation,
        local_row: Option<Value>,
    ) -> Result<String> {
        RusqliteStore::apply_local_operation(self, operation, local_row)
    }
}

fn assert_generic_json_operations(store: &mut impl GenericJsonStore) -> Result<()> {
    let upsert = json!({
        "table": "tasks",
        "row_id": "json-parity-task",
        "op": "upsert",
        "payload": {
            "title": "JSON parity",
            "completed": 0,
            "user_id": "user-rust",
            "project_id": "p0"
        },
        "base_version": 0
    });
    let commit_id = store.apply_local_operation(serde_json::from_value(upsert)?, None)?;
    assert!(!commit_id.is_empty());

    let rows = store.list_table_json("tasks")?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], "json-parity-task");
    assert_eq!(rows[0]["title"], "JSON parity");

    let delete = json!({
        "table": "tasks",
        "row_id": "json-parity-task",
        "op": "delete",
        "payload": null,
        "base_version": 0
    });
    store.apply_local_operation(serde_json::from_value(delete)?, None)?;
    assert!(store.list_table_json("tasks")?.is_empty());

    let internal_table_error = store
        .list_table_json("sync_outbox_commits")
        .expect_err("internal table should not be exposed through generated reads");
    assert_eq!(internal_table_error.kind(), ErrorKind::Config);

    Ok(())
}

fn assert_keep_local_retry_parity<S>(path: String, store: S) -> Result<()>
where
    S: SyncStore + SyncStateStore + DemoTaskStore,
{
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response_fn(|request| {
        Ok(push_conflict_response(
            request,
            "version conflict",
            "sync.version_conflict",
            json!({
                "id": "conflict-parity-task",
                "title": "Server winner",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0",
                "server_version": 9
            }),
            9,
        ))
    });
    let mut client = demo_client(test_config(&path), store, transport);

    client.add_task(
        "Conflict candidate".to_string(),
        Some("conflict-parity-task".to_string()),
    )?;
    let report = client.sync_http()?;
    assert!(report.conflicts_changed);

    let conflicts = client.conflict_summaries()?;
    assert_eq!(conflicts.len(), 1);
    let retry_commit_id = client.retry_conflict_keep_local(&conflicts[0].id)?;
    assert!(!retry_commit_id.is_empty());
    assert!(client.conflict_summaries()?.is_empty());

    client.sync_http()?;

    let requests = handle.requests();
    assert_eq!(requests.len(), 2);
    let retry_push = requests[1].push.as_ref().expect("retry push");
    assert_eq!(retry_push.commits.len(), 1);
    assert_eq!(
        retry_push.commits[0].operations[0].row_id,
        "conflict-parity-task"
    );
    assert_eq!(retry_push.commits[0].operations[0].base_version, Some(9));

    Ok(())
}

fn assert_transport_retry_backoff_parity<S>(path: String, store: S) -> Result<()>
where
    S: SyncStore + SyncStateStore + DemoTaskStore,
{
    let transport = TestTransport::new();
    let handle = transport.handle();
    transport.push_http_response_fn(|_request| {
        Err(SyncularError::message(
            ErrorKind::Transport,
            "sync failed with HTTP 500: retry later",
        ))
    });
    let mut client = demo_client(test_config(&path), store, transport);

    client.add_task(
        "Retry backoff candidate".to_string(),
        Some("retry-backoff-parity-task".to_string()),
    )?;
    let error = client
        .sync_http()
        .expect_err("first push should fail transport");
    assert_eq!(error.kind(), ErrorKind::Transport);

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "pending");

    client.sync_http()?;
    {
        let requests = handle.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].push.is_some());
        assert!(requests[1].push.is_none());
    }

    std::thread::sleep(Duration::from_millis(1_100));
    client.sync_http()?;

    let requests = handle.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[2].push.is_some());

    let outbox = client.outbox_summaries()?;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].status, "acked");

    Ok(())
}

fn assert_snapshot_apply_parity<S>(path: String, store: S) -> Result<()>
where
    S: SyncStore + DemoTaskStore,
{
    let transport = TestTransport::new();
    transport.push_http_response(snapshot_combined_response(
        "sub-tasks",
        "tasks",
        vec![task_row("snapshot-parity-task")],
        scopes(),
        1,
    ));
    let mut client = demo_client(test_config(&path), store, transport);

    let report = client.sync_http()?;
    assert_eq!(report.changed_tables, vec!["tasks".to_string()]);

    let tasks = client.list_tasks()?;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "snapshot-parity-task");
    assert_eq!(tasks[0].title, "Snapshot parity");
    assert_eq!(tasks[0].server_version, 42);

    Ok(())
}

fn assert_revocation_parity<S>(path: String, store: S) -> Result<()>
where
    S: SyncStore + DemoTaskStore,
{
    let transport = TestTransport::new();
    transport.push_http_response(snapshot_combined_response(
        "sub-tasks",
        "tasks",
        vec![task_row("revocation-parity-task")],
        scopes(),
        1,
    ));
    transport.push_http_response(revoked_subscription_response("sub-tasks", scopes(), 2));
    let mut client = demo_client(test_config(&path), store, transport);

    let first = client.sync_http()?;
    assert_eq!(first.changed_tables, vec!["tasks".to_string()]);
    assert_eq!(client.list_tasks()?.len(), 1);

    let second = client.sync_http()?;
    assert_eq!(second.changed_tables, vec!["tasks".to_string()]);
    assert!(client.list_tasks()?.is_empty());

    Ok(())
}

#[test]
fn diesel_store_compacts_old_sync_state_and_bounded_tombstones() -> Result<()> {
    let path = temp_db_path("syncular-diesel-compaction");
    let mut store = DieselSqliteStore::open_with_schema(&path, demo_todo_app_schema())?;
    let mut conn = diesel::sqlite::SqliteConnection::establish(&path)?;
    let now = now_ms();
    let old = now - 120_000;

    sql_query(
        "insert into sync_outbox_commits \
         (id, client_commit_id, status, operations_json, created_at, updated_at, attempt_count, schema_version, next_attempt_at) \
         values \
         ('outbox-acked', 'commit-acked', 'acked', '[]', ?1, ?1, 0, ?2, 0), \
         ('outbox-pending', 'commit-pending', 'pending', '[]', ?1, ?1, 0, ?2, 0)",
    )
    .bind::<BigInt, _>(old)
    .bind::<Integer, _>(current_schema_version())
    .execute(&mut conn)?;
    sql_query(
        "insert into sync_conflicts \
         (id, outbox_commit_id, client_commit_id, op_index, result_status, message, created_at, resolved_at) \
         values \
         ('conflict-resolved', 'outbox-acked', 'commit-acked', 0, 'conflict', 'resolved', ?1, ?1), \
         ('conflict-open', 'outbox-pending', 'commit-pending', 0, 'conflict', 'open', ?1, null)",
    )
    .bind::<BigInt, _>(old)
    .execute(&mut conn)?;
    sql_query(
        "insert into sync_blob_outbox \
         (hash, size, mime_type, body, status, attempt_count, created_at, updated_at, next_attempt_at) \
         values \
         ('sha256:failed', 1, 'application/octet-stream', x'01', 'failed', 1, ?1, ?1, 0), \
         ('sha256:pending', 1, 'application/octet-stream', x'02', 'pending', 0, ?1, ?1, 0)",
    )
    .bind::<BigInt, _>(old)
    .execute(&mut conn)?;
    sql_query(
        "insert into sync_blob_cache \
         (hash, size, mime_type, body, encrypted, cached_at, last_accessed_at) \
         values \
         ('sha256:cache-old', 100, 'application/octet-stream', x'01', 0, ?1, ?1), \
         ('sha256:cache-new', 50, 'application/octet-stream', x'02', 0, ?1, ?2)",
    )
    .bind::<BigInt, _>(old)
    .bind::<BigInt, _>(now)
    .execute(&mut conn)?;
    sql_query(
        "insert into sync_subscription_state \
         (state_id, subscription_id, \"table\", scopes_json, params_json, cursor, status, created_at, updated_at) \
         values \
         ('default', 'inactive-sub', 'tasks', '{}', '{}', 1, 'inactive', ?1, ?1), \
         ('default', 'active-sub', 'tasks', '{}', '{}', 1, 'active', ?1, ?1)",
    )
    .bind::<BigInt, _>(old)
    .execute(&mut conn)?;
    sql_query(
        "insert into comments \
         (id, task_id, body, author_id, deleted, server_version) \
         values \
         ('comment-tombstone-old', 'task-1', 'old', 'user-rust', 1, 5), \
         ('comment-tombstone-new', 'task-1', 'new', 'user-rust', 1, 50), \
         ('comment-active', 'task-1', 'active', 'user-rust', 0, 4)",
    )
    .execute(&mut conn)?;

    let options = json!({
        "olderThanMs": 60_000,
        "maxBlobCacheBytes": 120,
        "pruneFailedBlobUploads": true,
        "pruneInactiveSubscriptionStates": true,
        "maxTombstoneServerVersion": 10
    })
    .to_string();
    let report: Value = serde_json::from_str(&store.compact_storage_json(Some(&options))?)?;

    assert_eq!(report["ackedOutboxCommitsDeleted"], 1);
    assert_eq!(report["resolvedConflictsDeleted"], 1);
    assert_eq!(report["failedBlobUploadsDeleted"], 1);
    assert_eq!(report["inactiveSubscriptionStatesDeleted"], 1);
    assert_eq!(report["tombstoneRowsDeleted"], 1);
    assert_eq!(report["blobCacheBytesPruned"], 100);

    assert_eq!(
        count_rows(
            &mut conn,
            "select count(*) as count from sync_outbox_commits where status = 'acked'",
        )?,
        0
    );
    assert_eq!(
        count_rows(
            &mut conn,
            "select count(*) as count from sync_conflicts where resolved_at is not null",
        )?,
        0
    );
    assert_eq!(
        count_rows(
            &mut conn,
            "select count(*) as count from sync_blob_outbox where status = 'failed'",
        )?,
        0
    );
    assert_eq!(
        count_rows(
            &mut conn,
            "select count(*) as count from sync_subscription_state where status != 'active'",
        )?,
        0
    );
    assert_eq!(
        count_rows(&mut conn, "select count(*) as count from sync_blob_cache")?,
        1
    );

    let comments = store.list_table_json("comments")?;
    assert_eq!(comments.len(), 2);
    assert!(comments
        .iter()
        .any(|row| row["id"] == "comment-tombstone-new"));
    assert!(comments.iter().any(|row| row["id"] == "comment-active"));

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

#[derive(QueryableByName)]
struct OperationsJsonRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    operations_json: String,
}

fn count_rows(conn: &mut diesel::sqlite::SqliteConnection, sql: &str) -> Result<i64> {
    Ok(sql_query(sql)
        .load::<CountRow>(conn)?
        .into_iter()
        .next()
        .map(|row| row.count)
        .unwrap_or(0))
}

fn outbox_operations(
    conn: &mut diesel::sqlite::SqliteConnection,
) -> Result<Vec<Vec<SyncOperation>>> {
    sql_query("select operations_json from sync_outbox_commits order by created_at asc, id asc")
        .load::<OperationsJsonRow>(conn)?
        .into_iter()
        .map(|row| serde_json::from_str(&row.operations_json).map_err(Into::into))
        .collect()
}

fn encrypted_app_schema() -> AppSchema {
    AppSchema {
        app_tables: generated::APP_TABLES,
        app_table_metadata: ENCRYPTED_APP_TABLE_METADATA,
        migrations: migrations::MIGRATIONS,
        schema_version: None,
        default_subscriptions: generated::default_subscriptions,
        adapter_for: diesel_tables::adapter_for,
    }
}

fn test_encrypted_crdt() -> Result<EncryptedCrdt> {
    let mut keys = BTreeMap::new();
    keys.insert("default".to_string(), key_to_base64url(&[11u8; 32])?);
    EncryptedCrdt::from_static_config(StaticEncryptedCrdtConfig {
        keys,
        encryption_kid: None,
        partition_id: None,
    })
}

fn encrypted_remote_title_update(encryption: &EncryptedCrdt, row_id: &str) -> Result<Value> {
    let row = json!({
        "id": row_id,
        "title": "Remote initial",
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": 42,
        "image": null,
        "title_yjs_state": null
    });
    let mutation = encryption.build_text_update_mutation(BuildEncryptedCrdtTextUpdateArgs {
        ctx: FieldEncryptionContext {
            actor_id: "remote-user".to_string(),
            client_id: "remote-client".to_string(),
        },
        metadata: &ENCRYPTED_TASKS_METADATA,
        field: "title",
        row_id,
        existing_row: &row,
        next_text: "Remote secret",
    })?;
    Ok(mutation.payload.expect("encrypted payload"))
}

fn encrypted_remote_title_checkpoint(
    encryption: &EncryptedCrdt,
    row_id: &str,
    covers_seq: i64,
) -> Result<Value> {
    let state = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Checkpoint secret".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("checkpoint-state".to_string()),
    })?;
    let row = json!({
        "id": row_id,
        "title": "Checkpoint secret",
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": 42,
        "image": null,
        "title_yjs_state": state.next_state_base64
    });
    let mutation = encryption.build_checkpoint_mutation(BuildEncryptedCrdtCheckpointArgs {
        ctx: FieldEncryptionContext {
            actor_id: "remote-user".to_string(),
            client_id: "remote-client".to_string(),
        },
        metadata: &ENCRYPTED_TASKS_METADATA,
        field: "title",
        row_id,
        existing_row: &row,
        covers_seq,
    })?;
    Ok(mutation.payload.expect("encrypted checkpoint payload"))
}

fn encrypted_remote_title_update_requiring_base(
    encryption: &EncryptedCrdt,
    row_id: &str,
) -> Result<(Value, Value)> {
    let base = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: None,
        next_text: "Encrypted base".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("encrypted-required-base".to_string()),
    })?;
    let next = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: Some(base.next_state_base64.clone()),
        next_text: "Encrypted recovered".to_string(),
        container_key: Some("title".to_string()),
        update_id: Some("encrypted-required-next".to_string()),
    })?;
    let mut next_update = next.update;
    next_update.requires_state_vector_base64 =
        Some(yjs_state_vector_base64(Some(&base.next_state_base64))?);

    let base_row = json!({
        "id": row_id,
        "title": "Encrypted base",
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": 42,
        "image": null,
        "title_yjs_state": base.next_state_base64
    });
    let update = encryption.build_yjs_update_mutation(BuildEncryptedCrdtYjsUpdateArgs {
        ctx: FieldEncryptionContext {
            actor_id: "remote-user".to_string(),
            client_id: "remote-client".to_string(),
        },
        metadata: &ENCRYPTED_TASKS_METADATA,
        field: "title",
        row_id,
        existing_row: &base_row,
        update: next_update,
    })?;

    let recovery_row = json!({
        "id": row_id,
        "title": "Encrypted recovered",
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": 43,
        "image": null,
        "title_yjs_state": next.next_state_base64
    });
    let checkpoint = encryption.build_checkpoint_mutation(BuildEncryptedCrdtCheckpointArgs {
        ctx: FieldEncryptionContext {
            actor_id: "remote-user".to_string(),
            client_id: "remote-client".to_string(),
        },
        metadata: &ENCRYPTED_TASKS_METADATA,
        field: "title",
        row_id,
        existing_row: &recovery_row,
        covers_seq: 2,
    })?;

    Ok((
        update.payload.expect("encrypted update payload"),
        checkpoint.payload.expect("encrypted checkpoint payload"),
    ))
}

fn encrypted_crdt_test_subscriptions() -> Vec<SubscriptionSpec> {
    vec![
        SubscriptionSpec {
            id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            scopes: scopes(),
            params: serde_json::Map::new(),
            bootstrap_phase: 0,
        },
        encrypted_crdt_subscription("sub-tasks-title-crdt-updates", CRDT_UPDATES_TABLE),
        encrypted_crdt_subscription("sub-tasks-title-crdt-checkpoints", CRDT_CHECKPOINTS_TABLE),
    ]
}

fn encrypted_crdt_subscription(id: &str, table: &str) -> SubscriptionSpec {
    let mut params = serde_json::Map::new();
    params.insert("app_table".to_string(), json!("tasks"));
    params.insert("field_name".to_string(), json!("title"));
    SubscriptionSpec {
        id: id.to_string(),
        table: table.to_string(),
        scopes: scopes(),
        params,
        bootstrap_phase: 0,
    }
}

fn demo_client<S, T>(config: SyncularClientConfig, store: S, transport: T) -> SyncularClient<S, T>
where
    S: SyncStore,
    T: SyncTransport,
{
    SyncularClient::with_app_schema_parts(config, store, transport, demo_todo_app_schema())
}

fn test_config(path: &str) -> SyncularClientConfig {
    SyncularClientConfig {
        db_path: path.to_string(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
        client_id: "store-parity".to_string(),
        actor_id: "user-rust".to_string(),
        project_id: Some("p0".to_string()),
    }
}

#[derive(Clone)]
struct EncryptedCrdtRequiredBaseRecoveryTransport {
    encrypted_update: Value,
    recovery_checkpoint: Value,
    requests: Arc<Mutex<Vec<CombinedRequest>>>,
}

impl EncryptedCrdtRequiredBaseRecoveryTransport {
    fn new(encrypted_update: Value, recovery_checkpoint: Value) -> Self {
        Self {
            encrypted_update,
            recovery_checkpoint,
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<CombinedRequest> {
        self.requests
            .lock()
            .expect("encrypted CRDT recovery requests lock")
            .clone()
    }

    fn initial_task_row() -> Value {
        json!({
            "id": "encrypted-resync-task",
            "title": "Remote initial",
            "completed": 0,
            "user_id": "user-rust",
            "project_id": "p0",
            "server_version": 42,
            "image": null,
            "title_yjs_state": null
        })
    }
}

impl SyncTransport for EncryptedCrdtRequiredBaseRecoveryTransport {
    type Realtime = NoopRealtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let call = {
            let mut requests = self
                .requests
                .lock()
                .map_err(|_| SyncularError::protocol_message("encrypted CRDT requests lock"))?;
            requests.push(request.clone());
            requests.len()
        };

        let pull = if call == 1 {
            Some(PullResponse {
                ok: true,
                subscriptions: vec![
                    SubscriptionResponse {
                        id: "sub-tasks".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: true,
                        bootstrap_state: None,
                        next_cursor: 1,
                        integrity: None,
                        commits: Vec::new(),
                        snapshots: Some(vec![SyncSnapshot {
                            table: "tasks".to_string(),
                            rows: vec![Self::initial_task_row()],
                            chunks: None,
                            artifacts: None,
                            manifest: None,
                            is_first_page: true,
                            is_last_page: true,
                            bootstrap_state_after: None,
                        }]),
                    },
                    SubscriptionResponse {
                        id: "sub-tasks-title-crdt-updates".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: false,
                        bootstrap_state: None,
                        next_cursor: 2,
                        integrity: None,
                        snapshots: None,
                        commits: vec![SyncCommit {
                            commit_seq: 2,
                            created_at: "2026-05-10T00:00:00.000Z".to_string(),
                            actor_id: "remote-user".to_string(),
                            changes: vec![SyncChange {
                                table: CRDT_UPDATES_TABLE.to_string(),
                                row_id: self.encrypted_update["update_id"]
                                    .as_str()
                                    .unwrap()
                                    .to_string(),
                                op: "upsert".to_string(),
                                row_json: Some(self.encrypted_update.clone()),
                                row_version: Some(2),
                                scopes: scopes(),
                            }],
                        }],
                    },
                ],
            })
        } else {
            request.pull.as_ref().map(|pull| PullResponse {
                ok: true,
                subscriptions: pull
                    .subscriptions
                    .iter()
                    .map(|sub| {
                        let rows = match sub.table.as_str() {
                            "tasks" => vec![Self::initial_task_row()],
                            CRDT_UPDATES_TABLE => Vec::new(),
                            CRDT_CHECKPOINTS_TABLE => vec![self.recovery_checkpoint.clone()],
                            _ => Vec::new(),
                        };
                        SubscriptionResponse {
                            id: sub.id.clone(),
                            status: "active".to_string(),
                            scopes: sub.scopes.clone(),
                            bootstrap: true,
                            bootstrap_state: None,
                            next_cursor: 3,
                            integrity: None,
                            commits: Vec::new(),
                            snapshots: Some(vec![SyncSnapshot {
                                table: sub.table.clone(),
                                rows,
                                chunks: None,
                                artifacts: None,
                                manifest: None,
                                is_first_page: true,
                                is_last_page: true,
                                bootstrap_state_after: None,
                            }]),
                        }
                    })
                    .collect(),
            })
        };

        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push: None,
            pull,
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _chunk: &SnapshotChunkRef,
        _scopes: &ScopeValues,
    ) -> Result<SnapshotChunkRows> {
        Err(SyncularError::message(
            ErrorKind::Internal,
            "snapshot chunks are not used in encrypted CRDT recovery tests",
        ))
    }

    fn connect_realtime(&self) -> Result<NoopRealtime> {
        Ok(NoopRealtime)
    }
}

struct EncryptedCrdtPullTransport {
    encrypted_update: Value,
}

impl SyncTransport for EncryptedCrdtPullTransport {
    type Realtime = NoopRealtime;

    fn post_sync(&self, _request: &CombinedRequest) -> Result<CombinedResponse> {
        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push: None,
            pull: Some(PullResponse {
                ok: true,
                subscriptions: vec![
                    SubscriptionResponse {
                        id: "sub-tasks".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: true,
                        bootstrap_state: None,
                        next_cursor: 1,
                        integrity: None,
                        commits: Vec::new(),
                        snapshots: Some(vec![SyncSnapshot {
                            table: "tasks".to_string(),
                            rows: vec![json!({
                                "id": "encrypted-pull-task",
                                "title": "Remote initial",
                                "completed": 0,
                                "user_id": "user-rust",
                                "project_id": "p0",
                                "server_version": 42,
                                "image": null,
                                "title_yjs_state": null
                            })],
                            chunks: None,
                            artifacts: None,
                            manifest: None,
                            is_first_page: true,
                            is_last_page: true,
                            bootstrap_state_after: None,
                        }]),
                    },
                    SubscriptionResponse {
                        id: "sub-tasks-title-crdt-updates".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: false,
                        bootstrap_state: None,
                        next_cursor: 2,
                        integrity: None,
                        snapshots: None,
                        commits: vec![SyncCommit {
                            commit_seq: 2,
                            created_at: "2026-05-10T00:00:00.000Z".to_string(),
                            actor_id: "remote-user".to_string(),
                            changes: vec![SyncChange {
                                table: CRDT_UPDATES_TABLE.to_string(),
                                row_id: self.encrypted_update["update_id"]
                                    .as_str()
                                    .unwrap()
                                    .to_string(),
                                op: "upsert".to_string(),
                                row_json: Some(self.encrypted_update.clone()),
                                row_version: Some(2),
                                scopes: scopes(),
                            }],
                        }],
                    },
                ],
            }),
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _chunk: &SnapshotChunkRef,
        _scopes: &ScopeValues,
    ) -> Result<SnapshotChunkRows> {
        Err(SyncularError::message(
            ErrorKind::Internal,
            "snapshot chunks are not used in encrypted CRDT tests",
        ))
    }

    fn connect_realtime(&self) -> Result<NoopRealtime> {
        Ok(NoopRealtime)
    }
}

struct EncryptedCrdtCheckpointPullTransport {
    encrypted_checkpoint: Value,
}

impl SyncTransport for EncryptedCrdtCheckpointPullTransport {
    type Realtime = NoopRealtime;

    fn post_sync(&self, _request: &CombinedRequest) -> Result<CombinedResponse> {
        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push: None,
            pull: Some(PullResponse {
                ok: true,
                subscriptions: vec![
                    SubscriptionResponse {
                        id: "sub-tasks".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: true,
                        bootstrap_state: None,
                        next_cursor: 1,
                        integrity: None,
                        commits: Vec::new(),
                        snapshots: Some(vec![SyncSnapshot {
                            table: "tasks".to_string(),
                            rows: vec![json!({
                                "id": "encrypted-checkpoint-task",
                                "title": "stale checkpoint title",
                                "completed": 0,
                                "user_id": "user-rust",
                                "project_id": "p0",
                                "server_version": 42,
                                "image": null,
                                "title_yjs_state": null
                            })],
                            chunks: None,
                            artifacts: None,
                            manifest: None,
                            is_first_page: true,
                            is_last_page: true,
                            bootstrap_state_after: None,
                        }]),
                    },
                    SubscriptionResponse {
                        id: "sub-tasks-title-crdt-checkpoints".to_string(),
                        status: "active".to_string(),
                        scopes: scopes(),
                        bootstrap: false,
                        bootstrap_state: None,
                        next_cursor: 7,
                        integrity: None,
                        snapshots: None,
                        commits: vec![SyncCommit {
                            commit_seq: 7,
                            created_at: "2026-05-10T00:00:00.000Z".to_string(),
                            actor_id: "remote-user".to_string(),
                            changes: vec![SyncChange {
                                table: CRDT_CHECKPOINTS_TABLE.to_string(),
                                row_id: self.encrypted_checkpoint["checkpoint_id"]
                                    .as_str()
                                    .unwrap()
                                    .to_string(),
                                op: "upsert".to_string(),
                                row_json: Some(self.encrypted_checkpoint.clone()),
                                row_version: Some(7),
                                scopes: scopes(),
                            }],
                        }],
                    },
                ],
            }),
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _chunk: &SnapshotChunkRef,
        _scopes: &ScopeValues,
    ) -> Result<SnapshotChunkRows> {
        Err(SyncularError::message(
            ErrorKind::Internal,
            "snapshot chunks are not used in encrypted CRDT checkpoint tests",
        ))
    }

    fn connect_realtime(&self) -> Result<NoopRealtime> {
        Ok(NoopRealtime)
    }
}

fn task_row(id: &str) -> Value {
    json!({
        "id": id,
        "title": match id {
            "snapshot-parity-task" => "Snapshot parity",
            "revocation-parity-task" => "Revocation parity",
            _ => "Parity task",
        },
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": 42,
        "image": null,
        "title_yjs_state": null
    })
}

fn scopes() -> ScopeValues {
    let mut scopes = ScopeValues::new();
    scopes.insert("user_id".to_string(), json!("user-rust"));
    scopes.insert("project_id".to_string(), json!("p0"));
    scopes
}

struct NoopRealtime;

impl RealtimeTransport for NoopRealtime {
    fn push_commit(&mut self, _commit: PushCommitRequest) -> Result<PushCommitResponse> {
        Err(SyncularError::message(
            ErrorKind::Internal,
            "websocket push is not used in store parity tests",
        ))
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        Ok(None)
    }

    fn close(&mut self) {}
}

fn temp_db_path(prefix: &str) -> String {
    unique_temp_db_path(prefix)
}
