/**
 * Content-addressed segment store (SPEC.md §5.1).
 *
 * Segments are cache entries, not durable state: identical bytes share one
 * `segmentId` (`"sha256:" + hex`), entries expire on a TTL (default 24 h),
 * and `get` returns expired records so the download path can distinguish
 * `sync.segment_expired` from `sync.not_found` (§5.5).
 */
import { sha256Hex } from './scopes';

export const DEFAULT_SEGMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SegmentMetadata {
  readonly partition: string;
  /** Partition log continuity that produced these bytes (§2.1). */
  readonly logEpoch: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly mediaType: 'rows' | 'sqlite';
  readonly scopeDigest: string;
  readonly asOfCommitSeq: number;
  readonly rowCount: number;
  readonly rowCursor: string | null;
  readonly nextRowCursor: string | null;
}

export interface SegmentRecord extends SegmentMetadata {
  readonly segmentId: string;
  /**
   * Every scope digest this content was published under (§3.5). Identical
   * bytes have one content address, so two scopes whose rows happen to be
   * byte-identical publish the SAME `segmentId`; the store keeps one entry
   * per content address and records both digests instead of letting the
   * second publication overwrite the first. The record's `scopeDigest` is
   * always `scopeDigests[0]` (the publisher's own digest, so its descriptor
   * and signed URL stay consistent). A download is
   * authorized when the caller's freshly computed digest is one of these
   * (§5.5).
   */
  readonly scopeDigests: readonly string[];
  readonly byteLength: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** Byte equality for the content-address collision check (§5.1). */
export function segmentBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Merge one publication into the stored entry for the same content address
 * (§5.1). Identical bytes are one entry: the record takes the incoming
 * publication's metadata (a later publisher's descriptor, scope digest, and
 * cursors stay consistent with what it just published), the scope digests
 * union with the incoming digest first (the record's primary `scopeDigest`),
 * `createdAtMs` keeps the earliest sighting, and `expiresAtMs` takes the
 * later expiry. Callers MUST have proven the bytes identical first.
 */
export function mergeSegmentRecord(
  existing: SegmentRecord | undefined,
  metadata: SegmentMetadata,
  segmentId: string,
  byteLength: number,
  nowMs: number,
  ttlMs: number,
): SegmentRecord {
  return {
    ...metadata,
    segmentId,
    scopeDigests: [
      metadata.scopeDigest,
      ...(existing?.scopeDigests ?? []).filter(
        (digest) => digest !== metadata.scopeDigest,
      ),
    ],
    byteLength,
    createdAtMs: Math.min(existing?.createdAtMs ?? nowMs, nowMs),
    expiresAtMs: Math.max(
      existing?.expiresAtMs ?? nowMs + ttlMs,
      nowMs + ttlMs,
    ),
  };
}

/**
 * The §5.3 reuse key: sqlite images are not byte-deterministic, so
 * cross-client dedup is a metadata lookup, not hash convergence — one
 * stored image per (partition, table, schemaVersion, scope digest, pin).
 */
export interface SegmentFindKey {
  readonly partition: string;
  readonly logEpoch: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly mediaType: 'rows' | 'sqlite';
  readonly scopeDigest: string;
  readonly asOfCommitSeq: number;
}

/**
 * Coarse store-level counters for the admin/console read surface. Optional:
 * a store that omits `stats()` simply cannot report them.
 * All counts include expired-but-not-yet-evicted entries (the store's own
 * bytes on disk), split by media type.
 */
export interface SegmentStoreStats {
  readonly count: number;
  readonly bytes: number;
  readonly rowsSegments: number;
  readonly sqliteSegments: number;
  /**
   * ADDITIVE marker — present and `true` only on stores whose counters are
   * approximate (the S3/R2 store's LIST-free pointer accumulator, which can
   * drift under concurrent writers or after lifecycle GC). Absent on the
   * exact in-process stores (memory/sqlite). The admin surface carries it
   * through so the console can label the numbers honestly.
   */
  readonly approximate?: boolean;
}

export interface SegmentStore {
  put(
    metadata: SegmentMetadata,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<SegmentRecord>;
  /** Returns expired records too — expiry is the caller's check (§5.5). */
  get(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; bytes: Uint8Array } | undefined>;
  /**
   * Unexpired record for the §5.3 reuse key (whole-table segments only:
   * `rowCursor` null), or undefined. Servers MUST reuse instead of
   * rebuilding sqlite images while one exists (§5.3).
   *
   * The digest matches when it is one of the record's `scopeDigests`
   * (§5.1). That cannot hand a sqlite image to the wrong digest: a sqlite
   * image embeds its `scopeDigest` in its bytes, and a merge requires byte
   * equality, so two images published under different digests are never
   * byte-identical and never share one entry. Only rows segments merge
   * across digests, and their bytes carry no digest for a reader to compare
   * against the descriptor.
   */
  find(key: SegmentFindKey, nowMs: number): Promise<SegmentRecord | undefined>;
  /** Admin/console counters: ADDITIVE, optional. */
  stats?(): Promise<SegmentStoreStats>;
}

export async function segmentIdFor(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

export class MemorySegmentStore implements SegmentStore {
  #ttlMs: number;
  #entries = new Map<string, { record: SegmentRecord; bytes: Uint8Array }>();

  constructor(options?: { ttlMs?: number }) {
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SEGMENT_TTL_MS;
  }

  async put(
    metadata: SegmentMetadata,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<SegmentRecord> {
    const segmentId = await segmentIdFor(bytes);
    const existing = this.#entries.get(segmentId);
    if (existing !== undefined && !segmentBytesEqual(existing.bytes, bytes)) {
      throw new Error(
        `MemorySegmentStore: content-address collision at ${segmentId} (§5.1)`,
      );
    }
    const record = mergeSegmentRecord(
      existing?.record,
      metadata,
      segmentId,
      bytes.length,
      nowMs,
      this.#ttlMs,
    );
    this.#entries.set(segmentId, { record, bytes });
    return record;
  }

  async get(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; bytes: Uint8Array } | undefined> {
    return this.#entries.get(segmentId);
  }

  async find(
    key: SegmentFindKey,
    nowMs: number,
  ): Promise<SegmentRecord | undefined> {
    for (const { record } of this.#entries.values()) {
      if (
        record.partition === key.partition &&
        record.logEpoch === key.logEpoch &&
        record.table === key.table &&
        record.schemaVersion === key.schemaVersion &&
        record.mediaType === key.mediaType &&
        record.scopeDigests.includes(key.scopeDigest) &&
        record.asOfCommitSeq === key.asOfCommitSeq &&
        record.rowCursor === null &&
        record.expiresAtMs > nowMs
      ) {
        return record;
      }
    }
    return undefined;
  }

  async stats(): Promise<SegmentStoreStats> {
    let bytes = 0;
    let rowsSegments = 0;
    let sqliteSegments = 0;
    for (const { record } of this.#entries.values()) {
      bytes += record.byteLength;
      if (record.mediaType === 'sqlite') sqliteSegments += 1;
      else rowsSegments += 1;
    }
    return { count: this.#entries.size, bytes, rowsSegments, sqliteSegments };
  }
}
