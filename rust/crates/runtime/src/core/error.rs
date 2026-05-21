use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use std::fmt;

pub type Result<T> = std::result::Result<T, SyncularError>;

pub const FULL_SNAPSHOT_RESYNC_REQUIRED: &str = "full snapshot resync required";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncularErrorClassification {
    pub code: String,
    pub category: String,
    pub retryable: bool,
    pub recommended_action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorKind {
    Busy,
    Config,
    Storage,
    Transport,
    Protocol,
    Schema,
    Codegen,
    Internal,
}

#[derive(Debug)]
pub struct SyncularError {
    kind: ErrorKind,
    source: anyhow::Error,
}

impl SyncularError {
    pub fn new(kind: ErrorKind, source: impl Into<anyhow::Error>) -> Self {
        Self {
            kind,
            source: source.into(),
        }
    }

    pub fn message(kind: ErrorKind, message: impl fmt::Display) -> Self {
        Self::new(kind, anyhow!(message.to_string()))
    }

    pub fn config(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Config, message)
    }

    pub fn busy(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Busy, message)
    }

    pub fn storage(source: impl Into<anyhow::Error>) -> Self {
        Self::new(ErrorKind::Storage, source)
    }

    pub fn transport(source: impl Into<anyhow::Error>) -> Self {
        Self::new(ErrorKind::Transport, source)
    }

    pub fn protocol(source: impl Into<anyhow::Error>) -> Self {
        Self::new(ErrorKind::Protocol, source)
    }

    pub fn protocol_message(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Protocol, message)
    }

    pub fn schema(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Schema, message)
    }

    pub fn codegen(message: impl fmt::Display) -> Self {
        Self::message(ErrorKind::Codegen, message)
    }

    pub fn limit_exceeded(
        limit: &str,
        observed: usize,
        max: usize,
        message: impl fmt::Display,
    ) -> Self {
        let payload = serde_json::json!({
            "code": "runtime.limit_exceeded",
            "category": "limit-exceeded",
            "retryable": false,
            "recommendedAction": "reduceInput",
            "limit": limit,
            "observed": observed,
            "max": max,
        });
        Self::message(ErrorKind::Config, format!("{message}: {payload}"))
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message_text(&self) -> String {
        self.source.to_string()
    }

    pub fn debug_text(&self) -> String {
        self.to_string()
    }

    pub fn requires_full_snapshot_resync(&self) -> bool {
        self.message_text().contains(FULL_SNAPSHOT_RESYNC_REQUIRED)
    }

    pub fn classification(&self) -> SyncularErrorClassification {
        let message = self.message_text();
        if let Some(classification) = classification_from_server_error(&message) {
            return classification;
        }

        if http_status_from_message(&message) == Some(401) {
            return syncular_error_classification(
                "sync.auth_required",
                "auth-required",
                true,
                "refreshAuth",
            );
        }

        if http_status_from_message(&message) == Some(403) {
            return syncular_error_classification(
                "sync.forbidden",
                "forbidden",
                false,
                "checkPermissions",
            );
        }

        let haystack = format!("{message}\n{}", self.debug_text());
        if self.kind == ErrorKind::Schema || haystack_contains_schema_mismatch(&haystack) {
            return syncular_error_classification(
                "sync.schema_mismatch",
                "schema-mismatch",
                false,
                "regenerateClient",
            );
        }

        if self.kind == ErrorKind::Transport && haystack_contains_offline(&haystack) {
            return syncular_error_classification("sync.offline", "offline", true, "retryLater");
        }

        if self.kind == ErrorKind::Protocol
            && (haystack_contains_integrity_rejection(&haystack)
                || self.requires_full_snapshot_resync())
        {
            return syncular_error_classification(
                "sync.integrity_rejected",
                "integrity-rejected",
                false,
                "forceResync",
            );
        }

        match self.kind {
            ErrorKind::Busy => {
                syncular_error_classification("runtime.busy", "rate-limited", true, "retryLater")
            }
            ErrorKind::Config => syncular_error_classification(
                "runtime.config_invalid",
                "invalid-request",
                false,
                "fixRequest",
            ),
            ErrorKind::Storage => {
                syncular_error_classification("storage.failed", "storage", false, "inspectStorage")
            }
            ErrorKind::Transport => syncular_error_classification(
                "sync.transport_failed",
                "transport",
                true,
                "retryLater",
            ),
            ErrorKind::Protocol => syncular_error_classification(
                "sync.invalid_request",
                "invalid-request",
                false,
                "fixRequest",
            ),
            ErrorKind::Schema => unreachable!("schema errors are classified above"),
            ErrorKind::Codegen => syncular_error_classification(
                "runtime.codegen_mismatch",
                "schema-mismatch",
                false,
                "regenerateClient",
            ),
            ErrorKind::Internal => syncular_error_classification(
                "runtime.internal",
                "internal",
                false,
                "inspectServer",
            ),
        }
    }

    pub fn context(self, context: impl fmt::Display) -> Self {
        Self {
            kind: self.kind,
            source: self.source.context(context.to_string()),
        }
    }
}

