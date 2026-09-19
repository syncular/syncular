/**
 * S3-compatible segment store (SPEC.md §5.1 cache semantics, §5.4
 * delegated presign) — AWS S3, Cloudflare R2, MinIO. Zero dependencies:
 * hand-rolled SigV4 over `fetch` (sigv4.ts).
 *
 * Key layout (deterministic — every lookup is a GET/HEAD, never a LIST):
 *
 *   {keyPrefix}seg/sha256/{hex}
 *     The segment bytes, verbatim and immutable (the object body MUST be
 *     exactly the content-addressed bytes so presigned GETs serve them
 *     directly and the client's §5.1 hash check passes).
 *
 *   {keyPrefix}rec/sha256/{hex}.json
 *     The `SegmentRecord` (§5.1). It is the one MUTABLE object of the two:
 *     the scope-digest set is a union that every publication extends, so
 *     the merge is a read-modify-write. Keeping the record in the body (not
 *     in the bytes object's user metadata) is what makes that write
 *     conditional — a body ETag changes when the union changes, while the
 *     bytes ETag is a content hash and is identical for identical bytes. A
 *     `412` re-reads and merges again, so no concurrent publication can drop
 *     another one's digest. `get` therefore reads two objects.
 *
 *   {keyPrefix}find/{sha256Hex(canonical reuse key)}.json
 *     Whole-table reuse pointer (§5.3): written only when
 *     `rowCursor === null`, body = the record JSON. The reuse key is the
 *     canonical JSON array `[partition, table, schemaVersion, mediaType,
 *     scopeDigest, asOfCommitSeq]`, so `find` is one GET (plus a HEAD to
 *     confirm the segment object itself still exists — lifecycle GC may
 *     remove objects independently of pointers).
 *
 * Records written before the split kept the record in the bytes object's
 * user metadata `x-amz-meta-syncular-record`; `get` still reads that shape
 * and the next `put` materializes the record object from it, so an upgrade
 * loses no cache entry.
 *
 * TTL mapping: expiry is **store-side and authoritative** — `expiresAtMs`
 * (put-time + `ttlMs`, default 24 h) is recorded in the record and the
 * pointer; `get` returns expired records so §5.5 can answer
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
import {
  mergeSegmentRecord,
  segmentBytesEqual,
  segmentIdFor,
} from './segment-store';
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
const CAS_ATTEMPTS = 16;

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

// Runtime-neutral base64url: `Buffer` is not present on
// Cloudflare Workers without `nodejs_compat`, so a legacy object-metadata
// record header is decoded with `atob`, available in every runtime.
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
  const strings = [
    'segmentId',
    'partition',
    'logEpoch',
    'table',
    'scopeDigest',
  ] as const;
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
  const scopeDigest = r.scopeDigest as string;
  // Records written before §5.1 recorded the digest set carry only the
  // primary digest; the object is a cache entry with a TTL, so reading it
  // back as a one-digest record is correct, not a degraded path.
  const rawDigests = r.scopeDigests;
  if (
    rawDigests !== undefined &&
    (!Array.isArray(rawDigests) ||
      rawDigests.some((digest) => typeof digest !== 'string'))
  ) {
    throw new Error(`S3SegmentStore: bad record scopeDigests in ${source}`);
  }
  return {
    segmentId: r.segmentId as string,
    partition: r.partition as string,
    logEpoch: r.logEpoch as string,
    table: r.table as string,
    schemaVersion: r.schemaVersion as number,
    mediaType: r.mediaType,
    scopeDigest,
    scopeDigests: [
      scopeDigest,
      ...((rawDigests ?? []) as string[]).filter(
        (digest) => digest !== scopeDigest,
      ),
    ],
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

  /** `{keyPrefix}rec/sha256/{hex}.json` — the §5.1 record (§5.1 union). */
  #recordKeyFor(segmentId: string): string {
    return `${this.#prefix}rec/${segmentId.replace(':', '/')}.json`;
  }

  async #findKeyFor(key: SegmentFindKey): Promise<string> {
    const canonical = JSON.stringify([
      key.partition,
      key.logEpoch,
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
      /** Return a `412` response instead of throwing (conditional writes). */
      readonly allow412?: boolean;
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
    if (options?.allow412 === true && response.status === 412) return response;
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
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const { stats, etag } = await this.#readStats();
      const next: StatsAccumulator = {
        count: stats.count + delta.count,
        bytes: stats.bytes + delta.bytes,
        rowsSegments: stats.rowsSegments + delta.rowsSegments,
        sqliteSegments: stats.sqliteSegments + delta.sqliteSegments,
      };
      if (await this.#writeStatsCas(next, etag)) return;
    }
    // Lost the CAS race `CAS_ATTEMPTS` times running — leave the
    // counters as-is. `stats()` stays APPROXIMATE by contract.
  }

  async put(
    metadata: SegmentMetadata,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<SegmentRecord> {
    const segmentId = await segmentIdFor(bytes);
    await this.#putBytes(segmentId, bytes);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      // The id IS the content address, so an existing record means a second
      // scope published the same bytes: read it back and merge the digest set
      // (§5.1).
      const preexisting = await this.#readRecord(segmentId);
      const record = mergeSegmentRecord(
        preexisting?.record,
        metadata,
        segmentId,
        bytes.length,
        nowMs,
        this.#ttlMs,
      );
      const recordJson = recordToJson(record);
      // The digest set is monotone (§5.1) and this is a read-modify-write: a
      // concurrent publisher of the same bytes computed its own union from the
      // same pre-state, so an unconditional PUT would drop one of the digests
      // and make that scope's download `sync.forbidden`. The write is
      // conditional on the record body that was read — the record ETag is the
      // body hash, so it changes whenever the union does — and a `412`
      // re-reads and merges again. In-process dedupe cannot cover this: two
      // scopes whose rows are byte-identical are two builds, and two server
      // instances share one bucket.
      const conditional: Record<string, string> =
        preexisting?.etag === undefined
          ? { 'if-none-match': '*' }
          : { 'if-match': preexisting.etag };
      const response = await this.#request(
        'PUT',
        this.#recordKeyFor(segmentId),
        {
          body: new TextEncoder().encode(recordJson),
          headers: { 'content-type': 'application/json', ...conditional },
          allow412: true,
        },
      );
      if (response !== undefined && response.status === 412) {
        await response.arrayBuffer();
        continue;
      }
      await response?.arrayBuffer();
      if (preexisting === undefined) {
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
    throw new Error(
      `S3SegmentStore: ${CAS_ATTEMPTS} conditional writes in a row lost the race for ${segmentId} — the stored digest set would have dropped a scope`,
    );
  }

  /**
   * Write the immutable bytes object. Create-only, so a second publisher of
   * identical bytes is a no-op and a second publisher of DIFFERENT bytes under
   * the same content address is the hash collision §5.1 requires to fail
   * loudly instead of overwriting.
   */
  async #putBytes(segmentId: string, bytes: Uint8Array): Promise<void> {
    const key = this.objectKeyFor(segmentId);
    const response = await this.#request('PUT', key, {
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'if-none-match': '*',
      },
      allow412: true,
    });
    if (response === undefined || response.status !== 412) {
      await response?.arrayBuffer();
      return;
    }
    await response.arrayBuffer();
    const current = await this.#request('GET', key);
    if (current === undefined) return;
    const stored = new Uint8Array(await current.arrayBuffer());
    if (!segmentBytesEqual(stored, bytes)) {
      throw new Error(
        `S3SegmentStore: content-address collision at ${segmentId} (§5.1)`,
      );
    }
  }

  /**
   * Read the record object plus the ETag of the body that was read, so the
   * union write can be made conditional on exactly that pre-state (§5.1).
   *
   * A record written before the record/bytes split rides in the bytes object's
   * user metadata; it is read here and its union is materialized into a record
   * object by the next `put`. That shape carries no usable ETag for the union
   * (the bytes ETag is a content hash), which is exactly why it was replaced.
   * A bytes object with neither a record object nor the legacy metadata is an
   * entry whose record is missing — a cache miss, not corruption, so `get`
   * reports it as absent and the client re-pulls.
   */
  async #readRecord(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; etag: string | undefined } | undefined> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) return undefined;
    const response = await this.#request('GET', this.#recordKeyFor(segmentId));
    if (response !== undefined) {
      return {
        record: parseRecordJson(await response.text(), 'segment record'),
        etag: response.headers.get('etag') ?? undefined,
      };
    }
    const legacy = await this.#request('GET', this.objectKeyFor(segmentId));
    if (legacy === undefined) return undefined;
    const meta = legacy.headers.get(RECORD_META_HEADER);
    await legacy.arrayBuffer();
    if (meta === null) return undefined;
    return {
      record: parseRecordJson(base64urlToUtf8(meta), segmentId),
      etag: undefined,
    };
  }

  async get(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; bytes: Uint8Array } | undefined> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) return undefined;
    const record = await this.#readRecord(segmentId);
    if (record === undefined) return undefined;
    const response = await this.#request('GET', this.objectKeyFor(segmentId));
    if (response === undefined) return undefined;
    return {
      record: record.record,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
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
      record.logEpoch !== key.logEpoch ||
      record.table !== key.table ||
      record.schemaVersion !== key.schemaVersion ||
      record.mediaType !== key.mediaType ||
      !record.scopeDigests.includes(key.scopeDigest) ||
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
