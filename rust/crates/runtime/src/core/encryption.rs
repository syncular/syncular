use crate::error::{Result, SyncularError};
use crate::protocol::{
    blob_hash, normalize_blob_mime_type, validate_blob_bytes, validate_blob_size_bytes, BlobRef,
    OperationResult, PullResponse, PushBatchRequest, PushCommitRequest, PushCommitResponse,
    SyncChange, SyncOperation,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use bip39::{Language, Mnemonic};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Sha256;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

pub const DEFAULT_FIELD_ENCRYPTION_PREFIX: &str = "dgsync:e2ee:1:";
const KEY_WRAP_HKDF_INFO: &[u8] = b"syncular-key-wrap-v1";
const BLOB_CIPHERTEXT_VERSION: u8 = 1;
const BLOB_NONCE_LEN: usize = 24;
const BLOB_CIPHERTEXT_HEADER_LEN: usize = 1 + BLOB_NONCE_LEN;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldDecryptionErrorMode {
    Throw,
    KeepCiphertext,
}

impl Default for FieldDecryptionErrorMode {
    fn default() -> Self {
        Self::Throw
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldEncryptionRule {
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    pub fields: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_id_field: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldEncryptionContext {
    pub actor_id: String,
    pub client_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldEncryptionTarget {
    pub scope: String,
    pub table: String,
    pub row_id: String,
    pub field: String,
}

pub trait FieldEncryptionKeyProvider: Send + Sync {
    fn get_key(&self, kid: &str) -> Result<Vec<u8>>;

    fn encryption_kid(
        &self,
        _ctx: &FieldEncryptionContext,
        _target: &FieldEncryptionTarget,
    ) -> Result<String> {
        Ok("default".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct StaticFieldEncryptionKeys {
    keys: BTreeMap<String, Vec<u8>>,
    encryption_kid: String,
}

impl StaticFieldEncryptionKeys {
    pub fn new(
        keys: impl IntoIterator<Item = (impl Into<String>, impl Into<Vec<u8>>)>,
        encryption_kid: Option<String>,
    ) -> Result<Self> {
        let mut decoded = BTreeMap::new();
        for (kid, key) in keys {
            let kid = kid.into();
            validate_kid(&kid)?;
            let key = key.into();
            validate_32_bytes("encryption key", &key)?;
            decoded.insert(kid, key);
        }

        let encryption_kid = encryption_kid.unwrap_or_else(|| "default".to_string());
        validate_kid(&encryption_kid)?;

        Ok(Self {
            keys: decoded,
            encryption_kid,
        })
    }

    pub fn from_key_material(
        keys: BTreeMap<String, String>,
        encryption_kid: Option<String>,
    ) -> Result<Self> {
        let mut decoded = BTreeMap::new();
        for (kid, material) in keys {
            decoded.insert(kid, decode_key_material(&material)?);
        }
        Self::new(decoded, encryption_kid)
    }
}

impl FieldEncryptionKeyProvider for StaticFieldEncryptionKeys {
    fn get_key(&self, kid: &str) -> Result<Vec<u8>> {
        self.keys.get(kid).cloned().ok_or_else(|| {
            SyncularError::config(format!("Missing encryption key for kid \"{kid}\""))
        })
    }

    fn encryption_kid(
        &self,
        _ctx: &FieldEncryptionContext,
        _target: &FieldEncryptionTarget,
    ) -> Result<String> {
        Ok(self.encryption_kid.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticFieldEncryptionConfig {
    pub rules: Vec<FieldEncryptionRule>,
    pub keys: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_kid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decryption_error_mode: Option<FieldDecryptionErrorMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelope_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticBlobEncryptionConfig {
    pub keys: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_kid: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EncryptedBlobBody {
    pub blob: BlobRef,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct BlobEncryption {
    keys: BTreeMap<String, Vec<u8>>,
    encryption_kid: String,
}

impl BlobEncryption {
    pub fn from_static_config(config: StaticBlobEncryptionConfig) -> Result<Self> {
        let mut keys = BTreeMap::new();
        for (kid, material) in config.keys {
            validate_kid(&kid)?;
            keys.insert(kid, decode_key_material(&material)?);
        }

        let encryption_kid = config
            .encryption_kid
            .unwrap_or_else(|| "default".to_string());
        validate_kid(&encryption_kid)?;
        if keys.is_empty() {
            return Err(SyncularError::config(
                "blob encryption requires at least one key",
            ));
        }
        if !keys.contains_key(&encryption_kid) {
            return Err(SyncularError::config(format!(
                "blob encryption key \"{encryption_kid}\" is missing"
            )));
        }

        Ok(Self {
            keys,
            encryption_kid,
        })
    }

    pub fn from_static_config_json(config_json: &str) -> Result<Option<Self>> {
        let trimmed = config_json.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(None);
        }
        let config: StaticBlobEncryptionConfig = serde_json::from_str(trimmed)?;
        Ok(Some(Self::from_static_config(config)?))
    }

    pub fn encrypt_blob(&self, plaintext: &[u8], mime_type: &str) -> Result<EncryptedBlobBody> {
        let mime_type = normalize_blob_mime_type(mime_type);
        let kid = self.encryption_kid.clone();
        let key = self.key(&kid)?;
        let nonce = random_bytes(BLOB_NONCE_LEN)?;
        let aad = make_blob_aad(&kid, &mime_type);
        let encrypted = xchacha_encrypt(key, &nonce, &aad, plaintext)?;
        let mut body = Vec::with_capacity(BLOB_CIPHERTEXT_HEADER_LEN + encrypted.len());
        body.push(BLOB_CIPHERTEXT_VERSION);
        body.extend_from_slice(&nonce);
        body.extend_from_slice(&encrypted);

        let size = i64::try_from(body.len()).map_err(|_| {
            SyncularError::protocol_message("encrypted blob is too large for SQLite size metadata")
        })?;
        validate_blob_size_bytes(size)?;
        let blob = BlobRef {
            hash: blob_hash(&body),
            size,
            mime_type,
            encrypted: true,
            key_id: Some(kid),
        };
        Ok(EncryptedBlobBody { blob, body })
    }

    pub fn decrypt_blob(&self, blob: &BlobRef, body: &[u8]) -> Result<Vec<u8>> {
        validate_blob_bytes(blob, body)?;
        if !blob.encrypted {
            return Ok(body.to_vec());
        }
        let kid = blob.key_id.as_deref().ok_or_else(|| {
            SyncularError::protocol_message("encrypted blob ref is missing keyId")
        })?;
        validate_kid(kid)?;
        let key = self.key(kid)?;
        if body.len() < BLOB_CIPHERTEXT_HEADER_LEN {
            return Err(SyncularError::protocol_message(
                "encrypted blob body is too short",
            ));
        }
        if body[0] != BLOB_CIPHERTEXT_VERSION {
            return Err(SyncularError::protocol_message(format!(
                "unsupported encrypted blob version {}",
                body[0]
            )));
        }
        let nonce = &body[1..BLOB_CIPHERTEXT_HEADER_LEN];
        let ciphertext = &body[BLOB_CIPHERTEXT_HEADER_LEN..];
        xchacha_decrypt(key, nonce, &make_blob_aad(kid, &blob.mime_type), ciphertext)
    }

    pub fn ensure_can_decrypt(&self, blob: &BlobRef) -> Result<()> {
        if !blob.encrypted {
            return Ok(());
        }
        let kid = blob.key_id.as_deref().ok_or_else(|| {
            SyncularError::protocol_message("encrypted blob ref is missing keyId")
        })?;
        validate_kid(kid)?;
        let _ = self.key(kid)?;
        Ok(())
    }

    fn key(&self, kid: &str) -> Result<&[u8]> {
        self.keys.get(kid).map(Vec::as_slice).ok_or_else(|| {
            SyncularError::config(format!("Missing blob encryption key for kid \"{kid}\""))
        })
    }
}

#[derive(Clone)]
pub struct FieldEncryption {
    rules: Vec<FieldEncryptionRule>,
    index: RuleIndex,
    keys: Arc<dyn FieldEncryptionKeyProvider>,
    prefix: String,
    decryption_error_mode: FieldDecryptionErrorMode,
}

impl FieldEncryption {
    pub fn new(
        rules: Vec<FieldEncryptionRule>,
        keys: Arc<dyn FieldEncryptionKeyProvider>,
    ) -> Result<Self> {
        Self::with_options(rules, keys, None, FieldDecryptionErrorMode::Throw)
    }

    pub fn with_options(
        rules: Vec<FieldEncryptionRule>,
        keys: Arc<dyn FieldEncryptionKeyProvider>,
        envelope_prefix: Option<String>,
        decryption_error_mode: FieldDecryptionErrorMode,
    ) -> Result<Self> {
        let prefix = envelope_prefix.unwrap_or_else(|| DEFAULT_FIELD_ENCRYPTION_PREFIX.to_string());
        if !prefix.ends_with(':') {
            return Err(SyncularError::config(
                "field encryption envelope prefix must end with ':'",
            ));
        }
        let index = RuleIndex::build(&rules)?;
        Ok(Self {
            rules,
            index,
            keys,
            prefix,
            decryption_error_mode,
        })
    }

    pub fn from_static_config(config: StaticFieldEncryptionConfig) -> Result<Self> {
        let keys =
            StaticFieldEncryptionKeys::from_key_material(config.keys, config.encryption_kid)?;
        Self::with_options(
            config.rules,
            Arc::new(keys),
            config.envelope_prefix,
            config.decryption_error_mode.unwrap_or_default(),
        )
    }

    pub fn from_static_config_json(config_json: &str) -> Result<Option<Self>> {
        let trimmed = config_json.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(None);
        }
        let config: StaticFieldEncryptionConfig = serde_json::from_str(trimmed)?;
        Ok(Some(Self::from_static_config(config)?))
    }

    pub fn rules(&self) -> &[FieldEncryptionRule] {
        &self.rules
    }

    pub fn transform_push_batch_request(
        &self,
        ctx: &FieldEncryptionContext,
        mut request: PushBatchRequest,
    ) -> Result<PushBatchRequest> {
        for commit in &mut request.commits {
            self.transform_push_commit_request_in_place(ctx, commit)?;
        }
        Ok(request)
    }

    pub fn transform_push_commit_request(
        &self,
        ctx: &FieldEncryptionContext,
        mut request: PushCommitRequest,
    ) -> Result<PushCommitRequest> {
        self.transform_push_commit_request_in_place(ctx, &mut request)?;
        Ok(request)
    }

    pub fn transform_operations_for_push(
        &self,
        ctx: &FieldEncryptionContext,
        operations: Vec<SyncOperation>,
    ) -> Result<Vec<SyncOperation>> {
        operations
            .into_iter()
            .map(|operation| self.transform_operation_for_push(ctx, operation))
            .collect()
    }

    pub fn transform_push_response(
        &self,
        ctx: &FieldEncryptionContext,
        outbox_operations: &[SyncOperation],
        mut response: PushCommitResponse,
    ) -> Result<PushCommitResponse> {
        for result in &mut response.results {
            self.transform_operation_result(ctx, outbox_operations, result)?;
        }
        Ok(response)
    }

    pub fn transform_pull_response(
        &self,
        ctx: &FieldEncryptionContext,
        mut response: PullResponse,
    ) -> Result<PullResponse> {
        for sub in &mut response.subscriptions {
            if let Some(snapshots) = &mut sub.snapshots {
                for snapshot in snapshots {
                    for row in &mut snapshot.rows {
                        *row = self.transform_snapshot_row(ctx, &snapshot.table, row.clone())?;
                    }
                }
            }
            for commit in &mut sub.commits {
                for change in &mut commit.changes {
                    self.transform_change_in_place(ctx, change)?;
                }
            }
        }
        Ok(response)
    }

    pub fn transform_snapshot_row(
        &self,
        ctx: &FieldEncryptionContext,
        snapshot_table: &str,
        row: Value,
    ) -> Result<Value> {
        let Value::Object(record) = row else {
            return Ok(row);
        };
        let scope = snapshot_table.to_string();
        let table = self.infer_snapshot_table(&scope, &record)?;
        let Some(config) = self.index.config_for(&scope, &table) else {
            return Ok(Value::Object(record));
        };
        let row_id = snapshot_row_id(&record, &config.row_id_field, &scope, &table)?;
        let transformed = self.transform_record_fields(
            ctx,
            TransformMode::Decrypt,
            FieldRecordTarget {
                scope: &scope,
                table: &table,
                row_id: &row_id,
            },
            record,
        )?;
        Ok(Value::Object(transformed))
    }

    pub fn transform_change(
        &self,
        ctx: &FieldEncryptionContext,
        mut change: SyncChange,
    ) -> Result<SyncChange> {
        self.transform_change_in_place(ctx, &mut change)?;
        Ok(change)
    }

    fn transform_push_commit_request_in_place(
        &self,
        ctx: &FieldEncryptionContext,
        request: &mut PushCommitRequest,
    ) -> Result<()> {
        for operation in &mut request.operations {
            *operation = self.transform_operation_for_push(ctx, operation.clone())?;
        }
        Ok(())
    }

    fn transform_operation_for_push(
        &self,
        ctx: &FieldEncryptionContext,
        mut operation: SyncOperation,
    ) -> Result<SyncOperation> {
        if operation.op != "upsert" {
            return Ok(operation);
        }
        let Some(Value::Object(record)) = operation.payload.take() else {
            return Ok(operation);
        };
        let target = self.index.resolve_scope_and_table(&operation.table);
        let record = self.transform_record_fields(
            ctx,
            TransformMode::Encrypt,
            FieldRecordTarget {
                scope: &target.scope,
                table: &target.table,
                row_id: &operation.row_id,
            },
            record,
        )?;
        operation.payload = Some(Value::Object(record));
        Ok(operation)
    }

    fn transform_operation_result(
        &self,
        ctx: &FieldEncryptionContext,
        outbox_operations: &[SyncOperation],
        result: &mut OperationResult,
    ) -> Result<()> {
        if result.status != "conflict" && result.status != "error" {
            return Ok(());
        }
        let Some(Value::Object(record)) = result.server_row.take() else {
            return Ok(());
        };
        let Some(operation) = outbox_operations.get(result.op_index as usize) else {
            result.server_row = Some(Value::Object(record));
            return Ok(());
        };
        let target = self.index.resolve_scope_and_table(&operation.table);
        let record = self.transform_record_fields(
            ctx,
            TransformMode::Decrypt,
            FieldRecordTarget {
                scope: &target.scope,
                table: &target.table,
                row_id: &operation.row_id,
            },
            record,
        )?;
        result.server_row = Some(Value::Object(record));
        Ok(())
    }

    fn transform_change_in_place(
        &self,
        ctx: &FieldEncryptionContext,
        change: &mut SyncChange,
    ) -> Result<()> {
        if change.op != "upsert" {
            return Ok(());
        }
        let Some(Value::Object(record)) = change.row_json.take() else {
            return Ok(());
        };
        let target = self.index.resolve_scope_and_table(&change.table);
        let record = self.transform_record_fields(
            ctx,
            TransformMode::Decrypt,
            FieldRecordTarget {
                scope: &target.scope,
                table: &target.table,
                row_id: &change.row_id,
            },
            record,
        )?;
        change.row_json = Some(Value::Object(record));
        Ok(())
    }

    fn infer_snapshot_table(&self, scope: &str, row: &Map<String, Value>) -> Result<String> {
        if let Some(table) = row.get("table_name").and_then(Value::as_str) {
            if !table.is_empty() {
                return Ok(table.to_string());
            }
        }
        if let Some(table) = row.get("__table").and_then(Value::as_str) {
            if !table.is_empty() {
                return Ok(table.to_string());
            }
        }
        if let Some(table) = self.index.only_table_for_scope(scope) {
            return Ok(table.to_string());
        }
        Ok(scope.to_string())
    }

    fn transform_record_fields(
        &self,
        ctx: &FieldEncryptionContext,
        mode: TransformMode,
        target: FieldRecordTarget<'_>,
        mut record: Map<String, Value>,
    ) -> Result<Map<String, Value>> {
        let Some(config) = self.index.config_for(target.scope, target.table) else {
            return Ok(record);
        };

        for field in &config.fields {
            let Some(value) = record.remove(field) else {
                continue;
            };
            let transformed = match mode {
                TransformMode::Encrypt => self.encrypt_value(ctx, &target, field, value)?,
                TransformMode::Decrypt => self.decrypt_value(&target, field, value)?,
            };
            record.insert(field.clone(), transformed);
        }

        Ok(record)
    }

    fn encrypt_value(
        &self,
        ctx: &FieldEncryptionContext,
        target: &FieldRecordTarget<'_>,
        field: &str,
        value: Value,
    ) -> Result<Value> {
        if value.is_null() {
            return Ok(value);
        }
        if value
            .as_str()
            .and_then(|value| decode_envelope(&self.prefix, value).ok().flatten())
            .is_some()
        {
            return Ok(value);
        }

        let field_target = FieldEncryptionTarget {
            scope: target.scope.to_string(),
            table: target.table.to_string(),
            row_id: target.row_id.to_string(),
            field: field.to_string(),
        };
        let kid = self.keys.encryption_kid(ctx, &field_target)?;
        validate_kid(&kid)?;
        let key = self.keys.get_key(&kid)?;
        validate_32_bytes("encryption key", &key)?;
        let nonce = random_bytes(24)?;
        let aad = make_aad(target.scope, target.table, target.row_id, field);
        let plaintext = serde_json::to_vec(&value)?;
        let ciphertext = xchacha_encrypt(&key, &nonce, &aad, &plaintext)?;
        Ok(Value::String(encode_envelope(
            &self.prefix,
            &kid,
            &nonce,
            &ciphertext,
        )))
    }

    fn decrypt_value(
        &self,
        target: &FieldRecordTarget<'_>,
        field: &str,
        value: Value,
    ) -> Result<Value> {
        let Some(raw) = value.as_str() else {
            return Ok(value);
        };
        let Some(envelope) = decode_envelope(&self.prefix, raw)? else {
            return Ok(value);
        };

        let decrypt = || -> Result<Value> {
            let key = self.keys.get_key(&envelope.kid)?;
            validate_32_bytes("encryption key", &key)?;
            let aad = make_aad(target.scope, target.table, target.row_id, field);
            let plaintext = xchacha_decrypt(&key, &envelope.nonce, &aad, &envelope.ciphertext)?;
            Ok(serde_json::from_slice(&plaintext)?)
        };

        match decrypt() {
            Ok(value) => Ok(value),
            Err(error)
                if self.decryption_error_mode == FieldDecryptionErrorMode::KeepCiphertext =>
            {
                Ok(value)
            }
            Err(error) => Err(SyncularError::protocol_message(format!(
                "Failed to decrypt {}.{}.{} row={}: {}",
                target.scope,
                target.table,
                field,
                target.row_id,
                error.message_text()
            ))),
        }
    }
}

#[derive(Debug, Clone)]
struct RuleConfig {
    fields: BTreeSet<String>,
    row_id_field: String,
}

#[derive(Clone)]
struct RuleIndex {
    by_scope_table: HashMap<(String, String), RuleConfig>,
    tables_by_scope: HashMap<String, BTreeSet<String>>,
    scopes_by_table: HashMap<String, BTreeSet<String>>,
}

impl RuleIndex {
    fn build(rules: &[FieldEncryptionRule]) -> Result<Self> {
        let mut by_scope_table: HashMap<(String, String), RuleConfig> = HashMap::new();
        let mut tables_by_scope: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut scopes_by_table: HashMap<String, BTreeSet<String>> = HashMap::new();

        for rule in rules {
            if rule.scope.trim().is_empty() {
                return Err(SyncularError::config(
                    "field encryption rule scope cannot be empty",
                ));
            }
            let table = rule.table.clone().unwrap_or_else(|| "*".to_string());
            if table.trim().is_empty() {
                return Err(SyncularError::config(
                    "field encryption rule table cannot be empty",
                ));
            }
            if rule.fields.is_empty() {
                return Err(SyncularError::config(format!(
                    "field encryption rule {}/{} has no fields",
                    rule.scope, table
                )));
            }
            for field in &rule.fields {
                if field.trim().is_empty() {
                    return Err(SyncularError::config(format!(
                        "field encryption rule {}/{} has an empty field",
                        rule.scope, table
                    )));
                }
            }

            let row_id_field = rule
                .row_id_field
                .clone()
                .unwrap_or_else(|| "id".to_string());
            let key = (rule.scope.clone(), table.clone());
            let entry = by_scope_table.entry(key).or_insert_with(|| RuleConfig {
                fields: BTreeSet::new(),
                row_id_field: row_id_field.clone(),
            });
            if entry.row_id_field != row_id_field {
                return Err(SyncularError::config(format!(
                    "conflicting rowIdField for field encryption rule {}/{}",
                    rule.scope, table
                )));
            }
            for field in &rule.fields {
                entry.fields.insert(field.clone());
            }

            if table != "*" {
                tables_by_scope
                    .entry(rule.scope.clone())
                    .or_default()
                    .insert(table.clone());
                scopes_by_table
                    .entry(table)
                    .or_default()
                    .insert(rule.scope.clone());
            }
        }

        Ok(Self {
            by_scope_table,
            tables_by_scope,
            scopes_by_table,
        })
    }

    fn config_for(&self, scope: &str, table: &str) -> Option<&RuleConfig> {
        self.by_scope_table
            .get(&(scope.to_string(), table.to_string()))
            .or_else(|| {
                self.by_scope_table
                    .get(&(scope.to_string(), "*".to_string()))
            })
    }

    fn only_table_for_scope(&self, scope: &str) -> Option<&str> {
        let tables = self.tables_by_scope.get(scope)?;
        if tables.len() == 1 {
            tables.iter().next().map(String::as_str)
        } else {
            None
        }
    }

    fn resolve_scope_and_table(&self, identifier: &str) -> ResolvedScopeTable {
        if self.config_for(identifier, identifier).is_some() {
            return ResolvedScopeTable {
                scope: identifier.to_string(),
                table: identifier.to_string(),
            };
        }

        if let Some(table) = self.only_table_for_scope(identifier) {
            return ResolvedScopeTable {
                scope: identifier.to_string(),
                table: table.to_string(),
            };
        }

        if let Some(scopes) = self.scopes_by_table.get(identifier) {
            if scopes.len() == 1 {
                return ResolvedScopeTable {
                    scope: scopes.iter().next().expect("one scope").clone(),
                    table: identifier.to_string(),
                };
            }
        }

        ResolvedScopeTable {
            scope: identifier.to_string(),
            table: identifier.to_string(),
        }
    }
}

struct ResolvedScopeTable {
    scope: String,
    table: String,
}

#[derive(Debug, Clone, Copy)]
enum TransformMode {
    Encrypt,
    Decrypt,
}

#[derive(Debug, Clone, Copy)]
struct FieldRecordTarget<'a> {
    scope: &'a str,
    table: &'a str,
    row_id: &'a str,
}

#[derive(Debug, Clone)]
struct DecodedEnvelope {
    kid: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct X25519KeyPair {
    pub public_key: String,
    pub private_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedKey {
    pub ephemeral_public: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedKeyJson {
    pub ephemeral_public: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum ParsedKeyShare {
    #[serde(rename = "symmetric")]
    Symmetric { key: String, kid: Option<String> },
    #[serde(rename = "publicKey")]
    PublicKey { public_key: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Argon2idKeyDerivationParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for Argon2idKeyDerivationParams {
    fn default() -> Self {
        Self {
            memory_kib: 19 * 1024,
            iterations: 2,
            parallelism: 1,
        }
    }
}

pub fn generate_symmetric_key() -> Result<Vec<u8>> {
    random_bytes(32)
}

pub fn key_to_base64url(key: &[u8]) -> Result<String> {
    validate_32_bytes("key", key)?;
    Ok(URL_SAFE_NO_PAD.encode(key))
}

pub fn base64url_to_key(encoded: &str) -> Result<Vec<u8>> {
    let key = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|err| SyncularError::config(format!("invalid base64url key: {err}")))?;
    validate_32_bytes("key", &key)?;
    Ok(key)
}

pub fn key_to_mnemonic(key: &[u8]) -> Result<String> {
    validate_32_bytes("key", key)?;
    let mnemonic = Mnemonic::from_entropy_in(Language::English, key)
        .map_err(|err| SyncularError::config(format!("encode mnemonic: {err}")))?;
    Ok(mnemonic.to_string())
}

pub fn mnemonic_to_key(phrase: &str) -> Result<Vec<u8>> {
    let normalized = normalize_mnemonic_input(phrase);
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|err| SyncularError::config(format!("decode mnemonic: {err}")))?;
    let key = mnemonic.to_entropy();
    validate_32_bytes("mnemonic entropy", &key)?;
    Ok(key)
}

pub fn generate_x25519_keypair() -> Result<X25519KeyPair> {
    let private_key = random_array_32()?;
    let public_key = PublicKey::from(&StaticSecret::from(private_key));
    Ok(X25519KeyPair {
        public_key: URL_SAFE_NO_PAD.encode(public_key.as_bytes()),
        private_key: URL_SAFE_NO_PAD.encode(private_key),
    })
}

pub fn public_key_to_mnemonic(public_key: &[u8]) -> Result<String> {
    key_to_mnemonic(public_key)
}

pub fn mnemonic_to_public_key(phrase: &str) -> Result<Vec<u8>> {
    mnemonic_to_key(phrase)
}

pub fn wrap_key_for_recipient(
    recipient_public_key: &[u8],
    symmetric_key: &[u8],
) -> Result<WrappedKey> {
    let recipient_public_key =
        PublicKey::from(expect_32("recipient public key", recipient_public_key)?);
    validate_32_bytes("symmetric key", symmetric_key)?;

    let mut ephemeral_private = random_array_32()?;
    let ephemeral_secret = StaticSecret::from(ephemeral_private);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let shared_secret = ephemeral_secret.diffie_hellman(&recipient_public_key);
    validate_shared_secret(shared_secret.as_bytes())?;

    let mut wrapping_key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(ephemeral_public.as_bytes()), shared_secret.as_bytes())
        .expand(KEY_WRAP_HKDF_INFO, &mut wrapping_key)
        .map_err(|err| SyncularError::protocol_message(format!("derive wrapping key: {err}")))?;
    let nonce = random_bytes(24)?;
    let encrypted = xchacha_encrypt(&wrapping_key, &nonce, &[], symmetric_key)?;
    wrapping_key.zeroize();
    ephemeral_private.zeroize();

    let mut ciphertext = Vec::with_capacity(24 + encrypted.len());
    ciphertext.extend_from_slice(&nonce);
    ciphertext.extend_from_slice(&encrypted);
    Ok(WrappedKey {
        ephemeral_public: ephemeral_public.as_bytes().to_vec(),
        ciphertext,
    })
}

pub fn unwrap_key(my_private_key: &[u8], wrapped: &WrappedKey) -> Result<Vec<u8>> {
    let my_private_key = StaticSecret::from(expect_32("private key", my_private_key)?);
    let ephemeral_public = PublicKey::from(expect_32(
        "ephemeral public key",
        &wrapped.ephemeral_public,
    )?);
    if wrapped.ciphertext.len() != 72 {
        return Err(SyncularError::protocol_message(format!(
            "wrapped key ciphertext must be 72 bytes, got {}",
            wrapped.ciphertext.len()
        )));
    }
    let shared_secret = my_private_key.diffie_hellman(&ephemeral_public);
    validate_shared_secret(shared_secret.as_bytes())?;

    let mut wrapping_key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&wrapped.ephemeral_public), shared_secret.as_bytes())
        .expand(KEY_WRAP_HKDF_INFO, &mut wrapping_key)
        .map_err(|err| SyncularError::protocol_message(format!("derive wrapping key: {err}")))?;
    let nonce = &wrapped.ciphertext[..24];
    let encrypted = &wrapped.ciphertext[24..];
    let key = xchacha_decrypt(&wrapping_key, nonce, &[], encrypted)?;
    wrapping_key.zeroize();
    validate_32_bytes("unwrapped key", &key)?;
    Ok(key)
}

pub fn encode_wrapped_key(wrapped: &WrappedKey) -> String {
    let mut combined =
        Vec::with_capacity(wrapped.ephemeral_public.len() + wrapped.ciphertext.len());
    combined.extend_from_slice(&wrapped.ephemeral_public);
    combined.extend_from_slice(&wrapped.ciphertext);
    URL_SAFE_NO_PAD.encode(combined)
}

pub fn decode_wrapped_key(encoded: &str) -> Result<WrappedKey> {
    let combined = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|err| SyncularError::protocol_message(format!("decode wrapped key: {err}")))?;
    if combined.len() != 104 {
        return Err(SyncularError::protocol_message(format!(
            "wrapped key must be 104 bytes, got {}",
            combined.len()
        )));
    }
    Ok(WrappedKey {
        ephemeral_public: combined[..32].to_vec(),
        ciphertext: combined[32..].to_vec(),
    })
}

pub fn wrapped_key_to_json(wrapped: &WrappedKey) -> WrappedKeyJson {
    WrappedKeyJson {
        ephemeral_public: URL_SAFE_NO_PAD.encode(&wrapped.ephemeral_public),
        ciphertext: URL_SAFE_NO_PAD.encode(&wrapped.ciphertext),
    }
}

pub fn wrapped_key_from_json(json: &WrappedKeyJson) -> Result<WrappedKey> {
    let ephemeral_public = base64url_to_key(&json.ephemeral_public)?;
    let ciphertext = URL_SAFE_NO_PAD.decode(&json.ciphertext).map_err(|err| {
        SyncularError::protocol_message(format!("decode wrapped key ciphertext: {err}"))
    })?;
    Ok(WrappedKey {
        ephemeral_public,
        ciphertext,
    })
}

pub fn key_to_share_url(key: &[u8], kid: Option<&str>) -> Result<String> {
    validate_32_bytes("key", key)?;
    if let Some(kid) = kid {
        validate_kid(kid)?;
    }
    let kid_part = kid
        .map(|kid| format!("/{}", percent_encode(kid)))
        .unwrap_or_default();
    Ok(format!(
        "sync://k/1/{}{}",
        URL_SAFE_NO_PAD.encode(key),
        kid_part
    ))
}

pub fn public_key_to_share_url(public_key: &[u8]) -> Result<String> {
    validate_32_bytes("public key", public_key)?;
    Ok(format!(
        "sync://pk/1/{}",
        URL_SAFE_NO_PAD.encode(public_key)
    ))
}

pub fn parse_share_url(url: &str) -> Result<ParsedKeyShare> {
    let Some(rest) = url.strip_prefix("sync://") else {
        return Err(SyncularError::config("share URL must start with sync://"));
    };
    let mut parts = rest.split('/');
    let share_type = parts
        .next()
        .ok_or_else(|| SyncularError::config("missing share URL type"))?;
    let version = parts
        .next()
        .ok_or_else(|| SyncularError::config("missing share URL version"))?;
    let encoded = parts
        .next()
        .ok_or_else(|| SyncularError::config("missing share URL key data"))?;
    if version != "1" {
        return Err(SyncularError::config(format!(
            "unsupported share URL version: {version}"
        )));
    }
    match share_type {
        "k" => {
            let key = base64url_to_key(encoded)?;
            let kid = parts.next().map(percent_decode).transpose()?;
            if let Some(kid) = kid.as_deref() {
                validate_kid(kid)?;
            }
            Ok(ParsedKeyShare::Symmetric {
                key: URL_SAFE_NO_PAD.encode(key),
                kid,
            })
        }
        "pk" => {
            let public_key = base64url_to_key(encoded)?;
            Ok(ParsedKeyShare::PublicKey {
                public_key: URL_SAFE_NO_PAD.encode(public_key),
            })
        }
        _ => Err(SyncularError::config(format!(
            "unknown share URL type: {share_type}"
        ))),
    }
}

pub fn derive_scoped_passphrase_key_pbkdf2(
    passphrase: &str,
    scope: &str,
    iterations: u32,
) -> Result<Vec<u8>> {
    if iterations == 0 {
        return Err(SyncularError::config(
            "PBKDF2 iteration count must be greater than zero",
        ));
    }
    let mut key = [0u8; 32];
    let salt = format!("sync-e2ee:{scope}");
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt.as_bytes(), iterations, &mut key);
    Ok(key.to_vec())
}

pub fn derive_passphrase_key_argon2id(
    passphrase: &str,
    salt: &[u8],
    params: Argon2idKeyDerivationParams,
) -> Result<Vec<u8>> {
    if salt.len() < 8 {
        return Err(SyncularError::config(
            "Argon2id salt must be at least 8 bytes",
        ));
    }
    let params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(32),
    )
    .map_err(|err| SyncularError::config(format!("invalid Argon2id params: {err}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|err| SyncularError::config(format!("derive Argon2id key: {err}")))?;
    Ok(key.to_vec())
}

pub fn encryption_helpers_json(method: &str, args_json: &str) -> Result<String> {
    match method {
        "generateSymmetricKey" => Ok(serde_json::to_string(&key_to_base64url(
            &generate_symmetric_key()?,
        )?)?),
        "keyToMnemonic" => {
            let args: KeyMaterialArgs = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&key_to_mnemonic(
                &decode_key_material(&args.key)?,
            )?)?)
        }
        "mnemonicToKey" => {
            let args: MnemonicArgs = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&key_to_base64url(
                &mnemonic_to_key(&args.phrase)?,
            )?)?)
        }
        "generateKeypair" => Ok(serde_json::to_string(&generate_x25519_keypair()?)?),
        "wrapKeyForRecipient" => {
            let args: WrapKeyArgs = serde_json::from_str(args_json)?;
            let wrapped = wrap_key_for_recipient(
                &decode_key_material(&args.recipient_public_key)?,
                &decode_key_material(&args.symmetric_key)?,
            )?;
            Ok(serde_json::to_string(&encode_wrapped_key(&wrapped))?)
        }
        "unwrapKey" => {
            let args: UnwrapKeyArgs = serde_json::from_str(args_json)?;
            let wrapped = decode_wrapped_key(&args.wrapped_key)?;
            Ok(serde_json::to_string(&key_to_base64url(&unwrap_key(
                &decode_key_material(&args.private_key)?,
                &wrapped,
            )?)?)?)
        }
        "keyToShareUrl" => {
            let args: KeyShareUrlArgs = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&key_to_share_url(
                &decode_key_material(&args.key)?,
                args.kid.as_deref(),
            )?)?)
        }
        "publicKeyToShareUrl" => {
            let args: PublicKeyArgs = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&public_key_to_share_url(
                &decode_key_material(&args.public_key)?,
            )?)?)
        }
        "parseShareUrl" => {
            let args: ShareUrlArgs = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&parse_share_url(&args.url)?)?)
        }
        "deriveScopedPassphraseKeyPbkdf2" => {
            let args: Pbkdf2Args = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&key_to_base64url(
                &derive_scoped_passphrase_key_pbkdf2(
                    &args.passphrase,
                    &args.scope,
                    args.iterations.unwrap_or(100_000),
                )?,
            )?)?)
        }
        "derivePassphraseKeyArgon2id" => {
            let args: Argon2idArgs = serde_json::from_str(args_json)?;
            Ok(serde_json::to_string(&key_to_base64url(
                &derive_passphrase_key_argon2id(
                    &args.passphrase,
                    &decode_key_material(&args.salt)?,
                    args.params.unwrap_or_default(),
                )?,
            )?)?)
        }
        _ => Err(SyncularError::config(format!(
            "unknown encryption helper method: {method}"
        ))),
    }
}

