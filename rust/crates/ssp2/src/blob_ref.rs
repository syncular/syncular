//! Canonical BlobRef documents (SPEC.md §5.9.1) — the value a `blob_ref`
//! column (§2.4 tag 7) carries. Wire-shaped identically to `json` (a `str`);
//! decode accepts exactly the canonical text on every path, so the raw string
//! a decoder preserves for re-encoding is the canonical one.

use crate::error::{DecodeError, Result};
use crate::primitives::{parse_json_document, I64_SAFE_MAX};
use serde_json::Value;

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

/// The canonical serialization of BlobRef fields (§5.9.1): keys in the order
/// `blobId`, `byteLength`, `mediaType`, `name`, absent optional keys omitted,
/// no whitespace. `serde_json` escapes strings exactly as ECMAScript
/// `JSON.stringify` does for well-formed text, so the TS core's
/// `serializeBlobRef` produces the same bytes.
pub fn serialize_blob_ref(
    blob_id: &str,
    byte_length: i64,
    media_type: Option<&str>,
    name: Option<&str>,
) -> String {
    let text = |s: &str| serde_json::to_string(s).expect("a str always serializes");
    let mut out = format!(
        "{{\"blobId\":{},\"byteLength\":{byte_length}",
        text(blob_id)
    );
    if let Some(media_type) = media_type {
        out.push_str(&format!(",\"mediaType\":{}", text(media_type)));
    }
    if let Some(name) = name {
        out.push_str(&format!(",\"name\":{}", text(name)));
    }
    out.push('}');
    out
}

