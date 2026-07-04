/**
 * Minimal AWS Signature Version 4 — exactly the subset the S3 segment
 * store needs (header-signed requests and presigned GET URLs), hand-rolled
 * per the dependency-light doctrine (REVISE): SigV4 is small and
 * well-specified, so no SDK.
 *
 * Runtime-neutral (TODO §4.2): the crypto primitives are Web Crypto
 * (`crypto.subtle`), not `node:crypto`, so this module runs unchanged on
 * Cloudflare Workers / Deno / browsers as well as Bun/Node. `crypto.subtle`
 * is async, so signing is async throughout; the `S3SegmentStore` consumers
 * are already async, and the `DelegatedPresignConfig.presign` seam already
 * accepts a `Promise<SegmentUrlIssue>`.
 *
 * Pinned by the published AWS SigV4 example vectors in
 * `test/sigv4.test.ts`; the hermetic S3 stub re-derives every signature
 * from the incoming request, so an asymmetric signing bug fails tests.
 */

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token (signed as `x-amz-security-token`). */
  readonly sessionToken?: string;
}

/** Hex SHA-256 of an empty body — the payload hash for GET/HEAD/DELETE. */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The presigned-URL payload sentinel (S3 presigns never hash the body). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const textEncoder = new TextEncoder();

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? textEncoder.encode(data) : data;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Web Crypto wants an `ArrayBuffer`; slice() gives an owned, exact-length one. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bufferOf(toBytes(data)));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256(
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    bufferOf(toBytes(key)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    bufferOf(toBytes(data)),
  );
  return new Uint8Array(mac);
}

/**
 * AWS canonical URI-encoding: RFC 3986 unreserved characters only —
 * stricter than `encodeURIComponent` (which leaves `!'()*` alone).
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replaceAll('%2F', '/');
}

/** `YYYYMMDD'T'HHMMSS'Z'` plus its date-only prefix, from epoch ms. */
export function amzTimestamps(nowMs: number): {
  amzDate: string;
  dateStamp: string;
} {
  const iso = new Date(nowMs).toISOString();
  const amzDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Sorted, fully re-encoded canonical query string from *decoded* pairs. */
export function canonicalQuery(
  params: Iterable<readonly [string, string]>,
): string {
  return [...params]
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface CanonicalRequestArgs {
  readonly method: string;
  /** The URI-encoded absolute path exactly as sent on the request line. */
  readonly canonicalPath: string;
  /** Decoded query pairs; `X-Amz-Signature` must already be excluded. */
  readonly query: Iterable<readonly [string, string]>;
  /** Only the headers being signed (name → raw value). */
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

export function canonicalRequest(args: CanonicalRequestArgs): {
  text: string;
  signedHeaders: string;
} {
  const entries = Object.entries(args.headers)
    .map(
      ([name, value]) =>
        [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const text = [
    args.method.toUpperCase(),
    args.canonicalPath,
    canonicalQuery(args.query),
    ...entries.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    args.payloadHash,
  ].join('\n');
  return { text, signedHeaders };
}

export async function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequestText: string,
): Promise<string> {
  return `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequestText)}`;
}

export async function sigV4Signature(args: {
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
  readonly stringToSign: string;
}): Promise<string> {
  const kDate = await hmacSha256(`AWS4${args.secretAccessKey}`, args.dateStamp);
  const kRegion = await hmacSha256(kDate, args.region);
  const kService = await hmacSha256(kRegion, args.service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return toHex(await hmacSha256(kSigning, args.stringToSign));
}

export interface SignRequestArgs {
  readonly method: string;
  /** Full request URL (host is taken from here and always signed). */
  readonly url: URL;
  readonly region: string;
  /** Defaults to `s3`. */
  readonly service?: string;
  readonly credentials: SigV4Credentials;
  readonly nowMs: number;
  /** Hex SHA-256 of the request body (`EMPTY_PAYLOAD_SHA256` if none). */
  readonly payloadHash: string;
  /** Extra headers to send *and* sign (e.g. content-type, x-amz-meta-*). */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Headers for a header-authenticated request: the caller's headers plus
 * `x-amz-date`, `x-amz-content-sha256`, optional `x-amz-security-token`,
 * and `authorization`. `host` is signed but not returned — fetch derives
 * it from the URL.
 */
export async function signRequest(
  args: SignRequestArgs,
): Promise<Record<string, string>> {
  const service = args.service ?? 's3';
  const { amzDate, dateStamp } = amzTimestamps(args.nowMs);
  const added: Record<string, string> = {
    'x-amz-content-sha256': args.payloadHash,
    'x-amz-date': amzDate,
    ...(args.credentials.sessionToken !== undefined
      ? { 'x-amz-security-token': args.credentials.sessionToken }
      : {}),
  };
  const { text, signedHeaders } = canonicalRequest({
    method: args.method,
    canonicalPath: args.url.pathname,
    query: args.url.searchParams,
    headers: { ...args.headers, ...added, host: args.url.host },
    payloadHash: args.payloadHash,
  });
  const scope = `${dateStamp}/${args.region}/${service}/aws4_request`;
  const signature = await sigV4Signature({
    secretAccessKey: args.credentials.secretAccessKey,
    dateStamp,
    region: args.region,
    service,
    stringToSign: await stringToSign(amzDate, scope, text),
  });
  return {
    ...args.headers,
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

export interface PresignArgs {
  /** Defaults to `GET`. */
  readonly method?: string;
  /** Object URL without any `X-Amz-*` query parameters. */
  readonly url: URL;
  readonly region: string;
  /** Defaults to `s3`. */
  readonly service?: string;
  readonly credentials: SigV4Credentials;
  readonly nowMs: number;
  readonly expiresSeconds: number;
}

/** Query-authenticated (presigned) URL; only the `host` header is signed. */
export async function presignUrl(args: PresignArgs): Promise<URL> {
  const service = args.service ?? 's3';
  const method = args.method ?? 'GET';
  const { amzDate, dateStamp } = amzTimestamps(args.nowMs);
  const scope = `${dateStamp}/${args.region}/${service}/aws4_request`;
  const url = new URL(args.url);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set(
    'X-Amz-Credential',
    `${args.credentials.accessKeyId}/${scope}`,
  );
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(args.expiresSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (args.credentials.sessionToken !== undefined) {
    url.searchParams.set('X-Amz-Security-Token', args.credentials.sessionToken);
  }
  const { text } = canonicalRequest({
    method,
    canonicalPath: url.pathname,
    query: url.searchParams,
    headers: { host: url.host },
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const signature = await sigV4Signature({
    secretAccessKey: args.credentials.secretAccessKey,
    dateStamp,
    region: args.region,
    service,
    stringToSign: await stringToSign(amzDate, scope, text),
  });
  url.searchParams.set('X-Amz-Signature', signature);
  return url;
}
