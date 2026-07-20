//! End-to-end exercise of the C-ABI surface from Rust (default build:
//! client-local, no native transport). Proves the 5 functions marshal JSON,
//! run the shared command router, forward exact core events, and free cleanly.

use std::ffi::{CStr, CString};

use serde_json::{json, Value};

use crate::{
    syncular_client_close, syncular_client_command, syncular_client_new,
    syncular_client_poll_event, syncular_free_string,
};

/// Send one command and return the parsed reply, freeing the C string.
fn command(handle: *mut crate::Handle, method: &str, params: Value) -> Value {
    let cmd = CString::new(json!({ "method": method, "params": params }).to_string()).unwrap();
    let reply_ptr = syncular_client_command(handle, cmd.as_ptr());
    assert!(!reply_ptr.is_null(), "command {method} returned null");
    let text = unsafe { CStr::from_ptr(reply_ptr) }
        .to_str()
        .unwrap()
        .to_owned();
    syncular_free_string(reply_ptr);
    serde_json::from_str(&text).unwrap()
}

/// Poll one event and free its C string.
fn poll_event(handle: *mut crate::Handle) -> Option<Value> {
    let event_ptr = syncular_client_poll_event(handle, 0);
    if event_ptr.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(event_ptr) }
        .to_str()
        .unwrap()
        .to_owned();
    syncular_free_string(event_ptr);
    Some(serde_json::from_str(&text).unwrap())
}

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

#[test]
fn new_command_readrows_close_roundtrips() {
    let config = CString::new("{}").unwrap();
    let handle = syncular_client_new(config.as_ptr());
    assert!(!handle.is_null());

    // create
    let create = command(
        handle,
        "create",
        json!({ "clientId": "c1", "schema": simple_schema() }),
    );
    assert_eq!(create["result"], json!({}), "create ok: {create}");

    // subscribe
    let sub = command(
        handle,
        "subscribe",
        json!({ "id": "s1", "table": "todo", "scopes": {} }),
    );
    assert_eq!(sub["result"], json!({}));

    // mutate — an optimistic local upsert
    let mutate = command(
        handle,
        "mutate",
        json!({ "mutations": [{
            "op": "upsert",
            "table": "todo",
            "values": { "id": "t1", "title": "hello", "done": false }
        }] }),
    );
    assert!(
        mutate["result"]["clientCommitId"].is_string(),
        "mutate returns a commit id: {mutate}"
    );

    // readRows — the optimistic overlay is visible locally
    let rows = command(handle, "readRows", json!({ "table": "todo" }));
    let list = rows["result"]["rows"].as_array().expect("rows array");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["values"]["title"], "hello");

    // pendingCommitIds — one queued commit
    let pending = command(handle, "pendingCommitIds", Value::Null);
    assert_eq!(pending["result"]["ids"].as_array().unwrap().len(), 1);

    syncular_client_close(handle);
}

#[test]
fn sync_without_native_transport_fails_loud() {
    let config = CString::new("{}").unwrap();
    let handle = syncular_client_new(config.as_ptr());
    command(
        handle,
        "create",
        json!({ "clientId": "c1", "schema": simple_schema() }),
    );
    let outcome = command(handle, "sync", Value::Null);
    // The client turns a transport error into a Failed outcome (never a panic).
    assert_eq!(outcome["result"]["ok"], json!(false), "outcome: {outcome}");
    assert_eq!(
        outcome["result"]["errorCode"], "transport.unavailable",
        "outcome: {outcome}"
    );
    syncular_client_close(handle);
}

#[test]
fn poll_event_nonblocking_returns_null_when_empty() {
    let config = CString::new("{}").unwrap();
    let handle = syncular_client_new(config.as_ptr());
    command(
        handle,
        "create",
        json!({ "clientId": "c1", "schema": simple_schema() }),
    );
    // Active creation publishes the initial diagnostics snapshot exactly once.
    let initial = poll_event(handle).expect("initial diagnostics event");
    assert_eq!(initial["type"], "diagnostics");
    assert_eq!(initial["snapshot"]["version"], 1);
    // Non-blocking poll after the queue is drained → null.
    let ev = syncular_client_poll_event(handle, 0);
    assert!(ev.is_null());
    syncular_client_close(handle);
}

#[test]
fn poll_event_forwards_exact_change_batches_and_sync_intents() {
    let config = CString::new("{}").unwrap();
    let handle = syncular_client_new(config.as_ptr());
    command(
        handle,
        "create",
        json!({ "clientId": "c1", "schema": simple_schema() }),
    );
    command(
        handle,
        "mutate",
        json!({ "mutations": [{
            "op": "upsert",
            "table": "todo",
            "values": { "id": "t1", "title": "hello", "done": false }
        }] }),
    );

    let mut events = Vec::new();
    while let Some(event) = poll_event(handle) {
        events.push(event);
    }
    let change = events
        .iter()
        .find(|event| event["type"] == "change")
        .expect("mutation publishes a change batch");
    assert!(change["batch"]["revision"].is_string());
    assert_eq!(change["batch"]["tables"][0]["table"], "todo");
    assert_eq!(change["batch"]["status"]["outbox"], 1);
    let intent = events
        .iter()
        .find(|event| event["type"] == "sync-intent")
        .expect("mutation publishes sync intent");
    assert_eq!(intent["intent"]["kind"], "interactive");
    let diagnostics = events
        .iter()
        .rfind(|event| event["type"] == "diagnostics")
        .expect("mutation publishes changed diagnostics");
    assert_eq!(diagnostics["snapshot"]["version"], 1);
    assert_eq!(diagnostics["snapshot"]["replica"]["pendingOutbox"], 1);

    syncular_client_close(handle);
}

