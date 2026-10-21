/**
 * `ObjectBucket` over the S3 REST API: hand-rolled SigV4 over `fetch`
 * (sigv4.ts), zero dependencies, path-style requests
 * (`{endpoint}/{bucket}/{key}`) that AWS S3, Cloudflare R2's S3 endpoint, and
 * MinIO all accept.
 *
 * This module owns the transport only. The segment and blob store logic lives
 * in `bucket-segment-store.ts` / `bucket-blob-store.ts` and runs over any
 * `ObjectBucket`, so the same objects are reachable through an R2 binding
 * (`R2SegmentStore` in `@syncular/server-workers`) with no copy between them.
 */
import type {
  BucketListPage,
  BucketObject,
  BucketObjectHead,
  BucketWriteOptions,
  ObjectBucket,
} from './object-bucket';
import {
  EMPTY_PAYLOAD_SHA256,
  type SigV4Credentials,
  sha256Hex,
  signRequest,
} from './sigv4';

export interface S3ObjectBucketConfig {
  /**
   * Endpoint origin, no bucket, no trailing slash:
   * AWS `https://s3.<region>.amazonaws.com`,
   * R2 `https://<account-id>.r2.cloudflarestorage.com`,
   * MinIO `http://127.0.0.1:9000`.
   */
  readonly endpoint: string;
  /** AWS region; R2 uses `auto`. */
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token. */
  readonly sessionToken?: string;
}

const META_HEADER_PREFIX = 'x-amz-meta-';

/** User metadata carried as `x-amz-meta-*` headers (lowercased by `Headers`). */
function metadataOf(headers: Headers): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.startsWith(META_HEADER_PREFIX)) {
      metadata[name.slice(META_HEADER_PREFIX.length)] = value;
    }
  }
  return metadata;
}

function sizeOf(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (value === null) return undefined;
  const size = Number(value);
  return Number.isFinite(size) ? size : undefined;
}

/** One `<Contents>` entry from a `ListObjectsV2` page. */
interface ListedObject {
  readonly key: string;
}

/**
 * Extract `<Key>` values (and the `<NextContinuationToken>`, if the listing
 * is truncated) from a `ListObjectsV2` XML body. A tiny regex reader; the
 * only XML the stores ever parse, and only on the GC path. `ListObjectsV2`
 * returns keys XML-escaped for `& < >`; we unescape those.
 */
function parseListObjectsV2(xml: string): {
  objects: ListedObject[];
  nextToken: string | undefined;
} {
  const objects: ListedObject[] = [];
  for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
    objects.push({ key: unescapeXml(m[1] ?? '') });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch =
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  const nextToken =
    truncated && tokenMatch !== null
      ? unescapeXml(tokenMatch[1] ?? '')
      : undefined;
  return { objects, nextToken };
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export class S3ObjectBucket implements ObjectBucket {
  readonly #config: S3ObjectBucketConfig;
  readonly #credentials: SigV4Credentials;

  constructor(config: S3ObjectBucketConfig) {
    this.#config = config;
    this.#credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined
        ? { sessionToken: config.sessionToken }
        : {}),
    };
  }

  /** The object URL the presign helpers sign (`{endpoint}/{bucket}/{key}`). */
  urlFor(key: string): URL {
    const endpoint = this.#config.endpoint.replace(/\/+$/, '');
    return new URL(`${endpoint}/${this.#config.bucket}/${key}`);
  }

  async #request(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    key: string,
    options?: {
      readonly body?: Uint8Array;
      readonly headers?: Readonly<Record<string, string>>;
      readonly query?: Iterable<readonly [string, string]>;
      /** Return a `412` response instead of throwing (conditional writes). */
      readonly allow412?: boolean;
    },
  ): Promise<Response | undefined> {
    const url = this.urlFor(key);
    if (options?.query !== undefined) {
      for (const [name, value] of options.query) {
        url.searchParams.set(name, value);
      }
    }
    const body = options?.body;
    const headers = await signRequest({
      method,
      url,
      region: this.#config.region,
      credentials: this.#credentials,
      nowMs: Date.now(),
      payloadHash:
        body === undefined ? EMPTY_PAYLOAD_SHA256 : await sha256Hex(body),
      ...(options?.headers !== undefined ? { headers: options.headers } : {}),
    });
    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    });
    if (response.status === 404) {
      await response.arrayBuffer();
      return undefined;
    }
    if (options?.allow412 === true && response.status === 412) return response;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `S3ObjectBucket: ${method} ${key} failed with ${response.status}: ${detail}`,
      );
    }
    return response;
  }

  async get(key: string): Promise<BucketObject | undefined> {
    const response = await this.#request('GET', key);
    if (response === undefined) return undefined;
    return {
      body: response.body,
      etag: response.headers.get('etag') ?? undefined,
      size: sizeOf(response.headers),
      metadata: metadataOf(response.headers),
      arrayBuffer: () => response.arrayBuffer(),
      text: () => response.text(),
    };
  }

  async head(key: string): Promise<BucketObjectHead | undefined> {
    const response = await this.#request('HEAD', key);
    if (response === undefined) return undefined;
    await response.arrayBuffer();
    return {
      etag: response.headers.get('etag') ?? undefined,
      size: sizeOf(response.headers),
      metadata: metadataOf(response.headers),
    };
  }

  async put(key: string, options: BucketWriteOptions): Promise<boolean> {
    const headers: Record<string, string> = {
      'content-type': options.contentType,
    };
    if (options.createOnly === true) headers['if-none-match'] = '*';
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      headers[`${META_HEADER_PREFIX}${name}`] = value;
    }
    const response = await this.#request('PUT', key, {
      body: options.body,
      headers,
      allow412: true,
    });
    if (response === undefined) {
      throw new Error(`S3ObjectBucket: PUT ${key} failed with 404`);
    }
    await response.arrayBuffer();
    // A failed `If-Match` / `If-None-Match: *` is a `412`: the caller's CAS
    // read superseded, so it re-reads instead of overwriting.
    return response.status !== 412;
  }

  async delete(key: string): Promise<void> {
    const response = await this.#request('DELETE', key);
    await response?.arrayBuffer();
  }

  async list(prefix: string, cursor?: string): Promise<BucketListPage> {
    const query: Array<readonly [string, string]> = [
      ['list-type', '2'],
      ['prefix', prefix],
    ];
    if (cursor !== undefined) query.push(['continuation-token', cursor]);
    // ListObjectsV2 is a bucket-level GET (`GET /{bucket}?list-type=2`).
    const response = await this.#request('GET', '', { query });
    if (response === undefined) return { keys: [], cursor: undefined };
    const { objects, nextToken } = parseListObjectsV2(await response.text());
    return { keys: objects.map((object) => object.key), cursor: nextToken };
  }
}
