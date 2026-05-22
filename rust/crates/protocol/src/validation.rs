use crate::{
    decode_snapshot_chunk_sha256, validate_pull_snapshot_manifests,
    validate_scoped_snapshot_artifact_ref, validate_snapshot_chunk_format, AuthLeaseProvenance,
    CombinedRequest, CombinedResponse, OperationResult, ProtocolError, PullRequest, PullResponse,
    PushBatchRequest, PushBatchResponse, PushCommitRequest, PushCommitResponse,
    RealtimePresenceRequest, RealtimePushRequest, RealtimeServerMessage, Result, ScopeValues,
    SnapshotChunkRef, SyncChange, SyncOperation, SyncSnapshot, SYNC_PACK_ENCODING_BINARY_V1,
};
use serde_json::Value;

pub fn validate_combined_request(request: &CombinedRequest) -> Result<()> {
    ensure_non_empty("clientId", &request.client_id)?;
    validate_sync_pack_encodings(&request.sync_pack_encodings)?;
    if let Some(push) = &request.push {
        validate_push_batch_request(push)?;
    }
    if let Some(pull) = &request.pull {
        validate_pull_request(pull)?;
    }
    if request.push.is_none() && request.pull.is_none() {
        return Err(ProtocolError::message(
            "combined request must include push or pull",
        ));
    }
    Ok(())
}

pub fn validate_combined_response(response: &CombinedResponse) -> Result<()> {
    if !response.ok {
        return Err(ProtocolError::message("combined response ok must be true"));
    }
    if response
        .required_schema_version
        .is_some_and(|value| value < 1)
    {
        return Err(ProtocolError::message(
            "combined response requiredSchemaVersion must be positive",
        ));
    }
    if response
        .latest_schema_version
        .is_some_and(|value| value < 1)
    {
        return Err(ProtocolError::message(
            "combined response latestSchemaVersion must be positive",
        ));
    }
    if let Some(push) = &response.push {
        validate_push_batch_response(push)?;
    }
    if let Some(pull) = &response.pull {
        validate_pull_response(pull)?;
    }
    Ok(())
}

pub fn validate_realtime_push_request(request: &RealtimePushRequest) -> Result<()> {
    if request.message_type != crate::REALTIME_CLIENT_MESSAGE_PUSH {
        return Err(ProtocolError::message(format!(
            "realtime push type must be {}, got {}",
            crate::REALTIME_CLIENT_MESSAGE_PUSH,
            request.message_type
        )));
    }
    ensure_non_empty("realtime push requestId", &request.request_id)?;
    validate_push_commit_request(&PushCommitRequest {
        client_commit_id: request.client_commit_id.clone(),
        operations: request.operations.clone(),
        schema_version: request.schema_version,
        auth_lease: request.auth_lease.clone(),
    })
}

pub fn validate_realtime_presence_request(request: &RealtimePresenceRequest) -> Result<()> {
    if request.message_type != crate::REALTIME_CLIENT_MESSAGE_PRESENCE {
        return Err(ProtocolError::message(format!(
            "realtime presence type must be {}, got {}",
            crate::REALTIME_CLIENT_MESSAGE_PRESENCE,
            request.message_type
        )));
    }
    ensure_non_empty("realtime presence action", &request.action)?;
    ensure_non_empty("realtime presence scopeKey", &request.scope_key)
}

pub fn validate_realtime_server_message(message: &RealtimeServerMessage) -> Result<()> {
    match message.event.as_str() {
        crate::REALTIME_SERVER_EVENT_SYNC => validate_realtime_sync_data(&message.data),
        crate::REALTIME_SERVER_EVENT_PRESENCE => {
            if crate::realtime_presence_event_from_value(&serde_json::json!({
                "event": message.event,
                "data": message.data
            }))
            .is_none()
            {
                return Err(ProtocolError::message(
                    "realtime presence message is missing presence data",
                ));
            }
            Ok(())
        }
        crate::REALTIME_SERVER_EVENT_PUSH_RESPONSE => {
            let data = message
                .data
                .as_object()
                .ok_or_else(|| ProtocolError::message("push-response data must be an object"))?;
            ensure_value_string("push-response requestId", data.get("requestId"))?;
            if let Some(results) = data.get("results") {
                let results = results.as_array().ok_or_else(|| {
                    ProtocolError::message("push-response results must be an array")
                })?;
                for result in results {
                    let result: OperationResult = serde_json::from_value(result.clone())?;
                    validate_operation_result(&result)?;
                }
            }
            Ok(())
        }
        "hello" | "heartbeat" | "error" => Ok(()),
        event => Err(ProtocolError::message(format!(
            "unsupported realtime server event: {event}"
        ))),
    }
}

