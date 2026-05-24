use std::time::Duration;

use serde_json::json;
use syncular_client::native::{NativeClientConfig, NativeEventKind, NativeSyncularClient};
use syncular_todo_app_example::generated::{
    migrations,
    syncular::{task_changed_rows, tasks_subscription, NewTask},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = std::env::args().nth(1).unwrap_or_else(|| {
        std::env::temp_dir()
            .join(format!(
                "syncular-generated-native-app-{}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    });
    remove_sqlite_files(&db_path);

    let actor_id = "user-rust";
    let project_id = "project-rust";
    let mut client = NativeSyncularClient::builder(NativeClientConfig {
        db_path: db_path.clone(),
        base_url: "http://127.0.0.1:9/sync".to_string(),
        client_id: "generated-native-app".to_string(),
        actor_id: actor_id.to_string(),
        project_id: Some(project_id.to_string()),
        app_schema_json: Some(generated_app_schema_json()?),
    })
    .auto_sync_local_writes(false)
    .open()?;

    client.set_auth_headers_json(r#"{"authorization":"Bearer generated-native-app"}"#)?;
    client.set_subscriptions(vec![tasks_subscription(actor_id, Some(project_id))])?;
    client.join_presence("tasks:project-rust", Some(json!({ "view": "tasks" })))?;

    let events = client.event_receiver(32);
    let task = NewTask::new(
        "generated-native-task",
        "Generated native app",
        actor_id,
        Some(project_id),
    );
    let operation_json = serde_json::to_string(&task.sync_operation())?;
    let local_row_json = serde_json::to_string(&task.row_json())?;
    let command_id = client.enqueue_mutation_json(&operation_json, Some(&local_row_json))?;

    while let Some(event) = events.recv_timeout(Duration::from_secs(2)) {
        if event.resync_required.unwrap_or(false)
            || matches!(event.kind, NativeEventKind::EventsOverflowed)
        {
            refresh_all_projections();
            continue;
        }

        for task in task_changed_rows(&event.changed_rows) {
            if let Some(row_id) = task.row_id() {
                refresh_task_projection(row_id);
            }
        }

        if event.kind == NativeEventKind::LocalWriteCommitted
            && event.command_id.as_deref() == Some(command_id.as_str())
        {
            break;
        }
    }

    client.update_presence_metadata("tasks:project-rust", json!({ "view": "done" }))?;
    client.leave_presence("tasks:project-rust")?;
    client.shutdown()?;
    remove_sqlite_files(&db_path);
    Ok(())
}

fn refresh_all_projections() {}

fn refresh_task_projection(_row_id: &str) {}

fn remove_sqlite_files(path: &str) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

fn generated_app_schema_json() -> Result<String, serde_json::Error> {
    let mut schema: serde_json::Value =
        serde_json::from_str(include_str!("../syncular.schema.json"))?;
    schema["schemaVersion"] = schema["appSchemaVersion"].clone();
    if let Some(tables) = schema["tables"].as_array_mut() {
        for table in tables {
            if let Some(subscription_id) = table["subscription"]["id"].as_str() {
                table["subscriptionId"] = json!(subscription_id);
            }
        }
    }
    schema["migrations"] = migrations::MIGRATIONS
        .iter()
        .map(|migration| {
            json!({
                "version": migration.version,
                "schemaVersion": migration.schema_version,
                "name": migration.name,
                "upSql": migration.up_sql,
            })
        })
        .collect();
    serde_json::to_string(&schema)
}
