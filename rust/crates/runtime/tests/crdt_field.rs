use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use syncular_runtime::app_schema::{
    app_schema_from_json, AppSchema, AppTableMetadata, CrdtYjsFieldMetadata,
};
use syncular_runtime::binary_snapshot::SnapshotChunkRows;
use syncular_runtime::client::{SyncularClient, SyncularClientConfig};
use syncular_runtime::compaction::{StorageCompactionOptions, StorageCompactionReport};
use syncular_runtime::crdt_field::{
    validate_crdt_field, CrdtFieldId, CrdtFieldSyncMode, CrdtUpdateStatus,
};
use syncular_runtime::crdt_yjs::{
    build_yjs_text_update, transform_local_row_for_metadata, BuildYjsTextUpdateArgs,
};
use syncular_runtime::diesel_sqlite::DieselSqliteStore;
use syncular_runtime::encrypted_crdt::{
    is_encrypted_crdt_system_table, EncryptedCrdt, StaticEncryptedCrdtConfig,
};
use syncular_runtime::encryption::key_to_base64url;
use syncular_runtime::error::{Result, SyncularError};
use syncular_runtime::fixtures::todo::{app_schema as demo_todo_app_schema, generated};
use syncular_runtime::protocol::{
    CombinedRequest, CombinedResponse, OperationResult, PullResponse, PushCommitRequest,
    PushCommitResponse, ScopeValues, SnapshotChunkRef, SubscriptionResponse, SyncChange,
    SyncCommit, SyncOperation, SyncSnapshot,
};
use syncular_runtime::transport::{RealtimeEvent, RealtimeTransport, SyncTransport};
use syncular_testkit::{
    unique_temp_db_path, AppTestServer, AppTestServerDeliveryMode, AppTestServerOptions,
};

