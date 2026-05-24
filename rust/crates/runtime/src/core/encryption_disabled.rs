use crate::error::{Result, SyncularError};
use crate::protocol::{
    BlobRef, PullResponse, PushBatchRequest, PushCommitRequest, PushCommitResponse, SyncChange,
    SyncOperation,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const DEFAULT_FIELD_ENCRYPTION_PREFIX: &str = "dgsync:e2ee:1:";

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
    fn get_key(&self, _kid: &str) -> Result<Vec<u8>> {
        Err(e2ee_feature_disabled())
    }

    fn encryption_kid(
        &self,
        _ctx: &FieldEncryptionContext,
        _target: &FieldEncryptionTarget,
    ) -> Result<String> {
        Err(e2ee_feature_disabled())
    }
}

#[derive(Debug, Clone)]
pub struct StaticFieldEncryptionKeys;

impl StaticFieldEncryptionKeys {
    pub fn new(
        _keys: impl IntoIterator<Item = (impl Into<String>, impl Into<Vec<u8>>)>,
        _encryption_kid: Option<String>,
    ) -> Result<Self> {
        Err(e2ee_feature_disabled())
    }

    pub fn from_key_material(
        _keys: BTreeMap<String, String>,
        _encryption_kid: Option<String>,
    ) -> Result<Self> {
        Err(e2ee_feature_disabled())
    }
}

impl FieldEncryptionKeyProvider for StaticFieldEncryptionKeys {}

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
pub struct BlobEncryption;

impl BlobEncryption {
    pub fn from_static_config(_config: StaticBlobEncryptionConfig) -> Result<Self> {
        Err(e2ee_feature_disabled())
    }

    pub fn from_static_config_json(config_json: &str) -> Result<Option<Self>> {
        let trimmed = config_json.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(None);
        }
        Err(e2ee_feature_disabled())
    }

    pub fn encrypt_blob(&self, _plaintext: &[u8], _mime_type: &str) -> Result<EncryptedBlobBody> {
        Err(e2ee_feature_disabled())
    }

    pub fn decrypt_blob(&self, _blob: &BlobRef, _body: &[u8]) -> Result<Vec<u8>> {
        Err(e2ee_feature_disabled())
    }

    pub fn ensure_can_decrypt(&self, _blob: &BlobRef) -> Result<()> {
        Err(e2ee_feature_disabled())
    }
}

#[derive(Clone)]
pub struct FieldEncryption {
    rules: Vec<FieldEncryptionRule>,
}

impl FieldEncryption {
    pub fn new(
        _rules: Vec<FieldEncryptionRule>,
        _keys: Arc<dyn FieldEncryptionKeyProvider>,
    ) -> Result<Self> {
        Err(e2ee_feature_disabled())
    }

    pub fn with_options(
        _rules: Vec<FieldEncryptionRule>,
        _keys: Arc<dyn FieldEncryptionKeyProvider>,
        _envelope_prefix: Option<String>,
        _decryption_error_mode: FieldDecryptionErrorMode,
    ) -> Result<Self> {
        Err(e2ee_feature_disabled())
    }

    pub fn from_static_config(_config: StaticFieldEncryptionConfig) -> Result<Self> {
        Err(e2ee_feature_disabled())
    }

    pub fn from_static_config_json(config_json: &str) -> Result<Option<Self>> {
        let trimmed = config_json.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(None);
        }
        Err(e2ee_feature_disabled())
    }

    pub fn rules(&self) -> &[FieldEncryptionRule] {
        &self.rules
    }

    pub fn transform_push_batch_request(
        &self,
        _ctx: &FieldEncryptionContext,
        _request: PushBatchRequest,
    ) -> Result<PushBatchRequest> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_push_commit_request(
        &self,
        _ctx: &FieldEncryptionContext,
        _request: PushCommitRequest,
    ) -> Result<PushCommitRequest> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_operations_for_push(
        &self,
        _ctx: &FieldEncryptionContext,
        _operations: Vec<SyncOperation>,
    ) -> Result<Vec<SyncOperation>> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_push_response(
        &self,
        _ctx: &FieldEncryptionContext,
        _outbox_operations: &[SyncOperation],
        _response: PushCommitResponse,
    ) -> Result<PushCommitResponse> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_pull_response(
        &self,
        _ctx: &FieldEncryptionContext,
        _response: PullResponse,
    ) -> Result<PullResponse> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_snapshot_row(
        &self,
        _ctx: &FieldEncryptionContext,
        _snapshot_table: &str,
        _row: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(e2ee_feature_disabled())
    }

    pub fn transform_change(
        &self,
        _ctx: &FieldEncryptionContext,
        _change: SyncChange,
    ) -> Result<SyncChange> {
        Err(e2ee_feature_disabled())
    }
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
    Err(e2ee_feature_disabled())
}

