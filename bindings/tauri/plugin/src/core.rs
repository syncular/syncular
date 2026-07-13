//! The transport-agnostic, Tauri-free CORE of the plugin.
//!
//! Everything here is plain Rust with no dependency on the `tauri` crate, so
//! it is unit-testable without a window or a mock runtime. The Tauri shell
//! (see `lib.rs`) is a thin layer that owns one [`SyncularCore`] on a
//! dedicated thread, forwards `syncular_command` / `syncular_query` invokes to
//! it, and pumps drained events onto the `syncular://event` Tauri channel.
//!
//! This mirrors the `syncular-ffi` `Handle`: one owned [`SyncClient`], one
//! owned [`HostTransport`] (native HTTP+WS via the `native-transport` feature),
//! and a derived event queue. The plugin is the THIRD consumer of the shared
//! `syncular-command` router (after the conformance shim and the FFI core), so
//! the command surface stays conformance-locked.
//!
//! ## Thread-safety, honestly
//!
//! [`SyncClient`] is synchronous and NOT `Sync` — it owns a rusqlite
//! connection. The plugin follows the shim/FFI pattern: exactly ONE thread
//! owns the core, and all access arrives through a command MAILBOX (an mpsc
//! channel). The Tauri commands (running on Tauri's async runtime) never touch
//! the client directly; they post a [`Request`] to the owning thread and await
//! the reply. The background host loop (§8.4) runs ON that same owning thread,
//! interleaved with mailbox requests, so there is never concurrent access to
//! the connection.

use std::collections::VecDeque;

use serde_json::{json, Value};
use syncular_client::SyncClient;
use syncular_command::{dispatch, CreateEffects};

use crate::transport::{self, HostTransport};

/// One client-observable event (§8 realtime signals + §6 conflicts + §1.6
/// schema floor + §7.3 lease). JSON-able; delivered onto the Tauri channel.
/// The same event vocabulary the FFI `poll_event` surfaces.
#[derive(Debug, Clone)]
pub struct Event {
    pub json: Value,
}

/// Snapshot of the client's observable state after the last drain, for
/// diffing into events (the FFI derive-events pattern).
#[derive(Debug, Default, Clone)]
struct ObservedState {
    sync_needed: bool,
    conflicts: usize,
    rejections: usize,
    pending_commits: usize,
    schema_floor: Option<Value>,
    lease_error: Option<String>,
}

/// The Tauri-free core: one client, its owned transport, the derived-event
/// diff state, and the pending event queue. Lives on ONE owning thread.
pub struct SyncularCore {
    client: Option<SyncClient>,
    transport: HostTransport,
    effects: CreateEffects,
    last: ObservedState,
    queue: VecDeque<Event>,
}

impl SyncularCore {
    /// Build a core from the plugin config JSON (`baseUrl`, `headers`, …). A
    /// `baseUrl` under the `native-transport` feature owns a real HTTP+WS
    /// transport; without it the core is client-local only (tests, offline).
    pub fn new(config: &Value) -> Result<Self, String> {
        let transport = HostTransport::from_config(config)?;
        Ok(SyncularCore {
            client: None,
            transport,
            effects: CreateEffects::default(),
            last: ObservedState::default(),
            queue: VecDeque::new(),
        })
    }

    /// Run one JSON command (`{"method","params"}`) through the shared router,
    /// then drain inbound realtime traffic and derive events. Returns the
    /// driver-protocol `{"result"|"error"}` reply.
    pub fn command(&mut self, command: &Value) -> Value {
        let method = command.get("method").and_then(Value::as_str).unwrap_or("");
        let params = command.get("params").cloned().unwrap_or(Value::Null);
        let result = dispatch(
            &mut self.transport,
            &mut self.client,
            &mut self.effects,
            method,
            &params,
        );
        if method == "create" {
            self.transport.set_signed_urls(self.effects.signed_urls);
        }
        self.drain_realtime();
        self.derive_events(method);
        match result {
            Ok(value) => json!({ "result": value }),
            Err((code, message)) => json!({ "error": { "code": code, "message": message } }),
        }
    }

    /// The `syncular_query` fast path: arbitrary read-only SQL over the local
    /// database. Routed through the same `query` command so there is one
    /// implementation (the router owns it); this wrapper spares the JS bridge
    /// from wrapping the method/params envelope for the hot live-query path.
    pub fn query(&mut self, sql: &str, params: Value) -> Value {
        let bind = match params {
            Value::Null => Value::Array(Vec::new()),
            other => other,
        };
        self.command(&json!({ "method": "query", "params": { "sql": sql, "params": bind } }))
    }

    /// True when the core wants a sync round (§8.4 coalesced signal). The host
    /// loop polls this to decide whether to run `syncUntilIdle`.
    pub fn sync_needed(&self) -> bool {
        self.client
            .as_ref()
            .map(SyncClient::sync_needed)
            .unwrap_or(false)
    }

