/**
 * S3-compatible segment store (SPEC.md §5.1 cache semantics, §5.4
 * delegated presign) — AWS S3, Cloudflare R2, MinIO. Zero dependencies:
 * hand-rolled SigV4 over `fetch` (sigv4.ts).
 *
 * Key layout (deterministic — every lookup is a GET/HEAD, never a LIST):
 *
 *   {keyPrefix}seg/sha256/{hex}
 *     The segment bytes, verbatim (the object body MUST be exactly the
 *     content-addressed bytes so presigned GETs serve them directly and
 *     the client's §5.1 hash check passes). The full `SegmentRecord`
 *     (minus bytes) rides along as object user metadata
 *     `x-amz-meta-syncular-record` = base64url(JSON), so `get` is a
 *     single GET.
 *
 *   {keyPrefix}find/{sha256Hex(canonical reuse key)}.json
 *     Whole-table reuse pointer (§5.3): written only when
 *     `rowCursor === null`, body = the record JSON. The reuse key is the
 *     canonical JSON array `[partition, table, schemaVersion, mediaType,
 *     scopeDigest, asOfCommitSeq]`, so `find` is one GET (plus a HEAD to
 *     confirm the segment object itself still exists — lifecycle GC may
 *     remove objects independently of pointers).
 *
 * TTL mapping: expiry is **store-side and authoritative** — `expiresAtMs`
 * (put-time + `ttlMs`, default 24 h) is recorded in the object metadata
 * and the pointer; `get` returns expired records so §5.5 can answer
 * `sync.segment_expired`, and `find` filters them out itself. S3 lifecycle
 * expiration is garbage collection only: configure it comfortably ABOVE
 * `ttlMs` (e.g. 2 days for the 24 h default) so clients normally see the
 * precise, retryable `sync.segment_expired` and hit `sync.not_found` only
 * long after. Never set lifecycle below `ttlMs`.
 */
import type {
  SegmentFindKey,
  SegmentMetadata,
  SegmentRecord,
  SegmentStore,
  SegmentStoreStats,
} from './segment-store';
import { segmentIdFor } from './segment-store';
import type { DelegatedPresignConfig, SegmentUrlIssue } from './signed-url';
import {
  EMPTY_PAYLOAD_SHA256,
  presignUrl,
  type SigV4Credentials,
  sha256Hex,
  signRequest,
} from './sigv4';

