/**
 * S3-compatible blob store (SPEC.md §5.9.2 durable objects, §5.9.5 delegated
 * presign) — AWS S3, Cloudflare R2, MinIO. The blob twin of
 * `s3-segment-store.ts`: same hand-rolled SigV4 over `fetch` (sigv4.ts), same
 * content-addressed key layout, same LIST-free-on-the-hot-path CAS stats
 * accumulator. Zero dependencies.
 *
 * Key layout (deterministic — every point lookup is a GET/HEAD, never a LIST):
 *
 *   {keyPrefix}blob/sha256/{hex}
 *     The blob bytes, VERBATIM (the object body MUST be exactly the
 *     content-addressed bytes so a presigned GET serves them directly and the
 *     client's §5.9.1 hash check passes — blobs are never re-compressed at
 *     rest, §5.8/§5.9.5). The `byteLength` + optional `mediaType` ride along
 *     as object user metadata `x-amz-meta-syncular-blob` = base64url(JSON), so
 *     `get` is a single GET. `createdAtMs` is stored there too so the orphan
 *     sweep (§5.9.2) can read the upload age without a separate index.
 *
 * DURABILITY vs SEGMENT TTL — the honest interface difference (§5.9.2): a
 * blob referenced by a live row must stay downloadable INDEFINITELY. So,
 * unlike `S3SegmentStore`, this store writes **no `expiresAtMs`, no S3
 * lifecycle-expiration mapping, and no TTL config**. Expiry is
 * REFERENCE-driven, not time-driven: reclamation is the host-scheduled
 * `sweepOrphanBlobs` (blob-store.ts) deleting only objects no live row
 * references after a grace period — never a bucket lifecycle rule. Do NOT
 * put a lifecycle expiration on the `blob/` prefix; it would delete
 * still-referenced attachments.
 *
 * The orphan sweep is the ONLY operation that LISTs: `sweepOrphans` pages
 * `ListObjectsV2` over the `blob/` prefix (an admin/GC path, off the hot
 * path) to find candidates, reads each object's `createdAtMs` from its
 * metadata for the grace check, and DELETEs the unreferenced-and-old ones.
 */
import type { BlobRecord, BlobStore, BlobStoreStats } from './blob-store';
import type {
  BlobPresignConfig,
  BlobUploadPresignConfig,
  SegmentUrlIssue,
} from './signed-url';
import {
  EMPTY_PAYLOAD_SHA256,
  presignUrl,
  type SigV4Credentials,
  sha256Hex,
  signRequest,
} from './sigv4';

export interface S3BlobStoreConfig {
  /**
   * Endpoint origin, no bucket, no trailing slash:
   * AWS `https://s3.<region>.amazonaws.com`,
   * R2 `https://<account-id>.r2.cloudflarestorage.com`,
   * MinIO `http://127.0.0.1:9000`. Requests are path-style
   * (`{endpoint}/{bucket}/{key}`), which all three accept.
   */
  readonly endpoint: string;
  /** AWS region; R2 uses `auto`. */
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token. */
  readonly sessionToken?: string;
  /** Key namespace inside the bucket, e.g. `syncular/`. Default: none. */
  readonly keyPrefix?: string;
}

const BLOB_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BLOB_META_HEADER = 'x-amz-meta-syncular-blob';

/**
 * Stats accumulator (mirrors `S3SegmentStore`): a small counter object under
 * a fixed key, updated read-modify-write on `put` under an ETag
 * compare-and-swap. A LIST-free point-lookup store cannot count objects on
 * demand cheaply, so `stats()` reads the accumulator. The counters are
 * APPROXIMATE — a crash between the blob PUT and the accumulator CAS, or a
 * sweep DELETE the accumulator does not decrement, drifts them — so the
 * admin surface labels S3 blob stats `approximate: true`. A health gauge,
 * not an invoice.
 */
const STATS_KEY_SUFFIX = 'stats/blobs.json';
const STATS_CAS_ATTEMPTS = 16;

interface StatsAccumulator {
  count: number;
  bytes: number;
}