#[test]
fn rust_client_exposes_generic_crdt_field_text_flow() -> Result<()> {
    let path = temp_db_path("syncular-crdt-field-text");
    let app_schema = demo_todo_app_schema();
    let store = DieselSqliteStore::open_with_schema(&path, app_schema)?;
    let mut client =
        SyncularClient::with_app_schema_parts(test_config(&path), store, NoopTransport, app_schema);

    client.apply_mutation_json(
        &json!({
            "table": "tasks",
            "row_id": "crdt-field-task",
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
    )?;

    let field = client.open_crdt_field(CrdtFieldId::new("tasks", "crdt-field-task", "title"))?;
    assert_eq!(field.sync_mode(), CrdtFieldSyncMode::ServerMerge);
    assert_eq!(field.state_column(), "title_yjs_state");

    let receipt = client.apply_crdt_field_text(&field, "Field title")?;
    assert_eq!(receipt.sync_mode, CrdtFieldSyncMode::ServerMerge);
    assert!(!receipt.client_commit_id.is_empty());

    let materialized = client.materialize_crdt_field(&field)?;
    assert_eq!(materialized.value, Value::String("Field title".to_string()));
    assert!(materialized
        .state_base64
        .as_deref()
        .is_some_and(|value| !value.is_empty()));
    assert!(!materialized.state_vector_base64.is_empty());

    let materialized_json: Value =
        serde_json::from_str(&client.materialize_crdt_field_json(&field)?)?;
    assert_eq!(materialized_json["value"], "Field title");

    let rows: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(rows[0]["title"], "Field title");
    assert!(rows[0]["title_yjs_state"].as_str().is_some());

    let state_vector = client.snapshot_crdt_field_state_vector_base64(&field)?;
    assert_eq!(state_vector, materialized.state_vector_base64);

    let compaction = client.compact_crdt_field(&field, 1)?;
    assert!(!compaction.checkpoint_created);
    assert!(compaction.client_commit_id.is_none());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_merge_crdt_field_persists_document_state_update_log_and_ack_status() -> Result<()> {
    let path = temp_db_path("syncular-crdt-document-log");
    let server = seeded_todo_app_server("crdt-document-log-task")?;
    let app_schema = demo_todo_app_schema();
    let store = DieselSqliteStore::open_with_schema(&path, app_schema)?;
    let mut client = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path, "crdt-document-log-client"),
        store,
        server,
        app_schema,
    );

    client.sync_http()?;
    let field =
        client.open_crdt_field(CrdtFieldId::new("tasks", "crdt-document-log-task", "title"))?;
    let receipt = client.apply_crdt_field_text(&field, "Document log title")?;

    let snapshot = client.crdt_document_snapshot(&field)?;
    assert_eq!(snapshot.table, "tasks");
    assert_eq!(snapshot.field, "title");
    assert_eq!(snapshot.sync_mode, CrdtFieldSyncMode::ServerMerge);
    assert_eq!(snapshot.pending_updates, 1);
    assert_eq!(snapshot.flushed_updates, 0);
    assert_eq!(snapshot.acked_updates, 0);
    assert_eq!(snapshot.log_updates, 1);
    assert!(snapshot
        .state_base64
        .as_deref()
        .is_some_and(|value| !value.is_empty()));
    assert!(!snapshot.state_vector_base64.is_empty());

    let log = client.crdt_update_log(&field, 10)?;
    assert_eq!(log.len(), 1);
    assert_eq!(
        log[0].client_commit_id.as_deref(),
        Some(receipt.client_commit_id.as_str())
    );
    assert_eq!(
        log[0].origin,
        syncular_runtime::crdt_field::CrdtUpdateOrigin::Local
    );
    assert_eq!(log[0].status, CrdtUpdateStatus::Pending);
    assert!(!log[0].update_base64.is_empty());

    client.sync_http()?;
    let acked_snapshot = client.crdt_document_snapshot(&field)?;
    assert_eq!(acked_snapshot.pending_updates, 0);
    assert_eq!(acked_snapshot.flushed_updates, 0);
    assert_eq!(acked_snapshot.acked_updates, 1);
    assert_eq!(acked_snapshot.log_updates, 1);
    let acked_log = client.crdt_update_log(&field, 10)?;
    assert_eq!(acked_log[0].status, CrdtUpdateStatus::Acked);
    assert!(acked_log[0].flushed_at.is_some());
    assert!(acked_log[0].acked_at.is_some());

    let compaction = client.compact_crdt_field(&field, 1)?;
    assert!(!compaction.checkpoint_created);
    let compacted = client.crdt_document_snapshot(&field)?;
    assert!(compacted.compacted_at.is_some());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_merge_crdt_field_enforces_bounded_pending_update_queue() -> Result<()> {
    let path = temp_db_path("syncular-crdt-document-backpressure");
    let app_schema = demo_todo_app_schema();
    let store = DieselSqliteStore::open_with_schema(&path, app_schema)?;
    let mut client =
        SyncularClient::with_app_schema_parts(test_config(&path), store, NoopTransport, app_schema);
    client.apply_mutation_json(
        &json!({
            "table": "tasks",
            "row_id": "crdt-document-backpressure-task",
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
    )?;

    let field = client.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "crdt-document-backpressure-task",
        "title",
    ))?;
    client.apply_crdt_field_text(&field, "First queued title")?;
    let materialized = client.materialize_crdt_field(&field)?;
    let second = build_yjs_text_update(BuildYjsTextUpdateArgs {
        previous_state_base64: materialized.state_base64,
        next_text: "Second queued title".to_string(),
        container_key: Some(field.container_key().to_string()),
        update_id: Some("backpressure-second".to_string()),
    })?;
    let err = client
        .apply_crdt_field_yjs_update_with_queue_capacity(&field, second.update, 1)
        .expect_err("second pending CRDT update should hit queue capacity");
    assert!(err.to_string().contains("CRDT update queue is full"));

    let snapshot = client.crdt_document_snapshot(&field)?;
    assert_eq!(snapshot.pending_updates, 1);
    assert_eq!(snapshot.log_updates, 1);

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn rust_client_crdt_text_rejects_non_empty_plain_text_without_state() -> Result<()> {
    let path = temp_db_path("syncular-crdt-field-plain-seed");
    let app_schema = demo_todo_app_schema();
    let store = DieselSqliteStore::open_with_schema(&path, app_schema)?;
    let mut client =
        SyncularClient::with_app_schema_parts(test_config(&path), store, NoopTransport, app_schema);
    client.apply_mutation_json(
        &json!({
            "table": "tasks",
            "row_id": "crdt-field-plain-seed-task",
            "op": "upsert",
            "payload": {
                "title": "Plain seed",
                "completed": 0,
                "user_id": "user-rust",
                "project_id": "p0"
            },
            "base_version": 0
        })
        .to_string(),
        None,
    )?;

    let field = client.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "crdt-field-plain-seed-task",
        "title",
    ))?;
    let err = client
        .apply_crdt_field_text(&field, "CRDT replacement")
        .expect_err("state-less non-empty CRDT text replacement should be rejected");
    assert!(err.to_string().contains("without existing Yjs state"));

    let materialized = client.materialize_crdt_field(&field)?;
    assert_eq!(materialized.value, Value::String("Plain seed".to_string()));
    let rows: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(rows[0]["title"], "Plain seed");

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn crdt_field_validation_rejects_invalid_injected_schema_metadata() -> Result<()> {
    let non_text_state_schema = app_schema_from_json(
        &crdt_validation_schema_json(
            json!({
                "field": "title",
                "stateColumn": "completed",
                "containerKey": "title",
                "rowIdField": "id",
                "kind": "text",
                "syncMode": "server-merge"
            }),
            json!([]),
            json!([]),
        )
        .to_string(),
    )?;
    let err = validate_crdt_field(
        non_text_state_schema,
        &CrdtFieldId::new("tasks", "invalid-crdt-task", "title"),
    )
    .expect_err("non-text CRDT state columns should be rejected");
    assert!(
        err.to_string()
            .contains("state column completed must use a text column"),
        "unexpected error: {err}"
    );

    let missing_scope_schema = app_schema_from_json(
        &crdt_validation_schema_json(
            valid_validation_crdt_field(),
            json!([]),
            json!([{
                "name": "actor",
                "column": "missing_actor_id",
                "source": "actorId",
                "required": true
            }]),
        )
        .to_string(),
    )?;
    let err = validate_crdt_field(
        missing_scope_schema,
        &CrdtFieldId::new("tasks", "invalid-crdt-task", "title"),
    )
    .expect_err("unknown scope columns should be rejected");
    assert!(
        err.to_string()
            .contains("references unknown scope column missing_actor_id"),
        "unexpected error: {err}"
    );

    let encrypted_field_conflict_schema = app_schema_from_json(
        &crdt_validation_schema_json(
            valid_validation_crdt_field(),
            json!([{
                "field": "title",
                "scope": "actor",
                "rowIdField": "id"
            }]),
            json!([]),
        )
        .to_string(),
    )?;
    let err = validate_crdt_field(
        encrypted_field_conflict_schema,
        &CrdtFieldId::new("tasks", "invalid-crdt-task", "title"),
    )
    .expect_err("field-level encryption should not overlap CRDT fields");
    assert!(
        err.to_string()
            .contains("conflicts with encrypted field title"),
        "unexpected error: {err}"
    );

    Ok(())
}

#[test]
fn rust_client_exposes_encrypted_crdt_field_through_same_identity() -> Result<()> {
    let path = temp_db_path("syncular-crdt-field-encrypted");
    let app_schema = encrypted_app_schema();
    let store = DieselSqliteStore::open_with_schema(&path, app_schema)?;
    let mut client =
        SyncularClient::with_app_schema_parts(test_config(&path), store, NoopTransport, app_schema);
    client.set_encrypted_crdt(Some(test_encrypted_crdt()?));

    client.apply_mutation_json(
        &json!({
            "table": "tasks",
            "row_id": "encrypted-crdt-field-task",
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
    )?;

    let field = client.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-crdt-field-task",
        "title",
    ))?;
    assert_eq!(field.sync_mode(), CrdtFieldSyncMode::EncryptedUpdateLog);

    let receipt = client.apply_crdt_field_text(&field, "Encrypted field title")?;
    assert_eq!(receipt.sync_mode, CrdtFieldSyncMode::EncryptedUpdateLog);
    assert!(!receipt.client_commit_id.is_empty());

    let materialized = client.materialize_crdt_field(&field)?;
    assert_eq!(
        materialized.value,
        Value::String("Encrypted field title".to_string())
    );
    assert!(materialized
        .state_base64
        .as_deref()
        .is_some_and(|value| !value.is_empty()));
    assert!(!materialized.state_vector_base64.is_empty());

    let rows: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(rows[0]["title"], "Encrypted field title");
    assert!(rows[0]["title_yjs_state"].as_str().is_some());

    let compaction = client.compact_crdt_field(&field, 1)?;
    assert!(!compaction.checkpoint_created);
    assert!(compaction.client_commit_id.is_none());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn server_merge_crdt_field_converges_after_offline_edits_and_reopen() -> Result<()> {
    let path_a = temp_db_path("syncular-crdt-converge-a");
    let path_b = temp_db_path("syncular-crdt-converge-b");
    let server = seeded_todo_app_server("crdt-converge-task")?;
    let app_schema = demo_todo_app_schema();
    let store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let mut client_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "crdt-client-a"),
        store_a,
        server.clone(),
        app_schema,
    );
    let mut client_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "crdt-client-b"),
        store_b,
        server.clone(),
        app_schema,
    );

    client_a.sync_http()?;
    client_b.sync_http()?;

    let field_a =
        client_a.open_crdt_field(CrdtFieldId::new("tasks", "crdt-converge-task", "title"))?;
    let field_b =
        client_b.open_crdt_field(CrdtFieldId::new("tasks", "crdt-converge-task", "title"))?;

    client_a.apply_crdt_field_text(&field_a, "Client A")?;
    client_b.apply_crdt_field_text(&field_b, "Client B")?;

    assert_eq!(
        client_a.materialize_crdt_field(&field_a)?.value,
        Value::String("Client A".to_string())
    );
    assert_eq!(
        client_b.materialize_crdt_field(&field_b)?.value,
        Value::String("Client B".to_string())
    );

    client_a.sync_http()?;
    client_b.sync_http()?;
    client_a.sync_http()?;

    let value_a = client_a.materialize_crdt_field(&field_a)?;
    let value_b = client_b.materialize_crdt_field(&field_b)?;
    assert_eq!(value_a.value, value_b.value);
    let merged = value_a
        .value
        .as_str()
        .ok_or_else(|| SyncularError::protocol_message("merged CRDT value should be text"))?;
    assert!(merged.contains("Client A"), "merged value was {merged:?}");
    assert!(merged.contains("Client B"), "merged value was {merged:?}");
    assert!(!merged.trim().is_empty());
    assert_eq!(value_a.state_vector_base64, value_b.state_vector_base64);

    drop(client_a);
    drop(client_b);

    let reopened_store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let mut reopened_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "crdt-client-a-reopen"),
        reopened_store_a,
        NoopTransport,
        app_schema,
    );
    let reopened_field =
        reopened_a.open_crdt_field(CrdtFieldId::new("tasks", "crdt-converge-task", "title"))?;
    let reopened = reopened_a.materialize_crdt_field(&reopened_field)?;
    assert_eq!(reopened.value, value_a.value);
    assert_eq!(reopened.state_vector_base64, value_a.state_vector_base64);

    let _ = std::fs::remove_file(path_a);
    let _ = std::fs::remove_file(path_b);
    Ok(())
}