export interface S3SegmentStoreConfig {
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
  /** Segment TTL (§5.1 cache semantics). Default 24 h. */
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const SEGMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RECORD_META_HEADER = 'x-amz-meta-syncular-record';

/**
 * Stats accumulator (§ "S3 stats" in the README). The store keeps a small
 * counter object under a fixed key, updated read-modify-write on `put`. It
 * exists because a LIST-free store (every lookup is a GET/HEAD) has no cheap
 * way to count objects on demand — so `stats()` reads the accumulator instead
 * of enumerating the bucket.
 *
 * The write is guarded by an ETag compare-and-swap (`If-Match`, or
 * `If-None-Match: *` to create): the loop re-reads and retries on a `412`
 * precondition failure, so concurrent writers do not silently clobber each
 * other's increment. The counters are still APPROXIMATE — a crash between the
 * segment PUT and the accumulator CAS, or a writer against a backend that
 * ignores conditional headers, can drift them — so the admin surface labels
 * S3 stats `approximate: true`. They are a health gauge, not an invoice.
 */
const STATS_KEY_SUFFIX = 'stats/segments.json';
const STATS_CAS_ATTEMPTS = 16;

interface StatsAccumulator {
  count: number;
  bytes: number;
  rowsSegments: number;
  sqliteSegments: number;
}

function emptyStats(): StatsAccumulator {
  return { count: 0, bytes: 0, rowsSegments: 0, sqliteSegments: 0 };
}

function parseStatsJson(json: string): StatsAccumulator {
  const parsed = JSON.parse(json) as Partial<StatsAccumulator>;
  return {
    count: Number(parsed.count ?? 0),
    bytes: Number(parsed.bytes ?? 0),
    rowsSegments: Number(parsed.rowsSegments ?? 0),
    sqliteSegments: Number(parsed.sqliteSegments ?? 0),
  };
}

// Runtime-neutral base64url (TODO §4.2): `Buffer` is not present on
// Cloudflare Workers without `nodejs_compat`, so the object-metadata record
// header is (de)coded with `btoa`/`atob`, available in every runtime.
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

function recordToJson(record: SegmentRecord): string {
  return JSON.stringify(record);
}

function isMediaType(value: unknown): value is 'rows' | 'sqlite' {
  return value === 'rows' || value === 'sqlite';
}

function parseRecordJson(json: string, source: string): SegmentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`S3SegmentStore: corrupt record JSON in ${source}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`S3SegmentStore: corrupt record in ${source}`);
  }
  const r = parsed as Record<string, unknown>;
  const strings = ['segmentId', 'partition', 'table', 'scopeDigest'] as const;
  const numbers = [
    'schemaVersion',
    'asOfCommitSeq',
    'rowCount',
    'byteLength',
    'createdAtMs',
    'expiresAtMs',
  ] as const;
  for (const field of strings) {
    if (typeof r[field] !== 'string') {
      throw new Error(`S3SegmentStore: bad record field ${field} in ${source}`);
    }
  }
  for (const field of numbers) {
    if (typeof r[field] !== 'number') {
      throw new Error(`S3SegmentStore: bad record field ${field} in ${source}`);
    }
  }
  if (!isMediaType(r.mediaType)) {
    throw new Error(`S3SegmentStore: bad record mediaType in ${source}`);
  }
  const cursorOk = (v: unknown): v is string | null =>
    v === null || typeof v === 'string';
  if (!cursorOk(r.rowCursor) || !cursorOk(r.nextRowCursor)) {
    throw new Error(`S3SegmentStore: bad record cursor in ${source}`);
  }
  return {
    segmentId: r.segmentId as string,
    partition: r.partition as string,
    table: r.table as string,
    schemaVersion: r.schemaVersion as number,
    mediaType: r.mediaType,
    scopeDigest: r.scopeDigest as string,
    asOfCommitSeq: r.asOfCommitSeq as number,
    rowCount: r.rowCount as number,
    rowCursor: r.rowCursor,
    nextRowCursor: r.nextRowCursor,
    byteLength: r.byteLength as number,
    createdAtMs: r.createdAtMs as number,
    expiresAtMs: r.expiresAtMs as number,
  };
}

export class S3SegmentStore implements SegmentStore {
  readonly #config: S3SegmentStoreConfig;
  readonly #credentials: SigV4Credentials;
  readonly #ttlMs: number;
  readonly #prefix: string;

  constructor(config: S3SegmentStoreConfig) {
    this.#config = config;
    this.#credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined
        ? { sessionToken: config.sessionToken }
        : {}),
    };
    this.#ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.#prefix = config.keyPrefix ?? '';
  }

  /** `{keyPrefix}seg/sha256/{hex}` — the §5.4 "key embeds the segmentId". */
  objectKeyFor(segmentId: string): string {
    return `${this.#prefix}seg/${segmentId.replace(':', '/')}`;
  }

