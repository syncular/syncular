//! Canonical BlobRef documents (SPEC.md §5.9.1) — the value a `blob_ref`
//! column (§2.4 tag 7) carries. Wire-shaped identically to `json` (a `str`),
//! validated at decode against the pinned shape and key order; the raw string
//! is preserved verbatim for re-encoding.

use crate::error::{DecodeError, Result};
use serde_json::Value;

/// The pinned canonical key order (§5.9.1).
const CANONICAL_KEYS: [&str; 4] = ["blobId", "byteLength", "mediaType", "name"];

fn is_blob_id(value: &str) -> bool {
    match value.strip_prefix("sha256:") {
        Some(hex) => {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }
        None => false,
    }
}

/// Validate a raw `blob_ref` string against §5.9.1. A failure is a decode
/// error (`sync.invalid_request`), the same class as the `json` parse.
pub fn validate_blob_ref(raw: &str) -> Result<()> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| DecodeError::invalid("blob_ref value does not parse as JSON (§5.9.1)"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| DecodeError::invalid("blob_ref value must be a JSON object (§5.9.1)"))?;

    // Unknown keys are rejected; present keys must appear in canonical order.
    let mut present: Vec<&str> = Vec::with_capacity(obj.len());
    for key in obj.keys() {
        if !CANONICAL_KEYS.contains(&key.as_str()) {
            return Err(DecodeError::invalid(format!(
                "blob_ref has unknown key {key:?} (§5.9.1)"
            )));
        }
        present.push(key.as_str());
    }
    let expected: Vec<&str> = CANONICAL_KEYS
        .iter()
        .copied()
        .filter(|k| obj.contains_key(*k))
        .collect();
    if present != expected {
        return Err(DecodeError::invalid(
            "blob_ref keys are not in canonical order (§5.9.1)",
        ));
    }

    match obj.get("blobId").and_then(Value::as_str) {
        Some(id) if is_blob_id(id) => {}
        _ => {
            return Err(DecodeError::invalid(
                "blob_ref.blobId must be \"sha256:<64 hex>\" (§5.9.1)",
            ))
        }
    }
    match obj.get("byteLength") {
        Some(Value::Number(n)) if n.is_u64() || (n.is_i64() && n.as_i64().unwrap_or(-1) >= 0) => {}
        _ => {
            return Err(DecodeError::invalid(
                "blob_ref.byteLength must be a non-negative integer (§5.9.1)",
            ))
        }
    }
    if let Some(media) = obj.get("mediaType") {
        if !media.is_string() {
            return Err(DecodeError::invalid(
                "blob_ref.mediaType must be a string when present (§5.9.1)",
            ));
        }
    }
    if let Some(name) = obj.get("name") {
        if !name.is_string() {
            return Err(DecodeError::invalid(
                "blob_ref.name must be a string when present (§5.9.1)",
            ));
        }
    }
    Ok(())
}
