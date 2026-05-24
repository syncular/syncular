use crate::{ProtocolError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRef {
    pub hash: String,
    pub size: i64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub encrypted: bool,
    #[serde(rename = "keyId", skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUploadInitRequest {
    pub hash: String,
    pub size: i64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUploadInitResponse {
    pub exists: bool,
    #[serde(rename = "uploadId", skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    #[serde(rename = "uploadUrl", skip_serializing_if = "Option::is_none")]
    pub upload_url: Option<String>,
    #[serde(rename = "uploadMethod", skip_serializing_if = "Option::is_none")]
    pub upload_method: Option<String>,
    #[serde(rename = "uploadHeaders", default)]
    pub upload_headers: BTreeMap<String, String>,
    #[serde(rename = "chunkSize", skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobUploadCompleteResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobDownloadUrlResponse {
    pub url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

pub fn blob_hash(data: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(data)))
}

pub fn normalize_blob_mime_type(mime_type: &str) -> String {
    let trimmed = mime_type.trim();
    if trimmed.is_empty() {
        "application/octet-stream".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn validate_blob_hash(hash: &str) -> Result<()> {
    let Some(hex) = hash.strip_prefix("sha256:") else {
        return Err(ProtocolError::message(format!("invalid blob hash: {hash}")));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProtocolError::message(format!("invalid blob hash: {hash}")));
    }
    Ok(())
}

pub fn validate_blob_ref(blob: &BlobRef) -> Result<()> {
    validate_blob_hash(&blob.hash)?;
    if blob.size < 0 {
        return Err(ProtocolError::message(format!(
            "blob size must be non-negative: {}",
            blob.size
        )));
    }
    if blob.mime_type.trim().is_empty() {
        return Err(ProtocolError::message("blob mimeType must not be empty"));
    }
    if blob.key_id.as_deref().is_some_and(str::is_empty) {
        return Err(ProtocolError::message("blob keyId must not be empty"));
    }
    Ok(())
}

pub fn validate_blob_bytes(blob: &BlobRef, data: &[u8]) -> Result<()> {
    validate_blob_ref(blob)?;
    let actual_size =
        i64::try_from(data.len()).map_err(|_| ProtocolError::message("blob is too large"))?;
    validate_blob_digest(blob, &blob_hash(data), actual_size)
}

pub fn validate_blob_digest(blob: &BlobRef, actual_hash: &str, actual_size: i64) -> Result<()> {
    validate_blob_ref(blob)?;
    if blob.size != actual_size {
        return Err(ProtocolError::message(format!(
            "blob size mismatch: expected {}, got {}",
            blob.size, actual_size
        )));
    }
    if actual_hash != blob.hash {
        return Err(ProtocolError::message(format!(
            "blob hash mismatch: expected {}, got {}",
            blob.hash, actual_hash
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_blob_ref_bytes() {
        let bytes = b"hello syncular";
        let blob = BlobRef {
            hash: blob_hash(bytes),
            size: bytes.len() as i64,
            mime_type: "text/plain".to_string(),
            encrypted: false,
            key_id: None,
        };

        validate_blob_bytes(&blob, bytes).expect("valid blob bytes");
        validate_blob_ref(&blob).expect("valid blob ref");
        let error = validate_blob_digest(&blob, "sha256:bad", blob.size).unwrap_err();
        assert!(error.to_string().contains("blob hash mismatch"));
    }

    #[test]
    fn rejects_invalid_blob_ref_shape() {
        let blob = BlobRef {
            hash: "sha256:bad".to_string(),
            size: -1,
            mime_type: "".to_string(),
            encrypted: false,
            key_id: None,
        };
        assert!(validate_blob_ref(&blob).is_err());
    }
}