fn syncular_error_classification(
    code: &str,
    category: &str,
    retryable: bool,
    recommended_action: &str,
) -> SyncularErrorClassification {
    SyncularErrorClassification {
        code: code.to_string(),
        category: category.to_string(),
        retryable,
        recommended_action: recommended_action.to_string(),
    }
}

fn known_error_classification(code: &str) -> Option<SyncularErrorClassification> {
    let (category, retryable, recommended_action) = match code {
        "sync.auth_required" => ("auth-required", true, "refreshAuth"),
        "sync.forbidden" => ("forbidden", false, "checkPermissions"),
        "sync.invalid_request" => ("invalid-request", false, "fixRequest"),
        "sync.invalid_client_id" => ("invalid-request", false, "resetClientId"),
        "sync.invalid_subscription" => ("invalid-request", false, "fixRequest"),
        "sync.empty_commit" => ("invalid-request", false, "fixRequest"),
        "sync.unknown_table" => ("schema-mismatch", false, "regenerateClient"),
        "sync.unsupported_operation" => ("invalid-request", false, "fixRequest"),
        "sync.row_missing" => ("not-found", false, "forceResync"),
        "sync.version_conflict" => ("conflict", false, "resolveConflict"),
        "sync.constraint_violation" => ("invalid-request", false, "fixRequest"),
        "sync.missing_scopes" => ("internal", false, "inspectServer"),
        "sync.idempotency_cache_miss" => ("internal", true, "retryLater"),
        "sync.too_many_operations" => ("invalid-request", false, "splitBatch"),
        "sync.not_found" => ("not-found", false, "forceResync"),
        "sync.rate_limited" => ("rate-limited", true, "retryLater"),
        "sync.schema_mismatch" => ("schema-mismatch", false, "regenerateClient"),
        "sync.integrity_rejected" => ("integrity-rejected", false, "forceResync"),
        "sync.scope_revoked" => ("scope-revoked", false, "checkPermissions"),
        "sync.offline" => ("offline", true, "retryLater"),
        "sync.websocket_not_configured" => ("server", false, "inspectServer"),
        "sync.websocket_connection_limit" => ("rate-limited", true, "retryLater"),
        "sync.transport_failed" => ("transport", true, "retryLater"),
        "runtime.busy" => ("rate-limited", true, "retryLater"),
        "runtime.limit_exceeded" => ("limit-exceeded", false, "reduceInput"),
        "runtime.config_invalid" => ("invalid-request", false, "fixRequest"),
        "runtime.codegen_mismatch" => ("schema-mismatch", false, "regenerateClient"),
        "runtime.internal" => ("internal", false, "inspectServer"),
        "storage.failed" => ("storage", false, "inspectStorage"),
        "worker.closed" => ("invalid-request", false, "fixRequest"),
        "worker.not_open" => ("invalid-request", false, "fixRequest"),
        "worker.protocol_mismatch" => ("schema-mismatch", false, "regenerateClient"),
        "worker.request_timeout" => ("rate-limited", true, "retryLater"),
        "worker.failed" => ("internal", false, "recreateClient"),
        "worker.message_unreadable" => ("internal", false, "recreateClient"),
        "console.auth_required" => ("auth-required", true, "refreshAuth"),
        "console.forbidden_origin" => ("forbidden", false, "checkPermissions"),
        "console.invalid_request" => ("invalid-request", false, "fixRequest"),
        "console.schema_unavailable" => ("server", true, "retryLater"),
        "console.not_found" => ("not-found", false, "inspectServer"),
        "console.downstream_unavailable" => ("server", true, "retryLater"),
        "console.downstream_invalid_response" => ("server", false, "inspectServer"),
        "console.internal" => ("internal", false, "inspectServer"),
        "proxy.auth_required" => ("auth-required", true, "refreshAuth"),
        "proxy.forbidden_origin" => ("forbidden", false, "checkPermissions"),
        "proxy.connection_limit" => ("rate-limited", true, "retryLater"),
        "blob.invalid_request" => ("blob", false, "fixRequest"),
        "blob.storage_not_configured" => ("blob", false, "inspectServer"),
        "blob.too_large" => ("blob", false, "fixRequest"),
        "blob.not_found" => ("blob", false, "fixRequest"),
        "blob.forbidden" => ("forbidden", false, "checkPermissions"),
        "blob.invalid_token" => ("auth-required", true, "refreshAuth"),
        "blob.upload_failed" => ("blob", true, "retryLater"),
        "blob.hash_mismatch" => ("integrity-rejected", false, "fixRequest"),
        "blob.size_mismatch" => ("blob", false, "fixRequest"),
        _ => return None,
    };

    Some(syncular_error_classification(
        code,
        category,
        retryable,
        recommended_action,
    ))
}