fn validate_push_batch_request(push: &PushBatchRequest) -> Result<()> {
    if push.commits.is_empty() {
        return Err(ProtocolError::message(
            "push request must include at least one commit",
        ));
    }
    for commit in &push.commits {
        validate_push_commit_request(commit)?;
    }
    Ok(())
}

fn validate_push_commit_request(commit: &PushCommitRequest) -> Result<()> {
    ensure_non_empty("clientCommitId", &commit.client_commit_id)?;
    if commit.schema_version < 1 {
        return Err(ProtocolError::message(
            "push commit schemaVersion must be positive",
        ));
    }
    if commit.operations.is_empty() {
        return Err(ProtocolError::message(
            "push commit must include at least one operation",
        ));
    }
    for operation in &commit.operations {
        validate_operation(operation)?;
    }
    if let Some(auth_lease) = &commit.auth_lease {
        validate_auth_lease_provenance(auth_lease)?;
    }
    Ok(())
}

fn validate_operation(operation: &SyncOperation) -> Result<()> {
    ensure_non_empty("operation table", &operation.table)?;
    ensure_non_empty("operation row_id", &operation.row_id)?;
    match operation.op.as_str() {
        "upsert" | "delete" => Ok(()),
        op => Err(ProtocolError::message(format!(
            "unsupported operation op: {op}"
        ))),
    }
}

fn validate_auth_lease_provenance(auth_lease: &AuthLeaseProvenance) -> Result<()> {
    ensure_non_empty("authLease leaseId", &auth_lease.lease_id)?;
    if auth_lease.lease_expires_at_ms < 0 {
        return Err(ProtocolError::message(
            "authLease leaseExpiresAtMs must be non-negative",
        ));
    }
    ensure_non_empty(
        "authLease leaseStatusAtEnqueue",
        &auth_lease.lease_status_at_enqueue,
    )?;
    if auth_lease.lease_token.as_deref().is_some_and(str::is_empty) {
        return Err(ProtocolError::message(
            "authLease leaseToken must not be empty",
        ));
    }
    Ok(())
}

fn validate_pull_request(pull: &PullRequest) -> Result<()> {
    if pull.limit_commits < 1 {
        return Err(ProtocolError::message(
            "pull request limitCommits must be positive",
        ));
    }
    if pull.limit_snapshot_rows < 1 {
        return Err(ProtocolError::message(
            "pull request limitSnapshotRows must be positive",
        ));
    }
    if pull.max_snapshot_pages < 1 {
        return Err(ProtocolError::message(
            "pull request maxSnapshotPages must be positive",
        ));
    }
    validate_sync_pack_encodings(&pull.sync_pack_encodings)?;
    for encoding in &pull.snapshot_encodings {
        validate_snapshot_encoding(encoding)?;
    }
    if let Some(artifacts) = &pull.snapshot_artifacts {
        ensure_non_empty("snapshotArtifacts schemaVersion", &artifacts.schema_version)?;
        if artifacts.artifact_kinds.is_empty() {
            return Err(ProtocolError::message(
                "snapshotArtifacts artifactKinds must not be empty",
            ));
        }
        for artifact_kind in &artifacts.artifact_kinds {
            if artifact_kind != crate::SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1 {
                return Err(ProtocolError::message(format!(
                    "unsupported snapshot artifact kind: {artifact_kind}"
                )));
            }
        }
        for compression in &artifacts.compressions {
            if compression != crate::SNAPSHOT_ARTIFACT_COMPRESSION_NONE
                && compression != crate::SNAPSHOT_CHUNK_COMPRESSION_GZIP
            {
                return Err(ProtocolError::message(format!(
                    "unsupported snapshot artifact compression: {compression}"
                )));
            }
        }
    }
    for subscription in &pull.subscriptions {
        ensure_non_empty("subscription id", &subscription.id)?;
        ensure_non_empty("subscription table", &subscription.table)?;
        validate_request_scopes(&subscription.scopes)?;
        if subscription.cursor < 0 {
            return Err(ProtocolError::message(
                "subscription cursor must be non-negative",
            ));
        }
        if subscription
            .verified_root
            .as_deref()
            .is_some_and(|root| validate_hex_root("subscription verifiedRoot", root).is_err())
        {
            return Err(ProtocolError::message(
                "subscription verifiedRoot must be a 64-character hex root",
            ));
        }
    }
    Ok(())
}