fn encode_envelope(prefix: &str, kid: &str, nonce: &[u8], ciphertext: &[u8]) -> String {
    format!(
        "{prefix}{kid}:{}:{}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(ciphertext)
    )
}

fn decode_envelope(prefix: &str, value: &str) -> Result<Option<DecodedEnvelope>> {
    let Some(rest) = value.strip_prefix(prefix) else {
        return Ok(None);
    };
    let mut parts = rest.split(':');
    let kid = parts.next().unwrap_or_default();
    let nonce = parts.next().unwrap_or_default();
    let ciphertext = parts.next().unwrap_or_default();
    if parts.next().is_some() || kid.is_empty() || nonce.is_empty() || ciphertext.is_empty() {
        return Ok(None);
    }
    let nonce = URL_SAFE_NO_PAD.decode(nonce).map_err(|err| {
        SyncularError::protocol_message(format!("decode encryption nonce: {err}"))
    })?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|err| SyncularError::protocol_message(format!("decode ciphertext: {err}")))?;
    Ok(Some(DecodedEnvelope {
        kid: kid.to_string(),
        nonce,
        ciphertext,
    }))
}

pub(crate) fn xchacha_encrypt(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    validate_32_bytes("XChaCha20-Poly1305 key", key)?;
    if nonce.len() != 24 {
        return Err(SyncularError::protocol_message(format!(
            "XChaCha20-Poly1305 nonce must be 24 bytes, got {}",
            nonce.len()
        )));
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| SyncularError::protocol_message("invalid XChaCha20-Poly1305 key"))?;
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| SyncularError::protocol_message("XChaCha20-Poly1305 encryption failed"))
}

