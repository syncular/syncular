/**
 * Key sharing utilities for human-friendly key exchange.
 *
 * Supports:
 * - BIP39 mnemonic phrases (24 words for 32-byte keys)
 * - URL-safe encoding for QR codes
 * - X25519 keypairs for asymmetric key wrapping
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { isRecord } from '@syncular/core';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  randomBytes,
} from './crypto-utils';

const WORD_SET = new Set(wordlist);

// ============================================================================
// Utility Functions
// ============================================================================

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function isAllZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function validateSharedSecret(sharedSecret: Uint8Array): void {
  // Reject all-zero shared secrets which indicate a low-order point attack.
  // This can happen if a malicious party provides a small-order public key.
  if (isAllZero(sharedSecret)) {
    throw new Error(
      'X25519 shared secret is all zeros - possible low-order point attack'
    );
  }
}

// ============================================================================
// Symmetric Key Utilities
// ============================================================================

/**
 * Generate a cryptographically secure 32-byte symmetric key.
 */
export function generateSymmetricKey(): Uint8Array {
  return randomBytes(32);
}

/**
 * Convert a 32-byte key to a 24-word BIP39 mnemonic phrase.
 *
 * The same key always produces the same words (deterministic).
 */
export function keyToMnemonic(key: Uint8Array): string {
  if (key.length !== 32) {
    throw new Error(`Key must be 32 bytes, got ${key.length}`);
  }
  return entropyToMnemonic(key, wordlist);
}

/**
 * Parse a BIP39 mnemonic phrase back to key bytes.
 *
 * @throws If the mnemonic is invalid or has wrong word count
 */
export function normalizeMnemonicInput(phrase: string): string {
  const normalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return normalized;

  // Keep valid word tokens only so pasted numbered lists like
  // "1 word 2 word ..." still recover cleanly.
  const tokenizedWords = (normalized.match(/[a-z]+/g) ?? []).filter((word) =>
    WORD_SET.has(word)
  );

  if (tokenizedWords.length === 24) return tokenizedWords.join(' ');
  if (tokenizedWords.length > 24) {
    for (let i = 0; i <= tokenizedWords.length - 24; i++) {
      const candidate = tokenizedWords.slice(i, i + 24).join(' ');
      try {
        mnemonicToEntropy(candidate, wordlist);
        return candidate;
      } catch {
        // Continue scanning for a valid 24-word window.
      }
    }
  }

  return normalized;
}

export function mnemonicToKey(phrase: string): Uint8Array {
  const normalized = normalizeMnemonicInput(phrase);
  const entropy = mnemonicToEntropy(normalized, wordlist);
  if (entropy.length !== 32) {
    throw new Error(
      `Expected 24-word mnemonic (32 bytes), got ${entropy.length} bytes`
    );
  }
  return entropy;
}

/**
 * Encode a key as URL-safe base64 (for QR codes).
 */
export function keyToBase64Url(key: Uint8Array): string {
  return bytesToBase64Url(key);
}

/**
 * Decode URL-safe base64 back to key bytes.
 */
export function base64UrlToKey(encoded: string): Uint8Array {
  const key = base64UrlToBytes(encoded);
  if (key.length !== 32) {
    throw new Error(`Invalid key length: expected 32 bytes, got ${key.length}`);
  }
  return key;
}

// ============================================================================
// X25519 Keypair Utilities
// ============================================================================

interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generate an X25519 keypair for key exchange.
 *
 * Store privateKey securely. Share publicKey freely.
 */
export function generateKeypair(): KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Convert a 32-byte public key to a 24-word mnemonic.
 */
