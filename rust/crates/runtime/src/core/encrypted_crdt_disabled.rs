use crate::app_schema::{AppTableMetadata, CrdtYjsFieldMetadata};
use crate::crdt_yjs::YjsUpdateEnvelope;
use crate::encryption::{
    FieldEncryptionContext, FieldEncryptionKeyProvider, StaticFieldEncryptionKeys,
};
use crate::error::{Result, SyncularError};
use crate::protocol::{PendingSyncularMutation, PullResponse, SyncChange};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const CRDT_UPDATES_TABLE: &str = "sync_crdt_updates";
pub const CRDT_CHECKPOINTS_TABLE: &str = "sync_crdt_checkpoints";

pub fn is_encrypted_crdt_system_table(table: &str) -> bool {
    matches!(table, CRDT_UPDATES_TABLE | CRDT_CHECKPOINTS_TABLE)
}

pub fn encrypted_crdt_identity_column(table: &str) -> Result<&'static str> {
    match table {
        CRDT_UPDATES_TABLE => Ok("update_id"),
        CRDT_CHECKPOINTS_TABLE => Ok("checkpoint_id"),
        _ => Err(SyncularError::config(format!(
            "unknown encrypted CRDT system table: {table}"
        ))),
    }
}

pub fn encrypted_crdt_normalize_row(
    table: &str,
    row_id: &str,
    row: Option<&Value>,
) -> Result<Map<String, Value>> {
    let mut obj = match row {
        Some(Value::Object(obj)) => obj.clone(),
        Some(other) => {
            return Err(SyncularError::protocol_message(format!(
                "encrypted CRDT row for {table} is not an object: {other}"
            )));
        }
        None => Map::new(),
    };
    let identity_column = encrypted_crdt_identity_column(table)?;
    obj.entry(identity_column.to_string())
        .or_insert_with(|| Value::String(row_id.to_string()));
    required_string(&obj, "stream_id")?;
    required_string(&obj, "app_table")?;
    required_string(&obj, "row_id")?;
    required_string(&obj, "field_name")?;
    required_string(&obj, identity_column)?;
    required_string(&obj, "key_id")?;
    required_string(&obj, "ciphertext")?;
    if table == CRDT_CHECKPOINTS_TABLE {
        let covers_seq = obj
            .get("covers_seq")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                SyncularError::protocol_message(
                    "encrypted CRDT checkpoint covers_seq must be an integer",
                )
            })?;
        if covers_seq < 0 {
            return Err(SyncularError::protocol_message(
                "encrypted CRDT checkpoint covers_seq must be non-negative",
            ));
        }
    }
    Ok(obj)
}

pub fn encrypted_crdt_scopes_json(row: &Map<String, Value>) -> Result<String> {
    let scopes = row
        .get("scopes")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !scopes.is_object() {
        return Err(SyncularError::protocol_message(
            "encrypted CRDT scopes must be an object",
        ));
    }
    Ok(serde_json::to_string(&scopes)?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticEncryptedCrdtConfig {
    pub keys: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_kid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_id: Option<String>,
}

#[derive(Clone)]
pub struct EncryptedCrdt {
    partition_id: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedCrdtStreamStats {
    pub update_count: i64,
    pub checkpoint_count: i64,
    pub checkpointable_update_count: i64,
    pub max_server_seq: Option<i64>,
    pub latest_checkpoint_covers_seq: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct BuildEncryptedCrdtTextUpdateArgs<'a> {
    pub ctx: FieldEncryptionContext,
    pub metadata: &'static AppTableMetadata,
    pub field: &'a str,
    pub row_id: &'a str,
    pub existing_row: &'a Value,
    pub next_text: &'a str,
}

#[derive(Debug, Clone)]
pub struct BuildEncryptedCrdtYjsUpdateArgs<'a> {
    pub ctx: FieldEncryptionContext,
    pub metadata: &'static AppTableMetadata,
    pub field: &'a str,
    pub row_id: &'a str,
    pub existing_row: &'a Value,
    pub update: YjsUpdateEnvelope,
}

#[derive(Debug, Clone)]
pub struct BuildEncryptedCrdtCheckpointArgs<'a> {
    pub ctx: FieldEncryptionContext,
    pub metadata: &'static AppTableMetadata,
    pub field: &'a str,
    pub row_id: &'a str,
    pub existing_row: &'a Value,
    pub covers_seq: i64,
}

impl EncryptedCrdt {
    pub fn new(_keys: Arc<dyn FieldEncryptionKeyProvider>) -> Self {
        Self {
            partition_id: "default".to_string(),
        }
    }

    pub fn with_partition_id(
        _keys: Arc<dyn FieldEncryptionKeyProvider>,
        partition_id: impl Into<String>,
    ) -> Result<Self> {
        let partition_id = partition_id.into();
        if partition_id.trim().is_empty() {
            return Err(SyncularError::config(
                "encrypted CRDT partition_id cannot be empty",
            ));
        }
        Ok(Self { partition_id })
    }

    pub fn from_static_config(config: StaticEncryptedCrdtConfig) -> Result<Self> {
        let _ = StaticFieldEncryptionKeys::from_key_material(config.keys, config.encryption_kid)?;
        Err(e2ee_feature_disabled())
    }

    pub fn from_static_config_json(config_json: &str) -> Result<Option<Self>> {
        let trimmed = config_json.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(None);
        }
        Err(e2ee_feature_disabled())
    }

    pub fn partition_id(&self) -> &str {
        &self.partition_id
    }

    pub fn transform_pull_response(&self, _response: PullResponse) -> Result<PullResponse> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_change(&self, _change: SyncChange) -> Result<SyncChange> {
        Err(e2ee_feature_disabled())
    }

    pub fn build_text_update_mutation(
        &self,
        _args: BuildEncryptedCrdtTextUpdateArgs<'_>,
    ) -> Result<PendingSyncularMutation> {
        Err(e2ee_feature_disabled())
    }

    pub fn build_yjs_update_mutation(
        &self,
        _args: BuildEncryptedCrdtYjsUpdateArgs<'_>,
    ) -> Result<PendingSyncularMutation> {
        Err(e2ee_feature_disabled())
    }

    pub fn build_checkpoint_mutation(
        &self,
        _args: BuildEncryptedCrdtCheckpointArgs<'_>,
    ) -> Result<PendingSyncularMutation> {
        Err(e2ee_feature_disabled())
    }
}

