use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde::de::DeserializeOwned;
use syncular_runtime::protocol::{
    AuthLeasePayload, AuthLeaseProtectedHeader, AuthLeaseValidationResult, AUTH_LEASE_ALG_ES256,
    AUTH_LEASE_CODE_EXPIRED, AUTH_LEASE_CODE_INVALID, AUTH_LEASE_TYP,
};

#[derive(Clone)]
pub struct TestAuthLeaseKeyPair {
    kid: String,
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedTestAuthLease {
    pub header: AuthLeaseProtectedHeader,
    pub payload: AuthLeasePayload,
}

impl TestAuthLeaseKeyPair {
    pub fn deterministic(kid: impl Into<String>) -> Self {
        let signing_key = SigningKey::from_slice(&[
            7, 42, 19, 88, 193, 54, 21, 77, 99, 101, 12, 204, 33, 15, 76, 145, 9, 111, 7, 62, 188,
            10, 222, 44, 72, 3, 170, 81, 94, 6, 23, 209,
        ])
        .expect("deterministic test auth lease key");
        let verifying_key = *signing_key.verifying_key();
        Self {
            kid: kid.into(),
            signing_key,
            verifying_key,
        }
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }
}

impl Default for TestAuthLeaseKeyPair {
    fn default() -> Self {
        Self::deterministic("syncular-test-lease-key")
    }
}

pub fn issue_test_auth_lease(payload: &AuthLeasePayload, key: &TestAuthLeaseKeyPair) -> String {
    let header = AuthLeaseProtectedHeader::es256(key.kid());
    let signing_input = format!(
        "{}.{}",
        encode_json_segment(&header),
        encode_json_segment(payload)
    );
    let signature: Signature = key.signing_key.sign(signing_input.as_bytes());
    format!(
        "{}.{}",
        signing_input,
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

pub fn verify_test_auth_lease(
    token: &str,
    verifying_key: &VerifyingKey,
    now_ms: i64,
) -> Result<VerifiedTestAuthLease, AuthLeaseValidationResult> {
    let parts = token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(invalid("auth lease token must have three JWS segments"));
    }

    let header: AuthLeaseProtectedHeader = decode_json_segment(parts[0])?;
    if header.alg != AUTH_LEASE_ALG_ES256 || header.typ != AUTH_LEASE_TYP {
        return Err(invalid("auth lease token has unsupported protected header"));
    }

    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or_else(|| invalid("auth lease signature segment is invalid"))?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    verifying_key
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| invalid("auth lease signature verification failed"))?;

    let payload: AuthLeasePayload = decode_json_segment(parts[1])?;
    let skew = payload.max_clock_skew_ms.max(0);
    if now_ms + skew < payload.not_before_ms {
        return Err(AuthLeaseValidationResult::rejected(
            AUTH_LEASE_CODE_INVALID,
            "auth lease is not valid yet",
        ));
    }
    if now_ms - skew > payload.expires_at_ms {
        let mut result =
            AuthLeaseValidationResult::rejected(AUTH_LEASE_CODE_EXPIRED, "auth lease is expired");
        result.lease_id = Some(payload.lease_id);
        result.kid = Some(header.kid);
        result.expires_at_ms = Some(payload.expires_at_ms);
        return Err(result);
    }

    Ok(VerifiedTestAuthLease { header, payload })
}

fn encode_json_segment<T: serde::Serialize>(value: &T) -> String {
    let json = serde_json::to_vec(value).expect("auth lease JSON segment");
    URL_SAFE_NO_PAD.encode(json)
}

fn decode_json_segment<T: DeserializeOwned>(segment: &str) -> Result<T, AuthLeaseValidationResult> {
    let bytes = URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| invalid("auth lease JSON segment is not base64url"))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid("auth lease JSON segment is invalid"))
}

fn invalid(message: impl Into<String>) -> AuthLeaseValidationResult {
    AuthLeaseValidationResult::rejected(AUTH_LEASE_CODE_INVALID, message)
}
