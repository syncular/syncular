use crate::app_schema::{AppTableMetadata, CrdtYjsFieldMetadata};
#[cfg(feature = "crdt-yjs")]
use crate::error::FULL_SNAPSHOT_RESYNC_REQUIRED;
use crate::error::{Result, SyncularError};
use crate::limits::{
    MAX_CRDT_REQUEST_JSON_BYTES, MAX_CRDT_STATE_BASE64_BYTES, MAX_CRDT_STATE_VECTOR_BASE64_BYTES,
    MAX_CRDT_TEXT_BYTES, MAX_CRDT_UPDATE_BASE64_BYTES,
};
#[cfg(feature = "crdt-yjs")]
use crate::protocol::random_syncular_id;
use crate::protocol::{validate_payload_bytes, SyncOperation};
#[cfg(feature = "crdt-yjs")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(feature = "crdt-yjs")]
use yrs::updates::decoder::Decode;
#[cfg(feature = "crdt-yjs")]
use yrs::updates::encoder::Encode;
#[cfg(feature = "crdt-yjs")]
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

pub const YJS_PAYLOAD_KEY: &str = "__yjs";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum YjsFieldKind {
    Text,
    XmlFragment,
    Prosemirror,
}

impl Default for YjsFieldKind {
    fn default() -> Self {
        Self::Text
    }
}

