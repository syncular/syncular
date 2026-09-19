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

/**
 * One publication of a content address (§5.1): the full descriptor context
 * that authorized the bytes plus that publication's own cache lifetime.
 * Identical bytes have one content address, so one stored entry carries one
 * publication per distinct (partition, logEpoch, table, schemaVersion,
 * mediaType, scopeDigest, asOfCommitSeq, cursors) context it was published
 * under. Authorization selects a matching publication; it never unions
 * digests across a different partition or epoch.
 */
export interface SegmentPublication extends SegmentMetadata {
  readonly byteLength: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface SegmentRecord extends SegmentMetadata {
  readonly segmentId: string;
  /**
   * Every scope digest this content was published under (§3.5), primary
   * first. A compatibility view over `publications`; download and `find`
   * authorize on a matching publication, not on this union.
   */
  readonly scopeDigests: readonly string[];
  /** Every publication of this content address, oldest first (§5.1). */
  readonly publications: readonly SegmentPublication[];
  readonly byteLength: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** Canonical identity of one publication; two equal keys are one grant. */
export function publicationKey(metadata: SegmentMetadata): string {
  return JSON.stringify([
    metadata.partition,
    metadata.logEpoch,
    metadata.table,
    metadata.schemaVersion,
    metadata.mediaType,
    metadata.scopeDigest,
    metadata.asOfCommitSeq,
    metadata.rowCursor,
    metadata.nextRowCursor,
  ]);
}

/**
 * Materialize publications for a record written before provenance existed
 * (in-flight 0.21 objects, §5.1). Only the merged top-level context is
 * known, so each recorded digest is one publication under it: that is the
 * old single-record read behavior preserved verbatim.
 */
export function publicationsForRecord(
  record: SegmentMetadata & {
    readonly scopeDigests: readonly string[];
    readonly byteLength: number;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
  },
): SegmentPublication[] {
  return record.scopeDigests.map((scopeDigest) => ({
    partition: record.partition,
    logEpoch: record.logEpoch,
    table: record.table,
    schemaVersion: record.schemaVersion,
    mediaType: record.mediaType,
    scopeDigest,
    asOfCommitSeq: record.asOfCommitSeq,
    rowCount: record.rowCount,
    rowCursor: record.rowCursor,
    nextRowCursor: record.nextRowCursor,
    byteLength: record.byteLength,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  }));
}

/**
 * The newest publication matching a context, or undefined (§5.5). Optional
 * `nowMs` skips publications whose own TTL has elapsed, so an expired
 * `asOf`/schema publication never shadows a newer live one.
 */
export interface SegmentPublicationSelector {
  readonly partition: string;
  readonly logEpoch: string;
  readonly scopeDigest: string;
  readonly table?: string;
  readonly schemaVersion?: number;
  readonly mediaType?: 'rows' | 'sqlite';
  readonly asOfCommitSeq?: number;
  readonly rowCursor?: string | null;
  readonly nowMs?: number;
}

export function selectSegmentPublication(
  record: SegmentRecord,
  context: SegmentPublicationSelector,
): SegmentPublication | undefined {
  for (let index = record.publications.length - 1; index >= 0; index--) {
    const publication = record.publications[index]!;
    if (
      publication.partition === context.partition &&
      publication.logEpoch === context.logEpoch &&
      publication.scopeDigest === context.scopeDigest &&
      (context.table === undefined || publication.table === context.table) &&
      (context.schemaVersion === undefined ||
        publication.schemaVersion === context.schemaVersion) &&
      (context.mediaType === undefined ||
        publication.mediaType === context.mediaType) &&
      (context.asOfCommitSeq === undefined ||
        publication.asOfCommitSeq === context.asOfCommitSeq) &&
      (context.rowCursor === undefined ||
        publication.rowCursor === context.rowCursor) &&
      (context.nowMs === undefined || publication.expiresAtMs > context.nowMs)
    ) {
      return publication;
    }
  }
  return undefined;
}

/**
 * Project a record onto one publication. The compatibility view is narrowed
 * to that grant: `scopeDigests` and `publications` hold only the chosen
 * publication, so a caller that authorizes from them cannot union a grant
 * from a different partition or epoch.
 */
export function publicationRecord(
  record: SegmentRecord,
  publication: SegmentPublication,
): SegmentRecord {
  return {
    ...record,
    ...publication,
    scopeDigests: [publication.scopeDigest],
    publications: [publication],
  };
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
 * later expiry. A publication with the incoming context merges into that
 * publication's own lifetime; a publication with a new context is appended,
 * so no context's grant is overwritten or extended by another. Callers MUST
 * have proven the bytes identical first.
 */
export function mergeSegmentRecord(
  existing: SegmentRecord | undefined,
  metadata: SegmentMetadata,
  segmentId: string,
  byteLength: number,
  nowMs: number,
  ttlMs: number,
): SegmentRecord {
  const prior = existing?.publications ?? [];
  const fresh: SegmentPublication = {
    ...metadata,
    byteLength,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
  const key = publicationKey(metadata);
  const at = prior.findIndex(
    (publication) => publicationKey(publication) === key,
  );
  // Re-publication of one context merges that publication's lifetime only:
  // an unrelated refresh must not extend another publication's grant (§5.1).
  const publications =
    at < 0
      ? [...prior, fresh]
      : prior.map((publication, index) =>
          index === at
            ? {
                ...fresh,
                createdAtMs: Math.min(publication.createdAtMs, nowMs),
                expiresAtMs: Math.max(publication.expiresAtMs, nowMs + ttlMs),
              }
            : publication,
        );
  return {
    ...metadata,
    segmentId,
    scopeDigests: [
      metadata.scopeDigest,
      ...(existing?.scopeDigests ?? []).filter(
        (digest) => digest !== metadata.scopeDigest,
      ),
    ],
    publications,
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
      if (publication !== undefined) {
        return publicationRecord(record, publication);
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
