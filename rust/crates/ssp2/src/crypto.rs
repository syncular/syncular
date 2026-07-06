//! Client-side encryption primitives (SPEC.md §5.11) — the Rust half of the
//! cross-core §5.11 contract, byte-identical to `@syncular/core`'s `crypto.ts`.
//!
//! The ciphertext envelope, the declared-type value serializer, and
//! AES-256-GCM encrypt/decrypt. The row codec (`segment.rs`) never touches
//! this: an encrypted column has wire type `bytes` and the client's
//! encode/apply seam runs these functions on the plaintext value before/after
//! the codec. X25519 sealed-box key wrapping (the async-encryption utilities)
//! lives in `wrap.rs`.
//!
//! Gated behind the `e2ee` feature so lean builds skip the crypto crates.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

/// Envelope version byte (§5.11).
pub const ENVELOPE_VERSION: u8 = 0x01;
/// AES-GCM nonce length (96-bit).
pub const NONCE_LENGTH: usize = 12;
/// AES-256 key length.
pub const KEY_LENGTH: usize = 32;

/// The pre-flip declared type of an encrypted column (§5.11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeclaredType {
    String,
    Integer,
    Float,
    Boolean,
    Json,
    BlobRef,
    Bytes,
}

impl DeclaredType {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "string" => Some(DeclaredType::String),
            "integer" => Some(DeclaredType::Integer),
            "float" => Some(DeclaredType::Float),
            "boolean" => Some(DeclaredType::Boolean),
            "json" => Some(DeclaredType::Json),
            "blob_ref" => Some(DeclaredType::BlobRef),
            "bytes" => Some(DeclaredType::Bytes),
            _ => None,
        }
    }
}

/// A non-null declared-type value (mirrors ssp2 `ColumnValue`, minus crdt).
#[derive(Debug, Clone, PartialEq)]
pub enum PlainValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    /// raw JSON document string (preserved verbatim, §2.4 tag 5)
    Json(String),
    /// raw canonical BlobRef string (§5.9.1)
    BlobRef(String),
    Bytes(Vec<u8>),
}

/// A §5.11 decrypt failure — `client.decrypt_failed`, never on the wire.
#[derive(Debug, Clone)]
pub struct DecryptError(pub String);

impl std::fmt::Display for DecryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "client.decrypt_failed: {}", self.0)
    }
}
impl std::error::Error for DecryptError {}

// -- value serializer: declared type ⇄ canonical plaintext bytes (§5.11) -----

/// Serialize a declared-type value to the canonical plaintext bytes fed to
/// GCM (§5.11 value serializer). Byte-identical to `serializePlain` in TS.
pub fn serialize_plain(value: &PlainValue) -> Result<Vec<u8>, String> {
    Ok(match value {
        PlainValue::String(s) | PlainValue::Json(s) | PlainValue::BlobRef(s) => {
            s.as_bytes().to_vec()
        }
        PlainValue::Integer(i) => i.to_le_bytes().to_vec(),
        PlainValue::Float(f) => f.to_le_bytes().to_vec(),
        PlainValue::Boolean(b) => vec![if *b { 1 } else { 0 }],
        PlainValue::Bytes(b) => b.clone(),
    })
}

/// Parse decrypted plaintext bytes back to a declared-type value (§5.11).
pub fn deserialize_plain(declared: DeclaredType, bytes: &[u8]) -> Result<PlainValue, DecryptError> {
    match declared {
        DeclaredType::String | DeclaredType::Json | DeclaredType::BlobRef => {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| DecryptError("decrypted value is not valid UTF-8".to_owned()))?
                .to_owned();
            if declared == DeclaredType::Json {
                serde_json::from_str::<serde_json::Value>(&text)
                    .map_err(|_| DecryptError("decrypted json does not parse".to_owned()))?;
                Ok(PlainValue::Json(text))
            } else if declared == DeclaredType::BlobRef {
                Ok(PlainValue::BlobRef(text))
            } else {
                Ok(PlainValue::String(text))
            }
        }
        DeclaredType::Integer => {
            if bytes.len() != 8 {
                return Err(DecryptError("decrypted integer must be 8 bytes".to_owned()));
            }
            let mut a = [0u8; 8];
            a.copy_from_slice(bytes);
            Ok(PlainValue::Integer(i64::from_le_bytes(a)))
        }
        DeclaredType::Float => {
            if bytes.len() != 8 {
                return Err(DecryptError("decrypted float must be 8 bytes".to_owned()));
            }
            let mut a = [0u8; 8];
            a.copy_from_slice(bytes);
            Ok(PlainValue::Float(f64::from_le_bytes(a)))
        }
        DeclaredType::Boolean => {
            if bytes.len() != 1 || (bytes[0] != 0 && bytes[0] != 1) {
                return Err(DecryptError(
                    "decrypted boolean must be one 0x00/0x01 byte".to_owned(),
                ));
            }
            Ok(PlainValue::Boolean(bytes[0] == 1))
        }
        DeclaredType::Bytes => Ok(PlainValue::Bytes(bytes.to_vec())),
    }
}

// -- envelope: 0x01 | keyIdLen | keyId | nonce(12) | ct+tag  (§5.11) ---------

pub struct Envelope {
    pub key_id: String,
    pub nonce: [u8; NONCE_LENGTH],
    /// ciphertext with the 16-byte GCM tag appended.
    pub ciphertext: Vec<u8>,
}