#[test]
fn server_merge_crdt_field_tolerates_duplicate_reordered_remote_delivery() -> Result<()> {
    let path_a = temp_db_path("syncular-crdt-disorder-a");
    let path_b = temp_db_path("syncular-crdt-disorder-b");
    let path_c = temp_db_path("syncular-crdt-disorder-c");
    let server = seeded_todo_app_server_with_delivery(
        "crdt-disorder-task",
        AppTestServerDeliveryMode::ReverseAndDuplicate,
    )?;
    let app_schema = demo_todo_app_schema();
    let store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let store_c = DieselSqliteStore::open_with_schema(&path_c, app_schema)?;
    let mut client_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "crdt-disorder-a"),
        store_a,
        server.clone(),
        app_schema,
    );
    let mut client_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "crdt-disorder-b"),
        store_b,
        server.clone(),
        app_schema,
    );
    let mut client_c = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_c, "crdt-disorder-c"),
        store_c,
        server.clone(),
        app_schema,
    );

    client_a.sync_http()?;
    client_b.sync_http()?;
    client_c.sync_http()?;

    let field_a =
        client_a.open_crdt_field(CrdtFieldId::new("tasks", "crdt-disorder-task", "title"))?;
    let field_b =
        client_b.open_crdt_field(CrdtFieldId::new("tasks", "crdt-disorder-task", "title"))?;
    let field_c =
        client_c.open_crdt_field(CrdtFieldId::new("tasks", "crdt-disorder-task", "title"))?;

    client_a.apply_crdt_field_text(&field_a, "Remote A")?;
    client_b.apply_crdt_field_text(&field_b, "Remote B")?;
    client_a.sync_http()?;
    client_b.sync_http()?;
    client_c.sync_http()?;

    let materialized = client_c.materialize_crdt_field(&field_c)?;
    let merged = materialized
        .value
        .as_str()
        .ok_or_else(|| SyncularError::protocol_message("reordered CRDT value should be text"))?;
    assert!(merged.contains("Remote A"), "merged value was {merged:?}");
    assert!(merged.contains("Remote B"), "merged value was {merged:?}");
    assert!(!merged.trim().is_empty());
    assert!(!materialized.state_vector_base64.is_empty());

    client_c.sync_http()?;
    let replayed = client_c.materialize_crdt_field(&field_c)?;
    assert_eq!(replayed.value, materialized.value);
    assert_eq!(
        replayed.state_vector_base64,
        materialized.state_vector_base64
    );

    let _ = std::fs::remove_file(path_a);
    let _ = std::fs::remove_file(path_b);
    let _ = std::fs::remove_file(path_c);
    Ok(())
}

