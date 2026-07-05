/**
 * Client-side encryption primitives (SPEC.md §5.11).
 *
 * The byte-exact ciphertext envelope, the declared-type value serializer,
 * and AES-256-GCM encrypt/decrypt over WebCrypto (a global — this keeps
 * `@syncular/core` dependency-free). These are the codec-level pieces shared
 * by the wire boundary: the client encrypts a configured column's plaintext
 * value here before the row codec (§2.4) sees it as a `bytes` value, and
 * decrypts on apply. The row codec itself never touches this file.
 *
 * X25519 sealed-box key wrapping (the "async encryption" utilities) lives in
 * `@syncular/crypto` (it needs an audited curve implementation); this module
 * is the symmetric core and the envelope both sides agree on byte-for-byte.
 */
import { ByteReader, ByteWriter } from './bytes';

/** The pre-flip application type of an encrypted column (SPEC.md §5.11). */
export type DeclaredType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'blob_ref'
  | 'bytes';

/** A non-null row value, per the declared type. `crdt` is never encrypted. */
export type PlainValue = string | number | boolean | Uint8Array;

/** Envelope version byte (SPEC.md §5.11). */
export const ENVELOPE_VERSION = 0x01;

/** AES-GCM nonce length (96-bit, the GCM standard). */
export const NONCE_LENGTH = 12;

/** Symmetric key length: AES-256. */
export const KEY_LENGTH = 32;

/**
 * Client-local decrypt failure (SPEC.md §5.11, §10.3). Never on the wire —
 * the `client.` family is client-only. Raised at the apply seam for an
 * unknown envelope version, unknown `keyId`, GCM auth failure (wrong key), a
 * malformed envelope, or a post-decrypt value-parse failure. Not retryable.
 */
export class DecryptError extends Error {
  override readonly name = 'DecryptError';
  readonly code = 'client.decrypt_failed';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
  }
}

/**
 * Injectable nonce source (SPEC.md §5.11 nonce discipline). Production uses
 * {@link secureRandomNonce}; crypto golden vectors inject a fixed nonce. A
 * fixed nonce MUST NOT be reachable from a production encode path.
 */
export type NonceSource = () => Uint8Array;

export function secureRandomNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH);
  crypto.getRandomValues(nonce);
  return nonce;
}

// ---------------------------------------------------------------------------
// Value serializer — declared type ⇄ canonical plaintext bytes (§5.11)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Serialize a declared-type value to the canonical plaintext bytes fed to
 * GCM (SPEC.md §5.11 value serializer). Not a re-run of the row codec — this
 * is the self-describing per-`declaredType` encoding both cores agree on.
 */
export function serializePlain(
  declaredType: DeclaredType,
  value: PlainValue,
): Uint8Array {
  switch (declaredType) {
    case 'string':
    case 'json':
    case 'blob_ref':
      if (typeof value !== 'string') {
        throw new Error(`encrypted ${declaredType} column requires a string`);
      }
      return textEncoder.encode(value);
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error('encrypted integer column requires a safe integer');
      }
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
      return out;
    }
    case 'float': {
      if (typeof value !== 'number') {
        throw new Error('encrypted float column requires a number');
      }
      const out = new Uint8Array(8);
      new DataView(out.buffer).setFloat64(0, value, true);
      return out;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error('encrypted boolean column requires a boolean');
      }
      return new Uint8Array([value ? 1 : 0]);
    case 'bytes':
      if (!(value instanceof Uint8Array)) {
        throw new Error('encrypted bytes column requires a Uint8Array');
      }
      return value;
  }
}

/**
 * Parse the decrypted plaintext bytes back to a declared-type value (SPEC.md
 * §5.11). A `json`/`blob_ref` value is re-validated as the row codec would
 * (§2.4); any parse failure is a decrypt failure.
 */
export function deserializePlain(
  declaredType: DeclaredType,
  bytes: Uint8Array,
): PlainValue {
  switch (declaredType) {
    case 'string':
    case 'json':
    case 'blob_ref': {
      let text: string;
      try {
        text = textDecoder.decode(bytes);
      } catch {
        throw new DecryptError(
          `decrypted ${declaredType} value is not valid UTF-8`,
        );
      }
      if (declaredType === 'json') {
        try {
          JSON.parse(text);
        } catch {
          throw new DecryptError('decrypted json value does not parse');
        }
      }
      return text;
    }
    case 'integer': {
      if (bytes.length !== 8) {
        throw new DecryptError('decrypted integer must be 8 bytes');
      }
      const big = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(
        0,
        true,
      );
      const num = Number(big);
      if (!Number.isSafeInteger(num)) {
        throw new DecryptError('decrypted integer outside safe range');
      }
      return num;
    }
    case 'float': {
      if (bytes.length !== 8) {
        throw new DecryptError('decrypted float must be 8 bytes');
      }
      return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(
        0,
        true,
      );
    }
    case 'boolean': {
      if (bytes.length !== 1 || (bytes[0] !== 0 && bytes[0] !== 1)) {
        throw new DecryptError('decrypted boolean must be one 0x00/0x01 byte');
      }
      return bytes[0] === 1;
    }
    case 'bytes':
      return bytes;
  }
}

