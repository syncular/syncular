/**
 * SQLite-backed blob store via `bun:sqlite` (dev/bench convenience,
 * dependency-free). Bun-specific by design (top-level `bun:sqlite` import),
 * so it lives in its own module — the runtime-neutral `BlobStore` interface,
 * `MemoryBlobStore`, `blobIdFor`, and `isBlobId` stay in `blob-store.ts` for
 * the Workers/edge core (TODO §4.2 neutrality discipline; enforced by
 * `test/runtime-neutrality.test.ts`).
 */
import { Database } from 'bun:sqlite';
import type { BlobRecord, BlobStore, BlobStoreStats } from './blob-store';

export class SqliteBlobStore implements BlobStore {
  readonly db: Database;

  constructor(db: Database | string = ':memory:') {
    this.db = typeof db === 'string' ? new Database(db) : db;
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
    const existing = await this.get(partition, blobId);
    if (existing !== undefined) return existing.record;
    const record: BlobRecord = {
      blobId,
      partition,
      byteLength: bytes.length,
      ...(mediaType !== undefined ? { mediaType } : {}),
      createdAtMs: nowMs,
    };
    this.db
      .query(
        `INSERT OR IGNORE INTO sync_blobs(
          partition, blob_id, byte_length, media_type, created_at_ms, bytes
        ) VALUES (?,?,?,?,?,?)`,
      )
      .run(partition, blobId, bytes.length, mediaType ?? null, nowMs, bytes);
    return record;
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
    referencedBlobIds: ReadonlySet<string>,
  ): Promise<string[]> {
    const candidates = this.db
      .query<{ blob_id: string }, [string, number]>(
        `SELECT blob_id FROM sync_blobs
         WHERE partition=? AND created_at_ms < ?`,
      )
      .all(partition, olderThanMs);
    const swept: string[] = [];
    const del = this.db.query(
      'DELETE FROM sync_blobs WHERE partition=? AND blob_id=?',
    );
    for (const { blob_id } of candidates) {
      if (!referencedBlobIds.has(blob_id)) {
        del.run(partition, blob_id);
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
