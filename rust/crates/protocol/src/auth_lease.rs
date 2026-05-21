use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const AUTH_LEASE_VERSION: i32 = 1;
pub const AUTH_LEASE_ALG_ES256: &str = "ES256";
pub const AUTH_LEASE_TYP: &str = "syncular-auth-lease+jws";

pub const AUTH_LEASE_CODE_MISSING: &str = "sync.auth_lease_missing";
pub const AUTH_LEASE_CODE_INVALID: &str = "sync.auth_lease_invalid";
pub const AUTH_LEASE_CODE_EXPIRED: &str = "sync.auth_lease_expired";
pub const AUTH_LEASE_CODE_SCHEMA_MISMATCH: &str = "sync.auth_lease_schema_mismatch";
pub const AUTH_LEASE_CODE_SCOPE_MISMATCH: &str = "sync.auth_lease_scope_mismatch";
pub const AUTH_LEASE_CODE_SCOPE_REVOKED: &str = "sync.auth_lease_scope_revoked";
pub const AUTH_LEASE_CODE_BUSINESS_REJECTED: &str = "sync.auth_lease_business_rejected";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeaseProtectedHeader {
    pub alg: String,
    pub kid: String,
    pub typ: String,
}

impl AuthLeaseProtectedHeader {
    pub fn es256(kid: impl Into<String>) -> Self {
        Self {
            alg: AUTH_LEASE_ALG_ES256.to_string(),
            kid: kid.into(),
            typ: AUTH_LEASE_TYP.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeasePayload {
    pub version: i32,
    pub lease_id: String,
    pub issuer: String,
    pub audience: String,
    pub actor_id: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub subject: Map<String, Value>,
    pub schema_version: i32,
    pub protocol_version: i32,
    pub issued_at_ms: i64,
    pub not_before_ms: i64,
    pub expires_at_ms: i64,
    pub max_clock_skew_ms: i64,
    pub scopes: Vec<AuthLeaseScope>,
    pub capabilities: AuthLeaseCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeaseScope {
    pub subscription_id: String,
    pub table: String,
    pub values: Map<String, Value>,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeaseCapabilities {
    pub allow_blobs: bool,
    pub allow_crdt: bool,
    pub allow_encrypted_fields: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeaseValidationResult {
    pub ok: bool,
    #[serde(rename = "leaseId", skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "expiresAtMs", skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
}

impl AuthLeaseValidationResult {
    pub fn accepted(
        lease_id: impl Into<String>,
        kid: impl Into<String>,
        expires_at_ms: i64,
    ) -> Self {
        Self {
            ok: true,
            lease_id: Some(lease_id.into()),
            kid: Some(kid.into()),
            code: None,
            message: None,
            expires_at_ms: Some(expires_at_ms),
        }
    }

    pub fn rejected(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            lease_id: None,
            kid: None,
            code: Some(code.into()),
            message: Some(message.into()),
            expires_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLeaseProvenance {
    pub lease_id: String,
    pub lease_expires_at_ms: i64,
    pub lease_status_at_enqueue: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_scope_summary_json: Option<String>,
    #[serde(rename = "leaseToken", skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<String>,
}
