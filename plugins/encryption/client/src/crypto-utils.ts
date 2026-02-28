const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Uint8Array(256);

for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function randomBytes(length: number): Uint8Array {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error(
      'Secure random generator is not available (crypto.getRandomValues). ' +
        'Ensure you are running in a secure context or polyfill crypto.'
    );
  }
  const out = new Uint8Array(length);
  cryptoObj.getRandomValues(out);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let result = '';
  const len = bytes.length;
  const remainder = len % 3;

  for (let i = 0; i < len - remainder; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    const c = bytes[i + 2]!;
    result +=
      BASE64_CHARS.charAt((a >> 2) & 0x3f) +
      BASE64_CHARS.charAt(((a << 4) | (b >> 4)) & 0x3f) +
      BASE64_CHARS.charAt(((b << 2) | (c >> 6)) & 0x3f) +
      BASE64_CHARS.charAt(c & 0x3f);
  }

  if (remainder === 1) {
    const a = bytes[len - 1]!;
    result +=
      BASE64_CHARS.charAt((a >> 2) & 0x3f) +
      BASE64_CHARS.charAt((a << 4) & 0x3f) +
      '==';
  } else if (remainder === 2) {
    const a = bytes[len - 2]!;
    const b = bytes[len - 1]!;
    result +=
      BASE64_CHARS.charAt((a >> 2) & 0x3f) +
      BASE64_CHARS.charAt(((a << 4) | (b >> 4)) & 0x3f) +
      BASE64_CHARS.charAt((b << 2) & 0x3f) +
      '=';
  }

  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  if (!BASE64_PATTERN.test(base64)) {
    throw new Error('Invalid base64 string');
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  const len = base64.length;
  let padding = 0;
  if (base64[len - 1] === '=') padding++;
  if (base64[len - 2] === '=') padding++;

  const outputLen = (len * 3) / 4 - padding;
  const out = new Uint8Array(outputLen);

  let outIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const a = BASE64_LOOKUP[base64.charCodeAt(i)]!;
    const b = BASE64_LOOKUP[base64.charCodeAt(i + 1)]!;
    const c = BASE64_LOOKUP[base64.charCodeAt(i + 2)]!;
    const d = BASE64_LOOKUP[base64.charCodeAt(i + 3)]!;

    out[outIdx++] = (a << 2) | (b >> 4);
    if (outIdx < outputLen) out[outIdx++] = ((b << 4) | (c >> 2)) & 0xff;
    if (outIdx < outputLen) out[outIdx++] = ((c << 6) | d) & 0xff;
  }

  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  if (!BASE64_URL_PATTERN.test(base64url)) {
    throw new Error('Invalid base64url string');
  }
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice((base64.length + 3) % 4);
  return base64ToBytes(padded);
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0) {
    throw new Error('Invalid hex string (length must be even)');
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) throw new Error('Invalid hex string');
    out[i] = byte;
  }
  return out;
}
