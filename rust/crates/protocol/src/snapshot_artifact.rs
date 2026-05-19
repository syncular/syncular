use crate::integrity::validate_commit_integrity_hex;
use crate::{ProtocolError, Result, SNAPSHOT_CHUNK_COMPRESSION_GZIP};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const SNAPSHOT_ARTIFACT_COMPRESSION_NONE: &str = "none";
pub const SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION: i32 = 1;
pub const SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1: &str = "sqlite-snapshot-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopedSnapshotArtifactManifest {
    pub version: i32,
    #[serde(rename = "artifactKind")]
    pub artifact_kind: String,
    pub digest: String,
    #[serde(rename = "partitionId")]
    pub partition_id: String,
    #[serde(rename = "subscriptionId")]
    pub subscription_id: String,
    pub table: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "asOfCommitSeq")]
    pub as_of_commit_seq: i64,
    #[serde(rename = "scopeDigest")]
    pub scope_digest: String,
    #[serde(rename = "rowCursor")]
    pub row_cursor: Option<String>,
    #[serde(rename = "rowLimit")]
    pub row_limit: i64,
    #[serde(rename = "rowCount")]
    pub row_count: i64,
    #[serde(rename = "nextRowCursor")]
    pub next_row_cursor: Option<String>,
    #[serde(rename = "isFirstPage")]
    pub is_first_page: bool,
    #[serde(rename = "isLastPage")]
    pub is_last_page: bool,
    pub compression: String,
    #[serde(rename = "byteLength")]
    pub byte_length: i64,
    pub sha256: String,
    #[serde(rename = "featureSet", default)]
    pub feature_set: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopedSnapshotArtifactRef {
    pub id: String,
    #[serde(rename = "byteLength")]
    pub byte_length: i64,
    pub sha256: String,
    #[serde(rename = "manifestDigest")]
    pub manifest_digest: String,
    #[serde(rename = "artifactKind")]
    pub artifact_kind: String,
    pub compression: String,
    #[serde(rename = "rowCount")]
    pub row_count: i64,
    #[serde(rename = "nextRowCursor")]
    pub next_row_cursor: Option<String>,
    #[serde(rename = "isFirstPage")]
    pub is_first_page: bool,
    #[serde(rename = "isLastPage")]
    pub is_last_page: bool,
    pub manifest: ScopedSnapshotArtifactManifest,
}

pub fn validate_scoped_snapshot_artifact_manifest(
    manifest: &ScopedSnapshotArtifactManifest,
) -> Result<()> {
    if manifest.version != SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION {
        return Err(ProtocolError::message(format!(
            "unsupported scoped snapshot artifact manifest version {}",
            manifest.version
        )));
    }
    if manifest.artifact_kind != SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1 {
        return Err(ProtocolError::message(format!(
            "unsupported scoped snapshot artifact kind {}",
            manifest.artifact_kind
        )));
    }
    if manifest.compression != SNAPSHOT_ARTIFACT_COMPRESSION_NONE
        && manifest.compression != SNAPSHOT_CHUNK_COMPRESSION_GZIP
    {
        return Err(ProtocolError::message(format!(
            "unsupported scoped snapshot artifact compression {}",
            manifest.compression
        )));
    }
    if manifest.row_limit < 1 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact rowLimit must be positive: {}",
            manifest.row_limit
        )));
    }
    if manifest.row_count < 0 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact rowCount must be non-negative: {}",
            manifest.row_count
        )));
    }
    if manifest.byte_length < 0 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact byteLength must be non-negative: {}",
            manifest.byte_length
        )));
    }
    validate_commit_integrity_hex(
        "scoped snapshot artifact digest",
        &manifest.subscription_id,
        manifest.as_of_commit_seq,
        &manifest.digest,
    )?;
    validate_commit_integrity_hex(
        "scoped snapshot artifact scope digest",
        &manifest.subscription_id,
        manifest.as_of_commit_seq,
        &manifest.scope_digest,
    )?;
    validate_commit_integrity_hex(
        "scoped snapshot artifact sha256",
        &manifest.subscription_id,
        manifest.as_of_commit_seq,
        &manifest.sha256,
    )?;

    let actual_digest = scoped_snapshot_artifact_manifest_digest(manifest)?;
    if actual_digest != manifest.digest {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact digest mismatch: expected {}, got {}",
            manifest.digest, actual_digest
        )));
    }
    Ok(())
}

