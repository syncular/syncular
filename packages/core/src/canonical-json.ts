/**
 * Canonical JSON for digests (SPEC.md §11.2) and the digests over it —
 * contractual across implementations: UTF-8, no insignificant whitespace,
 * object keys sorted by code-unit, scope value lists sorted and
 * deduplicated, every other array in its stated order.
 *
 * Used for the unit id and registration digest (§4.1), the echo digest
 * (§4.4), the scope digest (§3.5) and the `X-Syncular-Scopes` header (§5.5).
 */
import { utf8Encode } from './bytes';
import type { FencedRecord } from './message';

/** A unit's scope map: one value per requested variable (§4.1). */
export type UnitScopes = Readonly<Record<string, string>>;

export function canonicalScopeJson(
  scopes: Readonly<Record<string, readonly string[]>>,
): string {
  const keys = Object.keys(scopes).sort();
  const parts = keys.map((key) => {
    const values = [...new Set(scopes[key] ?? [])].sort();
    const list = values.map((value) => JSON.stringify(value)).join(',');
    return `${JSON.stringify(key)}:[${list}]`;
  });
  return `{${parts.join(',')}}`;
}

/** §4.1: the canonical JSON of a unit's scope map. */
export function canonicalUnitJson(scopes: UnitScopes): string {
  const keys = Object.keys(scopes).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${JSON.stringify(scopes[key])}`,
  );
  return `{${parts.join(',')}}`;
}

/** §4.1: lowercase hex of the first 16 bytes of SHA-256 over the canonical
 * JSON of the unit's scope map. */
export function unitId(scopes: UnitScopes): string {
  let hex = '';
  for (const byte of sha256(utf8Encode(canonicalUnitJson(scopes))).subarray(
    0,
    16,
  )) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** §4.1: SHA-256 over the canonical JSON array of the units' scope maps in
 * registration order, as 32 raw bytes. */
export function registrationDigest(units: readonly UnitScopes[]): Uint8Array {
  return sha256(utf8Encode(`[${units.map(canonicalUnitJson).join(',')}]`));
}

/** One unit of the effective list as the echo digest sees it (§4.4). */
export interface UnitEcho {
  id: string;
  status: 'active' | 'revoked';
  fenced: readonly FencedRecord[];
}

/** §4.4: SHA-256 over the canonical JSON array, in registration order, of
 * `{"fenced":[…],"id":…,"status":…}` per unit, as 32 raw bytes. */
export function echoDigest(units: readonly UnitEcho[]): Uint8Array {
  const entries = units.map((unit) => {
    const fenced = unit.fenced.map(
      (record) =>
        `{"scopes":${canonicalScopeJson(record.scopes)},"status":${JSON.stringify(record.status)},"table":${JSON.stringify(record.table)}}`,
    );
    return `{"fenced":[${fenced.join(',')}],"id":${JSON.stringify(unit.id)},"status":${JSON.stringify(unit.status)}}`;
  });
  return sha256(utf8Encode(`[${entries.join(',')}]`));
}

// FIPS 180-4 SHA-256. Synchronous so the unit id is a plain function of the
// scope map on every runtime (WebCrypto digests are async only).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((data.length + 72) >>> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const h: [number, number, number, number, number, number, number, number] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      w[i] =
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) +
        (w[i - 7] as number) +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        (w[i - 16] as number);
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        hh +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        ((e & f) ^ (~e & g)) +
        (K[i] as number) +
        (w[i] as number);
      const t2 =
        (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}
