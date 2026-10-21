/**
 * Content-addressed segment store over the `ObjectBucket` seam (§5.1 cache
 * semantics) — the store logic shared by `S3SegmentStore` (S3 REST + SigV4)
 * and `R2SegmentStore` (`@syncular/server-workers`, the R2 binding).
 *
 * Key layout (deterministic — every lookup is a GET/HEAD, never a LIST):
 *
 *   {keyPrefix}seg/sha256/{hex}
 *     The segment bytes, verbatim and immutable (the object body MUST be
 *     exactly the content-addressed bytes so a presigned GET or the inline
 *     download route serves them directly and the client's §5.1 hash check
 *     passes).
 *
 *   {keyPrefix}rec/sha256/{hex}.json
 *     The `SegmentRecord` (§5.1). It is the one MUTABLE object of the two:
 *     the scope-digest set is a union that every publication extends, so
 *     the merge is a read-modify-write. Keeping the record in the body (not
 *     in the bytes object's user metadata) is what makes that write
 *     conditional — a body ETag changes when the union changes, while the
 *     bytes ETag is a content hash and is identical for identical bytes. A
 *     failed precondition re-reads and merges again, so no concurrent
 *     publication can drop another one's digest. `get` therefore reads two
 *     objects.
 *
 *   {keyPrefix}find/{sha256Hex(canonical reuse key)}.json
 *     Whole-table reuse pointer (§5.3): written only when
 *     `rowCursor === null`, body = the record JSON. The reuse key is the
 *     canonical JSON array `[partition, logEpoch, table, schemaVersion,
 *     mediaType, scopeDigest, asOfCommitSeq]`, so `find` is one GET (plus a
 *     HEAD to confirm the segment object itself still exists — lifecycle GC
 *     may remove objects independently of pointers).
 *
 * Records written before the split kept the record in the bytes object's
 * user metadata `syncular-record`; `get` still reads that shape and the next
 * `put` materializes the record object from it, so an upgrade loses no cache
 * entry.
 *
 * TTL mapping: expiry is **store-side and authoritative** — `expiresAtMs`
 * (put-time + `ttlMs`, default 24 h) is recorded in the record and the
 * pointer; `get` returns expired records so §5.5 can answer
 * `sync.segment_expired`, and `find` filters them out itself. Bucket
 * lifecycle expiration is garbage collection only: configure it comfortably
 * ABOVE `ttlMs` (e.g. 2 days for the 24 h default) so clients normally see
 * the precise, retryable `sync.segment_expired` and hit `sync.not_found` only
 * long after. Never set lifecycle below `ttlMs`.
 */
import type { ObjectBucket } from './object-bucket';
import type {
  SegmentFindKey,
  SegmentMetadata,
  SegmentPublication,
  SegmentRecord,
  SegmentStore,
  SegmentStoreStats,
  SegmentStream,
} from './segment-store';
import {
  mergeSegmentRecord,
  publicationRecord,
  publicationsForRecord,
  segmentBytesEqual,
  segmentIdFor,
  selectSegmentPublication,
} from './segment-store';
import { sha256Hex } from './sigv4';

