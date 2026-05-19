use crate::integrity::validate_commit_integrity_hex;
use crate::{
    ProtocolError, PullResponse, Result, SnapshotManifest, SyncSnapshot, SNAPSHOT_MANIFEST_VERSION,
};
use sha2::{Digest, Sha256};

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
            return Err(ProtocolError::message(format!(
                "subscription {subscription_id} snapshot {} has manifest without chunk refs",
                snapshot.table
            )));
        }
        return Ok(());
    }

    let Some(manifest) = &snapshot.manifest else {
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} chunked snapshot {} is missing manifest",
            snapshot.table
        )));
    };

    if manifest.version != SNAPSHOT_MANIFEST_VERSION {
        return Err(ProtocolError::message(format!(
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
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} snapshot manifest table mismatch: {} != {}",
            manifest.table, snapshot.table
        )));
    }
    if manifest.is_first_page != snapshot.is_first_page
        || manifest.is_last_page != snapshot.is_last_page
    {
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} snapshot {} manifest page flags do not match snapshot",
            snapshot.table
        )));
    }
    if let Some(bootstrap_state_after) = &snapshot.bootstrap_state_after {
        if bootstrap_state_after.as_of_commit_seq != manifest.as_of_commit_seq {
            return Err(ProtocolError::message(format!(
                "subscription {subscription_id} snapshot {} manifest asOfCommitSeq does not match bootstrapStateAfter",
                snapshot.table
            )));
        }
    }
    if manifest.chunks.len() != chunks.len() {
        return Err(ProtocolError::message(format!(
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
            return Err(ProtocolError::message(format!(
                "subscription {subscription_id} snapshot {} manifest chunk {index} does not match chunk ref",
                snapshot.table
            )));
        }
    }

    let actual_digest = snapshot_manifest_digest(manifest)?;
    if actual_digest != manifest.digest {
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} snapshot {} manifest digest mismatch: expected {}, got {}",
            snapshot.table, manifest.digest, actual_digest
        )));
    }
    Ok(())
}

pub fn snapshot_manifest_digest(manifest: &SnapshotManifest) -> Result<String> {
    if manifest.row_limit < 1 {
        return Err(ProtocolError::message(format!(
            "snapshot manifest rowLimit must be positive: {}",
            manifest.row_limit
        )));
    }
    for chunk in &manifest.chunks {
        if chunk.byte_length < 0 {
            return Err(ProtocolError::message(format!(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PullResponse, ScopeValues, SnapshotChunkRef, SnapshotManifestChunkRef,
        SubscriptionResponse, SyncSnapshot,
    };

    #[test]
    fn validates_chunked_snapshot_manifest() {
        let chunk = SnapshotChunkRef {
            id: "chunk-1".to_string(),
            byte_length: 128,
            sha256: "0".repeat(64),
            encoding: "binary-table-v1".to_string(),
            compression: "gzip".to_string(),
        };
        let mut manifest = SnapshotManifest {
            version: SNAPSHOT_MANIFEST_VERSION,
            digest: String::new(),
            table: "tasks".to_string(),
            as_of_commit_seq: 42,
            scope_digest: "c".repeat(64),
            row_cursor: None,
            row_limit: 1000,
            next_row_cursor: None,
            is_first_page: true,
            is_last_page: true,
            chunks: vec![SnapshotManifestChunkRef {
                id: chunk.id.clone(),
                byte_length: chunk.byte_length,
                sha256: chunk.sha256.clone(),
                encoding: chunk.encoding.clone(),
                compression: chunk.compression.clone(),
            }],
        };
        manifest.digest = snapshot_manifest_digest(&manifest).expect("digest");
        let pull = PullResponse {
            ok: true,
            subscriptions: vec![SubscriptionResponse {
                id: "sub-tasks".to_string(),
                status: "active".to_string(),
                scopes: ScopeValues::new(),
                bootstrap: true,
                bootstrap_state: None,
                next_cursor: 42,
                integrity: None,
                commits: Vec::new(),
                snapshots: Some(vec![SyncSnapshot {
                    table: "tasks".to_string(),
                    rows: Vec::new(),
                    chunks: Some(vec![chunk]),
                    manifest: Some(manifest),
                    is_first_page: true,
                    is_last_page: true,
                    bootstrap_state_after: None,
                }]),
            }],
        };

        validate_pull_snapshot_manifests(&pull).expect("valid manifest");
    }
}