pub fn validate_scoped_snapshot_artifact_ref(artifact: &ScopedSnapshotArtifactRef) -> Result<()> {
    if artifact.id.is_empty() {
        return Err(ProtocolError::message(
            "scoped snapshot artifact id must not be empty",
        ));
    }
    validate_scoped_snapshot_artifact_manifest(&artifact.manifest)?;
    if artifact.manifest_digest != artifact.manifest.digest {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact ref manifest digest mismatch: {} != {}",
            artifact.manifest_digest, artifact.manifest.digest
        )));
    }
    if artifact.artifact_kind != artifact.manifest.artifact_kind {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact ref kind mismatch: {} != {}",
            artifact.artifact_kind, artifact.manifest.artifact_kind
        )));
    }
    if artifact.compression != artifact.manifest.compression {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact ref compression mismatch: {} != {}",
            artifact.compression, artifact.manifest.compression
        )));
    }
    if artifact.byte_length != artifact.manifest.byte_length {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact ref byte length mismatch: {} != {}",
            artifact.byte_length, artifact.manifest.byte_length
        )));
    }
    if artifact.sha256 != artifact.manifest.sha256 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact ref sha256 mismatch: {} != {}",
            artifact.sha256, artifact.manifest.sha256
        )));
    }
    if artifact.row_count != artifact.manifest.row_count {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact ref row count mismatch: {} != {}",
            artifact.row_count, artifact.manifest.row_count
        )));
    }
    if artifact.next_row_cursor != artifact.manifest.next_row_cursor {
        return Err(ProtocolError::message(
            "scoped snapshot artifact ref next cursor mismatch",
        ));
    }
    if artifact.is_first_page != artifact.manifest.is_first_page {
        return Err(ProtocolError::message(
            "scoped snapshot artifact ref first-page flag mismatch",
        ));
    }
    if artifact.is_last_page != artifact.manifest.is_last_page {
        return Err(ProtocolError::message(
            "scoped snapshot artifact ref last-page flag mismatch",
        ));
    }
    Ok(())
}

pub fn scoped_snapshot_artifact_manifest_digest(
    manifest: &ScopedSnapshotArtifactManifest,
) -> Result<String> {
    if manifest.row_limit < 1 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact rowLimit must be positive: {}",
            manifest.row_limit
        )));
    }
    if manifest.row_count < 0 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact rowCount must be non-negative: {}",
            manifest.row_count
        )));
    }
    if manifest.byte_length < 0 {
        return Err(ProtocolError::message(format!(
            "scoped snapshot artifact byteLength must be non-negative: {}",
            manifest.byte_length
        )));
    }
    Ok(hex::encode(Sha256::digest(
        scoped_snapshot_artifact_digest_payload(manifest),
    )))
}

fn scoped_snapshot_artifact_digest_payload(manifest: &ScopedSnapshotArtifactManifest) -> String {
    let feature_set = normalized_feature_set(&manifest.feature_set);
    let mut parts = Vec::with_capacity(19 + feature_set.len() * 2);
    parts.push("syncular.scoped-snapshot-artifact.v1".to_string());
    append_manifest_int_field(&mut parts, "version", manifest.version.into());
    append_manifest_string_field(&mut parts, "artifactKind", &manifest.artifact_kind);
    append_manifest_string_field(&mut parts, "partitionId", &manifest.partition_id);
    append_manifest_string_field(&mut parts, "subscriptionId", &manifest.subscription_id);
    append_manifest_string_field(&mut parts, "table", &manifest.table);
    append_manifest_string_field(&mut parts, "schemaVersion", &manifest.schema_version);
    append_manifest_int_field(&mut parts, "asOfCommitSeq", manifest.as_of_commit_seq);
    append_manifest_string_field(&mut parts, "scopeDigest", &manifest.scope_digest);
    append_manifest_nullable_string_field(&mut parts, "rowCursor", manifest.row_cursor.as_deref());
    append_manifest_int_field(&mut parts, "rowLimit", manifest.row_limit);
    append_manifest_int_field(&mut parts, "rowCount", manifest.row_count);
    append_manifest_nullable_string_field(
        &mut parts,
        "nextRowCursor",
        manifest.next_row_cursor.as_deref(),
    );
    append_manifest_bool_field(&mut parts, "isFirstPage", manifest.is_first_page);
    append_manifest_bool_field(&mut parts, "isLastPage", manifest.is_last_page);
    append_manifest_string_field(&mut parts, "compression", &manifest.compression);
    append_manifest_int_field(&mut parts, "byteLength", manifest.byte_length);
    append_manifest_string_field(&mut parts, "sha256", &manifest.sha256);
    append_manifest_int_field(&mut parts, "featureCount", feature_set.len() as i64);

    for (index, feature) in feature_set.iter().enumerate() {
        append_manifest_int_field(&mut parts, &format!("feature.{index}.index"), index as i64);
        append_manifest_string_field(&mut parts, &format!("feature.{index}.name"), feature);
    }

    format!("{}\n", parts.join("\n"))
}

