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
  readonly byteLength: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * The §5.3 reuse key: sqlite images are not byte-deterministic, so
 * cross-client dedup is a metadata lookup, not hash convergence — one
 * stored image per (partition, table, schemaVersion, scope digest, pin).
 */
export interface SegmentFindKey {
  readonly partition: string;
  readonly table: string;
  readonly schemaVersion: number;
  readonly mediaType: 'rows' | 'sqlite';
  readonly scopeDigest: string;
  readonly asOfCommitSeq: number;
}

/**
 * Coarse store-level counters for the admin/console read surface (TODO
 * §2.5). Optional — a store that omits `stats()` simply cannot report them.
 * All counts include expired-but-not-yet-evicted entries (the store's own
 * bytes on disk), split by media type.
 */
export interface SegmentStoreStats {
  readonly count: number;
  readonly bytes: number;
  readonly rowsSegments: number;
  readonly sqliteSegments: number;
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
   */
  find(key: SegmentFindKey, nowMs: number): Promise<SegmentRecord | undefined>;
  /** Admin/console counters (TODO §2.5) — ADDITIVE, optional. */
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
    const record: SegmentRecord = {
      ...metadata,
      segmentId,
      byteLength: bytes.length,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#ttlMs,
    };
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
        record.table === key.table &&
        record.schemaVersion === key.schemaVersion &&
        record.mediaType === key.mediaType &&
        record.scopeDigest === key.scopeDigest &&
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
