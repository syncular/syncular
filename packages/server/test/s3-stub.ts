/**
 * Hermetic in-process S3 stub: exactly the subset `S3SegmentStore` uses
 * (PUT/GET/HEAD/DELETE object, header SigV4 auth, presigned GET) on a
 * loopback `Bun.serve`. Every request's signature is re-derived from what
 * actually arrived on the wire — method, path, query, headers, body hash —
 * so a signing bug on either side fails loudly instead of round-tripping.
 * Presigned-URL expiry is enforced against an injectable clock.
 */
import {
  canonicalRequest,
  sha256Hex,
  sigV4Signature,
  stringToSign,
  UNSIGNED_PAYLOAD,
} from '../src/sigv4';

export interface S3StubConfig {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Stub clock for presigned-URL expiry (epoch ms). */
  readonly now: () => number;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  /** Response headers to echo (content-type + x-amz-meta-*). */
  readonly headers: Record<string, string>;
}

export interface S3Stub {
  /** Endpoint origin, e.g. `http://127.0.0.1:49152`. */
  readonly url: string;
  readonly objects: Map<string, StoredObject>;
  stop(): void;
}

function xmlError(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    { status, headers: { 'content-type': 'application/xml' } },
  );
}

function parseAmzDate(amzDate: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (m === null) return undefined;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

/** Verify either auth scheme; returns an error Response or undefined (ok). */
async function authorize(
  req: Request,
  url: URL,
  bodyHash: string,
  config: S3StubConfig,
): Promise<Response | undefined> {
  const scopeSuffix = `/${config.region}/s3/aws4_request`;

  const authHeader = req.headers.get('authorization');
  if (authHeader !== null) {
    const m =
      /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
        authHeader,
      );
    if (m === null) return xmlError(400, 'InvalidRequest', 'bad authorization');
    const [, credential, signedHeaderList, signature] = m as unknown as [
      string,
      string,
      string,
      string,
    ];
    const credParts = credential.split('/');
    const accessKeyId = credParts[0] ?? '';
    const dateStamp = credParts[1] ?? '';
    if (
      accessKeyId !== config.accessKeyId ||
      !credential.endsWith(scopeSuffix)
    ) {
      return xmlError(403, 'InvalidAccessKeyId', 'unknown credential');
    }
    const amzDate = req.headers.get('x-amz-date') ?? '';
    const payloadHash = req.headers.get('x-amz-content-sha256') ?? '';
    if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== bodyHash) {
      return xmlError(400, 'XAmzContentSHA256Mismatch', 'body hash mismatch');
    }
    const headers: Record<string, string> = {};
    for (const name of signedHeaderList.split(';')) {
      const value = req.headers.get(name);
      if (value === null) {
        return xmlError(403, 'SignatureDoesNotMatch', `missing header ${name}`);
      }
      headers[name] = value;
    }
    const { text } = canonicalRequest({
      method: req.method,
      canonicalPath: url.pathname,
      query: url.searchParams,
      headers,
      payloadHash,
    });
    const expected = await sigV4Signature({
      secretAccessKey: config.secretAccessKey,
      dateStamp,
      region: config.region,
      service: 's3',
      stringToSign: await stringToSign(
        amzDate,
        `${dateStamp}${scopeSuffix}`,
        text,
      ),
    });
    if (signature !== expected) {
      return xmlError(403, 'SignatureDoesNotMatch', 'signature mismatch');
    }
    return undefined;
  }

  if (url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    const credential = url.searchParams.get('X-Amz-Credential') ?? '';
    const amzDate = url.searchParams.get('X-Amz-Date') ?? '';
    const expires = Number(url.searchParams.get('X-Amz-Expires') ?? 'NaN');
    const signature = url.searchParams.get('X-Amz-Signature') ?? '';
    const signedHeaderList = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    const credParts = credential.split('/');
    const accessKeyId = credParts[0] ?? '';
    const dateStamp = credParts[1] ?? '';
    if (
      accessKeyId !== config.accessKeyId ||
      !credential.endsWith(scopeSuffix)
    ) {
      return xmlError(403, 'InvalidAccessKeyId', 'unknown credential');
    }
    const issuedAtMs = parseAmzDate(amzDate);
    if (issuedAtMs === undefined || !Number.isFinite(expires)) {
      return xmlError(403, 'AccessDenied', 'malformed presign parameters');
    }
    const nowMs = config.now();
    if (nowMs > issuedAtMs + expires * 1000) {
      return xmlError(403, 'AccessDenied', 'Request has expired');
    }
    if (nowMs < issuedAtMs - 15 * 60 * 1000) {
      return xmlError(403, 'AccessDenied', 'Request is not yet valid');
    }
    const headers: Record<string, string> = {};
    for (const name of signedHeaderList.split(';')) {
      const value = req.headers.get(name);
      if (value === null) {
        return xmlError(403, 'SignatureDoesNotMatch', `missing header ${name}`);
      }
      headers[name] = value;
    }
    const query = [...url.searchParams].filter(
      ([name]) => name !== 'X-Amz-Signature',
    );
    const { text } = canonicalRequest({
      method: req.method,
      canonicalPath: url.pathname,
      query,
      headers,
      payloadHash: UNSIGNED_PAYLOAD,
    });
    const expected = await sigV4Signature({
      secretAccessKey: config.secretAccessKey,
      dateStamp,
      region: config.region,
      service: 's3',
      stringToSign: await stringToSign(
        amzDate,
        `${dateStamp}${scopeSuffix}`,
        text,
      ),
    });
    if (signature !== expected) {
      return xmlError(403, 'SignatureDoesNotMatch', 'signature mismatch');
    }
    return undefined;
  }

  return xmlError(403, 'AccessDenied', 'no authentication supplied');
}

