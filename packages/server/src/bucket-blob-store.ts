/**
 * Content-addressed blob store over the `ObjectBucket` seam (§5.9.2 durable
 * objects) — the store logic shared by `S3BlobStore` (S3 REST + SigV4) and
 * `R2BlobStore` (`@syncular/server-workers`, the R2 binding). The blob twin of
 * `bucket-segment-store.ts`: same content-addressed key layout, same
 * LIST-free-on-the-hot-path CAS stats accumulator.
 *
 * Key layout (deterministic — every point lookup is a GET/HEAD, never a LIST):
 *
 *   {keyPrefix}blob/{partition}/sha256/{hex}
 *     The blob bytes, VERBATIM (the object body MUST be exactly the
 *     content-addressed bytes so a presigned GET or the inline download route
 *     serves them directly and the client's §5.9.1 hash check passes — blobs
 *     are never re-compressed at rest, §5.8/§5.9.5). The `byteLength` +
 *     optional `mediaType` ride along as user metadata `syncular-blob` =
 *     base64url(JSON), so `get` is a single GET. `createdAtMs` is stored there
 *     too so the orphan sweep (§5.9.2) can read the upload age without a
 *     separate index.
 *
 * DURABILITY vs SEGMENT TTL — the honest interface difference (§5.9.2): a
 * blob referenced by a live row must stay downloadable INDEFINITELY. So,
 * unlike the segment store, this store writes **no `expiresAtMs`, no bucket
 * lifecycle-expiration mapping, and no TTL config**. Expiry is
 * REFERENCE-driven, not time-driven: reclamation is the host-scheduled
 * `sweepOrphanBlobs` (blob-store.ts) deleting only objects no live row
 * references after a grace period — never a bucket lifecycle rule. Do NOT
 * put a lifecycle expiration on the `blob/` prefix; it would delete
 * still-referenced attachments.
 *
 * The orphan sweep is the ONLY operation that LISTs: `sweepOrphans` pages a
 * prefix listing over the `blob/` prefix (an admin/GC path, off the hot path)
 * to find candidates, reads each object's `createdAtMs` from its metadata for
 * the grace check, and DELETEs the unreferenced-and-old ones.
 */
import type { BlobRecord, BlobStore, BlobStoreStats } from './blob-store';
import type { ObjectBucket } from './object-bucket';

export interface BucketBlobStoreOptions {
  /** Key namespace inside the bucket, e.g. `syncular/`. Default: none. */
  readonly keyPrefix?: string | undefined;
}

const BLOB_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BLOB_META_KEY = 'syncular-blob';