#[test]
fn encrypted_crdt_field_converges_after_offline_updates_without_plaintext_leakage() -> Result<()> {
    let path_a = temp_db_path("syncular-ecrdt-converge-a");
    let path_b = temp_db_path("syncular-ecrdt-converge-b");
    let server = SharedCrdtServer::new("encrypted-converge-task");
    let app_schema = encrypted_app_schema();
    let store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let encryption = test_encrypted_crdt()?;
    let mut client_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "ecrdt-client-a"),
        store_a,
        server.clone(),
        app_schema,
    );
    let mut client_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "ecrdt-client-b"),
        store_b,
        server.clone(),
        app_schema,
    );
    client_a.set_encrypted_crdt(Some(encryption.clone()));
    client_b.set_encrypted_crdt(Some(encryption.clone()));

    client_a.sync_http()?;
    client_b.sync_http()?;

    let field_a = client_a.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-converge-task",
        "title",
    ))?;
    let field_b = client_b.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-converge-task",
        "title",
    ))?;
    assert_eq!(field_a.sync_mode(), CrdtFieldSyncMode::EncryptedUpdateLog);
    assert_eq!(field_b.sync_mode(), CrdtFieldSyncMode::EncryptedUpdateLog);

    client_a.apply_crdt_field_text(&field_a, "Secret A")?;
    client_b.apply_crdt_field_text(&field_b, "Secret B")?;

    client_a.sync_http()?;
    client_b.sync_http()?;
    client_a.sync_http()?;

    let value_a = client_a.materialize_crdt_field(&field_a)?;
    let value_b = client_b.materialize_crdt_field(&field_b)?;
    assert_eq!(value_a.value, value_b.value);
    let merged = value_a
        .value
        .as_str()
        .ok_or_else(|| SyncularError::protocol_message("merged encrypted CRDT should be text"))?;
    assert!(
        merged.contains("Secret A"),
        "merged encrypted value was {merged:?}"
    );
    assert!(
        merged.contains("Secret B"),
        "merged encrypted value was {merged:?}"
    );
    assert!(!merged.trim().is_empty());
    assert_eq!(value_a.state_vector_base64, value_b.state_vector_base64);

    let server_commits_json = {
        let state = server
            .state
            .lock()
            .map_err(|_| SyncularError::protocol_message("CRDT test server state poisoned"))?;
        serde_json::to_string(&state.commits)?
    };
    assert!(server_commits_json.contains("ciphertext"));
    assert!(!server_commits_json.contains("Secret A"));
    assert!(!server_commits_json.contains("Secret B"));
    assert!(!server_commits_json.contains("update_base64"));
    assert!(!server_commits_json.contains("state_base64"));

    drop(client_a);
    drop(client_b);

    let reopened_store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let mut reopened_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "ecrdt-client-a-reopen"),
        reopened_store_a,
        NoopTransport,
        app_schema,
    );
    reopened_a.set_encrypted_crdt(Some(encryption));
    let reopened_field = reopened_a.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-converge-task",
        "title",
    ))?;
    let reopened = reopened_a.materialize_crdt_field(&reopened_field)?;
    assert_eq!(reopened.value, value_a.value);
    assert_eq!(reopened.state_vector_base64, value_a.state_vector_base64);

    let _ = std::fs::remove_file(path_a);
    let _ = std::fs::remove_file(path_b);
    Ok(())
}

#[test]
fn encrypted_crdt_local_edit_survives_first_bootstrap_snapshot() -> Result<()> {
    let path = temp_db_path("syncular-ecrdt-prebootstrap");
    let server = SharedCrdtServer::new("encrypted-prebootstrap-task");
    let app_schema = encrypted_app_schema();
    let store = DieselSqliteStore::open_with_schema(&path, app_schema)?;
    let mut client = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path, "ecrdt-prebootstrap-client"),
        store,
        server,
        app_schema,
    );
    client.set_encrypted_crdt(Some(test_encrypted_crdt()?));

    client.apply_mutation_json(
        &json!({
            "table": "tasks",
            "row_id": "encrypted-prebootstrap-task",
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
    )?;

    let field = client.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-prebootstrap-task",
        "title",
    ))?;
    client.apply_crdt_field_text(&field, "Prebootstrap secret")?;
    assert_eq!(
        client.materialize_crdt_field(&field)?.value,
        Value::String("Prebootstrap secret".to_string())
    );

    client.sync_http()?;

    let materialized = client.materialize_crdt_field(&field)?;
    assert_eq!(
        materialized.value,
        Value::String("Prebootstrap secret".to_string())
    );
    assert!(!materialized.state_vector_base64.is_empty());
    let rows: Value = serde_json::from_str(&client.list_table_json("tasks")?)?;
    assert_eq!(rows[0]["title"], "Prebootstrap secret");
    assert!(rows[0]["title_yjs_state"].as_str().is_some());

    let _ = std::fs::remove_file(path);
    Ok(())
}

