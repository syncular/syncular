import { describe, expect, test } from 'bun:test';
import {
  type DeclaredType,
  DecryptError,
  decodeEnvelope,
  decryptValue,
  deserializePlain,
  encodeEnvelope,
  encryptValue,
  type PlainValue,
  serializePlain,
} from './crypto';

const KEY = new Uint8Array(32).fill(7);
const FIXED_NONCE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const fixedNonce = () => FIXED_NONCE.slice();
const provider = (id: string) => (id === 'k1' ? KEY : undefined);

const cases: ReadonlyArray<[DeclaredType, PlainValue]> = [
  ['string', 'hello world'],
  ['string', '𝔘nicode non-BMP 🔐'],
  ['json', '{"a":1,"b":[true,null]}'],
  ['blob_ref', '{"blobId":"abc","size":1}'],
  ['integer', 9007199254740991],
  ['integer', -9007199254740991],
  ['float', Math.PI],
  ['boolean', true],
  ['boolean', false],
  ['bytes', new Uint8Array([0xde, 0xad, 0xbe, 0xef])],
];

describe('§5.11 value serializer round-trip', () => {
  for (const [type, value] of cases) {
    test(`${type}: ${JSON.stringify(value)}`, () => {
      const bytes = serializePlain(type, value);
      const back = deserializePlain(type, bytes);
      if (value instanceof Uint8Array) {
        expect(back).toEqual(value);
      } else {
        expect(back).toBe(value as never);
      }
    });
  }
});

describe('§5.11 envelope byte structure', () => {
  test('encode/decode round-trips fields', () => {
    const env = {
      keyId: 'k1',
      nonce: FIXED_NONCE,
      ciphertext: new Uint8Array(20).fill(9),
    };
    const bytes = encodeEnvelope(env);
    // 0x01 | keyIdLen | "k1" | 12 nonce | 20 ct = 1+1+2+12+20 = 36
    expect(bytes.length).toBe(36);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(2);
    const decoded = decodeEnvelope(bytes);
    expect(decoded.keyId).toBe('k1');
    expect([...decoded.nonce]).toEqual([...FIXED_NONCE]);
    expect(decoded.ciphertext.length).toBe(20);
  });

  test('unknown version fails', () => {
    const bytes = encodeEnvelope({
      keyId: 'k1',
      nonce: FIXED_NONCE,
      ciphertext: new Uint8Array(20),
    });
    bytes[0] = 0x02;
    expect(() => decodeEnvelope(bytes)).toThrow(DecryptError);
  });

  test('truncated envelope fails loud (keyIdLen past the buffer)', () => {
    // version 0x01, keyIdLen 200, then nothing — reading keyId overruns.
    expect(() => decodeEnvelope(new Uint8Array([0x01, 200]))).toThrow(
      DecryptError,
    );
  });

  test('ciphertext shorter than the GCM tag fails', () => {
    // version | keyIdLen=1 | 'k' | 12-byte nonce | 4 ct bytes (< 16 tag)
    const bytes = new Uint8Array([
      0x01,
      0x01,
      0x6b,
      ...FIXED_NONCE,
      1,
      2,
      3,
      4,
    ]);
    expect(() => decodeEnvelope(bytes)).toThrow(DecryptError);
  });
});

describe('§5.11 encrypt/decrypt', () => {
  for (const [type, value] of cases) {
    test(`AES-GCM ${type} round-trip`, async () => {
      const env = await encryptValue(type, value, 'k1', KEY, fixedNonce);
      expect(env[0]).toBe(0x01);
      const back = await decryptValue(type, env, provider);
      if (value instanceof Uint8Array) {
        expect(back).toEqual(value);
      } else {
        expect(back).toBe(value as never);
      }
    });
  }

  test('deterministic with fixed nonce', async () => {
    const a = await encryptValue('string', 'x', 'k1', KEY, fixedNonce);
    const b = await encryptValue('string', 'x', 'k1', KEY, fixedNonce);
    expect([...a]).toEqual([...b]);
  });

  test('wrong key surfaces client.decrypt_failed', async () => {
    const env = await encryptValue('string', 'secret', 'k1', KEY, fixedNonce);
    const badProvider = (id: string) =>
      id === 'k1' ? new Uint8Array(32).fill(1) : undefined;
    await expect(decryptValue('string', env, badProvider)).rejects.toThrow(
      DecryptError,
    );
  });

  test('unknown keyId surfaces client.decrypt_failed', async () => {
    const env = await encryptValue('string', 'secret', 'k1', KEY, fixedNonce);
    await expect(
      decryptValue('string', env, () => undefined),
    ).rejects.toMatchObject({ code: 'client.decrypt_failed' });
  });
});
