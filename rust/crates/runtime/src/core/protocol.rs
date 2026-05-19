use crate::error::{Result, SyncularError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
pub use syncular_protocol::{
    validate_scoped_snapshot_artifact_ref, BlobDownloadUrlResponse, BlobRef,
    BlobUploadCompleteResponse, BlobUploadInitRequest, BlobUploadInitResponse, BootstrapState,
    CombinedRequest, CombinedResponse, OperationResult, PullRequest, PullResponse,
    PushBatchRequest, PushBatchResponse, PushCommitRequest, PushCommitResponse,
    RealtimePresenceEntry, RealtimePresenceEvent, RealtimePresenceRequest, RealtimePushRequest,
    RealtimePushResponseData, RealtimeServerMessage, ScopeValues, ScopedSnapshotArtifactManifest,
    ScopedSnapshotArtifactRef, SnapshotArtifactsRequest, SnapshotChunkRef, SnapshotManifest,
    SnapshotManifestChunkRef, SubscriptionIntegrity, SubscriptionRequest, SubscriptionResponse,
    SyncChange, SyncCommit, SyncOperation, SyncSnapshot, VerifiedCommitRoot,
    BINARY_SYNC_PACK_WIRE_VERSION, COMMIT_INTEGRITY_GENESIS_ROOT, COMMIT_INTEGRITY_HEX_LENGTH,
    REALTIME_CLIENT_MESSAGE_PRESENCE, REALTIME_CLIENT_MESSAGE_PUSH, REALTIME_SERVER_EVENT_PRESENCE,
    REALTIME_SERVER_EVENT_PUSH_RESPONSE, REALTIME_SERVER_EVENT_SYNC,
    SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1, SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
    SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1, SNAPSHOT_CHUNK_ENCODING_JSON_ROW_FRAME_V1,
    SNAPSHOT_MANIFEST_VERSION, SYNC_PACK_CONTENT_TYPE, SYNC_PACK_ENCODING_BINARY_V1,
    SYNC_PACK_ENCODING_JSON_V1, WIRE_COMMIT_CHAIN_ROOT_VERSION, WIRE_COMMIT_DIGEST_VERSION,
};
use uuid::Uuid;

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
    syncular_protocol::validate_pull_snapshot_manifests(response).map_err(Into::into)
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
    syncular_protocol::validate_blob_hash(hash).map_err(Into::into)
}

pub fn validate_blob_bytes(blob: &BlobRef, data: &[u8]) -> Result<()> {
    syncular_protocol::validate_blob_bytes(blob, data).map_err(Into::into)
}

pub fn validate_blob_digest(blob: &BlobRef, actual_hash: &str, actual_size: i64) -> Result<()> {
    syncular_protocol::validate_blob_digest(blob, actual_hash, actual_size).map_err(Into::into)
}