#[test]
fn encrypted_crdt_multiple_fields_share_system_table_and_pull_independently() -> Result<()> {
    let path_a = temp_db_path("syncular-ecrdt-multifield-a");
    let path_b = temp_db_path("syncular-ecrdt-multifield-b");
    let server = SharedCrdtServer::with_tasks(&["multi-title-task", "multi-image-task"]);
    let app_schema = multi_field_encrypted_app_schema();
    let encryption = test_encrypted_crdt()?;
    let store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let mut client_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "ecrdt-multifield-a"),
        store_a,
        server.clone(),
        app_schema,
    );
    let mut client_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "ecrdt-multifield-b"),
        store_b,
        server.clone(),
        app_schema,
    );
    client_a.set_encrypted_crdt(Some(encryption.clone()));
    client_b.set_encrypted_crdt(Some(encryption));

    client_a.sync_http()?;
    client_b.sync_http()?;

    let title_a =
        client_a.open_crdt_field(CrdtFieldId::new("tasks", "multi-title-task", "title"))?;
    let image_a =
        client_a.open_crdt_field(CrdtFieldId::new("tasks", "multi-image-task", "image"))?;
    assert_eq!(title_a.sync_mode(), CrdtFieldSyncMode::EncryptedUpdateLog);
    assert_eq!(image_a.sync_mode(), CrdtFieldSyncMode::EncryptedUpdateLog);

    client_a.apply_crdt_field_text(&title_a, "Title stream")?;
    client_a.apply_crdt_field_text(&image_a, "Image stream")?;
    client_a.sync_http()?;
    client_b.sync_http()?;

    let title_b =
        client_b.open_crdt_field(CrdtFieldId::new("tasks", "multi-title-task", "title"))?;
    let image_b =
        client_b.open_crdt_field(CrdtFieldId::new("tasks", "multi-image-task", "image"))?;
    assert_eq!(
        client_b.materialize_crdt_field(&title_b)?.value,
        Value::String("Title stream".to_string())
    );
    assert_eq!(
        client_b.materialize_crdt_field(&image_b)?.value,
        Value::String("Image stream".to_string())
    );

    let server_commits_json = {
        let state = server
            .state
            .lock()
            .map_err(|_| SyncularError::protocol_message("CRDT test server state poisoned"))?;
        serde_json::to_string(&state.commits)?
    };
    assert_eq!(
        server_commits_json
            .matches("\"table\":\"sync_crdt_updates\"")
            .count(),
        2
    );
    assert!(server_commits_json.contains("\"field_name\":\"title\""));
    assert!(server_commits_json.contains("\"field_name\":\"image\""));
    assert!(server_commits_json.contains("ciphertext"));
    assert!(!server_commits_json.contains("Title stream"));
    assert!(!server_commits_json.contains("Image stream"));
    assert!(!server_commits_json.contains("update_base64"));

    let _ = std::fs::remove_file(path_a);
    let _ = std::fs::remove_file(path_b);
    Ok(())
}

#[test]
fn encrypted_crdt_checkpoint_compaction_prunes_updates_without_blanking_content() -> Result<()> {
    let path_a = temp_db_path("syncular-ecrdt-checkpoint-a");
    let path_b = temp_db_path("syncular-ecrdt-checkpoint-b");
    let server = SharedCrdtServer::new("encrypted-checkpoint-task");
    let app_schema = encrypted_app_schema();
    let encryption = test_encrypted_crdt()?;
    let store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let mut client_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "ecrdt-checkpoint-a"),
        store_a,
        server.clone(),
        app_schema,
    );
    let mut client_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "ecrdt-checkpoint-b"),
        store_b,
        server.clone(),
        app_schema,
    );
    client_a.set_encrypted_crdt(Some(encryption.clone()));
    client_b.set_encrypted_crdt(Some(encryption));

    client_a.sync_http()?;
    client_b.sync_http()?;

    let field_a = client_a.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-checkpoint-task",
        "title",
    ))?;
    client_a.apply_crdt_field_text(&field_a, "Checkpoint secret")?;
    client_a.sync_http()?;

    client_b.sync_http()?;
    let field_b = client_b.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-checkpoint-task",
        "title",
    ))?;
    assert_eq!(
        client_b.materialize_crdt_field(&field_b)?.value,
        Value::String("Checkpoint secret".to_string())
    );

    let checkpoint = client_b.compact_crdt_field(&field_b, 1)?;
    assert!(checkpoint.checkpoint_created);
    assert!(checkpoint.client_commit_id.is_some());
    client_b.sync_http()?;

    let options = StorageCompactionOptions {
        prune_encrypted_crdt_updates: Some(true),
        max_encrypted_crdt_checkpoints_per_stream: Some(1),
        ..StorageCompactionOptions::default()
    };
    let report: StorageCompactionReport = serde_json::from_str(
        &client_b.compact_storage_json(Some(&serde_json::to_string(&options)?))?,
    )?;
    assert_eq!(report.encrypted_crdt_updates_deleted, 1);
    assert_eq!(report.encrypted_crdt_checkpoints_deleted, 0);
    assert_eq!(
        client_b.materialize_crdt_field(&field_b)?.value,
        Value::String("Checkpoint secret".to_string())
    );

    client_a.sync_http()?;
    assert_eq!(
        client_a.materialize_crdt_field(&field_a)?.value,
        Value::String("Checkpoint secret".to_string())
    );

    let server_commits_json = {
        let state = server
            .state
            .lock()
            .map_err(|_| SyncularError::protocol_message("CRDT test server state poisoned"))?;
        serde_json::to_string(&state.commits)?
    };
    assert!(server_commits_json.contains("sync_crdt_checkpoints"));
    assert!(!server_commits_json.contains("Checkpoint secret"));
    assert!(!server_commits_json.contains("state_base64"));

    let _ = std::fs::remove_file(path_a);
    let _ = std::fs::remove_file(path_b);
    Ok(())
}

