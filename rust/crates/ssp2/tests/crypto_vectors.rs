//! §5.11 crypto golden vectors: the Rust core reproduces every committed
//! envelope byte-for-byte and round-trips decrypt/unwrap (SPEC.md Appendix A
//! #22–23). This is the cross-core CI gate against the TS reference.
#![cfg(feature = "e2ee")]

use serde_json::Value;
use ssp2::crypto::{decrypt_value, encrypt_value, DeclaredType, PlainValue};
use ssp2::wrap::unwrap_key;

fn hex_to_bytes(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn load() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../spec/vectors/crypto/vectors.json");
    let text = std::fs::read_to_string(path).expect("read crypto vectors");
    serde_json::from_str(&text).expect("parse crypto vectors")
}

/// Rebuild the declared-type value from the recorded plaintext bytes so the
/// Rust core can re-encrypt with the fixed nonce and match `envelopeHex`.
fn value_from(declared: DeclaredType, value_bytes: &[u8]) -> PlainValue {
    match declared {
        DeclaredType::String => {
            PlainValue::String(String::from_utf8(value_bytes.to_vec()).unwrap())
        }
        DeclaredType::Json => {
            PlainValue::Json(String::from_utf8(value_bytes.to_vec()).unwrap())
        }
        DeclaredType::BlobRef => {
            PlainValue::BlobRef(String::from_utf8(value_bytes.to_vec()).unwrap())
        }
        DeclaredType::Integer => {
            let mut a = [0u8; 8];
            a.copy_from_slice(value_bytes);
            PlainValue::Integer(i64::from_le_bytes(a))
        }
        DeclaredType::Float => {
            let mut a = [0u8; 8];
            a.copy_from_slice(value_bytes);
            PlainValue::Float(f64::from_le_bytes(a))
        }
        DeclaredType::Boolean => PlainValue::Boolean(value_bytes[0] == 1),
        DeclaredType::Bytes => PlainValue::Bytes(value_bytes.to_vec()),
    }
}

#[test]
fn aes_gcm_vectors_match_byte_for_byte() {
    let doc = load();
    let key = hex_to_bytes(doc["keyHex"].as_str().unwrap());
    let nonce_bytes = hex_to_bytes(doc["nonceHex"].as_str().unwrap());
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&nonce_bytes);
    for case in doc["aesGcm"].as_array().unwrap() {
        let declared =
            DeclaredType::from_name(case["declaredType"].as_str().unwrap()).unwrap();
        let value_bytes = hex_to_bytes(case["valueHex"].as_str().unwrap());
        let value = value_from(declared, &value_bytes);
        let key_id = case["keyId"].as_str().unwrap();
        let env = encrypt_value(&value, key_id, &key, nonce).unwrap();
        assert_eq!(
            hex(&env),
            case["envelopeHex"].as_str().unwrap(),
            "envelope mismatch for {}",
            case["name"]
        );
        // Round-trip decrypt the committed envelope.
        let committed = hex_to_bytes(case["envelopeHex"].as_str().unwrap());
        let key2 = key.clone();
        let back = decrypt_value(declared, &committed, |id| {
            if id == key_id {
                Some(key2.clone())
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(back, value, "decrypt round-trip for {}", case["name"]);
    }
}

#[test]
fn x25519_wrap_vector_unwraps() {
    let doc = load();
    let w = &doc["x25519Wrap"];
    let recipient_priv_v = hex_to_bytes(w["recipientPrivHex"].as_str().unwrap());
    let mut recipient_priv = [0u8; 32];
    recipient_priv.copy_from_slice(&recipient_priv_v);
    let envelope = hex_to_bytes(w["envelopeHex"].as_str().unwrap());
    let key = unwrap_key(&envelope, &recipient_priv).unwrap();
    assert_eq!(hex(&key), w["symmetricKeyHex"].as_str().unwrap());
}