pub fn encrypted_crdt_stream_id(table: &str, row_id: &str, field: &str) -> String {
    format!(
        "{}:{}:{}",
        escape_stream_part(table),
        escape_stream_part(row_id),
        escape_stream_part(field)
    )
}

pub fn is_encrypted_update_log_field(field: &CrdtYjsFieldMetadata) -> bool {
    field.sync_mode == "encrypted-update-log"
}

pub fn encrypted_field_metadata(
    metadata: &'static AppTableMetadata,
    field_name: &str,
) -> Result<&'static CrdtYjsFieldMetadata> {
    metadata
        .crdt_yjs_fields
        .iter()
        .find(|field| field.field == field_name && is_encrypted_update_log_field(field))
        .ok_or_else(|| {
            SyncularError::config(format!(
                "no encrypted CRDT Yjs field metadata for {}.{field_name}",
                metadata.name
            ))
        })
}

pub fn encrypted_crdt_plaintext_update_base64(row: &Map<String, Value>) -> Option<String> {
    row.get("update_base64")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn encrypted_crdt_plaintext_state_base64(row: &Map<String, Value>) -> Option<String> {
    row.get("state_base64")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn apply_encrypted_crdt_plaintext_to_row(
    _metadata: &'static AppTableMetadata,
    _field_name: &str,
    _app_row_id: &str,
    _system_table: &str,
    _system_row: &Map<String, Value>,
    _current_row: Option<Value>,
) -> Result<Option<Value>> {
    Err(e2ee_feature_disabled())
}

pub fn encrypted_crdt_row_matches_scopes(
    row: &Map<String, Value>,
    scopes: &Map<String, Value>,
) -> bool {
    if scopes.is_empty() {
        return true;
    }
    let Some(stored_scopes) = row.get("scopes").and_then(Value::as_object) else {
        return false;
    };
    scopes.iter().all(|(key, requested)| {
        let Some(stored) = stored_scopes.get(key) else {
            return false;
        };
        if let Value::Array(values) = requested {
            return values.iter().any(|value| value == stored);
        }
        stored == requested
    })
}

fn required_string(row: &Map<String, Value>, field: &str) -> Result<String> {
    row.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            SyncularError::protocol_message(format!(
                "encrypted CRDT payload field {field} must be a non-empty string"
            ))
        })
}

fn escape_stream_part(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn e2ee_feature_disabled() -> SyncularError {
    SyncularError::config("E2EE support is not enabled in this Syncular runtime build")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_null_config_reports_disabled_feature() {
        let err = match EncryptedCrdt::from_static_config_json("{}") {
            Ok(_) => panic!("non-null encrypted CRDT config should require e2ee feature"),
            Err(err) => err,
        };
        assert!(err.to_string().contains("E2EE support is not enabled"));
    }
}
