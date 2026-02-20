const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Cross-runtime SHA-256 digest helper.
 *
 * Uses Web Crypto when available, with Node crypto fallback.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const payload = typeof input === 'string' ? textEncoder.encode(input) : input;

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digestBuffer = await crypto.subtle.digest(
      'SHA-256',
      payload.slice().buffer
    );
    return toHex(new Uint8Array(digestBuffer));
  }

  try {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto.createHash('sha256').update(payload).digest('hex');
  } catch {}

  throw new Error(
    'Failed to create SHA-256 hash, no crypto implementation available'
  );
}
