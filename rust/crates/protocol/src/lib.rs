use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub mod binary_snapshot;
pub mod binary_sync_pack;
pub mod error;
pub mod integrity;
pub mod snapshot_manifest;

pub use error::{ProtocolError, Result};
pub use integrity::{
    validate_pull_commit_integrity_metadata, verify_subscription_commit_integrity,
    wire_commit_chain_root, wire_commit_chain_root_from_digest, wire_commit_digest,
    VerifiedCommitRoot,
};
pub use snapshot_manifest::{snapshot_manifest_digest, validate_pull_snapshot_manifests};

pub const COMMIT_INTEGRITY_HEX_LENGTH: usize = 64;
pub const COMMIT_INTEGRITY_GENESIS_ROOT: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";
pub const WIRE_COMMIT_DIGEST_VERSION: &str = "syncular-wire-commit-digest-v1";
pub const WIRE_COMMIT_CHAIN_ROOT_VERSION: &str = "syncular-wire-commit-chain-root-v1";
pub const SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1: &str = "json-row-frame-v1";
pub const SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1: &str = "binary-table-v1";
pub const SYNC_PACK_ENCODING_JSON_V1: &str = "json-v1";
pub const SYNC_PACK_ENCODING_BINARY_V1: &str = "binary-sync-pack-v1";
pub const SYNC_PACK_CONTENT_TYPE: &str = "application/vnd.syncular.sync-pack.v1";
pub const BINARY_SYNC_PACK_WIRE_VERSION: u16 = 13;
pub const SNAPSHOT_MANIFEST_VERSION: i32 = 1;