pub fn key_to_base64url(_key: &[u8]) -> Result<String> {
    Err(e2ee_feature_disabled())
}

pub fn base64url_to_key(_encoded: &str) -> Result<Vec<u8>> {
    Err(e2ee_feature_disabled())
}

pub fn key_to_mnemonic(_key: &[u8]) -> Result<String> {
    Err(e2ee_feature_disabled())
}

pub fn mnemonic_to_key(_phrase: &str) -> Result<Vec<u8>> {
    Err(e2ee_feature_disabled())
}

pub fn generate_x25519_keypair() -> Result<X25519KeyPair> {
    Err(e2ee_feature_disabled())
}

pub fn public_key_to_mnemonic(_public_key: &[u8]) -> Result<String> {
    Err(e2ee_feature_disabled())
}

pub fn mnemonic_to_public_key(_phrase: &str) -> Result<Vec<u8>> {
    Err(e2ee_feature_disabled())
}

pub fn wrap_key_for_recipient(
    _recipient_public_key: &[u8],
    _symmetric_key: &[u8],
) -> Result<WrappedKey> {
    Err(e2ee_feature_disabled())
}

pub fn unwrap_key(_my_private_key: &[u8], _wrapped: &WrappedKey) -> Result<Vec<u8>> {
    Err(e2ee_feature_disabled())
}

pub fn encode_wrapped_key(_wrapped: &WrappedKey) -> String {
    String::new()
}

pub fn decode_wrapped_key(_encoded: &str) -> Result<WrappedKey> {
    Err(e2ee_feature_disabled())
}

pub fn wrapped_key_to_json(wrapped: &WrappedKey) -> WrappedKeyJson {
    WrappedKeyJson {
        ephemeral_public: String::from_utf8_lossy(&wrapped.ephemeral_public).into_owned(),
        ciphertext: String::from_utf8_lossy(&wrapped.ciphertext).into_owned(),
    }
}

pub fn wrapped_key_from_json(_json: &WrappedKeyJson) -> Result<WrappedKey> {
    Err(e2ee_feature_disabled())
}

pub fn key_to_share_url(_key: &[u8], _kid: Option<&str>) -> Result<String> {
    Err(e2ee_feature_disabled())
}

pub fn public_key_to_share_url(_public_key: &[u8]) -> Result<String> {
    Err(e2ee_feature_disabled())
}

pub fn parse_share_url(_url: &str) -> Result<ParsedKeyShare> {
    Err(e2ee_feature_disabled())
}

pub fn derive_scoped_passphrase_key_pbkdf2(
    _passphrase: &str,
    _scope: &str,
    _iterations: u32,
) -> Result<Vec<u8>> {
    Err(e2ee_feature_disabled())
}

pub fn derive_passphrase_key_argon2id(
    _passphrase: &str,
    _salt: &[u8],
    _params: Argon2idKeyDerivationParams,
) -> Result<Vec<u8>> {
    Err(e2ee_feature_disabled())
}

pub fn encryption_helpers_json(_method: &str, _args_json: &str) -> Result<String> {
    Err(e2ee_feature_disabled())
}

fn e2ee_feature_disabled() -> SyncularError {
    SyncularError::config("E2EE support is not enabled in this Syncular runtime build")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_null_config_reports_disabled_feature() {
        let err = match FieldEncryption::from_static_config_json("{}") {
            Ok(_) => panic!("non-null E2EE config should require e2ee feature"),
            Err(err) => err,
        };
        assert!(err.to_string().contains("E2EE support is not enabled"));
    }
}