fn normalized_feature_set(feature_set: &[String]) -> Vec<String> {
    feature_set
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(feature_set: Vec<String>) -> ScopedSnapshotArtifactManifest {
        ScopedSnapshotArtifactManifest {
            version: SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
            artifact_kind: SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1.to_string(),
            digest: String::new(),
            partition_id: "partition-1".to_string(),
            subscription_id: "sub-tasks".to_string(),
            table: "tasks".to_string(),
            schema_version: "7".to_string(),
            as_of_commit_seq: 42,
            scope_digest: "a".repeat(64),
            row_cursor: None,
            row_limit: 50_000,
            row_count: 12_345,
            next_row_cursor: Some("task-12345".to_string()),
            is_first_page: true,
            is_last_page: false,
            compression: SNAPSHOT_ARTIFACT_COMPRESSION_NONE.to_string(),
            byte_length: 4096,
            sha256: "b".repeat(64),
            feature_set,
        }
    }

    #[test]
    fn validates_scoped_snapshot_artifact_manifest() {
        let mut manifest = artifact(vec![
            "crdt-yjs".to_string(),
            "blobs".to_string(),
            "crdt-yjs".to_string(),
        ]);
        manifest.digest = scoped_snapshot_artifact_manifest_digest(&manifest).expect("digest");

        validate_scoped_snapshot_artifact_manifest(&manifest).expect("valid artifact manifest");

        let mut reordered = artifact(vec!["blobs".to_string(), "crdt-yjs".to_string()]);
        reordered.digest = scoped_snapshot_artifact_manifest_digest(&reordered).expect("digest");
        assert_eq!(manifest.digest, reordered.digest);
    }

    #[test]
    fn rejects_scope_mismatch() {
        let mut manifest = artifact(vec!["blobs".to_string()]);
        manifest.digest = scoped_snapshot_artifact_manifest_digest(&manifest).expect("digest");
        manifest.scope_digest = "c".repeat(64);

        let error = validate_scoped_snapshot_artifact_manifest(&manifest)
            .expect_err("scope mismatch rejects");
        assert!(
            error
                .to_string()
                .contains("scoped snapshot artifact digest mismatch"),
            "{error}"
        );
    }

    #[test]
    fn validates_scoped_snapshot_artifact_refs() {
        let mut manifest = artifact(vec!["blobs".to_string()]);
        manifest.digest = scoped_snapshot_artifact_manifest_digest(&manifest).expect("digest");
        let artifact = ScopedSnapshotArtifactRef {
            id: "artifact-1".to_string(),
            byte_length: manifest.byte_length,
            sha256: manifest.sha256.clone(),
            manifest_digest: manifest.digest.clone(),
            artifact_kind: manifest.artifact_kind.clone(),
            compression: manifest.compression.clone(),
            row_count: manifest.row_count,
            next_row_cursor: manifest.next_row_cursor.clone(),
            is_first_page: manifest.is_first_page,
            is_last_page: manifest.is_last_page,
            manifest,
        };

        validate_scoped_snapshot_artifact_ref(&artifact).expect("valid artifact ref");

        let mut mismatched = artifact.clone();
        mismatched.sha256 = "c".repeat(64);
        assert!(validate_scoped_snapshot_artifact_ref(&mismatched).is_err());
    }
}
