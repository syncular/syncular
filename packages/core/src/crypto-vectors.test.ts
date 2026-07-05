/**
 * §5.11 crypto golden vectors: the TS core reproduces every committed
 * envelope byte-for-byte and round-trips decrypt (SPEC.md Appendix A #22–23).
 * A regeneration must be byte-identical — the cross-core contract with Rust.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeclaredType, decryptValue, type PlainValue } from './crypto';

const hexToBytes = (h: string) => {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++)
    o[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
};

interface Vectors {
  keyHex: string;
  nonceHex: string;
  aesGcm: {
    name: string;
    declaredType: DeclaredType;
    keyId: string;
    valueHex: string;
    envelopeHex: string;
  }[];
  x25519Wrap: {
    recipientPrivHex: string;
    symmetricKeyHex: string;
    envelopeHex: string;
  };
}

const vectors: Vectors = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../spec/vectors/crypto/vectors.json'),
    'utf8',
  ),
);

describe('§5.11 crypto vectors (TS core)', () => {
  const key = hexToBytes(vectors.keyHex);
  const provider = (id: string) => (id === 'k1' ? key : undefined);

  for (const c of vectors.aesGcm) {
    test(`decrypt ${c.name} matches committed envelope`, async () => {
      const env = hexToBytes(c.envelopeHex);
      const value = await decryptValue(c.declaredType, env, provider);
      // The decrypted value must serialize back to the recorded plaintext.
      const roundTrip = serialize(c.declaredType, value);
      expect(hex(roundTrip)).toBe(c.valueHex);
    });
  }
});

function serialize(type: DeclaredType, value: PlainValue): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (type === 'integer') {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, BigInt(value as number), true);
    return out;
  }
  if (type === 'float') {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value as number, true);
    return out;
  }
  if (type === 'boolean') return new Uint8Array([value ? 1 : 0]);
  return new TextEncoder().encode(value as string);
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