    /// Run one `syncUntilIdle` round for the background host loop, deriving
    /// events afterwards. A no-op (empty reply) before `create`.
    pub fn sync_until_idle(&mut self) -> Value {
        if self.client.is_none() {
            return json!({ "result": null });
        }
        self.command(&json!({ "method": "syncUntilIdle", "params": {} }))
    }

    /// Drain every event queued since the last call (the host thread pushes
    /// them onto the Tauri channel). Mirrors the FFI `poll_event`, batched.
    pub fn drain_events(&mut self) -> Vec<Event> {
        self.queue.drain(..).collect()
    }

    /// Replace the transport's request headers (RFC 0002 §2.3 — rotating
    /// auth without tearing the plugin down). See
    /// `HostTransport::set_headers` for the HTTP/WS pickup semantics.
    pub fn set_headers(&mut self, headers: Vec<(String, String)>) {
        self.transport.set_headers(headers);
    }

    /// Release the socket/reader thread. Idempotent.
    pub fn shutdown(&mut self) {
        self.transport.shutdown();
    }

    fn push(&mut self, json: Value) {
        self.queue.push_back(Event { json });
    }

    /// Feed buffered inbound WS frames to the client (which may ack back through
    /// the same transport). A no-op without a native socket.
    fn drain_realtime(&mut self) {
        if self.client.is_none() {
            return;
        }
        let frames = self.transport.take_inbound();
        for frame in frames {
            match frame {
                transport::Inbound::Text(text) => {
                    if is_presence_control(&text) {
                        self.push(json!({ "type": "presence" }));
                    }
                    if let Some(client) = self.client.as_mut() {
                        client.on_realtime_text(&text);
                    }
                }
                transport::Inbound::Binary(bytes) => {
                    if let Some(client) = self.client.as_mut() {
                        client.on_realtime_binary(&mut self.transport, &bytes);
                    }
                }
            }
        }
    }

    /// Diff observable state against the last snapshot and enqueue one event
    /// per change (the invalidation-equivalent set). Same policy as the FFI,
    /// plus a coarse `invalidate` whenever the local database plausibly
    /// changed, so the webview's live queries re-run.
    ///
    /// `method` is the command that just ran (or `""` for a realtime-only
    /// drain). A `mutate` writes the optimistic overlay immediately — visible
    /// to local queries before any sync — so it always invalidates; sync
    /// rounds invalidate when they applied commits/segment rows or changed
    /// pending state.
    fn derive_events(&mut self, method: &str) {
        let Some(client) = self.client.as_ref() else {
            return;
        };
        let now = ObservedState {
            sync_needed: client.sync_needed(),
            conflicts: client.conflicts().len(),
            rejections: client.rejections().len(),
            pending_commits: client.pending_commit_ids().len(),
            schema_floor: client
                .schema_floor()
                .map(|f| serde_json::to_value(f).unwrap_or(Value::Null)),
            lease_error: client.lease_state().and_then(|l| l.error_code.clone()),
        };
        let mut pending: Vec<Value> = Vec::new();
        if now.sync_needed && !self.last.sync_needed {
            pending.push(json!({ "type": "sync-needed" }));
        }
        if now.conflicts > self.last.conflicts {
            pending.push(json!({ "type": "conflict", "count": now.conflicts }));
        }
        if now.rejections > self.last.rejections {
            pending.push(json!({ "type": "rejection", "count": now.rejections }));
        }
        if now.schema_floor != self.last.schema_floor {
            if let Some(floor) = &now.schema_floor {
                pending.push(json!({ "type": "schema-floor", "floor": floor }));
            }
        }
        if now.lease_error != self.last.lease_error {
            if let Some(code) = &now.lease_error {
                pending.push(json!({ "type": "lease", "errorCode": code }));
            }
        }
        // A local apply changed rows the webview's live queries depend on:
        // emit a coarse `invalidate` so the JS bridge re-runs its queries. A
        // `mutate` always writes the optimistic overlay; a sync round changes
        // data when its pending-commit count moved or conflicts appeared.
        let data_changed = method == "mutate"
            || now.pending_commits != self.last.pending_commits
            || now.conflicts != self.last.conflicts;
        if data_changed {
            pending.push(json!({ "type": "invalidate" }));
        }
        self.last = now;
        for event in pending {
            self.push(event);
        }
    }
}

