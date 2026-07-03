//! # syncular-command — one JSON command surface over the Rust client core
//!
//! The command router the conformance shim proved (JSON in, JSON out, bytes
//! as `{"$bytes": hex}`) factored into a transport-agnostic module so BOTH
//! the stdio conformance shim AND the FFI native core dispatch through the
//! same code. That keeps a single command surface, conformance-locked via
//! the shim: whatever the shim exercises, the FFI core inherits.
//!
//! The router is generic over the `Transport` seam. The shim binds it to a
//! stdio host (transport inverted to the harness); the FFI crate binds it to
//! a real native HTTP+WS transport. Everything host-specific — realtime
//! notification draining, deferred requests, event queues — stays in each
//! host; only the pure `method → result` dispatch (and its JSON parsing) is
//! shared here.

use serde_json::{json, Value};
use ssp2::segment::{decode_rows_segment, encode_rows_segment};
use ssp2::{
    decode_message, encode_message, parse_control, render_message, render_rows_segment,
    ControlMessage,
};
use syncular_client::{ClientLimits, Mutation, SyncClient, Transport};

// -- bytes <-> {"$bytes": hex} (the driver-protocol byte envelope) ----------

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    syncular_client::values::bytes_to_hex(bytes)
}

pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    syncular_client::values::hex_to_bytes(hex)
}

pub fn bytes_value(bytes: &[u8]) -> Value {
    json!({ "$bytes": bytes_to_hex(bytes) })
}

pub fn value_bytes(value: Option<&Value>) -> Result<Vec<u8>, String> {
    let hex = value
        .and_then(|v| v.get("$bytes"))
        .and_then(Value::as_str)
        .ok_or_else(|| "expected a {\"$bytes\": hex} value".to_owned())?;
    hex_to_bytes(hex)
}

/// The `(code, message)` pair the driver protocol carries in an `error`.
pub type CommandError = (String, String);

/// Parsed side effects of a `create` command that the host must apply to its
/// own transport/clock (the router stays transport-agnostic). The client is
/// already installed into the `Option<SyncClient>` slot by `dispatch`.
#[derive(Debug, Default, Clone)]
pub struct CreateEffects {
    /// §5.4 capability the harness/host announced for its endpoints — the
    /// host sets its transport's `supports_url_fetch` accordingly.
    pub signed_urls: bool,
}

fn client_err(message: String) -> CommandError {
    ("client.failed".to_owned(), message)
}

fn need_client(client: &mut Option<SyncClient>) -> Result<&mut SyncClient, CommandError> {
    client
        .as_mut()
        .ok_or_else(|| client_err("no client instance created".to_owned()))
}

pub fn parse_limits(value: Option<&Value>) -> ClientLimits {
    let mut limits = ClientLimits::default();
    let Some(object) = value.and_then(Value::as_object) else {
        return limits;
    };
    limits.limit_commits = object
        .get("limitCommits")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    limits.limit_snapshot_rows = object
        .get("limitSnapshotRows")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    limits.max_snapshot_pages = object
        .get("maxSnapshotPages")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    limits.accept = object
        .get("accept")
        .and_then(Value::as_u64)
        .map(|v| v as u8);
    limits
}

pub fn parse_mutations(value: Option<&Value>) -> Result<Vec<Mutation>, String> {
    let list = value
        .and_then(Value::as_array)
        .ok_or_else(|| "mutations must be a list".to_owned())?;
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        let op = entry
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| "mutation missing op".to_owned())?;
        let table = entry
            .get("table")
            .and_then(Value::as_str)
            .ok_or_else(|| "mutation missing table".to_owned())?
            .to_owned();
        let base_version = entry.get("baseVersion").and_then(Value::as_i64);
        match op {
            "upsert" => {
                let values = entry
                    .get("values")
                    .and_then(Value::as_object)
                    .cloned()
                    .ok_or_else(|| "upsert missing values".to_owned())?;
                out.push(Mutation::Upsert {
                    table,
                    values,
                    base_version,
                });
            }
            "delete" => {
                let row_id = entry
                    .get("rowId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "delete missing rowId".to_owned())?
                    .to_owned();
                out.push(Mutation::Delete {
                    table,
                    row_id,
                    base_version,
                });
            }
            other => return Err(format!("unknown mutation op {other:?}")),
        }
    }
    Ok(out)
}

