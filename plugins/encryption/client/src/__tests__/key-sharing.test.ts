import { describe, expect, test } from 'bun:test';
import {
  base64UrlToKey,
  decodeWrappedKey,
  encodeWrappedKey,
  generateKeypair,
  generateSymmetricKey,
  keyToBase64Url,
  keyToJson,
  keyToMnemonic,
  keyToShareUrl,
  mnemonicToKey,
  mnemonicToPublicKey,
  normalizeMnemonicInput,
  parseKeyShareJson,
  parseShareUrl,
  publicKeyToJson,
  publicKeyToMnemonic,
  publicKeyToShareUrl,
  unwrapKey,
  wrapKeyForRecipient,
} from '../key-sharing';

describe('key-sharing', () => {
  describe('symmetric key utilities', () => {
    test('generateSymmetricKey returns 32 bytes', () => {
      const key = generateSymmetricKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    test('keyToMnemonic produces 24 words', () => {
      const key = generateSymmetricKey();
      const mnemonic = keyToMnemonic(key);
      const words = mnemonic.split(' ');
      expect(words.length).toBe(24);
    });

    test('mnemonicToKey roundtrip', () => {
      const key = generateSymmetricKey();
      const mnemonic = keyToMnemonic(key);
      const recovered = mnemonicToKey(mnemonic);
      expect(recovered).toEqual(key);
    });

    test('normalizeMnemonicInput strips numbered list noise', () => {
      const key = generateSymmetricKey();
      const mnemonic = keyToMnemonic(key);
      const words = mnemonic.split(' ');
      const numbered = words.map((word, i) => `${i + 1}. ${word}`).join('\n');

      const normalized = normalizeMnemonicInput(numbered);
      expect(normalized).toBe(mnemonic);

      const recovered = mnemonicToKey(numbered);
      expect(recovered).toEqual(key);
    });

    test('keyToBase64Url roundtrip', () => {
      const key = generateSymmetricKey();
      const encoded = keyToBase64Url(key);
      const decoded = base64UrlToKey(encoded);
      expect(decoded).toEqual(key);
    });

    test('base64UrlToKey rejects malformed base64url', () => {
      expect(() => base64UrlToKey('@@@@')).toThrow();
    });

    test('base64UrlToKey rejects wrong-length payloads', () => {
      expect(() => base64UrlToKey('QQ')).toThrow(
        'Invalid key length: expected 32 bytes, got 1'
      );
    });

    test('keyToMnemonic throws for wrong length', () => {
      expect(() => keyToMnemonic(new Uint8Array(16))).toThrow();
    });
  });

  describe('X25519 keypair utilities', () => {
    test('generateKeypair returns valid keys', () => {
      const { publicKey, privateKey } = generateKeypair();
      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey.length).toBe(32);
    });

    test('publicKeyToMnemonic roundtrip', () => {
      const { publicKey } = generateKeypair();
      const mnemonic = publicKeyToMnemonic(publicKey);
      const recovered = mnemonicToPublicKey(mnemonic);
      expect(recovered).toEqual(publicKey);
    });
  });

  describe('key wrapping', () => {
    test('wrap and unwrap symmetric key', () => {
      const alice = generateKeypair();
      const symmetricKey = generateSymmetricKey();

      const wrapped = wrapKeyForRecipient(alice.publicKey, symmetricKey);
      expect(wrapped.ephemeralPublic.length).toBe(32);
      expect(wrapped.ciphertext.length).toBe(72);

      const unwrapped = unwrapKey(alice.privateKey, wrapped);
      expect(unwrapped).toEqual(symmetricKey);
    });

    test('encodeWrappedKey roundtrip', () => {
      const alice = generateKeypair();
      const symmetricKey = generateSymmetricKey();

      const wrapped = wrapKeyForRecipient(alice.publicKey, symmetricKey);
      const encoded = encodeWrappedKey(wrapped);
      const decoded = decodeWrappedKey(encoded);

      expect(decoded.ephemeralPublic).toEqual(wrapped.ephemeralPublic);
      expect(decoded.ciphertext).toEqual(wrapped.ciphertext);

      const unwrapped = unwrapKey(alice.privateKey, decoded);
      expect(unwrapped).toEqual(symmetricKey);
    });

    test('wrong private key fails to unwrap', () => {
      const alice = generateKeypair();
      const bob = generateKeypair();
      const symmetricKey = generateSymmetricKey();

      const wrapped = wrapKeyForRecipient(alice.publicKey, symmetricKey);

      expect(() => unwrapKey(bob.privateKey, wrapped)).toThrow();
    });
  });

  describe('share URL format', () => {
    test('keyToShareUrl roundtrip', () => {
      const key = generateSymmetricKey();
      const url = keyToShareUrl(key);
      const parsed = parseShareUrl(url);

      expect(parsed.type).toBe('symmetric');
      if (parsed.type === 'symmetric') {
        expect(parsed.key).toEqual(key);
        expect(parsed.kid).toBeUndefined();
      }
    });

    test('keyToShareUrl with kid', () => {
      const key = generateSymmetricKey();
      const url = keyToShareUrl(key, 'my-key-id');
      const parsed = parseShareUrl(url);

      expect(parsed.type).toBe('symmetric');
      if (parsed.type === 'symmetric') {
        expect(parsed.key).toEqual(key);
        expect(parsed.kid).toBe('my-key-id');
      }
    });

    test('publicKeyToShareUrl roundtrip', () => {
      const { publicKey } = generateKeypair();
      const url = publicKeyToShareUrl(publicKey);
      const parsed = parseShareUrl(url);

      expect(parsed.type).toBe('publicKey');
      if (parsed.type === 'publicKey') {
        expect(parsed.publicKey).toEqual(publicKey);
      }
    });

    test('parseShareUrl throws for invalid URL', () => {
      expect(() => parseShareUrl('https://example.com')).toThrow();
      expect(() => parseShareUrl('sync://invalid')).toThrow();
    });

    test('parseShareUrl rejects malformed base64url payloads', () => {
      expect(() => parseShareUrl('sync://k/1/@@@@')).toThrow();
    });

    test('parseShareUrl rejects wrong-length key payloads', () => {
      expect(() => parseShareUrl('sync://pk/1/QQ')).toThrow(
        'Invalid key length: expected 32 bytes, got 1'
      );
    });
  });

  describe('JSON format', () => {
    test('keyToJson roundtrip', () => {
      const key = generateSymmetricKey();
      const json = keyToJson(key, 'test-kid');
      const parsed = parseKeyShareJson(JSON.stringify(json));

      expect(parsed.type).toBe('symmetric');
      if (parsed.type === 'symmetric') {
        expect(parsed.key).toEqual(key);
        expect(parsed.kid).toBe('test-kid');
      }
    });

    test('publicKeyToJson roundtrip', () => {
      const { publicKey } = generateKeypair();
      const json = publicKeyToJson(publicKey);
      const parsed = parseKeyShareJson(JSON.stringify(json));

      expect(parsed.type).toBe('publicKey');
      if (parsed.type === 'publicKey') {
        expect(parsed.publicKey).toEqual(publicKey);
      }
    });

    test('parseKeyShareJson rejects malformed payloads', () => {
      expect(() =>
        parseKeyShareJson(JSON.stringify({ type: 'symmetric', k: '@@@@' }))
      ).toThrow();
    });

    test('parseKeyShareJson rejects wrong-length payloads', () => {
      expect(() =>
        parseKeyShareJson(JSON.stringify({ type: 'publicKey', pk: 'QQ' }))
      ).toThrow('Invalid key length: expected 32 bytes, got 1');
    });
  });
});