  async #findKeyFor(key: SegmentFindKey): Promise<string> {
    const canonical = JSON.stringify([
      key.partition,
      key.table,
      key.schemaVersion,
      key.mediaType,
      key.scopeDigest,
      key.asOfCommitSeq,
    ]);
    return `${this.#prefix}find/${await sha256Hex(canonical)}.json`;
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
    },
  ): Promise<Response | undefined> {
    const url = this.#urlFor(key);
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
        `S3SegmentStore: ${method} ${key} failed with ${response.status}: ${detail}`,
      );
    }
    return response;
  }

  /** Read the stats accumulator + its ETag (for the CAS write), or none. */
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

  /**
   * Conditionally write the stats accumulator. `etag` present ⇒ `If-Match`
   * (update the object we read); absent ⇒ `If-None-Match: *` (create only).
   * Returns `false` on a `412` precondition failure so the caller retries.
   */
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
        `S3SegmentStore: stats PUT failed with ${response.status}: ${detail}`,
      );
    }
    await response.arrayBuffer();
    return true;
  }

  /**
   * Fold `delta` into the stats accumulator under an ETag compare-and-swap
   * retry loop. Best-effort: exhausting the retry budget leaves the counters
   * drifted (they are documented APPROXIMATE) rather than failing the `put`
   * that already stored the bytes.
   */
  async #bumpStats(delta: StatsAccumulator): Promise<void> {
    for (let attempt = 0; attempt < STATS_CAS_ATTEMPTS; attempt++) {
      const { stats, etag } = await this.#readStats();
      const next: StatsAccumulator = {
        count: stats.count + delta.count,
        bytes: stats.bytes + delta.bytes,
        rowsSegments: stats.rowsSegments + delta.rowsSegments,
        sqliteSegments: stats.sqliteSegments + delta.sqliteSegments,
      };
      if (await this.#writeStatsCas(next, etag)) return;
    }
    // Lost the CAS race `STATS_CAS_ATTEMPTS` times running — leave the
    // counters as-is. `stats()` stays APPROXIMATE by contract.
  }

  async put(
    metadata: SegmentMetadata,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<SegmentRecord> {
    const segmentId = await segmentIdFor(bytes);
    const record: SegmentRecord = {
      ...metadata,
      segmentId,
      byteLength: bytes.length,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
    };
    const recordJson = recordToJson(record);
    // Detect an idempotent re-put (same content-address ⇒ same key) so the
    // stats accumulator counts each distinct segment once, not once per PUT.
    const objectKey = this.objectKeyFor(segmentId);
    const preexisting = await this.#request('HEAD', objectKey);
    await preexisting?.arrayBuffer();
    const isNew = preexisting === undefined;
    const response = await this.#request('PUT', objectKey, {
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        [RECORD_META_HEADER]: utf8ToBase64url(recordJson),
      },
    });
    await response?.arrayBuffer();
    if (isNew) {
      await this.#bumpStats({
        count: 1,
        bytes: bytes.length,
        rowsSegments: metadata.mediaType === 'rows' ? 1 : 0,
        sqliteSegments: metadata.mediaType === 'sqlite' ? 1 : 0,
      });
    }
    if (metadata.rowCursor === null) {
      const pointer = await this.#request(
        'PUT',
        await this.#findKeyFor(metadata),
        {
          body: new TextEncoder().encode(recordJson),
          headers: { 'content-type': 'application/json' },
        },
      );
      await pointer?.arrayBuffer();
    }
    return record;
  }

  async get(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; bytes: Uint8Array } | undefined> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) return undefined;
    const response = await this.#request('GET', this.objectKeyFor(segmentId));
    if (response === undefined) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const meta = response.headers.get(RECORD_META_HEADER);
    if (meta === null) {
      throw new Error(
        `S3SegmentStore: object for ${segmentId} lacks ${RECORD_META_HEADER}`,
      );
    }
    const record = parseRecordJson(base64urlToUtf8(meta), segmentId);
    return { record, bytes };
  }

  async find(
    key: SegmentFindKey,
    nowMs: number,
  ): Promise<SegmentRecord | undefined> {
    const response = await this.#request('GET', await this.#findKeyFor(key));
    if (response === undefined) return undefined;
    const record = parseRecordJson(await response.text(), 'reuse pointer');
    if (
      record.partition !== key.partition ||
      record.table !== key.table ||
      record.schemaVersion !== key.schemaVersion ||
      record.mediaType !== key.mediaType ||
      record.scopeDigest !== key.scopeDigest ||
      record.asOfCommitSeq !== key.asOfCommitSeq ||
      record.rowCursor !== null
    ) {
      return undefined;
    }
    if (record.expiresAtMs <= nowMs) return undefined;
    // Lifecycle GC may have removed the object while the pointer survived.
    const head = await this.#request(
      'HEAD',
      this.objectKeyFor(record.segmentId),
    );
    if (head === undefined) return undefined;
    await head.arrayBuffer();
    return record;
  }

  /**
   * Store-wide counters from the pointer-object accumulator (never a LIST).
   * Marked `approximate: true`: the counters are maintained by a best-effort
   * ETag-CAS read-modify-write on `put`, so a crash between the segment PUT
   * and the accumulator write, or lifecycle GC that deletes objects the
   * accumulator still counts, can drift them. Exact within a single writer;
   * a health gauge under concurrency. See the README "S3 stats".
   */
  async stats(): Promise<SegmentStoreStats> {
    const { stats } = await this.#readStats();
    return {
      count: stats.count,
      bytes: stats.bytes,
      rowsSegments: stats.rowsSegments,
      sqliteSegments: stats.sqliteSegments,
      approximate: true,
    };
  }

  /**
   * SigV4 presigned GET for a segment object (§5.4 delegated presign).
   * The signed key embeds the `segmentId` (equivalence rule) and
   * `urlExpiresAtMs` is the provider-enforced expiry
   * (`X-Amz-Date + X-Amz-Expires`). TTL SHOULD be ≤ 15 minutes (§5.4);
   * default 900 s.
   */
  async presignSegmentGet(
    segmentId: string,
    options?: { readonly ttlSeconds?: number; readonly nowMs?: number },
  ): Promise<SegmentUrlIssue> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) {
      throw new Error(`S3SegmentStore: malformed segmentId ${segmentId}`);
    }
    const ttlSeconds = options?.ttlSeconds ?? 900;
    const nowMs = options?.nowMs ?? Date.now();
    const url = await presignUrl({
      url: this.#urlFor(this.objectKeyFor(segmentId)),
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
 * Wire an `S3SegmentStore` into `SyncServerConfig.signedUrls` as the §5.4
 * delegated-presign scheme:
 * `signedUrls: s3PresignedUrls(store, { ttlSeconds: 900 })`.
 */
export function s3PresignedUrls(
  store: S3SegmentStore,
  options?: { readonly ttlSeconds?: number },
): DelegatedPresignConfig {
  return {
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
    presign: ({ segmentId, ttlSeconds, nowMs }) =>
      store.presignSegmentGet(segmentId, { ttlSeconds, nowMs }),
  };
}