/// Validate a raw `blob_ref` string against §5.9.1: a valid JSON document
/// (Conventions JSON validity rule), the pinned shape, and text byte-identical
/// to [`serialize_blob_ref`] of the parsed fields. A failure is a decode error
/// (`sync.invalid_request`) on every decode path.
pub fn validate_blob_ref(raw: &str) -> Result<()> {
    let value = parse_json_document(raw, "blob_ref value")?;
    let obj = value
        .as_object()
        .ok_or_else(|| DecodeError::invalid("blob_ref value must be a JSON object (§5.9.1)"))?;
    if obj
        .keys()
        .any(|key| !matches!(key.as_str(), "blobId" | "byteLength" | "mediaType" | "name"))
    {
        return Err(DecodeError::invalid("blob_ref has an unknown key (§5.9.1)"));
    }
    let blob_id = match obj.get("blobId").and_then(Value::as_str) {
        Some(id) if is_blob_id(id) => id,
        _ => {
            return Err(DecodeError::invalid(
                "blob_ref.blobId must be \"sha256:<64 hex>\" (§5.9.1)",
            ))
        }
    };
    let byte_length = match obj.get("byteLength").and_then(Value::as_i64) {
        Some(v) if (0..=I64_SAFE_MAX).contains(&v) => v,
        _ => {
            return Err(DecodeError::invalid(
                "blob_ref.byteLength must be a non-negative integer within the safe-integer range (§5.9.1)",
            ))
        }
    };
    let optional_str = |key: &str| match obj.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(DecodeError::invalid(format!(
            "blob_ref.{key} must be a string when present (§5.9.1)"
        ))),
    };
    let media_type = optional_str("mediaType")?;
    let name = optional_str("name")?;
    // Reordered or duplicate keys, whitespace, and a byteLength written as
    // `1e2`, `3.0` or `-0` all differ from the canonical text.
    if serialize_blob_ref(blob_id, byte_length, media_type, name) != raw {
        return Err(DecodeError::invalid(
            "blob_ref is not in canonical form (§5.9.1)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{serialize_blob_ref, validate_blob_ref};

    fn blob_id() -> String {
        format!("sha256:{}", "ab".repeat(32))
    }

    #[test]
    fn serializes_in_the_pinned_key_order_with_json_stringify_escapes() {
        let id = blob_id();
        assert_eq!(
            serialize_blob_ref(
                &id,
                1024,
                Some("text/plain"),
                Some("\"q\" \\ \u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f} é 😀 \u{2028}"),
            ),
            format!(
                "{{\"blobId\":\"{id}\",\"byteLength\":1024,\"mediaType\":\"text/plain\",\"name\":\"\\\"q\\\" \\\\ \\b\\f\\n\\r\\t\\u0001\\u001f\u{7f} é 😀 \u{2028}\"}}"
            )
        );
    }

    #[test]
    fn accepts_canonical_text_with_and_without_the_optional_keys() {
        let id = blob_id();
        for raw in [
            serialize_blob_ref(&id, 0, None, None),
            serialize_blob_ref(&id, 9_007_199_254_740_991, None, Some("a.txt")),
            serialize_blob_ref(&id, 1, Some("image/png"), Some("")),
        ] {
            validate_blob_ref(&raw).unwrap_or_else(|e| panic!("{raw}: {}", e.detail));
        }
    }

    /// The same rejections as the TS core's `blob-ref.test.ts`.
    #[test]
    fn rejects_every_non_canonical_text() {
        let id = blob_id();
        let upper = format!("sha256:{}", "AB".repeat(32));
        let rejected = [
            (
                "reordered keys",
                format!(r#"{{"byteLength":1,"blobId":"{id}"}}"#),
            ),
            (
                "mediaType after name",
                format!(r#"{{"blobId":"{id}","byteLength":1,"name":"a","mediaType":"b"}}"#),
            ),
            (
                "byteLength 1e2",
                format!(r#"{{"blobId":"{id}","byteLength":1e2}}"#),
            ),
            (
                "byteLength 3.0",
                format!(r#"{{"blobId":"{id}","byteLength":3.0}}"#),
            ),
            (
                "byteLength -0",
                format!(r#"{{"blobId":"{id}","byteLength":-0}}"#),
            ),
            (
                "byteLength 01",
                format!(r#"{{"blobId":"{id}","byteLength":01}}"#),
            ),
            (
                "byteLength -1",
                format!(r#"{{"blobId":"{id}","byteLength":-1}}"#),
            ),
            (
                "byteLength 2^53",
                format!(r#"{{"blobId":"{id}","byteLength":9007199254740992}}"#),
            ),
            (
                "whitespace",
                format!(r#"{{"blobId": "{id}","byteLength":1}}"#),
            ),
            (
                "trailing newline",
                format!("{{\"blobId\":\"{id}\",\"byteLength\":1}}\n"),
            ),
            (
                "duplicate key",
                format!(r#"{{"blobId":"{id}","byteLength":1,"byteLength":1}}"#),
            ),
            (
                "non-canonical escape",
                format!(r#"{{"blobId":"{id}","byteLength":1,"name":"\u0061"}}"#),
            ),
            (
                "escaped slash",
                format!(r#"{{"blobId":"{id}","byteLength":1,"name":"a\/b"}}"#),
            ),
            (
                "unpaired surrogate name",
                format!(r#"{{"blobId":"{id}","byteLength":1,"name":"\ud800"}}"#),
            ),
            (
                "U+0000 name",
                format!(r#"{{"blobId":"{id}","byteLength":1,"name":"\u0000"}}"#),
            ),
            (
                "unknown key",
                format!(r#"{{"blobId":"{id}","byteLength":1,"x":1}}"#),
            ),
            (
                "uppercase hex",
                format!(r#"{{"blobId":"{upper}","byteLength":1}}"#),
            ),
            ("missing byteLength", format!(r#"{{"blobId":"{id}"}}"#)),
            (
                "numeric name",
                format!(r#"{{"blobId":"{id}","byteLength":1,"name":7}}"#),
            ),
            ("array", "[]".to_owned()),
        ];
        for (name, raw) in rejected {
            let error = validate_blob_ref(&raw)
                .err()
                .unwrap_or_else(|| panic!("{name}: accepted {raw}"));
            assert_eq!(error.code.as_str(), "sync.invalid_request", "{name}");
        }
    }
}