function emptyStats(): StatsAccumulator {
  return { count: 0, bytes: 0 };
}

function parseStatsJson(json: string): StatsAccumulator {
  const parsed = JSON.parse(json) as Partial<StatsAccumulator>;
  return {
    count: Number(parsed.count ?? 0),
    bytes: Number(parsed.bytes ?? 0),
  };
}

// Runtime-neutral base64url (TODO §4.2): `Buffer` is not present on
// Cloudflare Workers without `nodejs_compat`, so the metadata header is
// (de)coded with `btoa`/`atob`, available in every runtime.
function utf8ToBase64url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function base64urlToUtf8(value: string): string {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

interface BlobMeta {
  readonly byteLength: number;
  readonly mediaType?: string;
  readonly createdAtMs: number;
}

function metaToJson(meta: BlobMeta): string {
  return JSON.stringify(meta);
}

function parseMetaJson(json: string, source: string): BlobMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`S3BlobStore: corrupt blob metadata in ${source}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`S3BlobStore: corrupt blob metadata in ${source}`);
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.byteLength !== 'number' || typeof r.createdAtMs !== 'number') {
    throw new Error(`S3BlobStore: bad blob metadata in ${source}`);
  }
  return {
    byteLength: r.byteLength,
    ...(typeof r.mediaType === 'string' ? { mediaType: r.mediaType } : {}),
    createdAtMs: r.createdAtMs,
  };
}

/** One `<Contents>` entry from a `ListObjectsV2` page. */
interface ListedObject {
  readonly key: string;
}

/**
 * Extract `<Key>` values (and the `<NextContinuationToken>`, if the listing
 * is truncated) from a `ListObjectsV2` XML body. A tiny regex reader — the
 * only XML the store ever parses, and only on the GC path. `ListObjectsV2`
 * returns keys XML-escaped for `& < >`; we unescape those three.
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

export class S3BlobStore implements BlobStore {
  readonly #config: S3BlobStoreConfig;
  readonly #credentials: SigV4Credentials;
  readonly #prefix: string;

  constructor(config: S3BlobStoreConfig) {
    this.#config = config;
    this.#credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined
        ? { sessionToken: config.sessionToken }
        : {}),
    };
    this.#prefix = config.keyPrefix ?? '';
  }

  /**
   * `{keyPrefix}blob/{partition}/sha256/{hex}` — the §5.9.5 "signed key embeds
   * the blobId". Blobs are content-addressed, but download authorization and
   * the reference index are per-partition, so the same bytes uploaded under
   * two partitions are two objects (a partition MUST NOT read another's
   * attachment by guessing a content address). The partition is folded into
   * the key as a path segment.
   */
  objectKeyFor(partition: string, blobId: string): string {
    return `${this.#prefix}blob/${partition}/${blobId.replace(':', '/')}`;
  }

  #statsKey(): string {
    return `${this.#prefix}${STATS_KEY_SUFFIX}`;
  }

  #urlFor(key: string): URL {
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
    },
  ): Promise<Response | undefined> {
    const url = this.#urlFor(key);
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
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `S3BlobStore: ${method} ${key} failed with ${response.status}: ${detail}`,
      );
    }
    return response;
  }

  async #readStats(): Promise<{
    stats: StatsAccumulator;
    etag: string | undefined;
  }> {
    const response = await this.#request('GET', this.#statsKey());
    if (response === undefined) {
      return { stats: emptyStats(), etag: undefined };
    }
    const etag = response.headers.get('etag') ?? undefined;
    const stats = parseStatsJson(await response.text());
    return { stats, etag };
  }

  async #writeStatsCas(
    stats: StatsAccumulator,
    etag: string | undefined,
  ): Promise<boolean> {
    const url = this.#urlFor(this.#statsKey());
    const body = new TextEncoder().encode(JSON.stringify(stats));
    const conditional: Record<string, string> =
      etag === undefined ? { 'if-none-match': '*' } : { 'if-match': etag };
    const headers = await signRequest({
      method: 'PUT',
      url,
      region: this.#config.region,
      credentials: this.#credentials,
      nowMs: Date.now(),
      payloadHash: await sha256Hex(body),
      headers: { 'content-type': 'application/json', ...conditional },
    });
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: body as BodyInit,
    });
    if (response.status === 412) {
      await response.arrayBuffer();
      return false;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `S3BlobStore: stats PUT failed with ${response.status}: ${detail}`,
      );
    }
    await response.arrayBuffer();
    return true;
  }

  /**
   * Fold `delta` into the stats accumulator under an ETag CAS retry loop.
   * Best-effort: exhausting the budget leaves the counters drifted (they are
   * documented APPROXIMATE) rather than failing an op that already touched
   * the bytes.
   */
  async #bumpStats(delta: StatsAccumulator): Promise<void> {
    for (let attempt = 0; attempt < STATS_CAS_ATTEMPTS; attempt++) {
      const { stats, etag } = await this.#readStats();
      const next: StatsAccumulator = {
        count: stats.count + delta.count,
        bytes: stats.bytes + delta.bytes,
      };
      if (await this.#writeStatsCas(next, etag)) return;
    }
    // Lost the CAS race `STATS_CAS_ATTEMPTS` times — leave counters as-is;
    // `stats()` stays APPROXIMATE by contract.
  }

  async put(
    partition: string,
    blobId: string,
    bytes: Uint8Array,
    nowMs: number,
    mediaType?: string,
  ): Promise<BlobRecord> {
    const record: BlobRecord = {
      blobId,
      partition,
      byteLength: bytes.length,
      ...(mediaType !== undefined ? { mediaType } : {}),
      createdAtMs: nowMs,
    };
    const objectKey = this.objectKeyFor(partition, blobId);
    // Idempotent re-put (same content-address ⇒ same key): count each distinct
    // blob once, and preserve the FIRST createdAtMs so the sweep's grace clock
    // is not reset by a re-upload (§5.9.2 upload age).
    const preexisting = await this.#request('HEAD', objectKey);
    if (preexisting !== undefined) {
      const meta = preexisting.headers.get(BLOB_META_HEADER);
      await preexisting.arrayBuffer();
      if (meta !== null) {
        const existing = parseMetaJson(base64urlToUtf8(meta), blobId);
        return {
          blobId,
          partition,
          byteLength: existing.byteLength,
          ...(existing.mediaType !== undefined
            ? { mediaType: existing.mediaType }
            : {}),
          createdAtMs: existing.createdAtMs,
        };
      }
    }
    const meta: BlobMeta = {
      byteLength: bytes.length,
      ...(mediaType !== undefined ? { mediaType } : {}),
      createdAtMs: nowMs,
    };
    const response = await this.#request('PUT', objectKey, {
      body: bytes,
      headers: {
        'content-type': mediaType ?? 'application/octet-stream',
        [BLOB_META_HEADER]: utf8ToBase64url(metaToJson(meta)),
      },
    });
    await response?.arrayBuffer();
    await this.#bumpStats({ count: 1, bytes: bytes.length });
    return record;
  }

  async has(partition: string, blobId: string): Promise<boolean> {
    if (!BLOB_ID_PATTERN.test(blobId)) return false;
    const response = await this.#request(
      'HEAD',
      this.objectKeyFor(partition, blobId),
    );
    if (response === undefined) return false;
    await response.arrayBuffer();
    return true;
  }

  async get(
    partition: string,
    blobId: string,
  ): Promise<{ record: BlobRecord; bytes: Uint8Array } | undefined> {
    if (!BLOB_ID_PATTERN.test(blobId)) return undefined;
    const response = await this.#request(
      'GET',
      this.objectKeyFor(partition, blobId),
    );
    if (response === undefined) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const rawMeta = response.headers.get(BLOB_META_HEADER);
    const meta =
      rawMeta !== null
        ? parseMetaJson(base64urlToUtf8(rawMeta), blobId)
        : { byteLength: bytes.length, createdAtMs: 0 };
    return {
      record: {
        blobId,
        partition,
        byteLength: meta.byteLength,
        ...(meta.mediaType !== undefined ? { mediaType: meta.mediaType } : {}),
        createdAtMs: meta.createdAtMs,
      },
      bytes,
    };
  }

  /**
   * §5.9.2 orphan sweep — the ONLY LISTing operation. Page `ListObjectsV2`
   * over `{prefix}blob/{partition}/`, HEAD each object for its `createdAtMs`,
   * and DELETE the ones both older than `olderThanMs` AND absent from
   * `referencedBlobIds`. Returns the deleted blobIds. Never deletes a
   * referenced blob (§5.9.2). Off the hot path — a host-scheduled GC job.
   */
  async sweepOrphans(
    partition: string,
    olderThanMs: number,
    referencedBlobIds: ReadonlySet<string>,
  ): Promise<string[]> {
    const listPrefix = `${this.#prefix}blob/${partition}/`;
    const swept: string[] = [];
    let deletedBytes = 0;
    let continuationToken: string | undefined;
    do {
      const query: Array<readonly [string, string]> = [
        ['list-type', '2'],
        ['prefix', listPrefix],
      ];
      if (continuationToken !== undefined) {
        query.push(['continuation-token', continuationToken]);
      }
      // ListObjectsV2 is a bucket-level GET (`GET /{bucket}?list-type=2`).
      const response = await this.#request('GET', '', { query });
      if (response === undefined) break;
      const { objects, nextToken } = parseListObjectsV2(await response.text());
      continuationToken = nextToken;
      for (const { key } of objects) {
        // `{listPrefix}sha256/{hex}` → `sha256:{hex}`.
        const rest = key.slice(listPrefix.length);
        if (!rest.startsWith('sha256/')) continue;
        const blobId = `sha256:${rest.slice('sha256/'.length)}`;
        if (!BLOB_ID_PATTERN.test(blobId)) continue;
        if (referencedBlobIds.has(blobId)) continue;
        const head = await this.#request('HEAD', key);
        if (head === undefined) continue;
        const rawMeta = head.headers.get(BLOB_META_HEADER);
        const lengthHeader = head.headers.get('content-length');
        await head.arrayBuffer();
        const meta =
          rawMeta !== null
            ? parseMetaJson(base64urlToUtf8(rawMeta), blobId)
            : {
                byteLength: Number(lengthHeader ?? 0),
                createdAtMs: 0,
              };
        if (meta.createdAtMs >= olderThanMs) continue;
        const del = await this.#request('DELETE', key);
        await del?.arrayBuffer();
        swept.push(blobId);
        deletedBytes += meta.byteLength;
      }
    } while (continuationToken !== undefined);
    if (swept.length > 0) {
      await this.#bumpStats({ count: -swept.length, bytes: -deletedBytes });
    }
    return swept;
  }

  /**
   * Store-wide counters from the pointer-object accumulator (never a LIST on
   * the read path). `approximate: true` for the same reasons `S3SegmentStore`
   * documents: best-effort ETag-CAS maintenance and sweep deletes that may
   * miss the decrement. Exact within a single writer; a health gauge under
   * concurrency. Note this is store-WIDE, not partition-scoped, so a shared
   * bucket reports the whole bucket — the parameter is accepted for interface
   * parity but the accumulator is one object per store.
   */
  async stats(_partition: string): Promise<BlobStoreStats> {
    const { stats } = await this.#readStats();
    return { count: stats.count, bytes: stats.bytes, approximate: true };
  }

  /**
   * SigV4 presigned GET for a blob object (§5.9.5 delegated presign). The
   * signed key embeds the `blobId`; `urlExpiresAtMs` is the provider-enforced
   * expiry (`X-Amz-Date + X-Amz-Expires`). Issued ONLY after the row-derived
   * authorization check (§5.9.5) — the caller (blob-handlers) resolves scopes
   * and tests referencing rows first; the URL is then a short-TTL bearer
   * grant to exactly those immutable bytes. TTL SHOULD be ≤ 15 minutes;
   * default 900 s.
   */
  async presignBlobGet(
    partition: string,
    blobId: string,
    options?: { readonly ttlSeconds?: number; readonly nowMs?: number },
  ): Promise<SegmentUrlIssue> {
    if (!BLOB_ID_PATTERN.test(blobId)) {
      throw new Error(`S3BlobStore: malformed blobId ${blobId}`);
    }
    const ttlSeconds = options?.ttlSeconds ?? 900;
    const nowMs = options?.nowMs ?? Date.now();
    const url = await presignUrl({
      url: this.#urlFor(this.objectKeyFor(partition, blobId)),
      region: this.#config.region,
      credentials: this.#credentials,
      nowMs,
      expiresSeconds: ttlSeconds,
    });
    return {
      url: url.toString(),
      urlExpiresAtMs: (Math.floor(nowMs / 1000) + ttlSeconds) * 1000,
    };
  }

  /**
   * SigV4 presigned PUT for a blob object (§5.9.3 direct-to-storage upload).
   * The blob twin of `presignBlobGet`: the signed key embeds the `blobId`, so
   * the grant places bytes at exactly the content-addressed key. The store
   * does NOT recompute the SHA-256 (it is the object store, not the sync
   * server); integrity is enforced at REFERENCE time — the §5.9.6 push
   * existence check verifies the object exists (`has`) and every consumer
   * re-verifies the content address over the received bytes (§5.9.5/§5.1). A
   * client PUTting bytes that do not hash to `{blobId}` poisons only its own
   * upload; no honest reference resolves to it. Issued by the upload-grant
   * handler after host authentication; TTL SHOULD be ≤ 15 min (default 900).
   */
  async presignBlobPut(
    partition: string,
    blobId: string,
    options?: { readonly ttlSeconds?: number; readonly nowMs?: number },
  ): Promise<SegmentUrlIssue> {
    if (!BLOB_ID_PATTERN.test(blobId)) {
      throw new Error(`S3BlobStore: malformed blobId ${blobId}`);
    }
    const ttlSeconds = options?.ttlSeconds ?? 900;
    const nowMs = options?.nowMs ?? Date.now();
    const url = await presignUrl({
      method: 'PUT',
      url: this.#urlFor(this.objectKeyFor(partition, blobId)),
      region: this.#config.region,
      credentials: this.#credentials,
      nowMs,
      expiresSeconds: ttlSeconds,
    });
    return {
      url: url.toString(),
      urlExpiresAtMs: (Math.floor(nowMs / 1000) + ttlSeconds) * 1000,
    };
  }
}

