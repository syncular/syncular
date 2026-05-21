use crate::error::{Result, SyncularError};
use crate::limits::{
    MAX_BLOB_PAYLOAD_BYTES, MAX_MUTATION_BATCH_JSON_BYTES, MAX_MUTATION_LOCAL_ROW_JSON_BYTES,
    MAX_MUTATION_OPERATION_JSON_BYTES, MAX_OUTBOX_OPERATIONS_JSON_BYTES,
    MAX_REALTIME_SYNC_PACK_BYTES, MAX_SNAPSHOT_ARTIFACT_COMPRESSED_BYTES,
    MAX_SNAPSHOT_ARTIFACT_DECOMPRESSED_BYTES, MAX_SNAPSHOT_CHUNK_COMPRESSED_BYTES,
    MAX_SNAPSHOT_CHUNK_DECOMPRESSED_BYTES, MAX_WEBSOCKET_TEXT_FRAME_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
pub use syncular_protocol::{
    validate_scoped_snapshot_artifact_ref, AuthLeaseCapabilities, AuthLeaseIssueRequest,
    AuthLeaseIssueResponse, AuthLeasePayload, AuthLeaseProtectedHeader, AuthLeaseProvenance,
    AuthLeaseScope, AuthLeaseValidationResult, BlobDownloadUrlResponse, BlobRef,
    BlobUploadCompleteResponse, BlobUploadInitRequest, BlobUploadInitResponse, BootstrapState,
    CombinedRequest, CombinedResponse, CrdtStateVectorHint, OperationResult, PullRequest,
    PullResponse, PushBatchRequest, PushBatchResponse, PushCommitRequest, PushCommitResponse,
    RealtimePresenceEntry, RealtimePresenceEvent, RealtimePresenceRequest, RealtimePushRequest,
    RealtimePushResponseData, RealtimeServerMessage, ScopeValues, ScopedSnapshotArtifactManifest,
    ScopedSnapshotArtifactRef, SnapshotArtifactsRequest, SnapshotChunkRef, SnapshotManifest,
    SnapshotManifestChunkRef, SubscriptionIntegrity, SubscriptionRequest, SubscriptionResponse,
    SyncChange, SyncCommit, SyncOperation, SyncSnapshot, VerifiedCommitRoot, AUTH_LEASE_ALG_ES256,
    AUTH_LEASE_CODE_BUSINESS_REJECTED, AUTH_LEASE_CODE_EXPIRED, AUTH_LEASE_CODE_INVALID,
    AUTH_LEASE_CODE_MISSING, AUTH_LEASE_CODE_SCHEMA_MISMATCH, AUTH_LEASE_CODE_SCOPE_MISMATCH,
    AUTH_LEASE_CODE_SCOPE_REVOKED, AUTH_LEASE_PROTOCOL_VERSION, AUTH_LEASE_TYP, AUTH_LEASE_VERSION,
    BINARY_SYNC_PACK_WIRE_VERSION, COMMIT_INTEGRITY_GENESIS_ROOT, COMMIT_INTEGRITY_HEX_LENGTH,
    REALTIME_CLIENT_MESSAGE_PRESENCE, REALTIME_CLIENT_MESSAGE_PUSH, REALTIME_SERVER_EVENT_PRESENCE,
    REALTIME_SERVER_EVENT_PUSH_RESPONSE, REALTIME_SERVER_EVENT_SYNC,
    SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1, SNAPSHOT_CHUNK_COMPRESSION_GZIP,
    SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1, SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
    SNAPSHOT_MANIFEST_VERSION, SYNC_PACK_CONTENT_TYPE, SYNC_PACK_ENCODING_BINARY_V1,
    SYNC_PACK_ENCODING_JSON_V1, WIRE_COMMIT_CHAIN_ROOT_VERSION, WIRE_COMMIT_DIGEST_VERSION,
};
use uuid::Uuid;

pub fn validate_sqlite_snapshot_artifact_for_apply(
    artifact: &ScopedSnapshotArtifactRef,
    subscription_id: &str,
    table: &str,
) -> Result<()> {
    validate_scoped_snapshot_artifact_ref(artifact)?;
    validate_snapshot_artifact_ref_size(artifact)?;
    if artifact.artifact_kind != SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1 {
        return Err(SyncularError::protocol_message(format!(
            "unsupported snapshot artifact kind {}",
            artifact.artifact_kind
        )));
    }
    if artifact.compression != SNAPSHOT_CHUNK_COMPRESSION_GZIP {
        return Err(SyncularError::protocol_message(format!(
            "unsupported snapshot artifact compression {}",
            artifact.compression
        )));
    }
    if artifact.manifest.subscription_id != subscription_id {
        return Err(SyncularError::protocol_message(format!(
            "snapshot artifact subscription mismatch: expected {}, got {}",
            subscription_id, artifact.manifest.subscription_id
        )));
    }
    if artifact.manifest.table != table {
        return Err(SyncularError::protocol_message(format!(
            "snapshot artifact table mismatch: expected {}, got {}",
            table, artifact.manifest.table
        )));
    }
    Ok(())
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

    pub fn mutations(&self) -> &[PendingSyncularMutation] {
        &self.mutations
    }

    pub fn into_mutations(self) -> Vec<PendingSyncularMutation> {
        self.mutations
    }
}

pub fn validate_mutation_json_input_size(
    operation_json: &str,
    local_row_json: Option<&str>,
) -> Result<()> {
    validate_payload_bytes(
        "maxMutationOperationJsonBytes",
        operation_json.len(),
        MAX_MUTATION_OPERATION_JSON_BYTES,
        "Syncular mutation operation JSON exceeds the configured limit",
    )?;
    if let Some(local_row_json) = local_row_json {
        validate_payload_bytes(
            "maxMutationLocalRowJsonBytes",
            local_row_json.len(),
            MAX_MUTATION_LOCAL_ROW_JSON_BYTES,
            "Syncular mutation local row JSON exceeds the configured limit",
        )?;
    }
    Ok(())
}

pub fn validate_mutation_batch_json_input_size(operations_json: &str) -> Result<()> {
    validate_payload_bytes(
        "maxMutationBatchJsonBytes",
        operations_json.len(),
        MAX_MUTATION_BATCH_JSON_BYTES,
        "Syncular mutation batch JSON exceeds the configured limit",
    )
}

pub fn validate_pending_mutation_batch_size(mutations: &[PendingSyncularMutation]) -> Result<()> {
    let bytes = serde_json::to_vec(mutations)?;
    validate_payload_bytes(
        "maxMutationBatchJsonBytes",
        bytes.len(),
        MAX_MUTATION_BATCH_JSON_BYTES,
        "Syncular typed mutation batch exceeds the configured limit",
    )
}

pub fn sync_operations_json_for_outbox(operations: &[SyncOperation]) -> Result<String> {
    let operations_json = serde_json::to_string(operations)?;
    validate_payload_bytes(
        "maxOutboxOperationsJsonBytes",
        operations_json.len(),
        MAX_OUTBOX_OPERATIONS_JSON_BYTES,
        "Syncular outbox operations JSON exceeds the configured limit",
    )?;
    Ok(operations_json)
}

pub fn validate_payload_bytes(
    limit: &'static str,
    observed: usize,
    max: usize,
    message: &'static str,
) -> Result<()> {
    if observed > max {
        return Err(SyncularError::limit_exceeded(limit, observed, max, message));
    }
    Ok(())
}

pub fn random_syncular_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn validate_pull_commit_integrity_metadata(response: &PullResponse) -> Result<()> {
    syncular_protocol::validate_pull_commit_integrity_metadata(response).map_err(Into::into)
}

pub fn verify_subscription_commit_integrity(
    subscription_id: &str,
    stored_root: Option<&str>,
    integrity: Option<&SubscriptionIntegrity>,
    commits: &[SyncCommit],
) -> Result<Option<VerifiedCommitRoot>> {
    syncular_protocol::verify_subscription_commit_integrity(
        subscription_id,
        stored_root,
        integrity,
        commits,
    )
    .map_err(Into::into)
}

pub fn validate_pull_snapshot_manifests(response: &PullResponse) -> Result<()> {
    syncular_protocol::validate_pull_snapshot_manifests(response).map_err(SyncularError::from)?;
    for subscription in &response.subscriptions {
        if let Some(snapshots) = &subscription.snapshots {
            for snapshot in snapshots {
                if let Some(chunks) = &snapshot.chunks {
                    for chunk in chunks {
                        validate_snapshot_chunk_ref_size(chunk)?;
                    }
                }
                if let Some(artifacts) = &snapshot.artifacts {
                    for artifact in artifacts {
                        validate_snapshot_artifact_ref_size(artifact)?;
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn wire_commit_digest(
    partition_id: &str,
    subscription_id: &str,
    commit: &SyncCommit,
) -> Result<String> {
    syncular_protocol::wire_commit_digest(partition_id, subscription_id, commit).map_err(Into::into)
}

pub fn wire_commit_chain_root(
    partition_id: &str,
    subscription_id: &str,
    previous_chain_root: &str,
    commit_seq: i64,
    commit_digest: &str,
) -> Result<String> {
    syncular_protocol::wire_commit_chain_root(
        partition_id,
        subscription_id,
        previous_chain_root,
        commit_seq,
        commit_digest,
    )
    .map_err(Into::into)
}

pub fn wire_commit_chain_root_from_digest(
    partition_id: &str,
    subscription_id: &str,
    previous_chain_root: &str,
    commit_seq: i64,
    commit_digest: &str,
) -> Result<String> {
    syncular_protocol::wire_commit_chain_root_from_digest(
        partition_id,
        subscription_id,
        previous_chain_root,
        commit_seq,
        commit_digest,
    )
    .map_err(Into::into)
}

pub fn snapshot_manifest_digest(manifest: &SnapshotManifest) -> Result<String> {
    syncular_protocol::snapshot_manifest_digest(manifest).map_err(Into::into)
}

pub fn blob_hash(data: &[u8]) -> String {
    syncular_protocol::blob_hash(data)
}

pub fn normalize_blob_mime_type(mime_type: &str) -> String {
    syncular_protocol::normalize_blob_mime_type(mime_type)
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
        validate_blob_size_bytes(size)?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("sha256:{}", hex::encode(hasher.finalize())), size))
}

pub fn validate_blob_hash(hash: &str) -> Result<()> {
    syncular_protocol::validate_blob_hash(hash).map_err(Into::into)
}

pub fn validate_blob_size_bytes(size: i64) -> Result<()> {
    if size < 0 {
        return Err(SyncularError::protocol_message(
            "blob size cannot be negative",
        ));
    }
    if size > MAX_BLOB_PAYLOAD_BYTES {
        return Err(SyncularError::limit_exceeded(
            "maxBlobPayloadBytes",
            usize::try_from(size).unwrap_or(usize::MAX),
            usize::try_from(MAX_BLOB_PAYLOAD_BYTES).unwrap_or(usize::MAX),
            "Syncular blob payload exceeds the configured limit",
        ));
    }
    Ok(())
}

pub fn validate_blob_ref_size(blob: &BlobRef) -> Result<()> {
    validate_blob_size_bytes(blob.size)
}

pub fn validate_blob_bytes(blob: &BlobRef, data: &[u8]) -> Result<()> {
    validate_payload_bytes(
        "maxBlobPayloadBytes",
        data.len(),
        usize::try_from(MAX_BLOB_PAYLOAD_BYTES).unwrap_or(usize::MAX),
        "Syncular blob payload exceeds the configured limit",
    )?;
    validate_blob_ref_size(blob)?;
    syncular_protocol::validate_blob_bytes(blob, data).map_err(Into::into)
}

pub fn validate_blob_digest(blob: &BlobRef, actual_hash: &str, actual_size: i64) -> Result<()> {
    validate_blob_ref_size(blob)?;
    validate_blob_size_bytes(actual_size)?;
    syncular_protocol::validate_blob_digest(blob, actual_hash, actual_size).map_err(Into::into)
}

pub fn validate_snapshot_chunk_ref_size(chunk: &SnapshotChunkRef) -> Result<()> {
    validate_i64_payload_bytes(
        "maxSnapshotChunkCompressedBytes",
        chunk.byte_length,
        MAX_SNAPSHOT_CHUNK_COMPRESSED_BYTES,
        "Syncular snapshot chunk compressed payload exceeds the configured limit",
    )
}

pub fn validate_snapshot_chunk_compressed_bytes(
    chunk: &SnapshotChunkRef,
    bytes: &[u8],
) -> Result<()> {
    validate_snapshot_chunk_ref_size(chunk)?;
    validate_payload_bytes(
        "maxSnapshotChunkCompressedBytes",
        bytes.len(),
        usize::try_from(MAX_SNAPSHOT_CHUNK_COMPRESSED_BYTES).unwrap_or(usize::MAX),
        "Syncular snapshot chunk compressed payload exceeds the configured limit",
    )?;
    if bytes.len() as i64 != chunk.byte_length {
        return Err(SyncularError::protocol_message(format!(
            "snapshot chunk byte length mismatch: expected {}, got {}",
            chunk.byte_length,
            bytes.len()
        )));
    }
    Ok(())
}

pub fn validate_snapshot_chunk_decompressed_bytes(bytes: &[u8]) -> Result<()> {
    validate_payload_bytes(
        "maxSnapshotChunkDecompressedBytes",
        bytes.len(),
        MAX_SNAPSHOT_CHUNK_DECOMPRESSED_BYTES,
        "Syncular snapshot chunk decompressed payload exceeds the configured limit",
    )
}

pub fn validate_snapshot_artifact_ref_size(artifact: &ScopedSnapshotArtifactRef) -> Result<()> {
    validate_i64_payload_bytes(
        "maxSnapshotArtifactCompressedBytes",
        artifact.byte_length,
        MAX_SNAPSHOT_ARTIFACT_COMPRESSED_BYTES,
        "Syncular snapshot artifact compressed payload exceeds the configured limit",
    )
}

pub fn validate_snapshot_artifact_compressed_bytes(
    artifact: &ScopedSnapshotArtifactRef,
    bytes: &[u8],
) -> Result<()> {
    validate_snapshot_artifact_ref_size(artifact)?;
    validate_payload_bytes(
        "maxSnapshotArtifactCompressedBytes",
        bytes.len(),
        usize::try_from(MAX_SNAPSHOT_ARTIFACT_COMPRESSED_BYTES).unwrap_or(usize::MAX),
        "Syncular snapshot artifact compressed payload exceeds the configured limit",
    )?;
    if bytes.len() as i64 != artifact.byte_length {
        return Err(SyncularError::protocol_message(format!(
            "snapshot artifact byte length mismatch: expected {}, got {}",
            artifact.byte_length,
            bytes.len()
        )));
    }
    Ok(())
}

pub fn validate_snapshot_artifact_decompressed_bytes(bytes: &[u8]) -> Result<()> {
    validate_payload_bytes(
        "maxSnapshotArtifactDecompressedBytes",
        bytes.len(),
        MAX_SNAPSHOT_ARTIFACT_DECOMPRESSED_BYTES,
        "Syncular snapshot artifact decompressed payload exceeds the configured limit",
    )
}

pub fn validate_realtime_sync_pack_bytes(bytes: &[u8]) -> Result<()> {
    validate_payload_bytes(
        "maxRealtimeSyncPackBytes",
        bytes.len(),
        MAX_REALTIME_SYNC_PACK_BYTES,
        "Syncular realtime sync-pack payload exceeds the configured limit",
    )
}

pub fn validate_websocket_text_frame_size(text: &str) -> Result<()> {
    validate_payload_bytes(
        "maxWebsocketTextFrameBytes",
        text.len(),
        MAX_WEBSOCKET_TEXT_FRAME_BYTES,
        "Syncular websocket text frame exceeds the configured limit",
    )
}

fn validate_i64_payload_bytes(
    limit: &'static str,
    observed: i64,
    max: i64,
    message: &'static str,
) -> Result<()> {
    if observed < 0 {
        return Err(SyncularError::protocol_message(format!(
            "{limit} observed byte length cannot be negative"
        )));
    }
    if observed > max {
        return Err(SyncularError::limit_exceeded(
            limit,
            usize::try_from(observed).unwrap_or(usize::MAX),
            usize::try_from(max).unwrap_or(usize::MAX),
            message,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_blob_ref_returns_stable_limit_error() {
        let blob = BlobRef {
            hash: format!("sha256:{}", "0".repeat(64)),
            size: MAX_BLOB_PAYLOAD_BYTES + 1,
            mime_type: "application/octet-stream".to_string(),
            encrypted: false,
            key_id: None,
        };

        let err = validate_blob_digest(&blob, &blob.hash, blob.size).unwrap_err();
        let classification = err.classification();
        assert_eq!(classification.code, "runtime.limit_exceeded");
        assert_eq!(classification.category, "limit-exceeded");
        assert_eq!(classification.recommended_action, "reduceInput");
        assert!(err.message_text().contains("maxBlobPayloadBytes"));
    }

    #[test]
    fn oversized_snapshot_refs_return_stable_limit_errors() {
        let chunk = SnapshotChunkRef {
            id: "chunk-1".to_string(),
            byte_length: MAX_SNAPSHOT_CHUNK_COMPRESSED_BYTES + 1,
            sha256: "0".repeat(64),
            encoding: SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1.to_string(),
            compression: SNAPSHOT_CHUNK_COMPRESSION_GZIP.to_string(),
        };
        let chunk_err = validate_snapshot_chunk_ref_size(&chunk).unwrap_err();
        assert_eq!(chunk_err.classification().code, "runtime.limit_exceeded");
        assert!(chunk_err
            .message_text()
            .contains("maxSnapshotChunkCompressedBytes"));

        let mut manifest = ScopedSnapshotArtifactManifest {
            version: syncular_protocol::SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
            artifact_kind: SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1.to_string(),
            digest: "artifact-digest".to_string(),
            partition_id: "partition-1".to_string(),
            subscription_id: "sub-1".to_string(),
            table: "tasks".to_string(),
            schema_version: "1".to_string(),
            as_of_commit_seq: 1,
            scope_digest: "scope-digest".to_string(),
            row_cursor: None,
            byte_length: MAX_SNAPSHOT_ARTIFACT_COMPRESSED_BYTES + 1,
            sha256: "0".repeat(64),
            compression: SNAPSHOT_CHUNK_COMPRESSION_GZIP.to_string(),
            row_count: 1,
            row_limit: 1,
            next_row_cursor: None,
            is_first_page: true,
            is_last_page: true,
            feature_set: Vec::new(),
        };
        manifest.digest =
            syncular_protocol::scoped_snapshot_artifact_manifest_digest(&manifest).expect("digest");
        let artifact = ScopedSnapshotArtifactRef {
            id: "artifact-1".to_string(),
            manifest_digest: manifest.digest.clone(),
            byte_length: manifest.byte_length,
            sha256: manifest.sha256.clone(),
            artifact_kind: manifest.artifact_kind.clone(),
            compression: manifest.compression.clone(),
            row_count: manifest.row_count,
            next_row_cursor: manifest.next_row_cursor.clone(),
            is_first_page: manifest.is_first_page,
            is_last_page: manifest.is_last_page,
            manifest,
        };
        let artifact_err = validate_snapshot_artifact_ref_size(&artifact).unwrap_err();
        assert_eq!(artifact_err.classification().code, "runtime.limit_exceeded");
        assert!(artifact_err
            .message_text()
            .contains("maxSnapshotArtifactCompressedBytes"));
    }

    #[test]
    fn oversized_realtime_payloads_return_stable_limit_errors() {
        let sync_pack = vec![0u8; MAX_REALTIME_SYNC_PACK_BYTES + 1];
        let sync_pack_err = validate_realtime_sync_pack_bytes(&sync_pack).unwrap_err();
        assert_eq!(
            sync_pack_err.classification().code,
            "runtime.limit_exceeded"
        );
        assert!(sync_pack_err
            .message_text()
            .contains("maxRealtimeSyncPackBytes"));

        let frame = "x".repeat(MAX_WEBSOCKET_TEXT_FRAME_BYTES + 1);
        let frame_err = validate_websocket_text_frame_size(&frame).unwrap_err();
        assert_eq!(frame_err.classification().code, "runtime.limit_exceeded");
        assert!(frame_err
            .message_text()
            .contains("maxWebsocketTextFrameBytes"));
    }
}
