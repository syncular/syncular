/**
 * Integration tests for external snapshot chunk storage
 *
 * Covers:
 * - pull() with chunkStorage parameter stores chunks externally
 * - Chunk body is retrieved from external storage
 * - Fallback to inline body when external read fails
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BlobStorageAdapter } from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import {
  ensureSyncSchema,
  insertSnapshotChunk,
  readSnapshotChunk,
  type SyncCoreDb,
} from '@syncular/server';
import { createDbMetadataChunkStorage } from '@syncular/server/snapshot-chunks';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

async function chunkBodyToUint8Array(
  body: Uint8Array | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;

  const reader = body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}

describe('External chunk storage integration', () => {
  let db: Kysely<SyncCoreDb>;
  let dialect: ReturnType<typeof createSqliteServerDialect>;
  let mockBlobAdapter: BlobStorageAdapter & {
    put: (hash: string, data: Uint8Array) => Promise<void>;
    get: (hash: string) => Promise<Uint8Array | null>;
    _storage: Map<string, Uint8Array>;
  };

  beforeEach(async () => {
    db = createBunSqliteDb<SyncCoreDb>({ path: ':memory:' });
    dialect = createSqliteServerDialect();
    await ensureSyncSchema(db, dialect);

    // Create in-memory mock blob adapter
    const storage = new Map<string, Uint8Array>();
    mockBlobAdapter = {
      name: 'mock',
      _storage: storage,
      async signUpload() {
        return { url: 'http://mock/upload', method: 'PUT' };
      },
      async signDownload() {
        return 'http://mock/download';
      },
      async exists(hash: string) {
        return storage.has(hash);
      },
      async delete(hash: string) {
        storage.delete(hash);
      },
      async put(hash: string, data: Uint8Array) {
        storage.set(hash, new Uint8Array(data));
      },
      async get(hash: string) {
        const data = storage.get(hash);
        return data ? new Uint8Array(data) : null;
      },
    };
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('readSnapshotChunk with external storage', () => {
    it('reads chunk from external storage when available', async () => {
      const chunkStorage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      // Store a chunk via the external storage
      const body = new TextEncoder().encode('external chunk data');
      const ref = await chunkStorage.storeChunk({
        partitionId: 'test',
        scopeKey: 'test-scope',
        scope: 'test_table',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 100,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'abc123',
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Read via readSnapshotChunk with chunkStorage option
      const chunk = await readSnapshotChunk(db, ref.id, { chunkStorage });

      expect(chunk).not.toBeNull();
      expect(
        new TextDecoder().decode(await chunkBodyToUint8Array(chunk!.body))
      ).toBe('external chunk data');
    });

    it('falls back to inline body when external storage returns null', async () => {
      // Create a chunk storage that always returns null for reads
      const failingChunkStorage: {
        readChunk: (chunkId: string) => Promise<Uint8Array | null>;
      } = {
        readChunk: async () => null,
      };

      // Insert chunk with inline body
      const body = new TextEncoder().encode('inline fallback data');
      await insertSnapshotChunk(db, {
        chunkId: 'test-fallback',
        partitionId: 'test',
        scopeKey: 'test',
        scope: 'test_items',
        asOfCommitSeq: 100,
        rowCursor: '',
        rowLimit: 100,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'fallback123',
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Read with failing external storage - should fall back to inline
      const chunk = await readSnapshotChunk(db, 'test-fallback', {
        chunkStorage: failingChunkStorage,
      });

      expect(chunk).not.toBeNull();
      expect(
        new TextDecoder().decode(await chunkBodyToUint8Array(chunk!.body))
      ).toBe('inline fallback data');
    });

    it('returns null when chunk not found', async () => {
      const chunkStorage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const chunk = await readSnapshotChunk(db, 'non-existent', {
        chunkStorage,
      });

      expect(chunk).toBeNull();
    });

    it('works without chunkStorage (inline only)', async () => {
      // Insert inline chunk
      const body = new TextEncoder().encode('inline only content');
      await insertSnapshotChunk(db, {
        chunkId: 'inline-chunk',
        partitionId: 'test',
        scopeKey: 'test',
        scope: 'test_items',
        asOfCommitSeq: 100,
        rowCursor: '',
        rowLimit: 100,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'inline123',
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Read without external storage
      const chunk = await readSnapshotChunk(db, 'inline-chunk');

      expect(chunk).not.toBeNull();
      expect(
        new TextDecoder().decode(await chunkBodyToUint8Array(chunk!.body))
      ).toBe('inline only content');
    });
  });

  describe('chunkStorage interface', () => {
    it('DbMetadataChunkStorage implements required interface', async () => {
      const chunkStorage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      // Verify all required methods exist
      expect(typeof chunkStorage.storeChunk).toBe('function');
      expect(typeof chunkStorage.readChunk).toBe('function');
      expect(typeof chunkStorage.findChunk).toBe('function');
      expect(typeof chunkStorage.cleanupExpired).toBe('function');
      expect(typeof chunkStorage.name).toBe('string');
    });

    it('findChunk returns matching chunk reference', async () => {
      const chunkStorage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('findable data');
      await chunkStorage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 50,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'findable123',
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      const found = await chunkStorage.findChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 50,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
      });

      expect(found).not.toBeNull();
      expect(found!.sha256).toBe('findable123');
    });

    it('cleanupExpired removes old chunks', async () => {
      const chunkStorage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      // Insert expired chunk
      await chunkStorage.storeChunk({
        partitionId: 'test',
        scopeKey: 'old',
        scope: 'tasks',
        asOfCommitSeq: 1,
        rowCursor: '',
        rowLimit: 10,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'old123',
        body: new TextEncoder().encode('old data'),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      // Insert valid chunk
      await chunkStorage.storeChunk({
        partitionId: 'test',
        scopeKey: 'new',
        scope: 'tasks',
        asOfCommitSeq: 2,
        rowCursor: '',
        rowLimit: 10,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'new456',
        body: new TextEncoder().encode('new data'),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Cleanup expired
      const deleted = await chunkStorage.cleanupExpired(
        new Date().toISOString()
      );
      expect(deleted).toBe(1);

      // Old chunk should be gone
      const oldFound = await chunkStorage.findChunk({
        partitionId: 'test',
        scopeKey: 'old',
        scope: 'tasks',
        asOfCommitSeq: 1,
        rowCursor: '',
        rowLimit: 10,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
      });
      expect(oldFound).toBeNull();

      // New chunk should still exist
      const newFound = await chunkStorage.findChunk({
        partitionId: 'test',
        scopeKey: 'new',
        scope: 'tasks',
        asOfCommitSeq: 2,
        rowCursor: '',
        rowLimit: 10,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
      });
      expect(newFound).not.toBeNull();
    });
  });
});