pub(crate) fn xchacha_decrypt(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    validate_32_bytes("XChaCha20-Poly1305 key", key)?;
    if nonce.len() != 24 {
        return Err(SyncularError::protocol_message(format!(
            "XChaCha20-Poly1305 nonce must be 24 bytes, got {}",
            nonce.len()
        )));
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| SyncularError::protocol_message("invalid XChaCha20-Poly1305 key"))?;
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| SyncularError::protocol_message("XChaCha20-Poly1305 decryption failed"))
}

fn make_aad(scope: &str, table: &str, row_id: &str, field: &str) -> Vec<u8> {
    format!("{scope}\u{1f}{table}\u{1f}{row_id}\u{1f}{field}").into_bytes()
}

fn make_blob_aad(kid: &str, mime_type: &str) -> Vec<u8> {
    format!(
        "syncular:blob:v1\u{1f}{kid}\u{1f}{}",
        normalize_blob_mime_type(mime_type)
    )
    .into_bytes()
}

fn snapshot_row_id(
    row: &Map<String, Value>,
    row_id_field: &str,
    scope: &str,
    table: &str,
) -> Result<String> {
    let row_id = row
        .get(row_id_field)
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default();
    if row_id.is_empty() {
        return Err(SyncularError::protocol_message(format!(
            "snapshot row for {scope}/{table} is missing row id field \"{row_id_field}\""
        )));
    }
    Ok(row_id)
}