fn validate_push_batch_response(push: &PushBatchResponse) -> Result<()> {
    if !push.ok {
        return Err(ProtocolError::message("push response ok must be true"));
    }
    for commit in &push.commits {
        validate_push_commit_response(commit)?;
    }
    Ok(())
}

fn validate_push_commit_response(commit: &PushCommitResponse) -> Result<()> {
    ensure_non_empty("push response clientCommitId", &commit.client_commit_id)?;
    match commit.status.as_str() {
        "applied" | "cached" | "rejected" => {}
        status => {
            return Err(ProtocolError::message(format!(
                "unsupported push response status: {status}"
            )))
        }
    }
    for result in &commit.results {
        validate_operation_result(result)?;
    }
    Ok(())
}

fn validate_operation_result(result: &OperationResult) -> Result<()> {
    if result.op_index < 0 {
        return Err(ProtocolError::message(
            "operation result opIndex must be non-negative",
        ));
    }
    match result.status.as_str() {
        "applied" => Ok(()),
        "conflict" => {
            if result.message.as_deref().unwrap_or("").is_empty() {
                return Err(ProtocolError::message(
                    "conflict operation result must include message",
                ));
            }
            if result.server_version.is_none() {
                return Err(ProtocolError::message(
                    "conflict operation result must include server_version",
                ));
            }
            Ok(())
        }
        "error" => {
            if result.error.as_deref().unwrap_or("").is_empty() {
                return Err(ProtocolError::message(
                    "error operation result must include error",
                ));
            }
            Ok(())
        }
        status => Err(ProtocolError::message(format!(
            "unsupported operation result status: {status}"
        ))),
    }
}

fn validate_pull_response(pull: &PullResponse) -> Result<()> {
    if !pull.ok {
        return Err(ProtocolError::message("pull response ok must be true"));
    }
    validate_pull_snapshot_manifests(pull)?;
    for subscription in &pull.subscriptions {
        ensure_non_empty("pull subscription id", &subscription.id)?;
        match subscription.status.as_str() {
            "active" | "revoked" => {}
            status => {
                return Err(ProtocolError::message(format!(
                    "unsupported pull subscription status: {status}"
                )))
            }
        }
        validate_request_scopes(&subscription.scopes)?;
        if subscription.next_cursor < 0 {
            return Err(ProtocolError::message(
                "pull subscription nextCursor must be non-negative",
            ));
        }
        if let Some(integrity) = &subscription.integrity {
            ensure_non_empty(
                "subscription integrity partitionId",
                &integrity.partition_id,
            )?;
            validate_hex_root(
                "subscription integrity previousChainRoot",
                &integrity.previous_chain_root,
            )?;
            validate_hex_root(
                "subscription integrity commitChainRoot",
                &integrity.commit_chain_root,
            )?;
        }
        if let Some(snapshots) = &subscription.snapshots {
            for snapshot in snapshots {
                validate_snapshot(snapshot)?;
            }
        }
        for commit in &subscription.commits {
            if commit.commit_seq < 0 {
                return Err(ProtocolError::message(
                    "sync commit commitSeq must be non-negative",
                ));
            }
            ensure_non_empty("sync commit actorId", &commit.actor_id)?;
            for change in &commit.changes {
                validate_change(change)?;
            }
        }
    }
    Ok(())
}

fn validate_change(change: &SyncChange) -> Result<()> {
    ensure_non_empty("sync change table", &change.table)?;
    ensure_non_empty("sync change row_id", &change.row_id)?;
    match change.op.as_str() {
        "upsert" | "delete" => {}
        op => {
            return Err(ProtocolError::message(format!(
                "unsupported sync change op: {op}"
            )))
        }
    }
    validate_stored_scopes(&change.scopes)
}

fn validate_snapshot(snapshot: &SyncSnapshot) -> Result<()> {
    ensure_non_empty("snapshot table", &snapshot.table)?;
    if let Some(chunks) = &snapshot.chunks {
        for chunk in chunks {
            validate_snapshot_chunk_ref(chunk)?;
        }
    }
    if let Some(artifacts) = &snapshot.artifacts {
        for artifact in artifacts {
            validate_scoped_snapshot_artifact_ref(artifact)?;
        }
    }
    Ok(())
}

fn validate_snapshot_chunk_ref(chunk: &SnapshotChunkRef) -> Result<()> {
    ensure_non_empty("snapshot chunk id", &chunk.id)?;
    if chunk.byte_length < 0 {
        return Err(ProtocolError::message(
            "snapshot chunk byteLength must be non-negative",
        ));
    }
    validate_snapshot_chunk_format(chunk)?;
    decode_snapshot_chunk_sha256(chunk)?;
    Ok(())
}

