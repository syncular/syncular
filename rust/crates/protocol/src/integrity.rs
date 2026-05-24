use crate::ProtocolError;
use crate::{
    append_canonical_json, append_canonical_object, append_json_string, sha256_hex, PullResponse,
    Result, SubscriptionIntegrity, SyncCommit, COMMIT_INTEGRITY_GENESIS_ROOT,
    COMMIT_INTEGRITY_HEX_LENGTH, WIRE_COMMIT_CHAIN_ROOT_VERSION, WIRE_COMMIT_DIGEST_VERSION,
};
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCommitRoot {
    pub partition_id: String,
    pub commit_seq: i64,
    pub root: String,
}

pub fn validate_pull_commit_integrity_metadata(response: &PullResponse) -> Result<()> {
    for subscription in &response.subscriptions {
        let Some(integrity) = &subscription.integrity else {
            continue;
        };
        if subscription.commits.is_empty() {
            return Err(ProtocolError::message(format!(
                "subscription {} has integrity metadata without commits",
                subscription.id
            )));
        }
        validate_commit_integrity_hex(
            "previousChainRoot",
            &subscription.id,
            integrity.commit_seq,
            &integrity.previous_chain_root,
        )?;
        validate_commit_integrity_hex(
            "commitChainRoot",
            &subscription.id,
            integrity.commit_seq,
            &integrity.commit_chain_root,
        )?;
        let Some(last_commit) = subscription.commits.last() else {
            continue;
        };
        if last_commit.commit_seq != integrity.commit_seq {
            return Err(ProtocolError::message(format!(
                "subscription {} integrity commitSeq mismatch: expected {}, got {}",
                subscription.id, last_commit.commit_seq, integrity.commit_seq
            )));
        }
    }
    Ok(())
}

pub fn verify_subscription_commit_integrity(
    subscription_id: &str,
    stored_root: Option<&str>,
    integrity: Option<&SubscriptionIntegrity>,
    commits: &[SyncCommit],
) -> Result<Option<VerifiedCommitRoot>> {
    let Some(integrity) = integrity else {
        return Ok(None);
    };
    let mut expected_previous_root = stored_root
        .filter(|root| !root.is_empty())
        .unwrap_or(COMMIT_INTEGRITY_GENESIS_ROOT)
        .to_string();

    if integrity.previous_chain_root != expected_previous_root {
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} previousChainRoot mismatch: expected {}, got {}",
            expected_previous_root, integrity.previous_chain_root
        )));
    }

    for commit in commits {
        let actual_digest = wire_commit_digest(&integrity.partition_id, subscription_id, commit)?;
        expected_previous_root = wire_commit_chain_root_from_digest(
            &integrity.partition_id,
            subscription_id,
            &expected_previous_root,
            commit.commit_seq,
            &actual_digest,
        )?;
    }

    if expected_previous_root != integrity.commit_chain_root {
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} commitChainRoot mismatch: expected {}, got {}",
            integrity.commit_chain_root, expected_previous_root
        )));
    }

    Ok(Some(VerifiedCommitRoot {
        partition_id: integrity.partition_id.clone(),
        commit_seq: integrity.commit_seq,
        root: integrity.commit_chain_root.clone(),
    }))
}

pub fn wire_commit_digest(
    partition_id: &str,
    subscription_id: &str,
    commit: &SyncCommit,
) -> Result<String> {
    let mut payload = String::new();
    append_wire_commit_digest_payload(&mut payload, partition_id, subscription_id, commit)?;
    Ok(sha256_hex(&payload))
}

pub fn wire_commit_chain_root(
    partition_id: &str,
    subscription_id: &str,
    previous_chain_root: &str,
    commit_seq: i64,
    commit_digest: &str,
) -> Result<String> {
    wire_commit_chain_root_from_digest(
        partition_id,
        subscription_id,
        previous_chain_root,
        commit_seq,
        commit_digest,
    )
}

pub fn wire_commit_chain_root_from_digest(
    partition_id: &str,
    subscription_id: &str,
    previous_chain_root: &str,
    commit_seq: i64,
    commit_digest: &str,
) -> Result<String> {
    let mut payload = String::new();
    append_wire_commit_chain_root_payload(
        &mut payload,
        partition_id,
        subscription_id,
        previous_chain_root,
        commit_seq,
        commit_digest,
    )?;
    Ok(sha256_hex(&payload))
}

