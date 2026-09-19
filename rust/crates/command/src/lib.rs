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
    ClientDiagnosticsRequest, ClientLimits, CommandEffects, CommitOutcomeQuery,
    LocalDataPurgeInput, LocalDataRebootstrapInput, Mutation, ResolveCommitOutcomeInput,
    SyncClient, Transport, WindowBase, WindowCoverage,
};
use syncular_client::previous_version::{
    PreviousVersionContextConfig, PreviousVersionReadSpec,
};

// -- bytes <-> {"$bytes": hex} (the driver-protocol byte envelope) ----------

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    syncular_client::values::bytes_to_hex(bytes)
}

pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    syncular_client::values::hex_to_bytes(hex)
}

pub fn bytes_value(bytes: &[u8]) -> Value {
    Value::Object(serde_json::Map::from_iter([(
        "$bytes".to_owned(),
        Value::from(bytes_to_hex(bytes)),
    )]))
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
    /// True while a security preflight is pending: a preflighted client was
    /// installed (or entered preflight, or was shut down mid-preflight) and
    /// `activateSecurity` has yet to complete. `dispatch` maintains this so a
    /// replacement `create` without the `securityPreflight` flag is refused
    /// across `shutdown`, where the client slot is empty, on a host that reuses
    /// one `CreateEffects` across creates (the Tauri plugin, the conformance
    /// shim, the bench harness).
    ///
    /// A host that allocates a fresh `CreateEffects` per create — the React
    /// Native native module rebuilds its FFI handle on every `create` — starts
    /// each create with this flag clear. For those hosts the persisted marker
    /// in the client core carries the gate: a file-backed replica reopens in
    /// preflight, and the `create` path refuses a plain re-create against it.
    /// This in-memory flag covers the same-handle case where no file persists
    /// the marker.
    pub security_preflight_pending: bool,
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

/// RFC 0005 D8: parse the host's `previousVersionContext` config with the
/// TS keys and defaults: `enabled` (default false), `maxBytes` 8 MiB,
/// `maxRows` 20000, `maxTables` 32, `maxRowBytes` 1 MiB, `maxAgeMs` 24h.
/// Invalid values fail the request loudly rather than silently defaulting.
pub fn parse_previous_version_context(
    value: Option<&Value>,
) -> Result<Option<PreviousVersionContextConfig>, CommandError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value.as_object().ok_or_else(|| {
        client_err("sync.invalid_request: previousVersionContext must be an object".to_owned())
    })?;
    let enabled = match object.get("enabled") {
        None => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => {
            return Err(client_err(
                "sync.invalid_request: previousVersionContext.enabled must be a boolean".to_owned(),
            ))
        }
    };
    let mut config = PreviousVersionContextConfig {
        enabled,
        ..PreviousVersionContextConfig::default()
    };
    for (key, slot) in [
        ("maxBytes", &mut config.max_bytes),
        ("maxRows", &mut config.max_rows),
        ("maxTables", &mut config.max_tables),
        ("maxRowBytes", &mut config.max_row_bytes),
        ("maxAgeMs", &mut config.max_age_ms),
    ] {
        if let Some(raw) = object.get(key) {
            *slot = raw.as_i64().ok_or_else(|| {
                client_err(format!(
                    "sync.invalid_request: previousVersionContext.{key} must be a positive safe integer"
                ))
            })?;
        }
    }
    config.validate().map_err(client_err)?;
    Ok(Some(config))
}

/// RFC 0005 D7: `previousVersionSnapshot` params — `{table, rowIds?, limit?}`.
fn parse_previous_version_snapshot_spec(
    params: &Value,
) -> Result<PreviousVersionReadSpec, CommandError> {
    let table = params
        .get("table")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            client_err("sync.invalid_request: previousVersionSnapshot missing table".to_owned())
        })?;
    let row_ids = match params.get("rowIds") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| match id {
                Value::String(id) => Ok(id.clone()),
                Value::Number(number) => Ok(number.to_string()),
                Value::Bool(boolean) => Ok(boolean.to_string()),
                _ => Err(client_err(
                    "sync.invalid_request: previousVersionSnapshot rowIds must be strings"
                        .to_owned(),
                )),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => {
            return Err(client_err(
                "sync.invalid_request: previousVersionSnapshot rowIds must be an array".to_owned(),
            ))
        }
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_i64().ok_or_else(|| {
            client_err(
                "sync.invalid_request: previousVersionSnapshot limit must be a positive number"
                    .to_owned(),
            )
        })?),
    };
    Ok(PreviousVersionReadSpec {
        table: table.to_owned(),
        row_ids,
        limit,
    })
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

