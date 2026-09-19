/**
 * SQLite-backed segment store over the shared synchronous driver.
 */
import {
  DEFAULT_SEGMENT_TTL_MS,
  mergeSegmentRecord,
  publicationKey,
  publicationRecord,
  publicationsForRecord,
  type SegmentFindKey,
  type SegmentMetadata,
  type SegmentPublication,
  type SegmentRecord,
  segmentBytesEqual,
  type SegmentStore,
  type SegmentStoreStats,
  segmentIdFor,
  selectSegmentPublication,
} from './segment-store';
import {
  SqliteAdapterRequiredError,
  type SqliteDatabase,
} from './sqlite-driver';

export class SqliteSegmentStore implements SegmentStore {
  readonly db: SqliteDatabase;
  #ttlMs: number;

  constructor(
    db: SqliteDatabase | string = ':memory:',
    options?: { ttlMs?: number },
  ) {
    if (typeof db === 'string') {
      throw new SqliteAdapterRequiredError();
    }
    this.db = db;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SEGMENT_TTL_MS;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_segments(
        segment_id TEXT PRIMARY KEY, partition TEXT NOT NULL,
        log_epoch TEXT NOT NULL,
        tbl TEXT NOT NULL, schema_version INTEGER NOT NULL,
        media_type TEXT NOT NULL, scope_digest TEXT NOT NULL,
        as_of_commit_seq INTEGER NOT NULL, row_count INTEGER NOT NULL,
        row_cursor TEXT, next_row_cursor TEXT,
        byte_length INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL, bytes BLOB NOT NULL
      );
    `);
    // One row per scope digest a content address was published under (§5.1):
    // identical bytes from two scopes share a `segment_id` and must both stay
    // downloadable (§5.5).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_segment_scopes(
        segment_id TEXT NOT NULL, scope_digest TEXT NOT NULL,
        PRIMARY KEY (segment_id, scope_digest)
      );
    `);
    // One row per publication of a content address (§5.1): the same bytes
    // under a different partition, epoch, table, or pin are distinct grants
    // and must each stay downloadable. Rows written before this table existed
    // materialize from the top-level record plus `sync_segment_scopes` on
    // read, so an in-flight 0.21 object loses no publication.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_segment_publications(
        segment_id TEXT NOT NULL, pub_key TEXT NOT NULL,
        partition TEXT NOT NULL, log_epoch TEXT NOT NULL,
        tbl TEXT NOT NULL, schema_version INTEGER NOT NULL,
        media_type TEXT NOT NULL, scope_digest TEXT NOT NULL,
        as_of_commit_seq INTEGER NOT NULL, row_count INTEGER NOT NULL,
        row_cursor TEXT, next_row_cursor TEXT,
        byte_length INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (segment_id, pub_key)
      );
    `);
    const columns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(sync_segments)')
      .all();
    if (!columns.some((column) => column.name === 'log_epoch')) {
      this.db.exec(
        "ALTER TABLE sync_segments ADD COLUMN log_epoch TEXT NOT NULL DEFAULT ''",
      );
    }
    // Backfill digests recorded before the side table existed, so an
    // upgraded store keeps `find`/download working for cached segments.
    this.db.exec(
      `INSERT OR IGNORE INTO sync_segment_scopes(segment_id, scope_digest)
       SELECT segment_id, scope_digest FROM sync_segments`,
    );
  }

  /** Every digest recorded for a content address, primary first. */
  #scopeDigestsFor(segmentId: string, primary: string): string[] {
    const rows = this.db
      .query<{ scope_digest: string }, [string]>(
        'SELECT scope_digest FROM sync_segment_scopes WHERE segment_id=?',
      )
      .all(segmentId);
    const digests = rows.map((row) => row.scope_digest);
    return [primary, ...digests.filter((digest) => digest !== primary)];
  }

  /** Stored publications for a content address, oldest first. */
  #publicationsFor(segmentId: string): SegmentPublication[] {
    const rows = this.db
      .query<
        {
          partition: string;
          log_epoch: string;
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
        },
        [string]
      >(
        'SELECT * FROM sync_segment_publications WHERE segment_id=? ORDER BY rowid',
      )
      .all(segmentId);
    return rows.map((row) => ({
      partition: row.partition,
      logEpoch: row.log_epoch,
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
    }));
  }

  async put(
    metadata: SegmentMetadata,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<SegmentRecord> {
    const segmentId = await segmentIdFor(bytes);
    const existing = await this.get(segmentId);
    if (existing !== undefined && !segmentBytesEqual(existing.bytes, bytes)) {
      throw new Error(
        `SqliteSegmentStore: content-address collision at ${segmentId} (§5.1)`,
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
    // The bytes are proven identical to the stored ones, so replacing the
    // row with the merged record (metadata, digest set, merged times) is the
    // merge: the other digests live in `sync_segment_scopes` below. The
    // publication set is rewritten from the merged record in one transaction
    // so a crash cannot leave provenance half-applied.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO sync_segments(
            segment_id, partition, log_epoch, tbl, schema_version, media_type,
            scope_digest, as_of_commit_seq, row_count, row_cursor,
            next_row_cursor, byte_length, created_at_ms, expires_at_ms, bytes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.segmentId,
          record.partition,
          record.logEpoch,
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
      this.db
        .query(
          `INSERT OR IGNORE INTO sync_segment_scopes(segment_id, scope_digest)
           VALUES (?,?)`,
        )
        .run(record.segmentId, metadata.scopeDigest);
      this.db
        .query('DELETE FROM sync_segment_publications WHERE segment_id=?')
        .run(record.segmentId);
      const insertPublication = this.db.query(
        `INSERT INTO sync_segment_publications(
           segment_id, pub_key, partition, log_epoch, tbl, schema_version,
           media_type, scope_digest, as_of_commit_seq, row_count, row_cursor,
           next_row_cursor, byte_length, created_at_ms, expires_at_ms
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const publication of record.publications) {
        insertPublication.run(
          record.segmentId,
          publicationKey(publication),
          publication.partition,
          publication.logEpoch,
          publication.table,
          publication.schemaVersion,
          publication.mediaType,
          publication.scopeDigest,
          publication.asOfCommitSeq,
          publication.rowCount,
          publication.rowCursor,
          publication.nextRowCursor,
          publication.byteLength,
          publication.createdAtMs,
          publication.expiresAtMs,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
          log_epoch: string;
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
    const scopeDigests = this.#scopeDigestsFor(
      row.segment_id,
      row.scope_digest,
    );
    const top = {
      segmentId: row.segment_id,
      partition: row.partition,
      logEpoch: row.log_epoch,
      table: row.tbl,
      schemaVersion: row.schema_version,
      mediaType:
        row.media_type === 'sqlite' ? ('sqlite' as const) : ('rows' as const),
      scopeDigest: row.scope_digest,
      scopeDigests,
      asOfCommitSeq: row.as_of_commit_seq,
      rowCount: row.row_count,
      rowCursor: row.row_cursor,
      nextRowCursor: row.next_row_cursor,
      byteLength: row.byte_length,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
    };
    const stored = this.#publicationsFor(row.segment_id);
    return {
      record: {
        ...top,
        publications: stored.length > 0 ? stored : publicationsForRecord(top),
      },
      bytes: new Uint8Array(row.bytes),
    };
  }

  async find(
    key: SegmentFindKey,
    nowMs: number,
  ): Promise<SegmentRecord | undefined> {
    // A publication row is the provenance index; a record written before the
    // table existed falls back to the legacy top-level/scope join below.
    const publication = this.db
      .query<
        { segment_id: string },
        [string, string, string, number, string, string, number, number]
      >(
        `SELECT segment_id FROM sync_segment_publications
         WHERE partition=? AND log_epoch=? AND tbl=? AND schema_version=? AND media_type=?
           AND scope_digest=? AND as_of_commit_seq=? AND row_cursor IS NULL
           AND expires_at_ms > ?
         LIMIT 1`,
      )
      .get(
        key.partition,
        key.logEpoch,
        key.table,
        key.schemaVersion,
        key.mediaType,
        key.scopeDigest,
        key.asOfCommitSeq,
        nowMs,
      );
    const legacy = this.db
      .query<
        { segment_id: string },
        [string, string, string, number, string, string, number, number]
      >(
        `SELECT s.segment_id
         FROM sync_segments s
         JOIN sync_segment_scopes sc ON sc.segment_id = s.segment_id
         WHERE s.partition=? AND s.log_epoch=? AND s.tbl=? AND s.schema_version=? AND s.media_type=?
           AND sc.scope_digest=? AND s.as_of_commit_seq=? AND s.row_cursor IS NULL
           AND s.expires_at_ms > ?
         LIMIT 1`,
      )
      .get(
        key.partition,
        key.logEpoch,
        key.table,
        key.schemaVersion,
        key.mediaType,
        key.scopeDigest,
        key.asOfCommitSeq,
        nowMs,
      );
    const segmentId = publication?.segment_id ?? legacy?.segment_id;
    if (segmentId === undefined) return undefined;
    const entry = await this.get(segmentId);
    if (entry === undefined) return undefined;
    const match = selectSegmentPublication(entry.record, {
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
    if (match === undefined) return undefined;
    return publicationRecord(entry.record, match);
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
