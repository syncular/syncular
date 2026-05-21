use std::time::{Duration, Instant};

use serde_json::{json, Value};
use syncular_runtime::app_schema::{AppSchema, AppTableMetadata, EmbeddedMigration};
use syncular_runtime::error::{ErrorKind, Result, SyncularError};
use syncular_runtime::fixtures::todo;
use syncular_runtime::native::{
    NativeClientConfig, NativeClientOptions, NativeDiagnostic, NativeEvent, NativeEventKind,
    NativeEventSubscription, NativeSyncularClient,
};

use crate::temp::TempDbPath;

#[derive(Debug, Clone)]
pub struct NativeFixtureOptions {
    pub db_prefix: String,
    pub base_url: String,
    pub client_id: String,
    pub actor_id: String,
    pub project_id: Option<String>,
    pub client_options: NativeClientOptions,
}

impl Default for NativeFixtureOptions {
    fn default() -> Self {
        Self {
            db_prefix: "syncular-native-test".to_string(),
            base_url: "http://127.0.0.1:9/sync".to_string(),
            client_id: "native-test-client".to_string(),
            actor_id: "user-rust".to_string(),
            project_id: Some("p0".to_string()),
            client_options: NativeClientOptions {
                auto_sync_local_writes: false,
            },
        }
    }
}

pub struct NativeFixture {
    db: TempDbPath,
    pub client: NativeSyncularClient,
    pub events: NativeEventSubscription,
}

impl NativeFixture {
    pub fn db_path(&self) -> String {
        self.db.to_string_lossy()
    }

    pub fn close(mut self) -> Result<()> {
        self.client.close()
    }
}

pub fn open_native_client_with_schema(app_schema: AppSchema) -> Result<NativeFixture> {
    open_native_client_with_schema_options(app_schema, NativeFixtureOptions::default())
}

pub fn open_native_client_with_schema_options(
    app_schema: AppSchema,
    options: NativeFixtureOptions,
) -> Result<NativeFixture> {
    let db = TempDbPath::new(&options.db_prefix);
    let config = native_config_for_db(&db, &options, None);
    let client = NativeSyncularClient::open_with_options_and_schema(
        config.into(),
        options.client_options,
        app_schema,
    )?;
    let events = client.subscribe_events(256);
    Ok(NativeFixture { db, client, events })
}

pub fn open_native_client_with_schema_json(schema_json: String) -> Result<NativeFixture> {
    open_native_client_with_schema_json_options(schema_json, NativeFixtureOptions::default())
}

pub fn open_native_client_with_schema_json_options(
    schema_json: String,
    options: NativeFixtureOptions,
) -> Result<NativeFixture> {
    let db = TempDbPath::new(&options.db_prefix);
    let config = native_config_for_db(&db, &options, Some(schema_json));
    let client = NativeSyncularClient::open_native_with_options(config, options.client_options)?;
    let events = client.subscribe_events(256);
    Ok(NativeFixture { db, client, events })
}

pub fn native_config_for_db(
    db: &TempDbPath,
    options: &NativeFixtureOptions,
    app_schema_json: Option<String>,
) -> NativeClientConfig {
    NativeClientConfig {
        db_path: db.to_string_lossy(),
        base_url: options.base_url.clone(),
        client_id: options.client_id.clone(),
        actor_id: options.actor_id.clone(),
        project_id: options.project_id.clone(),
        app_schema_json,
    }
}

pub fn app_schema_json(app_schema: AppSchema) -> String {
    json!({
        "schemaVersion": app_schema.current_schema_version(),
        "tables": app_schema
            .app_table_metadata
            .iter()
            .map(app_table_metadata_json)
            .collect::<Vec<_>>(),
        "migrations": app_schema
            .migrations
            .iter()
            .map(embedded_migration_json)
            .collect::<Vec<_>>()
    })
    .to_string()
}

pub fn todo_app_schema_json() -> String {
    app_schema_json(todo::app_schema())
}

pub fn wait_native_event(
    events: &NativeEventSubscription,
    kind: NativeEventKind,
    timeout: Duration,
) -> NativeEvent {
    wait_native_event_matching(events, timeout, |event| event.kind == kind)
        .unwrap_or_else(|| panic!("timed out waiting for native event {kind:?}"))
}

pub fn wait_native_event_matching(
    events: &NativeEventSubscription,
    timeout: Duration,
    mut predicate: impl FnMut(&NativeEvent) -> bool,
) -> Option<NativeEvent> {
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let remaining = deadline.saturating_duration_since(now);
        let event = events.next_event_timeout(remaining)?;
        if predicate(&event) {
            return Some(event);
        }
    }
}

