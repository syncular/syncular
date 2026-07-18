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
use syncular_client::{
    ClientLimits, CommandEffects, CommitOutcomeQuery, LocalDataPurgeInput, Mutation,
    ResolveCommitOutcomeInput, SyncClient, Transport, WindowBase, WindowCoverage,
};

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
    let code = message
        .split_once(':')
        .map(|(candidate, _)| candidate)
        .filter(|candidate| candidate.starts_with("client.") || candidate.starts_with("sync."))
        .unwrap_or("client.failed");
    (code.to_owned(), message)
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
    limits.blob_cache_max_bytes = object.get("blobCacheMaxBytes").and_then(Value::as_i64);
    limits.outcome_retention_max_entries = object
        .get("outcomeRetentionMaxEntries")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    limits
}

/// §5.11: parse the `encryption` config into the client's portable keyring.
/// Shape: `{ keys: { "<keyId>": {"$bytes": "<hex>"} },
/// keyIdColumns: { "<table>": "<column>" } }`. Keys are 32 bytes.
pub fn parse_encryption(
    value: &Value,
) -> Result<syncular_client::values::EncryptionConfig, String> {
    let mut config = syncular_client::values::EncryptionConfig::default();
    let Some(keys) = value.get("keys").and_then(Value::as_object) else {
        return Ok(config);
    };
    for (key_id, key_val) in keys {
        let bytes =
            value_bytes(Some(key_val)).map_err(|e| format!("encryption key {key_id:?}: {e}"))?;
        if bytes.len() != 32 {
            return Err(format!(
                "encryption key {key_id:?} must be 32 bytes, got {}",
                bytes.len()
            ));
        }
        config.keys.insert(key_id.clone(), bytes);
    }
    if let Some(columns) = value.get("keyIdColumns") {
        let columns = columns
            .as_object()
            .ok_or_else(|| "encryption keyIdColumns must be an object".to_owned())?;
        for (table, column) in columns {
            let column = column.as_str().ok_or_else(|| {
                format!("encryption keyIdColumns entry for {table:?} must be a string")
            })?;
            if column.is_empty() {
                return Err(format!(
                    "encryption keyIdColumns entry for {table:?} must not be empty"
                ));
            }
            config
                .key_id_columns
                .insert(table.clone(), column.to_owned());
        }
    }
    Ok(config)
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
                let mut values = entry
                    .get("values")
                    .and_then(Value::as_object)
                    .cloned()
                    .ok_or_else(|| "upsert missing values".to_owned())?;
                decode_bigint_members(&mut values)?;
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

fn decode_bigint_members(values: &mut serde_json::Map<String, Value>) -> Result<(), String> {
    for value in values.values_mut() {
        let Some(decimal) = value.get("$bigint").and_then(Value::as_str) else {
            continue;
        };
        let integer = decimal
            .parse::<i64>()
            .map_err(|_| format!("bigint value {decimal:?} is outside SQLite's i64 range"))?;
        *value = Value::from(integer);
    }
    Ok(())
}

fn scopes_from_params(value: Option<&Value>) -> Result<Vec<(String, Vec<String>)>, String> {
    match value {
        Some(v) => syncular_client::values::json_to_scope_map(v),
        None => Ok(Vec::new()),
    }
}

/// §4.8: parse a window base descriptor `{ table, variable, fixedScopes?,
/// params? }` from a command's `base` param.
fn window_base_from_params(value: Option<&Value>) -> Result<WindowBase, String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "setWindow/windowState missing base object".to_owned())?;
    let table = object
        .get("table")
        .and_then(Value::as_str)
        .ok_or_else(|| "window base missing table".to_owned())?
        .to_owned();
    let variable = object
        .get("variable")
        .and_then(Value::as_str)
        .ok_or_else(|| "window base missing variable".to_owned())?
        .to_owned();
    let fixed_scopes = scopes_from_params(object.get("fixedScopes"))?;
    let params = object
        .get("params")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(WindowBase {
        table,
        variable,
        fixed_scopes,
        params,
    })
}

