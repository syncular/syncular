use serde_json::Value;
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
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(value) => Ok(if *value { "true" } else { "false" }.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => serde_json::to_string(value),
        Value::Array(values) => {
            let mut out = String::from("[");
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&canonical_json_string(item)?);
            }
            out.push(']');
            Ok(out)
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key)?);
                out.push(':');
                out.push_str(&canonical_json_string(
                    values
                        .get(key)
                        .expect("serde_json object key should resolve"),
                )?);
            }
            out.push('}');
            Ok(out)
        }
    }
}