export interface BucketSegmentStoreOptions {
  /** Key namespace inside the bucket, e.g. `syncular/`. Default: none. */
  readonly keyPrefix?: string | undefined;
  /** Segment TTL (§5.1 cache semantics). Default 24 h. */
  readonly ttlMs?: number | undefined;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const SEGMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** Legacy record carried in the bytes object's user metadata. */
const LEGACY_RECORD_META_KEY = 'syncular-record';

/**
 * Stats accumulator (§ "S3 stats" in the README). The store keeps a small
 * counter object under a fixed key, updated read-modify-write on `put`. It
 * exists because a LIST-free store (every lookup is a GET/HEAD) has no cheap
 * way to count objects on demand — so `stats()` reads the accumulator instead
 * of enumerating the bucket.
 *
 * The write is guarded by an ETag compare-and-swap (`ifMatch`, or `createOnly`
 * to create): the loop re-reads and retries on a failed precondition, so
 * concurrent writers do not silently clobber each other's increment. The
 * counters are still APPROXIMATE — a crash between the segment PUT and the
 * accumulator CAS, or a writer against a backend that ignores conditional
 * writes, can drift them — so the admin surface labels these stats
 * `approximate: true`. They are a health gauge, not an invoice.
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

/** One publication inside a stored record (or a legacy materialized one). */
function parsePublication(
  value: unknown,
  source: string,
  label: string,
): SegmentPublication {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label}: corrupt publication in ${source}`);
  }
  const p = value as Record<string, unknown>;
  const strings = ['partition', 'logEpoch', 'table', 'scopeDigest'] as const;
  const numbers = [
    'schemaVersion',
    'asOfCommitSeq',
    'rowCount',
    'byteLength',
    'createdAtMs',
    'expiresAtMs',
  ] as const;
  for (const field of strings) {
    if (typeof p[field] !== 'string') {
      throw new Error(`${label}: bad publication field ${field} in ${source}`);
    }
  }
  for (const field of numbers) {
    if (typeof p[field] !== 'number') {
      throw new Error(`${label}: bad publication field ${field} in ${source}`);
    }
  }
  if (!isMediaType(p.mediaType)) {
    throw new Error(`${label}: bad publication mediaType in ${source}`);
  }
  const cursorOk = (v: unknown): v is string | null =>
    v === null || typeof v === 'string';
  if (!cursorOk(p.rowCursor) || !cursorOk(p.nextRowCursor)) {
    throw new Error(`${label}: bad publication cursor in ${source}`);
  }
  return {
    partition: p.partition as string,
    logEpoch: p.logEpoch as string,
    table: p.table as string,
    schemaVersion: p.schemaVersion as number,
    mediaType: p.mediaType,
    scopeDigest: p.scopeDigest as string,
    asOfCommitSeq: p.asOfCommitSeq as number,
    rowCount: p.rowCount as number,
    rowCursor: p.rowCursor,
    nextRowCursor: p.nextRowCursor,
    byteLength: p.byteLength as number,
    createdAtMs: p.createdAtMs as number,
    expiresAtMs: p.expiresAtMs as number,
  };
}

function parseRecordJson(
  json: string,
  source: string,
  label: string,
): SegmentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${label}: corrupt record JSON in ${source}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label}: corrupt record in ${source}`);
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
      throw new Error(`${label}: bad record field ${field} in ${source}`);
    }
  }
  for (const field of numbers) {
    if (typeof r[field] !== 'number') {
      throw new Error(`${label}: bad record field ${field} in ${source}`);
    }
  }
  if (!isMediaType(r.mediaType)) {
    throw new Error(`${label}: bad record mediaType in ${source}`);
  }
  const cursorOk = (v: unknown): v is string | null =>
    v === null || typeof v === 'string';
  if (!cursorOk(r.rowCursor) || !cursorOk(r.nextRowCursor)) {
    throw new Error(`${label}: bad record cursor in ${source}`);
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
    throw new Error(`${label}: bad record scopeDigests in ${source}`);
  }
  const rawPublications = r.publications;
  if (rawPublications !== undefined && !Array.isArray(rawPublications)) {
    throw new Error(`${label}: bad record publications in ${source}`);
  }
  const top = {
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
  return {
    ...top,
    // A record from before per-publication provenance, or a legacy record
    // whose union came from object metadata, materializes its publications
    // from the merged top-level context — the old single-record read.
    publications:
      rawPublications === undefined
        ? publicationsForRecord(top)
        : rawPublications.map((value) =>
            parsePublication(value, source, label),
          ),
  };
}

export class BucketSegmentStore implements SegmentStore {
  readonly #bucket: ObjectBucket;
  readonly #ttlMs: number;
  readonly #prefix: string;
  /** Error prefix: the concrete store class the host constructed. */
  readonly #label: string;

  constructor(bucket: ObjectBucket, options?: BucketSegmentStoreOptions) {
    this.#bucket = bucket;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.#prefix = options?.keyPrefix ?? '';
    this.#label = this.constructor.name;
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

  /** Read the stats accumulator + its ETag (for the CAS write), or none. */
  async #readStats(): Promise<{
    stats: StatsAccumulator;
    etag: string | undefined;
  }> {
    const object = await this.#bucket.get(this.#statsKey());
    if (object === undefined) {
      return { stats: emptyStats(), etag: undefined };
    }
    return {
      stats: parseStatsJson(await object.text()),
      etag: object.etag,
    };
  }