pub(crate) fn random_bytes(length: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; length];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| SyncularError::config(format!("secure random generator failed: {err}")))?;
    Ok(bytes)
}

fn random_array_32() -> Result<[u8; 32]> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| SyncularError::config(format!("secure random generator failed: {err}")))?;
    Ok(bytes)
}

pub(crate) fn validate_32_bytes(label: &str, bytes: &[u8]) -> Result<()> {
    if bytes.len() != 32 {
        return Err(SyncularError::config(format!(
            "{label} must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    Ok(())
}

fn expect_32(label: &str, bytes: &[u8]) -> Result<[u8; 32]> {
    validate_32_bytes(label, bytes)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn validate_kid(kid: &str) -> Result<()> {
    if kid.is_empty() {
        return Err(SyncularError::config("encryption key id cannot be empty"));
    }
    if kid.contains(':') {
        return Err(SyncularError::config(
            "encryption key id must not contain ':'",
        ));
    }
    Ok(())
}

fn validate_shared_secret(shared_secret: &[u8; 32]) -> Result<()> {
    if shared_secret.iter().all(|byte| *byte == 0) {
        return Err(SyncularError::protocol_message(
            "X25519 shared secret is all zeros",
        ));
    }
    Ok(())
}

fn decode_key_material(material: &str) -> Result<Vec<u8>> {
    let trimmed = material.trim();
    let decoded = if let Some(rest) = trimmed.strip_prefix("hex:") {
        hex::decode(rest).map_err(|err| SyncularError::config(format!("invalid hex key: {err}")))?
    } else if let Some(rest) = trimmed.strip_prefix("base64:") {
        STANDARD
            .decode(rest)
            .map_err(|err| SyncularError::config(format!("invalid base64 key: {err}")))?
    } else if let Some(rest) = trimmed.strip_prefix("base64url:") {
        URL_SAFE_NO_PAD
            .decode(rest)
            .map_err(|err| SyncularError::config(format!("invalid base64url key: {err}")))?
    } else if trimmed.len() == 64 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        hex::decode(trimmed)
            .map_err(|err| SyncularError::config(format!("invalid hex key: {err}")))?
    } else {
        URL_SAFE_NO_PAD
            .decode(trimmed)
            .map_err(|err| SyncularError::config(format!("invalid base64url key: {err}")))?
    };
    validate_32_bytes("key material", &decoded)?;
    Ok(decoded)
}

fn normalize_mnemonic_input(phrase: &str) -> String {
    phrase
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn percent_encode(value: &str) -> String {
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

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(SyncularError::config("invalid percent-encoded key id"));
        }
        let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
            .map_err(|_| SyncularError::config("invalid percent-encoded key id"))?;
        let byte = u8::from_str_radix(hex, 16)
            .map_err(|_| SyncularError::config("invalid percent-encoded key id"))?;
        out.push(byte);
        index += 3;
    }
    String::from_utf8(out).map_err(|_| SyncularError::config("invalid UTF-8 key id"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyMaterialArgs {
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MnemonicArgs {
    phrase: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrapKeyArgs {
    recipient_public_key: String,
    symmetric_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnwrapKeyArgs {
    private_key: String,
    wrapped_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyShareUrlArgs {
    key: String,
    kid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicKeyArgs {
    public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareUrlArgs {
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pbkdf2Args {
    passphrase: String,
    scope: String,
    iterations: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Argon2idArgs {
    passphrase: String,
    salt: String,
    params: Option<Argon2idKeyDerivationParams>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{PullResponse, SubscriptionResponse, SyncCommit, SyncSnapshot};
    use serde_json::json;

    fn encryption() -> FieldEncryption {
        let mut keys = BTreeMap::new();
        keys.insert("default".to_string(), URL_SAFE_NO_PAD.encode([7u8; 32]));
        FieldEncryption::from_static_config(StaticFieldEncryptionConfig {
            rules: vec![FieldEncryptionRule {
                scope: "tasks".to_string(),
                table: Some("tasks".to_string()),
                fields: vec!["title".to_string()],
                row_id_field: None,
            }],
            keys,
            encryption_kid: None,
            decryption_error_mode: None,
            envelope_prefix: None,
        })
        .expect("encryption")
    }

    fn ctx() -> FieldEncryptionContext {
        FieldEncryptionContext {
            actor_id: "user-rust".to_string(),
            client_id: "client-rust".to_string(),
        }
    }

    fn blob_encryption() -> BlobEncryption {
        let mut keys = BTreeMap::new();
        keys.insert("default".to_string(), URL_SAFE_NO_PAD.encode([9u8; 32]));
        BlobEncryption::from_static_config(StaticBlobEncryptionConfig {
            keys,
            encryption_kid: None,
        })
        .expect("blob encryption")
    }

    #[test]
    fn encrypts_push_and_decrypts_pull_rows() -> Result<()> {
        let encryption = encryption();
        let op = SyncOperation {
            table: "tasks".to_string(),
            row_id: "t1".to_string(),
            op: "upsert".to_string(),
            payload: Some(json!({ "title": "Secret", "completed": 0 })),
            base_version: None,
        };
        let encrypted = encryption.transform_operations_for_push(&ctx(), vec![op.clone()])?;
        let payload = encrypted[0].payload.as_ref().expect("payload");
        let title = payload["title"].as_str().expect("encrypted title");
        assert!(title.starts_with(DEFAULT_FIELD_ENCRYPTION_PREFIX));
        assert_ne!(title, "Secret");

        let pull = PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: "sub-tasks".to_string(),
                status: "active".to_string(),
                scopes: Map::new(),
                bootstrap: true,
                bootstrap_state: None,
                next_cursor: 1,
                integrity: None,
                commits: Vec::new(),
                snapshots: Some(vec![SyncSnapshot {
                    table: "tasks".to_string(),
                    rows: vec![json!({ "id": "t1", "title": title, "completed": 0 })],
                    chunks: None,
                    artifacts: None,
                    manifest: None,
                    is_first_page: true,
                    is_last_page: true,
                    bootstrap_state_after: None,
                }]),
            }],
        };
        let decrypted = encryption.transform_pull_response(&ctx(), pull)?;
        let row = &decrypted.subscriptions[0].snapshots.as_ref().unwrap()[0].rows[0];
        assert_eq!(row["title"], "Secret");
        Ok(())
    }

    #[test]
    fn encrypted_blob_body_roundtrips_with_ciphertext_ref() -> Result<()> {
        let encryption = blob_encryption();
        let plaintext = b"top secret blob payload";
        let encrypted = encryption.encrypt_blob(plaintext, "text/plain")?;
        assert!(encrypted.blob.encrypted);
        assert_eq!(encrypted.blob.key_id.as_deref(), Some("default"));
        assert_eq!(encrypted.blob.hash, blob_hash(&encrypted.body));
        assert_ne!(encrypted.blob.hash, blob_hash(plaintext));
        assert_ne!(encrypted.body, plaintext);

        let decrypted = encryption.decrypt_blob(&encrypted.blob, &encrypted.body)?;
        assert_eq!(decrypted, plaintext);
        Ok(())
    }

    #[test]
    fn encrypted_blob_decryption_authenticates_metadata() -> Result<()> {
        let encryption = blob_encryption();
        let encrypted = encryption.encrypt_blob(b"payload", "text/plain")?;

        let mut tampered_mime = encrypted.blob.clone();
        tampered_mime.mime_type = "application/json".to_string();
        let error = encryption
            .decrypt_blob(&tampered_mime, &encrypted.body)
            .unwrap_err();
        assert!(error.to_string().contains("decryption failed"));

        let mut tampered_key = encrypted.blob.clone();
        tampered_key.key_id = Some("missing".to_string());
        let error = encryption
            .decrypt_blob(&tampered_key, &encrypted.body)
            .unwrap_err();
        assert!(error.to_string().contains("Missing blob encryption key"));
        Ok(())
    }

    #[test]
    fn decrypts_incremental_changes() -> Result<()> {
        let encryption = encryption();
        let encrypted = encryption.transform_operations_for_push(
            &ctx(),
            vec![SyncOperation {
                table: "tasks".to_string(),
                row_id: "t2".to_string(),
                op: "upsert".to_string(),
                payload: Some(json!({ "title": "Incremental" })),
                base_version: None,
            }],
        )?;
        let title = encrypted[0].payload.as_ref().unwrap()["title"]
            .as_str()
            .unwrap()
            .to_string();
        let pull = PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: "sub-tasks".to_string(),
                status: "active".to_string(),
                scopes: Map::new(),
                bootstrap: false,
                bootstrap_state: None,
                next_cursor: 2,
                integrity: None,
                snapshots: None,
                commits: vec![SyncCommit {
                    commit_seq: 2,
                    created_at: "2026-05-10T00:00:00.000Z".to_string(),
                    actor_id: "other".to_string(),
                    changes: vec![SyncChange {
                        table: "tasks".to_string(),
                        row_id: "t2".to_string(),
                        op: "upsert".to_string(),
                        row_json: Some(json!({ "id": "t2", "title": title })),
                        row_version: Some(1),
                        scopes: Map::new(),
                    }],
                }],
            }],
        };
        let decrypted = encryption.transform_pull_response(&ctx(), pull)?;
        let change = &decrypted.subscriptions[0].commits[0].changes[0];
        assert_eq!(change.row_json.as_ref().unwrap()["title"], "Incremental");
        Ok(())
    }

    #[test]
    fn key_wrapping_roundtrips() -> Result<()> {
        let alice = generate_x25519_keypair()?;
        let key = generate_symmetric_key()?;
        let wrapped = wrap_key_for_recipient(&decode_key_material(&alice.public_key)?, &key)?;
        let unwrapped = unwrap_key(&decode_key_material(&alice.private_key)?, &wrapped)?;
        assert_eq!(unwrapped, key);
        Ok(())
    }

    #[test]
    fn static_reader_keys_do_not_require_default_encryption_kid() -> Result<()> {
        let mut keys = BTreeMap::new();
        keys.insert("k1".to_string(), URL_SAFE_NO_PAD.encode([1u8; 32]));
        let provider = StaticFieldEncryptionKeys::from_key_material(keys, None)?;
        assert!(provider.get_key("k1").is_ok());
        assert_eq!(
            provider.encryption_kid(
                &ctx(),
                &FieldEncryptionTarget {
                    scope: "tasks".to_string(),
                    table: "tasks".to_string(),
                    row_id: "t1".to_string(),
                    field: "title".to_string(),
                }
            )?,
            "default"
        );
        Ok(())
    }

    #[test]
    fn key_share_url_roundtrips() -> Result<()> {
        let key = [9u8; 32];
        let url = key_to_share_url(&key, Some("scope~patient%3Ap1"))?;
        let parsed = parse_share_url(&url)?;
        assert_eq!(
            parsed,
            ParsedKeyShare::Symmetric {
                key: URL_SAFE_NO_PAD.encode(key),
                kid: Some("scope~patient%3Ap1".to_string())
            }
        );
        Ok(())
    }

    #[test]
    fn mnemonic_roundtrips_32_byte_keys() -> Result<()> {
        let key = [3u8; 32];
        let phrase = key_to_mnemonic(&key)?;
        let decoded = mnemonic_to_key(&phrase)?;
        assert_eq!(decoded, key);
        Ok(())
    }
}