fn validate_realtime_sync_data(value: &Value) -> Result<()> {
    let data = value
        .as_object()
        .ok_or_else(|| ProtocolError::message("realtime sync data must be an object"))?;
    if let Some(cursor) = data.get("cursor") {
        if cursor.as_i64().is_none_or(|cursor| cursor < 0) {
            return Err(ProtocolError::message(
                "realtime sync cursor must be a non-negative integer",
            ));
        }
    }
    if let Some(dropped_count) = data.get("droppedCount") {
        if dropped_count
            .as_i64()
            .is_none_or(|dropped_count| dropped_count < 0)
        {
            return Err(ProtocolError::message(
                "realtime sync droppedCount must be a non-negative integer",
            ));
        }
    }
    if let Some(encoding) = data.get("syncPackEncoding").and_then(Value::as_str) {
        if encoding != SYNC_PACK_ENCODING_BINARY_V1 {
            return Err(ProtocolError::message(format!(
                "unsupported realtime sync pack encoding: {encoding}"
            )));
        }
    }
    Ok(())
}

fn validate_sync_pack_encodings(encodings: &[String]) -> Result<()> {
    for encoding in encodings {
        if encoding != SYNC_PACK_ENCODING_BINARY_V1 {
            return Err(ProtocolError::message(format!(
                "unsupported sync pack encoding: {encoding}"
            )));
        }
    }
    Ok(())
}

fn validate_snapshot_encoding(encoding: &str) -> Result<()> {
    if encoding != crate::SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1 {
        return Err(ProtocolError::message(format!(
            "unsupported snapshot encoding: {encoding}"
        )));
    }
    Ok(())
}

fn validate_request_scopes(scopes: &ScopeValues) -> Result<()> {
    for (key, value) in scopes {
        ensure_non_empty("scope key", key)?;
        match value {
            Value::String(_) => {}
            Value::Array(values) if values.iter().all(Value::is_string) => {}
            _ => {
                return Err(ProtocolError::message(format!(
                    "scope {key} must be a string or string array"
                )))
            }
        }
    }
    Ok(())
}

fn validate_stored_scopes(scopes: &ScopeValues) -> Result<()> {
    for (key, value) in scopes {
        ensure_non_empty("stored scope key", key)?;
        if !value.is_string() {
            return Err(ProtocolError::message(format!(
                "stored scope {key} must be a string"
            )));
        }
    }
    Ok(())
}

fn ensure_value_string(label: &str, value: Option<&Value>) -> Result<()> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::message(format!("{label} must be a string")))?;
    ensure_non_empty(label, value)
}

fn validate_hex_root(label: &str, value: &str) -> Result<()> {
    if value.len() != crate::COMMIT_INTEGRITY_HEX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ProtocolError::message(format!(
            "{label} must be a 64-character hex root"
        )));
    }
    Ok(())
}

