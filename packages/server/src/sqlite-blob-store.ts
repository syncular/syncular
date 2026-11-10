/**
 * SQLite-backed blob store over the shared synchronous driver.
 */
import type { BlobRecord, BlobStore, BlobStoreStats } from './blob-store';
import {
  SqliteAdapterRequiredError,
  type SqliteDatabase,
} from './sqlite-driver';

export class SqliteBlobStore implements BlobStore {
  readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase | string = ':memory:') {
    if (typeof db === 'string') {
      throw new SqliteAdapterRequiredError();
    }
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_blobs(
        partition TEXT NOT NULL, blob_id TEXT NOT NULL,
        byte_length INTEGER NOT NULL, media_type TEXT,
        created_at_ms INTEGER NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY (partition, blob_id)
      );
    `);
  }

  async put(
    partition: string,
    blobId: string,
    bytes: Uint8Array,
    nowMs: number,
    mediaType?: string,
  ): Promise<BlobRecord> {
    // A re-upload refreshes the sweep grace clock and names the media type an
    // earlier upload left out; it never replaces a recorded one.
    const row = this.db
      .query<
        { media_type: string | null; created_at_ms: number },
        [string, string, number, string | null, number, Uint8Array]
      >(
        `INSERT INTO sync_blobs(
          partition, blob_id, byte_length, media_type, created_at_ms, bytes
        ) VALUES (?,?,?,?,?,?)
        ON CONFLICT(partition, blob_id) DO UPDATE SET
          media_type = coalesce(media_type, excluded.media_type),
          created_at_ms = max(created_at_ms, excluded.created_at_ms)
        RETURNING media_type, created_at_ms`,
      )
      .get(partition, blobId, bytes.length, mediaType ?? null, nowMs, bytes);
    if (row === null) {
      throw new Error('SqliteBlobStore: blob upsert returned no row');
    }
    return {
      blobId,
      partition,
      byteLength: bytes.length,
      ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
      createdAtMs: row.created_at_ms,
    };
  }

  async delete(partition: string, blobId: string): Promise<void> {
    this.db
      .query('DELETE FROM sync_blobs WHERE partition=? AND blob_id=?')
      .run(partition, blobId);
  }

  async has(partition: string, blobId: string): Promise<boolean> {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        'SELECT 1 AS n FROM sync_blobs WHERE partition=? AND blob_id=?',
      )
      .get(partition, blobId);
    return row !== null;
  }

  async get(
    partition: string,
    blobId: string,
  ): Promise<{ record: BlobRecord; bytes: Uint8Array } | undefined> {
    const row = this.db
      .query<
        {
          byte_length: number;
          media_type: string | null;
          created_at_ms: number;
          bytes: Uint8Array;
        },
        [string, string]
      >(
        `SELECT byte_length, media_type, created_at_ms, bytes
         FROM sync_blobs WHERE partition=? AND blob_id=?`,
      )
      .get(partition, blobId);
    if (row === null) return undefined;
    return {
      record: {
        blobId,
        partition,
        byteLength: row.byte_length,
        ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
        createdAtMs: row.created_at_ms,
      },
      bytes: new Uint8Array(row.bytes),
    };
  }

  async sweepOrphans(
    partition: string,
    olderThanMs: number,
    isReferenced: (blobId: string) => Promise<boolean>,
  ): Promise<string[]> {
    const candidates = this.db
      .query<{ blob_id: string }, [string, number]>(
        `SELECT blob_id FROM sync_blobs
         WHERE partition=? AND created_at_ms < ?`,
      )
      .all(partition, olderThanMs);
    const swept: string[] = [];
    // The age condition repeats in the DELETE: a re-upload during the
    // reference lookup refreshed the grace clock and keeps the blob.
    const del = this.db.query(
      'DELETE FROM sync_blobs WHERE partition=? AND blob_id=? AND created_at_ms < ?',
    );
    for (const { blob_id } of candidates) {
      if (await isReferenced(blob_id)) continue;
      if (del.run(partition, blob_id, olderThanMs).changes > 0) {
        swept.push(blob_id);
      }
    }
    return swept;
  }

  async stats(partition: string): Promise<BlobStoreStats> {
    const row = this.db
      .query<{ count: number; bytes: number | null }, [string]>(
        'SELECT count(*) AS count, sum(byte_length) AS bytes FROM sync_blobs WHERE partition=?',
      )
      .get(partition);
    return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
  }
}