  /**
   * Conditionally write the stats accumulator. `etag` present ⇒ `ifMatch`
   * (update the object we read); absent ⇒ `createOnly` (create only). Returns
   * `false` on a failed precondition so the caller retries.
   */
  async #writeStatsCas(
    stats: StatsAccumulator,
    etag: string | undefined,
  ): Promise<boolean> {
    return this.#bucket.put(this.#statsKey(), {
      body: new TextEncoder().encode(JSON.stringify(stats)),
      contentType: 'application/json',
      ...(etag === undefined ? { createOnly: true } : { ifMatch: etag }),
    });
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
      // body hash, so it changes whenever the union does — and a failed
      // precondition re-reads and merges again. In-process dedupe cannot cover
      // this: two scopes whose rows are byte-identical are two builds, and two
      // server instances share one bucket.
      const written = await this.#bucket.put(this.#recordKeyFor(segmentId), {
        body: new TextEncoder().encode(recordJson),
        contentType: 'application/json',
        ...(preexisting?.etag === undefined
          ? { createOnly: true }
          : { ifMatch: preexisting.etag }),
      });
      if (!written) continue;
      if (preexisting === undefined) {
        await this.#bumpStats({
          count: 1,
          bytes: bytes.length,
          rowsSegments: metadata.mediaType === 'rows' ? 1 : 0,
          sqliteSegments: metadata.mediaType === 'sqlite' ? 1 : 0,
        });
      }
      if (metadata.rowCursor === null) {
        await this.#bucket.put(await this.#findKeyFor(metadata), {
          body: new TextEncoder().encode(recordJson),
          contentType: 'application/json',
        });
      }
      return record;
    }
    throw new Error(
      `${this.#label}: ${CAS_ATTEMPTS} conditional writes in a row lost the race for ${segmentId} — the stored digest set would have dropped a scope`,
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
    const written = await this.#bucket.put(key, {
      body: bytes,
      contentType: 'application/octet-stream',
      createOnly: true,
    });
    if (written) return;
    const current = await this.#bucket.get(key);
    if (current === undefined) return;
    const stored = new Uint8Array(await current.arrayBuffer());
    if (!segmentBytesEqual(stored, bytes)) {
      throw new Error(
        `${this.#label}: content-address collision at ${segmentId} (§5.1)`,
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
    const object = await this.#bucket.get(this.#recordKeyFor(segmentId));
    if (object !== undefined) {
      return {
        record: parseRecordJson(
          await object.text(),
          'segment record',
          this.#label,
        ),
        etag: object.etag,
      };
    }
    const legacy = await this.#bucket.get(this.objectKeyFor(segmentId));
    if (legacy === undefined) return undefined;
    const meta = legacy.metadata[LEGACY_RECORD_META_KEY];
    await legacy.arrayBuffer();
    if (meta === undefined) return undefined;
    return {
      record: parseRecordJson(base64urlToUtf8(meta), segmentId, this.#label),
      etag: undefined,
    };
  }

  async get(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; bytes: Uint8Array } | undefined> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) return undefined;
    const record = await this.#readRecord(segmentId);
    if (record === undefined) return undefined;
    const object = await this.#bucket.get(this.objectKeyFor(segmentId));
    if (object === undefined) return undefined;
    return {
      record: record.record,
      bytes: new Uint8Array(await object.arrayBuffer()),
    };
  }

  /** The record plus the object GET's body, never buffered (see `get`). */
  async open(segmentId: string): Promise<SegmentStream | undefined> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) return undefined;
    const record = await this.#readRecord(segmentId);
    if (record === undefined) return undefined;
    const object = await this.#bucket.get(this.objectKeyFor(segmentId));
    if (object === undefined || object.body === null) return undefined;
    return {
      record: record.record,
      body: object.body,
      byteLength: record.record.byteLength,
    };
  }

  async find(
    key: SegmentFindKey,
    nowMs: number,
  ): Promise<SegmentRecord | undefined> {
    const pointer = await this.#bucket.get(await this.#findKeyFor(key));
    if (pointer === undefined) return undefined;
    const record = parseRecordJson(
      await pointer.text(),
      'reuse pointer',
      this.#label,
    );
    // The pointer is keyed by the full context, but the record body is the
    // whole merged entry: select the publication the key names, never the
    // top-level fields or the digest union (§5.1).
    const publication = selectSegmentPublication(record, {
      partition: key.partition,
      logEpoch: key.logEpoch,
      table: key.table,
      schemaVersion: key.schemaVersion,
      mediaType: key.mediaType,
      scopeDigest: key.scopeDigest,
      asOfCommitSeq: key.asOfCommitSeq,
      rowCursor: null,
      nowMs,
    });
    if (publication === undefined) return undefined;
    // Lifecycle GC may have removed the object while the pointer survived.
    const head = await this.#bucket.head(this.objectKeyFor(record.segmentId));
    if (head === undefined) return undefined;
    return publicationRecord(record, publication);
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
}