impl YjsFieldKind {
    pub fn from_metadata(value: &str) -> Result<Self> {
        match value {
            "text" => Ok(Self::Text),
            "xml-fragment" => Ok(Self::XmlFragment),
            "prosemirror" => Ok(Self::Prosemirror),
            other => Err(SyncularError::config(format!(
                "unsupported Yjs field kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YjsFieldRule {
    pub table: String,
    pub field: String,
    pub state_column: String,
    #[serde(default)]
    pub container_key: Option<String>,
    #[serde(default)]
    pub row_id_field: Option<String>,
    #[serde(default)]
    pub kind: YjsFieldKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YjsUpdateEnvelope {
    pub update_id: String,
    pub update_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_state_vector_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildYjsTextUpdateArgs {
    #[serde(default)]
    pub previous_state_base64: Option<String>,
    pub next_text: String,
    #[serde(default)]
    pub container_key: Option<String>,
    #[serde(default)]
    pub update_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildYjsTextUpdateResult {
    pub update: YjsUpdateEnvelope,
    pub next_state_base64: String,
    pub next_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyYjsTextUpdatesArgs {
    #[serde(default)]
    pub previous_state_base64: Option<String>,
    pub updates: Vec<YjsUpdateEnvelope>,
    #[serde(default)]
    pub container_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyYjsTextUpdatesResult {
    pub next_state_base64: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyYjsUpdatesToStateArgs {
    #[serde(default)]
    pub previous_state_base64: Option<String>,
    pub updates: Vec<YjsUpdateEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyYjsUpdatesToStateResult {
    pub next_state_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyYjsEnvelopeToPayloadArgs {
    pub table: String,
    #[serde(default)]
    pub row_id: Option<String>,
    pub payload: Value,
    #[serde(default)]
    pub existing_row: Option<Value>,
    pub rules: Vec<YjsFieldRule>,
    #[serde(default)]
    pub envelope_key: Option<String>,
    #[serde(default)]
    pub strict: Option<bool>,
    #[serde(default)]
    pub strip_envelope: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyYjsEnvelopeToPayloadResult {
    pub payload: Value,
}

pub fn validate_crdt_request_json_size(request_json: &str) -> Result<()> {
    validate_payload_bytes(
        "maxCrdtRequestJsonBytes",
        request_json.len(),
        MAX_CRDT_REQUEST_JSON_BYTES,
        "Syncular CRDT request JSON exceeds the configured limit",
    )
}

pub fn validate_yjs_update_envelope_size(update: &YjsUpdateEnvelope) -> Result<()> {
    validate_payload_bytes(
        "maxCrdtUpdateBase64Bytes",
        update.update_base64.len(),
        MAX_CRDT_UPDATE_BASE64_BYTES,
        "Syncular CRDT updateBase64 exceeds the configured limit",
    )?;
    if let Some(required) = &update.requires_state_vector_base64 {
        validate_payload_bytes(
            "maxCrdtStateVectorBase64Bytes",
            required.len(),
            MAX_CRDT_STATE_VECTOR_BASE64_BYTES,
            "Syncular CRDT requiresStateVectorBase64 exceeds the configured limit",
        )?;
    }
    Ok(())
}

pub fn validate_yjs_update_envelope_list_size(updates: &[YjsUpdateEnvelope]) -> Result<()> {
    for update in updates {
        validate_yjs_update_envelope_size(update)?;
    }
    Ok(())
}

pub fn validate_yjs_state_base64_size(state_base64: &str) -> Result<()> {
    validate_payload_bytes(
        "maxCrdtStateBase64Bytes",
        state_base64.len(),
        MAX_CRDT_STATE_BASE64_BYTES,
        "Syncular CRDT stateBase64 exceeds the configured limit",
    )
}

pub fn validate_yjs_text_input_size(next_text: &str) -> Result<()> {
    validate_payload_bytes(
        "maxCrdtTextBytes",
        next_text.len(),
        MAX_CRDT_TEXT_BYTES,
        "Syncular CRDT text exceeds the configured limit",
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeYjsRowArgs {
    pub table: String,
    #[serde(default)]
    pub row_id: Option<String>,
    pub row: Value,
    pub rules: Vec<YjsFieldRule>,
    #[serde(default)]
    pub envelope_key: Option<String>,
    #[serde(default)]
    pub strip_envelope: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeYjsRowResult {
    pub row: Value,
}

#[cfg(feature = "crdt-yjs")]
pub fn build_yjs_text_update(args: BuildYjsTextUpdateArgs) -> Result<BuildYjsTextUpdateResult> {
    validate_yjs_text_input_size(&args.next_text)?;
    let container_key = args.container_key.unwrap_or_else(|| "text".to_string());
    let doc = create_doc_from_state(args.previous_state_base64.as_deref())?;
    let before = {
        let txn = doc.transact();
        txn.state_vector()
    };
    patch_text(&doc, &container_key, &args.next_text);
    let text_ref = doc.get_or_insert_text(container_key);
    let txn = doc.transact();
    let update = txn.encode_state_as_update_v1(&before);
    let next_state = txn.encode_state_as_update_v1(&StateVector::default());
    let next_text = text_ref.get_string(&txn);

    let next_state_base64 = encode_base64(&next_state);
    validate_yjs_state_base64_size(&next_state_base64)?;
    Ok(BuildYjsTextUpdateResult {
        update: YjsUpdateEnvelope {
            update_id: args.update_id.unwrap_or_else(random_syncular_id),
            update_base64: encode_base64(&update),
            requires_state_vector_base64: None,
        },
        next_state_base64,
        next_text,
    })
}

#[cfg(not(feature = "crdt-yjs"))]
pub fn build_yjs_text_update(_args: BuildYjsTextUpdateArgs) -> Result<BuildYjsTextUpdateResult> {
    Err(crdt_yjs_feature_disabled())
}

#[cfg(feature = "crdt-yjs")]
pub fn apply_yjs_text_updates(args: ApplyYjsTextUpdatesArgs) -> Result<ApplyYjsTextUpdatesResult> {
    let container_key = args.container_key.unwrap_or_else(|| "text".to_string());
    let doc = create_doc_from_state(args.previous_state_base64.as_deref())?;
    apply_updates(&doc, &args.updates)?;
    let text_ref = doc.get_or_insert_text(container_key);
    let txn = doc.transact();
    let text = text_ref.get_string(&txn);
    let next_state = txn.encode_state_as_update_v1(&StateVector::default());
    let next_state_base64 = encode_base64(&next_state);
    validate_yjs_state_base64_size(&next_state_base64)?;
    Ok(ApplyYjsTextUpdatesResult {
        next_state_base64,
        text,
    })
}

#[cfg(not(feature = "crdt-yjs"))]
pub fn apply_yjs_text_updates(_args: ApplyYjsTextUpdatesArgs) -> Result<ApplyYjsTextUpdatesResult> {
    Err(crdt_yjs_feature_disabled())
}

#[cfg(feature = "crdt-yjs")]
pub fn apply_yjs_updates_to_state(
    args: ApplyYjsUpdatesToStateArgs,
) -> Result<ApplyYjsUpdatesToStateResult> {
    let doc = create_doc_from_state(args.previous_state_base64.as_deref())?;
    apply_updates(&doc, &args.updates)?;
    let next_state = {
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };
    let next_state_base64 = encode_base64(&next_state);
    validate_yjs_state_base64_size(&next_state_base64)?;
    Ok(ApplyYjsUpdatesToStateResult { next_state_base64 })
}

#[cfg(not(feature = "crdt-yjs"))]
pub fn apply_yjs_updates_to_state(
    _args: ApplyYjsUpdatesToStateArgs,
) -> Result<ApplyYjsUpdatesToStateResult> {
    Err(crdt_yjs_feature_disabled())
}

#[cfg(feature = "crdt-yjs")]
pub fn materialize_yjs_state(state_base64: &str, rule: &YjsFieldRule) -> Result<Value> {
    let doc = create_doc_from_state(Some(state_base64))?;
    materialize_rule_value(&doc, rule)
}

#[cfg(not(feature = "crdt-yjs"))]
pub fn materialize_yjs_state(_state_base64: &str, _rule: &YjsFieldRule) -> Result<Value> {
    Err(crdt_yjs_feature_disabled())
}

#[cfg(feature = "crdt-yjs")]
pub fn yjs_state_vector_base64(state_base64: Option<&str>) -> Result<String> {
    let doc = create_doc_from_state(state_base64)?;
    let txn = doc.transact();
    let state_vector_base64 = encode_base64(&txn.state_vector().encode_v1());
    validate_payload_bytes(
        "maxCrdtStateVectorBase64Bytes",
        state_vector_base64.len(),
        MAX_CRDT_STATE_VECTOR_BASE64_BYTES,
        "Syncular CRDT stateVectorBase64 exceeds the configured limit",
    )?;
    Ok(state_vector_base64)
}

#[cfg(not(feature = "crdt-yjs"))]
pub fn yjs_state_vector_base64(_state_base64: Option<&str>) -> Result<String> {
    Err(crdt_yjs_feature_disabled())
}

pub fn apply_yjs_envelope_to_payload(
    args: ApplyYjsEnvelopeToPayloadArgs,
) -> Result<ApplyYjsEnvelopeToPayloadResult> {
    let payload = transform_payload(
        &args.table,
        args.row_id.as_deref(),
        args.payload,
        args.existing_row.as_ref(),
        &args.rules,
        args.envelope_key.as_deref().unwrap_or(YJS_PAYLOAD_KEY),
        args.strict.unwrap_or(true),
        args.strip_envelope.unwrap_or(true),
    )?;
    Ok(ApplyYjsEnvelopeToPayloadResult { payload })
}

pub fn materialize_yjs_row(args: MaterializeYjsRowArgs) -> Result<MaterializeYjsRowResult> {
    let row = materialize_row(
        &args.table,
        args.row_id.as_deref(),
        args.row,
        &args.rules,
        args.envelope_key.as_deref().unwrap_or(YJS_PAYLOAD_KEY),
        args.strip_envelope.unwrap_or(true),
    )?;
    Ok(MaterializeYjsRowResult { row })
}

pub fn build_yjs_text_update_json(args_json: &str) -> Result<String> {
    validate_crdt_request_json_size(args_json)?;
    let args: BuildYjsTextUpdateArgs = serde_json::from_str(args_json)?;
    Ok(serde_json::to_string(&build_yjs_text_update(args)?)?)
}

pub fn apply_yjs_text_updates_json(args_json: &str) -> Result<String> {
    validate_crdt_request_json_size(args_json)?;
    let args: ApplyYjsTextUpdatesArgs = serde_json::from_str(args_json)?;
    Ok(serde_json::to_string(&apply_yjs_text_updates(args)?)?)
}

pub fn apply_yjs_envelope_to_payload_json(args_json: &str) -> Result<String> {
    validate_crdt_request_json_size(args_json)?;
    let args: ApplyYjsEnvelopeToPayloadArgs = serde_json::from_str(args_json)?;
    Ok(serde_json::to_string(&apply_yjs_envelope_to_payload(
        args,
    )?)?)
}

pub fn materialize_yjs_row_json(args_json: &str) -> Result<String> {
    validate_crdt_request_json_size(args_json)?;
    let args: MaterializeYjsRowArgs = serde_json::from_str(args_json)?;
    Ok(serde_json::to_string(&materialize_yjs_row(args)?)?)
}

pub fn transform_operation_payload_for_metadata(
    operation: &mut SyncOperation,
    existing_row: Option<&Value>,
    metadata: &AppTableMetadata,
) -> Result<()> {
    let rules = rules_from_metadata(metadata)?;
    if operation.op != "upsert" || rules.is_empty() {
        return Ok(());
    }
    let Some(payload) = operation.payload.take() else {
        return Ok(());
    };
    operation.payload = Some(transform_payload(
        metadata.name,
        Some(&operation.row_id),
        payload,
        existing_row,
        &rules,
        YJS_PAYLOAD_KEY,
        true,
        true,
    )?);
    Ok(())
}

pub fn transform_local_row_for_metadata(
    table: &str,
    row_id: &str,
    local_row: Option<Value>,
    operation_payload: Option<&Value>,
    existing_row: Option<&Value>,
    metadata: &AppTableMetadata,
) -> Result<Option<Value>> {
    let rules = rules_from_metadata(metadata)?;
    if rules.is_empty() {
        return Ok(local_row);
    }
    let local_row = match local_row {
        Some(local_row) => local_row,
        None => {
            let Some(operation_payload) = operation_payload else {
                return Ok(None);
            };
            if !has_envelope(operation_payload, YJS_PAYLOAD_KEY) {
                return Ok(None);
            }
            if let Some(existing_row) = existing_row {
                merge_operation_payload_into_local_row(
                    existing_row.clone(),
                    operation_payload,
                    metadata,
                    YJS_PAYLOAD_KEY,
                )
            } else {
                let Value::Object(mut row) = operation_payload.clone() else {
                    return Ok(None);
                };
                strip_enveloped_materialized_fields(&mut row, metadata, YJS_PAYLOAD_KEY);
                row.insert(
                    metadata.primary_key_column.to_string(),
                    Value::String(row_id.to_string()),
                );
                Value::Object(row)
            }
        }
    };
    let local_row =
        with_operation_envelope(local_row, operation_payload, metadata, YJS_PAYLOAD_KEY);
    if !has_envelope(&local_row, YJS_PAYLOAD_KEY) {
        return Ok(Some(local_row));
    }
    Ok(Some(transform_payload(
        table,
        Some(row_id),
        local_row,
        existing_row,
        &rules,
        YJS_PAYLOAD_KEY,
        true,
        true,
    )?))
}

pub fn materialize_row_for_metadata(
    table: &str,
    row_id: Option<&str>,
    row: Value,
    metadata: &AppTableMetadata,
) -> Result<Value> {
    let rules = rules_from_metadata(metadata)?;
    if rules.is_empty() {
        return Ok(row);
    }
    materialize_row(table, row_id, row, &rules, YJS_PAYLOAD_KEY, true)
}

pub fn rules_from_metadata(metadata: &AppTableMetadata) -> Result<Vec<YjsFieldRule>> {
    metadata
        .crdt_yjs_fields
        .iter()
        .filter(|field| field.sync_mode == "server-merge" || field.sync_mode.is_empty())
        .map(|field| rule_from_metadata(metadata.name, field))
        .collect()
}

fn rule_from_metadata(table: &str, field: &CrdtYjsFieldMetadata) -> Result<YjsFieldRule> {
    Ok(YjsFieldRule {
        table: table.to_string(),
        field: field.field.to_string(),
        state_column: field.state_column.to_string(),
        container_key: Some(field.container_key.to_string()),
        row_id_field: Some(field.row_id_field.to_string()),
        kind: YjsFieldKind::from_metadata(field.kind)?,
    })
}

#[cfg(feature = "crdt-yjs")]
fn transform_payload(
    table: &str,
    row_id: Option<&str>,
    payload: Value,
    existing_row: Option<&Value>,
    rules: &[YjsFieldRule],
    envelope_key: &str,
    strict: bool,
    strip_envelope: bool,
) -> Result<Value> {
    let mut payload = match payload {
        Value::Object(payload) => payload,
        other => return Ok(other),
    };
    let table_rules = table_rule_index(table, rules)?;
    let raw_envelope = payload.get(envelope_key).cloned();

    if table_rules.is_empty() {
        if raw_envelope.is_some() && strict {
            return Err(SyncularError::protocol_message(format!(
                "Yjs envelope provided for table \"{table}\" without matching rules"
            )));
        }
        if strip_envelope {
            payload.remove(envelope_key);
        }
        return Ok(Value::Object(payload));
    }

    let Some(raw_envelope) = raw_envelope else {
        if strip_envelope {
            payload.remove(envelope_key);
        }
        return Ok(Value::Object(payload));
    };
    let Value::Object(envelope) = raw_envelope else {
        return Err(SyncularError::protocol_message(format!(
            "Yjs payload key \"{envelope_key}\" must be an object for table \"{table}\""
        )));
    };

    for (field, raw_update_input) in envelope {
        let Some(rule) = table_rules.get(&field) else {
            if strict {
                return Err(SyncularError::protocol_message(format!(
                    "No Yjs rule found for envelope field \"{field}\" on table \"{table}\""
                )));
            }
            continue;
        };
        let updates =
            normalize_update_envelopes(raw_update_input, &format!("yjs.{table}.{field}"))?;
        let base_state = existing_row
            .and_then(|row| state_value_to_base64(row.get(&rule.state_column)))
            .or_else(|| state_value_to_base64(payload.get(&rule.state_column)));
        if base_state.is_none() {
            if let Some(required) = updates
                .iter()
                .find_map(|update| required_state_vector(update))
            {
                return Err(SyncularError::protocol_message(format!(
                    "Yjs diff envelope for table \"{table}\" row \"{}\" field \"{field}\" requires local base state vector {required}, but no local state is available; {FULL_SNAPSHOT_RESYNC_REQUIRED}",
                    row_id.unwrap_or("<unknown>")
                )));
            }
        }
        let doc = create_doc_from_state(base_state.as_deref())?;
        if base_state.is_none() {
            seed_rule_value_from_rows(&doc, rule, &Map::new(), existing_row);
        }
        apply_updates(&doc, &updates)?;
        let next_value = materialize_rule_value(&doc, rule)?;
        let next_state = {
            let txn = doc.transact();
            encode_base64(&txn.encode_state_as_update_v1(&StateVector::default()))
        };
        payload.insert(rule.field.clone(), next_value);
        payload.insert(rule.state_column.clone(), Value::String(next_state));
    }

    if strip_envelope {
        payload.remove(envelope_key);
    }
    Ok(Value::Object(payload))
}

#[cfg(not(feature = "crdt-yjs"))]
fn transform_payload(
    table: &str,
    _row_id: Option<&str>,
    payload: Value,
    _existing_row: Option<&Value>,
    rules: &[YjsFieldRule],
    envelope_key: &str,
    strict: bool,
    strip_envelope: bool,
) -> Result<Value> {
    let mut payload = match payload {
        Value::Object(payload) => payload,
        other => return Ok(other),
    };
    let table_rules = table_rule_index(table, rules)?;
    let raw_envelope = payload.get(envelope_key).cloned();

    if table_rules.is_empty() {
        if raw_envelope.is_some() && strict {
            return Err(SyncularError::protocol_message(format!(
                "Yjs envelope provided for table \"{table}\" without matching rules"
            )));
        }
        if strip_envelope {
            payload.remove(envelope_key);
        }
        return Ok(Value::Object(payload));
    }

    if raw_envelope.is_some() {
        return Err(crdt_yjs_feature_disabled());
    }
    if strip_envelope {
        payload.remove(envelope_key);
    }
    Ok(Value::Object(payload))
}

#[cfg(feature = "crdt-yjs")]
fn materialize_row(
    table: &str,
    _row_id: Option<&str>,
    row: Value,
    rules: &[YjsFieldRule],
    envelope_key: &str,
    strip_envelope: bool,
) -> Result<Value> {
    let mut row = match row {
        Value::Object(row) => row,
        other => return Ok(other),
    };
    for rule in table_rule_index(table, rules)?.values() {
        let Some(state_base64) = state_value_to_base64(row.get(&rule.state_column)) else {
            continue;
        };
        let doc = create_doc_from_state(Some(&state_base64))?;
        row.insert(rule.field.clone(), materialize_rule_value(&doc, rule)?);
    }
    if strip_envelope {
        row.remove(envelope_key);
    }
    Ok(Value::Object(row))
}

#[cfg(not(feature = "crdt-yjs"))]
fn materialize_row(
    table: &str,
    _row_id: Option<&str>,
    row: Value,
    rules: &[YjsFieldRule],
    envelope_key: &str,
    strip_envelope: bool,
) -> Result<Value> {
    let mut row = match row {
        Value::Object(row) => row,
        other => return Ok(other),
    };
    let table_rules = table_rule_index(table, rules)?;
    if !table_rules.is_empty() {
        return Err(crdt_yjs_feature_disabled());
    }
    if strip_envelope {
        row.remove(envelope_key);
    }
    Ok(Value::Object(row))
}

fn table_rule_index(table: &str, rules: &[YjsFieldRule]) -> Result<BTreeMap<String, YjsFieldRule>> {
    let mut out = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for rule in rules.iter().filter(|rule| rule.table == table) {
        if rule.field.trim().is_empty() {
            return Err(SyncularError::config(
                "Yjs field rule field cannot be empty",
            ));
        }
        if rule.state_column.trim().is_empty() {
            return Err(SyncularError::config(
                "Yjs field rule stateColumn cannot be empty",
            ));
        }
        if !seen.insert(rule.field.clone()) {
            return Err(SyncularError::config(format!(
                "duplicate Yjs rule for table \"{table}\", field \"{}\"",
                rule.field
            )));
        }
        out.insert(
            rule.field.clone(),
            YjsFieldRule {
                table: rule.table.clone(),
                field: rule.field.clone(),
                state_column: rule.state_column.clone(),
                container_key: Some(
                    rule.container_key
                        .clone()
                        .unwrap_or_else(|| rule.field.clone()),
                ),
                row_id_field: Some(
                    rule.row_id_field
                        .clone()
                        .unwrap_or_else(|| "id".to_string()),
                ),
                kind: rule.kind,
            },
        );
    }
    Ok(out)
}

#[cfg(feature = "crdt-yjs")]
fn normalize_update_envelopes(value: Value, context: &str) -> Result<Vec<YjsUpdateEnvelope>> {
    match value {
        Value::Array(values) => values
            .into_iter()
            .enumerate()
            .map(|(index, value)| normalize_update_envelope(value, &format!("{context}[{index}]")))
            .collect(),
        value => Ok(vec![normalize_update_envelope(value, context)?]),
    }
}

#[cfg(feature = "crdt-yjs")]
fn normalize_update_envelope(value: Value, context: &str) -> Result<YjsUpdateEnvelope> {
    let envelope: YjsUpdateEnvelope = serde_json::from_value(value).map_err(|err| {
        SyncularError::protocol_message(format!("{context} must be a Yjs update envelope: {err}"))
    })?;
    if envelope.update_id.trim().is_empty() {
        return Err(SyncularError::protocol_message(format!(
            "{context}.updateId must be a non-empty string"
        )));
    }
    if envelope.update_base64.trim().is_empty() {
        return Err(SyncularError::protocol_message(format!(
            "{context}.updateBase64 must be a non-empty base64 string"
        )));
    }
    if envelope
        .requires_state_vector_base64
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(SyncularError::protocol_message(format!(
            "{context}.requiresStateVectorBase64 must be a non-empty base64 string when provided"
        )));
    }
    validate_yjs_update_envelope_size(&envelope)?;
    Ok(envelope)
}

#[cfg(feature = "crdt-yjs")]
fn create_doc_from_state(state_base64: Option<&str>) -> Result<Doc> {
    let doc = Doc::new();
    if let Some(state_base64) = state_base64.filter(|value| !value.trim().is_empty()) {
        validate_yjs_state_base64_size(state_base64)?;
        let bytes = decode_base64(state_base64)?;
        let update = Update::decode_v1(bytes.as_slice())
            .map_err(|err| SyncularError::protocol_message(format!("decode Yjs state: {err}")))?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|err| SyncularError::protocol_message(format!("apply Yjs state: {err}")))?;
    }
    Ok(doc)
}

#[cfg(feature = "crdt-yjs")]
fn apply_updates(doc: &Doc, updates: &[YjsUpdateEnvelope]) -> Result<()> {
    validate_yjs_update_envelope_list_size(updates)?;
    let mut txn = doc.transact_mut();
    for update in updates {
        if let Some(required) = required_state_vector(update) {
            let actual = encode_base64(&txn.state_vector().encode_v1());
            if actual != required {
                return Err(SyncularError::protocol_message(format!(
                    "Yjs update {} requires base state vector {required}, but current state vector is {actual}; {FULL_SNAPSHOT_RESYNC_REQUIRED}",
                    update.update_id
                )));
            }
        }
        let bytes = decode_base64(&update.update_base64)?;
        let decoded = Update::decode_v1(bytes.as_slice()).map_err(|err| {
            SyncularError::protocol_message(format!(
                "decode Yjs update {}: {err}",
                update.update_id
            ))
        })?;
        txn.apply_update(decoded).map_err(|err| {
            SyncularError::protocol_message(format!("apply Yjs update {}: {err}", update.update_id))
        })?;
    }
    Ok(())
}

#[cfg(feature = "crdt-yjs")]
fn required_state_vector(update: &YjsUpdateEnvelope) -> Option<&str> {
    update
        .requires_state_vector_base64
        .as_deref()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(feature = "crdt-yjs")]
fn patch_text(doc: &Doc, container_key: &str, next_text: &str) {
    let text = doc.get_or_insert_text(container_key);
    let current_text = {
        let txn = doc.transact();
        text.get_string(&txn)
    };
    if current_text == next_text {
        return;
    }

    let prefix_len = common_prefix_boundary(&current_text, next_text);
    let (current_suffix_start, next_suffix_start) =
        common_suffix_boundaries(&current_text, next_text, prefix_len);

    let delete_len = current_suffix_start - prefix_len;
    let insert_segment = &next_text[prefix_len..next_suffix_start];
    let mut txn = doc.transact_mut();
    if delete_len > 0 {
        text.remove_range(&mut txn, prefix_len as u32, delete_len as u32);
    }
    if !insert_segment.is_empty() {
        text.insert(&mut txn, prefix_len as u32, insert_segment);
    }
}

#[cfg(feature = "crdt-yjs")]
fn common_prefix_boundary(left: &str, right: &str) -> usize {
    let mut prefix = 0;
    for ((left_index, left_char), (right_index, right_char)) in
        left.char_indices().zip(right.char_indices())
    {
        if left_index != right_index || left_char != right_char {
            break;
        }
        prefix = left_index + left_char.len_utf8();
    }
    prefix
}

#[cfg(feature = "crdt-yjs")]
fn common_suffix_boundaries(left: &str, right: &str, prefix_len: usize) -> (usize, usize) {
    let mut left_start = left.len();
    let mut right_start = right.len();
    let mut left_chars = left[prefix_len..].char_indices().rev();
    let mut right_chars = right[prefix_len..].char_indices().rev();

    while let (Some((left_index, left_char)), Some((right_index, right_char))) =
        (left_chars.next(), right_chars.next())
    {
        if left_char != right_char {
            break;
        }
        left_start = prefix_len + left_index;
        right_start = prefix_len + right_index;
    }

    (left_start, right_start)
}

#[cfg(feature = "crdt-yjs")]
fn seed_rule_value_from_rows(
    doc: &Doc,
    rule: &YjsFieldRule,
    payload: &Map<String, Value>,
    existing_row: Option<&Value>,
) {
    if rule.kind != YjsFieldKind::Text {
        return;
    }
    let initial = payload
        .get(&rule.field)
        .and_then(Value::as_str)
        .or_else(|| existing_row.and_then(|row| row.get(&rule.field).and_then(Value::as_str)));
    if let Some(initial) = initial.filter(|value| !value.is_empty()) {
        patch_text(
            doc,
            rule.container_key.as_deref().unwrap_or(&rule.field),
            initial,
        );
    }
}

#[cfg(feature = "crdt-yjs")]
fn materialize_rule_value(doc: &Doc, rule: &YjsFieldRule) -> Result<Value> {
    let container_key = rule.container_key.as_deref().unwrap_or(&rule.field);
    let text_ref;
    let xml_ref;
    match rule.kind {
        YjsFieldKind::Text => {
            text_ref = Some(doc.get_or_insert_text(container_key));
            xml_ref = None;
        }
        YjsFieldKind::XmlFragment | YjsFieldKind::Prosemirror => {
            text_ref = None;
            xml_ref = Some(doc.get_or_insert_xml_fragment(container_key));
        }
    }
    let txn = doc.transact();
    let value = match rule.kind {
        YjsFieldKind::Text => text_ref.expect("text ref is initialized").get_string(&txn),
        YjsFieldKind::XmlFragment | YjsFieldKind::Prosemirror => {
            xml_ref.expect("xml ref is initialized").get_string(&txn)
        }
    };
    Ok(Value::String(value))
}

fn has_envelope(value: &Value, envelope_key: &str) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.contains_key(envelope_key))
}

fn with_operation_envelope(
    local_row: Value,
    operation_payload: Option<&Value>,
    metadata: &AppTableMetadata,
    envelope_key: &str,
) -> Value {
    if has_envelope(&local_row, envelope_key) {
        return local_row;
    }
    let Some(envelope) = operation_payload.and_then(|payload| payload.get(envelope_key)) else {
        return local_row;
    };
    let Value::Object(mut row) = local_row else {
        return local_row;
    };
    row.insert(envelope_key.to_string(), envelope.clone());
    strip_enveloped_materialized_fields(&mut row, metadata, envelope_key);
    Value::Object(row)
}

fn merge_operation_payload_into_local_row(
    local_row: Value,
    operation_payload: &Value,
    metadata: &AppTableMetadata,
    envelope_key: &str,
) -> Value {
    match local_row {
        Value::Object(mut row) => {
            if let Value::Object(payload) = operation_payload {
                for (key, value) in payload {
                    row.insert(key.clone(), value.clone());
                }
            }
            strip_enveloped_materialized_fields(&mut row, metadata, envelope_key);
            Value::Object(row)
        }
        other => other,
    }
}

fn strip_enveloped_materialized_fields(
    row: &mut Map<String, Value>,
    metadata: &AppTableMetadata,
    envelope_key: &str,
) {
    let Some(envelope) = row.get(envelope_key).and_then(Value::as_object) else {
        return;
    };
    let enveloped_fields = envelope.keys().cloned().collect::<Vec<_>>();
    for field_name in enveloped_fields {
        if let Some(field) = metadata
            .crdt_yjs_fields
            .iter()
            .find(|candidate| candidate.field == field_name)
        {
            row.remove(field.field);
            row.remove(field.state_column);
        }
    }
}

#[cfg(feature = "crdt-yjs")]
fn state_value_to_base64(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

#[cfg(feature = "crdt-yjs")]
fn encode_base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

#[cfg(feature = "crdt-yjs")]
fn decode_base64(value: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(value)
        .map_err(|err| SyncularError::protocol_message(format!("invalid base64 string: {err}")))
}

#[cfg(not(feature = "crdt-yjs"))]
fn crdt_yjs_feature_disabled() -> SyncularError {
    SyncularError::config("CRDT Yjs support is not enabled in this Syncular runtime build")
}

#[cfg(all(test, feature = "crdt-yjs"))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_updates_merge_concurrent_changes() -> Result<()> {
        let base = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: "middle".to_string(),
            container_key: None,
            update_id: Some("base".to_string()),
        })?;
        let prepend = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: Some(base.next_state_base64.clone()),
            next_text: "left middle".to_string(),
            container_key: None,
            update_id: Some("prepend".to_string()),
        })?;
        let append = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: Some(base.next_state_base64.clone()),
            next_text: "middle right".to_string(),
            container_key: None,
            update_id: Some("append".to_string()),
        })?;

        let forward = apply_yjs_text_updates(ApplyYjsTextUpdatesArgs {
            previous_state_base64: Some(base.next_state_base64.clone()),
            updates: vec![prepend.update.clone(), append.update.clone()],
            container_key: None,
        })?;
        let reverse = apply_yjs_text_updates(ApplyYjsTextUpdatesArgs {
            previous_state_base64: Some(base.next_state_base64),
            updates: vec![append.update, prepend.update],
            container_key: None,
        })?;

        assert_eq!(forward.text, reverse.text);
        assert!(forward.text.contains("left"));
        assert!(forward.text.contains("middle"));
        assert!(forward.text.contains("right"));
        Ok(())
    }

    #[test]
    fn envelope_materializes_payload_and_strips_transport_key() -> Result<()> {
        let base = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: "hello".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("base".to_string()),
        })?;
        let next = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: Some(base.next_state_base64.clone()),
            next_text: "hello world".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("next".to_string()),
        })?;
        let result = apply_yjs_envelope_to_payload(ApplyYjsEnvelopeToPayloadArgs {
            table: "tasks".to_string(),
            row_id: Some("task-1".to_string()),
            payload: json!({ "__yjs": { "title": next.update } }),
            existing_row: Some(json!({
                "id": "task-1",
                "title": "hello",
                "title_yjs_state": base.next_state_base64
            })),
            rules: vec![YjsFieldRule {
                table: "tasks".to_string(),
                field: "title".to_string(),
                state_column: "title_yjs_state".to_string(),
                container_key: Some("title".to_string()),
                row_id_field: Some("id".to_string()),
                kind: YjsFieldKind::Text,
            }],
            envelope_key: None,
            strict: None,
            strip_envelope: None,
        })?;

        assert_eq!(result.payload["title"], "hello world");
        assert!(result.payload["title_yjs_state"].as_str().is_some());
        assert!(result.payload.get(YJS_PAYLOAD_KEY).is_none());
        Ok(())
    }

    #[test]
    fn initial_yjs_envelope_does_not_duplicate_plain_payload_text() -> Result<()> {
        let initial = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: "Draft".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("initial".to_string()),
        })?;
        let result = apply_yjs_envelope_to_payload(ApplyYjsEnvelopeToPayloadArgs {
            table: "tasks".to_string(),
            row_id: Some("task-1".to_string()),
            payload: json!({
                "title": "Draft",
                "__yjs": { "title": initial.update }
            }),
            existing_row: None,
            rules: vec![YjsFieldRule {
                table: "tasks".to_string(),
                field: "title".to_string(),
                state_column: "title_yjs_state".to_string(),
                container_key: Some("title".to_string()),
                row_id_field: Some("id".to_string()),
                kind: YjsFieldKind::Text,
            }],
            envelope_key: None,
            strict: None,
            strip_envelope: None,
        })?;

        assert_eq!(result.payload["title"], "Draft");
        assert!(result.payload["title_yjs_state"].as_str().is_some());
        assert!(result.payload.get(YJS_PAYLOAD_KEY).is_none());
        Ok(())
    }