/// Parse an `activateSecurity` (or rotation) `headers` param: an object of
/// string values, replacing the transport's FULL header set.
/// The router validates the shape at the shared chokepoint; each host applies
/// the parsed set to its own transport (the router stays transport-agnostic).
pub fn parse_headers(value: &Value) -> Result<Vec<(String, String)>, String> {
    let object = value.as_object().ok_or_else(|| {
        "sync.invalid_request: headers must be an object of string values".to_owned()
    })?;
    let mut headers = Vec::with_capacity(object.len());
    for (name, value) in object {
        let value = value
            .as_str()
            .ok_or_else(|| format!("sync.invalid_request: header {name:?} must be a string"))?;
        headers.push((name.clone(), value.to_owned()));
    }
    Ok(headers)
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
    if method == "create" {
        // Fail-closed against a compromised webview re-issuing `create` (or
        // `shutdown` + `create`) WITHOUT the securityPreflight flag to exit
        // the gate: while a preflight is pending — on the live client, or
        // carried in `effects` across a `shutdown` — a replacement create must
        // itself request securityPreflight; the gate opens only through
        // activateSecurity.
        let requests_preflight = params
            .get("securityPreflight")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let preflight_engaged = client.as_ref().map_or(
            effects.security_preflight_pending,
            SyncClient::security_preflight,
        );
        if preflight_engaged && !requests_preflight {
            return Err((
                syncular_client::SECURITY_PREFLIGHT_REQUIRED_CODE.to_owned(),
                "the local replica is in security preflight; a replacement create must itself request securityPreflight, and protected data opens only after activateSecurity".to_owned(),
            ));
        }
    } else {
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
            // RFC 0005 D8: the feature config rides the top-level key the TS
            // client uses; the Rust core carries it on `ClientLimits` so it is
            // resolved before the opening schema reset runs.
            let previous_version_context =
                parse_previous_version_context(params.get("previousVersionContext"))?;
            let mut limits = limits;
            limits.previous_version_context = previous_version_context;
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
            // A file-backed replica reopens in preflight when its persisted
            // quarantine marker is set (client core restores it). Refuse a plain
            // re-create so a rebuilt host handle — the React Native native module
            // tears its FFI handle down on every create — cannot downgrade a
            // quarantined replica to active. A create that itself requests
            // securityPreflight, or an activated replica whose marker cleared,
            // proceeds.
            if instance.security_preflight() && !security_preflight {
                return Err((
                    syncular_client::SECURITY_PREFLIGHT_REQUIRED_CODE.to_owned(),
                    "the local replica is in security preflight; a replacement create must itself request securityPreflight, and protected data opens only after activateSecurity".to_owned(),
                ));
            }
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
            effects.security_preflight_pending = security_preflight;
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
            effects.security_preflight_pending = true;
            Ok(json!({}))
        }
        "activateSecurity" => {
            let encryption = match params.get("encryption") {
                Some(value) => parse_encryption(value).map_err(client_err)?,
                None => syncular_client::values::EncryptionConfig::default(),
            };
            // Optional fresh transport headers ride the activation atomically,
            // so a preflight that outlives the boot token starts its first
            // sync round with valid credentials. Validated here at the shared
            // chokepoint (invalid input keeps the gate closed); the host
            // applies the parsed set to its own transport.
            if let Some(headers) = params.get("headers") {
                parse_headers(headers).map_err(client_err)?;
            }
            need_client(client)?
                .activate_security(encryption)
                .map_err(client_err)?;
            effects.security_preflight_pending = false;
            Ok(json!({}))
        }
        "setHeaders" => {
            let headers = params
                .get("headers")
                .ok_or_else(|| client_err("setHeaders missing headers".to_owned()))?;
            parse_headers(headers).map_err(client_err)?;
            Ok(json!({}))
        }
        "shutdown" => {
            if let Some(running) = client.as_mut() {
                // Capture the gate state BEFORE the shutdown barrier flips the
                // client into preflight: an unactivated preflight stays
                // pending across the shutdown, while an activated client may
                // be recreated plainly afterwards.
                effects.security_preflight_pending = running.security_preflight();
                running.disconnect_realtime(transport);
                // Teardown barrier only: an activated client that shuts down
                // cleanly must not leave a durable quarantine mark, or its next
                // plain create would be refused forever.
                running.seal_security_on_teardown();
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
        "timeWindowSugar" => {
            let created_at_ms = params
                .get("createdAtMs")
                .and_then(Value::as_i64)
                .ok_or_else(|| client_err("timeWindowSugar missing createdAtMs".to_owned()))?;
            let count = params
                .get("count")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| client_err("timeWindowSugar missing count".to_owned()))?;
            let now_ms = params
                .get("nowMs")
                .and_then(Value::as_i64)
                .ok_or_else(|| client_err("timeWindowSugar missing nowMs".to_owned()))?;
            if params.get("unit").and_then(Value::as_str) != Some("month") {
                return Err(client_err(
                    "sync.invalid_request: timeWindowSugar requires the month unit".to_owned(),
                ));
            }
            let unit = syncular_client::TimeBucketUnit::Month;
            Ok(json!({
                "bucket": syncular_client::creation_time_bucket(created_at_ms, unit)
                    .map_err(client_err)?,
                "units": syncular_client::last(count, unit, now_ms).map_err(client_err)?,
            }))
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
        "rebootstrapLocalData" => {
            let input: LocalDataRebootstrapInput =
                serde_json::from_value(params.get("input").cloned().ok_or_else(|| {
                    client_err(
                        "sync.invalid_request: rebootstrapLocalData missing input".to_owned(),
                    )
                })?)
                .map_err(|error| {
                    client_err(format!(
                        "sync.invalid_request: invalid rebootstrapLocalData input: {error}"
                    ))
                })?;
            let result = need_client(client)?
                .rebootstrap_local_data(&input)
                .map_err(client_err)?;
            Ok(json!({
                "alreadyApplied": result.already_applied,
                "retainedCommits": result.retained_commits,
                "resetSubscriptions": result.reset_subscriptions,
                "effects": if result.already_applied {
                    CommandEffects::none()
                } else {
                    CommandEffects::interactive()
                }
            }))
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
                Some(Value::Array(list)) => list.as_slice(),
                None | Some(Value::Null) => &[],
                Some(_) => return Err(client_err("query params must be a list".to_owned())),
            };
            let rows = need_client(client)?.query(sql, bind).map_err(client_err)?;
            Ok(Value::Object(serde_json::Map::from_iter([(
                "rows".to_owned(),
                Value::Array(rows.into_iter().map(Value::Object).collect()),
            )])))
        }
        "querySnapshot" => {
            let sql = params
                .get("sql")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("querySnapshot missing sql".to_owned()))?;
            let bind = match params.get("params") {
                Some(Value::Array(list)) => list.as_slice(),
                None | Some(Value::Null) => &[],
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
            let mut snapshot = need_client(client)?
                .query_snapshot(sql, bind, &coverage)
                .map_err(client_err)?;
            let rows = std::mem::take(&mut snapshot.rows);
            let mut result = serde_json::to_value(snapshot).expect("snapshot serializes");
            result["rows"] = Value::Array(rows.into_iter().map(Value::Object).collect());
            Ok(result)
        }
        "localRevision" => Ok(json!({
            "revision": need_client(client)?.local_revision().to_string()
        })),
        "previousVersionSnapshot" | "previous_version_snapshot" => {
            let spec = parse_previous_version_snapshot_spec(params)?;
            let snapshot = need_client(client)?.previous_version_snapshot(&spec).map_err(client_err)?;
            serde_json::to_value(snapshot).map_err(|error| client_err(error.to_string()))
        }
        "previousVersionAudit" | "previous_version_audit" => Ok(
            match need_client(client)?.previous_version_audit() {
                Some(audit) => serde_json::to_value(audit)
                    .map_err(|error| client_err(error.to_string()))?,
                None => Value::Null,
            },
        ),
        "previousVersionDiscard" | "previous_version_discard" => {
            let outcome = need_client(client)?.previous_version_discard();
            Ok(json!({
                "present": outcome.present,
                "discarded": outcome.discarded,
            }))
        }
        "statusSnapshot" => Ok(serde_json::to_value(need_client(client)?.status_snapshot())
            .expect("status serializes")),
        "diagnosticsSnapshot" => {
            let request = serde_json::from_value::<ClientDiagnosticsRequest>(params.clone())
                .map_err(|error| {
                    client_err(format!(
                        "sync.invalid_request: invalid diagnostics request: {error}"
                    ))
                })?;
            let snapshot = need_client(client)?
                .diagnostics_snapshot(&request)
                .map_err(client_err)?;
            Ok(serde_json::to_value(snapshot).expect("diagnostics serialize"))
        }
        // Conformance/debug drains. Production hosts normally drain these
        // immediately after every command, but exposing the exact core output
        // here lets both client implementations consume one observation
        // vector catalog without bridge inference.
        "progressSnapshot" => Ok(
            serde_json::to_value(need_client(client)?.progress().snapshot())
                .expect("progress JSON"),
        ),
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
            // fetch_blob_bytes returns (code, message) so the server's blob.*
            // code reaches the caller (§5.9.5 cross-scope probe). The command
            // boundary owns the JSON byte encoding used by native bindings.
            let blob = need_client(client)?.fetch_blob_bytes(transport, &blob)?;
            let mut value = serde_json::Map::new();
            value.insert("blobId".to_owned(), Value::from(blob.blob_id));
            value.insert("byteLength".to_owned(), Value::from(blob.byte_length));
            value.insert("bytes".to_owned(), bytes_value(&blob.bytes));
            if let Some(media_type) = blob.media_type {
                value.insert("mediaType".to_owned(), Value::from(media_type));
            }
            Ok(Value::Object(serde_json::Map::from_iter([(
                "blob".to_owned(),
                Value::Object(value),
            )])))
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
        "pendingPayloads" => {
            let payloads = need_client(client)?.pending_payloads();
            Ok(json!({
                "payloads": payloads.iter().map(|p| bytes_value(p)).collect::<Vec<_>>()
            }))
        }
        "subscriptionState" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| client_err("subscriptionState missing id".to_owned()))?;
            let state = need_client(client)?.subscription_state(id);
            Ok(json!({ "state": state }))
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
        Mutation, SegmentRequest, SyncClient, Transport, TransportError,
        SECURITY_PREFLIGHT_REQUIRED_CODE,
    };

    use super::{
        dispatch, parse_encryption, parse_headers, parse_previous_version_context, CreateEffects,
    };

    #[derive(Default)]
    struct NoNetwork {
        realtime_connects: usize,
        realtime_closes: usize,
    }

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
            _on_progress: &mut dyn FnMut(u64),
        ) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::new("sync.transport_failed", "offline"))
        }

        fn realtime_connect(&mut self) -> Result<(), TransportError> {
            self.realtime_connects += 1;
            Ok(())
        }

        fn realtime_send(&mut self, _text: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn realtime_close(&mut self) -> Result<(), TransportError> {
            self.realtime_closes += 1;
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
    fn native_command_realtime_connection_is_idempotent() {
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect("create client");

        for _ in 0..2 {
            dispatch(
                &mut transport,
                &mut client,
                &mut effects,
                "connectRealtime",
                &json!({}),
            )
            .expect("idempotent connect command");
        }
        assert_eq!(transport.realtime_connects, 1);

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "disconnectRealtime",
            &json!({}),
        )
        .expect("disconnect command");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "disconnectRealtime",
            &json!({}),
        )
        .expect("idempotent disconnect command");
        assert_eq!(transport.realtime_closes, 1);
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "connectRealtime",
            &json!({}),
        )
        .expect("deliberate reconnect command");
        assert_eq!(transport.realtime_connects, 2);
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
    fn native_command_hosts_reject_subscription_identity_rebinds() {
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect("create client");

        let original = json!({
            "id": "stable-subscription",
            "table": "todos",
            "scopes": { "list_id": ["list-2", "list-1"] },
            "params": "{\"view\":\"v1\"}"
        });
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "subscribe",
            &original,
        )
        .expect("register subscription");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "subscribe",
            &json!({
                "id": "stable-subscription",
                "table": "todos",
                "scopes": { "list_id": ["list-1", "list-2", "list-1"] },
                "params": "{\"view\":\"v1\"}"
            }),
        )
        .expect("canonical re-declaration is idempotent");

        let error = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "subscribe",
            &json!({
                "id": "stable-subscription",
                "table": "todos",
                "scopes": { "list_id": ["list-2"] },
                "params": "{\"view\":\"v1\"}"
            }),
        )
        .expect_err("changed native query identity must fail");
        assert_eq!(error.0, "client.subscription_intent_mismatch");

        let state = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "subscriptionState",
            &json!({ "id": "stable-subscription" }),
        )
        .expect("subscription state");
        assert_eq!(state["state"]["cursor"], -1);
        assert_eq!(state["state"]["table"], "todos");
    }

    #[test]
    fn security_preflight_is_fail_closed_until_exact_activation() {
        let mut transport = NoNetwork::default();
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
        let diagnostics_error = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "diagnosticsSnapshot",
            &json!({}),
        )
        .expect_err("diagnostics table/subscription evidence remains protected");
        assert_eq!(diagnostics_error.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

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

        let repair_error = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "rebootstrapLocalData",
            &json!({ "input": { "rebootstrapId": "blocked-repair" } }),
        )
        .expect_err("projection repair must remain protected during preflight");
        assert_eq!(repair_error.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

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

    #[test]
    fn preflight_refuses_a_replacement_create_without_the_flag() {
        let mut transport = NoNetwork::default();
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

        // The escape the gate exists to prevent: a plain re-create must fail.
        let escape = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect_err("plain create must be refused during preflight");
        assert_eq!(escape.0, SECURITY_PREFLIGHT_REQUIRED_CODE);
        // The refused create left the preflighted client installed and gated.
        let query_error = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "query",
            &json!({ "sql": "SELECT id FROM todos", "params": [] }),
        )
        .expect_err("protected query stays gated");
        assert_eq!(query_error.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

        // A preflighted replacement is permitted and stays gated.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "securityPreflight": true }),
        )
        .expect("preflighted replacement create");
        let still_gated = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "query",
            &json!({ "sql": "SELECT id FROM todos", "params": [] }),
        )
        .expect_err("replacement stays gated");
        assert_eq!(still_gated.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

        // A legitimate activation releases the gate; creates behave as today.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "activateSecurity",
            &json!({}),
        )
        .expect("activation");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect("plain create after activation");
        let rows = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "query",
            &json!({ "sql": "SELECT id FROM todos", "params": [] }),
        )
        .expect("active query");
        assert_eq!(rows, json!({ "rows": [] }));
    }

    /// A file-backed replica: the persisted quarantine marker only exists here,
    /// which is why the in-memory tests above could not catch this.
    fn temp_db_path(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "syncular-command-{tag}-{}-{:?}.db",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn an_activated_replica_reopens_plainly_after_shutdown() {
        // Shutting an ACTIVATED client down is not a quarantine event. The
        // teardown barrier used to call `begin_security_preflight`, which now
        // persists the gate, so every cleanly closed replica was marked pending
        // and its next plain `create` was refused forever — the reopen path
        // restores the flag from the marker and the create guard rejects it.
        let path = temp_db_path("activated-reopen");
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "securityPreflight": true, "dbPath": path }),
        )
        .expect("preflight create");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "activateSecurity",
            &json!({}),
        )
        .expect("activation clears the gate");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "shutdown",
            &json!({}),
        )
        .expect("shutdown after activation");

        // The replica is active on disk, so a plain re-create must be admitted.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "dbPath": path }),
        )
        .expect("an activated replica must reopen plainly after shutdown");
        let state = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "securityLifecycle",
            &json!({}),
        )
        .expect("lifecycle");
        assert_eq!(state, json!({ "state": "active" }));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unactivated_replica_stays_quarantined_across_shutdown_on_disk() {
        // The other half, and the reason the marker exists: a replica that
        // entered preflight and never activated must still refuse a plain
        // re-create after shutdown, even on a host that rebuilt its handle and
        // carries no in-memory flag.
        let path = temp_db_path("quarantined-reopen");
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "securityPreflight": true, "dbPath": path }),
        )
        .expect("preflight create");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "shutdown",
            &json!({}),
        )
        .expect("shutdown during preflight");

        // A fresh host handle: no in-memory pending flag survives here, so only
        // the persisted marker can hold the gate.
        let mut rebuilt = CreateEffects::default();
        let escape = dispatch(
            &mut transport,
            &mut client,
            &mut rebuilt,
            "create",
            &json!({ "schema": schema(), "dbPath": path }),
        )
        .expect_err("a quarantined replica must refuse a plain re-create");
        assert_eq!(escape.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn preflight_gate_survives_shutdown_before_replacement_creates() {
        let mut transport = NoNetwork::default();
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
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "shutdown",
            &json!({}),
        )
        .expect("shutdown during preflight");
        assert!(client.is_none());

        // The pending preflight rides `effects` across the empty client slot.
        let escape = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect_err("shutdown + plain create must stay refused");
        assert_eq!(escape.0, SECURITY_PREFLIGHT_REQUIRED_CODE);

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "securityPreflight": true }),
        )
        .expect("preflighted re-create");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "activateSecurity",
            &json!({}),
        )
        .expect("activation");

        // An ACTIVATED client shut down cleanly may be recreated plainly.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "shutdown",
            &json!({}),
        )
        .expect("shutdown after activation");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect("plain create after an activated shutdown");
    }

    #[test]
    fn activate_security_validates_optional_headers_atomically() {
        let mut transport = NoNetwork::default();
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

        // Invalid header shapes fail loudly and keep the gate closed.
        let invalid = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "activateSecurity",
            &json!({ "headers": { "authorization": 7 } }),
        )
        .expect_err("non-string header must fail");
        assert_eq!(invalid.0, "sync.invalid_request");
        let lifecycle = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "securityLifecycle",
            &json!({}),
        )
        .expect("lifecycle");
        assert_eq!(lifecycle, json!({ "state": "preflight" }));

        // A valid header set activates in one atomic step.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "activateSecurity",
            &json!({ "headers": { "authorization": "Bearer fresh" } }),
        )
        .expect("activation with fresh headers");
        let lifecycle = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "securityLifecycle",
            &json!({}),
        )
        .expect("lifecycle");
        assert_eq!(lifecycle, json!({ "state": "active" }));
    }

    #[test]
    fn parse_headers_reads_the_full_replacement_set() {
        let parsed = parse_headers(&json!({
            "authorization": "Bearer fresh",
            "x-tenant": "t1"
        }))
        .expect("valid headers parse");
        assert_eq!(
            parsed,
            vec![
                ("authorization".to_owned(), "Bearer fresh".to_owned()),
                ("x-tenant".to_owned(), "t1".to_owned())
            ]
        );
        assert!(parse_headers(&json!(["authorization"])).is_err());
        assert!(parse_headers(&json!({ "authorization": null })).is_err());
    }

    #[test]
    fn set_headers_validates_replacement_and_respects_preflight() {
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect("create");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "setHeaders",
            &json!({ "headers": { "authorization": "Bearer fresh" } }),
        )
        .expect("valid replacement");
        let invalid = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "setHeaders",
            &json!({ "headers": { "authorization": 7 } }),
        )
        .expect_err("invalid replacement");
        assert_eq!(invalid.0, "sync.invalid_request");

        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "beginSecurityPreflight",
            &json!({}),
        )
        .expect("preflight");
        let gated = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "setHeaders",
            &json!({ "headers": {} }),
        )
        .expect_err("direct rotation must respect preflight");
        assert_eq!(gated.0, SECURITY_PREFLIGHT_REQUIRED_CODE);
    }

    fn schema_v2() -> Value {
        json!({
            "version": 2,
            "tables": [{
                "name": "todos",
                "columns": [
                    { "name": "id", "type": "string", "nullable": false },
                    { "name": "list_id", "type": "string", "nullable": false },
                    { "name": "note", "type": "string", "nullable": true }
                ],
                "primaryKey": "id",
                "scopes": [{ "pattern": "list:{list_id}", "column": "list_id" }]
            }]
        })
    }

    fn previous_version_enabled() -> Value {
        json!({ "enabled": true })
    }

    fn container_path(db_path: &str) -> String {
        format!("{db_path}.prev-context")
    }

    #[test]
    fn previous_version_config_parser_matches_ts_keys_and_defaults() {
        assert_eq!(parse_previous_version_context(None).expect("absent"), None);
        let defaults = parse_previous_version_context(Some(&json!({})))
            .expect("empty")
            .expect("present");
        assert!(!defaults.enabled);
        assert_eq!(defaults.max_bytes, 8 * 1024 * 1024);
        assert_eq!(defaults.max_rows, 20_000);
        assert_eq!(defaults.max_tables, 32);
        assert_eq!(defaults.max_row_bytes, 1024 * 1024);
        assert_eq!(defaults.max_age_ms, 24 * 60 * 60 * 1000);

        let configured = parse_previous_version_context(Some(&json!({
            "enabled": true,
            "maxBytes": 1024,
            "maxRows": 3,
            "maxTables": 2,
            "maxRowBytes": 5,
            "maxAgeMs": 7
        })))
        .expect("configured")
        .expect("present");
        assert!(configured.enabled);
        assert_eq!(configured.max_bytes, 1024);
        assert_eq!(configured.max_rows, 3);
        assert_eq!(configured.max_tables, 2);
        assert_eq!(configured.max_row_bytes, 5);
        assert_eq!(configured.max_age_ms, 7);

        // Invalid values fail loudly instead of silently defaulting.
        for (value, expected) in [
            (json!([]), "must be an object"),
            (json!({ "enabled": "yes" }), "enabled must be a boolean"),
            (json!({ "maxBytes": 0 }), "maxBytes must be a positive safe integer"),
            (json!({ "maxRows": -1 }), "maxRows must be a positive safe integer"),
            (json!({ "maxTables": 1.5 }), "maxTables must be a positive safe integer"),
            (json!({ "maxRowBytes": "1" }), "maxRowBytes must be a positive safe integer"),
            (json!({ "maxAgeMs": 0 }), "maxAgeMs must be a positive safe integer"),
        ] {
            let error = parse_previous_version_context(Some(&value)).expect_err("must fail");
            assert_eq!(error.0, "sync.invalid_request", "{value}");
            assert!(error.1.contains(expected), "{value}: {}", error.1);
        }
    }

    #[test]
    fn invalid_previous_version_config_fails_create_loudly() {
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        let error = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema(), "previousVersionContext": { "enabled": true, "maxRows": 0 } }),
        )
        .expect_err("invalid config must fail the create");
        assert_eq!(error.0, "sync.invalid_request");
        assert!(error.1.contains("maxRows"), "{}", error.1);
        assert!(client.is_none(), "no client may be installed");
    }

    #[test]
    fn previous_version_snapshot_reports_not_configured_by_default() {
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({ "schema": schema() }),
        )
        .expect("create");
        let snapshot = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionSnapshot",
            &json!({ "table": "todos" }),
        )
        .expect("snapshot");
        assert_eq!(snapshot["state"], json!("previousVersion"));
        assert_eq!(snapshot["available"], json!(false));
        assert_eq!(snapshot["reason"], json!("not-configured"));
        assert_eq!(snapshot["rows"], json!([]));
        assert_eq!(snapshot["truncated"], json!(false));
        assert_eq!(snapshot["currentVersion"], json!(1));
        let discarded = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionDiscard",
            &json!({}),
        )
        .expect("discard");
        assert_eq!(discarded, json!({ "present": false, "discarded": false }));
        assert_eq!(
            dispatch(
                &mut transport,
                &mut client,
                &mut effects,
                "previousVersionAudit",
                &json!({}),
            )
            .expect("audit"),
            Value::Null
        );
    }

    #[test]
    fn previous_version_commands_round_trip_through_the_dispatcher() {
        let path = temp_db_path("previous-version");
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();

        // A v1 replica with one pending local row and the feature on.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({
                "schema": schema(),
                "dbPath": path,
                "previousVersionContext": previous_version_enabled()
            }),
        )
        .expect("create v1");
        client
            .as_mut()
            .expect("client")
            .mutate(vec![Mutation::Upsert {
                table: "todos".to_owned(),
                values: serde_json::Map::from_iter([
                    ("id".to_owned(), json!("t1")),
                    ("list_id".to_owned(), json!("l1")),
                ]),
                base_version: None,
            }])
            .expect("seed a local row");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "shutdown",
            &json!({}),
        )
        .expect("shutdown");

        // The bump captures into the sibling file.
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({
                "schema": schema_v2(),
                "dbPath": path,
                "previousVersionContext": previous_version_enabled()
            }),
        )
        .expect("create v2");
        assert!(
            std::path::Path::new(&container_path(&path)).exists(),
            "the bump must leave a container file"
        );
        let status = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "statusSnapshot",
            &json!({}),
        )
        .expect("status");
        assert_eq!(
            status["previousVersionContext"]["present"],
            json!(true),
            "{status}"
        );
        assert!(
            status["previousVersionContext"]["createdAtMs"].is_i64(),
            "{status}"
        );

        let snapshot = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionSnapshot",
            &json!({ "table": "todos" }),
        )
        .expect("snapshot");
        assert_eq!(snapshot["state"], json!("previousVersion"));
        assert_eq!(snapshot["available"], json!(true));
        assert_eq!(snapshot["previousVersion"], json!(1));
        assert_eq!(snapshot["currentVersion"], json!(2));
        assert_eq!(snapshot["truncated"], json!(false));
        assert_eq!(snapshot["rows"][0]["id"], json!("t1"));
        assert_eq!(snapshot["rows"][0]["list_id"], json!("l1"));

        // Unknown previous table and a bad limit are loud request errors.
        let unknown = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionSnapshot",
            &json!({ "table": "absent" }),
        )
        .expect_err("unknown previous table");
        assert_eq!(unknown.0, "sync.invalid_request");
        let bad_limit = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionSnapshot",
            &json!({ "table": "todos", "limit": 0 }),
        )
        .expect_err("bad limit");
        assert_eq!(bad_limit.0, "sync.invalid_request");

        // D6: the audit names the pending commit's classification, with no
        // envelope and nothing dropped.
        let audit = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionAudit",
            &json!({}),
        )
        .expect("audit");
        assert_eq!(audit["v"], json!(1));
        assert_eq!(audit["fromVersion"], json!(1));
        assert_eq!(audit["toVersion"], json!(2));
        assert_eq!(audit["pending"], json!(1));
        assert_eq!(audit["encodable"], json!(1));
        assert_eq!(audit["incompatible"], json!([]));
        assert!(audit.get("operations").is_none());

        // The executable downgrade step, idempotent.
        let discarded = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionDiscard",
            &json!({}),
        )
        .expect("discard");
        assert_eq!(discarded, json!({ "present": true, "discarded": true }));
        assert!(!std::path::Path::new(&container_path(&path)).exists());
        let again = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionDiscard",
            &json!({}),
        )
        .expect("idempotent discard");
        assert_eq!(again, json!({ "present": false, "discarded": false }));

        // Storage read directly: both metadata records are gone.
        let inspect = rusqlite::Connection::open(&path).expect("inspect replica");
        let remaining: i64 = inspect
            .query_row(
                "SELECT COUNT(*) FROM _syncular_meta WHERE key IN (?1, ?2)",
                rusqlite::params!["previousVersionContext", "previousVersionAudit"],
                |row| row.get(0),
            )
            .expect("count meta");
        assert_eq!(remaining, 0);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn previous_version_ttl_expires_at_read_through_the_dispatcher() {
        let path = temp_db_path("previous-version-ttl");
        let mut transport = NoNetwork::default();
        let mut client: Option<SyncClient> = None;
        let mut effects = CreateEffects::default();
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({
                "schema": schema(),
                "dbPath": path,
                "previousVersionContext": previous_version_enabled()
            }),
        )
        .expect("create v1");
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "shutdown",
            &json!({}),
        )
        .expect("shutdown");

        // The injected clock is two seconds past the capture, with a TTL far
        // larger than the boot gap but far smaller than the skew, so the boot
        // reconcile keeps the container and the read expires it.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64
            + 2_000;
        dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "create",
            &json!({
                "schema": schema_v2(),
                "dbPath": path,
                "nowMs": now_ms,
                "previousVersionContext": { "enabled": true, "maxAgeMs": 500 }
            }),
        )
        .expect("create v2");
        assert!(std::path::Path::new(&container_path(&path)).exists());
        let snapshot = dispatch(
            &mut transport,
            &mut client,
            &mut effects,
            "previousVersionSnapshot",
            &json!({ "table": "todos" }),
        )
        .expect("snapshot");
        assert_eq!(snapshot["available"], json!(false));
        assert_eq!(snapshot["reason"], json!("expired"));
        assert_eq!(snapshot["rows"], json!([]));
        // The TTL discards, and the FILE is what must be gone.
        assert!(!std::path::Path::new(&container_path(&path)).exists());

        let _ = std::fs::remove_file(&path);
    }
}
