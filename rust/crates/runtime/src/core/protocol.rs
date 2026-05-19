use crate::error::{Result, SyncularError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use uuid::Uuid;

pub type ScopeValues = Map<String, Value>;

pub const SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1: &str = "json-row-frame-v1";
pub const SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1: &str = "binary-table-v1";
pub const SYNC_PACK_ENCODING_JSON_V1: &str = "json-v1";
pub const SYNC_PACK_ENCODING_BINARY_V1: &str = "binary-sync-pack-v1";
pub const COMMIT_INTEGRITY_HEX_LENGTH: usize = 64;
pub const SNAPSHOT_MANIFEST_VERSION: i32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOperation {
    pub table: String,
    pub row_id: String,
    pub op: String,
    pub payload: Option<Value>,
    pub base_version: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncularMutationKind {
    Insert,
    Update,
    Upsert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingSyncularMutation {
    pub kind: SyncularMutationKind,
    pub table: String,
    pub row_id: String,
    pub payload: Option<Value>,
    pub base_version: Option<i64>,
    pub local_row: Option<Value>,
}

impl PendingSyncularMutation {
    pub fn operation(&self, base_version: Option<i64>) -> SyncOperation {
        SyncOperation {
            table: self.table.clone(),
            row_id: self.row_id.clone(),
            op: match self.kind {
                SyncularMutationKind::Delete => "delete",
                SyncularMutationKind::Insert
                | SyncularMutationKind::Update
                | SyncularMutationKind::Upsert => "upsert",
            }
            .to_string(),
            payload: self.payload.clone(),
            base_version,
        }
    }
}

pub trait IntoSyncularMutation {
    fn into_syncular_mutation(self) -> PendingSyncularMutation;
}

impl IntoSyncularMutation for PendingSyncularMutation {
    fn into_syncular_mutation(self) -> PendingSyncularMutation {
        self
    }
}

impl IntoSyncularMutation for SyncOperation {
    fn into_syncular_mutation(self) -> PendingSyncularMutation {
        PendingSyncularMutation {
            kind: if self.op == "delete" {
                SyncularMutationKind::Delete
            } else {
                SyncularMutationKind::Upsert
            },
            table: self.table,
            row_id: self.row_id,
            payload: self.payload,
            base_version: self.base_version,
            local_row: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationReceipt {
    pub commit_id: String,
    pub client_commit_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationCommit<R> {
    pub result: R,
    pub commit: MutationReceipt,
}

#[derive(Debug, Default)]
pub struct SyncularMutationBatch {
    mutations: Vec<PendingSyncularMutation>,
}

impl SyncularMutationBatch {
    pub fn new() -> Self {
        Self {
            mutations: Vec::new(),
        }
    }

    pub fn push<M>(&mut self, mutation: M) -> String
    where
        M: IntoSyncularMutation,
    {
        let mutation = mutation.into_syncular_mutation();
        let row_id = mutation.row_id.clone();
        self.mutations.push(mutation);
        row_id
    }

    pub fn is_empty(&self) -> bool {
        self.mutations.is_empty()
    }

    pub fn into_mutations(self) -> Vec<PendingSyncularMutation> {
        self.mutations
    }
}

pub fn random_syncular_id() -> String {
    Uuid::new_v4().to_string()
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
    pub server_version: Option<i64>,
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
    pub commits: Vec<SyncCommit>,
    pub snapshots: Option<Vec<SyncSnapshot>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCommit {
    #[serde(rename = "commitSeq")]
    pub commit_seq: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "actorId")]
    pub actor_id: String,
    #[serde(rename = "commitDigest", skip_serializing_if = "Option::is_none")]
    pub commit_digest: Option<String>,
    #[serde(rename = "commitChainRoot", skip_serializing_if = "Option::is_none")]
    pub commit_chain_root: Option<String>,
    pub changes: Vec<SyncChange>,
}

pub fn validate_pull_commit_integrity_metadata(response: &PullResponse) -> Result<()> {
    for subscription in &response.subscriptions {
        let mut previous_integrity_commit_seq = None;
        for commit in &subscription.commits {
            validate_commit_integrity_metadata(&subscription.id, commit)?;
            if commit.commit_digest.is_some() {
                if let Some(previous) = previous_integrity_commit_seq {
                    if commit.commit_seq <= previous {
                        return Err(SyncularError::protocol_message(format!(
                            "subscription {} integrity-bearing commit sequence must be strictly increasing: {} after {}",
                            subscription.id, commit.commit_seq, previous
                        )));
                    }
                }
                previous_integrity_commit_seq = Some(commit.commit_seq);
            }
        }
    }
    Ok(())
}

pub fn validate_pull_snapshot_manifests(response: &PullResponse) -> Result<()> {
    for subscription in &response.subscriptions {
        let Some(snapshots) = &subscription.snapshots else {
            continue;
        };
        for snapshot in snapshots {
            validate_snapshot_manifest(&subscription.id, snapshot)?;
        }
    }
    Ok(())
}

fn validate_snapshot_manifest(subscription_id: &str, snapshot: &SyncSnapshot) -> Result<()> {
    let chunks = snapshot.chunks.as_deref().unwrap_or(&[]);
    if chunks.is_empty() {
        if snapshot.manifest.is_some() {
            return Err(SyncularError::protocol_message(format!(
                "subscription {subscription_id} snapshot {} has manifest without chunk refs",
                snapshot.table
            )));
        }
        return Ok(());
    }

    let Some(manifest) = &snapshot.manifest else {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} chunked snapshot {} is missing manifest",
            snapshot.table
        )));
    };

    if manifest.version != SNAPSHOT_MANIFEST_VERSION {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} snapshot {} has unsupported manifest version {}",
            snapshot.table, manifest.version
        )));
    }
    validate_commit_integrity_hex(
        "snapshot manifest digest",
        subscription_id,
        manifest.as_of_commit_seq,
        &manifest.digest,
    )?;
    validate_commit_integrity_hex(
        "snapshot scope digest",
        subscription_id,
        manifest.as_of_commit_seq,
        &manifest.scope_digest,
    )?;
    if manifest.table != snapshot.table {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} snapshot manifest table mismatch: {} != {}",
            manifest.table, snapshot.table
        )));
    }
    if manifest.is_first_page != snapshot.is_first_page
        || manifest.is_last_page != snapshot.is_last_page
    {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} snapshot {} manifest page flags do not match snapshot",
            snapshot.table
        )));
    }
    if let Some(bootstrap_state_after) = &snapshot.bootstrap_state_after {
        if bootstrap_state_after.as_of_commit_seq != manifest.as_of_commit_seq {
            return Err(SyncularError::protocol_message(format!(
                "subscription {subscription_id} snapshot {} manifest asOfCommitSeq does not match bootstrapStateAfter",
                snapshot.table
            )));
        }
    }
    if manifest.chunks.len() != chunks.len() {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} snapshot {} manifest chunk count does not match chunk refs",
            snapshot.table
        )));
    }
    for (index, (manifest_chunk, chunk)) in manifest.chunks.iter().zip(chunks).enumerate() {
        if manifest_chunk.id != chunk.id
            || manifest_chunk.byte_length != chunk.byte_length
            || manifest_chunk.sha256 != chunk.sha256
            || manifest_chunk.encoding != chunk.encoding
            || manifest_chunk.compression != chunk.compression
        {
            return Err(SyncularError::protocol_message(format!(
                "subscription {subscription_id} snapshot {} manifest chunk {index} does not match chunk ref",
                snapshot.table
            )));
        }
    }

    let actual_digest = snapshot_manifest_digest(manifest)?;
    if actual_digest != manifest.digest {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} snapshot {} manifest digest mismatch: expected {}, got {}",
            snapshot.table, manifest.digest, actual_digest
        )));
    }
    Ok(())
}