fn classification_from_server_error(message: &str) -> Option<SyncularErrorClassification> {
    let parsed = parse_json_object_suffix(message)?;
    let code = parsed
        .get("code")
        .and_then(serde_json::Value::as_str)
        .or_else(|| parsed.get("error").and_then(serde_json::Value::as_str))?;

    let base = known_error_classification(code)
        .unwrap_or_else(|| syncular_error_classification(code, "server", false, "inspectServer"));
    Some(SyncularErrorClassification {
        code: code.to_string(),
        category: parsed
            .get("category")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&base.category)
            .to_string(),
        retryable: parsed
            .get("retryable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(base.retryable),
        recommended_action: parsed
            .get("recommendedAction")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&base.recommended_action)
            .to_string(),
    })
}

fn parse_json_object_suffix(message: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let start = message.find('{')?;
    let tail = &message[start..];
    let parsed = match serde_json::from_str::<serde_json::Value>(tail) {
        Ok(value) => value,
        Err(_) => {
            let end = tail.rfind('}')?;
            serde_json::from_str::<serde_json::Value>(&tail[..=end]).ok()?
        }
    };
    match parsed {
        serde_json::Value::Object(object) => Some(object),
        _ => None,
    }
}

fn http_status_from_message(message: &str) -> Option<u16> {
    let index = message.find("HTTP ")?;
    let status = message.get(index + 5..index + 8)?;
    status.parse::<u16>().ok()
}

fn haystack_contains_schema_mismatch(haystack: &str) -> bool {
    haystack.to_ascii_lowercase().contains("schema version")
}

fn haystack_contains_offline(haystack: &str) -> bool {
    let haystack = haystack.to_ascii_lowercase();
    haystack.contains("offline") || haystack.contains("network is unreachable")
}

fn haystack_contains_integrity_rejection(haystack: &str) -> bool {
    let haystack = haystack.to_ascii_lowercase();
    [
        "hash mismatch",
        "sha256 mismatch",
        "byte length mismatch",
        "manifest ",
        "integrity",
        "chain root",
        "commit root",
        "verified root",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

impl fmt::Display for SyncularError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.source)
    }
}

impl std::error::Error for SyncularError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl From<anyhow::Error> for SyncularError {
    fn from(source: anyhow::Error) -> Self {
        Self::new(ErrorKind::Internal, source)
    }
}

#[cfg(feature = "native")]
impl From<diesel::ConnectionError> for SyncularError {
    fn from(source: diesel::ConnectionError) -> Self {
        Self::storage(source)
    }
}

#[cfg(feature = "native")]
impl From<diesel::result::Error> for SyncularError {
    fn from(source: diesel::result::Error) -> Self {
        Self::storage(source)
    }
}

#[cfg(feature = "native")]
impl From<rusqlite::Error> for SyncularError {
    fn from(source: rusqlite::Error) -> Self {
        Self::storage(source)
    }
}

#[cfg(feature = "native")]
impl From<reqwest::Error> for SyncularError {
    fn from(source: reqwest::Error) -> Self {
        Self::transport(source)
    }
}

