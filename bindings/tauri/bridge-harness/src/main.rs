//! Headless line-protocol harness for the real Tauri plugin core.
//!
//! This is test infrastructure, not a shipped binding. It lets the TypeScript
//! bridge and reactive store consume the exact command replies/events produced
//! by `tauri-plugin-syncular::core::SyncularCore` without requiring a display.

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};
use syncular_client::FileQuerySnapshotReader;
use tauri_plugin_syncular::core::SyncularCore;

fn inject_db_path(mut command: Value, path: &str) -> Value {
    if command.get("method").and_then(Value::as_str) != Some("create") {
        return command;
    }
    if let Some(params) = command.get_mut("params").and_then(Value::as_object_mut) {
        params.insert("dbPath".to_owned(), Value::from(path));
    }
    command
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut core = SyncularCore::new(&json!({}))?;
    let db_path = std::env::temp_dir().join(format!(
        "syncular-tauri-bridge-harness-{}.db",
        std::process::id()
    ));
    let db_path_string = db_path.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&db_path);
    let mut reader = FileQuerySnapshotReader::new(db_path_string.clone());
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line)?;
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let reply = match request.get("kind").and_then(Value::as_str) {
            Some("command") => {
                let command = inject_db_path(
                    request.get("command").cloned().unwrap_or(Value::Null),
                    &db_path_string,
                );
                core.command(&command)
            }
            Some("query") => core.query(
                request.get("sql").and_then(Value::as_str).unwrap_or(""),
                request.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("snapshot") => {
                let sql = request.get("sql").and_then(Value::as_str).unwrap_or("");
                let params = request
                    .get("params")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                match reader.query_snapshot(sql, &params, &[]) {
                    Ok(snapshot) => json!({ "result": snapshot }),
                    Err(message) => {
                        json!({ "error": { "code": "client.failed", "message": message } })
                    }
                }
            }
            _ => {
                json!({ "error": { "code": "harness.invalid_request", "message": "unknown harness request kind" } })
            }
        };
        let events: Vec<Value> = core
            .drain_events()
            .into_iter()
            .map(|event| event.json)
            .collect();
        serde_json::to_writer(
            &mut stdout,
            &json!({
                "id": id,
                "reply": reply,
                "events": events,
            }),
        )?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    core.shutdown();
    drop(reader);
    let _ = std::fs::remove_file(db_path);
    Ok(())
}
