/**
 * §5.11 crypto golden-vector generator (SPEC.md Appendix A cases 22–23).
 *
 * Deterministic: a fixed key and nonce (test-only injection — never a
 * production encode path). Both cores reproduce the envelope bytes byte-for-
 * byte and round-trip decrypt/unwrap. Writes `spec/vectors/crypto/vectors.json`.
 *
 * Run: `bun run packages/core/scripts/generate-crypto-vectors.ts`
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { webCryptoX25519, wrapKeyWith } from '../../crypto/src/index';
import {
  type DeclaredType,
  encryptValue,
  type PlainValue,
  serializePlain,
} from '../src/crypto';

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h: string) => {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++)
    o[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
};

const KEY_HEX = '07'.repeat(32);
const NONCE_HEX = '000102030405060708090a0b';
const KEY = hexToBytes(KEY_HEX);
const NONCE = hexToBytes(NONCE_HEX);
const fixedNonce = () => NONCE.slice();

const aesCases: {
  name: string;
  declaredType: DeclaredType;
  value: PlainValue;
}[] = [
  { name: 'string', declaredType: 'string', value: 'hello 🔐' },
  { name: 'json', declaredType: 'json', value: '{"a":1,"b":[true,null]}' },
  {
    name: 'blob_ref',
    declaredType: 'blob_ref',
    value: '{"algo":"sha256","hash":"ab","size":3}',
  },
  { name: 'integer', declaredType: 'integer', value: 9007199254740991 },
  { name: 'float', declaredType: 'float', value: Math.PI },
  { name: 'boolean', declaredType: 'boolean', value: true },
  { name: 'bytes', declaredType: 'bytes', value: hexToBytes('deadbeef') },
];

async function main() {
  const aes = [];
  for (const c of aesCases) {
    const env = await encryptValue(
      c.declaredType,
      c.value,
      'k1',
      KEY,
      fixedNonce,
    );
    aes.push({
      name: c.name,
      declaredType: c.declaredType,
      keyId: 'k1',
      // The plaintext bytes fed to GCM — the §5.11 value serializer output.
      valueHex: hex(serializePlain(c.declaredType, c.value)),
      envelopeHex: hex(env),
    });
  }

  const RECIPIENT_PRIV = '03'.repeat(32);
  const EPHEMERAL_PRIV = '05'.repeat(32);
  const WK_HEX = '2a'.repeat(32);
  const recipientPub = await webCryptoX25519.publicFromPrivate(
    hexToBytes(RECIPIENT_PRIV),
  );
  const wrapEnv = await wrapKeyWith(
    hexToBytes(WK_HEX),
    recipientPub,
    hexToBytes(EPHEMERAL_PRIV),
    NONCE,
  );

  const doc = {
    description:
      'SPEC.md §5.11 cross-core crypto vectors. Fixed key/nonce (test-only injection). Both cores reproduce envelopeHex byte-for-byte and round-trip decrypt/unwrap.',
    keyHex: KEY_HEX,
    nonceHex: NONCE_HEX,
    aesGcm: aes,
    x25519Wrap: {
      recipientPrivHex: RECIPIENT_PRIV,
      recipientPubHex: hex(recipientPub),
      ephemeralPrivHex: EPHEMERAL_PRIV,
      nonceHex: NONCE_HEX,
      symmetricKeyHex: WK_HEX,
      envelopeHex: hex(wrapEnv),
    },
  };
  const out = join(
    import.meta.dir,
    '../../../spec/vectors/crypto/vectors.json',
  );
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

void main();