#[test]
fn encrypted_crdt_checkpoint_persists_after_reopen_with_pruned_updates() -> Result<()> {
    let path_a = temp_db_path("syncular-ecrdt-checkpoint-reopen-a");
    let path_b = temp_db_path("syncular-ecrdt-checkpoint-reopen-b");
    let server = SharedCrdtServer::new("encrypted-checkpoint-reopen-task");
    let app_schema = encrypted_app_schema();
    let encryption = test_encrypted_crdt()?;
    let store_a = DieselSqliteStore::open_with_schema(&path_a, app_schema)?;
    let store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let mut client_a = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_a, "ecrdt-checkpoint-reopen-a"),
        store_a,
        server.clone(),
        app_schema,
    );
    let mut client_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "ecrdt-checkpoint-reopen-b"),
        store_b,
        server.clone(),
        app_schema,
    );
    client_a.set_encrypted_crdt(Some(encryption.clone()));
    client_b.set_encrypted_crdt(Some(encryption.clone()));

    client_a.sync_http()?;
    client_b.sync_http()?;

    let field_a = client_a.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-checkpoint-reopen-task",
        "title",
    ))?;
    client_a.apply_crdt_field_text(&field_a, "Checkpoint reopen secret")?;
    client_a.sync_http()?;

    client_b.sync_http()?;
    let field_b = client_b.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-checkpoint-reopen-task",
        "title",
    ))?;
    let pulled = client_b.materialize_crdt_field(&field_b)?;
    assert_eq!(
        pulled.value,
        Value::String("Checkpoint reopen secret".to_string())
    );
    assert!(!pulled.state_vector_base64.is_empty());

    let checkpoint = client_b.compact_crdt_field(&field_b, 1)?;
    assert!(checkpoint.checkpoint_created);
    assert!(checkpoint.client_commit_id.is_some());
    client_b.sync_http()?;

    let options = StorageCompactionOptions {
        prune_encrypted_crdt_updates: Some(true),
        max_encrypted_crdt_checkpoints_per_stream: Some(1),
        ..StorageCompactionOptions::default()
    };
    let report: StorageCompactionReport = serde_json::from_str(
        &client_b.compact_storage_json(Some(&serde_json::to_string(&options)?))?,
    )?;
    assert_eq!(report.encrypted_crdt_updates_deleted, 1);
    assert_eq!(report.encrypted_crdt_checkpoints_deleted, 0);
    let after_prune = client_b.materialize_crdt_field(&field_b)?;
    assert_eq!(after_prune.value, pulled.value);
    assert_eq!(after_prune.state_vector_base64, pulled.state_vector_base64);

    drop(client_a);
    drop(client_b);

    let reopened_store_b = DieselSqliteStore::open_with_schema(&path_b, app_schema)?;
    let mut reopened_b = SyncularClient::with_app_schema_parts(
        test_config_with_client(&path_b, "ecrdt-checkpoint-reopen-b-again"),
        reopened_store_b,
        NoopTransport,
        app_schema,
    );
    reopened_b.set_encrypted_crdt(Some(encryption));
    let reopened_field = reopened_b.open_crdt_field(CrdtFieldId::new(
        "tasks",
        "encrypted-checkpoint-reopen-task",
        "title",
    ))?;
    let reopened = reopened_b.materialize_crdt_field(&reopened_field)?;
    assert_eq!(reopened.value, after_prune.value);
    assert_eq!(
        reopened.state_vector_base64,
        after_prune.state_vector_base64
    );

    let server_commits_json = {
        let state = server
            .state
            .lock()
            .map_err(|_| SyncularError::protocol_message("CRDT test server state poisoned"))?;
        serde_json::to_string(&state.commits)?
    };
    assert!(server_commits_json.contains("sync_crdt_checkpoints"));
    assert!(!server_commits_json.contains("Checkpoint reopen secret"));
    assert!(!server_commits_json.contains("state_base64"));
    assert!(!server_commits_json.contains("update_base64"));

    let _ = std::fs::remove_file(path_a);
    let _ = std::fs::remove_file(path_b);
    Ok(())
}

fn test_config(path: &str) -> SyncularClientConfig {
    test_config_with_client(path, "crdt-field-client")
}

fn test_config_with_client(path: &str, client_id: &str) -> SyncularClientConfig {
    SyncularClientConfig {
        db_path: path.to_string(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
        client_id: client_id.to_string(),
        actor_id: "user-rust".to_string(),
        project_id: Some("p0".to_string()),
    }
}

const ENCRYPTED_TASKS_CRDT_YJS_FIELDS: &[CrdtYjsFieldMetadata] = &[CrdtYjsFieldMetadata {
    field: "title",
    state_column: "title_yjs_state",
    container_key: "title",
    row_id_field: "id",
    kind: "text",
    sync_mode: "encrypted-update-log",
}];

const MULTI_FIELD_ENCRYPTED_TASKS_CRDT_YJS_FIELDS: &[CrdtYjsFieldMetadata] = &[
    CrdtYjsFieldMetadata {
        field: "title",
        state_column: "title_yjs_state",
        container_key: "title",
        row_id_field: "id",
        kind: "text",
        sync_mode: "encrypted-update-log",
    },
    CrdtYjsFieldMetadata {
        field: "image",
        state_column: "title_yjs_state",
        container_key: "image",
        row_id_field: "id",
        kind: "text",
        sync_mode: "encrypted-update-log",
    },
];

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

const MULTI_FIELD_ENCRYPTED_TASKS_METADATA: AppTableMetadata = AppTableMetadata {
    name: "tasks",
    primary_key_column: "id",
    server_version_column: "server_version",
    soft_delete_column: None,
    columns: generated::TASKS_COLUMNS,
    blob_columns: generated::TASKS_BLOB_COLUMNS,
    crdt_yjs_fields: MULTI_FIELD_ENCRYPTED_TASKS_CRDT_YJS_FIELDS,
    encrypted_fields: generated::TASKS_ENCRYPTED_FIELDS,
    scopes: generated::TASKS_SCOPES,
    subscription_id: "sub-tasks",
};

const ENCRYPTED_APP_TABLE_METADATA: &[AppTableMetadata] = &[
    generated::COMMENTS_METADATA,
    generated::PROJECTS_METADATA,
    ENCRYPTED_TASKS_METADATA,
];

const MULTI_FIELD_ENCRYPTED_APP_TABLE_METADATA: &[AppTableMetadata] = &[
    generated::COMMENTS_METADATA,
    generated::PROJECTS_METADATA,
    MULTI_FIELD_ENCRYPTED_TASKS_METADATA,
];

fn encrypted_app_schema() -> AppSchema {
    AppSchema {
        app_table_metadata: ENCRYPTED_APP_TABLE_METADATA,
        ..demo_todo_app_schema()
    }
}

fn multi_field_encrypted_app_schema() -> AppSchema {
    AppSchema {
        app_table_metadata: MULTI_FIELD_ENCRYPTED_APP_TABLE_METADATA,
        ..demo_todo_app_schema()
    }
}

fn valid_validation_crdt_field() -> Value {
    json!({
        "field": "title",
        "stateColumn": "title_yjs_state",
        "containerKey": "title",
        "rowIdField": "id",
        "kind": "text",
        "syncMode": "server-merge"
    })
}

fn crdt_validation_schema_json(crdt_field: Value, encrypted_fields: Value, scopes: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "tables": [{
            "name": "tasks",
            "primaryKeyColumn": "id",
            "serverVersionColumn": "server_version",
            "subscriptionId": "sub-tasks",
            "columns": [
                { "name": "id", "typeFamily": "text", "primaryKey": true },
                { "name": "title", "typeFamily": "text", "notnullRequired": true },
                { "name": "title_yjs_state", "typeFamily": "text" },
                { "name": "completed", "typeFamily": "integer", "notnullRequired": true },
                { "name": "server_version", "typeFamily": "integer", "notnullRequired": true }
            ],
            "crdtYjsFields": [crdt_field],
            "encryptedFields": encrypted_fields,
            "scopes": scopes
        }]
    })
}