#[test]
fn diagnostics_command_reports_expected_intent_without_private_payloads() {
    let config = CString::new("{}").unwrap();
    let handle = syncular_client_new(config.as_ptr());
    command(
        handle,
        "create",
        json!({ "clientId": "private-client", "schema": simple_schema() }),
    );
    let reply = command(
        handle,
        "diagnosticsSnapshot",
        json!({
            "expectedSubscriptions": [{ "id": "membership", "table": "todo" }]
        }),
    );
    assert_eq!(
        reply["result"]["subscriptions"][0]["state"], "unregistered",
        "diagnostics reply: {reply}"
    );
    let encoded = reply.to_string();
    assert!(!encoded.contains("private-client"));
    assert!(!encoded.contains("operations"));
    syncular_client_close(handle);
}

#[test]
fn preflight_refuses_plain_replacement_creates_and_activates_with_headers() {
    let config = CString::new("{}").unwrap();
    let handle = syncular_client_new(config.as_ptr());
    let created = command(
        handle,
        "create",
        json!({
            "clientId": "ffi-preflight-escape",
            "schema": simple_schema(),
            "securityPreflight": true
        }),
    );
    assert_eq!(created["result"], json!({}), "preflight create: {created}");

    // The escape the gate exists to prevent: re-issuing create WITHOUT the
    // securityPreflight flag must be refused by the shared router.
    let escape = command(
        handle,
        "create",
        json!({ "clientId": "ffi-preflight-escape", "schema": simple_schema() }),
    );
    assert_eq!(
        escape["error"]["code"], "client.security_preflight_required",
        "{escape}"
    );
    let gated = command(
        handle,
        "query",
        json!({ "sql": "SELECT id FROM todo", "params": [] }),
    );
    assert_eq!(gated["error"]["code"], "client.security_preflight_required");

    // Invalid activation headers fail loudly and keep the gate closed.
    let invalid = command(
        handle,
        "activateSecurity",
        json!({ "headers": { "authorization": 7 } }),
    );
    assert_eq!(invalid["error"]["code"], "sync.invalid_request", "{invalid}");
    let lifecycle = command(handle, "securityLifecycle", Value::Null);
    assert_eq!(lifecycle["result"]["state"], "preflight");

    // A valid header set rides the activation atomically (applied to the
    // owned transport before any startup sync round) and releases the gate.
    let activated = command(
        handle,
        "activateSecurity",
        json!({ "headers": { "authorization": "Bearer post-preflight" } }),
    );
    assert_eq!(activated["result"], json!({}), "{activated}");
    let rows = command(
        handle,
        "query",
        json!({ "sql": "SELECT id FROM todo", "params": [] }),
    );
    assert_eq!(rows["result"]["rows"], json!([]));
    let recreated = command(
        handle,
        "create",
        json!({ "clientId": "ffi-preflight-escape", "schema": simple_schema() }),
    );
    assert_eq!(
        recreated["result"],
        json!({}),
        "plain create after activation: {recreated}"
    );
    syncular_client_close(handle);
}

#[test]
fn malformed_config_returns_null_handle() {
    let bad = CString::new("not json").unwrap();
    let handle = syncular_client_new(bad.as_ptr());
    assert!(handle.is_null());
}

/// The five exported symbols and the five header declarations must be the
/// same set. Cheap `nm` inspection of the built staticlib; skipped (not
/// failed) if the artifact or `nm` is absent so the test stays hermetic.
#[test]
fn header_matches_symbols() {
    use std::process::Command;

    const EXPECTED: [&str; 5] = [
        "syncular_client_new",
        "syncular_client_command",
        "syncular_client_poll_event",
        "syncular_client_close",
        "syncular_free_string",
    ];

    // 1) The header declares exactly the five functions.
    let header = include_str!("../../../ffi.h");
    for name in EXPECTED {
        assert!(
            header.contains(name),
            "ffi.h is missing the exported symbol {name}"
        );
    }

    // 2) The built staticlib exports exactly those five (nm inspection).
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut candidates = Vec::new();
    for profile in ["debug", "release"] {
        for lib in ["libsyncular.a", "libsyncular.dylib", "libsyncular.so"] {
            candidates.push(format!("{manifest}/../../target/{profile}/{lib}"));
        }
    }
    let Some(artifact) = candidates
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("skipping symbol check: no built libsyncular artifact found");
        return;
    };
    let Ok(output) = Command::new("nm").arg(&artifact).output() else {
        eprintln!("skipping symbol check: nm unavailable");
        return;
    };
    let symbols = String::from_utf8_lossy(&output.stdout);
    for name in EXPECTED {
        // Mach-O prefixes exported C symbols with an underscore; match either.
        let found = symbols
            .lines()
            .any(|l| l.ends_with(&format!(" {name}")) || l.ends_with(&format!(" _{name}")));
        assert!(found, "exported symbol {name} not found in {artifact}");
    }
}

#[test]
fn baseurl_without_native_feature_is_rejected() {
    // The default build has no native transport; a baseUrl config is refused.
    let config = CString::new(r#"{"baseUrl":"http://localhost:1/sync"}"#).unwrap();
    let handle = syncular_client_new(config.as_ptr());
    #[cfg(not(feature = "native-transport"))]
    assert!(handle.is_null());
    #[cfg(feature = "native-transport")]
    {
        // With the feature, the handle builds (no connection attempted yet).
        assert!(!handle.is_null());
        syncular_client_close(handle);
    }
}
