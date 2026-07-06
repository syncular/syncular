//! §5.11 asymmetric ("async") encryption — X25519 sealed-box key wrapping.
//!
//! Utilities (not wire protocol) to share a 32-byte symmetric key to a
//! recipient's X25519 public key. Byte-identical to the TS `@syncular/crypto`
//! implementation. The wrap envelope is:
//!
//! `0x01 | ephemeralPublic(32) | nonce(12) | wrapped (K.len + 16)`
//!
//! where `wrapKey = HKDF-SHA256(ikm = X25519(e, P), salt = "",
//! info = "syncular/e2ee/x25519-wrap/v1", len = 32)` and `wrapped =
//! AES-256-GCM(wrapKey, nonce, K)`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::crypto::{DecryptError, ENVELOPE_VERSION, NONCE_LENGTH};

pub const HKDF_INFO: &[u8] = b"syncular/e2ee/x25519-wrap/v1";

/// Generate an X25519 keypair: `(private 32 bytes, public 32 bytes)`.
pub fn generate_keypair() -> ([u8; 32], [u8; 32]) {
    let secret = StaticSecret::random_from_rng(rand_core::OsRng);
    let public = PublicKey::from(&secret);
    (secret.to_bytes(), public.to_bytes())
}

/// Public key for a given private key.
pub fn public_from_private(private: &[u8; 32]) -> [u8; 32] {
    let secret = StaticSecret::from(*private);
    PublicKey::from(&secret).to_bytes()
}

fn derive_wrap_key(shared: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(&[]), shared);
    let mut out = [0u8; 32];
    hk.expand(HKDF_INFO, &mut out)
        .expect("32 is a valid length");
    out
}

/// Wrap a 32-byte symmetric key `k` to a recipient public key, using a
/// caller-supplied ephemeral secret and nonce (production supplies random
/// ones; vectors inject fixed ones for determinism).
pub fn wrap_key_with(
    k: &[u8],
    recipient_public: &[u8; 32],
    ephemeral_secret: [u8; 32],
    nonce: [u8; NONCE_LENGTH],
) -> Result<Vec<u8>, String> {
    let e = StaticSecret::from(ephemeral_secret);
    let e_pub = PublicKey::from(&e);
    let shared = e.diffie_hellman(&PublicKey::from(*recipient_public));
    let wrap_key = derive_wrap_key(shared.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| format!("bad key: {e}"))?;
    let wrapped = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: k, aad: &[] })
        .map_err(|e| format!("wrap encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(1 + 32 + NONCE_LENGTH + wrapped.len());
    out.push(ENVELOPE_VERSION);
    out.extend_from_slice(e_pub.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&wrapped);
    Ok(out)
}

/// Wrap with random ephemeral secret + nonce (production path).
pub fn wrap_key(k: &[u8], recipient_public: &[u8; 32]) -> Result<Vec<u8>, String> {
    use rand_core::RngCore;
    let mut eph = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut eph);
    let mut nonce = [0u8; NONCE_LENGTH];
    rand_core::OsRng.fill_bytes(&mut nonce);
    wrap_key_with(k, recipient_public, eph, nonce)
}

/// Unwrap a wrap envelope with the recipient's private key, recovering `K`.
pub fn unwrap_key(envelope: &[u8], recipient_private: &[u8; 32]) -> Result<Vec<u8>, DecryptError> {
    if envelope.len() < 1 + 32 + NONCE_LENGTH + 16 {
        return Err(DecryptError("wrap envelope truncated".to_owned()));
    }
    if envelope[0] != ENVELOPE_VERSION {
        return Err(DecryptError(format!(
            "unknown wrap envelope version 0x{:02x}",
            envelope[0]
        )));
    }
    let mut e_pub = [0u8; 32];
    e_pub.copy_from_slice(&envelope[1..33]);
    let mut nonce = [0u8; NONCE_LENGTH];
    nonce.copy_from_slice(&envelope[33..33 + NONCE_LENGTH]);
    let wrapped = &envelope[33 + NONCE_LENGTH..];
    let recipient = StaticSecret::from(*recipient_private);
    let shared = recipient.diffie_hellman(&PublicKey::from(e_pub));
    let wrap_key = derive_wrap_key(shared.as_bytes());
    let cipher =
        Aes256Gcm::new_from_slice(&wrap_key).map_err(|e| DecryptError(format!("bad key: {e}")))?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: wrapped,
                aad: &[],
            },
        )
        .map_err(|_| DecryptError("wrap GCM authentication failed".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_unwrap_round_trip() {
        let (priv_k, pub_k) = generate_keypair();
        let key = [42u8; 32];
        let env = wrap_key(&key, &pub_k).unwrap();
        let back = unwrap_key(&env, &priv_k).unwrap();
        assert_eq!(back, key.to_vec());
    }

    #[test]
    fn wrong_recipient_fails() {
        let (_priv_a, pub_a) = generate_keypair();
        let (priv_b, _pub_b) = generate_keypair();
        let env = wrap_key(&[1u8; 32], &pub_a).unwrap();
        assert!(unwrap_key(&env, &priv_b).is_err());
    }
}