fn test_encrypted_crdt() -> Result<EncryptedCrdt> {
    let mut keys = BTreeMap::new();
    keys.insert("default".to_string(), key_to_base64url(&[7u8; 32])?);
    EncryptedCrdt::from_static_config(StaticEncryptedCrdtConfig {
        keys,
        encryption_kid: None,
        partition_id: None,
    })
}

fn temp_db_path(prefix: &str) -> String {
    unique_temp_db_path(prefix)
}

#[derive(Clone, Copy)]
struct NoopTransport;

struct NoopRealtime;

#[derive(Clone)]
struct SharedCrdtServer {
    state: Arc<Mutex<CrdtServerState>>,
}

struct CrdtServerState {
    rows: BTreeMap<String, Value>,
    commits: Vec<CrdtServerCommit>,
    next_commit_seq: i64,
}

#[derive(Clone, Serialize)]
struct CrdtServerCommit {
    commit_seq: i64,
    client_id: String,
    changes: Vec<SyncChange>,
}

impl SharedCrdtServer {
    fn new(task_id: &str) -> Self {
        Self::with_tasks(&[task_id])
    }

    fn with_tasks(task_ids: &[&str]) -> Self {
        let mut rows = BTreeMap::new();
        for task_id in task_ids {
            rows.insert((*task_id).to_string(), task_row(task_id));
        }
        Self {
            state: Arc::new(Mutex::new(CrdtServerState {
                rows,
                commits: Vec::new(),
                next_commit_seq: 1,
            })),
        }
    }

    fn apply_operation(
        state: &mut CrdtServerState,
        client_id: &str,
        operation: &SyncOperation,
        commit_seq: i64,
    ) -> Result<SyncChange> {
        if is_encrypted_crdt_system_table(&operation.table) {
            return Ok(SyncChange {
                table: operation.table.clone(),
                row_id: operation.row_id.clone(),
                op: operation.op.clone(),
                row_json: operation.payload.clone(),
                row_version: Some(commit_seq),
                scopes: operation
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("scopes"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_else(scopes),
            });
        }
        if operation.table != "tasks" {
            return Err(SyncularError::protocol_message(format!(
                "test CRDT server only supports tasks, got {}",
                operation.table
            )));
        }
        let metadata = demo_todo_app_schema()
            .table_metadata("tasks")
            .expect("todo task metadata exists");
        match operation.op.as_str() {
            "upsert" => {
                let current_row = state.rows.get(&operation.row_id).cloned();
                let row = transform_local_row_for_metadata(
                    "tasks",
                    &operation.row_id,
                    None,
                    operation.payload.as_ref(),
                    current_row.as_ref(),
                    metadata,
                )?
                .unwrap_or_else(|| {
                    let mut row = current_row
                        .and_then(|row| row.as_object().cloned())
                        .unwrap_or_default();
                    if let Some(payload) = operation.payload.as_ref().and_then(Value::as_object) {
                        row.extend(payload.clone());
                    }
                    row.insert("id".to_string(), Value::String(operation.row_id.clone()));
                    Value::Object(row)
                });
                let mut row = row.as_object().cloned().ok_or_else(|| {
                    SyncularError::protocol_message("server CRDT row should be a JSON object")
                })?;
                row.insert("server_version".to_string(), json!(commit_seq));
                state
                    .rows
                    .insert(operation.row_id.clone(), Value::Object(row));
                Ok(SyncChange {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    op: operation.op.clone(),
                    row_json: operation.payload.clone(),
                    row_version: Some(commit_seq),
                    scopes: scopes(),
                })
            }
            "delete" => {
                state.rows.remove(&operation.row_id);
                Ok(SyncChange {
                    table: operation.table.clone(),
                    row_id: operation.row_id.clone(),
                    op: operation.op.clone(),
                    row_json: None,
                    row_version: Some(commit_seq),
                    scopes: scopes(),
                })
            }
            other => Err(SyncularError::protocol_message(format!(
                "unsupported test CRDT server operation {other}"
            ))),
        }
        .map_err(|err| err.context(format!("apply operation from {client_id}")))
    }
}

fn task_row(task_id: &str) -> Value {
    json!({
        "id": task_id,
        "title": "",
        "completed": 0,
        "user_id": "user-rust",
        "project_id": "p0",
        "server_version": 0,
        "image": null,
        "title_yjs_state": null
    })
}

fn seeded_todo_app_server(task_id: &str) -> Result<AppTestServer> {
    seeded_todo_app_server_with_delivery(task_id, AppTestServerDeliveryMode::Normal)
}

fn seeded_todo_app_server_with_delivery(
    task_id: &str,
    delivery_mode: AppTestServerDeliveryMode,
) -> Result<AppTestServer> {
    let server = AppTestServer::with_options(
        demo_todo_app_schema(),
        AppTestServerOptions {
            delivery_mode,
            ..AppTestServerOptions::default()
        },
    );
    server.seed_row("tasks", task_row(task_id))?;
    Ok(server)
}

impl SyncTransport for SharedCrdtServer {
    type Realtime = NoopRealtime;

