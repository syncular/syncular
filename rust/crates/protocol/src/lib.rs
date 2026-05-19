use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const COMMIT_INTEGRITY_HEX_LENGTH: usize = 64;
pub const COMMIT_INTEGRITY_GENESIS_ROOT: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";
pub const WIRE_COMMIT_DIGEST_VERSION: &str = "syncular-wire-commit-digest-v1";
pub const WIRE_COMMIT_CHAIN_ROOT_VERSION: &str = "syncular-wire-commit-chain-root-v1";

pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn canonical_json_string(value: &Value) -> Result<String, serde_json::Error> {
    let mut out = String::new();
    append_canonical_json(&mut out, value)?;
    Ok(out)
}

pub fn append_canonical_json(out: &mut String, value: &Value) -> Result<(), serde_json::Error> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => out.push_str(&value.to_string()),
        Value::String(value) => out.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            out.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                append_canonical_json(out, item)?;
            }
            out.push(']');
        }
        Value::Object(values) => {
            append_canonical_object(out, values)?;
        }
    }
    Ok(())
}

pub fn append_canonical_object(
    out: &mut String,
    values: &Map<String, Value>,
) -> Result<(), serde_json::Error> {
    let mut keys = values.keys().collect::<Vec<_>>();
    keys.sort();
    out.push('{');
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key)?);
        out.push(':');
        append_canonical_json(
            out,
            values
                .get(key)
                .expect("serde_json object key should resolve"),
        )?;
    }
    out.push('}');
    Ok(())
}