pub fn encode_envelope(env: &Envelope) -> Result<Vec<u8>, String> {
    let key_id_bytes = env.key_id.as_bytes();
    if key_id_bytes.len() > 0xff {
        return Err("keyId exceeds 255 UTF-8 bytes".to_owned());
    }
    let mut out = Vec::with_capacity(2 + key_id_bytes.len() + NONCE_LENGTH + env.ciphertext.len());
    out.push(ENVELOPE_VERSION);
    out.push(key_id_bytes.len() as u8);
    out.extend_from_slice(key_id_bytes);
    out.extend_from_slice(&env.nonce);
    out.extend_from_slice(&env.ciphertext);
    Ok(out)
}

pub fn decode_envelope(bytes: &[u8]) -> Result<Envelope, DecryptError> {
    if bytes.len() < 2 {
        return Err(DecryptError("envelope truncated".to_owned()));
    }
    if bytes[0] != ENVELOPE_VERSION {
        return Err(DecryptError(format!(
            "unknown envelope version 0x{:02x}",
            bytes[0]
        )));
    }
    let key_id_len = bytes[1] as usize;
    let key_id_end = 2 + key_id_len;
    let nonce_end = key_id_end + NONCE_LENGTH;
    if bytes.len() < nonce_end + 16 {
        return Err(DecryptError("envelope truncated".to_owned()));
    }
    let key_id = std::str::from_utf8(&bytes[2..key_id_end])
        .map_err(|_| DecryptError("keyId is not valid UTF-8".to_owned()))?
        .to_owned();
    let mut nonce = [0u8; NONCE_LENGTH];
    nonce.copy_from_slice(&bytes[key_id_end..nonce_end]);
    Ok(Envelope {
        key_id,
        nonce,
        ciphertext: bytes[nonce_end..].to_vec(),
    })
}

// -- AES-256-GCM --------------------------------------------------------------

fn cipher(key: &[u8]) -> Result<Aes256Gcm, String> {
    if key.len() != KEY_LENGTH {
        return Err(format!("AES-256-GCM key must be {KEY_LENGTH} bytes"));
    }
    Aes256Gcm::new_from_slice(key).map_err(|e| format!("bad key: {e}"))
}

/// Encrypt one declared-type value into a §5.11 envelope with a caller-supplied
/// nonce (production supplies a CSPRNG nonce; vectors inject a fixed nonce).
pub fn encrypt_value(
    value: &PlainValue,
    key_id: &str,
    key: &[u8],
    nonce: [u8; NONCE_LENGTH],
) -> Result<Vec<u8>, String> {
    let plaintext = serialize_plain(value)?;
    let ct = cipher(key)?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &[],
            },
        )
        .map_err(|e| format!("aes-gcm encrypt failed: {e}"))?;
    encode_envelope(&Envelope {
        key_id: key_id.to_owned(),
        nonce,
        ciphertext: ct,
    })
}

/// Decrypt a §5.11 envelope back to a declared-type value. `key_provider`
/// resolves the envelope's `keyId`; a missing key or GCM tag mismatch is a
/// `DecryptError` (`client.decrypt_failed`).
pub fn decrypt_value(
    declared: DeclaredType,
    envelope_bytes: &[u8],
    key_provider: impl Fn(&str) -> Option<Vec<u8>>,
) -> Result<PlainValue, DecryptError> {
    let env = decode_envelope(envelope_bytes)?;
    let key = key_provider(&env.key_id)
        .ok_or_else(|| DecryptError(format!("no key for keyId {:?}", env.key_id)))?;
    let c = cipher(&key).map_err(DecryptError)?;
    let plaintext = c
        .decrypt(
            Nonce::from_slice(&env.nonce),
            Payload {
                msg: &env.ciphertext,
                aad: &[],
            },
        )
        .map_err(|_| {
            DecryptError(format!(
                "GCM authentication failed for keyId {:?} (wrong key or corrupt ciphertext)",
                env.key_id
            ))
        })?;
    deserialize_plain(declared, &plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];
    const NONCE: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

    fn provider(id: &str) -> Option<Vec<u8>> {
        if id == "k1" {
            Some(KEY.to_vec())
        } else {
            None
        }
    }

    #[test]
    fn round_trips_every_declared_type() {
        let cases = vec![
            (
                DeclaredType::String,
                PlainValue::String("hello 🔐".to_owned()),
            ),
            (DeclaredType::Json, PlainValue::Json("{\"a\":1}".to_owned())),
            (
                DeclaredType::BlobRef,
                PlainValue::BlobRef("{\"blobId\":\"x\"}".to_owned()),
            ),
            (DeclaredType::Integer, PlainValue::Integer(9007199254740991)),
            (
                DeclaredType::Integer,
                PlainValue::Integer(-9007199254740991),
            ),
            (DeclaredType::Float, PlainValue::Float(3.141592653589793)),
            (DeclaredType::Boolean, PlainValue::Boolean(true)),
            (DeclaredType::Bytes, PlainValue::Bytes(vec![0xde, 0xad])),
        ];
        for (ty, value) in cases {
            let env = encrypt_value(&value, "k1", &KEY, NONCE).unwrap();
            assert_eq!(env[0], ENVELOPE_VERSION);
            let back = decrypt_value(ty, &env, provider).unwrap();
            assert_eq!(back, value);
        }
    }

    #[test]
    fn wrong_key_fails() {
        let env = encrypt_value(&PlainValue::String("s".to_owned()), "k1", &KEY, NONCE).unwrap();
        let bad = decrypt_value(DeclaredType::String, &env, |id| {
            if id == "k1" {
                Some(vec![9u8; 32])
            } else {
                None
            }
        });
        assert!(bad.is_err());
    }

    #[test]
    fn fixed_nonce_is_deterministic() {
        let a = encrypt_value(&PlainValue::String("x".to_owned()), "k1", &KEY, NONCE).unwrap();
        let b = encrypt_value(&PlainValue::String("x".to_owned()), "k1", &KEY, NONCE).unwrap();
        assert_eq!(a, b);
    }
}
