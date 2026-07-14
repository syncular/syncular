//! Headless line-protocol harness for the real Tauri plugin core.
//!
//! This is test infrastructure, not a shipped binding. It lets the TypeScript
//! bridge and reactive store consume the exact command replies/events produced
//! by `tauri-plugin-syncular::core::SyncularCore` without requiring a display.

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};
use tauri_plugin_syncular::core::SyncularCore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut core = SyncularCore::new(&json!({}))?;
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
            Some("command") => core.command(request.get("command").unwrap_or(&Value::Null)),
            Some("query") => core.query(
                request.get("sql").and_then(Value::as_str).unwrap_or(""),
                request.get("params").cloned().unwrap_or(Value::Null),
            ),
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
    Ok(())
}