/// §5.10.5: parse the common `(table, rowId, column, name)` target of a crdt
/// command. `name` selects the shared type inside the doc (default `"text"`,
/// matching the TS `YjsColumn.text()` default).
#[cfg(feature = "crdt-yjs")]
fn crdt_target(params: &Value) -> Result<(String, String, String, String), CommandError> {
    let table = params
        .get("table")
        .and_then(Value::as_str)
        .ok_or_else(|| client_err("crdt command missing table".to_owned()))?
        .to_owned();
    let row_id = params
        .get("rowId")
        .and_then(Value::as_str)
        .ok_or_else(|| client_err("crdt command missing rowId".to_owned()))?
        .to_owned();
    let column = params
        .get("column")
        .and_then(Value::as_str)
        .ok_or_else(|| client_err("crdt command missing column".to_owned()))?
        .to_owned();
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("text")
        .to_owned();
    Ok((table, row_id, column, name))
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
    if method != "create" {
        let allowed_during_preflight = matches!(
            method,
            "securityLifecycle"
                | "beginSecurityPreflight"
                | "activateSecurity"
                | "purgeLocalData"
                | "localRevision"
                | "statusSnapshot"
                | "shutdown"
        );
        if client
            .as_ref()
            .is_some_and(|running| running.security_preflight())
            && !allowed_during_preflight
        {
            return Err((
                syncular_client::SECURITY_PREFLIGHT_REQUIRED_CODE.to_owned(),
                "the local replica is in security preflight; complete quarantine checks and call activateSecurity before accessing protected data".to_owned(),
            ));
        }
    }
    match method {
        "create" => {
            let client_id = params
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let schema = params
                .get("schema")
                .ok_or_else(|| client_err("create missing schema".to_owned()))?;
            let limits = parse_limits(params.get("limits"));
            // §native: a `dbPath` installs a file-backed rusqlite connection so
            // native hosts (Tauri plugin, FFI file variant) persist across
            // restarts; absent it, the default in-memory core (the shim's mode).
            let mut instance = match params.get("dbPath").and_then(Value::as_str) {
                Some(path) => SyncClient::open_path_with_identity(client_id, schema, limits, path)
                    .map_err(client_err)?,
                None => {
                    SyncClient::new_with_identity(client_id, schema, limits).map_err(client_err)?
                }
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
            // §5.11: install client-side encryption keys. Shape:
            // { encryption: { keys: { "<keyId>": {"$bytes": "<hex>"} },
            //                 keyIdColumns: { "<table>": "<column>" } } }.
            let security_preflight = params
                .get("securityPreflight")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if security_preflight && params.get("encryption").is_some() {
                return Err(client_err(
                    "sync.invalid_request: securityPreflight and encryption are mutually exclusive; install keys with activateSecurity after preflight"
                        .to_owned(),
                ));
            }
            if let Some(enc) = params.get("encryption") {
                let config = parse_encryption(enc).map_err(client_err)?;
                instance.set_encryption(config);
            }
            if security_preflight {
                instance.begin_security_preflight();
            }
            *client = Some(instance);
            Ok(json!({}))
        }
        "securityLifecycle" => Ok(json!({
            "state": need_client(client)?.security_lifecycle()
        })),
        "beginSecurityPreflight" => {
            let running = need_client(client)?;
            running.disconnect_realtime(transport);
            running.begin_security_preflight();
            Ok(json!({}))
        }
        "activateSecurity" => {
            let encryption = match params.get("encryption") {
                Some(value) => parse_encryption(value).map_err(client_err)?,
                None => syncular_client::values::EncryptionConfig::default(),
            };
            need_client(client)?
                .activate_security(encryption)
                .map_err(client_err)?;
            Ok(json!({}))
        }
        "shutdown" => {
            if let Some(running) = client.as_mut() {
                running.disconnect_realtime(transport);
                running.begin_security_preflight();
            }
            *client = None;
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
        "setWindow" => {
            let base = window_base_from_params(params.get("base")).map_err(client_err)?;
            let units: Vec<String> = params
                .get("units")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let command_effects = need_client(client)?
                .set_window(&base, &units)
                .map_err(client_err)?;
            Ok(json!({ "effects": command_effects }))
        }
        "windowState" => {
            let base = window_base_from_params(params.get("base")).map_err(client_err)?;
            let state = need_client(client)?.window_state(&base);
            Ok(json!({ "units": state.units, "pending": state.pending }))
        }
        "mutate" => {
            let mutations = parse_mutations(params.get("mutations")).map_err(client_err)?;
            let id = need_client(client)?.mutate(mutations).map_err(client_err)?;
            Ok(json!({
                "clientCommitId": id,
                "effects": CommandEffects::interactive()
            }))
        }
        "patch" => {
            let table = params
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("patch missing table".to_owned()))?;
            let row_id = params
                .get("rowId")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("patch missing rowId".to_owned()))?;
            let mut partial = params
                .get("partial")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| client_err("patch missing partial object".to_owned()))?;
            decode_bigint_members(&mut partial).map_err(client_err)?;
            let base_version = params.get("baseVersion").and_then(Value::as_i64);
            let id = need_client(client)?
                .patch(table, row_id, partial, base_version)
                .map_err(client_err)?;
            Ok(json!({
                "clientCommitId": id,
                "effects": CommandEffects::interactive()
            }))
        }
        "purgeLocalData" => {
            let input: LocalDataPurgeInput =
                serde_json::from_value(params.get("input").cloned().ok_or_else(|| {
                    client_err("sync.invalid_request: purgeLocalData missing input".to_owned())
                })?)
                .map_err(|error| {
                    client_err(format!(
                        "sync.invalid_request: invalid purgeLocalData input: {error}"
                    ))
                })?;
            let result = need_client(client)?
                .purge_local_data(&input)
                .map_err(client_err)?;
            serde_json::to_value(result).map_err(|error| client_err(error.to_string()))
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
        "querySnapshot" => {
            let sql = params
                .get("sql")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("querySnapshot missing sql".to_owned()))?;
            let bind = match params.get("params") {
                Some(Value::Array(list)) => list.clone(),
                None | Some(Value::Null) => Vec::new(),
                Some(_) => {
                    return Err(client_err("querySnapshot params must be a list".to_owned()))
                }
            };
            let mut coverage = Vec::new();
            for entry in params
                .get("coverage")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let base = window_base_from_params(entry.get("base")).map_err(client_err)?;
                let units = entry
                    .get("units")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                coverage.push(WindowCoverage { base, units });
            }
            let snapshot = need_client(client)?
                .query_snapshot(sql, &bind, &coverage)
                .map_err(client_err)?;
            Ok(serde_json::to_value(snapshot).expect("snapshot serializes"))
        }
        "localRevision" => Ok(json!({
            "revision": need_client(client)?.local_revision().to_string()
        })),
        "statusSnapshot" => Ok(serde_json::to_value(need_client(client)?.status_snapshot())
            .expect("status serializes")),
        // Conformance/debug drains. Production hosts normally drain these
        // immediately after every command, but exposing the exact core output
        // here lets both client implementations consume one observation
        // vector catalog without bridge inference.
        "drainChangeBatches" => Ok(json!({
            "batches": need_client(client)?.drain_change_batches()
        })),
        "drainSyncIntents" => Ok(json!({
            "intents": need_client(client)?.drain_sync_intents()
        })),
        // -- §5.10.5 native CRDT (the `crdt-yjs` feature) -----------------------
        // Thin forwards to the client core's yrs helpers. The command surface
        // stays present-but-unavailable in a lean build: without the feature
        // these fail loudly (`client.crdt_unavailable`) rather than being an
        // unknown method, so a wrapper's typed method gives a clear error.
        #[cfg(feature = "crdt-yjs")]
        "crdtText" => {
            let (table, row_id, column, name) = crdt_target(params)?;
            let text = need_client(client)?
                .crdt_text(&table, &row_id, &column, &name)
                .map_err(client_err)?;
            Ok(json!({ "text": text }))
        }
        #[cfg(feature = "crdt-yjs")]
        "crdtInsertText" => {
            let (table, row_id, column, name) = crdt_target(params)?;
            let index = params
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| client_err("crdtInsertText missing index".to_owned()))?
                as u32;
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("crdtInsertText missing value".to_owned()))?;
            let id = need_client(client)?
                .crdt_insert_text(&table, &row_id, &column, &name, index, value)
                .map_err(client_err)?;
            Ok(json!({ "clientCommitId": id }))
        }
        #[cfg(feature = "crdt-yjs")]
        "crdtDeleteText" => {
            let (table, row_id, column, name) = crdt_target(params)?;
            let index = params
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| client_err("crdtDeleteText missing index".to_owned()))?
                as u32;
            let len = params
                .get("len")
                .and_then(Value::as_u64)
                .ok_or_else(|| client_err("crdtDeleteText missing len".to_owned()))?
                as u32;
            let id = need_client(client)?
                .crdt_delete_text(&table, &row_id, &column, &name, index, len)
                .map_err(client_err)?;
            Ok(json!({ "clientCommitId": id }))
        }
        #[cfg(feature = "crdt-yjs")]
        "crdtApplyUpdate" => {
            let (table, row_id, column, _name) = crdt_target(params)?;
            let update = value_bytes(params.get("update")).map_err(client_err)?;
            let id = need_client(client)?
                .crdt_apply_update(&table, &row_id, &column, &update)
                .map_err(client_err)?;
            Ok(json!({ "clientCommitId": id }))
        }
        #[cfg(not(feature = "crdt-yjs"))]
        "crdtText" | "crdtInsertText" | "crdtDeleteText" | "crdtApplyUpdate" => Err((
            "client.crdt_unavailable".to_owned(),
            "native CRDT support requires the `crdt-yjs` feature (§5.10.5)".to_owned(),
        )),

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
        "commitOutcome" => {
            let client_commit_id = params
                .get("clientCommitId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    client_err(
                        "sync.invalid_request: commitOutcome missing clientCommitId".to_owned(),
                    )
                })?;
            let outcome = need_client(client)?
                .commit_outcome(client_commit_id)
                .map_err(client_err)?;
            Ok(json!({ "outcome": outcome }))
        }
        "commitOutcomes" => {
            let query = serde_json::from_value::<CommitOutcomeQuery>(
                params.get("query").cloned().unwrap_or_else(|| json!({})),
            )
            .map_err(|error| {
                client_err(format!(
                    "sync.invalid_request: invalid commit outcome query: {error}"
                ))
            })?;
            let outcomes = need_client(client)?
                .commit_outcomes(query)
                .map_err(client_err)?;
            Ok(json!({ "outcomes": outcomes }))
        }
        "resolveCommitOutcome" => {
            let input = serde_json::from_value::<ResolveCommitOutcomeInput>(
                params.get("input").cloned().ok_or_else(|| {
                    client_err(
                        "sync.invalid_request: resolveCommitOutcome missing input".to_owned(),
                    )
                })?,
            )
            .map_err(|error| {
                client_err(format!(
                    "sync.invalid_request: invalid outcome resolution: {error}"
                ))
            })?;
            let outcome = need_client(client)?
                .resolve_commit_outcome(input)
                .map_err(client_err)?;
            Ok(json!({ "outcome": outcome }))
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

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use syncular_client::{
        SegmentRequest, SyncClient, Transport, TransportError, SECURITY_PREFLIGHT_REQUIRED_CODE,
    };

    use super::{dispatch, parse_encryption, CreateEffects};

    struct NoNetwork;

    impl Transport for NoNetwork {
        fn sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_sync(&mut self, _request: &[u8]) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn download_segment(
            &mut self,
            _request: &SegmentRequest,
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    fn schema() -> Value {
        json!({
            "version": 1,
            "tables": [{
                "name": "todos",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "list_id", "type": "string", "nullable": false }
                ],
                "primaryKey": "id",
                "scopes": [{ "pattern": "list:{list_id}", "column": "list_id" }]
            }]
        })
    }

    #[test]
    fn parses_portable_encryption_keyring_and_key_id_columns() {
        let key_hex = "2a".repeat(32);
        let config = parse_encryption(&json!({
            "keys": { "practice-key-v1": { "$bytes": key_hex } },
            "keyIdColumns": { "patients": "encryption_key_id" }
        }))
        .expect("portable keyring parses");
        assert_eq!(config.keys["practice-key-v1"], vec![0x2a; 32]);
        assert_eq!(config.key_id_columns["patients"], "encryption_key_id");
    }

    #[test]
    fn rejects_non_string_key_id_columns() {
        let error = parse_encryption(&json!({
            "keys": {},
            "keyIdColumns": { "patients": 7 }
        }))
        .expect_err("invalid selector must fail");
        assert!(error.contains("must be a string"), "{error}");
    }

    #[test]
    fn security_preflight_is_fail_closed_until_exact_activation() {
        let mut transport = NoNetwork;
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "securityPreflight": true }),
        )
        .expect("preflight create");

        let lifecycle = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "securityLifecycle",
            &json!({}),
        )
        .expect("lifecycle");
        assert_eq!(lifecycle, json!({ "state": "preflight" }));

        let query_error = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "query",
            &json!({ "sql": "SELECT id FROM todos", "params": [] }),
        )
        .expect_err("protected query must fail");
        assert_eq!(query_error.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "purgeLocalData",
            &json!({
                "input": {
                    "purgeId": "directive-1",
                    "targets": [{
                        "table": "todos",
                        "selectors": { "list_id": ["list-1"] }
                    }]
                }
            }),
        )
        .expect("authorized local purge remains available");

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "activateSecurity",
            &json!({}),
        )
        .expect("activation");
        let rows = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "query",
            &json!({ "sql": "SELECT id FROM todos", "params": [] }),
        )
        .expect("active query");
        assert_eq!(rows, json!({ "rows": [] }));

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "beginSecurityPreflight",
            &json!({}),
        )
        .expect("re-enter preflight");
        let blocked = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "mutate",
            &json!({ "mutations": [] }),
        )
        .expect_err("mutation must be gated");
        assert_eq!(blocked.0, SECURITY_PREFLIGHT_REQUIRED_CODE);
    }
}