/**
 * Wire an `S3BlobStore` into `SyncServerConfig.blobSignedUrls` as the §5.9.5
 * delegated-presign scheme for blob downloads:
 * `blobSignedUrls: s3PresignedBlobUrls(blobStore, { ttlSeconds: 900 })`.
 * The presigned URL is issued only after the row-derived authorization check
 * (blob-handlers) — never as a bearer capability minted from the id alone.
 */
export function s3PresignedBlobUrls(
  store: S3BlobStore,
  options?: { readonly ttlSeconds?: number },
): BlobPresignConfig {
  return {
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
    presign: ({ partition, blobId, ttlSeconds, nowMs }) =>
      store.presignBlobGet(partition, blobId, { ttlSeconds, nowMs }),
  };
}

/**
 * Wire an `S3BlobStore` into `SyncServerConfig.blobUploadUrls` as the §5.9.3
 * presigned-upload (direct-to-storage) scheme:
 * `blobUploadUrls: s3PresignedBlobUploads(blobStore, { ttlSeconds: 900 })`.
 * The upload-grant handler issues the presigned PUT only after host
 * authentication + the size-cap check; the client PUTs bytes straight to the
 * object store with no host auth (§5.9.3). Integrity stays the content-address
 * check at reference/download time — never a store-side hash recompute.
 */
export function s3PresignedBlobUploads(
  store: S3BlobStore,
  options?: { readonly ttlSeconds?: number },
): BlobUploadPresignConfig {
  return {
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
    presign: ({ partition, blobId, ttlSeconds, nowMs }) =>
      store.presignBlobPut(partition, blobId, { ttlSeconds, nowMs }),
  };
}
