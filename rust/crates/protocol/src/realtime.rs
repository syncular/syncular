use crate::{OperationResult, ProtocolError, PushCommitRequest, PushCommitResponse, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REALTIME_CLIENT_MESSAGE_PUSH: &str = "push";
pub const REALTIME_CLIENT_MESSAGE_PRESENCE: &str = "presence";
pub const REALTIME_SERVER_EVENT_SYNC: &str = "sync";
pub const REALTIME_SERVER_EVENT_PRESENCE: &str = "presence";
pub const REALTIME_SERVER_EVENT_PUSH_RESPONSE: &str = "push-response";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePresenceEntry {
    pub client_id: String,
    pub actor_id: String,
    pub joined_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePresenceEvent {
    pub action: String,
    pub scope_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<RealtimePresenceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePushRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub request_id: String,
    pub client_commit_id: String,
    pub operations: Vec<crate::SyncOperation>,
    pub schema_version: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_lease: Option<crate::AuthLeaseProvenance>,
}

impl RealtimePushRequest {
    pub fn from_commit(request_id: impl Into<String>, commit: PushCommitRequest) -> Self {
        Self {
            message_type: REALTIME_CLIENT_MESSAGE_PUSH.to_string(),
            request_id: request_id.into(),
            client_commit_id: commit.client_commit_id,
            operations: commit.operations,
            schema_version: commit.schema_version,
            auth_lease: commit.auth_lease,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePresenceRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub action: String,
    pub scope_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl RealtimePresenceRequest {
    pub fn new(
        action: impl Into<String>,
        scope_key: impl Into<String>,
        metadata: Option<Value>,
    ) -> Self {
        Self {
            message_type: REALTIME_CLIENT_MESSAGE_PRESENCE.to_string(),
            action: action.into(),
            scope_key: scope_key.into(),
            metadata,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RealtimeServerMessage {
    pub event: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePushResponseData {
    pub request_id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub commit_seq: Option<i64>,
    #[serde(default)]
    pub results: Vec<OperationResult>,
}

pub fn realtime_push_response_from_value(
    value: &Value,
    expected_request_id: &str,
    client_commit_id: &str,
) -> Result<Option<PushCommitResponse>> {
    let event = value.get("event").and_then(Value::as_str).unwrap_or("");
    if event != REALTIME_SERVER_EVENT_PUSH_RESPONSE {
        return Ok(None);
    }
    let data = value
        .get("data")
        .cloned()
        .ok_or_else(|| ProtocolError::message("push-response missing data"))?;
    let data: RealtimePushResponseData = serde_json::from_value(data)?;
    if data.request_id != expected_request_id {
        return Ok(None);
    }
    Ok(Some(PushCommitResponse {
        client_commit_id: client_commit_id.to_string(),
        status: data.status.unwrap_or_else(|| "rejected".to_string()),
        commit_seq: data.commit_seq,
        results: data.results,
    }))
}

pub fn realtime_presence_event_from_value(value: &Value) -> Option<RealtimePresenceEvent> {
    let presence = value
        .get("data")
        .and_then(|data| data.get("presence"))
        .or_else(|| value.get("presence"))
        .or_else(|| value.get("data"))?;
    serde_json::from_value(presence.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SyncOperation;
    use serde_json::json;

    #[test]
    fn encodes_push_and_presence_requests() {
        let push = RealtimePushRequest::from_commit(
            "req-1",
            PushCommitRequest {
                client_commit_id: "commit-1".to_string(),
                operations: vec![SyncOperation {
                    table: "tasks".to_string(),
                    row_id: "task-1".to_string(),
                    op: "upsert".to_string(),
                    payload: None,
                    base_version: None,
                }],
                schema_version: 7,
                auth_lease: Some(crate::AuthLeaseProvenance {
                    lease_id: "lease-1".to_string(),
                    lease_expires_at_ms: 1_779_446_400_000,
                    lease_status_at_enqueue: "active".to_string(),
                    lease_scope_summary_json: None,
                    lease_token: Some("lease-token".to_string()),
                }),
            },
        );
        assert_eq!(
            serde_json::to_value(push).expect("push json"),
            json!({
                "type": "push",
                "requestId": "req-1",
                "clientCommitId": "commit-1",
                "operations": [{
                    "table": "tasks",
                    "row_id": "task-1",
                    "op": "upsert",
                    "payload": null,
                    "base_version": null
                }],
                "schemaVersion": 7,
                "authLease": {
                    "leaseId": "lease-1",
                    "leaseExpiresAtMs": 1_779_446_400_000_i64,
                    "leaseStatusAtEnqueue": "active",
                    "leaseToken": "lease-token"
                }
            })
        );

        let presence = RealtimePresenceRequest::new("join", "user:1", Some(json!({"doc": "a"})));
        assert_eq!(
            serde_json::to_value(presence).expect("presence json"),
            json!({
                "type": "presence",
                "action": "join",
                "scopeKey": "user:1",
                "metadata": {"doc": "a"}
            })
        );
    }

    #[test]
    fn decodes_matching_push_response() {
        let response = realtime_push_response_from_value(
            &json!({
                "event": "push-response",
                "data": {
                    "requestId": "req-1",
                    "status": "accepted",
                    "commitSeq": 42,
                    "results": [{"opIndex": 0, "status": "ok"}]
                }
            }),
            "req-1",
            "commit-1",
        )
        .expect("decode")
        .expect("response");

        assert_eq!(response.client_commit_id, "commit-1");
        assert_eq!(response.status, "accepted");
        assert_eq!(response.commit_seq, Some(42));
        assert_eq!(response.results.len(), 1);
    }
}