fn scopes_from_params(value: Option<&Value>) -> Result<Vec<(String, Vec<String>)>, String> {
    match value {
        Some(v) => syncular_client::values::json_to_scope_map(v),
        None => Ok(Vec::new()),
    }
}

/// Dispatch one command against the client instance over `transport`.
///
/// The `create` command installs a fresh `SyncClient` into `client` and
/// returns its parsed `CreateEffects` in the `Ok` result via `effects`; every
/// other command mutates the existing instance. Errors come back as the
/// driver-protocol `(code, message)` pair.
///
/// Generic over `T: Transport` so the shim (host-inverted transport) and the
/// FFI core (native HTTP+WS transport) share this exact router.
pub fn dispatch<T: Transport>(
    transport: &mut T,
    client: &mut Option<SyncClient>,
    effects: &mut CreateEffects,
    method: &str,
    params: &Value,
) -> Result<Value, CommandError> {
    match method {
        "create" => {
            let client_id = params
                .get("clientId")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("create missing clientId".to_owned()))?
                .to_owned();
            let schema = params
                .get("schema")
                .ok_or_else(|| client_err("create missing schema".to_owned()))?;
            let limits = parse_limits(params.get("limits"));
            // §native: a `dbPath` installs a file-backed rusqlite connection so
            // native hosts (Tauri plugin, FFI file variant) persist across
            // restarts; absent it, the default in-memory core (the shim's mode).
            let mut instance = match params.get("dbPath").and_then(Value::as_str) {
                Some(path) => {
                    SyncClient::open_path(client_id, schema, limits, path).map_err(client_err)?
                }
                None => SyncClient::new(client_id, schema, limits).map_err(client_err)?,
            };
            // Harness clock pin (§5.4 expiry runs on the virtual clock).
            if let Some(now_ms) = params.get("nowMs").and_then(Value::as_i64) {
                instance.set_now_ms(now_ms);
            }
            // §5.4 capability of the host endpoint set (accept bit 3) — the
            // host applies it to its own transport.
            effects.signed_urls = params
                .get("signedUrls")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            *client = Some(instance);
            Ok(json!({}))
        }
        "subscribe" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscribe missing id".to_owned()))?
                .to_owned();
            let table = params
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscribe missing table".to_owned()))?
                .to_owned();
            let scopes = scopes_from_params(params.get("scopes")).map_err(client_err)?;
            let sub_params = params
                .get("params")
                .and_then(Value::as_str)
                .map(str::to_owned);
            need_client(client)?
                .subscribe(id, table, scopes, sub_params)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "unsubscribe" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("unsubscribe missing id".to_owned()))?;
            need_client(client)?.unsubscribe(id);
            Ok(json!({}))
        }
        "mutate" => {
            let mutations = parse_mutations(params.get("mutations")).map_err(client_err)?;
            let id = need_client(client)?.mutate(mutations).map_err(client_err)?;
            Ok(json!({ "clientCommitId": id }))
        }
        "sync" => {
            let outcome = need_client(client)?.sync(transport);
            Ok(outcome.to_json())
        }
        "syncUntilIdle" => {
            let max_rounds = params
                .get("maxRounds")
                .and_then(Value::as_u64)
                .map(|v| v as u32);
            let outcome = need_client(client)?.sync_until_idle(transport, max_rounds);
            Ok(outcome.to_json())
        }
        "readRows" => {
            let table = params
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("readRows missing table".to_owned()))?;
            let rows = need_client(client)?.read_rows(table).map_err(client_err)?;
            Ok(json!({ "rows": rows }))
        }
        "query" => {
            // The React `useSyncQuery` live-query fast path: arbitrary read-only
            // SQL over the local visible tables/views. Params ride as the driver
            // value forms (bytes as `{"$bytes": hex}`); rows come back the same.
            let sql = params
                .get("sql")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("query missing sql".to_owned()))?;
            let bind = match params.get("params") {
                Some(Value::Array(list)) => list.clone(),
                None | Some(Value::Null) => Vec::new(),
                Some(_) => return Err(client_err("query params must be a list".to_owned())),
            };
            let rows = need_client(client)?.query(sql, &bind).map_err(client_err)?;
            Ok(json!({ "rows": rows }))
        }
        "uploadBlob" => {
            let bytes = value_bytes(params.get("bytes")).map_err(client_err)?;
            let media_type = params
                .get("mediaType")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let reference = need_client(client)?
                .upload_blob(&bytes, media_type, name)
                .map_err(client_err)?;
            Ok(json!({ "ref": reference }))
        }
        "fetchBlob" => {
            let blob = params
                .get("blob")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("fetchBlob missing blob".to_owned()))?
                .to_owned();
            // fetch_blob returns (code, message) so the server's blob.* code
            // reaches the caller (§5.9.5 cross-scope probe).
            let value = need_client(client)?.fetch_blob(transport, &blob)?;
            Ok(json!({ "blob": value }))
        }
        "conflicts" => {
            let conflicts = need_client(client)?.conflicts().to_vec();
            Ok(json!({ "conflicts": conflicts }))
        }
        "rejections" => {
            let rejections = need_client(client)?.rejections().to_vec();
            Ok(json!({ "rejections": rejections }))
        }
        "pendingCommitIds" => {
            let ids = need_client(client)?.pending_commit_ids();
            Ok(json!({ "ids": ids }))
        }
        "subscriptionState" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscriptionState missing id".to_owned()))?;
            let state = need_client(client)?.subscription_state(id);
            Ok(json!({ "state": state }))
        }
        "schemaFloor" => {
            let floor = need_client(client)?.schema_floor().cloned();
            Ok(json!({ "floor": floor }))
        }
        "leaseState" => {
            let lease = need_client(client)?.lease_state().cloned();
            Ok(json!({ "lease": lease }))
        }
        "upgrading" => {
            // §7.4.5: true while a schema-bump reset + first re-bootstrap runs.
            let value = need_client(client)?.upgrading();
            Ok(json!({ "value": value }))
        }
        "recreateWithSchema" => {
            // §7.4.2 "app ships new code": swap to the new schema on the SAME
            // in-memory database (the Rust core has no persistent restart, so
            // recreation IS the boot). Fires the §7.4.1 marker check.
            let schema = params
                .get("schema")
                .ok_or_else(|| client_err("recreateWithSchema missing schema".to_owned()))?;
            need_client(client)?
                .recreate_with_schema(schema)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "connectRealtime" => {
            need_client(client)?
                .connect_realtime(transport)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "disconnectRealtime" => {
            need_client(client)?.disconnect_realtime(transport);
            Ok(json!({}))
        }
        "syncNeeded" => {
            let value = need_client(client)?.sync_needed();
            Ok(json!({ "value": value }))
        }
        "setPresence" => {
            let scope_key = params
                .get("scopeKey")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("setPresence missing scopeKey".to_owned()))?
                .to_owned();
            // §8.6.2: `doc` may be a JSON object or null (a leave).
            let doc = params.get("doc");
            let doc_ref = match doc {
                None | Some(Value::Null) => None,
                Some(v) => Some(v),
            };
            need_client(client)?
                .set_presence(transport, &scope_key, doc_ref)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "presence" => {
            let scope_key = params
                .get("scopeKey")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("presence missing scopeKey".to_owned()))?;
            let peers = need_client(client)?.presence(scope_key);
            Ok(json!({ "peers": peers }))
        }

        // -- CodecDriver surface (Appendix A) — no client instance needed --
        "messageRoundtrip" => {
            let bytes = value_bytes(params.get("bytes")).map_err(client_err)?;
            match decode_message(&bytes) {
                Ok(message) => Ok(json!({
                    "ok": true,
                    "bytes": bytes_value(&encode_message(&message)),
                    "renderedJson": render_message(&message).to_string(),
                })),
                Err(error) => Ok(json!({ "ok": false, "errorCode": error.code.as_str() })),
            }
        }
        "segmentRoundtrip" => {
            let bytes = value_bytes(params.get("bytes")).map_err(client_err)?;
            match decode_rows_segment(&bytes) {
                Ok(segment) => Ok(json!({
                    "ok": true,
                    "bytes": bytes_value(&encode_rows_segment(&segment)),
                    "renderedJson": render_rows_segment(&segment).to_string(),
                })),
                Err(error) => Ok(json!({ "ok": false, "errorCode": error.code.as_str() })),
            }
        }
        "realtimeKnown" => {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("realtimeKnown missing text".to_owned()))?;
            let known = matches!(
                parse_control(text),
                Ok(ControlMessage::Hello { .. })
                    | Ok(ControlMessage::Wake { .. })
                    | Ok(ControlMessage::Heartbeat { .. })
                    | Ok(ControlMessage::Presence { .. })
            );
            Ok(json!({ "value": known }))
        }

        other => Err(client_err(format!("unknown method {other:?}"))),
    }
}