fn ensure_non_empty(label: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(ProtocolError::message(format!("{label} must not be empty")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        binary_sync_pack::decode_binary_sync_pack, validate_blob_ref, BlobRef,
        RealtimePresenceRequest, RealtimePushRequest,
    };
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RelayProtocolBoundaryFixture {
        combined: CombinedFixture,
        binary_sync_pack: BinarySyncPackFixture,
        blob: BlobFixture,
        realtime: RealtimeFixture,
    }

    #[derive(Deserialize)]
    struct CombinedFixture {
        request: CombinedRequest,
        response: CombinedResponse,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BinarySyncPackFixture {
        encoded_hex: String,
        decoded_response: CombinedResponse,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BlobFixture {
        r#ref: BlobRef,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RealtimeFixture {
        push_request: RealtimePushRequest,
        presence_request: RealtimePresenceRequest,
        server_sync_message: RealtimeServerMessage,
        server_presence_message: RealtimeServerMessage,
        server_push_response_message: RealtimeServerMessage,
        binary_sync_pack_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RustCanonicalFixture {
        combined_request: Value,
        realtime_push_request: Value,
        realtime_presence_request: Value,
        blob_ref: Value,
    }

    #[test]
    fn validates_relay_protocol_boundary_fixture() {
        let fixture: RelayProtocolBoundaryFixture = serde_json::from_str(include_str!(
            "../../runtime/tests/fixtures/relay-protocol-boundary-v1.json"
        ))
        .expect("relay boundary fixture");

        validate_combined_request(&fixture.combined.request).expect("combined request");
        validate_combined_response(&fixture.combined.response).expect("combined response");
        validate_combined_response(&fixture.binary_sync_pack.decoded_response)
            .expect("binary decoded response fixture");

        let encoded = hex::decode(fixture.binary_sync_pack.encoded_hex).expect("binary hex");
        let decoded = decode_binary_sync_pack(&encoded).expect("decode binary sync pack");
        validate_combined_response(&decoded).expect("decoded binary response");

        validate_blob_ref(&fixture.blob.r#ref).expect("blob ref");
        validate_realtime_push_request(&fixture.realtime.push_request).expect("push request");
        validate_realtime_presence_request(&fixture.realtime.presence_request)
            .expect("presence request");
        validate_realtime_server_message(&fixture.realtime.server_sync_message)
            .expect("sync message");
        validate_realtime_server_message(&fixture.realtime.server_presence_message)
            .expect("presence message");
        validate_realtime_server_message(&fixture.realtime.server_push_response_message)
            .expect("push response message");

        let realtime_pack =
            hex::decode(fixture.realtime.binary_sync_pack_hex).expect("realtime sync pack hex");
        let decoded_realtime_pack =
            decode_binary_sync_pack(&realtime_pack).expect("decode realtime sync pack");
        validate_combined_response(&decoded_realtime_pack).expect("realtime sync pack response");
    }

    #[test]
    fn rejects_stale_binary_sync_pack_versions_for_relay_boundary() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../runtime/tests/fixtures/relay-protocol-boundary-v1.json"
        ))
        .expect("relay boundary fixture");
        let mut encoded = hex::decode(
            fixture["binarySyncPack"]["encodedHex"]
                .as_str()
                .expect("encoded hex"),
        )
        .expect("hex");
        encoded[4..6].copy_from_slice(&10u16.to_le_bytes());

        let error = decode_binary_sync_pack(&encoded).expect_err("old version rejects");
        assert!(
            error
                .to_string()
                .contains("unsupported binary sync pack version: 10"),
            "{error}"
        );
    }

    #[test]
    fn keeps_rust_canonical_relay_examples_stable() {
        let fixture: RustCanonicalFixture = serde_json::from_str(include_str!(
            "../../runtime/tests/fixtures/rust-relay-protocol-canonical-v1.json"
        ))
        .expect("rust canonical relay fixture");
        let operation = crate::SyncOperation {
            table: "tasks".to_string(),
            row_id: "rust-relay-task-1".to_string(),
            op: "upsert".to_string(),
            payload: Some(serde_json::json!({
                "id": "rust-relay-task-1",
                "title": "Rust relay canonical"
            })),
            base_version: None,
        };
        let commit = PushCommitRequest {
            client_commit_id: "rust-relay-commit-1".to_string(),
            operations: vec![operation.clone()],
            schema_version: 7,
            auth_lease: None,
        };
        let combined = CombinedRequest {
            client_id: "rust-relay-client-1".to_string(),
            sync_pack_encodings: vec![crate::SYNC_PACK_ENCODING_BINARY_V1.to_string()],
            push: Some(PushBatchRequest {
                commits: vec![commit.clone()],
            }),
            pull: None,
        };
        let realtime_push =
            RealtimePushRequest::from_commit("rust-relay-request-1", commit.clone());
        let realtime_presence = RealtimePresenceRequest::new(
            "join",
            "project:rust-relay",
            Some(serde_json::json!({"relayId": "rust-relay-1"})),
        );
        let blob = BlobRef {
            hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            size: 17,
            mime_type: "text/plain".to_string(),
            encrypted: true,
            key_id: Some("rust-relay-key-1".to_string()),
        };

        validate_combined_request(&combined).expect("combined request");
        validate_realtime_push_request(&realtime_push).expect("realtime push");
        validate_realtime_presence_request(&realtime_presence).expect("presence");
        validate_blob_ref(&blob).expect("blob ref");
        assert_eq!(
            serde_json::to_value(combined).expect("combined json"),
            fixture.combined_request
        );
        assert_eq!(
            serde_json::to_value(realtime_push).expect("push json"),
            fixture.realtime_push_request
        );
        assert_eq!(
            serde_json::to_value(realtime_presence).expect("presence json"),
            fixture.realtime_presence_request
        );
        assert_eq!(
            serde_json::to_value(blob).expect("blob json"),
            fixture.blob_ref
        );
    }

    #[test]
    fn rejects_invalid_relay_protocol_shapes() {
        let request = CombinedRequest {
            client_id: "relay-client".to_string(),
            sync_pack_encodings: vec!["legacy-json".to_string()],
            push: None,
            pull: None,
        };
        let error = validate_combined_request(&request).expect_err("invalid request");
        assert!(
            error.to_string().contains("unsupported sync pack encoding"),
            "{error}"
        );
    }
}