pub type ScopeValues = Map<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOperation {
    pub table: String,
    pub row_id: String,
    pub op: String,
    pub payload: Option<Value>,
    pub base_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushCommitRequest {
    #[serde(rename = "clientCommitId")]
    pub client_commit_id: String,
    pub operations: Vec<SyncOperation>,
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushBatchRequest {
    pub commits: Vec<PushCommitRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapState {
    #[serde(rename = "asOfCommitSeq")]
    pub as_of_commit_seq: i64,
    pub tables: Vec<String>,
    #[serde(rename = "tableIndex")]
    pub table_index: i64,
    #[serde(rename = "rowCursor")]
    pub row_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionRequest {
    pub id: String,
    pub table: String,
    pub scopes: ScopeValues,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    pub cursor: i64,
    #[serde(rename = "bootstrapState", skip_serializing_if = "Option::is_none")]
    pub bootstrap_state: Option<BootstrapState>,
    #[serde(rename = "verifiedRoot", skip_serializing_if = "Option::is_none")]
    pub verified_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    #[serde(rename = "limitCommits")]
    pub limit_commits: i64,
    #[serde(rename = "limitSnapshotRows")]
    pub limit_snapshot_rows: i64,
    #[serde(rename = "maxSnapshotPages")]
    pub max_snapshot_pages: i64,
    #[serde(rename = "dedupeRows", skip_serializing_if = "Option::is_none")]
    pub dedupe_rows: Option<bool>,
    #[serde(
        rename = "snapshotEncodings",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub snapshot_encodings: Vec<String>,
    #[serde(
        rename = "syncPackEncodings",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub sync_pack_encodings: Vec<String>,
    pub subscriptions: Vec<SubscriptionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CombinedRequest {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(
        rename = "syncPackEncodings",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub sync_pack_encodings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push: Option<PushBatchRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull: Option<PullRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CombinedResponse {
    pub ok: bool,
    #[serde(
        rename = "requiredSchemaVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub required_schema_version: Option<i32>,
    #[serde(
        rename = "latestSchemaVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub latest_schema_version: Option<i32>,
    pub push: Option<PushBatchResponse>,
    pub pull: Option<PullResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushBatchResponse {
    pub ok: bool,
    pub commits: Vec<PushCommitResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushCommitResponse {
    #[serde(rename = "clientCommitId")]
    pub client_commit_id: String,
    pub status: String,
    #[serde(rename = "commitSeq")]
    pub commit_seq: Option<i64>,
    pub results: Vec<OperationResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationResult {
    #[serde(rename = "opIndex")]
    pub op_index: i32,
    pub status: String,
    pub message: Option<String>,
    pub error: Option<String>,
    pub code: Option<String>,
    pub retriable: Option<bool>,
    #[serde(rename = "server_version")]
    pub server_version: Option<i64>,
    #[serde(rename = "server_row")]
    pub server_row: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullResponse {
    pub ok: bool,
    pub subscriptions: Vec<SubscriptionResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionResponse {
    pub id: String,
    pub status: String,
    pub scopes: ScopeValues,
    pub bootstrap: bool,
    #[serde(rename = "bootstrapState")]
    pub bootstrap_state: Option<BootstrapState>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: i64,
    pub integrity: Option<SubscriptionIntegrity>,
    pub commits: Vec<SyncCommit>,
    pub snapshots: Option<Vec<SyncSnapshot>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionIntegrity {
    #[serde(rename = "partitionId")]
    pub partition_id: String,
    #[serde(rename = "previousChainRoot")]
    pub previous_chain_root: String,
    #[serde(rename = "commitChainRoot")]
    pub commit_chain_root: String,
    #[serde(rename = "commitSeq")]
    pub commit_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncCommit {
    #[serde(rename = "commitSeq")]
    pub commit_seq: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "actorId")]
    pub actor_id: String,
    pub changes: Vec<SyncChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChange {
    pub table: String,
    pub row_id: String,
    pub op: String,
    pub row_json: Option<Value>,
    pub row_version: Option<i64>,
    pub scopes: ScopeValues,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSnapshot {
    pub table: String,
    pub rows: Vec<Value>,
    pub chunks: Option<Vec<SnapshotChunkRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<SnapshotManifest>,
    #[serde(rename = "isFirstPage")]
    pub is_first_page: bool,
    #[serde(rename = "isLastPage")]
    pub is_last_page: bool,
    #[serde(rename = "bootstrapStateAfter")]
    pub bootstrap_state_after: Option<BootstrapState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotChunkRef {
    pub id: String,
    #[serde(rename = "byteLength")]
    pub byte_length: i64,
    pub sha256: String,
    pub encoding: String,
    pub compression: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub version: i32,
    pub digest: String,
    pub table: String,
    #[serde(rename = "asOfCommitSeq")]
    pub as_of_commit_seq: i64,
    #[serde(rename = "scopeDigest")]
    pub scope_digest: String,
    #[serde(rename = "rowCursor")]
    pub row_cursor: Option<String>,
    #[serde(rename = "rowLimit")]
    pub row_limit: i64,
    #[serde(rename = "nextRowCursor")]
    pub next_row_cursor: Option<String>,
    #[serde(rename = "isFirstPage")]
    pub is_first_page: bool,
    #[serde(rename = "isLastPage")]
    pub is_last_page: bool,
    pub chunks: Vec<SnapshotManifestChunkRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifestChunkRef {
    pub id: String,
    #[serde(rename = "byteLength")]
    pub byte_length: i64,
    pub sha256: String,
    pub encoding: String,
    pub compression: String,
}

pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn canonical_json_string(value: &Value) -> Result<String> {
    let mut out = String::new();
    append_canonical_json(&mut out, value)?;
    Ok(out)
}

pub fn append_canonical_json(out: &mut String, value: &Value) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => out.push_str(&value.to_string()),
        Value::String(value) => out.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            out.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                append_canonical_json(out, item)?;
            }
            out.push(']');
        }
        Value::Object(values) => {
            append_canonical_object(out, values)?;
        }
    }
    Ok(())
}

pub fn append_canonical_object(out: &mut String, values: &Map<String, Value>) -> Result<()> {
    let mut keys = values.keys().collect::<Vec<_>>();
    keys.sort();
    out.push('{');
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key)?);
        out.push(':');
        append_canonical_json(
            out,
            values
                .get(key)
                .expect("serde_json object key should resolve"),
        )?;
    }
    out.push('}');
    Ok(())
}