export function publicKeyToMnemonic(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Public key must be 32 bytes, got ${publicKey.length}`);
  }
  return entropyToMnemonic(publicKey, wordlist);
}

/**
 * Parse a mnemonic back to a public key.
 */
export function mnemonicToPublicKey(phrase: string): Uint8Array {
  return mnemonicToKey(phrase);
}

// ============================================================================
// Key Wrapping (Envelope Encryption)
// ============================================================================

interface WrappedKey {
  /** Sender's ephemeral public key (32 bytes) */
  ephemeralPublic: Uint8Array;
  /** Encrypted symmetric key + auth tag (48 bytes) */
  ciphertext: Uint8Array;
}

const HKDF_INFO = new TextEncoder().encode('syncular-key-wrap-v1');

/**
 * Wrap a symmetric key for a recipient using their public key.
 *
 * Uses X25519 ECDH + HKDF + XChaCha20-Poly1305.
 */
export function wrapKeyForRecipient(
  recipientPublicKey: Uint8Array,
  symmetricKey: Uint8Array
): WrappedKey {
  if (recipientPublicKey.length !== 32) {
    throw new Error('Recipient public key must be 32 bytes');
  }
  if (symmetricKey.length !== 32) {
    throw new Error('Symmetric key must be 32 bytes');
  }

  // Generate ephemeral keypair
  const ephemeralPrivate = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

  // ECDH shared secret
  const sharedSecret = x25519.getSharedSecret(
    ephemeralPrivate,
    recipientPublicKey
  );

  // Reject low-order points that would result in all-zero shared secret
  validateSharedSecret(sharedSecret);

  // Derive wrapping key using HKDF
  const wrappingKey = hkdf(
    sha256,
    sharedSecret,
    ephemeralPublic,
    HKDF_INFO,
    32
  );

  // Encrypt the symmetric key
  const nonce = randomBytes(24);
  const aead = xchacha20poly1305(wrappingKey, nonce);
  const encrypted = aead.encrypt(symmetricKey);

  // Ciphertext = nonce + encrypted (24 + 32 + 16 = 72 bytes)
  const ciphertext = concatBytes(nonce, encrypted);

  return { ephemeralPublic, ciphertext };
}

/**
 * Unwrap a key using your private key.
 */
export function unwrapKey(
  myPrivateKey: Uint8Array,
  wrapped: WrappedKey
): Uint8Array {
  if (myPrivateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }
  if (wrapped.ephemeralPublic.length !== 32) {
    throw new Error('Ephemeral public key must be 32 bytes');
  }
  if (wrapped.ciphertext.length !== 72) {
    throw new Error(
      'Ciphertext must be 72 bytes (nonce + encrypted key + tag)'
    );
  }

  // ECDH shared secret
  const sharedSecret = x25519.getSharedSecret(
    myPrivateKey,
    wrapped.ephemeralPublic
  );

  // Reject low-order points that would result in all-zero shared secret
  validateSharedSecret(sharedSecret);

  // Derive wrapping key using HKDF
  const wrappingKey = hkdf(
    sha256,
    sharedSecret,
    wrapped.ephemeralPublic,
    HKDF_INFO,
    32
  );

  // Extract nonce and encrypted data
  const nonce = wrapped.ciphertext.slice(0, 24);
  const encrypted = wrapped.ciphertext.slice(24);

  // Decrypt
  const aead = xchacha20poly1305(wrappingKey, nonce);
  return aead.decrypt(encrypted);
}

/**
 * Serialize a wrapped key for storage/transmission.
 */
export function encodeWrappedKey(wrapped: WrappedKey): string {
  const combined = concatBytes(wrapped.ephemeralPublic, wrapped.ciphertext);
  return bytesToBase64Url(combined);
}

/**
 * Deserialize a wrapped key.
 */
export function decodeWrappedKey(encoded: string): WrappedKey {
  const combined = base64UrlToBytes(encoded);
  if (combined.length !== 104) {
    throw new Error(
      `Invalid wrapped key length: expected 104 bytes, got ${combined.length}`
    );
  }
  return {
    ephemeralPublic: combined.slice(0, 32),
    ciphertext: combined.slice(32),
  };
}

// ============================================================================
// Share URL Format
// ============================================================================

const SHARE_URL_PREFIX = 'sync://';

interface SymmetricKeyShare {
  type: 'symmetric';
  key: Uint8Array;
  kid?: string;
}

interface PublicKeyShare {
  type: 'publicKey';
  publicKey: Uint8Array;
}

type ParsedShare = SymmetricKeyShare | PublicKeyShare;

/**
 * Encode a symmetric key as a shareable URL.
 *
 * Format: sync://k/1/<base64url>[/<kid>]
 */
export function keyToShareUrl(key: Uint8Array, kid?: string): string {
  const encoded = bytesToBase64Url(key);
  const kidPart = kid ? `/${encodeURIComponent(kid)}` : '';
  return `${SHARE_URL_PREFIX}k/1/${encoded}${kidPart}`;
}

/**
 * Encode a public key as a shareable URL.
 *
 * Format: sync://pk/1/<base64url>
 */
export function publicKeyToShareUrl(publicKey: Uint8Array): string {
  const encoded = bytesToBase64Url(publicKey);
  return `${SHARE_URL_PREFIX}pk/1/${encoded}`;
}

/**
 * Parse a share URL back to typed result.
 */
export function parseShareUrl(url: string): ParsedShare {
  if (!url.startsWith(SHARE_URL_PREFIX)) {
    throw new Error(`Invalid share URL: must start with ${SHARE_URL_PREFIX}`);
  }

  const rest = url.slice(SHARE_URL_PREFIX.length);
  const parts = rest.split('/');

  if (parts.length < 3) {
    throw new Error('Invalid share URL format');
  }

  const [type, version, encoded, kidEncoded] = parts;

  if (version !== '1') {
    throw new Error(`Unsupported share URL version: ${version}`);
  }

  if (!encoded) {
    throw new Error('Invalid share URL: missing encoded key data');
  }

  if (type === 'k') {
    const key = base64UrlToKey(encoded);
    const kid = kidEncoded ? decodeURIComponent(kidEncoded) : undefined;
    return { type: 'symmetric', key, kid };
  }

  if (type === 'pk') {
    const publicKey = base64UrlToKey(encoded);
    return { type: 'publicKey', publicKey };
  }

  throw new Error(`Unknown share URL type: ${type}`);
}

// ============================================================================
// JSON Format
// ============================================================================

interface SymmetricKeyJson {
  type: 'symmetric';
  kid?: string;
  k: string;
}

interface PublicKeyJson {
  type: 'publicKey';
  pk: string;
}

/**
 * Encode a symmetric key as JSON.
 */
export function keyToJson(key: Uint8Array, kid?: string): SymmetricKeyJson {
  return {
    type: 'symmetric',
    ...(kid && { kid }),
    k: bytesToBase64Url(key),
  };
}

/**
 * Encode a public key as JSON.
 */
export function publicKeyToJson(publicKey: Uint8Array): PublicKeyJson {
  return {
    type: 'publicKey',
    pk: bytesToBase64Url(publicKey),
  };
}

/**
 * Parse a JSON key share string.
 */
export function parseKeyShareJson(json: string): ParsedShare {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(json);
  } catch {
    throw new Error('Invalid key share JSON');
  }

  if (!isRecord(parsedValue)) {
    throw new Error('Invalid key share JSON');
  }

  const parsedType = parsedValue.type;

  if (parsedType === 'symmetric') {
    const keyMaterial = parsedValue.k;
    if (typeof keyMaterial !== 'string') {
      throw new Error('Invalid symmetric key share JSON');
    }
    const kidValue = parsedValue.kid;
    if (kidValue !== undefined && typeof kidValue !== 'string') {
      throw new Error('Invalid symmetric key share JSON');
    }
    return {
      type: 'symmetric',
      key: base64UrlToKey(keyMaterial),
      kid: kidValue,
    };
  }

  if (parsedType === 'publicKey') {
    const publicKeyMaterial = parsedValue.pk;
    if (typeof publicKeyMaterial !== 'string') {
      throw new Error('Invalid public key share JSON');
    }
    return {
      type: 'publicKey',
      publicKey: base64UrlToKey(publicKeyMaterial),
    };
  }

  throw new Error(`Unknown key share type: ${String(parsedType)}`);
}
