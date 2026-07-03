/**
 * Content-addressed segment store (SPEC.md §5.1).
 *
 * Segments are cache entries, not durable state: identical bytes share one
 * `segmentId` (`"sha256:" + hex`), entries expire on a TTL (default 24 h),
 * and `get` returns expired records so the download path can distinguish
 * `sync.segment_expired` from `sync.not_found` (§5.5).
 */
import { Database } from 'bun:sqlite';
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

export class SqliteSegmentStore implements SegmentStore {
  readonly db: Database;
  #ttlMs: number;

  constructor(
    db: Database | string = ':memory:',
    options?: { ttlMs?: number },
  ) {
    this.db = typeof db === 'string' ? new Database(db) : db;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SEGMENT_TTL_MS;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_segments(
        segment_id TEXT PRIMARY KEY, partition TEXT NOT NULL,
        tbl TEXT NOT NULL, schema_version INTEGER NOT NULL,
        media_type TEXT NOT NULL, scope_digest TEXT NOT NULL,
        as_of_commit_seq INTEGER NOT NULL, row_count INTEGER NOT NULL,
        row_cursor TEXT, next_row_cursor TEXT,
        byte_length INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL, bytes BLOB NOT NULL
      );
    `);
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
    this.db
      .query(
        `INSERT OR REPLACE INTO sync_segments(
          segment_id, partition, tbl, schema_version, media_type,
          scope_digest, as_of_commit_seq, row_count, row_cursor,
          next_row_cursor, byte_length, created_at_ms, expires_at_ms, bytes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.segmentId,
        record.partition,
        record.table,
        record.schemaVersion,
        record.mediaType,
        record.scopeDigest,
        record.asOfCommitSeq,
        record.rowCount,
        record.rowCursor,
        record.nextRowCursor,
        record.byteLength,
        record.createdAtMs,
        record.expiresAtMs,
        bytes,
      );
    return record;
  }

  async get(
    segmentId: string,
  ): Promise<{ record: SegmentRecord; bytes: Uint8Array } | undefined> {
    const row = this.db
      .query<
        {
          segment_id: string;
          partition: string;
          tbl: string;
          schema_version: number;
          media_type: string;
          scope_digest: string;
          as_of_commit_seq: number;
          row_count: number;
          row_cursor: string | null;
          next_row_cursor: string | null;
          byte_length: number;
          created_at_ms: number;
          expires_at_ms: number;
          bytes: Uint8Array;
        },
        [string]
      >('SELECT * FROM sync_segments WHERE segment_id=?')
      .get(segmentId);
    if (row === null) return undefined;
    return {
      record: {
        segmentId: row.segment_id,
        partition: row.partition,
        table: row.tbl,
        schemaVersion: row.schema_version,
        mediaType: row.media_type === 'sqlite' ? 'sqlite' : 'rows',
        scopeDigest: row.scope_digest,
        asOfCommitSeq: row.as_of_commit_seq,
        rowCount: row.row_count,
        rowCursor: row.row_cursor,
        nextRowCursor: row.next_row_cursor,
        byteLength: row.byte_length,
        createdAtMs: row.created_at_ms,
        expiresAtMs: row.expires_at_ms,
      },
      bytes: new Uint8Array(row.bytes),
    };
  }

  async find(
    key: SegmentFindKey,
    nowMs: number,
  ): Promise<SegmentRecord | undefined> {
    const row = this.db
      .query<
        {
          segment_id: string;
          row_count: number;
          next_row_cursor: string | null;
          byte_length: number;
          created_at_ms: number;
          expires_at_ms: number;
        },
        [string, string, number, string, string, number, number]
      >(
        `SELECT segment_id, row_count, next_row_cursor, byte_length,
                created_at_ms, expires_at_ms
         FROM sync_segments
         WHERE partition=? AND tbl=? AND schema_version=? AND media_type=?
           AND scope_digest=? AND as_of_commit_seq=? AND row_cursor IS NULL
           AND expires_at_ms > ?
         LIMIT 1`,
      )
      .get(
        key.partition,
        key.table,
        key.schemaVersion,
        key.mediaType,
        key.scopeDigest,
        key.asOfCommitSeq,
        nowMs,
      );
    if (row === null) return undefined;
    return {
      segmentId: row.segment_id,
      partition: key.partition,
      table: key.table,
      schemaVersion: key.schemaVersion,
      mediaType: key.mediaType,
      scopeDigest: key.scopeDigest,
      asOfCommitSeq: key.asOfCommitSeq,
      rowCount: row.row_count,
      rowCursor: null,
      nextRowCursor: row.next_row_cursor,
      byteLength: row.byte_length,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
    };
  }

  async stats(): Promise<SegmentStoreStats> {
    const row = this.db
      .query<
        {
          count: number;
          bytes: number | null;
          rows_segments: number;
          sqlite_segments: number;
        },
        []
      >(
        `SELECT count(*) AS count, sum(byte_length) AS bytes,
                sum(CASE WHEN media_type='sqlite' THEN 0 ELSE 1 END) AS rows_segments,
                sum(CASE WHEN media_type='sqlite' THEN 1 ELSE 0 END) AS sqlite_segments
         FROM sync_segments`,
      )
      .get();
    return {
      count: row?.count ?? 0,
      bytes: row?.bytes ?? 0,
      rowsSegments: row?.rows_segments ?? 0,
      sqliteSegments: row?.sqlite_segments ?? 0,
    };
  }
}