    #[test]
    fn diff_envelope_remote_rows_preserve_non_crdt_payload_fields() -> Result<()> {
        static CRDT_FIELDS: &[CrdtYjsFieldMetadata] = &[CrdtYjsFieldMetadata {
            field: "title",
            state_column: "title_yjs_state",
            container_key: "title",
            row_id_field: "id",
            kind: "text",
            sync_mode: "server-merge",
        }];
        static TABLE: AppTableMetadata = AppTableMetadata {
            name: "tasks",
            primary_key_column: "id",
            server_version_column: "server_version",
            soft_delete_column: None,
            subscription_id: "tasks",
            columns: &[],
            blob_columns: &[],
            crdt_yjs_fields: CRDT_FIELDS,
            encrypted_fields: &[],
            scopes: &[],
        };

        let base = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: "hello".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("base".to_string()),
        })?;
        let next = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: Some(base.next_state_base64.clone()),
            next_text: "hello world".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("next".to_string()),
        })?;
        let mut next_update = next.update;
        next_update.requires_state_vector_base64 =
            Some(yjs_state_vector_base64(Some(&base.next_state_base64))?);

        let row = transform_local_row_for_metadata(
            "tasks",
            "task-1",
            None,
            Some(&json!({
                "updated_at": 2,
                "__yjs": { "title": next_update }
            })),
            Some(&json!({
                "id": "task-1",
                "title": "hello",
                "title_yjs_state": base.next_state_base64,
                "updated_at": 1
            })),
            &TABLE,
        )?
        .expect("diff envelope materializes existing row");

        assert_eq!(row["title"], "hello world");
        assert_eq!(row["updated_at"], 2);
        assert!(row["title_yjs_state"].as_str().is_some());
        assert!(row.get(YJS_PAYLOAD_KEY).is_none());
        Ok(())
    }

    #[test]
    fn diff_envelope_without_required_local_base_requests_resync() -> Result<()> {
        static CRDT_FIELDS: &[CrdtYjsFieldMetadata] = &[CrdtYjsFieldMetadata {
            field: "title",
            state_column: "title_yjs_state",
            container_key: "title",
            row_id_field: "id",
            kind: "text",
            sync_mode: "server-merge",
        }];
        static TABLE: AppTableMetadata = AppTableMetadata {
            name: "tasks",
            primary_key_column: "id",
            server_version_column: "server_version",
            soft_delete_column: None,
            subscription_id: "tasks",
            columns: &[],
            blob_columns: &[],
            crdt_yjs_fields: CRDT_FIELDS,
            encrypted_fields: &[],
            scopes: &[],
        };

        let base = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: "hello".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("base".to_string()),
        })?;
        let next = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: Some(base.next_state_base64.clone()),
            next_text: "hello world".to_string(),
            container_key: Some("title".to_string()),
            update_id: Some("next".to_string()),
        })?;
        let mut next_update = next.update;
        next_update.requires_state_vector_base64 =
            Some(yjs_state_vector_base64(Some(&base.next_state_base64))?);

        let err = transform_local_row_for_metadata(
            "tasks",
            "task-1",
            None,
            Some(&json!({
                "__yjs": { "title": next_update }
            })),
            None,
            &TABLE,
        )
        .expect_err("server diff without local base must request resync");

        let message = err.to_string();
        assert!(message.contains("tasks"));
        assert!(message.contains("task-1"));
        assert!(message.contains("title"));
        assert!(message.contains("full snapshot resync required"));
        Ok(())
    }
}

#[cfg(all(test, not(feature = "crdt-yjs")))]
mod tests_without_crdt_yjs {
    use super::*;

    #[test]
    fn yjs_operations_report_disabled_feature() {
        let err = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: "hello".to_string(),
            container_key: None,
            update_id: None,
        })
        .expect_err("CRDT/Yjs operation should require crdt-yjs feature");

        assert!(err.to_string().contains("CRDT Yjs support is not enabled"));
    }
}
