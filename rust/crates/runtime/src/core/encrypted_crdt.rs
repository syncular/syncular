use crate::app_schema::{AppTableMetadata, CrdtYjsFieldMetadata};
use crate::crdt_yjs::{
    apply_yjs_updates_to_state, build_yjs_text_update, materialize_yjs_state,
    validate_yjs_state_base64_size, validate_yjs_text_input_size,
    validate_yjs_update_envelope_size, yjs_state_vector_base64, ApplyYjsUpdatesToStateArgs,
    BuildYjsTextUpdateArgs, YjsFieldKind, YjsFieldRule, YjsUpdateEnvelope,
};
use crate::encryption::{
    random_bytes, validate_32_bytes, xchacha_decrypt, xchacha_encrypt, FieldEncryptionContext,
    FieldEncryptionKeyProvider, FieldEncryptionTarget, StaticFieldEncryptionKeys,
};
use crate::error::{Result, SyncularError};
use crate::protocol::{PendingSyncularMutation, PullResponse, SyncChange, SyncularMutationKind};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use uuid::Uuid;

pub const CRDT_UPDATES_TABLE: &str = "sync_crdt_updates";
pub const CRDT_CHECKPOINTS_TABLE: &str = "sync_crdt_checkpoints";
const CRDT_CIPHERTEXT_PREFIX: &str = "dgsync:ecrdt:1:";

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
    keys: Arc<dyn FieldEncryptionKeyProvider>,
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
    pub fn new(keys: Arc<dyn FieldEncryptionKeyProvider>) -> Self {
        Self {
            keys,
            partition_id: "default".to_string(),
        }
    }

    pub fn with_partition_id(
        keys: Arc<dyn FieldEncryptionKeyProvider>,
        partition_id: impl Into<String>,
    ) -> Result<Self> {
        let partition_id = partition_id.into();
        if partition_id.trim().is_empty() {
            return Err(SyncularError::config(
                "encrypted CRDT partition_id cannot be empty",
            ));
        }
        Ok(Self { keys, partition_id })
    }

    pub fn from_static_config(config: StaticEncryptedCrdtConfig) -> Result<Self> {
        let keys =
            StaticFieldEncryptionKeys::from_key_material(config.keys, config.encryption_kid)?;
        Self::with_partition_id(
            Arc::new(keys),
            config.partition_id.unwrap_or_else(|| "default".to_string()),
        )
    }

    pub fn from_static_config_json(config_json: &str) -> Result<Option<Self>> {
        let trimmed = config_json.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(None);
        }
        let config: StaticEncryptedCrdtConfig = serde_json::from_str(trimmed)?;
        Ok(Some(Self::from_static_config(config)?))
    }

    pub fn partition_id(&self) -> &str {
        &self.partition_id
    }

    pub fn transform_pull_response(&self, mut response: PullResponse) -> Result<PullResponse> {
        for sub in &mut response.subscriptions {
            if let Some(snapshots) = &mut sub.snapshots {
                for snapshot in snapshots {
                    if !is_encrypted_crdt_system_table(&snapshot.table) {
                        continue;
                    }
                    for row in &mut snapshot.rows {
                        *row = self.decrypt_system_row_value(&snapshot.table, row.clone())?;
                    }
                }
            }
            for commit in &mut sub.commits {
                for change in &mut commit.changes {
                    if !is_encrypted_crdt_system_table(&change.table) || change.op != "upsert" {
                        continue;
                    }
                    if let Some(row_json) = change.row_json.take() {
                        change.row_json =
                            Some(self.decrypt_system_row_value(&change.table, row_json)?);
                    }
                }
            }
        }
        Ok(response)
    }

    pub fn transform_change(&self, mut change: SyncChange) -> Result<SyncChange> {
        if is_encrypted_crdt_system_table(&change.table) && change.op == "upsert" {
            if let Some(row_json) = change.row_json.take() {
                change.row_json = Some(self.decrypt_system_row_value(&change.table, row_json)?);
            }
        }
        Ok(change)
    }

    pub fn build_text_update_mutation(
        &self,
        args: BuildEncryptedCrdtTextUpdateArgs<'_>,
    ) -> Result<PendingSyncularMutation> {
        validate_yjs_text_input_size(args.next_text)?;
        let field = encrypted_field_metadata(args.metadata, args.field)?;
        if field.kind != "text" {
            return Err(SyncularError::config(format!(
                "encrypted CRDT text updates require a text Yjs field, got {}.{} kind {}",
                args.metadata.name, field.field, field.kind
            )));
        }
        let existing = args.existing_row.as_object().ok_or_else(|| {
            SyncularError::protocol_message("encrypted CRDT update existing_row must be an object")
        })?;
        let previous_state_base64 = existing
            .get(field.state_column)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let requires_state_vector_base64 = previous_state_base64
            .as_deref()
            .map(|state| yjs_state_vector_base64(Some(state)))
            .transpose()?;
        let mut update = build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64,
            next_text: args.next_text.to_string(),
            container_key: Some(field.container_key.to_string()),
            update_id: None,
        })?;
        update.update.requires_state_vector_base64 = requires_state_vector_base64;
        self.build_yjs_update_mutation(BuildEncryptedCrdtYjsUpdateArgs {
            ctx: args.ctx,
            metadata: args.metadata,
            field: args.field,
            row_id: args.row_id,
            existing_row: args.existing_row,
            update: update.update,
        })
    }

    pub fn build_yjs_update_mutation(
        &self,
        args: BuildEncryptedCrdtYjsUpdateArgs<'_>,
    ) -> Result<PendingSyncularMutation> {
        validate_yjs_update_envelope_size(&args.update)?;
        if args.update.update_id.trim().is_empty() {
            return Err(SyncularError::protocol_message(
                "encrypted CRDT update.updateId must be a non-empty string",
            ));
        }
        if args.update.update_base64.trim().is_empty() {
            return Err(SyncularError::protocol_message(
                "encrypted CRDT update.updateBase64 must be a non-empty base64 string",
            ));
        }
        let field = encrypted_field_metadata(args.metadata, args.field)?;
        let existing = args.existing_row.as_object().ok_or_else(|| {
            SyncularError::protocol_message("encrypted CRDT update existing_row must be an object")
        })?;
        let scopes = scopes_from_app_row(args.metadata, existing)?;
        let stream_id = encrypted_crdt_stream_id(args.metadata.name, args.row_id, field.field);
        let target = FieldEncryptionTarget {
            scope: args.metadata.name.to_string(),
            table: args.metadata.name.to_string(),
            row_id: args.row_id.to_string(),
            field: field.field.to_string(),
        };
        let key_id = self.keys.encryption_kid(&args.ctx, &target)?;
        let key = self.keys.get_key(&key_id)?;
        validate_32_bytes("encrypted CRDT key", &key)?;
        let plaintext = serde_json::to_vec(&EncryptedCrdtPlaintext::YjsUpdateV1 {
            update_base64: args.update.update_base64.clone(),
            requires_state_vector_base64: args.update.requires_state_vector_base64.clone(),
        })?;
        let aad = encrypted_crdt_aad(
            CRDT_UPDATES_TABLE,
            &self.partition_id,
            &stream_id,
            args.metadata.name,
            args.row_id,
            field.field,
            &args.update.update_id,
        );
        let ciphertext = encrypt_payload(&key, &aad, &plaintext)?;
        let payload = json!({
            "partition_id": self.partition_id,
            "stream_id": stream_id,
            "app_table": args.metadata.name,
            "row_id": args.row_id,
            "field_name": field.field,
            "update_id": args.update.update_id,
            "actor_id": args.ctx.actor_id,
            "client_id": args.ctx.client_id,
            "key_id": key_id,
            "ciphertext": ciphertext,
            "scopes": Value::Object(scopes.clone())
        });
        let mut local_row = payload.clone();
        local_row["update_base64"] = Value::String(args.update.update_base64);
        if let Some(required) = &args.update.requires_state_vector_base64 {
            local_row["requires_state_vector_base64"] = Value::String(required.clone());
        }

        Ok(PendingSyncularMutation {
            kind: SyncularMutationKind::Upsert,
            table: CRDT_UPDATES_TABLE.to_string(),
            row_id: payload["update_id"].as_str().unwrap().to_string(),
            payload: Some(payload),
            base_version: None,
            local_row: Some(local_row),
        })
    }

    pub fn build_checkpoint_mutation(
        &self,
        args: BuildEncryptedCrdtCheckpointArgs<'_>,
    ) -> Result<PendingSyncularMutation> {
        if args.covers_seq < 0 {
            return Err(SyncularError::config(
                "encrypted CRDT checkpoint covers_seq must be non-negative",
            ));
        }
        let field = encrypted_field_metadata(args.metadata, args.field)?;
        let existing = args.existing_row.as_object().ok_or_else(|| {
            SyncularError::protocol_message(
                "encrypted CRDT checkpoint existing_row must be an object",
            )
        })?;
        let state_base64 = checkpoint_state_base64(existing, field)?;
        validate_yjs_state_base64_size(&state_base64)?;
        let scopes = scopes_from_app_row(args.metadata, existing)?;
        let stream_id = encrypted_crdt_stream_id(args.metadata.name, args.row_id, field.field);
        let target = FieldEncryptionTarget {
            scope: args.metadata.name.to_string(),
            table: args.metadata.name.to_string(),
            row_id: args.row_id.to_string(),
            field: field.field.to_string(),
        };
        let key_id = self.keys.encryption_kid(&args.ctx, &target)?;
        let key = self.keys.get_key(&key_id)?;
        validate_32_bytes("encrypted CRDT key", &key)?;
        let checkpoint_id = Uuid::new_v4().to_string();
        let plaintext = serde_json::to_vec(&EncryptedCrdtPlaintext::YjsStateV1 {
            state_base64: state_base64.clone(),
        })?;
        let aad = encrypted_crdt_aad(
            CRDT_CHECKPOINTS_TABLE,
            &self.partition_id,
            &stream_id,
            args.metadata.name,
            args.row_id,
            field.field,
            &checkpoint_id,
        );
        let ciphertext = encrypt_payload(&key, &aad, &plaintext)?;
        let payload = json!({
            "partition_id": self.partition_id,
            "stream_id": stream_id,
            "app_table": args.metadata.name,
            "row_id": args.row_id,
            "field_name": field.field,
            "checkpoint_id": checkpoint_id,
            "covers_seq": args.covers_seq,
            "actor_id": args.ctx.actor_id,
            "client_id": args.ctx.client_id,
            "key_id": key_id,
            "ciphertext": ciphertext,
            "scopes": Value::Object(scopes.clone())
        });
        let mut local_row = payload.clone();
        local_row["state_base64"] = Value::String(state_base64);

        Ok(PendingSyncularMutation {
            kind: SyncularMutationKind::Upsert,
            table: CRDT_CHECKPOINTS_TABLE.to_string(),
            row_id: payload["checkpoint_id"].as_str().unwrap().to_string(),
            payload: Some(payload),
            base_version: None,
            local_row: Some(local_row),
        })
    }

    fn decrypt_system_row_value(&self, table: &str, value: Value) -> Result<Value> {
        let Value::Object(mut row) = value else {
            return Ok(value);
        };
        self.decrypt_system_row_in_place(table, &mut row)?;
        Ok(Value::Object(row))
    }

    fn decrypt_system_row_in_place(&self, table: &str, row: &mut Map<String, Value>) -> Result<()> {
        if table == CRDT_UPDATES_TABLE && row.get("update_base64").is_some() {
            return Ok(());
        }
        if table == CRDT_CHECKPOINTS_TABLE && row.get("state_base64").is_some() {
            return Ok(());
        }

        let identity_column = encrypted_crdt_identity_column(table)?;
        let partition_id = row
            .get("partition_id")
            .and_then(Value::as_str)
            .unwrap_or("default");
        let stream_id = required_string(row, "stream_id")?;
        let app_table = required_string(row, "app_table")?;
        let row_id = required_string(row, "row_id")?;
        let field_name = required_string(row, "field_name")?;
        let identity = required_string(row, identity_column)?;
        let key_id = required_string(row, "key_id")?;
        let ciphertext = required_string(row, "ciphertext")?;
        let key = self.keys.get_key(&key_id)?;
        validate_32_bytes("encrypted CRDT key", &key)?;
        let aad = encrypted_crdt_aad(
            table,
            &partition_id,
            &stream_id,
            &app_table,
            &row_id,
            &field_name,
            &identity,
        );
        let plaintext = decrypt_payload(&key, &aad, &ciphertext)?;
        match serde_json::from_slice::<EncryptedCrdtPlaintext>(&plaintext)? {
            EncryptedCrdtPlaintext::YjsUpdateV1 {
                update_base64,
                requires_state_vector_base64,
            } => {
                if table != CRDT_UPDATES_TABLE {
                    return Err(SyncularError::protocol_message(
                        "encrypted CRDT update plaintext cannot be stored in checkpoint table",
                    ));
                }
                row.insert("update_base64".to_string(), Value::String(update_base64));
                if let Some(required) = requires_state_vector_base64 {
                    row.insert(
                        "requires_state_vector_base64".to_string(),
                        Value::String(required),
                    );
                }
            }
            EncryptedCrdtPlaintext::YjsStateV1 { state_base64 } => {
                if table != CRDT_CHECKPOINTS_TABLE {
                    return Err(SyncularError::protocol_message(
                        "encrypted CRDT checkpoint plaintext cannot be stored in update table",
                    ));
                }
                row.insert("state_base64".to_string(), Value::String(state_base64));
            }
        }
        Ok(())
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
    metadata: &AppTableMetadata,
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

pub fn encrypted_crdt_required_state_vector_base64(row: &Map<String, Value>) -> Option<String> {
    row.get("requires_state_vector_base64")
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
    metadata: &'static AppTableMetadata,
    field_name: &str,
    app_row_id: &str,
    system_table: &str,
    system_row: &Map<String, Value>,
    current_row: Option<Value>,
) -> Result<Option<Value>> {
    let field = encrypted_field_metadata(metadata, field_name)?;
    let mut app_row = current_row
        .and_then(|row| row.as_object().cloned())
        .unwrap_or_default();
    app_row.insert(
        metadata.primary_key_column.to_string(),
        Value::String(app_row_id.to_string()),
    );
    merge_scope_columns(metadata, system_row, &mut app_row)?;

    let previous_state_base64 = app_row
        .get(field.state_column)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let next_state_base64 = match system_table {
        CRDT_UPDATES_TABLE => {
            let Some(update_base64) = encrypted_crdt_plaintext_update_base64(system_row) else {
                return Ok(None);
            };
            apply_yjs_updates_to_state(ApplyYjsUpdatesToStateArgs {
                previous_state_base64,
                updates: vec![YjsUpdateEnvelope {
                    update_id: system_row
                        .get("update_id")
                        .and_then(Value::as_str)
                        .unwrap_or("encrypted-crdt-update")
                        .to_string(),
                    update_base64,
                    requires_state_vector_base64: encrypted_crdt_required_state_vector_base64(
                        system_row,
                    ),
                }],
            })?
            .next_state_base64
        }
        CRDT_CHECKPOINTS_TABLE => {
            let Some(state_base64) = encrypted_crdt_plaintext_state_base64(system_row) else {
                return Ok(None);
            };
            state_base64
        }
        _ => return Ok(None),
    };
    let rule = yjs_rule_from_metadata(metadata.name, field)?;
    app_row.insert(
        field.field.to_string(),
        materialize_yjs_state(&next_state_base64, &rule)?,
    );
    app_row.insert(
        field.state_column.to_string(),
        Value::String(next_state_base64),
    );
    fill_required_app_defaults(metadata, &mut app_row);
    Ok(Some(Value::Object(app_row)))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum EncryptedCrdtPlaintext {
    #[serde(rename = "yjs-update-v1", rename_all = "camelCase")]
    YjsUpdateV1 {
        update_base64: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requires_state_vector_base64: Option<String>,
    },
    #[serde(rename = "yjs-state-v1", rename_all = "camelCase")]
    YjsStateV1 { state_base64: String },
}

fn scopes_from_app_row(
    metadata: &AppTableMetadata,
    row: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    let mut scopes = Map::new();
    for scope in metadata.scopes {
        if let Some(value) = row.get(scope.column) {
            scopes.insert(scope.name.to_string(), value.clone());
        } else if scope.required {
            return Err(SyncularError::protocol_message(format!(
                "cannot build encrypted CRDT update for {} without scope column {}",
                metadata.name, scope.column
            )));
        }
    }
    Ok(scopes)
}

fn merge_scope_columns(
    metadata: &AppTableMetadata,
    system_row: &Map<String, Value>,
    app_row: &mut Map<String, Value>,
) -> Result<()> {
    let scopes = system_row
        .get("scopes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for scope in metadata.scopes {
        if !app_row.contains_key(scope.column) {
            if let Some(value) = scopes.get(scope.name) {
                app_row.insert(scope.column.to_string(), value.clone());
            }
        }
    }
    Ok(())
}

fn fill_required_app_defaults(metadata: &AppTableMetadata, row: &mut Map<String, Value>) {
    for column in metadata.columns {
        if row.contains_key(column.name) {
            continue;
        }
        let value = match column.type_family {
            "integer" => Value::Number(0.into()),
            "real" => json!(0.0),
            "text" if column.notnull_required => Value::String(String::new()),
            _ => Value::Null,
        };
        row.insert(column.name.to_string(), value);
    }
}

fn yjs_rule_from_metadata(table: &str, field: &CrdtYjsFieldMetadata) -> Result<YjsFieldRule> {
    Ok(YjsFieldRule {
        table: table.to_string(),
        field: field.field.to_string(),
        state_column: field.state_column.to_string(),
        container_key: Some(field.container_key.to_string()),
        row_id_field: Some(field.row_id_field.to_string()),
        kind: match field.kind {
            "text" => YjsFieldKind::Text,
            "xml-fragment" => YjsFieldKind::XmlFragment,
            "prosemirror" => YjsFieldKind::Prosemirror,
            other => {
                return Err(SyncularError::config(format!(
                    "unsupported encrypted CRDT Yjs field kind: {other}"
                )));
            }
        },
    })
}

fn checkpoint_state_base64(
    existing: &Map<String, Value>,
    field: &CrdtYjsFieldMetadata,
) -> Result<String> {
    if let Some(state) = existing
        .get(field.state_column)
        .and_then(Value::as_str)
        .filter(|state| !state.is_empty())
    {
        return Ok(state.to_string());
    }

    if field.kind == "text" {
        let text = existing
            .get(field.field)
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(build_yjs_text_update(BuildYjsTextUpdateArgs {
            previous_state_base64: None,
            next_text: text.to_string(),
            container_key: Some(field.container_key.to_string()),
            update_id: Some("checkpoint-state".to_string()),
        })?
        .next_state_base64);
    }

    Err(SyncularError::protocol_message(format!(
        "cannot build encrypted CRDT checkpoint for {} without {} state",
        field.field, field.state_column
    )))
}

fn encrypted_crdt_aad(
    table: &str,
    partition_id: &str,
    stream_id: &str,
    app_table: &str,
    row_id: &str,
    field_name: &str,
    identity: &str,
) -> Vec<u8> {
    format!(
        "{table}\u{1f}{partition_id}\u{1f}{stream_id}\u{1f}{app_table}\u{1f}{row_id}\u{1f}{field_name}\u{1f}{identity}"
    )
    .into_bytes()
}

fn encrypt_payload(key: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<String> {
    let nonce = random_bytes(24)?;
    let ciphertext = xchacha_encrypt(key, &nonce, aad, plaintext)?;
    Ok(format!(
        "{CRDT_CIPHERTEXT_PREFIX}{}:{}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(ciphertext)
    ))
}

fn decrypt_payload(key: &[u8], aad: &[u8], encoded: &str) -> Result<Vec<u8>> {
    let rest = encoded
        .strip_prefix(CRDT_CIPHERTEXT_PREFIX)
        .ok_or_else(|| {
            SyncularError::protocol_message("encrypted CRDT ciphertext has unsupported envelope")
        })?;
    let mut parts = rest.split(':');
    let nonce = parts.next().unwrap_or_default();
    let ciphertext = parts.next().unwrap_or_default();
    if parts.next().is_some() || nonce.is_empty() || ciphertext.is_empty() {
        return Err(SyncularError::protocol_message(
            "encrypted CRDT ciphertext envelope is malformed",
        ));
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(nonce)
        .map_err(|err| SyncularError::protocol_message(format!("decode CRDT nonce: {err}")))?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|err| SyncularError::protocol_message(format!("decode CRDT ciphertext: {err}")))?;
    xchacha_decrypt(key, &nonce, aad, &ciphertext)
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
