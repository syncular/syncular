/**
 * @syncular/crypto — §5.11 asymmetric ("async") encryption utilities.
 *
 * X25519 sealed-box key wrapping: share a 32-byte symmetric key to a
 * recipient's X25519 public key. These are UTILITIES, not sync wire protocol
 * (§5.11): key distribution rides the app's own channel or a synced table of
 * wrapped keys (see the docs recipe). Byte-identical to the Rust `ssp2::wrap`
 * implementation.
 *
 * The wrap envelope is:
 *   0x01 | ephemeralPublic(32) | nonce(12) | wrapped (K.len + 16)
 * with
 *   wrapKey = HKDF-SHA256(ikm = X25519(e, P), salt = "",
 *                         info = "syncular/e2ee/x25519-wrap/v1", len = 32)
 *   wrapped = AES-256-GCM(wrapKey, nonce, K)
 *
 * Backend: WebCrypto (AES-GCM + HKDF are universal; X25519 is present in Bun,
 * Node 18+, and modern browsers). An environment lacking WebCrypto X25519
 * (older Safari) must polyfill `crypto.subtle` X25519 or supply a `@noble/
 * curves` shim through the injectable `x25519` hooks below.
 */

const ENVELOPE_VERSION = 0x01;
const NONCE_LENGTH = 12;
const HKDF_INFO = new TextEncoder().encode('syncular/e2ee/x25519-wrap/v1');

/** A §5.11 key-unwrap failure (`client.decrypt_failed`). */
export class UnwrapError extends Error {
  override readonly name = 'UnwrapError';
  readonly code = 'client.decrypt_failed';
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Pluggable X25519 backend so a WebCrypto-less environment can inject
 * `@noble/curves`. Defaults to WebCrypto.
 */
export interface X25519Backend {
  generateKeyPair(): Promise<{
    privateKey: Uint8Array;
    publicKey: Uint8Array;
  }>;
  publicFromPrivate(privateKey: Uint8Array): Promise<Uint8Array>;
  /** Raw X25519 shared secret (32 bytes). */
  sharedSecret(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ): Promise<Uint8Array>;
}

async function importX25519Private(raw: Uint8Array): Promise<CryptoKey> {
  // PKCS#8 wrapper for a raw 32-byte X25519 private key.
  const pkcs8 = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x04,
    0x22,
    0x04,
    0x20,
    ...raw,
  ]);
  return crypto.subtle.importKey(
    'pkcs8',
    toBuffer(pkcs8),
    { name: 'X25519' },
    true,
    ['deriveBits'],
  );
}

async function importX25519Public(raw: Uint8Array): Promise<CryptoKey> {
  // SPKI wrapper for a raw 32-byte X25519 public key.
  const spki = new Uint8Array([
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x03,
    0x21,
    0x00,
    ...raw,
  ]);
  return crypto.subtle.importKey(
    'spki',
    toBuffer(spki),
    { name: 'X25519' },
    true,
    [],
  );
}

async function exportRawPublic(key: CryptoKey): Promise<Uint8Array> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key));
  // The raw 32-byte key is the tail of the SPKI structure.
  return spki.slice(spki.length - 32);
}

async function exportRawPrivate(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key));
  return pkcs8.slice(pkcs8.length - 32);
}

/** The default WebCrypto X25519 backend. */
export const webCryptoX25519: X25519Backend = {
  async generateKeyPair() {
    const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    return {
      privateKey: await exportRawPrivate(kp.privateKey),
      publicKey: await exportRawPublic(kp.publicKey),
    };
  },
  async publicFromPrivate(privateKey) {
    // Derive the public key by importing the private key and re-exporting;
    // WebCrypto keeps them paired inside a JWK export.
    const priv = await importX25519Private(privateKey);
    const jwk = await crypto.subtle.exportKey('jwk', priv);
    const x = (jwk as JsonWebKey).x;
    if (x === undefined) throw new Error('X25519 private key export missing x');
    return b64urlToBytes(x);
  },
  async sharedSecret(privateKey, publicKey) {
    const priv = await importX25519Private(privateKey);
    const pub = await importX25519Public(publicKey);
    const bits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: pub },
      priv,
      256,
    );
    return new Uint8Array(bits);
  },
};

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveWrapKey(shared: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    toBuffer(shared),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: HKDF_INFO,
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Generate an X25519 keypair (raw 32-byte private + public). */
export async function generateKeyPair(
  backend: X25519Backend = webCryptoX25519,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  return backend.generateKeyPair();
}

/**
 * Wrap a 32-byte symmetric key `k` to a recipient X25519 public key, using a
 * caller-supplied ephemeral secret and nonce (production supplies random ones;
 * vectors inject fixed ones for determinism).
 */
export async function wrapKeyWith(
  k: Uint8Array,
  recipientPublic: Uint8Array,
  ephemeralPrivate: Uint8Array,
  nonce: Uint8Array,
  backend: X25519Backend = webCryptoX25519,
): Promise<Uint8Array> {
  const ephemeralPublic = await backend.publicFromPrivate(ephemeralPrivate);
  const shared = await backend.sharedSecret(ephemeralPrivate, recipientPublic);
  const wrapKey = await deriveWrapKey(shared);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 },
      wrapKey,
      toBuffer(k),
    ),
  );
  const out = new Uint8Array(1 + 32 + NONCE_LENGTH + wrapped.length);
  out[0] = ENVELOPE_VERSION;
  out.set(ephemeralPublic, 1);
  out.set(nonce, 33);
  out.set(wrapped, 33 + NONCE_LENGTH);
  return out;
}

/** Wrap with a random ephemeral keypair + nonce (production path). */
export async function wrapKey(
  k: Uint8Array,
  recipientPublic: Uint8Array,
  backend: X25519Backend = webCryptoX25519,
): Promise<Uint8Array> {
  const eph = await backend.generateKeyPair();
  const nonce = new Uint8Array(NONCE_LENGTH);
  crypto.getRandomValues(nonce);
  return wrapKeyWith(k, recipientPublic, eph.privateKey, nonce, backend);
}

/** Unwrap a wrap envelope with the recipient's private key, recovering `K`. */
export async function unwrapKey(
  envelope: Uint8Array,
  recipientPrivate: Uint8Array,
  backend: X25519Backend = webCryptoX25519,
): Promise<Uint8Array> {
  if (envelope.length < 1 + 32 + NONCE_LENGTH + 16) {
    throw new UnwrapError('wrap envelope truncated');
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw new UnwrapError(
      `unknown wrap envelope version 0x${(envelope[0] ?? 0).toString(16)}`,
    );
  }
  const ephemeralPublic = envelope.subarray(1, 33);
  const nonce = envelope.subarray(33, 33 + NONCE_LENGTH);
  const wrapped = envelope.subarray(33 + NONCE_LENGTH);
  const shared = await backend.sharedSecret(recipientPrivate, ephemeralPublic);
  const wrapKey = await deriveWrapKey(shared);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 },
        wrapKey,
        toBuffer(wrapped),
      ),
    );
  } catch {
    throw new UnwrapError(
      'wrap GCM authentication failed (wrong recipient key)',
    );
  }
}