#[cfg(feature = "native")]
impl From<reqwest::header::InvalidHeaderValue> for SyncularError {
    fn from(source: reqwest::header::InvalidHeaderValue) -> Self {
        Self::transport(source)
    }
}

#[cfg(feature = "native")]
impl From<tungstenite::Error> for SyncularError {
    fn from(source: tungstenite::Error) -> Self {
        Self::transport(source)
    }
}

impl From<serde_json::Error> for SyncularError {
    fn from(source: serde_json::Error) -> Self {
        Self::protocol(source)
    }
}

impl From<syncular_protocol::ProtocolError> for SyncularError {
    fn from(source: syncular_protocol::ProtocolError) -> Self {
        Self::protocol(source)
    }
}

impl From<std::io::Error> for SyncularError {
    fn from(source: std::io::Error) -> Self {
        Self::new(ErrorKind::Internal, source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_prefers_server_error_envelope() {
        let error = SyncularError::message(
            ErrorKind::Transport,
            r#"sync failed with HTTP 403: {"error":"sync.forbidden","code":"sync.forbidden","category":"forbidden","retryable":false,"recommendedAction":"checkPermissions","message":"Forbidden"}"#,
        );

        assert_eq!(
            error.classification(),
            SyncularErrorClassification {
                code: "sync.forbidden".to_string(),
                category: "forbidden".to_string(),
                retryable: false,
                recommended_action: "checkPermissions".to_string(),
            }
        );
    }

    #[test]
    fn classification_knows_shared_taxonomy_codes_without_envelope_metadata() {
        let conflict = SyncularError::message(
            ErrorKind::Transport,
            r#"sync failed with HTTP 409: {"error":"sync.version_conflict","code":"sync.version_conflict","message":"Version conflict"}"#,
        );
        let worker = SyncularError::message(
            ErrorKind::Transport,
            r#"worker failed: {"error":"worker.failed","code":"worker.failed","message":"Worker failed"}"#,
        );

        assert_eq!(conflict.classification().category, "conflict");
        assert_eq!(
            conflict.classification().recommended_action,
            "resolveConflict"
        );
        assert_eq!(worker.classification().category, "internal");
        assert_eq!(worker.classification().recommended_action, "recreateClient");
    }

    #[test]
    fn classification_maps_http_auth_statuses_without_server_envelope() {
        let auth = SyncularError::message(ErrorKind::Transport, "sync failed with HTTP 401");
        let forbidden = SyncularError::message(ErrorKind::Transport, "sync failed with HTTP 403");

        assert_eq!(auth.classification().code, "sync.auth_required");
        assert_eq!(auth.classification().recommended_action, "refreshAuth");
        assert_eq!(forbidden.classification().code, "sync.forbidden");
        assert_eq!(
            forbidden.classification().recommended_action,
            "checkPermissions"
        );
    }

    #[test]
    fn classification_maps_schema_and_integrity_errors() {
        let schema = SyncularError::schema("server schema version 12 is not compatible");
        let integrity = SyncularError::protocol_message(
            "snapshot chunk sha256 mismatch; full snapshot resync required",
        );

        assert_eq!(schema.classification().code, "sync.schema_mismatch");
        assert_eq!(
            schema.classification().recommended_action,
            "regenerateClient"
        );
        assert_eq!(integrity.classification().code, "sync.integrity_rejected");
        assert_eq!(integrity.classification().recommended_action, "forceResync");
    }

    #[test]
    fn classification_maps_runtime_storage_failures() {
        let error = SyncularError::message(ErrorKind::Storage, "database is locked");

        assert_eq!(
            error.classification(),
            SyncularErrorClassification {
                code: "storage.failed".to_string(),
                category: "storage".to_string(),
                retryable: false,
                recommended_action: "inspectStorage".to_string(),
            }
        );
    }

    #[test]
    fn classification_maps_offline_transport_failures() {
        let error = SyncularError::message(ErrorKind::Transport, "browser fetch failed: offline");

        assert_eq!(
            error.classification(),
            SyncularErrorClassification {
                code: "sync.offline".to_string(),
                category: "offline".to_string(),
                retryable: true,
                recommended_action: "retryLater".to_string(),
            }
        );
    }
}