export function startS3Stub(config: S3StubConfig): S3Stub {
  const objects = new Map<string, StoredObject>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      const denial = await authorize(req, url, await sha256Hex(body), config);
      if (denial !== undefined) return denial;

      const bucketPrefix = `/${config.bucket}/`;
      if (!url.pathname.startsWith(bucketPrefix)) {
        return xmlError(404, 'NoSuchBucket', 'unknown bucket');
      }
      const key = decodeURIComponent(url.pathname.slice(bucketPrefix.length));

      switch (req.method) {
        case 'PUT': {
          // Conditional writes for optimistic-concurrency (ETag CAS): S3 and
          // R2 honor `If-Match` (update only if the current ETag matches) and
          // `If-None-Match: *` (create only if absent). A failed precondition
          // is `412 PreconditionFailed`. The stats-accumulator CAS loop in
          // `S3SegmentStore` relies on exactly this.
          const existing = objects.get(key);
          const ifMatch = req.headers.get('if-match');
          const ifNoneMatch = req.headers.get('if-none-match');
          const currentEtag =
            existing === undefined
              ? undefined
              : (existing.headers.etag as string | undefined);
          if (ifNoneMatch === '*' && existing !== undefined) {
            return xmlError(
              412,
              'PreconditionFailed',
              'object already exists (If-None-Match)',
            );
          }
          if (ifMatch !== null && ifMatch !== currentEtag) {
            return xmlError(
              412,
              'PreconditionFailed',
              'etag mismatch (If-Match)',
            );
          }
          const etag = `"${await sha256Hex(body)}"`;
          const headers: Record<string, string> = { etag };
          for (const [name, value] of req.headers) {
            const lower = name.toLowerCase();
            if (lower === 'content-type' || lower.startsWith('x-amz-meta-')) {
              headers[lower] = value;
            }
          }
          objects.set(key, { bytes: body, headers });
          return new Response(null, { status: 200, headers: { etag } });
        }
        case 'GET':
        case 'HEAD': {
          const stored = objects.get(key);
          if (stored === undefined) {
            return req.method === 'HEAD'
              ? new Response(null, { status: 404 })
              : xmlError(404, 'NoSuchKey', 'no such key');
          }
          return new Response(
            req.method === 'HEAD'
              ? null
              : (stored.bytes as unknown as BodyInit),
            {
              status: 200,
              headers: {
                ...stored.headers,
                'content-length': String(stored.bytes.length),
              },
            },
          );
        }
        case 'DELETE': {
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        default:
          return xmlError(405, 'MethodNotAllowed', req.method);
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    objects,
    stop: () => server.stop(true),
  };
}