fn validate_commit_integrity_metadata(subscription_id: &str, commit: &SyncCommit) -> Result<()> {
    match (&commit.commit_digest, &commit.commit_chain_root) {
        (None, None) => Ok(()),
        (Some(commit_digest), Some(commit_chain_root)) => {
            validate_commit_integrity_hex(
                "commitDigest",
                subscription_id,
                commit.commit_seq,
                commit_digest,
            )?;
            validate_commit_integrity_hex(
                "commitChainRoot",
                subscription_id,
                commit.commit_seq,
                commit_chain_root,
            )
        }
        _ => Err(SyncularError::protocol_message(format!(
            "subscription {} commit {} integrity metadata must include both commitDigest and commitChainRoot",
            subscription_id, commit.commit_seq
        ))),
    }
}

fn validate_commit_integrity_hex(
    label: &str,
    subscription_id: &str,
    commit_seq: i64,
    value: &str,
) -> Result<()> {
    if value.len() != COMMIT_INTEGRITY_HEX_LENGTH
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SyncularError::protocol_message(format!(
            "subscription {subscription_id} commit {commit_seq} {label} must be a lowercase 64-character SHA-256 hex string"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChange {
    pub table: String,
    pub row_id: String,
    pub op: String,
    pub row_json: Option<Value>,
    pub row_version: Option<i64>,
    pub scopes: Map<String, Value>,
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

pub fn snapshot_manifest_digest(manifest: &SnapshotManifest) -> Result<String> {
    if manifest.row_limit < 1 {
        return Err(SyncularError::protocol_message(format!(
            "snapshot manifest rowLimit must be positive: {}",
            manifest.row_limit
        )));
    }
    for chunk in &manifest.chunks {
        if chunk.byte_length < 0 {
            return Err(SyncularError::protocol_message(format!(
                "snapshot manifest chunk byteLength must be non-negative: {}",
                chunk.byte_length
            )));
        }
    }
    Ok(hex::encode(Sha256::digest(
        snapshot_manifest_digest_payload(manifest),
    )))
}

fn snapshot_manifest_digest_payload(manifest: &SnapshotManifest) -> String {
    let mut parts = Vec::with_capacity(10 + manifest.chunks.len() * 6);
    parts.push("syncular.snapshot-manifest.v1".to_string());
    append_manifest_int_field(&mut parts, "version", manifest.version.into());
    append_manifest_string_field(&mut parts, "table", &manifest.table);
    append_manifest_int_field(&mut parts, "asOfCommitSeq", manifest.as_of_commit_seq);
    append_manifest_string_field(&mut parts, "scopeDigest", &manifest.scope_digest);
    append_manifest_nullable_string_field(&mut parts, "rowCursor", manifest.row_cursor.as_deref());
    append_manifest_int_field(&mut parts, "rowLimit", manifest.row_limit);
    append_manifest_nullable_string_field(
        &mut parts,
        "nextRowCursor",
        manifest.next_row_cursor.as_deref(),
    );
    append_manifest_bool_field(&mut parts, "isFirstPage", manifest.is_first_page);
    append_manifest_bool_field(&mut parts, "isLastPage", manifest.is_last_page);
    append_manifest_int_field(&mut parts, "chunkCount", manifest.chunks.len() as i64);

    for (index, chunk) in manifest.chunks.iter().enumerate() {
        append_manifest_int_field(&mut parts, &format!("chunk.{index}.index"), index as i64);
        append_manifest_string_field(&mut parts, &format!("chunk.{index}.id"), &chunk.id);
        append_manifest_int_field(
            &mut parts,
            &format!("chunk.{index}.byteLength"),
            chunk.byte_length,
        );
        append_manifest_string_field(&mut parts, &format!("chunk.{index}.sha256"), &chunk.sha256);
        append_manifest_string_field(
            &mut parts,
            &format!("chunk.{index}.encoding"),
            &chunk.encoding,
        );
        append_manifest_string_field(
            &mut parts,
            &format!("chunk.{index}.compression"),
            &chunk.compression,
        );
    }

    format!("{}\n", parts.join("\n"))
}

fn append_manifest_string_field(parts: &mut Vec<String>, name: &str, value: &str) {
    parts.push(format!("{name}:s:{}:{value}", value.len()));
}

fn append_manifest_nullable_string_field(parts: &mut Vec<String>, name: &str, value: Option<&str>) {
    match value {
        Some(value) => append_manifest_string_field(parts, name, value),
        None => parts.push(format!("{name}:n")),
    }
}

fn append_manifest_int_field(parts: &mut Vec<String>, name: &str, value: i64) {
    parts.push(format!("{name}:i:{value}"));
}

fn append_manifest_bool_field(parts: &mut Vec<String>, name: &str, value: bool) {
    parts.push(format!("{name}:b:{}", if value { 1 } else { 0 }));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRef {
    pub hash: String,
    pub size: i64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub encrypted: bool,
    #[serde(rename = "keyId", skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUploadInitRequest {
    pub hash: String,
    pub size: i64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUploadInitResponse {
    pub exists: bool,
    #[serde(rename = "uploadId", skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    #[serde(rename = "uploadUrl", skip_serializing_if = "Option::is_none")]
    pub upload_url: Option<String>,
    #[serde(rename = "uploadMethod", skip_serializing_if = "Option::is_none")]
    pub upload_method: Option<String>,
    #[serde(rename = "uploadHeaders", default)]
    pub upload_headers: std::collections::BTreeMap<String, String>,
    #[serde(rename = "chunkSize", skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUploadCompleteResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobDownloadUrlResponse {
    pub url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

pub fn blob_hash(data: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(data)))
}

pub fn blob_hash_reader(mut reader: impl Read) -> Result<(String, i64)> {
    let mut hasher = Sha256::new();
    let mut size = 0i64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(i64::try_from(read).map_err(|_| {
                SyncularError::protocol_message("blob chunk is too large for size metadata")
            })?)
            .ok_or_else(|| SyncularError::protocol_message("blob is too large"))?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("sha256:{}", hex::encode(hasher.finalize())), size))
}

pub fn validate_blob_hash(hash: &str) -> Result<()> {
    let Some(hex) = hash.strip_prefix("sha256:") else {
        return Err(SyncularError::protocol_message(format!(
            "invalid blob hash: {hash}"
        )));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SyncularError::protocol_message(format!(
            "invalid blob hash: {hash}"
        )));
    }
    Ok(())
}

pub fn validate_blob_bytes(blob: &BlobRef, data: &[u8]) -> Result<()> {
    validate_blob_hash(&blob.hash)?;
    let actual_size = i64::try_from(data.len())
        .map_err(|_| SyncularError::protocol_message("blob is too large"))?;
    validate_blob_digest(blob, &blob_hash(data), actual_size)
}

pub fn validate_blob_digest(blob: &BlobRef, actual_hash: &str, actual_size: i64) -> Result<()> {
    validate_blob_hash(&blob.hash)?;
    if blob.size != actual_size {
        return Err(SyncularError::protocol_message(format!(
            "blob size mismatch: expected {}, got {}",
            blob.size, actual_size
        )));
    }
    if actual_hash != blob.hash {
        return Err(SyncularError::protocol_message(format!(
            "blob hash mismatch: expected {}, got {}",
            blob.hash, actual_hash
        )));
    }
    Ok(())
}