fn append_wire_commit_digest_payload(
    out: &mut String,
    partition_id: &str,
    subscription_id: &str,
    commit: &SyncCommit,
) -> Result<()> {
    out.push_str("{\"actorId\":");
    append_json_string(out, &commit.actor_id)?;
    out.push_str(",\"changes\":[");
    for (index, change) in commit.changes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"op\":");
        append_json_string(out, &change.op)?;
        out.push_str(",\"row\":");
        match &change.row_json {
            Some(row) => append_canonical_json(out, row)?,
            None => out.push_str("null"),
        }
        out.push_str(",\"rowId\":");
        append_json_string(out, &change.row_id)?;
        out.push_str(",\"rowVersion\":");
        match change.row_version {
            Some(row_version) => {
                write!(out, "{row_version}").expect("writing to String should not fail")
            }
            None => out.push_str("null"),
        }
        out.push_str(",\"scopes\":");
        append_canonical_object(out, &change.scopes)?;
        out.push_str(",\"table\":");
        append_json_string(out, &change.table)?;
        out.push('}');
    }
    out.push_str("],\"commitSeq\":");
    write!(out, "{}", commit.commit_seq).expect("writing to String should not fail");
    out.push_str(",\"createdAt\":");
    append_json_string(out, &commit.created_at)?;
    out.push_str(",\"partitionId\":");
    append_json_string(out, partition_id)?;
    out.push_str(",\"subscriptionId\":");
    append_json_string(out, subscription_id)?;
    out.push_str(",\"version\":");
    append_json_string(out, WIRE_COMMIT_DIGEST_VERSION)?;
    out.push('}');
    Ok(())
}

fn append_wire_commit_chain_root_payload(
    out: &mut String,
    partition_id: &str,
    subscription_id: &str,
    previous_chain_root: &str,
    commit_seq: i64,
    commit_digest: &str,
) -> Result<()> {
    out.push_str("{\"commitDigest\":");
    append_json_string(out, commit_digest)?;
    out.push_str(",\"commitSeq\":");
    write!(out, "{commit_seq}").expect("writing to String should not fail");
    out.push_str(",\"partitionId\":");
    append_json_string(out, partition_id)?;
    out.push_str(",\"previousChainRoot\":");
    append_json_string(out, previous_chain_root)?;
    out.push_str(",\"subscriptionId\":");
    append_json_string(out, subscription_id)?;
    out.push_str(",\"version\":");
    append_json_string(out, WIRE_COMMIT_CHAIN_ROOT_VERSION)?;
    out.push('}');
    Ok(())
}

pub(crate) fn validate_commit_integrity_hex(
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
        return Err(ProtocolError::message(format!(
            "subscription {subscription_id} commit {commit_seq} {label} must be a lowercase 64-character SHA-256 hex string"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ScopeValues, SyncChange};
    use serde_json::json;

    #[test]
    fn verifies_subscription_commit_root() {
        let change = SyncChange {
            table: "tasks".to_string(),
            row_id: "task-1".to_string(),
            op: "upsert".to_string(),
            row_json: Some(json!({"id":"task-1","title":"Ship"})),
            row_version: Some(1),
            scopes: ScopeValues::new(),
        };
        let commit = SyncCommit {
            commit_seq: 7,
            created_at: "2026-05-19T00:00:00.000Z".to_string(),
            actor_id: "server".to_string(),
            changes: vec![change],
        };
        let digest = wire_commit_digest("default", "sub-tasks", &commit).expect("digest");
        let root = wire_commit_chain_root(
            "default",
            "sub-tasks",
            COMMIT_INTEGRITY_GENESIS_ROOT,
            7,
            &digest,
        )
        .expect("root");
        let verified = verify_subscription_commit_integrity(
            "sub-tasks",
            None,
            Some(&SubscriptionIntegrity {
                partition_id: "default".to_string(),
                previous_chain_root: COMMIT_INTEGRITY_GENESIS_ROOT.to_string(),
                commit_chain_root: root.clone(),
                commit_seq: 7,
            }),
            &[commit],
        )
        .expect("valid root")
        .expect("verified root");

        assert_eq!(verified.root, root);
        assert_eq!(verified.commit_seq, 7);
    }
}
