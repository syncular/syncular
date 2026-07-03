/**
 * Minimal AWS Signature Version 4 — exactly the subset the S3 segment
 * store needs (header-signed requests and presigned GET URLs), hand-rolled
 * per the dependency-light doctrine (REVISE): SigV4 is small and
 * well-specified, so no SDK.
 *
 * Pinned by the published AWS SigV4 example vectors in
 * `test/sigv4.test.ts`; the hermetic S3 stub re-derives every signature
 * from the incoming request, so an asymmetric signing bug fails tests.
 */
import { createHash, createHmac } from 'node:crypto';

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

export function sha256HexSync(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
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

export function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequestText: string,
): string {
  return `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256HexSync(canonicalRequestText)}`;
}

export function sigV4Signature(args: {
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
  readonly stringToSign: string;
}): string {
  const kDate = hmacSha256(`AWS4${args.secretAccessKey}`, args.dateStamp);
  const kRegion = hmacSha256(kDate, args.region);
  const kService = hmacSha256(kRegion, args.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return createHmac('sha256', kSigning).update(args.stringToSign).digest('hex');
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
export function signRequest(args: SignRequestArgs): Record<string, string> {
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
  const signature = sigV4Signature({
    secretAccessKey: args.credentials.secretAccessKey,
    dateStamp,
    region: args.region,
    service,
    stringToSign: stringToSign(amzDate, scope, text),
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
export function presignUrl(args: PresignArgs): URL {
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
  const signature = sigV4Signature({
    secretAccessKey: args.credentials.secretAccessKey,
    dateStamp,
    region: args.region,
    service,
    stringToSign: stringToSign(amzDate, scope, text),
  });
  url.searchParams.set('X-Amz-Signature', signature);
  return url;
}