// ---------------------------------------------------------------------------
// Envelope — 0x01 | keyIdLen(u8) | keyId | nonce(12) | ct+tag  (§5.11)
// ---------------------------------------------------------------------------

export interface Envelope {
  readonly keyId: string;
  readonly nonce: Uint8Array;
  /** AES-256-GCM ciphertext with the 16-byte tag appended. */
  readonly ciphertext: Uint8Array;
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const keyIdBytes = textEncoder.encode(envelope.keyId);
  if (keyIdBytes.length > 0xff) {
    throw new Error('keyId exceeds 255 UTF-8 bytes');
  }
  if (envelope.nonce.length !== NONCE_LENGTH) {
    throw new Error(`nonce must be ${NONCE_LENGTH} bytes`);
  }
  const writer = new ByteWriter();
  writer.u8(ENVELOPE_VERSION);
  writer.u8(keyIdBytes.length);
  writer.raw(keyIdBytes);
  writer.raw(envelope.nonce);
  writer.raw(envelope.ciphertext);
  return writer.finish();
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const reader = new ByteReader(bytes);
  let version: number;
  let keyIdLen: number;
  try {
    version = reader.u8();
    keyIdLen = reader.u8();
  } catch {
    throw new DecryptError('encrypted value: envelope truncated');
  }
  if (version !== ENVELOPE_VERSION) {
    throw new DecryptError(
      `encrypted value: unknown envelope version 0x${version.toString(16)}`,
    );
  }
  let keyIdBytes: Uint8Array;
  let nonce: Uint8Array;
  try {
    keyIdBytes = reader.raw(keyIdLen);
    nonce = reader.raw(NONCE_LENGTH);
  } catch {
    throw new DecryptError('encrypted value: envelope truncated');
  }
  // The remaining bytes are ciphertext+tag; must be at least the 16-byte tag.
  const ciphertext = bytes.subarray(2 + keyIdLen + NONCE_LENGTH);
  if (ciphertext.length < 16) {
    throw new DecryptError('encrypted value: ciphertext shorter than GCM tag');
  }
  let keyId: string;
  try {
    keyId = textDecoder.decode(keyIdBytes);
  } catch {
    throw new DecryptError('encrypted value: keyId is not valid UTF-8');
  }
  return { keyId, nonce, ciphertext: ciphertext.slice() };
}

// ---------------------------------------------------------------------------
// AES-256-GCM over WebCrypto
// ---------------------------------------------------------------------------

/**
 * Copy into a fresh `ArrayBuffer`-backed view. WebCrypto's `BufferSource`
 * type rejects a `Uint8Array<ArrayBufferLike>` (it could be SharedArrayBuffer);
 * a plain copy is unambiguously `ArrayBuffer`-backed.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`AES-256-GCM key must be ${KEY_LENGTH} bytes`);
  }
  return crypto.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt one declared-type value into a §5.11 envelope. `nonceSource`
 * defaults to a secure RNG; vectors inject a fixed nonce.
 */
export async function encryptValue(
  declaredType: DeclaredType,
  value: PlainValue,
  keyId: string,
  key: Uint8Array,
  nonceSource: NonceSource = secureRandomNonce,
): Promise<Uint8Array> {
  const plaintext = serializePlain(declaredType, value);
  const nonce = nonceSource();
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`nonce source must yield ${NONCE_LENGTH} bytes`);
  }
  const cryptoKey = await importAesKey(key);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 },
      cryptoKey,
      toBuffer(plaintext),
    ),
  );
  return encodeEnvelope({ keyId, nonce, ciphertext: ct });
}

/**
 * Decrypt a §5.11 envelope back to a declared-type value. `keyProvider`
 * resolves the envelope's `keyId` to key bytes; a missing key or GCM tag
 * mismatch is {@link DecryptError} (`client.decrypt_failed`).
 */
export async function decryptValue(
  declaredType: DeclaredType,
  envelopeBytes: Uint8Array,
  keyProvider: (keyId: string) => Uint8Array | undefined,
): Promise<PlainValue> {
  const envelope = decodeEnvelope(envelopeBytes);
  const key = keyProvider(envelope.keyId);
  if (key === undefined) {
    throw new DecryptError(
      `no key for keyId ${JSON.stringify(envelope.keyId)}`,
    );
  }
  const cryptoKey = await importAesKey(key);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toBuffer(envelope.nonce), tagLength: 128 },
        cryptoKey,
        toBuffer(envelope.ciphertext),
      ),
    );
  } catch {
    throw new DecryptError(
      `GCM authentication failed for keyId ${JSON.stringify(envelope.keyId)} (wrong key or corrupt ciphertext)`,
    );
  }
  return deserializePlain(declaredType, plaintext);
}