pub fn drain_native_events(
    subscription: &NativeEventSubscription,
    timeout: Duration,
) -> Vec<NativeEvent> {
    let mut events = Vec::new();
    while let Some(event) = subscription.next_event_timeout(timeout) {
        events.push(event);
    }
    events
}

pub fn assert_native_event_kind(event: &NativeEvent, expected: NativeEventKind) {
    assert_eq!(event.kind, expected, "unexpected native event: {event:?}");
}

pub fn assert_native_rows_changed(event: &NativeEvent, expected_tables: &[&str]) {
    assert_native_event_kind(event, NativeEventKind::RowsChanged);
    let expected = expected_tables
        .iter()
        .map(|table| table.to_string())
        .collect::<Vec<_>>();
    assert_eq!(event.tables, expected, "unexpected changed tables");
}

pub fn assert_native_table_row_count(
    client: &mut NativeSyncularClient,
    table: &str,
    expected: usize,
) -> Vec<Value> {
    let rows_json = client.list_table_json(table).expect("native table rows");
    let rows: Vec<Value> = serde_json::from_str(&rows_json).expect("native table rows json");
    assert_eq!(
        rows.len(),
        expected,
        "unexpected native row count for {table}"
    );
    rows
}

pub fn todo_task_upsert_operation_json(task_id: &str, title: &str) -> String {
    json!({
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
    .to_string()
}

pub fn apply_native_todo_task_upsert(
    client: &mut NativeSyncularClient,
    task_id: &str,
    title: &str,
) -> Result<String> {
    client.apply_mutation_json(&todo_task_upsert_operation_json(task_id, title), None)
}

pub fn assert_native_error_kind(event: &NativeEvent, expected: ErrorKind) {
    assert_eq!(
        event.error.as_ref().map(|error| error.kind),
        Some(expected),
        "unexpected native event error: {event:?}"
    );
}

pub fn assert_native_error_code(event: &NativeEvent, expected: &str) {
    assert_eq!(
        event.error.as_ref().map(|error| error.code.as_str()),
        Some(expected),
        "unexpected native event error code: {event:?}"
    );
}

pub fn assert_native_diagnostic_code<'a>(
    event: &'a NativeEvent,
    expected: &str,
) -> &'a NativeDiagnostic {
    let diagnostic = event
        .diagnostic
        .as_ref()
        .unwrap_or_else(|| panic!("expected native diagnostic on event: {event:?}"));
    assert_eq!(
        diagnostic.code, expected,
        "unexpected native diagnostic code on event: {event:?}"
    );
    diagnostic
}

pub fn assert_native_diagnostic_detail(event: &NativeEvent, key: &str, expected: Value) {
    let diagnostic = event
        .diagnostic
        .as_ref()
        .unwrap_or_else(|| panic!("expected native diagnostic on event: {event:?}"));
    assert_eq!(
        diagnostic.details.get(key),
        Some(&expected),
        "unexpected native diagnostic detail {key} on event: {event:?}"
    );
}

pub fn parse_native_event_json(event_json: &str) -> Result<NativeEvent> {
    serde_json::from_str(event_json).map_err(SyncularError::from)
}

fn app_table_metadata_json(table: &AppTableMetadata) -> Value {
    json!({
        "name": table.name,
        "primaryKeyColumn": table.primary_key_column,
        "serverVersionColumn": table.server_version_column,
        "softDeleteColumn": table.soft_delete_column,
        "subscriptionId": table.subscription_id,
        "columns": table.columns.iter().map(|column| {
            json!({
                "name": column.name,
                "typeFamily": column.type_family,
                "notnullRequired": column.notnull_required,
                "primaryKey": column.primary_key
            })
        }).collect::<Vec<_>>(),
        "blobColumns": table.blob_columns,
        "crdtYjsFields": table.crdt_yjs_fields.iter().map(|field| {
            json!({
                "field": field.field,
                "stateColumn": field.state_column,
                "containerKey": field.container_key,
                "rowIdField": field.row_id_field,
                "kind": field.kind,
                "syncMode": field.sync_mode
            })
        }).collect::<Vec<_>>(),
        "encryptedFields": table.encrypted_fields.iter().map(|field| {
            json!({
                "field": field.field,
                "scope": field.scope,
                "rowIdField": field.row_id_field
            })
        }).collect::<Vec<_>>(),
        "scopes": table.scopes.iter().map(|scope| {
            json!({
                "name": scope.name,
                "column": scope.column,
                "source": scope.source,
                "required": scope.required
            })
        }).collect::<Vec<_>>()
    })
}

fn embedded_migration_json(migration: &EmbeddedMigration) -> Value {
    json!({
        "version": migration.version,
        "schemaVersion": migration.schema_version,
        "name": migration.name,
        "upSql": migration.up_sql
    })
}