    fn post_sync(&self, request: &CombinedRequest) -> Result<CombinedResponse> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| SyncularError::protocol_message("CRDT test server state poisoned"))?;

        let mut push_commits = Vec::new();
        if let Some(push) = &request.push {
            for commit in &push.commits {
                let commit_seq = state.next_commit_seq;
                state.next_commit_seq += 1;
                let mut changes = Vec::with_capacity(commit.operations.len());
                for operation in &commit.operations {
                    changes.push(Self::apply_operation(
                        &mut state,
                        &request.client_id,
                        operation,
                        commit_seq,
                    )?);
                }
                state.commits.push(CrdtServerCommit {
                    commit_seq,
                    client_id: request.client_id.clone(),
                    changes: changes.clone(),
                });
                push_commits.push(PushCommitResponse {
                    client_commit_id: commit.client_commit_id.clone(),
                    status: "applied".to_string(),
                    commit_seq: Some(commit_seq),
                    results: commit
                        .operations
                        .iter()
                        .enumerate()
                        .map(|(index, _)| OperationResult {
                            op_index: index as i32,
                            status: "applied".to_string(),
                            message: None,
                            error: None,
                            code: None,
                            retriable: None,
                            server_version: Some(commit_seq),
                            server_row: None,
                        })
                        .collect(),
                });
            }
        }

        let pull = request.pull.as_ref().map(|pull| PullResponse {
            ok: true,
            subscriptions: pull
                .subscriptions
                .iter()
                .map(|sub| {
                    let current_cursor = state.next_commit_seq - 1;
                    let bootstrap = sub.cursor < 0;
                    SubscriptionResponse {
                        id: sub.id.clone(),
                        status: "active".to_string(),
                        scopes: sub.scopes.clone(),
                        bootstrap,
                        bootstrap_state: None,
                        next_cursor: current_cursor,
                        commits: if bootstrap {
                            Vec::new()
                        } else {
                            self.deliver_commits(&state, sub.cursor, &request.client_id)
                        },
                        snapshots: bootstrap.then(|| {
                            vec![SyncSnapshot {
                                table: sub.table.clone(),
                                rows: if sub.table == "tasks" {
                                    state.rows.values().cloned().collect()
                                } else {
                                    Vec::new()
                                },
                                chunks: None,
                                manifest: None,
                                is_first_page: true,
                                is_last_page: true,
                                bootstrap_state_after: None,
                            }]
                        }),
                    }
                })
                .collect(),
        });

        Ok(CombinedResponse {
            ok: true,
            required_schema_version: None,
            latest_schema_version: None,
            push: request
                .push
                .as_ref()
                .map(|_| syncular_runtime::protocol::PushBatchResponse {
                    ok: true,
                    commits: push_commits,
                }),
            pull,
        })
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _: &SnapshotChunkRef,
        _: &ScopeValues,
    ) -> Result<SnapshotChunkRows> {
        Err(SyncularError::config(
            "CRDT conformance test server does not use snapshot chunks",
        ))
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(NoopRealtime)
    }
}

impl SharedCrdtServer {
    fn deliver_commits(
        &self,
        state: &CrdtServerState,
        cursor: i64,
        request_client_id: &str,
    ) -> Vec<SyncCommit> {
        state
            .commits
            .iter()
            .filter(|commit| commit.commit_seq > cursor && commit.client_id != request_client_id)
            .map(|commit| SyncCommit {
                partition_id: None,
                commit_seq: commit.commit_seq,
                created_at: "2026-05-13T00:00:00.000Z".to_string(),
                actor_id: commit.client_id.clone(),
                previous_chain_root: None,
                commit_digest: None,
                commit_chain_root: None,
                changes: commit.changes.clone(),
            })
            .collect()
    }
}

fn scopes() -> ScopeValues {
    let mut scopes = ScopeValues::new();
    scopes.insert("user_id".to_string(), json!("user-rust"));
    scopes.insert("project_id".to_string(), json!("p0"));
    scopes
}

impl SyncTransport for NoopTransport {
    type Realtime = NoopRealtime;

    fn post_sync(&self, _: &CombinedRequest) -> Result<CombinedResponse> {
        Err(SyncularError::config("noop transport does not sync"))
    }

    fn fetch_snapshot_chunk_rows(
        &self,
        _: &SnapshotChunkRef,
        _: &ScopeValues,
    ) -> Result<SnapshotChunkRows> {
        Err(SyncularError::config(
            "noop transport does not fetch snapshots",
        ))
    }

    fn connect_realtime(&self) -> Result<Self::Realtime> {
        Ok(NoopRealtime)
    }
}

impl RealtimeTransport for NoopRealtime {
    fn push_commit(&mut self, _: PushCommitRequest) -> Result<PushCommitResponse> {
        Err(SyncularError::config("noop realtime does not push"))
    }

    fn read_event(&mut self) -> Result<Option<RealtimeEvent>> {
        Ok(None)
    }

    fn close(&mut self) {}
}