/**
 * Stats accumulator (mirrors the segment store): a small counter object under
 * a fixed key, updated read-modify-write on `put` under an ETag
 * compare-and-swap. A LIST-free point-lookup store cannot count objects on
 * demand cheaply, so `stats()` reads the accumulator. The counters are
 * APPROXIMATE — a crash between the blob PUT and the accumulator CAS, or a
 * sweep DELETE the accumulator does not decrement, drifts them — so the
 * admin surface labels these stats `approximate: true`. A health gauge,
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

// Runtime-neutral base64url: `Buffer` is not present on
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

function parseMetaJson(json: string, source: string, label: string): BlobMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${label}: corrupt blob metadata in ${source}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label}: corrupt blob metadata in ${source}`);
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.byteLength !== 'number' || typeof r.createdAtMs !== 'number') {
    throw new Error(`${label}: bad blob metadata in ${source}`);
  }
  return {
    byteLength: r.byteLength,
    ...(typeof r.mediaType === 'string' ? { mediaType: r.mediaType } : {}),
    createdAtMs: r.createdAtMs,
  };
}

export class BucketBlobStore implements BlobStore {
  readonly #bucket: ObjectBucket;
  readonly #prefix: string;
  /** Error prefix: the concrete store class the host constructed. */
  readonly #label: string;

  constructor(bucket: ObjectBucket, options?: BucketBlobStoreOptions) {
    this.#bucket = bucket;
    this.#prefix = options?.keyPrefix ?? '';
    this.#label = this.constructor.name;
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

  async #readStats(): Promise<{
    stats: StatsAccumulator;
    etag: string | undefined;
  }> {
    const object = await this.#bucket.get(this.#statsKey());
    if (object === undefined) {
      return { stats: emptyStats(), etag: undefined };
    }
    return { stats: parseStatsJson(await object.text()), etag: object.etag };
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
    const preexisting = await this.#bucket.head(objectKey);
    if (preexisting !== undefined) {
      const meta = preexisting.metadata[BLOB_META_KEY];
      if (meta !== undefined) {
        const existing = parseMetaJson(
          base64urlToUtf8(meta),
          blobId,
          this.#label,
        );
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
    // Conditional write: of two concurrent uploads of the same blob exactly
    // one lands, so the first createdAtMs survives and the blob counts once.
    // The loser re-reads and returns the winner's record.
    const written = await this.#bucket.put(objectKey, {
      body: bytes,
      contentType: mediaType ?? 'application/octet-stream',
      metadata: { [BLOB_META_KEY]: utf8ToBase64url(metaToJson(meta)) },
      ...(preexisting === undefined
        ? { createOnly: true }
        : { ifMatch: preexisting.etag }),
    });
    if (!written) return this.put(partition, blobId, bytes, nowMs, mediaType);
    if (preexisting === undefined)
      await this.#bumpStats({ count: 1, bytes: bytes.length });
    return record;
  }

  async has(partition: string, blobId: string): Promise<boolean> {
    if (!BLOB_ID_PATTERN.test(blobId)) return false;
    const head = await this.#bucket.head(this.objectKeyFor(partition, blobId));
    return head !== undefined;
  }

  async get(
    partition: string,
    blobId: string,
  ): Promise<{ record: BlobRecord; bytes: Uint8Array } | undefined> {
    if (!BLOB_ID_PATTERN.test(blobId)) return undefined;
    const object = await this.#bucket.get(this.objectKeyFor(partition, blobId));
    if (object === undefined) return undefined;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const rawMeta = object.metadata[BLOB_META_KEY];
    const meta =
      rawMeta !== undefined
        ? parseMetaJson(base64urlToUtf8(rawMeta), blobId, this.#label)
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
   * §5.9.2 orphan sweep — the ONLY LISTing operation. Page the `{prefix}blob/
   * {partition}/` prefix, HEAD each object for its `createdAtMs`, and DELETE
   * the ones both older than `olderThanMs` AND absent from
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
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list(listPrefix, cursor);
      cursor = page.cursor;
      for (const key of page.keys) {
        // `{listPrefix}sha256/{hex}` → `sha256:{hex}`.
        const rest = key.slice(listPrefix.length);
        if (!rest.startsWith('sha256/')) continue;
        const blobId = `sha256:${rest.slice('sha256/'.length)}`;
        if (!BLOB_ID_PATTERN.test(blobId)) continue;
        if (referencedBlobIds.has(blobId)) continue;
        const head = await this.#bucket.head(key);
        if (head === undefined) continue;
        const rawMeta = head.metadata[BLOB_META_KEY];
        const meta =
          rawMeta !== undefined
            ? parseMetaJson(base64urlToUtf8(rawMeta), blobId, this.#label)
            : { byteLength: head.size ?? 0, createdAtMs: 0 };
        if (meta.createdAtMs >= olderThanMs) continue;
        await this.#bucket.delete(key);
        swept.push(blobId);
        deletedBytes += meta.byteLength;
      }
    } while (cursor !== undefined);
    if (swept.length > 0) {
      await this.#bumpStats({ count: -swept.length, bytes: -deletedBytes });
    }
    return swept;
  }

  /**
   * Store-wide counters from the pointer-object accumulator (never a LIST on
   * the read path). `approximate: true` for the same reasons the segment
   * store documents: best-effort ETag-CAS maintenance and sweep deletes that
   * may miss the decrement. Exact within a single writer; a health gauge
   * under concurrency. Note this is store-WIDE, not partition-scoped, so a
   * shared bucket reports the whole bucket — the parameter is accepted for
   * interface parity but the accumulator is one object per store.
   */
  async stats(_partition: string): Promise<BlobStoreStats> {
    const { stats } = await this.#readStats();
    return { count: stats.count, bytes: stats.bytes, approximate: true };
  }
}