/// A presence fanout control frame (§8.6.2) — `{"event":"presence",...}`, the
/// one inbound realtime event a native host surfaces directly.
fn is_presence_control(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("event")
                .and_then(Value::as_str)
                .map(|e| e == "presence")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_schema() -> Value {
        json!({
            "version": 1,
            "tables": [{
                "name": "todo",
                "primaryKey": "id",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "title", "type": "string", "nullable": false },
                    { "name": "done", "type": "boolean", "nullable": false }
                ],
                "scopes": []
            }]
        })
    }

    fn create(core: &mut SyncularCore) {
        let reply = core.command(&json!({
            "method": "create",
            "params": { "clientId": "c1", "schema": simple_schema() }
        }));
        assert_eq!(reply["result"], json!({}), "create ok: {reply}");
    }

    #[test]
    fn command_round_trip_create_mutate_query() {
        let mut core = SyncularCore::new(&json!({})).unwrap();
        create(&mut core);

        let sub = core.command(&json!({
            "method": "subscribe",
            "params": { "id": "s1", "table": "todo", "scopes": {} }
        }));
        assert_eq!(sub["result"], json!({}));

        let mutate = core.command(&json!({
            "method": "mutate",
            "params": { "mutations": [{
                "op": "upsert", "table": "todo",
                "values": { "id": "t1", "title": "hello", "done": false }
            }] }
        }));
        assert!(mutate["result"]["clientCommitId"].is_string(), "{mutate}");

        // The query fast path sees the optimistic overlay immediately.
        let rows = core.query("SELECT id, title FROM todo ORDER BY id", Value::Null);
        let list = rows["result"]["rows"].as_array().expect("rows");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["title"], "hello");
        assert_eq!(list[0]["id"], "t1");
    }

    #[test]
    fn query_binds_params() {
        let mut core = SyncularCore::new(&json!({})).unwrap();
        create(&mut core);
        core.command(&json!({
            "method": "mutate",
            "params": { "mutations": [
                { "op": "upsert", "table": "todo", "values": { "id": "a", "title": "A", "done": false } },
                { "op": "upsert", "table": "todo", "values": { "id": "b", "title": "B", "done": true } }
            ] }
        }));
        let rows = core.query("SELECT id FROM todo WHERE done = ?", json!([true]));
        let list = rows["result"]["rows"].as_array().expect("rows");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "b");
    }

    #[test]
    fn events_derived_after_mutate() {
        let mut core = SyncularCore::new(&json!({})).unwrap();
        // Before create, no events.
        create(&mut core);
        let _ = core.drain_events();
        core.command(&json!({
            "method": "mutate",
            "params": { "mutations": [{
                "op": "upsert", "table": "todo",
                "values": { "id": "t1", "title": "x", "done": false }
            }] }
        }));
        let events = core.drain_events();
        // A local mutate writes the optimistic overlay immediately (a pending
        // outbox commit appears) → an `invalidate` so live queries re-run. It
        // does NOT flag sync_needed (that is a realtime-wake signal per SPEC).
        let kinds: Vec<&str> = events
            .iter()
            .filter_map(|e| e.json.get("type").and_then(Value::as_str))
            .collect();
        assert!(kinds.contains(&"invalidate"), "kinds: {kinds:?}");
        // Draining is exhaustive.
        assert!(core.drain_events().is_empty());
    }

    #[test]
    fn sync_without_native_transport_fails_loud() {
        let mut core = SyncularCore::new(&json!({})).unwrap();
        create(&mut core);
        let outcome = core.command(&json!({ "method": "sync", "params": {} }));
        assert_eq!(outcome["result"]["ok"], json!(false), "{outcome}");
        assert_eq!(outcome["result"]["errorCode"], "transport.unavailable");
    }

    #[test]
    fn file_db_persists_across_reopen() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("syncular-tauri-test-{}.db", std::process::id()));
        let path_str = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);

        {
            let mut core = SyncularCore::new(&json!({})).unwrap();
            let reply = core.command(&json!({
                "method": "create",
                "params": { "clientId": "c1", "schema": simple_schema(), "dbPath": path_str }
            }));
            assert_eq!(reply["result"], json!({}), "create with dbPath: {reply}");
            core.command(&json!({
                "method": "mutate",
                "params": { "mutations": [{
                    "op": "upsert", "table": "todo",
                    "values": { "id": "persisted", "title": "kept", "done": false }
                }] }
            }));
        }
        // Reopen the same file: the persisted row is still there.
        {
            let mut core = SyncularCore::new(&json!({})).unwrap();
            core.command(&json!({
                "method": "create",
                "params": { "clientId": "c1", "schema": simple_schema(), "dbPath": path_str }
            }));
            let rows = core.query("SELECT title FROM todo", Value::Null);
            let list = rows["result"]["rows"].as_array().expect("rows");
            assert_eq!(list.len(), 1, "reopened db: {rows}");
            assert_eq!(list[0]["title"], "kept");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn config_validation_rejects_baseurl_without_native_feature() {
        let result = SyncularCore::new(&json!({ "baseUrl": "http://localhost:9/sync" }));
        #[cfg(not(feature = "native-transport"))]
        assert!(
            result.is_err(),
            "baseUrl must be refused without native-transport"
        );
        #[cfg(feature = "native-transport")]
        assert!(result.is_ok(), "baseUrl builds with native-transport");
    }
}
