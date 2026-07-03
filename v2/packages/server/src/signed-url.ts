/**
 * Signed-URL segment delivery (SPEC.md §5.4): the native HMAC token
 * scheme, plus the delegated-presign alternative (S3/R2/GCS) behind one
 * issuance seam.
 *
 * Native: `st = base64url(payloadJson) + "." +
 * base64url(HMAC-SHA256(key, payloadJson))` with claims
 * `{v, seg, sd, aud, exp}`; `exp` is unix seconds. Issuance happens inside
 * the pull immediately after scope resolution; verification checks MAC,
 * expiry (≤ 60 s skew), and `seg`/`sd`/`aud` equality. Actual CDN serving
 * is out of scope.
 *
 * Delegated presign: the provider mints the URL (§5.4 equivalence rule —
 * the signed object key embeds the `segmentId`, the expiry obeys the same
 * TTL guidance); `issueSegmentUrl` routes to whichever config the host
 * supplied. Both paths issue only after scope resolution, so a URL is
 * never minted for scopes the actor did not hold at that moment.
 */
import { syncError } from './errors';

export interface SignedUrlConfig {
  /** HMAC key (raw bytes or UTF-8 string). */
  readonly key: string | Uint8Array;
  /** URL prefix; the segment URL is `${baseUrl}/${segmentId}?st=${token}`. */
  readonly baseUrl: string;
  /** Token TTL; SHOULD be ≤ 15 minutes (§5.4). Default 900. */
  readonly ttlSeconds?: number;
  /**
   * Opaque per-partition audience (§5.4): stable per partition, MUST NOT
   * disclose the internal partition id.
   */
  readonly audience: (partition: string) => string;
}

/** What descriptor emission needs: the §5.4 `url`/`urlExpiresAtMs` pair. */
export interface SegmentUrlIssue {
  readonly url: string;
  readonly urlExpiresAtMs: number;
}

export interface SegmentPresignArgs {
  readonly segmentId: string;
  readonly partition: string;
  readonly scopeDigest: string;
  readonly nowMs: number;
  /** Resolved TTL (config value or the 900 s default) — already applied. */
  readonly ttlSeconds: number;
}

/**
 * Delegated presign (§5.4): the provider signs the URL. The callback MUST
 * satisfy the equivalence rule — the signed object key embeds exactly one
 * `segmentId`, and `urlExpiresAtMs` reflects the real provider expiry.
 * `S3SegmentStore.presignSegmentGet` (via `s3PresignedUrls`) is the
 * in-tree implementation.
 */
export interface DelegatedPresignConfig {
  readonly presign: (
    args: SegmentPresignArgs,
  ) => SegmentUrlIssue | Promise<SegmentUrlIssue>;
  /** URL TTL; SHOULD be ≤ 15 minutes (§5.4). Default 900. */
  readonly ttlSeconds?: number;
}

/** Either §5.4 scheme; the pull emits descriptors identically for both. */
export type SegmentUrlConfig = SignedUrlConfig | DelegatedPresignConfig;

/**
 * Issue the §5.4 `url`/`urlExpiresAtMs` pair for one segment descriptor,
 * routing to the native HMAC token or the delegated presigner. Callers
 * (the pull) invoke this only after scope resolution and only when the
 * client advertised accept bit 3.
 */
export async function issueSegmentUrl(
  config: SegmentUrlConfig,
  args: {
    readonly segmentId: string;
    readonly partition: string;
    readonly scopeDigest: string;
    readonly nowMs: number;
  },
): Promise<SegmentUrlIssue> {
  const ttlSeconds = config.ttlSeconds ?? 900;
  if ('presign' in config) {
    return config.presign({ ...args, ttlSeconds });
  }
  const exp = Math.floor(args.nowMs / 1000) + ttlSeconds;
  const token = await signSegmentToken(config.key, {
    v: 1,
    seg: args.segmentId,
    sd: args.scopeDigest,
    aud: config.audience(args.partition),
    exp,
  });
  return {
    url: `${config.baseUrl}/${args.segmentId}?st=${token}`,
    urlExpiresAtMs: exp * 1000,
  };
}

export interface SegmentTokenClaims {
  readonly v: 1;
  readonly seg: string;
  readonly sd: string;
  readonly aud: string;
  /** Unix seconds — the sole non-millisecond timestamp in the spec. */
  readonly exp: number;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

async function hmac(
  key: string | Uint8Array,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    payload.slice().buffer as ArrayBuffer,
  );
  return new Uint8Array(mac);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function signSegmentToken(
  key: string | Uint8Array,
  claims: SegmentTokenClaims,
): Promise<string> {
  const payloadJson = JSON.stringify({
    v: claims.v,
    seg: claims.seg,
    sd: claims.sd,
    aud: claims.aud,
    exp: claims.exp,
  });
  const payload = encoder.encode(payloadJson);
  const mac = await hmac(key, payload);
  return `${base64url(payload)}.${base64url(mac)}`;
}

const DEFAULT_SKEW_SECONDS = 60;

/**
 * Verify a segment token per §5.4. Throws `SyncError sync.forbidden` on any
 * failure (MAC, expiry, or claim mismatch).
 */
export async function verifySegmentToken(
  key: string | Uint8Array,
  token: string,
  expected: {
    readonly segmentId: string;
    readonly scopeDigest: string;
    readonly audience: string;
    readonly nowMs: number;
    readonly skewSeconds?: number;
  },
): Promise<SegmentTokenClaims> {
  const forbidden = (reason: string) =>
    syncError('sync.forbidden', `segment token rejected: ${reason}`);
  const dot = token.indexOf('.');
  if (dot < 0) throw forbidden('malformed token');
  const payload = fromBase64url(token.slice(0, dot));
  const mac = fromBase64url(token.slice(dot + 1));
  const computed = await hmac(key, payload);
  if (!constantTimeEqual(mac, computed)) throw forbidden('bad MAC');
  let claims: SegmentTokenClaims;
  try {
    claims = JSON.parse(
      new TextDecoder().decode(payload),
    ) as SegmentTokenClaims;
  } catch {
    throw forbidden('unparseable claims');
  }
  if (claims.v !== 1) throw forbidden('unsupported token version');
  const skew = expected.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  if (
    typeof claims.exp !== 'number' ||
    claims.exp < expected.nowMs / 1000 - skew
  ) {
    throw forbidden('token expired');
  }
  if (claims.seg !== expected.segmentId) throw forbidden('segment mismatch');
  if (claims.sd !== expected.scopeDigest)
    throw forbidden('scope-digest mismatch');
  if (claims.aud !== expected.audience) throw forbidden('audience mismatch');
  return claims;
}
